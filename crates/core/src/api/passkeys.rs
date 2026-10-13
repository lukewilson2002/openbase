//! DTOs for passkeys (WebAuthn sign-in): the account's list, registering a new one and signing in
//! with one.
//!
//! The browser's WebAuthn objects (`options` below, and the `credential` the browser answers
//! with) travel as opaque JSON: the server builds and checks them with `webauthn-rs`, the web
//! client only converts their binary members between base64url and `ArrayBuffer`
//! (`web/src/lib/webauthn.ts`). Nothing else needs to understand them.

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

/// One registered passkey, as `GET /api/auth/passkeys` lists it. Never carries the public key or
/// the credential id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasskeyInfo {
    pub id: String,
    /// The label the user chose.
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    /// How the browser said the authenticator connects ("internal", "usb", "hybrid", ...); may be
    /// empty.
    #[serde(default)]
    pub transports: Vec<String>,
    /// The authenticator says the credential can be synced to other devices (iCloud Keychain,
    /// Google Password Manager, a password manager).
    #[serde(default)]
    pub backup_eligible: bool,
    /// ... and that it currently is.
    #[serde(default)]
    pub backup_state: bool,
}

/// `POST /api/auth/passkeys/register/start`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasskeyRegisterStart {
    /// The account password. Required unless the session signed in within the last 10 minutes;
    /// the answer `reauth_required` (403) says it is.
    #[serde(default)]
    pub password: Option<String>,
}

/// A WebAuthn challenge: the `challenge_id` goes back with the browser's answer; `options` is
/// handed to `navigator.credentials.create()` (registering) or `.get()` (signing in), after
/// converting its base64url members to buffers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasskeyChallenge {
    pub challenge_id: String,
    pub options: Json,
}

/// `POST /api/auth/passkeys/register/finish`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasskeyRegisterFinish {
    pub challenge_id: String,
    /// A label for the new passkey (at most 100 characters); "Passkey" when empty.
    #[serde(default)]
    pub name: Option<String>,
    /// The browser's `PublicKeyCredential` from `create()`, with its binary members as base64url.
    pub credential: Json,
}

/// `PATCH /api/auth/passkeys/{id}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasskeyRename {
    pub name: String,
}

/// `POST /api/auth/passkey-login/finish`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasskeyLoginFinish {
    pub challenge_id: String,
    /// The browser's `PublicKeyCredential` from `get()`, with its binary members as base64url.
    pub credential: Json,
}

/// `DELETE /api/admin/users/{id}/passkeys`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, optional_fields = nullable))]
pub struct PasskeysRemoved {
    pub removed: i64,
}
