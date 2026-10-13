# Security

What OpenGrid defends against, the limits that are in place, what an
administrator has to configure, and the risks that were looked at and accepted.
The limits are the values in the code today; rate limits and budgets are in
memory and start over when the server restarts.

Contents: [Threat model](#threat-model) · [Checklist for administrators](#checklist-for-administrators) ·
[Built-in protections](#built-in-protections) ·
[Sign-in, sessions, tokens, invites and email](#sign-in-sessions-tokens-invites-and-email) ·
[Share links, forms, uploads, CSV and webhooks](#share-links-forms-uploads-csv-and-webhooks) ·
[Formula, query and API cost limits](#formula-query-and-api-cost-limits) ·
[Accepted risks](#accepted-risks) · [Reporting a problem](#reporting-a-problem)

## Threat model

OpenGrid is one process (axum + SQLite) on one small server, reachable from the
internet behind a TLS reverse proxy. The sizing target is a single 1 vCPU / 1 GB
host, so limits are set so that a handful of concurrent hostile requests cannot
exhaust it.

We defend against:

- **Anonymous visitors.** They reach only sign-in, share links (`/s/{token}`),
  public forms (`/f/{token}`), the webhook endpoint (`/api/hooks/{token}`) and the
  static client. A share token is the capability: unguessable, revocable and
  optionally password protected. Visitors must not learn anything a share does
  not show (hidden fields, user ids, e-mail addresses) and must not be able to
  use a lot of CPU, memory, disk or mail with few requests. Everything they can
  do is rate limited. Also in scope: password and second-factor guessing,
  enumeration of accounts, and spam through the server's SMTP identity.
- **Signed-in users acting beyond their role.** A user is trusted according to
  their role on a base (Viewer, Commenter, Editor, Creator, Owner); reading other
  workspaces, escalating through invites or API tokens and abusing read-only
  tokens are in scope. A Viewer must not be able to hurt other users'
  availability with one request. Editors and Owners can create expensive
  formulas and large requests, so those are bounded too. An Editor can read and
  export all of a base's data: the limits keep one user from taking the whole
  server down, they are not a boundary between roles.
- **Stolen or leaked credentials**: a leaked API token, an old session or invite
  link, a compromised session that mints a token.
- **Cross-site requests** from a browser that is signed in to OpenGrid.
- **API tokens** (the Airtable-compatible `/api/v1`) act as their owner, limited
  by the token's scope, and are rate limited per token and per user.

Not defended against: an administrator or anyone with shell access to the server
(they own the database), a compromised reverse proxy or host, a stolen session
cookie or API token that has not been revoked (use HTTPS and revoke tokens),
denial of service by volume (use your proxy or provider), and a determined
attacker with many IP addresses against limits that are keyed by IP. Instance
admins get no implicit access to base data, but they can reset passwords and
disable 2FA, which is a path to any account.

## Checklist for administrators

- **Run it behind HTTPS** and set `OPENGRID_PUBLIC_URL` to the exact public URL.
  With an `https://` URL session cookies are marked `Secure`; the URL's origin is
  also what the CSRF `Origin` check compares against. The bundled Caddy setup
  does this for you.
- **`OPENGRID_TRUST_PROXY=true` only behind a proxy, and only when OpenGrid is
  reachable solely through it.** OpenGrid then takes the client address from the
  **last** `X-Forwarded-For` entry (the address the proxy saw); earlier entries
  are client-controlled. Caddy (default behaviour) and nginx with
  `proxy_set_header X-Forwarded-For $remote_addr;` or `$proxy_add_x_forwarded_for`
  are fine. A chain of several proxies is not supported: the last proxy must be
  the one that sees real clients, or every user shares the previous proxy's
  address. Every per-IP limit below uses this address. With the flag off behind a
  proxy, all visitors share one address and hit the limits together; with it on
  while the port is reachable directly, anyone can pick their own address and
  escape the limits. The flag only affects `X-Forwarded-For`; `X-Forwarded-Proto`
  is not read.
- **Keep `OPENGRID_OPEN_SIGNUP=false`** (the default) unless you want strangers
  creating accounts. With open sign-up anyone can create a workspace, an
  automation and invites that send mail from your address, within the budgets
  below. Users then come in through invites.
- **SMTP.** If it is configured, the server sends invitations, password resets
  and automation `send_email` actions (up to 10 recipients per action, to any
  address), so a Creator can make it send mail to arbitrary people. Use a
  dedicated sender address on a domain with SPF/DKIM, an SMTP account or provider
  with its own sending caps and abuse monitoring, and lower
  `OPENGRID_EMAIL_PER_USER_HOUR` / `OPENGRID_EMAIL_PER_HOUR` if you do not use
  email automations.
- **Disk space.** The server does not look at free disk. The byte budgets below
  bound anonymous growth to about 1 GB per hour, plus up to two hours of retention
  for unattached form uploads, but nothing refuses uploads at a free-space floor.
  Monitor the volume (and the backups directory) and alert before it fills: a
  full disk stops SQLite commits.
- **Backups** contain every record, every file and the user table (password
  hashes). Protect and encrypt offsite copies; see
  [self-hosting](self-hosting.md#6-backups).
- **Turn on 2FA** for administrators and other important accounts (Account →
  Security).
- **Lower the Airtable-compatible API limits** with `OPENGRID_V1_RATE_PER_TOKEN`
  (default 5 per second) and `OPENGRID_V1_RATE_PER_USER` (default 50 per second)
  on a small host.
- **Review the audit log** (Admin → Audit, `GET /api/admin/audit`) for
  `login_failed`, `login_2fa_failed` and `password_reset_request` bursts. Rows are
  kept for `OPENGRID_AUDIT_DAYS` (default 365).
- **`OPENGRID_ALLOW_PRIVATE_WEBHOOKS`** stays `false` unless automations must call
  services on your own network; see [automations](automations.md#http-requests-and-ssrf).

## Built-in protections

- **Passwords** are hashed with Argon2id (m = 19 MiB, t = 2, p = 1); at most 2
  hashes run at a time, which also caps the memory a flood of sign-in attempts can
  take.
- **Sessions** are opaque server-side tokens (only the SHA-256 is stored), sent as
  `HttpOnly`, `SameSite=Lax` cookies, `Secure` when the public URL is `https`.
  Optional TOTP two-factor authentication; turning it on signs out the account's
  other sessions.
- **CSRF.** Cookie-authenticated unsafe requests need the `X-OpenGrid-CSRF`
  header; no CORS is ever enabled, so cross-site pages cannot add it. Only a
  well-formed `Authorization: Bearer` header exempts a request; other
  `Authorization` values (such as Basic auth added by a proxy) do not. The
  Airtable-compatible `/api/v1` reads bearer tokens only and never the cookie.
- **Response headers** set by the server: a restrictive
  `Content-Security-Policy` (`default-src 'self'`, no framing, no `object-src`),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: same-origin`. The bundled Caddyfile adds
  `Strict-Transport-Security`.
- **No dynamic SQL from user input.** User tables are JSON rows keyed by field id;
  adding, renaming or deleting a field never builds SQL from names.
- **Roles are checked in one place** (`perm.rs`). No access answers 404 (no
  existence leaks); insufficient role answers 403. API tokens can manage
  workspaces, members, invites and (for administrators) the admin pages only with
  the explicit `manage` permission, and can never touch credentials, 2FA, sessions
  or tokens (see below).
- **Outgoing HTTP from automations** resolves the host, refuses non-public
  addresses, pins the connection to the vetted address and does not follow
  redirects ([automations](automations.md#http-requests-and-ssrf)).
- **Rate limiter memory is bounded**: keys over 64 bytes are hashed, expired
  windows are swept every 30 s, and at most 100,000 keys are tracked.
- **Dependencies**: the server uses rustls (no OpenSSL); the web client is built
  with a committed lockfile, `npm ci --ignore-scripts` and no runtime CDN.

## Sign-in, sessions, tokens, invites and email

### Limits in place

| What | Limit |
|---|---|
| Password attempts, per client address | 10 per minute |
| Password attempts, per account and client address | 10 per hour (reset on success) |
| Password attempts, per account from anywhere | 60 per hour (reset on success). Deliberately high: when it trips the real owner is locked out too, so it only stops distributed guessing |
| Login email | must be a plausible address of at most 254 bytes, checked before it is used as a limiter key or audit field; anything else answers the usual 401 and is not logged |
| Second-factor attempts, per client address | 30 per 10 minutes (counted before anything is looked up) |
| Second-factor attempts, per pending sign-in | 10 per 10 minutes (counted only for real pending sessions) |
| Second-factor attempts, per account across sign-ins | 10 per hour (reset on success) |
| Sign-up, per client address | 10 per hour |
| Password-reset requests, per client address / per mailbox | 5 per hour / 3 per hour (extra requests are answered 200 and send nothing) |
| Invite and automation emails | `OPENGRID_EMAIL_PER_USER_HOUR` (100) per user and `OPENGRID_EMAIL_PER_HOUR` (500) per instance; each recipient counts. Over the limit: invite creation answers 429, an automation run fails with an explanatory error |
| Airtable-compatible API (`/api/v1`) | `OPENGRID_V1_RATE_PER_TOKEN` (5 per second) per token and `OPENGRID_V1_RATE_PER_USER` (50 per second) per user; over the limit answers 429 |
| Audit log | detail capped at 2 KiB per row; rows older than `OPENGRID_AUDIT_DAYS` (365) deleted daily |

### Behaviour worth knowing

- **API tokens** are deleted when their owner changes their password, uses a
  reset link, or an operator runs `reset-password`. Deactivating a user blocks
  their tokens but does not delete them (reactivation restores them); reset the
  password when reactivating an account you think was compromised.
- **The `manage` permission** (off by default, needs `write`) lets a token do the
  account-level things a user can do in the UI: create, rename, delete and
  restore workspaces, change members' roles and remove them, create / list /
  revoke / accept invites, delete, duplicate and restore bases, and, when the
  owner is an instance administrator, use the admin pages. Every such check goes
  through `Actor::require_capability` (`Manage`, `ManageUnscoped` or
  `SessionOnly`); a refusal names the `manage` permission. A `manage` token that
  is limited to specific bases is additionally refused everything that reaches
  beyond a single base (workspaces, workspace members and invites, admin).
  Admin calls made with a token are written to the audit log as `admin_token_use`
  with the token's id and the request. **Credentials are session-only
  whatever the token's scope**: password change, 2FA setup / enable / disable,
  the session list and revocation, and listing / creating / deleting tokens. A
  leaked token, even a `manage` one, can therefore neither take over the account
  nor mint a replacement that outlives its own revocation. Changing a password
  deletes all of the owner's tokens. Treat a `manage` token like a signed-in
  session of the same user: give it only to tools you fully trust (an AI agent,
  for example), and prefer an expiry. `tests/token_capabilities.rs` checks every
  manage-gated and session-only route against sessions, write, read-only and
  `manage` tokens, per role.
- **Read-only tokens** are refused on every state-changing request, in one place
  (the authentication extractor), apart from the view-query POST. A new mutating
  route is therefore safe by default; `tests/security_auth.rs` lists all mutating
  routes and checks them.
- **Base-limited tokens** only see, and mark read, the notifications of their
  bases.
- **Open event streams** end when their session or API token is deleted or
  expires, the user is deactivated, or the role is lost (re-checked every 60 s).
- **Invites** are valid only while their creator is active and still an Owner of
  the workspace (Creator of the base) holding the invited role, and cannot be
  accepted by their creator. Removing or demoting someone therefore voids what
  they had pending.

## Share links, forms, uploads, CSV and webhooks

### Limits in place

| Surface | Limit |
|---|---|
| Public requests (all `/api/public/*`) | 300 per minute per client IP, 1,200 per minute per share token |
| Share-link password checks | 30 per minute per (client IP, link), on the public endpoints and on attachment downloads together; Argon2id |
| Attachment downloads with `?share=` | 600 per minute per client IP, 2,400 per minute per token (own buckets, so a gallery of thumbnails does not eat the public-request budget) |
| Public form submissions / uploads | 20 each per 10 minutes per (client IP, link); a file is at most 25 MB and never above the configured upload limit |
| Anonymous upload bytes | per hour: 200 MB per client IP, 500 MB per base, 1,000 MB for the whole server; charged when the request starts, for its declared length (the cap if none is declared) |
| Unattached uploads | public-form uploads that no record references are deleted after 2 hours, other unattached uploads after 24 hours |
| CSV import | 20 MB, 100,000 rows, 500 columns, **3,000,000 cells** (rows x widest row), two imports at a time server-wide; bad rows are found by bisection, at most 50 are reported |
| Webhook calls (`/api/hooks/{token}`) | body up to 1 MB; 60 per minute per automation and 30 per minute with unknown tokens per client address; 200 queued runs per automation; a finished run keeps the first 16,384 characters of the body, runs are deleted after 30 days |
| Group headers in a public share response | 1,000, key/label cut to 200 characters, raw value never sent, user-field keys replaced by placeholders |

### What a share link exposes

- A read-only link exposes the fields its view shows and the records its filter
  lists. Attachments are downloadable through the link only when they sit in a
  visible attachment field of such a record; knowing an attachment id is not
  enough. Trashing the workspace, base, table or view, disabling the link, hiding
  the field or removing the file all close the download.
- Because a link follows its view's live configuration, **changing the shown
  fields, their order, the filter or the form of a view that has an enabled link
  needs the Creator role**, the same as managing the link. Editors keep the rest
  (widths, sorts, colours, renames).

## Formula, query and API cost limits

| Limit | Value | Where |
|---|---|---|
| Work budget per formula evaluation | 20,000,000 units (about a byte of text touched by a function; an uncached regex compile costs 500,000; running a regex costs 8 per byte of input; `ARRAYUNIQUE` costs n^2/16) | `formula/eval.rs`, `functions/regex.rs` |
| Live intermediate values per evaluation | 4 MiB of text/array data alive at once (arguments already computed while later ones are evaluated) | `formula/eval.rs` |
| Formula result text | 400,000 bytes (100,000 characters x 4) | `formula/coerce.rs` |
| Formula source length / nesting | 10,000 characters, 64 nested computed-field levels, tree height 512 | `limits.rs`, `formula/mod.rs` |
| Regex pattern length / compiled size | 2,000 characters / 1 MiB | `functions/regex.rs` |
| Regex cache | 64 compiled patterns per thread, least recently used evicted; **failed compiles are cached too** | `functions/regex.rs` |
| Grid search text | 500 characters (400 beyond); lower-cased once per query, not per row | `limits.rs`, `query/search.rs` |
| `filterByFormula` (v1 API) | 5 seconds of evaluation per request, then 422 | `v1/records.rs` |
| v1 pagination snapshots | 16 per user, 256 and 1,000,000 ids overall; when the store is full the user holding the most loses their oldest snapshot first | `v1/cursor.rs` |

A formula that exhausts a budget evaluates to `#ERROR: Formula is too expensive to
evaluate`, and `IF(ISERROR(...))` cannot hide that. The cost of a normal formula is
orders of magnitude below the budgets.

Also in place: view queries read the base's data version *before* building their
plan from the field definitions, so a schema change that races with a scan can
never be cached under the version that already includes it. Date parsing accepts
ASCII digits only. The dependency graph orders a lookup or rollup whose target is
its own link field (self-linked tables) correctly.

## Accepted risks

Authentication and email:

- A distributed attacker (many addresses) can still trip the 60-per-hour
  per-account login limit and lock the real owner out for up to an hour. Existing
  sessions keep working. Enable 2FA on important accounts (enabling it also
  ends the other sessions of that account).
- Any signed-in user can create a workspace and so send invite and automation
  emails to arbitrary addresses within the budgets. There is no setting to
  restrict workspace creation to admins; keep sign-up invite-only.
- Removing a member from a workspace does not remove base-level grants they were
  given separately by someone else (they are shown in the base's member list).
  Self-granting by invite is closed, so such rows exist only if another owner or
  creator added them.
- Reactivating a deactivated user restores their API tokens (see above).

Shares, uploads and imports:

- **Upload byte budgets live in memory** and start over on restart; they are also
  charged by declared length, so a client that declares a long request and sends
  less uses up budget it did not use.
- **Files removed from a cell are kept while the record history is.** Garbage
  collection treats an attachment id found in retained record history
  (`OPENGRID_HISTORY_DAYS`, default 365) as referenced, so undo and "restore from
  history" keep working. The cost is disk space for files that were deliberately
  cleared; lower the history retention if that matters.
- **Share-scoped attachment checks scan the shared view once per data change.**
  The set of files a view exposes is cached per view and base version; after
  every change to the base the next download from a link rebuilds it (one pass
  over the view's records). A very large, constantly edited shared view makes that
  pass the dominant cost of a download.
- **Re-enabling a link re-publishes whatever the view looks like then.** The
  Editor restriction applies while a link is enabled; an Editor can still edit the
  view while its link is disabled, so review the view before turning the link back
  on.
- **Imports hold the single database writer** while they run (a 100,000-row import
  takes a while); other writes wait. Two concurrent imports are the maximum; large
  imports are best done off-hours.
- **Per-IP limits can be shared or dodged:** visitors behind one NAT share a
  budget, and an attacker with many addresses (an IPv6 range) multiplies theirs.
  The per-base and server-wide upload budgets and the Argon2 concurrency cap are
  what hold in that case.

Formulas and queries:

- A formula with many *distinct, dynamically built* regex patterns (more than the
  64-entry cache) pays an uncached compile per pattern on every record, up to the
  per-evaluation budget (about 40 compiles). Recomputation on the writer is
  bounded per record by that budget, not by wall-clock time; only Editors and
  Owners can save such a formula. `filterByFormula` has the 5-second request
  deadline on top.
- The work budget counts bytes and compiles, not CPU time, so it is an
  approximation: it bounds the cost per record but the sum over a very large table
  of slow-but-within-budget formulas is bounded only by the table size limits
  (100,000 records).
- Public group header keys of text fields are cut to 200 characters, so two groups
  with the same first 200 characters share a collapse-state key in a public view.
  Cosmetic only.
- Group headers beyond the first 1,000 in a public share are not sent; their
  records still page normally but appear without a header.

## Reporting a problem

The project has no dedicated security contact or disclosure process yet. Until it
does, report a vulnerability privately to the maintainer of the repository you
installed OpenGrid from rather than in a public issue.
