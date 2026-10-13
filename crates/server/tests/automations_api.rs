//! The automations HTTP API: CRUD, permissions, validation, the test
//! endpoint, run history and the incoming webhook.

mod automations_support;
mod common;
mod schema_support;

use automations_support::*;
use common::Client;
use opengrid::perm::Role;
use schema_support::{ALL_ROLES, token_client};
use serde_json::{Value, json};

fn auto_url(id: &str) -> String {
    format!("/api/automations/{id}")
}

fn simple_body(env: &Env, name: &str) -> Value {
    json!({
        "name": name,
        "enabled": false,
        "trigger": env.trigger_created(),
        "actions": [env.notify_action("hello")]
    })
}

// ----------------------------------------------------------------- CRUD

#[tokio::test]
async fn create_read_update_list_delete() {
    let env = Env::new().await;
    let app = &env.f.app;
    let owner = &env.f.owner;
    let r = app
        .post(
            owner,
            &format!("/api/bases/{}/automations", env.base()),
            json!({
                "name": "  Welcome mail ",
                "trigger": env.trigger_created(),
                "actions": [
                    { "type": "create_record", "table_id": env.table(),
                      "values": { "Name": "hi", "amount": 3 } },
                    env.notify_action("done")
                ]
            }),
        )
        .await;
    r.assert_status(201);
    let a = r.body.clone();
    let id = a["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("aut"));
    assert_eq!(a["name"], "Welcome mail");
    assert_eq!(a["base_id"], env.base());
    assert_eq!(a["enabled"], false, "new automations are off by default");
    assert_eq!(a["webhook_token"], Value::Null);
    assert_eq!(a["next_run_at"], Value::Null);
    assert_eq!(a["created_by"], owner.user_id.clone().unwrap().as_str());
    assert!(a["created_at"].as_i64().unwrap() > 0);
    // Field names in values were replaced by ids so renames cannot break it.
    assert_eq!(
        a["actions"][0]["values"],
        json!({ &env.name: "hi", &env.amount: 3 })
    );

    let got = app.get(owner, &auto_url(&id)).await;
    got.assert_status(200);
    assert_eq!(got.body["actions"], a["actions"]);
    assert_eq!(got.body["trigger"], env.trigger_created());

    let list = app
        .get(owner, &format!("/api/bases/{}/automations", env.base()))
        .await;
    list.assert_status(200);
    assert_eq!(list.body.as_array().unwrap().len(), 1);

    // Partial update: only what is sent changes.
    let patched = app
        .patch(
            owner,
            &auto_url(&id),
            json!({ "name": "Renamed", "actions": [env.notify_action("new text")] }),
        )
        .await;
    patched.assert_status(200);
    assert_eq!(patched.body["name"], "Renamed");
    assert_eq!(patched.body["actions"].as_array().unwrap().len(), 1);
    assert_eq!(patched.body["trigger"], env.trigger_created());
    assert!(patched.body["updated_at"].as_i64().unwrap() >= a["updated_at"].as_i64().unwrap());

    let on = app
        .patch(owner, &auto_url(&id), json!({ "enabled": true }))
        .await;
    on.assert_status(200);
    assert_eq!(on.body["enabled"], true);

    app.delete(owner, &auto_url(&id)).await.assert_status(200);
    app.get(owner, &auto_url(&id)).await.assert_status(404);
    app.delete(owner, &auto_url(&id)).await.assert_status(404);
    let list = app
        .get(owner, &format!("/api/bases/{}/automations", env.base()))
        .await;
    assert_eq!(list.body.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn stored_definitions_use_the_documented_json_and_hash_the_token() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let token = a["webhook_token"].as_str().unwrap();
    let (trigger, hash): (String, Option<String>) = schema_support::sql(&env.f.app, |tx| {
        tx.query_row(
            "SELECT \"trigger\", webhook_token_hash FROM automations WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
    });
    assert_eq!(
        serde_json::from_str::<Value>(&trigger).unwrap(),
        json!({ "type": "webhook" })
    );
    assert_eq!(hash.unwrap(), opengrid::ids::hash_token(token));
    let leaked = env.f.app.query_i64(
        "SELECT count(*) FROM automations WHERE instr(\"trigger\" || actions || name || COALESCE(webhook_token_hash, ''), ?1) > 0",
        &[token],
    );
    assert_eq!(leaked, 0, "the token itself is never stored");
}

#[tokio::test]
async fn listing_is_per_base() {
    let env = Env::new().await;
    env.create(
        "mine",
        env.trigger_created(),
        json!([env.notify_action("x")]),
    )
    .await;
    let other = schema_support::base(&env.f.app, &env.f.owner, &env.f.ws, "Other").await;
    let r = env
        .f
        .app
        .get(
            &env.f.owner,
            &format!("/api/bases/{}/automations", other["id"].as_str().unwrap()),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body, json!([]));
}

#[tokio::test]
async fn the_audit_log_records_changes() {
    let env = Env::new().await;
    let a = env
        .create(
            "audited",
            env.trigger_created(),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    env.f
        .app
        .patch(&env.f.owner, &auto_url(id), json!({ "name": "audited 2" }))
        .await
        .assert_status(200);
    env.f
        .app
        .delete(&env.f.owner, &auto_url(id))
        .await
        .assert_status(200);
    for action in [
        "automation_create",
        "automation_update",
        "automation_delete",
    ] {
        assert_eq!(
            env.f.app.query_i64(
                "SELECT count(*) FROM audit_log WHERE action = ?1 AND target = ?2",
                &[action, id]
            ),
            1,
            "{action}"
        );
    }
}

// ----------------------------------------------------------- permissions

#[tokio::test]
async fn role_matrix() {
    for role in ALL_ROLES {
        let env = Env::new().await;
        let app = &env.f.app;
        let user = env
            .f
            .member(&format!("{}-user@example.com", role.as_str()), role);
        let a = env
            .create(
                "target",
                env.trigger_created(),
                json!([env.notify_action("x")]),
            )
            .await;
        let id = a["id"].as_str().unwrap();
        let creator_plus = role >= Role::Creator;
        let editor_plus = role >= Role::Editor;
        let expect = |ok: bool, ok_status: u16| if ok { ok_status } else { 403 };
        let label = role.as_str();

        let r = app
            .get(&user, &format!("/api/bases/{}/automations", env.base()))
            .await;
        assert_eq!(
            r.status.as_u16(),
            expect(creator_plus, 200),
            "list as {label}"
        );
        let r = app.get(&user, &auto_url(id)).await;
        assert_eq!(
            r.status.as_u16(),
            expect(creator_plus, 200),
            "get as {label}"
        );
        let r = app
            .post(
                &user,
                &format!("/api/bases/{}/automations", env.base()),
                simple_body(&env, "by role"),
            )
            .await;
        assert_eq!(
            r.status.as_u16(),
            expect(creator_plus, 201),
            "create as {label}"
        );
        let r = app
            .patch(&user, &auto_url(id), json!({ "name": "x" }))
            .await;
        assert_eq!(
            r.status.as_u16(),
            expect(creator_plus, 200),
            "patch as {label}"
        );
        let r = app
            .post(
                &user,
                &format!("{}/test", auto_url(id)),
                json!({ "dry_run": true }),
            )
            .await;
        // A dry run needs a record to test with; the role check comes first.
        if creator_plus {
            assert_eq!(r.status.as_u16(), 400, "test as {label} (no records yet)");
        } else {
            assert_eq!(r.status.as_u16(), 403, "test as {label}");
        }
        let r = app.get(&user, &format!("{}/runs", auto_url(id))).await;
        assert_eq!(
            r.status.as_u16(),
            expect(editor_plus, 200),
            "runs as {label}"
        );
        let r = app.delete(&user, &auto_url(id)).await;
        assert_eq!(
            r.status.as_u16(),
            expect(creator_plus, 200),
            "delete as {label}"
        );
        if !creator_plus {
            // Refused: it must still be there.
            app.get(&env.f.owner, &auto_url(id))
                .await
                .assert_status(200);
        }
    }
}

#[tokio::test]
async fn base_level_sharing_grants_the_same_rights() {
    let env = Env::new().await;
    let a = env
        .create(
            "target",
            env.trigger_created(),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let guest_creator = env.f.base_guest("gc@example.com", Role::Creator);
    let guest_editor = env.f.base_guest("ge@example.com", Role::Editor);
    env.f
        .app
        .get(&guest_creator, &auto_url(id))
        .await
        .assert_status(200);
    env.f
        .app
        .get(&guest_editor, &auto_url(id))
        .await
        .assert_status(403);
    env.f
        .app
        .get(&guest_editor, &format!("{}/runs", auto_url(id)))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn strangers_anonymous_and_scoped_tokens() {
    let env = Env::new().await;
    let app = &env.f.app;
    let a = env
        .create(
            "target",
            env.trigger_created(),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let base_path = format!("/api/bases/{}/automations", env.base());

    // Not a member: existence is not revealed.
    let stranger = app.user("stranger@example.com", "S");
    for (method, path, body) in [
        ("GET", base_path.clone(), None),
        ("POST", base_path.clone(), Some(simple_body(&env, "x"))),
        ("GET", auto_url(id), None),
        ("PATCH", auto_url(id), Some(json!({ "name": "x" }))),
        ("DELETE", auto_url(id), None),
        ("POST", format!("{}/test", auto_url(id)), Some(json!({}))),
        ("GET", format!("{}/runs", auto_url(id)), None),
    ] {
        let r = app.request(&stranger, method, &path, body.clone()).await;
        assert_eq!(r.status.as_u16(), 404, "{method} {path} as a stranger");
        let r = app.request(&app.anon(), method, &path, body).await;
        assert_eq!(r.status.as_u16(), 401, "{method} {path} anonymously");
    }
    app.get(&stranger, &auto_url("autNoSuchThing"))
        .await
        .assert_status(404);

    // API tokens: read-only tokens act as viewers, base-limited tokens
    // cannot reach other bases.
    let ro = token_client(app, &env.f.owner, false);
    let rw = token_client(app, &env.f.owner, true);
    app.get(&ro, &auto_url(id)).await.assert_status(403);
    app.post(&ro, &base_path, simple_body(&env, "x"))
        .await
        .assert_status(403);
    app.get(&rw, &auto_url(id)).await.assert_status(200);
    app.post(&rw, &base_path, simple_body(&env, "via token"))
        .await
        .assert_status(201);
}

// ------------------------------------------------------------ validation

async fn expect_400(
    env: &Env,
    label: &str,
    trigger: Value,
    actions: Value,
    enabled: bool,
    needle: &str,
) {
    let r = env.try_create(label, trigger, actions, enabled).await;
    assert_eq!(r.status.as_u16(), 400, "{label}: {}", r.body);
    assert_eq!(r.body["error"]["code"], "bad_request", "{label}");
    let msg = r.body["error"]["message"].as_str().unwrap_or_default();
    assert!(
        msg.to_lowercase().contains(&needle.to_lowercase()),
        "{label}: expected {needle:?} in {msg:?}"
    );
}

#[tokio::test]
async fn invalid_triggers_are_rejected() {
    let env = Env::new().await;
    let notify = json!([env.notify_action("x")]);
    let formula = env
        .f
        .add_field(
            env.table(),
            json!({ "name": "Calc", "type": "formula", "options": { "expression": "1" } }),
        )
        .await;
    let other_base = schema_support::base(&env.f.app, &env.f.owner, &env.f.ws, "Other").await;
    let foreign_table = other_base["tables"][0]["id"].as_str().unwrap();
    let foreign_view = other_base["tables"][0]["views"][0]["id"].as_str().unwrap();
    let grid_view = env.f.view_id.clone();

    let cases: Vec<(&str, Value, &str)> = vec![
        ("unknown table", json!({ "type": "record_created", "table_id": "tblNope" }), "does not exist in this base"),
        ("table of another base", json!({ "type": "record_created", "table_id": foreign_table }), "does not exist in this base"),
        ("unknown watched field", env.trigger_updated(&["fldNope"]), "does not exist"),
        ("computed watched field", env.trigger_updated(&[formula["id"].as_str().unwrap()]), "computed"),
        ("duplicate watched field", env.trigger_updated(&[&env.name, &env.name]), "twice"),
        (
            "filter on an unknown field",
            env.trigger_matches(json!({ "conjunction": "and", "items": [ { "field_id": "fldNope", "op": "is", "value": 1 } ] })),
            "invalid filter",
        ),
        (
            "operator that does not fit the field",
            env.trigger_matches(json!({ "conjunction": "and", "items": [ { "field_id": env.amount, "op": "contains", "value": "x" } ] })),
            "invalid filter",
        ),
        ("form trigger on a grid view", json!({ "type": "form_submitted", "view_id": grid_view }), "form view"),
        ("form trigger on an unknown view", json!({ "type": "form_submitted", "view_id": "viwNope" }), "does not exist"),
        ("form trigger on another base's view", json!({ "type": "form_submitted", "view_id": foreign_view }), "does not exist"),
        ("not a cron", json!({ "type": "schedule", "cron": "when it feels right", "timezone": "UTC" }), "cron"),
        ("empty cron", json!({ "type": "schedule", "cron": " ", "timezone": "UTC" }), "empty"),
        ("every minute", json!({ "type": "schedule", "cron": "* * * * *", "timezone": "UTC" }), "minimum interval"),
        ("every 4 minutes", json!({ "type": "schedule", "cron": "*/4 * * * *", "timezone": "UTC" }), "minimum interval"),
        ("seconds", json!({ "type": "schedule", "cron": "*/30 * * * * *", "timezone": "UTC" }), "minimum interval"),
        ("two close minutes", json!({ "type": "schedule", "cron": "0,3 * * * *", "timezone": "UTC" }), "minimum interval"),
        ("unknown zone", json!({ "type": "schedule", "cron": "0 9 * * *", "timezone": "Mars/Base" }), "time zone"),
    ];
    for (label, trigger, needle) in cases {
        expect_400(&env, label, trigger, notify.clone(), false, needle).await;
    }

    // Every 5 minutes is the fastest allowed.
    env.try_create(
        "5 min",
        json!({ "type": "schedule", "cron": "*/5 * * * *", "timezone": "UTC" }),
        notify,
        true,
    )
    .await
    .assert_status(201);
}

#[tokio::test]
async fn invalid_actions_are_rejected_with_the_action_number() {
    let env = Env::new().await;
    let t = env.table();
    let created = env.trigger_created();
    let webhook = json!({ "type": "webhook" });
    let formula = env
        .f
        .add_field(
            t,
            json!({ "name": "Calc", "type": "formula", "options": { "expression": "1" } }),
        )
        .await;
    let other_base = schema_support::base(&env.f.app, &env.f.owner, &env.f.ws, "Other").await;
    let foreign_table = other_base["tables"][0]["id"].as_str().unwrap().to_string();
    let outsider = env.f.app.user("outsider@example.com", "O");
    let owner_id = env.f.owner.user_id.clone().unwrap();
    let ok_notify = env.notify_action("fine");
    let create =
        |values: Value| json!({ "type": "create_record", "table_id": t, "values": values });
    let http = |m: &str, url: &str| json!({ "type": "http_request", "method": m, "url": url });
    let email = |to: &str, subject: &str| json!({ "type": "send_email", "to": to, "subject": subject, "body": "b" });

    type Case = (&'static str, Value, Vec<Value>, &'static str);
    let cases: Vec<Case> = vec![
        (
            "unknown table",
            created.clone(),
            vec![json!({ "type": "create_record", "table_id": "tblNope", "values": {} })],
            "does not exist in this base",
        ),
        (
            "table of another base",
            created.clone(),
            vec![json!({ "type": "create_record", "table_id": foreign_table, "values": {} })],
            "does not exist in this base",
        ),
        (
            "unknown field",
            created.clone(),
            vec![create(json!({ "Nope": 1 }))],
            "unknown field",
        ),
        (
            "computed field",
            created.clone(),
            vec![create(json!({ "Calc": 1 }))],
            "computed",
        ),
        (
            "computed field by id",
            created.clone(),
            vec![create(json!({ formula["id"].as_str().unwrap(): 1 }))],
            "computed",
        ),
        (
            "same field twice",
            created.clone(),
            vec![create(json!({ "Amount": 1, env.amount.as_str(): 2 }))],
            "more than once",
        ),
        (
            "literal value of the wrong type",
            created.clone(),
            vec![create(json!({ "Amount": "banana" }))],
            "Amount",
        ),
        (
            "unclosed template",
            created.clone(),
            vec![create(json!({ "Name": "{{trigger.record.id" }))],
            "closing",
        ),
        (
            "unknown variable",
            created.clone(),
            vec![create(json!({ "Name": "{{secrets.key}}" }))],
            "unknown placeholder",
        ),
        (
            "forward step reference",
            created.clone(),
            vec![
                create(json!({ "Name": "{{steps.2.record_id}}" })),
                ok_notify.clone(),
            ],
            "action 1",
        ),
        (
            "self step reference",
            created.clone(),
            vec![
                ok_notify.clone(),
                create(json!({ "Name": "{{steps.2.x}}" })),
            ],
            "does not run before",
        ),
        (
            "body variable on a record trigger",
            created.clone(),
            vec![create(json!({ "Name": "{{trigger.body.x}}" }))],
            "webhook",
        ),
        (
            "record variable on a webhook trigger",
            webhook.clone(),
            vec![create(json!({ "Name": "{{trigger.record.id}}" }))],
            "record and form",
        ),
        (
            "update without values",
            created.clone(),
            vec![
                json!({ "type": "update_record", "table_id": t, "record_id": "{{trigger.record.id}}", "values": {} }),
            ],
            "at least one field",
        ),
        (
            "update without record",
            created.clone(),
            vec![
                json!({ "type": "update_record", "table_id": t, "record_id": " ", "values": { "Name": "x" } }),
            ],
            "record_id",
        ),
        (
            "bad recipient",
            created.clone(),
            vec![email("not-an-email", "hi")],
            "not a valid email",
        ),
        (
            "one bad recipient among good ones",
            created.clone(),
            vec![email("a@example.com, nope", "hi")],
            "not a valid email",
        ),
        (
            "too many recipients",
            created.clone(),
            vec![email(
                &(0..11)
                    .map(|i| format!("u{i}@example.com"))
                    .collect::<Vec<_>>()
                    .join(","),
                "hi",
            )],
            "at most 10",
        ),
        (
            "no recipient",
            created.clone(),
            vec![email("  ", "hi")],
            "recipient",
        ),
        (
            "no subject",
            created.clone(),
            vec![email("a@example.com", " ")],
            "subject",
        ),
        (
            "ftp url",
            created.clone(),
            vec![http("GET", "ftp://example.com/x")],
            "http",
        ),
        (
            "file url",
            created.clone(),
            vec![http("GET", "file:///etc/passwd")],
            "http",
        ),
        (
            "garbage url",
            created.clone(),
            vec![http("GET", "not a url")],
            "http",
        ),
        (
            "templated scheme",
            created.clone(),
            vec![http("GET", "{{trigger.record.id}}://x.example.com")],
            "http",
        ),
        (
            "url with credentials",
            created.clone(),
            vec![http("GET", "https://user:pw@example.com/")],
            "user name",
        ),
        (
            "get with body",
            created.clone(),
            vec![
                json!({ "type": "http_request", "method": "GET", "url": "https://example.com/", "body": "x" }),
            ],
            "GET",
        ),
        (
            "reserved header",
            created.clone(),
            vec![
                json!({ "type": "http_request", "method": "GET", "url": "https://example.com/", "headers": { "Host": "evil" } }),
            ],
            "cannot be overridden",
        ),
        (
            "bad header name",
            created.clone(),
            vec![
                json!({ "type": "http_request", "method": "GET", "url": "https://example.com/", "headers": { "Bad Name": "x" } }),
            ],
            "invalid header",
        ),
        (
            "duplicate header",
            created.clone(),
            vec![
                json!({ "type": "http_request", "method": "GET", "url": "https://example.com/", "headers": { "X-A": "1", "x-a": "2" } }),
            ],
            "twice",
        ),
        (
            "unknown method",
            created.clone(),
            vec![
                json!({ "type": "http_request", "method": "TRACE", "url": "https://example.com/" }),
            ],
            "TRACE",
        ),
        (
            "unknown action type",
            created.clone(),
            vec![json!({ "type": "run_script", "code": "1" })],
            "run_script",
        ),
        (
            "notify nobody",
            created.clone(),
            vec![json!({ "type": "notify", "user_ids": [], "message": "x" })],
            "at least one user",
        ),
        (
            "notify someone without access",
            created.clone(),
            vec![
                json!({ "type": "notify", "user_ids": [outsider.user_id.clone().unwrap()], "message": "x" }),
            ],
            "does not have access",
        ),
        (
            "notify the same user twice",
            created.clone(),
            vec![
                json!({ "type": "notify", "user_ids": [owner_id.clone(), owner_id.clone()], "message": "x" }),
            ],
            "twice",
        ),
        (
            "notify without message",
            created.clone(),
            vec![json!({ "type": "notify", "user_ids": [owner_id.clone()], "message": " " })],
            "message",
        ),
        (
            "condition on a webhook automation",
            webhook.clone(),
            vec![
                json!({ "condition": env.status_is(&env.doing), "type": "notify", "user_ids": [owner_id.clone()], "message": "x" }),
            ],
            "need a record",
        ),
        (
            "condition on an unknown field",
            created.clone(),
            vec![
                json!({ "condition": { "conjunction": "and", "items": [ { "field_id": "fldNope", "op": "is", "value": 1 } ] },
                         "type": "notify", "user_ids": [owner_id.clone()], "message": "x" }),
            ],
            "invalid condition",
        ),
    ];
    for (label, trigger, actions, needle) in cases {
        expect_400(&env, label, trigger, Value::Array(actions), false, needle).await;
    }

    // The action number is part of the message.
    let r = env
        .try_create(
            "numbered",
            created.clone(),
            json!([ok_notify.clone(), create(json!({ "Nope": 1 }))]),
            false,
        )
        .await;
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("action 2:"),
        "{}",
        r.body
    );

    // At most 25 actions.
    let many: Vec<Value> = (0..26).map(|_| ok_notify.clone()).collect();
    expect_400(
        &env,
        "26 actions",
        created.clone(),
        Value::Array(many),
        false,
        "at most 25",
    )
    .await;
    let max: Vec<Value> = (0..25).map(|_| ok_notify.clone()).collect();
    env.try_create("25 actions", created.clone(), Value::Array(max), false)
        .await
        .assert_status(201);

    // An enabled automation needs something to do.
    expect_400(
        &env,
        "enabled without actions",
        created.clone(),
        json!([]),
        true,
        "at least one action",
    )
    .await;
    env.try_create("draft", created.clone(), json!([]), false)
        .await
        .assert_status(201);
}

#[tokio::test]
async fn malformed_requests_use_the_error_envelope() {
    let env = Env::new().await;
    let path = format!("/api/bases/{}/automations", env.base());
    for (label, body) in [
        (
            "empty name",
            json!({ "name": "  ", "trigger": env.trigger_created(), "actions": [] }),
        ),
        (
            "name too long",
            json!({ "name": "x".repeat(300), "trigger": env.trigger_created(), "actions": [] }),
        ),
        ("missing trigger", json!({ "name": "n", "actions": [] })),
        (
            "unknown trigger type",
            json!({ "name": "n", "trigger": { "type": "moon_phase" }, "actions": [] }),
        ),
        ("not an object", json!([1, 2, 3])),
    ] {
        let r = env.f.app.post(&env.f.owner, &path, body).await;
        assert_eq!(r.status.as_u16(), 400, "{label}: {}", r.body);
        assert_eq!(r.body["error"]["code"], "bad_request", "{label}");
    }
}

#[tokio::test]
async fn localhost_and_private_literals_are_refused_at_save_time_unless_allowed() {
    let strict = Env::with_config(|c| c.allow_private_webhooks = false).await;
    for url in [
        "http://127.0.0.1:9000/x",
        "http://localhost/x",
        "http://10.1.2.3/x",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/x",
        "http://[::ffff:127.0.0.1]/x",
        "http://[fd00::1]/",
    ] {
        expect_400(
            &strict,
            url,
            strict.trigger_created(),
            json!([{ "type": "http_request", "method": "GET", "url": url }]),
            false,
            "not allowed",
        )
        .await;
    }
    strict
        .try_create(
            "public host",
            strict.trigger_created(),
            json!([{ "type": "http_request", "method": "GET", "url": "https://example.com/hook" }]),
            true,
        )
        .await
        .assert_status(201);
    // A templated URL cannot be judged at save time; the run-time guard handles it.
    strict
        .try_create(
            "templated",
            strict.trigger_created(),
            json!([{ "type": "http_request", "method": "GET", "url": "https://example.com/{{trigger.record.id}}" }]),
            true,
        )
        .await
        .assert_status(201);

    let lax = Env::with_config(|c| c.allow_private_webhooks = true).await;
    lax.try_create(
        "lan",
        lax.trigger_created(),
        json!([{ "type": "http_request", "method": "GET", "url": "http://10.1.2.3/x" }]),
        true,
    )
    .await
    .assert_status(201);
}

#[tokio::test]
async fn updating_revalidates_and_a_broken_automation_cannot_be_turned_on() {
    let env = Env::new().await;
    let a = env
        .try_create(
            "stale",
            env.trigger_created(),
            json!([{ "type": "create_record", "table_id": env.table(), "values": {} }]),
            false,
        )
        .await;
    a.assert_status(201);
    let id = a.body["id"].as_str().unwrap().to_string();

    let bad = env
        .f
        .app
        .patch(&env.f.owner, &auto_url(&id), json!({ "actions": [{ "type": "create_record", "table_id": "tblNope", "values": {} }] }))
        .await;
    bad.assert_status(400);
    let bad = env
        .f
        .app
        .patch(
            &env.f.owner,
            &auto_url(&id),
            json!({ "trigger": { "type": "schedule", "cron": "* * * * *", "timezone": "UTC" } }),
        )
        .await;
    bad.assert_status(400);
    // Nothing changed.
    let got = env.f.app.get(&env.f.owner, &auto_url(&id)).await;
    assert_eq!(got.body["trigger"], env.trigger_created());

    // The target table disappears; renaming still works, enabling does not.
    let t = env.f.add_table("Soon gone").await;
    let tid = t["id"].as_str().unwrap();
    env.f
        .app
        .patch(
            &env.f.owner,
            &auto_url(&id),
            json!({ "actions": [{ "type": "create_record", "table_id": tid, "values": {} }] }),
        )
        .await
        .assert_status(200);
    env.f
        .app
        .delete(&env.f.owner, &format!("/api/tables/{tid}"))
        .await
        .assert_status(200);
    env.f
        .app
        .patch(
            &env.f.owner,
            &auto_url(&id),
            json!({ "name": "still renameable" }),
        )
        .await
        .assert_status(200);
    let on = env
        .f
        .app
        .patch(&env.f.owner, &auto_url(&id), json!({ "enabled": true }))
        .await;
    on.assert_status(400);
    assert!(
        on.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("does not exist")
    );
}

// ------------------------------------------------------------- webhooks

#[tokio::test]
async fn webhook_token_is_shown_once_and_can_be_rotated() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let token = a["webhook_token"].as_str().unwrap().to_string();
    assert!(token.starts_with("ogh_") && token.len() >= 40, "{token}");

    // Never shown again.
    let got = env.f.app.get(&env.f.owner, &auto_url(id)).await;
    assert_eq!(got.body["webhook_token"], Value::Null);
    let list = env
        .f
        .app
        .get(
            &env.f.owner,
            &format!("/api/bases/{}/automations", env.base()),
        )
        .await;
    assert_eq!(list.body[0]["webhook_token"], Value::Null);
    let renamed = env
        .f
        .app
        .patch(&env.f.owner, &auto_url(id), json!({ "name": "x" }))
        .await;
    assert_eq!(
        renamed.body["webhook_token"],
        Value::Null,
        "an ordinary update does not reissue it"
    );

    let anon = env.f.app.anon();
    env.f
        .app
        .post(&anon, &format!("/api/hooks/{token}"), json!({ "a": 1 }))
        .await
        .assert_status(202);

    // Rotating issues a new one and kills the old one.
    let rotated = env
        .f
        .app
        .patch(
            &env.f.owner,
            &auto_url(id),
            json!({ "rotate_webhook_token": true }),
        )
        .await;
    rotated.assert_status(200);
    let new_token = rotated.body["webhook_token"].as_str().unwrap().to_string();
    assert_ne!(new_token, token);
    env.f
        .app
        .post(&anon, &format!("/api/hooks/{token}"), json!({}))
        .await
        .assert_status(404);
    env.f
        .app
        .post(&anon, &format!("/api/hooks/{new_token}"), json!({}))
        .await
        .assert_status(202);

    // Rotation only makes sense for webhook automations.
    let other = env
        .create(
            "not a hook",
            env.trigger_created(),
            json!([env.notify_action("x")]),
        )
        .await;
    env.f
        .app
        .patch(
            &env.f.owner,
            &auto_url(other["id"].as_str().unwrap()),
            json!({ "rotate_webhook_token": true }),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn switching_trigger_types_manages_the_token() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let token = a["webhook_token"].as_str().unwrap();

    let r = env
        .f
        .app
        .patch(
            &env.f.owner,
            &auto_url(id),
            json!({ "trigger": env.trigger_created() }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["webhook_token"], Value::Null);
    env.f
        .app
        .post(&env.f.app.anon(), &format!("/api/hooks/{token}"), json!({}))
        .await
        .assert_status(404);
    assert_eq!(
        env.f.app.query_i64(
            "SELECT count(*) FROM automations WHERE id = ?1 AND webhook_token_hash IS NULL",
            &[id]
        ),
        1
    );

    // Back to a webhook: a fresh token comes with the response.
    let r = env
        .f
        .app
        .patch(
            &env.f.owner,
            &auto_url(id),
            json!({ "trigger": { "type": "webhook" } }),
        )
        .await;
    r.assert_status(200);
    let fresh = r.body["webhook_token"].as_str().unwrap();
    assert_ne!(fresh, token);
    env.f
        .app
        .post(&env.f.app.anon(), &format!("/api/hooks/{fresh}"), json!({}))
        .await
        .assert_status(202);
}

#[tokio::test]
async fn incoming_webhooks_queue_runs_with_the_body() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("order {{trigger.body.order.id}}")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let token = a["webhook_token"].as_str().unwrap();
    let anon = env.f.app.anon();

    let r = env
        .f
        .app
        .post(
            &anon,
            &format!("/api/hooks/{token}"),
            json!({ "order": { "id": 17 }, "tags": ["a"] }),
        )
        .await;
    r.assert_status(202);
    assert_eq!(r.body["ok"], true);
    let run_id = r.body["run_id"].as_i64().unwrap();

    let run = env.only_run(id).await;
    assert_eq!(run["id"], run_id);
    assert_eq!(run["status"], "queued");
    assert_eq!(run["trigger_data"]["type"], "webhook");
    assert_eq!(
        run["trigger_data"]["body"],
        json!({ "order": { "id": 17 }, "tags": ["a"] })
    );

    env.drain().await;
    let run = env.only_run(id).await;
    assert_eq!(run["status"], "succeeded");
    let payload: String = schema_support::sql(&env.f.app, |tx| {
        tx.query_row("SELECT payload FROM notifications", [], |r| r.get(0))
    });
    assert!(payload.contains("order 17"), "{payload}");

    // An empty body is fine, anything that is not JSON is not.
    env.f
        .app
        .request(&anon, "POST", &format!("/api/hooks/{token}"), None)
        .await
        .assert_status(202);
    let bad = env
        .f
        .app
        .send(
            axum::http::Request::builder()
                .method("POST")
                .uri(format!("/api/hooks/{token}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from("{not json"))
                .unwrap(),
        )
        .await;
    assert_eq!(bad.status.as_u16(), 400);
    assert_eq!(bad.body["error"]["code"], "bad_request");
    assert_eq!(env.run_count(id), 2);
}

#[tokio::test]
async fn webhook_bodies_are_limited_to_one_megabyte() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let token = a["webhook_token"].as_str().unwrap();
    let send = |len: usize| {
        let body = format!("{{\"pad\":\"{}\"}}", "a".repeat(len));
        env.f.app.send(
            axum::http::Request::builder()
                .method("POST")
                .uri(format!("/api/hooks/{token}"))
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body))
                .unwrap(),
        )
    };
    assert_eq!(
        send(1024 * 1024 - 20).await.status.as_u16(),
        202,
        "just under 1 MB"
    );
    let big = send(1024 * 1024 + 10).await;
    assert_eq!(big.status.as_u16(), 413);
    assert_eq!(big.body["error"]["code"], "payload_too_large");
    let huge = send(3 * 1024 * 1024).await;
    assert_eq!(huge.status.as_u16(), 413);
    assert_eq!(
        env.run_count(a["id"].as_str().unwrap()),
        1,
        "only the first one was queued"
    );
}

#[tokio::test]
async fn unknown_disabled_and_malformed_tokens_are_all_404() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let token = a["webhook_token"].as_str().unwrap();
    let anon = env.f.app.anon();
    for t in ["ogh_doesnotexist", "x", &"y".repeat(500), "%00"] {
        env.f
            .app
            .post(&anon, &format!("/api/hooks/{t}"), json!({}))
            .await
            .assert_status(404);
    }
    // The hash of the token is not the token.
    env.f
        .app
        .post(
            &anon,
            &format!("/api/hooks/{}", opengrid::ids::hash_token(token)),
            json!({}),
        )
        .await
        .assert_status(404);
    // Disabled: same answer as unknown, nothing queued.
    env.f
        .app
        .patch(&env.f.owner, &auto_url(id), json!({ "enabled": false }))
        .await
        .assert_status(200);
    env.f
        .app
        .post(&anon, &format!("/api/hooks/{token}"), json!({}))
        .await
        .assert_status(404);
    assert_eq!(env.run_count(id), 0);
    // GET is not a thing.
    let r = env.f.app.get(&anon, &format!("/api/hooks/{token}")).await;
    assert_eq!(r.status.as_u16(), 405);
}

#[tokio::test]
async fn webhooks_are_rate_limited_per_token_and_guessing_per_client() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let b = env
        .create(
            "hook b",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let (ta, tb) = (
        a["webhook_token"].as_str().unwrap(),
        b["webhook_token"].as_str().unwrap(),
    );
    let anon = env.f.app.anon();
    for i in 0..60 {
        let r = env
            .f
            .app
            .post(&anon, &format!("/api/hooks/{ta}"), json!({ "i": i }))
            .await;
        assert_eq!(r.status.as_u16(), 202, "call {i}");
    }
    let r = env
        .f
        .app
        .post(&anon, &format!("/api/hooks/{ta}"), json!({}))
        .await;
    assert_eq!(r.status.as_u16(), 429);
    assert_eq!(r.body["error"]["code"], "too_many_requests");
    // Another token is unaffected.
    env.f
        .app
        .post(&anon, &format!("/api/hooks/{tb}"), json!({}))
        .await
        .assert_status(202);

    // Guessing tokens from one address gets cut off.
    let peer: std::net::SocketAddr = "203.0.113.9:4000".parse().unwrap();
    let mut statuses = Vec::new();
    for i in 0..40 {
        let r = env
            .f
            .app
            .request_with(
                &anon,
                "POST",
                &format!("/api/hooks/guess{i}"),
                Some(json!({})),
                &[],
                true,
                Some(peer),
            )
            .await;
        statuses.push(r.status.as_u16());
    }
    assert_eq!(&statuses[..30], &[404; 30]);
    assert_eq!(&statuses[30..], &[429; 10]);
    // ...but only that address.
    let other: std::net::SocketAddr = "203.0.113.10:4000".parse().unwrap();
    let r = env
        .f
        .app
        .request_with(
            &anon,
            "POST",
            "/api/hooks/guess",
            Some(json!({})),
            &[],
            true,
            Some(other),
        )
        .await;
    assert_eq!(r.status.as_u16(), 404);
}

#[tokio::test]
async fn webhooks_stop_accepting_calls_when_the_queue_is_backed_up() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let id = a["id"].as_str().unwrap().to_string();
    let token = a["webhook_token"].as_str().unwrap();
    let aid = id.clone();
    env.f
        .app
        .state
        .db
        .write_sync(|tx| {
            let mut stmt = tx.prepare(
                "INSERT INTO automation_runs (automation_id, status, trigger_data, created_at)
                 VALUES (?1, 'queued', '{}', 1)",
            )?;
            for _ in 0..opengrid::automations::store::MAX_QUEUED_WEBHOOK_RUNS {
                stmt.execute([&aid])?;
            }
            Ok(())
        })
        .unwrap();
    let r = env
        .f
        .app
        .post(&env.f.app.anon(), &format!("/api/hooks/{token}"), json!({}))
        .await;
    assert_eq!(r.status.as_u16(), 429);
    assert_eq!(
        env.run_count(&id),
        opengrid::automations::store::MAX_QUEUED_WEBHOOK_RUNS
    );
}

#[tokio::test]
async fn webhooks_work_without_csrf_header_or_session() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("x")]),
        )
        .await;
    let token = a["webhook_token"].as_str().unwrap();
    let r = env
        .f
        .app
        .request_with(
            &Client::default(),
            "POST",
            &format!("/api/hooks/{token}"),
            Some(json!({})),
            &[],
            false,
            None,
        )
        .await;
    assert_eq!(r.status.as_u16(), 202);
}

// ------------------------------------------------------------- test runs

#[tokio::test]
async fn dry_runs_render_everything_and_change_nothing() {
    let env = Env::new().await;
    let rec = env.rec(json!({ &env.name: "Ada", &env.amount: 4 }));
    let a = env
        .create(
            "dry",
            env.trigger_created(),
            json!([
                { "type": "create_record", "table_id": env.table(), "values": { "Name": "copy of {{trigger.record.fields.Name}}" } },
                { "type": "update_record", "table_id": env.table(), "record_id": "{{steps.1.record_id}}", "values": { "Amount": 9 } },
                { "type": "send_email", "to": "x@example.com", "subject": "Hi {{trigger.record.fields.Name}}", "body": "b" },
                { "type": "http_request", "method": "POST", "url": env.server.url("/never/{{trigger.record.id}}"),
                  "headers": { "Authorization": "Bearer top-secret" }, "body": "{\"n\": \"{{trigger.record.fields.Name}}\"}" },
                env.notify_action("hello {{trigger.record.fields.Name}}")
            ]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env
        .f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(id)),
            json!({ "record_id": rec }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["dry_run"], true, "dry run is the default");
    assert_eq!(r.body["status"], "succeeded", "{}", r.body);
    assert_eq!(r.body["run_id"], Value::Null);
    let log = r.body["log"].as_array().unwrap();
    assert_eq!(log.len(), 5);
    assert_eq!(log[0]["output"]["values"][&env.name], "copy of Ada");
    assert_eq!(log[0]["output"]["dry_run"], true);
    assert_eq!(log[2]["output"]["subject"], "Hi Ada");
    assert_eq!(
        log[3]["output"]["url"],
        env.server.url(&format!("/never/{rec}"))
    );
    assert_eq!(log[3]["output"]["body"], "{\"n\": \"Ada\"}");
    assert_eq!(
        log[3]["output"]["header_names"],
        json!(["Authorization", "Content-Type"])
    );
    assert!(
        !r.body.to_string().contains("top-secret"),
        "header values are not echoed"
    );
    assert_eq!(log[4]["output"]["message"], "hello Ada");

    // Nothing happened.
    assert_eq!(env.record_count(), 1);
    assert!(env.f.app.mailer.sent().is_empty());
    assert!(env.server.hits().is_empty());
    assert_eq!(
        env.f
            .app
            .query_i64("SELECT count(*) FROM notifications", &[]),
        0
    );
    assert_eq!(env.run_count(id), 0, "dry runs are not recorded");
}

#[tokio::test]
async fn dry_runs_still_apply_the_ssrf_guard_and_report_errors() {
    let env = Env::with_config(|c| c.allow_private_webhooks = false).await;
    env.rec(json!({}));
    let a = env
        .create(
            "dry",
            env.trigger_created(),
            json!([{ "type": "http_request", "method": "GET", "url": "https://example.com/{{trigger.record.id}}" }]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    // Point the template at the loopback address through the record value.
    env.f
        .app
        .patch(
            &env.f.owner,
            &auto_url(id),
            json!({ "actions": [{ "type": "http_request", "method": "GET", "url": "http://{{trigger.record.fields.Name}}/x" }] }),
        )
        .await
        .assert_status(200);
    let rec = env.rec(json!({ &env.name: "127.0.0.1" }));
    let r = env
        .f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(id)),
            json!({ "record_id": rec }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["status"], "failed");
    assert!(
        r.body["error"].as_str().unwrap().contains("not allowed"),
        "{}",
        r.body
    );
    assert_eq!(r.body["log"][0]["status"], "failed");
}

#[tokio::test]
async fn real_test_runs_do_the_work_and_are_recorded() {
    let env = Env::new().await;
    let rec = env.rec(json!({ &env.name: "Grace" }));
    let a = env
        .create(
            "real",
            env.trigger_created(),
            json!([
                { "type": "create_record", "table_id": env.table(), "values": { "Name": "made by test for {{trigger.record.fields.Name}}" } },
                { "type": "http_request", "method": "POST", "url": env.server.url("/real"), "body": "{{steps.1.record_id}}" },
                { "type": "send_email", "to": "x@example.com", "subject": "Hi", "body": "b" }
            ]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    // It works while the automation is switched off too.
    env.f
        .app
        .patch(&env.f.owner, &auto_url(id), json!({ "enabled": false }))
        .await
        .assert_status(200);
    let r = env
        .f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(id)),
            json!({ "dry_run": false }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["dry_run"], false);
    assert_eq!(r.body["status"], "succeeded", "{}", r.body);
    assert_eq!(env.record_count(), 2);
    assert_eq!(env.server.hits().len(), 1);
    assert_eq!(env.f.app.mailer.sent().len(), 1);

    // The run is in the history, flagged as a test, finished.
    let run_id = r.body["run_id"].as_i64().unwrap();
    let run = env.only_run(id).await;
    assert_eq!(run["id"], run_id);
    assert_eq!(run["status"], "succeeded");
    assert_eq!(run["trigger_data"]["test"], true);
    assert_eq!(
        run["trigger_data"]["record"]["id"],
        rec.as_str(),
        "the first record was used"
    );
    assert_eq!(run["log"], r.body["log"]);
}

#[tokio::test]
async fn real_test_runs_report_failures() {
    let env = Env::new().await;
    env.rec(json!({}));
    let a = env
        .create(
            "failing",
            env.trigger_created(),
            json!([{ "type": "http_request", "method": "GET", "url": env.server.url("/status/500") }]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env
        .f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(id)),
            json!({ "dry_run": false }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["status"], "failed");
    assert!(r.body["error"].as_str().unwrap().contains("500"));
    assert_eq!(env.server.hits().len(), 1, "a test run does not retry");
    assert_eq!(env.only_run(id).await["status"], "failed");
}

#[tokio::test]
async fn test_runs_pick_the_requested_record_or_complain() {
    let env = Env::new().await;
    let a = env
        .create(
            "t",
            env.trigger_created(),
            json!([env.notify_action("{{trigger.record.fields.Name}}")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    async fn test(env: &Env, id: &str, body: Value) -> common::Response {
        env.f
            .app
            .post(&env.f.owner, &format!("{}/test", auto_url(id)), body)
            .await
    }
    assert_eq!(
        test(&env, id, json!({})).await.status.as_u16(),
        400,
        "no records to test with"
    );
    let first = env.rec(json!({ &env.name: "first" }));
    let second = env.rec(json!({ &env.name: "second" }));
    let r = test(&env, id, json!({})).await;
    r.assert_status(200);
    assert_eq!(r.body["log"][0]["output"]["message"], "first");
    let r = test(&env, id, json!({ "record_id": second })).await;
    assert_eq!(r.body["log"][0]["output"]["message"], "second");
    let _ = first;

    // Records of other tables or deleted records are refused.
    let other = env.f.add_table("Other").await;
    let foreign = env
        .f
        .insert_record(other["id"].as_str().unwrap(), json!({}));
    assert_eq!(
        test(&env, id, json!({ "record_id": foreign }))
            .await
            .status
            .as_u16(),
        400
    );
    assert_eq!(
        test(&env, id, json!({ "record_id": "recNope" }))
            .await
            .status
            .as_u16(),
        400
    );
    schema_support::trash_record(&env.f.app, &second, 3);
    assert_eq!(
        test(&env, id, json!({ "record_id": second }))
            .await
            .status
            .as_u16(),
        400
    );
}

#[tokio::test]
async fn test_runs_of_webhook_and_schedule_automations_need_no_record() {
    let env = Env::new().await;
    let hook = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([env.notify_action("sku {{trigger.body.sku}}")]),
        )
        .await;
    let r = env
        .f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(hook["id"].as_str().unwrap())),
            json!({ "body": { "sku": "Z9" } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["log"][0]["output"]["message"], "sku Z9");
    // A webhook test without a sample body sees an empty object.
    let r = env
        .f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(hook["id"].as_str().unwrap())),
            json!({}),
        )
        .await;
    assert_eq!(r.body["log"][0]["output"]["message"], "sku ");
    // ...and a record cannot be supplied.
    env.f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(hook["id"].as_str().unwrap())),
            json!({ "record_id": "recX" }),
        )
        .await
        .assert_status(400);

    let sched = env
        .create(
            "sched",
            json!({ "type": "schedule", "cron": "0 8 * * *", "timezone": "UTC" }),
            json!([env.notify_action("{{trigger.type}}")]),
        )
        .await;
    let r = env
        .f
        .app
        .post(
            &env.f.owner,
            &format!("{}/test", auto_url(sched["id"].as_str().unwrap())),
            json!({}),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["log"][0]["output"]["message"], "schedule");
}

#[tokio::test]
async fn test_runs_are_rate_limited() {
    let env = Env::new().await;
    env.rec(json!({}));
    let a = env
        .create("t", env.trigger_created(), json!([env.notify_action("x")]))
        .await;
    let url = format!("{}/test", auto_url(a["id"].as_str().unwrap()));
    let mut last = 0;
    for _ in 0..31 {
        last = env
            .f
            .app
            .post(&env.f.owner, &url, json!({}))
            .await
            .status
            .as_u16();
    }
    assert_eq!(last, 429);
}

// ------------------------------------------------------------ run history

#[tokio::test]
async fn run_history_is_paged_newest_first() {
    let env = Env::new().await;
    let a = env
        .create("c", env.trigger_created(), json!([env.notify_action("x")]))
        .await;
    let id = a["id"].as_str().unwrap();
    let recs: Vec<String> = (0..5).map(|_| env.rec(json!({}))).collect();
    env.fire_created(&recs.iter().map(String::as_str).collect::<Vec<_>>());
    env.drain().await;

    let url = format!("{}/runs", auto_url(id));
    let page1 = env.f.app.get(&env.f.owner, &format!("{url}?limit=2")).await;
    page1.assert_status(200);
    assert_eq!(page1.body["total"], 5);
    let ids1: Vec<i64> = page1.body["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids1.len(), 2);
    assert!(ids1[0] > ids1[1], "newest first");
    let before = page1.body["next_before"].as_i64().unwrap();
    assert_eq!(before, ids1[1]);

    let page2 = env
        .f
        .app
        .get(&env.f.owner, &format!("{url}?limit=2&before={before}"))
        .await;
    let ids2: Vec<i64> = page2.body["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids2.len(), 2);
    assert!(ids2[0] < ids1[1]);
    let page3 = env
        .f
        .app
        .get(
            &env.f.owner,
            &format!("{url}?limit=2&before={}", page2.body["next_before"]),
        )
        .await;
    assert_eq!(page3.body["runs"].as_array().unwrap().len(), 1);
    assert_eq!(page3.body["next_before"], Value::Null, "last page");

    // Defaults and clamping.
    let all = env.f.app.get(&env.f.owner, &url).await;
    assert_eq!(all.body["runs"].as_array().unwrap().len(), 5);
    let huge = env
        .f
        .app
        .get(&env.f.owner, &format!("{url}?limit=100000"))
        .await;
    huge.assert_status(200);
    let zero = env.f.app.get(&env.f.owner, &format!("{url}?limit=0")).await;
    assert_eq!(
        zero.body["runs"].as_array().unwrap().len(),
        1,
        "limit is clamped to at least 1"
    );

    // Each run carries its log.
    let first = &all.body["runs"][0];
    assert_eq!(first["status"], "succeeded");
    assert_eq!(first["log"][0]["action"], "notify");
    assert_eq!(first["automation_id"], id);

    // Runs of another automation are not mixed in.
    let b = env
        .create(
            "other",
            env.trigger_created(),
            json!([env.notify_action("x")]),
        )
        .await;
    let r = env
        .f
        .app
        .get(
            &env.f.owner,
            &format!("{}/runs", auto_url(b["id"].as_str().unwrap())),
        )
        .await;
    assert_eq!(r.body["total"], 0);
}
