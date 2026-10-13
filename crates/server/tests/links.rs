//! Link integrity: both sides of a link stay in sync in the same
//! transaction; trashed records disappear from reads but keep their place.

mod common;
mod records_support;
mod schema_support;

use records_support::*;
use serde_json::{Value, json};

/// Customers (Table 1) with link `Orders`; orders with an inverse `Table 1`.
struct World {
    l: Linked,
    lid: String,
    iid: String,
}

async fn world() -> World {
    let l = linked().await;
    let lid = sid(&l.link["id"]).to_string();
    let iid = sid(&l.inverse["id"]).to_string();
    World { l, lid, iid }
}

impl World {
    fn f(&self) -> &Fixture {
        &self.l.f
    }
    async fn customer(&self, name: &str, orders: &[&str]) -> String {
        let r = self
            .f()
            .create(
                &self.l.t1,
                json!({ &self.f().primary_id: name, &self.lid: orders }),
            )
            .await;
        sid(&r["id"]).to_string()
    }
    async fn order(&self, name: &str) -> String {
        let t2_primary = self.t2_primary().await;
        let r = self
            .f()
            .create(&self.l.t2, json!({ t2_primary: name }))
            .await;
        sid(&r["id"]).to_string()
    }
    async fn t2_primary(&self) -> String {
        sid(&self.f().table(&self.l.t2).await["primary_field_id"]).to_string()
    }
    fn customers_orders(&self, customer: &str) -> Vec<String> {
        stored_ids(self.f(), customer, &self.lid)
    }
    fn orders_customers(&self, order: &str) -> Vec<String> {
        stored_ids(self.f(), order, &self.iid)
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[tokio::test]
async fn adding_a_link_adds_this_record_to_the_inverse_side() {
    let w = world().await;
    let (o1, o2) = (w.order("Order 1").await, w.order("Order 2").await);
    let c = w.customer("Alice", &[&o1, &o2]).await;
    assert_eq!(w.customers_orders(&c), s(&[&o1, &o2]));
    assert_eq!(w.orders_customers(&o1), s(&[&c]));
    assert_eq!(w.orders_customers(&o2), s(&[&c]));

    // the API shows [{id, name}] with the linked record's primary text
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_ids_of(&rec["values"][&w.lid]), s(&[&o1, &o2]));
    assert_eq!(
        link_names(&rec["values"][&w.lid]),
        s(&["Order 1", "Order 2"])
    );
    let order = w.f().get(&w.l.t2, &o1).await;
    assert_eq!(link_ids_of(&order["values"][&w.iid]), s(&[&c]));
    assert_eq!(link_names(&order["values"][&w.iid]), s(&["Alice"]));
}

#[tokio::test]
async fn linking_from_the_inverse_side_works_the_same() {
    let w = world().await;
    let c1 = w.customer("A", &[]).await;
    let c2 = w.customer("B", &[]).await;
    let o = w.order("O").await;
    w.f().set(&w.l.t2, &o, json!({ &w.iid: [c1, c2] })).await;
    assert_eq!(w.orders_customers(&o), s(&[&c1, &c2]));
    assert_eq!(w.customers_orders(&c1), s(&[&o]));
    assert_eq!(w.customers_orders(&c2), s(&[&o]));
}

#[tokio::test]
async fn new_records_can_be_created_already_linked() {
    let w = world().await;
    let c = w.customer("A", &[]).await;
    let t2p = w.t2_primary().await;
    let r = w
        .f()
        .app
        .post(
            &w.f().owner,
            &records_url(&w.l.t2),
            json!({ "records": [
                { "values": { &t2p: "o1", &w.iid: [c] } },
                { "values": { &t2p: "o2", &w.iid: [c] } },
                { "values": { &t2p: "o3" } } ] }),
        )
        .await;
    r.assert_status(201);
    let ids: Vec<String> = r.body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| sid(&x["id"]).to_string())
        .collect();
    assert_eq!(
        w.customers_orders(&c),
        s(&[&ids[0], &ids[1]]),
        "appended in creation order"
    );
}

#[tokio::test]
async fn removing_and_replacing_links_updates_both_sides() {
    let w = world().await;
    let (o1, o2, o3) = (w.order("1").await, w.order("2").await, w.order("3").await);
    let c = w.customer("A", &[&o1, &o2]).await;

    // replace [o1, o2] by [o2, o3]
    w.f().set(&w.l.t1, &c, json!({ &w.lid: [o2, o3] })).await;
    assert_eq!(w.customers_orders(&c), s(&[&o2, &o3]));
    assert!(
        w.orders_customers(&o1).is_empty(),
        "removed from the old partner"
    );
    assert_eq!(w.orders_customers(&o2), s(&[&c]));
    assert_eq!(w.orders_customers(&o3), s(&[&c]));
    assert!(
        w.f().record_data(&o1).get(&w.iid).is_none(),
        "an emptied inverse cell is removed, not stored as []"
    );

    // clear
    w.f().set(&w.l.t1, &c, json!({ &w.lid: null })).await;
    assert!(w.customers_orders(&c).is_empty());
    for o in [&o1, &o2, &o3] {
        assert!(w.orders_customers(o).is_empty());
    }
}

#[tokio::test]
async fn the_other_side_is_edited_history_updated_at_and_events_included() {
    let w = world().await;
    let o = w.order("O").await;
    let c = w.customer("A", &[]).await;
    let before = w.f().columns(&o);
    let mut rx = w.f().app.state.events.subscribe(&w.f().base_id);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    w.f().set(&w.l.t1, &c, json!({ &w.lid: [o] })).await;

    let after = w.f().columns(&o);
    assert!(after.2 > before.2, "the linked record counts as edited");
    assert_eq!(after.3, w.f().columns(&c).3);
    let h = w.f().history(&o);
    assert_eq!(h.last().unwrap().0, "update");
    assert_eq!(
        h.last().unwrap().1,
        json!({ &w.iid: { "old": null, "new": [c.clone()] } })
    );
    let hc = w.f().history(&c);
    assert_eq!(
        hc.last().unwrap().1,
        json!({ &w.lid: { "old": null, "new": [o.clone()] } })
    );

    // one RecordsChanged per table
    let mut seen = std::collections::BTreeMap::new();
    while let Ok(ev) = rx.try_recv() {
        if let ob_core::api::events::BaseEvent::RecordsChanged {
            table_id, updated, ..
        } = ev.event.clone()
        {
            seen.insert(table_id, updated);
        }
    }
    assert_eq!(seen[&w.l.t1], vec![c.clone()]);
    assert_eq!(seen[&w.l.t2], vec![o.clone()]);

    // re-sending the same links changes nothing on either side
    let (cb, ob) = (w.f().columns(&c), w.f().columns(&o));
    w.f().set(&w.l.t1, &c, json!({ &w.lid: [o] })).await;
    assert_eq!((w.f().columns(&c), w.f().columns(&o)), (cb, ob));
}

#[tokio::test]
async fn link_order_is_kept_and_new_ids_are_appended() {
    let w = world().await;
    let (o1, o2, o3) = (w.order("1").await, w.order("2").await, w.order("3").await);
    let c = w.customer("A", &[&o2]).await;
    // another customer links o1 and o3 from the inverse side: ids are appended
    w.f().set(&w.l.t2, &o1, json!({ &w.iid: [c] })).await;
    w.f().set(&w.l.t2, &o3, json!({ &w.iid: [c] })).await;
    assert_eq!(w.customers_orders(&c), s(&[&o2, &o1, &o3]));
    // reordering through the link cell is respected
    w.f()
        .set(&w.l.t1, &c, json!({ &w.lid: [o3, o1, o2] }))
        .await;
    assert_eq!(w.customers_orders(&c), s(&[&o3, &o1, &o2]));
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_ids_of(&rec["values"][&w.lid]), s(&[&o3, &o1, &o2]));
}

#[tokio::test]
async fn duplicates_and_object_ids_are_accepted() {
    let w = world().await;
    let o = w.order("O").await;
    let c = w.customer("A", &[&o, &o]).await;
    assert_eq!(w.customers_orders(&c), s(&[&o]));
    let c2 = w
        .f()
        .create(&w.l.t1, json!({ &w.lid: [{ "id": o }] }))
        .await;
    assert_eq!(link_ids_of(&c2["values"][&w.lid]), s(&[&o]));
    assert_eq!(w.orders_customers(&o).len(), 2);
}

#[tokio::test]
async fn invalid_link_targets_are_rejected_and_nothing_is_written() {
    let w = world().await;
    let o = w.order("O").await;
    let c = w.customer("A", &[]).await;
    let other_customer = w.customer("B", &[]).await;

    for (bad, why) in [
        (json!(["recNOPE"]), "unknown record"),
        (json!([other_customer.clone()]), "record of the wrong table"),
        (json!([o.clone(), "recNOPE"]), "one bad id among good ones"),
        (json!("not-a-record-id"), "malformed id"),
        (json!(5), "wrong json type"),
    ] {
        let r = w
            .f()
            .patch_as(&w.f().owner, &w.l.t1, &c, json!({ &w.lid: bad }))
            .await;
        r.assert_status(400);
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Orders"),
            "{why}: {}",
            r.body
        );
        assert!(w.customers_orders(&c).is_empty(), "{why}");
        assert!(w.orders_customers(&o).is_empty(), "{why}");
    }
    // trashed targets are rejected as well
    w.f()
        .delete_records(&w.l.t2, &[&o])
        .await
        .assert_status(204);
    let r = w
        .f()
        .patch_as(&w.f().owner, &w.l.t1, &c, json!({ &w.lid: [o] }))
        .await;
    r.assert_status(400);
    let r = w
        .f()
        .create_as(&w.f().owner, &w.l.t1, json!({ &w.lid: [o] }))
        .await;
    r.assert_status(400);
    // too many links
    let many: Vec<String> = (0..10_001).map(|i| format!("rec{i:014}")).collect();
    w.f()
        .patch_as(&w.f().owner, &w.l.t1, &c, json!({ &w.lid: many }))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn single_link_fields_hold_at_most_one_record() {
    let f = Fixture::new().await;
    let t1 = f.table_id.clone();
    let t2 = id_of(&f.add_table("Projects").await);
    let link = f
        .add_field(
            &t1,
            json!({ "name": "Project", "type": "link",
                    "options": { "linked_table_id": t2, "single": true } }),
        )
        .await;
    let (lid, iid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );
    let p1 = sid(&f.create(&t2, json!({})).await["id"]).to_string();
    let p2 = sid(&f.create(&t2, json!({})).await["id"]).to_string();
    let a = sid(&f.create(&t1, json!({ &lid: [p1] })).await["id"]).to_string();
    let r = f.create_as(&f.owner, &t1, json!({ &lid: [p1, p2] })).await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("single")
    );
    f.patch_as(&f.owner, &t1, &a, json!({ &lid: [p1, p2] }))
        .await
        .assert_status(400);
    // the single side moves from one project to the other
    f.set(&t1, &a, json!({ &lid: [p2] })).await;
    assert_eq!(stored_ids(&f, &a, &lid), s(&[&p2]));
    assert!(stored_ids(&f, &p1, &iid).is_empty());
    assert_eq!(stored_ids(&f, &p2, &iid), s(&[&a]));
    // the inverse side is a normal multi link: a project holds many records
    let b = sid(&f.create(&t1, json!({})).await["id"]).to_string();
    f.set(&t2, &p2, json!({ &iid: [a, b] })).await;
    assert_eq!(stored_ids(&f, &b, &lid), s(&[&p2]));
}

#[tokio::test]
async fn self_links_are_paired_like_any_other() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let link = f.add_link(&t, "Parent", &t).await;
    let (pid, cid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );
    let a = sid(&f.create(&t, json!({ &f.primary_id: "a" })).await["id"]).to_string();
    let b = sid(&f.create(&t, json!({ &f.primary_id: "b", &pid: [a] })).await["id"]).to_string();
    assert_eq!(stored_ids(&f, &b, &pid), s(&[&a]));
    assert_eq!(stored_ids(&f, &a, &cid), s(&[&b]));
    // a record linked to itself
    f.set(&t, &a, json!({ &pid: [a, b] })).await;
    assert_eq!(stored_ids(&f, &a, &pid), s(&[&a, &b]));
    assert_eq!(
        stored_ids(&f, &a, &cid),
        s(&[&b, &a]),
        "both partners of the self link updated"
    );
    assert_eq!(stored_ids(&f, &b, &cid), s(&[&a]));
    // and unlinked again
    f.set(&t, &a, json!({ &pid: [] })).await;
    assert!(stored_ids(&f, &a, &pid).is_empty());
    assert_eq!(stored_ids(&f, &a, &cid), s(&[&b]));
    assert!(stored_ids(&f, &b, &cid).is_empty());
    let rec = f.get(&t, &b).await;
    assert_eq!(link_names(&rec["values"][&pid]), s(&["a"]));
}

#[tokio::test]
async fn trashed_records_vanish_from_reads_but_keep_their_links() {
    let w = world().await;
    let (o1, o2) = (w.order("Order 1").await, w.order("Order 2").await);
    let c = w.customer("A", &[&o1, &o2]).await;
    w.f()
        .delete_records(&w.l.t2, &[&o1])
        .await
        .assert_status(204);

    // stored arrays are untouched on both sides ...
    assert_eq!(w.customers_orders(&c), s(&[&o1, &o2]));
    assert_eq!(w.orders_customers(&o1), s(&[&c]));
    // ... but reads hide the trashed record
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_ids_of(&rec["values"][&w.lid]), s(&[&o2]));
    // a customer whose only order is trashed shows no link value at all
    let o3 = w.order("Order 3").await;
    let c2 = w.customer("B", &[&o3]).await;
    w.f()
        .delete_records(&w.l.t2, &[&o3])
        .await
        .assert_status(204);
    let rec = w.f().get(&w.l.t1, &c2).await;
    assert!(rec["values"].get(&w.lid).is_none());
    // restore: everything is back, in the original order
    w.f()
        .restore_records(&w.l.t2, &[&o1])
        .await
        .assert_status(200);
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_ids_of(&rec["values"][&w.lid]), s(&[&o1, &o2]));
}

#[tokio::test]
async fn editing_a_link_cell_keeps_the_hidden_trashed_links() {
    let w = world().await;
    let (o1, o2, o3) = (w.order("1").await, w.order("2").await, w.order("3").await);
    let c = w.customer("A", &[&o1, &o2]).await;
    w.f()
        .delete_records(&w.l.t2, &[&o2])
        .await
        .assert_status(204);

    // the client sees [o1] and sets [o1, o3]; the hidden o2 stays linked
    let r = w.f().set(&w.l.t1, &c, json!({ &w.lid: [o1, o3] })).await;
    assert_eq!(link_ids_of(&r["values"][&w.lid]), s(&[&o1, &o3]));
    assert_eq!(w.customers_orders(&c), s(&[&o1, &o3, &o2]));
    assert_eq!(
        w.orders_customers(&o2),
        s(&[&c]),
        "the trashed partner keeps its link"
    );
    w.f()
        .restore_records(&w.l.t2, &[&o2])
        .await
        .assert_status(200);
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_ids_of(&rec["values"][&w.lid]), s(&[&o1, &o3, &o2]));

    // clearing the cell keeps hidden links too
    w.f()
        .delete_records(&w.l.t2, &[&o2])
        .await
        .assert_status(204);
    let r = w.f().set(&w.l.t1, &c, json!({ &w.lid: [] })).await;
    assert!(r["values"].get(&w.lid).is_none());
    assert_eq!(w.customers_orders(&c), s(&[&o2]));
    assert!(w.orders_customers(&o1).is_empty());
    assert_eq!(w.orders_customers(&o2), s(&[&c]));
}

#[tokio::test]
async fn replacing_a_single_link_drops_a_hidden_trashed_one() {
    let f = Fixture::new().await;
    let t1 = f.table_id.clone();
    let t2 = id_of(&f.add_table("Projects").await);
    let link = f
        .add_field(
            &t1,
            json!({ "name": "Project", "type": "link",
                    "options": { "linked_table_id": t2, "single": true } }),
        )
        .await;
    let (lid, iid) = (
        sid(&link["id"]).to_string(),
        sid(&link["inverse"]["id"]).to_string(),
    );
    let p1 = sid(&f.create(&t2, json!({})).await["id"]).to_string();
    let p2 = sid(&f.create(&t2, json!({})).await["id"]).to_string();
    let a = sid(&f.create(&t1, json!({ &lid: [p1] })).await["id"]).to_string();
    f.delete_records(&t2, &[&p1]).await.assert_status(204);
    f.set(&t1, &a, json!({ &lid: [p2] })).await;
    // a single link never holds two records, hidden or not
    assert_eq!(stored_ids(&f, &a, &lid), s(&[&p2]));
    assert!(stored_ids(&f, &p1, &iid).is_empty());
}

#[tokio::test]
async fn link_names_follow_the_linked_primary_value() {
    let w = world().await;
    let t2p = w.t2_primary().await;
    let o = w.order("Before").await;
    let c = w.customer("A", &[&o]).await;
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_names(&rec["values"][&w.lid]), s(&["Before"]));
    w.f().set(&w.l.t2, &o, json!({ &t2p: "After" })).await;
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_names(&rec["values"][&w.lid]), s(&["After"]));
    // a blank primary shows an empty name
    w.f().set(&w.l.t2, &o, json!({ &t2p: null })).await;
    let rec = w.f().get(&w.l.t1, &c).await;
    assert_eq!(link_ids_of(&rec["values"][&w.lid]), s(&[&o]));
    assert_eq!(link_names(&rec["values"][&w.lid]), s(&[""]));
}

#[tokio::test]
async fn deleting_and_restoring_the_linking_record_hides_and_shows_it_for_its_partners() {
    let w = world().await;
    let o = w.order("O").await;
    let c = w.customer("A", &[&o]).await;
    w.f()
        .delete_records(&w.l.t1, &[&c])
        .await
        .assert_status(204);
    let order = w.f().get(&w.l.t2, &o).await;
    assert!(
        order["values"].get(&w.iid).is_none(),
        "the trashed customer is hidden"
    );
    assert_eq!(w.orders_customers(&o), s(&[&c]), "but the link is kept");
    w.f()
        .restore_records(&w.l.t1, &[&c])
        .await
        .assert_status(200);
    let order = w.f().get(&w.l.t2, &o).await;
    assert_eq!(link_ids_of(&order["values"][&w.iid]), s(&[&c]));
}

#[tokio::test]
async fn a_batch_linking_many_records_to_one_target_stays_consistent() {
    let w = world().await;
    let c = w.customer("A", &[]).await;
    let t2p = w.t2_primary().await;
    let records: Vec<Value> = (0..200)
        .map(|i| json!({ "values": { &t2p: format!("o{i}"), &w.iid: [c] } }))
        .collect();
    let r = w
        .f()
        .app
        .post(
            &w.f().owner,
            &records_url(&w.l.t2),
            json!({ "records": records }),
        )
        .await;
    r.assert_status(201);
    let ids: Vec<String> = r.body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| sid(&x["id"]).to_string())
        .collect();
    assert_eq!(w.customers_orders(&c), ids);
    // delete them all in one request: the customer sees none
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    w.f()
        .delete_records(&w.l.t2, &refs)
        .await
        .assert_status(204);
    let rec = w.f().get(&w.l.t1, &c).await;
    assert!(rec["values"].get(&w.lid).is_none());
}

#[tokio::test]
async fn a_stale_client_may_resend_a_link_that_was_trashed_since() {
    let w = world().await;
    let (o1, o2) = (w.order("1").await, w.order("2").await);
    let c = w.customer("A", &[&o1, &o2]).await;
    w.f()
        .delete_records(&w.l.t2, &[&o2])
        .await
        .assert_status(204);
    // the client still believes the customer links [o1, o2] and sends both back
    let r = w.f().set(&w.l.t1, &c, json!({ &w.lid: [o1, o2] })).await;
    assert_eq!(link_ids_of(&r["values"][&w.lid]), s(&[&o1]));
    assert_eq!(w.customers_orders(&c), s(&[&o1, &o2]), "unchanged");
    // but a trashed record cannot be newly linked
    let o3 = w.order("3").await;
    w.f()
        .delete_records(&w.l.t2, &[&o3])
        .await
        .assert_status(204);
    w.f()
        .patch_as(&w.f().owner, &w.l.t1, &c, json!({ &w.lid: [o1, o3] }))
        .await
        .assert_status(400);
}
