//! Trash: listing, restoring and permanently purging soft-deleted items.
//!
//! Deleting a workspace, base, table, field, view or record only stamps
//! `deleted_at` (and `deleted_by`, who did it); the data stays until
//! [`purge_expired`] removes it after the retention period. Cascades stamp the
//! same values on everything trashed in one operation so restoring the root
//! brings back exactly those items. Restoring clears both.

use std::collections::{HashMap, HashSet};

use ob_core::api::records::{TrashItem, TrashListing};
use ob_core::field::FieldKind;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value as Json};

use crate::auth::{Actor, Capability};
use crate::engine::write::{self, WriteCtx, WriteOutcome, WriteSource};
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::store::schema::{self, Touched};
use crate::store::{fields, workspaces};

/// Most trashed records shown in one listing (newest first).
const MAX_TRASHED_RECORDS_LISTED: i64 = 1000;
/// Rows handled per batch while purging records.
const PURGE_BATCH: i64 = 1000;

// ----------------------------------------------------------------- listing

/// How long a trashed item is kept before [`purge_expired`] removes it.
pub fn retention_ms(trash_days: u32) -> i64 {
    i64::from(trash_days) * 24 * 3600 * 1000
}

/// The kinds of item the trash holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Workspace,
    Base,
    Table,
    Field,
    View,
    Record,
}

impl Kind {
    pub fn parse(s: &str) -> AppResult<Kind> {
        Ok(match s {
            "workspace" => Kind::Workspace,
            "base" => Kind::Base,
            "table" => Kind::Table,
            "field" => Kind::Field,
            "view" => Kind::View,
            "record" => Kind::Record,
            other => {
                return Err(AppError::bad_request(format!(
                    "unknown trash item kind '{other}' (workspace, base, table, field, view or record)"
                )));
            }
        })
    }
}

/// What [`list_all`] is narrowed to; `None` means no restriction.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub workspace_id: Option<String>,
    pub base_id: Option<String>,
    pub kind: Option<Kind>,
}

impl Filter {
    fn wants(&self, kind: Kind) -> bool {
        self.kind.is_none_or(|k| k == kind)
    }

    fn wants_workspace(&self, id: &str) -> bool {
        self.workspace_id.as_deref().is_none_or(|w| w == id)
    }

    fn wants_base(&self, id: &str) -> bool {
        self.base_id.as_deref().is_none_or(|b| b == id)
    }

    fn wants_inside_bases(&self) -> bool {
        [Kind::Table, Kind::Field, Kind::View, Kind::Record]
            .into_iter()
            .any(|k| self.wants(k))
    }
}

/// The workspace (and base) a trashed item belongs to. Every item carries it,
/// so one listing across workspaces can say where each thing came from and
/// show the real tile of a trashed base or workspace.
#[derive(Debug, Clone)]
struct Place {
    workspace_id: String,
    workspace_name: String,
    workspace_color: String,
    base: Option<BasePlace>,
}

#[derive(Debug, Clone)]
struct BasePlace {
    id: String,
    name: String,
    icon: Option<String>,
    color: String,
}

/// A trashed row before it is given its [`Place`].
struct Found {
    kind: &'static str,
    id: String,
    name: String,
    icon: Option<String>,
    table_id: Option<String>,
    table_name: Option<String>,
    deleted_at: i64,
    deleted_by_id: Option<String>,
    deleted_by_name: Option<String>,
}

impl Place {
    fn item(&self, f: Found, retention_ms: i64) -> TrashItem {
        let base = self.base.as_ref();
        TrashItem {
            kind: f.kind.into(),
            id: f.id,
            name: f.name,
            icon: f.icon,
            table_id: f.table_id,
            deleted_at: f.deleted_at,
            workspace_id: self.workspace_id.clone(),
            workspace_name: self.workspace_name.clone(),
            workspace_color: self.workspace_color.clone(),
            base_id: base.map(|b| b.id.clone()),
            base_name: base.map(|b| b.name.clone()),
            base_icon: base.and_then(|b| b.icon.clone()),
            base_color: base.map(|b| b.color.clone()),
            table_name: f.table_name,
            deleted_by_id: f.deleted_by_id,
            deleted_by_name: f.deleted_by_name,
            expires_at: f.deleted_at.saturating_add(retention_ms),
        }
    }
}

/// The place of a base (live or trashed) and its workspace.
fn base_place(conn: &Connection, base_id: &str) -> AppResult<Place> {
    conn.query_row(
        "SELECT b.id, b.name, b.icon, b.color, w.id, w.name, w.color
         FROM bases b JOIN workspaces w ON w.id = b.workspace_id WHERE b.id = ?1",
        [base_id],
        |r| {
            Ok(Place {
                base: Some(BasePlace {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    icon: r.get(2)?,
                    color: r.get(3)?,
                }),
                workspace_id: r.get(4)?,
                workspace_name: r.get(5)?,
                workspace_color: r.get(6)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("base"))
}

fn primary_text(v: SqlValue) -> String {
    match v {
        SqlValue::Text(s) => s,
        SqlValue::Integer(i) => i.to_string(),
        SqlValue::Real(f) => f.to_string(),
        _ => String::new(),
    }
}

/// What a caller may restore inside one live base (mirrors [`authorize`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InBase {
    /// Creator and up: tables, fields, shared views, their own personal views
    /// and records.
    Everything,
    /// Below creator: only their own personal views.
    OwnViews,
}

/// The trash of one live base, unsorted: tables, fields, views (shared ones
/// only with [`InBase::Everything`], and the caller's own personal ones) and
/// the newest records.
fn base_items(
    conn: &Connection,
    place: &Place,
    user_id: &str,
    scope: InBase,
    filter: &Filter,
    retention_ms: i64,
) -> AppResult<Vec<TrashItem>> {
    let base_id = place
        .base
        .as_ref()
        .map(|b| b.id.as_str())
        .ok_or_else(|| AppError::internal("base trash without a base"))?;
    let everything = scope == InBase::Everything;
    let mut found: Vec<Found> = Vec::new();

    if everything && filter.wants(Kind::Table) {
        let mut stmt = conn.prepare(
            "SELECT t.id, t.name, t.icon, t.deleted_at, t.deleted_by, u.name
             FROM tables t LEFT JOIN users u ON u.id = t.deleted_by
             WHERE t.base_id = ?1 AND t.deleted_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([base_id], |r| {
            Ok(Found {
                kind: "table",
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                table_id: None,
                table_name: None,
                deleted_at: r.get(3)?,
                deleted_by_id: r.get(4)?,
                deleted_by_name: r.get(5)?,
            })
        })?;
        for row in rows {
            found.push(row?);
        }
    }

    if everything && filter.wants(Kind::Field) {
        found.extend(trashed_fields(conn, base_id)?);
    }

    if filter.wants(Kind::View) {
        let mut stmt = conn.prepare(
            "SELECT v.id, v.name, v.table_id, t.name, v.deleted_at, v.deleted_by, u.name
             FROM views v JOIN tables t ON t.id = v.table_id
             LEFT JOIN users u ON u.id = v.deleted_by
             WHERE t.base_id = ?1 AND t.deleted_at IS NULL AND v.deleted_at IS NOT NULL
               AND ((?3 AND v.personal_owner_id IS NULL) OR v.personal_owner_id = ?2)",
        )?;
        let rows = stmt.query_map(params![base_id, user_id, everything], |r| {
            Ok(Found {
                kind: "view",
                id: r.get(0)?,
                name: r.get(1)?,
                icon: None,
                table_id: Some(r.get(2)?),
                table_name: Some(r.get(3)?),
                deleted_at: r.get(4)?,
                deleted_by_id: r.get(5)?,
                deleted_by_name: r.get(6)?,
            })
        })?;
        for row in rows {
            found.push(row?);
        }
    }

    if everything && filter.wants(Kind::Record) {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.table_id, t.name, r.deleted_at,
                    json_extract(r.data, '$.\"' || t.primary_field_id || '\"'),
                    r.deleted_by, u.name
             FROM records r JOIN tables t ON t.id = r.table_id
             LEFT JOIN users u ON u.id = r.deleted_by
             WHERE t.base_id = ?1 AND t.deleted_at IS NULL AND r.deleted_at IS NOT NULL
             ORDER BY r.deleted_at DESC, r.id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![base_id, MAX_TRASHED_RECORDS_LISTED], |r| {
            Ok(Found {
                kind: "record",
                id: r.get(0)?,
                name: primary_text(r.get::<_, SqlValue>(4)?),
                icon: None,
                table_id: Some(r.get(1)?),
                table_name: Some(r.get(2)?),
                deleted_at: r.get(3)?,
                deleted_by_id: r.get(5)?,
                deleted_by_name: r.get(6)?,
            })
        })?;
        for row in rows {
            found.push(row?);
        }
    }

    Ok(found
        .into_iter()
        .map(|f| place.item(f, retention_ms))
        .collect())
}

/// Newest first; the kind and id break ties so the order is stable.
fn newest_first(items: &mut [TrashItem]) {
    items.sort_by(|a, b| {
        b.deleted_at
            .cmp(&a.deleted_at)
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.id.cmp(&b.id))
    });
}

/// Keep only the newest [`MAX_TRASHED_RECORDS_LISTED`] records of a sorted
/// listing (each base contributes at most that many, so the merge is exact).
fn cap_records(items: &mut Vec<TrashItem>) {
    let mut records = 0;
    items.retain(|i| {
        if i.kind != "record" {
            return true;
        }
        records += 1;
        records <= MAX_TRASHED_RECORDS_LISTED
    });
}

/// Everything in the trash of a base, newest first: tables, fields, views
/// (only shared ones and the caller's own personal ones) and records. The
/// caller must be allowed to restore them (Creator).
pub fn list_base(
    conn: &Connection,
    base_id: &str,
    user_id: &str,
    retention_ms: i64,
) -> AppResult<TrashListing> {
    let place = base_place(conn, base_id)?;
    let mut items = base_items(
        conn,
        &place,
        user_id,
        InBase::Everything,
        &Filter::default(),
        retention_ms,
    )?;
    newest_first(&mut items);
    Ok(TrashListing { items })
}

/// Trashed fields of live tables. A link pair trashed together is listed once.
fn trashed_fields(conn: &Connection, base_id: &str) -> AppResult<Vec<Found>> {
    let all = schema::base_field_records_all(conn, base_id)?;
    let stamps: HashMap<&str, Option<i64>> = all
        .iter()
        .map(|r| (r.field.id.as_str(), r.deleted_at))
        .collect();
    let by_id: HashMap<&str, &schema::FieldRecord> =
        all.iter().map(|r| (r.field.id.as_str(), r)).collect();
    let live_tables: HashMap<String, String> = schema::live_tables(conn, base_id)?
        .into_iter()
        .map(|t| (t.id, t.name))
        .collect();
    let mut deleted_by: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT f.id, f.deleted_by, u.name FROM fields f JOIN tables t ON t.id = f.table_id
             LEFT JOIN users u ON u.id = f.deleted_by
             WHERE t.base_id = ?1 AND f.deleted_at IS NOT NULL",
        )?;
        let rows = stmt.query_map([base_id], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
        for row in rows {
            let (id, by) = row?;
            deleted_by.insert(id, by);
        }
    }
    let mut out = Vec::new();
    for r in &all {
        let Some(at) = r.deleted_at else { continue };
        let Some(table_name) = live_tables.get(&r.field.table_id) else {
            continue;
        };
        if let FieldKind::Link(l) = &r.field.kind {
            // A pair trashed together is listed once. A link whose partner no
            // longer links back (the partner changed type) cannot be restored,
            // so it is not offered.
            let partner_links_back = by_id.get(l.inverse_field_id.as_str()).is_some_and(
                |p| matches!(&p.field.kind, FieldKind::Link(b) if b.inverse_field_id == r.field.id),
            );
            if !partner_links_back {
                continue;
            }
            let partner_same_stamp = stamps.get(l.inverse_field_id.as_str()) == Some(&Some(at));
            if partner_same_stamp && l.inverse_field_id < r.field.id {
                continue;
            }
        }
        let (by_id, by_name) = deleted_by.remove(&r.field.id).unwrap_or_default();
        out.push(Found {
            kind: "field",
            id: r.field.id.clone(),
            name: r.field.name.clone(),
            icon: None,
            table_id: Some(r.field.table_id.clone()),
            table_name: Some(table_name.clone()),
            deleted_at: at,
            deleted_by_id: by_id,
            deleted_by_name: by_name,
        });
    }
    Ok(out)
}

/// Trashed bases of a workspace, newest first. The caller must be allowed to
/// restore them (owner).
pub fn list_workspace(
    conn: &Connection,
    workspace_id: &str,
    retention_ms: i64,
) -> AppResult<TrashListing> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.name, b.icon, b.color, b.deleted_at, b.deleted_by, u.name,
                w.id, w.name, w.color
         FROM bases b JOIN workspaces w ON w.id = b.workspace_id
         LEFT JOIN users u ON u.id = b.deleted_by
         WHERE b.workspace_id = ?1 AND b.deleted_at IS NOT NULL
         ORDER BY b.deleted_at DESC, b.id",
    )?;
    let items = stmt
        .query_map([workspace_id], |r| {
            let base = BasePlace {
                id: r.get(0)?,
                name: r.get(1)?,
                icon: r.get(2)?,
                color: r.get(3)?,
            };
            let found = Found {
                kind: "base",
                id: base.id.clone(),
                name: base.name.clone(),
                icon: base.icon.clone(),
                table_id: None,
                table_name: None,
                deleted_at: r.get(4)?,
                deleted_by_id: r.get(5)?,
                deleted_by_name: r.get(6)?,
            };
            let place = Place {
                workspace_id: r.get(7)?,
                workspace_name: r.get(8)?,
                workspace_color: r.get(9)?,
                base: Some(base),
            };
            Ok(place.item(found, retention_ms))
        })?
        .collect::<Result<_, _>>()?;
    Ok(TrashListing { items })
}

/// Workspaces in the trash that `user_id` owns, newest first. Once a workspace
/// is deleted, `GET /api/workspaces/{id}/trash` answers 404 (the workspace no
/// longer resolves), so this is how an owner finds one to restore.
pub fn list_deleted_workspaces(
    conn: &Connection,
    user_id: &str,
    retention_ms: i64,
) -> AppResult<TrashListing> {
    let mut stmt = conn.prepare(
        "SELECT w.id, w.name, w.color, w.icon, w.deleted_at, w.deleted_by, u.name
         FROM workspaces w
         JOIN workspace_members m ON m.workspace_id = w.id
         LEFT JOIN users u ON u.id = w.deleted_by
         WHERE w.deleted_at IS NOT NULL AND m.user_id = ?1 AND m.role = 'owner'
         ORDER BY w.deleted_at DESC, w.id",
    )?;
    let items = stmt
        .query_map([user_id], |r| {
            let place = Place {
                workspace_id: r.get(0)?,
                workspace_name: r.get(1)?,
                workspace_color: r.get(2)?,
                base: None,
            };
            let found = Found {
                kind: "workspace",
                id: place.workspace_id.clone(),
                name: place.workspace_name.clone(),
                icon: r.get(3)?,
                table_id: None,
                table_name: None,
                deleted_at: r.get(4)?,
                deleted_by_id: r.get(5)?,
                deleted_by_name: r.get(6)?,
            };
            Ok(place.item(found, retention_ms))
        })?
        .collect::<Result<_, _>>()?;
    Ok(TrashListing { items })
}

/// Whether an API token's base limit (if any) lets it reach `base_id`.
fn token_reaches_base(actor: &Actor, base_id: &str) -> bool {
    actor
        .token_scope
        .as_ref()
        .and_then(|s| s.base_ids.as_ref())
        .is_none_or(|bases| bases.iter().any(|b| b == base_id))
}

/// `GET /api/trash`: everything the caller could restore, from every workspace
/// they belong to, newest first. Each part applies the rule [`authorize`]
/// applies to restoring it, so nothing is listed that restoring would refuse:
///
/// - deleted workspaces they own (the manage permission without a base limit);
/// - trashed bases of live workspaces they own (the manage permission, and a
///   base-limited token only sees its bases);
/// - inside each live base they can open: everything with the creator role,
///   and their own personal views at any role (nothing for a read-only token).
///
/// Items inside trashed bases or workspaces are not listed: they come back
/// with the base or workspace, and cannot be restored on their own.
pub fn list_all(
    conn: &Connection,
    actor: &Actor,
    filter: &Filter,
    retention_ms: i64,
) -> AppResult<TrashListing> {
    let mut items: Vec<TrashItem> = Vec::new();
    if filter.base_id.is_none()
        && filter.wants(Kind::Workspace)
        && actor.require_capability(Capability::ManageUnscoped).is_ok()
    {
        items.extend(
            list_deleted_workspaces(conn, &actor.user_id, retention_ms)?
                .items
                .into_iter()
                .filter(|i| filter.wants_workspace(&i.id)),
        );
    }

    let memberships: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT w.id, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
             WHERE m.user_id = ?1 AND w.deleted_at IS NULL ORDER BY w.created_at, w.id",
        )?;
        let rows = stmt.query_map([&actor.user_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let manages_bases = actor.require_capability(Capability::Manage).is_ok();
    for (workspace_id, role) in memberships {
        if !filter.wants_workspace(&workspace_id) {
            continue;
        }
        if Role::parse(&role)? == Role::Owner && manages_bases && filter.wants(Kind::Base) {
            items.extend(
                list_workspace(conn, &workspace_id, retention_ms)?
                    .items
                    .into_iter()
                    .filter(|i| filter.wants_base(&i.id) && token_reaches_base(actor, &i.id)),
            );
        }
        // A read-only token may restore nothing (it acts as a viewer, whose
        // own personal views would otherwise be listed but refused).
        if !filter.wants_inside_bases() || actor.token_scope.as_ref().is_some_and(|s| !s.write) {
            continue;
        }
        let bases: Vec<String> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT b.id FROM bases b
                 JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.user_id = ?2
                 WHERE b.workspace_id = ?1 AND b.deleted_at IS NULL AND {}
                 ORDER BY b.position, b.created_at, b.id",
                perm::MEMBER_CAN_OPEN_BASE
            ))?;
            let rows = stmt.query_map([&workspace_id, &actor.user_id], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for base_id in bases.iter().filter(|b| filter.wants_base(b)) {
            // The same check `authorize` makes for items in a base, including
            // a token's base limit and a read-only token acting as viewer.
            let Ok(role) = perm::require_base(conn, actor, base_id, Role::Viewer) else {
                continue;
            };
            let scope = if role >= Role::Creator {
                InBase::Everything
            } else {
                InBase::OwnViews
            };
            if scope == InBase::OwnViews && !filter.wants(Kind::View) {
                continue;
            }
            let place = base_place(conn, base_id)?;
            items.extend(base_items(
                conn,
                &place,
                &actor.user_id,
                scope,
                filter,
                retention_ms,
            )?);
        }
    }
    newest_first(&mut items);
    cap_records(&mut items);
    Ok(TrashListing { items })
}

// ----------------------------------------------------------------- restore

/// What a restore request points at, once authorized.
#[derive(Debug, Clone)]
pub enum Target {
    Workspace(String),
    Base(String),
    Table(String),
    Field(String),
    View(String),
    Record(String),
}

fn lookup_text(conn: &Connection, sql: &str, id: &str, what: &str) -> AppResult<String> {
    conn.query_row(sql, [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| AppError::not_found(what.to_string()))
}

/// Role of the user on a workspace even while it is in the trash.
fn workspace_role_any(
    conn: &Connection,
    user_id: &str,
    workspace_id: &str,
) -> AppResult<Option<Role>> {
    let role: Option<String> = conn
        .query_row(
            "SELECT role FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
            [workspace_id, user_id],
            |r| r.get(0),
        )
        .optional()?;
    role.as_deref().map(Role::parse).transpose()
}

/// Resolve `{kind, id}` to a [`Target`] and check the actor may restore it:
/// Owner for workspaces and bases (session only), Creator for items inside a
/// base, the owner for their own personal views.
pub fn authorize(conn: &Connection, actor: &Actor, kind: &str, id: &str) -> AppResult<Target> {
    match kind {
        "workspace" => {
            actor.require_capability(Capability::ManageUnscoped)?;
            lookup_text(
                conn,
                "SELECT id FROM workspaces WHERE id = ?1",
                id,
                "workspace",
            )?;
            match workspace_role_any(conn, &actor.user_id, id)? {
                None => Err(AppError::not_found("workspace")),
                Some(r) if r < Role::Owner => Err(AppError::forbidden(
                    "this action requires the owner role on this workspace",
                )),
                Some(_) => Ok(Target::Workspace(id.to_string())),
            }
        }
        "base" => {
            actor.require_capability(Capability::Manage)?;
            lookup_text(conn, "SELECT id FROM bases WHERE id = ?1", id, "base")?;
            if actor
                .token_scope
                .as_ref()
                .and_then(|s| s.base_ids.as_ref())
                .is_some_and(|bases| !bases.iter().any(|b| b == id))
            {
                return Err(AppError::not_found("base"));
            }
            match perm::base_role_including_trashed(conn, &actor.user_id, id)? {
                None => Err(AppError::not_found("base")),
                Some(r) if r < Role::Owner => Err(AppError::forbidden(
                    "this action requires the owner role on this base",
                )),
                Some(_) => Ok(Target::Base(id.to_string())),
            }
        }
        "table" => {
            let base = lookup_text(
                conn,
                "SELECT base_id FROM tables WHERE id = ?1",
                id,
                "table",
            )?;
            perm::require_base(conn, actor, &base, Role::Creator)?;
            Ok(Target::Table(id.to_string()))
        }
        "field" => {
            let base = lookup_text(
                conn,
                "SELECT t.base_id FROM fields f JOIN tables t ON t.id = f.table_id WHERE f.id = ?1",
                id,
                "field",
            )?;
            perm::require_base(conn, actor, &base, Role::Creator)?;
            Ok(Target::Field(id.to_string()))
        }
        "view" => {
            let row: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT t.base_id, v.personal_owner_id FROM views v
                     JOIN tables t ON t.id = v.table_id WHERE v.id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            let (base, owner) = row.ok_or_else(|| AppError::not_found("view"))?;
            match owner {
                Some(o) if o == actor.user_id => {
                    perm::require_base(conn, actor, &base, Role::Viewer)?;
                }
                Some(_) => return Err(AppError::not_found("view")),
                None => {
                    perm::require_base(conn, actor, &base, Role::Creator)?;
                }
            }
            Ok(Target::View(id.to_string()))
        }
        "record" => {
            let base = lookup_text(
                conn,
                "SELECT t.base_id FROM records r JOIN tables t ON t.id = r.table_id WHERE r.id = ?1",
                id,
                "record",
            )?;
            perm::require_base(conn, actor, &base, Role::Creator)?;
            Ok(Target::Record(id.to_string()))
        }
        other => Err(AppError::bad_request(format!(
            "unknown trash item kind '{other}'"
        ))),
    }
}

/// What a restore changed, for event publishing.
#[derive(Debug, Clone, Default)]
pub struct Restored {
    /// Bases whose subscribers should hear about it.
    pub base_ids: Vec<String>,
    /// Schema change to announce (tables/fields/views).
    pub schema: Option<Touched>,
    /// Announce `BaseChanged` (bases, workspaces).
    pub base_changed: bool,
    /// Fields brought back (field restores bring back partners/dependents).
    pub restored_field_ids: Vec<String>,
    /// What restoring a record changed (records of several tables when
    /// linked records had to be recalculated); publish its events.
    pub records: Option<WriteOutcome>,
}

fn not_in_trash() -> AppError {
    AppError::conflict("this item is not in the trash")
}

/// Restore an authorized target on behalf of `user_id`.
pub fn restore(tx: &Transaction, target: &Target, user_id: Option<&str>) -> AppResult<Restored> {
    match target {
        Target::Workspace(id) => restore_workspace(tx, id),
        Target::Base(id) => restore_base(tx, id),
        Target::Table(id) => restore_table(tx, id),
        Target::Field(id) => {
            let base = schema::table_any(
                tx,
                &schema::field_any(tx, id)?
                    .ok_or_else(|| AppError::not_found("field"))?
                    .field
                    .table_id,
            )?
            .ok_or_else(|| AppError::not_found("table"))?
            .base_id;
            let out = fields::restore(tx, id)?;
            Ok(Restored {
                base_ids: vec![base],
                schema: Some(out.touched),
                restored_field_ids: out.restored_field_ids,
                ..Restored::default()
            })
        }
        Target::View(id) => restore_view(tx, id),
        Target::Record(id) => restore_record(tx, id, user_id),
    }
}

fn restore_workspace(tx: &Transaction, id: &str) -> AppResult<Restored> {
    let n = tx.execute(
        "UPDATE workspaces SET deleted_at = NULL, deleted_by = NULL
         WHERE id = ?1 AND deleted_at IS NOT NULL",
        [id],
    )?;
    if n == 0 {
        return Err(not_in_trash());
    }
    Ok(Restored {
        base_ids: workspaces::base_ids(tx, id)?,
        base_changed: true,
        ..Restored::default()
    })
}

fn restore_base(tx: &Transaction, id: &str) -> AppResult<Restored> {
    let base = crate::store::bases::base_any(tx, id)?.ok_or_else(|| AppError::not_found("base"))?;
    if base.deleted_at.is_none() {
        return Err(not_in_trash());
    }
    let ws_live: bool = tx.query_row(
        "SELECT deleted_at IS NULL FROM workspaces WHERE id = ?1",
        [&base.workspace_id],
        |r| r.get(0),
    )?;
    if !ws_live {
        return Err(AppError::conflict("restore the workspace first"));
    }
    tx.execute(
        "UPDATE bases SET deleted_at = NULL, deleted_by = NULL WHERE id = ?1",
        [id],
    )?;
    Ok(Restored {
        base_ids: vec![id.to_string()],
        base_changed: true,
        ..Restored::default()
    })
}

fn restore_table(tx: &Transaction, id: &str) -> AppResult<Restored> {
    let table = schema::table_any(tx, id)?.ok_or_else(|| AppError::not_found("table"))?;
    let Some(stamp) = table.deleted_at else {
        return Err(not_in_trash());
    };
    let live: Vec<String> = schema::live_tables(tx, &table.base_id)?
        .into_iter()
        .map(|t| t.name)
        .collect();
    if live.len() >= ob_core::limits::MAX_TABLES_PER_BASE {
        return Err(AppError::bad_request(format!(
            "a base can have at most {} tables",
            ob_core::limits::MAX_TABLES_PER_BASE
        )));
    }
    let taken = schema::name_keys(live.iter().map(String::as_str));
    let name = if taken.contains(&schema::name_key(&table.name)) {
        let head: String = table
            .name
            .chars()
            .take(ob_core::limits::MAX_NAME_LEN - 16)
            .collect();
        schema::uniquify(&taken, &format!("{head} (restored)"))
    } else {
        table.name.clone()
    };
    tx.execute(
        "UPDATE tables SET deleted_at = NULL, deleted_by = NULL, name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    let mut touched = Touched::of(id);
    for t in fields::restore_incoming_links(tx, &table, stamp)?.0 {
        touched.add(&t);
    }
    // While the table was in the trash, records of the tables it links to
    // were deleted or edited without reaching it (the engine only sees live
    // tables), so its counts, lookups, rollups and formulas are as old as the
    // deletion. Bring them up to date, for every record including trashed
    // ones; whatever depends on them in other tables follows.
    let computed: Vec<String> = schema::table_fields(tx, id)?
        .into_iter()
        .filter(|f| crate::engine::recompute::is_materialized(&f.kind))
        .map(|f| f.id)
        .collect();
    if !computed.is_empty() {
        crate::engine::recompute::recompute_fields(tx, &table.base_id, id, &computed)?;
    }
    Ok(Restored {
        base_ids: vec![table.base_id],
        schema: Some(touched),
        ..Restored::default()
    })
}

fn restore_view(tx: &Transaction, id: &str) -> AppResult<Restored> {
    let view = schema::view_any(tx, id)?.ok_or_else(|| AppError::not_found("view"))?;
    if view.deleted_at.is_none() {
        return Err(not_in_trash());
    }
    let table =
        schema::table_any(tx, &view.view.table_id)?.ok_or_else(|| AppError::not_found("table"))?;
    if table.deleted_at.is_some() {
        return Err(AppError::conflict("restore the table first"));
    }
    tx.execute(
        "UPDATE views SET deleted_at = NULL, deleted_by = NULL WHERE id = ?1",
        [id],
    )?;
    Ok(Restored {
        base_ids: vec![table.base_id],
        schema: Some(Touched::of(&table.id)),
        ..Restored::default()
    })
}

fn restore_record(tx: &Transaction, id: &str, user_id: Option<&str>) -> AppResult<Restored> {
    let (table_id, deleted): (String, Option<i64>) = tx
        .query_row(
            "SELECT table_id, deleted_at FROM records WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("record"))?;
    if deleted.is_none() {
        return Err(not_in_trash());
    }
    let table = schema::table_any(tx, &table_id)?.ok_or_else(|| AppError::not_found("table"))?;
    if table.deleted_at.is_some() {
        return Err(AppError::conflict("restore the table first"));
    }
    // The write engine brings the record back, recalculates its computed
    // fields and the counts/lookups/rollups of the records it links to.
    let ctx = WriteCtx::new(user_id, WriteSource::Api);
    let outcome = write::restore_records(tx, &ctx, &table_id, &[id.to_string()])?;
    Ok(Restored {
        base_ids: vec![table.base_id],
        records: Some(outcome),
        ..Restored::default()
    })
}

// ------------------------------------------------------------------- purge

/// How much a purge removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgeStats {
    pub workspaces: usize,
    pub bases: usize,
    pub tables: usize,
    pub fields: usize,
    pub views: usize,
    pub records: usize,
}

fn ids(tx: &Transaction, sql: &str, p: impl rusqlite::Params) -> AppResult<Vec<String>> {
    let mut stmt = tx.prepare(sql)?;
    let rows = stmt.query_map(p, |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn count(tx: &Transaction, sql: &str, id: &str) -> AppResult<usize> {
    let n: i64 = tx.query_row(sql, [id], |r| r.get(0))?;
    Ok(n as usize)
}

/// Permanently delete everything trashed before `cutoff_ms`: workspaces,
/// bases and tables with all their contents; records (also removing their ids
/// from the link arrays of the records they were linked to); views; and fields
/// (also removing their key from every record of the table).
pub fn purge_expired(tx: &Transaction, cutoff_ms: i64) -> AppResult<PurgeStats> {
    let mut stats = PurgeStats::default();
    for id in ids(
        tx,
        "SELECT id FROM workspaces WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [cutoff_ms],
    )? {
        purge_workspace(tx, &id, &mut stats)?;
    }
    for id in ids(
        tx,
        "SELECT id FROM bases WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [cutoff_ms],
    )? {
        purge_base(tx, &id, &mut stats)?;
    }
    for id in ids(
        tx,
        "SELECT id FROM tables WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [cutoff_ms],
    )? {
        purge_table(tx, &id, &mut stats)?;
    }
    purge_records(tx, cutoff_ms, &mut stats)?;
    purge_views(tx, cutoff_ms, &mut stats)?;
    purge_fields(tx, cutoff_ms, &mut stats)?;
    Ok(stats)
}

fn purge_workspace(tx: &Transaction, id: &str, stats: &mut PurgeStats) -> AppResult<()> {
    for base in ids(tx, "SELECT id FROM bases WHERE workspace_id = ?1", [id])? {
        purge_base(tx, &base, stats)?;
    }
    stats.workspaces += tx.execute("DELETE FROM workspaces WHERE id = ?1", [id])?;
    Ok(())
}

fn purge_base(tx: &Transaction, id: &str, stats: &mut PurgeStats) -> AppResult<()> {
    for table in ids(tx, "SELECT id FROM tables WHERE base_id = ?1", [id])? {
        purge_table(tx, &table, stats)?;
    }
    stats.bases += tx.execute("DELETE FROM bases WHERE id = ?1", [id])?;
    Ok(())
}

fn purge_table(tx: &Transaction, id: &str, stats: &mut PurgeStats) -> AppResult<()> {
    stats.records += count(tx, "SELECT count(*) FROM records WHERE table_id = ?1", id)?;
    stats.fields += count(tx, "SELECT count(*) FROM fields WHERE table_id = ?1", id)?;
    stats.views += count(tx, "SELECT count(*) FROM views WHERE table_id = ?1", id)?;
    tx.execute("DELETE FROM record_history WHERE table_id = ?1", [id])?;
    // Foreign keys cascade to fields, views, records and comments.
    stats.tables += tx.execute("DELETE FROM tables WHERE id = ?1", [id])?;
    Ok(())
}

/// Link fields of a table (live or trashed) as (field id, inverse field id).
fn link_pairs(tx: &Transaction, table_id: &str) -> AppResult<Vec<(String, String)>> {
    let mut stmt =
        tx.prepare("SELECT id, options FROM fields WHERE table_id = ?1 AND type = 'link'")?;
    let rows = stmt
        .query_map([table_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, options)| {
            let o: Json = serde_json::from_str(&options).ok()?;
            let inverse = o.get("inverse_field_id")?.as_str()?.to_string();
            Some((id, inverse))
        })
        .collect())
}

fn purge_records(tx: &Transaction, cutoff_ms: i64, stats: &mut PurgeStats) -> AppResult<()> {
    let mut pairs_cache: HashMap<String, Vec<(String, String)>> = HashMap::new();
    loop {
        let batch: Vec<(String, String, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, table_id, data FROM records
                 WHERE deleted_at IS NOT NULL AND deleted_at < ?1 LIMIT ?2",
            )?;
            stmt.query_map(params![cutoff_ms, PURGE_BATCH], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<Result<_, _>>()?
        };
        if batch.is_empty() {
            return Ok(());
        }
        let purged: HashSet<&str> = batch.iter().map(|(id, _, _)| id.as_str()).collect();
        // other record id -> inverse field id -> purged ids to remove
        let mut removals: HashMap<String, HashMap<String, HashSet<String>>> = HashMap::new();
        for (id, table_id, data) in &batch {
            if !pairs_cache.contains_key(table_id) {
                pairs_cache.insert(table_id.clone(), link_pairs(tx, table_id)?);
            }
            let Ok(obj) = serde_json::from_str::<Map<String, Json>>(data) else {
                continue;
            };
            for (field_id, inverse_id) in &pairs_cache[table_id] {
                let Some(Json::Array(linked)) = obj.get(field_id) else {
                    continue;
                };
                for other in linked.iter().filter_map(Json::as_str) {
                    if purged.contains(other) {
                        continue;
                    }
                    removals
                        .entry(other.to_string())
                        .or_default()
                        .entry(inverse_id.clone())
                        .or_default()
                        .insert(id.clone());
                }
            }
        }
        for (other, per_field) in &removals {
            strip_link_ids(tx, other, per_field)?;
        }
        for (id, _, _) in &batch {
            tx.execute("DELETE FROM record_history WHERE record_id = ?1", [id])?;
            stats.records += tx.execute("DELETE FROM records WHERE id = ?1", [id])?;
        }
    }
}

/// Remove `gone` ids from the link arrays `per_field` of record `record_id`.
fn strip_link_ids(
    tx: &Transaction,
    record_id: &str,
    per_field: &HashMap<String, HashSet<String>>,
) -> AppResult<()> {
    let data: Option<String> = tx
        .query_row("SELECT data FROM records WHERE id = ?1", [record_id], |r| {
            r.get(0)
        })
        .optional()?;
    let Some(data) = data else { return Ok(()) };
    let Ok(mut obj) = serde_json::from_str::<Map<String, Json>>(&data) else {
        return Ok(());
    };
    let mut changed = false;
    for (field_id, gone) in per_field {
        let Some(Json::Array(items)) = obj.get_mut(field_id) else {
            continue;
        };
        let before = items.len();
        items.retain(|v| v.as_str().is_none_or(|s| !gone.contains(s)));
        if items.len() != before {
            changed = true;
            if items.is_empty() {
                obj.remove(field_id);
            }
        }
    }
    if changed {
        tx.execute(
            "UPDATE records SET data = ?2 WHERE id = ?1",
            params![record_id, serde_json::to_string(&obj)?],
        )?;
    }
    Ok(())
}

fn purge_views(tx: &Transaction, cutoff_ms: i64, stats: &mut PurgeStats) -> AppResult<()> {
    // A link field's record picker may point at a view that is going away.
    tx.execute(
        "UPDATE fields SET options = json_remove(options, '$.picker_view_id')
         WHERE type = 'link'
           AND json_extract(options, '$.picker_view_id') IN
               (SELECT id FROM views WHERE deleted_at IS NOT NULL AND deleted_at < ?1)",
        [cutoff_ms],
    )?;
    stats.views += tx.execute(
        "DELETE FROM views WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        [cutoff_ms],
    )?;
    Ok(())
}

fn purge_fields(tx: &Transaction, cutoff_ms: i64, stats: &mut PurgeStats) -> AppResult<()> {
    let doomed: Vec<(String, String)> = {
        let mut stmt = tx.prepare(
            "SELECT id, table_id FROM fields WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        )?;
        stmt.query_map([cutoff_ms], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?
    };
    for (field_id, table_id) in doomed {
        let path = format!("$.\"{field_id}\"");
        tx.execute(
            "UPDATE records SET data = json_remove(data, ?2)
             WHERE table_id = ?1 AND json_type(data, ?2) IS NOT NULL",
            params![table_id, path],
        )?;
        stats.fields += tx.execute("DELETE FROM fields WHERE id = ?1", [&field_id])?;
    }
    Ok(())
}
