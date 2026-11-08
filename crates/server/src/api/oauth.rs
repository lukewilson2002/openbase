//! `oauth` API: the consent step of the OAuth flow and the "connected apps" lists.
//!
//! Everything here is session only: an API token (or an OAuth grant) can never approve an app,
//! list the connected apps or revoke one, otherwise an agent could hand itself more access. The
//! routes sit behind the CSRF guard like the rest of `/api`, so a cross-site page cannot approve
//! an app on a signed-in user's behalf. The protocol endpoints (`/oauth/*`) live in
//! [`crate::oauth`].

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use ob_core::api::oauth::{
    ConsentDecision, ConsentOutcome, ConsentRequest, GrantAccessUpdate, GrantInfo, access,
};
use serde_json::json;

use crate::auth::{Actor, Capability, ClientInfo, admin_guard};
use crate::error::{AppError, AppResult};
use crate::extract::ApiJson;
use crate::oauth::authorize::redirect_url;
use crate::oauth::redirect;
use crate::oauth::scope::{self, Access};
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::oauth as store;
use crate::store::tokens::validate_base_ids;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/oauth/requests/{id}", get(get_request))
        .route("/api/oauth/requests/{id}/decision", post(decide))
        .route("/api/oauth/grants", get(list_grants))
        .route(
            "/api/oauth/grants/{id}",
            delete(revoke_grant).patch(change_grant_access),
        )
        .route("/api/admin/oauth/grants", get(admin_list_grants))
        .route("/api/admin/oauth/grants/{id}", delete(admin_revoke_grant))
}

/// The highest level the user may choose for a request, the level preselected on the page, and
/// the level the app asked for.
///
/// - Every level is offered, whatever the app asked for: many assistants never ask for Full
///   control, and the person is the one who decides what an app gets. The ceiling is therefore
///   what the person could hand out themselves, that is, may create `manage` tokens (every
///   signed-in person may; a token or an OAuth grant never reaches this code, the endpoints are
///   session-only). It is a ceiling on the app's scope only: the app still acts as the person
///   and keeps their role in every workspace, so Full control never lifts a Viewer above Viewer.
/// - The preselected level is what the app asked for (Read only when it named no scope we know).
///   Anything above that is the person's own choice, made in the decision they post, and is
///   recorded as such in the audit log.
fn levels(actor: &Actor, req: &store::PendingRequest) -> (Access, Access, Option<Access>) {
    let asked = scope::max_requested(&req.scope);
    let mut max = Access::Manage;
    if actor.require_capability(Capability::Manage).is_err() {
        max = Access::Write;
    }
    (max, asked.unwrap_or(Access::Read).min(max), asked)
}

async fn get_request(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<ConsentRequest>> {
    actor.require_capability(Capability::SessionOnly)?;
    let info = state
        .db
        .read(move |c| {
            let Some(req) = store::request(c, &id)? else {
                return Err(AppError::not_found("authorization request"));
            };
            let client = store::client(c, &req.client_id)?
                .ok_or_else(|| AppError::not_found("authorization request"))?;
            let (max, default, asked) = levels(&actor, &req);
            Ok(ConsentRequest {
                id: req.id,
                client_id: client.id.clone(),
                impersonates: redirect::impersonated_product(&client.name, &req.redirect_uri)
                    .map(str::to_string),
                client_name: redirect::display_name(&client.name),
                client_source: client.source,
                redirect_host: redirect::host_label(&req.redirect_uri),
                loopback: redirect::is_loopback(&req.redirect_uri),
                trusted_host: redirect::trusted_host(&req.redirect_uri),
                redirect_uri: req.redirect_uri,
                requested_access: asked.map(|a| a.as_str().to_string()),
                max_access: max.as_str().to_string(),
                default_access: default.as_str().to_string(),
                expires_at: req.expires_at,
            })
        })
        .await?;
    Ok(Json(info))
}

async fn decide(
    State(state): State<AppState>,
    actor: Actor,
    client_info: ClientInfo,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ConsentDecision>,
) -> AppResult<Json<ConsentOutcome>> {
    actor.require_capability(Capability::SessionOnly)?;
    let issuer = state.config.oauth_issuer();
    let outcome = state
        .db
        .write(move |tx| {
            let Some(req) = store::request(tx, &id)? else {
                return Err(AppError::not_found("authorization request"));
            };
            let client = store::client(tx, &req.client_id)?
                .ok_or_else(|| AppError::not_found("authorization request"))?;
            let detail = json!({
                "client": redirect::display_name(&client.name),
                "client_id": client.id,
                "redirect_host": redirect::host_label(&req.redirect_uri),
            });
            let state_pair = req.state.as_deref().map(|s| ("state", s));
            let redirect_to = match body.decision.as_str() {
                "deny" => {
                    store::delete_request(tx, &req.id)?;
                    audit::record_as(
                        tx,
                        &actor,
                        actions::OAUTH_DENY,
                        Some(&client.id),
                        Some(detail),
                        Some(&client_info.ip),
                    )?;
                    let mut pairs = vec![("error", "access_denied")];
                    pairs.extend(state_pair);
                    redirect_url(&req.redirect_uri, &pairs, &issuer)
                }
                "approve" => {
                    let (max, _, asked) = levels(&actor, &req);
                    let chosen =
                        body.access
                            .as_deref()
                            .and_then(Access::parse)
                            .ok_or_else(|| {
                                AppError::bad_request(format!(
                                    "choose an access level: {}, {} or {}",
                                    access::READ,
                                    access::WRITE,
                                    access::MANAGE
                                ))
                            })?;
                    if chosen > max {
                        return Err(AppError::bad_request(
                            "your account cannot give an app that much access",
                        ));
                    }
                    let base_ids = match &body.base_ids {
                        None => None,
                        Some(ids) => Some(validate_base_ids(tx, &actor.user_id, ids)?),
                    };
                    // The same rule as Change access (AGT-2), so no state is reachable by one
                    // path only: an app limited to some projects never gets Full control.
                    if chosen == Access::Manage && base_ids.is_some() {
                        return Err(limited_app_cannot_manage());
                    }
                    let token_scope = chosen.token_scope(base_ids);
                    let code = store::create_code(
                        tx,
                        &client.id,
                        &actor.user_id,
                        &req.redirect_uri,
                        &req.code_challenge,
                        &req.resource,
                        &token_scope,
                    )?;
                    store::delete_request(tx, &req.id)?;
                    let mut detail = detail;
                    detail["access"] = json!(chosen.as_str());
                    // What the app asked for, and whether the person chose more: the choice that
                    // matters most when reading the log after an incident.
                    detail["requested"] = json!(asked.map(Access::as_str));
                    detail["beyond_request"] = json!(chosen > asked.unwrap_or(Access::Read));
                    detail["base_ids"] = json!(token_scope.base_ids);
                    audit::record_as(
                        tx,
                        &actor,
                        actions::OAUTH_APPROVE,
                        Some(&client.id),
                        Some(detail),
                        Some(&client_info.ip),
                    )?;
                    let mut pairs = vec![("code", code.as_str())];
                    pairs.extend(state_pair);
                    redirect_url(&req.redirect_uri, &pairs, &issuer)
                }
                _ => {
                    return Err(AppError::bad_request(
                        "decision must be \"approve\" or \"deny\"",
                    ));
                }
            };
            redirect_to.ok_or_else(|| AppError::internal("stored redirect URI is not a URL"))
        })
        .await?;
    Ok(Json(ConsentOutcome {
        redirect_to: outcome,
    }))
}

/// Full control reaches beyond single projects (workspaces, members), so an app limited to some
/// projects cannot hold it, whether at consent or through Change access.
fn limited_app_cannot_manage() -> AppError {
    AppError::bad_request(
        "an app limited to some projects cannot have Full control, which reaches beyond single \
         projects; connect it without a project limit to give it Full control",
    )
}

async fn list_grants(
    State(state): State<AppState>,
    actor: Actor,
) -> AppResult<Json<Vec<GrantInfo>>> {
    actor.require_capability(Capability::SessionOnly)?;
    let list = state
        .db
        .read(move |c| store::list_grants(c, Some(&actor.user_id)))
        .await?;
    Ok(Json(list))
}

async fn revoke_grant(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    actor.require_capability(Capability::SessionOnly)?;
    state
        .db
        .write(move |tx| {
            let n = tx.execute(
                "DELETE FROM oauth_grants WHERE id = ?1 AND user_id = ?2",
                rusqlite::params![id, actor.user_id],
            )?;
            if n == 0 {
                return Err(AppError::not_found("connected app"));
            }
            audit::record_as(
                tx,
                &actor,
                actions::OAUTH_GRANT_REVOKE,
                Some(&id),
                Some(json!({ "by": "user" })),
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Change what a connected app may do (Account, AI assistants, Change access): up or down,
/// applied to the grant and its live tokens from their next request, no reconnect.
///
/// Session only, like every other way of changing or removing a connected app: if an app could
/// raise its own access, the consent screen would mean nothing. The new level can never exceed
/// what the person themselves may hand out (see [`levels`]), and the app keeps acting as the
/// person, so their role in each workspace still bounds it. An app limited to some projects
/// cannot be given Full control, which reaches beyond single projects.
async fn change_grant_access(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<GrantAccessUpdate>,
) -> AppResult<Json<GrantInfo>> {
    actor.require_capability(Capability::SessionOnly)?;
    let to = Access::parse(&body.access).ok_or_else(|| {
        AppError::bad_request(format!(
            "choose an access level: {}, {} or {}",
            access::READ,
            access::WRITE,
            access::MANAGE
        ))
    })?;
    if to == Access::Manage {
        actor.require_capability(Capability::Manage)?;
    }
    let info = state
        .db
        .write(move |tx| {
            let Some(current) = store::list_grants(tx, Some(&actor.user_id))?
                .into_iter()
                .find(|g| g.id == id)
            else {
                return Err(AppError::not_found("connected app"));
            };
            if to == Access::Manage && current.bases.is_some() {
                return Err(limited_app_cannot_manage());
            }
            let Some((before, after)) = store::set_grant_access(tx, &id, &actor.user_id, to)?
            else {
                return Err(AppError::not_found("connected app"));
            };
            audit::record_as(
                tx,
                &actor,
                actions::OAUTH_GRANT_UPDATE,
                Some(&id),
                Some(json!({
                    "client": current.client_name,
                    "redirect_host": current.redirect_host,
                    "from": scope::access_of(&before).as_str(),
                    "to": scope::access_of(&after).as_str(),
                    "base_ids": after.base_ids,
                })),
                Some(&client.ip),
            )?;
            store::list_grants(tx, Some(&actor.user_id))?
                .into_iter()
                .find(|g| g.id == id)
                .ok_or_else(|| AppError::not_found("connected app"))
        })
        .await?;
    Ok(Json(info))
}

async fn admin_list_grants(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
) -> AppResult<Json<Vec<GrantInfo>>> {
    actor.require_capability(Capability::SessionOnly)?;
    admin_guard(&state, &actor, &client, "GET /api/admin/oauth/grants").await?;
    let list = state.db.read(|c| store::list_grants(c, None)).await?;
    Ok(Json(list))
}

async fn admin_revoke_grant(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    actor.require_capability(Capability::SessionOnly)?;
    admin_guard(
        &state,
        &actor,
        &client,
        "DELETE /api/admin/oauth/grants/{id}",
    )
    .await?;
    state
        .db
        .write(move |tx| {
            let Some(owner) = store::grant_owner(tx, &id)? else {
                return Err(AppError::not_found("connected app"));
            };
            store::revoke_grant(tx, &id)?;
            audit::record_as(
                tx,
                &actor,
                actions::OAUTH_GRANT_REVOKE,
                Some(&id),
                Some(json!({ "by": "admin", "user_id": owner })),
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
