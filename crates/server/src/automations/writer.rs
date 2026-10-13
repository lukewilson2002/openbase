//! How the create_record / update_record actions write records.
//!
//! Automation actions write through the record write engine
//! ([`crate::engine::write`]) with [`WriteSource::Automation`], so they have
//! exactly the effects of an API write: typecast (including new select
//! choices), link-inverse maintenance, computed-field recompute, record
//! history, "assigned" notifications and the per-base limits.
//!
//! The functions run inside the caller's write transaction and return the
//! [`WriteOutcome`]. **After the transaction commits** the caller publishes
//! `outcome.events()` on the event bus (that is what updates SSE clients and
//! invalidates the view query cache); [`publish`] does that.
//!
//! Loops: the engine calls [`super::on_records_changed`] with
//! `by_automation: true` for these writes, and record triggers ignore such
//! changes, so no automation can start another (or itself) by changing
//! records.

use std::collections::BTreeMap;

use ob_core::api::records::{NewRecord, RecordPatch};
use rusqlite::Transaction;
use serde_json::Value as Json;

use crate::engine::write::{self, CreateOpts, WriteCtx, WriteOutcome, WriteSource};
use crate::error::{AppError, AppResult};
use crate::events::EventBus;

/// Who is writing and on whose behalf.
#[derive(Debug, Clone, Copy)]
pub struct AutomationCtx<'a> {
    /// The automation's creator: recorded as the record's creator/editor and
    /// whose timezone interprets date input. `None` when the user is gone.
    pub user_id: Option<&'a str>,
}

fn write_ctx(tx: &Transaction, ctx: &AutomationCtx) -> AppResult<WriteCtx> {
    let wctx = match ctx.user_id {
        Some(user) => WriteCtx::for_user(tx, user, WriteSource::Automation)?,
        None => WriteCtx::new(None, WriteSource::Automation),
    };
    // Airtable-style typecast: "12" for a number, a choice name for a select.
    Ok(wctx.typecast(true))
}

/// Create a record in `table_id`. `values` is keyed by **field id** and holds
/// client-style JSON. Returns the outcome; the new id is
/// `outcome.target().created[0]`.
pub fn create_record(
    tx: &Transaction,
    ctx: &AutomationCtx,
    table_id: &str,
    values: &BTreeMap<String, Json>,
) -> AppResult<WriteOutcome> {
    let wctx = write_ctx(tx, ctx)?;
    write::create_records(
        tx,
        &wctx,
        table_id,
        vec![NewRecord {
            values: values.clone(),
        }],
        &CreateOpts::default(),
    )
}

/// Update the given fields of a record (JSON null clears a field).
pub fn update_record(
    tx: &Transaction,
    ctx: &AutomationCtx,
    table_id: &str,
    record_id: &str,
    values: &BTreeMap<String, Json>,
) -> AppResult<WriteOutcome> {
    let wctx = write_ctx(tx, ctx)?;
    write::update_records(
        tx,
        &wctx,
        table_id,
        vec![RecordPatch {
            id: record_id.to_string(),
            values: values.clone(),
        }],
    )
}

/// The id of the record [`create_record`] made.
pub fn created_id(outcome: &WriteOutcome) -> AppResult<String> {
    outcome
        .target()
        .created
        .first()
        .cloned()
        .ok_or_else(|| AppError::internal("the write engine created no record"))
}

/// Publish a committed write: SSE clients get the events and the per-base
/// data version is bumped (which invalidates cached view queries).
pub fn publish(events: &EventBus, user_id: Option<&str>, outcome: &WriteOutcome) {
    for event in outcome.events() {
        events.publish(&outcome.base_id, None, user_id.map(str::to_string), event);
    }
}
