//! How the create_record / update_record actions write records.
//!
//! The actions only know the [`RecordWriter`] trait. The real implementation
//! is the record write engine (validation, computed-field recompute, link
//! inverses, history, SSE), which another workstream builds; until it is
//! wired in, [`SqlRecordWriter`] writes `records.data` directly. It is
//! **not** a replacement for the engine:
//!
//! * values are normalized with `og_core::cell::normalize` (typecast on), so
//!   bad values are rejected, but select choices that do not exist are not
//!   created and attachment values are taken as given;
//! * computed fields (formula, lookup, rollup, count) are not recomputed;
//! * link fields are stored on this side only (no inverse maintenance);
//! * no record history rows are written.
//!
//! INTEGRATOR: implement [`RecordWriter`] over `crate::engine::write` and
//! return it from [`super::default_record_writer`]. The implementation must
//! tell the automation hook the write came from an automation
//! (`RecordChanges { by_automation: true, .. }`), which is what stops
//! automations from triggering each other.

use std::collections::BTreeMap;

use chrono::Utc;
use chrono_tz::Tz;
use og_core::cell::{CellCtx, normalize};
use og_core::field::Field;
use og_core::limits;
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Map, Value as Json};

use super::{RecordChanges, on_records_changed};
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::schema;

/// Who is writing and on whose behalf.
#[derive(Debug, Clone, Copy)]
pub struct WriteCtx<'a> {
    pub base_id: &'a str,
    /// The automation's creator: recorded as the record's creator/editor.
    pub user_id: Option<&'a str>,
    pub automation_id: &'a str,
}

/// Writes records for automation actions, inside the caller's transaction.
///
/// `values` is keyed by **field id** and holds client-style JSON that the
/// implementation must validate leniently (Airtable `typecast`: `"1,200"`
/// for a number, a choice name for a select, ...). Implementations must
/// reject computed fields and unknown fields with a `BadRequest` error.
pub trait RecordWriter: Send + Sync {
    /// Create a record in `table_id`; returns its id.
    fn create(
        &self,
        tx: &Transaction,
        table_id: &str,
        values: &BTreeMap<String, Json>,
        ctx: &WriteCtx,
    ) -> AppResult<String>;

    /// Update the given fields of an existing record (the caller has checked
    /// it exists, is live, and belongs to the automation's base).
    fn update(
        &self,
        tx: &Transaction,
        record_id: &str,
        values: &BTreeMap<String, Json>,
        ctx: &WriteCtx,
    ) -> AppResult<()>;
}

/// Minimal direct-SQL writer; see the module docs for what it leaves out.
#[derive(Debug, Default, Clone, Copy)]
pub struct SqlRecordWriter;

fn cell_ctx() -> CellCtx {
    CellCtx::new(Utc::now(), Tz::UTC).with_typecast(true)
}

/// Normalize `values` against `fields`: `Some` entries are written, `None`
/// entries clear the cell.
fn normalize_values(
    fields: &[Field],
    values: &BTreeMap<String, Json>,
) -> AppResult<Vec<(String, Option<Json>)>> {
    let ctx = cell_ctx();
    values
        .iter()
        .map(|(id, raw)| {
            let field = fields
                .iter()
                .find(|f| &f.id == id)
                .ok_or_else(|| AppError::bad_request(format!("unknown field {id}")))?;
            let v = normalize(field, raw, &ctx)
                .map_err(|e| AppError::bad_request(format!("field \"{}\": {e}", field.name)))?;
            Ok((id.clone(), v))
        })
        .collect()
}

impl RecordWriter for SqlRecordWriter {
    fn create(
        &self,
        tx: &Transaction,
        table_id: &str,
        values: &BTreeMap<String, Json>,
        ctx: &WriteCtx,
    ) -> AppResult<String> {
        let table = schema::live_table(tx, table_id)?;
        let fields = schema::table_fields(tx, table_id)?;
        let live: i64 = tx.query_row(
            "SELECT count(*) FROM records WHERE table_id = ?1 AND deleted_at IS NULL",
            [table_id],
            |r| r.get(0),
        )?;
        if live as usize >= limits::MAX_RECORDS_PER_TABLE {
            return Err(AppError::bad_request(format!(
                "the table is full ({} records)",
                limits::MAX_RECORDS_PER_TABLE
            )));
        }
        let mut data = Map::new();
        for (id, v) in normalize_values(&fields, values)? {
            if let Some(v) = v {
                data.insert(id, v);
            }
        }
        let position: f64 = tx.query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM records WHERE table_id = ?1",
            [table_id],
            |r| r.get(0),
        )?;
        let id = new_id(og_core::ids::RECORD);
        let now = now_ms();
        tx.execute(
            "INSERT INTO records (id, table_id, data, position, autonumber, created_at, created_by, updated_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?7)",
            params![
                id,
                table_id,
                Json::Object(data).to_string(),
                position,
                table.next_autonumber,
                now,
                ctx.user_id
            ],
        )?;
        tx.execute(
            "UPDATE tables SET next_autonumber = next_autonumber + 1 WHERE id = ?1",
            [table_id],
        )?;
        on_records_changed(
            tx,
            &RecordChanges {
                base_id: ctx.base_id,
                table_id,
                created: std::slice::from_ref(&id),
                user_id: ctx.user_id,
                by_automation: true,
                ..Default::default()
            },
        )?;
        Ok(id)
    }

    fn update(
        &self,
        tx: &Transaction,
        record_id: &str,
        values: &BTreeMap<String, Json>,
        ctx: &WriteCtx,
    ) -> AppResult<()> {
        let (table_id, raw): (String, String) = tx
            .query_row(
                "SELECT table_id, data FROM records WHERE id = ?1 AND deleted_at IS NULL",
                [record_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::not_found("record"))?;
        let fields = schema::table_fields(tx, &table_id)?;
        let mut data: Map<String, Json> = match serde_json::from_str(&raw) {
            Ok(Json::Object(m)) => m,
            _ => Map::new(),
        };
        let before = data.clone();
        let mut changed = Vec::new();
        for (id, v) in normalize_values(&fields, values)? {
            let old = data.get(&id).cloned();
            match v {
                Some(v) => {
                    data.insert(id.clone(), v);
                }
                None => {
                    data.remove(&id);
                }
            }
            if old.as_ref() != data.get(&id) {
                changed.push(id);
            }
        }
        if changed.is_empty() {
            return Ok(());
        }
        tx.execute(
            "UPDATE records SET data = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1",
            params![
                record_id,
                Json::Object(data).to_string(),
                now_ms(),
                ctx.user_id
            ],
        )?;
        let updated = [(record_id.to_string(), changed)];
        let before = [(record_id.to_string(), before)];
        on_records_changed(
            tx,
            &RecordChanges {
                base_id: ctx.base_id,
                table_id: &table_id,
                updated: &updated,
                before: &before,
                user_id: ctx.user_id,
                by_automation: true,
                ..Default::default()
            },
        )?;
        Ok(())
    }
}
