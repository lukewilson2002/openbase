//! Invites to a workspace, giving access to all of its bases or a picked list
//! of them. The link carries a secret token (`inv_` + 43 random chars); only
//! its hash is stored. An invite is valid for 7 days, can be accepted once,
//! and may be restricted to one email address.

use ob_core::api::auth::{InviteInfo, InvitePreview};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::{hash_token, new_id, new_token};
use crate::perm::{self, Role};
use crate::store::workspaces::{self, BaseAccess};

/// Invites expire after 7 days.
pub const INVITE_TTL_MS: i64 = 7 * 24 * 3600 * 1000;
/// Most invites listed for one workspace or base.
const LIST_LIMIT: i64 = 500;

/// A stored invite.
#[derive(Debug, Clone)]
pub struct InviteRow {
    pub info: InviteInfo,
    pub created_by: Option<String>,
}

impl InviteRow {
    pub fn workspace_id(&self) -> AppResult<&str> {
        self.info
            .workspace_id
            .as_deref()
            .ok_or_else(|| AppError::internal("invite has no workspace"))
    }

    pub fn role(&self) -> AppResult<Role> {
        Role::parse(&self.info.role)
    }

    pub fn access(&self) -> BaseAccess {
        if self.info.all_bases {
            BaseAccess::All
        } else {
            BaseAccess::Only(self.info.base_ids.clone())
        }
    }
}

const COLUMNS: &str = "id, workspace_id, email, role, created_at, expires_at, accepted_at, \
                       created_by, all_bases";

fn from_row(r: &Row) -> rusqlite::Result<InviteRow> {
    Ok(InviteRow {
        info: InviteInfo {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            base_id: None,
            email: r.get(2)?,
            role: r.get(3)?,
            created_at: r.get(4)?,
            expires_at: r.get(5)?,
            accepted_at: r.get(6)?,
            all_bases: r.get(8)?,
            base_ids: Vec::new(),
        },
        created_by: r.get(7)?,
    })
}

/// Fill in `base_ids` of limited invites (all of them, trashed bases included,
/// so restoring a base restores what the invite gives).
fn with_bases(conn: &Connection, mut rows: Vec<InviteRow>) -> AppResult<Vec<InviteRow>> {
    let mut stmt = conn.prepare(
        "SELECT ib.base_id FROM invite_bases ib JOIN bases b ON b.id = ib.base_id
         WHERE ib.invite_id = ?1 ORDER BY b.position, b.created_at, b.id",
    )?;
    for row in rows.iter_mut().filter(|r| !r.info.all_bases) {
        let ids = stmt.query_map([&row.info.id], |r| r.get(0))?;
        row.info.base_ids = ids.collect::<Result<_, _>>()?;
    }
    Ok(rows)
}

fn query(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> AppResult<Vec<InviteRow>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt
        .query_map(params, from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    with_bases(conn, rows)
}

/// Link the invitee opens.
pub fn invite_url(public_url: &str, token: &str) -> String {
    format!("{}/invite/{token}", public_url.trim_end_matches('/'))
}

/// Create an invite to `workspace_id`. The caller has already checked
/// permissions, normalized `email` and validated `access` (see
/// [`workspaces::validate_access`]). Returns the raw token and the stored invite.
pub fn create(
    conn: &Connection,
    created_by: &str,
    workspace_id: &str,
    email: Option<&str>,
    role: Role,
    access: &BaseAccess,
) -> AppResult<(String, InviteInfo)> {
    let id = new_id(ob_core::ids::INVITE);
    let token = new_token("inv_");
    let now = now_ms();
    let all_bases = matches!(access, BaseAccess::All);
    conn.execute(
        "INSERT INTO invites (id, token_hash, workspace_id, email, role, created_by, created_at,
                              expires_at, all_bases)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            hash_token(&token),
            workspace_id,
            email,
            role.as_str(),
            created_by,
            now,
            now + INVITE_TTL_MS,
            all_bases,
        ],
    )?;
    let mut base_ids = Vec::new();
    if let BaseAccess::Only(ids) = access {
        for b in ids {
            conn.execute(
                "INSERT OR IGNORE INTO invite_bases (invite_id, base_id) VALUES (?1, ?2)",
                params![id, b],
            )?;
        }
        base_ids = ids.clone();
    }
    let info = InviteInfo {
        id,
        workspace_id: Some(workspace_id.to_string()),
        base_id: None,
        email: email.map(str::to_string),
        role: role.as_str().to_string(),
        created_at: now,
        expires_at: now + INVITE_TTL_MS,
        accepted_at: None,
        all_bases,
        base_ids,
    };
    Ok((token, info))
}

/// Invites of a workspace, newest first (accepted and expired included).
pub fn list_for_workspace(conn: &Connection, workspace_id: &str) -> AppResult<Vec<InviteInfo>> {
    let rows = query(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM invites WHERE workspace_id = ?1
             ORDER BY created_at DESC, id LIMIT ?2"
        ),
        params![workspace_id, LIST_LIMIT],
    )?;
    Ok(rows.into_iter().map(|r| r.info).collect())
}

/// Pending (unaccepted, unexpired) invites whose access includes `base_id`,
/// newest first.
pub fn list_for_base(conn: &Connection, base_id: &str) -> AppResult<Vec<InviteInfo>> {
    let rows = query(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM invites i
             WHERE i.accepted_at IS NULL AND i.expires_at > ?3
               AND i.workspace_id = (SELECT workspace_id FROM bases WHERE id = ?1)
               AND (i.all_bases = 1
                    OR EXISTS (SELECT 1 FROM invite_bases ib
                               WHERE ib.invite_id = i.id AND ib.base_id = ?1))
             ORDER BY created_at DESC, id LIMIT ?2"
        ),
        params![base_id, LIST_LIMIT, now_ms()],
    )?;
    Ok(rows.into_iter().map(|r| r.info).collect())
}

/// Invites of a workspace that can still be accepted (see
/// [`find_valid_by_token`]), oldest first.
pub fn pending_for_workspace(conn: &Connection, workspace_id: &str) -> AppResult<Vec<InviteRow>> {
    let rows = query(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM invites
             WHERE workspace_id = ?1 AND accepted_at IS NULL AND expires_at > ?2
             ORDER BY created_at, id LIMIT ?3"
        ),
        params![workspace_id, now_ms(), LIST_LIMIT],
    )?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if still_valid(conn, &row)? {
            out.push(row);
        }
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<InviteRow>> {
    Ok(query(
        conn,
        &format!("SELECT {COLUMNS} FROM invites WHERE id = ?1"),
        [id],
    )?
    .pop())
}

pub fn delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM invites WHERE id = ?1", [id])?;
    Ok(())
}

/// Name and icon of the invite's workspace, if it is not deleted.
fn live_workspace(
    conn: &Connection,
    invite: &InviteRow,
) -> AppResult<Option<(String, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT name, icon FROM workspaces WHERE id = ?1 AND deleted_at IS NULL",
            [invite.workspace_id()?],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// The listed bases of a limited invite that are not in the trash.
fn live_listed_bases(conn: &Connection, invite: &InviteRow) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for b in &invite.info.base_ids {
        let live: bool = conn
            .query_row(
                "SELECT deleted_at IS NULL FROM bases WHERE id = ?1",
                [b],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if live {
            out.push(b.clone());
        }
    }
    Ok(out)
}

/// Whether the invite's creator can still hand out what it gives: an active
/// user who holds at least the invited role, and either owns the workspace
/// or (for an invite limited to some bases) is a Creator who can still open
/// each of them. An invite is only as good as its creator's standing, so
/// removal, demotion, deactivation or losing a base voids pending invites.
fn creator_may_still_invite(conn: &Connection, invite: &InviteRow) -> AppResult<bool> {
    let Some(creator) = &invite.created_by else {
        return Ok(false);
    };
    let active: bool = conn
        .query_row(
            "SELECT is_active FROM users WHERE id = ?1",
            [creator],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false);
    if !active {
        return Ok(false);
    }
    let ws_role = perm::workspace_role(conn, creator, invite.workspace_id()?)?;
    if ws_role == Some(Role::Owner) {
        return Ok(true);
    }
    if invite.info.all_bases {
        return Ok(false);
    }
    let needed = Role::Creator.max(invite.role()?);
    for b in live_listed_bases(conn, invite)? {
        if !perm::base_role(conn, creator, &b)?.is_some_and(|r| r >= needed) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Workspace alive, at least one live base for a limited invite, creator
/// still entitled to invite.
fn still_valid(conn: &Connection, invite: &InviteRow) -> AppResult<bool> {
    if live_workspace(conn, invite)?.is_none() {
        return Ok(false);
    }
    if !invite.info.all_bases && live_listed_bases(conn, invite)?.is_empty() {
        return Ok(false);
    }
    creator_may_still_invite(conn, invite)
}

/// An invite that can still be accepted: unexpired, unaccepted, workspace
/// (and for a limited invite, one of its bases) alive, creator still entitled
/// to invite.
pub fn find_valid_by_token(conn: &Connection, token: &str) -> AppResult<Option<InviteRow>> {
    let row = query(
        conn,
        &format!(
            "SELECT {COLUMNS} FROM invites
             WHERE token_hash = ?1 AND accepted_at IS NULL AND expires_at > ?2"
        ),
        params![hash_token(token), now_ms()],
    )?
    .pop();
    let Some(row) = row else { return Ok(None) };
    if !still_valid(conn, &row)? {
        return Ok(None);
    }
    Ok(Some(row))
}

/// Same as [`find_valid_by_token`] but a 404 with a clear message when invalid.
pub fn require_valid_by_token(conn: &Connection, token: &str) -> AppResult<InviteRow> {
    find_valid_by_token(conn, token)?
        .ok_or_else(|| AppError::not_found("invite (it may have expired or already been used)"))
}

/// Public preview for the accept page. Every invite joins a workspace, so the
/// target is always the workspace, even when it gives only some of its bases.
pub fn preview(conn: &Connection, invite: &InviteRow) -> AppResult<InvitePreview> {
    let (target_name, target_icon) =
        live_workspace(conn, invite)?.ok_or_else(|| AppError::not_found("invite"))?;
    let invited_by: Option<String> = match &invite.created_by {
        Some(uid) => conn
            .query_row("SELECT name FROM users WHERE id = ?1", [uid], |r| r.get(0))
            .optional()?,
        None => None,
    };
    Ok(InvitePreview {
        target_name,
        target_icon,
        target_kind: "workspace".into(),
        role: invite.info.role.clone(),
        email: invite.info.email.clone(),
        invited_by,
    })
}

/// Accept a valid invite for a user: enforce the email restriction, grant the
/// role and base access (merged with any membership they already have; only
/// an owner's invite can raise an existing member's role) and mark the invite
/// used. Returns the updated invite.
pub fn accept(
    conn: &Connection,
    invite: &InviteRow,
    user_id: &str,
    user_email: &str,
) -> AppResult<InviteInfo> {
    // An invite grants access to someone else. Letting its creator redeem it
    // would mint a standalone grant that outlives their membership.
    if invite.created_by.as_deref() == Some(user_id) {
        return Err(AppError::forbidden("you cannot accept your own invite"));
    }
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
    let ws = invite.workspace_id()?;
    let mut role = invite.role()?;
    // A workspace role applies to every base the member can open, so letting
    // a creator's invite raise an existing member would promote them on
    // bases the creator has no say over (a viewer of B made creator of B by
    // someone limited to A). Such an invite only adds its bases, at the
    // member's current role; that role is below owner (owners have every
    // base already), so it never exceeds what the creator could have given.
    if let Some(existing) = perm::workspace_role(conn, user_id, ws)? {
        let by_owner = match &invite.created_by {
            Some(c) => perm::workspace_role(conn, c, ws)? == Some(Role::Owner),
            None => false,
        };
        if !by_owner {
            role = existing;
        }
    }
    workspaces::grant(conn, ws, user_id, role, &invite.access())?;
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
            "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('wsp1', ?1, 'owner', 0)",
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

    fn only(ids: &[&str]) -> BaseAccess {
        BaseAccess::Only(ids.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn grant_keeps_the_higher_role_and_merges_bases() {
        let (c, _owner, ws) = db();
        c.execute(
            "INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('app2', 'wsp1', 'Ops', 0)",
            [],
        )
        .unwrap();
        let u = users::create(&c, "b@example.com", "B", "!", false).unwrap();
        let g = |role, access: &BaseAccess| workspaces::grant(&c, &ws, &u, role, access).unwrap();
        assert_eq!(g(Role::Editor, &only(&["app1"])), Role::Editor);
        assert_eq!(crate::perm::base_role(&c, &u, "app2").unwrap(), None);
        assert_eq!(g(Role::Viewer, &only(&["app2"])), Role::Editor);
        assert_eq!(
            crate::perm::base_role(&c, &u, "app2").unwrap(),
            Some(Role::Editor)
        );
        assert_eq!(g(Role::Viewer, &BaseAccess::All), Role::Editor);
        let all: bool = c
            .query_row(
                "SELECT all_bases FROM workspace_members WHERE user_id = ?1",
                [&u],
                |r| r.get(0),
            )
            .unwrap();
        assert!(all);
        // Once all bases, a later limited grant does not narrow it.
        g(Role::Viewer, &only(&["app1"]));
        let listed: i64 = c
            .query_row(
                "SELECT count(*) FROM workspace_member_bases WHERE user_id = ?1",
                [&u],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(listed, 0);
        assert_eq!(g(Role::Owner, &only(&["app1"])), Role::Owner);
        assert_eq!(
            crate::perm::workspace_role(&c, &u, "wsp1").unwrap(),
            Some(Role::Owner)
        );
    }

    #[test]
    fn accept_flow_and_validity() {
        let (c, owner, ws) = db();
        let b = users::create(&c, "b@example.com", "B", "!", false).unwrap();
        let (token, info) = create(
            &c,
            &owner,
            &ws,
            Some("B@example.com"),
            Role::Editor,
            &only(&["app1"]),
        )
        .unwrap();
        assert!(!info.all_bases);
        assert_eq!(info.base_ids, vec!["app1".to_string()]);
        let row = find_valid_by_token(&c, &token).unwrap().unwrap();
        assert_eq!(row.info.base_ids, vec!["app1".to_string()]);
        let p = preview(&c, &row).unwrap();
        assert_eq!(p.target_name, "Acme");
        assert_eq!(p.target_kind, "workspace");
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
        assert_eq!(list_for_workspace(&c, &ws).unwrap()[0].id, info.id);
    }

    #[test]
    fn expired_and_deleted_target_invites_are_invalid() {
        let (c, owner, ws) = db();
        let (token, info) = create(&c, &owner, &ws, None, Role::Viewer, &BaseAccess::All).unwrap();
        c.execute(
            "UPDATE invites SET expires_at = 0 WHERE id = ?1",
            [&info.id],
        )
        .unwrap();
        assert!(find_valid_by_token(&c, &token).unwrap().is_none());
        // A limited invite whose only base is in the trash cannot be used.
        let (token2, _) = create(&c, &owner, &ws, None, Role::Viewer, &only(&["app1"])).unwrap();
        assert!(find_valid_by_token(&c, &token2).unwrap().is_some());
        c.execute("UPDATE bases SET deleted_at = 1", []).unwrap();
        assert!(find_valid_by_token(&c, &token2).unwrap().is_none());
        c.execute("UPDATE bases SET deleted_at = NULL", []).unwrap();
        c.execute("UPDATE workspaces SET deleted_at = 1", [])
            .unwrap();
        assert!(find_valid_by_token(&c, &token2).unwrap().is_none());
        assert!(find_valid_by_token(&c, "inv_nope").unwrap().is_none());
    }

    #[test]
    fn a_creator_invite_adds_bases_to_an_existing_member_but_never_raises_their_role() {
        let (c, owner, ws) = db();
        c.execute(
            "INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('app2', 'wsp1', 'Ops', 0)",
            [],
        )
        .unwrap();
        let creator = users::create(&c, "cr@example.com", "Cr", "!", false).unwrap();
        workspaces::grant(&c, &ws, &creator, Role::Creator, &only(&["app1"])).unwrap();
        let limited = users::create(&c, "l@example.com", "L", "!", false).unwrap();
        workspaces::grant(&c, &ws, &limited, Role::Viewer, &only(&["app2"])).unwrap();
        let everywhere = users::create(&c, "e@example.com", "E", "!", false).unwrap();
        workspaces::grant(&c, &ws, &everywhere, Role::Viewer, &BaseAccess::All).unwrap();
        let invite_and_accept = |by: &str, user: &str, email: &str, role| {
            let (token, _) = create(&c, by, &ws, None, role, &only(&["app1"])).unwrap();
            let row = find_valid_by_token(&c, &token).unwrap().unwrap();
            accept(&c, &row, user, email).unwrap();
        };
        let role = |u: &str, b: &str| crate::perm::base_role(&c, u, b).unwrap();

        invite_and_accept(&creator, &limited, "l@example.com", Role::Creator);
        assert_eq!(role(&limited, "app1"), Some(Role::Viewer), "base added");
        assert_eq!(role(&limited, "app2"), Some(Role::Viewer), "not raised");
        invite_and_accept(&creator, &everywhere, "e@example.com", Role::Creator);
        assert_eq!(role(&everywhere, "app2"), Some(Role::Viewer));
        assert_eq!(
            crate::perm::workspace_role(&c, &everywhere, &ws).unwrap(),
            Some(Role::Viewer)
        );
        // A newcomer gets the invited role; an owner's invite still raises.
        let new = users::create(&c, "n@example.com", "N", "!", false).unwrap();
        invite_and_accept(&creator, &new, "n@example.com", Role::Editor);
        assert_eq!(role(&new, "app1"), Some(Role::Editor));
        invite_and_accept(&owner, &limited, "l@example.com", Role::Editor);
        assert_eq!(role(&limited, "app2"), Some(Role::Editor));
    }

    #[test]
    fn a_creator_invite_lapses_when_the_creator_loses_a_listed_base() {
        let (c, owner, ws) = db();
        let creator = users::create(&c, "cr@example.com", "Cr", "!", false).unwrap();
        workspaces::grant(&c, &ws, &creator, Role::Creator, &only(&["app1"])).unwrap();
        let (token, _) = create(&c, &creator, &ws, None, Role::Editor, &only(&["app1"])).unwrap();
        assert!(find_valid_by_token(&c, &token).unwrap().is_some());
        // An all-bases invite needs an owner.
        let (all, _) = create(&c, &creator, &ws, None, Role::Editor, &BaseAccess::All).unwrap();
        assert!(find_valid_by_token(&c, &all).unwrap().is_none());
        // Moving the creator to another base voids the invite.
        c.execute(
            "INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('app2', 'wsp1', 'Ops', 0)",
            [],
        )
        .unwrap();
        c.execute(
            "UPDATE workspace_member_bases SET base_id = 'app2' WHERE user_id = ?1",
            [&creator],
        )
        .unwrap();
        assert!(find_valid_by_token(&c, &token).unwrap().is_none());
        let _ = owner;
    }
}
