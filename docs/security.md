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
