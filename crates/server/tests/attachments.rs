//! Attachment upload/download through the real router: storage, limits,
//! content-type safety, permissions and share-link access.

mod common;

use axum::body::Body;
use axum::http::{Request, header};
use common::{Client, Response, TestApp};
use opengrid::db::now_ms;
use opengrid::ids::new_id;
use sha2::{Digest, Sha256};

const BOUNDARY: &str = "----opengridtestboundary7MA4YWxkTrZu0gW";

/// Ids of the rows created by [`Fixture::new`].
struct Fixture {
    owner: Client,
    base: String,
    view: String,
}

impl Fixture {
    /// A workspace (owned by a fresh user) with one base, table and view.
    fn new(app: &TestApp) -> Fixture {
        let owner = app.user("owner@example.com", "Owner");
        let owner_id = owner.user_id.clone().unwrap();
        let (base, view) = create_base(app, &owner_id);
        Fixture { owner, base, view }
    }
}

/// Insert workspace -> base -> table -> view rows owned by `owner_id`.
fn create_base(app: &TestApp, owner_id: &str) -> (String, String) {
    let owner_id = owner_id.to_string();
    app.state
        .db
        .write_sync(|tx| {
            let now = now_ms();
            let ws = new_id(og_core::ids::WORKSPACE);
            let base = new_id(og_core::ids::BASE);
            let table = new_id(og_core::ids::TABLE);
            let view = new_id(og_core::ids::VIEW);
            tx.execute(
                "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?1, 'WS', ?2, ?3)",
                rusqlite::params![ws, owner_id, now],
            )?;
            tx.execute(
                "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)",
                rusqlite::params![ws, owner_id, now],
            )?;
            tx.execute(
                "INSERT INTO bases (id, workspace_id, name, created_at) VALUES (?1, ?2, 'Base', ?3)",
                rusqlite::params![base, ws, now],
            )?;
            tx.execute(
                "INSERT INTO tables (id, base_id, name, primary_field_id, created_at) VALUES (?1, ?2, 'T', 'fldPrimary', ?3)",
                rusqlite::params![table, base, now],
            )?;
            tx.execute(
                "INSERT INTO views (id, table_id, name, type, created_at) VALUES (?1, ?2, 'Grid', 'grid', ?3)",
                rusqlite::params![view, table, now],
            )?;
            Ok((base, view))
        })
        .unwrap()
}

fn grant(app: &TestApp, base: &str, user: &Client, role: &str) {
    let (base, uid, role) = (
        base.to_string(),
        user.user_id.clone().unwrap(),
        role.to_string(),
    );
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "INSERT INTO base_members (base_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![base, uid, role, now_ms()],
            )?;
            Ok(())
        })
        .unwrap();
}

/// Give the view's table an attachment field and a record that holds `att`.
fn show_in_view(app: &TestApp, view: &str, field: &str, att: &str) {
    let (view, field, att) = (view.to_string(), field.to_string(), att.to_string());
    app.state
        .db
        .write_sync(|tx| {
            let table: String =
                tx.query_row("SELECT table_id FROM views WHERE id = ?1", [&view], |r| {
                    r.get(0)
                })?;
            tx.execute(
                "INSERT INTO fields (id, table_id, name, type, options, position, created_at)
                 VALUES (?1, ?2, 'Files', 'attachment', '{}', 1, 1)",
                rusqlite::params![field, table],
            )?;
            let data = serde_json::json!({ field.clone(): [{ "id": att, "filename": "pic.png" }] });
            tx.execute(
                "INSERT INTO records (id, table_id, data, position, autonumber, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 1, 1, 1, 1)",
                rusqlite::params![new_id("rec"), table, data.to_string()],
            )?;
            Ok(())
        })
        .unwrap();
}

fn add_share(
    app: &TestApp,
    view: &str,
    kind: &str,
    password: Option<&str>,
    enabled: bool,
) -> String {
    let token = opengrid::ids::new_token("shr_");
    let hash = password.map(|p| opengrid::auth::password::hash(p).unwrap());
    let (view, kind, t) = (view.to_string(), kind.to_string(), token.clone());
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "INSERT INTO share_links (id, token, kind, view_id, password_hash, enabled, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![new_id(og_core::ids::SHARE), t, kind, view, hash, enabled, now_ms()],
            )?;
            Ok(())
        })
        .unwrap();
    token
}

fn multipart_body(parts: &[(&str, Option<&str>, &[u8])]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, filename, data) in parts {
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        match filename {
            Some(f) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{f}\"\r\n\
                     Content-Type: application/octet-stream\r\n\r\n"
                )
                .as_bytes(),
            ),
            None => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            ),
        }
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
    body
}

fn with_auth(
    mut req: axum::http::request::Builder,
    client: &Client,
) -> axum::http::request::Builder {
    if let Some(c) = &client.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", opengrid::auth::SESSION_COOKIE, c),
        );
    }
    if let Some(t) = &client.bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    req.header(opengrid::http::CSRF_HEADER, "1")
}

async fn upload_parts(
    app: &TestApp,
    client: &Client,
    base: &str,
    parts: &[(&str, Option<&str>, &[u8])],
) -> Response {
    let req = with_auth(
        Request::builder()
            .method("POST")
            .uri(format!("/api/bases/{base}/attachments")),
        client,
    )
    .header(
        header::CONTENT_TYPE,
        format!("multipart/form-data; boundary={BOUNDARY}"),
    )
    .body(Body::from(multipart_body(parts)))
    .unwrap();
    app.send(req).await
}

async fn upload(
    app: &TestApp,
    client: &Client,
    base: &str,
    filename: &str,
    data: &[u8],
) -> Response {
    upload_parts(app, client, base, &[("file", Some(filename), data)]).await
}

async fn get_with(
    app: &TestApp,
    client: &Client,
    path: &str,
    share_password: Option<&str>,
) -> Response {
    let mut req = with_auth(Request::builder().method("GET").uri(path), client);
    if let Some(p) = share_password {
        req = req.header("x-share-password", p);
    }
    app.send(req.body(Body::empty()).unwrap()).await
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn sha_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn blob_file(app: &TestApp, data: &[u8]) -> std::path::PathBuf {
    let sha = sha_hex(data);
    app.state
        .config
        .attachments_dir()
        .join(&sha[..2])
        .join(&sha)
}

fn attachment_rows(app: &TestApp) -> i64 {
    app.state
        .db
        .write_sync(|tx| Ok(tx.query_row("SELECT count(*) FROM attachments", [], |r| r.get(0))?))
        .unwrap()
}

fn tmp_files(app: &TestApp) -> usize {
    std::fs::read_dir(app.state.config.data_dir.join("tmp"))
        .map(|rd| rd.count())
        .unwrap_or(0)
}

fn header_str<'a>(res: &'a Response, name: &str) -> &'a str {
    res.headers
        .get(name)
        .unwrap_or_else(|| panic!("missing header {name}"))
        .to_str()
        .unwrap()
}

fn assert_safe_headers(res: &Response) {
    assert_eq!(header_str(res, "x-content-type-options"), "nosniff");
    assert_eq!(
        header_str(res, "content-security-policy"),
        "sandbox; default-src 'none'"
    );
    assert_eq!(header_str(res, "cache-control"), "private, max-age=86400");
}

#[tokio::test]
async fn image_upload_records_dimensions_thumbnail_and_downloads_inline() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let data = png(800, 600);
    let res = upload(&app, &fx.owner, &fx.base, "photo.png", &data).await;
    res.assert_status(200);
    let id = res.body["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("att"));
    assert_eq!(res.body["filename"], "photo.png");
    assert_eq!(res.body["mime"], "image/png");
    assert_eq!(res.body["size"], data.len() as u64);
    assert_eq!(res.body["width"], 800);
    assert_eq!(res.body["height"], 600);

    // Stored content-addressed.
    let blob = blob_file(&app, &data);
    assert_eq!(std::fs::read(&blob).unwrap(), data);
    assert_eq!(tmp_files(&app), 0, "temp upload file cleaned up");

    let res = app
        .get(&fx.owner, &format!("/api/attachments/{id}/photo.png"))
        .await;
    res.assert_status(200);
    assert_eq!(res.bytes, data);
    assert_eq!(header_str(&res, "content-type"), "image/png");
    assert!(header_str(&res, "content-disposition").starts_with("inline;"));
    assert_eq!(header_str(&res, "content-length"), data.len().to_string());
    assert_safe_headers(&res);

    let thumb = app
        .get(&fx.owner, &format!("/api/attachments/{id}/thumb"))
        .await;
    thumb.assert_status(200);
    assert_eq!(header_str(&thumb, "content-type"), "image/png");
    assert_safe_headers(&thumb);
    let img = image::load_from_memory(&thumb.bytes).unwrap();
    assert_eq!((img.width(), img.height()), (400, 300));
}

#[tokio::test]
async fn identical_uploads_share_one_file() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let data = b"same bytes".to_vec();
    let a = upload(&app, &fx.owner, &fx.base, "a.txt", &data).await;
    let b = upload(&app, &fx.owner, &fx.base, "b.txt", &data).await;
    a.assert_status(200);
    b.assert_status(200);
    assert_ne!(a.body["id"], b.body["id"]);
    assert_eq!(attachment_rows(&app), 2);
    let dir = blob_file(&app, &data).parent().unwrap().to_path_buf();
    assert_eq!(std::fs::read_dir(dir).unwrap().count(), 1);
}

#[tokio::test]
async fn uploads_over_the_limit_get_413_and_leave_nothing_behind() {
    let app = TestApp::new(); // 5 MB limit
    let fx = Fixture::new(&app);
    let limit = app.state.config.max_upload_bytes() as usize;

    // Just over the per-file limit (within the request overhead allowance).
    let res = upload(&app, &fx.owner, &fx.base, "big.bin", &vec![7u8; limit + 1]).await;
    res.assert_status(413);
    assert_eq!(res.body["error"]["code"], "payload_too_large");

    // Far over: rejected by the request body limit.
    let res = upload(&app, &fx.owner, &fx.base, "huge.bin", &vec![7u8; limit * 2]).await;
    res.assert_status(413);

    // Declared Content-Length over the limit is refused before reading.
    let body = multipart_body(&[("file", Some("big.bin"), &vec![7u8; limit * 2])]);
    let req = with_auth(
        Request::builder()
            .method("POST")
            .uri(format!("/api/bases/{}/attachments", fx.base)),
        &fx.owner,
    )
    .header(
        header::CONTENT_TYPE,
        format!("multipart/form-data; boundary={BOUNDARY}"),
    )
    .header(header::CONTENT_LENGTH, body.len())
    .body(Body::from(body))
    .unwrap();
    app.send(req).await.assert_status(413);

    assert_eq!(attachment_rows(&app), 0);
    assert_eq!(tmp_files(&app), 0);

    // Exactly at the limit is fine.
    let res = upload(&app, &fx.owner, &fx.base, "ok.bin", &vec![7u8; limit]).await;
    res.assert_status(200);
}

#[tokio::test]
async fn non_images_are_downloads_with_nosniff_and_sandbox() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let cases: [(&str, &[u8], &str); 4] = [
        (
            "page.html",
            b"<html><script>alert(1)</script></html>",
            "text/html",
        ),
        (
            "logo.svg",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
            "image/svg+xml",
        ),
        ("doc.pdf", b"%PDF-1.7 fake", "application/pdf"),
        // Lies about being a PNG: never inline.
        (
            "evil.png",
            b"<html><script>alert(1)</script></html>",
            "application/octet-stream",
        ),
    ];
    for (name, data, stored_mime) in cases {
        let res = upload(&app, &fx.owner, &fx.base, name, data).await;
        res.assert_status(200);
        assert_eq!(res.body["mime"], stored_mime, "{name}");
        assert!(res.body.get("width").is_none());
        let id = res.body["id"].as_str().unwrap();
        let dl = app
            .get(&fx.owner, &format!("/api/attachments/{id}/{name}"))
            .await;
        dl.assert_status(200);
        assert_eq!(dl.bytes, data);
        assert_eq!(
            header_str(&dl, "content-type"),
            "application/octet-stream",
            "{name}"
        );
        let cd = header_str(&dl, "content-disposition");
        assert!(cd.starts_with("attachment;"), "{name}: {cd}");
        assert!(cd.contains(&format!("filename*=UTF-8''{name}")), "{cd}");
        assert_safe_headers(&dl);
        let thumb = app
            .get(&fx.owner, &format!("/api/attachments/{id}/thumb"))
            .await;
        thumb.assert_status(404);
    }
}

#[tokio::test]
async fn filenames_are_sanitized_and_percent_encoded() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let res = upload(&app, &fx.owner, &fx.base, "../../etc/passwd", b"x").await;
    res.assert_status(200);
    assert_eq!(res.body["filename"], "passwd");

    let res = upload(
        &app,
        &fx.owner,
        &fx.base,
        "C:\\temp\\r\u{e9}sum\u{e9} final.pdf",
        b"x",
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["filename"], "r\u{e9}sum\u{e9} final.pdf");
    let id = res.body["id"].as_str().unwrap();
    let dl = app
        .get(&fx.owner, &format!("/api/attachments/{id}/x"))
        .await;
    let cd = header_str(&dl, "content-disposition");
    assert!(
        cd.contains("filename*=UTF-8''r%C3%A9sum%C3%A9%20final.pdf"),
        "{cd}"
    );
    // ASCII fallback has no quotes or non-ASCII characters smuggled in.
    assert!(cd.is_ascii());

    let res = upload(&app, &fx.owner, &fx.base, "..", b"x").await;
    assert_eq!(res.body["filename"], "file");
}

#[tokio::test]
async fn corrupt_image_still_uploads_without_thumbnail() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
    data.extend_from_slice(&[0u8; 100]);
    let res = upload(&app, &fx.owner, &fx.base, "broken.png", &data).await;
    res.assert_status(200);
    assert_eq!(res.body["mime"], "image/png");
    assert!(res.body.get("width").is_none());
    let id = res.body["id"].as_str().unwrap();
    app.get(&fx.owner, &format!("/api/attachments/{id}/thumb"))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn upload_requires_file_field_and_ignores_other_fields() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let res = upload_parts(&app, &fx.owner, &fx.base, &[("note", None, b"hello")]).await;
    res.assert_status(400);
    let res = upload_parts(
        &app,
        &fx.owner,
        &fx.base,
        &[("note", None, b"hello"), ("file", Some("a.txt"), b"data")],
    )
    .await;
    res.assert_status(200);
    assert_eq!(res.body["filename"], "a.txt");

    // Not multipart at all.
    let res = app
        .post(
            &fx.owner,
            &format!("/api/bases/{}/attachments", fx.base),
            serde_json::json!({}),
        )
        .await;
    res.assert_status(400);
}

#[tokio::test]
async fn permissions_viewer_downloads_but_cannot_upload_outsiders_get_404() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let viewer = app.user("viewer@example.com", "Viewer");
    let editor = app.user("editor@example.com", "Editor");
    let outsider = app.user("outsider@example.com", "Outsider");
    grant(&app, &fx.base, &viewer, "viewer");
    grant(&app, &fx.base, &editor, "editor");

    let res = upload(&app, &fx.owner, &fx.base, "a.txt", b"secret").await;
    let id = res.body["id"].as_str().unwrap().to_string();
    let path = format!("/api/attachments/{id}/a.txt");

    app.get(&viewer, &path).await.assert_status(200);
    app.get(&outsider, &path).await.assert_status(404);
    app.get(&app.anon(), &path).await.assert_status(404);
    app.get(&outsider, &format!("/api/attachments/{id}/thumb"))
        .await
        .assert_status(404);
    app.get(&fx.owner, "/api/attachments/attDoesNotExist00/x")
        .await
        .assert_status(404);

    upload(&app, &viewer, &fx.base, "v.txt", b"x")
        .await
        .assert_status(403);
    upload(&app, &outsider, &fx.base, "o.txt", b"x")
        .await
        .assert_status(404);
    upload(&app, &app.anon(), &fx.base, "n.txt", b"x")
        .await
        .assert_status(401);
    upload(&app, &editor, &fx.base, "e.txt", b"x")
        .await
        .assert_status(200);
    upload(&app, &fx.owner, "appNoSuchBase0000", "x.txt", b"x")
        .await
        .assert_status(404);
}

#[tokio::test]
async fn read_only_token_can_download_but_not_upload() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let token = opengrid::ids::new_token("pat");
    let (uid, hash) = (
        fx.owner.user_id.clone().unwrap(),
        opengrid::ids::hash_token(&token),
    );
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
                 VALUES (?1, ?2, 'ro', ?3, '{\"write\": false}', ?4)",
                rusqlite::params![new_id("pat"), uid, hash, now_ms()],
            )?;
            Ok(())
        })
        .unwrap();
    let ro = Client {
        bearer: Some(token),
        ..Client::default()
    };
    let res = upload(&app, &fx.owner, &fx.base, "a.txt", b"x").await;
    let id = res.body["id"].as_str().unwrap();
    app.get(&ro, &format!("/api/attachments/{id}/a.txt"))
        .await
        .assert_status(200);
    upload(&app, &ro, &fx.base, "b.txt", b"x")
        .await
        .assert_status(403);
}

#[tokio::test]
async fn deleted_base_hides_attachments() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let res = upload(&app, &fx.owner, &fx.base, "a.txt", b"x").await;
    let id = res.body["id"].as_str().unwrap().to_string();
    let base = fx.base.clone();
    app.state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE bases SET deleted_at = 1 WHERE id = ?1", [base])?;
            Ok(())
        })
        .unwrap();
    app.get(&fx.owner, &format!("/api/attachments/{id}/a.txt"))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn share_token_grants_access_to_the_attachments_its_view_shows() {
    let app = TestApp::new();
    let fx = Fixture::new(&app);
    let res = upload(&app, &fx.owner, &fx.base, "pic.png", &png(10, 10)).await;
    let id = res.body["id"].as_str().unwrap().to_string();
    show_in_view(&app, &fx.view, "fldFiles", &id);
    let path = |t: &str| format!("/api/attachments/{id}/pic.png?share={t}");
    let anon = app.anon();

    let open = add_share(&app, &fx.view, "view", None, true);
    let res = app.get(&anon, &path(&open)).await;
    res.assert_status(200);
    assert_safe_headers(&res);
    app.get(&anon, &format!("/api/attachments/{id}/thumb?share={open}"))
        .await
        .assert_status(200);

    // An authenticated outsider can also use a share token.
    let outsider = app.user("outsider@example.com", "O");
    app.get(&outsider, &path(&open)).await.assert_status(200);

    let disabled = add_share(&app, &fx.view, "view", None, false);
    app.get(&anon, &path(&disabled)).await.assert_status(404);

    let form = add_share(&app, &fx.view, "form", None, true);
    app.get(&anon, &path(&form)).await.assert_status(404);

    app.get(&anon, &path("shr_bogus")).await.assert_status(404);

    // A share of a view in another base grants nothing here.
    let (_, other_view) = create_base(&app, &outsider.user_id.clone().unwrap());
    let other = add_share(&app, &other_view, "view", None, true);
    app.get(&anon, &path(&other)).await.assert_status(404);

    // Password-protected share.
    let locked = add_share(&app, &fx.view, "view", Some("letmein123"), true);
    app.get(&anon, &path(&locked)).await.assert_status(404);
    get_with(&app, &anon, &path(&locked), Some("wrong"))
        .await
        .assert_status(404);
    get_with(&app, &anon, &path(&locked), Some("letmein123"))
        .await
        .assert_status(200);

    // Deleting the shared view revokes access.
    let view = fx.view.clone();
    app.state
        .db
        .write_sync(|tx| {
            tx.execute("UPDATE views SET deleted_at = 1 WHERE id = ?1", [view])?;
            Ok(())
        })
        .unwrap();
    app.get(&anon, &path(&open)).await.assert_status(404);
}
