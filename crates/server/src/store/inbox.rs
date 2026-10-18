//! The inbox: a user's private quick-capture drafts (`inbox_items`).
//!
//! A draft is Markdown plus uploaded files and belongs to one user and to no
//! workspace. Every function takes the owner's id and answers "not found" for
//! anyone else's draft, so existence never leaks. Files are uploaded without a
//! base (`attachments.base_id` NULL, `created_by` = the owner) and only move
//! into a base when the draft is filed into one of its tables; the draft keeps
//! the same references an attachment cell stores.

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
    body: String,
    attachments: String,
    created_at: i64,
    updated_at: i64,
) -> InboxItem {
    InboxItem {
        id,
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
        "SELECT id, body, attachments, created_at, updated_at FROM inbox_items
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
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(items)
}

/// One of the user's drafts; 404 when it is missing or someone else's.
pub fn get(conn: &Connection, user_id: &str, id: &str) -> AppResult<InboxItem> {
    conn.query_row(
        "SELECT id, body, attachments, created_at, updated_at FROM inbox_items
         WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
        |r| {
            Ok(row_to_item(
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
            ))
        },
    )
    .optional()?
    .ok_or_else(not_found)
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

/// The ids of the files in the user's drafts other than `except` (a file may be in one
/// draft only: filing a draft hands its files to a base, which would leave a second draft
/// pointing at a file it can no longer reach).
fn files_of_other_drafts(
    conn: &Connection,
    user_id: &str,
    except: Option<&str>,
) -> AppResult<HashSet<String>> {
    let mut stmt = conn.prepare(
        "SELECT attachments FROM inbox_items
         WHERE user_id = ?1 AND id != ?2 AND attachments != '[]'",
    )?;
    let rows = stmt
        .query_map(params![user_id, except.unwrap_or_default()], |r| {
            r.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .iter()
        .flat_map(|json| serde_json::from_str::<Vec<AttachmentRef>>(json).unwrap_or_default())
        .map(|a| a.id)
        .collect())
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
    body: &str,
    files: &[AttachmentRef],
) -> AppResult<InboxItem> {
    check_body(body)?;
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
        "INSERT INTO inbox_items (id, user_id, body, attachments, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, user_id, body, attachments_json(&refs)?, now],
    )?;
    get(conn, user_id, &id)
}

/// Change a draft: only what is given. `files` replaces the whole list.
pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    body: Option<&str>,
    files: Option<&[AttachmentRef]>,
) -> AppResult<InboxItem> {
    let current = get(conn, user_id, id)?;
    let body = match body {
        Some(b) => {
            check_body(b)?;
            b.to_string()
        }
        None => current.body,
    };
    let refs = match files {
        Some(f) => resolve_attachments(conn, user_id, Some(id), f)?,
        None => current.attachments,
    };
    conn.execute(
        "UPDATE inbox_items SET body = ?1, attachments = ?2, updated_at = ?3
         WHERE id = ?4 AND user_id = ?5",
        params![body, attachments_json(&refs)?, now_ms(), id, user_id],
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

/// Hand the draft's files that the attachment fields of `given` use over to `base_id`, so a
/// record of that base can hold them, and take them out of the user's other drafts (a file
/// lives in one draft only, but a stale reference must never outlive the move). Returns how
/// many files moved.
pub fn move_files_to_base(
    conn: &Connection,
    user_id: &str,
    item: &InboxItem,
    base_id: &str,
    fields: &[Field],
    given: &Map<String, Value>,
) -> AppResult<usize> {
    let wanted = attachment_ids_in(fields, given);
    let mut moved = HashSet::new();
    for a in item.attachments.iter().filter(|a| wanted.contains(&a.id)) {
        let n = conn.execute(
            "UPDATE attachments SET base_id = ?1
             WHERE id = ?2 AND base_id IS NULL AND created_by = ?3",
            params![base_id, a.id, user_id],
        )?;
        if n > 0 {
            moved.insert(a.id.clone());
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
