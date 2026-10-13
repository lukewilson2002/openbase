//! The instance's SMTP relay cannot be used as a spam cannon: invites,
//! automation emails and password-reset mails are all rate limited.

mod automations_support;
mod common;
mod schema_support;

use std::time::Duration;

use automations_support::*;
use common::TestApp;
use serde_json::json;

fn mail_app(tweak: impl FnOnce(&mut opengrid::config::Config)) -> TestApp {
    TestApp::with_config(|c| {
        c.smtp_host = Some("smtp.test.invalid".into());
        tweak(c);
    })
}

async fn email_invite(app: &TestApp, by: &common::Client, ws: &str, n: usize) -> u16 {
    app.post(
        by,
        &format!("/api/workspaces/{ws}/invites"),
        json!({ "role": "viewer", "email": format!("guest{n}@example.com") }),
    )
    .await
    .status
    .as_u16()
}

#[tokio::test]
async fn invite_emails_are_limited_per_user_and_per_instance() {
    let app = mail_app(|c| {
        c.email_per_user_hour = 3;
        c.email_per_hour = 4;
    });
    let a = app.user("a@example.com", "A");
    let b = app.user("b@example.com", "B");
    let (ws_a, _) = app.workspace_with_base(&a, "A");
    let (ws_b, _) = app.workspace_with_base(&b, "B");
    for n in 0..3 {
        assert_eq!(email_invite(&app, &a, &ws_a, n).await, 201);
    }
    // Per-user budget spent.
    assert_eq!(email_invite(&app, &a, &ws_a, 3).await, 429);
    // Another user still has theirs, until the instance budget (4) is gone.
    assert_eq!(email_invite(&app, &b, &ws_b, 4).await, 201);
    assert_eq!(email_invite(&app, &b, &ws_b, 5).await, 429);
    // A refused invite is not created, and link-only invites send no email so
    // they are not limited by the email budget.
    assert_eq!(
        app.query_i64("SELECT count(*) FROM invites WHERE email IS NOT NULL", &[]),
        4
    );
    app.post(
        &a,
        &format!("/api/workspaces/{ws_a}/invites"),
        json!({"role": "viewer"}),
    )
    .await
    .assert_status(201);
    assert_eq!(app.mailer.wait_for(4).await.len(), 4);
}

#[tokio::test]
async fn automation_emails_count_every_recipient_against_the_budget() {
    let env = Env::with_config(|c| c.email_per_user_hour = 3).await;
    let email = json!([{ "type": "send_email",
        "to": "a@example.com, b@example.com", "subject": "s", "body": "b" }]);

    let first = env
        .create("first", env.trigger_created(), email.clone())
        .await;
    let second = env.create("second", env.trigger_created(), email).await;
    let rec = env.rec(json!({}));
    env.fire_created(&[&rec]);
    env.drain().await;

    let runs = [
        env.only_run(first["id"].as_str().unwrap()).await,
        env.only_run(second["id"].as_str().unwrap()).await,
    ];
    let statuses: Vec<&str> = runs.iter().map(|r| r["status"].as_str().unwrap()).collect();
    assert_eq!(
        statuses.iter().filter(|s| **s == "succeeded").count(),
        1,
        "{runs:#?}"
    );
    let failed = runs.iter().find(|r| r["status"] == "failed").unwrap();
    assert!(
        failed["error"].as_str().unwrap().contains("email limit"),
        "{failed:#}"
    );
    // Only the run that fit the budget sent anything (2 recipients).
    assert_eq!(env.f.app.mailer.sent().len(), 2);
}

#[tokio::test]
async fn password_reset_mails_to_one_address_are_limited() {
    let app = mail_app(|_| {});
    app.user("victim@example.com", "Victim");
    for _ in 0..5 {
        app.post(
            &app.anon(),
            "/api/auth/password-reset/request",
            json!({"email": "victim@example.com"}),
        )
        .await
        .assert_status(200);
    }
    assert_eq!(app.mailer.wait_for(3).await.len(), 3);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        app.mailer.sent().len(),
        3,
        "an address gets at most 3 reset mails an hour"
    );
}
