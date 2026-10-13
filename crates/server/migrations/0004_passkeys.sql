-- OpenBase schema v4: passkeys (WebAuthn sign-in). Additive: new tables only.
--
-- A passkey is a public-key credential held by the user's device (or password manager). The
-- server stores only the public half; the private key never leaves the authenticator.

-- One row per registered credential. Removing the user removes their passkeys.
CREATE TABLE passkeys (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The credential id the browser presents at sign-in (base64url, unpadded). Unique across the
    -- instance: sign-in finds the account from it.
    credential_id    TEXT NOT NULL UNIQUE,
    -- JSON of the webauthn-rs `Passkey` (public key, signature counter, backup flags, ...).
    credential       TEXT NOT NULL,
    -- A label the user chose ("MacBook Touch ID").
    name             TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    last_used_at     INTEGER,
    -- JSON array of the transports the browser reported at registration ("internal", "usb",
    -- "hybrid", ...), or NULL when it reported none. Informational only.
    transports       TEXT,
    -- Backup flags as the authenticator reported them: a backup-eligible credential is a
    -- synced passkey (iCloud Keychain, Google Password Manager, a password manager).
    backup_eligible  INTEGER NOT NULL DEFAULT 0,
    backup_state     INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX passkeys_user ON passkeys(user_id, created_at);

-- The WebAuthn "user handle" of an account: an opaque random id (not the user id, not an email)
-- stored in the authenticator next to every discoverable credential, which is how a sign-in
-- without typing a username finds the account. It stays the same for the life of the account,
-- so re-registering a device replaces its old credential instead of leaving a stale one.
CREATE TABLE passkey_user_handles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    handle  BLOB NOT NULL UNIQUE
) STRICT;
