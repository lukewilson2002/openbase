//! A software WebAuthn authenticator (and the browser around it) for the passkey tests.
//!
//! It does what a browser plus a platform authenticator do, byte for byte: reads the options the
//! server sent, builds `clientDataJSON`, signs with an ES256 key and answers in the JSON shape
//! `web/src/lib/webauthn.ts` sends. It holds discoverable credentials (with the user handle the
//! server chose), counts signatures, and exposes the knobs a test needs to misbehave: the
//! counter, the user-verification flag, the origin, the relying party.
#![allow(dead_code)]

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use serde_cbor_2::Value as Cbor;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::common::{Client, Response, TestApp};

pub const ORIGIN: &str = "http://localhost:8080";

const FLAG_UP: u8 = 0x01;
const FLAG_UV: u8 = 0x04;
const FLAG_BE: u8 = 0x08;
const FLAG_BS: u8 = 0x10;
const FLAG_AT: u8 = 0x40;

pub struct Credential {
    pub id: Vec<u8>,
    key: SigningKey,
    pub rp_id: String,
    pub user_handle: Vec<u8>,
    pub counter: u32,
}

impl Credential {
    pub fn id_b64(&self) -> String {
        B64.encode(&self.id)
    }
}

pub struct Authenticator {
    /// The origin the "browser" is on; it ends up in `clientDataJSON`.
    pub origin: String,
    pub credentials: Vec<Credential>,
    /// Set the user-verified flag in what the authenticator signs.
    pub user_verified: bool,
    /// Report the credential as synced (backup eligible and backed up).
    pub synced: bool,
    /// Include the user handle in assertions (a discoverable credential does).
    pub send_user_handle: bool,
    /// Transports reported with a new credential.
    pub transports: Vec<&'static str>,
}

impl Authenticator {
    pub fn new() -> Authenticator {
        Authenticator::on(ORIGIN)
    }

    pub fn on(origin: &str) -> Authenticator {
        Authenticator {
            origin: origin.to_string(),
            credentials: Vec::new(),
            user_verified: true,
            synced: false,
            send_user_handle: true,
            transports: vec!["internal"],
        }
    }

    fn rp_id_of(&self) -> String {
        url::Url::parse(&self.origin)
            .unwrap()
            .host_str()
            .unwrap()
            .to_string()
    }

    fn flags(&self, extra: u8) -> u8 {
        let mut f = FLAG_UP | extra;
        if self.user_verified {
            f |= FLAG_UV;
        }
        if self.synced {
            f |= FLAG_BE | FLAG_BS;
        }
        f
    }

    /// `navigator.credentials.create()`: the credential JSON the web client sends to
    /// `register/finish`, or the reason the browser would have refused.
    pub fn create(&mut self, options: &Value) -> Result<Value, String> {
        let pk = &options["publicKey"];
        let rp_id = pk["rp"]["id"].as_str().ok_or("no rp id")?.to_string();
        if rp_id != self.rp_id_of() {
            return Err(format!(
                "SecurityError: {rp_id} is not valid for the origin"
            ));
        }
        let challenge = pk["challenge"].as_str().ok_or("no challenge")?;
        let user_handle = B64
            .decode(pk["user"]["id"].as_str().ok_or("no user id")?)
            .map_err(|e| e.to_string())?;
        // excludeCredentials: a device that holds one of these refuses (InvalidStateError).
        for ex in pk["excludeCredentials"].as_array().into_iter().flatten() {
            let id = B64
                .decode(ex["id"].as_str().unwrap_or_default())
                .map_err(|e| e.to_string())?;
            if self
                .credentials
                .iter()
                .any(|c| c.id == id && c.rp_id == rp_id)
            {
                return Err("InvalidStateError: already registered".into());
            }
        }
        // A new credential for the same account on the same authenticator replaces the old.
        self.credentials
            .retain(|c| !(c.rp_id == rp_id && c.user_handle == user_handle));

        let mut id = vec![0u8; 32];
        rand::RngExt::fill(&mut rand::rng(), id.as_mut_slice());
        let mut secret = [0u8; 32];
        rand::RngExt::fill(&mut rand::rng(), secret.as_mut_slice());
        let key = SigningKey::from_slice(&secret).map_err(|e| e.to_string())?;
        let point = VerifyingKey::from(&key).to_encoded_point(false);

        let cose = Cbor::Map(
            [
                (Cbor::Integer(1), Cbor::Integer(2)),
                (Cbor::Integer(3), Cbor::Integer(-7)),
                (Cbor::Integer(-1), Cbor::Integer(1)),
                (Cbor::Integer(-2), Cbor::Bytes(point.x().unwrap().to_vec())),
                (Cbor::Integer(-3), Cbor::Bytes(point.y().unwrap().to_vec())),
            ]
            .into_iter()
            .collect(),
        );
        let mut auth_data = Sha256::digest(rp_id.as_bytes()).to_vec();
        auth_data.push(self.flags(FLAG_AT));
        auth_data.extend_from_slice(&0u32.to_be_bytes());
        auth_data.extend_from_slice(&[0u8; 16]); // AAGUID: none
        auth_data.extend_from_slice(&(id.len() as u16).to_be_bytes());
        auth_data.extend_from_slice(&id);
        auth_data.extend(serde_cbor_2::to_vec(&cose).map_err(|e| e.to_string())?);
        let attestation = Cbor::Map(
            [
                (Cbor::Text("fmt".into()), Cbor::Text("none".into())),
                (Cbor::Text("attStmt".into()), Cbor::Map(Default::default())),
                (Cbor::Text("authData".into()), Cbor::Bytes(auth_data)),
            ]
            .into_iter()
            .collect(),
        );
        let client_data = json!({
            "type": "webauthn.create",
            "challenge": challenge,
            "origin": self.origin,
            "crossOrigin": false,
        })
        .to_string();

        let credential = json!({
            "id": B64.encode(&id),
            "rawId": B64.encode(&id),
            "type": "public-key",
            "response": {
                "attestationObject": B64.encode(serde_cbor_2::to_vec(&attestation).unwrap()),
                "clientDataJSON": B64.encode(client_data),
                "transports": self.transports,
            },
            "clientExtensionResults": { "credProps": { "rk": true } },
        });
        self.credentials.push(Credential {
            id,
            key,
            rp_id,
            user_handle,
            counter: 0,
        });
        Ok(credential)
    }

    /// `navigator.credentials.get()` with the first credential for the relying party (what a
    /// discoverable sign-in with a single passkey does).
    pub fn get(&mut self, options: &Value) -> Result<Value, String> {
        self.get_with(options, None)
    }

    /// Like [`Authenticator::get`], picking the credential with this id (the user's choice in the
    /// account picker).
    pub fn get_with(&mut self, options: &Value, pick: Option<&[u8]>) -> Result<Value, String> {
        let pk = &options["publicKey"];
        let rp_id = pk["rpId"].as_str().ok_or("no rp id")?.to_string();
        if rp_id != self.rp_id_of() {
            return Err(format!(
                "SecurityError: {rp_id} is not valid for the origin"
            ));
        }
        let challenge = pk["challenge"].as_str().ok_or("no challenge")?.to_string();
        let allowed: Vec<Vec<u8>> = pk["allowCredentials"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| B64.decode(a["id"].as_str()?).ok())
            .collect();
        let index = self
            .credentials
            .iter()
            .position(|c| {
                c.rp_id == rp_id
                    && pick.is_none_or(|p| c.id == p)
                    && (allowed.is_empty() || allowed.contains(&c.id))
            })
            .ok_or("NotAllowedError: no credential")?;
        Ok(self.assert_with(index, &challenge))
    }

    /// Sign `challenge` (base64url) with credential `index` and build the answer.
    pub fn assert_with(&mut self, index: usize, challenge: &str) -> Value {
        self.counter_bump(index);
        let flags = self.flags(0);
        let origin = self.origin.clone();
        let send_handle = self.send_user_handle;
        let c = &self.credentials[index];
        let mut auth_data = Sha256::digest(c.rp_id.as_bytes()).to_vec();
        auth_data.push(flags);
        auth_data.extend_from_slice(&c.counter.to_be_bytes());
        let client_data = json!({
            "type": "webauthn.get",
            "challenge": challenge,
            "origin": origin,
            "crossOrigin": false,
        })
        .to_string();
        let mut signed = auth_data.clone();
        signed.extend_from_slice(&Sha256::digest(client_data.as_bytes()));
        let signature: Signature = c.key.sign(&signed);
        json!({
            "id": c.id_b64(),
            "rawId": c.id_b64(),
            "type": "public-key",
            "response": {
                "authenticatorData": B64.encode(&auth_data),
                "clientDataJSON": B64.encode(client_data),
                "signature": B64.encode(signature.to_der().as_bytes()),
                "userHandle": send_handle.then(|| B64.encode(&c.user_handle)),
            },
            "clientExtensionResults": {},
        })
    }

    /// A copy of the first credential (the same key, as if the device were cloned).
    pub fn clone_first_credential(&self) -> Credential {
        let c = &self.credentials[0];
        Credential {
            id: c.id.clone(),
            key: c.key.clone(),
            rp_id: c.rp_id.clone(),
            user_handle: c.user_handle.clone(),
            counter: c.counter,
        }
    }

    fn counter_bump(&mut self, index: usize) {
        self.credentials[index].counter += 1;
    }

    /// Make the next assertion of credential `index` carry this counter value minus one (it is
    /// incremented before use).
    pub fn set_counter(&mut self, index: usize, next: u32) {
        self.credentials[index].counter = next.saturating_sub(1);
    }
}

// ------------------------------------------------------------------------- server round trips

/// Session clients created with `TestApp::user` are "just signed in", so registering needs no
/// password. This is the whole registration against the real endpoints.
pub async fn register(
    app: &TestApp,
    client: &Client,
    auth: &mut Authenticator,
    name: &str,
) -> Response {
    let start = app
        .post(client, "/api/auth/passkeys/register/start", json!({}))
        .await;
    start.assert_status(200);
    let credential = auth.create(&start.body["options"]).expect("authenticator");
    app.post(
        client,
        "/api/auth/passkeys/register/finish",
        json!({
            "challenge_id": start.body["challenge_id"],
            "name": name,
            "credential": credential,
        }),
    )
    .await
}

/// A fresh client address per call (the app must run with `trust_proxy`), so tests that sign in
/// many times do not meet the per-address limit by accident.
pub fn from_new_address(n: u32) -> [(&'static str, String); 1] {
    [("x-forwarded-for", format!("198.51.100.{}", n % 250 + 1))]
}

pub async fn login_start(app: &TestApp, ip: u32) -> Response {
    let h = from_new_address(ip);
    app.request_with(
        &app.anon(),
        "POST",
        "/api/auth/passkey-login/start",
        Some(json!({})),
        &[(h[0].0, h[0].1.as_str())],
        true,
        None,
    )
    .await
}

pub async fn login_finish(
    app: &TestApp,
    ip: u32,
    challenge_id: &Value,
    credential: &Value,
) -> Response {
    let h = from_new_address(ip);
    app.request_with(
        &app.anon(),
        "POST",
        "/api/auth/passkey-login/finish",
        Some(json!({ "challenge_id": challenge_id, "credential": credential })),
        &[(h[0].0, h[0].1.as_str())],
        true,
        None,
    )
    .await
}

/// A complete usernameless sign-in; returns the finish response.
pub async fn sign_in(app: &TestApp, auth: &mut Authenticator, ip: u32) -> Response {
    let start = login_start(app, ip).await;
    start.assert_status(200);
    let credential = auth.get(&start.body["options"]).expect("authenticator");
    login_finish(app, ip, &start.body["challenge_id"], &credential).await
}

/// The audit log's actions, oldest first.
pub fn audit_actions(app: &TestApp) -> Vec<String> {
    app.state
        .db
        .write_sync(|tx| {
            let mut stmt = tx.prepare("SELECT action FROM audit_log ORDER BY id")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            Ok(rows.map(|r| r.unwrap()).collect::<Vec<_>>())
        })
        .unwrap()
}

/// The `detail` JSON of the newest audit row with this action.
pub fn last_audit(app: &TestApp, action: &str) -> Value {
    let action = action.to_string();
    app.state
        .db
        .write_sync(move |tx| {
            let (detail, target, user_id): (Option<String>, Option<String>, Option<String>) = tx
                .query_row(
                    "SELECT detail, target, user_id FROM audit_log WHERE action = ?1
                     ORDER BY id DESC LIMIT 1",
                    [&action],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
            Ok(json!({
                "detail": detail.and_then(|d| serde_json::from_str::<Value>(&d).ok()),
                "target": target,
                "user_id": user_id,
            }))
        })
        .unwrap()
}
