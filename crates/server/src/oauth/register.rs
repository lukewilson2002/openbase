//! `POST /oauth/register`: RFC 7591 dynamic client registration.
//!
//! Anyone can register (that is the point: Claude Code, ChatGPT and other apps register
//! themselves on first use), so this is the place abuse would start, and everything is bounded:
//! the body is capped, names and redirect URIs are validated, each client address may register
//! only a few clients per hour (IPv6 addresses count per /64), the total number is capped (when
//! the table is full the longest unused client is forgotten, so the cap never locks anybody out),
//! identical registrations share one client, and a client nobody ever used is forgotten after
//! seven days by the hourly cleanup. A registration grants
//! nothing by itself: no access is possible without a signed-in user approving it on the consent
//! page, which names the app and shows where the access would go.

use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};

use super::{MAX_BODY_BYTES, OAuthError, no_store, redirect, scope};
use crate::auth::ClientInfo;
use crate::db::now_ms;
use crate::ids::hash_token;
use crate::state::AppState;
use crate::store::oauth::{self as store, Client, MAX_DCR_CLIENTS, SOURCE_DCR};

/// Registrations one client address may make per hour.
pub const REGISTRATIONS_PER_IP_PER_HOUR: u32 = 30;
/// Longest accepted app name.
pub const MAX_NAME_CHARS: usize = 100;
/// Name used when an app does not give one.
pub const DEFAULT_NAME: &str = "Unnamed app";

/// An error of RFC 7591 section 3.2.2.
fn metadata_error(code: &'static str, description: impl Into<String>) -> OAuthError {
    OAuthError::new(code, description)
}

/// An app name made safe to show: control characters dropped, whitespace collapsed. `None` when
/// it is too long. The consent page shows it as plain text; it is still *untrusted*.
pub fn clean_name(raw: &str) -> Option<String> {
    let collapsed = raw
        .chars()
        .filter(|c| !c.is_control() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() > MAX_NAME_CHARS {
        return None;
    }
    Some(if collapsed.is_empty() {
        DEFAULT_NAME.to_string()
    } else {
        collapsed
    })
}

/// Validate a `redirect_uris` value. Returns the unique list, in order.
pub fn redirect_uris(value: Option<&Value>) -> Result<Vec<String>, OAuthError> {
    let invalid = |m: String| OAuthError::new("invalid_redirect_uri", m);
    let Some(list) = value.and_then(Value::as_array) else {
        return Err(invalid(
            "redirect_uris is required: a list of strings".into(),
        ));
    };
    if list.is_empty() || list.len() > redirect::MAX_REDIRECT_URIS {
        return Err(invalid(format!(
            "redirect_uris must list 1 to {} addresses",
            redirect::MAX_REDIRECT_URIS
        )));
    }
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let Some(uri) = item.as_str() else {
            return Err(invalid("every redirect URI must be a string".into()));
        };
        redirect::validate(uri).map_err(invalid)?;
        if !out.iter().any(|u| u == uri) {
            out.push(uri.to_string());
        }
    }
    Ok(out)
}

/// An optional `logo_uri`: kept only when it is a plain `https` URL of reasonable length. The
/// server never fetches it and the consent page does not load it.
pub fn logo_uri(value: Option<&Value>) -> Result<Option<String>, OAuthError> {
    let Some(v) = value.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let ok = v.as_str().filter(|s| {
        s.len() <= redirect::MAX_REDIRECT_URI_LEN
            && url::Url::parse(s).is_ok_and(|u| {
                u.scheme() == "https"
                    && u.host().is_some()
                    && u.username().is_empty()
                    && u.password().is_none()
            })
    });
    match ok {
        Some(s) => Ok(Some(s.to_string())),
        None => Err(metadata_error(
            "invalid_client_metadata",
            "logo_uri must be an https URL",
        )),
    }
}

fn fingerprint(name: &str, uris: &[String]) -> String {
    let mut sorted = uris.to_vec();
    sorted.sort();
    hash_token(&format!("{name}\0{}", sorted.join("\0")))
}

/// `POST /oauth/register`.
pub async fn register(
    State(state): State<AppState>,
    client_info: ClientInfo,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, OAuthError> {
    if !state.config.oauth_enabled() || !state.config.oauth_registration {
        return Err(OAuthError::disabled());
    }
    state.limiter.check(
        "oauth_register",
        &super::rate_key(&client_info.ip),
        REGISTRATIONS_PER_IP_PER_HOUR,
        Duration::from_secs(3600),
    )?;
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    if !is_json {
        return Err(metadata_error(
            "invalid_client_metadata",
            "send the client metadata as JSON with Content-Type: application/json",
        ));
    }
    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| metadata_error("invalid_client_metadata", "the request body is too large"))?;
    let doc: Value = serde_json::from_slice(&bytes)
        .map_err(|_| metadata_error("invalid_client_metadata", "the body must be a JSON object"))?;
    let Some(doc) = doc.as_object() else {
        return Err(metadata_error(
            "invalid_client_metadata",
            "the body must be a JSON object",
        ));
    };

    let new = parse_registration(doc)?;
    let response = state
        .db
        .write(move |tx| {
            let fp = (!new.confidential).then(|| fingerprint(&new.name, &new.redirect_uris));
            if let Some(fp) = &fp
                && let Some(existing) = store::client_by_fingerprint(tx, fp)?
            {
                return Ok(registration_response(&existing, None));
            }
            // A full table forgets the longest unused client instead of refusing the newcomer:
            // otherwise a trickle of registrations from a few addresses would keep every real
            // app out for good.
            store::make_room(tx, SOURCE_DCR, MAX_DCR_CLIENTS)?;
            let (secret, secret_hash) = if new.confidential {
                let (s, h) = store::new_client_secret();
                (Some(s), Some(h))
            } else {
                (None, None)
            };
            let client = Client {
                id: store::new_client_id(),
                source: SOURCE_DCR.into(),
                name: new.name,
                logo_uri: new.logo_uri,
                redirect_uris: new.redirect_uris,
                secret_hash,
                created_at: now_ms(),
                last_used_at: None,
                fetched_at: None,
            };
            store::insert_client(tx, &client, fp.as_deref())?;
            Ok(registration_response(&client, secret))
        })
        .await?;
    let mut res = (StatusCode::CREATED, axum::Json(response)).into_response();
    no_store(&mut res);
    Ok(res)
}

struct NewClient {
    name: String,
    logo_uri: Option<String>,
    redirect_uris: Vec<String>,
    confidential: bool,
}

fn parse_registration(doc: &Map<String, Value>) -> Result<NewClient, OAuthError> {
    let bad = |m: &str| metadata_error("invalid_client_metadata", m);
    let redirect_uris = redirect_uris(doc.get("redirect_uris"))?;
    let name = match doc.get("client_name") {
        None | Some(Value::Null) => DEFAULT_NAME.to_string(),
        Some(Value::String(s)) => clean_name(s).ok_or_else(|| {
            bad(&format!(
                "client_name is longer than {MAX_NAME_CHARS} characters"
            ))
        })?,
        Some(_) => return Err(bad("client_name must be a string")),
    };
    let logo_uri = logo_uri(doc.get("logo_uri"))?;
    if let Some(v) = doc.get("grant_types").filter(|v| !v.is_null()) {
        let list = v
            .as_array()
            .ok_or_else(|| bad("grant_types must be a list"))?;
        let mut has_code = false;
        for g in list {
            match g.as_str() {
                Some("authorization_code") => has_code = true,
                Some("refresh_token") => {}
                _ => {
                    return Err(bad(
                        "unsupported grant type: only authorization_code and refresh_token are available",
                    ));
                }
            }
        }
        if !has_code {
            return Err(bad("grant_types must include authorization_code"));
        }
    }
    if let Some(v) = doc.get("response_types").filter(|v| !v.is_null()) {
        let ok = v
            .as_array()
            .is_some_and(|l| !l.is_empty() && l.iter().all(|t| t.as_str() == Some("code")));
        if !ok {
            return Err(bad("response_types must be [\"code\"]"));
        }
    }
    if let Some(v) = doc.get("scope").filter(|v| !v.is_null())
        && !v.as_str().is_some_and(|s| s.len() <= 1000)
    {
        return Err(bad("scope must be a string"));
    }
    let confidential = match doc.get("token_endpoint_auth_method") {
        None | Some(Value::Null) => false,
        Some(Value::String(m)) if m == "none" => false,
        Some(Value::String(m)) if m == "client_secret_post" => true,
        Some(_) => {
            return Err(bad(
                "token_endpoint_auth_method must be 'none' or 'client_secret_post'",
            ));
        }
    };
    Ok(NewClient {
        name,
        logo_uri,
        redirect_uris,
        confidential,
    })
}

fn registration_response(c: &Client, secret: Option<String>) -> Value {
    let mut doc = json!({
        "client_id": c.id,
        "client_id_issued_at": c.created_at / 1000,
        "client_name": c.name,
        "redirect_uris": c.redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": if c.is_confidential() { "client_secret_post" } else { "none" },
        "scope": scope::SUPPORTED.join(" "),
    });
    if let Some(logo) = &c.logo_uri {
        doc["logo_uri"] = json!(logo);
    }
    if let Some(secret) = secret {
        doc["client_secret"] = json!(secret);
        doc["client_secret_expires_at"] = json!(0);
    }
    doc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_cleaned_and_bounded() {
        assert_eq!(clean_name("  My \n App\t").as_deref(), Some("My App"));
        assert_eq!(clean_name("a\u{0007}b").as_deref(), Some("ab"));
        assert_eq!(clean_name("   ").as_deref(), Some(DEFAULT_NAME));
        assert_eq!(
            clean_name(&"x".repeat(MAX_NAME_CHARS)).map(|s| s.len()),
            Some(MAX_NAME_CHARS)
        );
        assert!(clean_name(&"x".repeat(MAX_NAME_CHARS + 1)).is_none());
    }

    #[test]
    fn fingerprint_ignores_redirect_order() {
        let a = fingerprint("App", &["https://a/x".into(), "https://b/y".into()]);
        let b = fingerprint("App", &["https://b/y".into(), "https://a/x".into()]);
        assert_eq!(a, b);
        assert_ne!(
            a,
            fingerprint("Other", &["https://a/x".into(), "https://b/y".into()])
        );
    }

    #[test]
    fn redirect_uri_lists_are_validated() {
        assert_eq!(
            redirect_uris(Some(&json!([
                "https://a.example/cb",
                "https://a.example/cb"
            ])))
            .unwrap(),
            vec!["https://a.example/cb".to_string()]
        );
        for bad in [
            json!(null),
            json!("https://a.example/cb"),
            json!([]),
            json!([1]),
            json!(["javascript:alert(1)"]),
            json!(["https://a.example/cb#x"]),
            json!(
                (0..11)
                    .map(|i| format!("https://a.example/{i}"))
                    .collect::<Vec<_>>()
            ),
        ] {
            let err = redirect_uris(Some(&bad)).unwrap_err();
            assert_eq!(err.error, "invalid_redirect_uri", "{bad}");
        }
        assert!(redirect_uris(None).is_err());
    }
}
