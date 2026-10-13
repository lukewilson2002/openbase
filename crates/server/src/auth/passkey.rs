//! Passkeys (WebAuthn): the relying party, and the short-lived server-side state of the two
//! ceremonies (registering a credential, signing in with one).
//!
//! - **Relying party.** The RP ID is the host of `OPENBASE_PUBLIC_URL` and the only accepted
//!   origin is that URL's origin. A host that is an IP address cannot be an RP ID, so passkeys
//!   are off for it ([`Passkeys::enabled`]). Changing the host later makes every stored
//!   credential unusable (the browser files them under the old RP ID); see docs/security.md.
//! - **State.** `webauthn-rs` requires the per-ceremony state to stay on the server. It is kept
//!   in memory under an unguessable id for [`CHALLENGE_TTL`], is consumed by the first attempt to
//!   finish (successful or not, so a challenge can never be tried twice), and the stores are
//!   bounded. A restart drops pending ceremonies; the user just starts again.
//! - **Policy.** User verification is always required, so a passkey sign-in is itself a
//!   multi-factor sign-in (possession plus PIN, biometrics or device unlock) and does not ask
//!   for the TOTP code. Credentials are requested as discoverable (resident), so the sign-in
//!   needs no username.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ob_core::api::passkeys::PasskeyChallenge;
use serde_json::{Value, json};
use webauthn_rs::prelude::{
    DiscoverableAuthentication, Passkey, PasskeyRegistration, PublicKeyCredential,
    RegisterPublicKeyCredential, Url, Uuid, Webauthn, WebauthnBuilder,
};

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::ids::new_token;

/// How long a started ceremony can be finished (the browser's own timeout is 5 minutes too).
pub const CHALLENGE_TTL: Duration = Duration::from_secs(5 * 60);
/// Ceremonies waiting for their second half, per kind. When full, the oldest tenth is dropped.
const MAX_PENDING: usize = 10_000;

/// A signed-in session that started within this long ago may register a passkey without typing
/// the password again.
pub const RECENT_SIGN_IN_MS: i64 = 10 * 60 * 1000;

/// A bounded map of ceremonies waiting to be finished, each usable once.
struct Pending<T> {
    map: HashMap<String, (Instant, T)>,
}

impl<T> Default for Pending<T> {
    fn default() -> Self {
        Pending {
            map: HashMap::new(),
        }
    }
}

impl<T> Pending<T> {
    fn insert(&mut self, id: String, value: T) {
        let now = Instant::now();
        if self.map.len() >= MAX_PENDING {
            self.map
                .retain(|_, (started, _)| now.duration_since(*started) < CHALLENGE_TTL);
        }
        if self.map.len() >= MAX_PENDING {
            let mut starts: Vec<Instant> = self.map.values().map(|v| v.0).collect();
            starts.sort_unstable();
            let cutoff = starts[starts.len() / 10];
            self.map.retain(|_, (started, _)| *started > cutoff);
        }
        self.map.insert(id, (now, value));
    }

    /// Remove and return the ceremony, unless it has expired.
    fn take(&mut self, id: &str) -> Option<T> {
        let (started, value) = self.map.remove(id)?;
        (started.elapsed() < CHALLENGE_TTL).then_some(value)
    }
}

/// A registration waiting for the browser's answer.
pub struct PendingRegistration {
    pub user_id: String,
    /// The session that started it: another session of the same user cannot finish it.
    pub session_hash: Option<String>,
    state: PasskeyRegistration,
}

/// The passkey relying party and its pending ceremonies. One per server, in [`AppState`].
///
/// [`AppState`]: crate::state::AppState
pub struct Passkeys {
    webauthn: Option<Webauthn>,
    registrations: Mutex<Pending<PendingRegistration>>,
    logins: Mutex<Pending<DiscoverableAuthentication>>,
}

/// The RP ID and origin for a public URL, or `None` when WebAuthn cannot work for it (not a URL,
/// or a host that is an IP address).
pub fn relying_party(config: &Config) -> Option<(String, Url)> {
    let url = Url::parse(&config.public_url).ok()?;
    let url::Host::Domain(host) = url.host()? else {
        return None;
    };
    let origin = Url::parse(&config.public_origin()).ok()?;
    Some((host.to_ascii_lowercase(), origin))
}

impl Passkeys {
    pub fn new(config: &Config) -> Passkeys {
        let webauthn =
            relying_party(config).and_then(|(rp_id, origin)| {
                match WebauthnBuilder::new(&rp_id, &origin).map(|b| b.rp_name("OpenBase").build()) {
                    Ok(Ok(w)) => Some(w),
                    _ => {
                        tracing::warn!(
                            "passkeys are off: OPENBASE_PUBLIC_URL does not give a usable WebAuthn \
                         relying party"
                        );
                        None
                    }
                }
            });
        Passkeys {
            webauthn,
            registrations: Mutex::default(),
            logins: Mutex::default(),
        }
    }

    /// Passkeys can be used at the configured public URL.
    pub fn enabled(&self) -> bool {
        self.webauthn.is_some()
    }

    /// Fail with the "passkeys are not available" explanation when they are off.
    pub fn require_enabled(&self) -> AppResult<()> {
        self.webauthn().map(|_| ())
    }

    fn webauthn(&self) -> AppResult<&Webauthn> {
        self.webauthn.as_ref().ok_or_else(|| {
            AppError::bad_request(
                "passkeys are not available on this server: OPENBASE_PUBLIC_URL must be an \
                 address with a domain name (for example https://base.example.com, or \
                 http://localhost:8080)",
            )
        })
    }

    /// Start registering a credential for the account. `exclude` are the raw credential ids the
    /// account already has.
    pub fn start_registration(
        &self,
        user_id: &str,
        session_hash: Option<String>,
        handle: Uuid,
        email: &str,
        display_name: &str,
        exclude: Vec<Vec<u8>>,
    ) -> AppResult<PasskeyChallenge> {
        let webauthn = self.webauthn()?;
        let exclude = (!exclude.is_empty()).then_some(exclude);
        let (ccr, state) = webauthn
            .start_passkey_registration(handle, email, display_name, exclude)
            .map_err(|e| AppError::internal(format!("webauthn registration: {e}")))?;
        let mut options = serde_json::to_value(&ccr)?;
        require_discoverable(&mut options);
        let id = new_token("pkc_");
        self.registrations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                id.clone(),
                PendingRegistration {
                    user_id: user_id.to_string(),
                    session_hash,
                    state,
                },
            );
        Ok(PasskeyChallenge {
            challenge_id: id,
            options,
        })
    }

    /// Take a pending registration (spending it). `None` if it never existed, expired, was
    /// already tried, or belongs to another user or session.
    pub fn take_registration(
        &self,
        challenge_id: &str,
        user_id: &str,
        session_hash: Option<&str>,
    ) -> Option<PendingRegistration> {
        let pending = self
            .registrations
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take(challenge_id)?;
        (pending.user_id == user_id && pending.session_hash.as_deref() == session_hash)
            .then_some(pending)
    }

    /// Check the browser's answer to a registration and return the new credential.
    pub fn finish_registration(
        &self,
        pending: &PendingRegistration,
        credential: &Value,
    ) -> AppResult<Passkey> {
        let webauthn = self.webauthn()?;
        let reg: RegisterPublicKeyCredential = serde_json::from_value(credential.clone())
            .map_err(|e| AppError::bad_request(format!("malformed passkey response: {e}")))?;
        webauthn
            .finish_passkey_registration(&reg, &pending.state)
            .map_err(|e| {
                tracing::debug!(error = %e, "passkey registration refused");
                AppError::bad_request(
                    "the passkey could not be verified; check that you are on the address \
                     OpenBase is configured for, and try again",
                )
            })
    }

    /// Start a sign-in. Discoverable: no account is named, so the options carry no credential
    /// list and the authenticator offers the passkeys it holds for this site.
    pub fn start_login(&self) -> AppResult<PasskeyChallenge> {
        let webauthn = self.webauthn()?;
        let (rcr, state) = webauthn
            .start_discoverable_authentication()
            .map_err(|e| AppError::internal(format!("webauthn authentication: {e}")))?;
        let options = serde_json::to_value(&rcr)?;
        let id = new_token("pkc_");
        self.logins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), state);
        Ok(PasskeyChallenge {
            challenge_id: id,
            options,
        })
    }

    /// Take a pending sign-in (spending it).
    pub fn take_login(&self, challenge_id: &str) -> Option<DiscoverableAuthentication> {
        self.logins
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take(challenge_id)
    }

    /// Parse the browser's answer to a sign-in and say which credential and account it claims.
    /// Nothing is trusted yet: [`Passkeys::finish_login`] checks the signature.
    pub fn identify_login(
        &self,
        credential: &Value,
    ) -> AppResult<(PublicKeyCredential, Uuid, Vec<u8>)> {
        let webauthn = self.webauthn()?;
        let cred: PublicKeyCredential = serde_json::from_value(credential.clone())
            .map_err(|e| AppError::bad_request(format!("malformed passkey response: {e}")))?;
        let (handle, cred_id) = webauthn
            .identify_discoverable_authentication(&cred)
            .map_err(|_| AppError::bad_request("the passkey response names no account"))?;
        let cred_id = cred_id.to_vec();
        Ok((cred, handle, cred_id))
    }

    /// Verify the signature, challenge, origin, RP ID, user verification and signature counter of
    /// a sign-in against the stored credential. Updates `passkey` (counter, backup flags) on
    /// success. The error says whether the counter went backwards, which is the signal that the
    /// credential was cloned.
    pub fn finish_login(
        &self,
        cred: &PublicKeyCredential,
        state: DiscoverableAuthentication,
        passkey: &mut Passkey,
    ) -> Result<(), LoginRefused> {
        let webauthn = self.webauthn().map_err(|_| LoginRefused::Invalid)?;
        let key = [webauthn_rs::prelude::DiscoverableKey::from(&*passkey)];
        let result = webauthn
            .finish_discoverable_authentication(cred, state, &key)
            .map_err(|e| {
                tracing::debug!(error = %e, "passkey sign-in refused");
                match e {
                    webauthn_rs::prelude::WebauthnError::CredentialPossibleCompromise => {
                        LoginRefused::CounterRegression
                    }
                    _ => LoginRefused::Invalid,
                }
            })?;
        passkey.update_credential(&result);
        Ok(())
    }
}

/// Why a passkey sign-in was refused after the credential was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginRefused {
    /// Wrong signature, challenge, origin or RP ID, missing user verification, ...
    Invalid,
    /// The signature counter did not increase: the credential may have been cloned.
    CounterRegression,
}

/// `webauthn-rs` asks authenticators for a resident key only as a "discouraged" preference. A
/// sign-in without a username needs the credential to be discoverable, so require it.
fn require_discoverable(options: &mut Value) {
    if let Some(selection) = options
        .pointer_mut("/publicKey/authenticatorSelection")
        .and_then(Value::as_object_mut)
    {
        selection.insert("residentKey".into(), json!("required"));
        selection.insert("requireResidentKey".into(), json!(true));
    }
}

/// What the browser reported about the credential's transports (`getTransports()`), as strings.
pub fn reported_transports(credential: &Value) -> Vec<String> {
    credential
        .pointer("/response/transports")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .take(16)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The browser's own claim, never trusted for security, that the new credential is not
/// discoverable (`credProps.rk == false`). Used only to give the user a useful message.
pub fn reported_not_discoverable(credential: &Value) -> bool {
    credential
        .pointer("/clientExtensionResults/credProps/rk")
        .or_else(|| credential.pointer("/extensions/credProps/rk"))
        .and_then(Value::as_bool)
        == Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(url: &str) -> Config {
        let dir = std::path::Path::new("/nonexistent");
        let mut c = Config::for_tests(dir);
        c.public_url = url.to_string();
        c
    }

    #[test]
    fn the_relying_party_is_the_host_of_the_public_url() {
        let (rp, origin) = relying_party(&config("https://Base.Example.com/")).unwrap();
        assert_eq!(rp, "base.example.com");
        assert_eq!(origin.as_str(), "https://base.example.com/");
        let (rp, origin) = relying_party(&config("http://localhost:8080")).unwrap();
        assert_eq!(rp, "localhost");
        assert_eq!(origin.as_str(), "http://localhost:8080/");
    }

    #[test]
    fn an_ip_address_or_garbage_cannot_be_a_relying_party() {
        for url in [
            "http://127.0.0.1:8080",
            "http://[::1]:8080",
            "https://203.0.113.7",
            "not a url",
            "",
        ] {
            assert!(relying_party(&config(url)).is_none(), "{url}");
            assert!(!Passkeys::new(&config(url)).enabled(), "{url}");
        }
        assert!(Passkeys::new(&config("http://localhost:8080")).enabled());
        assert!(Passkeys::new(&config("https://base.example.com")).enabled());
    }

    #[test]
    fn registration_options_require_a_discoverable_credential_and_user_verification() {
        let p = Passkeys::new(&config("https://base.example.com"));
        let c = p
            .start_registration(
                "usr1",
                None,
                Uuid::new_v4(),
                "ada@example.com",
                "Ada",
                vec![vec![1, 2, 3]],
            )
            .unwrap();
        let pk = &c.options["publicKey"];
        assert_eq!(pk["rp"]["id"], "base.example.com");
        assert_eq!(pk["user"]["name"], "ada@example.com");
        assert_eq!(pk["authenticatorSelection"]["residentKey"], "required");
        assert_eq!(pk["authenticatorSelection"]["requireResidentKey"], true);
        assert_eq!(pk["authenticatorSelection"]["userVerification"], "required");
        assert_eq!(pk["attestation"], "none");
        assert_eq!(pk["excludeCredentials"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_login_challenge_has_no_credential_list_and_is_spent_once() {
        let p = Passkeys::new(&config("https://base.example.com"));
        let c = p.start_login().unwrap();
        let pk = &c.options["publicKey"];
        assert_eq!(pk["rpId"], "base.example.com");
        assert_eq!(pk["userVerification"], "required");
        assert_eq!(pk["allowCredentials"].as_array().unwrap().len(), 0);
        assert!(p.take_login(&c.challenge_id).is_some());
        assert!(p.take_login(&c.challenge_id).is_none(), "single use");
        assert!(p.take_login("pkc_unknown").is_none());
    }

    #[test]
    fn a_registration_is_bound_to_its_user_and_session_and_spent_by_the_first_try() {
        let p = Passkeys::new(&config("https://base.example.com"));
        let start = |p: &Passkeys| {
            p.start_registration(
                "usr1",
                Some("sess1".into()),
                Uuid::new_v4(),
                "a@example.com",
                "A",
                vec![],
            )
            .unwrap()
            .challenge_id
        };
        let id = start(&p);
        assert!(p.take_registration(&id, "usr2", Some("sess1")).is_none());
        // The wrong try spent it.
        assert!(p.take_registration(&id, "usr1", Some("sess1")).is_none());
        let id = start(&p);
        assert!(p.take_registration(&id, "usr1", Some("other")).is_none());
        let id = start(&p);
        assert!(p.take_registration(&id, "usr1", Some("sess1")).is_some());
    }

    #[test]
    fn the_pending_stores_stay_bounded_and_expire() {
        let mut pending: Pending<u8> = Pending::default();
        for i in 0..MAX_PENDING + 5 {
            pending.insert(format!("c{i}"), 0);
        }
        assert!(pending.map.len() <= MAX_PENDING);
        pending.insert("old".into(), 1);
        pending.map.get_mut("old").unwrap().0 =
            Instant::now() - CHALLENGE_TTL - Duration::from_secs(1);
        assert!(pending.take("old").is_none(), "expired");
    }

    #[test]
    fn transports_and_credprops_are_read_from_the_browser_answer() {
        let c = json!({"response": {"transports": ["internal", "hybrid"]},
                       "clientExtensionResults": {"credProps": {"rk": false}}});
        assert_eq!(reported_transports(&c), vec!["internal", "hybrid"]);
        assert!(reported_not_discoverable(&c));
        let c = json!({"extensions": {"credProps": {"rk": true}}});
        assert!(!reported_not_discoverable(&c));
        assert!(!reported_not_discoverable(&json!({})));
        assert!(reported_transports(&json!({})).is_empty());
    }
}
