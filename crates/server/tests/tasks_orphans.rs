//! Orphaned attachment files (on disk, but no row uses their hash) are swept.
//! They appear when a row insert fails after the file was stored, or after a
//! restore merges attachments into a data dir whose database doesn't use them.

mod common;

use common::TestApp;
use opengrid::store::attachments::{blob_path, thumb_path};
use opengrid::tasks;

fn put(dir: &std::path::Path, sha: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let blob = blob_path(dir, sha).unwrap();
    let thumb = thumb_path(dir, sha).unwrap();
    std::fs::create_dir_all(blob.parent().unwrap()).unwrap();
    std::fs::write(&blob, b"x").unwrap();
    std::fs::write(&thumb, b"t").unwrap();
    (blob, thumb)
}

#[test]
fn sweep_deletes_files_without_rows_and_keeps_used_and_foreign_files() {
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

    let used_sha = used.clone();
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "INSERT INTO attachments (id, sha256, filename, mime, size, created_at)
                 VALUES ('attUsedxxxxxxxxx1', ?1, 'f', 'text/plain', 1, 0)",
                [used_sha],
            )?;
            Ok(())
        })
        .unwrap();

    let removed = app
        .state
        .db
        .write_sync(|tx| tasks::sweep_orphan_files(tx, &dir))
        .unwrap();
    assert_eq!(removed, 2, "orphan blob + lone thumbnail");
    assert!(used_blob.exists() && used_thumb.exists());
    assert!(!orphan_blob.exists() && !orphan_thumb.exists());
    assert!(!lone_thumb.exists());
    assert!(foreign.exists());

    // Idempotent; a missing directory is fine.
    let again = app
        .state
        .db
        .write_sync(|tx| tasks::sweep_orphan_files(tx, &dir))
        .unwrap();
    assert_eq!(again, 0);
    let none = app
        .state
        .db
        .write_sync(|tx| tasks::sweep_orphan_files(tx, &dir.join("missing")))
        .unwrap();
    assert_eq!(none, 0);
}
