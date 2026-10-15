# Changelog

All notable changes to OpenBase are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the major version is 0, a new minor
version (0.2.0) may contain breaking changes; read its notes before upgrading.

Releases are published from [GitHub Releases](https://github.com/lukewilson2002/openbase/releases)
(see [docs/releasing.md](docs/releasing.md)). Write changes under **Unreleased** as you go;
`scripts/release.sh X.Y.Z` turns that section into the release's.

## [Unreleased]

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

[Unreleased]: https://github.com/lukewilson2002/openbase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lukewilson2002/openbase/compare/v0.1.0-rc.2...v0.1.0
[0.1.0-rc.2]: https://github.com/lukewilson2002/openbase/compare/v0.1.0-rc.1...v0.1.0-rc.2
[0.1.0-rc.1]: https://github.com/lukewilson2002/openbase/releases/tag/v0.1.0-rc.1
