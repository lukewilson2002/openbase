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
/// per key across all of them. When `max_failures` wrong guesses fall within `window` the key
/// refuses every guess, right or wrong, for `lockout`. Once the lockout is over, guesses are let
/// through one at a time, and a wrong one locks the key again, so the cap holds for the window
/// and not for each lockout. The window slides: the previous window's failures count in
/// proportion to how much of it is still inside the last `window`, so a burst split across a
/// window boundary cannot get twice the cap.
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
    /// Wrong guesses in the window that began at `window_start`.
    failures: u32,
    /// Wrong guesses in the window before it.
    prev_failures: u32,
    /// Guesses started and not yet settled; each could turn out wrong.
    in_flight: u32,
    locked_until: Option<Instant>,
}

impl GuessEntry {
    /// Move the window forward to `now`.
    fn roll(&mut self, now: Instant, window: Duration) {
        let elapsed = now.saturating_duration_since(self.window_start);
        if elapsed >= window * 2 {
            self.window_start = now;
            self.prev_failures = 0;
            self.failures = 0;
        } else if elapsed >= window {
            self.window_start += window;
            self.prev_failures = self.failures;
            self.failures = 0;
        }
    }

    /// Wrong guesses inside the last `window` (call after [`GuessEntry::roll`]).
    fn recent_failures(&self, now: Instant, window: Duration) -> u32 {
        let elapsed = now.saturating_duration_since(self.window_start);
        let left = window.saturating_sub(elapsed).as_millis();
        let carried = u128::from(self.prev_failures) * left / window.as_millis().max(1);
        self.failures.saturating_add(carried as u32)
    }
}

/// Entries of keys that are idle, unlocked and outside both windows are dropped when the map
/// grows past this. Keys are ids of real share links (callers only count after resolving one),
/// so the map is bounded by the links that exist; this keeps long-dead entries from piling up.
const GUESS_SWEEP_AT: usize = 4096;

/// A guess started with [`GuessLimiter::begin`]. It counts as wrong unless [`Guess::right`] is
/// called, including when it is dropped unfinished (the request went away mid-check), so a guesser
/// cannot get free attempts by hanging up.
pub struct Guess {
    limiter: GuessLimiter,
    key: String,
    right: bool,
}

impl Guess {
    /// The guess was the right secret: it does not count against the key.
    pub fn right(mut self) {
        self.right = true;
    }
}

impl Drop for Guess {
    fn drop(&mut self) {
        let l = &self.limiter;
        let now = (l.clock)();
        let mut map = l.entries.lock().unwrap_or_else(|p| p.into_inner());
        let Some(e) = map.get_mut(&self.key) else {
            return;
        };
        e.roll(now, l.window);
        e.in_flight = e.in_flight.saturating_sub(1);
        if !self.right {
            e.failures = e.failures.saturating_add(1);
            if e.recent_failures(now, l.window) >= l.max_failures {
                e.locked_until = Some(now + l.lockout);
            }
        }
    }
}

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

    /// Start a guess at `key`'s secret: Err (429) while the key is locked, or when the guesses
    /// already running could by themselves use up what is left of the cap. Only a guess that
    /// proves wrong counts and can lock the key; guesses still being checked just hold a place,
    /// so a crowd of visitors with the right password queued behind slow hashing cannot lock a
    /// link, while a burst of parallel guesses still cannot get past the cap before the first
    /// failure is recorded.
    pub fn begin(&self, key: &str) -> AppResult<Guess> {
        let now = (self.clock)();
        let mut map = self.entries.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= GUESS_SWEEP_AT {
            map.retain(|_, e| {
                e.in_flight > 0
                    || e.locked_until.is_some_and(|u| now < u)
                    || now.saturating_duration_since(e.window_start) < self.window * 2
            });
        }
        let e = map.entry(key.to_string()).or_insert(GuessEntry {
            window_start: now,
            failures: 0,
            prev_failures: 0,
            in_flight: 0,
            locked_until: None,
        });
        if e.locked_until.is_some_and(|u| now < u) {
            return Err(AppError::TooManyRequests);
        }
        e.locked_until = None;
        e.roll(now, self.window);
        // Past the cap with the lockout over, one probe at a time.
        let room = self
            .max_failures
            .saturating_sub(e.recent_failures(now, self.window))
            .max(1);
        if e.in_flight >= room {
            return Err(AppError::TooManyRequests);
        }
        e.in_flight += 1;
        Ok(Guess {
            limiter: self.clone(),
            key: key.to_string(),
            right: false,
        })
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
    fn a_right_guess_is_not_counted() {
        let (clock, _now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for _ in 0..99 {
            g.begin("lnk").unwrap(); // 99 wrong guesses
        }
        g.begin("lnk").unwrap().right(); // the 100th is right: no lock
        g.begin("lnk").unwrap().right();
        // Right guesses never add up to a lockout.
        for _ in 0..500 {
            g.begin("ok").unwrap().right();
        }
    }

    #[test]
    fn a_right_guess_after_a_lockout_does_not_lock_the_key_again() {
        let (clock, now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for _ in 0..100 {
            g.begin("lnk").unwrap();
        }
        assert!(g.begin("lnk").is_err());
        advance(&now, QUARTER + Duration::from_secs(1));
        for _ in 0..5 {
            g.begin("lnk").unwrap().right();
        }
        // A wrong guess still locks it again: the cap is for the hour.
        g.begin("lnk").unwrap();
        assert!(g.begin("lnk").is_err());
    }

    #[test]
    fn guesses_still_being_checked_never_lock_the_key() {
        let (clock, _now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        let running: Vec<Guess> = (0..100).map(|_| g.begin("lnk").unwrap()).collect();
        // The cap is spoken for, so more are refused for now ...
        assert!(g.begin("lnk").is_err());
        // ... but all of them turn out right, so nothing was locked.
        for guess in running {
            guess.right();
        }
        g.begin("lnk").unwrap().right();
    }

    #[test]
    fn parallel_guesses_cannot_get_past_the_cap() {
        let (clock, _now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        let running: Vec<Guess> = (0..100).map(|_| g.begin("lnk").unwrap()).collect();
        assert!(g.begin("lnk").is_err(), "no 101st before any is settled");
        drop(running); // all wrong
        assert!(g.begin("lnk").is_err(), "and the key is locked now");
    }

    #[test]
    fn a_burst_split_across_a_window_boundary_does_not_double_the_cap() {
        let (clock, now) = manual_clock();
        let g = GuessLimiter::new(100, HOUR, QUARTER).with_clock(clock);
        for _ in 0..99 {
            g.begin("lnk").unwrap();
        }
        advance(&now, HOUR + Duration::from_secs(1));
        // The 99 just before the boundary still weigh almost fully.
        let mut let_through = 0;
        while g.begin("lnk").is_ok() {
            let_through += 1;
            assert!(let_through < 5, "locked well before another 99");
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
        // Two hours on, the old failures no longer count.
        advance(&now, HOUR * 2);
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
        advance(&now, HOUR * 2 + Duration::from_secs(1));
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
