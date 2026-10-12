//! Trash: listing, restoring and permanently purging soft-deleted items.
//!
//! Deleting a workspace, base, table, field, view or record only stamps
//! `deleted_at`; the data stays until [`purge_expired`] removes it after the
//! retention period. Cascades stamp the same value on everything trashed in
//! one operation so restoring the root brings back exactly those items.

use std::collections::{HashMap, HashSet};

use og_core::api::records::{TrashItem, TrashListing};
use og_core::field::FieldKind;
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Map, Value as Json};

use crate::auth::Actor;
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::store::schema::{self, Touched};
use crate::store::{fields, workspaces};

/// Most trashed records shown in one listing (newest first).
const MAX_TRASHED_RECORDS_LISTED: i64 = 1000;
/// Rows handled per batch while purging records.
const PURGE_BATCH: i64 = 1000;

// ----------------------------------------------------------------- listing

fn primary_text(v: SqlValue) -> String {
    match v {
        SqlValue::Text(s) => s,
        SqlValue::Integer(i) => i.to_string(),
        SqlValue::Real(f) => f.to_string(),
        _ => String::new(),
    }
}

/// Everything in the trash of a base, newest first: tables, fields, views
/// (only shared ones and the caller's own personal ones) and records.
pub fn list_base(conn: &Connection, base_id: &str, user_id: &str) -> AppResult<TrashListing> {
    let mut items: Vec<TrashItem> = Vec::new();

    let mut stmt = conn.prepare(
        "SELECT id, name, deleted_at FROM tables WHERE base_id = ?1 AND deleted_at IS NOT NULL",
    )?;
    for row in stmt.query_map([base_id], |r| {
        Ok(TrashItem {
            kind: "table".into(),
            id: r.get(0)?,
            name: r.get(1)?,
            table_id: None,
            deleted_at: r.get(2)?,
        })
    })? {
        items.push(row?);
    }

    items.extend(trashed_fields(conn, base_id)?);

    let mut stmt = conn.prepare(
        "SELECT v.id, v.name, v.table_id, v.deleted_at FROM views v
         JOIN tables t ON t.id = v.table_id
         WHERE t.base_id = ?1 AND t.deleted_at IS NULL AND v.deleted_at IS NOT NULL
           AND (v.personal_owner_id IS NULL OR v.personal_owner_id = ?2)",
    )?;
    for row in stmt.query_map(params![base_id, user_id], |r| {
        Ok(TrashItem {
            kind: "view".into(),
            id: r.get(0)?,
            name: r.get(1)?,
            table_id: Some(r.get(2)?),
            deleted_at: r.get(3)?,
        })
    })? {
        items.push(row?);
    }

    let mut stmt = conn.prepare(
        "SELECT r.id, r.table_id, r.deleted_at,
                json_extract(r.data, '$.\"' || t.primary_field_id || '\"')
         FROM records r JOIN tables t ON t.id = r.table_id
         WHERE t.base_id = ?1 AND t.deleted_at IS NULL AND r.deleted_at IS NOT NULL
         ORDER BY r.deleted_at DESC, r.id LIMIT ?2",
    )?;
    for row in stmt.query_map(params![base_id, MAX_TRASHED_RECORDS_LISTED], |r| {
        Ok(TrashItem {
            kind: "record".into(),
            id: r.get(0)?,
            name: primary_text(r.get::<_, SqlValue>(3)?),
            table_id: Some(r.get(1)?),
            deleted_at: r.get(2)?,
        })
    })? {
        items.push(row?);
    }

    items.sort_by(|a, b| {
        b.deleted_at
            .cmp(&a.deleted_at)
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(TrashListing { items })
}

/// Trashed fields of live tables. A link pair trashed together is listed once.
fn trashed_fields(conn: &Connection, base_id: &str) -> AppResult<Vec<TrashItem>> {
    let all = schema::base_field_records_all(conn, base_id)?;
    let stamps: HashMap<&str, Option<i64>> = all
        .iter()
        .map(|r| (r.field.id.as_str(), r.deleted_at))
        .collect();
    let by_id: HashMap<&str, &schema::FieldRecord> =
        all.iter().map(|r| (r.field.id.as_str(), r)).collect();
    let live_tables: HashSet<String> = schema::live_tables(conn, base_id)?
        .into_iter()
        .map(|t| t.id)
        .collect();
    let mut out = Vec::new();
    for r in &all {
        let Some(at) = r.deleted_at else { continue };
        if !live_tables.contains(&r.field.table_id) {
            continue;
        }
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
        out.push(TrashItem {
            kind: "field".into(),
            id: r.field.id.clone(),
            name: r.field.name.clone(),
            table_id: Some(r.field.table_id.clone()),
            deleted_at: at,
        });
    }
    Ok(out)
}

/// Trashed bases of a workspace, newest first.
pub fn list_workspace(conn: &Connection, workspace_id: &str) -> AppResult<TrashListing> {
    let mut stmt = conn.prepare(
        "SELECT id, name, deleted_at FROM bases
         WHERE workspace_id = ?1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id",
    )?;
    let items = stmt
        .query_map([workspace_id], |r| {
            Ok(TrashItem {
                kind: "base".into(),
                id: r.get(0)?,
                name: r.get(1)?,
                table_id: None,
                deleted_at: r.get(2)?,
            })
        })?
        .collect::<Result<_, _>>()?;
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

/// Role of the user on a base even while the base is in the trash.
fn base_role_any(conn: &Connection, user_id: &str, base_id: &str) -> AppResult<Option<Role>> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT (SELECT role FROM workspace_members WHERE workspace_id = b.workspace_id AND user_id = ?2),
                    (SELECT role FROM base_members WHERE base_id = b.id AND user_id = ?2)
             FROM bases b WHERE b.id = ?1",
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

/// Resolve `{kind, id}` to a [`Target`] and check the actor may restore it:
/// Owner for workspaces and bases (session only), Creator for items inside a
/// base, the owner for their own personal views.
pub fn authorize(conn: &Connection, actor: &Actor, kind: &str, id: &str) -> AppResult<Target> {
    match kind {
        "workspace" => {
            if actor.token_scope.is_some() {
                return Err(AppError::forbidden("API tokens cannot manage workspaces"));
            }
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
            if actor.token_scope.is_some() {
                return Err(AppError::forbidden("API tokens cannot restore bases"));
            }
            lookup_text(conn, "SELECT id FROM bases WHERE id = ?1", id, "base")?;
            match base_role_any(conn, &actor.user_id, id)? {
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
}

fn not_in_trash() -> AppError {
    AppError::conflict("this item is not in the trash")
}

/// Restore an authorized target.
pub fn restore(tx: &Transaction, target: &Target) -> AppResult<Restored> {
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
        Target::Record(id) => restore_record(tx, id),
    }
}

fn restore_workspace(tx: &Transaction, id: &str) -> AppResult<Restored> {
    let n = tx.execute(
        "UPDATE workspaces SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL",
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
    tx.execute("UPDATE bases SET deleted_at = NULL WHERE id = ?1", [id])?;
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
    if live.len() >= og_core::limits::MAX_TABLES_PER_BASE {
        return Err(AppError::bad_request(format!(
            "a base can have at most {} tables",
            og_core::limits::MAX_TABLES_PER_BASE
        )));
    }
    let taken = schema::name_keys(live.iter().map(String::as_str));
    let name = if taken.contains(&schema::name_key(&table.name)) {
        let head: String = table
            .name
            .chars()
            .take(og_core::limits::MAX_NAME_LEN - 16)
            .collect();
        schema::uniquify(&taken, &format!("{head} (restored)"))
    } else {
        table.name.clone()
    };
    tx.execute(
        "UPDATE tables SET deleted_at = NULL, name = ?2 WHERE id = ?1",
        params![id, name],
    )?;
    let mut touched = Touched::of(id);
    for t in fields::restore_incoming_links(tx, &table, stamp)?.0 {
        touched.add(&t);
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
    tx.execute("UPDATE views SET deleted_at = NULL WHERE id = ?1", [id])?;
    Ok(Restored {
        base_ids: vec![table.base_id],
        schema: Some(Touched::of(&table.id)),
        ..Restored::default()
    })
}

fn restore_record(tx: &Transaction, id: &str) -> AppResult<Restored> {
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
    tx.execute("UPDATE records SET deleted_at = NULL WHERE id = ?1", [id])?;
    Ok(Restored {
        base_ids: vec![table.base_id],
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
