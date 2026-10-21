//! Record comments: CRUD, validation, permissions, events and @mention
//! notifications.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use common::Client;
use ob_core::api::events::BaseEvent;
use openbase::perm::Role;
use query_support::*;
use serde_json::{Value, json};

fn comments_url(record_id: &str) -> String {
    format!("/api/records/{record_id}/comments")
}

fn comment_url(id: &str) -> String {
    format!("/api/comments/{id}")
}

struct Setup {
    f: Fixture,
    record: String,
}

async fn setup() -> Setup {
    let f = Fixture::new().await;
    let rec = f
        .create(&f.table_id, json!({ &f.primary_id: "Ticket 7" }))
        .await;
    let record = id_str(&rec["id"]);
    Setup { f, record }
}

impl Setup {
    async fn post(&self, c: &Client, body: &str) -> common::Response {
        self.f
            .app
            .post(c, &comments_url(&self.record), json!({ "body": body }))
            .await
    }

    async fn post_ok(&self, c: &Client, body: &str) -> Value {
        let r = self.post(c, body).await;
        r.assert_status(201);
        r.body.clone()
    }

    async fn list(&self) -> Vec<Value> {
        let r = self
            .f
            .app
            .get(&self.f.owner, &comments_url(&self.record))
            .await;
        r.assert_status(200);
        r.body.as_array().unwrap().clone()
    }

    fn notifications_of(&self, user: &Client) -> Vec<(String, Value, bool)> {
        let uid = user.user_id.clone().unwrap();
        sql(&self.f.app, |tx| {
            let mut stmt = tx.prepare(
                "SELECT kind, payload, read_at IS NOT NULL FROM notifications
                 WHERE user_id = ?1 ORDER BY created_at, rowid",
            )?;
            let rows = stmt
                .query_map([&uid], |r| {
                    let p: String = r.get(1)?;
                    Ok((r.get(0)?, serde_json::from_str(&p).unwrap(), r.get(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }
}

fn mention(name: &str, user: &Client) -> String {
    format!("@[{name}]({})", user.user_id.as_ref().unwrap())
}

// -------------------------------------------------------------------- CRUD

#[tokio::test]
async fn post_list_edit_delete() {
    let s = setup().await;
    assert!(s.list().await.is_empty());
    let c1 = s.post_ok(&s.f.owner, "  first comment \n").await;
    assert!(id_str(&c1["id"]).starts_with("com"));
    assert_eq!(c1["record_id"], s.record);
    assert_eq!(c1["body"], "first comment", "bodies are trimmed");
    assert_eq!(c1["user_id"], s.f.owner.user_id.clone().unwrap());
    assert_eq!(c1["user_name"], "Owner");
    assert!(c1["created_at"].as_i64().unwrap() > 0);
    assert_eq!(c1["created_at"], c1["updated_at"]);
    let c2 = s.post_ok(&s.f.owner, "second").await;
    // Oldest first.
    let list = s.list().await;
    assert_eq!(
        list.iter()
            .map(|c| c["body"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["first comment", "second"]
    );
    assert_eq!(list[0], c1);

    // Edit.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let r =
        s.f.app
            .patch(
                &s.f.owner,
                &comment_url(c1["id"].as_str().unwrap()),
                json!({ "body": "  edited " }),
            )
            .await;
    r.assert_status(200);
    assert_eq!(r.body["body"], "edited");
    assert_eq!(r.body["id"], c1["id"]);
    assert_eq!(r.body["created_at"], c1["created_at"]);
    assert!(r.body["updated_at"].as_i64().unwrap() > c1["created_at"].as_i64().unwrap());
    assert_eq!(s.list().await[0]["body"], "edited");

    // Delete.
    let r =
        s.f.app
            .delete(&s.f.owner, &comment_url(c2["id"].as_str().unwrap()))
            .await;
    r.assert_status(204);
    assert!(r.bytes.is_empty());
    assert_eq!(s.list().await.len(), 1);
    s.f.app
        .delete(&s.f.owner, &comment_url(c2["id"].as_str().unwrap()))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn bodies_must_be_non_empty_and_bounded() {
    let s = setup().await;
    for bad in ["", "   ", "\n\t "] {
        let r = s.post(&s.f.owner, bad).await;
        r.assert_status(400);
        assert_eq!(r.body["error"]["code"], "bad_request");
    }
    let max = ob_core::limits::MAX_COMMENT_LEN;
    s.post(&s.f.owner, &"x".repeat(max))
        .await
        .assert_status(201);
    s.post(&s.f.owner, &"x".repeat(max + 1))
        .await
        .assert_status(400);
    // Multi-byte characters count as one each.
    s.post(&s.f.owner, &"é".repeat(max))
        .await
        .assert_status(201);
    // Editing obeys the same rules.
    let c = s.post_ok(&s.f.owner, "ok").await;
    let url = comment_url(c["id"].as_str().unwrap());
    s.f.app
        .patch(&s.f.owner, &url, json!({ "body": "  " }))
        .await
        .assert_status(400);
    s.f.app
        .patch(&s.f.owner, &url, json!({ "body": "x".repeat(max + 1) }))
        .await
        .assert_status(400);
    assert_eq!(
        s.list().await.iter().filter(|c| c["body"] == "ok").count(),
        1
    );
    // Malformed bodies use the error envelope.
    let r =
        s.f.app
            .post(&s.f.owner, &comments_url(&s.record), json!({ "text": "x" }))
            .await;
    r.assert_status(400);
    assert_eq!(r.body["error"]["code"], "bad_request");
}

#[tokio::test]
async fn unknown_and_trashed_records() {
    let s = setup().await;
    s.f.app
        .post(&s.f.owner, &comments_url("recNope"), json!({ "body": "x" }))
        .await
        .assert_status(404);
    s.f.app
        .get(&s.f.owner, &comments_url("recNope"))
        .await
        .assert_status(404);
    s.f.app
        .patch(&s.f.owner, &comment_url("comNope"), json!({ "body": "x" }))
        .await
        .assert_status(404);
    s.f.app
        .delete(&s.f.owner, &comment_url("comNope"))
        .await
        .assert_status(404);
    // A trashed record keeps its comments (readable) but takes no new ones.
    s.post_ok(&s.f.owner, "before").await;
    s.f.delete_records(&s.f.table_id, &[&s.record])
        .await
        .assert_status(204);
    assert_eq!(s.list().await.len(), 1);
    s.post(&s.f.owner, "after").await.assert_status(404);
    s.f.restore_records(&s.f.table_id, &[&s.record])
        .await
        .assert_status(200);
    s.post(&s.f.owner, "after").await.assert_status(201);
}

// ------------------------------------------------------------- permissions

#[tokio::test]
async fn role_matrix_for_reading_and_posting() {
    let s = setup().await;
    for role in ALL_ROLES {
        let u =
            s.f.member(&format!("{}-user@example.com", role.as_str()), role);
        s.f.app
            .get(&u, &comments_url(&s.record))
            .await
            .assert_status(200);
        let r = s.post(&u, &format!("hi from {}", role.as_str())).await;
        if role >= Role::Commenter {
            r.assert_status(201);
        } else {
            r.assert_status(403);
        }
    }
    assert_eq!(s.list().await.len(), 4);
    // Base-level sharing works the same way.
    let guest = s.f.base_guest("guest@example.com", Role::Commenter);
    s.post(&guest, "guest comment").await.assert_status(201);
}

#[tokio::test]
async fn strangers_anonymous_callers_and_read_only_tokens() {
    let s = setup().await;
    let c = s.post_ok(&s.f.owner, "hello").await;
    let url = comment_url(c["id"].as_str().unwrap());
    let stranger = s.f.app.user("stranger@example.com", "Stranger");
    s.f.app
        .get(&stranger, &comments_url(&s.record))
        .await
        .assert_status(404);
    s.post(&stranger, "x").await.assert_status(404);
    s.f.app
        .patch(&stranger, &url, json!({ "body": "x" }))
        .await
        .assert_status(404);
    s.f.app.delete(&stranger, &url).await.assert_status(404);
    s.f.app
        .get(&s.f.app.anon(), &comments_url(&s.record))
        .await
        .assert_status(401);
    s.post(&s.f.app.anon(), "x").await.assert_status(401);
    // Read-only token: reads, cannot post. A write token posts as the user.
    let ro = token_client(&s.f.app, &s.f.owner, false);
    s.f.app
        .get(&ro, &comments_url(&s.record))
        .await
        .assert_status(200);
    s.post(&ro, "x").await.assert_status(403);
    let rw = token_client(&s.f.app, &s.f.owner, true);
    let posted = s.post_ok(&rw, "from a token").await;
    assert_eq!(posted["user_id"], s.f.owner.user_id.clone().unwrap());
    assert_eq!(s.list().await.len(), 2);
}

#[tokio::test]
async fn only_the_author_edits() {
    let s = setup().await;
    let editor = s.f.member("editor-user@example.com", Role::Editor);
    let c = s.post_ok(&editor, "mine").await;
    let url = comment_url(c["id"].as_str().unwrap());
    // Not even the base owner may rewrite someone else's words.
    s.f.app
        .patch(&s.f.owner, &url, json!({ "body": "tampered" }))
        .await
        .assert_status(403);
    let other = s.f.member("commenter-user@example.com", Role::Commenter);
    s.f.app
        .patch(&other, &url, json!({ "body": "tampered" }))
        .await
        .assert_status(403);
    assert_eq!(s.list().await[0]["body"], "mine");
    s.f.app
        .patch(&editor, &url, json!({ "body": "still mine" }))
        .await
        .assert_status(200);
    // An author who is no longer allowed to comment cannot edit either.
    let uid = editor.user_id.clone().unwrap();
    let ws = s.f.ws.clone();
    sql(&s.f.app, |tx| {
        tx.execute(
            "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ?1 AND user_id = ?2",
            [&ws, &uid],
        )
    });
    s.f.app
        .patch(&editor, &url, json!({ "body": "again" }))
        .await
        .assert_status(403);
}

#[tokio::test]
async fn author_or_base_owner_deletes() {
    let s = setup().await;
    let editor = s.f.member("editor-user@example.com", Role::Editor);
    let creator = s.f.member("creator-user@example.com", Role::Creator);
    let c = s.post_ok(&editor, "to delete").await;
    let url = comment_url(c["id"].as_str().unwrap());
    // Other members, even creators, cannot delete it.
    s.f.app.delete(&creator, &url).await.assert_status(403);
    let viewer = s.f.member("viewer-user@example.com", Role::Viewer);
    s.f.app.delete(&viewer, &url).await.assert_status(403);
    assert_eq!(s.list().await.len(), 1);
    // The base owner can delete any comment.
    s.f.app.delete(&s.f.owner, &url).await.assert_status(204);
    assert!(s.list().await.is_empty());
    // The author can delete their own.
    let c = s.post_ok(&editor, "mine").await;
    s.f.app
        .delete(&editor, &comment_url(c["id"].as_str().unwrap()))
        .await
        .assert_status(204);
    // An author demoted to viewer can still remove their own old comment.
    let c = s.post_ok(&editor, "old").await;
    let uid = editor.user_id.clone().unwrap();
    let ws = s.f.ws.clone();
    sql(&s.f.app, |tx| {
        tx.execute(
            "UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = ?1 AND user_id = ?2",
            [&ws, &uid],
        )
    });
    s.f.app
        .delete(&editor, &comment_url(c["id"].as_str().unwrap()))
        .await
        .assert_status(204);
    // A base-level owner (without workspace role) can delete too.
    let c = s.post_ok(&s.f.owner, "by the owner").await;
    let base_owner = s.f.base_guest("baseowner@example.com", Role::Owner);
    s.f.app
        .delete(&base_owner, &comment_url(c["id"].as_str().unwrap()))
        .await
        .assert_status(204);
}

// ------------------------------------------------------------------ events

#[tokio::test]
async fn comment_changes_publish_comments_changed_without_invalidating_queries() {
    let s = setup().await;
    let mut rx = s.f.app.state.events.subscribe(&s.f.base_id);
    s.f.query(json!({})).await;
    let scans = s.f.app.state.query_cache.scans();
    let c = s.post_ok(&s.f.owner, "a").await;
    let id = c["id"].as_str().unwrap().to_string();
    s.f.app
        .patch(&s.f.owner, &comment_url(&id), json!({ "body": "b" }))
        .await
        .assert_status(200);
    s.f.app
        .delete(&s.f.owner, &comment_url(&id))
        .await
        .assert_status(204);
    for _ in 0..3 {
        let ev = rx.try_recv().unwrap();
        assert_eq!(ev.base_id, s.f.base_id);
        assert_eq!(ev.user_id, s.f.owner.user_id);
        assert_eq!(
            ev.event,
            BaseEvent::CommentsChanged {
                record_id: s.record.clone()
            }
        );
    }
    assert!(rx.try_recv().is_err());
    // Comments are not part of a view query, so the cache survives them.
    s.f.query(json!({})).await;
    assert_eq!(s.f.app.state.query_cache.scans(), scans);
}

#[tokio::test]
async fn failed_requests_publish_nothing() {
    let s = setup().await;
    let mut rx = s.f.app.state.events.subscribe(&s.f.base_id);
    s.post(&s.f.owner, "  ").await.assert_status(400);
    let viewer = s.f.member("viewer-user@example.com", Role::Viewer);
    s.post(&viewer, "x").await.assert_status(403);
    assert!(rx.try_recv().is_err());
}

// ---------------------------------------------------------------- mentions

#[tokio::test]
async fn mentions_notify_users_with_access_except_the_author() {
    let s = setup().await;
    let ann = s.f.member("ann@example.com", Role::Viewer);
    let bob = s.f.base_guest("bob@example.com", Role::Commenter);
    let outsider = s.f.app.user("outsider@example.com", "Outsider");
    let body = format!(
        "{} {} {} {} again {}",
        mention("Ann", &ann),
        mention("Bob", &bob),
        mention("Me", &s.f.owner),
        mention("Outsider", &outsider),
        mention("Ann", &ann),
    );
    let c = s.post_ok(&s.f.owner, &body).await;
    let comment_id = c["id"].as_str().unwrap().to_string();

    let n = s.notifications_of(&ann);
    assert_eq!(n.len(), 1, "one notification per mentioned user");
    assert_eq!(n[0].0, "mention");
    assert!(!n[0].2, "unread");
    let p = &n[0].1;
    assert_eq!(p["base_id"], s.f.base_id);
    assert_eq!(p["table_id"], s.f.table_id);
    assert_eq!(p["record_id"], s.record);
    assert_eq!(p["record_name"], "Ticket 7");
    assert_eq!(p["comment_id"], comment_id);
    assert_eq!(p["author_id"], s.f.owner.user_id.clone().unwrap());
    assert_eq!(p["author_name"], "Owner");
    assert_eq!(p["table_name"], "Table 1");
    assert_eq!(p["base_name"], "CRM");
    let snippet = p["snippet"].as_str().unwrap();
    assert!(
        snippet.starts_with("@Ann @Bob @Me @Outsider again @Ann"),
        "{snippet}"
    );
    assert!(!snippet.contains("usr"), "ids do not leak into the snippet");

    assert_eq!(s.notifications_of(&bob).len(), 1);
    assert!(s.notifications_of(&s.f.owner).is_empty(), "not the author");
    assert!(
        s.notifications_of(&outsider).is_empty(),
        "no access to the base"
    );
}

#[tokio::test]
async fn mention_notifications_carry_the_base_and_table_icons() {
    let s = setup().await;
    let ann = s.f.member("ann@example.com", Role::Viewer);
    s.f.app
        .patch(
            &s.f.owner,
            &format!("/api/bases/{}", s.f.base_id),
            json!({ "icon": "store" }),
        )
        .await
        .assert_status(200);
    s.f.app
        .patch(
            &s.f.owner,
            &format!("/api/tables/{}", s.f.table_id),
            json!({ "icon": "package" }),
        )
        .await
        .assert_status(200);
    s.post_ok(&s.f.owner, &mention("Ann", &ann)).await;
    let n = s.notifications_of(&ann);
    assert_eq!(n[0].1["base_icon"], "store");
    assert_eq!(n[0].1["table_icon"], "package");
}

#[tokio::test]
async fn mentions_of_unknown_or_inactive_users_and_plain_text_are_ignored() {
    let s = setup().await;
    let ann = s.f.member("ann@example.com", Role::Viewer);
    let gone = s.f.member("gone@example.com", Role::Viewer);
    let gone_id = gone.user_id.clone().unwrap();
    sql(&s.f.app, |tx| {
        tx.execute("UPDATE users SET is_active = 0 WHERE id = ?1", [&gone_id])
    });
    let body = format!(
        "{} {} @[Nobody](usrDoesNotExist1) @Ann [Ann](usr123) @[Rec](recAAAA)",
        mention("Gone", &gone),
        "plain text"
    );
    s.post_ok(&s.f.owner, &body).await;
    assert!(s.notifications_of(&ann).is_empty());
    assert!(s.notifications_of(&gone).is_empty());
}

#[tokio::test]
async fn editing_a_comment_only_notifies_newly_mentioned_users() {
    let s = setup().await;
    let ann = s.f.member("ann@example.com", Role::Viewer);
    let bob = s.f.member("bob@example.com", Role::Viewer);
    let c = s
        .post_ok(&s.f.owner, &format!("hi {}", mention("Ann", &ann)))
        .await;
    let url = comment_url(c["id"].as_str().unwrap());
    assert_eq!(s.notifications_of(&ann).len(), 1);
    s.f.app
        .patch(
            &s.f.owner,
            &url,
            json!({ "body": format!("hi {} and {}", mention("Ann", &ann), mention("Bob", &bob)) }),
        )
        .await
        .assert_status(200);
    assert_eq!(s.notifications_of(&ann).len(), 1, "Ann was already told");
    assert_eq!(s.notifications_of(&bob).len(), 1);
    // Re-saving the same text notifies nobody again.
    s.f.app
        .patch(
            &s.f.owner,
            &url,
            json!({ "body": format!("hi {} and {} !", mention("Ann", &ann), mention("Bob", &bob)) }),
        )
        .await
        .assert_status(200);
    assert_eq!(s.notifications_of(&ann).len(), 1);
    assert_eq!(s.notifications_of(&bob).len(), 1);
}

#[tokio::test]
async fn a_rejected_comment_creates_no_notifications() {
    let s = setup().await;
    let ann = s.f.member("ann@example.com", Role::Viewer);
    // Too long: rejected before anything is stored.
    let body = format!(
        "{} {}",
        mention("Ann", &ann),
        "x".repeat(ob_core::limits::MAX_COMMENT_LEN)
    );
    s.post(&s.f.owner, &body).await.assert_status(400);
    assert!(s.notifications_of(&ann).is_empty());
    assert!(s.list().await.is_empty());
}

#[tokio::test]
async fn long_comments_get_a_short_snippet() {
    let s = setup().await;
    let ann = s.f.member("ann@example.com", Role::Viewer);
    let long = format!("{} {}", mention("Ann", &ann), "lorem ipsum ".repeat(60));
    s.post_ok(&s.f.owner, &long).await;
    let n = s.notifications_of(&ann);
    let snippet = n[0].1["snippet"].as_str().unwrap();
    assert!(
        snippet.chars().count() <= 140,
        "{}",
        snippet.chars().count()
    );
    assert!(snippet.ends_with('…'));
}

#[tokio::test]
async fn commenters_can_mention_and_the_notification_names_them() {
    let s = setup().await;
    let commenter = s.f.member("commenter-user@example.com", Role::Commenter);
    let ann = s.f.member("ann@example.com", Role::Viewer);
    s.post_ok(&commenter, &format!("{} please look", mention("Ann", &ann)))
        .await;
    let n = s.notifications_of(&ann);
    assert_eq!(n[0].1["author_id"], commenter.user_id.clone().unwrap());
    assert_eq!(n[0].1["author_name"], "commenter-user@example.com");
}

#[tokio::test]
async fn comments_are_markdown_and_mentions_follow_its_rules() {
    let s = setup().await;
    let ann = s.f.member("ann@example.com", Role::Viewer);
    let bob = s.f.member("bob@example.com", Role::Viewer);
    // A mention in code is text; the snippet is the words without the markup.
    let body = format!(
        "## Review\n\n- **{}** please check\n- `{}` is how you write a mention",
        mention("Ann", &ann),
        mention("Bob", &bob)
    );
    let c = s.post_ok(&s.f.owner, &body).await;
    assert_eq!(c["body"], body.as_str(), "stored as written");
    let n = s.notifications_of(&ann);
    assert_eq!(n.len(), 1);
    assert_eq!(
        n[0].1["snippet"],
        format!(
            "Review @Ann please check {} is how you write a mention",
            mention("Bob", &bob)
        )
    );
    assert!(s.notifications_of(&bob).is_empty());
}
