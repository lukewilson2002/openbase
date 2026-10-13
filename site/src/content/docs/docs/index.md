---
title: OpenBase documentation
description: "Documentation for OpenBase, the self-hosted Airtable alternative: quickstart, self-hosting, AI assistants (MCP), automations, the REST API and security."
---

OpenBase is a self-hosted alternative to Airtable for individuals and very small businesses:
tables, linked records, formulas, grid / kanban / calendar / gallery / timeline / list / form views,
automations, sharing and an Airtable-compatible API. It is one Rust program with the web app compiled
in; the database, uploaded files and backups live in one folder on a server you control. It is
dual licensed MIT OR Apache-2.0, with no paid tier and no license keys.

## Start here

1. **[Quickstart](/docs/quickstart/)**: an empty VPS to a working, HTTPS OpenBase with your first
   admin account and an AI assistant connected.
2. **[Self-hosting](/docs/self-hosting/)**: choosing a server, Docker Compose with Caddy, the
   systemd alternative, email, backups and restore, upgrades, account recovery and troubleshooting.
3. **[Connect AI assistants](/docs/mcp/)**: OpenBase is also an MCP server. Claude, ChatGPT and other
   assistants can build and edit your bases within the access you give them.

## Reference

- **[Automations](/docs/automations/)**: triggers, actions, `{{...}}` placeholders and webhooks.
- **[API](/docs/api/)**: the Airtable-compatible REST API under `/api/v1`, and where it differs from Airtable.
- **[Security](/docs/security/)**: the threat model, every limit, the administrator checklist and the
  accepted risks.

## About these pages

These pages are the documentation files of the
[repository](https://github.com/lukewilson2002/openbase/tree/main/docs), rendered as they are: one source
of truth, so the site and the files you get with a download never disagree. Each page has an
"Edit page" link to its source file. Search works offline in your browser; nothing is sent to a server.

Questions and bug reports go to the
[issue tracker](https://github.com/lukewilson2002/openbase/issues). Report security problems
privately, as described under [Reporting a problem](/docs/security/#reporting-a-problem).
