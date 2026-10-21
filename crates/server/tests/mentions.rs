//! @mentions in long text cells and Inbox drafts: who gets a `mention`
//! notification, and when (only once the text is on a record). Mentions in
//! comments are covered in comments.rs.

mod common;
mod records_support;
mod schema_support;

use common::Client;
use ob_core::api::records::NewRecord;
use openbase::engine::write::{self, CreateOpts, WriteCtx, WriteSource};
use openbase::perm::Role;
use records_support::*;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn mention(name: &str, user: &Client) -> String {
    format!("@[{name}]({})", user.user_id.as_ref().unwrap())
}

/// `(kind, payload)` of a user's notifications, oldest first.
fn notifications_of(f: &Fixture, user: &Client) -> Vec<(String, Value)> {
    let uid = user.user_id.clone().unwrap();
    sql(&f.app, |tx| {
        let mut stmt = tx.prepare(
            "SELECT kind, payload FROM notifications WHERE user_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt
            .query_map([&uid], |r| {
                let p: String = r.get(1)?;
                Ok((r.get(0)?, serde_json::from_str(&p).unwrap()))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

fn mentions_of(f: &Fixture, user: &Client) -> Vec<Value> {
    notifications_of(f, user)
        .into_iter()
        .filter(|(k, _)| k == "mention")
        .map(|(_, p)| p)
        .collect()
}

/// A fixture whose Notes field is rich text, with Ann (a workspace member).
async fn setup() -> (Fixture, Client) {
    let f = Fixture::new().await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/fields/{}", f.notes_id),
            json!({ "options": {} }),
        )
        .await
        .assert_status(200);
    let ann = f.member("ann@example.com", Role::Viewer);
    (f, ann)
}

#[tokio::test]
async fn creating_a_record_with_a_mention_notifies_once_it_is_saved() {
    let (f, ann) = setup().await;
    let text = format!(
        "**Plan** for the launch: {} can you check the date?",
        mention("Ann", &ann)
    );
    let rec = f
        .create(
            &f.table_id,
            json!({ &f.primary_id: "Launch", &f.notes_id: text }),
        )
        .await;
    let n = mentions_of(&f, &ann);
    assert_eq!(n.len(), 1);
    let p = &n[0];
    assert_eq!(p["record_id"], rec["id"]);
    assert_eq!(p["record_name"], "Launch");
    assert_eq!(p["base_id"], f.base_id);
    assert_eq!(p["table_id"], f.table_id);
    assert_eq!(p["field_id"], f.notes_id);
    assert_eq!(p["field_name"], "Notes");
    assert_eq!(p["author_id"], f.owner.user_id.clone().unwrap());
    assert_eq!(p["author_name"], "Owner");
    assert!(p.get("comment_id").is_none());
    assert_eq!(
        p["snippet"], "Plan for the launch: @Ann can you check the date?",
        "plain text, no markup or ids"
    );
}

#[tokio::test]
async fn updating_a_cell_notifies_only_the_newly_mentioned() {
    let (f, ann) = setup().await;
    let bob = f.base_guest("bob@example.com", Role::Commenter);
    let rec = f
        .create(
            &f.table_id,
            json!({ &f.notes_id: format!("hi {}", mention("Ann", &ann)) }),
        )
        .await;
    let id = sid(&rec["id"]).to_string();
    assert_eq!(mentions_of(&f, &ann).len(), 1);

    let both = format!("hi {} and {}", mention("Ann", &ann), mention("Bob", &bob));
    f.set(&f.table_id, &id, json!({ &f.notes_id: both })).await;
    assert_eq!(mentions_of(&f, &ann).len(), 1, "Ann was already mentioned");
    assert_eq!(mentions_of(&f, &bob).len(), 1);

    // Saving again (the same text, or other edits around the same mentions) tells nobody again.
    f.set(&f.table_id, &id, json!({ &f.notes_id: both })).await;
    f.set(
        &f.table_id,
        &id,
        json!({ &f.notes_id: format!("{both}, thanks"), &f.primary_id: "Renamed" }),
    )
    .await;
    assert_eq!(mentions_of(&f, &ann).len(), 1);
    assert_eq!(mentions_of(&f, &bob).len(), 1);

    // A mention that was removed and comes back is new again.
    f.set(&f.table_id, &id, json!({ &f.notes_id: "nobody" }))
        .await;
    f.set(
        &f.table_id,
        &id,
        json!({ &f.notes_id: mention("Ann", &ann) }),
    )
    .await;
    assert_eq!(mentions_of(&f, &ann).len(), 2);
}

#[tokio::test]
async fn not_the_author_nor_people_without_access() {
    let (f, ann) = setup().await;
    let outsider = f.app.user("outsider@example.com", "Outsider");
    let gone = f.member("gone@example.com", Role::Viewer);
    let gone_id = gone.user_id.clone().unwrap();
    sql(&f.app, |tx| {
        tx.execute("UPDATE users SET is_active = 0 WHERE id = ?1", [&gone_id])
    });
    let text = format!(
        "{} {} {} @[Nobody](usrDoesNotExist1)",
        mention("Me", &f.owner),
        mention("Outsider", &outsider),
        mention("Gone", &gone),
    );
    f.create(&f.table_id, json!({ &f.notes_id: text })).await;
    assert!(mentions_of(&f, &f.owner).is_empty(), "not the author");
    assert!(
        mentions_of(&f, &outsider).is_empty(),
        "cannot read the base"
    );
    assert!(mentions_of(&f, &gone).is_empty(), "deactivated");
    assert!(mentions_of(&f, &ann).is_empty());

    // An editor who mentions the owner: the owner is told, the editor (author) is not.
    let editor = f.member("editor@example.com", Role::Editor);
    f.create_as(&editor, &f.table_id, json!({ &f.notes_id: format!("{} {}", mention("Owner", &f.owner), mention("Me", &editor)) }))
        .await
        .assert_status(201);
    let n = mentions_of(&f, &f.owner);
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["author_id"], editor.user_id.clone().unwrap());
    assert!(mentions_of(&f, &editor).is_empty());
}

#[tokio::test]
async fn look_alikes_notify_nobody() {
    let (f, ann) = setup().await;
    let id = ann.user_id.clone().unwrap();
    // In code, typed as text (the editor escapes brackets), or a plain link without the @.
    let text = format!("`@[Ann]({id})`\n\n```\n@[Ann]({id})\n```\n\n@\\[Ann\\]({id}) [Ann]({id})");
    f.create(&f.table_id, json!({ &f.notes_id: text })).await;
    assert!(mentions_of(&f, &ann).is_empty());
}

#[tokio::test]
async fn one_notification_per_record_however_many_fields_mention_someone() {
    let (f, ann) = setup().await;
    let more = id_of(
        &f.add_field(
            &f.table_id,
            json!({ "name": "More", "type": "rich_text", "options": {} }),
        )
        .await,
    );
    f.create(
        &f.table_id,
        json!({ &f.notes_id: mention("Ann", &ann), &more: mention("Ann", &ann) }),
    )
    .await;
    assert_eq!(mentions_of(&f, &ann).len(), 1);
}

#[tokio::test]
async fn mentions_in_other_text_fields_are_just_text() {
    let (f, ann) = setup().await;
    // The primary field is single-line text: not a place for mentions.
    f.create(&f.table_id, json!({ &f.primary_id: mention("Ann", &ann) }))
        .await;
    assert!(mentions_of(&f, &ann).is_empty());
}

#[tokio::test]
async fn the_v1_api_notifies_like_the_app() {
    let (f, ann) = setup().await;
    let token = f
        .app
        .api_token(&f.owner, json!({ "name": "t", "write": true }))
        .await;
    let r = f
        .app
        .post(
            &token,
            &format!("/api/v1/{}/{}", f.base_id, f.table_id),
            json!({ "fields": { "Notes": format!("see {}", mention("Ann", &ann)) } }),
        )
        .await;
    r.assert_status(200);
    let id = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(mentions_of(&f, &ann).len(), 1);
    // A PATCH that keeps the mention tells nobody again.
    f.app
        .patch(
            &token,
            &format!("/api/v1/{}/{}/{id}", f.base_id, f.table_id),
            json!({ "fields": { "Notes": format!("see {} today", mention("Ann", &ann)) } }),
        )
        .await
        .assert_status(200);
    assert_eq!(mentions_of(&f, &ann).len(), 1);
}

#[tokio::test]
async fn a_write_without_an_actor_notifies_nobody() {
    // An anonymous form submission has no author to name.
    let (f, ann) = setup().await;
    let mut values = BTreeMap::new();
    values.insert(f.notes_id.clone(), json!(mention("Ann", &ann)));
    let table = f.table_id.clone();
    f.app
        .state
        .db
        .write_sync(move |tx| {
            let ctx = WriteCtx::new(
                None,
                WriteSource::Form {
                    view_id: "viwX".into(),
                },
            );
            write::create_records(
                tx,
                &ctx,
                &table,
                vec![NewRecord { values }],
                &CreateOpts::default(),
            )?;
            Ok(())
        })
        .unwrap();
    assert!(mentions_of(&f, &ann).is_empty());
}

// ------------------------------------------------------------------ inbox

async fn draft(f: &Fixture, body: &str) -> String {
    let r = f
        .app
        .post(&f.owner, "/api/inbox", json!({ "body": body }))
        .await;
    r.assert_status(201);
    r.body["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_draft_notifies_nobody_until_it_is_filed() {
    let (f, ann) = setup().await;
    let body = format!("Call the venue, {} knows the number", mention("Ann", &ann));
    let id = draft(&f, "first thoughts").await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/inbox/{id}"),
            json!({ "body": body }),
        )
        .await
        .assert_status(200);
    assert!(mentions_of(&f, &ann).is_empty(), "a draft is private");

    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": { &f.primary_id: "Venue", &f.notes_id: body } }),
        )
        .await;
    r.assert_status(201);
    let n = mentions_of(&f, &ann);
    assert_eq!(n.len(), 1, "filed: now Ann can see it");
    assert_eq!(n[0]["record_id"], r.body["id"]);
    assert_eq!(n[0]["record_name"], "Venue");
    assert_eq!(n[0]["field_id"], f.notes_id);
}

#[tokio::test]
async fn a_draft_filed_as_a_comment_notifies_through_the_comment() {
    let (f, ann) = setup().await;
    let body = format!("Ask {} about it", mention("Ann", &ann));
    let id = draft(&f, &body).await;
    assert!(mentions_of(&f, &ann).is_empty());
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{id}/file"),
            json!({ "table_id": f.table_id, "fields": { &f.primary_id: "From the inbox" }, "note_as_comment": true }),
        )
        .await;
    r.assert_status(201);
    let n = mentions_of(&f, &ann);
    assert_eq!(n.len(), 1);
    assert_eq!(n[0]["record_id"], r.body["id"]);
    assert!(n[0]["comment_id"].as_str().unwrap().starts_with("com"));
    assert_eq!(n[0]["snippet"], "Ask @Ann about it");
}
