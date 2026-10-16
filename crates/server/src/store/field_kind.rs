//! Validation and normalization of field definitions.
//!
//! [`normalize_kind`] takes the options a client sent for a field and returns
//! the options to store: select choices get ids and colours, formulas are
//! converted to stored form with their inferred result type, lookup result
//! types are derived from their target, and every reference (linked table,
//! link field, lookup target, picker view, watched fields) is checked.
//! Link pairing (creating the inverse field) is not done here; see `fields`.

use std::collections::HashSet;

use ob_core::api::schema::{CreateField, UpdateField};
use ob_core::field::{
    DateOptions, Field, FieldKind, LastModifiedOptions, LinkOptions, SelectOptions, ValueFormat,
    default_choice_color,
};
use ob_core::limits;
use ob_core::value::ResultType;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{Map, Value as Json};

use crate::error::{AppError, AppResult};
use crate::ids::new_id;
use crate::store::fields_engine;
use crate::store::schema::{self, TableRow};

/// Highest number of decimal places a number-like field may show.
pub const MAX_PRECISION: u8 = 8;
const MAX_ICON_LEN: usize = 32;
const MAX_SYMBOL_LEN: usize = 8;
const MAX_BUTTON_LABEL_LEN: usize = 100;

/// Where a field definition lives while it is validated.
pub struct KindCtx<'a> {
    pub conn: &'a Connection,
    pub table: &'a TableRow,
    /// Live fields of the table (include the field being updated).
    pub siblings: &'a [Field],
    /// Id of the field being created or updated.
    pub field_id: &'a str,
    /// The field's current definition when updating. References it already
    /// held to things that have since been deleted are dropped rather than
    /// rejected, so a client sending its options back unchanged still works.
    pub previous: Option<&'a FieldKind>,
}

/// Validate `kind` and return the normalized options to store.
pub fn normalize_kind(ctx: &KindCtx, mut kind: FieldKind) -> AppResult<FieldKind> {
    match &mut kind {
        FieldKind::SingleLineText(o) => {
            if o.default.as_deref().map_or(0, |d| d.chars().count()) > limits::MAX_TEXT_CELL_LEN {
                return Err(AppError::bad_request("default text is too long"));
            }
        }
        FieldKind::Number(o) | FieldKind::Percent(o) => {
            check_precision(o.precision)?;
            if o.default.is_some_and(|d| !d.is_finite()) {
                return Err(AppError::bad_request("default must be a finite number"));
            }
        }
        FieldKind::Currency(o) => {
            check_precision(o.precision)?;
            check_short_text(&o.symbol, MAX_SYMBOL_LEN, "currency symbol")?;
        }
        FieldKind::Rating(o) => {
            if !(1..=10).contains(&o.max) {
                return Err(AppError::bad_request("rating max must be between 1 and 10"));
            }
            check_short_text(&o.icon, MAX_ICON_LEN, "rating icon")?;
            schema::validate_color(&o.color)?;
        }
        FieldKind::Checkbox(o) => {
            check_short_text(&o.icon, MAX_ICON_LEN, "checkbox icon")?;
            schema::validate_color(&o.color)?;
        }
        FieldKind::SingleSelect(o) | FieldKind::MultipleSelect(o) => normalize_choices(o)?,
        FieldKind::Date(o) | FieldKind::CreatedTime(o) => check_date_options(o)?,
        FieldKind::LastModifiedTime(o) | FieldKind::LastModifiedBy(o) => {
            check_last_modified(ctx, o)?
        }
        FieldKind::Link(o) => check_link(ctx, o)?,
        FieldKind::Formula(o) => {
            check_expression(&o.expression)?;
            let (stored, result_type) =
                fields_engine::prepare_formula(ctx.siblings, &o.expression)?;
            o.expression = stored;
            o.result_type = result_type;
            check_value_format(o.format.as_ref())?;
        }
        FieldKind::Lookup(o) => {
            let target = check_link_and_target(ctx, &o.link_field_id, &o.target_field_id)?;
            o.result_type = lookup_result_type(&target);
        }
        FieldKind::Rollup(o) => {
            let target = check_link_and_target(ctx, &o.link_field_id, &o.target_field_id)?;
            check_expression(&o.expression)?;
            let (stored, result_type) =
                fields_engine::prepare_rollup(ctx.siblings, &target, &o.expression)?;
            o.expression = stored;
            o.result_type = result_type;
            check_value_format(o.format.as_ref())?;
        }
        FieldKind::Count(o) => {
            find_link_field(ctx, &o.link_field_id)?;
        }
        FieldKind::Button(o) => {
            o.label = o.label.trim().to_string();
            if o.label.is_empty() {
                return Err(AppError::bad_request("button label cannot be empty"));
            }
            check_short_text(&o.label, MAX_BUTTON_LABEL_LEN, "button label")?;
            check_expression(&o.url_formula)?;
            let (stored, _) = fields_engine::prepare_formula(ctx.siblings, &o.url_formula)?;
            o.url_formula = stored;
        }
        FieldKind::LongText(_)
        | FieldKind::Duration(_)
        | FieldKind::User(_)
        | FieldKind::Email(_)
        | FieldKind::Url(_)
        | FieldKind::Phone(_)
        | FieldKind::Attachment(_)
        | FieldKind::CreatedBy(_)
        | FieldKind::Autonumber(_)
        | FieldKind::Barcode(_) => {}
    }
    Ok(kind)
}

fn check_precision(precision: u8) -> AppResult<()> {
    if precision > MAX_PRECISION {
        return Err(AppError::bad_request(format!(
            "precision cannot exceed {MAX_PRECISION} decimal places"
        )));
    }
    Ok(())
}

fn check_short_text(text: &str, max: usize, what: &str) -> AppResult<()> {
    if text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(AppError::bad_request(format!(
            "{what} must be at most {max} characters"
        )));
    }
    Ok(())
}

fn check_expression(expression: &str) -> AppResult<()> {
    if expression.chars().count() > limits::MAX_FORMULA_LEN {
        return Err(AppError::bad_request(format!(
            "formula is too long (max {} characters)",
            limits::MAX_FORMULA_LEN
        )));
    }
    Ok(())
}

fn check_date_options(o: &DateOptions) -> AppResult<()> {
    if let Some(tz) = &o.timezone {
        tz.parse::<chrono_tz::Tz>()
            .map_err(|_| AppError::bad_request(format!("unknown timezone '{tz}'")))?;
    }
    Ok(())
}

fn check_value_format(format: Option<&ValueFormat>) -> AppResult<()> {
    match format {
        Some(ValueFormat::Number { precision })
        | Some(ValueFormat::Currency { precision, .. })
        | Some(ValueFormat::Percent { precision }) => check_precision(*precision),
        Some(ValueFormat::Date(d)) => check_date_options(d),
        Some(ValueFormat::Duration { .. }) | None => Ok(()),
    }
}

fn normalize_choices(o: &mut SelectOptions) -> AppResult<()> {
    if o.choices.len() > limits::MAX_CHOICES_PER_FIELD {
        return Err(AppError::bad_request(format!(
            "a select field can have at most {} choices",
            limits::MAX_CHOICES_PER_FIELD
        )));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for (i, c) in o.choices.iter_mut().enumerate() {
        c.name = schema::validate_name(&c.name, "choice")?;
        if !names.insert(schema::name_key(&c.name)) {
            return Err(AppError::bad_request(format!(
                "duplicate choice name '{}'",
                c.name
            )));
        }
        if c.color.is_empty() {
            c.color = default_choice_color(&c.name, i).to_string();
        } else {
            schema::validate_color(&c.color)?;
        }
        c.id = c.id.trim().to_string();
        if c.id.is_empty() {
            c.id = new_id(ob_core::ids::CHOICE);
        } else if c.id.len() > 64
            || !c
                .id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return Err(AppError::bad_request("invalid choice id"));
        }
        if !ids.insert(c.id.clone()) {
            return Err(AppError::bad_request("duplicate choice id"));
        }
    }
    Ok(())
}

fn check_last_modified(ctx: &KindCtx, o: &mut LastModifiedOptions) -> AppResult<()> {
    check_date_options(&o.date)?;
    let mut seen = HashSet::new();
    o.fields.retain(|f| seen.insert(f.clone()));
    let previously_watched = |id: &str| match ctx.previous {
        Some(FieldKind::LastModifiedTime(p) | FieldKind::LastModifiedBy(p)) => {
            p.fields.iter().any(|f| f == id)
        }
        _ => false,
    };
    let mut gone = Vec::new();
    for id in &o.fields {
        let Some(f) = ctx.siblings.iter().find(|f| &f.id == id) else {
            if previously_watched(id) {
                gone.push(id.clone()); // deleted since: stop watching it
                continue;
            }
            return Err(AppError::bad_request(format!(
                "watched field '{id}' is not in this table"
            )));
        };
        if f.field_type().is_computed() || f.id == ctx.field_id {
            return Err(AppError::bad_request(format!(
                "watched field '{}' must be an editable field",
                f.name
            )));
        }
    }
    o.fields.retain(|id| !gone.contains(id));
    Ok(())
}

fn check_link(ctx: &KindCtx, o: &mut LinkOptions) -> AppResult<()> {
    let target = schema::table_any(ctx.conn, &o.linked_table_id)?
        .filter(|t| t.deleted_at.is_none())
        .ok_or_else(|| AppError::bad_request("linked table not found"))?;
    if target.base_id != ctx.table.base_id {
        return Err(AppError::bad_request(
            "a link field can only link to a table in the same base",
        ));
    }
    if let Some(view_id) = o.picker_view_id.clone() {
        let ok: Option<i64> = ctx
            .conn
            .query_row(
                "SELECT 1 FROM views WHERE id = ?1 AND table_id = ?2 AND deleted_at IS NULL
                 AND personal_owner_id IS NULL",
                [&view_id, &target.id],
                |r| r.get(0),
            )
            .optional()?;
        if ok.is_none() {
            let unchanged = matches!(
                ctx.previous,
                Some(FieldKind::Link(p)) if p.picker_view_id.as_deref() == Some(view_id.as_str())
            );
            if !unchanged {
                return Err(AppError::bad_request(
                    "picker view must be a shared view of the linked table",
                ));
            }
            // The view it pointed at was deleted: the picker falls back to all records.
            o.picker_view_id = None;
        }
    }
    Ok(())
}

/// The link field `link_field_id` of this table, as a [`Field`] with its options.
fn find_link_field<'a>(ctx: &'a KindCtx, link_field_id: &str) -> AppResult<(&'a Field, String)> {
    let found = ctx
        .siblings
        .iter()
        .find(|f| f.id == link_field_id && f.id != ctx.field_id);
    match found.map(|f| (f, &f.kind)) {
        Some((f, FieldKind::Link(l))) => Ok((f, l.linked_table_id.clone())),
        _ => Err(AppError::bad_request(
            "link_field_id must be a link field in this table",
        )),
    }
}

fn check_link_and_target(ctx: &KindCtx, link_field_id: &str, target_id: &str) -> AppResult<Field> {
    let (_, linked_table_id) = find_link_field(ctx, link_field_id)?;
    let target = schema::live_field(ctx.conn, target_id)
        .map_err(|_| AppError::bad_request("target field not found"))?
        .field;
    if target.table_id != linked_table_id {
        return Err(AppError::bad_request(
            "target field must be in the linked table",
        ));
    }
    Ok(target)
}

// ----------------------------------------------------------- result types

/// Type of one value of `f` as it appears inside a lookup/rollup array.
pub fn element_result_type(f: &Field) -> ResultType {
    use FieldKind as K;
    fn scalar(t: &ResultType) -> ResultType {
        match t {
            ResultType::Array(inner) => scalar(inner),
            other => other.clone(),
        }
    }
    match &f.kind {
        K::Number(_)
        | K::Currency(_)
        | K::Percent(_)
        | K::Duration(_)
        | K::Rating(_)
        | K::Count(_)
        | K::Autonumber(_) => ResultType::Number,
        K::Checkbox(_) => ResultType::Bool,
        K::Date(o) if o.include_time => ResultType::DateTime,
        K::Date(_) => ResultType::Date,
        K::CreatedTime(_) | K::LastModifiedTime(_) => ResultType::DateTime,
        K::Formula(o) => scalar(&o.result_type),
        K::Lookup(o) => scalar(&o.result_type),
        K::Rollup(o) => scalar(&o.result_type),
        _ => ResultType::Text,
    }
}

/// Result type of a lookup of `target`: always an array of the target's type.
pub fn lookup_result_type(target: &Field) -> ResultType {
    ResultType::Array(Box::new(element_result_type(target)))
}

// ------------------------------------------------------------ JSON bodies

/// Select choices may omit `id` and `color` on the wire: fill in blanks so the
/// strict DTOs parse; [`normalize_kind`] then generates real ids and colours.
pub fn fill_choice_defaults(kind_json: &mut Json) {
    let Some(choices) = kind_json
        .pointer_mut("/options/choices")
        .and_then(Json::as_array_mut)
    else {
        return;
    };
    for c in choices {
        if let Some(obj) = c.as_object_mut() {
            for key in ["id", "color"] {
                if obj.get(key).is_none_or(Json::is_null) {
                    obj.insert(key.into(), Json::String(String::new()));
                }
            }
        }
    }
}

/// Parse the body of `POST /api/tables/{id}/fields`.
pub fn parse_create_field(mut body: Json) -> AppResult<CreateField> {
    fill_choice_defaults(&mut body);
    serde_json::from_value(body)
        .map_err(|e| AppError::bad_request(format!("invalid field definition: {e}")))
}

/// Parse the body of `PATCH /api/fields/{id}`. A present `type` is parsed
/// strictly (the DTO's optional flatten would silently ignore bad options).
pub fn parse_update_field(body: Json) -> AppResult<UpdateField> {
    #[derive(Deserialize)]
    struct Rest {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        position: Option<f64>,
    }
    let Json::Object(obj) = body else {
        return Err(AppError::bad_request("expected a JSON object"));
    };
    let kind =
        if obj.contains_key("type") {
            let mut k = Map::new();
            k.insert("type".into(), obj["type"].clone());
            if let Some(o) = obj.get("options") {
                k.insert("options".into(), o.clone());
            }
            let mut kj = Json::Object(k);
            fill_choice_defaults(&mut kj);
            Some(serde_json::from_value::<FieldKind>(kj).map_err(|e| {
                AppError::bad_request(format!("invalid field type or options: {e}"))
            })?)
        } else {
            None
        };
    let rest: Rest = serde_json::from_value(Json::Object(obj))
        .map_err(|e| AppError::bad_request(format!("invalid field update: {e}")))?;
    Ok(UpdateField {
        name: rest.name,
        description: rest.description,
        kind,
        position: rest.position,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn choices_get_ids_colours_and_reject_duplicates() {
        let mut o: SelectOptions = serde_json::from_value(json!({"choices": [
            {"id": "", "name": " Billing ", "color": ""},
            {"id": "keep_me", "name": "Done", "color": "green"},
            {"id": "", "name": "Critical", "color": ""}
        ]}))
        .unwrap();
        normalize_choices(&mut o).unwrap();
        assert!(o.choices[0].id.starts_with("sel"));
        assert_eq!(o.choices[0].name, "Billing");
        assert_eq!(o.choices[0].color, ob_core::field::COLORS[0]);
        assert_eq!(o.choices[1].id, "keep_me");
        assert_eq!(o.choices[2].color, "red");

        let mut dup: SelectOptions = serde_json::from_value(json!({"choices": [
            {"id": "", "name": "A", "color": "blue"}, {"id": "", "name": "a", "color": "red"}
        ]}))
        .unwrap();
        assert!(normalize_choices(&mut dup).is_err());

        let mut bad_color: SelectOptions =
            serde_json::from_value(json!({"choices": [{"id": "", "name": "A", "color": "mauve"}]}))
                .unwrap();
        assert!(normalize_choices(&mut bad_color).is_err());

        let mut dup_id: SelectOptions = serde_json::from_value(json!({"choices": [
            {"id": "x", "name": "A", "color": "blue"}, {"id": "x", "name": "B", "color": "red"}
        ]}))
        .unwrap();
        assert!(normalize_choices(&mut dup_id).is_err());
    }

    #[test]
    fn create_field_body_may_omit_choice_ids() {
        let f = parse_create_field(json!({
            "name": "Status", "type": "single_select",
            "options": {"choices": [{"name": "Open"}]}
        }))
        .unwrap();
        let FieldKind::SingleSelect(o) = f.kind else {
            panic!("wrong kind")
        };
        assert_eq!(o.choices[0].name, "Open");
    }

    #[test]
    fn update_field_rejects_bad_options_instead_of_ignoring_them() {
        assert!(
            parse_update_field(json!({"type": "number", "options": {"precision": "x"}})).is_err()
        );
        let u = parse_update_field(json!({"name": "N"})).unwrap();
        assert!(u.kind.is_none());
        assert_eq!(u.name.as_deref(), Some("N"));
        let u = parse_update_field(json!({"type": "email", "options": {}})).unwrap();
        assert!(u.kind.is_some());
        assert!(parse_update_field(json!([1])).is_err());
    }

    #[test]
    fn lookup_types_follow_target() {
        let f = |kind| Field {
            id: "f".into(),
            table_id: "t".into(),
            name: "f".into(),
            description: None,
            kind,
        };
        let n = f(FieldKind::Number(Default::default()));
        assert_eq!(
            lookup_result_type(&n),
            ResultType::Array(Box::new(ResultType::Number))
        );
        let d = f(FieldKind::Date(DateOptions {
            include_time: true,
            ..Default::default()
        }));
        assert_eq!(element_result_type(&d), ResultType::DateTime);
        assert_eq!(
            element_result_type(&f(FieldKind::Checkbox(Default::default()))),
            ResultType::Bool
        );
        assert_eq!(
            element_result_type(&f(FieldKind::Email(ob_core::field::Empty {}))),
            ResultType::Text
        );
    }

    #[test]
    fn precision_and_timezone_checks() {
        assert!(check_precision(8).is_ok());
        assert!(check_precision(9).is_err());
        let ok = DateOptions {
            timezone: Some("Europe/Berlin".into()),
            ..Default::default()
        };
        assert!(check_date_options(&ok).is_ok());
        let bad = DateOptions {
            timezone: Some("Mars/Olympus".into()),
            ..Default::default()
        };
        assert!(check_date_options(&bad).is_err());
    }
}
