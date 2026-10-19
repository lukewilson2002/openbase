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
    include_str!("../migrations/0003_oauth.sql"),
    include_str!("../migrations/0004_passkeys.sql"),
    include_str!("../migrations/0005_workspace_base_access.sql"),
    include_str!("../migrations/0006_workspace_color_deleted_by.sql"),
    include_str!("../migrations/0007_invite_may_raise_roles.sql"),
    include_str!("../migrations/0008_view_description_field.sql"),
    include_str!("../migrations/0009_inbox.sql"),
    include_str!("../migrations/0010_comments_created.sql"),
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
    /// empty WAL after a clean stop is what `openbase restore` relies on to
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
    /// so the drop never runs, and `openbase restore` treats a non-empty WAL
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
/// newer OpenBase (downgrades are not supported).
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
             upgrade OpenBase or restore a backup"
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
        assert_eq!(v, schema_version());
        assert_eq!(schema_version(), 10);
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
        let path = dir.path().join("openbase.db");
        {
            let conn = Connection::open(&path).unwrap();
            v1_database(&conn, None);
        }
        let db = Db::open(&path).unwrap();
        drop(db);
        let files = snapshots(&dir.path().join("backups"));
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].starts_with("pre-migration-v1-"));
        assert_eq!(file_schema_version(&path).unwrap(), schema_version());
    }

    #[test]
    fn v2_database_gets_the_oauth_tables_and_is_snapshotted_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openbase.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
            migrate_with(&conn, &MIGRATIONS[..2], None).unwrap();
            conn.execute_batch(
                "INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
                     VALUES ('u1', 'a@example.com', 'A', '!', 1, 1);",
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        drop(db);
        let files = snapshots(&dir.path().join("backups"));
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].starts_with("pre-migration-v2-"));
        assert_eq!(file_schema_version(&path).unwrap(), schema_version());
        let conn = Connection::open(&path).unwrap();
        for table in [
            "oauth_clients",
            "oauth_requests",
            "oauth_codes",
            "oauth_grants",
            "oauth_tokens",
        ] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table}");
        }
        let users: i64 = conn
            .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
            .unwrap();
        assert_eq!(users, 1, "existing data is kept");
    }

    #[test]
    fn v3_database_gets_the_passkey_tables_and_is_snapshotted_first() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openbase.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
            migrate_with(&conn, &MIGRATIONS[..3], None).unwrap();
            conn.execute_batch(
                "INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
                     VALUES ('u1', 'a@example.com', 'A', '!', 1, 1);
                 INSERT INTO oauth_clients (id, source, name, redirect_uris, created_at)
                     VALUES ('c1', 'dcr', 'App', '[]', 1);",
            )
            .unwrap();
        }
        assert_eq!(file_schema_version(&path).unwrap(), 3);
        let db = Db::open(&path).unwrap();
        drop(db);
        let files = snapshots(&dir.path().join("backups"));
        assert_eq!(files.len(), 1, "{files:?}");
        assert!(files[0].starts_with("pre-migration-v3-"));
        assert_eq!(file_schema_version(&path).unwrap(), schema_version());
        // The snapshot is the v3 database, without the new tables.
        let snap = Connection::open(dir.path().join("backups").join(&files[0])).unwrap();
        let has = |c: &Connection, t: &str| -> i64 {
            c.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = ?1",
                [t],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(has(&snap, "passkeys"), 0);
        assert_eq!(has(&snap, "oauth_clients"), 1);

        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        for table in ["passkeys", "passkey_user_handles"] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table}");
        }
        // Existing data is intact.
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(count("SELECT count(*) FROM users"), 1);
        assert_eq!(count("SELECT count(*) FROM oauth_clients"), 1);
        // The new tables work, and are tied to the user.
        conn.execute_batch(
            "INSERT INTO passkey_user_handles (user_id, handle) VALUES ('u1', x'00112233445566778899aabbccddeeff');
             INSERT INTO passkeys (id, user_id, credential_id, credential, name, created_at)
                 VALUES ('pky1', 'u1', 'cred1', '{}', 'Laptop', 1);",
        )
        .unwrap();
        assert!(
            conn.execute(
                "INSERT INTO passkeys (id, user_id, credential_id, credential, name, created_at)
                 VALUES ('pky2', 'u1', 'cred1', '{}', 'Same credential', 1)",
                [],
            )
            .is_err(),
            "a credential id is unique"
        );
        assert!(
            conn.execute(
                "INSERT INTO passkeys (id, user_id, credential_id, credential, name, created_at)
                 VALUES ('pky3', 'nobody', 'cred3', '{}', 'Orphan', 1)",
                [],
            )
            .is_err(),
            "a passkey needs its user"
        );
        conn.execute("DELETE FROM users WHERE id = 'u1'", [])
            .unwrap();
        assert_eq!(count("SELECT count(*) FROM passkeys"), 0);
        assert_eq!(count("SELECT count(*) FROM passkey_user_handles"), 0);
        // Migrating again is a no-op.
        migrate(&conn).unwrap();
    }

    #[test]
    fn v4_base_members_and_base_invites_become_workspace_base_access() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate_with(&conn, &MIGRATIONS[..4], None).unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES
                 ('owner', 'o@example.com', 'O', '!', 1, 1),
                 ('guest', 'g@example.com', 'G', '!', 1, 1),
                 ('double', 'd@example.com', 'D', '!', 1, 1),
                 ('bowner', 'b@example.com', 'B', '!', 1, 1),
                 ('trashed', 't@example.com', 'T', '!', 1, 1),
                 ('gone', 'x@example.com', 'X', '!', 1, 1);
             INSERT INTO workspaces (id, name, created_at, deleted_at) VALUES
                 ('w1', 'One', 1, NULL), ('w2', 'Two', 1, NULL), ('w3', 'Gone', 1, 7);
             INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES
                 ('w1', 'owner', 'owner', 1), ('w2', 'owner', 'owner', 1),
                 ('w3', 'owner', 'owner', 1),
                 ('w1', 'double', 'viewer', 1);
             INSERT INTO bases (id, workspace_id, name, created_at, deleted_at) VALUES
                 ('b1', 'w1', 'CRM', 1, NULL), ('b2', 'w1', 'Ops', 1, NULL),
                 ('b3', 'w2', 'Other', 1, NULL), ('b4', 'w1', 'Unshared', 1, NULL),
                 ('b5', 'w1', 'Trashed', 1, 7), ('b6', 'w3', 'In trashed', 1, NULL);
             -- base-only member of two bases of w1, plus a double member
             INSERT INTO base_members (base_id, user_id, role, created_at) VALUES
                 ('b1', 'guest', 'viewer', 5), ('b2', 'guest', 'editor', 3),
                 ('b1', 'double', 'creator', 1),
                 ('b3', 'bowner', 'owner', 1),
                 -- trashed bases: their own members, and a higher role for guest
                 ('b5', 'trashed', 'editor', 1), ('b6', 'gone', 'editor', 1),
                 ('b5', 'guest', 'owner', 1);
             INSERT INTO invites (id, token_hash, workspace_id, base_id, role, created_at, expires_at, accepted_at)
                 VALUES ('i1', 'h1', NULL, 'b1', 'editor', 1, 9999999999999, NULL),
                        ('i2', 'h2', NULL, 'b3', 'owner', 1, 9999999999999, NULL),
                        ('i3', 'h3', NULL, 'b2', 'viewer', 1, 9999999999999, 2),
                        ('i4', 'h4', 'w1', NULL, 'viewer', 1, 9999999999999, NULL),
                        ('i5', 'h5', NULL, 'b5', 'viewer', 1, 9999999999999, NULL),
                        ('i6', 'h6', NULL, 'b6', 'viewer', 1, 9999999999999, NULL);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(schema_version(), 10);

        let member = |ws: &str, user: &str| -> (String, bool, Vec<String>) {
            let (role, all): (String, bool) = conn
                .query_row(
                    "SELECT role, all_bases FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2",
                    [ws, user],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT base_id FROM workspace_member_bases
                     WHERE workspace_id = ?1 AND user_id = ?2 ORDER BY base_id",
                )
                .unwrap();
            let bases = stmt
                .query_map([ws, user], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap();
            (role, all, bases)
        };
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // Base-only member: highest role, limited to the live bases they had
        // (the trashed base's owner role neither counts nor stays listed).
        assert_eq!(
            member("w1", "guest"),
            ("editor".into(), false, s(&["b1", "b2"]))
        );
        // Already a workspace member: keeps the workspace role on all bases;
        // the single-base raise to creator is dropped, not widened.
        assert_eq!(member("w1", "double"), ("viewer".into(), true, s(&[])));
        // A single-base owner becomes a limited creator, not a workspace owner.
        assert_eq!(
            member("w2", "bowner"),
            ("creator".into(), false, s(&["b3"]))
        );
        assert_eq!(member("w1", "owner"), ("owner".into(), true, s(&[])));
        // Only on a trashed base, or a base of a trashed workspace: no member.
        let memberships = |u: &str| -> i64 {
            conn.query_row(
                "SELECT count(*) FROM workspace_members WHERE user_id = ?1",
                [u],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(memberships("trashed"), 0);
        assert_eq!(memberships("gone"), 0);
        let role = |u: &str, b: &str| crate::perm::base_role(&conn, u, b).unwrap();
        use crate::perm::Role;
        assert_eq!(role("guest", "b1"), Some(Role::Editor));
        assert_eq!(role("guest", "b4"), None);
        assert_eq!(role("double", "b1"), Some(Role::Viewer));
        assert_eq!(role("double", "b4"), Some(Role::Viewer));
        assert_eq!(role("bowner", "b3"), Some(Role::Creator));
        // Restoring the trashed base does not bring the old access back.
        conn.execute("UPDATE bases SET deleted_at = NULL WHERE id = 'b5'", [])
            .unwrap();
        assert_eq!(role("guest", "b5"), None);
        assert_eq!(role("trashed", "b5"), None);

        // Base invites became workspace invites limited to their base.
        let invite = |id: &str| -> (Option<String>, Option<String>, String, bool, Vec<String>) {
            let row: (Option<String>, Option<String>, String, bool) = conn
                .query_row(
                    "SELECT workspace_id, base_id, role, all_bases FROM invites WHERE id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .unwrap();
            let mut stmt = conn
                .prepare("SELECT base_id FROM invite_bases WHERE invite_id = ?1")
                .unwrap();
            let bases = stmt
                .query_map([id], |r| r.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap();
            (row.0, row.1, row.2, row.3, bases)
        };
        let w = |x: &str| Some(x.to_string());
        assert_eq!(
            invite("i1"),
            (w("w1"), None, "editor".into(), false, s(&["b1"]))
        );
        assert_eq!(
            invite("i2"),
            (w("w2"), None, "creator".into(), false, s(&["b3"]))
        );
        assert_eq!(
            invite("i3"),
            (w("w1"), None, "viewer".into(), false, s(&["b2"]))
        );
        assert_eq!(invite("i4"), (w("w1"), None, "viewer".into(), true, s(&[])));
        // Invites to a trashed base or a base of a trashed workspace are gone.
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            count("SELECT count(*) FROM invites WHERE id IN ('i5', 'i6')"),
            0
        );

        assert_eq!(
            count("SELECT count(*) FROM sqlite_master WHERE name = 'base_members'"),
            0
        );
        assert_eq!(count("SELECT count(*) FROM users WHERE intro_seen = 0"), 6);
        assert_eq!(count("SELECT count(*) FROM pragma_foreign_key_check"), 0);
        // Leaving a workspace takes the base list with it.
        conn.execute(
            "DELETE FROM workspace_members WHERE workspace_id = 'w1' AND user_id = 'guest'",
            [],
        )
        .unwrap();
        assert_eq!(
            count("SELECT count(*) FROM workspace_member_bases WHERE user_id = 'guest'"),
            0
        );
        migrate(&conn).unwrap();
    }

    #[test]
    fn v5_workspaces_are_coloured_in_creation_order_per_creator() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate_with(&conn, &MIGRATIONS[..5], None).unwrap();
        let mut sql = String::from(
            "INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES
                 ('a', 'a@example.com', 'A', '!', 1, 1), ('b', 'b@example.com', 'B', '!', 1, 1);
             INSERT INTO workspaces (id, name, created_by, created_at, deleted_at) VALUES
                 ('b1', 'B first', 'b', 1, NULL), ('orphan', 'No creator', NULL, 1, NULL)",
        );
        // Out of id order on purpose: creation time decides. Nine of them, so
        // the ninth wraps around to the first colour.
        for i in 0..9 {
            sql.push_str(&format!(", ('a{}', 'A {i}', 'a', {}, NULL)", 9 - i, 10 + i));
        }
        conn.execute_batch(&format!("{sql};")).unwrap();
        migrate(&conn).unwrap();
        let color = |id: &str| -> String {
            conn.query_row("SELECT color FROM workspaces WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        let a: Vec<String> = (0..9).map(|i| color(&format!("a{}", 9 - i))).collect();
        let mut expected: Vec<&str> = crate::store::workspaces::DEFAULT_COLORS.to_vec();
        expected.push("green");
        assert_eq!(a, expected);
        assert_eq!(color("b1"), "green");
        assert_eq!(color("orphan"), "green");
        migrate(&conn).unwrap();
    }

    #[test]
    fn v6_invites_may_not_raise_existing_members_after_the_upgrade() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        migrate_with(&conn, &MIGRATIONS[..6], None).unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, email, name, password_hash, created_at, updated_at)
                 VALUES ('owner', 'o@example.com', 'O', '!', 1, 1);
             INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'One', 1);
             INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
                 VALUES ('w1', 'owner', 'owner', 1);
             INSERT INTO invites (id, token_hash, workspace_id, role, created_by, created_at, expires_at)
                 VALUES ('i1', 'h1', 'w1', 'editor', 'owner', 1, 9999999999999);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        assert_eq!(schema_version(), 10);
        let flag = |id: &str| -> bool {
            conn.query_row(
                "SELECT may_raise_roles FROM invites WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(!flag("i1"), "who set its terms, and how, was not recorded");
        conn.execute(
            "INSERT INTO invites (id, token_hash, workspace_id, role, created_at, expires_at)
             VALUES ('i2', 'h2', 'w1', 'viewer', 1, 9999999999999)",
            [],
        )
        .unwrap();
        assert!(!flag("i2"), "off unless set");
        migrate(&conn).unwrap();
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
        let db = Db::open(&dir.path().join("openbase.db")).unwrap();
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

    #[test]
    fn kanban_description_moves_to_the_view() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        v1_database(&conn, None);
        migrate_with(&conn, &MIGRATIONS[..7], None).unwrap();
        conn.execute_batch(
            r#"INSERT INTO views (id, table_id, name, type, config, created_at) VALUES
                 ('v1', 't1', 'Board', 'kanban', '{"kanban":{"stack_field_id":"f2","description_field_id":"f3"}}', 1),
                 ('v2', 't1', 'Bare', 'kanban', '{"kanban":{"stack_field_id":"f2","description_field_id":null}}', 1),
                 ('v3', 't1', 'Grid', 'grid', '{}', 1);"#,
        )
        .unwrap();
        migrate(&conn).unwrap();
        let config = |id: &str| -> serde_json::Value {
            let raw: String = conn
                .query_row("SELECT config FROM views WHERE id = ?1", [id], |r| r.get(0))
                .unwrap();
            serde_json::from_str(&raw).unwrap()
        };
        assert_eq!(
            config("v1"),
            serde_json::json!({"kanban": {"stack_field_id": "f2"}, "description_field_id": "f3"})
        );
        assert_eq!(
            config("v2"),
            serde_json::json!({"kanban": {"stack_field_id": "f2"}})
        );
        assert_eq!(config("v3"), serde_json::json!({}));
    }
}
