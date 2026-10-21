//! @mentions in Markdown: record comments and rich text cells.
//!
//! A mention is written `@[Name](usrXXXX)`: an `@` right before a Markdown
//! link whose address is a user id. The name is only a label (the client fills
//! it in); the id is what counts. Mentions are found with a CommonMark parser,
//! so the same characters inside code (`` `@[A](usr1)` ``) or escaped as text
//! (`@\[A\](usr1)`, which the editor writes for typed brackets) are not
//! mentions.
//!
//! A mention notifies once the text it is in becomes visible to the people it
//! names: when a comment is posted or edited and when a rich text cell is
//! saved on a record (which is also when an Inbox draft is filed; a draft
//! itself notifies no one). Only mentions the text did not have before count,
//! never the author, and only active users who may read the record's base get
//! a `mention` notification. Everything runs inside the caller's write
//! transaction, so the text and its notifications are stored together or not
//! at all.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension};
use serde_json::json;

use crate::error::AppResult;
use crate::perm;
use crate::store::links::NameCache;
use crate::store::{notifications, schema, search};

/// Characters of a comment shown in its notification.
const SNIPPET_LEN: usize = 140;

/// User ids are `usr` + base62; nothing else is a mention.
static USER_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^usr[0-9A-Za-z]{1,40}$").expect("valid user id regex"));

/// One person mentioned in a text, with the label of their first mention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mention {
    pub user_id: String,
    pub label: String,
}

/// Where the mentioning text is, for the notification.
#[derive(Debug, Clone, Copy)]
pub enum Place<'a> {
    Comment { id: &'a str },
    Field { id: &'a str, name: &'a str },
}

fn parser(md: &str) -> Parser<'_> {
    Parser::new_ext(
        md,
        Options::ENABLE_TABLES
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_GFM,
    )
}

/// Everyone mentioned in `md`, once each, in order of first appearance.
pub fn mentions(md: &str) -> Vec<Mention> {
    if !md.contains("](usr") {
        return Vec::new();
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    // The mention being read: its id and the text of its label so far.
    let mut open: Option<(String, String)> = None;
    for (event, range) in parser(md).into_offset_iter() {
        match event {
            Event::Start(Tag::Link { dest_url, .. })
                if md[range.start..].starts_with('[')
                    && md[..range.start].ends_with('@')
                    && USER_ID.is_match(&dest_url) =>
            {
                open = Some((dest_url.to_string(), String::new()));
            }
            Event::Text(t) | Event::Code(t) => {
                if let Some((_, label)) = open.as_mut() {
                    label.push_str(&t);
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some((user_id, label)) = open.take()
                    && seen.insert(user_id.clone())
                {
                    out.push(Mention { user_id, label });
                }
            }
            _ => {}
        }
    }
    out
}

/// The distinct user ids mentioned in `md`, in order of first appearance.
pub fn mentioned_user_ids(md: &str) -> Vec<String> {
    mentions(md).into_iter().map(|m| m.user_id).collect()
}

/// The people mentioned in `after` who were not mentioned in `before`.
pub fn added(before: Option<&str>, after: &str) -> Vec<Mention> {
    let had: BTreeSet<String> = before
        .map(mentioned_user_ids)
        .unwrap_or_default()
        .into_iter()
        .collect();
    mentions(after)
        .into_iter()
        .filter(|m| !had.contains(&m.user_id))
        .collect()
}

/// The words of `md` without its markup, on one line: a mention reads
/// `@Name`, a link its text, an embedded file its name.
pub fn plain_text(md: &str) -> String {
    let mut out = String::new();
    for event in parser(md) {
        match event {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak | Event::Rule => out.push(' '),
            Event::End(
                TagEnd::Paragraph
                | TagEnd::Heading(_)
                | TagEnd::Item
                | TagEnd::CodeBlock
                | TagEnd::TableCell
                | TagEnd::BlockQuote(_),
            ) => out.push(' '),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `md` as plain text cut at [`SNIPPET_LEN`] characters, for a notification.
pub fn snippet(md: &str) -> String {
    let plain = plain_text(md);
    if plain.chars().count() <= SNIPPET_LEN {
        return plain;
    }
    let cut: String = plain.chars().take(SNIPPET_LEN - 1).collect();
    format!("{}…", cut.trim_end())
}

/// Create a `mention` notification for each of `mentioned` in the text `md`
/// of a record, except the author, for active users who may read the
/// record's base. `md` is the whole text: a comment's notification shows its
/// start, a cell's the words around the mention.
pub fn notify(
    conn: &Connection,
    record_id: &str,
    author_id: &str,
    md: &str,
    mentioned: &[Mention],
    place: Place,
) -> AppResult<()> {
    let mentioned: Vec<&Mention> = mentioned
        .iter()
        .filter(|m| m.user_id != author_id)
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
    let (base_name, base_icon): (String, Option<String>) = conn
        .query_row(
            "SELECT name, icon FROM bases WHERE id = ?1",
            [&base_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or_default();
    let names = NameCache::new(conn, chrono_tz::Tz::UTC);
    let record_name = names.record_text(record_id).unwrap_or_default();
    let author_name: String = conn
        .query_row("SELECT name FROM users WHERE id = ?1", [author_id], |r| {
            r.get(0)
        })
        .unwrap_or_default();
    let plain = plain_text(md);
    for m in mentioned {
        let active: bool = conn
            .query_row(
                "SELECT is_active FROM users WHERE id = ?1",
                [&m.user_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(false);
        if !active || perm::base_role(conn, &m.user_id, &base_id)?.is_none() {
            continue;
        }
        let mut payload = json!({
            "base_id": base_id,
            "base_name": base_name,
            "base_icon": base_icon,
            "table_id": table.id,
            "table_name": table.name,
            "table_icon": table.icon,
            "record_id": record_id,
            "record_name": record_name,
            "author_id": author_id,
            "author_name": author_name,
        });
        match place {
            Place::Comment { id } => {
                payload["comment_id"] = json!(id);
                payload["snippet"] = json!(snippet(md));
            }
            Place::Field { id, name } => {
                payload["field_id"] = json!(id);
                payload["field_name"] = json!(name);
                payload["snippet"] = json!(search::snippet(
                    &plain,
                    &format!("@{}", m.label).to_lowercase()
                ));
            }
        }
        notifications::create(conn, &m.user_id, "mention", &payload)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(md: &str) -> Vec<String> {
        mentioned_user_ids(md)
    }

    #[test]
    fn mentions_are_found_once_each() {
        let body = "hey @[Ann](usrAAA111) and @[Bob B](usrBBB222), again @[Ann](usrAAA111)";
        assert_eq!(ids(body), vec!["usrAAA111", "usrBBB222"]);
        assert_eq!(
            mentions("**@[Ann *A*](usrAAA111)**")[0],
            Mention {
                user_id: "usrAAA111".into(),
                label: "Ann A".into()
            }
        );
        // In lists, quotes, tables and headings too.
        assert_eq!(
            ids("- @[A](usr1)\n> @[B](usr2)\n\n| @[C](usr3) |\n|---|\n\n# @[D](usr4)"),
            vec!["usr1", "usr2", "usr3", "usr4"]
        );
    }

    #[test]
    fn look_alikes_are_not_mentions() {
        // Wrong id prefix, missing parts, no @, plain @name.
        assert!(ids("@[X](recAAA) @Ann @[Y]() @[Z](usr) [W](usr1)").is_empty());
        // Code, escaped brackets (typed text), an image.
        assert!(
            ids("`@[A](usr1)`\n\n```\n@[B](usr2)\n```\n\n@\\[C\\](usr3) @![D](usr4)").is_empty()
        );
    }

    #[test]
    fn added_mentions_are_the_new_ones() {
        let before = "@[A](usr1) hi";
        let after = "@[A](usr1) and @[B](usr2)";
        assert_eq!(
            added(Some(before), after)
                .iter()
                .map(|m| m.user_id.as_str())
                .collect::<Vec<_>>(),
            vec!["usr2"]
        );
        assert_eq!(added(None, after).len(), 2);
        assert!(added(Some(after), before).is_empty());
    }

    #[test]
    fn plain_text_drops_the_markup() {
        assert_eq!(
            plain_text(
                "# Plan\n\nping @[Ann](usrAAA111)\nplease *review* [this](https://x.test)\n\n- [ ] one\n- two\n\n> [!NOTE]\n> `code`"
            ),
            "Plan ping @Ann please review this one two code"
        );
        assert_eq!(
            plain_text("![photo.png](/api/attachments/attX/photo.png)"),
            "photo.png"
        );
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
