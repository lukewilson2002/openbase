//! Airtable-compatible API: authentication (bearer tokens only), token
//! scopes, the Airtable error format, rate limits and routing.

mod common;
mod query_support;
mod records_support;
mod schema_support;
mod share_support;
mod v1_support;

use std::time::Duration;

use common::Client;
use openbase::perm::Role;
use serde_json::{Value, json};
use v1_support::*;

// ------------------------------------------------------ authentication

#[tokio::test]
async fn a_bearer_token_lists_records() {
    let v = v1_people().await;
    let r = v.get("").await;
    r.assert_status(200);
    assert_eq!(r.body["records"].as_array().unwrap().len(), 5);
}

#[tokio::test]
async fn session_cookies_are_rejected() {
    let v = v1_people().await;
    // The owner is signed in with a cookie and has full access to the base...
    v.app()
        .get(&v.p.f.owner, &format!("/api/bases/{}", v.base_id()))
        .await
        .assert_status(200);
    // ...but the Airtable API never looks at cookies.
    for path in [
        v.path(""),
        format!("{}/{}", v.path(""), v.p.ids[0]),
        "/api/v1/meta/bases".to_string(),
        format!("/api/v1/meta/bases/{}/tables", v.base_id()),
    ] {
        let r = v.app().get(&v.p.f.owner, &path).await;
        assert_v1_error(&r, 401, "AUTHENTICATION_REQUIRED");
        assert!(
            r.body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Bearer")
        );
    }
    let write = v
        .app()
        .post(
            &v.p.f.owner,
            &v.path(""),
            json!({ "fields": { "Name": "Mallory" } }),
        )
        .await;
    assert_v1_error(&write, 401, "AUTHENTICATION_REQUIRED");
    let total = v.get("").await.body["records"].as_array().unwrap().len();
    assert_eq!(total, 5, "nothing was written");
}

#[tokio::test]
async fn a_cookie_does_not_help_a_bad_token() {
    let v = v1_people().await;
    let mixed = Client {
        cookie: v.p.f.owner.cookie.clone(),
        bearer: Some("pat_not_a_real_token".into()),
        user_id: v.p.f.owner.user_id.clone(),
    };
    let r = v.app().get(&mixed, &v.path("")).await;
    assert_v1_error(&r, 401, "AUTHENTICATION_REQUIRED");
}

#[tokio::test]
async fn invalid_expired_and_malformed_credentials_are_401() {
    let v = v1_people().await;
    let bad = Client {
        bearer: Some("pat_nope".into()),
        ..Default::default()
    };
    assert_v1_error(
        &v.app().get(&bad, &v.path("")).await,
        401,
        "AUTHENTICATION_REQUIRED",
    );
    // No credentials at all.
    let anon = v.app().anon();
    assert_v1_error(
        &v.app().get(&anon, &v.path("")).await,
        401,
        "AUTHENTICATION_REQUIRED",
    );
    // Expired token.
    let expired = make_token(v.app(), &v.p.f.owner, true, None, Some(1));
    assert_v1_error(
        &v.app().get(&expired, &v.path("")).await,
        401,
        "AUTHENTICATION_REQUIRED",
    );
    // A scheme other than Bearer.
    let r = v
        .app()
        .request_with(
            &anon,
            "GET",
            &v.path(""),
            None,
            &[("authorization", "Basic dXNlcjpwYXNz")],
            false,
            None,
        )
        .await;
    assert_v1_error(&r, 401, "AUTHENTICATION_REQUIRED");
}

#[tokio::test]
async fn deactivated_users_lose_api_access() {
    let v = v1_people().await;
    v.get("").await.assert_status(200);
    let uid = v.p.f.owner.user_id.clone().unwrap();
    sql(v.app(), |tx| {
        tx.execute("UPDATE users SET is_active = 0 WHERE id = ?1", [&uid])
    });
    assert_v1_error(&v.get("").await, 401, "AUTHENTICATION_REQUIRED");
}

#[tokio::test]
async fn using_a_token_stamps_last_used_at() {
    let v = v1_people().await;
    let hash = openbase::ids::hash_token(v.token.bearer.as_deref().unwrap());
    let stamp = |app: &common::TestApp| -> Option<i64> {
        sql(app, |tx| {
            tx.query_row(
                "SELECT last_used_at FROM api_tokens WHERE token_hash = ?1",
                [&hash],
                |r| r.get(0),
            )
        })
    };
    assert_eq!(stamp(v.app()), None);
    v.get("").await.assert_status(200);
    assert!(stamp(v.app()).is_some());
}

// ------------------------------------------------------------- scopes

#[tokio::test]
async fn read_only_tokens_can_read_but_not_write() {
    let v = v1_people().await;
    let ro = make_token(v.app(), &v.p.f.owner, false, None, None);
    let rec = v.p.ids[0].clone();
    v.app().get(&ro, &v.path("")).await.assert_status(200);
    v.app()
        .get(&ro, &format!("{}/{rec}", v.path("")))
        .await
        .assert_status(200);
    let denied =
        |r: common::Response| assert_v1_error(&r, 403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
    denied(
        v.app()
            .post(&ro, &v.path(""), json!({ "fields": { "Name": "x" } }))
            .await,
    );
    denied(
        v.app()
            .patch(
                &ro,
                &v.path(""),
                json!({ "records": [{ "id": rec, "fields": { "Name": "x" } }] }),
            )
            .await,
    );
    denied(
        v.app()
            .put(
                &ro,
                &format!("{}/{rec}", v.path("")),
                json!({ "fields": { "Name": "x" } }),
            )
            .await,
    );
    denied(
        v.app()
            .delete(&ro, &v.path(&format!("?records%5B%5D={rec}")))
            .await,
    );
    let all = v.get("").await;
    assert_eq!(all.body["records"].as_array().unwrap().len(), 5);
    assert_eq!(all.body["records"][0]["fields"]["Name"], "Alice");
}

#[tokio::test]
async fn viewers_cannot_write_even_with_a_write_token() {
    let v = v1_people().await;
    let viewer = v.p.f.member("viewer@example.com", Role::Viewer);
    let tok = make_token(v.app(), &viewer, true, None, None);
    v.app().get(&tok, &v.path("")).await.assert_status(200);
    let r = v
        .app()
        .post(&tok, &v.path(""), json!({ "fields": { "Name": "x" } }))
        .await;
    assert_v1_error(&r, 403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
    // A commenter cannot edit records either.
    let commenter = v.p.f.member("commenter@example.com", Role::Commenter);
    let tok = make_token(v.app(), &commenter, true, None, None);
    let r = v
        .app()
        .post(&tok, &v.path(""), json!({ "fields": { "Name": "x" } }))
        .await;
    assert_v1_error(&r, 403, "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
    // An editor can.
    let editor = v.p.f.member("editor@example.com", Role::Editor);
    let tok = make_token(v.app(), &editor, true, None, None);
    v.app()
        .post(&tok, &v.path(""), json!({ "fields": { "Name": "ok" } }))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn base_restricted_tokens_only_see_their_bases() {
    let v = v1_people().await;
    // A second base for the same owner.
    let other = base(v.app(), &v.p.f.owner, &v.p.f.ws, "Other").await;
    let other_id = other["id"].as_str().unwrap().to_string();
    let other_table = other["tables"][0]["id"].as_str().unwrap().to_string();
    let only_first = make_token(v.app(), &v.p.f.owner, true, Some(&[v.base_id()]), None);
    v.app()
        .get(&only_first, &v.path(""))
        .await
        .assert_status(200);
    let r = v
        .app()
        .get(&only_first, &format!("/api/v1/{other_id}/{other_table}"))
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
    let r = v
        .app()
        .post(
            &only_first,
            &format!("/api/v1/{other_id}/{other_table}"),
            json!({ "fields": {} }),
        )
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
    let r = v
        .app()
        .get(
            &only_first,
            &format!("/api/v1/meta/bases/{other_id}/tables"),
        )
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
    // The base list shows only the allowed base.
    let bases = v.app().get(&only_first, "/api/v1/meta/bases").await;
    bases.assert_status(200);
    let ids: Vec<&str> = bases.body["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [v.base_id()]);
    // An unrestricted token sees both.
    let all = v.app().get(&v.token, "/api/v1/meta/bases").await;
    assert_eq!(all.body["bases"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn users_without_access_get_404_not_403() {
    let v = v1_people().await;
    let stranger = v.p.f.app.user("stranger@example.com", "Stranger");
    let tok = make_token(v.app(), &stranger, true, None, None);
    assert_v1_error(&v.app().get(&tok, &v.path("")).await, 404, "NOT_FOUND");
    let r = v
        .app()
        .post(&tok, &v.path(""), json!({ "fields": { "Name": "x" } }))
        .await;
    assert_v1_error(&r, 404, "NOT_FOUND");
    let bases = v.app().get(&tok, "/api/v1/meta/bases").await;
    assert_eq!(bases.body["bases"], json!([]));
}

// -------------------------------------------------------- error format

#[tokio::test]
async fn errors_use_the_airtable_format() {
    let v = v1_people().await;
    let base = v.base_id().to_string();
    // Unknown table, base and record.
    assert_v1_error(
        &v.app().get(&v.token, &format!("/api/v1/{base}/Nope")).await,
        404,
        "NOT_FOUND",
    );
    assert_v1_error(
        &v.app().get(&v.token, "/api/v1/bseNOPE/tblNOPE").await,
        404,
        "NOT_FOUND",
    );
    assert_v1_error(&v.get("/recNOPE").await, 404, "NOT_FOUND");
    // Unknown routes and methods.
    for path in ["/api/v1", "/api/v1/", "/api/v1/meta", "/api/v1/a/b/c/d/e"] {
        let r = v.app().get(&v.token, path).await;
        assert_v1_error(&r, 404, "NOT_FOUND");
    }
    let r = v
        .app()
        .request(&v.token, "OPTIONS", &v.path(""), None)
        .await;
    assert_v1_error(&r, 405, "METHOD_NOT_ALLOWED");
    let r = v
        .app()
        .post(&v.token, "/api/v1/meta/bases", json!({}))
        .await;
    assert_v1_error(&r, 405, "METHOD_NOT_ALLOWED");
    // Malformed and mistyped bodies.
    let r = v
        .app()
        .request_with(
            &v.token,
            "POST",
            &v.path(""),
            None,
            &[("content-type", "application/json")],
            true,
            None,
        )
        .await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
    let r = v
        .app()
        .post(&v.token, &v.path(""), json!({ "records": "nope" }))
        .await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
    let r = v
        .app()
        .post(
            &v.token,
            &v.path(""),
            json!({ "records": [{ "nofields": 1 }] }),
        )
        .await;
    assert_v1_error(&r, 422, "INVALID_REQUEST_UNKNOWN");
    // Malformed query strings.
    assert_v1_error(
        &v.get("?pageSize=abc").await,
        422,
        "INVALID_REQUEST_UNKNOWN",
    );
}

#[tokio::test]
async fn unauthorized_errors_never_reach_the_internal_envelope() {
    let v = v1_people().await;
    // Same request on the internal API keeps its own format.
    let r = v
        .app()
        .get(
            &v.p.f.app.anon(),
            &format!("/api/tables/{}/records/x", v.table_id()),
        )
        .await;
    assert_eq!(r.status, 401);
    assert_eq!(r.body["error"]["code"], "unauthorized");
    // The v1 error has `type`, not `code`.
    let r = v.app().get(&v.p.f.app.anon(), &v.path("")).await;
    assert!(r.body["error"].get("code").is_none());
}

#[tokio::test]
async fn bodies_over_the_limit_are_413() {
    let v = v1_people().await;
    let big = "x".repeat(5 * 1024 * 1024);
    let r = v.post(json!({ "fields": { "Name": big } })).await;
    assert_v1_error(&r, 413, "REQUEST_BODY_TOO_LARGE");
}

// --------------------------------------------------------- rate limits

#[tokio::test]
async fn a_token_gets_five_requests_per_second() {
    let v = {
        let p = people_with(|c| {
            c.v1_rate_per_token = 5;
            c.v1_rate_per_user = 50;
        })
        .await;
        let token = make_token(&p.f.app, &p.f.owner, true, None, None);
        V1 { p, token }
    };
    let other = make_token(v.app(), &v.p.f.owner, true, None, None);
    for i in 0..5 {
        let r = v.get("?pageSize=1").await;
        assert_eq!(r.status, 200, "request {i}");
    }
    let limited = v.get("?pageSize=1").await;
    assert_v1_error(&limited, 429, "RATE_LIMIT_REACHED");
    assert!(limited.headers.contains_key("retry-after"));
    // Another token of the same user has its own bucket, and the internal API
    // is not affected.
    v.app()
        .get(&other, &v.path("?pageSize=1"))
        .await
        .assert_status(200);
    v.app()
        .get(&v.p.f.owner, &format!("/api/bases/{}", v.base_id()))
        .await
        .assert_status(200);
    // The window passes.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    v.get("?pageSize=1").await.assert_status(200);
}

#[tokio::test]
async fn a_user_gets_fifty_requests_per_second_across_tokens() {
    let p = people_with(|c| {
        c.v1_rate_per_token = 1000;
        c.v1_rate_per_user = 50;
    })
    .await;
    let tokens: Vec<Client> = (0..3)
        .map(|_| make_token(&p.f.app, &p.f.owner, true, None, None))
        .collect();
    let path = format!("/api/v1/{}/{}?pageSize=1", p.f.base_id, p.f.table_id);
    for i in 0..50 {
        let r = p.f.app.get(&tokens[i % 3], &path).await;
        assert_eq!(r.status, 200, "request {i}");
    }
    for t in &tokens {
        assert_v1_error(&p.f.app.get(t, &path).await, 429, "RATE_LIMIT_REACHED");
    }
    // Another user is unaffected.
    let other = p.f.member("other@example.com", Role::Editor);
    let tok = make_token(&p.f.app, &other, true, None, None);
    p.f.app.get(&tok, &path).await.assert_status(200);
}

#[tokio::test]
async fn invalid_tokens_do_not_consume_rate_limit_state() {
    let p = people_with(|c| c.v1_rate_per_token = 1).await;
    let bad = Client {
        bearer: Some("pat_garbage".into()),
        ..Default::default()
    };
    let path = format!("/api/v1/{}/{}", p.f.base_id, p.f.table_id);
    for _ in 0..5 {
        assert_v1_error(
            &p.f.app.get(&bad, &path).await,
            401,
            "AUTHENTICATION_REQUIRED",
        );
    }
}

#[allow(dead_code)]
fn unused(_: Value) {}
