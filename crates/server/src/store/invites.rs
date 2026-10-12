//! Invites to a workspace or a single base. The link carries a secret token
//! (`inv_` + 43 random chars); only its hash is stored. An invite is valid for
//! 7 days, can be accepted once, and may be restricted to one email address.

use og_core::api::auth::{InviteInfo, InvitePreview};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::{hash_token, new_id, new_token};
use crate::perm::Role;

/// Invites expire after 7 days.
pub const INVITE_TTL_MS: i64 = 7 * 24 * 3600 * 1000;
/// Most invites listed for one workspace or base.
const LIST_LIMIT: i64 = 500;

/// What an invite grants access to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InviteTarget {
    Workspace(String),
    Base(String),
}

/// A stored invite.
#[derive(Debug, Clone)]
pub struct InviteRow {
    pub info: InviteInfo,
    pub created_by: Option<String>,
}

impl InviteRow {
    pub fn target(&self) -> AppResult<InviteTarget> {
        match (&self.info.workspace_id, &self.info.base_id) {
            (Some(ws), None) => Ok(InviteTarget::Workspace(ws.clone())),
            (None, Some(b)) => Ok(InviteTarget::Base(b.clone())),
            _ => Err(AppError::internal("invite has no single target")),
        }
    }

    pub fn role(&self) -> AppResult<Role> {
        Role::parse(&self.info.role)
    }
}

const COLUMNS: &str =
    "id, workspace_id, base_id, email, role, created_at, expires_at, accepted_at, created_by";

fn from_row(r: &Row) -> rusqlite::Result<InviteRow> {
    Ok(InviteRow {
        info: InviteInfo {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            base_id: r.get(2)?,
            email: r.get(3)?,
            role: r.get(4)?,
            created_at: r.get(5)?,
            expires_at: r.get(6)?,
            accepted_at: r.get(7)?,
        },
        created_by: r.get(8)?,
    })
}

/// Link the invitee opens.
pub fn invite_url(public_url: &str, token: &str) -> String {
    format!("{}/invite/{token}", public_url.trim_end_matches('/'))
}

/// Create an invite. The caller has already checked permissions and
/// normalized `email`. Returns the raw token and the stored invite.
pub fn create(
    conn: &Connection,
    created_by: &str,
    target: &InviteTarget,
    email: Option<&str>,
    role: Role,
) -> AppResult<(String, InviteInfo)> {
    let id = new_id(og_core::ids::INVITE);
    let token = new_token("inv_");
    let now = now_ms();
    let (ws, base) = match target {
        InviteTarget::Workspace(w) => (Some(w.as_str()), None),
        InviteTarget::Base(b) => (None, Some(b.as_str())),
    };
    conn.execute(
        "INSERT INTO invites (id, token_hash, workspace_id, base_id, email, role, created_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            hash_token(&token),
            ws,
            base,
            email,
            role.as_str(),
            created_by,
            now,
            now + INVITE_TTL_MS
        ],
    )?;
    let info = InviteInfo {
        id,
        workspace_id: ws.map(str::to_string),
        base_id: base.map(str::to_string),
        email: email.map(str::to_string),
        role: role.as_str().to_string(),
        created_at: now,
        expires_at: now + INVITE_TTL_MS,
        accepted_at: None,
    };
    Ok((token, info))
}

/// Invites of a workspace or base, newest first (accepted and expired included).
pub fn list(conn: &Connection, target: &InviteTarget) -> AppResult<Vec<InviteInfo>> {
    let (col, id) = match target {
        InviteTarget::Workspace(w) => ("workspace_id", w),
        InviteTarget::Base(b) => ("base_id", b),
    };
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM invites WHERE {col} = ?1 ORDER BY created_at DESC, id LIMIT ?2"
    ))?;
    let rows = stmt.query_map(params![id, LIST_LIMIT], from_row)?;
    Ok(rows
        .map(|r| r.map(|i| i.info))
        .collect::<Result<Vec<_>, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<InviteRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM invites WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM invites WHERE id = ?1", [id])?;
    Ok(())
}

/// Name of the invite's target, if it (and its workspace) is not deleted.
fn live_target_name(conn: &Connection, target: &InviteTarget) -> AppResult<Option<String>> {
    Ok(match target {
        InviteTarget::Workspace(w) => conn
            .query_row(
                "SELECT name FROM workspaces WHERE id = ?1 AND deleted_at IS NULL",
                [w],
                |r| r.get(0),
            )
            .optional()?,
        InviteTarget::Base(b) => conn
            .query_row(
                "SELECT b.name FROM bases b JOIN workspaces w ON w.id = b.workspace_id
                 WHERE b.id = ?1 AND b.deleted_at IS NULL AND w.deleted_at IS NULL",
                [b],
                |r| r.get(0),
            )
            .optional()?,
    })
}

/// An invite that can still be accepted: unexpired, unaccepted, target alive.
pub fn find_valid_by_token(conn: &Connection, token: &str) -> AppResult<Option<InviteRow>> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM invites
                 WHERE token_hash = ?1 AND accepted_at IS NULL AND expires_at > ?2"
            ),
            params![hash_token(token), now_ms()],
            from_row,
        )
        .optional()?;
    let Some(row) = row else { return Ok(None) };
    if live_target_name(conn, &row.target()?)?.is_none() {
        return Ok(None);
    }
    Ok(Some(row))
}

/// Same as [`find_valid_by_token`] but a 404 with a clear message when invalid.
pub fn require_valid_by_token(conn: &Connection, token: &str) -> AppResult<InviteRow> {
    find_valid_by_token(conn, token)?
        .ok_or_else(|| AppError::not_found("invite (it may have expired or already been used)"))
}

/// Public preview for the accept page.
pub fn preview(conn: &Connection, invite: &InviteRow) -> AppResult<InvitePreview> {
    let target = invite.target()?;
    let target_name =
        live_target_name(conn, &target)?.ok_or_else(|| AppError::not_found("invite"))?;
    let invited_by: Option<String> = match &invite.created_by {
        Some(uid) => conn
            .query_row("SELECT name FROM users WHERE id = ?1", [uid], |r| r.get(0))
            .optional()?,
        None => None,
    };
    Ok(InvitePreview {
        target_name,
        target_kind: match target {
            InviteTarget::Workspace(_) => "workspace".into(),
            InviteTarget::Base(_) => "base".into(),
        },
        role: invite.info.role.clone(),
        email: invite.info.email.clone(),
        invited_by,
    })
}

/// Give `user_id` `role` on the target, keeping their existing role if higher.
pub fn grant_role(
    conn: &Connection,
    target: &InviteTarget,
    user_id: &str,
    role: Role,
) -> AppResult<Role> {
    let (table, col, id) = match target {
        InviteTarget::Workspace(w) => ("workspace_members", "workspace_id", w),
        InviteTarget::Base(b) => ("base_members", "base_id", b),
    };
    let existing: Option<String> = conn
        .query_row(
            &format!("SELECT role FROM {table} WHERE {col} = ?1 AND user_id = ?2"),
            params![id, user_id],
            |r| r.get(0),
        )
        .optional()?;
    let existing = existing.as_deref().map(Role::parse).transpose()?;
    let effective = existing.map_or(role, |e| e.max(role));
    conn.execute(
        &format!(
            "INSERT INTO {table} ({col}, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT({col}, user_id) DO UPDATE SET role = excluded.role"
        ),
        params![id, user_id, effective.as_str(), now_ms()],
    )?;
    Ok(effective)
}

/// Accept a valid invite for a user: enforce the email restriction, grant the
/// role and mark the invite used. Returns the updated invite.
pub fn accept(
    conn: &Connection,
    invite: &InviteRow,
    user_id: &str,
    user_email: &str,
) -> AppResult<InviteInfo> {
    if let Some(email) = &invite.info.email {
        if !email.eq_ignore_ascii_case(user_email.trim()) {
            return Err(AppError::forbidden(
                "this invite was sent to a different email address",
            ));
        }
    }
    let now = now_ms();
    let n = conn.execute(
        "UPDATE invites SET accepted_at = ?1, accepted_by = ?2
         WHERE id = ?3 AND accepted_at IS NULL",
        params![now, user_id, invite.info.id],
    )?;
    if n == 0 {
        return Err(AppError::not_found(
            "invite (it may have already been used)",
        ));
    }
    grant_role(conn, &invite.target()?, user_id, invite.role()?)?;
    let mut info = invite.info.clone();
    info.accepted_at = Some(now);
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::users;

    fn db() -> (Connection, String, String) {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        crate::db::migrate(&c).unwrap();
        let u = users::create(&c, "owner@example.com", "Owner", "!", false).unwrap();
        c.execute(
            "INSERT INTO workspaces (id, name, created_by, created_at) VALUES ('wsp1', 'Acme', ?1, 0)",
            [&u],
        )
        .unwrap();
        c.execute(
            "INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('app1', 'wsp1', 'CRM', 0)",
            [],
        )
        .unwrap();
        (c, u, "wsp1".into())
    }

    #[test]
    fn grant_keeps_the_higher_role() {
        let (c, _owner, ws) = db();
        let u = users::create(&c, "b@example.com", "B", "!", false).unwrap();
        let t = InviteTarget::Workspace(ws);
        assert_eq!(grant_role(&c, &t, &u, Role::Editor).unwrap(), Role::Editor);
        assert_eq!(grant_role(&c, &t, &u, Role::Viewer).unwrap(), Role::Editor);
        assert_eq!(grant_role(&c, &t, &u, Role::Owner).unwrap(), Role::Owner);
        assert_eq!(
            crate::perm::workspace_role(&c, &u, "wsp1").unwrap(),
            Some(Role::Owner)
        );
    }

    #[test]
    fn accept_flow_and_validity() {
        let (c, owner, _) = db();
        let b = users::create(&c, "b@example.com", "B", "!", false).unwrap();
        let target = InviteTarget::Base("app1".into());
        let (token, info) =
            create(&c, &owner, &target, Some("B@example.com"), Role::Editor).unwrap();
        let row = find_valid_by_token(&c, &token).unwrap().unwrap();
        let p = preview(&c, &row).unwrap();
        assert_eq!(p.target_name, "CRM");
        assert_eq!(p.target_kind, "base");
        assert_eq!(p.invited_by.as_deref(), Some("Owner"));
        // Wrong email is refused.
        let other = users::create(&c, "c@example.com", "C", "!", false).unwrap();
        assert!(matches!(
            accept(&c, &row, &other, "c@example.com"),
            Err(AppError::Forbidden(_))
        ));
        let accepted = accept(&c, &row, &b, "b@example.com").unwrap();
        assert!(accepted.accepted_at.is_some());
        assert_eq!(
            crate::perm::base_role(&c, &b, "app1").unwrap(),
            Some(Role::Editor)
        );
        assert!(find_valid_by_token(&c, &token).unwrap().is_none());
        assert!(accept(&c, &row, &b, "b@example.com").is_err());
        assert_eq!(list(&c, &target).unwrap()[0].id, info.id);
    }

    #[test]
    fn expired_and_deleted_target_invites_are_invalid() {
        let (c, owner, ws) = db();
        let (token, info) =
            create(&c, &owner, &InviteTarget::Workspace(ws), None, Role::Viewer).unwrap();
        c.execute(
            "UPDATE invites SET expires_at = 0 WHERE id = ?1",
            [&info.id],
        )
        .unwrap();
        assert!(find_valid_by_token(&c, &token).unwrap().is_none());
        let (token2, _) = create(
            &c,
            &owner,
            &InviteTarget::Base("app1".into()),
            None,
            Role::Viewer,
        )
        .unwrap();
        c.execute("UPDATE workspaces SET deleted_at = 1", [])
            .unwrap();
        assert!(find_valid_by_token(&c, &token2).unwrap().is_none());
        assert!(find_valid_by_token(&c, "inv_nope").unwrap().is_none());
    }
}
