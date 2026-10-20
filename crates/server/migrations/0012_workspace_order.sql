-- OpenBase schema v12: each member orders the workspaces they belong to in their own sidebar
-- (POST /api/workspaces/reorder). NULL = no place of their own yet: those workspaces follow the
-- placed ones, oldest first, so a workspace created or joined later lands at the end.
ALTER TABLE workspace_members ADD COLUMN position REAL;
