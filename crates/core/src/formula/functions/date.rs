//! Date and time functions.
//!
//! Blank date input gives a blank result. Functions whose answer depends on
//! a timezone (date parts, formatting, `DATEADD`, `IS_SAME`) look through a
//! `SET_TIMEZONE(...)` / `SET_LOCALE(...)` passed directly as their date
//! argument; otherwise they use [`EvalContext::timezone`] (UTC by default).
//!
//! [`EvalContext::timezone`]: crate::formula::EvalContext::timezone

use chrono::{Datelike, NaiveDate, Timelike};
use chrono_tz::Tz;

use super::{
    FnSpec, Imp, arg, int, literal_text, num_arg, r_bool, r_date, r_datetime, r_number, r_text,
    text_arg,
};
use crate::formula::ast::Expr;
use crate::formula::coerce::{DateVal, R, err, num, preview, text, to_date, to_number, to_text};
use crate::formula::datetime::{
    Local, Unit, date_add, date_diff, default_format, format_moment, humanize, parse_date_text,
    parse_tz, parse_with_format, start_of, weeknum, workday, workday_diff,
};
use crate::formula::eval::Evaluator;
use crate::formula::types::Ty;
use crate::value::Value;

/// Upper bound on holidays passed to `WORKDAY`/`WORKDAY_DIFF`.
const MAX_HOLIDAYS: usize = 2_000;

pub(crate) const SPECS: &[FnSpec] = &[
    FnSpec::new("DATEADD", 3, Some(3), r_dateadd, Imp::Lazy(dateadd)),
    FnSpec::new("DATESTR", 1, Some(1), r_text, Imp::Lazy(datestr)),
    FnSpec::new(
        "DATETIME_DIFF",
        2,
        Some(3),
        r_unit_at_2,
        Imp::Eager(datetime_diff),
    ),
    FnSpec::new(
        "DATETIME_FORMAT",
        1,
        Some(2),
        r_text,
        Imp::Lazy(datetime_format),
    ),
    FnSpec::new(
        "DATETIME_PARSE",
        1,
        Some(3),
        r_datetime,
        Imp::Eager(datetime_parse),
    ),
    FnSpec::new("DAY", 1, Some(1), r_number, Imp::Lazy(day)),
    FnSpec::new("FROMNOW", 1, Some(1), r_text, Imp::Eager(fromnow)),
    FnSpec::new("HOUR", 1, Some(1), r_number, Imp::Lazy(hour)),
    FnSpec::new("IS_AFTER", 2, Some(2), r_bool, Imp::Eager(is_after)),
    FnSpec::new("IS_BEFORE", 2, Some(2), r_bool, Imp::Eager(is_before)),
    FnSpec::new("IS_SAME", 2, Some(3), r_is_same, Imp::Lazy(is_same)),
    FnSpec::new("MINUTE", 1, Some(1), r_number, Imp::Lazy(minute)),
    FnSpec::new("MONTH", 1, Some(1), r_number, Imp::Lazy(month)),
    FnSpec::new("NOW", 0, Some(0), r_datetime, Imp::Eager(now)),
    FnSpec::new("SECOND", 1, Some(1), r_number, Imp::Lazy(second)),
    FnSpec::new("SET_LOCALE", 2, Some(2), r_first, Imp::Eager(set_locale)),
    FnSpec::new(
        "SET_TIMEZONE",
        2,
        Some(2),
        r_set_timezone,
        Imp::Eager(set_timezone),
    ),
    FnSpec::new("TIMESTR", 1, Some(1), r_text, Imp::Lazy(timestr)),
    FnSpec::new("TODAY", 0, Some(0), r_date, Imp::Eager(today)),
    FnSpec::new("TONOW", 1, Some(1), r_text, Imp::Eager(tonow)),
    FnSpec::new("WEEKDAY", 1, Some(2), r_week_start, Imp::Lazy(weekday)),
    FnSpec::new("WEEKNUM", 1, Some(2), r_week_start, Imp::Lazy(weeknum_)),
    FnSpec::new("WORKDAY", 2, Some(3), r_date, Imp::Eager(workday_)),
    FnSpec::new(
        "WORKDAY_DIFF",
        2,
        Some(3),
        r_number,
        Imp::Eager(workday_diff_),
    ),
    FnSpec::new("YEAR", 1, Some(1), r_number, Imp::Lazy(year)),
];

// ---------------------------------------------------------------------------
// Save-time checks of literal arguments
// ---------------------------------------------------------------------------

fn check_unit(e: Option<&Expr>) -> Result<Option<Unit>, String> {
    match literal_text(e) {
        Some(u) => Unit::parse(u)
            .map(Some)
            .ok_or_else(|| format!("unknown unit '{u}'")),
        None => Ok(None),
    }
}

fn r_dateadd(tys: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    let unit = check_unit(args.get(2))?;
    let date_input = tys.first().map(Ty::leaf) == Some(Ty::Date);
    Ok(match unit {
        Some(u) if date_input && u >= Unit::Day => Ty::Date,
        _ => Ty::DateTime,
    })
}

fn r_unit_at_2(_: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    check_unit(args.get(2))?;
    Ok(Ty::Number)
}

fn r_is_same(_: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    check_unit(args.get(2))?;
    Ok(Ty::Bool)
}

fn r_first(tys: &[Ty], _: &[Expr]) -> Result<Ty, String> {
    Ok(tys.first().cloned().unwrap_or(Ty::Any))
}

fn r_set_timezone(tys: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    if let Some(tz) = literal_text(args.get(1))
        && parse_tz(tz).is_none()
    {
        return Err(format!("unknown timezone '{tz}'"));
    }
    r_first(tys, args)
}

fn r_week_start(_: &[Ty], args: &[Expr]) -> Result<Ty, String> {
    if let Some(s) = literal_text(args.get(1)) {
        parse_week_start(s)
            .map_err(|_| format!("week start must be 'Sunday' or 'Monday', not '{s}'"))?;
    }
    Ok(Ty::Number)
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/// Evaluates a date argument, looking through directly nested
/// `SET_TIMEZONE` / `SET_LOCALE` calls. The outermost `SET_TIMEZONE` wins.
fn date_arg(ev: &Evaluator, e: &Expr) -> R<Option<(DateVal, Tz)>> {
    let mut cur = e;
    let mut tz: Option<Tz> = None;
    while let Expr::Call { name, args, .. } = cur {
        if args.len() != 2 || !(name == "SET_TIMEZONE" || name == "SET_LOCALE") {
            break;
        }
        let second = ev.eval_ok(&args[1])?;
        if name == "SET_TIMEZONE" && tz.is_none() {
            tz = Some(tz_from(&second)?);
        }
        cur = &args[0];
    }
    let v = ev.eval_ok(cur)?;
    Ok(to_date(&v)?.map(|d| (d, tz.unwrap_or_else(|| ev.ctx.timezone()))))
}

fn tz_from(v: &Value) -> R<Tz> {
    let name = to_text(v)?;
    parse_tz(&name).ok_or_else(|| err(format!("Unknown timezone '{}'", preview(&name))))
}

fn local_arg(ev: &Evaluator, e: &Expr) -> R<Option<Local>> {
    Ok(date_arg(ev, e)?.map(|(d, tz)| Local::new(d, tz)))
}

fn unit_from(v: &Value, default: Unit) -> R<Unit> {
    let s = to_text(v)?;
    if s.trim().is_empty() {
        return Ok(default);
    }
    Unit::parse(&s).ok_or_else(|| err(format!("Unknown unit '{}'", preview(&s))))
}

/// A date argument for functions without timezone semantics.
fn plain_date(v: &Value) -> R<Option<DateVal>> {
    to_date(v)
}

/// Calendar date of a value in the context timezone.
fn calendar_date(d: DateVal, tz: Tz) -> NaiveDate {
    match d {
        DateVal::Date(day) => day,
        DateVal::Instant(t) => t.with_timezone(&tz).date_naive(),
    }
}

/// Date part extractor shared by `DAY`, `HOUR`, ... .
fn part(args: &[Expr], ev: &Evaluator, f: fn(&Local) -> u32) -> R {
    match local_arg(ev, &args[0])? {
        Some(l) => num(f64::from(f(&l))),
        None => Ok(Value::Null),
    }
}

fn parse_week_start(s: &str) -> Result<bool, ()> {
    match s.trim().to_ascii_lowercase().as_str() {
        "" | "sunday" => Ok(false),
        "monday" => Ok(true),
        _ => Err(()),
    }
}

fn week_start_arg(args: &[Expr], ev: &Evaluator) -> R<bool> {
    let Some(e) = args.get(1) else {
        return Ok(false);
    };
    let s = to_text(&ev.eval_ok(e)?)?;
    parse_week_start(&s).map_err(|_| {
        err(format!(
            "Week start must be 'Sunday' or 'Monday', not '{}'",
            preview(&s)
        ))
    })
}

/// Holidays from comma-separated date text, dates, or arrays of either.
fn holidays(v: &Value, tz: Tz) -> R<Vec<NaiveDate>> {
    let mut out = Vec::new();
    let mut leaves = Vec::new();
    crate::formula::coerce::for_each_leaf(std::slice::from_ref(v), &mut |l| leaves.push(l));
    for leaf in leaves {
        match leaf {
            Value::Null => {}
            Value::Text(s) => {
                for piece in s.split(',') {
                    let piece = piece.trim();
                    if piece.is_empty() {
                        continue;
                    }
                    let d = parse_date_text(piece).ok_or_else(|| {
                        err(format!(
                            "Cannot read holiday '{}' as a date",
                            preview(piece)
                        ))
                    })?;
                    out.push(calendar_date(d, tz));
                }
            }
            other => {
                if let Some(d) = to_date(other)? {
                    out.push(calendar_date(d, tz));
                }
            }
        }
        if out.len() > MAX_HOLIDAYS {
            return Err(err(format!("Too many holidays (maximum {MAX_HOLIDAYS})")));
        }
    }
    Ok(out)
}

fn out_of_range() -> Value {
    err("Date out of range")
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

/// `DATEADD(date, count, unit)`.
fn dateadd(args: &[Expr], ev: &Evaluator) -> R {
    let date = date_arg(ev, &args[0])?;
    let count = to_number(&ev.eval_ok(&args[1])?)?;
    let unit = unit_from(&ev.eval_ok(&args[2])?, Unit::Day)?;
    let Some((d, tz)) = date else {
        return Ok(Value::Null);
    };
    date_add(d, count, unit, tz)
        .map(DateVal::to_value)
        .ok_or_else(out_of_range)
}

/// `DATESTR(date)`: `YYYY-MM-DD`.
fn datestr(args: &[Expr], ev: &Evaluator) -> R {
    Ok(match local_arg(ev, &args[0])? {
        Some(l) => Value::Text(format_moment(&l, "YYYY-MM-DD")),
        None => Value::Null,
    })
}

/// `TIMESTR(date)`: `HH:mm:ss`.
fn timestr(args: &[Expr], ev: &Evaluator) -> R {
    Ok(match local_arg(ev, &args[0])? {
        Some(l) => Value::Text(format_moment(&l, "HH:mm:ss")),
        None => Value::Null,
    })
}

/// `DATETIME_DIFF(date1, date2, [unit='seconds'])`: `date1 - date2`.
fn datetime_diff(a: &[Value], _: &Evaluator) -> R {
    let unit = unit_from(arg(a, 2), Unit::Second)?;
    let (Some(x), Some(y)) = (plain_date(arg(a, 0))?, plain_date(arg(a, 1))?) else {
        return Ok(Value::Null);
    };
    date_diff(x, y, unit).map_or_else(|| Err(out_of_range()), num)
}

/// `DATETIME_FORMAT(date, [format])` with Moment.js tokens.
fn datetime_format(args: &[Expr], ev: &Evaluator) -> R {
    let local = local_arg(ev, &args[0])?;
    let fmt = match args.get(1) {
        Some(e) => to_text(&ev.eval_ok(e)?)?,
        None => String::new(),
    };
    let Some(l) = local else {
        return Ok(Value::Null);
    };
    if fmt.is_empty() {
        return Ok(Value::Text(default_format(&l)));
    }
    if fmt.len() > 1_000 {
        return Err(err("Date format is too long"));
    }
    text(format_moment(&l, &fmt))
}

/// `DATETIME_PARSE(text, [format], [locale])`.
fn datetime_parse(a: &[Value], ev: &Evaluator) -> R {
    let input = arg(a, 0);
    match input {
        Value::Date(_) | Value::DateTime(_) => {
            return Ok(plain_date(input)?
                .map(|d| Value::DateTime(d.instant()))
                .unwrap_or(Value::Null));
        }
        _ => {}
    }
    let s = to_text(input)?;
    if s.trim().is_empty() {
        return Ok(Value::Null);
    }
    let fmt = text_arg(a, 1)?;
    let parsed = if fmt.trim().is_empty() {
        parse_date_text(&s).map(DateVal::instant)
    } else {
        parse_with_format(&s, &fmt, ev.ctx.now().year())
    };
    parsed
        .map(Value::DateTime)
        .ok_or_else(|| err(format!("DATETIME_PARSE could not read '{}'", preview(&s))))
}

fn day(args: &[Expr], ev: &Evaluator) -> R {
    part(args, ev, |l| l.naive.day())
}

fn month(args: &[Expr], ev: &Evaluator) -> R {
    part(args, ev, |l| l.naive.month())
}

fn year(args: &[Expr], ev: &Evaluator) -> R {
    match local_arg(ev, &args[0])? {
        Some(l) => num(f64::from(l.naive.year())),
        None => Ok(Value::Null),
    }
}

fn hour(args: &[Expr], ev: &Evaluator) -> R {
    part(args, ev, |l| l.naive.hour())
}

fn minute(args: &[Expr], ev: &Evaluator) -> R {
    part(args, ev, |l| l.naive.minute())
}

fn second(args: &[Expr], ev: &Evaluator) -> R {
    part(args, ev, |l| l.naive.second())
}

/// `WEEKDAY(date, [start])`: 0–6 from Sunday, or from Monday with "Monday".
fn weekday(args: &[Expr], ev: &Evaluator) -> R {
    let monday = week_start_arg(args, ev)?;
    match local_arg(ev, &args[0])? {
        Some(l) => {
            let wd = l.naive.weekday();
            let n = if monday {
                wd.num_days_from_monday()
            } else {
                wd.num_days_from_sunday()
            };
            num(f64::from(n))
        }
        None => Ok(Value::Null),
    }
}

/// `WEEKNUM(date, [start])`: week of the year, week 1 contains January 1.
fn weeknum_(args: &[Expr], ev: &Evaluator) -> R {
    let monday = week_start_arg(args, ev)?;
    match local_arg(ev, &args[0])? {
        Some(l) => num(f64::from(weeknum(l.naive.date(), monday))),
        None => Ok(Value::Null),
    }
}

fn compare_dates(
    a: &[Value],
    f: fn(chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>) -> bool,
) -> R {
    match (plain_date(arg(a, 0))?, plain_date(arg(a, 1))?) {
        (Some(x), Some(y)) => Ok(Value::Bool(f(x.instant(), y.instant()))),
        _ => Ok(Value::Null),
    }
}

fn is_after(a: &[Value], _: &Evaluator) -> R {
    compare_dates(a, |x, y| x > y)
}

fn is_before(a: &[Value], _: &Evaluator) -> R {
    compare_dates(a, |x, y| x < y)
}

/// `IS_SAME(date1, date2, [unit])`: equal after truncating both to `unit`
/// (exact to the millisecond by default).
fn is_same(args: &[Expr], ev: &Evaluator) -> R {
    let first = date_arg(ev, &args[0])?;
    let second = date_arg(ev, &args[1])?;
    let unit = match args.get(2) {
        Some(e) => unit_from(&ev.eval_ok(e)?, Unit::Millisecond)?,
        None => Unit::Millisecond,
    };
    let (Some((x, tz)), Some((y, _))) = (first, second) else {
        return Ok(Value::Null);
    };
    if unit == Unit::Millisecond {
        return Ok(Value::Bool(x.instant() == y.instant()));
    }
    let lx = Local::new(x, tz).naive;
    let ly = Local::new(y, tz).naive;
    Ok(Value::Bool(start_of(lx, unit) == start_of(ly, unit)))
}

fn now(_: &[Value], ev: &Evaluator) -> R {
    Ok(Value::DateTime(ev.ctx.now()))
}

/// `TODAY()`: the current date in the context timezone.
fn today(_: &[Value], ev: &Evaluator) -> R {
    Ok(Value::Date(
        ev.ctx.now().with_timezone(&ev.ctx.timezone()).date_naive(),
    ))
}

/// `SET_LOCALE(date, locale)`: accepted for compatibility; output stays English.
fn set_locale(a: &[Value], _: &Evaluator) -> R {
    Ok(arg(a, 0).clone())
}

/// `SET_TIMEZONE(date, tz)`: validates the zone and returns the date. The
/// zone takes effect only when this call is the direct date argument of
/// another date function (see the module docs).
fn set_timezone(a: &[Value], _: &Evaluator) -> R {
    tz_from(arg(a, 1))?;
    Ok(arg(a, 0).clone())
}

fn relative(a: &[Value], ev: &Evaluator) -> R {
    match plain_date(arg(a, 0))? {
        Some(d) => Ok(Value::Text(humanize(ev.ctx.now() - d.instant()))),
        None => Ok(Value::Null),
    }
}

/// `TONOW(date)`: humanized distance between the date and now ("3 days").
fn tonow(a: &[Value], ev: &Evaluator) -> R {
    relative(a, ev)
}

/// `FROMNOW(date)`: same distance as `TONOW`, provided for compatibility.
fn fromnow(a: &[Value], ev: &Evaluator) -> R {
    relative(a, ev)
}

/// `WORKDAY(start, days, [holidays])`.
fn workday_(a: &[Value], ev: &Evaluator) -> R {
    let tz = ev.ctx.timezone();
    let start = plain_date(arg(a, 0))?;
    let n = int(num_arg(a, 1)?);
    let hol = holidays(arg(a, 2), tz)?;
    let Some(start) = start else {
        return Ok(Value::Null);
    };
    workday(calendar_date(start, tz), n, &hol)
        .map(Value::Date)
        .ok_or_else(out_of_range)
}

/// `WORKDAY_DIFF(start, end, [holidays])`: inclusive count of workdays.
fn workday_diff_(a: &[Value], ev: &Evaluator) -> R {
    let tz = ev.ctx.timezone();
    let start = plain_date(arg(a, 0))?;
    let end = plain_date(arg(a, 1))?;
    let hol = holidays(arg(a, 2), tz)?;
    match (start, end) {
        (Some(s), Some(e)) => {
            num(workday_diff(calendar_date(s, tz), calendar_date(e, tz), &hol) as f64)
        }
        _ => Ok(Value::Null),
    }
}
