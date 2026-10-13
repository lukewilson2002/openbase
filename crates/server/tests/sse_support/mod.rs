//! Helpers for reading Server-Sent Events from the in-process router: real
//! streaming requests through `GET /api/bases/{id}/events`, frames parsed as
//! they arrive.
#![allow(dead_code)]

use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use crate::common::{Client, TestApp};

/// Short keep-alive and access re-check intervals for every test here.
pub fn fast() {
    opengrid::api::events::set_timing_for_tests(
        Duration::from_millis(200),
        Duration::from_millis(150),
    );
}

pub struct Opened {
    pub status: StatusCode,
    pub headers: axum::http::HeaderMap,
    pub error: Value,
    pub stream: Option<Stream>,
}

/// One parsed SSE message.
#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    pub comment: Option<String>,
    pub event: Option<String>,
    pub data: Option<String>,
}

pub struct Stream {
    pub body: Body,
    pub buf: String,
}

pub async fn open(app: &TestApp, client: &Client, base_id: &str) -> Opened {
    fast();
    let mut req = Request::builder()
        .method("GET")
        .uri(format!("/api/bases/{base_id}/events"))
        .header(header::ACCEPT, "text/event-stream");
    if let Some(c) = &client.cookie {
        req = req.header(
            header::COOKIE,
            format!("{}={}", opengrid::auth::SESSION_COOKIE, c),
        );
    }
    if let Some(t) = &client.bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let res = app
        .router
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    if status != StatusCode::OK {
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        return Opened {
            status,
            headers,
            error: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            stream: None,
        };
    }
    Opened {
        status,
        headers,
        error: Value::Null,
        stream: Some(Stream {
            body: res.into_body(),
            buf: String::new(),
        }),
    }
}

impl Opened {
    pub fn stream(self) -> Stream {
        assert_eq!(self.status, StatusCode::OK, "{}", self.error);
        self.stream.expect("stream")
    }
}

pub fn parse(block: &str) -> Msg {
    let mut msg = Msg {
        comment: None,
        event: None,
        data: None,
    };
    for line in block.lines() {
        if let Some(c) = line.strip_prefix(':') {
            msg.comment = Some(c.trim().to_string());
        } else if let Some(e) = line.strip_prefix("event:") {
            msg.event = Some(e.trim().to_string());
        } else if let Some(d) = line.strip_prefix("data:") {
            msg.data = Some(d.trim().to_string());
        }
    }
    msg
}

impl Stream {
    /// The next message, or None when the stream ended; Err on timeout.
    pub async fn next_msg(&mut self, within: Duration) -> Result<Option<Msg>, ()> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            if let Some(i) = self.buf.find("\n\n") {
                let block: String = self.buf.drain(..i + 2).collect();
                return Ok(Some(parse(&block)));
            }
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(left, self.body.frame()).await {
                Err(_) => return Err(()),
                Ok(None) => return Ok(None),
                Ok(Some(Err(e))) => panic!("body error: {e}"),
                Ok(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        self.buf.push_str(std::str::from_utf8(&data).unwrap());
                    }
                }
            }
        }
    }

    /// The next real event (comments skipped): (event name, data JSON).
    pub async fn next_event(&mut self) -> (String, Value) {
        self.try_event(Duration::from_secs(5))
            .await
            .expect("an event within 5s")
    }

    pub async fn try_event(&mut self, within: Duration) -> Option<(String, Value)> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next_msg(left).await {
                Err(()) => return None,
                Ok(None) => panic!("stream ended while waiting for an event"),
                Ok(Some(m)) if m.event.is_some() => {
                    let data: Value = serde_json::from_str(m.data.as_ref().unwrap()).unwrap();
                    return Some((m.event.unwrap(), data));
                }
                Ok(Some(_)) => {}
            }
        }
    }

    /// Wait until the server closes the stream (skipping any events and comments).
    pub async fn expect_closed(&mut self, within: Duration) {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match self.next_msg(left).await {
                Err(()) => panic!("stream stayed open"),
                Ok(None) => return,
                Ok(Some(_)) => {}
            }
        }
    }

    /// Assert that no event (comments aside) arrives for `quiet`.
    pub async fn expect_quiet(&mut self, quiet: Duration) {
        if let Some(ev) = self.try_event(quiet).await {
            panic!("unexpected event {ev:?}");
        }
    }
}

pub const SOON: Duration = Duration::from_secs(5);

