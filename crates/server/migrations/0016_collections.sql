-- OpenBase schema v16: the groundwork of the UX overhaul (docs/plans/2026-11-07-ux-overhaul.md,
-- BE-1). Everything here adds a column or a row; no value a user entered changes. The data the
-- SQL cannot express (page properties, the Home presets) is set by `store::pages::upgrade_to_v16`,
-- which runs right after this script in the same transaction.
--
-- Projects become folders and a workspace's top level is one of them: `root_base_id` points at it
-- (decision 1). Collections (tables) get a colour, a page body, the two properties Home reads, and
-- a name for their records. People choose the first day of their calendar weeks.

ALTER TABLE workspaces ADD COLUMN root_base_id TEXT;

-- One of ob_core::field::COLORS. New tables take the next colour of the same cycle
-- (`store::tables::TABLE_COLORS`; keep the two lists in step).
ALTER TABLE tables ADD COLUMN color TEXT NOT NULL DEFAULT 'blue';

-- The rich text property that holds the collection's page (decision 2), the date property Home
-- orders it by (HOME-5), the checkbox property that marks a record done (HOME-5). Plain ids like
-- `primary_field_id`; NULL = none. The page property is set by the data fix below.
ALTER TABLE tables ADD COLUMN body_field_id TEXT;
ALTER TABLE tables ADD COLUMN home_date_field_id TEXT;
ALTER TABLE tables ADD COLUMN done_field_id TEXT;

-- What one record of the collection is called ("client"); empty = "record" (COL-1).
ALTER TABLE tables ADD COLUMN record_noun TEXT NOT NULL DEFAULT '';

-- 0 = Sunday, 1 = Monday.
ALTER TABLE users ADD COLUMN week_start INTEGER NOT NULL DEFAULT 0 CHECK (week_start IN (0, 1));

-- Colour the tables that exist: cycle through the palette in table order within each project.
-- Tables in the trash come after the live ones, so the live ones get the first colours.
UPDATE tables SET color = (
    SELECT CASE (o.n - 1) % 10
               WHEN 0 THEN 'blue' WHEN 1 THEN 'orange' WHEN 2 THEN 'green'
               WHEN 3 THEN 'purple' WHEN 4 THEN 'yellow' WHEN 5 THEN 'pink'
               WHEN 6 THEN 'teal' WHEN 7 THEN 'red' WHEN 8 THEN 'cyan'
               ELSE 'gray' END
    FROM (SELECT id, row_number() OVER (
                   PARTITION BY base_id
                   ORDER BY deleted_at IS NOT NULL, position, created_at, id) AS n
          FROM tables) o
    WHERE o.id = tables.id);

-- A workspace without a live project gets one, named after the workspace, so every workspace has
-- a top level. It has no tables and is open to everyone who has every project of the workspace,
-- like any project made later; members limited to a list of projects are not widened.
INSERT INTO bases (id, workspace_id, name, color, position, created_by, created_at)
SELECT 'app' || lower(hex(randomblob(7))),
       w.id,
       w.name,
       w.color,
       0,
       w.created_by,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM workspaces w
 WHERE NOT EXISTS (SELECT 1 FROM bases b WHERE b.workspace_id = w.id AND b.deleted_at IS NULL);

-- The top level is the first live project by position; ties go to the earlier creation time,
-- then to the lower id (decision 1).
UPDATE workspaces SET root_base_id = (
    SELECT b.id FROM bases b
     WHERE b.workspace_id = workspaces.id AND b.deleted_at IS NULL
     ORDER BY b.position, b.created_at, b.id
     LIMIT 1);
