//! The inbox: a user's private quick-capture drafts (`inbox_items`).
//!
//! A draft is Markdown plus uploaded files and belongs to one user and to no
//! workspace. Every function takes the owner's id and answers "not found" for
//! anyone else's draft, so existence never leaks. Files are uploaded without a
//! base (`attachments.base_id` NULL, `created_by` = the owner) and only move
//! into a base when the draft is filed into one of its tables; the draft keeps
//! the same references an attachment cell stores. The text may also embed or
//! link the user's unattached uploads by address (`/api/attachments/<id>/...`,
//! see [`attachments::referenced_ids`]); filing moves those into the base too.

use std::collections::HashSet;

use ob_core::api::inbox::InboxItem;
use ob_core::field::{AttachmentRef, Field, FieldKind};
use ob_core::ids;
use ob_core::limits;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::attachments;
use crate::v1::input::FieldIndex;

fn not_found() -> AppError {
    AppError::not_found("inbox item")
}

fn row_to_item(
    id: String,
    title: String,
    body: String,
    attachments: String,
    created_at: i64,
    updated_at: i64,
) -> InboxItem {
    InboxItem {
        id,
        title,
        body,
        // Written only by this module; a damaged value reads as "no files".
        attachments: serde_json::from_str(&attachments).unwrap_or_default(),
        created_at,
        updated_at,
    }
}

/// The user's drafts, most recently changed first.
pub fn list(conn: &Connection, user_id: &str) -> AppResult<Vec<InboxItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, body, attachments, created_at, updated_at FROM inbox_items
         WHERE user_id = ?1 ORDER BY updated_at DESC, rowid DESC",
    )?;
    let items = stmt
        .query_map([user_id], |r| {
            Ok(row_to_item(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

/// One of the user's drafts; 404 when it is missing or someone else's.
pub fn get(conn: &Connection, user_id: &str, id: &str) -> AppResult<InboxItem> {
    conn.query_row(
        "SELECT id, title, body, attachments, created_at, updated_at FROM inbox_items
         WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
        |r| {
            Ok(row_to_item(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        },
    )
    .optional()?
    .ok_or_else(not_found)
}

/// A title is one line: line breaks become spaces, and the ends are trimmed.
fn clean_title(title: &str) -> AppResult<String> {
    let title = title
        .split(['\r', '\n'])
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let title = title.trim().to_string();
    if title.chars().count() > limits::MAX_INBOX_TITLE_LEN {
        return Err(AppError::bad_request(format!(
            "the title is too long (maximum {} characters)",
            limits::MAX_INBOX_TITLE_LEN
        )));
    }
    Ok(title)
}

fn check_body(body: &str) -> AppResult<()> {
    if body.chars().count() > limits::MAX_TEXT_CELL_LEN {
        return Err(AppError::bad_request(format!(
            "the text is too long (maximum {} characters)",
            limits::MAX_TEXT_CELL_LEN
        )));
    }
    Ok(())
}

/// The ids of the files in the user's drafts other than `except`, in their file lists and
/// embedded or linked in their text (a file may be in one draft only: filing a draft hands
/// its files to a base, which would leave a second draft pointing at a file it can no
/// longer reach).
fn files_of_other_drafts(
    conn: &Connection,
    user_id: &str,
    except: Option<&str>,
) -> AppResult<HashSet<String>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT attachments, body FROM inbox_items
         WHERE user_id = ?2 AND id != ?3
           AND (attachments != '[]' OR {})",
        attachments::may_reference_sql("body")
    ))?;
    let rows = stmt
        .query_map(
            params![attachments::REF_PREFIX, user_id, except.unwrap_or_default()],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = HashSet::new();
    for (json, body) in rows {
        out.extend(
            serde_json::from_str::<Vec<AttachmentRef>>(&json)
                .unwrap_or_default()
                .into_iter()
                .map(|a| a.id),
        );
        out.extend(attachments::referenced_ids(&body));
    }
    Ok(out)
}

fn already_in_another_draft(id: &str) -> AppError {
    AppError::bad_request(format!(
        "attachment {id} is already in another draft; a file can be in one draft at a time \
         (remove it there first, or upload it again)"
    ))
}

/// A draft's text may only embed or link the user's own unattached uploads (the files
/// `POST /api/inbox/attachments` gives), none of which is in another draft. References the
/// draft's current text (`held`) already has are left alone, so a file filed away
/// elsewhere cannot make an old draft impossible to edit.
fn check_body_files(
    conn: &Connection,
    user_id: &str,
    draft: Option<&str>,
    body: &str,
    held: Option<&str>,
) -> AppResult<()> {
    let held: HashSet<String> = held
        .map(attachments::referenced_ids)
        .unwrap_or_default()
        .into_iter()
        .collect();
    let ids: Vec<String> = attachments::referenced_ids(body)
        .into_iter()
        .filter(|id| !held.contains(id))
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    let taken = files_of_other_drafts(conn, user_id, draft)?;
    for id in ids {
        let mine = attachments::get(conn, &id)?
            .is_some_and(|r| r.base_id.is_none() && r.created_by.as_deref() == Some(user_id));
        if !mine {
            return Err(AppError::bad_request(format!(
                "attachment {id} in the text is not one of your inbox uploads; upload it with \
                 POST /api/inbox/attachments first"
            )));
        }
        if taken.contains(&id) {
            return Err(already_in_another_draft(&id));
        }
    }
    Ok(())
}

/// The references to store for the files `given`: each must be an upload of
/// this user that is not in any base yet (`POST /api/inbox/attachments`) and not in
/// another of their drafts (`draft`: the one being changed, if any). The reference is
/// rebuilt from the `attachments` row, never taken from the client.
fn resolve_attachments(
    conn: &Connection,
    user_id: &str,
    draft: Option<&str>,
    given: &[AttachmentRef],
) -> AppResult<Vec<AttachmentRef>> {
    if given.len() > limits::MAX_INBOX_ATTACHMENTS {
        return Err(AppError::bad_request(format!(
            "too many files (maximum {} per draft)",
            limits::MAX_INBOX_ATTACHMENTS
        )));
    }
    let taken = if given.is_empty() {
        HashSet::new()
    } else {
        files_of_other_drafts(conn, user_id, draft)?
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for a in given {
        if !seen.insert(a.id.as_str()) {
            continue;
        }
        let row = attachments::get(conn, &a.id)?
            .filter(|r| r.base_id.is_none() && r.created_by.as_deref() == Some(user_id))
            .ok_or_else(|| {
                AppError::bad_request(format!(
                    "attachment {} was not found; upload it with POST /api/inbox/attachments first",
                    a.id
                ))
            })?;
        if taken.contains(&row.id) {
            return Err(AppError::bad_request(format!(
                "attachment {} is already in another draft; a file can be in one draft at a \
                 time (remove it there first, or upload it again)",
                row.id
            )));
        }
        out.push(row.to_ref());
    }
    Ok(out)
}

fn attachments_json(refs: &[AttachmentRef]) -> AppResult<String> {
    Ok(serde_json::to_string(refs)?)
}

/// Add a draft for `user_id`.
pub fn create(
    conn: &Connection,
    user_id: &str,
    title: &str,
    body: &str,
    files: &[AttachmentRef],
) -> AppResult<InboxItem> {
    let title = clean_title(title)?;
    check_body(body)?;
    check_body_files(conn, user_id, None, body, None)?;
    let count: i64 = conn.query_row(
        "SELECT count(*) FROM inbox_items WHERE user_id = ?1",
        [user_id],
        |r| r.get(0),
    )?;
    if count as usize >= limits::MAX_INBOX_ITEMS {
        return Err(AppError::bad_request(format!(
            "the inbox is full (maximum {} drafts); file or delete some first",
            limits::MAX_INBOX_ITEMS
        )));
    }
    let refs = resolve_attachments(conn, user_id, None, files)?;
    let id = new_id(ids::INBOX);
    let now = now_ms();
    conn.execute(
        "INSERT INTO inbox_items (id, user_id, title, body, attachments, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, user_id, title, body, attachments_json(&refs)?, now],
    )?;
    get(conn, user_id, &id)
}

/// Change a draft: only what is given. `files` replaces the whole list.
pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    title: Option<&str>,
    body: Option<&str>,
    files: Option<&[AttachmentRef]>,
) -> AppResult<InboxItem> {
    let current = get(conn, user_id, id)?;
    let title = match title {
        Some(t) => clean_title(t)?,
        None => current.title,
    };
    let body = match body {
        Some(b) => {
            check_body(b)?;
            check_body_files(conn, user_id, Some(id), b, Some(&current.body))?;
            b.to_string()
        }
        None => current.body,
    };
    let refs = match files {
        Some(f) => resolve_attachments(conn, user_id, Some(id), f)?,
        None => current.attachments,
    };
    // An edited draft goes to the top of the list (newest first) even when the clock has not moved
    // on since another draft was written: it is then a millisecond past the newest of the others.
    conn.execute(
        "UPDATE inbox_items SET title = ?1, body = ?2, attachments = ?3,
           updated_at = MAX(?4, (SELECT COALESCE(MAX(o.updated_at) + 1, 0) FROM inbox_items o
                                 WHERE o.user_id = ?6 AND o.id <> ?5))
         WHERE id = ?5 AND user_id = ?6",
        params![title, body, attachments_json(&refs)?, now_ms(), id, user_id],
    )?;
    get(conn, user_id, id)
}

/// Delete a draft (hard delete: drafts are not worth a trash). Its files stay
/// until the attachment garbage collection finds nothing referencing them.
pub fn delete(conn: &Connection, user_id: &str, id: &str) -> AppResult<()> {
    let n = conn.execute(
        "DELETE FROM inbox_items WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
    )?;
    if n == 0 {
        return Err(not_found());
    }
    Ok(())
}

/// The attachment ids that `given` (the `fields` of a record to create, keyed by field name
/// or id) puts into attachment fields of `fields`. Text that merely contains an id, or a
/// non-attachment field, does not count.
fn attachment_ids_in(fields: &[Field], given: &Map<String, Value>) -> HashSet<String> {
    let index = FieldIndex::new(fields);
    given
        .iter()
        .filter(|(key, _)| {
            index
                .resolve(key)
                .is_some_and(|f| matches!(f.kind, FieldKind::Attachment(_)))
        })
        .filter_map(|(_, v)| v.as_array())
        .flatten()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// The files `given` references in rich text fields of `fields`: any `/api/attachments/<id>/`
/// address inside a rich text value.
fn text_refs_in(fields: &[Field], given: &Map<String, Value>) -> Vec<String> {
    let index = FieldIndex::new(fields);
    given
        .iter()
        .filter(|(key, _)| {
            index
                .resolve(key)
                .is_some_and(|f| matches!(f.kind, FieldKind::RichText(_)))
        })
        .filter_map(|(_, v)| v.as_str())
        .flat_map(attachments::referenced_ids)
        .collect()
}

/// Hand the draft's files that the attachment fields of `given` use over to `base_id`, so a
/// record of that base can hold them, and take them out of the user's other drafts (a file
/// lives in one draft only, but a stale reference must never outlive the move). Also moves
/// every unattached upload of the user that rich text values in `given`, or the `note`
/// (the draft text about to become a comment), embed or link by address; one that another
/// draft's text embeds is refused (`400`). Returns how many files moved.
pub fn move_files_to_base(
    conn: &Connection,
    user_id: &str,
    item: &InboxItem,
    base_id: &str,
    fields: &[Field],
    given: &Map<String, Value>,
    note: Option<&str>,
) -> AppResult<usize> {
    let wanted = attachment_ids_in(fields, given);
    let mut ids: Vec<&str> = item
        .attachments
        .iter()
        .filter(|a| wanted.contains(&a.id))
        .map(|a| a.id.as_str())
        .collect();
    let referenced: Vec<String> = text_refs_in(fields, given)
        .into_iter()
        .chain(note.map(attachments::referenced_ids).unwrap_or_default())
        .collect();
    if !referenced.is_empty() {
        // A file another draft's text names stays where it is: moving it would break that draft.
        let taken = files_of_other_drafts(conn, user_id, Some(&item.id))?;
        if let Some(id) = referenced.iter().find(|id| taken.contains(*id)) {
            return Err(already_in_another_draft(id));
        }
    }
    ids.extend(referenced.iter().map(String::as_str));
    let mut moved = HashSet::new();
    for id in ids {
        let n = conn.execute(
            "UPDATE attachments SET base_id = ?1
             WHERE id = ?2 AND base_id IS NULL AND created_by = ?3",
            params![base_id, id, user_id],
        )?;
        if n > 0 {
            moved.insert(id.to_string());
        }
    }
    if !moved.is_empty() {
        strip_from_other_drafts(conn, user_id, &item.id, &moved)?;
    }
    Ok(moved.len())
}

/// Remove the files `ids` from the user's drafts other than `except`.
fn strip_from_other_drafts(
    conn: &Connection,
    user_id: &str,
    except: &str,
    ids: &HashSet<String>,
) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT id, attachments FROM inbox_items
         WHERE user_id = ?1 AND id != ?2 AND attachments != '[]'",
    )?;
    let rows = stmt
        .query_map(params![user_id, except], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, json) in rows {
        let files: Vec<AttachmentRef> = serde_json::from_str(&json).unwrap_or_default();
        let kept: Vec<AttachmentRef> = files
            .iter()
            .filter(|a| !ids.contains(&a.id))
            .cloned()
            .collect();
        if kept.len() != files.len() {
            conn.execute(
                "UPDATE inbox_items SET attachments = ?1 WHERE id = ?2 AND user_id = ?3",
                params![attachments_json(&kept)?, id, user_id],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_overlong_body_is_refused() {
        assert!(check_body(&"a".repeat(limits::MAX_TEXT_CELL_LEN)).is_ok());
        assert!(check_body(&"a".repeat(limits::MAX_TEXT_CELL_LEN + 1)).is_err());
    }
}
