//! In-process event bus: one broadcast channel per base, created on first
//! subscriber and dropped when the last subscriber leaves. No Redis, no
//! cross-process fan-out: OpenGrid runs as a single process by design.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use og_core::api::events::{BaseEvent, EventEnvelope};
use tokio::sync::broadcast;

const CHANNEL_CAPACITY: usize = 256;

#[derive(Clone, Default)]
pub struct EventBus {
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<Arc<EventEnvelope>>>>>,
}

impl EventBus {
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
}
