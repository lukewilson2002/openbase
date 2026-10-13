# OpenGrid

OpenGrid is a self-hosted alternative to Airtable for individuals and small
businesses. It is one Rust binary with an embedded web app and a SQLite
database, and it is built to run well on a $4–6/month VPS.

- **One process, one data directory.** The database (`opengrid.db`),
  uploaded files (`attachments/`) and backups (`backups/`) all live in a
  single directory. You don't need Postgres or Redis, and the Docker image
  and release binary don't need Node either.
- **Rust server, embedded web app.** The axum + SQLite server is written in
  Rust. The React + TypeScript web client (built with Vite) is compiled into
  the binary at build time, so a deployment is still one file.
- **No paid tier.** There are no license keys and no feature flags. Dual
  licensed MIT OR Apache-2.0.

> **Status:** under active development. This README describes what v1
> includes. The scale numbers below are targets and are still being verified.

## Features

**Accounts and admin.** First-run setup (the first user becomes admin).
Invite-only or open signup. Sessions you can list and revoke. Password
change and password reset, by email when SMTP is configured, otherwise
through an admin reset link or `opengrid reset-password`. TOTP two-factor
auth, profiles with time zones, and personal access tokens (read or write,
optionally limited to some bases). Admin pages cover users, instance stats,
the audit log, and backups (list, create now, download).

**Workspaces and sharing.** Workspaces with five roles: owner, creator,
editor, commenter and viewer. Invites by link, or by email if SMTP is set
up. Sharing per base: your effective role is the higher of your workspace
role and your base role. Read-only view share links (optional password) and
public form links.

**Bases, tables and fields.** 28 field types: single line text, long text
(plain or Markdown), number, currency, percent, duration, rating, checkbox,
single and multiple select, date (optional time, formats, time zones),
email, URL, phone, attachment (with thumbnails), link to another record
(paired both ways), user, formula, lookup, rollup, count, created/last
modified time, created/last modified by, autonumber, barcode and button.
Fields support descriptions and defaults. Changing a field's type converts
its data. You can change the primary field. Deleted fields can be restored.

**Formulas.** Airtable-compatible syntax and the full Airtable function list.
That includes date formatting and arithmetic, time zones, `WORKDAY` and
regex functions.

**Records.** Create, edit, delete and restore records, in batches. Manual
ordering, an expanded record view, duplicating, comments with @mentions,
per-record revision history, attachments, copy/paste of ranges, a fill
handle, undo/redo and search.

**Views.** Grid, form, gallery, kanban, calendar, timeline (with swimlanes
and Gantt-style dependency arrows) and list. Every view supports nested
filters, sorts, up to three grouping levels, hidden/reordered/resized
fields, frozen columns, row height, row colouring, summary bar
aggregations, personal and locked views, and CSV export.

**Live collaboration.** Changes appear in other open tabs within moments,
via Server-Sent Events. If two people edit the same cell, the last write
wins, and record history keeps both versions.

**Automations.** Triggers: record created, record updated, record matches
conditions, form submitted, schedule (cron) and incoming webhook. Actions:
create record, update record, send email, HTTP request (with SSRF
protection) and in-app notification. Runs are logged and retried.

**API.** An Airtable-compatible REST API under `/api/v1`. Existing Airtable
clients and n8n/Make/Zapier HTTP steps work once you change the base URL;
see [docs/api.md](docs/api.md) for what is supported and how it differs from
Airtable.

**Operations.** CSV import and export. Daily automatic backups with
retention. `opengrid backup` and `opengrid restore` commands. An automatic
database snapshot before every schema upgrade. A trash that keeps deleted
items for 30 days. Record history retention, a health endpoint, a Docker
image, docker-compose with Caddy for automatic HTTPS, and a systemd unit.

## What is deliberately not included

| Not included | Why |
|---|---|
| Interface designer (dashboards, page builder, portals) | It would be a second app-builder product and roughly double the frontend work. Views, forms and share links cover what small businesses need. |
| Extensions, scripting, "run script" automation action | Running user JavaScript safely needs an embedded sandboxed JS engine, which costs too much memory, security risk and maintenance. Use the HTTP-request action or the API instead. |
| AI features | They depend on external paid model APIs. Use the REST API to connect your own AI tools. |
| Sync and vendor integrations (Slack, Gmail, Jira, ...) | They depend on outside services and break easily. Webhooks, HTTP requests and SMTP cover most needs. |
| Email-received automation trigger | It would need an inbound mail server. |
| SSO (SAML/OIDC) | Too much setup and support for a deployment of 25 users or fewer. Passwords plus TOTP 2FA are solid. |
| Field- and table-level permissions | Every write path would need an extra check. Five roles plus per-base sharing are enough for small teams. |
| S3 storage, multiple nodes, Postgres | Each adds a moving part. The design is one node, local disk and backups. |
| Excel (.xlsx) and Airtable-base import | CSV covers it, since both Airtable and Excel export CSV. |
| Airtable-style webhooks API | Automations ("record created/updated → HTTP request") cover outbound notifications. |
| Presence avatars and live cursors | Low value, and would need a client-to-server presence channel. |
| Non-English UI | Translations need ongoing maintenance. |
| Native mobile apps, offline mode | The web UI is responsive. |
| Timeline resource planning, Gantt critical path | Complex scheduling math with little value for small businesses. |
| Calendar iCal feed | Left out of v1 to limit scope. It may come later. |

## Quick start

### Docker Compose with automatic HTTPS (recommended)

You need a server with Docker and a domain whose DNS points at it.

```sh
git clone https://github.com/opengrid/opengrid.git
cd opengrid/deploy
cp .env.example .env        # set OPENGRID_DOMAIN=grid.example.com
docker compose up -d --build
```

Open `https://grid.example.com`. The first account you create becomes the
administrator. Caddy gets and renews the TLS certificate automatically.

### Single binary

```sh
# Build from source (requires Rust and Node 24), or download a release binary.
(cd web && npm ci && npm run build)    # produces web/dist, embedded below
cargo build --release --locked -p opengrid

OPENGRID_DATA_DIR=./data ./target/release/opengrid
# Listening on http://127.0.0.1:8080
```

Building from source requires Rust and Node 24. Docker and release-binary
users need neither: the web client is already inside the binary.

Put it behind a reverse proxy that terminates TLS (Caddy, nginx) before
exposing it to the internet. See [docs/self-hosting.md](docs/self-hosting.md)
for a full walkthrough, a systemd unit, backups and upgrades.

### Command line

```
opengrid [serve]                 run the server (default)
opengrid migrate                 apply database migrations and exit
opengrid create-admin --email E --name N    (password from OPENGRID_ADMIN_PASSWORD)
opengrid reset-password --email E           (password from OPENGRID_NEW_PASSWORD)
opengrid disable-2fa --email E              turn off 2FA for a user who lost their device
opengrid backup [--out FILE]     write a backup archive
opengrid restore ARCHIVE [--force]   restore an archive (server must be stopped)
opengrid healthcheck             exit 0 if the server answers /api/health
```

## Configuration

Each option can be set as a command-line flag (`--data-dir`) or as an
environment variable (`OPENGRID_DATA_DIR`).

| Variable | Default | Meaning |
|---|---|---|
| `OPENGRID_DATA_DIR` | `./data` | Directory for the database, attachments and backups. |
| `OPENGRID_BIND` | `127.0.0.1:8080` | Address to listen on. |
| `OPENGRID_PUBLIC_URL` | `http://localhost:8080` | URL users reach OpenGrid at. Used for links in emails and the CSRF Origin check. With `https://`, session cookies are marked Secure. |
| `OPENGRID_OPEN_SIGNUP` | `false` | Let anyone create an account. When false, new users need an invite (the first account is always allowed and becomes admin). |
| `OPENGRID_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` / `X-Forwarded-Proto` from a reverse proxy (the last `X-Forwarded-For` entry is the client address). Enable only if OpenGrid can be reached solely through that proxy; see `docs/security.md`. |
| `OPENGRID_MAX_UPLOAD_MB` | `100` | Maximum size of one uploaded file, in MB. |
| `OPENGRID_BACKUP_HOUR` | `3` | Hour (0–23, server local time, see `TZ`) for the daily automatic backup. `-1` turns automatic backups off. |
| `OPENGRID_BACKUP_KEEP` | `7` | Number of automatic backups to keep. |
| `OPENGRID_TRASH_DAYS` | `30` | Days deleted items stay in the trash. |
| `OPENGRID_HISTORY_DAYS` | `365` | Days of record history to keep (`0` = forever). |
| `OPENGRID_AUDIT_DAYS` | `365` | Days of audit log (logins, password and token changes, invites, admin actions) to keep (`0` = forever). |
| `OPENGRID_EMAIL_PER_USER_HOUR` | `100` | Invite and automation emails one user can cause per hour. |
| `OPENGRID_EMAIL_PER_HOUR` | `500` | Invite and automation emails the whole instance sends per hour on behalf of users. |
| `OPENGRID_SMTP_HOST` | *(unset)* | SMTP server for outgoing email. Email features are off when unset. |
| `OPENGRID_SMTP_PORT` | `587` | SMTP port. |
| `OPENGRID_SMTP_USER` | *(unset)* | SMTP username. |
| `OPENGRID_SMTP_PASSWORD` | *(unset)* | SMTP password. |
| `OPENGRID_SMTP_SECURITY` | `starttls` | `starttls`, `tls` (implicit TLS, usually port 465) or `none` (local relay only). |
| `OPENGRID_SMTP_FROM` | `OpenGrid <opengrid@localhost>` | Sender address. |
| `OPENGRID_ALLOW_PRIVATE_WEBHOOKS` | `false` | Allow automation HTTP requests to private/loopback addresses. Off by default to prevent SSRF. |
| `OPENGRID_LOG_FORMAT` | `pretty` | `pretty` or `json`. |
| `OPENGRID_LOG` | `info,tower_http=info` | Log filter (`tracing` env-filter syntax). |
| `OPENGRID_ADMIN_PASSWORD` | – | Password for `create-admin`. |
| `OPENGRID_NEW_PASSWORD` | – | Password for `reset-password`. |

## Scale

These are **targets for a 1 vCPU / 1 GB VPS and are still being verified.**
A seeded 50,000-record scale test is planned, and these numbers will be
replaced with its measured results.

| | Target |
|---|---|
| Records per table | 50,000 comfortable, 100,000 hard cap |
| Fields per table | 500 (hard limit) |
| Tables per base | 200 (hard limit) |
| Concurrent active users | about 25 |
| Upload size | 100 MB per file (configurable) |
| Grid page fetch (cached) | under 50 ms p95 at 50k rows |
| View re-query after a write | under 1 s at 50k rows |
| Memory (RSS) | under 60 MB idle, under 300 MB under load |

## Development

```sh
scripts/check.sh    # cargo fmt --check, clippy -D warnings, all tests
(cd web && npm ci && npm run build)   # web client, embedded by the server build
```

The server embeds `web/dist` when it is compiled. Without it the server
still builds and runs, and shows a "web client not built" page at `/`.

The design and the reasons behind it are in
[docs/plans/2026-10-12-opengrid.md](docs/plans/2026-10-12-opengrid.md).

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT), at your option.
