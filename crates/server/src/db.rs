//! SQLite access.
//!
//! One writer connection (behind a mutex) serializes all writes, so every
//! mutation is a plain transaction with no SQLITE_BUSY handling; a small pool
//! of reader connections serves queries concurrently thanks to WAL mode.
//! Both are used from `spawn_blocking` via [`Db::read`] and [`Db::write`].

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags, Transaction};

use crate::error::{AppError, AppResult};

/// Embedded migrations, applied in order. `PRAGMA user_version` records how
/// many have been applied. Never edit a released migration; add a new one.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_icons.sql"),
];

pub fn schema_version() -> i64 {
    MIGRATIONS.len() as i64
}

#[derive(Clone)]
pub struct Db {
    inner: Arc<Inner>,
}

struct Inner {
    writer: Mutex<Connection>,
    readers: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,
}

impl Drop for Inner {
    /// On shutdown, fold the WAL back into the database file and truncate it.
    /// SQLite only does this automatically when the *last* connection closes,
    /// and here that can be a read-only pool connection, which cannot. An
    /// empty WAL after a clean stop is what `opengrid restore` relies on to
    /// tell a stopped server from a running one.
    fn drop(&mut self) {
        let conn = self.writer.get_mut().unwrap_or_else(|p| p.into_inner());
        if let Err(e) = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())) {
            tracing::warn!(error = %e, "could not checkpoint the database on shutdown");
        }
    }
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -8000;",
    )
}

impl Db {
    /// Open (creating if needed) the database at `path` and run pending migrations.
    ///
    /// When an existing database is about to be migrated, a snapshot is first
    /// written to the `backups` directory next to the database file (the data
    /// directory layout used by [`crate::config::Config`]). Use
    /// [`Db::open_with_backup_dir`] to choose another directory or none.
    pub fn open(path: &Path) -> AppResult<Db> {
        let backups = path.parent().map(|p| p.join("backups"));
        Self::open_with_backup_dir(path, backups.as_deref())
    }

    /// Like [`Db::open`], with an explicit directory for the pre-migration
    /// snapshot (`None` disables it).
    pub fn open_with_backup_dir(path: &Path, backup_dir: Option<&Path>) -> AppResult<Db> {
        let writer = Connection::open(path).map_err(AppError::internal)?;
        configure(&writer).map_err(AppError::internal)?;
        migrate_with(&writer, MIGRATIONS, backup_dir)?;
        let manager = r2d2_sqlite::SqliteConnectionManager::file(path)
            .with_flags(OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .with_init(|c| {
                c.execute_batch(
                    "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -4000;",
                )
            });
        let readers = r2d2::Pool::builder()
            .max_size(4)
            .min_idle(Some(1))
            .build(manager)
            .map_err(AppError::internal)?;
        Ok(Db {
            inner: Arc::new(Inner {
                writer: Mutex::new(writer),
                readers,
            }),
        })
    }

    /// Run `f` inside a write transaction on the single writer connection.
    /// The transaction commits if `f` returns Ok and rolls back otherwise.
    pub async fn write<T, F>(&self, f: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction) -> AppResult<T> + Send + 'static,
    {
        self.write_as(f).await
    }

    /// [`write`](Self::write) for callers with their own error type (for
    /// example the Airtable-compatible API's), which must be built from
    /// [`AppError`] and is returned as is, rolling the transaction back.
    pub async fn write_as<T, E, F>(&self, f: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<AppError> + Send + 'static,
        F: FnOnce(&Transaction) -> Result<T, E> + Send + 'static,
    {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = inner.writer.lock().unwrap_or_else(|p| p.into_inner());
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|e| E::from(AppError::internal(e)))?;
            let out = f(&tx)?;
            tx.commit().map_err(|e| E::from(AppError::internal(e)))?;
            Ok(out)
        })
        .await
        .map_err(|e| E::from(AppError::internal(e)))?
    }

    /// Run `f` with a read-only connection from the pool.
    pub async fn read<T, F>(&self, f: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> AppResult<T> + Send + 'static,
    {
        self.read_as(f).await
    }

    /// [`read`](Self::read) with the caller's own error type.
    pub async fn read_as<T, E, F>(&self, f: F) -> Result<T, E>
    where
        T: Send + 'static,
        E: From<AppError> + Send + 'static,
        F: FnOnce(&Connection) -> Result<T, E> + Send + 'static,
    {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner
                .readers
                .get()
                .map_err(|e| E::from(AppError::internal(e)))?;
            f(&conn)
        })
        .await
        .map_err(|e| E::from(AppError::internal(e)))?
    }

    /// Synchronous access to the writer for CLI commands and tests.
    pub fn write_sync<T>(&self, f: impl FnOnce(&Transaction) -> AppResult<T>) -> AppResult<T> {
        let mut conn = self.inner.writer.lock().unwrap_or_else(|p| p.into_inner());
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(AppError::internal)?;
        let out = f(&tx)?;
        tx.commit().map_err(AppError::internal)?;
        Ok(out)
    }

    /// Fold the WAL back into the database file and truncate it (what
    /// dropping the last handle does). A server calls this explicitly on
    /// shutdown: background tasks keep handles alive until the process exits,
    /// so the drop never runs, and `opengrid restore` treats a non-empty WAL
    /// as "the server is still running".
    pub fn checkpoint(&self) -> AppResult<()> {
        let conn = self.inner.writer.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .map_err(AppError::internal)
    }

    /// Consistent online snapshot of the database into `dest` (VACUUM INTO).
    pub fn snapshot_to(&self, dest: &Path) -> AppResult<()> {
        let conn = self.inner.writer.lock().unwrap_or_else(|p| p.into_inner());
        let dest = dest
            .to_str()
            .ok_or_else(|| AppError::internal("non-utf8 path"))?;
        conn.execute("VACUUM INTO ?1", [dest])
            .map_err(AppError::internal)?;
        Ok(())
    }
}

/// Apply pending migrations. Refuses to run against a database created by a
/// newer OpenGrid (downgrades are not supported).
pub fn migrate(conn: &Connection) -> AppResult<()> {
    migrate_with(conn, MIGRATIONS, None)
}

/// File name prefix of automatic pre-migration snapshots.
pub const PRE_MIGRATION_PREFIX: &str = "pre-migration-v";

/// Apply `migrations`. If the database already has a schema (user_version > 0)
/// and migrations are pending, first snapshot it into `backup_dir` as
/// `pre-migration-v<old>-<YYYYmmdd-HHMMSS>.db` so a failed or unwanted
/// upgrade can be rolled back by restoring that file.
fn migrate_with(
    conn: &Connection,
    migrations: &[&str],
    backup_dir: Option<&Path>,
) -> AppResult<()> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(AppError::internal)?;
    let target = migrations.len() as i64;
    if current > target {
        return Err(AppError::internal(format!(
            "database schema version {current} is newer than this binary supports ({target}); \
             upgrade OpenGrid or restore a backup"
        )));
    }
    if current > 0 && current < target {
        if let Some(dir) = backup_dir {
            let path = pre_migration_snapshot(conn, dir, current)?;
            tracing::info!(path = %path.display(), "wrote pre-migration snapshot");
        }
    }
    for (i, sql) in migrations.iter().enumerate().skip(current as usize) {
        let version = i as i64 + 1;
        tracing::info!(version, "applying database migration");
        conn.execute_batch("BEGIN IMMEDIATE")
            .map_err(AppError::internal)?;
        let res = conn
            .execute_batch(sql)
            .and_then(|_| conn.execute_batch(&format!("PRAGMA user_version = {version}")));
        match res {
            Ok(()) => conn.execute_batch("COMMIT").map_err(AppError::internal)?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(AppError::internal(format!(
                    "migration {version} failed: {e}"
                )));
            }
        }
    }
    Ok(())
}

/// `VACUUM INTO` a fresh file in `dir`; refuses to migrate if this fails, since
/// migrating without a safety copy is exactly what the snapshot is for.
fn pre_migration_snapshot(conn: &Connection, dir: &Path, version: i64) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|e| {
        AppError::internal(format!(
            "cannot create backup directory {}: {e}",
            dir.display()
        ))
    })?;
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let mut path = dir.join(format!("{PRE_MIGRATION_PREFIX}{version}-{ts}.db"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{PRE_MIGRATION_PREFIX}{version}-{ts}-{n}.db"));
        n += 1;
    }
    let dest = path
        .to_str()
        .ok_or_else(|| AppError::internal("non-utf8 backup path"))?;
    conn.execute("VACUUM INTO ?1", [dest]).map_err(|e| {
        AppError::internal(format!(
            "could not write pre-migration snapshot to {dest}: {e}; not migrating"
        ))
    })?;
    Ok(path)
}

/// Current version of the database file at `path` without migrating it.
pub fn file_schema_version(path: &Path) -> AppResult<i64> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(AppError::internal)?;
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(AppError::internal)
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_empty_database_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, schema_version());
        migrate(&conn).unwrap();
        let fk_errors: i64 = conn
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(fk_errors, 0);
    }

    /// A v1 database holding a workspace, base and table.
    fn v1_database(conn: &Connection, base_icon: Option<&str>) {
        migrate_with(conn, &MIGRATIONS[..1], None).unwrap();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Acme', 1);
             INSERT INTO bases (id, workspace_id, name, created_at) VALUES ('b1', 'w1', 'CRM', 1);
             INSERT INTO tables (id, base_id, name, primary_field_id, created_at)
                 VALUES ('t1', 'b1', 'Contacts', 'f1', 1);",
        )
        .unwrap();
        conn.execute("UPDATE bases SET icon = ?1", [base_icon])
            .unwrap();
    }

    #[test]
    fn v1_database_migrates_to_icons_keeping_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        v1_database(&conn, Some("briefcase"));
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
        migrate(&conn).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 2);
        assert_eq!(schema_version(), 2);
        let icon = |sql: &str| -> Option<String> { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        // new columns exist and start empty; existing rows are intact
        assert_eq!(icon("SELECT icon FROM workspaces WHERE id = 'w1'"), None);
        assert_eq!(icon("SELECT icon FROM tables WHERE id = 't1'"), None);
        assert_eq!(
            icon("SELECT name FROM tables WHERE id = 't1'").as_deref(),
            Some("Contacts")
        );
        // a valid v1 base icon is kept
        assert_eq!(
            icon("SELECT icon FROM bases WHERE id = 'b1'").as_deref(),
            Some("briefcase")
        );
        // and the new columns accept values
        conn.execute_batch(
            "UPDATE workspaces SET icon = 'store'; UPDATE tables SET icon = 'package';",
        )
        .unwrap();
        // migrating again is a no-op
        migrate(&conn).unwrap();
        assert_eq!(
            icon("SELECT icon FROM tables WHERE id = 't1'").as_deref(),
            Some("package")
        );
    }

    #[test]
    fn v1_free_text_base_icons_that_are_not_valid_names_are_cleared() {
        for bad in [
            "",
            "Briefcase",
            "chart column",
            "\u{1F4BC}",
            &"x".repeat(65),
        ] {
            let conn = Connection::open_in_memory().unwrap();
            v1_database(&conn, Some(bad));
            migrate(&conn).unwrap();
            let icon: Option<String> = conn
                .query_row("SELECT icon FROM bases WHERE id = 'b1'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(icon, None, "{bad:?}");
        }
    }

    #[test]
    fn v1_file_database_is_snapshotted_before_the_icons_migration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opengrid.db");
        {
            let conn = Connection::open(&path).unwrap();
            v1_database(&conn, None);
        }
        let db = Db::open(&path).unwrap();
        drop(db);
        let files = snapshots(&dir.path().join("backups"));
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].starts_with("pre-migration-v1-"));
        assert_eq!(file_schema_version(&path).unwrap(), 2);
    }

    #[test]
    fn refuses_newer_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 9999").unwrap();
        assert!(migrate(&conn).is_err());
    }

    fn snapshots(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    const M1: &str = "CREATE TABLE a (x INTEGER);";
    const M2: &str = "CREATE TABLE b (y INTEGER);";

    #[test]
    fn pre_migration_snapshot_taken_when_upgrading_existing_db() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("backups");
        let db_path = dir.path().join("t.db");
        let conn = Connection::open(&db_path).unwrap();
        migrate_with(&conn, &[M1], Some(&backups)).unwrap();
        conn.execute("INSERT INTO a VALUES (42)", []).unwrap();
        // Fresh database -> no snapshot.
        assert!(snapshots(&backups).is_empty());

        // Upgrade 1 -> 2 snapshots the v1 database first.
        migrate_with(&conn, &[M1, M2], Some(&backups)).unwrap();
        let files = snapshots(&backups);
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].starts_with("pre-migration-v1-") && files[0].ends_with(".db"));
        let snap = Connection::open(backups.join(&files[0])).unwrap();
        let v: i64 = snap
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
        let x: i64 = snap.query_row("SELECT x FROM a", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 42);
        let has_b: i64 = snap
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(has_b, 0, "snapshot must predate the migration");

        // Up to date -> no new snapshot.
        migrate_with(&conn, &[M1, M2], Some(&backups)).unwrap();
        assert_eq!(snapshots(&backups).len(), 1);
    }

    #[test]
    fn no_snapshot_without_backup_dir_or_for_new_db() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("backups");
        let conn = Connection::open(dir.path().join("t.db")).unwrap();
        migrate_with(&conn, &[M1, M2], Some(&backups)).unwrap();
        assert!(snapshots(&backups).is_empty());
        let conn2 = Connection::open(dir.path().join("u.db")).unwrap();
        migrate_with(&conn2, &[M1], None).unwrap();
        migrate_with(&conn2, &[M1, M2], None).unwrap();
        assert!(snapshots(&backups).is_empty());
    }

    #[test]
    fn db_open_uses_sibling_backups_dir_and_skips_fresh_db() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("opengrid.db")).unwrap();
        drop(db);
        assert!(snapshots(&dir.path().join("backups")).is_empty());
    }

    #[tokio::test]
    async fn write_rolls_back_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        let r: AppResult<()> = db
            .write(|tx| {
                tx.execute("INSERT INTO settings(key, value) VALUES ('a', 'b')", [])
                    .map_err(AppError::internal)?;
                Err(AppError::bad_request("nope"))
            })
            .await;
        assert!(r.is_err());
        let n: i64 = db
            .read(|c| {
                c.query_row("SELECT count(*) FROM settings", [], |r| r.get(0))
                    .map_err(AppError::internal)
            })
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
}
