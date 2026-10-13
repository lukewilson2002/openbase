# Self-hosting OpenBase

This guide takes a fresh VPS to a running OpenBase with HTTPS, backups
(including offsite copies), upgrades and recovery. Every setting is
described in the [README](../README.md#configuration).

## 1. Choosing a server

OpenBase is one process that uses SQLite, so a small VPS is enough.

| Team size | Suggested VPS | Notes |
|---|---|---|
| 1-10 people, up to ~20k records per table | 1 vCPU, 1 GB RAM, 20 GB disk | The $4-6/month tier at most providers. |
| 10-25 people, up to ~50k records per table | 1-2 vCPU, 2 GB RAM | Leaves headroom for Caddy and large imports. |

These are suggestions, not tested configurations. What has been measured (on a
fast laptop, not a VPS; see [Resource usage](../README.md#resource-usage-and-scale)):
the server idles at about 16-20 MB and stayed at or under about 105 MB with a
50,000-record, 11-field table, and the Docker image is about 184 MB on disk. The
systemd unit caps memory at 400 MB.

Disk usage is roughly the database (a 50,000-record test table with 11 fields
produced a 5.7 MB backup archive; usually tens of MB) plus your attachments plus
your backups. Each backup archive holds the whole database **and every
attachment**, so with `OPENBASE_BACKUP_KEEP=7` you need room for about 8x
(database + attachments). The server does not check free disk space: keep an eye
on it, especially if you store many large files.

Use any 64-bit Linux with Docker (the image is built for the architecture of the
machine that builds it; it was tested as linux/arm64 and the Dockerfile has no
architecture-specific steps, but an amd64 build was not run). Open ports 80 and
443 in your firewall; OpenBase itself is never exposed directly.

## 2. Docker Compose with Caddy (recommended)

Caddy terminates HTTPS and gets and renews a Let's Encrypt certificate
automatically. OpenBase listens only on the internal Docker network.

1. Point DNS for your domain (for example `base.example.com`) at the
   server: an `A` record, plus `AAAA` if you use IPv6. Wait until
   `dig +short base.example.com` returns the server's IP.
2. Install Docker Engine and the Compose plugin
   (https://docs.docker.com/engine/install/).
3. Get the code and configure it:

   ```sh
   git clone <repository-url> openbase
   cd openbase/deploy
   cp .env.example .env
   nano .env            # set OPENBASE_DOMAIN, TZ and optionally SMTP
   ```

4. Build and start:

   ```sh
   docker compose up -d --build
   docker compose ps        # openbase should become "healthy"
   docker compose logs -f   # Ctrl-C to stop following
   ```

5. Open `https://base.example.com` and continue with
   [first run](#4-first-run-create-the-administrator).

What runs where:

- `openbase` uses the image built from `deploy/Dockerfile`: a Node 24 stage builds
  the web client, a `rust:1-bookworm` stage builds the server with the client
  embedded, and the final stage is `debian:bookworm-slim` with only the binary,
  CA certificates and time zone data. It runs as the unprivileged user
  `openbase` (uid 10001), keeps its data in the `openbase-data` volume (mounted at
  `/data`), and has a built-in health check (`openbase healthcheck`, every 30 s).
- `caddy` uses the official `caddy:2` image configured by
  `deploy/Caddyfile`. Certificates are stored in the `caddy-data` volume. It
  forwards Server-Sent Events without buffering, so live updates work.
- `OPENBASE_TRUST_PROXY=true` and `OPENBASE_PUBLIC_URL=https://<domain>`
  are set for you in `docker-compose.yml`. Nothing but Caddy can reach the
  `openbase` container (its port is not published).
- Everything in `deploy/.env` is passed to the `openbase` container, so any
  `OPENBASE_*` option from the [README](../README.md#configuration) works there.

The Compose file, the image build, first-run signup, data surviving
`docker compose restart` / a re-created container, `openbase backup` and the
restore procedure below were all run end to end. A real Let's Encrypt
certificate could not be: it needs a public domain, so that step is untested here.

### Trying the stack locally (no domain, no certificate)

Caddy cannot get a public certificate for `localhost`, so `deploy/docker-compose.local.yml`
overrides three things: the site address becomes `http://localhost` (Caddy then serves
plain HTTP and skips certificates), the published port becomes `127.0.0.1:8088`, and
`OPENBASE_PUBLIC_URL` becomes `http://localhost:8088`.

```sh
cd openbase/deploy
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
open http://localhost:8088       # first account becomes the administrator
docker compose -f docker-compose.yml -f docker-compose.local.yml down -v   # removes the volumes too
```

Use this only on your own machine: there is no TLS. `docker compose config` accepts
both files together with the shipped `.env.example`.

Run CLI commands inside the container like this:

```sh
docker compose exec openbase openbase --help
```

## 3. Alternative: the binary with systemd

1. Build the binary (needs Rust and Node 24):

   ```sh
   (cd web && npm ci --ignore-scripts && npm run build)
   cargo build --release --locked -p openbase
   ```

   Or copy a release binary to the server.

2. Install the binary, create a user and install the unit:

   ```sh
   sudo install -m 0755 target/release/openbase /usr/local/bin/openbase
   sudo useradd --system --home-dir /var/lib/openbase --shell /usr/sbin/nologin openbase
   sudo install -m 0644 deploy/openbase.service /etc/systemd/system/openbase.service
   sudo install -d -m 0750 -o root -g openbase /etc/openbase
   sudo tee /etc/openbase/openbase.env >/dev/null <<'EOF'
   OPENBASE_PUBLIC_URL=https://base.example.com
   OPENBASE_TRUST_PROXY=true
   TZ=Europe/Berlin
   EOF
   sudo chmod 0640 /etc/openbase/openbase.env
   sudo chgrp openbase /etc/openbase/openbase.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now openbase
   systemctl status openbase
   ```

   The unit stores data in `/var/lib/openbase` and listens on
   `127.0.0.1:8080`. It is hardened with `ProtectSystem=strict`,
   `NoNewPrivileges`, `PrivateTmp`, a system-call filter and
   `MemoryMax=400M`. The unit file passes `systemd-analyze verify` (checked in a
   Debian 12 container); it has not been started under a real systemd host, so
   if a hardening option does not suit your distribution, loosen it and tell us.

3. Put a TLS reverse proxy in front. With Caddy installed from your
   distribution, `/etc/caddy/Caddyfile` only needs:

   ```
   base.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

Run CLI commands as the service user so file ownership stays correct:

```sh
sudo -u openbase env OPENBASE_DATA_DIR=/var/lib/openbase openbase --help
```

## 4. First run: create the administrator

The first account created through the sign-up page becomes the
administrator. Do this right after the first start, before you share the
URL. Afterwards, new accounts need an invite unless
`OPENBASE_OPEN_SIGNUP=true`.

You can also create an administrator from the command line (for example
for automated installs). The password is read from an environment variable
so it does not end up in your shell history or the process list:

```sh
read -rs OPENBASE_ADMIN_PASSWORD && export OPENBASE_ADMIN_PASSWORD
docker compose exec -e OPENBASE_ADMIN_PASSWORD openbase \
    openbase create-admin --email you@example.com --name "Your Name"
unset OPENBASE_ADMIN_PASSWORD
```

Then turn on two-factor authentication for the admin account under
**Account → Security**.

## 5. Email (SMTP)

Email is optional. Without it, invites and password-reset links are shown
to the admin to pass on by hand. There are two ways to turn it on, and you
can mix them.

**In the app (no restart).** Sign in as an administrator, open
**Admin → Email**, fill in host, port, connection security (`starttls` for
port 587, `tls` for 465, `none` only for a relay on the same machine or
network), username, password and the sender address, and press **Save
changes**. It takes effect immediately. Press **Send test email** (to your
own address, or another one you type) to check it: if delivery fails, the
page shows the real error from the mail server or the connection ("Connection
refused", "authentication failed", ...), so you can fix it before an invitation
goes missing. The settings are stored in the database, so they are in your
backups (the password included: protect backups as you protect the database).
The password is write-only: the page shows "Saved" with **Replace** and
**Remove**, and leaving the field empty keeps the saved one.

**In the environment.** Set these in `deploy/.env` (or
`/etc/openbase/openbase.env`) and restart:

```sh
OPENBASE_SMTP_HOST=smtp.example.com
OPENBASE_SMTP_PORT=587
OPENBASE_SMTP_SECURITY=starttls     # or tls for port 465
OPENBASE_SMTP_USER=openbase@example.com
OPENBASE_SMTP_PASSWORD=app-password
OPENBASE_SMTP_FROM=OpenBase <openbase@example.com>
```

Leave the `OPENBASE_SMTP_*` lines out entirely (or commented out) to leave
the setting to the page. Don't set them to empty values. **A variable that is
set always wins, field by field**: the page shows that field as read-only
("set by environment"), and a change attempted through the API is refused with
the name of the variable. So you can, for example, keep the host and the
password in the environment (out of the database) and still let an
administrator change the sender address on the page. Remove the variable and
restart to manage that field on the page again. The limits on how many
invitation and automation emails go out per hour
(`OPENBASE_EMAIL_PER_USER_HOUR`, `OPENBASE_EMAIL_PER_HOUR`) are shown on the
page but can only be changed in the environment. Any transactional email
provider works (Postmark, Mailgun, Amazon SES, Fastmail, a Google
Workspace app password, ...). Many VPS providers block outgoing port 25,
so use 587 or 465. Configure SPF/DKIM for the sender domain, or invites
will end up in spam.

## 6. Backups

A backup archive (`.tar.gz`) holds:

- `openbase.db`, a consistent snapshot of the database taken with SQLite
  `VACUUM INTO` while the server keeps running;
- `attachments/`, every uploaded file and thumbnail;
- `manifest.json`, with the OpenBase version, the schema version and the
  creation time.

Backups are written to `<data dir>/backups/` under a temporary name and
renamed when complete, so a crash never leaves a half-written archive that
looks valid.

### Automatic daily backups

Every day at `OPENBASE_BACKUP_HOUR` (default `3`, server local time, so set
`TZ`) the server writes `openbase-auto-YYYYmmdd-HHMMSS.tar.gz` (the
timestamp in the name is UTC). It keeps the newest `OPENBASE_BACKUP_KEEP`
(default 7) automatic backups and deletes older ones. Manual backups and
pre-migration snapshots are never deleted automatically. If the server was
down at the scheduled hour, the backup runs as soon as it is back up that
day. Set `OPENBASE_BACKUP_HOUR=-1` to turn automatic backups off.

### Manual backups

- In the web app: **Admin → Backups → Create backup now**. You can also
  download any backup there.
- From the command line:

  ```sh
  docker compose exec openbase openbase backup
  # or to a specific file:
  docker compose exec openbase openbase backup --out /data/backups/before-cleanup.tar.gz
  ```

  Manual backups are named `openbase-YYYYmmdd-HHMMSS.tar.gz`. Delete old
  ones yourself when you no longer need them. Archives written with
  `--out` under any other name work for `restore` but are not listed (or
  downloadable) on the admin Backups page, which only shows OpenBase's own
  file names.

### Offsite copies (strongly recommended)

Backups on the same disk do not protect you from losing the server, the
disk or the account. Copy them somewhere else every day. With Docker, the
backups directory on the host is the volume's data path:

```sh
docker volume inspect deploy_openbase-data --format '{{ .Mountpoint }}'
# usually /var/lib/docker/volumes/deploy_openbase-data/_data
```

Using [rclone](https://rclone.org) (any S3-compatible storage, Backblaze B2,
Google Drive, another server over SFTP, ...), add a root crontab entry
(`sudo crontab -e`) that runs an hour after the backup:

```cron
# m h dom mon dow  command
30 4 * * * rclone copy --max-age 48h /var/lib/docker/volumes/deploy_openbase-data/_data/backups b2:my-openbase-backups >> /var/log/openbase-offsite.log 2>&1
```

Or with rsync over SSH to another machine:

```cron
30 4 * * * rsync -a /var/lib/docker/volumes/deploy_openbase-data/_data/backups/ backup@backup-host:/srv/openbase-backups/ >> /var/log/openbase-offsite.log 2>&1
```

For systemd installs the directory is `/var/lib/openbase/backups`.

The archives are not encrypted, and they contain every record, every
attachment and the user table (password hashes). Use encrypted storage
(an rclone `crypt` remote, or a provider with server-side encryption) and
restrict who can read it. Run a test restore now and then (see below).

## 7. Restoring a backup

A restore replaces the database with the one in the archive and adds the
archive's attachments. Files already on disk are kept, since attachment
files are named by their content hash. The current database is never
deleted: it is moved aside to `openbase.db.pre-restore-<timestamp>` (with its
`-wal` file, if it had one).

**The server must be stopped.** `openbase restore` refuses to run while
`openbase.db-wal` is non-empty, which is how it detects a running (or
crashed) server.

With Docker Compose:

```sh
cd openbase/deploy
docker compose stop openbase

# Restore an archive that is already in the backups directory ...
docker compose run --rm --no-deps openbase restore /data/backups/openbase-auto-20261012-010000.tar.gz --force

# ... or one from the host (for example downloaded from offsite storage):
docker compose run --rm --no-deps -v "$PWD/openbase-20261012-010000.tar.gz:/restore.tar.gz:ro" \
    openbase restore /restore.tar.gz --force

docker compose start openbase
docker compose logs -f openbase
```

With systemd:

```sh
sudo systemctl stop openbase
sudo -u openbase env OPENBASE_DATA_DIR=/var/lib/openbase \
    openbase restore /path/to/openbase-20261012-010000.tar.gz --force
sudo systemctl start openbase
```

What happens, step by step:

1. Refuse if the WAL file is non-empty (server still running). If the
   server crashed instead, start it once and stop it cleanly so SQLite
   checkpoints the WAL, then retry. `--force` skips this check: use it only
   if you are sure no OpenBase process is running.
2. Refuse to replace an existing database unless `--force` is given.
3. Extract the archive into a temporary directory inside the data
   directory. Archives containing absolute paths, `..` components, links
   or device files are rejected outright.
4. Check that `manifest.json` exists, that its schema version is not newer
   than this OpenBase supports (upgrade OpenBase first if it is), and that
   `openbase.db` passes SQLite's `quick_check`.
5. Move the current `openbase.db` (and its WAL) aside to
   `openbase.db.pre-restore-<timestamp>`, move the restored database in,
   and merge the attachments.

If the archive came from an older OpenBase, the database is migrated on the
next start (with a pre-migration snapshot, see below). Once everything
looks right, you can delete the `openbase.db.pre-restore-*` files.

To restore onto a **new server**, install OpenBase there (sections 2 or 3)
but do not create an account. Then run the restore (without `--force` if
the data directory is still empty) and start the server.

## 8. Upgrading

1. Read the release notes.
2. Take a manual backup and make sure a recent offsite copy exists.
3. Update and restart:

   ```sh
   cd openbase && git pull
   cd deploy && docker compose up -d --build
   ```

   With systemd: replace `/usr/local/bin/openbase` and run
   `sudo systemctl restart openbase`.

When the new version needs to change the database schema, OpenBase first
writes a **pre-migration snapshot**,
`backups/pre-migration-v<old version>-<timestamp>.db`, and then migrates.
If the snapshot cannot be written (for example, the disk is full), it does
not migrate and refuses to start. These snapshots are plain SQLite
databases and are never deleted automatically. Remove old ones once you
are happy with the upgrade.

`openbase migrate` (also run on every start) is a no-op on a database that is
already current: it takes no snapshot and writes nothing. That was checked with
the release binary; a snapshot taken *because migrations were pending* is covered
by unit tests only, since schema version 1 is the only version so far.

To **roll back** an upgrade: stop the server, reinstall the previous
version, and restore your pre-upgrade backup archive with `openbase restore
--force`. You can also copy the `pre-migration-*.db` file over
`openbase.db` (with the server stopped, after deleting `openbase.db-wal`
and `openbase.db-shm`). OpenBase refuses to open a database written by a
newer version, so it cannot be downgraded by accident.

## 9. Account recovery

**Forgotten password.** Users can reset their own password with "Forgot
password" when SMTP is configured. Otherwise an administrator can create a
reset link under **Admin → Users → Create password reset link** and pass it on
(this works only in the web app, signed in: an API token or AI agent can never
create a reset link). From the
command line (this also signs the user out everywhere):

```sh
read -rs OPENBASE_NEW_PASSWORD && export OPENBASE_NEW_PASSWORD
docker compose exec -e OPENBASE_NEW_PASSWORD openbase \
    openbase reset-password --email user@example.com
unset OPENBASE_NEW_PASSWORD
```

**Lost two-factor device.** Turn off 2FA for the user from the command
line. This also signs them out everywhere. They can log in with their
password and set up 2FA again:

```sh
docker compose exec openbase openbase disable-2fa --email user@example.com
```

**Connect Claude or ChatGPT.** They sign in through OAuth, which OpenBase serves
itself, but they connect from their providers' servers: `OPENBASE_PUBLIC_URL` must be your
public `https://` address (with the bundled Caddy it already is) and the server must be
reachable from the internet. Over plain `http://` on a public address OpenBase does not
offer OAuth at all. Check with
`curl https://<domain>/.well-known/oauth-protected-resource/mcp`. People approve each app
on an approval page after signing in; you can see and revoke everyone's connections under
**Admin → Connected apps**. Apps register themselves unless you set
`OPENBASE_OAUTH_REGISTRATION=false` (apps that publish a metadata document can still ask a
signed-in person for approval); `openbase oauth-client add --name N --redirect-uri URI`
adds one by hand. Details: [mcp.md](mcp.md#connect-with-oauth-sign-in).

**The only administrator is locked out.** Use `reset-password` and/or
`disable-2fa` above, or create another administrator with `create-admin`.

## 10. Troubleshooting

| Symptom | What to check |
|---|---|
| Browser shows a certificate error or Caddy logs `challenge failed` | DNS must point at this server, and ports 80 and 443 must be reachable from the internet. Check with `docker compose logs caddy`. |
| `openbase` container keeps restarting | `docker compose logs openbase`. The most common cause is a database from a newer OpenBase ("schema version N is newer than this binary supports"): upgrade, or restore an older backup. |
| `unhealthy` in `docker compose ps` | `docker compose exec openbase openbase healthcheck` prints the reason. |
| Login works but you are logged out immediately | `OPENBASE_PUBLIC_URL` must match the URL in the browser exactly, including `https://`. |
| Requests rejected with "missing CSRF header" | A custom script is using a session cookie. Use a personal access token (`Authorization: Bearer ...`) instead. |
| All users appear to come from one IP (rate limits hit) | Set `OPENBASE_TRUST_PROXY=true` when running behind a reverse proxy. Never enable it when OpenBase is reachable directly, and only behind a proxy that sets or appends the client address in `X-Forwarded-For` (OpenBase uses the last entry); see `docs/security.md`. |
| Uploads fail with 413 | Raise `OPENBASE_MAX_UPLOAD_MB`. If you use a proxy other than Caddy, raise its body size limit too (nginx: `client_max_body_size`). |
| Live updates do not appear | A proxy is buffering Server-Sent Events. For nginx set `proxy_buffering off;` for `/api/bases/`. |
| `restore` says the server looks like it is still running | Stop the server. If it crashed, start and stop it cleanly once, then retry. |
| Disk full | Delete old manual backups and `pre-migration-*.db` / `openbase.db.pre-restore-*` files from the data directory, or lower `OPENBASE_BACKUP_KEEP`. |
| Claude or ChatGPT cannot connect or sign in | They connect from the internet: `OPENBASE_PUBLIC_URL` must be the public `https://` address, with a valid certificate, and `/.well-known/oauth-protected-resource/mcp` must answer JSON from outside. Put a proxy rule in front of `/mcp`, `/oauth/` and `/.well-known/` if you restrict paths. |
| Emails are not delivered | Check the logs for SMTP errors, make sure outgoing port 587/465 is not blocked, and check SPF/DKIM. |

Logs go to stdout (`docker compose logs`, or `journalctl -u openbase` for
systemd). Set `OPENBASE_LOG=debug` temporarily for more detail, and
`OPENBASE_LOG_FORMAT=json` if you ship logs to a collector.
