//! Helpers for the Airtable-compatible API tests: a base with the `People`
//! table and a bearer-token client, request builders with Airtable's bracketed
//! query keys, and token fixtures with scopes.
#![allow(dead_code)]

use serde_json::{Value, json};

use crate::common::{Client, Response, TestApp};
pub use crate::share_support::*;

mod everything;
#[allow(unused_imports)]
pub use everything::*;

/// Percent-encode `(key, value)` pairs into a query string.
pub fn qs(pairs: &[(&str, &str)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

/// Insert an API token for `user`; returns a bearer client.
pub fn make_token(
    app: &TestApp,
    user: &Client,
    write: bool,
    base_ids: Option<&[&str]>,
    expires_at: Option<i64>,
) -> Client {
    let token = format!("pat_v1_{}", openbase::ids::new_id("x"));
    let hash = openbase::ids::hash_token(&token);
    let uid = user.user_id.clone().unwrap();
    let scopes = json!({ "write": write, "base_ids": base_ids }).to_string();
    sql(app, |tx| {
        tx.execute(
            "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at)
             VALUES (?1, ?2, 't', ?3, ?4, 1, ?5)",
            rusqlite::params![openbase::ids::new_id("pat"), uid, hash, scopes, expires_at],
        )
    });
    Client {
        cookie: None,
        bearer: Some(token),
        user_id: user.user_id.clone(),
    }
}

/// The People table of `query_support` with a write token for its owner.
pub struct V1 {
    pub p: People,
    pub token: Client,
}

pub async fn v1_people() -> V1 {
    let p = people().await;
    let token = make_token(&p.f.app, &p.f.owner, true, None, None);
    V1 { p, token }
}

impl V1 {
    pub fn app(&self) -> &TestApp {
        &self.p.f.app
    }

    pub fn base_id(&self) -> &str {
        &self.p.f.base_id
    }

    pub fn table_id(&self) -> &str {
        &self.p.f.table_id
    }

    /// `/api/v1/{base}/{table id}{suffix}`
    pub fn path(&self, suffix: &str) -> String {
        format!("/api/v1/{}/{}{suffix}", self.base_id(), self.table_id())
    }

    /// `GET` with the write token.
    pub async fn get(&self, suffix: &str) -> Response {
        self.app().get(&self.token, &self.path(suffix)).await
    }

    /// `GET ...?{query}` with the write token.
    pub async fn list(&self, pairs: &[(&str, &str)]) -> Response {
        let q = qs(pairs);
        self.get(&format!("?{q}")).await
    }

    pub async fn post(&self, body: Value) -> Response {
        self.app().post(&self.token, &self.path(""), body).await
    }

    pub async fn patch(&self, body: Value) -> Response {
        self.app().patch(&self.token, &self.path(""), body).await
    }

    pub async fn put(&self, body: Value) -> Response {
        self.app().put(&self.token, &self.path(""), body).await
    }

    pub async fn delete(&self, ids: &[&str]) -> Response {
        let pairs: Vec<(&str, &str)> = ids.iter().map(|id| ("records[]", *id)).collect();
        let q = qs(&pairs);
        self.app()
            .delete(&self.token, &self.path(&format!("?{q}")))
            .await
    }

    /// Ids of the records of a list response, in order.
    pub fn listed_ids(resp: &Response) -> Vec<String> {
        resp.body["records"]
            .as_array()
            .unwrap_or_else(|| panic!("no records in {}", resp.body))
            .iter()
            .map(|r| r["id"].as_str().unwrap().to_string())
            .collect()
    }

    /// The `Name` cells of a list response, in order.
    pub fn listed_names(resp: &Response) -> Vec<String> {
        resp.body["records"]
            .as_array()
            .unwrap_or_else(|| panic!("no records in {}", resp.body))
            .iter()
            .map(|r| r["fields"]["Name"].as_str().unwrap_or("").to_string())
            .collect()
    }
}

/// Assert an Airtable-style error body and status.
#[track_caller]
pub fn assert_v1_error(r: &Response, status: u16, kind: &str) {
    assert_eq!(r.status.as_u16(), status, "status; body: {}", r.body);
    let err = r.body.as_object().expect("error body is an object");
    assert_eq!(err.len(), 1, "only an \"error\" key: {}", r.body);
    let detail = r.body["error"].as_object().expect("error object");
    assert_eq!(detail.len(), 2, "type and message only: {}", r.body);
    assert_eq!(r.body["error"]["type"], kind, "body: {}", r.body);
    assert!(
        r.body["error"]["message"]
            .as_str()
            .is_some_and(|m| !m.is_empty()),
        "message: {}",
        r.body
    );
}
