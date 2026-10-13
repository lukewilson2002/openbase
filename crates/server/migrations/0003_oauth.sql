-- OpenBase schema v3: an OAuth 2.1 authorization server for the MCP endpoint.
-- Additive: new tables only. Secrets (codes, access and refresh tokens, client secrets) are
-- stored as SHA-256 hashes, like sessions and personal access tokens.

-- Registered clients. `id` is the client_id: random for `dcr` and `preregistered` clients, the
-- HTTPS URL of the client's metadata document for `cimd` clients (cached copy of that document).
CREATE TABLE oauth_clients (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL CHECK (source IN ('dcr', 'cimd', 'preregistered')),
    name          TEXT NOT NULL,
    -- Stored for completeness; the consent page never loads it.
    logo_uri      TEXT,
    -- JSON array of exact redirect URIs.
    redirect_uris TEXT NOT NULL,
    -- SHA-256 of the client secret (confidential clients only).
    secret_hash   TEXT,
    -- Registrations of public clients with the same name and redirect URIs share one client.
    fingerprint   TEXT,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    -- cimd: when the metadata document was last fetched.
    fetched_at    INTEGER
) STRICT;
CREATE INDEX oauth_clients_fingerprint ON oauth_clients(fingerprint) WHERE fingerprint IS NOT NULL;

-- Authorization requests waiting for the user's decision. The browser only carries this row's
-- id to the consent page, so the client cannot change the parameters between the steps.
CREATE TABLE oauth_requests (
    id             TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    state          TEXT,
    resource       TEXT NOT NULL,
    -- Normalized list of the requested scopes, space separated ('' = none requested).
    scope          TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL
) STRICT;

-- Authorization codes: single use, short lived, bound to everything the token request must repeat.
CREATE TABLE oauth_codes (
    code_hash      TEXT PRIMARY KEY,
    client_id      TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource       TEXT NOT NULL,
    -- JSON TokenScope chosen on the consent page.
    scopes         TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    used_at        INTEGER,
    -- The grant created when the code was redeemed (so a replay can revoke it).
    grant_id       TEXT
) STRICT;

-- What a user has allowed a client to do: the "connected apps".
CREATE TABLE oauth_grants (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id    TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    -- The redirect address the user approved the app for (shown as "who receives the access").
    redirect_uri TEXT NOT NULL,
    -- The resource (audience) the tokens are valid for.
    resource     TEXT NOT NULL,
    -- JSON TokenScope: {"write", "manage", "base_ids"}.
    scopes       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
) STRICT;
CREATE INDEX oauth_grants_user ON oauth_grants(user_id);
CREATE INDEX oauth_grants_client ON oauth_grants(client_id);

-- Access tokens (1 hour) and rotating refresh tokens (30 days idle). A refresh token that has
-- been exchanged keeps its row with `used_at` set, which is how reuse is detected.
CREATE TABLE oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    grant_id   TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
) STRICT;
CREATE INDEX oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(expires_at);
