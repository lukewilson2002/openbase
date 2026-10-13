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
//! Snapshots live in memory for [`SNAPSHOT_TTL`] and are bounded, per user
//! ([`MAX_SNAPSHOTS_PER_USER`]) and overall, and when the overall bounds bite
//! the user holding the most pays, so one integration cannot push out
//! everyone else's listings. An offset
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
/// Snapshots one user may have in progress; their oldest goes first.
pub const MAX_SNAPSHOTS_PER_USER: usize = 16;
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

impl Inner {
    /// Removes the oldest snapshot matching `pick`; false if none matched.
    fn evict_oldest_of(&mut self, pick: impl Fn(&Snapshot) -> bool) -> bool {
        let oldest = self
            .map
            .iter()
            .filter(|(_, s)| pick(s))
            .min_by_key(|(_, s)| s.seq)
            .map(|(k, _)| k.clone());
        let Some(oldest) = oldest else { return false };
        if let Some(s) = self.map.remove(&oldest) {
            self.weight -= s.ids.ids.len();
        }
        true
    }
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
        // A user over their own limit loses their oldest snapshot...
        while inner.map.values().filter(|s| s.user_id == user_id).count() >= MAX_SNAPSHOTS_PER_USER
        {
            if !inner.evict_oldest_of(|s| s.user_id == user_id) {
                break;
            }
        }
        // ...and when the whole store is full, the user holding the most
        // (by count, or by ids when it is the id budget that is exhausted)
        // loses their oldest, never simply the globally oldest.
        loop {
            let by_count = inner.map.len() >= MAX_SNAPSHOTS;
            let by_weight = inner.weight + new_weight > MAX_SNAPSHOT_IDS;
            if inner.map.is_empty() || !(by_count || by_weight) {
                break;
            }
            let mut per_user: HashMap<&str, (usize, usize)> = HashMap::new();
            for s in inner.map.values() {
                let e = per_user.entry(s.user_id.as_str()).or_default();
                e.0 += 1;
                e.1 += s.ids.ids.len();
            }
            let heaviest = per_user
                .into_iter()
                .max_by_key(|(_, (count, ids))| if by_weight { *ids } else { *count })
                .map(|(u, _)| u.to_string());
            let Some(victim) = heaviest else { break };
            if !inner.evict_oldest_of(|s| s.user_id == victim) {
                break;
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
    fn one_user_cannot_evict_another_users_snapshots() {
        let c = Cursors::default();
        let theirs = c.create("victim", "t", 1, ids(5));
        // A user opening far more listings than the per-user cap, enough
        // to cycle the whole store several times over.
        let mut mine = Vec::new();
        for _ in 0..MAX_SNAPSHOTS * 3 {
            mine.push(c.create("noisy", "t", 1, ids(2)));
        }
        assert!(
            c.get(&theirs, "victim", "t", 1).is_some(),
            "the victim's snapshot survived"
        );
        // The noisy user keeps only their newest ones.
        let alive = mine
            .iter()
            .filter(|id| c.get(id, "noisy", "t", 1).is_some())
            .count();
        assert_eq!(alive, MAX_SNAPSHOTS_PER_USER);
        assert!(c.get(mine.last().unwrap(), "noisy", "t", 1).is_some());
        assert!(c.get(&mine[0], "noisy", "t", 1).is_none());
    }

    #[test]
    fn a_full_store_takes_from_the_biggest_holder() {
        let c = Cursors::default();
        // Fill the store with one snapshot each for many users (the oldest
        // ones), then one user at their cap.
        let mut small = Vec::new();
        for i in 0..MAX_SNAPSHOTS - MAX_SNAPSHOTS_PER_USER {
            small.push((format!("u{i}"), c.create(&format!("u{i}"), "t", 1, ids(1))));
        }
        let mut big = Vec::new();
        for _ in 0..MAX_SNAPSHOTS_PER_USER {
            big.push(c.create("big", "t", 1, ids(1)));
        }
        assert_eq!(c.len(), MAX_SNAPSHOTS);
        // A newcomer displaces the biggest holder's oldest, not the globally
        // oldest snapshot (which belongs to a user holding just one).
        c.create("new", "t", 1, ids(1));
        assert!(c.get(&big[0], "big", "t", 1).is_none());
        for (u, id) in &small {
            assert!(c.get(id, u, "t", 1).is_some(), "{u} lost a snapshot");
        }
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
