//! Calendar-week and calendar-month operands of `is_within`: the ranges they resolve to, where
//! the week starts, and how date-only and date-time cells fall into them across time zones.

use chrono::{DateTime, Datelike, Days, Months, NaiveDate, TimeZone, Utc, Weekday};
use serde_json::{Value as Json, json};

use super::*;
use crate::query::dates::{resolve_range, uses_week_start, week_start_from};
use crate::query::{QueryCtx, compile_filter, matches};
use crate::view::DateOperand;
use crate::view::FilterOp::*;

const SUN: Weekday = Weekday::Sun;
const MON: Weekday = Weekday::Mon;

fn day(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
}

fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
}

fn operand(mode: &str) -> DateOperand {
    serde_json::from_value(json!({ "mode": mode })).unwrap()
}

fn range(mode: &str, today: &str, week_start: Weekday) -> (String, String) {
    let (a, b) = resolve_range(&operand(mode), day(today), week_start)
        .unwrap_or_else(|| panic!("{mode} resolves for {today}"));
    (a.to_string(), b.to_string())
}

fn is_in(ctx: &QueryCtx, field: &str, mode: &str, cell: Json) -> bool {
    let operand = json!({ "mode": mode });
    let f = compile_filter(&cond(field, IsWithin, operand.clone()), &table())
        .unwrap_or_else(|e| panic!("{field} {mode}: {e}"));
    let cells = if cell.is_null() {
        json!({})
    } else {
        json!({ field: cell })
    };
    matches(&f, &row("r", cells), ctx, &names())
}

/// A date-only cell on each side of both ends of the range is (not) inside.
fn assert_date_range(ctx: &QueryCtx, mode: &str, start: &str, end: &str) {
    let before = day(start).pred_opt().unwrap().to_string();
    let after = day(end).succ_opt().unwrap().to_string();
    assert!(is_in(ctx, "fldDate", mode, json!(start)), "{mode} start");
    assert!(is_in(ctx, "fldDate", mode, json!(end)), "{mode} end");
    assert!(
        !is_in(ctx, "fldDate", mode, json!(before)),
        "{mode} before {start}"
    );
    assert!(
        !is_in(ctx, "fldDate", mode, json!(after)),
        "{mode} after {end}"
    );
}

#[test]
fn the_modes_are_range_modes_and_only_weeks_depend_on_the_week_start() {
    for mode in [
        "this_calendar_week",
        "next_calendar_week",
        "last_calendar_week",
        "next_calendar_month",
        "last_calendar_month",
    ] {
        let op = operand(mode);
        assert!(crate::query::dates::is_range_mode(&op), "{mode}");
        assert_eq!(uses_week_start(&op), mode.ends_with("week"), "{mode}");
        assert_eq!(serde_json::to_value(&op).unwrap(), json!({ "mode": mode }));
    }
    assert!(!uses_week_start(&operand("this_calendar_month")));
    assert!(!uses_week_start(&operand("past_week")));
}

#[test]
fn the_week_start_is_sunday_or_monday() {
    assert_eq!(week_start_from(0), Some(SUN));
    assert_eq!(week_start_from(1), Some(MON));
    for n in [-1, 2, 7, i64::MAX] {
        assert_eq!(week_start_from(n), None, "{n}");
    }
    assert_eq!(utc_ctx().week_start, SUN, "Sunday unless told otherwise");
}

fn utc_ctx() -> QueryCtx {
    qctx_in("UTC", at(2026, 10, 12, 15, 0))
}

#[test]
fn every_day_of_a_week_resolves_to_the_same_week() {
    // 2026-10-11 is a Sunday.
    for (today, sunday_start, monday_start) in [
        ("2026-10-11", "2026-10-11", "2026-10-05"), // Sunday
        ("2026-10-12", "2026-10-11", "2026-10-12"), // Monday
        ("2026-10-13", "2026-10-11", "2026-10-12"),
        ("2026-10-14", "2026-10-11", "2026-10-12"),
        ("2026-10-15", "2026-10-11", "2026-10-12"),
        ("2026-10-16", "2026-10-11", "2026-10-12"),
        ("2026-10-17", "2026-10-11", "2026-10-12"), // Saturday
        ("2026-10-18", "2026-10-18", "2026-10-12"), // Sunday again
    ] {
        for (week_start, first) in [(SUN, sunday_start), (MON, monday_start)] {
            let last = day(first)
                .checked_add_days(Days::new(6))
                .unwrap()
                .to_string();
            assert_eq!(
                range("this_calendar_week", today, week_start),
                (first.to_string(), last),
                "{today} from {week_start}"
            );
        }
    }
}

#[test]
fn next_and_last_week_are_seven_days_either_way() {
    assert_eq!(
        range("next_calendar_week", "2026-10-14", SUN),
        ("2026-10-18".into(), "2026-10-24".into())
    );
    assert_eq!(
        range("last_calendar_week", "2026-10-14", SUN),
        ("2026-10-04".into(), "2026-10-10".into())
    );
    assert_eq!(
        range("next_calendar_week", "2026-10-14", MON),
        ("2026-10-19".into(), "2026-10-25".into())
    );
    assert_eq!(
        range("last_calendar_week", "2026-10-14", MON),
        ("2026-10-05".into(), "2026-10-11".into())
    );
    // On the first and last day of the week the neighbours do not move.
    assert_eq!(
        range("next_calendar_week", "2026-10-11", SUN),
        ("2026-10-18".into(), "2026-10-24".into())
    );
    assert_eq!(
        range("last_calendar_week", "2026-10-17", SUN),
        ("2026-10-04".into(), "2026-10-10".into())
    );
    // On a Sunday a Monday-start week is still the one that began the Monday before.
    assert_eq!(
        range("next_calendar_week", "2026-10-11", MON),
        ("2026-10-12".into(), "2026-10-18".into())
    );
    assert_eq!(
        range("last_calendar_week", "2026-10-11", MON),
        ("2026-09-28".into(), "2026-10-04".into())
    );
}

#[test]
fn weeks_cross_month_and_year_ends() {
    // 2026-12-31 is a Thursday.
    assert_eq!(
        range("this_calendar_week", "2026-12-31", SUN),
        ("2026-12-27".into(), "2027-01-02".into())
    );
    assert_eq!(
        range("this_calendar_week", "2026-12-31", MON),
        ("2026-12-28".into(), "2027-01-03".into())
    );
    assert_eq!(
        range("next_calendar_week", "2026-12-31", SUN),
        ("2027-01-03".into(), "2027-01-09".into())
    );
    assert_eq!(
        range("last_calendar_week", "2026-12-31", SUN),
        ("2026-12-20".into(), "2026-12-26".into())
    );
    // 2027-01-01 is a Friday: the week began in the old year.
    assert_eq!(
        range("this_calendar_week", "2027-01-01", SUN),
        ("2026-12-27".into(), "2027-01-02".into())
    );
    assert_eq!(
        range("last_calendar_week", "2027-01-01", MON),
        ("2026-12-21".into(), "2026-12-27".into())
    );
    // Leap day.
    assert_eq!(
        range("this_calendar_week", "2028-02-29", MON),
        ("2028-02-28".into(), "2028-03-05".into())
    );
    assert_eq!(
        range("next_calendar_week", "2028-02-23", SUN),
        ("2028-02-27".into(), "2028-03-04".into())
    );
}

#[test]
fn other_week_starts_resolve_too() {
    // The core takes any weekday even though the profile offers two.
    assert_eq!(
        range("this_calendar_week", "2026-10-14", Weekday::Sat),
        ("2026-10-10".into(), "2026-10-16".into())
    );
    assert_eq!(
        range("this_calendar_week", "2026-10-14", Weekday::Wed),
        ("2026-10-14".into(), "2026-10-20".into())
    );
    assert_eq!(
        range("this_calendar_week", "2026-10-14", Weekday::Thu),
        ("2026-10-08".into(), "2026-10-14".into())
    );
}

#[test]
fn next_and_last_month_are_whole_months() {
    for (today, next, last) in [
        (
            "2026-10-12",
            ("2026-11-01", "2026-11-30"),
            ("2026-09-01", "2026-09-30"),
        ),
        // Year rollover both ways.
        (
            "2026-12-15",
            ("2027-01-01", "2027-01-31"),
            ("2026-11-01", "2026-11-30"),
        ),
        (
            "2027-01-15",
            ("2027-02-01", "2027-02-28"),
            ("2026-12-01", "2026-12-31"),
        ),
        // A long month beside a short one: the day of the month never clamps the result.
        (
            "2026-01-31",
            ("2026-02-01", "2026-02-28"),
            ("2025-12-01", "2025-12-31"),
        ),
        (
            "2026-03-31",
            ("2026-04-01", "2026-04-30"),
            ("2026-02-01", "2026-02-28"),
        ),
        (
            "2026-05-31",
            ("2026-06-01", "2026-06-30"),
            ("2026-04-01", "2026-04-30"),
        ),
        // Leap years.
        (
            "2028-01-31",
            ("2028-02-01", "2028-02-29"),
            ("2027-12-01", "2027-12-31"),
        ),
        (
            "2028-03-01",
            ("2028-04-01", "2028-04-30"),
            ("2028-02-01", "2028-02-29"),
        ),
        (
            "2100-01-31", // 2100 is not a leap year
            ("2100-02-01", "2100-02-28"),
            ("2099-12-01", "2099-12-31"),
        ),
        // The first and the last day of a month.
        (
            "2026-10-01",
            ("2026-11-01", "2026-11-30"),
            ("2026-09-01", "2026-09-30"),
        ),
        (
            "2026-10-31",
            ("2026-11-01", "2026-11-30"),
            ("2026-09-01", "2026-09-30"),
        ),
    ] {
        for week_start in [SUN, MON] {
            assert_eq!(
                range("next_calendar_month", today, week_start),
                (next.0.into(), next.1.into()),
                "next month of {today}"
            );
            assert_eq!(
                range("last_calendar_month", today, week_start),
                (last.0.into(), last.1.into()),
                "last month of {today}"
            );
        }
    }
}

/// Every day of three years: the ranges keep their shape whatever the date and week start.
#[test]
fn the_ranges_hold_for_every_day_of_three_years() {
    let mut today = day("2026-01-01");
    while today < day("2029-01-01") {
        for week_start in [SUN, MON] {
            let get = |mode: &str| resolve_range(&operand(mode), today, week_start).unwrap();
            let (this_a, this_b) = get("this_calendar_week");
            assert_eq!(this_a.weekday(), week_start, "{today}");
            assert_eq!((this_b - this_a).num_days(), 6, "{today}");
            assert!(this_a <= today && today <= this_b, "{today} is in its week");
            let (next_a, next_b) = get("next_calendar_week");
            assert_eq!(next_a, this_b.succ_opt().unwrap(), "{today}");
            assert_eq!((next_b - next_a).num_days(), 6, "{today}");
            let (last_a, last_b) = get("last_calendar_week");
            assert_eq!(last_b, this_a.pred_opt().unwrap(), "{today}");
            assert_eq!((last_b - last_a).num_days(), 6, "{today}");

            let (cur_a, cur_b) = get("this_calendar_month");
            let (next_a, next_b) = get("next_calendar_month");
            let (last_a, last_b) = get("last_calendar_month");
            assert_eq!(next_a, cur_b.succ_opt().unwrap(), "{today}");
            assert_eq!(last_b, cur_a.pred_opt().unwrap(), "{today}");
            for (a, b) in [(last_a, last_b), (next_a, next_b)] {
                assert_eq!(a.day(), 1, "{today}");
                assert_eq!(
                    b,
                    a.checked_add_months(Months::new(1))
                        .unwrap()
                        .pred_opt()
                        .unwrap(),
                    "{today}"
                );
            }
        }
        today = today.succ_opt().unwrap();
    }
}

#[test]
fn the_calendar_ends_of_time_do_not_panic() {
    for mode in [
        "this_calendar_week",
        "next_calendar_week",
        "last_calendar_week",
        "next_calendar_month",
        "last_calendar_month",
    ] {
        for d in [NaiveDate::MIN, NaiveDate::MAX] {
            let _ = resolve_range(&operand(mode), d, SUN);
        }
    }
    assert_eq!(
        resolve_range(&operand("next_calendar_week"), NaiveDate::MAX, SUN),
        None
    );
    assert_eq!(
        resolve_range(&operand("last_calendar_week"), NaiveDate::MIN, MON),
        None
    );
}

#[test]
fn weeks_follow_the_context_week_start() {
    // Wednesday 2026-10-14.
    let now = at(2026, 10, 14, 12, 0);
    let sunday = qctx_in("UTC", now);
    let monday = qctx_in("UTC", now).with_week_start(MON);
    assert_date_range(&sunday, "this_calendar_week", "2026-10-11", "2026-10-17");
    assert_date_range(&monday, "this_calendar_week", "2026-10-12", "2026-10-18");
    assert_date_range(&sunday, "next_calendar_week", "2026-10-18", "2026-10-24");
    assert_date_range(&monday, "next_calendar_week", "2026-10-19", "2026-10-25");
    assert_date_range(&sunday, "last_calendar_week", "2026-10-04", "2026-10-10");
    assert_date_range(&monday, "last_calendar_week", "2026-10-05", "2026-10-11");
    // Sunday 2026-10-18 belongs to the next week for Sunday-start, the last day of this one for Monday-start.
    assert!(is_in(
        &sunday,
        "fldDate",
        "next_calendar_week",
        json!("2026-10-18")
    ));
    assert!(!is_in(
        &monday,
        "fldDate",
        "next_calendar_week",
        json!("2026-10-18")
    ));
    assert!(is_in(
        &monday,
        "fldDate",
        "this_calendar_week",
        json!("2026-10-18")
    ));
}

#[test]
fn months_through_the_filter() {
    let c = qctx_in("UTC", at(2026, 12, 15, 12, 0));
    assert_date_range(&c, "next_calendar_month", "2027-01-01", "2027-01-31");
    assert_date_range(&c, "last_calendar_month", "2026-11-01", "2026-11-30");
    let leap = qctx_in("UTC", at(2028, 1, 31, 12, 0));
    assert_date_range(&leap, "next_calendar_month", "2028-02-01", "2028-02-29");
    let mar = qctx_in("UTC", at(2028, 3, 31, 12, 0));
    assert_date_range(&mar, "last_calendar_month", "2028-02-01", "2028-02-29");
}

#[test]
fn empty_cells_are_in_no_calendar_range() {
    let c = utc_ctx();
    for mode in [
        "this_calendar_week",
        "next_calendar_week",
        "last_calendar_week",
        "next_calendar_month",
        "last_calendar_month",
    ] {
        assert!(!is_in(&c, "fldDate", mode, Json::Null), "{mode}");
        assert!(!is_in(&c, "fldDt", mode, Json::Null), "{mode}");
    }
}

#[test]
fn the_new_ranges_are_for_is_within_only() {
    for op in [Is, IsNot, IsBefore, IsAfter, IsOnOrBefore, IsOnOrAfter] {
        for mode in [
            "this_calendar_week",
            "next_calendar_week",
            "last_calendar_week",
            "next_calendar_month",
            "last_calendar_month",
        ] {
            let err = compile_filter(&cond("fldDate", op, json!({ "mode": mode })), &table())
                .expect_err(&format!("{op:?} {mode}"));
            assert!(err.contains("needs a single day"), "{err}");
        }
    }
}

#[test]
fn zones_east_and_west_of_utc_decide_the_week() {
    // Saturday 2026-10-17 12:00 UTC: Kiritimati (UTC+14) is already on Sunday the 18th,
    // Pago Pago (UTC-11) is still on the 17th, 01:00 that day.
    let now = at(2026, 10, 17, 12, 0);
    let utc = qctx_in("UTC", now);
    let east = qctx_in("Pacific/Kiritimati", now);
    let west = qctx_in("Pacific/Pago_Pago", now);
    assert_date_range(&utc, "this_calendar_week", "2026-10-11", "2026-10-17");
    assert_date_range(&west, "this_calendar_week", "2026-10-11", "2026-10-17");
    assert_date_range(&east, "this_calendar_week", "2026-10-18", "2026-10-24");
    assert_date_range(&east, "last_calendar_week", "2026-10-11", "2026-10-17");
    assert_date_range(&east, "next_calendar_week", "2026-10-25", "2026-10-31");
    // With Monday weeks all three agree: Oct 12 to 18 holds both the 17th and the 18th.
    for ctx in [&utc, &east, &west] {
        let ctx = ctx.clone().with_week_start(MON);
        assert_date_range(&ctx, "this_calendar_week", "2026-10-12", "2026-10-18");
    }

    // The far end of the other side: Sunday 2026-10-18 05:00 UTC is still Saturday the 17th
    // (18:00) at Pago Pago, and already Sunday the 18th at 19:00 in Kiritimati, 05:00 in UTC.
    let now = at(2026, 10, 18, 5, 0);
    assert_date_range(
        &qctx_in("Pacific/Pago_Pago", now),
        "this_calendar_week",
        "2026-10-11",
        "2026-10-17",
    );
    assert_date_range(
        &qctx_in("UTC", now),
        "this_calendar_week",
        "2026-10-18",
        "2026-10-24",
    );
    // Month edge: 2026-10-31 23:00 UTC is already November 1st in Tokyo.
    let now = at(2026, 10, 31, 23, 0);
    assert_date_range(
        &qctx_in("UTC", now),
        "next_calendar_month",
        "2026-11-01",
        "2026-11-30",
    );
    assert_date_range(
        &qctx_in("Asia/Tokyo", now),
        "next_calendar_month",
        "2026-12-01",
        "2026-12-31",
    );
    assert_date_range(
        &qctx_in("Asia/Tokyo", now),
        "last_calendar_month",
        "2026-10-01",
        "2026-10-31",
    );
    // And New Year's Eve in Los Angeles is still the old year when UTC has moved on.
    let now = at(2027, 1, 1, 3, 0);
    assert_date_range(
        &qctx_in("America/Los_Angeles", now),
        "next_calendar_month",
        "2027-01-01",
        "2027-01-31",
    );
    assert_date_range(
        &qctx_in("UTC", now),
        "next_calendar_month",
        "2027-02-01",
        "2027-02-28",
    );
}

#[test]
fn date_times_fall_in_the_week_of_their_local_day() {
    // Los Angeles on Saturday 2026-10-17 05:00 (12:00 UTC).
    let la = qctx_in("America/Los_Angeles", at(2026, 10, 17, 12, 0));
    // Sunday 00:00 in LA is 07:00 UTC; one minute earlier is still Saturday: this week.
    assert!(is_in(
        &la,
        "fldDt",
        "this_calendar_week",
        json!("2026-10-18T06:59:00.000Z")
    ));
    assert!(!is_in(
        &la,
        "fldDt",
        "next_calendar_week",
        json!("2026-10-18T06:59:00.000Z")
    ));
    assert!(!is_in(
        &la,
        "fldDt",
        "this_calendar_week",
        json!("2026-10-18T07:00:00.000Z")
    ));
    assert!(is_in(
        &la,
        "fldDt",
        "next_calendar_week",
        json!("2026-10-18T07:00:00.000Z")
    ));
    // The start of this week: Sunday 2026-10-11 00:00 PDT is 07:00 UTC.
    assert!(is_in(
        &la,
        "fldDt",
        "this_calendar_week",
        json!("2026-10-11T07:00:00.000Z")
    ));
    assert!(is_in(
        &la,
        "fldDt",
        "last_calendar_week",
        json!("2026-10-11T06:59:00.000Z")
    ));
    // The same instants in UTC: Sunday 06:59 is the next week already.
    let utc = qctx_in("UTC", at(2026, 10, 17, 12, 0));
    assert!(is_in(
        &utc,
        "fldDt",
        "next_calendar_week",
        json!("2026-10-18T06:59:00.000Z")
    ));

    // A date-time field with its own zone decides by that zone, not the viewer's: 16:00 UTC
    // on Saturday is Sunday 01:00 in Tokyo.
    let cell = json!("2026-10-17T16:00:00.000Z");
    assert!(is_in(&la, "fldDt", "this_calendar_week", cell.clone()));
    assert!(!is_in(
        &la,
        "fldDtTokyo",
        "this_calendar_week",
        cell.clone()
    ));
    assert!(is_in(&la, "fldDtTokyo", "next_calendar_week", cell.clone()));
    // Monday weeks: Sunday in Tokyo closes the week of Monday the 12th.
    let la_monday = la.clone().with_week_start(MON);
    assert!(is_in(&la_monday, "fldDtTokyo", "this_calendar_week", cell));
}

#[test]
fn date_only_cells_ignore_the_zone() {
    // The same stored date is in the same week for every viewer who is on that week.
    let now = at(2026, 10, 14, 12, 0);
    for zone in [
        "UTC",
        "Pacific/Pago_Pago",
        "Pacific/Kiritimati",
        "Asia/Kolkata",
        "America/St_Johns",
    ] {
        let c = qctx_in(zone, now);
        assert!(
            is_in(&c, "fldDate", "this_calendar_week", json!("2026-10-11")),
            "{zone}"
        );
        assert!(
            is_in(&c, "fldDate", "this_calendar_week", json!("2026-10-17")),
            "{zone}"
        );
        assert!(
            !is_in(&c, "fldDate", "this_calendar_week", json!("2026-10-18")),
            "{zone}"
        );
        assert!(
            is_in(&c, "fldDate", "next_calendar_month", json!("2026-11-30")),
            "{zone}"
        );
    }
}

#[test]
fn spring_forward_week_in_chicago() {
    // DST starts Sunday 2026-03-08 at 02:00 CST, a 23-hour day. 01:30 CST that Sunday:
    let c = qctx_in("America/Chicago", at(2026, 3, 8, 7, 30));
    assert_date_range(&c, "this_calendar_week", "2026-03-08", "2026-03-14");
    assert_date_range(
        &c.clone().with_week_start(MON),
        "this_calendar_week",
        "2026-03-02",
        "2026-03-08",
    );
    // Sunday 00:00 CST is 06:00 UTC: a minute earlier is still the week before.
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-03-08T06:00:00.000Z")
    ));
    assert!(is_in(
        &c,
        "fldDt",
        "last_calendar_week",
        json!("2026-03-08T05:59:00.000Z")
    ));
    // The week ends Saturday 23:59 CDT (UTC-5), 04:59 UTC on Sunday the 15th.
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-03-15T04:59:00.000Z")
    ));
    assert!(is_in(
        &c,
        "fldDt",
        "next_calendar_week",
        json!("2026-03-15T05:00:00.000Z")
    ));
    // With Monday weeks the week closes on that Sunday: 23:59 CDT is 04:59 UTC on Monday the 9th.
    let mon = c.with_week_start(MON);
    assert!(is_in(
        &mon,
        "fldDt",
        "this_calendar_week",
        json!("2026-03-09T04:59:00.000Z")
    ));
    assert!(is_in(
        &mon,
        "fldDt",
        "next_calendar_week",
        json!("2026-03-09T05:00:00.000Z")
    ));
}

#[test]
fn fall_back_week_in_chicago() {
    // DST ends Sunday 2026-11-01 at 02:00 CDT, a 25-hour day. Noon UTC is 06:00 CST.
    let c = qctx_in("America/Chicago", at(2026, 11, 1, 12, 0));
    assert_date_range(&c, "this_calendar_week", "2026-11-01", "2026-11-07");
    // Sunday 00:00 CDT is 05:00 UTC; a minute earlier is Saturday night, last week.
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-11-01T05:00:00.000Z")
    ));
    assert!(is_in(
        &c,
        "fldDt",
        "last_calendar_week",
        json!("2026-11-01T04:59:00.000Z")
    ));
    // Both 01:30s of the repeated hour are Sunday.
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-11-01T06:30:00.000Z")
    ));
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-11-01T07:30:00.000Z")
    ));
    // The week ends Saturday 23:59 CST (UTC-6) = 05:59 UTC on the 8th.
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-11-08T05:59:00.000Z")
    ));
    assert!(is_in(
        &c,
        "fldDt",
        "next_calendar_week",
        json!("2026-11-08T06:00:00.000Z")
    ));
    // A "now" inside the 25-hour day keeps the same week and month.
    let before = qctx_in("America/Chicago", at(2026, 11, 1, 5, 30));
    assert_date_range(&before, "this_calendar_week", "2026-11-01", "2026-11-07");
    assert_date_range(&before, "next_calendar_month", "2026-12-01", "2026-12-31");
    assert_date_range(&before, "last_calendar_month", "2026-10-01", "2026-10-31");
    // Saturday 23:30 CDT Oct 31 (04:30 UTC Nov 1): the last week, and still October.
    let saturday = qctx_in("America/Chicago", at(2026, 10, 31, 23, 0));
    assert_date_range(&saturday, "this_calendar_week", "2026-10-25", "2026-10-31");
    assert_date_range(&saturday, "next_calendar_month", "2026-11-01", "2026-11-30");
}

#[test]
fn southern_hemisphere_dst_week_in_sydney() {
    // DST starts Sunday 2026-10-04 at 02:00 AEST (UTC+10) -> 03:00 AEDT (UTC+11).
    // 20:00 UTC on the 3rd is 07:00 AEDT on the 4th.
    let c = qctx_in("Australia/Sydney", at(2026, 10, 3, 20, 0)).with_week_start(MON);
    assert_date_range(&c, "this_calendar_week", "2026-09-28", "2026-10-04");
    // Sunday 23:59 AEDT is 12:59 UTC; Monday 00:00 AEDT is 13:00 UTC.
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-10-04T12:59:00.000Z")
    ));
    assert!(is_in(
        &c,
        "fldDt",
        "next_calendar_week",
        json!("2026-10-04T13:00:00.000Z")
    ));
    // Monday 2026-09-28 00:00 AEST is 14:00 UTC the day before.
    assert!(is_in(
        &c,
        "fldDt",
        "this_calendar_week",
        json!("2026-09-27T14:00:00.000Z")
    ));
    assert!(is_in(
        &c,
        "fldDt",
        "last_calendar_week",
        json!("2026-09-27T13:59:00.000Z")
    ));
    // The same moment for a Sunday-start viewer.
    let sun = qctx_in("Australia/Sydney", at(2026, 10, 3, 20, 0));
    assert_date_range(&sun, "this_calendar_week", "2026-10-04", "2026-10-10");
}

#[test]
fn month_ends_across_the_date_line() {
    // 2026-02-28 23:00 UTC: March 1st already in Auckland (UTC+13 in summer), still February in LA.
    let now = at(2026, 2, 28, 23, 0);
    assert_date_range(
        &qctx_in("Pacific/Auckland", now),
        "last_calendar_month",
        "2026-02-01",
        "2026-02-28",
    );
    assert_date_range(
        &qctx_in("Pacific/Auckland", now),
        "next_calendar_month",
        "2026-04-01",
        "2026-04-30",
    );
    assert_date_range(
        &qctx_in("America/Los_Angeles", now),
        "next_calendar_month",
        "2026-03-01",
        "2026-03-31",
    );
    // 07:59 UTC is still February 28th (23:59) in Los Angeles but already March 1st in Auckland;
    // one minute later it is March 1st in both.
    let la = qctx_in("America/Los_Angeles", now);
    let akl = qctx_in("Pacific/Auckland", now);
    let last_minute = json!("2026-03-01T07:59:00.000Z");
    let first_minute = json!("2026-03-01T08:00:00.000Z");
    assert!(!is_in(
        &la,
        "fldDt",
        "next_calendar_month",
        last_minute.clone()
    ));
    assert!(is_in(
        &la,
        "fldDt",
        "next_calendar_month",
        first_minute.clone()
    ));
    assert!(!is_in(&akl, "fldDt", "last_calendar_month", last_minute));
    assert!(!is_in(&akl, "fldDt", "last_calendar_month", first_minute));
}
