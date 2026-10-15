//! Search everything (`GET /api/search`): what it finds, the order, the access
//! rules, limits and validation.

mod common;
mod schema_support;

use common::{Client, Response, TestApp};
use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

async fn search(app: &TestApp, c: &Client, query: &str) -> Response {
    app.get(c, &format!("/api/search?{query}")).await
}

/// `(kind, name)` of each result, in order.
fn found(r: &Response) -> Vec<(String, String)> {
    r.assert_status(200);
    r.body["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (sid(&i["kind"]).to_string(), sid(&i["name"]).to_string()))
        .collect()
}

fn hit(kind: &str, name: &str) -> (String, String) {
    (kind.to_string(), name.to_string())
}

async fn new_view(f: &Fixture, c: &Client, name: &str, personal: bool) -> String {
    let r = f
        .app
        .post(
            c,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": name, "type": "kanban", "personal": personal }),
        )
        .await;
    r.assert_status(201);
    sid(&r.body["id"]).to_string()
}

#[tokio::test]
async fn names_come_before_records_and_starts_with_before_contains() {
    let f = Fixture::new().await;
    let club = workspace(&f.app, &f.owner, "Dish club").await;
    base(&f.app, &f.owner, &f.ws, "Big dishes").await;
    let washer = f.add_table("Dishwasher").await;
    new_view(&f, &f.owner, "My dishes", true).await;
    f.insert_record(&f.table_id, json!({ &f.primary_id: "Wash dishes" }));
    let dishes = f.insert_record(&f.table_id, json!({ &f.primary_id: "Dishes" }));
    let kitchen = f.insert_record(
        &f.table_id,
        json!({ &f.primary_id: "Kitchen", &f.notes_id: "Leave the DISHES\nin the sink" }),
    );
    f.insert_record(&f.table_id, json!({ &f.primary_id: "Laundry" }));

    let r = search(&f.app, &f.owner, "q=dish").await;
    assert_eq!(
        found(&r),
        [
            hit("workspace", "Dish club"),
            hit("table", "Dishwasher"),
            hit("base", "Big dishes"),
            hit("view", "My dishes"),
            hit("record", "Dishes"),
            hit("record", "Wash dishes"),
            hit("record", "Kitchen"),
        ]
    );
    let results = r.body["results"].as_array().unwrap();
    assert_eq!(results[0]["id"], club.as_str());
    assert_eq!(results[0]["workspace_id"], club.as_str());
    assert_eq!(
        results[0]["workspace_color"], "blue",
        "the owner's second workspace"
    );
    assert!(results[0]["base_id"].is_null());

    let table = &results[1];
    assert_eq!(table["id"], washer["id"]);
    assert_eq!(table["table_id"], washer["id"]);
    assert_eq!(table["base_id"], f.base_id.as_str());
    assert_eq!(table["base_name"], "CRM");
    assert_eq!(table["base_color"], "blue");
    assert_eq!(table["workspace_name"], "Acme");
    assert_eq!(table["workspace_color"], "green");
    assert_eq!(
        table["view_id"], washer["views"][0]["id"],
        "opens in its first view"
    );
    assert_eq!(table["view_type"], "grid");

    let view = &results[3];
    assert_eq!(view["view_id"], view["id"]);
    assert_eq!(view["view_type"], "kanban");
    assert_eq!(view["table_id"], f.table_id.as_str());

    let rec = &results[4];
    assert_eq!(rec["id"], dishes.as_str());
    assert_eq!(rec["record_id"], dishes.as_str());
    assert_eq!(rec["table_id"], f.table_id.as_str());
    assert_eq!(rec["table_name"], "Table 1");
    assert_eq!(rec["view_id"], f.view_id.as_str());
    assert!(rec["snippet"].is_null(), "matched in the primary field");
    let by_notes = &results[6];
    assert_eq!(by_notes["record_id"], kitchen.as_str());
    assert_eq!(by_notes["snippet"], "Leave the DISHES in the sink");

    // Case and surrounding spaces do not matter.
    assert_eq!(
        found(&search(&f.app, &f.owner, "q=%20%20DISH%20").await),
        found(&r)
    );
    assert!(found(&search(&f.app, &f.owner, "q=nothing-like-this").await).is_empty());
}

#[tokio::test]
async fn search_finds_only_what_the_caller_can_open() {
    let f = Fixture::new().await;
    let secret = base(&f.app, &f.owner, &f.ws, "Dish secrets").await;
    let secret_table = sid(&secret["tables"][0]["id"]).to_string();
    let secret_primary = sid(&secret["tables"][0]["primary_field_id"]).to_string();
    insert_record(
        &f.app,
        &secret_table,
        json!({ secret_primary: "Dish in Secrets" }),
    );
    f.insert_record(&f.table_id, json!({ &f.primary_id: "Dish in CRM" }));
    workspace(&f.app, &f.owner, "Dish club").await;

    let everything = found(&search(&f.app, &f.owner, "q=dish").await);
    assert_eq!(
        everything,
        [
            hit("workspace", "Dish club"),
            hit("base", "Dish secrets"),
            hit("record", "Dish in CRM"),
            hit("record", "Dish in Secrets"),
        ]
    );

    // A member limited to CRM finds nothing of the other base.
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    assert_eq!(
        found(&search(&f.app, &guest, "q=dish").await),
        [hit("record", "Dish in CRM")]
    );
    assert_eq!(
        found(&search(&f.app, &guest, "q=acme").await),
        [hit("workspace", "Acme")],
        "they can open the workspace itself"
    );

    // Personal views are found by their owner only.
    let editor = f.member("ed@example.com", Role::Editor);
    new_view(&f, &editor, "Dish board", true).await;
    assert!(found(&search(&f.app, &editor, "q=dish%20board").await) == [hit("view", "Dish board")]);
    assert!(found(&search(&f.app, &f.owner, "q=dish%20board").await).is_empty());

    // Invited but not joined, or a stranger: nothing at all.
    f.app
        .post(
            &f.owner,
            &format!("/api/workspaces/{}/invites", f.ws),
            json!({ "role": "editor", "email": "later@example.com" }),
        )
        .await
        .assert_status(201);
    let later = f.app.user("later@example.com", "Later");
    assert!(found(&search(&f.app, &later, "q=dish").await).is_empty());
    assert!(found(&search(&f.app, &later, "q=acme").await).is_empty());
    let stranger = f.app.user("s@example.com", "S");
    assert!(found(&search(&f.app, &stranger, "q=dish").await).is_empty());

    // A token limited to CRM: not the other base, nor a workspace without its bases.
    let limited = f
        .app
        .raw_token(&f.owner, json!({ "write": false, "base_ids": [f.base_id] }));
    assert_eq!(
        found(&search(&f.app, &limited, "q=dish").await),
        [hit("record", "Dish in CRM")]
    );
    let read_only = token_client(&f.app, &f.owner, false);
    assert_eq!(
        found(&search(&f.app, &read_only, "q=dish").await),
        everything
    );

    // Trashed things are not found.
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", sid(&secret["id"])))
        .await
        .assert_status(200);
    let gone = f.insert_record(&f.table_id, json!({ &f.primary_id: "Dish gone" }));
    trash_record(&f.app, &gone, 1);
    let table = f.add_table("Dish table").await;
    f.app
        .delete(&f.owner, &format!("/api/tables/{}", sid(&table["id"])))
        .await
        .assert_status(200);
    assert_eq!(
        found(&search(&f.app, &f.owner, "q=dish").await),
        [hit("workspace", "Dish club"), hit("record", "Dish in CRM")]
    );
    search(&f.app, &f.app.anon(), "q=dish")
        .await
        .assert_status(401);
}

#[tokio::test]
async fn trashed_fields_views_and_workspaces_are_not_found() {
    let f = Fixture::new().await;
    f.insert_record(
        &f.table_id,
        json!({ &f.primary_id: "Kitchen", &f.notes_id: "Dish rack" }),
    );
    let view = new_view(&f, &f.owner, "Dish board", false).await;
    let club = workspace(&f.app, &f.owner, "Dish club").await;
    let club_base = base(&f.app, &f.owner, &club, "Dish base").await;
    let club_table = sid(&club_base["tables"][0]["id"]).to_string();
    let club_primary = sid(&club_base["tables"][0]["primary_field_id"]).to_string();
    insert_record(&f.app, &club_table, json!({ club_primary: "Dish in club" }));
    assert_eq!(
        found(&search(&f.app, &f.owner, "q=dish").await),
        [
            hit("workspace", "Dish club"),
            hit("base", "Dish base"),
            hit("view", "Dish board"),
            hit("record", "Dish in club"),
            hit("record", "Kitchen"),
        ]
    );

    f.app
        .delete(&f.owner, &format!("/api/fields/{}", f.notes_id))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/views/{view}"))
        .await
        .assert_status(200);
    f.app
        .delete(&f.owner, &format!("/api/workspaces/{club}"))
        .await
        .assert_status(200);
    assert!(found(&search(&f.app, &f.owner, "q=dish").await).is_empty());
}

#[tokio::test]
async fn search_limits_and_validation() {
    let f = Fixture::new().await;
    for i in 0..60 {
        f.insert_record(
            &f.table_id,
            json!({ &f.primary_id: format!("Item {i:02}") }),
        );
    }
    let count = async |query: &str| found(&search(&f.app, &f.owner, query).await).len();
    assert_eq!(count("q=item").await, 20, "default limit");
    assert_eq!(count("q=item&limit=5").await, 5);
    assert_eq!(count("q=item&limit=100").await, 50, "at most 50");
    assert_eq!(
        found(&search(&f.app, &f.owner, "q=item&limit=3").await),
        [
            hit("record", "Item 00"),
            hit("record", "Item 01"),
            hit("record", "Item 02"),
        ],
        "in the table's order"
    );

    // Names fill the limit before any record is looked at.
    f.add_table("Items").await;
    assert_eq!(
        found(&search(&f.app, &f.owner, "q=item&limit=1").await),
        [hit("table", "Items")]
    );

    for bad in ["", "q=", "q=%20%20", &format!("q={}", "x".repeat(201))] {
        let r = search(&f.app, &f.owner, bad).await;
        r.assert_status(400);
        assert_eq!(r.body["error"]["code"], "bad_request", "{bad}");
    }
    search(&f.app, &f.owner, &format!("q={}", "x".repeat(200)))
        .await
        .assert_status(200);
    search(&f.app, &f.owner, "q=item&limit=lots")
        .await
        .assert_status(400);
}

#[tokio::test]
async fn record_search_counts_rows_against_one_budget() {
    let f = Fixture::new().await;
    for i in 0..10 {
        f.insert_record(&f.table_id, json!({ &f.primary_id: format!("Match {i}") }));
    }
    let table_id = f.table_id.clone();
    let (hits, left) = f
        .app
        .state
        .db
        .write_sync(|tx| {
            let table = openbase::store::schema::live_table(tx, &table_id)?;
            let mut left = 3;
            let hits = openbase::engine::query::search_table(
                tx,
                &table,
                "match",
                50,
                chrono_tz::UTC,
                &mut left,
            )?;
            Ok((hits, left))
        })
        .unwrap();
    assert_eq!(left, 0);
    assert_eq!(hits.len(), 3, "stops reading when the budget is spent");
    assert!(
        hits.iter()
            .all(|h| h.starts_with && h.matched_text.is_none())
    );
}
