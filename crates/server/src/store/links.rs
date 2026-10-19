//! Link cells: id-array helpers, referential checks and the name/liveness
//! cache every read path and the recompute engine use.
//!
//! A link field and its inverse both store arrays of record ids; the write
//! engine keeps them consistent inside one transaction (`engine::write`).
//! Trashed records stay in the arrays (so restoring is trivial) but must
//! never be shown or counted, so everything that reads link values goes
//! through [`NameCache::live_ids`].

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use chrono_tz::Tz;
use ob_core::cell::{NameResolver, display_text};
use ob_core::field::Field;
use rusqlite::{Connection, params_from_iter};
use serde_json::{Map, Value as Json};

use crate::error::{AppError, AppResult};
use crate::store::records::{self, RecordRow};
use crate::store::schema;

/// Entries after which the cache is dropped to bound memory on huge recomputes.
const MAX_ENTRIES: usize = 300_000;
const IN_CHUNK: usize = 400;

/// The record ids in a link cell of `data` (empty when absent or malformed).
pub fn link_ids(data: &Map<String, Json>, field_id: &str) -> Vec<String> {
    data.get(field_id).map(ids_of).unwrap_or_default()
}

/// The strings of a JSON array (or a lone string).
pub fn ids_of(v: &Json) -> Vec<String> {
    match v {
        Json::Array(a) => a
            .iter()
            .filter_map(Json::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        Json::String(s) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

pub fn ids_json(ids: &[String]) -> Json {
    Json::Array(ids.iter().cloned().map(Json::String).collect())
}

/// `(added, removed)` going from `old` to `new`, both in their own order.
pub fn diff(old: &[String], new: &[String]) -> (Vec<String>, Vec<String>) {
    let old_set: HashSet<&String> = old.iter().collect();
    let new_set: HashSet<&String> = new.iter().collect();
    let added = new
        .iter()
        .filter(|i| !old_set.contains(i))
        .cloned()
        .collect();
    let removed = old
        .iter()
        .filter(|i| !new_set.contains(i))
        .cloned()
        .collect();
    (added, removed)
}

/// Remove duplicates keeping the first occurrence.
pub fn dedupe(ids: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|i| seen.insert(i.clone())).collect()
}

/// Every id must be a live record of `linked_table_id`.
pub fn require_live_targets(
    conn: &Connection,
    field: &Field,
    linked_table_id: &str,
    ids: &[String],
) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let live = records::live_ids_in_table(conn, linked_table_id, ids)?;
    if let Some(bad) = ids.iter().find(|i| !live.contains(*i)) {
        return Err(AppError::bad_request(format!(
            "field \"{}\": record {bad} does not exist in the linked table (or is in the trash)",
            field.name
        )));
    }
    Ok(())
}

#[derive(Default)]
struct Inner {
    /// record id -> primary text when the record is live, None when it is
    /// trashed, its table is trashed, or it does not exist.
    records: HashMap<String, Option<String>>,
    /// record id -> (primary text, in the trash) for [`NameCache::record_info`]; None when the
    /// record or its table does not exist.
    info: HashMap<String, Option<(String, bool)>>,
    users: HashMap<String, Option<String>>,
    /// primary field id -> definition (None when gone).
    fields: HashMap<String, Option<Field>>,
}

/// Names and liveness of linked records and users, cached for the duration of
/// one request or transaction. Call [`NameCache::invalidate`] whenever a
/// record's primary value or trash state changes inside the transaction.
pub struct NameCache<'a> {
    conn: &'a Connection,
    tz: Tz,
    inner: RefCell<Inner>,
}

impl<'a> NameCache<'a> {
    pub fn new(conn: &'a Connection, tz: Tz) -> Self {
        NameCache {
            conn,
            tz,
            inner: RefCell::new(Inner::default()),
        }
    }

    pub fn timezone(&self) -> Tz {
        self.tz
    }

    pub fn invalidate(&self, record_id: &str) {
        let mut inner = self.inner.borrow_mut();
        inner.records.remove(record_id);
        inner.info.remove(record_id);
    }

    pub fn invalidate_all(&self) {
        *self.inner.borrow_mut() = Inner::default();
    }

    /// Load the given records into the cache with one query per chunk.
    pub fn preload<'i>(&self, ids: impl IntoIterator<Item = &'i str>) {
        let missing: Vec<String> = {
            let inner = self.inner.borrow();
            let mut seen = HashSet::new();
            ids.into_iter()
                .filter(|i| !inner.records.contains_key(*i) && seen.insert(*i))
                .map(str::to_string)
                .collect()
        };
        if missing.is_empty() {
            return;
        }
        if self.inner.borrow().records.len() > MAX_ENTRIES {
            self.invalidate_all();
        }
        for chunk in missing.chunks(IN_CHUNK) {
            if let Err(e) = self.load_chunk(chunk) {
                tracing::warn!(error = %e, "could not load linked record names");
                let mut inner = self.inner.borrow_mut();
                for id in chunk {
                    inner.records.entry(id.clone()).or_insert(None);
                }
            }
        }
    }

    /// The rows of `ids` with their table's primary field id and trash stamp.
    fn fetch_rows(&self, ids: &[String]) -> AppResult<Vec<(RecordRow, String, Option<i64>)>> {
        let marks = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT r.id, r.table_id, r.data, r.position, r.autonumber, r.created_at, r.created_by,
                    r.updated_at, r.updated_by, r.deleted_at, t.primary_field_id, t.deleted_at
             FROM records r JOIN tables t ON t.id = r.table_id WHERE r.id IN ({marks})"
        );
        let mut stmt = self.conn.prepare_cached(&sql)?;
        let rows = stmt
            .query_map(params_from_iter(ids.iter()), |r| {
                Ok((RecordRow::from_sql(r)?, r.get(10)?, r.get(11)?))
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }

    fn load_chunk(&self, ids: &[String]) -> AppResult<()> {
        let rows = self.fetch_rows(ids)?;
        let mut found: HashSet<&str> = HashSet::new();
        for (row, primary_id, table_deleted) in &rows {
            found.insert(row.id.as_str());
            let name = if row.deleted_at.is_some() || table_deleted.is_some() {
                None
            } else {
                Some(self.primary_text(row, primary_id))
            };
            self.inner.borrow_mut().records.insert(row.id.clone(), name);
        }
        let mut inner = self.inner.borrow_mut();
        for id in ids {
            if !found.contains(id.as_str()) {
                inner.records.insert(id.clone(), None);
            }
        }
        Ok(())
    }

    /// Load the given records for [`NameCache::record_info`] with one query per chunk.
    pub fn preload_info<'i>(&self, ids: impl IntoIterator<Item = &'i str>) {
        let missing: Vec<String> = {
            let inner = self.inner.borrow();
            let mut seen = HashSet::new();
            ids.into_iter()
                .filter(|i| !inner.info.contains_key(*i) && seen.insert(*i))
                .map(str::to_string)
                .collect()
        };
        for chunk in missing.chunks(IN_CHUNK) {
            let rows = self.fetch_rows(chunk).unwrap_or_else(|e| {
                tracing::warn!(error = %e, "could not load record names");
                Vec::new()
            });
            let mut found: HashSet<&str> = HashSet::new();
            for (row, primary_id, _) in &rows {
                found.insert(row.id.as_str());
                let info = (self.primary_text(row, primary_id), row.deleted_at.is_some());
                self.inner
                    .borrow_mut()
                    .info
                    .insert(row.id.clone(), Some(info));
            }
            let mut inner = self.inner.borrow_mut();
            for id in chunk {
                if !found.contains(id.as_str()) {
                    inner.info.insert(id.clone(), None);
                }
            }
        }
    }

    /// Primary text of a record and whether it is in the trash, trashed records included
    /// (unlike [`NameCache::record_text`]); None when the record does not exist.
    pub fn record_info(&self, id: &str) -> Option<(String, bool)> {
        self.preload_info(std::iter::once(id));
        self.inner.borrow().info.get(id).cloned().flatten()
    }

    fn primary_field(&self, field_id: &str) -> Option<Field> {
        if let Some(f) = self.inner.borrow().fields.get(field_id) {
            return f.clone();
        }
        let f = schema::field_any(self.conn, field_id)
            .ok()
            .flatten()
            .filter(|r| r.deleted_at.is_none())
            .map(|r| r.field);
        self.inner
            .borrow_mut()
            .fields
            .insert(field_id.to_string(), f.clone());
        f
    }

    fn primary_text(&self, row: &RecordRow, primary_id: &str) -> String {
        let Some(field) = self.primary_field(primary_id) else {
            return String::new();
        };
        let stored = records::cell(self.conn, &field, row);
        display_text(&field, stored.as_ref(), self, self.tz)
    }

    /// Primary text of a live record; None when it is trashed or missing.
    pub fn record_text(&self, id: &str) -> Option<String> {
        self.preload(std::iter::once(id));
        self.inner.borrow().records.get(id).cloned().flatten()
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.record_text(id).is_some()
    }

    /// The live record ids of a stored link cell, in stored order.
    pub fn live_ids(&self, stored: &Json) -> Vec<String> {
        let ids = ids_of(stored);
        self.preload(ids.iter().map(String::as_str));
        let inner = self.inner.borrow();
        ids.into_iter()
            .filter(|i| inner.records.get(i).is_some_and(Option::is_some))
            .collect()
    }

    /// Display name of a user (None when unknown).
    pub fn user_text(&self, id: &str) -> Option<String> {
        if let Some(n) = self.inner.borrow().users.get(id) {
            return n.clone();
        }
        let name: Option<String> = self
            .conn
            .query_row("SELECT name FROM users WHERE id = ?1", [id], |r| r.get(0))
            .ok();
        self.inner
            .borrow_mut()
            .users
            .insert(id.to_string(), name.clone());
        name
    }
}

impl NameResolver for NameCache<'_> {
    fn record_name(&self, id: &str) -> Option<String> {
        self.record_text(id)
    }
    fn user_name(&self, id: &str) -> Option<String> {
        self.user_text(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn diff_keeps_each_sides_order() {
        let (added, removed) = diff(&s(&["a", "b", "c"]), &s(&["c", "d", "a", "e"]));
        assert_eq!(added, s(&["d", "e"]));
        assert_eq!(removed, s(&["b"]));
    }

    #[test]
    fn dedupe_keeps_first() {
        assert_eq!(dedupe(s(&["a", "b", "a", "c", "b"])), s(&["a", "b", "c"]));
    }

    #[test]
    fn ids_of_ignores_non_strings() {
        assert_eq!(ids_of(&json!(["a", 3, null, "", "b"])), s(&["a", "b"]));
        assert_eq!(ids_of(&json!("x")), s(&["x"]));
        assert!(ids_of(&json!({"a": 1})).is_empty());
    }
}
