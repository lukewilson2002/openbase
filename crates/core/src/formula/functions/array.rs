//! Array functions, mainly for rollups (`values`) and lookup fields. A
//! non-array argument is treated as a one-item array and blank as empty.

use super::{FnSpec, Imp, arg, int, num_arg, r_text};
use crate::formula::ast::Expr;
use crate::formula::coerce::{MAX_TEXT_BYTES, R, flatten, to_number, to_text, too_long};
use crate::formula::eval::Evaluator;
use crate::formula::types::Ty;
use crate::value::Value;

pub(crate) const SPECS: &[FnSpec] = &[
    FnSpec::new(
        "ARRAYCOMPACT",
        1,
        Some(1),
        r_same_array,
        Imp::Eager(arraycompact),
    ),
    FnSpec::new(
        "ARRAYFLATTEN",
        1,
        Some(1),
        r_flat_array,
        Imp::Eager(arrayflatten),
    ),
    FnSpec::new("ARRAYJOIN", 1, Some(2), r_text, Imp::Eager(arrayjoin)),
    FnSpec::new(
        "ARRAYSLICE",
        2,
        Some(3),
        r_same_array,
        Imp::Eager(arrayslice),
    ),
    FnSpec::new(
        "ARRAYUNIQUE",
        1,
        Some(1),
        r_same_array,
        Imp::Eager(arrayunique),
    ),
];

fn r_same_array(tys: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(match tys.first() {
        Some(arr @ Ty::Array(_)) => arr.clone(),
        Some(other) => Ty::Array(Box::new(other.clone())),
        None => Ty::Array(Box::new(Ty::Any)),
    })
}

fn r_flat_array(tys: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(Ty::Array(Box::new(
        tys.first().map(Ty::leaf).unwrap_or(Ty::Any),
    )))
}

/// Top-level items of an argument. Errors anywhere inside propagate.
fn items(v: &Value) -> R<Vec<Value>> {
    flatten(std::slice::from_ref(v))?;
    Ok(match v {
        Value::Array(items) => items.clone(),
        Value::Null => Vec::new(),
        other => vec![other.clone()],
    })
}

/// All leaves of the first argument (blank → empty).
fn leaves(a: &[Value]) -> R<Vec<Value>> {
    match arg(a, 0) {
        Value::Null => Ok(Vec::new()),
        v => flatten(std::slice::from_ref(v)),
    }
}

/// `ARRAYCOMPACT(values)`: drops blanks and empty text; keeps `FALSE`, 0
/// and whitespace-only text.
fn arraycompact(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Array(
        items(arg(a, 0))?
            .into_iter()
            .filter(|v| match v {
                Value::Null => false,
                Value::Text(s) => !s.is_empty(),
                _ => true,
            })
            .collect(),
    ))
}

/// `ARRAYFLATTEN(values)`: removes all nesting.
fn arrayflatten(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Array(leaves(a)?))
}

/// `ARRAYJOIN(values, [separator=", "])`.
fn arrayjoin(a: &[Value], _: &Evaluator) -> R {
    let sep = if a.len() < 2 {
        ", ".to_string()
    } else {
        to_text(arg(a, 1))?
    };
    let mut out = String::new();
    for (i, v) in leaves(a)?.iter().enumerate() {
        if i > 0 {
            out.push_str(&sep);
        }
        out.push_str(&to_text(v)?);
        if out.len() > MAX_TEXT_BYTES {
            return Err(too_long());
        }
    }
    Ok(Value::Text(out))
}

/// `ARRAYUNIQUE(values)`: first occurrence of each distinct item.
fn arrayunique(a: &[Value], _: &Evaluator) -> R {
    let mut out: Vec<Value> = Vec::new();
    for v in items(arg(a, 0))? {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    Ok(Value::Array(out))
}

/// Converts a 1-based (negative: from the end) index to a 0-based offset.
fn offset(i: i64, len: i64) -> i64 {
    match i {
        i if i > 0 => i - 1,
        i if i < 0 => len + i,
        _ => 0,
    }
}

/// `ARRAYSLICE(values, start, [end])`: 1-based and inclusive; negative
/// indexes count from the end (`-1` is the last item).
fn arrayslice(a: &[Value], _: &Evaluator) -> R {
    let all = items(arg(a, 0))?;
    let len = all.len() as i64;
    let start = offset(int(num_arg(a, 1)?), len).clamp(0, len);
    let end = match arg(a, 2) {
        Value::Null => len,
        v => match int(to_number(v)?) {
            0 => len,
            e => offset(e, len) + 1,
        },
    }
    .clamp(0, len);
    if start >= end {
        return Ok(Value::Array(Vec::new()));
    }
    Ok(Value::Array(all[start as usize..end as usize].to_vec()))
}
