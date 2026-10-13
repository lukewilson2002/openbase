//! Filter compilation and evaluation, and row colouring (which reuses it).

use std::collections::HashSet;

use chrono::NaiveDate;
use serde_json::Value as Json;

use super::dates::{
    MAX_RELATIVE_DAYS, cell_day, is_range_mode, operand_days, parse_exact, resolve_day,
    resolve_range,
};
use super::{FieldLookup, Kind, QueryCtx, Row, is_cell_empty, kind_of};
use crate::cell::parse::parse_number;
use crate::cell::{NameResolver, display_text, to_value};
use crate::field::{COLORS, Field, FieldKind};
use crate::limits::{MAX_FILTER_CONDITIONS, MAX_FILTER_DEPTH};
use crate::value::Value;
use crate::view::{Conjunction, DateOperand, Filter, FilterItem, FilterOp, RowColor};

/// The special user operand meaning "the viewer".
const ME: &str = "me";

/// Operators available for a field (empty for buttons). The UI lists these.
pub fn filter_ops_for(field: &Field) -> Vec<FilterOp> {
    ops_for_kind(kind_of(field)).to_vec()
}

fn ops_for_kind(kind: Kind) -> &'static [FilterOp] {
    use FilterOp::*;
    match kind {
        Kind::Text => &[
            Contains,
            DoesNotContain,
            Is,
            IsNot,
            StartsWith,
            EndsWith,
            IsEmpty,
            IsNotEmpty,
        ],
        Kind::Number => &[Is, IsNot, Lt, Lte, Gt, Gte, IsEmpty, IsNotEmpty],
        Kind::Bool => &[Is],
        Kind::Select | Kind::User { multiple: false } => {
            &[Is, IsNot, IsAnyOf, IsNoneOf, IsEmpty, IsNotEmpty]
        }
        Kind::MultiSelect | Kind::User { multiple: true } => &[
            HasAnyOf, HasAllOf, HasNoneOf, IsExactly, IsEmpty, IsNotEmpty,
        ],
        Kind::Date => &[
            Is,
            IsNot,
            IsBefore,
            IsAfter,
            IsOnOrBefore,
            IsOnOrAfter,
            IsWithin,
            IsEmpty,
            IsNotEmpty,
        ],
        Kind::Attachment => &[Contains, DoesNotContain, IsEmpty, IsNotEmpty],
        Kind::Link | Kind::List => &[
            Contains,
            DoesNotContain,
            HasAnyOf,
            HasAllOf,
            HasNoneOf,
            IsExactly,
            IsEmpty,
            IsNotEmpty,
        ],
        Kind::Inert => &[],
    }
}

/// A validated filter ready to evaluate against many rows. Conditions with
/// an empty operand were dropped at compile time (they match everything, as
/// in Airtable), as were groups left empty.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledFilter {
    root: Group,
}

#[derive(Debug, Clone, PartialEq)]
struct Group {
    conjunction: Conjunction,
    items: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Cond(Box<Cond>),
    Group(Group),
}

#[derive(Debug, Clone, PartialEq)]
struct Cond {
    field: Field,
    test: Test,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum TextOp {
    Contains,
    DoesNotContain,
    StartsWith,
    EndsWith,
    Is,
    IsNot,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SetOp {
    HasAny,
    HasAll,
    HasNone,
    Exactly,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum DayOp {
    Is,
    IsNot,
    Before,
    After,
    OnOrBefore,
    OnOrAfter,
}

/// What a compiled condition checks. Needles for case-insensitive text ops
/// are stored lowercased.
#[derive(Debug, Clone, PartialEq)]
enum Test {
    Empty(bool),
    Text(TextOp, String),
    Number(FilterOp, f64),
    Bool(bool),
    /// Single-valued membership (select, single user): `negate` for
    /// is_not / is_none_of.
    OneOf {
        ids: Vec<String>,
        me: bool,
        negate: bool,
    },
    /// Multi-valued set comparison on ids (multi select, link, multi user).
    Set {
        op: SetOp,
        ids: Vec<String>,
        me: bool,
    },
    /// Substring search over item names (link names, attachment
    /// filenames, computed array elements).
    ItemText {
        negate: bool,
        needle: String,
    },
    /// Set comparison over computed array element texts.
    ItemSet {
        op: SetOp,
        items: Vec<String>,
    },
    Day(DayOp, DateOperand),
    Within(DateOperand),
}

impl CompiledFilter {
    /// A filter that matches every row.
    pub fn match_all() -> Self {
        CompiledFilter {
            root: Group {
                conjunction: Conjunction::And,
                items: Vec::new(),
            },
        }
    }

    /// True when the filter has no effective conditions.
    pub fn is_trivial(&self) -> bool {
        self.root.items.is_empty()
    }

    /// Ids of the fields the effective conditions read (sorted, unique).
    pub fn field_ids(&self) -> Vec<String> {
        fn walk(g: &Group, out: &mut Vec<String>) {
            for item in &g.items {
                match item {
                    Node::Cond(c) => out.push(c.field.id.clone()),
                    Node::Group(g) => walk(g, out),
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, &mut out);
        out.sort();
        out.dedup();
        out
    }
}

/// Validate and compile a view filter against the table's fields: every
/// field must exist, every operator must suit the field type (computed
/// fields by result type) and every operand must have the right shape;
/// nesting is limited to `limits::MAX_FILTER_DEPTH` levels (the top group is
/// level 1) and `limits::MAX_FILTER_CONDITIONS` conditions.
pub fn compile_filter<F: FieldLookup + ?Sized>(
    filter: &Filter,
    fields: &F,
) -> Result<CompiledFilter, String> {
    let mut count = 0;
    let root = compile_group(filter, fields, 1, &mut count)?.unwrap_or(Group {
        conjunction: filter.conjunction,
        items: Vec::new(),
    });
    Ok(CompiledFilter { root })
}

fn compile_group<F: FieldLookup + ?Sized>(
    filter: &Filter,
    fields: &F,
    depth: usize,
    count: &mut usize,
) -> Result<Option<Group>, String> {
    if depth > MAX_FILTER_DEPTH {
        return Err(format!(
            "filters can be nested at most {MAX_FILTER_DEPTH} levels deep"
        ));
    }
    let mut items = Vec::new();
    for item in &filter.items {
        match item {
            FilterItem::Condition(c) => {
                *count += 1;
                if *count > MAX_FILTER_CONDITIONS {
                    return Err(format!(
                        "filters can have at most {MAX_FILTER_CONDITIONS} conditions"
                    ));
                }
                let field = fields
                    .field(&c.field_id)
                    .ok_or_else(|| format!("filter refers to unknown field {}", c.field_id))?;
                if let Some(test) = compile_test(field, c.op, &c.value)? {
                    items.push(Node::Cond(Box::new(Cond {
                        field: field.clone(),
                        test,
                    })));
                }
            }
            FilterItem::Group(g) => {
                if let Some(group) = compile_group(g, fields, depth + 1, count)? {
                    items.push(Node::Group(group));
                }
            }
        }
    }
    Ok((!items.is_empty()).then_some(Group {
        conjunction: filter.conjunction,
        items,
    }))
}

fn op_name(op: FilterOp) -> String {
    serde_json::to_value(op)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{op:?}"))
}

/// Read a text operand. `None` = empty (condition ignored).
fn text_operand(field: &Field, v: &Json) -> Result<Option<String>, String> {
    match v {
        Json::Null => Ok(None),
        Json::String(s) if s.is_empty() => Ok(None),
        Json::String(s) => Ok(Some(s.clone())),
        Json::Number(n) => Ok(Some(n.to_string())),
        Json::Bool(b) => Ok(Some(b.to_string())),
        _ => Err(format!("filter on \"{}\" needs a text value", field.name)),
    }
}

/// Read an id-list operand (a string or array of strings). Empty → `None`.
fn ids_operand(field: &Field, v: &Json) -> Result<Option<Vec<String>>, String> {
    let bad = || format!("filter on \"{}\" needs an id or a list of ids", field.name);
    let ids: Vec<String> = match v {
        Json::Null => Vec::new(),
        Json::String(s) => vec![s.clone()],
        Json::Array(items) => items
            .iter()
            .map(|i| match i {
                Json::String(s) => Ok(s.clone()),
                _ => Err(bad()),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(bad()),
    };
    let ids: Vec<String> = ids.into_iter().filter(|s| !s.trim().is_empty()).collect();
    Ok((!ids.is_empty()).then_some(ids))
}

/// Split the "me" marker out of user ids.
fn split_me(ids: Vec<String>) -> (Vec<String>, bool) {
    let me = ids.iter().any(|i| i == ME);
    (ids.into_iter().filter(|i| i != ME).collect(), me)
}

fn date_operand(field: &Field, op: FilterOp, v: &Json) -> Result<Option<DateOperand>, String> {
    let operand = match v {
        Json::Null => return Ok(None),
        Json::String(s) if s.trim().is_empty() => return Ok(None),
        Json::String(s) => DateOperand::ExactDate { date: s.clone() },
        other => serde_json::from_value::<DateOperand>(other.clone())
            .map_err(|_| format!("filter on \"{}\" has an invalid date value", field.name))?,
    };
    if let DateOperand::ExactDate { date } = &operand {
        if date.trim().is_empty() {
            return Ok(None);
        }
        if parse_exact(date).is_none() {
            return Err(format!("\"{date}\" is not a valid date"));
        }
    }
    if operand_days(&operand).is_some_and(|d| d > MAX_RELATIVE_DAYS) {
        return Err(format!(
            "relative dates can be at most {MAX_RELATIVE_DAYS} days away"
        ));
    }
    let within = op == FilterOp::IsWithin;
    if within != is_range_mode(&operand) {
        return Err(if within {
            "\"is within\" needs a range such as past week or next number of days".to_string()
        } else {
            format!("\"{}\" needs a single day, not a range", op_name(op))
        });
    }
    Ok(Some(operand))
}

fn set_op(op: FilterOp) -> Option<SetOp> {
    match op {
        FilterOp::HasAnyOf => Some(SetOp::HasAny),
        FilterOp::HasAllOf => Some(SetOp::HasAll),
        FilterOp::HasNoneOf => Some(SetOp::HasNone),
        FilterOp::IsExactly => Some(SetOp::Exactly),
        _ => None,
    }
}

fn text_op(op: FilterOp) -> Option<TextOp> {
    match op {
        FilterOp::Contains => Some(TextOp::Contains),
        FilterOp::DoesNotContain => Some(TextOp::DoesNotContain),
        FilterOp::StartsWith => Some(TextOp::StartsWith),
        FilterOp::EndsWith => Some(TextOp::EndsWith),
        FilterOp::Is => Some(TextOp::Is),
        FilterOp::IsNot => Some(TextOp::IsNot),
        _ => None,
    }
}

/// Compile one condition. `Ok(None)` = empty operand (ignored).
fn compile_test(field: &Field, op: FilterOp, v: &Json) -> Result<Option<Test>, String> {
    let kind = kind_of(field);
    if !ops_for_kind(kind).contains(&op) {
        return Err(format!(
            "operator \"{}\" is not available for field \"{}\" ({})",
            op_name(op),
            field.name,
            field.field_type().label()
        ));
    }
    match op {
        FilterOp::IsEmpty => return Ok(Some(Test::Empty(true))),
        FilterOp::IsNotEmpty => return Ok(Some(Test::Empty(false))),
        _ => {}
    }
    let test = match kind {
        Kind::Text => {
            let Some(s) = text_operand(field, v)? else {
                return Ok(None);
            };
            let top = text_op(op).ok_or("unsupported text operator")?;
            let needle = if matches!(top, TextOp::Is | TextOp::IsNot) {
                s
            } else {
                s.to_lowercase()
            };
            Test::Text(top, needle)
        }
        Kind::Number => {
            let n = match v {
                Json::Null => return Ok(None),
                Json::String(s) if s.trim().is_empty() => return Ok(None),
                Json::Number(n) => n.as_f64(),
                Json::String(s) => parse_number(s, None).map(|p| p.value),
                _ => None,
            };
            let n = n.ok_or_else(|| format!("filter on \"{}\" needs a number", field.name))?;
            Test::Number(op, n)
        }
        Kind::Bool => match v {
            Json::Null => return Ok(None),
            Json::Bool(b) => Test::Bool(*b),
            Json::String(s) if s == "true" || s == "false" => Test::Bool(s == "true"),
            _ => return Err(format!("filter on \"{}\" needs true or false", field.name)),
        },
        Kind::Select | Kind::User { multiple: false } => {
            let Some(ids) = ids_operand(field, v)? else {
                return Ok(None);
            };
            if matches!(op, FilterOp::Is | FilterOp::IsNot) && ids.len() > 1 {
                return Err(format!(
                    "\"{}\" takes a single value; use \"is any of\"",
                    op_name(op)
                ));
            }
            let (ids, me) = if kind == Kind::Select {
                (ids, false)
            } else {
                split_me(ids)
            };
            Test::OneOf {
                ids,
                me,
                negate: matches!(op, FilterOp::IsNot | FilterOp::IsNoneOf),
            }
        }
        Kind::MultiSelect | Kind::User { multiple: true } | Kind::Link | Kind::List
            if set_op(op).is_some() =>
        {
            let sop = set_op(op).ok_or("unsupported operator")?;
            let Some(ids) = ids_operand(field, v)? else {
                return Ok(None);
            };
            match kind {
                Kind::List => Test::ItemSet {
                    op: sop,
                    items: ids,
                },
                Kind::User { .. } => {
                    let (ids, me) = split_me(ids);
                    Test::Set { op: sop, ids, me }
                }
                _ => Test::Set {
                    op: sop,
                    ids,
                    me: false,
                },
            }
        }
        Kind::Link | Kind::List | Kind::Attachment => {
            let Some(s) = text_operand(field, v)? else {
                return Ok(None);
            };
            Test::ItemText {
                negate: op == FilterOp::DoesNotContain,
                needle: s.to_lowercase(),
            }
        }
        Kind::Date => {
            let Some(operand) = date_operand(field, op, v)? else {
                return Ok(None);
            };
            match op {
                FilterOp::IsWithin => Test::Within(operand),
                FilterOp::Is => Test::Day(DayOp::Is, operand),
                FilterOp::IsNot => Test::Day(DayOp::IsNot, operand),
                FilterOp::IsBefore => Test::Day(DayOp::Before, operand),
                FilterOp::IsAfter => Test::Day(DayOp::After, operand),
                FilterOp::IsOnOrBefore => Test::Day(DayOp::OnOrBefore, operand),
                FilterOp::IsOnOrAfter => Test::Day(DayOp::OnOrAfter, operand),
                _ => return Err("unsupported date operator".into()),
            }
        }
        Kind::MultiSelect | Kind::User { multiple: true } | Kind::Inert => {
            return Err(format!(
                "operator \"{}\" is not supported here",
                op_name(op)
            ));
        }
    };
    Ok(Some(test))
}

/// Whether `row` passes the filter. Semantics follow Airtable: negative
/// operators (`is_not`, `does_not_contain`, `is_none_of`, `has_none_of`)
/// match empty cells; comparisons never match empty cells.
pub fn matches(
    f: &CompiledFilter,
    row: &dyn Row,
    ctx: &QueryCtx,
    names: &dyn NameResolver,
) -> bool {
    eval_group(&f.root, row, ctx, names)
}

fn eval_group(g: &Group, row: &dyn Row, ctx: &QueryCtx, names: &dyn NameResolver) -> bool {
    let mut results = g.items.iter().map(|item| match item {
        Node::Cond(c) => eval_cond(c, row, ctx, names),
        Node::Group(sub) => eval_group(sub, row, ctx, names),
    });
    match g.conjunction {
        Conjunction::And => results.all(|r| r),
        Conjunction::Or => g.items.is_empty() || results.any(|r| r),
    }
}

fn numbers_equal(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0)
}

fn cell_ids(stored: Option<&Json>) -> Vec<&str> {
    match stored {
        Some(j) => crate::cell::string_items(j).collect(),
        None => Vec::new(),
    }
}

fn set_matches<T: AsRef<str>>(op: SetOp, cell: &[&str], wanted: &[T]) -> bool {
    let has = |w: &T| cell.contains(&w.as_ref());
    match op {
        SetOp::HasAny => wanted.iter().any(has),
        SetOp::HasAll => wanted.iter().all(has),
        SetOp::HasNone => !wanted.iter().any(has),
        SetOp::Exactly => {
            let a: HashSet<&str> = cell.iter().copied().collect();
            let b: HashSet<&str> = wanted.iter().map(AsRef::as_ref).collect();
            a == b
        }
    }
}

fn with_me<'a>(ids: &'a [String], me: bool, ctx: &'a QueryCtx) -> Vec<&'a str> {
    let mut out: Vec<&str> = ids.iter().map(String::as_str).collect();
    if me {
        if let Some(u) = ctx.current_user_id.as_deref() {
            out.push(u);
        }
    }
    out
}

/// Texts of a multi-valued cell's items (link names, filenames, elements).
fn item_texts(
    field: &Field,
    stored: Option<&Json>,
    ctx: &QueryCtx,
    names: &dyn NameResolver,
) -> Vec<String> {
    match to_value(field, stored, names) {
        Value::Array(items) => items
            .iter()
            .map(|i| {
                crate::cell::value_text(
                    i,
                    &crate::cell::number_format_of(field),
                    crate::cell::date_options_of(field).as_ref(),
                    ctx.timezone,
                )
            })
            .collect(),
        Value::Null => Vec::new(),
        other => vec![crate::cell::value_text(
            &other,
            &crate::cell::number_format_of(field),
            None,
            ctx.timezone,
        )],
    }
}

fn eval_cond(c: &Cond, row: &dyn Row, ctx: &QueryCtx, names: &dyn NameResolver) -> bool {
    let field = &c.field;
    let stored = row.get(&field.id).filter(|j| !j.is_null());
    match &c.test {
        Test::Empty(want) => is_cell_empty(field, stored) == *want,
        Test::Text(op, needle) => {
            let hay = display_text(field, stored, names, ctx.timezone);
            match op {
                TextOp::Is => hay == *needle,
                TextOp::IsNot => hay != *needle,
                TextOp::Contains => hay.to_lowercase().contains(needle.as_str()),
                TextOp::DoesNotContain => !hay.to_lowercase().contains(needle.as_str()),
                TextOp::StartsWith => hay.to_lowercase().starts_with(needle.as_str()),
                TextOp::EndsWith => hay.to_lowercase().ends_with(needle.as_str()),
            }
        }
        Test::Number(op, n) => match to_value(field, stored, names) {
            Value::Number(v) => match op {
                FilterOp::Is => numbers_equal(v, *n),
                FilterOp::IsNot => !numbers_equal(v, *n),
                FilterOp::Lt => v < *n && !numbers_equal(v, *n),
                FilterOp::Lte => v < *n || numbers_equal(v, *n),
                FilterOp::Gt => v > *n && !numbers_equal(v, *n),
                FilterOp::Gte => v > *n || numbers_equal(v, *n),
                _ => false,
            },
            _ => *op == FilterOp::IsNot,
        },
        Test::Bool(want) => to_value(field, stored, names).truthy() == *want,
        Test::OneOf { ids, me, negate } => {
            let wanted = with_me(ids, *me, ctx);
            let hit = cell_ids(stored).iter().any(|id| wanted.contains(id));
            hit != *negate
        }
        Test::Set { op, ids, me } => {
            let wanted = with_me(ids, *me, ctx);
            if wanted.is_empty() {
                // "me" with no signed-in viewer: nothing can match except none-of.
                return *op == SetOp::HasNone
                    || (*op == SetOp::Exactly && cell_ids(stored).is_empty());
            }
            set_matches(*op, &cell_ids(stored), &wanted)
        }
        Test::ItemText { negate, needle } => {
            let hit = item_texts(field, stored, ctx, names)
                .iter()
                .any(|t| t.to_lowercase().contains(needle.as_str()));
            hit != *negate
        }
        Test::ItemSet { op, items } => {
            let texts = item_texts(field, stored, ctx, names);
            let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
            set_matches(*op, &refs, items)
        }
        Test::Day(op, operand) => {
            let today = ctx.now.with_timezone(&ctx.timezone).date_naive();
            let target = resolve_day(operand, today);
            let day = cell_day(field, stored, ctx.timezone);
            match (day, target) {
                (Some(d), Some(t)) => day_matches(*op, d, t),
                (None, _) => *op == DayOp::IsNot,
                (Some(_), None) => false,
            }
        }
        Test::Within(operand) => {
            let today = ctx.now.with_timezone(&ctx.timezone).date_naive();
            match (
                cell_day(field, stored, ctx.timezone),
                resolve_range(operand, today),
            ) {
                (Some(d), Some((start, end))) => start <= d && d <= end,
                _ => false,
            }
        }
    }
}

fn day_matches(op: DayOp, d: NaiveDate, t: NaiveDate) -> bool {
    match op {
        DayOp::Is => d == t,
        DayOp::IsNot => d != t,
        DayOp::Before => d < t,
        DayOp::After => d > t,
        DayOp::OnOrBefore => d <= t,
        DayOp::OnOrAfter => d >= t,
    }
}

/// A validated row colouring configuration.
#[derive(Debug, Clone, PartialEq)]
pub enum CompiledRowColor {
    /// Colour of the row's choice in this single select field.
    BySelect(Field),
    /// First matching rule's colour.
    ByConditions(Vec<(String, CompiledFilter)>),
}

/// Validate a row colouring config: the select field must exist and be a
/// single select; rule colours must come from [`COLORS`]; rule filters are
/// compiled like view filters.
pub fn compile_row_color<F: FieldLookup + ?Sized>(
    config: &RowColor,
    fields: &F,
) -> Result<CompiledRowColor, String> {
    match config {
        RowColor::BySelect { field_id } => {
            let field = fields
                .field(field_id)
                .ok_or_else(|| format!("row colour refers to unknown field {field_id}"))?;
            if !matches!(field.kind, FieldKind::SingleSelect(_)) {
                return Err(format!(
                    "rows can only be coloured by a single select field, not \"{}\"",
                    field.name
                ));
            }
            Ok(CompiledRowColor::BySelect(field.clone()))
        }
        RowColor::ByConditions { rules } => {
            if rules.len() > MAX_FILTER_CONDITIONS {
                return Err(format!(
                    "row colouring can have at most {MAX_FILTER_CONDITIONS} rules"
                ));
            }
            let compiled = rules
                .iter()
                .map(|r| {
                    if !COLORS.contains(&r.color.as_str()) {
                        return Err(format!("unknown colour \"{}\"", r.color));
                    }
                    Ok((r.color.clone(), compile_filter(&r.filter, fields)?))
                })
                .collect::<Result<_, String>>()?;
            Ok(CompiledRowColor::ByConditions(compiled))
        }
    }
}

/// The colour of a row under a compiled colouring config, if any.
pub fn row_color_compiled(
    config: &CompiledRowColor,
    row: &dyn Row,
    ctx: &QueryCtx,
    names: &dyn NameResolver,
) -> Option<String> {
    match config {
        CompiledRowColor::BySelect(field) => {
            let FieldKind::SingleSelect(o) = &field.kind else {
                return None;
            };
            let id = row.get(&field.id)?.as_str()?;
            o.choices
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.color.clone())
        }
        CompiledRowColor::ByConditions(rules) => rules
            .iter()
            .find(|(_, f)| matches(f, row, ctx, names))
            .map(|(color, _)| color.clone()),
    }
}

/// The colour of one row. Compiles `config` on every call; use
/// [`compile_row_color`] + [`row_color_compiled`] for many rows. An invalid
/// config colours nothing.
pub fn row_color<F: FieldLookup + ?Sized>(
    config: &RowColor,
    row: &dyn Row,
    fields: &F,
    ctx: &QueryCtx,
    names: &dyn NameResolver,
) -> Option<String> {
    let compiled = compile_row_color(config, fields).ok()?;
    row_color_compiled(&compiled, row, ctx, names)
}
