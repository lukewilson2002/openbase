//! Workspaces and their members. Creating, renaming, deleting and managing members is for
//! signed-in users, or API tokens with the `manage` permission and no base restriction
//! (`perm::require_workspace`). Listing workspaces works with any token, limited to the bases
//! the token can reach.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch};
use axum::{Json, Router};
use ob_core::api::events::BaseEvent;
use ob_core::api::workspaces::{
    CreateWorkspace, Member, UpdateMember, UpdateWorkspace, WorkspaceSummary,
};
use rusqlite::Connection;

use crate::api::schema_support::{ok, publish};
use crate::auth::{Actor, Capability};
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
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
            patch(update_member).delete(remove_member),
        )
}

/// The workspaces `actor` can see. A signed-in user sees everything; an API token only the
/// bases its scope reaches (a base-limited token sees just the workspaces holding them), with
/// roles capped the way `perm::require_base` caps them (read-only tokens act as Viewer).
pub fn visible_workspaces(conn: &Connection, actor: &Actor) -> AppResult<Vec<WorkspaceSummary>> {
    let all = workspaces::list_for_user(conn, &actor.user_id)?;
    let Some(scope) = &actor.token_scope else {
        return Ok(all);
    };
    let mut out = Vec::new();
    for mut ws in all {
        ws.bases.retain_mut(
            |b| match perm::require_base(conn, actor, &b.id, Role::Viewer) {
                Ok(role) => {
                    b.role = role.as_str().to_string();
                    true
                }
                Err(_) => false,
            },
        );
        if !scope.write {
            ws.role = Role::Viewer.as_str().to_string();
        }
        if scope.base_ids.is_some() && ws.bases.is_empty() {
            continue;
        }
        out.push(ws);
    }
    Ok(out)
}

async fn list(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<Vec<WorkspaceSummary>>> {
    let out = state
        .db
        .read(move |c| visible_workspaces(c, &actor))
        .await?;
    Ok(Json(out))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    ApiJson(body): ApiJson<CreateWorkspace>,
) -> AppResult<(StatusCode, Json<WorkspaceSummary>)> {
    actor.require_capability(Capability::ManageUnscoped)?;
    let out = state
        .db
        .write(move |tx| workspaces::create(tx, &actor.user_id, &body))
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
            workspaces::set_icon(tx, &id, &body.icon)?;
            if let Some(color) = &body.color {
                workspaces::set_color(tx, &id, color)?;
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
            let mut members = workspaces::members(c, &id)?;
            hide_unopenable_bases(c, &actor, &id, &mut members)?;
            Ok(members)
        })
        .await?;
    Ok(Json(out))
}

/// Trim each member's `base_ids` to the bases the caller can open, unless
/// the caller owns the workspace (with a session or an unrestricted token).
/// Otherwise a member limited to one base would learn the ids of bases they
/// were never given, and which colleagues can open them.
pub fn hide_unopenable_bases(
    conn: &Connection,
    actor: &Actor,
    workspace_id: &str,
    members: &mut [Member],
) -> AppResult<()> {
    let unrestricted = actor
        .token_scope
        .as_ref()
        .is_none_or(|s| s.base_ids.is_none());
    if unrestricted
        && perm::workspace_role(conn, &actor.user_id, workspace_id)? == Some(Role::Owner)
    {
        return Ok(());
    }
    let mut openable = std::collections::HashMap::new();
    for m in members.iter_mut() {
        let mut kept = Vec::with_capacity(m.base_ids.len());
        for b in m.base_ids.drain(..) {
            let ok = match openable.get(&b) {
                Some(ok) => *ok,
                None => {
                    let ok = perm::require_base(conn, actor, &b, Role::Viewer).is_ok();
                    openable.insert(b.clone(), ok);
                    ok
                }
            };
            if ok {
                kept.push(b);
            }
        }
        m.base_ids = kept;
    }
    Ok(())
}

/// Change a member's role and/or which bases they can open. Everyone's
/// streams on the workspace's bases are told, so a member who lost a base has
/// their stream closed by the access re-check.
async fn update_member(
    State(state): State<AppState>,
    actor: Actor,
    headers: HeaderMap,
    Path((id, user_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<UpdateMember>,
) -> AppResult<Json<serde_json::Value>> {
    if body.role.is_none() && body.all_bases.is_none() && body.base_ids.is_none() {
        return Err(AppError::bad_request(
            "give a new role, all_bases or base_ids",
        ));
    }
    let who = actor.clone();
    let change = workspaces::MemberChange {
        role: body.role.as_deref().map(Role::parse).transpose()?,
        all_bases: body.all_bases,
        base_ids: body.base_ids,
    };
    let bases = state
        .db
        .write(move |tx| {
            perm::require_workspace(tx, &actor, &id, Role::Owner)?;
            workspaces::update_member(tx, &id, &user_id, change)?;
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
