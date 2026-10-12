//! Small in-memory fixed-window rate limiter keyed by (bucket, key), e.g.
//! ("login", client ip). State is bounded: windows expire and are pruned.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};

#[derive(Clone, Default)]
pub struct RateLimiter {
    inner: Arc<Mutex<HashMap<(&'static str, String), (Instant, u32)>>>,
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
        let now = Instant::now();
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() > 50_000 {
            map.retain(|_, (start, _)| now.duration_since(*start) < Duration::from_secs(3600));
        }
        let entry = map.entry((bucket, key.to_string())).or_insert((now, 0));
        if now.duration_since(entry.0) >= window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        if entry.1 > max {
            Err(AppError::TooManyRequests)
        } else {
            Ok(())
        }
    }

    /// Forget a key (e.g. after a successful login).
    pub fn reset(&self, bucket: &'static str, key: &str) {
        let mut map = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        map.remove(&(bucket, key.to_string()));
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
}
