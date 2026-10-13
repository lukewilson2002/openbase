//! Date filters: relative operands with a fixed `now`, viewer and field
//! zones, and days around DST transitions.

use chrono::{DateTime, TimeZone, Utc};
use serde_json::{Value as Json, json};

use super::*;
use crate::query::{QueryCtx, compile_filter, matches};
use crate::view::FilterOp::{self, *};

fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
}

fn dm(ctx: &QueryCtx, field: &str, op: FilterOp, operand: Json, cell: Json) -> bool {
    let f = compile_filter(&cond(field, op, operand.clone()), &table())
        .unwrap_or_else(|e| panic!("{field} {op:?} {operand}: {e}"));
    let cells = if cell.is_null() {
        json!({})
    } else {
        json!({ field: cell })
    };
    matches(&f, &row("r", cells), ctx, &names())
}

fn mode(m: &str) -> Json {
    json!({ "mode": m })
}

fn days(m: &str, n: u32) -> Json {
    json!({ "mode": m, "days": n })
}

fn exact(d: &str) -> Json {
    json!({ "mode": "exact_date", "date": d })
}

/// now = Monday 2026-10-12 15:00 UTC, viewer in UTC.
fn utc() -> QueryCtx {
    qctx()
}

#[test]
fn single_day_operands() {
    let c = utc();
    let cases = [
        (mode("today"), "2026-10-12"),
        (mode("tomorrow"), "2026-10-13"),
        (mode("yesterday"), "2026-10-11"),
        (mode("one_week_ago"), "2026-10-05"),
        (mode("one_week_from_now"), "2026-10-19"),
        (mode("one_month_ago"), "2026-09-12"),
        (mode("one_month_from_now"), "2026-11-12"),
        (days("number_of_days_ago", 3), "2026-10-09"),
        (days("number_of_days_from_now", 10), "2026-10-22"),
        (days("number_of_days_ago", 0), "2026-10-12"),
        (exact("2026-01-01"), "2026-01-01"),
        (exact("1/2/2026"), "2026-01-02"),
        (exact("March 4, 2026"), "2026-03-04"),
        (json!("2026-05-06"), "2026-05-06"),
        (exact("2026-05-06T23:00:00Z"), "2026-05-06"),
    ];
    for (operand, day) in cases {
        assert!(
            dm(&c, "fldDate", Is, operand.clone(), json!(day)),
            "{operand} is {day}"
        );
        assert!(
            !dm(&c, "fldDate", IsNot, operand.clone(), json!(day)),
            "{operand} is_not {day}"
        );
        assert!(
            !dm(&c, "fldDate", Is, operand.clone(), json!("2000-01-01")),
            "{operand}"
        );
        assert!(
            dm(&c, "fldDate", IsNot, operand.clone(), json!("2000-01-01")),
            "{operand}"
        );
    }
}

#[test]
fn comparisons() {
    let c = utc();
    let today = mode("today");
    assert!(dm(
        &c,
        "fldDate",
        IsBefore,
        today.clone(),
        json!("2026-10-11")
    ));
    assert!(!dm(
        &c,
        "fldDate",
        IsBefore,
        today.clone(),
        json!("2026-10-12")
    ));
    assert!(dm(
        &c,
        "fldDate",
        IsOnOrBefore,
        today.clone(),
        json!("2026-10-12")
    ));
    assert!(!dm(
        &c,
        "fldDate",
        IsOnOrBefore,
        today.clone(),
        json!("2026-10-13")
    ));
    assert!(dm(
        &c,
        "fldDate",
        IsAfter,
        today.clone(),
        json!("2026-10-13")
    ));
    assert!(!dm(
        &c,
        "fldDate",
        IsAfter,
        today.clone(),
        json!("2026-10-12")
    ));
    assert!(dm(
        &c,
        "fldDate",
        IsOnOrAfter,
        today.clone(),
        json!("2026-10-12")
    ));
    assert!(!dm(
        &c,
        "fldDate",
        IsOnOrAfter,
        today.clone(),
        json!("2026-10-11")
    ));
    // Date-times compare by calendar day: any time today "is" today and is
    // neither before nor after it.
    for t in ["2026-10-12T00:00:00.000Z", "2026-10-12T23:59:59.999Z"] {
        assert!(dm(&c, "fldDt", Is, today.clone(), json!(t)), "{t}");
        assert!(!dm(&c, "fldDt", IsBefore, today.clone(), json!(t)), "{t}");
        assert!(!dm(&c, "fldDt", IsAfter, today.clone(), json!(t)), "{t}");
    }
    assert!(dm(
        &c,
        "fldDt",
        IsBefore,
        today.clone(),
        json!("2026-10-11T23:59:59.000Z")
    ));
}

#[test]
fn empty_cells() {
    let c = utc();
    let today = mode("today");
    assert!(
        dm(&c, "fldDate", IsNot, today.clone(), Json::Null),
        "is not matches empty"
    );
    for op in [Is, IsBefore, IsAfter, IsOnOrBefore, IsOnOrAfter] {
        assert!(!dm(&c, "fldDate", op, today.clone(), Json::Null), "{op:?}");
    }
    assert!(!dm(&c, "fldDate", IsWithin, mode("past_week"), Json::Null));
    assert!(dm(&c, "fldDate", IsEmpty, Json::Null, Json::Null));
    assert!(dm(
        &c,
        "fldDate",
        IsNotEmpty,
        Json::Null,
        json!("2026-10-12")
    ));
    assert!(
        !dm(&c, "fldDate", Is, today, json!("garbage")),
        "malformed storage is empty"
    );
}

#[test]
fn within_ranges_are_inclusive() {
    let c = utc();
    let cases: [(Json, &str, &str); 10] = [
        (mode("past_week"), "2026-10-05", "2026-10-12"),
        (mode("past_month"), "2026-09-12", "2026-10-12"),
        (mode("past_year"), "2025-10-12", "2026-10-12"),
        (mode("next_week"), "2026-10-12", "2026-10-19"),
        (mode("next_month"), "2026-10-12", "2026-11-11"),
        (mode("next_year"), "2026-10-12", "2027-10-12"),
        (days("past_number_of_days", 2), "2026-10-10", "2026-10-12"),
        (days("next_number_of_days", 0), "2026-10-12", "2026-10-12"),
        (mode("this_calendar_month"), "2026-10-01", "2026-10-31"),
        (mode("this_calendar_year"), "2026-01-01", "2026-12-31"),
    ];
    for (operand, start, end) in cases {
        let before = chrono::NaiveDate::parse_from_str(start, "%Y-%m-%d")
            .unwrap()
            .pred_opt()
            .unwrap();
        let after = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .unwrap()
            .succ_opt()
            .unwrap();
        assert!(
            dm(&c, "fldDate", IsWithin, operand.clone(), json!(start)),
            "{operand} start"
        );
        assert!(
            dm(&c, "fldDate", IsWithin, operand.clone(), json!(end)),
            "{operand} end"
        );
        assert!(
            !dm(
                &c,
                "fldDate",
                IsWithin,
                operand.clone(),
                json!(before.to_string())
            ),
            "{operand} before"
        );
        assert!(
            !dm(
                &c,
                "fldDate",
                IsWithin,
                operand.clone(),
                json!(after.to_string())
            ),
            "{operand} after"
        );
    }
}

#[test]
fn month_arithmetic_clamps_to_month_end() {
    let c = qctx_in("UTC", at(2026, 3, 31, 12, 0));
    assert!(dm(
        &c,
        "fldDate",
        Is,
        mode("one_month_ago"),
        json!("2026-02-28")
    ));
    assert!(dm(
        &c,
        "fldDate",
        Is,
        mode("one_month_from_now"),
        json!("2026-04-30")
    ));
    let leap = qctx_in("UTC", at(2028, 2, 10, 12, 0));
    assert!(dm(
        &leap,
        "fldDate",
        IsWithin,
        mode("this_calendar_month"),
        json!("2028-02-29")
    ));
    assert!(!dm(
        &leap,
        "fldDate",
        IsWithin,
        mode("this_calendar_month"),
        json!("2028-03-01")
    ));
    let dec = qctx_in("UTC", at(2026, 12, 15, 12, 0));
    assert!(dm(
        &dec,
        "fldDate",
        IsWithin,
        mode("this_calendar_month"),
        json!("2026-12-31")
    ));
    assert!(dm(
        &dec,
        "fldDate",
        Is,
        mode("one_month_from_now"),
        json!("2027-01-15")
    ));
}

#[test]
fn viewer_zone_decides_today() {
    // 03:00 UTC on Oct 12 is still Oct 11 in Los Angeles, already Oct 12 in
    // Tokyo and Auckland.
    let now = at(2026, 10, 12, 3, 0);
    let la = qctx_in("America/Los_Angeles", now);
    let tokyo = qctx_in("Asia/Tokyo", now);
    let akl = qctx_in("Pacific/Auckland", now);
    let today = mode("today");
    assert!(dm(&la, "fldDate", Is, today.clone(), json!("2026-10-11")));
    assert!(dm(
        &tokyo,
        "fldDate",
        Is,
        today.clone(),
        json!("2026-10-12")
    ));
    assert!(dm(&akl, "fldDate", Is, today.clone(), json!("2026-10-12")));
    assert!(!dm(&la, "fldDate", Is, today.clone(), json!("2026-10-12")));
    // Date-times without a field zone are read in the viewer's zone.
    let t = json!("2026-10-12T02:00:00.000Z");
    assert!(
        dm(&la, "fldDt", Is, today.clone(), t.clone()),
        "Oct 11 19:00 in LA"
    );
    assert!(
        dm(&tokyo, "fldDt", Is, today.clone(), t.clone()),
        "Oct 12 11:00 in Tokyo"
    );
    let late = json!("2026-10-11T12:00:00.000Z");
    assert!(
        dm(&la, "fldDt", Is, today.clone(), late.clone()),
        "Oct 11 05:00 in LA"
    );
    assert!(
        dm(&akl, "fldDt", Is, today.clone(), late.clone()),
        "Oct 12 01:00 in Auckland"
    );
    assert!(
        dm(&tokyo, "fldDt", Is, mode("yesterday"), late),
        "Oct 11 21:00 in Tokyo"
    );
}

#[test]
fn field_zone_decides_cell_day() {
    // 16:00 UTC Oct 11 is 01:00 Oct 12 in Tokyo.
    let now = at(2026, 10, 12, 3, 0);
    let la = qctx_in("America/Los_Angeles", now); // today = Oct 11
    let cell = json!("2026-10-11T16:00:00.000Z");
    assert!(!dm(&la, "fldDtTokyo", Is, mode("today"), cell.clone()));
    assert!(dm(&la, "fldDtTokyo", Is, mode("tomorrow"), cell.clone()));
    assert!(
        dm(&la, "fldDt", Is, mode("today"), cell.clone()),
        "same instant, viewer zone"
    );
    assert!(dm(&la, "fldDtTokyo", Is, exact("2026-10-12"), cell.clone()));
}

#[test]
fn new_york_spring_forward() {
    // DST starts 2026-03-08 02:00 EST -> 03:00 EDT.
    let c = qctx_in("America/New_York", at(2026, 3, 9, 3, 30)); // Mar 8 23:30 EDT
    let today = mode("today");
    assert!(dm(&c, "fldDate", Is, today.clone(), json!("2026-03-08")));
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            mode("yesterday"),
            json!("2026-03-08T04:30:00.000Z")
        ),
        "Mar 7 23:30 EST"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            today.clone(),
            json!("2026-03-08T05:30:00.000Z")
        ),
        "Mar 8 00:30 EST"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            today.clone(),
            json!("2026-03-08T07:00:00.000Z")
        ),
        "Mar 8 03:00 EDT"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            today.clone(),
            json!("2026-03-09T03:59:00.000Z")
        ),
        "Mar 8 23:59 EDT"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            mode("tomorrow"),
            json!("2026-03-09T04:00:00.000Z")
        ),
        "Mar 9 00:00 EDT"
    );
    // Rolling past week straddling the change.
    let c = qctx_in("America/New_York", at(2026, 3, 10, 12, 0)); // Mar 10 08:00 EDT
    assert!(
        dm(
            &c,
            "fldDt",
            IsWithin,
            mode("past_week"),
            json!("2026-03-03T05:30:00.000Z")
        ),
        "Mar 3 00:30 EST"
    );
    assert!(
        !dm(
            &c,
            "fldDt",
            IsWithin,
            mode("past_week"),
            json!("2026-03-03T04:30:00.000Z")
        ),
        "Mar 2 23:30 EST"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            IsWithin,
            mode("past_week"),
            json!("2026-03-11T03:59:00.000Z")
        ),
        "Mar 10 23:59 EDT"
    );
    assert!(
        !dm(
            &c,
            "fldDt",
            IsWithin,
            mode("past_week"),
            json!("2026-03-11T04:00:00.000Z")
        ),
        "Mar 11 00:00 EDT"
    );
}

#[test]
fn new_york_fall_back() {
    // DST ends 2026-11-01 02:00 EDT -> 01:00 EST.
    let c = qctx_in("America/New_York", at(2026, 11, 2, 4, 30)); // Nov 1 23:30 EST
    let today = mode("today");
    assert!(dm(&c, "fldDate", Is, today.clone(), json!("2026-11-01")));
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            today.clone(),
            json!("2026-11-01T04:30:00.000Z")
        ),
        "Nov 1 00:30 EDT"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            mode("yesterday"),
            json!("2026-11-01T03:59:00.000Z")
        ),
        "Oct 31 23:59 EDT"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            today.clone(),
            json!("2026-11-01T05:30:00.000Z")
        ),
        "first 01:30 (EDT)"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            today.clone(),
            json!("2026-11-01T06:30:00.000Z")
        ),
        "second 01:30 (EST)"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            today.clone(),
            json!("2026-11-02T04:59:00.000Z")
        ),
        "Nov 1 23:59 EST"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            mode("tomorrow"),
            json!("2026-11-02T05:00:00.000Z")
        ),
        "Nov 2 00:00 EST"
    );
}

#[test]
fn london_and_southern_hemisphere() {
    // London: BST starts 2026-03-29 01:00 UTC.
    let c = qctx_in("Europe/London", at(2026, 3, 29, 23, 30)); // Mar 30 00:30 BST
    assert!(dm(&c, "fldDate", Is, mode("today"), json!("2026-03-30")));
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            mode("yesterday"),
            json!("2026-03-29T22:59:00.000Z")
        ),
        "Mar 29 23:59 BST"
    );
    // Sydney: DST ends 2026-04-05 03:00 AEDT -> 02:00 AEST.
    let c = qctx_in("Australia/Sydney", at(2026, 4, 5, 13, 30)); // Apr 5 23:30 AEST
    assert!(dm(&c, "fldDate", Is, mode("today"), json!("2026-04-05")));
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            mode("today"),
            json!("2026-04-04T13:30:00.000Z")
        ),
        "Apr 5 00:30 AEDT"
    );
    assert!(
        dm(
            &c,
            "fldDt",
            Is,
            mode("tomorrow"),
            json!("2026-04-05T14:00:00.000Z")
        ),
        "Apr 6 00:00 AEST"
    );
    // Kolkata: half-hour offset, no DST.
    let c = qctx_in("Asia/Kolkata", at(2026, 10, 12, 18, 29)); // Oct 12 23:59 IST
    assert!(dm(&c, "fldDate", Is, mode("today"), json!("2026-10-12")));
    let c = qctx_in("Asia/Kolkata", at(2026, 10, 12, 18, 30)); // Oct 13 00:00 IST
    assert!(dm(&c, "fldDate", Is, mode("today"), json!("2026-10-13")));
}

#[test]
fn computed_and_system_dates() {
    let c = utc();
    assert!(dm(
        &c,
        "fldCreated",
        Is,
        mode("today"),
        json!("2026-10-12T09:00:00.000Z")
    ));
    assert!(dm(
        &c,
        "fldCreated",
        IsWithin,
        mode("past_week"),
        json!("2026-10-06T09:00:00.000Z")
    ));
    assert!(dm(
        &c,
        "fldFDate",
        Is,
        mode("yesterday"),
        json!("2026-10-11")
    ));
    assert!(!dm(
        &c,
        "fldFDate",
        Is,
        mode("yesterday"),
        json!({"error": "#ERROR"})
    ));
}
