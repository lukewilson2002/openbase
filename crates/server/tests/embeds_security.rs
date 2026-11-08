//! Embeds (REC-6, BE-8) read views and linked records on behalf of the person looking at a page. The page
//! only asks for what the server lists for that person, but the server is what decides: a view the reader
//! cannot open answers nothing about itself or its records, whoever writes the embed, whatever the text says.
//! The embed block itself is only text, which the server stores as written and leaves out of search.

mod common;
mod schema_support;

use openbase::perm::Role;
use schema_support::*;
use serde_json::{Value, json};

use common::Client;

/// A second folder with a table of its own, a record and a shared view, in the fixture's workspace.
struct Secret {
    base_id: String,
    view_id: String,
    table_id: String,
}

async fn secret_folder(f: &Fixture) -> Secret {
    let folder = base(&f.app, &f.owner, &f.ws, "Payroll").await;
    let base_id = id_of(&folder);
    let table = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{base_id}/tables"),
            json!({ "name": "Salaries" }),
        )
        .await;
    table.assert_status(201);
    let table_id = id_of(&table.body);
    let primary = table.body["primary_field_id"].as_str().unwrap().to_string();
    insert_record(&f.app, &table_id, json!({ primary: "Zelda Zoltan 120000" }));
    let view = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{table_id}/views"),
            json!({ "name": "Everyone's pay", "type": "grid" }),
        )
        .await;
    view.assert_status(201);
    Secret {
        base_id,
        view_id: id_of(&view.body),
        table_id,
    }
}

fn query_path(view_id: &str) -> String {
    format!("/api/views/{view_id}/query")
}

/// What no response to a reader who cannot open the view may contain.
fn assert_no_leak(body: &Value) {
    let text = body.to_string();
    for secret in ["Zelda", "120000", "Everyone's pay", "Payroll", "Salaries"] {
        assert!(!text.contains(secret), "leaked {secret}: {text}");
    }
}

#[tokio::test]
async fn a_member_limited_to_one_folder_cannot_read_a_view_of_another() {
    let f = Fixture::new().await;
    let secret = secret_folder(&f).await;
    let guest = f.base_guest("guest@example.com", Role::Editor);

    let r = f
        .app
        .post(&guest, &query_path(&secret.view_id), json!({ "limit": 10 }))
        .await;
    r.assert_status(404);
    assert_no_leak(&r.body);
    // The same limit for the folder's other doors: its schema, its records, its listing in the workspace.
    f.app
        .get(&guest, &format!("/api/bases/{}", secret.base_id))
        .await
        .assert_status(404);
    f.app
        .get(
            &guest,
            &format!("/api/tables/{}/records/lookup?q=Zelda", secret.table_id),
        )
        .await
        .assert_status(404);
    let ws = f.app.get(&guest, "/api/workspaces").await;
    ws.assert_status(200);
    assert_no_leak(&ws.body);
    // The owner reads it, so the 404 is the guest's access and not a broken view.
    let ok = f
        .app
        .post(
            &f.owner,
            &query_path(&secret.view_id),
            json!({ "limit": 10 }),
        )
        .await;
    ok.assert_status(200);
    assert_eq!(ok.body["total"], 1);
}

#[tokio::test]
async fn a_view_the_reader_cannot_open_answers_like_one_that_does_not_exist() {
    let f = Fixture::new().await;
    let secret = secret_folder(&f).await;
    let guest = f.base_guest("guest@example.com", Role::Viewer);
    let closed = f
        .app
        .post(&guest, &query_path(&secret.view_id), json!({ "limit": 10 }))
        .await;
    let missing = f
        .app
        .post(
            &guest,
            &query_path("viwDoesNotExist00"),
            json!({ "limit": 10 }),
        )
        .await;
    closed.assert_status(404);
    missing.assert_status(404);
    // Nothing tells an id that is there from one that is not: the same status and the same code.
    assert_eq!(closed.body["error"]["code"], missing.body["error"]["code"]);
}

#[tokio::test]
async fn a_view_of_another_workspace_is_not_there_for_someone_who_is_not_a_member() {
    let f = Fixture::new().await;
    let secret = secret_folder(&f).await;
    let outsider = f.app.user("outsider@example.com", "Outsider");
    // Their own workspace and view: an embed can name any id, but each answer is for the one asking.
    let ws = workspace(&f.app, &outsider, "Elsewhere").await;
    let theirs = id_of(&base(&f.app, &outsider, &ws, "Theirs").await);
    let table = f
        .app
        .post(
            &outsider,
            &format!("/api/bases/{theirs}/tables"),
            json!({ "name": "Theirs" }),
        )
        .await;
    table.assert_status(201);
    let own_view = table.body["views"][0]["id"].as_str().unwrap().to_string();
    f.app
        .post(
            &outsider,
            &query_path(&secret.view_id),
            json!({ "limit": 10 }),
        )
        .await
        .assert_status(404);
    f.app
        .post(&outsider, &query_path(&own_view), json!({ "limit": 10 }))
        .await
        .assert_status(200);
    // And a member of ours does not read theirs.
    f.app
        .post(&f.owner, &query_path(&own_view), json!({ "limit": 10 }))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn nobody_reads_another_persons_personal_view() {
    let f = Fixture::new().await;
    let editor = f.member("editor@example.com", Role::Editor);
    let made = f
        .app
        .post(
            &editor,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Only mine", "type": "grid", "personal": true }),
        )
        .await;
    made.assert_status(201);
    let id = id_of(&made.body);
    // Not the owner of the workspace, not a creator, not another editor.
    let other = f.member("other@example.com", Role::Editor);
    let creator = f.member("creator@example.com", Role::Creator);
    for who in [&f.owner, &other, &creator] {
        let r = f
            .app
            .post(who, &query_path(&id), json!({ "limit": 10 }))
            .await;
        r.assert_status(404);
        assert!(!r.body.to_string().contains("Only mine"));
        // And it is in nobody else's schema, so a page has nothing to look it up in.
        let schema = f.app.get(who, &format!("/api/bases/{}", f.base_id)).await;
        assert!(!schema.body.to_string().contains("Only mine"));
    }
    f.app
        .post(&editor, &query_path(&id), json!({ "limit": 10 }))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_token_limited_to_some_folders_cannot_read_a_view_of_the_others() {
    let f = Fixture::new().await;
    let secret = secret_folder(&f).await;
    let token = f.app.raw_token(
        &f.owner,
        json!({ "write": false, "base_ids": [f.base_id.clone()] }),
    );
    let r = f
        .app
        .post(&token, &query_path(&secret.view_id), json!({ "limit": 10 }))
        .await;
    r.assert_status(404);
    assert_no_leak(&r.body);
}

#[tokio::test]
async fn nobody_signed_out_reads_a_view() {
    let f = Fixture::new().await;
    let secret = secret_folder(&f).await;
    let anon: Client = f.app.anon();
    let r = f
        .app
        .post(&anon, &query_path(&secret.view_id), json!({ "limit": 10 }))
        .await;
    r.assert_status(401);
    assert_no_leak(&r.body);
}

#[tokio::test]
async fn a_view_in_the_trash_is_not_readable() {
    let f = Fixture::new().await;
    let secret = secret_folder(&f).await;
    f.app
        .delete(&f.owner, &format!("/api/views/{}", secret.view_id))
        .await
        .assert_status(200);
    let r = f
        .app
        .post(
            &f.owner,
            &query_path(&secret.view_id),
            json!({ "limit": 10 }),
        )
        .await;
    r.assert_status(404);
    assert_no_leak(&r.body);
}

#[tokio::test]
async fn an_embed_is_text_the_server_stores_as_written_and_does_not_search() {
    let f = Fixture::new().await;
    // Whatever is in the block, a write keeps it: reading it is the page's strict job, and showing it is
    // the reader's permission. Nothing here makes the server fetch or check anything the text names.
    let hostile = "```openbase\n{\"embed\":\"view\",\"view\":\"viwOtherWorkspace1\",\"limit\":10,\"x\":\"<script>alert(1)</script>\"}\n```";
    let text = format!("Intro words\n\n{hostile}\n\nClosing words");
    let id = f.insert_record(&f.table_id, json!({ f.primary_id.clone(): "Page one" }));
    f.app
        .patch(
            &f.owner,
            &format!("/api/tables/{}/records", f.table_id),
            json!({ "records": [{ "id": id, "values": { f.notes_id.clone(): text } }] }),
        )
        .await
        .assert_status(200);
    assert_eq!(f.record_data(&id)[&f.notes_id], text.as_str());
    // The text around the block is found, the block's JSON is not.
    for (needle, expected) in [
        ("Closing", 1),
        ("viwOtherWorkspace1", 0),
        ("script", 0),
        ("embed", 0),
    ] {
        let r = f
            .app
            .get(&f.owner, &format!("/api/search?q={needle}&limit=20"))
            .await;
        r.assert_status(200);
        let hits = r.body["results"]
            .as_array()
            .map(|a| a.iter().filter(|x| x["record_id"] == id.as_str()).count())
            .unwrap_or(0);
        assert_eq!(hits, expected, "search for {needle}: {}", r.body);
    }
}
