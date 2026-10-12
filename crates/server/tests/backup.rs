//! Backup archives: create, restore, validation and retention.

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};

use common::TestApp;
use opengrid::backup;
use opengrid::config::Config;
use opengrid::state::AppState;

const BLOB_SHA: &str = "ab0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";

/// Put a user row and an attachment blob into the app's data dir.
fn seed(app: &TestApp) -> PathBuf {
    app.user("alice@example.com", "Alice");
    let dir = app.state.config.attachments_dir().join(&BLOB_SHA[..2]);
    std::fs::create_dir_all(&dir).unwrap();
    let blob = dir.join(BLOB_SHA);
    std::fs::write(&blob, b"attachment bytes").unwrap();
    blob
}

fn user_count(state: &AppState, email: &str) -> i64 {
    let email = email.to_string();
    state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT count(*) FROM users WHERE email = ?1",
                [email],
                |r| r.get(0),
            )?)
        })
        .unwrap()
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

/// Entries (path, bytes) of a .tar.gz archive.
fn archive_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let f = std::fs::File::open(path).unwrap();
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(f));
    let mut out = Vec::new();
    for e in ar.entries().unwrap() {
        let mut e = e.unwrap();
        let p = e.path().unwrap().to_string_lossy().into_owned();
        let mut buf = Vec::new();
        std::io::Read::read_to_end(&mut e, &mut buf).unwrap();
        out.push((p, buf));
    }
    out
}

/// Build a .tar.gz with raw entries; names are written verbatim into the
/// header (bypassing the tar crate's own path checks) so tests can craft
/// malicious archives.
fn raw_archive(path: &Path, entries: &[RawEntry]) {
    let f = std::fs::File::create(path).unwrap();
    let gz = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
    let mut b = tar::Builder::new(gz);
    for (name, data, kind) in entries {
        let mut h = tar::Header::new_old();
        let bytes = name.as_bytes();
        h.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_entry_type(*kind);
        if *kind == tar::EntryType::Symlink {
            h.set_link_name("/etc/passwd").unwrap();
        }
        h.set_cksum();
        b.append(&h, *data).unwrap();
    }
    b.into_inner().unwrap().finish().unwrap().flush().unwrap();
}

type RawEntry<'a> = (&'a str, &'a [u8], tar::EntryType);

fn manifest(schema_version: i64) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "app_version": "0.1.0",
        "schema_version": schema_version,
        "created_at": "2026-10-12T00:00:00Z",
    }))
    .unwrap()
}

/// A valid database file at the current schema, as bytes.
fn valid_db_bytes() -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("x.db");
    let conn = rusqlite::Connection::open(&p).unwrap();
    opengrid::db::migrate(&conn).unwrap();
    drop(conn);
    std::fs::read(p).unwrap()
}

#[test]
fn create_writes_archive_with_manifest_db_and_attachments() {
    let app = TestApp::new();
    seed(&app);
    let path = backup::create(&app.state, None).unwrap();
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(backup::is_backup_name(&name), "{name}");
    assert!(name.starts_with("opengrid-") && name.ends_with(".tar.gz"));
    assert_eq!(path.parent().unwrap(), app.state.config.backups_dir());

    let entries = archive_entries(&path);
    let names: Vec<&str> = entries.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(names[0], "manifest.json", "{names:?}");
    assert!(names.contains(&"opengrid.db"));
    let blob_entry = format!("attachments/{}/{}", &BLOB_SHA[..2], BLOB_SHA);
    let blob = entries.iter().find(|(p, _)| *p == blob_entry).unwrap();
    assert_eq!(blob.1, b"attachment bytes");

    let m: serde_json::Value = serde_json::from_slice(&entries[0].1).unwrap();
    assert_eq!(m["schema_version"], opengrid::db::schema_version());
    assert_eq!(m["app_version"], env!("CARGO_PKG_VERSION"));
    assert!(m["created_at"].as_str().unwrap().contains('T'));

    // No temp files are left behind.
    let leftovers: Vec<String> = files_in(&app.state.config.backups_dir())
        .into_iter()
        .filter(|f| f.contains("partial") || f.starts_with('.'))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn create_honours_explicit_output_path() {
    let app = TestApp::new();
    let out_dir = tempfile::tempdir().unwrap();
    let out = out_dir.path().join("mine.tar.gz");
    let written = backup::create(&app.state, Some(&out)).unwrap();
    assert_eq!(written, out);
    assert!(out.exists());
    assert_eq!(files_in(out_dir.path()), vec!["mine.tar.gz".to_string()]);
}

#[test]
fn backup_restore_round_trip_into_fresh_dir() {
    let app = TestApp::new();
    seed(&app);
    let archive = backup::create(&app.state, None).unwrap();

    let target = tempfile::tempdir().unwrap();
    let config = Config::for_tests(target.path());
    backup::restore(&config, &archive, false).unwrap();

    let restored_blob = config.attachments_dir().join(&BLOB_SHA[..2]).join(BLOB_SHA);
    assert_eq!(std::fs::read(restored_blob).unwrap(), b"attachment bytes");
    // No leftover temp directories in the data dir.
    let names = files_in(target.path());
    assert!(
        names.iter().all(|n| !n.starts_with(".restore")),
        "{names:?}"
    );

    let state = AppState::open(config).unwrap();
    assert_eq!(user_count(&state, "alice@example.com"), 1);
}

#[test]
fn restore_refuses_existing_database_without_force_and_keeps_it_with_force() {
    let source = TestApp::new();
    seed(&source);
    let archive = backup::create(&source.state, None).unwrap();

    let target = tempfile::tempdir().unwrap();
    let config = Config::for_tests(target.path());
    {
        let state = AppState::open(config.clone()).unwrap();
        state
            .db
            .write_sync(|tx| {
                tx.execute(
                    "INSERT INTO settings (key, value) VALUES ('marker', 'old')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
    }
    let err = backup::restore(&config, &archive, false).unwrap_err();
    assert!(err.to_string().contains("--force"), "{err}");

    backup::restore(&config, &archive, true).unwrap();
    let names = files_in(target.path());
    let aside: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with("opengrid.db.pre-restore-") && !n.ends_with("-wal"))
        .collect();
    assert_eq!(aside.len(), 1, "{names:?}");
    // The set-aside copy still holds the old data.
    let old = rusqlite::Connection::open(target.path().join(aside[0])).unwrap();
    let marker: String = old
        .query_row("SELECT value FROM settings WHERE key = 'marker'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(marker, "old");
    drop(old);

    let state = AppState::open(config).unwrap();
    assert_eq!(user_count(&state, "alice@example.com"), 1);
}

#[test]
fn restore_refuses_while_wal_is_non_empty() {
    let source = TestApp::new();
    let archive = backup::create(&source.state, None).unwrap();
    let target = tempfile::tempdir().unwrap();
    let config = Config::for_tests(target.path());
    std::fs::write(config.db_path(), b"").unwrap();
    std::fs::write(target.path().join("opengrid.db-wal"), b"pretend wal").unwrap();
    let err = backup::restore(&config, &archive, false).unwrap_err();
    assert!(err.to_string().contains("stop the server"), "{err}");
}

#[test]
fn restore_rejects_path_traversal_and_links() {
    let db = valid_db_bytes();
    let m = manifest(opengrid::db::schema_version());
    let cases: Vec<(&str, tar::EntryType)> = vec![
        ("../escaped", tar::EntryType::Regular),
        ("attachments/../../escaped", tar::EntryType::Regular),
        ("/tmp/opengrid-absolute-escape", tar::EntryType::Regular),
        ("attachments/link", tar::EntryType::Symlink),
    ];
    for (bad, kind) in cases {
        let work = tempfile::tempdir().unwrap();
        let data = work.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let archive = work.path().join("evil.tar.gz");
        raw_archive(
            &archive,
            &[
                ("manifest.json", &m, tar::EntryType::Regular),
                ("opengrid.db", &db, tar::EntryType::Regular),
                (bad, b"pwned", kind),
            ],
        );
        let config = Config::for_tests(&data);
        let err = backup::restore(&config, &archive, false).unwrap_err();
        assert!(
            err.to_string().contains("unsafe") || err.to_string().contains("not allowed"),
            "{bad}: {err}"
        );
        assert!(!work.path().join("escaped").exists(), "{bad}");
        assert!(
            !data.join("opengrid.db").exists(),
            "{bad}: nothing restored"
        );
        let names = files_in(&data);
        assert!(
            names.iter().all(|n| !n.starts_with(".restore")),
            "{names:?}"
        );
    }
    assert!(!Path::new("/tmp/opengrid-absolute-escape").exists());
}

#[test]
fn restore_rejects_newer_schema_and_missing_parts() {
    let db = valid_db_bytes();
    let newer = manifest(opengrid::db::schema_version() + 1);
    let ok = manifest(opengrid::db::schema_version());
    let cases: Vec<(&str, Vec<RawEntry>)> = vec![
        (
            "newer",
            vec![
                ("manifest.json", &newer, tar::EntryType::Regular),
                ("opengrid.db", &db, tar::EntryType::Regular),
            ],
        ),
        (
            "manifest",
            vec![("opengrid.db", &db, tar::EntryType::Regular)],
        ),
        (
            "opengrid.db",
            vec![("manifest.json", &ok, tar::EntryType::Regular)],
        ),
        (
            "manifest",
            vec![
                ("manifest.json", b"not json", tar::EntryType::Regular),
                ("opengrid.db", &db, tar::EntryType::Regular),
            ],
        ),
        (
            "database",
            vec![
                ("manifest.json", &ok, tar::EntryType::Regular),
                (
                    "opengrid.db",
                    b"definitely not sqlite",
                    tar::EntryType::Regular,
                ),
            ],
        ),
    ];
    for (expect, entries) in cases {
        let work = tempfile::tempdir().unwrap();
        let archive = work.path().join("a.tar.gz");
        raw_archive(&archive, &entries);
        let data = work.path().join("data");
        let config = Config::for_tests(&data);
        let err = backup::restore(&config, &archive, false).unwrap_err();
        assert!(
            err.to_string().contains(expect),
            "expected '{expect}' in: {err}"
        );
        assert!(!data.join("opengrid.db").exists());
    }
}

#[test]
fn restore_rejects_garbage_file() {
    let work = tempfile::tempdir().unwrap();
    let archive = work.path().join("a.tar.gz");
    std::fs::write(&archive, b"this is not a gzip file").unwrap();
    let config = Config::for_tests(&work.path().join("data"));
    assert!(backup::restore(&config, &archive, false).is_err());
    let missing = work.path().join("missing.tar.gz");
    assert!(backup::restore(&config, &missing, false).is_err());
}

#[test]
fn restore_merges_attachments_with_existing_ones() {
    let source = TestApp::new();
    seed(&source);
    let archive = backup::create(&source.state, None).unwrap();

    let target = tempfile::tempdir().unwrap();
    let config = Config::for_tests(target.path());
    let other = config.attachments_dir().join("cd").join("cdcd");
    std::fs::create_dir_all(other.parent().unwrap()).unwrap();
    std::fs::write(&other, b"existing").unwrap();
    backup::restore(&config, &archive, false).unwrap();
    assert_eq!(std::fs::read(&other).unwrap(), b"existing");
    assert!(
        config
            .attachments_dir()
            .join(&BLOB_SHA[..2])
            .join(BLOB_SHA)
            .exists()
    );
}

#[test]
fn automatic_backups_use_their_own_name_and_retention_keeps_newest_n() {
    let dir = tempfile::tempdir().unwrap();
    let names = [
        "opengrid-auto-20261001-030000.tar.gz",
        "opengrid-auto-20261002-030000.tar.gz",
        "opengrid-auto-20261003-030000.tar.gz",
        "opengrid-auto-20261004-030000.tar.gz",
        "opengrid-auto-20261005-030000.tar.gz",
        // Manual backups, snapshots and foreign files are never pruned.
        "opengrid-20260101-120000.tar.gz",
        "pre-migration-v1-20260101-120000.db",
        "notes.txt",
    ];
    for n in names {
        std::fs::write(dir.path().join(n), b"x").unwrap();
    }
    let removed = backup::prune(dir.path(), 3).unwrap();
    assert_eq!(removed.len(), 2);
    assert_eq!(
        files_in(dir.path()),
        vec![
            "notes.txt",
            "opengrid-20260101-120000.tar.gz",
            "opengrid-auto-20261003-030000.tar.gz",
            "opengrid-auto-20261004-030000.tar.gz",
            "opengrid-auto-20261005-030000.tar.gz",
            "pre-migration-v1-20260101-120000.db",
        ]
    );
    // keep = 0 still keeps the newest one: never delete every backup.
    backup::prune(dir.path(), 0).unwrap();
    let left: Vec<String> = files_in(dir.path())
        .into_iter()
        .filter(|n| n.starts_with("opengrid-auto-"))
        .collect();
    assert_eq!(left, vec!["opengrid-auto-20261005-030000.tar.gz"]);
}

#[test]
fn create_automatic_names_and_prunes() {
    let app = TestApp::with_config(|c| c.backup_keep = 2);
    let dir = app.state.config.backups_dir();
    for d in ["20200101", "20200102", "20200103"] {
        std::fs::write(dir.join(format!("opengrid-auto-{d}-030000.tar.gz")), b"x").unwrap();
    }
    let path = backup::create_automatic(&app.state).unwrap();
    let name = path.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("opengrid-auto-"), "{name}");
    let autos: Vec<String> = files_in(&dir)
        .into_iter()
        .filter(|n| n.starts_with("opengrid-auto-"))
        .collect();
    assert_eq!(autos.len(), 2, "{autos:?}");
    assert!(autos.contains(&name));
}

#[test]
fn backup_names_are_validated_strictly() {
    for ok in [
        "opengrid-20261012-030000.tar.gz",
        "opengrid-auto-20261012-030000.tar.gz",
        "pre-migration-v1-20261012-030000.db",
        "pre-migration-v12-20261012-030000-2.db",
    ] {
        assert!(backup::is_backup_name(ok), "{ok}");
    }
    for bad in [
        "",
        "..",
        "../opengrid-20261012-030000.tar.gz",
        "opengrid-20261012-030000.tar.gz/..",
        "opengrid.db",
        "opengrid-2026101-030000.tar.gz",
        "opengrid-20261012-030000.tar.gz.partial",
        ".opengrid-20261012-030000.tar.gz",
        "opengrid-20261012-030000.TAR.GZ",
        "pre-migration-v-20261012-030000.db",
        "opengrid-２0261012-030000.tar.gz",
    ] {
        assert!(!backup::is_backup_name(bad), "{bad}");
    }
}

#[test]
fn list_returns_backups_newest_first() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("opengrid-20261001-030000.tar.gz"), b"12345").unwrap();
    std::fs::write(
        dir.path().join("opengrid-auto-20261002-030000.tar.gz"),
        b"1",
    )
    .unwrap();
    std::fs::write(dir.path().join("pre-migration-v1-20261003-030000.db"), b"1").unwrap();
    std::fs::write(dir.path().join("random.tar.gz"), b"1").unwrap();
    std::fs::write(dir.path().join(".opengrid-x.partial"), b"1").unwrap();
    let list = backup::list(dir.path()).unwrap();
    let names: Vec<&str> = list.iter().map(|b| b.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "pre-migration-v1-20261003-030000.db",
            "opengrid-auto-20261002-030000.tar.gz",
            "opengrid-20261001-030000.tar.gz",
        ]
    );
    assert_eq!(list[2].size, 5);
    assert!(list[0].created_at > 0);
    // Missing directory is an empty list, not an error.
    assert!(backup::list(&dir.path().join("nope")).unwrap().is_empty());
}
