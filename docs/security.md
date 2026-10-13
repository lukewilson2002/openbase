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
  Existing sessions keep working. Enable 2FA on important accounts.
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
