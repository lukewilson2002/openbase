//! `GET /api/workspaces/{id}/home`: what a workspace's Home shows, in one request (see
//! `store::home`). Any member of the workspace, or API token that reaches one of its projects.

use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use chrono::Utc;
use ob_core::api::home::HomeResponse;

use crate::auth::Actor;
use crate::error::AppResult;
use crate::state::AppState;
use crate::store::home::{self, Budget};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/workspaces/{id}/home", get(get_home))
}

async fn get_home(
    State(state): State<AppState>,
    actor: Actor,
    Path(id): Path<String>,
) -> AppResult<Json<HomeResponse>> {
    let out = state
        .db
        .read(move |c| home::home(c, &actor, &id, Utc::now(), Budget::default()))
        .await?;
    Ok(Json(out))
}
