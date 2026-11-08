//! HOME-11: Home answers in under 300 ms for a workspace with 20 collections and 100,000
//! records. Ignored in the ordinary run, because a debug build says nothing about it; run it in
//! release mode, at the Phase 6 gate and whenever `store::home` changes:
//!
//! ```sh
//! cargo test --release -p openbase --test home_perf -- --ignored --nocapture
//! ```

mod common;
mod records_support;
mod schema_support;

use std::time::{Duration, Instant};

use chrono::{Days, Utc};
use records_support::*;
use rusqlite::params;
use serde_json::{Value, json};

const TABLES: usize = 20;
const RECORDS_PER_TABLE: usize = 5_000;
const LIMIT: Duration = Duration::from_millis(300);

#[tokio::test]
#[ignore = "release-mode benchmark: cargo test --release -p openbase --test home_perf -- --ignored"]
async fn home_answers_in_under_300_ms_for_20_collections_and_100000_records() {
    let f = Fixture::new().await;
    // Four projects of five collections: dated collections spread over folders, as people make
    // them. The fixture's own project holds the first five.
    // (table id, whether Due has a time, [name, due, done, ...] ids)
    let mut tables: Vec<(String, bool, Vec<String>)> = Vec::new();
    let mut bases = vec![f.base_id.clone()];
    for i in 1..4 {
        bases.push(
            sid(&base(&f.app, &f.owner, &f.ws, &format!("Folder {i}")).await["id"]).to_string(),
        );
    }
    for n in 0..TABLES {
        let base_id = &bases[n % bases.len()];
        let table = f
            .app
            .post(
                &f.owner,
                &format!("/api/bases/{base_id}/tables"),
                json!({ "name": format!("Collection {n}") }),
            )
            .await;
        table.assert_status(201);
        let t = sid(&table.body["id"]).to_string();
        let mut ids = vec![sid(&table.body["primary_field_id"]).to_string()];
        for (name, ty, options) in [
            ("Due", "date", json!({ "include_time": n % 2 == 0 })),
            ("Done", "checkbox", json!({})),
            ("Notes", "text", json!({})),
            ("Cost", "number", json!({ "precision": 2 })),
            ("Owner", "text", json!({})),
            ("Stage", "text", json!({})),
            ("Link", "url", json!({})),
        ] {
            let field = f
                .add_field(&t, json!({ "name": name, "type": ty, "options": options }))
                .await;
            ids.push(sid(&field["id"]).to_string());
        }
        f.app
            .patch(
                &f.owner,
                &format!("/api/tables/{t}"),
                json!({ "home_date_field_id": ids[1], "done_field_id": ids[2] }),
            )
            .await
            .assert_status(200);
        tables.push((t, n % 2 == 0, ids));
    }

    // 5,000 records a table, dated over 180 days around today (about a fifth fall in Home's
    // window), a third of them done, each with a create entry in the history.
    let today = Utc::now().date_naive();
    let now_ms = Utc::now().timestamp_millis();
    let owner = f.owner.user_id.clone().unwrap();
    let seed = std::mem::take(&mut tables);
    sql(&f.app, |tx| {
        let mut rec = tx.prepare(
            "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at,
                                  created_by, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?7)",
        )?;
        let mut hist = tx.prepare(
            "INSERT INTO record_history (record_id, table_id, user_id, kind, changes, created_at)
             VALUES (?1, ?2, ?3, 'create', '{}', ?4)",
        )?;
        for (t, with_time, ids) in &seed {
            for i in 0..RECORDS_PER_TABLE {
                let day = today
                    .checked_add_days(Days::new(i as u64 % 180))
                    .unwrap()
                    .checked_sub_days(Days::new(90))
                    .unwrap();
                let due = if *with_time {
                    format!("{day}T09:30:00.000Z")
                } else {
                    day.to_string()
                };
                let data = json!({
                    &ids[0]: format!("Record {i} of {t}"),
                    &ids[1]: due,
                    &ids[2]: i % 3 == 0,
                    &ids[3]: "Some notes about the work, long enough to look like real text.",
                    &ids[4]: (i as f64) * 1.5,
                    &ids[5]: "Dana",
                    &ids[6]: "In progress",
                    &ids[7]: "https://example.com/a/b/c",
                });
                let id = format!("rec{}x{i}", &t[3..]);
                let at = now_ms - (i as i64) * 1_000;
                rec.execute(params![
                    id,
                    t,
                    data.to_string(),
                    i as f64,
                    i as i64 + 1,
                    at,
                    owner
                ])?;
                hist.execute(params![id, t, owner, at])?;
            }
        }
        Ok(())
    });
    let total: i64 = sql(&f.app, |tx| {
        tx.query_row("SELECT count(*) FROM records", [], |r| r.get(0))
    });
    assert_eq!(total, (TABLES * RECORDS_PER_TABLE) as i64);

    let url = format!("/api/workspaces/{}/home", f.ws);
    let mut timings = Vec::new();
    let mut last = Value::Null;
    for _ in 0..8 {
        let started = Instant::now();
        let r = f.app.get(&f.owner, &url).await;
        timings.push(started.elapsed());
        r.assert_status(200);
        last = r.body.clone();
    }
    println!("home timings over {total} records in {TABLES} collections: {timings:?}");
    assert_eq!(last["due"].as_array().unwrap().len(), 50);
    assert_eq!(last["recent"].as_array().unwrap().len(), 10);
    assert_eq!(
        last["truncated"], false,
        "the whole workspace fits the budget"
    );
    // The first request is as warm as the rest can be in a fresh process: no cache is involved,
    // so every one of them must be fast.
    for t in &timings {
        assert!(*t < LIMIT, "Home took {t:?}, over {LIMIT:?}: {timings:?}");
    }
}
