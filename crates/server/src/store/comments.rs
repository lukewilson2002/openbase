//! Record comments.
//!
//! A comment is Markdown (the rich text of rich text fields) up to
//! `limits::MAX_COMMENT_LEN` characters, with mentions written
//! `@[Name](usrXXXX)` (see [`mentions`]). Posting (or editing a comment to
//! add) a mention notifies the mentioned users who may read the base, except
//! the author. Everything here runs inside the caller's write transaction, so
//! a comment and its notifications are stored together or not at all.
//!
//! Comments were plain text before schema version 13; that migration turned
//! the stored bodies into Markdown that reads the same ([`plain_to_markdown`]).
//!
//! Comments are deleted for real (their text may be sensitive); the schema's
//! `deleted_at` column is unused.

use std::sync::LazyLock;

use ob_core::api::records::Comment;
use ob_core::limits;
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, params};

use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::perm;
use crate::store::attachments;
use crate::store::mentions::{self, Place};

/// A mention as plain-text comments wrote it (the Markdown form is the same).
static PLAIN_MENTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"@\[[^\]\n]{0,255}\]\(usr[0-9A-Za-z]{1,40}\)").expect("valid mention regex")
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

/// Files embedded or linked in a comment (`/api/attachments/<id>/...`) must be files of the
/// record's project, as in rich text cells; `held` is the body being replaced.
fn require_project_files(
    conn: &Connection,
    base_id: &str,
    body: &str,
    held: Option<&str>,
) -> AppResult<()> {
    match attachments::first_foreign_ref(conn, base_id, body, held)? {
        Some(bad) => Err(AppError::bad_request(
            crate::engine::write::not_a_project_file(&bad),
        )),
        None => Ok(()),
    }
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
    require_project_files(tx, &perm::base_of_record(tx, record_id)?, &body, None)?;
    let id = new_id(ob_core::ids::COMMENT);
    tx.execute(
        "INSERT INTO comments (id, record_id, user_id, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, record_id, author, body, now],
    )?;
    let mentioned = mentions::mentions(&body);
    mentions::notify(
        tx,
        record_id,
        author,
        &body,
        &mentioned,
        Place::Comment { id: &id },
    )?;
    Ok(get(tx, &id)?.comment)
}

/// Replace a comment's body (the author's edit) and notify users mentioned
/// for the first time.
pub fn update(tx: &Connection, id: &str, body: &str, now: i64) -> AppResult<Comment> {
    let body = validate_body(body)?;
    let current = get(tx, id)?;
    require_project_files(tx, &current.base_id, &body, Some(&current.comment.body))?;
    tx.execute(
        "UPDATE comments SET body = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, body, now],
    )?;
    if let Some(author) = &current.comment.user_id {
        let added = mentions::added(Some(&current.comment.body), &body);
        mentions::notify(
            tx,
            &current.comment.record_id,
            author,
            &body,
            &added,
            Place::Comment { id },
        )?;
    }
    Ok(get(tx, id)?.comment)
}

pub fn delete(tx: &Connection, id: &str) -> AppResult<()> {
    tx.execute("DELETE FROM comments WHERE id = ?1", [id])?;
    Ok(())
}

/// Rewrite every stored comment as Markdown that shows the text it had as
/// plain text (schema version 13).
pub fn plain_bodies_to_markdown(conn: &Connection) -> rusqlite::Result<()> {
    let bodies: Vec<(String, String)> = conn
        .prepare("SELECT id, body FROM comments")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut update = conn.prepare("UPDATE comments SET body = ?2 WHERE id = ?1")?;
    for (id, body) in bodies {
        let md = plain_to_markdown(&body);
        if md != body {
            update.execute(params![id, md])?;
        }
    }
    Ok(())
}

/// A plain-text comment as Markdown that reads the same: characters Markdown
/// would take as formatting are escaped where they could be (as the editor
/// escapes typed text), a line that would start a heading, list, quote or
/// rule is escaped at its start, and indentation, which would make a code
/// block, is dropped. Mentions stay as they are.
pub fn plain_to_markdown(body: &str) -> String {
    body.split('\n')
        .map(|line| escape_line_start(&escape_line(line.trim_start())))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Escape the characters of one line of plain text, outside its mentions.
fn escape_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    // Char index of each byte offset where a mention starts or ends.
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for m in PLAIN_MENTION.find_iter(line) {
        spans.push((
            line[..m.start()].chars().count(),
            line[..m.end()].chars().count(),
        ));
    }
    let is_space = |c: Option<&char>| c.is_some_and(|c| c.is_whitespace());
    let is_word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
    let mut out = String::with_capacity(line.len() + 8);
    let mut i = 0;
    while i < chars.len() {
        if let Some(&(_, end)) = spans.iter().find(|(s, _)| *s == i) {
            out.extend(&chars[i..end]);
            i = end;
            continue;
        }
        let c = chars[i];
        let prev = i.checked_sub(1).and_then(|p| chars.get(p));
        let next = chars.get(i + 1);
        match c {
            '\\' if next.is_none_or(|n| n.is_ascii_punctuation()) => out.push_str("\\\\"),
            '`' | '[' | ']' | '~' | '|' | '<' => {
                out.push('\\');
                out.push(c);
            }
            '*' if !(is_space(prev) && is_space(next)) => out.push_str("\\*"),
            '_' if !((is_word(prev) && is_word(next)) || (is_space(prev) && is_space(next))) => {
                out.push_str("\\_")
            }
            '&' if ENTITY.is_match(&line[line.char_indices().nth(i).map_or(0, |(b, _)| b)..]) => {
                out.push_str("\\&")
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

static ENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^&(?:#\d+|#x[\da-f]+|[a-z][\da-z]*);").expect("valid entity regex")
});

/// Escape the start of an (escaped, unindented) line that would otherwise
/// begin a heading, a list item, a quote or a rule.
fn escape_line_start(line: &str) -> String {
    let ends_or_space = |rest: &str| rest.is_empty() || rest.starts_with(char::is_whitespace);
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) && ends_or_space(&line[hashes..]) {
        return format!("\\{line}");
    }
    if (line.starts_with('-') || line.starts_with('+') || line.starts_with('>'))
        && (line.starts_with('>') || ends_or_space(&line[1..]))
    {
        return format!("\\{line}");
    }
    if (line.starts_with('-') || line.starts_with('='))
        && line
            .chars()
            .all(|c| c == '-' || c == '=' || c.is_whitespace())
    {
        return format!("\\{line}");
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if (1..=9).contains(&digits)
        && line[digits..].starts_with(['.', ')'])
        && ends_or_space(&line[digits + 1..])
    {
        return format!("{}\\{}", &line[..digits], &line[digits..]);
    }
    line.to_string()
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
    fn plain_comments_become_markdown_that_reads_the_same() {
        let cases = [
            (
                "ping @[Ann](usrAAA111) please",
                "ping @[Ann](usrAAA111) please",
            ),
            ("snake_case and 2 * 3", "snake_case and 2 * 3"),
            (
                "*bold* _it_ `code` [x](y) ~s~ a|b <b>",
                "\\*bold\\* \\_it\\_ \\`code\\` \\[x\\](y) \\~s\\~ a\\|b \\<b>",
            ),
            (
                "# not a heading\n- not a list\n+ nor\n> not a quote\n1. not numbered\n2) either\n---\n===",
                "\\# not a heading\n\\- not a list\n\\+ nor\n\\> not a quote\n1\\. not numbered\n2\\) either\n\\---\n\\===",
            ),
            ("    indented\n\ta tab", "indented\na tab"),
            ("a \\ b \\* end\\", "a \\ b \\\\\\* end\\\\"),
            ("&amp; stays &; R&D", "\\&amp; stays &; R&D"),
            ("#hashtag 3.14 -1", "#hashtag 3.14 -1"),
        ];
        for (plain, md) in cases {
            assert_eq!(plain_to_markdown(plain), md, "{plain:?}");
            // Rendered, the Markdown shows the plain text again (spacing aside).
            if !plain.contains("@[") {
                let words = plain.split_whitespace().collect::<Vec<_>>().join(" ");
                assert_eq!(mentions::plain_text(md), words, "{plain:?}");
            }
        }
    }
}
