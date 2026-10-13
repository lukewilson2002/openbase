//! Static checks and result-type inference.
//!
//! [`infer_type`] reports the errors Airtable reports when a formula is
//! saved: unknown functions, wrong argument counts, unknown fields, `values`
//! outside a rollup, and invalid literal arguments it can see statically
//! (timezone names, date units, regular expressions). It is lenient about
//! operand types wherever evaluation coerces (text in arithmetic, numbers in
//! `&`, ...).

use super::FormulaError;
use super::ast::{BinOp, Expr};
use super::coerce::{to_date, to_number, to_text};
use super::functions;
use crate::value::{ResultType, Value};

/// What the type checker knows about the table.
pub trait TypeEnv {
    /// Result type of the field with this id (or name, for display-form
    /// formulas); `None` if there is no such field.
    fn field_type(&self, field_id: &str) -> Option<ResultType>;
    /// Element type of the rollup `values` array; `None` (the default) means
    /// this formula is not a rollup and `values` is an error.
    fn values_type(&self) -> Option<ResultType> {
        None
    }
}

/// Internal type lattice: [`ResultType`] plus `Any` (blank / unknown).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Ty {
    Text,
    Number,
    Bool,
    Date,
    DateTime,
    Array(Box<Ty>),
    Any,
}

impl Ty {
    pub(crate) fn from_result(rt: &ResultType) -> Ty {
        match rt {
            ResultType::Text => Ty::Text,
            ResultType::Number => Ty::Number,
            ResultType::Bool => Ty::Bool,
            ResultType::Date => Ty::Date,
            ResultType::DateTime => Ty::DateTime,
            ResultType::Array(inner) => Ty::Array(Box::new(Ty::from_result(inner))),
        }
    }

    pub(crate) fn to_result(&self) -> ResultType {
        match self {
            Ty::Text | Ty::Any => ResultType::Text,
            Ty::Number => ResultType::Number,
            Ty::Bool => ResultType::Bool,
            Ty::Date => ResultType::Date,
            Ty::DateTime => ResultType::DateTime,
            Ty::Array(inner) => ResultType::Array(Box::new(inner.to_result())),
        }
    }

    pub(crate) fn is_dateish(&self) -> bool {
        matches!(self, Ty::Date | Ty::DateTime)
    }

    /// Element type with nested arrays flattened.
    pub(crate) fn leaf(&self) -> Ty {
        match self {
            Ty::Array(inner) => inner.leaf(),
            other => other.clone(),
        }
    }
}

/// Least common type of two branches (`IF`, `SWITCH`): blank adopts the
/// other side, date + datetime is datetime, anything else mixed is text.
pub(crate) fn unify(a: &Ty, b: &Ty) -> Ty {
    match (a, b) {
        _ if a == b => a.clone(),
        (Ty::Any, x) | (x, Ty::Any) => x.clone(),
        (Ty::Date, Ty::DateTime) | (Ty::DateTime, Ty::Date) => Ty::DateTime,
        (Ty::Array(x), Ty::Array(y)) => Ty::Array(Box::new(unify(x, y))),
        _ => Ty::Text,
    }
}

/// Type-checks `expr` and returns the type of its result.
pub fn infer_type(expr: &Expr, env: &dyn TypeEnv) -> Result<ResultType, FormulaError> {
    Ok(infer(expr, env)?.to_result())
}

pub(crate) fn infer(expr: &Expr, env: &dyn TypeEnv) -> Result<Ty, FormulaError> {
    match expr {
        Expr::Number(_) => Ok(Ty::Number),
        Expr::Text(_) => Ok(Ty::Text),
        Expr::Bool(_) => Ok(Ty::Bool),
        Expr::Field { name, span } => env
            .field_type(name)
            .map(|rt| Ty::from_result(&rt))
            .ok_or_else(|| FormulaError::at(span.start, format!("Unknown field '{name}'"))),
        Expr::Values => match env.values_type() {
            Some(rt) => Ok(match Ty::from_result(&rt) {
                arr @ Ty::Array(_) => arr,
                scalar => Ty::Array(Box::new(scalar)),
            }),
            None => Err(FormulaError::new(
                "'values' can only be used in a rollup formula",
            )),
        },
        Expr::Neg(inner) => {
            infer(inner, env)?;
            Ok(Ty::Number)
        }
        Expr::Binary { op, lhs, rhs } => {
            infer(lhs, env)?;
            infer(rhs, env)?;
            Ok(match op {
                BinOp::Concat => Ty::Text,
                BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div => Ty::Number,
                _ => Ty::Bool,
            })
        }
        Expr::Call { name, args, pos } => {
            let Some(spec) = functions::lookup(name) else {
                return Err(FormulaError::at(*pos, format!("Unknown function {name}")));
            };
            check_arity(spec, args.len()).map_err(|m| FormulaError::at(*pos, m))?;
            let mut tys = Vec::with_capacity(args.len());
            for a in args {
                tys.push(infer(a, env)?);
            }
            (spec.ret)(&tys, args).map_err(|m| FormulaError::at(*pos, format!("{name}: {m}")))
        }
    }
}

pub(crate) fn check_arity(spec: &functions::FnSpec, got: usize) -> Result<(), String> {
    let plural = |n: usize| if n == 1 { "argument" } else { "arguments" };
    match spec.max {
        Some(max) if spec.min == max && got != max => Err(format!(
            "{} expects {max} {} but got {got}",
            spec.name,
            plural(max)
        )),
        Some(max) if got > max => Err(format!(
            "{} expects at most {max} {} but got {got}",
            spec.name,
            plural(max)
        )),
        _ if got < spec.min => Err(format!(
            "{} expects at least {} {} but got {got}",
            spec.name,
            spec.min,
            plural(spec.min)
        )),
        _ => Ok(()),
    }
}

/// Converts an evaluated value to the declared result type so materialized
/// JSON always matches it (e.g. `IF(x, 1, "a")` is typed text, so the `1`
/// becomes `"1"`). Blank and errors pass through; impossible conversions
/// become errors.
pub fn conform(v: Value, ty: &ResultType) -> Value {
    if matches!(v, Value::Null | Value::Error(_)) {
        return v;
    }
    match ty {
        ResultType::Text => match v {
            Value::Text(_) => v,
            other => to_text(&other).map(Value::Text).unwrap_or_else(|e| e),
        },
        ResultType::Number => match v {
            Value::Number(_) => v,
            other => to_number(&other).map(Value::Number).unwrap_or_else(|e| e),
        },
        ResultType::Bool => match v {
            Value::Bool(_) => v,
            other => Value::Bool(other.truthy()),
        },
        ResultType::Date => match to_date(&v) {
            Ok(Some(d)) => Value::Date(d.instant().date_naive()),
            Ok(None) => Value::Null,
            Err(e) => e,
        },
        ResultType::DateTime => match to_date(&v) {
            Ok(Some(d)) => Value::DateTime(d.instant()),
            Ok(None) => Value::Null,
            Err(e) => e,
        },
        ResultType::Array(inner) => match v {
            Value::Array(items) => {
                Value::Array(items.into_iter().map(|i| conform(i, inner)).collect())
            }
            scalar => Value::Array(vec![conform(scalar, inner)]),
        },
    }
}
