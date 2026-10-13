//! The headline test: an agent runs a small business without the web UI.
//!
//! A freshly signed-up administrator creates a `manage` token (the one thing the account page
//! does), and from then on EVERYTHING below is an MCP `tools/call` over real HTTP on a real TCP
//! port: workspace, invite, base, tables with linked records and every kind of computed field,
//! records, grid / kanban / form views, queries with computed values, edits, deletes and
//! restores, comments, public forms, automations, attachments, CSV export and import, history,
//! notifications and the admin pages.
//!
//! The only things done outside MCP are the ones that are not the agent's to do: signing up,
//! accepting an invite as the invited person, writing a comment as that other person, and
//! submitting the public form as an anonymous visitor.

mod common;
mod mcp_support;

use std::time::Duration;

use base64::Engine;
use mcp_support::*;
use serde_json::{Value, json};

fn id_of(v: &Value, pointer: &str) -> String {
    v.pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no string at {pointer} in {v}"))
        .to_string()
}

fn names(v: &Value, pointer: &str) -> Vec<String> {
    v.pointer(pointer)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("no array at {pointer} in {v}"))
        .iter()
        .map(|x| x.as_str().unwrap_or_default().to_string())
        .collect()
}

/// The record named `name` among `records` (list_records / query_view shape).
fn record<'a>(records: &'a Value, name: &str) -> &'a Value {
    records
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["fields"]["Name"] == name)
        .unwrap_or_else(|| panic!("no record {name} in {records}"))
}

#[tokio::test]
async fn an_agent_runs_the_business_without_the_ui() {
    let live = LiveApp::start().await;
    let app = &live.app;
    live.run_automations();

    // ---- fixture: the administrator signs up and creates a manage token on the account page
    let (res, admin) = app
        .signup("admin@acme.test", "correct horse battery staple", None)
        .await;
    res.assert_status(200);
    assert_eq!(res.body["is_admin"], true, "the first account is the administrator");
    let token = app
        .api_token(&admin, json!({"name": "agent", "write": true, "manage": true}))
        .await;
    let agent = live.agent(token.bearer.as_deref().unwrap());

    // ---- the handshake and the toolbox
    let init = agent.initialize().await;
    assert_eq!(init["serverInfo"]["name"], "opengrid");
    let tools = agent.tool_names().await;
    for expected in [
        "create_workspace",
        "create_invite",
        "create_base",
        "create_field",
        "create_view",
        "query_view",
        "create_share_link",
        "create_automation",
        "upload_attachment",
        "export_csv",
        "import_csv",
        "get_record_history",
        "list_notifications",
        "admin_list_users",
    ] {
        assert!(tools.iter().any(|t| t == expected), "{expected} in {tools:?}");
    }

    // ---- 1. a workspace, and a teammate invited into it
    let ws = agent
        .call("create_workspace", json!({"name": "Acme Co"}))
        .await;
    let ws_id = id_of(&ws, "/workspace/id");
    let listed = agent.call("list_workspaces", json!({})).await;
    assert_eq!(listed["workspaces"][0]["name"], "Acme Co");
    assert_eq!(listed["workspaces"][0]["role"], "owner");

    let invite = agent
        .call(
            "create_invite",
            json!({"scope": "workspace", "id": ws_id, "role": "editor", "email": "teammate@acme.test"}),
        )
        .await;
    let invite_url = id_of(&invite, "/url");
    assert!(
        invite_url.starts_with(&format!("{}/invite/", live.url)),
        "the link is on the public URL: {invite_url}"
    );
    let invite_token = invite_url.rsplit('/').next().unwrap().to_string();
    let pending = agent
        .call("list_invites", json!({"scope": "workspace", "id": ws_id}))
        .await;
    assert_eq!(pending["invites"].as_array().unwrap().len(), 1);
    assert_eq!(pending["invites"][0]["email"], "teammate@acme.test");

    // fixture: the invited person signs up with the link
    let (res, teammate) = app
        .signup("teammate@acme.test", "teammate password 123", Some(&invite_token))
        .await;
    res.assert_status(200);
    let teammate_id = teammate.user_id.clone().unwrap();

    let members = agent
        .call("list_members", json!({"scope": "workspace", "id": ws_id}))
        .await;
    let role_of = |members: &Value, email: &str| -> String {
        members["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["email"] == email)
            .unwrap_or_else(|| panic!("{email} not in {members}"))["role"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(role_of(&members, "admin@acme.test"), "owner");
    assert_eq!(role_of(&members, "teammate@acme.test"), "editor");
    agent
        .call(
            "set_member_role",
            json!({"scope": "workspace", "id": ws_id, "user_id": teammate_id, "role": "creator"}),
        )
        .await;
    let members = agent
        .call("list_members", json!({"scope": "workspace", "id": ws_id}))
        .await;
    assert_eq!(role_of(&members, "teammate@acme.test"), "creator");

    // ---- 2. a base, tables and fields (names everywhere, no ids to juggle)
    let base = agent
        .call(
            "create_base",
            json!({"workspace_id": ws_id, "name": "Operations", "color": "green"}),
        )
        .await;
    let base_id = id_of(&base, "/base/id");
    let first_table = id_of(&base, "/base/tables/0/id");
    let collaborators = agent
        .call("list_collaborators", json!({"base_id": base_id}))
        .await;
    assert_eq!(collaborators["collaborators"].as_array().unwrap().len(), 2);

    // The new base comes with one table: make it the customers table.
    let renamed = agent
        .call(
            "rename_table",
            json!({"base_id": base_id, "table": first_table, "name": "Customers"}),
        )
        .await;
    assert_eq!(renamed["table"]["name"], "Customers");
    agent
        .call("create_table", json!({"base_id": base_id, "name": "Orders"}))
        .await;
    agent
        .call("create_table", json!({"base_id": base_id, "name": "Activity log"}))
        .await;

    // Customers
    for (name, ty, options) in [
        ("Email", "email", json!({})),
        (
            "Tier",
            "single_select",
            json!({"choices": ["Gold", "Silver", {"name": "Bronze", "color": "orange"}]}),
        ),
        ("Since", "date", json!({"date_format": "iso"})),
        ("Active", "checkbox", json!({})),
    ] {
        agent
            .call(
                "create_field",
                json!({"base_id": base_id, "table": "Customers", "name": name, "type": ty, "options": options}),
            )
            .await;
    }
    // Orders: a link to customers (with the inverse field created for us), numbers, a date,
    // a status, and computed fields over all of that.
    let link = agent
        .call(
            "create_field",
            json!({"base_id": base_id, "table": "Orders", "name": "Customer", "type": "link",
                   "options": {"linked_table": "Customers"}, "inverse_name": "Orders"}),
        )
        .await;
    assert_eq!(link["field"]["inverse"]["name"], "Orders", "{link}");
    for (name, ty, options) in [
        ("Qty", "number", json!({"precision": 0})),
        ("Unit price", "currency", json!({"precision": 2, "symbol": "$"})),
        ("Due", "date", json!({"date_format": "iso"})),
        ("Status", "single_select", json!({"choices": ["Open", "Paid"]})),
        ("Invoice", "attachment", json!({})),
    ] {
        agent
            .call(
                "create_field",
                json!({"base_id": base_id, "table": "Orders", "name": name, "type": ty, "options": options}),
            )
            .await;
    }
    // A formula is checked before it is created: good and bad.
    let good = agent
        .call(
            "check_formula",
            json!({"base_id": base_id, "table": "Orders", "expression": "{Qty} * {Unit price}"}),
        )
        .await;
    assert_eq!(good["ok"], true, "{good}");
    assert_eq!(good["result_type"], "number");
    let bad = agent
        .call(
            "check_formula",
            json!({"base_id": base_id, "table": "Orders", "expression": "{Qty} * {Nope}"}),
        )
        .await;
    assert_eq!(bad["ok"], false);
    assert!(bad["error"]["message"].as_str().unwrap().contains("Nope"), "{bad}");

    for (table, name, ty, options) in [
        ("Orders", "Total", "formula", json!({"expression": "{Qty} * {Unit price}"})),
        (
            "Orders",
            "Customer tier",
            "lookup",
            json!({"link_field": "Customer", "target_field": "Tier"}),
        ),
        (
            "Customers",
            "Lifetime value",
            "rollup",
            json!({"link_field": "Orders", "target_field": "Total", "expression": "SUM(values)"}),
        ),
        ("Customers", "Order count", "count", json!({"link_field": "Orders"})),
    ] {
        let f = agent
            .call(
                "create_field",
                json!({"base_id": base_id, "table": table, "name": name, "type": ty, "options": options}),
            )
            .await;
        assert_eq!(f["field"]["type"], ty, "{f}");
    }
    agent
        .call(
            "create_field",
            json!({"base_id": base_id, "table": "Activity log", "name": "Detail", "type": "long_text"}),
        )
        .await;

    // The schema reads back with names; the options use ids inside, names outside.
    let schema = agent
        .call("get_base_schema", json!({"base_id": base_id}))
        .await;
    let table_names: Vec<&str> = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(table_names, ["Customers", "Orders", "Activity log"]);
    let orders = &schema["tables"][1];
    let order_fields: Vec<&str> = orders["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        order_fields,
        ["Name", "Customer", "Qty", "Unit price", "Due", "Status", "Invoice", "Total", "Customer tier"]
    );

    // ---- 3. records, with links; computed values come back immediately
    let customers = agent
        .call(
            "create_records",
            json!({"base_id": base_id, "table": "Customers", "records": [
                {"fields": {"Name": "Ada Lovelace", "Email": "ada@example.com", "Tier": "Gold", "Since": "2025-01-15", "Active": true}},
                {"fields": {"Name": "Bob Builder", "Email": "bob@example.com", "Tier": "Silver", "Since": "2025-03-01"}},
                {"fields": {"Name": "Cy Young", "Email": "cy@example.com", "Tier": "Gold", "Since": "2025-06-30", "Active": true}},
            ]}),
        )
        .await;
    let rec_id = |created: &Value, i: usize| id_of(created, &format!("/created/{i}/id"));
    let (ada, bob, cy) = (rec_id(&customers, 0), rec_id(&customers, 1), rec_id(&customers, 2));

    let new_orders = agent
        .call(
            "create_records",
            json!({"base_id": base_id, "table": "Orders", "records": [
                {"fields": {"Name": "O-1", "Customer": [ada], "Qty": 2, "Unit price": 50, "Due": "2026-11-01", "Status": "Open"}},
                {"fields": {"Name": "O-2", "Customer": [ada], "Qty": 1, "Unit price": 30, "Due": "2026-11-03", "Status": "Paid"}},
                {"fields": {"Name": "O-3", "Customer": [bob], "Qty": 5, "Unit price": 10, "Due": "2026-12-03", "Status": "Open"}},
                {"fields": {"Name": "O-4", "Customer": [cy], "Qty": 10, "Unit price": 7.5, "Due": "2027-01-10", "Status": "Open"}},
            ]}),
        )
        .await;
    let (o1, o3, o4) = (
        rec_id(&new_orders, 0),
        rec_id(&new_orders, 2),
        rec_id(&new_orders, 3),
    );
    let o1_fields = &new_orders["created"][0]["fields"];
    assert_eq!(o1_fields["Total"], 100, "formula: 2 x 50");
    assert_eq!(o1_fields["Customer"][0]["name"], "Ada Lovelace", "links show names");
    assert_eq!(o1_fields["Customer tier"], json!(["Gold"]), "lookup through the link");

    let customer_rows = agent
        .call(
            "list_records",
            json!({"base_id": base_id, "table": "Customers", "sort": [{"field": "Name"}]}),
        )
        .await;
    let value = |name: &str, field: &str| record(&customer_rows["records"], name)["fields"][field].clone();
    assert_eq!(value("Ada Lovelace", "Lifetime value"), 130, "rollup SUM of 100 + 30");
    assert_eq!(value("Ada Lovelace", "Order count"), 2);
    assert_eq!(value("Bob Builder", "Lifetime value"), 50);
    assert_eq!(value("Cy Young", "Lifetime value"), 75);

    // ---- 4. views: a filtered, sorted, grouped grid and a kanban board
    let grid = agent
        .call(
            "create_view",
            json!({"base_id": base_id, "table": "Orders", "name": "Big orders by status", "type": "grid",
                   "config": {
                       "filter": {"conjunction": "and", "items": [
                           {"field_id": "Total", "op": "gte", "value": 50},
                           {"conjunction": "or", "items": [
                               {"field_id": "Status", "op": "is", "value": "Open"},
                               {"field_id": "Status", "op": "is", "value": "Paid"}
                           ]}
                       ]},
                       "sorts": [{"field_id": "Total", "direction": "desc"}],
                       "groups": [{"field_id": "Status"}],
                       "hidden_fields": ["Due", "Invoice"]
                   }}),
        )
        .await;
    assert_eq!(grid["view"]["config"]["sorts"][0]["field_id"], "Total", "config reads back with names");
    let board = agent
        .call(
            "create_view",
            json!({"base_id": base_id, "table": "Orders", "name": "Order board", "type": "kanban",
                   "config": {"kanban": {"stack_field_id": "Status", "stack_order": ["Open", "Paid"]}}}),
        )
        .await;
    assert_eq!(board["view"]["type"], "kanban");

    let q = agent
        .call(
            "query_view",
            json!({"base_id": base_id, "table": "Orders", "view": "Big orders by status"}),
        )
        .await;
    assert_eq!(q["total"], 3, "O-2 (30) is filtered out: {q}");
    let order: Vec<&str> = q["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["fields"]["Name"].as_str().unwrap())
        .collect();
    assert_eq!(order, ["O-1", "O-4", "O-3"], "sorted by total, descending: 100, 75, 50");
    assert_eq!(q["records"][0]["fields"]["Total"], 100);
    assert_eq!(q["records"][0]["fields"]["Status"], "Open", "select values are names");
    assert_eq!(q["groups"].as_array().unwrap().len(), 1);
    assert_eq!(q["groups"][0]["label"], "Open");
    assert_eq!(q["groups"][0]["count"], 3);
    let columns = names(&q, "/columns");
    assert!(!columns.contains(&"Due".to_string()), "hidden fields stay hidden: {columns:?}");
    assert_eq!(columns[0], "Name");

    let b = agent
        .call("query_view", json!({"base_id": base_id, "view": "Order board"}))
        .await;
    assert_eq!(b["total"], 4);
    assert_eq!(b["view_type"], "kanban");

    // search and paging
    let p1 = agent
        .call(
            "query_view",
            json!({"base_id": base_id, "view": "Order board", "max_records": 3}),
        )
        .await;
    assert_eq!(p1["count"], 3);
    assert_eq!(p1["next_offset"], 3);
    let p2 = agent
        .call(
            "query_view",
            json!({"base_id": base_id, "view": "Order board", "max_records": 3, "offset": 3}),
        )
        .await;
    assert_eq!(p2["count"], 1);
    assert!(p2.get("next_offset").is_none());
    let s = agent
        .call(
            "query_view",
            json!({"base_id": base_id, "view": "Order board", "search": "O-3"}),
        )
        .await;
    assert_eq!(s["total"], 1);

    // ---- 5. edits flow through formulas and rollups; deletes go to the trash and come back
    let upd = agent
        .call(
            "update_records",
            json!({"base_id": base_id, "table": "Orders", "records": [
                {"id": o1, "fields": {"Unit price": 55}},
                {"id": o3, "fields": {"Qty": 6}}
            ]}),
        )
        .await;
    assert_eq!(upd["updated"][0]["fields"]["Total"], 110, "2 x 55");
    assert_eq!(upd["updated"][1]["fields"]["Total"], 60, "6 x 10");
    let bob_row = agent
        .call("get_record", json!({"base_id": base_id, "table": "Customers", "record_id": bob}))
        .await;
    assert_eq!(bob_row["fields"]["Lifetime value"], 60, "the rollup followed");

    agent
        .call(
            "delete_records",
            json!({"base_id": base_id, "table": "Orders", "record_ids": [o4]}),
        )
        .await;
    let cy_row = agent
        .call("get_record", json!({"base_id": base_id, "table": "Customers", "record_id": cy}))
        .await;
    assert!(
        cy_row["fields"].get("Lifetime value").is_none_or(|v| v == 0),
        "Cy has no orders any more: {cy_row}"
    );
    assert_eq!(
        agent
            .call("query_view", json!({"base_id": base_id, "view": "Order board"}))
            .await["total"],
        3
    );
    let trash = agent.call("list_trash", json!({"base_id": base_id})).await;
    let trashed = trash["items"].as_array().unwrap();
    assert!(trashed.iter().any(|i| i["kind"] == "record" && i["id"] == o4), "{trash}");
    let restored = agent
        .call("restore_from_trash", json!({"kind": "record", "id": o4}))
        .await;
    assert_eq!(restored["restored"]["id"], o4);
    let cy_row = agent
        .call("get_record", json!({"base_id": base_id, "table": "Customers", "record_id": cy}))
        .await;
    assert_eq!(cy_row["fields"]["Lifetime value"], 75, "restored with its link");
    assert_eq!(
        agent
            .call("query_view", json!({"base_id": base_id, "view": "Order board"}))
            .await["total"],
        4
    );

    // ---- 6. history, comments and notifications
    let hist = agent
        .call("get_record_history", json!({"record_id": o1}))
        .await;
    let entries = hist["entries"].as_array().unwrap();
    assert_eq!(entries[0]["kind"], "update", "newest first: {hist}");
    assert_eq!(entries[0]["changes"]["Unit price"], json!({"old": 50, "new": 55}));
    assert_eq!(entries.last().unwrap()["kind"], "create");
    assert_eq!(
        entries.last().unwrap()["changes"]["Status"]["new"], "Open",
        "history shows choice names, not ids"
    );
    let o4_hist = agent
        .call("get_record_history", json!({"record_id": o4}))
        .await;
    let kinds: Vec<&str> = o4_hist["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["restore", "delete", "create"], "{o4_hist}");

    agent
        .call(
            "add_comment",
            json!({"record_id": o1, "body": "Customer asked for an invoice copy."}),
        )
        .await;
    let comments = agent.call("list_comments", json!({"record_id": o1})).await;
    assert_eq!(comments["comments"].as_array().unwrap().len(), 1);

    // fixture: the teammate answers and mentions the administrator
    let admin_id = admin.user_id.clone().unwrap();
    app.post(
        &teammate,
        &format!("/api/records/{o1}/comments"),
        json!({"body": format!("@[Test User]({admin_id}) invoice is attached")}),
    )
    .await
    .assert_status(201);
    let notes = agent.call("list_notifications", json!({})).await;
    assert_eq!(notes["unread"], 1, "{notes}");
    assert_eq!(notes["notifications"][0]["kind"], "mention");
    agent.call("mark_notifications_read", json!({})).await;
    let notes = agent
        .call("list_notifications", json!({"unread_only": true}))
        .await;
    assert_eq!(notes["unread"], 0);
    assert_eq!(notes["count"], 0);

    // ---- 7. a public form: an anonymous visitor creates a record
    let form = agent
        .call(
            "create_view",
            json!({"base_id": base_id, "table": "Orders", "name": "Order request", "type": "form",
                   "config": {"form": {
                       "title": "Request an order",
                       "fields": [
                           {"field_id": "Name", "required": true, "label": "Reference"},
                           {"field_id": "Qty", "required": true},
                           {"field_id": "Unit price"}
                       ]
                   }}}),
        )
        .await;
    assert_eq!(form["view"]["config"]["form"]["fields"][0]["field_id"], "Name");
    let share = agent
        .call(
            "create_share_link",
            json!({"base_id": base_id, "table": "Orders", "view": "Order request"}),
        )
        .await;
    assert_eq!(share["share_link"]["kind"], "form");
    let share_url = id_of(&share, "/share_link/url");
    assert!(share_url.starts_with(&format!("{}/f/", live.url)));
    let share_token = id_of(&share, "/share_link/token");
    // fixture: the visitor opens the public form and submits it (no credentials)
    let anon = app.anon();
    let public = app
        .get(&anon, &format!("/api/public/forms/{share_token}"))
        .await;
    public.assert_status(200);
    let field_key = |label: &str| -> String {
        public.body["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["label"] == label)
            .unwrap_or_else(|| panic!("{label} in {}", public.body))["id"]
            .as_str()
            .unwrap()
            .to_string()
    };
    app.post(
        &anon,
        &format!("/api/public/forms/{share_token}/submit"),
        json!({"values": {field_key("Reference"): "Walk-in", field_key("Qty"): 3, field_key("Unit price"): 4}}),
    )
    .await
    .assert_status(200);
    let found = agent
        .call(
            "list_records",
            json!({"base_id": base_id, "table": "Orders", "filter_by_formula": "{Name} = 'Walk-in'"}),
        )
        .await;
    assert_eq!(found["count"], 1, "{found}");
    assert_eq!(found["records"][0]["fields"]["Total"], 12);

    // ---- 8. an automation, which then really runs
    let dry_target = agent
        .call(
            "create_automation",
            json!({"base_id": base_id, "name": "Log new orders", "enabled": true,
                   "trigger": {"type": "record_created", "table": "Orders"},
                   "actions": [{
                       "type": "create_record", "table": "Activity log",
                       "values": {"Name": "New order {{trigger.record.fields.Name}}",
                                  "Detail": "Qty {{trigger.record.fields.Qty}}"}
                   }]}),
        )
        .await;
    let auto_id = id_of(&dry_target, "/automation/id");
    assert_eq!(dry_target["automation"]["enabled"], true);
    // A dry run renders but changes nothing.
    let dry = agent
        .call("test_automation", json!({"automation_id": auto_id, "record_id": o1}))
        .await;
    assert_eq!(dry["dry_run"], true);
    assert_eq!(dry["status"], "succeeded", "{dry}");
    let log_rows = agent
        .call("list_records", json!({"base_id": base_id, "table": "Activity log"}))
        .await;
    assert_eq!(log_rows["count"], 0, "a dry run writes nothing");

    agent
        .call(
            "create_records",
            json!({"base_id": base_id, "table": "Orders", "records": [
                {"fields": {"Name": "O-5", "Customer": [cy], "Qty": 1, "Unit price": 99, "Status": "Open"}}
            ]}),
        )
        .await;
    let mut run = Value::Null;
    for _ in 0..100 {
        let runs = agent
            .call("list_automation_runs", json!({"automation_id": auto_id}))
            .await;
        if runs["runs"][0]["status"] == "succeeded" {
            run = runs["runs"][0].clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(run["status"], "succeeded", "the automation ran: {run}");
    assert_eq!(run["log"][0]["action"], "create_record");
    let log_rows = agent
        .call("list_records", json!({"base_id": base_id, "table": "Activity log"}))
        .await;
    assert_eq!(log_rows["count"], 1);
    assert_eq!(log_rows["records"][0]["fields"]["Name"], "New order O-5");
    assert_eq!(log_rows["records"][0]["fields"]["Detail"], "Qty 1");
    // Switching it off and listing it.
    let off = agent
        .call("update_automation", json!({"automation_id": auto_id, "enabled": false}))
        .await;
    assert_eq!(off["automation"]["enabled"], false);
    let autos = agent
        .call("list_automations", json!({"base_id": base_id}))
        .await;
    assert_eq!(autos["automations"][0]["name"], "Log new orders");

    // ---- 9. an attachment from base64, written into a record
    let invoice_text = "Invoice O-1: 110.00";
    let up = agent
        .call(
            "upload_attachment",
            json!({"base_id": base_id, "filename": "invoice.txt",
                   "content_base64": base64::engine::general_purpose::STANDARD.encode(invoice_text)}),
        )
        .await;
    assert_eq!(up["attachment"]["filename"], "invoice.txt");
    assert_eq!(up["attachment"]["size"], invoice_text.len());
    let att_id = id_of(&up, "/attachment/id");
    let with_file = agent
        .call(
            "update_records",
            json!({"base_id": base_id, "table": "Orders", "records": [
                {"id": o1, "fields": {"Invoice": [{"id": att_id}]}}
            ]}),
        )
        .await;
    assert_eq!(with_file["updated"][0]["fields"]["Invoice"][0]["filename"], "invoice.txt");

    // ---- 10. CSV out and back in as a new table
    let csv = agent
        .text(
            "export_csv",
            json!({"base_id": base_id, "table": "Orders", "view": "Big orders by status"}),
        )
        .await;
    let mut lines = csv.lines();
    assert_eq!(
        lines.next().unwrap(),
        "Name,Customer,Qty,Unit price,Status,Total,Customer tier",
        "visible fields in view order"
    );
    let rows: Vec<&str> = lines.filter(|l| !l.is_empty()).collect();
    assert_eq!(rows.len(), 4, "O-1, O-4, O-3 and O-5: {csv}");
    assert!(rows[0].starts_with("O-1,Ada Lovelace,2,"), "{}", rows[0]);
    let imported = agent
        .call(
            "import_csv",
            json!({"base_id": base_id, "new_table_name": "Orders archive", "csv_text": csv}),
        )
        .await;
    assert_eq!(imported["created"], 4, "{imported}");
    let archive_rows = agent
        .call("list_records", json!({"base_id": base_id, "table": "Orders archive"}))
        .await;
    assert_eq!(archive_rows["count"], 4);
    assert_eq!(record(&archive_rows["records"], "O-1")["fields"]["Customer"], "Ada Lovelace");
    // ...and into an existing table, with a mapping
    let into = agent
        .call(
            "import_csv",
            json!({"base_id": base_id, "table": "Activity log",
                   "csv_text": "Event,Notes\nImport finished,4 rows\n",
                   "mapping": {"Event": "Name", "Notes": "Detail"}}),
        )
        .await;
    assert_eq!(into["created"], 1);

    // ---- 11. the administrator's own pages
    let users = agent.call("admin_list_users", json!({})).await;
    assert_eq!(users["users"].as_array().unwrap().len(), 2);
    let stats = agent.call("admin_stats", json!({})).await;
    assert_eq!(stats["stats"]["users"], 2);
    assert_eq!(
        stats["stats"]["records"], 15,
        "3 customers + 6 orders + 2 log rows + 4 archived"
    );
    let audit = agent.call("admin_audit_log", json!({})).await;
    assert!(
        audit["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["action"] == "admin_token_use"),
        "token use on admin pages is audited: {audit}"
    );

    // ---- 12. what the agent still cannot do: credentials and tokens stay with the user
    let (is_error, text, _) = agent
        .raw(
            "api_request",
            json!({"method": "POST", "path": "/api/tokens", "body": {"name": "x", "write": true}}),
        )
        .await;
    assert!(is_error && text.contains("not available through MCP"), "{text}");
}
