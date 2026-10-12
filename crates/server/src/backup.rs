//! Backups: a `.tar.gz` holding a consistent database snapshot (`VACUUM INTO`),
//! the attachments directory and a `manifest.json`.
//!
//! Archive layout:
//!
//! ```text
//! manifest.json              {app_version, schema_version, created_at}
//! opengrid.db                consistent snapshot of the database
//! attachments/<aa>/<sha256>  content-addressed files (+ <sha256>.thumb.png)
//! ```
//!
//! File names in `<data_dir>/backups`:
//! - `opengrid-YYYYmmdd-HHMMSS.tar.gz`: manual backups (CLI, admin "create now");
//!   never pruned automatically.
//! - `opengrid-auto-YYYYmmdd-HHMMSS.tar.gz`: daily automatic backups; only these
//!   are pruned to `backup_keep`.
//! - `pre-migration-vN-YYYYmmdd-HHMMSS.db`: raw database snapshots taken before
//!   a schema upgrade (see [`crate::db`]).
//!
//! Timestamps in names are UTC. Archives are written to a hidden `.partial`
//! file and renamed into place, so a crash never leaves a truncated backup
//! under a valid name.

use std::fs::File;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use og_core::api::auth::BackupInfo;
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Name of the manifest entry in an archive.
pub const MANIFEST: &str = "manifest.json";
const DB_ENTRY: &str = "opengrid.db";
const ATTACHMENTS_ENTRY: &str = "attachments";
const AUTO_PREFIX: &str = "opengrid-auto-";

static BACKUP_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:opengrid-(?:auto-)?[0-9]{8}-[0-9]{6}\.tar\.gz|pre-migration-v[0-9]{1,6}-[0-9]{8}-[0-9]{6}(?:-[0-9]{1,4})?\.db)$",
    )
    .expect("valid regex")
});
static AUTO_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^opengrid-auto-[0-9]{8}-[0-9]{6}\.tar\.gz$").expect("valid regex")
});
static NAME_TS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9]{8}-[0-9]{6})").expect("valid regex"));

/// Contents of `manifest.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub app_version: String,
    pub schema_version: i64,
    /// RFC 3339, UTC.
    pub created_at: String,
}

/// Whether `name` is a backup file name OpenGrid creates (strict: this is the
/// path-traversal guard for the download endpoint).
pub fn is_backup_name(name: &str) -> bool {
    BACKUP_NAME.is_match(name)
}

fn is_automatic_name(name: &str) -> bool {
    AUTO_NAME.is_match(name)
}

fn timestamp() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string()
}

fn io_err(what: &str, path: &Path, e: io::Error) -> AppError {
    AppError::internal(format!("{what} {}: {e}", path.display()))
}

/// Deletes a file or directory when dropped (cleanup on every error path).
struct TempPath(PathBuf);

impl Drop for TempPath {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = std::fs::remove_dir_all(&self.0);
        } else {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// Write a manual backup to `out`, or to
/// `<data_dir>/backups/opengrid-<timestamp>.tar.gz` when `out` is None.
/// Blocking; call from `spawn_blocking` in async code.
pub fn create(state: &AppState, out: Option<&Path>) -> AppResult<PathBuf> {
    let path = match out {
        Some(p) => p.to_path_buf(),
        None => state
            .config
            .backups_dir()
            .join(format!("opengrid-{}.tar.gz", timestamp())),
    };
    write_archive(state, &path)?;
    Ok(path)
}

/// Write an automatic backup (`opengrid-auto-<timestamp>.tar.gz`) and prune
/// old automatic backups beyond `config.backup_keep`.
pub fn create_automatic(state: &AppState) -> AppResult<PathBuf> {
    let dir = state.config.backups_dir();
    let path = dir.join(format!("{AUTO_PREFIX}{}.tar.gz", timestamp()));
    write_archive(state, &path)?;
    let removed = prune(&dir, state.config.backup_keep)?;
    for p in removed {
        tracing::info!(path = %p.display(), "pruned old automatic backup");
    }
    Ok(path)
}

fn write_archive(state: &AppState, path: &Path) -> AppResult<()> {
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    std::fs::create_dir_all(&dir).map_err(|e| io_err("cannot create", &dir, e))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::bad_request("backup output path has no file name"))?
        .to_string_lossy()
        .into_owned();
    let suffix = crate::ids::new_id("");

    // 1. Consistent database snapshot.
    let snapshot = TempPath(dir.join(format!(".snapshot-{suffix}.db")));
    state.db.snapshot_to(&snapshot.0)?;

    // 2. Archive into a hidden partial file.
    let partial = TempPath(dir.join(format!(".{file_name}.{suffix}.partial")));
    let file = File::create(&partial.0).map_err(|e| io_err("cannot create", &partial.0, e))?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    tar.mode(tar::HeaderMode::Deterministic);
    tar.follow_symlinks(false);

    let manifest = Manifest {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: crate::db::schema_version(),
        created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    };
    let manifest = serde_json::to_vec_pretty(&manifest)?;
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(chrono::Utc::now().timestamp().max(0) as u64);
    header.set_cksum();
    let archive_err = |e: io::Error| AppError::internal(format!("writing backup archive: {e}"));
    tar.append_data(&mut header, MANIFEST, manifest.as_slice())
        .map_err(archive_err)?;

    let mut db_file =
        File::open(&snapshot.0).map_err(|e| io_err("cannot open snapshot", &snapshot.0, e))?;
    tar.append_file(DB_ENTRY, &mut db_file)
        .map_err(archive_err)?;
    drop(db_file);

    append_attachments(
        &mut tar,
        &state.config.attachments_dir(),
        Path::new(ATTACHMENTS_ENTRY),
    )?;

    let gz = tar.into_inner().map_err(archive_err)?;
    let file = gz.finish().map_err(archive_err)?;
    file.sync_all().map_err(archive_err)?;
    drop(file);

    // 3. Atomically publish under the final name.
    std::fs::rename(&partial.0, path).map_err(|e| io_err("cannot write", path, e))?;
    std::mem::forget(partial);
    Ok(())
}

/// Recursively add regular files under `dir` as `prefix/...`. Attachment files
/// are immutable, but may be deleted (garbage collection) while we copy:
/// files that vanish are skipped. Hidden entries and symlinks are skipped.
fn append_attachments<W: Write>(
    tar: &mut tar::Builder<W>,
    dir: &Path,
    prefix: &Path,
) -> AppResult<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err("cannot read", dir, e)),
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_err("cannot read", dir, e)),
        };
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_err("cannot stat", &path, e)),
        };
        let archive_path = prefix.join(&name);
        if meta.is_dir() {
            append_attachments(tar, &path, &archive_path)?;
        } else if meta.is_file() {
            let mut f = match File::open(&path) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(io_err("cannot open", &path, e)),
            };
            tar.append_file(&archive_path, &mut f)
                .map_err(|e| AppError::internal(format!("writing backup archive: {e}")))?;
        }
    }
    Ok(())
}

/// Delete automatic backups beyond the newest `keep` (at least one is always
/// kept). Other files in the directory are never touched. Returns the paths
/// removed.
pub fn prune(dir: &Path, keep: usize) -> AppResult<Vec<PathBuf>> {
    let mut autos: Vec<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| is_automatic_name(n))
            .collect(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err("cannot read", dir, e)),
    };
    // Fixed-width UTC timestamps: lexicographic order is chronological.
    autos.sort_unstable_by(|a, b| b.cmp(a));
    let mut removed = Vec::new();
    for name in autos.into_iter().skip(keep.max(1)) {
        let p = dir.join(&name);
        match std::fs::remove_file(&p) {
            Ok(()) => removed.push(p),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err("cannot delete", &p, e)),
        }
    }
    Ok(removed)
}

/// Creation time (ms since epoch, from the UTC timestamp in the name).
fn name_time_ms(name: &str) -> Option<i64> {
    let ts = NAME_TS.captures(name)?.get(1)?.as_str();
    let t = chrono::NaiveDateTime::parse_from_str(ts, "%Y%m%d-%H%M%S").ok()?;
    Some(t.and_utc().timestamp_millis())
}

/// Backups in `dir` (archives and pre-migration snapshots), newest first.
pub fn list(dir: &Path) -> AppResult<Vec<BackupInfo>> {
    let rd = match std::fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err("cannot read", dir, e)),
    };
    let mut out = Vec::new();
    for entry in rd.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_backup_name(&name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let created_at = name_time_ms(&name).unwrap_or_else(|| {
            meta.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });
        out.push(BackupInfo {
            name,
            size: meta.len(),
            created_at,
        });
    }
    out.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.name.cmp(&a.name))
    });
    Ok(out)
}

/// Time of the newest automatic backup in `dir`, in ms since epoch.
pub fn last_automatic_backup_ms(dir: &Path) -> Option<i64> {
    std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| is_automatic_name(n))
        .filter_map(|n| name_time_ms(&n))
        .max()
}

/// Restore `archive` into `config.data_dir`. **The server must be stopped.**
///
/// Steps: refuse if the database's WAL file is non-empty (a running server, or
/// one that crashed: start and stop it once to checkpoint) unless `force`;
/// refuse to replace an existing database unless `force`; extract into a temp
/// directory inside the data dir with strict path checks; validate the
/// manifest, schema version and database; move the old database aside to
/// `opengrid.db.pre-restore-<ts>` (with its WAL, so nothing is lost); move the
/// new database in; merge attachments (existing files are kept, since they are
/// content-addressed).
pub fn restore(config: &Config, archive: &Path, force: bool) -> AppResult<()> {
    let db_path = config.db_path();
    let wal = sidecar(&db_path, "-wal");
    let shm = sidecar(&db_path, "-shm");
    let wal_len = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
    if wal_len > 0 && !force {
        return Err(AppError::conflict(format!(
            "{} is not empty, so OpenGrid looks like it is still running: stop the server first \
             (use --force only if you are sure it is stopped)",
            wal.display()
        )));
    }
    if db_path.exists() && !force {
        return Err(AppError::conflict(format!(
            "a database already exists at {}; pass --force to replace it \
             (the current database is kept as opengrid.db.pre-restore-<timestamp>)",
            db_path.display()
        )));
    }

    let file = File::open(archive).map_err(|e| {
        AppError::bad_request(format!("cannot open archive {}: {e}", archive.display()))
    })?;
    std::fs::create_dir_all(&config.data_dir)
        .map_err(|e| io_err("cannot create", &config.data_dir, e))?;
    let tmp = TempPath(
        config
            .data_dir
            .join(format!(".restore-{}", crate::ids::new_id(""))),
    );
    std::fs::create_dir(&tmp.0).map_err(|e| io_err("cannot create", &tmp.0, e))?;

    extract(file, &tmp.0)?;
    validate_extracted(&tmp.0)?;

    // Commit phase: old database aside, new one in, attachments merged.
    let ts = timestamp();
    if db_path.exists() {
        let mut aside = sidecar(&db_path, &format!(".pre-restore-{ts}"));
        let mut n = 1;
        while aside.exists() {
            aside = sidecar(&db_path, &format!(".pre-restore-{ts}-{n}"));
            n += 1;
        }
        std::fs::rename(&db_path, &aside).map_err(|e| io_err("cannot move", &db_path, e))?;
        if wal.exists() {
            // SQLite finds `<file>-wal` next to the database, so the set-aside
            // copy stays complete.
            let aside_wal = sidecar(&aside, "-wal");
            std::fs::rename(&wal, &aside_wal).map_err(|e| io_err("cannot move", &wal, e))?;
        }
        tracing::info!(path = %aside.display(), "previous database kept");
    }
    for stale in [&wal, &shm] {
        match std::fs::remove_file(stale) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err("cannot remove", stale, e)),
        }
    }
    let new_db = tmp.0.join(DB_ENTRY);
    std::fs::rename(&new_db, &db_path).map_err(|e| io_err("cannot move", &new_db, e))?;
    merge_dir(&tmp.0.join(ATTACHMENTS_ENTRY), &config.attachments_dir())?;
    Ok(())
}

/// `path` with `suffix` appended to its file name.
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Extract the archive into `dest`, accepting only `manifest.json`,
/// `opengrid.db` and regular files/directories under `attachments/`. Any
/// absolute path, `..` component, link or special file aborts the restore.
fn extract(file: File, dest: &Path) -> AppResult<()> {
    let bad = |e: io::Error| AppError::bad_request(format!("cannot read backup archive: {e}"));
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(io::BufReader::new(file)));
    for entry in ar.entries().map_err(bad)? {
        let mut entry = entry.map_err(bad)?;
        let kind = entry.header().entry_type();
        if matches!(
            kind,
            tar::EntryType::XGlobalHeader | tar::EntryType::XHeader
        ) {
            continue;
        }
        let raw = entry.path().map_err(bad)?.into_owned();
        let mut rel = PathBuf::new();
        for c in raw.components() {
            match c {
                Component::Normal(p) => rel.push(p),
                Component::CurDir => {}
                _ => {
                    return Err(AppError::bad_request(format!(
                        "unsafe path in backup archive: {}",
                        raw.display()
                    )));
                }
            }
        }
        if !matches!(kind, tar::EntryType::Regular | tar::EntryType::Directory) {
            return Err(AppError::bad_request(format!(
                "entry type {kind:?} is not allowed in a backup archive ({})",
                raw.display()
            )));
        }
        let mut comps = rel.components();
        let top = comps
            .next()
            .map(|c| c.as_os_str().to_string_lossy().into_owned());
        let wanted = match top.as_deref() {
            Some(MANIFEST) | Some(DB_ENTRY) => {
                comps.next().is_none() && kind == tar::EntryType::Regular
            }
            Some(ATTACHMENTS_ENTRY) => true,
            _ => false,
        };
        if !wanted {
            tracing::warn!(path = %raw.display(), "ignoring unexpected entry in backup archive");
            continue;
        }
        let out = dest.join(&rel);
        if kind == tar::EntryType::Directory {
            std::fs::create_dir_all(&out).map_err(|e| io_err("cannot create", &out, e))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("cannot create", parent, e))?;
        }
        let mut f = File::create(&out).map_err(|e| io_err("cannot create", &out, e))?;
        io::copy(&mut entry, &mut f).map_err(bad)?;
        f.sync_all().map_err(|e| io_err("cannot write", &out, e))?;
    }
    Ok(())
}

fn validate_extracted(dir: &Path) -> AppResult<()> {
    let manifest_path = dir.join(MANIFEST);
    let raw = std::fs::read(&manifest_path).map_err(|_| {
        AppError::bad_request("archive has no manifest.json; is this an OpenGrid backup?")
    })?;
    let manifest: Manifest = serde_json::from_slice(&raw)
        .map_err(|e| AppError::bad_request(format!("invalid manifest.json in archive: {e}")))?;
    let supported = crate::db::schema_version();
    if manifest.schema_version > supported {
        return Err(AppError::bad_request(format!(
            "backup schema version {} is newer than this OpenGrid supports ({supported}); \
             upgrade OpenGrid (to at least {}) before restoring",
            manifest.schema_version, manifest.app_version
        )));
    }
    let db = dir.join(DB_ENTRY);
    if !db.is_file() {
        return Err(AppError::bad_request("archive has no opengrid.db"));
    }
    let invalid =
        |e: rusqlite::Error| AppError::bad_request(format!("backup database is invalid: {e}"));
    let conn =
        rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(invalid)?;
    let check: String = conn
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(invalid)?;
    if check != "ok" {
        return Err(AppError::bad_request(format!(
            "backup database is corrupt: {check}"
        )));
    }
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(invalid)?;
    if version != manifest.schema_version {
        return Err(AppError::bad_request(format!(
            "backup database schema version {version} does not match its manifest ({})",
            manifest.schema_version
        )));
    }
    Ok(())
}

/// Move every file under `src` into `dest` (same relative path) unless a file
/// already exists there.
fn merge_dir(src: &Path, dest: &Path) -> AppResult<()> {
    let rd = match std::fs::read_dir(src) {
        Ok(rd) => rd,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(io_err("cannot read", src, e)),
    };
    std::fs::create_dir_all(dest).map_err(|e| io_err("cannot create", dest, e))?;
    for entry in rd {
        let entry = entry.map_err(|e| io_err("cannot read", src, e))?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&from).map_err(|e| io_err("cannot stat", &from, e))?;
        if meta.is_dir() {
            merge_dir(&from, &to)?;
        } else if meta.is_file() && !to.exists() {
            std::fs::rename(&from, &to).map_err(|e| io_err("cannot move", &from, e))?;
        }
    }
    Ok(())
}
