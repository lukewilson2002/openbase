//! Automations: triggers, actions, durable run queue. Workstream W8.
//!
//! # How it fits together
//!
//! * **Definitions** live in the `automations` table ([`store`]): a trigger
//!   and an ordered list of actions as JSON (the DTOs in
//!   `og_core::api::automations`), validated on save by [`validate`].
//! * **Triggers only enqueue.** The record write path calls
//!   [`on_records_changed`] inside its write transaction; the incoming-webhook
//!   endpoint, the form path and the schedule scanner call the same enqueue
//!   helpers. They insert `automation_runs` rows (status `queued`, with a
//!   snapshot of what fired) and do no I/O, so writes stay fast and atomic: a
//!   rolled-back write queues nothing.
//! * **The [`runner`]** (started from `tasks::spawn_all`) claims queued runs,
//!   executes their actions one after another *outside* the database lock
//!   ([`actions`]; each database write is its own `Db::write`), keeps a step
//!   log, retries transient failures and recovers runs a crash left running.
//! * **Loops are impossible.** Records an automation creates or updates are
//!   written with `by_automation` set, and [`on_records_changed`] ignores
//!   such changes entirely, so no automation can trigger another (or itself)
//!   through record changes.
//!
//! # Writes made by actions
//!
//! The create_record / update_record actions write through the record write
//! engine ([`writer`]) with `WriteSource::Automation`, so they behave exactly
//! like API writes (typecast, links, recompute, history) and the engine calls
//! [`on_records_changed`] with `by_automation: true`. After each action's
//! transaction commits the executor publishes the write's events.

pub mod actions;
pub mod download;
pub mod http;
pub mod runner;
pub mod schedule;
pub mod ssrf;
pub mod store;
pub mod template;
pub mod triggers;
pub mod validate;
pub mod writer;

use rusqlite::Transaction;
use serde_json::{Map, Value as Json};

use crate::error::AppResult;

/// What happened to records in one write transaction.
#[derive(Debug, Clone, Default)]
pub struct RecordChanges<'a> {
    pub base_id: &'a str,
    pub table_id: &'a str,
    /// Newly created record ids.
    pub created: &'a [String],
    /// Updated record ids with the editable field ids whose values changed.
    pub updated: &'a [(String, Vec<String>)],
    /// Set when the records were created by a public form submission (view id).
    pub form_view_id: Option<&'a str>,
    pub user_id: Option<&'a str>,
    /// True when an automation action made these changes. Record triggers
    /// ignore such changes (loop prevention).
    pub by_automation: bool,
    /// The full `records.data` of each updated record as it was *before* the
    /// write (record id, data). Optional: it lets `record_matches` see exactly
    /// whether an update turned a record from not matching into matching.
    /// Without it, an update is taken to start matching when the record
    /// matches now and the update changed a field the filter reads.
    pub before: &'a [(String, Map<String, Json>)],
}

/// Enqueue runs for automations whose triggers match. Called by the record
/// write path after the records are written (computed fields included), in
/// the same transaction.
pub fn on_records_changed(tx: &Transaction, changes: &RecordChanges) -> AppResult<()> {
    if changes.by_automation {
        return Ok(());
    }
    if changes.created.is_empty() && changes.updated.is_empty() {
        return Ok(());
    }
    let queued = triggers::enqueue_record_changes(tx, changes)?;
    if queued > 0 {
        runner::wake();
    }
    Ok(())
}
