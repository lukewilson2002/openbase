//! Connected apps (OAuth grants) and credential changes: what ends a connection, and what an
//! authorization code that nobody has redeemed yet is worth after the person changed a
//! credential. Personal access tokens are deliberately different (documented in
//! docs/security.md): they are only suspended while an account is deactivated and survive
//! "sign out other sessions" and turning on two-factor authentication.

mod common;
mod mcp_support;
mod oauth_support;

use common::{Client, TestApp};
use oauth_support::*;
use serde_json::json;
use totp_rs::{Algorithm, Builder, Secret, Totp};

const PW: &str = "password1234";

struct World {
    app: TestApp,
    admin: Client,
    user: Client,
}

impl World {
    async fn new() -> World {
        let app = TestApp::new();
        let admin = app.admin("root@example.com", "Root");
        let user = app.user("alice@example.com", "Alice");
        World { app, admin, user }
    }

    async fn connect(&self, user: &Client) -> Connected {
        connect(&self.app, user, "Test Agent", "write", None).await
    }

    fn grants(&self) -> i64 {
        self.app.query_i64("SELECT count(*) FROM oauth_grants", &[])
    }

    async fn works(&self, c: &Connected) -> bool {
        mcp_support::legacy(&self.app, &c.bearer(), "tools/list", json!({}))
            .await
            .status
            == 200
    }

    /// Approve a request for `user` but do not redeem the code yet; returns (client, code, verifier).
    async fn pending_code(&self, user: &Client) -> (String, String, String) {
        let client_id = register_client(&self.app, "Slow App", &[LOOPBACK_REDIRECT]).await;
        let (verifier, challenge) = pkce();
        let res = authorize_with_as(
            &self.app,
            user,
            &client_id,
            LOOPBACK_REDIRECT,
            &challenge,
            &[("scope", "openbase:read openbase:write")],
        )
        .await;
        let id = request_id(&res);
        let code = code_of(&approve(&self.app, user, &id, "write").await);
        (client_id, code, verifier)
    }

    async fn redeem(&self, client_id: &str, code: &str, verifier: &str) -> u16 {
        token_code(&self.app, client_id, code, LOOPBACK_REDIRECT, verifier)
            .await
            .status
            .as_u16()
    }
}

fn totp(secret_b32: &str) -> Totp {
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(
            Secret::try_from_base32(secret_b32)
                .unwrap()
                .as_bytes()
                .to_vec(),
        )
        .build()
        .unwrap()
}

/// A code from the previous 30 second window (so the current one stays usable).
fn previous_code(secret: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    totp(secret).generate(now - 30).to_string()
}

async fn enable_2fa(app: &TestApp, user: &Client) {
    let res = app.post(user, "/api/auth/2fa/setup", json!({})).await;
    res.assert_status(200);
    let secret = res.body["secret"].as_str().unwrap().to_string();
    app.post(
        user,
        "/api/auth/2fa/enable",
        json!({"code": previous_code(&secret)}),
    )
    .await
    .assert_status(200);
}

// -------------------------------------------------------------------- unredeemed codes

#[tokio::test]
async fn a_password_change_voids_codes_that_were_approved_but_not_yet_redeemed() {
    let w = World::new().await;
    let (client_id, code, verifier) = w.pending_code(&w.user).await;
    assert_eq!(
        w.app.query_i64(
            "SELECT count(*) FROM oauth_codes WHERE used_at IS NULL",
            &[]
        ),
        1
    );
    w.app
        .post(
            &w.user,
            "/api/auth/password",
            json!({"current_password": PW, "new_password": "a brand new password 99"}),
        )
        .await
        .assert_status(200);
    assert_eq!(
        w.app.query_i64("SELECT count(*) FROM oauth_codes", &[]),
        0,
        "the code is gone"
    );
    // The code, presented within its 60 seconds, buys nothing.
    assert_eq!(w.redeem(&client_id, &code, &verifier).await, 400);
    assert_eq!(w.grants(), 0);
}

#[tokio::test]
async fn a_password_reset_voids_codes_that_were_approved_but_not_yet_redeemed() {
    let w = World::new().await;
    let (client_id, code, verifier) = w.pending_code(&w.user).await;
    let user_id = w.user.user_id.clone().unwrap();
    let token = w
        .app
        .state
        .db
        .write_sync(move |tx| {
            Ok(openbase::store::users::create_reset_token(tx, &user_id, 3_600_000)?.0)
        })
        .unwrap();
    w.app
        .post(
            &w.app.anon(),
            "/api/auth/password-reset/confirm",
            json!({"token": token, "new_password": "my new password 123"}),
        )
        .await
        .assert_status(200);
    assert_eq!(w.redeem(&client_id, &code, &verifier).await, 400);
    assert_eq!(w.grants(), 0);
}

#[tokio::test]
async fn codes_of_other_people_are_not_touched_by_a_password_change() {
    let w = World::new().await;
    let (client_id, code, verifier) = w.pending_code(&w.admin).await;
    w.app
        .post(
            &w.user,
            "/api/auth/password",
            json!({"current_password": PW, "new_password": "a brand new password 99"}),
        )
        .await
        .assert_status(200);
    assert_eq!(w.redeem(&client_id, &code, &verifier).await, 200);
}

// ---------------------------------------------------------------- what ends connections

#[tokio::test]
async fn deactivating_a_user_ends_their_connected_apps_for_good() {
    let w = World::new().await;
    let a = w.connect(&w.user).await;
    let other = w.connect(&w.admin).await;
    let pat = w
        .app
        .api_token(&w.user, json!({"name": "t", "write": true}))
        .await;
    let (client_id, code, verifier) = w.pending_code(&w.user).await;
    let id = w.user.user_id.clone().unwrap();
    assert!(w.works(&a).await);

    w.app
        .patch(
            &w.admin,
            &format!("/api/admin/users/{id}"),
            json!({"is_active": false}),
        )
        .await
        .assert_status(200);
    assert!(!w.works(&a).await);
    assert_eq!(
        w.app.query_i64(
            "SELECT count(*) FROM oauth_grants WHERE user_id = ?1",
            &[&id]
        ),
        0,
        "the grant is deleted, not just suspended"
    );

    // Reactivating the account does not bring the app back; nor does a code approved earlier.
    w.app
        .patch(
            &w.admin,
            &format!("/api/admin/users/{id}"),
            json!({"is_active": true}),
        )
        .await
        .assert_status(200);
    assert!(!w.works(&a).await);
    assert_eq!(
        token_refresh(&w.app, &a.client_id, &a.refresh).await.status,
        400
    );
    assert_eq!(w.redeem(&client_id, &code, &verifier).await, 400);
    // Somebody else's connection is untouched.
    assert!(w.works(&other).await);
    // Personal access tokens keep the documented behaviour: suspended while the account is
    // deactivated, valid again on reactivation.
    mcp_support::legacy(&w.app, &pat, "tools/list", json!({}))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn turning_on_two_factor_ends_connected_apps_but_not_tokens() {
    let w = World::new().await;
    let a = w.connect(&w.user).await;
    let pat = w
        .app
        .api_token(&w.user, json!({"name": "t", "write": true}))
        .await;
    assert!(w.works(&a).await);
    enable_2fa(&w.app, &w.user).await;
    assert!(!w.works(&a).await);
    assert_eq!(w.grants(), 0);
    assert_eq!(
        token_refresh(&w.app, &a.client_id, &a.refresh).await.status,
        400
    );
    mcp_support::legacy(&w.app, &pat, "tools/list", json!({}))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn signing_out_other_sessions_ends_connected_apps_but_not_tokens() {
    let w = World::new().await;
    let a = w.connect(&w.user).await;
    let b = w.connect(&w.admin).await;
    let pat = w
        .app
        .api_token(&w.user, json!({"name": "t", "write": true}))
        .await;
    assert!(w.works(&a).await);
    w.app
        .post(&w.user, "/api/auth/sessions/revoke-others", json!({}))
        .await
        .assert_status(200);
    assert!(!w.works(&a).await);
    assert_eq!(w.grants(), 1, "only this person's connections ended");
    assert!(w.works(&b).await);
    mcp_support::legacy(&w.app, &pat, "tools/list", json!({}))
        .await
        .assert_status(200);
    // The session that asked is still signed in.
    w.app.get(&w.user, "/api/auth/me").await.assert_status(200);
}

#[tokio::test]
async fn an_administrator_switching_off_someones_two_factor_ends_their_connected_apps() {
    let w = World::new().await;
    enable_2fa(&w.app, &w.user).await;
    // (Turning 2FA on signed this session out of nothing else; connect afterwards.)
    let a = w.connect(&w.user).await;
    assert!(w.works(&a).await);
    let id = w.user.user_id.clone().unwrap();
    w.app
        .patch(
            &w.admin,
            &format!("/api/admin/users/{id}"),
            json!({"disable_2fa": true}),
        )
        .await
        .assert_status(200);
    assert!(!w.works(&a).await);
    assert_eq!(w.grants(), 0);
}
