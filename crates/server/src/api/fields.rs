//! Fields: create, update (including type changes), delete, primary field.
//! All require the Creator role on the base.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{patch, post};
use axum::{Json, Router};
use og_core::api::schema::{SetPrimaryField, Table};
use serde_json::{Value as Json2, json};

use crate::api::schema_support::{ApiJson, publish_schema};
use crate::auth::Actor;
use crate::error::AppResult;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::field_kind::{parse_create_field, parse_update_field};
use crate::store::fields::{self, FieldChange};
use crate::store::schema::Touched;
use crate::store::tables;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tables/{id}/fields", post(create))
        .route("/api/fields/{id}", patch(update).delete(remove))
        .route("/api/tables/{id}/primary-field", post(set_primary))
}

/// The field as JSON, plus the link `inverse` created/kept in the other table
/// and the ids of fields trashed as a consequence.
fn change_body(change: &FieldChange) -> Json2 {
    let mut body = serde_json::to_value(&change.field).unwrap_or(Json2::Null);
    if let Some(obj) = body.as_object_mut() {
        if let Some(inv) = &change.inverse {
            obj.insert(
                "inverse".into(),
                serde_json::to_value(inv).unwrap_or(Json2::Null),
            );
        }
        if !change.removed_field_ids.is_empty() {
            obj.insert("removed_field_ids".into(), json!(change.removed_field_ids));
        }
    }
    body
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<Json2>,
) -> AppResult<(StatusCode, Json<Json2>)> {
    let input = parse_create_field(body)?;
    let who = actor.clone();
    let (base, change) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_table(tx, &table_id)?;
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            Ok((base, fields::create(tx, &table_id, &input)?))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &change.touched);
    Ok((StatusCode::CREATED, Json(change_body(&change))))
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Json2>,
) -> AppResult<Json<Json2>> {
    let patch = parse_update_field(body)?;
    let who = actor.clone();
    let (base, change) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_field(tx, &id)?;
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            Ok((base, fields::update(tx, &id, &patch)?))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &change.touched);
    Ok(Json(change_body(&change)))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<Json2>> {
    let who = actor.clone();
    let (base, out) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_field(tx, &id)?;
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            Ok((base, fields::delete(tx, &id)?))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &out.touched);
    Ok(Json(
        json!({ "ok": true, "deleted_field_ids": out.deleted_field_ids }),
    ))
}

async fn set_primary(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<SetPrimaryField>,
) -> AppResult<Json<Table>> {
    let who = actor.clone();
    let (base, table) = state
        .db
        .write(move |tx| {
            let base = perm::base_of_table(tx, &table_id)?;
            perm::require_base(tx, &actor, &base, Role::Creator)?;
            let row = fields::set_primary(tx, &table_id, &body.field_id)?;
            Ok((base, tables::to_dto(tx, &row, &actor.user_id)?))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &Touched::of(&table.id));
    Ok(Json(table))
}
