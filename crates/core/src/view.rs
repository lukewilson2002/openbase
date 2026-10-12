//! View configuration.
//!
//! One [`ViewConfig`] struct covers every view type; sections that don't apply
//! to a view's type are ignored. All fields default so configs stay readable
//! as the struct evolves.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::ids::FieldId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewType {
    Grid,
    Form,
    Gallery,
    Kanban,
    Calendar,
    Timeline,
    List,
}

impl ViewType {
    pub const ALL: [ViewType; 7] = [
        ViewType::Grid,
        ViewType::Form,
        ViewType::Gallery,
        ViewType::Kanban,
        ViewType::Calendar,
        ViewType::Timeline,
        ViewType::List,
    ];
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Conjunction {
    #[default]
    And,
    Or,
}

/// A filter tree. Top level is a group; groups nest (the UI allows 2 levels).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Filter {
    #[serde(default)]
    pub conjunction: Conjunction,
    #[serde(default)]
    pub items: Vec<FilterItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterItem {
    Condition(Condition),
    Group(Filter),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Condition {
    pub field_id: FieldId,
    pub op: FilterOp,
    /// Operand; shape depends on the op and field type:
    /// text ops: string; numeric ops: number; select ops: choice id or array;
    /// date ops: [`DateOperand`]; is_empty/is_not_empty: ignored.
    #[serde(default)]
    pub value: Json,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    // generic
    Is,
    IsNot,
    IsEmpty,
    IsNotEmpty,
    // text
    Contains,
    DoesNotContain,
    StartsWith,
    EndsWith,
    // numeric
    Lt,
    Lte,
    Gt,
    Gte,
    // single select / user (single)
    IsAnyOf,
    IsNoneOf,
    // multi-valued (multiple select, link, user, attachment names, lookup)
    HasAnyOf,
    HasAllOf,
    HasNoneOf,
    IsExactly,
    // dates
    IsBefore,
    IsAfter,
    IsOnOrBefore,
    IsOnOrAfter,
    IsWithin,
}

/// Date filter operand. Relative modes are resolved against `now` and the
/// viewer's timezone at query time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum DateOperand {
    Today,
    Tomorrow,
    Yesterday,
    OneWeekAgo,
    OneWeekFromNow,
    OneMonthAgo,
    OneMonthFromNow,
    NumberOfDaysAgo { days: u32 },
    NumberOfDaysFromNow { days: u32 },
    ExactDate { date: String },
    // for is_within only
    PastWeek,
    PastMonth,
    PastYear,
    NextWeek,
    NextMonth,
    NextYear,
    PastNumberOfDays { days: u32 },
    NextNumberOfDays { days: u32 },
    ThisCalendarMonth,
    ThisCalendarYear,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    #[default]
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sort {
    pub field_id: FieldId,
    #[serde(default)]
    pub direction: Direction,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowHeight {
    #[default]
    Short,
    Medium,
    Tall,
    ExtraTall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Aggregation {
    None,
    Empty,
    Filled,
    Unique,
    PercentEmpty,
    PercentFilled,
    PercentUnique,
    Sum,
    Average,
    Median,
    Min,
    Max,
    Range,
    StdDev,
    Checked,
    Unchecked,
    PercentChecked,
    PercentUnchecked,
    EarliestDate,
    LatestDate,
    DateRangeDays,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RowColor {
    /// Colour each row by the colour of its choice in a single select field.
    BySelect { field_id: FieldId },
    /// First matching rule wins.
    ByConditions { rules: Vec<ColorRule> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorRule {
    pub color: String,
    pub filter: Filter,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct KanbanConfig {
    /// Single select, user (single) or checkbox field to stack by.
    pub stack_field_id: Option<FieldId>,
    pub cover_field_id: Option<FieldId>,
    pub hide_empty_stacks: bool,
    /// Stack (choice id / user id / "true"/"false"/"" for uncategorized) display order.
    pub stack_order: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CalendarConfig {
    pub date_field_id: Option<FieldId>,
    /// Optional end date for multi-day events.
    pub end_field_id: Option<FieldId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct GalleryConfig {
    pub cover_field_id: Option<FieldId>,
    /// Crop (true) or fit (false) cover images.
    pub cover_crop: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TimelineConfig {
    pub start_field_id: Option<FieldId>,
    pub end_field_id: Option<FieldId>,
    /// Optional swimlane grouping.
    pub group_field_id: Option<FieldId>,
    /// Optional link-to-self field drawn as dependency arrows (Gantt).
    pub dependency_field_id: Option<FieldId>,
    pub scale: TimelineScale,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimelineScale {
    Day,
    #[default]
    Week,
    Month,
    Quarter,
    Year,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FormConfig {
    pub title: String,
    pub description: String,
    pub fields: Vec<FormField>,
    pub submit_label: String,
    pub success_message: String,
    /// Only http(s) URLs are accepted.
    pub redirect_url: Option<String>,
    pub show_submit_another: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FormField {
    pub field_id: FieldId,
    #[serde(default)]
    pub required: bool,
    /// Label override.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub help: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViewConfig {
    pub filter: Option<Filter>,
    pub sorts: Vec<Sort>,
    /// Up to 3 levels.
    pub groups: Vec<Sort>,
    pub hidden_fields: Vec<FieldId>,
    /// Display order; fields not listed follow in table order.
    pub field_order: Vec<FieldId>,
    pub field_widths: BTreeMap<FieldId, u32>,
    /// Number of frozen columns after the primary field (grid).
    pub frozen_columns: u32,
    pub row_height: RowHeight,
    pub row_color: Option<RowColor>,
    /// Summary bar aggregations (grid).
    pub summaries: BTreeMap<FieldId, Aggregation>,
    /// Wrap long cell content (grid).
    pub wrap_headers: bool,
    pub kanban: KanbanConfig,
    pub calendar: CalendarConfig,
    pub gallery: GalleryConfig,
    pub timeline: TimelineConfig,
    pub form: FormConfig,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nested_filter_round_trips() {
        let json = serde_json::json!({
            "conjunction": "or",
            "items": [
                {"field_id": "fld1", "op": "contains", "value": "x"},
                {"conjunction": "and", "items": [
                    {"field_id": "fld2", "op": "gt", "value": 3},
                    {"field_id": "fld3", "op": "is_within", "value": {"mode": "past_number_of_days", "days": 7}}
                ]}
            ]
        });
        let f: Filter = serde_json::from_value(json.clone()).unwrap();
        assert!(matches!(f.items[1], FilterItem::Group(_)));
        assert_eq!(serde_json::to_value(&f).unwrap(), json);
    }

    #[test]
    fn empty_config_parses() {
        let c: ViewConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c, ViewConfig::default());
    }
}
