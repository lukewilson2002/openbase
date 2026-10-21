//! Field (column) definitions.
//!
//! A field's type and its options travel together as [`FieldKind`], serialized
//! as `{"type": "...", "options": {...}}`. Field ids are stable; names are not,
//! so stored record data and formulas (after parsing) refer to fields by id.
//!
//! Canonical stored JSON per type (what lives in `records.data[field_id]`):
//!
//! | type               | stored JSON                                         |
//! |--------------------|-----------------------------------------------------|
//! | text               | string (line breaks only when `multiline`)          |
//! | rich_text          | string of Markdown                                  |
//! | number/currency/percent/rating | number (percent stored as fraction: 0.5 = 50%) |
//! | duration           | number of seconds                                   |
//! | checkbox           | `true` (unchecked is absent/null)                   |
//! | single_select      | choice id string                                    |
//! | multiple_select    | array of choice id strings                          |
//! | date               | `"YYYY-MM-DD"` (date only) or RFC 3339 UTC `"...Z"`  |
//! | email/url/phone/barcode | string                                         |
//! | attachment         | array of [`AttachmentRef`]                          |
//! | link               | array of record id strings (both sides stored)       |
//! | user               | array of user id strings                            |
//! | computed types     | never stored; computed on read                      |
//!
//! `options` is always required on the wire; `{}` gives every option its default.
//!
//! Empty values are never stored: an empty string, empty array or `false`
//! checkbox is removed from the record JSON (`cell::normalize` enforces this).

use serde::{Deserialize, Serialize};

use crate::ids::{ChoiceId, FieldId, TableId, ViewId};
use crate::value::ResultType;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Field {
    pub id: FieldId,
    pub table_id: TableId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub kind: FieldKind,
}

impl Field {
    pub fn field_type(&self) -> FieldType {
        self.kind.field_type()
    }
}

/// Field type tag without options. Serialized names match [`FieldKind`] tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    /// Plain text. Named `single_line_text` before v0.8, still accepted.
    #[serde(alias = "single_line_text")]
    Text,
    /// Markdown. Named `long_text` before v0.8, still accepted.
    #[serde(alias = "long_text")]
    RichText,
    Number,
    Currency,
    Percent,
    Duration,
    Rating,
    Checkbox,
    SingleSelect,
    MultipleSelect,
    Date,
    Email,
    Url,
    Phone,
    Attachment,
    Link,
    User,
    Formula,
    Lookup,
    Rollup,
    Count,
    CreatedTime,
    LastModifiedTime,
    CreatedBy,
    LastModifiedBy,
    Autonumber,
    Barcode,
    Button,
}

impl FieldType {
    pub const ALL: [FieldType; 28] = [
        FieldType::Text,
        FieldType::RichText,
        FieldType::Number,
        FieldType::Currency,
        FieldType::Percent,
        FieldType::Duration,
        FieldType::Rating,
        FieldType::Checkbox,
        FieldType::SingleSelect,
        FieldType::MultipleSelect,
        FieldType::Date,
        FieldType::Email,
        FieldType::Url,
        FieldType::Phone,
        FieldType::Attachment,
        FieldType::Link,
        FieldType::User,
        FieldType::Formula,
        FieldType::Lookup,
        FieldType::Rollup,
        FieldType::Count,
        FieldType::CreatedTime,
        FieldType::LastModifiedTime,
        FieldType::CreatedBy,
        FieldType::LastModifiedBy,
        FieldType::Autonumber,
        FieldType::Barcode,
        FieldType::Button,
    ];

    /// Computed fields are never written by clients and never stored.
    pub fn is_computed(self) -> bool {
        matches!(
            self,
            FieldType::Formula
                | FieldType::Lookup
                | FieldType::Rollup
                | FieldType::Count
                | FieldType::CreatedTime
                | FieldType::LastModifiedTime
                | FieldType::CreatedBy
                | FieldType::LastModifiedBy
                | FieldType::Autonumber
                | FieldType::Button
        )
    }

    /// Whether this type may be a table's primary field.
    pub fn can_be_primary(self) -> bool {
        !matches!(
            self,
            FieldType::Link
                | FieldType::Attachment
                | FieldType::Checkbox
                | FieldType::Lookup
                | FieldType::Rollup
                | FieldType::Count
                | FieldType::Button
                | FieldType::MultipleSelect
                | FieldType::Rating
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            FieldType::Text => "Text",
            FieldType::RichText => "Rich text",
            FieldType::Number => "Number",
            FieldType::Currency => "Currency",
            FieldType::Percent => "Percent",
            FieldType::Duration => "Duration",
            FieldType::Rating => "Rating",
            FieldType::Checkbox => "Checkbox",
            FieldType::SingleSelect => "Single select",
            FieldType::MultipleSelect => "Multiple select",
            FieldType::Date => "Date",
            FieldType::Email => "Email",
            FieldType::Url => "URL",
            FieldType::Phone => "Phone number",
            FieldType::Attachment => "Attachment",
            FieldType::Link => "Link to another record",
            FieldType::User => "User",
            FieldType::Formula => "Formula",
            FieldType::Lookup => "Lookup",
            FieldType::Rollup => "Rollup",
            FieldType::Count => "Count",
            FieldType::CreatedTime => "Created time",
            FieldType::LastModifiedTime => "Last modified time",
            FieldType::CreatedBy => "Created by",
            FieldType::LastModifiedBy => "Last modified by",
            FieldType::Autonumber => "Autonumber",
            FieldType::Barcode => "Barcode",
            FieldType::Button => "Button",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(tag = "type", content = "options", rename_all = "snake_case")]
pub enum FieldKind {
    /// Accepts `single_line_text` (its name before v0.8).
    #[serde(alias = "single_line_text")]
    Text(#[serde(default)] TextOptions),
    /// Accepts `long_text` (its name before v0.8); its old `rich` option is ignored.
    #[serde(alias = "long_text")]
    RichText(#[serde(default)] Empty),
    Number(#[serde(default)] NumberOptions),
    Currency(#[serde(default)] CurrencyOptions),
    Percent(#[serde(default)] NumberOptions),
    Duration(#[serde(default)] DurationOptions),
    Rating(#[serde(default)] RatingOptions),
    Checkbox(#[serde(default)] CheckboxOptions),
    SingleSelect(#[serde(default)] SelectOptions),
    MultipleSelect(#[serde(default)] SelectOptions),
    Date(#[serde(default)] DateOptions),
    Email(#[serde(default)] Empty),
    Url(#[serde(default)] Empty),
    Phone(#[serde(default)] Empty),
    Attachment(#[serde(default)] Empty),
    Link(LinkOptions),
    User(#[serde(default)] UserOptions),
    Formula(FormulaOptions),
    Lookup(LookupOptions),
    Rollup(RollupOptions),
    Count(CountOptions),
    CreatedTime(#[serde(default)] DateOptions),
    LastModifiedTime(#[serde(default)] LastModifiedOptions),
    CreatedBy(#[serde(default)] Empty),
    LastModifiedBy(#[serde(default)] LastModifiedOptions),
    Autonumber(#[serde(default)] Empty),
    Barcode(#[serde(default)] Empty),
    Button(ButtonOptions),
}

impl FieldKind {
    pub fn field_type(&self) -> FieldType {
        match self {
            FieldKind::Text(_) => FieldType::Text,
            FieldKind::RichText(_) => FieldType::RichText,
            FieldKind::Number(_) => FieldType::Number,
            FieldKind::Currency(_) => FieldType::Currency,
            FieldKind::Percent(_) => FieldType::Percent,
            FieldKind::Duration(_) => FieldType::Duration,
            FieldKind::Rating(_) => FieldType::Rating,
            FieldKind::Checkbox(_) => FieldType::Checkbox,
            FieldKind::SingleSelect(_) => FieldType::SingleSelect,
            FieldKind::MultipleSelect(_) => FieldType::MultipleSelect,
            FieldKind::Date(_) => FieldType::Date,
            FieldKind::Email(_) => FieldType::Email,
            FieldKind::Url(_) => FieldType::Url,
            FieldKind::Phone(_) => FieldType::Phone,
            FieldKind::Attachment(_) => FieldType::Attachment,
            FieldKind::Link(_) => FieldType::Link,
            FieldKind::User(_) => FieldType::User,
            FieldKind::Formula(_) => FieldType::Formula,
            FieldKind::Lookup(_) => FieldType::Lookup,
            FieldKind::Rollup(_) => FieldType::Rollup,
            FieldKind::Count(_) => FieldType::Count,
            FieldKind::CreatedTime(_) => FieldType::CreatedTime,
            FieldKind::LastModifiedTime(_) => FieldType::LastModifiedTime,
            FieldKind::CreatedBy(_) => FieldType::CreatedBy,
            FieldKind::LastModifiedBy(_) => FieldType::LastModifiedBy,
            FieldKind::Autonumber(_) => FieldType::Autonumber,
            FieldKind::Barcode(_) => FieldType::Barcode,
            FieldKind::Button(_) => FieldType::Button,
        }
    }

    /// Default options for a freshly created field of `t`. Types whose options
    /// have required references (link, lookup, rollup, count, formula, button)
    /// return `None`: the client must supply options.
    pub fn default_for(t: FieldType) -> Option<FieldKind> {
        Some(match t {
            FieldType::Text => FieldKind::Text(Default::default()),
            FieldType::RichText => FieldKind::RichText(Empty {}),
            FieldType::Number => FieldKind::Number(Default::default()),
            FieldType::Currency => FieldKind::Currency(Default::default()),
            FieldType::Percent => FieldKind::Percent(Default::default()),
            FieldType::Duration => FieldKind::Duration(Default::default()),
            FieldType::Rating => FieldKind::Rating(Default::default()),
            FieldType::Checkbox => FieldKind::Checkbox(Default::default()),
            FieldType::SingleSelect => FieldKind::SingleSelect(Default::default()),
            FieldType::MultipleSelect => FieldKind::MultipleSelect(Default::default()),
            FieldType::Date => FieldKind::Date(Default::default()),
            FieldType::Email => FieldKind::Email(Empty {}),
            FieldType::Url => FieldKind::Url(Empty {}),
            FieldType::Phone => FieldKind::Phone(Empty {}),
            FieldType::Attachment => FieldKind::Attachment(Empty {}),
            FieldType::User => FieldKind::User(Default::default()),
            FieldType::CreatedTime => FieldKind::CreatedTime(Default::default()),
            FieldType::LastModifiedTime => FieldKind::LastModifiedTime(Default::default()),
            FieldType::CreatedBy => FieldKind::CreatedBy(Empty {}),
            FieldType::LastModifiedBy => FieldKind::LastModifiedBy(Default::default()),
            FieldType::Autonumber => FieldKind::Autonumber(Empty {}),
            FieldType::Barcode => FieldKind::Barcode(Empty {}),
            FieldType::Link
            | FieldType::Formula
            | FieldType::Lookup
            | FieldType::Rollup
            | FieldType::Count
            | FieldType::Button => return None,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
// ts-rs would emit `Record<symbol, never>`; JSON object keys are strings.
#[cfg_attr(
    feature = "ts",
    derive(ts_rs::TS),
    ts(export, type = "Record<string, never>")
)]
pub struct Empty {}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct TextOptions {
    /// Keep line breaks. Off, a line break becomes a space (titles, names).
    #[serde(default)]
    pub multiline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct NumberOptions {
    /// Decimal places, 0..=8.
    pub precision: u8,
    pub allow_negative: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<f64>,
}

impl Default for NumberOptions {
    fn default() -> Self {
        Self {
            precision: 0,
            allow_negative: true,
            default: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct CurrencyOptions {
    pub precision: u8,
    pub symbol: String,
    pub allow_negative: bool,
}

impl Default for CurrencyOptions {
    fn default() -> Self {
        Self {
            precision: 2,
            symbol: "$".into(),
            allow_negative: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum DurationFormat {
    /// h:mm
    #[default]
    HMm,
    /// h:mm:ss
    HMmSs,
    /// h:mm:ss.s
    HMmSsS,
    /// h:mm:ss.ss
    HMmSsSs,
    /// h:mm:ss.sss
    HMmSsSss,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct DurationOptions {
    #[serde(default)]
    pub format: DurationFormat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct RatingOptions {
    /// 1..=10
    pub max: u8,
    pub icon: String,
    pub color: String,
}

impl Default for RatingOptions {
    fn default() -> Self {
        Self {
            max: 5,
            icon: "star".into(),
            color: "yellow".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct CheckboxOptions {
    pub icon: String,
    pub color: String,
}

impl Default for CheckboxOptions {
    fn default() -> Self {
        Self {
            icon: "check".into(),
            color: "green".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SelectChoice {
    pub id: ChoiceId,
    pub name: String,
    /// One of [`COLORS`].
    pub color: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct SelectOptions {
    #[serde(default)]
    pub choices: Vec<SelectChoice>,
}

/// The fixed colour palette used by select choices, row colouring, bases etc.
pub const COLORS: [&str; 20] = [
    "blue",
    "cyan",
    "teal",
    "green",
    "yellow",
    "orange",
    "red",
    "pink",
    "purple",
    "gray",
    "blue_dark",
    "cyan_dark",
    "teal_dark",
    "green_dark",
    "yellow_dark",
    "orange_dark",
    "red_dark",
    "pink_dark",
    "purple_dark",
    "gray_dark",
];

/// The colour a new select choice gets when none was given. Common severity, priority and
/// status words get a colour that matches their meaning (Critical red, High orange, Medium
/// yellow, Low green, Done green, ...); any other name falls back to the palette cycle at
/// `index` (the choice's position in the field), so choices still look distinct.
pub fn default_choice_color(name: &str, index: usize) -> &'static str {
    let key = name
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    match key.as_str() {
        "critical" | "urgent" | "blocker" | "highest" | "p0" | "sev0" | "sev1" | "severe"
        | "blocked" | "failed" | "failure" | "error" | "rejected" | "broken" | "emergency" => "red",
        "high" | "major" | "p1" | "sev2" | "important" | "overdue" | "at risk" | "warning" => {
            "orange"
        }
        "medium" | "med" | "moderate" | "normal" | "p2" | "sev3" | "in progress" | "doing"
        | "started" | "in review" | "review" | "pending" | "waiting" | "on hold"
        | "in development" => "yellow",
        "low" | "minor" | "lowest" | "trivial" | "p3" | "p4" | "sev4" | "done" | "complete"
        | "completed" | "resolved" | "closed" | "shipped" | "approved" | "fixed" | "passed"
        | "success" | "active" | "released" | "live" | "paid" => "green",
        "open" | "new" | "planned" | "scheduled" | "ready" | "to do" | "todo" | "backlog"
        | "not started" | "draft" | "idea" | "proposed" => "blue",
        "cancelled" | "canceled" | "wont do" | "won't do" | "archived" | "duplicate"
        | "obsolete" | "inactive" | "n/a" | "none" | "unknown" => "gray",
        _ => COLORS[index % COLORS.len()],
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum DateFormat {
    /// 10/12/2026
    #[default]
    Us,
    /// 12/10/2026
    European,
    /// 2026-10-12
    Iso,
    /// October 12, 2026
    Friendly,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum TimeFormat {
    #[default]
    H12,
    H24,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct DateOptions {
    pub include_time: bool,
    pub date_format: DateFormat,
    pub time_format: TimeFormat,
    /// IANA zone used to display (and interpret input) for every viewer.
    /// `None` means each viewer sees their own local zone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct LastModifiedOptions {
    /// Only changes to these fields count. Empty = any editable field.
    pub fields: Vec<FieldId>,
    /// Display options (ignored for last_modified_by).
    pub date: DateOptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct LinkOptions {
    pub linked_table_id: TableId,
    /// The paired field in the linked table. Every link field has exactly one
    /// inverse (self-links included); both sides store record ids.
    /// Ignored on create (the server creates the inverse) and filled on read.
    #[serde(default)]
    pub inverse_field_id: FieldId,
    /// Limit to a single linked record.
    #[serde(default)]
    pub single: bool,
    /// Restrict the record picker to records in this view of the linked table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picker_view_id: Option<ViewId>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct UserOptions {
    pub multiple: bool,
    /// Send an in-app notification when a user is added to the cell.
    pub notify: bool,
}

/// How a computed number/date result is displayed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ValueFormat {
    Number { precision: u8 },
    Currency { precision: u8, symbol: String },
    Percent { precision: u8 },
    Duration { format: DurationFormat },
    Date(DateOptions),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct FormulaOptions {
    /// Source text as the user typed it, with `{Field Name}` references.
    /// The server stores it with references rewritten to `{fldXXXX}` ids and
    /// rewrites back to names when serving (so renames never break formulas).
    pub expression: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ValueFormat>,
    /// Filled by the server from type inference; ignored on input.
    #[serde(default)]
    pub result_type: ResultType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct LookupOptions {
    /// A link field in this table.
    pub link_field_id: FieldId,
    /// A field in the linked table.
    pub target_field_id: FieldId,
    /// Filled by the server (always an array of the target's type); ignored on input.
    #[serde(default)]
    pub result_type: ResultType,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct RollupOptions {
    pub link_field_id: FieldId,
    pub target_field_id: FieldId,
    /// A formula over the array `values`, e.g. `SUM(values)`,
    /// `ARRAYJOIN(ARRAYUNIQUE(values), ", ")`.
    pub expression: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<ValueFormat>,
    /// Filled by the server from type inference; ignored on input.
    #[serde(default)]
    pub result_type: ResultType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct CountOptions {
    pub link_field_id: FieldId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ButtonOptions {
    pub label: String,
    /// Formula producing the URL to open. Only http(s) and mailto URLs open.
    pub url_formula: String,
}

/// Reference to an uploaded file, as stored in an attachment cell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct AttachmentRef {
    pub id: String,
    pub filename: String,
    pub mime: String,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_kind_round_trips_with_type_tag() {
        let f = Field {
            id: "fld1".into(),
            table_id: "tbl1".into(),
            name: "Price".into(),
            description: None,
            kind: FieldKind::Currency(CurrencyOptions::default()),
        };
        let json = serde_json::to_value(&f).unwrap();
        assert_eq!(json["type"], "currency");
        assert_eq!(json["options"]["symbol"], "$");
        let back: Field = serde_json::from_value(json).unwrap();
        assert_eq!(back, f);
    }

    #[test]
    fn options_default_when_missing() {
        let f: Field = serde_json::from_value(serde_json::json!({
            "id": "fld1", "table_id": "tbl1", "name": "N", "type": "number", "options": {}
        }))
        .unwrap();
        assert_eq!(f.kind, FieldKind::Number(NumberOptions::default()));
    }

    #[test]
    fn every_type_has_matching_tag() {
        for t in FieldType::ALL {
            let tag = serde_json::to_value(t).unwrap();
            if let Some(kind) = FieldKind::default_for(t) {
                assert_eq!(kind.field_type(), t);
                let j = serde_json::to_value(&kind).unwrap();
                assert_eq!(j["type"], tag);
            }
        }
    }

    #[test]
    fn text_types_accept_their_old_names() {
        let kind = |j: serde_json::Value| serde_json::from_value::<FieldKind>(j).unwrap();
        assert_eq!(
            kind(serde_json::json!({"type": "single_line_text", "options": {"default": "x"}})),
            FieldKind::Text(TextOptions {
                multiline: false,
                default: Some("x".into()),
            })
        );
        // Long text is Rich text now; its old `rich` option means nothing.
        for options in [
            serde_json::json!({}),
            serde_json::json!({"rich": true}),
            serde_json::json!({"rich": false}),
        ] {
            assert_eq!(
                kind(serde_json::json!({"type": "long_text", "options": options})),
                FieldKind::RichText(Empty {})
            );
        }
        let t: FieldType = serde_json::from_value(serde_json::json!("long_text")).unwrap();
        assert_eq!(t, FieldType::RichText);
        // Written under the new names only.
        assert_eq!(
            serde_json::to_value(FieldKind::Text(TextOptions::default())).unwrap(),
            serde_json::json!({"type": "text", "options": {"multiline": false}})
        );
        assert_eq!(
            serde_json::to_value(FieldKind::RichText(Empty {})).unwrap(),
            serde_json::json!({"type": "rich_text", "options": {}})
        );
    }

    #[test]
    fn default_choice_colors_follow_meaning() {
        assert_eq!(default_choice_color("Critical", 0), "red");
        assert_eq!(default_choice_color(" urgent ", 3), "red");
        assert_eq!(default_choice_color("High", 1), "orange");
        assert_eq!(default_choice_color("MEDIUM", 2), "yellow");
        assert_eq!(default_choice_color("Low", 3), "green");
        assert_eq!(default_choice_color("In Progress", 0), "yellow");
        assert_eq!(default_choice_color("in_progress", 0), "yellow");
        assert_eq!(default_choice_color("Done", 5), "green");
        assert_eq!(default_choice_color("Open", 5), "blue");
        assert_eq!(default_choice_color("Won't do", 0), "gray");
    }

    #[test]
    fn unknown_choice_names_cycle_the_palette() {
        assert_eq!(default_choice_color("Billing", 0), COLORS[0]);
        assert_eq!(default_choice_color("Shipping", 2), COLORS[2]);
        assert_eq!(default_choice_color("Other", 21), COLORS[1]);
    }
}
