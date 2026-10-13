//! Views: create, update, delete, duplicate. Fine-grained rules (personal,
//! locked, shared) live in `store::views`; the handlers only resolve the
//! caller's role on the base.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{patch, post};
use axum::{Json, Router};
use og_core::api::schema::{CreateView, DuplicateView, UpdateView, View};

use crate::api::schema_support::{OptionalJson, ok, publish_schema};
use crate::auth::Actor;
use crate::error::AppResult;
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::schema::Touched;
use crate::store::views;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tables/{id}/views", post(create))
        .route("/api/views/{id}", patch(update).delete(remove))
        .route("/api/views/{id}/duplicate", post(duplicate))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<CreateView>,
) -> AppResult<(StatusCode, Json<View>)> {
    let who = actor.clone();
    let (base, view) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_table(tx, &table_id)?;
            let role = perm::require_base(tx, &actor, &base, Role::Viewer)?;
            Ok((
                base,
                views::create(tx, &table_id, &body, &actor.user_id, role)?,
            ))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &Touched::of(&view.table_id));
    Ok((StatusCode::CREATED, Json(view)))
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateView>,
) -> AppResult<Json<View>> {
    let who = actor.clone();
    let (base, view) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_view(tx, &id)?;
            let role = perm::require_base(tx, &actor, &base, Role::Viewer)?;
            Ok((base, views::update(tx, &id, &body, &actor.user_id, role)?))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &Touched::of(&view.table_id));
    Ok(Json(view))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let who = actor.clone();
    let (base, table_id) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_view(tx, &id)?;
            let role = perm::require_base(tx, &actor, &base, Role::Viewer)?;
            let table_id = crate::store::schema::live_view(tx, &id)?.view.table_id;
            views::delete(tx, &id, &actor.user_id, role)?;
            Ok((base, table_id))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &Touched::of(&table_id));
    Ok(ok())
}

async fn duplicate(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    OptionalJson(body): OptionalJson<DuplicateView>,
) -> AppResult<(StatusCode, Json<View>)> {
    let who = actor.clone();
    let (base, view) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_view(tx, &id)?;
            let role = perm::require_base(tx, &actor, &base, Role::Viewer)?;
            Ok((
                base,
                views::duplicate(tx, &id, &body, &actor.user_id, role)?,
            ))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &Touched::of(&view.table_id));
    Ok((StatusCode::CREATED, Json(view)))
}
