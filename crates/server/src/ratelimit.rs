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

/// Where [`GuessLimiter`] reads the time. Tests replace it with a clock they move by hand
/// instead of sleeping through an hour.
pub type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

/// Brute-force lockout for one secret shared by many guessers, such as a share link's password:
/// the per-IP limits cannot see a guesser who has many addresses, so this counts *wrong* guesses
/// per key across all of them. After `max_failures` wrong guesses within `window` the key
/// refuses every guess, right or wrong, for `lockout`; a guess made after the lockout still
/// counts against the same window, so the cap holds for the window and not for each lockout.
///
/// Anyone who knows a link can therefore lock its password prompt by guessing wrongly on
/// purpose. That is accepted (docs/security.md): the alternative is leaving the password open to
/// distributed guessing.
#[derive(Clone)]
pub struct GuessLimiter {
    max_failures: u32,
    window: Duration,
    lockout: Duration,
    clock: Clock,
    entries: Arc<Mutex<HashMap<String, GuessEntry>>>,
}

struct GuessEntry {
    window_start: Instant,
    failures: u32,
    locked_until: Option<Instant>,
}

/// Entries of keys that are neither locked nor inside their window are dropped when the map
/// grows past this. Keys are ids of real share links (callers only count after resolving one),
/// so the map is bounded by the links that exist; this keeps long-dead entries from piling up.
const GUESS_SWEEP_AT: usize = 4096;

impl GuessLimiter {
    pub fn new(max_failures: u32, window: Duration, lockout: Duration) -> Self {
        GuessLimiter {
            max_failures,
            window,
            lockout,
            clock: Arc::new(Instant::now),
            entries: Arc::default(),
        }
    }

    /// The same limiter reading time from `clock`.
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// Start a guess at `key`'s secret: Err (429) while the key is locked, else the guess is
    /// counted as wrong at once, which locks the key when it makes `max_failures` in the window.
    /// Counting before the (slow) check, not after, keeps a burst of parallel guesses from all
    /// getting through before the first failure is recorded. Call [`GuessLimiter::was_right`]
    /// when the guess turns out right.
    pub fn begin(&self, key: &str) -> AppResult<()> {
        let now = (self.clock)();
        let mut map = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= GUESS_SWEEP_AT {
            map.retain(|_, e| {
                e.locked_until.is_some_and(|u| now < u)
                    || now.duration_since(e.window_start) < self.window
            });
        }
        let e = map.entry(key.to_string()).or_insert(GuessEntry {
            window_start: now,
            failures: 0,
            locked_until: None,
        });
        if e.locked_until.is_some_and(|u| now < u) {
            return Err(AppError::TooManyRequests);
        }
        if now.duration_since(e.window_start) >= self.window {
            e.window_start = now;
            e.failures = 0;
        }
        e.failures = e.failures.saturating_add(1);
        if e.failures >= self.max_failures {
            e.locked_until = Some(now + self.lockout);
        }
        Ok(())
    }

    /// The guess started with [`GuessLimiter::begin`] was right: it does not count against the
    /// key, and if it was the one that locked the key, the key is open again.
    pub fn was_right(&self, key: &str) {
        let mut map = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(e) = map.get_mut(key) {
            e.failures = e.failures.saturating_sub(1);
            if e.failures < self.max_failures {
                e.locked_until = None;
            }
        }
    }

    /// Number of tracked keys (for tests).
    pub fn len(&self) -> usize {
        self.entries.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clock that only moves when told to.
    fn manual_clock() -> (Clock, Arc<Mutex<Instant>>) {
        let now = Arc::new(Mutex::new(Instant::now()));
        let handle = now.clone();
        (Arc::new(move || *handle.lock().unwrap()), now)
    }

    fn advance(now: &Arc<Mutex<Instant>>, by: Duration) {
        *now.lock().unwrap() += by;
    }

    const HOUR: Duration = Duration::from_secs(3600);
    const QUARTER: Duration = Duration::from_secs(15 * 60);

    #[test]
    fn guess_cap_locks_a_key_for_the_lockout_then_reopens() {
        let (clock, now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for _ in 0..100 {
            g.begin("lnk").unwrap(); // 100 wrong guesses are let through
        }
        assert!(g.begin("lnk").is_err(), "the 101st guess is refused");
        assert!(g.begin("other").is_ok(), "other keys are unaffected");

        advance(&now, QUARTER - Duration::from_secs(1));
        assert!(
            g.begin("lnk").is_err(),
            "still locked just before 15 minutes"
        );
        advance(&now, Duration::from_secs(2));
        assert!(g.begin("lnk").is_ok(), "open again after 15 minutes");
    }

    #[test]
    fn a_right_guess_is_not_counted_and_unlocks_what_it_locked() {
        let (clock, _now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for _ in 0..100 {
            g.begin("lnk").unwrap(); // the 100th attempt locks the key ...
        }
        g.was_right("lnk"); // ... but it was the right password
        g.begin("lnk").unwrap();
        // Right guesses never add up to a lockout.
        for _ in 0..500 {
            g.begin("ok").unwrap();
            g.was_right("ok");
        }
    }

    #[test]
    fn guess_cap_holds_for_the_whole_window_not_for_each_lockout() {
        let (clock, now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for _ in 0..100 {
            g.begin("lnk").unwrap();
        }
        advance(&now, QUARTER + Duration::from_secs(1));
        g.begin("lnk").unwrap(); // let through once the lockout is over ...
        assert!(
            g.begin("lnk").is_err(),
            "... but that wrong guess locks it again: the cap is per hour, not per lockout"
        );
        // A new hour starts a new count.
        advance(&now, HOUR);
        g.begin("lnk").unwrap();
        g.begin("lnk").unwrap();
    }

    #[test]
    fn guesses_spread_over_more_than_an_hour_never_lock() {
        let (clock, now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for _ in 0..500 {
            advance(&now, Duration::from_secs(60));
            g.begin("lnk").unwrap();
        }
    }

    #[test]
    fn guess_entries_are_swept_when_the_map_grows() {
        let (clock, now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for i in 0..GUESS_SWEEP_AT {
            g.begin(&format!("k{i}")).unwrap();
        }
        assert_eq!(g.len(), GUESS_SWEEP_AT);
        advance(&now, HOUR + Duration::from_secs(1));
        g.begin("fresh").unwrap();
        assert_eq!(g.len(), 1, "idle entries are dropped");
    }

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
