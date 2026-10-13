//! The Airtable-compatible API under `/api/v1` (documented in `docs/api.md`).
//!
//! Existing Airtable client libraries and scripts should work against
//! `https://<your server>/api/v1` with an OpenGrid API token in place of an
//! Airtable personal access token. Routes:
//!
//! - `GET  /api/v1/meta/bases`, `GET /api/v1/meta/bases/{baseId}/tables`
//! - `GET|POST|PATCH|PUT|DELETE /api/v1/{baseId}/{tableIdOrName}`
//! - `GET|PATCH|PUT|DELETE /api/v1/{baseId}/{tableIdOrName}/{recordId}`
//!
//! Only bearer tokens authenticate (never the session cookie), permissions
//! are the token owner's role on the base capped by the token's scope
//! ([`crate::perm::require_base`]), and every error is
//! `{"error": {"type", "message"}}` with Airtable's type names. Unknown
//! paths below `/api/v1` get the same format from the SPA fallback in
//! [`crate::web`].

pub mod auth;
pub mod cursor;
pub mod error;
pub mod input;
pub mod meta;
pub mod records;
pub mod shape;

use axum::Router;
use axum::routing::get;

use crate::state::AppState;
use crate::v1::error::V1Error;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/meta/bases",
            get(meta::list_bases).fallback(not_allowed),
        )
        .route(
            "/api/v1/meta/bases/{base_id}/tables",
            get(meta::list_tables).fallback(not_allowed),
        )
        .route(
            "/api/v1/{base_id}/{table}",
            get(records::list)
                .post(records::create)
                .patch(records::patch_batch)
                .put(records::put_batch)
                .delete(records::delete_batch)
                .fallback(not_allowed),
        )
        .route(
            "/api/v1/{base_id}/{table}/{record_id}",
            get(records::get_one)
                .patch(records::patch_one)
                .put(records::put_one)
                .delete(records::delete_one)
                .fallback(not_allowed),
        )
}

async fn not_allowed() -> V1Error {
    crate::error::AppError::MethodNotAllowed.into()
}
