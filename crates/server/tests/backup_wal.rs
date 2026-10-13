//! `restore` detects a running server by a non-empty WAL file, so a cleanly
//! stopped server must leave no WAL behind.

mod common;

use common::TestApp;
use opengrid::backup;
use opengrid::config::Config;
use opengrid::state::AppState;

#[tokio::test]
async fn cleanly_closed_database_leaves_no_wal_so_restore_proceeds() {
    let source = TestApp::new();
    let archive = backup::create(&source.state, None).unwrap();

    let target = tempfile::tempdir().unwrap();
    let config = Config::for_tests(target.path());
    {
        let state = AppState::open(config.clone()).unwrap();
        state
            .db
            .write(|tx| {
                tx.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", [])?;
                Ok(())
            })
            .await
            .unwrap();
        // Use a reader too, as a running server would.
        let n: i64 = state
            .db
            .read(|c| Ok(c.query_row("SELECT count(*) FROM settings", [], |r| r.get(0))?))
            .await
            .unwrap();
        assert_eq!(n, 1);
    }
    let wal = target.path().join("opengrid.db-wal");
    let wal_len = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    assert_eq!(wal_len, 0, "a clean shutdown must checkpoint the WAL");

    // Only the existing database blocks the restore now, not the WAL check.
    let err = backup::restore(&config, &archive, false).unwrap_err();
    assert!(err.to_string().contains("--force"), "{err}");
    backup::restore(&config, &archive, true).unwrap();
    let state = AppState::open(config).unwrap();
    let n: i64 = state
        .db
        .write_sync(|tx| {
            Ok(
                tx.query_row("SELECT count(*) FROM settings WHERE key = 'k'", [], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(n, 0, "restored database replaced the old one");
}

#[tokio::test]
async fn an_explicit_checkpoint_empties_the_wal_while_handles_are_still_open() {
    // A running server keeps database handles alive in background tasks, so
    // the checkpoint-on-drop never happens; shutdown calls `checkpoint`.
    let target = tempfile::tempdir().unwrap();
    let state = AppState::open(Config::for_tests(target.path())).unwrap();
    state
        .db
        .write(|tx| {
            tx.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')", [])?;
            Ok(())
        })
        .await
        .unwrap();
    let wal = target.path().join("opengrid.db-wal");
    let wal_len = || std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    assert!(wal_len() > 0, "the write should sit in the WAL");
    state.db.checkpoint().unwrap();
    assert_eq!(wal_len(), 0);
    // Still usable afterwards.
    state
        .db
        .write(|tx| {
            tx.execute("INSERT INTO settings (key, value) VALUES ('k2', 'v')", [])?;
            Ok(())
        })
        .await
        .unwrap();
}
