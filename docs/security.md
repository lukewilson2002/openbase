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
