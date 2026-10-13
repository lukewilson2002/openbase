//! Admin backup endpoints: list, create now, download.

mod common;

use common::{Client, TestApp};

#[tokio::test]
async fn admin_can_create_list_and_download_backups() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");

    let res = app.get(&admin, "/api/admin/backups").await;
    res.assert_status(200);
    assert_eq!(res.body, serde_json::json!([]));

    let res = app
        .post(&admin, "/api/admin/backups", serde_json::json!({}))
        .await;
    res.assert_status(200);
    let name = res.body["name"].as_str().unwrap().to_string();
    assert!(openbase::backup::is_backup_name(&name), "{name}");
    assert!(res.body["size"].as_u64().unwrap() > 0);
    assert!(res.body["created_at"].as_i64().unwrap() > 0);

    let res = app.get(&admin, "/api/admin/backups").await;
    res.assert_status(200);
    assert_eq!(res.body.as_array().unwrap().len(), 1);
    assert_eq!(res.body[0]["name"], name.as_str());

    let res = app.get(&admin, &format!("/api/admin/backups/{name}")).await;
    res.assert_status(200);
    let on_disk = std::fs::read(app.state.config.backups_dir().join(&name)).unwrap();
    assert_eq!(res.bytes, on_disk);
    assert_eq!(
        res.headers.get("content-type").unwrap(),
        "application/octet-stream"
    );
    let cd = res
        .headers
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cd.starts_with("attachment;") && cd.contains(&name), "{cd}");
    assert_eq!(res.headers.get("cache-control").unwrap(), "no-store");
    // A gzip stream.
    assert_eq!(&res.bytes[..2], &[0x1f, 0x8b]);
}

/// Browsers always send `Accept-Encoding`; the compression layer must not break the stream.
#[tokio::test]
async fn download_survives_response_compression() {
    use std::io::Read;

    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    let res = app
        .post(&admin, "/api/admin/backups", serde_json::json!({}))
        .await;
    let name = res.body["name"].as_str().unwrap().to_string();
    let on_disk = std::fs::read(app.state.config.backups_dir().join(&name)).unwrap();

    for encoding in ["gzip", "gzip, deflate, br", "identity"] {
        let res = app
            .request_with(
                &admin,
                "GET",
                &format!("/api/admin/backups/{name}"),
                None,
                &[("accept-encoding", encoding)],
                true,
                None,
            )
            .await;
        res.assert_status(200);
        let body = match res
            .headers
            .get("content-encoding")
            .map(|v| v.to_str().unwrap())
        {
            Some("gzip") => {
                let mut out = Vec::new();
                flate2::read::GzDecoder::new(&res.bytes[..])
                    .read_to_end(&mut out)
                    .unwrap();
                out
            }
            None => res.bytes.clone(),
            Some(other) => panic!("unexpected content-encoding {other} for {encoding}"),
        };
        assert_eq!(body, on_disk, "accept-encoding: {encoding}");
    }
}

#[tokio::test]
async fn non_admins_and_tokens_are_refused() {
    let app = TestApp::new();
    let user = app.user("user@example.com", "User");
    let anon = app.anon();
    std::fs::write(
        app.state
            .config
            .backups_dir()
            .join("openbase-20261012-030000.tar.gz"),
        b"x",
    )
    .unwrap();
    for c in [&user, &anon] {
        let expected = if c.cookie.is_some() { 403 } else { 401 };
        app.get(c, "/api/admin/backups")
            .await
            .assert_status(expected);
        app.post(c, "/api/admin/backups", serde_json::json!({}))
            .await
            .assert_status(expected);
        app.get(c, "/api/admin/backups/openbase-20261012-030000.tar.gz")
            .await
            .assert_status(expected);
    }

    // An admin's API token cannot reach admin endpoints.
    let admin = app.admin("admin@example.com", "Admin");
    let token = openbase::ids::new_token("pat");
    let (uid, hash) = (
        admin.user_id.clone().unwrap(),
        openbase::ids::hash_token(&token),
    );
    app.state
        .db
        .write_sync(|tx| {
            tx.execute(
                "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
                 VALUES ('patX', ?1, 't', ?2, '{\"write\": true}', 0)",
                rusqlite::params![uid, hash],
            )?;
            Ok(())
        })
        .unwrap();
    let bearer = Client {
        bearer: Some(token),
        ..Client::default()
    };
    app.get(&bearer, "/api/admin/backups")
        .await
        .assert_status(403);
}

#[tokio::test]
async fn download_rejects_names_outside_the_pattern() {
    let app = TestApp::new();
    let admin = app.admin("admin@example.com", "Admin");
    // Files that exist but must never be served.
    std::fs::write(app.state.config.backups_dir().join("notes.txt"), b"x").unwrap();
    for bad in [
        "notes.txt",
        "..%2Fopenbase.db",
        "%2E%2E",
        "openbase.db",
        "..%2F..%2Fetc%2Fpasswd",
        "openbase-20261012-030000.tar.gz.partial",
    ] {
        let res = app.get(&admin, &format!("/api/admin/backups/{bad}")).await;
        assert_eq!(res.status.as_u16(), 404, "{bad}");
    }
    // Valid pattern but missing file.
    app.get(&admin, "/api/admin/backups/openbase-20000101-000000.tar.gz")
        .await
        .assert_status(404);
}
