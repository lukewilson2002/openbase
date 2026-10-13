//! Shared integration-test harness: an in-process OpenGrid on a temp data dir,
//! driven through the real router (middleware included) with `oneshot`.
#![allow(dead_code)]

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use opengrid::config::Config;
use opengrid::email::CapturingMailer;
use opengrid::state::AppState;
use serde_json::Value;
use tower::ServiceExt;

pub struct TestApp {
    pub state: AppState,
    pub router: Router,
    /// Every email the app "sent" (the transport behind `state.mailer`). Email features
    /// still only trigger when an SMTP host is configured: `config.smtp_host`, or saved
    /// through `PATCH /api/admin/email`.
    pub mailer: Arc<CapturingMailer>,
    _dir: Option<tempfile::TempDir>,
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
        // Every configured SMTP host "delivers" to the capturing mailer, whether it comes from
        // `config.smtp_host` or from the settings saved through the admin API.
        let mailer = Arc::new(CapturingMailer::default());
        let capture = mailer.clone();
        let state = AppState::open_with_mail(
            config,
            Arc::new(move |_| Ok(capture.clone() as Arc<dyn opengrid::email::Mailer>)),
        )
        .unwrap();
        let router = opengrid::http::router(state.clone());
        TestApp {
            state,
            router,
            mailer,
            _dir: Some(dir),
        }
    }

    /// A harness around a state that was opened by the test itself (to restart "the server"
    /// on the same data directory). Its `mailer` field is unused.
    pub fn from_parts(state: AppState, router: Router) -> TestApp {
        TestApp {
            state,
            router,
            mailer: Arc::new(CapturingMailer::default()),
            _dir: None,
        }
    }

    /// Like [`TestApp::request`] with extra request headers and extensions
    /// control: `csrf: false` omits the CSRF header; `peer` sets the TCP peer
    /// address (ConnectInfo), which oneshot requests otherwise lack.
    #[allow(clippy::too_many_arguments)]
    pub async fn request_with(
        &self,
        client: &Client,
        method: &str,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
        csrf: bool,
        peer: Option<std::net::SocketAddr>,
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
        if csrf {
            req = req.header(opengrid::http::CSRF_HEADER, "1");
        }
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let mut req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&b).unwrap()))
                .unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        if let Some(addr) = peer {
            req.extensions_mut()
                .insert(axum::extract::ConnectInfo(addr));
        }
        self.send(req).await
    }

    /// Sign up through the API; returns the response and a client holding
    /// the new session cookie (if any).
    pub async fn signup(
        &self,
        email: &str,
        password: &str,
        invite_token: Option<&str>,
    ) -> (Response, Client) {
        let res = self
            .post(
                &self.anon(),
                "/api/auth/signup",
                serde_json::json!({
                    "email": email,
                    "name": "Test User",
                    "password": password,
                    "invite_token": invite_token,
                }),
            )
            .await;
        let client = Client {
            cookie: res.session_cookie(),
            bearer: None,
            user_id: res.body["id"].as_str().map(str::to_string),
        };
        (res, client)
    }

    /// Log in through the API; returns the response and a client holding the
    /// session cookie set by it (a pending-2FA cookie when 2FA is on).
    pub async fn login(&self, email: &str, password: &str) -> (Response, Client) {
        let res = self
            .post(
                &self.anon(),
                "/api/auth/login",
                serde_json::json!({ "email": email, "password": password }),
            )
            .await;
        let client = Client {
            cookie: res.session_cookie(),
            bearer: None,
            user_id: res.body["user"]["id"].as_str().map(str::to_string),
        };
        (res, client)
    }

    /// Create a workspace (and optionally a base in it) directly in the
    /// database with `owner` as workspace owner. Returns (workspace_id, base_id).
    pub fn workspace_with_base(&self, owner: &Client, name: &str) -> (String, String) {
        let owner_id = owner.user_id.clone().unwrap();
        let name = name.to_string();
        self.state
            .db
            .write_sync(|tx| {
                let ws = opengrid::ids::new_id(og_core::ids::WORKSPACE);
                let base = opengrid::ids::new_id(og_core::ids::BASE);
                let now = opengrid::db::now_ms();
                tx.execute(
                    "INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![ws, name, owner_id, now],
                )?;
                tx.execute(
                    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
                     VALUES (?1, ?2, 'owner', ?3)",
                    rusqlite::params![ws, owner_id, now],
                )?;
                tx.execute(
                    "INSERT INTO bases (id, workspace_id, name, created_by, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![base, ws, format!("{name} base"), owner_id, now],
                )?;
                Ok((ws, base))
            })
            .unwrap()
    }

    /// Give `user` a direct role on a base (base-level sharing).
    pub fn grant_base_role(&self, user: &Client, base_id: &str, role: &str) {
        let uid = user.user_id.clone().unwrap();
        let base_id = base_id.to_string();
        let role = role.to_string();
        self.state
            .db
            .write_sync(|tx| {
                tx.execute(
                    "INSERT INTO base_members (base_id, user_id, role, created_at) VALUES (?1, ?2, ?3, 0)
                     ON CONFLICT(base_id, user_id) DO UPDATE SET role = excluded.role",
                    rusqlite::params![base_id, uid, role],
                )?;
                Ok(())
            })
            .unwrap();
    }

    /// Give `user` a role on a workspace.
    pub fn grant_workspace_role(&self, user: &Client, workspace_id: &str, role: &str) {
        let uid = user.user_id.clone().unwrap();
        let ws = workspace_id.to_string();
        let role = role.to_string();
        self.state
            .db
            .write_sync(|tx| {
                tx.execute(
                    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?1, ?2, ?3, 0)
                     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role",
                    rusqlite::params![ws, uid, role],
                )?;
                Ok(())
            })
            .unwrap();
    }

    /// Run a read query against the database (for assertions).
    pub fn query_i64(&self, sql: &str, params: &[&str]) -> i64 {
        self.state
            .db
            .write_sync(|tx| {
                Ok(tx.query_row(sql, rusqlite::params_from_iter(params), |r| r.get(0))?)
            })
            .unwrap()
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
        // Hashing is deliberately slow; every test user shares one hash of the same password.
        static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
        let hash = HASH
            .get_or_init(|| opengrid::auth::password::hash("password1234").unwrap())
            .clone();
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

    /// A bearer-only client for a raw token string.
    pub fn bearer(token: &str) -> Client {
        Client {
            bearer: Some(token.to_string()),
            ..Default::default()
        }
    }

    /// Create a personal access token for `user` through the API (a session call, like the
    /// account page) and return a bearer client for it. `body` is a `CreateTokenRequest`.
    pub async fn api_token(&self, user: &Client, body: Value) -> Client {
        let res = self.post(user, "/api/tokens", body).await;
        res.assert_status(201);
        let mut c = Self::bearer(res.body["token"].as_str().unwrap());
        c.user_id = user.user_id.clone();
        c
    }

    /// Insert a token row with arbitrary stored `scopes` JSON (for shapes the API refuses to
    /// create, such as `manage` without `write`, or rows written before `manage` existed).
    pub fn raw_token(&self, user: &Client, scopes: Value) -> Client {
        let token = format!("pat_raw_{}", opengrid::ids::new_id("x"));
        let hash = opengrid::ids::hash_token(&token);
        let uid = user.user_id.clone().unwrap();
        let scopes = scopes.to_string();
        self.state
            .db
            .write_sync(|tx| {
                tx.execute(
                    "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
                     VALUES (?1, ?2, 'raw', ?3, ?4, 1)",
                    rusqlite::params![opengrid::ids::new_id("pat"), uid, hash, scopes],
                )?;
                Ok(())
            })
            .unwrap();
        let mut c = Self::bearer(&token);
        c.user_id = user.user_id.clone();
        c
    }
}
