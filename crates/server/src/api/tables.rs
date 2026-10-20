//! Tables: create, rename/reorder, delete, duplicate.

use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{patch, post};
use axum::{Json, Router};
use ob_core::api::schema::{CreateTable, DuplicateTable, Table, UpdateTable};
use ob_core::api::workspaces::Reorder;
use ob_core::limits;

use crate::api::schema_support::{OptionalJson, ok, publish_schema};
use crate::auth::Actor;
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::field_kind::parse_create_field;
use crate::store::fields;
use crate::store::schema::{self, PositionScope, Touched};
use crate::store::tables;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/bases/{id}/tables", post(create))
        .route("/api/bases/{id}/tables/reorder", post(reorder))
        .route("/api/tables/{id}", patch(update).delete(remove))
        .route("/api/tables/{id}/duplicate", post(duplicate))
}

/// Point a lookup/rollup/count's `link_field_id` (and the `fields` watched by a
/// last-modified field) at fields created earlier in the same request when they
/// are given by name.
fn resolve_batch_refs(def: &mut serde_json::Value, created: &HashMap<String, String>) {
    let Some(options) = def.get_mut("options").and_then(|o| o.as_object_mut()) else {
        return;
    };
    let swap = |v: &mut serde_json::Value| {
        if let serde_json::Value::String(s) = v
            && let Some(id) = created.get(&s.trim().to_lowercase())
        {
            *s = id.clone();
        }
    };
    if let Some(v) = options.get_mut("link_field_id") {
        swap(v);
    }
    if let Some(serde_json::Value::Array(items)) = options.get_mut("fields") {
        items.iter_mut().for_each(swap);
    }
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(base_id): Path<String>,
    ApiJson(body): ApiJson<CreateTable>,
) -> AppResult<(StatusCode, Json<Table>)> {
    // Check every field definition's shape before touching the database, so a
    // malformed one names itself and nothing is created.
    let raw_fields = body.fields.clone().unwrap_or_default();
    if raw_fields.len() >= limits::MAX_FIELDS_PER_TABLE {
        return Err(AppError::bad_request(format!(
            "a table can have at most {} fields (the primary field counts)",
            limits::MAX_FIELDS_PER_TABLE
        )));
    }
    for (i, f) in raw_fields.iter().enumerate() {
        parse_field_def(f).map_err(|e| field_error(i, f, e))?;
    }
    let who = actor.clone();
    let base = base_id.clone();
    let (table, touched) = state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &base_id, Role::Creator)?;
            let row = tables::create(
                tx,
                &base_id,
                &body.name,
                body.icon.as_deref(),
                &actor.user_id,
            )?;
            // The transaction rolls back on the first error: all or nothing.
            let mut touched = Touched::of(&row.id);
            let mut created: HashMap<String, String> = HashMap::from([(
                tables::PRIMARY_FIELD_NAME.to_lowercase(),
                row.primary_field_id.clone(),
            )]);
            for (i, mut f) in raw_fields.into_iter().enumerate() {
                resolve_batch_refs(&mut f, &created);
                let input = parse_field_def(&f).map_err(|e| field_error(i, &f, e))?;
                let change =
                    fields::create(tx, &row.id, &input).map_err(|e| field_error(i, &f, e))?;
                created.insert(input.name.trim().to_lowercase(), change.field.id.clone());
                for t in &change.touched.0 {
                    touched.add(t);
                }
            }
            Ok((tables::to_dto(tx, &row, &actor.user_id)?, touched))
        })
        .await?;
    publish_schema(&state, &headers, &who, &base, &touched);
    Ok((StatusCode::CREATED, Json(table)))
}

/// Parse one entry of `fields`. A type without options (`{"name": "Qty", "type": "number"}`)
/// takes its default options, which `POST /api/tables/{id}/fields` would require spelled out.
fn parse_field_def(def: &serde_json::Value) -> AppResult<ob_core::api::schema::CreateField> {
    let mut def = def.clone();
    if let Some(obj) = def.as_object_mut() {
        obj.entry("options")
            .or_insert_with(|| serde_json::json!({}));
    }
    parse_create_field(def)
}

/// Say which entry of `fields` an error belongs to.
fn field_error(index: usize, def: &serde_json::Value, e: AppError) -> AppError {
    let name = def
        .get("name")
        .and_then(|n| n.as_str())
        .map(|n| format!(" '{n}'"))
        .unwrap_or_default();
    let prefix = format!("fields[{index}]{name}: ");
    match e {
        AppError::BadRequest(m) => AppError::BadRequest(format!("{prefix}{m}")),
        AppError::Conflict(m) => AppError::Conflict(format!("{prefix}{m}")),
        AppError::NotFound(m) => AppError::BadRequest(format!("{prefix}{m} not found")),
        other => other,
    }
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
            Ok((base, tables::soft_delete(tx, &id, &actor.user_id)?))
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

/// Reorder the tables of a base: the listed tables take the places they held, in the given
/// order; every other table keeps its place.
async fn reorder(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(base_id): Path<String>,
    ApiJson(body): ApiJson<Reorder>,
) -> AppResult<Json<serde_json::Value>> {
    let who = actor.clone();
    let id = base_id.clone();
    let changed = state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &id, Role::Creator)?;
            schema::reorder_siblings(tx, PositionScope::TablesIn(&id), &body.ids, |_| Ok(()))
                .map(|changed| changed.then_some(body.ids))
        })
        .await?;
    if let Some(ids) = changed {
        // Several tables changed place: subscribers refetch the whole base.
        publish_schema(&state, &headers, &who, &base_id, &Touched(ids));
    }
    Ok(ok())
}
