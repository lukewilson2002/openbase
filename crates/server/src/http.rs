//! Router assembly and cross-cutting middleware.

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::api;
use crate::error::AppError;
use crate::state::AppState;

/// Header every cookie-authenticated state-changing request must carry.
/// Browsers cannot attach custom headers to cross-site requests without a
/// CORS preflight, and OpenGrid never answers preflights, so this blocks CSRF.
pub const CSRF_HEADER: &str = "x-opengrid-csrf";

/// Default JSON body limit; upload routes set their own.
const JSON_BODY_LIMIT: usize = 4 * 1024 * 1024;

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .merge(api::router())
        .layer(middleware::from_fn_with_state(state.clone(), csrf_guard))
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT));

    Router::new()
        .merge(api)
        .merge(crate::web::router())
        .layer(CompressionLayer::new())
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
                 img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; \
                 form-action 'self'; object-src 'none'",
            ),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("same-origin"),
        ))
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    state
        .db
        .read(|c| {
            c.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                .map_err(AppError::from)
        })
        .await?;
    Ok(axum::Json(
        serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }),
    ))
}

/// Reject cookie-authenticated unsafe requests that lack the CSRF header.
/// Bearer-token requests and anonymous requests (public forms) are exempt:
/// they carry no ambient credentials.
async fn csrf_guard(State(_state): State<AppState>, req: Request, next: Next) -> Response {
    let unsafe_method = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if unsafe_method {
        let has_cookie = req
            .headers()
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| v.contains(crate::auth::SESSION_COOKIE));
        let has_bearer = req.headers().contains_key(header::AUTHORIZATION);
        let has_csrf = req.headers().get(CSRF_HEADER).is_some_and(|v| v == "1");
        if has_cookie && !has_bearer && !has_csrf {
            return AppError::forbidden("missing CSRF header").into_response();
        }
    }
    next.run(req).await
}
