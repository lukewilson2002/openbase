mod common;

use axum::body::Body;
use axum::http::{Request, header};
use common::TestApp;

#[tokio::test]
async fn health_reports_ok() {
    let app = TestApp::new();
    let res = app.get(&app.anon(), "/api/health").await;
    res.assert_status(200);
    assert_eq!(res.body["status"], "ok");
}

#[tokio::test]
async fn security_headers_present() {
    let app = TestApp::new();
    let res = app.get(&app.anon(), "/api/health").await;
    assert!(res.headers.get("content-security-policy").is_some());
    assert_eq!(
        res.headers.get("x-content-type-options").unwrap(),
        "nosniff"
    );
    assert_eq!(res.headers.get("x-frame-options").unwrap(), "DENY");
}

#[tokio::test]
async fn unknown_api_path_is_json_404() {
    let app = TestApp::new();
    let res = app.get(&app.anon(), "/api/does-not-exist").await;
    res.assert_status(404);
    assert_eq!(res.body["error"]["code"], "not_found");
}

#[tokio::test]
async fn cookie_post_without_csrf_header_is_rejected() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let req = Request::builder()
        .method("POST")
        .uri("/api/health")
        .header(
            header::COOKIE,
            format!("og_session={}", user.cookie.unwrap()),
        )
        .body(Body::empty())
        .unwrap();
    let res = app.send(req).await;
    res.assert_status(403);
}
