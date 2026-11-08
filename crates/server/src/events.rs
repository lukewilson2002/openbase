//! In-process event bus: one broadcast channel per base, created on first
//! subscriber and dropped when the last subscriber leaves. No Redis, no
//! cross-process fan-out: OpenBase runs as a single process by design.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use ob_core::api::events::{BaseEvent, EventEnvelope};
use tokio::sync::{OnceCell, broadcast, watch};

use crate::store::versions::DataVersions;

const CHANNEL_CAPACITY: usize = 256;
/// The all-projects tap carries the traffic of every project at once, so it is
/// roomier than a single project's channel.
const TAP_CAPACITY: usize = 1024;
/// Open workspace event streams one user may hold (see
/// [`EventBus::open_workspace_stream`]). A browser keeps one per tab and
/// allows about six connections per site, so this is generous; it stops a
/// runaway client from holding the server's connections.
pub const MAX_WORKSPACE_STREAMS_PER_USER: usize = 20;
/// Projects whose workspace [`EventBus::workspace_of`] remembers before it starts over.
const HOME_CACHE_MAX: usize = 100_000;

/// Flipped to `true` when the server begins to shut down.
#[derive(Clone)]
struct Shutdown(Arc<watch::Sender<bool>>);

impl Default for Shutdown {
    fn default() -> Self {
        Shutdown(Arc::new(watch::channel(false).0))
    }
}

/// Every project's events in one channel, for the workspace stream
/// (`GET /api/workspaces/{id}/events`), which relays many projects at once and
/// so cannot hold a subscription per project.
#[derive(Clone)]
struct Tap(broadcast::Sender<Arc<EventEnvelope>>);

impl Default for Tap {
    fn default() -> Self {
        Tap(broadcast::channel(TAP_CAPACITY).0)
    }
}

/// Which workspace each project belongs to, for the workspace streams. A project never moves
/// between workspaces, so an answer stays right for as long as the project exists.
#[derive(Default)]
struct Homes {
    cells: Mutex<HashMap<String, Arc<OnceCell<String>>>>,
    /// How many times the answer had to be loaded (tests and metrics).
    loads: AtomicU64,
}

/// A user with open event streams on one base.
struct Viewer {
    user_id: String,
    /// Open streams (browser tabs); the user counts as present while > 0.
    streams: usize,
}

/// Who is viewing each base, by first arrival. Memory only: a restart empties
/// it and clients reconnect (and so rejoin).
type Presence = Arc<Mutex<HashMap<String, Vec<Viewer>>>>;

#[derive(Clone, Default)]
pub struct EventBus {
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<Arc<EventEnvelope>>>>>,
    presence: Presence,
    versions: DataVersions,
    shutdown: Shutdown,
    tap: Tap,
    /// Open workspace streams per user id.
    workspace_streams: Arc<Mutex<HashMap<String, usize>>>,
    homes: Arc<Homes>,
}

/// One open workspace event stream of a user. Dropping it frees the user's
/// slot. It is deliberately not [`PresenceGuard`]: a workspace stream never
/// counts as viewing any project.
pub struct WorkspaceStreamGuard {
    bus: EventBus,
    user_id: String,
}

impl Drop for WorkspaceStreamGuard {
    fn drop(&mut self) {
        let mut map = self
            .bus
            .workspace_streams
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(n) = map.get_mut(&self.user_id) {
            *n -= 1;
            if *n == 0 {
                map.remove(&self.user_id);
            }
        }
    }
}

/// One open event stream of a user on a base. Dropping it (the stream ended or
/// the client went away) leaves the base; the last guard of a user announces
/// that they stopped viewing.
pub struct PresenceGuard {
    bus: EventBus,
    base_id: String,
    user_id: String,
}

fn viewer_ids(viewers: &[Viewer]) -> Vec<String> {
    viewers.iter().map(|v| v.user_id.clone()).collect()
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.bus.leave(&self.base_id, &self.user_id);
    }
}

impl EventBus {
    /// Tell every open event stream to end: graceful shutdown waits for open
    /// connections, and an SSE stream otherwise never finishes by itself.
    pub fn begin_shutdown(&self) {
        self.shutdown.0.send_replace(true);
    }

    /// Becomes `true` once [`EventBus::begin_shutdown`] was called.
    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.shutdown.0.subscribe()
    }

    /// The per-base data versions bumped by [`EventBus::publish`]; the view
    /// query cache is keyed by them.
    pub fn versions(&self) -> &DataVersions {
        &self.versions
    }

    /// Register an open event stream of `user_id` on `base_id`. The user's first
    /// stream on the base broadcasts `presence_changed`; more streams of the
    /// same user (other tabs) change nothing. Hold the guard as long as the
    /// stream lives.
    pub fn join(&self, base_id: &str, user_id: &str) -> PresenceGuard {
        self.join_then(base_id, user_id, |_| ()).0
    }

    /// [`EventBus::join`] and [`EventBus::subscribe`] in one step, plus the viewers right after
    /// joining (the new stream included): the subscription starts exactly where that list
    /// ends, so a stream that sends the list first never misses an arrival or departure, and
    /// is not told about its own.
    pub fn join_and_subscribe(
        &self,
        base_id: &str,
        user_id: &str,
    ) -> (
        PresenceGuard,
        broadcast::Receiver<Arc<EventEnvelope>>,
        Vec<String>,
    ) {
        let (guard, (rx, viewers)) = self.join_then(base_id, user_id, |viewers| {
            // Presence lock held: nobody joins or leaves before the subscription exists.
            (self.subscribe(base_id), viewer_ids(viewers))
        });
        (guard, rx, viewers)
    }

    /// Register the stream (announcing it to the subscribers there are), then run `then` with the
    /// viewer list while the presence lock is still held.
    fn join_then<T>(
        &self,
        base_id: &str,
        user_id: &str,
        then: impl FnOnce(&[Viewer]) -> T,
    ) -> (PresenceGuard, T) {
        let out = {
            let mut map = self.presence.lock().unwrap_or_else(|p| p.into_inner());
            let viewers = map.entry(base_id.to_string()).or_default();
            match viewers.iter_mut().find(|v| v.user_id == user_id) {
                Some(v) => v.streams += 1,
                None => {
                    viewers.push(Viewer {
                        user_id: user_id.to_string(),
                        streams: 1,
                    });
                    // Announced under the lock so announcements keep their order.
                    self.announce(base_id, user_id, viewers);
                }
            }
            then(viewers)
        };
        (
            PresenceGuard {
                bus: self.clone(),
                base_id: base_id.to_string(),
                user_id: user_id.to_string(),
            },
            out,
        )
    }

    fn leave(&self, base_id: &str, user_id: &str) {
        let mut map = self.presence.lock().unwrap_or_else(|p| p.into_inner());
        let Some(viewers) = map.get_mut(base_id) else {
            return;
        };
        let Some(at) = viewers.iter().position(|v| v.user_id == user_id) else {
            return;
        };
        viewers[at].streams -= 1;
        if viewers[at].streams > 0 {
            return;
        }
        viewers.remove(at);
        self.announce(base_id, user_id, viewers);
        if viewers.is_empty() {
            map.remove(base_id);
        }
    }

    fn announce(&self, base_id: &str, user_id: &str, viewers: &[Viewer]) {
        self.publish(
            base_id,
            None,
            Some(user_id.to_string()),
            BaseEvent::PresenceChanged {
                viewers: viewer_ids(viewers),
            },
        );
    }

    /// The users viewing `base_id` now (one open event stream or more), in the
    /// order they arrived.
    pub fn viewers(&self, base_id: &str) -> Vec<String> {
        let map = self.presence.lock().unwrap_or_else(|p| p.into_inner());
        map.get(base_id)
            .map(|v| v.iter().map(|v| v.user_id.clone()).collect())
            .unwrap_or_default()
    }

    /// Take a slot for a workspace event stream of `user_id`, or `None` when
    /// they already hold [`MAX_WORKSPACE_STREAMS_PER_USER`].
    pub fn open_workspace_stream(&self, user_id: &str) -> Option<WorkspaceStreamGuard> {
        let mut map = self
            .workspace_streams
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let n = map.entry(user_id.to_string()).or_insert(0);
        if *n >= MAX_WORKSPACE_STREAMS_PER_USER {
            return None;
        }
        *n += 1;
        Some(WorkspaceStreamGuard {
            bus: self.clone(),
            user_id: user_id.to_string(),
        })
    }

    /// The events of every project, in publish order. Presence changes are not
    /// in it: a workspace stream never takes part in presence. The caller
    /// filters by project and permission.
    pub fn subscribe_all(&self) -> broadcast::Receiver<Arc<EventEnvelope>> {
        self.tap.0.subscribe()
    }

    /// The workspace `base_id` belongs to, loaded with `load` the first time anyone asks and
    /// remembered after. Every workspace stream sees every project's `base_changed`, and most
    /// belong to other workspaces: asking the database about each one, in each stream, lets one
    /// person's project churn load every other tenant's reads. Concurrent first askers share
    /// one load, and a failed load is not remembered.
    pub async fn workspace_of<F, Fut, E>(&self, base_id: &str, load: F) -> Result<String, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, E>>,
    {
        let cell = {
            let mut cells = self.homes.cells.lock().unwrap_or_else(|p| p.into_inner());
            if cells.len() >= HOME_CACHE_MAX {
                cells.clear();
            }
            cells.entry(base_id.to_string()).or_default().clone()
        };
        cell.get_or_try_init(|| {
            self.homes.loads.fetch_add(1, Ordering::Relaxed);
            load()
        })
        .await
        .cloned()
    }

    /// How many times [`EventBus::workspace_of`] had to load an answer.
    pub fn workspace_loads(&self) -> u64 {
        self.homes.loads.load(Ordering::Relaxed)
    }

    pub fn subscribe(&self, base_id: &str) -> broadcast::Receiver<Arc<EventEnvelope>> {
        let mut map = self.channels.lock().unwrap_or_else(|p| p.into_inner());
        map.entry(base_id.to_string())
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0)
            .subscribe()
    }

    pub fn publish(
        &self,
        base_id: &str,
        client_id: Option<String>,
        user_id: Option<String>,
        event: BaseEvent,
    ) {
        // Every committed mutation publishes; comments and who is looking do not
        // affect queries.
        if !matches!(
            event,
            BaseEvent::CommentsChanged { .. } | BaseEvent::PresenceChanged { .. }
        ) {
            self.versions.bump(base_id);
        }
        let mut map = self.channels.lock().unwrap_or_else(|p| p.into_inner());
        let tapped =
            !matches!(event, BaseEvent::PresenceChanged { .. }) && self.tap.0.receiver_count() > 0;
        if !tapped && !map.contains_key(base_id) {
            return;
        }
        let env = Arc::new(EventEnvelope {
            base_id: base_id.to_string(),
            client_id,
            user_id,
            event,
        });
        // Both sends happen under the channels lock, so the tap and the
        // project's channel see events in the same order.
        if tapped {
            let _ = self.tap.0.send(env.clone());
        }
        if let Some(tx) = map.get(base_id) {
            if tx.send(env).is_err() {
                // No receivers left: drop the channel.
                map.remove(base_id);
            }
        }
    }

    /// Number of bases with live subscribers (for metrics/tests).
    pub fn active_channels(&self) -> usize {
        self.channels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_workspace_of_a_project_is_loaded_once_even_when_asked_together() {
        let bus = EventBus::default();
        let ask = |bus: EventBus| async move {
            bus.workspace_of("app1", || async {
                tokio::task::yield_now().await;
                Ok::<_, ()>("wsp1".to_string())
            })
            .await
        };
        let (a, b, c) = tokio::join!(ask(bus.clone()), ask(bus.clone()), ask(bus.clone()));
        assert_eq!(
            (a, b, c),
            (Ok("wsp1".into()), Ok("wsp1".into()), Ok("wsp1".into()))
        );
        assert_eq!(ask(bus.clone()).await, Ok("wsp1".to_string()));
        assert_eq!(bus.workspace_loads(), 1);
        // A failed load is not remembered: the next ask tries again.
        let failed = bus
            .workspace_of("app2", || async { Err::<String, _>("gone") })
            .await;
        assert_eq!(failed, Err("gone"));
        let retried = bus
            .workspace_of("app2", || async { Ok::<_, &str>("wsp2".to_string()) })
            .await;
        assert_eq!(retried, Ok("wsp2".to_string()));
    }

    #[tokio::test]
    async fn subscribers_receive_only_their_base() {
        let bus = EventBus::default();
        let mut a = bus.subscribe("app1");
        let mut b = bus.subscribe("app2");
        bus.publish("app1", None, None, BaseEvent::BaseChanged);
        assert_eq!(a.recv().await.unwrap().base_id, "app1");
        assert!(b.try_recv().is_err());
    }

    #[test]
    fn publish_without_subscribers_is_noop() {
        let bus = EventBus::default();
        bus.publish("app1", None, None, BaseEvent::BaseChanged);
        assert_eq!(bus.active_channels(), 0);
    }

    #[tokio::test]
    async fn presence_counts_a_user_once_and_announces_first_and_last_stream() {
        let bus = EventBus::default();
        let mut rx = bus.subscribe("app1");
        let first = bus.join("app1", "usr1");
        let viewers = |env: Arc<EventEnvelope>| match &env.event {
            BaseEvent::PresenceChanged { viewers } => viewers.clone(),
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(viewers(rx.recv().await.unwrap()), ["usr1"]);
        // A second tab of the same user announces nothing.
        let second = bus.join("app1", "usr1");
        assert!(rx.try_recv().is_err());
        let other = bus.join("app1", "usr2");
        assert_eq!(viewers(rx.recv().await.unwrap()), ["usr1", "usr2"]);
        assert_eq!(bus.viewers("app1"), ["usr1", "usr2"]);
        drop(first);
        assert!(rx.try_recv().is_err(), "usr1 still has a tab open");
        drop(second);
        assert_eq!(viewers(rx.recv().await.unwrap()), ["usr2"]);
        drop(other);
        assert!(viewers(rx.recv().await.unwrap()).is_empty());
        assert!(bus.viewers("app1").is_empty());
        // Presence never counts as a data change.
        assert_eq!(bus.versions().current("app1"), 0);
    }

    #[tokio::test]
    async fn the_tap_sees_every_project_but_never_presence() {
        let bus = EventBus::default();
        let mut tap = bus.subscribe_all();
        bus.publish("app1", None, None, BaseEvent::BaseChanged);
        bus.publish("app2", None, None, BaseEvent::BaseChanged);
        let _guard = bus.join("app1", "usr1");
        assert_eq!(tap.recv().await.unwrap().base_id, "app1");
        assert_eq!(tap.recv().await.unwrap().base_id, "app2");
        assert!(tap.try_recv().is_err(), "presence is not tapped");
        // A tap alone creates no per-project channel.
        assert_eq!(bus.active_channels(), 0);
    }

    #[test]
    fn workspace_stream_slots_are_limited_per_user_and_freed_on_drop() {
        let bus = EventBus::default();
        let held: Vec<_> = (0..MAX_WORKSPACE_STREAMS_PER_USER)
            .map(|_| bus.open_workspace_stream("usr1").unwrap())
            .collect();
        assert!(bus.open_workspace_stream("usr1").is_none());
        assert!(bus.open_workspace_stream("usr2").is_some());
        drop(held);
        assert!(bus.open_workspace_stream("usr1").is_some());
    }

    #[test]
    fn publishing_bumps_the_data_version_except_for_comments() {
        let bus = EventBus::default();
        assert_eq!(bus.versions().current("app1"), 0);
        bus.publish("app1", None, None, BaseEvent::BaseChanged);
        assert_eq!(bus.versions().current("app1"), 1);
        bus.publish(
            "app1",
            None,
            None,
            BaseEvent::RecordsChanged {
                table_id: "tbl".into(),
                created: vec![],
                updated: vec!["rec".into()],
                deleted: vec![],
            },
        );
        assert_eq!(bus.versions().current("app1"), 2);
        bus.publish(
            "app1",
            None,
            None,
            BaseEvent::CommentsChanged {
                record_id: "rec".into(),
            },
        );
        assert_eq!(bus.versions().current("app1"), 2);
        assert_eq!(bus.versions().current("app2"), 0);
    }
}
