//! Date filter operands: relative modes resolved to calendar days.

use chrono::{Datelike, Days, Months, NaiveDate};
use chrono_tz::Tz;
use serde_json::Value as Json;

use crate::cell::parse::{ParsedDate, parse_date};
use crate::field::Field;
use crate::value::Value;
use crate::view::DateOperand;

/// Largest `days` accepted in relative operands (~270 years).
pub(crate) const MAX_RELATIVE_DAYS: u32 = 100_000;

/// Whether `op` is one of the `is_within` range modes.
pub(crate) fn is_range_mode(op: &DateOperand) -> bool {
    matches!(
        op,
        DateOperand::PastWeek
            | DateOperand::PastMonth
            | DateOperand::PastYear
            | DateOperand::NextWeek
            | DateOperand::NextMonth
            | DateOperand::NextYear
            | DateOperand::PastNumberOfDays { .. }
            | DateOperand::NextNumberOfDays { .. }
            | DateOperand::ThisCalendarMonth
            | DateOperand::ThisCalendarYear
    )
}

/// The `days` of a relative operand, if it has one.
pub(crate) fn operand_days(op: &DateOperand) -> Option<u32> {
    match op {
        DateOperand::NumberOfDaysAgo { days }
        | DateOperand::NumberOfDaysFromNow { days }
        | DateOperand::PastNumberOfDays { days }
        | DateOperand::NextNumberOfDays { days } => Some(*days),
        _ => None,
    }
}

/// Parse the date of an `exact_date` operand (any supported date format;
/// a time or offset is dropped, keeping the written calendar day).
pub(crate) fn parse_exact(s: &str) -> Option<NaiveDate> {
    match parse_date(s, false)? {
        ParsedDate::Date(d) => Some(d),
        ParsedDate::Local(l) => Some(l.date()),
        ParsedDate::Instant(i) => Some(i.date_naive()),
    }
}

fn add(d: NaiveDate, days: u32) -> Option<NaiveDate> {
    d.checked_add_days(Days::new(u64::from(days)))
}

fn sub(d: NaiveDate, days: u32) -> Option<NaiveDate> {
    d.checked_sub_days(Days::new(u64::from(days)))
}

/// Resolve a single-day operand relative to `today`. Range modes → `None`.
pub(crate) fn resolve_day(op: &DateOperand, today: NaiveDate) -> Option<NaiveDate> {
    match op {
        DateOperand::Today => Some(today),
        DateOperand::Tomorrow => add(today, 1),
        DateOperand::Yesterday => sub(today, 1),
        DateOperand::OneWeekAgo => sub(today, 7),
        DateOperand::OneWeekFromNow => add(today, 7),
        DateOperand::OneMonthAgo => today.checked_sub_months(Months::new(1)),
        DateOperand::OneMonthFromNow => today.checked_add_months(Months::new(1)),
        DateOperand::NumberOfDaysAgo { days } => sub(today, *days),
        DateOperand::NumberOfDaysFromNow { days } => add(today, *days),
        DateOperand::ExactDate { date } => parse_exact(date),
        _ => None,
    }
}

/// Resolve an `is_within` operand to an inclusive day range. "Past/next
/// week/month/year" are rolling 7/30/365 days including today (as in
/// Airtable); calendar modes cover the whole current month/year.
pub(crate) fn resolve_range(op: &DateOperand, today: NaiveDate) -> Option<(NaiveDate, NaiveDate)> {
    match op {
        DateOperand::PastWeek => Some((sub(today, 7)?, today)),
        DateOperand::PastMonth => Some((sub(today, 30)?, today)),
        DateOperand::PastYear => Some((sub(today, 365)?, today)),
        DateOperand::NextWeek => Some((today, add(today, 7)?)),
        DateOperand::NextMonth => Some((today, add(today, 30)?)),
        DateOperand::NextYear => Some((today, add(today, 365)?)),
        DateOperand::PastNumberOfDays { days } => Some((sub(today, *days)?, today)),
        DateOperand::NextNumberOfDays { days } => Some((today, add(today, *days)?)),
        DateOperand::ThisCalendarMonth => {
            let first = today.with_day(1)?;
            let last = first.checked_add_months(Months::new(1))?.pred_opt()?;
            Some((first, last))
        }
        DateOperand::ThisCalendarYear => Some((
            NaiveDate::from_ymd_opt(today.year(), 1, 1)?,
            NaiveDate::from_ymd_opt(today.year(), 12, 31)?,
        )),
        _ => None,
    }
}

/// The calendar day of a date cell: date-only values as stored; instants in
/// the field's fixed zone, else `tz`.
pub(crate) fn cell_day(field: &Field, stored: Option<&Json>, tz: Tz) -> Option<NaiveDate> {
    match crate::cell::to_value(field, stored, &crate::cell::NoNames) {
        Value::Date(d) => Some(d),
        Value::DateTime(i) => {
            let zone = crate::cell::date_options_of(field)
                .and_then(|o| o.timezone)
                .and_then(|z| z.parse::<Tz>().ok())
                .unwrap_or(tz);
            Some(i.with_timezone(&zone).date_naive())
        }
        _ => None,
    }
}
