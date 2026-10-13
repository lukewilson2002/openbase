# OpenGrid MCP server

> **Draft.** This page documents what the code does today. It is complete for the
> transport, tokens, tools and limits; the next pass should add per-client setup
> walk-throughs (Claude Desktop, Claude Code, Cursor, ChatGPT connectors), a
> worked end-to-end example conversation, and screenshots of the account page.

OpenGrid contains an [MCP](https://modelcontextprotocol.io) (Model Context Protocol)
server in the same binary, at `/mcp`. An AI agent that holds one of your personal
access tokens can do everything you can do in the web app, within that token's
permissions, so you never have to open the app yourself if you would rather
describe the work to an agent.

- **Same rules as the app.** Every action goes through the same permission checks,
  validation, history, live updates and automations as a click in the browser.
  Record changes are attributed to you in the record history.
- **Nothing to install.** No extra process, port or dependency. The endpoint is on
  your normal public URL, behind your normal HTTPS.
- **Not for account takeover.** Passwords, two-factor authentication, sessions and
  API tokens can never be read or changed through a token, whatever its scope.

Contents: [Connect an agent](#connect-an-agent) · [Choose a token](#choose-a-token) ·
[Tools](#tools) · [Reaching everything: api_reference and api_request](#reaching-everything-api_reference-and-api_request) ·
[Protocol](#protocol) · [Security](#security) · [Limits and settings](#limits-and-settings) ·
[Troubleshooting](#troubleshooting)

## Connect an agent

1. In OpenGrid open **Account → Tokens → New token**. Pick a name, whether it may
   write, and (only if the agent should manage workspaces and members) the
   "Allow managing workspaces, members and settings" box. Copy the token; it is
   shown once.
2. Point your MCP client at `https://<your OpenGrid>/mcp` (the *Streamable HTTP*
   transport) and send the token as a bearer header:

   ```
   Authorization: Bearer <token>
   ```

Examples:

```sh
# Claude Code
claude mcp add --transport http opengrid https://grid.example.com/mcp \
  --header "Authorization: Bearer $OPENGRID_TOKEN"
```

```json
// Clients configured with a JSON file
{
  "mcpServers": {
    "opengrid": {
      "type": "http",
      "url": "https://grid.example.com/mcp",
      "headers": { "Authorization": "Bearer pat..." }
    }
  }
}
```

The server does not support OAuth sign-in; clients that can only connect through an
OAuth flow cannot use it. A quick check from a shell:

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
| **Read only** | read bases, schema, records, comments; call any `GET` (and view-query) endpoint | the read tools and `api_reference` / `api_request` |
| **Read and write** | additionally create, update and delete records, comment, change tables, fields and views, import CSV, upload files, create bases, manage shares and automations (as far as the owner's role allows) | + `create_records`, `update_records`, `delete_records`, `add_comment` |
| **Write + manage** | additionally create / rename / delete / restore workspaces, change members' roles, remove members, invite people, delete / duplicate / restore bases, and (if the owner is an instance administrator) use the admin pages | + `create_workspace`, `list_members`, `set_member_role`, `create_invite` |

Optionally limit a token to chosen **bases** (a base-limited token cannot see or
touch any other base, through any tool) and give it an **expiry**. A base-limited
`manage` token manages only its bases: workspace-level actions (workspaces,
workspace members and invites, admin) are refused for it.

The permission table, route by route, is in [api.md](api.md#token-permissions).

## Tools

Tools are listed according to the token (a read-only token does not see
`create_records`), and every tool re-checks permissions when called. A call that
fails returns a tool result with `isError: true` and a message that says how to fix
it (for example the valid table and field names); protocol problems are JSON-RPC
errors.

Results are compact JSON text, plus the same data as `structuredContent` when it fits.
Text longer than 100,000 bytes is cut with a note.

| Tool | Needs | What it does |
|---|---|---|
| `list_bases` | any token | Workspaces and bases the token can reach, with your role on each |
| `get_base_schema` `{base_id}` | any | Tables, fields (id, name, type, options), views |
| `list_records` `{base_id, table, view?, filter_by_formula?, fields?, sort?, max_records?, offset?}` | any | Records as `{id, createdTime, fields}` keyed by field **name**; linked records as `{id, name}`; `max_records` defaults to 50 (cap 200); `offset` continues |
| `search_records` `{base_id, table, query, max_records?}` | any | Case-insensitive text search over all fields |
| `get_record` `{base_id, table, record_id}` | any | One record |
| `list_comments` `{record_id}` | any | Comments, oldest first |
| `create_records` `{base_id, table, records: [{fields}], typecast?}` | write | 1-10 records; `typecast` (default true) converts values leniently and creates select choices |
| `update_records` `{base_id, table, records: [{id, fields}], typecast?}` | write | 1-10 records; only the given fields change; `null` clears |
| `delete_records` `{base_id, table, record_ids}` | write | 1-10 records, **to the trash** (restorable for `OPENGRID_TRASH_DAYS`, default 30) |
| `add_comment` `{record_id, body}` | write | Comment as the token's user (`@[Name](usrXXXX)` mentions) |
| `api_reference` `{area?}` | any | The REST endpoint catalogue (see below) |
| `api_request` `{method, path, query?, body?}` | any | Call any catalogued endpoint (see below) |
| `create_workspace` `{name}` | manage | New workspace; the token's user becomes its owner |
| `list_members` `{scope, id}` | manage | Members of a workspace or of a base |
| `set_member_role` `{scope, id, user_id, role}` | manage | Change a member's role |
| `create_invite` `{scope, id, role, email?}` | manage | Create an invite link |

`table` is a table name or id; `base_id` comes from `list_bases`. The record tools
use the code behind the [Airtable-compatible API](api.md#2-airtable-compatible-api-apiv1),
so value shapes, `filterByFormula`, permission checks, history, live updates and
automations behave identically.

## Reaching everything: api_reference and api_request

The curated tools cover everyday data work. For everything else the web app can do
(create tables, fields and views, automations, share links, CSV import, file
upload, trash restore, comments, ...), the agent calls:

1. `api_reference` with no argument: the list of areas. With `{"area": "records"}`:
   every endpoint of the area with method, path, purpose, minimum role, required
   token permission, and a request / response summary.
2. `api_request` with `{method, path, query?, body?}`: the request runs inside the
   server through the real router with the caller's own token, so it is exactly the
   request the web app would make. The result is `{status, ok, body}`; a status of
   400 or more makes the tool result an error.

Details:

- `path` must start with `/api/` and contain real ids; query parameters go in
  `query` (an object; lists repeat the key).
- **Uploads and CSV import** use a multipart body:
  `{"multipart": {"file": {"filename": "people.csv", "text": "Name,Age\nAda,36\n"}, "has_header": true}}`.
  Use `content_base64` instead of `text` for binary files. The whole request is
  capped at 8 MB, so files up to roughly 6 MB.
- **Responses:** JSON and text are returned in full up to 100,000 bytes (then cut,
  with `truncated: true`). Small binary files (up to 64 KB) come back as
  `body_base64`; larger downloads are described but not returned.
- **Refused up front** with a message: anything that is not `/api/...`; `/mcp`
  itself; credential, 2FA, session and token endpoints; sign-in flows; and the
  endless live-update stream. Everything else is the server's own answer: a request
  that needs a permission the token lacks gets the server's `403`, naming the
  `manage` permission where that is what is missing.

The catalogue lives in `crates/server/src/mcp/catalogue.rs`. A test scans the
source for every registered route and fails if one is missing from it.

## Protocol

`POST /mcp` accepts one JSON-RPC 2.0 message per request and answers with one JSON
object (`Content-Type: application/json`); notifications get `202 Accepted`. There
are no sessions and no server-initiated messages, so `GET /mcp` and `DELETE /mcp`
answer `405`. Two protocol generations are served on the same endpoint:

- **`2026-07-28` (current, stateless).** No handshake. Each request carries
  `params._meta["io.modelcontextprotocol/protocolVersion"]` and the headers
  `MCP-Protocol-Version`, `Mcp-Method` and (for `tools/call`) `Mcp-Name`; a
  mismatch is `400` with error `-32020`, an unsupported version `400` with `-32022`
  and the list of supported versions. `server/discover` returns versions,
  capabilities and instructions. Results carry `resultType: "complete"`; `tools/list`
  also carries `ttlMs` and `cacheScope: "private"` (the list depends on the token).
- **`2025-11-25`, `2025-06-18`, `2025-03-26` (handshake).** `initialize` negotiates the
  version (a version we speak is echoed; otherwise `2025-11-25` is proposed),
  `notifications/initialized` is accepted, `ping` answers `{}`. Requests without a
  version header are treated as `2025-03-26`.

Only the `tools` capability is offered; `tools/list` is paginated by an opaque
`cursor`. JSON-RPC batches are not accepted.

## Security

- **Bearer tokens only.** A session cookie is never looked at: a request without a
  valid `Authorization: Bearer` header is `401` with `WWW-Authenticate`. That is the
  reason `/mcp` is exempt from the cookie CSRF header.
- **Origin check (DNS rebinding).** A request carrying an `Origin` header (browsers
  always send one) is served only if the origin is the configured public URL or in
  `OPENGRID_MCP_ALLOWED_ORIGINS`; otherwise `403`. Non-browser clients send no
  `Origin` and are unaffected.
- **Limits.** Bodies up to 8 MB; `OPENGRID_MCP_RATE_PER_TOKEN` and
  `OPENGRID_MCP_RATE_PER_USER` requests per second (invalid tokens cost nothing and
  are never counted).
- **Scope is enforced by the server, not by the tool list.** Hiding a tool is a
  convenience; every request is checked as the web app would check it, by role,
  token write flag, base list and the `manage` permission. Base-limited tokens
  cannot see other bases through any tool or endpoint (tests cover every tool and
  a long list of `api_request` probes).
- **Audit.** Calls an administrator's `manage` token makes to the admin pages are
  recorded in the audit log (`admin_token_use`, with the token id). Token use is
  stamped in the token list ("last used").
- **Prompt injection.** An agent reads text that other people wrote (record
  contents, comments). Anything the agent may do, text it reads might trick it into
  doing: use read-only or base-limited tokens for agents that process untrusted
  content, and avoid `manage` tokens for them.

More in [security.md](security.md).

## Limits and settings

| Setting | Default | Meaning |
|---|---|---|
| `OPENGRID_MCP_RATE_PER_TOKEN` | 30 | requests per second per token |
| `OPENGRID_MCP_RATE_PER_USER` | 100 | requests per second per user |
| `OPENGRID_MCP_ALLOWED_ORIGINS` | none | extra browser origins allowed, comma separated |

Fixed in code: 8 MB request body, 10 records per write call, 200 records per
`list_records` call, 100,000 bytes per tool result, 120 s per `api_request`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` "session cookies are not accepted" | the client sent a cookie but no bearer token; configure the `Authorization` header |
| `401` `invalid_token` | the token is wrong, expired, revoked, or its owner was deactivated or changed their password (that deletes all tokens) |
| `403` "Origin is not allowed" | a browser-based client on another origin; add it to `OPENGRID_MCP_ALLOWED_ORIGINS` |
| `429` | rate limit; retry after the `Retry-After` seconds |
| a tool is missing from the list | the token lacks write or `manage`; create another token |
| "not found, or you have no access" | wrong id, or the base is outside the token's base list or the owner's access |
| the client says the server is not an MCP server | it expects OAuth, or a proxy buffers or rewrites `/mcp`; check with the `curl` command above |
