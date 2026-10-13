-- OpenBase schema v2: icons for workspaces and tables.
-- An icon is a Lucide icon name in kebab-case ("briefcase", "chart-column");
-- NULL means "none" and clients fall back to the first letter of the name.
-- Additive: two nullable columns, plus clearing any v1 base icon that is not a
-- valid name (v1 accepted free text up to 64 characters but never displayed it).

ALTER TABLE workspaces ADD COLUMN icon TEXT;
ALTER TABLE tables ADD COLUMN icon TEXT;

UPDATE bases SET icon = NULL
WHERE icon IS NOT NULL AND (icon = '' OR length(icon) > 64 OR icon GLOB '*[^a-z0-9-]*');
