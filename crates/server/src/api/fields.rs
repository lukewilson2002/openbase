//! Fields: create, update (including type changes), delete, primary field.
//! All require the Creator role on the base.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{patch, post};
use axum::{Json, Router};
use ob_core::api::schema::{
    DeleteFieldResponse, FormulaCheck, FormulaCheckError, FormulaCheckResult, SetPrimaryField,
    Table,
};
use serde_json::{Value as Json2, json};

use crate::api::schema_support::publish_schema;
use crate::auth::Actor;
use crate::engine::recompute::{self, DEFAULT_MAX_EVALS, Session};
use crate::engine::write;
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::field_kind::{parse_create_field, parse_update_field};
use crate::store::fields::{self, FieldChange};
use crate::store::schema::{self, Touched};
use crate::store::{fields_engine, records, tables};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tables/{id}/formula/check", post(formula_check))
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
        serde_json::to_value(DeleteFieldResponse {
            ok: true,
            deleted_field_ids: out.deleted_field_ids,
        })
        .unwrap_or(Json2::Null),
    ))
}

/// `POST /api/tables/{id}/formula/check`: parse and type-check a formula as
/// typed in the field editor and preview it on a sample record. Editor role
/// (field creators need it, and it changes nothing).
async fn formula_check(
    State(state): State<AppState>,
    actor: Actor,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<FormulaCheck>,
) -> AppResult<Json<FormulaCheckResult>> {
    let result = state
        .db
        .read(move |conn| {
            let base = perm::base_of_table(conn, &table_id)?;
            perm::require_base(conn, &actor, &base, Role::Editor)?;
            let table_fields = schema::table_fields(conn, &table_id)?;
            let (stored, ty) = match fields_engine::check_formula(&table_fields, &body.expression) {
                Ok(ok) => ok,
                Err(e) => {
                    return Ok(FormulaCheckResult {
                        ok: false,
                        error: Some(FormulaCheckError {
                            message: e.message,
                            pos: e.pos,
                        }),
                        result_type: None,
                        preview: None,
                    });
                }
            };
            let row = match &body.record_id {
                Some(id) => Some(
                    records::get(conn, id)?
                        .filter(|r| r.table_id == table_id && r.deleted_at.is_none())
                        .ok_or_else(|| AppError::not_found("record"))?,
                ),
                None => {
                    let first = records::table_ids(conn, &table_id, false)?;
                    match first.first() {
                        Some(id) => records::get(conn, id)?,
                        None => None,
                    }
                }
            };
            let preview = match row {
                Some(row) => {
                    let tz = write::user_timezone(conn, &actor.user_id);
                    let mut session =
                        Session::new(conn, &base, chrono::Utc::now(), tz, DEFAULT_MAX_EVALS)?;
                    let value = session.preview(&stored, &ty, &row);
                    Some(recompute::stored_json(&value).unwrap_or(serde_json::Value::Null))
                }
                None => None,
            };
            Ok(FormulaCheckResult {
                ok: true,
                error: None,
                result_type: Some(ty),
                preview,
            })
        })
        .await?;
    Ok(Json(result))
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
