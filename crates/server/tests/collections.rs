//! Collection settings of the UX overhaul (BE-2, BE-4, BE-5): a table's colour, page, record name,
//! Home date and Done property, the richer listings, the guards that clear a setting when its
//! property goes, the page write that adds "Page", and the workspace's top-level project.

mod common;
mod schema_support;

use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn table_url(id: &str) -> String {
    format!("/api/tables/{id}")
}

async fn patch_table(f: &Fixture, id: &str, body: Value) -> common::Response {
    f.app.patch(&f.owner, &table_url(id), body).await
}

async fn add_date(f: &Fixture, table: &str, name: &str) -> String {
    f.add_field(
        table,
        json!({ "name": name, "type": "date", "options": {"include_time": false, "time_zone": "utc"} }),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn add_checkbox(f: &Fixture, table: &str, name: &str) -> String {
    f.add_field(
        table,
        json!({ "name": name, "type": "checkbox", "options": {} }),
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn ids(v: &Value) -> Vec<&str> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect()
}

// ------------------------------------------------------------------------------ BE-2: colours

#[tokio::test]
async fn a_table_takes_a_colour_when_created_and_when_updated() {
    let f = Fixture::new().await;
    let url = format!("/api/bases/{}/tables", f.base_id);
    let r = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "name": "Clients", "color": "teal" }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["color"], "teal");
    // The answer already names the page the table starts with.
    let page = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "Page")
        .unwrap();
    assert_eq!(r.body["body_field_id"], page["id"]);
    assert_eq!(r.body["record_count"], 0);

    // Without a colour the table takes the next of the cycle, which an update can change.
    let r = f.app.post(&f.owner, &url, json!({ "name": "Plain" })).await;
    r.assert_status(201);
    let first = r.body["color"].as_str().unwrap().to_string();
    assert!(ob_core::field::COLORS.contains(&first.as_str()));
    let id = r.body["id"].as_str().unwrap();
    let r = patch_table(&f, id, json!({ "color": "pink" })).await;
    r.assert_status(200);
    assert_eq!(r.body["color"], "pink");
    assert_eq!(f.table(id).await["color"], "pink");

    // A colour that is not in the palette is refused, on create and on update.
    f.app
        .post(&f.owner, &url, json!({ "name": "Bad", "color": "mauve" }))
        .await
        .assert_status(400);
    let r = patch_table(&f, id, json!({ "color": "mauve" })).await;
    r.assert_status(400);
    assert_eq!(f.table(id).await["color"], "pink");
}

#[tokio::test]
async fn the_icon_is_still_accepted_and_returned_next_to_the_colour() {
    let f = Fixture::new().await;
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{}/tables", f.base_id),
            json!({ "name": "Old school", "icon": "map", "color": "red" }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(r.body["icon"], "map");
    assert_eq!(r.body["color"], "red");
    let id = r.body["id"].as_str().unwrap();
    let r = patch_table(&f, id, json!({ "icon": "users" })).await;
    r.assert_status(200);
    assert_eq!(r.body["icon"], "users");
    assert_eq!(r.body["color"], "red", "the icon does not touch the colour");
    let r = patch_table(&f, id, json!({ "icon": null, "color": "gray" })).await;
    assert!(r.body["icon"].is_null());
    assert_eq!(r.body["color"], "gray");
}

// ------------------------------------------------------------------------------ BE-4: listings

#[tokio::test]
async fn table_listings_carry_the_collection_settings_and_live_record_counts() {
    let f = Fixture::new().await;
    let empty = f.add_table("Empty").await;
    let recs = format!("/api/tables/{}/records", f.table_id);
    let made = f
        .app
        .post(
            &f.owner,
            &recs,
            json!({ "records": [
                {"values": {f.primary_id.clone(): "a"}},
                {"values": {f.primary_id.clone(): "b"}},
                {"values": {f.primary_id.clone(): "c"}},
            ]}),
        )
        .await;
    made.assert_status(201);
    let gone = made.body["records"][2]["id"].as_str().unwrap().to_string();
    f.app
        .request(&f.owner, "DELETE", &recs, Some(json!({ "ids": [gone] })))
        .await
        .assert_status(204);

    let s = f.schema().await;
    assert_eq!(
        s["is_top_level"], true,
        "the fixture's base is the top level"
    );
    let t = f.table(&f.table_id).await;
    assert_eq!(t["record_count"], 2, "trashed records are not counted");
    assert_eq!(t["body_field_id"], f.page_id.as_str());
    assert_eq!(t["record_noun"], "");
    assert!(t["home_date_field_id"].is_null() && t["done_field_id"].is_null());
    assert!(ob_core::field::COLORS.contains(&t["color"].as_str().unwrap()));
    let e = f.table(empty["id"].as_str().unwrap()).await;
    assert_eq!(e["record_count"], 0, "a table without records counts 0");
    assert_ne!(e["color"], t["color"], "neighbours take different colours");

    // The workspace list says the same about every table, and names the top level.
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    list.assert_status(200);
    let ws = &list.body[0];
    assert_eq!(ws["root_base_id"], f.base_id.as_str());
    let b = &ws["bases"][0];
    assert_eq!(b["is_top_level"], true);
    let summary = b["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == f.table_id.as_str())
        .unwrap();
    assert_eq!(summary["record_count"], 2);
    assert_eq!(summary["color"], t["color"]);
    assert_eq!(summary["body_field_id"], f.page_id.as_str());
    assert_eq!(summary["record_noun"], "");
    assert!(summary["home_date_field_id"].is_null() && summary["done_field_id"].is_null());
}

#[tokio::test]
async fn record_counts_come_from_one_grouped_query_per_project_or_workspace() {
    let f = Fixture::new().await;
    let other = f.add_table("Second").await;
    let other_id = other["id"].as_str().unwrap().to_string();
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{other_id}/records"),
            json!({ "records": [{"values": {}}, {"values": {}}] }),
        )
        .await
        .assert_status(201);
    let (base, ws) = (f.base_id.clone(), f.ws.clone());
    let (by_base, by_ws) = sql(&f.app, |tx| {
        Ok((
            openbase::store::schema::record_counts_in_base(tx, &base).unwrap(),
            openbase::store::schema::record_counts_in_workspace(tx, &ws).unwrap(),
        ))
    });
    assert_eq!(by_base.len(), 2, "every live table has an entry");
    assert_eq!(by_base[&f.table_id], 0);
    assert_eq!(by_base[&other_id], 2);
    assert_eq!(by_base, by_ws);
}

#[tokio::test]
async fn a_second_project_is_not_the_top_level() {
    let f = Fixture::new().await;
    let side = base(&f.app, &f.owner, &f.ws, "Side").await;
    assert_eq!(side["is_top_level"], false);
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    let bases = list.body[0]["bases"].as_array().unwrap();
    let flags: Vec<(&str, bool)> = bases
        .iter()
        .map(|b| {
            (
                b["name"].as_str().unwrap(),
                b["is_top_level"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(flags, [("CRM", true), ("Side", false)]);
}

#[tokio::test]
async fn a_limited_member_is_not_told_the_id_of_a_top_level_they_cannot_open() {
    let f = Fixture::new().await;
    let side = base(&f.app, &f.owner, &f.ws, "Side").await;
    let side_id = side["id"].as_str().unwrap();
    let guest = f.app.user("guest@example.com", "Guest");
    add_base_member(&f.app, side_id, &guest, Role::Editor);
    let list = f.app.get(&guest, "/api/workspaces").await;
    list.assert_status(200);
    let ws = &list.body[0];
    assert_eq!(ids(&ws["bases"]), [side_id]);
    assert!(ws["root_base_id"].is_null());
    assert_eq!(ws["bases"][0]["is_top_level"], false);
}

// ----------------------------------------------------------------- BE-5: table settings (PATCH)

#[tokio::test]
async fn description_and_record_name_are_set_and_validated() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let r = patch_table(
        &f,
        id,
        json!({ "description": "Who we work for", "record_noun": "  client " }),
    )
    .await;
    r.assert_status(200);
    assert_eq!(r.body["description"], "Who we work for");
    assert_eq!(r.body["record_noun"], "client", "trimmed");

    for bad in ["x".repeat(41), "a\nb".to_string()] {
        patch_table(&f, id, json!({ "record_noun": bad }))
            .await
            .assert_status(400);
    }
    assert_eq!(f.table(id).await["record_noun"], "client");
    let r = patch_table(&f, id, json!({ "record_noun": "x".repeat(40) })).await;
    r.assert_status(200);

    // Empty goes back to "record".
    let r = patch_table(&f, id, json!({ "record_noun": "   " })).await;
    assert_eq!(r.body["record_noun"], "");
}

#[tokio::test]
async fn the_home_date_must_be_a_date_like_property_of_the_table() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let due = add_date(&f, id, "Due").await;
    let created = f
        .add_field(
            id,
            json!({"name": "Made", "type": "created_time", "options": {}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let modified = f
        .add_field(
            id,
            json!({"name": "Touched", "type": "last_modified_time", "options": {"fields": []}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let soon = f
        .add_field(
            id,
            json!({"name": "Soon", "type": "formula", "options": {"expression": "TODAY()"}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let shout = f
        .add_field(
            id,
            json!({"name": "Shout", "type": "formula", "options": {"expression": "UPPER({Name})"}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let other = f.add_table("Other").await;
    let other_date = add_date(&f, other["id"].as_str().unwrap(), "Elsewhere").await;

    for ok in [&due, &created, &modified, &soon] {
        let r = patch_table(&f, id, json!({ "home_date_field_id": ok })).await;
        r.assert_status(200);
        assert_eq!(r.body["home_date_field_id"], ok.as_str());
    }
    // Text, a formula that is not a date, a field that does not exist and another table's date.
    for (bad, why) in [
        (f.notes_id.as_str(), "rich text"),
        (f.primary_id.as_str(), "text"),
        (shout.as_str(), "text formula"),
        ("fldNope", "unknown"),
        (other_date.as_str(), "other table"),
    ] {
        let r = patch_table(&f, id, json!({ "home_date_field_id": bad })).await;
        r.assert_status(400);
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Home date"),
            "{why}: {}",
            r.body
        );
    }
    assert_eq!(f.table(id).await["home_date_field_id"], soon.as_str());

    // null removes it, and leaving it out keeps it.
    patch_table(&f, id, json!({ "color": "red" })).await;
    assert_eq!(f.table(id).await["home_date_field_id"], soon.as_str());
    let r = patch_table(&f, id, json!({ "home_date_field_id": null })).await;
    r.assert_status(200);
    assert!(r.body["home_date_field_id"].is_null());
}

#[tokio::test]
async fn done_must_be_a_checkbox_property_of_the_table() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let done = add_checkbox(&f, id, "Done").await;
    let other = f.add_table("Other").await;
    let other_box = add_checkbox(&f, other["id"].as_str().unwrap(), "Done").await;
    let n = f
        .add_field(
            id,
            json!({"name": "N", "type": "number", "options": {"precision": 0}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();

    let r = patch_table(&f, id, json!({ "done_field_id": done })).await;
    r.assert_status(200);
    assert_eq!(r.body["done_field_id"], done.as_str());
    for bad in [
        n.as_str(),
        f.primary_id.as_str(),
        "fldNope",
        other_box.as_str(),
    ] {
        let r = patch_table(&f, id, json!({ "done_field_id": bad })).await;
        r.assert_status(400);
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Done"),
            "{}",
            r.body
        );
    }
    assert_eq!(f.table(id).await["done_field_id"], done.as_str());
    let r = patch_table(&f, id, json!({ "done_field_id": null })).await;
    assert!(r.body["done_field_id"].is_null());
}

#[tokio::test]
async fn a_bad_setting_changes_nothing_of_the_same_request() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let before = f.table(id).await;
    let r = patch_table(
        &f,
        id,
        json!({ "name": "Renamed", "color": "pink", "record_noun": "client", "done_field_id": f.primary_id }),
    )
    .await;
    r.assert_status(400);
    let after = f.table(id).await;
    assert_eq!(after["name"], before["name"]);
    assert_eq!(after["color"], before["color"]);
    assert_eq!(after["record_noun"], "");
}

#[tokio::test]
async fn only_creators_change_the_settings_of_a_table() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    for (email, role, status) in [
        ("v@example.com", Role::Viewer, 403),
        ("c@example.com", Role::Commenter, 403),
        ("e@example.com", Role::Editor, 403),
        ("cr@example.com", Role::Creator, 200),
    ] {
        let who = f.member(email, role);
        let r = f
            .app
            .patch(&who, &table_url(id), json!({ "record_noun": "client" }))
            .await;
        r.assert_status(status);
        let r = f
            .app
            .post(
                &who,
                &format!("/api/tables/{id}/body-field"),
                json!({ "field_id": null }),
            )
            .await;
        r.assert_status(status);
    }
}

// --------------------------------------------------------------- BE-5: the body-field endpoint

#[tokio::test]
async fn the_page_can_be_another_rich_text_property_or_none() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let url = format!("/api/tables/{id}/body-field");
    assert_eq!(f.table(id).await["body_field_id"], f.page_id.as_str());

    let r = f
        .app
        .post(&f.owner, &url, json!({ "field_id": f.notes_id }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["body_field_id"], f.notes_id.as_str());
    assert_eq!(r.body["id"], id, "it answers the table, like primary-field");
    assert_eq!(f.table(id).await["body_field_id"], f.notes_id.as_str());

    let r = f
        .app
        .post(&f.owner, &url, json!({ "field_id": null }))
        .await;
    r.assert_status(200);
    assert!(r.body["body_field_id"].is_null());
    assert!(f.table(id).await["body_field_id"].is_null());
}

#[tokio::test]
async fn a_body_that_names_no_field_id_is_refused_instead_of_clearing_the_page() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let url = format!("/api/tables/{id}/body-field");
    // A misspelled key, an empty body and an unknown key beside a valid one each leave the
    // page where it was.
    for body in [
        json!({}),
        json!({ "field": f.notes_id }),
        json!({ "fieldId": f.notes_id }),
        json!({ "field_id": f.notes_id, "extra": true }),
        json!({ "create": false }),
    ] {
        let r = f.app.post(&f.owner, &url, body.clone()).await;
        r.assert_status(400);
        assert_eq!(
            f.table(id).await["body_field_id"],
            f.page_id.as_str(),
            "{body}"
        );
    }
    // null is still the explicit way to clear it, and create may carry a null field_id.
    f.app
        .post(&f.owner, &url, json!({ "field_id": null }))
        .await
        .assert_status(200);
    assert!(f.table(id).await["body_field_id"].is_null());
    f.app
        .post(&f.owner, &url, json!({ "field_id": null, "create": true }))
        .await
        .assert_status(200);
    assert!(!f.table(id).await["body_field_id"].is_null());
}

#[tokio::test]
async fn a_view_created_with_a_config_hides_the_page_unless_the_config_names_it() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let url = format!("/api/tables/{id}/views");
    let hidden = |v: &Value| -> Vec<Value> {
        v["config"]["hidden_fields"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let make = |config: Value| {
        let (f, url) = (&f, &url);
        async move {
            let r = f
                .app
                .post(
                    &f.owner,
                    url,
                    json!({ "name": "V", "type": "grid", "config": config }),
                )
                .await;
            r.assert_status(201);
            r.body.clone()
        }
    };

    // Any config at all, such as a sort.
    let v = make(json!({ "sorts": [{ "field_id": f.primary_id, "direction": "asc" }] })).await;
    assert_eq!(hidden(&v), vec![json!(f.page_id)]);
    // Other hidden fields keep their place, and the page is not listed twice.
    let v = make(json!({ "hidden_fields": [f.notes_id] })).await;
    assert_eq!(hidden(&v), vec![json!(f.notes_id), json!(f.page_id)]);
    let v = make(json!({ "hidden_fields": [f.page_id] })).await;
    assert_eq!(hidden(&v), vec![json!(f.page_id)]);
    // A config that places the page in the field order shows it on purpose.
    let v = make(json!({ "field_order": [f.page_id] })).await;
    assert!(hidden(&v).is_empty());
}

#[tokio::test]
async fn the_page_must_be_a_rich_text_property_of_the_table_other_than_its_title() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let url = format!("/api/tables/{id}/body-field");
    let plain = f
        .add_field(
            id,
            json!({"name": "Code", "type": "text", "options": {"multiline": true}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let other = f.add_table("Other").await;
    let other_rich = other["fields"][1]["id"].as_str().unwrap().to_string();

    let r = f
        .app
        .post(&f.owner, &url, json!({ "field_id": plain }))
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("rich text")
    );
    f.app
        .post(&f.owner, &url, json!({ "field_id": other_rich }))
        .await
        .assert_status(404);
    f.app
        .post(&f.owner, &url, json!({ "field_id": "fldNope" }))
        .await
        .assert_status(404);
    f.app
        .post(
            &f.owner,
            "/api/tables/tblNope/body-field",
            json!({ "field_id": null }),
        )
        .await
        .assert_status(404);

    // A rich text title cannot also be the page.
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", f.primary_id),
            json!({"type": "rich_text", "options": {}}),
        )
        .await
        .assert_status(200);
    let r = f
        .app
        .post(&f.owner, &url, json!({ "field_id": f.primary_id }))
        .await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("title")
    );
    assert_eq!(f.table(id).await["body_field_id"], f.page_id.as_str());
}

#[tokio::test]
async fn create_adds_a_hidden_page_only_when_there_is_none() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let url = format!("/api/tables/{id}/body-field");

    // It has one: nothing is added.
    let r = f.app.post(&f.owner, &url, json!({ "create": true })).await;
    r.assert_status(200);
    assert_eq!(r.body["body_field_id"], f.page_id.as_str());
    assert_eq!(r.body["fields"].as_array().unwrap().len(), 3);

    f.app
        .post(&f.owner, &url, json!({ "field_id": null }))
        .await;
    let r = f.app.post(&f.owner, &url, json!({ "create": true })).await;
    r.assert_status(200);
    let page = r.body["body_field_id"].as_str().unwrap();
    assert_ne!(
        page, f.page_id,
        "a new property, as the old Page still exists"
    );
    let made = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == page)
        .unwrap();
    assert_eq!(made["name"], "Page 2");
    assert_eq!(made["type"], "rich_text");
    for v in r.body["views"].as_array().unwrap() {
        assert!(
            v["config"]["hidden_fields"]
                .as_array()
                .unwrap()
                .contains(&json!(page)),
            "hidden in {}",
            v["name"]
        );
    }

    // Not both a field and create.
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "create": true, "field_id": f.notes_id }),
        )
        .await
        .assert_status(400);
}

// ------------------------------------------------------------------------- BE-5: the guards

#[tokio::test]
async fn deleting_or_retyping_the_page_clears_it_and_nothing_is_refused() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let url = format!("/api/tables/{id}/body-field");

    // Retyping to another type.
    f.app
        .post(&f.owner, &url, json!({ "field_id": f.notes_id }))
        .await;
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", f.notes_id),
            json!({"type": "text", "options": {"multiline": true}}),
        )
        .await;
    r.assert_status(200);
    assert!(f.table(id).await["body_field_id"].is_null());

    // Renaming or editing the page keeps it.
    f.app
        .post(&f.owner, &url, json!({ "field_id": f.page_id }))
        .await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", f.page_id),
            json!({"name": "Notes page"}),
        )
        .await
        .assert_status(200);
    assert_eq!(f.table(id).await["body_field_id"], f.page_id.as_str());

    // Deleting it, with the delete call behaving exactly as before.
    let r = f
        .app
        .delete(&f.owner, &format!("/api/fields/{}", f.page_id))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["deleted_field_ids"], json!([f.page_id]));
    assert!(f.table(id).await["body_field_id"].is_null());

    // Coming back from the trash makes it the page again, hidden views and all: otherwise the
    // next page save would start a second "Page" and leave the first one's text out of sight.
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({"kind": "field", "id": f.page_id}),
        )
        .await
        .assert_status(200);
    assert_eq!(f.table(id).await["body_field_id"], f.page_id.as_str());
}

#[tokio::test]
async fn a_restored_property_gets_its_setting_back_only_if_nothing_else_took_the_place() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let url = format!("/api/tables/{id}/body-field");
    let restore = |field: String| {
        let f = &f;
        async move {
            f.app
                .post(
                    &f.owner,
                    "/api/trash/restore",
                    json!({"kind": "field", "id": field}),
                )
                .await
                .assert_status(200);
        }
    };

    // The table chose another page while the first was in the trash: that choice stands.
    f.app
        .delete(&f.owner, &format!("/api/fields/{}", f.page_id))
        .await
        .assert_status(200);
    f.app
        .post(&f.owner, &url, json!({ "field_id": f.notes_id }))
        .await
        .assert_status(200);
    restore(f.page_id.clone()).await;
    assert_eq!(f.table(id).await["body_field_id"], f.notes_id.as_str());

    // A Home date comes back as the Home date, once: the mark is spent by the restore.
    let due = add_date(&f, id, "Due").await;
    patch_table(&f, id, json!({ "home_date_field_id": due }))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/fields/{due}"))
        .await
        .assert_status(200);
    assert!(f.table(id).await["home_date_field_id"].is_null());
    restore(due.clone()).await;
    assert_eq!(f.table(id).await["home_date_field_id"], due.as_str());
    // Cleared by hand before the second delete, it stays cleared through that restore.
    patch_table(&f, id, json!({ "home_date_field_id": null }))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/fields/{due}"))
        .await
        .assert_status(200);
    restore(due.clone()).await;
    assert!(f.table(id).await["home_date_field_id"].is_null());

    // The same for Done.
    let done = add_checkbox(&f, id, "Done").await;
    patch_table(&f, id, json!({ "done_field_id": done }))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/fields/{done}"))
        .await
        .assert_status(200);
    restore(done.clone()).await;
    assert_eq!(f.table(id).await["done_field_id"], done.as_str());
}

#[tokio::test]
async fn making_the_page_the_title_clears_the_page() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/body-field"),
            json!({ "field_id": f.notes_id }),
        )
        .await
        .assert_status(200);
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/primary-field"),
            json!({ "field_id": f.notes_id }),
        )
        .await
        .assert_status(200);
    let t = f.table(id).await;
    assert_eq!(t["primary_field_id"], f.notes_id.as_str());
    assert!(t["body_field_id"].is_null());
}

#[tokio::test]
async fn deleting_or_retyping_the_home_date_or_done_property_clears_it() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let due = add_date(&f, id, "Due").await;
    let done = add_checkbox(&f, id, "Done").await;
    let set = || async {
        patch_table(
            &f,
            id,
            json!({ "home_date_field_id": due, "done_field_id": done }),
        )
        .await
        .assert_status(200);
    };
    set().await;

    // A date that stays a date keeps the setting; a date that becomes text loses it.
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{due}"),
            json!({"name": "Deadline"}),
        )
        .await
        .assert_status(200);
    assert_eq!(f.table(id).await["home_date_field_id"], due.as_str());
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{due}"),
            json!({"type": "text", "options": {"multiline": false}}),
        )
        .await
        .assert_status(200);
    let t = f.table(id).await;
    assert!(t["home_date_field_id"].is_null());
    assert_eq!(
        t["done_field_id"],
        done.as_str(),
        "the other setting is not touched"
    );

    // A checkbox that becomes a number loses Done.
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{done}"),
            json!({"type": "number", "options": {"precision": 0}}),
        )
        .await
        .assert_status(200);
    assert!(f.table(id).await["done_field_id"].is_null());

    // Deleting them clears them too.
    let due = add_date(&f, id, "Due 2").await;
    let done = add_checkbox(&f, id, "Done 2").await;
    patch_table(
        &f,
        id,
        json!({ "home_date_field_id": due, "done_field_id": done }),
    )
    .await
    .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/fields/{due}"))
        .await
        .assert_status(200);
    let t = f.table(id).await;
    assert!(t["home_date_field_id"].is_null());
    assert_eq!(t["done_field_id"], done.as_str());
    f.app
        .delete(&f.owner, &format!("/api/fields/{done}"))
        .await
        .assert_status(200);
    assert!(f.table(id).await["done_field_id"].is_null());
}

#[tokio::test]
async fn a_home_date_rollup_goes_with_the_link_it_reads() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let other = f.add_table("Other").await;
    let other_id = other["id"].as_str().unwrap();
    let when = add_date(&f, other_id, "When").await;
    let link = f.add_link(id, "Other", other_id).await;
    let latest = f
        .add_field(
            id,
            json!({"name": "Latest", "type": "rollup", "options": {
                "link_field_id": link["id"], "target_field_id": when, "expression": "MAX(values)"}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    patch_table(&f, id, json!({ "home_date_field_id": latest }))
        .await
        .assert_status(200);
    // Deleting the link trashes the rollup built on it, and the setting goes with the rollup.
    let r = f
        .app
        .delete(
            &f.owner,
            &format!("/api/fields/{}", link["id"].as_str().unwrap()),
        )
        .await;
    r.assert_status(200);
    assert!(
        r.body["deleted_field_ids"]
            .as_array()
            .unwrap()
            .contains(&json!(latest))
    );
    assert!(f.table(id).await["home_date_field_id"].is_null());

    // Restoring the link brings the rollup back, and it is the Home date again.
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({"kind": "field", "id": link["id"]}),
        )
        .await
        .assert_status(200);
    assert_eq!(f.table(id).await["home_date_field_id"], latest.as_str());

    // So does restoring the table the link pointed at, which took the link and rollup with it.
    f.app
        .delete(&f.owner, &format!("/api/tables/{other_id}"))
        .await
        .assert_status(200);
    assert!(f.table(id).await["home_date_field_id"].is_null());
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({"kind": "table", "id": other_id}),
        )
        .await
        .assert_status(200);
    assert_eq!(f.table(id).await["home_date_field_id"], latest.as_str());
}

#[tokio::test]
async fn a_lookup_of_a_date_in_another_table_does_not_survive_its_link_going() {
    // Home dates are properties of the table itself; a link's lookup gives a list, so it is
    // refused outright.
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let other = f.add_table("Other").await;
    let other_id = other["id"].as_str().unwrap();
    let d = add_date(&f, other_id, "When").await;
    let link = f.add_link(id, "Other", other_id).await;
    let look = f
        .add_field(
            id,
            json!({"name": "When (lookup)", "type": "lookup", "options": {"link_field_id": link["id"], "target_field_id": d}}),
        )
        .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let r = patch_table(&f, id, json!({ "home_date_field_id": look })).await;
    r.assert_status(400);
}

// ------------------------------------------------------------------- BE-5: writing a page

#[tokio::test]
async fn writing_a_page_saves_it_in_the_page_property() {
    let f = Fixture::new().await;
    let rec = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/records", f.table_id),
            json!({ "records": [{"values": {f.primary_id.clone(): "Ada"}}] }),
        )
        .await;
    let rid = rec.body["records"][0]["id"].as_str().unwrap().to_string();
    let url = format!("/api/tables/{}/records/{rid}/page", f.table_id);

    let r = f
        .app
        .put(&f.owner, &url, json!({ "text": "# Hello\n\nA page." }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["field_id"], f.page_id.as_str());
    assert_eq!(r.body["created"], false);
    assert_eq!(r.body["record"]["values"][&f.page_id], "# Hello\n\nA page.");
    let got = f
        .app
        .get(
            &f.owner,
            &format!("/api/tables/{}/records/{rid}", f.table_id),
        )
        .await;
    assert_eq!(got.body["values"][&f.page_id], "# Hello\n\nA page.");

    // It is saved like any cell: history sees it.
    let h = f
        .app
        .get(&f.owner, &format!("/api/records/{rid}/history"))
        .await;
    assert!(
        h.body
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["changes"].get(&f.page_id).is_some()),
        "{:?}",
        h.body
    );

    // null clears it.
    let r = f.app.put(&f.owner, &url, json!({ "text": null })).await;
    r.assert_status(200);
    assert!(r.body["record"]["values"].get(&f.page_id).is_none());
}

#[tokio::test]
async fn writing_a_page_in_a_collection_without_one_adds_page_in_the_same_save() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/body-field"),
            json!({ "field_id": null }),
        )
        .await
        .assert_status(200);
    let rec = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/records"),
            json!({ "records": [{"values": {}}] }),
        )
        .await;
    let rid = rec.body["records"][0]["id"].as_str().unwrap().to_string();
    let url = format!("/api/tables/{id}/records/{rid}/page");

    // An editor, who cannot add properties, causes the one schema change this allows.
    let editor = f.member("ed@example.com", Role::Editor);
    f.app
        .post(
            &editor,
            &format!("/api/tables/{id}/fields"),
            json!({"name": "X", "type": "text", "options": {}}),
        )
        .await
        .assert_status(403);
    let r = f
        .app
        .put(&editor, &url, json!({ "text": "first words" }))
        .await;
    r.assert_status(200);
    assert_eq!(r.body["created"], true);
    let field = r.body["field_id"].as_str().unwrap().to_string();
    assert_eq!(r.body["record"]["values"][&field], "first words");
    let t = f.table(id).await;
    assert_eq!(t["body_field_id"], field.as_str());
    let made = t["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == field.as_str())
        .unwrap();
    assert_eq!(made["type"], "rich_text");
    // "Page" is taken by the old, unpointed property, so this one is "Page 2".
    assert_eq!(made["name"], "Page 2");
    for v in t["views"].as_array().unwrap() {
        assert!(
            v["config"]["hidden_fields"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
    }

    // The next save finds it.
    let r = f.app.put(&editor, &url, json!({ "text": "more" })).await;
    assert_eq!(r.body["created"], false);
    assert_eq!(r.body["field_id"], field.as_str());
}

#[tokio::test]
async fn a_page_write_that_fails_adds_no_property() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/body-field"),
            json!({ "field_id": null }),
        )
        .await
        .assert_status(200);
    let count = |t: Value| t["fields"].as_array().unwrap().len();
    let before = count(f.table(id).await);
    // No such record.
    f.app
        .put(
            &f.owner,
            &format!("/api/tables/{id}/records/recNope/page"),
            json!({ "text": "x" }),
        )
        .await
        .assert_status(404);
    // Too long for a cell.
    let rec = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/records"),
            json!({ "records": [{"values": {}}] }),
        )
        .await;
    let rid = rec.body["records"][0]["id"].as_str().unwrap().to_string();
    f.app
        .put(
            &f.owner,
            &format!("/api/tables/{id}/records/{rid}/page"),
            json!({ "text": "x".repeat(ob_core::limits::MAX_TEXT_CELL_LEN + 1) }),
        )
        .await
        .assert_status(400);
    assert_eq!(count(f.table(id).await), before);
    assert!(f.table(id).await["body_field_id"].is_null());
}

#[tokio::test]
async fn people_who_cannot_edit_cannot_write_a_page() {
    let f = Fixture::new().await;
    let rec = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/records", f.table_id),
            json!({ "records": [{"values": {}}] }),
        )
        .await;
    let rid = rec.body["records"][0]["id"].as_str().unwrap();
    let url = format!("/api/tables/{}/records/{rid}/page", f.table_id);
    for (email, role) in [
        ("v@example.com", Role::Viewer),
        ("c@example.com", Role::Commenter),
    ] {
        let who = f.member(email, role);
        f.app
            .put(&who, &url, json!({ "text": "no" }))
            .await
            .assert_status(403);
    }
    let out = f.app.anon();
    f.app
        .put(&out, &url, json!({ "text": "no" }))
        .await
        .assert_status(401);
}

#[tokio::test]
async fn a_table_at_the_property_limit_says_why_it_cannot_get_a_page() {
    let f = Fixture::new().await;
    let id = f.table_id.clone();
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/body-field"),
            json!({ "field_id": null }),
        )
        .await
        .assert_status(200);
    // Fill the table with properties straight in the database.
    let t = id.clone();
    sql(&f.app, |tx| {
        let have: i64 = tx.query_row(
            "SELECT count(*) FROM fields WHERE table_id = ?1 AND deleted_at IS NULL",
            [&t],
            |r| r.get(0),
        )?;
        for i in have..ob_core::limits::MAX_FIELDS_PER_TABLE as i64 {
            tx.execute(
                "INSERT INTO fields (id, table_id, name, type, options, position, created_at)
                 VALUES (?1, ?2, ?3, 'text', '{}', ?4, 1)",
                rusqlite::params![format!("fldfill{i}"), t, format!("F{i}"), 100 + i],
            )?;
        }
        Ok(())
    });
    let rec = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/records"),
            json!({ "records": [{"values": {}}] }),
        )
        .await;
    let rid = rec.body["records"][0]["id"].as_str().unwrap();
    let r = f
        .app
        .put(
            &f.owner,
            &format!("/api/tables/{id}/records/{rid}/page"),
            json!({ "text": "x" }),
        )
        .await;
    r.assert_status(409);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("room for a page")
    );
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{id}/body-field"),
            json!({ "create": true }),
        )
        .await
        .assert_status(409);
}

// ----------------------------------------------------------------- duplication and the trash

#[tokio::test]
async fn duplicating_a_table_or_a_project_remaps_the_settings_and_the_trash_keeps_them() {
    let f = Fixture::new().await;
    let id = f.table_id.as_str();
    let due = add_date(&f, id, "Due").await;
    let done = add_checkbox(&f, id, "Done").await;
    patch_table(
        &f,
        id,
        json!({ "color": "purple", "record_noun": "client", "home_date_field_id": due, "done_field_id": done }),
    )
    .await
    .assert_status(200);
    let original = f.table(id).await;

    let name_of = |t: &Value, field: &str| -> Option<String> {
        let fid = t[field].as_str()?;
        t["fields"]
            .as_array()?
            .iter()
            .find(|x| x["id"] == fid)
            .map(|x| x["name"].as_str().unwrap().to_string())
    };
    let check = |copy: &Value| {
        assert_eq!(copy["color"], "purple");
        assert_eq!(copy["record_noun"], "client");
        for key in ["body_field_id", "home_date_field_id", "done_field_id"] {
            assert!(copy[key].is_string(), "{key}");
            assert_ne!(copy[key], original[key], "{key} points into the copy");
            assert_eq!(name_of(copy, key), name_of(&original, key), "{key}");
        }
    };

    let r = f
        .app
        .post(&f.owner, &format!("/api/tables/{id}/duplicate"), json!({}))
        .await;
    r.assert_status(201);
    check(&r.body);
    let copy_id = r.body["id"].as_str().unwrap().to_string();

    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{}/duplicate", f.base_id),
            json!({"name": "CRM copy"}),
        )
        .await;
    r.assert_status(201);
    assert_eq!(
        r.body["is_top_level"], false,
        "a copy of the top level is just a folder"
    );
    let tables = r.body["tables"].as_array().unwrap();
    let in_copy = tables
        .iter()
        .find(|t| t["name"] == original["name"])
        .unwrap();
    check(in_copy);

    // Trash and restore keep the settings as they were.
    f.app
        .delete(&f.owner, &table_url(&copy_id))
        .await
        .assert_status(200);
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({"kind": "table", "id": copy_id}),
        )
        .await
        .assert_status(200);
    check(&f.table(&copy_id).await);
}

// ---------------------------------------------------------------------- the top-level project

#[tokio::test]
async fn an_owner_chooses_which_project_is_the_top_level_and_only_the_pointer_moves() {
    let f = Fixture::new().await;
    let side = base(&f.app, &f.owner, &f.ws, "Side").await;
    let side_id = side["id"].as_str().unwrap().to_string();
    let url = format!("/api/workspaces/{}/top-level", f.ws);
    let tables_before = f.schema().await["tables"].clone();

    let r = f
        .app
        .post(&f.owner, &url, json!({ "base_id": side_id }))
        .await;
    r.assert_status(200);
    assert_eq!(
        r.body["id"],
        f.ws.as_str(),
        "it answers the workspace summary"
    );
    assert_eq!(r.body["root_base_id"], side_id.as_str());
    let flags: Vec<(String, bool)> = r.body["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            (
                b["name"].as_str().unwrap().into(),
                b["is_top_level"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        flags,
        [("CRM".to_string(), false), ("Side".to_string(), true)]
    );
    assert_eq!(f.schema().await["is_top_level"], false);
    assert_eq!(
        f.schema().await["tables"],
        tables_before,
        "nothing else moved"
    );

    // Choosing it again changes nothing.
    f.app
        .post(&f.owner, &url, json!({ "base_id": side_id }))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn the_top_level_must_be_a_live_project_of_the_workspace() {
    let f = Fixture::new().await;
    let url = format!("/api/workspaces/{}/top-level", f.ws);
    let other_ws = workspace(&f.app, &f.owner, "Elsewhere").await;
    let foreign = base(&f.app, &f.owner, &other_ws, "Foreign").await;
    let gone = base(&f.app, &f.owner, &f.ws, "Gone").await;
    let gone_id = gone["id"].as_str().unwrap();
    f.app
        .delete(&f.owner, &format!("/api/bases/{gone_id}"))
        .await
        .assert_status(200);
    for bad in [foreign["id"].as_str().unwrap(), gone_id, "appNope"] {
        f.app
            .post(&f.owner, &url, json!({ "base_id": bad }))
            .await
            .assert_status(400);
    }
    f.app
        .post(&f.owner, &url, json!({}))
        .await
        .assert_status(400);
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    let ws = list
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == f.ws.as_str())
        .unwrap();
    assert_eq!(ws["root_base_id"], f.base_id.as_str());
}

#[tokio::test]
async fn only_workspace_owners_choose_the_top_level() {
    let f = Fixture::new().await;
    let side = base(&f.app, &f.owner, &f.ws, "Side").await;
    let body = json!({ "base_id": side["id"] });
    let url = format!("/api/workspaces/{}/top-level", f.ws);
    for (email, role) in [
        ("v@example.com", Role::Viewer),
        ("e@example.com", Role::Editor),
        ("c@example.com", Role::Creator),
    ] {
        let who = f.member(email, role);
        f.app
            .post(&who, &url, body.clone())
            .await
            .assert_status(403);
    }
    let stranger = f.app.user("x@example.com", "X");
    f.app
        .post(&stranger, &url, body.clone())
        .await
        .assert_status(404);
    f.app
        .post(&f.app.anon(), &url, body.clone())
        .await
        .assert_status(401);
    // A token needs the manage permission, and a write token without it is refused.
    let write = token_client(&f.app, &f.owner, true);
    f.app.post(&write, &url, body).await.assert_status(403);
}

#[tokio::test]
async fn the_top_level_project_cannot_be_deleted_until_another_takes_its_place() {
    let f = Fixture::new().await;
    let side = base(&f.app, &f.owner, &f.ws, "Side").await;
    let side_id = side["id"].as_str().unwrap().to_string();

    let r = f
        .app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await;
    r.assert_status(409);
    let msg = r.body["error"]["message"].as_str().unwrap();
    assert!(msg.contains("top-level"), "{msg}");
    assert!(
        msg.contains("Make another folder the top level first"),
        "{msg}"
    );
    assert!(msg.contains("delete the workspace"), "{msg}");
    assert_eq!(f.schema().await["name"], "CRM", "it is still there");

    // The folder that is not the top level can go.
    f.app
        .delete(&f.owner, &format!("/api/bases/{side_id}"))
        .await
        .assert_status(200);
    f.app
        .post(
            &f.owner,
            "/api/trash/restore",
            json!({"kind": "base", "id": side_id}),
        )
        .await
        .assert_status(200);

    // Move the pointer and the old top level is a folder like any other, the new one is protected.
    f.app
        .post(
            &f.owner,
            &format!("/api/workspaces/{}/top-level", f.ws),
            json!({ "base_id": side_id }),
        )
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/bases/{side_id}"))
        .await
        .assert_status(409);
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);

    // The whole workspace can always go to the trash.
    f.app
        .delete(&f.owner, &format!("/api/workspaces/{}", f.ws))
        .await
        .assert_status(200);
}
