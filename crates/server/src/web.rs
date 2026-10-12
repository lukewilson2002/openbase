//! Serves the compiled web client (crates/web/dist), embedded into the binary
//! at build time. Unknown non-API paths fall back to index.html (SPA routing).

use axum::Router;
use axum::body::Body;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use crate::state::AppState;

#[derive(rust_embed::Embed)]
#[folder = "../web/dist/"]
#[allow_missing = true]
struct Assets;

pub fn router() -> Router<AppState> {
    Router::new().fallback(serve)
}

async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return crate::error::AppError::not_found("endpoint").into_response();
    }
    if let Some(file) = Assets::get(path).filter(|_| !path.is_empty()) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        // Trunk emits content-hashed file names for wasm/js/css.
        let cache = if path.ends_with(".wasm") || path.ends_with(".js") || path.ends_with(".css") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        return Response::builder()
            .header(header::CONTENT_TYPE, mime.as_ref())
            .header(header::CACHE_CONTROL, cache)
            .body(Body::from(file.data.into_owned()))
            .unwrap();
    }
    match Assets::get("index.html") {
        Some(index) => Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(index.data.into_owned()))
            .unwrap(),
        None => (
            StatusCode::NOT_FOUND,
            "OpenGrid web client not built. Run `trunk build --release` in crates/web.",
        )
            .into_response(),
    }
}
