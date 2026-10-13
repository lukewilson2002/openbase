//! The recompute engine: computed values are materialized into
//! `records.data` and kept current across fields, links and tables.

mod common;
mod records_support;
mod schema_support;

use records_support::*;
use serde_json::{Value, json};

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// table -> (created, updated, deleted)
type Events = std::collections::BTreeMap<String, (Vec<String>, Vec<String>, Vec<String>)>;

/// Drain the events of a base into table -> (created, updated, deleted).
fn drain(
    rx: &mut tokio::sync::broadcast::Receiver<std::sync::Arc<og_core::api::events::EventEnvelope>>,
) -> Events {
    let mut out: Events = Default::default();
    while let Ok(ev) = rx.try_recv() {
        if let og_core::api::events::BaseEvent::RecordsChanged {
            table_id,
            created,
            updated,
            deleted,
        } = ev.event.clone()
        {
            let e = out.entry(table_id).or_default();
            e.0.extend(created);
            e.1.extend(updated);
            e.2.extend(deleted);
        }
    }
    out
}

// ------------------------------------------------------------ same record

#[tokio::test]
async fn formulas_are_materialized_and_chain_in_dependency_order() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let price = f.number(&t, "Price").await;
    let qty = f.number(&t, "Qty").await;
    // declared in the "wrong" order on purpose: Label reads Total which reads Price and Qty
    let total = f.formula(&t, "Total", "{Price} * {Qty}").await;
    let label = f.formula(&t, "Label", "\"Total: \" & {Total}").await;
    let (pid, qid, tid, lid) = (
        sid(&price["id"]),
        sid(&qty["id"]),
        sid(&total["id"]),
        sid(&label["id"]),
    );

    let rec = f.create(&t, json!({ pid: 2, qid: 3 })).await;
    let rid = sid(&rec["id"]);
    assert_eq!(rec["values"][tid], 6);
    assert_eq!(rec["values"][lid], "Total: 6");
    assert_eq!(f.stored(rid, tid), 6, "materialized in records.data");

    let rec = f.set(&t, rid, json!({ pid: 5 })).await;
    assert_eq!(rec["values"][tid], 15);
    assert_eq!(rec["values"][lid], "Total: 15");

    // blanks count as 0 in arithmetic; a formula with no inputs still gets a value
    let empty = f.create(&t, json!({})).await;
    assert_eq!(empty["values"][tid], 0);
    assert_eq!(empty["values"][lid], "Total: 0");
    let constant = f.formula(&t, "One", "1 + 1").await;
    assert_eq!(
        f.stored(sid(&empty["id"]), sid(&constant["id"])),
        2,
        "filled for existing records"
    );
    let later = f.create(&t, json!({})).await;
    assert_eq!(later["values"][sid(&constant["id"])], 2, "and for new ones");
}

#[tokio::test]
async fn blank_results_are_not_stored_and_errors_are_stored_as_objects() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    let nid = sid(&n["id"]);
    let blank = f.formula(&t, "Blank", "IF({N} > 5, \"big\")").await;
    let div = f.formula(&t, "Div", "10 / {N}").await;
    let rec = f.create(&t, json!({ nid: 0 })).await;
    let rid = sid(&rec["id"]);
    assert!(rec["values"].get(sid(&blank["id"])).is_none());
    assert!(f.record_data(rid).get(sid(&blank["id"])).is_none());
    let err = &rec["values"][sid(&div["id"])];
    assert!(err["error"].as_str().unwrap().contains("ERROR"), "{err}");
    assert_eq!(&f.stored(rid, sid(&div["id"])), err);

    // recovers once the input is valid again
    let rec = f.set(&t, rid, json!({ nid: 10 })).await;
    assert_eq!(rec["values"][sid(&blank["id"])], "big");
    assert_eq!(rec["values"][sid(&div["id"])], 1);
}

#[tokio::test]
async fn formula_results_follow_their_declared_type() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let d = f
        .add_field(&t, json!({ "name": "Due", "type": "date", "options": {} }))
        .await;
    let flag = f
        .add_field(
            &t,
            json!({ "name": "Done", "type": "checkbox", "options": {} }),
        )
        .await;
    let plus = f.formula(&t, "Later", "DATEADD({Due}, 7, 'days')").await;
    let is_done = f.formula(&t, "IsDone", "{Done}").await;
    let text = f.formula(&t, "Mixed", "IF({Done}, 1, \"no\")").await;
    assert_eq!(plus["options"]["result_type"], "date");
    assert_eq!(is_done["options"]["result_type"], "bool");
    assert_eq!(text["options"]["result_type"], "text");
    let rec = f
        .create(
            &t,
            json!({ sid(&d["id"]): "2026-01-01", sid(&flag["id"]): true }),
        )
        .await;
    let v = &rec["values"];
    assert!(sid(&v[sid(&plus["id"])]).starts_with("2026-01-08"), "{v}");
    assert_eq!(v[sid(&is_done["id"])], true);
    assert_eq!(v[sid(&text["id"])], "1", "the number is conformed to text");
}

#[tokio::test]
async fn unrelated_edits_do_not_cascade() {
    let l = linked().await;
    let f = &l.f;
    let total = f
        .rollup(&l.t1, "Sum", &l.link, &l.price, "SUM(values)")
        .await;
    let t2p = sid(&f.table(&l.t2).await["primary_field_id"]).to_string();
    let o = f.create(&l.t2, json!({ sid(&l.price["id"]): 10 })).await;
    let c = f
        .create(&l.t1, json!({ sid(&l.link["id"]): [o["id"]] }))
        .await;
    assert_eq!(c["values"][sid(&total["id"])], 10);
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    // editing a field no computed value reads announces only the edited record
    f.set(&l.t2, sid(&o["id"]), json!({ &t2p: "just a name" }))
        .await;
    let ev = drain(&mut rx);
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(ev[&l.t2].1, s(&[sid(&o["id"])]));
    // while a price edit reaches the customer's rollup
    f.set(&l.t2, sid(&o["id"]), json!({ sid(&l.price["id"]): 11 }))
        .await;
    let ev = drain(&mut rx);
    assert_eq!(ev[&l.t1].1, s(&[sid(&c["id"])]));
    // and a price edit that leaves the rollup unchanged stops there
    let o2 = f.create(&l.t2, json!({ sid(&l.price["id"]): 0 })).await;
    f.set(
        &l.t1,
        sid(&c["id"]),
        json!({ sid(&l.link["id"]): [o["id"], o2["id"]] }),
    )
    .await;
    let _ = drain(&mut rx);
    f.set(&l.t2, sid(&o2["id"]), json!({ sid(&l.price["id"]): null }))
        .await;
    let ev = drain(&mut rx);
    assert!(!ev.contains_key(&l.t1), "the sum did not change: {ev:?}");
}

// ------------------------------------------------- lookups, rollups, counts

#[tokio::test]
async fn lookups_rollups_and_counts_follow_the_links() {
    let l = linked().await;
    let f = &l.f;
    let lookup = f.lookup(&l.t1, "Prices", &l.link, &l.price).await;
    let rollup = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    let count = f.count(&l.t1, "N", &l.link).await;
    let (lk, ru, ct) = (sid(&lookup["id"]), sid(&rollup["id"]), sid(&count["id"]));
    let pid = sid(&l.price["id"]);

    let (o1, o2) = (
        sid(&f.create(&l.t2, json!({ pid: 10 })).await["id"]).to_string(),
        sid(&f.create(&l.t2, json!({ pid: 20 })).await["id"]).to_string(),
    );
    let c = f.create(&l.t1, json!({})).await;
    let cid = sid(&c["id"]).to_string();
    assert!(
        c["values"].get(lk).is_none(),
        "an empty lookup is not stored"
    );
    assert_eq!(c["values"][ru], 0, "SUM over nothing is 0");
    assert_eq!(c["values"][ct], 0);

    let c = f
        .set(&l.t1, &cid, json!({ sid(&l.link["id"]): [o1, o2] }))
        .await;
    assert_eq!(
        c["values"][lk],
        json!([10, 20]),
        "target values in link order"
    );
    assert_eq!(c["values"][ru], 30);
    assert_eq!(c["values"][ct], 2);

    // editing a linked record cascades to the customer
    f.set(&l.t2, &o1, json!({ pid: 15 })).await;
    let c = f.get(&l.t1, &cid).await;
    assert_eq!(c["values"][lk], json!([15, 20]));
    assert_eq!(c["values"][ru], 35);

    // reordering the links reorders the lookup
    f.set(&l.t1, &cid, json!({ sid(&l.link["id"]): [o2, o1] }))
        .await;
    assert_eq!(f.get(&l.t1, &cid).await["values"][lk], json!([20, 15]));

    // blank targets are skipped
    f.set(&l.t2, &o2, json!({ pid: null })).await;
    let c = f.get(&l.t1, &cid).await;
    assert_eq!(c["values"][lk], json!([15]));
    assert_eq!(c["values"][ct], 2, "the count still counts the record");

    // linking from the other side updates the customer too
    let o3 = sid(&f.create(&l.t2, json!({ pid: 100 })).await["id"]).to_string();
    f.set(&l.t2, &o3, json!({ sid(&l.inverse["id"]): [cid] }))
        .await;
    let c = f.get(&l.t1, &cid).await;
    assert_eq!(c["values"][ru], 115);
    assert_eq!(c["values"][ct], 3);
    // and unlinking from the other side
    f.set(&l.t2, &o3, json!({ sid(&l.inverse["id"]): [] }))
        .await;
    let c = f.get(&l.t1, &cid).await;
    assert_eq!(c["values"][ru], 15);
    assert_eq!(c["values"][ct], 2);
}

#[tokio::test]
async fn deleting_and_restoring_linked_records_updates_counts_lookups_and_rollups() {
    let l = linked().await;
    let f = &l.f;
    let lookup = f.lookup(&l.t1, "Prices", &l.link, &l.price).await;
    let rollup = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    let count = f.count(&l.t1, "N", &l.link).await;
    let inv_count = f.count(&l.t2, "Customers", &l.inverse).await;
    let pid = sid(&l.price["id"]);
    let o1 = sid(&f.create(&l.t2, json!({ pid: 10 })).await["id"]).to_string();
    let o2 = sid(&f.create(&l.t2, json!({ pid: 20 })).await["id"]).to_string();
    let c = sid(&f
        .create(&l.t1, json!({ sid(&l.link["id"]): [o1, o2] }))
        .await["id"])
    .to_string();
    let read = |id: &'static str| {
        let (f, c) = (f, c.clone());
        let t1 = l.t1.clone();
        async move { f.get(&t1, &c).await["values"][id].clone() }
    };
    let (lk, ru, ct) = (sid(&lookup["id"]), sid(&rollup["id"]), sid(&count["id"]));
    let lk: &'static str = Box::leak(lk.to_string().into_boxed_str());
    let ru: &'static str = Box::leak(ru.to_string().into_boxed_str());
    let ct: &'static str = Box::leak(ct.to_string().into_boxed_str());
    assert_eq!(read(ct).await, 2);

    f.delete_records(&l.t2, &[&o1]).await.assert_status(200);
    assert_eq!(read(ct).await, 1, "trashed records are not counted");
    assert_eq!(read(lk).await, json!([20]));
    assert_eq!(read(ru).await, 20);
    assert_eq!(
        f.stored(&c, sid(&rollup["id"])),
        20,
        "the stored value was recomputed"
    );

    f.restore_records(&l.t2, &[&o1]).await.assert_status(200);
    assert_eq!(read(ct).await, 2);
    assert_eq!(read(lk).await, json!([10, 20]));
    assert_eq!(read(ru).await, 30);

    // deleting the customer: its orders stop counting it
    assert_eq!(f.get(&l.t2, &o1).await["values"][sid(&inv_count["id"])], 1);
    f.delete_records(&l.t1, &[&c]).await.assert_status(200);
    let v = f.get(&l.t2, &o1).await["values"][sid(&inv_count["id"])].clone();
    assert!(v.is_null() || v == 0, "{v}");
    f.restore_records(&l.t1, &[&c]).await.assert_status(200);
    assert_eq!(f.get(&l.t2, &o1).await["values"][sid(&inv_count["id"])], 1);
}

#[tokio::test]
async fn restoring_a_record_refreshes_its_stale_computed_fields() {
    let l = linked().await;
    let f = &l.f;
    let rollup = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    let pid = sid(&l.price["id"]);
    let o = sid(&f.create(&l.t2, json!({ pid: 10 })).await["id"]).to_string();
    let c = sid(&f.create(&l.t1, json!({ sid(&l.link["id"]): [o] })).await["id"]).to_string();
    f.delete_records(&l.t1, &[&c]).await.assert_status(200);
    // while the customer is trashed its order changes; its materialized total goes stale
    f.set(&l.t2, &o, json!({ pid: 99 })).await;
    f.restore_records(&l.t1, &[&c]).await.assert_status(200);
    assert_eq!(f.get(&l.t1, &c).await["values"][sid(&rollup["id"])], 99);
}

#[tokio::test]
async fn a_lookup_of_a_link_field_yields_the_linked_primary_names() {
    let f = Fixture::new().await;
    let a = f.table_id.clone();
    let b = id_of(&f.add_table("Orders").await);
    let c = id_of(&f.add_table("Lines").await);
    let a_to_b = f.add_link(&a, "Orders", &b).await;
    let b_to_c = f.add_link(&b, "Lines", &c).await;
    let lookup = f.lookup(&a, "Their lines", &a_to_b, &b_to_c).await;
    assert_eq!(lookup["options"]["result_type"], json!({ "array": "text" }));
    let c_primary = sid(&f.table(&c).await["primary_field_id"]).to_string();
    let l1 = f.create(&c, json!({ &c_primary: "Widget" })).await;
    let l2 = f.create(&c, json!({ &c_primary: "Gadget" })).await;
    let l3 = f.create(&c, json!({ &c_primary: "Gizmo" })).await;
    let o1 = f
        .create(&b, json!({ sid(&b_to_c["id"]): [l1["id"], l2["id"]] }))
        .await;
    let o2 = f
        .create(&b, json!({ sid(&b_to_c["id"]): [l3["id"]] }))
        .await;
    let rec = f
        .create(&a, json!({ sid(&a_to_b["id"]): [o1["id"], o2["id"]] }))
        .await;
    // nested arrays are flattened one level
    assert_eq!(
        rec["values"][sid(&lookup["id"])],
        json!(["Widget", "Gadget", "Gizmo"])
    );
    // renaming a line updates the lookup two hops away
    f.set(&c, sid(&l3["id"]), json!({ &c_primary: "Gizmo 2" }))
        .await;
    assert_eq!(
        f.get(&a, sid(&rec["id"])).await["values"][sid(&lookup["id"])],
        json!(["Widget", "Gadget", "Gizmo 2"])
    );
}

#[tokio::test]
async fn lookups_carry_every_kind_of_target_value() {
    let l = linked().await;
    let f = &l.f;
    let tags = f
        .add_field(
            &l.t2,
            json!({ "name": "Tags", "type": "multiple_select",
                    "options": { "choices": [ { "name": "red" }, { "name": "blue" }, { "name": "green" } ] } }),
        )
        .await;
    let due = f
        .add_field(
            &l.t2,
            json!({ "name": "Due", "type": "date", "options": {} }),
        )
        .await;
    let paid = f
        .add_field(
            &l.t2,
            json!({ "name": "Paid", "type": "checkbox", "options": {} }),
        )
        .await;
    let auto = f
        .add_field(
            &l.t2,
            json!({ "name": "No", "type": "autonumber", "options": {} }),
        )
        .await;
    let (tags_l, due_l, paid_l, auto_l) = (
        f.lookup(&l.t1, "L tags", &l.link, &tags).await,
        f.lookup(&l.t1, "L due", &l.link, &due).await,
        f.lookup(&l.t1, "L paid", &l.link, &paid).await,
        f.lookup(&l.t1, "L no", &l.link, &auto).await,
    );
    assert_eq!(tags_l["options"]["result_type"], json!({ "array": "text" }));
    let o1 = f
        .create(&l.t2, json!({ sid(&tags["id"]): ["red", "blue"], sid(&due["id"]): "2026-05-01", sid(&paid["id"]): true }))
        .await;
    let o2 = f
        .create(
            &l.t2,
            json!({ sid(&tags["id"]): ["green"], sid(&due["id"]): "2026-06-01" }),
        )
        .await;
    let c = f
        .create(&l.t1, json!({ sid(&l.link["id"]): [o1["id"], o2["id"]] }))
        .await;
    let v = &c["values"];
    assert_eq!(
        v[sid(&tags_l["id"])],
        json!(["red", "blue", "green"]),
        "multi selects are flattened"
    );
    assert_eq!(v[sid(&due_l["id"])], json!(["2026-05-01", "2026-06-01"]));
    assert_eq!(v[sid(&paid_l["id"])], json!([true, false]));
    assert_eq!(
        v[sid(&auto_l["id"])],
        json!([1, 2]),
        "system fields are readable through lookups"
    );
}

#[tokio::test]
async fn rollup_expressions_run_over_the_values_array() {
    let l = linked().await;
    let f = &l.f;
    let pid = sid(&l.price["id"]);
    let max = f
        .rollup(&l.t1, "Max", &l.link, &l.price, "MAX(values)")
        .await;
    let avg = f
        .rollup(&l.t1, "Avg", &l.link, &l.price, "AVERAGE(values)")
        .await;
    let joined = f
        .rollup(
            &l.t1,
            "Joined",
            &l.link,
            &l.price,
            "ARRAYJOIN(values, \" | \")",
        )
        .await;
    let filled = f
        .rollup(&l.t1, "Filled", &l.link, &l.price, "COUNTA(values)")
        .await;
    assert_eq!(joined["options"]["result_type"], "text");
    let o: Vec<String> = {
        let mut v = Vec::new();
        for p in [4, 8, 6] {
            v.push(sid(&f.create(&l.t2, json!({ pid: p })).await["id"]).to_string());
        }
        v
    };
    let c = f.create(&l.t1, json!({ sid(&l.link["id"]): o })).await;
    let v = &c["values"];
    assert_eq!(v[sid(&max["id"])], 8);
    assert_eq!(v[sid(&avg["id"])], 6);
    assert_eq!(v[sid(&joined["id"])], "4 | 8 | 6");
    assert_eq!(v[sid(&filled["id"])], 3);
}

#[tokio::test]
async fn formula_over_lookup_over_rollup_across_three_tables() {
    let f = Fixture::new().await;
    let customers = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let lines = id_of(&f.add_table("Lines").await);
    let c_to_o = f.add_link(&customers, "Orders", &orders).await;
    let o_to_l = f.add_link(&orders, "Lines", &lines).await;
    let amount = f.number(&lines, "Amount").await;
    let order_total = f
        .rollup(&orders, "Order total", &o_to_l, &amount, "SUM(values)")
        .await;
    f.lookup(&customers, "Order totals", &c_to_o, &order_total)
        .await;
    let spend = f.formula(&customers, "Spend", "SUM({Order totals})").await;
    let big = f
        .formula(
            &customers,
            "Big spender",
            "IF({Spend} >= 100, \"yes\", \"no\")",
        )
        .await;
    assert_eq!(spend["options"]["result_type"], "number");
    let (aid, tid, sp, bg) = (
        sid(&amount["id"]),
        sid(&order_total["id"]),
        sid(&spend["id"]),
        sid(&big["id"]),
    );

    let mk_line = |n: i64| {
        let (f, lines, aid) = (&f, lines.clone(), aid.to_string());
        async move { sid(&f.create(&lines, json!({ aid: n })).await["id"]).to_string() }
    };
    let (l1, l2, l3) = (mk_line(30).await, mk_line(20).await, mk_line(70).await);
    let o1 = sid(&f
        .create(&orders, json!({ sid(&o_to_l["id"]): [l1, l2] }))
        .await["id"])
    .to_string();
    let o2 = sid(&f.create(&orders, json!({ sid(&o_to_l["id"]): [l3] })).await["id"]).to_string();
    assert_eq!(f.get(&orders, &o1).await["values"][tid], 50);
    let c = sid(&f
        .create(&customers, json!({ sid(&c_to_o["id"]): [o1] }))
        .await["id"])
    .to_string();
    let v = f.get(&customers, &c).await;
    assert_eq!(v["values"][sp], 50);
    assert_eq!(v["values"][bg], "no");

    // an edit three tables away reaches the formula
    f.set(&lines, &l1, json!({ aid: 80 })).await;
    let v = f.get(&customers, &c).await;
    assert_eq!(v["values"][sp], 100);
    assert_eq!(v["values"][bg], "yes");

    // a new link in the middle table
    f.set(&customers, &c, json!({ sid(&c_to_o["id"]): [o1, o2] }))
        .await;
    assert_eq!(f.get(&customers, &c).await["values"][sp], 170);

    // removing a line from an order
    f.set(&orders, &o1, json!({ sid(&o_to_l["id"]): [l2] }))
        .await;
    assert_eq!(f.get(&orders, &o1).await["values"][tid], 20);
    assert_eq!(f.get(&customers, &c).await["values"][sp], 90);
    assert_eq!(f.get(&customers, &c).await["values"][bg], "no");

    // deleting and restoring the line two hops away
    f.delete_records(&lines, &[&l3]).await.assert_status(200);
    assert_eq!(f.get(&customers, &c).await["values"][sp], 20);
    f.restore_records(&lines, &[&l3]).await.assert_status(200);
    assert_eq!(f.get(&customers, &c).await["values"][sp], 90);
    // deleting the order in the middle
    f.delete_records(&orders, &[&o2]).await.assert_status(200);
    assert_eq!(f.get(&customers, &c).await["values"][sp], 20);
}

#[tokio::test]
async fn formulas_over_links_show_primary_text_and_follow_renames() {
    let l = linked().await;
    let f = &l.f;
    let t2p = sid(&f.table(&l.t2).await["primary_field_id"]).to_string();
    let joined = f
        .formula(&l.t1, "Order names", "ARRAYJOIN({Orders}, \", \")")
        .await;
    let first = f.formula(&l.t1, "Shout", "UPPER({Order names})").await;
    let o1 = sid(&f.create(&l.t2, json!({ &t2p: "alpha" })).await["id"]).to_string();
    let o2 = sid(&f.create(&l.t2, json!({ &t2p: "beta" })).await["id"]).to_string();
    let c = sid(&f
        .create(&l.t1, json!({ sid(&l.link["id"]): [o1, o2] }))
        .await["id"])
    .to_string();
    let (jid, sh) = (sid(&joined["id"]), sid(&first["id"]));
    assert_eq!(f.get(&l.t1, &c).await["values"][jid], "alpha, beta");
    assert_eq!(f.get(&l.t1, &c).await["values"][sh], "ALPHA, BETA");
    // renaming a linked record updates the formula over the link
    f.set(&l.t2, &o1, json!({ &t2p: "gamma" })).await;
    assert_eq!(f.get(&l.t1, &c).await["values"][jid], "gamma, beta");
    assert_eq!(f.get(&l.t1, &c).await["values"][sh], "GAMMA, BETA");
    // trashed linked records drop out
    f.delete_records(&l.t2, &[&o2]).await.assert_status(200);
    assert_eq!(f.get(&l.t1, &c).await["values"][jid], "gamma");
    f.restore_records(&l.t2, &[&o2]).await.assert_status(200);
    assert_eq!(f.get(&l.t1, &c).await["values"][jid], "gamma, beta");
}

#[tokio::test]
async fn changing_the_primary_field_refreshes_formulas_that_show_link_names() {
    let l = linked().await;
    let f = &l.f;
    let t2p = sid(&f.table(&l.t2).await["primary_field_id"]).to_string();
    let joined = f
        .formula(&l.t1, "Order names", "ARRAYJOIN({Orders}, \", \")")
        .await;
    let pid = sid(&l.price["id"]);
    let o = sid(&f.create(&l.t2, json!({ &t2p: "alpha", pid: 42 })).await["id"]).to_string();
    let c = sid(&f.create(&l.t1, json!({ sid(&l.link["id"]): [o] })).await["id"]).to_string();
    assert_eq!(
        f.get(&l.t1, &c).await["values"][sid(&joined["id"])],
        "alpha"
    );
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{}/primary-field", l.t2),
            json!({ "field_id": pid }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.get(&l.t1, &c).await["values"][sid(&joined["id"])], "42");
}

// ------------------------------------------------------------ system fields

#[tokio::test]
async fn system_fields_are_synthesized_not_stored() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let auto = f
        .add_field(
            &t,
            json!({ "name": "No", "type": "autonumber", "options": {} }),
        )
        .await;
    let made = f
        .add_field(
            &t,
            json!({ "name": "Made", "type": "created_time", "options": {} }),
        )
        .await;
    let by = f
        .add_field(
            &t,
            json!({ "name": "By", "type": "created_by", "options": {} }),
        )
        .await;
    let touched = f
        .add_field(
            &t,
            json!({ "name": "Touched", "type": "last_modified_time", "options": {} }),
        )
        .await;
    let touched_by = f
        .add_field(
            &t,
            json!({ "name": "Touched by", "type": "last_modified_by", "options": {} }),
        )
        .await;
    let rec = f.create(&t, json!({ &f.primary_id: "x" })).await;
    let rid = sid(&rec["id"]);
    let v = &rec["values"];
    assert_eq!(v[sid(&auto["id"])], 1);
    assert_eq!(v[sid(&by["id"])], f.owner.user_id.clone().unwrap());
    assert_eq!(v[sid(&touched_by["id"])], f.owner.user_id.clone().unwrap());
    assert!(sid(&v[sid(&made["id"])]).ends_with('Z'));
    assert_eq!(v[sid(&made["id"])], v[sid(&touched["id"])], "just created");
    let data = f.record_data(rid);
    for fld in [&auto, &made, &by, &touched, &touched_by] {
        assert!(
            data.get(sid(&fld["id"])).is_none(),
            "{} must not be stored",
            fld["name"]
        );
    }

    // another user edits: last modified moves, created stays
    let other = f.member("editor2@example.com", opengrid::perm::Role::Editor);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let r = f
        .patch_as(&other, &t, rid, json!({ &f.primary_id: "y" }))
        .await;
    r.assert_status(200);
    let v = &r.body["records"][0]["values"];
    assert_eq!(v[sid(&touched_by["id"])], other.user_id.clone().unwrap());
    assert_eq!(v[sid(&by["id"])], f.owner.user_id.clone().unwrap());
    assert_ne!(v[sid(&made["id"])], v[sid(&touched["id"])]);
    assert_eq!(v[sid(&auto["id"])], 1);
}

#[tokio::test]
async fn formulas_can_read_system_fields_and_record_functions() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    f.add_field(
        &t,
        json!({ "name": "No", "type": "autonumber", "options": {} }),
    )
    .await;
    f.add_field(
        &t,
        json!({ "name": "Touched", "type": "last_modified_time", "options": {} }),
    )
    .await;
    let lbl = f.formula(&t, "Label", "\"#\" & {No}").await;
    let when = f.formula(&t, "When", "{Touched}").await;
    let fn_touched = f.formula(&t, "Fn touched", "LAST_MODIFIED_TIME()").await;
    let rid_f = f.formula(&t, "Rid", "RECORD_ID()").await;
    let rec = f.create(&t, json!({})).await;
    let rid = sid(&rec["id"]).to_string();
    let v = &rec["values"];
    assert_eq!(v[sid(&lbl["id"])], "#1");
    assert_eq!(v[sid(&rid_f["id"])], rid);
    let t0 = v[sid(&when["id"])].clone();
    assert_eq!(v[sid(&fn_touched["id"])], t0);
    // an edit moves both the system field and the formulas that read it
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let v = f.set(&t, &rid, json!({ &f.primary_id: "edit" })).await["values"].clone();
    assert_ne!(
        v[sid(&when["id"])],
        t0,
        "formula over a last-modified field"
    );
    assert_ne!(
        v[sid(&fn_touched["id"])],
        t0,
        "LAST_MODIFIED_TIME() formula"
    );
    assert_eq!(v[sid(&when["id"])], v[sid(&fn_touched["id"])]);
}

#[tokio::test]
async fn watched_last_modified_fields_only_move_for_their_fields() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let watch = f
        .add_field(
            &t,
            json!({ "name": "Notes touched", "type": "last_modified_time",
                    "options": { "fields": [f.notes_id] } }),
        )
        .await;
    let who = f
        .add_field(
            &t,
            json!({ "name": "Notes by", "type": "last_modified_by",
                    "options": { "fields": [f.notes_id] } }),
        )
        .await;
    let fn_f = f.formula(&t, "Fn", "LAST_MODIFIED_TIME({Notes})").await;
    let rec = f.create(&t, json!({ &f.notes_id: "first" })).await;
    let rid = sid(&rec["id"]).to_string();
    let t0 = rec["values"][sid(&watch["id"])].clone();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    // editing another field does not move it
    let other = f.member("ed@example.com", opengrid::perm::Role::Editor);
    let r = f
        .patch_as(&other, &t, &rid, json!({ &f.primary_id: "name" }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["records"][0]["values"][sid(&watch["id"])], t0);
    assert_eq!(
        r.body["records"][0]["values"][sid(&who["id"])],
        f.owner.user_id.clone().unwrap(),
        "still the author of the last Notes edit"
    );
    assert_eq!(r.body["records"][0]["values"][sid(&fn_f["id"])], t0);
    // editing the watched field does
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let r = f
        .patch_as(&other, &t, &rid, json!({ &f.notes_id: "second" }))
        .await;
    let v = &r.body["records"][0]["values"];
    assert_ne!(v[sid(&watch["id"])], t0);
    assert_eq!(v[sid(&who["id"])], other.user_id.clone().unwrap());
    assert_eq!(v[sid(&fn_f["id"])], v[sid(&watch["id"])]);
}

// -------------------------------------------------------------------- buttons

#[tokio::test]
async fn buttons_store_their_url_when_it_is_safe() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let btn = f
        .add_field(
            &t,
            json!({ "name": "Open", "type": "button",
                    "options": { "label": "Open", "url_formula": "\"https://example.com/?q=\" & ENCODE_URL_COMPONENT({Name})" } }),
        )
        .await;
    let bad = f
        .add_field(
            &t,
            json!({ "name": "Bad", "type": "button",
                    "options": { "label": "Bad", "url_formula": "\"javascript:alert(1)\"" } }),
        )
        .await;
    let rec = f.create(&t, json!({ &f.primary_id: "a b" })).await;
    assert_eq!(
        rec["values"][sid(&btn["id"])],
        "https://example.com/?q=a%20b"
    );
    assert!(
        rec["values"].get(sid(&bad["id"])).is_none(),
        "non-http(s)/mailto URLs are dropped"
    );
    let rec = f
        .set(&t, sid(&rec["id"]), json!({ &f.primary_id: "c" }))
        .await;
    assert_eq!(rec["values"][sid(&btn["id"])], "https://example.com/?q=c");
}

// ------------------------------------------------------------- schema changes

#[tokio::test]
async fn creating_a_formula_materializes_it_for_every_record_including_trashed_ones() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    let nid = sid(&n["id"]);
    let a = f.create(&t, json!({ nid: 1 })).await;
    let b = f.create(&t, json!({ nid: 2 })).await;
    f.delete_records(&t, &[sid(&b["id"])])
        .await
        .assert_status(200);
    let dbl = f.formula(&t, "Double", "{N} * 2").await;
    assert_eq!(f.stored(sid(&a["id"]), sid(&dbl["id"])), 2);
    assert_eq!(
        f.stored(sid(&b["id"]), sid(&dbl["id"])),
        4,
        "trashed records are brought up to date too"
    );
    f.restore_records(&t, &[sid(&b["id"])])
        .await
        .assert_status(200);
    assert_eq!(f.get(&t, sid(&b["id"])).await["values"][sid(&dbl["id"])], 4);
}

#[tokio::test]
async fn changing_a_formula_expression_recomputes_it_and_its_dependents() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    let nid = sid(&n["id"]);
    let base = f.formula(&t, "Base", "{N} + 1").await;
    let top = f.formula(&t, "Top", "{Base} * 10").await;
    let rec = f.create(&t, json!({ nid: 1 })).await;
    let rid = sid(&rec["id"]);
    assert_eq!(rec["values"][sid(&top["id"])], 20);
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&base["id"])),
            json!({ "type": "formula", "options": { "expression": "{N} + 100" } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(f.stored(rid, sid(&base["id"])), 101);
    assert_eq!(f.stored(rid, sid(&top["id"])), 1010);
    // renaming a field keeps formulas working (they reference ids)
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "name": "Renamed" }),
        )
        .await
        .assert_status(200);
    let shown = f.field(&t, "Base").await;
    assert_eq!(shown["options"]["expression"], "{Renamed} + 100");
    f.set(&t, rid, json!({ nid: 2 })).await;
    assert_eq!(f.stored(rid, sid(&top["id"])), 1020);
}

#[tokio::test]
async fn changing_a_source_fields_type_re_infers_and_recomputes_dependents() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    let nid = sid(&n["id"]);
    let echo = f.formula(&t, "Echo", "{N}").await;
    assert_eq!(echo["options"]["result_type"], "number");
    let rec = f.create(&t, json!({ nid: 7 })).await;
    let rid = sid(&rec["id"]);
    assert_eq!(f.stored(rid, sid(&echo["id"])), 7);
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{nid}"),
            json!({ "type": "single_line_text", "options": {} }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.stored(rid, nid), "7", "the value was converted");
    let echo_now = f.field(&t, "Echo").await;
    assert_eq!(echo_now["options"]["result_type"], "text");
    assert_eq!(
        f.stored(rid, sid(&echo["id"])),
        "7",
        "the dependent follows the new type"
    );
}

#[tokio::test]
async fn deleting_a_referenced_field_turns_formulas_into_errors_and_restore_heals_them() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    let nid = sid(&n["id"]).to_string();
    let calc = f.formula(&t, "Calc", "{N} * 2").await;
    let top = f.formula(&t, "Top", "{Calc} + 1").await;
    let rec = f.create(&t, json!({ &nid: 5 })).await;
    let rid = sid(&rec["id"]).to_string();
    assert_eq!(f.stored(&rid, sid(&top["id"])), 11);

    f.app
        .delete(&f.owner, &format!("/api/fields/{nid}"))
        .await
        .assert_status(200);
    let err = f.stored(&rid, sid(&calc["id"]));
    assert!(err["error"].as_str().unwrap().contains("ERROR"), "{err}");
    assert!(
        f.stored(&rid, sid(&top["id"]))["error"].is_string(),
        "errors propagate down the chain"
    );
    assert!(
        f.get(&t, &rid).await["values"].get(&nid).is_none(),
        "the deleted field's data is hidden"
    );

    // records written while the field is gone are evaluated with the error too
    let rec2 = f.create(&t, json!({})).await;
    assert!(rec2["values"][sid(&calc["id"])]["error"].is_string());

    // restore: the formulas recover without any record being touched
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({ "kind": "field", "id": nid }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.stored(&rid, sid(&calc["id"])), 10);
    assert_eq!(f.stored(&rid, sid(&top["id"])), 11);
    assert_eq!(
        f.get(&t, &rid).await["values"][&nid],
        5,
        "the data came back"
    );
    assert!(f.stored(sid(&rec2["id"]), sid(&calc["id"])).as_i64() == Some(0));
}

#[tokio::test]
async fn deleting_and_restoring_a_formula_field_recomputes_it() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let n = f.number(&t, "N").await;
    let nid = sid(&n["id"]);
    let calc = f.formula(&t, "Calc", "{N} * 2").await;
    let cid = sid(&calc["id"]).to_string();
    let rec = f.create(&t, json!({ nid: 5 })).await;
    let rid = sid(&rec["id"]).to_string();
    f.app
        .delete(&f.owner, &format!("/api/fields/{cid}"))
        .await
        .assert_status(200);
    assert!(f.get(&t, &rid).await["values"].get(&cid).is_none());
    // records change while the formula field is in the trash
    f.set(&t, &rid, json!({ nid: 50 })).await;
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({ "kind": "field", "id": cid }),
        )
        .await
        .assert_status(200);
    assert_eq!(
        f.get(&t, &rid).await["values"][&cid],
        100,
        "not the stale 10"
    );
}

#[tokio::test]
async fn deleting_the_link_removes_lookups_and_restoring_recomputes_them() {
    let l = linked().await;
    let f = &l.f;
    let pid = sid(&l.price["id"]);
    let rollup = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    let o = sid(&f.create(&l.t2, json!({ pid: 10 })).await["id"]).to_string();
    let c = sid(&f.create(&l.t1, json!({ sid(&l.link["id"]): [o] })).await["id"]).to_string();
    assert_eq!(f.get(&l.t1, &c).await["values"][sid(&rollup["id"])], 10);
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&l.link["id"])))
        .await
        .assert_status(200);
    assert!(
        f.get(&l.t1, &c).await["values"]
            .get(sid(&rollup["id"]))
            .is_none()
    );
    f.set(&l.t2, &o, json!({ pid: 25 })).await;
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({ "kind": "field", "id": l.link["id"] }),
        )
        .await
        .assert_status(200);
    let v = f.get(&l.t1, &c).await;
    assert_eq!(v["values"][sid(&rollup["id"])], 25);
    assert_eq!(link_ids_of(&v["values"][sid(&l.link["id"])]), s(&[&o]));
}

// --------------------------------------------------------------------- cycles

#[tokio::test]
async fn formula_cycles_are_rejected() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let a = f.formula(&t, "A", "1").await;
    let b = f.formula(&t, "B", "{A} + 1").await;
    // A -> B -> A
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&a["id"])),
            json!({ "type": "formula", "options": { "expression": "{B} + 1" } }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("circular")
    );
    // self reference
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&b["id"])),
            json!({ "type": "formula", "options": { "expression": "{B}" } }),
        )
        .await;
    r.assert_status(400);
    // and nothing changed
    assert_eq!(f.field(&t, "A").await["options"]["expression"], "1");
    let rec = f.create(&t, json!({})).await;
    assert_eq!(rec["values"][sid(&b["id"])], 2);
}

#[tokio::test]
async fn cycles_through_lookups_of_formulas_across_tables_are_rejected() {
    let l = linked().await;
    let f = &l.f;
    // Orders.Double = {Price} * 2; Table 1 looks it up; then Orders.Price tries to read the lookup
    let double = f.formula(&l.t2, "Double", "{Price} * 2").await;
    let lk = f.lookup(&l.t1, "Doubles", &l.link, &double).await;
    let back = f.lookup(&l.t2, "Back", &l.inverse, &lk).await;
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", sid(&double["id"])),
            json!({ "type": "formula", "options": { "expression": "SUM({Back})" } }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("circular")
    );
    let _ = back;
}

#[tokio::test]
async fn a_primary_formula_that_depends_on_a_formula_showing_its_own_name_is_a_cycle() {
    // Orders' primary = formula over a lookup of Customers.Label;
    // Customers.Label = ARRAYJOIN({Orders}) shows Orders' primary text.
    let l = linked().await;
    let f = &l.f;
    let label = f
        .formula(&l.t1, "Label", "ARRAYJOIN({Orders}, \",\")")
        .await;
    let lk = f.lookup(&l.t2, "Labels", &l.inverse, &label).await;
    let new_primary = f
        .formula(&l.t2, "Title", "ARRAYJOIN({Labels}, \",\")")
        .await;
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/primary-field", l.t2),
            json!({ "field_id": new_primary["id"] }),
        )
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("circular"),
        "{}",
        r.body
    );
    let _ = lk;
}

// ---------------------------------------------------------------- the cap

#[tokio::test]
async fn a_runaway_cascade_fails_cleanly_with_a_conflict() {
    use opengrid::engine::write::{self, WriteCtx, WriteSource};
    let l = linked().await;
    let f = &l.f;
    let pid = sid(&l.price["id"]).to_string();
    let total = f
        .rollup(&l.t1, "Total", &l.link, &l.price, "SUM(values)")
        .await;
    // one order linked from 30 customers
    let o = sid(&f.create(&l.t2, json!({ &pid: 1 })).await["id"]).to_string();
    let lid = sid(&l.link["id"]).to_string();
    for _ in 0..30 {
        f.create(&l.t1, json!({ &lid: [o] })).await;
    }
    let owner = f.owner.user_id.clone().unwrap();

    // a generous cap lets the edit through ...
    let ok = {
        let (t2, o, pid, owner) = (l.t2.clone(), o.clone(), pid.clone(), owner.clone());
        f.app.state.db.write_sync(move |tx| {
            let ctx = WriteCtx::new(Some(&owner), WriteSource::Api).with_max_recomputes(1000);
            write::update_records(
                tx,
                &ctx,
                &t2,
                vec![og_core::api::records::RecordPatch {
                    id: o,
                    values: [(pid, json!(2))].into_iter().collect(),
                }],
            )
        })
    };
    assert!(ok.is_ok());
    let customers = f.order(&l.t1);
    assert_eq!(f.stored(&customers[0], sid(&total["id"])), 2);

    // ... a tiny one stops it with a 409 and rolls everything back
    let err = {
        let (t2, o, pid, owner) = (l.t2.clone(), o.clone(), pid.clone(), owner.clone());
        f.app
            .state
            .db
            .write_sync(move |tx| {
                let ctx = WriteCtx::new(Some(&owner), WriteSource::Api).with_max_recomputes(5);
                write::update_records(
                    tx,
                    &ctx,
                    &t2,
                    vec![og_core::api::records::RecordPatch {
                        id: o,
                        values: [(pid, json!(3))].into_iter().collect(),
                    }],
                )
            })
            .unwrap_err()
    };
    assert!(
        matches!(err, opengrid::error::AppError::Conflict(_)),
        "{err:?}"
    );
    assert!(err.to_string().contains("recalculate"));
    assert_eq!(
        f.record_data(&o)[&pid],
        2,
        "the edit itself was rolled back"
    );
    assert_eq!(f.stored(&customers[0], sid(&total["id"])), 2);
}

#[tokio::test]
async fn the_default_cap_is_generous_for_normal_use() {
    const { assert!(opengrid::engine::recompute::DEFAULT_MAX_EVALS >= 100_000) };
}

#[allow(dead_code)]
fn unused(_: Value) {}
