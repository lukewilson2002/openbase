//! The built-in MCP (Model Context Protocol) server: `POST /mcp`.
//!
//! An AI agent authenticates with a personal access token and can do everything the token's
//! user can do in the web app, within the token's scope: the curated data tools ([`data`]) for
//! the common work, and the escape hatches `api_reference` / `api_request` ([`api`],
//! [`catalogue`]) that run any request of the internal REST API through the real router, so
//! every permission check, validation, event and side effect is the web UI's own. Credentials,
//! sessions and token management stay out of reach (session-only), and so does anything that
//! needs the `manage` permission unless the token has it.
//!
//! # Transport
//!
//! Streamable HTTP, implemented here instead of with the `rmcp` crate: the server is stateless
//! (no sessions, no server-initiated messages, every response a single JSON object), its tool
//! list depends on the bearer token of each request, and every request must meet our own
//! authentication, Origin and rate-limit rules, which is easier to get right in ~400 lines than
//! by adapting an SDK built around sessions. Both protocol eras are served on the same endpoint:
//!
//! - the stateless revision `2026-07-28` (no handshake; every request carries
//!   `_meta["io.modelcontextprotocol/protocolVersion"]`, the `MCP-Protocol-Version`,
//!   `Mcp-Method` and `Mcp-Name` headers; `server/discover`), and
//! - the handshake revisions `2025-11-25`, `2025-06-18` and `2025-03-26` (`initialize`,
//!   `notifications/initialized`, `ping`), served without `Mcp-Session-Id` (sessions are
//!   optional in those revisions).
//!
//! # Security
//!
//! Only `Authorization: Bearer <token>` authenticates: a personal access token, or an OAuth
//! access token issued by the built-in authorization server ([`crate::oauth`]) for this very
//! endpoint (a session cookie is refused with 401, which is also why this route needs no CSRF
//! header). An OAuth grant becomes the same [`crate::auth::TokenScope`] as a personal access
//! token, so everything below treats the two alike; OAuth tokens work on `/mcp` only, never on
//! `/api/*` (`api_request` runs its in-process requests as a [`crate::auth::TrustedActor`]).
//! `401` responses carry `WWW-Authenticate: Bearer resource_metadata="..."` (RFC 9728) so MCP
//! clients can discover the authorization server; an OAuth token that lacks the scope for the
//! tool it calls gets `403` with `error="insufficient_scope"`. A browser `Origin` is
//! accepted only from the configured public URL (DNS-rebinding protection, MCP spec); bodies
//! are capped; every request counts against a per-token and a per-user rate limit; token use is
//! stamped like on every other API.

pub mod admin;
pub mod api;
pub mod automations;
pub mod catalogue;
pub mod data;
pub mod files;
pub mod history;
pub mod people;
pub mod resolve;
pub mod schema;
pub mod sharing;
pub mod support;
pub mod tools;
pub mod views;

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine;
use serde_json::{Map, Value, json};

use crate::auth::{
    Actor, OAUTH_ACCESS_PREFIX, bearer_from_headers, client_ip, lookup_api_token,
    lookup_oauth_token, stamp_grant_use, stamp_token_use,
};
use crate::ids::hash_token;
use crate::state::AppState;

/// Largest accepted request body. File uploads through `api_request` travel base64-encoded
/// inside the JSON, so this is also (roughly three quarters of) the largest file.
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// Protocol revisions served: the stateless one first, then the handshake revisions.
pub const MODERN_VERSIONS: &[&str] = &["2026-07-28"];
pub const LEGACY_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26"];
/// What a client that sends no version is assumed to speak (MCP spec, transports).
const ASSUMED_VERSION: &str = "2025-03-26";

const META_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";

// JSON-RPC and MCP error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const HEADER_MISMATCH: i64 = -32020;
const UNSUPPORTED_VERSION: i64 = -32022;
/// Implementation-defined range: refused before or beside the protocol (auth, origin, limits).
const SERVER_REFUSAL: i64 = -32000;

/// Page size of `tools/list`.
const TOOLS_PAGE: usize = 100;

/// Guidance shown to the model by clients (`instructions` of `initialize` / `server/discover`).
const INSTRUCTIONS: &str = "\
OpenBase is a self-hosted Airtable alternative. These tools act as the token's user, within the token's permissions: you can do everything the user can do in the web app. \
Start with list_bases, then get_base_schema to learn table and field names. Tables, fields and views can be given by NAME or id. \
Records: list_records, search_records, get_record, create_records, update_records, delete_records work with field NAMES (like the Airtable API); writes are limited to 10 records per call; deleted records go to the trash (restore_from_trash). \
Structure: create_table, create_field (field_types explains all 28 types and their options), update_field, create_view / update_view (grid, kanban, calendar, gallery, timeline, form, list; filters, sorts and groups use field names), query_view reads a view as the app shows it. \
Workspaces, bases and tables can have an icon (a Lucide name: pass `icon` to the create_* and rename_* tools, null removes it; list_icons searches the names). Also: formulas (check_formula), comments, record history, trash, share links and public forms, automations (test_automation dry-runs), CSV import and export, file uploads, notifications. \
Tokens with the 'manage' permission can also manage workspaces, members, invites and bases; instance administrators get admin_* tools (users, email settings, audit log, stats, backups). \
For anything else call api_reference to see every REST endpoint and api_request to call one; it runs through the same permission checks as the web app. \
Credentials, sessions and API tokens can never be changed through MCP (also: no password-reset links, no switching off someone's 2FA, no SMTP password). \
Errors name what to fix (valid table or field names, missing role or token permission).";

/// Every tool, in the order `tools/list` shows them: the data tools first, then the
/// application-management groups.
pub fn definitions() -> Vec<tools::ToolDef> {
    let mut all = data::definitions();
    all.extend(people::definitions());
    all.extend(schema::definitions());
    all.extend(views::definitions());
    all.extend(history::definitions());
    all.extend(sharing::definitions());
    all.extend(automations::definitions());
    all.extend(files::definitions());
    all.extend(admin::definitions());
    all
}

/// Run the tool `name` (its level was already checked against the token).
pub async fn run(ctx: &McpCtx, name: &str, args: Value) -> tools::ToolResult {
    if let Some(r) = people::run(ctx, name, &args).await {
        return r;
    }
    if let Some(r) = schema::run(ctx, name, &args).await {
        return r;
    }
    if let Some(r) = views::run(ctx, name, &args).await {
        return r;
    }
    if let Some(r) = history::run(ctx, name, &args).await {
        return r;
    }
    if let Some(r) = sharing::run(ctx, name, &args).await {
        return r;
    }
    if let Some(r) = automations::run(ctx, name, &args).await {
        return r;
    }
    if let Some(r) = files::run(ctx, name, &args).await {
        return r;
    }
    if let Some(r) = admin::run(ctx, name, &args).await {
        return r;
    }
    data::run(ctx, name, args).await
}

pub fn router() -> Router<AppState> {
    Router::new().route("/mcp", post(handle).get(no_stream).delete(no_session))
}

/// Everything a tool call knows about its caller.
#[derive(Clone)]
pub struct McpCtx {
    pub state: AppState,
    pub actor: Actor,
    /// The raw bearer token, attached to internal requests (never logged or returned).
    pub token: String,
    pub ip: String,
    pub peer: Option<SocketAddr>,
    pub user_agent: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing

fn rpc_body(id: Value, result: Result<Value, (i64, String, Option<Value>)>) -> Value {
    match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message, data)) => {
            let mut error = json!({ "code": code, "message": message });
            if let Some(data) = data {
                error["data"] = data;
            }
            json!({ "jsonrpc": "2.0", "id": id, "error": error })
        }
    }
}

fn json_response(status: StatusCode, body: &Value) -> Response {
    let mut res = Response::new(Body::from(body.to_string()));
    *res.status_mut() = status;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

fn refuse(status: StatusCode, code: i64, message: &str) -> Response {
    json_response(
        status,
        &rpc_body(Value::Null, Err((code, message.to_string(), None))),
    )
}

/// The `WWW-Authenticate` challenge of this endpoint: the realm, the location of the protected
/// resource metadata (when OAuth is available, RFC 9728 5.1) and optional error parameters.
fn challenge(state: &AppState, error: Option<(&str, &str)>, scope: Option<&str>) -> HeaderValue {
    let mut value = String::from("Bearer realm=\"OpenBase MCP\"");
    if let Some((code, description)) = error {
        value.push_str(&format!(
            ", error=\"{code}\", error_description=\"{description}\""
        ));
    }
    if let Some(scope) = scope {
        value.push_str(&format!(", scope=\"{scope}\""));
    }
    if state.config.oauth_enabled() {
        value.push_str(&format!(
            ", resource_metadata=\"{}\"",
            crate::oauth::metadata::resource_metadata_url(&state.config)
        ));
    }
    HeaderValue::from_str(&value).expect("challenge values are ASCII")
}

fn unauthorized(state: &AppState, message: &str, invalid_token: bool) -> Response {
    let mut res = refuse(StatusCode::UNAUTHORIZED, SERVER_REFUSAL, message);
    let error =
        invalid_token.then_some(("invalid_token", "The access token is invalid or expired"));
    // With OAuth available, the challenge names the scope a client should ask for: read and
    // write, not `manage` (see `oauth::scope::CHALLENGE`).
    let scope = state
        .config
        .oauth_enabled()
        .then_some(crate::oauth::scope::CHALLENGE);
    res.headers_mut()
        .insert(header::WWW_AUTHENTICATE, challenge(state, error, scope));
    res
}

/// `GET /mcp`: this server offers no server-initiated stream (MCP spec: 405 is the answer).
async fn no_stream() -> Response {
    method_not_allowed("this MCP endpoint takes POST requests only; there is no event stream")
}

/// `DELETE /mcp`: there are no sessions to end.
async fn no_session() -> Response {
    method_not_allowed("this MCP endpoint is stateless; there are no sessions to end")
}

fn method_not_allowed(message: &str) -> Response {
    let mut res = refuse(StatusCode::METHOD_NOT_ALLOWED, INVALID_REQUEST, message);
    res.headers_mut()
        .insert(header::ALLOW, HeaderValue::from_static("POST"));
    res
}

/// DNS-rebinding protection: a request that carries an `Origin` header (browsers always do) is
/// served only for the public URL's origin or the configured extra origins.
fn origin_allowed(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let origin = origin.trim().trim_end_matches('/');
    let public = state.config.public_origin();
    origin.eq_ignore_ascii_case(&public)
        || state
            .config
            .mcp_allowed_origins
            .iter()
            .any(|o| origin.eq_ignore_ascii_case(o.trim().trim_end_matches('/')))
}

/// Does the `Accept` header (when sent) allow a JSON response?
fn accepts_json(headers: &HeaderMap) -> bool {
    let Some(accept) = headers.get(header::ACCEPT) else {
        return true;
    };
    let Ok(accept) = accept.to_str() else {
        return false;
    };
    accept.split(',').any(|part| {
        let mime = part.split(';').next().unwrap_or("").trim();
        matches!(mime, "application/json" | "application/*" | "*/*")
    })
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim())
        .is_some_and(|m| m.eq_ignore_ascii_case("application/json"))
}

fn header_str<'a>(headers: &'a HeaderMap, name: &'static str) -> Option<&'a str> {
    headers
        .get(HeaderName::from_static(name))
        .and_then(|v| v.to_str().ok())
}

/// `POST /mcp`.
async fn handle(State(state): State<AppState>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    if parts.method != Method::POST {
        return method_not_allowed("this MCP endpoint takes POST requests only");
    }
    if !origin_allowed(&state, &parts.headers) {
        return refuse(
            StatusCode::FORBIDDEN,
            SERVER_REFUSAL,
            "this Origin is not allowed to use the MCP endpoint (set OPENBASE_MCP_ALLOWED_ORIGINS to allow it)",
        );
    }

    // Authentication: bearer tokens only (personal access tokens and OAuth access tokens).
    // Cookies are never looked at.
    let Some(token) = bearer_from_headers(&parts.headers).map(str::to_string) else {
        let has_cookie = parts.headers.contains_key(header::COOKIE);
        return unauthorized(
            &state,
            if has_cookie {
                "the MCP endpoint accepts bearer tokens only (Authorization: Bearer <token>); session cookies are not accepted"
            } else {
                "authentication required: send a personal access token or an OAuth access token as Authorization: Bearer <token>"
            },
            false,
        );
    };
    let lookup = token.clone();
    let oauth_token = token.starts_with(OAUTH_ACCESS_PREFIX);
    let found = if oauth_token {
        // OAuth tokens count only while OAuth is available (not over plain http on a public
        // host) and only when issued for this endpoint.
        if state.config.oauth_enabled() {
            let resource = state.config.mcp_resource();
            state
                .db
                .read(move |c| lookup_oauth_token(c, &lookup, &resource))
                .await
        } else {
            Ok(None)
        }
    } else {
        state.db.read(move |c| lookup_api_token(c, &lookup)).await
    };
    let found = match found {
        Ok(found) => found,
        Err(e) => return e.into_response(),
    };
    let Some((actor, last_used_at)) = found else {
        return unauthorized(&state, "the access token is invalid or expired", true);
    };
    // Limits apply to valid tokens only, which keeps the limiter's memory bounded by the number
    // of tokens (same approach as /api/v1).
    let second = std::time::Duration::from_secs(1);
    // (An OAuth grant is limited as a whole, not per access token: tokens rotate every hour.)
    let token_key = actor
        .oauth_grant_id
        .clone()
        .unwrap_or_else(|| hash_token(&token));
    let limited = state
        .limiter
        .check(
            "mcp_token",
            &token_key,
            state.config.mcp_rate_per_token,
            second,
        )
        .and_then(|()| {
            state.limiter.check(
                "mcp_user",
                &actor.user_id,
                state.config.mcp_rate_per_user,
                second,
            )
        });
    if limited.is_err() {
        let mut res = refuse(
            StatusCode::TOO_MANY_REQUESTS,
            SERVER_REFUSAL,
            "rate limit reached: slow down and retry in a moment",
        );
        res.headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        return res;
    }
    if actor.oauth_grant_id.is_some() {
        stamp_grant_use(&state, &actor, last_used_at).await;
    } else {
        stamp_token_use(&state, &actor, last_used_at).await;
    }

    if !is_json_content_type(&parts.headers) {
        return refuse(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            INVALID_REQUEST,
            "send the JSON-RPC message with Content-Type: application/json",
        );
    }
    if !accepts_json(&parts.headers) {
        return refuse(
            StatusCode::NOT_ACCEPTABLE,
            INVALID_REQUEST,
            "this endpoint answers with application/json; include it in the Accept header",
        );
    }
    let declared = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    let too_big = || {
        refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            SERVER_REFUSAL,
            &format!(
                "request body is larger than {} MB",
                MAX_BODY_BYTES / (1024 * 1024)
            ),
        )
    };
    if declared.is_some_and(|n| n > MAX_BODY_BYTES) {
        return too_big();
    }
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY_BYTES).await else {
        return too_big();
    };

    let ctx = McpCtx {
        ip: client_ip(&parts, state.config.trust_proxy),
        peer: parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0),
        user_agent: parts
            .headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.chars().take(200).collect()),
        state,
        actor,
        token,
    };
    let (status, body, scope_challenge) = process(&ctx, &parts.headers, &bytes).await;
    match body {
        Some(body) => {
            let mut res = json_response(status, &body);
            if let Some(scope) = scope_challenge {
                res.headers_mut().insert(
                    header::WWW_AUTHENTICATE,
                    challenge(
                        &ctx.state,
                        Some((
                            "insufficient_scope",
                            "The access token does not allow this tool",
                        )),
                        Some(&scope),
                    ),
                );
            }
            res
        }
        None => {
            let mut res = Response::new(Body::empty());
            *res.status_mut() = status;
            res
        }
    }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC processing

type RpcError = (i64, String, Option<Value>);

fn error(code: i64, message: impl Into<String>) -> RpcError {
    (code, message.into(), None)
}

fn supported_versions() -> Vec<&'static str> {
    MODERN_VERSIONS
        .iter()
        .chain(LEGACY_VERSIONS)
        .copied()
        .collect()
}

/// `=?base64?...?=` header values (MCP spec, value encoding) back to text.
fn decode_header_value(raw: &str) -> Option<String> {
    match raw
        .strip_prefix("=?base64?")
        .and_then(|r| r.strip_suffix("?="))
    {
        Some(b64) => {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
            String::from_utf8(bytes).ok()
        }
        None => Some(raw.to_string()),
    }
}

/// Parse and answer one POST body. Returns the HTTP status and the JSON body (None = empty), and
/// the scope to name in a `403 insufficient_scope` challenge when that is the answer.
pub async fn process(
    ctx: &McpCtx,
    headers: &HeaderMap,
    bytes: &[u8],
) -> (StatusCode, Option<Value>, Option<String>) {
    if let Some((message, scope)) = insufficient_scope(ctx, bytes) {
        return (
            StatusCode::FORBIDDEN,
            Some(rpc_body(Value::Null, Err((SERVER_REFUSAL, message, None)))),
            Some(scope),
        );
    }
    let (status, body) = process_message(ctx, headers, bytes).await;
    (status, body, None)
}

/// MCP authorization, scope challenges: an OAuth access token that calls a tool its scope does
/// not allow is answered `403` with `error="insufficient_scope"` and the scope that would be
/// enough, so a client can send the user through the consent step again with more access.
/// (Personal access tokens keep getting a tool error that names the permission they lack.)
fn insufficient_scope(ctx: &McpCtx, bytes: &[u8]) -> Option<(String, String)> {
    ctx.actor.oauth_grant_id.as_ref()?;
    // Cheap pre-check, so that the large bodies of other calls (uploads) are not parsed twice.
    if !bytes
        .windows(b"tools/call".len())
        .any(|w| w == b"tools/call")
    {
        return None;
    }
    let msg: Value = serde_json::from_slice(bytes).ok()?;
    if msg.get("method").and_then(Value::as_str) != Some("tools/call") {
        return None;
    }
    let name = msg.get("params")?.get("name")?.as_str()?;
    let level = tools::required_level(name)?;
    let needed = level.missing_scope(&ctx.actor)?;
    Some((
        format!(
            "The tool '{name}' needs more access than this connection was given ({needed}). \
             Reconnect the app and choose more access on the approval page."
        ),
        needed.to_string(),
    ))
}

async fn process_message(
    ctx: &McpCtx,
    headers: &HeaderMap,
    bytes: &[u8],
) -> (StatusCode, Option<Value>) {
    let msg: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Some(rpc_body(
                    Value::Null,
                    Err(error(PARSE_ERROR, format!("invalid JSON: {e}"))),
                )),
            );
        }
    };
    let invalid = |message: &str| {
        (
            StatusCode::BAD_REQUEST,
            Some(rpc_body(Value::Null, Err(error(INVALID_REQUEST, message)))),
        )
    };
    let Some(obj) = msg.as_object() else {
        return invalid(if msg.is_array() {
            "JSON-RPC batches are not supported: send one message per POST"
        } else {
            "the body must be a single JSON-RPC message (an object)"
        });
    };
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return invalid("\"jsonrpc\" must be \"2.0\"");
    }
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        // A response from the client to a server request: we never send any, accept and ignore.
        if obj.contains_key("result") || obj.contains_key("error") {
            return (StatusCode::ACCEPTED, None);
        }
        return invalid("a JSON-RPC message needs a string \"method\"");
    };
    let id = match obj.get("id") {
        None => None,
        Some(id @ (Value::String(_) | Value::Number(_))) => Some(id.clone()),
        Some(_) => return invalid("\"id\" must be a string or a number"),
    };
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    if !(params.is_null() || params.is_object()) {
        return (
            StatusCode::BAD_REQUEST,
            Some(rpc_body(
                id.unwrap_or(Value::Null),
                Err(error(INVALID_PARAMS, "\"params\" must be an object")),
            )),
        );
    }
    let Some(id) = id else {
        // A notification (initialized, cancelled, ...): accepted, no body.
        return (StatusCode::ACCEPTED, None);
    };

    // Which era is the client speaking?
    let meta_version = params
        .get("_meta")
        .and_then(|m| m.get(META_VERSION))
        .and_then(Value::as_str);
    let modern = meta_version.is_some();
    let header_version = header_str(headers, "mcp-protocol-version");
    if modern {
        if let Err((status, e)) = check_modern_headers(headers, method, &params, meta_version) {
            return (status, Some(rpc_body(id, Err(e))));
        }
    } else if let Some(v) = header_version {
        if !supported_versions().contains(&v) {
            return (
                StatusCode::BAD_REQUEST,
                Some(rpc_body(
                    id,
                    Err((
                        UNSUPPORTED_VERSION,
                        "Unsupported protocol version".into(),
                        Some(json!({ "supported": supported_versions(), "requested": v })),
                    )),
                )),
            );
        }
        if MODERN_VERSIONS.contains(&v) {
            return (
                StatusCode::BAD_REQUEST,
                Some(rpc_body(
                    id,
                    Err(error(
                        HEADER_MISMATCH,
                        format!(
                            "MCP-Protocol-Version {v} requires _meta[\"{META_VERSION}\"] in params"
                        ),
                    )),
                )),
            );
        }
    }
    let version = meta_version
        .or(header_version)
        .unwrap_or(ASSUMED_VERSION)
        .to_string();
    tracing::debug!(method, version = %version, "mcp request");

    let result = dispatch(ctx, method, &params, modern).await;
    let status = match &result {
        Err((METHOD_NOT_FOUND, ..)) if modern => StatusCode::NOT_FOUND,
        _ => StatusCode::OK,
    };
    (status, Some(rpc_body(id, result)))
}

/// A modern request must repeat its version, method and (for tool calls) tool name in headers.
fn check_modern_headers(
    headers: &HeaderMap,
    method: &str,
    params: &Value,
    meta_version: Option<&str>,
) -> Result<(), (StatusCode, RpcError)> {
    let version = meta_version.unwrap_or_default();
    if !MODERN_VERSIONS.contains(&version) {
        return Err((
            StatusCode::BAD_REQUEST,
            (
                UNSUPPORTED_VERSION,
                "Unsupported protocol version".into(),
                Some(json!({ "supported": supported_versions(), "requested": version })),
            ),
        ));
    }
    let mismatch = |why: String| {
        Err((
            StatusCode::BAD_REQUEST,
            error(HEADER_MISMATCH, format!("Header mismatch: {why}")),
        ))
    };
    match header_str(headers, "mcp-protocol-version") {
        None => return mismatch("the MCP-Protocol-Version header is missing".into()),
        Some(h) if h != version => {
            return mismatch(format!(
                "MCP-Protocol-Version header {h:?} does not match _meta {version:?}"
            ));
        }
        Some(_) => {}
    }
    match header_str(headers, "mcp-method") {
        None => return mismatch("the Mcp-Method header is missing".into()),
        Some(h) if h != method => {
            return mismatch(format!(
                "Mcp-Method header {h:?} does not match the method {method:?}"
            ));
        }
        Some(_) => {}
    }
    if method == "tools/call" {
        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
        match header_str(headers, "mcp-name").map(decode_header_value) {
            None => return mismatch("the Mcp-Name header is missing".into()),
            Some(None) => return mismatch("the Mcp-Name header is not valid".into()),
            Some(Some(h)) if h != name => {
                return mismatch(format!(
                    "Mcp-Name header {h:?} does not match the tool name {name:?}"
                ));
            }
            Some(Some(_)) => {}
        }
    }
    Ok(())
}

fn server_info() -> Value {
    json!({
        "name": "openbase",
        "title": "OpenBase",
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// Decorate a result for the era: modern results carry `resultType` and the server's identity.
fn finish(mut result: Value, modern: bool) -> Value {
    if modern && let Some(o) = result.as_object_mut() {
        o.insert("resultType".into(), json!("complete"));
        let meta = o.entry("_meta").or_insert_with(|| json!({}));
        if let Some(m) = meta.as_object_mut() {
            m.insert(META_SERVER_INFO.into(), server_info());
        }
    }
    result
}

async fn dispatch(
    ctx: &McpCtx,
    method: &str,
    params: &Value,
    modern: bool,
) -> Result<Value, RpcError> {
    match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .ok_or_else(|| error(INVALID_PARAMS, "initialize needs params.protocolVersion"))?;
            // Echo the client's version when we speak it, else propose our newest handshake
            // revision (the client then decides whether it can use it).
            let version = if LEGACY_VERSIONS.contains(&requested) {
                requested
            } else {
                LEGACY_VERSIONS[0]
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": server_info(),
                "instructions": INSTRUCTIONS,
            }))
        }
        "server/discover" => Ok(finish(
            json!({
                "supportedVersions": supported_versions(),
                "capabilities": { "tools": { "listChanged": false } },
                "instructions": INSTRUCTIONS,
                "ttlMs": 3_600_000,
                "cacheScope": "public",
            }),
            true,
        )),
        // Removed in the stateless revision but harmless: answer for old clients.
        "ping" => Ok(finish(json!({}), modern)),
        "tools/list" => {
            let cursor = params.get("cursor").and_then(Value::as_str);
            let page = tools::list_page(&ctx.actor, cursor, TOOLS_PAGE)
                .map_err(|m| error(INVALID_PARAMS, m))?;
            let mut result = json!({ "tools": page.tools });
            if let Some(next) = page.next_cursor {
                result["nextCursor"] = json!(next);
            }
            if modern {
                // The list depends on the token (scope), so it must not be shared.
                result["ttlMs"] = json!(60_000);
                result["cacheScope"] = json!("private");
            }
            Ok(finish(result, modern))
        }
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| error(INVALID_PARAMS, "tools/call needs params.name"))?;
            let args = match params.get("arguments") {
                None | Some(Value::Null) => Value::Object(Map::new()),
                Some(a @ Value::Object(_)) => a.clone(),
                Some(_) => return Err(error(INVALID_PARAMS, "params.arguments must be an object")),
            };
            match tools::call(ctx, name, args).await {
                None => Err(error(INVALID_PARAMS, format!("Unknown tool: {name}"))),
                Some(outcome) => Ok(finish(outcome.into_result(), modern)),
            }
        }
        other => Err(error(
            METHOD_NOT_FOUND,
            format!("Method not found: {other}"),
        )),
    }
}
