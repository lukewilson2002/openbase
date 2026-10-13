//! Client registration: dynamic registration (RFC 7591), client ID metadata documents fetched
//! from an HTTPS URL, clients added on the command line, and forgetting unused clients.

mod common;
mod mcp_support;
mod oauth_support;

use common::TestApp;
use oauth_support::*;
use serde_json::{Value, json};

const GOOD: &str = "https://app.example.com/oauth/callback";

fn count(app: &TestApp, sql: &str) -> i64 {
    app.query_i64(sql, &[])
}

// ------------------------------------------------------------------------------------- DCR

#[tokio::test]
async fn registration_returns_a_public_client() {
    let app = TestApp::new();
    let res = register(
        &app,
        json!({
            "client_name": "  Fancy\u{7} App ",
            "redirect_uris": [GOOD, LOOPBACK_REDIRECT, GOOD],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "logo_uri": "https://app.example.com/logo.png",
            "client_uri": "https://app.example.com",
            "software_id": "ignored",
        }),
    )
    .await;
    res.assert_status(201);
    let b = &res.body;
    assert!(b["client_id"].as_str().unwrap().starts_with("ocl"));
    assert_eq!(b["client_name"], "Fancy App");
    assert_eq!(b["redirect_uris"], json!([GOOD, LOOPBACK_REDIRECT]));
    assert_eq!(b["token_endpoint_auth_method"], "none");
    assert_eq!(b["response_types"], json!(["code"]));
    assert!(b.get("client_secret").is_none());
    assert!(b["client_id_issued_at"].as_i64().unwrap() > 1_700_000_000);
    assert_eq!(res.headers["cache-control"], "no-store");
    let row: (String, Option<String>) = app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT source, logo_uri FROM oauth_clients WHERE id = ?1",
                [b["client_id"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(row.0, "dcr");
    assert_eq!(row.1.as_deref(), Some("https://app.example.com/logo.png"));
}

#[tokio::test]
async fn registration_without_a_name_gets_a_placeholder() {
    let app = TestApp::new();
    let res = register(&app, json!({"redirect_uris": [GOOD]})).await;
    res.assert_status(201);
    assert_eq!(res.body["client_name"], "Unnamed app");
}

#[tokio::test]
async fn registration_refuses_unsafe_redirect_uris() {
    let app = TestApp::new();
    let long = format!("https://app.example.com/{}", "a".repeat(2100));
    let eleven: Vec<String> = (0..11)
        .map(|i| format!("https://app.example.com/{i}"))
        .collect();
    for bad in [
        json!(["javascript:alert(1)"]),
        json!(["data:text/html;base64,PHNjcmlwdD4="]),
        json!(["file:///etc/passwd"]),
        json!(["vscode://callback"]),
        json!(["http://app.example.com/cb"]),
        json!(["http://10.0.0.5/cb"]),
        json!(["http://127.0.0.2/cb"]),
        json!(["http://localhost.attacker.example/cb"]),
        json!(["https://app.example.com/cb#fragment"]),
        json!(["https://user:secret@app.example.com/cb"]),
        json!(["https://*.example.com/cb"]),
        json!(["https://app.example.com/*"]),
        json!(["https://app.example.com/a b"]),
        json!(["/relative"]),
        json!([""]),
        json!([long]),
        json!(eleven),
        json!([]),
        json!([GOOD, 5]),
        json!(GOOD),
        json!(null),
    ] {
        let res = register(&app, json!({"client_name": "x", "redirect_uris": bad})).await;
        res.assert_status(400);
        assert_eq!(res.body["error"], "invalid_redirect_uri", "{bad}");
        assert!(res.body["error_description"].as_str().unwrap().len() > 5);
    }
    // A missing list is the same error.
    let res = register(&app, json!({"client_name": "x"})).await;
    res.assert_status(400);
    assert_eq!(res.body["error"], "invalid_redirect_uri");
    assert_eq!(count(&app, "SELECT count(*) FROM oauth_clients"), 0);
}

#[tokio::test]
async fn registration_refuses_unsupported_or_oversized_metadata() {
    let app = TestApp::new();
    for (label, extra) in [
        ("implicit grant", json!({"grant_types": ["implicit"]})),
        (
            "password grant",
            json!({"grant_types": ["authorization_code", "password"]}),
        ),
        ("no code grant", json!({"grant_types": ["refresh_token"]})),
        ("token response", json!({"response_types": ["token"]})),
        (
            "jwt auth",
            json!({"token_endpoint_auth_method": "private_key_jwt"}),
        ),
        (
            "basic auth",
            json!({"token_endpoint_auth_method": "client_secret_basic"}),
        ),
        ("long name", json!({"client_name": "n".repeat(101)})),
        ("name type", json!({"client_name": 5})),
        (
            "http logo",
            json!({"logo_uri": "http://app.example.com/l.png"}),
        ),
        ("js logo", json!({"logo_uri": "javascript:alert(1)"})),
        ("scope type", json!({"scope": ["a"]})),
    ] {
        let mut doc = json!({"client_name": "x", "redirect_uris": [GOOD]});
        for (k, v) in extra.as_object().unwrap() {
            doc[k] = v.clone();
        }
        let res = register(&app, doc).await;
        res.assert_status(400);
        assert_eq!(
            res.body["error"], "invalid_client_metadata",
            "{label}: {}",
            res.body
        );
    }
    // Not JSON, wrong content type, not an object, too large.
    let post = |ct: &'static str, body: Vec<u8>| {
        let app = &app;
        async move { raw_body(app, "POST", "/oauth/register", ct, body, &[]).await }
    };
    let res = post("application/json", b"{nope".to_vec()).await;
    res.assert_status(400);
    assert_eq!(res.body["error"], "invalid_client_metadata");
    let res = post("application/json", b"[1,2]".to_vec()).await;
    res.assert_status(400);
    let res = post(
        "text/plain",
        serde_json::to_vec(&json!({"redirect_uris": [GOOD]})).unwrap(),
    )
    .await;
    res.assert_status(400);
    let big = serde_json::to_vec(&json!({"redirect_uris": [GOOD], "padding": "p".repeat(20_000)}))
        .unwrap();
    let res = post("application/json", big).await;
    res.assert_status(400);
    assert_eq!(count(&app, "SELECT count(*) FROM oauth_clients"), 0);
}

#[tokio::test]
async fn loopback_redirects_are_accepted_for_native_apps() {
    let app = TestApp::new();
    for uri in [
        "http://127.0.0.1:53124/callback",
        "http://127.0.0.1/cb",
        "http://[::1]:8080/cb",
        "http://localhost:3118/callback",
    ] {
        register(&app, json!({"client_name": uri, "redirect_uris": [uri]}))
            .await
            .assert_status(201);
    }
}

#[tokio::test]
async fn identical_registrations_share_one_client() {
    let app = TestApp::new();
    let a = register_client(&app, "Same App", &[GOOD, LOOPBACK_REDIRECT]).await;
    let b = register_client(&app, "Same App", &[LOOPBACK_REDIRECT, GOOD]).await;
    assert_eq!(a, b);
    let c = register_client(&app, "Other App", &[GOOD, LOOPBACK_REDIRECT]).await;
    assert_ne!(a, c);
    let d = register_client(&app, "Same App", &[GOOD]).await;
    assert_ne!(a, d);
    assert_eq!(count(&app, "SELECT count(*) FROM oauth_clients"), 3);
}

#[tokio::test]
async fn confidential_registrations_get_a_secret_that_is_stored_hashed() {
    let app = TestApp::new();
    let res = register(
        &app,
        json!({"client_name": "Server App", "redirect_uris": [GOOD], "token_endpoint_auth_method": "client_secret_post"}),
    )
    .await;
    res.assert_status(201);
    let secret = res.body["client_secret"].as_str().unwrap().to_string();
    assert_eq!(res.body["client_secret_expires_at"], 0);
    assert_eq!(res.body["token_endpoint_auth_method"], "client_secret_post");
    let stored: String = app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row("SELECT secret_hash FROM oauth_clients", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(stored, openbase::ids::hash_token(&secret));
    assert_ne!(stored, secret);
    // Confidential registrations are never merged with each other.
    let again = register(
        &app,
        json!({"client_name": "Server App", "redirect_uris": [GOOD], "token_endpoint_auth_method": "client_secret_post"}),
    )
    .await;
    assert_ne!(again.body["client_id"], res.body["client_id"]);
    assert_ne!(again.body["client_secret"], res.body["client_secret"]);
}

#[tokio::test]
async fn registration_is_rate_limited_per_address() {
    let app = TestApp::new();
    for i in 0..30 {
        register(
            &app,
            json!({"client_name": format!("App {i}"), "redirect_uris": [GOOD]}),
        )
        .await
        .assert_status(201);
    }
    let res = register(
        &app,
        json!({"client_name": "One too many", "redirect_uris": [GOOD]}),
    )
    .await;
    res.assert_status(429);
    assert_eq!(res.body["error"], "temporarily_unavailable");
    assert_eq!(count(&app, "SELECT count(*) FROM oauth_clients"), 30);
}

#[tokio::test]
async fn the_number_of_registered_clients_is_capped() {
    let app = TestApp::new();
    app.state
        .db
        .write_sync(|tx| {
            for i in 0..openbase::store::oauth::MAX_DCR_CLIENTS {
                tx.execute(
                    "INSERT INTO oauth_clients (id, source, name, redirect_uris, created_at)
                     VALUES (?1, 'dcr', 'bulk', '[]', ?2)",
                    rusqlite::params![format!("bulk{i}"), openbase::db::now_ms()],
                )?;
            }
            Ok(())
        })
        .unwrap();
    let res = register(
        &app,
        json!({"client_name": "late", "redirect_uris": [GOOD]}),
    )
    .await;
    res.assert_status(429);
}

#[tokio::test]
async fn clients_nobody_used_are_forgotten_after_a_week() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let idle = register_client(&app, "Idle", &[GOOD]).await;
    let connected = connect(&app, &user, "Connected", "read", None).await;
    let tried = register_client(&app, "Tried once", &[GOOD]).await;
    // "Tried once" started an authorization request, so it counts as used at that time.
    authorize_with(&app, &tried, GOOD, &pkce().1, &[])
        .await
        .assert_status(302);
    let hand = openbase::cli::add_oauth_client(&app.state, "By hand", &[GOOD.to_string()], false)
        .unwrap()
        .0;

    let week = 7 * 24 * 3600 * 1000;
    let long_ago = openbase::db::now_ms() - week - 60_000;
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_clients SET created_at = ?1, last_used_at = NULL",
                [long_ago],
            )?;
            tx.execute(
                "UPDATE oauth_clients SET last_used_at = ?1 WHERE id = ?2",
                rusqlite::params![openbase::db::now_ms(), tried],
            )?;
            Ok(())
        })
        .unwrap();
    openbase::tasks::tick(&app.state, &mut openbase::tasks::Clock::default()).await;
    let ids: Vec<String> = app
        .state
        .db
        .write_sync(|tx| {
            let mut stmt = tx.prepare("SELECT id FROM oauth_clients ORDER BY id")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.map(|r| r.unwrap()).collect())
        })
        .unwrap();
    assert!(!ids.contains(&idle), "an unused client is forgotten");
    assert!(
        ids.contains(&connected.client_id),
        "a client with a connection stays"
    );
    assert!(ids.contains(&tried), "a client used recently stays");
    assert!(ids.contains(&hand), "clients added by hand stay");
    // The forgotten client can no longer start a flow.
    authorize_with(&app, &idle, GOOD, &pkce().1, &[])
        .await
        .assert_status(400);
}

// ------------------------------------------------------------------------ command line

#[tokio::test]
async fn clients_can_be_added_by_hand() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let (public_id, no_secret) = openbase::cli::add_oauth_client(
        &app.state,
        "Claude",
        &["https://claude.ai/api/mcp/auth_callback".into()],
        false,
    )
    .unwrap();
    assert!(no_secret.is_none());
    let (conf_id, secret) = openbase::cli::add_oauth_client(
        &app.state,
        "Backend",
        &[GOOD.into(), "http://127.0.0.1:9/cb".into()],
        true,
    )
    .unwrap();
    let secret = secret.unwrap();
    // Bad input is refused like it is for registration.
    for uris in [
        vec![],
        vec!["http://evil.example/cb".to_string()],
        vec!["javascript:x".to_string()],
    ] {
        assert!(openbase::cli::add_oauth_client(&app.state, "Bad", &uris, false).is_err());
    }
    let listing = openbase::cli::list_oauth_clients(&app.state)
        .unwrap()
        .join("\n");
    assert!(listing.contains(&public_id) && listing.contains("preregistered"));
    assert!(listing.contains("(confidential)"));
    assert!(
        !listing.contains(&secret),
        "the secret is shown once, at creation"
    );

    // The public client works with the usual flow, and the source is recorded.
    let (verifier, challenge) = pkce();
    let res = authorize_with(
        &app,
        &public_id,
        "https://claude.ai/api/mcp/auth_callback",
        &challenge,
        &[],
    )
    .await;
    let id = request_id(&res);
    let info = app.get(&user, &format!("/api/oauth/requests/{id}")).await;
    info.assert_status(200);
    assert_eq!(info.body["client_source"], "preregistered");
    assert_eq!(info.body["trusted_host"], true);
    assert!(info.body["impersonates"].is_null());
    let code = code_of(&approve(&app, &user, &id, "read").await);
    token_code(
        &app,
        &public_id,
        &code,
        "https://claude.ai/api/mcp/auth_callback",
        &verifier,
    )
    .await
    .assert_status(200);

    // The confidential client must authenticate at the token endpoint.
    let (verifier, challenge) = pkce();
    let id = request_id(&authorize_with(&app, &conf_id, GOOD, &challenge, &[]).await);
    let code = code_of(&approve(&app, &user, &id, "read").await);
    let send = |client_secret: Option<&'static str>| {
        let (app, conf_id, code, verifier) =
            (&app, conf_id.clone(), code.clone(), verifier.clone());
        async move {
            let mut pairs = vec![
                ("grant_type", "authorization_code"),
                ("client_id", conf_id.as_str()),
                ("code", code.as_str()),
                ("redirect_uri", GOOD),
                ("code_verifier", verifier.as_str()),
            ];
            if let Some(s) = client_secret {
                pairs.push(("client_secret", s));
            }
            form(app, "/oauth/token", &pairs).await
        }
    };
    for wrong in [None, Some("ocsWRONG"), Some("oclSomethingElse")] {
        let res = send(wrong).await;
        res.assert_status(401);
        assert_eq!(res.body["error"], "invalid_client");
    }
    // Failed client authentication did not burn the code.
    let secret: &'static str = Box::leak(secret.into_boxed_str());
    send(Some(secret)).await.assert_status(200);

    // Removing a client removes its connections.
    assert_eq!(count(&app, "SELECT count(*) FROM oauth_grants"), 2);
    openbase::cli::remove_oauth_client(&app.state, &conf_id).unwrap();
    assert_eq!(count(&app, "SELECT count(*) FROM oauth_grants"), 1);
    assert!(openbase::cli::remove_oauth_client(&app.state, &conf_id).is_err());
}

// ---------------------------------------------------------------------------------- CIMD

/// An app server with the loopback exception for http client ids, which exists for local
/// development and tests (a real client id is an https URL).
fn app_with_doc_fetching() -> TestApp {
    TestApp::with_config(|c| c.allow_private_webhooks = true)
}

#[tokio::test]
async fn a_metadata_document_identifies_the_client() {
    let app = app_with_doc_fetching();
    let user = app.user("a@example.com", "A");
    let docs = DocServer::start().await;
    docs.serve_default("Document App", &[GOOD, "http://127.0.0.1/cb"]);
    let client_id = docs.client_id();

    let (verifier, challenge) = pkce();
    let res = authorize_with(&app, &client_id, GOOD, &challenge, &[]).await;
    let id = request_id(&res);
    assert_eq!(docs.hits(), 1);
    let info = app.get(&user, &format!("/api/oauth/requests/{id}")).await;
    info.assert_status(200);
    assert_eq!(info.body["client_name"], "Document App");
    assert_eq!(info.body["client_source"], "cimd");
    assert_eq!(info.body["client_id"], client_id.as_str());
    assert_eq!(info.body["redirect_host"], "app.example.com");

    // The rest of the flow works with a URL client id, and the grant lists the document's app.
    let code = code_of(&approve(&app, &user, &id, "write").await);
    let tokens = token_code(&app, &client_id, &code, GOOD, &verifier).await;
    tokens.assert_status(200);
    let grants = app.get(&user, "/api/oauth/grants").await;
    assert_eq!(grants.body[0]["client_name"], "Document App");
    assert_eq!(grants.body[0]["client_source"], "cimd");

    // A second request within the hour uses the cached copy.
    authorize_with(&app, &client_id, GOOD, &pkce().1, &[])
        .await
        .assert_status(302);
    assert_eq!(docs.hits(), 1, "cached");
    // An hour later it is fetched again, and changes are picked up.
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE oauth_clients SET fetched_at = fetched_at - 3700000",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    docs.serve_default("Renamed App", &[GOOD]);
    let id = request_id(&authorize_with(&app, &client_id, GOOD, &pkce().1, &[]).await);
    assert_eq!(docs.hits(), 2);
    let info = app.get(&user, &format!("/api/oauth/requests/{id}")).await;
    assert_eq!(info.body["client_name"], "Renamed App");
    // The redirect address it no longer lists is refused now.
    let res = authorize_with(&app, &client_id, "http://127.0.0.1/cb", &pkce().1, &[]).await;
    res.assert_status(400);
}

#[tokio::test]
async fn an_unreachable_document_is_served_stale_for_a_day_not_longer() {
    let app = app_with_doc_fetching();
    let docs = DocServer::start().await;
    docs.serve_default("Document App", &[GOOD]);
    let client_id = docs.client_id();
    authorize_with(&app, &client_id, GOOD, &pkce().1, &[])
        .await
        .assert_status(302);
    docs.serve_raw(b"oops".to_vec(), "text/plain", 500);
    let age = |ms: i64| {
        let app = &app;
        async move {
            app.state
                .db
                .write_sync(|tx| {
                    tx.execute(
                        "UPDATE oauth_clients SET fetched_at = ?1",
                        [openbase::db::now_ms() - ms],
                    )?;
                    Ok(())
                })
                .unwrap();
        }
    };
    age(2 * 3600 * 1000).await;
    authorize_with(&app, &client_id, GOOD, &pkce().1, &[])
        .await
        .assert_status(302);
    assert_eq!(docs.hits(), 2, "it tried to refresh");
    age(25 * 3600 * 1000).await;
    let res = authorize_with(&app, &client_id, GOOD, &pkce().1, &[]).await;
    res.assert_status(400);
}

#[tokio::test]
async fn bad_metadata_documents_are_refused_without_redirecting() {
    let app = app_with_doc_fetching();
    let docs = DocServer::start().await;
    let client_id = docs.client_id();
    let base = |extra: Value| {
        let mut d = json!({"client_id": client_id, "client_name": "X", "redirect_uris": [GOOD]});
        for (k, v) in extra.as_object().unwrap() {
            if v.is_null() {
                d.as_object_mut().unwrap().remove(k);
            } else {
                d[k] = v.clone();
            }
        }
        d
    };
    let cases: Vec<(&str, Vec<u8>, &str, u16)> = vec![
        (
            "client_id of another app",
            serde_json::to_vec(&base(json!({"client_id": "https://evil.example/c.json"}))).unwrap(),
            "application/json",
            200,
        ),
        (
            "no client_id",
            serde_json::to_vec(&base(json!({"client_id": null}))).unwrap(),
            "application/json",
            200,
        ),
        (
            "a client secret",
            serde_json::to_vec(&base(json!({"client_secret": "s3cret"}))).unwrap(),
            "application/json",
            200,
        ),
        (
            "secret based authentication",
            serde_json::to_vec(&base(
                json!({"token_endpoint_auth_method": "client_secret_post"}),
            ))
            .unwrap(),
            "application/json",
            200,
        ),
        (
            "plain http redirect",
            serde_json::to_vec(&base(json!({"redirect_uris": ["http://evil.example/cb"]})))
                .unwrap(),
            "application/json",
            200,
        ),
        (
            "no redirect uris",
            serde_json::to_vec(&base(json!({"redirect_uris": []}))).unwrap(),
            "application/json",
            200,
        ),
        ("not json", b"<html>".to_vec(), "application/json", 200),
        ("not an object", b"[1]".to_vec(), "application/json", 200),
        (
            "html content type",
            serde_json::to_vec(&base(json!({}))).unwrap(),
            "text/html",
            200,
        ),
        (
            "error status",
            serde_json::to_vec(&base(json!({}))).unwrap(),
            "application/json",
            404,
        ),
        (
            "too large",
            serde_json::to_vec(&base(json!({"padding": "p".repeat(20_000)}))).unwrap(),
            "application/json",
            200,
        ),
    ];
    for (label, body, content_type, status) in cases {
        docs.serve_raw(body, content_type, status);
        let res = authorize_with(&app, &client_id, GOOD, &pkce().1, &[]).await;
        res.assert_status(400);
        assert!(
            !res.headers.contains_key("location"),
            "{label}: an unidentified app is never redirected to"
        );
        assert_eq!(
            count(&app, "SELECT count(*) FROM oauth_clients"),
            0,
            "{label}"
        );
    }
}

#[tokio::test]
async fn client_id_urls_must_be_https_and_public_unless_the_operator_allows_private_hosts() {
    // Default configuration: the local test server is refused (SSRF guard), whatever the URL.
    let app = TestApp::new();
    let docs = DocServer::start().await;
    docs.serve_default("X", &[GOOD]);
    let res = authorize_with(&app, &docs.client_id(), GOOD, &pkce().1, &[]).await;
    res.assert_status(400);
    assert_eq!(
        docs.hits(),
        0,
        "nothing was requested from the private address"
    );
    for url in [
        "https://127.0.0.1/client.json",
        "https://localhost/client.json",
        "https://169.254.169.254/latest/meta-data/x",
        "https://[::1]/client.json",
        "https://10.1.2.3/client.json",
        "http://app.example.com/client.json",
        "https://app.example.com/",
        "https://app.example.com/../client.json",
        "https://app.example.com/client.json#f",
        "https://u:p@app.example.com/client.json",
    ] {
        let res = authorize_with(&app, url, GOOD, &pkce().1, &[]).await;
        res.assert_status(400);
        assert!(!res.headers.contains_key("location"), "{url}");
    }
    // With private addresses allowed, plain http is accepted for loopback hosts only.
    let app = app_with_doc_fetching();
    let res = authorize_with(
        &app,
        "http://app.example.com/client.json",
        GOOD,
        &pkce().1,
        &[],
    )
    .await;
    res.assert_status(400);
    // A registered client id is not a URL, and a URL cannot take over a registered client id.
    let registered = register_client(&app, "Reg", &[GOOD]).await;
    authorize_with(&app, &registered, GOOD, &pkce().1, &[])
        .await
        .assert_status(302);
}

#[tokio::test]
async fn a_slow_metadata_server_does_not_hang_the_authorization_page() {
    use tokio::io::AsyncReadExt;
    let app = app_with_doc_fetching();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        // Accept and say nothing.
        let mut held = Vec::new();
        while let Ok((mut s, _)) = listener.accept().await {
            let mut buf = [0u8; 256];
            let _ = s.read(&mut buf).await;
            held.push(s);
        }
    });
    let started = std::time::Instant::now();
    let res = authorize_with(
        &app,
        &format!("http://127.0.0.1:{port}/client.json"),
        GOOD,
        &pkce().1,
        &[],
    )
    .await;
    res.assert_status(400);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(8),
        "{:?}",
        started.elapsed()
    );
}
