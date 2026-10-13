//! The email settings tools for an administrator's `manage` token: read, change without ever
//! touching the password, and send a test email that reports the real error.

mod common;
mod mcp_support;

use mcp_support::*;
use openbase::email::{RawSmtp, smtp_factory};
use serde_json::json;

const SECRET: &str = "S3cr3t-smtp-pa55word!";

#[tokio::test]
async fn an_agent_reads_and_changes_the_email_settings_but_not_the_password() {
    let r = Rig::new().await;
    let a = &r.agent;
    let tools = a.tool_names().await;
    for t in [
        "admin_get_email_settings",
        "admin_update_email_settings",
        "admin_send_test_email",
    ] {
        assert!(tools.contains(&t.to_string()), "{t}");
    }

    // the tool has no password argument at all
    let (_, body) = a.rpc("tools/list", json!({})).await;
    let update = body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "admin_update_email_settings")
        .unwrap()
        .clone();
    let props: Vec<&str> = update["inputSchema"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(props, ["from", "host", "port", "security", "username"]);
    assert!(update["description"].as_str().unwrap().contains("password"));

    let off = a.call("admin_get_email_settings", json!({})).await;
    assert_eq!(off["email"]["enabled"], false);
    assert_eq!(off["email"]["sources"]["host"], "unset");
    assert_eq!(off["email"]["budgets"]["per_hour"], 500);

    // change
    let saved = a
        .call(
            "admin_update_email_settings",
            json!({
                "host": "smtp.example.com", "port": 465, "security": "tls",
                "username": "mailer", "from": "OpenBase <base@example.com>"
            }),
        )
        .await;
    assert_eq!(saved["email"]["enabled"], true);
    assert_eq!(saved["email"]["host"], "smtp.example.com");
    assert_eq!(saved["email"]["port"], 465);
    assert_eq!(saved["email"]["security"], "tls");
    assert_eq!(saved["email"]["username"], "mailer");
    assert!(
        saved["note"]
            .as_str()
            .unwrap()
            .contains("admin_send_test_email")
    );
    let again = a.call("admin_get_email_settings", json!({})).await;
    assert_eq!(again["email"]["host"], "smtp.example.com");
    assert_eq!(again["email"]["password_set"], false);

    // errors that say what to fix
    let e = a
        .fails("admin_update_email_settings", json!({"password": SECRET}))
        .await;
    assert!(
        e.contains("Invalid arguments") && e.contains("password"),
        "{e}"
    );
    assert!(
        r.app()
            .state
            .email
            .resolved()
            .smtp
            .unwrap()
            .password
            .is_none()
    );
    assert!(
        a.fails("admin_update_email_settings", json!({}))
            .await
            .contains("Give something to change")
    );
    let e = a
        .fails("admin_update_email_settings", json!({"security": "ssl"}))
        .await;
    assert!(
        e.contains("starttls, tls or none") || e.contains("Invalid arguments"),
        "{e}"
    );
    let e = a
        .fails("admin_update_email_settings", json!({"from": "nonsense"}))
        .await;
    assert!(e.contains("invalid sender address"), "{e}");
    let e = a
        .fails("admin_update_email_settings", json!({"port": 0}))
        .await;
    assert!(e.contains("port"), "{e}");

    // the password is set by a person in the web app (a session) ...
    r.app()
        .patch(&r.admin, "/api/admin/email", json!({"password": SECRET}))
        .await
        .assert_status(200);
    let with_pw = a.call("admin_get_email_settings", json!({})).await;
    assert_eq!(with_pw["email"]["password_set"], true);
    assert!(!with_pw.to_string().contains(SECRET));
    // ... and from then on the agent cannot redirect it
    let e = a
        .fails(
            "admin_update_email_settings",
            json!({"host": "evil.example.com"}),
        )
        .await;
    assert!(e.contains("different server"), "{e}");
    // the sender address is harmless
    a.call(
        "admin_update_email_settings",
        json!({"from": "Grid <grid2@example.com>"}),
    )
    .await;

    // api_request cannot do it either
    let e = a
        .fails(
            "api_request",
            json!({"method": "PATCH", "path": "/api/admin/email", "body": {"password": "x"}}),
        )
        .await;
    assert!(e.contains("API tokens can never"), "{e}");

    // switch email off with null
    let off = a
        .call("admin_update_email_settings", json!({"host": null}))
        .await;
    assert!(off["email"].get("host").is_none() || off["email"]["host"].is_null());
    assert_eq!(off["email"]["enabled"], false);

    // everything is in the audit log, the password never
    let log = a.call("admin_audit_log", json!({"limit": 50})).await;
    let actions: Vec<&str> = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"admin_email_update"), "{actions:?}");
    assert!(!log.to_string().contains("S3cr3t"));
}

#[tokio::test]
async fn a_test_email_is_delivered_or_fails_with_the_real_error() {
    let r = Rig::new().await;
    let a = &r.agent;

    // off: an error that says what to do
    let e = a.fails("admin_send_test_email", json!({})).await;
    assert!(e.contains("no SMTP host"), "{e}");

    a.call(
        "admin_update_email_settings",
        json!({"host": "smtp.example.com"}),
    )
    .await;
    let ok = a.call("admin_send_test_email", json!({})).await;
    assert_eq!(ok["sent"], true);
    assert_eq!(ok["to"], "admin@example.com");
    let sent = r.app().mailer.wait_for(1).await;
    assert_eq!(sent[0].to, "admin@example.com");
    let ok = a
        .call("admin_send_test_email", json!({"to": "ops@example.org"}))
        .await;
    assert_eq!(ok["to"], "ops@example.org");
    assert_eq!(r.app().mailer.wait_for(2).await[1].to, "ops@example.org");
    let e = a
        .fails("admin_send_test_email", json!({"to": "not an address"}))
        .await;
    assert!(e.contains("not a valid email address"), "{e}");

    // a mail server that cannot be reached: the error text is the real one
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    a.call(
        "admin_update_email_settings",
        json!({"host": "127.0.0.1", "port": port, "security": "none"}),
    )
    .await;
    r.app()
        .state
        .email
        .set_factory(
            smtp_factory(),
            &RawSmtp {
                host: Some("127.0.0.1".into()),
                port: Some(port),
                security: Some("none".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let e = a.fails("admin_send_test_email", json!({})).await;
    assert!(e.contains("was not sent"), "{e}");
    let lower = e.to_lowercase();
    assert!(
        lower.contains("refused") || lower.contains("connect"),
        "{e}"
    );
}

#[tokio::test]
async fn the_email_tools_need_an_administrators_manage_token() {
    let r = Rig::new().await;
    let (_, mate) = r
        .teammate(
            "mate@example.com",
            "owner",
            json!({"write": true, "manage": true}),
        )
        .await;
    for t in [
        "admin_get_email_settings",
        "admin_update_email_settings",
        "admin_send_test_email",
    ] {
        let e = mate.fails(t, json!({})).await;
        assert!(e.contains("instance administrator"), "{t}: {e}");
    }
    let limited = r
        .agent_with(json!({"write": true, "manage": true, "base_ids": [r.base]}))
        .await;
    let e = limited.fails("admin_get_email_settings", json!({})).await;
    assert!(
        e.contains("limited to specific bases") || e.contains("beyond single bases"),
        "{e}"
    );
}
