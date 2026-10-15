//! `GET /api/search`: search everything the caller can open. Any signed-in
//! user or API token (limited to the bases the token reaches); see
//! `store::search`.

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
    let results = state
        .db
        .read(move |c| search::search(c, &actor, &needle, limit))
        .await?;
    Ok(Json(SearchResponse { results }))
}
