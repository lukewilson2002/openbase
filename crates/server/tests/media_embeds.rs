//! Media embeds in long text: files named by address (`/api/attachments/<id>/<name>`) must
//! belong to the record's project, survive the attachment cleanup, are served inline (video and
//! audio with `Range` support), and move out of the inbox when a draft that embeds them is
//! filed.

mod common;
mod records_support;
mod schema_support;

use axum::body::Body;
use axum::http::{Request, header};
use common::{Client, Response, TestApp};
use records_support::*;
use serde_json::json;

const BOUNDARY: &str = "----media-embeds-boundary";

fn multipart(filename: &str, data: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(
        format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
             Content-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    body
}

fn request(who: &Client, method: &str, uri: &str) -> axum::http::request::Builder {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(c) = &who.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", openbase::auth::SESSION_COOKIE, c),
        );
    }
    if let Some(t) = &who.bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    req.header(openbase::http::CSRF_HEADER, "1")
}

async fn post_file(app: &TestApp, who: &Client, uri: &str, name: &str, data: &[u8]) -> Response {
    let req = request(who, "POST", uri)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={BOUNDARY}"),
        )
        .body(Body::from(multipart(name, data)))
        .unwrap();
    app.send(req).await
}

/// Upload into a project; returns the attachment id.
async fn upload(f: &Fixture, base: &str, name: &str, data: &[u8]) -> String {
    let r = post_file(
        &f.app,
        &f.owner,
        &format!("/api/bases/{base}/attachments"),
        name,
        data,
    )
    .await;
    r.assert_status(200);
    r.body["id"].as_str().unwrap().to_string()
}

/// Upload into the caller's inbox; returns the attachment id.
async fn inbox_upload(app: &TestApp, who: &Client, name: &str, data: &[u8]) -> String {
    let r = post_file(app, who, "/api/inbox/attachments", name, data).await;
    r.assert_status(200);
    r.body["id"].as_str().unwrap().to_string()
}

async fn get_range(app: &TestApp, who: &Client, path: &str, range: Option<&str>) -> Response {
    let mut req = request(who, "GET", path);
    if let Some(r) = range {
        req = req.header(header::RANGE, r);
    }
    app.send(req.body(Body::empty()).unwrap()).await
}

fn embed(id: &str, name: &str) -> String {
    format!("![A caption](/api/attachments/{id}/{name} \"Title\")")
}

fn message(r: &Response) -> String {
    r.body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn header_str<'a>(res: &'a Response, name: &str) -> &'a str {
    res.headers
        .get(name)
        .unwrap_or_else(|| panic!("missing header {name}"))
        .to_str()
        .unwrap()
}

/// `len` bytes that start like an MP4 file and then count up, so ranges can be checked.
fn mp4(len: usize) -> Vec<u8> {
    let mut v = vec![0, 0, 0, 0x18];
    v.extend_from_slice(b"ftypisom\0\0\x02\0isomiso2mp41");
    while v.len() < len {
        v.push((v.len() % 251) as u8);
    }
    v.truncate(len);
    v
}

fn webm() -> Vec<u8> {
    let mut v = vec![0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x82, 0x84];
    v.extend_from_slice(b"webm");
    v.extend_from_slice(&[0; 40]);
    v
}

/// A second project in the fixture's workspace.
async fn other_base(f: &Fixture) -> (String, String) {
    let b = schema_support::base(&f.app, &f.owner, &f.ws, "Elsewhere").await;
    (
        b["id"].as_str().unwrap().to_string(),
        b["tables"][0]["id"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn long_text_may_only_embed_files_of_its_own_project() {
    let f = Fixture::new().await;
    let (other, _) = other_base(&f).await;
    let own = upload(&f, &f.base_id, "own.png", b"own").await;
    let foreign = upload(&f, &other, "foreign.png", b"foreign").await;
    let notes = |t: &str| json!({ &f.primary_id: "r", &f.notes_id: t });

    // Create: own file accepted (embed and plain link), foreign refused, naming the id.
    let ok = f
        .create_as(
            &f.owner,
            &f.table_id,
            notes(&format!(
                "{}\n\n[doc](/api/attachments/{own}/own.png)",
                embed(&own, "own.png")
            )),
        )
        .await;
    ok.assert_status(201);
    let bad = f
        .create_as(
            &f.owner,
            &f.table_id,
            notes(&embed(&foreign, "foreign.png")),
        )
        .await;
    bad.assert_status(400);
    let m = message(&bad);
    assert!(
        m.contains(&foreign) && m.contains("is not a file of this project"),
        "{m}"
    );
    assert!(m.contains("Notes"), "{m}");

    // A missing file is refused like a foreign one.
    let missing = "attAAAAAAAAAAAAAA";
    f.create_as(&f.owner, &f.table_id, notes(&embed(missing, "x.png")))
        .await
        .assert_status(400);

    // A bare id in prose is not a reference.
    f.create_as(
        &f.owner,
        &f.table_id,
        notes(&format!("see {foreign} and /api/attachments/{foreign}")),
    )
    .await
    .assert_status(201);

    // Update: same rules.
    let rec = id_str(&ok.body["records"][0]["id"]).to_string();
    f.patch_as(
        &f.owner,
        &f.table_id,
        &rec,
        json!({ &f.notes_id: embed(&foreign, "foreign.png") }),
    )
    .await
    .assert_status(400);
    f.patch_as(
        &f.owner,
        &f.table_id,
        &rec,
        json!({ &f.notes_id: embed(missing, "x.png") }),
    )
    .await
    .assert_status(400);
    f.patch_as(
        &f.owner,
        &f.table_id,
        &rec,
        json!({ &f.notes_id: embed(&own, "own.png") }),
    )
    .await
    .assert_status(200);

    // An inbox upload is nobody's project file either.
    let inbox = inbox_upload(&f.app, &f.owner, "inbox.png", b"inbox").await;
    f.create_as(&f.owner, &f.table_id, notes(&embed(&inbox, "inbox.png")))
        .await
        .assert_status(400);
}

#[tokio::test]
async fn references_a_value_already_holds_do_not_block_other_edits() {
    let f = Fixture::new().await;
    let (other, _) = other_base(&f).await;
    let foreign = upload(&f, &other, "foreign.png", b"foreign").await;
    // A legacy value with a foreign reference (written behind the API's back).
    let text = embed(&foreign, "foreign.png");
    let rec = f.insert_record(&f.table_id, json!({ &f.notes_id: text }));
    let edited = format!("{text}\nmore words");
    f.patch_as(&f.owner, &f.table_id, &rec, json!({ &f.notes_id: edited }))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn the_v1_api_and_csv_import_apply_the_same_rule() {
    let f = Fixture::new().await;
    let (other, _) = other_base(&f).await;
    let foreign = upload(&f, &other, "foreign.png", b"foreign").await;
    let text = embed(&foreign, "foreign.png");
    let token = f
        .app
        .api_token(&f.owner, json!({ "name": "t", "write": true }))
        .await;
    let r = f
        .app
        .post(
            &token,
            &format!("/api/v1/{}/{}", f.base_id, f.table_id),
            json!({ "records": [ { "fields": { "Notes": text } } ] }),
        )
        .await;
    // The Airtable-style API answers value errors with 422.
    r.assert_status(422);
    assert!(message(&r).contains(&foreign), "{}", message(&r));
    // CSV import goes through the same write path (all or nothing).
    let csv = format!("Name,Notes\nr,\"{}\"\n", text.replace('"', "\"\""));
    let r = post_file(
        &f.app,
        &f.owner,
        &format!("/api/tables/{}/import", f.table_id),
        "data.csv",
        csv.as_bytes(),
    )
    .await;
    assert!(r.status.is_client_error(), "{} {:?}", r.status, r.body);
    assert!(r.body.to_string().contains(&foreign), "{:?}", r.body);
}

#[tokio::test]
async fn comments_obey_the_same_rule() {
    let f = Fixture::new().await;
    let (other, _) = other_base(&f).await;
    let own = upload(&f, &f.base_id, "own.png", b"own").await;
    let foreign = upload(&f, &other, "foreign.png", b"foreign").await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "r" })).await;
    let url = format!("/api/records/{}/comments", id_str(&rec["id"]));
    f.app
        .post(
            &f.owner,
            &url,
            json!({ "body": embed(&foreign, "foreign.png") }),
        )
        .await
        .assert_status(400);
    let ok = f
        .app
        .post(&f.owner, &url, json!({ "body": embed(&own, "own.png") }))
        .await;
    ok.assert_status(201);
    let cid = ok.body["id"].as_str().unwrap();
    f.app
        .patch(
            &f.owner,
            &format!("/api/comments/{cid}"),
            json!({ "body": embed(&foreign, "foreign.png") }),
        )
        .await
        .assert_status(400);
}

#[tokio::test]
async fn duplicating_a_project_copies_the_files_its_text_embeds() {
    let f = Fixture::new().await;
    let own = upload(&f, &f.base_id, "own.png", b"own").await;
    f.create(
        &f.table_id,
        json!({ &f.primary_id: "r", &f.notes_id: embed(&own, "own.png") }),
    )
    .await;
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/bases/{}/duplicate", f.base_id),
            json!({ "include_records": true }),
        )
        .await;
    r.assert_status(201);
    let copy = id_str(&r.body["id"]).to_string();
    let dump = dump_records(&f.app, &copy);
    let text = dump
        .values()
        .find_map(|(_, d, _)| {
            d.as_object()?
                .values()
                .find_map(|v| v.as_str().filter(|s| s.contains("/api/attachments/")))
        })
        .expect("the copied note")
        .to_string();
    assert!(!text.contains(&own), "{text}");
    let new_id = openbase::store::attachments::referenced_ids(&text).remove(0);
    let n: i64 = sql(&f.app, |tx| {
        tx.query_row(
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id = ?2",
            [&new_id, &copy],
            |r| r.get(0),
        )
    });
    assert_eq!(n, 1, "the copy has its own row");
}

#[tokio::test]
async fn a_file_referenced_only_from_long_text_survives_the_cleanup() {
    let f = Fixture::new().await;
    let kept = upload(&f, &f.base_id, "kept.png", b"kept").await;
    let lost = upload(&f, &f.base_id, "lost.png", b"lost").await;
    f.create(
        &f.table_id,
        json!({ &f.primary_id: "r", &f.notes_id: embed(&kept, "kept.png") }),
    )
    .await;
    let far = openbase::db::now_ms() + 10_000_000;
    let deleted = sql(&f.app, |tx| {
        Ok(openbase::store::attachments::delete_unreferenced(tx, far, far).unwrap())
    });
    assert_eq!(deleted.len(), 1);
    let exists = |id: &str| {
        f.app
            .query_i64("SELECT count(*) FROM attachments WHERE id = ?1", &[id])
            == 1
    };
    assert!(exists(&kept));
    assert!(!exists(&lost));
}

#[tokio::test]
async fn video_and_audio_are_served_inline_with_their_sniffed_type() {
    let f = Fixture::new().await;
    let mut ogg = b"OggS\0\x02".to_vec();
    ogg.extend_from_slice(&[0; 20]);
    ogg.extend_from_slice(b"\x01vorbis");
    let mut wav = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
    wav.extend_from_slice(&[0; 20]);
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("clip.mp4", mp4(200), "video/mp4"),
        ("clip.webm", webm(), "video/webm"),
        (
            "song.m4a",
            {
                let mut v = vec![0, 0, 0, 0x14];
                v.extend_from_slice(b"ftypM4A \0\0\0\0M4A isom");
                v
            },
            "audio/mp4",
        ),
        (
            "movie.mov",
            {
                let mut v = vec![0, 0, 0, 0x14];
                v.extend_from_slice(b"ftypqt  \0\0\0\0qt  ");
                v
            },
            "video/quicktime",
        ),
        ("a.ogg", ogg, "audio/ogg"),
        ("a.wav", wav, "audio/wav"),
        ("a.flac", b"fLaC\0\0\0\"rest".to_vec(), "audio/flac"),
        ("a.mp3", b"ID3\x04\0\0\0\0\0\0rest".to_vec(), "audio/mpeg"),
        ("b.mp3", vec![0xFF, 0xFB, 0x90, 0x00, 1, 2, 3], "audio/mpeg"),
    ];
    for (name, data, ctype) in cases {
        let id = upload(&f, &f.base_id, name, &data).await;
        let dl = get_range(
            &f.app,
            &f.owner,
            &format!("/api/attachments/{id}/{name}"),
            None,
        )
        .await;
        dl.assert_status(200);
        assert_eq!(header_str(&dl, "content-type"), ctype, "{name}");
        assert!(
            header_str(&dl, "content-disposition").starts_with("inline;"),
            "{name}"
        );
        assert_eq!(header_str(&dl, "accept-ranges"), "bytes");
        assert_eq!(header_str(&dl, "x-content-type-options"), "nosniff");
        assert_eq!(
            header_str(&dl, "content-security-policy"),
            "sandbox; default-src 'none'"
        );
        assert_eq!(header_str(&dl, "cache-control"), "private, max-age=86400");
        assert_eq!(dl.bytes, data, "{name}");
    }

    // Still attachments: the name or the stored type never decides, only the bytes.
    let not_media: Vec<(&str, &[u8])> = vec![
        (
            "logo.svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>1</script></svg>",
        ),
        ("page.html", b"<html><script>1</script></html>"),
        ("doc.pdf", b"%PDF-1.7 fake"),
        ("fake.mp4", b"<html><script>1</script></html>"),
        ("fake.mp3", b"just some text"),
        // An HEIC/AVIF-style ISO file is not playable media.
        ("pic.avif", b"\0\0\0\x14ftypavif\0\0\0\0avifmif1"),
    ];
    for (name, data) in not_media {
        let id = upload(&f, &f.base_id, name, data).await;
        let dl = get_range(
            &f.app,
            &f.owner,
            &format!("/api/attachments/{id}/{name}"),
            None,
        )
        .await;
        dl.assert_status(200);
        assert_eq!(
            header_str(&dl, "content-type"),
            "application/octet-stream",
            "{name}"
        );
        assert!(
            header_str(&dl, "content-disposition").starts_with("attachment;"),
            "{name}"
        );
    }
}

#[tokio::test]
async fn range_requests_get_partial_content() {
    let f = Fixture::new().await;
    let data = mp4(1000);
    let id = upload(&f, &f.base_id, "clip.mp4", &data).await;
    let path = format!("/api/attachments/{id}/clip.mp4");
    let get = |range: Option<&'static str>| get_range(&f.app, &f.owner, &path, range);

    let r = get(Some("bytes=0-9")).await;
    r.assert_status(206);
    assert_eq!(r.bytes, &data[..10]);
    assert_eq!(header_str(&r, "content-range"), "bytes 0-9/1000");
    assert_eq!(header_str(&r, "content-length"), "10");
    assert_eq!(header_str(&r, "content-type"), "video/mp4");
    assert_eq!(header_str(&r, "accept-ranges"), "bytes");
    assert_eq!(header_str(&r, "x-content-type-options"), "nosniff");
    assert_eq!(header_str(&r, "cache-control"), "private, max-age=86400");

    let r = get(Some("bytes=-5")).await;
    r.assert_status(206);
    assert_eq!(r.bytes, &data[995..]);
    assert_eq!(header_str(&r, "content-range"), "bytes 995-999/1000");

    let r = get(Some("bytes=990-")).await;
    r.assert_status(206);
    assert_eq!(r.bytes, &data[990..]);
    assert_eq!(header_str(&r, "content-range"), "bytes 990-999/1000");

    // An end past the file is clamped; a suffix longer than the file is the whole file.
    let r = get(Some("bytes=500-99999")).await;
    r.assert_status(206);
    assert_eq!(r.bytes, &data[500..]);
    assert_eq!(header_str(&r, "content-range"), "bytes 500-999/1000");
    let r = get(Some("bytes=-5000")).await;
    r.assert_status(206);
    assert_eq!(r.bytes, data);
    assert_eq!(header_str(&r, "content-range"), "bytes 0-999/1000");

    // Nothing of the file in the range.
    for range in ["bytes=1000-", "bytes=5000-6000", "bytes=-0"] {
        let r = get(Some(range)).await;
        r.assert_status(416);
        assert_eq!(header_str(&r, "content-range"), "bytes */1000", "{range}");
        assert!(r.bytes.is_empty());
    }

    // Unsupported or malformed: the whole file.
    for range in [
        "bytes=0-1,5-6",
        "items=0-1",
        "bytes=9-3",
        "bytes=abc",
        "bytes=-",
        "bytes=0-1x",
    ] {
        let r = get(Some(range)).await;
        r.assert_status(200);
        assert_eq!(r.bytes, data, "{range}");
        assert_eq!(header_str(&r, "accept-ranges"), "bytes");
    }
    let r = get(None).await;
    r.assert_status(200);
    assert_eq!(header_str(&r, "content-length"), "1000");
}

#[tokio::test]
async fn share_links_serve_files_embedded_in_visible_long_text() {
    let f = Fixture::new().await;
    let data = mp4(300);
    let shown = upload(&f, &f.base_id, "clip.mp4", &data).await;
    let hidden = upload(&f, &f.base_id, "hidden.mp4", &mp4(300)).await;
    f.create(
        &f.table_id,
        json!({ &f.primary_id: "r", &f.notes_id: embed(&shown, "clip.mp4") }),
    )
    .await;
    let token = openbase::ids::new_token("shr_");
    let (t, view) = (token.clone(), f.view_id.clone());
    sql(&f.app, |tx| {
        tx.execute(
            "INSERT INTO share_links (id, token, kind, view_id, enabled, created_at)
             VALUES (?1, ?2, 'view', ?3, 1, ?4)",
            rusqlite::params![
                openbase::ids::new_id(ob_core::ids::SHARE),
                t,
                view,
                openbase::db::now_ms()
            ],
        )
    });
    let anon = f.app.anon();
    let r = get_range(
        &f.app,
        &anon,
        &format!("/api/attachments/{shown}/clip.mp4?share={token}"),
        Some("bytes=0-9"),
    )
    .await;
    r.assert_status(206);
    assert_eq!(r.bytes, &data[..10]);
    assert_eq!(header_str(&r, "content-type"), "video/mp4");
    // Only what the shared records show.
    get_range(
        &f.app,
        &anon,
        &format!("/api/attachments/{hidden}/hidden.mp4?share={token}"),
        None,
    )
    .await
    .assert_status(404);
    get_range(
        &f.app,
        &anon,
        &format!("/api/attachments/{shown}/clip.mp4"),
        None,
    )
    .await
    .assert_status(404);
}

// ----------------------------------------------------------------------------------- inbox

async fn add_draft(f: &Fixture, body: &str) -> Response {
    f.app
        .post(&f.owner, "/api/inbox", json!({ "body": body }))
        .await
}

#[tokio::test]
async fn filing_moves_the_inbox_uploads_a_long_text_value_embeds() {
    let f = Fixture::new().await;
    let photo = inbox_upload(&f.app, &f.owner, "photo.png", b"photo").await;
    let draft = add_draft(&f, &format!("trip\n\n{}", embed(&photo, "photo.png"))).await;
    draft.assert_status(201);
    let did = id_str(&draft.body["id"]).to_string();
    let viewer = f.member("viewer@example.com", openbase::perm::Role::Viewer);
    f.app
        .get(&viewer, &format!("/api/attachments/{photo}/photo.png"))
        .await
        .assert_status(404);

    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{did}/file"),
            json!({ "table_id": f.table_id, "fields": {
                "Name": "Trip", "Notes": embed(&photo, "photo.png") } }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(
        f.app.query_i64(
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id = ?2",
            &[&photo, &f.base_id]
        ),
        1
    );
    f.app
        .get(&viewer, &format!("/api/attachments/{photo}/photo.png"))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn filing_moves_the_uploads_the_note_comment_embeds() {
    let f = Fixture::new().await;
    let photo = inbox_upload(&f.app, &f.owner, "photo.png", b"photo").await;
    let draft = add_draft(&f, &embed(&photo, "photo.png")).await;
    let did = id_str(&draft.body["id"]).to_string();
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{did}/file"),
            json!({ "table_id": f.table_id, "fields": { "Name": "Trip" }, "note_as_comment": true }),
        )
        .await;
    r.assert_status(201);
    assert_eq!(
        f.app.query_i64(
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id = ?2",
            &[&photo, &f.base_id]
        ),
        1
    );
    let comments = f
        .app
        .get(
            &f.owner,
            &format!("/api/records/{}/comments", id_str(&r.body["id"])),
        )
        .await;
    assert!(comments.body[0]["body"].as_str().unwrap().contains(&photo));
}

#[tokio::test]
async fn a_filing_that_embeds_someone_elses_inbox_upload_fails_whole() {
    let f = Fixture::new().await;
    let other = f.member("other@example.com", openbase::perm::Role::Editor);
    let theirs = inbox_upload(&f.app, &other, "theirs.png", b"theirs").await;
    let draft = add_draft(&f, "mine").await;
    let did = id_str(&draft.body["id"]).to_string();
    let r = f
        .app
        .post(
            &f.owner,
            &format!("/api/inbox/{did}/file"),
            json!({ "table_id": f.table_id, "fields": {
                "Name": "x", "Notes": embed(&theirs, "theirs.png") } }),
        )
        .await;
    r.assert_status(400);
    assert!(message(&r).contains(&theirs), "{}", message(&r));
    // Nothing moved, and the draft is still there.
    assert_eq!(
        f.app.query_i64(
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id IS NULL",
            &[&theirs]
        ),
        1
    );
    f.app
        .get(&f.owner, "/api/inbox")
        .await
        .body
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["id"] == did.as_str())
        .then_some(())
        .expect("draft kept");
}

#[tokio::test]
async fn a_draft_body_may_only_embed_the_callers_unattached_uploads() {
    let f = Fixture::new().await;
    let other = f.member("other@example.com", openbase::perm::Role::Editor);
    let theirs = inbox_upload(&f.app, &other, "theirs.png", b"theirs").await;
    let project_file = upload(&f, &f.base_id, "proj.png", b"proj").await;
    let mine = inbox_upload(&f.app, &f.owner, "mine.png", b"mine").await;

    // Another user's upload, a project file and a missing file are all refused.
    for id in [theirs.as_str(), project_file.as_str(), "attAAAAAAAAAAAAAA"] {
        let r = add_draft(&f, &embed(id, "x.png")).await;
        r.assert_status(400);
        assert!(message(&r).contains(id), "{}", message(&r));
    }

    // Own upload: fine on create and on edit.
    let ok = add_draft(&f, &embed(&mine, "mine.png")).await;
    ok.assert_status(201);
    let did = id_str(&ok.body["id"]).to_string();
    let r = f
        .app
        .patch(
            &f.owner,
            &format!("/api/inbox/{did}"),
            json!({ "body": embed(&theirs, "theirs.png") }),
        )
        .await;
    r.assert_status(400);

    // A file is in one draft only, whether listed or embedded.
    let r = add_draft(&f, &embed(&mine, "mine.png")).await;
    r.assert_status(400);
    assert!(
        message(&r).contains("already in another draft"),
        "{}",
        message(&r)
    );
    let listed = f
        .app
        .post(
            &f.owner,
            "/api/inbox",
            json!({ "attachments": [ { "id": mine, "filename": "mine.png", "mime": "image/png", "size": 4 } ] }),
        )
        .await;
    listed.assert_status(400);
    // Editing the owning draft keeps working.
    f.app
        .patch(
            &f.owner,
            &format!("/api/inbox/{did}"),
            json!({ "body": format!("{} again", embed(&mine, "mine.png")) }),
        )
        .await
        .assert_status(200);
}

#[tokio::test]
async fn files_embedded_in_draft_text_survive_the_cleanup() {
    let f = Fixture::new().await;
    let kept = inbox_upload(&f.app, &f.owner, "kept.png", b"kept").await;
    let lost = inbox_upload(&f.app, &f.owner, "lost.png", b"lost").await;
    add_draft(&f, &embed(&kept, "kept.png"))
        .await
        .assert_status(201);
    let far = openbase::db::now_ms() + 10_000_000;
    let deleted = sql(&f.app, |tx| {
        Ok(openbase::store::attachments::delete_unreferenced(tx, far, far).unwrap())
    });
    assert_eq!(deleted.len(), 1);
    let exists = |id: &str| {
        f.app
            .query_i64("SELECT count(*) FROM attachments WHERE id = ?1", &[id])
            == 1
    };
    assert!(exists(&kept));
    assert!(!exists(&lost));
}

// ------------------------------------------------------------ foreign references and copies

#[tokio::test]
async fn duplicating_a_project_never_copies_a_file_of_another_project() {
    let f = Fixture::new().await;
    let (other, _) = other_base(&f).await;
    let foreign = upload(&f, &other, "foreign.png", b"foreign").await;
    let inbox = inbox_upload(&f.app, &f.owner, "inbox.png", b"inbox").await;
    let own = upload(&f, &f.base_id, "own.png", b"own").await;
    // Bob may copy A only; he must not get B's files through the copy.
    let bob = f.base_guest("bob@example.com", openbase::perm::Role::Creator);
    let files = f
        .add_field(
            &f.table_id,
            json!({ "name": "Files", "type": "attachment", "options": {} }),
        )
        .await;
    let files_id = id_str(&files["id"]).to_string();
    let cell =
        |id: &str| json!([{ "id": id, "filename": "x.png", "mime": "image/png", "size": 1 }]);
    // References written behind the API's back (old data, or a type change).
    let text = format!(
        "{} {} {}",
        embed(&foreign, "foreign.png"),
        embed(&inbox, "inbox.png"),
        embed(&own, "own.png")
    );
    f.insert_record(
        &f.table_id,
        json!({ &f.primary_id: "r", &f.notes_id: text, &files_id: cell(&foreign) }),
    );
    let r = f
        .app
        .post(
            &bob,
            &format!("/api/bases/{}/duplicate", f.base_id),
            json!({ "include_records": true }),
        )
        .await;
    r.assert_status(201);
    let copy = id_str(&r.body["id"]).to_string();

    // Only A's own file got a copy.
    let copied: i64 = f.app.query_i64(
        "SELECT count(*) FROM attachments WHERE base_id = ?1",
        &[&copy],
    );
    assert_eq!(copied, 1, "only the project's own file is copied");
    let dump = dump_records(&f.app, &copy);
    let (_, data, _) = dump.values().next().expect("the copied record");
    let note = data
        .as_object()
        .unwrap()
        .values()
        .find_map(|v| v.as_str().filter(|s| s.contains("/api/attachments/")))
        .expect("the copied note");
    // Foreign references are left as they were: they do not load in the copy either.
    assert!(note.contains(&foreign) && note.contains(&inbox), "{note}");
    assert!(!note.contains(&own), "{note}");
    // The attachment cell naming a foreign file is dropped.
    assert!(!data.to_string().contains("\"filename\""), "{data}");
    // Bob can open neither file.
    for (id, name) in [(&foreign, "foreign.png"), (&inbox, "inbox.png")] {
        f.app
            .get(&bob, &format!("/api/attachments/{id}/{name}"))
            .await
            .assert_status(404);
    }
}

#[tokio::test]
async fn converting_a_field_to_long_text_refuses_references_to_foreign_files() {
    let f = Fixture::new().await;
    let (other, _) = other_base(&f).await;
    let foreign = upload(&f, &other, "foreign.png", b"foreign").await;
    let own = upload(&f, &f.base_id, "own.png", b"own").await;
    let bob = f.base_guest("bob@example.com", openbase::perm::Role::Creator);
    let tag = f
        .add_field(
            &f.table_id,
            json!({ "name": "Tag", "type": "single_line_text", "options": {} }),
        )
        .await;
    let tag_id = id_str(&tag["id"]).to_string();
    let mine = f
        .create_as(
            &bob,
            &f.table_id,
            json!({ &tag_id: embed(&own, "own.png") }),
        )
        .await;
    mine.assert_status(201);
    let theirs = f
        .create_as(
            &bob,
            &f.table_id,
            json!({ &tag_id: embed(&foreign, "foreign.png") }),
        )
        .await;
    theirs.assert_status(201);
    let their_id = id_str(&theirs.body["records"][0]["id"]).to_string();

    let url = format!("/api/fields/{tag_id}");
    let convert = || {
        f.app
            .patch(&bob, &url, json!({ "type": "long_text", "options": {} }))
    };
    let r = convert().await;
    r.assert_status(400);
    let m = message(&r);
    assert!(
        m.contains(&foreign) && m.contains("Tag") && m.contains(&their_id),
        "{m}"
    );
    assert!(m.contains("not files of this project"), "{m}");
    // Nothing changed.
    let table = f.table(&f.table_id).await;
    let kind = table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["id"] == tag_id.as_str())
        .unwrap()["type"]
        .clone();
    assert_eq!(kind, "single_line_text");

    // Once the stray reference is gone the conversion goes through.
    f.patch_as(&bob, &f.table_id, &their_id, json!({ &tag_id: "plain" }))
        .await
        .assert_status(200);
    convert().await.assert_status(200);
}

#[tokio::test]
async fn a_file_referenced_only_from_a_comment_survives_the_cleanup() {
    let f = Fixture::new().await;
    let commented = upload(&f, &f.base_id, "commented.png", b"commented").await;
    let lost = upload(&f, &f.base_id, "lost.png", b"lost").await;
    let rec = f.create(&f.table_id, json!({ &f.primary_id: "r" })).await;
    f.app
        .post(
            &f.owner,
            &format!("/api/records/{}/comments", id_str(&rec["id"])),
            json!({ "body": embed(&commented, "commented.png") }),
        )
        .await
        .assert_status(201);

    // A draft filed as a comment moves its upload into the project, where only the comment
    // names it.
    let photo = inbox_upload(&f.app, &f.owner, "photo.png", b"photo").await;
    let draft = add_draft(&f, &embed(&photo, "photo.png")).await;
    let did = id_str(&draft.body["id"]).to_string();
    f.app
        .post(
            &f.owner,
            &format!("/api/inbox/{did}/file"),
            json!({ "table_id": f.table_id, "fields": { "Name": "Trip" }, "note_as_comment": true }),
        )
        .await
        .assert_status(201);

    let far = openbase::db::now_ms() + 10_000_000;
    let deleted = sql(&f.app, |tx| {
        Ok(openbase::store::attachments::delete_unreferenced(tx, far, far).unwrap())
    });
    assert_eq!(deleted.len(), 1);
    let exists = |id: &str| {
        f.app
            .query_i64("SELECT count(*) FROM attachments WHERE id = ?1", &[id])
            == 1
    };
    assert!(exists(&commented));
    assert!(exists(&photo));
    assert!(!exists(&lost));
}

#[tokio::test]
async fn a_share_opens_only_files_embedded_in_what_the_shared_view_shows() {
    let f = Fixture::new().await;
    let secret_field = f
        .add_field(
            &f.table_id,
            json!({ "name": "Secret", "type": "long_text", "options": {} }),
        )
        .await;
    let secret_id = id_str(&secret_field["id"]).to_string();
    let up = |name: &'static str| upload(&f, &f.base_id, name, name.as_bytes());
    let (shown, both, hidden, filtered, trashed, loose) = (
        up("shown.png").await,
        up("both.png").await,
        up("hidden.png").await,
        up("filtered.png").await,
        up("trashed.png").await,
        up("loose.png").await,
    );
    let rec = |name: &str, notes: String, secret: String| json!({ &f.primary_id: name, &f.notes_id: notes, &secret_id: secret });
    let keep = f
        .create(
            &f.table_id,
            rec(
                "keep",
                format!(
                    "{} {}",
                    embed(&shown, "shown.png"),
                    embed(&both, "both.png")
                ),
                embed(&hidden, "hidden.png"),
            ),
        )
        .await;
    let keep = id_str(&keep["id"]).to_string();
    f.create(
        &f.table_id,
        rec(
            "drop",
            format!(
                "{} {}",
                embed(&filtered, "filtered.png"),
                embed(&both, "both.png")
            ),
            String::new(),
        ),
    )
    .await;
    let gone = f
        .create(
            &f.table_id,
            rec(
                "keep trashed",
                embed(&trashed, "trashed.png"),
                String::new(),
            ),
        )
        .await;
    f.delete_records(&f.table_id, &[id_str(&gone["id"])])
        .await
        .assert_status(204);
    let view = f
        .app
        .post(
            &f.owner,
            &format!("/api/tables/{}/views", f.table_id),
            json!({ "name": "Public", "type": "grid", "config": {
                "filter": { "conjunction": "and", "items": [
                    { "field_id": f.primary_id, "op": "contains", "value": "keep" } ] },
                "hidden_fields": [secret_id],
            } }),
        )
        .await;
    view.assert_status(201);
    let token = openbase::ids::new_token("shr_");
    let (t, view_id) = (token.clone(), id_str(&view.body["id"]).to_string());
    sql(&f.app, |tx| {
        tx.execute(
            "INSERT INTO share_links (id, token, kind, view_id, enabled, created_at)
             VALUES (?1, ?2, 'view', ?3, 1, ?4)",
            rusqlite::params![
                openbase::ids::new_id(ob_core::ids::SHARE),
                t,
                view_id,
                openbase::db::now_ms()
            ],
        )
    });
    let anon = f.app.anon();
    let status = |id: &str, name: &str| {
        let path = format!("/api/attachments/{id}/{name}?share={token}");
        let (app, anon) = (&f.app, &anon);
        async move { get_range(app, anon, &path, None).await.status.as_u16() }
    };
    assert_eq!(status(&shown, "shown.png").await, 200);
    // In a shown record too, though also in a filtered-out one.
    assert_eq!(status(&both, "both.png").await, 200);
    assert_eq!(status(&hidden, "hidden.png").await, 404, "hidden field");
    assert_eq!(status(&filtered, "filtered.png").await, 404, "filtered out");
    assert_eq!(status(&trashed, "trashed.png").await, 404, "trashed record");
    assert_eq!(status(&loose, "loose.png").await, 404, "in no record");

    // Editing the record closes the download at once.
    f.patch_as(
        &f.owner,
        &f.table_id,
        &keep,
        json!({ &f.notes_id: "no files" }),
    )
    .await
    .assert_status(200);
    assert_eq!(status(&shown, "shown.png").await, 404);
}

#[tokio::test]
async fn filing_cannot_take_a_file_out_from_under_another_drafts_text() {
    let f = Fixture::new().await;
    let photo = inbox_upload(&f.app, &f.owner, "photo.png", b"photo").await;
    let holder = add_draft(&f, &embed(&photo, "photo.png")).await;
    holder.assert_status(201);
    let mine = add_draft(&f, "my own note").await;
    let did = id_str(&mine.body["id"]).to_string();
    let url = format!("/api/inbox/{did}/file");
    let records = |f: &Fixture| {
        f.app.query_i64(
            "SELECT count(*) FROM records WHERE table_id = ?1",
            &[&f.table_id],
        )
    };
    let still_unattached = |f: &Fixture| {
        f.app.query_i64(
            "SELECT count(*) FROM attachments WHERE id = ?1 AND base_id IS NULL",
            &[&photo],
        ) == 1
    };

    // A long text value of the filing names the other draft's file.
    let r = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "table_id": f.table_id, "fields": {
                "Name": "x", "Notes": embed(&photo, "photo.png") } }),
        )
        .await;
    r.assert_status(400);
    assert!(
        message(&r).contains(&photo) && message(&r).contains("already in another draft"),
        "{}",
        message(&r)
    );
    assert!(still_unattached(&f));
    assert_eq!(records(&f), 0);

    // So does the draft's own text, filed as a comment (written behind the API's back, as
    // an old draft might hold it).
    let body = embed(&photo, "photo.png");
    sql(&f.app, |tx| {
        tx.execute(
            "UPDATE inbox_items SET body = ?2 WHERE id = ?1",
            [&did, &body],
        )
    });
    let r = f
        .app
        .post(
            &f.owner,
            &url,
            json!({ "table_id": f.table_id, "fields": { "Name": "x" }, "note_as_comment": true }),
        )
        .await;
    r.assert_status(400);
    assert!(
        message(&r).contains("already in another draft"),
        "{}",
        message(&r)
    );
    assert!(still_unattached(&f));
    assert_eq!(records(&f), 0);
}

#[tokio::test]
async fn video_and_audio_are_never_compressed() {
    let f = Fixture::new().await;
    // Long enough for the compression layer's size threshold.
    let data = mp4(5000);
    let id = upload(&f, &f.base_id, "clip.mp4", &data).await;
    let gzip = |path: String| {
        request(&f.owner, "GET", &path)
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap()
    };
    let r = f
        .app
        .send(gzip(format!("/api/attachments/{id}/clip.mp4")))
        .await;
    r.assert_status(200);
    assert_eq!(header_str(&r, "content-type"), "video/mp4");
    assert!(
        r.headers.get("content-encoding").is_none(),
        "{:?}",
        r.headers
    );
    assert_eq!(header_str(&r, "accept-ranges"), "bytes");
    assert_eq!(r.bytes, data);

    // Everything else still is: JSON compresses.
    let r = f.app.send(gzip(format!("/api/bases/{}", f.base_id))).await;
    r.assert_status(200);
    assert_eq!(header_str(&r, "content-encoding"), "gzip");
}
