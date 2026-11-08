//! DONE-8: the Airtable-compatible API (`/api/v1`) answers the v15 fixture exactly as it did
//! before the UX overhaul's schema changes.
//!
//! The golden files in `tests/golden/v1/` were captured from the v15 fixture (`v15_support`) with
//! the server as it was before migration 0016. The test opens the fixture with the current server
//! (which migrates it), asks the same questions and compares. The only differences it tolerates
//! are the ones the spec names, and it checks that they are exactly those:
//!
//! - the new page property of a table (a rich text field named "Page", "Page 2", ...) in the
//!   `fields` of the table metadata (it has no values, so records are untouched); and
//! - the project a workspace without a live project gets (named after the workspace), in the
//!   list of bases.
//!
//! Regenerate the files only for a change of the v1 API that is meant to happen:
//! `OPENBASE_UPDATE_GOLDEN=1 cargo test -p openbase --test v1_golden`. Run that against a build
//! without the change under test, or the golden would absorb it.

mod common;
mod v15_support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use common::{Client, TestApp};
use openbase::config::Config;
use openbase::email::CapturingMailer;
use openbase::state::AppState;
use rusqlite::Connection;
use serde_json::{Map, Value, json};

/// Ids of the fields and bases in the database file.
struct Snapshot {
    fields: BTreeSet<String>,
    bases: BTreeSet<String>,
}

fn snapshot(path: &std::path::Path) -> Snapshot {
    let conn = Connection::open(path).unwrap();
    let ids = |sql: &str| -> BTreeSet<String> {
        conn.prepare(sql)
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    Snapshot {
        fields: ids("SELECT id FROM fields"),
        bases: ids("SELECT id FROM bases"),
    }
}

struct Opened {
    app: TestApp,
    /// Fields and bases that exist now but did not in the v15 file.
    new_fields: Vec<(String, String, String)>,
    new_bases: Vec<(String, String)>,
    _dir: tempfile::TempDir,
}

fn open_fixture() -> Opened {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("openbase.db");
    v15_support::build(&path);
    let before = snapshot(&path);

    let mailer = Arc::new(CapturingMailer::default());
    let state = AppState::open_with_mail(
        Config::for_tests(dir.path()),
        Arc::new(move |_| Ok(mailer.clone() as Arc<dyn openbase::email::Mailer>)),
    )
    .unwrap();
    let router = openbase::http::router(state.clone());
    let app = TestApp::from_parts(state, router);

    let conn = Connection::open(&path).unwrap();
    let new_fields = conn
        .prepare("SELECT id, name, type FROM fields ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<Vec<(String, String, String)>, _>>()
        .unwrap()
        .into_iter()
        .filter(|(id, ..)| !before.fields.contains(id))
        .collect();
    let new_bases = conn
        .prepare("SELECT id, name FROM bases ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<(String, String)>, _>>()
        .unwrap()
        .into_iter()
        .filter(|(id, _)| !before.bases.contains(id))
        .collect();
    Opened {
        app,
        new_fields,
        new_bases,
        _dir: dir,
    }
}

fn client(token: &str) -> Client {
    TestApp::bearer(token)
}

/// `{status, body}` of a GET. An `offset` is opaque and random per run, so it is masked.
async fn fetch(app: &TestApp, who: &Client, path: &str) -> Value {
    let r = app.get(who, path).await;
    let mut body = r.body.clone();
    if body["offset"].is_string() {
        body["offset"] = json!("<offset>");
    }
    json!({ "status": r.status.as_u16(), "body": body })
}

/// Every page of a table's record listing for the given query string, with the opaque `offset`
/// replaced by a marker (it is random per run).
async fn list_pages(app: &TestApp, who: &Client, path: &str, query: &str) -> Value {
    let mut pages = Vec::new();
    let mut offset: Option<String> = None;
    loop {
        let mut q = query.to_string();
        if let Some(o) = &offset {
            q.push_str(if q.is_empty() { "?" } else { "&" });
            q.push_str(&format!("offset={o}"));
        }
        let r = app.get(who, &format!("{path}{q}")).await;
        let mut body = r.body.clone();
        offset = body["offset"].as_str().map(str::to_string);
        if offset.is_some() {
            body["offset"] = json!("<offset>");
        }
        pages.push(json!({ "status": r.status.as_u16(), "body": body }));
        if offset.is_none() || pages.len() > 10 {
            break;
        }
    }
    Value::Array(pages)
}

/// What one base answers: its table metadata, and for each of its tables the record listings
/// (names and ids as keys, a page size that forces paging, sort, field selection, formula, view)
/// and the first two records.
async fn capture_base(app: &TestApp, who: &Client, base_id: &str) -> Value {
    let meta = fetch(app, who, &format!("/api/v1/meta/bases/{base_id}/tables")).await;
    let mut tables = Map::new();
    for t in meta["body"]["tables"].as_array().into_iter().flatten() {
        let table_id = t["id"].as_str().unwrap().to_string();
        let path = format!("/api/v1/{base_id}/{table_id}");
        let mut out = Map::new();
        out.insert("list".into(), list_pages(app, who, &path, "").await);
        out.insert(
            "list_by_field_id".into(),
            list_pages(app, who, &path, "?returnFieldsByFieldId=true&pageSize=3").await,
        );
        let first = app.get(who, &format!("{path}?maxRecords=2")).await.body["records"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for (i, rec) in first.iter().enumerate() {
            let rid = rec["id"].as_str().unwrap();
            out.insert(
                format!("record_{}", i + 1),
                fetch(app, who, &format!("{path}/{rid}")).await,
            );
        }
        if t["name"] == "Tasks" {
            let extra = [
                (
                    "sorted",
                    "?sort%5B0%5D%5Bfield%5D=Hours&sort%5B0%5D%5Bdirection%5D=desc",
                ),
                ("some_fields", "?fields%5B%5D=Title&fields%5B%5D=Due"),
                ("formula", "?filterByFormula=%7BHours%7D+%3E+1"),
                ("view", "?view=Board"),
                ("empty_cells", "?cellFormat=json&returnFieldsByFieldId=true"),
            ];
            for (name, query) in extra {
                out.insert(name.into(), list_pages(app, who, &path, query).await);
            }
            // By table name, as Airtable clients do.
            out.insert(
                "by_name".into(),
                fetch(app, who, &format!("/api/v1/{base_id}/Tasks?pageSize=1")).await,
            );
        }
        tables.insert(table_id, Value::Object(out));
    }
    json!({ "meta": meta, "tables": tables })
}

/// Everything the golden files hold, by file name.
async fn capture(o: &Opened) -> BTreeMap<String, Value> {
    let app = &o.app;
    let olive = client(v15_support::OLIVE_TOKEN);
    let bob = client(v15_support::BOB_TOKEN);
    let carol = client(v15_support::CAROL_TOKEN);
    let mut files = BTreeMap::new();

    files.insert(
        "meta_bases_olive".into(),
        fetch(app, &olive, "/api/v1/meta/bases").await,
    );
    files.insert(
        "meta_bases_bob".into(),
        fetch(app, &bob, "/api/v1/meta/bases").await,
    );
    files.insert(
        "meta_bases_carol".into(),
        fetch(app, &carol, "/api/v1/meta/bases").await,
    );

    for base in [
        "sales", "sales2", "ops", "wide", "betax", "betay", "betaz", "betaq",
    ] {
        let id = v15_support::id::base(base);
        files.insert(format!("base_{base}"), capture_base(app, &olive, &id).await);
    }
    // The viewer sees only the project she was limited to, and may not write.
    files.insert(
        "base_sales_as_bob".into(),
        capture_base(app, &bob, &v15_support::id::base("sales")).await,
    );

    let sales = v15_support::id::base("sales");
    let mut errors = Map::new();
    for (name, who, path) in [
        (
            "trashed_table_by_id",
            &olive,
            format!("/api/v1/{sales}/{}", v15_support::id::table("oldnotes")),
        ),
        (
            "trashed_table_by_name",
            &olive,
            format!("/api/v1/{sales}/Old%20notes"),
        ),
        ("unknown_table", &olive, format!("/api/v1/{sales}/Nothing")),
        (
            "trashed_base_tables",
            &olive,
            format!(
                "/api/v1/meta/bases/{}/tables",
                v15_support::id::base("archive")
            ),
        ),
        (
            "trashed_record",
            &olive,
            format!(
                "/api/v1/{sales}/{}/{}",
                v15_support::id::table("tasks"),
                v15_support::id::record("tasks", 4)
            ),
        ),
        (
            "other_workspace_base",
            &bob,
            format!(
                "/api/v1/{}/{}",
                v15_support::id::base("ops"),
                v15_support::id::table("inventory")
            ),
        ),
        (
            "no_token",
            &Client::default(),
            format!("/api/v1/{sales}/{}", v15_support::id::table("tasks")),
        ),
    ] {
        errors.insert(name.into(), fetch(app, who, &path).await);
    }
    files.insert("errors".into(), Value::Object(errors));
    files
}

/// Remove what the spec allows to differ. Returns how many page fields and projects it removed.
fn normalize(o: &Opened, files: &mut BTreeMap<String, Value>) -> (usize, usize) {
    let page_ids: BTreeSet<&str> = o
        .new_fields
        .iter()
        .filter(|(_, name, ty)| ty == "rich_text" && is_page_name(name))
        .map(|(id, ..)| id.as_str())
        .collect();
    assert_eq!(
        page_ids.len(),
        o.new_fields.len(),
        "the migration may only add page properties, found {:?}",
        o.new_fields
    );
    let new_base_names: BTreeSet<&str> = o.new_bases.iter().map(|(_, n)| n.as_str()).collect();

    let (mut pages, mut projects) = (0, 0);
    fn walk(v: &mut Value, page_ids: &BTreeSet<&str>, count: &mut usize) {
        match v {
            Value::Object(m) => {
                if let Some(Value::Array(fields)) = m.get_mut("fields") {
                    let before = fields.len();
                    fields.retain(|f| !f["id"].as_str().is_some_and(|id| page_ids.contains(id)));
                    *count += before - fields.len();
                }
                for x in m.values_mut() {
                    walk(x, page_ids, count);
                }
            }
            Value::Array(a) => a.iter_mut().for_each(|x| walk(x, page_ids, count)),
            _ => {}
        }
    }
    for v in files.values_mut() {
        walk(v, &page_ids, &mut pages);
    }
    for name in ["meta_bases_olive", "meta_bases_bob", "meta_bases_carol"] {
        if let Some(Value::Array(bases)) =
            files.get_mut(name).and_then(|v| v["body"].get_mut("bases"))
        {
            let before = bases.len();
            bases.retain(|b| {
                !b["name"]
                    .as_str()
                    .is_some_and(|n| new_base_names.contains(n))
            });
            projects += before - bases.len();
        }
    }
    (pages, projects)
}

fn is_page_name(name: &str) -> bool {
    name == "Page"
        || name
            .strip_prefix("Page ")
            .is_some_and(|n| n.parse::<u32>().is_ok())
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/v1")
}

/// The first path at which two JSON values differ, for a readable failure.
fn first_difference(path: &str, a: &Value, b: &Value) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for k in x.keys().chain(y.keys()).collect::<BTreeSet<_>>() {
                match (x.get(k), y.get(k)) {
                    (Some(p), Some(q)) => {
                        if let Some(d) = first_difference(&format!("{path}/{k}"), p, q) {
                            return Some(d);
                        }
                    }
                    (p, q) => {
                        return Some(format!(
                            "{path}/{k}: golden {} / now {}",
                            brief(p),
                            brief(q)
                        ));
                    }
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            for i in 0..x.len().max(y.len()) {
                match (x.get(i), y.get(i)) {
                    (Some(p), Some(q)) => {
                        if let Some(d) = first_difference(&format!("{path}/{i}"), p, q) {
                            return Some(d);
                        }
                    }
                    (p, q) => {
                        return Some(format!(
                            "{path}/{i}: golden {} / now {}",
                            brief(p),
                            brief(q)
                        ));
                    }
                }
            }
            None
        }
        _ if a == b => None,
        _ => Some(format!(
            "{path}: golden {} / now {}",
            brief(Some(a)),
            brief(Some(b))
        )),
    }
}

fn brief(v: Option<&Value>) -> String {
    match v {
        None => "(missing)".into(),
        Some(v) => {
            let s = v.to_string();
            if s.len() > 300 {
                format!("{}...", &s[..300])
            } else {
                s
            }
        }
    }
}

#[tokio::test]
async fn v1_responses_for_the_v15_fixture_are_unchanged() {
    let opened = open_fixture();
    let mut files = capture(&opened).await;
    let (pages, projects) = normalize(&opened, &mut files);

    let update = std::env::var("OPENBASE_UPDATE_GOLDEN").is_ok_and(|v| v == "1");
    let dir = golden_dir();
    if update {
        assert_eq!(
            (pages, projects),
            (0, 0),
            "regenerate the golden files from a server before migration 0016"
        );
        std::fs::create_dir_all(&dir).unwrap();
        // Drop files of requests that are no longer made.
        for entry in std::fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            if !files.contains_key(&stem) {
                std::fs::remove_file(p).unwrap();
            }
        }
        for (name, value) in &files {
            let mut text = serde_json::to_string_pretty(value).unwrap();
            text.push('\n');
            std::fs::write(dir.join(format!("{name}.json")), text).unwrap();
        }
        return;
    }

    let mut on_disk: BTreeSet<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("no golden files in {}: {e}", dir.display()))
        .map(|e| {
            e.unwrap()
                .path()
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .to_string()
        })
        .collect();
    for (name, now) in &files {
        let text = std::fs::read_to_string(dir.join(format!("{name}.json")))
            .unwrap_or_else(|e| panic!("golden file {name}.json: {e}"));
        let golden: Value = serde_json::from_str(&text).unwrap();
        if let Some(d) = first_difference("", &golden, now) {
            panic!("v1 response {name} differs from its golden file at {d}");
        }
        on_disk.remove(name);
    }
    assert!(
        on_disk.is_empty(),
        "golden files nobody compares: {on_disk:?}"
    );

    // Page properties and projects are only ever stripped where the migration added them.
    assert!(pages <= opened.new_fields.len() && projects <= opened.new_bases.len());
}
