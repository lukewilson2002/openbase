//! File downloads behind the SSRF guard, for the MCP `upload_attachment` tool.
//!
//! Same protections as the `http_request` action ([`super::http`], [`super::ssrf`]): only
//! http(s), no credentials in the URL, the host is resolved by us and every address checked
//! (loopback, private, link-local, ... refused unless the operator allows private webhooks),
//! the connection is pinned to the checked addresses, redirects are never followed and the
//! system proxy is ignored. On top of that the body is read only up to a byte limit; a longer
//! file is refused, never cut.

use std::time::Duration;

use super::http::{HttpError, TIMEOUT, USER_AGENT, describe, transient_status};
use super::ssrf::{self, Resolver};

/// How long a whole download may take (the 10 second limit of an API call is too short).
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// A fetched file.
#[derive(Debug, Clone)]
pub struct Download {
    pub bytes: Vec<u8>,
    /// The `Content-Type` header without parameters, lower-cased.
    pub content_type: Option<String>,
}

/// Fetch `url` with `GET` using the system resolver.
pub async fn download(
    url: &str,
    allow_private: bool,
    max_bytes: u64,
) -> Result<Download, HttpError> {
    download_with(url, allow_private, max_bytes, &ssrf::SystemResolver).await
}

/// Like [`download`] with an explicit resolver (tests).
pub async fn download_with(
    url: &str,
    allow_private: bool,
    max_bytes: u64,
    resolver: &dyn Resolver,
) -> Result<Download, HttpError> {
    let refuse = |message: String| HttpError {
        message,
        transient: false,
    };
    let vetted = ssrf::vet_with(url, allow_private, resolver).await?;
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(DOWNLOAD_TIMEOUT)
        .connect_timeout(TIMEOUT);
    if let Some((domain, addrs)) = &vetted.pinned {
        builder = builder.resolve_to_addrs(domain, addrs);
    }
    let client = builder
        .build()
        .map_err(|e| refuse(format!("could not create HTTP client: {e}")))?;
    let mut resp = client
        .get(vetted.url.clone())
        .send()
        .await
        .map_err(describe)?;
    let status = resp.status();
    if status.is_redirection() {
        return Err(refuse(format!(
            "the server answered {} (a redirect); redirects are not followed, use the final URL",
            status.as_u16()
        )));
    }
    if !status.is_success() {
        return Err(HttpError {
            message: format!("the server answered {}", status.as_u16()),
            transient: transient_status(status.as_u16()),
        });
    }
    let too_big = || {
        refuse(format!(
            "the file is larger than the upload limit of {} MB",
            max_bytes / (1024 * 1024)
        ))
    };
    if resp.content_length().is_some_and(|n| n > max_bytes) {
        return Err(too_big());
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        })
        .filter(|v| !v.is_empty());
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(describe)? {
        if bytes.len() as u64 + chunk.len() as u64 > max_bytes {
            return Err(too_big());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Download {
        bytes,
        content_type,
    })
}
