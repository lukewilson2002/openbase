-- OpenBase schema v17: a property that was a collection's page, Home date or Done property when it
-- went to the trash remembers which, so restoring it makes it that again (UX overhaul, BE-5).
-- `store::pages::clear_stale_settings` sets this when it clears the table's pointer for a trashed
-- property, and `restore_cleared_settings` reads and clears it. One of `body_field_id`,
-- `home_date_field_id` or `done_field_id`; NULL = none. Nothing a user entered changes.
ALTER TABLE fields ADD COLUMN trashed_setting TEXT;
