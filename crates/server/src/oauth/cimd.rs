//! OAuth Client ID Metadata Documents: the `client_id` is an HTTPS URL, and the document served
//! there describes the client (name, redirect URIs). Apps that publish one (Claude's "published
//! identity") need no registration step.
//!
//! The URL is chosen by whoever starts an authorization request, so fetching it is a server-side
//! request forgery risk. It goes through the same guard as automations' HTTP requests and file
//! downloads ([`crate::automations::download`]): http(s) only, no credentials in the URL, the
//! host is resolved by us and every address checked (no loopback, private or link-local
//! targets), the connection is pinned to the checked addresses and redirects are never followed.
//! Unlike automations, this guard is **never** relaxed by `OPENBASE_ALLOW_PRIVATE_WEBHOOKS`: that
//! switch is for automations calling the operator's own network, while any signed-in user can
//! make this fetch happen. The only exception is the development-only
//! `OPENBASE_OAUTH_CIMD_ALLOW_PRIVATE` ([`crate::config::Config::oauth_cimd_allow_private`]),
//! which exists for clients under development on the same machine (and for the tests).
//!
//! The fetch happens only for a signed-in user (see [`super::authorize`]), and what went wrong
//! is never shown: the person sees a generic message, the details (resolved addresses, status
//! codes, timeouts) go to the server log, so the page cannot be used to probe the internal
//! network. On top of that: a 5 second deadline, a 16 KB limit on the document, strict
//! validation, and a one hour cache in the database.

use std::time::Duration;

use serde_json::Value;

use super::redirect::MAX_REDIRECT_URI_LEN;
use super::register::{clean_name, logo_uri, redirect_uris};
use crate::db::now_ms;
use crate::state::AppState;
use crate::store::oauth::{self as store, Client, MAX_CIMD_CLIENTS, SOURCE_CIMD};

/// A fetched document is used for this long before it is fetched again.
pub const CACHE_MS: i64 = 3_600_000;
/// When fetching fails, a cached copy this young is still used.
pub const STALE_OK_MS: i64 = 24 * 3_600_000;
/// Largest document accepted.
pub const MAX_DOCUMENT_BYTES: u64 = 16 * 1024;
/// How long the whole fetch may take (the user is waiting for the consent page).
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Does this `client_id` use the metadata document form (a URL) rather than a registered id?
pub fn is_url(client_id: &str) -> bool {
    client_id.starts_with("https://") || client_id.starts_with("http://")
}

/// What the person is told when the document could not be fetched, whatever the reason.
pub const FETCH_FAILED: &str = "could not fetch the app's metadata document";

/// The URL rules of the draft, plus the loopback exception for local development
/// (`allow_private`, from `OPENBASE_OAUTH_CIMD_ALLOW_PRIVATE`).
pub fn validate_client_id(client_id: &str, allow_private: bool) -> Result<url::Url, String> {
    if client_id.len() > MAX_REDIRECT_URI_LEN {
        return Err("the client_id URL is too long".into());
    }
    let url = url::Url::parse(client_id).map_err(|_| "the client_id is not a valid URL")?;
    let loopback_http = allow_private
        && url.scheme() == "http"
        && match url.host() {
            Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        };
    if url.scheme() != "https" && !loopback_http {
        return Err("a client_id URL must use https".into());
    }
    if url.host().is_none() {
        return Err("the client_id URL needs a host".into());
    }
    if url.fragment().is_some() || client_id.contains('#') {
        return Err("a client_id URL cannot have a fragment".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("a client_id URL cannot contain a user name or password".into());
    }
    if url.path() == "/" || url.path().is_empty() {
        return Err("a client_id URL needs a path".into());
    }
    if url
        .path_segments()
        .is_some_and(|mut s| s.any(|seg| seg == "." || seg == ".."))
        || client_id.contains("/./")
        || client_id.contains("/../")
        || client_id
            .split(['?', '#'])
            .next()
            .is_some_and(|p| p.ends_with("/..") || p.ends_with("/."))
    {
        return Err("a client_id URL cannot contain . or .. path segments".into());
    }
    Ok(url)
}

/// Validate a fetched document against the `client_id` it was fetched for.
pub fn parse_document(client_id: &str, body: &[u8]) -> Result<Client, String> {
    let doc: Value = serde_json::from_slice(body)
        .map_err(|_| "the client metadata document is not valid JSON".to_string())?;
    let doc = doc
        .as_object()
        .ok_or("the client metadata document must be a JSON object")?;
    if doc.get("client_id").and_then(Value::as_str) != Some(client_id) {
        return Err("the document's client_id does not match the URL it was served from".into());
    }
    // Public clients only: a document is public, so it cannot hold a secret (draft: MUST NOT).
    if doc.contains_key("client_secret") || doc.contains_key("client_secret_expires_at") {
        return Err("a client metadata document cannot contain a client secret".into());
    }
    match doc.get("token_endpoint_auth_method") {
        None | Some(Value::Null) => {}
        Some(Value::String(m)) if m == "none" => {}
        Some(_) => {
            return Err(
                "token_endpoint_auth_method must be 'none' for a metadata document client".into(),
            );
        }
    }
    let uris = redirect_uris(doc.get("redirect_uris")).map_err(|e| e.description)?;
    let name = match doc.get("client_name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(clean_name(s)?),
        Some(_) => return Err("client_name must be a string".into()),
    };
    let name = name.unwrap_or_else(|| {
        url::Url::parse(client_id)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_else(|| super::register::DEFAULT_NAME.to_string())
    });
    let logo = logo_uri(doc.get("logo_uri")).map_err(|e| e.description)?;
    Ok(Client {
        id: client_id.to_string(),
        source: SOURCE_CIMD.into(),
        name,
        logo_uri: logo,
        redirect_uris: uris,
        secret_hash: None,
        created_at: now_ms(),
        last_used_at: None,
        fetched_at: Some(now_ms()),
    })
}

/// The client behind a URL `client_id`: the cached copy while it is fresh, else the freshly
/// fetched and validated document (stored for the token endpoint, which never fetches).
pub async fn resolve(state: &AppState, client_id: &str) -> Result<Client, String> {
    // Never `allow_private_webhooks`: see the module documentation.
    let allow_private = state.config.oauth_cimd_allow_private;
    validate_client_id(client_id, allow_private)?;
    let id = client_id.to_string();
    let cached = state
        .db
        .read({
            let id = id.clone();
            move |c| store::client(c, &id)
        })
        .await
        .map_err(|e| e.to_string())?;
    if let Some(c) = &cached
        && c.source != SOURCE_CIMD
    {
        return Err("this client_id belongs to a registered client".into());
    }
    let age = |c: &Client| now_ms() - c.fetched_at.unwrap_or(0);
    if let Some(c) = &cached
        && age(c) < CACHE_MS
    {
        return Ok(c.clone());
    }

    let fetched = fetch(client_id, allow_private).await;
    let client = match (fetched, cached) {
        (Ok(c), _) => c,
        (Err(_), Some(stale)) if age(&stale) < STALE_OK_MS => return Ok(stale),
        (Err(e), _) => return Err(e),
    };
    let to_store = client.clone();
    state
        .db
        .write(move |tx| {
            // A new document makes room by forgetting the longest unused one that nobody
            // connected through; a full table never blocks a new app.
            if store::client(tx, &to_store.id)?.is_none() {
                store::make_room(tx, SOURCE_CIMD, MAX_CIMD_CLIENTS)?;
            }
            store::upsert_cimd_client(tx, &to_store)
        })
        .await
        .map_err(|e| e.to_string())?;
    // Re-read: an existing row keeps its `last_used_at` and `created_at`.
    let stored = state
        .db
        .read(move |c| store::client(c, &id))
        .await
        .map_err(|e| e.to_string())?;
    stored.ok_or_else(|| "the client could not be stored".to_string())
}

async fn fetch(client_id: &str, allow_private: bool) -> Result<Client, String> {
    let fetched = tokio::time::timeout(
        FETCH_TIMEOUT,
        crate::automations::download::download(client_id, allow_private, MAX_DOCUMENT_BYTES),
    )
    .await
    .map_err(|_| {
        tracing::warn!(
            client_id,
            "fetching an OAuth client metadata document timed out"
        );
        FETCH_FAILED.to_string()
    })?
    .map_err(|e| {
        // The reason (a refused address, a status code, a connect error) stays in the log: shown
        // to a visitor it would turn this page into a probe of the internal network.
        tracing::warn!(
            client_id,
            error = %e.message,
            "could not fetch an OAuth client metadata document"
        );
        FETCH_FAILED.to_string()
    })?;
    if let Some(ct) = &fetched.content_type
        && ct != "application/json"
        && !ct.ends_with("+json")
    {
        tracing::warn!(client_id, content_type = %ct, "OAuth client metadata document with the wrong content type");
        return Err("the client metadata document must be served as application/json".into());
    }
    parse_document(client_id, &fetched.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_id_urls_follow_the_draft() {
        for ok in [
            "https://app.example.com/oauth/client.json",
            "https://app.example.com/a?b=1",
            "https://app.example.com:8443/x",
        ] {
            assert!(validate_client_id(ok, false).is_ok(), "{ok}");
        }
        for bad in [
            "http://app.example.com/x",
            "https://app.example.com",
            "https://app.example.com/",
            "https://app.example.com/a/../b",
            "https://app.example.com/a/./b",
            "https://app.example.com/x#f",
            "https://u:p@app.example.com/x",
            "ftp://app.example.com/x",
            "not a url",
        ] {
            assert!(validate_client_id(bad, false).is_err(), "{bad}");
        }
        // The loopback http exception needs the development-only switch.
        assert!(validate_client_id("http://127.0.0.1:9/client.json", false).is_err());
        assert!(validate_client_id("http://127.0.0.1:9/client.json", true).is_ok());
        assert!(validate_client_id("http://example.com/client.json", true).is_err());
    }

    fn doc(client_id: &str, extra: serde_json::Value) -> Vec<u8> {
        let mut d = serde_json::json!({
            "client_id": client_id,
            "client_name": "Fancy App",
            "redirect_uris": ["https://app.example.com/cb", "http://127.0.0.1/cb"],
        });
        for (k, v) in extra.as_object().unwrap() {
            d[k] = v.clone();
        }
        serde_json::to_vec(&d).unwrap()
    }

    #[test]
    fn documents_must_describe_the_url_they_came_from() {
        let id = "https://app.example.com/client.json";
        let c = parse_document(id, &doc(id, serde_json::json!({}))).unwrap();
        assert_eq!(c.name, "Fancy App");
        assert_eq!(c.redirect_uris.len(), 2);
        assert_eq!(c.source, SOURCE_CIMD);
        // Another client_id in the document.
        assert!(
            parse_document(
                id,
                &doc("https://evil.example/c.json", serde_json::json!({}))
            )
            .is_err()
        );
        // Secrets and secret-based authentication.
        assert!(parse_document(id, &doc(id, serde_json::json!({"client_secret": "x"}))).is_err());
        assert!(
            parse_document(
                id,
                &doc(
                    id,
                    serde_json::json!({"token_endpoint_auth_method": "client_secret_post"})
                )
            )
            .is_err()
        );
        assert!(
            parse_document(
                id,
                &doc(
                    id,
                    serde_json::json!({"token_endpoint_auth_method": "none"})
                )
            )
            .is_ok()
        );
        // Bad redirect URIs, bad JSON.
        assert!(
            parse_document(
                id,
                &doc(
                    id,
                    serde_json::json!({"redirect_uris": ["http://evil.example/cb"]})
                )
            )
            .is_err()
        );
        assert!(parse_document(id, &doc(id, serde_json::json!({"redirect_uris": []}))).is_err());
        assert!(parse_document(id, b"[1]").is_err());
        assert!(parse_document(id, b"nope").is_err());
        // A missing name falls back to the host.
        let mut d: serde_json::Value =
            serde_json::from_slice(&doc(id, serde_json::json!({}))).unwrap();
        d.as_object_mut().unwrap().remove("client_name");
        let c = parse_document(id, d.to_string().as_bytes()).unwrap();
        assert_eq!(c.name, "app.example.com");
    }
}
