> Note (2026-10-13): this project was renamed from OpenGrid to OpenBase after this note was written. The content below is unchanged and still says OpenGrid.

# Baserow and peers: lessons for OpenGrid

Research date: 2026-10-12. Sources: vendor docs, community forums, and the GitHub source/API (repo metadata pulled with `gh api` on 2026-10-12). Any claim I could not confirm against a primary source is marked **[unverified]**.

## TL;DR

- **Baserow** is the closest model of what OpenGrid is cloning. It also shows the weight we are trying to avoid: Django, Postgres, Redis, Celery, Channels and Nuxt 4 together need **2 GB RAM at minimum, 3 GB in staff's recommendation, and 4 GB in practice**. Its core is MIT, but Kanban, Calendar and Timeline views, row comments, row coloring, personal views and non-CSV export are all **Premium**. RBAC, field-level permissions, SSO, audit log and data sync are **Advanced/Enterprise**. For OpenGrid, "no paywalled features" is a real point of difference.
- **Each Baserow user table is a real Postgres table**: `database_table_<id>` with `field_<id>` columns, and through tables `database_relation_*` for links. Django models are generated at runtime and changed through Django's schema editor (DDL). Formulas are parsed with ANTLR4, compiled to SQL and **stored materialized**.
- **Grist** is the closest *architectural* match to our constraints: **one SQLite file per document**, SQLite home DB, Apache-2.0 core. The catch is that it **loads the whole document into a Python data engine in RAM, and again in every browser tab**. Grist recommends keeping a document under **20 MB / about 100k rows**.
- **NocoDB left OSI open source in January 2026** (it moved from AGPL-3.0 to the "Sustainable Use License"). **Teable** is AGPL plus a paid-feature image and Postgres-only. **APITable/AITable** is AGPL with a heavy MySQL, Redis, RabbitMQ and MinIO stack. **Rowy** has been dormant since November 2024 and is tied to Firebase.
- **Scale people actually report:** Airtable and others cap paid bases at about 50k–500k rows. Baserow users report slow API fetches from about 5–7k rows when fetching everything, and formula/lookup cascades as the main cost. Grist's guidance is about 100k rows per document. If OpenGrid reliably handles **100k rows × 50 fields per table on 1 vCPU / 512 MB**, it will be competitive.

---

## 1. Baserow in depth

### 1.1 Project status

- Repo: `baserow/baserow`, 6.1k stars on the GitHub mirror (development historically on GitLab; `.gitlab-ci.yml` is still present). Last push 2026-10-12.
- Latest release: **2.4.0 (2026-09-30)**, which added a button field, field permissions for users and teams, and AI provider management. The previous release was 2.3.4 (2026-09-15).
- Stack confirmed from `backend/pyproject.toml` and `web-frontend/package.json`:
  - Django 5.2.17
  - channels[daphne] 4.3.2 with channels-redis 4.3.0 (WebSocket layer)
  - celery[redis] 5.6.2
  - gunicorn 23 with uvicorn 0.52 (ASGI)
  - psycopg2
  - Nuxt ^4.5.2 with Vue 3.5
  - Caddy as reverse proxy in the all-in-one image

### 1.2 Licensing and paywall

Licensing comes from the repo `LICENSE` and the `premium/LICENSE` file:

- **Core:** MIT. The README says "all non-premium and non-enterprise features under the MIT License."
- **`premium/` and `enterprise/` directories:** source-available under the "Baserow Premium Edition license". It allows production use only with a paid subscription for the right number of users. Dev and test use is free, and any modifications you make still belong to Baserow. Licenses can be validated offline, but they do not auto-renew offline.

Feature matrix, per baserow.io/user-docs/pricing-plans (2026-10). Self-hosted instances have no row or storage limits; the limits in the table apply to cloud.

| Feature | Free (MIT) | Premium ($10–12/user/mo) | Advanced ($18–22/user/mo) | Enterprise (self-host only, custom price) |
|---|---|---|---|---|
| Grid, Gallery, Form views | yes | yes | yes | yes |
| **Kanban, Calendar, Timeline views** | **no** | yes | yes | yes |
| Form survey mode | no | yes | yes | yes |
| **Personal views** | no | yes | yes | yes |
| **Row comments** | no | yes | yes | yes |
| Row coloring | no | yes | yes | yes |
| Export | CSV only | CSV, JSON, Excel, XML | yes | yes |
| Dashboard graph widget | no | yes | yes | yes |
| AI field and AI formula generator | no | yes | yes | yes |
| Remove branding from forms | no | yes | yes | yes |
| **RBAC / field-level permissions** | no | no | yes | yes |
| **SSO** (SAML/OIDC) | no | no | yes | yes |
| **Audit log** | no | no | yes | yes |
| Data sync (Jira, GitLab, GitHub, HubSpot, Baserow) | no | no | yes | yes |
| Admin panel, instance-wide features | partial **[unverified split]** | | | yes |
| Row history retention (cloud) | 14 d | 90 d | 180 d | 180 d |
| Cloud limits: rows / storage | 3k / 2 GB | 50k / 20 GB | 250k / 100 GB | 1M / 1 TB |

In the OSS edition, row history, trash, undo/redo, realtime collaboration, formulas, link and lookup fields, the REST API, webhooks and snapshots are all free. That is my reading of the docs and code **[snapshot tier not explicitly stated]**.

**Takeaway:** the features people most often want after Grid view are Kanban, Calendar, comments, permissions and SSO. Baserow charges for all of them. These are exactly the features OpenGrid should ship free.

### 1.3 Architecture

The all-in-one `baserow/baserow` image runs these processes under supervisord:

- Caddy
- Nuxt SSR server (web-frontend)
- Gunicorn/uvicorn ASGI backend, which serves both HTTP and WebSockets
- Celery "fast" worker (realtime fan-out)
- Celery "slow" worker (exports and imports)
- Celery beat (cron)
- Embedded Postgres 15
- Embedded Redis

Redis serves three roles: the Channels layer, the Celery broker, and the cache. Baserow also has optional query caching through django-cachalot (`BASEROW_CACHALOT_ENABLED`). Search uses a Postgres tsvector column per field (`tsv_field_*`), with `BASEROW_USE_PG_FULLTEXT_SEARCH=true` by default.

### 1.4 Resource requirements

- Official community FAQ: "Baserow needs at minimum **2GB of RAM**."
- Staff in forum threads recommend **3 GB minimum** because "that's what it can grow to with a basic setup". They estimate **about 400 MB per Celery worker**, and each configured Celery worker actually starts two processes.
- Hosting providers and guides recommend **2 vCPU / 4 GB**.
- A forum thread (January 2024) shows a 1 vCPU / 2 GB droplet where schema changes stalled requests for up to 20 minutes and crashed the box. Staff's advice was 4 GB / 2 vCPU with 3 GB allocated to Baserow. The user's eventual fix was a 32 GB server.
- Tuning knobs: `BASEROW_RUN_MINIMAL=yes` with `BASEROW_AMOUNT_OF_WORKERS=1` (one Celery process handles both queues, so a slow export delays realtime updates), and `BASEROW_AMOUNT_OF_GUNICORN_WORKERS`.
- **Conclusion: Baserow cannot run on a 512 MB–1 GB VPS.** That is the market gap OpenGrid targets.

### 1.5 How user tables are stored

Confirmed in source (`backend/src/baserow/contrib/database/table/constants.py` and `models.py`):

- Every user table is a physical Postgres table named `database_table_<id>`. Every field is a column named `field_<id>`.
- Link-row (M:N) fields use through tables named `database_relation_<id>`. Multiple-select fields use `database_multipleselect_*` and multiple-collaborator fields use `database_multiplecollaborators_*`.
- Metadata lives in normal tables (`database_table`, `database_field` plus per-type subclasses, and views). Adding a field inserts a metadata row and then runs `ALTER TABLE ... ADD COLUMN` through Django's `schema_editor`. Changing a field type does an `ALTER COLUMN ... TYPE ... USING` conversion. The exact SQL path for type changes is **[inferred, not read line-by-line]**.
- A Django model class is generated per request with `type()` (`table.get_model()`) and cached, with field attributes cached in Redis. Registering all models permanently was rejected because it would exhaust memory.
- Limits: `BASEROW_MAX_FIELD_LIMIT` defaults to **600 fields per table**, and `BASEROW_MAX_FIELD_TEXT_LENGTH` to 1,000,000 characters.
- Row counts are maintained asynchronously by Celery. Per-row `needs_background_update` columns let formulas be recomputed in the background.

Pros:

- Real SQL types and native indexes.
- Fast filtering and sorting in the database.
- Direct SQL access for power users.

Cons:

- DDL runs on every schema edit. It takes locks and can rewrite whole tables on large data, which is the most likely cause of the "schema updates bring the server down" reports **[inferred]**.
- Very large numbers of tables in one database.
- Backup and restore at the granularity of one tenant is awkward.
- Migrations have to touch N user tables.

### 1.6 Formulas

- The grammar is ANTLR4 (`formula/*.g4`). Separate parsers are generated for the browser (validation) and the backend (Python AST).
- Pipeline: parse, then type-check, then compile to a **Django expression and on to a prepared SQL statement**.
- Results are **stored in a real column** (materialized), not computed on read.
- Baserow keeps a field dependency graph. When a field is created, edited, renamed, deleted or restored, it rebuilds the table's reference tree, re-types dependent formulas and refreshes their values. Deleting a field marks its dependents as broken; they recover if a field with the same name comes back. Circular references are rejected.
- Lookups, rollups and cross-table formulas cascade updates through `database_relation_*` tables. Staff say "relationship and formula updates" are the largest cost in writes.

### 1.7 Realtime collaboration

- Django Channels WebSockets run on the ASGI workers with a Redis channel layer. Celery "fast" workers fan out events such as `rows_updated` and `field_created` to page and table groups.
- Since 2.3, missed events are replayed on reconnect (`BASEROW_REALTIME_REPLAY_MAX_EVENTS=200`, with 24 h retention). A presence bar shows who is viewing, including anonymous public-view visitors since 2.3.3.
- Conflict model: last write wins per cell. There is no OT or CRDT **[inferred from event design; no merge logic seen]**.

### 1.8 Undo/redo, trash, row history

- **Undo/redo:** `core/action/handler.py`. Every mutating API call is recorded as an `Action` row with a user, a scope (table, view, workspace…), a client **session id** sent as an HTTP header, and serialized params. Undo and redo replay these in reverse, per user, per session and per scope. Actions are pruned after `MINUTES_UNTIL_ACTION_CLEANED_UP` (default **120 min**), so the undo window is about 2 hours.
- **Trash:** a soft-delete flag (`trashed=True`) on workspaces, applications, tables, fields and rows, with a central `TrashEntry`. Items are permanently deleted after `HOURS_UNTIL_TRASH_PERMANENTLY_DELETED` (default **72 h**, confirmed in `settings/base.py`). Restoring a field restores its column, because the column is kept until the trash is purged.
- **Row history:** per-row change log with before and after values, shown in the row modal. It is kept for `BASEROW_ROW_HISTORY_RETENTION_DAYS` (default **180**) and pruned every 30 min. Self-hosted retention is configurable and free.

### 1.9 Known pain points (forum and GitHub)

- **Memory:** threads titled "Very high memory usage", "Wsgi consume a lot of memory" and "Memory leak issues with Digital Ocean self host". Celery in debug mode leaks memory. Third-party packages (Cloudron) started one Celery process per core per queue. Even tuned, installs run at about 2.5–3 GB.
- **Concurrency:** staff note that one gunicorn worker handles one request at a time, so a slow schema change blocks everything else. On 1 vCPU, adding a field to a big table, or editing a formula with many dependents, stalls the instance.
- **Wide tables, lookups and formulas:** staff say tables get slower as columns are added, and that "relationship and formula updates" dominate. Deeply nested formulas return a generic "Unknown error". One version-specific report (1.32.1) has lookups stopping after about 1,100 rows.
- **API fetch of whole tables:** slow from about 5–7k rows when users page through everything. A 10–35M row deployment hit timeouts, and staff said they had never seen tables that large.
- **Upgrades:** the embedded Postgres 11 to 15 jump in 1.24.0 needed a manual upgrade image. Users report "success" messages followed by containers that still fail, and backend restart loops after migration. Other threads cover failed 1.23 to 1.24 upgrades and large file uploads failing on specific versions. This is the classic risk of bundling a database server.
- **Imports:** "Import .csv is stuck in importing". Imports run as async Celery jobs; synchronous imports are capped at 5,000 rows by default.
- **"Reconnecting to server"** loops behind reverse proxies, caused by WebSocket proxy misconfiguration.

---

## 2. Peers (brief)

| | Storage model | Footprint | License / gates | Activity (GitHub, 2026-10-12) |
|---|---|---|---|---|
| **Grist** (grist-core) | **One SQLite file per document** (`.grist`). Home DB is SQLite (`home.sqlite3`) or Postgres. Sessions in SQLite or Redis. Optional S3 snapshot sync (bucket must support versioning). | Recommended: 8 GB / 2 CPU for "moderate" load. A sample doc measured **about 100 MB RAM without the sandbox, 200 MB with it**, on 1 CPU. RAM grows with the number of open documents. | Core is **Apache-2.0**. The "Full" edition (activation key) gates **OIDC/SAML SSO**, admin controls (e.g. removing users), automations, email notifications, AI, Azure storage, the native S3 client and Fleet HA. | 11.9k stars, v1.7.21 (2026-10-09) |
| **NocoDB** | Metadata in `NC_DB` (SQLite by default, or Postgres/MySQL). New bases create **real tables** in NC_DB. It can also put a UI over an *existing* external database. Deletes are soft (flag), and select options live only in metadata **[secondary source]**. | Node.js. Guides say 1–2 GB minimum and 4 GB for 10–20 users. No measured idle figures found. | **Sustainable Use License since January 2026** (v0.301.0+; previously AGPL-3.0). Free to self-host and modify internally, but you cannot resell it as a hosted service. No longer OSI open source. Enterprise tier gating **[not researched in detail]**. | 65k stars, release 2026.09.1 |
| **Teable** | Postgres-only now (`db-provider/postgres.provider.ts`). Physical tables and columns via `create-database-column-query` and `generated-column-query`, so it is Baserow-like **[inferred from source tree]**. Supports BYO database. | NestJS, Next.js, Postgres and Redis. A third party quotes **4 GB / 2 CPU minimum** for basic compose, and 16 GB+ for the AI and app-builder stack **[unverified]**. | Community is **AGPL-3.0** (packages MIT). The official image bundles paid features unlocked by a license key. | 21.9k stars, released 2026-10-11 |
| **APITable / AITable** | MySQL with Redis, RabbitMQ and MinIO. Java backend plus NestJS room server (realtime via OT). | Heavy multi-service stack. The 4 CPU / 8 GB figure is **[unverified]**. | AGPL-3.0, with an unusual "Powered by" embedding clause. The enterprise edition is separate. | 15.6k stars, last push 2026-09-06 (syncs from the hosted product) |
| **Rowy** | A UI over **Firestore**. Runs in your own GCP/Firebase project. | Not self-contained, because it needs Google Cloud. | Apache-2.0 **[repo shows NOASSERTION]**. | Repo moved to `buildship-ai/rowy`. **Last commit 2024-11-23, effectively dormant.** |

### 2.1 Grist details that matter

- On open, a doc worker starts a sandboxed **Python data engine** (gVisor `runsc` in the official image; it needs XSAVE and SYS_PTRACE). **All document data is read from SQLite into that process.** The browser also holds full copies of the tables it has fetched and keeps them current through WebSocket deltas.
- "On-demand tables", which kept data out of the engine, have been **deprecated**. Users on 1.7.12 report RAM exhaustion and an unresponsive server when several large documents are open.
- Limits: hosted plans cap documents at 5k, 100k or 150k rows, with **data size capped at rows × 2 KB**. The recommended maximum is **20 MB per document**, which is about 100k rows × 24 numeric columns.
- Formulas are full Python, very powerful but expensive. A recent release says lookups and summary tables now use about 30% less memory.
- Strengths worth copying:
  - The document is one file: easy backup, download, email, fork and restore.
  - Each file is self-describing; any SQLite tool can read it.
  - Per-document action history gives undo and version snapshots.

---

## 3. Lessons for a Rust single-binary, SQLite-backed design

### 3.1 Copy

1. **Grist's isolation unit.** Use one SQLite file per base (workspace or base) plus a small `system.sqlite` for users, sessions, ACLs and the base registry. Benefits:
   - Backup and restore per base.
   - No migration of N tables across a whole multi-tenant database.
   - The blast radius of corruption is one base.
   - Easy export (hand over the file) and `VACUUM INTO` snapshots.
2. **Baserow's metadata-driven schema with ID-based physical names** (`t_<id>`, `f_<id>`), never user-visible names. Renames are then metadata-only. Keep metadata (tables, fields, views, filters) in the same base file, so schema and data stay transactionally consistent.
3. **Baserow's action log for undo/redo:** an action row with user, session id, scope, and params plus inverse params. Record it in the same transaction as the change. Also borrow its scoped undo (per view/table) and time-bounded pruning.
4. **Baserow's trash model:** soft-delete everything (rows, fields, tables, views), restore within N hours, and purge with a background task. Keep dropped columns until the purge, so restoring a field is instant.
5. **Row history as an append-only change table** (row_id, field_id, old, new, user, ts) with configurable retention. It doubles as the audit log, which we can ship free (Baserow sells it).
6. **Materialized formula values plus a dependency graph** (Baserow), with formulas compiled from an AST into SQL expressions where possible. That way sort, filter and search run on stored values. Use a single grammar shared by client and server: for example, a Rust parser compiled to WASM for the browser, replacing Baserow's two ANTLR targets.
7. **Realtime reconnect replay** (Baserow 2.3): keep a ring buffer of the last N events per base, so clients resync without a full reload.
8. **Ship free** what Baserow paywalls: Kanban, Calendar, Timeline, Gallery, Form views, row comments, personal views, row coloring, all export formats, RBAC including field-level permissions, OIDC SSO, and the audit log. All of these are cheap in a single binary. SAML is the one item to weigh for complexity.

### 3.2 Avoid

1. **The multi-process zoo.** Baserow runs Celery, Redis, Channels, a separate SSR server and an embedded Postgres, which is why it needs 2–4 GB. Use in-process Tokio tasks for background jobs, an in-process broadcast channel for realtime, and SQLite (WAL) as the only store. Serve a prebuilt SPA, with no SSR.
2. **DDL on the request path for big tables.** SQLite `ALTER TABLE ADD COLUMN` is cheap (metadata-only). Type changes and `DROP COLUMN` rewrite the table. So:
   - Run type conversions as background jobs with progress reporting.
   - Or store cells in a layout where type changes are metadata-only: real columns with SQLite's dynamic typing plus app-level type metadata. SQLite's flexible typing helps here.
   - **Never block the single writer for minutes.** Chunk rewrites into batches of about 5–10k rows.
3. **Whole-document-in-RAM** (Grist). Our 512 MB budget can't hold it. Query SQLite with pagination and windowed virtual scrolling, and never ship the full table to the client.
4. **Unbounded formula cascades.** Run recomputation incrementally and in batches, with depth and size limits and clear errors (not "Unknown error"). Recompute dependents in the same write transaction for small fan-out, and in a background job (with a per-row stale flag, as Baserow's `needs_background_update` does) for large fan-out.
5. **A sandboxed general-purpose language for formulas** (Grist's Python with gVisor). It is heavy and a security surface. Use a typed, side-effect-free expression language that compiles to SQL or to Rust closures.
6. **Bundling a database server whose major version changes** (the Baserow PG 11→15 upgrade problems). With SQLite as a library, upgrades become app-level migrations. Still:
   - Run migrations per base file inside a transaction.
   - Take an automatic `VACUUM INTO` backup before migrating.
   - Refuse to start on a newer schema than the binary understands.
7. **Licensing drift** (NocoDB AGPL→SUL, Teable and Baserow open-core). Commit publicly to MIT/Apache-2.0 for everything, and accept no CLA that allows relicensing **[recommendation]**.
8. **Soft-deleted rows that stay in hot indexes** (NocoDB). Use partial indexes (`WHERE deleted_at IS NULL`) or move trashed rows to a trash table.

### 3.3 Realistic scale targets (what others publish)

| Product | Published or observed limit |
|---|---|
| Airtable (benchmark) | About 1k rows per base (Free), 50k (Team), 125k (Business), 500k (Enterprise Scale) **[from memory, not re-verified 2026-10]** |
| Baserow cloud | 3k / 50k / 250k / 1M rows **per workspace** by tier. Self-host is "unlimited", but users struggle above millions, and wide formula-heavy tables at 10k–100k. Maximum 600 fields per table. |
| Grist | Hosted documents capped at 5k / 100k / 150k rows. Recommended at most 20 MB per document. |
| Teable | Marketing claim of "millions of rows", with no published benchmark. |
| NocoDB | No published per-base limit found. |

**Suggested OpenGrid targets** (to validate with benchmarks):

- Per table: 100k rows × 50 fields, including 5 formulas and 3 lookups.
- Grid scroll and page fetch p95 under 100 ms.
- Single-cell edit, including dependent recompute, p95 under 50 ms.
- Adding a field under 100 ms at any size.
- Type change on 100k rows runs as a background job of 10 s or less.
- Up to 25 concurrent users on 1 vCPU / 512 MB, with process RSS under 150 MB idle and under 300 MB under load.
- Document a "soft ceiling" of about 1M rows per base, rather than claiming "infinite".

### 3.4 Open questions and unverified items

- Baserow's exact SQL path for field-type conversions, and its lock behavior on big tables. I inferred this from Django's schema editor and did not read it line-by-line.
- Teable's physical storage layout (inferred from source file names) and its RAM requirements (from a third party).
- APITable's hardware requirements, and Rowy's license (GitHub reports NOASSERTION).
- Current Airtable plan limits.
- Which tier Baserow snapshots and the admin panel sit in.

## Sources

- https://baserow.io/pricing ; https://baserow.io/user-docs/pricing-plans ; https://baserow.io/user-docs/self-hosted-licenses ; https://baserow.io/user-docs/enterprise-license-overview
- https://baserow.io/docs/installation/install-with-docker ; https://baserow.io/docs/installation/configuration
- https://baserow.io/docs/technical/formula-technical-guide ; https://baserow.io/blog/how-baserow-lets-users-generate-django-models ; https://baserow.io/docs/technical/database-plugin
- https://community.baserow.io/t/read-me-first-technical-help-faqs/17 ; https://community.baserow.io/t/very-high-memory-usage/5409 ; https://community.baserow.io/t/wsgi-consume-a-lot-of-memory/3070 ; https://community.baserow.io/t/baserow-schema-updates-are-slowing-down-all-api-calls-and-brings-the-server-down/4271 ; https://community.baserow.io/t/table-design-with-lots-of-columns/9455 ; https://community.baserow.io/t/best-practices-for-efficiently-fetching-large-datasets-7k-rows-via-api/10862 ; https://community.baserow.io/t/issue-with-formula-calculation-in-the-tables-after-1100-rows/9786 ; https://community.baserow.io/t/important-postgresql-15-upgrade-in-the-docker-image/4971 ; https://community.baserow.io/t/problem-with-upgrading-database-to-15-version-postgesql/4995
- GitHub source: baserow/baserow `backend/src/baserow/config/settings/base.py`, `contrib/database/table/{constants,models}.py`, `core/action/handler.py`, `premium/LICENSE`, `backend/pyproject.toml`, `web-frontend/package.json`; release list
- https://support.getgrist.com/self-managed/ ; https://support.getgrist.com/limits/ ; https://support.getgrist.com/on-demand-tables/ ; https://community.getgrist.com/t/high-ram-usage-when-working-with-large-documents/14057 ; grist-core `documentation/overview.md`
- https://nocodb.com/docs/self-hosting/license ; https://nocodb.com/docs/product-docs/engineering/architecture ; https://forum.cloudron.io/topic/14918/heads-up-nocodb-is-no-longer-open-source./4
- https://github.com/teableio/teable ; https://help.teable.ai/en/deploy/docker ; https://shop.zimaspace.com (Teable hardware, third party)
- https://isitreallyfoss.com/projects/apitable ; https://github.com/apitable/terraform-apitable-enterprise
- https://github.com/buildship-ai/rowy (formerly rowyio/rowy)
