//! Cron scheduling for the `schedule` trigger.
//!
//! Patterns use croner syntax (5 fields: minute hour day-of-month month
//! day-of-week; a leading seconds field is also accepted; `@daily`-style
//! nicknames work). Occurrences are computed in the automation's IANA time
//! zone, so "every day at 09:00" stays at 09:00 wall-clock time across
//! daylight-saving changes; croner decides what happens to a wall-clock time
//! that does not exist (spring forward: runs at the first instant after the
//! gap) or happens twice (fall back: runs once).
//!
//! A pattern may not fire more often than every [`MIN_INTERVAL_SECS`].

use std::str::FromStr;

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use croner::Cron;
use og_core::api::automations::MIN_SCHEDULE_INTERVAL_SECS;

pub const MIN_INTERVAL_SECS: i64 = MIN_SCHEDULE_INTERVAL_SECS;

/// How many consecutive occurrences are examined when checking the interval.
const INTERVAL_SAMPLE: usize = 4000;
/// ... and how far ahead (days) at most.
const INTERVAL_HORIZON_DAYS: i64 = 800;

pub fn parse_cron(expr: &str) -> Result<Cron, String> {
    let expr = expr.trim();
    if expr.is_empty() {
        return Err("the cron expression is empty".into());
    }
    if expr.len() > 200 {
        return Err("the cron expression is too long".into());
    }
    Cron::from_str(expr).map_err(|e| format!("invalid cron expression \"{expr}\": {e}"))
}

pub fn parse_timezone(name: &str) -> Result<Tz, String> {
    name.trim().parse::<Tz>().map_err(|_| {
        format!("unknown time zone \"{name}\"; use an IANA name such as Europe/Berlin")
    })
}

/// First occurrence strictly after `after_ms` (unix ms), as unix ms. `None`
/// when the pattern never fires again.
pub fn next_after(cron: &Cron, tz: Tz, after_ms: i64) -> Option<i64> {
    let after: DateTime<Utc> = Utc.timestamp_millis_opt(after_ms).single()?;
    let local = after.with_timezone(&tz);
    let next = cron.find_next_occurrence(&local, false).ok()?;
    Some(next.timestamp_millis())
}

/// Validate a schedule trigger: pattern, zone and minimum interval.
pub fn validate(cron_expr: &str, timezone: &str) -> Result<(), String> {
    let cron = parse_cron(cron_expr)?;
    let tz = parse_timezone(timezone)?;
    check_interval(&cron, tz)
}

/// Reject patterns that can fire twice within [`MIN_INTERVAL_SECS`]. Looks at
/// consecutive occurrences starting now (and from a fixed leap-year start, so
/// patterns that only come close together on rare dates are seen too).
pub fn check_interval(cron: &Cron, tz: Tz) -> Result<(), String> {
    let starts = [
        Utc::now(),
        Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0)
            .single()
            .unwrap_or_else(Utc::now),
    ];
    for start in starts {
        let horizon = start + chrono::Duration::days(INTERVAL_HORIZON_DAYS);
        let mut prev: Option<DateTime<Tz>> = None;
        let mut cursor = start.with_timezone(&tz);
        for _ in 0..INTERVAL_SAMPLE {
            let Ok(next) = cron.find_next_occurrence(&cursor, false) else {
                break;
            };
            if let Some(p) = prev {
                let gap = next.timestamp() - p.timestamp();
                if gap < MIN_INTERVAL_SECS {
                    return Err(format!(
                        "this schedule can fire every {gap} seconds; the minimum interval is {} minutes",
                        MIN_INTERVAL_SECS / 60
                    ));
                }
            }
            if next.with_timezone(&Utc) > horizon {
                break;
            }
            prev = Some(next);
            cursor = next;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0)
            .unwrap()
            .timestamp_millis()
    }

    fn next(expr: &str, tz: &str, after: i64) -> i64 {
        next_after(
            &parse_cron(expr).unwrap(),
            parse_timezone(tz).unwrap(),
            after,
        )
        .unwrap()
    }

    #[test]
    fn next_occurrence_in_utc() {
        assert_eq!(
            next("0 9 * * *", "UTC", utc(2026, 5, 1, 8, 0)),
            utc(2026, 5, 1, 9, 0)
        );
        // Strictly after: at exactly 09:00 the next one is tomorrow.
        assert_eq!(
            next("0 9 * * *", "UTC", utc(2026, 5, 1, 9, 0)),
            utc(2026, 5, 2, 9, 0)
        );
        assert_eq!(
            next("*/15 * * * *", "UTC", utc(2026, 5, 1, 9, 1)),
            utc(2026, 5, 1, 9, 15)
        );
        assert_eq!(
            next("@daily", "UTC", utc(2026, 5, 1, 9, 1)),
            utc(2026, 5, 2, 0, 0)
        );
    }

    #[test]
    fn time_zone_shifts_the_utc_instant() {
        // 09:00 in Berlin (CEST, UTC+2) is 07:00 UTC; in winter (CET, UTC+1) 08:00 UTC.
        assert_eq!(
            next("0 9 * * *", "Europe/Berlin", utc(2026, 7, 1, 0, 0)),
            utc(2026, 7, 1, 7, 0)
        );
        assert_eq!(
            next("0 9 * * *", "Europe/Berlin", utc(2026, 1, 15, 0, 0)),
            utc(2026, 1, 15, 8, 0)
        );
        // Half-hour offset zone.
        assert_eq!(
            next("0 9 * * *", "Asia/Kolkata", utc(2026, 7, 1, 0, 0)),
            utc(2026, 7, 1, 3, 30)
        );
    }

    #[test]
    fn wall_clock_time_is_kept_across_spring_forward() {
        // US DST started 2026-03-08 at 02:00 local (EST -> EDT).
        // 09:00 New York: 14:00 UTC before the change, 13:00 UTC after.
        let before = next("0 9 * * *", "America/New_York", utc(2026, 3, 7, 15, 0));
        assert_eq!(before, utc(2026, 3, 8, 13, 0), "09:00 EDT on the 8th");
        let sat = next("0 9 * * *", "America/New_York", utc(2026, 3, 6, 15, 0));
        assert_eq!(sat, utc(2026, 3, 7, 14, 0), "09:00 EST on the 7th");
        // Europe: DST started 2026-03-29 at 01:00 UTC.
        assert_eq!(
            next("30 8 * * *", "Europe/London", utc(2026, 3, 28, 12, 0)),
            utc(2026, 3, 29, 7, 30),
            "08:30 BST"
        );
        assert_eq!(
            next("30 8 * * *", "Europe/London", utc(2026, 3, 27, 12, 0)),
            utc(2026, 3, 28, 8, 30),
            "08:30 GMT"
        );
    }

    #[test]
    fn nonexistent_wall_time_runs_once_after_the_gap() {
        // 02:30 does not exist in New York on 2026-03-08 (clocks jump 02:00 -> 03:00).
        let n = next("30 2 * * *", "America/New_York", utc(2026, 3, 8, 0, 0));
        // It runs once, at the first instant after the gap (03:00 EDT = 07:00 UTC)
        // or at the latest 03:30 EDT; never skipped, never twice.
        assert!(
            (utc(2026, 3, 8, 7, 0)..=utc(2026, 3, 8, 7, 30)).contains(&n),
            "got {}",
            DateTime::<Utc>::from_timestamp_millis(n).unwrap()
        );
        let after = next("30 2 * * *", "America/New_York", n);
        assert_eq!(after, utc(2026, 3, 9, 6, 30), "back to 02:30 EDT next day");
    }

    #[test]
    fn repeated_wall_time_runs_once_on_fall_back() {
        // US DST ended 2026-11-01 at 02:00 EDT -> 01:00 EST: 01:30 happens twice.
        let mut t = utc(2026, 11, 1, 0, 0);
        let mut hits = Vec::new();
        let cron = parse_cron("30 1 * * *").unwrap();
        let tz = parse_timezone("America/New_York").unwrap();
        for _ in 0..3 {
            t = next_after(&cron, tz, t).unwrap();
            hits.push(t);
        }
        // Three consecutive runs are on three different days (never twice on Nov 1).
        let days: Vec<_> = hits
            .iter()
            .map(|ms| {
                DateTime::<Utc>::from_timestamp_millis(*ms)
                    .unwrap()
                    .with_timezone(&tz)
                    .date_naive()
            })
            .collect();
        assert_eq!(days[0].to_string(), "2026-11-01");
        assert_eq!(days[1].to_string(), "2026-11-02");
        assert_eq!(days[2].to_string(), "2026-11-03");
    }

    #[test]
    fn day_of_week_and_month_patterns() {
        // Mondays 08:00; 2026-05-01 is a Friday.
        assert_eq!(
            next("0 8 * * MON", "UTC", utc(2026, 5, 1, 0, 0)),
            utc(2026, 5, 4, 8, 0)
        );
        // First of the month.
        assert_eq!(
            next("0 0 1 * *", "UTC", utc(2026, 5, 1, 0, 0)),
            utc(2026, 6, 1, 0, 0)
        );
        // Feb 29 only exists in leap years.
        assert_eq!(
            next("0 12 29 2 *", "UTC", utc(2026, 1, 1, 0, 0)),
            utc(2028, 2, 29, 12, 0)
        );
    }

    #[test]
    fn rejects_bad_patterns_and_zones() {
        for bad in [
            "",
            "   ",
            "not a cron",
            "61 * * * *",
            "* * * *",
            "* * * * * * * *",
        ] {
            assert!(parse_cron(bad).is_err(), "{bad:?}");
        }
        assert!(parse_cron(&"*".repeat(500)).is_err());
        assert!(parse_timezone("Mars/Olympus").is_err());
        assert!(parse_timezone("").is_err());
        assert!(parse_timezone("Europe/Berlin").is_ok());
        assert!(parse_timezone("UTC").is_ok());
    }

    #[test]
    fn minimum_interval_is_enforced() {
        for ok in [
            "*/5 * * * *",
            "0,30 * * * *",
            "0 * * * *",
            "0 9 * * MON-FRI",
            "@hourly",
            "@daily",
            "0 0 1 1 *",
            "*/10 * * * *",
            "0 0 29 2 *",
            "0 */6 * * *",
            "59 23,0 * * *", // 23:59 and 00:59: an hour apart
        ] {
            assert!(validate(ok, "UTC").is_ok(), "{ok} should be accepted");
        }
        for bad in [
            "* * * * *",
            "*/4 * * * *",
            "*/1 * * * *",
            "0,2 * * * *",
            "0,3 * * * *",
            "*/10 * * * * *",
            "* * * * * *",
        ] {
            let e = validate(bad, "UTC").expect_err(bad);
            assert!(e.contains("minimum interval"), "{bad}: {e}");
        }
    }

    #[test]
    fn rare_close_pairs_are_caught() {
        // 23:59 and 00:00 on consecutive days, but only on the 1st and 2nd of
        // January: the pair is 1 minute apart.
        let e = validate("59,0 23,0 1,2 1 *", "UTC");
        assert!(e.is_err(), "{e:?}");
    }

    #[test]
    fn validate_reports_zone_errors() {
        assert!(
            validate("0 9 * * *", "Nowhere/Land")
                .unwrap_err()
                .contains("time zone")
        );
    }
}
