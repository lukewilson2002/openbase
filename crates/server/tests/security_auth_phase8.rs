//! Regression tests for the final security audit (phase 8): sign-in, invites and cookies.
//! Each test fails on the code before its fix. The finding ids are in the test names' comments.

mod common;

use common::TestApp;
use serde_json::json;

const PW: &str = "password1234";

fn token_of(url: &serde_json::Value) -> String {
    url.as_str()
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_string()
}

fn smtp(c: &mut openbase::config::Config) {
    c.smtp_host = Some("smtp.example.com".into());
}

/// The eight-digit code in the mail the server sent.
fn code_in(body: &str) -> String {
    body.split_whitespace()
        .find(|w| w.len() == 8 && w.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or_else(|| panic!("no code in: {body}"))
        .to_string()
}

async fn restricted_invite(app: &TestApp, email: &str) -> (common::Client, String) {
    let (_, admin) = app.signup("admin@example.com", PW, None).await;
    let (ws, _) = app.workspace_with_base(&admin, "Acme");
    let res = app
        .post(
            &admin,
            &format!("/api/workspaces/{ws}/invites"),
            json!({"role": "owner", "email": email}),
        )
        .await;
    res.assert_status(201);
    (admin, token_of(&res.body["url"]))
}

async fn signup_with(
    app: &TestApp,
    email: &str,
    token: &str,
    code: Option<&str>,
) -> common::Response {
    app.post(
        &app.anon(),
        "/api/auth/signup",
        json!({"email": email, "name": "N", "password": PW, "invite_token": token, "email_code": code}),
    )
    .await
}

/// F18, F36, F45, F52: typing the invited address proves nothing, so a leaked link cannot be
/// used to sign up as the invitee. The code goes to the mailbox only.
#[tokio::test]
async fn an_invite_for_one_address_needs_a_code_mailed_to_it() {
    let app = TestApp::with_config(smtp);
    let (_, token) = restricted_invite(&app, "bob@corp.example").await;

    // The holder of the link types the address and gets no account, only a request for a code.
    let res = signup_with(&app, "bob@corp.example", &token, None).await;
    res.assert_status(403);
    assert_eq!(res.body["error"]["code"], "email_code_required");
    assert_eq!(app.query_i64("SELECT count(*) FROM users", &[]), 1);
    // The invite mail came first, the code mail second.
    let mails = app.mailer.wait_for(2).await;
    assert_eq!(mails[1].to, "bob@corp.example");
    let code = code_in(&mails[1].body);
    assert!(
        !res.body.to_string().contains(&code),
        "the code is not in the response"
    );

    // A wrong code and another address both fail; no account is made.
    signup_with(&app, "bob@corp.example", &token, Some("00000000"))
        .await
        .assert_status(400);
    signup_with(&app, "mallory@example.com", &token, Some(&code))
        .await
        .assert_status(403);
    assert_eq!(app.query_i64("SELECT count(*) FROM users", &[]), 1);

    // The person who read the mail signs up, once.
    let res = signup_with(&app, "BOB@corp.example", &token, Some(&code)).await;
    res.assert_status(200);
    assert_eq!(app.query_i64("SELECT count(*) FROM users", &[]), 2);
    signup_with(&app, "bob@corp.example", &token, Some(&code))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn five_wrong_codes_void_the_code() {
    let app = TestApp::with_config(smtp);
    let (_, token) = restricted_invite(&app, "bob@corp.example").await;
    signup_with(&app, "bob@corp.example", &token, None)
        .await
        .assert_status(403);
    let code = code_in(&app.mailer.wait_for(2).await[1].body);
    for _ in 0..5 {
        signup_with(&app, "bob@corp.example", &token, Some("00000000"))
            .await
            .assert_status(400);
    }
    signup_with(&app, "bob@corp.example", &token, Some(&code))
        .await
        .assert_status(400);
}

/// Without a way to mail the code the address cannot be confirmed, so the sign-up is refused
/// with the way out, not accepted on the typed address.
#[tokio::test]
async fn an_invite_for_one_address_is_refused_when_the_server_cannot_mail() {
    let app = TestApp::new();
    let (_, token) = restricted_invite(&app, "bob@corp.example").await;
    let res = signup_with(&app, "bob@corp.example", &token, None).await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("set up email")
    );
    assert_eq!(app.query_i64("SELECT count(*) FROM users", &[]), 1);
}

/// F42: pointing an invite at a base of another workspace passed every check in that workspace,
/// and the foreign list then kept the invite alive after its creator lost standing in its own.
#[tokio::test]
async fn an_invite_cannot_be_pointed_at_a_base_of_another_workspace() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let creator = app.user("creator@example.com", "C");
    app.grant_base_role(&creator, &base, "creator");
    let (_, own_base) = app.workspace_with_base(&creator, "Own");

    let res = app
        .post(
            &creator,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "creator"}),
        )
        .await;
    res.assert_status(201);
    let id = res.body["info"]["id"].as_str().unwrap().to_string();
    app.patch(
        &creator,
        &format!("/api/invites/{id}"),
        json!({"base_ids": [own_base]}),
    )
    .await
    .assert_status(404);
    let list = app
        .get(&owner, &format!("/api/workspaces/{ws}/invites"))
        .await;
    assert_eq!(list.body[0]["base_ids"], json!([base]));

    // Stored data that already has a foreign base on it is dead once the creator is out.
    app.state
        .db
        .write_sync(|tx| {
            tx.execute("DELETE FROM invite_bases", [])?;
            tx.execute(
                "INSERT INTO invite_bases (invite_id, base_id) VALUES (?1, ?2)",
                rusqlite::params![id, own_base],
            )?;
            Ok(())
        })
        .unwrap();
    let token = token_of(&res.body["url"]);
    app.get(&app.anon(), &format!("/api/invites/by-token/{token}"))
        .await
        .assert_status(404);
}

/// F57: trashing the one base a creator lost brought their voided invite back, and accepting it
/// handed that base over.
#[tokio::test]
async fn trashing_a_base_the_creator_lost_does_not_revive_their_invite() {
    let app = TestApp::new();
    let owner = app.user("owner@example.com", "O");
    let (ws, base) = app.workspace_with_base(&owner, "Acme");
    let res = app
        .post(
            &owner,
            &format!("/api/workspaces/{ws}/bases"),
            json!({"name": "B"}),
        )
        .await;
    res.assert_status(201);
    let b = res.body["id"].as_str().unwrap().to_string();
    let creator = app.user("creator@example.com", "C");
    app.grant_base_role(&creator, &base, "creator");
    app.grant_base_role(&creator, &b, "creator");

    let res = app
        .post(
            &creator,
            &format!("/api/bases/{base}/invites"),
            json!({"role": "viewer", "base_ids": [base, b]}),
        )
        .await;
    res.assert_status(201);
    let token = token_of(&res.body["url"]);
    let preview = format!("/api/invites/by-token/{token}");
    app.get(&app.anon(), &preview).await.assert_status(200);

    // An owner takes `b` off the creator: the invite is void while `b` is live ...
    let cid = creator.user_id.clone().unwrap();
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "DELETE FROM workspace_member_bases WHERE user_id = ?1 AND base_id = ?2",
                rusqlite::params![cid, b],
            )?;
            Ok(())
        })
        .unwrap();
    app.get(&app.anon(), &preview).await.assert_status(404);
    // ... and stays void when `b` goes to the trash.
    app.delete(&owner, &format!("/api/bases/{b}"))
        .await
        .assert_status(200);
    app.get(&app.anon(), &preview).await.assert_status(404);
    let other = app.user("other@example.com", "X");
    app.post(&other, &format!("{preview}/accept"), json!({}))
        .await
        .assert_status(404);
}

fn reset_token(app: &TestApp, user: &common::Client) -> String {
    let uid = user.user_id.clone().unwrap();
    app.state
        .db
        .write_sync(|tx| openbase::store::users::create_reset_token(tx, &uid, 3_600_000))
        .unwrap()
        .0
}

async fn reset_with(app: &TestApp, token: &str) -> common::Response {
    app.post(
        &app.anon(),
        "/api/auth/password-reset/confirm",
        json!({"token": token, "new_password": "another good password"}),
    )
    .await
}

/// F47, F48, F53: a reset link issued before the password changed no longer works.
#[tokio::test]
async fn changing_the_password_voids_reset_links() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let link = reset_token(&app, &user);
    app.post(
        &user,
        "/api/auth/password",
        json!({"current_password": PW, "new_password": "a brand new password"}),
    )
    .await
    .assert_status(200);
    reset_with(&app, &link).await.assert_status(400);
}

#[tokio::test]
async fn the_command_line_password_reset_voids_reset_links() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    let link = reset_token(&app, &user);
    openbase::cli::reset_password(&app.state, "a@example.com", "a brand new password").unwrap();
    reset_with(&app, &link).await.assert_status(400);
}

/// F51: an old session cannot turn on two-factor authentication (which would lock the owner
/// out) without the password.
#[tokio::test]
async fn an_old_session_confirms_the_password_to_turn_on_two_factor() {
    let app = TestApp::new();
    let user = app.user("a@example.com", "A");
    app.state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE sessions SET created_at = created_at - 3600000", [])?;
            Ok(())
        })
        .unwrap();
    let setup = app.post(&user, "/api/auth/2fa/setup", json!({})).await;
    setup.assert_status(200);
    let secret = setup.body["secret"].as_str().unwrap().to_string();
    let totp = totp_rs::Builder::new()
        .with_algorithm(totp_rs::Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(30)
        .with_secret(
            totp_rs::Secret::try_from_base32(&secret)
                .unwrap()
                .as_bytes()
                .to_vec(),
        )
        .build()
        .unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let code = totp.generate(now - 30).to_string();
    let path = "/api/auth/2fa/enable";

    let res = app.post(&user, path, json!({"code": code})).await;
    res.assert_status(403);
    assert_eq!(res.body["error"]["code"], "reauth_required");
    app.post(
        &user,
        path,
        json!({"code": code, "password": "wrong password"}),
    )
    .await
    .assert_status(403);
    let me = app.get(&user, "/api/auth/me").await;
    assert_eq!(me.body["totp_enabled"], false);
    let res = app
        .post(&user, path, json!({"code": code, "password": PW}))
        .await;
    res.assert_status(200);
    assert_eq!(res.body["totp_enabled"], true);
}

/// F59: a cookie whose name only decodes to the session cookie's is not that cookie.
#[tokio::test]
async fn a_percent_encoded_cookie_name_is_not_the_session_cookie() {
    let app = TestApp::with_config(|c| c.public_url = "https://base.example.com".into());
    let user = app.user("a@example.com", "A");
    let token = user.cookie.clone().unwrap();
    let name = app.state.config.session_cookie_name();
    assert_eq!(name, "__Host-ob_session");
    let get = |cookie: String| {
        let app = &app;
        async move {
            app.request_with(
                &app.anon(),
                "GET",
                "/api/auth/me",
                None,
                &[("cookie", cookie.as_str())],
                true,
                None,
            )
            .await
        }
    };
    get(format!("{name}={token}")).await.assert_status(200);
    get(format!("%5F_Host-ob_session={token}"))
        .await
        .assert_status(401);
    // Planted alongside the real one it does not take over.
    get(format!("{name}={token}; %5F_Host-ob_session=bogus"))
        .await
        .assert_status(200);
}

/// F58: per-address sign-in limits count an IPv6 /64 as one address.
#[tokio::test]
async fn sign_in_limits_count_an_ipv6_prefix_as_one_address() {
    let app = TestApp::with_config(|c| c.trust_proxy = true);
    app.user("a@example.com", "A");
    let attempt = |ip: String| {
        let app = &app;
        async move {
            app.request_with(
                &app.anon(),
                "POST",
                "/api/auth/login",
                Some(json!({"email": "a@example.com", "password": "wrong password!"})),
                &[("x-forwarded-for", ip.as_str())],
                true,
                None,
            )
            .await
        }
    };
    for i in 0..10 {
        attempt(format!("2001:db8:1:2::{i:x}"))
            .await
            .assert_status(401);
    }
    attempt("2001:db8:1:2:ffff::1".into())
        .await
        .assert_status(429);
    // Another /64 has its own budget.
    attempt("2001:db8:1:3::1".into()).await.assert_status(401);
}
