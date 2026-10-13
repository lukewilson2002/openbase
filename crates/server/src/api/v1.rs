//! Routes of the Airtable-compatible API (see [`crate::v1`]).

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    crate::v1::router()
}
