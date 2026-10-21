-- OpenBase schema v14: the text field types are Text and Rich text. `single_line_text` becomes
-- `text` (plain, one line unless its `multiline` option is on) and `long_text` becomes
-- `rich_text` (always Markdown, no options). A long text field without its `rich` option showed
-- its text as typed, so it becomes a Text field with `multiline` on and shows the same; the values
-- themselves do not change. The old names stay accepted on input (serde aliases on FieldKind).
UPDATE fields
   SET type = 'text',
       options = json_set(CASE WHEN json_valid(options) THEN options ELSE '{}' END, '$.multiline', json('false'))
 WHERE type = 'single_line_text';

UPDATE fields
   SET type = 'text',
       options = '{"multiline":true}'
 WHERE type = 'long_text'
   AND NOT (json_valid(options) AND coalesce(json_extract(options, '$.rich'), 0) IN (1, 'true'));

UPDATE fields
   SET type = 'rich_text',
       options = '{}'
 WHERE type = 'long_text';
