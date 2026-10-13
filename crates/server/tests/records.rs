//! The record write endpoints: create, update, delete, restore, move, get.
//! Normalization per field type, computed-field rejection, typecast, limits,
//! history, positions, autonumbers, events and the role matrix.

mod common;
mod records_support;
mod schema_support;

use opengrid::perm::Role;
use records_support::*;
use serde_json::{Value, json};

// ------------------------------------------------------------------ basics

#[tokio::test]
async fn create_returns_the_record_and_get_reads_it_back() {
    let f = Fixture::new().await;
    let rec = f
        .create(&f.table_id, json!({ &f.primary_id: "Alice", &f.notes_id: "line1\nline2" }))
        .await;
    assert!(sid(&rec["id"]).starts_with("rec"));
    assert_eq!(rec["table_id"], f.table_id);
    assert_eq!(rec["autonumber"], 1);
    assert_eq!(rec["created_by"], f.owner.user_id.clone().unwrap());
    assert_eq!(rec["updated_by"], rec["created_by"]);
    assert!(rec["created_at"].as_i64().unwrap() > 0);
    assert_eq!(rec["values"][&f.primary_id], "Alice");
    assert_eq!(rec["values"][&f.notes_id], "line1\nline2");

    let got = f.get(&f.table_id, sid(&rec["id"])).await;
    assert_eq!(got, rec);
}

#[tokio::test]
async fn batch_create_keeps_input_order_and_assigns_increasing_autonumbers() {
    let f = Fixture::new().await;
    let r = f
        .app
        .post(
            &f.owner,
            &records_url(&f.table_id),
            json!({ "records": [
                { "values": { &f.primary_id: "a" } },
                { "values": { &f.primary_id: "b" } },
                { "values": {} },
            ] }),
        )
        .await;
    r.assert_status(201);
    let recs = r.body["records"].as_array().unwrap();
    assert_eq!(recs.len(), 3);
    assert_eq!(recs[0]["values"][&f.primary_id], "a");
    assert_eq!(recs[1]["values"][&f.primary_id], "b");
    assert_eq!(recs[2]["values"], json!({}));
    let autos: Vec<i64> = recs.iter().map(|r| r["autonumber"].as_i64().unwrap()).collect();
    assert_eq!(autos, [1, 2, 3]);
    let ids: Vec<String> = recs.iter().map(|r| sid(&r["id"]).to_string()).collect();
    assert_eq!(f.order(&f.table_id), ids, "appended in input order");
}

#[tokio::test]
async fn autonumbers_are_never_reused_after_deletes() {
    let f = Fixture::new().await;
    let a = f.create(&f.table_id, json!({})).await;
    let b = f.create(&f.table_id, json!({})).await;
    f.delete_records(&f.table_id, &[sid(&b["id"])]).await.assert_status(200);
    let c = f.create(&f.table_id, json!({})).await;
    assert_eq!((a["autonumber"].as_i64(), c["autonumber"].as_i64()), (Some(1), Some(3)));
    // the counter survives restores too
    f.restore_records(&f.table_id, &[sid(&b["id"])]).await.assert_status(200);
    let d = f.create(&f.table_id, json!({})).await;
    assert_eq!(d["autonumber"], 4);
    assert_eq!(f.get(&f.table_id, sid(&b["id"])).await["autonumber"], 2);
}

#[tokio::test]
async fn empty_values_are_never_stored() {
    let f = Fixture::new().await;
    let rec = f
        .create(&f.table_id, json!({ &f.primary_id: "", &f.notes_id: null }))
        .await;
    assert_eq!(rec["values"], json!({}));
    assert_eq!(f.record_data(sid(&rec["id"])), json!({}));
    let r = f.set(&f.table_id, sid(&rec["id"]), json!({ &f.primary_id: "x" })).await;
    assert_eq!(r["values"][&f.primary_id], "x");
    // null and "" both clear
    let r = f.set(&f.table_id, sid(&rec["id"]), json!({ &f.primary_id: null })).await;
    assert_eq!(r["values"], json!({}));
    f.set(&f.table_id, sid(&rec["id"]), json!({ &f.primary_id: "y" })).await;
    let r = f.set(&f.table_id, sid(&rec["id"]), json!({ &f.primary_id: "" })).await;
    assert_eq!(r["values"], json!({}));
    assert_eq!(f.record_data(sid(&rec["id"])), json!({}));
}

#[tokio::test]
async fn patch_changes_only_the_listed_fields() {
    let f = Fixture::new().await;
    let rec = f
        .create(&f.table_id, json!({ &f.primary_id: "keep", &f.notes_id: "old" }))
        .await;
    let r = f.set(&f.table_id, sid(&rec["id"]), json!({ &f.notes_id: "new" })).await;
    assert_eq!(r["values"][&f.primary_id], "keep");
    assert_eq!(r["values"][&f.notes_id], "new");
}

#[tokio::test]
async fn field_defaults_apply_to_new_records_only_for_absent_fields() {
    let f = Fixture::new().await;
    let t = f
        .add_field(
            &f.table_id,
            json!({ "name": "Greeting", "type": "single_line_text", "options": { "default": "hello" } }),
        )
        .await;
    let n = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": { "default": 7 } }),
        )
        .await;
    let (tid, nid) = (sid(&t["id"]), sid(&n["id"]));
    let rec = f.create(&f.table_id, json!({})).await;
    assert_eq!(rec["values"][tid], "hello");
    assert_eq!(rec["values"][nid], 7);
    // an explicit value or an explicit null wins over the default
    let rec = f.create(&f.table_id, json!({ tid: "bye", nid: null })).await;
    assert_eq!(rec["values"][tid], "bye");
    assert!(rec["values"].get(nid).is_none());
    // updates never re-apply defaults
    let r = f.set(&f.table_id, sid(&rec["id"]), json!({ tid: null })).await;
    assert!(r["values"].get(tid).is_none());
}

// ---------------------------------------------------- field type coverage

struct Sink {
    f: Fixture,
    table: String,
    ids: std::collections::HashMap<&'static str, String>,
    todo: String,
    done: String,
    tag_a: String,
}

async fn sink() -> Sink {
    let f = Fixture::new().await;
    let table = id_of(&f.add_table("Sink").await);
    let mut ids = std::collections::HashMap::new();
    let specs: Vec<(&'static str, Value)> = vec![
        ("long", json!({ "type": "long_text", "options": {} })),
        ("number", json!({ "type": "number", "options": { "precision": 2, "allow_negative": false } })),
        ("currency", json!({ "type": "currency", "options": {} })),
        ("percent", json!({ "type": "percent", "options": {} })),
        ("duration", json!({ "type": "duration", "options": {} })),
        ("rating", json!({ "type": "rating", "options": { "max": 5 } })),
        ("checkbox", json!({ "type": "checkbox", "options": {} })),
        ("single", json!({ "type": "single_select", "options": { "choices": [ { "name": "Todo" }, { "name": "Done" } ] } })),
        ("multi", json!({ "type": "multiple_select", "options": { "choices": [ { "name": "a" }, { "name": "b" } ] } })),
        ("date", json!({ "type": "date", "options": {} })),
        ("datetime", json!({ "type": "date", "options": { "include_time": true, "timezone": "UTC" } })),
        ("email", json!({ "type": "email", "options": {} })),
        ("url", json!({ "type": "url", "options": {} })),
        ("phone", json!({ "type": "phone", "options": {} })),
        ("barcode", json!({ "type": "barcode", "options": {} })),
    ];
    let mut todo = String::new();
    let mut done = String::new();
    let mut tag_a = String::new();
    for (key, mut spec) in specs {
        spec["name"] = json!(key);
        let created = f.add_field(&table, spec).await;
        match key {
            "single" => {
                todo = sid(&created["options"]["choices"][0]["id"]).to_string();
                done = sid(&created["options"]["choices"][1]["id"]).to_string();
            }
            "multi" => tag_a = sid(&created["options"]["choices"][0]["id"]).to_string(),
            _ => {}
        }
        ids.insert(key, sid(&created["id"]).to_string());
    }
    Sink {
        f,
        table,
        ids,
        todo,
        done,
        tag_a,
    }
}

impl Sink {
    fn id(&self, k: &str) -> &str {
        &self.ids[k]
    }
    async fn create(&self, values: Value) -> Response {
        self.f.create_as(&self.f.owner, &self.table, values).await
    }
    async fn typecast(&self, values: Value) -> Response {
        self.f.create_typecast(&self.table, values).await
    }
}

use common::Response;

#[tokio::test]
async fn every_editable_type_is_normalized_through_the_api() {
    let s = sink().await;
    let r = s
        .create(json!({
            s.id("long"): "a\r\nb",
            s.id("number"): 12.345,
            s.id("currency"): 9.5,
            s.id("rating"): 4,
            s.id("checkbox"): true,
            s.id("single"): "Done",
            s.id("multi"): ["a", "b"],
            s.id("date"): "2026-03-04",
            s.id("datetime"): "2026-03-04T10:30:00Z",
            s.id("email"): "Ann@Example.com",
            s.id("url"): "https://example.com/x",
            s.id("phone"): "+1 555 0100",
            s.id("barcode"): "12345",
        }))
        .await;
    r.assert_status(201);
    let v = &r.body["records"][0]["values"];
    assert_eq!(v[s.id("long")], "a\nb", "line endings are normalized");
    assert_eq!(v[s.id("number")], 12.35, "rounded to the field's precision");
    assert_eq!(v[s.id("currency")], 9.5);
    assert_eq!(v[s.id("rating")], 4);
    assert_eq!(v[s.id("checkbox")], true);
    assert_eq!(v[s.id("single")], s.done, "select names become choice ids");
    assert_eq!(v[s.id("multi")].as_array().unwrap().len(), 2);
    assert_eq!(v[s.id("date")], "2026-03-04");
    assert!(sid(&v[s.id("datetime")]).starts_with("2026-03-04T10:30:00"));
    assert_eq!(v[s.id("email")], "Ann@Example.com");
    assert_eq!(v[s.id("url")], "https://example.com/x");
    assert_eq!(v[s.id("phone")], "+1 555 0100");
    assert_eq!(v[s.id("barcode")], "12345");
}

#[tokio::test]
async fn invalid_values_are_rejected_naming_the_field() {
    let s = sink().await;
    let bad: Vec<(&str, Value)> = vec![
        ("number", json!("twelve")),
        ("number", json!(-1)),
        ("rating", json!(9)),
        ("checkbox", json!("maybe")),
        ("single", json!("Nope")),
        ("multi", json!(["a", "zzz"])),
        ("date", json!("not a date")),
        ("email", json!("not-an-email")),
        ("url", json!("javascript:alert(1)")),
        ("long", json!({ "a": 1 })),
    ];
    for (key, value) in bad {
        let r = s.create(json!({ s.id(key): value })).await;
        r.assert_status(400);
        let msg = r.body["error"]["message"].as_str().unwrap();
        assert!(msg.contains(key), "{key}: {msg}");
    }
    // nothing was created by the failed requests
    assert_eq!(s.f.order(&s.table).len(), 0);
}

#[tokio::test]
async fn strict_mode_wants_natural_json_types_and_typecast_reads_text() {
    let s = sink().await;
    let strict = s
        .create(json!({ s.id("currency"): "$1,200.50" }))
        .await;
    strict.assert_status(400);
    let r = s
        .typecast(json!({
            s.id("currency"): "$1,200.50",
            s.id("percent"): "25%",
            s.id("checkbox"): "yes",
            s.id("multi"): "a, b",
            s.id("number"): "7",
        }))
        .await;
    r.assert_status(201);
    let v = &r.body["records"][0]["values"];
    assert_eq!(v[s.id("currency")], 1200.5);
    assert_eq!(v[s.id("percent")], 0.25, "percent is stored as a fraction");
    assert_eq!(v[s.id("checkbox")], true);
    assert_eq!(v[s.id("multi")].as_array().unwrap().len(), 2);
    assert_eq!(v[s.id("number")], 7);
}

#[tokio::test]
async fn typecast_creates_missing_select_choices_and_announces_the_schema_change() {
    let s = sink().await;
    let mut rx = s.f.app.state.events.subscribe(&s.f.base_id);
    // strict mode refuses unknown choices
    s.create(json!({ s.id("single"): "Blocked" })).await.assert_status(400);
    assert!(rx.try_recv().is_err(), "a failed write publishes nothing");

    let r = s
        .typecast(json!({ s.id("single"): "Blocked", s.id("multi"): ["a", "New one", "new ONE"] }))
        .await;
    r.assert_status(201);
    let table = s.f.table(&s.table).await;
    let single = table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == s.id("single"))
        .unwrap()
        .clone();
    let choices = single["options"]["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 3);
    assert_eq!(choices[2]["name"], "Blocked");
    assert!(!choices[2]["color"].as_str().unwrap().is_empty());
    let multi = table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == s.id("multi"))
        .unwrap()
        .clone();
    assert_eq!(
        multi["options"]["choices"].as_array().unwrap().len(),
        3,
        "case-insensitive duplicates create one choice"
    );
    // stored as ids of the new choices
    let rid = sid(&r.body["records"][0]["id"]);
    assert_eq!(s.f.stored(rid, s.id("single")), choices[2]["id"]);

    // events: schema change first, then the record change
    let first = rx.try_recv().unwrap();
    assert!(matches!(
        first.event,
        og_core::api::events::BaseEvent::SchemaChanged { ref table_id } if table_id.as_deref() == Some(s.table.as_str())
    ));
    let second = rx.try_recv().unwrap();
    assert!(matches!(
        second.event,
        og_core::api::events::BaseEvent::RecordsChanged { ref created, .. } if created == &[rid.to_string()]
    ));
    // names that exist already (any case) do not create choices
    s.typecast(json!({ s.id("single"): "todo" })).await.assert_status(201);
    let table = s.f.table(&s.table).await;
    let n = table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == s.id("single"))
        .unwrap()["options"]["choices"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(n, 3);
}

#[tokio::test]
async fn select_values_may_be_sent_as_choice_ids_and_cleared() {
    let s = sink().await;
    let r = s.create(json!({ s.id("single"): s.todo, s.id("multi"): [s.tag_a] })).await;
    r.assert_status(201);
    let rid = sid(&r.body["records"][0]["id"]).to_string();
    assert_eq!(r.body["records"][0]["values"][s.id("single")], s.todo);
    let upd = s.f.set(&s.table, &rid, json!({ s.id("single"): null, s.id("multi"): [] })).await;
    assert_eq!(upd["values"], json!({}));
}

// -------------------------------------------------- computed field rejection

#[tokio::test]
async fn computed_and_unknown_fields_are_rejected_by_name() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let formula = f.formula(&t, "Calc", "1 + 1").await;
    let auto = f
        .add_field(&t, json!({ "name": "Auto", "type": "autonumber", "options": {} }))
        .await;
    let created = f
        .add_field(&t, json!({ "name": "Made", "type": "created_time", "options": {} }))
        .await;
    let by = f
        .add_field(&t, json!({ "name": "By", "type": "created_by", "options": {} }))
        .await;
    let modified = f
        .add_field(&t, json!({ "name": "Touched", "type": "last_modified_time", "options": {} }))
        .await;
    let button = f
        .add_field(
            &t,
            json!({ "name": "Go", "type": "button", "options": { "label": "Go", "url_formula": "\"https://example.com\"" } }),
        )
        .await;
    let rec = f.create(&t, json!({ &f.primary_id: "x" })).await;
    let rid = sid(&rec["id"]);
    for field in [&formula, &auto, &created, &by, &modified, &button] {
        let r = f.create_as(&f.owner, &t, json!({ sid(&field["id"]): 1 })).await;
        r.assert_status(400);
        let msg = r.body["error"]["message"].as_str().unwrap();
        assert!(msg.contains(sid(&field["name"])) && msg.contains("computed"), "{msg}");
        f.patch_as(&f.owner, &t, rid, json!({ sid(&field["id"]): 1 }))
            .await
            .assert_status(400);
    }
    let r = f.create_as(&f.owner, &t, json!({ "fldDoesNotExist": 1 })).await;
    r.assert_status(400);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("fldDoesNotExist"));
    // a field of another table is unknown here too
    let other = f.add_table("Other").await;
    let other_field = &other["fields"][0];
    f.create_as(&f.owner, &t, json!({ sid(&other_field["id"]): "x" }))
        .await
        .assert_status(400);
    // a mixed valid/invalid request writes nothing
    let r = f
        .create_as(&f.owner, &t, json!({ &f.primary_id: "ok", sid(&formula["id"]): 3 }))
        .await;
    r.assert_status(400);
    assert_eq!(f.order(&t).len(), 1);
}

#[tokio::test]
async fn deleted_fields_cannot_be_written() {
    let f = Fixture::new().await;
    let n = f.number(&f.table_id, "Gone").await;
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", sid(&n["id"])))
        .await
        .assert_status(200);
    f.create_as(&f.owner, &f.table_id, json!({ sid(&n["id"]): 1 }))
        .await
        .assert_status(400);
}

// ------------------------------------------------------------- limits

#[tokio::test]
async fn batch_size_limits() {
    let f = Fixture::new().await;
    let url = records_url(&f.table_id);
    f.app
        .post(&f.owner, &url, json!({ "records": [] }))
        .await
        .assert_status(400);
    let many = |n: usize| json!({ "records": (0..n).map(|_| json!({ "values": {} })).collect::<Vec<_>>() });
    f.app.post(&f.owner, &url, many(1001)).await.assert_status(400);
    assert_eq!(f.order(&f.table_id).len(), 0);
    f.app.post(&f.owner, &url, many(1000)).await.assert_status(201);
    assert_eq!(f.order(&f.table_id).len(), 1000);
    // update and delete are limited the same way
    let ids = f.order(&f.table_id);
    let patches: Vec<Value> = ids
        .iter()
        .chain(ids.iter().take(1))
        .map(|id| json!({ "id": id, "values": {} }))
        .collect();
    f.app
        .patch(&f.owner, &url, json!({ "records": patches }))
        .await
        .assert_status(400);
    let too_many: Vec<&String> = ids.iter().chain(ids.iter().take(1)).collect();
    f.app
        .request(&f.owner, "DELETE", &url, Some(json!({ "ids": too_many })))
        .await
        .assert_status(400);
    f.app
        .request(&f.owner, "DELETE", &url, Some(json!({ "ids": [] })))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn a_table_holds_at_most_the_maximum_number_of_records() {
    let f = Fixture::new().await;
    let max = og_core::limits::MAX_RECORDS_PER_TABLE;
    let tid = f.table_id.clone();
    sql(&f.app, move |tx| {
        tx.execute(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?2)
             INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             SELECT 'recfill' || x, ?1, '{}', x, x, 1, 1 FROM c",
            rusqlite::params![tid, max as i64 - 1],
        )
    });
    f.create(&f.table_id, json!({})).await; // the last free slot
    let r = f.create_as(&f.owner, &f.table_id, json!({})).await;
    r.assert_status(400);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("at most"));
    // trashed records do not count: delete one, create one
    f.delete_records(&f.table_id, &["recfill5"]).await.assert_status(200);
    f.create(&f.table_id, json!({})).await;
    f.restore_records(&f.table_id, &["recfill5"])
        .await
        .assert_status(400);
}

// ------------------------------------------------------- update semantics

#[tokio::test]
async fn updates_that_change_nothing_leave_no_trace() {
    let f = Fixture::new().await;
    let user = f.owner.user_id.clone().unwrap();
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "same" })).await;
    let rid = sid(&rec["id"]).to_string();
    let before = f.columns(&rid);
    assert_eq!(f.history(&rid).len(), 1, "creation is logged once");

    // sleep so that a bump would be visible
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let r = f.set(&f.table_id, &rid, json!({ &f.primary_id: "same" })).await;
    assert_eq!(r["values"][&f.primary_id], "same");
    assert_eq!(f.columns(&rid), before, "no updated_at bump");
    assert_eq!(f.history(&rid).len(), 1, "no history row");
    // an empty patch is a no-op as well
    f.set(&f.table_id, &rid, json!({})).await;
    assert_eq!(f.columns(&rid), before);

    let r = f.set(&f.table_id, &rid, json!({ &f.primary_id: "different" })).await;
    let after = f.columns(&rid);
    assert!(after.2 > before.2, "updated_at moved");
    assert_eq!(after.3.as_deref(), Some(user.as_str()));
    assert_eq!(r["updated_at"], after.2);
    assert_eq!(r["created_at"], rec["created_at"]);
    assert_eq!(f.history(&rid).len(), 2);
}

#[tokio::test]
async fn history_rows_record_old_and_new_values_of_editable_fields() {
    let f = Fixture::new().await;
    let user = f.owner.user_id.clone().unwrap();
    let calc = f.formula(&f.table_id, "Calc", "{Name} & \"!\"").await;
    let rec = f
        .create(&f.table_id, json!({ &f.primary_id: "a", &f.notes_id: "n" }))
        .await;
    let rid = sid(&rec["id"]).to_string();
    f.set(&f.table_id, &rid, json!({ &f.primary_id: "b", &f.notes_id: null })).await;
    f.delete_records(&f.table_id, &[&rid]).await.assert_status(200);
    f.restore_records(&f.table_id, &[&rid]).await.assert_status(200);

    let h = f.history(&rid);
    let kinds: Vec<&str> = h.iter().map(|(k, _, _)| k.as_str()).collect();
    assert_eq!(kinds, ["create", "update", "delete", "restore"]);
    assert_eq!(
        h[0].1,
        json!({ &f.primary_id: { "old": null, "new": "a" }, &f.notes_id: { "old": null, "new": "n" } })
    );
    assert_eq!(
        h[1].1,
        json!({ &f.primary_id: { "old": "a", "new": "b" }, &f.notes_id: { "old": "n", "new": null } })
    );
    assert_eq!(h[2].1, json!({}));
    assert_eq!(h[3].1, json!({}));
    assert!(h.iter().all(|(_, _, u)| u.as_deref() == Some(user.as_str())));
    // computed fields are never part of the history
    for (_, changes, _) in &h {
        assert!(changes.get(sid(&calc["id"])).is_none());
    }
}

#[tokio::test]
async fn update_errors() {
    let f = Fixture::new().await;
    let a = f.create(&f.table_id, json!({})).await;
    let aid = sid(&a["id"]);
    let other = f.add_table("Other").await;
    let oid = id_of(&other);
    let foreign = f.create(&oid, json!({})).await;

    // unknown record, record of another table
    f.patch_as(&f.owner, &f.table_id, "recNOPE", json!({}))
        .await
        .assert_status(404);
    f.patch_as(&f.owner, &f.table_id, sid(&foreign["id"]), json!({}))
        .await
        .assert_status(404);
    // trashed record cannot be edited
    f.delete_records(&f.table_id, &[aid]).await.assert_status(200);
    f.patch_as(&f.owner, &f.table_id, aid, json!({ &f.primary_id: "x" }))
        .await
        .assert_status(404);
    // the same record twice in one batch is ambiguous
    let b = f.create(&f.table_id, json!({})).await;
    let bid = sid(&b["id"]);
    f.app
        .patch(
            &f.owner,
            &records_url(&f.table_id),
            json!({ "records": [
                { "id": bid, "values": { &f.primary_id: "1" } },
                { "id": bid, "values": { &f.primary_id: "2" } } ] }),
        )
        .await
        .assert_status(400);
    // a failure rolls the whole batch back
    let c = f.create(&f.table_id, json!({})).await;
    let r = f
        .app
        .patch(
            &f.owner,
            &records_url(&f.table_id),
            json!({ "records": [
                { "id": c["id"], "values": { &f.primary_id: "changed" } },
                { "id": "recNOPE", "values": {} } ] }),
        )
        .await;
    r.assert_status(404);
    assert!(f.record_data(sid(&c["id"])).get(&f.primary_id).is_none());
    // malformed bodies use the error envelope
    let r = f
        .app
        .patch(&f.owner, &records_url(&f.table_id), json!({ "nope": 1 }))
        .await;
    r.assert_status(400);
    assert!(r.body["error"]["code"].is_string());
}

// ------------------------------------------------------------ delete & restore

#[tokio::test]
async fn delete_is_soft_and_restore_brings_the_record_back() {
    let f = Fixture::new().await;
    let a = f.create(&f.table_id, json!({ &f.primary_id: "a" })).await;
    let b = f.create(&f.table_id, json!({ &f.primary_id: "b" })).await;
    let (aid, bid) = (sid(&a["id"]), sid(&b["id"]));
    let r = f.delete_records(&f.table_id, &[aid]).await;
    r.assert_status(200);
    assert_eq!(r.body["ids"], json!([aid]));
    assert!(f.columns(aid).4.is_some(), "deleted_at set, row kept");
    assert_eq!(f.record_data(aid)[&f.primary_id], "a", "data is kept");
    assert_eq!(f.order(&f.table_id), [bid.to_string()]);
    f.app
        .get(&f.owner, &format!("{}/{aid}", records_url(&f.table_id)))
        .await
        .assert_status(404);
    // deleting twice is a 404, not a silent success
    f.delete_records(&f.table_id, &[aid]).await.assert_status(404);

    let r = f.restore_records(&f.table_id, &[aid]).await;
    r.assert_status(200);
    assert_eq!(r.body["records"][0]["values"][&f.primary_id], "a");
    assert!(f.columns(aid).4.is_none());
    assert_eq!(f.order(&f.table_id), [aid.to_string(), bid.to_string()], "keeps its place");
    // restoring a live record or an unknown one fails
    f.restore_records(&f.table_id, &[aid]).await.assert_status(409);
    f.restore_records(&f.table_id, &["recNOPE"]).await.assert_status(404);
}

#[tokio::test]
async fn deleting_several_records_is_all_or_nothing() {
    let f = Fixture::new().await;
    let a = f.create(&f.table_id, json!({})).await;
    let aid = sid(&a["id"]);
    f.delete_records(&f.table_id, &[aid, "recNOPE"]).await.assert_status(404);
    assert!(f.columns(aid).4.is_none());
    // duplicates in the request are fine
    let r = f.delete_records(&f.table_id, &[aid, aid]).await;
    r.assert_status(200);
    assert_eq!(r.body["ids"], json!([aid]));
}

#[tokio::test]
async fn trash_endpoint_restores_a_record_through_the_write_engine() {
    let l = linked().await;
    let n = l.f.count(&l.t1, "N", &l.link).await;
    let order = l.f.create(&l.t2, json!({})).await;
    let cust = l.f.create(&l.t1, json!({ sid(&l.link["id"]): [order["id"]] })).await;
    let (cid, oid) = (sid(&cust["id"]).to_string(), sid(&order["id"]).to_string());
    assert_eq!(l.f.value(&l.t1, &cid, sid(&n["id"])).await, 1);
    l.f.delete_records(&l.t2, &[&oid]).await.assert_status(200);
    assert!(l.f.value(&l.t1, &cid, sid(&n["id"])).await.is_null() || l.f.value(&l.t1, &cid, sid(&n["id"])).await == 0);
    let r = l
        .f
        .app
        .post(
            &l.f.owner,
            "/api/trash/restore",
            json!({ "kind": "record", "id": oid }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(l.f.value(&l.t1, &cid, sid(&n["id"])).await, 1, "the count sees it again");
    assert_eq!(l.f.history(&oid).last().unwrap().0, "restore");
}

// ------------------------------------------------------- positions & move

async fn five(f: &Fixture) -> Vec<String> {
    let mut ids = Vec::new();
    for n in 0..5 {
        let r = f.create(&f.table_id, json!({ &f.primary_id: format!("r{n}") })).await;
        ids.push(sid(&r["id"]).to_string());
    }
    ids
}

#[tokio::test]
async fn records_are_created_at_the_end_or_after_a_given_record() {
    let f = Fixture::new().await;
    let ids = five(&f).await;
    assert_eq!(f.order(&f.table_id), ids);
    let r = f
        .app
        .post(
            &f.owner,
            &records_url(&f.table_id),
            json!({ "records": [ { "values": {} }, { "values": {} } ], "after_record_id": ids[1] }),
        )
        .await;
    r.assert_status(201);
    let new: Vec<String> = r.body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| sid(&r["id"]).to_string())
        .collect();
    let expected: Vec<String> = [&ids[0], &ids[1], &new[0], &new[1], &ids[2], &ids[3], &ids[4]]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(f.order(&f.table_id), expected);
    // after the last record
    let r = f
        .app
        .post(
            &f.owner,
            &records_url(&f.table_id),
            json!({ "records": [ { "values": {} } ], "after_record_id": ids[4] }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(f.order(&f.table_id).last().unwrap(), sid(&r.body["records"][0]["id"]));
    // unknown or trashed anchors are rejected
    f.app
        .post(
            &f.owner,
            &records_url(&f.table_id),
            json!({ "records": [ { "values": {} } ], "after_record_id": "recNOPE" }),
        )
        .await
        .assert_status(400);
    f.delete_records(&f.table_id, &[&ids[0]]).await.assert_status(200);
    f.app
        .post(
            &f.owner,
            &records_url(&f.table_id),
            json!({ "records": [ { "values": {} } ], "after_record_id": ids[0] }),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn repeated_insertion_between_two_records_never_runs_out_of_room() {
    let f = Fixture::new().await;
    let ids = five(&f).await;
    // always insert directly after the first record: the gap halves every time
    let mut inserted = Vec::new();
    for _ in 0..70 {
        let r = f
            .app
            .post(
                &f.owner,
                &records_url(&f.table_id),
                json!({ "records": [ { "values": {} } ], "after_record_id": ids[0] }),
            )
            .await;
        r.assert_status(201);
        inserted.push(sid(&r.body["records"][0]["id"]).to_string());
    }
    let order = f.order(&f.table_id);
    assert_eq!(order[0], ids[0]);
    // newest insertion sits directly after the first record
    let expected: Vec<String> = std::iter::once(ids[0].clone())
        .chain(inserted.iter().rev().cloned())
        .chain(ids[1..].iter().cloned())
        .collect();
    assert_eq!(order, expected);
}

#[tokio::test]
async fn move_places_records_before_or_after_a_reference_record() {
    let f = Fixture::new().await;
    let ids = five(&f).await;
    let url = format!("{}/move", records_url(&f.table_id));
    let mv = |body: Value| f.app.post(&f.owner, &url, body);

    mv(json!({ "ids": [ids[4], ids[3]], "before_id": ids[0] })).await.assert_status(200);
    assert_eq!(
        f.order(&f.table_id),
        [&ids[4], &ids[3], &ids[0], &ids[1], &ids[2]].map(|s| s.to_string())
    );
    mv(json!({ "ids": [ids[4]], "after_id": ids[2] })).await.assert_status(200);
    assert_eq!(
        f.order(&f.table_id),
        [&ids[3], &ids[0], &ids[1], &ids[2], &ids[4]].map(|s| s.to_string())
    );
    // the given order of several moved records is kept
    mv(json!({ "ids": [ids[2], ids[1]], "after_id": ids[3] })).await.assert_status(200);
    assert_eq!(
        f.order(&f.table_id),
        [&ids[3], &ids[2], &ids[1], &ids[0], &ids[4]].map(|s| s.to_string())
    );
    // neither anchor: to the end
    mv(json!({ "ids": [ids[3]] })).await.assert_status(200);
    assert_eq!(f.order(&f.table_id).last().unwrap(), &ids[3]);
}

#[tokio::test]
async fn move_errors_and_effects() {
    let f = Fixture::new().await;
    let ids = five(&f).await;
    let url = format!("{}/move", records_url(&f.table_id));
    let history_before = f.history(&ids[0]).len();
    let updated_before = f.columns(&ids[0]).2;
    // both anchors, the anchor among the moved ones, unknown ids, empty
    f.app
        .post(&f.owner, &url, json!({ "ids": [ids[0]], "before_id": ids[1], "after_id": ids[2] }))
        .await
        .assert_status(400);
    f.app
        .post(&f.owner, &url, json!({ "ids": [ids[0]], "before_id": ids[0] }))
        .await
        .assert_status(400);
    f.app
        .post(&f.owner, &url, json!({ "ids": ["recNOPE"], "before_id": ids[0] }))
        .await
        .assert_status(404);
    f.app
        .post(&f.owner, &url, json!({ "ids": [ids[0]], "before_id": "recNOPE" }))
        .await
        .assert_status(400);
    f.app.post(&f.owner, &url, json!({ "ids": [] })).await.assert_status(400);
    assert_eq!(f.order(&f.table_id), ids, "nothing moved");

    // moving is not an edit: no history, no updated_at change; but an event
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    f.app
        .post(&f.owner, &url, json!({ "ids": [ids[0]], "after_id": ids[4] }))
        .await
        .assert_status(200);
    assert_eq!(f.history(&ids[0]).len(), history_before);
    assert_eq!(f.columns(&ids[0]).2, updated_before);
    let ev = rx.try_recv().unwrap();
    assert!(matches!(
        ev.event,
        og_core::api::events::BaseEvent::RecordsChanged { ref updated, .. } if updated == &[ids[0].clone()]
    ));
    // trashed records cannot be moved
    f.delete_records(&f.table_id, &[&ids[1]]).await.assert_status(200);
    f.app
        .post(&f.owner, &url, json!({ "ids": [ids[1]], "after_id": ids[2] }))
        .await
        .assert_status(404);
}

// ----------------------------------------------------------------- events

#[tokio::test]
async fn events_are_published_after_commit_one_per_table() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let a = f.create(&f.table_id, json!({ &f.primary_id: "a" })).await;
    let aid = sid(&a["id"]).to_string();
    let ev = rx.try_recv().unwrap();
    assert_eq!(ev.base_id, f.base_id);
    assert_eq!(ev.user_id.as_deref(), f.owner.user_id.as_deref());
    assert!(matches!(
        ev.event,
        og_core::api::events::BaseEvent::RecordsChanged { ref table_id, ref created, ref updated, ref deleted }
            if *table_id == f.table_id && created == &[aid.clone()] && updated.is_empty() && deleted.is_empty()
    ));
    f.set(&f.table_id, &aid, json!({ &f.primary_id: "b" })).await;
    assert!(matches!(
        rx.try_recv().unwrap().event,
        og_core::api::events::BaseEvent::RecordsChanged { ref updated, .. } if updated == &[aid.clone()]
    ));
    // a no-op update announces nothing
    f.set(&f.table_id, &aid, json!({ &f.primary_id: "b" })).await;
    assert!(rx.try_recv().is_err());
    f.delete_records(&f.table_id, &[&aid]).await.assert_status(200);
    assert!(matches!(
        rx.try_recv().unwrap().event,
        og_core::api::events::BaseEvent::RecordsChanged { ref deleted, .. } if deleted == &[aid.clone()]
    ));
    f.restore_records(&f.table_id, &[&aid]).await.assert_status(200);
    assert!(matches!(
        rx.try_recv().unwrap().event,
        og_core::api::events::BaseEvent::RecordsChanged { ref created, .. } if created == &[aid.clone()]
    ));
    // failed writes publish nothing
    f.create_as(&f.owner, &f.table_id, json!({ "fldNOPE": 1 })).await.assert_status(400);
    f.patch_as(&f.owner, &f.table_id, "recNOPE", json!({})).await.assert_status(404);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn the_clients_id_travels_with_the_event() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let r = f
        .app
        .request_with(
            &f.owner,
            "POST",
            &records_url(&f.table_id),
            Some(json!({ "records": [ { "values": {} } ] })),
            &[("x-client-id", "tab-42")],
            true,
            None,
        )
        .await;
    r.assert_status(201);
    assert_eq!(rx.try_recv().unwrap().client_id.as_deref(), Some("tab-42"));
}

// ------------------------------------------------------------------ roles

#[tokio::test]
async fn role_matrix_for_record_writes() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    let rid = sid(&rec["id"]).to_string();
    for role in ALL_ROLES {
        let who = f.member(&format!("{}-role@example.com", role.as_str()), role);
        let can_write = role >= Role::Editor;
        let expect = if can_write { [201, 200, 200] } else { [403, 403, 403] };
        let url = records_url(&f.table_id);

        let r = f.create_as(&who, &f.table_id, json!({})).await;
        assert_eq!(r.status.as_u16(), expect[0], "{role:?} create");
        let r = f.patch_as(&who, &f.table_id, &rid, json!({ &f.primary_id: role.as_str() })).await;
        assert_eq!(r.status.as_u16(), expect[1], "{role:?} patch");
        let tmp = f.create(&f.table_id, json!({})).await;
        let tid = sid(&tmp["id"]).to_string();
        let r = f
            .app
            .request(&who, "DELETE", &url, Some(json!({ "ids": [tid] })))
            .await;
        assert_eq!(r.status.as_u16(), expect[2], "{role:?} delete");
        if can_write {
            let r = f
                .app
                .post(&who, &format!("{url}/restore"), json!({ "ids": [tid] }))
                .await;
            assert_eq!(r.status.as_u16(), 200, "{role:?} restore");
            let r = f
                .app
                .post(&who, &format!("{url}/move"), json!({ "ids": [tid] }))
                .await;
            assert_eq!(r.status.as_u16(), 200, "{role:?} move");
        } else {
            f.delete_records(&f.table_id, &[&tid]).await.assert_status(200);
            let r = f
                .app
                .post(&who, &format!("{url}/restore"), json!({ "ids": [tid] }))
                .await;
            assert_eq!(r.status.as_u16(), 403, "{role:?} restore");
            let r = f
                .app
                .post(&who, &format!("{url}/move"), json!({ "ids": [rid] }))
                .await;
            assert_eq!(r.status.as_u16(), 403, "{role:?} move");
        }
        // everyone can read
        let r = f.app.get(&who, &format!("{url}/{rid}")).await;
        assert_eq!(r.status.as_u16(), 200, "{role:?} get");
    }
}

#[tokio::test]
async fn strangers_anonymous_callers_and_base_guests() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({})).await;
    let rid = sid(&rec["id"]).to_string();
    let url = records_url(&f.table_id);
    // no access at all: 404, never 403 (ids do not leak)
    let stranger = f.app.user("stranger@example.com", "Stranger");
    f.app.get(&stranger, &format!("{url}/{rid}")).await.assert_status(404);
    f.create_as(&stranger, &f.table_id, json!({})).await.assert_status(404);
    f.patch_as(&stranger, &f.table_id, &rid, json!({})).await.assert_status(404);
    // not signed in
    let anon = f.app.anon();
    f.app.get(&anon, &format!("{url}/{rid}")).await.assert_status(401);
    f.create_as(&anon, &f.table_id, json!({})).await.assert_status(401);
    // base-level guests: editor can write, viewer cannot
    let ed = f.base_guest("guest-ed@example.com", Role::Editor);
    f.create_as(&ed, &f.table_id, json!({})).await.assert_status(201);
    let vw = f.base_guest("guest-vw@example.com", Role::Viewer);
    f.create_as(&vw, &f.table_id, json!({})).await.assert_status(403);
    // unknown table
    f.create_as(&f.owner, "tblNOPE", json!({})).await.assert_status(404);
    // cookie-authenticated writes need the CSRF header
    let r = f
        .app
        .request_with(
            &f.owner,
            "POST",
            &url,
            Some(json!({ "records": [ { "values": {} } ] })),
            &[],
            false,
            None,
        )
        .await;
    r.assert_status(403);
}

#[tokio::test]
async fn read_only_tokens_cannot_write_but_can_read() {
    let f = Fixture::new().await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "x" })).await;
    let rid = sid(&rec["id"]).to_string();
    let url = records_url(&f.table_id);
    let ro = token_client(&f.app, &f.owner, false);
    let rw = token_client(&f.app, &f.owner, true);

    f.app.get(&ro, &format!("{url}/{rid}")).await.assert_status(200);
    f.create_as(&ro, &f.table_id, json!({})).await.assert_status(403);
    f.patch_as(&ro, &f.table_id, &rid, json!({ &f.primary_id: "y" })).await.assert_status(403);
    f.app
        .request(&ro, "DELETE", &url, Some(json!({ "ids": [rid] })))
        .await
        .assert_status(403);
    f.app
        .post(&ro, &format!("{url}/restore"), json!({ "ids": [rid] }))
        .await
        .assert_status(403);
    f.app
        .post(&ro, &format!("{url}/move"), json!({ "ids": [rid] }))
        .await
        .assert_status(403);
    assert_eq!(f.record_data(&rid)[&f.primary_id], "x", "nothing changed");
    assert_eq!(f.order(&f.table_id).len(), 1);

    // a write token works, and acts as the user
    let r = f.create_as(&rw, &f.table_id, json!({ &f.primary_id: "via token" })).await;
    r.assert_status(201);
    assert_eq!(r.body["records"][0]["created_by"], f.owner.user_id.clone().unwrap());
}

#[tokio::test]
async fn a_token_limited_to_other_bases_cannot_reach_this_one() {
    let f = Fixture::new().await;
    let token = format!("pat_test_{}", opengrid::ids::new_id("x"));
    let hash = opengrid::ids::hash_token(&token);
    let uid = f.owner.user_id.clone().unwrap();
    let scopes = json!({ "write": true, "base_ids": ["appSomethingElse"] }).to_string();
    sql(&f.app, move |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
             VALUES ('patx', ?1, 't', ?2, ?3, 1)",
            rusqlite::params![uid, hash, scopes],
        )
    });
    let client = common::Client {
        cookie: None,
        bearer: Some(token),
        user_id: f.owner.user_id.clone(),
    };
    f.create_as(&client, &f.table_id, json!({})).await.assert_status(404);
}
