//! One-time codes that prove a person can read the mailbox an invite was addressed to.
//!
//! An invite may be limited to one email address. Signing up with the address typed into the
//! form proves nothing (the form is anonymous), so a link that leaked would let whoever holds it
//! claim the address. Instead the server mails a short code to the invited address and the
//! sign-up must present it. Codes live in memory, like pending passkey ceremonies: a restart
//! only means asking for another.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rand::RngExt as _;

use crate::ids::hash_token;

/// How long a code can be used.
const TTL: Duration = Duration::from_secs(15 * 60);
/// Wrong tries after which a code is void (a new one has to be mailed).
const MAX_WRONG: u32 = 5;
/// Most invites with a code waiting at once; the oldest is dropped beyond it.
const MAX_ENTRIES: usize = 10_000;
/// Digits in a code. Eight: with five tries per mailed code and three mails an hour per invite
/// a guess succeeds with a chance of about one in a million over the invite's whole week.
const DIGITS: usize = 8;

struct Entry {
    hash: String,
    expires: Instant,
    wrong: u32,
}

#[derive(Default)]
pub struct InviteEmailCodes {
    waiting: Mutex<HashMap<String, Entry>>,
}

impl InviteEmailCodes {
    /// A fresh code for the invite, replacing any earlier one.
    pub fn issue(&self, invite_id: &str) -> String {
        let mut rng = rand::rng();
        let code: String = (0..DIGITS)
            .map(|_| char::from(b'0' + rng.random_range(0..10u8)))
            .collect();
        let now = Instant::now();
        let mut map = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        map.retain(|_, e| e.expires > now);
        if map.len() >= MAX_ENTRIES {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, e)| e.expires)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
        map.insert(
            invite_id.to_string(),
            Entry {
                hash: hash_token(&code),
                expires: now + TTL,
                wrong: 0,
            },
        );
        code
    }

    /// Whether `code` is the one mailed for the invite. A right code is used up; a wrong one
    /// counts, and the fifth voids the code.
    pub fn verify(&self, invite_id: &str, code: &str) -> bool {
        let digits: String = code.chars().filter(|c| !c.is_whitespace()).collect();
        let mut map = self.waiting.lock().unwrap_or_else(|p| p.into_inner());
        let Some(entry) = map.get_mut(invite_id) else {
            return false;
        };
        if entry.expires <= Instant::now() {
            map.remove(invite_id);
            return false;
        }
        if entry.hash == hash_token(&digits) {
            map.remove(invite_id);
            return true;
        }
        entry.wrong += 1;
        if entry.wrong >= MAX_WRONG {
            map.remove(invite_id);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_works_once_and_a_wrong_one_five_times_voids_it() {
        let codes = InviteEmailCodes::default();
        let code = codes.issue("inv1");
        assert_eq!(code.len(), DIGITS);
        assert!(!codes.verify("inv2", &code), "belongs to another invite");
        assert!(codes.verify("inv1", &format!(" {code} ")));
        assert!(!codes.verify("inv1", &code), "used up");

        let code = codes.issue("inv1");
        for _ in 0..MAX_WRONG {
            assert!(!codes.verify("inv1", "00000000x"));
        }
        assert!(
            !codes.verify("inv1", &code),
            "five wrong tries void the code"
        );
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let codes = InviteEmailCodes::default();
        let first = codes.issue("inv1");
        let second = codes.issue("inv1");
        // (A repeat of the same eight digits has a chance of one in 10^8.)
        assert_ne!(first, second);
        assert!(!codes.verify("inv1", &first));
        assert!(codes.verify("inv1", &second));
    }
}
