//! Paging state of the list-records endpoint.
//!
//! A multi-page listing is served from a *snapshot*: the ordered ids of the
//! records the first request matched. The `offset` handed to the client names
//! the snapshot and the position of the next page, so paging is stable while
//! the caller edits the very records it is paging through (the usual
//! "read a page, update it, read the next" loop): records changed or removed
//! in between show their current state or drop out, nothing is skipped or
//! repeated.
//!
//! Snapshots live in memory for [`SNAPSHOT_TTL`] and are bounded; an offset
//! whose snapshot is gone, belongs to another user or table, or was made for
//! different query parameters is "not available" (422
//! `LIST_RECORDS_ITERATOR_NOT_AVAILABLE`), exactly like an expired Airtable
//! offset. The client restarts the listing.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::engine::query::CachedQuery;
use crate::ids::new_token;

/// How long an offset stays valid.
pub const SNAPSHOT_TTL: Duration = Duration::from_secs(300);
/// Snapshots kept at once.
pub const MAX_SNAPSHOTS: usize = 256;
/// Ids kept across all snapshots (about 20 MB).
pub const MAX_SNAPSHOT_IDS: usize = 1_000_000;

const PREFIX: &str = "itr";

struct Snapshot {
    user_id: String,
    table_id: String,
    fingerprint: u64,
    ids: Arc<CachedQuery>,
    created: Instant,
    /// Creation order (instants can tie).
    seq: u64,
}

#[derive(Default)]
struct Inner {
    map: HashMap<String, Snapshot>,
    weight: usize,
    seq: u64,
}

/// The snapshots of in-progress listings.
pub struct Cursors {
    ttl: Duration,
    inner: Mutex<Inner>,
}

impl Default for Cursors {
    fn default() -> Self {
        Cursors::with_ttl(SNAPSHOT_TTL)
    }
}

impl Cursors {
    pub fn with_ttl(ttl: Duration) -> Cursors {
        Cursors {
            ttl,
            inner: Mutex::new(Inner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Remember `ids` for a listing and return the snapshot id.
    pub fn create(
        &self,
        user_id: &str,
        table_id: &str,
        fingerprint: u64,
        ids: Arc<CachedQuery>,
    ) -> String {
        let id = new_token("");
        let mut inner = self.lock();
        let now = Instant::now();
        let ttl = self.ttl;
        let mut expired = Vec::new();
        inner.map.retain(|k, s| {
            let keep = now.duration_since(s.created) < ttl;
            if !keep {
                expired.push((k.clone(), s.ids.ids.len()));
            }
            keep
        });
        inner.weight -= expired.iter().map(|(_, n)| n).sum::<usize>();
        let new_weight = ids.ids.len();
        // Evict the oldest until the newcomer fits.
        while !inner.map.is_empty()
            && (inner.map.len() >= MAX_SNAPSHOTS || inner.weight + new_weight > MAX_SNAPSHOT_IDS)
        {
            let oldest = inner
                .map
                .iter()
                .min_by_key(|(_, s)| s.seq)
                .map(|(k, _)| k.clone());
            let Some(oldest) = oldest else { break };
            if let Some(s) = inner.map.remove(&oldest) {
                inner.weight -= s.ids.ids.len();
            }
        }
        inner.weight += new_weight;
        inner.seq += 1;
        let seq = inner.seq;
        inner.map.insert(
            id.clone(),
            Snapshot {
                user_id: user_id.to_string(),
                table_id: table_id.to_string(),
                fingerprint,
                ids,
                created: now,
                seq,
            },
        );
        id
    }

    /// The ids of snapshot `id`, if it is alive and was made for this user,
    /// table and query.
    pub fn get(
        &self,
        id: &str,
        user_id: &str,
        table_id: &str,
        fingerprint: u64,
    ) -> Option<Arc<CachedQuery>> {
        let inner = self.lock();
        let s = inner.map.get(id)?;
        let alive = Instant::now().duration_since(s.created) < self.ttl;
        (alive && s.user_id == user_id && s.table_id == table_id && s.fingerprint == fingerprint)
            .then(|| s.ids.clone())
    }

    /// Drop every snapshot (offsets in flight become unavailable).
    pub fn clear(&self) {
        let mut inner = self.lock();
        inner.map.clear();
        inner.weight = 0;
    }

    pub fn len(&self) -> usize {
        self.lock().map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The opaque `offset` string for position `index` of snapshot `id`.
pub fn encode(id: &str, index: usize) -> String {
    format!(
        "{PREFIX}{}",
        URL_SAFE_NO_PAD.encode(format!("{id}:{index}"))
    )
}

/// Parse an offset made by [`encode`].
pub fn decode(offset: &str) -> Option<(String, usize)> {
    let raw = offset.strip_prefix(PREFIX)?;
    let bytes = URL_SAFE_NO_PAD.decode(raw).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let (id, index) = text.split_once(':')?;
    Some((id.to_string(), index.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Arc<CachedQuery> {
        Arc::new(CachedQuery {
            ids: (0..n).map(|i| format!("rec{i}")).collect(),
            groups: Vec::new(),
        })
    }

    #[test]
    fn offsets_round_trip_and_reject_garbage() {
        let o = encode("abc123", 42);
        assert!(o.starts_with("itr"));
        assert_eq!(decode(&o), Some(("abc123".to_string(), 42)));
        for bad in ["", "itr", "itr!!!", "abc", "itrYWJj", "rec123"] {
            assert_eq!(decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_snapshot_is_bound_to_user_table_and_query() {
        let c = Cursors::default();
        let id = c.create("u1", "t1", 7, ids(3));
        assert_eq!(c.get(&id, "u1", "t1", 7).unwrap().ids.len(), 3);
        assert!(c.get(&id, "u2", "t1", 7).is_none());
        assert!(c.get(&id, "u1", "t2", 7).is_none());
        assert!(c.get(&id, "u1", "t1", 8).is_none());
        assert!(c.get("nope", "u1", "t1", 7).is_none());
        c.clear();
        assert!(c.get(&id, "u1", "t1", 7).is_none());
    }

    #[test]
    fn snapshots_expire() {
        let c = Cursors::with_ttl(Duration::from_millis(30));
        let id = c.create("u", "t", 1, ids(2));
        assert!(c.get(&id, "u", "t", 1).is_some());
        std::thread::sleep(Duration::from_millis(60));
        assert!(c.get(&id, "u", "t", 1).is_none());
        // Expired snapshots are dropped when the next one is made.
        c.create("u", "t", 1, ids(1));
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn memory_is_bounded() {
        let c = Cursors::default();
        let first = c.create("u", "t", 1, ids(10));
        for _ in 0..MAX_SNAPSHOTS + 5 {
            c.create("u", "t", 1, ids(1));
        }
        assert!(c.len() <= MAX_SNAPSHOTS);
        assert!(
            c.get(&first, "u", "t", 1).is_none(),
            "the oldest went first"
        );
        // Big snapshots push out older ones by weight.
        let c = Cursors::default();
        let a = c.create("u", "t", 1, ids(600_000));
        let b = c.create("u", "t", 1, ids(600_000));
        assert!(c.get(&a, "u", "t", 1).is_none());
        assert!(c.get(&b, "u", "t", 1).is_some());
    }
}
