//! Integration points with the wave-1 engines.
//!
//! The schema plane (this workstream) must not depend on code that does not
//! exist yet, so everything it needs from the formula engine (`og_core::formula`),
//! the cell converter (`og_core::cell::convert`) and the recompute engine
//! (`crate::engine::recompute`) goes through the functions in this module.
//! Each has a deliberately simple placeholder body; the integrator replaces
//! the bodies (not the signatures) once those engines land.
//!
//! Formulas are stored with `{fldXXXX}` field-id references and shown to
//! clients with `{Field Name}` references: [`prepare_formula`] converts
//! display -> stored, [`display_formula`] converts stored -> display.

use rusqlite::Transaction;
use serde_json::Value as Json;

use og_core::field::Field;
use og_core::value::ResultType;
use og_core::view::ViewConfig;

use crate::error::{AppError, AppResult};

const NEEDS_ENGINE: &str = "formula fields with references require the formula engine";

/// Parse and validate a formula typed by a user (`expression_display`, with
/// `{Field Name}` references resolved against `table_fields`), and return the
/// stored form (references rewritten to `{fldXXXX}` ids) together with the
/// inferred result type. Used for formula fields and button `url_formula`s.
///
/// PLACEHOLDER: accepts only expressions without references, stores them
/// unchanged and reports `ResultType::Text`.
/// REPLACE WITH: `og_core::formula::parse` + `to_storage` + `infer_type`.
pub fn prepare_formula(
    table_fields: &[Field],
    expression_display: &str,
) -> AppResult<(String, ResultType)> {
    let _ = table_fields;
    if expression_display.contains('{') {
        return Err(AppError::bad_request(NEEDS_ENGINE));
    }
    Ok((expression_display.to_string(), ResultType::Text))
}

/// Parse and validate a rollup expression, a formula over the array `values`
/// holding the `target` field's values from linked records. Returns the stored
/// expression and its inferred result type.
///
/// PLACEHOLDER: same behaviour as [`prepare_formula`].
/// REPLACE WITH: formula parse/infer with `values: Array(type of target)`.
pub fn prepare_rollup(
    table_fields: &[Field],
    target: &Field,
    expression_display: &str,
) -> AppResult<(String, ResultType)> {
    let _ = target;
    prepare_formula(table_fields, expression_display)
}

/// Rewrite a stored expression (`{fldXXXX}` references) into display form
/// (`{Field Name}` references) using the table's current field names. Applied
/// to every formula, rollup and button expression sent to clients.
///
/// PLACEHOLDER: identity.
/// REPLACE WITH: `og_core::formula::to_display`.
pub fn display_formula(stored: &str, table_fields: &[Field]) -> String {
    let _ = table_fields;
    stored.to_string()
}

/// Convert one stored cell value from field `from` to field `to` (same field
/// id, new type or options) when a field's type changes. `None` in means the
/// cell is empty; `None` out means the value cannot be represented and is
/// dropped.
///
/// PLACEHOLDER: keeps the value when both fields have the same type, drops it
/// otherwise.
/// REPLACE WITH: `og_core::cell::convert`.
pub fn convert_value(from: &Field, to: &Field, stored: Option<&Json>) -> Option<Json> {
    if from.field_type() == to.field_type() {
        stored.cloned()
    } else {
        None
    }
}

/// Called inside the schema-changing transaction after fields were created,
/// changed or removed: (re)materializes the computed fields among `field_ids`
/// and everything that depends on them, in `table_id` of `base_id`.
///
/// PLACEHOLDER: does nothing.
/// REPLACE WITH: `crate::engine::recompute::recompute_fields`.
pub fn after_field_change(
    tx: &Transaction,
    base_id: &str,
    table_id: &str,
    field_ids: &[String],
) -> AppResult<()> {
    let _ = (tx, base_id, table_id, field_ids);
    Ok(())
}

/// Check a view config against the field types of its table: operators that
/// do not apply to a field's type, operand shapes, kanban stack field types,
/// and so on. Structural checks (unknown field ids, limits) are done by the
/// caller before this is invoked.
///
/// PLACEHOLDER: accepts everything.
/// REPLACE WITH: `og_core::query::validate_config`.
pub fn validate_view_config_semantics(fields: &[Field], config: &ViewConfig) -> AppResult<()> {
    let _ = (fields, config);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_formula_rejects_references() {
        assert!(prepare_formula(&[], "{Name} & 1").is_err());
        let (stored, ty) = prepare_formula(&[], "1 + 1").unwrap();
        assert_eq!(stored, "1 + 1");
        assert_eq!(ty, ResultType::Text);
    }
}
