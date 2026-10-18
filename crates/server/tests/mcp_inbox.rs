//! The inbox through MCP: list, add, edit, file and delete drafts, with a file uploaded for the
//! inbox (`upload_attachment` without a project), and presence through `api_request`.

mod common;
mod mcp_support;

use mcp_support::*;
use serde_json::json;

fn b64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn an_agent_captures_edits_files_and_deletes_drafts() {
    let r = Rig::new().await;
    let a = &r.agent;
    let names = a.tool_names().await;
    for t in [
        "list_inbox",
        "add_to_inbox",
        "update_inbox_item",
        "file_inbox_item",
        "delete_inbox_item",
    ] {
        assert!(names.contains(&t.to_string()), "{t} not listed");
    }

    assert_eq!(a.call("list_inbox", json!({})).await["items"], json!([]));
    let added = a
        .call(
            "add_to_inbox",
            json!({"body": "Buy a **bigger** whiteboard"}),
        )
        .await;
    let id = added["item"]["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("inb"));
    let second = a.call("add_to_inbox", json!({"body": "second"})).await;
    let second_id = second["item"]["id"].as_str().unwrap().to_string();

    let listed = a.call("list_inbox", json!({})).await;
    assert_eq!(listed["items"].as_array().unwrap().len(), 2);
    assert_eq!(listed["items"][0]["id"], second_id, "newest first");

    let edited = a
        .call(
            "update_inbox_item",
            json!({"id": id, "body": "Buy a whiteboard"}),
        )
        .await;
    assert_eq!(edited["item"]["body"], "Buy a whiteboard");
    a.fails("update_inbox_item", json!({"id": id})).await;

    // A file uploaded without a project is for the inbox; only the id is needed to attach it.
    let up = a
        .call(
            "upload_attachment",
            json!({"filename": "receipt.txt", "content_base64": b64(b"42 EUR")}),
        )
        .await;
    let att = up["attachment"]["id"].as_str().unwrap().to_string();
    let with_file = a
        .call(
            "update_inbox_item",
            json!({"id": id, "attachments": [{"id": att}]}),
        )
        .await;
    assert_eq!(
        with_file["item"]["attachments"][0]["filename"],
        "receipt.txt"
    );

    // Filing: choose the table by name, the values by field name.
    let t = r.table("Shopping").await;
    r.field("Shopping", "Notes", "long_text", json!({})).await;
    r.field("Shopping", "Receipt", "attachment", json!({}))
        .await;
    let filed = a
        .call(
            "file_inbox_item",
            json!({"id": id, "project_id": r.base, "table": "Shopping",
                   "fields": {"Name": "Whiteboard", "Notes": "Buy a whiteboard",
                              "Receipt": [{"id": att}]}}),
        )
        .await;
    assert_eq!(filed["filed"], true);
    assert_eq!(filed["record"]["table_id"], t["id"]);
    let rows = a
        .call(
            "list_records",
            json!({"project_id": r.base, "table": "Shopping"}),
        )
        .await;
    let rec = &rows["records"][0]["fields"];
    assert_eq!(rec["Name"], "Whiteboard");
    assert_eq!(rec["Notes"], "Buy a whiteboard");
    assert_eq!(rec["Receipt"][0]["id"], att);
    // The draft is gone; the other one is still there.
    let left = a.call("list_inbox", json!({})).await;
    assert_eq!(left["items"].as_array().unwrap().len(), 1);
    assert_eq!(left["items"][0]["id"], second_id);
    a.fails(
        "file_inbox_item",
        json!({"id": id, "project_id": r.base, "table": "Shopping", "fields": {}}),
    )
    .await;

    // A wrong table names the valid ones; the draft stays.
    let e = a
        .fails(
            "file_inbox_item",
            json!({"id": second_id, "base_id": r.base, "table": "Nope"}),
        )
        .await;
    assert!(e.contains("Shopping"), "{e}");
    assert_eq!(
        a.call("list_inbox", json!({})).await["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    a.call("delete_inbox_item", json!({"id": second_id})).await;
    assert_eq!(a.call("list_inbox", json!({})).await["items"], json!([]));
    a.fails("delete_inbox_item", json!({"id": second_id})).await;
}

#[tokio::test]
async fn read_only_tokens_read_the_inbox_but_cannot_change_it() {
    let r = Rig::new().await;
    let ro = r.agent_with(json!({"write": false})).await;
    let names = ro.tool_names().await;
    assert!(names.contains(&"list_inbox".to_string()));
    for t in [
        "add_to_inbox",
        "update_inbox_item",
        "file_inbox_item",
        "delete_inbox_item",
    ] {
        assert!(
            !names.contains(&t.to_string()),
            "{t} is listed for a read-only token"
        );
    }
    r.agent
        .call("add_to_inbox", json!({"body": "visible"}))
        .await;
    assert_eq!(
        ro.call("list_inbox", json!({})).await["items"][0]["body"],
        "visible"
    );
    ro.fails("add_to_inbox", json!({"body": "nope"})).await;
}

#[tokio::test]
async fn inboxes_are_private_between_users() {
    let r = Rig::new().await;
    r.agent
        .call("add_to_inbox", json!({"body": "admin's"}))
        .await;
    let (_user, mate) = r
        .teammate("mate@example.com", "editor", json!({"write": true}))
        .await;
    assert_eq!(mate.call("list_inbox", json!({})).await["items"], json!([]));
    let mine = r.agent.call("list_inbox", json!({})).await;
    let id = mine["items"][0]["id"].as_str().unwrap();
    let e = mate.fails("delete_inbox_item", json!({"id": id})).await;
    assert!(e.contains("not found"), "{e}");
    mate.fails("update_inbox_item", json!({"id": id, "body": "x"}))
        .await;
}

#[tokio::test]
async fn presence_and_the_inbox_routes_are_in_the_api_catalogue() {
    let r = Rig::new().await;
    let a = &r.agent;
    let inbox = a.call("api_reference", json!({"area": "inbox"})).await;
    let paths: Vec<String> = inbox["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            format!(
                "{} {}",
                e["method"].as_str().unwrap(),
                e["path"].as_str().unwrap()
            )
        })
        .collect();
    for p in [
        "GET /api/inbox",
        "POST /api/inbox",
        "POST /api/inbox/attachments",
        "PATCH /api/inbox/{id}",
        "DELETE /api/inbox/{id}",
        "POST /api/inbox/{id}/file",
    ] {
        assert!(paths.contains(&p.to_string()), "{p} missing from {paths:?}");
    }
    let presence = a
        .call(
            "api_request",
            json!({"method": "GET", "path": format!("/api/bases/{}/presence", r.base)}),
        )
        .await;
    assert_eq!(presence["body"], json!({"viewers": []}), "{presence}");
}

#[tokio::test]
async fn project_limited_tokens_cannot_use_the_inbox() {
    let r = Rig::new().await;
    r.table("Shopping").await;
    let added = r
        .agent
        .call("add_to_inbox", json!({"body": "private note"}))
        .await;
    let id = added["item"]["id"].as_str().unwrap().to_string();

    let limited = r
        .agent_with(json!({"write": true, "base_ids": [r.base]}))
        .await;
    for (tool, args) in [
        ("list_inbox", json!({})),
        ("add_to_inbox", json!({"body": "x"})),
        ("update_inbox_item", json!({"id": id, "body": "x"})),
        ("delete_inbox_item", json!({"id": id})),
        (
            "file_inbox_item",
            json!({"id": id, "project_id": r.base, "table": "Shopping", "fields": {"Name": "x"}}),
        ),
        (
            "upload_attachment",
            json!({"filename": "a.txt", "content_base64": b64(b"hello")}),
        ),
    ] {
        let e = limited.fails(tool, args).await;
        assert!(e.contains("limited to specific"), "{tool}: {e}");
    }
    // Uploading into a project it may reach still works.
    limited
        .call(
            "upload_attachment",
            json!({"project_id": r.base, "filename": "a.txt", "content_base64": b64(b"hello")}),
        )
        .await;
    // Nothing happened to the draft.
    let left = r.agent.call("list_inbox", json!({})).await;
    assert_eq!(left["items"].as_array().unwrap().len(), 1);
    assert_eq!(left["items"][0]["body"], "private note");

    // A token for the same user without a project limit uses the inbox.
    let open = r.agent_with(json!({"write": true})).await;
    assert_eq!(
        open.call("list_inbox", json!({})).await["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn an_agent_embeds_an_inbox_upload_in_a_note_and_files_it() {
    let r = Rig::new().await;
    let a = &r.agent;
    let up = a
        .call(
            "upload_attachment",
            json!({"filename": "site photo.png", "content_base64": b64(b"png?")}),
        )
        .await;
    let att = up["attachment"]["id"].as_str().unwrap().to_string();
    let line = up["markdown"].as_str().unwrap().to_string();
    assert_eq!(
        line,
        format!("![](/api/attachments/{att}/site%20photo.png)")
    );

    let added = a
        .call(
            "add_to_inbox",
            json!({"body": format!("Site visit\n\n{line}")}),
        )
        .await;
    let id = added["item"]["id"].as_str().unwrap().to_string();
    r.table("Visits").await;
    r.field("Visits", "Notes", "long_text", json!({"rich": true}))
        .await;
    let filed = a
        .call(
            "file_inbox_item",
            json!({"id": id, "project_id": r.base, "table": "Visits",
                   "fields": {"Name": "Site", "Notes": format!("Site visit\n\n{line}")}}),
        )
        .await;
    assert_eq!(filed["filed"], true);
    // The upload moved into the project with the record.
    let rows = a
        .call(
            "list_records",
            json!({"project_id": r.base, "table": "Visits"}),
        )
        .await;
    assert!(
        rows["records"][0]["fields"]["Notes"]
            .as_str()
            .unwrap()
            .contains(&att)
    );
}
