# OpenGrid API

OpenGrid has three HTTP surfaces:

| Surface | Prefix | Who uses it | Auth |
|---|---|---|---|
| Airtable-compatible API | `/api/v1` | scripts, n8n/Make/Zapier, existing Airtable client libraries | API token (`Authorization: Bearer`) only |
| Internal API | `/api/...` | the web client | session cookie or API token |
| Public links | `/api/public/...` | share links and public forms | the unguessable link token (+ optional password) |

The internal API is specified in `docs/plans/2026-10-12-opengrid.md` §3.1 and typed
in `crates/core/src/api` (exported to TypeScript in `web/src/api/types`). This
document covers the Airtable-compatible API in full, and summarises the public
links and CSV endpoints.

---

## 1. API tokens

Create a token with `POST /api/tokens` from a signed-in session (tokens cannot
create or list tokens themselves):

```json
{ "name": "n8n", "write": true, "base_ids": ["bseXXXX"], "expires_in_days": 90 }
```

The secret is shown once. A token acts as its owner, limited further by:

- **write**: a read-only token acts as a Viewer on every base and may only
  read. Every state-changing request (anything but GET/HEAD, apart from view
  queries, which are POSTs) answers `403`, including actions on the owner's own
  data such as deleting a comment or marking notifications read.
- **base_ids**: the bases the token may reach; any other base answers 404.
  `/api/notifications` only lists (and marks read) notifications of those bases.
- expiry: expired tokens answer 401. Open event streams (`/api/bases/{id}/events`)
  end when their token is deleted or expires.
- Changing or resetting the owner's password deletes all of their tokens.

Roles are the owner's: Viewer < Commenter < Editor < Creator < Owner. Records
can be written by Editors and above. The Airtable API changes no schema, except
that `typecast` may add select options.

---

## 2. Airtable-compatible API (`/api/v1`)

Point an Airtable client at `https://<your server>/api/v1` instead of
`https://api.airtable.com/v0`, and use an OpenGrid token in place of an
Airtable personal access token:

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://grid.example.com/api/v1/meta/bases"

curl -H "Authorization: Bearer $TOKEN" \
  "https://grid.example.com/api/v1/$BASE_ID/Tasks?filterByFormula=%7BStatus%7D%3D%27Todo%27&sort%5B0%5D%5Bfield%5D=Due"
```

### 2.1 Authentication and rate limits

- **Bearer tokens only.** The session cookie is never read, so a browser
  signed in to OpenGrid cannot be driven through this API (no CSRF surface);
  a request with only a cookie is `401 AUTHENTICATION_REQUIRED`.
- **Rate limits** (fixed one-second windows): **5 requests/second per token**
  and **50 requests/second per user** (all of a user's tokens together). Over the
  limit: `429 RATE_LIMIT_REACHED` with `Retry-After: 1`. Server operators can
  change both with `OPENGRID_V1_RATE_PER_TOKEN` / `OPENGRID_V1_RATE_PER_USER`.
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
| 403 | `INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` | the token cannot write (read-only token, or the owner is below Editor on the base) |
| 404 | `NOT_FOUND` | unknown/inaccessible base (a base outside a token's `base_ids` or one the user cannot see is a 404, not a 403), table, record, or route |
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
Owners), capped at `read` for read-only tokens. Bases a token cannot reach are
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

| Airtable type | OpenGrid field | `options` |
|---|---|---|
| `singleLineText`, `email`, `url`, `phoneNumber`, `barcode` | single line text, email, URL, phone, barcode | none |
| `multilineText` / `richText` | long text / long text with markdown on | none |
| `number`, `percent` | number, percent | `{precision}` |
| `currency` | currency | `{precision, symbol}` |
| `duration` | duration | `{durationFormat}` (`h:mm`, `h:mm:ss`, `h:mm:ss.S`, …) |
| `rating` | rating | `{icon, max, color}` |
| `checkbox` | checkbox | `{icon, color}` |
| `singleSelect`, `multipleSelects` | single / multiple select | `{choices: [{id, name, color}]}` |
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
(OpenGrid's list view; Airtable has no equivalent).

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
| `filterByFormula` | keep records for which the formula is truthy (see below). |
| `returnFieldsByFieldId` | key `fields` by field id instead of name. |
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

**`filterByFormula`** uses OpenGrid's Airtable-compatible formula language
(`docs/plans`, section on formulas): `{Field Name}` references (or
`{fldXXXX}` ids), the same functions and the same truthiness as Airtable (0, `""`,
blank and `FALSE()` are false). It is evaluated for each record of the (view or
table) listing, in the viewer's time zone. Invalid formulas, unknown field names
and unknown functions are `INVALID_FILTER_BY_FORMULA` with the position of the
problem in the message. A formula that evaluates to an error for a record
excludes that record. Formulas are limited to 10,000 characters.

`GET /api/v1/{baseId}/{table}/{recordId}` returns one record without an
envelope (`returnFieldsByFieldId` is supported); records of trashed records or
other tables are 404.

### 2.5 Value shapes

Records are rendered the way Airtable renders them. **Empty cells are omitted**,
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

Attachment `url`s are **absolute** (built from `OPENGRID_PUBLIC_URL`) and, unlike
Airtable's, need the same bearer token (or a signed-in session) to download.
`thumbnails` (images only) has `small` and `large` pointing at OpenGrid's single
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
  collaborator fields); the person must have access to the base;
- attachments take `[{"id": "attXXXX"}]`, the id of a file uploaded to the same
  base with `POST /api/bases/{id}/attachments` (session or token with write
  access). OpenGrid does **not** fetch `url`s on a client's behalf (SSRF), so
  `[{"url": …}]` is a 422;
- barcode takes `{"text"}` or a string;
- computed fields (formula, lookup, rollup, count, created/modified time/by,
  autonumber, button) cannot be written: `INVALID_VALUE_FOR_COLUMN`.

### 2.7 Differences from Airtable

| Airtable | OpenGrid |
|---|---|
| `https://api.airtable.com/v0/…` | `https://<server>/api/v1/…`; base ids look like `bseXXXX`, table ids `tblXXXX`, field ids `fldXXXX`, record ids `recXXXX` |
| personal access tokens with scopes | OpenGrid API tokens: read/write plus an optional base list; there is no schema scope because this API cannot change schema |
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
| a read-only/unreachable base → 403 or 404 | an inaccessible base is always 404, a read-only token writing is 403 |
| 2xx for create is 200 | same |
| select colors like `blueLight2` | OpenGrid's palette names (`blue`, `blue_dark`, …) |
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

Public endpoints take no credentials; the token in the URL is the capability.
A password-protected link wants the header `X-Share-Password` (401
`share_password_required` / `share_password_invalid`). Disabled, deleted or
wrong-kind links are 404, like unknown tokens. All responses are
`Cache-Control: no-store`; requests are rate limited per client IP (300/min),
per token (1,200/min), password checks (30/min) and form traffic (20 submits
and 20 uploads per 10 minutes per IP and link).

| Endpoint | Purpose |
|---|---|
| `GET /api/public/shares/{token}` | the shared view: name, layout config and **only the visible fields** (hidden fields and field order of the view apply) |
| `POST /api/public/shares/{token}/query` | records (`QueryRequest`: `offset`, `limit`, `search`, `range`, `timezone`, `transient`). Search, ranges and `transient` filter/sort/group overrides may only use visible fields (400 otherwise). Records contain only visible fields; user values are `[{"name"}]`, created/modified-by `{"name"}`; **no user ids, e-mail addresses or creator/editor metadata** ever appear |
| `GET /api/attachments/{id}/{filename}?share={token}` | attachment files of the shared view (send `X-Share-Password` when protected) |
| `GET /api/public/forms/{token}` | the form: title, description, fields with label/help/required/options |
| `POST /api/public/forms/{token}/submit` | `{"values": {fieldId: value}}` creates one record anonymously (history source `form`, no user). Only form fields are accepted, required fields are enforced, values are read leniently like a browser form but **never create select options**. **Link and user fields are not collected by public forms** (they would need pickers over other data), even if listed in the form's config |
| `POST /api/public/forms/{token}/attachments` | multipart `file` for an attachment field of the form (at most 25 MB, further capped by the upload limit) |

---

## 4. CSV

- `GET /api/views/{id}/export.csv?timezone=` (Viewer): the view's visible
  fields in view order, filter and sort applied, cells as display text (dates
  in `timezone`, default the caller's zone), streamed in 500-record pages.
  UTF-8 with a BOM, CRLF, RFC 4180 quoting. Cells (and headers) starting with
  `=`, `+`, `-`, `@`, TAB or CR get a leading `'` so spreadsheets do not run
  them as formulas (numbers keep their sign). The file name is the view name,
  sanitized.
- `POST /api/tables/{id}/import` (Editor): multipart `file` (CSV, at most 20 MB,
  100,000 rows, 500 columns), `mapping` (JSON `{csvColumn: fieldId | null}`;
  columns are header names, or zero-based numbers when `has_header` is
  `false`; omitted = match by field name) and `has_header` (default `true`).
  Values are read with typecast. **All or nothing**: any bad row gives
  `422 {"error": {"code": "import_failed", "rows": [{"row", "message"}], …}}`
  with the first 50 problems, and nothing is written. BOMs, CRLF/LF, ragged rows
  and quoted newlines are handled.
- `POST /api/bases/{id}/import` (Creator): multipart `file`, optional `name`,
  `has_header`; creates a new table with inferred field types and imports every
  row, again atomically.
