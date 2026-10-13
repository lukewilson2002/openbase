//! Authorization. Every data endpoint resolves the caller's effective role on
//! a base through [`require_base`]; there is no other path to data.
//!
//! Effective role on a base = max(workspace role, base role). Instance admins
//! get no implicit data access (they manage users, not content).
//! Callers without any role get 404, never 403, so ids don't leak existence.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::auth::{Actor, Capability};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// Read records, views, comments.
    Viewer,
    /// Viewer + comment on records.
    Commenter,
    /// Commenter + create/edit/delete records, create personal views.
    Editor,
    /// Editor + change schema (tables, fields, views), share links, automations.
    Creator,
    /// Creator + manage members, delete/rename the workspace or base.
    Owner,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Commenter => "commenter",
            Role::Editor => "editor",
            Role::Creator => "creator",
            Role::Owner => "owner",
        }
    }

    pub fn parse(s: &str) -> AppResult<Role> {
        Ok(match s {
            "viewer" => Role::Viewer,
            "commenter" => Role::Commenter,
            "editor" => Role::Editor,
            "creator" => Role::Creator,
            "owner" => Role::Owner,
            _ => return Err(AppError::bad_request(format!("unknown role '{s}'"))),
        })
    }
}

pub fn workspace_role(
    conn: &Connection,
    user_id: &str,
    workspace_id: &str,
) -> AppResult<Option<Role>> {
    let role: Option<String> = conn
        .query_row(
            "SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.workspace_id = ?1 AND m.user_id = ?2 AND w.deleted_at IS NULL",
            [workspace_id, user_id],
            |r| r.get(0),
        )
        .optional()?;
    role.as_deref().map(Role::parse).transpose()
}

/// Effective role of `user_id` on `base_id`, or None if the user has no access
/// or the base (or its workspace) is deleted.
pub fn base_role(conn: &Connection, user_id: &str, base_id: &str) -> AppResult<Option<Role>> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT
                (SELECT role FROM workspace_members WHERE workspace_id = b.workspace_id AND user_id = ?2),
                (SELECT role FROM base_members WHERE base_id = b.id AND user_id = ?2)
             FROM bases b JOIN workspaces w ON w.id = b.workspace_id
             WHERE b.id = ?1 AND b.deleted_at IS NULL AND w.deleted_at IS NULL",
            [base_id, user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((ws, base)) = row else {
        return Ok(None);
    };
    let ws = ws.as_deref().map(Role::parse).transpose()?;
    let base = base.as_deref().map(Role::parse).transpose()?;
    Ok(ws.max(base))
}

/// Resolve and check the actor's role on a base. API tokens are additionally
/// limited by their scope (base list, read-only caps the role at Viewer).
pub fn require_base(conn: &Connection, actor: &Actor, base_id: &str, min: Role) -> AppResult<Role> {
    if let Some(scope) = &actor.token_scope {
        if let Some(bases) = &scope.base_ids {
            if !bases.iter().any(|b| b == base_id) {
                return Err(AppError::not_found("base"));
            }
        }
    }
    let Some(mut role) = base_role(conn, &actor.user_id, base_id)? else {
        return Err(AppError::not_found("base"));
    };
    if let Some(scope) = &actor.token_scope {
        if !scope.write {
            role = role.min(Role::Viewer);
        }
    }
    if role < min {
        return Err(AppError::forbidden(format!(
            "this action requires the {} role on this base",
            min.as_str()
        )));
    }
    Ok(role)
}

/// Same as [`require_base`] for workspace-level actions. A signed-in user needs the workspace
/// role; an API token additionally needs the `manage` permission and no base restriction
/// ([`Capability::ManageUnscoped`]).
pub fn require_workspace(
    conn: &Connection,
    actor: &Actor,
    workspace_id: &str,
    min: Role,
) -> AppResult<Role> {
    actor.require_capability(Capability::ManageUnscoped)?;
    workspace_role_at_least(conn, actor, workspace_id, min)
}

/// Workspace role check for actions that only create content inside the workspace (adding a
/// base). Tokens need write access and no base restriction (a base-limited token could not
/// reach the base it just created) but not the `manage` permission.
pub fn require_workspace_for_content(
    conn: &Connection,
    actor: &Actor,
    workspace_id: &str,
    min: Role,
) -> AppResult<Role> {
    if let Some(scope) = &actor.token_scope {
        if !scope.write {
            return Err(AppError::forbidden(
                "this API token is read-only; use a token with write access",
            ));
        }
        if scope.base_ids.is_some() {
            return Err(AppError::forbidden(
                "an API token limited to specific bases cannot create bases",
            ));
        }
    }
    workspace_role_at_least(conn, actor, workspace_id, min)
}

fn workspace_role_at_least(
    conn: &Connection,
    actor: &Actor,
    workspace_id: &str,
    min: Role,
) -> AppResult<Role> {
    let Some(role) = workspace_role(conn, &actor.user_id, workspace_id)? else {
        return Err(AppError::not_found("workspace"));
    };
    if role < min {
        return Err(AppError::forbidden(format!(
            "this action requires the {} role on this workspace",
            min.as_str()
        )));
    }
    Ok(role)
}

fn lookup(conn: &Connection, sql: &str, id: &str, what: &str) -> AppResult<String> {
    conn.query_row(sql, [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::not_found(what.to_string()))
}

/// Base containing a live table.
pub fn base_of_table(conn: &Connection, table_id: &str) -> AppResult<String> {
    lookup(
        conn,
        "SELECT base_id FROM tables WHERE id = ?1 AND deleted_at IS NULL",
        table_id,
        "table",
    )
}

/// Base containing a live field (of a live table).
pub fn base_of_field(conn: &Connection, field_id: &str) -> AppResult<String> {
    lookup(
        conn,
        "SELECT t.base_id FROM fields f JOIN tables t ON t.id = f.table_id
         WHERE f.id = ?1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL",
        field_id,
        "field",
    )
}

/// Base containing a live view.
pub fn base_of_view(conn: &Connection, view_id: &str) -> AppResult<String> {
    lookup(
        conn,
        "SELECT t.base_id FROM views v JOIN tables t ON t.id = v.table_id
         WHERE v.id = ?1 AND v.deleted_at IS NULL AND t.deleted_at IS NULL",
        view_id,
        "view",
    )
}

/// Base containing a record (live or trashed: restoring needs the trashed case).
pub fn base_of_record(conn: &Connection, record_id: &str) -> AppResult<String> {
    lookup(
        conn,
        "SELECT t.base_id FROM records r JOIN tables t ON t.id = r.table_id
         WHERE r.id = ?1 AND t.deleted_at IS NULL",
        record_id,
        "record",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_are_ordered() {
        assert!(Role::Owner > Role::Creator);
        assert!(Role::Creator > Role::Editor);
        assert!(Role::Editor > Role::Commenter);
        assert!(Role::Commenter > Role::Viewer);
        for r in [
            Role::Viewer,
            Role::Commenter,
            Role::Editor,
            Role::Creator,
            Role::Owner,
        ] {
            assert_eq!(Role::parse(r.as_str()).unwrap(), r);
        }
        assert!(Role::parse("admin").is_err());
    }
}
