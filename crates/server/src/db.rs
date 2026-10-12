//! SQLite access.
//!
//! One writer connection (behind a mutex) serializes all writes, so every
//! mutation is a plain transaction with no SQLITE_BUSY handling; a small pool
//! of reader connections serves queries concurrently thanks to WAL mode.
//! Both are used from `spawn_blocking` via [`Db::read`] and [`Db::write`].

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OpenFlags, Transaction};

use crate::error::{AppError, AppResult};

/// Embedded migrations, applied in order. `PRAGMA user_version` records how
/// many have been applied. Never edit a released migration; add a new one.
const MIGRATIONS: &[&str] = &[include_str!("../migrations/0001_init.sql")];

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
    pub fn open(path: &Path) -> AppResult<Db> {
        let writer = Connection::open(path).map_err(AppError::internal)?;
        configure(&writer).map_err(AppError::internal)?;
        migrate(&writer)?;
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
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = inner.writer.lock().unwrap_or_else(|p| p.into_inner());
            let tx = conn
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(AppError::internal)?;
            let out = f(&tx)?;
            tx.commit().map_err(AppError::internal)?;
            Ok(out)
        })
        .await
        .map_err(AppError::internal)?
    }

    /// Run `f` with a read-only connection from the pool.
    pub async fn read<T, F>(&self, f: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> AppResult<T> + Send + 'static,
    {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let conn = inner.readers.get().map_err(AppError::internal)?;
            f(&conn)
        })
        .await
        .map_err(AppError::internal)?
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
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(AppError::internal)?;
    let target = schema_version();
    if current > target {
        return Err(AppError::internal(format!(
            "database schema version {current} is newer than this binary supports ({target}); \
             upgrade OpenGrid or restore a backup"
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
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

    #[test]
    fn refuses_newer_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 9999").unwrap();
        assert!(migrate(&conn).is_err());
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
