//! The runner: scheduling (time zones, DST), crash recovery, disabled
//! automations, pruning and the background loop.

mod automations_support;
mod common;
mod schema_support;

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use automations_support::*;
use chrono::{TimeZone, Utc};
use opengrid::automations::runner::MAX_ATTEMPTS;
use serde_json::{Value, json};

const DAY: i64 = 24 * 3600 * 1000;

fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, s)
        .unwrap()
        .timestamp_millis()
}

fn schedule_trigger(cron: &str, tz: &str) -> Value {
    json!({ "type": "schedule", "cron": cron, "timezone": tz })
}

fn set_next_run(env: &Env, id: &str, at: Option<i64>) {
    let id = id.to_string();
    schema_support::sql(&env.f.app, |tx| {
        tx.execute(
            "UPDATE automations SET next_run_at = ?2 WHERE id = ?1",
            rusqlite::params![id, at],
        )
    });
}

fn next_run(env: &Env, id: &str) -> Option<i64> {
    let id = id.to_string();
    schema_support::sql(&env.f.app, |tx| {
        tx.query_row(
            "SELECT next_run_at FROM automations WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
    })
}

// ------------------------------------------------------------ schedules

#[tokio::test]
async fn saving_a_schedule_computes_the_next_run_in_its_time_zone() {
    let env = Env::new().await;
    let before = Utc::now().timestamp_millis();
    let a = env
        .create(
            "daily",
            schedule_trigger("0 9 * * *", "America/New_York"),
            json!([env.notify_action("tick")]),
        )
        .await;
    let after = Utc::now().timestamp_millis();
    let next = a["next_run_at"].as_i64().unwrap();

    let cron = croner::Cron::from_str("0 9 * * *").unwrap();
    let expect = |t: i64| {
        let local = Utc
            .timestamp_millis_opt(t)
            .unwrap()
            .with_timezone(&chrono_tz::America::New_York);
        cron.find_next_occurrence(&local, false)
            .unwrap()
            .timestamp_millis()
    };
    assert!(
        next == expect(before) || next == expect(after),
        "next={next}"
    );
    assert!(next > before && next <= after + DAY + 3_600_000);

    // The stored value matches what the API reported, and a disabled
    // schedule has none.
    assert_eq!(next_run(&env, a["id"].as_str().unwrap()), Some(next));
    let off = env
        .try_create(
            "off",
            schedule_trigger("0 9 * * *", "UTC"),
            json!([env.notify_action("t")]),
            false,
        )
        .await;
    off.assert_status(201);
    assert_eq!(off.body["next_run_at"], Value::Null);
}

#[tokio::test]
async fn due_schedules_queue_one_run_and_advance_across_the_spring_forward_gap() {
    let env = Env::new().await;
    let a = env
        .create(
            "ny 9am",
            schedule_trigger("0 9 * * *", "America/New_York"),
            json!([env.notify_action("tick {{trigger.time}}")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();

    // 2026-03-07 09:00 EST = 14:00Z is due; US clocks spring forward the next night.
    let due = utc(2026, 3, 7, 14, 0, 0);
    set_next_run(&env, id, Some(due));
    assert_eq!(
        env.runner.enqueue_due_schedules(due + 1000).await.unwrap(),
        1
    );
    assert_eq!(
        next_run(&env, id),
        Some(utc(2026, 3, 8, 13, 0, 0)),
        "09:00 EDT is 13:00Z"
    );

    // Nothing is due again until then.
    assert_eq!(
        env.runner.enqueue_due_schedules(due + 2000).await.unwrap(),
        0
    );
    assert_eq!(env.run_count(id), 1);

    let run = env.only_run(id).await;
    assert_eq!(run["trigger_data"]["type"], "schedule");
    assert_eq!(
        run["trigger_data"]["time"], due,
        "the run records the scheduled time"
    );

    // And onwards through the change.
    let due2 = utc(2026, 3, 8, 13, 0, 0);
    assert_eq!(env.runner.enqueue_due_schedules(due2).await.unwrap(), 1);
    assert_eq!(next_run(&env, id), Some(utc(2026, 3, 9, 13, 0, 0)));
}

#[tokio::test]
async fn schedules_follow_the_fall_back_change_too() {
    let env = Env::new().await;
    let a = env
        .create(
            "ny 9am",
            schedule_trigger("0 9 * * *", "America/New_York"),
            json!([env.notify_action("t")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    // 2026-10-31 09:00 EDT = 13:00Z; clocks go back on Nov 1, so Nov 1's 09:00 is EST = 14:00Z.
    let due = utc(2026, 10, 31, 13, 0, 0);
    set_next_run(&env, id, Some(due));
    env.runner.enqueue_due_schedules(due).await.unwrap();
    assert_eq!(next_run(&env, id), Some(utc(2026, 11, 1, 14, 0, 0)));
}

#[tokio::test]
async fn a_wall_clock_time_inside_the_gap_still_runs_that_day() {
    let env = Env::new().await;
    let a = env
        .create(
            "2:30",
            schedule_trigger("30 2 * * *", "America/New_York"),
            json!([env.notify_action("t")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    // Run due on March 7th; 02:30 does not exist on March 8th (the gap).
    let due = utc(2026, 3, 7, 7, 30, 0);
    set_next_run(&env, id, Some(due));
    env.runner.enqueue_due_schedules(due).await.unwrap();
    let next = next_run(&env, id).unwrap();
    assert!(
        next >= utc(2026, 3, 8, 7, 0, 0) && next <= utc(2026, 3, 8, 7, 30, 0),
        "March 8th's run happens right after the gap, got {}",
        Utc.timestamp_millis_opt(next).unwrap()
    );
}

#[tokio::test]
async fn missed_occurrences_collapse_into_one_run() {
    let env = Env::new().await;
    let a = env
        .create(
            "hourly",
            schedule_trigger("0 * * * *", "UTC"),
            json!([env.notify_action("t")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let now = utc(2026, 5, 10, 12, 30, 0);
    set_next_run(&env, id, Some(now - 3 * DAY));
    assert_eq!(
        env.runner.enqueue_due_schedules(now).await.unwrap(),
        1,
        "the server was off for three days"
    );
    assert_eq!(next_run(&env, id), Some(utc(2026, 5, 10, 13, 0, 0)));
    assert_eq!(env.runner.enqueue_due_schedules(now).await.unwrap(), 0);
}

#[tokio::test]
async fn disabled_schedules_never_fire() {
    let env = Env::new().await;
    let a = env
        .create(
            "sched",
            schedule_trigger("0 * * * *", "UTC"),
            json!([env.notify_action("t")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    env.f
        .app
        .patch(
            &env.f.owner,
            &format!("/api/automations/{id}"),
            json!({ "enabled": false }),
        )
        .await
        .assert_status(200);
    assert_eq!(next_run(&env, id), None);
    // Even a stale next_run_at in the past is ignored while disabled.
    set_next_run(&env, id, Some(1000));
    assert_eq!(
        env.runner
            .enqueue_due_schedules(utc(2026, 1, 1, 0, 0, 0))
            .await
            .unwrap(),
        0
    );
    assert_eq!(env.run_count(id), 0);

    // Turning it back on schedules the next occurrence from now.
    let r = env
        .f
        .app
        .patch(
            &env.f.owner,
            &format!("/api/automations/{id}"),
            json!({ "enabled": true }),
        )
        .await;
    r.assert_status(200);
    let next = r.body["next_run_at"].as_i64().unwrap();
    assert!(
        next > Utc::now().timestamp_millis() && next % 3_600_000 == 0,
        "top of an hour: {next}"
    );
}

#[tokio::test]
async fn changing_the_schedule_recomputes_next_run() {
    let env = Env::new().await;
    let a = env
        .create(
            "sched",
            schedule_trigger("0 9 * * *", "UTC"),
            json!([env.notify_action("t")]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let first = a["next_run_at"].as_i64().unwrap();
    let r = env
        .f
        .app
        .patch(
            &env.f.owner,
            &format!("/api/automations/{id}"),
            json!({ "trigger": schedule_trigger("0 9 * * *", "Asia/Tokyo") }),
        )
        .await;
    r.assert_status(200);
    let second = r.body["next_run_at"].as_i64().unwrap();
    assert_eq!(first.rem_euclid(DAY), 9 * 3_600_000, "09:00 UTC");
    assert_eq!(
        second.rem_euclid(DAY),
        0,
        "09:00 in Tokyo (UTC+9) is midnight UTC"
    );
    // Renaming does not move it.
    let r = env
        .f
        .app
        .patch(
            &env.f.owner,
            &format!("/api/automations/{id}"),
            json!({ "name": "renamed" }),
        )
        .await;
    assert_eq!(r.body["next_run_at"], second);
}

#[tokio::test]
async fn a_due_schedule_runs_its_actions() {
    let env = Env::new().await;
    let a = env
        .create(
            "report",
            schedule_trigger("0 6 * * *", "Europe/Berlin"),
            json!([
                { "type": "create_record", "table_id": env.table(), "values": { "Name": "Report {{trigger.time}}" } },
                { "type": "http_request", "method": "POST", "url": env.server.url("/report"), "body": "{{trigger.type}}" }
            ]),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let due = utc(2026, 7, 1, 4, 0, 0);
    set_next_run(&env, id, Some(due));
    env.runner.enqueue_due_schedules(due).await.unwrap();
    assert_eq!(env.drain().await, 1);
    let run = env.only_run(id).await;
    assert_eq!(run["status"], "succeeded", "{run:#}");
    let new_id = run["log"][0]["output"]["record_id"].as_str().unwrap();
    assert_eq!(
        env.f.record_data(new_id)[&env.name],
        "Report 2026-07-01T04:00:00.000Z"
    );
    assert_eq!(env.server.hits()[0].body, "schedule");
}

#[tokio::test]
async fn an_unreadable_stored_schedule_stops_instead_of_looping() {
    let env = Env::new().await;
    let id = env.insert_raw(
        schedule_trigger("not a cron", "UTC"),
        json!([env.notify_action("t")]),
        true,
    );
    set_next_run(&env, &id, Some(1000));
    assert_eq!(
        env.runner
            .enqueue_due_schedules(utc(2026, 1, 1, 0, 0, 0))
            .await
            .unwrap(),
        1
    );
    assert_eq!(next_run(&env, &id), None);
    assert_eq!(
        env.runner
            .enqueue_due_schedules(utc(2026, 1, 2, 0, 0, 0))
            .await
            .unwrap(),
        0
    );
}

// ------------------------------------------------------------- recovery

async fn automation_with_two_steps(env: &Env) -> String {
    let a = env
        .create(
            "two steps",
            env.trigger_created(),
            json!([
                { "type": "create_record", "table_id": env.table(), "values": { "Name": "made once" } },
                env.notify_action("step one made {{steps.1.record_id}}")
            ]),
        )
        .await;
    a["id"].as_str().unwrap().to_string()
}

fn mark_running(env: &Env, run_id: i64, attempts: u32, log: Value) {
    schema_support::sql(&env.f.app, |tx| {
        tx.execute(
            "UPDATE automation_runs SET status = 'running', attempts = ?2, log = ?3, started_at = 5 WHERE id = ?1",
            rusqlite::params![run_id, attempts, log.to_string()],
        )
    });
}

fn finished_step(index: u32, action: &str, output: Value) -> Value {
    json!({ "index": index, "action": action, "status": "succeeded", "attempt": 1, "output": output, "duration_ms": 3 })
}

#[tokio::test]
async fn a_run_interrupted_by_a_crash_resumes_after_its_last_finished_step() {
    let env = Env::new().await;
    let id = automation_with_two_steps(&env).await;
    let rec = env.rec(json!({}));
    let run_id = env.queue_record_run(&id, "record_created", &rec);
    // The server died after step 1 had created "recPREVIOUS" and logged it.
    mark_running(
        &env,
        run_id,
        1,
        json!([finished_step(
            0,
            "create_record",
            json!({ "record_id": "recPREVIOUS", "table_id": env.table() })
        )]),
    );
    let before = env.record_count();

    assert_eq!(env.runner.recover().await.unwrap(), (1, 0));
    let queued = env.run_row(run_id);
    assert_eq!(queued["status"], "queued");
    assert_eq!(queued["log"].as_array().unwrap().len(), 2);
    assert_eq!(queued["log"][1]["action"], "recovery");

    assert_eq!(env.drain().await, 1);
    let run = env.run_row(run_id);
    assert_eq!(run["status"], "succeeded", "{run:#}");
    assert_eq!(run["attempts"], 2);
    assert_eq!(env.record_count(), before, "step 1 was not repeated");
    let msg: Vec<String> = schema_support::sql(&env.f.app, |tx| {
        let mut s = tx.prepare("SELECT payload FROM notifications")?;
        s.query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()
    });
    assert!(
        msg[0].contains("step one made recPREVIOUS"),
        "outputs came back from the log: {msg:?}"
    );
}

#[tokio::test]
async fn a_run_is_recovered_only_once() {
    let env = Env::new().await;
    let id = automation_with_two_steps(&env).await;
    let rec = env.rec(json!({}));
    let run_id = env.queue_record_run(&id, "record_created", &rec);
    mark_running(&env, run_id, 1, json!([]));
    assert_eq!(env.runner.recover().await.unwrap(), (1, 0));

    // It is claimed again and the server dies again.
    let claimed = env
        .runner
        .claim(opengrid::db::now_ms())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.id, run_id);
    assert_eq!(env.run_row(run_id)["status"], "running");
    assert_eq!(env.runner.recover().await.unwrap(), (0, 1));
    let run = env.run_row(run_id);
    assert_eq!(run["status"], "failed");
    assert!(
        run["error"]
            .as_str()
            .unwrap()
            .contains("interrupted by a server restart")
    );
    assert_eq!(env.drain().await, 0);
    assert_eq!(
        env.record_count(),
        1,
        "the failed run never created its record"
    );
}

#[tokio::test]
async fn runs_that_used_all_their_attempts_are_not_recovered() {
    let env = Env::new().await;
    let id = automation_with_two_steps(&env).await;
    let rec = env.rec(json!({}));
    let run_id = env.queue_record_run(&id, "record_created", &rec);
    mark_running(&env, run_id, MAX_ATTEMPTS, json!([]));
    assert_eq!(env.runner.recover().await.unwrap(), (0, 1));
    assert_eq!(env.run_row(run_id)["status"], "failed");
}

#[tokio::test]
async fn recovery_leaves_queued_and_finished_runs_alone() {
    let env = Env::new().await;
    let id = automation_with_two_steps(&env).await;
    let rec = env.rec(json!({}));
    let queued = env.queue_record_run(&id, "record_created", &rec);
    let done = env.queue_record_run(&id, "record_created", &rec);
    schema_support::sql(&env.f.app, |tx| {
        tx.execute(
            "UPDATE automation_runs SET status = 'succeeded' WHERE id = ?1",
            [done],
        )
    });
    assert_eq!(env.runner.recover().await.unwrap(), (0, 0));
    assert_eq!(env.run_row(queued)["status"], "queued");
    assert_eq!(env.run_row(done)["status"], "succeeded");
}

// ------------------------------------------------------ disabled / gone

#[tokio::test]
async fn a_disabled_automation_never_runs_even_with_runs_queued() {
    let env = Env::new().await;
    let id = automation_with_two_steps(&env).await;
    let rec = env.rec(json!({}));
    let run_id = env.queue_record_run(&id, "record_created", &rec);
    // Disabled behind the API's back (it would have cancelled the run).
    schema_support::sql(&env.f.app, |tx| {
        tx.execute("UPDATE automations SET enabled = 0 WHERE id = ?1", [&id])
    });
    assert_eq!(env.drain().await, 1);
    let run = env.run_row(run_id);
    assert_eq!(run["status"], "failed");
    assert!(run["error"].as_str().unwrap().contains("turned off"));
    assert_eq!(run["log"], json!([]));
    assert_eq!(env.record_count(), 1, "no action ran");
}

// --------------------------------------------------------------- prune

#[tokio::test]
async fn runs_older_than_30_days_are_pruned() {
    let env = Env::new().await;
    let id = automation_with_two_steps(&env).await;
    let now = utc(2026, 6, 30, 12, 0, 0);
    let insert = |status: &str, age_days: i64| -> i64 {
        let (id, status) = (id.clone(), status.to_string());
        schema_support::sql(&env.f.app, |tx| {
            tx.execute(
                "INSERT INTO automation_runs (automation_id, status, trigger_data, created_at)
                 VALUES (?1, ?2, '{}', ?3)",
                rusqlite::params![id, status, now - age_days * DAY],
            )?;
            Ok(tx.last_insert_rowid())
        })
    };
    let old_ok = insert("succeeded", 31);
    let old_failed = insert("failed", 45);
    let edge = insert("succeeded", 30);
    let recent = insert("succeeded", 29);
    let old_queued = insert("queued", 40);
    let old_running = insert("running", 40);

    assert_eq!(env.runner.prune(now).await.unwrap(), 2);
    let exists = |rid: i64| {
        schema_support::sql(&env.f.app, |tx| {
            tx.query_row(
                "SELECT count(*) FROM automation_runs WHERE id = ?1",
                [rid],
                |r| r.get::<_, i64>(0),
            )
        }) == 1
    };
    assert!(!exists(old_ok) && !exists(old_failed));
    assert!(
        exists(recent) && exists(edge),
        "30 days exactly is still kept"
    );
    assert!(
        exists(old_queued) && exists(old_running),
        "unfinished runs are never pruned"
    );
}

// ----------------------------------------------------------- the loop

#[tokio::test]
async fn the_background_loop_picks_up_runs_and_schedules_by_itself() {
    let env = Env::new().await;
    let a = env
        .create(
            "bg",
            env.trigger_created(),
            json!([{ "type": "http_request", "method": "POST", "url": env.server.url("/bg"), "body": "{{trigger.record.id}}" }]),
        )
        .await;
    let id = a["id"].as_str().unwrap().to_string();
    let sched = env
        .create(
            "tick",
            schedule_trigger("0 * * * *", "UTC"),
            json!([env.notify_action("tick")]),
        )
        .await;
    let sched_id = sched["id"].as_str().unwrap().to_string();
    set_next_run(&env, &sched_id, Some(1000));

    let handle = tokio::spawn(Arc::new(env.runner.clone()).run_forever());
    let recs: Vec<String> = (0..3).map(|_| env.rec(json!({}))).collect();
    env.fire_created(&recs.iter().map(String::as_str).collect::<Vec<_>>());

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let pending = env.f.app.query_i64(
            "SELECT count(*) FROM automation_runs WHERE status IN ('queued', 'running')",
            &[],
        );
        let total = env
            .f
            .app
            .query_i64("SELECT count(*) FROM automation_runs", &[]);
        if pending == 0 && total == 4 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "runner did not finish: pending={pending} total={total}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    handle.abort();

    let runs = env.runs(&id).await;
    assert_eq!(runs.len(), 3);
    assert!(runs.iter().all(|r| r["status"] == "succeeded"), "{runs:#?}");
    assert_eq!(env.server.hits_on("/bg").len(), 3);
    assert_eq!(env.only_run(&sched_id).await["status"], "succeeded");
}

#[tokio::test]
async fn the_loop_recovers_crashed_runs_on_startup() {
    let env = Env::new().await;
    let id = automation_with_two_steps(&env).await;
    let rec = env.rec(json!({}));
    let run_id = env.queue_record_run(&id, "record_created", &rec);
    mark_running(&env, run_id, 1, json!([]));
    let handle = tokio::spawn(Arc::new(env.runner.clone()).run_forever());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while env.run_row(run_id)["status"] != "succeeded" {
        assert!(
            tokio::time::Instant::now() < deadline,
            "not recovered: {:#}",
            env.run_row(run_id)
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    handle.abort();
}
