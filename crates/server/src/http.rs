//! Router assembly and cross-cutting middleware.

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::api;
use crate::error::AppError;
use crate::state::AppState;

/// Header every cookie-authenticated state-changing request must carry.
/// Browsers cannot attach custom headers to cross-site requests without a
/// CORS preflight, and OpenBase never answers preflights, so this blocks CSRF.
pub const CSRF_HEADER: &str = "x-openbase-csrf";

/// Browser features no page of OpenBase uses, switched off for it and for anything it embeds.
const PERMISSIONS_POLICY: &str = "camera=(), microphone=(), geolocation=()";

/// One year. Without `includeSubDomains` and `preload` on purpose: the host may share its
/// parent domain with sites that are not served over https, and preloading is a promise that is
/// hard to take back.
const HSTS: &str = "max-age=31536000";

/// Default JSON body limit; upload routes set their own.
const JSON_BODY_LIMIT: usize = 4 * 1024 * 1024;

pub fn router(state: AppState) -> Router {
    // The MCP tools run requests through a second assembly of this router (same middleware and
    // handlers, but without `/mcp` itself, which `api_request` refuses to call anyway). Its
    // state has its own empty `app_router` cell: storing a router that holds the very state
    // that points back at it would be a reference cycle that never frees the database.
    // Building the router twice for one state keeps the first.
    if state.app_router.get().is_none() {
        let mut inner = state.clone();
        inner.app_router = Default::default();
        let _ = state.app_router.set(assemble(inner, false));
    }
    assemble(state, true)
}

fn assemble(state: AppState, with_mcp: bool) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .merge(api::router())
        // A known path with the wrong method: answer with the JSON error format too.
        .method_not_allowed_fallback(|| async { AppError::MethodNotAllowed })
        .layer(middleware::from_fn_with_state(state.clone(), csrf_guard))
        .layer(DefaultBodyLimit::max(JSON_BODY_LIMIT));

    // `/mcp` takes bearer tokens only (cookies are refused), so it needs no CSRF header and
    // sits outside the cookie guard above; it enforces its own body limit.
    // The OAuth protocol endpoints (`/oauth/*`, `/.well-known/oauth-*`) use no cookies either and
    // answer in the RFCs' formats, so they are outside the cookie guard too.
    let mut app = Router::new().merge(api).merge(crate::oauth::router());
    if with_mcp {
        app = app.merge(crate::mcp::router());
    }
    app.merge(crate::web::router())
        // Compress text, but not what is already compressed or must stay byte-exact for `Range`
        // requests: video, audio and the opaque downloads (`application/octet-stream`).
        .layer(
            CompressionLayer::new().compress_when(
                DefaultPredicate::new()
                    .and(NotForContentType::new("video/"))
                    .and(NotForContentType::new("audio/"))
                    .and(NotForContentType::new("application/octet-stream")),
            ),
        )
        // CSP for the React SPA: only same-origin scripts (no inline, no eval, no WASM).
        // `style-src 'unsafe-inline'` is needed because Radix UI and canvas widgets set
        // inline styles; `img-src data: blob:` covers generated QR codes and previews.
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
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
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static(PERMISSIONS_POLICY),
        ))
        // No page of ours is meant to share a browsing context group with another origin's
        // window (no popup flows with `window.opener`), and nothing we serve is meant to be
        // embedded by another origin's no-cors `<img>`/`<script>`: attachments are fetched by
        // the app itself, and the machine endpoints that must be read from other origins
        // (OAuth discovery, registration, token, MCP) are fetched in CORS mode, which the
        // resource policy does not apply to.
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            hsts_when_https,
        ))
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// `Strict-Transport-Security`, only when the public URL is https. Sent over plain http a browser
/// ignores it, but the header would then promise something the deployment does not do; a
/// local `http://localhost` setup must never pin the browser to https.
async fn hsts_when_https(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    if state.config.public_https() {
        res.headers_mut()
            .entry(header::STRICT_TRANSPORT_SECURITY)
            .or_insert(HeaderValue::from_static(HSTS));
    }
    res
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

/// Reject cookie-authenticated unsafe requests that lack the CSRF header or that a browser
/// declares as coming from another origin. Bearer-token requests and anonymous requests (public
/// forms) are exempt: they carry no ambient credentials.
async fn csrf_guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let unsafe_method = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if unsafe_method {
        let cookie_name = state.config.session_cookie_name();
        let has_cookie = req
            .headers()
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .any(|v| v.contains(cookie_name));
        // Exactly what the Actor extractor treats as a token: any other
        // Authorization value (e.g. Basic auth added by a proxy) leaves the
        // cookie in charge, so the CSRF header is still required.
        let has_bearer = crate::auth::bearer_from_headers(req.headers()).is_some();
        if has_cookie && !has_bearer {
            let has_csrf = req.headers().get(CSRF_HEADER).is_some_and(|v| v == "1");
            if !has_csrf {
                return AppError::forbidden("missing CSRF header").into_response();
            }
            if declared_origin_differs(req.headers(), &state.config.public_origin()) {
                return AppError::forbidden("cross-origin request refused").into_response();
            }
        }
    }
    next.run(req).await
}

/// Whether the request says it came from a page of another origin: its `Origin` header, or
/// without one its `Referer`, is present and is not `public_origin`. A request with neither
/// (every non-browser client) passes; so does anything whose header names the right origin.
/// A header that cannot be read as an origin (including the opaque `null`) counts as different,
/// because a browser never sends one from a page of ours.
fn declared_origin_differs(headers: &axum::http::HeaderMap, public_origin: &str) -> bool {
    let Some(declared) = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
    else {
        return false;
    };
    let Some(declared) = declared.to_str().ok() else {
        return true;
    };
    match url::Url::parse(declared) {
        Ok(u) => u.origin().ascii_serialization() != public_origin,
        Err(_) => true,
    }
}
