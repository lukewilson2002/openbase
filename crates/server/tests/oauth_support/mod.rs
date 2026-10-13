//! Helpers for the OAuth tests: PKCE, form posts, the authorization code flow end to end, and a
//! local HTTP server that serves client metadata documents.
#![allow(dead_code)]

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, Response as HttpResponse, header};
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::common::{Client, Response, TestApp};

pub const LOOPBACK_REDIRECT: &str = "http://127.0.0.1:53124/callback";

/// A PKCE pair: (verifier, S256 challenge).
pub fn pkce() -> (String, String) {
    let verifier = format!(
        "{}{}",
        openbase::ids::new_token("v"),
        openbase::ids::new_token("w")
    );
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// The scopes an app asks for when it wants `access` ("read", "write" or "manage").
pub fn scope_for(access: &str) -> &'static str {
    match access {
        "manage" => "openbase:read openbase:write openbase:manage",
        "write" => "openbase:read openbase:write",
        _ => "openbase:read",
    }
}

pub fn encode(pairs: &[(&str, &str)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

/// POST `application/x-www-form-urlencoded` (what OAuth clients send), without cookies.
pub async fn form(app: &TestApp, path: &str, pairs: &[(&str, &str)]) -> Response {
    form_with(app, path, pairs, &[]).await
}

pub async fn form_with(
    app: &TestApp,
    path: &str,
    pairs: &[(&str, &str)],
    headers: &[(&str, &str)],
) -> Response {
    raw_body(
        app,
        "POST",
        path,
        "application/x-www-form-urlencoded",
        encode(pairs).into_bytes(),
        headers,
    )
    .await
}

pub async fn raw_body(
    app: &TestApp,
    method: &str,
    path: &str,
    content_type: &str,
    body: Vec<u8>,
    headers: &[(&str, &str)],
) -> Response {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::CONTENT_TYPE, content_type);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    app.send(req.body(Body::from(body)).unwrap()).await
}

/// GET without credentials.
pub async fn get(app: &TestApp, path: &str) -> Response {
    app.send(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
}

/// `POST /oauth/register` with a JSON document.
pub async fn register(app: &TestApp, doc: Value) -> Response {
    raw_body(
        app,
        "POST",
        "/oauth/register",
        "application/json",
        serde_json::to_vec(&doc).unwrap(),
        &[],
    )
    .await
}

/// Register a public client and return its client_id.
pub async fn register_client(app: &TestApp, name: &str, redirect_uris: &[&str]) -> String {
    let res = register(
        app,
        json!({"client_name": name, "redirect_uris": redirect_uris}),
    )
    .await;
    res.assert_status(201);
    res.body["client_id"].as_str().unwrap().to_string()
}

/// A new signed-in user (the browser of the person who is connecting an app).
pub fn signed_in(app: &TestApp) -> Client {
    app.user(
        &format!("{}@example.com", openbase::ids::new_id("browser")),
        "Browser",
    )
}

/// `GET /oauth/authorize` with these parameters as a visitor who is NOT signed in.
pub async fn authorize_anonymous(app: &TestApp, pairs: &[(&str, &str)]) -> Response {
    get(app, &format!("/oauth/authorize?{}", encode(pairs))).await
}

/// `GET /oauth/authorize` with these parameters as `user`'s browser (session cookie).
pub async fn authorize_as(app: &TestApp, user: &Client, pairs: &[(&str, &str)]) -> Response {
    let path = format!("/oauth/authorize?{}", encode(pairs));
    app.request_with(user, "GET", &path, None, &[], false, None)
        .await
}

/// `GET /oauth/authorize` with these parameters, from a freshly signed-in browser (a request is
/// stored only for a signed-in person; tests that need no particular user use this).
pub async fn authorize(app: &TestApp, pairs: &[(&str, &str)]) -> Response {
    let user = signed_in(app);
    authorize_as(app, &user, pairs).await
}

/// The standard parameters of an authorization request of a client, plus `extra` parameters
/// (which replace defaults of the same name; an empty value removes the parameter).
pub fn authorize_params(
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    extra: &[(&str, &str)],
) -> Vec<(String, String)> {
    let mut params: Vec<(String, String)> = vec![
        ("response_type".into(), "code".into()),
        ("client_id".into(), client_id.into()),
        ("redirect_uri".into(), redirect_uri.into()),
        ("code_challenge".into(), challenge.into()),
        ("code_challenge_method".into(), "S256".into()),
        ("state".into(), "xyz-state".into()),
    ];
    for (k, v) in extra {
        params.retain(|(pk, _)| pk != k);
        if !v.is_empty() {
            params.push((k.to_string(), v.to_string()));
        }
    }
    params
}

fn as_pairs(params: &[(String, String)]) -> Vec<(&str, &str)> {
    params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect()
}

/// The standard authorization request of a client from a freshly signed-in browser.
pub async fn authorize_with(
    app: &TestApp,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    extra: &[(&str, &str)],
) -> Response {
    let params = authorize_params(client_id, redirect_uri, challenge, extra);
    authorize(app, &as_pairs(&params)).await
}

/// The same request from `user`'s browser.
pub async fn authorize_with_as(
    app: &TestApp,
    user: &Client,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    extra: &[(&str, &str)],
) -> Response {
    let params = authorize_params(client_id, redirect_uri, challenge, extra);
    authorize_as(app, user, &as_pairs(&params)).await
}

/// The same request from a visitor who is not signed in.
pub async fn authorize_with_anonymous(
    app: &TestApp,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    extra: &[(&str, &str)],
) -> Response {
    let params = authorize_params(client_id, redirect_uri, challenge, extra);
    authorize_anonymous(app, &as_pairs(&params)).await
}

pub fn location(res: &Response) -> String {
    res.headers
        .get(header::LOCATION)
        .unwrap_or_else(|| panic!("no Location header; status {}", res.status))
        .to_str()
        .unwrap()
        .to_string()
}

/// The pending request id in the redirect to the consent page.
pub fn request_id(res: &Response) -> String {
    assert_eq!(res.status, 302, "expected a redirect to the consent page");
    let loc = location(res);
    let rest = loc
        .strip_prefix("/oauth/consent?request=")
        .unwrap_or_else(|| panic!("not the consent page: {loc}"));
    rest.to_string()
}

/// Query parameters of a URL (absolute or not).
pub fn query_of(url: &str) -> HashMap<String, String> {
    let parsed = url::Url::parse(url)
        .or_else(|_| url::Url::parse(&format!("http://x{url}")))
        .unwrap();
    parsed
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// `POST /api/oauth/requests/{id}/decision` as a signed-in user.
pub async fn decide(app: &TestApp, user: &Client, id: &str, body: Value) -> Response {
    app.post(user, &format!("/api/oauth/requests/{id}/decision"), body)
        .await
}

pub async fn approve(app: &TestApp, user: &Client, id: &str, access: &str) -> Response {
    decide(
        app,
        user,
        id,
        json!({"decision": "approve", "access": access}),
    )
    .await
}

/// The authorization code in an approval's redirect address.
pub fn code_of(approval: &Response) -> String {
    approval.assert_status(200);
    let params = query_of(approval.body["redirect_to"].as_str().unwrap());
    params
        .get("code")
        .unwrap_or_else(|| panic!("no code in {}", approval.body))
        .clone()
}

pub async fn token_code(
    app: &TestApp,
    client_id: &str,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Response {
    form(
        app,
        "/oauth/token",
        &[
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ],
    )
    .await
}

pub async fn token_refresh(app: &TestApp, client_id: &str, refresh_token: &str) -> Response {
    form(
        app,
        "/oauth/token",
        &[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh_token),
        ],
    )
    .await
}

/// What a completed authorization code flow leaves behind.
pub struct Connected {
    pub client_id: String,
    pub redirect_uri: String,
    pub access: String,
    pub refresh: String,
    pub response: Response,
}

impl Connected {
    /// A bearer client for the access token (for `/mcp`).
    pub fn bearer(&self) -> Client {
        TestApp::bearer(&self.access)
    }
}

/// Register a client and run the whole flow as `user`: authorize, approve with `access` and
/// `base_ids` (None = all bases), exchange the code.
pub async fn connect(
    app: &TestApp,
    user: &Client,
    name: &str,
    access: &str,
    base_ids: Option<Vec<String>>,
) -> Connected {
    let client_id = register_client(app, name, &[LOOPBACK_REDIRECT]).await;
    connect_as(app, user, &client_id, LOOPBACK_REDIRECT, access, base_ids).await
}

pub async fn connect_as(
    app: &TestApp,
    user: &Client,
    client_id: &str,
    redirect_uri: &str,
    access: &str,
    base_ids: Option<Vec<String>>,
) -> Connected {
    let (verifier, challenge) = pkce();
    // The app asks for the scopes of the level it will be given (Full control is offered only to
    // an app that asked for it).
    let asked = scope_for(access);
    let res = authorize_with_as(
        app,
        user,
        client_id,
        redirect_uri,
        &challenge,
        &[("scope", asked)],
    )
    .await;
    let id = request_id(&res);
    let mut body = json!({"decision": "approve", "access": access});
    if let Some(ids) = base_ids {
        body["base_ids"] = json!(ids);
    }
    let approval = decide(app, user, &id, body).await;
    let code = code_of(&approval);
    let response = token_code(app, client_id, &code, redirect_uri, &verifier).await;
    response.assert_status(200);
    Connected {
        client_id: client_id.to_string(),
        redirect_uri: redirect_uri.to_string(),
        access: response.body["access_token"].as_str().unwrap().to_string(),
        refresh: response.body["refresh_token"].as_str().unwrap().to_string(),
        response,
    }
}

/// Names of the tools `tools/list` shows a bearer client.
pub async fn tool_names(app: &TestApp, client: &Client) -> Vec<String> {
    let res = crate::mcp_support::legacy(app, client, "tools/list", json!({})).await;
    res.assert_status(200);
    res.body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect()
}

pub fn audit_actions(app: &TestApp) -> Vec<String> {
    app.state
        .db
        .write_sync(|tx| {
            let mut stmt = tx.prepare("SELECT action FROM audit_log ORDER BY id")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.map(|r| r.unwrap()).collect::<Vec<_>>())
        })
        .unwrap()
}

// ------------------------------------------------------------ metadata document server

#[derive(Clone)]
struct DocState {
    body: Arc<Mutex<Vec<u8>>>,
    content_type: Arc<Mutex<String>>,
    status: Arc<Mutex<u16>>,
    hits: Arc<Mutex<u32>>,
}

/// A throwaway HTTP server on 127.0.0.1 that serves one client metadata document at
/// `/client.json`, and counts requests.
pub struct DocServer {
    pub addr: SocketAddr,
    state: DocState,
}

impl DocServer {
    pub async fn start() -> DocServer {
        let state = DocState {
            body: Arc::new(Mutex::new(Vec::new())),
            content_type: Arc::new(Mutex::new("application/json".into())),
            status: Arc::new(Mutex::new(200)),
            hits: Arc::new(Mutex::new(0)),
        };
        async fn handle(State(st): State<DocState>) -> HttpResponse<Body> {
            *st.hits.lock().unwrap() += 1;
            HttpResponse::builder()
                .status(*st.status.lock().unwrap())
                .header(
                    header::CONTENT_TYPE,
                    st.content_type.lock().unwrap().clone(),
                )
                .body(Body::from(st.body.lock().unwrap().clone()))
                .unwrap()
        }
        let app = Router::new().fallback(handle).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        DocServer { addr, state }
    }

    /// The client_id of the document: its own URL.
    pub fn client_id(&self) -> String {
        format!("http://127.0.0.1:{}/client.json", self.addr.port())
    }

    pub fn serve(&self, doc: &Value) {
        *self.state.body.lock().unwrap() = serde_json::to_vec(doc).unwrap();
    }

    /// Serve a standard document for this server's URL, with `redirect_uris`.
    pub fn serve_default(&self, name: &str, redirect_uris: &[&str]) {
        self.serve(&json!({
            "client_id": self.client_id(),
            "client_name": name,
            "redirect_uris": redirect_uris,
            "token_endpoint_auth_method": "none",
        }));
    }

    pub fn serve_raw(&self, body: Vec<u8>, content_type: &str, status: u16) {
        *self.state.body.lock().unwrap() = body;
        *self.state.content_type.lock().unwrap() = content_type.to_string();
        *self.state.status.lock().unwrap() = status;
    }

    pub fn hits(&self) -> u32 {
        *self.state.hits.lock().unwrap()
    }
}
