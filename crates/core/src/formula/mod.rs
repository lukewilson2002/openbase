//! Airtable-compatible formula language.
//!
//! Pipeline: [`parse`] text into an [`Expr`]; [`to_storage`] / [`to_display`]
//! rewrite field references between `{Field Name}` (what users type) and
//! `{fldXXXX}` (what the server stores, so renames never break formulas);
//! [`infer_type`] checks a formula at save time and computes its
//! [`ResultType`]; [`eval`] computes a [`Value`] for one record.
//!
//! Semantics follow Airtable:
//! - blank is 0 in arithmetic and `""` in `&`; `TRUE` is 1 and `FALSE` is 0;
//! - numbers print without trailing zeros (`3`, `1.5`);
//! - `=` on text is case-sensitive;
//! - errors (`Value::Error("#ERROR: ...")`) propagate through operators and
//!   almost all functions; `ISERROR` and `IF` branches not taken stop them;
//! - dates print as ISO 8601 in text context, arrays print joined with `", "`;
//! - date arithmetic goes through `DATEADD` / `DATETIME_DIFF`, not `+`/`-`.
//!
//! Dates are UTC unless [`EvalContext::timezone`] says otherwise. `Value` has
//! no timezone, so `SET_TIMEZONE(date, "Area/City")` only has an effect when it
//! is passed *directly* as the date argument of a date function, e.g.
//! `DATETIME_FORMAT(SET_TIMEZONE({Due}, "Europe/Paris"), "HH:mm")`, `HOUR(...)`,
//! `DAY(...)`, `DATESTR(...)`, `DATEADD(...)`, `IS_SAME(...)`. Anywhere else it
//! returns its date unchanged. `SET_LOCALE` is accepted and ignored (English only).
//!
//! Text positions (`FIND`, `MID`, `LEN`, ...) count Unicode scalar values.

mod ast;
mod coerce;
mod datetime;
mod eval;
mod functions;
mod lexer;
mod parser;
mod refs;
mod types;

#[cfg(test)]
mod tests;

use std::fmt;

pub use ast::{BinOp, Expr, Span, escape_field_name};
pub use coerce::{format_number, to_text};
pub use eval::{EvalContext, eval};
pub use functions::function_names;
pub use parser::parse;
pub use refs::{referenced_fields, to_display, to_storage};
pub use types::{TypeEnv, conform, infer_type};

use crate::value::{ResultType, Value};

/// Maximum height of a parsed expression tree. Long operator chains such as
/// `{A} & {B} & ...` grow the tree one level per operator; this bounds the
/// recursion of every tree walk (type check, evaluation, printing).
pub const MAX_EXPR_HEIGHT: usize = 512;

/// A parse or type error, with the byte offset in the formula source when known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaError {
    pub message: String,
    pub pos: Option<usize>,
}

impl FormulaError {
    pub fn at(pos: usize, message: impl Into<String>) -> Self {
        FormulaError {
            message: message.into(),
            pos: Some(pos),
        }
    }

    pub fn new(message: impl Into<String>) -> Self {
        FormulaError {
            message: message.into(),
            pos: None,
        }
    }
}

impl fmt::Display for FormulaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.pos {
            Some(p) => write!(f, "{} (at position {p})", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for FormulaError {}

/// True if the formula's result depends on the current time
/// (`NOW`, `TODAY`, `TONOW`, `FROMNOW`) and must be refreshed periodically.
pub fn is_volatile(expr: &Expr) -> bool {
    let mut volatile = false;
    expr.walk(&mut |e| {
        if let Expr::Call { name, .. } = e
            && matches!(name.as_str(), "NOW" | "TODAY" | "TONOW" | "FROMNOW")
        {
            volatile = true;
        }
    });
    volatile
}

/// A parsed formula with its derived facts, ready to evaluate repeatedly.
#[derive(Debug, Clone, PartialEq)]
pub struct Formula {
    pub expr: Expr,
    pub volatile: bool,
}

impl Formula {
    /// Parses `src` (stored or display form; references are kept as written).
    pub fn parse(src: &str) -> Result<Formula, FormulaError> {
        let expr = parse(src)?;
        let volatile = is_volatile(&expr);
        Ok(Formula { expr, volatile })
    }

    /// Type-checks the formula and returns its result type.
    pub fn infer_type(&self, env: &dyn TypeEnv) -> Result<ResultType, FormulaError> {
        infer_type(&self.expr, env)
    }

    pub fn referenced_fields(&self) -> Vec<String> {
        referenced_fields(&self.expr)
    }

    pub fn eval(&self, ctx: &dyn EvalContext) -> Value {
        eval(&self.expr, ctx)
    }

    /// Evaluates and converts the result to `ty` (see [`conform`]), so the
    /// materialized value always matches the field's declared result type.
    pub fn eval_as(&self, ctx: &dyn EvalContext, ty: &ResultType) -> Value {
        conform(eval(&self.expr, ctx), ty)
    }
}
