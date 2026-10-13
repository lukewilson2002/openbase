//! SQL for the `automations` and `automation_runs` tables.
//!
//! Synchronous functions over a `Connection` / `Transaction`, like the rest of
//! `store`. Triggers and actions are stored as JSON (the same shapes as the
//! API DTOs); the webhook token is stored only as a SHA-256 hash.
//!
//! Runs form a durable queue: `queued` -> `running` -> `succeeded | failed`. A
//! failed attempt that will be retried goes back to `queued` with the retry
//! time recorded on the last log line (`retry_at`), so the whole queue state
//! lives in the database and survives restarts.

use og_core::api::automations::{
    ActionStep, Automation, AutomationRun, RunStatus, StepLog, Trigger,
};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, params};
use serde_json::Value as Json;

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;

/// Queued runs per automation beyond which new events are dropped (with a
/// warning), so a bulk import cannot bury the database in work.
pub const MAX_QUEUED_RUNS_PER_AUTOMATION: i64 = 5_000;
/// The same for webhook calls, whose payloads can be up to 1 MB each.
pub const MAX_QUEUED_WEBHOOK_RUNS: i64 = 200;

// ------------------------------------------------------------ automations

#[derive(Debug, Clone)]
pub struct AutomationRow {
    pub id: String,
    pub base_id: String,
    pub name: String,
    pub enabled: bool,
    pub trigger: Trigger,
    pub actions: Vec<ActionStep>,
    pub webhook_token_hash: Option<String>,
    pub next_run_at: Option<i64>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl AutomationRow {
    /// The API form; `webhook_token` is only known right after (re)issuing it.
    pub fn dto(&self, webhook_token: Option<String>) -> Automation {
        Automation {
            id: self.id.clone(),
            base_id: self.base_id.clone(),
            name: self.name.clone(),
            enabled: self.enabled,
            trigger: self.trigger.clone(),
            actions: self.actions.clone(),
            next_run_at: self.next_run_at,
            webhook_token,
            created_by: self.created_by.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

const COLS: &str = "id, base_id, name, enabled, \"trigger\", actions, webhook_token_hash, \
                    next_run_at, created_by, created_at, updated_at";

struct Raw {
    id: String,
    base_id: String,
    name: String,
    enabled: bool,
    trigger: String,
    actions: String,
    webhook_token_hash: Option<String>,
    next_run_at: Option<i64>,
    created_by: Option<String>,
    created_at: i64,
    updated_at: i64,
}

fn raw(r: &Row) -> rusqlite::Result<Raw> {
    Ok(Raw {
        id: r.get(0)?,
        base_id: r.get(1)?,
        name: r.get(2)?,
        enabled: r.get(3)?,
        trigger: r.get(4)?,
        actions: r.get(5)?,
        webhook_token_hash: r.get(6)?,
        next_run_at: r.get(7)?,
        created_by: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

fn parse(r: Raw) -> AppResult<AutomationRow> {
    let trigger = serde_json::from_str(&r.trigger)
        .map_err(|e| AppError::internal(format!("corrupt trigger of automation {}: {e}", r.id)))?;
    let actions = serde_json::from_str(&r.actions)
        .map_err(|e| AppError::internal(format!("corrupt actions of automation {}: {e}", r.id)))?;
    Ok(AutomationRow {
        id: r.id,
        base_id: r.base_id,
        name: r.name,
        enabled: r.enabled,
        trigger,
        actions,
        webhook_token_hash: r.webhook_token_hash,
        next_run_at: r.next_run_at,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}

fn query(conn: &Connection, sql: &str, p: impl rusqlite::Params) -> AppResult<Vec<AutomationRow>> {
    let mut stmt = conn.prepare(sql)?;
    let raws = stmt.query_map(p, raw)?.collect::<Result<Vec<_>, _>>()?;
    raws.into_iter().map(parse).collect()
}

pub fn get(conn: &Connection, id: &str) -> AppResult<AutomationRow> {
    query(
        conn,
        &format!("SELECT {COLS} FROM automations WHERE id = ?1"),
        [id],
    )?
    .pop()
    .ok_or_else(|| AppError::not_found("automation"))
}

/// All automations of a base, oldest first.
pub fn list(conn: &Connection, base_id: &str) -> AppResult<Vec<AutomationRow>> {
    query(
        conn,
        &format!("SELECT {COLS} FROM automations WHERE base_id = ?1 ORDER BY created_at, id"),
        [base_id],
    )
}

/// Enabled automations of a base. Rows whose JSON no longer parses are
/// skipped with a warning rather than failing the record write that asked.
pub fn enabled_for_base(conn: &Connection, base_id: &str) -> AppResult<Vec<AutomationRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM automations WHERE base_id = ?1 AND enabled = 1 ORDER BY created_at, id"
    ))?;
    let raws = stmt
        .query_map([base_id], raw)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(raws
        .into_iter()
        .filter_map(|r| match parse(r) {
            Ok(a) => Some(a),
            Err(e) => {
                tracing::warn!(error = %e, "skipping unreadable automation");
                None
            }
        })
        .collect())
}

pub fn by_webhook_hash(conn: &Connection, hash: &str) -> AppResult<Option<AutomationRow>> {
    Ok(query(
        conn,
        &format!("SELECT {COLS} FROM automations WHERE webhook_token_hash = ?1"),
        [hash],
    )?
    .pop())
}

pub fn insert(tx: &Transaction, a: &AutomationRow) -> AppResult<()> {
    tx.execute(
        &format!(
            "INSERT INTO automations ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
        ),
        params![
            a.id,
            a.base_id,
            a.name,
            a.enabled,
            serde_json::to_string(&a.trigger)?,
            serde_json::to_string(&a.actions)?,
            a.webhook_token_hash,
            a.next_run_at,
            a.created_by,
            a.created_at,
            a.updated_at
        ],
    )?;
    Ok(())
}

pub fn update(tx: &Transaction, a: &AutomationRow) -> AppResult<()> {
    tx.execute(
        "UPDATE automations SET name = ?2, enabled = ?3, \"trigger\" = ?4, actions = ?5,
                webhook_token_hash = ?6, next_run_at = ?7, updated_at = ?8
         WHERE id = ?1",
        params![
            a.id,
            a.name,
            a.enabled,
            serde_json::to_string(&a.trigger)?,
            serde_json::to_string(&a.actions)?,
            a.webhook_token_hash,
            a.next_run_at,
            a.updated_at
        ],
    )?;
    Ok(())
}

/// Delete an automation; its runs go with it (foreign key cascade).
pub fn delete(tx: &Transaction, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM automations WHERE id = ?1", [id])?;
    Ok(())
}

pub fn new_automation_id() -> String {
    new_id(og_core::ids::AUTOMATION)
}

/// Enabled schedule automations whose `next_run_at` has passed.
pub fn due_schedules(conn: &Connection, now: i64) -> AppResult<Vec<AutomationRow>> {
    let rows = query(
        conn,
        &format!(
            "SELECT {COLS} FROM automations
             WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1
             ORDER BY next_run_at, id"
        ),
        [now],
    )?;
    Ok(rows
        .into_iter()
        .filter(|a| matches!(a.trigger, Trigger::Schedule { .. }))
        .collect())
}

pub fn set_next_run(tx: &Transaction, id: &str, next: Option<i64>) -> AppResult<()> {
    tx.execute(
        "UPDATE automations SET next_run_at = ?2 WHERE id = ?1",
        params![id, next],
    )?;
    Ok(())
}

// ------------------------------------------------------------------ runs

#[derive(Debug, Clone)]
pub struct RunRow {
    pub id: i64,
    pub automation_id: String,
    pub status: RunStatus,
    pub trigger_data: Json,
    pub log: Vec<StepLog>,
    pub error: Option<String>,
    pub attempts: u32,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

impl RunRow {
    pub fn dto(self) -> AutomationRun {
        AutomationRun {
            id: self.id,
            automation_id: self.automation_id,
            status: self.status,
            trigger_data: self.trigger_data,
            log: self.log,
            error: self.error,
            attempts: self.attempts,
            created_at: self.created_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
        }
    }
}

const RUN_COLS: &str = "id, automation_id, status, trigger_data, log, error, attempts, created_at, started_at, finished_at";

fn run_status(s: &str) -> RunStatus {
    match s {
        "queued" => RunStatus::Queued,
        "running" => RunStatus::Running,
        "succeeded" => RunStatus::Succeeded,
        _ => RunStatus::Failed,
    }
}

fn run_row(r: &Row) -> rusqlite::Result<RunRow> {
    let status: String = r.get(2)?;
    let trigger_data: String = r.get(3)?;
    let log: String = r.get(4)?;
    Ok(RunRow {
        id: r.get(0)?,
        automation_id: r.get(1)?,
        status: run_status(&status),
        trigger_data: serde_json::from_str(&trigger_data).unwrap_or(Json::Null),
        log: serde_json::from_str(&log).unwrap_or_default(),
        error: r.get(5)?,
        attempts: r.get::<_, i64>(6)?.max(0) as u32,
        created_at: r.get(7)?,
        started_at: r.get(8)?,
        finished_at: r.get(9)?,
    })
}

pub fn get_run(conn: &Connection, run_id: i64) -> AppResult<RunRow> {
    conn.query_row(
        &format!("SELECT {RUN_COLS} FROM automation_runs WHERE id = ?1"),
        [run_id],
        run_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("run"))
}

/// Queue a run. Returns None (and logs) when the automation already has
/// [`MAX_QUEUED_RUNS_PER_AUTOMATION`] runs waiting.
pub fn enqueue_run(
    tx: &Transaction,
    automation_id: &str,
    trigger_data: &Json,
) -> AppResult<Option<i64>> {
    enqueue_run_capped(
        tx,
        automation_id,
        trigger_data,
        MAX_QUEUED_RUNS_PER_AUTOMATION,
    )
}

/// [`enqueue_run`] with an explicit limit on waiting runs.
pub fn enqueue_run_capped(
    tx: &Transaction,
    automation_id: &str,
    trigger_data: &Json,
    cap: i64,
) -> AppResult<Option<i64>> {
    let queued: i64 = tx.query_row(
        "SELECT count(*) FROM automation_runs WHERE automation_id = ?1 AND status = 'queued'",
        [automation_id],
        |r| r.get(0),
    )?;
    if queued >= cap {
        tracing::warn!(
            automation = automation_id,
            queued,
            "automation run queue is full; dropping event"
        );
        return Ok(None);
    }
    tx.execute(
        "INSERT INTO automation_runs (automation_id, status, trigger_data, log, attempts, created_at)
         VALUES (?1, 'queued', ?2, '[]', 0, ?3)",
        params![automation_id, trigger_data.to_string(), now_ms()],
    )?;
    Ok(Some(tx.last_insert_rowid()))
}

/// Record a run that was executed synchronously (a real test run).
pub fn insert_finished_run(
    tx: &Transaction,
    automation_id: &str,
    trigger_data: &Json,
    status: RunStatus,
    log: &[StepLog],
    error: Option<&str>,
    started_at: i64,
) -> AppResult<i64> {
    tx.execute(
        "INSERT INTO automation_runs
            (automation_id, status, trigger_data, log, error, attempts, created_at, started_at, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, ?7)",
        params![
            automation_id,
            status.as_str(),
            trigger_data.to_string(),
            serde_json::to_string(log)?,
            error,
            started_at,
            now_ms()
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

/// Take the oldest queued run whose retry time has passed and mark it running.
pub fn claim_next(tx: &Transaction, now: i64) -> AppResult<Option<RunRow>> {
    let id: Option<i64> = tx
        .query_row(
            "SELECT id FROM automation_runs
             WHERE status = 'queued'
               AND COALESCE(json_extract(log, '$[#-1].retry_at'), 0) <= ?1
             ORDER BY id LIMIT 1",
            [now],
            |r| r.get(0),
        )
        .optional()?;
    let Some(id) = id else {
        return Ok(None);
    };
    tx.execute(
        "UPDATE automation_runs SET status = 'running', started_at = ?2, attempts = attempts + 1
         WHERE id = ?1",
        params![id, now],
    )?;
    Ok(Some(get_run(tx, id)?))
}

/// Persist the step log of a running run.
pub fn save_log(tx: &Transaction, run_id: i64, log: &[StepLog]) -> AppResult<()> {
    tx.execute(
        "UPDATE automation_runs SET log = ?2 WHERE id = ?1",
        params![run_id, serde_json::to_string(log)?],
    )?;
    Ok(())
}

pub fn finish(
    tx: &Transaction,
    run_id: i64,
    status: RunStatus,
    error: Option<&str>,
    log: &[StepLog],
    now: i64,
) -> AppResult<()> {
    tx.execute(
        "UPDATE automation_runs SET status = ?2, error = ?3, log = ?4, finished_at = ?5 WHERE id = ?1",
        params![run_id, status.as_str(), error, serde_json::to_string(log)?, now],
    )?;
    trim_webhook_bodies(tx, None, Some(run_id))?;
    Ok(())
}

/// Most characters of a webhook body kept on a finished run.
pub const KEPT_BODY_CHARS: usize = 16 * 1024;

/// Replace the body of finished webhook runs (of one automation and/or one
/// run; both None = all) that is longer than [`KEPT_BODY_CHARS`] by
/// `{"truncated": true, "preview": "<its first characters>"}`. A webhook
/// holder can send 1 MB per call and runs are kept for 30 days, so the full
/// body is only needed while the run is queued or running.
pub fn trim_webhook_bodies(
    tx: &Transaction,
    automation_id: Option<&str>,
    run_id: Option<i64>,
) -> AppResult<usize> {
    Ok(tx.execute(
        "UPDATE automation_runs
         SET trigger_data = json_set(trigger_data, '$.body', json_object(
                 'truncated', json('true'),
                 'preview', substr(CAST(json_extract(trigger_data, '$.body') AS TEXT), 1, ?3)))
         WHERE status IN ('succeeded', 'failed')
           AND (?1 IS NULL OR automation_id = ?1)
           AND (?2 IS NULL OR id = ?2)
           AND length(trigger_data) > ?3 * 2
           AND json_extract(trigger_data, '$.type') = 'webhook'
           AND json_type(trigger_data, '$.body') IS NOT NULL",
        params![automation_id, run_id, KEPT_BODY_CHARS as i64],
    )?)
}

/// Put a run back in the queue (a transient failure to retry, or recovery).
pub fn requeue(tx: &Transaction, run_id: i64, log: &[StepLog]) -> AppResult<()> {
    tx.execute(
        "UPDATE automation_runs SET status = 'queued', started_at = NULL, log = ?2 WHERE id = ?1",
        params![run_id, serde_json::to_string(log)?],
    )?;
    Ok(())
}

/// Fail every queued run of an automation (it was disabled or changed).
pub fn cancel_queued(
    tx: &Transaction,
    automation_id: &str,
    reason: &str,
    now: i64,
) -> AppResult<usize> {
    let n = tx.execute(
        "UPDATE automation_runs SET status = 'failed', error = ?2, finished_at = ?3
         WHERE automation_id = ?1 AND status = 'queued'",
        params![automation_id, reason, now],
    )?;
    trim_webhook_bodies(tx, Some(automation_id), None)?;
    Ok(n)
}

/// Runs left `running` by a crash or restart. Each is re-queued once (a
/// `recovery` line is added to its log); one that was already recovered, or
/// has used all its attempts, is failed instead. Returns (requeued, failed).
pub fn recover_interrupted(
    tx: &Transaction,
    now: i64,
    max_attempts: u32,
) -> AppResult<(usize, usize)> {
    let runs: Vec<RunRow> = {
        let mut stmt = tx.prepare(&format!(
            "SELECT {RUN_COLS} FROM automation_runs WHERE status = 'running' ORDER BY id"
        ))?;
        stmt.query_map([], run_row)?
            .collect::<Result<Vec<_>, _>>()?
    };
    let (mut requeued, mut failed) = (0, 0);
    for run in runs {
        let mut log = run.log.clone();
        let already = log.iter().any(|l| l.action == RECOVERY_ACTION);
        if already || run.attempts >= max_attempts {
            log.push(recovery_line(
                og_core::api::automations::StepStatus::Failed,
                "the server stopped while this run was in progress and it cannot be resumed again",
                run.attempts,
            ));
            finish(
                tx,
                run.id,
                RunStatus::Failed,
                Some("interrupted by a server restart"),
                &log,
                now,
            )?;
            failed += 1;
        } else {
            log.push(recovery_line(
                og_core::api::automations::StepStatus::Skipped,
                "the server stopped while this run was in progress; it was queued again",
                run.attempts,
            ));
            requeue(tx, run.id, &log)?;
            requeued += 1;
        }
    }
    Ok((requeued, failed))
}

/// Action name of the system log line written by crash recovery.
pub const RECOVERY_ACTION: &str = "recovery";

fn recovery_line(
    status: og_core::api::automations::StepStatus,
    message: &str,
    attempt: u32,
) -> StepLog {
    StepLog {
        index: None,
        action: RECOVERY_ACTION.into(),
        status,
        attempt,
        output: None,
        error: Some(message.into()),
        duration_ms: 0,
        retry_at: None,
    }
}

/// Newest-first page of an automation's runs: runs with id < `before` (all
/// when None), at most `limit`, plus the automation's total run count.
pub fn runs_page(
    conn: &Connection,
    automation_id: &str,
    before: Option<i64>,
    limit: u32,
) -> AppResult<(Vec<RunRow>, i64, Option<i64>)> {
    let total: i64 = conn.query_row(
        "SELECT count(*) FROM automation_runs WHERE automation_id = ?1",
        [automation_id],
        |r| r.get(0),
    )?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {RUN_COLS} FROM automation_runs
         WHERE automation_id = ?1 AND id < ?2
         ORDER BY id DESC LIMIT ?3"
    ))?;
    let runs = stmt
        .query_map(
            params![automation_id, before.unwrap_or(i64::MAX), limit as i64 + 1],
            run_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut runs = runs;
    let next_before = if runs.len() > limit as usize {
        runs.truncate(limit as usize);
        runs.last().map(|r| r.id)
    } else {
        None
    };
    Ok((runs, total, next_before))
}

/// Delete finished runs created before `cutoff_ms`. Queued and running runs
/// are never pruned.
pub fn prune_runs(tx: &Transaction, cutoff_ms: i64) -> AppResult<usize> {
    Ok(tx.execute(
        "DELETE FROM automation_runs
         WHERE created_at < ?1 AND status IN ('succeeded', 'failed')",
        [cutoff_ms],
    )?)
}

/// Retention of run history.
pub const RUN_RETENTION_DAYS: i64 = 30;
