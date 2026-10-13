-- OpenBase schema v1.
-- Conventions: ids are prefixed random strings (see ob_core::ids); timestamps
-- are INTEGER unix milliseconds UTC; soft-deleted rows have deleted_at set and
-- are purged by the trash job after the retention period.

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    is_admin        INTEGER NOT NULL DEFAULT 0,
    is_active       INTEGER NOT NULL DEFAULT 1,
    timezone        TEXT,
    totp_secret     TEXT,
    totp_enabled    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    last_login_at   INTEGER
) STRICT;

CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,           -- sha256(token), hex
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    user_agent    TEXT,
    ip            TEXT,
    -- set after password ok but before TOTP verified
    pending_2fa   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE api_tokens (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    -- JSON: {"access": "read"|"write", "base_ids": [..] | null (all bases)}
    scopes        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    expires_at    INTEGER
) STRICT;
CREATE INDEX api_tokens_user ON api_tokens(user_id);

CREATE TABLE password_resets (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
) STRICT;

CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER
) STRICT;

-- role: owner | creator | editor | commenter | viewer
CREATE TABLE workspace_members (
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
) STRICT;
CREATE INDEX workspace_members_user ON workspace_members(user_id);

CREATE TABLE invites (
    id            TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,
    workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    base_id       TEXT REFERENCES bases(id) ON DELETE CASCADE,
    email         TEXT COLLATE NOCASE,
    role          TEXT NOT NULL,
    created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    accepted_at   INTEGER,
    accepted_by   TEXT REFERENCES users(id) ON DELETE SET NULL
) STRICT;

CREATE TABLE bases (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    color         TEXT NOT NULL DEFAULT 'blue',
    icon          TEXT,
    position      REAL NOT NULL DEFAULT 0,
    created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at    INTEGER NOT NULL,
    deleted_at    INTEGER
) STRICT;
CREATE INDEX bases_workspace ON bases(workspace_id);

-- Base-level sharing: grants a role on one base (effective role is the max of
-- workspace and base roles).
CREATE TABLE base_members (
    base_id     TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (base_id, user_id)
) STRICT;
CREATE INDEX base_members_user ON base_members(user_id);

CREATE TABLE tables (
    id                TEXT PRIMARY KEY,
    base_id           TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    description       TEXT,
    position          REAL NOT NULL DEFAULT 0,
    primary_field_id  TEXT NOT NULL,
    next_autonumber   INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL,
    deleted_at        INTEGER
) STRICT;
CREATE INDEX tables_base ON tables(base_id);

CREATE TABLE fields (
    id           TEXT PRIMARY KEY,
    table_id     TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,
    options      TEXT NOT NULL,      -- JSON, shape per ob_core::field::FieldKind
    description  TEXT,
    position     REAL NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER
) STRICT;
CREATE INDEX fields_table ON fields(table_id);

-- One row per record. `data` is a JSON object keyed by field id holding the
-- canonical value of every non-empty editable field AND the materialized value
-- of every computed field (maintained by the recompute engine).
CREATE TABLE records (
    id          TEXT PRIMARY KEY,
    table_id    TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    data        TEXT NOT NULL DEFAULT '{}',
    position    REAL NOT NULL,        -- manual order (grid without sorts)
    autonumber  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    created_by  TEXT,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT,
    deleted_at  INTEGER
) STRICT;
CREATE INDEX records_table_live ON records(table_id, position) WHERE deleted_at IS NULL;
CREATE INDEX records_table_deleted ON records(table_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE views (
    id           TEXT PRIMARY KEY,
    table_id     TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,
    config       TEXT NOT NULL DEFAULT '{}',   -- JSON ob_core::view::ViewConfig
    position     REAL NOT NULL DEFAULT 0,
    -- personal views are visible only to their owner
    personal_owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    locked       INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    deleted_at   INTEGER
) STRICT;
CREATE INDEX views_table ON views(table_id);

CREATE TABLE comments (
    id          TEXT PRIMARY KEY,
    record_id   TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER
) STRICT;
CREATE INDEX comments_record ON comments(record_id, created_at);

-- Append-only per-record change log (editable fields only).
-- changes: JSON {"fldX": {"old": <json>, "new": <json>}, ...}
-- kind: create | update | delete | restore
CREATE TABLE record_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id   TEXT NOT NULL,
    table_id    TEXT NOT NULL,
    user_id     TEXT,
    kind        TEXT NOT NULL,
    changes     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX record_history_record ON record_history(record_id, id);
CREATE INDEX record_history_created ON record_history(created_at);

-- Uploaded files. Bytes live at <data_dir>/attachments/<sha256[0..2]>/<sha256>.
CREATE TABLE attachments (
    id          TEXT PRIMARY KEY,
    sha256      TEXT NOT NULL,
    filename    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    has_thumb   INTEGER NOT NULL DEFAULT 0,
    base_id     TEXT REFERENCES bases(id) ON DELETE CASCADE,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX attachments_sha ON attachments(sha256);
CREATE INDEX attachments_base ON attachments(base_id);

-- kind: view (read-only shared view) | form (public form)
CREATE TABLE share_links (
    id             TEXT PRIMARY KEY,
    token          TEXT NOT NULL UNIQUE,  -- unguessable, appears in URL
    kind           TEXT NOT NULL,
    view_id        TEXT NOT NULL REFERENCES views(id) ON DELETE CASCADE,
    password_hash  TEXT,
    enabled        INTEGER NOT NULL DEFAULT 1,
    created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX share_links_view ON share_links(view_id);

CREATE TABLE automations (
    id           TEXT PRIMARY KEY,
    base_id      TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 0,
    trigger      TEXT NOT NULL,   -- JSON
    actions      TEXT NOT NULL,   -- JSON array
    -- incoming-webhook trigger secret (hashed); scheduled-trigger next run
    webhook_token_hash TEXT UNIQUE,
    next_run_at  INTEGER,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX automations_base ON automations(base_id);

-- Durable job queue for automation runs (survives restarts).
-- status: queued | running | succeeded | failed
CREATE TABLE automation_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    automation_id  TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    status         TEXT NOT NULL,
    trigger_data   TEXT NOT NULL,   -- JSON
    log            TEXT NOT NULL DEFAULT '[]',
    error          TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    started_at     INTEGER,
    finished_at    INTEGER
) STRICT;
CREATE INDEX automation_runs_status ON automation_runs(status, id);
CREATE INDEX automation_runs_automation ON automation_runs(automation_id, id);

CREATE TABLE notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,     -- mention | assigned | invite | automation
    payload     TEXT NOT NULL,     -- JSON
    read_at     INTEGER,
    created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX notifications_user ON notifications(user_id, created_at);

-- Security-relevant events (logins, role changes, token creation, ...).
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT,
    action      TEXT NOT NULL,
    target      TEXT,
    detail      TEXT,              -- JSON
    ip          TEXT,
    created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX audit_log_created ON audit_log(created_at);
