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
///
/// `Deserialize` is written by hand (see [`parse`]) so a request body cannot make the parser
/// copy its nested groups once per level; the derive's `untagged` buffering did exactly that.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct Filter {
    #[serde(default)]
    pub conjunction: Conjunction,
    #[serde(default)]
    pub items: Vec<FilterItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
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

mod parse {
    //! Streaming deserialization of [`Filter`] and [`FilterItem`].
    //!
    //! An item is a condition when it has a valid `field_id` and `op`, otherwise a group, and
    //! that is decided here from the object's own keys, in one pass. Depth and the number of
    //! items are counted as the input is read, so a hostile body is refused after a few
    //! levels or a few thousand items, not after the whole 4 MiB has been built up.

    use std::cell::Cell;
    use std::fmt;

    use serde::de::{self, Deserializer, IgnoredAny, MapAccess, Visitor};

    use super::{Condition, Conjunction, Filter, FilterItem, Json};

    /// Levels of objects the parser accepts (a condition is one, like a group), above the 3 a filter may use
    /// (`limits::MAX_FILTER_DEPTH`, checked when the filter is compiled), so a stored view that
    /// is over that limit still loads, and can be edited back under it.
    const PARSE_MAX_DEPTH: usize = 8;
    /// Items (conditions and groups) in one filter, over the limit of
    /// `limits::MAX_FILTER_CONDITIONS` conditions for the same reason.
    const PARSE_MAX_ITEMS: usize = 5_000;

    thread_local! {
        // The limits are per filter, and `Deserialize` has nowhere to carry state, so the
        // counts live here. Deserialization is synchronous and never yields, and the
        // guard resets them when the outermost filter finishes, error or not.
        static STATE: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
    }

    struct Guard;

    impl Guard {
        fn enter<E: de::Error>() -> Result<Guard, E> {
            let (depth, items) = STATE.get();
            if depth >= PARSE_MAX_DEPTH {
                return Err(E::custom(format!(
                    "filters can be nested at most {PARSE_MAX_DEPTH} levels deep"
                )));
            }
            STATE.set((depth + 1, items));
            Ok(Guard)
        }
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            let (depth, items) = STATE.get();
            STATE.set((depth - 1, if depth == 1 { 0 } else { items }));
        }
    }

    fn count_item<E: de::Error>() -> Result<(), E> {
        let (depth, items) = STATE.get();
        if items >= PARSE_MAX_ITEMS {
            return Err(E::custom(format!(
                "filters can have at most {PARSE_MAX_ITEMS} conditions and groups"
            )));
        }
        STATE.set((depth, items + 1));
        Ok(())
    }

    /// Read the keys of a filter object. Returns the parts either shape could use.
    fn read_object<'de, A: MapAccess<'de>>(mut map: A) -> Result<Object, A::Error> {
        let _guard = Guard::enter()?;
        let mut o = Object::default();
        while let Some(key) = map.next_key::<String>()? {
            match key.as_str() {
                // Small values are held as JSON so that a malformed one can fall through to the
                // other shape exactly as the untagged derive did.
                "field_id" => o.field_id = Some(map.next_value()?),
                "op" => o.op = Some(map.next_value()?),
                "value" => o.value = Some(map.next_value()?),
                "conjunction" => o.conjunction = Some(map.next_value()?),
                "items" => o.items = Some(map.next_value::<Items>()?.0),
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(o)
    }

    #[derive(Default)]
    struct Object {
        field_id: Option<Json>,
        op: Option<Json>,
        value: Option<Json>,
        conjunction: Option<Json>,
        items: Option<Vec<FilterItem>>,
    }

    impl Object {
        fn into_group<E: de::Error>(self) -> Result<Filter, E> {
            let conjunction = match self.conjunction {
                Some(j) => serde_json::from_value::<Conjunction>(j).map_err(E::custom)?,
                None => Conjunction::default(),
            };
            Ok(Filter {
                conjunction,
                items: self.items.unwrap_or_default(),
            })
        }
    }

    struct Items(Vec<FilterItem>);

    impl<'de> de::Deserialize<'de> for Items {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Items;
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("a list of filter items")
                }
                fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Items, A::Error> {
                    // No `size_hint` allocation: the list grows as items really arrive.
                    let mut out = Vec::new();
                    while let Some(item) = seq.next_element::<FilterItem>()? {
                        out.push(item);
                    }
                    Ok(Items(out))
                }
            }
            d.deserialize_seq(V)
        }
    }

    impl<'de> de::Deserialize<'de> for Filter {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = Filter;
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("a filter group")
                }
                fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Filter, A::Error> {
                    read_object(map)?.into_group()
                }
            }
            d.deserialize_map(V)
        }
    }

    impl<'de> de::Deserialize<'de> for FilterItem {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = FilterItem;
                fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                    f.write_str("a filter condition or group")
                }
                fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<FilterItem, A::Error> {
                    count_item()?;
                    let o = read_object(map)?;
                    let condition = match (&o.field_id, &o.op) {
                        (Some(f), Some(op)) => serde_json::from_value(f.clone())
                            .ok()
                            .zip(serde_json::from_value(op.clone()).ok()),
                        _ => None,
                    };
                    match condition {
                        Some((field_id, op)) => Ok(FilterItem::Condition(Condition {
                            field_id,
                            op,
                            value: o.value.unwrap_or_default(),
                        })),
                        None => o.into_group().map(FilterItem::Group),
                    }
                }
            }
            d.deserialize_map(V)
        }
    }
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
    // weeks start on the viewer's week start (request, else profile, else Sunday)
    ThisCalendarWeek,
    NextCalendarWeek,
    LastCalendarWeek,
    NextCalendarMonth,
    LastCalendarMonth,
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
    /// People who get a notification (and an email when the server can send mail) for every
    /// response that comes in through the form's public link. Project members only.
    pub notify_user_ids: Vec<String>,
}

/// What a layout entry of a form is, in place of a question.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
#[serde(rename_all = "snake_case")]
pub enum FormBlock {
    /// A section heading: `label` is its text.
    Heading,
    /// A paragraph of explanatory text: `help` is its text.
    Text,
}

/// One entry of a form: a question about a table field, or (with `block`) a heading or a
/// paragraph between questions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct FormField {
    /// The table field asked for. A block has an id of its own (`blk...`, made when the form is
    /// saved if it is left out) that no field uses.
    #[serde(default)]
    pub field_id: FieldId,
    #[serde(default)]
    pub required: bool,
    /// Label override.
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub help: Option<String>,
    /// Show this entry only when the answers given so far (the entries above it) meet the
    /// condition; otherwise it is left out, its answer is ignored and it is not required.
    #[serde(default)]
    pub show_if: Option<Filter>,
    /// Set for a heading or a paragraph of text instead of a question.
    #[serde(default)]
    pub block: Option<FormBlock>,
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

    /// The derive this file used to have, kept as the reference for what old stored JSON means.
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OldItem {
        Condition(Condition),
        Group(OldFilter),
    }

    #[derive(Deserialize)]
    struct OldFilter {
        #[serde(default)]
        conjunction: Conjunction,
        #[serde(default)]
        items: Vec<OldItem>,
    }

    impl OldFilter {
        fn convert(self) -> Filter {
            Filter {
                conjunction: self.conjunction,
                items: self
                    .items
                    .into_iter()
                    .map(|i| match i {
                        OldItem::Condition(c) => FilterItem::Condition(c),
                        OldItem::Group(g) => FilterItem::Group(g.convert()),
                    })
                    .collect(),
            }
        }
    }

    #[test]
    fn filter_parses_as_the_untagged_derive_did() {
        use serde_json::json;
        let corpus = [
            json!({}),
            json!({"items": []}),
            json!({"conjunction": "or"}),
            json!({"items": [{}]}),
            json!({"items": [{"field_id": "f", "op": "is_empty"}]}),
            json!({"items": [{"field_id": "f", "op": "is", "value": null, "extra": [1, {"a": 2}]}]}),
            // a condition whose op is unknown has always loaded as an empty group
            json!({"items": [{"field_id": "f", "op": "nonsense", "value": 1}]}),
            json!({"items": [{"op": "is", "value": 1}]}),
            json!({"conjunction": "or", "items": [
                {"field_id": "f", "op": "has_any_of", "value": ["a", "b"]},
                {"conjunction": "and", "items": [
                    {"field_id": "g", "op": "is_within", "value": {"mode": "past_week"}},
                    {"items": [{"field_id": "h", "op": "gt", "value": 2.5}]}
                ]},
                {"unknown": true}
            ]}),
        ];
        for json in corpus {
            let old: OldFilter = serde_json::from_value(json.clone()).unwrap();
            let new: Filter = serde_json::from_value(json.clone()).unwrap();
            assert_eq!(new, old.convert(), "{json}");
            let from_str: Filter = serde_json::from_str(&json.to_string()).unwrap();
            assert_eq!(from_str, new, "{json}");
        }
        // The same errors as before for an item that is neither.
        for bad in [
            json!({"conjunction": "xor"}),
            json!({"items": [{"conjunction": 3}]}),
            json!({"items": {}}),
            json!({"items": [1]}),
        ] {
            assert!(serde_json::from_value::<OldFilter>(bad.clone()).is_err());
            assert!(
                serde_json::from_value::<Filter>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    fn nested_body(levels: usize, leaf: &str) -> String {
        format!(
            "{}{leaf}{}",
            r#"{"items":["#.repeat(levels),
            "]}".repeat(levels)
        )
    }

    #[test]
    fn deep_filters_are_refused_while_parsing() {
        // A stored filter a little over the compile-time limit still loads.
        let ok = nested_body(PARSE_DEPTH_OK, r#"{"field_id":"f","op":"is_empty"}"#);
        assert!(serde_json::from_str::<Filter>(&ok).is_ok());
        // The shape F2 describes: dozens of levels around one huge junk value. Refused at the
        // depth limit, without the junk ever being copied per level.
        let junk = format!(r#"{{"x":[{}0]}}"#, "0,".repeat(1_000_000));
        let bomb = nested_body(60, &junk);
        let started = std::time::Instant::now();
        let e = serde_json::from_str::<Filter>(&bomb)
            .unwrap_err()
            .to_string();
        assert!(e.contains("nested at most"), "{e}");
        assert!(started.elapsed().as_secs() < 2);
        // The limit is per filter: a failed parse leaves nothing behind for the next one.
        assert!(serde_json::from_str::<Filter>(&ok).is_ok());
    }

    /// Groups; the condition inside the innermost one is a level of its own.
    const PARSE_DEPTH_OK: usize = 7;

    #[test]
    fn filters_with_too_many_items_are_refused_while_parsing() {
        let item = r#"{"field_id":"f","op":"is_empty"}"#;
        let many = |n: usize| format!(r#"{{"items":[{}]}}"#, vec![item; n].join(","));
        assert!(serde_json::from_str::<Filter>(&many(5_000)).is_ok());
        let e = serde_json::from_str::<Filter>(&many(5_001))
            .unwrap_err()
            .to_string();
        assert!(e.contains("at most"), "{e}");
        // Empty groups count too: a body of `{}` repeated is the cheapest way to make nodes.
        let groups = format!(r#"{{"items":[{}]}}"#, vec!["{}"; 100_000].join(","));
        assert!(serde_json::from_str::<Filter>(&groups).is_err());
        assert!(serde_json::from_str::<Filter>(&many(10)).is_ok());
    }

    #[test]
    fn empty_config_parses() {
        let c: ViewConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(c, ViewConfig::default());
    }
}
