//! Numeric functions. Aggregates (`SUM`, `AVERAGE`, `MAX`, `MIN`, `COUNT*`)
//! take any mix of values and arrays (rollup inputs) and flatten them.

use super::{FnSpec, Imp, arg, int, num_arg, opt_num_arg, r_number};
use crate::formula::ast::Expr;
use crate::formula::coerce::{R, err, flatten, num, parse_number_text, preview, to_text};
use crate::formula::eval::Evaluator;
use crate::formula::types::Ty;
use crate::value::Value;

pub(crate) const SPECS: &[FnSpec] = &[
    FnSpec::new("ABS", 1, Some(1), r_number, Imp::Eager(abs)),
    FnSpec::new("AVERAGE", 1, None, r_number, Imp::Eager(average)),
    FnSpec::new("CEILING", 1, Some(2), r_number, Imp::Eager(ceiling)),
    FnSpec::new("COUNT", 1, None, r_number, Imp::Eager(count)),
    FnSpec::new("COUNTA", 1, None, r_number, Imp::Eager(counta)),
    FnSpec::new("COUNTALL", 1, None, r_number, Imp::Eager(countall)),
    FnSpec::new("EVEN", 1, Some(1), r_number, Imp::Eager(even)),
    FnSpec::new("EXP", 1, Some(1), r_number, Imp::Eager(exp)),
    FnSpec::new("FLOOR", 1, Some(2), r_number, Imp::Eager(floor)),
    FnSpec::new("INT", 1, Some(1), r_number, Imp::Eager(int_)),
    FnSpec::new("LOG", 1, Some(2), r_number, Imp::Eager(log)),
    FnSpec::new("MAX", 1, None, r_minmax, Imp::Eager(max)),
    FnSpec::new("MIN", 1, None, r_minmax, Imp::Eager(min)),
    FnSpec::new("MOD", 2, Some(2), r_number, Imp::Eager(mod_)),
    FnSpec::new("ODD", 1, Some(1), r_number, Imp::Eager(odd)),
    FnSpec::new("POWER", 2, Some(2), r_number, Imp::Eager(power)),
    FnSpec::new("ROUND", 1, Some(2), r_number, Imp::Eager(round)),
    FnSpec::new("ROUNDDOWN", 1, Some(2), r_number, Imp::Eager(rounddown)),
    FnSpec::new("ROUNDUP", 1, Some(2), r_number, Imp::Eager(roundup)),
    FnSpec::new("SQRT", 1, Some(1), r_number, Imp::Eager(sqrt)),
    FnSpec::new("SUM", 1, None, r_number, Imp::Eager(sum)),
    FnSpec::new("VALUE", 1, Some(1), r_number, Imp::Eager(value)),
];

/// `MAX`/`MIN` of dates are dates; otherwise numbers.
fn r_minmax(tys: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    let leaves: Vec<Ty> = tys.iter().map(Ty::leaf).collect();
    if !leaves.is_empty() && leaves.iter().all(Ty::is_dateish) {
        if leaves.iter().all(|t| *t == Ty::Date) {
            return Ok(Ty::Date);
        }
        return Ok(Ty::DateTime);
    }
    Ok(Ty::Number)
}

/// Rounds to 15 significant digits to remove binary noise such as
/// `1.005 * 100 = 100.49999999999999`.
fn snap(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 {
        return x;
    }
    format!("{x:.14e}").parse().unwrap_or(x)
}

/// Precision argument clamped to a range where `10^p` is finite.
fn precision(a: &[Value], i: usize) -> R<i32> {
    Ok(int(opt_num_arg(a, i, 0.0)?).clamp(-300, 300) as i32)
}

/// Applies `f` to `x` scaled by `10^p`, then scales back.
fn at_precision(x: f64, p: i32, f: impl Fn(f64) -> f64) -> R {
    if p > 15 {
        return num(x);
    }
    let scale = 10f64.powi(p);
    num(snap(f(snap(x * scale)) / scale))
}

fn abs(a: &[Value], _: &Evaluator) -> R {
    num(num_arg(a, 0)?.abs())
}

/// `ROUND`: ties go toward positive infinity, as in Airtable.
fn round(a: &[Value], _: &Evaluator) -> R {
    let x = num_arg(a, 0)?;
    at_precision(x, precision(a, 1)?, |v| (v + 0.5).floor())
}

/// `ROUNDUP`: away from zero.
fn roundup(a: &[Value], _: &Evaluator) -> R {
    let x = num_arg(a, 0)?;
    at_precision(x, precision(a, 1)?, |v| v.signum() * v.abs().ceil())
}

/// `ROUNDDOWN`: toward zero.
fn rounddown(a: &[Value], _: &Evaluator) -> R {
    let x = num_arg(a, 0)?;
    at_precision(x, precision(a, 1)?, f64::trunc)
}

fn to_multiple(a: &[Value], f: fn(f64) -> f64) -> R {
    let x = num_arg(a, 0)?;
    let sig = opt_num_arg(a, 1, 1.0)?.abs();
    if sig == 0.0 {
        return num(0.0);
    }
    num(snap(f(snap(x / sig)) * sig))
}

/// `CEILING(value, [significance])`: nearest multiple at or above.
fn ceiling(a: &[Value], _: &Evaluator) -> R {
    to_multiple(a, f64::ceil)
}

/// `FLOOR(value, [significance])`: nearest multiple at or below.
fn floor(a: &[Value], _: &Evaluator) -> R {
    to_multiple(a, f64::floor)
}

fn int_(a: &[Value], _: &Evaluator) -> R {
    num(num_arg(a, 0)?.floor())
}

/// Rounds away from zero to the nearest even (or odd) integer.
fn to_parity(x: f64, want_odd: bool) -> R {
    let mut n = x.abs().ceil();
    let is_odd = n % 2.0 == 1.0;
    if is_odd != want_odd {
        n += 1.0;
    }
    num(if x < 0.0 { -n } else { n })
}

fn even(a: &[Value], _: &Evaluator) -> R {
    to_parity(num_arg(a, 0)?, false)
}

fn odd(a: &[Value], _: &Evaluator) -> R {
    to_parity(num_arg(a, 0)?, true)
}

fn exp(a: &[Value], _: &Evaluator) -> R {
    num(num_arg(a, 0)?.exp())
}

/// `LOG(number, [base=10])`.
fn log(a: &[Value], _: &Evaluator) -> R {
    let x = num_arg(a, 0)?;
    let base = opt_num_arg(a, 1, 10.0)?;
    if x <= 0.0 {
        return Err(err("LOG needs a number greater than 0"));
    }
    if base <= 0.0 || base == 1.0 {
        return Err(err("LOG base must be greater than 0 and not 1"));
    }
    num(x.ln() / base.ln())
}

/// `MOD(value, divisor)`: the remainder takes the sign of `value`.
fn mod_(a: &[Value], _: &Evaluator) -> R {
    let x = num_arg(a, 0)?;
    let d = num_arg(a, 1)?;
    if d == 0.0 {
        return Err(err("Division by zero"));
    }
    num(x % d)
}

fn power(a: &[Value], _: &Evaluator) -> R {
    num(num_arg(a, 0)?.powf(num_arg(a, 1)?))
}

fn sqrt(a: &[Value], _: &Evaluator) -> R {
    let x = num_arg(a, 0)?;
    if x < 0.0 {
        return Err(err("SQRT of a negative number"));
    }
    num(x.sqrt())
}

/// Numbers among the (flattened) arguments: numbers, booleans and numeric
/// text count; blanks, other text and dates are skipped.
fn numbers(a: &[Value]) -> R<Vec<f64>> {
    Ok(flatten(a)?
        .iter()
        .filter_map(|v| match v {
            Value::Number(n) if n.is_finite() => Some(*n),
            Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Value::Text(s) if !s.trim().is_empty() => parse_number_text(s),
            _ => None,
        })
        .collect())
}

fn sum(a: &[Value], _: &Evaluator) -> R {
    num(numbers(a)?.iter().sum())
}

/// `AVERAGE`: blank when there are no numbers.
fn average(a: &[Value], _: &Evaluator) -> R {
    let ns = numbers(a)?;
    if ns.is_empty() {
        return Ok(Value::Null);
    }
    num(ns.iter().sum::<f64>() / ns.len() as f64)
}

/// `MAX`/`MIN`: over numbers, or over dates when there are no numbers.
/// Blank when there is nothing to compare.
fn extreme(a: &[Value], want_max: bool) -> R {
    let ns = numbers(a)?;
    if !ns.is_empty() {
        let pick = if want_max { f64::max } else { f64::min };
        return num(ns.into_iter().reduce(pick).unwrap_or(0.0));
    }
    let mut best: Option<(chrono::DateTime<chrono::Utc>, Value)> = None;
    for v in flatten(a)? {
        let t = match &v {
            Value::Date(d) => crate::formula::coerce::naive_midnight(*d).and_utc(),
            Value::DateTime(t) => *t,
            _ => continue,
        };
        let better = match &best {
            None => true,
            Some((b, _)) => (want_max && t > *b) || (!want_max && t < *b),
        };
        if better {
            best = Some((t, v));
        }
    }
    Ok(best.map(|(_, v)| v).unwrap_or(Value::Null))
}

fn max(a: &[Value], _: &Evaluator) -> R {
    extreme(a, true)
}

fn min(a: &[Value], _: &Evaluator) -> R {
    extreme(a, false)
}

/// `COUNT`: number of numeric items.
fn count(a: &[Value], _: &Evaluator) -> R {
    let n = flatten(a)?
        .iter()
        .filter(|v| matches!(v, Value::Number(_)))
        .count();
    num(n as f64)
}

/// `COUNTA`: number of non-blank items.
fn counta(a: &[Value], _: &Evaluator) -> R {
    num(flatten(a)?.iter().filter(|v| !v.is_blank()).count() as f64)
}

/// `COUNTALL`: number of items, blanks included.
fn countall(a: &[Value], _: &Evaluator) -> R {
    num(flatten(a)?.len() as f64)
}

/// `VALUE(text)`: reads a number out of formatted text such as `"$1,000.50"`
/// or `"50%"`. Blank text is blank.
fn value(a: &[Value], _: &Evaluator) -> R {
    let v = arg(a, 0);
    if let Value::Number(_) = v {
        return Ok(v.clone());
    }
    let s = to_text(v)?;
    let t = s.trim();
    if t.is_empty() {
        return Ok(Value::Null);
    }
    if let Some(n) = parse_number_text(t) {
        return num(n);
    }
    let percent = t.ends_with('%');
    let negative = t.starts_with('(') && t.ends_with(')');
    let kept: String = t
        .chars()
        .filter(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | 'e' | 'E'))
        .collect();
    let kept = kept.trim_matches(|c| c == 'e' || c == 'E');
    match kept.parse::<f64>() {
        Ok(n) if n.is_finite() && kept.chars().any(|c| c.is_ascii_digit()) => {
            let n = if negative { -n.abs() } else { n };
            num(if percent { n / 100.0 } else { n })
        }
        _ => Err(err(format!(
            "VALUE could not read a number from '{}'",
            preview(t)
        ))),
    }
}
