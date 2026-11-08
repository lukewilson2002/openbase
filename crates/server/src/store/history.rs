//! Per-record change log (`record_history`): one row per create, update,
//! delete and restore, listing the old and new JSON of every *editable* field
//! that changed. Computed values are derived, so they are never logged.
//! Retention is enforced by the `tasks` module (`history_days`).

use std::collections::{BTreeMap, HashSet};

use ob_core::api::records::{FieldChange, HistoryEntry};
use ob_core::field::FieldKind;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde_json::{Map, Value as Json};

use crate::error::AppResult;
use crate::store::links::NameCache;
use crate::store::schema;

pub const CREATE: &str = "create";
pub const UPDATE: &str = "update";
pub const DELETE: &str = "delete";
pub const RESTORE: &str = "restore";

/// Append a history row. `changes` is `{field_id: {"old": ..., "new": ...}}`.
pub fn record(
    conn: &Connection,
    record_id: &str,
    table_id: &str,
    user_id: Option<&str>,
    kind: &str,
    changes: &Map<String, Json>,
    at_ms: i64,
) -> AppResult<()> {
    conn.prepare_cached(
        "INSERT INTO record_history (record_id, table_id, user_id, kind, changes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?
    .execute(params![
        record_id,
        table_id,
        user_id,
        kind,
        serde_json::to_string(changes)?,
        at_ms
    ])?;
    Ok(())
}

/// How long a text edit keeps folding into the latest history row (BE-6).
pub const COALESCE_WINDOW_MS: i64 = 10 * 60 * 1000;

/// Log an update. With `coalesce`, an edit of one text cell by the person
/// who made the record's latest history row is folded into that row when the
/// row is an update of the same single field and under [`COALESCE_WINDOW_MS`]
/// old: the row keeps its first `old`, takes the new `new` and moves to
/// `at_ms`. Page text autosaves every few seconds and each row holds the whole
/// text twice, so one row per save would drown the real history. Anything
/// else (another field, another person, a stale row, a row whose `new` is
/// not the value this edit started from) adds a row as usual.
///
/// The row keeps its id, so a reader paging by id (record history) sees no
/// gap; feeds sort by time, where the row simply becomes the newest. When the
/// fold puts the cell back to the row's first `old` (typing, then undo) there is
/// no change left to show, and the row is removed.
pub fn record_update(
    conn: &Connection,
    record_id: &str,
    table_id: &str,
    user_id: Option<&str>,
    changes: &Map<String, Json>,
    at_ms: i64,
    coalesce: bool,
) -> AppResult<()> {
    if coalesce
        && let Some(user) = user_id
        && changes.len() == 1
        && let Some((field_id, incoming)) = changes.iter().next()
        && let Some(row) = conn
            .prepare_cached(
                "SELECT id, user_id, kind, changes, created_at FROM record_history
                 WHERE record_id = ?1 ORDER BY id DESC LIMIT 1",
            )?
            .query_row([record_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })
            .optional()?
    {
        let (id, row_user, kind, raw, row_at) = row;
        let age = at_ms - row_at;
        if kind == UPDATE
            && row_user.as_deref() == Some(user)
            && (0..COALESCE_WINDOW_MS).contains(&age)
            && let Ok(Json::Object(mut stored)) = serde_json::from_str::<Json>(&raw)
            && stored.len() == 1
            && let Some(prev) = stored.get_mut(field_id)
            // The edit must continue from where the row left off; a cell that
            // changed some other way in between starts a new row.
            && prev.get("new") == incoming.get("old")
        {
            prev["new"] = incoming.get("new").cloned().unwrap_or(Json::Null);
            // An undo inside the window puts the cell back to where the row started. A row
            // claiming "changed from X to X" would be the newest thing in the history, the
            // activity feed and Home, and would bump a last-modified time for no change; the
            // edit and its undo cancel out, so the row goes.
            if prev.get("old") == prev.get("new") {
                conn.prepare_cached("DELETE FROM record_history WHERE id = ?1")?
                    .execute([id])?;
                return Ok(());
            }
            conn.prepare_cached(
                "UPDATE record_history SET changes = ?1, created_at = ?2 WHERE id = ?3",
            )?
            .execute(params![serde_json::to_string(&stored)?, at_ms, id])?;
            return Ok(());
        }
    }
    record(conn, record_id, table_id, user_id, UPDATE, changes, at_ms)
}

/// One change entry in the stored shape.
pub fn change(old: Option<&Json>, new: Option<&Json>) -> Json {
    serde_json::json!({
        "old": old.cloned().unwrap_or(Json::Null),
        "new": new.cloned().unwrap_or(Json::Null),
    })
}

/// A record's history, newest first.
pub fn list(conn: &Connection, record_id: &str, limit: usize) -> AppResult<Vec<HistoryEntry>> {
    list_page(conn, record_id, None, limit)
}

/// A page of a record's history, newest first: entries with an id below
/// `before` (the id of the last entry of the previous page), at most `limit`.
pub fn list_page(
    conn: &Connection,
    record_id: &str,
    before: Option<i64>,
    limit: usize,
) -> AppResult<Vec<HistoryEntry>> {
    let mut stmt = conn.prepare(
        "SELECT h.id, h.user_id, u.name, h.kind, h.changes, h.created_at
         FROM record_history h LEFT JOIN users u ON u.id = h.user_id
         WHERE h.record_id = ?1 AND h.id < ?2 ORDER BY h.id DESC LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(
            params![record_id, before.unwrap_or(i64::MAX), limit as i64],
            |r| {
                let raw: String = r.get(4)?;
                let changes: BTreeMap<String, FieldChange> =
                    serde_json::from_str(&raw).unwrap_or_default();
                Ok(HistoryEntry {
                    id: r.get(0)?,
                    user_id: r.get(1)?,
                    user_name: r.get(2)?,
                    kind: r.get(3)?,
                    changes,
                    created_at: r.get(5)?,
                })
            },
        )?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Turn the link-field values of history entries into `[{id, name}]`.
///
/// History stores link cells as arrays of record ids. When it is read, the
/// ids of every link field of the record's table are given the primary text
/// the linked record has *now*; a linked record that is in the trash or gone
/// (and ids whose field was deleted or changed type) keeps its id as the
/// name. Values already in the `{id, name}` shape are left alone.
pub fn resolve_link_names(
    conn: &Connection,
    record_id: &str,
    entries: &mut [HistoryEntry],
    tz: chrono_tz::Tz,
) -> AppResult<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let table_id: Option<String> = conn
        .query_row(
            "SELECT table_id FROM records WHERE id = ?1",
            [record_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(table_id) = table_id else {
        return Ok(());
    };
    let link_fields = link_field_ids(conn, &table_id)?;
    if link_fields.is_empty() {
        return Ok(());
    }
    let names = NameCache::new(conn, tz);
    for entry in entries.iter_mut() {
        link_refs(&mut entry.changes, &link_fields, &names);
    }
    Ok(())
}

/// The ids of the link fields of a table.
pub fn link_field_ids(conn: &Connection, table_id: &str) -> AppResult<HashSet<String>> {
    Ok(schema::table_fields(conn, table_id)?
        .into_iter()
        .filter(|f| matches!(f.kind, FieldKind::Link(_)))
        .map(|f| f.id)
        .collect())
}

/// Turn the ids in the values of `link_fields` among `changes` into `[{id, name}]` (see
/// [`resolve_link_names`]).
pub fn link_refs(
    changes: &mut BTreeMap<String, FieldChange>,
    link_fields: &HashSet<String>,
    names: &NameCache,
) {
    let to_refs = |v: &mut Json| {
        let Json::Array(items) = v else { return };
        for item in items.iter_mut() {
            if let Json::String(id) = item {
                let name = names.record_text(id).unwrap_or_else(|| id.clone());
                *item = serde_json::json!({ "id": id, "name": name });
            }
        }
    };
    for (field_id, change) in changes.iter_mut() {
        if link_fields.contains(field_id) {
            to_refs(&mut change.old);
            to_refs(&mut change.new);
        }
    }
}

/// When (and by whom) the latest create/update touching any of `field_ids`
/// happened, from the history. `None` when history holds no such entry.
pub fn last_modified(
    conn: &Connection,
    record_id: &str,
    field_ids: &[String],
) -> AppResult<Option<(i64, Option<String>)>> {
    if field_ids.is_empty() {
        return Ok(None);
    }
    let marks = vec!["?"; field_ids.len()].join(",");
    let sql = format!(
        "SELECT h.created_at, h.user_id FROM record_history h
         WHERE h.record_id = ? AND h.kind IN ('create', 'update')
           AND EXISTS (SELECT 1 FROM json_each(h.changes) j WHERE j.key IN ({marks}))
         ORDER BY h.id DESC LIMIT 1"
    );
    let mut stmt = conn.prepare_cached(&sql)?;
    let params = std::iter::once(record_id).chain(field_ids.iter().map(String::as_str));
    let mut rows = stmt.query(params_from_iter(params))?;
    Ok(match rows.next()? {
        Some(r) => Some((r.get(0)?, r.get(1)?)),
        None => None,
    })
}
