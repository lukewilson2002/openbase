//! Schema version 16 (UX overhaul, BE-1): the upgrade of the v15 fixture database, and what new
//! workspaces and tables get from the same rules.
//!
//! The upgrade tests open the fixture (`v15_support`) with `Db::open`, as the server does at
//! start, and read the result straight from the file. `no_cell_value_and_no_old_row_changes`
//! is the DONE-7 check; the golden test in `v1_golden.rs` is DONE-8.

mod common;
mod schema_support;
mod v15_support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use openbase::db::Db;
use rusqlite::Connection;
use serde_json::{Value, json};

use v15_support::id;

/// The palette cycle of the migration and of new tables, spelled out here on purpose.
const CYCLE: [&str; 10] = [
    "blue", "orange", "green", "purple", "yellow", "pink", "teal", "red", "cyan", "gray",
];

/// A migrated copy of the fixture, with what the file held before the upgrade.
struct Upgraded {
    dir: tempfile::TempDir,
    conn: Connection,
    before: Before,
}

/// Facts about the v15 file, read before the server touched it.
struct Before {
    checksum: (String, usize),
    record_counts: BTreeMap<String, (i64, i64)>,
    /// Per table: the columns it had at v15, its highest rowid, and a digest of those columns of
    /// every row (the `views.config` column is compared separately).
    rows: BTreeMap<String, (Vec<String>, i64, String)>,
    field_ids: BTreeSet<String>,
    base_ids: BTreeSet<String>,
    configs: BTreeMap<String, Value>,
}

fn db_path(dir: &tempfile::TempDir) -> std::path::PathBuf {
    dir.path().join("openbase.db")
}

fn table_names(conn: &Connection) -> Vec<String> {
    conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn columns(conn: &Connection, table: &str) -> Vec<String> {
    conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Digest of `cols` of the rows of `table` up to `max_rowid`, in rowid order.
fn digest(conn: &Connection, table: &str, cols: &[String], max_rowid: i64) -> String {
    use sha2::{Digest, Sha256};
    let list = cols
        .iter()
        .map(|c| format!("quote({c})"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {list} FROM {table} WHERE rowid <= ?1 ORDER BY rowid"
        ))
        .unwrap();
    let mut hasher = Sha256::new();
    let mut rows = stmt.query([max_rowid]).unwrap();
    while let Some(r) = rows.next().unwrap() {
        for i in 0..cols.len() {
            hasher.update(r.get::<_, String>(i).unwrap());
            hasher.update([0x1f]);
        }
        hasher.update([0x1e]);
    }
    hex::encode(hasher.finalize())
}

fn view_configs(conn: &Connection) -> BTreeMap<String, Value> {
    conn.prepare("SELECT id, config FROM views")
        .unwrap()
        .query_map([], |r| {
            let raw: String = r.get(1)?;
            Ok((r.get(0)?, serde_json::from_str(&raw).unwrap()))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn ids(conn: &Connection, sql: &str) -> BTreeSet<String> {
    conn.prepare(sql)
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn read_before(path: &Path) -> Before {
    let conn = Connection::open(path).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        15
    );
    let mut rows = BTreeMap::new();
    for t in table_names(&conn) {
        let cols: Vec<String> = columns(&conn, &t)
            .into_iter()
            .filter(|c| !(t == "views" && c == "config"))
            .collect();
        let max: i64 = conn
            .query_row(
                &format!("SELECT COALESCE(MAX(rowid), 0) FROM {t}"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        let d = digest(&conn, &t, &cols, max);
        rows.insert(t, (cols, max, d));
    }
    Before {
        checksum: v15_support::cell_checksum(&conn),
        record_counts: v15_support::record_counts(&conn),
        rows,
        field_ids: ids(&conn, "SELECT id FROM fields"),
        base_ids: ids(&conn, "SELECT id FROM bases"),
        configs: view_configs(&conn),
    }
}

fn upgrade() -> Upgraded {
    let dir = tempfile::tempdir().unwrap();
    let path = db_path(&dir);
    v15_support::build(&path);
    let before = read_before(&path);
    drop(Db::open(&path).unwrap());
    let conn = Connection::open(&path).unwrap();
    Upgraded { dir, conn, before }
}

impl Upgraded {
    fn string(&self, sql: &str, key: &str) -> Option<String> {
        self.conn
            .query_row(sql, [key], |r| r.get(0))
            .unwrap_or_else(|e| panic!("{sql} [{key}]: {e}"))
    }

    fn table_pointer(&self, column: &str, table: &str) -> Option<String> {
        self.string(
            &format!("SELECT {column} FROM tables WHERE id = ?1"),
            &id::table(table),
        )
    }

    fn field_name(&self, field_id: &str) -> String {
        self.conn
            .query_row("SELECT name FROM fields WHERE id = ?1", [field_id], |r| {
                r.get(0)
            })
            .unwrap()
    }

    /// The name of the field a table's pointer column names, if it points anywhere.
    fn pointed_name(&self, column: &str, table: &str) -> Option<String> {
        self.table_pointer(column, table)
            .map(|f| self.field_name(&f))
    }

    fn live_field_count(&self, table: &str) -> i64 {
        self.conn
            .query_row(
                "SELECT count(*) FROM fields WHERE table_id = ?1 AND deleted_at IS NULL",
                [id::table(table)],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn is_new_field(&self, field_id: &str) -> bool {
        !self.before.field_ids.contains(field_id)
    }
}

#[test]
fn the_database_reaches_the_current_version_and_stays_consistent() {
    let up = upgrade();
    let version: i64 = up
        .conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    // 17 only adds the column that remembers which setting a trashed property was.
    assert_eq!(version, 17);
    assert_eq!(version, openbase::db::schema_version());
    let violations: i64 = up
        .conn
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(violations, 0);

    // The server took its safety copy first: the file as it was, at version 15.
    let backups: Vec<_> = std::fs::read_dir(up.dir.path().join("backups"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert!(
        backups[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("pre-migration-v15-")
    );
    let snap = Connection::open(&backups[0]).unwrap();
    assert_eq!(v15_support::cell_checksum(&snap), up.before.checksum);

    // Opening the upgraded file again changes nothing.
    let fields: i64 = up
        .conn
        .query_row("SELECT count(*) FROM fields", [], |r| r.get(0))
        .unwrap();
    let bases: i64 = up
        .conn
        .query_row("SELECT count(*) FROM bases", [], |r| r.get(0))
        .unwrap();
    drop(Db::open(&db_path(&up.dir)).unwrap());
    let again = |t: &str| -> i64 {
        up.conn
            .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!((again("fields"), again("bases")), (fields, bases));
}

/// DONE-7: record counts, a checksum of every cell value, and every other row the upgrade did not
/// mean to touch.
#[test]
fn no_cell_value_and_no_old_row_changes() {
    let up = upgrade();

    let (checksum, cells) = v15_support::cell_checksum(&up.conn);
    assert!(
        cells > 500,
        "the fixture should hold plenty of cells, not {cells}"
    );
    assert_eq!(up.before.checksum, (checksum, cells));
    assert_eq!(
        v15_support::record_counts(&up.conn),
        up.before.record_counts
    );
    assert!(up.before.record_counts.len() > 15);

    // Every v15 column of every v15 row, in every table, is byte for byte what it was. The only
    // column that is allowed to change is a view's config, checked below.
    for (table, (cols, max_rowid, before)) in &up.before.rows {
        assert_eq!(
            &digest(&up.conn, table, cols, *max_rowid),
            before,
            "table {table} changed"
        );
    }

    // A view's config changed only by gaining the new page properties in its hidden fields.
    let new_pages = ids(&up.conn, "SELECT id FROM fields WHERE type = 'rich_text'")
        .into_iter()
        .filter(|f| up.is_new_field(f))
        .collect::<BTreeSet<_>>();
    assert_eq!(new_pages.len(), 13);
    let after = view_configs(&up.conn);
    assert_eq!(
        after.keys().collect::<Vec<_>>(),
        up.before.configs.keys().collect::<Vec<_>>()
    );
    for (view, config) in &after {
        let mut expected = up.before.configs[view].clone();
        let hidden: Vec<Value> = config["hidden_fields"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let added: Vec<Value> = hidden
            .iter()
            .filter(|f| new_pages.contains(f.as_str().unwrap()))
            .cloned()
            .collect();
        if !added.is_empty() {
            let list = expected
                .as_object_mut()
                .unwrap()
                .entry("hidden_fields")
                .or_insert_with(|| json!([]));
            list.as_array_mut().unwrap().extend(added);
        }
        assert_eq!(config, &expected, "view {view}");
    }

    // The new rows are exactly the page properties and the new top-level projects.
    let new_fields: Vec<(String, String, String)> = up
        .conn
        .prepare("SELECT id, name, type FROM fields ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<(String, String, String)>, _>>()
        .unwrap()
        .into_iter()
        .filter(|(f, ..)| up.is_new_field(f.as_str()))
        .collect();
    assert!(
        new_fields
            .iter()
            .all(|(_, name, ty)| ty == "rich_text" && name.starts_with("Page"))
    );
    let new_bases = ids(&up.conn, "SELECT id FROM bases")
        .into_iter()
        .filter(|b| !up.before.base_ids.contains(b))
        .count();
    assert_eq!(new_bases, 3);
}

#[test]
fn each_workspace_gets_the_first_live_project_by_position_as_its_top_level() {
    let up = upgrade();
    let root = |ws: &str| -> String {
        up.string(
            "SELECT root_base_id FROM workspaces WHERE id = ?1",
            &id::workspace(ws),
        )
        .unwrap_or_else(|| panic!("workspace {ws} has no top level"))
    };

    // Acme: the trashed project at position 0 is skipped; "Sales" and "Sales copy" tie on
    // position 1 and the earlier one wins.
    assert_eq!(root("acme"), id::base("sales"));
    // Beta: three live projects tie on position 1; two were made at the same moment, so the
    // lower id (y before z) decides, and the later one at position 2 never competes.
    assert_eq!(root("beta"), id::base("betay"));
    // A trashed workspace with a live project points at it.
    assert_eq!(root("gone"), id::base("gonebase"));

    // A workspace without a live project gets one named after it: Empty (only a trashed
    // project), Fresh (none at all) and a trashed workspace without any.
    for (ws, name, color) in [
        ("empty", "Empty", "purple"),
        ("fresh", "Fresh", "orange"),
        ("gone2", "Gone too", "teal"),
    ] {
        let base = root(ws);
        assert!(
            !up.before.base_ids.contains(&base),
            "{name} should be a new project"
        );
        let (workspace, found, base_color, position, by, deleted): (
            String,
            String,
            String,
            f64,
            Option<String>,
            Option<i64>,
        ) = up
            .conn
            .query_row(
                "SELECT workspace_id, name, color, position, created_by, deleted_at
                   FROM bases WHERE id = ?1",
                [&base],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(workspace, id::workspace(ws));
        assert_eq!(found, name);
        assert_eq!(base_color, color, "the workspace's colour");
        assert_eq!(position, 0.0);
        assert_eq!(by, Some(id::user("carol")));
        assert_eq!(deleted, None);
        let tables: i64 = up
            .conn
            .query_row(
                "SELECT count(*) FROM tables WHERE base_id = ?1",
                [&base],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }
    // The project Empty had in its trash stays there, and stays out of the way.
    assert_eq!(
        up.string(
            "SELECT CAST(deleted_at IS NOT NULL AS TEXT) FROM bases WHERE id = ?1",
            &id::base("emptyold")
        ),
        Some("1".into())
    );
    // Nobody who was limited to a list of projects gained one.
    let listed: i64 = up
        .conn
        .query_row("SELECT count(*) FROM workspace_member_bases", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(listed, 1);
}

#[test]
fn tables_cycle_through_the_palette_in_table_order_within_each_project() {
    let up = upgrade();
    let colors = |base: &str| -> Vec<(String, String)> {
        up.conn
            .prepare(
                "SELECT id, color FROM tables WHERE base_id = ?1
                 ORDER BY deleted_at IS NOT NULL, position, created_at, id",
            )
            .unwrap()
            .query_map([id::base(base)], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };

    // Sales: ten live tables take the ten colours in position order, then the two in the trash
    // start the cycle over.
    let sales = colors("sales");
    let order: Vec<&str> = sales.iter().map(|(t, _)| t.as_str()).collect();
    let expected_order: Vec<String> = [
        "tasks",
        "clients",
        "meetings",
        "pagea",
        "pageb",
        "pagec",
        "paged",
        "titled",
        "habits",
        "everything",
        "oldnotes",
        "olddocs",
    ]
    .iter()
    .map(|t| id::table(t))
    .collect();
    assert_eq!(order, expected_order);
    for (i, (table, color)) in sales.iter().enumerate() {
        assert_eq!(color, CYCLE[i % 10], "{table}");
    }
    assert_eq!(
        colors("ops"),
        vec![
            (id::table("inventory"), "blue".into()),
            (id::table("scratch"), "orange".into())
        ]
    );
    assert_eq!(
        colors("wide"),
        vec![
            (id::table("wide500"), "blue".into()),
            (id::table("wide499"), "orange".into())
        ]
    );
    // Each project starts again at blue.
    assert_eq!(colors("betaz")[0].1, "blue");
    assert_eq!(colors("sales2")[0].1, "blue");
    // Every table has one of the palette's colours.
    let all = ids(&up.conn, "SELECT DISTINCT color FROM tables");
    assert!(all.iter().all(|c| CYCLE.contains(&c.as_str())));
}

/// What each table's page should be after the upgrade: `Existing(name)` keeps that field,
/// `Created(name)` gets a new hidden one, `None` stays without.
enum Page {
    Existing(&'static str),
    Created(&'static str),
    None,
}

#[test]
fn every_live_table_gets_a_page_property_by_decision_2() {
    use Page::*;
    let up = upgrade();
    let cases = [
        ("tasks", Created("Page")),
        // exactly one rich text field: it is the page
        ("clients", Existing("Brief")),
        ("everything", Existing("Rich")),
        ("reading", Existing("Review")),
        // a trashed project's table is still a live table
        ("archived", Existing("Memo")),
        // two rich text fields
        ("meetings", Created("Page")),
        // name collisions: "Page", then "page" and "Page 2", then a rich text "Page" in use
        ("pagea", Created("Page 2")),
        ("pageb", Created("Page 3")),
        ("paged", Created("Page 2")),
        // one live and one trashed rich text field: the live one
        ("pagec", Existing("Body")),
        // the only rich text field is the title: a page of its own
        ("titled", Created("Page")),
        ("habits", Created("Page")),
        ("copyitems", Created("Page")),
        ("inventory", Created("Page")),
        ("scratch", Created("Page")),
        ("goals", Created("Page")),
        ("gonething", Created("Page")),
        // at the limit of 500 properties: left without; one below it: the 500th is the page
        ("wide500", None),
        ("wide499", Created("Page")),
        // in the trash: left without, even with exactly one rich text field
        ("oldnotes", None),
        ("olddocs", None),
    ];
    let tables: i64 = up
        .conn
        .query_row("SELECT count(*) FROM tables", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cases.len() as i64, tables, "every table has a case");
    for (table, page) in &cases {
        let pointed = up.pointed_name("body_field_id", table);
        match page {
            Existing(name) => {
                let field = up.table_pointer("body_field_id", table).unwrap();
                assert!(!up.is_new_field(&field), "{table} should keep its field");
                assert_eq!(pointed.as_deref(), Some(*name), "{table}");
            }
            Created(name) => {
                let field = up.table_pointer("body_field_id", table).unwrap();
                assert!(up.is_new_field(&field), "{table} should get a new field");
                assert_eq!(pointed.as_deref(), Some(*name), "{table}");
                let (ty, options, table_id): (String, String, String) = up
                    .conn
                    .query_row(
                        "SELECT type, options, table_id FROM fields WHERE id = ?1",
                        [&field],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .unwrap();
                assert_eq!((ty.as_str(), options.as_str()), ("rich_text", "{}"));
                assert_eq!(table_id, id::table(table));
                // last in table order
                let (position, max_other): (f64, f64) = up
                    .conn
                    .query_row(
                        "SELECT position, (SELECT MAX(position) FROM fields
                                            WHERE table_id = ?2 AND id != ?1)
                           FROM fields WHERE id = ?1",
                        [&field, &id::table(table)],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .unwrap();
                assert!(position > max_other, "{table}: page after the others");
                // hidden in every view of the table: shown, personal, default and trashed
                let views: Vec<(String, String)> = up
                    .conn
                    .prepare("SELECT id, config FROM views WHERE table_id = ?1")
                    .unwrap()
                    .query_map([id::table(table)], |r| Ok((r.get(0)?, r.get(1)?)))
                    .unwrap()
                    .collect::<Result<_, _>>()
                    .unwrap();
                assert!(!views.is_empty());
                for (view, config) in views {
                    let config: Value = serde_json::from_str(&config).unwrap();
                    assert!(
                        config["hidden_fields"]
                            .as_array()
                            .unwrap()
                            .contains(&json!(field)),
                        "{table}: page not hidden in {view}"
                    );
                }
            }
            None => {
                assert_eq!(pointed, Option::None, "{table} should have no page");
            }
        }
    }

    // The limit: the table at 500 fields did not grow, the one below it reached 500.
    assert_eq!(up.live_field_count("wide500"), 500);
    assert_eq!(up.live_field_count("wide499"), 500);
    // Nothing else got a field: tables that keep their own rich text field have the count they had.
    assert_eq!(up.live_field_count("clients"), 10);
    assert_eq!(up.live_field_count("pagec"), 2);
    // A trashed rich text field is never picked, and the trashed table has no new field.
    let olddocs_fields: i64 = up
        .conn
        .query_row(
            "SELECT count(*) FROM fields WHERE table_id = ?1",
            [id::table("olddocs")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(olddocs_fields, 2);
    // Views that already hid something keep it, and the page joins the list.
    let hidden = |view: &str| -> Vec<String> {
        let config: String = up
            .conn
            .query_row(
                "SELECT config FROM views WHERE id = ?1",
                [id::view(view)],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str::<Value>(&config).unwrap()["hidden_fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    };
    let agenda = hidden("meetingsagenda");
    assert_eq!(agenda.len(), 2);
    assert_eq!(agenda[0], id::field("meetings", "minutes"));
    // No record has a value for a page property the upgrade made.
    let new_pages: Vec<String> = ids(&up.conn, "SELECT id FROM fields WHERE type = 'rich_text'")
        .into_iter()
        .filter(|f| up.is_new_field(f))
        .collect();
    assert_eq!(new_pages.len(), 13);
    for page in new_pages {
        let with_value: i64 = up
            .conn
            .query_row(
                "SELECT count(*) FROM records WHERE instr(data, ?1) > 0",
                [&page],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(with_value, 0, "{page}");
    }
}

#[test]
fn home_date_and_done_are_preset_by_name() {
    let up = upgrade();
    let home = |t: &str| up.pointed_name("home_date_field_id", t);
    let done = |t: &str| up.pointed_name("done_field_id", t);

    // By name, best first: Due beats Start although Start comes first in the table; Done beats
    // Complete likewise.
    assert_eq!(home("tasks").as_deref(), Some("Due"));
    assert_eq!(done("tasks").as_deref(), Some("Done"));
    // Case does not matter.
    assert_eq!(home("clients").as_deref(), Some("DEADLINE"));
    assert_eq!(done("clients").as_deref(), Some("Completed"));
    assert_eq!(home("goals").as_deref(), Some("Deadline"));
    assert_eq!(done("goals").as_deref(), Some("Done"));
    // When beats Start; "Attended" is not a Done name.
    assert_eq!(home("meetings").as_deref(), Some("When"));
    assert_eq!(done("meetings"), None);
    // Only a date property counts as the date, and only a checkbox as Done: the text fields
    // called Due and Done are passed over.
    assert_eq!(home("habits").as_deref(), Some("Date"));
    assert_eq!(done("habits").as_deref(), Some("complete"));
    // Trashed properties are never picked; other names do not match; no match leaves it off.
    for table in ["pagea", "inventory", "everything", "scratch", "wide500"] {
        assert_eq!(home(table), None, "{table}");
        assert_eq!(done(table), None, "{table}");
    }
    // A table in the trash gets its presets too, so that a restore behaves like any other.
    assert_eq!(home("oldnotes").as_deref(), Some("Due"));
    assert_eq!(done("oldnotes").as_deref(), Some("Done"));
    // The Home properties are properties of their own table.
    for column in ["home_date_field_id", "done_field_id", "body_field_id"] {
        let stray: i64 = up
            .conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM tables t WHERE t.{column} IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM fields f
                                        WHERE f.id = t.{column} AND f.table_id = t.id)"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stray, 0, "{column}");
    }
}

#[test]
fn record_names_are_empty_and_weeks_start_on_sunday() {
    let up = upgrade();
    let named: i64 = up
        .conn
        .query_row(
            "SELECT count(*) FROM tables WHERE record_noun != ''",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(named, 0);
    let users: i64 = up
        .conn
        .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
        .unwrap();
    let sundays: i64 = up
        .conn
        .query_row("SELECT count(*) FROM users WHERE week_start = 0", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!((users, sundays), (4, 4));
    // Only Sunday and Monday are weeks' first days.
    assert!(
        up.conn
            .execute("UPDATE users SET week_start = 2", [])
            .is_err()
    );
    up.conn
        .execute(
            "UPDATE users SET week_start = 1 WHERE id = ?1",
            [id::user("ann")],
        )
        .unwrap();
}

// ------------------------------------------------------------------ new workspaces and tables

use schema_support::*;

#[tokio::test]
async fn a_new_workspace_gets_a_top_level_project_named_after_it() {
    let f = Fixture::new().await;
    let res = f
        .app
        .post(
            &f.owner,
            "/api/workspaces",
            json!({"name": "Studio", "color": "pink"}),
        )
        .await;
    res.assert_status(201);
    let ws = res.body["id"].as_str().unwrap().to_string();
    let bases = res.body["bases"].as_array().unwrap();
    assert_eq!(bases.len(), 1, "{}", res.body);
    assert_eq!(bases[0]["name"], "Studio");
    assert_eq!(bases[0]["color"], "pink");
    assert_eq!(bases[0]["role"], "owner");
    assert_eq!(bases[0]["tables"], json!([]));
    let top = bases[0]["id"].as_str().unwrap().to_string();

    let root: String = f
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT root_base_id FROM workspaces WHERE id = ?1",
                [&ws],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(root, top);

    // The workspace list shows the same project, and it opens like any project.
    let list = f.app.get(&f.owner, "/api/workspaces").await;
    let listed = list
        .body
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == ws.as_str())
        .unwrap();
    assert_eq!(listed["bases"][0]["id"], top.as_str());
    f.app
        .get(&f.owner, &format!("/api/bases/{top}"))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn a_new_table_gets_the_next_colour_and_a_hidden_page_property() {
    let f = Fixture::new().await;
    let first = f.table(&f.table_id).await;
    let names = Fixture::field_names(&first);
    assert_eq!(names, vec!["Name", "Page", "Notes"]);
    let page = first["fields"][1]["id"].as_str().unwrap().to_string();
    assert_eq!(first["fields"][1]["type"], "rich_text");

    let (colour, body): (String, Option<String>) = f
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT color, body_field_id FROM tables WHERE id = ?1",
                [&f.table_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(colour, "blue");
    assert_eq!(body.as_deref(), Some(page.as_str()));
    // The default grid hides it.
    let default_view = first["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["is_default"] == true)
        .unwrap();
    assert_eq!(default_view["config"]["hidden_fields"], json!([page]));

    // The next tables go round the palette.
    let mut seen = vec![colour];
    for n in 2..=11 {
        let t = f.add_table(&format!("Table {n}")).await;
        let tid = id_of(&t);
        let c: String = f
            .app
            .state
            .db
            .write_sync(|tx| {
                Ok(
                    tx.query_row("SELECT color FROM tables WHERE id = ?1", [&tid], |r| {
                        r.get(0)
                    })?,
                )
            })
            .unwrap();
        seen.push(c);
    }
    assert_eq!(seen, [CYCLE.to_vec(), vec!["blue"]].concat());
}

#[tokio::test]
async fn a_table_with_a_field_called_page_gets_page_2() {
    let f = Fixture::new().await;
    // Rename the page that Table 1 got, as a person could, and create another table that has to
    // find a free name in a table with its own "Page".
    let t = f.add_table("Notes").await;
    let tid = id_of(&t);
    let page_id = t["fields"][1]["id"].as_str().unwrap().to_string();
    f.app
        .delete(&f.owner, &format!("/api/fields/{page_id}"))
        .await
        .assert_status(200);
    f.add_field(&tid, json!({"name": "Page", "type": "text", "options": {}}))
        .await;
    let created = f
        .app
        .state
        .db
        .write_sync(|tx| ::openbase::store::pages::create_body_field(tx, &tid))
        .unwrap();
    let created = created.expect("room for a page");
    let name: String = f
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(
                tx.query_row("SELECT name FROM fields WHERE id = ?1", [&created], |r| {
                    r.get(0)
                })?,
            )
        })
        .unwrap();
    assert_eq!(name, "Page 2");
}

#[tokio::test]
async fn a_copy_of_a_table_keeps_its_colour_and_points_at_its_own_page() {
    let f = Fixture::new().await;
    let first = f.table(&f.table_id).await;
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{}/duplicate", f.table_id),
            json!({}),
        )
        .await
        .assert_status(201);
    let schema = f.schema().await;
    let copy = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "Table 1 copy")
        .unwrap();
    let (colour, body): (String, Option<String>) = f
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT color, body_field_id FROM tables WHERE id = ?1",
                [copy["id"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(colour, "blue");
    let page_copy = copy["fields"][1]["id"].as_str().unwrap();
    assert_ne!(page_copy, first["fields"][1]["id"].as_str().unwrap());
    assert_eq!(body.as_deref(), Some(page_copy));
    let default_view = copy["views"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["is_default"] == true)
        .unwrap();
    assert_eq!(default_view["config"]["hidden_fields"], json!([page_copy]));
}

#[tokio::test]
async fn a_table_created_with_its_own_page_field_keeps_it_and_the_new_page_is_page_2() {
    let f = Fixture::new().await;
    let res = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{}/tables", f.base_id),
            json!({"name": "Journal", "fields": [{"name": "Page", "type": "number"}]}),
        )
        .await;
    res.assert_status(201);
    assert_eq!(
        Fixture::field_names(&res.body),
        vec!["Name", "Page", "Page 2"]
    );
    assert_eq!(res.body["fields"][1]["type"], "number");
    assert_eq!(res.body["fields"][2]["type"], "rich_text");
    let tid = id_of(&res.body);
    let body: Option<String> = f
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT body_field_id FROM tables WHERE id = ?1",
                [&tid],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(
        body.as_deref(),
        res.body["fields"][2]["id"].as_str(),
        "the table points at the new page, not at the number"
    );
}

#[tokio::test]
async fn a_table_created_with_499_more_fields_has_no_room_for_a_page() {
    let f = Fixture::new().await;
    let fields: Vec<Value> = (1..=498)
        .map(|n| json!({"name": format!("F{n}"), "type": "number"}))
        .collect();
    let res = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{}/tables", f.base_id),
            json!({"name": "Wide", "fields": fields}),
        )
        .await;
    res.assert_status(201);
    // Name + 498 + the page fill the table exactly.
    assert_eq!(res.body["fields"].as_array().unwrap().len(), 500);
    let full: Vec<Value> = (1..=499)
        .map(|n| json!({"name": format!("G{n}"), "type": "number"}))
        .collect();
    let res = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{}/tables", f.base_id),
            json!({"name": "Wider", "fields": full}),
        )
        .await;
    res.assert_status(201);
    let fields = res.body["fields"].as_array().unwrap();
    assert_eq!(fields.len(), 500);
    assert!(
        fields
            .iter()
            .all(|f| f["type"] == "number" || f["name"] == "Name")
    );
    let tid = id_of(&res.body);
    let body: Option<String> = f
        .app
        .state
        .db
        .write_sync(|tx| {
            Ok(tx.query_row(
                "SELECT body_field_id FROM tables WHERE id = ?1",
                [&tid],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(body, None, "a full table stays without a page");
}
