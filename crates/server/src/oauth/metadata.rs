//! Discovery documents: RFC 9728 protected resource metadata for the MCP endpoint and RFC 8414
//! authorization server metadata for this instance.
//!
//! Both are built from `OPENBASE_PUBLIC_URL` alone, so OAuth works out of the box. They are not
//! served (404) when OAuth is not available, see [`crate::config::Config::oauth_enabled`].

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::{OAuthError, scope};
use crate::config::Config;
use crate::state::AppState;

/// How long clients may reuse a metadata document.
const MAX_AGE: &str = "public, max-age=300";

/// The URL of the protected resource metadata of the MCP endpoint (the path-suffixed form of
/// RFC 9728 section 3.1), which `401` responses of `/mcp` point to.
pub fn resource_metadata_url(config: &Config) -> String {
    format!(
        "{}/.well-known/oauth-protected-resource/mcp",
        config.oauth_issuer()
    )
}

pub fn protected_resource_document(config: &Config) -> Value {
    json!({
        "resource": config.mcp_resource(),
        "authorization_servers": [config.oauth_issuer()],
        "scopes_supported": scope::SUPPORTED,
        "bearer_methods_supported": ["header"],
        "resource_name": "OpenBase MCP",
    })
}

pub fn authorization_server_document(config: &Config) -> Value {
    let issuer = config.oauth_issuer();
    let mut doc = json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/oauth/authorize"),
        "token_endpoint": format!("{issuer}/oauth/token"),
        "revocation_endpoint": format!("{issuer}/oauth/revoke"),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "scopes_supported": scope::SUPPORTED,
        "client_id_metadata_document_supported": true,
        "authorization_response_iss_parameter_supported": true,
    });
    if config.oauth_registration {
        doc["registration_endpoint"] = json!(format!("{issuer}/oauth/register"));
    }
    doc
}

fn document(state: &AppState, build: fn(&Config) -> Value) -> Result<Response, OAuthError> {
    if !state.config.oauth_enabled() {
        return Err(OAuthError::disabled());
    }
    let mut res = Json(build(&state.config)).into_response();
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(MAX_AGE));
    Ok(res)
}

/// `GET /.well-known/oauth-protected-resource/mcp`.
pub async fn protected_resource(State(state): State<AppState>) -> Result<Response, OAuthError> {
    document(&state, protected_resource_document)
}

/// `GET /.well-known/oauth-protected-resource` (no path suffix): there is no protected resource at
/// the origin, so there is no document. Serving the `/mcp` document here would advertise a
/// `resource` that does not match the URL it was read from (RFC 9728 section 3.3).
pub async fn protected_resource_root() -> OAuthError {
    OAuthError {
        status: axum::http::StatusCode::NOT_FOUND,
        error: "not_found",
        description: "the protected resource is /mcp; its metadata is at \
                      /.well-known/oauth-protected-resource/mcp"
            .into(),
    }
}

/// `GET /.well-known/oauth-authorization-server`.
pub async fn authorization_server(State(state): State<AppState>) -> Result<Response, OAuthError> {
    document(&state, authorization_server_document)
}
