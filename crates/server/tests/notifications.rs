//! `GET /api/notifications` and `POST /api/notifications/read`.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use common::{Client, TestApp};
use opengrid::perm::Role;
use query_support::*;
use serde_json::{Value, json};

/// Insert a notification directly; `read` marks it already read.
fn notify(app: &TestApp, user: &Client, kind: &str, n: i64, read: bool) -> String {
    let id = opengrid::ids::new_id(og_core::ids::NOTIFICATION);
    let (nid, uid, kind) = (id.clone(), user.user_id.clone().unwrap(), kind.to_string());
    sql(app, |tx| {
        tx.execute(
            "INSERT INTO notifications (id, user_id, kind, payload, read_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                nid,
                uid,
                kind,
                json!({ "n": n }).to_string(),
                read.then_some(5),
                1_000 + n
            ],
        )
    });
    id
}

async fn list(app: &TestApp, c: &Client) -> Value {
    let r = app.get(c, "/api/notifications").await;
    r.assert_status(200);
    r.body
}

#[tokio::test]
async fn empty_inbox() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    let body = list(&app, &u).await;
    assert_eq!(body, json!({ "notifications": [], "unread": 0 }));
}

#[tokio::test]
async fn lists_newest_first_with_payloads_and_unread_count() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    notify(&app, &u, "mention", 1, true);
    notify(&app, &u, "assigned", 2, false);
    notify(&app, &u, "automation", 3, false);
    let body = list(&app, &u).await;
    assert_eq!(body["unread"], 2);
    let items = body["notifications"].as_array().unwrap();
    let kinds: Vec<&str> = items.iter().map(|n| n["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["automation", "assigned", "mention"]);
    assert_eq!(items[0]["payload"], json!({ "n": 3 }));
    assert_eq!(items[0]["read_at"], Value::Null);
    assert_eq!(items[0]["created_at"], 1_003);
    assert_eq!(items[2]["read_at"], 5);
    assert!(
        items[0]["id"]
            .as_str()
            .unwrap()
            .starts_with(og_core::ids::NOTIFICATION)
    );
}

#[tokio::test]
async fn at_most_fifty_are_listed_but_the_unread_count_is_complete() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    for i in 0..60 {
        notify(&app, &u, "mention", i, false);
    }
    let body = list(&app, &u).await;
    let items = body["notifications"].as_array().unwrap();
    assert_eq!(items.len(), 50);
    assert_eq!(body["unread"], 60);
    // The newest 50: payloads 59 down to 10.
    assert_eq!(items[0]["payload"]["n"], 59);
    assert_eq!(items[49]["payload"]["n"], 10);
}

#[tokio::test]
async fn everyone_only_sees_their_own() {
    let app = TestApp::new();
    let a = app.user("a@example.com", "A");
    let b = app.user("b@example.com", "B");
    notify(&app, &a, "mention", 1, false);
    notify(&app, &b, "mention", 2, false);
    notify(&app, &b, "mention", 3, false);
    assert_eq!(list(&app, &a).await["unread"], 1);
    assert_eq!(list(&app, &b).await["unread"], 2);
}

#[tokio::test]
async fn marking_specific_notifications_read() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    let n1 = notify(&app, &u, "mention", 1, false);
    let n2 = notify(&app, &u, "mention", 2, false);
    let n3 = notify(&app, &u, "mention", 3, false);
    let r = app
        .post(&u, "/api/notifications/read", json!({ "ids": [n1, n3] }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "ok": true }));
    let body = list(&app, &u).await;
    assert_eq!(body["unread"], 1);
    let unread: Vec<&Value> = body["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["read_at"].is_null())
        .map(|n| &n["id"])
        .collect();
    assert_eq!(unread, [&json!(n2)]);
    // Read ones carry a timestamp.
    assert!(body["notifications"][0]["read_at"].as_i64().unwrap() > 0);
}

#[tokio::test]
async fn an_empty_list_or_no_body_marks_everything_read() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    for i in 0..3 {
        notify(&app, &u, "mention", i, false);
    }
    app.post(&u, "/api/notifications/read", json!({ "ids": [] }))
        .await
        .assert_status(200);
    assert_eq!(list(&app, &u).await["unread"], 0);
    for i in 3..6 {
        notify(&app, &u, "mention", i, false);
    }
    app.post(&u, "/api/notifications/read", json!({}))
        .await
        .assert_status(200);
    assert_eq!(list(&app, &u).await["unread"], 0);
    for i in 6..9 {
        notify(&app, &u, "mention", i, false);
    }
    // No body at all.
    app.request(&u, "POST", "/api/notifications/read", None)
        .await
        .assert_status(200);
    assert_eq!(list(&app, &u).await["unread"], 0);
}

#[tokio::test]
async fn marking_read_is_idempotent_and_keeps_the_first_read_time() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    let n = notify(&app, &u, "mention", 1, true);
    app.post(&u, "/api/notifications/read", json!({ "ids": [n] }))
        .await
        .assert_status(200);
    let body = list(&app, &u).await;
    assert_eq!(
        body["notifications"][0]["read_at"], 5,
        "already read stays as is"
    );
    assert_eq!(body["unread"], 0);
}

#[tokio::test]
async fn cannot_mark_someone_elses_notifications() {
    let app = TestApp::new();
    let a = app.user("a@example.com", "A");
    let b = app.user("b@example.com", "B");
    let theirs = notify(&app, &b, "mention", 1, false);
    // Unknown and foreign ids are ignored, not an error and not a side effect.
    let r = app
        .post(
            &a,
            "/api/notifications/read",
            json!({ "ids": [theirs, "ntfNope"] }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(list(&app, &b).await["unread"], 1);
    // "Mark all" only touches the caller's own.
    notify(&app, &a, "mention", 2, false);
    app.post(&a, "/api/notifications/read", json!({}))
        .await
        .assert_status(200);
    assert_eq!(list(&app, &a).await["unread"], 0);
    assert_eq!(list(&app, &b).await["unread"], 1);
}

#[tokio::test]
async fn many_ids_in_one_request() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    let ids: Vec<String> = (0..450)
        .map(|i| notify(&app, &u, "mention", i, false))
        .collect();
    app.post(&u, "/api/notifications/read", json!({ "ids": ids }))
        .await
        .assert_status(200);
    assert_eq!(list(&app, &u).await["unread"], 0);
}

#[tokio::test]
async fn authentication_is_required_and_tokens_work() {
    let app = TestApp::new();
    let u = app.user("u@example.com", "U");
    notify(&app, &u, "mention", 1, false);
    app.get(&app.anon(), "/api/notifications")
        .await
        .assert_status(401);
    app.post(&app.anon(), "/api/notifications/read", json!({}))
        .await
        .assert_status(401);
    // Session or token, read-only or not.
    let ro = token_client(&app, &u, false);
    assert_eq!(list(&app, &ro).await["unread"], 1);
    app.post(&ro, "/api/notifications/read", json!({}))
        .await
        .assert_status(200);
    assert_eq!(list(&app, &u).await["unread"], 0);
    // Malformed bodies use the error envelope.
    let r = app
        .post(&u, "/api/notifications/read", json!({ "ids": "x" }))
        .await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn assignment_and_mention_notifications_flow_into_the_inbox() {
    let f = Fixture::new().await;
    let ann = f.member("ann@example.com", Role::Editor);
    let ann_id = ann.user_id.clone().unwrap();
    // A user field that notifies.
    let owner_field = id_of(
        &f.add_field(
            &f.table_id,
            json!({ "name": "Assignee", "type": "user", "options": { "notify": true } }),
        )
        .await,
    );
    let rec = f
        .create(
            &f.table_id,
            json!({ &f.primary_id: "Fix bug", &owner_field: [ann_id] }),
        )
        .await;
    let rid = id_str(&rec["id"]);
    let body = list(&f.app, &ann).await;
    assert_eq!(body["unread"], 1);
    assert_eq!(body["notifications"][0]["kind"], "assigned");
    assert_eq!(body["notifications"][0]["payload"]["record_id"], rid);
    // A comment mention lands in the same inbox.
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/records/{rid}/comments"),
            json!({ "body": format!("ping @[Ann]({ann_id})") }),
        )
        .await;
    r.assert_status(201);
    let body = list(&f.app, &ann).await;
    assert_eq!(body["unread"], 2);
    assert_eq!(body["notifications"][0]["kind"], "mention");
    assert_eq!(body["notifications"][1]["kind"], "assigned");
    f.app
        .post(
            &ann,
            "/api/notifications/read",
            json!({ "ids": [body["notifications"][0]["id"]] }),
        )
        .await
        .assert_status(200);
    assert_eq!(list(&f.app, &ann).await["unread"], 1);
}
