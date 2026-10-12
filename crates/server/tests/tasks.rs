//! Background jobs, called directly as plain functions.

mod common;

use chrono::{Local, TimeZone};
use common::TestApp;
use opengrid::db::now_ms;
use opengrid::tasks;

const HOUR: i64 = 3600 * 1000;
const DAY: i64 = 24 * HOUR;

fn count(app: &TestApp, sql: &str) -> i64 {
    let sql = sql.to_string();
    app.state
        .db
        .write_sync(|tx| Ok(tx.query_row(&sql, [], |r| r.get(0))?))
        .unwrap()
}

fn exec(app: &TestApp, sql: &str, params: impl rusqlite::Params) {
    let sql = sql.to_string();
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(&sql, params)?;
            Ok(())
        })
        .unwrap();
}

#[test]
fn purge_sessions_removes_only_expired() {
    let app = TestApp::new();
    let live = app.user("a@example.com", "A");
    exec(
        &app,
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES ('expired', ?1, 0, 1, 0)",
        [live.user_id.clone().unwrap()],
    );
    assert_eq!(count(&app, "SELECT count(*) FROM sessions"), 2);
    let n = app
        .state
        .db
        .write_sync(|tx| tasks::purge_sessions(tx))
        .unwrap();
    assert_eq!(n, 1);
    assert_eq!(count(&app, "SELECT count(*) FROM sessions"), 1);
}

#[test]
fn history_retention_deletes_old_rows_and_zero_keeps_all() {
    let app = TestApp::new();
    let now = now_ms();
    for (i, age_days) in [400, 366, 364, 1].iter().enumerate() {
        exec(
            &app,
            "INSERT INTO record_history (record_id, table_id, kind, changes, created_at)
             VALUES (?1, 'tbl1', 'update', '{}', ?2)",
            rusqlite::params![format!("rec{i}"), now - age_days * DAY],
        );
    }
    let kept = app
        .state
        .db
        .write_sync(|tx| tasks::purge_history(tx, 0, now))
        .unwrap();
    assert_eq!(kept, 0, "history_days = 0 keeps everything");
    assert_eq!(count(&app, "SELECT count(*) FROM record_history"), 4);

    let n = app
        .state
        .db
        .write_sync(|tx| tasks::purge_history(tx, 365, now))
        .unwrap();
    assert_eq!(n, 2);
    let left: Vec<String> = app
        .state
        .db
        .write_sync(|tx| {
            let mut s = tx.prepare("SELECT record_id FROM record_history ORDER BY record_id")?;
            let v = s
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(v)
        })
        .unwrap();
    assert_eq!(left, vec!["rec2", "rec3"]);
}

/// Workspace/base/table rows for the GC test.
fn seed_table(app: &TestApp) {
    exec(
        app,
        "INSERT INTO workspaces (id, name, created_at) VALUES ('wsp1', 'W', 0)",
        [],
    );
    exec(
        app,
        "INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('app1', 'wsp1', 'B', 0)",
        [],
    );
    exec(
        app,
        "INSERT INTO tables (id, base_id, name, primary_field_id, created_at)
         VALUES ('tbl1', 'app1', 'T', 'fld1', 0)",
        [],
    );
}

/// An attachment row plus its file (and thumbnail) on disk.
fn add_attachment(app: &TestApp, id: &str, sha: &str, created_at: i64) -> std::path::PathBuf {
    exec(
        app,
        "INSERT INTO attachments (id, sha256, filename, mime, size, base_id, created_at, has_thumb)
         VALUES (?1, ?2, 'f.txt', 'text/plain', 1, 'app1', ?3, 1)",
        rusqlite::params![id, sha, created_at],
    );
    let dir = app.state.config.attachments_dir();
    let blob = opengrid::store::attachments::blob_path(&dir, sha).unwrap();
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::write(&blob, b"x").unwrap();
    let thumb = opengrid::store::attachments::thumb_path(&dir, sha).unwrap();
    std::fs::write(&thumb, b"t").unwrap();
    blob
}

fn add_record(app: &TestApp, id: &str, data: &str, deleted: bool) {
    exec(
        app,
        "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at, deleted_at)
         VALUES (?1, 'tbl1', ?2, 0, 0, 0, 0, ?3)",
        rusqlite::params![id, data, deleted.then_some(1i64)],
    );
}

fn sha(c: char) -> String {
    c.to_string().repeat(64)
}

#[test]
fn attachment_gc_deletes_unreferenced_rows_and_orphaned_files_only() {
    let app = TestApp::new();
    seed_table(&app);
    let now = now_ms();
    let old = now - 2 * DAY;

    // Referenced by a live record.
    let live_blob = add_attachment(&app, "attLiveRefxxxxxx1", &sha('a'), old);
    add_record(
        &app,
        "rec1",
        r#"{"fld9":[{"id":"attLiveRefxxxxxx1","filename":"f.txt","mime":"text/plain","size":1}]}"#,
        false,
    );
    // Referenced only by a trashed record (restorable): kept.
    let trashed_blob = add_attachment(&app, "attTrashRefxxxxx1", &sha('b'), old);
    add_record(
        &app,
        "rec2",
        r#"{"fld9":[{"id":"attTrashRefxxxxx1"}]}"#,
        true,
    );
    // Unreferenced but recent (an upload whose record save is in flight): kept.
    let recent_blob = add_attachment(&app, "attRecentxxxxxxx1", &sha('c'), now - HOUR);
    // Unreferenced and old: deleted with its file and thumbnail.
    let dead_blob = add_attachment(&app, "attDeadxxxxxxxxx1", &sha('d'), old);
    // Unreferenced and old, but shares its file with a referenced row: the row
    // goes, the file stays.
    let shared_blob = add_attachment(&app, "attDeadSharedxxx1", &sha('a'), old);
    assert_eq!(shared_blob, live_blob);

    let stats = app
        .state
        .db
        .write_sync(|tx| tasks::gc_attachments(tx, &app.state.config.attachments_dir(), now))
        .unwrap();
    assert_eq!(stats.rows_deleted, 2, "{stats:?}");
    assert_eq!(stats.files_deleted, 1, "{stats:?}");

    let ids: Vec<String> = app
        .state
        .db
        .write_sync(|tx| {
            let mut s = tx.prepare("SELECT id FROM attachments ORDER BY id")?;
            let v = s
                .query_map([], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;
            Ok(v)
        })
        .unwrap();
    assert_eq!(
        ids,
        vec![
            "attLiveRefxxxxxx1",
            "attRecentxxxxxxx1",
            "attTrashRefxxxxx1"
        ]
    );
    assert!(live_blob.exists());
    assert!(trashed_blob.exists());
    assert!(recent_blob.exists());
    assert!(!dead_blob.exists());
    let dead_thumb =
        opengrid::store::attachments::thumb_path(&app.state.config.attachments_dir(), &sha('d'))
            .unwrap();
    assert!(!dead_thumb.exists());

    // Idempotent.
    let again = app
        .state
        .db
        .write_sync(|tx| tasks::gc_attachments(tx, &app.state.config.attachments_dir(), now))
        .unwrap();
    assert_eq!((again.rows_deleted, again.files_deleted), (0, 0));
}

#[test]
fn gc_tolerates_missing_files() {
    let app = TestApp::new();
    seed_table(&app);
    let now = now_ms();
    let blob = add_attachment(&app, "attGonexxxxxxxxx1", &sha('e'), now - 2 * DAY);
    std::fs::remove_file(&blob).unwrap();
    let stats = app
        .state
        .db
        .write_sync(|tx| tasks::gc_attachments(tx, &app.state.config.attachments_dir(), now))
        .unwrap();
    assert_eq!(stats.rows_deleted, 1);
    assert_eq!(count(&app, "SELECT count(*) FROM attachments"), 0);
}

#[test]
fn stale_upload_temp_files_are_cleaned() {
    let app = TestApp::new();
    let tmp = app.state.config.data_dir.join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("upload-old"), b"x").unwrap();
    // Pretend "now" is two days ahead so the file counts as stale.
    let later = std::time::SystemTime::now() + std::time::Duration::from_secs(2 * 24 * 3600);
    assert_eq!(tasks::clean_tmp(&tmp, later).unwrap(), 1);
    assert!(!tmp.join("upload-old").exists());
    std::fs::write(tmp.join("upload-new"), b"x").unwrap();
    assert_eq!(
        tasks::clean_tmp(&tmp, std::time::SystemTime::now()).unwrap(),
        0
    );
    assert!(tmp.join("upload-new").exists());
    assert_eq!(tasks::clean_tmp(&tmp.join("missing"), later).unwrap(), 0);
}

fn local(y: i32, m: u32, d: u32, h: u32) -> chrono::DateTime<Local> {
    Local
        .with_ymd_and_hms(y, m, d, h, 30, 0)
        .earliest()
        .unwrap()
}

#[test]
fn daily_backup_is_due_once_per_day_after_the_configured_hour() {
    let at = |h| local(2026, 10, 12, h);
    let ms = |t: chrono::DateTime<Local>| t.timestamp_millis();
    // Disabled.
    assert!(!tasks::backup_due(-1, None, at(10)));
    // Before the hour: not yet.
    assert!(!tasks::backup_due(3, None, at(2)));
    // At or after the hour with no backup today: due (catch-up after downtime).
    assert!(tasks::backup_due(3, None, at(3)));
    assert!(tasks::backup_due(
        3,
        Some(ms(local(2026, 10, 11, 4))),
        at(9)
    ));
    // Already backed up today (even before the hour, e.g. manual-free restart).
    assert!(!tasks::backup_due(3, Some(ms(at(3))), at(23)));
    // Invalid hours never fire.
    assert!(!tasks::backup_due(24, None, at(23)));
}

#[test]
fn automatic_backup_job_writes_archive_and_skips_when_done_today() {
    let app = TestApp::with_config(|c| {
        c.backup_hour = 0;
        c.backup_keep = 2;
    });
    let first = tasks::run_backup_if_due(&app.state, Local::now()).unwrap();
    assert!(first.is_some());
    let second = tasks::run_backup_if_due(&app.state, Local::now()).unwrap();
    assert!(second.is_none(), "only one automatic backup per day");
    let disabled = TestApp::new(); // backup_hour = -1
    assert!(
        tasks::run_backup_if_due(&disabled.state, Local::now())
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn tick_runs_every_job_and_survives_failures() {
    let app = TestApp::new();
    let uid = app.user("a@example.com", "A").user_id.unwrap();
    exec(
        &app,
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
         VALUES ('expired', ?1, 0, 1, 0)",
        [uid],
    );
    let mut clock = tasks::Clock::default();
    tasks::tick(&app.state, &mut clock).await;
    assert_eq!(
        count(
            &app,
            "SELECT count(*) FROM sessions WHERE token_hash = 'expired'"
        ),
        0
    );

    // A failing job is logged and reported, never propagated or panicking.
    let failed = tasks::run_job(&app.state, "always-fails", |_| {
        Err::<(), _>(opengrid::error::AppError::internal("boom"))
    })
    .await;
    assert!(!failed);
    let panicked = tasks::run_job(
        &app.state,
        "panics",
        |_| -> opengrid::error::AppResult<()> { panic!("job panic") },
    )
    .await;
    assert!(!panicked);
    let ok = tasks::run_job(&app.state, "ok", |_| Ok(())).await;
    assert!(ok);
}
