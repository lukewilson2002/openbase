//! DTOs for base schema: tables, fields, views.

use serde::{Deserialize, Serialize};

use crate::field::{Field, FieldKind};
use crate::view::{ViewConfig, ViewType};

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
    /// Caller's effective role.
    pub role: String,
    pub tables: Vec<Table>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateTable {
    pub name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateTable {
    #[serde(default)]
    pub name: Option<String>,
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
