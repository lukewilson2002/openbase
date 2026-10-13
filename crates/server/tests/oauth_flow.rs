//! The authorization code flow: the authorization endpoint, the consent API, the token endpoint
//! (code and refresh grants) and revocation, with every error path.

mod common;
mod mcp_support;
mod oauth_support;

use common::{Client, TestApp};
use oauth_support::*;
use serde_json::{Value, json};

const CB: &str = "https://app.example.com/oauth/callback";

struct Fx {
    app: TestApp,
    user: Client,
    client_id: String,
}

impl Fx {
    async fn new() -> Fx {
        let app = TestApp::new();
        let user = app.user("alice@example.com", "Alice");
        let client_id = register_client(&app, "Fancy App", &[CB, LOOPBACK_REDIRECT]).await;
        Fx {
            app,
            user,
            client_id,
        }
    }

    async fn authorize(&self, extra: &[(&str, &str)]) -> common::Response {
        authorize_with(&self.app, &self.client_id, CB, &pkce().1, extra).await
    }

    /// Start a flow (the app asks for the scopes of `access`) and approve it; returns
    /// (code, verifier).
    async fn code(&self, access: &str) -> (String, String) {
        let (verifier, challenge) = pkce();
        let res = authorize_with(
            &self.app,
            &self.client_id,
            CB,
            &challenge,
            &[("scope", scope_for(access))],
        )
        .await;
        let id = request_id(&res);
        (
            code_of(&approve(&self.app, &self.user, &id, access).await),
            verifier,
        )
    }

    async fn exchange(&self, code: &str, verifier: &str) -> common::Response {
        token_code(&self.app, &self.client_id, code, CB, verifier).await
    }

    fn count(&self, sql: &str) -> i64 {
        self.app.query_i64(sql, &[])
    }

    /// Pretend the refresh tokens that were exchanged were exchanged `secs` seconds ago.
    fn age_used_refresh_tokens(&self, secs: i64) {
        self.app
            .state
            .db
            .write_sync(move |tx| {
                tx.execute(
                    "UPDATE oauth_tokens SET used_at = used_at - ?1 WHERE used_at IS NOT NULL",
                    [secs * 1000],
                )?;
                Ok(())
            })
            .unwrap();
    }
}

/// `GET /oauth/authorize` for `client_id` from `ip` (through `X-Forwarded-For`, so the app must
/// trust the proxy), signed in as `user` or as a visitor.
async fn authorize_from(
    app: &TestApp,
    user: Option<&Client>,
    ip: &str,
    client_id: &str,
) -> common::Response {
    let params = authorize_params(client_id, CB, &pkce().1, &[]);
    let query = encode(
        &params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect::<Vec<_>>(),
    );
    app.request_with(
        user.unwrap_or(&Client::default()),
        "GET",
        &format!("/oauth/authorize?{query}"),
        None,
        &[("x-forwarded-for", ip)],
        false,
        None,
    )
    .await
}

fn error_of(res: &common::Response) -> (&str, &str) {
    (
        res.body["error"].as_str().unwrap_or_default(),
        res.body["error_description"].as_str().unwrap_or_default(),
    )
}

// ------------------------------------------------------------------------- authorize

#[tokio::test]
async fn a_valid_request_is_stored_and_the_browser_goes_to_the_consent_page() {
    let fx = Fx::new().await;
    let (_, challenge) = pkce();
    let res = authorize_with(
        &fx.app,
        &fx.client_id,
        CB,
        &challenge,
        &[
            ("scope", "openbase:write"),
            ("resource", "http://localhost:8080/mcp"),
        ],
    )
    .await;
    let id = request_id(&res);
    assert!(
        id.starts_with("oar") && id.len() > 40,
        "an unguessable id: {id}"
    );
    assert_eq!(res.headers["cache-control"], "no-store");
    // Only the id travels through the browser; everything else is kept on the server.
    let loc = location(&res);
    for leaked in [&challenge, "xyz-state", "openbase", CB, "http%3A"] {
        assert!(!loc.contains(leaked), "{loc} must not carry {leaked}");
    }
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 1);
    let row: (String, String, String, String) = fx
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT redirect_uri, code_challenge, state, scope FROM oauth_requests",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?)
        })
        .unwrap();
    assert_eq!(
        row,
        (
            CB.into(),
            challenge,
            "xyz-state".into(),
            "openbase:write".into()
        )
    );
    // Starting a request does not make the client count as used: only a completed exchange does
    // (otherwise strangers could keep clients alive past the unused-client cleanup).
    assert_eq!(
        fx.count("SELECT count(*) FROM oauth_clients WHERE last_used_at IS NOT NULL"),
        0
    );
}

#[tokio::test]
async fn a_trailing_slash_on_the_resource_is_accepted() {
    let fx = Fx::new().await;
    for resource in ["http://localhost:8080/mcp", "http://localhost:8080/mcp/"] {
        request_id(&fx.authorize(&[("resource", resource)]).await);
    }
}

#[tokio::test]
async fn an_unknown_client_or_redirect_is_shown_to_the_user_and_never_redirected_to() {
    let fx = Fx::new().await;
    let (_, challenge) = pkce();
    let page = |res: &common::Response| String::from_utf8_lossy(&res.bytes).into_owned();
    for (label, res) in [
        (
            "no client_id",
            authorize(
                &fx.app,
                &[
                    ("response_type", "code"),
                    ("redirect_uri", CB),
                    ("code_challenge", &challenge),
                ],
            )
            .await,
        ),
        (
            "unknown client",
            authorize_with(&fx.app, "oclNope", CB, &challenge, &[]).await,
        ),
        (
            "no redirect_uri",
            authorize_with(
                &fx.app,
                &fx.client_id,
                CB,
                &challenge,
                &[("redirect_uri", "")],
            )
            .await,
        ),
        (
            "unregistered redirect",
            authorize_with(
                &fx.app,
                &fx.client_id,
                "https://evil.example/cb",
                &challenge,
                &[],
            )
            .await,
        ),
        (
            "redirect with a different path",
            authorize_with(
                &fx.app,
                &fx.client_id,
                "https://app.example.com/oauth/other",
                &challenge,
                &[],
            )
            .await,
        ),
        (
            "redirect with an added query",
            authorize_with(
                &fx.app,
                &fx.client_id,
                &format!("{CB}?next=https://evil.example"),
                &challenge,
                &[],
            )
            .await,
        ),
        (
            "redirect with a trailing slash",
            authorize_with(&fx.app, &fx.client_id, &format!("{CB}/"), &challenge, &[]).await,
        ),
        (
            "different scheme",
            authorize_with(
                &fx.app,
                &fx.client_id,
                "http://app.example.com/oauth/callback",
                &challenge,
                &[],
            )
            .await,
        ),
        (
            "javascript scheme",
            authorize_with(
                &fx.app,
                &fx.client_id,
                "javascript:alert(1)",
                &challenge,
                &[],
            )
            .await,
        ),
        (
            "repeated parameter",
            authorize(
                &fx.app,
                &[
                    ("client_id", &fx.client_id),
                    ("client_id", "oclOther"),
                    ("redirect_uri", CB),
                ],
            )
            .await,
        ),
    ] {
        res.assert_status(400);
        assert!(
            !res.headers.contains_key("location"),
            "{label}: must not redirect"
        );
        let html = page(&res);
        assert!(html.contains("Cannot connect the app"), "{label}: {html}");
        assert_eq!(res.headers["cache-control"], "no-store", "{label}");
    }
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 0);
}

#[tokio::test]
async fn the_error_page_does_not_echo_markup() {
    let fx = Fx::new().await;
    let res = authorize(&fx.app, &[("client_id", "<script>alert(1)</script>")]).await;
    res.assert_status(400);
    let html = String::from_utf8_lossy(&res.bytes).into_owned();
    assert!(!html.contains("<script>alert"), "{html}");
}

#[tokio::test]
async fn problems_after_the_redirect_is_verified_go_back_to_the_client_with_state_and_issuer() {
    let fx = Fx::new().await;
    let (_, challenge) = pkce();
    let bad_challenge = "short";
    for (label, extra, error) in [
        (
            "response_type",
            vec![("response_type", "token")],
            "unsupported_response_type",
        ),
        (
            "no response_type",
            vec![("response_type", "")],
            "unsupported_response_type",
        ),
        (
            "no challenge",
            vec![("code_challenge", "")],
            "invalid_request",
        ),
        (
            "malformed challenge",
            vec![("code_challenge", bad_challenge)],
            "invalid_request",
        ),
        (
            "plain method",
            vec![("code_challenge_method", "plain")],
            "invalid_request",
        ),
        (
            "no method",
            vec![("code_challenge_method", "")],
            "invalid_request",
        ),
        (
            "other resource",
            vec![("resource", "https://other.example/mcp")],
            "invalid_target",
        ),
        (
            "resource with a path",
            vec![("resource", "http://localhost:8080/mcp/extra")],
            "invalid_target",
        ),
    ] {
        let res = authorize_with(&fx.app, &fx.client_id, CB, &challenge, &extra).await;
        assert_eq!(res.status, 302, "{label}");
        let loc = location(&res);
        assert!(loc.starts_with(&format!("{CB}?")), "{label}: {loc}");
        let q = query_of(&loc);
        assert_eq!(q["error"], error, "{label}");
        assert_eq!(q["state"], "xyz-state", "{label}");
        assert_eq!(q["iss"], "http://localhost:8080", "{label}");
        assert!(q.contains_key("error_description"), "{label}");
        assert!(!q.contains_key("code"));
    }
    // An over-long state cannot be reflected; the error still goes back.
    let long = "s".repeat(2000);
    let res = authorize_with(&fx.app, &fx.client_id, CB, &challenge, &[("state", &long)]).await;
    assert_eq!(res.status, 302);
    let q = query_of(&location(&res));
    assert_eq!(q["error"], "invalid_request");
    assert!(!q.contains_key("state"));
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 0);
}

#[tokio::test]
async fn loopback_redirects_may_use_any_port() {
    let fx = Fx::new().await;
    let (_, challenge) = pkce();
    for uri in [
        "http://127.0.0.1:53124/callback",
        "http://127.0.0.1:61999/callback",
        "http://127.0.0.1/callback",
    ] {
        request_id(&authorize_with(&fx.app, &fx.client_id, uri, &challenge, &[]).await);
    }
    for uri in [
        "http://127.0.0.1:53124/other",
        "http://localhost:53124/callback",
        "https://127.0.0.1:53124/callback",
        "http://127.0.0.1:53124/callback?x=1",
    ] {
        let res = authorize_with(&fx.app, &fx.client_id, uri, &challenge, &[]).await;
        res.assert_status(400);
    }
    // The port the client used is the one the code is sent to, and the one it must repeat.
    let (verifier, challenge) = pkce();
    let used = "http://127.0.0.1:61999/callback";
    let id = request_id(&authorize_with(&fx.app, &fx.client_id, used, &challenge, &[]).await);
    let approval = approve(&fx.app, &fx.user, &id, "read").await;
    assert!(
        approval.body["redirect_to"]
            .as_str()
            .unwrap()
            .starts_with("http://127.0.0.1:61999/callback?code=")
    );
    let code = code_of(&approval);
    let wrong = token_code(&fx.app, &fx.client_id, &code, LOOPBACK_REDIRECT, &verifier).await;
    wrong.assert_status(400);
    assert_eq!(error_of(&wrong).0, "invalid_grant");
}

#[tokio::test]
async fn authorization_requests_are_rate_limited_and_capped() {
    let fx = Fx::new().await;
    for _ in 0..60 {
        fx.authorize(&[]).await.assert_status(302);
    }
    let res = fx.authorize(&[]).await;
    res.assert_status(429);
    assert!(!res.headers.contains_key("location"));
    // The table of waiting requests has a ceiling too.
    let fx = Fx::new().await;
    fx.app
        .state
        .db
        .write_sync(|tx| {
            for i in 0..openbase::store::oauth::MAX_PENDING_REQUESTS {
                // Spread over many clients, so the instance-wide ceiling is what trips.
                tx.execute(
                    "INSERT INTO oauth_clients (id, source, name, redirect_uris, created_at)
                     VALUES (?1, 'dcr', 'bulk', '[]', 1)",
                    [format!("ocl{i}")],
                )?;
                tx.execute(
                    "INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, resource, scope, created_at, expires_at)
                     VALUES (?1, ?2, 'x', 'y', 'z', '', 1, ?3)",
                    rusqlite::params![format!("oar{i}"), format!("ocl{i}"), openbase::db::now_ms() + 600_000],
                )?;
            }
            Ok(())
        })
        .unwrap();
    fx.authorize(&[]).await.assert_status(503);
}

/// One app cannot use up the instance-wide room for waiting requests; others are unaffected.
#[tokio::test]
async fn waiting_requests_are_capped_per_client() {
    let fx = Fx::new().await;
    let other = register_client(&fx.app, "Other App", &[CB]).await;
    let cap = openbase::store::oauth::MAX_PENDING_PER_CLIENT;
    let client_id = fx.client_id.clone();
    fx.app
        .state
        .db
        .write_sync(move |tx| {
            for i in 0..cap {
                tx.execute(
                    "INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, resource, scope, created_at, expires_at)
                     VALUES (?1, ?2, 'x', 'y', 'z', '', 1, ?3)",
                    rusqlite::params![format!("oar{i}"), client_id, openbase::db::now_ms() + 600_000],
                )?;
            }
            Ok(())
        })
        .unwrap();
    fx.authorize(&[]).await.assert_status(503);
    authorize_with(&fx.app, &other, CB, &pkce().1, &[])
        .await
        .assert_status(302);
}

/// Anyone can open `/oauth/authorize`, so for a visitor who is not signed in it must write
/// nothing: no waiting request, no "used" mark on the client. The visitor is sent to sign in,
/// with this very request as the place to come back to.
#[tokio::test]
async fn visitors_are_sent_to_sign_in_and_nothing_is_stored() {
    let fx = Fx::new().await;
    let (_, challenge) = pkce();
    let params = authorize_params(
        &fx.client_id,
        CB,
        &challenge,
        &[("scope", "openbase:write")],
    );
    let pairs: Vec<(&str, &str)> = params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let res = authorize_anonymous(&fx.app, &pairs).await;
    res.assert_status(302);
    let loc = location(&res);
    assert!(loc.starts_with("/login?next="), "{loc}");
    // `next` is the same authorization request, to be loaded again once signed in.
    let next = query_of(&loc).remove("next").unwrap();
    assert_eq!(next, format!("/oauth/authorize?{}", encode(&pairs)));
    assert_eq!(res.headers["cache-control"], "no-store");
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 0);
    assert_eq!(
        fx.count("SELECT count(*) FROM oauth_clients WHERE last_used_at IS NOT NULL"),
        0
    );

    // A flood of anonymous hits (up to the per-address limit) leaves the tables as they were.
    for _ in 0..40 {
        authorize_anonymous(&fx.app, &pairs)
            .await
            .assert_status(302);
    }
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 0);
    assert_eq!(
        fx.count("SELECT count(*) FROM oauth_clients WHERE last_used_at IS NOT NULL"),
        0
    );

    // Coming back with a session finishes the job: the request is stored and the browser goes on
    // to the consent page.
    let res = authorize_as(&fx.app, &fx.user, &pairs).await;
    let id = request_id(&res);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 1);
    approve(&fx.app, &fx.user, &id, "write")
        .await
        .assert_status(200);
}

/// A broken link is explained before the sign-in, not after it; problems with a client's own
/// parameters wait for the second pass so nothing is redirected to an unverified address.
#[tokio::test]
async fn a_visitor_sees_broken_links_explained_before_signing_in() {
    let fx = Fx::new().await;
    let (_, challenge) = pkce();
    for (label, client, redirect) in [
        ("unknown client", "oclNope", CB),
        (
            "unregistered redirect",
            fx.client_id.as_str(),
            "https://evil.example/cb",
        ),
    ] {
        let res = authorize_with_anonymous(&fx.app, client, redirect, &challenge, &[]).await;
        res.assert_status(400);
        assert!(!res.headers.contains_key("location"), "{label}");
    }
    // A very long query would not fit through the sign-in page.
    let long = "x".repeat(openbase::oauth::authorize::MAX_QUERY_LEN);
    let res =
        authorize_with_anonymous(&fx.app, &fx.client_id, CB, &challenge, &[("state", &long)]).await;
    res.assert_status(400);
    assert!(!res.headers.contains_key("location"));
}

/// A session cookie is the only thing that counts as being signed in: a bearer token on the
/// authorization endpoint does not make a request storable.
#[tokio::test]
async fn a_bearer_token_does_not_count_as_signed_in() {
    let fx = Fx::new().await;
    let token = fx
        .app
        .api_token(&fx.user, json!({"name": "t", "write": true}))
        .await;
    let (_, challenge) = pkce();
    let params = authorize_params(&fx.client_id, CB, &challenge, &[]);
    let pairs: Vec<(&str, &str)> = params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let res = authorize_as(&fx.app, &token, &pairs).await;
    res.assert_status(302);
    assert!(location(&res).starts_with("/login?next="));
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 0);
}

#[tokio::test]
async fn one_person_can_only_start_so_many_requests_a_minute() {
    // Different addresses, one account: the per-person limit is what trips.
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    let user = app.user("busy@example.com", "Busy");
    let client_id = register_client(&app, "Busy App", &[CB]).await;
    for n in 0..openbase::oauth::authorize::REQUESTS_PER_USER_PER_MINUTE {
        let ip = format!("198.51.100.{}", n + 1);
        let res = authorize_from(&app, Some(&user), &ip, &client_id).await;
        res.assert_status(302);
    }
    let res = authorize_from(&app, Some(&user), "198.51.100.200", &client_id).await;
    res.assert_status(429);
    // Somebody else is not affected.
    let other = app.user("calm@example.com", "Calm");
    authorize_from(&app, Some(&other), "198.51.100.201", &client_id)
        .await
        .assert_status(302);
}

/// IPv6 clients are limited per /64, not per address: a subscriber's whole /64 is one budget.
#[tokio::test]
async fn ipv6_clients_share_one_authorization_budget_per_slash_64() {
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    let client_id = register_client(&app, "V6 App", &[CB]).await;
    let limit = openbase::oauth::authorize::REQUESTS_PER_IP_PER_MINUTE;
    for n in 0..limit {
        // Every hit from another address inside 2001:db8:1:2::/64.
        let ip = format!("2001:db8:1:2:{:x}:{:x}::{:x}", n, n + 7, n + 1);
        let res = authorize_from(&app, None, &ip, &client_id).await;
        res.assert_status(302);
    }
    let res = authorize_from(&app, None, "2001:db8:1:2:ffff::1", &client_id).await;
    res.assert_status(429);
    // Another /64 (and an IPv4 address) have their own budgets.
    authorize_from(&app, None, "2001:db8:1:3::1", &client_id)
        .await
        .assert_status(302);
    authorize_from(&app, None, "203.0.113.9", &client_id)
        .await
        .assert_status(302);
}

#[test]
fn rate_keys_group_ipv6_by_slash_64() {
    use openbase::oauth::rate_key;
    assert_eq!(rate_key("203.0.113.9"), "203.0.113.9");
    assert_eq!(
        rate_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
        rate_key("2001:db8:1:2::1")
    );
    assert_ne!(rate_key("2001:db8:1:2::1"), rate_key("2001:db8:1:3::1"));
    assert_eq!(rate_key("::ffff:203.0.113.9"), "203.0.113.9");
    assert_eq!(rate_key("unknown"), "unknown");
}

// --------------------------------------------------------------------------- consent

#[tokio::test]
async fn the_consent_page_gets_everything_it_shows_from_the_server() {
    let fx = Fx::new().await;
    let id = request_id(&fx.authorize(&[("redirect_uri", CB)]).await);
    let info = fx
        .app
        .get(&fx.user, &format!("/api/oauth/requests/{id}"))
        .await;
    info.assert_status(200);
    let b = &info.body;
    assert_eq!(b["id"], id.as_str());
    assert_eq!(b["client_name"], "Fancy App");
    assert_eq!(b["client_source"], "dcr");
    assert_eq!(b["client_id"], fx.client_id.as_str());
    assert_eq!(b["redirect_uri"], CB);
    assert_eq!(b["redirect_host"], "app.example.com");
    assert_eq!(b["loopback"], false);
    assert_eq!(b["trusted_host"], false);
    assert!(b["impersonates"].is_null());
    assert!(b["requested_access"].is_null());
    assert_eq!(
        b["max_access"], "write",
        "no scope asked: Full control is not offered"
    );
    assert_eq!(
        b["default_access"], "read",
        "never preselect more than reading"
    );
    assert!(b["expires_at"].as_i64().unwrap() > openbase::db::now_ms());
}

#[tokio::test]
async fn requested_scopes_set_the_ceiling_and_read_only_is_always_preselected() {
    let fx = Fx::new().await;
    for (scope, requested, max) in [
        ("openbase:read", "read", "read"),
        ("openbase:write", "write", "write"),
        ("openbase:read openbase:write", "write", "write"),
        // The ceiling is what the app asked for; the preselection is always Read only, even for
        // an app that asks for everything.
        (
            "openbase:read openbase:write openbase:manage",
            "manage",
            "manage",
        ),
        ("openbase:manage", "manage", "manage"),
    ] {
        let id = request_id(&fx.authorize(&[("scope", scope)]).await);
        let info = fx
            .app
            .get(&fx.user, &format!("/api/oauth/requests/{id}"))
            .await;
        assert_eq!(info.body["requested_access"], requested, "{scope}");
        assert_eq!(info.body["max_access"], max, "{scope}");
        assert_eq!(info.body["default_access"], "read", "{scope}");
    }
    // Unknown scopes are ignored: the app asked for nothing we know, so it can be given reading
    // and editing, but never Full control.
    let id = request_id(&fx.authorize(&[("scope", "openid profile")]).await);
    let info = fx
        .app
        .get(&fx.user, &format!("/api/oauth/requests/{id}"))
        .await;
    assert!(info.body["requested_access"].is_null());
    assert_eq!(info.body["max_access"], "write");
    assert_eq!(info.body["default_access"], "read");
    approve(&fx.app, &fx.user, &id, "write")
        .await
        .assert_status(200);
}

/// Full control is for apps that ask for it: an app that asked for less (or named nothing) is
/// refused when the decision claims more, whatever the page offered.
#[tokio::test]
async fn full_control_is_only_granted_to_an_app_that_asked_for_it() {
    let fx = Fx::new().await;
    for scope in ["", "openbase:read openbase:write", "openid"] {
        let extra: Vec<(&str, &str)> = if scope.is_empty() {
            vec![]
        } else {
            vec![("scope", scope)]
        };
        let id = request_id(&fx.authorize(&extra).await);
        let res = approve(&fx.app, &fx.user, &id, "manage").await;
        res.assert_status(400);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("more access than the app asked for"),
            "{scope:?}: {}",
            res.body
        );
    }
    assert_eq!(fx.count("SELECT count(*) FROM oauth_codes"), 0);
    let id = request_id(&fx.authorize(&[("scope", "openbase:manage")]).await);
    approve(&fx.app, &fx.user, &id, "manage")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn the_consent_page_is_told_when_to_be_suspicious() {
    let app = TestApp::new();
    let user = app.user("alice@example.com", "Alice");
    let show = |name: &'static str, redirect: &'static str| {
        let (app, user) = (&app, &user);
        async move {
            let client = register_client(app, name, &[redirect]).await;
            let id = request_id(&authorize_with(app, &client, redirect, &pkce().1, &[]).await);
            app.get(user, &format!("/api/oauth/requests/{id}"))
                .await
                .body
        }
    };
    // Claude's own redirect address: trusted, not an imitation.
    let b = show("Claude", "https://claude.ai/api/mcp/auth_callback").await;
    assert_eq!(b["trusted_host"], true);
    assert!(b["impersonates"].is_null());
    assert_eq!(b["loopback"], false);
    let b = show(
        "ChatGPT",
        "https://chatgpt.com/connector_platform_oauth_redirect",
    )
    .await;
    assert_eq!(b["trusted_host"], true);
    assert!(b["impersonates"].is_null());
    // Only the providers' documented callbacks are trusted, not every path on their domains: a
    // GPT's action callback on chat.openai.com is written by whoever made that GPT.
    let b = show(
        "ChatGPT",
        "https://chat.openai.com/aip/g-1234/oauth/callback",
    )
    .await;
    assert_eq!(b["trusted_host"], false);
    assert_eq!(b["impersonates"], "ChatGPT");
    let b = show("My GPT", "https://chatgpt.com/aip/g-1234/oauth/callback").await;
    assert_eq!(b["trusted_host"], false);
    assert!(b["impersonates"].is_null());
    let b = show("Claude", "https://claude.ai/some/other/path").await;
    assert_eq!(b["trusted_host"], false);
    assert_eq!(b["impersonates"], "Claude");
    // The name of a known assistant on another host.
    let b = show("Claude", "https://claude-login.example.net/cb").await;
    assert_eq!(b["trusted_host"], false);
    assert_eq!(b["impersonates"], "Claude");
    let b = show("Official ChatGPT Connector", "https://evil.example/cb").await;
    assert_eq!(b["impersonates"], "ChatGPT");
    let b = show("Cl4ude", "https://claude.ai.evil.example/cb").await;
    assert_eq!(b["impersonates"], "Claude");
    // Capitals and letters of other scripts, fullwidth text and accents do not hide a name.
    for name in [
        "\u{0421}laude",
        "Cl\u{0410}ude",
        "\u{FF23}\u{FF4C}\u{FF41}\u{FF55}\u{FF44}\u{FF45}",
        "Cl\u{00E0}ude",
        "\u{03A7}\u{0043}hatGPT",
    ] {
        let b = show(name, "https://evil.example/cb").await;
        assert!(!b["impersonates"].is_null(), "{name:?} must be flagged");
    }
    // A local app: flagged as loopback; Claude Code is the case where the imitation is expected.
    let b = show("Claude Code", "http://127.0.0.1:53124/callback").await;
    assert_eq!(b["loopback"], true);
    assert_eq!(b["trusted_host"], false);
    assert_eq!(b["impersonates"], "Claude");
    assert_eq!(b["redirect_host"], "127.0.0.1:53124");
    // An unremarkable app has neither.
    let b = show("My Notes", "https://notes.example.org/cb").await;
    assert_eq!(b["trusted_host"], false);
    assert_eq!(b["loopback"], false);
    assert!(b["impersonates"].is_null());
}

/// Names that were stored before the registration check (or that reach the page some other way)
/// are shown without hidden or direction-changing characters, and never longer than 100.
#[tokio::test]
async fn the_consent_page_never_shows_hidden_characters_in_a_name() {
    let fx = Fx::new().await;
    let long = format!("{}\u{202E}", "x".repeat(300));
    for (stored, shown) in [
        ("\u{202E}edualC".to_string(), "edualC".to_string()),
        (
            "Safe\u{200B}\u{2066}App\u{2069}".to_string(),
            "SafeApp".to_string(),
        ),
        (long, "x".repeat(100)),
    ] {
        let id = fx.client_id.clone();
        fx.app
            .state
            .db
            .write_sync(move |tx| {
                tx.execute(
                    "UPDATE oauth_clients SET name = ?2 WHERE id = ?1",
                    rusqlite::params![id, stored],
                )?;
                Ok(())
            })
            .unwrap();
        let req = request_id(&fx.authorize(&[]).await);
        let info = fx
            .app
            .get(&fx.user, &format!("/api/oauth/requests/{req}"))
            .await;
        assert_eq!(info.body["client_name"], shown.as_str());
        // The connected-apps lists and the audit log agree.
        let code = code_of(&approve(&fx.app, &fx.user, &req, "read").await);
        let _ = code;
        let audit = fx.app.state.db.write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT detail FROM audit_log WHERE action = 'oauth_approve' ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get::<_, String>(0),
            )?)
        }).unwrap();
        assert!(
            !audit.contains('\u{202E}') && !audit.contains('\u{200B}'),
            "{audit}"
        );
    }
}

#[tokio::test]
async fn consent_endpoints_are_for_signed_in_people_only() {
    let fx = Fx::new().await;
    let id = request_id(&fx.authorize(&[]).await);
    let path = format!("/api/oauth/requests/{id}");
    let decision = format!("{path}/decision");
    // Signed out.
    fx.app.get(&fx.app.anon(), &path).await.assert_status(401);
    fx.app
        .post(
            &fx.app.anon(),
            &decision,
            json!({"decision": "approve", "access": "manage"}),
        )
        .await
        .assert_status(401);
    // An API token cannot approve, even the most powerful one.
    let token = fx
        .app
        .api_token(
            &fx.user,
            json!({"name": "agent", "write": true, "manage": true}),
        )
        .await;
    fx.app.get(&token, &path).await.assert_status(403);
    let res = fx
        .app
        .post(
            &token,
            &decision,
            json!({"decision": "approve", "access": "manage"}),
        )
        .await;
    res.assert_status(403);
    // An OAuth grant cannot either.
    let granted = connect(&fx.app, &fx.user, "Agent", "manage", None).await;
    fx.app
        .get(&granted.bearer(), &path)
        .await
        .assert_status(401);
    let res = fx
        .app
        .post(
            &granted.bearer(),
            &decision,
            json!({"decision": "approve", "access": "manage"}),
        )
        .await;
    res.assert_status(401);
    // Nothing was approved.
    assert_eq!(
        fx.count("SELECT count(*) FROM oauth_codes"),
        1,
        "only the codes of connect()"
    );
    assert!(
        fx.app.get(&fx.user, &path).await.status == 200,
        "still waiting"
    );
}

#[tokio::test]
async fn approving_needs_the_csrf_header_like_every_state_changing_call() {
    let fx = Fx::new().await;
    let id = request_id(&fx.authorize(&[]).await);
    let res = fx
        .app
        .request_with(
            &fx.user,
            "POST",
            &format!("/api/oauth/requests/{id}/decision"),
            Some(json!({"decision": "approve", "access": "manage"})),
            &[],
            false,
            None,
        )
        .await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("CSRF")
    );
    assert_eq!(fx.count("SELECT count(*) FROM oauth_codes"), 0);
    // With the header it works.
    approve(&fx.app, &fx.user, &id, "read")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn unknown_and_expired_requests_are_not_found() {
    let fx = Fx::new().await;
    let id = request_id(&fx.authorize(&[]).await);
    fx.app
        .get(&fx.user, "/api/oauth/requests/oarNope")
        .await
        .assert_status(404);
    approve(&fx.app, &fx.user, "oarNope", "read")
        .await
        .assert_status(404);
    fx.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE oauth_requests SET expires_at = 1", [])?;
            Ok(())
        })
        .unwrap();
    fx.app
        .get(&fx.user, &format!("/api/oauth/requests/{id}"))
        .await
        .assert_status(404);
    approve(&fx.app, &fx.user, &id, "read")
        .await
        .assert_status(404);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_codes"), 0);
}

#[tokio::test]
async fn approval_returns_the_redirect_with_code_state_and_issuer() {
    let fx = Fx::new().await;
    let id = request_id(&fx.authorize(&[("redirect_uri", CB)]).await);
    let approval = approve(&fx.app, &fx.user, &id, "write").await;
    approval.assert_status(200);
    let to = approval.body["redirect_to"].as_str().unwrap();
    assert!(to.starts_with(&format!("{CB}?")), "{to}");
    let q = query_of(to);
    assert!(q["code"].starts_with("ocd") && q["code"].len() > 40);
    assert_eq!(q["state"], "xyz-state");
    assert_eq!(q["iss"], "http://localhost:8080");
    assert!(!q.contains_key("error"));
    // The code is stored hashed, with a 60 second life.
    let (hash, ttl): (String, i64) = fx
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT code_hash, expires_at - created_at FROM oauth_codes",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(hash, openbase::ids::hash_token(&q["code"]));
    assert_eq!(ttl, 60_000);
    // The request is used up: it cannot be decided twice.
    approve(&fx.app, &fx.user, &id, "manage")
        .await
        .assert_status(404);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_codes"), 1);
}

#[tokio::test]
async fn approving_with_a_registered_redirect_that_has_a_query_keeps_it() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let uri = "https://app.example.com/cb?tenant=42";
    let client = register_client(&app, "Q", &[uri]).await;
    let id = request_id(&authorize_with(&app, &client, uri, &pkce().1, &[]).await);
    let approval = approve(&app, &user, &id, "read").await;
    let q = query_of(approval.body["redirect_to"].as_str().unwrap());
    assert_eq!(q["tenant"], "42");
    assert!(q.contains_key("code"));
}

#[tokio::test]
async fn denying_sends_access_denied_and_issues_nothing() {
    let fx = Fx::new().await;
    let id = request_id(&fx.authorize(&[]).await);
    let res = decide(&fx.app, &fx.user, &id, json!({"decision": "deny"})).await;
    res.assert_status(200);
    let to = res.body["redirect_to"].as_str().unwrap();
    assert!(to.starts_with(&format!("{CB}?")));
    let q = query_of(to);
    assert_eq!(q["error"], "access_denied");
    assert_eq!(q["state"], "xyz-state");
    assert_eq!(q["iss"], "http://localhost:8080");
    assert!(!q.contains_key("code"));
    assert_eq!(fx.count("SELECT count(*) FROM oauth_codes"), 0);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_requests"), 0);
    assert!(audit_actions(&fx.app).contains(&"oauth_deny".to_string()));
}

#[tokio::test]
async fn the_user_picks_the_access_within_what_the_app_asked_for() {
    let fx = Fx::new().await;
    let (ws, base) = fx.app.workspace_with_base(&fx.user, "Acme");
    let _ = ws;
    let other = fx.app.user("bob@example.com", "Bob");
    let (_, other_base) = fx.app.workspace_with_base(&other, "Bobs");
    let stage = |scope: &'static str| {
        let fx = &fx;
        async move { request_id(&fx.authorize(&[("scope", scope)]).await) }
    };
    // A missing or unknown level.
    let id = stage("").await;
    for body in [
        json!({"decision": "approve"}),
        json!({"decision": "approve", "access": "root"}),
        json!({"decision": "approve", "access": ""}),
        json!({"decision": "maybe", "access": "read"}),
        json!({"access": "read"}),
    ] {
        decide(&fx.app, &fx.user, &id, body)
            .await
            .assert_status(400);
    }
    // More than the app asked for.
    let id2 = stage("openbase:read").await;
    let res = approve(&fx.app, &fx.user, &id2, "write").await;
    res.assert_status(400);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("more access")
    );
    let id3 = stage("openbase:write").await;
    approve(&fx.app, &fx.user, &id3, "manage")
        .await
        .assert_status(400);
    // Bases: empty list, unknown base, somebody else's base, too many.
    for ids in [
        json!([]),
        json!(["appNope"]),
        json!([other_base]),
        json!((0..101).map(|i| format!("app{i}")).collect::<Vec<_>>()),
    ] {
        let res = decide(
            &fx.app,
            &fx.user,
            &id,
            json!({"decision": "approve", "access": "read", "base_ids": ids}),
        )
        .await;
        res.assert_status(400);
    }
    // Rejected approvals leave the request waiting and issue nothing.
    assert_eq!(fx.count("SELECT count(*) FROM oauth_codes"), 0);
    fx.app
        .get(&fx.user, &format!("/api/oauth/requests/{id}"))
        .await
        .assert_status(200);
    // A valid choice, limited to one base.
    let res = decide(
        &fx.app,
        &fx.user,
        &id,
        json!({"decision": "approve", "access": "write", "base_ids": [base, base]}),
    )
    .await;
    res.assert_status(200);
    let scopes: String = fx
        .app
        .state
        .db
        .write_sync(|tx| Ok(tx.query_row("SELECT scopes FROM oauth_codes", [], |r| r.get(0))?))
        .unwrap();
    let scopes: Value = serde_json::from_str(&scopes).unwrap();
    assert_eq!(
        scopes,
        json!({"write": true, "manage": false, "base_ids": [base]})
    );
}

// ----------------------------------------------------------------------------- token

#[tokio::test]
async fn a_code_is_exchanged_for_tokens() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("write").await;
    let res = fx.exchange(&code, &verifier).await;
    res.assert_status(200);
    let b = &res.body;
    assert_eq!(b["token_type"], "Bearer");
    assert_eq!(b["expires_in"], 3600);
    assert_eq!(b["scope"], "openbase:read openbase:write");
    let access = b["access_token"].as_str().unwrap();
    let refresh = b["refresh_token"].as_str().unwrap();
    assert!(access.starts_with("oat") && access.len() == 46);
    assert!(refresh.starts_with("ort") && refresh.len() == 46);
    assert_eq!(res.headers["cache-control"], "no-store");
    assert_eq!(res.headers["pragma"], "no-cache");
    // Hashed at rest, with the lifetimes of the design.
    let rows: Vec<(String, String, i64)> = fx
        .app
        .state
        .db
        .write_sync(|tx| {
            let mut stmt = tx.prepare(
                "SELECT token_hash, kind, expires_at - created_at FROM oauth_tokens ORDER BY kind",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            Ok(rows.map(|r| r.unwrap()).collect())
        })
        .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                openbase::ids::hash_token(access),
                "access".into(),
                3_600_000
            ),
            (
                openbase::ids::hash_token(refresh),
                "refresh".into(),
                30 * 24 * 3_600_000
            ),
        ]
    );
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 1);
    assert!(audit_actions(&fx.app).contains(&"oauth_grant_create".to_string()));
    assert!(audit_actions(&fx.app).contains(&"oauth_approve".to_string()));
}

#[tokio::test]
async fn the_scope_in_the_response_is_what_was_granted() {
    let fx = Fx::new().await;
    for (access, scope) in [
        ("read", "openbase:read"),
        ("write", "openbase:read openbase:write"),
        ("manage", "openbase:read openbase:write openbase:manage"),
    ] {
        let (code, verifier) = fx.code(access).await;
        let res = fx.exchange(&code, &verifier).await;
        assert_eq!(res.body["scope"], scope, "{access}");
    }
}

#[tokio::test]
async fn a_wrong_verifier_fails_and_burns_the_code() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("read").await;
    let wrong = fx.exchange(&code, &"x".repeat(64)).await;
    wrong.assert_status(400);
    assert_eq!(error_of(&wrong).0, "invalid_grant");
    // Even the right verifier cannot be used now.
    let res = fx.exchange(&code, &verifier).await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_grant");
    assert_eq!(fx.count("SELECT count(*) FROM oauth_tokens"), 0);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
}

#[tokio::test]
async fn pkce_verifiers_that_are_malformed_never_match() {
    let fx = Fx::new().await;
    // The challenge itself offered as verifier (what "plain" would accept).
    let (verifier, challenge) = pkce();
    let id = request_id(&authorize_with(&fx.app, &fx.client_id, CB, &challenge, &[]).await);
    let code = code_of(&approve(&fx.app, &fx.user, &id, "read").await);
    assert_eq!(fx.exchange(&code, &challenge).await.status, 400);
    let _ = verifier;
    // A short verifier whose hash is the stored challenge.
    for short in ["a".repeat(42), "a".repeat(129), "a b".repeat(20)] {
        let challenge = {
            use base64::Engine;
            use sha2::{Digest, Sha256};
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(Sha256::digest(short.as_bytes()))
        };
        let id = request_id(&authorize_with(&fx.app, &fx.client_id, CB, &challenge, &[]).await);
        let code = code_of(&approve(&fx.app, &fx.user, &id, "read").await);
        let res = fx.exchange(&code, &short).await;
        res.assert_status(400);
        assert_eq!(error_of(&res).0, "invalid_grant", "{short:?}");
    }
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
}

#[tokio::test]
async fn the_redirect_uri_must_be_repeated_exactly() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("read").await;
    for wrong in [
        LOOPBACK_REDIRECT,
        "https://app.example.com/oauth/callback/",
        "https://evil.example/cb",
    ] {
        let res = token_code(&fx.app, &fx.client_id, &code, wrong, &verifier).await;
        res.assert_status(400);
        assert_eq!(error_of(&res).0, "invalid_grant");
    }
    // The first failure burned the code.
    fx.exchange(&code, &verifier).await.assert_status(400);
}

#[tokio::test]
async fn a_code_belongs_to_the_client_it_was_issued_to() {
    let fx = Fx::new().await;
    let other = register_client(&fx.app, "Other App", &[CB]).await;
    let (code, verifier) = fx.code("read").await;
    let res = token_code(&fx.app, &other, &code, CB, &verifier).await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_grant");
    // The rightful client is not locked out by somebody else's attempt.
    fx.exchange(&code, &verifier).await.assert_status(200);
    // Unknown clients are rejected before the code is looked at.
    let res = token_code(&fx.app, "oclNope", &code, CB, &verifier).await;
    res.assert_status(401);
    assert_eq!(error_of(&res).0, "invalid_client");
}

#[tokio::test]
async fn codes_expire_after_sixty_seconds() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("read").await;
    fx.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_codes SET expires_at = ?1",
                [openbase::db::now_ms() - 1],
            )?;
            Ok(())
        })
        .unwrap();
    let res = fx.exchange(&code, &verifier).await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_grant");
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
}

#[tokio::test]
async fn replaying_a_code_revokes_what_it_issued() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("manage").await;
    let first = fx.exchange(&code, &verifier).await;
    first.assert_status(200);
    let access = first.body["access_token"].as_str().unwrap().to_string();
    let refresh = first.body["refresh_token"].as_str().unwrap().to_string();
    // The tokens work...
    let mcp = TestApp::bearer(&access);
    mcp_support::legacy(&fx.app, &mcp, "tools/list", json!({}))
        .await
        .assert_status(200);

    // ...until somebody presents the code again.
    let replay = fx.exchange(&code, &verifier).await;
    replay.assert_status(400);
    assert_eq!(error_of(&replay).0, "invalid_grant");
    mcp_support::legacy(&fx.app, &mcp, "tools/list", json!({}))
        .await
        .assert_status(401);
    let res = token_refresh(&fx.app, &fx.client_id, &refresh).await;
    res.assert_status(400);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_tokens"), 0);
    assert!(audit_actions(&fx.app).contains(&"oauth_code_replay".to_string()));
}

#[tokio::test]
async fn token_requests_are_checked_for_shape() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("read").await;
    let c = fx.client_id.as_str();
    let auth = [("grant_type", "authorization_code"), ("client_id", c)];
    let with = |extra: &[(&'static str, &str)]| -> Vec<(&'static str, String)> {
        auth.iter()
            .chain(extra.iter())
            .map(|(k, v)| (*k, v.to_string()))
            .collect()
    };
    let post_owned = |pairs: Vec<(&'static str, String)>| {
        let app = &fx.app;
        async move {
            let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
            form(app, "/oauth/token", &refs).await
        }
    };
    // Missing parts.
    for pairs in [
        with(&[("redirect_uri", CB), ("code_verifier", &verifier)]),
        with(&[("code", &code), ("code_verifier", &verifier)]),
        with(&[("code", &code), ("redirect_uri", CB)]),
    ] {
        let res = post_owned(pairs).await;
        res.assert_status(400);
        assert_eq!(error_of(&res).0, "invalid_request");
    }
    // No grant type, an unsupported one, no client.
    let res = form(&fx.app, "/oauth/token", &[("client_id", c)]).await;
    assert_eq!(error_of(&res).0, "unsupported_grant_type");
    for grant in ["password", "client_credentials", "implicit"] {
        let res = form(
            &fx.app,
            "/oauth/token",
            &[("grant_type", grant), ("client_id", c)],
        )
        .await;
        res.assert_status(400);
        assert_eq!(error_of(&res).0, "unsupported_grant_type", "{grant}");
    }
    let res = form(
        &fx.app,
        "/oauth/token",
        &[("grant_type", "authorization_code")],
    )
    .await;
    assert_eq!(error_of(&res).0, "invalid_request");
    // A repeated parameter.
    let res = post_owned(with(&[
        ("code", &code),
        ("code", "other"),
        ("redirect_uri", CB),
        ("code_verifier", &verifier),
    ]))
    .await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_request");
    // Not a form.
    let res = raw_body(
        &fx.app,
        "POST",
        "/oauth/token",
        "application/json",
        serde_json::to_vec(&json!({"grant_type": "authorization_code"})).unwrap(),
        &[],
    )
    .await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_request");
    // Too large.
    let res = raw_body(
        &fx.app,
        "POST",
        "/oauth/token",
        "application/x-www-form-urlencoded",
        format!("grant_type=authorization_code&junk={}", "j".repeat(20_000)).into_bytes(),
        &[],
    )
    .await;
    res.assert_status(400);
    // The code survived all of that (nothing reached it) and still works.
    fx.exchange(&code, &verifier).await.assert_status(200);
    // GET is not a token endpoint.
    get(&fx.app, "/oauth/token").await.assert_status(405);
}

#[tokio::test]
async fn the_resource_parameter_must_name_this_server() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("read").await;
    let c = fx.client_id.as_str();
    let res = form(
        &fx.app,
        "/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("client_id", c),
            ("code", &code),
            ("redirect_uri", CB),
            ("code_verifier", &verifier),
            ("resource", "https://other.example/mcp"),
        ],
    )
    .await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_target");
    // Naming this server is fine, and the token is bound to it.
    let res = form(
        &fx.app,
        "/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("client_id", c),
            ("code", &code),
            ("redirect_uri", CB),
            ("code_verifier", &verifier),
            ("resource", "http://localhost:8080/mcp"),
        ],
    )
    .await;
    res.assert_status(200);
    let resource: String = fx
        .app
        .state
        .db
        .write_sync(|tx| Ok(tx.query_row("SELECT resource FROM oauth_grants", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(resource, "http://localhost:8080/mcp");
}

#[tokio::test]
async fn an_inactive_user_gets_no_tokens() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("read").await;
    fx.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE users SET is_active = 0", [])?;
            Ok(())
        })
        .unwrap();
    let res = fx.exchange(&code, &verifier).await;
    res.assert_status(400);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
}

#[tokio::test]
async fn a_user_can_only_have_so_many_connected_apps() {
    let fx = Fx::new().await;
    fx.app
        .state
        .db
        .write_sync(|tx| {
            let uid: String = tx.query_row("SELECT id FROM users", [], |r| r.get(0))?;
            for i in 0..openbase::store::oauth::MAX_GRANTS_PER_USER {
                tx.execute(
                    "INSERT INTO oauth_grants (id, user_id, client_id, redirect_uri, resource, scopes, created_at)
                     VALUES (?1, ?2, ?3, 'x', 'y', '{\"write\":false,\"manage\":false}', 1)",
                    rusqlite::params![format!("grt{i}"), uid, fx.client_id],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let (code, verifier) = fx.code("read").await;
    let res = fx.exchange(&code, &verifier).await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_grant");
    assert!(error_of(&res).1.contains("revoke"));
}

#[tokio::test]
async fn the_token_endpoint_is_rate_limited_per_address() {
    let fx = Fx::new().await;
    for _ in 0..300 {
        let res = form(&fx.app, "/oauth/token", &[("grant_type", "x")]).await;
        assert_eq!(res.status, 400);
    }
    let res = form(&fx.app, "/oauth/token", &[("grant_type", "x")]).await;
    res.assert_status(429);
}

// ---------------------------------------------------------------------------- refresh

#[tokio::test]
async fn refresh_tokens_rotate() {
    let fx = Fx::new().await;
    let first = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "write", None).await;
    let res = token_refresh(&fx.app, &fx.client_id, &first.refresh).await;
    res.assert_status(200);
    assert_ne!(res.body["refresh_token"], first.refresh.as_str());
    assert_ne!(res.body["access_token"], first.access.as_str());
    assert_eq!(res.body["token_type"], "Bearer");
    assert_eq!(res.body["expires_in"], 3600);
    assert_eq!(res.body["scope"], "openbase:read openbase:write");
    assert_eq!(res.headers["cache-control"], "no-store");
    // The new pair works; the grant is the same one.
    let new_access = TestApp::bearer(res.body["access_token"].as_str().unwrap());
    mcp_support::legacy(&fx.app, &new_access, "tools/list", json!({}))
        .await
        .assert_status(200);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 1);
    // And again, with the newest refresh token.
    let again = token_refresh(
        &fx.app,
        &fx.client_id,
        res.body["refresh_token"].as_str().unwrap(),
    )
    .await;
    again.assert_status(200);
}

#[tokio::test]
async fn presenting_an_old_refresh_token_revokes_the_whole_grant() {
    let fx = Fx::new().await;
    let first = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "write", None).await;
    let second = token_refresh(&fx.app, &fx.client_id, &first.refresh).await;
    second.assert_status(200);
    let newest = second.body["refresh_token"].as_str().unwrap().to_string();
    let newest_access = TestApp::bearer(second.body["access_token"].as_str().unwrap());
    mcp_support::legacy(&fx.app, &newest_access, "tools/list", json!({}))
        .await
        .assert_status(200);

    // The first token is used again, well after the grace window (by the app after a lost
    // response, or by a thief).
    fx.age_used_refresh_tokens(31);
    let reuse = token_refresh(&fx.app, &fx.client_id, &first.refresh).await;
    reuse.assert_status(400);
    assert_eq!(error_of(&reuse).0, "invalid_grant");
    assert!(error_of(&reuse).1.contains("revoked"));
    // Everything issued for the grant is dead, including the newest tokens.
    mcp_support::legacy(&fx.app, &newest_access, "tools/list", json!({}))
        .await
        .assert_status(401);
    token_refresh(&fx.app, &fx.client_id, &newest)
        .await
        .assert_status(400);
    mcp_support::legacy(&fx.app, &first.bearer(), "tools/list", json!({}))
        .await
        .assert_status(401);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_tokens"), 0);
    assert!(audit_actions(&fx.app).contains(&"oauth_refresh_reuse".to_string()));
    let grants = fx.app.get(&fx.user, "/api/oauth/grants").await;
    assert_eq!(grants.body, json!([]));
}

/// Two refreshes of the same token at once (two tabs, two workers of one app) must not destroy
/// the connection: one gets the new pair, the other `invalid_grant`, and nothing is revoked.
#[tokio::test]
async fn parallel_refreshes_with_one_token_do_not_revoke_the_connection() {
    let fx = Fx::new().await;
    let c = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "write", None).await;
    let (a, b) = tokio::join!(
        token_refresh(&fx.app, &fx.client_id, &c.refresh),
        token_refresh(&fx.app, &fx.client_id, &c.refresh),
    );
    let (ok, refused) = if a.status == 200 { (a, b) } else { (b, a) };
    ok.assert_status(200);
    refused.assert_status(400);
    assert_eq!(error_of(&refused).0, "invalid_grant");
    // The connection is alive: the pair the winner got works and can be refreshed again.
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 1);
    let access = TestApp::bearer(ok.body["access_token"].as_str().unwrap());
    mcp_support::legacy(&fx.app, &access, "tools/list", json!({}))
        .await
        .assert_status(200);
    token_refresh(
        &fx.app,
        &fx.client_id,
        ok.body["refresh_token"].as_str().unwrap(),
    )
    .await
    .assert_status(200);
    assert!(!audit_actions(&fx.app).contains(&"oauth_refresh_reuse".to_string()));
}

#[tokio::test]
async fn reusing_a_refresh_token_inside_the_grace_window_revokes_nothing_after_it_everything() {
    let fx = Fx::new().await;
    let first = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "write", None).await;
    let second = token_refresh(&fx.app, &fx.client_id, &first.refresh).await;
    second.assert_status(200);
    // Right away: refused, the newest pair keeps working.
    let early = token_refresh(&fx.app, &fx.client_id, &first.refresh).await;
    early.assert_status(400);
    assert_eq!(error_of(&early).0, "invalid_grant");
    assert!(!error_of(&early).1.contains("revoked"));
    token_refresh(
        &fx.app,
        &fx.client_id,
        second.body["refresh_token"].as_str().unwrap(),
    )
    .await
    .assert_status(200);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 1);
    // Past the window the same token means theft: the connection ends.
    fx.age_used_refresh_tokens(31);
    let late = token_refresh(&fx.app, &fx.client_id, &first.refresh).await;
    assert!(error_of(&late).1.contains("revoked"), "{}", late.body);
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
}

#[tokio::test]
async fn refresh_tokens_expire_after_thirty_idle_days() {
    let fx = Fx::new().await;
    let c = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "read", None).await;
    // Twenty-nine days later it still works, and the new token is good for thirty more.
    fx.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_tokens SET expires_at = ?1 WHERE kind = 'refresh'",
                [openbase::db::now_ms() + 24 * 3_600_000],
            )?;
            Ok(())
        })
        .unwrap();
    let res = token_refresh(&fx.app, &fx.client_id, &c.refresh).await;
    res.assert_status(200);
    let ttl_days: i64 = fx
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT (expires_at - created_at) / 86400000 FROM oauth_tokens
                 WHERE kind = 'refresh' AND used_at IS NULL",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(ttl_days, 30);
    // Past its expiry it is dead.
    fx.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_tokens SET expires_at = ?1 WHERE kind = 'refresh'",
                [openbase::db::now_ms() - 1],
            )?;
            Ok(())
        })
        .unwrap();
    let dead = token_refresh(
        &fx.app,
        &fx.client_id,
        res.body["refresh_token"].as_str().unwrap(),
    )
    .await;
    dead.assert_status(400);
    assert_eq!(error_of(&dead).0, "invalid_grant");
}

#[tokio::test]
async fn refresh_tokens_are_bound_to_their_client_and_to_a_working_account() {
    let fx = Fx::new().await;
    let c = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "read", None).await;
    let other = register_client(&fx.app, "Other", &[CB]).await;
    let res = token_refresh(&fx.app, &other, &c.refresh).await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_grant");
    // Another client's attempt neither used the token up nor revoked anything.
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 1);
    // Unknown token, missing token, unknown client.
    assert_eq!(
        error_of(&token_refresh(&fx.app, &fx.client_id, "ortNope").await).0,
        "invalid_grant"
    );
    let res = form(
        &fx.app,
        "/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("client_id", fx.client_id.as_str()),
        ],
    )
    .await;
    assert_eq!(error_of(&res).0, "invalid_request");
    assert_eq!(
        token_refresh(&fx.app, "oclNope", &c.refresh).await.status,
        401
    );
    // An access token is not a refresh token, nor the other way around.
    assert_eq!(
        error_of(&token_refresh(&fx.app, &fx.client_id, &c.access).await).0,
        "invalid_grant"
    );
    mcp_support::legacy(
        &fx.app,
        &TestApp::bearer(&c.refresh),
        "tools/list",
        json!({}),
    )
    .await
    .assert_status(401);
    // A deactivated user's refresh token stops working.
    fx.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE users SET is_active = 0", [])?;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        error_of(&token_refresh(&fx.app, &fx.client_id, &c.refresh).await).0,
        "invalid_grant"
    );
}

#[tokio::test]
async fn a_refresh_may_repeat_the_scope_but_neither_widen_nor_narrow_it() {
    let fx = Fx::new().await;
    let c = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "write", None).await;
    let post = |scope: &'static str, refresh: String| {
        let (app, cid) = (&fx.app, fx.client_id.clone());
        async move {
            form(
                app,
                "/oauth/token",
                &[
                    ("grant_type", "refresh_token"),
                    ("client_id", &cid),
                    ("refresh_token", &refresh),
                    ("scope", scope),
                ],
            )
            .await
        }
    };
    let res = post(
        "openbase:read openbase:write openbase:manage",
        c.refresh.clone(),
    )
    .await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_scope");
    // The refused attempt did not use the token up.
    // Asking for less is refused as well: tokens carry the scope of the connection, so a
    // read-only request must never be answered with a token that can write.
    let res = post("openbase:read", c.refresh.clone()).await;
    res.assert_status(400);
    assert_eq!(error_of(&res).0, "invalid_scope");
    assert!(error_of(&res).1.contains("narrow"), "{}", res.body);
    assert_eq!(
        fx.count("SELECT count(*) FROM oauth_tokens WHERE used_at IS NOT NULL"),
        0
    );
    // Exactly the granted scope (in any order, with unknown names ignored) is fine and the
    // answer names it.
    let res = post("openbase:write openbase:read mcp", c.refresh.clone()).await;
    res.assert_status(200);
    assert_eq!(res.body["scope"], "openbase:read openbase:write");
    // So is no scope at all.
    let next = res.body["refresh_token"].as_str().unwrap().to_string();
    token_refresh(&fx.app, &fx.client_id, &next)
        .await
        .assert_status(200);
}

// ---------------------------------------------------------------------------- revoke

#[tokio::test]
async fn revoking_either_token_ends_the_connection() {
    let fx = Fx::new().await;
    for use_refresh in [false, true] {
        let c = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "write", None).await;
        let token = if use_refresh { &c.refresh } else { &c.access };
        let res = form(
            &fx.app,
            "/oauth/revoke",
            &[
                ("token", token),
                ("client_id", &fx.client_id),
                (
                    "token_type_hint",
                    if use_refresh {
                        "refresh_token"
                    } else {
                        "access_token"
                    },
                ),
            ],
        )
        .await;
        res.assert_status(200);
        mcp_support::legacy(&fx.app, &c.bearer(), "tools/list", json!({}))
            .await
            .assert_status(401);
        token_refresh(&fx.app, &fx.client_id, &c.refresh)
            .await
            .assert_status(400);
    }
    assert_eq!(fx.count("SELECT count(*) FROM oauth_grants"), 0);
    assert!(audit_actions(&fx.app).contains(&"oauth_grant_revoke".to_string()));
}

#[tokio::test]
async fn revocation_never_confirms_whether_a_token_existed() {
    let fx = Fx::new().await;
    let c = connect_as(&fx.app, &fx.user, &fx.client_id, CB, "write", None).await;
    let other = register_client(&fx.app, "Other", &[CB]).await;
    let revoke = |token: &str, client: &str| {
        let (app, token, client) = (&fx.app, token.to_string(), client.to_string());
        async move {
            form(
                app,
                "/oauth/revoke",
                &[("token", &token), ("client_id", &client)],
            )
            .await
        }
    };
    // Unknown token: 200. Another client's token: 200 and untouched.
    revoke("oatNope", &fx.client_id).await.assert_status(200);
    revoke(&c.access, &other).await.assert_status(200);
    mcp_support::legacy(&fx.app, &c.bearer(), "tools/list", json!({}))
        .await
        .assert_status(200);
    // Unknown client: refused. No token: invalid_request.
    revoke(&c.access, "oclNope").await.assert_status(401);
    let res = form(
        &fx.app,
        "/oauth/revoke",
        &[("client_id", fx.client_id.as_str())],
    )
    .await;
    assert_eq!(error_of(&res).0, "invalid_request");
    // Revoking twice is fine.
    revoke(&c.access, &fx.client_id).await.assert_status(200);
    revoke(&c.access, &fx.client_id).await.assert_status(200);
    mcp_support::legacy(&fx.app, &c.bearer(), "tools/list", json!({}))
        .await
        .assert_status(401);
}

// --------------------------------------------------------------------- hygiene

#[tokio::test]
async fn no_secret_is_stored_in_the_clear() {
    let fx = Fx::new().await;
    let (code, verifier) = fx.code("manage").await;
    let res = fx.exchange(&code, &verifier).await;
    let secrets = [
        code,
        res.body["access_token"].as_str().unwrap().to_string(),
        res.body["refresh_token"].as_str().unwrap().to_string(),
    ];
    // Every text column of every OAuth table, and the audit log.
    let dump: String = fx
        .app
        .state
        .db
        .write_sync(|tx| {
            let mut out = String::new();
            for table in [
                "oauth_clients",
                "oauth_requests",
                "oauth_codes",
                "oauth_grants",
                "oauth_tokens",
                "audit_log",
            ] {
                let mut stmt = tx.prepare(&format!("SELECT * FROM {table}"))?;
                let n = stmt.column_count();
                let mut rows = stmt.query([])?;
                while let Some(row) = rows.next()? {
                    for i in 0..n {
                        let v: rusqlite::types::Value = row.get(i)?;
                        out.push_str(&format!("{v:?}\n"));
                    }
                }
            }
            Ok(out)
        })
        .unwrap();
    assert!(dump.len() > 200);
    for s in &secrets {
        assert!(
            !dump.contains(s.as_str()),
            "{} is stored in the clear",
            &s[..6]
        );
    }
}
