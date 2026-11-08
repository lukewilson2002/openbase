//! The calendar-week and calendar-month operands of `is_within` through the real router: the
//! week starts on the request's `week_start`, else the caller's profile, else Sunday, and the
//! answers are cached per week start.

mod common;
mod query_support;
mod records_support;
mod schema_support;

use chrono::{Datelike, Days, Months, NaiveDate, Weekday};
use query_support::*;
use serde_json::{Value, json};

fn today_utc() -> NaiveDate {
    chrono::Utc::now().date_naive()
}

fn sunday_on_or_before(d: NaiveDate) -> NaiveDate {
    d.checked_sub_days(Days::new(u64::from(d.weekday().num_days_from_sunday())))
        .unwrap()
}

fn plus(d: NaiveDate, days: i64) -> NaiveDate {
    if days >= 0 {
        d.checked_add_days(Days::new(days as u64)).unwrap()
    } else {
        d.checked_sub_days(Days::new(days.unsigned_abs())).unwrap()
    }
}

/// The five people dated around the Sunday-start week that holds today (`S`): the Saturday
/// before it, its Sunday and Monday, its Saturday, and the Sunday after. Whatever today is,
/// Sunday and Monday weeks hold different people (Alice, bob, Carol, dave, Eve in that order).
async fn dated_around_this_week() -> (People, NaiveDate) {
    let p = people().await;
    let s = sunday_on_or_before(today_utc());
    for (id, offset) in p.ids.iter().zip([-1, 0, 1, 6, 7]) {
        p.f.set(
            &p.f.table_id,
            id,
            json!({ &p.due: plus(s, offset).to_string() }),
        )
        .await;
    }
    (p, s)
}

/// The names whose date falls in the seven days from the week start that holds today.
fn expected_this_week(s: NaiveDate, week_start: Weekday) -> Vec<String> {
    let today = today_utc();
    let back = (today.weekday().num_days_from_sunday() + 7 - week_start.num_days_from_sunday()) % 7;
    let first = plus(today, -i64::from(back));
    let last = plus(first, 6);
    let all = ["Alice", "bob", "Carol", "dave", "Eve"];
    [-1, 0, 1, 6, 7]
        .iter()
        .zip(all)
        .filter(|(offset, _)| {
            let d = plus(s, **offset);
            first <= d && d <= last
        })
        .map(|(_, n)| n.to_string())
        .collect()
}

async fn set_profile_week_start(p: &People, week_start: i32) {
    p.f.app
        .patch(
            &p.f.owner,
            "/api/auth/me",
            json!({ "week_start": week_start }),
        )
        .await
        .assert_status(200);
}

fn this_week_filter(p: &People) -> Value {
    json!({ "filter": and(vec![cond(&p.due, "is_within", json!({ "mode": "this_calendar_week" }))]) })
}

#[tokio::test]
async fn a_week_starts_on_sunday_unless_the_request_or_the_profile_says_otherwise() {
    let (p, s) = dated_around_this_week().await;
    p.f.configure(this_week_filter(&p)).await;
    let q = |body: Value| {
        let p = &p;
        async move { names(p, &p.f.query(body).await) }
    };
    let sunday = expected_this_week(s, Weekday::Sun);
    let monday = expected_this_week(s, Weekday::Mon);
    assert_ne!(sunday, monday, "the fixture tells the two apart on any day");

    // No profile value and no request value: Sunday.
    assert_eq!(q(json!({ "timezone": "UTC" })).await, sunday);
    // The request names one.
    assert_eq!(
        q(json!({ "timezone": "UTC", "week_start": 1 })).await,
        monday
    );
    assert_eq!(
        q(json!({ "timezone": "UTC", "week_start": 0 })).await,
        sunday
    );

    // The profile's week start applies when the request names none ...
    set_profile_week_start(&p, 1).await;
    assert_eq!(q(json!({ "timezone": "UTC" })).await, monday);
    // ... and the request wins over the profile.
    assert_eq!(
        q(json!({ "timezone": "UTC", "week_start": 0 })).await,
        sunday
    );
    set_profile_week_start(&p, 0).await;
    assert_eq!(q(json!({ "timezone": "UTC" })).await, sunday);
}

#[tokio::test]
async fn a_request_week_start_other_than_zero_or_one_is_refused() {
    let (p, _) = dated_around_this_week().await;
    p.f.configure(this_week_filter(&p)).await;
    for bad in [2, 7, -1] {
        p.f.query_as(&p.f.owner, p.view(), json!({ "week_start": bad }))
            .await
            .assert_status(400);
    }
}

#[tokio::test]
async fn results_with_a_calendar_week_are_cached_per_week_start() {
    let (p, _) = dated_around_this_week().await;
    p.f.configure(this_week_filter(&p)).await;
    let cache = &p.f.app.state.query_cache;
    let sunday =
        p.f.query(json!({ "timezone": "UTC", "week_start": 0 }))
            .await;
    let monday =
        p.f.query(json!({ "timezone": "UTC", "week_start": 1 }))
            .await;
    assert_eq!(cache.scans(), 2, "week starts must not share a cache entry");
    assert_ne!(names(&p, &sunday), names(&p, &monday));
    p.f.query(json!({ "timezone": "UTC", "week_start": 1 }))
        .await;
    assert_eq!(cache.scans(), 2);

    // A filter that does not use a week shares one entry whatever the week start.
    p.f.configure(json!({ "filter": and(vec![cond(
        &p.due,
        "is_within",
        json!({ "mode": "this_calendar_month" }),
    )]) }))
    .await;
    let before = cache.scans();
    p.f.query(json!({ "timezone": "UTC", "week_start": 0 }))
        .await;
    p.f.query(json!({ "timezone": "UTC", "week_start": 1 }))
        .await;
    assert_eq!(cache.scans(), before + 1);
}

#[tokio::test]
async fn neighbouring_weeks_and_months() {
    let p = people().await;
    let today = today_utc();
    let first_of_month = today.with_day(1).unwrap();
    let month = |n: i32| {
        if n >= 0 {
            first_of_month
                .checked_add_months(Months::new(n as u32))
                .unwrap()
        } else {
            first_of_month
                .checked_sub_months(Months::new(n.unsigned_abs()))
                .unwrap()
        }
    };
    // Last day of last month, first and last day of next month, first of the month after.
    let dates = [
        month(0).pred_opt().unwrap(),
        month(1),
        month(2).pred_opt().unwrap(),
        month(2),
        month(-1),
    ];
    for (id, d) in p.ids.iter().zip(&dates) {
        p.f.set(&p.f.table_id, id, json!({ &p.due: d.to_string() }))
            .await;
    }
    let run = |mode: &'static str| {
        let p = &p;
        async move {
            p.f.configure(json!({ "filter": and(vec![cond(
                &p.due,
                "is_within",
                json!({ "mode": mode }),
            )]) }))
            .await;
            names(p, &p.f.query(json!({ "timezone": "UTC" })).await)
        }
    };
    // Alice: last day of last month, bob: first of next, Carol: last of next,
    // dave: first of the month after, Eve: first of last month.
    assert_eq!(run("next_calendar_month").await, ["bob", "Carol"]);
    assert_eq!(run("last_calendar_month").await, ["Alice", "Eve"]);

    // Weeks: a record a week ahead and one a week back, by the Sunday week.
    let s = sunday_on_or_before(today);
    for (id, offset) in p.ids.iter().zip([-8, -7, -1, 7, 13]) {
        p.f.set(
            &p.f.table_id,
            id,
            json!({ &p.due: plus(s, offset).to_string() }),
        )
        .await;
    }
    assert_eq!(run("last_calendar_week").await, ["bob", "Carol"]);
    assert_eq!(run("next_calendar_week").await, ["dave", "Eve"]);
}

#[tokio::test]
async fn summaries_and_exports_follow_the_week_start_too() {
    let (p, s) = dated_around_this_week().await;
    let mut config = this_week_filter(&p);
    config["summaries"] = json!({ &p.name: "filled" });
    p.f.configure(config).await;
    for week_start in [0, 1] {
        let weekday = if week_start == 0 {
            Weekday::Sun
        } else {
            Weekday::Mon
        };
        let r =
            p.f.app
                .get(
                    &p.f.owner,
                    &format!(
                        "/api/views/{}/aggregations?timezone=UTC&week_start={week_start}",
                        p.view()
                    ),
                )
                .await;
        r.assert_status(200);
        assert_eq!(
            r.body["values"][&p.name],
            expected_this_week(s, weekday).len(),
            "week_start {week_start}"
        );
    }
    p.f.app
        .get(
            &p.f.owner,
            &format!("/api/views/{}/aggregations?week_start=2", p.view()),
        )
        .await
        .assert_status(400);

    for (week_start, weekday) in [(0, Weekday::Sun), (1, Weekday::Mon)] {
        let r =
            p.f.app
                .get(
                    &p.f.owner,
                    &format!(
                        "/api/views/{}/export.csv?timezone=UTC&week_start={week_start}",
                        p.view()
                    ),
                )
                .await;
        r.assert_status(200);
        let text = String::from_utf8_lossy(&r.bytes).into_owned();
        for name in expected_this_week(s, weekday) {
            assert!(
                text.contains(&name),
                "{name} is in the export for {week_start}"
            );
        }
        let rows = text.lines().count() - 1;
        assert_eq!(rows, expected_this_week(s, weekday).len(), "{week_start}");
    }
}
