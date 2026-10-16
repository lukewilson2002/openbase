//! Workspaces and workspace membership.
//!
//! Access checks happen in the handlers (`perm::require_workspace`); the
//! functions here enforce data rules such as "a workspace always keeps at
//! least one owner".

use std::collections::{HashMap, HashSet};

use ob_core::api::workspaces::{
    BasePerson, BaseSummary, CreateWorkspace, Member, TableSummary, WorkspaceSummary,
};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::perm::Role;
use crate::store::{bases, invites, schema};

/// Which bases of a workspace a member (or an invite) gives access to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BaseAccess {
    /// Every base, including bases created later.
    All,
    /// Only these bases.
    Only(Vec<String>),
}

impl BaseAccess {
    fn includes(&self, base_id: &str) -> bool {
        match self {
            BaseAccess::All => true,
            BaseAccess::Only(ids) => ids.iter().any(|b| b == base_id),
        }
    }
}

/// Check a picked list of bases: at least one, each a live base of
/// `workspace_id`. Returns the list without duplicates.
pub fn validate_base_ids(
    conn: &Connection,
    workspace_id: &str,
    base_ids: &[String],
) -> AppResult<Vec<String>> {
    if base_ids.is_empty() {
        return Err(AppError::bad_request(
            "pick at least one base, or give access to all bases",
        ));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for b in base_ids {
        if !seen.insert(b.as_str()) {
            continue;
        }
        let ok: bool = conn
            .query_row(
                "SELECT count(*) > 0 FROM bases
                 WHERE id = ?1 AND workspace_id = ?2 AND deleted_at IS NULL",
                [b, workspace_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if !ok {
            return Err(AppError::bad_request(format!(
                "base '{b}' is not a base of this workspace"
            )));
        }
        out.push(b.clone());
    }
    Ok(out)
}

/// A member row: role and whether they have every base.
fn member_row(
    conn: &Connection,
    workspace_id: &str,
    user_id: &str,
) -> AppResult<Option<(Role, bool)>> {
    let row: Option<(String, bool)> = conn
        .query_row(
            "SELECT role, all_bases FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
            [workspace_id, user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    row.map(|(r, all)| Ok((Role::parse(&r)?, all))).transpose()
}

/// Live bases on a limited member's list, in display order.
fn listed_live_bases(
    conn: &Connection,
    workspace_id: &str,
    user_id: &str,
) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT b.id FROM workspace_member_bases mb JOIN bases b ON b.id = mb.base_id
         WHERE mb.workspace_id = ?1 AND mb.user_id = ?2 AND b.deleted_at IS NULL
         ORDER BY b.position, b.created_at, b.id",
    )?;
    let rows = stmt.query_map([workspace_id, user_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn add_listed_bases(
    conn: &Connection,
    workspace_id: &str,
    user_id: &str,
    base_ids: &[String],
) -> AppResult<()> {
    for b in base_ids {
        conn.execute(
            "INSERT OR IGNORE INTO workspace_member_bases (workspace_id, user_id, base_id)
             VALUES (?1, ?2, ?3)",
            params![workspace_id, user_id, b],
        )?;
    }
    Ok(())
}

/// Make `user_id` a member of `workspace_id` with `role` and `access`, or merge
/// that into their membership: the higher role wins and base access is the
/// union (all bases if either side has them). Owners always get all bases.
pub fn grant(
    conn: &Connection,
    workspace_id: &str,
    user_id: &str,
    role: Role,
    access: &BaseAccess,
) -> AppResult<Role> {
    let existing = member_row(conn, workspace_id, user_id)?;
    let role = existing.map_or(role, |(r, _)| r.max(role));
    let all = role == Role::Owner
        || matches!(access, BaseAccess::All)
        || existing.is_some_and(|(_, all)| all);
    conn.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role, all_bases, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role,
                                                          all_bases = excluded.all_bases",
        params![workspace_id, user_id, role.as_str(), all, now_ms()],
    )?;
    if all {
        conn.execute(
            "DELETE FROM workspace_member_bases WHERE workspace_id = ?1 AND user_id = ?2",
            [workspace_id, user_id],
        )?;
    } else if let BaseAccess::Only(ids) = access {
        add_listed_bases(conn, workspace_id, user_id, ids)?;
    }
    Ok(role)
}

/// A member without all bases who creates (or duplicates) a base gets it on
/// their list; otherwise they could not open the base they just made.
pub fn add_new_base_for_creator(
    tx: &Transaction,
    workspace_id: &str,
    user_id: &str,
    base_id: &str,
) -> AppResult<()> {
    tx.execute(
        "INSERT OR IGNORE INTO workspace_member_bases (workspace_id, user_id, base_id)
         SELECT workspace_id, user_id, ?3 FROM workspace_members
         WHERE workspace_id = ?1 AND user_id = ?2 AND all_bases = 0",
        params![workspace_id, user_id, base_id],
    )?;
    Ok(())
}

fn summary_of(
    base: &bases::BaseRow,
    role: Role,
    people: Vec<BasePerson>,
    tables: Vec<TableSummary>,
) -> BaseSummary {
    BaseSummary {
        id: base.id.clone(),
        workspace_id: base.workspace_id.clone(),
        name: base.name.clone(),
        color: base.color.clone(),
        icon: base.icon.clone(),
        role: role.as_str().to_string(),
        people,
        tables,
    }
}

/// Live tables of every live base in a workspace, by base, in sidebar order:
/// one query per workspace rather than one per base.
fn tables_by_base(
    conn: &Connection,
    workspace_id: &str,
) -> AppResult<HashMap<String, Vec<TableSummary>>> {
    let mut stmt = conn.prepare(
        "SELECT t.base_id, t.id, t.name, t.icon FROM tables t JOIN bases b ON b.id = t.base_id
         WHERE b.workspace_id = ?1 AND b.deleted_at IS NULL AND t.deleted_at IS NULL
         ORDER BY t.position, t.created_at, t.id",
    )?;
    let rows = stmt.query_map([workspace_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            TableSummary {
                id: r.get(1)?,
                name: r.get(2)?,
                icon: r.get(3)?,
            },
        ))
    })?;
    let mut out: HashMap<String, Vec<TableSummary>> = HashMap::new();
    for row in rows {
        let (base_id, table) = row?;
        out.entry(base_id).or_default().push(table);
    }
    Ok(out)
}

/// Members and pending invites of a workspace, to answer "who can open this
/// base" for each of its bases without a query per base.
pub struct People {
    members: Vec<Member>,
    invites: Vec<invites::InviteRow>,
}

impl People {
    pub fn load(conn: &Connection, workspace_id: &str) -> AppResult<People> {
        Ok(People {
            members: members(conn, workspace_id)?,
            invites: invites::pending_for_workspace(conn, workspace_id)?,
        })
    }

    /// Members who can open `base_id`, then pending invites (sent to an
    /// address) that would let someone open it. Unaddressed invite links are
    /// left out: they are not a person yet.
    pub fn for_base(&self, base_id: &str) -> Vec<BasePerson> {
        let members = self
            .members
            .iter()
            .filter(|m| member_can_open(m, base_id))
            .map(|m| BasePerson {
                user_id: Some(m.user_id.clone()),
                name: m.name.clone(),
                email: m.email.clone(),
                pending: false,
                role: m.role.clone(),
            });
        let invited = self
            .invites
            .iter()
            .filter(|i| i.access().includes(base_id))
            .filter_map(|i| {
                let email = i.info.email.clone()?;
                Some(BasePerson {
                    user_id: None,
                    name: email.clone(),
                    email,
                    pending: true,
                    role: i.info.role.clone(),
                })
            });
        members.chain(invited).collect()
    }

    fn member_count(&self) -> i64 {
        self.members.len() as i64
    }

    fn pending_invite_count(&self) -> i64 {
        self.invites.len() as i64
    }
}

fn member_can_open(m: &Member, base_id: &str) -> bool {
    m.all_bases || m.base_ids.iter().any(|b| b == base_id)
}

/// Who can open `base` (for the base schema and base cards).
pub fn people_for_base(conn: &Connection, base: &bases::BaseRow) -> AppResult<Vec<BasePerson>> {
    Ok(People::load(conn, &base.workspace_id)?.for_base(&base.id))
}

/// `GET /api/workspaces`: the workspaces the user is a member of, with their
/// role, the live bases they can open, and who else can open each.
pub fn list_for_user(conn: &Connection, user_id: &str) -> AppResult<Vec<WorkspaceSummary>> {
    let mut out = Vec::new();
    type MemberOf = (String, String, Option<String>, String, String, bool);
    let member_of: Vec<MemberOf> = {
        let mut stmt = conn.prepare(
            "SELECT w.id, w.name, w.icon, w.color, m.role, m.all_bases FROM workspace_members m
             JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = ?1 AND w.deleted_at IS NULL
             ORDER BY w.created_at, w.id",
        )?;
        let rows = stmt.query_map([user_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    for (id, name, icon, color, role, all_bases) in member_of {
        let role = Role::parse(&role)?;
        let people = People::load(conn, &id)?;
        let listed: HashSet<String> = if all_bases {
            HashSet::new()
        } else {
            listed_live_bases(conn, &id, user_id)?.into_iter().collect()
        };
        let mut tables = tables_by_base(conn, &id)?;
        let bases = bases::live_bases_in(conn, &id)?
            .iter()
            .filter(|b| all_bases || listed.contains(&b.id))
            .map(|b| {
                let tables = tables.remove(&b.id).unwrap_or_default();
                summary_of(b, role, people.for_base(&b.id), tables)
            })
            .collect();
        out.push(WorkspaceSummary {
            id,
            name,
            icon,
            color,
            role: role.as_str().to_string(),
            bases,
            member_count: people.member_count(),
            pending_invite_count: people.pending_invite_count(),
        });
    }
    Ok(out)
}

/// Colours handed out to new workspaces, in order. Migration 0006 colours the
/// workspaces that existed before with the same cycle; keep them in step.
pub const DEFAULT_COLORS: [&str; 8] = [
    "green", "blue", "gray", "purple", "orange", "teal", "pink", "yellow",
];

/// The first of [`DEFAULT_COLORS`] that none of `user_id`'s live workspaces
/// uses, so workspaces side by side in the sidebar look different; once all
/// are taken, the cycle continues by how many workspaces they have.
fn next_default_color(conn: &Connection, user_id: &str) -> AppResult<&'static str> {
    let mut stmt = conn.prepare(
        "SELECT w.color FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.user_id = ?1 AND w.deleted_at IS NULL",
    )?;
    let used: Vec<String> = stmt
        .query_map([user_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(DEFAULT_COLORS
        .iter()
        .find(|c| !used.iter().any(|u| u == *c))
        .copied()
        .unwrap_or(DEFAULT_COLORS[used.len() % DEFAULT_COLORS.len()]))
}

/// Create a workspace owned by `user_id`, in `color` or else the next default
/// colour (see [`next_default_color`]).
pub fn create(
    tx: &Transaction,
    user_id: &str,
    input: &CreateWorkspace,
) -> AppResult<WorkspaceSummary> {
    let name = schema::validate_name(&input.name, "workspace")?;
    let icon = schema::icon_on_create(input.icon.as_deref())?;
    let color = match &input.color {
        Some(c) => {
            schema::validate_color(c)?;
            c.clone()
        }
        None => next_default_color(tx, user_id)?.to_string(),
    };
    let id = new_id(ob_core::ids::WORKSPACE);
    let now = now_ms();
    tx.execute(
        "INSERT INTO workspaces (id, name, icon, color, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, name, icon, color, user_id, now],
    )?;
    tx.execute(
        "INSERT INTO workspace_members (workspace_id, user_id, role, all_bases, created_at)
         VALUES (?1, ?2, 'owner', 1, ?3)",
        params![id, user_id, now],
    )?;
    Ok(WorkspaceSummary {
        id,
        name,
        icon,
        color,
        role: Role::Owner.as_str().to_string(),
        bases: Vec::new(),
        member_count: 1,
        pending_invite_count: 0,
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

/// Change a live workspace's colour.
pub fn set_color(tx: &Transaction, workspace_id: &str, color: &str) -> AppResult<()> {
    schema::validate_color(color)?;
    let n = tx.execute(
        "UPDATE workspaces SET color = ?2 WHERE id = ?1 AND deleted_at IS NULL",
        params![workspace_id, color],
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

/// Move a workspace (with everything in it) to the trash, as deleted by
/// `user_id`. Like a base, only the workspace row is stamped.
pub fn soft_delete(tx: &Transaction, workspace_id: &str, user_id: &str) -> AppResult<()> {
    let n = tx.execute(
        "UPDATE workspaces SET deleted_at = ?2, deleted_by = ?3
         WHERE id = ?1 AND deleted_at IS NULL",
        params![workspace_id, now_ms(), user_id],
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

/// Members of a workspace, oldest first, with the bases each can open.
pub fn members(conn: &Connection, workspace_id: &str) -> AppResult<Vec<Member>> {
    let mut lists: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT mb.user_id, b.id FROM workspace_member_bases mb
             JOIN bases b ON b.id = mb.base_id
             WHERE mb.workspace_id = ?1 AND b.deleted_at IS NULL
             ORDER BY b.position, b.created_at, b.id",
        )?;
        let rows = stmt.query_map([workspace_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (user, base) = row?;
            lists.entry(user).or_default().push(base);
        }
    }
    let mut stmt = conn.prepare(
        "SELECT u.id, u.name, u.email, m.role, m.all_bases FROM workspace_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = ?1 ORDER BY m.created_at, u.name, u.id",
    )?;
    let rows = stmt.query_map([workspace_id], |r| {
        Ok(Member {
            user_id: r.get(0)?,
            name: r.get(1)?,
            email: r.get(2)?,
            role: r.get(3)?,
            all_bases: r.get(4)?,
            base_ids: Vec::new(),
        })
    })?;
    let mut out: Vec<Member> = rows.collect::<Result<_, _>>()?;
    for m in out.iter_mut().filter(|m| !m.all_bases) {
        m.base_ids = lists.remove(&m.user_id).unwrap_or_default();
    }
    Ok(out)
}

fn member_role(conn: &Connection, workspace_id: &str, user_id: &str) -> AppResult<Role> {
    member_row(conn, workspace_id, user_id)?
        .map(|(r, _)| r)
        .ok_or_else(|| AppError::not_found("member"))
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

/// A change to a member: absent fields are unchanged.
#[derive(Debug, Default)]
pub struct MemberChange {
    pub role: Option<Role>,
    pub all_bases: Option<bool>,
    pub base_ids: Option<Vec<String>>,
}

/// Change a member's role and/or the bases they can open. The last owner
/// cannot be demoted; owners always have every base; a member limited to
/// some bases keeps at least one.
pub fn update_member(
    tx: &Transaction,
    workspace_id: &str,
    user_id: &str,
    change: MemberChange,
) -> AppResult<()> {
    let (current, current_all) =
        member_row(tx, workspace_id, user_id)?.ok_or_else(|| AppError::not_found("member"))?;
    let role = change.role.unwrap_or(current);
    if current == Role::Owner && role != Role::Owner && owner_count(tx, workspace_id)? <= 1 {
        return Err(last_owner_error());
    }
    let wants_limit = change.all_bases == Some(false)
        || (change.base_ids.is_some() && change.all_bases != Some(true));
    if role == Role::Owner && wants_limit {
        return Err(AppError::bad_request(
            "owners can always open every base; choose another role to limit their bases",
        ));
    }
    let all = if role == Role::Owner {
        true
    } else {
        match (change.all_bases, &change.base_ids) {
            (Some(a), _) => a,
            (None, Some(_)) => false,
            (None, None) => current_all,
        }
    };
    tx.execute(
        "UPDATE workspace_members SET role = ?3, all_bases = ?4
         WHERE workspace_id = ?1 AND user_id = ?2",
        params![workspace_id, user_id, role.as_str(), all],
    )?;
    if all {
        tx.execute(
            "DELETE FROM workspace_member_bases WHERE workspace_id = ?1 AND user_id = ?2",
            [workspace_id, user_id],
        )?;
        return Ok(());
    }
    match change.base_ids {
        Some(ids) => {
            let ids = validate_base_ids(tx, workspace_id, &ids)?;
            // Bases in the trash stay on the list: the member gets them back
            // if the base is restored, and the client never sees them to resend.
            tx.execute(
                "DELETE FROM workspace_member_bases
                 WHERE workspace_id = ?1 AND user_id = ?2
                   AND base_id IN (SELECT id FROM bases WHERE deleted_at IS NULL)",
                [workspace_id, user_id],
            )?;
            add_listed_bases(tx, workspace_id, user_id, &ids)?;
        }
        None if current_all => {
            return Err(AppError::bad_request(
                "pick the bases this member can open (base_ids), or keep all bases",
            ));
        }
        None => {}
    }
    Ok(())
}

/// Take one base off a limited member's list. Members with every base, and
/// members for whom it is the last base, are changed elsewhere.
pub fn remove_listed_base(
    tx: &Transaction,
    workspace_id: &str,
    user_id: &str,
    base_id: &str,
) -> AppResult<()> {
    let (_, all) =
        member_row(tx, workspace_id, user_id)?.ok_or_else(|| AppError::not_found("member"))?;
    if all {
        return Err(AppError::bad_request(
            "this member can open every base of the workspace; change their access on the \
             workspace members page",
        ));
    }
    let listed = listed_live_bases(tx, workspace_id, user_id)?;
    if !listed.iter().any(|b| b == base_id) {
        return Err(AppError::not_found("member"));
    }
    if listed.len() == 1 {
        return Err(AppError::bad_request(
            "this is the only base this member can open; remove them from the workspace instead",
        ));
    }
    tx.execute(
        "DELETE FROM workspace_member_bases WHERE workspace_id = ?1 AND user_id = ?2 AND base_id = ?3",
        params![workspace_id, user_id, base_id],
    )?;
    Ok(())
}

/// Remove a member (or let them leave); their base list goes with them. The
/// last owner cannot go.
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
