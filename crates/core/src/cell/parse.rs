//! Locale-free text parsing primitives shared by `normalize`, `parse_text`
//! and `convert`: numbers, durations, booleans, dates, comma lists, ids.
//!
//! Every function here is total: bad input yields `None`, never a panic.

use std::sync::LazyLock;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use regex::Regex;

/// Characters stripped from numeric input as currency symbols.
const CURRENCY_SYMBOLS: &[char] = &[
    '$', '€', '£', '¥', '₹', '₩', '₽', '¢', '₺', '₫', '₪', '฿', '₴', '₦', '₱', '₡', '₲', '₵', '₸',
];

/// A number read from human text, remembering whether it carried a `%`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ParsedNumber {
    pub value: f64,
    pub percent: bool,
}

/// Parse a number from human text. Accepts thousands separators (`,`, `_`,
/// spaces), currency symbols (common ones plus `extra_symbol`), a trailing
/// or leading `%`, accounting negatives `(12.50)` and exponents. Commas are
/// always thousands separators (locale-free), so `1,5` reads as 15.
pub(crate) fn parse_number(input: &str, extra_symbol: Option<&str>) -> Option<ParsedNumber> {
    let mut s = input.trim().to_string();
    if s.is_empty() || s.len() > 200 {
        return None;
    }
    if let Some(sym) = extra_symbol.map(str::trim).filter(|x| !x.is_empty()) {
        s = s.replace(sym, "");
    }
    let mut negative = false;
    let mut t = s.trim();
    if t.starts_with('(') && t.ends_with(')') && t.len() >= 2 {
        negative = true;
        t = t[1..t.len() - 1].trim();
    }
    let mut percent = false;
    let mut cleaned = String::with_capacity(t.len());
    for c in t.chars() {
        match c {
            '%' => {
                if percent {
                    return None;
                }
                percent = true;
            }
            ',' | '_' | ' ' | '\u{a0}' | '\u{202f}' | '\'' => {}
            c if CURRENCY_SYMBOLS.contains(&c) => {}
            '0'..='9' | '.' | '-' | '+' | 'e' | 'E' => cleaned.push(c),
            _ => return None,
        }
    }
    // A leading sign may sit before the stripped currency symbol: "-$5".
    if !cleaned.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let value: f64 = cleaned.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let value = if negative { -value } else { value };
    Some(ParsedNumber { value, percent })
}

/// Parse a duration into seconds. Accepts `h:mm`, `h:mm:ss`, `h:mm:ss.fff`
/// (always hours first), a bare number of seconds, and unit forms such as
/// `1h 30m`, `90 min`, `1.5 hours`, `45s`. A leading `-` negates.
pub(crate) fn parse_duration(input: &str) -> Option<f64> {
    let s = input.trim();
    if s.is_empty() || s.len() > 100 {
        return None;
    }
    let (negative, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest.trim()),
        None => (false, s),
    };
    let secs = if body.contains(':') {
        parse_colon_duration(body)?
    } else if let Ok(n) = body.parse::<f64>() {
        if !body.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return None;
        }
        n
    } else {
        parse_unit_duration(body)?
    };
    if !secs.is_finite() {
        return None;
    }
    Some(if negative { -secs } else { secs })
}

fn parse_colon_duration(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    let digits = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit());
    match parts.as_slice() {
        [h, m] if digits(h) && digits(m) => {
            let h: f64 = h.parse().ok()?;
            let m: f64 = m.parse().ok()?;
            (m < 60.0).then_some(h * 3600.0 + m * 60.0)
        }
        [h, m, sec] if digits(h) && digits(m) => {
            let h: f64 = h.parse().ok()?;
            let m: f64 = m.parse().ok()?;
            let valid_sec = !sec.is_empty()
                && sec.chars().all(|c| c.is_ascii_digit() || c == '.')
                && !sec.starts_with('.');
            if !valid_sec {
                return None;
            }
            let sec: f64 = sec.parse().ok()?;
            (m < 60.0 && sec < 60.0).then_some(h * 3600.0 + m * 60.0 + sec)
        }
        _ => None,
    }
}

static UNIT_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*([0-9]+(?:\.[0-9]+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)\s*,?").expect("valid regex")
});

fn parse_unit_duration(s: &str) -> Option<f64> {
    let mut rest = s;
    let mut total = 0.0;
    let mut any = false;
    while !rest.trim().is_empty() {
        let caps = UNIT_TOKEN.captures(rest)?;
        let n: f64 = caps[1].parse().ok()?;
        let unit = caps[2].to_ascii_lowercase();
        let mult = match unit.chars().next() {
            Some('h') => 3600.0,
            Some('m') => 60.0,
            _ => 1.0,
        };
        total += n * mult;
        any = true;
        rest = &rest[caps[0].len()..];
    }
    any.then_some(total)
}

/// Interpret a checkbox word. `Some(true)` checked, `Some(false)` unchecked,
/// `None` not a recognised word.
pub(crate) fn parse_bool_word(input: &str) -> Option<bool> {
    let s = input.trim().to_lowercase();
    match s.as_str() {
        "true" | "t" | "yes" | "y" | "checked" | "check" | "on" | "1" | "x" | "✓" | "✔" | "☑" => {
            Some(true)
        }
        "false" | "f" | "no" | "n" | "unchecked" | "off" | "0" | "" | "☐" => Some(false),
        _ => None,
    }
}

/// Split a comma-separated list, respecting double quotes (`""` inside quotes
/// is a literal quote). Items are trimmed; empty items are dropped.
pub(crate) fn split_list(input: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut was_quoted = false;
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cur.push(c);
            }
        } else if c == '"' && cur.trim().is_empty() {
            cur.clear();
            quoted = true;
            was_quoted = true;
        } else if c == ',' {
            push_item(&mut items, &mut cur, was_quoted);
            was_quoted = false;
        } else {
            cur.push(c);
        }
    }
    push_item(&mut items, &mut cur, was_quoted);
    items
}

fn push_item(items: &mut Vec<String>, cur: &mut String, was_quoted: bool) {
    let item = if was_quoted {
        cur.clone()
    } else {
        cur.trim().to_string()
    };
    if !item.trim().is_empty() {
        items.push(item);
    }
    cur.clear();
}

/// Join list items with `", "`, quoting items that would not survive
/// [`split_list`] unchanged (commas, quotes, surrounding spaces).
pub(crate) fn join_list<S: AsRef<str>>(items: &[S]) -> String {
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        let item = item.as_ref();
        if i > 0 {
            out.push_str(", ");
        }
        let needs_quotes = item.contains(',') || item.starts_with('"') || item.trim() != item;
        if needs_quotes {
            out.push('"');
            out.push_str(&item.replace('"', "\"\""));
            out.push('"');
        } else {
            out.push_str(item);
        }
    }
    out
}

/// Whether `s` is a well-formed id with the given prefix: the prefix followed
/// by 1..=40 ASCII letters or digits.
pub(crate) fn is_valid_id(s: &str, prefix: &str) -> bool {
    match s.strip_prefix(prefix) {
        Some(rest) => {
            !rest.is_empty() && rest.len() <= 40 && rest.chars().all(|c| c.is_ascii_alphanumeric())
        }
        None => false,
    }
}

/// Clean text for storage: normalise line endings to `\n`, turn line breaks
/// into spaces unless `multiline`, and drop other control characters.
pub(crate) fn clean_text(s: &str, multiline: bool) -> String {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    s.chars()
        .filter_map(|c| match c {
            '\n' if multiline => Some('\n'),
            '\n' => Some(' '),
            '\t' => Some('\t'),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

/// A date or time read from text, before the field's zone is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ParsedDate {
    /// A calendar date with no time.
    Date(NaiveDate),
    /// A wall-clock time with no zone (interpreted in the field/ctx zone).
    Local(NaiveDateTime),
    /// An instant (input carried `Z` or an offset).
    Instant(DateTime<Utc>),
}

const TIME: &str = r"(?:\s*(?:,|T|at)?\s*([0-9]{1,2})(?::([0-9]{2}))?(?::([0-9]{2})(?:[.,]([0-9]{1,9}))?)?\s*([aApP]\.?[mM]?\.?)?)?";

static ISO_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([0-9]{{4}})[-/]([0-9]{{1,2}})[-/]([0-9]{{1,2}}){TIME}\s*(Z|z|UTC|[+-][0-9]{{2}}(?::?[0-9]{{2}})?)?$"
    ))
    .expect("valid regex")
});
static SLASH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^([0-9]{{1,2}})[/.-]([0-9]{{1,2}})[/.-]([0-9]{{4}}|[0-9]{{2}}){TIME}$"
    ))
    .expect("valid regex")
});
static MONTH_FIRST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\.?\s+([0-9]{{1,2}})(?:st|nd|rd|th)?,?\s+([0-9]{{4}}){TIME}$"
    ))
    .expect("valid regex")
});
static DAY_FIRST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:[A-Za-z]+,\s*)?([0-9]{{1,2}})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+([0-9]{{4}}){TIME}$"
    ))
    .expect("valid regex")
});

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

fn month_from_name(name: &str) -> Option<u32> {
    let n = name.to_lowercase();
    if n.len() < 3 {
        return None;
    }
    if n == "sept" {
        return Some(9);
    }
    MONTHS
        .iter()
        .position(|m| m.starts_with(&n))
        .map(|i| i as u32 + 1)
}

/// Parse a date/time from text: ISO dates and date-times (with optional
/// `Z`/offset), RFC 3339, `MM/DD/YYYY` (or `DD/MM/YYYY` when `european`),
/// `Month D, YYYY`, `D Month YYYY`, each optionally followed by a time
/// (`14:30`, `2:30pm`, `2pm`, `14:30:15.250`).
pub(crate) fn parse_date(input: &str, european: bool) -> Option<ParsedDate> {
    let s = input.trim();
    if s.is_empty() || s.len() > 100 {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(ParsedDate::Instant(dt.with_timezone(&Utc)));
    }
    if let Some(c) = ISO_RE.captures(s) {
        let date = ymd(&c[1], &c[2], &c[3])?;
        let time = time_from(&c, 4)?;
        let zone = c.get(9).map(|m| m.as_str());
        return finish(date, time, zone);
    }
    if let Some(c) = SLASH_RE.captures(s) {
        let (m, d) = if european {
            (&c[2], &c[1])
        } else {
            (&c[1], &c[2])
        };
        let date = ymd(&c[3], m, d)?;
        let time = time_from(&c, 4)?;
        return finish(date, time, None);
    }
    if let Some(c) = MONTH_FIRST_RE.captures(s) {
        let month = month_from_name(&c[1])?;
        let date = ymd(&c[3], &month.to_string(), &c[2])?;
        let time = time_from(&c, 4)?;
        return finish(date, time, None);
    }
    if let Some(c) = DAY_FIRST_RE.captures(s) {
        let month = month_from_name(&c[2])?;
        let date = ymd(&c[3], &month.to_string(), &c[1])?;
        let time = time_from(&c, 4)?;
        return finish(date, time, None);
    }
    None
}

fn ymd(y: &str, m: &str, d: &str) -> Option<NaiveDate> {
    let mut year: i32 = y.parse().ok()?;
    if y.len() <= 2 {
        year += 2000;
    }
    if !(1..=9999).contains(&year) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, m.parse().ok()?, d.parse().ok()?)
}

/// Read the optional time captured at groups `first..first+5`
/// (hour, minute, second, fraction, am/pm). `Some(None)` = no time given;
/// `None` = a time was given but is invalid.
fn time_from(c: &regex::Captures<'_>, first: usize) -> Option<Option<NaiveTime>> {
    let Some(hour) = c.get(first) else {
        return Some(None);
    };
    let minute = c.get(first + 1);
    let ampm = c.get(first + 4).map(|m| m.as_str().to_ascii_lowercase());
    if minute.is_none() && ampm.is_none() {
        // A bare number after a date is not a time.
        return None;
    }
    let mut h: u32 = hour.as_str().parse().ok()?;
    let m: u32 = minute.map_or(Some(0), |m| m.as_str().parse().ok())?;
    let sec: u32 = c
        .get(first + 2)
        .map_or(Some(0), |m| m.as_str().parse().ok())?;
    let nanos: u32 = match c.get(first + 3) {
        Some(f) => {
            // Pad or cut to nine digits (never by bytes: the pattern only
            // matches ASCII digits, but this must not panic regardless).
            let padded: String = f
                .as_str()
                .chars()
                .chain(std::iter::repeat('0'))
                .take(9)
                .collect();
            padded.parse().ok()?
        }
        None => 0,
    };
    if let Some(ap) = ampm {
        if !(1..=12).contains(&h) {
            return None;
        }
        let pm = ap.starts_with('p');
        h = match (h, pm) {
            (12, false) => 0,
            (12, true) => 12,
            (h, true) => h + 12,
            (h, false) => h,
        };
    }
    NaiveTime::from_hms_nano_opt(h, m, sec, nanos).map(Some)
}

fn finish(date: NaiveDate, time: Option<NaiveTime>, zone: Option<&str>) -> Option<ParsedDate> {
    match (time, zone) {
        (None, None) => Some(ParsedDate::Date(date)),
        (None, Some(_)) => None,
        (Some(t), None) => Some(ParsedDate::Local(date.and_time(t))),
        (Some(t), Some(z)) => {
            let offset_secs = parse_offset(z)?;
            let local = date.and_time(t);
            let utc = local.checked_sub_signed(Duration::seconds(offset_secs))?;
            Some(ParsedDate::Instant(Utc.from_utc_datetime(&utc)))
        }
    }
}

fn parse_offset(z: &str) -> Option<i64> {
    if z.eq_ignore_ascii_case("z") || z.eq_ignore_ascii_case("utc") {
        return Some(0);
    }
    let sign = if z.starts_with('-') { -1 } else { 1 };
    let digits: String = z[1..].chars().filter(|c| c.is_ascii_digit()).collect();
    let (h, m) = match digits.len() {
        2 => (digits.parse::<i64>().ok()?, 0),
        4 => (
            digits[..2].parse::<i64>().ok()?,
            digits[2..].parse::<i64>().ok()?,
        ),
        _ => return None,
    };
    if h > 23 || m > 59 {
        return None;
    }
    Some(sign * (h * 3600 + m * 60))
}

/// Interpret a wall-clock time in `zone`. Ambiguous times (DST fall-back)
/// take the earlier instant; times inside a DST gap move forward by the gap
/// (e.g. 02:30 on a spring-forward night becomes 03:30).
pub(crate) fn local_to_utc(local: NaiveDateTime, zone: Tz) -> Option<DateTime<Utc>> {
    if let Some(dt) = zone.from_local_datetime(&local).earliest() {
        return Some(dt.with_timezone(&Utc));
    }
    let shifted = local.checked_add_signed(Duration::hours(1))?;
    zone.from_local_datetime(&shifted)
        .earliest()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Read a stored date cell: `YYYY-MM-DD` or an RFC 3339 instant.
pub(crate) fn read_stored_date(s: &str) -> Option<ParsedDate> {
    if s.len() == 10 {
        return NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .ok()
            .map(ParsedDate::Date);
    }
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| ParsedDate::Instant(d.with_timezone(&Utc)))
}

/// Parse an IANA zone name, `None` when unknown.
pub(crate) fn parse_tz(name: &str) -> Option<Tz> {
    name.parse::<Tz>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(s: &str) -> Option<f64> {
        parse_number(s, None).map(|p| p.value)
    }

    #[test]
    fn numbers_lenient() {
        assert_eq!(num("42"), Some(42.0));
        assert_eq!(num("  -3.5 "), Some(-3.5));
        assert_eq!(num("1,234.50"), Some(1234.5));
        assert_eq!(num("$1,234.50"), Some(1234.5));
        assert_eq!(num("-$5"), Some(-5.0));
        assert_eq!(num("(12.50)"), Some(-12.5));
        assert_eq!(num("€ 9"), Some(9.0));
        assert_eq!(num("1e3"), Some(1000.0));
        assert_eq!(num("1 000"), Some(1000.0));
        assert_eq!(num(".5"), Some(0.5));
        assert_eq!(
            parse_number("50%", None),
            Some(ParsedNumber {
                value: 50.0,
                percent: true
            })
        );
        assert_eq!(
            parse_number("CHF 12", Some("CHF")).map(|p| p.value),
            Some(12.0)
        );
    }

    #[test]
    fn numbers_rejected() {
        for bad in [
            "", "abc", "1.2.3", "inf", "NaN", "infinity", "-", "$", "%", "5%%", "1e999", "12abc",
            "0x10",
        ] {
            assert_eq!(num(bad), None, "{bad:?}");
        }
        assert_eq!(num(&"9".repeat(300)), None);
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("1:30"), Some(5400.0));
        assert_eq!(parse_duration("0:05"), Some(300.0));
        assert_eq!(parse_duration("1:30:15"), Some(5415.0));
        assert_eq!(parse_duration("0:00:01.5"), Some(1.5));
        assert_eq!(parse_duration("-1:00"), Some(-3600.0));
        assert_eq!(parse_duration("90"), Some(90.0));
        assert_eq!(parse_duration("2.5"), Some(2.5));
        assert_eq!(parse_duration("1h 30m"), Some(5400.0));
        assert_eq!(parse_duration("1h30m15s"), Some(5415.0));
        assert_eq!(parse_duration("90 min"), Some(5400.0));
        assert_eq!(parse_duration("1.5 hours"), Some(5400.0));
        assert_eq!(parse_duration("45s"), Some(45.0));
        assert_eq!(parse_duration("100:00"), Some(360000.0));
        for bad in [
            "",
            "1:75",
            "1:30:61",
            "abc",
            "1:",
            ":30",
            "1::2",
            "5 parsecs",
            "1:2:3:4",
            "1e5",
            "0:00:.5",
        ] {
            assert_eq!(parse_duration(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn bool_words() {
        for t in ["true", "TRUE", "yes", "Y", "checked", "on", "1", "x", "✓"] {
            assert_eq!(parse_bool_word(t), Some(true), "{t}");
        }
        for f in ["false", "no", "N", "unchecked", "off", "0", "", "  "] {
            assert_eq!(parse_bool_word(f), Some(false), "{f}");
        }
        assert_eq!(parse_bool_word("maybe"), None);
    }

    #[test]
    fn lists_split_and_join() {
        assert_eq!(split_list("a, b ,c"), vec!["a", "b", "c"]);
        assert_eq!(split_list("\"Red, dark\", Blue"), vec!["Red, dark", "Blue"]);
        assert_eq!(split_list("\"say \"\"hi\"\"\", x"), vec!["say \"hi\"", "x"]);
        assert_eq!(split_list(" , ,a,,"), vec!["a"]);
        assert!(split_list("").is_empty());
        assert_eq!(split_list("\"unterminated, x"), vec!["unterminated, x"]);
        let items = ["Red, dark", "Blue", "say \"hi\"", " padded "];
        let joined = join_list(&items);
        assert_eq!(joined, "\"Red, dark\", Blue, say \"hi\", \" padded \"");
        assert_eq!(split_list(&joined), items);
    }

    #[test]
    fn ids() {
        assert!(is_valid_id("rec123abc", "rec"));
        assert!(!is_valid_id("rec", "rec"));
        assert!(!is_valid_id("usr123", "rec"));
        assert!(!is_valid_id("rec-12", "rec"));
        assert!(!is_valid_id("rec 12", "rec"));
        assert!(!is_valid_id(&format!("rec{}", "a".repeat(41)), "rec"));
    }

    #[test]
    fn text_cleaning() {
        assert_eq!(clean_text("a\r\nb\rc\nd", true), "a\nb\nc\nd");
        assert_eq!(clean_text("a\r\nb\nc", false), "a b c");
        assert_eq!(clean_text("a\u{0}b\u{7}c\td", false), "abc\td");
    }

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn local(y: i32, m: u32, day: u32, h: u32, min: u32) -> ParsedDate {
        ParsedDate::Local(d(y, m, day).and_hms_opt(h, min, 0).unwrap())
    }

    #[test]
    fn dates_parse() {
        use ParsedDate::*;
        assert_eq!(parse_date("2026-10-12", false), Some(Date(d(2026, 10, 12))));
        assert_eq!(parse_date("2026/1/5", false), Some(Date(d(2026, 1, 5))));
        assert_eq!(parse_date("10/12/2026", false), Some(Date(d(2026, 10, 12))));
        assert_eq!(parse_date("10/12/2026", true), Some(Date(d(2026, 12, 10))));
        assert_eq!(parse_date("1/5/26", false), Some(Date(d(2026, 1, 5))));
        assert_eq!(
            parse_date("October 12, 2026", false),
            Some(Date(d(2026, 10, 12)))
        );
        assert_eq!(
            parse_date("Oct 12 2026", false),
            Some(Date(d(2026, 10, 12)))
        );
        assert_eq!(
            parse_date("Sept 3rd, 2026", false),
            Some(Date(d(2026, 9, 3)))
        );
        assert_eq!(
            parse_date("12 October 2026", false),
            Some(Date(d(2026, 10, 12)))
        );
        assert_eq!(
            parse_date("Monday, October 12, 2026", false),
            Some(Date(d(2026, 10, 12)))
        );
        assert_eq!(
            parse_date("2026-10-12 14:30", false),
            Some(local(2026, 10, 12, 14, 30))
        );
        assert_eq!(
            parse_date("2026-10-12T14:30", false),
            Some(local(2026, 10, 12, 14, 30))
        );
        assert_eq!(
            parse_date("10/12/2026 2:30pm", false),
            Some(local(2026, 10, 12, 14, 30))
        );
        assert_eq!(
            parse_date("10/12/2026 2pm", false),
            Some(local(2026, 10, 12, 14, 0))
        );
        assert_eq!(
            parse_date("10/12/2026 12:15 AM", false),
            Some(local(2026, 10, 12, 0, 15))
        );
        assert_eq!(
            parse_date("10/12/2026 12:15 p.m.", false),
            Some(local(2026, 10, 12, 12, 15))
        );
        assert_eq!(
            parse_date("October 12, 2026 at 9:05am", false),
            Some(local(2026, 10, 12, 9, 5))
        );
        assert_eq!(
            parse_date("2026-10-12T14:30:00Z", false),
            Some(Instant(
                Utc.with_ymd_and_hms(2026, 10, 12, 14, 30, 0).unwrap()
            ))
        );
        assert_eq!(
            parse_date("2026-10-12T14:30:00.250+02:00", false),
            Some(Instant(
                Utc.with_ymd_and_hms(2026, 10, 12, 12, 30, 0).unwrap()
                    + Duration::milliseconds(250)
            ))
        );
        assert_eq!(
            parse_date("2026-10-12 14:30 -0500", false),
            Some(Instant(
                Utc.with_ymd_and_hms(2026, 10, 12, 19, 30, 0).unwrap()
            ))
        );
        assert_eq!(
            parse_date("2026-10-12T14:30Z", false),
            Some(Instant(
                Utc.with_ymd_and_hms(2026, 10, 12, 14, 30, 0).unwrap()
            ))
        );
    }

    #[test]
    fn dates_rejected() {
        for bad in [
            "",
            "hello",
            "2026-13-01",
            "2026-02-30",
            "13/13/2026",
            "10/12/2026 14",
            "2026-10-12 25:00",
            "2026-10-12 13:00pm",
            "Smarch 3, 2026",
            "0000-01-01",
            "2026-10-12Z",
            "10/12",
            "2026",
            "2026-10-12 14:60",
        ] {
            assert_eq!(parse_date(bad, false), None, "{bad:?}");
        }
    }

    #[test]
    fn local_times_across_dst() {
        let ny: Tz = "America/New_York".parse().unwrap();
        // Normal: EDT is UTC-4.
        let t = local_to_utc(d(2026, 7, 1).and_hms_opt(9, 0, 0).unwrap(), ny).unwrap();
        assert_eq!(t, Utc.with_ymd_and_hms(2026, 7, 1, 13, 0, 0).unwrap());
        // Gap: 2026-03-08 02:30 does not exist; moves to 03:30 EDT.
        let t = local_to_utc(d(2026, 3, 8).and_hms_opt(2, 30, 0).unwrap(), ny).unwrap();
        assert_eq!(t, Utc.with_ymd_and_hms(2026, 3, 8, 7, 30, 0).unwrap());
        // Ambiguous: 2026-11-01 01:30 happens twice; earliest is EDT.
        let t = local_to_utc(d(2026, 11, 1).and_hms_opt(1, 30, 0).unwrap(), ny).unwrap();
        assert_eq!(t, Utc.with_ymd_and_hms(2026, 11, 1, 5, 30, 0).unwrap());
    }

    #[test]
    fn stored_dates() {
        assert_eq!(
            read_stored_date("2026-10-12"),
            Some(ParsedDate::Date(d(2026, 10, 12)))
        );
        assert!(matches!(
            read_stored_date("2026-10-12T00:00:00.000Z"),
            Some(ParsedDate::Instant(_))
        ));
        assert_eq!(read_stored_date("garbage"), None);
        assert_eq!(read_stored_date("2026-1-1"), None);
    }
}
