//! Workspaces and workspace membership.
//!
//! Access checks happen in the handlers (`perm::require_workspace`); the
//! functions here enforce data rules such as "a workspace always keeps at
//! least one owner".

use std::collections::HashMap;

use og_core::api::workspaces::{BaseSummary, Member, WorkspaceSummary};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::perm::Role;
use crate::store::{bases, schema};

fn summary_of(base: &bases::BaseRow, role: Role) -> BaseSummary {
    BaseSummary {
        id: base.id.clone(),
        workspace_id: base.workspace_id.clone(),
        name: base.name.clone(),
        color: base.color.clone(),
        icon: base.icon.clone(),
        role: role.as_str().to_string(),
    }
}

/// `GET /api/workspaces`: workspaces the user belongs to (with their role and
/// every live base, at the user's effective role), then workspaces the user
/// only reaches through bases shared directly with them (role None, only
/// those bases).
pub fn list_for_user(conn: &Connection, user_id: &str) -> AppResult<Vec<WorkspaceSummary>> {
    let mut base_roles: HashMap<String, Role> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT base_id, role FROM base_members WHERE user_id = ?1")?;
        let rows = stmt.query_map([user_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (base_id, role) = row?;
            base_roles.insert(base_id, Role::parse(&role)?);
        }
    }

    let mut out = Vec::new();
    let member_of: Vec<(String, String, Option<String>, String)> = {
        let mut stmt = conn.prepare(
            "SELECT w.id, w.name, w.icon, m.role FROM workspace_members m
             JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = ?1 AND w.deleted_at IS NULL
             ORDER BY w.created_at, w.id",
        )?;
        let rows = stmt.query_map([user_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, name, icon, role) in member_of {
        let ws_role = Role::parse(&role)?;
        let bases = bases::live_bases_in(conn, &id)?
            .iter()
            .map(|b| {
                summary_of(
                    b,
                    base_roles.get(&b.id).map_or(ws_role, |r| ws_role.max(*r)),
                )
            })
            .collect();
        out.push(WorkspaceSummary {
            id,
            name,
            icon,
            role: Some(ws_role.as_str().to_string()),
            bases,
        });
    }

    let shared_only: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT w.id, w.name, w.icon, w.created_at FROM base_members bm
             JOIN bases b ON b.id = bm.base_id AND b.deleted_at IS NULL
             JOIN workspaces w ON w.id = b.workspace_id AND w.deleted_at IS NULL
             WHERE bm.user_id = ?1
               AND NOT EXISTS (SELECT 1 FROM workspace_members wm
                               WHERE wm.workspace_id = w.id AND wm.user_id = ?1)
             ORDER BY w.created_at, w.id",
        )?;
        let rows = stmt.query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, name, icon) in shared_only {
        let bases = bases::live_bases_in(conn, &id)?
            .iter()
            .filter_map(|b| base_roles.get(&b.id).map(|r| summary_of(b, *r)))
            .collect();
        out.push(WorkspaceSummary {
            id,
            name,
            icon,
            role: None,
            bases,
        });
    }
    Ok(out)
}

/// Create a workspace owned by `user_id`.
pub fn create(
    tx: &Transaction,
    user_id: &str,
    name: &str,
    icon: Option<&str>,
) -> AppResult<WorkspaceSummary> {
    let name = schema::validate_name(name, "workspace")?;
    let icon = schema::icon_on_create(icon)?;
    let id = new_id(og_core::ids::WORKSPACE);
    let now = now_ms();
    tx.execute(
        "INSERT INTO workspaces (id, name, icon, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, icon, user_id, now],
    )?;
    tx.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         VALUES (?1, ?2, 'owner', ?3)",
        params![id, user_id, now],
    )?;
    Ok(WorkspaceSummary {
        id,
        name,
        icon,
        role: Some(Role::Owner.as_str().to_string()),
        bases: Vec::new(),
    })
}

/// Set (`Some(Some(name))`) or clear (`Some(None)`) a live workspace's icon;
/// `None` leaves it alone.
pub fn set_icon(
    tx: &Transaction,
    workspace_id: &str,
    icon: &Option<Option<String>>,
) -> AppResult<()> {
    let Some(icon) = schema::icon_patch(icon)? else {
        return Ok(());
    };
    let n = tx.execute(
        "UPDATE workspaces SET icon = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![workspace_id, icon],
    )?;
    if n == 0 {
        return Err(AppError::not_found("workspace"));
    }
    Ok(())
}

/// Rename a live workspace.
pub fn rename(tx: &Transaction, workspace_id: &str, name: &str) -> AppResult<String> {
    let name = schema::validate_name(name, "workspace")?;
    let n = tx.execute(
        "UPDATE workspaces SET name = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![workspace_id, name],
    )?;
    if n == 0 {
        return Err(AppError::not_found("workspace"));
    }
    Ok(name)
}

/// Move a workspace (with everything in it) to the trash.
pub fn soft_delete(tx: &Transaction, workspace_id: &str) -> AppResult<()> {
    let n = tx.execute(
        "UPDATE workspaces SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![workspace_id, now_ms()],
    )?;
    if n == 0 {
        return Err(AppError::not_found("workspace"));
    }
    Ok(())
}

/// Ids of the live bases of a workspace (for event fan-out).
pub fn base_ids(conn: &Connection, workspace_id: &str) -> AppResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM bases WHERE workspace_id = ?1 AND deleted_at IS NULL")?;
    let rows = stmt.query_map([workspace_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Members of a workspace, oldest first.
pub fn members(conn: &Connection, workspace_id: &str) -> AppResult<Vec<Member>> {
    let mut stmt = conn.prepare(
        "SELECT u.id, u.name, u.email, m.role FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ?1 ORDER BY m.created_at, u.name, u.id",
    )?;
    let rows = stmt.query_map([workspace_id], |r| {
        Ok(Member {
            user_id: r.get(0)?,
            name: r.get(1)?,
            email: r.get(2)?,
            role: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn member_role(conn: &Connection, workspace_id: &str, user_id: &str) -> AppResult<Role> {
    let role: Option<String> = conn
        .query_row(
            "SELECT role FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
            [workspace_id, user_id],
            |r| r.get(0),
        )
        .optional()?;
    match role {
        Some(r) => Role::parse(&r),
        None => Err(AppError::not_found("member")),
    }
}

fn owner_count(conn: &Connection, workspace_id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "SELECT count(*) FROM workspace_members WHERE workspace_id = ?1 AND role = 'owner'",
        [workspace_id],
        |r| r.get(0),
    )?)
}

fn last_owner_error() -> AppError {
    AppError::conflict("a workspace must keep at least one owner")
}

/// Change a member's role. The last owner cannot be demoted.
pub fn set_member_role(
    tx: &Transaction,
    workspace_id: &str,
    user_id: &str,
    new_role: Role,
) -> AppResult<()> {
    let current = member_role(tx, workspace_id, user_id)?;
    if current == Role::Owner && new_role != Role::Owner && owner_count(tx, workspace_id)? <= 1 {
        return Err(last_owner_error());
    }
    tx.execute(
        "UPDATE workspace_members SET role = ?3 WHERE workspace_id = ?1 AND user_id = ?2",
        params![workspace_id, user_id, new_role.as_str()],
    )?;
    Ok(())
}

/// Remove a member (or let them leave). The last owner cannot go.
pub fn remove_member(tx: &Transaction, workspace_id: &str, user_id: &str) -> AppResult<()> {
    let current = member_role(tx, workspace_id, user_id)?;
    if current == Role::Owner && owner_count(tx, workspace_id)? <= 1 {
        return Err(last_owner_error());
    }
    tx.execute(
        "DELETE FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
        params![workspace_id, user_id],
    )?;
    Ok(())
}
