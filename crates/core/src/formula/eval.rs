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

/// Work units one evaluation may spend before it is cut off. One unit is
/// about a byte of text touched by a function; an uncached regular
/// expression compile costs a fixed amount (see `functions::regex`). Generous
/// for any real formula, but bounds the CPU a hostile one can burn per record.
pub(crate) const WORK_BUDGET: u64 = 20_000_000;
/// Bytes of intermediate values that may be alive at once during one
/// evaluation (arguments already evaluated while later ones are computed).
pub(crate) const LIVE_BYTES_BUDGET: usize = 4 << 20;

/// Evaluates `expr` for the record described by `ctx`.
pub fn eval(expr: &Expr, ctx: &dyn EvalContext) -> Value {
    let ev = Evaluator {
        ctx,
        depth: Cell::new(0),
        work: Cell::new(0),
        live: Cell::new(0),
        exhausted: Cell::new(false),
    };
    let v = ev.eval(expr);
    // A formula that ran out of budget never yields a normal value, even if
    // a surrounding `IF(ISERROR(..))` swallowed the error on the way up.
    if ev.exhausted.get() {
        return budget_error();
    }
    v
}

fn budget_error() -> Value {
    err("Formula is too expensive to evaluate")
}

/// Approximate heap footprint of a value, in bytes.
pub(crate) fn weight(v: &Value) -> usize {
    match v {
        Value::Text(s) | Value::Error(s) => s.len(),
        Value::Array(items) => items.iter().map(|i| 16 + weight(i)).sum(),
        _ => 0,
    }
}

pub(crate) struct Evaluator<'a> {
    pub ctx: &'a dyn EvalContext,
    depth: Cell<usize>,
    work: Cell<u64>,
    live: Cell<usize>,
    exhausted: Cell<bool>,
}

impl Evaluator<'_> {
    /// Spends `units` of the work budget; `Err` once it is gone.
    pub(crate) fn charge(&self, units: u64) -> R<()> {
        if self.exhausted.get() {
            return Err(budget_error());
        }
        let used = self.work.get().saturating_add(units);
        self.work.set(used);
        if used > WORK_BUDGET {
            self.exhausted.set(true);
            return Err(budget_error());
        }
        Ok(())
    }

    /// Records that `v` stays alive while other operands are evaluated.
    /// Returns the amount to pass to [`Evaluator::release`] later.
    pub(crate) fn hold(&self, v: &Value) -> R<usize> {
        let w = weight(v);
        let live = self.live.get().saturating_add(w);
        self.live.set(live);
        if live > LIVE_BYTES_BUDGET {
            self.exhausted.set(true);
            return Err(budget_error());
        }
        Ok(w)
    }

    pub(crate) fn release(&self, bytes: usize) {
        self.live.set(self.live.get().saturating_sub(bytes));
    }

    pub(crate) fn eval(&self, e: &Expr) -> Value {
        if let Err(e) = self.charge(1) {
            return e;
        }
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
                let held = match self.hold(&a) {
                    Ok(w) => w,
                    Err(e) => return e,
                };
                let b = self.eval(rhs);
                self.release(held);
                if let Err(e) = self.charge((weight(&a) + weight(&b)) as u64) {
                    return e;
                }
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
