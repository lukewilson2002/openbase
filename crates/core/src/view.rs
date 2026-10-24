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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum Conjunction {
    #[default]
    And,
    Or,
}

/// A filter tree. Top level is a group; groups nest (the UI allows 2 levels).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Filter {
    #[serde(default)]
    pub conjunction: Conjunction,
    #[serde(default)]
    pub items: Vec<FilterItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(untagged)]
pub enum FilterItem {
    Condition(Condition),
    Group(Filter),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
/// viewer's timezone at query time: "today" is the calendar day in that zone
/// (the request's `timezone`, else the user's profile zone, else UTC), not the
/// server's or UTC's. `exact_date` is the day as written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    #[default]
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Sort {
    pub field_id: FieldId,
    #[serde(default)]
    pub direction: Direction,
}

/// One group level of a view: the field, the order of its groups and, for a
/// date field, how much time each group spans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Group {
    pub field_id: FieldId,
    #[serde(default)]
    pub direction: Direction,
    /// Date fields only (dates, created/modified times, date formulas and
    /// lookups): the period each group covers. Absent means day.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granularity: Option<DateGranularity>,
}

/// The period a date group level buckets its records by, in the field's
/// time zone (else the viewer's). Weeks start on Monday.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum DateGranularity {
    #[default]
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum RowHeight {
    #[default]
    Short,
    Medium,
    Tall,
    ExtraTall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum RowColor {
    /// Colour each row by the colour of its choice in a single select field.
    BySelect { field_id: FieldId },
    /// First matching rule wins.
    ByConditions { rules: Vec<ColorRule> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct ColorRule {
    pub color: String,
    pub filter: Filter,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct KanbanConfig {
    /// Single select, user (single) or checkbox field to stack by.
    pub stack_field_id: Option<FieldId>,
    pub cover_field_id: Option<FieldId>,
    pub hide_empty_stacks: bool,
    /// Stack (choice id / user id / "true"/"false"/"" for uncategorized) display order.
    pub stack_order: Vec<String>,
    /// Stacks left off the board in this view (same keys as `stack_order`); their cards stay in
    /// the table and are still found by search and filters.
    pub hidden_stacks: Vec<String>,
    /// Stacked by a person: a stack for every collaborator, even those without cards. Off: only
    /// the people who hold cards get one.
    pub show_all_people: bool,
    /// Most non-empty fields a card shows (absent = 6).
    pub card_field_limit: Option<u32>,
    /// Cover images fit inside their box (true) instead of cropping to fill it (false).
    pub cover_fit: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct CalendarConfig {
    pub date_field_id: Option<FieldId>,
    /// Optional end date for multi-day events.
    pub end_field_id: Option<FieldId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct GalleryConfig {
    pub cover_field_id: Option<FieldId>,
    /// Crop (true) or fit (false) cover images.
    pub cover_crop: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct ListConfig {
    /// Checkbox, single select or user (one person) field drawn at the start of every row and
    /// editable there: tick items off without opening them.
    pub prefix_field_id: Option<FieldId>,
    /// Link field whose records are in this same table: a record links to its parent, and the
    /// list nests it under that parent (sub-items). Only the first linked record counts as parent.
    pub parent_field_id: Option<FieldId>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct TimelineConfig {
    pub start_field_id: Option<FieldId>,
    pub end_field_id: Option<FieldId>,
    /// Optional swimlane grouping.
    pub group_field_id: Option<FieldId>,
    /// Optional link-to-self field drawn as dependency arrows (Gantt).
    pub dependency_field_id: Option<FieldId>,
    pub scale: TimelineScale,
    /// Width in pixels of the lane labels on the left, as dragged by its divider (80 to 480;
    /// absent = the default).
    pub label_width: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(default)]
pub struct ViewConfig {
    pub filter: Option<Filter>,
    pub sorts: Vec<Sort>,
    /// Up to 3 levels.
    pub groups: Vec<Group>,
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
    /// Text field read as each record's description, under its title: a
    /// clamped excerpt on kanban, gallery and list cards (and left out of
    /// their label/value fields), the full text on hover there and on
    /// calendar events and timeline bars. Optional; any text field will do.
    pub description_field_id: Option<FieldId>,
    pub kanban: KanbanConfig,
    pub calendar: CalendarConfig,
    pub gallery: GalleryConfig,
    pub list: ListConfig,
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
