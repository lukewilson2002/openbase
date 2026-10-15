//! The one Trash (`GET /api/trash`): everything the caller could restore across
//! their workspaces, its filters, where each item was and who deleted it, and
//! `deleted_by` being recorded on delete and cleared on restore.

mod common;
mod schema_support;

use common::{Client, Response, TestApp};
use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

const DAY: i64 = 24 * 3600 * 1000;

fn sid(v: &Value) -> &str {
    v.as_str().unwrap()
}

async fn trash(app: &TestApp, c: &Client, query: &str) -> Response {
    app.get(c, &format!("/api/trash{query}")).await
}

/// `(kind, id)` of each listed item, in order.
fn listed(r: &Response) -> Vec<(String, String)> {
    r.assert_status(200);
    r.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| (sid(&i["kind"]).to_string(), sid(&i["id"]).to_string()))
        .collect()
}

fn pair(kind: &str, id: &str) -> (String, String) {
    (kind.to_string(), id.to_string())
}

async fn delete_record(app: &TestApp, c: &Client, table: &str, id: &str) {
    app.request(
        c,
        "DELETE",
        &format!("/api/tables/{table}/records"),
        Some(json!({ "ids": [id] })),
    )
    .await
    .assert_status(204);
}

async fn restore(app: &TestApp, c: &Client, kind: &str, id: &str) -> Response {
    app.post(c, "/api/trash/restore", json!({ "kind": kind, "id": id }))
        .await
}

fn deleted_by(app: &TestApp, table: &str, id: &str) -> Option<String> {
    let (q, id) = (
        format!("SELECT deleted_by FROM {table} WHERE id = ?1"),
        id.to_string(),
    );
    sql(app, |tx| tx.query_row(&q, [&id], |r| r.get(0)))
}

/// Two workspaces of the fixture's owner, with something of every kind in the
/// trash: Acme (bases CRM and Ops) and Home (bases Chores and a trashed
/// Garden), plus a deleted workspace Old.
struct World {
    f: Fixture,
    home: String,
    ops: String,
    chores: String,
    chores_table: String,
    garden: String,
    old: String,
    crm_record: String,
    ops_record: String,
    chores_record: String,
    crm_table: String,
}

impl World {
    async fn new() -> World {
        let f = Fixture::new().await;
        let ops = base(&f.app, &f.owner, &f.ws, "Ops").await;
        let ops_table = sid(&ops["tables"][0]["id"]).to_string();
        let home = workspace(&f.app, &f.owner, "Home").await;
        let chores = base(&f.app, &f.owner, &home, "Chores").await;
        let chores_table = sid(&chores["tables"][0]["id"]).to_string();
        let garden = base(&f.app, &f.owner, &home, "Garden").await;
        let old = workspace(&f.app, &f.owner, "Old").await;

        let crm_record = f.insert_record(&f.table_id, json!({ &f.primary_id: "Call Ada" }));
        let ops_primary = sid(&ops["tables"][0]["primary_field_id"]).to_string();
        let ops_record = insert_record(&f.app, &ops_table, json!({ ops_primary: "Invoice" }));
        let chores_primary = sid(&chores["tables"][0]["primary_field_id"]).to_string();
        let chores_record =
            insert_record(&f.app, &chores_table, json!({ chores_primary: "Dishes" }));
        let crm_table = sid(&f.add_table("Leads").await["id"]).to_string();

        delete_record(&f.app, &f.owner, &f.table_id, &crm_record).await;
        delete_record(&f.app, &f.owner, &ops_table, &ops_record).await;
        delete_record(&f.app, &f.owner, &chores_table, &chores_record).await;
        f.app
            .delete(&f.owner, &format!("/api/tables/{crm_table}"))
            .await
            .assert_status(200);
        let garden_id = sid(&garden["id"]).to_string();
        f.app
            .delete(&f.owner, &format!("/api/bases/{garden_id}"))
            .await
            .assert_status(200);
        f.app
            .delete(&f.owner, &format!("/api/workspaces/{old}"))
            .await
            .assert_status(200);

        // Deterministic order whatever the clock resolution.
        set_deleted_at(&f.app, "workspaces", &old, 7_000);
        set_deleted_at(&f.app, "bases", &garden_id, 6_000);
        set_deleted_at(&f.app, "tables", &crm_table, 5_000);
        set_deleted_at(&f.app, "records", &chores_record, 4_000);
        set_deleted_at(&f.app, "records", &ops_record, 3_000);
        set_deleted_at(&f.app, "records", &crm_record, 2_000);
        World {
            home,
            ops: sid(&ops["id"]).to_string(),
            chores: sid(&chores["id"]).to_string(),
            chores_table,
            garden: garden_id,
            old,
            crm_record,
            ops_record,
            chores_record,
            crm_table,
            f,
        }
    }
}

#[tokio::test]
async fn one_trash_lists_every_workspace_newest_first_with_where_and_who() {
    let w = World::new().await;
    let f = &w.f;
    let r = trash(&f.app, &f.owner, "").await;
    assert_eq!(
        listed(&r),
        [
            pair("workspace", &w.old),
            pair("base", &w.garden),
            pair("table", &w.crm_table),
            pair("record", &w.chores_record),
            pair("record", &w.ops_record),
            pair("record", &w.crm_record),
        ]
    );
    let items = r.body["items"].as_array().unwrap();
    let ws_color = |id: &str| {
        let list = &listed_workspaces(&f.app, &f.owner);
        list.iter().find(|(i, _)| i == id).map(|(_, c)| c.clone())
    };

    let old = &items[0];
    assert_eq!(old["name"], "Old");
    assert_eq!(old["workspace_id"], w.old.as_str());
    assert_eq!(old["workspace_name"], "Old");
    assert!(old["workspace_color"].is_string());
    assert!(old["base_id"].is_null() && old["base_name"].is_null());
    assert_eq!(old["deleted_by_id"], f.owner.user_id.as_deref().unwrap());
    assert_eq!(old["deleted_by_name"], "Owner");
    assert_eq!(old["expires_at"], 7_000 + 30 * DAY);

    // A trashed base describes itself, so the client can draw its tile.
    let garden = &items[1];
    assert_eq!(garden["workspace_name"], "Home");
    assert_eq!(
        garden["workspace_color"].as_str(),
        ws_color(&w.home).as_deref()
    );
    assert_eq!(garden["base_id"], w.garden.as_str());
    assert_eq!(garden["base_name"], "Garden");
    assert_eq!(garden["base_color"], "blue");
    assert!(garden["table_name"].is_null());

    let table = &items[2];
    assert_eq!(table["name"], "Leads");
    assert_eq!(table["base_name"], "CRM");
    assert_eq!(table["workspace_name"], "Acme");
    assert!(table["table_id"].is_null() && table["table_name"].is_null());

    let dishes = &items[3];
    assert_eq!(dishes["name"], "Dishes");
    assert_eq!(dishes["table_id"], w.chores_table.as_str());
    assert_eq!(dishes["table_name"], "Table 1");
    assert_eq!(dishes["base_id"], w.chores.as_str());
    assert_eq!(dishes["base_name"], "Chores");
    assert_eq!(dishes["workspace_id"], w.home.as_str());
    assert_eq!(dishes["deleted_by_name"], "Owner");
    assert_eq!(dishes["expires_at"], 4_000 + 30 * DAY);

    // Items trashed before deleted_by was recorded show no one.
    sql(&f.app, |tx| {
        tx.execute(
            "UPDATE records SET deleted_by = NULL WHERE id = ?1",
            [&w.crm_record],
        )
    });
    let r = trash(&f.app, &f.owner, "").await;
    let last = &r.body["items"][5];
    assert_eq!(last["id"], w.crm_record.as_str());
    assert!(last["deleted_by_id"].is_null() && last["deleted_by_name"].is_null());

    // The retention comes from the server's configuration.
    let short = Fixture::with_config(|c| c.trash_days = 7).await;
    let rec = short.insert_record(&short.table_id, json!({}));
    delete_record(&short.app, &short.owner, &short.table_id, &rec).await;
    set_deleted_at(&short.app, "records", &rec, 1_000);
    let r = trash(&short.app, &short.owner, "").await;
    assert_eq!(r.body["items"][0]["expires_at"], 1_000 + 7 * DAY);

    trash(&f.app, &f.app.anon(), "").await.assert_status(401);
}

fn listed_workspaces(app: &TestApp, owner: &Client) -> Vec<(String, String)> {
    let uid = owner.user_id.clone().unwrap();
    sql(app, |tx| {
        let mut stmt = tx.prepare(
            "SELECT w.id, w.color FROM workspaces w JOIN workspace_members m
             ON m.workspace_id = w.id WHERE m.user_id = ?1",
        )?;
        let rows = stmt.query_map([&uid], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    })
}

#[tokio::test]
async fn one_trash_filters_by_workspace_base_and_kind() {
    let w = World::new().await;
    let (app, owner) = (&w.f.app, &w.f.owner);
    let q = async |query: &str| listed(&trash(app, owner, query).await);

    assert_eq!(
        q(&format!("?workspace_id={}", w.home)).await,
        [pair("base", &w.garden), pair("record", &w.chores_record)]
    );
    assert_eq!(
        q(&format!("?workspace_id={}", w.f.ws)).await,
        [
            pair("table", &w.crm_table),
            pair("record", &w.ops_record),
            pair("record", &w.crm_record),
        ]
    );
    // A deleted workspace is found under its own id.
    assert_eq!(
        q(&format!("?workspace_id={}", w.old)).await,
        [pair("workspace", &w.old)]
    );
    assert_eq!(
        q(&format!("?base_id={}", w.ops)).await,
        [pair("record", &w.ops_record)]
    );
    assert_eq!(
        q(&format!("?base_id={}", w.garden)).await,
        [pair("base", &w.garden)]
    );
    assert_eq!(q("?kind=workspace").await, [pair("workspace", &w.old)]);
    assert_eq!(q("?kind=base").await, [pair("base", &w.garden)]);
    assert_eq!(q("?kind=table").await, [pair("table", &w.crm_table)]);
    assert_eq!(
        q("?kind=record").await,
        [
            pair("record", &w.chores_record),
            pair("record", &w.ops_record),
            pair("record", &w.crm_record),
        ]
    );
    assert!(q("?kind=field").await.is_empty());
    assert_eq!(
        q(&format!(
            "?workspace_id={}&base_id={}&kind=record",
            w.f.ws, w.f.base_id
        ))
        .await,
        [pair("record", &w.crm_record)]
    );
    // Filters that contradict each other, or point at nothing, list nothing.
    assert!(
        q(&format!("?workspace_id={}&base_id={}", w.home, w.ops))
            .await
            .is_empty()
    );
    assert!(q("?base_id=appNOPE").await.is_empty());
    // Empty parameters are no filter; an unknown kind is an error.
    assert_eq!(q("?workspace_id=&base_id=&kind=").await.len(), 6);
    let r = trash(app, owner, "?kind=thing").await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn one_trash_lists_only_what_the_caller_could_restore() {
    let w = World::new().await;
    let f = &w.f;
    // Someone else's personal view and a shared view in CRM, both trashed.
    let editor = f.member("ed@example.com", Role::Editor);
    let own_view = f
        .app
        .post(
            &editor,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    own_view.assert_status(201);
    let own_view = sid(&own_view.body["id"]).to_string();
    f.app
        .delete(&editor, &format!("/api/views/{own_view}"))
        .await
        .assert_status(200);
    let shared = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Shared", "type": "grid" }),
        )
        .await;
    let shared = sid(&shared.body["id"]).to_string();
    f.app
        .delete(&f.owner, &format!("/api/views/{shared}"))
        .await
        .assert_status(200);
    set_deleted_at(&f.app, "views", &own_view, 1_000);
    set_deleted_at(&f.app, "views", &shared, 900);

    // The owner sees the shared view but not the editor's personal one.
    let all = listed(&trash(&f.app, &f.owner, "").await);
    assert!(all.contains(&pair("view", &shared)));
    assert!(!all.contains(&pair("view", &own_view)));

    // An editor of every base sees only their own personal view.
    assert_eq!(
        listed(&trash(&f.app, &editor, "").await),
        [pair("view", &own_view)]
    );

    // A creator of every base of Acme sees Acme's tables and records, but not
    // its trashed bases or deleted workspaces (owners restore those), and
    // nothing of Home, where they are not a member.
    let creator = f.member("cr@example.com", Role::Creator);
    assert_eq!(
        listed(&trash(&f.app, &creator, "").await),
        [
            pair("table", &w.crm_table),
            pair("record", &w.ops_record),
            pair("record", &w.crm_record),
            pair("view", &shared),
        ]
    );

    // A creator limited to CRM does not see Ops' trash.
    let guest = f.base_guest("guest@example.com", Role::Creator);
    let guest_sees = listed(&trash(&f.app, &guest, "").await);
    assert_eq!(
        guest_sees,
        [
            pair("table", &w.crm_table),
            pair("record", &w.crm_record),
            pair("view", &shared),
        ]
    );
    assert!(
        listed(&trash(&f.app, &guest, &format!("?base_id={}", w.ops)).await).is_empty(),
        "filtering by a base they cannot open shows nothing"
    );

    // A creator of a deleted workspace does not see it: only owners restore it.
    add_ws_member(&f.app, &w.old, &creator, Role::Creator);
    assert!(!listed(&trash(&f.app, &creator, "").await).contains(&pair("workspace", &w.old)));

    // Someone invited but not joined, and a stranger, see nothing.
    f.app
        .post(
            &f.owner,
            &format!("/api/workspaces/{}/invites", f.ws),
            json!({ "role": "creator", "email": "later@example.com" }),
        )
        .await
        .assert_status(201);
    let later = f.app.user("later@example.com", "Later");
    assert!(listed(&trash(&f.app, &later, "").await).is_empty());
    let stranger = f.app.user("s@example.com", "S");
    assert!(listed(&trash(&f.app, &stranger, "").await).is_empty());

    // Tokens: without the manage permission no bases or workspaces; read-only
    // tokens act as viewers; a base-limited token only sees its base.
    let write = token_client(&f.app, &f.owner, true);
    let kinds: Vec<String> = listed(&trash(&f.app, &write, "").await)
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    assert!(!kinds.iter().any(|k| k == "workspace" || k == "base"));
    assert!(kinds.iter().any(|k| k == "record"));
    let read_only = token_client(&f.app, &f.owner, false);
    assert!(listed(&trash(&f.app, &read_only, "").await).is_empty());
    let manage = f.app.raw_token(
        &f.owner,
        json!({ "write": true, "manage": true, "base_ids": null }),
    );
    assert_eq!(listed(&trash(&f.app, &manage, "").await), all);
    let limited = f.app.raw_token(
        &f.owner,
        json!({ "write": true, "manage": true, "base_ids": [w.garden, f.base_id] }),
    );
    assert_eq!(
        listed(&trash(&f.app, &limited, "").await),
        [
            pair("base", &w.garden),
            pair("table", &w.crm_table),
            pair("record", &w.crm_record),
            pair("view", &shared),
        ]
    );

    // Whatever is listed can be restored by the one who sees it.
    for (who, c) in [
        ("guest", &guest),
        ("editor", &editor),
        ("limited", &limited),
    ] {
        for (kind, id) in listed(&trash(&f.app, c, "").await) {
            let r = restore(&f.app, c, &kind, &id).await;
            assert_eq!(r.status.as_u16(), 200, "{who} restoring {kind} {id}");
        }
    }
}

#[tokio::test]
async fn deleted_by_is_recorded_for_every_kind_and_cleared_on_restore() {
    let f = Fixture::new().await;
    let creator = f.member("cr@example.com", Role::Creator);
    // A second table linked from the first: trashing it also trashes the link
    // field pointing at it, recorded as deleted by the same person.
    let other = f.add_table("Projects").await;
    let other_id = sid(&other["id"]).to_string();
    let link = f.add_link(&f.table_id, "Project", &other_id).await;
    let link_id = sid(&link["id"]).to_string();
    let qty = f
        .add_field(
            &f.table_id,
            json!({ "name": "Qty", "type": "number", "options": {} }),
        )
        .await;
    let qty = sid(&qty["id"]).to_string();
    let view = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Board", "type": "grid" }),
        )
        .await;
    let view = sid(&view.body["id"]).to_string();
    let rec = f.insert_record(&f.table_id, json!({ &f.primary_id: "Ada" }));

    let creator_id = creator.user_id.clone().unwrap();
    let owner_id = f.owner.user_id.clone().unwrap();
    f.app
        .delete(&creator, &format!("/api/tables/{other_id}"))
        .await
        .assert_status(200);
    assert_eq!(
        deleted_by(&f.app, "tables", &other_id),
        Some(creator_id.clone())
    );
    assert_eq!(
        deleted_by(&f.app, "fields", &link_id),
        Some(creator_id.clone())
    );
    f.app
        .delete(&f.owner, &format!("/api/fields/{qty}"))
        .await
        .assert_status(200);
    assert_eq!(deleted_by(&f.app, "fields", &qty), Some(owner_id.clone()));
    f.app
        .delete(&creator, &format!("/api/views/{view}"))
        .await
        .assert_status(200);
    assert_eq!(deleted_by(&f.app, "views", &view), Some(creator_id.clone()));
    delete_record(&f.app, &creator, &f.table_id, &rec).await;
    assert_eq!(
        deleted_by(&f.app, "records", &rec),
        Some(creator_id.clone())
    );

    // The base's own trash names them too.
    let r = f
        .app
        .get(&f.owner, &format!("/api/bases/{}/trash", f.base_id))
        .await;
    r.assert_status(200);
    for item in r.body["items"].as_array().unwrap() {
        let expected = if item["id"] == qty.as_str() {
            "Owner"
        } else {
            "cr@example.com"
        };
        assert_eq!(item["deleted_by_name"], expected, "{item}");
        assert_eq!(item["workspace_name"], "Acme");
        assert_eq!(item["base_name"], "CRM");
    }

    for (kind, table, id) in [
        ("record", "records", &rec),
        ("view", "views", &view),
        ("field", "fields", &qty),
        ("table", "tables", &other_id),
    ] {
        restore(&f.app, &f.owner, kind, id).await.assert_status(200);
        assert_eq!(deleted_by(&f.app, table, id), None, "{kind}");
    }
    assert_eq!(deleted_by(&f.app, "fields", &link_id), None);

    // Bases and workspaces.
    f.app
        .delete(&f.owner, &format!("/api/bases/{}", f.base_id))
        .await
        .assert_status(200);
    assert_eq!(
        deleted_by(&f.app, "bases", &f.base_id),
        Some(owner_id.clone())
    );
    let r = f
        .app
        .get(&f.owner, &format!("/api/workspaces/{}/trash", f.ws))
        .await;
    assert_eq!(r.body["items"][0]["deleted_by_name"], "Owner");
    assert_eq!(r.body["items"][0]["base_color"], "blue");
    restore(&f.app, &f.owner, "base", &f.base_id)
        .await
        .assert_status(200);
    assert_eq!(deleted_by(&f.app, "bases", &f.base_id), None);

    f.app
        .delete(&f.owner, &format!("/api/workspaces/{}", f.ws))
        .await
        .assert_status(200);
    assert_eq!(deleted_by(&f.app, "workspaces", &f.ws), Some(owner_id));
    let r = f.app.get(&f.owner, "/api/trash/workspaces").await;
    assert_eq!(r.body["items"][0]["deleted_by_name"], "Owner");
    restore(&f.app, &f.owner, "workspace", &f.ws)
        .await
        .assert_status(200);
    assert_eq!(deleted_by(&f.app, "workspaces", &f.ws), None);
}
