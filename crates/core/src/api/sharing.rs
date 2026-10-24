//! DTOs for share links, public views and public forms, and CSV import.
//!
//! Share management (`/api/views/{id}/shares`, `/api/shares/{id}`) needs a
//! signed-in Creator. The `/api/public/...` endpoints take no credentials: the
//! unguessable share token is the capability, optionally guarded by a password
//! sent in the `X-Share-Password` header.
//!
//! Public responses are deliberately thinner than the internal ones: they carry
//! only the fields visible in the shared view, never user ids or e-mail
//! addresses, and never the formulas or link wiring behind computed fields.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value as Json;

use crate::api::records::GroupHeader;
use crate::field::FieldType;
use crate::view::{Filter, FormBlock, ViewType};

/// What a share link exposes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum ShareKind {
    /// Read-only access to the records of a (non-form) view.
    View,
    /// A public form that creates records anonymously.
    Form,
}

impl ShareKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ShareKind::View => "view",
            ShareKind::Form => "form",
        }
    }

    pub fn parse(s: &str) -> Option<ShareKind> {
        match s {
            "view" => Some(ShareKind::View),
            "form" => Some(ShareKind::Form),
            _ => None,
        }
    }
}

/// `POST /api/views/{id}/shares`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CreateShare {
    pub kind: ShareKind,
    /// Optional password visitors must send in `X-Share-Password`.
    #[serde(default)]
    pub password: Option<String>,
}

/// `PATCH /api/shares/{id}`. Omitted fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct UpdateShare {
    #[serde(default)]
    pub enabled: Option<bool>,
    /// A string sets the password, JSON `null` removes it, omitting the key
    /// leaves it alone.
    #[serde(default, deserialize_with = "some_value")]
    #[cfg_attr(feature = "ts", ts(type = "string | null", optional))]
    pub password: Option<Option<String>>,
}

/// Distinguish an omitted key (`None`) from an explicit `null` (`Some(None)`).
fn some_value<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

/// A share link as shown to the people who manage it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ShareLink {
    pub id: String,
    pub view_id: String,
    pub kind: ShareKind,
    /// The secret that appears in the public URL.
    pub token: String,
    /// App path of the public page: `/s/{token}` for views, `/f/{token}` for forms.
    pub path: String,
    /// `path` on the configured public URL.
    pub url: String,
    pub enabled: bool,
    pub has_password: bool,
    #[serde(default)]
    pub created_by: Option<String>,
    pub created_at: i64,
}

/// A field as seen through a public share: no formulas, no link wiring, no
/// ids of fields that are not shown.
///
/// `options` has the shape of the field's `options` object with internals
/// removed: formulas and rollups keep only `format` and `result_type`,
/// lookups and counts keep `result_type` (counts nothing), links keep
/// `single`, last-modified fields keep only their date display options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PublicField {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub options: Json,
}

/// The parts of a view's configuration a public viewer needs to lay it out.
/// References to fields that are not visible in the view are dropped.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PublicViewConfig {
    pub field_widths: BTreeMap<String, u32>,
    pub frozen_columns: u32,
    /// Stack field of a kanban view.
    #[serde(default)]
    pub kanban_stack_field_id: Option<String>,
    #[serde(default)]
    pub kanban_cover_field_id: Option<String>,
    #[serde(default)]
    pub description_field_id: Option<String>,
    #[serde(default)]
    pub kanban_hide_empty_stacks: bool,
    /// Stack keys in the view's order, and the stacks it leaves off the board. Empty for
    /// person stacks, whose keys are user ids a public viewer does not see.
    #[serde(default)]
    pub kanban_stack_order: Vec<String>,
    #[serde(default)]
    pub kanban_hidden_stacks: Vec<String>,
    #[serde(default)]
    pub kanban_card_field_limit: Option<u32>,
    /// Kanban covers are fitted whole rather than cropped.
    #[serde(default)]
    pub kanban_cover_fit: bool,
    #[serde(default)]
    pub gallery_cover_field_id: Option<String>,
    #[serde(default)]
    pub calendar_date_field_id: Option<String>,
    #[serde(default)]
    pub calendar_end_field_id: Option<String>,
    #[serde(default)]
    pub timeline_start_field_id: Option<String>,
    #[serde(default)]
    pub timeline_end_field_id: Option<String>,
    #[serde(default)]
    pub timeline_group_field_id: Option<String>,
}

/// `GET /api/public/shares/{token}`: a shared (read-only) view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PublicView {
    pub kind: ShareKind,
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: ViewType,
    pub table_name: String,
    #[serde(default)]
    pub table_icon: Option<String>,
    pub base_name: String,
    #[serde(default)]
    pub base_icon: Option<String>,
    /// Only the fields visible in the view, in the view's display order.
    pub fields: Vec<PublicField>,
    pub config: PublicViewConfig,
}

/// A record as seen through a public share. There are no creator or editor
/// ids; user cells carry names only (`User` fields `[{"name"}]`, created/last
/// modified by `{"name"}`), link cells `[{"id","name"}]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PublicRecord {
    pub id: String,
    pub values: BTreeMap<String, Json>,
}

/// `POST /api/public/shares/{token}/query` (body: `QueryRequest`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PublicQueryResponse {
    pub total: usize,
    pub offset: usize,
    pub records: Vec<PublicRecord>,
    /// Group headers (only for groupings on visible fields).
    #[serde(default)]
    pub groups: Vec<GroupHeader>,
    /// Row colours, only when the view colours rows by a visible select field.
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
}

/// One input of a public form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PublicFormField {
    /// Key to use in `values` when submitting.
    pub id: String,
    /// The label override, else the field name.
    pub label: String,
    #[serde(default)]
    pub help: Option<String>,
    pub required: bool,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    /// Type options: select choices, rating max, number precision, ...
    pub options: Json,
    /// What the field starts with (its default as a value to submit), so a visitor sees what an
    /// untouched box would otherwise get.
    #[serde(default)]
    pub default: Option<Json>,
    /// Shown only while the answers given above it meet this condition (field ids are those of the
    /// form's other inputs; one that is not among them counts as unanswered).
    #[serde(default)]
    pub show_if: Option<Filter>,
    /// Set for a heading (`label` is its text) or a paragraph (`help` is its text): not an input,
    /// `type` is `text` and `options` empty, and nothing is submitted for it.
    #[serde(default)]
    pub block: Option<FormBlock>,
}

/// `GET /api/public/forms/{token}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PublicForm {
    pub title: String,
    pub description: String,
    pub base_name: String,
    #[serde(default)]
    pub base_icon: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub table_icon: Option<String>,
    pub fields: Vec<PublicFormField>,
    pub submit_label: String,
    pub success_message: String,
    /// Only http(s) URLs are ever returned.
    #[serde(default)]
    pub redirect_url: Option<String>,
    pub show_submit_another: bool,
}

/// `POST /api/public/forms/{token}/submit`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct FormSubmission {
    /// Field id -> value, as in the record API (attachment fields take the
    /// `AttachmentRef` returned by the form's upload endpoint).
    pub values: BTreeMap<String, Json>,
}

/// One row-level problem found by a CSV import.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ImportRowError {
    /// Row number as a spreadsheet shows it: the header is row 1, the first
    /// data row is 2 (without a header the first data row is 1).
    pub row: usize,
    pub message: String,
}

/// Successful CSV import.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ImportResult {
    pub table_id: String,
    /// Records created.
    pub created: usize,
    /// Present when a new table was created: its fields (name, type).
    #[serde(default)]
    pub fields: Vec<ImportedField>,
}

/// A field created from a CSV column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ImportedField {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: FieldType,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_share_tells_missing_from_null() {
        let none: UpdateShare = serde_json::from_str("{}").unwrap();
        assert_eq!(none.password, None);
        let clear: UpdateShare = serde_json::from_str(r#"{"password": null}"#).unwrap();
        assert_eq!(clear.password, Some(None));
        let set: UpdateShare = serde_json::from_str(r#"{"password": "pw"}"#).unwrap();
        assert_eq!(set.password, Some(Some("pw".to_string())));
        let en: UpdateShare = serde_json::from_str(r#"{"enabled": false}"#).unwrap();
        assert_eq!((en.enabled, en.password), (Some(false), None));
    }

    #[test]
    fn share_kind_round_trips() {
        for k in [ShareKind::View, ShareKind::Form] {
            assert_eq!(ShareKind::parse(k.as_str()), Some(k));
            assert_eq!(serde_json::to_value(k).unwrap(), k.as_str());
        }
        assert_eq!(ShareKind::parse("other"), None);
    }
}
