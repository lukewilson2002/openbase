//! DTOs for the activity feed (`GET /api/history`): recent changes and comments across every
//! record the caller can open.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::records::FieldChange;
use crate::field::Field;

/// A page of the feed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ActivityPage {
    pub items: Vec<ActivityItem>,
    /// Pass as `before` to get the next page; null at the end of the feed.
    #[serde(default)]
    pub next: Option<String>,
    /// The (live) fields that the `changes` of `items` refer to, by field id, so a client can show
    /// their names and format their values without loading every table. A field deleted since
    /// is missing.
    pub fields: BTreeMap<String, Field>,
}

/// One thing that happened to a record: a create, update, delete or restore, or a comment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ActivityItem {
    /// Unique in the feed: the history entry's number, or the comment's id.
    pub id: String,
    /// create | update | delete | restore | comment
    pub kind: String,
    pub created_at: i64,
    /// Who did it; null when the account is gone or an automation did it.
    #[serde(default)]
    pub author: Option<ActivityAuthor>,
    pub record: ActivityRecord,
    pub place: ActivityPlace,
    /// Per field id, like a record's own history (link values as `[{id, name}]`); empty for a
    /// comment.
    pub changes: BTreeMap<String, FieldChange>,
    /// The text of a comment (mentions written `@[Name](usrXXXX)`); null for other kinds.
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ActivityAuthor {
    pub id: String,
    pub name: String,
}

/// The record an item is about, as it is now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ActivityRecord {
    pub id: String,
    /// The text of its primary field now (empty when it has none).
    pub name: String,
    /// In the trash now.
    pub deleted: bool,
}

/// Where the record lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ActivityPlace {
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_color: String,
    pub base_id: String,
    pub base_name: String,
    #[serde(default)]
    pub base_icon: Option<String>,
    pub base_color: String,
    pub table_id: String,
    pub table_name: String,
}
