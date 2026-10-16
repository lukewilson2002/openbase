//! The curated MCP data tools, through the real router: happy paths, errors that name valid
//! tables and fields, permissions and token scope, and that writes behave exactly like API
//! writes (history attributed to the token's user, live-update events, automations).

mod automations_support;
mod common;
mod mcp_support;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;
mod sse_support;

use common::Client;
use mcp_support::*;
use ob_core::api::events::BaseEvent;
use query_support::*;
use serde_json::{Value, json};

struct Rig {
    p: People,
    read: Client,
    write: Client,
}

async fn rig() -> Rig {
    let p = people().await;
    let owner = p.f.owner.clone();
    let read =
        p.f.app
            .api_token(&owner, json!({"name": "r", "write": false}))
            .await;
    let write =
        p.f.app
            .api_token(&owner, json!({"name": "w", "write": true}))
            .await;
    Rig { p, read, write }
}

impl Rig {
    fn app(&self) -> &common::TestApp {
        &self.p.f.app
    }
    fn base(&self) -> &str {
        &self.p.f.base_id
    }
}

fn names_of(records: &Value) -> Vec<String> {
    records
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["fields"]["Name"].as_str().unwrap_or_default().to_string())
        .collect()
}

// ---------------------------------------------------------------- discovery tools

#[tokio::test]
async fn list_bases_shows_what_the_token_can_reach() {
    let r = rig().await;
    let t = tool(r.app(), &r.write, "list_bases", json!({})).await;
    let v = t.ok();
    assert_eq!(v["access"], "read and write");
    let ws = &v["workspaces"][0];
    assert_eq!(ws["name"], "Acme");
    assert_eq!(ws["bases"][0]["id"], r.base());
    assert_eq!(ws["bases"][0]["role"], "owner");
    assert!(
        t.text.starts_with('{') && !t.text.contains('\n'),
        "compact JSON text"
    );
    assert_eq!(serde_json::from_str::<Value>(&t.text).unwrap(), *v);

    // Read-only tokens act as viewers and are told so.
    let v = tool(r.app(), &r.read, "list_bases", json!({}))
        .await
        .ok()
        .clone();
    assert_eq!(v["access"], "read-only");
    assert_eq!(v["workspaces"][0]["bases"][0]["role"], "viewer");

    // A base-limited token lists only its base, and not workspaces it has no base in.
    let (_ws2, other) = r.app().workspace_with_base(&r.p.f.owner, "Secret");
    let limited = r
        .app()
        .api_token(
            &r.p.f.owner,
            json!({"name": "l", "write": true, "base_ids": [r.base()]}),
        )
        .await;
    let v = tool(r.app(), &limited, "list_bases", json!({}))
        .await
        .ok()
        .clone();
    let listed = v["workspaces"].as_array().unwrap();
    assert_eq!(listed.len(), 1, "{v}");
    assert_eq!(listed[0]["bases"].as_array().unwrap().len(), 1);
    assert!(!v.to_string().contains(&other) && !v.to_string().contains("Secret"));

    // Arguments are not accepted.
    let t = tool(r.app(), &r.write, "list_bases", json!({"x": 1})).await;
    assert!(t.err().contains("no arguments"));
}

#[tokio::test]
async fn get_base_schema_lists_tables_fields_and_views() {
    let r = rig().await;
    let t = tool(
        r.app(),
        &r.read,
        "get_base_schema",
        json!({"base_id": r.base()}),
    )
    .await;
    let v = t.ok();
    assert_eq!(v["name"], "CRM");
    assert_eq!(v["your_role"], "viewer");
    let table = &v["tables"][0];
    assert_eq!(table["name"], "Table 1");
    assert_eq!(table["primary_field"], "Name");
    let fields = table["fields"].as_array().unwrap();
    let by_name = |n: &str| {
        fields
            .iter()
            .find(|f| f["name"] == n)
            .unwrap_or_else(|| panic!("no field {n}"))
    };
    assert_eq!(by_name("Age")["type"], "number");
    assert_eq!(by_name("Status")["type"], "single_select");
    let choices: Vec<&str> = by_name("Status")["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(choices, ["Todo", "Doing", "Done"]);
    assert!(by_name("Name")["id"].as_str().unwrap().starts_with("fld"));
    assert_eq!(table["views"][0]["type"], "grid");

    // Unknown base and a base outside the token's scope answer identically: no existence leak.
    let (_ws2, other) = r.app().workspace_with_base(&r.p.f.owner, "Secret");
    let limited = r
        .app()
        .api_token(
            &r.p.f.owner,
            json!({"name": "l", "write": false, "base_ids": [r.base()]}),
        )
        .await;
    let outside = tool(
        r.app(),
        &limited,
        "get_base_schema",
        json!({"base_id": other}),
    )
    .await;
    let missing = tool(
        r.app(),
        &limited,
        "get_base_schema",
        json!({"base_id": "appNoSuchBase"}),
    )
    .await;
    assert!(outside.err().contains("not found, or you have no access"));
    assert!(outside.err().contains("list_bases"));
    assert_eq!(
        outside.text.replace(&other, "X"),
        missing.text.replace("appNoSuchBase", "X")
    );
    // Missing or unknown arguments are explained.
    let t = tool(r.app(), &r.read, "get_base_schema", json!({})).await;
    assert!(t.err().contains("missing field `base_id`"), "{}", t.text);
    let t = tool(
        r.app(),
        &r.read,
        "get_base_schema",
        json!({"base_id": r.base(), "extra": 1}),
    )
    .await;
    assert!(t.err().contains("unknown field `extra`"), "{}", t.text);
}

// ------------------------------------------------------------------- reading

#[tokio::test]
async fn list_records_returns_airtable_shaped_records_by_field_name() {
    let r = rig().await;
    let t = tool(
        r.app(),
        &r.read,
        "list_records",
        json!({"base_id": r.base(), "table": "Table 1"}),
    )
    .await;
    let v = t.ok();
    assert_eq!(v["count"], 5);
    assert!(v.get("offset").is_none() && v.get("more_records").is_none());
    let first = &v["records"][0];
    assert!(first["id"].as_str().unwrap().starts_with("rec"));
    assert!(first["createdTime"].as_str().unwrap().ends_with('Z'));
    assert_eq!(first["fields"]["Name"], "Alice");
    assert_eq!(first["fields"]["Age"], 30);
    assert_eq!(first["fields"]["Status"], "Todo");
    assert_eq!(first["fields"]["Tags"], json!(["a"]));
    assert_eq!(first["fields"]["Due"], "2026-03-01");
    // Empty cells are omitted; the table can be named by id too.
    let t = tool(
        r.app(),
        &r.read,
        "list_records",
        json!({"base_id": r.base(), "table": r.p.f.table_id}),
    )
    .await;
    let dave = &t.ok()["records"][3];
    assert_eq!(dave["fields"], json!({"Name": "dave"}));
}

#[tokio::test]
async fn list_records_selects_fields_sorts_filters_and_uses_views() {
    let r = rig().await;
    let call = |args: Value| {
        let r = &r;
        async move {
            let mut a = json!({"base_id": r.base(), "table": "Table 1"});
            for (k, v) in args.as_object().unwrap() {
                a[k] = v.clone();
            }
            tool(r.app(), &r.read, "list_records", a).await
        }
    };
    // Field selection.
    let t = call(json!({"fields": ["Name", "Age"]})).await;
    let rec = &t.ok()["records"][0]["fields"];
    assert_eq!(rec, &json!({"Name": "Alice", "Age": 30}));
    // Sorting, two levels.
    let t = call(json!({"sort": [{"field": "Age", "direction": "desc"}, {"field": "Name"}], "fields": ["Name"]})).await;
    let names = names_of(&t.ok()["records"]);
    assert_eq!(names, ["Carol", "Alice", "Eve", "bob", "dave"]);
    // filterByFormula.
    let t = call(json!({"filter_by_formula": "{Status}='Todo'", "fields": ["Name"]})).await;
    assert_eq!(names_of(&t.ok()["records"]), ["Alice", "Eve"]);
    let t =
        call(json!({"filter_by_formula": "AND({Age}>=30, NOT({Done}))", "fields": ["Name"]})).await;
    assert_eq!(names_of(&t.ok()["records"]), ["Alice", "Eve"]);
    // A saved view's sorting applies (by name).
    let age = r.p.age.clone();
    r.p.f
        .new_view(
            &r.p.f.table_id,
            "By age",
            json!({"sorts": [{"field_id": age, "direction": "asc"}]}),
        )
        .await;
    let t = call(json!({"view": "By age", "fields": ["Name"], "max_records": 2})).await;
    assert_eq!(names_of(&t.ok()["records"]), ["dave", "bob"]);
}

#[tokio::test]
async fn list_records_pages_with_max_records_and_offset() {
    let r = rig().await;
    let mut seen = Vec::new();
    let mut offset: Option<String> = None;
    let mut calls = 0;
    loop {
        let mut args =
            json!({"base_id": r.base(), "table": "Table 1", "max_records": 2, "fields": ["Name"]});
        if let Some(o) = &offset {
            args["offset"] = json!(o);
        }
        let t = tool(r.app(), &r.read, "list_records", args).await;
        let v = t.ok();
        seen.extend(names_of(&v["records"]));
        calls += 1;
        match v.get("offset").and_then(Value::as_str) {
            Some(o) => {
                assert_eq!(v["more_records"], true);
                assert!(v["hint"].as_str().unwrap().contains("offset"));
                offset = Some(o.to_string());
            }
            None => break,
        }
    }
    assert_eq!(calls, 3);
    assert_eq!(seen, ["Alice", "bob", "Carol", "dave", "Eve"]);

    // The cap is 200; larger requests are clamped and say so.
    let t = tool(
        r.app(),
        &r.read,
        "list_records",
        json!({"base_id": r.base(), "table": "Table 1", "max_records": 5000}),
    )
    .await;
    assert!(t.ok()["note"].as_str().unwrap().contains("capped at 200"));
    // A stale offset is a clear error.
    let t = tool(
        r.app(),
        &r.read,
        "list_records",
        json!({"base_id": r.base(), "table": "Table 1", "offset": "itrBogus/rec0"}),
    )
    .await;
    assert!(t.err().contains("offset"), "{}", t.text);
}

#[tokio::test]
async fn list_records_errors_list_valid_names() {
    let r = rig().await;
    let base = r.base().to_string();
    let call = |args: Value| {
        let (r, base) = (&r, base.clone());
        async move {
            let mut a = json!({"base_id": base});
            for (k, v) in args.as_object().unwrap() {
                a[k] = v.clone();
            }
            tool(r.app(), &r.read, "list_records", a).await
        }
    };
    let t = call(json!({"table": "Nope"})).await;
    let msg = t.err();
    assert!(msg.contains("Table not found"), "{msg}");
    assert!(msg.contains("Tables in this base: 'Table 1'"), "{msg}");

    let t = call(json!({"table": "Table 1", "fields": ["Name", "Agee"]})).await;
    let msg = t.err();
    assert!(msg.contains("Unknown field name: \"Agee\""), "{msg}");
    assert!(
        msg.contains(
            "Fields of 'Table 1': 'Name', 'Notes', 'Age', 'Status', 'Tags', 'Due', 'Done'"
        ),
        "{msg}"
    );

    let t = call(json!({"table": "Table 1", "sort": [{"field": "Nope"}]})).await;
    assert!(t.err().contains("Unknown field name"), "{}", t.text);
    let t = call(json!({"table": "Table 1", "view": "Missing view"})).await;
    let msg = t.err();
    assert!(
        msg.contains("Missing view") && msg.contains("Views:"),
        "{msg}"
    );
    let t = call(json!({"table": "Table 1", "filter_by_formula": "{Status} ="})).await;
    assert!(t.err().contains("INVALID_FILTER_BY_FORMULA"), "{}", t.text);
    let t = call(json!({"table": "Table 1", "sort": [{"field": "Name", "direction": "up"}]})).await;
    assert!(t.err().contains("asc"), "{}", t.text);
    let t = call(json!({"table": "Table 1", "limit": 5})).await;
    assert!(t.err().contains("unknown field `limit`"), "{}", t.text);
    let t = call(json!({"table": "Table 1", "max_records": "many"})).await;
    assert!(t.err().contains("Invalid arguments"), "{}", t.text);
}

#[tokio::test]
async fn list_records_shows_linked_records_by_name() {
    let r = rig().await;
    let f = &r.p.f;
    let projects = f.add_table("Projects").await;
    let projects_id = id_of(&projects);
    let link = f.add_link(&f.table_id, "Project", &projects_id).await;
    let apollo = f
        .app
        .post(
            &f.owner,
            &records_url(&projects_id),
            json!({"records": [{"values": {projects["primary_field_id"].as_str().unwrap(): "Apollo"}}]}),
        )
        .await;
    apollo.assert_status(201);
    let apollo_id = id_of(&apollo.body["records"][0]);
    f.app
        .patch(
            &f.owner,
            &records_url(&f.table_id),
            json!({"records": [{"id": r.p.ids[0], "values": {id_of(&link): [apollo_id]}}]}),
        )
        .await
        .assert_status(200);
    let t = tool(
        r.app(),
        &r.read,
        "list_records",
        json!({"base_id": r.base(), "table": "Table 1", "fields": ["Name", "Project"], "max_records": 1}),
    )
    .await;
    assert_eq!(
        t.ok()["records"][0]["fields"]["Project"],
        json!([{"id": apollo_id, "name": "Apollo"}])
    );
}

#[tokio::test]
async fn search_records_finds_text_in_any_field() {
    let r = rig().await;
    let search = |q: &str| {
        let (r, q) = (&r, q.to_string());
        async move {
            tool(
                r.app(),
                &r.read,
                "search_records",
                json!({"base_id": r.base(), "table": "Table 1", "query": q, "max_records": 10}),
            )
            .await
        }
    };
    assert_eq!(names_of(&search("ALI").await.ok()["records"]), ["Alice"]);
    // Select options are searched by their text.
    assert_eq!(names_of(&search("done").await.ok()["records"]), ["Carol"]);
    assert_eq!(search("zzz-nothing").await.ok()["count"], 0);
    assert!(search("   ").await.err().contains("must not be empty"));
    assert!(search(&"x".repeat(501)).await.err().contains("too long"));
    let t = tool(
        r.app(),
        &r.read,
        "search_records",
        json!({"base_id": r.base(), "table": "Nope", "query": "a"}),
    )
    .await;
    assert!(t.err().contains("Tables in this base"));
}

#[tokio::test]
async fn get_record_returns_one_record_or_explains() {
    let r = rig().await;
    let t = tool(
        r.app(),
        &r.read,
        "get_record",
        json!({"base_id": r.base(), "table": "Table 1", "record_id": r.p.ids[2]}),
    )
    .await;
    let v = t.ok();
    assert_eq!(v["id"], r.p.ids[2].as_str());
    assert_eq!(v["fields"]["Name"], "Carol");
    assert_eq!(v["fields"]["Done"], true);
    let t = tool(
        r.app(),
        &r.read,
        "get_record",
        json!({"base_id": r.base(), "table": "Table 1", "record_id": "recNope"}),
    )
    .await;
    assert!(t.err().contains("Record 'recNope' not found"), "{}", t.text);
}

// ------------------------------------------------------------------- writing

#[tokio::test]
async fn create_records_writes_like_the_api() {
    let r = rig().await;
    let mut rx = r.app().state.events.subscribe(r.base());
    let t = tool(
        r.app(),
        &r.write,
        "create_records",
        json!({
            "base_id": r.base(),
            "table": "Table 1",
            "records": [
                {"fields": {"Name": "Zed", "Age": 50, "Status": "Blocked", "Tags": ["a", "new-tag"], "Due": "2026-04-01", "Done": true}},
                {"fields": {"Name": "Yan"}},
            ],
        }),
    )
    .await;
    let v = t.ok();
    assert_eq!(v["count"], 2);
    let zed = &v["created"][0];
    assert_eq!(zed["fields"]["Name"], "Zed");
    assert_eq!(
        zed["fields"]["Status"], "Blocked",
        "typecast created the choice"
    );
    assert_eq!(zed["fields"]["Tags"], json!(["a", "new-tag"]));
    let id = zed["id"].as_str().unwrap().to_string();

    // The record is really there, for the web app too.
    let q = r.p.f.query(json!({"search": "Zed"})).await;
    assert_eq!(q["total"], 1);
    // History is attributed to the token's user, as an API write.
    let hist = r.p.f.history(&id);
    assert_eq!(hist.len(), 1);
    assert_eq!(hist[0].0, "create");
    assert_eq!(hist[0].2, r.p.f.owner.user_id);
    // The write published its event after commit.
    // The new select choices changed the schema; the records change follows. Both carry the
    // token's user.
    let mut events = Vec::new();
    while let Ok(env) = rx.try_recv() {
        assert_eq!(env.user_id.as_deref(), r.p.f.owner.user_id.as_deref());
        events.push(env.event.clone());
    }
    assert!(
        events
            .iter()
            .any(|e| matches!(e, BaseEvent::SchemaChanged { .. })),
        "{events:?}"
    );
    let created: Vec<&Vec<String>> = events
        .iter()
        .filter_map(|e| match e {
            BaseEvent::RecordsChanged {
                table_id, created, ..
            } if table_id == &r.p.f.table_id => Some(created),
            _ => None,
        })
        .collect();
    assert_eq!(created.len(), 1, "{events:?}");
    assert_eq!(created[0].len(), 2);
}

#[tokio::test]
async fn create_records_respects_typecast_and_validation() {
    let r = rig().await;
    let create = |args: Value| {
        let r = &r;
        async move {
            let mut a = json!({"base_id": r.base(), "table": "Table 1"});
            for (k, v) in args.as_object().unwrap() {
                a[k] = v.clone();
            }
            tool(r.app(), &r.write, "create_records", a).await
        }
    };
    // Without typecast, an unknown choice is refused and nothing is created.
    let before = r.p.f.query(json!({})).await["total"].clone();
    let t = create(
        json!({"records": [{"fields": {"Name": "X", "Status": "Nope"}}], "typecast": false}),
    )
    .await;
    assert!(
        t.err().contains("INVALID_MULTIPLE_CHOICE_OPTIONS"),
        "{}",
        t.text
    );
    // Unknown field: names the fields.
    let t = create(json!({"records": [{"fields": {"Nam": "X"}}]})).await;
    let msg = t.err();
    assert!(
        msg.contains("Unknown field name: \"Nam\"") && msg.contains("Fields of 'Table 1'"),
        "{msg}"
    );
    // Wrong type, computed fields, batch sizes.
    let t =
        create(json!({"records": [{"fields": {"Name": "X", "Age": "old"}}], "typecast": false}))
            .await;
    assert!(t.err().contains("Age"), "{}", t.text);
    let eleven: Vec<Value> = (0..11)
        .map(|i| json!({"fields": {"Name": format!("n{i}")}}))
        .collect();
    let t = create(json!({"records": eleven})).await;
    assert!(t.err().contains("at most 10"), "{}", t.text);
    let t = create(json!({"records": []})).await;
    assert!(t.err().contains("at least one"), "{}", t.text);
    let t = create(json!({"records": [{"fields": {"Name": "X"}, "id": "rec1"}]})).await;
    assert!(t.err().contains("unknown field `id`"), "{}", t.text);
    // All or nothing: the failures created nothing.
    assert_eq!(r.p.f.query(json!({})).await["total"], before);
    let t = create(json!({"table": "Missing", "records": [{"fields": {"Name": "X"}}]})).await;
    assert!(t.err().contains("Tables in this base"), "{}", t.text);
}

#[tokio::test]
async fn update_records_merges_and_attributes_history() {
    let r = rig().await;
    let alice = r.p.ids[0].clone();
    let mut rx = r.app().state.events.subscribe(r.base());
    let t = tool(
        r.app(),
        &r.write,
        "update_records",
        json!({
            "base_id": r.base(),
            "table": "Table 1",
            "records": [
                {"id": alice, "fields": {"Age": 31, "Status": "Done"}},
                {"id": r.p.ids[3], "fields": {"Name": "Dave Dee"}},
            ],
        }),
    )
    .await;
    let v = t.ok();
    assert_eq!(v["count"], 2);
    assert_eq!(v["updated"][0]["fields"]["Age"], 31);
    assert_eq!(
        v["updated"][0]["fields"]["Name"], "Alice",
        "untouched fields stay"
    );
    assert_eq!(v["updated"][1]["fields"]["Name"], "Dave Dee");
    let hist = r.p.f.history(&alice);
    assert_eq!(hist.last().unwrap().0, "update");
    assert_eq!(hist.last().unwrap().2, r.p.f.owner.user_id);
    let env = rx.try_recv().expect("event");
    assert!(
        matches!(env.event, BaseEvent::RecordsChanged { ref updated, .. } if updated.len() == 2)
    );

    // null clears a cell.
    tool(
        r.app(),
        &r.write,
        "update_records",
        json!({"base_id": r.base(), "table": "Table 1", "records": [{"id": alice, "fields": {"Age": null}}]}),
    )
    .await
    .ok();
    let rec = tool(
        r.app(),
        &r.write,
        "get_record",
        json!({"base_id": r.base(), "table": "Table 1", "record_id": alice}),
    )
    .await;
    assert!(rec.ok()["fields"].get("Age").is_none());

    // Errors: unknown record, unknown field, too many.
    let t = tool(
        r.app(),
        &r.write,
        "update_records",
        json!({"base_id": r.base(), "table": "Table 1", "records": [{"id": "recNope", "fields": {"Age": 1}}]}),
    )
    .await;
    assert!(t.err().contains("not found"), "{}", t.text);
    let t = tool(
        r.app(),
        &r.write,
        "update_records",
        json!({"base_id": r.base(), "table": "Table 1", "records": [{"id": alice, "fields": {"Agee": 1}}]}),
    )
    .await;
    assert!(t.err().contains("Fields of 'Table 1'"), "{}", t.text);
}

#[tokio::test]
async fn delete_records_moves_to_the_trash_and_says_so() {
    let r = rig().await;
    let mut rx = r.app().state.events.subscribe(r.base());
    let ids = [r.p.ids[3].clone(), r.p.ids[4].clone()];
    let t = tool(
        r.app(),
        &r.write,
        "delete_records",
        json!({"base_id": r.base(), "table": "Table 1", "record_ids": ids}),
    )
    .await;
    let v = t.ok();
    assert_eq!(v["count"], 2);
    assert_eq!(v["deleted"], json!(ids));
    let note = v["note"].as_str().unwrap();
    assert!(
        note.contains("trash") && note.contains("30 days") && note.contains("restore"),
        "{note}"
    );
    assert_eq!(r.p.f.query(json!({})).await["total"], 3);
    let env = rx.try_recv().expect("event");
    assert!(
        matches!(env.event, BaseEvent::RecordsChanged { ref deleted, .. } if deleted.len() == 2)
    );
    // It is recoverable: the trash holds them and restore brings them back.
    let (_, restored) = api(
        r.app(),
        &r.write,
        "POST",
        &format!("/api/tables/{}/records/restore", r.p.f.table_id),
        Value::Null,
        json!({"ids": ids}),
    )
    .await;
    assert_eq!(restored["status"], 200, "{restored}");
    assert_eq!(r.p.f.query(json!({})).await["total"], 5);
    // Unknown ids fail the whole batch.
    let t = tool(
        r.app(),
        &r.write,
        "delete_records",
        json!({"base_id": r.base(), "table": "Table 1", "record_ids": [r.p.ids[0], "recNope"]}),
    )
    .await;
    assert!(t.is_error);
    assert_eq!(r.p.f.query(json!({})).await["total"], 5, "nothing deleted");
    let t = tool(
        r.app(),
        &r.write,
        "delete_records",
        json!({"base_id": r.base(), "table": "Table 1", "record_ids": []}),
    )
    .await;
    assert!(t.err().contains("at least one"));
}

#[tokio::test]
async fn write_tools_enforce_roles_and_token_scope() {
    let r = rig().await;
    let f = &r.p.f;
    let write_args = |base: &str| json!({"base_id": base, "table": "Table 1", "records": [{"fields": {"Name": "Mallory"}}]});
    // A read-only token that calls the (unlisted) tool by name is refused, nothing is written.
    let t = tool(r.app(), &r.read, "create_records", write_args(r.base())).await;
    assert!(t.err().contains("write access"));
    // A write token of a user who is only a viewer: the precise role error.
    let viewer = f.member("viewer@example.com", openbase::perm::Role::Viewer);
    let vt = r
        .app()
        .api_token(&viewer, json!({"name": "v", "write": true}))
        .await;
    let t = tool(r.app(), &vt, "create_records", write_args(r.base())).await;
    assert!(t.err().contains("requires the editor role"), "{}", t.text);
    let t = tool(
        r.app(),
        &vt,
        "update_records",
        json!({"base_id": r.base(), "table": "Table 1", "records": [{"id": r.p.ids[0], "fields": {"Age": 1}}]}),
    )
    .await;
    assert!(t.err().contains("requires the editor role"), "{}", t.text);
    let t = tool(
        r.app(),
        &vt,
        "delete_records",
        json!({"base_id": r.base(), "table": "Table 1", "record_ids": [r.p.ids[0]]}),
    )
    .await;
    assert!(t.err().contains("requires the editor role"), "{}", t.text);
    // A token limited to another base cannot write here, and learns nothing about it.
    let (_ws2, other) = r.app().workspace_with_base(&f.owner, "Other");
    let limited = r
        .app()
        .api_token(
            &f.owner,
            json!({"name": "l", "write": true, "base_ids": [other]}),
        )
        .await;
    let t = tool(r.app(), &limited, "create_records", write_args(r.base())).await;
    assert!(
        t.err().contains("not found, or you have no access"),
        "{}",
        t.text
    );
    for (name, args) in [
        (
            "list_records",
            json!({"base_id": r.base(), "table": "Table 1"}),
        ),
        (
            "search_records",
            json!({"base_id": r.base(), "table": "Table 1", "query": "a"}),
        ),
        (
            "aggregate_records",
            json!({"base_id": r.base(), "table": "Table 1", "group_by": ["Name"]}),
        ),
        (
            "get_record",
            json!({"base_id": r.base(), "table": "Table 1", "record_id": r.p.ids[0]}),
        ),
        ("get_base_schema", json!({"base_id": r.base()})),
    ] {
        let t = tool(r.app(), &limited, name, args).await;
        assert!(t.is_error, "{name}: {}", t.text);
        assert!(
            !t.text.contains("Alice") && !t.text.contains("Table 1'"),
            "{name} leaked: {}",
            t.text
        );
    }
    assert_eq!(f.query(json!({})).await["total"], 5, "nothing was written");
}

// ------------------------------------------------------------------- aggregate_records

/// `aggregate_records` as the read-only token, on "Table 1" unless `args` say otherwise.
async fn aggregate(r: &Rig, args: Value) -> Tool {
    let mut a = json!({"base_id": r.base(), "table": "Table 1"});
    for (k, v) in args.as_object().unwrap() {
        a[k] = v.clone();
    }
    tool(r.app(), &r.read, "aggregate_records", a).await
}

#[tokio::test]
async fn aggregate_records_groups_with_names_and_computes_on_the_server() {
    let r = rig().await;
    // Totals with no arguments but the table: one count.
    let t = aggregate(&r, json!({})).await;
    assert_eq!(t.ok()["groups"][0]["aggregates"], json!({"count": 5}));
    assert_eq!(t.ok()["record_count"], 5);

    // Counts and sums per select choice, by name.
    let t = aggregate(
        &r,
        json!({
            "group_by": ["Status"],
            "aggregates": [{"function": "count"}, {"function": "sum", "field": "Age"}],
            "sort": [{"by": "sum_Age", "direction": "desc"}],
        }),
    )
    .await;
    let v = t.ok();
    let rows: Vec<(Value, Value, Value)> = v["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["group"]["Status"].clone(),
                g["aggregates"]["count"].clone(),
                g["aggregates"]["sum_Age"].clone(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            (json!("Todo"), json!(2), json!(60)),
            (json!("Done"), json!(1), json!(41)),
            (json!("Doing"), json!(1), json!(25)),
            (json!(null), json!(1), json!(0)),
        ]
    );
    assert_eq!(v["total_groups"], 4);
    assert_eq!(v["truncated"], false);
    assert!(v.get("hint").is_none() && v.get("note").is_none());
    assert!(
        t.text.starts_with('{') && !t.text.contains('\n'),
        "compact JSON text"
    );

    // The filters of list_records, a view and a formula, and field ids work as names.
    let age = r.p.age.clone();
    r.p.f
        .new_view(
            &r.p.f.table_id,
            "Senior",
            json!({"filter": and(vec![cond(&age, "gt", json!(26))])}),
        )
        .await;
    let t = aggregate(
        &r,
        json!({
            "view": "Senior",
            "filter_by_formula": "{Status}='Todo'",
            "group_by": ["Tags"],
            "aggregates": [{"function": "avg", "field": age, "alias": "mean"}],
        }),
    )
    .await;
    let g = &t.ok()["groups"];
    assert_eq!(g.as_array().unwrap().len(), 2, "{}", t.text);
    assert_eq!(g[0]["group"]["Tags"], json!(["a"]));
    assert_eq!(g[0]["aggregates"]["mean"], 30);
    assert_eq!(t.ok()["record_count"], 2);

    // Dates: min and max of a date field per checkbox group.
    let t = aggregate(
        &r,
        json!({
            "group_by": ["Done"],
            "aggregates": [{"function": "min", "field": "Due"}, {"function": "max", "field": "Due"}],
        }),
    )
    .await;
    let unchecked = &t.ok()["groups"][0];
    assert_eq!(unchecked["group"]["Done"], false);
    assert_eq!(unchecked["aggregates"]["min_Due"], "2026-03-01");
    assert_eq!(unchecked["aggregates"]["max_Due"], "2026-03-10");
}

#[tokio::test]
async fn aggregate_records_limits_groups_and_hints_when_cut() {
    let r = rig().await;
    let t = aggregate(&r, json!({"group_by": ["Name"], "limit": 2})).await;
    let v = t.ok();
    assert_eq!(v["groups"].as_array().unwrap().len(), 2);
    assert_eq!(v["total_groups"], 5);
    assert_eq!(v["truncated"], true);
    assert!(v["hint"].as_str().unwrap().contains("limit"), "{v}");
    let t = aggregate(&r, json!({"group_by": ["Name"], "limit": 5000})).await;
    assert!(
        t.ok()["note"].as_str().unwrap().contains("1000"),
        "{}",
        t.text
    );
    assert_eq!(t.ok()["truncated"], false);
}

#[tokio::test]
async fn aggregate_records_errors_name_the_problem_and_the_valid_fields() {
    let r = rig().await;
    let t = aggregate(
        &r,
        json!({"aggregates": [{"function": "sum", "field": "Name"}]}),
    )
    .await;
    let m = t.err();
    assert!(
        m.contains("Cannot sum \"Name\"")
            && m.contains("single_line_text")
            && m.contains("\"Age\""),
        "{m}"
    );
    let t = aggregate(&r, json!({"aggregates": [{"function": "sum"}]})).await;
    assert!(t.err().contains("needs a `field`"), "{}", t.text);
    let t = aggregate(&r, json!({"group_by": ["Nope"]})).await;
    let m = t.err();
    assert!(
        m.contains("Nope") && m.contains("Fields of 'Table 1'"),
        "{m}"
    );
    let t = aggregate(
        &r,
        json!({"aggregates": [{"function": "median", "field": "Age"}]}),
    )
    .await;
    assert!(t.err().contains("Invalid arguments"), "{}", t.text);
    let t = aggregate(&r, json!({"view": "Missing view"})).await;
    let m = t.err();
    assert!(m.contains("Missing view") && m.contains("Views:"), "{m}");
    let t = aggregate(&r, json!({"filter_by_formula": "{Age} ="})).await;
    assert!(t.err().contains("INVALID_FILTER_BY_FORMULA"), "{}", t.text);
    let t = aggregate(&r, json!({"table": "No such table"})).await;
    assert!(t.err().contains("Tables in this base"), "{}", t.text);
}

// ------------------------------------------------------------------- comments

#[tokio::test]
async fn comments_can_be_added_and_listed() {
    let r = rig().await;
    let rec = r.p.ids[0].clone();
    let t = tool(
        r.app(),
        &r.write,
        "add_comment",
        json!({"record_id": rec, "body": "Looks good"}),
    )
    .await;
    let c = &t.ok()["comment"];
    assert_eq!(c["body"], "Looks good");
    assert_eq!(c["user_id"], r.p.f.owner.user_id.clone().unwrap());
    let t = tool(r.app(), &r.read, "list_comments", json!({"record_id": rec})).await;
    let v = t.ok();
    assert_eq!(v["comments"].as_array().unwrap().len(), 1);
    assert_eq!(v["comments"][0]["body"], "Looks good");
    // Errors.
    let t = tool(
        r.app(),
        &r.write,
        "add_comment",
        json!({"record_id": rec, "body": "  "}),
    )
    .await;
    assert!(t.err().contains("must not be empty"));
    let t = tool(
        r.app(),
        &r.write,
        "add_comment",
        json!({"record_id": "recNope", "body": "x"}),
    )
    .await;
    assert!(t.err().contains("not found"), "{}", t.text);
    let t = tool(
        r.app(),
        &r.read,
        "list_comments",
        json!({"record_id": "recNope"}),
    )
    .await;
    assert!(t.err().contains("not found"), "{}", t.text);
    // A commenter-level user may comment, a viewer may not.
    let viewer = r.p.f.member("v@example.com", openbase::perm::Role::Viewer);
    let vt = r
        .app()
        .api_token(&viewer, json!({"name": "v", "write": true}))
        .await;
    let t = tool(
        r.app(),
        &vt,
        "add_comment",
        json!({"record_id": rec, "body": "hi"}),
    )
    .await;
    assert!(t.err().contains("commenter role"), "{}", t.text);
}

// ------------------------------------------------- automations see MCP writes

#[tokio::test]
async fn mcp_writes_fire_automations_like_api_writes() {
    use automations_support::Env;
    let env = Env::new().await;
    let f = &env.f;
    let log = f.add_table("Log").await;
    let log_id = id_of(&log);
    env.create(
        "mirror",
        env.trigger_created(),
        json!([{ "type": "create_record", "table_id": log_id, "values": {
            "Name": "log of {{trigger.record.fields.Name}}"
        } }]),
    )
    .await;
    let token = f
        .app
        .api_token(&f.owner, json!({"name": "agent", "write": true}))
        .await;
    let t = tool(
        &f.app,
        &token,
        "create_records",
        json!({"base_id": f.base_id, "table": f.table_id, "records": [{"fields": {"Name": "From an agent"}}]}),
    )
    .await;
    t.ok();
    assert_eq!(env.drain().await, 1, "the MCP write queued exactly one run");
    let logged = tool(
        &f.app,
        &token,
        "list_records",
        json!({"base_id": f.base_id, "table": "Log"}),
    )
    .await;
    assert_eq!(
        logged.ok()["records"][0]["fields"]["Name"],
        "log of From an agent"
    );
}
