//! Bases: create, schema, update, delete, duplicate, sharing.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use ob_core::api::events::BaseEvent;
use ob_core::api::schema::BaseSchema;
use ob_core::api::workspaces::{
    Collaborator, CreateBase, DuplicateBase, Member, UpdateBase, UpdateMember,
};

use crate::api::schema_support::{OptionalJson, ok, publish};
use crate::auth::{Actor, Capability};
use crate::error::AppResult;
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::bases;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces/{id}/bases", post(create))
        .route("/api/bases/{id}", get(schema).patch(update).delete(remove))
        .route("/api/bases/{id}/duplicate", post(duplicate))
        .route("/api/bases/{id}/collaborators", get(collaborators))
        .route("/api/bases/{id}/members", get(list_members))
        .route(
            "/api/bases/{id}/members/{user_id}",
            patch(set_member_role).delete(remove_member),
        )
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    Path(workspace_id): Path<String>,
    ApiJson(body): ApiJson<CreateBase>,
) -> AppResult<(StatusCode, Json<BaseSchema>)> {
    let out = state
        .db
        .write(move |tx| {
            perm::require_workspace_for_content(tx, &actor, &workspace_id, Role::Creator)?;
            let base = bases::create(tx, &workspace_id, &body, &actor.user_id)?;
            let role = perm::require_base(tx, &actor, &base.id, Role::Viewer)?;
            bases::schema(tx, &base, &actor.user_id, role)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(out)))
}

async fn schema(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<BaseSchema>> {
    let out = state
        .db
        .read(move |c| {
            let role = perm::require_base(c, &actor, &id, Role::Viewer)?;
            let base = bases::live_base(c, &id)?;
            bases::schema(c, &base, &actor.user_id, role)
        })
        .await?;
    Ok(Json(out))
}

async fn update(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpdateBase>,
) -> AppResult<Json<BaseSchema>> {
    let who = actor.clone();
    let base_id = id.clone();
    let out = state
        .db
        .write(move |tx| {
            let role = perm::require_base(tx, &actor, &id, Role::Creator)?;
            let base = bases::update(tx, &id, &body)?;
            bases::schema(tx, &base, &actor.user_id, role)
        })
        .await?;
    publish(&state, &headers, &who, &base_id, BaseEvent::BaseChanged);
    Ok(Json(out))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    actor.require_capability(Capability::Manage)?;
    let who = actor.clone();
    let base_id = id.clone();
    state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &id, Role::Owner)?;
            bases::soft_delete(tx, &id)
        })
        .await?;
    publish(&state, &headers, &who, &base_id, BaseEvent::BaseChanged);
    Ok(ok())
}

/// Needs the Creator role on the source base and on its workspace.
async fn duplicate(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
    OptionalJson(body): OptionalJson<DuplicateBaseBody>,
) -> AppResult<(StatusCode, Json<BaseSchema>)> {
    actor.require_capability(Capability::Manage)?;
    let req: DuplicateBase = body.into();
    let out = state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &id, Role::Creator)?;
            let source = bases::live_base(tx, &id)?;
            perm::require_workspace(tx, &actor, &source.workspace_id, Role::Creator)?;
            let copy = bases::duplicate(tx, &id, &req, &actor.user_id)?;
            let role = perm::require_base(tx, &actor, &copy.id, Role::Viewer)?;
            bases::schema(tx, &copy, &actor.user_id, role)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(out)))
}

/// `DuplicateBase` with every field optional (the body itself may be omitted).
#[derive(Debug, Default, serde::Deserialize)]
struct DuplicateBaseBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    include_records: bool,
}

impl From<DuplicateBaseBody> for DuplicateBase {
    fn from(b: DuplicateBaseBody) -> Self {
        DuplicateBase {
            name: b.name,
            include_records: b.include_records,
        }
    }
}

async fn collaborators(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<Collaborator>>> {
    let out = state
        .db
        .read(move |c| {
            perm::require_base(c, &actor, &id, Role::Viewer)?;
            let base = bases::live_base(c, &id)?;
            bases::collaborators(c, &base)
        })
        .await?;
    Ok(Json(out))
}

async fn list_members(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<Member>>> {
    actor.require_capability(Capability::Manage)?;
    let out = state
        .db
        .read(move |c| {
            perm::require_base(c, &actor, &id, Role::Owner)?;
            bases::members(c, &id)
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
    actor.require_capability(Capability::Manage)?;
    let role = Role::parse(&body.role)?;
    let who = actor.clone();
    let base_id = id.clone();
    state
        .db
        .write(move |tx| {
            perm::require_base(tx, &actor, &id, Role::Owner)?;
            bases::set_member_role(tx, &id, &user_id, role)
        })
        .await?;
    publish(&state, &headers, &who, &base_id, BaseEvent::BaseChanged);
    Ok(ok())
}

/// Owners remove members; a member may also remove themself.
async fn remove_member(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path((id, user_id)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    actor.require_capability(Capability::Manage)?;
    let who = actor.clone();
    let base_id = id.clone();
    state
        .db
        .write(move |tx| {
            let min = if user_id == actor.user_id {
                Role::Viewer
            } else {
                Role::Owner
            };
            perm::require_base(tx, &actor, &id, min)?;
            bases::remove_member(tx, &id, &user_id)
        })
        .await?;
    publish(&state, &headers, &who, &base_id, BaseEvent::BaseChanged);
    Ok(ok())
}
