//! Triggers: which events enqueue a run, and which do not.
//!
//! The record write path calls `on_records_changed` inside its transaction;
//! these tests call it the same way (after writing the records) and look at
//! the `automation_runs` queue.

mod automations_support;
mod common;
mod schema_support;

use automations_support::*;
use openbase::automations::store::MAX_QUEUED_RUNS_PER_AUTOMATION;
use serde_json::{Value, json};

fn one_notify(env: &Env) -> Value {
    json!([env.notify_action("hi {{trigger.record.id}}")])
}

#[tokio::test]
async fn record_created_enqueues_one_run_per_new_record_with_a_snapshot() {
    let env = Env::new().await;
    let a = env
        .create("on create", env.trigger_created(), one_notify(&env))
        .await;
    let id = a["id"].as_str().unwrap();

    let r1 = env.rec(json!({ &env.name: "Ada", &env.amount: 5 }));
    let r2 = env.rec(json!({ &env.name: "Bob" }));
    env.fire_created(&[&r1, &r2]);

    let runs = env.runs(id).await;
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|r| r["status"] == "queued"));
    let first = &runs[0]["trigger_data"];
    assert_eq!(first["type"], "record_created");
    assert_eq!(first["record"]["id"], r1.as_str());
    assert_eq!(first["record"]["table_id"], env.table());
    assert_eq!(first["record"]["fields"][&env.name], "Ada");
    assert_eq!(first["record"]["fields"][&env.amount], 5);
    assert_eq!(
        first["user_id"],
        env.f.owner.user_id.clone().unwrap().as_str()
    );
    assert_eq!(runs[1]["trigger_data"]["record"]["id"], r2.as_str());
}

#[tokio::test]
async fn record_created_ignores_other_tables_updates_and_other_bases() {
    let env = Env::new().await;
    let a = env
        .create("on create", env.trigger_created(), one_notify(&env))
        .await;
    let id = a["id"].as_str().unwrap();

    // Another table of the same base: its creations are not ours.
    let other = env.f.add_table("Other").await;
    let other_id = other["id"].as_str().unwrap().to_string();
    let rec = env.f.insert_record(&other_id, json!({}));
    let base = env.base().to_string();
    env.f
        .app
        .state
        .db
        .write_sync(|tx| {
            openbase::automations::on_records_changed(
                tx,
                &openbase::automations::RecordChanges {
                    base_id: &base,
                    table_id: &other_id,
                    created: std::slice::from_ref(&rec),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    assert_eq!(env.run_count(id), 0);

    // Updates and empty change sets do nothing for a created trigger.
    let r = env.rec(json!({}));
    env.fire_updated(&r, &[&env.name]);
    env.fire(RecordChangesOwned::default());
    assert_eq!(env.run_count(id), 0);

    // The same table id in another base's hook call is not matched either.
    env.f
        .app
        .state
        .db
        .write_sync(|tx| {
            openbase::automations::on_records_changed(
                tx,
                &openbase::automations::RecordChanges {
                    base_id: "appSomewhereElse",
                    table_id: &base,
                    created: std::slice::from_ref(&r),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    assert_eq!(env.run_count(id), 0);
}

#[tokio::test]
async fn disabled_automations_do_not_enqueue() {
    let env = Env::new().await;
    let off = env
        .try_create("off", env.trigger_created(), one_notify(&env), false)
        .await;
    off.assert_status(201);
    let r = env.rec(json!({}));
    env.fire_created(&[&r]);
    assert_eq!(env.run_count(off.body["id"].as_str().unwrap()), 0);
}

#[tokio::test]
async fn record_updated_without_field_filter_fires_for_any_changed_field() {
    let env = Env::new().await;
    let a = env
        .create("any update", env.trigger_updated(&[]), one_notify(&env))
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({ &env.name: "x" }));

    env.fire_updated(&r, &[&env.name]);
    env.fire_updated(&r, &[&env.amount, &env.status]);
    assert_eq!(env.run_count(id), 2);

    // Nothing editable changed: no run.
    env.fire_updated(&r, &[]);
    assert_eq!(env.run_count(id), 2);

    // Creation is not an update.
    env.fire_created(&[&r]);
    assert_eq!(env.run_count(id), 2);

    let runs = env.runs(id).await;
    assert_eq!(runs[0]["trigger_data"]["type"], "record_updated");
    assert_eq!(
        runs[0]["trigger_data"]["changed_field_ids"],
        json!([env.name])
    );
    assert_eq!(
        runs[1]["trigger_data"]["changed_field_ids"],
        json!([env.amount, env.status])
    );
}

#[tokio::test]
async fn record_updated_with_field_filter_needs_one_of_those_fields() {
    let env = Env::new().await;
    let a = env
        .create(
            "status or amount",
            env.trigger_updated(&[&env.status, &env.amount]),
            one_notify(&env),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({}));

    env.fire_updated(&r, &[&env.name]);
    assert_eq!(env.run_count(id), 0, "unwatched field");
    env.fire_updated(&r, &[&env.name, &env.f.notes_id]);
    assert_eq!(env.run_count(id), 0);
    env.fire_updated(&r, &[&env.name, &env.amount]);
    assert_eq!(env.run_count(id), 1, "one watched field among several");
    env.fire_updated(&r, &[&env.status]);
    assert_eq!(env.run_count(id), 2);
}

#[tokio::test]
async fn record_updated_snapshot_has_the_new_values() {
    let env = Env::new().await;
    let a = env
        .create("u", env.trigger_updated(&[]), one_notify(&env))
        .await;
    let r = env.rec(json!({ &env.name: "old" }));
    env.set_data(&r, json!({ &env.name: "new" }));
    env.fire_updated(&r, &[&env.name]);
    let run = env.only_run(a["id"].as_str().unwrap()).await;
    assert_eq!(run["trigger_data"]["record"]["fields"][&env.name], "new");
}

#[tokio::test]
async fn record_matches_fires_for_new_records_that_match() {
    let env = Env::new().await;
    let a = env
        .create(
            "done!",
            env.trigger_matches(env.status_is(&env.doing)),
            one_notify(&env),
        )
        .await;
    let id = a["id"].as_str().unwrap();

    let no = env.rec(json!({ &env.status: env.todo }));
    env.fire_created(&[&no]);
    assert_eq!(env.run_count(id), 0, "created but not matching");

    let yes = env.rec(json!({ &env.status: env.doing }));
    env.fire_created(&[&yes]);
    let run = env.only_run(id).await;
    assert_eq!(run["trigger_data"]["type"], "record_matches");
    assert_eq!(run["trigger_data"]["record"]["id"], yes.as_str());
}

#[tokio::test]
async fn record_matches_fires_on_the_transition_when_before_is_known() {
    let env = Env::new().await;
    let a = env
        .create(
            "doing",
            env.trigger_matches(env.status_is(&env.doing)),
            one_notify(&env),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({ &env.status: env.todo, &env.name: "a" }));

    // todo -> doing: starts matching.
    env.set_data(&r, json!({ &env.status: env.doing, &env.name: "a" }));
    env.fire_updated_with_before(
        &r,
        &[&env.status],
        json!({ &env.status: env.todo, &env.name: "a" }),
    );
    assert_eq!(env.run_count(id), 1);

    // doing -> doing with another field edited: still matching, no new run.
    env.set_data(&r, json!({ &env.status: env.doing, &env.name: "b" }));
    env.fire_updated_with_before(
        &r,
        &[&env.name],
        json!({ &env.status: env.doing, &env.name: "a" }),
    );
    assert_eq!(env.run_count(id), 1);

    // Even when the edit touched the filter's own field, a record that
    // matched before and after is not a transition.
    env.fire_updated_with_before(
        &r,
        &[&env.status],
        json!({ &env.status: env.doing, &env.name: "b" }),
    );
    assert_eq!(env.run_count(id), 1);

    // doing -> todo: stops matching, no run.
    env.set_data(&r, json!({ &env.status: env.todo, &env.name: "b" }));
    env.fire_updated_with_before(
        &r,
        &[&env.status],
        json!({ &env.status: env.doing, &env.name: "b" }),
    );
    assert_eq!(env.run_count(id), 1);

    // todo -> doing again: fires again.
    env.set_data(&r, json!({ &env.status: env.doing, &env.name: "b" }));
    env.fire_updated_with_before(
        &r,
        &[&env.status],
        json!({ &env.status: env.todo, &env.name: "b" }),
    );
    assert_eq!(env.run_count(id), 2);

    // Blank -> matching counts as a transition.
    let blank = env.rec(json!({ &env.status: env.doing }));
    env.fire_updated_with_before(&blank, &[&env.status], json!({}));
    assert_eq!(env.run_count(id), 3);
}

#[tokio::test]
async fn record_matches_without_before_uses_the_changed_fields() {
    let env = Env::new().await;
    let a = env
        .create(
            "doing",
            env.trigger_matches(env.status_is(&env.doing)),
            one_notify(&env),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({ &env.status: env.doing }));

    // Matches now, but the edit did not touch the field the filter reads:
    // it must have matched before too.
    env.fire_updated(&r, &[&env.name]);
    assert_eq!(env.run_count(id), 0);
    // The filter's field changed and the record matches now: a transition.
    env.fire_updated(&r, &[&env.status]);
    assert_eq!(env.run_count(id), 1);
    // Changed the filter's field but the record does not match: nothing.
    let t = env.rec(json!({ &env.status: env.todo }));
    env.fire_updated(&t, &[&env.status]);
    assert_eq!(env.run_count(id), 1);
}

#[tokio::test]
async fn record_matches_supports_nested_and_numeric_filters() {
    let env = Env::new().await;
    let filter = json!({ "conjunction": "and", "items": [
        { "field_id": env.amount, "op": "gt", "value": 100 },
        { "conjunction": "or", "items": [
            { "field_id": env.status, "op": "is", "value": env.doing },
            { "field_id": env.name, "op": "contains", "value": "urgent" }
        ] }
    ] });
    let a = env
        .create("big", env.trigger_matches(filter), one_notify(&env))
        .await;
    let id = a["id"].as_str().unwrap();
    let cases = [
        (json!({ &env.amount: 50, &env.name: "urgent" }), false),
        (json!({ &env.amount: 500, &env.name: "calm" }), false),
        (json!({ &env.amount: 500, &env.name: "very URGENT" }), true),
        (json!({ &env.amount: 500, &env.status: env.doing }), true),
    ];
    let mut expected = Vec::new();
    for (data, should) in cases {
        let r = env.rec(data);
        env.fire_created(&[&r]);
        if should {
            expected.push(r);
        }
    }
    let fired: Vec<String> = env
        .runs(id)
        .await
        .iter()
        .map(|r| {
            r["trigger_data"]["record"]["id"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(fired, expected);
}

#[tokio::test]
async fn form_submitted_fires_only_for_its_form_and_record_created_too() {
    let env = Env::new().await;
    let form = env
        .create(
            "form",
            json!({ "type": "form_submitted", "view_id": env.form_view }),
            one_notify(&env),
        )
        .await;
    let created = env
        .create("created", env.trigger_created(), one_notify(&env))
        .await;
    let (form_id, created_id) = (
        form["id"].as_str().unwrap(),
        created["id"].as_str().unwrap(),
    );

    let r = env.rec(json!({ &env.name: "from the form" }));
    env.fire(RecordChangesOwned {
        created: vec![r.clone()],
        form_view_id: Some(env.form_view.clone()),
        ..Default::default()
    });
    let run = env.only_run(form_id).await;
    assert_eq!(run["trigger_data"]["type"], "form_submitted");
    assert_eq!(run["trigger_data"]["view_id"], env.form_view.as_str());
    assert_eq!(run["trigger_data"]["record"]["id"], r.as_str());
    assert_eq!(
        env.run_count(created_id),
        1,
        "a form submission also creates a record"
    );

    // A creation that did not come from the form, or came from another one.
    let r2 = env.rec(json!({}));
    env.fire_created(&[&r2]);
    env.fire(RecordChangesOwned {
        created: vec![r2.clone()],
        form_view_id: Some("viwOtherForm".into()),
        ..Default::default()
    });
    assert_eq!(env.run_count(form_id), 1);
}

#[tokio::test]
async fn changes_made_by_automations_never_trigger_record_automations() {
    let env = Env::new().await;
    let created = env
        .create("c", env.trigger_created(), one_notify(&env))
        .await;
    let updated = env
        .create("u", env.trigger_updated(&[]), one_notify(&env))
        .await;
    let matches = env
        .create(
            "m",
            env.trigger_matches(env.status_is(&env.doing)),
            one_notify(&env),
        )
        .await;
    let r = env.rec(json!({ &env.status: env.doing }));
    env.fire(RecordChangesOwned {
        created: vec![r.clone()],
        updated: vec![(r.clone(), vec![env.status.clone()])],
        by_automation: true,
        ..Default::default()
    });
    for a in [&created, &updated, &matches] {
        assert_eq!(env.run_count(a["id"].as_str().unwrap()), 0);
    }
}

#[tokio::test]
async fn an_automation_that_creates_records_in_its_own_table_runs_once() {
    let env = Env::new().await;
    let a = env
        .create(
            "echo",
            env.trigger_created(),
            json!([{ "type": "create_record", "table_id": env.table(),
                     "values": { "Name": "copy of {{trigger.record.fields.Name}}" } }]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({ &env.name: "original" }));
    env.fire_created(&[&r]);
    assert_eq!(env.drain().await, 1);
    assert_eq!(env.record_count(), 2, "the copy exists");
    assert_eq!(env.run_count(id), 1, "the copy did not trigger another run");
    assert_eq!(env.drain().await, 0);
    assert_eq!(env.run_count(id), 1);
}

#[tokio::test]
async fn an_update_automation_that_edits_its_own_record_runs_once() {
    let env = Env::new().await;
    let a = env
        .create(
            "touch",
            env.trigger_updated(&[]),
            json!([{ "type": "update_record", "table_id": env.table(),
                     "record_id": "{{trigger.record.id}}", "values": { "Name": "touched" } }]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({ &env.name: "plain" }));
    env.fire_updated(&r, &[&env.amount]);
    env.drain().await;
    assert_eq!(env.f.record_data(&r)[&env.name], "touched");
    assert_eq!(env.run_count(id), 1);
}

#[tokio::test]
async fn two_automations_cannot_ping_pong() {
    let env = Env::new().await;
    // A creates a record when one is created; B does the same: a classic loop.
    let make = |label: &str| {
        json!([{ "type": "create_record", "table_id": env.table(),
                 "values": { "Name": format!("{label} made this") } }])
    };
    let a = env.create("A", env.trigger_created(), make("A")).await;
    let b = env.create("B", env.trigger_created(), make("B")).await;
    let r = env.rec(json!({ &env.name: "seed" }));
    env.fire_created(&[&r]);
    env.drain().await;
    assert_eq!(
        env.record_count(),
        3,
        "seed + one record from each automation"
    );
    assert_eq!(env.run_count(a["id"].as_str().unwrap()), 1);
    assert_eq!(env.run_count(b["id"].as_str().unwrap()), 1);
}

#[tokio::test]
async fn a_rolled_back_write_queues_nothing() {
    let env = Env::new().await;
    let a = env
        .create("c", env.trigger_created(), one_notify(&env))
        .await;
    let r = env.rec(json!({}));
    let (base, table) = (env.base().to_string(), env.table().to_string());
    let res: Result<(), _> = env.f.app.state.db.write_sync(|tx| {
        openbase::automations::on_records_changed(
            tx,
            &openbase::automations::RecordChanges {
                base_id: &base,
                table_id: &table,
                created: std::slice::from_ref(&r),
                ..Default::default()
            },
        )?;
        Err(openbase::error::AppError::bad_request(
            "write failed afterwards",
        ))
    });
    assert!(res.is_err());
    assert_eq!(env.run_count(a["id"].as_str().unwrap()), 0);
}

#[tokio::test]
async fn the_queue_of_one_automation_is_capped() {
    let env = Env::new().await;
    let a = env
        .create("c", env.trigger_created(), one_notify(&env))
        .await;
    let id = a["id"].as_str().unwrap().to_string();
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
            for _ in 0..MAX_QUEUED_RUNS_PER_AUTOMATION - 1 {
                stmt.execute([&aid])?;
            }
            Ok(())
        })
        .unwrap();
    let r = env.rec(json!({}));
    env.fire_created(&[&r]);
    assert_eq!(env.run_count(&id), MAX_QUEUED_RUNS_PER_AUTOMATION);
    env.fire_created(&[&r]);
    assert_eq!(
        env.run_count(&id),
        MAX_QUEUED_RUNS_PER_AUTOMATION,
        "events beyond the cap are dropped"
    );
}

#[tokio::test]
async fn turning_an_automation_off_cancels_its_queued_runs() {
    let env = Env::new().await;
    let a = env
        .create("c", env.trigger_created(), one_notify(&env))
        .await;
    let id = a["id"].as_str().unwrap();
    let r = env.rec(json!({}));
    env.fire_created(&[&r]);
    assert_eq!(env.runs(id).await[0]["status"], "queued");

    let res = env
        .f
        .app
        .patch(
            &env.f.owner,
            &format!("/api/automations/{id}"),
            json!({ "enabled": false }),
        )
        .await;
    res.assert_status(200);
    let run = env.only_run(id).await;
    assert_eq!(run["status"], "failed");
    assert!(run["error"].as_str().unwrap().contains("turned off"));
    assert_eq!(env.drain().await, 0);
}
