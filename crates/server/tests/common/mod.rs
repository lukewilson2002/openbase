//! Shared integration-test harness: an in-process OpenGrid on a temp data dir,
//! driven through the real router (middleware included) with `oneshot`.
#![allow(dead_code)]

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use opengrid::config::Config;
use opengrid::state::AppState;
use serde_json::Value;
use tower::ServiceExt;

pub struct TestApp {
    pub state: AppState,
    pub router: Router,
    _dir: tempfile::TempDir,
}

pub struct Response {
    pub status: StatusCode,
    pub headers: axum::http::HeaderMap,
    pub body: Value,
    pub bytes: Vec<u8>,
}

impl Response {
    /// Value of the session cookie set by this response, if any.
    pub fn session_cookie(&self) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .find_map(|v| {
                let s = v.to_str().ok()?;
                let kv = s.split(';').next()?;
                let (k, val) = kv.split_once('=')?;
                (k == opengrid::auth::SESSION_COOKIE && !val.is_empty()).then(|| val.to_string())
            })
    }

    #[track_caller]
    pub fn assert_status(&self, expected: u16) -> &Self {
        assert_eq!(
            self.status.as_u16(),
            expected,
            "unexpected status; body: {}",
            self.body
        );
        self
    }
}

/// A logged-in client (or anonymous when `cookie` is None).
#[derive(Clone, Default)]
pub struct Client {
    pub cookie: Option<String>,
    pub bearer: Option<String>,
    pub user_id: Option<String>,
}

impl TestApp {
    pub fn new() -> TestApp {
        Self::with_config(|_| {})
    }

    pub fn with_config(f: impl FnOnce(&mut Config)) -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::for_tests(dir.path());
        f(&mut config);
        let state = AppState::open(config).unwrap();
        let router = opengrid::http::router(state.clone());
        TestApp {
            state,
            router,
            _dir: dir,
        }
    }

    pub async fn request(
        &self,
        client: &Client,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Response {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(c) = &client.cookie {
            req = req.header(
                header::COOKIE,
                format!("{}={}", opengrid::auth::SESSION_COOKIE, c),
            );
        }
        if let Some(t) = &client.bearer {
            req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
        }
        req = req.header(opengrid::http::CSRF_HEADER, "1");
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&b).unwrap()))
                .unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        self.send(req).await
    }

    pub async fn send(&self, req: Request<Body>) -> Response {
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Response {
            status,
            headers,
            body,
            bytes,
        }
    }

    pub async fn get(&self, c: &Client, path: &str) -> Response {
        self.request(c, "GET", path, None).await
    }
    pub async fn post(&self, c: &Client, path: &str, body: Value) -> Response {
        self.request(c, "POST", path, Some(body)).await
    }
    pub async fn patch(&self, c: &Client, path: &str, body: Value) -> Response {
        self.request(c, "PATCH", path, Some(body)).await
    }
    pub async fn put(&self, c: &Client, path: &str, body: Value) -> Response {
        self.request(c, "PUT", path, Some(body)).await
    }
    pub async fn delete(&self, c: &Client, path: &str) -> Response {
        self.request(c, "DELETE", path, None).await
    }

    /// Create a user directly in the database and return a logged-in client
    /// (session created directly, bypassing the login endpoint and its rate limits).
    pub fn user(&self, email: &str, name: &str) -> Client {
        self.user_with(email, name, false)
    }

    pub fn admin(&self, email: &str, name: &str) -> Client {
        self.user_with(email, name, true)
    }

    fn user_with(&self, email: &str, name: &str, is_admin: bool) -> Client {
        let hash = opengrid::auth::password::hash("password1234").unwrap();
        let email = email.to_string();
        let name = name.to_string();
        let (user_id, token) = self
            .state
            .db
            .write_sync(|tx| {
                let id = opengrid::ids::new_id(og_core::ids::USER);
                let now = opengrid::db::now_ms();
                tx.execute(
                    "INSERT INTO users (id, email, name, password_hash, is_admin, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    rusqlite::params![id, email, name, hash, is_admin, now],
                )?;
                let token = opengrid::auth::session::create(tx, &id, false, None, None)?;
                Ok((id, token))
            })
            .unwrap();
        Client {
            cookie: Some(token),
            bearer: None,
            user_id: Some(user_id),
        }
    }

    pub fn anon(&self) -> Client {
        Client::default()
    }
}
