//! Hardening from the 2026-11-07 review (SEC-4): the CSRF Origin check, share-link password
//! rules and guess cap, response headers, the `__Host-` session cookie with its idle timeout, and
//! the real client address seen by in-process MCP requests.

mod automations_support;
mod common;
mod mcp_support;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;
mod sse_support;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, header};
use common::{Client, Response, TestApp};
use mcp_support::Rig;
use openbase::db::now_ms;
use openbase::ratelimit::GuessLimiter;
use schema_support::Fixture;
use serde_json::json;
use share_support::anon;

/// `Config::for_tests`' public URL.
const HTTP_ORIGIN: &str = "http://localhost:8080";
const HTTPS_URL: &str = "https://base.example.com";

fn https_app() -> TestApp {
    TestApp::with_config(|c| c.public_url = HTTPS_URL.into())
}

fn set_cookies(res: &Response) -> Vec<String> {
    res.headers
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect()
}

fn header_of<'a>(res: &'a Response, name: &str) -> Option<&'a str> {
    res.headers.get(name).and_then(|v| v.to_str().ok())
}

/// A request that carries the session `token` under the cookie `name` (the test harness only
/// knows the plain-http name).
async fn with_cookie(
    app: &TestApp,
    name: &str,
    token: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
) -> Response {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::COOKIE, format!("{name}={token}"))
        .header(openbase::http::CSRF_HEADER, "1");
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    app.send(req.body(Body::empty()).unwrap()).await
}

// ------------------------------------------------------------------ SEC-4.1 CSRF Origin check

async fn create_workspace(app: &TestApp, c: &Client, headers: &[(&str, &str)]) -> Response {
    app.request_with(
        c,
        "POST",
        "/api/workspaces",
        Some(json!({ "name": "W" })),
        headers,
        true,
        None,
    )
    .await
}

#[tokio::test]
async fn a_cookie_request_from_another_origin_is_refused() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");

    for origin in [
        "https://evil.example",
        "http://localhost:8081",
        "https://localhost:8080",
        "http://localhost",
        "null",
        "not an origin",
    ] {
        let r = create_workspace(&app, &me, &[("origin", origin)]).await;
        r.assert_status(403);
        assert_eq!(r.body["error"]["message"], "cross-origin request refused");
    }
    assert_eq!(
        app.query_i64("SELECT count(*) FROM workspaces", &[]),
        0,
        "nothing was created by a refused request"
    );

    // The right origin passes, however it is spelled.
    create_workspace(&app, &me, &[("origin", HTTP_ORIGIN)])
        .await
        .assert_status(201);
    create_workspace(&app, &me, &[("origin", "HTTP://LOCALHOST:8080")])
        .await
        .assert_status(201);
}

#[tokio::test]
async fn the_referer_decides_only_when_there_is_no_origin() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");

    create_workspace(&app, &me, &[("referer", "https://evil.example/x")])
        .await
        .assert_status(403);
    create_workspace(&app, &me, &[("referer", "garbage")])
        .await
        .assert_status(403);
    create_workspace(
        &app,
        &me,
        &[("referer", "http://localhost:8080/b/app1/t/tbl1")],
    )
    .await
    .assert_status(201);
    // Origin is authoritative when both are sent.
    create_workspace(
        &app,
        &me,
        &[
            ("origin", HTTP_ORIGIN),
            ("referer", "https://evil.example/x"),
        ],
    )
    .await
    .assert_status(201);
    create_workspace(
        &app,
        &me,
        &[
            ("origin", "https://evil.example"),
            ("referer", "http://localhost:8080/"),
        ],
    )
    .await
    .assert_status(403);
    // Neither header: a non-browser client holding a cookie (it still needs the CSRF header).
    create_workspace(&app, &me, &[]).await.assert_status(201);
}

#[tokio::test]
async fn the_csrf_header_is_still_required_alongside_the_origin_check() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");
    let r = app
        .request_with(
            &me,
            "POST",
            "/api/workspaces",
            Some(json!({ "name": "W" })),
            &[("origin", HTTP_ORIGIN)],
            false,
            None,
        )
        .await;
    r.assert_status(403);
    assert_eq!(r.body["error"]["message"], "missing CSRF header");
}

#[tokio::test]
async fn bearer_clients_anonymous_posts_and_reads_are_not_subject_to_the_origin_check() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");
    let token = app
        .api_token(&me, json!({ "name": "t", "write": true, "manage": true }))
        .await;
    let evil = [("origin", "https://evil.example")];

    // A token holder is not browser-authenticated: no ambient credentials to abuse.
    create_workspace(&app, &token, &evil)
        .await
        .assert_status(201);
    // An anonymous visitor (public form) gets the normal answer, not a 403.
    let r = anon_with_origin(&app, "POST", "/api/public/forms/nope/submit").await;
    r.assert_status(404);
    let r = anon_with_origin(&app, "POST", "/api/auth/login").await;
    assert_ne!(r.status.as_u16(), 403, "{}", r.body);
    // Safe methods are never CSRF-relevant.
    app.request_with(&me, "GET", "/api/auth/me", None, &evil, true, None)
        .await
        .assert_status(200);
}

async fn anon_with_origin(app: &TestApp, method: &str, path: &str) -> Response {
    app.request_with(
        &Client::default(),
        method,
        path,
        Some(json!({ "values": {}, "email": "x@example.com", "password": "x" })),
        &[("origin", "https://evil.example")],
        false,
        None,
    )
    .await
}

#[tokio::test]
async fn the_origin_is_compared_with_the_https_public_url() {
    let app = https_app();
    let (res, _) = app
        .signup("a@example.com", "correct horse battery", None)
        .await;
    res.assert_status(200);
    let token = host_cookie_token(&res);
    for (origin, status) in [
        (HTTPS_URL, 201),
        ("https://base.example.com:443", 201),
        ("http://base.example.com", 403),
        ("https://evil.example", 403),
        ("https://base.example.com.evil.example", 403),
        ("https://sub.base.example.com", 403),
    ] {
        let r = https_workspace_post(&app, &token, origin).await;
        assert_eq!(r.status.as_u16(), status, "{origin}: {}", r.body);
    }
}

async fn https_workspace_post(app: &TestApp, token: &str, origin: &str) -> Response {
    let req = Request::builder()
        .method("POST")
        .uri("/api/workspaces")
        .header(header::COOKIE, format!("__Host-ob_session={token}"))
        .header(openbase::http::CSRF_HEADER, "1")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, origin)
        .body(Body::from(json!({ "name": "W" }).to_string()))
        .unwrap();
    app.send(req).await
}

// ----------------------------------------------------- SEC-4.2 share password length and cap

#[tokio::test]
async fn new_share_passwords_need_eight_characters_but_older_ones_keep_working() {
    let f = Fixture::new().await;
    let views = &f.view_id;
    async fn mk(f: &Fixture, pw: &str) -> Response {
        f.app
            .post(
                &f.owner,
                &format!("/api/views/{}/shares", f.view_id),
                json!({ "kind": "view", "password": pw }),
            )
            .await
    }
    mk(&f, "1234567").await.assert_status(400);
    mk(&f, "abcd").await.assert_status(400);
    // Eight characters, counted as characters and not bytes.
    mk(&f, "12345678").await.assert_status(201);
    mk(&f, "pässwörd").await.assert_status(201);
    mk(&f, "ééééééé").await.assert_status(400);

    // Updating a link applies the same rule.
    let link = f.share(views, "view", None).await;
    let id = link["id"].as_str().unwrap().to_string();
    let short = f
        .app
        .patch(
            &f.owner,
            &format!("/api/shares/{id}"),
            json!({ "password": "1234567" }),
        )
        .await;
    short.assert_status(400);
    assert!(
        short.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("8 to 256"),
        "{}",
        short.body
    );
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{id}"),
            json!({ "password": "12345678" }),
        )
        .await
        .assert_status(200);
    // Enabling or disabling a link that has an old password does not ask for a new one.
    f.app
        .patch(
            &f.owner,
            &format!("/api/shares/{id}"),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);

    // A password from when four characters were enough still opens its link.
    let old = f.share(views, "view", None).await;
    let old_id = old["id"].as_str().unwrap().to_string();
    let hash = openbase::auth::password::hash("abcd").unwrap();
    f.app
        .state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE share_links SET password_hash = ?1 WHERE id = ?2",
                rusqlite::params![hash, old_id],
            )?;
            Ok(())
        })
        .unwrap();
    let token = old["token"].as_str().unwrap();
    let path = format!("/api/public/shares/{token}");
    anon(
        &f.app,
        "GET",
        &path,
        None,
        &[("x-share-password", "abcd")],
        "10.0.0.1",
    )
    .await
    .assert_status(200);
    anon(
        &f.app,
        "GET",
        &path,
        None,
        &[("x-share-password", "abce")],
        "10.0.0.1",
    )
    .await
    .assert_status(401);
}

/// A manual clock for the guess cap, and the fixture built on it.
async fn fixture_with_clock() -> (Fixture, Arc<Mutex<Instant>>) {
    let now = Arc::new(Mutex::new(Instant::now()));
    let handle = now.clone();
    let f = Fixture::with_state(move |s| {
        s.share_guesses = GuessLimiter::new(
            openbase::api::sharing::GUESS_CAP,
            openbase::api::sharing::GUESS_WINDOW,
            openbase::api::sharing::GUESS_LOCKOUT,
        )
        .with_clock(Arc::new(move || *handle.lock().unwrap()));
    })
    .await;
    (f, now)
}

async fn guess(f: &Fixture, token: &str, ip: &str, password: &str) -> Response {
    anon(
        &f.app,
        "GET",
        &format!("/api/public/shares/{token}"),
        None,
        &[("x-share-password", password)],
        ip,
    )
    .await
}

#[tokio::test]
async fn a_link_locks_after_a_hundred_wrong_guesses_from_any_addresses() {
    let (f, now) = fixture_with_clock().await;
    let view = f.share(&f.view_id, "view", Some("the real secret")).await;
    let token = view["token"].as_str().unwrap().to_string();
    // A second protected link must not share the budget.
    let other_view = f.view_of(&f.table_id, "Other", "grid", json!({})).await;
    let other = f.share(&other_view, "view", Some("another secret")).await;
    let other_token = other["token"].as_str().unwrap().to_string();

    // A hundred different addresses, one wrong guess each (so no per-address limit is involved).
    for i in 0..100 {
        let ip = format!("10.1.{}.{}", i / 250, i % 250 + 1);
        let r = guess(&f, &token, &ip, "wrong guess").await;
        assert_eq!(r.status.as_u16(), 401, "guess {i}: {}", r.body);
        assert_eq!(r.body["error"]["code"], "share_password_invalid");
    }
    // The link now refuses guesses, the right one included, from yet another address ...
    let locked = guess(&f, &token, "10.9.9.9", "the real secret").await;
    assert_eq!(locked.status.as_u16(), 429, "{}", locked.body);
    // ... and without asking for a password the prompt is still shown.
    let r = anon(
        &f.app,
        "GET",
        &format!("/api/public/shares/{token}"),
        None,
        &[],
        "10.9.9.9",
    )
    .await;
    assert_eq!(r.body["error"]["code"], "share_password_required");
    // Other links are unaffected.
    guess(&f, &other_token, "10.9.9.9", "another secret")
        .await
        .assert_status(200);

    // Still locked a moment before 15 minutes, open right after.
    *now.lock().unwrap() += Duration::from_secs(15 * 60 - 5);
    assert_eq!(
        guess(&f, &token, "10.9.9.9", "the real secret")
            .await
            .status
            .as_u16(),
        429
    );
    *now.lock().unwrap() += Duration::from_secs(10);
    guess(&f, &token, "10.9.9.9", "the real secret")
        .await
        .assert_status(200);
    // Right guesses after a lockout do not lock the link again (the page sends the password with
    // every request, so the next one follows at once).
    for ip in ["10.9.9.9", "10.9.9.8", "10.9.9.7"] {
        guess(&f, &token, ip, "the real secret")
            .await
            .assert_status(200);
    }
    *now.lock().unwrap() += Duration::from_secs(16 * 60);
    guess(&f, &token, "10.9.9.9", "the real secret")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn the_attachment_route_counts_against_the_same_cap() {
    let (f, _now) = fixture_with_clock().await;
    let view = f.share(&f.view_id, "view", Some("the real secret")).await;
    let token = view["token"].as_str().unwrap().to_string();
    // The attachment id need not exist: the password is checked before the attachment is looked up
    // for exposure, and a wrong password answers 404 like every other denial there.
    let upload = f.upload("a.txt", b"hello").await;
    let aid = upload["id"].as_str().unwrap().to_string();
    for i in 0..100 {
        let ip = format!("10.2.{}.{}", i / 250, i % 250 + 1);
        let r = anon(
            &f.app,
            "GET",
            &format!("/api/attachments/{aid}/a.txt?share={token}"),
            None,
            &[("x-share-password", "wrong guess")],
            &ip,
        )
        .await;
        assert_eq!(r.status.as_u16(), 404, "{i}");
    }
    let r = guess(&f, &token, "10.9.9.9", "the real secret").await;
    assert_eq!(
        r.status.as_u16(),
        429,
        "the public view is locked too: {}",
        r.body
    );
}

// ------------------------------------------------------------------ SEC-4.4 response headers

fn assert_hardening_headers(res: &Response, what: &str) {
    assert_eq!(
        header_of(res, "cross-origin-opener-policy"),
        Some("same-origin"),
        "{what}"
    );
    assert_hardening_headers_except_opener(res, what);
}

fn assert_hardening_headers_except_opener(res: &Response, what: &str) {
    assert_eq!(
        header_of(res, "permissions-policy"),
        Some("camera=(), microphone=(), geolocation=()"),
        "{what}"
    );
    assert_eq!(
        header_of(res, "cross-origin-resource-policy"),
        Some("same-origin"),
        "{what}"
    );
    let csp = header_of(res, "content-security-policy").expect("a CSP");
    assert!(
        csp.contains("style-src 'self' 'unsafe-inline'"),
        "{what}: {csp}"
    );
    assert_eq!(header_of(res, "x-frame-options"), Some("DENY"), "{what}");
}

#[tokio::test]
async fn every_response_carries_the_hardening_headers() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");
    for path in [
        "/api/health",
        "/",
        "/some/client/route",
        "/api/nope",
        "/login/other",
        "/.well-known/oauth-authorization-server",
    ] {
        let r = app.get(&me, path).await;
        assert_hardening_headers(&r, path);
    }
    let r = app.get(&app.anon(), "/api/auth/me").await;
    r.assert_status(401);
    assert_hardening_headers(&r, "an error answer");
}

#[tokio::test]
async fn the_pages_an_oauth_popup_walks_through_keep_the_window_opener_link() {
    // A browser-based MCP client opens /oauth/authorize in a popup and waits for it; the opener
    // policy would cut that link on the first page. Everything else keeps the policy.
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");
    for path in ["/oauth/authorize", "/login", "/login/2fa", "/oauth/consent"] {
        let r = app.get(&me, path).await;
        assert!(
            header_of(&r, "cross-origin-opener-policy").is_none(),
            "{path}"
        );
        assert_hardening_headers_except_opener(&r, path);
    }
}

#[tokio::test]
async fn hsts_is_sent_only_when_the_public_url_is_https() {
    let plain = TestApp::new();
    let r = plain.get(&plain.anon(), "/api/health").await;
    assert!(
        header_of(&r, "strict-transport-security").is_none(),
        "plain http must never pin a browser to https"
    );

    let tls = https_app();
    for path in ["/api/health", "/", "/api/nope"] {
        let r = tls.get(&tls.anon(), path).await;
        let hsts = header_of(&r, "strict-transport-security").expect(path);
        assert_eq!(
            hsts, "max-age=31536000",
            "one year, no preload, no subdomains"
        );
        assert_hardening_headers(&r, path);
    }
}

#[tokio::test]
async fn cors_enabled_machine_endpoints_keep_their_cors_headers_under_the_resource_policy() {
    // `Cross-Origin-Resource-Policy` only governs no-cors embeds; the endpoints that other
    // origins must read answer CORS requests and keep doing so.
    let app = TestApp::new();
    let r = app
        .request_with(
            &app.anon(),
            "GET",
            "/.well-known/oauth-authorization-server",
            None,
            &[("origin", "https://client.example")],
            false,
            None,
        )
        .await;
    r.assert_status(200);
    assert_eq!(header_of(&r, "access-control-allow-origin"), Some("*"));
    assert_eq!(
        header_of(&r, "cross-origin-resource-policy"),
        Some("same-origin")
    );
}

// ------------------------------------------------------------------ SEC-4.5 session cookie

fn host_cookie_token(res: &Response) -> String {
    set_cookies(res)
        .iter()
        .find_map(|c| {
            c.strip_prefix("__Host-ob_session=")
                .map(|rest| rest.split(';').next().unwrap().to_string())
        })
        .expect("a __Host-ob_session cookie")
}

#[tokio::test]
async fn over_https_the_session_cookie_is_host_prefixed_and_only_that_name_signs_in() {
    let app = https_app();
    let (res, _) = app
        .signup("a@example.com", "correct horse battery", None)
        .await;
    res.assert_status(200);
    let cookies = set_cookies(&res);
    assert_eq!(cookies.len(), 1, "{cookies:?}");
    let c = &cookies[0];
    // The requirements of the `__Host-` prefix, plus the flags the cookie always had.
    assert!(c.starts_with("__Host-ob_session="), "{c}");
    assert!(c.contains("; Secure"), "{c}");
    assert!(c.contains("; Path=/"), "{c}");
    assert!(!c.to_ascii_lowercase().contains("domain"), "{c}");
    assert!(c.contains("; HttpOnly"), "{c}");
    assert!(c.contains("SameSite=Lax"), "{c}");

    let token = host_cookie_token(&res);
    with_cookie(
        &app,
        "__Host-ob_session",
        &token,
        "GET",
        "/api/auth/me",
        &[],
    )
    .await
    .assert_status(200);
    // The old name no longer signs anyone in: the rename ends existing sessions once.
    with_cookie(&app, "ob_session", &token, "GET", "/api/auth/me", &[])
        .await
        .assert_status(401);
}

#[tokio::test]
async fn logging_in_and_out_over_https_use_the_host_cookie_and_clear_the_old_name() {
    let app = https_app();
    let (res, _) = app
        .signup("a@example.com", "correct horse battery", None)
        .await;
    res.assert_status(200);
    let login = app
        .post(
            &app.anon(),
            "/api/auth/login",
            json!({ "email": "a@example.com", "password": "correct horse battery" }),
        )
        .await;
    login.assert_status(200);
    let token = host_cookie_token(&login);
    assert!(
        set_cookies(&login)
            .iter()
            .all(|c| !c.starts_with("ob_session=")),
        "{:?}",
        set_cookies(&login)
    );

    let out = with_cookie(
        &app,
        "__Host-ob_session",
        &token,
        "POST",
        "/api/auth/logout",
        &[],
    )
    .await;
    out.assert_status(200);
    let cookies = set_cookies(&out);
    let gone = |prefix: &str| {
        cookies
            .iter()
            .any(|c| c.starts_with(prefix) && c.contains("Max-Age=0"))
    };
    assert!(gone("__Host-ob_session="), "{cookies:?}");
    assert!(
        gone("ob_session="),
        "the pre-rename cookie is cleared too: {cookies:?}"
    );
    with_cookie(
        &app,
        "__Host-ob_session",
        &token,
        "GET",
        "/api/auth/me",
        &[],
    )
    .await
    .assert_status(401);
}

#[tokio::test]
async fn over_plain_http_the_cookie_keeps_its_name_and_is_not_secure() {
    let app = TestApp::new();
    let (res, _) = app
        .signup("a@example.com", "correct horse battery", None)
        .await;
    res.assert_status(200);
    let cookies = set_cookies(&res);
    assert!(cookies[0].starts_with("ob_session="), "{cookies:?}");
    assert!(!cookies[0].contains("Secure"), "{cookies:?}");
    let out = app
        .post(
            &Client {
                cookie: res.session_cookie(),
                ..Client::default()
            },
            "/api/auth/logout",
            json!({}),
        )
        .await;
    assert_eq!(set_cookies(&out).len(), 1, "no legacy clearing over http");
}

fn session_hash(c: &Client) -> String {
    openbase::ids::hash_token(c.cookie.as_deref().unwrap())
}

fn set_session_times(app: &TestApp, c: &Client, created_ago_ms: i64, seen_ago_ms: i64) {
    let now = now_ms();
    let hash = session_hash(c);
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE sessions SET created_at = ?1, expires_at = ?2, last_seen_at = ?3
                 WHERE token_hash = ?4",
                rusqlite::params![
                    now - created_ago_ms,
                    now - created_ago_ms + openbase::auth::session::SESSION_TTL_MS,
                    now - seen_ago_ms,
                    hash
                ],
            )?;
            Ok(())
        })
        .unwrap();
}

fn last_seen(app: &TestApp, c: &Client) -> i64 {
    app.query_i64(
        "SELECT last_seen_at FROM sessions WHERE token_hash = ?1",
        &[&session_hash(c)],
    )
}

const DAY: i64 = 24 * 3600 * 1000;
const MINUTE_MS: i64 = 60 * 1000;

#[tokio::test]
async fn a_session_idle_for_fourteen_days_ends_inside_its_thirty() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");

    set_session_times(&app, &me, 15 * DAY, 15 * DAY);
    app.get(&me, "/api/auth/me").await.assert_status(401);

    set_session_times(&app, &me, 20 * DAY, 14 * DAY + MINUTE_MS);
    app.get(&me, "/api/auth/me").await.assert_status(401);

    // Used 13 days ago: still in. Created 20 days ago, so the idle clock, not the age, matters.
    set_session_times(&app, &me, 20 * DAY, 13 * DAY);
    app.get(&me, "/api/auth/me").await.assert_status(200);
}

#[tokio::test]
async fn activity_keeps_a_session_alive_but_never_past_thirty_days() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");

    // Seen a moment ago, but older than the 30-day maximum.
    set_session_times(&app, &me, 31 * DAY, 1000);
    app.get(&me, "/api/auth/me").await.assert_status(401);

    // The sliding part: a request refreshes the idle clock.
    set_session_times(&app, &me, 20 * DAY, 13 * DAY);
    app.get(&me, "/api/auth/me").await.assert_status(200);
    let seen = last_seen(&app, &me);
    assert!(now_ms() - seen < MINUTE_MS, "last_seen_at was refreshed");
    // A session used every 13 days is therefore good until its 30 days are up.
    set_session_times(&app, &me, 29 * DAY, 13 * DAY);
    app.get(&me, "/api/auth/me").await.assert_status(200);
}

#[tokio::test]
async fn the_idle_clock_is_written_at_most_every_ten_minutes() {
    let app = TestApp::new();
    let me = app.user("a@example.com", "A");

    set_session_times(&app, &me, DAY, 5 * MINUTE_MS);
    let before = last_seen(&app, &me);
    for _ in 0..5 {
        app.get(&me, "/api/auth/me").await.assert_status(200);
    }
    assert_eq!(last_seen(&app, &me), before, "no write within ten minutes");

    set_session_times(&app, &me, DAY, 11 * MINUTE_MS);
    let before = last_seen(&app, &me);
    app.get(&me, "/api/auth/me").await.assert_status(200);
    let after = last_seen(&app, &me);
    assert!(after > before && now_ms() - after < MINUTE_MS);
    // And only once for the next stretch.
    app.get(&me, "/api/auth/me").await.assert_status(200);
    assert_eq!(last_seen(&app, &me), after);
}

#[tokio::test]
async fn idle_sessions_are_purged_with_the_expired_ones() {
    let app = TestApp::new();
    let idle = app.user("idle@example.com", "I");
    let active = app.user("active@example.com", "A");
    set_session_times(&app, &idle, 20 * DAY, 15 * DAY);
    set_session_times(&app, &active, 20 * DAY, 13 * DAY);
    let n = app
        .state
        .db
        .write_sync(|tx| openbase::tasks::purge_sessions(tx))
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(app.query_i64("SELECT count(*) FROM sessions", &[]), 1);
    app.get(&active, "/api/auth/me").await.assert_status(200);
}

// -------------------------------------------------------- SEC-4.6 real client address for MCP

/// The address recorded for the newest `admin_token_use` audit entry.
async fn last_admin_token_ip(r: &Rig) -> String {
    let page = r.app().get(&r.admin, "/api/admin/audit?limit=50").await;
    page.assert_status(200);
    page.body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| {
            e["action"] == "admin_token_use" && e["detail"]["request"] == "GET /api/admin/stats"
        })
        .map(|e| e["ip"].as_str().unwrap_or("none").to_string())
        .expect("an admin_token_use entry")
}

/// `tools/call api_request GET /api/admin/stats` straight into the router, as if it arrived from
/// `peer` (optionally with an `X-Forwarded-For` header on the outer request).
async fn mcp_stats_from(r: &Rig, peer: &str, forwarded: Option<&str>) {
    let peer: SocketAddr = peer.parse().unwrap();
    let mut headers = vec![
        ("accept", "application/json, text/event-stream"),
        ("mcp-protocol-version", "2025-06-18"),
    ];
    if let Some(f) = forwarded {
        headers.push(("x-forwarded-for", f));
    }
    let res = r
        .app()
        .request_with(
            &Client {
                bearer: Some(r.token.clone()),
                ..Client::default()
            },
            "POST",
            "/mcp",
            Some(json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "api_request",
                            "arguments": { "method": "GET", "path": "/api/admin/stats" } }
            })),
            &headers,
            false,
            Some(peer),
        )
        .await;
    res.assert_status(200);
    assert_eq!(
        res.body["result"]["structuredContent"]["status"], 200,
        "{}",
        res.body
    );
}

#[tokio::test]
async fn mcp_requests_are_seen_from_the_real_peer_without_a_proxy() {
    let r = Rig::new().await;
    mcp_stats_from(&r, "203.0.113.9:5555", None).await;
    assert_eq!(last_admin_token_ip(&r).await, "203.0.113.9");

    // A forwarded-for header sent by the caller means nothing when no proxy is trusted.
    mcp_stats_from(&r, "203.0.113.10:5555", Some("198.51.100.77")).await;
    assert_eq!(last_admin_token_ip(&r).await, "203.0.113.10");
}

#[tokio::test]
async fn mcp_requests_over_a_real_connection_record_the_socket_address() {
    // The same path through an actual TCP connection (peer 127.0.0.1), as a deployed server has.
    let r = Rig::new().await;
    r.agent
        .call(
            "api_request",
            json!({ "method": "GET", "path": "/api/admin/stats" }),
        )
        .await;
    assert_eq!(last_admin_token_ip(&r).await, "127.0.0.1");
}

#[tokio::test]
async fn mcp_requests_use_the_proxy_forwarded_address_only_when_a_proxy_is_trusted() {
    let r = Rig::with(|c| c.trust_proxy = true).await;
    mcp_stats_from(&r, "10.0.0.2:5555", Some("198.51.100.77")).await;
    assert_eq!(last_admin_token_ip(&r).await, "198.51.100.77");
    // Trusted but absent: fall back to the peer.
    mcp_stats_from(&r, "203.0.113.9:5555", None).await;
    assert_eq!(last_admin_token_ip(&r).await, "203.0.113.9");
}

#[tokio::test]
async fn mcp_rate_limits_see_the_real_peer_too() {
    // Rate limits keyed by address (here the public share endpoints, reached through
    // `api_request`) must count the caller, not "unknown" for every agent.
    let r = Rig::new().await;
    let limited = |peer: &'static str| {
        let r = &r;
        async move {
            let peer: SocketAddr = peer.parse().unwrap();
            let res = r
                .app()
                .request_with(
                    &Client {
                        bearer: Some(r.token.clone()),
                        ..Client::default()
                    },
                    "POST",
                    "/mcp",
                    Some(json!({
                        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": { "name": "api_request",
                                    "arguments": { "method": "GET", "path": "/api/public/shares/nope" } }
                    })),
                    &[
                        ("accept", "application/json, text/event-stream"),
                        ("mcp-protocol-version", "2025-06-18"),
                    ],
                    false,
                    Some(peer),
                )
                .await;
            res.body["result"]["structuredContent"]["status"]
                .as_u64()
                .unwrap()
        }
    };
    for _ in 0..openbase::api::sharing::IP_LIMIT {
        assert_eq!(limited("203.0.113.50:1").await, 404);
    }
    assert_eq!(
        limited("203.0.113.50:1").await,
        429,
        "the limit counts this address"
    );
    assert_eq!(
        limited("203.0.113.51:1").await,
        404,
        "another caller is not affected"
    );
}
