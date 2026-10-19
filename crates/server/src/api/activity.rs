//! `GET /api/history`: the activity feed, recent changes and comments across every record the
//! caller can open (any signed-in user or API token, limited to the bases the token reaches);
//! see `store::activity`. The history of one record is `GET /api/records/{id}/history`.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use ob_core::api::history::ActivityPage;
use serde::Deserialize;

use crate::auth::Actor;
use crate::error::AppResult;
use crate::extract::ApiQuery;
use crate::state::AppState;
use crate::store::activity::{self, Cursor, Filter, Order};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/history", get(feed))
}

/// Optional narrowing; empty values count as absent so a client can always send every parameter.
#[derive(Debug, Default, Deserialize)]
struct FeedParams {
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    table: Option<String>,
    /// The author's user id.
    #[serde(default)]
    user: Option<String>,
    /// create | update | delete | restore | comment
    #[serde(default)]
    kind: Option<String>,
    /// newest (default) | oldest
    #[serde(default)]
    order: Option<String>,
    /// The `next` of the previous page.
    #[serde(default)]
    before: Option<String>,
    /// Default [`activity::DEFAULT_LIMIT`], at most [`activity::MAX_LIMIT`].
    #[serde(default)]
    limit: Option<usize>,
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

async fn feed(
    State(state): State<AppState>,
    actor: Actor,
    ApiQuery(q): ApiQuery<FeedParams>,
) -> AppResult<Json<ActivityPage>> {
    let filter = Filter {
        workspace_id: non_empty(q.workspace),
        base_id: non_empty(q.base),
        table_id: non_empty(q.table),
        user_id: non_empty(q.user),
        kind: non_empty(q.kind)
            .as_deref()
            .map(activity::parse_kind)
            .transpose()?,
        order: non_empty(q.order)
            .as_deref()
            .map(Order::parse)
            .transpose()?
            .unwrap_or(Order::Newest),
        before: non_empty(q.before)
            .as_deref()
            .map(Cursor::decode)
            .transpose()?,
        limit: q
            .limit
            .unwrap_or(activity::DEFAULT_LIMIT)
            .clamp(1, activity::MAX_LIMIT),
    };
    let page = state
        .db
        .read(move |c| activity::feed(c, &actor, &filter))
        .await?;
    Ok(Json(page))
}
