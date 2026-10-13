//! `tokens` API: the caller's personal access tokens (session only: a token
//! can never mint or delete tokens), plus `whoami`, which also accepts tokens
//! so integrations can check what their token can do.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use og_core::api::auth::{CreateTokenRequest, CreatedToken, TokenInfo, WhoAmI};
use serde_json::json;

use crate::auth::{Actor, ClientInfo};
use crate::error::AppResult;
use crate::extract::ApiJson;
use crate::state::AppState;
use crate::store::audit::{self, actions};
use crate::store::tokens;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tokens", get(list).post(create))
        .route("/api/tokens/whoami", get(whoami))
        .route("/api/tokens/{id}", delete(remove))
}

async fn list(State(state): State<AppState>, actor: Actor) -> AppResult<Json<Vec<TokenInfo>>> {
    actor.require_session()?;
    let list = state
        .db
        .read(move |c| tokens::list(c, &actor.user_id))
        .await?;
    Ok(Json(list))
}

async fn create(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    ApiJson(req): ApiJson<CreateTokenRequest>,
) -> AppResult<(StatusCode, Json<CreatedToken>)> {
    actor.require_session()?;
    let created = state
        .db
        .write(move |tx| {
            let created = tokens::create(tx, &actor.user_id, &req)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::TOKEN_CREATE,
                Some(&created.info.id),
                Some(json!({
                    "name": created.info.name,
                    "write": created.info.write,
                    "base_ids": created.info.base_ids,
                })),
                Some(&client.ip),
            )?;
            Ok(created)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(created)))
}

async fn remove(
    State(state): State<AppState>,
    actor: Actor,
    client: ClientInfo,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    actor.require_session()?;
    state
        .db
        .write(move |tx| {
            tokens::delete(tx, &actor.user_id, &id)?;
            audit::record(
                tx,
                Some(&actor.user_id),
                actions::TOKEN_DELETE,
                Some(&id),
                None,
                Some(&client.ip),
            )
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn whoami(actor: Actor) -> Json<WhoAmI> {
    let (via_token, write, base_ids) = match actor.token_scope {
        Some(scope) => (true, scope.write, scope.base_ids),
        None => (false, true, None),
    };
    Json(WhoAmI {
        user_id: actor.user_id,
        email: actor.email,
        name: actor.name,
        via_token,
        write,
        base_ids,
    })
}
