//! DATETIME_FORMAT and its Moment.js tokens.

use super::support::*;
use crate::value::Value;

/// Friday 2024-01-05 14:07:09.045 UTC.
fn ctx() -> Ctx {
    with(&[
        ("D", dt("2024-01-05T14:07:09.045Z")),
        ("Summer", dt("2024-07-01T12:00:00Z")),
        ("Midnight", dt("2024-01-05T00:05:00Z")),
        ("Day", date(2024, 1, 5)),
    ])
}

#[track_caller]
fn fmt(token: &str, expected: &str) {
    let src = format!("DATETIME_FORMAT({{D}}, \"{token}\")");
    check_in(&src, &ctx(), t(expected));
}

#[test]
fn year_quarter_month_tokens() {
    fmt("YYYY", "2024");
    fmt("YY", "24");
    fmt("Q", "1");
    fmt("Qo", "1st");
    fmt("M", "1");
    fmt("Mo", "1st");
    fmt("MM", "01");
    fmt("MMM", "Jan");
    fmt("MMMM", "January");
}

#[test]
fn day_tokens() {
    fmt("D", "5");
    fmt("DD", "05");
    fmt("Do", "5th");
    fmt("DDD", "5");
    fmt("DDDo", "5th");
    fmt("DDDD", "005");
    fmt("d", "5");
    fmt("do", "5th");
    fmt("dd", "Fr");
    fmt("ddd", "Fri");
    fmt("dddd", "Friday");
    fmt("e", "5");
    fmt("E", "5");
}

#[test]
fn week_tokens() {
    fmt("w", "1");
    fmt("wo", "1st");
    fmt("ww", "01");
    fmt("W", "1");
    fmt("Wo", "1st");
    fmt("WW", "01");
    fmt("gggg", "2024");
    fmt("GGGG", "2024");
    // Dec 31 2024 is in locale week 1 of 2025 and ISO week 1 of 2025.
    check(
        "DATETIME_FORMAT(\"2024-12-31\", \"w gggg W GGGG\")",
        t("1 2025 1 2025"),
    );
    // Jan 1 2021 (Friday) is ISO week 53 of 2020.
    check(
        "DATETIME_FORMAT(\"2021-01-01\", \"W GGGG w\")",
        t("53 2020 1"),
    );
}

#[test]
fn time_tokens() {
    fmt("H", "14");
    fmt("HH", "14");
    fmt("h", "2");
    fmt("hh", "02");
    fmt("k", "14");
    fmt("kk", "14");
    fmt("m", "7");
    fmt("mm", "07");
    fmt("s", "9");
    fmt("ss", "09");
    fmt("S", "0");
    fmt("SS", "04");
    fmt("SSS", "045");
    fmt("A", "PM");
    fmt("a", "pm");
    fmt("X", "1704463629");
    fmt("x", "1704463629045");
    fmt("Z", "+00:00");
    fmt("ZZ", "+0000");
    let c = ctx();
    check_in(
        "DATETIME_FORMAT({Midnight}, \"h:mm A k kk H\")",
        &c,
        t("12:05 AM 24 24 0"),
    );
}

#[test]
fn localized_tokens() {
    fmt("LT", "2:07 PM");
    fmt("LTS", "2:07:09 PM");
    fmt("L", "01/05/2024");
    fmt("LL", "January 5, 2024");
    fmt("LLL", "January 5, 2024 2:07 PM");
    fmt("LLLL", "Friday, January 5, 2024 2:07 PM");
    fmt("l", "1/5/2024");
    fmt("ll", "Jan 5, 2024");
    fmt("lll", "Jan 5, 2024 2:07 PM");
    fmt("llll", "Fri, Jan 5, 2024 2:07 PM");
}

#[test]
fn combined_formats_and_escapes() {
    fmt("YYYY-MM-DD", "2024-01-05");
    fmt("DD/MM/YYYY HH:mm", "05/01/2024 14:07");
    fmt("MMMM Do, YYYY [at] h:mma", "January 5th, 2024 at 2:07pm");
    fmt("[Today is] dddd", "Today is Friday");
    fmt("[Q]Q-YYYY", "Q1-2024");
    // Like Moment, an unclosed '[' is literal and the rest is tokenized.
    fmt("[unclosed", "[unc1/5/2024o955");
    // Characters that are not tokens pass through.
    fmt("YYYY年M月D日", "2024年1月5日");
}

#[test]
fn ordinals() {
    for (day, expected) in [
        (1, "1st"),
        (2, "2nd"),
        (3, "3rd"),
        (4, "4th"),
        (11, "11th"),
        (12, "12th"),
        (13, "13th"),
        (21, "21st"),
        (22, "22nd"),
        (23, "23rd"),
        (31, "31st"),
    ] {
        check(
            &format!("DATETIME_FORMAT(\"2024-01-{day:02}\", \"Do\")"),
            t(expected),
        );
    }
}

#[test]
fn default_format_is_iso() {
    let c = ctx();
    check_in("DATETIME_FORMAT({D})", &c, t("2024-01-05T14:07:09Z"));
    check_in("DATETIME_FORMAT({D}, \"\")", &c, t("2024-01-05T14:07:09Z"));
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE({D}, \"America/New_York\"))",
        &c,
        t("2024-01-05T09:07:09-05:00"),
    );
}

#[test]
fn formats_in_nested_timezone() {
    let c = ctx();
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE({D}, \"America/New_York\"), \"YYYY-MM-DD HH:mm Z\")",
        &c,
        t("2024-01-05 09:07 -05:00"),
    );
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE({Summer}, \"America/New_York\"), \"HH:mm ZZ\")",
        &c,
        t("08:00 -0400"),
    );
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE({D}, \"Asia/Kolkata\"), \"HH:mm Z\")",
        &c,
        t("19:37 +05:30"),
    );
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE({D}, \"Pacific/Kiritimati\"), \"dddd D\")",
        &c,
        t("Saturday 6"),
    );
    // The outermost SET_TIMEZONE wins.
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE(SET_TIMEZONE({D}, \"Asia/Tokyo\"), \"UTC\"), \"HH\")",
        &c,
        t("14"),
    );
    // SET_LOCALE is accepted but output stays English.
    check_in(
        "DATETIME_FORMAT(SET_LOCALE({D}, \"fr\"), \"MMMM dddd\")",
        &c,
        t("January Friday"),
    );
    check_in(
        "DATETIME_FORMAT(SET_LOCALE(SET_TIMEZONE({D}, \"Asia/Tokyo\"), \"ja\"), \"HH:mm\")",
        &c,
        t("23:07"),
    );
    // X/x are timezone independent.
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE({D}, \"Asia/Tokyo\"), \"X\")",
        &c,
        t("1704463629"),
    );
}

#[test]
fn calendar_dates_format_without_shifting() {
    let c = ctx();
    check_in(
        "DATETIME_FORMAT({Day}, \"YYYY-MM-DD HH:mm\")",
        &c,
        t("2024-01-05 00:00"),
    );
    check_in(
        "DATETIME_FORMAT(SET_TIMEZONE({Day}, \"America/Los_Angeles\"), \"YYYY-MM-DD Z\")",
        &c,
        t("2024-01-05 -08:00"),
    );
}

#[test]
fn format_blank_and_errors() {
    check("DATETIME_FORMAT(BLANK(), \"YYYY\")", Value::Null);
    check("DATETIME_FORMAT(\"2024-03-15\", \"YYYY\")", t("2024"));
    check_err("DATETIME_FORMAT(\"not a date\", \"YYYY\")", "as a date");
    check_err("DATETIME_FORMAT(NOW(), ERROR())", "#ERROR!");
    check_err(
        &format!("DATETIME_FORMAT(NOW(), \"{}\")", "Y".repeat(1001)),
        "too long",
    );
}

#[test]
fn years_outside_four_digits() {
    let c = with(&[("Old", date(10, 3, 1))]);
    check_in("DATETIME_FORMAT({Old}, \"YYYY YY\")", &c, t("0010 10"));
}
