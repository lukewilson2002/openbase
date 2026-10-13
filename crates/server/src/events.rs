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

#[derive(Clone, Default)]
pub struct EventBus {
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<Arc<EventEnvelope>>>>>,
    versions: DataVersions,
    shutdown: Shutdown,
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
        // Every committed mutation publishes; comments do not affect queries.
        if !matches!(event, BaseEvent::CommentsChanged { .. }) {
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
