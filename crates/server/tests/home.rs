//! A workspace's Home (`GET /api/workspaces/{id}/home`, BE-3): what is due soon, what changed
//! lately and the caller's inbox drafts. Access follows the projects the caller can open; dates
//! are compared in the caller's time zone.

mod common;
mod records_support;
mod schema_support;

use chrono::{DateTime, Days, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use common::{Client, Response};
use openbase::perm::Role;
use openbase::store::home::{self, Budget};
use records_support::*;
use serde_json::{Value, json};

/// Table 1 of the fixture with a Due date and a Done checkbox, set as its Home date and Done.
struct Home {
    f: Fixture,
    due: String,
    done: String,
}

impl Home {
    async fn new() -> Home {
        let f = Fixture::new().await;
        let (due, done) = dated_table(&f, &f.table_id, false).await;
        Home { f, due, done }
    }

    async fn get(&self, c: &Client) -> Response {
        get_home(&self.f, c, &self.f.ws).await
    }

    /// Home as the owner, with a 200 asserted.
    async fn owner(&self) -> Value {
        let r = self.get(&self.f.owner).await;
        r.assert_status(200);
        r.body.clone()
    }

    async fn record(&self, name: &str, due: Option<&str>) -> String {
        let mut values = json!({ &self.f.primary_id: name });
        if let Some(d) = due {
            values[&self.due] = json!(d);
        }
        sid(&self.f.create(&self.f.table_id, values).await["id"]).to_string()
    }

    async fn set_timezone(&self, c: &Client, tz: &str) {
        self.f
            .app
            .patch(c, "/api/auth/me", json!({ "timezone": tz }))
            .await
            .assert_status(200);
    }
}

async fn get_home(f: &Fixture, c: &Client, ws: &str) -> Response {
    f.app.get(c, &format!("/api/workspaces/{ws}/home")).await
}

/// A Due date (with a time of day when `with_time`) and a Done checkbox in `table`, set as the
/// collection's Home date and Done. Returns their ids.
async fn dated_table(f: &Fixture, table: &str, with_time: bool) -> (String, String) {
    let due = f
        .add_field(
            table,
            json!({ "name": "Due", "type": "date", "options": { "include_time": with_time } }),
        )
        .await;
    let done = f
        .add_field(
            table,
            json!({ "name": "Done", "type": "checkbox", "options": {} }),
        )
        .await;
    let (due, done) = (sid(&due["id"]).to_string(), sid(&done["id"]).to_string());
    f.app
        .patch(
            &f.owner,
            &format!("/api/tables/{table}"),
            json!({ "home_date_field_id": due, "done_field_id": done }),
        )
        .await
        .assert_status(200);
    (due, done)
}

fn titles(items: &Value) -> Vec<String> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|i| sid(&i["title"]).to_string())
        .collect()
}

fn today_of(body: &Value) -> NaiveDate {
    NaiveDate::parse_from_str(sid(&body["today"]), "%Y-%m-%d").unwrap()
}

fn plus(d: NaiveDate, days: i64) -> NaiveDate {
    if days >= 0 {
        d.checked_add_days(Days::new(days as u64)).unwrap()
    } else {
        d.checked_sub_days(Days::new(days.unsigned_abs())).unwrap()
    }
}

// ------------------------------------------------------------------------------ due soon

#[tokio::test]
async fn due_lists_the_window_oldest_first_and_says_what_each_row_needs() {
    let h = Home::new().await;
    let today = today_of(&h.owner().await);
    for (name, offset) in [
        ("tomorrow", 1),
        ("a month ago", -31),
        ("edge back", -30),
        ("today", 0),
        ("edge ahead", 7),
        ("too far", 8),
        ("yesterday", -1),
    ] {
        h.record(name, Some(&plus(today, offset).to_string())).await;
    }
    h.record("no date", None).await;

    let body = h.owner().await;
    assert_eq!(
        titles(&body["due"]),
        ["edge back", "yesterday", "today", "tomorrow", "edge ahead"]
    );
    assert_eq!(body["truncated"], false);
    assert_eq!(body["timezone"], "UTC");

    let due = body["due"].as_array().unwrap();
    let first = &due[0];
    assert_eq!(first["date"], plus(today, -30).to_string());
    assert_eq!(first["overdue"], true);
    assert_eq!(first["has_time"], false);
    assert!(first["time"].is_null());
    assert_eq!(first["table_id"], h.f.table_id.as_str());
    assert_eq!(first["base_id"], h.f.base_id.as_str());
    assert_eq!(first["base_name"], "CRM");
    assert_eq!(first["table_name"], "Table 1");
    assert!(first["table_color"].is_string());
    assert_eq!(first["has_done"], true);
    assert_eq!(first["done_field_id"], h.done.as_str());
    assert_eq!(first["can_edit"], true);
    assert!(first["record_id"].as_str().unwrap().starts_with("rec"));
    let overdue: Vec<_> = due
        .iter()
        .map(|i| i["overdue"].as_bool().unwrap())
        .collect();
    assert_eq!(
        overdue,
        [true, true, false, false, false],
        "today is not overdue"
    );
}

#[tokio::test]
async fn done_records_leave_and_a_collection_without_done_still_lists() {
    let h = Home::new().await;
    let today = today_of(&h.owner().await).to_string();
    let finished = h.record("finished", Some(&today)).await;
    h.record("open", Some(&today)).await;
    let unticked = h.record("unticked", Some(&today)).await;
    h.f.set(&h.f.table_id, &finished, json!({ &h.done: true }))
        .await;
    h.f.set(&h.f.table_id, &unticked, json!({ &h.done: true }))
        .await;
    h.f.set(&h.f.table_id, &unticked, json!({ &h.done: false }))
        .await;
    assert_eq!(titles(&h.owner().await["due"]), ["open", "unticked"]);

    // Taking the Done setting away puts the finished record back, without a Done checkbox.
    h.f.app
        .patch(
            &h.f.owner,
            &format!("/api/tables/{}", h.f.table_id),
            json!({ "done_field_id": null }),
        )
        .await
        .assert_status(200);
    let body = h.owner().await;
    assert_eq!(titles(&body["due"]), ["finished", "open", "unticked"]);
    assert!(
        body["due"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["has_done"] == false && i["done_field_id"].is_null())
    );
}

#[tokio::test]
async fn collections_without_a_home_date_and_trashed_records_are_not_read() {
    let h = Home::new().await;
    let today = today_of(&h.owner().await).to_string();
    let plain = h.f.add_table("Notes").await;
    let plain_date =
        h.f.add_field(
            sid(&plain["id"]),
            json!({ "name": "Due", "type": "date", "options": {} }),
        )
        .await;
    h.f.create(
        sid(&plain["id"]),
        json!({ sid(&plain["primary_field_id"]): "dated but off Home", sid(&plain_date["id"]): today }),
    )
    .await;
    let gone = h.record("trashed", Some(&today)).await;
    h.record("kept", Some(&today)).await;
    h.f.delete_records(&h.f.table_id, &[&gone])
        .await
        .assert_status(204);
    assert_eq!(titles(&h.owner().await["due"]), ["kept"]);

    // A Home date that stopped being a date property (the setting clears with it) lists nothing.
    h.f.app
        .patch(
            &h.f.owner,
            &format!("/api/fields/{}", h.due),
            json!({ "type": "text", "options": {} }),
        )
        .await
        .assert_status(200);
    assert_eq!(h.owner().await["due"], json!([]));
}

#[tokio::test]
async fn due_is_capped_at_fifty_oldest_first() {
    let h = Home::new().await;
    let today = today_of(&h.owner().await);
    for i in 0..55 {
        // 55 records over the window's 38 days.
        let day = plus(today, -30 + (i % 38));
        h.f.insert_record(
            &h.f.table_id,
            json!({ &h.f.primary_id: format!("r{i:02}"), &h.due: day.to_string() }),
        );
    }
    let body = h.owner().await;
    let due = body["due"].as_array().unwrap();
    assert_eq!(due.len(), 50);
    assert_eq!(body["truncated"], false, "the cap is not the budget");
    let dates: Vec<&str> = due.iter().map(|i| sid(&i["date"])).collect();
    let mut sorted = dates.clone();
    sorted.sort();
    assert_eq!(dates, sorted);
}

// -------------------------------------------------------------------------- time zones

/// The instant `day` at `hh:mm` on a wall clock in `zone`.
fn local(zone: Tz, day: NaiveDate, hh: u32, mm: u32) -> DateTime<Utc> {
    zone.from_local_datetime(&day.and_hms_opt(hh, mm, 0).unwrap())
        .unwrap()
        .with_timezone(&Utc)
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[tokio::test]
async fn days_and_the_window_follow_the_callers_time_zone() {
    // The two ends of the clock: UTC+14 is a day ahead of UTC+0 for ten hours a day, and UTC-12
    // a day behind it for twelve.
    for zone in [
        "Pacific/Kiritimati",
        "Etc/GMT+12",
        "Asia/Kolkata",
        "America/St_Johns",
    ] {
        let f = Fixture::new().await;
        let (due, _) = dated_table(&f, &f.table_id, true).await;
        let h = Home {
            f,
            due,
            done: String::new(),
        };
        h.set_timezone(&h.f.owner, zone).await;
        let tz: Tz = zone.parse().unwrap();
        let body = h.owner().await;
        let today = today_of(&body);
        assert_eq!(body["timezone"], zone);
        assert_eq!(today, Utc::now().with_timezone(&tz).date_naive(), "{zone}");

        // Seconds into a local day, on the wall clock: the very start and end of the days at the
        // window's edges and around today.
        let cases = [
            ("start of today", plus(today, 0), (0, 5), true, false),
            ("end of yesterday", plus(today, -1), (23, 55), true, true),
            (
                "start of the oldest day",
                plus(today, -30),
                (0, 5),
                true,
                true,
            ),
            (
                "end of the day before it",
                plus(today, -31),
                (23, 55),
                false,
                true,
            ),
            ("end of the last day", plus(today, 7), (23, 55), true, false),
            (
                "start of the day after it",
                plus(today, 8),
                (0, 5),
                false,
                false,
            ),
        ];
        for (name, day, (hh, mm), _, _) in &cases {
            let at = iso(local(tz, *day, *hh, *mm));
            h.record(name, Some(&at)).await;
        }
        let body = h.owner().await;
        let found: Vec<&str> = body["due"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| sid(&i["title"]))
            .collect();
        for (name, day, (hh, mm), inside, overdue) in &cases {
            let item = body["due"]
                .as_array()
                .unwrap()
                .iter()
                .find(|i| i["title"] == *name);
            assert_eq!(item.is_some(), *inside, "{zone}: {name} in {found:?}");
            if let Some(item) = item {
                assert_eq!(item["date"], day.to_string(), "{zone}: {name}");
                assert_eq!(item["has_time"], true);
                assert_eq!(item["time"], format!("{hh:02}:{mm:02}"), "{zone}: {name}");
                assert_eq!(item["overdue"], *overdue, "{zone}: {name}");
            }
        }
    }
}

#[tokio::test]
async fn a_date_without_a_time_stays_on_its_day_in_every_zone() {
    for zone in ["Pacific/Kiritimati", "Etc/GMT+12", "UTC"] {
        let h = Home::new().await;
        h.set_timezone(&h.f.owner, zone).await;
        let today = today_of(&h.owner().await);
        h.record("all day", Some(&today.to_string())).await;
        let body = h.owner().await;
        assert_eq!(body["due"][0]["date"], today.to_string(), "{zone}");
        assert_eq!(body["due"][0]["overdue"], false, "{zone}");
        assert_eq!(body["due"][0]["has_time"], false);
    }
}

#[tokio::test]
async fn two_people_see_the_same_instant_on_their_own_days() {
    let f = Fixture::new().await;
    let (due, _) = dated_table(&f, &f.table_id, true).await;
    let h = Home {
        f,
        due,
        done: String::new(),
    };
    let tokyo = h.f.member("tokyo@example.com", Role::Viewer);
    let la = h.f.member("la@example.com", Role::Viewer);
    h.set_timezone(&tokyo, "Asia/Tokyo").await;
    h.set_timezone(&la, "America/Los_Angeles").await;
    // 12:00 in Tokyo on Tokyo's today is still the evening before in Los Angeles.
    let tokyo_today = today_of(&get_home(&h.f, &tokyo, &h.f.ws).await.body);
    let at = local("Asia/Tokyo".parse().unwrap(), tokyo_today, 8, 30);
    h.record("standup", Some(&iso(at))).await;
    let t = get_home(&h.f, &tokyo, &h.f.ws).await;
    let l = get_home(&h.f, &la, &h.f.ws).await;
    assert_eq!(t.body["due"][0]["date"], tokyo_today.to_string());
    assert_eq!(t.body["due"][0]["time"], "08:30");
    let la_tz: Tz = "America/Los_Angeles".parse().unwrap();
    let expected = at.with_timezone(&la_tz);
    assert_eq!(l.body["due"][0]["date"], expected.date_naive().to_string());
    assert_eq!(
        l.body["due"][0]["time"],
        expected.format("%H:%M").to_string()
    );
}

// ----------------------------------------------------------------------- computed dates

#[tokio::test]
async fn a_computed_date_is_a_home_date() {
    let f = Fixture::new().await;
    let start = f
        .add_field(
            &f.table_id,
            json!({ "name": "Start", "type": "date", "options": {} }),
        )
        .await;
    let formula = f
        .add_field(
            &f.table_id,
            json!({ "name": "Review", "type": "formula",
                    "options": { "expression": "DATEADD({Start}, 3, 'days')" } }),
        )
        .await;
    assert_eq!(formula["options"]["result_type"], "date", "{formula}");
    f.app
        .patch(
            &f.owner,
            &format!("/api/tables/{}", f.table_id),
            json!({ "home_date_field_id": formula["id"] }),
        )
        .await
        .assert_status(200);
    let body = get_home(&f, &f.owner, &f.ws).await.body.clone();
    let today = today_of(&body);
    f.create(
        &f.table_id,
        json!({ &f.primary_id: "starts earlier", sid(&start["id"]): plus(today, -5).to_string() }),
    )
    .await;
    f.create(
        &f.table_id,
        json!({ &f.primary_id: "starts later", sid(&start["id"]): plus(today, 10).to_string() }),
    )
    .await;
    f.create(&f.table_id, json!({ &f.primary_id: "never starts" }))
        .await;
    let body = get_home(&f, &f.owner, &f.ws).await.body.clone();
    // The first review is 2 days ago; the second is 13 days ahead, outside the window.
    assert_eq!(titles(&body["due"]), ["starts earlier"]);
    assert_eq!(body["due"][0]["date"], plus(today, -2).to_string());
    assert_eq!(body["due"][0]["overdue"], true);
}

#[tokio::test]
async fn creation_and_edit_times_work_as_home_dates() {
    let f = Fixture::new().await;
    let created = f
        .add_field(
            &f.table_id,
            json!({ "name": "Added", "type": "created_time", "options": {} }),
        )
        .await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/tables/{}", f.table_id),
            json!({ "home_date_field_id": created["id"] }),
        )
        .await
        .assert_status(200);
    f.create(&f.table_id, json!({ &f.primary_id: "new today" }))
        .await;
    let old = f.insert_record(&f.table_id, json!({ &f.primary_id: "ancient" }));
    assert!(!old.is_empty());
    let body = get_home(&f, &f.owner, &f.ws).await.body.clone();
    // The inserted row was created at the epoch.
    assert_eq!(titles(&body["due"]), ["new today"]);
    assert_eq!(body["due"][0]["has_time"], true);
    assert_eq!(body["due"][0]["date"], sid(&body["today"]));

    // Watching one property takes the long way, and gives the same answer.
    let watched = f
        .add_field(
            &f.table_id,
            json!({ "name": "Name changed", "type": "last_modified_time",
                    "options": { "fields": [&f.primary_id] } }),
        )
        .await;
    f.app
        .patch(
            &f.owner,
            &format!("/api/tables/{}", f.table_id),
            json!({ "home_date_field_id": watched["id"] }),
        )
        .await
        .assert_status(200);
    let body = get_home(&f, &f.owner, &f.ws).await.body.clone();
    assert_eq!(titles(&body["due"]), ["new today"]);
}

// ------------------------------------------------------------------------------ budget

#[tokio::test]
async fn a_collection_is_read_whole_or_not_at_all_and_the_response_says_when_one_was_not() {
    let h = Home::new().await;
    let today = today_of(&h.owner().await).to_string();
    let second = h.f.add_table("Second").await;
    let (due2, _) = dated_table(&h.f, sid(&second["id"]), false).await;
    let third = h.f.add_table("Third").await;
    let (due3, _) = dated_table(&h.f, sid(&third["id"]), false).await;
    for i in 0..3 {
        h.f.insert_record(
            &h.f.table_id,
            json!({ &h.f.primary_id: format!("a{i}"), &h.due: today }),
        );
        h.f.insert_record(
            sid(&second["id"]),
            json!({ sid(&second["primary_field_id"]): format!("b{i}"), &due2: today }),
        );
    }
    h.f.insert_record(
        sid(&third["id"]),
        json!({ sid(&third["primary_field_id"]): "c0", &due3: today }),
    );
    let owner = h.f.owner.user_id.clone().unwrap();
    let run = |records: usize, tables: usize| {
        let owner = owner.clone();
        let ws = h.f.ws.clone();
        h.f.app
            .state
            .db
            .write_sync(move |tx| {
                let owner = owner;
                let actor = openbase::auth::Actor {
                    user_id: owner,
                    name: "Owner".into(),
                    email: "owner@example.com".into(),
                    is_admin: false,
                    token_scope: None,
                    session_hash: None,
                    token_hash: None,
                    token_id: None,
                    oauth_grant_id: None,
                };
                home::home(tx, &actor, &ws, Utc::now(), Budget { records, tables })
            })
            .unwrap()
    };
    let all = run(100, 100);
    assert!(!all.truncated);
    assert_eq!(all.due.len(), 7);

    // 6 records fit the first two collections; the third is left out and the answer says so.
    let some = run(6, 100);
    assert!(some.truncated);
    assert_eq!(
        some.due
            .iter()
            .map(|d| d.title.as_str())
            .collect::<Vec<_>>(),
        ["a0", "a1", "a2", "b0", "b1", "b2"]
    );
    // 5 records: the second does not fit whole, but the smaller third still does.
    let skipped = run(5, 100);
    assert!(skipped.truncated);
    assert_eq!(
        skipped
            .due
            .iter()
            .map(|d| d.title.as_str())
            .collect::<Vec<_>>(),
        ["a0", "a1", "a2", "c0"]
    );
    assert!(run(7, 100).due.len() == 7 && !run(7, 100).truncated);
    // The number of collections is capped too.
    let two = run(100, 2);
    assert!(two.truncated);
    assert_eq!(two.due.len(), 6);
    assert!(run(0, 100).truncated);
}

// ------------------------------------------------------------------------------ recent

#[tokio::test]
async fn recent_is_the_ten_latest_records_once_each_with_who_and_when() {
    let h = Home::new().await;
    let editor = h.f.member("editor@example.com", Role::Editor);
    let mut ids = Vec::new();
    for i in 0..12 {
        ids.push(h.record(&format!("rec {i:02}"), None).await);
    }
    // An edit by someone else moves a record to the front, once, whatever the number of edits.
    for n in 0..3 {
        h.f.patch_as(
            &editor,
            &h.f.table_id,
            &ids[3],
            json!({ &h.f.primary_id: format!("rec 03 v{n}") }),
        )
        .await
        .assert_status(200);
    }
    let gone = ids[11].clone();
    h.f.delete_records(&h.f.table_id, &[&gone])
        .await
        .assert_status(204);

    let body = h.owner().await;
    let recent = body["recent"].as_array().unwrap();
    assert_eq!(recent.len(), 10);
    assert_eq!(recent[0]["title"], "rec 03 v2");
    assert_eq!(recent[0]["record_id"], ids[3].as_str());
    assert_eq!(recent[0]["kind"], "update");
    assert_eq!(recent[0]["author"]["name"], "editor@example.com");
    assert_eq!(recent[0]["table_name"], "Table 1");
    assert_eq!(recent[0]["base_id"], h.f.base_id.as_str());
    assert_eq!(recent[1]["title"], "rec 10", "the trashed record is gone");
    assert_eq!(recent[1]["kind"], "create");
    assert_eq!(recent[1]["author"]["name"], "Owner");
    let ids: Vec<&str> = recent.iter().map(|r| sid(&r["record_id"])).collect();
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "each record once");
    let at: Vec<i64> = recent.iter().map(|r| r["at"].as_i64().unwrap()).collect();
    assert!(at.windows(2).all(|w| w[0] >= w[1]), "newest first: {at:?}");
    // Home dates are not needed to appear here.
    assert_eq!(body["due"], json!([]));
}

// ------------------------------------------------------------------------------ drafts

#[tokio::test]
async fn drafts_are_the_callers_own_in_every_workspace() {
    let h = Home::new().await;
    let other = workspace(&h.f.app, &h.f.owner, "Second").await;
    h.f.app
        .post(
            &h.f.owner,
            "/api/inbox",
            json!({ "title": "buy stamps", "body": "" }),
        )
        .await
        .assert_status(201);
    let guest = h.f.member("guest@example.com", Role::Viewer);
    h.f.app
        .post(
            &guest,
            "/api/inbox",
            json!({ "title": "private", "body": "" }),
        )
        .await
        .assert_status(201);

    let mine = h.owner().await;
    assert_eq!(titles(&mine["drafts"]), ["buy stamps"]);
    let elsewhere = get_home(&h.f, &h.f.owner, &other).await;
    elsewhere.assert_status(200);
    assert_eq!(titles(&elsewhere.body["drafts"]), ["buy stamps"]);
    let theirs = get_home(&h.f, &guest, &h.f.ws).await;
    assert_eq!(titles(&theirs.body["drafts"]), ["private"]);
}

// ----------------------------------------------------------------------------- access

/// A second project with its own dated collection and a record on today.
async fn side_project(h: &Home) -> (String, String) {
    let side = schema_support::base(&h.f.app, &h.f.owner, &h.f.ws, "Side").await;
    let base = sid(&side["id"]).to_string();
    let table =
        h.f.app
            .post(
                &h.f.owner,
                &format!("/api/bases/{base}/tables"),
                json!({ "name": "Chores" }),
            )
            .await;
    table.assert_status(201);
    let table = table.body.clone();
    let (due, _) = dated_table(&h.f, sid(&table["id"]), false).await;
    let today = today_of(&h.owner().await).to_string();
    h.f.create(
        sid(&table["id"]),
        json!({ sid(&table["primary_field_id"]): "side chore", &due: today }),
    )
    .await;
    (base, sid(&table["id"]).to_string())
}

#[tokio::test]
async fn members_see_the_projects_they_can_open_and_roles_decide_the_done_box() {
    let h = Home::new().await;
    let today = today_of(&h.owner().await).to_string();
    h.record("main task", Some(&today)).await;
    let (side, _) = side_project(&h).await;

    // Everyone with the whole workspace sees both, in the order of the projects.
    let both = h.owner().await;
    assert_eq!(titles(&both["due"]), ["main task", "side chore"]);
    assert_eq!(both["due"][1]["base_name"], "Side");

    let viewer = h.f.member("viewer@example.com", Role::Viewer);
    let seen = get_home(&h.f, &viewer, &h.f.ws).await;
    seen.assert_status(200);
    assert_eq!(titles(&seen.body["due"]), ["main task", "side chore"]);
    assert!(
        seen.body["due"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["can_edit"] == false)
    );
    let editor = h.f.member("editor@example.com", Role::Editor);
    let seen = get_home(&h.f, &editor, &h.f.ws).await;
    assert!(
        seen.body["due"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["can_edit"] == true)
    );

    // A member limited to the side project sees only it: not the other project's due records,
    // recent changes or names.
    let limited = h.f.app.user("limited@example.com", "Limited");
    schema_support::add_base_member(&h.f.app, &side, &limited, Role::Editor);
    let seen = get_home(&h.f, &limited, &h.f.ws).await;
    seen.assert_status(200);
    assert_eq!(titles(&seen.body["due"]), ["side chore"]);
    let recent: Vec<&str> = titles_of(&seen.body["recent"]);
    assert_eq!(recent, ["side chore"], "{}", seen.body);
    assert!(!seen.body.to_string().contains("main task"));
    assert!(!seen.body.to_string().contains("CRM"));
    // And one limited to the main project, read-only by its role, cannot tick anything.
    let limited_viewer = h.f.base_guest("lv@example.com", Role::Viewer);
    let seen = get_home(&h.f, &limited_viewer, &h.f.ws).await;
    assert_eq!(titles(&seen.body["due"]), ["main task"]);
    assert_eq!(seen.body["due"][0]["can_edit"], false);
}

fn titles_of(v: &Value) -> Vec<&str> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|i| sid(&i["title"]))
        .collect()
}

#[tokio::test]
async fn outsiders_and_missing_workspaces_get_404_and_anonymous_gets_401() {
    let h = Home::new().await;
    let outsider = h.f.app.user("outsider@example.com", "Outsider");
    for (c, ws) in [
        (&outsider, h.f.ws.as_str()),
        (&h.f.owner, "wspDoesNotExist"),
    ] {
        let r = get_home(&h.f, c, ws).await;
        r.assert_status(404);
        assert_eq!(r.body["error"]["code"], "not_found");
    }
    get_home(&h.f, &h.f.app.anon(), &h.f.ws)
        .await
        .assert_status(401);
    // A workspace in the trash is gone for its members too.
    h.f.app
        .delete(&h.f.owner, &format!("/api/workspaces/{}", h.f.ws))
        .await
        .assert_status(200);
    get_home(&h.f, &h.f.owner, &h.f.ws).await.assert_status(404);
}

#[tokio::test]
async fn tokens_see_what_they_reach_and_never_the_inbox_of_a_limited_one() {
    let h = Home::new().await;
    let today = today_of(&h.owner().await).to_string();
    h.record("main task", Some(&today)).await;
    let (side, _) = side_project(&h).await;
    h.f.app
        .post(
            &h.f.owner,
            "/api/inbox",
            json!({ "title": "draft", "body": "" }),
        )
        .await
        .assert_status(201);

    // A read-only token sees everything its user does, and cannot edit.
    let read = schema_support::token_client(&h.f.app, &h.f.owner, false);
    let seen = get_home(&h.f, &read, &h.f.ws).await;
    seen.assert_status(200);
    assert_eq!(titles(&seen.body["due"]), ["main task", "side chore"]);
    assert!(
        seen.body["due"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["can_edit"] == false)
    );
    assert_eq!(titles(&seen.body["drafts"]), ["draft"]);

    // A token limited to the side project reaches only it, has no inbox, and for a workspace
    // that holds none of its projects the workspace does not exist.
    let limited =
        h.f.app
            .api_token(
                &h.f.owner,
                json!({ "name": "side only", "write": true, "base_ids": [side] }),
            )
            .await;
    let seen = get_home(&h.f, &limited, &h.f.ws).await;
    seen.assert_status(200);
    assert_eq!(titles(&seen.body["due"]), ["side chore"]);
    assert_eq!(seen.body["drafts"], json!([]));
    let elsewhere = workspace(&h.f.app, &h.f.owner, "Unreached").await;
    get_home(&h.f, &limited, &elsewhere)
        .await
        .assert_status(404);
}
