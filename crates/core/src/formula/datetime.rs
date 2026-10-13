//! Date and time support for formulas: lenient text parsing, Moment.js-style
//! format tokens (output and parsing), `DATEADD`/`DATETIME_DIFF` units,
//! timezone-aware local views, humanized durations and workday arithmetic.
//!
//! All arithmetic uses checked chrono operations, so absurd inputs produce
//! `None` (reported as an error by the caller) instead of panicking.

use chrono::{
    DateTime, Datelike, Days, FixedOffset, Months, NaiveDate, NaiveDateTime, NaiveTime, Offset,
    TimeDelta, TimeZone, Timelike, Utc, Weekday,
};
use chrono_tz::Tz;

use super::coerce::{DateVal, naive_midnight};

// ---------------------------------------------------------------------------
// Lenient parsing of date text (no explicit format)
// ---------------------------------------------------------------------------

const OFFSET_FORMATS: &[&str] = &[
    "%Y-%m-%dT%H:%M:%S%.f%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M%z",
    "%Y-%m-%d %H:%M:%S%.f%z",
    "%Y-%m-%d %H:%M:%S%z",
    "%Y-%m-%d %H:%M:%S %z",
    "%Y-%m-%d %H:%M%z",
];

const DATETIME_FORMATS: &[&str] = &[
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y/%m/%d %H:%M",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%Y %I:%M%p",
    "%B %d, %Y %I:%M %p",
    "%B %d, %Y %H:%M",
    "%B %d %Y %I:%M %p",
    "%B %d %Y %H:%M",
    "%d %B %Y %H:%M",
];

const DATE_FORMATS: &[&str] = &[
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%m/%d/%Y",
    "%m-%d-%Y",
    "%B %d, %Y",
    "%B %d %Y",
    "%d %B %Y",
    "%d %B, %Y",
    "%A, %B %d, %Y",
    "%a, %B %d, %Y",
];

/// Parses date text in the common formats people and other systems write:
/// ISO 8601 / RFC 3339 (with or without offset), `YYYY/MM/DD`, US
/// `M/D/YYYY` with optional 12/24-hour time, and English month names.
/// Date-only text yields a calendar date; text without an offset is UTC.
pub(crate) fn parse_date_text(s: &str) -> Option<DateVal> {
    let s = s.trim();
    if s.is_empty() || s.len() > 100 {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(DateVal::Instant(dt.with_timezone(&Utc)));
    }
    for f in OFFSET_FORMATS {
        if let Ok(dt) = DateTime::parse_from_str(s, f) {
            return Some(DateVal::Instant(dt.with_timezone(&Utc)));
        }
    }
    let (body, utc_suffix) = match s.strip_suffix('Z').or_else(|| s.strip_suffix(" UTC")) {
        Some(b) => (b.trim_end(), true),
        None => (s, false),
    };
    for f in DATETIME_FORMATS {
        if let Ok(n) = NaiveDateTime::parse_from_str(body, f) {
            return Some(DateVal::Instant(n.and_utc()));
        }
    }
    if !utc_suffix {
        for f in DATE_FORMATS {
            if let Ok(d) = NaiveDate::parse_from_str(body, f) {
                return Some(DateVal::Date(d));
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Timezones and local views
// ---------------------------------------------------------------------------

/// Parses an IANA timezone name (`"America/New_York"`, `"UTC"`).
pub(crate) fn parse_tz(name: &str) -> Option<Tz> {
    name.trim().parse::<Tz>().ok()
}

/// A date seen in a particular timezone.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Local {
    pub naive: NaiveDateTime,
    pub offset_secs: i32,
    pub utc: DateTime<Utc>,
    /// True when the zone is UTC (affects the default ISO output: `Z` vs `+00:00`).
    pub is_utc: bool,
}

impl Local {
    /// Calendar dates are not shifted by the zone: `DAY` of a date-only
    /// value is always its own day.
    pub(crate) fn new(d: DateVal, tz: Tz) -> Local {
        let is_utc = tz == chrono_tz::UTC;
        match d {
            DateVal::Instant(t) => {
                let z = t.with_timezone(&tz);
                Local {
                    naive: z.naive_local(),
                    offset_secs: z.offset().fix().local_minus_utc(),
                    utc: t,
                    is_utc,
                }
            }
            DateVal::Date(day) => {
                let naive = naive_midnight(day);
                let utc = from_local(naive, tz).unwrap_or_else(|| naive.and_utc());
                Local {
                    naive,
                    offset_secs: utc.with_timezone(&tz).offset().fix().local_minus_utc(),
                    utc,
                    is_utc,
                }
            }
        }
    }
}

/// Converts a local wall-clock time in `tz` to UTC. Ambiguous times (DST
/// fall-back) take the earlier instant; nonexistent times (spring-forward
/// gap) are moved forward by the gap.
pub(crate) fn from_local(naive: NaiveDateTime, tz: Tz) -> Option<DateTime<Utc>> {
    match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => Some(t.with_timezone(&Utc)),
        chrono::LocalResult::Ambiguous(a, _) => Some(a.with_timezone(&Utc)),
        chrono::LocalResult::None => {
            let shifted = naive.checked_add_signed(TimeDelta::hours(1))?;
            tz.from_local_datetime(&shifted)
                .earliest()
                .map(|t| t.with_timezone(&Utc))
        }
    }
}

// ---------------------------------------------------------------------------
// Units for DATEADD / DATETIME_DIFF / IS_SAME
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Unit {
    Millisecond,
    Second,
    Minute,
    Hour,
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

impl Unit {
    /// Accepts Moment's names: long forms and plurals in any case, and the
    /// case-sensitive short forms `ms s m h d w M Q y`.
    pub(crate) fn parse(s: &str) -> Option<Unit> {
        let s = s.trim();
        let short = match s {
            "ms" => Some(Unit::Millisecond),
            "s" => Some(Unit::Second),
            "m" => Some(Unit::Minute),
            "h" => Some(Unit::Hour),
            "d" => Some(Unit::Day),
            "w" => Some(Unit::Week),
            "M" => Some(Unit::Month),
            "Q" => Some(Unit::Quarter),
            "y" => Some(Unit::Year),
            _ => None,
        };
        if short.is_some() {
            return short;
        }
        let lower = s.to_ascii_lowercase();
        let singular = lower.strip_suffix('s').unwrap_or(&lower);
        Some(match singular {
            "millisecond" => Unit::Millisecond,
            "second" => Unit::Second,
            "minute" => Unit::Minute,
            "hour" => Unit::Hour,
            "day" => Unit::Day,
            "week" => Unit::Week,
            "month" => Unit::Month,
            "quarter" => Unit::Quarter,
            "year" => Unit::Year,
            _ => return None,
        })
    }

    /// Milliseconds per unit for the fixed-length units.
    fn fixed_ms(self) -> Option<f64> {
        Some(match self {
            Unit::Millisecond => 1.0,
            Unit::Second => 1_000.0,
            Unit::Minute => 60_000.0,
            Unit::Hour => 3_600_000.0,
            Unit::Day => 86_400_000.0,
            Unit::Week => 604_800_000.0,
            _ => return None,
        })
    }
}

/// Round half away from zero, as Moment does for fractional day/month counts.
fn round_count(n: f64) -> Option<i64> {
    let r = n.round();
    if r.abs() > 1e12 { None } else { Some(r as i64) }
}

fn add_months_naive(n: NaiveDateTime, months: i64) -> Option<NaiveDateTime> {
    let m = u32::try_from(months.unsigned_abs()).ok()?;
    if months >= 0 {
        n.checked_add_months(Months::new(m))
    } else {
        n.checked_sub_months(Months::new(m))
    }
}

fn add_days_naive(n: NaiveDateTime, days: i64) -> Option<NaiveDateTime> {
    let d = Days::new(days.unsigned_abs());
    if days >= 0 {
        n.checked_add_days(d)
    } else {
        n.checked_sub_days(d)
    }
}

/// Calendar addition of whole days/weeks/months/quarters/years to a local time.
fn add_calendar(n: NaiveDateTime, count: i64, unit: Unit) -> Option<NaiveDateTime> {
    match unit {
        Unit::Day => add_days_naive(n, count),
        Unit::Week => add_days_naive(n, count.checked_mul(7)?),
        Unit::Month => add_months_naive(n, count),
        Unit::Quarter => add_months_naive(n, count.checked_mul(3)?),
        Unit::Year => add_months_naive(n, count.checked_mul(12)?),
        _ => None,
    }
}

/// `DATEADD`. Calendar dates stay dates for day-or-larger units. Instants
/// get calendar units applied on the wall clock of `tz` (so adding a day
/// across a DST change keeps the time of day) and fixed units as exact
/// durations. Fractional calendar counts round like Moment.
pub(crate) fn date_add(d: DateVal, count: f64, unit: Unit, tz: Tz) -> Option<DateVal> {
    if !count.is_finite() {
        return None;
    }
    if unit >= Unit::Day {
        let whole = round_count(count)?;
        return match d {
            DateVal::Date(day) => {
                let n = add_calendar(naive_midnight(day), whole, unit)?;
                Some(DateVal::Date(n.date()))
            }
            DateVal::Instant(t) => {
                let local = t.with_timezone(&tz).naive_local();
                let moved = add_calendar(local, whole, unit)?;
                Some(DateVal::Instant(from_local(moved, tz)?))
            }
        };
    }
    let ms = count * unit.fixed_ms()?;
    if !ms.is_finite() || ms.abs() > 1e17 {
        return None;
    }
    let delta = TimeDelta::try_milliseconds(ms.round() as i64)?;
    let start = match d {
        DateVal::Date(day) => from_local(naive_midnight(day), tz)?,
        DateVal::Instant(t) => t,
    };
    start.checked_add_signed(delta).map(DateVal::Instant)
}

/// Fractional months from `b` to `a` (positive when `a` is later), using
/// Moment's algorithm: whole months plus the fraction of the next month.
fn month_diff(a: NaiveDateTime, b: NaiveDateTime) -> Option<f64> {
    if a < b {
        return month_diff(b, a).map(|m| -m);
    }
    let mut whole = (i64::from(a.year()) - i64::from(b.year())) * 12 + i64::from(a.month())
        - i64::from(b.month());
    let mut anchor = add_months_naive(b, whole)?;
    if anchor > a {
        whole -= 1;
        anchor = add_months_naive(b, whole)?;
    }
    let next = add_months_naive(b, whole + 1)?;
    let span = (next - anchor).num_milliseconds() as f64;
    let part = (a - anchor).num_milliseconds() as f64;
    Some(whole as f64 + if span > 0.0 { part / span } else { 0.0 })
}

/// `DATETIME_DIFF(a, b, unit)`: `a - b` in whole units, truncated toward zero.
pub(crate) fn date_diff(a: DateVal, b: DateVal, unit: Unit) -> Option<f64> {
    let (ia, ib) = (a.instant(), b.instant());
    let r = match unit {
        Unit::Month | Unit::Quarter | Unit::Year => {
            let months = month_diff(ia.naive_utc(), ib.naive_utc())?;
            match unit {
                Unit::Month => months,
                Unit::Quarter => months / 3.0,
                _ => months / 12.0,
            }
        }
        fixed => (ia - ib).num_milliseconds() as f64 / fixed.fixed_ms()?,
    };
    Some(r.trunc())
}

/// Truncates a local time to the start of `unit` (weeks start on Sunday).
pub(crate) fn start_of(n: NaiveDateTime, unit: Unit) -> NaiveDateTime {
    let date = n.date();
    let day_start = naive_midnight(date);
    let first_of = |month: u32| {
        NaiveDate::from_ymd_opt(date.year(), month, 1)
            .map(naive_midnight)
            .unwrap_or(day_start)
    };
    match unit {
        Unit::Millisecond => n,
        Unit::Second => n.with_nanosecond(0).unwrap_or(n),
        Unit::Minute => n.date().and_hms_opt(n.hour(), n.minute(), 0).unwrap_or(n),
        Unit::Hour => n.date().and_hms_opt(n.hour(), 0, 0).unwrap_or(n),
        Unit::Day => day_start,
        Unit::Week => {
            let back = u64::from(date.weekday().num_days_from_sunday());
            date.checked_sub_days(Days::new(back))
                .map(naive_midnight)
                .unwrap_or(day_start)
        }
        Unit::Month => first_of(date.month()),
        Unit::Quarter => first_of((date.month() - 1) / 3 * 3 + 1),
        Unit::Year => first_of(1),
    }
}

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/// Moment's English locale week: weeks start on Sunday and week 1 is the
/// week containing January 1. Returns (week, week-year).
pub(crate) fn locale_week(d: NaiveDate) -> (u32, i32) {
    let to_saturday = 6 - u64::from(d.weekday().num_days_from_sunday());
    let sat = d.checked_add_days(Days::new(to_saturday)).unwrap_or(d);
    (sat.ordinal0() / 7 + 1, sat.year())
}

/// `WEEKNUM`: week of the year with week 1 containing January 1 and weeks
/// starting on Sunday (or Monday), like Excel's `WEEKNUM` type 1/2.
pub(crate) fn weeknum(d: NaiveDate, monday_start: bool) -> u32 {
    let jan1 = NaiveDate::from_ymd_opt(d.year(), 1, 1).unwrap_or(d);
    let offset = if monday_start {
        jan1.weekday().num_days_from_monday()
    } else {
        jan1.weekday().num_days_from_sunday()
    };
    (d.ordinal0() + offset) / 7 + 1
}

// ---------------------------------------------------------------------------
// Moment format tokens
// ---------------------------------------------------------------------------

/// Format tokens. Matching always takes the longest token at a position.
const TOKENS: &[&str] = &[
    "LLLL", "llll", "MMMM", "DDDD", "dddd", "YYYY", "GGGG", "gggg", "LLL", "lll", "LTS", "MMM",
    "DDD", "DDDo", "ddd", "SSS", "Do", "Mo", "Qo", "do", "wo", "Wo", "LL", "ll", "LT", "MM", "DD",
    "dd", "YY", "GG", "gg", "HH", "hh", "kk", "mm", "ss", "SS", "ww", "WW", "ZZ", "L", "l", "M",
    "Q", "D", "d", "e", "E", "w", "W", "Y", "H", "h", "k", "m", "s", "S", "A", "a", "X", "x", "Z",
];

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Part {
    Lit(String),
    Tok(&'static str),
}

fn localized(tok: &str) -> Option<&'static str> {
    Some(match tok {
        "LT" => "h:mm A",
        "LTS" => "h:mm:ss A",
        "L" => "MM/DD/YYYY",
        "LL" => "MMMM D, YYYY",
        "LLL" => "MMMM D, YYYY h:mm A",
        "LLLL" => "dddd, MMMM D, YYYY h:mm A",
        "l" => "M/D/YYYY",
        "ll" => "MMM D, YYYY",
        "lll" => "MMM D, YYYY h:mm A",
        "llll" => "ddd, MMM D, YYYY h:mm A",
        _ => return None,
    })
}

/// Splits a Moment format string into literal text and tokens. `[...]` is
/// literal text; localized tokens (`LL`, `LT`, ...) are expanded to their
/// English formats.
pub(crate) fn tokenize_format(fmt: &str) -> Vec<Part> {
    let mut parts = Vec::new();
    tokenize_into(fmt, &mut parts, true);
    parts
}

fn push_lit(parts: &mut Vec<Part>, s: &str) {
    if let Some(Part::Lit(prev)) = parts.last_mut() {
        prev.push_str(s);
    } else {
        parts.push(Part::Lit(s.to_string()));
    }
}

fn tokenize_into(fmt: &str, parts: &mut Vec<Part>, expand: bool) {
    let mut rest = fmt;
    while let Some(c) = rest.chars().next() {
        if c == '[' {
            if let Some(close) = rest.find(']') {
                push_lit(parts, &rest[1..close]);
                rest = &rest[close + 1..];
                continue;
            }
        }
        if let Some(tok) = TOKENS
            .iter()
            .filter(|t| rest.starts_with(**t))
            .max_by_key(|t| t.len())
        {
            match localized(tok) {
                Some(expansion) if expand => tokenize_into(expansion, parts, false),
                _ => parts.push(Part::Tok(tok)),
            }
            rest = &rest[tok.len()..];
            continue;
        }
        push_lit(parts, &rest[..c.len_utf8()]);
        rest = &rest[c.len_utf8()..];
    }
}

const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

const WEEKDAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

fn ordinal(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (1, r) if r != 11 => "st",
        (2, r) if r != 12 => "nd",
        (3, r) if r != 13 => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn offset_text(secs: i32, colon: bool) -> String {
    let sign = if secs < 0 { '-' } else { '+' };
    let a = secs.unsigned_abs();
    let (h, m) = (a / 3600, (a % 3600) / 60);
    if colon {
        format!("{sign}{h:02}:{m:02}")
    } else {
        format!("{sign}{h:02}{m:02}")
    }
}

/// Formats a local time with Moment.js tokens (English).
pub(crate) fn format_moment(l: &Local, fmt: &str) -> String {
    let n = l.naive;
    let d = n.date();
    let mut out = String::new();
    for part in tokenize_format(fmt) {
        let tok = match part {
            Part::Lit(s) => {
                out.push_str(&s);
                continue;
            }
            Part::Tok(t) => t,
        };
        let month0 = d.month0() as usize;
        let wd = d.weekday().num_days_from_sunday() as usize;
        let hour12 = match n.hour() % 12 {
            0 => 12,
            h => h,
        };
        let s = match tok {
            "YYYY" => {
                let y = d.year();
                if (0..=9999).contains(&y) {
                    format!("{y:04}")
                } else {
                    format!("{y:+07}")
                }
            }
            "YY" => format!("{:02}", d.year().rem_euclid(100)),
            "Y" => d.year().to_string(),
            "Q" => ((d.month0() / 3) + 1).to_string(),
            "Qo" => ordinal(d.month0() / 3 + 1),
            "M" => d.month().to_string(),
            "Mo" => ordinal(d.month()),
            "MM" => format!("{:02}", d.month()),
            "MMM" => MONTHS[month0][..3].to_string(),
            "MMMM" => MONTHS[month0].to_string(),
            "D" => d.day().to_string(),
            "Do" => ordinal(d.day()),
            "DD" => format!("{:02}", d.day()),
            "DDD" => d.ordinal().to_string(),
            "DDDo" => ordinal(d.ordinal()),
            "DDDD" => format!("{:03}", d.ordinal()),
            "d" | "e" => wd.to_string(),
            "do" => ordinal(wd as u32),
            "dd" => WEEKDAYS[wd][..2].to_string(),
            "ddd" => WEEKDAYS[wd][..3].to_string(),
            "dddd" => WEEKDAYS[wd].to_string(),
            "E" => d.weekday().number_from_monday().to_string(),
            "w" => locale_week(d).0.to_string(),
            "wo" => ordinal(locale_week(d).0),
            "ww" => format!("{:02}", locale_week(d).0),
            "W" => d.iso_week().week().to_string(),
            "Wo" => ordinal(d.iso_week().week()),
            "WW" => format!("{:02}", d.iso_week().week()),
            "gggg" => format!("{:04}", locale_week(d).1),
            "gg" => format!("{:02}", locale_week(d).1.rem_euclid(100)),
            "GGGG" => format!("{:04}", d.iso_week().year()),
            "GG" => format!("{:02}", d.iso_week().year().rem_euclid(100)),
            "H" => n.hour().to_string(),
            "HH" => format!("{:02}", n.hour()),
            "h" => hour12.to_string(),
            "hh" => format!("{hour12:02}"),
            "k" => (if n.hour() == 0 { 24 } else { n.hour() }).to_string(),
            "kk" => format!("{:02}", if n.hour() == 0 { 24 } else { n.hour() }),
            "m" => n.minute().to_string(),
            "mm" => format!("{:02}", n.minute()),
            "s" => n.second().to_string(),
            "ss" => format!("{:02}", n.second()),
            "S" => (n.nanosecond() / 100_000_000 % 10).to_string(),
            "SS" => format!("{:02}", n.nanosecond() / 10_000_000 % 100),
            "SSS" => format!("{:03}", n.nanosecond() / 1_000_000 % 1000),
            "A" => (if n.hour() < 12 { "AM" } else { "PM" }).to_string(),
            "a" => (if n.hour() < 12 { "am" } else { "pm" }).to_string(),
            "X" => l.utc.timestamp().to_string(),
            "x" => l.utc.timestamp_millis().to_string(),
            "Z" => offset_text(l.offset_secs, true),
            "ZZ" => offset_text(l.offset_secs, false),
            other => other.to_string(),
        };
        out.push_str(&s);
    }
    out
}

/// Moment's default `format()` output: ISO 8601 with `Z` in UTC, otherwise
/// the zone offset.
pub(crate) fn default_format(l: &Local) -> String {
    if l.is_utc {
        format_moment(l, "YYYY-MM-DDTHH:mm:ss[Z]")
    } else {
        format_moment(l, "YYYY-MM-DDTHH:mm:ssZ")
    }
}

// ---------------------------------------------------------------------------
// Parsing with a Moment format (DATETIME_PARSE)
// ---------------------------------------------------------------------------

struct Scan<'a> {
    s: &'a str,
}

impl Scan<'_> {
    fn skip_separators(&mut self) {
        self.s = self
            .s
            .trim_start_matches(|c: char| !c.is_alphanumeric() && c != '+' && c != '-');
    }

    fn digits(&mut self, max: usize) -> Option<i64> {
        self.skip_separators();
        let len = self
            .s
            .char_indices()
            .take(max)
            .take_while(|(_, c)| c.is_ascii_digit())
            .count();
        if len == 0 {
            return None;
        }
        let v = self.s[..len].parse::<i64>().ok()?;
        self.s = &self.s[len..];
        Some(v)
    }

    fn signed_digits(&mut self, max: usize) -> Option<i64> {
        self.skip_separators();
        let neg = self.s.starts_with('-');
        if neg || self.s.starts_with('+') {
            self.s = &self.s[1..];
        }
        let v = self.digits(max)?;
        Some(if neg { -v } else { v })
    }

    fn word(&mut self) -> &str {
        self.s = self.s.trim_start_matches(|c: char| !c.is_alphanumeric());
        let len: usize = self
            .s
            .chars()
            .take_while(|c| c.is_alphabetic())
            .map(char::len_utf8)
            .sum();
        let (w, rest) = self.s.split_at(len);
        self.s = rest;
        w
    }

    fn eat_ordinal_suffix(&mut self) {
        let lower = self.s.get(..2).map(str::to_ascii_lowercase);
        if matches!(lower.as_deref(), Some("st" | "nd" | "rd" | "th")) {
            self.s = &self.s[2..];
        }
    }
}

fn month_from_name(w: &str) -> Option<u32> {
    if w.len() < 3 {
        return None;
    }
    let lw = w.to_lowercase();
    MONTHS
        .iter()
        .position(|m| {
            let lm = m.to_lowercase();
            lm == lw || (lw.len() >= 3 && lm.starts_with(&lw))
        })
        .map(|i| i as u32 + 1)
}

/// Parses `input` with a Moment format string, forgivingly like Moment's
/// non-strict mode: separators need not match exactly and trailing input is
/// ignored. Missing parts default to January 1st, midnight; a missing year
/// defaults to `default_year`. Without an explicit offset the result is UTC.
pub(crate) fn parse_with_format(
    input: &str,
    fmt: &str,
    default_year: i32,
) -> Option<DateTime<Utc>> {
    let mut sc = Scan { s: input.trim() };
    let (mut year, mut month, mut day) = (None::<i64>, 1i64, 1i64);
    let (mut hour, mut minute, mut second, mut millis) = (0i64, 0i64, 0i64, 0i64);
    let mut pm: Option<bool> = None;
    let mut offset: Option<i32> = None;
    let mut doy: Option<i64> = None;
    for part in tokenize_format(fmt) {
        let tok = match part {
            Part::Lit(lit) => {
                // Consume matching literal characters; skip the rest.
                for c in lit.chars() {
                    if let Some(rest) = sc.s.strip_prefix(c) {
                        sc.s = rest;
                    }
                }
                continue;
            }
            Part::Tok(t) => t,
        };
        match tok {
            "YYYY" | "gggg" | "GGGG" => year = Some(sc.signed_digits(4)?),
            "Y" => year = Some(sc.signed_digits(6)?),
            "YY" | "gg" | "GG" => {
                let y = sc.digits(2)?;
                year = Some(if y > 68 { 1900 + y } else { 2000 + y });
            }
            "M" | "MM" => month = sc.digits(2)?,
            "Mo" => {
                month = sc.digits(2)?;
                sc.eat_ordinal_suffix();
            }
            "MMM" | "MMMM" => month = i64::from(month_from_name(sc.word())?),
            "Q" => month = (sc.digits(1)? - 1) * 3 + 1,
            "D" | "DD" => day = sc.digits(2)?,
            "Do" => {
                day = sc.digits(2)?;
                sc.eat_ordinal_suffix();
            }
            "DDD" | "DDDD" => doy = Some(sc.digits(3)?),
            "d" | "e" | "E" => {
                sc.digits(1)?;
            }
            "dd" | "ddd" | "dddd" => {
                sc.word();
            }
            "H" | "HH" | "h" | "hh" | "k" | "kk" => hour = sc.digits(2)?,
            "m" | "mm" => minute = sc.digits(2)?,
            "s" | "ss" => second = sc.digits(2)?,
            "S" | "SS" | "SSS" => {
                sc.skip_separators();
                let len = sc.s.chars().take_while(char::is_ascii_digit).count();
                if len == 0 {
                    return None;
                }
                let frac = &sc.s[..len];
                let padded: String = frac.chars().chain("000".chars()).take(3).collect();
                millis = padded.parse().ok()?;
                sc.s = &sc.s[len..];
            }
            "A" | "a" => {
                let w = sc.word().to_ascii_lowercase();
                pm = match w.as_str() {
                    "pm" | "p" => Some(true),
                    "am" | "a" => Some(false),
                    _ => return None,
                };
            }
            "X" | "x" => {
                sc.skip_separators();
                let len =
                    sc.s.chars()
                        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
                        .count();
                let v: f64 = sc.s[..len].parse().ok()?;
                let ms = if tok == "X" { v * 1000.0 } else { v };
                if !ms.is_finite() || ms.abs() > 1e16 {
                    return None;
                }
                return DateTime::from_timestamp_millis(ms.round() as i64);
            }
            "Z" | "ZZ" => {
                sc.s = sc.s.trim_start();
                if let Some(rest) = sc.s.strip_prefix(['Z', 'z']) {
                    sc.s = rest;
                    offset = Some(0);
                } else {
                    let neg = sc.s.starts_with('-');
                    if !(neg || sc.s.starts_with('+')) {
                        return None;
                    }
                    sc.s = &sc.s[1..];
                    let h = sc.digits(2)?;
                    if let Some(rest) = sc.s.strip_prefix(':') {
                        sc.s = rest;
                    }
                    let m = sc.digits(2).unwrap_or(0);
                    let secs = i32::try_from(h * 3600 + m * 60).ok()?;
                    offset = Some(if neg { -secs } else { secs });
                }
            }
            _ => {}
        }
    }
    if let Some(is_pm) = pm {
        if is_pm && hour < 12 {
            hour += 12;
        } else if !is_pm && hour == 12 {
            hour = 0;
        }
    }
    if hour == 24 && minute == 0 && second == 0 {
        hour = 0; // k/kk: 24 means midnight
    }
    let year = i32::try_from(year.unwrap_or(i64::from(default_year))).ok()?;
    let date = match doy {
        Some(n) => NaiveDate::from_yo_opt(year, u32::try_from(n).ok()?)?,
        None => {
            NaiveDate::from_ymd_opt(year, u32::try_from(month).ok()?, u32::try_from(day).ok()?)?
        }
    };
    let time = NaiveTime::from_hms_milli_opt(
        u32::try_from(hour).ok()?,
        u32::try_from(minute).ok()?,
        u32::try_from(second).ok()?,
        u32::try_from(millis).ok()?,
    )?;
    let naive = date.and_time(time);
    match offset {
        Some(secs) => FixedOffset::east_opt(secs)?
            .from_local_datetime(&naive)
            .single()
            .map(|t| t.with_timezone(&Utc)),
        None => Some(naive.and_utc()),
    }
}

// ---------------------------------------------------------------------------
// Humanized durations (TONOW / FROMNOW)
// ---------------------------------------------------------------------------

/// Moment's `humanize()` without a suffix: "a few seconds", "5 minutes",
/// "a day", "3 months", "2 years".
pub(crate) fn humanize(delta: TimeDelta) -> String {
    let secs = (delta.num_milliseconds() as f64 / 1000.0).abs();
    let minutes = (secs / 60.0).round();
    let hours = (secs / 3600.0).round();
    let days = (secs / 86400.0).round();
    let months = (secs / 86400.0 / 30.436_875).round();
    let years = (secs / 86400.0 / 365.25).round();
    let plural = |n: f64, one: &str, many: &str| {
        if n <= 1.0 {
            one.to_string()
        } else {
            format!("{} {many}", n as i64)
        }
    };
    if secs < 45.0 {
        "a few seconds".into()
    } else if secs < 90.0 {
        "a minute".into()
    } else if minutes < 45.0 {
        plural(minutes, "a minute", "minutes")
    } else if minutes < 90.0 {
        "an hour".into()
    } else if hours < 22.0 {
        plural(hours, "an hour", "hours")
    } else if hours < 36.0 {
        "a day".into()
    } else if days < 26.0 {
        plural(days, "a day", "days")
    } else if days < 45.0 {
        "a month".into()
    } else if days < 320.0 {
        plural(months.max(2.0), "a month", "months")
    } else if days < 548.0 {
        "a year".into()
    } else {
        plural(years.max(2.0), "a year", "years")
    }
}

// ---------------------------------------------------------------------------
// Workdays (Monday–Friday)
// ---------------------------------------------------------------------------

fn is_weekend(d: NaiveDate) -> bool {
    matches!(d.weekday(), Weekday::Sat | Weekday::Sun)
}

fn shift(d: NaiveDate, days: i64) -> Option<NaiveDate> {
    if days >= 0 {
        d.checked_add_days(Days::new(days.unsigned_abs()))
    } else {
        d.checked_sub_days(Days::new(days.unsigned_abs()))
    }
}

/// Adds `n` workdays ignoring holidays (Excel `WORKDAY` without holidays).
fn add_weekdays(d: NaiveDate, n: i64) -> Option<NaiveDate> {
    if n == 0 {
        return Some(d);
    }
    let wd = i64::from(d.weekday().num_days_from_monday()); // Mon=0..Sun=6
    if n > 0 {
        // Start counting from Friday when starting on a weekend.
        let (d, wd) = if wd >= 5 {
            (shift(d, 4 - wd)?, 4)
        } else {
            (d, wd)
        };
        let (weeks, rem) = (n / 5, n % 5);
        let d = shift(d, weeks.checked_mul(7)?)?;
        shift(d, if wd + rem > 4 { rem + 2 } else { rem })
    } else {
        let m = -n;
        let (d, wd) = if wd >= 5 {
            (shift(d, 7 - wd)?, 0)
        } else {
            (d, wd)
        };
        let (weeks, rem) = (m / 5, m % 5);
        let d = shift(d, -weeks.checked_mul(7)?)?;
        shift(d, -(if wd - rem < 0 { rem + 2 } else { rem }))
    }
}

/// `WORKDAY(start, n, holidays)`: the date `n` working days (Mon–Fri, not a
/// holiday) after `start` (before, if negative).
pub(crate) fn workday(start: NaiveDate, n: i64, holidays: &[NaiveDate]) -> Option<NaiveDate> {
    let mut hol: Vec<NaiveDate> = holidays
        .iter()
        .copied()
        .filter(|h| !is_weekend(*h))
        .collect();
    hol.sort_unstable();
    hol.dedup();
    let mut cur = start;
    let mut remaining = n;
    // Each pass moves past `remaining` weekdays; holidays crossed in that
    // stretch must then be made up. Terminates because the holiday list is finite.
    for _ in 0..=hol.len() + 1 {
        if remaining == 0 {
            break;
        }
        let next = add_weekdays(cur, remaining)?;
        let crossed = if remaining > 0 {
            hol.iter().filter(|h| **h > cur && **h <= next).count()
        } else {
            hol.iter().filter(|h| **h < cur && **h >= next).count()
        } as i64;
        cur = next;
        remaining = if remaining > 0 { crossed } else { -crossed };
    }
    // `cur` may land on a holiday only if every pass found more; step past.
    let step = if n >= 0 { 1 } else { -1 };
    let mut guard = 0;
    while n != 0 && (is_weekend(cur) || hol.binary_search(&cur).is_ok()) && guard < 10_000 {
        cur = shift(cur, step)?;
        guard += 1;
    }
    Some(cur)
}

/// Weekdays (Mon–Fri) in the inclusive range `a..=b`, requires `a <= b`.
fn weekdays_between(a: NaiveDate, b: NaiveDate) -> i64 {
    let total = (b - a).num_days() + 1;
    let full_weeks = total / 7;
    let mut count = full_weeks * 5;
    let mut d = shift(a, full_weeks * 7).unwrap_or(b);
    while d <= b {
        if !is_weekend(d) {
            count += 1;
        }
        match d.succ_opt() {
            Some(n) => d = n,
            None => break,
        }
    }
    count
}

/// `WORKDAY_DIFF(start, end, holidays)`: working days between the dates,
/// both ends inclusive; negative when `end` is before `start`.
pub(crate) fn workday_diff(start: NaiveDate, end: NaiveDate, holidays: &[NaiveDate]) -> i64 {
    let (a, b, sign) = if start <= end {
        (start, end, 1)
    } else {
        (end, start, -1)
    };
    let mut hol: Vec<NaiveDate> = holidays
        .iter()
        .copied()
        .filter(|h| !is_weekend(*h) && *h >= a && *h <= b)
        .collect();
    hol.sort_unstable();
    hol.dedup();
    sign * (weekdays_between(a, b) - hol.len() as i64)
}
