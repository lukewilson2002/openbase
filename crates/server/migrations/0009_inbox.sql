-- OpenBase schema v9: the inbox, a user's private quick-capture drafts.
--
-- A draft is an optional title, Markdown text and uploaded files, kept until its owner files it
-- into a table (which creates a record and deletes the draft) or deletes it.
-- Drafts belong to one user and to no workspace. `attachments` is a JSON array
-- of attachment references (the shape an attachment cell stores).

CREATE TABLE inbox_items (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title        TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    attachments  TEXT NOT NULL DEFAULT '[]',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX inbox_items_user ON inbox_items(user_id, updated_at);
