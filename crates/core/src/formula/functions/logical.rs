//! Logical functions. `IF` and `SWITCH` evaluate only the branch they take,
//! so an error in an untaken branch does not surface.

use super::{FnSpec, Imp, arg, r_any, r_bool};
use crate::formula::ast::Expr;
use crate::formula::coerce::{R, flatten, strict_eq};
use crate::formula::eval::Evaluator;
use crate::formula::types::{Ty, unify};
use crate::value::Value;

pub(crate) const SPECS: &[FnSpec] = &[
    FnSpec::new("AND", 1, None, r_bool, Imp::Eager(and)),
    FnSpec::new("BLANK", 0, Some(0), r_any, Imp::Eager(blank)),
    FnSpec::new("ERROR", 0, Some(0), r_any, Imp::Eager(error)),
    FnSpec::new("FALSE", 0, Some(0), r_bool, Imp::Eager(false_)),
    FnSpec::new("IF", 2, Some(3), r_if, Imp::Lazy(if_)),
    FnSpec::new("ISERROR", 1, Some(1), r_bool, Imp::Raw(iserror)),
    FnSpec::new("NOT", 1, Some(1), r_bool, Imp::Eager(not)),
    FnSpec::new("OR", 1, None, r_bool, Imp::Eager(or)),
    FnSpec::new("SWITCH", 3, None, r_switch, Imp::Lazy(switch)),
    FnSpec::new("TRUE", 0, Some(0), r_bool, Imp::Eager(true_)),
    FnSpec::new("XOR", 1, None, r_bool, Imp::Eager(xor)),
];

fn r_if(tys: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    let then = tys.get(1).cloned().unwrap_or(Ty::Any);
    let otherwise = tys.get(2).cloned().unwrap_or(Ty::Any);
    Ok(unify(&then, &otherwise))
}

fn r_switch(tys: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    let rest = &tys[1.min(tys.len())..];
    let mut ty = Ty::Any;
    for (i, t) in rest.iter().enumerate() {
        // Results sit at odd positions within `rest`, plus a trailing default.
        let is_result = i % 2 == 1 || (rest.len() % 2 == 1 && i == rest.len() - 1);
        if is_result {
            ty = unify(&ty, t);
        }
    }
    Ok(ty)
}

/// Truthiness of every item, with arrays (rollup inputs) flattened.
fn truths(a: &[Value]) -> R<Vec<bool>> {
    Ok(flatten(a)?.iter().map(Value::truthy).collect())
}

fn and(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Bool(truths(a)?.into_iter().all(|t| t)))
}

fn or(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Bool(truths(a)?.into_iter().any(|t| t)))
}

fn xor(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Bool(
        truths(a)?.into_iter().filter(|t| *t).count() % 2 == 1,
    ))
}

fn not(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Bool(!arg(a, 0).truthy()))
}

fn blank(_: &[Value], _: &Evaluator) -> R {
    Ok(Value::Null)
}

fn error(_: &[Value], _: &Evaluator) -> R {
    Err(Value::Error("#ERROR!".to_string()))
}

fn true_(_: &[Value], _: &Evaluator) -> R {
    Ok(Value::Bool(true))
}

fn false_(_: &[Value], _: &Evaluator) -> R {
    Ok(Value::Bool(false))
}

fn iserror(a: &[Value], _: &Evaluator) -> R {
    Ok(Value::Bool(flatten(a).is_err()))
}

fn if_(args: &[Expr], ev: &Evaluator) -> R {
    let cond = ev.eval_ok(&args[0])?;
    if cond.truthy() {
        Ok(ev.eval(&args[1]))
    } else {
        Ok(args.get(2).map(|e| ev.eval(e)).unwrap_or(Value::Null))
    }
}

/// `SWITCH(expr, pattern1, result1, ..., [default])`.
fn switch(args: &[Expr], ev: &Evaluator) -> R {
    let subject = ev.eval_ok(&args[0])?;
    let rest = &args[1..];
    let mut pairs = rest.chunks_exact(2);
    for pair in pairs.by_ref() {
        let pattern = ev.eval_ok(&pair[0])?;
        if strict_eq(&subject, &pattern) {
            return Ok(ev.eval(&pair[1]));
        }
    }
    Ok(match pairs.remainder() {
        [default] => ev.eval(default),
        _ => Value::Null,
    })
}
