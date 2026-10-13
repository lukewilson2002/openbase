//! Per-record change log (`record_history`): one row per create, update,
//! delete and restore, listing the old and new JSON of every *editable* field
//! that changed. Computed values are derived, so they are never logged.
//! Retention is enforced by the `tasks` module (`history_days`).

use std::collections::BTreeMap;

use og_core::api::records::{FieldChange, HistoryEntry};
use rusqlite::{Connection, params, params_from_iter};
use serde_json::{Map, Value as Json};

use crate::error::AppResult;

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
