-- OpenBase schema v5: one access model. People get access by being workspace
-- members; each member has one role and either every base of the workspace
-- (all_bases = 1, including bases created later) or a picked list of bases
-- (workspace_member_bases). Per-base roles (base_members) go away.
--
-- Existing data is converted as follows:
--  * someone who was only a member of individual bases becomes a workspace
--    member limited to those bases, with their highest role among them (an
--    "owner" of a single base becomes a "creator": owners always see every
--    base, so keeping "owner" would hand them the whole workspace). Being a
--    workspace member, they now also see its member list, and a creator can
--    add new bases to the workspace;
--  * only live bases of live workspaces count: someone who was only on
--    trashed bases (or bases of a trashed workspace) becomes no member at
--    all, since they could open nothing, and their access to those bases
--    goes away instead of coming back with a restore;
--  * someone who was a workspace member AND a base member keeps their
--    workspace role on all bases; the base row only ever raised their role on
--    that one base, and that raise is dropped rather than widened;
--  * base invites become workspace invites limited to that base (owner role
--    capped at creator for the same reason as above); invites to trashed
--    bases or bases of trashed workspaces are deleted, for the same reason
--    as trashed-base members.
-- Everyone sees the new introduction once (intro_seen starts at 0).

ALTER TABLE users ADD COLUMN intro_seen INTEGER NOT NULL DEFAULT 0;

ALTER TABLE workspace_members ADD COLUMN all_bases INTEGER NOT NULL DEFAULT 1;

-- The bases a member with all_bases = 0 can open. The composite foreign key
-- removes the list together with the membership, so leaving a workspace can
-- never leave base access behind.
CREATE TABLE workspace_member_bases (
    workspace_id  TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    base_id       TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, user_id, base_id),
    FOREIGN KEY (workspace_id, user_id)
        REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX workspace_member_bases_base ON workspace_member_bases(base_id);

-- Invites always target a workspace now; base_id stays as an unused column
-- (dropping it would mean rebuilding the table).
ALTER TABLE invites ADD COLUMN all_bases INTEGER NOT NULL DEFAULT 1;

CREATE TABLE invite_bases (
    invite_id  TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    base_id    TEXT NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    PRIMARY KEY (invite_id, base_id)
) STRICT;
CREATE INDEX invite_bases_base ON invite_bases(base_id);

-- Base-only members become limited workspace members. A single INSERT ...
-- SELECT reads workspace_members while writing it; SQLite materialises the
-- SELECT first when it reads the target table, so the NOT EXISTS sees only
-- the memberships that existed before.
INSERT INTO workspace_members (workspace_id, user_id, role, created_at, all_bases)
SELECT b.workspace_id,
       bm.user_id,
       CASE max(CASE bm.role
                    WHEN 'viewer' THEN 1 WHEN 'commenter' THEN 2 WHEN 'editor' THEN 3
                    ELSE 4 END)
           WHEN 1 THEN 'viewer' WHEN 2 THEN 'commenter' WHEN 3 THEN 'editor'
           ELSE 'creator' END,
       min(bm.created_at),
       0
FROM base_members bm
JOIN bases b ON b.id = bm.base_id
JOIN workspaces w ON w.id = b.workspace_id
WHERE b.deleted_at IS NULL AND w.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM workspace_members wm
                  WHERE wm.workspace_id = b.workspace_id AND wm.user_id = bm.user_id)
GROUP BY b.workspace_id, bm.user_id;

-- Only the members created just above have all_bases = 0. Their trashed
-- bases stay off the list, so restoring one does not bring access back.
INSERT INTO workspace_member_bases (workspace_id, user_id, base_id)
SELECT b.workspace_id, bm.user_id, bm.base_id
FROM base_members bm
JOIN bases b ON b.id = bm.base_id
JOIN workspace_members wm ON wm.workspace_id = b.workspace_id AND wm.user_id = bm.user_id
WHERE wm.all_bases = 0 AND b.deleted_at IS NULL;

-- Invites to trashed bases go (see the header): converted, restoring the
-- base would revive them as invites into a workspace.
DELETE FROM invites
WHERE base_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM bases b JOIN workspaces w ON w.id = b.workspace_id
                  WHERE b.id = invites.base_id
                    AND b.deleted_at IS NULL AND w.deleted_at IS NULL);

-- The remaining base invites (pending or not, so the workspace's invite
-- history stays complete) become workspace invites limited to their base.
INSERT INTO invite_bases (invite_id, base_id)
SELECT id, base_id FROM invites WHERE base_id IS NOT NULL;

UPDATE invites
SET workspace_id = (SELECT b.workspace_id FROM bases b WHERE b.id = invites.base_id),
    all_bases = 0,
    role = CASE role WHEN 'owner' THEN 'creator' ELSE role END,
    base_id = NULL
WHERE base_id IS NOT NULL;

DROP TABLE base_members;
