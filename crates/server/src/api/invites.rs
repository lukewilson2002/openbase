//! `invites` API: invite links to a workspace, created by its owners (any
//! role, any bases) or from a base by its creators (limited to bases they can
//! open, never all bases, never above their own role); listing and revoking
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
use crate::store::invites::{self, InviteRow};
use crate::store::workspaces::{self, BaseAccess};
use crate::store::{bases, users};

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

/// Where an invite is being created from. Either way it is a workspace
/// invite; the origin decides who may create it and the default bases.
enum Origin {
    Workspace(String),
    Base(String),
}

/// Check the actor may create this invite and work out its workspace and
/// base access. Returns the workspace id, the highest role the actor may
/// grant and the access the invite gives.
fn authorize_create(
    conn: &Connection,
    actor: &Actor,
    origin: &Origin,
    role: Role,
    req: &CreateInviteRequest,
) -> AppResult<(String, Role, BaseAccess)> {
    match origin {
        Origin::Workspace(w) => {
            // `require_workspace` asks for the `manage` permission itself.
            let max = perm::require_workspace(conn, actor, w, Role::Owner)?;
            let access = if role == Role::Owner {
                BaseAccess::All
            } else {
                match (req.all_bases, &req.base_ids) {
                    (Some(true), _) | (None, None) => BaseAccess::All,
                    (_, Some(ids)) => {
                        BaseAccess::Only(workspaces::validate_base_ids(conn, w, ids)?)
                    }
                    (Some(false), None) => {
                        return Err(AppError::bad_request(
                            "pick the bases the invitee can open (base_ids), or give all bases",
                        ));
                    }
                }
            };
            Ok((w.clone(), max, access))
        }
        Origin::Base(b) => {
            actor.require_capability(Capability::Manage)?;
            let max = perm::require_base(conn, actor, b, Role::Creator)?;
            let ws = bases::live_base(conn, b)?.workspace_id;
            if req.all_bases == Some(true) && max < Role::Owner {
                return Err(AppError::forbidden(
                    "only workspace owners can invite someone to every base",
                ));
            }
            if role == Role::Owner || req.all_bases == Some(true) {
                return Ok((ws, max, BaseAccess::All));
            }
            let ids = req.base_ids.clone().unwrap_or_else(|| vec![b.clone()]);
            let ids = workspaces::validate_base_ids(conn, &ws, &ids)?;
            for id in &ids {
                // A creator can only hand out bases they can open themselves.
                perm::require_base(conn, actor, id, Role::Creator)?;
            }
            Ok((ws, max, BaseAccess::Only(ids)))
        }
    }
}

/// Owners of the workspace manage all its invites; a creator manages the
/// invites limited to bases they can open, at a role not above their own.
/// Without any role in the workspace this is a 404, like a missing invite.
fn require_manage_invite(conn: &Connection, actor: &Actor, invite: &InviteRow) -> AppResult<()> {
    actor.require_capability(Capability::Manage)?;
    let ws = invite.workspace_id()?;
    if perm::workspace_role(conn, &actor.user_id, ws)?.is_none() {
        return Err(AppError::not_found("invite"));
    }
    match perm::require_workspace(conn, actor, ws, Role::Owner) {
        Ok(_) => return Ok(()),
        // Only owners manage invites to every base; their error says why
        // (the role, or a token limited to specific bases).
        Err(e) if invite.info.all_bases => return Err(e),
        Err(_) => {}
    }
    let mut max = Role::Owner;
    for b in &invite.info.base_ids {
        if bases::live_base(conn, b).is_err() {
            continue;
        }
        max = max.min(perm::require_base(conn, actor, b, Role::Creator)?);
    }
    if invite.role()? > max {
        return Err(AppError::forbidden(
            "you cannot revoke an invite for a role above your own",
        ));
    }
    Ok(())
}

fn workspace_name(conn: &Connection, workspace_id: &str) -> AppResult<String> {
    Ok(conn
        .query_row(
            "SELECT name FROM workspaces WHERE id = ?1",
            [workspace_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default())
}

async fn create_invite(
    state: AppState,
    actor: Actor,
    client: ClientInfo,
    origin: Origin,
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
            let (ws, max_role, access) = authorize_create(tx, &actor, &origin, role, &req)?;
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
                invites::create(tx, &actor.user_id, &ws, email.as_deref(), role, &access)?;
            audit::record_as(
                tx,
                &actor,
                actions::INVITE_CREATE,
                Some(&info.id),
                Some(json!({
                    "workspace_id": info.workspace_id,
                    "email": info.email,
                    "role": info.role,
                    "all_bases": info.all_bases,
                    "base_ids": info.base_ids,
                })),
                Some(&client.ip),
            )?;
            Ok((token, info, workspace_name(tx, &ws)?))
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
    create_invite(state, actor, client, Origin::Workspace(id), req).await
}

async fn create_base(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
    ApiJson(req): ApiJson<CreateInviteRequest>,
) -> AppResult<(StatusCode, Json<CreatedInvite>)> {
    create_invite(state, actor, client, Origin::Base(id), req).await
}

async fn list_workspace(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<InviteInfo>>> {
    let list = state
        .db
        .read(move |c| {
            perm::require_workspace(c, &actor, &id, Role::Owner)?;
            invites::list_for_workspace(c, &id)
        })
        .await?;
    Ok(Json(list))
}

/// Pending invites that would give access to this base.
async fn list_base(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<Vec<InviteInfo>>> {
    actor.require_capability(Capability::Manage)?;
    let list = state
        .db
        .read(move |c| {
            perm::require_base(c, &actor, &id, Role::Creator)?;
            invites::list_for_base(c, &id)
        })
        .await?;
    Ok(Json(list))
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
            require_manage_invite(tx, &actor, &invite)?;
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
