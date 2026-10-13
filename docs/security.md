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
