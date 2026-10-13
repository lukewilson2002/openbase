//! Tables: create, rename/reorder, delete, duplicate.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{patch, post};
use axum::{Json, Router};
use og_core::api::schema::{CreateTable, DuplicateTable, Table, UpdateTable};

use crate::api::schema_support::{OptionalJson, ok, publish_schema};
use crate::auth::Actor;
use crate::error::AppResult;
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::schema::Touched;
use crate::store::tables;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/bases/{id}/tables", post(create))
        .route("/api/tables/{id}", patch(update).delete(remove))
        .route("/api/tables/{id}/duplicate", post(duplicate))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(base_id): Path<String>,
    ApiJson(body): ApiJson<CreateTable>,
) -> AppResult<(StatusCode, Json<Table>)> {
    let who = actor.clone();
    let base = base_id.clone();
    let table = state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &base_id, Role::Creator)?;
            let row = tables::create(tx, &base_id, &body.name, &actor.user_id)?;
            tables::to_dto(tx, &row, &actor.user_id)
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &Touched::of(&table.id));
    Ok((StatusCode::CREATED, Json(table)))
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateTable>,
) -> AppResult<Json<Table>> {
    let who = actor.clone();
    let (base, table) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_table(tx, &id)?;
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            let row = tables::update(tx, &id, &body)?;
            Ok((base, tables::to_dto(tx, &row, &actor.user_id)?))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &Touched::of(&table.id));
    Ok(Json(table))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let who = actor.clone();
    let (base, touched) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_table(tx, &id)?;
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            Ok((base, tables::soft_delete(tx, &id)?))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &touched);
    Ok(ok())
}

async fn duplicate(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    OptionalJson(req): OptionalJson<DuplicateTable>,
) -> AppResult<(StatusCode, Json<Table>)> {
    let who = actor.clone();
    let (base, table, touched) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_table(tx, &id)?;
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            let (row, touched) = tables::duplicate(tx, &id, &req, &actor.user_id)?;
            Ok((base, tables::to_dto(tx, &row, &actor.user_id)?, touched))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &touched);
    Ok((StatusCode::CREATED, Json(table)))
}
