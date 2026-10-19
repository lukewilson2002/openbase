-- OpenBase schema v11: every table has a default grid view (`is_default`), a plain grid of all its
-- records that cannot be deleted and is listed apart from the table's views. Its field order and
-- hidden fields are the layout of the table's records; it keeps no filter, sort, grouping or colours
-- (each person filters it on their own device).
ALTER TABLE views ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- One per table, trashed tables included (they may be restored). It starts with the layout of the
-- table's first shared grid view, so records keep the layout they had: that grid's field order,
-- hidden fields, widths, frozen columns, row height and header wrapping, without its filter, sorts,
-- grouping, colours or summaries.
INSERT INTO views (id, table_id, name, type, config, position, locked, created_at, is_default)
SELECT 'viw' || lower(hex(randomblob(7))),
       t.id,
       'Default grid',
       'grid',
       COALESCE(
         (SELECT json_remove(v.config, '$.filter', '$.sorts', '$.groups', '$.row_color', '$.summaries',
                             '$.description_field_id', '$.kanban', '$.calendar', '$.gallery',
                             '$.timeline', '$.form')
            FROM views v
           WHERE v.table_id = t.id AND v.type = 'grid' AND v.deleted_at IS NULL
             AND v.personal_owner_id IS NULL AND json_valid(v.config)
           ORDER BY v.position, v.created_at, v.id
           LIMIT 1),
         '{}'),
       0,
       0,
       CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       1
  FROM tables t;

CREATE UNIQUE INDEX views_one_default ON views(table_id) WHERE is_default = 1;
