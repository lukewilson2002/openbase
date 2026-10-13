//! Records API.
//!
//! Write endpoints (Editor role): `POST|PATCH|DELETE /api/tables/{id}/records`
//! (batch), `POST /api/tables/{id}/records/restore`,
//! `POST /api/tables/{id}/records/move`. Read: `GET /api/tables/{id}/records/{rid}`
//! (Viewer). All writes go through `engine::write` in one transaction and
//! events are published after it commits.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use og_core::api::records::{
    CreateRecords, MoveRecords, Record, RecordIds, RecordsResponse, UpdateRecords,
};
use serde_json::{Value as Json2, json};

use crate::api::schema_support::{ApiJson, publish};
use crate::auth::Actor;
use crate::engine::write::{self, CreateOpts, WriteCtx, WriteOutcome, WriteSource};
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::records as record_store;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tables/{id}/records",
            post(create).patch(update).delete(remove),
        )
        .route("/api/tables/{id}/records/restore", post(restore))
        .route("/api/tables/{id}/records/move", post(move_records))
        .route("/api/tables/{id}/records/{rid}", get(get_one))
}

/// Publish the events of a committed write on behalf of `actor`.
pub fn publish_outcome(state: &AppState, headers: &HeaderMap, actor: &Actor, outcome: &WriteOutcome) {
    for event in outcome.events() {
        publish(state, headers, actor, &outcome.base_id, event);
    }
}

fn editor_ctx(
    tx: &rusqlite::Transaction,
    actor: &Actor,
    table_id: &str,
) -> AppResult<WriteCtx> {
    let base = perm::base_of_table(tx, table_id)?;
    perm::require_base(tx, actor, &base, Role::Editor)?;
    WriteCtx::for_user(tx, &actor.user_id, WriteSource::Api)
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<CreateRecords>,
) -> AppResult<(StatusCode, Json<RecordsResponse>)> {
    let who = actor.clone();
    let (outcome, records) = state
        .db
        .write(move |tx| {
            let ctx = editor_ctx(tx, &actor, &table_id)?.typecast(body.typecast);
            let opts = CreateOpts {
                after_record_id: body.after_record_id,
            };
            let outcome = write::create_records(tx, &ctx, &table_id, body.records, &opts)?;
            let ids = outcome.target().created.to_vec();
            let records = record_store::load_dtos(tx, &table_id, &ids, ctx.timezone)?;
            Ok((outcome, records))
        })
        .await?;
    publish_outcome(&state, &headers, &who, &outcome);
    Ok((StatusCode::CREATED, Json(RecordsResponse { records })))
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<UpdateRecords>,
) -> AppResult<Json<RecordsResponse>> {
    let who = actor.clone();
    let (outcome, records) = state
        .db
        .write(move |tx| {
            let ctx = editor_ctx(tx, &actor, &table_id)?.typecast(body.typecast);
            let ids: Vec<String> = body.records.iter().map(|p| p.id.clone()).collect();
            let outcome = write::update_records(tx, &ctx, &table_id, body.records)?;
            let records = record_store::load_dtos(tx, &table_id, &ids, ctx.timezone)?;
            Ok((outcome, records))
        })
        .await?;
    publish_outcome(&state, &headers, &who, &outcome);
    Ok(Json(RecordsResponse { records }))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<RecordIds>,
) -> AppResult<Json<Json2>> {
    let who = actor.clone();
    let outcome = state
        .db
        .write(move |tx| {
            let ctx = editor_ctx(tx, &actor, &table_id)?;
            write::delete_records(tx, &ctx, &table_id, &body.ids)
        })
        .await?;
    publish_outcome(&state, &headers, &who, &outcome);
    Ok(Json(json!({ "ok": true, "ids": outcome.target().deleted.to_vec() })))
}

async fn restore(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<RecordIds>,
) -> AppResult<Json<RecordsResponse>> {
    let who = actor.clone();
    let (outcome, records) = state
        .db
        .write(move |tx| {
            let ctx = editor_ctx(tx, &actor, &table_id)?;
            let outcome = write::restore_records(tx, &ctx, &table_id, &body.ids)?;
            let ids = outcome.target().restored.to_vec();
            let records = record_store::load_dtos(tx, &table_id, &ids, ctx.timezone)?;
            Ok((outcome, records))
        })
        .await?;
    publish_outcome(&state, &headers, &who, &outcome);
    Ok(Json(RecordsResponse { records }))
}

async fn move_records(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<MoveRecords>,
) -> AppResult<Json<Json2>> {
    let who = actor.clone();
    let outcome = state
        .db
        .write(move |tx| {
            let ctx = editor_ctx(tx, &actor, &table_id)?;
            write::move_records(tx, &ctx, &table_id, &body)
        })
        .await?;
    publish_outcome(&state, &headers, &who, &outcome);
    Ok(Json(json!({ "ok": true })))
}

async fn get_one(
    State(state): State<AppState>,
    actor: Actor,
    Path((table_id, record_id)): Path<(String, String)>,
) -> AppResult<Json<Record>> {
    let record = state
        .db
        .read(move |conn| {
            let base = perm::base_of_table(conn, &table_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            let tz = write::user_timezone(conn, &actor.user_id);
            let mut found = record_store::load_dtos(conn, &table_id, &[record_id.clone()], tz)?;
            found
                .pop()
                .ok_or_else(|| AppError::not_found("record"))
        })
        .await?;
    Ok(Json(record))
}
