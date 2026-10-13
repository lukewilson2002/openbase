//! `api_request`: run a request of the internal REST API *inside the process* through the real
//! axum router, with the caller's own bearer token attached.
//!
//! Nothing is re-implemented: the request meets the same middleware, the same `Actor`
//! extraction (token scope, read-only enforcement, token-use stamping), the same handler
//! permission checks, validation, events and automations as a browser's. This module only
//! guards what must not be reachable from an agent at all (see [`catalogue::Access`]), builds
//! the request (including multipart bodies) and renders the response for a language model.

use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{HeaderValue, Request, header};
use base64::Engine;
use http_body_util::BodyExt;
use serde_json::{Map, Value, json};
use tower::ServiceExt;

use super::McpCtx;
use super::catalogue;
use super::tools::{MAX_RESULT_BYTES, truncate};

/// An in-process request is abandoned after this long.
const TIMEOUT: Duration = Duration::from_secs(120);
/// At most this much of a response body is read, however large it is.
const READ_CAP: usize = 1024 * 1024;
/// Binary bodies up to this size are returned base64-encoded; larger ones are only described.
const MAX_BINARY_RETURN: usize = 64 * 1024;
const MAX_PATH_LEN: usize = 1024;

/// The decoded arguments of `api_request`.
pub struct ApiCall {
    pub method: String,
    pub path: String,
    pub query: Option<Value>,
    pub body: Option<Value>,
}

/// A response, ready to show to the model.
pub struct ApiResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Option<Value>,
    pub text: Option<String>,
    pub body_base64: Option<String>,
    pub truncated: bool,
    pub note: Option<String>,
}

impl ApiResponse {
    pub fn ok(&self) -> bool {
        self.status < 400
    }

    pub fn to_json(&self) -> Value {
        let mut out = json!({ "status": self.status, "ok": self.ok() });
        let o = out.as_object_mut().expect("object");
        if let Some(ct) = &self.content_type {
            o.insert("content_type".into(), json!(ct));
        }
        if let Some(b) = &self.body {
            o.insert("body".into(), b.clone());
        }
        if let Some(t) = &self.text {
            o.insert("text".into(), json!(t));
        }
        if let Some(b) = &self.body_base64 {
            o.insert("body_base64".into(), json!(b));
        }
        if self.truncated {
            o.insert("truncated".into(), json!(true));
        }
        if let Some(n) = &self.note {
            o.insert("note".into(), json!(n));
        }
        out
    }

    /// The error message of a failed response (`{"error": {"message"}}`), if any.
    pub fn error_message(&self) -> Option<String> {
        let b = self.body.as_ref()?;
        let e = b.get("error")?;
        let msg = e.get("message").and_then(Value::as_str)?;
        Some(match e.get("code").and_then(Value::as_str) {
            Some(code) => format!("{msg} ({code})"),
            None => msg.to_string(),
        })
    }
}

const METHODS: &[&str] = &["GET", "POST", "PATCH", "PUT", "DELETE"];

/// Reject paths that are not plain `/api/...` request paths. Only exact, normalized paths are
/// forwarded, so the catalogue check and the router always agree on what a path means.
pub fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with("/api/") {
        return Err(format!(
            "path must start with /api/ (got {path:?}). Call api_reference to see the available endpoints."
        ));
    }
    if path.len() > MAX_PATH_LEN {
        return Err("path is too long".into());
    }
    if path.contains(['?', '#']) {
        return Err("put the query string in the `query` argument, not in the path".into());
    }
    if path
        .chars()
        .any(|c| c.is_control() || c == '\\' || c == ' ')
    {
        return Err("path contains forbidden characters (spaces, control characters, backslashes); percent-encode them".into());
    }
    for segment in path.split('/').skip(1) {
        if segment.is_empty() {
            return Err("path contains an empty segment (//) or ends with /".into());
        }
        let decoded = percent_decode(segment);
        if decoded == "." || decoded == ".." || decoded.contains(['/', '\\']) {
            return Err("path segments may not be . or .. or contain encoded slashes".into());
        }
    }
    Ok(())
}

pub(super) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `query` (an object) to a URL query string. Arrays repeat the key.
pub fn query_string(query: &Value) -> Result<String, String> {
    let Some(map) = query.as_object() else {
        return Err("`query` must be an object of parameter names to values".into());
    };
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in map {
        let mut add = |value: &Value| -> Result<(), String> {
            match value {
                Value::String(s) => {
                    ser.append_pair(k, s);
                }
                Value::Number(n) => {
                    ser.append_pair(k, &n.to_string());
                }
                Value::Bool(b) => {
                    ser.append_pair(k, &b.to_string());
                }
                Value::Null => {}
                _ => {
                    return Err(format!(
                        "query parameter {k:?} must be a string, number, boolean or a list of those"
                    ));
                }
            }
            Ok(())
        };
        match v {
            Value::Array(items) => {
                for item in items {
                    add(item)?;
                }
            }
            other => add(other)?,
        }
    }
    Ok(ser.finish())
}

/// A multipart body from `{"multipart": {"file": {"filename", "content_base64" | "text",
/// "content_type"?}, "<field>": "text"}}`. Returns (boundary, body).
pub fn build_multipart(spec: &Map<String, Value>) -> Result<(String, Vec<u8>), String> {
    if spec.is_empty() {
        return Err("multipart needs at least one part".into());
    }
    let boundary = format!("----openbase-mcp-{}", crate::ids::new_id("b"));
    let mut body: Vec<u8> = Vec::new();
    for (name, part) in spec {
        check_token(name, "multipart part name")?;
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match part {
            Value::String(text) => {
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                );
                body.extend_from_slice(text.as_bytes());
            }
            Value::Number(_) | Value::Bool(_) => {
                body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n{part}")
                        .as_bytes(),
                );
            }
            Value::Object(file) => {
                let filename = file
                    .get("filename")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("part {name:?}: a file needs a \"filename\""))?;
                check_token(filename, "filename")?;
                let content_type = file
                    .get("content_type")
                    .and_then(Value::as_str)
                    .unwrap_or("application/octet-stream");
                check_token(content_type, "content_type")?;
                let bytes = match (file.get("content_base64"), file.get("text")) {
                    (Some(Value::String(b64)), None) => base64::engine::general_purpose::STANDARD
                        .decode(b64.trim())
                        .map_err(|e| {
                            format!("part {name:?}: content_base64 is not valid base64 ({e})")
                        })?,
                    (None, Some(Value::String(text))) => text.clone().into_bytes(),
                    _ => {
                        return Err(format!(
                            "part {name:?}: give exactly one of \"content_base64\" or \"text\""
                        ));
                    }
                };
                body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
                    )
                    .as_bytes(),
                );
                body.extend_from_slice(&bytes);
            }
            _ => {
                return Err(format!(
                    "part {name:?} must be a string or a file object {{\"filename\", \"text\" | \"content_base64\"}}"
                ));
            }
        }
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((boundary, body))
}

/// Names that go inside quoted header parameters must not break out of them.
fn check_token(s: &str, what: &str) -> Result<(), String> {
    if s.is_empty() || s.len() > 255 || s.chars().any(|c| c.is_control() || c == '"' || c == '\\') {
        return Err(format!(
            "{what} must be 1-255 characters without quotes, backslashes or control characters"
        ));
    }
    Ok(())
}

/// Check a call before anything is sent: method, path shape, and endpoints agents may not use.
pub fn preflight(call: &ApiCall) -> Result<(String, String), String> {
    let method = call.method.trim().to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(format!(
            "method must be one of {} (got {:?})",
            METHODS.join(", "),
            call.method
        ));
    }
    validate_path(&call.path)?;
    if let Some(ep) = catalogue::find(&method, &call.path)
        && ep.access.blocked_for_agents()
    {
        return Err(match ep.access {
            catalogue::Access::SessionOnly => format!(
                "{method} {} is not available through MCP: it deals with credentials, sessions \
                 or API tokens, which only a signed-in user can reach in the web app.",
                ep.path
            ),
            _ => format!(
                "{method} {} is not available through MCP: {}",
                ep.path, ep.summary
            ),
        });
    }
    if call.body.is_some() && method == "GET" {
        return Err("GET requests cannot have a body; use `query` for parameters".into());
    }
    Ok((method, call.path.clone()))
}

/// Run `call` through the application router as the caller.
pub async fn execute(ctx: &McpCtx, call: ApiCall) -> Result<ApiResponse, String> {
    execute_with(ctx, call, MAX_RESULT_BYTES, false).await
}

/// [`execute`] with a custom cap on returned text; with `plain_cut` an over-long text is cut at
/// a character boundary without the in-band "[truncated ...]" note (the response still says
/// `truncated`), for callers that return the text itself, such as CSV exports.
pub async fn execute_with(
    ctx: &McpCtx,
    call: ApiCall,
    text_cap: usize,
    plain_cut: bool,
) -> Result<ApiResponse, String> {
    let (method, path) = preflight(&call)?;
    let uri = match &call.query {
        None | Some(Value::Null) => path.clone(),
        Some(q) => {
            let qs = query_string(q)?;
            if qs.is_empty() {
                path.clone()
            } else {
                format!("{path}?{qs}")
            }
        }
    };

    let mut builder = Request::builder()
        .method(method.as_str())
        .uri(&uri)
        .header(
            header::USER_AGENT,
            HeaderValue::from_str(&format!(
                "openbase-mcp ({})",
                ctx.user_agent.as_deref().unwrap_or("unknown client")
            ))
            .unwrap_or_else(|_| HeaderValue::from_static("openbase-mcp")),
        )
        .header(
            header::ACCEPT,
            "application/json, text/plain;q=0.9, */*;q=0.1",
        );
    // The audit log and rate limits of the handlers see the agent's real address.
    if ctx.state.config.trust_proxy
        && ctx.ip.parse::<std::net::IpAddr>().is_ok()
        && let Ok(v) = HeaderValue::from_str(&ctx.ip)
    {
        builder = builder.header("x-forwarded-for", v);
    }

    let body = match &call.body {
        None | Some(Value::Null) => Body::empty(),
        Some(Value::Object(o)) if o.len() == 1 && o.contains_key("multipart") => {
            let Some(spec) = o["multipart"].as_object() else {
                return Err("\"multipart\" must be an object of parts".into());
            };
            let (boundary, bytes) = build_multipart(spec)?;
            builder = builder.header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            );
            builder = builder.header(header::CONTENT_LENGTH, bytes.len());
            Body::from(bytes)
        }
        Some(json_body) => {
            let bytes = serde_json::to_vec(json_body).map_err(|e| e.to_string())?;
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            builder = builder.header(header::CONTENT_LENGTH, bytes.len());
            Body::from(bytes)
        }
    };
    // A personal access token goes along as the `Authorization` header it came in. An OAuth
    // access token is valid on /mcp only and is never sent to /api/*: the router is told who
    // the caller is instead (see `TrustedActor`).
    if ctx.actor.oauth_grant_id.is_none() {
        builder = builder.header(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", ctx.token))
                .map_err(|_| "the API token cannot be used in a header".to_string())?,
        );
    }
    let mut req = builder
        .body(body)
        .map_err(|e| format!("could not build the request: {e}"))?;
    if ctx.actor.oauth_grant_id.is_some() {
        req.extensions_mut()
            .insert(crate::auth::TrustedActor(ctx.actor.clone()));
    }
    if let Some(peer) = ctx.peer {
        req.extensions_mut().insert(ConnectInfo(peer));
    }

    let Some(router) = ctx.state.app_router.get() else {
        return Err("the application router is not ready".into());
    };
    let res = tokio::time::timeout(TIMEOUT, router.clone().oneshot(req))
        .await
        .map_err(|_| {
            format!(
                "the request did not finish within {} seconds",
                TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("request failed: {e}"))?;
    render(res, text_cap, plain_cut).await
}

fn is_json(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or("").trim();
    ct == "application/json" || ct.ends_with("+json")
}

fn is_text(ct: &str) -> bool {
    let ct = ct.split(';').next().unwrap_or("").trim();
    ct.starts_with("text/") || ct == "application/xml" || ct.ends_with("+xml")
}

async fn render(
    res: axum::response::Response,
    text_cap: usize,
    plain_cut: bool,
) -> Result<ApiResponse, String> {
    let (parts, mut body) = res.into_parts();
    let content_type = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let declared_len = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    let mut bytes: Vec<u8> = Vec::new();
    let mut cut = false;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| format!("could not read the response: {e}"))?;
        if let Some(data) = frame.data_ref() {
            let room = READ_CAP - bytes.len();
            if data.len() > room {
                bytes.extend_from_slice(&data[..room]);
                cut = true;
                break;
            }
            bytes.extend_from_slice(data);
        }
    }
    let mut out = ApiResponse {
        status: parts.status.as_u16(),
        content_type: content_type.clone(),
        body: None,
        text: None,
        body_base64: None,
        truncated: false,
        note: None,
    };
    if bytes.is_empty() && !cut {
        return Ok(out);
    }
    let ct = content_type.as_deref().unwrap_or("");
    if is_json(ct) || is_text(ct) || ct.is_empty() {
        let text = String::from_utf8_lossy(&bytes);
        if !cut && text.len() <= text_cap {
            if is_json(ct)
                && let Ok(v) = serde_json::from_str::<Value>(&text)
            {
                out.body = Some(v);
            } else {
                out.text = Some(text.into_owned());
            }
        } else {
            out.text = Some(if plain_cut {
                let mut end = text_cap.min(text.len());
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                text[..end].to_string()
            } else {
                truncate(&text, text_cap)
            });
            out.truncated = true;
            out.note = Some(
                "the response is larger than what is returned; narrow the request (smaller \
                 limit, filters, specific ids)"
                    .into(),
            );
        }
    } else if !cut && bytes.len() <= MAX_BINARY_RETURN {
        out.body_base64 = Some(base64::engine::general_purpose::STANDARD.encode(&bytes));
    } else {
        out.truncated = true;
        let size = declared_len
            .map(|n| format!("{n} bytes"))
            .unwrap_or_else(|| format!("more than {READ_CAP} bytes"));
        out.note = Some(format!(
            "binary response ({ct}, {size}) is not returned through MCP; \
             files over {} KB cannot be fetched this way",
            MAX_BINARY_RETURN / 1024
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_validated() {
        for ok in [
            "/api/bases/appX",
            "/api/v1/appX/Tasks/recY",
            "/api/attachments/att1/my%20file.png",
        ] {
            assert!(validate_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "/mcp",
            "api/bases",
            "/apix/bases",
            "/api/bases?x=1",
            "/api/bases#x",
            "/api/../mcp",
            "/api/%2e%2e/mcp",
            "/api/bases/%2e",
            "/api/a%2Fb",
            "/api//bases",
            "/api/bases/",
            "/api/ba ses",
            "/api/ba\\ses",
            "/api/ba\nses",
        ] {
            assert!(validate_path(bad).is_err(), "{bad}");
        }
        assert!(validate_path(&format!("/api/{}", "a".repeat(2000))).is_err());
    }

    #[test]
    fn preflight_blocks_what_agents_may_not_call() {
        let call = |m: &str, p: &str| ApiCall {
            method: m.into(),
            path: p.into(),
            query: None,
            body: None,
        };
        assert!(preflight(&call("get", "/api/bases/appX")).is_ok());
        for (m, p) in [
            ("POST", "/api/auth/password"),
            ("GET", "/api/tokens"),
            ("DELETE", "/api/tokens/patX"),
            ("GET", "/api/auth/sessions"),
            ("POST", "/api/auth/login"),
            ("GET", "/api/bases/appX/events"),
        ] {
            let err = preflight(&call(m, p)).unwrap_err();
            assert!(err.contains("not available through MCP"), "{m} {p}: {err}");
        }
        assert!(preflight(&call("GET", "/api/tokens/whoami")).is_ok());
        assert!(preflight(&call("TRACE", "/api/bases/appX")).is_err());
        assert!(preflight(&call("HEAD", "/api/health")).is_err());
        let mut with_body = call("GET", "/api/bases/appX");
        with_body.body = Some(json!({}));
        assert!(
            preflight(&with_body)
                .unwrap_err()
                .contains("cannot have a body")
        );
    }

    #[test]
    fn query_strings_are_encoded() {
        let qs = query_string(
            &json!({"q": "a b&c", "limit": 5, "on": true, "ids": ["x", "y"], "skip": null}),
        )
        .unwrap();
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(qs.as_bytes())
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        assert!(pairs.contains(&("q".into(), "a b&c".into())));
        assert!(pairs.contains(&("limit".into(), "5".into())));
        assert!(pairs.contains(&("on".into(), "true".into())));
        assert_eq!(pairs.iter().filter(|(k, _)| k == "ids").count(), 2);
        assert!(!pairs.iter().any(|(k, _)| k == "skip"));
        assert!(query_string(&json!({"a": {"b": 1}})).is_err());
        assert!(query_string(&json!("x")).is_err());
    }

    #[test]
    fn multipart_bodies_are_built_safely() {
        let spec = json!({
            "file": {"filename": "a.csv", "text": "x,y\n1,2\n", "content_type": "text/csv"},
            "name": "People",
            "has_header": true,
        });
        let (boundary, body) = build_multipart(spec.as_object().unwrap()).unwrap();
        let text = String::from_utf8(body).unwrap();
        assert!(text.contains(&format!("--{boundary}\r\n")));
        assert!(text.contains(
            "name=\"file\"; filename=\"a.csv\"\r\nContent-Type: text/csv\r\n\r\nx,y\n1,2\n\r\n"
        ));
        assert!(text.contains("name=\"name\"\r\n\r\nPeople\r\n"));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));

        let b64 = base64::engine::general_purpose::STANDARD.encode([0u8, 1, 2, 255]);
        let (_, body) = build_multipart(
            json!({"file": {"filename": "b.bin", "content_base64": b64}})
                .as_object()
                .unwrap(),
        )
        .unwrap();
        assert!(body.windows(4).any(|w| w == [0u8, 1, 2, 255]));

        for bad in [
            json!({}),
            json!({"file": {"text": "x"}}),
            json!({"file": {"filename": "a\"b", "text": "x"}}),
            json!({"file": {"filename": "a", "text": "x", "content_base64": "eA=="}}),
            json!({"file": {"filename": "a", "content_base64": "!!!"}}),
            json!({"na\"me": "x"}),
            json!({"x": [1]}),
        ] {
            assert!(build_multipart(bad.as_object().unwrap()).is_err(), "{bad}");
        }
    }
}
