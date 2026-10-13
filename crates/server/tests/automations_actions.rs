//! Actions: what each action type does when a run executes, templates,
//! conditions, the step log, retries and the SSRF guard at run time.

mod automations_support;
mod common;
mod schema_support;

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use automations_support::*;
use futures::future::BoxFuture;
use opengrid::automations::runner::Runner;
use opengrid::config::Config;
use opengrid::email::Mailer;
use opengrid::error::{AppError, AppResult};
use serde_json::{Value, json};

fn notifications(env: &Env) -> Vec<(String, Value)> {
    schema_support::sql(&env.f.app, |tx| {
        let mut stmt = tx.prepare("SELECT user_id, payload FROM notifications WHERE kind = 'automation' ORDER BY created_at, id")?;
        let rows = stmt
            .query_map([], |r| {
                let payload: String = r.get(1)?;
                Ok((
                    r.get::<_, String>(0)?,
                    serde_json::from_str(&payload).unwrap(),
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// Create an automation for record_created, fire it for a new record and run it.
async fn run_once(env: &Env, actions: Value, record: Value) -> (String, String, Value) {
    let a = env.create("test", env.trigger_created(), actions).await;
    let id = a["id"].as_str().unwrap().to_string();
    let rec = env.rec(record);
    env.fire_created(&[&rec]);
    env.drain().await;
    let run = env.only_run(&id).await;
    (id, rec, run)
}

// ------------------------------------------------------------- records

#[tokio::test]
async fn create_record_writes_templated_values_and_logs_the_new_id() {
    let env = Env::new().await;
    let mut events = env.f.app.state.events.subscribe(env.base());
    let (_, src, run) = run_once(
        &env,
        json!([{ "type": "create_record", "table_id": env.table(), "values": {
            "Name": "Follow-up for {{trigger.record.fields.Name}}",
            "Amount": "{{trigger.record.fields.Amount}}",
            "Status": "Doing",
            "Finished": true
        } }]),
        json!({ &env.name: "Ada", &env.amount: 12 }),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    assert_eq!(run["attempts"], 1);
    assert_eq!(run["error"], Value::Null);
    let out = &run["log"][0]["output"];
    let new_id = out["record_id"].as_str().unwrap();
    assert_ne!(new_id, src);
    assert_eq!(out["table_id"], env.table());

    let data = env.f.record_data(new_id);
    assert_eq!(data[&env.name], "Follow-up for Ada");
    assert_eq!(data[&env.amount], 12, "text was typecast to a number");
    assert_eq!(
        data[&env.status],
        env.doing.as_str(),
        "choice name resolved to its id"
    );
    assert_eq!(data[&env.done], true);
    assert_eq!(env.record_count(), 2);

    // Subscribers of the base are told about the new record.
    let ev = tokio::time::timeout(std::time::Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&ev.event).unwrap(),
        json!({ "kind": "records_changed", "table_id": env.table(), "created": [new_id], "updated": [], "deleted": [] })
    );
}

#[tokio::test]
async fn create_record_reports_invalid_values_as_a_permanent_failure() {
    let env = Env::new().await;
    // "banana" is not a number: rejected when the action runs (the template
    // hid it from save-time checks).
    let (id, _, run) = run_once(
        &env,
        json!([{ "type": "create_record", "table_id": env.table(),
                 "values": { "Amount": "{{trigger.record.fields.Name}}" } }]),
        json!({ &env.name: "banana" }),
    )
    .await;
    assert_eq!(run["status"], "failed");
    assert_eq!(run["attempts"], 1, "validation errors are not retried");
    assert!(
        run["error"].as_str().unwrap().starts_with("action 1:"),
        "{run:#}"
    );
    assert!(run["error"].as_str().unwrap().contains("Amount"));
    assert_eq!(env.record_count(), 1, "nothing was created");
    assert_eq!(run["log"][0]["status"], "failed");
    assert_eq!(env.run_count(&id), 1);
}

#[tokio::test]
async fn update_record_changes_the_trigger_record_and_chained_steps_see_outputs() {
    let env = Env::new().await;
    let (_, src, run) = run_once(
        &env,
        json!([
            { "type": "create_record", "table_id": env.table(), "values": { "Name": "child" } },
            { "type": "update_record", "table_id": env.table(),
              "record_id": "{{steps.1.record_id}}", "values": { "Amount": 99, "Status": "Todo" } },
            { "type": "update_record", "table_id": env.table(),
              "record_id": "{{trigger.record.id}}", "values": { "Name": "parent of {{steps.1.record_id}}" } }
        ]),
        json!({ &env.name: "parent" }),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let child = run["log"][0]["output"]["record_id"].as_str().unwrap();
    let child_data = env.f.record_data(child);
    assert_eq!(child_data[&env.amount], 99);
    assert_eq!(child_data[&env.status], env.todo.as_str());
    assert_eq!(child_data[&env.name], "child", "other fields untouched");
    assert_eq!(
        env.f.record_data(&src)[&env.name],
        format!("parent of {child}")
    );
    assert_eq!(run["log"][1]["output"]["record_id"], child);
}

#[tokio::test]
async fn update_record_refuses_missing_foreign_and_deleted_records() {
    let env = Env::new().await;
    let other = env.f.add_table("Other").await;
    let other_table = other["id"].as_str().unwrap().to_string();
    let in_other_table = env.f.insert_record(&other_table, json!({}));
    let deleted = env.rec(json!({}));
    schema_support::trash_record(&env.f.app, &deleted, 5);

    // A second base the automation's owner also owns.
    let ws = &env.f.ws;
    let b2 = schema_support::base(&env.f.app, &env.f.owner, ws, "Elsewhere").await;
    let t2 = b2["tables"][0]["id"].as_str().unwrap().to_string();
    let foreign = env.f.insert_record(&t2, json!({}));

    for (what, rid) in [
        ("missing", "recDoesNotExist"),
        ("other table", in_other_table.as_str()),
        ("other base", foreign.as_str()),
        ("deleted", deleted.as_str()),
    ] {
        let a = env
            .create(
                what,
                env.trigger_created(),
                json!([{ "type": "update_record", "table_id": env.table(),
                         "record_id": rid, "values": { "Name": "pwned" } }]),
            )
            .await;
        let r = env.rec(json!({}));
        env.fire_created(&[&r]);
        env.drain().await;
        let run = env.runs(a["id"].as_str().unwrap()).await.pop().unwrap();
        assert_eq!(run["status"], "failed", "{what}: {run:#}");
        assert!(
            run["error"].as_str().unwrap().contains("not found"),
            "{what}: {run:#}"
        );
        // Disable it so later iterations only run their own automation.
        env.f
            .app
            .patch(
                &env.f.owner,
                &format!("/api/automations/{}", a["id"].as_str().unwrap()),
                json!({"enabled": false}),
            )
            .await
            .assert_status(200);
    }
    for rid in [&in_other_table, &foreign, &deleted] {
        assert_eq!(env.f.record_data(rid), json!({}), "untouched");
    }
}

#[tokio::test]
async fn create_record_in_a_table_that_left_the_base_fails_cleanly() {
    let env = Env::new().await;
    let t = env.f.add_table("Doomed").await;
    let tid = t["id"].as_str().unwrap().to_string();
    let a = env
        .create(
            "to doomed",
            env.trigger_created(),
            json!([{ "type": "create_record", "table_id": tid, "values": {} }]),
        )
        .await;
    env.f
        .app
        .delete(&env.f.owner, &format!("/api/tables/{tid}"))
        .await
        .assert_status(200);
    let r = env.rec(json!({}));
    env.fire_created(&[&r]);
    env.drain().await;
    let run = env.only_run(a["id"].as_str().unwrap()).await;
    assert_eq!(run["status"], "failed");
    assert!(
        run["error"].as_str().unwrap().contains("no longer exists"),
        "{run:#}"
    );
}

// --------------------------------------------------------- conditions

#[tokio::test]
async fn conditions_skip_actions_that_do_not_match_the_trigger_record() {
    let env = Env::new().await;
    let a = env
        .create(
            "conditional",
            env.trigger_created(),
            json!([
                { "condition": env.status_is(&env.doing), "type": "notify",
                  "user_ids": [env.f.owner.user_id.clone().unwrap()], "message": "only doing" },
                env.notify_action("always"),
                { "condition": env.status_is(&env.todo), "type": "notify",
                  "user_ids": [env.f.owner.user_id.clone().unwrap()], "message": "only todo" }
            ]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let doing = env.rec(json!({ &env.status: env.doing }));
    let todo = env.rec(json!({ &env.status: env.todo }));
    env.fire_created(&[&doing, &todo]);
    env.drain().await;

    let runs = env.runs(id).await;
    assert_eq!(
        log_summary(&runs[0]),
        ["notify:succeeded", "notify:succeeded", "notify:skipped"]
    );
    assert_eq!(
        log_summary(&runs[1]),
        ["notify:skipped", "notify:succeeded", "notify:succeeded"]
    );
    assert!(runs.iter().all(|r| r["status"] == "succeeded"));
    let msgs: Vec<String> = notifications(&env)
        .iter()
        .map(|(_, p)| p["message"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(msgs, ["only doing", "always", "always", "only todo"]);
}

#[tokio::test]
async fn conditions_see_the_record_as_it_was_at_trigger_time() {
    let env = Env::new().await;
    let a = env
        .create(
            "snapshot",
            env.trigger_created(),
            json!([{ "condition": env.status_is(&env.doing), "type": "notify",
                     "user_ids": [env.f.owner.user_id.clone().unwrap()], "message": "x" }]),
        )
        .await;
    let r = env.rec(json!({ &env.status: env.doing }));
    env.fire_created(&[&r]);
    // The record changes before the runner gets to it; the run still sees the snapshot.
    env.set_data(&r, json!({ &env.status: env.todo }));
    env.drain().await;
    let run = env.only_run(a["id"].as_str().unwrap()).await;
    assert_eq!(log_summary(&run), ["notify:succeeded"]);
}

// ----------------------------------------------------------- templates

#[tokio::test]
async fn webhook_bodies_feed_templates_with_types_preserved() {
    let env = Env::new().await;
    let a = env
        .create(
            "order hook",
            json!({ "type": "webhook" }),
            json!([
                { "type": "create_record", "table_id": env.table(), "values": {
                    "Name": "{{trigger.body.customer.name}} ({{trigger.body.items.1.sku}})",
                    "Amount": "{{trigger.body.total}}"
                } },
                env.notify_action("created {{steps.1.record_id}} for {{trigger.body.customer.name}}; missing=[{{trigger.body.nope.deeper}}] type={{trigger.type}}")
            ]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    env.queue_run(
        id,
        json!({ "type": "webhook", "time": 1_700_000_000_000i64, "body": {
            "customer": { "name": "Grace" }, "items": [ { "sku": "A1" }, { "sku": "B2" } ], "total": 12 } }),
    );
    env.drain().await;
    let run = env.only_run(id).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let new_id = run["log"][0]["output"]["record_id"].as_str().unwrap();
    let data = env.f.record_data(new_id);
    assert_eq!(data[&env.name], "Grace (B2)");
    assert_eq!(data[&env.amount], 12, "a JSON number stays a number");
    let msg = notifications(&env).pop().unwrap().1["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        msg,
        format!("created {new_id} for Grace; missing=[] type=webhook")
    );
}

#[tokio::test]
async fn substituted_text_is_never_interpreted_again() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([env.notify_action("[{{trigger.record.fields.Name}}]")]),
        json!({ &env.name: "{{trigger.record.id}} {{steps.1.x}} ${HOME} $(whoami) `id`" }),
    )
    .await;
    assert_eq!(run["status"], "succeeded");
    assert_eq!(
        notifications(&env)[0].1["message"],
        "[{{trigger.record.id}} {{steps.1.x}} ${HOME} $(whoami) `id`]"
    );
}

// ------------------------------------------------------------- log shape

#[tokio::test]
async fn the_step_log_describes_every_action() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([
            env.notify_action("one"),
            { "type": "http_request", "method": "GET", "url": env.server.url("/status/404") },
            env.notify_action("never runs")
        ]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "failed");
    let log = run["log"].as_array().unwrap();
    assert_eq!(
        log.len(),
        2,
        "no line for the action after the failure: {run:#}"
    );
    assert_eq!(log[0]["index"], 0);
    assert_eq!(log[0]["action"], "notify");
    assert_eq!(log[0]["status"], "succeeded");
    assert_eq!(log[0]["attempt"], 1);
    assert!(log[0]["duration_ms"].as_i64().unwrap() >= 0);
    assert_eq!(log[0]["output"]["notified"], 1);
    assert_eq!(log[0]["error"], Value::Null);
    assert_eq!(log[1]["index"], 1);
    assert_eq!(log[1]["action"], "http_request");
    assert_eq!(log[1]["status"], "failed");
    assert!(log[1]["error"].as_str().unwrap().contains("404"));
    assert_eq!(
        log[1]["output"]["status"], 404,
        "the response is kept for debugging"
    );
    assert_eq!(
        run["error"],
        "action 2: the server answered with HTTP status 404"
    );
    assert!(run["started_at"].as_i64().unwrap() > 0);
    assert!(run["finished_at"].as_i64().unwrap() >= run["started_at"].as_i64().unwrap());
}

// --------------------------------------------------------------- notify

#[tokio::test]
async fn notify_reaches_users_with_access_and_skips_the_rest() {
    let env = Env::new().await;
    let editor = env.f.member("ed@example.com", opengrid::perm::Role::Editor);
    let outsider = env.f.app.user("out@example.com", "Out");
    let owner_id = env.f.owner.user_id.clone().unwrap();
    let ed_id = editor.user_id.clone().unwrap();
    let out_id = outsider.user_id.clone().unwrap();
    // The API refuses to save a notify action for an outsider; a user who lost
    // access after saving is skipped when it runs.
    let id = env.insert_raw(
        env.trigger_created(),
        json!([{ "type": "notify", "user_ids": [owner_id, ed_id, out_id, "usrGone"],
                 "message": "Record {{trigger.record.id}} arrived" }]),
        true,
    );
    let r = env.rec(json!({}));
    env.queue_record_run(&id, "record_created", &r);
    env.drain().await;
    let run = env.only_run(&id).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    assert_eq!(run["log"][0]["output"]["notified"], 2);
    assert_eq!(
        run["log"][0]["output"]["skipped"],
        json!([out_id, "usrGone"])
    );
    let n = notifications(&env);
    assert_eq!(
        n.iter().map(|(u, _)| u.as_str()).collect::<Vec<_>>(),
        [owner_id.as_str(), ed_id.as_str()]
    );
    assert_eq!(n[0].1["message"], format!("Record {r} arrived"));
    assert_eq!(n[0].1["automation_id"], id.as_str());
    assert_eq!(n[0].1["base_id"], env.base());
    assert_eq!(n[0].1["record_id"], r.as_str());
    assert_eq!(n[0].1["run_id"], run["id"]);
}

// ---------------------------------------------------------------- email

#[tokio::test]
async fn send_email_renders_recipients_subject_and_body() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([{ "type": "send_email",
                 "to": "{{trigger.record.fields.Name}}@example.com, boss@example.com; ops@example.com",
                 "subject": "Hello {{trigger.record.fields.Name}}\r\nBcc: attacker@example.com",
                 "body": "Amount: {{trigger.record.fields.Amount}}\nRecord {{trigger.record.id}}" }]),
        json!({ &env.name: "ada", &env.amount: 42 }),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let sent = env.f.app.mailer.sent();
    assert_eq!(sent.len(), 3);
    assert_eq!(
        sent.iter().map(|m| m.to.as_str()).collect::<Vec<_>>(),
        ["ada@example.com", "boss@example.com", "ops@example.com"]
    );
    for m in &sent {
        assert_eq!(
            m.subject, "Hello ada  Bcc: attacker@example.com",
            "line breaks in headers are neutralized"
        );
        assert!(m.body.starts_with("Amount: 42\nRecord rec"));
    }
    assert_eq!(
        run["log"][0]["output"]["sent_to"],
        json!(["ada@example.com", "boss@example.com", "ops@example.com"])
    );
}

#[tokio::test]
async fn send_email_with_a_bad_substituted_address_fails_without_sending() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([{ "type": "send_email", "to": "{{trigger.record.fields.Name}}", "subject": "s", "body": "b" }]),
        json!({ &env.name: "not an address" }),
    )
    .await;
    assert_eq!(run["status"], "failed");
    assert_eq!(run["attempts"], 1);
    assert!(
        run["error"]
            .as_str()
            .unwrap()
            .contains("not a valid email address"),
        "{run:#}"
    );
    assert!(env.f.app.mailer.sent().is_empty());
}

#[tokio::test]
async fn send_email_fails_when_smtp_is_not_configured() {
    let env = Env::with_config(|c| c.smtp_host = None).await;
    // Saving is refused...
    let r = env
        .try_create(
            "mail",
            env.trigger_created(),
            json!([{ "type": "send_email", "to": "a@example.com", "subject": "s", "body": "b" }]),
            true,
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not configured")
    );
    // ...and a definition that exists anyway fails its run.
    let id = env.insert_raw(
        env.trigger_created(),
        json!([{ "type": "send_email", "to": "a@example.com", "subject": "s", "body": "b" }]),
        true,
    );
    let rec = env.rec(json!({}));
    env.queue_record_run(&id, "record_created", &rec);
    env.drain().await;
    let run = env.only_run(&id).await;
    assert_eq!(run["status"], "failed");
    assert_eq!(run["attempts"], 1);
    assert!(run["error"].as_str().unwrap().contains("not configured"));
    assert!(env.f.app.mailer.sent().is_empty());
}

/// Fails the first `failures` sends, then delivers.
struct FlakyMailer {
    failures: u32,
    calls: AtomicU32,
    inner: opengrid::email::CapturingMailer,
}

impl Mailer for FlakyMailer {
    fn send<'a>(
        &'a self,
        to: &'a str,
        subject: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, AppResult<()>> {
        Box::pin(async move {
            if self.calls.fetch_add(1, Ordering::SeqCst) < self.failures {
                return Err(AppError::internal(
                    "connection to the mail server was reset",
                ));
            }
            self.inner.send(to, subject, body).await
        })
    }
}

#[tokio::test]
async fn mail_server_trouble_is_retried() {
    let mut env = Env::new().await;
    let mailer = Arc::new(FlakyMailer {
        failures: 2,
        calls: AtomicU32::new(0),
        inner: Default::default(),
    });
    env.f.app.state.mailer = mailer.clone();
    env.runner = Runner::new(
        env.f.app.state.clone(),
        instant_opts(),
    );
    let (_, _, run) = run_once(
        &env,
        json!([{ "type": "send_email", "to": "a@example.com", "subject": "s", "body": "b" }]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    assert_eq!(run["attempts"], 3);
    assert_eq!(mailer.inner.sent().len(), 1);
    assert_eq!(
        log_summary(&run),
        [
            "send_email:failed",
            "send_email:failed",
            "send_email:succeeded"
        ]
    );
    assert_eq!(run["log"][0]["attempt"], 1);
    assert_eq!(run["log"][2]["attempt"], 3);
}

// ----------------------------------------------------------------- http

#[tokio::test]
async fn http_request_sends_what_was_configured_with_safe_substitution() {
    let env = Env::new().await;
    let tricky = "Ada \"The Countess\" \\ Lovelace & co/../x";
    let (_, rec, run) = run_once(
        &env,
        json!([{ "type": "http_request", "method": "POST",
                 "url": env.server.url("/hook/{{trigger.record.id}}?name={{trigger.record.fields.Name}}"),
                 "headers": { "X-Api-Key": "key-{{trigger.record.id}}" },
                 "body": "{\"name\": \"{{trigger.record.fields.Name}}\", \"id\": \"{{trigger.record.id}}\", \"n\": {{trigger.record.fields.Amount}}}" }]),
        json!({ &env.name: tricky, &env.amount: 3 }),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let hits = env.server.hits();
    assert_eq!(hits.len(), 1);
    let h = &hits[0];
    assert_eq!(h.method, "POST");
    assert_eq!(h.path, format!("/hook/{rec}"));
    assert_eq!(
        h.query, "name=Ada%20%22The%20Countess%22%20%5C%20Lovelace%20%26%20co%2F..%2Fx",
        "values are percent-encoded in URLs"
    );
    assert_eq!(h.headers["x-api-key"], format!("key-{rec}"));
    assert_eq!(h.headers["user-agent"], "OpenGrid-Automations");
    assert_eq!(h.headers["content-type"], "application/json");
    let body: Value = serde_json::from_str(&h.body).expect("the JSON body stays valid JSON");
    assert_eq!(body, json!({ "name": tricky, "id": rec, "n": 3 }));
    let out = &run["log"][0]["output"];
    assert_eq!(out["status"], 200);
    assert_eq!(out["json"], json!({ "ok": true }));
    assert_eq!(out["body"], "{\"ok\":true}");
}

#[tokio::test]
async fn http_request_supports_all_methods_and_plain_text_bodies() {
    let env = Env::new().await;
    let actions: Vec<Value> = ["GET", "POST", "PUT", "PATCH", "DELETE"]
        .iter()
        .map(|m| {
            let mut a = json!({ "type": "http_request", "method": m, "url": env.server.url(&format!("/m/{m}")) });
            if *m != "GET" {
                a["body"] = json!("hello {{trigger.record.id}}");
            }
            a
        })
        .collect();
    let (_, rec, run) = run_once(&env, json!(actions), json!({})).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let hits = env.server.hits();
    assert_eq!(
        hits.iter().map(|h| h.method.as_str()).collect::<Vec<_>>(),
        ["GET", "POST", "PUT", "PATCH", "DELETE"]
    );
    assert_eq!(hits[0].body, "");
    assert_eq!(hits[1].body, format!("hello {rec}"));
    assert_eq!(hits[1].headers["content-type"], "text/plain; charset=utf-8");
}

#[tokio::test]
async fn later_steps_can_use_the_response_of_an_http_request() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([
            { "type": "http_request", "method": "GET", "url": env.server.url("/json") },
            { "type": "create_record", "table_id": env.table(), "values": {
                "Name": "{{steps.1.json.name}} #{{steps.1.json.id}}",
                "Amount": "{{steps.1.json.id}}" } },
            env.notify_action("status {{steps.1.status}}, body {{steps.1.body}}")
        ]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let new_id = run["log"][1]["output"]["record_id"].as_str().unwrap();
    let data = env.f.record_data(new_id);
    assert_eq!(data[&env.name], "Widget #7");
    assert_eq!(data[&env.amount], 7);
    assert_eq!(
        notifications(&env)[0].1["message"],
        "status 200, body {\"id\":7,\"name\":\"Widget\"}"
    );
}

#[tokio::test]
async fn http_redirects_are_not_followed() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([{ "type": "http_request", "method": "GET", "url": env.server.url("/redirect") }]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "succeeded");
    assert_eq!(run["log"][0]["output"]["status"], 302);
    assert_eq!(
        env.server.hits().len(),
        1,
        "the Location target was not requested"
    );
}

#[tokio::test]
async fn http_response_bodies_are_capped_at_256_kb() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([
            { "type": "http_request", "method": "GET", "url": env.server.url("/big") },
            env.notify_action("{{steps.1.truncated}}:{{steps.1.status}}")
        ]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let out = &run["log"][0]["output"];
    assert_eq!(out["truncated"], true);
    // The log keeps an even shorter copy.
    assert_eq!(out["body"].as_str().unwrap().len(), 20_000);
    assert_eq!(notifications(&env)[0].1["message"], "true:200");
}

#[tokio::test]
async fn client_errors_fail_the_run_without_retrying() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([{ "type": "http_request", "method": "POST", "url": env.server.url("/status/400"), "body": "x" }]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "failed");
    assert_eq!(run["attempts"], 1);
    assert_eq!(env.server.hits().len(), 1);
}

#[tokio::test]
async fn server_errors_are_retried_and_finished_steps_are_not_repeated() {
    let env = Env::new().await;
    let (_, _, run) = run_once(
        &env,
        json!([
            { "type": "create_record", "table_id": env.table(), "values": { "Name": "side effect" } },
            { "type": "http_request", "method": "POST", "url": env.server.url("/flaky/k1/2/503"), "body": "{}" },
            env.notify_action("after {{steps.2.json.id}}")
        ]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    assert_eq!(run["attempts"], 3);
    assert_eq!(env.server.hits().len(), 3);
    assert_eq!(
        env.record_count(),
        2,
        "the record was created once, not once per attempt"
    );
    assert_eq!(
        log_summary(&run),
        [
            "create_record:succeeded",
            "http_request:failed",
            "http_request:failed",
            "http_request:succeeded",
            "notify:succeeded"
        ]
    );
    assert_eq!(run["log"][1]["attempt"], 1);
    assert_eq!(run["log"][2]["attempt"], 2);
    assert_eq!(run["log"][3]["attempt"], 3);
    assert!(
        run["log"][1]["retry_at"].as_i64().unwrap() > 0,
        "failed lines say they will be retried"
    );
    assert_eq!(run["log"][3]["retry_at"], Value::Null);
    // The resumed run still had the earlier step's output and the new response.
    assert_eq!(notifications(&env)[0].1["message"], "after 42");
}

#[tokio::test]
async fn persistent_server_errors_give_up_after_three_attempts() {
    let env = Env::new().await;
    for code in [500, 503, 429, 408] {
        let env_url = env.server.url(&format!("/status/{code}"));
        let a = env
            .create(
                &format!("always {code}"),
                env.trigger_created(),
                json!([{ "type": "http_request", "method": "GET", "url": env_url }]),
            )
            .await;
        let id = a["id"].as_str().unwrap();
        let before = env.server.hits_on(&format!("/status/{code}")).len();
        let r = env.rec(json!({}));
        env.fire_created(&[&r]);
        env.drain().await;
        let run = env.runs(id).await.pop().unwrap();
        assert_eq!(run["status"], "failed", "{code}: {run:#}");
        assert_eq!(run["attempts"], 3, "{code}");
        assert_eq!(
            env.server.hits_on(&format!("/status/{code}")).len() - before,
            3,
            "{code}"
        );
        assert!(
            run["error"]
                .as_str()
                .unwrap()
                .contains("gave up after 3 attempts"),
            "{code}"
        );
        env.f
            .app
            .patch(
                &env.f.owner,
                &format!("/api/automations/{id}"),
                json!({"enabled": false}),
            )
            .await
            .assert_status(200);
    }
}

#[tokio::test]
async fn connection_failures_are_transient() {
    let env = Env::new().await;
    // A port nothing listens on.
    let closed = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (_, _, run) = run_once(
        &env,
        json!([{ "type": "http_request", "method": "GET", "url": format!("http://127.0.0.1:{closed}/") }]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "failed");
    assert_eq!(run["attempts"], 3);
    assert!(
        run["error"].as_str().unwrap().contains("could not connect"),
        "{run:#}"
    );
}

#[tokio::test]
async fn a_retry_waits_for_its_back_off() {
    let env = Env::new().await;
    let runner = Runner::new(
        env.f.app.state.clone(),
        opengrid::automations::runner::RunnerOpts {
            retry_delays: [
                std::time::Duration::from_secs(3600),
                std::time::Duration::from_secs(3600),
            ],
            ..instant_opts()
        },
    );
    let a = env
        .create(
            "slow retry",
            env.trigger_created(),
            json!([{ "type": "http_request", "method": "GET", "url": env.server.url("/status/503") }]),
        )
        .await;
    let r = env.rec(json!({}));
    env.fire_created(&[&r]);
    assert_eq!(runner.drain().await.unwrap(), 1, "first attempt");
    let run = env.only_run(a["id"].as_str().unwrap()).await;
    assert_eq!(run["status"], "queued", "waiting to retry");
    assert!(
        run["log"][0]["retry_at"].as_i64().unwrap()
            > chrono::Utc::now().timestamp_millis() + 3_000_000
    );
    assert_eq!(
        runner.drain().await.unwrap(),
        0,
        "not claimable before retry_at"
    );
    assert_eq!(env.server.hits().len(), 1);
}

// ----------------------------------------------------------------- SSRF

#[tokio::test]
async fn the_guard_blocks_internal_targets_at_run_time() {
    let env = Env::with_config(|c| c.allow_private_webhooks = false).await;
    let port = env.server.addr.port();
    let urls = [
        format!("http://127.0.0.1:{port}/secret"),
        format!("http://localhost:{port}/secret"),
        format!("http://[::1]:{port}/secret"),
        format!("http://[::ffff:127.0.0.1]:{port}/secret"),
        format!("http://2130706433:{port}/secret"),
        format!("http://0x7f.0.0.1:{port}/secret"),
        "http://10.0.0.5/admin".to_string(),
        "http://192.168.1.1/".to_string(),
        "http://172.16.0.9/".to_string(),
        "http://169.254.169.254/latest/meta-data/".to_string(),
        "http://100.64.0.1/".to_string(),
        "http://0.0.0.0/".to_string(),
        "http://[fd00::1]/".to_string(),
        "http://[fe80::1]/".to_string(),
        "ftp://example.com/file".to_string(),
        "file:///etc/passwd".to_string(),
        "gopher://example.com/".to_string(),
        "http://user:pass@example.com/".to_string(),
    ];
    for url in urls {
        let id = env.insert_raw(
            env.trigger_created(),
            json!([{ "type": "http_request", "method": "GET", "url": url }]),
            true,
        );
        let rec = env.rec(json!({}));
        env.queue_record_run(&id, "record_created", &rec);
        env.drain().await;
        let run = env.only_run(&id).await;
        assert_eq!(run["status"], "failed", "{url} must be refused: {run:#}");
        assert_eq!(run["attempts"], 1, "{url}: refusals are permanent");
        let err = run["error"].as_str().unwrap();
        assert!(
            err.contains("not allowed") || err.contains("only http"),
            "{url}: unexpected error {err}"
        );
    }
    assert!(
        env.server.hits().is_empty(),
        "nothing reached the local server"
    );
}

#[tokio::test]
async fn private_targets_work_when_the_operator_allows_them() {
    let env = Env::with_config(|c| c.allow_private_webhooks = true).await;
    let (_, _, run) = run_once(
        &env,
        json!([{ "type": "http_request", "method": "GET",
                 "url": format!("http://localhost:{}/ok", env.server.addr.port()) }]),
        json!({}),
    )
    .await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    assert_eq!(env.server.hits().len(), 1);
}

#[tokio::test]
async fn connections_are_pinned_to_the_vetted_address() {
    // "pinned.test" does not exist in DNS: the request only works because the
    // client connects to the address our resolver returned, which proves the
    // vetted address (not a second lookup) is what gets used.
    use opengrid::automations::{http, ssrf};
    use std::net::SocketAddr;
    struct Fixed(std::net::IpAddr);
    impl ssrf::Resolver for Fixed {
        fn resolve<'a>(
            &'a self,
            _host: &'a str,
            port: u16,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>,
        > {
            let addr = SocketAddr::new(self.0, port);
            Box::pin(async move { Ok(vec![addr]) })
        }
    }
    let server = TestServer::start().await;
    let req = |url: String| http::Request {
        method: og_core::api::automations::HttpMethod::Get,
        url,
        headers: vec![],
        body: None,
    };
    let url = format!("http://pinned.test:{}/x", server.addr.port());

    let ok = http::send_with(req(url.clone()), true, &Fixed("127.0.0.1".parse().unwrap()))
        .await
        .unwrap();
    assert_eq!(ok.status, 200);
    assert_eq!(
        server.hits()[0].headers["host"],
        format!("pinned.test:{}", server.addr.port())
    );

    // The same name resolving to loopback is refused when private targets are off.
    let err = http::send_with(req(url), false, &Fixed("127.0.0.1".parse().unwrap()))
        .await
        .unwrap_err();
    assert!(err.message.contains("not allowed"), "{}", err.message);
    assert!(!err.transient);
    assert_eq!(server.hits().len(), 1);
}

// ------------------------------------------------------ misc execution

#[tokio::test]
async fn a_run_of_a_deleted_automation_disappears_with_it() {
    let env = Env::new().await;
    let a = env
        .create("c", env.trigger_created(), json!([env.notify_action("x")]))
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({}));
    env.fire_created(&[&r]);
    assert_eq!(env.run_count(id), 1);
    env.f
        .app
        .delete(&env.f.owner, &format!("/api/automations/{id}"))
        .await
        .assert_status(200);
    assert_eq!(env.run_count(id), 0);
    assert_eq!(env.drain().await, 0);
}

#[tokio::test]
async fn config_default_is_to_refuse_private_targets() {
    // Guards against flipping the default by accident.
    let c = Config::for_tests(std::path::Path::new("/tmp/unused"));
    assert!(!c.allow_private_webhooks);
}
