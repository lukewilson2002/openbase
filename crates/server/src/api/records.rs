//! Records API.
//!
//! Write endpoints (Editor role): `POST|PATCH|DELETE /api/tables/{id}/records`
//! (batch), `POST /api/tables/{id}/records/restore`,
//! `POST /api/tables/{id}/records/move`. All writes go through `engine::write`
//! in one transaction and events are published after it commits.
//!
//! Responses: create (201), update, restore and move answer
//! `RecordsResponse` (the affected records, in request order); delete answers
//! 204 (batches are all-or-nothing, so the request's ids are the deleted ids).
//!
//! Read endpoints (Viewer), backed by `engine::query`:
//! `POST /api/views/{id}/query`,
//! `POST /api/tables/{id}/aggregate` (group-by: count, sum, avg, min, max per group),
//! `GET /api/views/{id}/aggregations?timezone=&search=&transient=`,
//! `GET /api/tables/{id}/records/{rid}`,
//! `POST /api/tables/{id}/records/get` (several records by id: linked-record previews),
//! `GET /api/tables/{id}/records/lookup?q=&limit=&view_id=&fields=` (link picker) and
//! `GET /api/records/{id}/history?before=&limit=`.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use ob_core::api::records::{
    AggregateRequest, AggregateResponse, AggregationsResponse, CreateRecords, HistoryEntry,
    LinkCandidates, MoveRecords, QueryRequest, QueryResponse, Record, RecordIds, RecordsResponse,
    TransientConfig, UpdateRecords,
};
use serde::Deserialize;

use crate::api::schema_support::publish;
use crate::auth::Actor;
use crate::engine::query;
use crate::engine::write::{self, CreateOpts, WriteCtx, WriteOutcome, WriteSource};
use crate::error::{AppError, AppResult};
use crate::extract::{ApiJson, ApiQuery};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::{history, records as record_store};

/// Entries per history page unless the request says otherwise, and the cap.
const HISTORY_DEFAULT: usize = 50;
const HISTORY_MAX: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/tables/{id}/records",
            post(create).patch(update).delete(remove),
        )
        .route("/api/tables/{id}/records/restore", post(restore))
        .route("/api/tables/{id}/records/move", post(move_records))
        .route("/api/tables/{id}/records/lookup", get(lookup))
        .route("/api/tables/{id}/records/get", post(get_many))
        .route("/api/tables/{id}/records/{rid}", get(get_one))
        .route("/api/tables/{id}/aggregate", post(aggregate))
        .route("/api/views/{id}/query", post(query_view))
        .route("/api/views/{id}/aggregations", get(aggregations))
        .route("/api/records/{id}/history", get(record_history))
}

/// Publish the events of a committed write on behalf of `actor`.
pub fn publish_outcome(
    state: &AppState,
    headers: &HeaderMap,
    actor: &Actor,
    outcome: &WriteOutcome,
) {
    for event in outcome.events() {
        publish(state, headers, actor, &outcome.base_id, event);
    }
}

fn editor_ctx(tx: &rusqlite::Transaction, actor: &Actor, table_id: &str) -> AppResult<WriteCtx> {
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
                before_record_id: body.before_record_id,
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
) -> AppResult<StatusCode> {
    let who = actor.clone();
    let outcome = state
        .db
        .write(move |tx| {
            let ctx = editor_ctx(tx, &actor, &table_id)?;
            write::delete_records(tx, &ctx, &table_id, &body.ids)
        })
        .await?;
    publish_outcome(&state, &headers, &who, &outcome);
    Ok(StatusCode::NO_CONTENT)
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
) -> AppResult<Json<RecordsResponse>> {
    let who = actor.clone();
    let (outcome, records) = state
        .db
        .write(move |tx| {
            let ctx = editor_ctx(tx, &actor, &table_id)?;
            let outcome = write::move_records(tx, &ctx, &table_id, &body)?;
            // The moved records in the order they were asked for (duplicates
            // collapse to their first mention).
            let mut seen = std::collections::HashSet::new();
            let ids: Vec<String> = body
                .ids
                .iter()
                .filter(|id| seen.insert(id.as_str()))
                .cloned()
                .collect();
            let records = record_store::load_dtos(tx, &table_id, &ids, ctx.timezone)?;
            Ok((outcome, records))
        })
        .await?;
    publish_outcome(&state, &headers, &who, &outcome);
    Ok(Json(RecordsResponse { records }))
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
            let mut found =
                record_store::load_dtos(conn, &table_id, std::slice::from_ref(&record_id), tz)?;
            found.pop().ok_or_else(|| AppError::not_found("record"))
        })
        .await?;
    Ok(Json(record))
}

/// Most records one `POST /api/tables/{id}/records/get` reads.
pub const MAX_GET_IDS: usize = 100;

/// `POST /api/tables/{id}/records/get`: the records of the table with these ids, in the order
/// asked (linked-record previews). Ids that are not live records of the table are left out, so a
/// link to a record deleted a moment ago does not fail the rest.
async fn get_many(
    State(state): State<AppState>,
    actor: Actor,
    Path(table_id): Path<String>,
    ApiJson(req): ApiJson<RecordIds>,
) -> AppResult<Json<RecordsResponse>> {
    if req.ids.len() > MAX_GET_IDS {
        return Err(AppError::bad_request(format!(
            "at most {MAX_GET_IDS} ids per request"
        )));
    }
    let records = state
        .db
        .read(move |conn| {
            let base = perm::base_of_table(conn, &table_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            let tz = write::user_timezone(conn, &actor.user_id);
            record_store::load_dtos(conn, &table_id, &req.ids, tz)
        })
        .await?;
    Ok(Json(RecordsResponse { records }))
}

/// `POST /api/views/{id}/query`.
async fn query_view(
    State(state): State<AppState>,
    actor: Actor,
    Path(view_id): Path<String>,
    ApiJson(req): ApiJson<QueryRequest>,
) -> AppResult<Json<QueryResponse>> {
    let cache = state.query_cache.clone();
    let versions = state.events.versions().clone();
    let response = state
        .db
        .read(move |conn| {
            let base = perm::base_of_view(conn, &view_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            let view = query::visible_view(conn, &actor.user_id, &view_id)?;
            query::run_query(conn, &cache, &versions, &actor.user_id, &view, &req)
        })
        .await?;
    Ok(Json(response))
}

#[derive(Debug, Default, Deserialize)]
struct AggregationsParams {
    /// IANA zone for relative dates in the view filter.
    #[serde(default)]
    timezone: Option<String>,
    /// Summarise only records matching this search (same semantics as the
    /// `search` of a view query).
    #[serde(default)]
    search: Option<String>,
    /// JSON-encoded [`TransientConfig`]: a one-off filter override, never
    /// saved.
    #[serde(default)]
    transient: Option<String>,
}

/// The longest accepted `transient` query parameter.
const MAX_TRANSIENT_PARAM: usize = 16 * 1024;

fn parse_transient(raw: Option<&str>) -> AppResult<Option<TransientConfig>> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if raw.len() > MAX_TRANSIENT_PARAM {
        return Err(AppError::bad_request("the transient parameter is too long"));
    }
    serde_json::from_str(raw)
        .map(Some)
        .map_err(|e| AppError::bad_request(format!("invalid transient parameter: {e}")))
}

/// `POST /api/tables/{id}/aggregate`: group a table's records (optionally narrowed by a view
/// and/or a formula) and compute count, sum, avg, min and max per group. Viewer role.
async fn aggregate(
    State(state): State<AppState>,
    actor: Actor,
    Path(table_id): Path<String>,
    ApiJson(body): ApiJson<AggregateRequest>,
) -> AppResult<Json<AggregateResponse>> {
    let cache = state.query_cache.clone();
    let versions = state.events.versions().clone();
    let response = state
        .db
        .read(move |conn| {
            let base = perm::base_of_table(conn, &table_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            crate::v1::aggregate::aggregate_in(
                conn, &cache, &versions, &actor, &base, &table_id, body,
            )
            .map_err(crate::v1::aggregate::app_error)
        })
        .await?;
    Ok(Json(response))
}

/// `GET /api/views/{id}/aggregations?timezone=&search=&transient=`.
async fn aggregations(
    State(state): State<AppState>,
    actor: Actor,
    Path(view_id): Path<String>,
    ApiQuery(params): ApiQuery<AggregationsParams>,
) -> AppResult<Json<AggregationsResponse>> {
    let transient = parse_transient(params.transient.as_deref())?;
    let response = state
        .db
        .read(move |conn| {
            let base = perm::base_of_view(conn, &view_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            let view = query::visible_view(conn, &actor.user_id, &view_id)?;
            let opts = query::AggregationOpts {
                timezone: params.timezone.as_deref(),
                search: params.search.as_deref(),
                transient: transient.as_ref(),
            };
            query::run_aggregations(conn, &actor.user_id, &view, &opts)
        })
        .await?;
    Ok(Json(response))
}

#[derive(Debug, Default, Deserialize)]
struct LookupParams {
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    /// Restrict candidates to the filter of this view of the table (the link
    /// field's picker view).
    #[serde(default)]
    view_id: Option<String>,
    /// Comma-separated ids of other fields whose text `q` also matches (the fields the picker
    /// shows under each record's name). Unknown ids are ignored.
    #[serde(default)]
    fields: Option<String>,
}

/// `GET /api/tables/{id}/records/lookup`: link picker candidates.
async fn lookup(
    State(state): State<AppState>,
    actor: Actor,
    Path(table_id): Path<String>,
    ApiQuery(params): ApiQuery<LookupParams>,
) -> AppResult<Json<LinkCandidates>> {
    let records = state
        .db
        .read(move |conn| {
            let base = perm::base_of_table(conn, &table_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            let not_a_view = || AppError::bad_request("view_id is not a view of this table");
            let view = match params.view_id.as_deref().filter(|v| !v.is_empty()) {
                Some(view_id) => {
                    let view = query::visible_view(conn, &actor.user_id, view_id)
                        .map_err(|_| not_a_view())?;
                    if view.view.table_id != table_id {
                        return Err(not_a_view());
                    }
                    Some(view)
                }
                None => None,
            };
            let limit = params
                .limit
                .unwrap_or(query::DEFAULT_LOOKUP_LIMIT)
                .min(query::MAX_LOOKUP_LIMIT);
            let also: Vec<String> = params
                .fields
                .as_deref()
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect();
            query::lookup_candidates(
                conn,
                &actor.user_id,
                &table_id,
                params.q.as_deref().unwrap_or_default(),
                limit,
                view.as_ref(),
                &also,
            )
        })
        .await?;
    Ok(Json(LinkCandidates { records }))
}

#[derive(Debug, Default, Deserialize)]
struct HistoryParams {
    /// Id of the last entry of the previous page.
    #[serde(default)]
    before: Option<i64>,
    #[serde(default)]
    limit: Option<usize>,
}

/// `GET /api/records/{id}/history`: newest first, paged by entry id.
async fn record_history(
    State(state): State<AppState>,
    actor: Actor,
    Path(record_id): Path<String>,
    ApiQuery(params): ApiQuery<HistoryParams>,
) -> AppResult<Json<Vec<HistoryEntry>>> {
    let entries = state
        .db
        .read(move |conn| {
            let base = perm::base_of_record(conn, &record_id)?;
            perm::require_base(conn, &actor, &base, Role::Viewer)?;
            let limit = params
                .limit
                .unwrap_or(HISTORY_DEFAULT)
                .clamp(1, HISTORY_MAX);
            let tz = write::user_timezone(conn, &actor.user_id);
            let mut entries = history::list_page(conn, &record_id, params.before, limit)?;
            history::resolve_link_names(conn, &record_id, &mut entries, tz)?;
            Ok(entries)
        })
        .await?;
    Ok(Json(entries))
}
