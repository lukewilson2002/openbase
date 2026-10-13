//! Share links, automations, files (upload, CSV), history and notifications through MCP tools.

mod common;
mod mcp_support;

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use base64::Engine;
use mcp_support::*;
use serde_json::{Value, json};

// ------------------------------------------------------------------------------- sharing

#[tokio::test]
async fn share_links_publish_views_and_forms_with_optional_passwords() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Tasks").await;
    r.field("Tasks", "Points", "number", json!({})).await;
    r.records("Tasks", json!([{"fields": {"Name": "t1", "Points": 3}}]))
        .await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Board", "type": "grid",
               "config": {"hidden_fields": ["Points"]}}),
    )
    .await;
    a.call(
        "create_view",
        json!({"base_id": b, "table": "Tasks", "name": "Intake", "type": "form"}),
    )
    .await;

    // A read-only public page of a grid view.
    let share = a
        .call("create_share_link", json!({"base_id": b, "view": "Board"}))
        .await["share_link"]
        .clone();
    assert_eq!(share["kind"], "view");
    assert_eq!(share["enabled"], true);
    assert_eq!(share["has_password"], false);
    let url = share["url"].as_str().unwrap();
    assert!(url.starts_with(&format!("{}/s/", r.live.url)), "{url}");
    let token = share["token"].as_str().unwrap().to_string();
    let anon = r.app().anon();
    let page = r
        .app()
        .get(&anon, &format!("/api/public/shares/{token}"))
        .await;
    page.assert_status(200);
    assert_eq!(page.body["name"], "Board");
    let q = r
        .app()
        .post(
            &anon,
            &format!("/api/public/shares/{token}/query"),
            json!({}),
        )
        .await;
    q.assert_status(200);
    assert_eq!(q.body["total"], 1);
    assert_eq!(
        page.body["fields"].as_array().unwrap().len(),
        2,
        "the hidden field is not published: {}",
        page.body
    );

    // Password: set, required, removed.
    let id = share["id"].as_str().unwrap().to_string();
    let upd = a
        .call(
            "update_share_link",
            json!({"share_id": id, "password": "open sesame"}),
        )
        .await;
    assert_eq!(upd["share_link"]["has_password"], true);
    let denied = r
        .app()
        .get(&anon, &format!("/api/public/shares/{token}"))
        .await;
    assert!(
        denied.status.as_u16() == 401 || denied.status.as_u16() == 403,
        "{}",
        denied.body
    );
    let ok = r
        .app()
        .request_with(
            &anon,
            "GET",
            &format!("/api/public/shares/{token}"),
            None,
            &[("x-share-password", "open sesame")],
            true,
            None,
        )
        .await;
    ok.assert_status(200);
    let upd = a
        .call(
            "update_share_link",
            json!({"share_id": id, "password": null}),
        )
        .await;
    assert_eq!(
        upd["share_link"]["has_password"], false,
        "null removes the password"
    );
    r.app()
        .get(&anon, &format!("/api/public/shares/{token}"))
        .await
        .assert_status(200);

    // Disable, list, delete.
    let upd = a
        .call(
            "update_share_link",
            json!({"share_id": id, "enabled": false}),
        )
        .await;
    assert_eq!(upd["share_link"]["enabled"], false);
    assert_eq!(
        r.app()
            .get(&anon, &format!("/api/public/shares/{token}"))
            .await
            .status,
        StatusCode::NOT_FOUND,
        "a disabled link is gone for visitors"
    );
    let listed = a
        .call("list_share_links", json!({"base_id": b, "view": "Board"}))
        .await;
    assert_eq!(listed["share_links"].as_array().unwrap().len(), 1);
    a.call("delete_share_link", json!({"share_id": id})).await;
    assert_eq!(
        a.call("list_share_links", json!({"base_id": b, "view": "Board"}))
            .await["share_links"],
        json!([])
    );

    // Forms
    let form = a
        .call(
            "create_share_link",
            json!({"base_id": b, "view": "Intake", "password": "letmein"}),
        )
        .await["share_link"]
        .clone();
    assert_eq!(
        form["kind"], "form",
        "form views are shared as forms by default"
    );
    assert_eq!(form["has_password"], true);
    let e = a
        .fails(
            "create_share_link",
            json!({"base_id": b, "view": "Board", "kind": "form"}),
        )
        .await;
    assert!(e.contains("not a form view"), "{e}");
    let e = a
        .fails(
            "create_share_link",
            json!({"base_id": b, "view": "Intake", "kind": "view"}),
        )
        .await;
    assert!(e.contains("form view") && e.contains("kind 'form'"), "{e}");
    let e = a
        .fails(
            "create_share_link",
            json!({"base_id": b, "view": "Board", "kind": "page"}),
        )
        .await;
    assert!(e.contains("'view' or 'form'"), "{e}");
    assert!(
        a.fails("update_share_link", json!({"share_id": "shrNope"}))
            .await
            .contains("Give something")
    );
    assert!(
        a.fails(
            "update_share_link",
            json!({"share_id": "shrNope", "enabled": true})
        )
        .await
        .contains("not found")
    );
}

// ----------------------------------------------------------------------------- automations

#[tokio::test]
async fn automations_are_created_with_names_tested_and_run() {
    let r = Rig::new().await;
    r.live.run_automations();
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Orders").await;
    r.field("Orders", "Amount", "number", json!({})).await;
    r.field("Orders", "Flag", "checkbox", json!({})).await;
    r.table("Notes").await;

    // A webhook automation: the secret is returned once.
    let hook = a
        .call(
            "create_automation",
            json!({"base_id": b, "name": "Intake hook", "enabled": true,
                   "trigger": {"type": "webhook"},
                   "actions": [{"type": "create_record", "table": "Notes",
                                "values": {"Name": "Hook says {{trigger.body.text}}"}}]}),
        )
        .await;
    let token = hook["automation"]["webhook_token"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(hook["note"].as_str().unwrap().contains("only now"));
    let id = hook["automation"]["id"].as_str().unwrap().to_string();
    let got = a.call("get_automation", json!({"automation_id": id})).await;
    assert!(
        got["automation"]["webhook_token"].is_null(),
        "the token is not shown again"
    );

    r.app()
        .post(
            &r.app().anon(),
            &format!("/api/hooks/{token}"),
            json!({"text": "hello"}),
        )
        .await
        .assert_status(202);
    let mut seen = false;
    for _ in 0..100 {
        let rows = a
            .call("list_records", json!({"base_id": b, "table": "Notes"}))
            .await;
        if rows["count"] == 1 {
            assert_eq!(rows["records"][0]["fields"]["Name"], "Hook says hello");
            seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(seen, "the webhook ran the automation");
    let runs = a
        .call(
            "list_automation_runs",
            json!({"automation_id": id, "limit": 1}),
        )
        .await;
    assert_eq!(runs["total"], 1);
    assert_eq!(runs["runs"][0]["trigger_data"]["type"], "webhook");

    // Rotating the token invalidates the old one.
    let rot = a
        .call(
            "update_automation",
            json!({"automation_id": id, "rotate_webhook_token": true}),
        )
        .await;
    let new_token = rot["automation"]["webhook_token"].as_str().unwrap();
    assert_ne!(new_token, token);
    assert!(
        r.app()
            .post(&r.app().anon(), &format!("/api/hooks/{token}"), json!({}))
            .await
            .status
            .is_client_error()
    );

    // Replace the trigger and actions using names, with a condition on a field.
    let upd = a
        .call(
            "update_automation",
            json!({"automation_id": id, "name": "Big orders", "enabled": true,
                   "trigger": {"type": "record_updated", "table": "Orders", "field_ids": ["Amount"]},
                   "actions": [{"type": "update_record", "table": "Orders",
                                "record_id": "{{trigger.record.id}}", "values": {"Flag": true},
                                "condition": {"items": [{"field": "Amount", "op": "gt", "value": 100}]}}]}),
        )
        .await;
    assert_eq!(upd["automation"]["name"], "Big orders");
    assert_eq!(upd["automation"]["trigger"]["type"], "record_updated");
    let orders_id = r.schema().await["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Orders")
        .unwrap()["id"]
        .clone();
    assert_eq!(upd["automation"]["trigger"]["table_id"], orders_id);
    // Replacing only the actions keeps the (id-based) trigger and still understands names.
    a.call(
        "update_automation",
        json!({"automation_id": id,
               "actions": [{"type": "update_record", "table": "Orders",
                            "record_id": "{{trigger.record.id}}", "values": {"Flag": true},
                            "condition": {"items": [{"field": "Amount", "op": "gt", "value": 100}]}}]}),
    )
    .await;

    // A real test run against a record: the condition decides.
    let rows = r
        .records("Orders", json!([{"fields": {"Name": "small", "Amount": 5}}, {"fields": {"Name": "big", "Amount": 500}}]))
        .await;
    let (small, big) = (
        rows[0]["id"].as_str().unwrap().to_string(),
        rows[1]["id"].as_str().unwrap().to_string(),
    );
    let t = a
        .call(
            "test_automation",
            json!({"automation_id": id, "record_id": small, "dry_run": false}),
        )
        .await;
    assert_eq!(t["dry_run"], false);
    assert_eq!(
        t["log"][0]["status"], "skipped",
        "the condition did not match: {t}"
    );
    let t = a
        .call(
            "test_automation",
            json!({"automation_id": id, "record_id": big}),
        )
        .await;
    assert_eq!(t["dry_run"], true, "a dry run is the default");
    assert_eq!(t["log"][0]["status"], "succeeded");
    assert_ne!(
        a.call(
            "get_record",
            json!({"base_id": b, "table": "Orders", "record_id": big})
        )
        .await["fields"]["Flag"],
        true,
        "a dry run changes nothing"
    );
    let t = a
        .call(
            "test_automation",
            json!({"automation_id": id, "record_id": big, "dry_run": false}),
        )
        .await;
    assert_eq!(t["status"], "succeeded", "{t}");
    assert_eq!(
        a.call(
            "get_record",
            json!({"base_id": b, "table": "Orders", "record_id": big})
        )
        .await["fields"]["Flag"],
        true
    );

    // Mistakes are explained.
    let e = a
        .fails(
            "create_automation",
            json!({"base_id": b, "name": "x", "trigger": {"type": "record_created", "table": "Nope"}, "actions": []}),
        )
        .await;
    assert!(
        e.contains("Table 'Nope' not found") && e.contains("'Orders'"),
        "{e}"
    );
    let e = a
        .fails(
            "create_automation",
            json!({"base_id": b, "name": "x", "trigger": {"type": "sometimes"}, "actions": []}),
        )
        .await;
    assert!(e.contains("unknown trigger type"), "{e}");
    let e = a
        .fails(
            "create_automation",
            json!({"base_id": b, "name": "x", "trigger": {"type": "webhook"},
                   "actions": [{"type": "create_record", "values": {}}]}),
        )
        .await;
    assert!(e.contains("action 1") && e.contains("table"), "{e}");
    let e = a
        .fails(
            "create_automation",
            json!({"base_id": b, "name": "x", "trigger": {"type": "schedule", "cron": "* * * * *", "timezone": "UTC"}, "actions": []}),
        )
        .await;
    assert!(
        e.to_lowercase().contains("5 minutes") || e.to_lowercase().contains("often"),
        "{e}"
    );
    let e = a
        .fails(
            "create_automation",
            json!({"base_id": b, "name": "x", "trigger": {"type": "webhook"},
                   "actions": [{"type": "notify", "user_ids": [], "message": "m", "condition": {"items": []}}]}),
        )
        .await;
    assert!(
        e.contains("conditions only work with record and form triggers"),
        "{e}"
    );

    // List, then delete.
    let list = a.call("list_automations", json!({"base_id": b})).await;
    assert_eq!(list["automations"].as_array().unwrap().len(), 1);
    a.call("delete_automation", json!({"automation_id": id}))
        .await;
    assert_eq!(
        a.call("list_automations", json!({"base_id": b})).await["automations"],
        json!([])
    );
    assert!(
        a.fails("get_automation", json!({"automation_id": id}))
            .await
            .contains("not found")
    );
}

// ----------------------------------------------------------------------------- files: upload

/// A throwaway file server on 127.0.0.1.
async fn file_server() -> SocketAddr {
    async fn small() -> impl IntoResponse {
        (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "downloaded bytes",
        )
    }
    async fn png() -> impl IntoResponse {
        // A real 1x1 PNG, so the content is sniffed as an image.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            .unwrap();
        ([(header::CONTENT_TYPE, "image/png")], bytes)
    }
    async fn big() -> impl IntoResponse {
        (
            [(header::CONTENT_TYPE, "application/octet-stream")],
            vec![7u8; 2 * 1024 * 1024],
        )
    }
    async fn redirect() -> impl IntoResponse {
        (StatusCode::FOUND, [(header::LOCATION, "/small.txt")])
    }
    async fn gone() -> impl IntoResponse {
        (StatusCode::NOT_FOUND, "nothing here")
    }
    let app = Router::new()
        .route("/files/small.txt", get(small))
        .route("/files/pixel.png", get(png))
        .route("/files/big.bin", get(big))
        .route("/redirect", get(redirect))
        .route("/gone", get(gone));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.ok() });
    addr
}

#[tokio::test]
async fn attachments_upload_from_base64_and_from_urls() {
    let r = Rig::with(|c| {
        c.allow_private_webhooks = true; // the test server is on 127.0.0.1
        c.max_upload_mb = 1;
    })
    .await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("Docs").await;
    r.field("Docs", "File", "attachment", json!({})).await;
    let addr = file_server().await;
    let url = |p: &str| format!("http://{addr}{p}");

    // base64
    let up = a
        .call(
            "upload_attachment",
            json!({"base_id": b, "filename": "a b.txt",
                   "content_base64": base64::engine::general_purpose::STANDARD.encode("hello")}),
        )
        .await;
    assert_eq!(up["attachment"]["filename"], "a b.txt");
    assert_eq!(up["attachment"]["size"], 5);
    assert_eq!(up["attachment"]["mime"], "text/plain");

    // URL: name from the path, content fetched by the server
    let up = a
        .call(
            "upload_attachment",
            json!({"base_id": b, "url": url("/files/small.txt")}),
        )
        .await;
    assert_eq!(up["attachment"]["filename"], "small.txt");
    assert_eq!(up["attachment"]["size"], "downloaded bytes".len());
    let up = a
        .call(
            "upload_attachment",
            json!({"base_id": b, "url": url("/files/pixel.png"), "filename": "dot.png"}),
        )
        .await;
    assert_eq!(up["attachment"]["filename"], "dot.png");
    assert_eq!(up["attachment"]["mime"], "image/png");
    assert_eq!(up["attachment"]["width"], 1);
    // ...usable in a record, and downloadable with the token
    let att = up["attachment"]["id"].as_str().unwrap().to_string();
    let rec = r
        .records(
            "Docs",
            json!([{"fields": {"Name": "d", "File": [{"id": att}]}}]),
        )
        .await;
    assert_eq!(rec[0]["fields"]["File"][0]["filename"], "dot.png");

    // Refusals
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "url": url("/files/big.bin")}),
        )
        .await;
    assert!(e.contains("larger than the upload limit of 1 MB"), "{e}");
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "url": url("/redirect")}),
        )
        .await;
    assert!(e.contains("redirect"), "{e}");
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "url": url("/gone")}),
        )
        .await;
    assert!(e.contains("404"), "{e}");
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "url": "ftp://example.com/x"}),
        )
        .await;
    assert!(e.contains("http"), "{e}");
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "filename": "x", "content_base64": "e30=", "url": url("/gone")}),
        )
        .await;
    assert!(e.contains("not both"), "{e}");
    let e = a.fails("upload_attachment", json!({"base_id": b})).await;
    assert!(e.contains("content_base64") && e.contains("url"), "{e}");
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "content_base64": "e30="}),
        )
        .await;
    assert!(e.contains("filename is required"), "{e}");
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "filename": "x", "content_base64": "not base64!!"}),
        )
        .await;
    assert!(e.contains("not valid base64"), "{e}");
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "filename": "x", "content_base64": ""}),
        )
        .await;
    assert!(e.contains("empty") || e.contains("filename"), "{e}");
    let too_big = base64::engine::general_purpose::STANDARD.encode(vec![1u8; 1024 * 1024 + 10]);
    let e = a
        .fails(
            "upload_attachment",
            json!({"base_id": b, "filename": "big.bin", "content_base64": too_big}),
        )
        .await;
    assert!(e.contains("larger than the upload limit of 1 MB"), "{e}");
    // The names that reach the file system and headers are cleaned.
    let up = a
        .call(
            "upload_attachment",
            json!({"base_id": b, "filename": "../..\\evil\"name.txt", "content_base64": "aGk="}),
        )
        .await;
    assert!(
        !up["attachment"]["filename"]
            .as_str()
            .unwrap()
            .contains(['/', '\\', '"']),
        "{up}"
    );

    // A viewer cannot upload.
    let (_, viewer) = r
        .teammate("v@example.com", "viewer", json!({"write": true}))
        .await;
    let e = viewer
        .fails(
            "upload_attachment",
            json!({"base_id": b, "filename": "x", "content_base64": "aGk="}),
        )
        .await;
    assert!(e.contains("editor role"), "{e}");
}

#[tokio::test]
async fn url_uploads_go_through_the_ssrf_guard() {
    // The default configuration: private and loopback addresses are refused.
    let r = Rig::new().await;
    let a = &r.agent;
    let addr = file_server().await;
    for url in [
        format!("http://{addr}/files/small.txt"),
        "http://127.0.0.1:1/x".to_string(),
        "http://localhost/x".to_string(),
        "http://169.254.169.254/latest/meta-data/".to_string(),
        "http://10.0.0.1/x".to_string(),
        "http://[::1]/x".to_string(),
        "http://2130706433/x".to_string(),
        "http://user:pass@example.com/x".to_string(),
    ] {
        let e = a
            .fails("upload_attachment", json!({"base_id": r.base, "url": url}))
            .await;
        assert!(
            e.contains("Could not fetch the URL")
                && (e.contains("private") || e.contains("user name") || e.contains("resolve")),
            "{url}: {e}"
        );
    }
    assert_eq!(
        r.app().query_i64("SELECT count(*) FROM attachments", &[]),
        0,
        "nothing was stored"
    );
}

// ----------------------------------------------------------------------------- files: CSV

#[tokio::test]
async fn csv_exports_are_cut_at_row_boundaries_with_a_note() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    // 600 rows of ~250 bytes: far over the cap; cells with commas, quotes and line breaks.
    let mut csv = String::from("Name,Text\n");
    for i in 0..600 {
        csv.push_str(&format!(
            "row {i},\"{} \"\"quoted\"\", with a comma\nand a line break\"\n",
            "x".repeat(200)
        ));
    }
    let imp = a
        .call(
            "import_csv",
            json!({"base_id": b, "new_table_name": "Big", "csv_text": csv}),
        )
        .await;
    assert_eq!(imp["created"], 600);

    let (is_error, text, meta) = a
        .raw(
            "export_csv",
            json!({"base_id": b, "table": "Big", "view": "Grid view"}),
        )
        .await;
    assert!(!is_error, "{text}");
    assert_eq!(meta["total_rows"], 600);
    assert_eq!(meta["truncated"], true);
    let rows = meta["rows"].as_u64().unwrap();
    assert!(rows > 100 && rows < 600, "{rows}");
    assert!(
        text.len() < 90_000,
        "the text stays small: {} bytes",
        text.len()
    );
    let (body, note) = text.rsplit_once("[cut:").expect("the cut is announced");
    assert!(note.contains(&format!("{rows} of 600 rows")), "{note}");
    // Everything before the note is whole rows of valid CSV.
    let mut reader = csv::ReaderBuilder::new().from_reader(body.trim_end().as_bytes());
    assert_eq!(reader.headers().unwrap().len(), 2, "Name and Text");
    let mut n = 0;
    for rec in reader.records() {
        let rec = rec.expect("whole rows only");
        assert!(rec.get(0).unwrap().starts_with("row "));
        n += 1;
    }
    assert_eq!(n as u64, rows);

    // A small export is complete and not marked as cut.
    a.call(
        "import_csv",
        json!({"base_id": b, "new_table_name": "Small", "csv_text": "Name,Text\nrow 0,a\nrow 1,b\n"}),
    )
    .await;
    let (_, text, meta) = a
        .raw(
            "export_csv",
            json!({"base_id": b, "table": "Small", "view": "Grid view"}),
        )
        .await;
    assert_eq!(text, "Name,Text\r\nrow 0,a\r\nrow 1,b\r\n");
    assert_eq!(meta["truncated"], false);
    assert_eq!(meta["rows"], 2);
    assert_eq!(meta["total_rows"], 2);
}

#[tokio::test]
async fn csv_round_trips_odd_cells_and_imports_with_mappings() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("People").await;
    r.field("People", "Qty", "number", json!({})).await;
    r.field(
        "People",
        "Status",
        "single_select",
        json!({"choices": ["Open", "Done"]}),
    )
    .await;
    r.records(
        "People",
        json!([
            {"fields": {"Name": "Plain", "Qty": 1, "Status": "Open"}},
            {"fields": {"Name": "Comma, \"quote\"\nnewline", "Qty": 2.5, "Status": "Done"}},
            {"fields": {"Name": "=SUM(A1)", "Qty": 3}},
        ]),
    )
    .await;
    let csv = a
        .text(
            "export_csv",
            json!({"base_id": b, "table": "People", "view": "Grid view"}),
        )
        .await;
    assert!(
        csv.starts_with("Name,"),
        "the byte order mark is not part of the text"
    );
    assert!(csv.contains("'=SUM(A1)"), "formulas are defused: {csv}");
    let copy = a
        .call(
            "import_csv",
            json!({"base_id": b, "new_table_name": "People copy", "csv_text": csv}),
        )
        .await;
    assert_eq!(copy["created"], 3);
    let fields: Vec<(&str, &str)> = copy["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["name"].as_str().unwrap(), f["type"].as_str().unwrap()))
        .collect();
    assert!(
        fields.contains(&("Qty", "number")),
        "types are inferred: {fields:?}"
    );
    let rows = a
        .call(
            "list_records",
            json!({"base_id": b, "table": "People copy"}),
        )
        .await;
    let names: Vec<&str> = rows["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["fields"]["Name"].as_str().unwrap())
        .collect();
    // Line breaks in a single-line text field became spaces when the record was written, and
    // the defused formula keeps its apostrophe: the export shows exactly what is stored.
    assert!(names.contains(&"Comma, \"quote\" newline"), "{names:?}");
    assert!(names.contains(&"'=SUM(A1)"), "{names:?}");

    // Into an existing table: columns by name, mapped columns, skipped columns.
    let into = a
        .call(
            "import_csv",
            json!({"base_id": b, "table": "People",
                   "csv_text": "Who,How many,Ignore me\nZed,7,x\nYan,8,y\n",
                   "mapping": {"Who": "Name", "How many": "Qty", "Ignore me": null}}),
        )
        .await;
    assert_eq!(into["created"], 2);
    let zed = a
        .call(
            "list_records",
            json!({"base_id": b, "table": "People", "filter_by_formula": "{Name} = 'Zed'"}),
        )
        .await;
    assert_eq!(zed["records"][0]["fields"]["Qty"], 7);
    // Without a header the mapping keys are column numbers.
    let into = a
        .call(
            "import_csv",
            json!({"base_id": b, "table": "People", "has_header": false,
                   "csv_text": "Xan,9\n", "mapping": {"0": "Name", "1": "Qty"}}),
        )
        .await;
    assert_eq!(into["created"], 1);
    // A select column creates its choices on the way in, like pasting.
    a.call(
        "import_csv",
        json!({"base_id": b, "table": "People", "csv_text": "Name,Status\nVic,Blocked\n"}),
    )
    .await;
    let vic = a
        .call(
            "list_records",
            json!({"base_id": b, "table": "People", "filter_by_formula": "{Name} = 'Vic'"}),
        )
        .await;
    assert_eq!(vic["records"][0]["fields"]["Status"], "Blocked");
}

#[tokio::test]
async fn csv_imports_are_all_or_nothing_and_say_which_rows_failed() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("People").await;
    r.field("People", "Qty", "number", json!({})).await;
    let e = a
        .fails(
            "import_csv",
            json!({"base_id": b, "table": "People",
                   "csv_text": "Name,Qty\nGood,1\nBad,not a number\nWorse,also not\n"}),
        )
        .await;
    assert!(
        e.contains("rejected and nothing was written") && e.contains("row 3"),
        "{e}"
    );
    assert_eq!(
        a.call("list_records", json!({"base_id": b, "table": "People"}))
            .await["count"],
        0,
        "the good row was not imported either"
    );

    let args = |extra: Value| {
        let mut v = json!({"base_id": b, "csv_text": "Name\nx\n"});
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    };
    let e = a.fails("import_csv", args(json!({}))).await;
    assert!(e.contains("table") && e.contains("new_table_name"), "{e}");
    let e = a
        .fails(
            "import_csv",
            args(json!({"table": "People", "new_table_name": "X"})),
        )
        .await;
    assert!(e.contains("not both"), "{e}");
    let e = a.fails("import_csv", args(json!({"table": "Nope"}))).await;
    assert!(e.contains("Table 'Nope' not found"), "{e}");
    let e = a
        .fails(
            "import_csv",
            args(json!({"table": "People", "mapping": {"Name": "Missing"}})),
        )
        .await;
    assert!(
        e.contains("mapping") && e.contains("Field 'Missing' not found"),
        "{e}"
    );
    let e = a
        .fails(
            "import_csv",
            args(json!({"table": "People", "mapping": "Name=Name"})),
        )
        .await;
    assert!(e.contains("mapping must be an object"), "{e}");
    let e = a
        .fails(
            "import_csv",
            args(json!({"new_table_name": "X", "mapping": {"a": "b"}})),
        )
        .await;
    assert!(e.contains("mapping applies to an existing table"), "{e}");
    let e = a
        .fails(
            "import_csv",
            json!({"base_id": b, "table": "People", "csv_text": "  "}),
        )
        .await;
    assert!(e.contains("csv_text is empty"), "{e}");
    // Viewers cannot import.
    let (_, viewer) = r
        .teammate("v@example.com", "viewer", json!({"write": true}))
        .await;
    let e = viewer
        .fails("import_csv", args(json!({"table": "People"})))
        .await;
    assert!(e.contains("editor role"), "{e}");
}

// ------------------------------------------------------------- history and notifications

#[tokio::test]
async fn history_pages_and_notifications_can_be_marked_read() {
    let r = Rig::new().await;
    let a = &r.agent;
    let b = r.base.as_str();
    r.table("T").await;
    r.field("T", "N", "number", json!({})).await;
    let rec = r
        .records("T", json!([{"fields": {"Name": "x", "N": 0}}]))
        .await[0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    for n in 1..=5 {
        a.call(
            "update_records",
            json!({"base_id": b, "table": "T", "records": [{"id": rec, "fields": {"N": n}}]}),
        )
        .await;
    }
    let p1 = a
        .call("get_record_history", json!({"record_id": rec, "limit": 2}))
        .await;
    assert_eq!(p1["count"], 2);
    assert_eq!(
        p1["entries"][0]["changes"]["N"],
        json!({"old": 4, "new": 5})
    );
    let before = p1["next_before"].as_i64().unwrap();
    let p2 = a
        .call(
            "get_record_history",
            json!({"record_id": rec, "limit": 2, "before": before}),
        )
        .await;
    assert_eq!(
        p2["entries"][0]["changes"]["N"],
        json!({"old": 2, "new": 3})
    );
    let all = a
        .call("get_record_history", json!({"record_id": rec}))
        .await;
    assert_eq!(all["count"], 6, "create + 5 updates");
    assert!(all.get("next_before").is_none());
    assert!(
        a.fails("get_record_history", json!({"record_id": "recNope"}))
            .await
            .contains("not found")
    );

    // Three mentions from a teammate; mark one, then the rest.
    let (mate, _) = r
        .teammate("mate@example.com", "editor", json!({"write": true}))
        .await;
    let me = r.admin.user_id.clone().unwrap();
    for i in 0..3 {
        r.app()
            .post(
                &mate,
                &format!("/api/records/{rec}/comments"),
                json!({"body": format!("@[Admin]({me}) look {i}")}),
            )
            .await
            .assert_status(201);
    }
    let n = a.call("list_notifications", json!({})).await;
    assert_eq!(n["unread"], 3);
    assert_eq!(n["notifications"].as_array().unwrap().len(), 3);
    let first = n["notifications"][0]["id"].as_str().unwrap().to_string();
    let limited = a.call("list_notifications", json!({"limit": 1})).await;
    assert_eq!(limited["count"], 1);
    assert_eq!(
        limited["unread"], 3,
        "the count is of all unread, not of the page"
    );
    let m = a
        .call("mark_notifications_read", json!({"ids": [first]}))
        .await;
    assert_eq!(m["marked"], 1);
    let n = a
        .call("list_notifications", json!({"unread_only": true}))
        .await;
    assert_eq!(n["unread"], 2);
    assert_eq!(n["count"], 2);
    a.call("mark_notifications_read", json!({})).await;
    assert_eq!(a.call("list_notifications", json!({})).await["unread"], 0);

    // Trash errors
    let e = a
        .fails(
            "restore_from_trash",
            json!({"kind": "spreadsheet", "id": "x"}),
        )
        .await;
    assert!(e.contains("Unknown kind") && e.contains("record"), "{e}");
    let e = a
        .fails(
            "restore_from_trash",
            json!({"kind": "record", "id": "recNope"}),
        )
        .await;
    assert!(e.contains("not found"), "{e}");
    let e = a
        .fails("list_trash", json!({"base_id": b, "workspace_id": r.ws}))
        .await;
    assert!(e.contains("not both"), "{e}");
}
