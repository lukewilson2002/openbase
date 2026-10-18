//! DTOs for searching everything the caller can open (`GET /api/search`).

use serde::{Deserialize, Serialize};

/// `GET /api/search?q=&limit=`: matches in workspace, base, table and view
/// names, in record text and in comments, best first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
}

/// One match. The ids of everything it sits in are filled in, so the client
/// can link to it and show where it is; `id` repeats the id of the match itself
/// (a table result has `id == table_id`, a record result `id == record_id`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SearchResult {
    /// workspace | base | table | view | record | comment
    pub kind: String,
    pub id: String,
    /// The name; for a record, the text of its primary field; for a comment,
    /// that of the record it is on.
    pub name: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub workspace_color: String,
    #[serde(default)]
    pub base_id: Option<String>,
    #[serde(default)]
    pub base_name: Option<String>,
    #[serde(default)]
    pub base_icon: Option<String>,
    #[serde(default)]
    pub base_color: Option<String>,
    #[serde(default)]
    pub table_id: Option<String>,
    #[serde(default)]
    pub table_name: Option<String>,
    /// The view itself for a view; for a table or a record, the first view of
    /// its table the caller can see, to open it in.
    #[serde(default)]
    pub view_id: Option<String>,
    /// grid | form | gallery | kanban | calendar | timeline | list, with `view_id`.
    #[serde(default)]
    pub view_type: Option<String>,
    #[serde(default)]
    pub record_id: Option<String>,
    /// For a record found by another field than its primary one, or a
    /// comment: the text around the match.
    #[serde(default)]
    pub snippet: Option<String>,
    /// For a comment: who wrote it (absent when that account is gone).
    #[serde(default)]
    pub author_name: Option<String>,
}
