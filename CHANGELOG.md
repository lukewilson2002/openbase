# Changelog

All notable changes to OpenBase are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the major version is 0, a new minor
version (0.2.0) may contain breaking changes; read its notes before upgrading.

Releases are published from [GitHub Releases](https://github.com/lukewilson2002/openbase/releases)
(see [docs/releasing.md](docs/releasing.md)). Write changes under **Unreleased** as you go;
`scripts/release.sh X.Y.Z` turns that section into the release's.

## [Unreleased]

### Added

- **MCP agents keep a table's views up to date.** The server instructions and the table, field and
  view tools now ask agents to set up the views a table's purpose calls for (a calendar for dated
  records, a kanban by status, a form for intake, grids sorted or filtered for common questions),
  named for what they show, and to read data through a fitting view with `query_view`.
  `create_table` and `import_csv` (new table) return a `views_note` saying so; `create_field`
  returns one naming the views the new field may concern, including the forms that do not ask for
  it yet. `delete_field` and type changes in `update_field` return `views_to_check`: every view
  whose filter, sorts, grouping, row colours, form or a setting such as a calendar's date field or
  a kanban's stack field used the field, and where.

### Changed

- The MCP server instructions were tightened to stay under 2048 characters, the length Claude
  Code shows.
- **Menus and popovers fit the screen.** Every menu, submenu and popover is at most as tall as the
  room between its trigger and the edge of the screen (clear of the iPhone home indicator) and
  scrolls past that. On a phone the table and view picker runs to the bottom of the screen, and an
  unfolded "Add view" scrolls inside it instead of being cut off.
- **The compact layout runs up to 1024px wide.** Phones in landscape and tablets in portrait keep
  the phone layout (views edge to edge, the menu in a drawer) instead of switching to the desktop
  one with its margins and docked menu at 768px.
- **The whole menu above the profile scrolls.** Members, Automations and Trash are no longer fixed
  at the bottom of the sidebar: a long menu pushes them down and you scroll to reach them (a short
  one still keeps them at the bottom). A shadow at the top or bottom edge shows there is more to
  scroll that way.
- MCP `create_view` and `update_view` accept `description_field_id` inside `kanban` (where 0.4.0
  had it), `gallery`, `calendar` or `timeline` and move it to the top of the config, where it
  belongs; the config help says so.

### Fixed

- On a phone, a grid view that opens with its primary column already unpinned no longer leaves the
  pin button floating in place while the column scrolls away; the button moves with its column.

## [0.5.0] - 2026-10-17

### Added

- **Every view can read a description under each record's title.** Kanban, gallery, list, calendar
  and timeline views have a "Description" choice in their settings (list views get a "Description"
  tool of their own): any text field, chosen per view, so no table has to have one. Kanban and
  gallery cards show an excerpt of up to three lines under the title, list rows two; pointing at it
  shows the whole text (rich text as formatted markdown). Calendar events and timeline bars have
  room for the title only, so pointing at them shows the description. On a phone, tapping opens the
  record as before. The description field is not repeated among the card's or row's other fields.
- **Phones can unpin the grid's primary column.** A pin button in the primary field's header lets
  it scroll away sideways; it is pinned by default and remembered per view on each device.

### Changed

- **The description setting moved from kanban to the view.** `kanban.description_field_id` is now
  `description_field_id` at the top of the view config (REST API and MCP), and shared views report
  it as `description_field_id`. Existing boards keep their choice: the database migration moves it.
- On a phone, a submenu that has no room beside its menu ("Add view" in the table and view picker)
  unfolds its choices in place instead of opening off the left edge of the screen.

### Fixed

- On iPhones, the item count, the app header and the floating "Add" button keep clear of the
  rounded corners, the notch and the home indicator (the page now asks for the screen's safe areas).

## [0.4.0] - 2026-10-16

### Added

- **Kanban cards can show a description.** The board's "Stacked by" settings have a new
  "Description" choice: a text field (single line or long text, or a formula, rollup or lookup that
  gives text) shown under each card's title as plain text, up to three lines before an ellipsis.
  That field no longer repeats as a label/value row on the card. Rich long text is shown without
  its markdown. Shared boards show it too, unless the view hides the field. The setting is
  `kanban.description_field_id` in the view config (REST API and MCP, which takes the field name).

### Changed

- **The view toolbar makes room for itself.** When the window is too narrow for every tool, Filter,
  Sort, Group, Hide fields, Color and Row height move into More, from the right end first, and come
  back as the window widens. Add field and Download CSV always live in More.
- The pictures on an empty base and on a view's "choose a field" screen no longer move.

### Fixed

- The grid grows to fit its rows when a horizontal scrollbar shows (macOS set to always show
  scrollbars, Windows, Linux) instead of scrolling while the page still has room.
- Person chips and select pills are no longer cut off at the top and bottom on kanban and gallery
  cards and in lists.

## [0.3.0] - 2026-10-16

### Added

- **Select choices get meaningful default colours.** A choice created without a colour (when
  creating a select field, converting a field or typecasting a record value) is coloured from its
  name when it is a common severity or status word: Critical and Urgent red, High orange,
  Medium and In Progress yellow, Low and Done green, Open and To do blue, Cancelled gray. Other
  names still cycle through the palette. Choices given as `{name, color}` keep their colour (the
  `create_field` MCP tool, `field_types` and the REST API all accept it).

- **Aggregate records (group-by).** `POST /api/tables/{id}/aggregate` and the MCP tool
  `aggregate_records` count, sum, average and take the minimum or maximum of a table's records,
  optionally grouped by up to 3 fields, computed on the server in one pass instead of paging every
  record to the client. Records can be narrowed with a `view` and/or a `filter_by_formula`, like
  listing them, and the same permissions apply (Viewer; read-only tokens may call it). Group values
  are names, not ids (select choices, linked records, people), dates are `YYYY-MM-DD`, the empty
  group is `null`; invalid combinations such as a sum of a text field are clear errors. See
  [docs/api.md](docs/api.md) section 5.
- **`create_table` takes a list of fields** (MCP tool and `POST /api/bases/{id}/tables`):
  `fields` has the shape of `create_field` and sets a table up in one call. It is all or
  nothing: every field is checked and, if one is invalid, no table is created and the error
  names it. A lookup, rollup or count may use a link field listed earlier in the same list.
- **`include_empty` for reads.** `list_records`, `search_records`, `get_record` and `query_view` (and `includeEmpty=true` on the REST list and single-record endpoints) return fields with no value as `null`, so a client can infer columns from the records. Default unchanged: empty fields are left out, as in Airtable.

### Changed

- **Every new table starts the same way:** with just its primary field "Name" and a grid view.
  The first table of a base created without `empty` used to get a "Notes" long-text field as
  well; it no longer does, so a script no longer has to check which fields a new table has
  (add what you need with `fields` on `create_table` or with `create_field`). The web app
  already created bases empty, so it is not affected. Existing tables keep their fields.
- **Relative date filters are documented as viewer-time-zone.** `today`, `tomorrow`, `past_week`
  and the other relative modes are calendar days in the viewer's time zone (the request's
  `timezone`, else the profile's, else UTC), so an evening in US Central time still shows
  today's events. The MCP `create_view` / `update_view` descriptions and `docs/api.md`
  (section 6) now say so, and the MCP `query_view` tool takes an optional `timezone`.

### Fixed

- **Send test email with providers like Resend.** Choosing STARTTLS for an implicit-TLS port
  (465, 2465) or TLS for a STARTTLS port (587, 2587, 25) used to leave the test hanging until
  it timed out with a generic message, with nothing reaching the mail provider. Admin > Email
  now keeps port and connection security together, warns about a mismatch, and every failed
  delivery says which server and mode it tried, the real error and, for a mismatch, the fix.
  A server that never answers is reported after 25 seconds. New tests run the real SMTP
  transport against a fake STARTTLS / implicit-TLS server with `AUTH PLAIN`/`LOGIN`.

## [0.2.0] - 2026-10-16

### Changed

- **One access model.** People get access only by being a member of a workspace. Each member
  has one role there and either every base of the workspace (including bases created later) or
  a picked list of bases; owners always have every base. Per-base roles and base-only members
  are gone. A member limited to some bases who creates or duplicates a base gets it on their
  list. `PATCH /api/workspaces/{id}/members/{user_id}` takes `role`, `all_bases` and
  `base_ids`; members carry `all_bases` and `base_ids`; `GET /api/bases/{id}/members` lists the
  workspace members who can open the base (any role may call it); `DELETE` on it takes the base
  off a limited member's list, and `PATCH /api/bases/{id}/members/{user_id}` is removed.
  `GET /api/workspaces` lists only workspaces you are a member of (with `role` always set),
  with `member_count`, `pending_invite_count` and, for each base, `people` (who can open it,
  including pending invites); `GET /api/bases/{id}` adds `people` and `workspace_name`. In
  member listings, callers who are not workspace owners only see the `base_ids` they can open.
- **Invites always join a workspace**, giving every base or a list (`all_bases`, `base_ids`
  on create and in listings). Owners invite from the workspace (every base by default); creators
  invite from a base they can open (that base by default, or other bases they can open; never
  every base, never above their own role). Accepting when already a member adds up the bases
  and keeps the higher role; only an invite whose terms a workspace owner last set without a
  token limited to some bases (from the workspace or from a base) raises an existing member's
  role, so one from a creator or from an owner's base-limited token only adds bases. Upgrading
  (database schema 7) records this on each invite; invites pending at the upgrade only add
  bases for existing members.
  A base-limited API token cannot create an invite to every base or at the owner role. The
  invite page always names the workspace. The MCP tools
  `set_member_role`, `create_invite`, `list_members`, `remove_member` and `list_invites` follow.
- **Upgrading converts existing sharing (database schema 5).** Someone who was only a member of
  individual bases becomes a workspace member limited to those bases, with their highest role
  among them (a single-base owner becomes a creator, because owners always have every base).
  Being a workspace member, they can now see the workspace's member list, and a base-level
  creator or owner becomes a workspace creator, which lets them add new bases to the workspace.
  Bases in the trash (or in a trashed workspace) do not count: access to them goes away, and
  someone who was only on such bases becomes no member at all. Someone who was already a
  workspace member keeps their workspace role on all bases, and **a higher role they were given
  on a single base is dropped** (a workspace viewer who was a creator on one base is now a viewer
  there too). Base invites become workspace invites limited to that base; invites to trashed
  bases are deleted. A snapshot of the old database is written to `backups/` before the upgrade,
  as for every migration.

### Added

- **A first-run intro** to bases, tables, workspaces and the assistant, shown once per account;
  replay it from the profile menu. The setup page is friendlier and no longer asks you to
  confirm the password.
- **A new app shell.** A menu button at the top left opens the sidebar, which you can resize and
  collapse (remembered on each device); on phones it is a drawer. Your profile menu sits at the
  bottom of the sidebar. Home opens the workspace you used last, or offers "Create your first
  workspace".
- **Workspace page** with avatars of who can open each base (dashed for pending invites); on
  phones, Import and New base float at the bottom. A **Members page** sets each member's role
  and the bases they can open.
- **One Share dialog** with two tabs: Invite people and Share a view.
- New bases start empty, with "Create your first table". Tables and their views live in the
  sidebar; the table tabs and the views panel are gone.
- **Inbox** at the top of every sidebar replaces the bell in the header: an unread count, and a
  panel beside the sidebar with your notifications and "Mark all as read". On phones the menu
  button shows a dot while something is unread.
- **Search everything** in the top bar (Ctrl+K or ⌘K) finds workspaces, bases, tables, views and
  records in everything you can open; on phones it is a search button.
- **The sidebar lists your workspaces as a tree.** Each workspace opens into Bases, Members, Trash
  and (for owners) Settings; account settings moved to the profile menu.
- **Inside a base**, the header reads "Workspace ⌄ / Base ⌄": both are menus, and the base menu
  starts with "Workspace home" and holds Rename base and Change icon. Each base's colour tints
  its tile and its Add button; workspaces have solid tiles in their colour.
- **The view toolbar is one row**: the table and view picker, Filter, Sort, Group and Hide fields
  (each tinted and labelled when in use, such as "Sorted by Who"), the view's own setting, a More
  menu (Color, Row height, Download CSV and per-view options), search and Add. Counts read
  "N items".
- **Every view type is redrawn**: the grid sits in a card; kanban stacks end with "+ Add" and their
  count; the calendar has its own header with a Month | Week | List switch and a foldable
  Unscheduled column; the timeline shows one row per record with a fixed name column; the list
  folds its groups; the form builder shows its settings beside a live preview. Kanban, calendar
  and timeline ask for their field on a full "choose a field" screen.
- **One Trash page** lists everything you can restore, from every workspace, with workspace, base
  and type filters, who deleted each item and how many days are left. The Trash links in a
  workspace and in a base open it filtered to them; the trash dialog inside a base is gone.
- **Members** shows each person's bases and role in one row, and pending invites can be changed
  in place. Faces are solid circles in each person's colour, with the leftmost face on top.
- `POST /api/workspaces/{id}/bases` accepts `empty: true` to create a base without tables;
  without it a base still starts with "Table 1".
- `intro_seen` on the signed-in user (`GET /api/auth/me`), set with `PATCH /api/auth/me`;
  everyone, including existing accounts after the upgrade, starts with `false`.
- **Workspace colours** from the same palette as bases. `color` on workspaces
  (`GET /api/workspaces`), accepted by `POST /api/workspaces` and `PATCH /api/workspaces/{id}`;
  a new workspace gets the first of green, blue, gray, purple, orange, teal, pink and yellow that
  none of your workspaces uses yet. `GET /api/bases/{id}` adds `workspace_color` and the invite
  preview `target_color`. Upgrading (database schema 6) colours existing workspaces in that order,
  oldest first, per person who created them.
- **One trash for everything.** `GET /api/trash` lists everything you could restore from every
  workspace you belong to, newest first, optionally filtered by `workspace_id`, `base_id` and
  `kind`; editors and viewers now find their own deleted personal views there (not through a
  read-only token, which cannot restore them). Trash items say
  where they were (`workspace_name`, `workspace_color`, `base_name`, `base_icon`, `base_color`,
  `table_name`), who deleted them (`deleted_by_id`, `deleted_by_name`) and when they are removed
  for good (`expires_at`); the existing trash listings carry the same fields. Who deleted
  something is recorded from this version on, so older items show no one.
- **Search everything.** `GET /api/search?q=` finds workspaces, bases, tables and views by name
  and records by the text of their primary field and their text, email, URL and phone fields,
  in everything you can open (`limit`, default 20, at most 50). Names come first, and text that
  starts with what you typed before text that contains it; a record found by another field
  carries a `snippet` of it. Record text is read up to a fixed budget per search (about one full
  table), so on very large instances some tables may not be searched.
- **Change a pending invite** without sending a new link: `PATCH /api/invites/{id}` takes `role`,
  `all_bases` and `base_ids` (each optional) and answers the updated invite. You need to be able
  to revoke the invite and to create one with the new terms (the same rules, including for
  base-limited API tokens); whoever changes it counts as its inviter from then on, so an invite
  changed by a creator never raises an existing member's role when accepted. Recorded in the audit
  log as `invite_update`. An invite that is no longer valid because of who made it (they were
  removed, demoted or lost a base) answers 409 like a used or expired one, and is left out of
  `GET /api/workspaces/{id}/invites` and `GET /api/bases/{id}/invites`. A creator changing only
  the role drops the trashed bases on the invite that they could not open.
- Each base in `GET /api/workspaces` lists its live `tables` (`id`, `name`, `icon`) in sidebar
  order, so the workspace page no longer loads every base to name its tables.

### Fixed

- Phones: tapping a text field no longer zooms the page in on iOS (form fields are 16px on touch
  screens and narrow windows), and the base's top bar no longer makes the page wider than a small
  phone. Buttons, menu items and the view list are larger on touch screens, the view options button
  is always visible there, and the expanded record scrolls as one column below tablet width.
- Phones: the icon picker opens as a bottom sheet that fits the visible screen and shrinks above the
  on-screen keyboard instead of running off the top, and the keyboard only opens when you tap the
  search box. A tap outside now closes it on iPhone, also when it was opened from the
  create/rename dialog, which stays open.

## [0.1.0] - 2026-10-13

First release. OpenBase is a self-hosted alternative to Airtable for individuals and very
small businesses, in one Rust binary with the web client embedded and a SQLite database.

### Added

- Accounts and administration: first-run setup (the first account is the administrator),
  invite-only or open sign-up, session management, password reset, passkey (WebAuthn)
  sign-in, TOTP two-factor authentication, profiles with time zones, personal access tokens,
  admin pages for users, outgoing email (SMTP), instance stats, the audit log and backups.
- Workspaces with five roles (owner, creator, editor, commenter, viewer), per-base sharing,
  invites by link or email, read-only view share links and public form links.
- Bases, tables and 28 field types, including linked records, formulas (Airtable-compatible
  syntax and function list), lookups, rollups, attachments with thumbnails and autonumber.
- Records: batch create, edit, delete and restore, comments with @mentions, per-record
  history, copy and paste, fill handle, undo and redo, search and a 30-day trash.
- Views: grid, form, gallery, kanban, calendar, timeline and list, each with nested filters,
  sorts, grouping, field layout, summaries and CSV export.
- Live collaboration over Server-Sent Events.
- Automations: record, form, schedule (cron) and webhook triggers; create-record,
  update-record, email, HTTP-request (with SSRF protection) and notification actions.
- An Airtable-compatible REST API under `/api/v1` and an MCP server at `/mcp` (about 70
  tools) with built-in OAuth 2.1 sign-in for AI assistants such as Claude and ChatGPT.
- CSV import and export.
- Operations: daily automatic backups with retention, `openbase backup` and `openbase restore`,
  an automatic database snapshot before every schema migration, a health endpoint
  (`/api/health`, which also reports the version) and `openbase healthcheck`.
- Deployment: a container image, a docker-compose stack with Caddy for automatic HTTPS, and a
  hardened systemd unit.

## [0.1.0-rc.2] - 2026-10-13

Second release candidate for OpenBase 0.1.0. It replaces 0.1.0-rc.1, whose release build
stopped at the end-to-end test gate and published nothing. It contains everything listed under
0.1.0 below. Not recommended for production use yet.

### Fixed

- Grid: right after "Add record", a delayed selection of the new row could move the selection
  under your next click, which then opened a cell editor or sent your typing to the button.

### Changed

- The release build now refuses to publish when any end-to-end test only passes on a retry.
- `scripts/release.sh` writes changelog links only to tags that exist and refuses to cut a
  release without notes under Unreleased.

## [0.1.0-rc.1] - 2026-10-13

### Added

- Release candidate for OpenBase 0.1.0, published to test the release pipeline end to end
  (native amd64 and arm64 builds, the `ghcr.io/lukewilson2002/openbase` image with provenance
  and SBOM attestations, and Linux binaries with checksums). It contains everything listed
  under 0.1.0 below. Not recommended for production use yet.

[Unreleased]: https://github.com/lukewilson2002/openbase/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/lukewilson2002/openbase/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/lukewilson2002/openbase/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lukewilson2002/openbase/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lukewilson2002/openbase/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lukewilson2002/openbase/compare/v0.1.0-rc.2...v0.1.0
[0.1.0-rc.2]: https://github.com/lukewilson2002/openbase/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/lukewilson2002/openbase/releases/tag/v0.1.0-rc.1
