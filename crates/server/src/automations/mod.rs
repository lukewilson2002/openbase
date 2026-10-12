//! Automations: triggers, actions, durable run queue. Workstream W8.
//!
//! The record write path (workstream W6) calls [`on_records_changed`] inside
//! its write transaction; implementations must only enqueue work (insert
//! automation_runs rows), never perform I/O, so writes stay fast and atomic.

use rusqlite::Transaction;

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
}

/// Enqueue runs for automations whose triggers match. Called by the record
/// write path after the records are written (computed fields included).
pub fn on_records_changed(_tx: &Transaction, _changes: &RecordChanges) -> AppResult<()> {
    Ok(())
}
