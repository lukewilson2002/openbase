//! Fixtures for the automation tests: a base with typed fields, a local HTTP
//! server that records what it receives, helpers that fire the record-change
//! hook the way the write path does, and a runner with no retry delays.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{Response, StatusCode, header};
use opengrid::automations::runner::{Runner, RunnerOpts};
use opengrid::automations::{RecordChanges, on_records_changed};
use opengrid::config::Config;
use serde_json::{Map, Value, json};

use crate::common::Response as ApiResponse;
use crate::schema_support::Fixture;

// ------------------------------------------------------------ test server

#[derive(Debug, Clone)]
pub struct Hit {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

#[derive(Clone, Default)]
struct ServerState {
    hits: Arc<Mutex<Vec<Hit>>>,
    counters: Arc<Mutex<BTreeMap<String, u32>>>,
}

/// A throwaway HTTP server on 127.0.0.1 that records every request.
///
/// Routes (by path): `/status/{code}`, `/flaky/{key}/{failures}/{code}`
/// (fails with `code` that many times, then answers 200 `{"id": 42}`),
/// `/big` (400 KB body), `/redirect` (302 to `/hit`), `/json`
/// (`{"id": 7, "name": "Widget"}`); anything else answers 200 `{"ok": true}`.
pub struct TestServer {
    pub addr: SocketAddr,
    state: ServerState,
}

impl TestServer {
    pub async fn start() -> TestServer {
        let state = ServerState::default();
        let app = Router::new().fallback(handle).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.ok();
        });
        TestServer { addr, state }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.addr.port())
    }

    pub fn hits(&self) -> Vec<Hit> {
        self.state.hits.lock().unwrap().clone()
    }

    pub fn hits_on(&self, path_prefix: &str) -> Vec<Hit> {
        self.hits()
            .into_iter()
            .filter(|h| h.path.starts_with(path_prefix))
            .collect()
    }
}

async fn handle(State(st): State<ServerState>, req: Request) -> Response<Body> {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 10 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let path = parts.uri.path().to_string();
    st.hits.lock().unwrap().push(Hit {
        method: parts.method.to_string(),
        path: path.clone(),
        query: parts.uri.query().unwrap_or("").to_string(),
        headers: parts
            .headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect(),
        body: String::from_utf8_lossy(&bytes).into_owned(),
    });
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let json_resp = |status: u16, body: Value| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    match segs.as_slice() {
        ["status", code] => Response::builder()
            .status(code.parse::<u16>().unwrap_or(500))
            .body(Body::from(format!("status {code}")))
            .unwrap(),
        ["flaky", key, failures, code] => {
            let n = {
                let mut c = st.counters.lock().unwrap();
                let n = c.entry(key.to_string()).or_insert(0);
                *n += 1;
                *n
            };
            if n <= failures.parse::<u32>().unwrap_or(0) {
                Response::builder()
                    .status(code.parse::<u16>().unwrap_or(503))
                    .body(Body::from("try again later"))
                    .unwrap()
            } else {
                json_resp(200, json!({ "id": 42 }))
            }
        }
        ["big"] => Response::builder()
            .status(200)
            .body(Body::from("a".repeat(400_000)))
            .unwrap(),
        ["redirect"] => Response::builder()
            .status(302)
            .header(header::LOCATION, "/hit")
            .body(Body::empty())
            .unwrap(),
        ["json"] => json_resp(200, json!({ "id": 7, "name": "Widget" })),
        _ => json_resp(200, json!({ "ok": true })),
    }
}

// -------------------------------------------------------------------- env

/// A base with a table (Name, Notes, Amount, Status, Done), a form view, a
/// test HTTP server, SMTP "configured" (the capturing mailer) and
/// `allow_private_webhooks` on so actions can reach the test server.
pub struct Env {
    pub f: Fixture,
    pub server: TestServer,
    pub name: String,
    pub amount: String,
    pub status: String,
    pub done: String,
    pub todo: String,
    pub doing: String,
    pub form_view: String,
    pub runner: Runner,
}

pub fn instant_opts() -> RunnerOpts {
    RunnerOpts {
        retry_delays: [Duration::ZERO, Duration::ZERO],
        concurrency: 1,
        poll: Duration::from_millis(20),
    }
}

impl Env {
    pub async fn new() -> Env {
        Self::with_config(|_| {}).await
    }

    pub async fn with_config(tweak: impl FnOnce(&mut Config)) -> Env {
        let f = Fixture::with_config(|c| {
            c.allow_private_webhooks = true;
            c.smtp_host = Some("smtp.test.invalid".into());
            tweak(c);
        })
        .await;
        let amount = f
            .add_field(
                &f.table_id,
                json!({ "name": "Amount", "type": "number", "options": {} }),
            )
            .await;
        let status = f
            .add_field(
                &f.table_id,
                json!({ "name": "Status", "type": "single_select",
                        "options": { "choices": [ { "name": "Todo" }, { "name": "Doing" }, { "name": "Done" } ] } }),
            )
            .await;
        let done = f
            .add_field(
                &f.table_id,
                json!({ "name": "Finished", "type": "checkbox", "options": {} }),
            )
            .await;
        let choice = |i: usize| {
            status["options"]["choices"][i]["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let r = f
            .app
            .post(
                &f.owner,
                &format!("/api/tables/{}/views", f.table_id),
                json!({ "name": "Intake", "type": "form" }),
            )
            .await;
        r.assert_status(201);
        let runner = Runner::new(f.app.state.clone(), instant_opts());
        Env {
            server: TestServer::start().await,
            name: f.primary_id.clone(),
            amount: amount["id"].as_str().unwrap().into(),
            status: status["id"].as_str().unwrap().into(),
            done: done["id"].as_str().unwrap().into(),
            todo: choice(0),
            doing: choice(1),
            form_view: r.body["id"].as_str().unwrap().into(),
            runner,
            f,
        }
    }

    pub fn table(&self) -> &str {
        &self.f.table_id
    }

    pub fn base(&self) -> &str {
        &self.f.base_id
    }

    // ------------------------------------------------------ definitions

    pub async fn try_create(
        &self,
        name: &str,
        trigger: Value,
        actions: Value,
        enabled: bool,
    ) -> ApiResponse {
        self.f
            .app
            .post(
                &self.f.owner,
                &format!("/api/bases/{}/automations", self.base()),
                json!({ "name": name, "enabled": enabled, "trigger": trigger, "actions": actions }),
            )
            .await
    }

    /// Create (enabled) through the API; panics unless it succeeds.
    pub async fn create(&self, name: &str, trigger: Value, actions: Value) -> Value {
        let r = self.try_create(name, trigger, actions, true).await;
        r.assert_status(201);
        r.body.clone()
    }

    pub fn trigger_created(&self) -> Value {
        json!({ "type": "record_created", "table_id": self.table() })
    }

    pub fn trigger_updated(&self, fields: &[&str]) -> Value {
        json!({ "type": "record_updated", "table_id": self.table(), "field_ids": fields })
    }

    pub fn trigger_matches(&self, filter: Value) -> Value {
        json!({ "type": "record_matches", "table_id": self.table(), "filter": filter })
    }

    pub fn notify_action(&self, message: &str) -> Value {
        json!({ "type": "notify", "user_ids": [self.f.owner.user_id.clone().unwrap()], "message": message })
    }

    /// Filter: Status is `choice`.
    pub fn status_is(&self, choice: &str) -> Value {
        json!({ "conjunction": "and", "items": [
            { "field_id": self.status, "op": "is", "value": choice }
        ] })
    }

    // --------------------------------------------------------- records

    pub fn rec(&self, data: Value) -> String {
        self.f.insert_record(self.table(), data)
    }

    pub fn set_data(&self, record_id: &str, data: Value) {
        let (id, data) = (record_id.to_string(), data.to_string());
        crate::schema_support::sql(&self.f.app, |tx| {
            tx.execute(
                "UPDATE records SET data = ?2 WHERE id = ?1",
                rusqlite::params![id, data],
            )
        });
    }

    /// Call the hook as the record write path would after creating `ids`.
    pub fn fire_created(&self, ids: &[&str]) {
        self.fire(RecordChangesOwned {
            created: ids.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        });
    }

    /// ... after updating `record_id`, whose fields `changed` changed.
    pub fn fire_updated(&self, record_id: &str, changed: &[&str]) {
        self.fire(RecordChangesOwned {
            updated: vec![(
                record_id.to_string(),
                changed.iter().map(|s| s.to_string()).collect(),
            )],
            ..Default::default()
        });
    }

    /// ... with the previous data of the record supplied.
    pub fn fire_updated_with_before(&self, record_id: &str, changed: &[&str], before: Value) {
        let Value::Object(before) = before else {
            panic!("before must be an object")
        };
        self.fire(RecordChangesOwned {
            updated: vec![(
                record_id.to_string(),
                changed.iter().map(|s| s.to_string()).collect(),
            )],
            before: vec![(record_id.to_string(), before)],
            ..Default::default()
        });
    }

    pub fn fire(&self, c: RecordChangesOwned) {
        let table = self.table().to_string();
        let base = self.base().to_string();
        let user = self.f.owner.user_id.clone();
        self.f
            .app
            .state
            .db
            .write_sync(|tx| {
                on_records_changed(
                    tx,
                    &RecordChanges {
                        base_id: &base,
                        table_id: &table,
                        created: &c.created,
                        updated: &c.updated,
                        form_view_id: c.form_view_id.as_deref(),
                        user_id: user.as_deref(),
                        by_automation: c.by_automation,
                        before: &c.before,
                    },
                )
            })
            .unwrap();
    }

    // ------------------------------------------------------------ runs

    /// Run everything runnable. Panics if the queue never empties (an
    /// automation loop would otherwise hang the test).
    pub async fn drain(&self) -> usize {
        tokio::time::timeout(Duration::from_secs(20), self.runner.drain())
            .await
            .expect("the runner never went idle: runs keep queueing more runs")
            .unwrap()
    }

    pub fn run_count(&self, automation_id: &str) -> i64 {
        self.f.app.query_i64(
            "SELECT count(*) FROM automation_runs WHERE automation_id = ?1",
            &[automation_id],
        )
    }

    /// Runs of an automation through the API, oldest first.
    pub async fn runs(&self, automation_id: &str) -> Vec<Value> {
        let r = self
            .f
            .app
            .get(
                &self.f.owner,
                &format!("/api/automations/{automation_id}/runs?limit=200"),
            )
            .await;
        r.assert_status(200);
        let mut runs = r.body["runs"].as_array().unwrap().clone();
        runs.reverse();
        runs
    }

    /// The only run of an automation.
    pub async fn only_run(&self, automation_id: &str) -> Value {
        let runs = self.runs(automation_id).await;
        assert_eq!(runs.len(), 1, "expected exactly one run, got {runs:#?}");
        runs.into_iter().next().unwrap()
    }

    pub fn record_count(&self) -> i64 {
        self.f.app.query_i64(
            "SELECT count(*) FROM records WHERE table_id = ?1 AND deleted_at IS NULL",
            &[self.table()],
        )
    }

    /// Insert an automation row directly, bypassing save-time validation
    /// (for definitions the API would refuse, or that went stale later).
    pub fn insert_raw(&self, trigger: Value, actions: Value, enabled: bool) -> String {
        let id = opengrid::automations::store::new_automation_id();
        let row = opengrid::automations::store::AutomationRow {
            id: id.clone(),
            base_id: self.base().to_string(),
            name: "raw".into(),
            enabled,
            trigger: serde_json::from_value(trigger).unwrap(),
            actions: serde_json::from_value(actions).unwrap(),
            webhook_token_hash: None,
            next_run_at: None,
            created_by: self.f.owner.user_id.clone(),
            created_at: 1,
            updated_at: 1,
        };
        self.f
            .app
            .state
            .db
            .write_sync(|tx| opengrid::automations::store::insert(tx, &row))
            .unwrap();
        id
    }

    /// Queue a run by hand with the given trigger data.
    pub fn queue_run(&self, automation_id: &str, trigger_data: Value) -> i64 {
        let id = automation_id.to_string();
        self.f
            .app
            .state
            .db
            .write_sync(|tx| {
                Ok(opengrid::automations::store::enqueue_run(tx, &id, &trigger_data)?.unwrap())
            })
            .unwrap()
    }

    /// Queue a run for a record trigger of the given record's current data.
    pub fn queue_record_run(&self, automation_id: &str, kind: &str, record_id: &str) -> i64 {
        let data = crate::schema_support::record_data(&self.f.app, record_id);
        self.queue_run(
            automation_id,
            json!({ "type": kind, "time": 1_700_000_000_000i64, "record":
                    { "id": record_id, "table_id": self.table(), "fields": data } }),
        )
    }

    pub fn run_row(&self, run_id: i64) -> Value {
        let run = self
            .f
            .app
            .state
            .db
            .write_sync(|tx| opengrid::automations::store::get_run(tx, run_id))
            .unwrap();
        serde_json::to_value(run.dto()).unwrap()
    }
}

#[derive(Default)]
pub struct RecordChangesOwned {
    pub created: Vec<String>,
    pub updated: Vec<(String, Vec<String>)>,
    pub form_view_id: Option<String>,
    pub by_automation: bool,
    pub before: Vec<(String, Map<String, Value>)>,
}

/// Status lines of a run's log, e.g. `["create_record:succeeded", ...]`.
pub fn log_summary(run: &Value) -> Vec<String> {
    run["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            format!(
                "{}:{}",
                l["action"].as_str().unwrap(),
                l["status"].as_str().unwrap()
            )
        })
        .collect()
}

pub fn status_code(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap()
}
