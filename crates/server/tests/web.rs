//! The embedded web client through the real router. These must pass whether or not
//! `web/dist` has been built, so they assert the behaviour that holds either way.

mod common;

use axum::body::Body;
use axum::http::{Request, header};
use common::TestApp;

/// True when the response is the SPA shell (HTML), false when `web/dist` is not built.
fn is_html(res: &common::Response) -> bool {
    res.headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/html"))
}

#[tokio::test]
async fn unknown_api_paths_are_json_404s_never_the_app() {
    let app = TestApp::new();
    let anon = app.anon();
    for path in ["/api/x", "/api/", "/api", "/api/bases/app1/events-nope"] {
        let res = app.get(&anon, path).await;
        res.assert_status(404);
        assert_eq!(res.body["error"]["code"], "not_found", "{path}");
        assert!(!is_html(&res), "{path} returned HTML");
    }
}

#[tokio::test]
async fn unknown_api_post_is_json_404_even_with_csrf_header() {
    let app = TestApp::new();
    let res = app
        .post(&app.anon(), "/api/does-not-exist", serde_json::json!({}))
        .await;
    res.assert_status(404);
    assert_eq!(res.body["error"]["code"], "not_found");
}

#[tokio::test]
async fn spa_routes_serve_the_shell_or_a_build_hint_but_never_json_or_5xx() {
    let app = TestApp::new();
    let anon = app.anon();
    for path in [
        "/",
        "/login",
        "/base/app1/tbl1/viw1",
        "/invite/sometoken",
        "/admin",
    ] {
        let res = app.get(&anon, path).await;
        if is_html(&res) {
            res.assert_status(200);
            assert_eq!(
                res.headers.get(header::CACHE_CONTROL).unwrap(),
                "no-cache",
                "{path}"
            );
            let html = String::from_utf8_lossy(&res.bytes);
            assert!(html.contains("<div id=\"root\">"), "{path}");
            // The shell must not need inline scripts (CSP script-src 'self').
            assert!(
                !html.contains("<script>"),
                "inline script in index.html would be blocked by the CSP"
            );
        } else {
            // dist absent: a plain-text hint, not an error page and not the API's JSON.
            res.assert_status(404);
            assert!(String::from_utf8_lossy(&res.bytes).contains("not built"));
        }
    }
}

#[tokio::test]
async fn missing_static_files_are_404_not_the_shell() {
    let app = TestApp::new();
    let anon = app.anon();
    for path in ["/assets/index-nonexistent.js", "/robots.txt", "/nope.map"] {
        let res = app.get(&anon, path).await;
        res.assert_status(404);
        assert!(!is_html(&res), "{path} must not fall back to index.html");
    }
}

/// With a built client, the brand files the page and the web app manifest link to are all served
/// with their own content types (never the HTML shell). Without a build there is nothing to serve.
#[tokio::test]
async fn brand_files_are_served_with_their_own_types() {
    let app = TestApp::new();
    let anon = app.anon();
    if !is_html(&app.get(&anon, "/").await) {
        return;
    }
    for (path, types) in [
        ("/favicon.svg", &["image/svg+xml"][..]),
        (
            "/favicon.ico",
            &["image/x-icon", "image/vnd.microsoft.icon"][..],
        ),
        ("/apple-touch-icon.png", &["image/png"][..]),
        ("/icon-192.png", &["image/png"][..]),
        ("/icon-512.png", &["image/png"][..]),
        ("/icon-maskable-512.png", &["image/png"][..]),
        ("/manifest.webmanifest", &["application/manifest+json"][..]),
    ] {
        let res = app.get(&anon, path).await;
        res.assert_status(200);
        let ct = res
            .headers
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(types.contains(&ct), "{path}: {ct}");
        assert!(res.headers.get(header::ETAG).is_some(), "{path}");
        assert!(!res.bytes.is_empty(), "{path}");
    }
    // The manifest is the one a browser would install from.
    let manifest = app.get(&anon, "/manifest.webmanifest").await;
    let m: serde_json::Value = serde_json::from_slice(&manifest.bytes).unwrap();
    assert_eq!(m["name"], "OpenBase");
    assert_eq!(m["theme_color"], "#1F5AE0");
    let icons = m["icons"].as_array().unwrap();
    assert!(icons.iter().any(|i| i["sizes"] == "192x192"));
    assert!(
        icons
            .iter()
            .any(|i| i["sizes"] == "512x512" && i["purpose"] == "any")
    );
    assert!(icons.iter().any(|i| i["purpose"] == "maskable"));
}

#[tokio::test]
async fn csp_allows_only_same_origin_scripts() {
    let app = TestApp::new();
    for path in ["/", "/login", "/api/health"] {
        let res = app.get(&app.anon(), path).await;
        let csp = res
            .headers
            .get("content-security-policy")
            .unwrap_or_else(|| panic!("no CSP on {path}"))
            .to_str()
            .unwrap()
            .to_string();
        assert!(csp.contains("script-src 'self';"), "{csp}");
        assert!(!csp.contains("wasm-unsafe-eval"), "{csp}");
        assert!(!csp.contains("unsafe-eval"), "{csp}");
        assert!(csp.contains("img-src 'self' data: blob:"), "{csp}");
        assert!(csp.contains("connect-src 'self'"), "{csp}");
    }
}

#[tokio::test]
async fn non_get_requests_to_app_routes_are_not_allowed() {
    let app = TestApp::new();
    let req = Request::builder()
        .method("POST")
        .uri("/login")
        .body(Body::empty())
        .unwrap();
    let res = app.send(req).await;
    res.assert_status(405);
}
