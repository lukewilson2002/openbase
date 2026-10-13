//! `invites` API: invite links to a workspace (workspace Owner) or a base
//! (base Creator, never above the inviter's own role), listing and revoking
//! them, a public preview by token, and accepting as a signed-in user.
//! New users accept by signing up with `invite_token` (see `api::auth`).

use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use ob_core::api::auth::{CreateInviteRequest, CreatedInvite, InviteInfo, InvitePreview};
use rusqlite::{Connection, OptionalExtension};
use serde_json::json;

use crate::auth::{Actor, Capability, ClientInfo};
use crate::email;
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::invites::{self, InviteTarget};
use crate::store::users;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/workspaces/{id}/invites",
            get(list_workspace).post(create_workspace),
        )
        .route("/api/bases/{id}/invites", get(list_base).post(create_base))
        .route("/api/invites/{id}", delete(revoke))
        .route("/api/invites/by-token/{token}", get(preview))
        .route("/api/invites/by-token/{token}/accept", post(accept))
}

/// Check the actor may manage invites for `target`; returns the highest role
/// they may grant.
fn require_manage(conn: &Connection, actor: &Actor, target: &InviteTarget) -> AppResult<Role> {
    match target {
        // `require_workspace` asks for the `manage` permission itself.
        InviteTarget::Workspace(w) => perm::require_workspace(conn, actor, w, Role::Owner),
        InviteTarget::Base(b) => {
            actor.require_capability(Capability::Manage)?;
            perm::require_base(conn, actor, b, Role::Creator)
        }
    }
}

fn target_name(conn: &Connection, target: &InviteTarget) -> AppResult<String> {
    let (sql, id) = match target {
        InviteTarget::Workspace(w) => ("SELECT name FROM workspaces WHERE id = ?1", w),
        InviteTarget::Base(b) => ("SELECT name FROM bases WHERE id = ?1", b),
    };
    Ok(conn
        .query_row(sql, [id], |r| r.get::<_, String>(0))
        .optional()?
        .unwrap_or_default())
}

async fn create_invite(
    state: AppState,
    actor: Actor,
    client: ClientInfo,
    target: InviteTarget,
    req: CreateInviteRequest,
) -> AppResult<(StatusCode, Json<CreatedInvite>)> {
    let role = Role::parse(req.role.trim())?;
    let email = match req.email.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(e) => Some(users::normalize_email(e)?),
    };
    let inviter_name = actor.name.clone();
    let will_email = email.is_some() && state.email.enabled();
    let (limiter, config) = (state.limiter.clone(), state.config.clone());
    let (token, info, name) = state
        .db
        .write(move |tx| {
            let max_role = require_manage(tx, &actor, &target)?;
            if role > max_role {
                return Err(AppError::forbidden(
                    "you cannot invite someone with a role above your own",
                ));
            }
            if will_email {
                // The invitee's address and the text around it come from the
                // caller: keep invite emails inside the shared hourly budget
                // (charged only once the caller is known to be allowed to
                // invite, so outsiders cannot burn it; an error rolls the
                // invite back).
                crate::email::spend_budget(&limiter, &config, &actor.user_id, 1)?;
            }
            let (token, info) =
                invites::create(tx, &actor.user_id, &target, email.as_deref(), role)?;
            audit::record_as(
                tx,
                &actor,
                actions::INVITE_CREATE,
                Some(&info.id),
                Some(json!({
                    "workspace_id": info.workspace_id,
                    "base_id": info.base_id,
                    "email": info.email,
                    "role": info.role,
                })),
                Some(&client.ip),
            )?;
            Ok((token, info, target_name(tx, &target)?))
        })
        .await?;
    let url = invites::invite_url(&state.config.public_url, &token);
    if let (Some(to), true) = (&info.email, state.email.enabled()) {
        let body = format!(
            "Hi,\n\n{inviter_name} invited you to \"{name}\" on OpenBase as {role}.\n\
             Open this link within 7 days to accept:\n\n{url}\n",
            role = info.role,
        );
        email::send_in_background(
            state.mailer.clone(),
            to.clone(),
            format!("{inviter_name} invited you to {name} on OpenBase"),
            body,
        );
    }
    Ok((StatusCode::CREATED, Json(CreatedInvite { url, info })))
}

async fn create_workspace(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<CreateInviteRequest>,
) -> AppResult<(StatusCode, Json<CreatedInvite>)> {
    create_invite(state, actor, client, InviteTarget::Workspace(id), req).await
}

async fn create_base(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<CreateInviteRequest>,
) -> AppResult<(StatusCode, Json<CreatedInvite>)> {
    create_invite(state, actor, client, InviteTarget::Base(id), req).await
}

async fn list_invites(
    state: AppState,
    actor: Actor,
    target: InviteTarget,
) -> AppResult<Json<Vec<InviteInfo>>> {
    let list = state
        .db
        .read(move |c| {
            require_manage(c, &actor, &target)?;
            invites::list(c, &target)
        })
        .await?;
    Ok(Json(list))
}

async fn list_workspace(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<InviteInfo>>> {
    list_invites(state, actor, InviteTarget::Workspace(id)).await
}

async fn list_base(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<InviteInfo>>> {
    list_invites(state, actor, InviteTarget::Base(id)).await
}

async fn revoke(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    state
        .db
        .write(move |tx| {
            let invite = invites::get(tx, &id)?.ok_or_else(|| AppError::not_found("invite"))?;
            // Without any role on the target this is a 404, like a missing invite.
            let max_role = require_manage(tx, &actor, &invite.target()?)?;
            if invite.role()? > max_role {
                return Err(AppError::forbidden(
                    "you cannot revoke an invite for a role above your own",
                ));
            }
            invites::delete(tx, &id)?;
            audit::record_as(
                tx,
                &actor,
                actions::INVITE_REVOKE,
                Some(&id),
                None,
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn preview(
    State(state): State<AppState>,
    client: ClientInfo,
    Path(token): Path<String>,
) -> AppResult<Json<InvitePreview>> {
    state
        .limiter
        .check("invite_preview", &client.ip, 60, Duration::from_secs(60))?;
    let preview = state
        .db
        .read(move |c| {
            let invite = invites::require_valid_by_token(c, &token)?;
            invites::preview(c, &invite)
        })
        .await?;
    Ok(Json(preview))
}

async fn accept(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(token): Path<String>,
) -> AppResult<Json<InviteInfo>> {
    actor.require_capability(Capability::ManageUnscoped)?;
    let info = state
        .db
        .write(move |tx| {
            let invite = invites::require_valid_by_token(tx, &token)?;
            let info = invites::accept(tx, &invite, &actor.user_id, &actor.email)?;
            audit::record_as(
                tx,
                &actor,
                actions::INVITE_ACCEPT,
                Some(&info.id),
                None,
                Some(&client.ip),
            )?;
            Ok(info)
        })
        .await?;
    Ok(Json(info))
}
