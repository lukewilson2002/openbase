<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/openbase-lockup-dark.svg">
    <img src="brand/openbase-lockup.svg" alt="OpenBase" width="320">
  </picture>
</p>

# OpenBase

OpenBase is a self-hosted alternative to Airtable for individuals and very small
businesses: tables, linked records, formulas, grid / kanban / calendar / gallery /
timeline / list / form views, automations, sharing and an Airtable-compatible API.
You run it on a small server you control, and your data stays in one folder.

- **One process, one data directory.** The server is a single Rust program
  (axum + SQLite) with the web app compiled into it. The database
  (`openbase.db`), uploaded files (`attachments/`) and backups (`backups/`) all
  live in one directory. No Postgres, no Redis, no Node at runtime.
- **Built for a small VPS.** Idle, the server uses about 18 MB of memory; a
  50,000-record table stayed under about 105 MB in our tests
  ([measured numbers](#resource-usage-and-scale), taken on a fast laptop, not on a
  $5 VPS).
- **No paid tier.** No license keys, no feature flags. Dual licensed
  MIT OR Apache-2.0.

> **Status:** version 0.1.0, not yet used in production by anyone but its
> authors. Read [what is and is not verified](#resource-usage-and-scale) before
> you rely on the numbers, and keep offsite backups.

## Contents

[Features](#features) · [Not included](#what-is-deliberately-not-included) ·
[Quick start](#quick-start) · [First run](#first-run) ·
[Configuration](#configuration) · [Backups and restore](#backups-and-restore) ·
[Upgrading](#upgrading) · [Resource usage and scale](#resource-usage-and-scale) ·
[Security](#security) · [API](#api) · [Building from source](#building-from-source) ·
[Tests](#running-the-tests) · [Contributing](#contributing-security-and-releases) · [License](#license)

## Features

**Accounts and admin.** First-run setup (the first user becomes admin).
Invite-only or open signup. Sessions you can list and revoke. Password change
and password reset, by email when SMTP is configured, otherwise through an admin
reset link or `openbase reset-password`. Passkey sign-in (Touch ID, Windows Hello,
a phone, a security key or a password manager: no username, no password, and no
two-factor code, because a passkey is verified on the device), TOTP two-factor
authentication, profiles with time zones, and personal access tokens (read or write, optionally
limited to some bases). Admin pages cover users, outgoing email (SMTP settings
and a "Send test email" button, no restart needed), instance stats, the audit log
and backups (list, create now, download).

**Workspaces and sharing.** Workspaces with five roles: owner, creator, editor,
commenter and viewer. Invites by link, or by email if SMTP is set up. Sharing per
base: your effective role is the higher of your workspace role and your base
role. Read-only view share links (optional password) and public form links.

**Bases, tables and fields.** Create, rename, duplicate (with or without
records), delete and restore bases and tables. 28 field types: single line text,
long text (plain or Markdown), number, currency, percent, duration, rating,
checkbox, single and multiple select, date (optional time, formats, time zones),
email, URL, phone, attachment (with thumbnails), link to another record (paired
both ways), user, formula, lookup, rollup, count, created / last modified time,
created / last modified by, autonumber, barcode and button (opens a URL computed
by a formula). Fields support descriptions and defaults. Changing a field's type
converts its data. You can change the primary field. Deleted fields can be
restored.

**Formulas.** Airtable-compatible syntax and the full Airtable function list,
including date formatting and arithmetic, time zones, `WORKDAY` and regex
functions. Formulas, lookups, rollups and counts are stored with the record and
recomputed when their inputs change.

**Records.** Create, edit, delete and restore records, in batches. Manual
ordering, an expanded record view, duplicating, comments with @mentions and
in-app notifications, per-record revision history, attachments, copy and paste of
ranges, a fill handle, undo / redo and search.

**Views.** Grid, form, gallery, kanban, calendar, timeline (with swimlanes and
Gantt-style dependency arrows) and list. Every view supports nested filters,
sorts, up to three grouping levels, hidden / reordered / resized fields, frozen
columns, row height, row colouring, summary-bar aggregations, personal and locked
views, and CSV export.

**Live collaboration.** Changes appear in other open tabs within moments, via
Server-Sent Events. If two people edit the same cell, the last write wins, and
record history keeps both versions.

**Automations.** Triggers: record created, record updated, record matches
conditions, form submitted, schedule (cron) and incoming webhook. Actions: create
record, update record, send email, HTTP request (with SSRF protection) and in-app
notification. `{{...}}` placeholders carry data between steps. Runs are logged and
retried. See [docs/automations.md](docs/automations.md).

**API.** An Airtable-compatible REST API under `/api/v1`. Existing Airtable
clients and n8n / Make / Zapier HTTP steps work once you change the base URL.

**AI agents (MCP).** The server is also an MCP (Model Context Protocol) server at
`/mcp`. An agent that you connect with a personal access token, or by signing in
from its connector screen (Claude, ChatGPT; OAuth is built in), can do everything
you can do in the web app, within the access you give it, so you do not have to use the app
yourself if you would rather not: build bases, tables, all 28 field types and views,
edit records, run formulas, set up automations and public forms, invite people,
import and export CSV, upload files, read history and notifications, and (for
administrators) manage users, email settings and backups. Workspaces, bases and
tables can be given icons. About 70 tools, plus a generic request tool for anything
else. **Account -> AI assistants** shows the address and short steps for Claude, ChatGPT and
other clients, and lists the connected apps you signed in with, each revocable. Passwords (including the SMTP password and
password-reset links), two-factor settings, passkeys, sessions and API tokens stay out of
reach of any token. See [docs/mcp.md](docs/mcp.md).

**Operations.** CSV import and export. Daily automatic backups with retention,
plus `openbase backup` and `openbase restore`. An automatic database snapshot
before a schema upgrade. A trash that keeps deleted items for 30 days. Record
history and audit-log retention. A health endpoint, a Docker image, a
docker-compose file with Caddy for automatic HTTPS, and a systemd unit.

## What is deliberately not included

| Not included | Why |
|---|---|
| Interface designer (dashboards, page builder, portals) | It would be a second app-builder product and roughly double the frontend work. Views, forms and share links cover what small businesses need. |
| Extensions, scripting, "run script" automation action | Running user JavaScript safely needs an embedded sandboxed JS engine, which costs too much memory, security risk and maintenance. Use the HTTP-request action or the API instead. |
| Built-in AI features (chat, generated content) | They depend on external paid model APIs. Bring your own agent instead: the built-in [MCP server](docs/mcp.md) and the REST API let any AI tool do whatever you can do in the app. |
| Sync and vendor integrations (Slack, Gmail, Jira, ...) | They depend on outside services and break easily. Webhooks, HTTP requests and SMTP cover most needs. |
| Email-received automation trigger | It would need an inbound mail server. |
| SSO (SAML / OIDC) | Too much setup and support for a deployment of 25 users or fewer. Passwords, passkeys and TOTP 2FA are solid. |
| Field- and table-level permissions | Every write path would need an extra check. Five roles plus per-base sharing are enough for small teams. |
| S3 storage, multiple nodes, Postgres | Each adds a moving part. The design is one node, local disk and backups. |
| Excel (.xlsx) and Airtable-base import | CSV covers it, since both Airtable and Excel export CSV. |
| Airtable-style webhooks API | Automations ("record created / updated -> HTTP request") cover outbound notifications. |
| Presence avatars and live cursors | Low value, and would need a client-to-server presence channel. |
| Non-English UI | Translations need ongoing maintenance. |
| Native mobile apps, offline mode | The web UI is responsive. |
| Timeline resource planning, Gantt critical path | Complex scheduling math with little value for small businesses. |
| Calendar iCal feed | Left out of v1 to limit scope. It may come later. |
| Conditional lookups and rollups | Left out of v1; ordinary lookups and rollups are included. |

## Quick start

Two supported ways to run it. Both end with OpenBase on `127.0.0.1:8080` or
behind Caddy; **never expose the plain HTTP port to the internet**, because
passwords and session cookies would travel unencrypted.

### Docker Compose with automatic HTTPS (recommended)

You need a server with Docker (Engine and the Compose plugin) and a domain whose
DNS already points at it, with ports 80 and 443 open. This uses the published
image, `ghcr.io/lukewilson2002/openbase`; nothing is compiled on your server.

```sh
git clone https://github.com/lukewilson2002/openbase
cd openbase/deploy
cp .env.example .env        # set OPENBASE_DOMAIN=base.example.com (and TZ)
docker compose up -d
docker compose ps           # openbase should become "healthy"
```

Open `https://base.example.com`. Caddy obtains and renews the certificate
automatically. (The clone is only for the Compose file, the Caddyfile and `.env`; you can
also copy those three files from the [latest release](https://github.com/lukewilson2002/openbase/releases/latest).)

To try the same stack on your own computer without a domain, add the local
override, which serves plain HTTP on `http://localhost:8088`:

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

#### Versions, tags and updates

Images are built only when a [GitHub Release](https://github.com/lukewilson2002/openbase/releases)
is published, never for a plain push to `main`, so you never get an untested build.
`OPENBASE_VERSION` in `deploy/.env` picks what you follow:

| Tag | Means | Moves when |
|---|---|---|
| `latest` (default) | the newest stable release | every stable release |
| `1` | the newest `1.x.y` | a new `1.x` or `1.x.y` release (not before 1.0) |
| `0.1` | the newest `0.1.y` | a new patch release of 0.1 |
| `1.4.2` | exactly that release | never |
| `1.5.0-rc.1` | a pre-release | never (pre-releases get no moving tags) |

While OpenBase is 0.x, a new minor version may contain breaking changes, so there is no `0` tag:
follow `latest` and read the release notes, or pin a minor such as `0.1`.

Nothing updates by itself. To update to what your tag now points at:

```sh
docker compose exec openbase openbase backup    # take a backup first
docker compose pull && docker compose up -d
```

For automatic updates (optional, limited to the `openbase` container, off by default) and for rolling
back, see [docs/self-hosting.md](docs/self-hosting.md#8-upgrading). Images are published for
`linux/amd64` and `linux/arm64`, and carry provenance and SBOM attestations.

To build the image from your own checkout instead (contributors, unreleased changes, other
architectures): `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

### Single binary with systemd

Download `openbase-X.Y.Z-linux-amd64.tar.gz` (or `-arm64`) from the
[releases page](https://github.com/lukewilson2002/openbase/releases/latest) and check it against
`SHA256SUMS` (`sha256sum --check --ignore-missing SHA256SUMS`). The archive holds the binary and
`openbase.service`; the binary needs glibc 2.36 or newer (Debian 12, Ubuntu 22.04 and later). Or
build one yourself (see [Building from source](#building-from-source)). Then follow
[docs/self-hosting.md](docs/self-hosting.md#3-alternative-the-binary-with-systemd)
for the service user, `deploy/openbase.service` and a TLS reverse proxy.

To just try it locally:

```sh
OPENBASE_DATA_DIR=./data ./openbase
# Listening on http://127.0.0.1:8080
```

### First run

Open the site: the first account you create becomes the administrator. Do this
before you share the URL. Afterwards new accounts need an invite unless you set
`OPENBASE_OPEN_SIGNUP=true`. For scripted installs you can create the
administrator on the command line instead:

```sh
read -rs OPENBASE_ADMIN_PASSWORD && export OPENBASE_ADMIN_PASSWORD
openbase create-admin --email you@example.com --name "Your Name"
```

Then add a passkey or turn on two-factor authentication under **Account -> Security**, and set up
offsite backups (below). The full walkthrough, SMTP setup, recovery and
troubleshooting are in [docs/self-hosting.md](docs/self-hosting.md).

### Command line

```
openbase [serve]                           run the server (default)
openbase migrate                           apply database migrations and exit
openbase create-admin --email E --name N   (password from OPENBASE_ADMIN_PASSWORD)
openbase reset-password --email E          (password from OPENBASE_NEW_PASSWORD)
openbase disable-2fa --email E             turn off 2FA for a user who lost their device
openbase oauth-client add|list|remove      OAuth clients added by hand (see docs/mcp.md)
openbase backup [--out FILE]               write a backup archive
openbase restore ARCHIVE [--force]         restore an archive (server must be stopped)
openbase healthcheck                       exit 0 if the server answers /api/health
```

With Docker, run them as `docker compose exec openbase openbase <command>`.

## Configuration

Every option is a command-line flag (`--data-dir`) and an environment variable
(`OPENBASE_DATA_DIR`); `openbase --help` lists them. With Docker Compose put them
in `deploy/.env`; with systemd in `/etc/openbase/openbase.env`.

| Variable | Default | Meaning |
|---|---|---|
| `OPENBASE_DATA_DIR` | `./data` (`/data` in the image) | Directory for the database, attachments and backups. |
| `OPENBASE_BIND` | `127.0.0.1:8080` (`0.0.0.0:8080` in the image) | Address to listen on. |
| `OPENBASE_PUBLIC_URL` | `http://localhost:8080` | URL users reach OpenBase at. Used for links in emails and the CSRF Origin check. With `https://`, session cookies are marked Secure. Must match the browser's address exactly. Passkeys are tied to its host: pick the final domain before people add passkeys, because changing the host makes them unusable (see [Security](docs/security.md#passkeys)). |
| `OPENBASE_OPEN_SIGNUP` | `false` | Let anyone create an account. When false, new users need an invite (the first account is always allowed and becomes admin). |
| `OPENBASE_TRUST_PROXY` | `false` | Take the client address from the last `X-Forwarded-For` entry. Enable only when OpenBase can be reached solely through the reverse proxy that sets it; see [docs/security.md](docs/security.md). The Compose file sets it for you. |
| `OPENBASE_MAX_UPLOAD_MB` | `100` | Maximum size of one uploaded file, in MB. |
| `OPENBASE_BACKUP_HOUR` | `3` | Hour (0-23, server local time, see `TZ`) for the daily automatic backup. `-1` turns automatic backups off. |
| `OPENBASE_BACKUP_KEEP` | `7` | Number of automatic backups to keep. |
| `OPENBASE_TRASH_DAYS` | `30` | Days deleted items stay in the trash. |
| `OPENBASE_HISTORY_DAYS` | `365` | Days of record history to keep (`0` = forever). Attachments mentioned in retained history are kept on disk. |
| `OPENBASE_AUDIT_DAYS` | `365` | Days of audit log (logins, password and token changes, invites, admin actions) to keep (`0` = forever). |
| `OPENBASE_EMAIL_PER_USER_HOUR` | `100` | Invite and automation emails one user can cause per hour. |
| `OPENBASE_EMAIL_PER_HOUR` | `500` | Invite and automation emails the whole instance sends per hour on behalf of users. |
| `OPENBASE_SMTP_HOST` | *(unset)* | SMTP server for outgoing email. Email features are off when no host is set here or on **Admin -> Email**. Do not set the other `OPENBASE_SMTP_*` variables to empty values, leave them out. |
| `OPENBASE_SMTP_PORT` | `587` | SMTP port. |
| `OPENBASE_SMTP_USER` | *(unset)* | SMTP username. |
| `OPENBASE_SMTP_PASSWORD` | *(unset)* | SMTP password. |
| `OPENBASE_SMTP_SECURITY` | `starttls` | `starttls`, `tls` (implicit TLS, usually port 465) or `none` (local relay only). |
| `OPENBASE_SMTP_FROM` | `OpenBase <openbase@localhost>` | Sender address. |
| `OPENBASE_ALLOW_PRIVATE_WEBHOOKS` | `false` | Allow automation HTTP requests to private and loopback addresses. Off by default to prevent SSRF. It does not apply to OAuth client metadata documents. |
| `OPENBASE_V1_RATE_PER_TOKEN` | `5` | Requests per second one API token may make to `/api/v1`; more answer `429`. |
| `OPENBASE_V1_RATE_PER_USER` | `50` | Requests per second all tokens of one user may make to `/api/v1` together. |
| `OPENBASE_MCP_RATE_PER_TOKEN` | `30` | Requests per second one API token may make to the MCP endpoint `/mcp`; more answer `429`. |
| `OPENBASE_MCP_RATE_PER_USER` | `100` | Requests per second all tokens of one user may make to `/mcp` together. |
| `OPENBASE_OAUTH_REGISTRATION` | `true` | Let apps register themselves for the OAuth sign-in of the MCP endpoint. Turn off to allow only apps that publish a client metadata document and clients added with `openbase oauth-client add` (apps that publish a document can still ask a signed-in person for approval). OAuth is served only when `OPENBASE_PUBLIC_URL` is `https://` (or a localhost address). |
| `OPENBASE_OAUTH_CIMD_ALLOW_PRIVATE` | `false` | Development only: fetch OAuth client metadata documents from loopback and private addresses and `http://localhost`, for a client under development on the same machine. Never turn it on in production: any signed-in user could make the server probe your network. |
| `OPENBASE_MCP_ALLOWED_ORIGINS` | *(none)* | Comma separated browser origins, besides the public URL, that may call `/mcp` (for browser-based MCP clients). Requests without an `Origin` header are not affected. |
| `OPENBASE_LOG_FORMAT` | `pretty` | `pretty` or `json`. |
| `OPENBASE_LOG` | `info,tower_http=info` | Log filter (`tracing` env-filter syntax, for example `debug`). Environment variable only. |
| `OPENBASE_ADMIN_PASSWORD` | – | Password for `create-admin`. |
| `OPENBASE_NEW_PASSWORD` | – | Password for `reset-password`. |

`TZ` (not an `OPENBASE_` variable) sets the time zone for `OPENBASE_BACKUP_HOUR`
and for log timestamps.

**Email can also be set up in the app.** An administrator finds the same six SMTP
settings under **Admin -> Email**, with a "Send test email" button that shows the mail
server's own error when delivery fails. Changes apply at once, without a restart, and
are saved in the database (so backups contain them, the SMTP password included). Each
setting that has an `OPENBASE_SMTP_*` variable set **wins over the saved value and is
shown there as read-only ("set by environment")**; settings without a variable stay
editable, so you can fix the host and password in the environment and leave the sender
address to the page. The SMTP password can be typed only by a signed-in person (never by
an API token or an AI agent), is never shown again ("Saved", with Replace and Remove)
and never appears in logs or the audit log. The email limits
(`OPENBASE_EMAIL_PER_USER_HOUR`, `OPENBASE_EMAIL_PER_HOUR`) are shown there but only
changed in the environment. See [docs/self-hosting.md](docs/self-hosting.md#5-email-smtp).

## Backups and restore

- **Automatic.** Every day at `OPENBASE_BACKUP_HOUR` the server writes
  `backups/openbase-auto-<UTC timestamp>.tar.gz` and keeps the newest
  `OPENBASE_BACKUP_KEEP`. If the server was down at that hour, the backup runs as
  soon as it is back up that day (so a brand-new instance writes one at its
  first start after the hour has passed).
- **Manual.** **Admin -> Backups -> Create backup now**, or `openbase backup [--out FILE]`.
  Works while the server is running (the database is copied with SQLite's
  `VACUUM INTO`).
- **What is inside.** `openbase.db`, every attachment, and a `manifest.json`
  (OpenBase version and schema version). Archives are not encrypted and contain
  password hashes.
- **Copy them off the server.** Backups on the same disk do not protect you from
  losing the server. For example, with [rclone](https://rclone.org) (any S3
  storage, Backblaze B2, SFTP, ...), as a root cron entry an hour after the backup
  hour:

  ```cron
  30 4 * * * rclone copy --max-age 48h /var/lib/docker/volumes/deploy_openbase-data/_data/backups b2:my-openbase-backups
  ```

  (`/var/lib/openbase/backups` for a systemd install; use an encrypted remote.)
  The offsite examples were not run against a real remote storage service; check
  that your copy job works and that you can restore from a copy.
- **Restore** (server stopped; the current database is moved aside, not deleted):

  ```sh
  docker compose stop openbase
  docker compose run --rm --no-deps openbase restore /data/backups/openbase-auto-20261012-030000.tar.gz --force
  docker compose start openbase
  ```

  Restoring onto a new server, from a file on the host, and with systemd are
  covered in [docs/self-hosting.md](docs/self-hosting.md#7-restoring-a-backup).
  Try a test restore before you need one.

## Upgrading

Read the [release notes](https://github.com/lukewilson2002/openbase/releases) (and
[CHANGELOG.md](CHANGELOG.md)), take a manual backup and make sure you have a recent offsite copy, then:

```sh
cd openbase/deploy
docker compose exec openbase openbase backup
docker compose pull && docker compose up -d
```

(Built from source instead? `git pull` and `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
systemd: replace `/usr/local/bin/openbase` with the new release binary and `systemctl restart openbase`.)
`openbase --version` and `/api/health` tell you which version is running.
When a new version changes the database schema, OpenBase first writes a
pre-migration snapshot (`backups/pre-migration-v<old>-<timestamp>.db`) and refuses
to start if it cannot. It never opens a database written by a newer version.
Rolling back means running the previous version again (pin `OPENBASE_VERSION=<previous release>`)
and restoring your pre-upgrade backup. Details, and the optional automatic updates, in
[docs/self-hosting.md](docs/self-hosting.md#8-upgrading).

## Resource usage and scale

**Where these numbers come from.** Everything below was measured on one machine:
an **Apple M3 Max laptop (16 cores, 64 GB RAM, macOS 27.0.1, arm64)**, with
Docker Desktop's Linux VM (16 CPUs, 23 GiB). That is far faster than a $4-6 VPS,
so **treat absolute times as best case; they have not been measured on a 1 vCPU /
1 GB VPS.** The methodology is in the scripts named in each row, so you can repeat
it on your own server.

### Limits

| | Limit | Status |
|---|---|---|
| Records per table | 50,000 comfortable, 100,000 hard cap | 50,000 measured; the 100,000 cap is enforced but not benchmarked |
| Fields per table | 500 | enforced |
| Tables per base | 200 | enforced |
| Upload size | 100 MB per file (`OPENBASE_MAX_UPLOAD_MB`) | enforced |
| CSV import | 100,000 rows, 20 MB, 3,000,000 cells | enforced |
| Concurrent active users | about 25 | design target, not load-tested |

### Measured: size and memory

| | Measured |
|---|---|
| Release binary (web client embedded), macOS arm64 | 26.1 MB |
| Docker image, linux/arm64 | 184 MB on disk, 41.5 MB compressed; the binary in it is 25.3 MB |
| Server idle, release binary, right after start (RSS) | 17.6 MB |
| Container idle (`/proc` RSS of the server / `docker stats`) | 19.9 MB / 6.4 MiB (`docker stats` leaves out page cache) |
| After the first password sign-in (a password hash uses 19 MiB while it runs) | 38 MB on macOS; 18 MB in the Linux container |
| 50,000-record table loaded through the API, 11 fields incl. a formula | 58 MB |
| ...after fetching the first page of that table | 77 MB |
| ...after a sorted query, a write and 8 simultaneous cold searches | 104 MB |
| Same load in a container limited to 1 CPU and 1 GB | 101 MB peak RSS |

(`scripts/smoke-install.sh` with `SEED_RECORDS=50000`, which runs
`scripts/loadtest.sh`; the container run used `docker run --cpus=1 --memory=1g`.
The macOS binary and idle rows were re-measured on 2026-10-13 after OAuth and passkeys were added
(passkeys bring in `webauthn-rs` and its pure-Rust crypto: no OpenSSL); the Docker image rows are
from the build after the rename, before those two, and the 50,000-record rows are from before the
rename; neither was repeated. Sizes are in MB of 10^6 bytes.)

### Measured: speed at 50,000 records

From the in-process scale test (`cargo test -p openbase --release --test scale --
--ignored --nocapture`, three runs; 50,000 orders with 11 fields incl. a link, a
lookup and a formula, plus 1,000 customers):

| | Result |
|---|---|
| Seeding through the write engine | 3.0-3.2 s |
| Cold query (filter + 2 sorts), 18,006 matches | 91-96 ms |
| Page of 100 rows, cached | p50 1.1-1.2 ms, p95 1.2-1.4 ms |
| The same query right after a single write | 90-101 ms |
| Summary bar (4 aggregations) | 82-86 ms |
| Cold search over all fields | 163-174 ms |
| Cold grouped query | 107-114 ms |
| Test process memory | 146-149 MB resident (includes the seeding data) |

The recompute test (`--test recompute_perf`, 5,000 customers and 50,000 linked
orders): editing one order's price, which updates a formula and a rollup, takes
0.7 ms; editing an unrelated cell 0.2 ms; linking 10,000 orders to one customer
takes about 1 s; editing a value that 10,000 orders look up takes about 0.5 s.

Over HTTP against the release server (`scripts/loadtest.sh`): inserting 50,000
records in batches of 1,000 took 2-3 s; the first page of 100 rows 65-70 ms; a
deep page of a text sort 83-93 ms cold and 1 ms cached; the same page right after
a one-record write 83-98 ms. With the container limited to **one CPU**
(`--cpus=1`), those were 86 ms, 94 ms and 98 ms, and eight simultaneous cold
searches finished in 1.6 s (0.6 s unrestricted). A CPU quota on a fast core is
not the same as a slow 1 vCPU host: expect a real $5 VPS to be slower by a factor
we have not measured.

### Against the design targets

| Target (1 vCPU / 1 GB VPS) | Result on the laptop |
|---|---|
| Grid page fetch (cached), p95 under 50 ms at 50k rows | met (1.4 ms) |
| View re-query after a write, under 1 s at 50k rows | met (about 0.1 s) |
| Memory, under 60 MB idle | met (18 MB) |
| Memory, under 300 MB under load at 50k rows | met (at most 104 MB over HTTP) |

Not measured: a real 1 vCPU VPS, 100,000-record tables, 25 simultaneous users,
upload-heavy workloads, long-running memory growth, or the speed of an amd64 build (the
amd64 image does build and passes `scripts/smoke-docker.sh`, run under emulation on an arm64
laptop; its size and memory were not measured). The systemd unit passes `systemd-analyze verify` but has not been run on a real systemd
host. The container build and the full install / backup / restore lifecycle were
run end to end on the laptop (`scripts/smoke-docker.sh`, `scripts/smoke-install.sh`).

Disk: the 50,000-record test database with 11 fields compressed to a 5.7 MB
backup archive. Each backup holds the database **and every attachment**, so
with the default `OPENBASE_BACKUP_KEEP=7` plan for roughly eight times your
database plus attachments.

## Security

OpenBase is designed to face the internet behind HTTPS: invite-only sign-up by
default, Argon2id passwords, optional passkeys and TOTP 2FA, revocable sessions and tokens, CSRF
protection, per-role access checks on every route, rate limits on every
unauthenticated surface, and SSRF protection for automation HTTP requests. The
threat model, every limit, the administrator checklist and the accepted risks are
in [docs/security.md](docs/security.md). Read the checklist before going live.

## API

The Airtable-compatible API lives under `/api/v1` and takes personal access
tokens (create one under **Account -> Tokens**):

```sh
curl -H "Authorization: Bearer $TOKEN" https://base.example.com/api/v1/meta/bases
```

[docs/api.md](docs/api.md) lists what is supported and how it differs from
Airtable. Automation triggers, actions, templates and webhooks are in
[docs/automations.md](docs/automations.md). To let an AI assistant do the work
instead of you, see [docs/mcp.md](docs/mcp.md) (setup per client, every tool, the
scope and security model).

## Building from source

You need Rust (the version in `rust-toolchain.toml`, stable) and Node 24. The
server embeds `web/dist` when it is compiled, so build the web client first:

```sh
(cd web && npm ci && npm run build)       # produces web/dist
cargo build --release --locked -p openbase
./target/release/openbase --help
```

Or build the container image from the checkout (no Rust or Node needed on the host):
`docker build -f deploy/Dockerfile -t openbase:local .`

Without `web/dist` the server still builds and runs, and shows a "web client not
built" page at `/`. Docker users need neither Rust nor Node: `deploy/Dockerfile`
builds both inside the image. The web client is described in
[web/README.md](web/README.md), the design in
[docs/plans/2026-10-12-openbase.md](docs/plans/2026-10-12-openbase.md).

## Running the tests

```sh
(cd web && npm ci --ignore-scripts)    # once
scripts/check.sh                       # rustfmt, clippy -D warnings, cargo test, generated types,
                                       # tsc, Vitest, production build, live API contract tests
OPENBASE_E2E=1 scripts/check.sh        # the same plus the Playwright end-to-end tests
```

The end-to-end tests drive the real server in Google Chrome (installed Chrome via
Playwright's `chrome` channel; no browser download) and take a minute or two.
Other scripts:

| Script | What it does |
|---|---|
| `scripts/gen-types.sh [--check]` | Regenerates (or verifies) the TypeScript types generated from the Rust DTOs. |
| `scripts/gen-brand.sh [--check]` | Copies the favicon, touch and manifest icons from `brand/` into `web/public/` and regenerates the inline logo path data (`web/src/components/brandMarks.ts`). |
| `scripts/smoke-install.sh [binary]` | Fresh-install walkthrough of the release binary: migrate, create-admin, serve, log in, create data, backup, restore elsewhere, reset-password, healthcheck. `SEED_RECORDS=50000` adds the load test. |
| `scripts/smoke-docker.sh [image]` | The same for the container image: health check, first-run signup, persistence across restarts, backup inside the container, image size and idle memory. |
| `scripts/loadtest.sh` | Loads N records into a running instance over HTTP and times the common reads. |
| `scripts/release.sh X.Y.Z` | Maintainer only: bumps the version, writes the changelog section, runs the checks, commits and tags. Pushes and publishes nothing ([docs/releasing.md](docs/releasing.md)). |
| `scripts/release-info.sh vX.Y.Z` | Checks a tag against the versions in the tree and prints the image tags a release would get. Used by the release workflow. |

GitHub Actions runs the same checks (plus the end-to-end tests) on every pull request and push to
`main` (`.github/workflows/ci.yml`). It never publishes anything; only publishing a GitHub Release does.

## Contributing, security and releases

[CONTRIBUTING.md](CONTRIBUTING.md) explains how to run the checks and how a release is made;
[SECURITY.md](SECURITY.md) says how to report a vulnerability privately; the maintainer's release
procedure is in [docs/releasing.md](docs/releasing.md).

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or
[MIT license](LICENSE-MIT), at your option.
