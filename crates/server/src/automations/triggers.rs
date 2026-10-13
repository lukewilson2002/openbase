//! Turning events into queued runs.
//!
//! Everything here only inserts `automation_runs` rows (see [`super::store`]);
//! nothing performs I/O, so it is safe to call inside the caller's write
//! transaction.
//!
//! Each run stores a [`TriggerData`] snapshot of what fired it. For record
//! triggers that includes the record's values *at the time of the event*, so a
//! run that executes later (or is retried) still sees what the trigger saw.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use ob_core::api::automations::Trigger;
use ob_core::cell::NoNames;
use ob_core::field::Field;
use ob_core::query::{CompiledFilter, OwnedRow, QueryCtx, compile_filter, matches};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

use super::RecordChanges;
use super::store::{self, AutomationRow};
use crate::db::now_ms;
use crate::error::AppResult;
use crate::store::schema;

/// The record that fired a trigger, as it was when the event happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerRecord {
    pub id: String,
    pub table_id: String,
    /// Stored cell JSON keyed by field id (computed fields included).
    pub fields: Map<String, Json>,
}

/// What fired a run (stored as the run's `trigger_data`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TriggerData {
    /// `record_created`, `record_updated`, `record_matches`,
    /// `form_submitted`, `schedule` or `webhook`.
    #[serde(rename = "type")]
    pub kind: String,
    /// When the event happened (unix ms); for schedules, the scheduled time.
    pub time: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<TriggerRecord>,
    /// Editable fields that changed (record_updated / record_matches).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changed_field_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
    /// Webhook JSON body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Json>,
    /// Set on runs started from the test endpoint.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub test: bool,
}

impl TriggerData {
    pub fn new(kind: &str, time: i64) -> TriggerData {
        TriggerData {
            kind: kind.to_string(),
            time,
            user_id: None,
            record: None,
            changed_field_ids: Vec::new(),
            view_id: None,
            body: None,
            test: false,
        }
    }

    pub fn to_json(&self) -> Json {
        serde_json::to_value(self).unwrap_or(Json::Null)
    }
}

/// Queue runs for record triggers. Returns how many runs were queued.
pub fn enqueue_record_changes(tx: &Transaction, changes: &RecordChanges) -> AppResult<usize> {
    let automations = store::enabled_for_base(tx, changes.base_id)?;
    let relevant: Vec<&AutomationRow> = automations
        .iter()
        .filter(|a| match &a.trigger {
            Trigger::RecordCreated { table_id }
            | Trigger::RecordUpdated { table_id, .. }
            | Trigger::RecordMatches { table_id, .. } => table_id == changes.table_id,
            Trigger::FormSubmitted { view_id } => changes.form_view_id == Some(view_id.as_str()),
            Trigger::Schedule { .. } | Trigger::Webhook {} => false,
        })
        .collect();
    if relevant.is_empty() {
        return Ok(0);
    }
    let now = now_ms();
    let needs_filters = relevant
        .iter()
        .any(|a| matches!(a.trigger, Trigger::RecordMatches { .. }));
    let fields: Vec<Field> = if needs_filters {
        schema::table_fields(tx, changes.table_id)?
    } else {
        Vec::new()
    };
    let mut filters: HashMap<&str, Option<Matcher>> = HashMap::new();
    if needs_filters {
        for a in &relevant {
            if let Trigger::RecordMatches { filter, .. } = &a.trigger {
                let matcher = match compile_filter(filter, &fields) {
                    Ok(compiled) => Some(Matcher {
                        compiled,
                        ctx: query_ctx(tx, a, changes.user_id, now),
                    }),
                    Err(e) => {
                        tracing::warn!(automation = %a.id, error = %e, "record_matches filter no longer valid; trigger ignored");
                        None
                    }
                };
                filters.insert(a.id.as_str(), matcher);
            }
        }
    }

    let mut queued = 0;
    let enqueue =
        |tx: &Transaction, a: &AutomationRow, mut data: TriggerData| -> AppResult<usize> {
            data.user_id = changes.user_id.map(str::to_string);
            Ok(usize::from(
                store::enqueue_run(tx, &a.id, &data.to_json())?.is_some(),
            ))
        };

    for id in changes.created {
        let Some(record) = load_record(tx, changes.table_id, id)? else {
            continue;
        };
        for a in &relevant {
            let kind = match &a.trigger {
                Trigger::RecordCreated { .. } => "record_created",
                Trigger::FormSubmitted { .. } => "form_submitted",
                Trigger::RecordMatches { .. } => {
                    let hit = filters
                        .get(a.id.as_str())
                        .and_then(Option::as_ref)
                        .is_some_and(|m| m.matches(&record));
                    if !hit {
                        continue;
                    }
                    "record_matches"
                }
                _ => continue,
            };
            let mut data = TriggerData::new(kind, now);
            data.record = Some(snapshot(&record, changes.table_id));
            if let Trigger::FormSubmitted { view_id } = &a.trigger {
                data.view_id = Some(view_id.clone());
            }
            queued += enqueue(tx, a, data)?;
        }
    }

    for (id, changed) in changes.updated {
        if changed.is_empty() {
            continue;
        }
        let Some(record) = load_record(tx, changes.table_id, id)? else {
            continue;
        };
        for a in &relevant {
            let kind = match &a.trigger {
                Trigger::RecordUpdated { field_ids, .. } => {
                    if !field_ids.is_empty() && !changed.iter().any(|c| field_ids.contains(c)) {
                        continue;
                    }
                    "record_updated"
                }
                Trigger::RecordMatches { .. } => {
                    let Some(m) = filters.get(a.id.as_str()).and_then(Option::as_ref) else {
                        continue;
                    };
                    if !m.matches(&record) {
                        continue;
                    }
                    let was_matching = match changes.before.iter().find(|(rid, _)| rid == id) {
                        Some((_, old)) => m.matches(&OwnedRow {
                            id: id.clone(),
                            data: old.clone(),
                        }),
                        // No "before" supplied: assume it was matching unless
                        // the update touched a field the filter reads.
                        None => {
                            let read = m.compiled.field_ids();
                            !changed.iter().any(|c| read.contains(c))
                        }
                    };
                    if was_matching {
                        continue;
                    }
                    "record_matches"
                }
                _ => continue,
            };
            let mut data = TriggerData::new(kind, now);
            data.record = Some(snapshot(&record, changes.table_id));
            data.changed_field_ids = changed.clone();
            queued += enqueue(tx, a, data)?;
        }
    }
    Ok(queued)
}

/// Queue a run for an incoming webhook call. None when the queue is full.
pub fn enqueue_webhook(
    tx: &Transaction,
    automation_id: &str,
    body: Option<Json>,
) -> AppResult<Option<i64>> {
    let mut data = TriggerData::new("webhook", now_ms());
    data.body = body;
    let id = store::enqueue_run_capped(
        tx,
        automation_id,
        &data.to_json(),
        store::MAX_QUEUED_WEBHOOK_RUNS,
    )?;
    if id.is_some() {
        super::runner::wake();
    }
    Ok(id)
}

/// Queue a run for a due schedule (`scheduled_for` is the due time).
pub fn enqueue_schedule(
    tx: &Transaction,
    automation_id: &str,
    scheduled_for: i64,
) -> AppResult<Option<i64>> {
    let data = TriggerData::new("schedule", scheduled_for);
    store::enqueue_run(tx, automation_id, &data.to_json())
}

struct Matcher {
    compiled: CompiledFilter,
    ctx: QueryCtx,
}

impl Matcher {
    fn matches(&self, row: &OwnedRow) -> bool {
        matches(&self.compiled, row, &self.ctx, &NoNames)
    }
}

/// Filter context: "today" in the automation owner's time zone, "me" the
/// user who made the change.
fn query_ctx(conn: &Connection, a: &AutomationRow, actor: Option<&str>, now: i64) -> QueryCtx {
    let tz = a
        .created_by
        .as_deref()
        .and_then(|u| {
            conn.query_row("SELECT timezone FROM users WHERE id = ?1", [u], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()
            .ok()
            .flatten()
            .flatten()
        })
        .and_then(|name| name.parse::<Tz>().ok())
        .unwrap_or(Tz::UTC);
    let at = DateTime::<Utc>::from_timestamp_millis(now).unwrap_or_else(Utc::now);
    let ctx = QueryCtx::new(at, tz);
    match actor {
        Some(u) => ctx.with_user(u),
        None => ctx,
    }
}

fn load_record(tx: &Connection, table_id: &str, id: &str) -> AppResult<Option<OwnedRow>> {
    let data: Option<String> = tx
        .query_row(
            "SELECT data FROM records WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL",
            [id, table_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(data.map(|d| OwnedRow {
        id: id.to_string(),
        data: match serde_json::from_str(&d) {
            Ok(Json::Object(m)) => m,
            _ => Map::new(),
        },
    }))
}

fn snapshot(row: &OwnedRow, table_id: &str) -> TriggerRecord {
    TriggerRecord {
        id: row.id.clone(),
        table_id: table_id.to_string(),
        fields: row.data.clone(),
    }
}
