//! Function registry and dispatch.
//!
//! Each category module exports a `SPECS` table. A [`FnSpec`] ties together
//! a function's arity (checked both when a formula is saved and when it is
//! evaluated), its result-type rule and its implementation.

mod array;
mod date;
mod logical;
mod numeric;
mod record;
mod regex;
mod text;

use std::collections::HashMap;
use std::sync::OnceLock;

use super::ast::Expr;
use super::coerce::{R, err, to_number, to_text};
use super::eval::{Evaluator, weight};
use super::types::{Ty, check_arity};
use crate::value::Value;

pub(crate) type EagerFn = fn(&[Value], &Evaluator) -> R;
pub(crate) type LazyFn = fn(&[Expr], &Evaluator) -> R;
/// Result-type rule: gets the argument types and expressions; `Err` is a
/// save-time error message (e.g. an invalid literal timezone).
pub(crate) type RetFn = fn(&[Ty], &[Expr]) -> Result<Ty, String>;

pub(crate) enum Imp {
    /// Arguments are evaluated first and the first error argument is the result.
    Eager(EagerFn),
    /// Arguments are evaluated first; errors are passed to the function.
    Raw(EagerFn),
    /// The function receives unevaluated arguments (`IF`, `SWITCH`, and date
    /// functions that look through `SET_TIMEZONE`).
    Lazy(LazyFn),
}

pub(crate) struct FnSpec {
    pub name: &'static str,
    pub min: usize,
    pub max: Option<usize>,
    pub ret: RetFn,
    pub imp: Imp,
}

impl FnSpec {
    pub(crate) const fn new(
        name: &'static str,
        min: usize,
        max: Option<usize>,
        ret: RetFn,
        imp: Imp,
    ) -> FnSpec {
        FnSpec {
            name,
            min,
            max,
            ret,
            imp,
        }
    }
}

fn registry() -> &'static HashMap<&'static str, &'static FnSpec> {
    static REG: OnceLock<HashMap<&'static str, &'static FnSpec>> = OnceLock::new();
    REG.get_or_init(|| {
        let mut m = HashMap::new();
        for table in [
            text::SPECS,
            logical::SPECS,
            numeric::SPECS,
            date::SPECS,
            array::SPECS,
            record::SPECS,
            regex::SPECS,
        ] {
            for spec in table {
                m.insert(spec.name, spec);
            }
        }
        m
    })
}

/// Looks up a function by its upper-case name.
pub(crate) fn lookup(name: &str) -> Option<&'static FnSpec> {
    registry().get(name).copied()
}

/// Every function name, for tests and editor autocompletion.
pub fn function_names() -> Vec<&'static str> {
    let mut names: Vec<_> = registry().keys().copied().collect();
    names.sort_unstable();
    names
}

/// Number of specs across all tables (duplicates would make this differ
/// from the registry size).
#[cfg(test)]
pub(crate) fn spec_count() -> usize {
    [
        text::SPECS,
        logical::SPECS,
        numeric::SPECS,
        date::SPECS,
        array::SPECS,
        record::SPECS,
        regex::SPECS,
    ]
    .iter()
    .map(|t| t.len())
    .sum()
}

/// Evaluates a function call.
pub(crate) fn call(ev: &Evaluator, name: &str, args: &[Expr]) -> Value {
    let Some(spec) = lookup(name) else {
        return err(format!("Unknown function {name}"));
    };
    if let Err(msg) = check_arity(spec, args.len()) {
        return err(msg);
    }
    let result = match spec.imp {
        Imp::Lazy(f) => f(args, ev),
        Imp::Eager(f) => {
            let (vals, held) = eval_args(ev, args);
            let r = match vals.iter().find(|v| v.is_error()) {
                Some(e) => Err(e.clone()),
                None => ev.charge(call_cost(&vals)).and_then(|()| f(&vals, ev)),
            };
            ev.release(held);
            r
        }
        Imp::Raw(f) => {
            let (vals, held) = eval_args(ev, args);
            let r = ev.charge(call_cost(&vals)).and_then(|()| f(&vals, ev));
            ev.release(held);
            r
        }
    };
    result.unwrap_or_else(|e| e)
}

/// Work charged for a call: a base cost plus the bytes of its arguments.
fn call_cost(vals: &[Value]) -> u64 {
    16 + vals.iter().map(|v| weight(v) as u64).sum::<u64>()
}

/// Evaluates every argument, tracking the bytes of the ones already
/// computed so a call with many large arguments is cut off before they all
/// pile up. Returns the values and the byte count to release afterwards.
fn eval_args(ev: &Evaluator, args: &[Expr]) -> (Vec<Value>, usize) {
    let mut vals = Vec::with_capacity(args.len());
    let mut held = 0;
    for a in args {
        let v = ev.eval(a);
        match ev.hold(&v) {
            Ok(w) => {
                held += w;
                vals.push(v);
            }
            Err(e) => {
                // Over budget: stop evaluating; the error becomes the result.
                vals.push(e);
                break;
            }
        }
    }
    (vals, held)
}

// ---------------------------------------------------------------------------
// Shared helpers for implementations
// ---------------------------------------------------------------------------

static NULL: Value = Value::Null;

/// Argument `i`, or blank when it was omitted.
pub(crate) fn arg(a: &[Value], i: usize) -> &Value {
    a.get(i).unwrap_or(&NULL)
}

pub(crate) fn text_arg(a: &[Value], i: usize) -> R<String> {
    to_text(arg(a, i))
}

pub(crate) fn num_arg(a: &[Value], i: usize) -> R<f64> {
    to_number(arg(a, i))
}

/// Numeric argument that defaults when omitted or blank.
pub(crate) fn opt_num_arg(a: &[Value], i: usize, default: f64) -> R<f64> {
    match arg(a, i) {
        Value::Null => Ok(default),
        v => to_number(v),
    }
}

/// Converts a count-like number to an integer, saturating huge values.
pub(crate) fn int(n: f64) -> i64 {
    n.trunc().clamp(-1e15, 1e15) as i64
}

/// The literal text of an argument, if it is a string literal.
pub(crate) fn literal_text(e: Option<&Expr>) -> Option<&str> {
    match e {
        Some(Expr::Text(s)) => Some(s),
        _ => None,
    }
}

pub(crate) fn r_text(_: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(Ty::Text)
}

pub(crate) fn r_number(_: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(Ty::Number)
}

pub(crate) fn r_bool(_: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(Ty::Bool)
}

pub(crate) fn r_any(_: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(Ty::Any)
}

pub(crate) fn r_date(_: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(Ty::Date)
}

pub(crate) fn r_datetime(_: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(Ty::DateTime)
}
