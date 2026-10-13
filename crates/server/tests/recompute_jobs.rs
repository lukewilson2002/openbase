//! Background jobs of the data plane: volatile formula refresh and trash purge.

mod common;
mod records_support;
mod schema_support;

use chrono::{TimeZone, Utc};
use opengrid::tasks;
use records_support::*;
use serde_json::json;

const DAY: i64 = 24 * 3600 * 1000;

#[tokio::test]
async fn volatile_formulas_are_refreshed_with_their_dependents_and_nothing_else() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let today = f.formula(&t, "Today", "TODAY()").await;
    let label = f
        .formula(
            &t,
            "Label",
            "\"Today is \" & DATETIME_FORMAT({Today}, 'YYYY-MM-DD')",
        )
        .await;
    let plain = f.formula(&t, "Plain", "1 + 1").await;
    let other_table = id_of(&f.add_table("Elsewhere").await);
    let elsewhere = f.formula(&other_table, "Now", "NOW()").await;
    let live = f.create(&t, json!({})).await;
    let dead = f.create(&t, json!({})).await;
    let other = f.create(&other_table, json!({})).await;
    let (live, dead, other) = (
        sid(&live["id"]).to_string(),
        sid(&dead["id"]).to_string(),
        sid(&other["id"]).to_string(),
    );
    f.delete_records(&t, &[&dead]).await.assert_status(204);

    // make every stored value stale
    let stale = |rid: &str, data: serde_json::Value| set_data(&f.app, rid, data);
    for rid in [&live, &dead] {
        stale(
            rid,
            json!({ sid(&today["id"]): "2000-01-01", sid(&label["id"]): "Today is 2000-01-01", sid(&plain["id"]): 999 }),
        );
    }
    stale(
        &other,
        json!({ sid(&elsewhere["id"]): "2000-01-01T00:00:00.000Z" }),
    );

    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let now = Utc.with_ymd_and_hms(2030, 6, 15, 12, 0, 0).unwrap();
    let changed = tasks::refresh_volatile_formulas(&f.app.state, now).unwrap();
    assert_eq!(
        changed, 2,
        "the live record (Today + Label) and the other table's record"
    );

    assert_eq!(f.stored(&live, sid(&today["id"])), "2030-06-15");
    assert_eq!(
        f.stored(&live, sid(&label["id"])),
        "Today is 2030-06-15",
        "dependents follow"
    );
    assert_eq!(
        f.stored(&live, sid(&plain["id"])),
        999,
        "non-volatile formulas are not touched"
    );
    assert_eq!(
        f.stored(&dead, sid(&today["id"])),
        "2000-01-01",
        "trashed records are skipped"
    );
    assert!(sid(&f.stored(&other, sid(&elsewhere["id"]))).starts_with("2030-06-15T12:00:00"));

    // subscribers hear about the changed records, per table
    let mut seen = std::collections::BTreeMap::new();
    while let Ok(ev) = rx.try_recv() {
        if let og_core::api::events::BaseEvent::RecordsChanged {
            table_id, updated, ..
        } = ev.event.clone()
        {
            seen.insert(table_id, updated);
        }
    }
    assert_eq!(seen[&t], vec![live.clone()]);
    assert_eq!(seen[&other_table], vec![other.clone()]);

    // nothing changed since: a second run changes nothing and says nothing
    let again = tasks::refresh_volatile_formulas(&f.app.state, now).unwrap();
    assert_eq!(again, 0);
    assert!(rx.try_recv().is_err());
    // a later instant changes the clock-dependent values again
    let later = Utc.with_ymd_and_hms(2030, 6, 16, 0, 0, 1).unwrap();
    assert_eq!(
        tasks::refresh_volatile_formulas(&f.app.state, later).unwrap(),
        2
    );
    assert_eq!(f.stored(&live, sid(&label["id"])), "Today is 2030-06-16");

    // once the record is restored its values are current again
    f.restore_records(&t, &[&dead]).await.assert_status(200);
    assert_eq!(f.stored(&dead, sid(&plain["id"])), 2);
}

#[tokio::test]
async fn deleted_and_trashed_things_are_not_refreshed() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let now_f = f.formula(&t, "Now", "NOW()").await;
    let rec = f.create(&t, json!({})).await;
    let rid = sid(&rec["id"]).to_string();
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&now_f["id"])))
        .await
        .assert_status(200);
    let before = f.record_data(&rid);
    let changed = tasks::refresh_volatile_formulas(&f.app.state, Utc::now()).unwrap();
    assert_eq!(changed, 0);
    assert_eq!(f.record_data(&rid), before);
}

#[tokio::test]
async fn trash_purge_job_removes_old_trash_and_keeps_recent() {
    let l = linked().await;
    let f = &l.f;
    let pid = sid(&l.price["id"]).to_string();
    let o_old = sid(&f.create(&l.t2, json!({ &pid: 1 })).await["id"]).to_string();
    let o_new = sid(&f.create(&l.t2, json!({ &pid: 2 })).await["id"]).to_string();
    let c = sid(&f
        .create(&l.t1, json!({ sid(&l.link["id"]): [o_old, o_new] }))
        .await["id"])
    .to_string();
    f.delete_records(&l.t2, &[&o_old, &o_new])
        .await
        .assert_status(204);
    let now = opengrid::db::now_ms();
    set_deleted_at(&f.app, "records", &o_old, now - 31 * DAY);
    set_deleted_at(&f.app, "records", &o_new, now - 2 * DAY);

    let stats = f
        .app
        .state
        .db
        .write_sync(|tx| tasks::purge_trash(tx, 30, now))
        .unwrap();
    assert_eq!(stats.records, 1);
    assert!(!record_exists(&f.app, &o_old));
    assert!(record_exists(&f.app, &o_new));
    // the purged record's id was stripped from the customer's link array
    assert_eq!(
        stored_ids(f, &c, sid(&l.link["id"])),
        std::slice::from_ref(&o_new)
    );
    // and the surviving trashed record can still be restored
    f.restore_records(&l.t2, &[&o_new]).await.assert_status(200);
    let rec = f.get(&l.t1, &c).await;
    assert_eq!(link_ids_of(&rec["values"][sid(&l.link["id"])]), [o_new]);
}

#[tokio::test]
async fn the_tick_runs_the_new_jobs_and_runs_each_only_when_due() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let today = f.formula(&t, "Today", "TODAY()").await;
    let rec = sid(&f.create(&t, json!({})).await["id"]).to_string();
    let doomed = sid(&f.create(&t, json!({})).await["id"]).to_string();
    f.delete_records(&t, &[&doomed]).await.assert_status(204);
    set_deleted_at(
        &f.app,
        "records",
        &doomed,
        opengrid::db::now_ms() - 40 * DAY,
    );
    set_data(&f.app, &rec, json!({ sid(&today["id"]): "2000-01-01" }));

    let mut clock = tasks::Clock::default();
    tasks::tick(&f.app.state, &mut clock).await;
    let today_now = Utc::now().format("%Y-%m-%d").to_string();
    let stored = f.stored(&rec, sid(&today["id"]));
    // allow for the date rolling over while the test runs
    assert!(
        stored == today_now.as_str() || stored.as_str().is_some_and(|s| s > "2000-01-01"),
        "{stored}"
    );
    assert!(!record_exists(&f.app, &doomed), "the trash purge ran");

    // not due again within the interval
    set_data(&f.app, &rec, json!({ sid(&today["id"]): "2000-01-01" }));
    tasks::tick(&f.app.state, &mut clock).await;
    assert_eq!(f.stored(&rec, sid(&today["id"])), "2000-01-01");
}

#[tokio::test]
async fn one_failing_base_does_not_stop_the_volatile_refresh_of_the_others() {
    let f = Fixture::new().await;
    // Two bases, each with a clock formula and a record holding a stale value.
    let second = schema_support::base(&f.app, &f.owner, &f.ws, "Second").await;
    let second_base = sid(&second["id"]).to_string();
    let second_table = {
        let r = f
            .app
            .post(
                &f.owner,
                &format!("/api/bases/{second_base}/tables"),
                json!({ "name": "T2" }),
            )
            .await;
        r.assert_status(201);
        sid(&r.body["id"]).to_string()
    };
    let mut bases = vec![(f.base_id.clone(), f.table_id.clone())];
    bases.push((second_base, second_table));
    // The refresh walks bases in id order: break the first, check the second.
    bases.sort();
    let mut stale = Vec::new();
    for (_, table) in &bases {
        let now_field = f.formula(table, "Now", "TODAY()").await;
        let rec = f.create(table, json!({})).await;
        let (rid, fid) = (
            sid(&rec["id"]).to_string(),
            sid(&now_field["id"]).to_string(),
        );
        set_data(&f.app, &rid, json!({ &fid: "2000-01-01" }));
        stale.push((rid, fid));
    }
    let broken = bases[0].1.clone();
    schema_support::sql(&f.app, move |tx| {
        tx.execute_batch(&format!(
            "CREATE TRIGGER break_refresh BEFORE UPDATE ON records
             WHEN NEW.table_id = '{broken}'
             BEGIN SELECT RAISE(ABORT, 'refresh of this base fails'); END"
        ))
    });

    let now = Utc.with_ymd_and_hms(2030, 6, 15, 12, 0, 0).unwrap();
    let changed = tasks::refresh_volatile_formulas(&f.app.state, now)
        .expect("a failing base is logged, not fatal");
    assert_eq!(changed, 1);
    assert_eq!(f.stored(&stale[0].0, &stale[0].1), "2000-01-01");
    assert_eq!(f.stored(&stale[1].0, &stale[1].1), "2030-06-15");
}
