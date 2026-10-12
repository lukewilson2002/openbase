//! DTOs for records, view queries, history, comments, trash and notifications.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// A record as returned by the API.
///
/// `values` is keyed by field id and contains every non-empty field,
/// including computed ones. Link fields are returned as `[{"id","name"}]`
/// ([`LinkRef`]); everything else in its canonical stored form (see
/// `og_core::field`). System fields (created/modified time/by, autonumber)
/// also appear in `values` under their field ids when the table has them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub table_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub created_by: Option<String>,
    #[serde(default)]
    pub updated_by: Option<String>,
    pub autonumber: i64,
    pub values: BTreeMap<String, Json>,
}

/// A linked record reference with its primary field text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkRef {
    pub id: String,
    pub name: String,
}

/// Restrict a query to records whose date field falls in [from, to]
/// (calendar and timeline views). Dates are `YYYY-MM-DD`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DateRange {
    pub field_id: String,
    /// Optional end-date field: a record matches if its span overlaps the range.
    #[serde(default)]
    pub end_field_id: Option<String>,
    pub from: String,
    pub to: String,
}

/// `POST /api/views/{id}/query`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct QueryRequest {
    #[serde(default)]
    pub offset: usize,
    /// Defaults to 100, max `limits::MAX_PAGE_SIZE`.
    #[serde(default)]
    pub limit: Option<usize>,
    /// Case-insensitive search over the view's visible fields.
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub range: Option<DateRange>,
    /// IANA zone of the viewer for relative date filters; defaults to the
    /// user's profile zone, then UTC.
    #[serde(default)]
    pub timezone: Option<String>,
}

/// One group header in a grouped view. Groups are listed in display order,
/// depth-first; `start` is the index (in the full ordered result) of the
/// first record in the group.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroupHeader {
    /// 0-based nesting level.
    pub depth: usize,
    pub field_id: String,
    /// Stable identity of the group value (choice id, user id, "" for empty...).
    pub key: String,
    /// Display label ("(Empty)" for blanks).
    pub label: String,
    /// Raw value to write into the field when a record is dragged into this group.
    #[serde(default)]
    pub value: Json,
    pub start: usize,
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryResponse {
    /// Number of records matching the filter and search.
    pub total: usize,
    pub offset: usize,
    pub records: Vec<Record>,
    /// Empty unless the view groups.
    #[serde(default)]
    pub groups: Vec<GroupHeader>,
    /// Row colour per record id (only when the view colours rows).
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AggregationsResponse {
    /// field id -> aggregated value for the view's configured summaries.
    pub values: BTreeMap<String, Json>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NewRecord {
    #[serde(default)]
    pub values: BTreeMap<String, Json>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CreateRecords {
    pub records: Vec<NewRecord>,
    /// Coerce values leniently and create missing select choices.
    #[serde(default)]
    pub typecast: bool,
    /// Insert after this record in manual order (default: at the end).
    #[serde(default)]
    pub after_record_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordPatch {
    pub id: String,
    /// Fields to set; JSON null clears a field. Fields not listed are unchanged.
    pub values: BTreeMap<String, Json>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UpdateRecords {
    pub records: Vec<RecordPatch>,
    #[serde(default)]
    pub typecast: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordsResponse {
    pub records: Vec<Record>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RecordIds {
    pub ids: Vec<String>,
}

/// Manual reorder: place `ids` (in the given order) before or after a record.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MoveRecords {
    pub ids: Vec<String>,
    #[serde(default)]
    pub before_id: Option<String>,
    #[serde(default)]
    pub after_id: Option<String>,
}

/// `GET /api/tables/{id}/records/lookup?q=&limit=&view_id=` (link picker).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkCandidates {
    pub records: Vec<LinkRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldChange {
    #[serde(default)]
    pub old: Json,
    #[serde(default)]
    pub new: Json,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub id: i64,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_name: Option<String>,
    /// create | update | delete | restore
    pub kind: String,
    pub changes: BTreeMap<String, FieldChange>,
    pub created_at: i64,
}

/// Comment bodies are plain text; mentions are written `@[Name](usrXXXX)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub record_id: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_name: Option<String>,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommentBody {
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrashItem {
    /// workspace | base | table | field | view | record
    pub kind: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub table_id: Option<String>,
    pub deleted_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrashListing {
    pub items: Vec<TrashItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RestoreRequest {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    /// mention | assigned | invite | automation
    pub kind: String,
    pub payload: Json,
    #[serde(default)]
    pub read_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotificationsResponse {
    pub notifications: Vec<Notification>,
    pub unread: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MarkRead {
    /// Empty = mark all read.
    #[serde(default)]
    pub ids: Vec<String>,
}
