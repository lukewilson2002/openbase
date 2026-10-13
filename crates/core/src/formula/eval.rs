//! Formula evaluation.
//!
//! Evaluation is total: every input produces a [`Value`] (possibly
//! `Value::Error`), never a panic.

use std::cell::Cell;
use std::cmp::Ordering;

use chrono::{DateTime, Utc};
use chrono_tz::Tz;

use super::MAX_EXPR_HEIGHT;
use super::ast::{BinOp, Expr};
use super::coerce::{R, compare, err, loose_eq, num, text, to_number, to_text};
use super::functions;
use crate::value::Value;

/// Everything a formula can read about the record being evaluated.
/// Field references in stored formulas are field ids.
pub trait EvalContext {
    /// Current value of a field (blank if the record has none).
    fn field(&self, field_id: &str) -> Value;
    fn record_id(&self) -> &str;
    fn created_time(&self) -> DateTime<Utc>;
    fn last_modified_time(&self) -> DateTime<Utc>;
    /// The evaluation clock (`NOW()`); passed in so evaluation stays pure.
    fn now(&self) -> DateTime<Utc>;
    /// The rollup input array for `values`; blank outside rollups.
    fn values(&self) -> Value {
        Value::Null
    }
    /// Default timezone for date parts, formatting and `TODAY()` when no
    /// `SET_TIMEZONE` applies. UTC unless overridden.
    fn timezone(&self) -> Tz {
        chrono_tz::UTC
    }
    /// When a specific field was last modified on this record, if tracked.
    /// `LAST_MODIFIED_TIME({Field})` falls back to the record's
    /// last-modified time when this returns `None`.
    fn field_modified_time(&self, _field_id: &str) -> Option<DateTime<Utc>> {
        None
    }
}

/// Evaluates `expr` for the record described by `ctx`.
pub fn eval(expr: &Expr, ctx: &dyn EvalContext) -> Value {
    Evaluator {
        ctx,
        depth: Cell::new(0),
    }
    .eval(expr)
}

pub(crate) struct Evaluator<'a> {
    pub ctx: &'a dyn EvalContext,
    depth: Cell<usize>,
}

impl Evaluator<'_> {
    pub(crate) fn eval(&self, e: &Expr) -> Value {
        // Parsed trees are height-limited already; this guards hand-built ones.
        let depth = self.depth.get();
        if depth > MAX_EXPR_HEIGHT + crate::limits::MAX_FORMULA_DEPTH {
            return err("Formula is nested too deeply");
        }
        self.depth.set(depth + 1);
        let v = self.eval_inner(e);
        self.depth.set(depth);
        v
    }

    /// Evaluates and turns a `Value::Error` into `Err` for `?` propagation.
    pub(crate) fn eval_ok(&self, e: &Expr) -> R {
        match self.eval(e) {
            v @ Value::Error(_) => Err(v),
            v => Ok(v),
        }
    }

    fn eval_inner(&self, e: &Expr) -> Value {
        match e {
            Expr::Number(n) => Value::Number(*n),
            Expr::Text(s) => Value::Text(s.clone()),
            Expr::Bool(b) => Value::Bool(*b),
            Expr::Field { name, .. } => self.ctx.field(name),
            Expr::Values => self.ctx.values(),
            Expr::Neg(inner) => match to_number(&self.eval(inner)) {
                Ok(n) => Value::Number(if n == 0.0 { 0.0 } else { -n }),
                Err(e) => e,
            },
            Expr::Binary { op, lhs, rhs } => {
                let a = self.eval(lhs);
                let b = self.eval(rhs);
                binary(*op, &a, &b).unwrap_or_else(|e| e)
            }
            Expr::Call { name, args, .. } => functions::call(self, name, args),
        }
    }
}

/// Applies a binary operator. Errors in either operand propagate (left first).
pub(crate) fn binary(op: BinOp, a: &Value, b: &Value) -> R {
    if a.is_error() {
        return Err(a.clone());
    }
    if b.is_error() {
        return Err(b.clone());
    }
    match op {
        BinOp::Concat => {
            let mut s = to_text(a)?;
            s.push_str(&to_text(b)?);
            text(s)
        }
        BinOp::Add | BinOp::Sub | BinOp::Mul | BinOp::Div => {
            let x = to_number(a)?;
            let y = to_number(b)?;
            match op {
                BinOp::Add => num(x + y),
                BinOp::Sub => num(x - y),
                BinOp::Mul => num(x * y),
                _ if y == 0.0 => Err(err("Division by zero")),
                _ => num(x / y),
            }
        }
        BinOp::Eq => Ok(Value::Bool(loose_eq(a, b))),
        BinOp::Ne => Ok(Value::Bool(!loose_eq(a, b))),
        BinOp::Lt => Ok(Value::Bool(compare(a, b) == Some(Ordering::Less))),
        BinOp::Gt => Ok(Value::Bool(compare(a, b) == Some(Ordering::Greater))),
        BinOp::Le => Ok(Value::Bool(matches!(
            compare(a, b),
            Some(Ordering::Less | Ordering::Equal)
        ))),
        BinOp::Ge => Ok(Value::Bool(matches!(
            compare(a, b),
            Some(Ordering::Greater | Ordering::Equal)
        ))),
    }
}
