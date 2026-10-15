//! Trash: list what was deleted and restore it.
//!
//! `GET /api/trash` lists everything the caller could restore, across every
//! workspace they belong to; the per-base and per-workspace listings and the
//! deleted-workspaces listing are narrower views of it with their own role
//! checks. Item-level restore (`POST /api/trash/restore`) authorizes by the
//! kind of item; see `store::trash::authorize`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use ob_core::api::events::BaseEvent;
use ob_core::api::records::{RestoreRequest, RestoreResponse, TrashListing};
use serde::Deserialize;

use crate::api::schema_support::{publish, publish_schema};
use crate::auth::{Actor, Capability};
use crate::error::AppResult;
use crate::extract::{ApiJson, ApiQuery};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::trash;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/trash", get(all_trash))
        .route("/api/bases/{id}/trash", get(base_trash))
        .route("/api/workspaces/{id}/trash", get(workspace_trash))
        .route("/api/trash/workspaces", get(deleted_workspaces))
        .route("/api/trash/restore", post(restore))
}

/// Optional narrowing of `GET /api/trash`; empty values count as absent so a
/// client can always send every parameter.
#[derive(Debug, Deserialize)]
struct TrashQuery {
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(default)]
    base_id: Option<String>,
    /// workspace | base | table | field | view | record
    #[serde(default)]
    kind: Option<String>,
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

async fn all_trash(
    State(state): State<AppState>,
    actor: Actor,
    ApiQuery(q): ApiQuery<TrashQuery>,
) -> AppResult<Json<TrashListing>> {
    let filter = trash::Filter {
        workspace_id: non_empty(q.workspace_id),
        base_id: non_empty(q.base_id),
        kind: non_empty(q.kind)
            .as_deref()
            .map(trash::Kind::parse)
            .transpose()?,
    };
    let retention = trash::retention_ms(state.config.trash_days);
    let out = state
        .db
        .read(move |c| trash::list_all(c, &actor, &filter, retention))
        .await?;
    Ok(Json(out))
}

async fn base_trash(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<TrashListing>> {
    let retention = trash::retention_ms(state.config.trash_days);
    let out = state
        .db
        .read(move |c| {
            perm::require_base(c, &actor, &id, Role::Creator)?;
            trash::list_base(c, &id, &actor.user_id, retention)
        })
        .await?;
    Ok(Json(out))
}

async fn workspace_trash(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<TrashListing>> {
    let retention = trash::retention_ms(state.config.trash_days);
    let out = state
        .db
        .read(move |c| {
            perm::require_workspace(c, &actor, &id, Role::Owner)?;
            trash::list_workspace(c, &id, retention)
        })
        .await?;
    Ok(Json(out))
}

/// The caller's own deleted workspaces (they must be an owner), for restoring.
async fn deleted_workspaces(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<TrashListing>> {
    actor.require_capability(Capability::ManageUnscoped)?;
    let retention = trash::retention_ms(state.config.trash_days);
    let out = state
        .db
        .read(move |c| trash::list_deleted_workspaces(c, &actor.user_id, retention))
        .await?;
    Ok(Json(out))
}

async fn restore(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    ApiJson(body): ApiJson<RestoreRequest>,
) -> AppResult<Json<RestoreResponse>> {
    let who = actor.clone();
    let restored = state
        .db
        .write(move |tx| {
            let target = trash::authorize(tx, &actor, &body.kind, &body.id)?;
            trash::restore(tx, &target, Some(&actor.user_id))
        })
        .await?;
    if let Some(outcome) = &restored.records {
        crate::api::records::publish_outcome(&state, &headers, &who, outcome);
    }
    for base in &restored.base_ids {
        if let Some(touched) = &restored.schema {
            publish_schema(&state, &headers, &who, base, touched);
        }
        if restored.base_changed {
            publish(&state, &headers, &who, base, BaseEvent::BaseChanged);
        }
    }
    Ok(Json(RestoreResponse {
        ok: true,
        restored_field_ids: restored.restored_field_ids,
    }))
}
