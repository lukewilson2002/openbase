//! The HTTP client behind the `http_request` action.
//!
//! Every request goes through the SSRF guard in [`super::ssrf`]: the target is
//! resolved and vetted first, then the connection is pinned to the vetted
//! addresses. Redirects are not followed and the system proxy is ignored (a
//! proxy would resolve names itself and bypass the pinning). Requests time out
//! after 10 seconds and only the first 256 KB of a response is kept.

use std::time::Duration;

use og_core::api::automations::HttpMethod;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value as Json;

use super::ssrf::{self, Resolver, SsrfError};

pub const USER_AGENT: &str = "OpenGrid-Automations";
pub const TIMEOUT: Duration = Duration::from_secs(10);
/// Bytes of a response body that are kept.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// Largest request body an action may send.
pub const MAX_REQUEST_BODY_BYTES: usize = 256 * 1024;
pub const MAX_HEADERS: usize = 20;

/// Headers the client sets itself.
const RESERVED_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "user-agent",
    "te",
    "trailer",
    "upgrade",
];

/// A request ready to send (templates already rendered).
#[derive(Debug, Clone)]
pub struct Request {
    pub method: HttpMethod,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// The response, with the body cut at [`MAX_RESPONSE_BYTES`].
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: String,
    pub truncated: bool,
    /// The body parsed as JSON, when it is (and was not truncated).
    pub json: Option<Json>,
}

/// Why a request did not produce a response.
#[derive(Debug, Clone)]
pub struct HttpError {
    pub message: String,
    /// Worth retrying (network trouble, timeouts) as opposed to refused.
    pub transient: bool,
}

impl From<SsrfError> for HttpError {
    fn from(e: SsrfError) -> Self {
        HttpError {
            transient: e.is_transient(),
            message: e.to_string(),
        }
    }
}

/// Check a header name/value pair; returns a user-facing reason when refused.
pub fn check_header(name: &str, value: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    if RESERVED_HEADERS.contains(&lower.as_str()) {
        return Err(format!(
            "the {name} header is set by OpenGrid and cannot be overridden"
        ));
    }
    HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| format!("invalid header name \"{name}\""))?;
    HeaderValue::from_str(value).map_err(|_| format!("invalid value for header \"{name}\""))?;
    Ok(())
}

/// Send `req` through the guard using the system resolver.
pub async fn send(req: Request, allow_private: bool) -> Result<Response, HttpError> {
    send_with(req, allow_private, &ssrf::SystemResolver).await
}

/// Like [`send`] with an explicit resolver (tests).
pub async fn send_with(
    req: Request,
    allow_private: bool,
    resolver: &dyn Resolver,
) -> Result<Response, HttpError> {
    let vetted = ssrf::vet_with(&req.url, allow_private, resolver).await?;

    let mut headers = HeaderMap::new();
    for (name, value) in &req.headers {
        check_header(name, value).map_err(|m| HttpError {
            message: m,
            transient: false,
        })?;
        // check_header validated both.
        if let (Ok(n), Ok(v)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            headers.append(n, v);
        }
    }

    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(TIMEOUT)
        .connect_timeout(TIMEOUT);
    if let Some((domain, addrs)) = &vetted.pinned {
        builder = builder.resolve_to_addrs(domain, addrs);
    }
    let client = builder.build().map_err(|e| HttpError {
        message: format!("could not create HTTP client: {e}"),
        transient: false,
    })?;

    let method = match req.method {
        HttpMethod::Get => reqwest::Method::GET,
        HttpMethod::Post => reqwest::Method::POST,
        HttpMethod::Put => reqwest::Method::PUT,
        HttpMethod::Patch => reqwest::Method::PATCH,
        HttpMethod::Delete => reqwest::Method::DELETE,
    };
    let mut builder = client.request(method, vetted.url.clone()).headers(headers);
    if let Some(body) = req.body {
        builder = builder.body(body);
    }
    let mut resp = builder.send().await.map_err(describe)?;
    let status = resp.status().as_u16();

    let mut bytes: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                let room = MAX_RESPONSE_BYTES - bytes.len();
                if chunk.len() > room {
                    bytes.extend_from_slice(&chunk[..room]);
                    truncated = true;
                    break;
                }
                bytes.extend_from_slice(&chunk);
                if bytes.len() == MAX_RESPONSE_BYTES {
                    // Exactly full: there may or may not be more.
                    match resp.chunk().await {
                        Ok(Some(_)) => truncated = true,
                        Ok(None) => {}
                        Err(_) => truncated = true,
                    }
                    break;
                }
            }
            Ok(None) => break,
            Err(e) => return Err(describe(e)),
        }
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    let json = if truncated {
        None
    } else {
        serde_json::from_str(&body).ok()
    };
    Ok(Response {
        status,
        body,
        truncated,
        json,
    })
}

fn describe(e: reqwest::Error) -> HttpError {
    let transient = e.is_timeout() || e.is_connect() || e.is_request() || e.is_body();
    let message = if e.is_timeout() {
        "the request timed out".to_string()
    } else if e.is_connect() {
        "could not connect to the server".to_string()
    } else {
        // Strip the URL: it may carry a secret token in its query string.
        format!("request failed: {}", e.without_url())
    };
    HttpError { message, transient }
}

/// Whether an HTTP status is worth retrying.
pub fn transient_status(status: u16) -> bool {
    status >= 500 || status == 429 || status == 408
}
