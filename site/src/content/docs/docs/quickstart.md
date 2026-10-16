---
title: Quickstart
description: "From an empty VPS to a running, HTTPS OpenBase with the first admin account and an AI assistant connected, using Docker Compose and Caddy."
---

This is the shortest path from an empty server to a working OpenBase at your own
address, with automatic HTTPS. Your own time is a few minutes; the first build, which
compiles the server inside Docker, adds some waiting time (2 minutes 12 seconds on a fast
laptop, much longer on a small VPS).

:::note[Version 0.1.0, not yet used in production by anyone but its authors]
Keep offsite backups from day one (step 5). What has and has not been verified is listed in
the [README](https://github.com/lukewilson2002/openbase#resource-usage-and-scale).
:::

## 1. What you need

- **A server.** Any 64-bit Linux VPS with Docker Engine and the Compose plugin
  ([install guide](https://docs.docker.com/engine/install/)). 1 vCPU, 1 GB RAM and 20 GB of disk
  is the suggested size for a small team; that exact size has not been tested, see
  [Self-hosting](/docs/self-hosting/#1-choosing-a-server).
- **A domain name** you can point at the server, such as `base.example.com`.
- **Ports 80 and 443 open** in the server's firewall. OpenBase itself is never exposed directly:
  Caddy sits in front of it, gets a Let's Encrypt certificate and renews it.

## 2. Point your domain at the server

Create an `A` record for `base.example.com` (and an `AAAA` record if you use IPv6) with the
server's IP address. Wait until this prints that address:

```sh
dig +short base.example.com
```

## 3. Download and start OpenBase

```sh
git clone https://github.com/lukewilson2002/openbase.git
cd openbase/deploy
cp .env.example .env
nano .env                 # set OPENBASE_DOMAIN=base.example.com (and TZ)
docker compose up -d
docker compose ps         # openbase should become "healthy"
```

:::note[The official image]
Compose pulls the official image, `ghcr.io/lukewilson2002/openbase` (linux/amd64 and linux/arm64),
so nothing is compiled on your server. `OPENBASE_VERSION` in `.env` picks the tag (default
`latest`). To update later: `docker compose pull && docker compose up -d`. To build from the cloned
source instead, see [Self-hosting](/docs/self-hosting/).
:::

If `docker compose ps` does not show `healthy` after a few minutes, read the logs with
`docker compose logs -f` and see
[Self-hosting](/docs/self-hosting/#2-docker-compose-with-caddy-recommended).

## 4. Create the first account

Open `https://base.example.com`. **The first account you create becomes the administrator**, so
do this before you share the address. Afterwards new people need an invite unless you set
`OPENBASE_OPEN_SIGNUP=true`. A short intro shows you around (replay it any time from your profile
menu), then OpenBase asks you to name your first workspace.

Prefer the command line? Create the administrator without opening the site:

```sh
read -rs OPENBASE_ADMIN_PASSWORD && export OPENBASE_ADMIN_PASSWORD
docker compose exec -e OPENBASE_ADMIN_PASSWORD openbase openbase create-admin --email you@example.com --name "Your Name"
```

## 5. Secure it and back it up

Everything below is in your profile menu at the bottom of the sidebar: **Settings** opens your
**Account** settings, and **Administration** (administrators only) opens the **Admin** pages.

1. **Add a passkey or turn on two-factor authentication** under **Account → Security**.
2. **Check the daily backup.** OpenBase writes one every night at 03:00 server time and keeps seven.
   Create one now under **Admin → Backups → Create backup now**.
3. **Copy backups off the server.** Backups on the same disk do not survive losing the server.
   [Self-hosting](/docs/self-hosting/#6-backups) shows how to do it with rclone, and how to restore.
4. **Set up email** (optional) under **Admin → Email** so that invites and password resets are sent for you.
   Without it, invites and reset links are copied by hand.

## 6. Let an AI assistant do the work

OpenBase is also an MCP server. Choose **Connect an assistant** in the profile menu (**Account → AI assistants**): it shows your server address
(`https://base.example.com/mcp`) with short steps for each client.

- **Claude or ChatGPT.** Add that address as a custom connector, sign in to OpenBase in the window that
  opens, choose **Read only**, **Read & edit** or **Full control**, and approve. Claude and ChatGPT
  connect from their own cloud, so this needs the public HTTPS address from steps 2 and 3.
- **Claude Code or a script.** Create a token under **Account → API tokens** and run
  `claude mcp add --transport http openbase https://base.example.com/mcp --header "Authorization: Bearer YOUR_TOKEN"`.

Then ask it, for example: "Create a base for tracking customers and orders, with a rollup of each
customer's lifetime value, and add three sample customers." The
[AI assistants guide](/docs/mcp/) has the details, the scope model and what an assistant can and cannot touch.

## What next

- [Self-hosting](/docs/self-hosting/): upgrades, restore, SMTP, the systemd alternative and troubleshooting.
- [Automations](/docs/automations/): triggers, actions and webhooks.
- [API](/docs/api/): the Airtable-compatible REST API.
- [Security](/docs/security/): the threat model and the administrator checklist. Read it before going live.
