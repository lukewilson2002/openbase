//! Record comments and @mentions.
//!
//! A comment is plain text up to `limits::MAX_COMMENT_LEN` characters.
//! Mentions are written `@[Name](usrXXXX)`; the name is only a label (the
//! client fills it in), the id is what counts. Posting (or editing a comment
//! to add) a mention creates a `mention` notification for each mentioned
//! user who may read the base, except the author. Everything here runs inside
//! the caller's write transaction, so a comment and its notifications are
//! stored together or not at all.
//!
//! Comments are deleted for real (their text may be sensitive); the schema's
//! `deleted_at` column is unused.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use og_core::api::records::Comment;
use og_core::limits;
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::perm;
use crate::store::links::NameCache;
use crate::store::{notifications, schema};

/// Characters of a comment shown in a notification.
const SNIPPET_LEN: usize = 140;

static MENTION: LazyLock<Regex> = LazyLock::new(|| {
    // The id alternation is deliberately strict: user ids are `usr` + base62.
    Regex::new(r"@\[([^\]\n]{0,255})\]\((usr[0-9A-Za-z]{1,40})\)").expect("valid mention regex")
});

/// A comment with the context needed for permission checks.
#[derive(Debug, Clone)]
pub struct CommentRow {
    pub comment: Comment,
    pub base_id: String,
    pub table_id: String,
}

/// Validate and trim a comment body: non-empty, at most
/// `limits::MAX_COMMENT_LEN` characters.
pub fn validate_body(raw: &str) -> AppResult<String> {
    let body = raw.trim();
    if body.is_empty() {
        return Err(AppError::bad_request("a comment cannot be empty"));
    }
    if body.chars().count() > limits::MAX_COMMENT_LEN {
        return Err(AppError::bad_request(format!(
            "a comment can have at most {} characters",
            limits::MAX_COMMENT_LEN
        )));
    }
    Ok(body.to_string())
}

/// The distinct user ids mentioned in a body, in order of first appearance.
pub fn mentioned_user_ids(body: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for cap in MENTION.captures_iter(body) {
        let id = cap[2].to_string();
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

/// The body as plain text for a notification: mentions become `@Name`,
/// whitespace is collapsed and the result is cut at [`SNIPPET_LEN`] characters.
pub fn snippet(body: &str) -> String {
    let plain = MENTION.replace_all(body, "@$1");
    let collapsed = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SNIPPET_LEN {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(SNIPPET_LEN - 1).collect();
    format!("{}…", cut.trim_end())
}

fn row_to_comment(r: &rusqlite::Row) -> rusqlite::Result<Comment> {
    Ok(Comment {
        id: r.get(0)?,
        record_id: r.get(1)?,
        user_id: r.get(2)?,
        user_name: r.get(3)?,
        body: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

const SELECT: &str =
    "SELECT c.id, c.record_id, c.user_id, u.name, c.body, c.created_at, c.updated_at
                      FROM comments c LEFT JOIN users u ON u.id = c.user_id";

/// A record's comments, oldest first.
pub fn list(conn: &Connection, record_id: &str) -> AppResult<Vec<Comment>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT} WHERE c.record_id = ?1 AND c.deleted_at IS NULL ORDER BY c.created_at, c.rowid"
    ))?;
    let rows = stmt
        .query_map([record_id], row_to_comment)?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// One comment with its base and table.
pub fn get(conn: &Connection, id: &str) -> AppResult<CommentRow> {
    conn.query_row(
        "SELECT c.id, c.record_id, c.user_id, u.name, c.body, c.created_at, c.updated_at,
                t.base_id, t.id
         FROM comments c
         JOIN records r ON r.id = c.record_id
         JOIN tables t ON t.id = r.table_id
         LEFT JOIN users u ON u.id = c.user_id
         WHERE c.id = ?1 AND c.deleted_at IS NULL AND t.deleted_at IS NULL",
        [id],
        |r| {
            Ok(CommentRow {
                comment: row_to_comment(r)?,
                base_id: r.get(7)?,
                table_id: r.get(8)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("comment"))
}

/// Add a comment by `author` to a live record and notify the mentioned.
pub fn create(
    tx: &Connection,
    record_id: &str,
    author: &str,
    body: &str,
    now: i64,
) -> AppResult<Comment> {
    let body = validate_body(body)?;
    let id = new_id(og_core::ids::COMMENT);
    tx.execute(
        "INSERT INTO comments (id, record_id, user_id, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, record_id, author, body, now],
    )?;
    notify_mentions(tx, record_id, &id, author, &body, &[])?;
    Ok(get(tx, &id)?.comment)
}

/// Replace a comment's body (the author's edit) and notify users mentioned
/// for the first time.
pub fn update(tx: &Connection, id: &str, body: &str, now: i64) -> AppResult<Comment> {
    let body = validate_body(body)?;
    let current = get(tx, id)?;
    tx.execute(
        "UPDATE comments SET body = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, body, now],
    )?;
    if let Some(author) = &current.comment.user_id {
        let already = mentioned_user_ids(&current.comment.body);
        notify_mentions(tx, &current.comment.record_id, id, author, &body, &already)?;
    }
    Ok(get(tx, id)?.comment)
}

pub fn delete(tx: &Connection, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM comments WHERE id = ?1", [id])?;
    Ok(())
}

/// Create a `mention` notification for every user mentioned in `body` (except
/// `skip` and the author) who is an active user with access to the record's
/// base.
fn notify_mentions(
    conn: &Connection,
    record_id: &str,
    comment_id: &str,
    author_id: &str,
    body: &str,
    skip: &[String],
) -> AppResult<()> {
    let mentioned: Vec<String> = mentioned_user_ids(body)
        .into_iter()
        .filter(|u| u != author_id && !skip.contains(u))
        .collect();
    if mentioned.is_empty() {
        return Ok(());
    }
    let base_id = perm::base_of_record(conn, record_id)?;
    let table_id: String = conn.query_row(
        "SELECT table_id FROM records WHERE id = ?1",
        [record_id],
        |r| r.get(0),
    )?;
    let table = schema::live_table(conn, &table_id)?;
    let base_name: String = conn
        .query_row("SELECT name FROM bases WHERE id = ?1", [&base_id], |r| {
            r.get(0)
        })
        .unwrap_or_default();
    let names = NameCache::new(conn, chrono_tz::Tz::UTC);
    let record_name = names.record_text(record_id).unwrap_or_default();
    let author_name: String = conn
        .query_row("SELECT name FROM users WHERE id = ?1", [author_id], |r| {
            r.get(0)
        })
        .unwrap_or_default();
    let text = snippet(body);
    for user_id in mentioned {
        let active: bool = conn
            .query_row(
                "SELECT is_active FROM users WHERE id = ?1",
                [&user_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if !active || perm::base_role(conn, &user_id, &base_id)?.is_none() {
            continue;
        }
        notifications::create(
            conn,
            &user_id,
            "mention",
            &json!({
                "base_id": base_id,
                "base_name": base_name,
                "table_id": table.id,
                "table_name": table.name,
                "record_id": record_id,
                "record_name": record_name,
                "comment_id": comment_id,
                "snippet": text,
                "author_id": author_id,
                "author_name": author_name,
            }),
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_are_trimmed_and_bounded() {
        assert_eq!(validate_body("  hi \n").unwrap(), "hi");
        assert!(validate_body("   \n\t").is_err());
        assert!(validate_body(&"x".repeat(limits::MAX_COMMENT_LEN)).is_ok());
        assert!(validate_body(&"x".repeat(limits::MAX_COMMENT_LEN + 1)).is_err());
        // Characters, not bytes.
        assert!(validate_body(&"é".repeat(limits::MAX_COMMENT_LEN)).is_ok());
    }

    #[test]
    fn mentions_are_extracted_once_each() {
        let body = "hey @[Ann](usrAAA111) and @[Bob B](usrBBB222), again @[Ann](usrAAA111)";
        assert_eq!(mentioned_user_ids(body), vec!["usrAAA111", "usrBBB222"]);
        // Not a mention: wrong id prefix, missing parts, plain @name.
        assert!(mentioned_user_ids("@[X](recAAA) @Ann @[Y]() @[Z](usr)").is_empty());
    }

    #[test]
    fn snippets_are_plain_and_short() {
        assert_eq!(
            snippet("  ping @[Ann](usrAAA111)\n  please\treview "),
            "ping @Ann please review"
        );
        let long = format!("{} end", "word ".repeat(100));
        let s = snippet(&long);
        assert!(s.chars().count() <= SNIPPET_LEN);
        assert!(s.ends_with('…'));
    }
}
