//! `GET /oauth/authorize`: the start of the authorization code flow.
//!
//! The handler validates the *whole* request before the user sees anything, stores it server-side
//! and sends the browser on to the consent page of the web app (`/oauth/consent?request=<id>`).
//! The browser therefore carries only an opaque id: the client cannot alter the redirect URI,
//! the PKCE challenge, the resource or the scopes between the steps, and the consent page needs
//! no query parameters it would have to trust. The consent page is a normal page of the app, so
//! it requires a signed-in session (the login redirect and the way back come from the app's own
//! guard), is served with the app's `frame-ancestors 'none'` CSP, and approval is a
//! CSRF-protected API call from that session (see `api::oauth`).
//!
//! Errors follow RFC 6749 4.1.2.1: while the client or the redirect URI cannot be trusted the
//! user sees an error page and nothing is redirected (an open redirect would otherwise be
//! possible); once both are verified, errors go back to the client's redirect URI with `error`,
//! `state` and the issuer (`iss`, RFC 9207, which protects clients that talk to several
//! authorization servers against mix-up attacks).

use std::time::Duration;

use axum::extract::{RawQuery, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::{normalize_resource, parse_params, redirect, scope};
use crate::auth::ClientInfo;
use crate::state::AppState;
use crate::store::oauth as store;

/// Authorization requests one client address may start per minute.
pub const REQUESTS_PER_IP_PER_MINUTE: u32 = 60;
/// Longest accepted `state` parameter.
pub const MAX_STATE_LEN: usize = 1024;
/// Length of a base64url-encoded SHA-256 digest.
const CHALLENGE_LEN: usize = 43;

/// The web app's consent page for a stored request.
pub fn consent_path(request_id: &str) -> String {
    format!("/oauth/consent?request={request_id}")
}

/// `redirect_uri` with `params` added to its query (existing query parameters are kept), plus
/// the issuer.
pub fn redirect_url(redirect_uri: &str, params: &[(&str, &str)], issuer: &str) -> Option<String> {
    let mut url = url::Url::parse(redirect_uri).ok()?;
    {
        let mut q = url.query_pairs_mut();
        for (k, v) in params {
            q.append_pair(k, v);
        }
        q.append_pair("iss", issuer);
    }
    Some(url.to_string())
}

fn found(location: &str) -> Response {
    let mut res = StatusCode::FOUND.into_response();
    if let Ok(v) = HeaderValue::from_str(location) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    super::no_store(&mut res);
    res
}

fn escape_html(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '&' => "&amp;".to_string(),
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '"' => "&quot;".to_string(),
            '\'' => "&#39;".to_string(),
            c => c.to_string(),
        })
        .collect()
}

/// A plain page for problems that must not be redirected to the client.
pub fn error_page(status: StatusCode, message: &str) -> Response {
    let html = format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>Cannot connect the app - OpenBase</title>\
         <style>body{{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;\
         color:#1f2328;line-height:1.5}}h1{{font-size:1.25rem}}p{{margin:.75rem 0}}\
         @media(prefers-color-scheme:dark){{body{{background:#14171a;color:#e6e8ea}}a{{color:#8ab4ff}}}}</style>\
         </head><body><h1>Cannot connect the app</h1><p>{}</p>\
         <p>Nothing was shared. Go back to the app and start again, or <a href=\"/\">open OpenBase</a>.</p>\
         </body></html>",
        escape_html(message)
    );
    let mut res = (status, axum::response::Html(html)).into_response();
    super::no_store(&mut res);
    res
}

/// A valid S256 code challenge: 43 characters of the base64url alphabet.
fn is_challenge(s: &str) -> bool {
    s.len() == CHALLENGE_LEN
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub async fn authorize(
    State(state): State<AppState>,
    client_info: ClientInfo,
    RawQuery(query): RawQuery,
) -> Response {
    if !state.config.oauth_enabled() {
        return error_page(
            StatusCode::NOT_FOUND,
            "OAuth sign-in is not available on this OpenBase: its public URL is not https.",
        );
    }
    if state
        .limiter
        .check(
            "oauth_authorize",
            &client_info.ip,
            REQUESTS_PER_IP_PER_MINUTE,
            Duration::from_secs(60),
        )
        .is_err()
    {
        return error_page(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many connection attempts. Wait a minute and try again.",
        );
    }
    let params = match parse_params(query.as_deref().unwrap_or("").as_bytes()) {
        Ok(p) => p,
        Err(e) => return error_page(StatusCode::BAD_REQUEST, &e.description),
    };

    // 1. Who is asking, and where may the answer go? Until both are verified: no redirects.
    let Some(client_id) = params.get("client_id").filter(|s| !s.is_empty()) else {
        return error_page(StatusCode::BAD_REQUEST, "The request has no client_id.");
    };
    let client = if super::cimd::is_url(client_id) {
        match super::cimd::resolve(&state, client_id).await {
            Ok(c) => c,
            Err(e) => {
                return error_page(
                    StatusCode::BAD_REQUEST,
                    &format!("The app could not be identified: {e}"),
                );
            }
        }
    } else {
        let id = client_id.clone();
        match state.db.read(move |c| store::client(c, &id)).await {
            Ok(Some(c)) => c,
            Ok(None) => {
                return error_page(
                    StatusCode::BAD_REQUEST,
                    "This app is not registered with OpenBase.",
                );
            }
            Err(e) => return e.into_response(),
        }
    };
    let Some(redirect_uri) = params.get("redirect_uri").filter(|s| !s.is_empty()) else {
        return error_page(StatusCode::BAD_REQUEST, "The request has no redirect_uri.");
    };
    if !redirect::matches(&client.redirect_uris, redirect_uri) {
        return error_page(
            StatusCode::BAD_REQUEST,
            "The app asked to send you to an address it did not register. For your safety \
             OpenBase did not continue.",
        );
    }

    // 2. From here on the redirect address is trusted: report problems to the client.
    let issuer = state.config.oauth_issuer();
    let state_param = params.get("state").map(String::as_str);
    let fail = |error: &str, description: &str| -> Response {
        let mut pairs = vec![("error", error), ("error_description", description)];
        if let Some(s) = state_param.filter(|s| s.len() <= MAX_STATE_LEN) {
            pairs.push(("state", s));
        }
        match redirect_url(redirect_uri, &pairs, &issuer) {
            Some(url) => found(&url),
            None => error_page(StatusCode::BAD_REQUEST, description),
        }
    };
    if state_param.is_some_and(|s| s.len() > MAX_STATE_LEN) {
        return fail("invalid_request", "the state parameter is too long");
    }
    if params.get("response_type").map(String::as_str) != Some("code") {
        return fail(
            "unsupported_response_type",
            "only response_type=code is supported",
        );
    }
    let Some(challenge) = params.get("code_challenge").filter(|c| is_challenge(c)) else {
        return fail(
            "invalid_request",
            "a code_challenge (PKCE, S256) is required",
        );
    };
    if params.get("code_challenge_method").map(String::as_str) != Some("S256") {
        return fail(
            "invalid_request",
            "code_challenge_method must be S256 (plain PKCE is not supported)",
        );
    }
    let resource = state.config.mcp_resource();
    if let Some(requested) = params.get("resource")
        && normalize_resource(requested) != resource
    {
        return fail(
            "invalid_target",
            &format!("this server issues tokens for {resource} only"),
        );
    }
    let (requested_scope, _) = scope::requested(params.get("scope").map(String::as_str));

    // 3. Keep the request on the server and hand the browser an id.
    let (cid, uri, ch, st, res, sc) = (
        client.id.clone(),
        redirect_uri.clone(),
        challenge.clone(),
        state_param.map(str::to_string),
        resource.clone(),
        requested_scope,
    );
    let created = state
        .db
        .write(move |tx| {
            store::touch_client(tx, &cid)?;
            store::create_request(tx, &cid, &uri, &ch, st.as_deref(), &res, &sc)
        })
        .await;
    match created {
        Ok(req) => found(&consent_path(&req.id)),
        Err(crate::error::AppError::TooManyRequests) => error_page(
            StatusCode::SERVICE_UNAVAILABLE,
            "OpenBase is handling too many connection attempts right now. Try again in a few minutes.",
        ),
        Err(e) => e.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_urls_keep_the_query_and_carry_the_issuer() {
        let u = redirect_url(
            "https://app.example/cb?x=1",
            &[("code", "abc"), ("state", "s t")],
            "https://base.example",
        )
        .unwrap();
        let parsed = url::Url::parse(&u).unwrap();
        let q: Vec<(String, String)> = parsed
            .query_pairs()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert_eq!(
            q,
            vec![
                ("x".to_string(), "1".to_string()),
                ("code".to_string(), "abc".to_string()),
                ("state".to_string(), "s t".to_string()),
                ("iss".to_string(), "https://base.example".to_string()),
            ]
        );
        assert!(redirect_url("not a url", &[], "i").is_none());
    }

    #[test]
    fn challenges_are_43_base64url_characters() {
        assert!(is_challenge(&"A".repeat(43)));
        assert!(is_challenge("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!is_challenge(&"A".repeat(42)));
        assert!(!is_challenge(&"A".repeat(44)));
        assert!(!is_challenge(&format!("{}=", "A".repeat(42))));
        assert!(!is_challenge(&format!("{}+", "A".repeat(42))));
    }

    #[test]
    fn error_pages_escape_their_message() {
        let res = error_page(StatusCode::BAD_REQUEST, "<script>alert(1)</script> & \"x\"");
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            escape_html("<a href='x'>&"),
            "&lt;a href=&#39;x&#39;&gt;&amp;"
        );
    }
}
