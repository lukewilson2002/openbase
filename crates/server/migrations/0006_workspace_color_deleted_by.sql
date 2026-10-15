-- OpenBase schema v6: workspace colours, and who moved things to the trash.
--
-- Workspaces get a colour from the same palette as bases (ob_core::field::COLORS).
-- Existing workspaces are coloured by creation order per creator, cycling
-- through the same eight colours `store::workspaces::DEFAULT_COLORS` hands out
-- to new workspaces (keep the two lists in step), so someone's first three
-- workspaces come out green, blue and gray rather than all the same.

ALTER TABLE workspaces ADD COLUMN color TEXT NOT NULL DEFAULT 'blue';

UPDATE workspaces SET color = (
    SELECT CASE (o.n - 1) % 8
               WHEN 0 THEN 'green' WHEN 1 THEN 'blue' WHEN 2 THEN 'gray'
               WHEN 3 THEN 'purple' WHEN 4 THEN 'orange' WHEN 5 THEN 'teal'
               WHEN 6 THEN 'pink' ELSE 'yellow' END
    FROM (SELECT id, row_number() OVER (PARTITION BY created_by ORDER BY created_at, id) AS n
          FROM workspaces) o
    WHERE o.id = workspaces.id);
