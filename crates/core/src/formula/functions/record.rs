//! Record functions: `RECORD_ID`, `CREATED_TIME`, `LAST_MODIFIED_TIME`.

use chrono::{DateTime, Utc};

use super::{FnSpec, Imp, r_datetime, r_text};
use crate::formula::ast::Expr;
use crate::formula::coerce::{R, err};
use crate::formula::eval::Evaluator;
use crate::formula::types::Ty;
use crate::value::Value;

pub(crate) const SPECS: &[FnSpec] = &[
    FnSpec::new(
        "CREATED_TIME",
        0,
        Some(0),
        r_datetime,
        Imp::Eager(created_time),
    ),
    FnSpec::new(
        "LAST_MODIFIED_TIME",
        0,
        None,
        r_last_modified,
        Imp::Lazy(last_modified_time),
    ),
    FnSpec::new("RECORD_ID", 0, Some(0), r_text, Imp::Eager(record_id)),
];

fn r_last_modified(_: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    if args.iter().any(|a| !matches!(a, Expr::Field { .. })) {
        return Err("arguments must be field references like {Status}".into());
    }
    Ok(Ty::DateTime)
}

fn record_id(_: &[Value], ev: &Evaluator) -> R {
    Ok(Value::Text(ev.ctx.record_id().to_string()))
}

fn created_time(_: &[Value], ev: &Evaluator) -> R {
    Ok(Value::DateTime(ev.ctx.created_time()))
}

/// `LAST_MODIFIED_TIME([{Field}, ...])`: the record's last modification, or
/// the latest modification of the listed fields when the context tracks it.
fn last_modified_time(args: &[Expr], ev: &Evaluator) -> R {
    let mut latest: Option<DateTime<Utc>> = None;
    for a in args {
        let Expr::Field { name, .. } = a else {
            return Err(err("LAST_MODIFIED_TIME arguments must be field references"));
        };
        let t = ev
            .ctx
            .field_modified_time(name)
            .unwrap_or_else(|| ev.ctx.last_modified_time());
        latest = Some(latest.map_or(t, |l| l.max(t)));
    }
    Ok(Value::DateTime(
        latest.unwrap_or_else(|| ev.ctx.last_modified_time()),
    ))
}
