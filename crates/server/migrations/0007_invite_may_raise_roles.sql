-- OpenBase schema v7: whether accepting an invite may raise an existing
-- member's role.
--
-- A workspace role applies to every base, so only someone who could set it
-- for the whole workspace may hand out an invite that raises it: a workspace
-- owner acting without a base-limited API token. This used to be read from
-- the inviter's role at accept time, which an owner's token limited to one
-- base also has; the flag records the standing of whoever set the invite's
-- terms when they set them.
--
-- Existing invites start with 0: how their terms were set (session, or a
-- token limited to some bases) was never recorded, so none may raise. Their
-- invitees who are already members still get the invite's bases, at their
-- current role; an owner can raise them directly or send a new invite.
-- Invites last 7 days, so this only touches the ones pending at the upgrade.

ALTER TABLE invites ADD COLUMN may_raise_roles INTEGER NOT NULL DEFAULT 0;
