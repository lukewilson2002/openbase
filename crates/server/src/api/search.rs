//! `GET /api/search`: search everything the caller can open, or only what is
//! inside one workspace or base of it. Any signed-in user or API token
//! (limited to the bases the token reaches); see `store::search`.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use ob_core::api::search::SearchResponse;
use serde::Deserialize;

use crate::auth::Actor;
use crate::error::AppResult;
use crate::extract::ApiQuery;
use crate::state::AppState;
use crate::store::search;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/search", get(search_everything))
}

#[derive(Debug, Deserialize)]
struct SearchParams {
    #[serde(default)]
    q: Option<String>,
    /// Default [`search::DEFAULT_LIMIT`], at most [`search::MAX_LIMIT`].
    #[serde(default)]
    limit: Option<usize>,
    /// Only what is inside this workspace (an id).
    #[serde(default)]
    workspace: Option<String>,
    /// Only what is inside this base (an id).
    #[serde(default)]
    base: Option<String>,
}

async fn search_everything(
    State(state): State<AppState>,
    actor: Actor,
    ApiQuery(params): ApiQuery<SearchParams>,
) -> AppResult<Json<SearchResponse>> {
    let needle = search::needle(params.q.as_deref().unwrap_or_default())?;
    let limit = params
        .limit
        .unwrap_or(search::DEFAULT_LIMIT)
        .clamp(1, search::MAX_LIMIT);
    let blank = |id: Option<String>| id.filter(|id| !id.trim().is_empty());
    let scope = search::Scope {
        workspace_id: blank(params.workspace),
        base_id: blank(params.base),
    };
    let results = state
        .db
        .read(move |c| search::search(c, &actor, &needle, limit, &scope))
        .await?;
    Ok(Json(SearchResponse { results }))
}
