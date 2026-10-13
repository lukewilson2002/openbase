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
use ob_core::api::oauth::{ConsentDecision, ConsentOutcome, ConsentRequest, GrantInfo, access};
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
        .route("/api/oauth/grants/{id}", delete(revoke_grant))
        .route("/api/admin/oauth/grants", get(admin_list_grants))
        .route("/api/admin/oauth/grants/{id}", delete(admin_revoke_grant))
}

/// The highest level the user may pick for a request, and the level preselected on the page.
///
/// - **Read only is always preselected**, whatever the app asked for: more access is a decision
///   the person makes, never a default.
/// - The ceiling is what the app asked for. An app that named no scope we know gets "Read & edit"
///   at most; **Full control is offered only when the app asked for it** (`openbase:manage`) and
///   the person could hand it out themselves, that is, may create `manage` tokens (every
///   signed-in person may; a token or an OAuth grant never reaches this code, the endpoints are
///   session-only).
fn levels(actor: &Actor, req: &store::PendingRequest) -> (Access, Access, Option<Access>) {
    let asked = scope::max_requested(&req.scope);
    let mut max = asked.unwrap_or(Access::Write);
    if max == Access::Manage && actor.require_capability(Capability::Manage).is_err() {
        max = Access::Write;
    }
    (max, Access::Read, asked)
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
                    audit::record(
                        tx,
                        Some(&actor.user_id),
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
                    let (max, _, _) = levels(&actor, &req);
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
                            "that is more access than the app asked for",
                        ));
                    }
                    let base_ids = match &body.base_ids {
                        None => None,
                        Some(ids) => Some(validate_base_ids(tx, &actor.user_id, ids)?),
                    };
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
                    detail["base_ids"] = json!(token_scope.base_ids);
                    audit::record(
                        tx,
                        Some(&actor.user_id),
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
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::OAUTH_GRANT_REVOKE,
                Some(&id),
                Some(json!({ "by": "user" })),
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
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
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::OAUTH_GRANT_REVOKE,
                Some(&id),
                Some(json!({ "by": "admin", "user_id": owner })),
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
