//! Executing the actions of one run.
//!
//! [`Executor::execute`] runs the actions of an automation in order against a
//! [`TriggerData`] snapshot, appending a [`StepLog`] line per action to the
//! run's log. It is used by the background runner (which persists the log
//! after every step so a crash or retry resumes where it stopped) and by the
//! test endpoint (`dry_run` renders and validates everything but sends,
//! writes and requests nothing).
//!
//! Resuming: actions whose log line says `succeeded` or `skipped` are not run
//! again; their outputs are read back from the log so `{{steps.n.*}}`
//! placeholders keep working. An action that failed is run again.
//!
//! Failures are classified: *transient* ones (network errors, timeouts, HTTP
//! 5xx/408/429, SMTP trouble) may be retried by the runner; everything else
//! (validation errors, refused URLs, 4xx responses, missing records) fails
//! the run for good.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use og_core::api::automations::{Action, ActionStep, HttpMethod, StepLog, StepStatus};
use og_core::cell::{CellCtx, CellError, NoNames, normalize};
use og_core::field::Field;
use og_core::query::{OwnedRow, QueryCtx, compile_filter, matches};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value as Json, json};

use super::http::{self, Request};
use super::store::{self, AutomationRow};
use super::template::{Escape, RecordCtx, RenderCtx};
use super::triggers::TriggerData;
use super::validate::{check_recipients, resolve_field, split_recipients};
use super::writer::{self, AutomationCtx};
use crate::error::{AppError, AppResult};
use crate::perm;
use crate::state::AppState;
use crate::store::{notifications, schema};

/// Record id handed to later steps in a dry run, where nothing is created.
pub const DRY_RUN_RECORD_ID: &str = "rec_dry_run";
/// Longest part of an HTTP response body kept in a run log.
const LOGGED_BODY_CHARS: usize = 20_000;
const EMAIL_TIMEOUT: Duration = Duration::from_secs(30);

/// Why an action failed.
#[derive(Debug, Clone)]
pub struct StepError {
    pub message: String,
    /// Worth retrying later.
    pub transient: bool,
    /// Partial output to keep in the log (e.g. the response of a failed request).
    pub output: Option<Json>,
}

impl StepError {
    pub fn permanent(message: impl Into<String>) -> StepError {
        StepError {
            message: message.into(),
            transient: false,
            output: None,
        }
    }

    pub fn transient(message: impl Into<String>) -> StepError {
        StepError {
            message: message.into(),
            transient: true,
            output: None,
        }
    }
}

impl From<AppError> for StepError {
    fn from(e: AppError) -> StepError {
        match e {
            AppError::Internal(detail) => {
                tracing::error!(error = %detail, "internal error in an automation action");
                StepError::permanent("internal error (see the server log)")
            }
            other => StepError::permanent(other.to_string()),
        }
    }
}

impl From<String> for StepError {
    fn from(message: String) -> StepError {
        StepError::permanent(message)
    }
}

/// Outcome of [`Executor::execute`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunResult {
    Succeeded,
    Failed { error: String, transient: bool },
}

/// One execution of an automation.
pub struct RunInput<'a> {
    pub automation: &'a AutomationRow,
    pub trigger: &'a TriggerData,
    /// Persist the log after every step (the runner); None for tests.
    pub run_id: Option<i64>,
    /// 1-based attempt number, stamped on log lines.
    pub attempt: u32,
    pub dry_run: bool,
}

pub struct Executor {
    pub state: AppState,
}

/// What an action that must not repeat needs to record its own success in the
/// run log inside the transaction of its effect: the log so far and the facts
/// of the step's log line.
struct StepCommit<'a> {
    log: &'a [StepLog],
    index: u32,
    started: Instant,
}

/// What the executor loads once per run.
struct Snapshot {
    fields: Vec<Field>,
    data: Map<String, Json>,
    tz: Tz,
}

impl Executor {
    pub fn new(state: AppState) -> Executor {
        Executor { state }
    }

    /// Run all actions that are not already done according to `log`,
    /// appending to it. Stops at the first failure.
    pub async fn execute(&self, input: &RunInput<'_>, log: &mut Vec<StepLog>) -> RunResult {
        let auto = input.automation;
        let trigger = input.trigger;
        let snapshot = match self.load_snapshot(auto, trigger).await {
            Ok(s) => s,
            Err(e) => {
                return RunResult::Failed {
                    error: StepError::from(e).message,
                    transient: false,
                };
            }
        };
        let record_row = trigger.record.as_ref().map(|r| OwnedRow {
            id: r.id.clone(),
            data: r.fields.clone(),
        });

        // Outputs of actions finished in earlier attempts.
        let mut outputs: Vec<Json> = vec![Json::Null; auto.actions.len()];
        for line in log.iter() {
            if let (Some(i), StepStatus::Succeeded) = (line.index, line.status) {
                if let Some(slot) = outputs.get_mut(i as usize) {
                    *slot = line.output.clone().unwrap_or(Json::Null);
                }
            }
        }

        for (i, step) in auto.actions.iter().enumerate() {
            let done = log.iter().any(|l| {
                l.index == Some(i as u32)
                    && matches!(l.status, StepStatus::Succeeded | StepStatus::Skipped)
            });
            if done {
                continue;
            }
            let started = Instant::now();
            let line = |status, output, error: Option<String>| StepLog {
                index: Some(i as u32),
                action: step.action.kind().to_string(),
                status,
                attempt: input.attempt,
                output,
                error,
                duration_ms: started.elapsed().as_millis() as i64,
                retry_at: None,
            };

            // Per-action condition, against the trigger record.
            if let Some(filter) = &step.condition {
                let verdict = match (&record_row, compile_filter(filter, &snapshot.fields)) {
                    (Some(row), Ok(compiled)) => Ok(matches(
                        &compiled,
                        row,
                        &condition_ctx(snapshot.tz, trigger),
                        &NoNames,
                    )),
                    (None, _) => Err("the condition needs a trigger record".to_string()),
                    (_, Err(e)) => Err(format!("the condition is no longer valid: {e}")),
                };
                match verdict {
                    Ok(true) => {}
                    Ok(false) => {
                        log.push(line(StepStatus::Skipped, None, None));
                        self.persist(input, log).await;
                        continue;
                    }
                    Err(msg) => {
                        log.push(line(StepStatus::Failed, None, Some(msg.clone())));
                        self.persist(input, log).await;
                        return RunResult::Failed {
                            error: format!("action {}: {msg}", i + 1),
                            transient: false,
                        };
                    }
                }
            }

            let ctx = RenderCtx {
                trigger_type: &trigger.kind,
                time_ms: trigger.time,
                record: trigger.record.as_ref().map(|r| RecordCtx {
                    id: &r.id,
                    table_id: &r.table_id,
                    fields: &snapshot.fields,
                    data: &snapshot.data,
                }),
                body: trigger.body.as_ref(),
                steps: &outputs,
            };
            let commit = StepCommit {
                log: log.as_slice(),
                index: i as u32,
                started,
            };
            match self.run_action(input, &ctx, step, commit).await {
                Ok(output) => {
                    log.push(line(StepStatus::Succeeded, Some(log_output(&output)), None));
                    outputs[i] = output;
                    self.persist(input, log).await;
                }
                Err(e) => {
                    let out = e.output.as_ref().map(log_output);
                    log.push(line(StepStatus::Failed, out, Some(e.message.clone())));
                    self.persist(input, log).await;
                    return RunResult::Failed {
                        error: format!("action {}: {}", i + 1, e.message),
                        transient: e.transient,
                    };
                }
            }
        }
        RunResult::Succeeded
    }

    async fn persist(&self, input: &RunInput<'_>, log: &[StepLog]) {
        let Some(run_id) = input.run_id else {
            return;
        };
        let log = log.to_vec();
        if let Err(e) = self
            .state
            .db
            .write(move |tx| store::save_log(tx, run_id, &log))
            .await
        {
            tracing::error!(run = run_id, error = %e, "could not save automation run log");
        }
    }

    async fn load_snapshot(
        &self,
        auto: &AutomationRow,
        trigger: &TriggerData,
    ) -> AppResult<Snapshot> {
        let table_id = trigger.record.as_ref().map(|r| r.table_id.clone());
        let owner = auto.created_by.clone();
        let data = trigger
            .record
            .as_ref()
            .map(|r| r.fields.clone())
            .unwrap_or_default();
        self.state
            .db
            .read(move |conn| {
                let fields = match &table_id {
                    Some(t) => schema::table_fields(conn, t)?,
                    None => Vec::new(),
                };
                let tz = owner
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
                    .and_then(|n| n.parse::<Tz>().ok())
                    .unwrap_or(Tz::UTC);
                Ok(Snapshot { fields, data, tz })
            })
            .await
    }

    async fn run_action(
        &self,
        input: &RunInput<'_>,
        ctx: &RenderCtx<'_>,
        step: &ActionStep,
        commit: StepCommit<'_>,
    ) -> Result<Json, StepError> {
        match &step.action {
            Action::CreateRecord { table_id, values } => {
                self.create_record(input, ctx, table_id, values, commit)
                    .await
            }
            Action::UpdateRecord {
                table_id,
                record_id,
                values,
            } => {
                self.update_record(input, ctx, table_id, record_id, values)
                    .await
            }
            Action::SendEmail { to, subject, body } => {
                self.send_email(input, ctx, to, subject, body).await
            }
            Action::HttpRequest {
                method,
                url,
                headers,
                body,
            } => {
                self.http_request(input, ctx, *method, url, headers, body.as_deref())
                    .await
            }
            Action::Notify { user_ids, message } => {
                self.notify(input, ctx, user_ids, message).await
            }
        }
    }

    // ----------------------------------------------------------- records

    async fn create_record(
        &self,
        input: &RunInput<'_>,
        ctx: &RenderCtx<'_>,
        table_id: &str,
        values: &BTreeMap<String, Json>,
        commit: StepCommit<'_>,
    ) -> Result<Json, StepError> {
        let rendered = render_values(ctx, values)?;
        let auto = input.automation.clone();
        let table = table_id.to_string();
        let mut shown = None;
        let record_id = if input.dry_run {
            let prepared = self
                .state
                .db
                .read(move |conn| prepare_values(conn, &auto.base_id, &table, &rendered))
                .await?;
            shown = Some(prepared);
            DRY_RUN_RECORD_ID.to_string()
        } else {
            // The record and the step's "succeeded" log line commit together:
            // a crash between the two (or a failed log write) would otherwise
            // run the step again on resume and create the record twice.
            let (run_id, attempt) = (input.run_id, input.attempt);
            let mut log = commit.log.to_vec();
            let (index, started) = (commit.index, commit.started);
            let outcome = self
                .state
                .db
                .write(move |tx| {
                    let prepared = prepare_values(tx, &auto.base_id, &table, &rendered)?;
                    let ctx = AutomationCtx {
                        user_id: auto.created_by.as_deref(),
                    };
                    let outcome = writer::create_record(tx, &ctx, &table, &prepared)?;
                    if let Some(run_id) = run_id {
                        let output =
                            json!({ "record_id": writer::created_id(&outcome)?, "table_id": table });
                        log.push(StepLog {
                            index: Some(index),
                            action: "create_record".to_string(),
                            status: StepStatus::Succeeded,
                            attempt,
                            output: Some(log_output(&output)),
                            error: None,
                            duration_ms: started.elapsed().as_millis() as i64,
                            retry_at: None,
                        });
                        store::save_log(tx, run_id, &log)?;
                    }
                    Ok(outcome)
                })
                .await?;
            // After the commit: tell SSE clients and invalidate cached queries.
            writer::publish(
                &self.state.events,
                input.automation.created_by.as_deref(),
                &outcome,
            );
            writer::created_id(&outcome)?
        };
        let mut out = json!({ "record_id": record_id, "table_id": table_id });
        if let Some(values) = shown {
            out["dry_run"] = json!(true);
            out["values"] = json!(values);
        }
        Ok(out)
    }

    async fn update_record(
        &self,
        input: &RunInput<'_>,
        ctx: &RenderCtx<'_>,
        table_id: &str,
        record_id: &str,
        values: &BTreeMap<String, Json>,
    ) -> Result<Json, StepError> {
        let record_id = ctx.render_str(record_id, Escape::None)?.trim().to_string();
        if record_id.is_empty() {
            return Err(StepError::permanent(
                "record_id is empty after substitution",
            ));
        }
        let rendered = render_values(ctx, values)?;
        let auto = input.automation.clone();
        let table = table_id.to_string();
        let rid = record_id.clone();
        let dry = input.dry_run;
        let shown = if dry {
            self.state
                .db
                .read(move |conn| {
                    let prepared = prepare_values(conn, &auto.base_id, &table, &rendered)?;
                    if rid != DRY_RUN_RECORD_ID {
                        check_record(conn, &auto.base_id, &table, &rid)?;
                    }
                    Ok(prepared)
                })
                .await?
        } else {
            let (prepared, outcome) = self
                .state
                .db
                .write(move |tx| {
                    let prepared = prepare_values(tx, &auto.base_id, &table, &rendered)?;
                    check_record(tx, &auto.base_id, &table, &rid)?;
                    let ctx = AutomationCtx {
                        user_id: auto.created_by.as_deref(),
                    };
                    let outcome = writer::update_record(tx, &ctx, &table, &rid, &prepared)?;
                    Ok((prepared, outcome))
                })
                .await?;
            writer::publish(
                &self.state.events,
                input.automation.created_by.as_deref(),
                &outcome,
            );
            prepared
        };
        let mut out = json!({ "record_id": record_id, "table_id": table_id });
        if dry {
            out["dry_run"] = json!(true);
            out["values"] = json!(shown);
        }
        Ok(out)
    }

    // ------------------------------------------------------------- email

    async fn send_email(
        &self,
        input: &RunInput<'_>,
        ctx: &RenderCtx<'_>,
        to: &str,
        subject: &str,
        body: &str,
    ) -> Result<Json, StepError> {
        if !self.state.config.email_enabled() {
            return Err(StepError::permanent(
                "email is not configured on this server (set OPENGRID_SMTP_HOST)",
            ));
        }
        let to = ctx.render_str(to, Escape::None)?;
        let recipients = split_recipients(&to);
        if recipients.is_empty() {
            return Err(StepError::permanent(
                "there is no recipient after substitution",
            ));
        }
        check_recipients(&recipients).map_err(StepError::from)?;
        // Header values must be a single line.
        let subject = ctx
            .render_str(subject, Escape::None)?
            .replace(['\r', '\n'], " ")
            .trim()
            .to_string();
        let body = ctx.render_str(body, Escape::None)?;
        if input.dry_run {
            return Ok(json!({
                "dry_run": true, "sent_to": recipients, "subject": subject, "body": body
            }));
        }
        for addr in &recipients {
            match tokio::time::timeout(EMAIL_TIMEOUT, self.state.mailer.send(addr, &subject, &body))
                .await
            {
                Err(_) => return Err(StepError::transient("sending the email timed out")),
                Ok(Err(AppError::BadRequest(m))) => return Err(StepError::permanent(m)),
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "automation email failed");
                    return Err(StepError::transient(
                        "the mail server did not accept the email",
                    ));
                }
                Ok(Ok(())) => {}
            }
        }
        Ok(json!({ "sent_to": recipients }))
    }

    // -------------------------------------------------------------- http

    async fn http_request(
        &self,
        input: &RunInput<'_>,
        ctx: &RenderCtx<'_>,
        method: HttpMethod,
        url: &str,
        headers: &BTreeMap<String, String>,
        body: Option<&str>,
    ) -> Result<Json, StepError> {
        let url = ctx.render_str(url, Escape::Url)?.trim().to_string();
        let mut rendered_headers = Vec::with_capacity(headers.len());
        for (name, value) in headers {
            rendered_headers.push((name.clone(), ctx.render_str(value, Escape::None)?));
        }
        let content_type = rendered_headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case("content-type"))
            .map(|(_, v)| v.to_ascii_lowercase());
        let body = match body.filter(|b| !b.is_empty()) {
            None => None,
            Some(src) => {
                let looks_json = src.trim_start().starts_with(['{', '[']);
                let escape = match content_type.as_deref() {
                    Some(ct) if ct.contains("json") => Escape::Json,
                    Some(ct) if ct.contains("x-www-form-urlencoded") => Escape::Url,
                    Some(_) => Escape::None,
                    None if looks_json => Escape::Json,
                    None => Escape::None,
                };
                if content_type.is_none() {
                    rendered_headers.push((
                        "Content-Type".into(),
                        if looks_json {
                            "application/json"
                        } else {
                            "text/plain; charset=utf-8"
                        }
                        .into(),
                    ));
                }
                Some(ctx.render_str(src, escape)?)
            }
        };
        if let Some(b) = &body {
            if b.len() > http::MAX_REQUEST_BODY_BYTES {
                return Err(StepError::permanent("the request body is too large"));
            }
        }
        let allow_private = self.state.config.allow_private_webhooks;
        if input.dry_run {
            // Still run the guard (name resolution only) so the test shows a refusal.
            super::ssrf::vet(&url, allow_private)
                .await
                .map_err(|e| StepError {
                    message: e.to_string(),
                    transient: e.is_transient(),
                    output: None,
                })?;
            return Ok(json!({
                "dry_run": true,
                "method": method.as_str(),
                "url": url,
                "header_names": rendered_headers.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>(),
                "body": body,
            }));
        }
        let resp = http::send(
            Request {
                method,
                url,
                headers: rendered_headers,
                body,
            },
            allow_private,
        )
        .await
        .map_err(|e| StepError {
            message: e.message,
            transient: e.transient,
            output: None,
        })?;
        let mut out = json!({
            "status": resp.status,
            "body": resp.body,
        });
        if resp.truncated {
            out["truncated"] = json!(true);
        }
        if let Some(j) = resp.json {
            out["json"] = j;
        }
        if resp.status >= 400 {
            return Err(StepError {
                message: format!("the server answered with HTTP status {}", resp.status),
                transient: http::transient_status(resp.status),
                output: Some(out),
            });
        }
        Ok(out)
    }

    // ------------------------------------------------------------ notify

    async fn notify(
        &self,
        input: &RunInput<'_>,
        ctx: &RenderCtx<'_>,
        user_ids: &[String],
        message: &str,
    ) -> Result<Json, StepError> {
        let message = ctx.render_str(message, Escape::None)?;
        let message: String = message
            .chars()
            .take(super::validate::MAX_MESSAGE_LEN)
            .collect();
        let auto = input.automation.clone();
        let users = user_ids.to_vec();
        let record_id = ctx.record.map(|r| r.id.to_string());
        let run_id = input.run_id;
        let dry = input.dry_run;
        let msg = message.clone();
        let (notified, skipped) = self
            .state
            .db
            .write(move |tx| {
                let mut notified = Vec::new();
                let mut skipped = Vec::new();
                for u in &users {
                    let active: bool = tx
                        .query_row("SELECT is_active FROM users WHERE id = ?1", [u], |r| {
                            r.get(0)
                        })
                        .optional()?
                        .unwrap_or(false);
                    if !active || perm::base_role(tx, u, &auto.base_id)?.is_none() {
                        skipped.push(u.clone());
                        continue;
                    }
                    if !dry {
                        notifications::create(
                            tx,
                            u,
                            "automation",
                            &json!({
                                "message": msg,
                                "automation_id": auto.id,
                                "automation_name": auto.name,
                                "base_id": auto.base_id,
                                "record_id": record_id,
                                "run_id": run_id,
                            }),
                        )?;
                    }
                    notified.push(u.clone());
                }
                Ok((notified, skipped))
            })
            .await?;
        let mut out =
            json!({ "notified": notified.len(), "user_ids": notified, "message": message });
        if !skipped.is_empty() {
            out["skipped"] = json!(skipped);
        }
        if dry {
            out["dry_run"] = json!(true);
        }
        Ok(out)
    }
}

// ----------------------------------------------------------------- helpers

fn condition_ctx(tz: Tz, trigger: &TriggerData) -> QueryCtx {
    let now = DateTime::<Utc>::from_timestamp_millis(trigger.time).unwrap_or_else(Utc::now);
    let ctx = QueryCtx::new(now, tz);
    match &trigger.user_id {
        Some(u) => ctx.with_user(u.clone()),
        None => ctx,
    }
}

/// Render the strings in action values.
fn render_values(
    ctx: &RenderCtx<'_>,
    values: &BTreeMap<String, Json>,
) -> Result<BTreeMap<String, Json>, StepError> {
    values
        .iter()
        .map(|(k, v)| Ok((k.clone(), ctx.render_json(v)?)))
        .collect()
}

/// Check the table belongs to the automation's base, resolve the value keys
/// (ids, or names for definitions saved by hand) to field ids and validate
/// each value; returns the values keyed by field id for the writer.
fn prepare_values(
    conn: &Connection,
    base_id: &str,
    table_id: &str,
    rendered: &BTreeMap<String, Json>,
) -> AppResult<BTreeMap<String, Json>> {
    match schema::table_any(conn, table_id)? {
        Some(t) if t.deleted_at.is_none() && t.base_id == base_id => {}
        _ => {
            return Err(AppError::bad_request(
                "the table no longer exists in this base",
            ));
        }
    }
    let fields = schema::table_fields(conn, table_id)?;
    let cell_ctx = CellCtx::new(Utc::now(), Tz::UTC).with_typecast(true);
    let mut out = BTreeMap::new();
    for (key, value) in rendered {
        let field = resolve_field(&fields, key)
            .ok_or_else(|| AppError::bad_request(format!("unknown field \"{key}\"")))?;
        if field.field_type().is_computed() {
            return Err(AppError::bad_request(format!(
                "field \"{}\" is computed and cannot be set",
                field.name
            )));
        }
        match normalize(field, value, &cell_ctx) {
            // Typecast creates missing select choices in the real writer.
            Ok(_) | Err(CellError::UnknownChoice(_)) => {}
            Err(e) => {
                return Err(AppError::bad_request(format!(
                    "field \"{}\": {e}",
                    field.name
                )));
            }
        }
        out.insert(field.id.clone(), value.clone());
    }
    Ok(out)
}

/// The record exists, is not deleted and lives in `table_id` of this base.
fn check_record(
    conn: &Connection,
    base_id: &str,
    table_id: &str,
    record_id: &str,
) -> AppResult<()> {
    let found: bool = conn
        .query_row(
            "SELECT 1 FROM records r JOIN tables t ON t.id = r.table_id
             WHERE r.id = ?1 AND r.table_id = ?2 AND t.base_id = ?3
               AND r.deleted_at IS NULL AND t.deleted_at IS NULL",
            [record_id, table_id, base_id],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false);
    if found {
        Ok(())
    } else {
        Err(AppError::bad_request(format!(
            "record {record_id} was not found in the table"
        )))
    }
}

/// The copy of a step's output kept in the run log: long response bodies are
/// cut so a run with many requests cannot bloat the database.
pub fn log_output(output: &Json) -> Json {
    let mut out = output.clone();
    if let Some(obj) = out.as_object_mut() {
        if let Some(Json::String(body)) = obj.get_mut("body") {
            if body.chars().count() > LOGGED_BODY_CHARS {
                *body = body.chars().take(LOGGED_BODY_CHARS).collect();
                obj.insert("truncated".into(), json!(true));
                obj.remove("json");
            }
        }
    }
    out
}
