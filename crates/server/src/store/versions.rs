//! Per-base data versions: a counter that goes up whenever anything a view
//! query can see (records, computed values, fields, views, tables, trash
//! state, membership) changed. The view-query cache (`engine::query`) keys
//! its entries by the version, so a bump invalidates them all.
//!
//! **Who bumps.** [`crate::events::EventBus::publish`] bumps the version of
//! the base for every event except `CommentsChanged`. Every mutating handler
//! (record writes, schema changes, trash, base/workspace changes) and the
//! background volatile-formula refresh already publish an event *after* its
//! transaction committed, so one choke point covers them all. A new write
//! path that publishes events is covered automatically; one that does not
//! must call [`DataVersions::bump`] after its commit.
//!
//! **Why after the commit.** A reader reads the version first and the data
//! second. If the bump happened before the commit, a reader could cache
//! pre-commit data under the new version and serve it forever; bumping after
//! the commit can only make a cache entry look older than it is.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default, Debug)]
pub struct DataVersions {
    inner: Arc<Mutex<HashMap<String, u64>>>,
}

impl DataVersions {
    /// The current version of a base (0 until the first change).
    pub fn current(&self, base_id: &str) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(base_id)
            .copied()
            .unwrap_or(0)
    }

    /// Record that data of `base_id` changed; returns the new version.
    pub fn bump(&self, base_id: &str) -> u64 {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let v = map.entry(base_id.to_string()).or_insert(0);
        *v += 1;
        *v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_per_base_and_monotonic() {
        let v = DataVersions::default();
        assert_eq!(v.current("a"), 0);
        assert_eq!(v.bump("a"), 1);
        assert_eq!(v.bump("a"), 2);
        assert_eq!(v.current("a"), 2);
        assert_eq!(v.current("b"), 0);
        let shared = v.clone();
        shared.bump("b");
        assert_eq!(v.current("b"), 1);
    }
}
