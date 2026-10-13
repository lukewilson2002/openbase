//! Small in-memory fixed-window rate limiter keyed by (bucket, key), e.g.
//! ("login", client ip). State is bounded: keys are at most [`MAX_KEY_LEN`]
//! bytes (longer ones are hashed), expired windows are swept periodically and
//! the map never holds more than [`MAX_ENTRIES`] pairs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::ids::hash_token;

/// Keys longer than this are replaced by their SHA-256, so a caller-chosen
/// string can never make the limiter hold more than a few dozen bytes per key.
const MAX_KEY_LEN: usize = 64;
/// Hard cap on tracked (bucket, key) pairs. When sweeping expired windows
/// leaves the map this full, the oldest tenth is evicted.
const MAX_ENTRIES: usize = 100_000;
/// Expired windows are swept at most this often (a sweep is O(entries)).
const SWEEP_EVERY: Duration = Duration::from_secs(30);

/// (bucket, key) -> (window start, hits in window, window length).
type Windows = HashMap<(&'static str, String), (Instant, u32, Duration)>;

#[derive(Default)]
struct Inner {
    map: Windows,
    last_sweep: Option<Instant>,
}

#[derive(Clone, Default)]
pub struct RateLimiter {
    inner: Arc<Mutex<Inner>>,
}

fn bounded_key(key: &str) -> String {
    if key.len() > MAX_KEY_LEN {
        hash_token(key)
    } else {
        key.to_string()
    }
}

impl RateLimiter {
    /// Count one hit; error with 429 if more than `max` hits in `window`.
    pub fn check(
        &self,
        bucket: &'static str,
        key: &str,
        max: u32,
        window: Duration,
    ) -> AppResult<()> {
        self.check_n(bucket, key, 1, max, window)
    }

    /// Count `n` hits at once (e.g. one per email recipient); error with 429
    /// if that brings the window above `max`. A refused request is still
    /// counted.
    pub fn check_n(
        &self,
        bucket: &'static str,
        key: &str,
        n: u32,
        max: u32,
        window: Duration,
    ) -> AppResult<()> {
        let now = Instant::now();
        let key = bounded_key(key);
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        let inner = &mut *guard;
        let sweep_due = inner
            .last_sweep
            .is_none_or(|t| now.duration_since(t) >= SWEEP_EVERY);
        if sweep_due || inner.map.len() >= MAX_ENTRIES {
            inner.last_sweep = Some(now);
            inner
                .map
                .retain(|_, (start, _, win)| now.duration_since(*start) < *win);
            if inner.map.len() >= MAX_ENTRIES {
                let mut starts: Vec<Instant> = inner.map.values().map(|v| v.0).collect();
                let cut = starts.len() / 10;
                let (_, oldest_kept, _) = starts.select_nth_unstable(cut);
                let oldest_kept = *oldest_kept;
                inner.map.retain(|_, (start, _, _)| *start >= oldest_kept);
            }
        }
        let entry = inner.map.entry((bucket, key)).or_insert((now, 0, window));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0, window);
        }
        entry.1 = entry.1.saturating_add(n);
        if entry.1 > max {
            Err(AppError::TooManyRequests)
        } else {
            Ok(())
        }
    }

    /// Forget a key (e.g. after a successful login).
    pub fn reset(&self, bucket: &'static str, key: &str) {
        let key = bounded_key(key);
        let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner.map.remove(&(bucket, key));
    }

    /// Number of tracked keys (for tests and diagnostics).
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .map
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_and_resets() {
        let rl = RateLimiter::default();
        for _ in 0..3 {
            rl.check("t", "k", 3, Duration::from_secs(60)).unwrap();
        }
        assert!(rl.check("t", "k", 3, Duration::from_secs(60)).is_err());
        assert!(rl.check("t", "other", 3, Duration::from_secs(60)).is_ok());
        rl.reset("t", "k");
        assert!(rl.check("t", "k", 3, Duration::from_secs(60)).is_ok());
    }

    #[test]
    fn huge_keys_are_hashed_not_stored() {
        let rl = RateLimiter::default();
        let big = "x".repeat(1_000_000);
        for _ in 0..3 {
            rl.check("t", &big, 3, Duration::from_secs(60)).unwrap();
        }
        assert!(rl.check("t", &big, 3, Duration::from_secs(60)).is_err());
        let held: usize = rl
            .inner
            .lock()
            .unwrap()
            .map
            .keys()
            .map(|(_, k)| k.len())
            .sum();
        assert!(held <= MAX_KEY_LEN, "limiter kept {held} bytes of key");
        rl.reset("t", &big);
        assert!(rl.check("t", &big, 3, Duration::from_secs(60)).is_ok());
    }

    #[test]
    fn expired_windows_are_swept_and_the_map_is_capped() {
        let rl = RateLimiter::default();
        for i in 0..10 {
            rl.check("short", &format!("k{i}"), 1, Duration::from_millis(1))
                .unwrap();
        }
        std::thread::sleep(Duration::from_millis(5));
        // Make the periodic sweep due.
        rl.inner.lock().unwrap().last_sweep = None;
        rl.check("t", "fresh", 1, Duration::from_secs(60)).unwrap();
        assert_eq!(rl.len(), 1, "expired windows are dropped");

        for i in 0..(MAX_ENTRIES + 500) {
            rl.check("t", &format!("k{i}"), 1, Duration::from_secs(3600))
                .unwrap();
        }
        assert!(rl.len() <= MAX_ENTRIES, "len {}", rl.len());
    }

    #[test]
    fn counts_several_hits_at_once() {
        let rl = RateLimiter::default();
        let w = Duration::from_secs(60);
        rl.check_n("t", "k", 4, 5, w).unwrap();
        assert!(rl.check_n("t", "k", 2, 5, w).is_err());
    }
}
