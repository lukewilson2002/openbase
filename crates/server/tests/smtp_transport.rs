//! The real SMTP transport against a fake server over every connection mode a provider such as
//! Resend offers (STARTTLS on 587/2587/25, implicit TLS on 465/2465), end to end through the
//! admin "send test email" endpoint: the saved username and API key reach the server, the message
//! is delivered, and every way a connection can go wrong comes back as a readable error.

mod common;
mod smtp_support;

use common::{Client, TestApp};
use openbase::email::{RawSmtp, smtp_factory, smtp_factory_with_roots};
use openbase::store::email_settings;
use serde_json::{Value, json};
use smtp_support::{FakeSmtp, Mode};

const KEY: &str = "re_Test123_abcDEFghiJKLmnoPQRstuVWXyz";

async fn stored(app: &TestApp) -> RawSmtp {
    app.state.db.read(email_settings::load).await.unwrap()
}

/// Save settings through the admin API, then switch the app to the real transport (trusting the
/// fake server's certificate) with what was stored, as a restart would.
async fn configure(app: &TestApp, admin: &Client, fake: &FakeSmtp, patch: Value) {
    app.patch(admin, "/api/admin/email", patch)
        .await
        .assert_status(200);
    let stored = stored(app).await;
    app.state
        .email
        .set_factory(
            smtp_factory_with_roots(vec![fake.cert_der.clone()]),
            &stored,
        )
        .unwrap();
}

async fn test_email(app: &TestApp, admin: &Client) -> Value {
    let res = app.post(admin, "/api/admin/email/test", json!({})).await;
    res.assert_status(200);
    res.body
}

fn resend_like(port: u16, security: &str) -> Value {
    json!({
        "host": "127.0.0.1", "port": port, "security": security,
        "username": "resend", "password": KEY,
        "from": "OpenBase <onboarding@example.com>",
    })
}

#[tokio::test]
async fn starttls_with_username_and_api_key_delivers_the_test_email() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let fake = smtp_support::start(Mode::StartTls, "resend", KEY).await;
    configure(&app, &admin, &fake, resend_like(fake.port, "starttls")).await;
    let body = test_email(&app, &admin).await;
    assert_eq!(body["ok"], true, "{body}");
    fake.with(|s| {
        assert_eq!(s.auths, vec![("resend".into(), KEY.into(), true)]);
        assert_eq!(s.mails.len(), 1);
        assert!(s.mails[0].from.contains("onboarding@example.com"));
        assert!(s.mails[0].to[0].contains("admin@example.com"));
        assert!(s.mails[0].data.contains("Subject: OpenBase test email"));
    });
}

#[tokio::test]
async fn implicit_tls_with_username_and_api_key_delivers_the_test_email() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let fake = smtp_support::start(Mode::Implicit, "resend", KEY).await;
    configure(&app, &admin, &fake, resend_like(fake.port, "tls")).await;
    let body = test_email(&app, &admin).await;
    assert_eq!(body["ok"], true, "{body}");
    fake.with(|s| {
        assert_eq!(s.auths, vec![("resend".into(), KEY.into(), true)]);
        assert_eq!(s.mails.len(), 1);
    });
}

#[tokio::test]
async fn a_wrong_key_reports_the_servers_auth_error() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let fake = smtp_support::start(Mode::StartTls, "resend", KEY).await;
    let mut patch = resend_like(fake.port, "starttls");
    patch["password"] = json!("re_wrong_key");
    configure(&app, &admin, &fake, patch).await;
    let body = test_email(&app, &admin).await;
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().unwrap();
    assert!(
        error.contains("535") || error.contains("Authentication credentials invalid"),
        "{error}"
    );
    assert!(
        !error.contains("re_wrong_key"),
        "the key must not be echoed: {error}"
    );
    fake.with(|s| assert!(s.mails.is_empty()));
}

#[tokio::test]
async fn a_server_with_an_untrusted_certificate_says_so() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let fake = smtp_support::start(Mode::Implicit, "resend", KEY).await;
    app.patch(&admin, "/api/admin/email", resend_like(fake.port, "tls"))
        .await
        .assert_status(200);
    // the stock transport trusts only the system roots, not the fake server's certificate
    let stored = stored(&app).await;
    app.state
        .email
        .set_factory(smtp_factory(), &stored)
        .unwrap();
    let body = test_email(&app, &admin).await;
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().unwrap().to_lowercase();
    assert!(
        error.contains("certificate") || error.contains("tls") || error.contains("handshake"),
        "a TLS error, not a generic one: {error}"
    );
    fake.with(|s| assert!(s.auths.is_empty()));
}

#[tokio::test]
async fn starttls_against_an_implicit_tls_port_fails_with_a_hint() {
    // Selecting "STARTTLS" for port 465 (or "TLS" for 587) is the easiest mistake to make with
    // Resend. The server never speaks first, so the client could only time out; the error says
    // which mode and port to use instead of leaving a generic failure.
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    // 2465 is Resend's alternative implicit-TLS port, and unprivileged
    let fake = smtp_support::start_on(2465, Mode::Implicit, "resend", KEY).await;
    configure(&app, &admin, &fake, resend_like(fake.port, "starttls")).await;
    let started = std::time::Instant::now();
    let body = test_email(&app, &admin).await;
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().unwrap();
    assert!(error.contains("did not answer"), "{error}");
    assert!(
        error.contains("implicit TLS") && error.contains("set Connection security to TLS"),
        "the fix is named: {error}"
    );
    assert!(
        error.contains(&format!("127.0.0.1:{}", fake.port)),
        "says where: {error}"
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(40),
        "answers before the endpoint's own limit: {:?}",
        started.elapsed()
    );
    fake.with(|s| assert!(s.auths.is_empty() && s.mails.is_empty()));
}

#[tokio::test]
async fn tls_against_a_starttls_port_is_a_readable_error() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let fake = smtp_support::start(Mode::StartTls, "resend", KEY).await;
    configure(&app, &admin, &fake, resend_like(fake.port, "tls")).await;
    let body = test_email(&app, &admin).await;
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().unwrap();
    // an ephemeral port is not a well-known one, so no hint here; the library's own error is
    assert!(error.len() > 20 && !error.contains("internal"), "{error}");
    assert!(
        !error.contains("did not answer"),
        "fails fast, not by timing out: {error}"
    );
    fake.with(|s| assert!(s.auths.is_empty() && s.mails.is_empty()));

    // on Resend's alternative STARTTLS port the error also names the fix
    let fake = smtp_support::start_on(2587, Mode::StartTls, "resend", KEY).await;
    configure(&app, &admin, &fake, resend_like(fake.port, "tls")).await;
    let body = test_email(&app, &admin).await;
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().unwrap();
    assert!(
        error.contains("set Connection security to STARTTLS"),
        "{error}"
    );
    fake.with(|s| assert!(s.auths.is_empty() && s.mails.is_empty()));
}
