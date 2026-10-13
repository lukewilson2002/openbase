//! `automations` API: CRUD (Creator and above), test runs, run history
//! (Editor and above) and the public incoming-webhook endpoint.
//!
//! The business rules live in `crate::automations` (validation in
//! `validate`, execution in `actions`/`runner`); the handlers resolve the
//! caller's role on the automation's base and delegate.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use ob_core::api::automations::{
    Automation, CreateAutomation, RunStatus, RunsPage, TestAutomation, TestResult, Trigger,
    UpdateAutomation, WebhookAccepted,
};
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{Value as Json2, json};

use crate::api::schema_support::{OptionalJson, ok};
use crate::auth::{Actor, ClientInfo};
use crate::automations::actions::{Executor, RunInput, RunResult};
use crate::automations::store::{self, AutomationRow};
use crate::automations::triggers::{TriggerData, TriggerRecord};
use crate::automations::{schedule, triggers, validate};
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiQuery};
use crate::ids::{hash_token, new_token};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::audit;
use crate::store::schema;

/// Largest body accepted by `POST /api/hooks/{token}`.
pub const MAX_WEBHOOK_BODY: usize = 1024 * 1024;
/// Calls per automation per minute on its webhook.
pub const WEBHOOK_RATE_PER_MINUTE: u32 = 60;
/// Calls with unknown tokens per client address per minute.
pub const WEBHOOK_BAD_TOKEN_PER_MINUTE: u32 = 30;
/// Test runs per user per minute.
const TEST_RATE_PER_MINUTE: u32 = 30;
const MINUTE: Duration = Duration::from_secs(60);
const TOKEN_PREFIX: &str = "obh_";
const DEFAULT_RUNS_PAGE: u32 = 50;
const MAX_RUNS_PAGE: u32 = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/bases/{id}/automations", get(list).post(create))
        .route(
            "/api/automations/{id}",
            get(read).patch(update).delete(remove),
        )
        .route("/api/automations/{id}/test", post(test))
        .route("/api/automations/{id}/runs", get(runs))
        .route(
            "/api/hooks/{token}",
            post(webhook).layer(DefaultBodyLimit::max(MAX_WEBHOOK_BODY)),
        )
}

fn load_for(tx: &Connection, actor: &Actor, id: &str, min: Role) -> AppResult<AutomationRow> {
    let row = store::get(tx, id)?;
    perm::require_base(tx, actor, &row.base_id, min)?;
    Ok(row)
}

fn audit_event(tx: &Transaction, actor: &Actor, action: &str, a: &AutomationRow) -> AppResult<()> {
    audit::record_as(
        tx,
        actor,
        action,
        Some(&a.id),
        Some(json!({ "name": a.name, "base_id": a.base_id })),
        None,
    )
}

/// First run time for a schedule trigger, from `now`.
fn first_run(trigger: &Trigger, now: i64) -> Option<i64> {
    let Trigger::Schedule { cron, timezone } = trigger else {
        return None;
    };
    let cron = schedule::parse_cron(cron).ok()?;
    let tz = schedule::parse_timezone(timezone).ok()?;
    schedule::next_after(&cron, tz, now)
}

// ------------------------------------------------------------------ CRUD

async fn list(
    State(state): State<AppState>,
    actor: Actor,
    Path(base_id): Path<String>,
) -> AppResult<Json<Vec<Automation>>> {
    let rows = state
        .db
        .read(move |c| {
            perm::require_base(c, &actor, &base_id, Role::Creator)?;
            store::list(c, &base_id)
        })
        .await?;
    Ok(Json(rows.iter().map(|r| r.dto(None)).collect()))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    Path(base_id): Path<String>,
    ApiJson(body): ApiJson<CreateAutomation>,
) -> AppResult<(StatusCode, Json<Automation>)> {
    let config = state.config.clone();
    let email_enabled = state.email.enabled();
    let dto = state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &base_id, Role::Creator)?;
            let name = schema::validate_name(&body.name, "automation")?;
            let valid = validate::validate(
                tx,
                &config,
                email_enabled,
                &base_id,
                &body.trigger,
                &body.actions,
                body.enabled,
            )?;
            let now = now_ms();
            let token =
                matches!(valid.trigger, Trigger::Webhook {}).then(|| new_token(TOKEN_PREFIX));
            let row = AutomationRow {
                id: store::new_automation_id(),
                base_id: base_id.clone(),
                name,
                enabled: body.enabled,
                next_run_at: body
                    .enabled
                    .then(|| first_run(&valid.trigger, now))
                    .flatten(),
                trigger: valid.trigger,
                actions: valid.actions,
                webhook_token_hash: token.as_deref().map(hash_token),
                created_by: Some(actor.user_id.clone()),
                created_at: now,
                updated_at: now,
            };
            store::insert(tx, &row)?;
            audit_event(tx, &actor, "automation_create", &row)?;
            Ok(row.dto(token))
        })
        .await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

async fn read(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Automation>> {
    let row = state
        .db
        .read(move |c| load_for(c, &actor, &id, Role::Creator))
        .await?;
    Ok(Json(row.dto(None)))
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateAutomation>,
) -> AppResult<Json<Automation>> {
    let config = state.config.clone();
    let email_enabled = state.email.enabled();
    let dto = state
        .db
        .write(move |tx| {
            let mut row = load_for(tx, &actor, &id, Role::Creator)?;
            let now = now_ms();
            let was_enabled = row.enabled;
            if let Some(name) = &body.name {
                row.name = schema::validate_name(name, "automation")?;
            }
            let trigger_changed = body.trigger.is_some();
            let enabled = body.enabled.unwrap_or(row.enabled);
            // A stored definition may have gone stale (a table was deleted);
            // renaming it must still work, turning it on must not.
            if trigger_changed || body.actions.is_some() || (enabled && !was_enabled) {
                let valid = validate::validate(
                    tx,
                    &config,
                    email_enabled,
                    &row.base_id,
                    body.trigger.as_ref().unwrap_or(&row.trigger),
                    body.actions.as_deref().unwrap_or(&row.actions),
                    enabled,
                )?;
                row.trigger = valid.trigger;
                row.actions = valid.actions;
            }
            row.enabled = enabled;

            let mut token = None;
            if matches!(row.trigger, Trigger::Webhook {}) {
                if body.rotate_webhook_token || row.webhook_token_hash.is_none() {
                    let t = new_token(TOKEN_PREFIX);
                    row.webhook_token_hash = Some(hash_token(&t));
                    token = Some(t);
                }
            } else {
                if body.rotate_webhook_token {
                    return Err(AppError::bad_request(
                        "only automations with a webhook trigger have a webhook token",
                    ));
                }
                row.webhook_token_hash = None;
            }

            row.next_run_at = if !enabled {
                None
            } else if trigger_changed || !was_enabled || row.next_run_at.is_none() {
                first_run(&row.trigger, now)
            } else {
                row.next_run_at
            };
            row.updated_at = now;
            store::update(tx, &row)?;
            if !enabled {
                store::cancel_queued(tx, &row.id, "the automation was turned off", now)?;
            }
            audit_event(tx, &actor, "automation_update", &row)?;
            Ok(row.dto(token))
        })
        .await?;
    Ok(Json(dto))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Json2>> {
    state
        .db
        .write(move |tx| {
            let row = load_for(tx, &actor, &id, Role::Creator)?;
            store::delete(tx, &row.id)?;
            audit_event(tx, &actor, "automation_delete", &row)
        })
        .await?;
    Ok(ok())
}

// ------------------------------------------------------------------ runs

#[derive(Debug, Deserialize)]
struct RunsQuery {
    limit: Option<u32>,
    before: Option<i64>,
}

async fn runs(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ApiQuery(q): ApiQuery<RunsQuery>,
) -> AppResult<Json<RunsPage>> {
    let limit = q.limit.unwrap_or(DEFAULT_RUNS_PAGE).clamp(1, MAX_RUNS_PAGE);
    let (rows, total, next_before) = state
        .db
        .read(move |c| {
            let row = load_for(c, &actor, &id, Role::Editor)?;
            store::runs_page(c, &row.id, q.before, limit)
        })
        .await?;
    Ok(Json(RunsPage {
        runs: rows.into_iter().map(|r| r.dto()).collect(),
        total,
        next_before,
    }))
}

// ------------------------------------------------------------------ test

async fn test(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    OptionalJson(req): OptionalJson<TestAutomation>,
) -> AppResult<Json<TestResult>> {
    state.limiter.check(
        "automation_test",
        &actor.user_id,
        TEST_RATE_PER_MINUTE,
        MINUTE,
    )?;
    let user_id = actor.user_id.clone();
    let (auto, trigger) = {
        let req = req.clone();
        state
            .db
            .read(move |c| {
                let row = load_for(c, &actor, &id, Role::Creator)?;
                let trigger = sample_trigger(c, &row, &req, &user_id)?;
                Ok((row, trigger))
            })
            .await?
    };
    let exec = Executor::new(state.clone());
    let started = now_ms();
    let mut log = Vec::new();
    let result = exec
        .execute(
            &RunInput {
                automation: &auto,
                trigger: &trigger,
                run_id: None,
                attempt: 1,
                dry_run: req.dry_run,
            },
            &mut log,
        )
        .await;
    let (status, error) = match result {
        RunResult::Succeeded => (RunStatus::Succeeded, None),
        RunResult::Failed { error, .. } => (RunStatus::Failed, Some(error)),
    };
    let run_id = if req.dry_run {
        None
    } else {
        let (aid, data, l, e) = (
            auto.id.clone(),
            trigger.to_json(),
            log.clone(),
            error.clone(),
        );
        Some(
            state
                .db
                .write(move |tx| {
                    store::insert_finished_run(tx, &aid, &data, status, &l, e.as_deref(), started)
                })
                .await?,
        )
    };
    Ok(Json(TestResult {
        dry_run: req.dry_run,
        status,
        log,
        error,
        run_id,
    }))
}

/// Build the trigger data a test run uses: the chosen (or first) record for
/// record triggers, the sample body for webhooks.
fn sample_trigger(
    conn: &Connection,
    auto: &AutomationRow,
    req: &TestAutomation,
    user_id: &str,
) -> AppResult<TriggerData> {
    let now = now_ms();
    let (kind, table_id) = match &auto.trigger {
        Trigger::RecordCreated { table_id } => ("record_created", Some(table_id.clone())),
        Trigger::RecordUpdated { table_id, .. } => ("record_updated", Some(table_id.clone())),
        Trigger::RecordMatches { table_id, .. } => ("record_matches", Some(table_id.clone())),
        Trigger::FormSubmitted { view_id } => {
            let view = schema::live_view(conn, view_id)
                .map_err(|_| AppError::bad_request("the form view no longer exists"))?;
            ("form_submitted", Some(view.view.table_id))
        }
        Trigger::Schedule { .. } => ("schedule", None),
        Trigger::Webhook {} => ("webhook", None),
    };
    let mut data = TriggerData::new(kind, now);
    data.test = true;
    data.user_id = Some(user_id.to_string());
    if let Trigger::FormSubmitted { view_id } = &auto.trigger {
        data.view_id = Some(view_id.clone());
    }
    match table_id {
        Some(table_id) => {
            let row: Option<(String, String)> = match &req.record_id {
                Some(rid) => conn
                    .query_row(
                        "SELECT id, data FROM records
                         WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL",
                        [rid, &table_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?,
                None => conn
                    .query_row(
                        "SELECT id, data FROM records WHERE table_id = ?1 AND deleted_at IS NULL
                         ORDER BY position, id LIMIT 1",
                        [&table_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?,
            };
            let (id, raw) = row.ok_or_else(|| match &req.record_id {
                Some(_) => AppError::bad_request("that record does not exist in the trigger table"),
                None => AppError::bad_request("the trigger table has no records to test with"),
            })?;
            let fields = match serde_json::from_str(&raw) {
                Ok(Json2::Object(m)) => m,
                _ => Default::default(),
            };
            data.record = Some(TriggerRecord {
                id,
                table_id,
                fields,
            });
        }
        None => {
            if req.record_id.is_some() {
                return Err(AppError::bad_request("this trigger does not use a record"));
            }
            if matches!(auto.trigger, Trigger::Webhook {}) {
                data.body = Some(req.body.clone().unwrap_or_else(|| json!({})));
            }
        }
    }
    Ok(data)
}

// --------------------------------------------------------------- webhook

/// `POST /api/hooks/{token}`: public. 404 for unknown tokens and for
/// disabled automations alike.
async fn webhook(
    State(state): State<AppState>,
    client: ClientInfo,
    Path(token): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> AppResult<(StatusCode, Json<WebhookAccepted>)> {
    let bytes = body.map_err(|e| {
        if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::PayloadTooLarge("the webhook body is too large (maximum 1 MB)".into())
        } else {
            AppError::bad_request("could not read the request body")
        }
    })?;
    if bytes.len() > MAX_WEBHOOK_BODY {
        return Err(AppError::PayloadTooLarge(
            "the webhook body is too large (maximum 1 MB)".into(),
        ));
    }
    let hash = hash_token(&token);
    let found = state
        .db
        .read(move |c| store::by_webhook_hash(c, &hash))
        .await?;
    let Some(auto) = found.filter(|a| a.enabled && matches!(a.trigger, Trigger::Webhook {})) else {
        // Guessing tokens is rate limited per client address.
        state.limiter.check(
            "hook_bad_token",
            &client.ip,
            WEBHOOK_BAD_TOKEN_PER_MINUTE,
            MINUTE,
        )?;
        return Err(AppError::not_found("webhook"));
    };
    state
        .limiter
        .check("hook", &auto.id, WEBHOOK_RATE_PER_MINUTE, MINUTE)?;
    let payload: Option<Json2> = if bytes.iter().all(u8::is_ascii_whitespace) {
        None
    } else {
        Some(
            serde_json::from_slice(&bytes)
                .map_err(|e| AppError::bad_request(format!("the body is not valid JSON: {e}")))?,
        )
    };
    let id = auto.id.clone();
    let run_id = state
        .db
        .write(move |tx| triggers::enqueue_webhook(tx, &id, payload))
        .await?
        .ok_or(AppError::TooManyRequests)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(WebhookAccepted { ok: true, run_id }),
    ))
}
