//! Id and secret-token generation. All randomness comes from the OS CSPRNG.

use rand::RngExt as _;
use sha2::{Digest, Sha256};

const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn random_base62(len: usize) -> String {
    let mut rng = rand::rng();
    (0..len)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

/// New prefixed id, e.g. `new_id(ob_core::ids::RECORD)` -> `rec` + 14 chars
/// (~83 bits of entropy: unguessable, so ids double as capability-free handles).
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", random_base62(14))
}

/// New secret token (sessions, API tokens, invites, share links): 43 chars of
/// base62 (~256 bits). Only `hash_token(token)` is stored.
pub fn new_token(prefix: &str) -> String {
    format!("{prefix}{}", random_base62(43))
}

/// SHA-256 hex digest of a token, the form stored in the database.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_prefix_and_are_unique() {
        let a = new_id("rec");
        let b = new_id("rec");
        assert!(a.starts_with("rec") && a.len() == 17);
        assert_ne!(a, b);
    }

    #[test]
    fn token_hash_is_stable_hex() {
        assert_eq!(hash_token("x"), hash_token("x"));
        assert_eq!(hash_token("x").len(), 64);
    }
}
