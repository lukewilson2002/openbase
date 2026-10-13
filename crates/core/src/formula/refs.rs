//! Field reference extraction and rewriting between display form
//! (`{Field Name}`) and storage form (`{fldXXXX}`).
//!
//! Rewriting splices the source text at the parsed reference spans, so
//! everything else (spacing, string literals, operators) is kept
//! byte-for-byte.

use super::ast::{Expr, Span, escape_field_name};
use super::{FormulaError, parse};

/// Field references in the order they first appear, without duplicates.
/// The strings are the raw reference text (names in display form, ids in
/// storage form).
pub fn referenced_fields(expr: &Expr) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    expr.walk(&mut |e| {
        if let Expr::Field { name, .. } = e
            && !out.iter().any(|n| n == name)
        {
            out.push(name.clone());
        }
    });
    out
}

/// Every field reference with its source span, sorted by position.
fn spans(expr: &Expr) -> Vec<(Span, String)> {
    let mut out = Vec::new();
    expr.walk(&mut |e| {
        if let Expr::Field { name, span } = e {
            out.push((*span, name.clone()));
        }
    });
    out.sort_by_key(|(s, _)| s.start);
    out
}

fn splice(src: &str, edits: Vec<(Span, String)>) -> String {
    let mut out = String::with_capacity(src.len());
    let mut last = 0;
    for (span, text) in edits {
        // Spans come from the parser and lie on char boundaries; guard anyway.
        let (Some(before), true) = (src.get(last..span.start), span.end <= src.len()) else {
            continue;
        };
        out.push_str(before);
        out.push_str(&text);
        last = span.end;
    }
    out.push_str(src.get(last..).unwrap_or(""));
    out
}

/// Rewrites every field reference in `src` (braced or bare) to `{<field id>}`
/// using `resolve` (name → id). Fails with a positioned error on a syntax
/// error or on the first name `resolve` does not know.
pub fn to_storage(
    src: &str,
    resolve: &dyn Fn(&str) -> Option<String>,
) -> Result<String, FormulaError> {
    let expr = parse(src)?;
    let mut edits = Vec::new();
    for (span, name) in spans(&expr) {
        let Some(id) = resolve(&name) else {
            return Err(FormulaError::at(
                span.start,
                format!("Unknown field '{name}'"),
            ));
        };
        edits.push((span, format!("{{{}}}", escape_field_name(&id))));
    }
    Ok(splice(src, edits))
}

/// Rewrites stored `{<field id>}` references back to `{Field Name}` using
/// `name_of`. Ids `name_of` does not know (e.g. a deleted field) are kept
/// as-is; a stored formula that no longer parses is returned unchanged.
pub fn to_display(stored: &str, name_of: &dyn Fn(&str) -> Option<String>) -> String {
    let Ok(expr) = parse(stored) else {
        return stored.to_string();
    };
    let edits = spans(&expr)
        .into_iter()
        .filter_map(|(span, id)| {
            name_of(&id).map(|name| (span, format!("{{{}}}", escape_field_name(&name))))
        })
        .collect();
    splice(stored, edits)
}
