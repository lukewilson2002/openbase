# Security notes

Short operator-facing summary of OpenGrid's threat model, the limits it enforces
and what you should configure. Sections are grouped by area of the hardening
review; each area lists its limits and accepted risks.

## Threat model

OpenGrid is a self-hosted app for a small team, reachable from the public
internet behind a TLS reverse proxy. We defend against:

- **Anonymous internet users**: password and second-factor guessing, resource
  exhaustion through unauthenticated endpoints, enumeration of accounts, spam
  through the server's SMTP identity.
- **Signed-in users acting beyond their role**: reading other workspaces,
  escalating through invites or API tokens, abusing read-only tokens.
- **Stolen or leaked credentials**: a leaked API token, an old session or
  invite link, a compromised session that mints a token.
- **Cross-site requests** from a browser signed in to OpenGrid.

Not defended against: a malicious instance administrator or someone with shell
access to the server (they own the database), a compromised reverse proxy, and
denial of service by volume (use your proxy or provider for that). Instance
admins get no implicit access to base data, but they can reset passwords and
disable 2FA, which is a path to any account.

## Authentication, sessions, tokens, invites, email

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
| Rate limiter memory | keys over 64 bytes are hashed; expired windows swept every 30 s; at most 100,000 tracked keys |
| Audit log | detail capped at 2 KiB per row; rows older than `OPENGRID_AUDIT_DAYS` (365) deleted daily |

### Behaviour worth knowing

- **Turning on 2FA** signs the user out everywhere else: every other session is
  deleted (the one that enabled it stays), because a session opened with only
  the password must not outlive the second factor. API tokens are unaffected
  (they are revoked by a password change, not by 2FA).
- **`last_used_at` of an API token** is refreshed at most once a minute per token
  (one implementation, shared by `/api/v1` and the session/token extractor), so
  a busy integration does not put a write on SQLite's single writer for every
  request. The value is therefore accurate to a minute.
- **Deleted workspaces** can be listed by their owners (`GET /api/trash/workspaces`,
  session only) so they can be restored; other roles, outsiders and API tokens
  see nothing there.
- **API tokens** are deleted when their owner changes their password, uses a
  reset link, or an operator runs `reset-password`. Deactivating a user blocks
  their tokens but does not delete them (reactivation restores them); reset the
  password when reactivating an account you think was compromised.
- **Read-only tokens** are refused on every state-changing request, in one
  place (the authentication extractor), apart from the view-query POST. A new
  mutating route is therefore safe by default; `tests/security_auth.rs` lists
  all mutating routes and checks them.
- **Base-limited tokens** only see and mark read the notifications of their bases.
- **Open event streams** end when their session or API token is deleted or
  expires, the user is deactivated, or the role is lost (re-checked every 60 s).
- **Invites** are valid only while their creator is active and still an Owner of
  the workspace (Creator of the base) holding the invited role, and cannot be
  accepted by their creator. Removing or demoting someone therefore voids what
  they had pending.
- **CSRF**: cookie-authenticated unsafe requests need the `X-OpenGrid-CSRF`
  header. Only a well-formed `Authorization: Bearer` header exempts a request;
  other `Authorization` values (such as Basic auth added by a proxy) do not.

### What admins should configure

- **`OPENGRID_TRUST_PROXY=true` only behind a proxy that sets or appends the
  client address in `X-Forwarded-For`, and only when OpenGrid is reachable
  solely through it.** OpenGrid uses the **last** entry (the address the proxy
  saw); earlier entries are client-controlled. Caddy (default behaviour) and
  nginx with `proxy_set_header X-Forwarded-For $remote_addr;` or
  `$proxy_add_x_forwarded_for` are fine. A chain of several proxies is not
  supported: the last proxy must be the one that sees real clients, or every
  user will share the previous proxy's address. With the setting off, the TCP
  peer address is used.
- **SMTP**: use a dedicated sender with its own sending limits, set SPF/DKIM,
  and lower `OPENGRID_EMAIL_PER_USER_HOUR` / `OPENGRID_EMAIL_PER_HOUR` if you
  do not use email automations. Keep `OPENGRID_OPEN_SIGNUP=false` (the default):
  with open sign-up anyone can create a workspace, an automation and invites
  that send mail from your address, within the budgets above.
- Review the audit log (`GET /api/admin/audit`) for `login_failed`, `login_2fa_failed`
  and `password_reset_request` bursts.

### Accepted risks

- A distributed attacker (many addresses) can still trip the 60-per-hour
  per-account login limit and lock the real owner out for up to an hour.
  Existing sessions keep working. Enable 2FA on important accounts (enabling it
  also ends the other sessions of that account).
- Any signed-in user can create a workspace and so send invite and automation
  emails to arbitrary addresses within the budgets. There is no setting to
  restrict workspace creation to admins; keep sign-up invite-only.
- Removing a member from a workspace does not remove base-level grants they
  were given separately by someone else (they are shown in the base's member
  list). Self-granting by invite is closed, so such rows exist only if another
  owner or creator added them.
- Reactivating a deactivated user restores their API tokens (see above).


# Security notes

OpenGrid is meant to run on the public internet for a small business. This
page summarises what it defends against, the limits that exist for that,
what an administrator has to configure, and what is knowingly accepted.

Sections are grouped by area; each group of fixes appends its own section.

## Threat model in short

- **Anonymous visitors** reach login/signup, public share links (read-only
  views and forms) and nothing else. They must not learn anything a share
  does not show (hidden fields, user ids, e-mail addresses) and must not be
  able to use a lot of CPU, memory or disk with few requests.
- **Signed-in users** are trusted only as far as their role in a workspace or
  base. A Viewer must not be able to hurt other users' availability with one
  request; Editors and Owners can create expensive formulas, so those are
  bounded per evaluation too.
- **API tokens** (Airtable-compatible v1 API) act as their owner, limited by
  the token's scope, and are rate limited per token and per user.
- A single small server (1 vCPU, 1 GB) is the sizing target: limits are set so
  that a handful of concurrent hostile requests cannot exhaust it.

## What administrators should configure

- `OPENGRID_TRUST_PROXY=true` **only** when OpenGrid is reachable solely
  through a reverse proxy that overwrites `X-Forwarded-For` (and
  `X-Forwarded-Proto`) instead of appending to what the client sent. With it
  on and a proxy that passes client-supplied headers through, every per-IP
  rate limit can be bypassed by a visitor; with it off behind a proxy, all
  visitors share the proxy's IP and one noisy client locks out the rest.
- Keep `OPENGRID_OPEN_SIGNUP` off unless you want strangers creating
  accounts; users then come in through invites.
- If SMTP is configured, remember that invites, password resets and
  notifications make the server send mail to addresses a user types: use a
  sending account with its own rate/daily limit at the provider, and a
  `OPENGRID_SMTP_FROM` on a domain with SPF/DKIM.
- `OPENGRID_V1_RATE_PER_TOKEN` (default 5/s) and `OPENGRID_V1_RATE_PER_USER`
  (default 50/s) bound the Airtable-compatible API; lower them for a small
  host.

## Formula, query and API cost limits (core engine)

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
| Group headers in a public share response | 1,000, key/label cut to 200 characters, raw value never sent, user-field keys replaced by placeholders | `engine/query.rs`, `api/sharing.rs` |

A formula that exhausts a budget evaluates to `#ERROR: Formula is too
expensive to evaluate`, and `IF(ISERROR(...))` cannot hide that. The cost of
a normal formula is orders of magnitude below the budgets.

Also in place: view queries read the base's data version *before* building
their plan from the field definitions, so a schema change that races with a
scan can never be cached under the version that already includes it.
Date parsing accepts ASCII digits only. The dependency graph orders a lookup
or rollup whose target is its own link field (self-linked tables) correctly.

### Accepted risks (core engine)

- A formula with many *distinct, dynamically built* regex patterns (more than
  the 64-entry cache) pays an uncached compile per pattern on every record,
  up to the per-evaluation budget (about 40 compiles). Recomputation on the
  writer is bounded per record by that budget, not by wall-clock time; only
  Editors and Owners can save such a formula. `filterByFormula` has the
  5-second request deadline on top.
- The work budget counts bytes and compiles, not CPU time, so it is an
  approximation: it bounds the cost per record but the sum over a very large
  table of slow-but-within-budget formulas is bounded only by the table size
  limits (100,000 records).
- Public group header keys of text fields are cut to 200 characters, so two
  groups with the same first 200 characters share a collapse-state key in a
  public view. Cosmetic only.
- Group headers beyond the first 1,000 in a public share are not sent; their
  records still page normally but appear without a header.


# Security notes

What OpenGrid protects against, the limits that are in place, what an
administrator has to configure, and the risks that were looked at and accepted.
Sections are per area; each lists values as they are in the code.

## Threat model in short

OpenGrid is one process (axum + SQLite) on one small server, meant to be
reachable from the internet behind a TLS reverse proxy.

- **Anonymous visitors** can reach only share links (`/s/{token}`), public
  forms (`/f/{token}`), the webhook endpoint (`/api/hooks/{token}`), sign-in and
  the static client. A share token is the capability: unguessable, revocable,
  optionally password protected. Everything they can do is rate limited.
- **Signed-in users** are trusted according to their role on a base (Viewer,
  Commenter, Editor, Creator, Owner). An Editor can read and export all of a
  base's data and can send large requests; the limits below keep one user from
  taking the whole server down, they are not a boundary between roles.
- **Not defended against:** an administrator with shell access, a compromised
  reverse proxy or host, a stolen session cookie or API token (use HTTPS and
  revoke tokens), and a determined attacker with many IP addresses against
  limits that are keyed by IP.

## Sharing, uploads, CSV and automations

### Limits in place

| Surface | Limit |
|---|---|
| Public requests (all `/api/public/*`) | 300/min per client IP, 1,200/min per share token |
| Share-link password checks | 30/min per (client IP, link), on the public endpoints and on attachment downloads together; Argon2id |
| Attachment downloads with `?share=` | 600/min per client IP, 2,400/min per token (own buckets, so a gallery of thumbnails does not eat the public-request budget) |
| Public form submissions / uploads | 20 each per 10 minutes per (client IP, link); a file is at most 25 MB and never above the configured upload limit |
| Anonymous upload bytes | per hour: 200 MB per client IP, 500 MB per base, 1,000 MB for the whole server; charged when the request starts, for its declared length (the cap if none is declared) |
| Unattached uploads | public-form uploads that no record references are deleted after 2 hours, other unattached uploads after 24 hours |
| CSV import | 20 MB, 100,000 rows, 500 columns, **3,000,000 cells** (rows x widest row), two imports at a time server-wide; bad rows are found by bisection, at most 50 are reported |
| Webhook calls | body up to 1 MB, 200 queued runs per automation; a finished run keeps the first 16,384 characters of the body, runs are deleted after 30 days |

### What a share link exposes

- A read-only link exposes the fields its view shows and the records its
  filter lists. Attachments are downloadable through the link only when they sit
  in a visible attachment field of such a record; knowing an attachment id is
  not enough. Trashing the workspace, base, table or view, disabling the link,
  hiding the field or removing the file all close the download.
- Because a link follows its view's live configuration, **changing the shown
  fields, their order, the filter or the form of a view that has an enabled link
  needs the Creator role**, the same as managing the link. Editors keep the
  rest (widths, sorts, colours, renames).

### What administrators should configure

- **`OPENGRID_TRUST_PROXY=true` only behind a proxy that overwrites
  `X-Forwarded-For`** (Caddy and the bundled compose file do). Every per-IP
  limit above uses that address. With the flag off behind a proxy, all visitors
  share one address and hit the limits together; with it on while the port is
  reachable directly, anyone can pick their own address and escape the limits.
- **Disk space.** The server does not look at free disk. The byte budgets bound
  anonymous growth to about 1 GB per hour, plus up to two hours of retention
  for unattached form uploads, but nothing refuses uploads at a free-space floor.
  Monitor the volume (and the backups directory) and alert before it fills: a
  full disk stops SQLite commits.
- **Email (SMTP).** If SMTP is configured, the server sends invitations,
  password resets and automation `send_email` actions
  (up to 10 recipients per action, to any address). A Creator can therefore
  make the server send mail to arbitrary people. Use a dedicated sender address
  and an SMTP account or provider with its own sending caps and abuse
  monitoring, and publish SPF/DKIM for the sender domain.
- **Backups** contain every file and the whole database; protect and encrypt
  offsite copies.

### Accepted risks

- **Upload byte budgets live in memory** and start over on restart; they are
  also charged by declared length, so a client that declares a long request and
  sends less uses up budget it did not use.
- **Files removed from a cell are kept while the record history is.** Garbage
  collection treats an attachment id found in retained record history
  (`history_days`, default 365) as referenced, so undo and "restore from
  history" keep working. The cost is disk space for files that were deliberately
  cleared; lower `history_days` if that matters.
- **Share-scoped attachment checks scan the shared view once per data change.**
  The set of files a view exposes is cached per view and base version; after
  every change to the base the next download from a link rebuilds it (one pass
  over the view's records). A very large, constantly edited shared view makes
  that pass the dominant cost of a download.
- **Re-enabling a link re-publishes whatever the view looks like then.** The
  Editor restriction applies while a link is enabled; an Editor can still edit
  the view while its link is disabled, so review the view before turning the
  link back on.
- **Imports hold the single database writer** while they run (a 100,000-row
  import takes a while); other writes wait. Two concurrent imports are the
  maximum; large imports are best done off-hours.
- **Per-IP limits can be shared or dodged:** visitors behind one NAT share a
  budget, and an attacker with many addresses (an IPv6 range) multiplies theirs.
  The per-base and server-wide upload budgets and the Argon2 concurrency cap
  are what hold in that case.
