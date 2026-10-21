//! CSV export of views and CSV import into existing and new tables.

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;

use axum::body::Body;
use axum::http::{Request, header};
use common::{Client, Response, TestApp};
use futures::StreamExt;
use openbase::perm::Role;
use serde_json::{Value, json};
use share_support::*;
use tower::ServiceExt;

const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

fn export_url(view_id: &str) -> String {
    format!("/api/views/{view_id}/export.csv")
}

/// Parse a CSV answer (BOM required) into rows.
fn rows_of(res: &Response) -> Vec<Vec<String>> {
    assert!(res.bytes.starts_with(BOM), "missing UTF-8 BOM");
    csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(&res.bytes[3..])
        .records()
        .map(|r| r.unwrap().iter().map(str::to_string).collect())
        .collect()
}

fn text_of(res: &Response) -> String {
    String::from_utf8(res.bytes[3..].to_vec()).unwrap()
}

// ------------------------------------------------------------------ export

#[tokio::test]
async fn export_has_headers_bom_and_download_headers() {
    let p = people().await;
    let f = &p.f;
    let r = f.app.get(&f.owner, &export_url(&f.view_id)).await;
    r.assert_status(200);
    assert_eq!(r.headers[header::CONTENT_TYPE], "text/csv; charset=utf-8");
    assert_eq!(r.headers[header::CACHE_CONTROL], "private, no-store");
    let disposition = r.headers[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(
        disposition.starts_with("attachment; filename=\"Grid view.csv\""),
        "{disposition}"
    );
    let rows = rows_of(&r);
    assert_eq!(
        rows[0],
        ["Name", "Notes", "Age", "Status", "Tags", "Due", "Done"]
    );
    assert_eq!(rows.len(), 6);
    // Standard CRLF line ends.
    assert!(text_of(&r).contains("\r\n"));
    assert!(!text_of(&r).replace("\r\n", "").contains('\n'));
    // Selects print their names, multiple selects are joined, checkboxes say so.
    assert_eq!(rows[1][0], "Alice");
    assert_eq!(rows[1][2], "30");
    assert_eq!(rows[1][3], "Todo");
    assert_eq!(rows[1][4], "a");
    assert_eq!(rows[2][4], "a, b");
    assert_eq!(rows[3][6], "checked");
    assert_eq!(rows[4], ["dave", "", "", "", "", "", ""]);
}

#[tokio::test]
async fn export_uses_the_views_visible_fields_order_filter_and_sort() {
    let p = people().await;
    let f = &p.f;
    let view = f
        .view_of(
            &f.table_id,
            "Adults, sorted",
            "grid",
            json!({
                "filter": and(vec![cond(&p.age, "gte", json!(30))]),
                "sorts": [{ "field_id": p.age, "direction": "desc" }, { "field_id": p.name, "direction": "asc" }],
                "hidden_fields": [f.notes_id, p.tags],
                "field_order": [p.status, p.name],
            }),
        )
        .await;
    let r = f.app.get(&f.owner, &export_url(&view)).await;
    r.assert_status(200);
    let rows = rows_of(&r);
    assert_eq!(rows[0], ["Status", "Name", "Age", "Due", "Done"]);
    let names: Vec<&str> = rows[1..].iter().map(|r| r[1].as_str()).collect();
    assert_eq!(names, ["Carol", "Alice", "Eve"]);
    assert_eq!(rows[1][0], "Done");
    // The file name comes from the view name, sanitized.
    let d = r.headers[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(d.contains("filename*=UTF-8''Adults%2C%20sorted.csv"), "{d}");
}

#[tokio::test]
async fn export_quotes_per_rfc_4180_and_round_trips() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let tricky = [
        ("comma, inside", "plain"),
        ("quote \"inside\"", "two\nlines"),
        ("cr\r\ninside", "tab\tinside"),
        ("ünïcödé ✓ 日本", "trailing,"),
        ("", ""),
    ];
    // What the table stores (text is normalized on the way in) is what comes out.
    let mut expected: Vec<(String, String)> = Vec::new();
    for (name, note) in tricky {
        let rec = f
            .create(&t, json!({ &p.name: name, &f.notes_id: note }))
            .await;
        let get = |id: &str| rec["values"][id].as_str().unwrap_or("").to_string();
        expected.push((get(&p.name), get(&f.notes_id)));
    }
    let all = f
        .view_of(
            &t,
            "Notes",
            "grid",
            json!({ "hidden_fields": [p.age, p.status, p.tags, p.due, p.done] }),
        )
        .await;
    let r = f.app.get(&f.owner, &export_url(&all)).await;
    let rows = rows_of(&r);
    for (name, note) in &expected {
        let found = rows.iter().any(|r| &r[0] == name && &r[1] == note);
        assert!(found, "round trip failed for {name:?} / {note:?}: {rows:?}");
    }
    let raw = text_of(&r);
    assert!(raw.contains("\"comma, inside\",plain\r\n"), "{raw}");
    assert!(
        raw.contains("\"quote \"\"inside\"\"\",\"two\nlines\"\r\n"),
        "{raw}"
    );
    assert!(raw.contains("ünïcödé ✓ 日本"));
}

#[tokio::test]
async fn export_guards_against_formula_injection() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let danger = [
        "=1+1",
        "+1+1",
        "-2+3",
        "@SUM(A1)",
        "\t=cmd",
        "=HYPERLINK(\"http://evil\")",
    ];
    for d in danger {
        f.create(&t, json!({ &p.name: d, &p.age: -5 })).await;
    }
    f.create(&t, json!({ &p.name: "safe = value", &p.age: -7 }))
        .await;
    let view = f
        .view_of(
            &t,
            "V",
            "grid",
            json!({ "hidden_fields": [f.notes_id, p.status, p.tags, p.due, p.done] }),
        )
        .await;
    let r = f.app.get(&f.owner, &export_url(&view)).await;
    let rows = rows_of(&r);
    for d in danger {
        let want = format!("'{d}");
        assert!(
            rows.iter().any(|r| r[0] == want),
            "{d:?} must be neutralized: {rows:?}"
        );
        assert!(!rows.iter().any(|r| r[0] == d), "{d:?} must not appear raw");
    }
    assert!(rows.iter().any(|r| r[0] == "safe = value"));
    // Real negative numbers stay numbers.
    assert!(rows.iter().any(|r| r[0] == "'=1+1" && r[1] == "-5"));
    assert!(rows.iter().any(|r| r[0] == "safe = value" && r[1] == "-7"));
}

#[tokio::test]
async fn export_guards_header_names_too() {
    let f = Fixture::new().await;
    f.number(&f.table_id, "=evil()").await;
    let r = f.app.get(&f.owner, &export_url(&f.view_id)).await;
    assert!(rows_of(&r)[0].contains(&"'=evil()".to_string()));
}

#[tokio::test]
async fn export_shows_link_user_attachment_and_computed_cells_as_text() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let orders = id_of(&f.add_table("Orders").await);
    let order_name = id_of(&f.field(&orders, "Name").await);
    let link = f.add_link(&t, "Orders", &orders).await;
    let o1 = f
        .create(&orders, json!({ &order_name: "Order, one" }))
        .await;
    let o2 = f.create(&orders, json!({ &order_name: "Order two" })).await;
    let who = id_of(
        &f.add_field(
            &t,
            json!({ "name": "Who", "type": "user", "options": { "multiple": true } }),
        )
        .await,
    );
    let files = id_of(&f.attachment_field(&t, "Files").await);
    let att = f.upload("report.pdf", b"%PDF-1.4").await;
    let double = id_of(&f.formula(&t, "Double", "{Age} * 2").await);
    f.add_field(
        &t,
        json!({ "name": "Made", "type": "created_by", "options": {} }),
    )
    .await;
    f.set(
        &t,
        &p.ids[0],
        json!({
            link["id"].as_str().unwrap(): [o1["id"], o2["id"]],
            &who: [f.owner.user_id.clone().unwrap()],
            &files: [att],
        }),
    )
    .await;
    let r = f.app.get(&f.owner, &export_url(&f.view_id)).await;
    let rows = rows_of(&r);
    let header = &rows[0];
    let col = |name: &str| header.iter().position(|h| h == name).unwrap();
    let alice = &rows[1];
    assert_eq!(alice[col("Orders")], "\"Order, one\", Order two");
    assert_eq!(alice[col("Who")], "Owner");
    assert_eq!(alice[col("Files")], "report.pdf");
    assert_eq!(alice[col("Double")], "60");
    assert_eq!(alice[col("Made")], "Owner");
    let raw = text_of(&r);
    assert!(
        !raw.contains("owner@example.com"),
        "e-mail addresses are not exported"
    );
    assert!(!raw.contains("usr"), "user ids are not exported");
    assert!(!raw.contains(&double));
}

#[tokio::test]
async fn export_formats_dates_in_the_requested_zone() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let at = id_of(
        &f.add_field(
            &t,
            json!({ "name": "At", "type": "date",
                    "options": { "include_time": true, "date_format": "iso", "time_format": "h24" } }),
        )
        .await,
    );
    f.set(&t, &p.ids[0], json!({ &at: "2026-03-10T23:30:00.000Z" }))
        .await;
    let get = |tz: Option<&str>| {
        let url = match tz {
            Some(z) => format!("{}?timezone={z}", export_url(&f.view_id)),
            None => export_url(&f.view_id),
        };
        let owner = f.owner.clone();
        let app = &f.app;
        async move { app.get(&owner, &url).await }
    };
    let cell = |r: &Response| {
        let rows = rows_of(r);
        let c = rows[0].iter().position(|h| h == "At").unwrap();
        rows[1][c].clone()
    };
    assert_eq!(cell(&get(None).await), "2026-03-10 23:30");
    assert_eq!(cell(&get(Some("UTC")).await), "2026-03-10 23:30");
    assert_eq!(cell(&get(Some("Asia/Tokyo")).await), "2026-03-11 08:30");
    assert_eq!(
        cell(&get(Some("America/Los_Angeles")).await),
        "2026-03-10 16:30"
    );
    get(Some("Mars/Base")).await.assert_status(400);
    // Without a parameter the profile zone applies.
    schema_support::sql(&f.app, |tx| {
        tx.execute("UPDATE users SET timezone = 'Asia/Tokyo'", [])
    });
    assert_eq!(cell(&get(None).await), "2026-03-11 08:30");
}

#[tokio::test]
async fn export_sanitizes_the_download_filename() {
    let f = Fixture::new().await;
    for (name, utf8_name) in [
        ("../../etc/passwd", "passwd.csv"),
        ("a\"b;c", "a%22b%3Bc.csv"),
        ("Q1 report", "Q1%20report.csv"),
        ("日本語", "%E6%97%A5%E6%9C%AC%E8%AA%9E.csv"),
        ("..\\..\\win.ini", "win.ini.csv"),
    ] {
        let id = f.view_of(&f.table_id, name, "grid", json!({})).await;
        let r = f.app.get(&f.owner, &export_url(&id)).await;
        r.assert_status(200);
        let d = r.headers[header::CONTENT_DISPOSITION].to_str().unwrap();
        assert!(d.is_ascii() && !d.contains(['\n', '\r']), "{d}");
        assert!(d.starts_with("attachment; filename=\""), "{d}");
        assert!(
            d.ends_with(&format!("filename*=UTF-8''{utf8_name}")),
            "{name:?} -> {d}"
        );
        assert!(!d.contains(".."), "{d}");
    }
}

#[tokio::test]
async fn export_needs_viewer_access() {
    let f = Fixture::new().await;
    let url = export_url(&f.view_id);
    for role in [
        Role::Viewer,
        Role::Commenter,
        Role::Editor,
        Role::Creator,
        Role::Owner,
    ] {
        let u = f.member(&format!("{}@x.io", role.as_str()), role);
        f.app.get(&u, &url).await.assert_status(200);
    }
    f.base_guest("guest@x.io", Role::Viewer);
    let stranger = f.app.user("stranger@x.io", "S");
    f.app.get(&stranger, &url).await.assert_status(404);
    f.app.get(&f.app.anon(), &url).await.assert_status(401);
    f.app
        .get(&f.owner, &export_url("viwNOPE"))
        .await
        .assert_status(404);
    // Tokens: a read-only token may export; a token limited to another base may not.
    let ro = token_client(&f.app, &f.owner, false);
    f.app.get(&ro, &url).await.assert_status(200);
    // Personal views belong to their owner.
    let personal = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Mine", "type": "grid", "personal": true }),
        )
        .await;
    let pid = id_of(&personal.body);
    f.app
        .get(&f.owner, &export_url(&pid))
        .await
        .assert_status(200);
    let viewer = f.member("v2@x.io", Role::Viewer);
    f.app
        .get(&viewer, &export_url(&pid))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn an_empty_table_exports_just_the_header() {
    let f = Fixture::new().await;
    let r = f.app.get(&f.owner, &export_url(&f.view_id)).await;
    r.assert_status(200);
    let rows = rows_of(&r);
    assert_eq!(rows, vec![vec!["Name".to_string(), "Notes".to_string()]]);
}

#[tokio::test]
async fn a_big_table_is_streamed_in_bounded_chunks() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let age = id_of(&f.number(&t, "Age").await);
    let (name, age2, table) = (f.primary_id.clone(), age.clone(), t.clone());
    schema_support::sql(&f.app, move |tx| {
        tx.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
             INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             SELECT 'recbig' || i, ?1, json_object(?2, 'Row ' || i, ?3, i), i, i, 1, 1 FROM n",
            rusqlite::params![table, name, age2],
        )
    });
    let sorted = f
        .view_of(
            &t,
            "Sorted",
            "grid",
            json!({ "sorts": [{ "field_id": age, "direction": "desc" }] }),
        )
        .await;
    let req = auth(
        Request::builder().method("GET").uri(export_url(&sorted)),
        &f.owner,
    )
    .body(Body::empty())
    .unwrap();
    let res = f.app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let mut stream = res.into_body().into_data_stream();
    let (mut chunks, mut largest, mut total) = (0usize, 0usize, 0usize);
    let mut all: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        chunks += 1;
        largest = largest.max(chunk.len());
        total += chunk.len();
        all.extend_from_slice(&chunk);
    }
    // 10,000 rows come in pages of 500: many chunks, none close to the whole file.
    assert!(chunks >= 20, "{chunks} chunks");
    assert!(
        largest < total / 10,
        "largest chunk {largest} of {total} bytes"
    );
    assert!(largest < 64 * 1024, "{largest}");
    // All rows, in order, exactly once; the sort ran once (cached for the pages).
    let parsed: Vec<Vec<String>> = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(&all[3..])
        .records()
        .map(|r| r.unwrap().iter().map(str::to_string).collect())
        .collect();
    assert_eq!(parsed.len(), 10_001);
    assert_eq!(parsed[1][2], "10000");
    assert_eq!(parsed[10_000][2], "1");
    let distinct: std::collections::HashSet<&str> = parsed.iter().map(|r| r[0].as_str()).collect();
    assert_eq!(distinct.len(), 10_001);
    assert_eq!(f.app.state.query_cache.scans(), 1);
}

#[tokio::test]
async fn export_includes_records_created_just_before() {
    let p = people().await;
    let f = &p.f;
    let first = rows_of(&f.app.get(&f.owner, &export_url(&f.view_id)).await).len();
    f.create(&f.table_id, json!({ &p.name: "Newest" })).await;
    let r = f.app.get(&f.owner, &export_url(&f.view_id)).await;
    let rows = rows_of(&r);
    assert_eq!(rows.len(), first + 1);
    assert_eq!(rows.last().unwrap()[0], "Newest");
}

// ------------------------------------------------------------------ import

async fn import_to(
    app: &TestApp,
    client: &Client,
    table_id: &str,
    csv: &[u8],
    mapping: Option<Value>,
    has_header: Option<&str>,
) -> Response {
    let mapping_text = mapping.map(|m| m.to_string());
    let mut parts: Vec<(&str, Option<&str>, &[u8])> = vec![("file", Some("data.csv"), csv)];
    if let Some(m) = &mapping_text {
        parts.push(("mapping", None, m.as_bytes()));
    }
    if let Some(h) = has_header {
        parts.push(("has_header", None, h.as_bytes()));
    }
    post_multipart(
        app,
        client,
        &format!("/api/tables/{table_id}/import"),
        &parts,
        &[],
    )
    .await
}

async fn all_records(p: &People) -> Value {
    p.f.query(json!({ "limit": 1000 })).await
}

#[tokio::test]
async fn import_maps_columns_and_typecasts_values() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let csv = "Full name,Years,Stage,Labels,Start,Finished,Ignored\r\n\
               Zoe,\"1,234\",Blocked,\"a, b\",2026-04-01,yes,junk\r\n\
               \"Yan \"\"Y\"\" Li\",$56,todo,,03/05/2026,No,junk\r\n\
               Xi,,,,,,\r\n";
    let mapping = json!({
        "Full name": p.name, "Years": p.age, "Stage": p.status, "Labels": p.tags,
        "Start": p.due, "Finished": p.done, "Ignored": null,
    });
    let mut events = f.app.state.events.subscribe(&f.base_id);
    let r = import_to(&f.app, &f.owner, &t, csv.as_bytes(), Some(mapping), None).await;
    r.assert_status(200);
    assert_eq!(r.body["created"], 3);
    assert_eq!(r.body["table_id"], t);
    let all = all_records(&p).await;
    assert_eq!(all["total"], 8);
    // New rows come last, in file order.
    let rows = &all["records"].as_array().unwrap()[5..];
    assert_eq!(rows[0]["values"][&p.name], "Zoe");
    assert_eq!(rows[0]["values"][&p.age], 1234);
    assert_eq!(rows[0]["values"][&p.due], "2026-04-01");
    assert_eq!(rows[0]["values"][&p.done], true);
    assert_eq!(rows[0]["values"][&p.tags].as_array().unwrap().len(), 2);
    assert_eq!(rows[1]["values"][&p.name], "Yan \"Y\" Li");
    assert_eq!(rows[1]["values"][&p.age], 56);
    assert_eq!(rows[1]["values"][&p.due], "2026-03-05");
    assert!(rows[1]["values"].get(&p.done).is_none());
    assert_eq!(rows[2]["values"][&p.name], "Xi");
    assert_eq!(rows[2]["values"].as_object().unwrap().len(), 1);
    // "Blocked" did not exist: typecast created the choice; "todo" matched "Todo".
    let status = f.field(&t, "Status").await;
    let names: Vec<&str> = status["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Todo", "Doing", "Done", "Blocked"]);
    assert_eq!(
        rows[1]["values"][&p.status],
        status["options"]["choices"][0]["id"]
    );
    // Provenance and history.
    assert_eq!(rows[0]["created_by"], f.owner.user_id.clone().unwrap());
    let id = rows[0]["id"].as_str().unwrap();
    assert_eq!(f.history(id)[0].0, "create");
    // Subscribers were told (schema for the new choice, then the records).
    let mut seen_records = false;
    let mut seen_schema = false;
    while let Ok(env) = events.try_recv() {
        match &env.event {
            ob_core::api::events::BaseEvent::RecordsChanged { created, .. } => {
                seen_records |= created.len() == 3;
            }
            ob_core::api::events::BaseEvent::SchemaChanged { .. } => seen_schema = true,
            _ => {}
        }
    }
    assert!(seen_records && seen_schema);
}

#[tokio::test]
async fn import_without_a_mapping_matches_columns_by_name() {
    let p = people().await;
    let csv = "name,AGE,Unknown,status\nNina,40,x,Doing\n";
    let r = import_to(
        &p.f.app,
        &p.f.owner,
        &p.f.table_id,
        csv.as_bytes(),
        None,
        None,
    )
    .await;
    r.assert_status(200);
    let all = all_records(&p).await;
    let nina = all["records"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(nina["values"][&p.name], "Nina");
    assert_eq!(nina["values"][&p.age], 40);
    assert!(nina["values"].get(&p.status).is_some());
}

#[tokio::test]
async fn import_without_a_header_uses_column_numbers() {
    let p = people().await;
    let csv = "Oscar,50\nPia,51\n";
    let mapping = json!({ "0": p.name, "1": p.age });
    let r = import_to(
        &p.f.app,
        &p.f.owner,
        &p.f.table_id,
        csv.as_bytes(),
        Some(mapping),
        Some("false"),
    )
    .await;
    r.assert_status(200);
    assert_eq!(r.body["created"], 2);
    let all = all_records(&p).await;
    assert_eq!(all["total"], 7);
    // A header-style key is unknown without a header.
    let bad = json!({ "Column 1": p.name });
    import_to(
        &p.f.app,
        &p.f.owner,
        &p.f.table_id,
        csv.as_bytes(),
        Some(bad),
        Some("false"),
    )
    .await
    .assert_status(400);
}

#[tokio::test]
async fn import_reads_whatever_spreadsheets_write() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let map = json!({ "n": p.name, "v": p.age });
    // BOM + CRLF + quoted newline + ragged rows + blank line + semicolons.
    let a = "\u{FEFF}n;v\r\n\"two\nlines\";1\r\nshort\r\n\r\nlong;3;extra;cells\r\n";
    import_to(&f.app, &f.owner, &t, a.as_bytes(), Some(map.clone()), None)
        .await
        .assert_status(200);
    // Tab separated, bare CR line ends.
    let b = "n\tv\rtabbed\t9\r";
    import_to(&f.app, &f.owner, &t, b.as_bytes(), Some(map.clone()), None)
        .await
        .assert_status(200);
    // Latin-1 bytes.
    let c = b"n,v\ncaf\xe9,2\n";
    import_to(&f.app, &f.owner, &t, c, Some(map), None)
        .await
        .assert_status(200);
    let all = all_records(&p).await;
    let got: Vec<(String, Option<i64>)> = all["records"].as_array().unwrap()[5..]
        .iter()
        .map(|r| {
            (
                r["values"][&p.name].as_str().unwrap().to_string(),
                r["values"][&p.age].as_i64(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("two lines".to_string(), Some(1)),
            ("short".to_string(), None),
            ("long".to_string(), Some(3)),
            ("tabbed".to_string(), Some(9)),
            ("café".to_string(), Some(2)),
        ]
    );
}

#[tokio::test]
async fn error_row_numbers_match_the_spreadsheet_row() {
    // Blank lines are rows in a spreadsheet, and a quoted line break stays in
    // its row: the bad values below are in rows 4, 8 and 10.
    let p = people().await;
    let f = &p.f;
    let csv = "n,age\r\n\
               fine,1\r\n\
               \r\n\
               bad,abc\r\n\
               \"two\nlines\",2\r\n\
               \r\n\
               \r\n\
               worse,xyz\r\n\
               fine too,3\r\n\
               last bad,??\r\n";
    let map = json!({ "n": p.name, "age": p.age });
    let r = import_to(
        &f.app,
        &f.owner,
        &f.table_id,
        csv.as_bytes(),
        Some(map),
        None,
    )
    .await;
    r.assert_status(422);
    let rows: Vec<i64> = r.body["error"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["row"].as_i64().unwrap())
        .collect();
    assert_eq!(rows, [4, 8, 10]);
}

#[tokio::test]
async fn import_is_all_or_nothing_with_row_numbers() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let before = all_records(&p).await["total"].as_i64().unwrap();
    let choices_before = f.field(&t, "Status").await;
    let csv = "n,age,st\n\
               ok one,1,NewChoiceA\n\
               bad,abc,Todo\n\
               ok two,2,Todo\n\
               worse,xyz,Todo\n\
               ok three,3,NewChoiceB\n";
    let map = json!({ "n": p.name, "age": p.age, "st": p.status });
    let r = import_to(&f.app, &f.owner, &t, csv.as_bytes(), Some(map), None).await;
    r.assert_status(422);
    assert_eq!(r.body["error"]["code"], "import_failed");
    assert_eq!(r.body["error"]["truncated"], false);
    let rows = r.body["error"]["rows"].as_array().unwrap();
    // Row numbers count the header as row 1.
    assert_eq!(
        rows.iter()
            .map(|r| r["row"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [3, 5]
    );
    assert!(
        rows[0]["message"].as_str().unwrap().contains("Age"),
        "{}",
        rows[0]
    );
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("nothing was imported")
    );
    // Nothing was written: no records, no new choices, no autonumber gaps.
    assert_eq!(all_records(&p).await["total"], before);
    assert_eq!(f.field(&t, "Status").await, choices_before);
    let next: i64 = schema_support::sql(&f.app, |tx| {
        tx.query_row(
            "SELECT next_autonumber FROM tables WHERE id = ?1",
            [&t],
            |r| r.get(0),
        )
    });
    let after_ok = import_to(
        &f.app,
        &f.owner,
        &t,
        b"n\nfine\n",
        Some(json!({ "n": p.name })),
        None,
    )
    .await;
    after_ok.assert_status(200);
    let rec_auto: i64 = schema_support::sql(&f.app, |tx| {
        tx.query_row(
            "SELECT autonumber FROM records WHERE table_id = ?1 ORDER BY autonumber DESC LIMIT 1",
            [&t],
            |r| r.get(0),
        )
    });
    assert_eq!(rec_auto, next, "the rejected import used no autonumbers");
}

#[tokio::test]
async fn a_bad_row_in_a_late_batch_rolls_back_the_earlier_batches() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let mut csv = String::from("n,age\n");
    for i in 0..2_500 {
        csv.push_str(&format!("row {i},{i}\n"));
    }
    csv.push_str("broken,notanumber\n");
    for i in 0..10 {
        csv.push_str(&format!("tail {i},{i}\n"));
    }
    let map = json!({ "n": p.name, "age": p.age });
    let r = import_to(
        &f.app,
        &f.owner,
        &t,
        csv.as_bytes(),
        Some(map.clone()),
        None,
    )
    .await;
    r.assert_status(422);
    // Header + 2,500 rows, then the broken one is row 2,502.
    assert_eq!(r.body["error"]["rows"][0]["row"], 2502);
    assert_eq!(r.body["error"]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(all_records(&p).await["total"], 5);
    // The same file without the broken row imports completely (3 batches).
    let fixed = csv.replace("broken,notanumber\n", "");
    let ok = import_to(&f.app, &f.owner, &t, fixed.as_bytes(), Some(map), None).await;
    ok.assert_status(200);
    assert_eq!(ok.body["created"], 2_510);
    assert_eq!(all_records(&p).await["total"], 2_515);
}

#[tokio::test]
async fn import_reports_at_most_fifty_row_errors() {
    let p = people().await;
    let mut csv = String::from("age\n");
    for _ in 0..200 {
        csv.push_str("nope\n");
    }
    let r = import_to(
        &p.f.app,
        &p.f.owner,
        &p.f.table_id,
        csv.as_bytes(),
        Some(json!({ "age": p.age })),
        None,
    )
    .await;
    r.assert_status(422);
    assert_eq!(r.body["error"]["truncated"], true);
    assert_eq!(r.body["error"]["rows"].as_array().unwrap().len(), 50);
    assert_eq!(all_records(&p).await["total"], 5);
}

#[tokio::test]
async fn import_validates_the_mapping_and_the_file() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let double = id_of(&f.formula(&t, "Double", "{Age} * 2").await);
    let orders = id_of(&f.add_table("Orders").await);
    let link = id_of(&f.add_link(&t, "Orders", &orders).await);
    let go = |csv: &'static [u8], mapping: Option<Value>| {
        let (app, owner, t) = (&f.app, f.owner.clone(), t.clone());
        async move { import_to(app, &owner, &t, csv, mapping, None).await }
    };
    // Unknown column, unknown field, computed / link fields, duplicate target.
    for (mapping, why) in [
        (json!({ "zzz": p.name }), "unknown column"),
        (json!({ "n": "fldNOPE" }), "unknown field"),
        (json!({ "n": double }), "computed field"),
        (json!({ "n": link }), "link field"),
        (
            json!({ "n": p.name, "v": p.name }),
            "two columns, one field",
        ),
        (json!({ "n": null }), "nothing mapped"),
        (json!({}), "empty mapping"),
    ] {
        let r = go(b"n,v\na,1\n", Some(mapping)).await;
        assert_eq!(r.status, 400, "{why}: {}", r.body);
        assert_eq!(r.body["error"]["code"], "bad_request", "{why}");
    }
    // Bad mapping JSON / shape.
    for text in ["not json", "[1,2]", "{\"n\": 5}"] {
        let r = post_multipart(
            &f.app,
            &f.owner,
            &format!("/api/tables/{t}/import"),
            &[
                ("file", Some("a.csv"), b"n\na\n"),
                ("mapping", None, text.as_bytes()),
            ],
            &[],
        )
        .await;
        r.assert_status(400);
    }
    // Empty files and missing parts.
    for body in [&b""[..], b"\n\n", b"\xff\xfeu\0t\0"] {
        go(body, Some(json!({ "n": p.name })))
            .await
            .assert_status(400);
    }
    post_multipart(
        &f.app,
        &f.owner,
        &format!("/api/tables/{t}/import"),
        &[("mapping", None, b"{}")],
        &[],
    )
    .await
    .assert_status(400);
    f.app
        .post(
            &f.owner,
            &format!("/api/tables/{t}/import"),
            json!({ "file": "x" }),
        )
        .await
        .assert_status(400);
    // Header-only file: nothing to import is not an error, just 0 records.
    let r = go(b"n,v\n", Some(json!({ "n": p.name }))).await;
    r.assert_status(200);
    assert_eq!(r.body["created"], 0);
    assert_eq!(all_records(&p).await["total"], 5);
}

#[tokio::test]
async fn import_enforces_size_row_and_column_limits() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let map = Some(json!({ "n": p.name }));
    // More than 100,000 rows.
    let mut rows = String::from("n\n");
    rows.push_str(&"x\n".repeat(100_001));
    let r = import_to(&f.app, &f.owner, &t, rows.as_bytes(), map.clone(), None).await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("100000")
    );
    // More than 500 columns.
    let wide = format!("n{}\na\n", ",c".repeat(500));
    import_to(&f.app, &f.owner, &t, wide.as_bytes(), map.clone(), None)
        .await
        .assert_status(400);
    // Over 20 MB.
    let big = format!("n\n{}\n", "y".repeat(21 * 1024 * 1024));
    let app = TestApp::with_config(|c| c.max_upload_mb = 100);
    let owner = app.user("o@x.io", "O");
    let (_, base_id) = app.workspace_with_base(&owner, "W");
    let table = {
        let r = app
            .post(
                &owner,
                &format!("/api/bases/{base_id}/tables"),
                json!({ "name": "T" }),
            )
            .await;
        r.assert_status(201);
        r.body
    };
    let r = import_to(
        &app,
        &owner,
        table["id"].as_str().unwrap(),
        big.as_bytes(),
        Some(json!({ "n": table["primary_field_id"] })),
        None,
    )
    .await;
    r.assert_status(413);
    assert_eq!(r.body["error"]["code"], "payload_too_large");
    // Exactly at the table record cap is fine, one more is not.
    let (name, table_id) = (p.name.clone(), t.clone());
    schema_support::sql(&f.app, move |tx| {
        tx.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99990)
             INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             SELECT 'recfill' || i, ?1, '{}', 1000 + i, 1000 + i, 1, 1 FROM n",
            [&table_id],
        )?;
        let _ = name;
        Ok(())
    });
    import_to(
        &f.app,
        &f.owner,
        &t,
        b"n\na\nb\nc\nd\ne\n",
        map.clone(),
        None,
    )
    .await
    .assert_status(200);
    let r = import_to(&f.app, &f.owner, &t, b"n\na\n", map, None).await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("limit")
    );
}

#[tokio::test]
async fn import_needs_editor_access() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let map = Some(json!({ "n": p.name }));
    for role in [Role::Viewer, Role::Commenter] {
        let u = f.member(&format!("{}@x.io", role.as_str()), role);
        let r = import_to(&f.app, &u, &t, b"n\nfoo\n", map.clone(), None).await;
        assert_eq!(r.status, 403, "{}", role.as_str());
    }
    for role in [Role::Editor, Role::Creator, Role::Owner] {
        let u = f.member(&format!("{}@x.io", role.as_str()), role);
        import_to(&f.app, &u, &t, b"n\nfoo\n", map.clone(), None)
            .await
            .assert_status(200);
    }
    let stranger = f.app.user("stranger@x.io", "S");
    import_to(&f.app, &stranger, &t, b"n\nfoo\n", map.clone(), None)
        .await
        .assert_status(404);
    import_to(&f.app, &f.app.anon(), &t, b"n\nfoo\n", map.clone(), None)
        .await
        .assert_status(401);
    let ro = token_client(&f.app, &f.owner, false);
    import_to(&f.app, &ro, &t, b"n\nfoo\n", map.clone(), None)
        .await
        .assert_status(403);
    let rw = token_client(&f.app, &f.owner, true);
    import_to(&f.app, &rw, &t, b"n\nfoo\n", map.clone(), None)
        .await
        .assert_status(200);
    import_to(&f.app, &f.owner, "tblNOPE", b"n\nfoo\n", map, None)
        .await
        .assert_status(404);
    assert_eq!(all_records(&p).await["total"], 5 + 4);
}

#[tokio::test]
async fn imported_records_show_up_in_cached_queries_and_exports() {
    let p = people().await;
    let f = &p.f;
    let before = all_records(&p).await["total"].as_i64().unwrap();
    import_to(
        &f.app,
        &f.owner,
        &f.table_id,
        b"n\nimported\n",
        Some(json!({ "n": p.name })),
        None,
    )
    .await
    .assert_status(200);
    assert_eq!(all_records(&p).await["total"].as_i64().unwrap(), before + 1);
    let r = f.app.get(&f.owner, &export_url(&f.view_id)).await;
    assert!(rows_of(&r).iter().any(|row| row[0] == "imported"));
}

// ----------------------------------------------------------- new table

async fn import_base(
    app: &TestApp,
    client: &Client,
    base_id: &str,
    file_name: &str,
    csv: &[u8],
    name: Option<&str>,
) -> Response {
    let mut parts: Vec<(&str, Option<&str>, &[u8])> = vec![("file", Some(file_name), csv)];
    if let Some(n) = &name {
        parts.push(("name", None, n.as_bytes()));
    }
    post_multipart(
        app,
        client,
        &format!("/api/bases/{base_id}/import"),
        &parts,
        &[],
    )
    .await
}

const SAMPLE: &str = "Name,Age,Price,Share,Done,Joined,Email,Site,Status,Notes,Zip\n\
    Ann,30,$10.50,12.5%,yes,2026-01-05,ann@x.io,https://a.example,Open,short,02134\n\
    Bob,41,$3,7%,no,2026-02-10,bob@x.io,http://b.example,Closed,\"multi\nline\",10001\n\
    Cy,25.5,$1200,50%,yes,2026-03-15,cy@x.io,https://c.example,Open,,94105\n\
    Di,,$7,1%,no,2026-04-20,di@x.io,https://d.example,Closed,x,60601\n\
    Ed,50,$8,2%,yes,2026-05-25,ed@x.io,https://e.example,Open,y,73301\n";

#[tokio::test]
async fn import_into_a_new_table_infers_field_types() {
    let f = Fixture::new().await;
    let mut events = f.app.state.events.subscribe(&f.base_id);
    let r = import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "People 2026.csv",
        SAMPLE.as_bytes(),
        None,
    )
    .await;
    r.assert_status(201);
    assert_eq!(r.body["created"], 5);
    let table_id = r.body["table_id"].as_str().unwrap().to_string();
    let types: Vec<(String, String)> = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["name"].as_str().unwrap().to_string(),
                f["type"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let expect = [
        ("Name", "text"),
        ("Age", "number"),
        ("Price", "currency"),
        ("Share", "percent"),
        ("Done", "checkbox"),
        ("Joined", "date"),
        ("Email", "email"),
        ("Site", "url"),
        ("Status", "single_select"),
        ("Notes", "text"),
        ("Zip", "text"),
    ];
    let expect: Vec<(String, String)> = expect
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    assert_eq!(types, expect);

    // The table exists with a grid view; the first column is the primary field.
    let table = f.table(&table_id).await;
    // Long or multi-line CSV text stays plain text, with its line breaks.
    let notes = table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "Notes")
        .unwrap();
    assert_eq!(notes["options"]["multiline"], true);
    assert_eq!(table["name"], "People 2026");
    assert_eq!(table["primary_field_id"], r.body["fields"][0]["id"]);
    assert_eq!(table["fields"].as_array().unwrap().len(), 11);
    assert_eq!(table["views"].as_array().unwrap().len(), 1);
    assert_eq!(table["views"][0]["type"], "grid");
    let by_name = |n: &str| {
        table["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == n)
            .cloned()
            .unwrap()
    };
    assert_eq!(by_name("Age")["options"]["precision"], 1);
    assert_eq!(by_name("Price")["options"]["symbol"], "$");
    assert_eq!(by_name("Share")["options"]["precision"], 1);
    let status_field = by_name("Status");
    let choices: Vec<&str> = status_field["options"]["choices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(choices, ["Open", "Closed"]);

    // The records hold the typed values.
    let view_id = table["views"][0]["id"].as_str().unwrap();
    let q = f.query_view(view_id, json!({})).await;
    assert_eq!(q["total"], 5);
    let ann = &q["records"][0]["values"];
    assert_eq!(ann[id_of(&by_name("Name"))], "Ann");
    assert_eq!(ann[id_of(&by_name("Age"))], 30);
    assert_eq!(ann[id_of(&by_name("Price"))], 10.5);
    assert_eq!(ann[id_of(&by_name("Share"))], 0.125);
    assert_eq!(ann[id_of(&by_name("Done"))], true);
    assert_eq!(ann[id_of(&by_name("Joined"))], "2026-01-05");
    assert_eq!(ann[id_of(&by_name("Email"))], "ann@x.io");
    assert_eq!(ann[id_of(&by_name("Zip"))], "02134");
    assert_eq!(
        q["records"][1]["values"][id_of(&by_name("Notes"))],
        "multi\nline"
    );
    assert!(
        q["records"][3]["values"]
            .get(id_of(&by_name("Age")))
            .is_none()
    );
    assert!(
        q["records"][1]["values"]
            .get(id_of(&by_name("Done")))
            .is_none()
    );

    // Schema and record events were published.
    let mut schema = false;
    let mut recs = false;
    while let Ok(env) = events.try_recv() {
        match env.event {
            ob_core::api::events::BaseEvent::SchemaChanged { .. } => schema = true,
            ob_core::api::events::BaseEvent::RecordsChanged { .. } => recs = true,
            _ => {}
        }
    }
    assert!(schema && recs);
}

#[tokio::test]
async fn new_table_names_headers_and_primary_rules() {
    let f = Fixture::new().await;
    // Explicit name wins; a clash with an existing table is a 409.
    let r = import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "x.csv",
        b"a\n1\n",
        Some("Leads"),
    )
    .await;
    r.assert_status(201);
    assert_eq!(
        f.table(r.body["table_id"].as_str().unwrap()).await["name"],
        "Leads"
    );
    let again = import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "x.csv",
        b"a\n1\n",
        Some("leads"),
    )
    .await;
    again.assert_status(409);
    // Without a name the file name is used and made unique.
    let one = import_base(&f.app, &f.owner, &f.base_id, "Sales.csv", b"a\n1\n", None).await;
    let two = import_base(&f.app, &f.owner, &f.base_id, "Sales.csv", b"a\n1\n", None).await;
    one.assert_status(201);
    two.assert_status(201);
    assert_eq!(
        f.table(one.body["table_id"].as_str().unwrap()).await["name"],
        "Sales"
    );
    assert_eq!(
        f.table(two.body["table_id"].as_str().unwrap()).await["name"],
        "Sales 2"
    );
    // Blank and duplicate headers get unique names; a number column can be primary.
    let r = import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "d.csv",
        b"id,,id,ID\n1,a,b,c\n2,d,e,f\n",
        Some("Dups"),
    )
    .await;
    r.assert_status(201);
    let names: Vec<&str> = r.body["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["id", "Column 2", "id 2", "ID 3"]);
    assert_eq!(r.body["fields"][0]["type"], "number");
    // A checkbox-looking first column stays text (a primary field cannot be a checkbox).
    let r = import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "c.csv",
        b"ok,x\nyes,1\nno,2\n",
        Some("Checks"),
    )
    .await;
    r.assert_status(201);
    assert_eq!(r.body["fields"][0]["type"], "text");
    assert_eq!(r.body["fields"][1]["type"], "number");
    // Header only: a table with fields and no records.
    let r = import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "e.csv",
        b"a,b\n",
        Some("Empty"),
    )
    .await;
    r.assert_status(201);
    assert_eq!(r.body["created"], 0);
    assert_eq!(r.body["fields"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn failed_new_table_imports_leave_nothing_behind() {
    let f = Fixture::new().await;
    let tables_before = f.schema().await["tables"].as_array().unwrap().len();
    for body in [&b""[..], b"\n", b"\xff\xfe"] {
        import_base(&f.app, &f.owner, &f.base_id, "bad.csv", body, Some("Bad"))
            .await
            .assert_status(400);
    }
    let wide = format!("n{}\n", ",c".repeat(600));
    import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "wide.csv",
        wide.as_bytes(),
        Some("Wide"),
    )
    .await
    .assert_status(400);
    post_multipart(
        &f.app,
        &f.owner,
        &format!("/api/bases/{}/import", f.base_id),
        &[("name", None, b"NoFile")],
        &[],
    )
    .await
    .assert_status(400);
    assert_eq!(
        f.schema().await["tables"].as_array().unwrap().len(),
        tables_before
    );
}

#[tokio::test]
async fn new_table_import_needs_creator_access() {
    let f = Fixture::new().await;
    for role in [Role::Viewer, Role::Commenter, Role::Editor] {
        let u = f.member(&format!("{}@x.io", role.as_str()), role);
        let r = import_base(&f.app, &u, &f.base_id, "a.csv", b"a\n1\n", Some("T")).await;
        assert_eq!(r.status, 403, "{}", role.as_str());
    }
    let c = f.member("creator@x.io", Role::Creator);
    import_base(&f.app, &c, &f.base_id, "a.csv", b"a\n1\n", Some("T1"))
        .await
        .assert_status(201);
    let stranger = f.app.user("stranger@x.io", "S");
    import_base(
        &f.app,
        &stranger,
        &f.base_id,
        "a.csv",
        b"a\n1\n",
        Some("T2"),
    )
    .await
    .assert_status(404);
    import_base(
        &f.app,
        &f.app.anon(),
        &f.base_id,
        "a.csv",
        b"a\n1\n",
        Some("T3"),
    )
    .await
    .assert_status(401);
    let ro = token_client(&f.app, &f.owner, false);
    import_base(&f.app, &ro, &f.base_id, "a.csv", b"a\n1\n", Some("T4"))
        .await
        .assert_status(403);
}

#[tokio::test]
async fn a_large_new_table_import_completes() {
    let f = Fixture::new().await;
    let mut csv = String::from("Name,Qty,Region\n");
    for i in 0..5_000 {
        csv.push_str(&format!("item {i},{i},{}\n", ["N", "S", "E", "W"][i % 4]));
    }
    let started = std::time::Instant::now();
    let r = import_base(
        &f.app,
        &f.owner,
        &f.base_id,
        "big.csv",
        csv.as_bytes(),
        Some("Big"),
    )
    .await;
    r.assert_status(201);
    assert_eq!(r.body["created"], 5_000);
    assert_eq!(r.body["fields"][1]["type"], "number");
    assert_eq!(r.body["fields"][2]["type"], "single_select");
    let table = f.table(r.body["table_id"].as_str().unwrap()).await;
    let q = f
        .query_view(
            table["views"][0]["id"].as_str().unwrap(),
            json!({ "limit": 1 }),
        )
        .await;
    assert_eq!(q["total"], 5_000);
    assert!(started.elapsed().as_secs() < 60, "{:?}", started.elapsed());
}

// ------------------------------------------------------- hardening (B2)

#[tokio::test]
async fn import_refuses_files_with_too_many_cells() {
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let map = Some(json!({ "n": p.name }));
    // 500 columns x 7,000 rows of real cells: 3.5M cells in 7 MB.
    let row = format!("{}\n", vec!["a"; 500].join(","));
    let mut wide = format!("n{}\n", ",c".repeat(499));
    wide.push_str(&row.repeat(7_000));
    let r = import_to(&f.app, &f.owner, &t, wide.as_bytes(), map.clone(), None).await;
    r.assert_status(400);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cells"),
        "{}",
        r.body
    );
    // A 500-column header over many one-cell rows is padded to 3.5M cells: refused too.
    let mut ragged = format!("n{}\n", ",c".repeat(499));
    ragged.push_str(&"a\n".repeat(7_000));
    import_to(&f.app, &f.owner, &t, ragged.as_bytes(), map.clone(), None)
        .await
        .assert_status(400);
    // The same through the new-table import (Creator).
    import_base(&f.app, &f.owner, &f.base_id, "w.csv", wide.as_bytes(), None)
        .await
        .assert_status(400);
    assert_eq!(all_records(&p).await["total"], 5);
    // Exactly at the budget (header + 5,999 rows of 500 cells) still imports.
    let mut ok = format!("n{}\n", ",c".repeat(499));
    ok.push_str(&row.repeat(5_999));
    import_to(&f.app, &f.owner, &t, ok.as_bytes(), map, None)
        .await
        .assert_status(200);
}

#[tokio::test]
async fn imports_queue_behind_a_small_number_of_slots() {
    use std::time::Duration;
    let p = people().await;
    let f = &p.f;
    let t = f.table_id.clone();
    let map = Some(json!({ "n": p.name }));
    let all = openbase::api::csv::IMPORT_CONCURRENCY as u32;
    let held = openbase::api::csv::IMPORT_PERMITS
        .acquire_many(all)
        .await
        .unwrap();
    let blocked = tokio::time::timeout(
        Duration::from_millis(400),
        import_to(&f.app, &f.owner, &t, b"n\nqueued\n", map.clone(), None),
    )
    .await;
    assert!(blocked.is_err(), "the import ran without a free slot");
    drop(held);
    import_to(&f.app, &f.owner, &t, b"n\nrunning\n", map, None)
        .await
        .assert_status(200);
}

#[tokio::test]
async fn bad_rows_are_found_by_bisection_not_one_by_one() {
    use openbase::engine::write::{WriteCtx, WriteSource};
    use openbase::store::csv_io::{self, ImportOutcome};
    let p = people().await;
    let f = &p.f;
    // 1,000 rows (one batch) with three bad ages.
    let mut text = String::from("n,age\n");
    for i in 0..1_000 {
        let age = if [137, 138, 900].contains(&i) {
            "nope".to_string()
        } else {
            i.to_string()
        };
        text.push_str(&format!("row {i},{age}\n"));
    }
    let parsed = csv_io::parse(text.as_bytes(), true).unwrap();
    let (table, user) = (f.table_id.clone(), f.owner.user_id.clone().unwrap());
    let (name, age) = (p.name.clone(), p.age.clone());
    let (calls, rejected) = f
        .app
        .state
        .db
        .write_sync(move |tx| {
            let fields = openbase::store::schema::table_fields(tx, &table)?;
            let mapping = [("n", &name), ("age", &age)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), Some(v.clone())))
                .collect();
            let cols = csv_io::resolve_mapping(&parsed, &mapping, &fields)?;
            let ctx = WriteCtx::for_user(tx, &user, WriteSource::Import)?.typecast(true);
            let before = csv_io::create_calls_on_this_thread();
            let out = csv_io::import_rows(tx, &ctx, &table, &cols, &parsed.rows)?;
            let calls = csv_io::create_calls_on_this_thread() - before;
            let ImportOutcome::Rejected { errors, truncated } = out else {
                panic!("expected a rejection");
            };
            assert!(!truncated);
            Ok((calls, errors.iter().map(|e| e.row).collect::<Vec<_>>()))
        })
        .unwrap();
    // Header is row 1, so data row i is row i + 2.
    assert_eq!(rejected, [139, 140, 902]);
    // One-by-one replay took 1,001 creates; bisecting three rows takes ~60.
    assert!(calls < 100, "{calls} create calls");
}

#[tokio::test]
async fn export_is_a_snapshot_when_rows_change_between_pages() {
    let f = Fixture::new().await;
    let t = f.table_id.clone();
    let age = id_of(&f.number(&t, "Age").await);
    let (name, age2, table) = (f.primary_id.clone(), age.clone(), t.clone());
    schema_support::sql(&f.app, move |tx| {
        tx.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200)
             INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
             SELECT 'recsnap' || i, ?1, json_object(?2, 'Row ' || i, ?3, i), i, i, 1, 1 FROM n",
            rusqlite::params![table, name, age2],
        )
    });
    let sorted = f
        .view_of(
            &t,
            "Sorted",
            "grid",
            json!({ "sorts": [{ "field_id": age, "direction": "desc" }] }),
        )
        .await;
    let req = auth(
        Request::builder().method("GET").uri(export_url(&sorted)),
        &f.owner,
    )
    .body(Body::empty())
    .unwrap();
    let res = f.app.router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), 200);
    let mut stream = res.into_body().into_data_stream();
    let mut all: Vec<u8> = Vec::new();
    all.extend_from_slice(&stream.next().await.unwrap().unwrap());
    // Records land at the top of the sort order while the file streams.
    f.create(&t, json!({ &f.primary_id: "Newcomer", &age: 5000 }))
        .await;
    f.create(&t, json!({ &f.primary_id: "Newcomer 2", &age: 5001 }))
        .await;
    while let Some(chunk) = stream.next().await {
        all.extend_from_slice(&chunk.unwrap());
    }
    let parsed: Vec<Vec<String>> = csv::ReaderBuilder::new()
        .has_headers(false)
        .from_reader(&all[3..])
        .records()
        .map(|r| r.unwrap().iter().map(str::to_string).collect())
        .collect();
    let distinct: std::collections::HashSet<&str> = parsed.iter().map(|r| r[0].as_str()).collect();
    // The header and exactly the 1,200 rows of the snapshot, each once.
    assert_eq!(parsed.len(), 1201);
    assert_eq!(distinct.len(), 1201, "a row was repeated");
    assert!(!distinct.contains("Newcomer"));
    for i in 1..=1200 {
        assert!(
            distinct.contains(format!("Row {i}").as_str()),
            "Row {i} missing"
        );
    }
}
