# OpenGrid MCP server

OpenGrid contains an [MCP](https://modelcontextprotocol.io) (Model Context Protocol)
server in the same binary, at `/mcp`. An AI agent that holds one of your personal
access tokens can do **everything you can do in the web app**, within that token's
permissions: build bases, tables, fields of all 28 types and views, fill in and edit
records, run formulas and rollups, set up automations and public forms, invite
people, import and export CSV, upload files, read history and notifications, and
(for administrators) manage users and backups. You do not have to open the app
yourself if you would rather describe the work to an agent.

- **Same rules as the app.** Every action goes through the same permission checks,
  validation, history, live updates and automations as a click in the browser.
  Record changes are attributed to you in the record history.
- **Nothing to install.** No extra process, port or dependency. The endpoint is on
  your normal public URL, behind your normal HTTPS.
- **Not for account takeover.** Passwords, two-factor authentication, sessions and
  API tokens can never be read or changed through a token, whatever its scope. The
  tools cannot create, list or delete tokens either. Even an administrator's token cannot
  create a password-reset link, switch off someone's 2FA, give a new user a password or
  set the SMTP password.

Contents: [Quick start](#quick-start) · [Set up your client](#set-up-your-client) ·
[Choose a token](#choose-a-token) · [How an agent works here](#how-an-agent-works-here) ·
[Tools](#tools) · [Reaching everything: api_reference and api_request](#reaching-everything-api_reference-and-api_request) ·
[Scope model](#scope-model) · [Security model](#security-model) · [Limits and settings](#limits-and-settings) ·
[Protocol](#protocol) · [What has been tested](#what-has-been-tested) · [Troubleshooting](#troubleshooting)

## Quick start

1. Open **Account → AI assistants** in OpenGrid. It shows your endpoint address and
   copy-ready settings (the same ones as below).
2. **Account → API tokens → New token.** Give it a name. Tick "Allow writes" if the
   assistant should change things, and (only for an assistant that should also manage
   workspaces and members) "Allow managing workspaces, members and settings". You can
   limit the token to chosen bases and give it an expiry. Copy the token; it is shown
   once.
3. Add the server to your assistant. For Claude Code:

   ```sh
   claude mcp add --transport http opengrid https://grid.example.com/mcp \
     --header "Authorization: Bearer YOUR_TOKEN"
   ```

4. Ask it to do something: "Create a base for tracking customers and orders, with a
   rollup of each customer's lifetime value, and add three sample customers."

## Set up your client

The server speaks the *Streamable HTTP* transport at `https://<your OpenGrid>/mcp` and
authenticates with a bearer header, `Authorization: Bearer <token>`. It does not
support OAuth sign-in, so a client that can only connect through an OAuth flow (for
example the connector directories of some chat apps) cannot use it.

| Client | How | Checked |
|---|---|---|
| **Claude Code** | `claude mcp add --transport http opengrid <url> --header "Authorization: Bearer <token>"` (this project and you; add `--scope user` for all your projects). Check with `claude mcp list`: it shows `opengrid ... Connected`. | yes, CLI 2.1.285: `scripts/mcp-claude-check.sh` |
| **Claude Code, shared with a team** | `claude mcp add --scope project ...` writes `.mcp.json` into the repository. Keep the token out of git (`"Authorization": "Bearer ${OPENGRID_TOKEN}"` expands an environment variable). Everyone must approve a project-scoped server once; until then `claude mcp list` shows "Pending approval". | approval behaviour yes |
| **Any client with a JSON file** (Cursor, Windsurf, Cline, ...) | The `mcpServers` object below. Cursor calls the file `~/.cursor/mcp.json`; VS Code uses `.vscode/mcp.json` with a top-level `servers` key instead of `mcpServers`. | format only |
| **Claude Desktop** | Its connector settings are for OAuth servers. Use a local bridge that adds the header: `"command": "npx", "args": ["-y", "mcp-remote", "<url>", "--header", "Authorization:${AUTH}"]` with `"env": {"AUTH": "Bearer <token>"}` in `claude_desktop_config.json`. | no |
| **Your own program** | Any MCP SDK with a Streamable HTTP client and custom headers: set the URL and the `Authorization` header. The official Rust SDK (`rmcp`) is tested against this server in both protocol generations. | yes (`rmcp`) |

```json
{
  "mcpServers": {
    "opengrid": {
      "type": "http",
      "url": "https://grid.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

"Checked: format only" means the configuration follows the client's documented shape
but this project has not run that client. A quick check from a shell works for any
setup:

```sh
curl -s https://grid.example.com/mcp \
  -H "Authorization: Bearer $OPENGRID_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Choose a token

Give an agent the least permission that does the job. What a token can do is the
intersection of its owner's role on each base and the token's scope:

| Token | The agent can | Tools it sees |
|---|---|---|
| **Read only** | read bases, schema, records, views, comments, history, trash listings, automations, notifications; export CSV | the read tools, `api_reference`, `api_request` (reads only) |
| **Read and write** | additionally create and edit records, comments, bases, tables, fields, views, share links, automations, imports and uploads, and restore from the trash, as far as the owner's role allows | + the write tools |
| **Write + manage** | additionally rename, delete, duplicate and restore workspaces and bases, change and remove members, create, list and revoke invites, and (if the owner is an instance administrator) use the admin pages | + the manage tools, and the `admin_*` tools for administrators |

Optionally limit a token to chosen **bases** (it cannot see or touch any other base,
through any tool) and give it an **expiry**. A base-limited `manage` token manages only
its bases: workspace-level actions (workspaces, workspace members and invites,
duplicating bases, the admin pages) are refused for it, and so are creating bases
and workspaces.

The permission table, route by route, is in [api.md](api.md#token-permissions).

## How an agent works here

- **Names, not ids.** Tables, fields, views and select choices are given by name
  (an id works too). `get_base_schema` lists them. A wrong name returns the valid
  ones.
- **Value shapes** follow the [Airtable-compatible API](api.md#25-value-shapes): text,
  numbers, `true`/`false`, dates as `"YYYY-MM-DD"` or ISO datetimes, select names,
  arrays of record ids for links, `{id}` for users and attachments. `field_types`
  explains each of the 28 types.
- **Every tool returns compact JSON** (and the same data as `structuredContent`).
  Select values, people and linked records read the same way in every tool.
- **Deletions are recoverable.** Deleted records, fields, tables, views, bases and
  workspaces go to the trash and come back with `restore_from_trash` within
  `OPENGRID_TRASH_DAYS` (30). Changing a field's type is the exception: it converts
  the data and asks for confirmation first.
- **Errors say how to fix them**: the valid names, the missing role ("requires the
  creator role on this base"), or the missing token permission ("needs an API token
  with the 'manage' permission").

A typical run, as tool calls:

```text
create_workspace {name: "Acme"}                              -> workspace id
create_base {workspace_id, name: "CRM"}                      -> base id, with a first table
rename_table {base_id, table: "Table 1", name: "Customers"}
create_table {base_id, name: "Orders"}
create_field {base_id, table: "Orders", name: "Customer", type: "link",
              options: {linked_table: "Customers"}, inverse_name: "Orders"}
create_field {..., table: "Orders", name: "Total", type: "formula",
              options: {expression: "{Qty} * {Unit price}"}}
create_field {..., table: "Customers", name: "Lifetime value", type: "rollup",
              options: {link_field: "Orders", target_field: "Total", expression: "SUM(values)"}}
create_records {base_id, table: "Customers", records: [{fields: {Name: "Ada"}}]}
create_view {base_id, table: "Orders", name: "Open by customer", type: "grid",
             config: {filter: {items: [{field_id: "Status", op: "is", value: "Open"}]},
                      sorts: [{field_id: "Total", direction: "desc"}],
                      groups: [{field_id: "Customer"}]}}
query_view {base_id, view: "Open by customer"}               -> rows in view order + groups
```

## Tools

Tools are listed according to the token (a read-only token does not see
`create_records`), and every tool re-checks permissions when called. A call that
fails returns a tool result with `isError: true` and a message that says how to fix
it; protocol problems are JSON-RPC errors. Results longer than 100,000 bytes are cut
with a note. `base_id` always comes from `list_bases`; `table`, `field` and `view`
are names or ids.

### Records and comments (data tools)

| Tool | Needs | What it does |
|---|---|---|
| `list_bases` | any | Workspaces and bases the token can reach, with your role on each and their icons |
| `get_base_schema` | any | The base's icon, and its tables (with icons), fields (id, name, type, options) and views |
| `list_records` | any | Records keyed by field **name**; optional view, `filterByFormula`, sort, field list; 50 per call (max 200), `offset` continues |
| `search_records` | any | Case-insensitive text search over all fields |
| `get_record` | any | One record |
| `create_records` | write | 1-10 records per call; `typecast` (default true) converts values and creates select choices |
| `update_records` | write | 1-10 records; only the given fields change; `null` clears |
| `delete_records` | write | 1-10 records, to the trash |
| `list_comments` / `add_comment` | any / write | Comments on a record; `@[Name](usrXXXX)` mentions notify people |

### Workspaces and people

| Tool | Needs | What it does |
|---|---|---|
| `list_workspaces` | any | Workspaces (with icons) with your role and their bases |
| `create_workspace` | manage | New workspace, optionally with an `icon`; you become its owner |
| `rename_workspace` | manage | Rename and/or change or remove the `icon` (owner role) |
| `delete_workspace` | manage | To the trash (owner role) |
| `list_members` | manage | Members of a workspace or of one base, with roles |
| `set_member_role` | manage | Change a member's role (a workspace always keeps an owner) |
| `remove_member` | manage | Remove someone's access to a workspace or base |
| `create_invite` | manage | Invite link for a workspace or base, optional email restriction; returns the link |
| `list_invites` / `revoke_invite` | manage | Pending invites; revoke one |
| `list_collaborators` | any | People who can see a base (user ids for user fields and @mentions) |

### Bases, tables and fields

| Tool | Needs | What it does |
|---|---|---|
| `create_base` / `rename_base` | write | Create a base in a workspace; rename or restyle it (name, colour, `icon`) |
| `duplicate_base` / `delete_base` | manage | Copy a base (records optional; the copy keeps the icons); delete to the trash (owner role) |
| `create_table` / `rename_table` | write | Add a table; rename it or change its description or `icon` |
| `duplicate_table` / `delete_table` | write | Copy a table (records optional; the copy keeps the icon); delete to the trash |
| `create_field` | write | Add a field of any of the 28 types with options; link fields create their inverse |
| `update_field` | write | Rename, change description or options (merged into the current ones), or change type (asks for `confirm_conversion` first) |
| `delete_field` | write | Delete a field and its dependants to the trash |
| `set_primary_field` | write | Choose the table's primary field |
| `check_formula` | write | Parse and type-check a formula and preview it on a record |
| `field_types` | any | Options and value shape of each field type, with an example |
| `list_icons` | any | Search the Lucide icon names (`query`, `limit`) that `icon` accepts |

#### Icons

Workspaces, bases and tables can have an icon: a [Lucide](https://lucide.dev) name in
kebab-case such as `briefcase`, `users` or `chart-column` (the web app's icon picker offers
the same set). `create_workspace`, `create_base` and `create_table` take an optional `icon`;
`rename_workspace`, `rename_base` and `rename_table` change it. In those, **leaving `icon` out
keeps the current icon, a name sets it, and `null` removes it**. The tools keep their
`rename_*` names (an `update_*` rename would have broken existing agents and prompts); their
titles and descriptions say that they also change icons.

Unlike the REST API, which only checks that an icon name is well-formed (so an icon from a
newer web client keeps working), the tools check the name against the list of Lucide icons
(`crates/server/data/lucide-icons.txt`, generated from the `lucide-react` package by
`scripts/gen-icons.sh`). An unknown name is refused with suggestions (`Did you mean:
shopping-cart, ...`); an old name (`home` for `house`) or loose spelling (`Chart Column`) is
accepted and stored under the canonical name, and the result says so in `note`. `list_icons`
finds names: every word of `query` has to match a name or an old name (`cart shop` finds
`shopping-cart`); without a query it lists alphabetically. Icons show in `list_bases`,
`list_workspaces` and `get_base_schema`.

### Views

| Tool | Needs | What it does |
|---|---|---|
| `get_view` | any | A view's configuration, with field names |
| `create_view` | write | Grid, form, gallery, kanban, calendar, timeline or list view, optionally personal, with a configuration |
| `update_view` | write | Rename, lock, or change parts of the configuration (filter, sorts, groups, hidden and ordered fields, widths, summaries, row colour, kanban / calendar / gallery / timeline / form settings) |
| `delete_view` | write | Delete to the trash |
| `query_view` | any | Rows as the app shows them: filter, sort and grouping applied, hidden fields left out, group headers, totals, paging |

A view configuration is the REST API's `ViewConfig`; wherever it wants a field id you
may write the field name, filter and sort entries may use `field` instead of
`field_id`, and select filters and kanban stack orders take choice names. Unknown keys
are rejected with the list of valid ones. `update_view` replaces only the parts you
send (settings objects merge key by key; `null` resets a part).

### Trash, history, notifications

| Tool | Needs | What it does |
|---|---|---|
| `list_trash` | any | Deleted records, fields, tables and views of a base (creator role); a workspace's deleted bases; your deleted workspaces |
| `restore_from_trash` | write | Bring back a record, field, table, view, base or workspace |
| `get_record_history` | any | Who changed which fields from what to what, newest first, with field names and readable values |
| `list_notifications` / `mark_notifications_read` | any / write | Your notifications; mark some or all read |

### Share links and public forms

| Tool | Needs | What it does |
|---|---|---|
| `create_share_link` | write | Public read-only page of a view, or a public form for a form view; optional password; returns the URL |
| `list_share_links` | any | A view's share links |
| `update_share_link` | write | Enable or disable; set or remove the password |
| `delete_share_link` | write | Delete a link for good |

### Automations

| Tool | Needs | What it does |
|---|---|---|
| `list_automations` / `get_automation` | any | A base's automations; one with trigger and actions |
| `create_automation` | write | One trigger (record created / updated / matches, form submitted, schedule, webhook) and up to 25 actions; tables and fields by name; off unless `enabled` |
| `update_automation` | write | Enable or disable, rename, replace trigger or actions, rotate a webhook token |
| `delete_automation` | write | Delete with its run history |
| `test_automation` | write | Dry run by default (renders and evaluates, changes nothing); `dry_run: false` runs the actions once |
| `list_automation_runs` | any | Run history with the log of each action |

### Files and data

| Tool | Needs | What it does |
|---|---|---|
| `upload_attachment` | write | Upload from `content_base64` or a public `url` (fetched by the server through the automations' SSRF guard); returns the attachment reference to put into an attachment field |
| `export_csv` | any | A view as CSV text; cut at about 80 KB at a row boundary with the totals |
| `import_csv` | write | CSV text into an existing table (columns by header or `mapping`) or into a new table with inferred field types; all or nothing |

### Administration

Only for a `manage` token whose owner is an instance administrator; other tokens
neither see nor can call these. Every call is recorded in the audit log.

**Why `admin_create_user` returns no reset link.** A password-reset link lets whoever
holds it choose the password of that account, and an account can be an administrator's.
If a token received the link it could take the account over and keep it after the token
is revoked, which is exactly what the "tokens never change credentials" rule prevents.
(For the same reason `POST /api/admin/users/{id}/reset-link` is session-only.) So the
tool creates the account with no usable password and says what to do: when the server
sends email the new person uses "Forgot password" on the sign-in page with their address,
otherwise an administrator, signed in to the web app, creates the link under **Admin →
Users → Create password reset link** and sends it. Creating an account is otherwise like
inviting a new person: a new account has no data.

**Email settings.** The three email tools let an agent set up or check outgoing email
without the web app, with one deliberate gap: **the SMTP password cannot be set or removed
by a token** (the tool has no such argument, and `api_request` is refused with 403),
because it is a credential; a person types it under **Admin → Email**. For the same reason,
while an SMTP password is in use (stored, or from `OPENGRID_SMTP_PASSWORD`) a token cannot
change the host, port, security mode or username: that would make the server send the
password to a server of the agent's choosing. It can still change the sender address, and
switch email off by clearing the host. Fields fixed by an `OPENGRID_SMTP_*` environment
variable are read-only for everyone. A typical sequence is `admin_get_email_settings`,
`admin_update_email_settings {host, port, security, username}`, a person enters the
password in the app, then `admin_send_test_email`.

| Tool | What it does |
|---|---|
| `admin_list_users` | All users with role, status and 2FA flag |
| `admin_create_user` | New account (name, email, optional administrator role) **without a usable password**: the tool cannot set one or return a reset link (see below) |
| `admin_update_user` | Rename, deactivate or reactivate, grant or revoke the administrator role (no way to switch off someone's 2FA) |
| `admin_get_email_settings` | The SMTP settings: on or off, host, port, security, username, sender, whether a password is stored (never the password), where each setting comes from, and the read-only email budgets |
| `admin_update_email_settings` | Change host, port, security, username or sender (effective at once). Never the password; and while a password is in use not the host, port, security or username either |
| `admin_send_test_email` | Send a test email (to the administrator, or `to`); a failure comes back as an error with the real SMTP error text |
| `admin_audit_log` | The audit log, newest first, paged |
| `admin_stats` | Counts, sizes, last backup, version |
| `admin_create_backup` / `admin_list_backups` | Make a backup now; list the stored backups |

## Reaching everything: api_reference and api_request

The tools above cover the whole application, but `api_request` stays for
completeness: any request of the REST API the web app uses, run inside the server
through the real router with the caller's own token.

1. `api_reference` with no argument: the list of areas. With `{"area": "records"}`:
   every endpoint of the area with method, path, purpose, minimum role, required
   token permission, and a request / response summary.
2. `api_request` with `{method, path, query?, body?}`. The result is
   `{status, ok, body}`; a status of 400 or more makes the tool result an error.

Details:

- `path` must start with `/api/` and contain real ids; query parameters go in
  `query` (an object; lists repeat the key).
- **Uploads and CSV import** use a multipart body:
  `{"multipart": {"file": {"filename": "people.csv", "text": "Name,Age\nAda,36\n"}, "has_header": true}}`.
  Use `content_base64` instead of `text` for binary files. The whole request is
  capped at 8 MB.
- **Responses:** JSON and text up to 100,000 bytes (then cut, with `truncated: true`).
  Small binary files (up to 64 KB) come back as `body_base64`.
- **Refused up front** with a message: anything that is not `/api/...`; `/mcp` itself;
  credential, 2FA, session and token endpoints; sign-in flows; and the endless
  live-update stream.

The catalogue lives in `crates/server/src/mcp/catalogue.rs`. A test scans the source
for every registered route and fails if one is missing from it.

## Scope model

Four things decide whether a call works, all enforced by the server on every call (the
tool list is only a convenience):

1. **The token's user and their role.** A token never has more rights than its owner
   has on the base: viewer, commenter, editor, creator or owner.
2. **Write.** A read-only token acts with at most the viewer role.
3. **Bases.** A base-limited token sees only those bases; everything else is "not
   found".
4. **`manage`** (needs write): workspaces, members, invites, deleting and duplicating
   bases, trash of bases and workspaces, the account name and time zone. Tools that
   reach beyond one base also need a token that is *not* base-limited. Admin tools
   additionally need the owner to be an instance administrator.

Errors tell the cause apart: "requires the creator role on this base" (the user's
role), "needs an API token with the 'manage' permission" (the token), "this API token
is read-only" or "limited to specific bases" (the token's limits), "not found, or you
have no access" (the base is outside the user's or the token's reach).

## Security model

- **Bearer tokens only.** A session cookie is never looked at: a request without a
  valid `Authorization: Bearer` header is `401` with `WWW-Authenticate`. That is the
  reason `/mcp` is exempt from the cookie CSRF header.
- **Credentials stay out of reach.** No tool changes a password, two-factor setting,
  session or API token, and `api_request` refuses those endpoints. Administrators
  cannot set another user's password, create a reset link for anyone, switch off their 2FA
  or set the SMTP password through MCP; a user created through MCP has no usable password
  until a person sets one in the web app. The server enforces this on the REST API itself,
  so `api_request` cannot get around it (`403` "API tokens can never ...", and nothing is
  changed).
- **Origin check (DNS rebinding).** A request carrying an `Origin` header (browsers
  always send one) is served only if the origin is the configured public URL or in
  `OPENGRID_MCP_ALLOWED_ORIGINS`; otherwise `403`. Non-browser clients send no
  `Origin` and are unaffected.
- **Outbound fetches are guarded.** `upload_attachment` with a `url`, and the
  automations' HTTP action, go through one SSRF guard: http(s) only, no credentials in
  the URL, the host is resolved by the server and every address checked (loopback,
  private, link-local including cloud metadata addresses, and other reserved ranges
  are refused unless `OPENGRID_ALLOW_PRIVATE_WEBHOOKS` is set), the connection is
  pinned to the checked addresses, redirects are not followed, and the download is
  refused (not cut) beyond the upload limit.
- **Limits.** Bodies up to 8 MB; per-token and per-user request rates; invalid tokens
  cost nothing and are never counted.
- **Destructive actions are recoverable** (trash) except changing a field's type,
  which needs an explicit confirmation, and deleting automations, share links and
  invites.
- **Audit.** Calls an administrator's `manage` token makes to the admin pages are
  recorded in the audit log (`admin_token_use`, with the token id). Token use is
  stamped in the token list ("last used"). Record changes show the token's owner in
  the history.
- **Prompt injection.** An agent reads text that other people wrote (record contents,
  comments, imported files, web pages behind an upload URL). Anything the agent may
  do, text it reads might trick it into doing: use read-only or base-limited tokens
  for agents that process untrusted content, avoid `manage` tokens for them, and set
  an expiry.

More in [security.md](security.md).

## Limits and settings

| Setting | Default | Meaning |
|---|---|---|
| `OPENGRID_MCP_RATE_PER_TOKEN` | 30 | requests per second per token |
| `OPENGRID_MCP_RATE_PER_USER` | 100 | requests per second per user |
| `OPENGRID_MCP_ALLOWED_ORIGINS` | none | extra browser origins allowed, comma separated |
| `OPENGRID_MAX_UPLOAD_MB` | 100 | largest uploaded file (`upload_attachment`, URL or base64) |
| `OPENGRID_ALLOW_PRIVATE_WEBHOOKS` | false | allow automations and URL uploads to reach private addresses |
| `OPENGRID_TRASH_DAYS` | 30 | how long deleted items can be restored |

Fixed in code: 8 MB request body (so base64 uploads up to about 6 MB; URL uploads are
limited only by the upload limit), 10 records per write call, 200 records per
`list_records` / `query_view` call, 100,000 bytes per tool result, about 80 KB of CSV
per `export_csv`, 120 s per `api_request`, 30 s per URL download.

## Protocol

`POST /mcp` accepts one JSON-RPC 2.0 message per request and answers with one JSON
object (`Content-Type: application/json`); notifications get `202 Accepted`. There
are no sessions and no server-initiated messages, so `GET /mcp` and `DELETE /mcp`
answer `405`. Two protocol generations are served on the same endpoint:

- **`2026-07-28` (current, stateless).** No handshake. Each request carries
  `params._meta["io.modelcontextprotocol/protocolVersion"]` and the headers
  `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`) `Mcp-Name`; a mismatch is
  `400` with error `-32020`, an unsupported version `400` with `-32022` and the list of
  supported versions. `server/discover` returns versions, capabilities and instructions.
  Results carry `resultType: "complete"`; `tools/list` also carries `ttlMs` and
  `cacheScope: "private"` (the list depends on the token).
- **`2025-11-25`, `2025-06-18`, `2025-03-26` (handshake).** `initialize` negotiates the
  version (a version we speak is echoed; otherwise `2025-11-25` is proposed),
  `notifications/initialized` is accepted, `ping` answers `{}`. Requests without a
  version header are treated as `2025-03-26`.

Only the `tools` capability is offered; `tools/list` is paginated by an opaque
`cursor`. JSON-RPC batches are not accepted.

## What has been tested

- `crates/server/tests/mcp_agent.rs`: an agent runs a small business **only** through
  `tools/call` over HTTP on a real port: workspace, invited teammate, base, linked
  tables with number, select, date, formula, lookup, rollup and count fields, records
  with links, a filtered, sorted and grouped grid and a kanban board queried with
  computed values, edits flowing through formulas, delete and restore, comments,
  mentions and notifications, a public form submitted by an anonymous visitor, an
  automation that really runs, an attachment, CSV export and import into a new table,
  history, and the admin pages. The only steps outside MCP are signing up, accepting
  the invite, the teammate's comment and the visitor's form submission.
- `mcp_tools_icons.rs` (icons set, changed, kept and cleared on a workspace, base and table and
  read back; unknown names with suggestions; `list_icons`), `mcp_tools_email.rs` and
  `admin_email.rs` (the email tools and API: precedence of the environment, write-only password,
  immediate effect, test email errors from an unreachable and a refusing server) and
  `token_capabilities.rs` (credential actions stay session-only for an administrator's token).
- `mcp_tools_schema.rs`, `mcp_tools_people.rs`, `mcp_tools_data.rs`: all 28 field
  types, names in view configurations, type changes, permissions (role vs token),
  base-limited and read-only tokens, admin rules, SSRF refusals, CSV edge cases.
- `mcp_client.rs`: the official Rust SDK (`rmcp` 3.5) connects over a real TCP
  listener with the stateless lifecycle, the `initialize` handshake and automatic
  negotiation, lists the tools and calls several.
- `scripts/mcp-claude-check.sh`: the real `claude` CLI (when installed) adds the
  server with the command shown on the account page and `claude mcp list` reports it
  connected. It runs in a temporary directory with a temporary home, leaving your
  Claude configuration alone.
- `web/contract/mcp.contract.test.ts`: handshake, `tools/list` and tool calls against
  the live server, read back through the web client's REST API.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` "session cookies are not accepted" | the client sent a cookie but no bearer token; configure the `Authorization` header |
| `401` `invalid_token` | the token is wrong, expired, revoked, or its owner was deactivated or changed their password (that deletes all tokens) |
| `403` "Origin is not allowed" | a browser-based client on another origin; add it to `OPENGRID_MCP_ALLOWED_ORIGINS` |
| `429` | rate limit; retry after the `Retry-After` seconds |
| a tool is missing from the list | the token lacks write or `manage`, or its owner is not an administrator (`admin_*`); create another token |
| "not found, or you have no access" | wrong id, or the base is outside the token's base list or the owner's access |
| "Several tables have a view named ..." | view names repeat across tables (every table starts with "Grid view"); pass `table` |
| `claude mcp list` says "Pending approval" | a project-scoped `.mcp.json` server has to be approved once; start `claude` in the project, or add the server with `claude mcp add` |
| the client says the server is not an MCP server | it expects OAuth, or a proxy buffers or rewrites `/mcp`; check with the `curl` command above |
