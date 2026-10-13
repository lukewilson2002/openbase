//! Automations end to end, through the real router and the real record write
//! engine: an API write fires a trigger, the runner executes the actions with
//! `engine::write`, and the effects show up where users look (view queries,
//! the SSE stream, history).
//!
//! Nothing here fires the trigger hook by hand: every trigger is produced by
//! an ordinary API request (or the webhook / schedule entry points).

mod automations_support;
mod common;
mod query_support;
mod records_support;
mod schema_support;
mod sse_support;

use std::time::Duration;

use automations_support::*;
use og_core::api::events::{BaseEvent, EventEnvelope};
use query_support::*;
use serde_json::{Value, json};
use sse_support::open;

/// A second table "Log" with a number `Amount` and the formula `Double`.
struct Log {
    id: String,
    view: String,
    name: String,
    amount: String,
    double: String,
}

async fn log_table(env: &Env) -> Log {
    let f = &env.f;
    let t = f.add_table("Log").await;
    let id = id_of(&t);
    let amount = id_of(&f.number(&id, "Amount").await);
    let double = id_of(&f.formula(&id, "Double", "{Amount} * 2").await);
    Log {
        view: id_of(&t["views"][0]),
        name: t["primary_field_id"].as_str().unwrap().to_string(),
        id,
        amount,
        double,
    }
}

/// Record ids of an events batch for `table`, collected from a bus receiver.
fn drain_events(
    rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<EventEnvelope>>,
) -> Vec<BaseEvent> {
    let mut out = Vec::new();
    while let Ok(env) = rx.try_recv() {
        out.push(env.event.clone());
    }
    out
}

fn created_in(events: &[BaseEvent], table: &str) -> Vec<String> {
    events
        .iter()
        .flat_map(|e| match e {
            BaseEvent::RecordsChanged {
                table_id, created, ..
            } if table_id == table => created.clone(),
            _ => vec![],
        })
        .collect()
}

fn updated_in(events: &[BaseEvent], table: &str) -> Vec<String> {
    events
        .iter()
        .flat_map(|e| match e {
            BaseEvent::RecordsChanged {
                table_id, updated, ..
            } if table_id == table => updated.clone(),
            _ => vec![],
        })
        .collect()
}

async fn api_create(env: &Env, values: Value) -> String {
    id_str(&env.f.create(env.table(), values).await["id"])
}

async fn api_set(env: &Env, id: &str, values: Value) {
    env.f.set(env.table(), id, values).await;
}

// ------------------------------------------------------------- the chain

#[tokio::test]
async fn api_create_fires_an_automation_that_writes_another_table_with_recompute_event_and_view() {
    let env = Env::new().await;
    let log = log_table(&env).await;
    let a = env
        .create(
            "mirror",
            env.trigger_created(),
            json!([{ "type": "create_record", "table_id": log.id, "values": {
                "Name": "log of {{trigger.record.fields.Name}}",
                "Amount": "{{trigger.record.fields.Amount}}"
            } }]),
        )
        .await;
    let aid = a["id"].as_str().unwrap();

    // The view is queried first so its result is cached; the automation's
    // write must invalidate that cache by publishing its events.
    let before = env.f.query_view(&log.view, json!({})).await;
    assert_eq!(before["total"], 0);

    // A real SSE client on the base.
    let mut sse = open(&env.f.app, &env.f.owner, env.base()).await.stream();
    sse.next_msg(sse_support::SOON).await.unwrap().unwrap(); // greeting

    let src = api_create(&env, json!({ &env.name: "Ada", &env.amount: 12 })).await;

    // The API response already published the source table's event.
    let (name, data) = sse.next_event().await;
    assert_eq!(name, "records_changed");
    assert_eq!(data["event"]["table_id"], env.table());
    assert_eq!(data["event"]["created"], json!([src]));

    // The trigger only queued a run; nothing else happened yet.
    let queued = env.runs(aid).await;
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["status"], "queued");
    assert_eq!(queued[0]["trigger_data"]["type"], "record_created");
    assert_eq!(env.f.query_view(&log.view, json!({})).await["total"], 0);

    assert_eq!(env.drain().await, 1);
    let run = env.only_run(aid).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let log_rec = id_str(&run["log"][0]["output"]["record_id"]);

    // The SSE client is told about the automation's write.
    let (name, data) = sse.next_event().await;
    assert_eq!(name, "records_changed");
    assert_eq!(data["event"]["table_id"], log.id);
    assert_eq!(data["event"]["created"], json!([log_rec]));
    assert_eq!(data["user_id"], env.f.owner.user_id.clone().unwrap());
    assert_eq!(data["client_id"], Value::Null);

    // The view query reflects it, computed field included.
    let after = env.f.query_view(&log.view, json!({})).await;
    assert_eq!(after["total"], 1, "the cached result was invalidated");
    let rec = &after["records"][0];
    assert_eq!(rec["id"], log_rec.as_str());
    assert_eq!(rec["values"][&log.name], "log of Ada");
    assert_eq!(rec["values"][&log.amount], 12);
    assert_eq!(rec["values"][&log.double], 24, "recomputed by the engine");
    assert_eq!(rec["created_by"], env.f.owner.user_id.clone().unwrap());

    // And it left the same traces as an API write: history.
    let hist = env.f.history(&log_rec);
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].0, "create");
    assert_eq!(hist[0].2, env.f.owner.user_id);

    // The loop stopped there: one run, one log record.
    assert_eq!(env.drain().await, 0);
    assert_eq!(env.run_count(aid), 1);
    assert_eq!(env.record_count(), 1);
}

#[tokio::test]
async fn an_update_action_recomputes_dependents_and_tells_subscribers() {
    let env = Env::new().await;
    let log = log_table(&env).await;
    let existing = env
        .f
        .create(&log.id, json!({ &log.name: "row", &log.amount: 1 }))
        .await;
    let log_rec = id_str(&existing["id"]);
    assert_eq!(existing["values"][&log.double], 2);

    let a = env
        .create(
            "push",
            env.trigger_created(),
            json!([{ "type": "update_record", "table_id": log.id, "record_id": log_rec,
                     "values": { "Amount": "{{trigger.record.fields.Amount}}" } }]),
        )
        .await;
    let mut rx = env.f.app.state.events.subscribe(env.base());
    // Cache the view, then let the automation change the record.
    assert_eq!(
        env.f.query_view(&log.view, json!({})).await["records"][0]["values"][&log.double],
        2
    );
    api_create(&env, json!({ &env.name: "x", &env.amount: 21 })).await;
    env.drain().await;
    let run = env.only_run(a["id"].as_str().unwrap()).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");

    let resp = env.f.query_view(&log.view, json!({})).await;
    assert_eq!(resp["records"][0]["values"][&log.amount], 21);
    assert_eq!(resp["records"][0]["values"][&log.double], 42);
    assert_eq!(
        updated_in(&drain_events(&mut rx), &log.id),
        std::slice::from_ref(&log_rec)
    );
    let hist = env.f.history(&log_rec);
    assert_eq!(hist.len(), 2, "create + the automation's update");
    assert_eq!(hist[1].0, "update");
}

#[tokio::test]
async fn actions_behave_like_api_writes_typecast_links_and_choices() {
    let env = Env::new().await;
    // A link field to a second table (with inverse), and a select whose
    // choices the action extends by name.
    let log = log_table(&env).await;
    let link = env.f.add_link(env.table(), "Logs", &log.id).await;
    let link_id = id_of(&link);
    let inverse = id_of(&link["inverse"]);
    let a = env
        .create(
            "typecast",
            env.trigger_created(),
            json!([{ "type": "create_record", "table_id": env.table(), "values": {
                "Name": "child of {{trigger.record.fields.Name}}",
                "Status": "Brand New",
                "Amount": "{{trigger.record.fields.Name}}"
            } }]),
        )
        .await;
    let aid = a["id"].as_str().unwrap().to_string();
    let mut rx = env.f.app.state.events.subscribe(env.base());
    api_create(&env, json!({ &env.name: "p", &env.amount: 3 })).await;
    env.drain().await;
    let run = env.only_run(&aid).await;
    // The name "p" is not a number: rejected exactly like the API would.
    assert_eq!(run["status"], "failed", "{run:#}");
    assert!(run["error"].as_str().unwrap().contains("Amount"), "{run:#}");
    assert_eq!(env.record_count(), 1);
    // Nothing leaked from the failed write: the transaction rolled back, so
    // the new choice does not exist either.
    let status = env.f.field(env.table(), "Status").await;
    assert_eq!(status["options"]["choices"].as_array().unwrap().len(), 3);
    drain_events(&mut rx);

    // Fix the definition; now the choice is created and the link maintained.
    env.f
        .app
        .patch(
            &env.f.owner,
            &format!("/api/automations/{aid}"),
            json!({ "actions": [
                { "type": "create_record", "table_id": env.table(), "values": {
                    "Name": "child of {{trigger.record.fields.Name}}",
                    "Status": "Brand New", "Amount": "15" } },
                { "type": "create_record", "table_id": log.id, "values": { "Name": "l" } },
                { "type": "update_record", "table_id": env.table(),
                  "record_id": "{{trigger.record.id}}",
                  "values": { link_id.as_str(): ["{{steps.2.record_id}}"] } },
            ] }),
        )
        .await
        .assert_status(200);
    let parent = api_create(&env, json!({ &env.name: "q" })).await;
    env.drain().await;
    let runs = env.runs(&aid).await;
    let run = runs.last().unwrap();
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let child = id_str(&run["log"][0]["output"]["record_id"]);
    let log_rec = id_str(&run["log"][1]["output"]["record_id"]);

    let child_rec = env.f.get(env.table(), &child).await;
    assert_eq!(child_rec["values"][&env.amount], 15);
    let status = env.f.field(env.table(), "Status").await;
    let choices = status["options"]["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 4, "typecast created the choice");
    assert_eq!(child_rec["values"][&env.status], choices[3]["id"]);

    // Link pair maintained on both sides.
    let parent_rec = env.f.get(env.table(), &parent).await;
    assert_eq!(
        link_ids_of(&parent_rec["values"][&link_id]),
        std::slice::from_ref(&log_rec)
    );
    let log_row = env.f.get(&log.id, &log_rec).await;
    assert_eq!(
        link_ids_of(&log_row["values"][&inverse]),
        std::slice::from_ref(&parent)
    );

    // Events: a schema change for the new choice, records for both tables.
    let events = drain_events(&mut rx);
    assert!(
        events.iter().any(
            |e| matches!(e, BaseEvent::SchemaChanged { table_id: Some(t) } if t == env.table())
        ),
        "{events:?}"
    );
    assert_eq!(created_in(&events, &log.id), std::slice::from_ref(&log_rec));
    assert!(created_in(&events, env.table()).contains(&child));
    assert!(
        updated_in(&events, &log.id).contains(&log_rec),
        "{events:?}"
    );
    // History for the link edit.
    assert!(env.f.history(&parent).iter().any(|h| h.0 == "update"));
}

// ------------------------------------------------------------- triggers

#[tokio::test]
async fn record_updated_with_a_field_filter_through_the_api() {
    let env = Env::new().await;
    let log = log_table(&env).await;
    let watch_amount = env
        .create(
            "amount changed",
            env.trigger_updated(&[&env.amount]),
            json!([{ "type": "create_record", "table_id": log.id,
                     "values": { "Name": "amount: {{trigger.record.fields.Name}}" } }]),
        )
        .await;
    let any = env
        .create(
            "anything changed",
            env.trigger_updated(&[]),
            json!([env.notify_action("changed")]),
        )
        .await;
    let (wa, any) = (
        watch_amount["id"].as_str().unwrap().to_string(),
        any["id"].as_str().unwrap().to_string(),
    );

    let r = api_create(&env, json!({ &env.name: "Ada", &env.amount: 1 })).await;
    env.drain().await;
    assert_eq!(
        (env.run_count(&wa), env.run_count(&any)),
        (0, 0),
        "creating a record is not an update"
    );

    api_set(&env, &r, json!({ &env.f.notes_id: "just a note" })).await;
    env.drain().await;
    assert_eq!(env.run_count(&wa), 0, "Notes is not watched");
    assert_eq!(env.run_count(&any), 1);

    api_set(&env, &r, json!({ &env.amount: 1 })).await;
    env.drain().await;
    assert_eq!(
        (env.run_count(&wa), env.run_count(&any)),
        (0, 1),
        "an update that changes nothing is not an event"
    );

    api_set(&env, &r, json!({ &env.amount: 2 })).await;
    env.drain().await;
    assert_eq!((env.run_count(&wa), env.run_count(&any)), (1, 2));
    let run = env.only_run(&wa).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    assert_eq!(
        run["trigger_data"]["changed_field_ids"],
        json!([env.amount])
    );
    let logs = env.f.query_view(&log.view, json!({})).await;
    assert_eq!(logs["total"], 1);
    assert_eq!(logs["records"][0]["values"][&log.name], "amount: Ada");

    // Several records in one batch: one run each.
    let r2 = api_create(&env, json!({ &env.name: "Bob" })).await;
    env.f
        .app
        .patch(
            &env.f.owner,
            &records_url(env.table()),
            json!({ "records": [
                { "id": r, "values": { &env.amount: 3 } },
                { "id": r2, "values": { &env.amount: 4 } },
            ] }),
        )
        .await
        .assert_status(200);
    env.drain().await;
    assert_eq!(env.run_count(&wa), 3);
}

#[tokio::test]
async fn record_matches_fires_only_on_the_transition_into_the_filter() {
    let env = Env::new().await;
    let a = env
        .create(
            "became done",
            env.trigger_matches(env.status_is(&env.done_choice)),
            json!([env.notify_action("done {{trigger.record.fields.Name}}")]),
        )
        .await;
    let id = a["id"].as_str().unwrap().to_string();

    // Created matching: fires. Created not matching: does not.
    let r1 = api_create(&env, json!({ &env.name: "one", &env.status: "Done" })).await;
    let r2 = api_create(&env, json!({ &env.name: "two", &env.status: "Todo" })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 1);

    // Todo -> Done: fires. Done -> Done (other field): does not.
    api_set(&env, &r2, json!({ &env.status: "Done" })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 2);
    api_set(&env, &r2, json!({ &env.amount: 5 })).await;
    api_set(&env, &r1, json!({ &env.name: "uno" })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 2);

    // Out and back in: fires again.
    api_set(&env, &r2, json!({ &env.status: "Doing" })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 2);
    api_set(&env, &r2, json!({ &env.status: "Done" })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 3);
    let runs = env.runs(&id).await;
    assert!(runs.iter().all(|r| r["status"] == "succeeded"), "{runs:#?}");
}

#[tokio::test]
async fn record_matches_sees_exact_transitions_with_the_pre_write_snapshot() {
    let env = Env::new().await;
    // A filter on a number: without the "before" snapshot an edit of the
    // filtered field from one matching value to another would look like a
    // transition.
    let amount_gt_10 = json!({ "conjunction": "and", "items": [
        { "field_id": env.amount, "op": "gt", "value": 10 } ] });
    let a = env
        .create(
            "big",
            env.trigger_matches(amount_gt_10),
            json!([env.notify_action("big")]),
        )
        .await;
    let id = a["id"].as_str().unwrap().to_string();
    let r = api_create(&env, json!({ &env.name: "n", &env.amount: 5 })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 0);
    api_set(&env, &r, json!({ &env.amount: 20 })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 1, "5 -> 20 enters the filter");
    api_set(&env, &r, json!({ &env.amount: 30 })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 1, "20 -> 30 stays inside it");
    api_set(&env, &r, json!({ &env.amount: 1 })).await;
    api_set(&env, &r, json!({ &env.amount: 11 })).await;
    env.drain().await;
    assert_eq!(env.run_count(&id), 2, "left and re-entered");

    // A filter on a *computed* field: the edited field (Amount) is not the
    // one the filter reads, yet the record starts matching.
    let double = id_of(&env.f.formula(env.table(), "Double", "{Amount} * 2").await);
    let dbl = env
        .create(
            "double big",
            env.trigger_matches(json!({ "conjunction": "and", "items": [
                { "field_id": double, "op": "gt", "value": 100 } ] })),
            json!([env.notify_action("dbl")]),
        )
        .await;
    let did = dbl["id"].as_str().unwrap().to_string();
    let r2 = api_create(&env, json!({ &env.name: "m", &env.amount: 10 })).await;
    env.drain().await;
    assert_eq!(env.run_count(&did), 0);
    api_set(&env, &r2, json!({ &env.amount: 60 })).await;
    env.drain().await;
    assert_eq!(env.run_count(&did), 1, "Double went 20 -> 120");
    api_set(&env, &r2, json!({ &env.amount: 70 })).await;
    env.drain().await;
    assert_eq!(env.run_count(&did), 1, "Double stayed above 100");
    let run = env.runs(&did).await.pop().unwrap();
    assert_eq!(run["trigger_data"]["record"]["fields"][&double], 120);
}

#[tokio::test]
async fn form_submissions_fire_form_and_created_triggers_through_the_engine() {
    let env = Env::new().await;
    let form = env
        .create(
            "form",
            json!({ "type": "form_submitted", "view_id": env.form_view }),
            json!([env.notify_action("submitted")]),
        )
        .await;
    let created = env
        .create(
            "created",
            env.trigger_created(),
            json!([env.notify_action("c")]),
        )
        .await;
    // A form-source write straight through the engine (the public form
    // endpoint belongs to W7): the engine passes the form view id on.
    let ctx = opengrid::engine::write::WriteCtx::new(
        None,
        opengrid::engine::write::WriteSource::Form {
            view_id: env.form_view.clone(),
        },
    );
    let table = env.table().to_string();
    let name = env.name.clone();
    env.f
        .app
        .state
        .db
        .write_sync(move |tx| {
            opengrid::engine::write::create_records(
                tx,
                &ctx,
                &table,
                vec![og_core::api::records::NewRecord {
                    values: [(name, json!("from a form"))].into_iter().collect(),
                }],
                &Default::default(),
            )
        })
        .unwrap();
    assert_eq!(env.run_count(form["id"].as_str().unwrap()), 1);
    assert_eq!(env.run_count(created["id"].as_str().unwrap()), 1);
}

#[tokio::test]
async fn a_webhook_updates_a_record_through_the_engine() {
    let env = Env::new().await;
    let a = env
        .create(
            "hook",
            json!({ "type": "webhook" }),
            json!([{ "type": "update_record", "table_id": env.table(),
                     "record_id": "{{trigger.body.id}}",
                     "values": { "Status": "{{trigger.body.status}}",
                                 "Amount": "{{trigger.body.amount}}" } }]),
        )
        .await;
    let token = a["webhook_token"].as_str().unwrap().to_string();
    let aid = a["id"].as_str().unwrap().to_string();
    // A record automation proves the hook's write does not loop.
    let watcher = env
        .create(
            "watch",
            env.trigger_updated(&[]),
            json!([env.notify_action("w")]),
        )
        .await;
    let r = api_create(&env, json!({ &env.name: "Ada" })).await;
    env.drain().await;

    let mut rx = env.f.app.state.events.subscribe(env.base());
    let anon = env.f.app.anon();
    env.f
        .app
        .post(
            &anon,
            &format!("/api/hooks/{token}"),
            json!({ "id": r, "status": "Doing", "amount": 7 }),
        )
        .await
        .assert_status(202);
    assert_eq!(env.drain().await, 1);
    let run = env.only_run(&aid).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");

    let rec = env.f.get(env.table(), &r).await;
    assert_eq!(rec["values"][&env.status], env.doing.as_str());
    assert_eq!(rec["values"][&env.amount], 7);
    assert_eq!(
        updated_in(&drain_events(&mut rx), env.table()),
        std::slice::from_ref(&r)
    );
    assert_eq!(env.f.history(&r).last().unwrap().0, "update");
    assert_eq!(
        env.run_count(watcher["id"].as_str().unwrap()),
        0,
        "automation writes do not fire record triggers"
    );

    // A bad payload fails the run with the engine's message, not a panic.
    env.f
        .app
        .post(
            &anon,
            &format!("/api/hooks/{token}"),
            json!({ "id": r, "status": "Doing", "amount": "lots" }),
        )
        .await
        .assert_status(202);
    env.drain().await;
    let runs = env.runs(&aid).await;
    assert_eq!(runs.last().unwrap()["status"], "failed");
    assert!(
        runs.last().unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("Amount"),
        "{runs:#?}"
    );
    assert_eq!(env.f.value(env.table(), &r, &env.amount).await, 7);
}

#[tokio::test]
async fn a_due_schedule_enqueues_and_runs_through_the_engine() {
    let env = Env::new().await;
    let log = log_table(&env).await;
    let a = env
        .create(
            "daily",
            json!({ "type": "schedule", "cron": "0 9 * * *", "timezone": "UTC" }),
            json!([{ "type": "create_record", "table_id": log.id,
                     "values": { "Name": "tick {{trigger.type}}", "Amount": 4 } }]),
        )
        .await;
    let aid = a["id"].as_str().unwrap();
    let due = a["next_run_at"].as_i64().expect("a next run time");
    assert_eq!(env.runner.enqueue_due_schedules(due - 1).await.unwrap(), 0);
    assert_eq!(
        env.runner.enqueue_due_schedules(due + 1000).await.unwrap(),
        1
    );
    assert_eq!(env.drain().await, 1);
    let run = env.only_run(aid).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let resp = env.f.query_view(&log.view, json!({})).await;
    assert_eq!(resp["total"], 1);
    assert_eq!(resp["records"][0]["values"][&log.name], "tick schedule");
    assert_eq!(resp["records"][0]["values"][&log.double], 8);
}

// ------------------------------------------------------- loop prevention

#[tokio::test]
async fn an_automation_updating_the_record_that_triggered_it_runs_once() {
    let env = Env::new().await;
    let a = env
        .create(
            "touch",
            env.trigger_updated(&[]),
            json!([{ "type": "update_record", "table_id": env.table(),
                     "record_id": "{{trigger.record.id}}",
                     "values": { "Notes": "touched {{trigger.record.fields.Name}}" } }]),
        )
        .await;
    let aid = a["id"].as_str().unwrap().to_string();
    let r = api_create(&env, json!({ &env.name: "Ada" })).await;
    api_set(&env, &r, json!({ &env.amount: 1 })).await;
    assert_eq!(env.drain().await, 1);
    assert_eq!(env.run_count(&aid), 1);
    assert_eq!(
        env.f.value(env.table(), &r, &env.f.notes_id).await,
        "touched Ada"
    );
    // Nothing further is queued, now or later.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(env.drain().await, 0);
    assert_eq!(env.run_count(&aid), 1);

    // A user edit afterwards starts exactly one new run.
    api_set(&env, &r, json!({ &env.amount: 2 })).await;
    assert_eq!(env.drain().await, 1);
    assert_eq!(env.run_count(&aid), 2);
}

#[tokio::test]
async fn automations_cannot_trigger_each_other_through_engine_writes() {
    let env = Env::new().await;
    let make = |label: &str| {
        json!([{ "type": "create_record", "table_id": env.table(),
                 "values": { "Name": format!("{label} made this") } }])
    };
    let a = env.create("A", env.trigger_created(), make("A")).await;
    let b = env.create("B", env.trigger_created(), make("B")).await;
    let m = env
        .create(
            "M",
            env.trigger_matches(json!({ "conjunction": "and", "items": [
                { "field_id": env.name, "op": "contains", "value": "made" } ] })),
            json!([env.notify_action("m")]),
        )
        .await;
    api_create(&env, json!({ &env.name: "seed" })).await;
    env.drain().await;
    assert_eq!(env.record_count(), 3, "seed + one record per automation");
    for x in [&a, &b] {
        assert_eq!(env.run_count(x["id"].as_str().unwrap()), 1);
    }
    assert_eq!(env.run_count(m["id"].as_str().unwrap()), 0);
}
