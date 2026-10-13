//! Malformed JSON bodies and query strings answer with the API's JSON error
//! envelope (`{"error": {"code", "message"}}`, status 400), not axum's
//! plain-text rejections. See `openbase::extract`.

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
        .header(openbase::http::CSRF_HEADER, "1");
    if let Some(c) = &client.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", openbase::auth::SESSION_COOKIE, c),
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

/// Records, schema, views, comments, trash and automations endpoints (the
/// handlers that once had their own extractor) answer malformed bodies with
/// the envelope, and well-formed requests still work.
#[tokio::test]
async fn record_and_schema_endpoints_get_the_envelope_for_malformed_bodies() {
    let app = TestApp::new();
    let user = app.user("user@example.com", "User");
    let json = Some("application/json");

    for (method, path) in [
        // records
        ("POST", "/api/tables/tblX/records"),
        ("PATCH", "/api/tables/tblX/records"),
        ("DELETE", "/api/tables/tblX/records"),
        ("POST", "/api/tables/tblX/records/restore"),
        ("POST", "/api/tables/tblX/records/move"),
        ("POST", "/api/views/viwX/query"),
        // schema
        ("POST", "/api/workspaces"),
        ("PATCH", "/api/workspaces/wspX"),
        ("POST", "/api/workspaces/wspX/bases"),
        ("PATCH", "/api/bases/appX"),
        ("POST", "/api/bases/appX/tables"),
        ("PATCH", "/api/tables/tblX"),
        ("POST", "/api/tables/tblX/fields"),
        ("PATCH", "/api/fields/fldX"),
        ("POST", "/api/tables/tblX/views"),
        ("PATCH", "/api/views/viwX"),
        ("POST", "/api/trash/restore"),
        // comments and automations
        ("POST", "/api/records/recX/comments"),
        ("POST", "/api/bases/appX/automations"),
        ("PATCH", "/api/automations/autX"),
    ] {
        for body in ["{", "[1,2"] {
            let res = raw(&app, &user, method, path, json, body).await;
            assert_envelope(&res, "invalid JSON request body");
        }
        // Valid JSON of the wrong shape: still the envelope (the message
        // comes from the type or from the handler's own validation).
        let res = raw(&app, &user, method, path, json, "\"text\"").await;
        assert_envelope(&res, "");
        let res = raw(&app, &user, method, path, None, "{}").await;
        assert_envelope(&res, "Content-Type");
    }

    // The right shape reaches the handler: the table does not exist (404),
    // which is a different error than a rejected body.
    let res = raw(
        &app,
        &user,
        "POST",
        "/api/tables/tblX/records",
        json,
        r#"{"records":[{"values":{}}]}"#,
    )
    .await;
    assert_eq!(res.status, StatusCode::NOT_FOUND, "{}", res.body);
    // Wrong shape of a typed body names the field.
    let res = raw(
        &app,
        &user,
        "POST",
        "/api/tables/tblX/records",
        json,
        r#"{"rows":[]}"#,
    )
    .await;
    assert_envelope(&res, "missing field `records`");
    // A wrong type inside the body.
    let res = raw(
        &app,
        &user,
        "POST",
        "/api/views/viwX/query",
        json,
        r#"{"offset":"zero"}"#,
    )
    .await;
    assert_envelope(&res, "invalid type");
}

/// Query strings of the data endpoints get the envelope too.
#[tokio::test]
async fn data_endpoints_get_the_envelope_for_bad_query_strings() {
    let app = TestApp::new();
    let user = app.user("user@example.com", "User");
    for path in [
        "/api/views/viwX/aggregations?timezone=a&timezone=b",
        "/api/tables/tblX/records/lookup?limit=abc",
        "/api/records/recX/history?before=abc",
        "/api/records/recX/history?limit=-1",
        "/api/automations/autX/runs?limit=abc",
    ] {
        let res = app.get(&user, path).await;
        assert_envelope(&res, "invalid query string");
    }
}

/// Static guard: no handler may take `axum::Json` / `axum::extract::Query` as
/// a request extractor (they reject with plain text). `Json` as a response is
/// fine.
#[test]
fn no_handler_uses_axum_json_or_query_as_a_request_extractor() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();
    let mut stack = vec![dir];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs")
                || path.file_name().and_then(|n| n.to_str()) == Some("extract.rs")
            {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            for (n, line) in text.lines().enumerate() {
                let t = line.trim_start();
                let request_json = t.starts_with("Json(") && t.contains("): Json<");
                let request_query = t.starts_with("Query(") && t.contains("): Query<");
                let imports_query = t.starts_with("use axum::extract::")
                    && t.split(|c: char| !c.is_alphanumeric() && c != '_')
                        .any(|w| w == "Query");
                if request_json || request_query || imports_query {
                    offenders.push(format!("{}:{}: {t}", path.display(), n + 1));
                }
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "use crate::extract::{{ApiJson, ApiQuery}}:\n{}",
        offenders.join("\n")
    );
}
