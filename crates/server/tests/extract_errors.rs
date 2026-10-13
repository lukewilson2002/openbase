//! Malformed JSON bodies and query strings answer with the API's JSON error
//! envelope (`{"error": {"code", "message"}}`, status 400), not axum's
//! plain-text rejections. See `opengrid::extract`.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::{Client, Response, TestApp};

async fn raw(
    app: &TestApp,
    client: &Client,
    method: &str,
    path: &str,
    content_type: Option<&str>,
    body: &str,
) -> Response {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(opengrid::http::CSRF_HEADER, "1");
    if let Some(c) = &client.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", opengrid::auth::SESSION_COOKIE, c),
        );
    }
    if let Some(ct) = content_type {
        req = req.header(header::CONTENT_TYPE, ct);
    }
    app.send(req.body(Body::from(body.to_string())).unwrap())
        .await
}

#[track_caller]
fn assert_envelope(res: &Response, message_contains: &str) {
    assert_eq!(res.status, StatusCode::BAD_REQUEST, "body: {}", res.body);
    let content_type = res
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    assert!(
        content_type.starts_with("application/json"),
        "content-type {content_type:?}"
    );
    assert_eq!(res.body["error"]["code"], "bad_request");
    let message = res.body["error"]["message"].as_str().expect("message");
    assert!(
        message.contains(message_contains),
        "message {message:?} lacks {message_contains:?}"
    );
}

#[tokio::test]
async fn malformed_json_bodies_get_the_envelope() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let anon = app.anon();
    let json = Some("application/json");

    // Public endpoint: syntax error, wrong shape, wrong type, empty body.
    let res = raw(&app, &anon, "POST", "/api/auth/login", json, "{").await;
    assert_envelope(&res, "invalid JSON request body");
    let res = raw(
        &app,
        &anon,
        "POST",
        "/api/auth/login",
        json,
        r#"{"email":"a@b.c"}"#,
    )
    .await;
    assert_envelope(&res, "missing field `password`");
    let res = raw(
        &app,
        &anon,
        "POST",
        "/api/auth/login",
        json,
        r#"{"email":5,"password":"x"}"#,
    )
    .await;
    assert_envelope(&res, "invalid type");
    let res = raw(&app, &anon, "POST", "/api/auth/login", json, "").await;
    assert_envelope(&res, "invalid JSON request body");
    let res = raw(
        &app,
        &anon,
        "POST",
        "/api/auth/login",
        None,
        r#"{"email":"a","password":"b"}"#,
    )
    .await;
    assert_envelope(&res, "Content-Type");

    // Authenticated handlers in each API area.
    for (method, path) in [
        ("POST", "/api/tokens"),
        ("POST", "/api/admin/users"),
        ("PATCH", "/api/admin/users/usrDoesNotMatter"),
        ("PATCH", "/api/auth/me"),
        ("POST", "/api/auth/password"),
        ("POST", "/api/auth/2fa/enable"),
        ("POST", "/api/workspaces/wspX/invites"),
    ] {
        let res = raw(&app, &admin, method, path, json, "[1,2").await;
        assert_envelope(&res, "invalid JSON request body");
    }
}

#[tokio::test]
async fn bad_query_strings_get_the_envelope() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");

    for query in ["limit=abc", "before=1.5", "limit=-3", "before=x&limit=1"] {
        let res = app.get(&admin, &format!("/api/admin/audit?{query}")).await;
        assert_envelope(&res, "invalid query string");
    }
    // A good query on the same route still works.
    app.get(&admin, "/api/admin/audit?limit=5")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn oversized_json_keeps_its_own_status_in_the_envelope() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let big = format!(r#"{{"name":"{}"}}"#, "a".repeat(5 * 1024 * 1024));
    let res = raw(
        &app,
        &admin,
        "POST",
        "/api/tokens",
        Some("application/json"),
        &big,
    )
    .await;
    assert_eq!(res.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(res.body["error"]["code"], "payload_too_large");
}

#[tokio::test]
async fn wrong_method_on_a_known_route_gets_the_envelope() {
    let app = TestApp::new();
    let anon = app.anon();
    let res = app.post(&anon, "/api/setup", serde_json::json!({})).await;
    assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(res.body["error"]["code"], "method_not_allowed");
    let res = app.delete(&anon, "/api/auth/login").await;
    assert_eq!(res.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(res.body["error"]["code"], "method_not_allowed");
}
