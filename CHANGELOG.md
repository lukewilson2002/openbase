# Changelog

All notable changes to OpenBase are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the major version is 0, a new minor
version (0.2.0) may contain breaking changes; read its notes before upgrading.

Releases are published from [GitHub Releases](https://github.com/lukewilson2002/openbase/releases)
(see [docs/releasing.md](docs/releasing.md)). Write changes under **Unreleased** as you go;
`scripts/release.sh X.Y.Z` turns that section into the release's.

## [Unreleased]

## [0.1.0] - unreleased

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

[Unreleased]: https://github.com/lukewilson2002/openbase/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lukewilson2002/openbase/releases/tag/v0.1.0
