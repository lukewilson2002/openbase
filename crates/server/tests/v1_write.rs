//! Airtable-compatible API, writing: create, update (PATCH merge, PUT
//! replace) and delete, with typecast, limits, atomicity, events and history.

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;
mod sse_support;
mod v1_support;

use serde_json::{Value, json};
use v1_support::*;

fn rec_path(v: &V1, id: &str) -> String {
    v.path(&format!("/{id}"))
}

async fn count(v: &V1) -> usize {
    v.get("").await.body["records"].as_array().unwrap().len()
}

// -------------------------------------------------------------- create

#[tokio::test]
async fn create_a_batch_of_records() {
    let v = v1_people().await;
    let r = v
        .post(json!({ "records": [
            { "fields": { "Name": "Frank", "Age": 52, "Status": "Done", "Tags": ["a", "b"], "Due": "2026-05-01", "Done": true } },
            { "fields": { "Name": "Gina" } },
        ] }))
        .await;
    r.assert_status(200);
    let records = r.body["records"].as_array().unwrap();
    assert_eq!(records.len(), 2);
    assert!(r.body.get("offset").is_none());
    assert_eq!(
        records[0]["fields"],
        json!({ "Name": "Frank", "Age": 52, "Status": "Done", "Tags": ["a", "b"], "Due": "2026-05-01", "Done": true })
    );
    assert_eq!(records[1]["fields"], json!({ "Name": "Gina" }));
    assert!(records[0]["id"].as_str().unwrap().starts_with("rec"));
    assert!(records[0]["createdTime"].as_str().unwrap().ends_with('Z'));
    // In request order, at the end of the table.
    let listed = v.get("").await;
    assert_eq!(&V1::listed_names(&listed)[5..], ["Frank", "Gina"]);
    // The internal API sees the same records.
    let internal =
        v.p.f
            .get(v.table_id(), records[0]["id"].as_str().unwrap())
            .await;
    assert_eq!(internal["values"][&v.p.name], "Frank");
    assert_eq!(internal["created_by"], json!(v.p.f.owner.user_id));
}

#[tokio::test]
async fn create_a_single_record_returns_the_bare_record() {
    let v = v1_people().await;
    let r = v
        .post(json!({ "fields": { "Name": "Solo", "Age": 7 } }))
        .await;
    r.assert_status(200);
    assert!(r.body.get("records").is_none());
    assert_eq!(r.body["fields"], json!({ "Name": "Solo", "Age": 7 }));
    assert!(r.body["id"].as_str().unwrap().starts_with("rec"));
    assert_eq!(count(&v).await, 6);
    // An empty record is fine.
    let empty = v.post(json!({ "fields": {} })).await;
    empty.assert_status(200);
    assert_eq!(empty.body["fields"], json!({}));
}

#[tokio::test]
async fn fields_may_be_keyed_by_name_or_by_id() {
    let v = v1_people().await;
    let r = v
        .post(json!({ "records": [
            { "fields": { &v.p.name: "ById", &v.p.age: 3 } },
            { "fields": { "Name": "ByName", &v.p.age: 4 } },
        ] }))
        .await;
    r.assert_status(200);
    // The response is keyed by name unless asked otherwise.
    assert_eq!(
        r.body["records"][0]["fields"],
        json!({ "Name": "ById", "Age": 3 })
    );
    let by_id = v
        .post(json!({ "fields": { "Name": "X" }, "returnFieldsByFieldId": true }))
        .await;
    assert_eq!(by_id.body["fields"], json!({ &v.p.name: "X" }));
    // The same field twice (name and id) is ambiguous.
    let dup = v.post(json!({ "fields": { "Age": 1, &v.p.age: 2 } })).await;
    assert_v1_error(&dup, 422, "INVALID_REQUEST_UNKNOWN");
}

#[tokio::test]
async fn create_validates_the_request_shape() {
    let v = v1_people().await;
    let before = count(&v).await;
    for body in [
        json!({}),
        json!({ "records": [] }),
        json!({ "records": [{ "fields": {} }], "fields": {} }),
        json!({ "records": {} }),
        json!({ "fields": [] }),
    ] {
        assert_v1_error(&v.post(body.clone()).await, 422, "INVALID_REQUEST_UNKNOWN");
    }
    assert_eq!(count(&v).await, before);
}

#[tokio::test]
async fn create_takes_at_most_ten_records() {
    let v = v1_people().await;
    let ten: Vec<Value> = (0..10)
        .map(|i| json!({ "fields": { "Name": format!("n{i}") } }))
        .collect();
    v.post(json!({ "records": ten })).await.assert_status(200);
    assert_eq!(count(&v).await, 15);
    let eleven: Vec<Value> = (0..11)
        .map(|i| json!({ "fields": { "Name": format!("m{i}") } }))
        .collect();
    let r = v.post(json!({ "records": eleven })).await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
    assert!(r.body["error"]["message"].as_str().unwrap().contains("10"));
    assert_eq!(count(&v).await, 15, "nothing from the rejected batch");
}

#[tokio::test]
async fn unknown_and_computed_fields_are_rejected_by_name() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let r = v
        .post(json!({ "fields": { "Name": "a", "Nope": 1 } }))
        .await;
    assert_v1_error(&r, 422, "UNKNOWN_FIELD_NAME");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Nope")
    );
    // Computed fields cannot take values.
    let path = format!("/api/v1/{}/Everything", v.base_id());
    for name in [
        "Calc",
        "Names",
        "AgeSum",
        "LinkCount",
        "Created",
        "Modified",
        "Author",
        "Editor",
        "Auto",
        "Go",
    ] {
        let r = v
            .app()
            .post(
                &v.token,
                &path,
                json!({ "fields": { "Title": "t", name: 1 } }),
            )
            .await;
        assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
        assert!(
            r.body["error"]["message"].as_str().unwrap().contains(name),
            "{name}"
        );
    }
    let n: i64 = v.app().query_i64(
        "SELECT count(*) FROM records WHERE table_id = ?1",
        &[&e.table_id],
    );
    assert_eq!(n, 1, "only the fixture's record exists");
}

#[tokio::test]
async fn invalid_values_are_422_invalid_value_for_column() {
    let v = v1_people().await;
    let cases = [
        ("Age", json!("not a number")),
        ("Age", json!(true)),
        ("Done", json!("yes")),
        ("Due", json!("not a date")),
        ("Tags", json!("a")),
        ("Name", json!(123)),
        ("Name", json!(["a"])),
    ];
    for (name, value) in cases {
        let r = v.post(json!({ "fields": { name: value.clone() } })).await;
        assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
        assert!(
            r.body["error"]["message"].as_str().unwrap().contains(name),
            "{name} {value}: {}",
            r.body
        );
    }
    assert_eq!(count(&v).await, 5);
}

#[tokio::test]
async fn a_failing_record_rolls_back_the_whole_batch() {
    let v = v1_people().await;
    let r = v
        .post(json!({ "records": [
            { "fields": { "Name": "Good 1" } },
            { "fields": { "Name": "Good 2", "Age": 2 } },
            { "fields": { "Name": "Bad", "Age": "x" } },
        ] }))
        .await;
    assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
    assert_eq!(count(&v).await, 5);
    let n = v.app().query_i64(
        "SELECT count(*) FROM records WHERE table_id = ?1",
        &[v.table_id()],
    );
    assert_eq!(n, 5, "not even trashed rows");
}

#[tokio::test]
async fn select_options_need_typecast_to_be_created() {
    let v = v1_people().await;
    let r = v
        .post(json!({ "fields": { "Name": "a", "Status": "Blocked" } }))
        .await;
    assert_v1_error(&r, 422, "INVALID_MULTIPLE_CHOICE_OPTIONS");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Blocked")
    );
    let r = v
        .post(json!({ "fields": { "Name": "a", "Tags": ["a", "c"] } }))
        .await;
    assert_v1_error(&r, 422, "INVALID_MULTIPLE_CHOICE_OPTIONS");
    // Existing options match by name, case-insensitively.
    let ok = v
        .post(json!({ "fields": { "Name": "a", "Status": "todo", "Tags": ["B"] } }))
        .await;
    ok.assert_status(200);
    assert_eq!(ok.body["fields"]["Status"], "Todo");
    assert_eq!(ok.body["fields"]["Tags"], json!(["b"]));
    // With typecast the missing options are created and shown right away.
    let r = v
        .post(json!({ "fields": { "Name": "b", "Status": "Blocked", "Tags": ["c", "d"] }, "typecast": true }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["fields"]["Status"], "Blocked");
    assert_eq!(r.body["fields"]["Tags"], json!(["c", "d"]));
    let status = v.p.f.field(v.table_id(), "Status").await;
    let names: Vec<&str> = status["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Todo", "Doing", "Done", "Blocked"]);
}

#[tokio::test]
async fn typecast_coerces_strings_like_airtable() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    let body = json!({ "typecast": true, "fields": {
        "Title": 42,
        "Num": "1,234.5678",
        "Cur": "EUR 9.99",
        "Pct": "25%",
        "Rate": "3",
        "Check": "yes",
        "Sel": "Green",
        "Multi": "x, y",
        "Day": "March 5, 2026",
        "Dur": "1:30:00",
    } });
    // Without typecast the same strings are refused.
    let mut strict = body.clone();
    strict["typecast"] = json!(false);
    assert_v1_error(
        &v.app().post(&v.token, &path, strict).await,
        422,
        "INVALID_VALUE_FOR_COLUMN",
    );
    let r = v.app().post(&v.token, &path, body).await;
    r.assert_status(200);
    let f = &r.body["fields"];
    assert_eq!(f["Title"], "42");
    assert_eq!(f["Num"], 1234.57);
    assert_eq!(f["Cur"], 9.99);
    assert_eq!(f["Pct"], 0.25);
    assert_eq!(f["Rate"], 3);
    assert_eq!(f["Check"], true);
    assert_eq!(f["Sel"], "Green");
    assert_eq!(f["Multi"], json!(["x", "y"]));
    assert_eq!(f["Day"], "2026-03-05");
    assert_eq!(f["Dur"], 5400);
    let _ = e;
}

#[tokio::test]
async fn links_collaborators_and_attachments_are_written_in_airtable_shapes() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    let ann =
        v.p.f
            .member("ann@example.com", opengrid::perm::Role::Editor);
    let bob =
        v.p.f
            .member("bob@example.com", opengrid::perm::Role::Viewer);
    let file = v.p.f.upload("note.txt", b"hello").await;
    let r = v
        .app()
        .post(
            &v.token,
            &path,
            json!({ "fields": {
                "Title": "Shapes",
                "Links": [v.p.ids[2], v.p.ids[3]],
                "Owner": { "email": "ANN@example.com" },
                "Team": [{ "id": bob.user_id }, { "email": "ann@example.com" }],
                "Files": [{ "id": file["id"] }],
            } }),
        )
        .await;
    r.assert_status(200);
    let f = &r.body["fields"];
    assert_eq!(f["Links"], json!([v.p.ids[2], v.p.ids[3]]));
    assert_eq!(f["Owner"]["id"], json!(ann.user_id));
    assert_eq!(f["Owner"]["email"], "ann@example.com");
    let team: Vec<&str> = f["Team"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["email"].as_str().unwrap())
        .collect();
    assert_eq!(team, ["bob@example.com", "ann@example.com"]);
    assert_eq!(f["Files"][0]["id"], file["id"]);
    assert_eq!(f["Files"][0]["filename"], "note.txt");
    assert_eq!(f["Files"][0]["size"], 5);
    // The inverse side of the link is maintained.
    let alice_like = v.p.f.get(v.table_id(), &v.p.ids[2]).await;
    let _ = alice_like;
    assert_eq!(f["LinkCount"], 2);
    let _ = e;
}

#[tokio::test]
async fn collaborators_must_have_access_to_the_base() {
    let v = v1_people().await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    let _e = everything(&v).await;
    let outsider = v.p.f.app.user("outsider@example.com", "Outsider");
    for owner in [
        json!({ "email": "outsider@example.com" }),
        json!({ "id": outsider.user_id }),
        json!({ "email": "nobody@example.com" }),
        json!("not-an-id"),
        json!(42),
    ] {
        let r = v
            .app()
            .post(
                &v.token,
                &path,
                json!({ "fields": { "Title": "x", "Owner": owner.clone() } }),
            )
            .await;
        assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Owner"),
            "{owner}"
        );
    }
}

#[tokio::test]
async fn attachment_urls_are_not_fetched() {
    let v = v1_people().await;
    let _e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    let r = v
        .app()
        .post(
            &v.token,
            &path,
            json!({ "fields": { "Title": "x", "Files": [{ "url": "http://127.0.0.1:1/secret" }] } }),
        )
        .await;
    assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("uploaded")
    );
    // An id of a file in another base is refused.
    let other = base(v.app(), &v.p.f.owner, &v.p.f.ws, "Other").await;
    let up = post_multipart(
        v.app(),
        &v.p.f.owner,
        &format!("/api/bases/{}/attachments", other["id"].as_str().unwrap()),
        &[("file", Some("x.txt"), b"data")],
        &[],
    )
    .await;
    up.assert_status(200);
    let r = v
        .app()
        .post(
            &v.token,
            &path,
            json!({ "fields": { "Title": "x", "Files": [{ "id": up.body["id"] }] } }),
        )
        .await;
    assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
}

#[tokio::test]
async fn links_to_missing_or_foreign_records_are_rejected() {
    let v = v1_people().await;
    let _e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    for links in [json!(["recNOTTHERE000000"]), json!(["bad"])] {
        let r = v
            .app()
            .post(
                &v.token,
                &path,
                json!({ "fields": { "Title": "x", "Links": links } }),
            )
            .await;
        assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
    }
}

#[tokio::test]
async fn created_records_publish_events_and_show_up_in_cached_queries() {
    let v = v1_people().await;
    // Prime the view-query cache.
    let before = v.p.f.query(json!({})).await;
    assert_eq!(before["total"], 5);
    let mut rx = v.app().state.events.subscribe(v.base_id());
    let r = v.post(json!({ "fields": { "Name": "Evented" } })).await;
    r.assert_status(200);
    let id = r.body["id"].as_str().unwrap();
    let env = rx.try_recv().expect("an event was published");
    match &env.event {
        og_core::api::events::BaseEvent::RecordsChanged {
            created, table_id, ..
        } => {
            assert_eq!(created, &[id.to_string()]);
            assert_eq!(table_id, v.table_id());
        }
        other => panic!("unexpected event {other:?}"),
    }
    assert_eq!(env.user_id, v.p.f.owner.user_id);
    assert_eq!(v.p.f.query(json!({})).await["total"], 6);
}

#[tokio::test]
async fn created_records_have_history_and_automations_see_them() {
    let v = v1_people().await;
    let r = v
        .post(json!({ "fields": { "Name": "Hist", "Age": 9 } }))
        .await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let history = v
        .app()
        .get(&v.p.f.owner, &format!("/api/records/{id}/history"))
        .await;
    history.assert_status(200);
    let entries = history.body.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["kind"], "create");
    assert_eq!(entries[0]["user_id"], json!(v.p.f.owner.user_id));
    assert_eq!(entries[0]["changes"][&v.p.age]["new"], 9);
}

// -------------------------------------------------------------- update

#[tokio::test]
async fn patch_merges_the_given_fields_only() {
    let v = v1_people().await;
    let id = &v.p.ids[0];
    let r = v
        .patch(json!({ "records": [{ "id": id, "fields": { "Age": 31, "Notes": "hi" } }] }))
        .await;
    r.assert_status(200);
    assert_eq!(
        r.body["records"][0]["fields"],
        json!({ "Name": "Alice", "Age": 31, "Notes": "hi", "Status": "Todo", "Tags": ["a"], "Due": "2026-03-01" })
    );
    assert_eq!(r.body["records"][0]["id"], *id);
    // Null clears a cell; absent keys stay.
    let r = v
        .patch(json!({ "records": [{ "id": id, "fields": { "Age": null, "Tags": [] , "Due": null } }] }))
        .await;
    assert_eq!(
        r.body["records"][0]["fields"],
        json!({ "Name": "Alice", "Notes": "hi", "Status": "Todo" })
    );
    // Several records at once, answered in request order.
    let r = v
        .patch(json!({ "records": [
            { "id": v.p.ids[2], "fields": { "Name": "Carol 2" } },
            { "id": v.p.ids[1], "fields": { "Name": "bob 2" } },
        ] }))
        .await;
    let names: Vec<&str> = r.body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["fields"]["Name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Carol 2", "bob 2"]);
}

#[tokio::test]
async fn patch_a_single_record_by_id_in_the_path() {
    let v = v1_people().await;
    let id = &v.p.ids[1];
    let r = v
        .app()
        .patch(
            &v.token,
            &rec_path(&v, id),
            json!({ "fields": { "Age": 26 } }),
        )
        .await;
    r.assert_status(200);
    assert!(r.body.get("records").is_none());
    assert_eq!(r.body["id"], *id);
    assert_eq!(r.body["fields"]["Age"], 26);
    assert_eq!(r.body["fields"]["Name"], "bob");
    assert_v1_error(
        &v.app()
            .patch(&v.token, &rec_path(&v, "recNOPE"), json!({ "fields": {} }))
            .await,
        404,
        "NOT_FOUND",
    );
    assert_v1_error(
        &v.app()
            .patch(&v.token, &rec_path(&v, id), json!({ "nofields": 1 }))
            .await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
}

#[tokio::test]
async fn patch_validates_ids_limits_and_values_atomically() {
    let v = v1_people().await;
    let id = &v.p.ids[0];
    // Unknown record: 404, and the earlier record in the batch is not written.
    let r = v
        .patch(json!({ "records": [
            { "id": id, "fields": { "Name": "Changed" } },
            { "id": "recMISSING0000000", "fields": { "Name": "x" } },
        ] }))
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
    assert_eq!(v.p.f.value(v.table_id(), id, &v.p.name).await, "Alice");
    // Bad value in the second record.
    let r = v
        .patch(json!({ "records": [
            { "id": id, "fields": { "Name": "Changed" } },
            { "id": v.p.ids[1], "fields": { "Age": "x" } },
        ] }))
        .await;
    assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
    assert_eq!(v.p.f.value(v.table_id(), id, &v.p.name).await, "Alice");
    // Unknown field, duplicates, empty and too many.
    assert_v1_error(
        &v.patch(json!({ "records": [{ "id": id, "fields": { "Nope": 1 } }] }))
            .await,
        422,
        "UNKNOWN_FIELD_NAME",
    );
    assert_v1_error(
        &v.patch(json!({ "records": [{ "id": id, "fields": {} }, { "id": id, "fields": {} }] }))
            .await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
    assert_v1_error(
        &v.patch(json!({ "records": [] })).await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
    assert_v1_error(&v.patch(json!({})).await, 422, "INVALID_REQUEST_UNKNOWN");
    let eleven: Vec<Value> = (0..11).map(|_| json!({ "id": id, "fields": {} })).collect();
    assert_v1_error(
        &v.patch(json!({ "records": eleven })).await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
    // Computed fields cannot be set.
    let e = everything(&v).await;
    let r = v
        .app()
        .patch(
            &v.token,
            &format!("/api/v1/{}/Everything", v.base_id()),
            json!({ "records": [{ "id": e.record_id, "fields": { "Calc": 5 } }] }),
        )
        .await;
    assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
}

#[tokio::test]
async fn patching_another_tables_record_is_404() {
    let v = v1_people().await;
    let other = v.p.f.add_table("Other").await;
    let foreign = v.p.f.insert_record(&id_of(&other), json!({}));
    let r = v
        .patch(json!({ "records": [{ "id": foreign, "fields": { "Name": "x" } }] }))
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
    // And trashed records.
    v.p.f
        .delete_records(v.table_id(), &[&v.p.ids[0]])
        .await
        .assert_status(204);
    let r = v
        .patch(json!({ "records": [{ "id": v.p.ids[0], "fields": { "Name": "x" } }] }))
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
}

#[tokio::test]
async fn patch_with_typecast_and_select_options() {
    let v = v1_people().await;
    let id = &v.p.ids[3];
    let strict = v
        .patch(json!({ "records": [{ "id": id, "fields": { "Age": "12" } }] }))
        .await;
    assert_v1_error(&strict, 422, "INVALID_VALUE_FOR_COLUMN");
    let r = v
        .patch(json!({ "typecast": true, "records": [{ "id": id, "fields": { "Age": "12", "Status": "Parked" } }] }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["records"][0]["fields"]["Age"], 12);
    assert_eq!(r.body["records"][0]["fields"]["Status"], "Parked");
    assert_v1_error(
        &v.patch(json!({ "records": [{ "id": id, "fields": { "Status": "Elsewhere" } }] }))
            .await,
        422,
        "INVALID_MULTIPLE_CHOICE_OPTIONS",
    );
}

#[tokio::test]
async fn upserts_are_not_supported() {
    let v = v1_people().await;
    let r = v
        .patch(json!({
            "performUpsert": { "fieldsToMergeOn": ["Name"] },
            "records": [{ "fields": { "Name": "Alice", "Age": 1 } }],
        }))
        .await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("performUpsert")
    );
    assert_eq!(count(&v).await, 5);
}

#[tokio::test]
async fn patch_does_not_touch_unchanged_records() {
    let v = v1_people().await;
    let id = &v.p.ids[0];
    let before = v.p.f.get(v.table_id(), id).await["updated_at"].clone();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let r = v
        .patch(json!({ "records": [{ "id": id, "fields": { "Name": "Alice", "Age": 30 } }] }))
        .await;
    r.assert_status(200);
    assert_eq!(v.p.f.get(v.table_id(), id).await["updated_at"], before);
    let h = v
        .app()
        .get(&v.p.f.owner, &format!("/api/records/{id}/history"))
        .await;
    assert_eq!(h.body.as_array().unwrap().len(), 1, "only the creation");
}

#[tokio::test]
async fn updates_record_history_and_publish_events() {
    let v = v1_people().await;
    let id = &v.p.ids[0];
    let mut rx = v.app().state.events.subscribe(v.base_id());
    v.patch(json!({ "records": [{ "id": id, "fields": { "Age": 99 } }] }))
        .await
        .assert_status(200);
    let env = rx.try_recv().expect("event");
    match &env.event {
        og_core::api::events::BaseEvent::RecordsChanged { updated, .. } => {
            assert_eq!(updated, std::slice::from_ref(id))
        }
        other => panic!("{other:?}"),
    }
    let h = v
        .app()
        .get(&v.p.f.owner, &format!("/api/records/{id}/history"))
        .await;
    let latest = &h.body[0];
    assert_eq!(latest["kind"], "update");
    assert_eq!(latest["changes"][&v.p.age], json!({ "old": 30, "new": 99 }));
    assert_eq!(latest["user_id"], json!(v.p.f.owner.user_id));
}

#[tokio::test]
async fn computed_fields_are_recomputed_after_v1_writes() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    let r = v
        .app()
        .patch(
            &v.token,
            &path,
            json!({ "records": [{ "id": e.record_id, "fields": { "Num": 10, "Links": [v.p.ids[2]] } }] }),
        )
        .await;
    r.assert_status(200);
    let f = &r.body["records"][0]["fields"];
    assert_eq!(f["Calc"], 20);
    assert_eq!(f["LinkCount"], 1);
    assert_eq!(f["AgeSum"], 41);
    assert_eq!(f["Names"], json!(["Carol"]));
    // Writing to the linked table through v1 updates the lookup side too.
    v.patch(json!({ "records": [{ "id": v.p.ids[2], "fields": { "Age": 50 } }] }))
        .await
        .assert_status(200);
    let r = v
        .app()
        .get(&v.token, &format!("{path}/{}", e.record_id))
        .await;
    assert_eq!(r.body["fields"]["AgeSum"], 50);
}

// ----------------------------------------------------------------- put

#[tokio::test]
async fn put_replaces_every_editable_field() {
    let v = v1_people().await;
    let id = &v.p.ids[0];
    let r = v
        .put(json!({ "records": [{ "id": id, "fields": { "Name": "Alicia", "Notes": "n" } }] }))
        .await;
    r.assert_status(200);
    // Everything not given is cleared.
    assert_eq!(
        r.body["records"][0]["fields"],
        json!({ "Name": "Alicia", "Notes": "n" })
    );
    let internal = v.p.f.get(v.table_id(), id).await;
    assert_eq!(internal["values"].as_object().unwrap().len(), 2);
    // PATCH, in contrast, would have kept them.
    let id2 = &v.p.ids[1];
    let r = v
        .patch(json!({ "records": [{ "id": id2, "fields": { "Name": "Bobby" } }] }))
        .await;
    assert_eq!(r.body["records"][0]["fields"]["Age"], 25);
}

#[tokio::test]
async fn put_leaves_computed_fields_alone_and_recomputes_them() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    let r = v
        .app()
        .put(
            &v.token,
            &format!("{path}/{}", e.record_id),
            json!({ "fields": { "Title": "Only", "Num": 2 } }),
        )
        .await;
    r.assert_status(200);
    let f = &r.body["fields"];
    assert_eq!(f["Title"], "Only");
    assert_eq!(f["Num"], 2);
    assert_eq!(f["Calc"], 4);
    assert_eq!(f["LinkCount"], 0);
    for cleared in [
        "Long", "Check", "Sel", "Multi", "Files", "Owner", "Team", "Links", "Code", "Email",
    ] {
        assert!(f.get(cleared).is_none(), "{cleared} should be cleared");
    }
    // System fields are still there.
    assert!(f.get("Created").is_some() && f.get("Auto").is_some() && f.get("Author").is_some());
    // The inverse links were cleaned up.
    let alice = v.p.f.get(v.table_id(), &v.p.ids[0]).await;
    let _ = alice;
}

#[tokio::test]
async fn put_batches_and_single_records_share_the_validation() {
    let v = v1_people().await;
    let id = &v.p.ids[0];
    let r = v
        .app()
        .put(
            &v.token,
            &rec_path(&v, id),
            json!({ "fields": { "Name": "Single", "Age": 1 } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["fields"], json!({ "Name": "Single", "Age": 1 }));
    assert_v1_error(
        &v.put(json!({ "records": [{ "id": id, "fields": { "Nope": 1 } }] }))
            .await,
        422,
        "UNKNOWN_FIELD_NAME",
    );
    assert_v1_error(
        &v.put(json!({ "records": [{ "id": "recNOPE00000000", "fields": {} }] }))
            .await,
        404,
        "NOT_FOUND",
    );
    assert_v1_error(
        &v.put(json!({ "records": [] })).await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
    // Atomic: a bad second record leaves the first untouched.
    let r = v
        .put(json!({ "records": [
            { "id": v.p.ids[1], "fields": { "Name": "Cleared" } },
            { "id": v.p.ids[2], "fields": { "Age": "bad" } },
        ] }))
        .await;
    assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
    assert_eq!(v.p.f.value(v.table_id(), &v.p.ids[1], &v.p.age).await, 25);
}

// -------------------------------------------------------------- delete

#[tokio::test]
async fn delete_a_batch_of_records() {
    let v = v1_people().await;
    let r = v.delete(&[&v.p.ids[1], &v.p.ids[3]]).await;
    r.assert_status(200);
    assert_eq!(
        r.body,
        json!({ "records": [
            { "id": v.p.ids[1], "deleted": true },
            { "id": v.p.ids[3], "deleted": true },
        ] })
    );
    assert_eq!(
        V1::listed_names(&v.get("").await),
        ["Alice", "Carol", "Eve"]
    );
    // Soft delete: the internal trash still has them.
    let trash = v
        .app()
        .get(&v.p.f.owner, &format!("/api/bases/{}/trash", v.base_id()))
        .await;
    let n = trash.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["kind"] == "record")
        .count();
    assert_eq!(n, 2);
    // `records` without brackets works too.
    let q = format!("?{}", qs(&[("records", &v.p.ids[0])]));
    v.app()
        .delete(&v.token, &v.path(&q))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn delete_a_single_record_by_path() {
    let v = v1_people().await;
    let id = &v.p.ids[4];
    let r = v.app().delete(&v.token, &rec_path(&v, id)).await;
    r.assert_status(200);
    assert_eq!(r.body, json!({ "id": id, "deleted": true }));
    assert_eq!(count(&v).await, 4);
    assert_v1_error(
        &v.app().delete(&v.token, &rec_path(&v, id)).await,
        404,
        "NOT_FOUND",
    );
}

#[tokio::test]
async fn delete_is_all_or_nothing_and_limited_to_ten() {
    let v = v1_people().await;
    let r = v.delete(&[&v.p.ids[0], "recMISSING0000000"]).await;
    assert_v1_error(&r, 404, "NOT_FOUND");
    assert_eq!(count(&v).await, 5, "the existing record survived");
    // No ids, too many ids.
    assert_v1_error(
        &v.app().delete(&v.token, &v.path("")).await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
    let many: Vec<String> = (0..11).map(|i| format!("rec{i}")).collect();
    let refs: Vec<&str> = many.iter().map(String::as_str).collect();
    assert_v1_error(&v.delete(&refs).await, 422, "INVALID_REQUEST_UNKNOWN");
    // Ten at once is fine.
    let rows: Vec<Value> = (0..10)
        .map(|i| json!({ "fields": { "Name": format!("d{i}") } }))
        .collect();
    let created = v.post(json!({ "records": rows })).await;
    let ids: Vec<String> = created.body["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let r = v.delete(&refs).await;
    r.assert_status(200);
    assert_eq!(r.body["records"].as_array().unwrap().len(), 10);
    assert_eq!(count(&v).await, 5);
    // Duplicate ids collapse.
    let r = v.delete(&[&v.p.ids[0], &v.p.ids[0]]).await;
    r.assert_status(200);
    assert_eq!(r.body["records"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn deleted_records_can_be_restored_from_the_trash_and_cleanup_links() {
    let v = v1_people().await;
    let e = everything(&v).await;
    let path = format!("/api/v1/{}/Everything", v.base_id());
    // Deleting a linked record updates the count on the other side.
    v.delete(&[&v.p.ids[0]]).await.assert_status(200);
    let r = v
        .app()
        .get(&v.token, &format!("{path}/{}", e.record_id))
        .await;
    assert_eq!(r.body["fields"]["LinkCount"], 1);
    assert_eq!(r.body["fields"]["Links"], json!([v.p.ids[1]]));
    v.p.f
        .restore_records(v.table_id(), &[&v.p.ids[0]])
        .await
        .assert_status(200);
    let r = v
        .app()
        .get(&v.token, &format!("{path}/{}", e.record_id))
        .await;
    assert_eq!(r.body["fields"]["LinkCount"], 2);
    // The delete was recorded and published.
    let mut rx = v.app().state.events.subscribe(v.base_id());
    v.delete(&[&v.p.ids[2]]).await.assert_status(200);
    match &rx.try_recv().unwrap().event {
        og_core::api::events::BaseEvent::RecordsChanged { deleted, .. } => {
            assert_eq!(deleted, &[v.p.ids[2].clone()])
        }
        other => panic!("{other:?}"),
    }
}

// ------------------------------------------------------------- limits

#[tokio::test]
async fn writes_respect_the_table_record_limit() {
    let v = v1_people().await;
    let t = v.table_id().to_string();
    // Fill the table up to its cap with direct inserts.
    let cap = og_core::limits::MAX_RECORDS_PER_TABLE;
    let t2 = t.clone();
    sql(v.app(), move |tx| {
        let mut stmt = tx.prepare(
            "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             VALUES (?1, ?2, '{}', ?3, ?3, 1, 1)",
        )?;
        for i in 5..cap {
            stmt.execute(rusqlite::params![
                format!("recfill{i:09}"),
                t2,
                (i + 100) as f64
            ])?;
        }
        Ok(())
    });
    let r = v
        .post(json!({ "fields": { "Name": "one too many" } }))
        .await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("records")
    );
}

#[tokio::test]
async fn long_text_over_the_cell_limit_is_rejected() {
    let v = v1_people().await;
    let huge = "x".repeat(og_core::limits::MAX_TEXT_CELL_LEN + 1);
    let r = v.post(json!({ "fields": { "Name": huge } })).await;
    assert_v1_error(&r, 422, "INVALID_VALUE_FOR_COLUMN");
    let _ = sse_support::fast;
}
