//! Date functions (formatting tokens are in `datetime_format.rs`).
//! The default test clock is Friday 2024-03-15T12:30:45.123Z.

use super::support::*;
use crate::value::Value;

fn d(src_date: Value) -> Ctx {
    with(&[("D", src_date)])
}

#[test]
fn dateadd_into_dst_gap_and_overlap() {
    // 02:30 EST on 2024-03-09; 02:30 on 2024-03-10 does not exist in New York,
    // so the result moves forward by the gap to 03:30 EDT.
    let gap = d(dt("2024-03-09T07:30:00Z"));
    check_in(
        "DATEADD(SET_TIMEZONE({D}, \"America/New_York\"), 1, \"day\")",
        &gap,
        dt("2024-03-10T07:30:00Z"),
    );
    // 01:30 EDT on 2024-11-02; 01:30 on 2024-11-03 happens twice and the
    // earlier (EDT) instant is used.
    let overlap = d(dt("2024-11-02T05:30:00Z"));
    check_in(
        "DATEADD(SET_TIMEZONE({D}, \"America/New_York\"), 1, \"day\")",
        &overlap,
        dt("2024-11-03T05:30:00Z"),
    );
}

#[test]
fn hour_around_dst_transition() {
    let c = d(dt("2024-03-10T07:30:00Z"));
    check_in("HOUR(SET_TIMEZONE({D}, \"America/New_York\"))", &c, n(3.0));
    let c = d(dt("2024-03-10T06:30:00Z"));
    check_in("HOUR(SET_TIMEZONE({D}, \"America/New_York\"))", &c, n(1.0));
}

#[test]
fn now_today_created_modified() {
    check("NOW()", dt("2024-03-15T12:30:45.123Z"));
    check("TODAY()", date(2024, 3, 15));
    check("CREATED_TIME()", dt("2024-01-02T03:04:05Z"));
    check("LAST_MODIFIED_TIME()", dt("2024-03-10T08:00:00Z"));
    let auckland = Ctx {
        tz: chrono_tz::Pacific::Auckland,
        ..Ctx::default()
    };
    check_in("TODAY()", &auckland, date(2024, 3, 16));
}

#[test]
fn last_modified_time_of_fields() {
    let mut c = Ctx::default();
    c.field_times
        .insert("A".into(), utc("2024-02-01T00:00:00Z"));
    c.field_times
        .insert("B".into(), utc("2024-02-05T00:00:00Z"));
    check_in("LAST_MODIFIED_TIME({A})", &c, dt("2024-02-01T00:00:00Z"));
    check_in(
        "LAST_MODIFIED_TIME({A}, {B})",
        &c,
        dt("2024-02-05T00:00:00Z"),
    );
    // Untracked fields fall back to the record's time.
    check_in("LAST_MODIFIED_TIME({C})", &c, dt("2024-03-10T08:00:00Z"));
    check_err_in("LAST_MODIFIED_TIME(1)", &c, "field references");
}

#[test]
fn record_id() {
    check("RECORD_ID()", t("recABC123"));
    check("\"https://x/\" & RECORD_ID()", t("https://x/recABC123"));
}

#[test]
fn date_parts() {
    let c = d(dt("2024-03-15T23:30:15Z"));
    check_in("YEAR({D})", &c, n(2024.0));
    check_in("MONTH({D})", &c, n(3.0));
    check_in("DAY({D})", &c, n(15.0));
    check_in("HOUR({D})", &c, n(23.0));
    check_in("MINUTE({D})", &c, n(30.0));
    check_in("SECOND({D})", &c, n(15.0));
    check("YEAR(\"2021-07-04\")", n(2021.0));
    check("MONTH(\"July 4, 2021\")", n(7.0));
    check("DAY(\"7/4/2021\")", n(4.0));
    check("HOUR(\"2021-07-04 18:45\")", n(18.0));
    check("YEAR(BLANK())", Value::Null);
    check("HOUR(BLANK())", Value::Null);
    check_err("YEAR(\"nope\")", "as a date");
    check_err("DAY(5)", "Expected a date");
    check_err("MONTH(ERROR())", "#ERROR!");
}

#[test]
fn date_parts_honour_nested_set_timezone() {
    let c = d(dt("2024-03-15T23:30:15Z"));
    check_in("HOUR(SET_TIMEZONE({D}, \"Asia/Tokyo\"))", &c, n(8.0));
    check_in("DAY(SET_TIMEZONE({D}, \"Asia/Tokyo\"))", &c, n(16.0));
    check_in("MINUTE(SET_TIMEZONE({D}, \"Asia/Kolkata\"))", &c, n(0.0));
    check_in("HOUR(SET_TIMEZONE({D}, \"America/New_York\"))", &c, n(19.0));
    // Not directly nested: no effect (Value has no zone).
    check_in(
        "HOUR(IF(1, SET_TIMEZONE({D}, \"Asia/Tokyo\")))",
        &c,
        n(23.0),
    );
    // Through SET_LOCALE as well.
    check_in(
        "HOUR(SET_LOCALE(SET_TIMEZONE({D}, \"Asia/Tokyo\"), \"ja\"))",
        &c,
        n(8.0),
    );
    // Calendar dates are never shifted.
    let cd = d(date(2024, 3, 15));
    check_in(
        "DAY(SET_TIMEZONE({D}, \"Pacific/Kiritimati\"))",
        &cd,
        n(15.0),
    );
    check_in("HOUR({D})", &cd, n(0.0));
    check_err_in(
        "HOUR(SET_TIMEZONE({D}, \"Mars/Base\"))",
        &c,
        "Unknown timezone",
    );
}

#[test]
fn context_timezone_is_the_default() {
    let c = Ctx {
        tz: chrono_tz::Asia::Tokyo,
        fields: [("D".to_string(), dt("2024-03-15T23:30:15Z"))].into(),
        ..Ctx::default()
    };
    check_in("HOUR({D})", &c, n(8.0));
    check_in("HOUR(SET_TIMEZONE({D}, \"UTC\"))", &c, n(23.0));
}

#[test]
fn set_timezone_and_set_locale_standalone() {
    let c = d(dt("2024-03-15T23:30:15Z"));
    check_in(
        "SET_TIMEZONE({D}, \"Asia/Tokyo\")",
        &c,
        dt("2024-03-15T23:30:15Z"),
    );
    check_in("SET_LOCALE({D}, \"fr\")", &c, dt("2024-03-15T23:30:15Z"));
    check_err_in(
        "SET_TIMEZONE({D}, \"Nowhere\")",
        &c,
        "Unknown timezone 'Nowhere'",
    );
    check("SET_TIMEZONE(BLANK(), \"UTC\")", Value::Null);
}

#[test]
fn datestr_timestr() {
    let c = d(dt("2024-03-15T23:30:05Z"));
    check_in("DATESTR({D})", &c, t("2024-03-15"));
    check_in("TIMESTR({D})", &c, t("23:30:05"));
    check_in(
        "DATESTR(SET_TIMEZONE({D}, \"Asia/Tokyo\"))",
        &c,
        t("2024-03-16"),
    );
    check_in(
        "TIMESTR(SET_TIMEZONE({D}, \"Asia/Tokyo\"))",
        &c,
        t("08:30:05"),
    );
    check("DATESTR(\"2024-01-02\")", t("2024-01-02"));
    check("TIMESTR(\"2024-01-02\")", t("00:00:00"));
    check("DATESTR(BLANK())", Value::Null);
}

#[test]
fn weekday() {
    check("WEEKDAY(\"2024-03-15\")", n(5.0));
    check("WEEKDAY(\"2024-03-15\", \"Monday\")", n(4.0));
    check("WEEKDAY(\"2024-03-17\")", n(0.0));
    check("WEEKDAY(\"2024-03-17\", \"monday\")", n(6.0));
    check("WEEKDAY(\"2024-03-17\", \"Sunday\")", n(0.0));
    check("WEEKDAY(BLANK())", Value::Null);
    check_err("WEEKDAY(\"2024-03-17\", \"Friday\")", "Week start");
}

#[test]
fn weeknum() {
    check("WEEKNUM(\"2024-01-01\")", n(1.0));
    check("WEEKNUM(\"2024-01-06\")", n(1.0));
    check("WEEKNUM(\"2024-01-07\")", n(2.0));
    check("WEEKNUM(\"2024-01-07\", \"Monday\")", n(1.0));
    check("WEEKNUM(\"2024-01-08\", \"Monday\")", n(2.0));
    check("WEEKNUM(\"2024-12-31\")", n(53.0));
    check("WEEKNUM(\"2023-01-01\")", n(1.0));
    check("WEEKNUM(BLANK())", Value::Null);
}

#[test]
fn dateadd_units() {
    let c = d(dt("2024-03-15T10:00:00Z"));
    check_in("DATEADD({D}, 1, \"days\")", &c, dt("2024-03-16T10:00:00Z"));
    check_in("DATEADD({D}, -2, \"d\")", &c, dt("2024-03-13T10:00:00Z"));
    check_in("DATEADD({D}, 1, \"week\")", &c, dt("2024-03-22T10:00:00Z"));
    check_in("DATEADD({D}, 2, \"w\")", &c, dt("2024-03-29T10:00:00Z"));
    check_in("DATEADD({D}, 1, \"month\")", &c, dt("2024-04-15T10:00:00Z"));
    check_in("DATEADD({D}, 1, \"M\")", &c, dt("2024-04-15T10:00:00Z"));
    check_in(
        "DATEADD({D}, 1, \"quarters\")",
        &c,
        dt("2024-06-15T10:00:00Z"),
    );
    check_in("DATEADD({D}, 1, \"Q\")", &c, dt("2024-06-15T10:00:00Z"));
    check_in("DATEADD({D}, 1, \"year\")", &c, dt("2025-03-15T10:00:00Z"));
    check_in("DATEADD({D}, 2, \"y\")", &c, dt("2026-03-15T10:00:00Z"));
    check_in("DATEADD({D}, 3, \"hours\")", &c, dt("2024-03-15T13:00:00Z"));
    check_in("DATEADD({D}, 1, \"h\")", &c, dt("2024-03-15T11:00:00Z"));
    check_in(
        "DATEADD({D}, 90, \"minutes\")",
        &c,
        dt("2024-03-15T11:30:00Z"),
    );
    check_in("DATEADD({D}, 5, \"m\")", &c, dt("2024-03-15T10:05:00Z"));
    check_in(
        "DATEADD({D}, 30, \"seconds\")",
        &c,
        dt("2024-03-15T10:00:30Z"),
    );
    check_in("DATEADD({D}, 1, \"s\")", &c, dt("2024-03-15T10:00:01Z"));
    check_in(
        "DATEADD({D}, 250, \"milliseconds\")",
        &c,
        dt("2024-03-15T10:00:00.250Z"),
    );
    check_in(
        "DATEADD({D}, 1, \"ms\")",
        &c,
        dt("2024-03-15T10:00:00.001Z"),
    );
    check_in("DATEADD({D}, 1, \"Days\")", &c, dt("2024-03-16T10:00:00Z"));
    check_in(
        "DATEADD({D}, 1.5, \"hours\")",
        &c,
        dt("2024-03-15T11:30:00Z"),
    );
    // Fractional calendar counts round like Moment.
    check_in(
        "DATEADD({D}, 1.5, \"days\")",
        &c,
        dt("2024-03-17T10:00:00Z"),
    );
    check_in(
        "DATEADD({D}, \"2\", \"days\")",
        &c,
        dt("2024-03-17T10:00:00Z"),
    );
}

#[test]
fn dateadd_months_clamp_to_month_end() {
    check("DATEADD(\"2024-01-31\", 1, \"month\")", date(2024, 2, 29));
    check("DATEADD(\"2023-01-31\", 1, \"month\")", date(2023, 2, 28));
    check("DATEADD(\"2024-02-29\", 1, \"year\")", date(2025, 2, 28));
    check("DATEADD(\"2024-03-31\", -1, \"months\")", date(2024, 2, 29));
}

#[test]
fn dateadd_keeps_calendar_dates() {
    let c = d(date(2024, 3, 15));
    check_in("DATEADD({D}, 1, \"day\")", &c, date(2024, 3, 16));
    check_in("DATEADD({D}, 6, \"hours\")", &c, dt("2024-03-15T06:00:00Z"));
}

#[test]
fn dateadd_across_dst_keeps_wall_clock_in_zone() {
    // 2024-03-10: US clocks spring forward.
    let c = d(dt("2024-03-09T17:00:00Z")); // 12:00 EST
    check_in(
        "DATEADD(SET_TIMEZONE({D}, \"America/New_York\"), 1, \"day\")",
        &c,
        dt("2024-03-10T16:00:00Z"),
    );
    check_in("DATEADD({D}, 1, \"day\")", &c, dt("2024-03-10T17:00:00Z"));
    check_in(
        "DATEADD(SET_TIMEZONE({D}, \"America/New_York\"), 24, \"hours\")",
        &c,
        dt("2024-03-10T17:00:00Z"),
    );
}

#[test]
fn dateadd_errors_and_blanks() {
    check("DATEADD(BLANK(), 1, \"day\")", Value::Null);
    check_err(
        "DATEADD(NOW(), 1, \"fortnight\")",
        "Unknown unit 'fortnight'",
    );
    check_err("DATEADD(NOW(), 1e15, \"years\")", "out of range");
    check_err("DATEADD(NOW(), 1e300, \"ms\")", "out of range");
    check_err("DATEADD(NOW(), \"x\", \"days\")", "as a number");
    check_err("DATEADD(1/0, 1, \"days\")", "Division by zero");
}

#[test]
fn datetime_diff() {
    check(
        "DATETIME_DIFF(\"2024-01-10\", \"2024-01-01\", \"days\")",
        n(9.0),
    );
    check(
        "DATETIME_DIFF(\"2024-01-01\", \"2024-01-10\", \"days\")",
        n(-9.0),
    );
    check("DATETIME_DIFF(\"2024-01-10\", \"2024-01-01\")", n(777600.0));
    check(
        "DATETIME_DIFF(\"2024-01-10\", \"2024-01-01\", \"hours\")",
        n(216.0),
    );
    check(
        "DATETIME_DIFF(\"2024-01-10\", \"2024-01-01\", \"h\")",
        n(216.0),
    );
    check(
        "DATETIME_DIFF(\"2024-01-10\", \"2024-01-01\", \"weeks\")",
        n(1.0),
    );
    check(
        "DATETIME_DIFF(\"2024-01-10\", \"2024-01-01\", \"minutes\")",
        n(12960.0),
    );
    check(
        "DATETIME_DIFF(\"2024-01-10\", \"2024-01-01\", \"ms\")",
        n(777_600_000.0),
    );
    check(
        "DATETIME_DIFF(\"2024-03-01\", \"2024-01-31\", \"months\")",
        n(1.0),
    );
    check(
        "DATETIME_DIFF(\"2024-03-31\", \"2024-01-31\", \"M\")",
        n(2.0),
    );
    check(
        "DATETIME_DIFF(\"2024-01-31\", \"2024-03-31\", \"months\")",
        n(-2.0),
    );
    check(
        "DATETIME_DIFF(\"2024-06-14\", \"2020-06-15\", \"years\")",
        n(3.0),
    );
    check(
        "DATETIME_DIFF(\"2024-06-15\", \"2020-06-15\", \"y\")",
        n(4.0),
    );
    check(
        "DATETIME_DIFF(\"2024-07-01\", \"2024-01-01\", \"quarters\")",
        n(2.0),
    );
    check(
        "DATETIME_DIFF(\"2024-01-01T10:00:00Z\", \"2024-01-01T09:00:01Z\", \"hours\")",
        n(0.0),
    );
    let c = with(&[("A", date(2024, 1, 2)), ("B", dt("2024-01-01T12:00:00Z"))]);
    check_in("DATETIME_DIFF({A}, {B}, \"hours\")", &c, n(12.0));
    check(
        "DATETIME_DIFF(BLANK(), \"2024-01-01\", \"days\")",
        Value::Null,
    );
    check_err("DATETIME_DIFF(NOW(), NOW(), \"eons\")", "Unknown unit");
    check_err("DATETIME_DIFF(\"x\", NOW())", "as a date");
}

#[test]
fn is_after_before() {
    check("IS_AFTER(\"2024-02-01\", \"2024-01-01\")", b(true));
    check("IS_AFTER(\"2024-01-01\", \"2024-02-01\")", b(false));
    check("IS_AFTER(\"2024-01-01\", \"2024-01-01\")", b(false));
    check("IS_BEFORE(\"2024-01-01\", \"2024-02-01\")", b(true));
    check("IS_BEFORE(\"2024-02-01\", \"2024-01-01\")", b(false));
    check("IS_BEFORE(TODAY(), NOW())", b(true));
    check("IS_AFTER(BLANK(), NOW())", Value::Null);
    check_err("IS_BEFORE(\"zz\", NOW())", "as a date");
}

#[test]
fn is_same() {
    let c = with(&[
        ("A", dt("2024-03-15T10:00:00Z")),
        ("B", dt("2024-03-15T23:00:00Z")),
    ]);
    check_in("IS_SAME({A}, {B}, \"day\")", &c, b(true));
    check_in("IS_SAME({A}, {B}, \"hour\")", &c, b(false));
    check_in("IS_SAME({A}, {B})", &c, b(false));
    check_in("IS_SAME({A}, {A})", &c, b(true));
    check_in(
        "IS_SAME(SET_TIMEZONE({B}, \"Asia/Tokyo\"), {A}, \"day\")",
        &c,
        b(false),
    );
    check(
        "IS_SAME(\"2024-03-01\", \"2024-03-31\", \"month\")",
        b(true),
    );
    check(
        "IS_SAME(\"2024-03-31\", \"2024-04-01\", \"month\")",
        b(false),
    );
    check("IS_SAME(\"2024-03-17\", \"2024-03-23\", \"week\")", b(true));
    check(
        "IS_SAME(\"2024-03-16\", \"2024-03-17\", \"week\")",
        b(false),
    );
    check(
        "IS_SAME(\"2024-01-05\", \"2024-03-30\", \"quarter\")",
        b(true),
    );
    check("IS_SAME(\"2024-03-30\", \"2024-04-01\", \"Q\")", b(false));
    check("IS_SAME(\"2024-01-05\", \"2024-12-30\", \"year\")", b(true));
    check(
        "IS_SAME(\"2024-01-05T10:00:01Z\", \"2024-01-05T10:00:59Z\", \"minute\")",
        b(true),
    );
    check(
        "IS_SAME(\"2024-01-05T10:00:01.100Z\", \"2024-01-05T10:00:01.900Z\", \"second\")",
        b(true),
    );
    check("IS_SAME(\"2024-01-01\", \"2024-01-01T00:00:00Z\")", b(true));
    check("IS_SAME(BLANK(), NOW())", Value::Null);
    check_err("IS_SAME(NOW(), NOW(), \"decade\")", "Unknown unit");
}

#[test]
fn tonow_fromnow_humanize() {
    check("TONOW(\"2024-03-12T12:30:45Z\")", t("3 days"));
    check("FROMNOW(\"2024-03-25T12:30:45Z\")", t("10 days"));
    check("TONOW(\"2024-03-15T12:30:30Z\")", t("a few seconds"));
    check("TONOW(\"2024-03-15T12:29:45Z\")", t("a minute"));
    check("TONOW(\"2024-03-15T12:20:45Z\")", t("10 minutes"));
    check("TONOW(\"2024-03-15T11:30:45Z\")", t("an hour"));
    check("TONOW(\"2024-03-15T10:30:45Z\")", t("2 hours"));
    check("TONOW(\"2024-03-14T12:30:45Z\")", t("a day"));
    check("TONOW(\"2024-02-10T12:30:45Z\")", t("a month"));
    check("TONOW(\"2023-12-15T12:30:45Z\")", t("3 months"));
    check("TONOW(\"2023-03-15T12:30:45Z\")", t("a year"));
    check("FROMNOW(\"2021-03-15T12:30:45Z\")", t("3 years"));
    check("TONOW(BLANK())", Value::Null);
}

#[test]
fn workday() {
    // 2024-03-15 is a Friday.
    check("WORKDAY(\"2024-03-15\", 1)", date(2024, 3, 18));
    check("WORKDAY(\"2024-03-15\", 5)", date(2024, 3, 22));
    check("WORKDAY(\"2024-03-15\", 0)", date(2024, 3, 15));
    check("WORKDAY(\"2024-03-18\", -1)", date(2024, 3, 15));
    check("WORKDAY(\"2024-03-16\", 1)", date(2024, 3, 18));
    check("WORKDAY(\"2024-03-17\", -1)", date(2024, 3, 15));
    check("WORKDAY(\"2024-03-20\", -5)", date(2024, 3, 13));
    check(
        "WORKDAY(\"2024-03-15\", 1, \"2024-03-18\")",
        date(2024, 3, 19),
    );
    check(
        "WORKDAY(\"2024-03-15\", 1, \"2024-03-18, 2024-03-19\")",
        date(2024, 3, 20),
    );
    check(
        "WORKDAY(\"2024-03-15\", 10, \"2024-03-25\")",
        date(2024, 4, 1),
    );
    check(
        "WORKDAY(\"2024-03-19\", -1, \"2024-03-18\")",
        date(2024, 3, 15),
    );
    check(
        "WORKDAY(\"2024-03-15\", 1, \"2024-03-16\")",
        date(2024, 3, 18),
    );
    check("WORKDAY(\"2024-03-15\", 2.9)", date(2024, 3, 19));
    check("WORKDAY(\"2024-01-01\", 260)", date(2024, 12, 30));
    let c = with(&[("H", arr(vec![date(2024, 3, 18)]))]);
    check_in("WORKDAY(\"2024-03-15\", 1, {H})", &c, date(2024, 3, 19));
    check("WORKDAY(BLANK(), 3)", Value::Null);
    check_err("WORKDAY(\"2024-03-15\", 1, \"not-a-date\")", "holiday");
    check_err("WORKDAY(\"2024-03-15\", 1e15)", "out of range");
}

#[test]
fn workday_diff() {
    check("WORKDAY_DIFF(\"2024-03-11\", \"2024-03-22\")", n(10.0));
    check("WORKDAY_DIFF(\"2024-03-22\", \"2024-03-11\")", n(-10.0));
    check(
        "WORKDAY_DIFF(\"2024-03-11\", \"2024-03-22\", \"2024-03-15\")",
        n(9.0),
    );
    check(
        "WORKDAY_DIFF(\"2024-03-11\", \"2024-03-22\", \"2024-03-15, 2024-03-15, 2024-03-16\")",
        n(9.0),
    );
    check(
        "WORKDAY_DIFF(\"2024-03-11\", \"2024-03-22\", \"2024-04-01\")",
        n(10.0),
    );
    check("WORKDAY_DIFF(\"2024-03-15\", \"2024-03-15\")", n(1.0));
    check("WORKDAY_DIFF(\"2024-03-16\", \"2024-03-17\")", n(0.0));
    check("WORKDAY_DIFF(\"2024-01-01\", \"2024-12-31\")", n(262.0));
    check("WORKDAY_DIFF(\"2024-03-11\", BLANK())", Value::Null);
}

#[test]
fn datetime_parse_lenient() {
    check("DATETIME_PARSE(\"2024-03-15\")", dt("2024-03-15T00:00:00Z"));
    check(
        "DATETIME_PARSE(\"2024-03-15T10:30:00Z\")",
        dt("2024-03-15T10:30:00Z"),
    );
    check(
        "DATETIME_PARSE(\"2024-03-15T10:30:00.250+02:00\")",
        dt("2024-03-15T08:30:00.250Z"),
    );
    check(
        "DATETIME_PARSE(\"2024-03-15 10:30\")",
        dt("2024-03-15T10:30:00Z"),
    );
    check(
        "DATETIME_PARSE(\"2024-03-15T10:30\")",
        dt("2024-03-15T10:30:00Z"),
    );
    check("DATETIME_PARSE(\"2024/03/15\")", dt("2024-03-15T00:00:00Z"));
    check("DATETIME_PARSE(\"3/15/2024\")", dt("2024-03-15T00:00:00Z"));
    check(
        "DATETIME_PARSE(\"03/15/2024 2:30 PM\")",
        dt("2024-03-15T14:30:00Z"),
    );
    check(
        "DATETIME_PARSE(\"March 15, 2024\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"Mar 15 2024\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"15 March 2024\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"2024-03-15 10:30:00 UTC\")",
        dt("2024-03-15T10:30:00Z"),
    );
    check("DATETIME_PARSE(BLANK())", Value::Null);
    let c = d(date(2024, 3, 15));
    check_in("DATETIME_PARSE({D})", &c, dt("2024-03-15T00:00:00Z"));
    check_err("DATETIME_PARSE(\"garbage\")", "could not read 'garbage'");
    check_err("DATETIME_PARSE(\"2024-02-30\")", "could not read");
}

#[test]
fn datetime_parse_with_format() {
    check(
        "DATETIME_PARSE(\"15/03/2024\", \"DD/MM/YYYY\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"15.3.2024\", \"D.M.YYYY\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"3/15/2024 2:30 PM\", \"M/D/YYYY h:mm A\")",
        dt("2024-03-15T14:30:00Z"),
    );
    check(
        "DATETIME_PARSE(\"12:15 am 2024-01-01\", \"hh:mm a YYYY-MM-DD\")",
        dt("2024-01-01T00:15:00Z"),
    );
    check(
        "DATETIME_PARSE(\"12:15 PM 2024-01-01\", \"hh:mm A YYYY-MM-DD\")",
        dt("2024-01-01T12:15:00Z"),
    );
    check(
        "DATETIME_PARSE(\"March 15th, 2024\", \"MMMM Do, YYYY\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"15 Mar 24\", \"DD MMM YY\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"15 Mar 99\", \"DD MMM YY\")",
        dt("1999-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"1710505845\", \"X\")",
        dt("2024-03-15T12:30:45Z"),
    );
    check(
        "DATETIME_PARSE(\"1710505845123\", \"x\")",
        dt("2024-03-15T12:30:45.123Z"),
    );
    check(
        "DATETIME_PARSE(\"2024-03-15 10:00 +02:00\", \"YYYY-MM-DD HH:mm Z\")",
        dt("2024-03-15T08:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"2024-03-15 10:00 -0530\", \"YYYY-MM-DD HH:mm ZZ\")",
        dt("2024-03-15T15:30:00Z"),
    );
    check(
        "DATETIME_PARSE(\"20240315 101112.5\", \"YYYYMMDD HHmmss.S\")",
        dt("2024-03-15T10:11:12.500Z"),
    );
    check(
        "DATETIME_PARSE(\"Friday, 2024-03-15\", \"dddd, YYYY-MM-DD\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"075 2024\", \"DDD YYYY\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check(
        "DATETIME_PARSE(\"[2024]\", \"[[]YYYY]\")",
        dt("2024-01-01T00:00:00Z"),
    );
    // Missing year defaults to the current year.
    check(
        "DATETIME_PARSE(\"03/15\", \"MM/DD\")",
        dt("2024-03-15T00:00:00Z"),
    );
    // Locale is accepted and ignored.
    check(
        "DATETIME_PARSE(\"2024-03-15\", \"YYYY-MM-DD\", \"fr\")",
        dt("2024-03-15T00:00:00Z"),
    );
    check_err(
        "DATETIME_PARSE(\"31/02/2024\", \"DD/MM/YYYY\")",
        "could not read",
    );
    check_err("DATETIME_PARSE(\"hello\", \"YYYY\")", "could not read");
    check_err("DATETIME_PARSE(\"10 xx\", \"HH A\")", "could not read");
}
