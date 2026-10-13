# Self-hosting OpenGrid

This guide takes a fresh VPS to a running OpenGrid with HTTPS, backups
(including offsite copies), upgrades and recovery. Every setting is
described in the [README](../README.md#configuration).

## 1. Choosing a server

OpenGrid is one process that uses SQLite, so a small VPS is enough.

| Team size | Suggested VPS | Notes |
|---|---|---|
| 1-10 people, up to ~20k records per table | 1 vCPU, 1 GB RAM, 20 GB disk | The $4-6/month tier at most providers. |
| 10-25 people, up to ~50k records per table | 1-2 vCPU, 2 GB RAM | Leaves headroom for Caddy and large imports. |

These are suggestions, not tested configurations. What has been measured (on a
fast laptop, not a VPS; see [Resource usage](../README.md#resource-usage-and-scale)):
the server idles at about 15-19 MB and stayed at or under about 105 MB with a
50,000-record, 11-field table, and the Docker image is about 181 MB on disk. The
systemd unit caps memory at 400 MB.

Disk usage is roughly the database (a 50,000-record test table with 11 fields
produced a 5.7 MB backup archive; usually tens of MB) plus your attachments plus
your backups. Each backup archive holds the whole database **and every
attachment**, so with `OPENGRID_BACKUP_KEEP=7` you need room for about 8x
(database + attachments). The server does not check free disk space: keep an eye
on it, especially if you store many large files.

Use any 64-bit Linux with Docker (the image is built for the architecture of the
machine that builds it; it was tested as linux/arm64 and the Dockerfile has no
architecture-specific steps, but an amd64 build was not run). Open ports 80 and
443 in your firewall; OpenGrid itself is never exposed directly.

## 2. Docker Compose with Caddy (recommended)

Caddy terminates HTTPS and gets and renews a Let's Encrypt certificate
automatically. OpenGrid listens only on the internal Docker network.

1. Point DNS for your domain (for example `grid.example.com`) at the
   server: an `A` record, plus `AAAA` if you use IPv6. Wait until
   `dig +short grid.example.com` returns the server's IP.
2. Install Docker Engine and the Compose plugin
   (https://docs.docker.com/engine/install/).
3. Get the code and configure it:

   ```sh
   git clone <repository-url> opengrid
   cd opengrid/deploy
   cp .env.example .env
   nano .env            # set OPENGRID_DOMAIN, TZ and optionally SMTP
   ```

4. Build and start:

   ```sh
   docker compose up -d --build
   docker compose ps        # opengrid should become "healthy"
   docker compose logs -f   # Ctrl-C to stop following
   ```

5. Open `https://grid.example.com` and continue with
   [first run](#4-first-run-create-the-administrator).

What runs where:

- `opengrid` uses the image built from `deploy/Dockerfile`: a Node 24 stage builds
  the web client, a `rust:1-bookworm` stage builds the server with the client
  embedded, and the final stage is `debian:bookworm-slim` with only the binary,
  CA certificates and time zone data. It runs as the unprivileged user
  `opengrid` (uid 10001), keeps its data in the `opengrid-data` volume (mounted at
  `/data`), and has a built-in health check (`opengrid healthcheck`, every 30 s).
- `caddy` uses the official `caddy:2` image configured by
  `deploy/Caddyfile`. Certificates are stored in the `caddy-data` volume. It
  forwards Server-Sent Events without buffering, so live updates work.
- `OPENGRID_TRUST_PROXY=true` and `OPENGRID_PUBLIC_URL=https://<domain>`
  are set for you in `docker-compose.yml`. Nothing but Caddy can reach the
  `opengrid` container (its port is not published).
- Everything in `deploy/.env` is passed to the `opengrid` container, so any
  `OPENGRID_*` option from the [README](../README.md#configuration) works there.

The Compose file, the image build, first-run signup, data surviving
`docker compose restart` / a re-created container, `opengrid backup` and the
restore procedure below were all run end to end. A real Let's Encrypt
certificate could not be: it needs a public domain, so that step is untested here.

### Trying the stack locally (no domain, no certificate)

Caddy cannot get a public certificate for `localhost`, so `deploy/docker-compose.local.yml`
overrides three things: the site address becomes `http://localhost` (Caddy then serves
plain HTTP and skips certificates), the published port becomes `127.0.0.1:8088`, and
`OPENGRID_PUBLIC_URL` becomes `http://localhost:8088`.

```sh
cd opengrid/deploy
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
open http://localhost:8088       # first account becomes the administrator
docker compose -f docker-compose.yml -f docker-compose.local.yml down -v   # removes the volumes too
```

Use this only on your own machine: there is no TLS. `docker compose config` accepts
both files together with the shipped `.env.example`.

Run CLI commands inside the container like this:

```sh
docker compose exec opengrid opengrid --help
```

## 3. Alternative: the binary with systemd

1. Build the binary (needs Rust and Node 24):

   ```sh
   (cd web && npm ci --ignore-scripts && npm run build)
   cargo build --release --locked -p opengrid
   ```

   Or copy a release binary to the server.

2. Install the binary, create a user and install the unit:

   ```sh
   sudo install -m 0755 target/release/opengrid /usr/local/bin/opengrid
   sudo useradd --system --home-dir /var/lib/opengrid --shell /usr/sbin/nologin opengrid
   sudo install -m 0644 deploy/opengrid.service /etc/systemd/system/opengrid.service
   sudo install -d -m 0750 -o root -g opengrid /etc/opengrid
   sudo tee /etc/opengrid/opengrid.env >/dev/null <<'EOF'
   OPENGRID_PUBLIC_URL=https://grid.example.com
   OPENGRID_TRUST_PROXY=true
   TZ=Europe/Berlin
   EOF
   sudo chmod 0640 /etc/opengrid/opengrid.env
   sudo chgrp opengrid /etc/opengrid/opengrid.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now opengrid
   systemctl status opengrid
   ```

   The unit stores data in `/var/lib/opengrid` and listens on
   `127.0.0.1:8080`. It is hardened with `ProtectSystem=strict`,
   `NoNewPrivileges`, `PrivateTmp`, a system-call filter and
   `MemoryMax=400M`. The unit file passes `systemd-analyze verify` (checked in a
   Debian 12 container); it has not been started under a real systemd host, so
   if a hardening option does not suit your distribution, loosen it and tell us.

3. Put a TLS reverse proxy in front. With Caddy installed from your
   distribution, `/etc/caddy/Caddyfile` only needs:

   ```
   grid.example.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

Run CLI commands as the service user so file ownership stays correct:

```sh
sudo -u opengrid env OPENGRID_DATA_DIR=/var/lib/opengrid opengrid --help
```

## 4. First run: create the administrator

The first account created through the sign-up page becomes the
administrator. Do this right after the first start, before you share the
URL. Afterwards, new accounts need an invite unless
`OPENGRID_OPEN_SIGNUP=true`.

You can also create an administrator from the command line (for example
for automated installs). The password is read from an environment variable
so it does not end up in your shell history or the process list:

```sh
read -rs OPENGRID_ADMIN_PASSWORD && export OPENGRID_ADMIN_PASSWORD
docker compose exec -e OPENGRID_ADMIN_PASSWORD opengrid \
    opengrid create-admin --email you@example.com --name "Your Name"
unset OPENGRID_ADMIN_PASSWORD
```

Then turn on two-factor authentication for the admin account under
**Account → Security**.

## 5. Email (SMTP)

Email is optional. Without it, invites and password-reset links are shown
to the admin to pass on by hand. To enable it, set these in `deploy/.env`
(or `/etc/opengrid/opengrid.env`) and restart:

```sh
OPENGRID_SMTP_HOST=smtp.example.com
OPENGRID_SMTP_PORT=587
OPENGRID_SMTP_SECURITY=starttls     # or tls for port 465
OPENGRID_SMTP_USER=opengrid@example.com
OPENGRID_SMTP_PASSWORD=app-password
OPENGRID_SMTP_FROM=OpenGrid <opengrid@example.com>
```

Leave the `OPENGRID_SMTP_*` lines out entirely (or commented out) to keep
email disabled. Don't set them to empty values. Any transactional email
provider works (Postmark, Mailgun, Amazon SES, Fastmail, a Google
Workspace app password, ...). Many VPS providers block outgoing port 25,
so use 587 or 465. Configure SPF/DKIM for the sender domain, or invites
will end up in spam.

## 6. Backups

A backup archive (`.tar.gz`) holds:

- `opengrid.db`, a consistent snapshot of the database taken with SQLite
  `VACUUM INTO` while the server keeps running;
- `attachments/`, every uploaded file and thumbnail;
- `manifest.json`, with the OpenGrid version, the schema version and the
  creation time.

Backups are written to `<data dir>/backups/` under a temporary name and
renamed when complete, so a crash never leaves a half-written archive that
looks valid.

### Automatic daily backups

Every day at `OPENGRID_BACKUP_HOUR` (default `3`, server local time, so set
`TZ`) the server writes `opengrid-auto-YYYYmmdd-HHMMSS.tar.gz` (the
timestamp in the name is UTC). It keeps the newest `OPENGRID_BACKUP_KEEP`
(default 7) automatic backups and deletes older ones. Manual backups and
pre-migration snapshots are never deleted automatically. If the server was
down at the scheduled hour, the backup runs as soon as it is back up that
day. Set `OPENGRID_BACKUP_HOUR=-1` to turn automatic backups off.

### Manual backups

- In the web app: **Admin → Backups → Create backup now**. You can also
  download any backup there.
- From the command line:

  ```sh
  docker compose exec opengrid opengrid backup
  # or to a specific file:
  docker compose exec opengrid opengrid backup --out /data/backups/before-cleanup.tar.gz
  ```

  Manual backups are named `opengrid-YYYYmmdd-HHMMSS.tar.gz`. Delete old
  ones yourself when you no longer need them. Archives written with
  `--out` under any other name work for `restore` but are not listed (or
  downloadable) on the admin Backups page, which only shows OpenGrid's own
  file names.

### Offsite copies (strongly recommended)

Backups on the same disk do not protect you from losing the server, the
disk or the account. Copy them somewhere else every day. With Docker, the
backups directory on the host is the volume's data path:

```sh
docker volume inspect deploy_opengrid-data --format '{{ .Mountpoint }}'
# usually /var/lib/docker/volumes/deploy_opengrid-data/_data
```

Using [rclone](https://rclone.org) (any S3-compatible storage, Backblaze B2,
Google Drive, another server over SFTP, ...), add a root crontab entry
(`sudo crontab -e`) that runs an hour after the backup:

```cron
# m h dom mon dow  command
30 4 * * * rclone copy --max-age 48h /var/lib/docker/volumes/deploy_opengrid-data/_data/backups b2:my-opengrid-backups >> /var/log/opengrid-offsite.log 2>&1
```

Or with rsync over SSH to another machine:

```cron
30 4 * * * rsync -a /var/lib/docker/volumes/deploy_opengrid-data/_data/backups/ backup@backup-host:/srv/opengrid-backups/ >> /var/log/opengrid-offsite.log 2>&1
```

For systemd installs the directory is `/var/lib/opengrid/backups`.

The archives are not encrypted, and they contain every record, every
attachment and the user table (password hashes). Use encrypted storage
(an rclone `crypt` remote, or a provider with server-side encryption) and
restrict who can read it. Run a test restore now and then (see below).

## 7. Restoring a backup

A restore replaces the database with the one in the archive and adds the
archive's attachments. Files already on disk are kept, since attachment
files are named by their content hash. The current database is never
deleted: it is moved aside to `opengrid.db.pre-restore-<timestamp>` (with its
`-wal` file, if it had one).

**The server must be stopped.** `opengrid restore` refuses to run while
`opengrid.db-wal` is non-empty, which is how it detects a running (or
crashed) server.

With Docker Compose:

```sh
cd opengrid/deploy
docker compose stop opengrid

# Restore an archive that is already in the backups directory ...
docker compose run --rm --no-deps opengrid restore /data/backups/opengrid-auto-20261012-010000.tar.gz --force

# ... or one from the host (for example downloaded from offsite storage):
docker compose run --rm --no-deps -v "$PWD/opengrid-20261012-010000.tar.gz:/restore.tar.gz:ro" \
    opengrid restore /restore.tar.gz --force

docker compose start opengrid
docker compose logs -f opengrid
```

With systemd:

```sh
sudo systemctl stop opengrid
sudo -u opengrid env OPENGRID_DATA_DIR=/var/lib/opengrid \
    opengrid restore /path/to/opengrid-20261012-010000.tar.gz --force
sudo systemctl start opengrid
```

What happens, step by step:

1. Refuse if the WAL file is non-empty (server still running). If the
   server crashed instead, start it once and stop it cleanly so SQLite
   checkpoints the WAL, then retry. `--force` skips this check: use it only
   if you are sure no OpenGrid process is running.
2. Refuse to replace an existing database unless `--force` is given.
3. Extract the archive into a temporary directory inside the data
   directory. Archives containing absolute paths, `..` components, links
   or device files are rejected outright.
4. Check that `manifest.json` exists, that its schema version is not newer
   than this OpenGrid supports (upgrade OpenGrid first if it is), and that
   `opengrid.db` passes SQLite's `quick_check`.
5. Move the current `opengrid.db` (and its WAL) aside to
   `opengrid.db.pre-restore-<timestamp>`, move the restored database in,
   and merge the attachments.

If the archive came from an older OpenGrid, the database is migrated on the
next start (with a pre-migration snapshot, see below). Once everything
looks right, you can delete the `opengrid.db.pre-restore-*` files.

To restore onto a **new server**, install OpenGrid there (sections 2 or 3)
but do not create an account. Then run the restore (without `--force` if
the data directory is still empty) and start the server.

## 8. Upgrading

1. Read the release notes.
2. Take a manual backup and make sure a recent offsite copy exists.
3. Update and restart:

   ```sh
   cd opengrid && git pull
   cd deploy && docker compose up -d --build
   ```

   With systemd: replace `/usr/local/bin/opengrid` and run
   `sudo systemctl restart opengrid`.

When the new version needs to change the database schema, OpenGrid first
writes a **pre-migration snapshot**,
`backups/pre-migration-v<old version>-<timestamp>.db`, and then migrates.
If the snapshot cannot be written (for example, the disk is full), it does
not migrate and refuses to start. These snapshots are plain SQLite
databases and are never deleted automatically. Remove old ones once you
are happy with the upgrade.

`opengrid migrate` (also run on every start) is a no-op on a database that is
already current: it takes no snapshot and writes nothing. That was checked with
the release binary; a snapshot taken *because migrations were pending* is covered
by unit tests only, since schema version 1 is the only version so far.

To **roll back** an upgrade: stop the server, reinstall the previous
version, and restore your pre-upgrade backup archive with `opengrid restore
--force`. You can also copy the `pre-migration-*.db` file over
`opengrid.db` (with the server stopped, after deleting `opengrid.db-wal`
and `opengrid.db-shm`). OpenGrid refuses to open a database written by a
newer version, so it cannot be downgraded by accident.

## 9. Account recovery

**Forgotten password.** Users can reset their own password with "Forgot
password" when SMTP is configured. Otherwise an administrator can create a
reset link under **Admin → Users → Reset link** and pass it on. From the
command line (this also signs the user out everywhere):

```sh
read -rs OPENGRID_NEW_PASSWORD && export OPENGRID_NEW_PASSWORD
docker compose exec -e OPENGRID_NEW_PASSWORD opengrid \
    opengrid reset-password --email user@example.com
unset OPENGRID_NEW_PASSWORD
```

**Lost two-factor device.** Turn off 2FA for the user from the command
line. This also signs them out everywhere. They can log in with their
password and set up 2FA again:

```sh
docker compose exec opengrid opengrid disable-2fa --email user@example.com
```

**The only administrator is locked out.** Use `reset-password` and/or
`disable-2fa` above, or create another administrator with `create-admin`.

## 10. Troubleshooting

| Symptom | What to check |
|---|---|
| Browser shows a certificate error or Caddy logs `challenge failed` | DNS must point at this server, and ports 80 and 443 must be reachable from the internet. Check with `docker compose logs caddy`. |
| `opengrid` container keeps restarting | `docker compose logs opengrid`. The most common cause is a database from a newer OpenGrid ("schema version N is newer than this binary supports"): upgrade, or restore an older backup. |
| `unhealthy` in `docker compose ps` | `docker compose exec opengrid opengrid healthcheck` prints the reason. |
| Login works but you are logged out immediately | `OPENGRID_PUBLIC_URL` must match the URL in the browser exactly, including `https://`. |
| Requests rejected with "missing CSRF header" | A custom script is using a session cookie. Use a personal access token (`Authorization: Bearer ...`) instead. |
| All users appear to come from one IP (rate limits hit) | Set `OPENGRID_TRUST_PROXY=true` when running behind a reverse proxy. Never enable it when OpenGrid is reachable directly, and only behind a proxy that sets or appends the client address in `X-Forwarded-For` (OpenGrid uses the last entry); see `docs/security.md`. |
| Uploads fail with 413 | Raise `OPENGRID_MAX_UPLOAD_MB`. If you use a proxy other than Caddy, raise its body size limit too (nginx: `client_max_body_size`). |
| Live updates do not appear | A proxy is buffering Server-Sent Events. For nginx set `proxy_buffering off;` for `/api/bases/`. |
| `restore` says the server looks like it is still running | Stop the server. If it crashed, start and stop it cleanly once, then retry. |
| Disk full | Delete old manual backups and `pre-migration-*.db` / `opengrid.db.pre-restore-*` files from the data directory, or lower `OPENGRID_BACKUP_KEEP`. |
| Emails are not delivered | Check the logs for SMTP errors, make sure outgoing port 587/465 is not blocked, and check SPF/DKIM. |

Logs go to stdout (`docker compose logs`, or `journalctl -u opengrid` for
systemd). Set `OPENGRID_LOG=debug` temporarily for more detail, and
`OPENGRID_LOG_FORMAT=json` if you ship logs to a collector.
