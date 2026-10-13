//! OAuth discovery: protected resource metadata (RFC 9728), authorization server metadata
//! (RFC 8414), when OAuth is advertised at all, CORS for browser-based clients, and the
//! `WWW-Authenticate` challenge of the MCP endpoint.

mod common;
mod mcp_support;
mod oauth_support;

use common::TestApp;
use mcp_support::legacy;
use oauth_support::*;
use serde_json::json;

fn app_at(public_url: &str) -> TestApp {
    let url = public_url.to_string();
    TestApp::with_config(move |c| c.public_url = url)
}

#[tokio::test]
async fn protected_resource_metadata_names_this_instance() {
    let app = app_at("https://base.example.com");
    for path in ["/.well-known/oauth-protected-resource/mcp"] {
        let res = get(&app, path).await;
        res.assert_status(200);
        assert_eq!(
            res.body["resource"], "https://base.example.com/mcp",
            "{path}"
        );
        assert_eq!(
            res.body["authorization_servers"],
            json!(["https://base.example.com"]),
            "{path}"
        );
        assert_eq!(res.body["bearer_methods_supported"], json!(["header"]));
        assert_eq!(
            res.body["scopes_supported"],
            json!(["openbase:read", "openbase:write", "openbase:manage"])
        );
        assert!(
            res.headers["content-type"]
                .to_str()
                .unwrap()
                .starts_with("application/json")
        );
    }
}

/// RFC 9728 section 3.3: the `resource` of a document is the URL it was read from minus the
/// well-known part. The root document would have to name the origin, which is not the protected
/// resource (that is `/mcp`), so it is not served at all.
#[tokio::test]
async fn the_root_protected_resource_document_is_not_served() {
    let app = app_at("https://base.example.com");
    let res = get(&app, "/.well-known/oauth-protected-resource").await;
    res.assert_status(404);
    assert!(res.body.get("resource").is_none(), "{}", res.body);
    assert_eq!(res.body["error"], "not_found");
    // The document the challenge points to is served and matches its own location.
    let doc = get(&app, "/.well-known/oauth-protected-resource/mcp").await;
    doc.assert_status(200);
    assert_eq!(doc.body["resource"], "https://base.example.com/mcp");
}

#[tokio::test]
async fn authorization_server_metadata_describes_every_endpoint() {
    let app = app_at("https://base.example.com");
    let res = get(&app, "/.well-known/oauth-authorization-server").await;
    res.assert_status(200);
    let m = &res.body;
    assert_eq!(m["issuer"], "https://base.example.com");
    assert_eq!(
        m["authorization_endpoint"],
        "https://base.example.com/oauth/authorize"
    );
    assert_eq!(m["token_endpoint"], "https://base.example.com/oauth/token");
    assert_eq!(
        m["registration_endpoint"],
        "https://base.example.com/oauth/register"
    );
    assert_eq!(
        m["revocation_endpoint"],
        "https://base.example.com/oauth/revoke"
    );
    assert_eq!(m["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(m["response_types_supported"], json!(["code"]));
    assert_eq!(
        m["grant_types_supported"],
        json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(
        m["token_endpoint_auth_methods_supported"],
        json!(["none", "client_secret_post"])
    );
    assert_eq!(m["client_id_metadata_document_supported"], true);
    assert_eq!(m["authorization_response_iss_parameter_supported"], true);
    assert_eq!(
        m["scopes_supported"],
        json!(["openbase:read", "openbase:write", "openbase:manage"])
    );
    // The issuer has no path and no trailing slash: it is the instance's origin.
    let app = app_at("https://base.example.com/");
    let res = get(&app, "/.well-known/oauth-authorization-server").await;
    assert_eq!(res.body["issuer"], "https://base.example.com");
}

#[tokio::test]
async fn registration_can_be_switched_off() {
    let app = TestApp::with_config(|c| c.oauth_registration = false);
    let res = get(&app, "/.well-known/oauth-authorization-server").await;
    res.assert_status(200);
    assert!(res.body.get("registration_endpoint").is_none());
    assert_eq!(res.body["client_id_metadata_document_supported"], true);
    let res = register(&app, json!({"redirect_uris": ["https://a.example/cb"]})).await;
    res.assert_status(404);
    assert_eq!(res.body["error"], "oauth_disabled");
}

#[tokio::test]
async fn oauth_is_advertised_over_https_and_loopback_only() {
    for (url, on) in [
        ("https://base.example.com", true),
        ("http://localhost:8080", true),
        ("http://127.0.0.1:9000", true),
        ("http://[::1]:9000", true),
        ("http://base.example.com", false),
        ("http://192.168.1.5:8080", false),
        ("http://localhost.evil.example", false),
        ("http://10.0.0.1", false),
    ] {
        let app = app_at(url);
        assert_eq!(app.state.config.oauth_enabled(), on, "{url}");
        for path in [
            "/.well-known/oauth-authorization-server",
            "/.well-known/oauth-protected-resource/mcp",
        ] {
            let res = get(&app, path).await;
            assert_eq!(
                res.status.as_u16(),
                if on { 200 } else { 404 },
                "{url} {path}"
            );
        }
        // Registration, authorization and tokens are refused too.
        let res = register(&app, json!({"redirect_uris": ["https://a.example/cb"]})).await;
        assert_eq!(
            res.status.as_u16(),
            if on { 201 } else { 404 },
            "{url} register"
        );
        let res = form(&app, "/oauth/token", &[("grant_type", "refresh_token")]).await;
        assert_eq!(res.status.as_u16() == 404, !on, "{url} token");
        let res = authorize(&app, &[("client_id", "x")]).await;
        assert_eq!(res.status.as_u16() == 404, !on, "{url} authorize");
    }
}

#[tokio::test]
async fn metadata_is_readable_from_a_browser_on_any_origin() {
    let app = TestApp::new();
    for path in [
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource/mcp",
    ] {
        let res = get(&app, path).await;
        assert_eq!(res.headers["access-control-allow-origin"], "*", "{path}");
    }
    // Preflight for the endpoints a browser-based client calls with fetch().
    for path in ["/oauth/token", "/oauth/register", "/oauth/revoke"] {
        let res = raw_body(
            &app,
            "OPTIONS",
            path,
            "text/plain",
            Vec::new(),
            &[
                ("origin", "https://inspector.example"),
                ("access-control-request-method", "POST"),
                ("access-control-request-headers", "content-type"),
            ],
        )
        .await;
        assert_eq!(res.status.as_u16(), 204, "{path}");
        assert_eq!(res.headers["access-control-allow-origin"], "*");
        assert!(
            res.headers["access-control-allow-methods"]
                .to_str()
                .unwrap()
                .contains("POST")
        );
        assert!(
            res.headers["access-control-allow-headers"]
                .to_str()
                .unwrap()
                .contains("content-type")
        );
        // No cookies are involved, so credentials are never allowed.
        assert!(!res.headers.contains_key("access-control-allow-credentials"));
    }
    // The consent API and the authorization endpoint are not cross-origin APIs.
    let res = get(&app, "/oauth/authorize").await;
    assert!(!res.headers.contains_key("access-control-allow-origin"));
}

#[tokio::test]
async fn mcp_401_points_at_the_resource_metadata() {
    let app = TestApp::new();
    let challenge = "Bearer realm=\"OpenBase MCP\", scope=\"openbase:read openbase:write\", resource_metadata=\"http://localhost:8080/.well-known/oauth-protected-resource/mcp\"";
    let res = legacy(&app, &app.anon(), "tools/list", json!({})).await;
    res.assert_status(401);
    assert_eq!(res.headers["www-authenticate"], challenge);

    // An invalid or expired token adds the error (RFC 6750 3.1), for both token kinds.
    for bad in ["pat_does_not_exist", "oat_does_not_exist", "garbage"] {
        let res = legacy(&app, &TestApp::bearer(bad), "tools/list", json!({})).await;
        res.assert_status(401);
        let h = res.headers["www-authenticate"].to_str().unwrap();
        assert!(
            h.starts_with("Bearer realm=\"OpenBase MCP\", error=\"invalid_token\""),
            "{h}"
        );
        assert!(
            h.ends_with("resource_metadata=\"http://localhost:8080/.well-known/oauth-protected-resource/mcp\""),
            "{h}"
        );
    }
    // The URL in the challenge is served, and is the one the protected resource document is at.
    let res = get(&app, "/.well-known/oauth-protected-resource/mcp").await;
    assert_eq!(res.body["resource"], "http://localhost:8080/mcp");
}

#[tokio::test]
async fn mcp_does_not_mention_oauth_when_it_is_not_available() {
    let app = app_at("http://base.example.com");
    let res = legacy(&app, &app.anon(), "tools/list", json!({})).await;
    res.assert_status(401);
    assert_eq!(
        res.headers["www-authenticate"],
        "Bearer realm=\"OpenBase MCP\""
    );
}

#[tokio::test]
async fn personal_access_tokens_work_exactly_as_before() {
    let app = TestApp::new();
    let user = app.admin("a@example.com", "A");
    let token = app
        .api_token(&user, json!({"name": "t", "write": true, "manage": true}))
        .await;
    let res = legacy(&app, &token, "tools/list", json!({})).await;
    res.assert_status(200);
    assert!(res.body["result"]["tools"].as_array().unwrap().len() > 50);
    // Not a PAT, not an OAuth token: unknown.
    let res = legacy(&app, &TestApp::bearer("pat0000"), "tools/list", json!({})).await;
    res.assert_status(401);
}
