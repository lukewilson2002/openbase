//! DTOs for the inbox: a user's private quick-capture drafts
//! (`/api/inbox`). A draft is an optional title, Markdown text and uploaded files; filing it
//! into a table creates a record and removes the draft.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};

use crate::field::AttachmentRef;

/// A draft in the caller's inbox. Timestamps are Unix milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct InboxItem {
    pub id: String,
    /// One line, may be empty: what a record's primary field would say.
    pub title: String,
    /// Markdown text.
    pub body: String,
    /// Uploaded files (`POST /api/inbox/attachments`), in the shape an
    /// attachment cell stores.
    pub attachments: Vec<AttachmentRef>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// `POST /api/inbox`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateInboxItem {
    /// One line (may be empty).
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>", optional))]
    pub title: String,
    /// Markdown text (may be empty when there is a title or files).
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>", optional))]
    pub body: String,
    #[serde(default)]
    pub attachments: Option<Vec<AttachmentRef>>,
}

/// `PATCH /api/inbox/{id}`: only the fields given change; `attachments`
/// replaces the whole list.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateInboxItem {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<AttachmentRef>>,
}

/// `POST /api/inbox/{id}/file`: create a record in `table_id` from the
/// draft. `fields` is keyed by field name or id; to keep the draft's files,
/// put them (`{"id": ...}` is enough) in an attachment field. With
/// `note_as_comment` the draft's text becomes the record's first comment
/// instead (in the same step). The answer is the created record
/// (`TableRecord` in TypeScript) and the draft is gone.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct FileInboxItem {
    pub table_id: String,
    #[serde(default)]
    #[cfg_attr(
        feature = "ts",
        ts(
            as = "Option<std::collections::BTreeMap<String, serde_json::Value>>",
            optional
        )
    )]
    pub fields: Map<String, Json>,
    /// Add the draft's text to the new record as a comment by the caller.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub note_as_comment: bool,
}
