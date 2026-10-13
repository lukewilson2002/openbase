//! Record rows: SQL access, ordering positions, system-field synthesis and
//! the client-facing record DTO.
//!
//! **What lives where.** `records.data` holds, keyed by field id, the
//! canonical value of every non-empty *editable* field and the materialized
//! value of every *computed* field (formula, lookup, rollup, count, button;
//! see `engine::recompute`). The *system* fields (created/last-modified
//! time/by, autonumber) are never stored in `data`: they come from the
//! record's columns and are synthesized by [`system_cell`] whenever a row is
//! turned into values. [`full_values`] and [`to_dtos`] are the shared read
//! path: they add the system fields, hide values of deleted fields and hide
//! trashed records from link arrays.
//!
//! Soft-deleted ("trashed") records keep their own link arrays and stay in
//! the arrays of the records that link to them, so restoring is trivial;
//! every read path must filter them out, which [`full_values`] does.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, SecondsFormat, Utc};
use og_core::api::records::{LinkRef, Record};
use og_core::field::{Field, FieldKind};
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde_json::{Map, Value as Json};

use crate::error::{AppError, AppResult};
use crate::store::history;
use crate::store::links::{NameCache, link_ids};

/// Ids per `IN (...)` query.
const IN_CHUNK: usize = 400;

/// A row of the `records` table with `data` parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordRow {
    pub id: String,
    pub table_id: String,
    pub data: Map<String, Json>,
    pub position: f64,
    pub autonumber: i64,
    pub created_at: i64,
    pub created_by: Option<String>,
    pub updated_at: i64,
    pub updated_by: Option<String>,
    pub deleted_at: Option<i64>,
}

pub const COLS: &str = "id, table_id, data, position, autonumber, created_at, created_by, \
                        updated_at, updated_by, deleted_at";

impl RecordRow {
    pub fn from_sql(r: &Row) -> rusqlite::Result<RecordRow> {
        let id: String = r.get(0)?;
        let raw: String = r.get(2)?;
        let data = match serde_json::from_str::<Json>(&raw) {
            Ok(Json::Object(o)) => o,
            _ => {
                tracing::warn!(record = %id, "record data is not a JSON object; reading it as empty");
                Map::new()
            }
        };
        Ok(RecordRow {
            id,
            table_id: r.get(1)?,
            data,
            position: r.get(3)?,
            autonumber: r.get(4)?,
            created_at: r.get(5)?,
            created_by: r.get(6)?,
            updated_at: r.get(7)?,
            updated_by: r.get(8)?,
            deleted_at: r.get(9)?,
        })
    }

    pub fn is_live(&self) -> bool {
        self.deleted_at.is_none()
    }
}

// ------------------------------------------------------------------- reads

/// A record in any state (live or trashed).
pub fn get(conn: &Connection, id: &str) -> AppResult<Option<RecordRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM records WHERE id = ?1"),
            [id],
            RecordRow::from_sql,
        )
        .optional()?)
}

/// Records by id, in any state and in no particular order; unknown ids are skipped.
pub fn get_many(conn: &Connection, ids: &[String]) -> AppResult<Vec<RecordRow>> {
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(IN_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut stmt =
            conn.prepare_cached(&format!("SELECT {COLS} FROM records WHERE id IN ({marks})"))?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), RecordRow::from_sql)?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

/// Ids of the records of a table in manual order, optionally with trashed ones.
pub fn table_ids(
    conn: &Connection,
    table_id: &str,
    include_trashed: bool,
) -> AppResult<Vec<String>> {
    let sql = if include_trashed {
        "SELECT id FROM records WHERE table_id = ?1 ORDER BY id"
    } else {
        "SELECT id FROM records WHERE table_id = ?1 AND deleted_at IS NULL ORDER BY position, id"
    };
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map([table_id], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Number of live records in a table.
pub fn live_count(conn: &Connection, table_id: &str) -> AppResult<usize> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM records WHERE table_id = ?1 AND deleted_at IS NULL",
        [table_id],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// Which of `ids` are live records of `table_id`.
pub fn live_ids_in_table(
    conn: &Connection,
    table_id: &str,
    ids: &[String],
) -> AppResult<HashSet<String>> {
    let mut out = HashSet::with_capacity(ids.len());
    for chunk in ids.chunks(IN_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        let mut stmt = conn.prepare_cached(&format!(
            "SELECT id FROM records WHERE table_id = ? AND deleted_at IS NULL AND id IN ({marks})"
        ))?;
        let params = std::iter::once(table_id).chain(chunk.iter().map(String::as_str));
        let rows = stmt.query_map(params_from_iter(params), |r| r.get::<_, String>(0))?;
        for id in rows {
            out.insert(id?);
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ writes

pub fn insert(conn: &Connection, row: &RecordRow) -> AppResult<()> {
    conn.prepare_cached(
        "INSERT INTO records (id, table_id, data, position, autonumber, created_at, created_by,
                              updated_at, updated_by, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?
    .execute(params![
        row.id,
        row.table_id,
        serde_json::to_string(&row.data)?,
        row.position,
        row.autonumber,
        row.created_at,
        row.created_by,
        row.updated_at,
        row.updated_by,
        row.deleted_at
    ])?;
    Ok(())
}

/// Replace a record's data without touching `updated_at` (computed values).
pub fn save_data(conn: &Connection, id: &str, data: &Map<String, Json>) -> AppResult<()> {
    conn.prepare_cached("UPDATE records SET data = ?2 WHERE id = ?1")?
        .execute(params![id, serde_json::to_string(data)?])?;
    Ok(())
}

/// Replace a record's data and stamp the edit.
pub fn save_edit(
    conn: &Connection,
    id: &str,
    data: &Map<String, Json>,
    at_ms: i64,
    user_id: Option<&str>,
) -> AppResult<()> {
    conn.prepare_cached(
        "UPDATE records SET data = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1",
    )?
    .execute(params![id, serde_json::to_string(data)?, at_ms, user_id])?;
    Ok(())
}

pub fn set_deleted_at(conn: &Connection, id: &str, at: Option<i64>) -> AppResult<()> {
    conn.prepare_cached("UPDATE records SET deleted_at = ?2 WHERE id = ?1")?
        .execute(params![id, at])?;
    Ok(())
}

pub fn set_position(conn: &Connection, id: &str, position: f64) -> AppResult<()> {
    conn.prepare_cached("UPDATE records SET position = ?2 WHERE id = ?1")?
        .execute(params![id, position])?;
    Ok(())
}

/// Reserve `n` autonumbers for a table; returns the first.
pub fn reserve_autonumbers(conn: &Connection, table_id: &str, n: usize) -> AppResult<i64> {
    let first: i64 = conn.query_row(
        "SELECT next_autonumber FROM tables WHERE id = ?1",
        [table_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE tables SET next_autonumber = ?2 WHERE id = ?1",
        params![table_id, first + n as i64],
    )?;
    Ok(first)
}

// --------------------------------------------------------------- positions

/// Smallest gap between two neighbours before positions are renumbered.
const MIN_GAP: f64 = 1e-6;

/// Position for a record appended after the last live one.
pub fn append_position(conn: &Connection, table_id: &str) -> AppResult<f64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM records
         WHERE table_id = ?1 AND deleted_at IS NULL",
        [table_id],
        |r| r.get(0),
    )?)
}

/// Rewrite every record's position (live and trashed) as 1, 2, 3, ... keeping
/// the current order. Used when repeated insertion between two records has
/// exhausted the precision of the positions.
pub fn renumber(conn: &Connection, table_id: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE records SET position = r.rn
         FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position, created_at, id) AS rn
               FROM records WHERE table_id = ?1) AS r
         WHERE records.id = r.id",
        [table_id],
    )?;
    Ok(())
}

/// Where to put records relative to an anchor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place<'a> {
    End,
    After(&'a str),
    Before(&'a str),
}

/// `n` increasing positions for records placed at `place`, ignoring the
/// records in `exclude` (the ones being moved). Renumbers the table first if
/// the gap is too small to split.
pub fn positions_for(
    conn: &Connection,
    table_id: &str,
    place: Place,
    n: usize,
    exclude: &HashSet<String>,
) -> AppResult<Vec<f64>> {
    if n == 0 {
        return Ok(Vec::new());
    }
    for attempt in 0..2 {
        match try_positions(conn, table_id, place, n, exclude)? {
            Some(p) => return Ok(p),
            None if attempt == 0 => renumber(conn, table_id)?,
            None => break,
        }
    }
    Err(AppError::internal("could not allocate record positions"))
}

fn anchor_position(conn: &Connection, table_id: &str, anchor: &str) -> AppResult<f64> {
    conn.query_row(
        "SELECT position FROM records WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL",
        params![anchor, table_id],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| AppError::bad_request(format!("record {anchor} was not found in this table")))
}

fn try_positions(
    conn: &Connection,
    table_id: &str,
    place: Place,
    n: usize,
    exclude: &HashSet<String>,
) -> AppResult<Option<Vec<f64>>> {
    let (lo, hi): (Option<f64>, Option<f64>) = match place {
        Place::End => {
            let last: f64 = conn.query_row(
                "SELECT COALESCE(MAX(position), 0) FROM records
                 WHERE table_id = ?1 AND deleted_at IS NULL",
                [table_id],
                |r| r.get(0),
            )?;
            (Some(last), None)
        }
        Place::After(anchor) => {
            let lo = anchor_position(conn, table_id, anchor)?;
            let mut stmt = conn.prepare_cached(
                "SELECT id, position FROM records
                 WHERE table_id = ?1 AND deleted_at IS NULL AND position > ?2
                 ORDER BY position LIMIT ?3",
            )?;
            let next = stmt
                .query_map(params![table_id, lo, exclude.len() as i64 + 1], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .find(|(id, _)| !exclude.contains(id))
                .map(|(_, p)| p);
            (Some(lo), next)
        }
        Place::Before(anchor) => {
            let hi = anchor_position(conn, table_id, anchor)?;
            let mut stmt = conn.prepare_cached(
                "SELECT id, position FROM records
                 WHERE table_id = ?1 AND deleted_at IS NULL AND position < ?2
                 ORDER BY position DESC LIMIT ?3",
            )?;
            let prev = stmt
                .query_map(params![table_id, hi, exclude.len() as i64 + 1], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .find(|(id, _)| !exclude.contains(id))
                .map(|(_, p)| p);
            (prev, Some(hi))
        }
    };
    let count = n as f64;
    Ok(match (lo, hi) {
        (Some(lo), Some(hi)) => {
            let step = (hi - lo) / (count + 1.0);
            if step.is_nan() || step < MIN_GAP {
                return Ok(None);
            }
            Some((1..=n).map(|i| lo + step * i as f64).collect())
        }
        (Some(lo), None) => Some((1..=n).map(|i| lo + i as f64).collect()),
        (None, Some(hi)) => Some((0..n).map(|i| hi - (n - i) as f64).collect()),
        (None, None) => Some((1..=n).map(|i| i as f64).collect()),
    })
}

// ------------------------------------------------------------ system fields

/// Whether the field's value comes from record columns instead of `data`.
pub fn is_system(field: &Field) -> bool {
    matches!(
        field.kind,
        FieldKind::Autonumber(_)
            | FieldKind::CreatedTime(_)
            | FieldKind::LastModifiedTime(_)
            | FieldKind::CreatedBy(_)
            | FieldKind::LastModifiedBy(_)
    )
}

pub fn instant_json(ms: i64) -> Option<Json> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|dt| Json::String(dt.to_rfc3339_opts(SecondsFormat::Millis, true)))
}

/// The stored-form JSON of a system field for `row`.
///
/// A last-modified field that watches specific fields reports the latest
/// history entry touching them (falling back to the creation time when none
/// is left, e.g. after history retention purged it); without watched fields
/// it is the record's `updated_at`/`updated_by`.
pub fn system_cell(conn: &Connection, field: &Field, row: &RecordRow) -> Option<Json> {
    match &field.kind {
        FieldKind::Autonumber(_) => Some(Json::from(row.autonumber)),
        FieldKind::CreatedTime(_) => instant_json(row.created_at),
        FieldKind::CreatedBy(_) => row.created_by.clone().map(Json::String),
        FieldKind::LastModifiedTime(o) => {
            if o.fields.is_empty() {
                instant_json(row.updated_at)
            } else {
                let at = history::last_modified(conn, &row.id, &o.fields)
                    .ok()
                    .flatten()
                    .map_or(row.created_at, |(at, _)| at);
                instant_json(at)
            }
        }
        FieldKind::LastModifiedBy(o) => {
            if o.fields.is_empty() {
                row.updated_by.clone().map(Json::String)
            } else {
                match history::last_modified(conn, &row.id, &o.fields) {
                    Ok(Some((_, user))) => user.map(Json::String),
                    _ => row.created_by.clone().map(Json::String),
                }
            }
        }
        _ => None,
    }
}

/// The stored-form value of one cell: system fields synthesized, everything
/// else from `data`. Link arrays are returned as stored (trashed ids included).
pub fn cell(conn: &Connection, field: &Field, row: &RecordRow) -> Option<Json> {
    if is_system(field) {
        system_cell(conn, field, row)
    } else {
        row.data.get(&field.id).filter(|v| !v.is_null()).cloned()
    }
}

/// Every non-empty value of a record keyed by field id, for the live fields
/// in `fields` only (values of deleted fields stay hidden): system fields
/// synthesized, link arrays restricted to live linked records. Values are in
/// stored form (computed errors are `{"error": ...}`).
pub fn full_values(
    conn: &Connection,
    fields: &[Field],
    row: &RecordRow,
    names: &NameCache,
) -> Map<String, Json> {
    let mut out = Map::new();
    for f in fields {
        let Some(v) = cell(conn, f, row) else {
            continue;
        };
        let v = if matches!(f.kind, FieldKind::Link(_)) {
            let live = names.live_ids(&v);
            if live.is_empty() {
                continue;
            }
            Json::Array(live.into_iter().map(Json::String).collect())
        } else {
            v
        };
        out.insert(f.id.clone(), v);
    }
    out
}

/// Records as sent to clients: [`full_values`] with link arrays rendered as
/// `[{"id","name"}]` (name = the linked record's primary field text).
pub fn to_dtos(
    conn: &Connection,
    fields: &[Field],
    rows: &[RecordRow],
    names: &NameCache,
) -> Vec<Record> {
    let link_fields: HashSet<&str> = fields
        .iter()
        .filter(|f| matches!(f.kind, FieldKind::Link(_)))
        .map(|f| f.id.as_str())
        .collect();
    let linked: Vec<String> = rows
        .iter()
        .flat_map(|r| link_fields.iter().flat_map(|f| link_ids(&r.data, f)))
        .collect();
    names.preload(linked.iter().map(String::as_str));
    rows.iter()
        .map(|row| {
            let mut values: BTreeMap<String, Json> = BTreeMap::new();
            for (k, v) in full_values(conn, fields, row, names) {
                let v = if link_fields.contains(k.as_str()) {
                    let refs: Vec<Json> = v
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Json::as_str)
                        .map(|id| {
                            serde_json::to_value(LinkRef {
                                id: id.to_string(),
                                name: names.record_text(id).unwrap_or_default(),
                            })
                            .unwrap_or(Json::Null)
                        })
                        .collect();
                    Json::Array(refs)
                } else {
                    v
                };
                values.insert(k, v);
            }
            Record {
                id: row.id.clone(),
                table_id: row.table_id.clone(),
                created_at: row.created_at,
                updated_at: row.updated_at,
                created_by: row.created_by.clone(),
                updated_by: row.updated_by.clone(),
                autonumber: row.autonumber,
                values,
            }
        })
        .collect()
}

/// The live records of `table_id` among `ids`, as DTOs in the order of
/// `ids` (unknown, foreign or trashed ids are skipped).
pub fn load_dtos(
    conn: &Connection,
    table_id: &str,
    ids: &[String],
    tz: chrono_tz::Tz,
) -> AppResult<Vec<Record>> {
    let fields = crate::store::schema::table_fields(conn, table_id)?;
    let mut rows: HashMap<String, RecordRow> = get_many(conn, ids)?
        .into_iter()
        .filter(|r| r.table_id == table_id && r.deleted_at.is_none())
        .map(|r| (r.id.clone(), r))
        .collect();
    let ordered: Vec<RecordRow> = ids.iter().filter_map(|i| rows.remove(i)).collect();
    let names = NameCache::new(conn, tz);
    Ok(to_dtos(conn, &fields, &ordered, &names))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn conn_with_records() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'w', 1);
             INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('b', 'w', 'b', 1);
             INSERT INTO tables (id, base_id, name, primary_field_id, created_at)
                 VALUES ('t', 'b', 't', 'f', 1);",
        )
        .unwrap();
        conn
    }

    fn add(conn: &Connection, id: &str, position: f64, deleted: Option<i64>) {
        conn.execute(
            "INSERT INTO records (id, table_id, position, autonumber, created_at, updated_at, deleted_at)
             VALUES (?1, 't', ?2, 1, 1, 1, ?3)",
            params![id, position, deleted],
        )
        .unwrap();
    }

    fn pos(conn: &Connection, id: &str) -> f64 {
        conn.query_row("SELECT position FROM records WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn positions_end_after_before() {
        let conn = conn_with_records();
        add(&conn, "a", 1.0, None);
        add(&conn, "b", 2.0, None);
        add(&conn, "gone", 3.0, Some(5));
        let none = HashSet::new();
        // End: after the last live record, trashed ones ignored.
        assert_eq!(
            positions_for(&conn, "t", Place::End, 2, &none).unwrap(),
            vec![3.0, 4.0]
        );
        // After a: between a and b.
        let p = positions_for(&conn, "t", Place::After("a"), 2, &none).unwrap();
        assert!(p[0] > 1.0 && p[1] < 2.0 && p[0] < p[1]);
        // After the last record: whole steps.
        assert_eq!(
            positions_for(&conn, "t", Place::After("b"), 1, &none).unwrap(),
            vec![3.0]
        );
        // Before the first record.
        assert_eq!(
            positions_for(&conn, "t", Place::Before("a"), 2, &none).unwrap(),
            vec![-1.0, 0.0]
        );
        // Before b.
        let p = positions_for(&conn, "t", Place::Before("b"), 1, &none).unwrap();
        assert!(p[0] > 1.0 && p[0] < 2.0);
        // Unknown or trashed anchors are rejected.
        assert!(positions_for(&conn, "t", Place::After("nope"), 1, &none).is_err());
        assert!(positions_for(&conn, "t", Place::After("gone"), 1, &none).is_err());
    }

    #[test]
    fn excluded_records_do_not_count_as_neighbours() {
        let conn = conn_with_records();
        add(&conn, "a", 1.0, None);
        add(&conn, "b", 2.0, None);
        add(&conn, "c", 3.0, None);
        let moving: HashSet<String> = ["b".to_string()].into();
        // Moving b after a: the next neighbour is c, not b itself.
        let p = positions_for(&conn, "t", Place::After("a"), 1, &moving).unwrap();
        assert!(p[0] > 1.0 && p[0] < 3.0);
    }

    #[test]
    fn exhausted_gaps_renumber_the_table() {
        let conn = conn_with_records();
        add(&conn, "a", 1.0, None);
        add(&conn, "b", 1.0 + 1e-9, None);
        add(&conn, "t1", 9.0, Some(1));
        let p = positions_for(&conn, "t", Place::After("a"), 1, &HashSet::new()).unwrap();
        // Renumbered to 1, 2 (+ trashed 3): the new record sits between a and b.
        assert_eq!(pos(&conn, "a"), 1.0);
        assert_eq!(pos(&conn, "b"), 2.0);
        assert!(p[0] > 1.0 && p[0] < 2.0);
        assert_eq!(pos(&conn, "t1"), 3.0);
    }
}
