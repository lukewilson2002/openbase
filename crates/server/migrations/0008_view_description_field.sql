-- OpenBase schema v8: the description field belongs to the view, not to kanban.
--
-- A view's description field (`ViewConfig.description_field_id`) is read under
-- each record's title in kanban, gallery, list, calendar and timeline views.
-- Kanban boards that already chose one (`kanban.description_field_id`) keep it.

UPDATE views
SET config = json_remove(
        json_set(config, '$.description_field_id', json_extract(config, '$.kanban.description_field_id')),
        '$.kanban.description_field_id')
WHERE json_valid(config)
  AND json_type(config, '$.kanban.description_field_id') = 'text';

UPDATE views
SET config = json_remove(config, '$.kanban.description_field_id')
WHERE json_valid(config)
  AND json_type(config, '$.kanban.description_field_id') IS NOT NULL;
