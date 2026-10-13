//! Trash: list what was deleted and restore it.
//!
//! Item-level restore (`POST /api/trash/restore`) authorizes by the kind of
//! item; see `store::trash::authorize`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use og_core::api::events::BaseEvent;
use og_core::api::records::{RestoreRequest, TrashListing};
use serde_json::json;

use crate::api::schema_support::{ApiJson, publish, publish_schema};
use crate::auth::Actor;
use crate::error::AppResult;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::trash;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/bases/{id}/trash", get(base_trash))
        .route("/api/workspaces/{id}/trash", get(workspace_trash))
        .route("/api/trash/restore", post(restore))
}

async fn base_trash(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<TrashListing>> {
    let out = state
        .db
        .read(move |c| {
            perm::require_base(c, &actor, &id, Role::Creator)?;
            trash::list_base(c, &id, &actor.user_id)
        })
        .await?;
    Ok(Json(out))
}

async fn workspace_trash(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<TrashListing>> {
    let out = state
        .db
        .read(move |c| {
            perm::require_workspace(c, &actor, &id, Role::Owner)?;
            trash::list_workspace(c, &id)
        })
        .await?;
    Ok(Json(out))
}

async fn restore(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    ApiJson(body): ApiJson<RestoreRequest>,
) -> AppResult<Json<serde_json::Value>> {
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
    Ok(Json(
        json!({ "ok": true, "restored_field_ids": restored.restored_field_ids }),
    ))
}
