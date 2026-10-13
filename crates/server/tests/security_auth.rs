//! Regression tests for the authentication / token / invite security review
//! (see docs/security.md). Each test fails on the code before its fix.

mod common;

use common::{Client, TestApp};
use serde_json::json;

const PW: &str = "password1234";

/// A login attempt from `ip` (needs `trust_proxy`).
async fn login_from(app: &TestApp, ip: &str, email: &str, password: &str) -> common::Response {
    app.request_with(
        &app.anon(),
        "POST",
        "/api/auth/login",
        Some(json!({"email": email, "password": password})),
        &[("x-forwarded-for", ip)],
        true,
        None,
    )
    .await
}

// ------------------------------------------------- login memory / disk abuse

#[tokio::test]
async fn oversized_login_email_is_refused_before_touching_limiter_or_audit_log() {
    let app = TestApp::new();
    app.user("a@example.com", "A");
    let big = format!("{}@example.com", "a".repeat(2_000_000));
    let res = app
        .post(
            &app.anon(),
            "/api/auth/login",
            json!({"email": big, "password": "whatever password"}),
        )
        .await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["code"], "invalid_credentials");
    assert_eq!(app.query_i64("SELECT count(*) FROM audit_log", &[]), 0);
    // Only the per-IP counter exists; no per-email key was created.
    assert_eq!(app.state.limiter.len(), 1);

    // A long junk string that is not an email address is refused too.
    let res = app
        .post(
            &app.anon(),
            "/api/auth/login",
            json!({"email": "x".repeat(300), "password": "whatever password"}),
        )
        .await;
    res.assert_status(401);
    assert_eq!(app.query_i64("SELECT count(*) FROM audit_log", &[]), 0);
    assert_eq!(app.state.limiter.len(), 1);
}

#[tokio::test]
async fn failed_logins_from_other_clients_cannot_lock_the_owner_out() {
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    app.user("a@example.com", "A");
    // 24 wrong passwords from three addresses (8 each): more than the old
    // 20-per-email lockout threshold.
    for ip in ["10.1.0.1", "10.1.0.2", "10.1.0.3"] {
        for _ in 0..8 {
            login_from(&app, ip, "a@example.com", "wrong password!")
                .await
                .assert_status(401);
        }
    }
    // The real owner, from a fresh address, can still sign in.
    login_from(&app, "10.1.0.9", "a@example.com", PW)
        .await
        .assert_status(200);
}

#[tokio::test]
async fn one_client_is_limited_per_email_even_across_minutes() {
    // The per-(email, client) bucket outlives the per-minute IP bucket: a
    // guesser who waits a minute cannot keep trying one account from one address.
    let app = TestApp::new();
    app.user("a@example.com", "A");
    for _ in 0..10 {
        app.login("a@example.com", "wrong password!")
            .await
            .0
            .assert_status(401);
    }
    // Simulate the one-minute IP window passing; the hourly bucket remains.
    app.state.limiter.reset("login_ip", "unknown");
    app.login("a@example.com", PW).await.0.assert_status(429);
    // Another account from the same address is unaffected.
    app.user("b@example.com", "B");
    app.login("b@example.com", PW).await.0.assert_status(200);
}

#[test]
fn audit_log_rows_are_bounded_and_expire() {
    let app = TestApp::new();
    app.state
        .db
        .write_sync(|tx| {
            use openbase::store::audit;
            let huge = json!({ "email": "x".repeat(100_000) });
            audit::record(
                tx,
                None,
                audit::actions::LOGIN_FAILED,
                None,
                Some(huge),
                None,
            )?;
            // One old row and one fresh row.
            tx.execute(
                "INSERT INTO audit_log (action, created_at) VALUES ('login', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
    let max: i64 = app.query_i64("SELECT max(length(detail)) FROM audit_log", &[]);
    assert!(max <= 2048, "stored {max} bytes of audit detail");

    let now = openbase::db::now_ms();
    let purged = app
        .state
        .db
        .write_sync(|tx| openbase::tasks::purge_audit(tx, 365, now))
        .unwrap();
    assert_eq!(purged, 1);
    assert_eq!(app.query_i64("SELECT count(*) FROM audit_log", &[]), 1);
    // 0 keeps everything.
    let purged = app
        .state
        .db
        .write_sync(|tx| openbase::tasks::purge_audit(tx, 0, now + 10_000_000_000_000))
        .unwrap();
    assert_eq!(purged, 0);
}

// ------------------------------------------- API tokens vs credential changes

fn bearer(token: &str) -> Client {
    Client {
        bearer: Some(token.to_string()),
        ..Default::default()
    }
}

async fn make_token(app: &TestApp, user: &Client, write: bool) -> String {
    let res = app
        .post(user, "/api/tokens", json!({"name": "t", "write": write}))
        .await;
    res.assert_status(201);
    res.body["token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn password_change_revokes_api_tokens() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let token = make_token(&app, &user, true).await;
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(200);
    app.post(
        &user,
        "/api/auth/password",
        json!({"current_password": PW, "new_password": "a brand new password"}),
    )
    .await
    .assert_status(200);
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(401);
    // Other users' tokens are untouched.
    let other = app.user("b@example.com", "B");
    let other_token = make_token(&app, &other, true).await;
    app.get(&bearer(&other_token), "/api/tokens/whoami")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn password_reset_link_revokes_api_tokens() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let token = make_token(&app, &user, true).await;
    let uid = user.user_id.clone().unwrap();
    let (reset, _) = app
        .state
        .db
        .write_sync(|tx| openbase::store::users::create_reset_token(tx, &uid, 3_600_000))
        .unwrap();
    app.post(
        &app.anon(),
        "/api/auth/password-reset/confirm",
        json!({"token": reset, "new_password": "a brand new password"}),
    )
    .await
    .assert_status(200);
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(401);
    assert_eq!(app.query_i64("SELECT count(*) FROM api_tokens", &[]), 0);
}

#[tokio::test]
async fn cli_password_reset_revokes_api_tokens() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let token = make_token(&app, &user, true).await;
    openbase::cli::reset_password(&app.state, "a@example.com", "a brand new password").unwrap();
    app.get(&bearer(&token), "/api/tokens/whoami")
        .await
        .assert_status(401);
}

// ------------------------------------------------------------------ invites

fn token_of(url: &serde_json::Value) -> String {
    url.as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string()
}

async fn invite(app: &TestApp, by: &Client, target: &str, role: &str) -> String {
    let res = app
        .post(by, &format!("{target}/invites"), json!({ "role": role }))
        .await;
    res.assert_status(201);
    token_of(&res.body["url"])
}

#[tokio::test]
async fn invites_die_with_their_creators_deactivation() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let owner = app.user("owner@example.com", "Owner");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    let token = invite(&app, &owner, &format!("/api/workspaces/{ws}"), "owner").await;
    let preview = format!("/api/invites/by-token/{token}");
    app.get(&app.anon(), &preview).await.assert_status(200);

    app.patch(
        &admin,
        &format!("/api/admin/users/{}", owner.user_id.as_ref().unwrap()),
        json!({"is_active": false}),
    )
    .await
    .assert_status(200);

    app.get(&app.anon(), &preview).await.assert_status(404);
    let newcomer = app.user("new@example.com", "New");
    app.post(&newcomer, &format!("{preview}/accept"), json!({}))
        .await
        .assert_status(404);
    app.signup("fresh@example.com", "a long password!", Some(&token))
        .await
        .0
        .assert_status(404);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM workspace_members WHERE role = 'owner'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn invites_die_when_their_creator_loses_the_role_to_grant_them() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "Owner");
    let second = app.user("second@example.com", "Second");
    let (ws, _) = app.workspace_with_base(&owner, "Acme");
    app.grant_workspace_role(&second, &ws, "owner");
    let target = format!("/api/workspaces/{ws}");
    let from_second = invite(&app, &second, &target, "owner").await;
    let from_owner = invite(&app, &owner, &target, "owner").await;

    // Demoted: no longer an Owner, so their pending invites stop working.
    app.grant_workspace_role(&second, &ws, "editor");
    let newcomer = app.user("new@example.com", "New");
    app.post(
        &newcomer,
        &format!("/api/invites/by-token/{from_second}/accept"),
        json!({}),
    )
    .await
    .assert_status(404);
    // Removed from the workspace entirely: same.
    app.state
        .db
        .write_sync(|tx| Ok(tx.execute("DELETE FROM workspace_members WHERE role = 'editor'", [])?))
        .unwrap();
    app.get(&app.anon(), &format!("/api/invites/by-token/{from_second}"))
        .await
        .assert_status(404);
    // The remaining owner's invite is unaffected.
    app.post(
        &newcomer,
        &format!("/api/invites/by-token/{from_owner}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
}

#[tokio::test]
async fn creators_cannot_accept_their_own_invites() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "Owner");
    let creator = app.user("creator@example.com", "Creator");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    app.grant_workspace_role(&creator, &ws, "creator");
    let token = invite(&app, &creator, &format!("/api/bases/{base}"), "creator").await;
    let res = app
        .post(
            &creator,
            &format!("/api/invites/by-token/{token}/accept"),
            json!({}),
        )
        .await;
    res.assert_status(403);
    // No standalone base grant that would outlive removal from the workspace.
    assert_eq!(app.query_i64("SELECT count(*) FROM base_members", &[]), 0);
    // Someone else can still use it.
    let other = app.user("other@example.com", "Other");
    app.post(
        &other,
        &format!("/api/invites/by-token/{token}/accept"),
        json!({}),
    )
    .await
    .assert_status(200);
}

// ------------------------------------------------- client IP / CSRF handling

#[tokio::test]
async fn client_supplied_forwarded_for_entries_cannot_dodge_per_ip_limits() {
    // A proxy that appends (nginx's $proxy_add_x_forwarded_for) leaves the
    // client's own value on the left; only the last entry is trustworthy.
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    app.user("a@example.com", "A");
    for i in 0..10 {
        let xff = format!("198.51.100.{i}, 203.0.113.7");
        app.request_with(
            &app.anon(),
            "POST",
            "/api/auth/login",
            Some(json!({"email": format!("u{i}@example.com"), "password": "wrong password!"})),
            &[("x-forwarded-for", xff.as_str())],
            true,
            None,
        )
        .await
        .assert_status(401);
    }
    let res = app
        .request_with(
            &app.anon(),
            "POST",
            "/api/auth/login",
            Some(json!({"email": "a@example.com", "password": "wrong password!"})),
            &[("x-forwarded-for", "198.51.100.99, 203.0.113.7")],
            true,
            None,
        )
        .await;
    res.assert_status(429);
    // Audit rows carry the proxy-observed address, not the spoofed one.
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE ip LIKE '198.51.100.%'",
            &[]
        ),
        0
    );
    assert!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE ip = '203.0.113.7'",
            &[]
        ) > 0
    );
}

#[tokio::test]
async fn non_bearer_authorization_headers_do_not_bypass_csrf() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let token = user.cookie.clone().unwrap();
    for auth in [
        "Basic dXNlcjpwYXNz",
        "Digest abc",
        "bearer lowercase",
        "Bearer",
    ] {
        let res = app
            .request_with(
                &Client {
                    cookie: Some(token.clone()),
                    ..Client::default()
                },
                "POST",
                "/api/auth/password",
                Some(json!({"current_password": PW, "new_password": "a brand new password"})),
                &[("authorization", auth)],
                false,
                None,
            )
            .await;
        res.assert_status(403);
        assert_eq!(
            res.body["error"]["message"], "missing CSRF header",
            "{auth}"
        );
    }
    // The password was not changed and the session still works.
    app.get(&user, "/api/auth/me").await.assert_status(200);
    app.login("a@example.com", PW).await.0.assert_status(200);
}

// ------------------------------------------------ read-only and scoped tokens

/// Every state-changing route of the internal API (method, path with made-up
/// ids). A read-only token must be refused on all of them, before the handler
/// looks at the ids. Add new mutating routes here.
const MUTATING_ROUTES: &[(&str, &str)] = &[
    ("POST", "/api/admin/users"),
    ("PATCH", "/api/admin/users/usrX"),
    ("POST", "/api/admin/users/usrX/reset-link"),
    ("PATCH", "/api/admin/email"),
    ("POST", "/api/admin/email/test"),
    ("POST", "/api/admin/backups"),
    ("POST", "/api/bases/appX/automations"),
    ("PATCH", "/api/automations/autX"),
    ("DELETE", "/api/automations/autX"),
    ("POST", "/api/automations/autX/test"),
    ("PATCH", "/api/auth/me"),
    ("POST", "/api/auth/password"),
    ("POST", "/api/auth/2fa/setup"),
    ("POST", "/api/auth/2fa/enable"),
    ("POST", "/api/auth/2fa/disable"),
    ("POST", "/api/auth/sessions/revoke-others"),
    ("DELETE", "/api/auth/sessions/0123456789abcdef"),
    ("POST", "/api/workspaces/wspX/bases"),
    ("PATCH", "/api/bases/appX"),
    ("DELETE", "/api/bases/appX"),
    ("POST", "/api/bases/appX/duplicate"),
    ("PATCH", "/api/bases/appX/members/usrX"),
    ("DELETE", "/api/bases/appX/members/usrX"),
    ("POST", "/api/records/recX/comments"),
    ("PATCH", "/api/comments/cmtX"),
    ("DELETE", "/api/comments/cmtX"),
    ("POST", "/api/tables/tblX/formula/check"),
    ("POST", "/api/tables/tblX/fields"),
    ("PATCH", "/api/fields/fldX"),
    ("DELETE", "/api/fields/fldX"),
    ("POST", "/api/tables/tblX/primary-field"),
    ("POST", "/api/tables/tblX/import"),
    ("POST", "/api/bases/appX/import"),
    ("POST", "/api/workspaces/wspX/invites"),
    ("POST", "/api/bases/appX/invites"),
    ("DELETE", "/api/invites/invX"),
    ("POST", "/api/invites/by-token/inv_x/accept"),
    ("POST", "/api/notifications/read"),
    ("POST", "/api/tables/tblX/records"),
    ("PATCH", "/api/tables/tblX/records"),
    ("DELETE", "/api/tables/tblX/records"),
    ("POST", "/api/tables/tblX/records/restore"),
    ("POST", "/api/tables/tblX/records/move"),
    ("POST", "/api/bases/appX/tables"),
    ("PATCH", "/api/tables/tblX"),
    ("DELETE", "/api/tables/tblX"),
    ("POST", "/api/tables/tblX/duplicate"),
    ("POST", "/api/tokens"),
    ("DELETE", "/api/tokens/tokX"),
    ("POST", "/api/trash/restore"),
    ("POST", "/api/tables/tblX/views"),
    ("PATCH", "/api/views/viwX"),
    ("DELETE", "/api/views/viwX"),
    ("POST", "/api/views/viwX/duplicate"),
    ("POST", "/api/views/viwX/shares"),
    ("PATCH", "/api/shares/shrX"),
    ("DELETE", "/api/shares/shrX"),
    ("POST", "/api/workspaces"),
    ("PATCH", "/api/workspaces/wspX"),
    ("DELETE", "/api/workspaces/wspX"),
    ("PATCH", "/api/workspaces/wspX/members/usrX"),
    ("DELETE", "/api/workspaces/wspX/members/usrX"),
    ("POST", "/api/bases/appX/attachments"),
];

#[tokio::test]
async fn read_only_tokens_cannot_call_any_mutating_route() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let ro = bearer(&make_token(&app, &user, false).await);
    for (method, path) in MUTATING_ROUTES {
        let body = (*method != "DELETE").then(|| json!({}));
        let res = app.request(&ro, method, path, body).await;
        assert_eq!(res.status, 403, "{method} {path}: {}", res.body);
        let msg = res.body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            msg.contains("read-only"),
            "{method} {path} was refused for another reason: {msg}"
        );
    }
    // Reads, and the read-only POST that runs a view query, still pass the guard
    // (the made-up ids then answer 404).
    app.get(&ro, "/api/tokens/whoami").await.assert_status(200);
    app.get(&ro, "/api/notifications").await.assert_status(200);
    app.post(&ro, "/api/views/viwX/query", json!({}))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn write_tokens_are_not_blocked_by_the_read_only_rule() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let rw = bearer(&make_token(&app, &user, true).await);
    for (method, path) in MUTATING_ROUTES {
        let body = (*method != "DELETE").then(|| json!({}));
        let res = app.request(&rw, method, path, body).await;
        let msg = res.body["error"]["message"].as_str().unwrap_or_default();
        assert!(!msg.contains("read-only"), "{method} {path}: {msg}");
    }
}

#[tokio::test]
async fn read_only_token_cannot_mark_notifications_read() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let (_ws, base) = app.workspace_with_base(&user, "Acme");
    let ro = bearer(&make_token(&app, &user, false).await);
    let uid = user.user_id.clone().unwrap();
    let nid = openbase::ids::new_id(ob_core::ids::NOTIFICATION);
    {
        let (nid, uid, base) = (nid.clone(), uid.clone(), base.clone());
        app.state
            .db
            .write_sync(move |tx| {
                tx.execute(
                    "INSERT INTO notifications (id, user_id, kind, payload, created_at)
                     VALUES (?1, ?2, 'mention', ?3, 1)",
                    rusqlite::params![nid, uid, json!({ "base_id": base }).to_string()],
                )?;
                Ok(())
            })
            .unwrap();
    }
    app.post(&ro, "/api/notifications/read", json!({"ids": [nid]}))
        .await
        .assert_status(403);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM notifications WHERE read_at IS NOT NULL",
            &[]
        ),
        0
    );
}

#[tokio::test]
async fn base_limited_tokens_only_see_and_mark_their_bases_notifications() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let (_w1, base_a) = app.workspace_with_base(&user, "A");
    let (_w2, base_b) = app.workspace_with_base(&user, "B");
    let uid = user.user_id.clone().unwrap();
    let mut ids = Vec::new();
    for (i, base) in [&base_a, &base_b].into_iter().enumerate() {
        let id = openbase::ids::new_id(ob_core::ids::NOTIFICATION);
        ids.push(id.clone());
        let (uid, base) = (uid.clone(), base.clone());
        app.state
            .db
            .write_sync(move |tx| {
                tx.execute(
                    "INSERT INTO notifications (id, user_id, kind, payload, created_at)
                     VALUES (?1, ?2, 'mention', ?3, ?4)",
                    rusqlite::params![
                        id,
                        uid,
                        json!({ "base_id": base, "snippet": "secret" }).to_string(),
                        10 + i as i64
                    ],
                )?;
                Ok(())
            })
            .unwrap();
    }
    let res = app
        .post(
            &user,
            "/api/tokens",
            json!({"name": "lim", "write": true, "base_ids": [base_a]}),
        )
        .await;
    res.assert_status(201);
    let lim = bearer(res.body["token"].as_str().unwrap());

    let listed = app.get(&lim, "/api/notifications").await;
    listed.assert_status(200);
    let items = listed.body["notifications"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{}", listed.body);
    assert_eq!(items[0]["id"], ids[0]);
    assert_eq!(listed.body["unread"], 1);

    // Marking everything read only touches the token's base; naming the other
    // base's notification is ignored.
    app.post(&lim, "/api/notifications/read", json!({"ids": [ids[1]]}))
        .await
        .assert_status(200);
    app.post(&lim, "/api/notifications/read", json!({}))
        .await
        .assert_status(200);
    let all = app.get(&user, "/api/notifications").await;
    let by_id = |id: &str| {
        all.body["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == id)
            .unwrap()
            .clone()
    };
    assert!(by_id(&ids[0])["read_at"].is_i64());
    assert!(by_id(&ids[1])["read_at"].is_null());
}

// ------------------------------------------------------------------ 2FA

mod second_factor {
    use super::*;
    use totp_rs::{Algorithm, Builder, Secret};

    fn code(secret_b32: &str, step_offset: i64) -> String {
        let totp = Builder::new()
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
            .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        totp.generate((now + step_offset * 30) as u64).to_string()
    }

    async fn enable_2fa(app: &TestApp, user: &Client) -> String {
        let res = app.post(user, "/api/auth/2fa/setup", json!({})).await;
        res.assert_status(200);
        let secret = res.body["secret"].as_str().unwrap().to_string();
        app.post(
            user,
            "/api/auth/2fa/enable",
            json!({"code": code(&secret, -1)}),
        )
        .await
        .assert_status(200);
        secret
    }

    #[tokio::test]
    async fn guesses_are_limited_per_account_across_pending_sessions() {
        let app = TestApp::new();
        let user = app.user("a@example.com", "A");
        let secret = enable_2fa(&app, &user).await;
        let good = code(&secret, 0);
        let wrong = if good == "000000" { "111111" } else { "000000" };
        // Each fresh password login hands out a new pending session (with its
        // own 10 guesses); the account as a whole only gets 10 an hour.
        let mut failed = 0;
        for _ in 0..3 {
            let (_, pending) = app.login("a@example.com", PW).await;
            for _ in 0..4 {
                let res = app
                    .post(&pending, "/api/auth/login/2fa", json!({"code": wrong}))
                    .await;
                if res.status == 401 {
                    failed += 1;
                } else {
                    res.assert_status(429);
                }
            }
        }
        assert_eq!(failed, 10, "only 10 wrong guesses per account per hour");
        // Even the right code is refused now, from a brand new pending session.
        let (_, pending) = app.login("a@example.com", PW).await;
        app.post(&pending, "/api/auth/login/2fa", json!({"code": good}))
            .await
            .assert_status(429);
    }

    #[tokio::test]
    async fn random_pending_cookies_do_not_grow_the_limiter_and_are_ip_limited() {
        let app = TestApp::new();
        app.user("a@example.com", "A");
        let mut limited = 0;
        for i in 0..60 {
            let bogus = Client {
                cookie: Some(format!("ses_random_{i}")),
                ..Client::default()
            };
            let res = app
                .post(&bogus, "/api/auth/login/2fa", json!({"code": "123456"}))
                .await;
            if res.status == 429 {
                limited += 1;
            } else {
                res.assert_status(401);
            }
        }
        assert!(limited > 0, "the endpoint has a per-IP limit");
        assert!(
            app.state.limiter.len() <= 2,
            "random cookies created {} limiter keys",
            app.state.limiter.len()
        );
    }
}
