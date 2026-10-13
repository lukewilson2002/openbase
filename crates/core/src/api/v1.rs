//! DTOs of the Airtable-compatible API under `/api/v1` (see `docs/api.md`).
//!
//! These follow Airtable's wire names (camelCase, `createdTime`, ...) rather
//! than the internal API's snake_case, so existing Airtable client libraries
//! and scripts keep working. Request bodies are parsed by the server directly
//! (they are lenient and Airtable-shaped); only the responses are typed here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// One record in Airtable shape. `fields` holds only non-empty cells, keyed by
/// field name (or field id with `returnFieldsByFieldId`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1Record {
    pub id: String,
    /// ISO 8601 UTC with milliseconds.
    #[serde(rename = "createdTime")]
    #[cfg_attr(feature = "ts", ts(rename = "createdTime"))]
    pub created_time: String,
    pub fields: BTreeMap<String, Json>,
}

/// `GET /api/v1/{baseId}/{table}`, and batch create/update.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1Records {
    pub records: Vec<V1Record>,
    /// Pass back as `offset` to get the next page; absent on the last page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1DeletedRecord {
    pub id: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1DeletedRecords {
    pub records: Vec<V1DeletedRecord>,
}

/// A base in `GET /api/v1/meta/bases`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1Base {
    pub id: String,
    pub name: String,
    /// `read`, `comment`, `edit` or `create`; a read-only token is capped at
    /// `read`.
    #[serde(rename = "permissionLevel")]
    #[cfg_attr(feature = "ts", ts(rename = "permissionLevel"))]
    pub permission_level: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1Bases {
    pub bases: Vec<V1Base>,
}

/// A field in table metadata, with Airtable's type names and option shapes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1Field {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    #[cfg_attr(feature = "ts", ts(rename = "type"))]
    pub field_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Json>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1View {
    pub id: String,
    pub name: String,
    /// `grid`, `form`, `gallery`, `kanban`, `calendar`, `timeline` or `list`.
    #[serde(rename = "type")]
    #[cfg_attr(feature = "ts", ts(rename = "type"))]
    pub view_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1Table {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "primaryFieldId")]
    #[cfg_attr(feature = "ts", ts(rename = "primaryFieldId"))]
    pub primary_field_id: String,
    pub fields: Vec<V1Field>,
    pub views: Vec<V1View>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1Tables {
    pub tables: Vec<V1Table>,
}

/// The body of every `/api/v1` error: `{"error": {"type", "message"}}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1ErrorDetail {
    #[serde(rename = "type")]
    #[cfg_attr(feature = "ts", ts(rename = "type"))]
    pub error_type: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct V1ErrorBody {
    pub error: V1ErrorDetail,
}
