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
//! - orphaned attachment file sweep (daily)
//! - record history retention (`history_days`, daily)
//! - audit log retention (`audit_days`, daily)
//! - trash purge (`trash_days`, daily)
//! - volatile formula refresh (`NOW()`/`TODAY()`..., every 5 minutes)
//! - daily automatic backup at `backup_hour` local time + retention
//!
//! The automations workstream adds its runner; see the marked spot in
//! [`tick`].

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use chrono::{DateTime, Local, Timelike};
use og_core::api::events::BaseEvent;
use rusqlite::{Connection, Transaction};

use crate::auth::session;
use crate::backup;
use crate::db::now_ms;
use crate::engine::recompute;
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
const VOLATILE_EVERY: Duration = Duration::from_secs(5 * 60);
const STALE_TMP: Duration = Duration::from_secs(24 * 3600);
/// Orphaned attachment files younger than this are never swept.
pub const ORPHAN_GRACE: Duration = Duration::from_secs(24 * 3600);

/// Start the background loop. Call once, from inside the tokio runtime.
pub fn spawn_all(state: &AppState) {
    // AUTOMATIONS (W8): the run queue worker has its own loop (it wakes on new
    // runs and polls every 2 s), so it is started here rather than from `tick`.
    crate::automations::runner::spawn(state);

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
    orphans: Option<Instant>,
    history: Option<Instant>,
    audit: Option<Instant>,
    trash: Option<Instant>,
    volatile: Option<Instant>,
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
    if due(&mut clock.orphans, DAILY) {
        run_job(state, "orphaned attachment files", |s| {
            let dir = s.config.attachments_dir();
            let n =
                s.db.write_sync(|tx| sweep_orphan_files(tx, &dir, SystemTime::now()))?;
            if n > 0 {
                tracing::info!(files = n, "deleted orphaned attachment files");
            }
            Ok(n)
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
    if due(&mut clock.audit, DAILY) {
        run_job(state, "audit log retention", |s| {
            let days = s.config.audit_days;
            s.db.write_sync(|tx| purge_audit(tx, days, now_ms()))
        })
        .await;
    }
    run_job(state, "automatic backup", |s| {
        run_backup_if_due(s, Local::now())
    })
    .await;

    if due(&mut clock.trash, DAILY) {
        run_job(state, "trash purge", |s| {
            let days = s.config.trash_days;
            let stats = s.db.write_sync(|tx| purge_trash(tx, days, now_ms()))?;
            if stats != Default::default() {
                tracing::info!(?stats, "purged expired trash");
            }
            Ok(stats)
        })
        .await;
    }
    if due(&mut clock.volatile, VOLATILE_EVERY) {
        run_job(state, "volatile formula refresh", |s| {
            refresh_volatile_formulas(s, chrono::Utc::now())
        })
        .await;
    }

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

/// Permanently delete everything that has been in the trash for more than
/// `trash_days` days (records, fields, tables, views, bases, workspaces).
pub fn purge_trash(
    tx: &Transaction,
    trash_days: u32,
    now_ms: i64,
) -> AppResult<crate::store::trash::PurgeStats> {
    let cutoff = now_ms - i64::from(trash_days) * 24 * 3600 * 1000;
    crate::store::trash::purge_expired(tx, cutoff)
}

/// Most record ids put into one refresh event.
const REFRESH_EVENT_IDS: usize = 1000;

/// Recompute every formula that depends on the clock (`NOW()`, `TODAY()`...)
/// for the live records of every base, plus whatever depends on those
/// formulas, one base per transaction. Subscribers hear about the changed
/// records (at most [`REFRESH_EVENT_IDS`] ids per table). Returns the number
/// of records whose stored values changed.
pub fn refresh_volatile_formulas(state: &AppState, now: DateTime<chrono::Utc>) -> AppResult<usize> {
    let groups = state.db.write_sync(|tx| recompute::volatile_fields(tx))?;
    let mut changed = 0;
    for (base_id, field_ids) in groups {
        let outcome = state
            .db
            .write_sync(|tx| recompute::refresh_volatile(tx, &base_id, &field_ids, now))?;
        for (table_id, ids) in outcome.updated {
            changed += ids.len();
            state.events.publish(
                &base_id,
                None,
                None,
                BaseEvent::RecordsChanged {
                    table_id,
                    created: Vec::new(),
                    updated: ids.into_iter().take(REFRESH_EVENT_IDS).collect(),
                    deleted: Vec::new(),
                },
            );
        }
    }
    Ok(changed)
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

/// Delete audit-log rows older than `audit_days` (0 = keep forever). Failed
/// sign-ins can be written by anyone, so the log must not grow without bound.
pub fn purge_audit(conn: &Connection, audit_days: u32, now_ms: i64) -> AppResult<usize> {
    if audit_days == 0 {
        return Ok(0);
    }
    let cutoff = now_ms - i64::from(audit_days) * 24 * 3600 * 1000;
    Ok(conn.execute("DELETE FROM audit_log WHERE created_at < ?1", [cutoff])?)
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

/// Delete attachment files (and thumbnails) whose hash no attachment row uses.
/// Such files appear when a row insert fails after its file was stored, or
/// after a restore merges in attachments the restored database doesn't use.
/// Files whose names are not `<sha256>` / `<sha256>.thumb.png` are left alone.
///
/// Like [`gc_attachments`], must run inside a write transaction so it cannot
/// race an upload that is reusing a file. Returns the number of files removed
/// (a blob and its thumbnail count once).
///
/// Two safety guards, because deleting files cannot be undone: nothing is
/// deleted when the attachments table is empty (e.g. `opengrid.db` was
/// replaced by a fresh database by mistake: the files are then the only copy
/// left), and only files last modified more than [`ORPHAN_GRACE`] before
/// `now` are candidates (a just-restored or just-copied file is kept for a
/// day, giving the administrator time to notice a mistake).
pub fn sweep_orphan_files(
    conn: &Connection,
    attachments_dir: &Path,
    now: SystemTime,
) -> AppResult<usize> {
    let any_rows = conn.query_row("SELECT EXISTS (SELECT 1 FROM attachments)", [], |r| {
        r.get::<_, bool>(0)
    })?;
    if !any_rows {
        return Ok(0);
    }
    let old_enough = |path: &Path| {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age >= ORPHAN_GRACE)
    };
    let shards = match std::fs::read_dir(attachments_dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => {
            return Err(AppError::internal(format!(
                "cannot read {}: {e}",
                attachments_dir.display()
            )));
        }
    };
    let mut removed = 0;
    for shard in shards.filter_map(|e| e.ok()) {
        if !shard.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(shard.path()) else {
            continue;
        };
        for file in files.filter_map(|e| e.ok()) {
            let name = file.file_name().to_string_lossy().into_owned();
            let (sha, is_thumb) = match name.strip_suffix(".thumb.png") {
                Some(sha) => (sha.to_string(), true),
                None => (name.clone(), false),
            };
            // blob_path validates the hash, so anything not ours is skipped.
            let Ok(blob) = attachment_store::blob_path(attachments_dir, &sha) else {
                continue;
            };
            if blob.parent() != Some(shard.path().as_path())
                || !old_enough(&file.path())
                || attachment_store::sha_in_use(conn, &sha)?
            {
                continue;
            }
            if is_thumb {
                // Counted only when its blob is already gone.
                if !blob.exists() && remove_if_exists(&file.path())? {
                    removed += 1;
                }
            } else if remove_if_exists(&blob)? {
                remove_if_exists(&attachment_store::thumb_path(attachments_dir, &sha)?)?;
                removed += 1;
            }
        }
    }
    Ok(removed)
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
