# Security

What OpenBase defends against, the limits that are in place, what an
administrator has to configure, and the risks that were looked at and accepted.
The limits are the values in the code today; rate limits and budgets are in
memory and start over when the server restarts.

Contents: [Threat model](#threat-model) · [Checklist for administrators](#checklist-for-administrators) ·
[Built-in protections](#built-in-protections) ·
[Sign-in, sessions, tokens, invites and email](#sign-in-sessions-tokens-invites-and-email) ·
[Passkeys](#passkeys) ·
[Share links, forms, uploads, CSV and webhooks](#share-links-forms-uploads-csv-and-webhooks) ·
[Formula, query and API cost limits](#formula-query-and-api-cost-limits) ·
[Accepted risks](#accepted-risks) · [Reporting a problem](#reporting-a-problem)

## Threat model

OpenBase is one process (axum + SQLite) on one small server, reachable from the
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
- **Cross-site requests** from a browser that is signed in to OpenBase.
- **API tokens** (the Airtable-compatible `/api/v1`, the internal API and the MCP
  endpoint) act as their owner, limited by the token's scope, and are rate limited
  per token and per user. An AI agent connected through MCP is such a token holder:
  anything it may do, it may also do wrongly or because text it read told it to
  (prompt injection), so scope its token to what the task needs.
- **Connected apps (OAuth).** An app that signs in through the built-in OAuth server
  holds a grant with the same kind of scope, valid on `/mcp` only. In scope: a malicious
  app asking for access (consent phishing, look-alike names, redirect tricks), a stolen
  authorization code or refresh token, a page that tries to approve for a signed-in user
  or to frame the approval page, registration abuse, and server-side request forgery
  through client metadata URLs. See [OAuth](#oauth-connected-apps).

Not defended against: an administrator or anyone with shell access to the server
(they own the database), a compromised reverse proxy or host, a stolen session
cookie or API token that has not been revoked (use HTTPS and revoke tokens),
denial of service by volume (use your proxy or provider), and a determined
attacker with many IP addresses against limits that are keyed by IP. Instance
admins get no implicit access to base data, but they can reset passwords and
disable 2FA, which is a path to any account (signed in; their API tokens cannot).

## Checklist for administrators

- **Run it behind HTTPS** and set `OPENBASE_PUBLIC_URL` to the exact public URL.
  With an `https://` URL session cookies are marked `Secure`; the URL's origin is
  also what the CSRF `Origin` check compares against. The bundled Caddy setup
  does this for you.
- **`OPENBASE_TRUST_PROXY=true` only behind a proxy, and only when OpenBase is
  reachable solely through it.** OpenBase then takes the client address from the
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
- **Keep `OPENBASE_OPEN_SIGNUP=false`** (the default) unless you want strangers
  creating accounts. With open sign-up anyone can create a workspace, an
  automation and invites that send mail from your address, within the budgets
  below. Users then come in through invites.
- **SMTP.** If it is configured, the server sends invitations, password resets
  and automation `send_email` actions (up to 10 recipients per action, to any
  address), so a Creator can make it send mail to arbitrary people. Use a
  dedicated sender address on a domain with SPF/DKIM, an SMTP account or provider
  with its own sending caps and abuse monitoring, and lower
  `OPENBASE_EMAIL_PER_USER_HOUR` / `OPENBASE_EMAIL_PER_HOUR` if you do not use
  email automations.
- **Email settings are in the app.** Under **Admin → Email** an administrator
  edits the SMTP settings; an `OPENBASE_SMTP_*` variable that is set wins for its field
  and is read-only there. The SMTP password is stored in the database in clear text
  (the server must present it to the mail server), so it is in every backup: protect
  backups like the database. It is write-only (never returned by the API, never logged,
  never in the audit log), and a signed-in person is the only one who can set or remove it.
  Prefer a dedicated SMTP account with its own sending caps. Putting the host and
  password in the environment keeps them out of the database altogether.
- **Disk space.** The server does not look at free disk. The byte budgets below
  bound anonymous growth to about 1 GB per hour, plus up to two hours of retention
  for unattached form uploads, but nothing refuses uploads at a free-space floor.
  Monitor the volume (and the backups directory) and alert before it fills: a
  full disk stops SQLite commits.
- **Backups** contain every record, every file and the user table (password
  hashes). Protect and encrypt offsite copies; see
  [self-hosting](self-hosting.md#6-backups).
- **Turn on 2FA** for administrators and other important accounts (Account →
  Security), or give them a passkey: a passkey sign-in already includes a second
  factor (see [Passkeys](#passkeys)).
- **Choose the final domain before anyone adds a passkey.** A passkey is bound to the
  host of `OPENBASE_PUBLIC_URL`; changing that host makes every passkey unusable (people
  fall back to their password and add new ones). Passkeys made on a `localhost` test install
  do not carry over to production. See [Passkeys](#passkeys).
- **Public HTTPS for OAuth.** Set `OPENBASE_PUBLIC_URL` to the public `https://` address.
  OpenBase serves the OAuth sign-in only over HTTPS (or on a localhost address), so
  codes and tokens never travel in clear text; Claude and ChatGPT reach it from the
  internet. Look at **Admin → Connected apps** now and then, and revoke what nobody
  uses. `OPENBASE_OAUTH_REGISTRATION=false` stops apps from registering themselves at
  `/oauth/register`; it does **not** stop an app that publishes a metadata document (its
  `client_id` is a URL) from asking a signed-in person for approval, see
  [accepted risks](#accepted-risks).
- **Treat MCP tokens like sessions.** An AI agent holding a `manage` token can do
  nearly everything you can in the app except change credentials and download backup
  archives; give agents the
  least permission that works (read-only, or write without `manage`), restrict
  them to the bases they need, set an expiry, and revoke the token when the work
  is done. See [MCP](mcp.md#security-model).
- **Lower the Airtable-compatible API limits** with `OPENBASE_V1_RATE_PER_TOKEN`
  (default 5 per second) and `OPENBASE_V1_RATE_PER_USER` (default 50 per second)
  on a small host.
- **Review the audit log** (Admin → Audit, `GET /api/admin/audit`) for
  `login_failed`, `login_2fa_failed`, `passkey_login_failed` (a `counter_regression`
  reason means a passkey may have been cloned) and `password_reset_request` bursts. Rows are
  kept for `OPENBASE_AUDIT_DAYS` (default 365).
- **`OPENBASE_ALLOW_PRIVATE_WEBHOOKS`** stays `false` unless automations must call
  services on your own network; see [automations](automations.md#http-requests-and-ssrf).

## Built-in protections

- **Passwords** are hashed with Argon2id (m = 19 MiB, t = 2, p = 1); at most 2
  hashes run at a time, which also caps the memory a flood of sign-in attempts can
  take.
- **Sessions** are opaque server-side tokens (only the SHA-256 is stored), sent as
  `HttpOnly`, `SameSite=Lax` cookies, `Secure` when the public URL is `https`.
  Optional TOTP two-factor authentication; turning it on signs out the account's
  other sessions and ends its connected apps (OAuth grants). Optional passkeys (WebAuthn),
  see [Passkeys](#passkeys).
- **MCP endpoint (`/mcp`).** Bearer tokens only (personal access tokens, and OAuth
  access tokens, see [OAuth](#oauth-connected-apps)): a session cookie
  is refused with 401, which is why the route needs no CSRF header. A request with
  a browser `Origin` header is served only for the public URL's origin (or
  `OPENBASE_MCP_ALLOWED_ORIGINS`), the MCP spec's DNS-rebinding protection;
  requests without `Origin` (every non-browser client) are unaffected. Bodies are
  capped at 8 MB and every request counts against `OPENBASE_MCP_RATE_PER_TOKEN` /
  `OPENBASE_MCP_RATE_PER_USER`. The tools `api_request` / `api_reference` run
  catalogued REST requests through the real router with the caller's own token,
  so permissions, validation and audit are the web app's; the paths are checked
  up front (only `/api/...`, no `..`, no `/mcp` recursion) and credential, session
  and token endpoints are refused before anything is sent. A test fails when a
  route is registered without an entry in the endpoint catalogue. The curated
  tools (bases, tables, fields, views, automations, share links, CSV, uploads, the
  admin pages) run through the same router; none of them can set a password, switch
  off 2FA or touch tokens, and `admin_*` tools exist only for a `manage` token of an
  instance administrator. **Downloading a backup archive is session-only** for every token,
  an administrator's `manage` token and a Full control OAuth grant included: the archive
  holds every password hash, two-factor secret and the SMTP password (listing and creating
  backups stay available, they reveal names and sizes only). `upload_attachment` with a URL fetches through the same
  SSRF guard as the automations' HTTP action (see [automations](automations.md#http-requests-and-ssrf)),
  with a size limit and no redirects. Full details: [MCP](mcp.md#security-model).
- **CSRF.** Cookie-authenticated unsafe requests need the `X-OpenBase-CSRF`
  header; no CORS is enabled for any cookie-authenticated route, so cross-site pages
  cannot add it. (The only cross-origin answers are the OAuth discovery, registration,
  token and revocation endpoints, which never read cookies; see [OAuth](#oauth-connected-apps).) Only a
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
- **Roles are checked in one place** (`perm.rs`). Access comes only from workspace
  membership: one role per member, for every base of the workspace or a picked list
  (`workspace_member_bases`); the same SQL condition decides base access, collaborator
  lists and notification recipients. No access answers 404 (no existence leaks);
  insufficient role answers 403. API tokens can manage
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

## OAuth (connected apps)

OpenBase is its own OAuth 2.1 authorization server for the MCP endpoint (MCP
authorization specification; how to use it: [MCP](mcp.md#connect-with-oauth-sign-in)).
The design was checked against the OAuth 2.1 security best current practice (RFC 9700):

| Threat | What stops it |
|---|---|
| Open redirect, redirect URI tampering | Redirect URIs are `https` or loopback `http` only, no wildcards, fragments, credentials or other schemes, and the requested address must equal a registered one exactly (loopback ports excepted, RFC 8252). A bad client or address is shown to the user as an error and **never redirected to**; only after both are verified do errors go back to the client. |
| Authorization code injection and interception | PKCE `S256` is required (plain is refused, so there is no downgrade); the code is bound to the client, the exact redirect address, the PKCE challenge, the resource and the access the user chose; it lives 60 seconds and works once. A code is spent the moment it is presented, even when PKCE or the redirect check then fails, and presenting a spent code revokes the grant it created. A code that was approved but not redeemed yet is deleted when its user changes or resets their password, turns on two-factor authentication, signs out other sessions or is deactivated. |
| Mix-up attacks | Every authorization response carries `iss` (RFC 9207) and the metadata says so; there is one issuer, the public origin. |
| Parameter tampering between steps | The whole authorization request is stored on the server; the browser carries only an unguessable id (`oar` + 43 random characters, 10 minutes). The approval page shows what the server stored, never what the URL says. The request is stored only after a signed-in person loaded `/oauth/authorize`: a visitor without a session is sent to `/login` with the request itself as the place to return to, and nothing is written for them. |
| CSRF on the approval | Approving needs the signed-in session **and** the `X-OpenBase-CSRF` header (a cross-site page cannot add it and no CORS preflight is answered for `/api`); a token or an OAuth grant can never approve (session-only). A request is approved once and then gone. |
| Clickjacking | The approval page is a page of the app: `frame-ancestors 'none'` and `X-Frame-Options: DENY` like every page. |
| Consent phishing, look-alike apps | The page leads with the redirect host (who receives the access), shows the app's name as plain text (a name with control, invisible or direction-changing characters is refused at registration and stripped from every display; 100 characters at most), warns for loopback and unverified hosts, and flags names that imitate Claude or ChatGPT unless the redirect address is exactly one of the providers' documented callbacks (`https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `https://chatgpt.com/connector_platform_oauth_redirect`, `https://platform.openai.com/apps-manage/oauth`). Other paths on those domains, such as a GPT's own callback, count as third parties. Names are compared as a skeleton: Unicode NFKC, case, accents, hidden characters, digit and symbol swaps, and a hand-picked table of Cyrillic, Greek and Armenian look-alikes of Latin letters are ignored (a subset of the Unicode confusables, not the whole table; a name written backwards under a direction override is caught too). **Read only is always preselected.** Read & edit is offered when the app asked for write (or named no scope we know); Full control only when the app asked for `openbase:manage` (the `/mcp` 401 challenge names `openbase:read openbase:write`, so a client that follows it does not) and the person could create such a token themselves. A name is not a credential: nothing is trusted because of it. |
| Stolen access token | Opaque 256-bit tokens, stored as SHA-256 only, one hour, valid on `/mcp` only: not on `/api/*` or `/api/v1`, which cannot even be used to list, create or revoke grants. The audience (`resource`) is checked on every use. |
| Stolen refresh token | Rotation on every use with reuse detection: presenting a token again more than 30 seconds after it was exchanged revokes the grant. Inside those 30 seconds (a client racing itself with two parallel refreshes) the second request is refused with `invalid_grant` and nothing is revoked, so a legitimate client does not destroy its own connection. 30 days idle expiry; bound to the client; a refresh may repeat the grant's scope but neither widen it nor narrow it (`invalid_scope`: tokens carry the scope of the connection, so a narrower request is refused rather than answered with a wider token). The grant is **deleted** (not suspended) when its user changes or resets their password, turns on two-factor authentication, uses "sign out other sessions", is deactivated (reactivating the account does not bring the app back), or has their two-factor switched off by an administrator or the `disable-2fa` command. Personal access tokens are different, see [Behaviour worth knowing](#behaviour-worth-knowing). A client that loses a refresh response has to be approved again: deliberate. |
| Token leakage | Tokens are never in URLs (codes only in the redirect, by design), never logged, never in the audit log (it names the app, host, access and bases), and token responses are `no-store`. Secrets in the database are hashes; a test greps every OAuth table and the audit log for the raw values. |
| Registration abuse (DCR) | 30 registrations per address per hour (IPv6: per /64), 16 KB bodies, validated names and redirect addresses, identical registrations share one client, and at most 5,000 self-registered clients. When that table is full the longest unused client that nobody connected through is forgotten to make room, so a trickle of registrations cannot keep real apps out. A client counts as used only when an authorization code was exchanged for it: starting an authorization request does not (anyone can start one), and clients never used are deleted after 7 days by the hourly cleanup. A registration grants nothing. `OPENBASE_OAUTH_REGISTRATION=false` turns it off, but not the metadata-document route (see accepted risks). |
| Server-side request forgery through `client_id` URLs | Client metadata documents are fetched only for a signed-in person, through the automations' SSRF guard (public addresses only, resolved and pinned, no redirects). **`OPENBASE_ALLOW_PRIVATE_WEBHOOKS` never relaxes it** (that switch is for automations calling your own network); the only exception is the separate development-only `OPENBASE_OAUTH_CIMD_ALLOW_PRIVATE`, off by default, which lets a client under development on the same machine be fetched from loopback. The person sees only "could not fetch the app's metadata document": resolved addresses, status codes and timeouts go to the server log, so the page is no probe of the internal network. 5 second deadline, 16 KB limit, JSON only, the document's `client_id` must equal the URL, and no secrets or secret-based authentication are accepted in it. |
| Denial of service | Per-address limits (IPv6: per /64): 60 authorization requests per minute (a visitor's request only redirects to the sign-in page and writes nothing), 300 token and 300 revocation requests per minute (separate buckets); 20 authorization requests per minute per signed-in person; at most 5,000 waiting authorization requests (200 per app), 5,000 cached documents, 100 connected apps per user; expired data is removed hourly. Only a signed-in person can store a request, fetch a document or make a client count as used, so anonymous traffic cannot fill or keep full any table. |
| Cross-origin use | Discovery, registration, token and revocation answer any origin (`Access-Control-Allow-Origin: *`, no credentials) so browser-based MCP clients work; none of them reads a cookie. `/oauth/authorize` and `/api/oauth/*` are not cross-origin APIs. |
| Plain HTTP | OAuth is not advertised or served on `http://` except for loopback addresses (`localhost`, `127.0.0.1`, `[::1]`). |
| Who did it | Actions an app or a personal access token takes that reach the audit log (invites, share links, automations, user and email administration, admin calls) carry `detail.via`: the connected app (client id and name, grant id) or the token (id and name). **Admin → Audit** shows it next to the person. Ordinary data edits are not audited; they show in the record history under the owner's name. |

The flow itself is audited (`oauth_approve`, `oauth_deny`, `oauth_grant_create`,
`oauth_grant_revoke` with who revoked it, `oauth_code_replay`, `oauth_refresh_reuse`), and
`tests/oauth_*.rs` covers each row. Not covered: what an approved app does with its access
(see the prompt-injection note above), a user who approves a malicious app that has a
convincing name on an address they do not look at, and a compromised provider (Claude's or
ChatGPT's own servers) that holds valid tokens. Revoke from **Connected apps**.

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
| Passkey sign-in attempts (finishing), per client address | 10 per minute, counted before anything is looked up |
| Passkey sign-in challenges requested, per client address | 30 per minute (the login page asks for one when it opens) |
| Passkey changes (start / finish of a registration, rename, remove), per user | 60 per 10 minutes |
| Passwords typed to confirm a passkey registration, per user | 10 per 10 minutes |
| Pending passkey ceremonies | 5 minutes each, used once, at most 10,000 of each kind in memory |
| Passkeys per account | 20 |
| Sign-up, per client address | 10 per hour |
| Password-reset requests, per client address / per mailbox | 5 per hour / 3 per hour (extra requests are answered 200 and send nothing) |
| Invite and automation emails | `OPENBASE_EMAIL_PER_USER_HOUR` (100) per user and `OPENBASE_EMAIL_PER_HOUR` (500) per instance; each recipient counts. Over the limit: invite creation answers 429, an automation run fails with an explanatory error |
| Airtable-compatible API (`/api/v1`) | `OPENBASE_V1_RATE_PER_TOKEN` (5 per second) per token and `OPENBASE_V1_RATE_PER_USER` (50 per second) per user; over the limit answers 429 |
| OAuth (`/oauth/*`) | per client address (IPv6: per /64): 30 registrations per hour, 60 authorization requests per minute, 300 token requests per minute, 300 revocations per minute; per signed-in person: 20 authorization requests per minute; codes live 60 s, access tokens 1 h, refresh tokens 30 days idle |
| MCP endpoint (`/mcp`) | `OPENBASE_MCP_RATE_PER_TOKEN` (30 per second) per token and `OPENBASE_MCP_RATE_PER_USER` (100 per second) per user, one JSON-RPC message per request; body up to 8 MB; over the limit answers 429 with `Retry-After` |
| Audit log | detail capped at 2 KiB per row; rows older than `OPENBASE_AUDIT_DAYS` (365) deleted daily |

### Behaviour worth knowing

- **API tokens** (and OAuth connected apps) are deleted when their owner changes their
  password, uses a reset link, or an operator runs `reset-password`. **Connected apps
  (OAuth grants) are also deleted** when the owner turns on two-factor authentication, uses
  "sign out other sessions", is deactivated, has their two-factor switched off by an
  administrator, or an operator runs `disable-2fa`; an app has to be approved again after
  that. **API tokens are not**: they survive those events, and deactivating a user only
  blocks their tokens (reactivation restores them). Reset the password when reactivating
  an account you think was compromised, and look at **Account → API tokens** after
  "sign out other sessions".
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
  passkeys (list, register, rename, remove), the session list and revocation, and
  listing / creating / deleting tokens. An
  instance administrator's `manage` token is no exception: it cannot create a
  password-reset link for a user (`POST /api/admin/users/{id}/reset-link`, which would
  be an account takeover), cannot switch off a user's 2FA (`disable_2fa`), cannot remove a user's
  passkeys (`DELETE /api/admin/users/{id}/passkeys`), cannot give a
  new user a password or receive their reset link (`POST /api/admin/users` creates the
  account without a usable password; a person sends the invitation from the web app), and
  cannot set or remove the SMTP password. It also cannot re-point a stored SMTP password:
  while a password is in use, changing the SMTP host, port, security mode or username is
  session-only, because that would make the server send the password to a server of the
  token's choosing. A leaked token, even a `manage` one, can therefore neither take over
  an account nor mint a replacement that outlives its own revocation. Changing a password
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
  expires, the user is deactivated, or access is lost: removal from the workspace or
  the base taken off their list publishes `base_changed`, which re-checks access at
  once (and it is re-checked every 60 s anyway).
- **Invites** always join a workspace, for every base or a list of bases. They are
  valid only while their creator is active and holds the invited role as an Owner of
  the workspace or, for an invite limited to some bases, as a Creator who can still
  open each of them; they cannot be accepted by their creator. Removing, demoting or
  narrowing someone therefore voids what they had pending, and a voided invite is not
  listed and cannot be changed (changing it would make the editor its inviter and
  revive the link). Creators can never invite to every base or to a base they cannot
  open. Accepting raises an existing member's workspace role only when its terms were
  last set by an owner acting for the whole workspace, not through a token limited to
  some bases (recorded on the invite when its terms are set).

## Passkeys

A passkey is a public-key credential held by the person's device or password manager (Touch ID,
Windows Hello, a phone, a security key). The server stores only the public key. A passkey signs a
person in with no username and no password, and because OpenBase always asks the authenticator for
**user verification** (fingerprint, face, PIN or screen lock) a passkey sign-in already is a
possession-plus-verification sign-in: **it does not ask for the TOTP code**. Signing in with the
password still does, when the account has 2FA. Passwords are not removed; there are no
passwordless-only accounts. The library is `webauthn-rs` (its pure-Rust crypto build; OpenSSL is not
used), and the browser side is the plain WebAuthn API.

| Topic | What OpenBase does |
|---|---|
| Relying party | The RP ID is the host of `OPENBASE_PUBLIC_URL` (`base.example.com`, or `localhost`), and the only accepted origin is that URL's origin (scheme, host and port). A server whose public URL is an IP address cannot use passkeys: WebAuthn needs a domain name, and `GET /api/setup` says `passkeys_enabled: false`. |
| **Changing the domain** | Browsers file every passkey under the RP ID it was made for. If the host of `OPENBASE_PUBLIC_URL` changes, **every existing passkey stops working** (the browser no longer offers it, or the server refuses it); people sign in with their password and add new ones, and the old rows can be deleted. Passkeys made while testing on `localhost` do not exist for the production domain. Choose the final domain before enabling passkeys for people. A different scheme or port on the same host is refused too (the origin must match exactly). |
| Registering | `POST /api/auth/passkeys/register/start` + `finish`, signed in. **Re-authentication:** the session must have been created within the last 10 minutes (signing up, or signing in with a password, a 2FA code or a passkey, all count), or the request must carry the account password; otherwise `403 reauth_required`. So a stolen but older session cookie cannot plant a passkey without the password (password guesses for this are limited to 10 per 10 minutes). Credentials are requested as discoverable (resident), with user verification required and no attestation (the server does not ask which device made it). The challenge is bound to the user and to the session that started it. |
| Signing in | Anonymous. `passkey-login/start` returns a challenge and an opaque id; `finish` checks the signature, challenge, origin, RP ID, the user-verified flag and the signature counter, and that the credential's user handle belongs to the same account. The state of a ceremony is kept in memory, is good for one attempt (a wrong answer spends it) and for 5 minutes. A restart drops pending ceremonies; the person just tries again. |
| Same answer for every refusal | An unknown credential, a wrong signature and a replayed challenge all answer 401 and look alike to the caller; the audit log records the real reason (`unknown_credential`, `invalid_response`, `counter_regression`, `deactivated`). |
| Clone detection | The authenticator's signature counter must increase. If it does not (and either value is above zero) the sign-in is refused and audited as `counter_regression` with the passkey's id. The passkey is **not** deleted automatically (only a holder of the key can trigger this, and deleting it would lock the owner out of that passkey); the owner or an administrator should remove it and add a fresh one. Synced passkeys (iCloud Keychain, Google Password Manager, password managers) report a counter of 0 and are not affected. |
| Deactivated users | A deactivated account cannot sign in with a passkey (403, audited); reactivating restores it. |
| Session-only | Registering, listing, renaming and removing passkeys, and the administrator's removal of all of a user's passkeys, are refused for every kind of token: personal access tokens (also with `manage`), OAuth grants, and MCP `api_request` (which refuses them up front, and the router refuses them again). A token that could add a passkey could plant a credential that outlives its own revocation. |
| Password change / reset | Passkeys are separate credentials and **survive** a password change or reset (which deletes API tokens and other sessions). If an account may have been compromised, also review its passkeys (Account → Security) or ask an administrator to remove them all. Passkeys are deleted with the user (foreign key cascade). |
| Removing | The owner removes one passkey from Account → Security; an administrator removes all of a user's passkeys from Admin → Users (lost device). Neither ends sessions that are already signed in. The person's device may still list the passkey; they should delete it there too. |
| Audit | `passkey_add`, `passkey_rename`, `passkey_remove`, `passkey_login`, `passkey_login_failed` (with the reason), `admin_passkeys_remove` (with how many). |

What is not covered: a passkey protected only by a weak device PIN or an unlocked device, malware
on the device that uses the authenticator while it is unlocked, and the loss of every device
together with the password (an administrator can create a reset link). Passkeys do not make a
stolen session cookie harmless: a session lives for 30 days however it was created. The WebAuthn
ceremony state (not the credentials) is kept in memory, which suits the single-node design.

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

- **Anyone can register an OAuth client** (dynamic registration is open by design: that is
  how Claude Code and others work), **and anyone can publish a client metadata document**
  (a `client_id` that is an `https://` URL with a name and redirect addresses of their
  choosing; there is no switch or allowlist for that route). A registration or a document
  gives nothing by itself, but it lets a stranger put an approval request with *their*
  chosen app name in front of a signed-in person who opens their link. The page shows where
  the access would go and warns about look-alikes; a person who ignores that can still
  approve a bad app. `OPENBASE_OAUTH_REGISTRATION=false` removes only the registration
  route: it does **not** remove this exposure, because the metadata-document route stays.
  What limits it: a stranger cannot get that page without the target person being signed in
  and following the link, the request (and the fetch of the document) happens only for a
  signed-in person, and the page names the document's address ("App identity").
- **Authorization requests need a session.** A visitor who is not signed in is sent to the
  sign-in page and nothing is stored for them, so anonymous traffic cannot fill the table
  of waiting requests, the client tables or the document cache, or keep an unused client
  alive. The per-address limits (IPv6 per /64) apply to the redirect itself. What remains
  is signed-in people filling the 5,000-request table (capped at 200 per app and 20 starts
  a minute per person); invite-only instances (the default) make that an insider's problem.
- A client that loses the response of a refresh and retries within 30 seconds gets
  `invalid_grant` and keeps its connection (the new tokens are lost with the response), and
  one that retries later has its connection revoked; either way the cost is one new approval.
- Rate limits for OAuth are per client address (IPv6: per /64) and in memory like the others.

- The email settings let an administrator (or an administrator's `manage` token, which
  may change host and port while no SMTP password is in use) make the server open a
  connection to any host and port, and the test email shows whether it answered. That is a
  small port-probing ability from the server's network position, comparable to what an
  administrator already has with `OPENBASE_ALLOW_PRIVATE_WEBHOOKS`; it is audited
  (`admin_email_update`, `admin_email_test`).

- A distributed attacker (many addresses) can still trip the 60-per-hour
  per-account login limit and lock the real owner out for up to an hour. Existing
  sessions keep working. Enable 2FA on important accounts (enabling it also
  ends the other sessions of that account).
- Any signed-in user can create a workspace and so send invite and automation
  emails to arbitrary addresses within the budgets. There is no setting to
  restrict workspace creation to admins; keep sign-up invite-only.
- A member limited to some bases still sees the workspace's member list (names and
  email addresses of everyone in it), like any other member.
- Reactivating a deactivated user restores their API tokens (see above); their connected
  apps (OAuth grants) were deleted when the account was deactivated.
- **A passkey planted with a stolen session outlives a password reset.** Registering needs the
  password or a sign-in from the last 10 minutes, so an attacker holding only an older cookie
  cannot do it, but someone who stole a *fresh* session can add their own passkey before the
  owner notices, and a password change does not remove passkeys (they are separate
  credentials). The audit log shows `passkey_add`; after a suspected compromise remove unknown
  passkeys, or have an administrator remove them all.
- **Ceremony state is in memory.** A restart cancels registrations and sign-ins in progress
  (the person starts again); a flood of challenge requests is limited per address and capped
  at 10,000 waiting ceremonies per kind, oldest dropped first.

Shares, uploads and imports:

- **Upload byte budgets live in memory** and start over on restart; they are also
  charged by declared length, so a client that declares a long request and sends
  less uses up budget it did not use.
- **Files removed from a cell are kept while the record history is.** Garbage
  collection treats an attachment id found in retained record history
  (`OPENBASE_HISTORY_DAYS`, default 365) as referenced, so undo and "restore from
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

Report a vulnerability **privately** with GitHub's private vulnerability reporting:
<https://github.com/lukewilson2002/openbase/security/advisories/new> (repository
**Security** tab -> **Report a vulnerability**). Do not open a public issue for it.
[SECURITY.md](../SECURITY.md) has what to include, what to expect and which versions are
supported: only the latest minor release gets fixes, shipped as a new release. A fix
reaches your server when you pull the new image (`docker compose pull && docker compose up -d`)
or install the new binary; nothing updates itself unless you turn that on
([upgrading](self-hosting.md#8-upgrading)).
