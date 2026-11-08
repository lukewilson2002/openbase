//! Real-time events: `GET /api/bases/{id}/events` (Server-Sent Events).
//!
//! The stream carries the base's [`EventEnvelope`]s from the in-process event
//! bus. Each message is `event: <kind>` (`records_changed`, `schema_changed`,
//! `comments_changed`, `base_changed`, `presence_changed`) and `data: <envelope JSON>`; clients
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
//! * **Presence.** An open stream counts its user as viewing the base. The
//!   user's first stream announces `presence_changed {viewers}` to the streams
//!   already open, their last one closing announces it again (any way the
//!   stream ends: client disconnect, lost access, shutdown), and
//!   `GET /api/bases/{id}/presence` answers the same list on demand. Several
//!   tabs of one user count once. Every new stream starts with the current list
//!   (the new viewer included) as its first event, right after the greeting
//!   comment: a `presence_changed` frame without a `user_id`, so a client needs
//!   no separate GET and cannot miss an arrival in between. It does not receive
//!   its own arrival a second time.
//! * **Workspace stream.** `GET /api/workspaces/{id}/events` relays the events of
//!   every project of the workspace the caller can open, so Home needs one
//!   connection instead of one per project (see [`stream_workspace_events`]).
//! * **Echoes.** Every event carries the `client_id` (the `X-Client-Id` of the
//!   request that caused it) so a client can skip its own changes.

use std::collections::{HashSet, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use futures::Stream;
use ob_core::api::events::{BaseEvent, EventEnvelope, Presence};
use rusqlite::Connection;
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::time::Instant;

use crate::auth::Actor;
use crate::db::now_ms;
use crate::error::{AppError, AppResult};
use crate::events::{PresenceGuard, WorkspaceStreamGuard};
use crate::perm::{self, Role};
use crate::state::AppState;
use crate::store::workspaces;

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
    Router::new()
        .route("/api/bases/{id}/events", get(stream_events))
        .route("/api/bases/{id}/presence", get(presence))
        .route("/api/workspaces/{id}/events", get(stream_workspace_events))
}

/// Who has the base open right now.
async fn presence(
    State(state): State<AppState>,
    actor: Actor,
    Path(base_id): Path<String>,
) -> AppResult<Json<Presence>> {
    let (a, b) = (actor, base_id.clone());
    state
        .db
        .read(move |conn| perm::require_base(conn, &a, &b, Role::Viewer).map(|_| ()))
        .await?;
    Ok(Json(Presence {
        viewers: state.events.viewers(&base_id),
    }))
}

/// Whether the actor may still read the base: the credential is still valid
/// (see [`actor_valid`]) and the role is at least Viewer.
fn access_ok(conn: &Connection, actor: &Actor, base_id: &str) -> bool {
    actor_valid(conn, actor) && perm::require_base(conn, actor, base_id, Role::Viewer).is_ok()
}

/// Whether the actor's credential still stands: the user is active and a
/// session actor's session (or a token actor's API token, or an OAuth grant)
/// has not ended.
fn actor_valid(conn: &Connection, actor: &Actor) -> bool {
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
    if let Some(grant) = &actor.oauth_grant_id {
        // A revoked OAuth grant ends its streams too.
        let valid: bool = conn
            .query_row(
                "SELECT count(*) > 0 FROM oauth_grants WHERE id = ?1",
                [grant],
                |r| r.get(0),
            )
            .unwrap_or(false);
        if !valid {
            return false;
        }
    }
    true
}

struct Feed {
    state: AppState,
    actor: Actor,
    base_id: String,
    rx: broadcast::Receiver<std::sync::Arc<EventEnvelope>>,
    /// `true` once the server is shutting down: the stream ends.
    shutdown: tokio::sync::watch::Receiver<bool>,
    greeted: bool,
    /// The viewers at connect time, sent as the first event (see the module docs).
    snapshot: Option<Vec<String>>,
    next_recheck: Instant,
    /// Leaves the base's presence list when the feed is dropped, whichever way
    /// the stream ends (including a client that simply disconnects).
    _presence: PresenceGuard,
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
        BaseEvent::PresenceChanged { .. } => "presence_changed",
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
        if let Some(viewers) = feed.snapshot.take() {
            let env = EventEnvelope {
                base_id: feed.base_id.clone(),
                client_id: None,
                user_id: None,
                event: BaseEvent::PresenceChanged { viewers },
            };
            return Some((Ok(to_sse(&env)), feed));
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
    // Join, subscribe and read the viewers in one step: the new stream is not
    // told about its own arrival, and misses no later one.
    let (presence, rx, viewers) = state.events.join_and_subscribe(&base_id, &actor.user_id);
    let shutdown = state.events.shutdown_signal();
    let feed = Feed {
        state,
        actor,
        base_id,
        rx,
        shutdown,
        greeted: false,
        snapshot: Some(viewers),
        next_recheck: Instant::now() + recheck_interval(),
        _presence: presence,
    };
    Ok(Sse::new(feed_stream(feed)).keep_alive(
        KeepAlive::new().interval(Duration::from_millis(KEEP_ALIVE_MS.load(Ordering::Relaxed))),
    ))
}

// ------------------------------------------------------- workspace stream

/// The projects of the workspace the actor can open right now.
fn readable_projects(
    conn: &Connection,
    actor: &Actor,
    workspace_id: &str,
) -> AppResult<HashSet<String>> {
    Ok(workspaces::base_ids(conn, workspace_id)?
        .into_iter()
        .filter(|b| perm::require_base(conn, actor, b, Role::Viewer).is_ok())
        .collect())
}

/// Whether the actor still stands in the workspace: a live credential and a
/// workspace role. Without them the stream ends.
fn still_member(conn: &Connection, actor: &Actor, workspace_id: &str) -> bool {
    actor_valid(conn, actor)
        && perm::workspace_role(conn, &actor.user_id, workspace_id)
            .ok()
            .flatten()
            .is_some()
}

struct WorkspaceFeed {
    state: AppState,
    actor: Actor,
    workspace_id: String,
    /// Every project's events; this stream keeps the ones in `allowed`.
    rx: broadcast::Receiver<std::sync::Arc<EventEnvelope>>,
    shutdown: tokio::sync::watch::Receiver<bool>,
    greeted: bool,
    /// The projects being relayed. Only this set decides what passes: an event
    /// of any other project, including every other workspace's, is dropped.
    allowed: HashSet<String>,
    /// Synthetic `base_changed` notices waiting to be sent.
    queue: VecDeque<Event>,
    next_recheck: Instant,
    /// Frees the user's stream slot, whichever way the stream ends.
    _slot: WorkspaceStreamGuard,
}

impl WorkspaceFeed {
    /// Re-read which projects the actor can open. A project that appeared or
    /// vanished since the last look is announced with `base_changed` (all of
    /// them when `everything`, after a lag). `false`: access to the whole
    /// workspace is gone and the stream must end.
    async fn refresh(&mut self, everything: bool) -> bool {
        self.next_recheck = Instant::now() + recheck_interval();
        let (actor, ws) = (self.actor.clone(), self.workspace_id.clone());
        let now = self
            .state
            .db
            .read(move |conn| {
                still_member(conn, &actor, &ws)
                    .then(|| readable_projects(conn, &actor, &ws))
                    .transpose()
            })
            .await
            .unwrap_or(None);
        let Some(now) = now else {
            return false;
        };
        let mut changed: Vec<&String> = if everything {
            now.union(&self.allowed).collect()
        } else {
            now.symmetric_difference(&self.allowed).collect()
        };
        changed.sort();
        self.queue
            .extend(changed.into_iter().map(|id| base_changed(id)));
        self.allowed = now;
        true
    }

    /// Whether the actor can open `base_id`, a project of this workspace: only
    /// `base_changed` events ask (a project created, granted, restored, taken
    /// away or deleted). `None`: the actor lost the workspace itself.
    async fn can_open(&mut self, base_id: &str) -> Option<bool> {
        let (actor, ws, base) = (
            self.actor.clone(),
            self.workspace_id.clone(),
            base_id.to_string(),
        );
        // Every project of the server passes here, most of them another workspace's. The
        // bus settles which workspace a project is in once for all streams, so those cost
        // no read here.
        let db = self.state.db.clone();
        let looked_up = base.clone();
        let home = self
            .state
            .events
            .workspace_of(base_id, || async move {
                db.read(move |conn| {
                    Ok(conn.query_row(
                        "SELECT workspace_id FROM bases WHERE id = ?1",
                        [&looked_up],
                        |r| r.get::<_, String>(0),
                    )?)
                })
                .await
            })
            .await;
        if !home.is_ok_and(|home| home == ws) {
            return Some(false);
        }
        self.state
            .db
            .read(move |conn| {
                if !still_member(conn, &actor, &ws) {
                    return Ok(None);
                }
                Ok(Some(
                    perm::require_base(conn, &actor, &base, Role::Viewer).is_ok(),
                ))
            })
            .await
            .unwrap_or(None)
    }
}

fn workspace_feed_stream(feed: WorkspaceFeed) -> impl Stream<Item = Result<Event, Infallible>> {
    futures::stream::unfold(feed, |mut feed| async move {
        if !feed.greeted {
            feed.greeted = true;
            return Some((Ok(Event::default().comment("connected")), feed));
        }
        loop {
            if let Some(event) = feed.queue.pop_front() {
                return Some((Ok(event), feed));
            }
            let received = tokio::select! {
                biased;
                _ = feed.shutdown.wait_for(|down| *down) => return None,
                msg = feed.rx.recv() => Some(msg),
                _ = tokio::time::sleep_until(feed.next_recheck) => None,
            };
            match received {
                None => {
                    if !feed.refresh(false).await {
                        return None;
                    }
                }
                Some(Ok(env)) => {
                    let was = feed.allowed.contains(&env.base_id);
                    if matches!(env.event, BaseEvent::BaseChanged) {
                        let now = feed.can_open(&env.base_id).await?;
                        if now {
                            feed.allowed.insert(env.base_id.clone());
                        } else {
                            feed.allowed.remove(&env.base_id);
                        }
                        // A project that just left the list is still announced,
                        // so the client drops it; one that never was is not.
                        if now || was {
                            return Some((Ok(to_sse(&env)), feed));
                        }
                    } else if was {
                        return Some((Ok(to_sse(&env)), feed));
                    }
                }
                Some(Err(RecvError::Lagged(_))) => {
                    if !feed.refresh(true).await {
                        return None;
                    }
                }
                Some(Err(RecvError::Closed)) => return None,
            }
        }
    })
}

/// `GET /api/workspaces/{id}/events`: one stream for all the projects of a
/// workspace the caller can open, for Home, which cannot hold a connection per
/// project (a browser allows about six per site).
///
/// The messages are the projects' own (`records_changed`, `schema_changed`,
/// `comments_changed`, `base_changed`) with the same envelope; its `base_id`
/// says which project an event belongs to. `presence_changed` is never relayed,
/// and the stream does not count its user as viewing any project: that is what
/// the per-project stream is for.
///
/// Projects created, restored or granted after the stream opened start being
/// relayed when their `base_changed` passes (creating and duplicating publish
/// one); a project the caller loses (access removed, project deleted) is
/// announced once with `base_changed` and then dropped. The whole set is also
/// re-read every [`RECHECK`] and after a lag, announcing the difference. The
/// stream ends when the caller leaves the workspace or the credential ends.
async fn stream_workspace_events(
    State(state): State<AppState>,
    actor: Actor,
    Path(workspace_id): Path<String>,
) -> AppResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let slot = state
        .events
        .open_workspace_stream(&actor.user_id)
        .ok_or(AppError::TooManyRequests)?;
    let (a, w, events) = (actor.clone(), workspace_id.clone(), state.events.clone());
    let (rx, allowed) = state
        .db
        .read(move |conn| {
            if perm::workspace_role(conn, &a.user_id, &w)?.is_none() {
                return Err(AppError::not_found("workspace"));
            }
            // Subscribe before listing the projects: one created in between is
            // then seen as an event instead of being missed.
            let rx = events.subscribe_all();
            let allowed = readable_projects(conn, &a, &w)?;
            // A token limited to other workspaces' projects does not see this one.
            let limited = a.token_scope.as_ref().is_some_and(|s| s.base_ids.is_some());
            if limited && allowed.is_empty() {
                return Err(AppError::not_found("workspace"));
            }
            Ok((rx, allowed))
        })
        .await?;
    let shutdown = state.events.shutdown_signal();
    let feed = WorkspaceFeed {
        state,
        actor,
        workspace_id,
        rx,
        shutdown,
        greeted: false,
        allowed,
        queue: VecDeque::new(),
        next_recheck: Instant::now() + recheck_interval(),
        _slot: slot,
    };
    Ok(Sse::new(workspace_feed_stream(feed)).keep_alive(
        KeepAlive::new().interval(Duration::from_millis(KEEP_ALIVE_MS.load(Ordering::Relaxed))),
    ))
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
            (
                BaseEvent::PresenceChanged {
                    viewers: vec!["u".into()],
                },
                "presence_changed",
            ),
        ];
        for (event, name) in cases {
            assert_eq!(event_name(&event), name);
            // Must agree with the serde tag clients see in the data.
            let json = serde_json::to_value(&event).unwrap();
            assert_eq!(json["kind"], name);
        }
    }
}
