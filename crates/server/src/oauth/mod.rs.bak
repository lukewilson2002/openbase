//! An OAuth 2.1 authorization server for the MCP endpoint, so that apps such as Claude and
//! ChatGPT can connect to OpenBase with a normal "sign in and approve" flow instead of a pasted
//! API token.
//!
//! # Standards
//!
//! - MCP authorization specification: the MCP server (`/mcp`) is the OAuth *resource server*,
//!   this module is its *authorization server*. An unauthenticated request to `/mcp` is answered
//!   `401` with `WWW-Authenticate: Bearer resource_metadata="..."`.
//! - RFC 9728 protected resource metadata ([`metadata`]), RFC 8414 authorization server metadata
//!   ([`metadata`]), RFC 9207 `iss` response parameter.
//! - Client registration, three ways: RFC 7591 dynamic registration ([`register`]), OAuth Client
//!   ID Metadata Documents, where the `client_id` is an HTTPS URL we fetch ([`cimd`]), and
//!   clients the administrator adds on the command line (`openbase oauth-client add`).
//! - Authorization code flow with mandatory PKCE `S256` (RFC 7636), RFC 8707 `resource`
//!   indicators, RFC 8252 loopback redirects ([`redirect`]), refresh token rotation with reuse
//!   detection, RFC 7009 revocation ([`token`]).
//!
//! # How the pieces fit
//!
//! 1. `GET /oauth/authorize` ([`authorize`]) validates the whole request, stores it server-side
//!    and sends the browser to the consent page `/oauth/consent?request=<id>` of the web app.
//!    Only the opaque id travels through the browser, so the client cannot change parameters
//!    between the steps. The consent page requires a signed-in session (the login redirect and
//!    the way back are the web app's own).
//! 2. `GET /api/oauth/requests/{id}` and `POST /api/oauth/requests/{id}/decision`
//!    ([`crate::api::oauth`]) show the request and take the user's decision: session only, and
//!    CSRF-protected like every other state-changing API call. Approval stores a single-use,
//!    60-second authorization code bound to client, redirect URI, PKCE challenge, resource and
//!    the access the user chose, and returns the redirect address to follow.
//! 3. `POST /oauth/token` ([`token`]) exchanges the code (or a refresh token) for an opaque
//!    access token (1 hour) and a rotating refresh token (30 days idle). Tokens are stored as
//!    hashes and are valid only on `/mcp`, never on `/api/*` or `/api/v1`.
//! 4. The grant ("connected app") maps onto the same [`crate::auth::TokenScope`] as a personal
//!    access token, so every permission check, session-only rule and rate limit of the MCP
//!    server applies unchanged.
//!
//! OAuth is advertised and served only when the public URL is HTTPS, or a loopback address (see
//! [`crate::config::Config::oauth_enabled`]).

pub mod authorize;
pub mod cimd;
pub mod metadata;
pub mod redirect;
pub mod register;
pub mod scope;
pub mod token;

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;

use crate::error::AppError;
use crate::state::AppState;

/// Largest body the protocol endpoints read.
pub const MAX_BODY_BYTES: usize = 16 * 1024;

/// The key the per-address limits of the OAuth endpoints use: an IPv4 address as it is, an IPv6
/// address reduced to its /64 (one subscriber usually holds a whole /64, so per-address keys would
/// give an attacker 2^64 fresh budgets), and an IPv4-mapped IPv6 address as the IPv4 address.
pub fn rate_key(ip: &str) -> String {
    use std::net::IpAddr;
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.to_string(),
        Ok(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
        Err(_) => ip.to_string(),
    }
}

pub fn router() -> Router<AppState> {
    // Machine endpoints: no cookies, no ambient credentials, so they may answer any origin
    // (browser-based MCP clients such as the MCP Inspector call them with `fetch`).
    // The root `/.well-known/oauth-protected-resource` answers 404: RFC 9728 section 3.3 requires
    // the `resource` of a document to be the URL it was read from minus the well-known part, and
    // the only protected resource is `/mcp` (the 401 challenge points at that document).
    let machine = Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(metadata::protected_resource_root),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(metadata::protected_resource),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(metadata::authorization_server),
        )
        .route("/oauth/register", post(register::register))
        .route("/oauth/token", post(token::token))
        .route("/oauth/revoke", post(token::revoke))
        .layer(middleware::from_fn(cors));
    Router::new()
        .route("/oauth/authorize", get(authorize::authorize))
        .merge(machine)
}

/// `Access-Control-Allow-Origin: *` for the machine endpoints, and an answer to preflights. Safe
/// because none of them looks at cookies: what they accept is a bearer token, a one-time code
/// with its PKCE verifier, or nothing at all.
async fn cors(req: Request, next: Next) -> Response {
    let preflight = req.method() == Method::OPTIONS;
    let mut res = if preflight {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(req).await
    };
    let h = res.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    if preflight {
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, authorization, mcp-protocol-version"),
        );
        h.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
    }
    res
}

/// An error in the format of RFC 6749 section 5.2: `{"error": "...", "error_description": "..."}`.
#[derive(Debug)]
pub struct OAuthError {
    pub status: StatusCode,
    pub error: &'static str,
    pub description: String,
}

impl OAuthError {
    pub fn new(error: &'static str, description: impl Into<String>) -> Self {
        OAuthError {
            status: StatusCode::BAD_REQUEST,
            error,
            description: description.into(),
        }
    }

    pub fn invalid_request(description: impl Into<String>) -> Self {
        Self::new("invalid_request", description)
    }

    pub fn invalid_grant(description: impl Into<String>) -> Self {
        Self::new("invalid_grant", description)
    }

    pub fn invalid_client(description: impl Into<String>) -> Self {
        OAuthError {
            status: StatusCode::UNAUTHORIZED,
            error: "invalid_client",
            description: description.into(),
        }
    }

    /// OAuth is not available on this instance.
    pub fn disabled() -> Self {
        OAuthError {
            status: StatusCode::NOT_FOUND,
            error: "oauth_disabled",
            description: "OAuth is not available on this instance: OPENBASE_PUBLIC_URL must be \
                          an https:// URL (or a localhost address)"
                .into(),
        }
    }

    pub fn rate_limited() -> Self {
        OAuthError {
            status: StatusCode::TOO_MANY_REQUESTS,
            error: "temporarily_unavailable",
            description: "too many requests; slow down and retry in a moment".into(),
        }
    }
}

impl From<AppError> for OAuthError {
    fn from(e: AppError) -> Self {
        match e {
            AppError::TooManyRequests => OAuthError::rate_limited(),
            AppError::BadRequest(m) => OAuthError::invalid_request(m),
            AppError::Internal(detail) => {
                tracing::error!(error = %detail, "internal error in the OAuth server");
                OAuthError {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    error: "server_error",
                    description: "Something went wrong. The error has been logged.".into(),
                }
            }
            other => OAuthError {
                status: other.status(),
                error: "server_error",
                description: other.to_string(),
            },
        }
    }
}

/// Responses carrying secrets must not be cached (RFC 6749 5.1).
pub fn no_store(res: &mut Response) {
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let body = json!({ "error": self.error, "error_description": self.description });
        let mut res = (self.status, axum::Json(body)).into_response();
        no_store(&mut res);
        res
    }
}

/// Parse an `application/x-www-form-urlencoded` body (or query string) into pairs. A parameter
/// that appears twice is an error (RFC 6749 3.1 / 3.2: parameters MUST NOT be repeated).
pub fn parse_params(raw: &[u8]) -> Result<std::collections::HashMap<String, String>, OAuthError> {
    let mut out = std::collections::HashMap::new();
    for (k, v) in url::form_urlencoded::parse(raw) {
        if out.insert(k.to_string(), v.to_string()).is_some() {
            return Err(OAuthError::invalid_request(format!(
                "the parameter '{k}' is repeated"
            )));
        }
    }
    Ok(out)
}

/// `https://host/mcp` with at most one trailing slash removed: the form resource indicators are
/// compared in.
pub fn normalize_resource(resource: &str) -> &str {
    resource.strip_suffix('/').unwrap_or(resource)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_parameters_are_refused() {
        assert!(parse_params(b"a=1&b=2").is_ok());
        assert!(parse_params(b"a=1&a=2").is_err());
        let p = parse_params(b"x=a%20b&y=%E2%9C%93").unwrap();
        assert_eq!(p["x"], "a b");
        assert_eq!(p["y"], "\u{2713}");
    }

    #[test]
    fn resources_compare_without_one_trailing_slash() {
        assert_eq!(
            normalize_resource("https://a.example/mcp/"),
            "https://a.example/mcp"
        );
        assert_eq!(
            normalize_resource("https://a.example/mcp"),
            "https://a.example/mcp"
        );
        assert_eq!(
            normalize_resource("https://a.example/mcp//"),
            "https://a.example/mcp/"
        );
    }
}
