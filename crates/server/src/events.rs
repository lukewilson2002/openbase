//! In-process event bus: one broadcast channel per base, created on first
//! subscriber and dropped when the last subscriber leaves. No Redis, no
//! cross-process fan-out: OpenBase runs as a single process by design.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ob_core::api::events::{BaseEvent, EventEnvelope};
use tokio::sync::{broadcast, watch};

use crate::store::versions::DataVersions;

const CHANNEL_CAPACITY: usize = 256;

/// Flipped to `true` when the server begins to shut down.
#[derive(Clone)]
struct Shutdown(Arc<watch::Sender<bool>>);

impl Default for Shutdown {
    fn default() -> Self {
        Shutdown(Arc::new(watch::channel(false).0))
    }
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
        if let Some(tx) = map.get(base_id) {
            let env = Arc::new(EventEnvelope {
                base_id: base_id.to_string(),
                client_id,
                user_id,
                event,
            });
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
