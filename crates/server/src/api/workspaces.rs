//! Workspaces and their members. Session-authenticated only: API tokens
//! never manage workspaces (`perm::require_workspace` rejects them).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch};
use axum::{Json, Router};
use og_core::api::events::BaseEvent;
use og_core::api::workspaces::{
    CreateWorkspace, Member, UpdateMember, UpdateWorkspace, WorkspaceSummary,
};

use crate::api::schema_support::{ok, publish, require_session};
use crate::extract::ApiJson;
use crate::auth::Actor;
use crate::error::{AppError, AppResult};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::workspaces;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces", get(list).post(create))
        .route("/api/workspaces/{id}", patch(rename).delete(remove))
        .route("/api/workspaces/{id}/members", get(list_members))
        .route(
            "/api/workspaces/{id}/members/{user_id}",
            patch(set_member_role).delete(remove_member),
        )
}

async fn list(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<Vec<WorkspaceSummary>>> {
    require_session(&actor)?;
    let user_id = actor.user_id;
    let out = state
        .db
        .read(move |c| workspaces::list_for_user(c, &user_id))
        .await?;
    Ok(Json(out))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ApiJson(body): ApiJson<CreateWorkspace>,
) -> AppResult<(StatusCode, Json<WorkspaceSummary>)> {
    require_session(&actor)?;
    let out = state
        .db
        .write(move |tx| workspaces::create(tx, &actor.user_id, &body.name))
        .await?;
    Ok((StatusCode::CREATED, Json(out)))
}

async fn rename(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateWorkspace>,
) -> AppResult<Json<WorkspaceSummary>> {
    let out = state
        .db
        .write(move |tx| {
            perm::require_workspace(tx, &actor, &id, Role::Owner)?;
            if let Some(name) = &body.name {
                workspaces::rename(tx, &id, name)?;
            }
            workspaces::list_for_user(tx, &actor.user_id)?
                .into_iter()
                .find(|w| w.id == id)
                .ok_or_else(|| AppError::not_found("workspace"))
        })
        .await?;
    Ok(Json(out))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let who = actor.clone();
    let bases = state
        .db
        .write(move |tx| {
            perm::require_workspace(tx, &actor, &id, Role::Owner)?;
            let bases = workspaces::base_ids(tx, &id)?;
            workspaces::soft_delete(tx, &id)?;
            Ok(bases)
        })
        .await?;
    for base in bases {
        publish(&state, &headers, &who, &base, BaseEvent::BaseChanged);
    }
    Ok(ok())
}

async fn list_members(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<Member>>> {
    let out = state
        .db
        .read(move |c| {
            perm::require_workspace(c, &actor, &id, Role::Viewer)?;
            workspaces::members(c, &id)
        })
        .await?;
    Ok(Json(out))
}

async fn set_member_role(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path((id, user_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateMember>,
) -> AppResult<Json<serde_json::Value>> {
    let who = actor.clone();
    let role = Role::parse(&body.role)?;
    let bases = state
        .db
        .write(move |tx| {
            perm::require_workspace(tx, &actor, &id, Role::Owner)?;
            workspaces::set_member_role(tx, &id, &user_id, role)?;
            workspaces::base_ids(tx, &id)
        })
        .await?;
    for base in bases {
        publish(&state, &headers, &who, &base, BaseEvent::BaseChanged);
    }
    Ok(ok())
}

/// Owners remove members; anyone may remove themself (leave).
async fn remove_member(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path((id, user_id)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let who = actor.clone();
    let bases = state
        .db
        .write(move |tx| {
            let min = if user_id == actor.user_id {
                Role::Viewer
            } else {
                Role::Owner
            };
            perm::require_workspace(tx, &actor, &id, min)?;
            workspaces::remove_member(tx, &id, &user_id)?;
            workspaces::base_ids(tx, &id)
        })
        .await?;
    for base in bases {
        publish(&state, &headers, &who, &base, BaseEvent::BaseChanged);
    }
    Ok(ok())
}
