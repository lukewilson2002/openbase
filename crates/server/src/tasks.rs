//! Background tasks run inside the server process (no external scheduler).
//!
//! [`spawn_all`] starts one tokio task that wakes every 60 seconds and runs
//! whichever jobs are due (see [`tick`]). Each job is a plain synchronous
//! function, tested directly; [`run_job`] runs one on the blocking pool and
//! logs any error or panic, so a failing job never stops the loop or the
//! other jobs.
//!
//! Jobs:
//! - expired session purge (hourly)
//! - attachment garbage collection + stale upload temp files (hourly)
//! - record history retention (`history_days`, daily)
//! - daily automatic backup at `backup_hour` local time + retention
//!
//! The data-plane workstream adds trash purge and volatile-formula refresh;
//! the automations workstream adds its runner. See the marked spots in
//! [`tick`].

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, Local, Timelike};
use rusqlite::Connection;

use crate::auth::session;
use crate::backup;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::attachments as attachment_store;

/// How often the loop wakes up.
pub const TICK: Duration = Duration::from_secs(60);
/// Unreferenced attachments younger than this are kept: an upload is saved
/// before the record that references it.
pub const ATTACHMENT_GRACE_MS: i64 = 24 * 3600 * 1000;
const HOURLY: Duration = Duration::from_secs(3600);
const DAILY: Duration = Duration::from_secs(24 * 3600);
const STALE_TMP: Duration = Duration::from_secs(24 * 3600);

/// Start the background loop. Call once, from inside the tokio runtime.
pub fn spawn_all(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        let mut clock = Clock::default();
        let mut interval = tokio::time::interval(TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            tick(&state, &mut clock).await;
        }
    });
}

/// When each periodic job last ran (None = never: runs on the first tick).
#[derive(Debug, Default)]
pub struct Clock {
    sessions: Option<Instant>,
    attachments: Option<Instant>,
    history: Option<Instant>,
}

fn due(last: &mut Option<Instant>, every: Duration) -> bool {
    let now = Instant::now();
    if last.is_some_and(|t| now.duration_since(t) < every) {
        return false;
    }
    *last = Some(now);
    true
}

/// Run every job that is due. Never fails; errors are logged.
pub async fn tick(state: &AppState, clock: &mut Clock) {
    if due(&mut clock.sessions, HOURLY) {
        run_job(state, "purge expired sessions", |s| {
            s.db.write_sync(|tx| purge_sessions(tx))
        })
        .await;
    }
    if due(&mut clock.attachments, HOURLY) {
        run_job(state, "attachment garbage collection", |s| {
            let dir = s.config.attachments_dir();
            let stats = s.db.write_sync(|tx| gc_attachments(tx, &dir, now_ms()))?;
            if stats.rows_deleted > 0 || stats.files_deleted > 0 {
                tracing::info!(
                    rows = stats.rows_deleted,
                    files = stats.files_deleted,
                    "deleted unreferenced attachments"
                );
            }
            clean_tmp(&s.config.data_dir.join("tmp"), SystemTime::now())
        })
        .await;
    }
    if due(&mut clock.history, DAILY) {
        run_job(state, "record history retention", |s| {
            let days = s.config.history_days;
            s.db.write_sync(|tx| purge_history(tx, days, now_ms()))
        })
        .await;
    }
    run_job(state, "automatic backup", |s| {
        run_backup_if_due(s, Local::now())
    })
    .await;

    // DATA-PLANE (W6): add the trash purge job (records/fields/tables/views/
    // bases deleted more than `config.trash_days` ago) and the volatile-formula
    // refresh (every 5 minutes) here, following the pattern above: a plain
    // function taking `&Transaction`, scheduled through a `Clock` field and
    // wrapped in `run_job`.
    //
    // AUTOMATIONS (W8): start the automation runner from `spawn_all` or
    // schedule its due-trigger scan here.
}

/// Run `job` on the blocking pool, logging errors and panics. Returns
/// whether it succeeded.
pub async fn run_job<T, F>(state: &AppState, name: &'static str, job: F) -> bool
where
    T: Send + 'static,
    F: FnOnce(&AppState) -> AppResult<T> + Send + 'static,
{
    let st = state.clone();
    let started = Instant::now();
    match tokio::task::spawn_blocking(move || job(&st)).await {
        Ok(Ok(_)) => {
            tracing::debug!(
                job = name,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "job done"
            );
            true
        }
        Ok(Err(e)) => {
            tracing::error!(job = name, error = %e, "background job failed");
            false
        }
        Err(e) => {
            tracing::error!(job = name, error = %e, "background job panicked");
            false
        }
    }
}

/// Delete expired sessions.
pub fn purge_sessions(conn: &Connection) -> AppResult<usize> {
    session::purge_expired(conn)
}

/// Delete record history older than `history_days` (0 = keep forever).
pub fn purge_history(conn: &Connection, history_days: u32, now_ms: i64) -> AppResult<usize> {
    if history_days == 0 {
        return Ok(0);
    }
    let cutoff = now_ms - i64::from(history_days) * 24 * 3600 * 1000;
    Ok(conn.execute("DELETE FROM record_history WHERE created_at < ?1", [cutoff])?)
}

/// Result of [`gc_attachments`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GcStats {
    pub rows_deleted: usize,
    pub files_deleted: usize,
}

/// Delete attachment rows older than [`ATTACHMENT_GRACE_MS`] that no record
/// (live or trashed) references, then the files (and thumbnails) whose hash no
/// remaining row uses.
///
/// Must run inside a write transaction: uploads store their file and insert
/// their row under the same writer lock, so a file can never be deleted
/// between an upload reusing it and its row being inserted. Missing files are
/// ignored.
pub fn gc_attachments(
    conn: &Connection,
    attachments_dir: &Path,
    now_ms: i64,
) -> AppResult<GcStats> {
    let shas = attachment_store::delete_unreferenced(conn, now_ms - ATTACHMENT_GRACE_MS)?;
    let mut stats = GcStats {
        rows_deleted: shas.len(),
        files_deleted: 0,
    };
    let unique: HashSet<String> = shas.into_iter().collect();
    for sha in unique {
        if attachment_store::sha_in_use(conn, &sha)? {
            continue;
        }
        let blob = attachment_store::blob_path(attachments_dir, &sha)?;
        let thumb = attachment_store::thumb_path(attachments_dir, &sha)?;
        if remove_if_exists(&blob)? {
            stats.files_deleted += 1;
        }
        remove_if_exists(&thumb)?;
    }
    Ok(stats)
}

fn remove_if_exists(path: &Path) -> AppResult<bool> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(AppError::internal(format!(
            "cannot delete {}: {e}",
            path.display()
        ))),
    }
}

/// Delete files in the upload temp directory older than a day (left behind by
/// a crash mid-upload). Returns how many were removed.
pub fn clean_tmp(dir: &Path, now: SystemTime) -> AppResult<usize> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => {
            return Err(AppError::internal(format!(
                "cannot read {}: {e}",
                dir.display()
            )));
        }
    };
    let mut n = 0;
    for entry in rd.filter_map(|e| e.ok()) {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .unwrap_or_default();
        if age > STALE_TMP && remove_if_exists(&entry.path())? {
            n += 1;
        }
    }
    Ok(n)
}

/// Whether the daily automatic backup should run now: backups are enabled
/// (`backup_hour` in 0..=23), the hour has been reached today (local time),
/// and no automatic backup was taken earlier today. A server that was down at
/// the backup hour catches up on the next tick.
pub fn backup_due(backup_hour: i32, last_backup_ms: Option<i64>, now: DateTime<Local>) -> bool {
    let Ok(hour) = u32::try_from(backup_hour) else {
        return false;
    };
    if hour > 23 || now.hour() < hour {
        return false;
    }
    let last_day = last_backup_ms
        .and_then(DateTime::from_timestamp_millis)
        .map(|t| t.with_timezone(&Local).date_naive());
    last_day != Some(now.date_naive())
}

/// Take the automatic backup (and prune old ones) if [`backup_due`].
pub fn run_backup_if_due(state: &AppState, now: DateTime<Local>) -> AppResult<Option<PathBuf>> {
    let last = backup::last_automatic_backup_ms(&state.config.backups_dir());
    if !backup_due(state.config.backup_hour, last, now) {
        return Ok(None);
    }
    let path = backup::create_automatic(state)?;
    tracing::info!(path = %path.display(), "automatic backup written");
    Ok(Some(path))
}
