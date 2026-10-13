//! Randomized consistency check of the incremental engine: after long
//! sequences of creates, edits, link changes, deletes and restores, (a) both
//! sides of every link agree and (b) recomputing every computed field from
//! scratch changes nothing for any live record, i.e. the incrementally
//! maintained values are exactly the from-scratch ones.

mod common;
mod records_support;
mod schema_support;

use std::collections::BTreeMap;

use opengrid::engine::recompute;
use records_support::*;
use serde_json::{Value, json};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a, T>(&mut self, v: &'a [T]) -> Option<&'a T> {
        if v.is_empty() {
            None
        } else {
            Some(&v[self.below(v.len())])
        }
    }
    fn subset(&mut self, v: &[String], max: usize) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for _ in 0..self.below(max + 1) {
            if let Some(x) = self.pick(v)
                && !out.contains(x)
            {
                out.push(x.clone());
            }
        }
        out
    }
}

struct World {
    f: Fixture,
    customers: String,
    orders: String,
    items: String,
    // fields
    c_name: String,
    c_orders: String,
    o_name: String,
    o_price: String,
    o_qty: String,
    o_customer: String,
    o_items: String,
    i_name: String,
    i_weight: String,
    i_order: String,
}

async fn world() -> World {
    let f = Fixture::new().await;
    let customers = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let items = id_of(&f.add_table("Items").await);
    let c_orders_l = f.add_link(&customers, "Orders", &orders).await;
    let o_items_l = f.add_link(&orders, "Items", &items).await;
    let price = f.number(&orders, "Price").await;
    let qty = f.number(&orders, "Qty").await;
    let weight = f.number(&items, "Weight").await;

    // customers: count, lookup, rollup, formulas (one shows linked names)
    f.count(&customers, "N", &c_orders_l).await;
    f.lookup(&customers, "Prices", &c_orders_l, &price).await;
    let total = f
        .rollup(&customers, "Total", &c_orders_l, &price, "SUM(values)")
        .await;
    let _ = total;
    f.formula(
        &customers,
        "Label",
        "{Name} & \": \" & ARRAYJOIN({Orders}, \",\")",
    )
    .await;
    f.formula(&customers, "Big", "IF({Total} > 50, \"big\", \"small\")")
        .await;
    // orders: formula, rollup over items, lookup of the customer name, formula over it
    let line = f.formula(&orders, "Line", "{Price} * {Qty}").await;
    let _ = line;
    let o_customer_f = c_orders_l["inverse"].clone();
    let cust_name = f
        .lookup(
            &orders,
            "Cust",
            &o_customer_f,
            &json!({ "id": f.primary_id }),
        )
        .await;
    let _ = cust_name;
    f.rollup(&orders, "Weight sum", &o_items_l, &weight, "SUM(values)")
        .await;
    f.formula(
        &orders,
        "Summary",
        "{Name} & \" x\" & {Qty} & \" w=\" & {Weight sum}",
    )
    .await;
    // items: lookup of the order's line and a count
    let i_order_f = o_items_l["inverse"].clone();
    let line_f = f.field(&orders, "Line").await;
    f.lookup(&items, "Order line", &i_order_f, &line_f).await;
    f.count(&items, "N orders", &i_order_f).await;

    let o_name = sid(&f.table(&orders).await["primary_field_id"]).to_string();
    let i_name = sid(&f.table(&items).await["primary_field_id"]).to_string();
    World {
        c_name: f.primary_id.clone(),
        c_orders: sid(&c_orders_l["id"]).to_string(),
        o_name,
        o_price: sid(&price["id"]).to_string(),
        o_qty: sid(&qty["id"]).to_string(),
        o_customer: sid(&o_customer_f["id"]).to_string(),
        o_items: sid(&o_items_l["id"]).to_string(),
        i_name,
        i_weight: sid(&weight["id"]).to_string(),
        i_order: sid(&i_order_f["id"]).to_string(),
        customers,
        orders,
        items,
        f,
    }
}

type Snapshot = BTreeMap<String, Value>;

/// Live records of the base: id -> data.
fn live_snapshot(w: &World) -> Snapshot {
    dump_records(&w.f.app, &w.f.base_id)
        .into_iter()
        .filter(|(_, (_, _, deleted))| deleted.is_none())
        .map(|(id, (_, data, _))| (id, data))
        .collect()
}

/// Same JSON, treating 1 and 1.0 alike.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn full_recompute(w: &World) {
    let base = w.f.base_id.clone();
    let schema_json = w.f.app.state.db.write_sync(|tx| {
        let mut per_table = Vec::new();
        for t in opengrid::store::schema::live_tables(tx, &base)? {
            let ids: Vec<String> = opengrid::store::schema::table_fields(tx, &t.id)?
                .into_iter()
                .map(|f| f.id)
                .collect();
            per_table.push((t.id, ids));
        }
        for (t, ids) in per_table {
            recompute::recompute_fields(tx, &base, &t, &ids)?;
        }
        Ok(())
    });
    schema_json.unwrap();
}

async fn run(seed: u64, steps: usize) {
    let w = world().await;
    let f = &w.f;
    let mut rng = Rng(seed);
    let mut live: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    let mut trashed: BTreeMap<&str, Vec<String>> = BTreeMap::new();
    for t in [&w.customers, &w.orders, &w.items] {
        live.insert(t.as_str(), Vec::new());
        trashed.insert(t.as_str(), Vec::new());
    }
    let tables = [w.customers.clone(), w.orders.clone(), w.items.clone()];

    for step in 0..steps {
        let table = tables[rng.below(3)].clone();
        let t = table.as_str();
        let op = rng.below(12);
        match op {
            // create
            0..=3 => {
                let (name_f, values) = match t {
                    _ if t == w.customers => (&w.c_name, json!({ &w.c_name: format!("c{step}") })),
                    _ if t == w.orders => (
                        &w.o_name,
                        json!({ &w.o_name: format!("o{step}"), &w.o_price: rng.below(40), &w.o_qty: 1 + rng.below(3) }),
                    ),
                    _ => (
                        &w.i_name,
                        json!({ &w.i_name: format!("i{step}"), &w.i_weight: rng.below(9) }),
                    ),
                };
                let _ = name_f;
                // sometimes already linked to existing records
                let mut values = values;
                if t == w.orders {
                    let c = rng.subset(&live[w.customers.as_str()], 1);
                    if !c.is_empty() {
                        values[&w.o_customer] = json!(c);
                    }
                    let i = rng.subset(&live[w.items.as_str()], 2);
                    if !i.is_empty() {
                        values[&w.o_items] = json!(i);
                    }
                }
                let rec = f.create(t, values).await;
                live.get_mut(t).unwrap().push(sid(&rec["id"]).to_string());
            }
            // edit a value
            4..=5 => {
                let Some(id) = rng.pick(&live[t]).cloned() else {
                    continue;
                };
                let values = if t == w.customers {
                    json!({ &w.c_name: format!("renamed{step}") })
                } else if t == w.orders {
                    match rng.below(3) {
                        0 => json!({ &w.o_name: format!("n{step}") }),
                        1 => json!({ &w.o_price: rng.below(60) }),
                        _ => json!({ &w.o_qty: rng.below(5) }),
                    }
                } else if rng.below(2) == 0 {
                    json!({ &w.i_weight: rng.below(20) })
                } else {
                    json!({ &w.i_name: format!("w{step}") })
                };
                f.set(t, &id, values).await;
            }
            // change links from either side
            6..=8 => {
                let Some(id) = rng.pick(&live[t]).cloned() else {
                    continue;
                };
                let (field, target) = if t == w.customers {
                    (&w.c_orders, &w.orders)
                } else if t == w.orders {
                    if rng.below(2) == 0 {
                        (&w.o_customer, &w.customers)
                    } else {
                        (&w.o_items, &w.items)
                    }
                } else {
                    (&w.i_order, &w.orders)
                };
                let ids = rng.subset(&live[target.as_str()], 3);
                f.set(t, &id, json!({ field: ids })).await;
            }
            // delete
            9 | 11 => {
                let Some(id) = rng.pick(&live[t]).cloned() else {
                    continue;
                };
                f.delete_records(t, &[&id]).await.assert_status(204);
                live.get_mut(t).unwrap().retain(|x| x != &id);
                trashed.get_mut(t).unwrap().push(id);
            }
            // restore
            10 => {
                let Some(id) = rng.pick(&trashed[t]).cloned() else {
                    continue;
                };
                f.restore_records(t, &[&id]).await.assert_status(200);
                trashed.get_mut(t).unwrap().retain(|x| x != &id);
                live.get_mut(t).unwrap().push(id);
            }
            // reorder, which must not disturb anything
            _ => {
                let Some(id) = rng.pick(&live[t]).cloned() else {
                    continue;
                };
                f.app
                    .post(
                        &f.owner,
                        &format!("{}/move", records_url(t)),
                        json!({ "ids": [id] }),
                    )
                    .await
                    .assert_status(200);
            }
        }

        if step % 25 == 24 || step + 1 == steps {
            check(&w, seed, step);
        }
    }
    let sizes: Vec<usize> = tables.iter().map(|t| live[t.as_str()].len()).collect();
    let trash: Vec<usize> = tables.iter().map(|t| trashed[t.as_str()].len()).collect();
    eprintln!("seed {seed:#x}: live {sizes:?}, trashed {trash:?}");
    assert!(
        sizes.iter().all(|n| *n >= 3),
        "the run should build up real data: {sizes:?}"
    );
}

fn check(w: &World, seed: u64, step: usize) {
    // (a) both sides of every link agree
    let schema = {
        let base = w.f.base_id.clone();
        w.f.app
            .state
            .db
            .write_sync(|tx| {
                let mut tables = Vec::new();
                for t in opengrid::store::schema::live_tables(tx, &base)? {
                    let fields = opengrid::store::schema::table_fields(tx, &t.id)?;
                    tables.push(json!({
                        "id": t.id,
                        "fields": fields.iter().map(|f| serde_json::to_value(f).unwrap()).collect::<Vec<_>>(),
                    }));
                }
                Ok(json!({ "tables": tables }))
            })
            .unwrap()
    };
    let all = dump_records(&w.f.app, &w.f.base_id);
    assert!(
        assert_link_arrays_consistent(&schema, &all) > 0 || step < 5,
        "seed {seed} step {step}"
    );

    // (b) incremental == from scratch, for every live record
    let before = live_snapshot(w);
    full_recompute(w);
    let after = live_snapshot(w);
    assert_eq!(before.len(), after.len());
    for (id, data) in &before {
        assert!(
            same(data, &after[id]),
            "seed {seed} step {step}: record {id} drifted\nincremental: {data}\nfrom scratch: {}",
            after[id]
        );
    }
}

#[tokio::test]
async fn incremental_recompute_matches_a_full_recompute_seed_1() {
    run(0x9E37_79B9_7F4A_7C15, 400).await;
}

#[tokio::test]
async fn incremental_recompute_matches_a_full_recompute_seed_2() {
    run(0xD1B5_4A32_D192_ED03, 400).await;
}

#[tokio::test]
async fn incremental_recompute_matches_a_full_recompute_seed_3() {
    run(0x1234_5678_9ABC_DEF1, 400).await;
}
