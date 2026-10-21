//! Scale: view queries, the cache and aggregations on big tables.
//!
//! The table "Orders" has 11 fields: a name, notes, amount and quantity
//! numbers, a single select, a multiple select, a date, a checkbox, a link to
//! a 1,000-record "Customers" table, a lookup of the customer's region and a
//! formula (`{Amount} * {Qty}`). Records are written through the write engine
//! in batches of 1,000 (so the formula, the lookup and the paired links are
//! materialized exactly as in production).
//!
//! * `scale_5k` runs in the normal suite with generous assertions (the build
//!   is unoptimized).
//! * `scale_50k` is `#[ignore]`d and asserts the budgets of the plan
//!   (docs/plans §1.5). Run it in release mode and read the printed numbers:
//!
//!   `cargo test -p openbase --release --test scale -- --ignored --nocapture`
//!
//! Printed per run: seed time, cold query (filter + sort), cached page
//! fetches (p50/p95), query after a single write, aggregations, a cold search
//! and the process memory (resident set; peak where the platform reports it).

mod common;
mod query_support;
mod records_support;
mod schema_support;

use std::time::{Duration, Instant};

use ob_core::api::records::NewRecord;
use openbase::engine::write::{self, CreateOpts, WriteCtx, WriteSource};
use query_support::*;
use serde_json::{Value, json};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*: deterministic, no dependencies.
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn bulk_create(f: &Fixture, table: &str, records: Vec<NewRecord>) -> Vec<String> {
    let owner = f.owner.user_id.clone().unwrap();
    let mut ids = Vec::with_capacity(records.len());
    let mut records = records.into_iter().peekable();
    while records.peek().is_some() {
        let batch: Vec<NewRecord> = records.by_ref().take(1000).collect();
        let (table, owner) = (table.to_string(), owner.clone());
        let out = f
            .app
            .state
            .db
            .write_sync(move |tx| {
                let ctx = WriteCtx::new(Some(&owner), WriteSource::Import);
                write::create_records(tx, &ctx, &table, batch, &CreateOpts::default())
            })
            .unwrap();
        ids.extend(out.target().created.iter().cloned());
    }
    ids
}

struct Orders {
    f: Fixture,
    view: String,
    name: String,
    amount: String,
    qty: String,
    status: String,
    due: String,
    done: String,
    total: String,
    table: String,
    ids: Vec<String>,
    choices: Vec<String>,
}

async fn build(n_orders: usize, n_customers: usize) -> Orders {
    let f = Fixture::new().await;
    let customers = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let region = f
        .add_field(
            &customers,
            json!({ "name": "Region", "type": "text", "options": {} }),
        )
        .await;
    let link = f.add_link(&orders, "Customer", &customers).await;
    let o_primary = id_str(&f.table(&orders).await["primary_field_id"]);
    let notes = id_of(
        &f.add_field(
            &orders,
            json!({ "name": "Notes", "type": "rich_text", "options": {} }),
        )
        .await,
    );
    let amount = id_of(&f.number(&orders, "Amount").await);
    let qty = id_of(&f.number(&orders, "Qty").await);
    let status = f
        .add_field(
            &orders,
            json!({ "name": "Status", "type": "single_select", "options": { "choices": [
                { "name": "New" }, { "name": "Packed" }, { "name": "Shipped" },
                { "name": "Delivered" }, { "name": "Returned" } ] } }),
        )
        .await;
    let tags = f
        .add_field(
            &orders,
            json!({ "name": "Tags", "type": "multiple_select", "options": { "choices": [
                { "name": "rush" }, { "name": "gift" }, { "name": "fragile" } ] } }),
        )
        .await;
    let due = id_of(
        &f.add_field(
            &orders,
            json!({ "name": "Due", "type": "date", "options": {} }),
        )
        .await,
    );
    let done = id_of(
        &f.add_field(
            &orders,
            json!({ "name": "Paid", "type": "checkbox", "options": {} }),
        )
        .await,
    );
    let lookup = f.lookup(&orders, "Region", &link, &region).await;
    let total = f.formula(&orders, "Total", "{Amount} * {Qty}").await;
    let status_id = id_str(&status["id"]);
    let tags_id = id_str(&tags["id"]);
    let link_id = id_str(&link["id"]);
    let choice = |field: &Value| -> Vec<String> {
        field["options"]["choices"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| id_str(&c["id"]))
            .collect()
    };
    let status_choices = choice(&status);
    let tag_choices = choice(&tags);
    let _ = lookup;

    let region_id = id_str(&region["id"]);
    let primary = f.primary_id.clone();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let regions = ["North", "South", "East", "West", "Central"];
    let customer_ids = bulk_create(
        &f,
        &customers,
        (0..n_customers)
            .map(|i| NewRecord {
                values: [
                    (primary.clone(), json!(format!("Customer {i:04}"))),
                    (region_id.clone(), json!(regions[i % regions.len()])),
                ]
                .into(),
            })
            .collect(),
    );

    let t = Instant::now();
    let ids = bulk_create(
        &f,
        &orders,
        (0..n_orders)
            .map(|i| {
                let day = 1 + rng.below(28);
                let month = 1 + rng.below(12);
                let mut v = serde_json::Map::new();
                v.insert(o_primary.clone(), json!(format!("Order {i:06}")));
                if i % 3 == 0 {
                    v.insert(notes.clone(), json!(format!("note for order {i}")));
                }
                v.insert(amount.clone(), json!(rng.below(100_000) as f64 / 100.0));
                v.insert(qty.clone(), json!(1 + rng.below(20)));
                v.insert(
                    status_id.clone(),
                    json!(status_choices[rng.below(status_choices.len() as u64) as usize]),
                );
                if rng.below(3) == 0 {
                    v.insert(
                        tags_id.clone(),
                        json!([tag_choices[rng.below(tag_choices.len() as u64) as usize]]),
                    );
                }
                v.insert(due.clone(), json!(format!("2026-{month:02}-{day:02}")));
                if rng.below(4) == 0 {
                    v.insert(done.clone(), json!(true));
                }
                let c = &customer_ids[rng.below(customer_ids.len() as u64) as usize];
                v.insert(link_id.clone(), json!([c]));
                NewRecord {
                    values: v.into_iter().collect(),
                }
            })
            .collect(),
    );
    println!(
        "seeded {n_orders} orders + {n_customers} customers in {:.1}s",
        t.elapsed().as_secs_f64()
    );

    let view = f.new_view(&orders, "Everything", json!({})).await;
    Orders {
        f,
        view,
        name: o_primary,
        amount,
        qty,
        status: status_id,
        due,
        done,
        total: id_str(&total["id"]),
        table: orders,
        ids,
        choices: status_choices,
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Resident set size and peak in MB, where the platform tells us cheaply.
fn memory_mb() -> Option<(f64, Option<f64>)> {
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        let kb = |key: &str| -> Option<f64> {
            status
                .lines()
                .find(|l| l.starts_with(key))?
                .split_whitespace()
                .nth(1)?
                .parse::<f64>()
                .ok()
                .map(|k| k / 1024.0)
        };
        return Some((kb("VmRSS:")?, kb("VmHWM:")));
    }
    // macOS and other Unixes: ask ps (resident set in KB).
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    let kb: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some((kb / 1024.0, None))
}

struct Budgets {
    cold_query: Duration,
    cached_p95: Duration,
    requery: Duration,
    aggregations: Duration,
    search: Duration,
}

async fn run(n_orders: usize, n_customers: usize, budgets: Budgets) {
    let o = build(n_orders, n_customers).await;
    let cache = o.f.app.state.query_cache.clone();
    let f = &o.f;
    let shipped = &o.choices[2];

    // ---- a typical grid view: filter + sort, with summaries
    f.configure_view(
        &o.view,
        json!({
            "filter": and(vec![
                cond(&o.status, "is_any_of", json!([shipped, o.choices[3]])),
                cond(&o.amount, "gt", json!(100)),
            ]),
            "sorts": [
                { "field_id": o.due, "direction": "desc" },
                { "field_id": o.name },
            ],
            "summaries": { &o.amount: "sum", &o.total: "average", &o.done: "checked",
                           &o.status: "unique" },
        }),
    )
    .await;

    // Cold query: the first request scans, filters, sorts and pages.
    let t = Instant::now();
    let first = f.query_view(&o.view, json!({ "limit": 100 })).await;
    let cold = t.elapsed();
    let total = first["total"].as_u64().unwrap();
    println!(
        "cold query (filter + 2 sorts): {:.0} ms, {total} matches",
        ms(cold)
    );
    assert!(total > 0 && (total as usize) < n_orders);
    assert_eq!(cache.scans(), 1);
    // The result is genuinely filtered and sorted.
    let dues: Vec<&str> = first["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["values"][&o.due].as_str().unwrap())
        .collect();
    assert!(
        dues.windows(2).all(|w| w[0] >= w[1]),
        "sorted by due, descending"
    );

    // Cached page fetches at scattered offsets.
    let mut times = Vec::new();
    let pages = 40usize;
    for i in 0..pages {
        let offset = (i * 7919) % (total as usize).max(1);
        let t = Instant::now();
        let page = f
            .query_view(&o.view, json!({ "offset": offset, "limit": 100 }))
            .await;
        times.push(t.elapsed());
        assert_eq!(page["total"].as_u64().unwrap(), total);
    }
    assert_eq!(cache.scans(), 1, "cached pages must not rescan");
    assert_eq!(cache.hits(), pages as u64);
    times.sort();
    let p50 = times[times.len() / 2];
    let p95 = times[(times.len() * 95 / 100).min(times.len() - 1)];
    println!(
        "cached page fetch (100 rows): p50 {:.1} ms, p95 {:.1} ms",
        ms(p50),
        ms(p95)
    );

    // A single write, then the same query again.
    let orders = o.table.clone();
    let r = f
        .app
        .patch(
            &f.owner,
            &records_url(&orders),
            json!({ "records": [ { "id": o.ids[1], "values": { &o.qty: 1001 } } ] }),
        )
        .await;
    r.assert_status(200);
    let t = Instant::now();
    let again = f.query_view(&o.view, json!({ "limit": 100 })).await;
    let requery = t.elapsed();
    println!("query after a single write: {:.0} ms", ms(requery));
    assert_eq!(cache.scans(), 2, "a write invalidates the cache");
    assert_eq!(again["total"], first["total"]);

    // Aggregations over the filtered rows.
    let t = Instant::now();
    let agg = f.aggregations(&o.view).await;
    let agg_time = t.elapsed();
    println!("aggregations (4 summaries): {:.0} ms", ms(agg_time));
    assert!(agg[&o.amount].as_f64().unwrap() > 0.0);
    assert_eq!(agg[&o.status], 2);

    // A cold search over every visible field.
    f.configure_view(&o.view, json!({})).await;
    let t = Instant::now();
    let found = f
        .query_view(&o.view, json!({ "search": "order 00123", "limit": 100 }))
        .await;
    let search = t.elapsed();
    println!(
        "cold search over all fields: {:.0} ms, {} hits",
        ms(search),
        found["total"]
    );
    assert!(found["total"].as_u64().unwrap() >= 1);

    // Grouped query with 50k+ rows: headers for every group.
    f.configure_view(&o.view, json!({ "groups": [ { "field_id": o.status } ] }))
        .await;
    let t = Instant::now();
    let grouped = f.query_view(&o.view, json!({ "limit": 100 })).await;
    println!(
        "cold grouped query (by status): {:.0} ms, {} groups",
        ms(t.elapsed()),
        grouped["groups"].as_array().unwrap().len()
    );
    assert_eq!(grouped["groups"].as_array().unwrap().len(), 5);

    match memory_mb() {
        Some((rss, Some(peak))) => println!("memory: {rss:.0} MB resident, {peak:.0} MB peak"),
        Some((rss, None)) => println!("memory: {rss:.0} MB resident"),
        None => println!("memory: not available on this platform"),
    }

    assert!(cold < budgets.cold_query, "cold query {cold:?} over budget");
    assert!(p95 < budgets.cached_p95, "cached p95 {p95:?} over budget");
    assert!(
        requery < budgets.requery,
        "re-query {requery:?} over budget"
    );
    assert!(
        agg_time < budgets.aggregations,
        "aggregations {agg_time:?} over budget"
    );
    assert!(search < budgets.search, "search {search:?} over budget");
}

/// Runs in the normal suite. The build is unoptimized, so the budgets are
/// several times looser than the plan's.
#[tokio::test(flavor = "multi_thread")]
async fn scale_5k() {
    run(
        5_000,
        200,
        Budgets {
            cold_query: Duration::from_secs(5),
            cached_p95: Duration::from_millis(500),
            requery: Duration::from_secs(5),
            aggregations: Duration::from_secs(5),
            search: Duration::from_secs(5),
        },
    )
    .await;
}

/// The plan's targets (docs/plans §1.5) at 50,000 records:
/// cached page < 50 ms p95, re-query after a write < 1 s.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "50k records; run with --release -- --ignored --nocapture"]
async fn scale_50k() {
    run(
        50_000,
        1_000,
        Budgets {
            cold_query: Duration::from_secs(2),
            cached_p95: Duration::from_millis(50),
            requery: Duration::from_secs(1),
            aggregations: Duration::from_secs(2),
            search: Duration::from_secs(2),
        },
    )
    .await;
}
