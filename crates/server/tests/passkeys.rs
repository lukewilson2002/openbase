//! Passkeys (WebAuthn sign-in): registering, listing, renaming and removing them, usernameless
//! sign-in, every way a sign-in can be refused, the 2FA rule, rate limits, admin removal and the
//! rule that none of it is reachable with a token.
//!
//! The authenticator is `passkey_support::Authenticator`, a software implementation that answers
//! in the exact JSON the web client sends. One test also runs webauthn-authenticator-rs'
//! independent `SoftPasskey` against the server.

mod common;
mod mcp_support;
mod oauth_support;
mod passkey_support;

use common::{Client, TestApp};
use passkey_support::*;
use serde_json::{Value, json};
use totp_rs::{Algorithm, Builder, Secret, Totp};

const PW: &str = "password1234";

fn app() -> TestApp {
    // Behind a proxy, so each test sign-in can come from its own address.
    TestApp::with_config(|c| c.trust_proxy = true)
}

async fn list(app: &TestApp, c: &Client) -> Vec<Value> {
    let res = app.get(c, "/api/auth/passkeys").await;
    res.assert_status(200);
    res.body.as_array().unwrap().clone()
}

fn age_sessions(app: &TestApp, minutes: i64) {
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "UPDATE sessions SET created_at = created_at - ?1",
                [minutes * 60_000],
            )?;
            Ok(())
        })
        .unwrap();
}

fn totp_for(secret_b32: &str) -> Totp {
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

async fn enable_2fa(app: &TestApp, user: &Client) -> String {
    let res = app.post(user, "/api/auth/2fa/setup", json!({})).await;
    res.assert_status(200);
    let secret = res.body["secret"].as_str().unwrap().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let code = totp_for(&secret).generate(now - 30).to_string();
    app.post(user, "/api/auth/2fa/enable", json!({ "code": code }))
        .await
        .assert_status(200);
    secret
}

// ----------------------------------------------------------------------------- managing them

#[tokio::test]
async fn register_list_rename_and_remove() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    assert!(list(&app, &ada).await.is_empty());

    let mut mac = Authenticator::new();
    mac.synced = true;
    let res = register(&app, &ada, &mut mac, "MacBook").await;
    res.assert_status(201);
    let id = res.body["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("pky"), "{id}");
    assert_eq!(res.body["name"], "MacBook");
    assert_eq!(res.body["transports"], json!(["internal"]));
    assert_eq!(res.body["backup_eligible"], true);
    assert_eq!(res.body["backup_state"], true);
    assert!(res.body["created_at"].as_i64().unwrap() > 0);
    assert!(res.body["last_used_at"].is_null());

    let mut key = Authenticator::new();
    key.transports = vec!["usb", "nfc", "bogus"];
    register(&app, &ada, &mut key, "Security key")
        .await
        .assert_status(201);

    let all = list(&app, &ada).await;
    assert_eq!(all.len(), 2);
    assert_eq!(all[0]["name"], "MacBook");
    assert_eq!(all[1]["name"], "Security key");
    assert_eq!(
        all[1]["transports"],
        json!(["usb", "nfc"]),
        "unknown transports are dropped"
    );
    assert_eq!(all[1]["backup_eligible"], false);
    // Only a description comes back: nothing that identifies or reconstructs the credential.
    let mut keys: Vec<&str> = all[0]
        .as_object()
        .unwrap()
        .keys()
        .map(|s| s.as_str())
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "backup_eligible",
            "backup_state",
            "created_at",
            "id",
            "last_used_at",
            "name",
            "transports"
        ]
    );
    let raw = serde_json::to_string(&all).unwrap();
    assert!(!raw.contains(&mac.credentials[0].id_b64()));

    // Rename.
    let res = app
        .patch(
            &ada,
            &format!("/api/auth/passkeys/{id}"),
            json!({"name": "  Work laptop  "}),
        )
        .await;
    res.assert_status(200);
    assert_eq!(res.body["name"], "Work laptop");
    app.patch(
        &ada,
        &format!("/api/auth/passkeys/{id}"),
        json!({"name": "x".repeat(101)}),
    )
    .await
    .assert_status(400);
    assert_eq!(list(&app, &ada).await[0]["name"], "Work laptop");

    // Remove: gone from the list and from the table; the other one stays.
    app.delete(&ada, &format!("/api/auth/passkeys/{id}"))
        .await
        .assert_status(204);
    assert_eq!(list(&app, &ada).await.len(), 1);
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 1);
    app.delete(&ada, &format!("/api/auth/passkeys/{id}"))
        .await
        .assert_status(404);
    app.patch(
        &ada,
        &format!("/api/auth/passkeys/{id}"),
        json!({"name": "again"}),
    )
    .await
    .assert_status(404);

    // The removed passkey can no longer sign in; the remaining one can.
    let res = sign_in(&app, &mut mac, 1).await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["code"], "invalid_passkey");
    sign_in(&app, &mut key, 2).await.assert_status(200);

    assert_eq!(
        audit_actions(&app)
            .into_iter()
            .filter(|a| a.starts_with("passkey"))
            .collect::<Vec<_>>(),
        [
            "passkey_add",
            "passkey_add",
            "passkey_rename",
            "passkey_remove",
            "passkey_login_failed",
            "passkey_login"
        ]
    );
    assert_eq!(
        last_audit(&app, "passkey_remove")["detail"]["name"],
        "Work laptop"
    );
    assert_eq!(
        last_audit(&app, "passkey_add")["target"]
            .as_str()
            .unwrap()
            .len(),
        17
    );
}

#[tokio::test]
async fn passkeys_belong_to_their_owner() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let bob = app.user("bob@example.com", "Bob");
    let mut phone = Authenticator::new();
    let id = register(&app, &ada, &mut phone, "Phone").await.body["id"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(list(&app, &bob).await.is_empty());
    app.patch(
        &bob,
        &format!("/api/auth/passkeys/{id}"),
        json!({"name": "mine"}),
    )
    .await
    .assert_status(404);
    app.delete(&bob, &format!("/api/auth/passkeys/{id}"))
        .await
        .assert_status(404);
    assert_eq!(list(&app, &ada).await[0]["name"], "Phone");
    // Signed out: nothing.
    app.get(&app.anon(), "/api/auth/passkeys")
        .await
        .assert_status(401);
    app.post(&app.anon(), "/api/auth/passkeys/register/start", json!({}))
        .await
        .assert_status(401);
}

#[tokio::test]
async fn a_passkey_without_a_name_is_called_passkey_and_a_bad_name_does_not_spend_the_challenge() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    let credential = dev.create(&start.body["options"]).unwrap();
    let finish = |name: Value| json!({"challenge_id": start.body["challenge_id"], "name": name, "credential": credential});
    app.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        finish(json!("x".repeat(101))),
    )
    .await
    .assert_status(400);
    // The same challenge still works with a good name.
    let res = app
        .post(
            &ada,
            "/api/auth/passkeys/register/finish",
            finish(json!("   ")),
        )
        .await;
    res.assert_status(201);
    assert_eq!(res.body["name"], "Passkey");
    // ... once.
    app.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        finish(json!("again")),
    )
    .await
    .assert_status(400);
}

#[tokio::test]
async fn the_options_ask_for_a_discoverable_credential_with_user_verification() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let res = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    res.assert_status(200);
    let pk = &res.body["options"]["publicKey"];
    assert_eq!(pk["rp"]["id"], "localhost");
    assert_eq!(pk["rp"]["name"], "OpenBase");
    assert_eq!(pk["user"]["name"], "ada@example.com");
    assert_eq!(pk["user"]["displayName"], "Ada");
    // The user handle is random, not the user id.
    let handle = pk["user"]["id"].as_str().unwrap();
    assert!(!handle.contains(ada.user_id.as_deref().unwrap()));
    assert_eq!(pk["authenticatorSelection"]["residentKey"], "required");
    assert_eq!(pk["authenticatorSelection"]["requireResidentKey"], true);
    assert_eq!(pk["authenticatorSelection"]["userVerification"], "required");
    assert_eq!(pk["attestation"], "none");
    // The same account always gets the same handle.
    let again = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    assert_eq!(
        again.body["options"]["publicKey"]["user"]["id"],
        pk["user"]["id"]
    );
    assert_ne!(
        again.body["options"]["publicKey"]["challenge"], pk["challenge"],
        "a fresh challenge every time"
    );
    let bob = app.user("bob@example.com", "Bob");
    let other = app
        .post(&bob, "/api/auth/passkeys/register/start", json!({}))
        .await;
    assert_ne!(
        other.body["options"]["publicKey"]["user"]["id"],
        pk["user"]["id"]
    );
}

#[tokio::test]
async fn the_same_authenticator_is_not_offered_twice_and_a_credential_registers_once() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "First")
        .await
        .assert_status(201);
    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    assert_eq!(
        start.body["options"]["publicKey"]["excludeCredentials"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let refused = dev.create(&start.body["options"]).unwrap_err();
    assert!(refused.starts_with("InvalidStateError"), "{refused}");

    // A different account on the same device gets a different user handle, so the device would
    // make a second credential; replaying the first credential's registration is refused by the
    // unique credential id.
    let mut fresh = Authenticator::new();
    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    let credential = fresh.create(&start.body["options"]).unwrap();
    let body = |challenge: &Value| json!({"challenge_id": challenge, "name": "Second", "credential": credential});
    app.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        body(&start.body["challenge_id"]),
    )
    .await
    .assert_status(201);
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 2);
}

#[tokio::test]
async fn an_account_holds_at_most_twenty_passkeys() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    for n in 0..20 {
        let mut dev = Authenticator::new();
        register(&app, &ada, &mut dev, &format!("Key {n}"))
            .await
            .assert_status(201);
    }
    let res = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    res.assert_status(409);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("at most 20")
    );
    assert_eq!(list(&app, &ada).await.len(), 20);
}

// ------------------------------------------------------------------------------- re-auth

#[tokio::test]
async fn registering_needs_a_recent_sign_in_or_the_password() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    // Just signed in: no password needed.
    app.post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await
        .assert_status(200);

    // An older session must prove it is the owner.
    age_sessions(&app, 11);
    let res = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    res.assert_status(403);
    assert_eq!(res.body["error"]["code"], "reauth_required");
    // An empty password is no password.
    app.post(
        &ada,
        "/api/auth/passkeys/register/start",
        json!({"password": ""}),
    )
    .await
    .assert_status(403);
    let res = app
        .post(
            &ada,
            "/api/auth/passkeys/register/start",
            json!({"password": "not the password"}),
        )
        .await;
    res.assert_status(403);
    assert_eq!(res.body["error"]["code"], "forbidden");
    let res = app
        .post(
            &ada,
            "/api/auth/passkeys/register/start",
            json!({"password": PW}),
        )
        .await;
    res.assert_status(200);

    // The whole ceremony with the password, from an old session.
    let mut dev = Authenticator::new();
    let credential = dev.create(&res.body["options"]).unwrap();
    app.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        json!({"challenge_id": res.body["challenge_id"], "name": "Late", "credential": credential}),
    )
    .await
    .assert_status(201);

    // Nothing else needs the password: rename and remove work for an old session.
    let id = list(&app, &ada).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    app.patch(
        &ada,
        &format!("/api/auth/passkeys/{id}"),
        json!({"name": "Renamed"}),
    )
    .await
    .assert_status(200);
    app.delete(&ada, &format!("/api/auth/passkeys/{id}"))
        .await
        .assert_status(204);
}

#[tokio::test]
async fn password_guesses_for_registering_are_limited() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    age_sessions(&app, 60);
    for _ in 0..10 {
        app.post(
            &ada,
            "/api/auth/passkeys/register/start",
            json!({"password": "wrong password"}),
        )
        .await
        .assert_status(403);
    }
    // Over the limit even the right password waits.
    app.post(
        &ada,
        "/api/auth/passkeys/register/start",
        json!({"password": PW}),
    )
    .await
    .assert_status(429);
}

#[tokio::test]
async fn a_registration_can_only_be_finished_by_the_session_that_started_it() {
    let app = app();
    let first = app.user("ada@example.com", "Ada");
    let (_, second) = app.login("ada@example.com", PW).await;
    let start = app
        .post(&first, "/api/auth/passkeys/register/start", json!({}))
        .await;
    let mut dev = Authenticator::new();
    let credential = dev.create(&start.body["options"]).unwrap();
    let body = json!({"challenge_id": start.body["challenge_id"], "credential": credential});
    app.post(&second, "/api/auth/passkeys/register/finish", body.clone())
        .await
        .assert_status(400);
    // Spent by the wrong try.
    app.post(&first, "/api/auth/passkeys/register/finish", body)
        .await
        .assert_status(400);
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 0);

    // Another user cannot finish it either.
    let bob = app.user("bob@example.com", "Bob");
    let start = app
        .post(&first, "/api/auth/passkeys/register/start", json!({}))
        .await;
    let mut dev = Authenticator::new();
    let credential = dev.create(&start.body["options"]).unwrap();
    app.post(
        &bob,
        "/api/auth/passkeys/register/finish",
        json!({"challenge_id": start.body["challenge_id"], "credential": credential}),
    )
    .await
    .assert_status(400);
}

#[tokio::test]
async fn a_registration_for_another_origin_or_with_a_bad_response_is_refused() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    // A page on another origin (same host, other port) cannot register.
    let mut evil = Authenticator::on("http://localhost:9999");
    let res = register(&app, &ada, &mut evil, "Wrong origin").await;
    res.assert_status(400);

    // Garbage is a 400, not a 500.
    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    app.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        json!({"challenge_id": start.body["challenge_id"], "credential": {"nonsense": true}}),
    )
    .await
    .assert_status(400);

    // The browser saying the credential is not discoverable gets a helpful answer.
    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    let mut dev = Authenticator::new();
    let mut credential = dev.create(&start.body["options"]).unwrap();
    credential["clientExtensionResults"]["credProps"]["rk"] = json!(false);
    let res = app
        .post(
            &ada,
            "/api/auth/passkeys/register/finish",
            json!({"challenge_id": start.body["challenge_id"], "credential": credential}),
        )
        .await;
    res.assert_status(400);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("without a username")
    );
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 0);

    // Without user verification the registration is refused (the options required it).
    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    let mut lax = Authenticator::new();
    lax.user_verified = false;
    let credential = lax.create(&start.body["options"]).unwrap();
    app.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        json!({"challenge_id": start.body["challenge_id"], "credential": credential}),
    )
    .await
    .assert_status(400);
}

// ---------------------------------------------------------------------------------- signing in

#[tokio::test]
async fn a_usernameless_sign_in_creates_a_full_session() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "Laptop")
        .await
        .assert_status(201);

    let start = login_start(&app, 1).await;
    start.assert_status(200);
    let pk = &start.body["options"]["publicKey"];
    assert_eq!(pk["rpId"], "localhost");
    assert_eq!(pk["userVerification"], "required");
    assert_eq!(pk["allowCredentials"], json!([]), "no account is named");
    assert!(
        start.body["challenge_id"]
            .as_str()
            .unwrap()
            .starts_with("pkc_")
    );

    let credential = dev.get(&start.body["options"]).unwrap();
    let res = login_finish(&app, 1, &start.body["challenge_id"], &credential).await;
    res.assert_status(200);
    assert_eq!(res.body["user"]["email"], "ada@example.com");
    assert_eq!(res.body["two_factor_required"], false);
    let cookie = res.session_cookie().expect("a session cookie");

    // The session is a normal, complete one.
    let signed_in = Client {
        cookie: Some(cookie),
        bearer: None,
        user_id: ada.user_id.clone(),
    };
    let me = app.get(&signed_in, "/api/auth/me").await;
    me.assert_status(200);
    assert_eq!(me.body["email"], "ada@example.com");
    assert_eq!(
        app.query_i64("SELECT count(*) FROM sessions WHERE pending_2fa = 1", &[]),
        0
    );
    let used = list(&app, &ada).await;
    assert!(used[0]["last_used_at"].as_i64().unwrap() > 0);
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM users WHERE last_login_at IS NOT NULL",
            &[]
        ),
        1
    );
    let audit = last_audit(&app, "passkey_login");
    assert_eq!(audit["user_id"].as_str(), ada.user_id.as_deref());
    assert_eq!(audit["detail"]["name"], "Laptop");

    // The stored signature counter moved.
    let stored: String = app
        .state
        .db
        .write_sync(|tx| Ok(tx.query_row("SELECT credential FROM passkeys", [], |r| r.get(0))?))
        .unwrap();
    let v: Value = serde_json::from_str(&stored).unwrap();
    assert_eq!(v["cred"]["counter"], 1);
}

#[tokio::test]
async fn with_several_accounts_the_credential_decides_who_signs_in() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let bob = app.user("bob@example.com", "Bob");
    let mut ada_dev = Authenticator::new();
    let mut bob_dev = Authenticator::new();
    register(&app, &ada, &mut ada_dev, "Ada's")
        .await
        .assert_status(201);
    register(&app, &bob, &mut bob_dev, "Bob's")
        .await
        .assert_status(201);
    let res = sign_in(&app, &mut bob_dev, 1).await;
    res.assert_status(200);
    assert_eq!(res.body["user"]["email"], "bob@example.com");
    let res = sign_in(&app, &mut ada_dev, 2).await;
    assert_eq!(res.body["user"]["email"], "ada@example.com");

    // One authenticator holding both accounts' passkeys (a shared device): the person picks.
    let mut shared = Authenticator::new();
    register(&app, &ada, &mut shared, "Ada on shared")
        .await
        .assert_status(201);
    register(&app, &bob, &mut shared, "Bob on shared")
        .await
        .assert_status(201);
    assert_eq!(shared.credentials.len(), 2);
    let pick = shared.credentials[1].id.clone();
    let start = login_start(&app, 3).await;
    let credential = shared
        .get_with(&start.body["options"], Some(&pick))
        .unwrap();
    let res = login_finish(&app, 3, &start.body["challenge_id"], &credential).await;
    assert_eq!(res.body["user"]["email"], "bob@example.com");
}

#[tokio::test]
async fn an_unknown_credential_is_refused_like_a_wrong_signature() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut known = Authenticator::new();
    register(&app, &ada, &mut known, "Laptop")
        .await
        .assert_status(201);

    // A passkey the server never saw (created, never finished).
    let mut stranger = Authenticator::new();
    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    stranger.create(&start.body["options"]).unwrap();
    let res = sign_in(&app, &mut stranger, 1).await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["code"], "invalid_passkey");
    let unknown_message = res.body["error"]["message"].clone();
    assert_eq!(
        last_audit(&app, "passkey_login_failed")["detail"]["reason"],
        "unknown_credential"
    );

    // A known credential with a broken signature gets the same answer.
    let start = login_start(&app, 2).await;
    let mut credential = known.get(&start.body["options"]).unwrap();
    let sig = credential["response"]["signature"]
        .as_str()
        .unwrap()
        .to_string();
    let mut bytes = base64_decode(&sig);
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    credential["response"]["signature"] = json!(base64_encode(&bytes));
    let res = login_finish(&app, 2, &start.body["challenge_id"], &credential).await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["message"], unknown_message);
    let failed = last_audit(&app, "passkey_login_failed");
    assert_eq!(failed["detail"]["reason"], "invalid_response");
    assert_eq!(failed["user_id"].as_str(), ada.user_id.as_deref());

    // And the real one still signs in afterwards.
    sign_in(&app, &mut known, 3).await.assert_status(200);
    assert_eq!(
        audit_actions(&app)
            .iter()
            .filter(|a| *a == "passkey_login_failed")
            .count(),
        2
    );
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .unwrap()
}

fn base64_encode(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

#[tokio::test]
async fn a_sign_in_must_match_the_challenge_the_origin_and_user_verification() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "Laptop")
        .await
        .assert_status(201);

    // Signed for another challenge.
    let first = login_start(&app, 1).await;
    let second = login_start(&app, 1).await;
    let credential = dev.get(&first.body["options"]).unwrap();
    login_finish(&app, 1, &second.body["challenge_id"], &credential)
        .await
        .assert_status(401);

    // From another origin: the browser there would sign its own origin into clientDataJSON.
    let start = login_start(&app, 2).await;
    let mut other_origin = Authenticator::on("http://localhost:9999");
    other_origin.credentials.push(passkey_support_clone(&dev));
    let credential = other_origin.get(&start.body["options"]).unwrap();
    let res = login_finish(&app, 2, &start.body["challenge_id"], &credential).await;
    res.assert_status(401);

    // User verification missing from what the authenticator signed.
    let start = login_start(&app, 3).await;
    dev.user_verified = false;
    let credential = dev.get(&start.body["options"]).unwrap();
    let res = login_finish(&app, 3, &start.body["challenge_id"], &credential).await;
    res.assert_status(401);
    dev.user_verified = true;

    // A challenge is good for one attempt: replaying a good answer fails.
    let start = login_start(&app, 4).await;
    let credential = dev.get(&start.body["options"]).unwrap();
    login_finish(&app, 4, &start.body["challenge_id"], &credential)
        .await
        .assert_status(200);
    let replay = login_finish(&app, 4, &start.body["challenge_id"], &credential).await;
    replay.assert_status(401);
    assert_eq!(replay.body["error"]["code"], "passkey_expired");
    // A made-up challenge id too.
    let res = login_finish(&app, 4, &json!("pkc_nope"), &credential).await;
    assert_eq!(res.body["error"]["code"], "passkey_expired");
}

/// A copy of the authenticator's first credential (the same key on a page of another origin).
fn passkey_support_clone(a: &Authenticator) -> passkey_support::Credential {
    a.clone_first_credential()
}

#[tokio::test]
async fn a_response_without_a_user_handle_or_with_someone_elses_is_refused() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let bob = app.user("bob@example.com", "Bob");
    let mut ada_dev = Authenticator::new();
    let mut bob_dev = Authenticator::new();
    register(&app, &ada, &mut ada_dev, "A")
        .await
        .assert_status(201);
    register(&app, &bob, &mut bob_dev, "B")
        .await
        .assert_status(201);

    // No user handle: the sign-in cannot say whose it is.
    ada_dev.send_user_handle = false;
    let start = login_start(&app, 1).await;
    let credential = ada_dev.get(&start.body["options"]).unwrap();
    login_finish(&app, 1, &start.body["challenge_id"], &credential)
        .await
        .assert_status(400);

    // Ada's credential claiming to be Bob's: the handle does not belong to the credential.
    ada_dev.send_user_handle = true;
    ada_dev.credentials[0].user_handle = bob_dev.credentials[0].user_handle.clone();
    let res = sign_in(&app, &mut ada_dev, 2).await;
    res.assert_status(401);
    assert_eq!(
        last_audit(&app, "passkey_login_failed")["detail"]["reason"],
        "unknown_credential"
    );
}

#[tokio::test]
async fn a_signature_counter_that_does_not_increase_is_refused_as_a_possible_clone() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "Laptop")
        .await
        .assert_status(201);
    sign_in(&app, &mut dev, 1).await.assert_status(200); // counter 1
    sign_in(&app, &mut dev, 2).await.assert_status(200); // counter 2

    // A clone that signed less often: its counter is behind.
    dev.set_counter(0, 2);
    let res = sign_in(&app, &mut dev, 3).await;
    res.assert_status(401);
    assert_eq!(res.body["error"]["code"], "invalid_passkey");
    let failed = last_audit(&app, "passkey_login_failed");
    assert_eq!(failed["detail"]["reason"], "counter_regression");
    assert_eq!(failed["user_id"].as_str(), ada.user_id.as_deref());
    assert_eq!(
        failed["target"].as_str().unwrap().len(),
        17,
        "names the passkey"
    );
    // An equal counter is refused too.
    dev.set_counter(0, 2);
    sign_in(&app, &mut dev, 4).await.assert_status(401);

    // The stored counter was not lowered, and the real device (ahead of the clone) works again.
    dev.set_counter(0, 3);
    sign_in(&app, &mut dev, 5).await.assert_status(200);
    let stored: String = app
        .state
        .db
        .write_sync(|tx| Ok(tx.query_row("SELECT credential FROM passkeys", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stored).unwrap()["cred"]["counter"],
        3
    );
}

#[tokio::test]
async fn a_deactivated_user_cannot_sign_in_with_a_passkey() {
    let app = app();
    let admin = app.admin("root@example.com", "Root");
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "Laptop")
        .await
        .assert_status(201);

    app.patch(
        &admin,
        &format!("/api/admin/users/{}", ada.user_id.as_deref().unwrap()),
        json!({"is_active": false}),
    )
    .await
    .assert_status(200);
    let res = sign_in(&app, &mut dev, 1).await;
    res.assert_status(403);
    assert!(
        res.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("deactivated")
    );
    assert!(res.session_cookie().is_none());
    assert_eq!(
        last_audit(&app, "passkey_login_failed")["detail"]["reason"],
        "deactivated"
    );
    assert_eq!(
        app.query_i64("SELECT count(*) FROM sessions", &[]),
        1,
        "only the admin's"
    );

    // Reactivated: the passkey works again.
    app.patch(
        &admin,
        &format!("/api/admin/users/{}", ada.user_id.as_deref().unwrap()),
        json!({"is_active": true}),
    )
    .await
    .assert_status(200);
    sign_in(&app, &mut dev, 2).await.assert_status(200);
}

#[tokio::test]
async fn a_passkey_sign_in_skips_two_factor_but_a_password_sign_in_still_needs_it() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "Laptop")
        .await
        .assert_status(201);
    enable_2fa(&app, &ada).await;

    // Password: only a pending session until the code is given.
    let (res, pending) = app.login("ada@example.com", PW).await;
    assert_eq!(res.body["two_factor_required"], true);
    assert!(res.body["user"].is_null());
    app.get(&pending, "/api/auth/me").await.assert_status(401);

    // Passkey: signed in, no code, no pending session.
    let res = sign_in(&app, &mut dev, 1).await;
    res.assert_status(200);
    assert_eq!(res.body["two_factor_required"], false);
    assert_eq!(res.body["user"]["totp_enabled"], true);
    let signed_in = Client {
        cookie: res.session_cookie(),
        bearer: None,
        user_id: ada.user_id.clone(),
    };
    app.get(&signed_in, "/api/auth/me").await.assert_status(200);
    // ... and it is a full session: it can see the sessions list, which a pending one cannot.
    app.get(&signed_in, "/api/auth/sessions")
        .await
        .assert_status(200);
}

#[tokio::test]
async fn passwords_keep_working_and_a_password_change_keeps_passkeys() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "Laptop")
        .await
        .assert_status(201);
    let (res, _) = app.login("ada@example.com", PW).await;
    res.assert_status(200);

    app.post(
        &ada,
        "/api/auth/password",
        json!({"current_password": PW, "new_password": "another password 1"}),
    )
    .await
    .assert_status(200);
    assert_eq!(
        list(&app, &ada).await.len(),
        1,
        "passkeys are separate credentials"
    );
    sign_in(&app, &mut dev, 1).await.assert_status(200);
    let (res, _) = app.login("ada@example.com", "another password 1").await;
    res.assert_status(200);

    // A reset link changes the password and leaves the passkey too.
    let admin = app.admin("root@example.com", "Root");
    let link = app
        .post(
            &admin,
            &format!(
                "/api/admin/users/{}/reset-link",
                ada.user_id.as_deref().unwrap()
            ),
            json!({}),
        )
        .await;
    let token = link.body["url"]
        .as_str()
        .unwrap()
        .rsplit('=')
        .next()
        .unwrap()
        .to_string();
    app.post(
        &app.anon(),
        "/api/auth/password-reset/confirm",
        json!({"token": token, "new_password": "a third password 3"}),
    )
    .await
    .assert_status(200);
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 1);
    sign_in(&app, &mut dev, 2).await.assert_status(200);
}

// -------------------------------------------------------------------------------- rate limits

#[tokio::test]
async fn sign_in_attempts_are_limited_per_address_and_other_addresses_are_unaffected() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let mut dev = Authenticator::new();
    register(&app, &ada, &mut dev, "Laptop")
        .await
        .assert_status(201);

    // Ten attempts a minute from one address, however they end.
    let ip = 7;
    for _ in 0..10 {
        let res = login_finish(&app, ip, &json!("pkc_nope"), &json!({})).await;
        res.assert_status(401);
    }
    let res = login_finish(&app, ip, &json!("pkc_nope"), &json!({})).await;
    res.assert_status(429);
    // Even a good answer waits, and it was not consumed by the refusal.
    let start = login_start(&app, 8).await;
    let credential = dev.get(&start.body["options"]).unwrap();
    login_finish(&app, ip, &start.body["challenge_id"], &credential)
        .await
        .assert_status(429);
    // Another address signs in with the same challenge.
    login_finish(&app, 8, &start.body["challenge_id"], &credential)
        .await
        .assert_status(200);

    // Asking for challenges is limited too, more generously.
    for _ in 0..30 {
        login_start(&app, 9).await.assert_status(200);
    }
    login_start(&app, 9).await.assert_status(429);
    login_start(&app, 10).await.assert_status(200);
}

#[tokio::test]
async fn managing_passkeys_is_rate_limited_per_user() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let bob = app.user("bob@example.com", "Bob");
    for _ in 0..60 {
        app.post(&ada, "/api/auth/passkeys/register/start", json!({}))
            .await
            .assert_status(200);
    }
    app.post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await
        .assert_status(429);
    app.post(&bob, "/api/auth/passkeys/register/start", json!({}))
        .await
        .assert_status(200);
}

// ----------------------------------------------------------------------------- admin removal

#[tokio::test]
async fn an_administrator_removes_all_of_a_users_passkeys() {
    let app = app();
    let admin = app.admin("root@example.com", "Root");
    let ada = app.user("ada@example.com", "Ada");
    let bob = app.user("bob@example.com", "Bob");
    let mut phone = Authenticator::new();
    let mut key = Authenticator::new();
    let mut bobs = Authenticator::new();
    register(&app, &ada, &mut phone, "Phone")
        .await
        .assert_status(201);
    register(&app, &ada, &mut key, "Key")
        .await
        .assert_status(201);
    register(&app, &bob, &mut bobs, "Bob's")
        .await
        .assert_status(201);

    let users = app.get(&admin, "/api/admin/users").await;
    let count_of = |email: &str| {
        users
            .body
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["email"] == email)
            .unwrap()["passkey_count"]
            .as_i64()
            .unwrap()
    };
    assert_eq!(count_of("ada@example.com"), 2);
    assert_eq!(count_of("bob@example.com"), 1);
    assert_eq!(count_of("root@example.com"), 0);

    // Not for ordinary users, not for anonymous callers.
    let path = format!(
        "/api/admin/users/{}/passkeys",
        ada.user_id.as_deref().unwrap()
    );
    app.delete(&bob, &path).await.assert_status(403);
    app.delete(&app.anon(), &path).await.assert_status(401);
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 3);

    let res = app.delete(&admin, &path).await;
    res.assert_status(200);
    assert_eq!(res.body, json!({"removed": 2}));
    assert!(list(&app, &ada).await.is_empty());
    assert_eq!(list(&app, &bob).await.len(), 1, "other users keep theirs");
    let audit = last_audit(&app, "admin_passkeys_remove");
    assert_eq!(audit["user_id"].as_str(), admin.user_id.as_deref());
    assert_eq!(audit["target"].as_str(), ada.user_id.as_deref());
    assert_eq!(audit["detail"]["removed"], 2);

    // The user's passkeys no longer sign in; their password does; they can register again.
    sign_in(&app, &mut phone, 1).await.assert_status(401);
    let (res, _) = app.login("ada@example.com", PW).await;
    res.assert_status(200);
    let mut new_phone = Authenticator::new();
    register(&app, &ada, &mut new_phone, "New phone")
        .await
        .assert_status(201);
    sign_in(&app, &mut new_phone, 2).await.assert_status(200);

    // Removing none is fine; an unknown user is a 404.
    let res = app
        .delete(
            &admin,
            &format!(
                "/api/admin/users/{}/passkeys",
                admin.user_id.as_deref().unwrap()
            ),
        )
        .await;
    assert_eq!(res.body, json!({"removed": 0}));
    app.delete(&admin, "/api/admin/users/usrNope/passkeys")
        .await
        .assert_status(404);
}

#[tokio::test]
async fn deleting_a_user_deletes_their_passkeys_and_handle() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let bob = app.user("bob@example.com", "Bob");
    let mut a = Authenticator::new();
    let mut b = Authenticator::new();
    register(&app, &ada, &mut a, "A").await.assert_status(201);
    register(&app, &bob, &mut b, "B").await.assert_status(201);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM passkey_user_handles", &[]),
        2
    );
    app.state
        .db
        .write_sync(|tx| {
            tx.execute("DELETE FROM users WHERE email = 'ada@example.com'", [])?;
            Ok(())
        })
        .unwrap();
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 1);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM passkey_user_handles", &[]),
        1
    );
    sign_in(&app, &mut a, 1).await.assert_status(401);
    sign_in(&app, &mut b, 2).await.assert_status(200);
}

// ------------------------------------------------------------------------------- availability

#[tokio::test]
async fn setup_says_whether_passkeys_work_here() {
    let app = app();
    let res = app.get(&app.anon(), "/api/setup").await;
    assert_eq!(res.body["passkeys_enabled"], true);

    // An IP address cannot be a WebAuthn relying party.
    let ip = TestApp::with_config(|c| c.public_url = "http://127.0.0.1:8080".into());
    let res = ip.get(&ip.anon(), "/api/setup").await;
    assert_eq!(res.body["passkeys_enabled"], false);
    let ada = ip.user("ada@example.com", "Ada");
    for (method, path, body) in [
        ("POST", "/api/auth/passkeys/register/start", json!({})),
        ("POST", "/api/auth/passkey-login/start", json!({})),
    ] {
        let res = ip.request(&ada, method, path, Some(body)).await;
        res.assert_status(400);
        assert!(
            res.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("domain name"),
            "{}",
            res.body
        );
    }
    assert!(list(&ip, &ada).await.is_empty());

    // A real domain works over https too.
    let prod = TestApp::with_config(|c| c.public_url = "https://base.example.com".into());
    let ada = prod.user("ada@example.com", "Ada");
    let start = prod
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    assert_eq!(
        start.body["options"]["publicKey"]["rp"]["id"],
        "base.example.com"
    );
    let mut dev = Authenticator::on("https://base.example.com");
    let credential = dev.create(&start.body["options"]).unwrap();
    prod.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        json!({"challenge_id": start.body["challenge_id"], "credential": credential}),
    )
    .await
    .assert_status(201);
}

#[tokio::test]
async fn the_csrf_header_is_required_with_a_session_cookie() {
    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let res = app
        .request_with(
            &ada,
            "POST",
            "/api/auth/passkeys/register/start",
            Some(json!({})),
            &[],
            false,
            None,
        )
        .await;
    res.assert_status(403);
    assert_eq!(res.body["error"]["message"], "missing CSRF header");
}

// ------------------------------------------------------------------------- tokens never do this

/// Every passkey management route, as (method, path template, concrete path, body).
const MANAGEMENT: &[(&str, &str, &str, Option<&str>)] = &[
    ("GET", "/api/auth/passkeys", "/api/auth/passkeys", None),
    (
        "POST",
        "/api/auth/passkeys/register/start",
        "/api/auth/passkeys/register/start",
        Some(r#"{"password":"password1234"}"#),
    ),
    (
        "POST",
        "/api/auth/passkeys/register/finish",
        "/api/auth/passkeys/register/finish",
        Some(r#"{"challenge_id":"pkc_x","credential":{}}"#),
    ),
    (
        "PATCH",
        "/api/auth/passkeys/{id}",
        "/api/auth/passkeys/pkyNope",
        Some(r#"{"name":"x"}"#),
    ),
    (
        "DELETE",
        "/api/auth/passkeys/{id}",
        "/api/auth/passkeys/pkyNope",
        None,
    ),
];

#[tokio::test]
async fn no_token_of_any_kind_can_manage_passkeys() {
    let app = app();
    let admin = app.admin("root@example.com", "Root");
    let mut dev = Authenticator::new();
    register(&app, &admin, &mut dev, "Laptop")
        .await
        .assert_status(201);
    let id = list(&app, &admin).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let admin_path = format!(
        "/api/admin/users/{}/passkeys",
        admin.user_id.as_deref().unwrap()
    );

    let manage = app
        .api_token(&admin, json!({"name": "m", "write": true, "manage": true}))
        .await;
    let write = app
        .api_token(&admin, json!({"name": "w", "write": true}))
        .await;
    let read = app
        .api_token(&admin, json!({"name": "r", "write": false}))
        .await;
    let (_, base) = app.workspace_with_base(&admin, "Acme");
    let limited = app
        .api_token(
            &admin,
            json!({"name": "l", "write": true, "manage": true, "base_ids": [base]}),
        )
        .await;

    let mut routes: Vec<(String, String, Option<Value>)> = MANAGEMENT
        .iter()
        .map(|(m, _, p, b)| {
            (
                m.to_string(),
                p.replace("pkyNope", &id),
                b.map(|b| serde_json::from_str(b).unwrap()),
            )
        })
        .collect();
    routes.push(("DELETE".into(), admin_path.clone(), None));
    for (label, token) in [
        ("manage", &manage),
        ("write", &write),
        ("read-only", &read),
        ("base-limited manage", &limited),
    ] {
        for (method, path, body) in &routes {
            let res = app.request(token, method, path, body.clone()).await;
            assert_eq!(
                res.status.as_u16(),
                403,
                "{label} token on {method} {path}: {}",
                res.body
            );
            // (A read-only token is turned away even earlier, for any state-changing request.)
            let expected = if label == "read-only" && method.as_str() != "GET" {
                "read-only"
            } else {
                "API tokens can never use this endpoint"
            };
            assert!(
                res.body["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(expected),
                "{label} {method} {path}: {}",
                res.body
            );
        }
    }
    // Nothing changed.
    assert_eq!(list(&app, &admin).await.len(), 1);
    assert_eq!(app.query_i64("SELECT count(*) FROM passkeys", &[]), 1);
    assert_eq!(
        app.query_i64("SELECT count(*) FROM passkey_user_handles", &[]),
        1
    );
    assert_eq!(
        app.query_i64(
            "SELECT count(*) FROM audit_log WHERE action LIKE '%passkey%'",
            &[]
        ),
        1
    );
}

#[tokio::test]
async fn mcp_api_request_and_oauth_grants_cannot_manage_passkeys_either() {
    let app = app();
    let admin = app.admin("root@example.com", "Root");
    let mut dev = Authenticator::new();
    register(&app, &admin, &mut dev, "Laptop")
        .await
        .assert_status(201);
    let id = list(&app, &admin).await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let manage = app
        .api_token(&admin, json!({"name": "m", "write": true, "manage": true}))
        .await;
    let granted = oauth_support::connect(&app, &admin, "Agent", "manage", None).await;
    let oauth = granted.bearer();

    let mut routes: Vec<(&str, String, Option<Value>)> = MANAGEMENT
        .iter()
        .map(|(m, _, p, b)| {
            (
                *m,
                p.replace("pkyNope", &id),
                b.map(|b| serde_json::from_str(b).unwrap()),
            )
        })
        .collect();
    routes.push((
        "DELETE",
        format!(
            "/api/admin/users/{}/passkeys",
            admin.user_id.as_deref().unwrap()
        ),
        None,
    ));
    // The sign-in flows are not for agents either.
    routes.push((
        "POST",
        "/api/auth/passkey-login/start".into(),
        Some(json!({})),
    ));
    routes.push((
        "POST",
        "/api/auth/passkey-login/finish".into(),
        Some(json!({"challenge_id": "pkc_x", "credential": {}})),
    ));
    for (who, client) in [("manage token", &manage), ("OAuth grant", &oauth)] {
        for (method, path, body) in &routes {
            let mut args = json!({"method": method, "path": path});
            if let Some(b) = body {
                args["body"] = b.clone();
            }
            let res = mcp_support::tool(&app, client, "api_request", args).await;
            assert!(
                res.is_error,
                "{who}: {method} {path} must be refused: {}",
                res.text
            );
            assert!(
                res.text.contains("not available through MCP"),
                "{who}: {method} {path}: {}",
                res.text
            );
        }
    }

    // Defence in depth: should a request reach the router in process as the grant (as
    // `api_request` sends them), the router itself refuses.
    use tower::ServiceExt;
    let access = granted.access.clone();
    let (actor, _) = app
        .state
        .db
        .write_sync(move |tx| {
            openbase::auth::lookup_oauth_token(tx, &access, "http://localhost:8080/mcp")
        })
        .unwrap()
        .expect("a valid grant");
    let trusted = openbase::auth::TrustedActor(actor);
    for (method, path, body) in &routes[..6] {
        let mut req = axum::http::Request::builder()
            .method(*method)
            .uri(path.as_str())
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                body.clone().unwrap_or(json!({})).to_string(),
            ))
            .unwrap();
        req.extensions_mut().insert(trusted.clone());
        let res = app.router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), 403, "{method} {path}");
    }
    assert_eq!(list(&app, &admin).await.len(), 1);
}

// ----------------------------------------------------------------------- independent client

/// webauthn-authenticator-rs' SoftPasskey is written independently of this server and of the
/// authenticator in `passkey_support`: whatever the server expects, it must also accept from a
/// second implementation. SoftPasskey cannot hold discoverable credentials, so the sign-in names
/// the credential and the user handle is added the way a browser would.
#[tokio::test]
async fn an_independent_authenticator_registers_and_signs_in() {
    use webauthn_authenticator_rs::WebauthnAuthenticator;
    use webauthn_authenticator_rs::softpasskey::SoftPasskey;
    use webauthn_rs::prelude::{
        CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
        RequestChallengeResponse, Url,
    };

    let app = app();
    let ada = app.user("ada@example.com", "Ada");
    let origin = Url::parse(ORIGIN).unwrap();
    let mut soft = SoftPasskey::new(true);

    let start = app
        .post(&ada, "/api/auth/passkeys/register/start", json!({}))
        .await;
    let mut options: CreationChallengeResponse =
        serde_json::from_value(start.body["options"].clone()).unwrap();
    // SoftPasskey cannot hold discoverable credentials; relax that one request for it.
    if let Some(sel) = options.public_key.authenticator_selection.as_mut() {
        sel.require_resident_key = false;
    }
    let handle = options.public_key.user.id.clone();
    let registered: RegisterPublicKeyCredential = soft
        .do_registration(origin.clone(), options)
        .expect("SoftPasskey registers");
    let credential_id = registered.raw_id.clone();
    app.post(
        &ada,
        "/api/auth/passkeys/register/finish",
        json!({
            "challenge_id": start.body["challenge_id"],
            "name": "Soft",
            "credential": serde_json::to_value(&registered).unwrap(),
        }),
    )
    .await
    .assert_status(201);

    let start = login_start(&app, 1).await;
    let mut request: RequestChallengeResponse =
        serde_json::from_value(start.body["options"].clone()).unwrap();
    request.public_key.allow_credentials = vec![
        serde_json::from_value(json!({
            "type": "public-key",
            "id": base64_encode(&credential_id),
        }))
        .unwrap(),
    ];
    let mut asserted: PublicKeyCredential = soft
        .do_authentication(origin, request)
        .expect("SoftPasskey signs");
    asserted.response.user_handle = Some(handle);
    let res = login_finish(
        &app,
        1,
        &start.body["challenge_id"],
        &serde_json::to_value(&asserted).unwrap(),
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["user"]["email"], "ada@example.com");
}
