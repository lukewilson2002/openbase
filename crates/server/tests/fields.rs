//! Fields: creation for every type, naming rules, option validation, update,
//! primary field, delete, role matrix.

mod common;
mod schema_support;

use og_core::field::{FieldKind, FieldType};
use opengrid::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn fields_url(table: &str) -> String {
    format!("/api/tables/{table}/fields")
}

fn type_tag(t: FieldType) -> String {
    serde_json::to_value(t)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn every_type_with_default_options_can_be_created() {
    let f = Fixture::new().await;
    let mut created = 0;
    for t in FieldType::ALL {
        if FieldKind::default_for(t).is_none() {
            continue; // link, formula, lookup, rollup, count, button need references
        }
        let name = format!("f-{}", type_tag(t));
        let r = f
            .app
            .post(
                &f.owner,
                &fields_url(&f.table_id),
                json!({ "name": name, "type": type_tag(t), "options": {} }),
            )
            .await;
        r.assert_status(201);
        assert_eq!(r.body["type"], type_tag(t).as_str());
        assert_eq!(r.body["table_id"], f.table_id.as_str());
        assert!(r.body["id"].as_str().unwrap().starts_with("fld"));
        created += 1;
    }
    assert_eq!(created, 22);
    let t = f.table(&f.table_id).await;
    assert_eq!(t["fields"].as_array().unwrap().len(), 2 + created);
}

#[tokio::test]
async fn created_fields_are_appended_and_options_default() {
    let f = Fixture::new().await;
    let a = f
        .add_field(
            &f.table_id,
            json!({ "name": "Amount", "type": "currency", "options": {} }),
        )
        .await;
    assert_eq!(a["options"]["symbol"], "$");
    assert_eq!(a["options"]["precision"], 2);
    let b = f
        .add_field(
            &f.table_id,
            json!({ "name": "Stars", "type": "rating", "options": { "max": 10 } }),
        )
        .await;
    assert_eq!(b["options"]["max"], 10);
    assert_eq!(b["options"]["icon"], "star");
    let t = f.table(&f.table_id).await;
    assert_eq!(
        Fixture::field_names(&t),
        ["Name", "Notes", "Amount", "Stars"]
    );
    // description is stored trimmed
    let c = f.add_field(&f.table_id, json!({ "name": "Done", "type": "checkbox", "options": {}, "description": "  is it done  " })).await;
    assert_eq!(c["description"], "is it done");
}

#[tokio::test]
async fn field_names_are_validated_and_unique_ignoring_case() {
    let f = Fixture::new().await;
    let url = fields_url(&f.table_id);
    for bad in ["", "   ", "new\nline"] {
        f.app
            .post(
                &f.owner,
                &url,
                json!({ "name": bad, "type": "number", "options": {} }),
            )
            .await
            .assert_status(400);
    }
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "name": "n".repeat(256), "type": "number", "options": {} }),
        )
        .await
        .assert_status(400);
    let ok = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "name": "  Total  ", "type": "number", "options": {} }),
        )
        .await;
    ok.assert_status(201);
    assert_eq!(ok.body["name"], "Total");
    for dup in ["total", "TOTAL ", "name"] {
        let r = f
            .app
            .post(
                &f.owner,
                &url,
                json!({ "name": dup, "type": "number", "options": {} }),
            )
            .await;
        r.assert_status(409);
        assert_eq!(r.body["error"]["code"], "conflict");
    }
    // another table may reuse the name; a deleted field frees its name
    let t2 = f.add_table("Other").await;
    f.add_field(
        t2["id"].as_str().unwrap(),
        json!({ "name": "Total", "type": "number", "options": {} }),
    )
    .await;
    f.app
        .delete(
            &f.owner,
            &format!("/api/fields/{}", ok.body["id"].as_str().unwrap()),
        )
        .await
        .assert_status(200);
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Total", "type": "text", "options": {} }),
        )
        .await
        .assert_status(400);
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Total", "type": "number", "options": {} }),
        )
        .await
        .assert_status(201);
}

#[tokio::test]
async fn malformed_field_bodies_are_400_in_the_standard_format() {
    let f = Fixture::new().await;
    let url = fields_url(&f.table_id);
    for body in [
        json!({ "name": "x" }),
        json!({ "name": "x", "type": "teleporter", "options": {} }),
        json!({ "name": "x", "type": "number", "options": { "precision": "lots" } }),
        json!({ "name": "x", "type": "link" }),
        json!([1, 2]),
    ] {
        let r = f.app.post(&f.owner, &url, body).await;
        r.assert_status(400);
        assert_eq!(r.body["error"]["code"], "bad_request");
    }
}

#[tokio::test]
async fn fields_per_table_are_limited() {
    let f = Fixture::new().await;
    let table = f.table_id.clone();
    sql(&f.app, |tx| {
        for i in 0..(og_core::limits::MAX_FIELDS_PER_TABLE - 2) {
            tx.execute(
                "INSERT INTO fields (id, table_id, name, type, options, position, created_at)
                 VALUES (?1, ?2, ?3, 'number', '{}', ?4, 1)",
                rusqlite::params![
                    format!("fldfill{i}"),
                    table,
                    format!("Filler {i}"),
                    10.0 + i as f64
                ],
            )?;
        }
        Ok(())
    });
    let r = f
        .app
        .post(
            &f.owner,
            &fields_url(&f.table_id),
            json!({ "name": "One too many", "type": "number", "options": {} }),
        )
        .await;
    r.assert_status(400);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("500"));
}

#[tokio::test]
async fn option_validation() {
    let f = Fixture::new().await;
    let url = fields_url(&f.table_id);
    let cases = [
        (
            json!({ "type": "number", "options": { "precision": 9 } }),
            400,
        ),
        (
            json!({ "type": "number", "options": { "precision": 8 } }),
            201,
        ),
        (
            json!({ "type": "percent", "options": { "precision": 9 } }),
            400,
        ),
        (
            json!({ "type": "currency", "options": { "precision": 12 } }),
            400,
        ),
        (
            json!({ "type": "currency", "options": { "symbol": "ABCDEFGHIJKLMN" } }),
            400,
        ),
        (json!({ "type": "rating", "options": { "max": 0 } }), 400),
        (json!({ "type": "rating", "options": { "max": 11 } }), 400),
        (json!({ "type": "rating", "options": { "max": 1 } }), 201),
        (
            json!({ "type": "rating", "options": { "color": "mauve" } }),
            400,
        ),
        (
            json!({ "type": "checkbox", "options": { "color": "mauve" } }),
            400,
        ),
        (
            json!({ "type": "date", "options": { "timezone": "Mars/Olympus" } }),
            400,
        ),
        (
            json!({ "type": "date", "options": { "timezone": "Europe/Berlin", "include_time": true } }),
            201,
        ),
        (
            json!({ "type": "created_time", "options": { "timezone": "Nowhere/Land" } }),
            400,
        ),
        (
            json!({ "type": "last_modified_time", "options": { "date": { "timezone": "Nowhere/Land" } } }),
            400,
        ),
        (
            json!({ "type": "last_modified_time", "options": { "fields": ["fldNOPE"] } }),
            400,
        ),
        (
            json!({ "type": "single_line_text", "options": { "default": "x" } }),
            201,
        ),
    ];
    for (i, (mut body, status)) in cases.into_iter().enumerate() {
        body["name"] = json!(format!("case {i}"));
        let r = f.app.post(&f.owner, &url, body.clone()).await;
        assert_eq!(r.status.as_u16(), status, "case {i}: {body}");
    }
}

#[tokio::test]
async fn last_modified_can_watch_editable_fields_of_the_table_only() {
    let f = Fixture::new().await;
    let url = fields_url(&f.table_id);
    let ok = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Edited", "type": "last_modified_time", "options": { "fields": [f.notes_id, f.notes_id] } }),
        )
        .await;
    ok.assert_status(201);
    assert_eq!(
        ok.body["options"]["fields"],
        json!([f.notes_id]),
        "duplicates removed"
    );
    let computed = f
        .add_field(
            &f.table_id,
            json!({ "name": "Auto", "type": "autonumber", "options": {} }),
        )
        .await;
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Bad", "type": "last_modified_by", "options": { "fields": [computed["id"]] } }),
        )
        .await
        .assert_status(400);
    let t2 = f.add_table("Other").await;
    f.app
        .post(
            &f.owner,
            &fields_url(t2["id"].as_str().unwrap()),
            json!({ "name": "Bad", "type": "last_modified_time", "options": { "fields": [f.notes_id] } }),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn select_choices_get_ids_colours_and_are_validated() {
    let f = Fixture::new().await;
    let url = fields_url(&f.table_id);
    let r = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Status", "type": "single_select",
                    "options": { "choices": [ { "name": "Todo" }, { "id": "", "name": " Doing ", "color": "orange" }, { "name": "Done", "color": "green" } ] } }),
        )
        .await;
    r.assert_status(201);
    let choices = r.body["options"]["choices"].as_array().unwrap();
    assert_eq!(choices.len(), 3);
    let ids: std::collections::HashSet<&str> =
        choices.iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 3);
    assert!(
        choices
            .iter()
            .all(|c| c["id"].as_str().unwrap().starts_with("sel"))
    );
    assert_eq!(choices[1]["name"], "Doing");
    assert_eq!(choices[1]["color"], "orange");
    assert!(og_core::field::COLORS.contains(&choices[0]["color"].as_str().unwrap()));

    let bad = [
        json!([{ "name": "A" }, { "name": "a" }]),
        json!([{ "name": "A", "color": "plaid" }]),
        json!([{ "name": "" }]),
        json!([{ "id": "same", "name": "A" }, { "id": "same", "name": "B" }]),
        json!([{ "id": "bad id!", "name": "A" }]),
    ];
    for (i, choices) in bad.into_iter().enumerate() {
        f.app
            .post(&f.owner, &url, json!({ "name": format!("bad{i}"), "type": "multiple_select", "options": { "choices": choices } }))
            .await
            .assert_status(400);
    }
    let many: Vec<Value> = (0..1001)
        .map(|i| json!({ "name": format!("c{i}") }))
        .collect();
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "name": "many", "type": "single_select", "options": { "choices": many } }),
        )
        .await
        .assert_status(400);
    let many: Vec<Value> = (0..1000)
        .map(|i| json!({ "name": format!("c{i}") }))
        .collect();
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "name": "many", "type": "single_select", "options": { "choices": many } }),
        )
        .await
        .assert_status(201);
}

#[tokio::test]
async fn update_renames_describes_and_reorders() {
    let f = Fixture::new().await;
    let a = f
        .add_field(
            &f.table_id,
            json!({ "name": "A", "type": "number", "options": {} }),
        )
        .await;
    let b = f
        .add_field(
            &f.table_id,
            json!({ "name": "B", "type": "number", "options": {} }),
        )
        .await;
    let (aid, bid) = (a["id"].as_str().unwrap(), b["id"].as_str().unwrap());

    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{aid}"),
            json!({ "name": " Alpha ", "description": "first", "position": 99.5 }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["name"], "Alpha");
    assert_eq!(r.body["description"], "first");
    assert_eq!(r.body["type"], "number", "type is untouched");
    let t = f.table(&f.table_id).await;
    assert_eq!(Fixture::field_names(&t), ["Name", "Notes", "B", "Alpha"]);

    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{aid}"),
            json!({ "description": "" }),
        )
        .await;
    assert!(r.body.get("description").is_none() || r.body["description"].is_null());
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{aid}"),
            json!({ "name": "b" }),
        )
        .await
        .assert_status(409);
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{aid}"),
            json!({ "name": "ALPHA" }),
        )
        .await
        .assert_status(200);
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{aid}"),
            json!({ "name": "" }),
        )
        .await
        .assert_status(400);
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{aid}"),
            json!({ "position": "front" }),
        )
        .await
        .assert_status(400);
    f.app
        .patch(&f.owner, "/api/fields/fldNOPE", json!({ "name": "x" }))
        .await
        .assert_status(404);
    let _ = bid;
}

#[tokio::test]
async fn update_with_bad_options_is_an_error_not_a_silent_no_op() {
    let f = Fixture::new().await;
    let a = f
        .add_field(
            &f.table_id,
            json!({ "name": "A", "type": "number", "options": { "precision": 2 } }),
        )
        .await;
    let path = format!("/api/fields/{}", a["id"].as_str().unwrap());
    f.app
        .patch(
            &f.owner,
            &path,
            json!({ "type": "number", "options": { "precision": "x" } }),
        )
        .await
        .assert_status(400);
    f.app
        .patch(
            &f.owner,
            &path,
            json!({ "type": "number", "options": { "precision": 20 } }),
        )
        .await
        .assert_status(400);
    f.app
        .patch(&f.owner, &path, json!({ "type": "nonsense" }))
        .await
        .assert_status(400);
    let r = f
        .app
        .patch(
            &f.owner,
            &path,
            json!({ "type": "number", "options": { "precision": 4 } }),
        )
        .await;
    r.assert_status(200);
    assert_eq!(r.body["options"]["precision"], 4);
}

#[tokio::test]
async fn role_matrix_for_field_endpoints() {
    for role in ALL_ROLES {
        let f = Fixture::new().await;
        let u = f.base_guest("g@example.com", role);
        let ok = role >= Role::Creator;
        let r = f
            .app
            .post(
                &u,
                &fields_url(&f.table_id),
                json!({ "name": "X", "type": "number", "options": {} }),
            )
            .await;
        assert_eq!(
            r.status.as_u16(),
            if ok { 201 } else { 403 },
            "create {role:?}"
        );
        let existing = f
            .add_field(
                &f.table_id,
                json!({ "name": "Y", "type": "number", "options": {} }),
            )
            .await;
        let id = existing["id"].as_str().unwrap();
        let r = f
            .app
            .patch(&u, &format!("/api/fields/{id}"), json!({ "name": "Z" }))
            .await;
        assert_eq!(
            r.status.as_u16(),
            if ok { 200 } else { 403 },
            "patch {role:?}"
        );
        let r = f
            .app
            .post(
                &u,
                &format!("/api/tables/{}/primary-field", f.table_id),
                json!({ "field_id": f.primary_id }),
            )
            .await;
        assert_eq!(
            r.status.as_u16(),
            if ok { 200 } else { 403 },
            "primary {role:?}"
        );
        let r = f.app.delete(&u, &format!("/api/fields/{id}")).await;
        assert_eq!(
            r.status.as_u16(),
            if ok { 200 } else { 403 },
            "delete {role:?}"
        );
    }
    let f = Fixture::new().await;
    let outsider = f.app.user("o@example.com", "O");
    f.app
        .post(
            &outsider,
            &fields_url(&f.table_id),
            json!({ "name": "X", "type": "number", "options": {} }),
        )
        .await
        .assert_status(404);
    f.app
        .patch(
            &outsider,
            &format!("/api/fields/{}", f.notes_id),
            json!({ "name": "X" }),
        )
        .await
        .assert_status(404);
    f.app
        .delete(&outsider, &format!("/api/fields/{}", f.notes_id))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn read_only_tokens_cannot_change_schema() {
    let f = Fixture::new().await;
    let read = token_client(&f.app, &f.owner, false);
    let write = token_client(&f.app, &f.owner, true);
    let body = json!({ "name": "X", "type": "number", "options": {} });
    f.app
        .post(&read, &fields_url(&f.table_id), body.clone())
        .await
        .assert_status(403);
    f.app
        .post(&write, &fields_url(&f.table_id), body)
        .await
        .assert_status(201);
}

#[tokio::test]
async fn primary_field_rules() {
    let f = Fixture::new().await;
    let notes = f.notes_id.clone();
    let link_target = f.add_table("Other").await;
    let link = f
        .add_link(&f.table_id, "Rel", link_target["id"].as_str().unwrap())
        .await;
    let check = f
        .add_field(
            &f.table_id,
            json!({ "name": "Done", "type": "checkbox", "options": {} }),
        )
        .await;
    let att = f
        .add_field(
            &f.table_id,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let url = format!("/api/tables/{}/primary-field", f.table_id);

    // the primary field cannot be deleted
    let r = f
        .app
        .delete(&f.owner, &format!("/api/fields/{}", f.primary_id))
        .await;
    r.assert_status(409);

    // ineligible types cannot become primary
    for bad in [&link["id"], &check["id"], &att["id"]] {
        f.app
            .post(&f.owner, &url, json!({ "field_id": bad }))
            .await
            .assert_status(400);
    }
    // unknown field, field of another table
    f.app
        .post(&f.owner, &url, json!({ "field_id": "fldNOPE" }))
        .await
        .assert_status(404);
    let other_primary = link_target["primary_field_id"].as_str().unwrap();
    f.app
        .post(&f.owner, &url, json!({ "field_id": other_primary }))
        .await
        .assert_status(404);

    // a long-text field is eligible and moves to the front
    let r = f
        .app
        .post(&f.owner, &url, json!({ "field_id": notes }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["primary_field_id"], notes.as_str());
    assert_eq!(r.body["fields"][0]["id"], notes.as_str());
    // idempotent
    f.app
        .post(&f.owner, &url, json!({ "field_id": notes }))
        .await
        .assert_status(200);
    // the old primary can be deleted now, the new one cannot
    f.app
        .delete(&f.owner, &format!("/api/fields/{notes}"))
        .await
        .assert_status(409);
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", f.primary_id))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn the_primary_field_cannot_change_to_an_ineligible_type() {
    let f = Fixture::new().await;
    let path = format!("/api/fields/{}", f.primary_id);
    let other = f.add_table("Other").await;
    for body in [
        json!({ "type": "checkbox", "options": {} }),
        json!({ "type": "attachment", "options": {} }),
        json!({ "type": "multiple_select", "options": {} }),
        json!({ "type": "rating", "options": {} }),
        json!({ "type": "link", "options": { "linked_table_id": other["id"] } }),
    ] {
        f.app
            .patch(&f.owner, &path, body.clone())
            .await
            .assert_status(400);
    }
    f.app
        .patch(&f.owner, &path, json!({ "type": "email", "options": {} }))
        .await
        .assert_status(200);
    f.app
        .patch(&f.owner, &path, json!({ "type": "number", "options": {} }))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn deleting_a_field_hides_it_and_frees_its_name() {
    let f = Fixture::new().await;
    let a = f
        .add_field(
            &f.table_id,
            json!({ "name": "Temp", "type": "number", "options": {} }),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let r = f.app.delete(&f.owner, &format!("/api/fields/{id}")).await;
    r.assert_status(200);
    assert_eq!(r.body["deleted_field_ids"], json!([id]));
    assert_eq!(
        Fixture::field_names(&f.table(&f.table_id).await),
        ["Name", "Notes"]
    );
    f.app
        .delete(&f.owner, &format!("/api/fields/{id}"))
        .await
        .assert_status(404);
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{id}"),
            json!({ "name": "x" }),
        )
        .await
        .assert_status(404);
    f.add_field(
        &f.table_id,
        json!({ "name": "Temp", "type": "number", "options": {} }),
    )
    .await;
}

#[tokio::test]
async fn deleting_a_field_keeps_its_data_for_restore_and_does_not_touch_other_fields() {
    let f = Fixture::new().await;
    let a = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let aid = a["id"].as_str().unwrap().to_string();
    let rec = f.insert_record(&f.table_id, json!({ &f.primary_id: "row", &aid: 5 }));
    f.app
        .delete(&f.owner, &format!("/api/fields/{aid}"))
        .await
        .assert_status(200);
    assert_eq!(
        f.record_data(&rec),
        json!({ &f.primary_id: "row", &aid: 5 })
    );
}

#[tokio::test]
async fn field_changes_publish_schema_events() {
    let f = Fixture::new().await;
    let mut rx = f.app.state.events.subscribe(&f.base_id);
    let a = f
        .add_field(
            &f.table_id,
            json!({ "name": "A", "type": "number", "options": {} }),
        )
        .await;
    let env = rx.try_recv().unwrap();
    assert_eq!(
        env.event,
        og_core::api::events::BaseEvent::SchemaChanged {
            table_id: Some(f.table_id.clone())
        }
    );
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", a["id"].as_str().unwrap()),
            json!({ "name": "B" }),
        )
        .await
        .assert_status(200);
    assert!(rx.try_recv().is_ok());
    f.app
        .delete(
            &f.owner,
            &format!("/api/fields/{}", a["id"].as_str().unwrap()),
        )
        .await
        .assert_status(200);
    assert!(rx.try_recv().is_ok());
    // a rejected request publishes nothing
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", f.primary_id))
        .await
        .assert_status(409);
    assert!(rx.try_recv().is_err());
}
