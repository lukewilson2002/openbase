//! Recompute performance: a single-cell edit with dependent recompute must
//! stay fast on big tables. Numbers are printed (`--nocapture`); the
//! assertions are generous because tests run unoptimized.
//!
//! `cargo test -p openbase --test recompute_perf -- --nocapture`
//! `cargo test -p openbase --test recompute_perf --release -- --ignored --nocapture` runs the 50k variant.

mod common;
mod records_support;
mod schema_support;

use std::time::Instant;

use ob_core::api::records::NewRecord;
use openbase::engine::write::{self, CreateOpts, WriteCtx, WriteSource};
use records_support::*;
use serde_json::json;

struct Perf {
    f: Fixture,
    customers: String,
    orders: String,
    discount: String,
    price: String,
    total: String,
    spend: String,
    customer_ids: Vec<String>,
    order_ids: Vec<String>,
}

fn bulk_create(f: &Fixture, table: &str, records: Vec<NewRecord>) -> Vec<String> {
    let owner = f.owner.user_id.clone().unwrap();
    let mut ids = Vec::new();
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

async fn build(n_orders: usize) -> Perf {
    let f = Fixture::new().await;
    let customers = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let link = f.add_link(&orders, "Customer", &customers).await;
    let discount = f
        .add_field(
            &customers,
            json!({ "name": "Discount", "type": "number", "options": { "precision": 2 } }),
        )
        .await;
    let price = f.number(&orders, "Price").await;
    let lookup = f.lookup(&orders, "Discounts", &link, &discount).await;
    let (lid, did, pid) = (
        sid(&link["id"]).to_string(),
        sid(&discount["id"]).to_string(),
        sid(&price["id"]).to_string(),
    );
    let _ = lookup;

    let n_customers = (n_orders / 10).max(1);
    let t = Instant::now();
    let customer_ids = bulk_create(
        &f,
        &customers,
        (0..n_customers)
            .map(|i| NewRecord {
                values: [
                    (did.clone(), json!(0.1)),
                    (f.primary_id.clone(), json!(format!("C{i}"))),
                ]
                .into_iter()
                .collect(),
            })
            .collect(),
    );
    let order_ids = bulk_create(
        &f,
        &orders,
        (0..n_orders)
            .map(|i| NewRecord {
                values: [
                    (pid.clone(), json!(100 + (i % 50) as i64)),
                    (lid.clone(), json!([customer_ids[i % n_customers]])),
                ]
                .into_iter()
                .collect(),
            })
            .collect(),
    );
    eprintln!(
        "created {n_customers} customers + {n_orders} linked orders in {:?}",
        t.elapsed()
    );

    // computed fields added to the populated tables: full recompute of every record
    let t = Instant::now();
    let total = f
        .formula(&orders, "Total", "{Price} * (1 - SUM({Discounts}))")
        .await;
    eprintln!(
        "formula over a lookup created for {n_orders} records in {:?}",
        t.elapsed()
    );
    let t = Instant::now();
    let spend = f
        .rollup(
            &customers,
            "Spend",
            &f.add_link_inverse(&link),
            &total,
            "SUM(values)",
        )
        .await;
    eprintln!(
        "rollup over {n_orders} formulas created in {:?}",
        t.elapsed()
    );
    Perf {
        total: sid(&total["id"]).to_string(),
        spend: sid(&spend["id"]).to_string(),
        f,
        customers,
        orders,
        discount: did,
        price: pid,
        customer_ids,
        order_ids,
    }
}

impl Fixture {
    /// The inverse of a link field, as the customers-side link field.
    fn add_link_inverse(&self, link: &serde_json::Value) -> serde_json::Value {
        link["inverse"].clone()
    }
}

async fn run(n_orders: usize, budget_ms: u128) {
    let p = build(n_orders).await;
    let f = &p.f;

    // correctness of the bulk result
    let o0 = &p.order_ids[0];
    assert_eq!(f.stored(o0, &p.total), 100.0 * (1.0 - 0.1));
    let c0 = &p.customer_ids[0];
    let expected_spend: f64 = (0..n_orders)
        .filter(|i| i % p.customer_ids.len() == 0)
        .map(|i| (100 + (i % 50) as i64) as f64 * 0.9)
        .sum();
    let got = f.stored(c0, &p.spend).as_f64().unwrap();
    assert!(
        (got - expected_spend).abs() < 1e-6,
        "{got} vs {expected_spend}"
    );

    // 1. edit an order's price: its formula and its customer's rollup
    let t = Instant::now();
    let r = f
        .set(&p.orders, &p.order_ids[1], json!({ &p.price: 1000 }))
        .await;
    let took = t.elapsed();
    eprintln!("edit one order price (formula + rollup recompute): {took:?}");
    assert_eq!(r["values"][&p.total], 900);
    assert!(took.as_millis() < budget_ms, "{took:?}");

    // 2. edit a customer's discount: its ~10 orders' lookups and formulas, then its rollup
    let t = Instant::now();
    f.set(
        &p.customers,
        &p.customer_ids[1],
        json!({ &p.discount: 0.5 }),
    )
    .await;
    let took = t.elapsed();
    eprintln!("edit one customer discount (10 orders + rollup): {took:?}");
    assert!(took.as_millis() < budget_ms, "{took:?}");
    assert_eq!(f.stored(&p.order_ids[1], &p.total), 500);

    // 3. the same edit with nothing depending on it
    let t = Instant::now();
    f.set(
        &p.customers,
        &p.customer_ids[2],
        json!({ &f.primary_id: "renamed" }),
    )
    .await;
    let took = t.elapsed();
    eprintln!("edit an unrelated cell: {took:?}");
    assert!(took.as_millis() < budget_ms, "{took:?}");

    // 4. worst case: one customer linked to as many orders as a link cell can hold,
    //    then its discount changes
    let hot_orders: Vec<&String> = p
        .order_ids
        .iter()
        .take(ob_core::limits::MAX_LINKS_PER_CELL)
        .collect();
    let n_hot = hot_orders.len();
    let hot = f.create(&p.customers, json!({ &p.discount: 0.2 })).await;
    let hot_id = sid(&hot["id"]).to_string();
    let inverse_link = f.field(&p.customers, "Orders").await;
    let t = Instant::now();
    f.set(
        &p.customers,
        &hot_id,
        json!({ sid(&inverse_link["id"]): hot_orders }),
    )
    .await;
    eprintln!("link {n_hot} orders to one customer: {:?}", t.elapsed());
    let t = Instant::now();
    f.set(&p.customers, &hot_id, json!({ &p.discount: 0.3 }))
        .await;
    let took = t.elapsed();
    eprintln!("edit the discount of a customer linked to {n_hot} orders: {took:?}");
    assert!(took.as_millis() < budget_ms * 20, "{took:?}");
    let hot_total = f.stored(&hot_id, &p.spend).as_f64().unwrap();
    assert!(hot_total > 0.0);
}

#[tokio::test]
async fn single_cell_edits_with_recompute_are_fast_at_5k_records() {
    run(5_000, 500).await;
}

#[tokio::test]
#[ignore = "50k records: run with --release -- --ignored --nocapture"]
async fn single_cell_edits_with_recompute_are_fast_at_50k_records() {
    run(50_000, 500).await;
}

/// Every write loads the base's schema and dependency graph (there is no
/// cache): measure it for a large-ish base so the decision is backed by a number.
#[tokio::test]
async fn loading_the_schema_graph_for_a_few_hundred_fields_is_cheap() {
    let f = Fixture::new().await;
    let mut tables = vec![f.table_id.clone()];
    for i in 1..20 {
        tables.push(id_of(&f.add_table(&format!("T{i}")).await));
    }
    // 20 tables x (1 number + 9 chained formulas + 5 more numbers) = 300 fields + the starters
    for t in &tables {
        f.number(t, "N").await;
        let mut prev = "N".to_string();
        for k in 0..9 {
            let name = format!("F{k}");
            f.formula(t, &name, &format!("{{{prev}}} + 1")).await;
            prev = name;
        }
        for k in 0..5 {
            f.number(t, &format!("X{k}")).await;
        }
    }
    let base = f.base_id.clone();
    let fields = f.app.query_i64(
        "SELECT count(*) FROM fields f JOIN tables t ON t.id = f.table_id WHERE t.base_id = ?1",
        &[&base],
    );
    let started = Instant::now();
    let runs = 20;
    for _ in 0..runs {
        let b = base.clone();
        f.app
            .state
            .db
            .write_sync(move |tx| {
                openbase::engine::recompute::BaseSchema::load(tx, &b)?;
                Ok(())
            })
            .unwrap();
    }
    let per_load = started.elapsed() / runs;
    eprintln!("schema + graph load for {fields} fields: {per_load:?} per write");
    assert!(per_load.as_millis() < 100, "{per_load:?}");
}
