# OpenBase API

OpenBase has three HTTP surfaces:

| Surface | Prefix | Who uses it | Auth |
|---|---|---|---|
| Airtable-compatible API | `/api/v1` | scripts, n8n/Make/Zapier, existing Airtable client libraries | API token (`Authorization: Bearer`) only |
| Internal API | `/api/...` | the web client | session cookie or API token |
| Public links | `/api/public/...` | share links and public forms | the unguessable link token (+ optional password) |

The internal API is specified in `docs/plans/2026-10-12-openbase.md` §3.1 and typed
in `crates/core/src/api` (exported to TypeScript in `web/src/api/types`). This
document covers the Airtable-compatible API in full, and summarises the public
links and CSV endpoints.

**Projects are called "bases" in the API.** OpenBase and its web app say *project*
(a project holds tables, and lives in a workspace), but the API keeps the older
name so that existing clients and Airtable-compatible tools keep working: routes
are `/api/bases/...` and `/api/v1/meta/bases`, fields are `base_id`, `base_ids`
and `all_bases`, events are `base_changed`, and ids look like `appXXXX`. This
document says "project" in prose and keeps every route and field name exact.

---

## 1. API tokens

Create a token with `POST /api/tokens` from a signed-in session (tokens cannot
create or list tokens themselves):

```json
{ "name": "n8n", "write": true, "manage": false, "base_ids": ["appXXXX"], "expires_in_days": 90 }
```

The secret is shown once. A token acts as its owner, limited further by:

- **write**: a read-only token acts as a Viewer on every project and may only
  read. Every state-changing request (anything but GET/HEAD, apart from view
  queries, which are POSTs) answers `403`, including actions on the owner's own
  data such as deleting a comment or marking notifications read.
- **manage** (needs `write`; default `false`): lets the token do the account-level
  things a signed-in user can do in the web app, see
  [token permissions](#token-permissions) below.
- **base_ids**: the projects the token may reach; any other project answers 404.
  `/api/notifications` only lists (and marks read) notifications of those projects.
- expiry: expired tokens answer 401. Open event streams (`/api/bases/{id}/events`)
  end when their token is deleted or expires.
- Changing or resetting the owner's password deletes all of their tokens.

Roles are the owner's: Viewer < Commenter < Editor < Creator < Owner. Records
can be written by Editors and above. The Airtable API changes no schema, except
that `typecast` may add select options.

### Who can open a project

Access comes only from workspace membership. Each member has one role in the
workspace and either every project (`all_bases`, including projects created later) or
a picked list (`base_ids`); their role applies to each project they can open, and
any other project answers 404. Owners always have every project. A member limited to
some projects who creates or duplicates a project gets it added to their list.

- `GET /api/workspaces` lists the caller's workspaces with the projects they can
  open, `member_count`, `pending_invite_count` and, per project, `people` (members
  who can open it, then pending invites sent to an address).
- `GET|PATCH /api/workspaces/{id}/members[/{user_id}]`: members carry
  `all_bases` and `base_ids`; the owner changes `role`, `all_bases` or
  `base_ids` (at least one project; owners cannot be limited).
- `GET /api/bases/{id}/members` (any role on the project) lists the members who can
  open it; `DELETE /api/bases/{id}/members/{user_id}` takes the project off a
  limited member's list (owners, or the member themself; not their last project,
  and not for all-projects members).
- Invites always join a workspace: `POST /api/workspaces/{id}/invites` (owners;
  every project unless `base_ids` is given) or `POST /api/bases/{id}/invites`
  (creators of that project; that project unless `base_ids` lists other projects they can
  open; never `all_bases`, never above their role). Accepting keeps the higher
  of the invited and existing role and adds up the projects.
- `POST /api/workspaces/{id}/bases` accepts `empty: true` for a project without
  tables; by default it starts with "Table 1".
- Every new table, a project's "Table 1" or one added with `POST /api/bases/{id}/tables`,
  starts with just its primary field "Name" and a grid view; nothing else is added.
  `POST /api/bases/{id}/tables` takes an optional `fields` array to create the rest in
  the same call: each entry has the shape of `POST /api/tables/{id}/fields` (`name`,
  `type`, `options`, `description`, `inverse_name`; `options` may be left out for the
  type's defaults), created in order after "Name". It is all or nothing: if any entry is
  invalid the answer is 400 (or 409 for a name clash), the message begins with the
  entry (`fields[2] 'Status': ...`) and no table is created. A lookup, rollup or count
  may give a link field listed earlier (or "Name") as `options.link_field_id` by name;
  everything else refers to ids as in `POST /api/tables/{id}/fields`. The answer is the
  table with all its fields.

### Token permissions

Every endpoint of the internal API (`/api/...`) falls into one of these classes.
The class is decided in one place (`Actor::require_capability`), and
`tests/token_capabilities.rs` proves it route by route.

| Class | Read-only token | Write token | Write + `manage` token | Session |
|---|---|---|---|---|
| Data: records, comments, tables, fields, views, shares, automations, CSV, attachments, creating a project in a workspace | reads only | yes (the owner's role still applies) | yes | yes |
| **Your inbox** (`/api/inbox*`, and downloading a file uploaded for it): private to you and in no project | reads only | yes, but **403** for a token limited to specific projects | yes, same exception | yes |
| **Manage**: create / rename / delete / restore workspaces, workspace members (role and project access changes, removal), the members of a project (listing, taking a project off a member's list), invites (create, list, revoke, accept), deleting, duplicating and restoring projects, workspace trash, `PATCH /api/auth/me` (name, time zone, `intro_seen`) | 403 | 403 | yes (the owner's role still applies) | yes |
| **Admin** pages (`/api/admin/*`: users, email settings, audit log, stats, listing and creating backups) | 403 | 403 | only if the owner is an instance administrator; every call is written to the audit log (`admin_token_use`, naming the token). Credential parts are session-only, see below | administrators |
| **Session only**: `/api/auth/password`, `/api/auth/2fa/*`, `/api/auth/passkeys*` (list, register, rename, remove), `/api/auth/sessions*`, `GET/POST /api/tokens`, `DELETE /api/tokens/{id}`, `POST /api/admin/users/{id}/reset-link`, `DELETE /api/admin/users/{id}/passkeys`, `GET /api/admin/backups/{name}` (downloading a backup archive: it holds every password hash, two-factor secret and the SMTP password), the OAuth consent step and the connected-apps lists (`/api/oauth/*`, `/api/admin/oauth/*`) | 403 | 403 | **403** | yes |
| **Session-only parts of admin requests**: `disable_2fa` in `PATCH /api/admin/users/{id}`; `password` in `POST /api/admin/users` (and the `reset_link` in its answer); `password` in `PATCH /api/admin/email` | 403 | 403 | **403** for that part (the whole request is refused, nothing is changed) | administrators |

Apps that connected through OAuth (see [MCP](mcp.md#connect-with-oauth-sign-in)) hold a grant with
the same read / write / `manage` / project-list scope, but its access tokens are valid on `/mcp`
only: the REST API and `/api/v1` answer `401` to them (the MCP tool `api_request` runs requests
as the grant, inside the server, with these same classes).

A request that needs `manage` and does not have it answers `403` with a message that
names the `manage` permission. Actions that reach beyond a single project (workspaces,
workspace members and invites, the admin pages) are also refused for a `manage` token
that is limited to specific projects (`base_ids`): such a token cannot touch what it
cannot see. Project-level management (deleting a project, the members of a project, project
invites, restoring a project) works on the projects in its list only; others answer 404. Credentials,
sessions and tokens are never reachable with a token, so a leaked token cannot take
over the account or mint a longer-lived replacement. `GET /api/tokens/whoami` reports
`write` and `manage`.

**Credentials and administrators.** The owner's rule is that a token never changes a
credential, so an instance administrator's `manage` token cannot create a password-reset
link for any user (that would be an account takeover), cannot switch off a user's
two-factor authentication, cannot remove a user's passkeys, and cannot set the SMTP password. `POST /api/admin/users` with a
token creates the account (name, email, optional administrator role) but without a usable
password: it refuses `password` and returns no `reset_link`; a signed-in administrator
creates the reset link in the app, or the person uses "Forgot password" when email is on.
Email settings (`GET|PATCH /api/admin/email`, `POST /api/admin/email/test`) are open to the
administrator's `manage` token, except that it can neither set nor remove the SMTP password,
and cannot change the host, port, security mode or username while a password is in use
(that would send the password to a server of its choosing); it can switch email off.

An AI agent can use all of this through the built-in MCP server; see [mcp.md](mcp.md).

### Passkeys (internal API)

Passkey sign-in uses the WebAuthn browser API; the endpoints below carry its JSON. All are JSON,
cookie requests need the `X-OpenBase-CSRF: 1` header like every state-changing call, and all except
the two sign-in calls are session-only.

| Endpoint | Purpose |
|---|---|
| `GET /api/auth/passkeys` | The caller's passkeys: `[{id, name, created_at, last_used_at, transports, backup_eligible, backup_state}]`. Never the key or the credential id. |
| `POST /api/auth/passkeys/register/start` | Body `{password?}`. Answers `{challenge_id, options}`: `options` is the `navigator.credentials.create()` argument with `challenge`, `user.id` and `excludeCredentials[].id` in base64url. `403 reauth_required` when the session is older than 10 minutes and no password is sent. |
| `POST /api/auth/passkeys/register/finish` | Body `{challenge_id, name?, credential}` (the created credential with its binary members as base64url). `201` with the new passkey. |
| `PATCH /api/auth/passkeys/{id}` | Body `{name}`. |
| `DELETE /api/auth/passkeys/{id}` | `204`. |
| `POST /api/auth/passkey-login/start` | Anonymous. Answers `{challenge_id, options}` for `navigator.credentials.get()` (no account named: the passkey identifies it). Limited per client address. |
| `POST /api/auth/passkey-login/finish` | Anonymous. Body `{challenge_id, credential}`. Answers like a password login (`{user, two_factor_required: false}`) and sets the session cookie; passkey sign-in never asks for the TOTP code. `401 invalid_passkey` for any refusal, `401 passkey_expired` for an unknown or used challenge, `403` for a deactivated user, `429` over the per-address limit. |
| `DELETE /api/admin/users/{id}/passkeys` | Administrators, signed in. Removes all of the user's passkeys; answers `{removed}`. |

`GET /api/setup` reports `passkeys_enabled` (false when `OPENBASE_PUBLIC_URL` is an IP address).
How passkeys are protected: [security.md](security.md#passkeys).

### Presence (internal API)

Who has a project open right now. (The routes keep the name `bases`: see the note at the top.)
Presence lives in memory only (a restart empties it and clients reconnect). Every open live-update
stream, `GET /api/bases/{id}/events`, counts its user as a viewer of that project, whatever the
credential (session or API token); several streams (tabs) of one user count once.

| Endpoint | Purpose |
|---|---|
| `GET /api/bases/{id}/presence` | `{viewers: [user_id, ...]}`: everyone with an open stream on the project, in the order they arrived. Same access as reading the project (Viewer role; a read-only token may call it). |
| `GET /api/bases/{id}/events` | Also sends `presence_changed` with `data` `{base_id, user_id, event: {kind: "presence_changed", viewers: [...]}}` to the streams already open when a user's **first** stream opens or their **last** one closes (closing the tab, losing access, the server stopping). `user_id` is the person who arrived or left. Every new stream also starts with the current list as its first event, right after the `: connected` comment: a `presence_changed` frame whose `user_id` is `null` and whose `viewers` already include the new viewer, so a client needs no separate `GET /presence` and cannot miss an arrival between the two. The stream is not told about its own arrival a second time. Presence never counts as a data change (no view cache is invalidated). |

### Inbox (internal API)

The inbox holds a person's private quick-capture drafts: Markdown text plus uploaded files, not yet in
any project. Only their owner sees them (anyone else gets `404`, like a missing draft). They work with
sessions and API tokens, in the token's owner's inbox; a read-only token can only list. A token limited to
specific projects (also an OAuth grant limited to some projects) gets `403` on every route below, filing included,
and on downloading an inbox file: the inbox is in no project, so such a token has no business in it. Timestamps
are Unix milliseconds; ids start with `inb`.

Limits: a draft's text is at most 100,000 characters, a draft holds at most 20 files, one person keeps at
most 500 drafts, a file can be in one draft at a time (`400` otherwise), the files a person has uploaded but
not filed add up to at most 200 MB (`OPENBASE_MAX_INBOX_MB`; `413` beyond), and uploads are limited to 60
per minute per person (`429`).

| Endpoint | Purpose |
|---|---|
| `GET /api/inbox` | Your drafts, most recently changed first: `[{id, body, attachments, created_at, updated_at}]`. |
| `POST /api/inbox` | Body `{title?, body?, attachments?}`; `201` with the draft. `title` is one line (line breaks become spaces, at most 1,000 characters) and may be empty, like `body`. `attachments` must be your own unfiled uploads that no other draft holds. `body` may embed or link your own unfiled uploads by address (see [Files in long text](#files-in-long-text-internal-api)); a reference to anything else (someone else's upload, a project's file, a missing file) is a `400` naming the id, and so is a file another draft already holds, in its file list or its text. References a draft's current text already has are left alone when you edit it. |
| `PATCH /api/inbox/{id}` | Body `{title?, body?, attachments?}`: what is given changes, `attachments` replaces the whole list. |
| `DELETE /api/inbox/{id}` | `204`. Permanent: drafts have no trash. |
| `POST /api/inbox/attachments` | Multipart field `file` (the upload limit applies, and so does your inbox quota). Answers the attachment reference `{id, filename, mime, size, ...}` to put in a draft's `attachments`. The file belongs to no project yet: only its uploader can download it (`GET /api/attachments/{id}/{filename}`). Files no draft or record refers to are cleaned up like any unreferenced upload. |
| `POST /api/inbox/{id}/file` | Body `{table_id, fields, note_as_comment?}`; `201` with the created record. `fields` is keyed by field name or id and read like the Airtable-compatible API (typecast on). Needs the Editor role on the table's project (`403`; `404` when you cannot see it). It goes through the normal record write path, so validation, history, live-update events and automations apply. To keep the draft's files, put them (`{"id": "att..."}` is enough) in an attachment field: they move into the table's project (a bare id mentioned in a text field does not move anything). Your unfiled uploads that a long text value in `fields` embeds or links by address (`/api/attachments/{id}/...`), or that the draft's text embeds when `note_as_comment` is set, move into the project too, even when they are not in the draft's file list; the record and its comment are then written with the ordinary ownership rule, so a reference to someone else's upload, a file of another project or a missing file fails the whole filing with `400`. The draft's text is not copied anywhere by itself: put it in a long text field, or send `note_as_comment: true` to add it as the record's first comment, by you (at most 10,000 characters, else `400`). Creating the record, adding the comment, moving the files and deleting the draft are one transaction: if anything fails, the draft and its files stay as they were. |
### Files in long text (internal API)

Long text (Markdown) can embed and link uploaded files by their download address. An **embed** is Markdown
image syntax on a line of its own, a **link** the usual link syntax; the address is relative (no host) and the
file name is percent-encoded:

```
![Alt text](/api/attachments/attXXXXXXXXXXXXXX/site%20photo.png "Caption")
[the report](/api/attachments/attXXXXXXXXXXXXXX/report.pdf)
```

Alt text and caption are optional (`![](...)` is valid). The reference carries no type: clients pick the
player from the file name extension, and the server decides how to serve the bytes (below). Only references
in the exact `/api/attachments/{id}/` form count; an id written bare in prose is just text. `POST
/api/bases/{id}/attachments` answers the reference to build the address from (`id`, `filename`); the
MCP tool `upload_attachment` also returns the finished line as `markdown`.

**Ownership on save.** Every `/api/attachments/{id}/` reference inside a **long text** value written to a
record must name a file of the record's project, exactly like attachment cells. Otherwise the write fails
with `400` (`422` in `/api/v1`) and `field "Notes": attachment attXXX is not a file of this project; upload
the file to this project to embed or link it`. The rule covers every write path: the app, `/api/v1`, CSV import,
automations, MCP and the inbox filing, and a file that does not exist is refused like another project's file.
A reference the value being replaced already contains is not checked again, so editing other text of an old
value never fails. Comments follow the same rule (`400`, `attachment attXXX is not a file of this project; ...`).
Changing a field of another type to long text is refused with `400` (`field "Tag" cannot become long text:
N record(s) refer to files that are not files of this project: rec... (att...)`, naming up to five records,
trashed ones included) while any of its values carries such a reference; remove the references first.
Duplicating a project copies the files its attachment cells and long text embed and points the copy at them,
but only files of the source project: a reference to any other file (another project's, an inbox upload) is
never copied, so a copy cannot be used to read it. In an attachment cell it is dropped, in long text it is left
as written and does not load in the copy.

**Cleanup.** Files referenced only from long text, a comment, record history or an inbox draft's text stay: the
cleanup looks for attachment ids in all record data, in comments and in the draft text, not just in attachment fields.

**Serving.** `GET /api/attachments/{id}/{filename}` is allowed for Viewers of the file's project (session or
token), for holders of an enabled view share link of the project (below) and, for an inbox upload, only for its
uploader. Sniffed raster images (png, jpeg, gif, webp), **video** (mp4, mov, webm, ogg with Theora) and
**audio** (mp3, aac, mp4/m4a, ogg, wav, flac) are served inline with their real `Content-Type`; the bytes
decide, never the file name or the stored type. Everything else (HTML, SVG, PDF, a video whose bytes are not
a video, ...) is an `application/octet-stream` attachment. Every response keeps `nosniff` and
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, max-age=86400` and sends
`Accept-Ranges: bytes`. One `Range: bytes=first-last`, `bytes=first-` or `bytes=-count` is answered
`206 Partial Content` with `Content-Range: bytes first-last/length` (so players can seek); a range outside the
file is `416` with `Content-Range: bytes */length`; several ranges or malformed values are ignored and the
whole file is sent. Bodies are streamed. Thumbnails support `Range` too.

**External media is not embedded.** `![](https://...)`, or any address not starting with `/api/attachments/`,
is shown by the web app as an ordinary link and never fetched by the browser; the editor does not create one.

---

## 2. Airtable-compatible API (`/api/v1`)

Point an Airtable client at `https://<your server>/api/v1` instead of
`https://api.airtable.com/v0`, and use an OpenBase token in place of an
Airtable personal access token:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://base.example.com/api/v1/meta/bases"

curl -H "Authorization: Bearer $TOKEN" \
  "https://base.example.com/api/v1/$BASE_ID/Tasks?filterByFormula=%7BStatus%7D%3D%27Todo%27&sort%5B0%5D%5Bfield%5D=Due"
```

### 2.1 Authentication and rate limits

- **Bearer tokens only.** The session cookie is never read, so a browser
  signed in to OpenBase cannot be driven through this API (no CSRF surface);
  a request with only a cookie is `401 AUTHENTICATION_REQUIRED`.
- **Rate limits** (fixed one-second windows): **5 requests/second per token**
  and **50 requests/second per user** (all of a user's tokens together). Over the
  limit: `429 RATE_LIMIT_REACHED` with `Retry-After: 1`. Server operators can
  change both with `OPENBASE_V1_RATE_PER_TOKEN` / `OPENBASE_V1_RATE_PER_USER`.
  Unlike Airtable there is no 30 second penalty.
- Requests with unknown or expired tokens are answered 401 before any limit is
  applied.

### 2.2 Errors

Every error, including unknown paths and malformed bodies, is

```json
{ "error": { "type": "UNKNOWN_FIELD_NAME", "message": "Unknown field name: \"Nope\"" } }
```

| Status | `type` | When |
|---|---|---|
| 401 | `AUTHENTICATION_REQUIRED` | no, invalid or expired token; cookie-only request |
| 403 | `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` | the token cannot write (read-only token, or the owner is below Editor on the project) |
| 404 | `NOT_FOUND` | unknown/inaccessible project (a project outside a token's `base_ids` or one the user cannot see is a 404, not a 403), table, record, or route |
| 405 | `METHOD_NOT_ALLOWED` | |
| 409 | `CONFLICT` | a write would exceed the recompute budget |
| 413 | `REQUEST_BODY_TOO_LARGE` | body over 4 MB |
| 422 | `INVALID_REQUEST_UNKNOWN` | malformed JSON or parameters, more than 10 records, empty batch, a table at its record limit |
| 422 | `UNKNOWN_FIELD_NAME` | a field name/id in `fields`, `fields[]` or `sort` that the table does not have |
| 422 | `INVALID_VALUE_FOR_COLUMN` | a value the field cannot take (wrong type, out of range, writing a computed field, unknown record/collaborator/attachment ids) |
| 422 | `INVALID_MULTIPLE_CHOICE_OPTIONS` | a select option that does not exist, without `typecast` |
| 422 | `INVALID_FILTER_BY_FORMULA` | `filterByFormula` does not parse, names an unknown field or fails type checking |
| 422 | `LIST_RECORDS_ITERATOR_NOT_AVAILABLE` | the `offset` expired, is unknown, belongs to someone else, or was made for different parameters |
| 422 | `VIEW_NAME_NOT_FOUND` | the `view` parameter names no view of the table |
| 429 | `RATE_LIMIT_REACHED` | see above |
| 500 | `SERVER_ERROR` | logged; the message is generic |

All batches are **atomic**: if any record fails, nothing is written.

### 2.3 Metadata

`GET /api/v1/meta/bases` → `{"bases": [{"id", "name", "permissionLevel"}]}`.
`permissionLevel` is `read`, `comment`, `edit` or `create` (Creators and
Owners), capped at `read` for read-only tokens. Projects a token cannot reach are
not listed. There is no pagination (no `offset`).

`GET /api/v1/meta/bases/{baseId}/tables` →

```json
{ "tables": [{
    "id": "tblXXXX", "name": "Tasks", "description": "…", "primaryFieldId": "fldXXXX",
    "fields": [{ "id": "fldXXXX", "name": "Status", "type": "singleSelect",
                 "description": "…", "options": { "choices": [{ "id": "selXXXX", "name": "Todo", "color": "blue" }] } }],
    "views": [{ "id": "viwXXXX", "name": "Grid", "type": "grid" }]
}] }
```

Field `type` names and options:

| Airtable type | OpenBase field | `options` |
|---|---|---|
| `singleLineText`, `email`, `url`, `phoneNumber`, `barcode` | single line text, email, URL, phone, barcode | none |
| `multilineText` / `richText` | long text / long text with markdown on | none |
| `number`, `percent` | number, percent | `{precision}` |
| `currency` | currency | `{precision, symbol}` |
| `duration` | duration | `{durationFormat}` (`h:mm`, `h:mm:ss`, `h:mm:ss.S`, …) |
| `rating` | rating | `{icon, max, color}` |
| `checkbox` | checkbox | `{icon, color}` |
| `singleSelect`, `multipleSelects` | single / multiple select | `{choices: [{id, name, color}]}`; `id` and `color` are optional when creating (a missing colour is chosen from the name: Critical red, High orange, Medium yellow, Low and Done green, and so on; other names cycle through the palette) |
| `date`, `dateTime` | date, date with time | `{dateFormat: {name, format}}`, plus `timeFormat` and `timeZone` for `dateTime` (`client` when the field shows each viewer's zone) |
| `multipleAttachments` | attachment | `{isReversed: false}` |
| `multipleRecordLinks` | link to another table | `{linkedTableId, isReversed: false, prefersSingleRecordLink, inverseLinkFieldId, viewIdForRecordSelection?}` |
| `singleCollaborator` / `multipleCollaborators` | user (single / multiple) | none |
| `formula` | formula | `{isValid, referencedFieldIds, result: {type, options?}}` (the expression itself is not exposed) |
| `multipleLookupValues` | lookup | `{isValid, recordLinkFieldId, fieldIdInLinkedTable, result}` |
| `rollup` | rollup | `{isValid, recordLinkFieldId, fieldIdInLinkedTable, referencedFieldIds, result}` |
| `count` | count | `{isValid, recordLinkFieldId}` |
| `createdTime`, `lastModifiedTime` | created / last modified time | `{result: {type: "dateTime", options}}` (+ `referencedFieldIds` for last modified) |
| `createdBy`, `lastModifiedBy` | created / last modified by | none (`referencedFieldIds` for last modified) |
| `autoNumber` | autonumber | none |
| `button` | button | `{label}` |

Views are the table's shared views plus the caller's own personal views. View
types: `grid`, `form`, `gallery`, `kanban`, `calendar`, `timeline`, and `list`
(OpenBase's list view; Airtable has no equivalent).

### 2.4 Listing records

`GET /api/v1/{baseId}/{tableIdOrName}` where `tableIdOrName` is the table id or
its exact name (ids win). Response: `{"records": [{"id", "createdTime",
"fields"}], "offset"?}`.

| Parameter | Behaviour |
|---|---|
| `pageSize` | 1 to 100, default 100. Larger or invalid values are a 422. |
| `maxRecords` | caps the total number of records across all pages. |
| `offset` | pass the `offset` of the previous response to get the next page; absent on the last page. See below. |
| `view` | a view id or name. Only that view's records, in its order (its filter and sort apply). Fields hidden in the view are still returned, as in Airtable. Personal views of other users and views of other tables are `VIEW_NAME_NOT_FOUND`. |
| `fields[]` | only these fields, by name or id (`fields[]=Name&fields[]=Status`; `fields=` also works). |
| `sort[i][field]`, `sort[i][direction]` | sort levels (`asc` default, or `desc`), field by name or id; at most 10 levels. Replaces the view's sort. |
| `filterByFormula` | keep records for which the formula is truthy (see below). Evaluation is cut off after 5 seconds per request (422 `INVALID_FILTER_BY_FORMULA`); a single record whose formula exceeds the evaluation budget counts as not matching. |
| `returnFieldsByFieldId` | key `fields` by field id instead of name. |
| `includeEmpty` | OpenBase extension (not in Airtable). `true` returns fields with no value as `null` instead of omitting them, so a client can infer the columns from the records (also for a table with no values yet). Only the fields selected by `fields[]` are included. Default `false` (Airtable-compatible omission); anything but a boolean is a 422. |
| `cellFormat` | only `json` (the default). `string` is a 422. |
| `timeZone`, `userLocale` | accepted. `timeZone` (validated IANA name) sets the zone for relative date filters of the `view` and for the formula; `userLocale` is accepted and ignored (English only). |
| other parameters | ignored (`recordMetadata[]`, …). |

**Offsets.** The first request of a multi-page listing takes a snapshot of the
matching record ids (in memory, for 5 minutes, at most 256 snapshots / 1 million
ids server-wide); `offset` is an opaque string naming the snapshot and the next
position. Paging is therefore **stable while you edit what you are paging
through** (the common "read a page, update its records, read the next page"
loop never skips or repeats a record, even when the update changes the
`filterByFormula`/`sort` result): records changed in between show their
current values, deleted ones drop out, new ones are not part of the listing.
An offset is only valid for the same user, table and parameters (`view`,
`sort`, `filterByFormula`, `maxRecords`, `timeZone`; `pageSize` and `fields[]`
may change); anything else is `422 LIST_RECORDS_ITERATOR_NOT_AVAILABLE`, and the
client restarts the listing without an offset.

**`filterByFormula`** uses OpenBase's Airtable-compatible formula language
(`docs/plans`, section on formulas): `{Field Name}` references (or
`{fldXXXX}` ids), the same functions and the same truthiness as Airtable (0, `""`,
blank and `FALSE()` are false). It is evaluated for each record of the (view or
table) listing, in the viewer's time zone. Invalid formulas, unknown field names
and unknown functions are `INVALID_FILTER_BY_FORMULA` with the position of the
problem in the message. A formula that evaluates to an error for a record
excludes that record. Formulas are limited to 10,000 characters.

`GET /api/v1/{baseId}/{table}/{recordId}` returns one record without an
envelope (`returnFieldsByFieldId` and `includeEmpty` are supported); records of trashed records or
other tables are 404.

### 2.5 Value shapes

Records are rendered the way Airtable renders them. **Empty cells are omitted**
(unless `includeEmpty=true` is passed on a read, which returns them as `null`),
checkboxes are `true` or absent.

| Field | Value |
|---|---|
| text, email, URL, phone | string |
| barcode | `{"text": "…"}` (no `type`) |
| number, currency, duration (seconds), rating, autonumber, count | number |
| percent | number as a fraction (`0.25` is 25%), as in Airtable |
| checkbox | `true` |
| single select | choice name |
| multiple select | array of choice names |
| date | `"2026-04-01"` |
| date with time, created/modified time | ISO 8601 UTC with milliseconds, `"2026-04-01T09:30:00.000Z"` |
| attachments | `[{id, url, filename, size, type, width?, height?, thumbnails?}]` |
| linked records | array of record ids (not `{id, name}`) |
| single collaborator, created/modified by | `{id, email, name}` |
| multiple collaborators | array of `{id, email, name}` |
| formula, lookup, rollup | the materialized value (formula errors are `{"error": "…"}`) |
| button | `{label, url}` |

Attachment `url`s are **absolute** (built from `OPENBASE_PUBLIC_URL`) and, unlike
Airtable's, need the same bearer token (or a signed-in session) to download.
`thumbnails` (images only) has `small` and `large` pointing at OpenBase's single
400 px thumbnail and `full` at the original, each with `url`, `width`, `height`.

### 2.6 Writing records

All writes go through the same engine as the web app: values are validated,
links are kept in sync with their inverse fields, computed fields are
recomputed, record history records the token's owner, and live-update events
reach open browser tabs.

**Create** — `POST /api/v1/{baseId}/{table}`

```json
{ "records": [{ "fields": { "Name": "Ada", "Status": "Todo" } }], "typecast": true }
```

or a single `{"fields": {...}}` (answered with the bare record). Up to **10**
records per request, answered `200 {"records": [...]}` in request order.
(Airtable also answers 200.)

**Update** — `PATCH` merges, `PUT` replaces:
`PATCH|PUT /api/v1/{baseId}/{table}` with `{"records": [{"id", "fields"}]}` (up
to 10), or `PATCH|PUT /api/v1/{baseId}/{table}/{recordId}` with `{"fields"}`.
`PATCH` changes only the fields given (`null` clears one); `PUT` clears every
**editable** field that is not given (computed fields cannot be cleared).
Updates that change nothing write nothing (no history entry, no
`last modified` bump).

**Delete** — `DELETE /api/v1/{baseId}/{table}?records[]=rec1&records[]=rec2`
(1 to 10) → `{"records": [{"id", "deleted": true}]}`; or
`DELETE .../{recordId}` → `{"id", "deleted": true}`. Deletes move records to the
trash (restorable in the web app); a missing id fails the whole request.

Common body options: `typecast` (below) and `returnFieldsByFieldId`.

**Field keys.** `fields` objects may use field names or field ids. Naming one
field twice (by name and by id) is a 422.

**Typecast.** Without `typecast`, values must have the field's natural JSON type
(numbers as numbers, checkboxes as booleans, multiple selects as arrays) and
select values must name existing options (`INVALID_MULTIPLE_CHOICE_OPTIONS`
otherwise). With `"typecast": true`, strings are read like pasted text
(`"$1,200"`, `"25%"`, `"yes"`, `"March 5, 2026"`, `"1:30:00"`, `"a, b"` for
multiple selects), numbers become text for text fields, out-of-range ratings
are clamped, and **missing select options are created**.

**Input shapes** (where they differ from the output shapes):

- select fields take names (matched case-insensitively; ids work too);
- linked records take an array of record ids (`["recXXXX"]`, or `[{"id"}]`);
  the ids must be live records of the linked table;
- collaborators take `{"id"}` or `{"email"}` (or an array of them for multiple
  collaborator fields); the person must have access to the project;
- attachments take `[{"id": "attXXXX"}]`, the id of a file uploaded to the same
  project with `POST /api/bases/{id}/attachments` (session or token with write
  access). OpenBase does **not** fetch `url`s on a client's behalf (SSRF), so
  `[{"url": …}]` is a 422;
- long text may embed or link files of the same project as `/api/attachments/{id}/{filename}` addresses
  (see [Files in long text](#files-in-long-text-internal-api)); a file of another project, or one that
  does not exist, is a 422;
- barcode takes `{"text"}` or a string;
- computed fields (formula, lookup, rollup, count, created/modified time/by,
  autonumber, button) cannot be written: `INVALID_VALUE_FOR_COLUMN`.

### 2.7 Differences from Airtable

| Airtable | OpenBase |
|---|---|
| `https://api.airtable.com/v0/…` | `https://<server>/api/v1/…`; project ids look like `appXXXX`, table ids `tblXXXX`, field ids `fldXXXX`, record ids `recXXXX` |
| personal access tokens with scopes | OpenBase API tokens: read/write plus an optional project list; there is no schema scope because this API cannot change schema |
| schema changes, webhooks, comments, collaborators API | not provided; use the internal API (`/api/...`) or automations |
| `POST …/listRecords` | not provided (use `GET`) |
| `performUpsert` | 422 (update by record id) |
| `cellFormat=string` | 422 (values are always JSON) |
| `userLocale` | accepted, ignored |
| `recordMetadata[]=commentCount` | ignored |
| attachment URLs in writes | not fetched; use uploaded file ids |
| attachment URLs on reads | absolute, need the bearer token, thumbnails have one real size |
| `offset` expires after 5 minutes | same, and offsets also stay valid while you edit the listed records |
| rate limit 5 req/s per base, 30 s penalty | 5 req/s per token and 50 req/s per user; retry in the next second |
| a read-only/unreachable base → 403 or 404 | an inaccessible project is always 404, a read-only token writing is 403 |
| 2xx for create is 200 | same |
| select colors like `blueLight2` | OpenBase's palette names (`blue`, `blue_dark`, …) |
| barcode `{"type", "text"}` | `{"text"}` |
| formula booleans as `1`/absent | booleans as `true`/`false` |
| `lookup`/`rollup` `options.result` details | simplified: `{type, options?}` of the result type |

---

## 3. Public share links and forms

Creators manage links on a view: `GET|POST /api/views/{id}/shares`
(`{"kind": "view" | "form", "password"?}`), `PATCH /api/shares/{id}`
(`{"enabled"?, "password"? | null}`), `DELETE /api/shares/{id}`. A form link
needs a form view; a read-only link needs any other view; personal views cannot
be shared. At most 20 links per view. Passwords are stored as Argon2id hashes.
A public link follows its view's live configuration, so while a view has an
enabled link, changing the shown fields, their order, the filter or the form
needs the Creator role (403 for Editors; widths, sorts, colours and renames
stay open to Editors).

Public endpoints take no credentials; the token in the URL is the capability.
A password-protected link wants the header `X-Share-Password` (401
`share_password_required` / `share_password_invalid`). Disabled, deleted or
wrong-kind links are 404, like unknown tokens. All responses are
`Cache-Control: no-store`; requests are rate limited per client IP (300/min),
per token (1,200/min), password checks (30/min) and form traffic (20 submits
and 20 uploads per 10 minutes per IP and link). Anonymous form uploads also
have hourly byte budgets: 200 MB per client IP, 500 MB per project and 1,000 MB
for the whole server (429 when used up; a request is charged its declared
length). Unattached public-form uploads are deleted after 2 hours.

| Endpoint | Purpose |
|---|---|
| `GET /api/public/shares/{token}` | the shared view: name, layout config and **only the visible fields** (hidden fields and field order of the view apply) |
| `POST /api/public/shares/{token}/query` | records (`QueryRequest`: `offset`, `limit`, `search`, `range`, `timezone`, `transient`). `search` is at most 500 characters (400 otherwise). Search, ranges and `transient` filter/sort/group overrides may only use visible fields (400 otherwise). `groups` carries at most 1,000 headers, each with `key`/`label` cut to 200 characters and `value` always `null`; keys of user fields are placeholders (`user-0`, ...), never user ids. Records contain only visible fields; user values are `[{"name"}]`, created/modified-by `{"name"}`; **no user ids, e-mail addresses or creator/editor metadata** ever appear |
| `GET /api/attachments/{id}/{filename}?share={token}` (also `/api/attachments/{id}/thumb`) | attachment files **the shared view shows**: the id must be in a visible attachment field, or referenced (`/api/attachments/{id}/...`) in a visible long text field, of a live record the view's filter lists, otherwise 404 (`Range` requests work as for signed-in users) (also for files of other tables, hidden fields, filtered-out or trashed records, and uploads not yet attached to a record). Send `X-Share-Password` when protected. Counts against its own rate limits (600/min per IP, 2,400/min per token) and the shared password limit (30/min per IP and link; 429 beyond) |
| `GET /api/public/forms/{token}` | the form: title, description, fields with label/help/required/options |
| `POST /api/public/forms/{token}/submit` | `{"values": {fieldId: value}}` creates one record anonymously (history source `form`, no user). Only form fields are accepted, required fields are enforced, values are read leniently like a browser form but **never create select options**. **Link and user fields are not collected by public forms** (they would need pickers over other data), even if listed in the form's config |
| `POST /api/public/forms/{token}/attachments` | multipart `file` for an attachment field of the form (at most 25 MB, further capped by the upload limit) |

---

## 4. CSV

- `GET /api/views/{id}/export.csv?timezone=` (Viewer): the view's visible
  fields in view order, filter and sort applied, cells as display text (dates
  in `timezone`, default the caller's zone), streamed in 500-record pages
  from the list of matching records taken when the export starts (edits made
  while it streams cannot repeat or skip rows).
  UTF-8 with a BOM, CRLF, RFC 4180 quoting. Cells (and headers) starting with
  `=`, `+`, `-`, `@`, TAB or CR get a leading `'` so spreadsheets do not run
  them as formulas (numbers keep their sign). The file name is the view name,
  sanitized.
- `POST /api/tables/{id}/import` (Editor): multipart `file` (CSV, at most 20 MB,
  100,000 rows, 500 columns and 3,000,000 cells, counting every row as padded
  to the widest one; at most two imports run at the same time, others wait),
  `mapping` (JSON `{csvColumn: fieldId | null}`;
  columns are header names, or zero-based numbers when `has_header` is
  `false`; omitted = match by field name) and `has_header` (default `true`).
  Values are read with typecast. **All or nothing**: any bad row gives
  `422 {"error": {"code": "import_failed", "rows": [{"row", "message"}], …}}`
  with the first 50 problems, and nothing is written. BOMs, CRLF/LF, ragged rows
  and quoted newlines are handled.
- `POST /api/bases/{id}/import` (Creator): multipart `file`, optional `name`,
  `has_header`; creates a new table with inferred field types and imports every
  row, again atomically.

---

## 5. Aggregation (group-by)

`POST /api/tables/{id}/aggregate` (Viewer; read-only tokens may call it, MCP: the
`aggregate_records` tool) counts, sums, averages and takes the minimum or maximum of
a table's records per group, computed on the server in one pass instead of paging every
record to the client. Request (all optional):

```json
{
  "group_by": ["Status", "Owner"],
  "aggregates": [
    {"function": "count"},
    {"function": "sum", "field": "Amount"},
    {"function": "avg", "field": "Amount", "alias": "mean_amount"},
    {"function": "max", "field": "Due"}
  ],
  "view": "Open work",
  "filter_by_formula": "{Region}='EU'",
  "sort": [{"by": "sum_Amount", "direction": "desc"}],
  "limit": 1000,
  "timezone": "Europe/Berlin"
}
```

Response:

```json
{
  "group_by": ["Status", "Owner"],
  "groups": [
    {"group": {"Status": "Done", "Owner": ["Ada"]}, "aggregates": {"count": 3, "sum_Amount": 42.5, "mean_amount": 14.17, "max_Due": "2026-03-20"}}
  ],
  "total_groups": 1, "truncated": false, "record_count": 3
}
```

- **Selecting records** works as in listing: `view` (name or id; its filter applies, personal
  views of others are not found) and/or `filter_by_formula` (an Airtable formula, the same
  5-second evaluation budget); with neither, every record is included. The caller needs the
  Viewer role on the project, exactly as for listing.
- **`group_by`**: up to 3 fields, by name or id; none gives one row with the totals (also for an
  empty table: count 0, sum 0, others `null`). Groups are the same as the grid's grouping:
  a multiple select, link or user field groups by the exact combination of its values, dates by
  calendar day in `timezone` (default the caller's), and empty cells form one group. Buttons
  cannot be grouped. Groups come ordered by their values (blanks first) unless `sort` says
  otherwise (`by` is an aggregate alias or a group-by field); `limit` (default 1000, at most
  10,000) cuts the list and `truncated` / `total_groups` report it.
- **Group values** are names, never ids: text, number and checkbox values as they are, a single
  select as its choice name, links, users and multiple selects as arrays of names, dates as
  `YYYY-MM-DD`, and `null` for the empty group.
- **`aggregates`** (default one `count`, at most 20): `count` without `field` counts records, with
  a `field` it counts records where the field is filled (a checkbox: checked); `sum` and `avg`
  need a number-like field (number, currency, percent, duration, rating, autonumber, count, or a
  formula, rollup or lookup returning a number); `min` and `max` take number or date fields (dates
  come back as `YYYY-MM-DD` or an ISO instant). Empty cells are skipped: `sum` of nothing is 0,
  `avg`, `min` and `max` of nothing are `null`. Values are keyed by `alias`, default `count` or
  `<function>_<Field name>`; aliases must be unique.
- **Errors** are 400 (MCP: a tool error) naming the problem and what would work: an unknown field,
  `sum` of a text field, a group by a button, `sum` without a field, two aggregates with the same
  alias, an invalid formula, an unknown view.

## 6. Relative date filters and time zones

A date filter (`is`, `is_before`, `is_after`, `is_on_or_before`,
`is_on_or_after`, `is_within`) takes a `DateOperand`. The relative modes
(`today`, `tomorrow`, `yesterday`, `one_week_ago`, `one_week_from_now`,
`one_month_ago`, `one_month_from_now`, `number_of_days_ago`,
`number_of_days_from_now`, and for `is_within` `past_week` / `past_month` /
`past_year` / `next_week` / `next_month` / `next_year`,
`past_number_of_days`, `next_number_of_days`, `this_calendar_month`,
`this_calendar_year`) are **calendar days in the viewer's time zone**, never the
server's and not UTC unless that is the viewer's zone. In US Central time
"today" therefore keeps meaning the same day until local midnight, even though
UTC rolls over at 6 or 7 pm.

The zone is chosen per request, in this order:

1. the request's `timezone` (`POST /api/views/{id}/query`,
   `GET /api/views/{id}/aggregations`, the CSV export, the public share query,
   and `timeZone` on the Airtable-compatible listing). The web app sends the
   profile's zone, or the browser's when the profile has none.
2. the signed-in user's profile time zone (`PATCH /api/auth/me`, `timezone`),
3. UTC (anonymous share viewers that send no `timezone`, and profiles with no zone).

Automations have no request: their `record_matches` trigger and conditions use
the profile zone of the automation's creator (UTC without one).

How cells are compared:

- **Date-only fields** have no time, so the stored calendar date is compared with
  the resolved day. Nothing shifts with the zone.
- **Date-time fields** (and created / last modified time) are first turned into a
  calendar day: in the field's own `timezone` when it has one, otherwise in the
  viewer's zone.
- `exact_date` is the calendar day as written; it does not depend on the zone.
- Rolling ranges (`past_week` = 7 days back to today, `next_month` = today to
  30 days ahead, ...) include today. DST changes do not matter because the
  arithmetic is on calendar dates.

Formula fields are different: a formula field's stored value is shared by every
viewer, so there is no viewer zone to use. `TODAY()` and `NOW()` in a formula
field are evaluated when a record is written (in the writer's profile zone) and
refreshed every 5 minutes in the background (in UTC), so a `TODAY()` formula can
be a day ahead of a US viewer in the evening. To compare with "today" in a view,
use a date filter (above) instead of a formula field. The Airtable-compatible
`filterByFormula` runs per request and takes its zone from `timeZone`.

Cached view results are keyed by zone and, for views with relative dates, by the
viewer's current day, so they never serve yesterday's "today".
