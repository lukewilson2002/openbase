//! Password hashing with Argon2id (OWASP minimum parameters: m=19 MiB, t=2, p=1).
//! Hashing is CPU- and memory-heavy, so callers run it via [`hash_async`] /
//! [`verify_async`], which use `spawn_blocking` behind a small semaphore to
//! bound peak memory on small VPSes.

use std::sync::LazyLock;

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};
use tokio::sync::Semaphore;

use crate::error::{AppError, AppResult};

pub const MIN_PASSWORD_LEN: usize = 10;
pub const MAX_PASSWORD_LEN: usize = 256;

/// Hashes that may run at once for sign-in, sign-up and password changes.
const SIGN_IN_SLOTS: usize = 2;
/// Hashes that may run at once for anonymous visitors checking a share link's password. A
/// separate pool: with one shared pool, a flood of share-password guesses (which anyone can send,
/// from any number of addresses) would queue behind or in front of real logins and starve them.
const ANONYMOUS_SLOTS: usize = 2;

static HASH_PERMITS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(SIGN_IN_SLOTS));
static ANONYMOUS_HASH_PERMITS: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(ANONYMOUS_SLOTS));

fn argon2() -> Argon2<'static> {
    let params = Params::new(19 * 1024, 2, 1, None).expect("valid argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub fn validate_new_password(pw: &str) -> AppResult<()> {
    let len = pw.chars().count();
    if len < MIN_PASSWORD_LEN {
        return Err(AppError::bad_request(format!(
            "password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    if pw.len() > MAX_PASSWORD_LEN {
        return Err(AppError::bad_request("password is too long"));
    }
    Ok(())
}

pub fn hash(pw: &str) -> AppResult<String> {
    let mut salt_bytes = [0u8; 16];
    rand::fill(&mut salt_bytes);
    Ok(argon2()
        .hash_password_with_salt(pw.as_bytes(), &salt_bytes)
        .map_err(AppError::internal)?
        .to_string())
}

pub fn verify(pw: &str, phc: &str) -> bool {
    if pw.len() > MAX_PASSWORD_LEN {
        return false;
    }
    match PasswordHash::new(phc) {
        Ok(parsed) => argon2().verify_password(pw.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

/// A valid hash of a random password, used to equalize timing when the user
/// doesn't exist (prevents account enumeration by response time).
pub static DUMMY_HASH: LazyLock<String> =
    LazyLock::new(|| hash("dummy-password-for-timing").unwrap());

pub async fn hash_async(pw: String) -> AppResult<String> {
    let _permit = HASH_PERMITS.acquire().await.map_err(AppError::internal)?;
    tokio::task::spawn_blocking(move || hash(&pw))
        .await
        .map_err(AppError::internal)?
}

pub async fn verify_async(pw: String, phc: String) -> AppResult<bool> {
    let _permit = HASH_PERMITS.acquire().await.map_err(AppError::internal)?;
    tokio::task::spawn_blocking(move || verify(&pw, &phc))
        .await
        .map_err(AppError::internal)
}

/// [`verify_async`] for callers that are not signed in (share-link passwords), in the
/// anonymous pool of hashing slots instead of the sign-in one.
pub async fn verify_anonymous_async(pw: String, phc: String) -> AppResult<bool> {
    let _permit = ANONYMOUS_HASH_PERMITS
        .acquire()
        .await
        .map_err(AppError::internal)?;
    tokio::task::spawn_blocking(move || verify(&pw, &phc))
        .await
        .map_err(AppError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn anonymous_checks_do_not_wait_for_sign_in_slots_and_the_reverse() {
        let phc = hash("share-secret").unwrap();
        let t = Duration::from_secs(20);

        // Every sign-in slot is taken (as in a flood of logins): an anonymous check still runs.
        let held = HASH_PERMITS
            .acquire_many(SIGN_IN_SLOTS as u32)
            .await
            .unwrap();
        let ok = tokio::time::timeout(
            t,
            verify_anonymous_async("share-secret".into(), phc.clone()),
        )
        .await
        .expect("an anonymous check waited for a sign-in slot")
        .unwrap();
        assert!(ok);
        drop(held);

        // Every anonymous slot is taken (as in a flood of guesses): a sign-in check still runs.
        let held = ANONYMOUS_HASH_PERMITS
            .acquire_many(ANONYMOUS_SLOTS as u32)
            .await
            .unwrap();
        let ok = tokio::time::timeout(t, verify_async("share-secret".into(), phc.clone()))
            .await
            .expect("a sign-in check waited for an anonymous slot")
            .unwrap();
        assert!(ok);
        // And the anonymous pool really is exhausted while held.
        assert!(ANONYMOUS_HASH_PERMITS.try_acquire().is_err());
        drop(held);
    }

    #[test]
    fn hash_and_verify() {
        let h = hash("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify("correct horse battery", &h));
        assert!(!verify("wrong", &h));
        assert!(!verify("x", "not a hash"));
    }

    #[test]
    fn password_policy() {
        assert!(validate_new_password("short").is_err());
        assert!(validate_new_password("long enough pw").is_ok());
        assert!(validate_new_password(&"x".repeat(300)).is_err());
    }
}
