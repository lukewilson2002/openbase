//! DTOs for base schema: tables, fields, views.

use serde::{Deserialize, Serialize};

use crate::field::{Field, FieldKind};
use crate::value::ResultType;
use crate::view::{ViewConfig, ViewType};
use serde_json::Value as Json;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct View {
    pub id: String,
    pub table_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: ViewType,
    pub config: ViewConfig,
    /// Personal views are visible only to their owner.
    #[serde(default)]
    pub personal: bool,
    /// Locked views can only be reconfigured by creators/owners.
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Table {
    pub id: String,
    pub base_id: String,
    pub name: String,
    /// Lucide icon name (kebab-case); the client falls back to the name's initial.
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub primary_field_id: String,
    /// Fields in display order.
    pub fields: Vec<Field>,
    /// Views in display order (only those visible to the caller).
    pub views: Vec<View>,
}

/// `GET /api/bases/{id}`: everything the client needs to render a base.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct BaseSchema {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub icon: Option<String>,
    /// Caller's role on the base (their workspace role).
    pub role: String,
    pub tables: Vec<Table>,
    /// Who can open this base (members first, then pending invites).
    pub people: Vec<crate::api::workspaces::BasePerson>,
    pub workspace_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateTable {
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateTable {
    #[serde(default)]
    pub name: Option<String>,
    /// Lucide icon name (kebab-case). Absent = unchanged, `null` = clear.
    #[serde(
        default,
        deserialize_with = "super::double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "ts", ts(as = "Option<String>"))]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateField {
    pub name: String,
    #[serde(flatten)]
    pub kind: FieldKind,
    #[serde(default)]
    pub description: Option<String>,
    /// For link fields: name of the inverse field created in the linked table.
    #[serde(default)]
    pub inverse_name: Option<String>,
}

/// Partial update. Changing `kind` to a different type converts existing data.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
// ts-rs cannot flatten an optional enum, so the generated type is `UpdateFieldBase`
// (everything except `kind`) and `web/src/api/types/overrides.ts` defines `UpdateField`.
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, rename = "UpdateFieldBase", optional_fields = nullable)
)]
pub struct UpdateField {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, flatten)]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub kind: Option<FieldKind>,
    /// Move the field after this field id in table order (None = unchanged).
    #[serde(default)]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SetPrimaryField {
    pub field_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateView {
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: ViewType,
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(as = "Option<bool>", optional))]
    pub personal: bool,
    /// Optional initial config (otherwise defaults; forms get all editable fields).
    #[serde(default)]
    pub config: Option<ViewConfig>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateView {
    #[serde(default)]
    pub name: Option<String>,
    /// Full replacement of the config.
    #[serde(default)]
    pub config: Option<ViewConfig>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub position: Option<f64>,
}

/// `POST /api/tables/{id}/duplicate` (body optional).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DuplicateTable {
    /// Name of the copy; defaults to "<name> copy" (made unique).
    #[serde(default)]
    pub name: Option<String>,
    /// Copy records too (default true).
    #[serde(default = "default_true")]
    pub include_records: bool,
}

impl Default for DuplicateTable {
    fn default() -> Self {
        Self {
            name: None,
            include_records: true,
        }
    }
}

fn default_true() -> bool {
    true
}

/// `POST /api/views/{id}/duplicate` (body optional).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DuplicateView {
    /// Name of the copy; defaults to "<name> copy".
    #[serde(default)]
    pub name: Option<String>,
    /// Make the copy a personal view (always true when the source is personal).
    #[serde(default)]
    pub personal: bool,
}

/// `POST /api/tables/{id}/formula/check`: parse and type-check a formula as
/// typed in the field editor (`{Field Name}` references) and preview it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct FormulaCheck {
    pub expression: String,
    /// Record to preview against (default: the first live record of the table).
    #[serde(default)]
    pub record_id: Option<String>,
}

/// Why a formula was rejected.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct FormulaCheckError {
    pub message: String,
    /// Byte offset in the expression, when known.
    #[serde(default)]
    pub pos: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct FormulaCheckResult {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<FormulaCheckError>,
    /// Inferred result type (present when `ok`).
    #[serde(default)]
    pub result_type: Option<ResultType>,
    /// The formula evaluated for the sample record, as it would be stored
    /// (errors are `{"error": "..."}`); absent when the table has no records.
    #[serde(default)]
    pub preview: Option<Json>,
}

/// `DELETE /api/fields/{id}`: the field is trashed together with the fields
/// that depended on it (lookups, rollups, the inverse of a link...).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct DeleteFieldResponse {
    pub ok: bool,
    pub deleted_field_ids: Vec<String>,
}
