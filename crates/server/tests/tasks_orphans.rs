//! Orphaned attachment files (on disk, but no row uses their hash) are swept.
//! They appear when a row insert fails after the file was stored, or after a
//! restore merges attachments into a data dir whose database doesn't use them.

mod common;

use std::time::{Duration, SystemTime};

use common::TestApp;
use openbase::store::attachments::{blob_path, thumb_path};
use openbase::tasks;

fn put(dir: &std::path::Path, sha: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let blob = blob_path(dir, sha).unwrap();
    let thumb = thumb_path(dir, sha).unwrap();
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::write(&blob, b"x").unwrap();
    std::fs::write(&thumb, b"t").unwrap();
    (blob, thumb)
}

fn insert_row(app: &TestApp, id: &str, sha: &str) {
    let (id, sha) = (id.to_string(), sha.to_string());
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "INSERT INTO attachments (id, sha256, filename, mime, size, created_at)
                 VALUES (?1, ?2, 'f', 'text/plain', 1, 0)",
                [id, sha],
            )?;
            Ok(())
        })
        .unwrap();
}

fn sweep(app: &TestApp, dir: &std::path::Path, now: SystemTime) -> usize {
    app.state
        .db
        .write_sync(|tx| tasks::sweep_orphan_files(tx, dir, now))
        .unwrap()
}

/// A moment past the grace period for files written just now.
fn later() -> SystemTime {
    SystemTime::now() + tasks::ORPHAN_GRACE + Duration::from_secs(60)
}

#[test]
fn sweep_deletes_old_files_without_rows_and_keeps_used_and_foreign_files() {
    let app = TestApp::new();
    let dir = app.state.config.attachments_dir();
    let used = "a".repeat(64);
    let orphan = "b".repeat(64);
    let (used_blob, used_thumb) = put(&dir, &used);
    let (orphan_blob, orphan_thumb) = put(&dir, &orphan);
    // A lone thumbnail whose blob is gone, and files that aren't ours.
    let lone_thumb = thumb_path(&dir, &"c".repeat(64)).unwrap();
    std::fs::create_dir_all(lone_thumb.parent().unwrap()).unwrap();
    std::fs::write(&lone_thumb, b"t").unwrap();
    let foreign = dir.join("aa").join("README.txt");
    std::fs::write(&foreign, b"keep me").unwrap();
    insert_row(&app, "attUsedxxxxxxxxx1", &used);

    // Fresh files are inside the grace period: nothing is deleted yet.
    assert_eq!(sweep(&app, &dir, SystemTime::now()), 0);
    assert!(orphan_blob.exists() && lone_thumb.exists());

    let removed = sweep(&app, &dir, later());
    assert_eq!(removed, 2, "orphan blob + lone thumbnail");
    assert!(used_blob.exists() && used_thumb.exists());
    assert!(!orphan_blob.exists() && !orphan_thumb.exists());
    assert!(!lone_thumb.exists());
    assert!(foreign.exists());

    // Idempotent; a missing directory is fine.
    assert_eq!(sweep(&app, &dir, later()), 0);
    assert_eq!(sweep(&app, &dir.join("missing"), later()), 0);
}

#[test]
fn sweep_never_deletes_anything_when_the_attachments_table_is_empty() {
    // E.g. openbase.db was replaced by a fresh database by mistake: the files
    // on disk are then the only copy left.
    let app = TestApp::new();
    let dir = app.state.config.attachments_dir();
    let (blob, thumb) = put(&dir, &"d".repeat(64));
    assert_eq!(sweep(&app, &dir, later()), 0);
    assert!(blob.exists() && thumb.exists());
}
