//! The activity feed (`GET /api/history`): history entries and comments of every record the
//! caller can open, its filters, both orders, cursor paging (also across equal times), and who
//! may see what.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use common::{Client, Response, TestApp};
use openbase::perm::Role;
use query_support::*;
use rusqlite::params;
use serde_json::{Value, json};

/// `GET /api/history{query}` (query without the `?`).
async fn feed(app: &TestApp, c: &Client, query: &str) -> Response {
    app.get(c, &format!("/api/history?{query}")).await
}

/// The item ids of a page, in order.
fn ids(r: &Response) -> Vec<String> {
    r.assert_status(200);
    r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

/// `kind:record name` of each item, in order.
fn summary(r: &Response) -> Vec<String> {
    r.assert_status(200);
    r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            format!(
                "{}:{}",
                i["kind"].as_str().unwrap(),
                i["record"]["name"].as_str().unwrap()
            )
        })
        .collect()
}

/// A history entry row, as `history::record` writes it; returns its id.
fn hist(
    app: &TestApp,
    record: &str,
    table: &str,
    user: &Client,
    kind: &str,
    changes: Value,
    at: i64,
) -> String {
    let (record, table, uid, kind, changes) = (
        record.to_string(),
        table.to_string(),
        user.user_id.clone(),
        kind.to_string(),
        changes.to_string(),
    );
    let id: i64 = schema_support::sql(app, |tx| {
        tx.execute(
            "INSERT INTO record_history (record_id, table_id, user_id, kind, changes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![record, table, uid, kind, changes, at],
        )?;
        Ok(tx.last_insert_rowid())
    });
    id.to_string()
}

/// A comment row; returns its id.
fn comment(
    app: &TestApp,
    record: &str,
    user: &Client,
    body: &str,
    at: i64,
    deleted: Option<i64>,
) -> String {
    let id = openbase::ids::new_id("cmt");
    let (cid, record, uid, body) = (
        id.clone(),
        record.to_string(),
        user.user_id.clone(),
        body.to_string(),
    );
    schema_support::sql(app, |tx| {
        tx.execute(
            "INSERT INTO comments (id, record_id, user_id, body, created_at, updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)",
            params![cid, record, uid, body, at, deleted],
        )
    });
    id
}

fn edit(field: &str, old: Value, new: Value) -> Value {
    json!({ field: { "old": old, "new": new } })
}

/// Acme (CRM with a Table 1 and a Contacts table; Ops) and Home (Chores), all owned by
/// the fixture's owner, and a record in each of the four tables.
struct World {
    f: Fixture,
    ops: String,
    ops_table: String,
    ops_primary: String,
    chores: String,
    chores_table: String,
    home: String,
    deal: String,
    contact: String,
    sprint: String,
    dishes: String,
}

impl World {
    async fn new() -> World {
        let f = Fixture::new().await;
        let contacts = f.add_table("Contacts").await;
        let contacts_table = contacts["id"].as_str().unwrap().to_string();
        let contacts_primary = contacts["primary_field_id"].as_str().unwrap().to_string();
        let ops = base(&f.app, &f.owner, &f.ws, "Ops").await;
        let ops_table = ops["tables"][0]["id"].as_str().unwrap().to_string();
        let ops_primary = ops["tables"][0]["primary_field_id"]
            .as_str()
            .unwrap()
            .to_string();
        let home = workspace(&f.app, &f.owner, "Home").await;
        let chores = base(&f.app, &f.owner, &home, "Chores").await;
        let chores_table = chores["tables"][0]["id"].as_str().unwrap().to_string();
        let chores_primary = chores["tables"][0]["primary_field_id"]
            .as_str()
            .unwrap()
            .to_string();
        let deal = f.insert_record(&f.table_id, json!({ &f.primary_id: "Big deal" }));
        let contact = f.insert_record(&contacts_table, json!({ &contacts_primary: "Ada" }));
        let sprint = f.insert_record(&ops_table, json!({ &ops_primary: "Sprint 1" }));
        let dishes = f.insert_record(&chores_table, json!({ &chores_primary: "Dishes" }));
        World {
            ops: ops["id"].as_str().unwrap().to_string(),
            ops_table,
            ops_primary,
            chores: chores["id"].as_str().unwrap().to_string(),
            chores_table,
            home,
            deal,
            contact,
            sprint,
            dishes,
            f,
        }
    }

    fn owner_hist(&self, record: &str, table: &str, kind: &str, at: i64) -> String {
        hist(
            &self.f.app,
            record,
            table,
            &self.f.owner,
            kind,
            json!({}),
            at,
        )
    }
}

#[tokio::test]
async fn lists_activity_of_every_project_newest_first_with_where_and_who() {
    let w = World::new().await;
    let f = &w.f;
    let ann = f.member("ann@example.com", Role::Editor);
    let a = hist(
        &f.app,
        &w.deal,
        &f.table_id,
        &f.owner,
        "create",
        edit(&f.primary_id, Value::Null, json!("Big deal")),
        1_000,
    );
    let b = hist(
        &f.app,
        &w.sprint,
        &w.ops_table,
        &ann,
        "update",
        edit(&w.ops_primary, json!("Sprint"), json!("Sprint 1")),
        2_000,
    );
    let c = hist(
        &f.app,
        &w.dishes,
        &w.chores_table,
        &f.owner,
        "update",
        json!({}),
        3_000,
    );

    let r = feed(&f.app, &f.owner, "").await;
    assert_eq!(ids(&r), [c.clone(), b.clone(), a.clone()]);
    assert!(r.body["next"].is_null());

    let items = r.body["items"].as_array().unwrap();
    let ops = &items[1];
    assert_eq!(ops["kind"], "update");
    assert_eq!(ops["created_at"], 2_000);
    assert_eq!(
        ops["author"],
        json!({ "id": ann.user_id.clone().unwrap(), "name": "ann@example.com" })
    );
    assert_eq!(
        ops["record"],
        json!({ "id": w.sprint, "name": "Sprint 1", "deleted": false })
    );
    assert_eq!(ops["place"]["workspace_name"], "Acme");
    assert_eq!(ops["place"]["workspace_id"], f.ws.as_str());
    assert_eq!(ops["place"]["base_id"], w.ops.as_str());
    assert_eq!(ops["place"]["base_name"], "Ops");
    assert_eq!(ops["place"]["table_id"], w.ops_table.as_str());
    assert_eq!(ops["place"]["table_name"], "Table 1");
    assert_eq!(
        ops["changes"][&w.ops_primary],
        json!({ "old": "Sprint", "new": "Sprint 1" })
    );
    assert!(ops["comment"].is_null());
    assert_eq!(items[0]["place"]["workspace_name"], "Home");
    assert_eq!(items[0]["place"]["base_name"], "Chores");
    // The fields the changes refer to come with the page, to show names and format values.
    assert_eq!(r.body["fields"][&w.ops_primary]["name"], "Name");
    assert_eq!(r.body["fields"][&f.primary_id]["name"], "Name");

    // Someone who has joined only the first workspace sees what happened there.
    let r = feed(&f.app, &ann, "").await;
    assert_eq!(ids(&r), [b, a]);
}

#[tokio::test]
async fn filters_narrow_by_workspace_project_table_author_and_kind() {
    let w = World::new().await;
    let f = &w.f;
    let ann = f.member("ann@example.com", Role::Editor);
    let contacts_table: String = schema_support::sql(&f.app, |tx| {
        tx.query_row(
            "SELECT table_id FROM records WHERE id = ?1",
            [&w.contact],
            |r| r.get(0),
        )
    });
    let created = hist(
        &f.app,
        &w.deal,
        &f.table_id,
        &f.owner,
        "create",
        json!({}),
        1_000,
    );
    let contact = hist(
        &f.app,
        &w.contact,
        &contacts_table,
        &ann,
        "update",
        json!({}),
        2_000,
    );
    let sprint = hist(
        &f.app,
        &w.sprint,
        &w.ops_table,
        &f.owner,
        "delete",
        json!({}),
        3_000,
    );
    let dishes = hist(
        &f.app,
        &w.dishes,
        &w.chores_table,
        &ann,
        "restore",
        json!({}),
        4_000,
    );
    let talk = comment(&f.app, &w.deal, &ann, "Call them", 5_000, None);

    let q = |query: &str| {
        let query = query.to_string();
        async move { ids(&feed(&f.app, &f.owner, &query).await) }
    };
    assert_eq!(
        q(&format!("workspace={}", f.ws)).await,
        [
            talk.clone(),
            sprint.clone(),
            contact.clone(),
            created.clone()
        ]
    );
    assert_eq!(q(&format!("workspace={}", w.home)).await, [dishes.as_str()]);
    assert_eq!(q(&format!("base={}", w.ops)).await, [sprint.as_str()]);
    assert_eq!(
        q(&format!("base={}", f.base_id)).await,
        [talk.clone(), contact.clone(), created.clone()]
    );
    assert_eq!(
        q(&format!("table={contacts_table}")).await,
        [contact.as_str()]
    );
    assert_eq!(
        q(&format!("user={}", ann.user_id.clone().unwrap())).await,
        [talk.clone(), dishes.clone(), contact.clone()]
    );
    assert_eq!(q("kind=create").await, [created.as_str()]);
    assert_eq!(q("kind=update").await, [contact.as_str()]);
    assert_eq!(q("kind=delete").await, [sprint.as_str()]);
    assert_eq!(q("kind=restore").await, [dishes.as_str()]);
    assert_eq!(q("kind=comment").await, [talk.as_str()]);
    // Filters combine; empty values count as absent.
    assert_eq!(
        q(&format!(
            "workspace={}&user={}&kind=update",
            f.ws,
            ann.user_id.clone().unwrap()
        ))
        .await,
        [contact.as_str()]
    );
    assert_eq!(
        q("workspace=&base=&table=&user=&kind=&order=&before=")
            .await
            .len(),
        5
    );
    // Something that does not exist or is not yours matches nothing (and says nothing about it).
    assert!(q("base=bseNope").await.is_empty());
    assert!(
        q(&format!("workspace={}&base={}", w.home, w.ops))
            .await
            .is_empty()
    );
    assert!(q("user=usrNobody").await.is_empty());
}

#[tokio::test]
async fn oldest_first_reverses_the_order() {
    let w = World::new().await;
    let f = &w.f;
    let a = w.owner_hist(&w.deal, &f.table_id, "create", 1_000);
    let b = w.owner_hist(&w.sprint, &w.ops_table, "update", 2_000);
    let c = comment(&f.app, &w.deal, &f.owner, "Hi", 3_000, None);
    assert_eq!(
        ids(&feed(&f.app, &f.owner, "order=newest").await),
        [c.clone(), b.clone(), a.clone()]
    );
    assert_eq!(
        ids(&feed(&f.app, &f.owner, "order=oldest").await),
        [a, b, c]
    );
}

#[tokio::test]
async fn pages_with_a_cursor_never_repeat_or_skip_even_when_times_are_equal() {
    let w = World::new().await;
    let f = &w.f;
    // Many items on the same few milliseconds, from both sources.
    for n in 0..14 {
        let at = 1_000 + (n / 5) * 10;
        w.owner_hist(&w.deal, &f.table_id, "update", at);
        if n % 2 == 0 {
            comment(&f.app, &w.deal, &f.owner, &format!("c{n}"), at, None);
        }
    }
    for order in ["newest", "oldest"] {
        let all = ids(&feed(&f.app, &f.owner, &format!("order={order}&limit=200")).await);
        assert_eq!(all.len(), 21);
        let mut unique = all.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), all.len(), "{order}: no item twice");

        for limit in [1, 2, 4, 7, 21, 22] {
            let mut paged = Vec::new();
            let mut before = String::new();
            let mut pages = 0;
            loop {
                let r = feed(
                    &f.app,
                    &f.owner,
                    &format!("order={order}&limit={limit}&before={before}"),
                )
                .await;
                paged.extend(ids(&r));
                pages += 1;
                match r.body["next"].as_str() {
                    Some(next) => before = next.to_string(),
                    None => break,
                }
                assert!(pages < 30, "paging does not end");
            }
            assert_eq!(paged, all, "{order} with pages of {limit}");
        }
    }
    // The last page says so, and a full page that happens to be the last one has no next.
    let r = feed(&f.app, &f.owner, "limit=21").await;
    assert!(r.body["next"].is_null());
    let r = feed(&f.app, &f.owner, "limit=20").await;
    assert!(r.body["next"].is_string());
}

#[tokio::test]
async fn comments_are_activity_but_deleted_ones_are_not() {
    let w = World::new().await;
    let f = &w.f;
    let ann = f.member("ann@example.com", Role::Editor);
    let kept = comment(
        &f.app,
        &w.deal,
        &ann,
        "Sent the quote @[Owner](usrX)",
        2_000,
        None,
    );
    comment(&f.app, &w.deal, &ann, "Never mind", 3_000, Some(3_500));
    w.owner_hist(&w.deal, &f.table_id, "update", 1_000);

    let r = feed(&f.app, &f.owner, "").await;
    let items = r.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], kept.as_str());
    assert_eq!(items[0]["kind"], "comment");
    assert_eq!(items[0]["comment"], "Sent the quote @[Owner](usrX)");
    assert_eq!(items[0]["changes"], json!({}));
    assert_eq!(items[0]["author"]["name"], "ann@example.com");
    assert_eq!(items[0]["record"]["name"], "Big deal");
    assert_eq!(items[0]["place"]["base_name"], "CRM");
    assert_eq!(ids(&feed(&f.app, &f.owner, "kind=comment").await), [kept]);
}

#[tokio::test]
async fn people_see_only_what_they_can_open() {
    let w = World::new().await;
    let f = &w.f;
    w.owner_hist(&w.deal, &f.table_id, "create", 1_000);
    let ops = w.owner_hist(&w.sprint, &w.ops_table, "create", 2_000);
    let home = w.owner_hist(&w.dishes, &w.chores_table, "create", 3_000);
    comment(&f.app, &w.sprint, &f.owner, "Ops talk", 4_000, None);

    // Nobody else's workspace.
    let stranger = f.app.user("stranger@example.com", "Stranger");
    let r = feed(&f.app, &stranger, "").await;
    assert!(ids(&r).is_empty());
    assert!(r.body["next"].is_null());
    // Naming what they cannot see changes nothing.
    assert!(ids(&feed(&f.app, &stranger, &format!("base={}", w.ops)).await).is_empty());
    assert!(ids(&feed(&f.app, &stranger, &format!("workspace={}", f.ws)).await).is_empty());
    assert_eq!(ids(&feed(&f.app, &f.owner, "kind=create").await).len(), 3);

    // A member limited to some projects sees those and not the others.
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    let guest_sees: Vec<String> = ids(&feed(&f.app, &guest, "").await);
    assert_eq!(guest_sees.len(), 1, "only CRM's");
    add_base_member(&f.app, &w.ops, &guest, Role::Viewer);
    let r = feed(&f.app, &guest, "").await;
    assert_eq!(
        r.body["items"].as_array().unwrap().len(),
        3,
        "CRM, and Ops with its comment"
    );
    assert!(ids(&r).contains(&ops));
    assert!(!ids(&r).contains(&home));

    // A token limited to a project reaches only that one, whatever the user can open.
    let limited = f
        .app
        .raw_token(&f.owner, json!({ "write": false, "base_ids": [w.ops] }));
    let r = feed(&f.app, &limited, "").await;
    assert_eq!(summary(&r), ["comment:Sprint 1", "create:Sprint 1"]);
    assert!(ids(&feed(&f.app, &limited, &format!("base={}", w.chores)).await).is_empty());
    let full = f
        .app
        .raw_token(&f.owner, json!({ "write": false, "base_ids": null }));
    assert_eq!(ids(&feed(&f.app, &full, "").await).len(), 4);

    // Signed out is signed out.
    feed(&f.app, &f.app.anon(), "").await.assert_status(401);
}

#[tokio::test]
async fn trashed_tables_projects_and_workspaces_are_left_out_until_restored() {
    let w = World::new().await;
    let f = &w.f;
    let deal = w.owner_hist(&w.deal, &f.table_id, "update", 1_000);
    let sprint = w.owner_hist(&w.sprint, &w.ops_table, "update", 2_000);
    let dishes = w.owner_hist(&w.dishes, &w.chores_table, "update", 3_000);
    assert_eq!(
        ids(&feed(&f.app, &f.owner, "").await),
        [dishes.clone(), sprint.clone(), deal.clone()]
    );

    schema_support::set_deleted_at(&f.app, "tables", &w.ops_table, 5_000);
    assert_eq!(
        ids(&feed(&f.app, &f.owner, "").await),
        [dishes.clone(), deal.clone()]
    );
    schema_support::set_deleted_at(&f.app, "bases", &w.chores, 5_000);
    assert_eq!(ids(&feed(&f.app, &f.owner, "").await), [deal.as_str()]);
    schema_support::set_deleted_at(&f.app, "workspaces", &f.ws, 5_000);
    assert!(ids(&feed(&f.app, &f.owner, "").await).is_empty());
    // Restored, it is all back.
    for (kind, id) in [
        ("workspaces", f.ws.as_str()),
        ("bases", w.chores.as_str()),
        ("tables", w.ops_table.as_str()),
    ] {
        f.app
            .state
            .db
            .write_sync(|tx| {
                tx.execute(
                    &format!("UPDATE {kind} SET deleted_at = NULL WHERE id = ?1"),
                    [id],
                )?;
                Ok(())
            })
            .unwrap();
    }
    assert_eq!(ids(&feed(&f.app, &f.owner, "").await).len(), 3);
}

#[tokio::test]
async fn records_show_their_current_name_and_whether_they_are_in_the_trash() {
    let f = Fixture::new().await;
    let rec = f
        .create(&f.table_id, json!({ &f.primary_id: "First name" }))
        .await;
    let id = id_str(&rec["id"]);
    f.set(&f.table_id, &id, json!({ &f.primary_id: "Second name" }))
        .await;
    let r = feed(&f.app, &f.owner, "").await;
    // Both entries say how the record is called now.
    assert_eq!(summary(&r), ["update:Second name", "create:Second name"]);
    assert_eq!(r.body["items"][0]["record"]["deleted"], false);
    assert_eq!(
        r.body["items"][0]["changes"][&f.primary_id],
        json!({ "old": "First name", "new": "Second name" })
    );

    f.delete_records(&f.table_id, &[&id])
        .await
        .assert_status(204);
    let r = feed(&f.app, &f.owner, "").await;
    assert_eq!(
        summary(&r),
        [
            "delete:Second name",
            "update:Second name",
            "create:Second name"
        ]
    );
    assert!(
        r.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["record"]["deleted"] == true)
    );
    f.restore_records(&f.table_id, &[&id])
        .await
        .assert_status(200);
    let r = feed(&f.app, &f.owner, "").await;
    assert_eq!(summary(&r)[0], "restore:Second name");
    assert_eq!(r.body["items"][0]["record"]["deleted"], false);
    let authors: Vec<&str> = r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["author"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(authors, ["Owner"; 4]);
}

#[tokio::test]
async fn link_values_show_names_and_every_changed_field_comes_with_its_definition() {
    let f = Fixture::new().await;
    let people = f.add_table("People").await;
    let people_id = people["id"].as_str().unwrap().to_string();
    let people_primary = people["primary_field_id"].as_str().unwrap().to_string();
    let link = f.add_link(&f.table_id, "Owner", &people_id).await;
    let link_id = link["id"].as_str().unwrap().to_string();
    let ada = f
        .create(&people_id, json!({ &people_primary: "Ada" }))
        .await;
    let ada_id = id_str(&ada["id"]);
    let deal = f
        .create(&f.table_id, json!({ &f.primary_id: "Deal" }))
        .await;
    let deal_id = id_str(&deal["id"]);
    f.set(
        &f.table_id,
        &deal_id,
        json!({ &link_id: [ada_id.as_str()] }),
    )
    .await;

    let r = feed(
        &f.app,
        &f.owner,
        &format!("table={}&kind=update", f.table_id),
    )
    .await;
    let item = &r.body["items"][0];
    assert_eq!(
        item["changes"][&link_id]["new"],
        json!([{ "id": ada_id, "name": "Ada" }])
    );
    assert_eq!(r.body["fields"][&link_id]["name"], "Owner");
    assert_eq!(r.body["fields"][&link_id]["type"], "link");
}

#[tokio::test]
async fn comments_added_through_the_api_appear() {
    let w = World::new().await;
    let f = &w.f;
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/records/{}/comments", w.deal),
            json!({ "body": "Looks good" }),
        )
        .await;
    r.assert_status(201);
    let r = feed(&f.app, &f.owner, "").await;
    assert_eq!(summary(&r), ["comment:Big deal"]);
    assert_eq!(r.body["items"][0]["comment"], "Looks good");
}

#[tokio::test]
async fn bad_parameters_are_rejected_and_limits_are_clamped() {
    let w = World::new().await;
    let f = &w.f;
    for n in 0..3 {
        w.owner_hist(&w.deal, &f.table_id, "update", 1_000 + n);
    }
    for bad in [
        "kind=nonsense",
        "order=sideways",
        "before=garbage",
        "before=MTox",
        "limit=-1",
        "limit=abc",
    ] {
        feed(&f.app, &f.owner, bad).await.assert_status(400);
    }
    assert_eq!(
        ids(&feed(&f.app, &f.owner, "limit=0").await).len(),
        1,
        "at least one"
    );
    assert_eq!(ids(&feed(&f.app, &f.owner, "limit=100000").await).len(), 3);
}
