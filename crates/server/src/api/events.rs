//! Real-time events: `GET /api/bases/{id}/events` (Server-Sent Events).
//!
//! The stream carries the base's [`EventEnvelope`]s from the in-process event
//! bus. Each message is `event: <kind>` (`records_changed`, `schema_changed`,
//! `comments_changed`, `base_changed`) and `data: <envelope JSON>`; clients
//! use them as invalidation hints and refetch what they display. A comment
//! line (`: keep-alive`) is sent every [`KEEP_ALIVE`] so proxies keep the
//! connection open.
//!
//! * **Access.** The caller needs the Viewer role on the base (sessions and
//!   API tokens both work). Access is checked when the stream opens, again
//!   whenever a `base_changed` event passes (membership, ownership or the base
//!   itself changed), after a lag, and every [`RECHECK`]; the stream ends as
//!   soon as access is gone (role revoked, base or workspace deleted, user
//!   deactivated, session ended, API token deleted or expired).
//! * **Lag.** The bus is a bounded broadcast channel. A client too slow to keep
//!   up misses events; it is told with a synthetic `base_changed` event, which
//!   by contract means "refetch everything".
//! * **Shutdown.** When the server is asked to stop, every stream ends
//!   ([`crate::events::EventBus::begin_shutdown`]); otherwise graceful
//!   shutdown would wait for them forever.
//! * **Echoes.** Every event carries the `client_id` (the `X-Client-Id` of the
//!   request that caused it) so a client can skip its own changes.

use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use futures::Stream;
use og_core::api::events::{BaseEvent, EventEnvelope};
use rusqlite::Connection;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::time::Instant;

use crate::auth::Actor;
use crate::db::now_ms;
use crate::error::AppResult;
use crate::events::EventBus;
use crate::perm::{self, Role};
use crate::state::AppState;

/// Interval of the keep-alive comment.
pub const KEEP_ALIVE: Duration = Duration::from_secs(15);
/// How often access is re-checked even when no event arrives.
pub const RECHECK: Duration = Duration::from_secs(60);

static KEEP_ALIVE_MS: AtomicU64 = AtomicU64::new(KEEP_ALIVE.as_millis() as u64);
static RECHECK_MS: AtomicU64 = AtomicU64::new(RECHECK.as_millis() as u64);

/// Shorten the keep-alive and access re-check intervals for every stream
/// opened afterwards (process-wide; for tests, which cannot wait a minute).
pub fn set_timing_for_tests(keep_alive: Duration, recheck: Duration) {
    KEEP_ALIVE_MS.store(keep_alive.as_millis().max(1) as u64, Ordering::Relaxed);
    RECHECK_MS.store(recheck.as_millis().max(1) as u64, Ordering::Relaxed);
}

fn recheck_interval() -> Duration {
    Duration::from_millis(RECHECK_MS.load(Ordering::Relaxed))
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/bases/{id}/events", get(stream_events))
}

/// Whether the actor may still read the base: the user is active, a session
/// actor's session (or a token actor's API token) is still valid, and the role
/// is at least Viewer.
fn access_ok(conn: &Connection, actor: &Actor, base_id: &str) -> bool {
    let active: bool = conn
        .query_row(
            "SELECT is_active FROM users WHERE id = ?1",
            [&actor.user_id],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !active {
        return false;
    }
    if let Some(hash) = &actor.session_hash {
        let valid: bool = conn
            .query_row(
                "SELECT count(*) > 0 FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
                rusqlite::params![hash, now_ms()],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !valid {
            return false;
        }
    }
    if let Some(hash) = &actor.token_hash {
        // A deleted or expired API token ends its streams like a ended session.
        let valid: bool = conn
            .query_row(
                "SELECT count(*) > 0 FROM api_tokens
                 WHERE token_hash = ?1 AND (expires_at IS NULL OR expires_at > ?2)",
                rusqlite::params![hash, now_ms()],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !valid {
            return false;
        }
    }
    perm::require_base(conn, actor, base_id, Role::Viewer).is_ok()
}

struct Feed {
    state: AppState,
    actor: Actor,
    base_id: String,
    rx: broadcast::Receiver<std::sync::Arc<EventEnvelope>>,
    /// `true` once the server is shutting down: the stream ends.
    shutdown: tokio::sync::watch::Receiver<bool>,
    greeted: bool,
    next_recheck: Instant,
}

impl Feed {
    async fn still_allowed(&mut self) -> bool {
        self.next_recheck = Instant::now() + recheck_interval();
        let (actor, base) = (self.actor.clone(), self.base_id.clone());
        self.state
            .db
            .read(move |conn| Ok(access_ok(conn, &actor, &base)))
            .await
            .unwrap_or(false)
    }
}

/// The SSE event name of a base event: its snake_case kind.
pub fn event_name(event: &BaseEvent) -> &'static str {
    match event {
        BaseEvent::RecordsChanged { .. } => "records_changed",
        BaseEvent::SchemaChanged { .. } => "schema_changed",
        BaseEvent::CommentsChanged { .. } => "comments_changed",
        BaseEvent::BaseChanged => "base_changed",
    }
}

fn to_sse(env: &EventEnvelope) -> Event {
    let data = serde_json::to_string(env).unwrap_or_else(|_| "{}".to_string());
    Event::default().event(event_name(&env.event)).data(data)
}

fn base_changed(base_id: &str) -> Event {
    to_sse(&EventEnvelope {
        base_id: base_id.to_string(),
        client_id: None,
        user_id: None,
        event: BaseEvent::BaseChanged,
    })
}

/// Turn a subscription into the SSE event stream; ends when the bus closes or
/// the caller loses access.
fn feed_stream(feed: Feed) -> impl Stream<Item = Result<Event, Infallible>> {
    futures::stream::unfold(feed, |mut feed| async move {
        if !feed.greeted {
            // An immediate frame lets proxies flush the response headers.
            feed.greeted = true;
            return Some((Ok(Event::default().comment("connected")), feed));
        }
        loop {
            let received = tokio::select! {
                // Checked first so a closing server is never kept waiting by
                // a busy stream.
                biased;
                _ = feed.shutdown.wait_for(|down| *down) => return None,
                msg = feed.rx.recv() => Some(msg),
                _ = tokio::time::sleep_until(feed.next_recheck) => None,
            };
            match received {
                None => {
                    if !feed.still_allowed().await {
                        return None;
                    }
                }
                Some(Ok(env)) => {
                    if matches!(env.event, BaseEvent::BaseChanged) && !feed.still_allowed().await {
                        return None;
                    }
                    return Some((Ok(to_sse(&env)), feed));
                }
                Some(Err(RecvError::Lagged(_))) => {
                    if !feed.still_allowed().await {
                        return None;
                    }
                    let event = base_changed(&feed.base_id);
                    return Some((Ok(event), feed));
                }
                Some(Err(RecvError::Closed)) => return None,
            }
        }
    })
}

async fn stream_events(
    State(state): State<AppState>,
    actor: Actor,
    Path(base_id): Path<String>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let (a, b) = (actor.clone(), base_id.clone());
    state
        .db
        .read(move |conn| perm::require_base(conn, &a, &b, Role::Viewer).map(|_| ()))
        .await?;
    // Subscribe only after the access check: subscribing creates the base's
    // channel, which must not be possible for ids the caller cannot read.
    let rx = subscribe(&state.events, &base_id);
    let shutdown = state.events.shutdown_signal();
    let feed = Feed {
        state,
        actor,
        base_id,
        rx,
        shutdown,
        greeted: false,
        next_recheck: Instant::now() + recheck_interval(),
    };
    Ok(Sse::new(feed_stream(feed)).keep_alive(
        KeepAlive::new().interval(Duration::from_millis(KEEP_ALIVE_MS.load(Ordering::Relaxed))),
    ))
}

fn subscribe(bus: &EventBus, base_id: &str) -> broadcast::Receiver<std::sync::Arc<EventEnvelope>> {
    bus.subscribe(base_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_are_the_snake_case_kinds() {
        let cases = [
            (
                BaseEvent::RecordsChanged {
                    table_id: "t".into(),
                    created: vec![],
                    updated: vec![],
                    deleted: vec![],
                },
                "records_changed",
            ),
            (
                BaseEvent::SchemaChanged { table_id: None },
                "schema_changed",
            ),
            (
                BaseEvent::CommentsChanged {
                    record_id: "r".into(),
                },
                "comments_changed",
            ),
            (BaseEvent::BaseChanged, "base_changed"),
        ];
        for (event, name) in cases {
            assert_eq!(event_name(&event), name);
            // Must agree with the serde tag clients see in the data.
            let json = serde_json::to_value(&event).unwrap();
            assert_eq!(json["kind"], name);
        }
    }
}
