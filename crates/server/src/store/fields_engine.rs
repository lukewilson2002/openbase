//! Integration points between the schema plane and the engines.
//!
//! The schema plane (`store::fields`, `store::field_kind`, `store::views`)
//! reaches the formula engine (`ob_core::formula`), the cell converter
//! (`ob_core::cell::convert`), the view-config validators
//! (`ob_core::query`) and the recompute engine
//! (`crate::engine::recompute`) only through this module.
//!
//! Formulas are stored with `{fldXXXX}` field-id references and shown to
//! clients with `{Field Name}` references: [`prepare_formula`] converts
//! display -> stored, [`display_formula`] converts stored -> display.
//!
//! Name resolution when a formula is saved: an exact field name wins, then a
//! case-insensitive match if it is unique, then a literal field id (so a
//! stored formula whose names were rewritten to ids still resolves).

use std::collections::{HashMap, HashSet};

use chrono::Utc;
use chrono_tz::Tz;
use ob_core::cell::{CellCtx, choices_needed_for_conversion, convert};
use ob_core::field::{Field, FieldKind, SelectChoice, TextOptions, default_choice_color};
use ob_core::formula::{self, FormulaError, TypeEnv};
use ob_core::ids;
use ob_core::limits;
use ob_core::query::{compile_filter, compile_row_color, validate_groups, validate_sorts};
use ob_core::value::ResultType;
use ob_core::view::{Condition, Filter, FilterItem, RowColor, ViewConfig};
use rusqlite::Transaction;
use serde_json::Value as Json;

use crate::engine::recompute;
use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::field_kind::element_result_type;
use crate::store::links::NameCache;
use crate::store::{comments, fields, markdown};

fn formula_error(e: FormulaError) -> AppError {
    AppError::bad_request(format!("Invalid formula: {e}"))
}

/// What a formula sees when it reads `field`: the static type of the value
/// `cell::to_value` / the recompute engine produces for it.
pub fn field_result_type(f: &Field) -> ResultType {
    use FieldKind as K;
    let text_list = || ResultType::Array(Box::new(ResultType::Text));
    match &f.kind {
        K::Text(_)
        | K::RichText(_)
        | K::Email(_)
        | K::Url(_)
        | K::Phone(_)
        | K::Barcode(_)
        | K::Button(_)
        | K::SingleSelect(_)
        | K::CreatedBy(_)
        | K::LastModifiedBy(_) => ResultType::Text,
        K::Number(_)
        | K::Currency(_)
        | K::Percent(_)
        | K::Duration(_)
        | K::Rating(_)
        | K::Autonumber(_)
        | K::Count(_) => ResultType::Number,
        K::Checkbox(_) => ResultType::Bool,
        K::Date(o) if o.include_time => ResultType::DateTime,
        K::Date(_) => ResultType::Date,
        K::CreatedTime(_) | K::LastModifiedTime(_) => ResultType::DateTime,
        K::MultipleSelect(_) | K::Link(_) | K::Attachment(_) => text_list(),
        K::User(o) if o.multiple => text_list(),
        K::User(_) => ResultType::Text,
        K::Formula(o) => o.result_type.clone(),
        K::Lookup(o) => o.result_type.clone(),
        K::Rollup(o) => o.result_type.clone(),
    }
}

struct Env<'a> {
    by_id: HashMap<&'a str, &'a Field>,
    values: Option<ResultType>,
}

impl<'a> Env<'a> {
    fn new(fields: &'a [Field], values: Option<ResultType>) -> Env<'a> {
        Env {
            by_id: fields.iter().map(|f| (f.id.as_str(), f)).collect(),
            values,
        }
    }
}

impl TypeEnv for Env<'_> {
    fn field_type(&self, field_id: &str) -> Option<ResultType> {
        self.by_id.get(field_id).map(|f| field_result_type(f))
    }
    fn values_type(&self) -> Option<ResultType> {
        self.values.clone()
    }
}

/// Field name -> id for formulas typed by users.
fn resolver(fields: &[Field]) -> impl Fn(&str) -> Option<String> + '_ {
    move |name: &str| {
        if let Some(f) = fields.iter().find(|f| f.name == name) {
            return Some(f.id.clone());
        }
        let lower = name.to_lowercase();
        let mut hits = fields.iter().filter(|f| f.name.to_lowercase() == lower);
        match (hits.next(), hits.next()) {
            (Some(f), None) => Some(f.id.clone()),
            (Some(_), Some(_)) => None, // ambiguous
            _ => fields.iter().find(|f| f.id == name).map(|f| f.id.clone()),
        }
    }
}

/// Parse and validate a formula typed by a user (`expression_display`, with
/// `{Field Name}` references resolved against `table_fields`), and return the
/// stored form (references rewritten to `{fldXXXX}` ids) together with the
/// inferred result type. Used for formula fields and button `url_formula`s.
/// Syntax and type errors are 400s carrying the formula error message and
/// position.
pub fn prepare_formula(
    table_fields: &[Field],
    expression_display: &str,
) -> AppResult<(String, ResultType)> {
    check_formula(table_fields, expression_display).map_err(formula_error)
}

/// [`prepare_formula`] with the structured error (message and position), for
/// the formula check endpoint.
pub fn check_formula(
    table_fields: &[Field],
    expression_display: &str,
) -> Result<(String, ResultType), FormulaError> {
    if expression_display.chars().count() > limits::MAX_FORMULA_LEN {
        return Err(FormulaError::new(format!(
            "formula is too long (max {} characters)",
            limits::MAX_FORMULA_LEN
        )));
    }
    let stored = formula::to_storage(expression_display, &resolver(table_fields))?;
    let parsed = formula::parse(&stored)?;
    let ty = formula::infer_type(&parsed, &Env::new(table_fields, None))?;
    Ok((stored, ty))
}

/// Parse and validate a rollup expression, a formula over the array `values`
/// holding the `target` field's values from linked records. Returns the stored
/// expression and its inferred result type. Rollups cannot read other fields
/// of their own table (the engine would have no dependency edge for them).
pub fn prepare_rollup(
    table_fields: &[Field],
    target: &Field,
    expression_display: &str,
) -> AppResult<(String, ResultType)> {
    let _ = table_fields;
    let parsed = formula::parse(expression_display).map_err(formula_error)?;
    if let Some(name) = formula::referenced_fields(&parsed).first() {
        return Err(AppError::bad_request(format!(
            "Invalid formula: a rollup can only use the linked values (values), not the field '{name}'"
        )));
    }
    let values = ResultType::Array(Box::new(element_result_type(target)));
    let env = Env::new(&[], Some(values));
    let ty = formula::infer_type(&parsed, &env).map_err(formula_error)?;
    Ok((expression_display.to_string(), ty))
}

/// Rewrite a stored expression (`{fldXXXX}` references) into display form
/// (`{Field Name}` references) using the table's current field names. Applied
/// to every formula, rollup and button expression sent to clients.
pub fn display_formula(stored: &str, table_fields: &[Field]) -> String {
    formula::to_display(stored, &|id: &str| {
        table_fields
            .iter()
            .find(|f| f.id == id)
            .map(|f| f.name.clone())
    })
}

/// Convert one stored cell from field `from` to field `to`, without link
/// names or a user timezone (see [`convert_column`] for the real path).
pub fn convert_value(from: &Field, to: &Field, stored: Option<&Json>) -> Option<Json> {
    convert(
        from,
        to,
        stored,
        &CellCtx::utc(Utc::now()),
        &ob_core::cell::NoNames,
    )
}

/// Convert every stored cell of `old.id` in `table_id` (live and trashed
/// records) to the new field definition. Links are rendered with the linked
/// records' primary text; trashed linked records are left out.
pub fn convert_column(tx: &Transaction, table_id: &str, old: &Field, new: &Field) -> AppResult<()> {
    let names = NameCache::new(tx, Tz::UTC);
    let ctx = CellCtx::utc(Utc::now());
    let from_link = matches!(old.kind, FieldKind::Link(_));
    let (from, unrich) = read_rich_as_plain(old, new);
    let to_rich =
        matches!(new.kind, FieldKind::RichText(_)) && !matches!(old.kind, FieldKind::RichText(_));
    fields::map_cells(tx, table_id, &old.id, |cell| {
        let converted = if from_link {
            let live = names.live_ids(cell);
            if live.is_empty() {
                return None;
            }
            let live = crate::store::links::ids_json(&live);
            convert(old, new, Some(&live), &ctx, &names)?
        } else {
            convert(&from, new, Some(&unrich(cell)), &ctx, &names)?
        };
        if !to_rich {
            return Some(converted);
        }
        // Plain text becomes Markdown that shows the same text.
        let md = comments::plain_to_markdown(converted.as_str()?);
        Some(Json::String(
            md.chars().take(limits::MAX_TEXT_CELL_LEN).collect(),
        ))
    })
}

/// Rich text is Markdown: when it becomes another type its cells are read as
/// the plain text they show (`markdown::to_plain`), as if `old` were
/// multiline Text. Returns the field to convert from and how to read a cell.
fn read_rich_as_plain(old: &Field, new: &Field) -> (Field, impl Fn(&Json) -> Json) {
    let unrich =
        matches!(old.kind, FieldKind::RichText(_)) && !matches!(new.kind, FieldKind::RichText(_));
    let from = if unrich {
        Field {
            kind: FieldKind::Text(TextOptions {
                multiline: true,
                default: None,
            }),
            ..old.clone()
        }
    } else {
        old.clone()
    };
    let read = move |cell: &Json| match cell.as_str() {
        Some(md) if unrich => Json::String(markdown::to_plain(md)),
        _ => cell.clone(),
    };
    (from, read)
}

/// Before a type change converts values into a select field, add the choices
/// the conversion needs (names found in the existing values) to `new`.
pub fn add_conversion_choices(
    tx: &Transaction,
    table_id: &str,
    old: &Field,
    new: &mut Field,
) -> AppResult<()> {
    if !matches!(
        new.kind,
        FieldKind::SingleSelect(_) | FieldKind::MultipleSelect(_)
    ) {
        return Ok(());
    }
    let path = format!("$.\"{}\"", old.id);
    let mut stmt = tx.prepare(
        "SELECT data FROM records
         WHERE table_id = ?1 AND json_type(data, ?2) IS NOT NULL",
    )?;
    let cells: Vec<Json> = stmt
        .query_map(rusqlite::params![table_id, path], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .filter_map(|raw| serde_json::from_str::<Json>(&raw).ok())
        .filter_map(|mut data| data.get_mut(&old.id).map(Json::take))
        .collect();
    let names = NameCache::new(tx, Tz::UTC);
    let (from, unrich) = read_rich_as_plain(old, new);
    let cells: Vec<Json> = cells.iter().map(unrich).collect();
    let needed = choices_needed_for_conversion(&from, new, cells.iter().map(Some), &names, Tz::UTC);
    if needed.is_empty() {
        return Ok(());
    }
    let choices = match &mut new.kind {
        FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => &mut o.choices,
        _ => return Ok(()),
    };
    for name in needed {
        if choices.len() >= limits::MAX_CHOICES_PER_FIELD {
            break;
        }
        let color = default_choice_color(&name, choices.len()).to_string();
        choices.push(SelectChoice {
            id: new_id(ids::CHOICE),
            name,
            color,
        });
    }
    Ok(())
}

/// Called inside the schema-changing transaction after fields were created,
/// changed, removed or restored: (re)materializes the computed fields among
/// `field_ids` and everything that depends on them, for every record
/// (including trashed ones), in `table_id` of `base_id`.
pub fn after_field_change(
    tx: &Transaction,
    base_id: &str,
    table_id: &str,
    field_ids: &[String],
) -> AppResult<()> {
    recompute::recompute_fields(tx, base_id, table_id, field_ids)?;
    Ok(())
}

// ------------------------------------------------------------ view configs

/// What the config being replaced already referred to, by location: a field
/// id in the filter, in the sorts, in the form, ... and each filter condition
/// as a whole (field, operator and operand).
///
/// A field can be deleted or change type after a view config was saved, and a
/// client sending its config back unchanged must not be rejected for that.
/// Only a reference found *in the same place* of the old config is forgiven,
/// and only when it no longer fits the table: a new or edited reference, or
/// one the old config made elsewhere, is validated in full. (A field the old
/// config merely hid does not excuse a new `contains` filter on it.)
#[derive(Debug, Clone, Default)]
pub struct Stale(HashSet<String>);

impl Stale {
    /// Nothing is forgiven.
    pub fn none() -> Stale {
        Stale::default()
    }

    /// The references of a saved config.
    pub fn of(config: &ViewConfig) -> Stale {
        let mut out = Stale::default();
        for s in &config.sorts {
            out.add("sort", &s.field_id);
        }
        for g in &config.groups {
            out.add("group", &g.field_id);
        }
        if let Some(filter) = &config.filter {
            out.add_filter(filter);
        }
        for id in &config.hidden_fields {
            out.add("hidden fields", id);
        }
        for id in &config.field_order {
            out.add("field order", id);
        }
        for id in config.field_widths.keys() {
            out.add("field widths", id);
        }
        for id in config.summaries.keys() {
            out.add("summaries", id);
        }
        match &config.row_color {
            Some(RowColor::BySelect { field_id }) => out.add("row color", field_id),
            Some(RowColor::ByConditions { rules }) => {
                for rule in rules {
                    out.add_filter(&rule.filter);
                }
            }
            None => {}
        }
        for (slot, id) in config_slots(config) {
            if let Some(id) = id {
                out.add(slot, id);
            }
        }
        for f in &config.form.fields {
            out.add("form", &f.field_id);
        }
        out
    }

    fn add(&mut self, slot: &str, id: &str) {
        self.0.insert(format!("{slot}\0{id}"));
    }

    fn add_filter(&mut self, filter: &Filter) {
        for item in &filter.items {
            match item {
                FilterItem::Condition(c) => {
                    self.add("filter", &c.field_id);
                    if let Some(key) = condition_key(c) {
                        self.0.insert(key);
                    }
                }
                FilterItem::Group(g) => self.add_filter(g),
            }
        }
    }

    /// Did the old config name `id` in this place (`what` is the label the
    /// validator uses: "sort", "filter", "form", "kanban stack field", ...)?
    pub fn field(&self, what: &str, id: &str) -> bool {
        self.0.contains(&format!("{what}\0{id}"))
    }

    fn condition(&self, c: &Condition) -> bool {
        condition_key(c).is_some_and(|k| self.0.contains(&k))
    }
}

fn condition_key(c: &Condition) -> Option<String> {
    serde_json::to_string(c)
        .ok()
        .map(|json| format!("condition\0{json}"))
}

/// The single-field slots of a config with the label the validator reports
/// them under.
pub fn config_slots(config: &ViewConfig) -> [(&'static str, Option<&String>); 10] {
    [
        ("kanban stack field", config.kanban.stack_field_id.as_ref()),
        ("kanban cover field", config.kanban.cover_field_id.as_ref()),
        ("description field", config.description_field_id.as_ref()),
        (
            "calendar date field",
            config.calendar.date_field_id.as_ref(),
        ),
        ("calendar end field", config.calendar.end_field_id.as_ref()),
        (
            "gallery cover field",
            config.gallery.cover_field_id.as_ref(),
        ),
        (
            "timeline start field",
            config.timeline.start_field_id.as_ref(),
        ),
        ("timeline end field", config.timeline.end_field_id.as_ref()),
        (
            "timeline group field",
            config.timeline.group_field_id.as_ref(),
        ),
        (
            "timeline dependency field",
            config.timeline.dependency_field_id.as_ref(),
        ),
    ]
}

/// Keep the conditions that still make sense: conditions on fields that no
/// longer exist are dropped, and so are conditions that `stale` says the old
/// config already held and that no longer fit their (changed) field type, so a
/// client sending an old config back unchanged is not rejected for them.
fn prune_filter(filter: &Filter, fields: &[Field], stale: &Stale) -> Filter {
    let mut items = Vec::new();
    for item in &filter.items {
        match item {
            FilterItem::Condition(c) => {
                if !fields.iter().any(|f| f.id == c.field_id) {
                    continue;
                }
                if stale.condition(c) {
                    let probe = Filter {
                        conjunction: filter.conjunction,
                        items: vec![item.clone()],
                    };
                    if compile_filter(&probe, fields).is_err() {
                        continue;
                    }
                }
                items.push(item.clone());
            }
            FilterItem::Group(g) => {
                let pruned = prune_filter(g, fields, stale);
                if !pruned.items.is_empty() {
                    items.push(FilterItem::Group(pruned));
                }
            }
        }
    }
    Filter {
        conjunction: filter.conjunction,
        items,
    }
}

fn prune_levels<T: Clone>(
    slot: &str,
    levels: &[T],
    field_id: fn(&T) -> &str,
    fields: &[Field],
    stale: &Stale,
    validate: fn(&[T], &[Field]) -> Result<(), String>,
) -> Vec<T> {
    levels
        .iter()
        .filter(|s| {
            let id = field_id(s);
            fields.iter().any(|f| f.id == id)
                && (!stale.field(slot, id) || validate(std::slice::from_ref(s), fields).is_ok())
        })
        .cloned()
        .collect()
}

fn bad(msg: String) -> AppError {
    AppError::bad_request(msg)
}

/// Check a view config against the field types of its table: operators that
/// do not apply to a field's type, operand shapes, sortable and groupable
/// fields and row colouring. Structural checks
/// (unknown field ids, limits) are done by the caller before this is invoked.
///
/// A saved config may still name fields that were deleted or changed type
/// afterwards (the server lets a client send those back unchanged, see
/// [`Stale`], the references of the config being replaced): references to
/// missing fields are ignored here, and so are stale references that no
/// longer fit their field's type. Everything else is validated.
pub fn validate_view_config_semantics(
    fields: &[Field],
    config: &ViewConfig,
    stale: &Stale,
) -> AppResult<()> {
    if let Some(filter) = &config.filter {
        let pruned = prune_filter(filter, fields, stale);
        compile_filter(&pruned, fields).map_err(bad)?;
    }
    let sorts = prune_levels(
        "sort",
        &config.sorts,
        |s| &s.field_id,
        fields,
        stale,
        validate_sorts,
    );
    validate_sorts(&sorts, fields).map_err(bad)?;
    let groups = prune_levels(
        "group",
        &config.groups,
        |g| &g.field_id,
        fields,
        stale,
        validate_groups,
    );
    validate_groups(&groups, fields).map_err(bad)?;
    match &config.row_color {
        Some(RowColor::BySelect { field_id }) => {
            if let Some(f) = fields.iter().find(|f| &f.id == field_id) {
                let probe = RowColor::BySelect {
                    field_id: field_id.clone(),
                };
                let ok = compile_row_color(&probe, fields);
                match ok {
                    Err(_) if stale.field("row color", &f.id) => {}
                    other => {
                        other.map_err(bad)?;
                    }
                }
            }
        }
        Some(RowColor::ByConditions { rules }) => {
            let pruned: Vec<_> = rules
                .iter()
                .map(|r| ob_core::view::ColorRule {
                    color: r.color.clone(),
                    filter: prune_filter(&r.filter, fields, stale),
                })
                .collect();
            compile_row_color(&RowColor::ByConditions { rules: pruned }, fields).map_err(bad)?;
        }
        None => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ob_core::field::{NumberOptions, SelectOptions, TextOptions};

    fn f(id: &str, name: &str, kind: FieldKind) -> Field {
        Field {
            id: id.into(),
            table_id: "tbl".into(),
            name: name.into(),
            description: None,
            kind,
        }
    }

    fn fields() -> Vec<Field> {
        vec![
            f("fldA", "Name", FieldKind::Text(TextOptions::default())),
            f("fldB", "Price", FieldKind::Number(NumberOptions::default())),
            f("fldC", "price", FieldKind::Number(NumberOptions::default())),
            f(
                "fldD",
                "Tags",
                FieldKind::MultipleSelect(SelectOptions::default()),
            ),
        ]
    }

    #[test]
    fn formulas_resolve_names_and_infer_types() {
        let fs = fields();
        let (stored, ty) = prepare_formula(&fs, "{Price} * 2").unwrap();
        assert_eq!(stored, "{fldB} * 2");
        assert_eq!(ty, ResultType::Number);
        // exact case wins over the case-insensitive match
        let (stored, _) = prepare_formula(&fs, "{price} + 1").unwrap();
        assert_eq!(stored, "{fldC} + 1");
        // case-insensitive when unique
        let (stored, ty) = prepare_formula(&fs, "{name} & \"!\"").unwrap();
        assert_eq!(stored, "{fldA} & \"!\"");
        assert_eq!(ty, ResultType::Text);
        // a literal id
        assert_eq!(prepare_formula(&fs, "{fldB}").unwrap().0, "{fldB}");
        // arrays
        let (_, ty) = prepare_formula(&fs, "{Tags}").unwrap();
        assert_eq!(ty, ResultType::Array(Box::new(ResultType::Text)));
    }

    #[test]
    fn formula_errors_are_400_with_position() {
        let fs = fields();
        for bad in ["{Nope} + 1", "1 +", "FOO(1)", "SUM(values)", "{Price"] {
            let e = prepare_formula(&fs, bad).unwrap_err();
            assert!(matches!(e, AppError::BadRequest(_)), "{bad}");
        }
        let AppError::BadRequest(m) = prepare_formula(&fs, "{Nope} + 1").unwrap_err() else {
            panic!()
        };
        assert!(m.contains("Nope") && m.contains("position"), "{m}");
    }

    #[test]
    fn rollups_type_over_the_target_and_reject_field_refs() {
        let fs = fields();
        let target = &fs[1];
        let (stored, ty) = prepare_rollup(&fs, target, "SUM(values)").unwrap();
        assert_eq!((stored.as_str(), ty), ("SUM(values)", ResultType::Number));
        let (_, ty) = prepare_rollup(&fs, &fs[0], "ARRAYJOIN(values, \", \")").unwrap();
        assert_eq!(ty, ResultType::Text);
        assert!(prepare_rollup(&fs, target, "SUM(values) + {Price}").is_err());
        assert!(prepare_rollup(&fs, target, "SUM(").is_err());
    }

    #[test]
    fn display_round_trip() {
        let fs = fields();
        let (stored, _) = prepare_formula(&fs, "{Price} * 2").unwrap();
        assert_eq!(display_formula(&stored, &fs), "{Price} * 2");
        // unknown ids stay as they are
        assert_eq!(display_formula("{fldGone} + 1", &fs), "{fldGone} + 1");
    }

    #[test]
    fn view_semantics_ignore_missing_fields() {
        let fs = fields();
        let config: ViewConfig = serde_json::from_value(serde_json::json!({
            "filter": { "items": [
                { "field_id": "fldGone", "op": "is", "value": 1 },
                { "field_id": "fldB", "op": "gt", "value": 3 }
            ] },
            "sorts": [ { "field_id": "fldGone" }, { "field_id": "fldB" } ]
        }))
        .unwrap();
        validate_view_config_semantics(&fs, &config, &Stale::none()).unwrap();
        // an operator that does not fit the type is rejected...
        let wrong: ViewConfig = serde_json::from_value(serde_json::json!({
            "filter": { "items": [ { "field_id": "fldB", "op": "contains", "value": "x" } ] }
        }))
        .unwrap();
        assert!(validate_view_config_semantics(&fs, &wrong, &Stale::none()).is_err());
        // ...unless the config being replaced already held exactly that condition
        validate_view_config_semantics(&fs, &wrong, &Stale::of(&wrong)).unwrap();
        // a field the old config merely mentioned elsewhere, or a changed operand, is not forgiven
        let hidden: ViewConfig =
            serde_json::from_value(serde_json::json!({ "hidden_fields": ["fldB"] })).unwrap();
        assert!(validate_view_config_semantics(&fs, &wrong, &Stale::of(&hidden)).is_err());
        let other: ViewConfig = serde_json::from_value(serde_json::json!({
            "filter": { "items": [ { "field_id": "fldB", "op": "contains", "value": "y" } ] }
        }))
        .unwrap();
        assert!(validate_view_config_semantics(&fs, &wrong, &Stale::of(&other)).is_err());
    }
}
