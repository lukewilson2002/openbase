# Airtable Feature Inventory (as of 2026-10-12)

Research input for **OpenGrid**, a self-hosted, single-binary Rust Airtable clone aimed at a 1 vCPU / 512 MB to 1 GB VPS with 25 users or fewer.

## How to read this

- **Sources.** The main source is Airtable's Help Center (`support.airtable.com/articles/*`). I fetched about 320 articles on 2026-10-12, most showing "last updated" within the past 2 months. I also used Airtable developer docs (`airtable.com/developers/web/api/*`) and a few third-party pricing write-ups, which are marked as such.
- **Verification markers.**
  - **[V]** means verified in Airtable docs today.
  - **[K]** means it comes from prior product knowledge and I could not confirm it in today's docs. Check these in-app before treating them as spec.
  - **[C]** means Airtable's own sources conflict.
- **Self-host feasibility** uses four ratings, each with a one-line reason:
  - **easy**: straightforward CRUD or UI work, with small memory cost.
  - **moderate**: real engineering (an engine, a scheduler, a complex UI), but it fits a single binary.
  - **hard**: significant complexity or risk to memory, correctness or security on a small VPS.
  - **ext**: depends on an external service (SMTP, an LLM API, OAuth to a third party, etc.).
- **Scope.** Enterprise-only features (SSO/SCIM, admin panel, HyperDB, audit-log APIs, eDiscovery, EKM, data residency, custom domains) are listed briefly in section 11 for completeness and are mostly out of scope.

---

## 1. Views

### 1.1 View types

| View | Plan | Key configuration | Self-host feasibility |
|---|---|---|---|
| **Grid** | All [V] | Hide/show and reorder fields; field width; header height (drag); row height Short/Medium/Tall/Extra Tall; freeze fields by dragging a divider ("no more than three fields can be frozen" per the Help Center [V]; I recall more being possible [C]); filter, sort, group (3 levels), color, summary bar; fill handle (drag to copy or extend evenly spaced dates); expand record (Space); every table must keep at least one collaborative grid view [V] | **moderate**: the core product. A virtualized canvas or DOM grid with copy/paste, fill handle and keyboard navigation is the biggest front-end job. |
| **Form** (legacy form view) | All; branding/cover/logo, redirect and removing "Airtable" branding are paid [V] | Field order and visibility; per-field label, help text and required; conditional field visibility (all plans), conditional *groups* (Business+); limit select options; limit linked-record selection to a view; after submit: message, "Submit another response" button, blank form after 5 s, or redirect URL (with `{record_id}` token); email responses to collaborators; "See who submitted" (requires login); cover image; logo (≤200×64 px); prefill via `?prefill_<Field>=value` (also `hide_` [K]), URL ≤ 8,000 chars [V]; computed fields not allowed; single page, no multi-step [V] | **easy/moderate**: public unauthenticated write endpoint needs rate limiting, CAPTCHA-free spam control, attachment size caps. |
| **Form builder** (new standalone forms, recommended) | All [V] | Everything above plus default values, warning messages, standalone sharing, conditional logic [V]; Airtable is moving features here, not to form view | **moderate**: ship one form system, not two. |
| **Calendar** | All; end date (ranges) and multiple date fields are paid [V] | Date field(s), optional end date (ranges), multiple date fields with labels; Month / 2-week / Week / 3-day / Day modes; drag to reschedule or resize; unscheduled sidebar (drag to clear date); card labels; color incl. "color by date field"; no grouping [V]; iCal subscription feed and ICS download [V] | **moderate**: the UI is work, but the iCal feed is cheap and high value. |
| **Gallery** | All [V] | Cover field (attachment), crop vs fit; "Customize cards" field visibility and order; filter/sort/color; card size not adjustable [V] | **easy**: needs thumbnailing (see attachments). |
| **Kanban** | All [V] | Stack by single select, user, or single-link linked record (not computed fields) [V]; card field visibility; "Wrap long cell values"; hide empty stacks [K]; cover image [K]; filter/sort/color; drag between stacks writes the field | **easy** |
| **Timeline** | Paid [V] | Start (+ optional end) date; swimlanes = group by any field; label customization; date settings (timescale day…year [K]); summary bar with *one* function per view incl. **Utilization** resource allocation (allocated hours, resource, available hours, days off) [V]; optional **Gantt layout** (dependency arrows) [V] | **moderate/hard**: resource utilization math is fiddly. |
| **Gantt** | Paid [V] | Start/end date; dependency field (self-link) as predecessors or successors; milestones (end date only, diamond); dependency arrows drawn in chart; invalid (red) dependencies and cycles flagged; critical path highlight [V]; end dates inclusive; no print [V] | **moderate**: critical path is a DAG longest-path calculation (easy), and the UI is the work. |
| **List** | All [V] | Hierarchical, multi-table: Level 1 = this table, levels 2–3 = linked tables via chosen link fields; "Enable nested records" (self-link tree); per-level filter, sort, row height, visible fields, prefix field (checkbox/user/single select); custom record terminology per level [V] | **moderate**: tree queries across links. |

Interface Designer has its own layouts (List, Gallery, Kanban, Calendar, Timeline, Grid, Overview, Form, Dashboard, Record review, Record detail, Blank legacy, Roadmap on Business+). See section 9.

### 1.2 View configuration common to most views

| Feature | Detail | Feasibility |
|---|---|---|
| **Collaboration type** | *Collaborative* (anyone with edit can change), *Personal* (only owner configures; paid), *Locked* (only Owner/Creator can unlock; paid) [V]. Tables with more than 20 views default new views to personal [V]. Commenters can create personal views [V]. | **easy**: a view owner id plus a lock flag. |
| **View sections and favorites** | My favorites, My personal views, More personal views, custom sections (paid), More collaborative views [V]; view descriptions [K] | **easy** |
| **Copy configuration from another view** | Same table only; choose sorts, groups, filters, field order, etc. [V] | **easy** |
| **Filters** | Condition = field + operator + value. Groups nest **3 levels max** (top, group, sub-group); each group uses **one** conjunction (AND *or* OR); **max 49 conditions per view** [V]. Drag to reorder. Advanced nested filters also apply in record coloring, conditional form fields and interfaces. Automations use conditions but **not nested groups** [V]. | **moderate**: filter compiler to SQL needs per-type semantics (below). |
| **Sorts** | Multiple sort levels, drag to reorder; "Automatically sort records" toggle (off = manual drag order + "Sort" button) [V]. Text uses natural sort ("z2" < "z11"); selects sort by option order; attachments by filename; blanks first ascending [V]. | **easy/moderate**: natural sort collation plus a manual order (fractional index) column. |
| **Grouping** | Grid, Timeline, List, Gantt only [V]; up to **3 levels**; collapse/expand all; per-group sort order; show/hide empty groups; drag records between groups to reassign value (not for computed fields); per-group summary bar and record count [V] | **moderate** |
| **Hide / reorder fields** | Per view; primary field cannot be hidden [V] | **easy** |
| **Row height** | Short / Medium / Tall / Extra Tall (grid, list per level) [V] | **easy** |
| **Record coloring** | Paid [V]. *By single select* (option colors) or *by conditions* (ordered color rules, each with nested condition groups, first match wins, optional default color); *by date field* in multi-date calendar [V]. Shown as left flag (grid/list), card stripe (kanban/gallery), full card (calendar/timeline/Gantt) [V]. | **easy**: reuse filter engine. |
| **Summary bar** | Per field in grid (one function per timeline view) [V]. Numeric: Sum, Average, Median, Min, Max, Range, Standard Deviation, Histogram. All non-computed fields: Empty, Filled, Percent Empty, Percent Filled. Many types: Unique, Percent Unique. Checkbox: Checked, Unchecked, Percent Checked, Percent Unchecked. Date: Earliest Date, Latest Date, Date Range (days), Date Range (months). Attachment: total size [V]. Applies to a selected range only when cells are selected; per group when grouped [V]. | **easy/moderate**: SQL aggregates, but doing them per group across 50k rows must be streamed. |
| **Search (find in view)** | Ctrl/Cmd-F search across visible cells with match navigation [K]; interface search returns ≤200 results [V] | **easy**: SQLite FTS5 or a LIKE scan. |
| **Print view / Download CSV** | All roles incl. Read-only can download CSV and print a view [V] | **easy** |
| **Share view** | See 5.3 | **easy** |
| **Shared view URL filters** | Filters encoded in the share URL [V] | **easy** |
| **Embed view** | `<iframe>` of a share link; auto-updates in real time [V] | **easy**: needs a CSP `frame-ancestors` policy. |

### 1.3 Filter operators per field type

Airtable's docs only document part of the operator matrix. Rows marked [V] were confirmed in docs; the rest is [K] (standard Airtable behavior I have seen, but not re-verified today).

| Field type | Operators |
|---|---|
| Text (single line, long text, email, URL, phone) | contains, does not contain, is, is not, is empty, is not empty. "contains" is case-insensitive, "is" case-sensitive [V] |
| Number / currency / percent / duration / rating / autonumber | `=`, `≠`, `<`, `≤`, `>`, `≥`, is empty, is not empty ([V] for >, <) |
| Date / date-time / created time / last modified time | is, is not, is before, is after, is on or before, is on or after, is within, is empty, is not empty. Relative values: today, tomorrow, yesterday, one week ago, one week from now, one month ago, one month from now, number of days ago, number of days from now, exact date. "is within": past week / month / year, next week / month / year (rolling 7/30/365 days, not calendar periods [V]), past/next number of days [K], "this calendar week/month/year" [K, unverified] |
| Single select | is, is not, is any of, is none of, is empty, is not empty |
| Multiple select / linked record / lookup | is exactly, has any of, has all of, has none of (empty always matches "has none of"), is empty, is not empty [V]. No partial "contains" on multi-select [V]. Linked records also support text contains / does not contain on display names [K] |
| User / created by / last modified by | is, is not, is any of, is none of, has any of / has all of / is exactly (multi-user), is empty, is not empty, and the **current user ("me")** dynamic value, used for "My tasks" pages [V for current-user concept] |
| Checkbox | is checked / is not checked |
| Attachment | filename contains / does not contain, has file type (image, text, PDF, …), is empty, is not empty [K] |
| Formula / rollup / lookup | Operators follow the *result type* |
| Button, barcode | barcode: text operators on value [K]; button not filterable [K] |

**OpenGrid note:** one shared "condition AST" should drive view filters, coloring, conditional lookup/rollup/count, linked-record selection filters, form field visibility, automation conditions, interface filters and permission row filters. That covers seven or more features with one engine.

---

## 2. Field types

Field identifiers come from the Web API field model [V]. The Help Center lists 27 user-facing types plus AI variants [V].

| Field type (API id) | Options | Feasibility |
|---|---|---|
| Single line text (`singleLineText`) | Default value | **easy** |
| Long text (`multilineText` / `richText`) | Enable rich text (Markdown-style subset: bold, italic, strike, code, headings, lists, checklists, quotes, links, @mentions) [V]; AI text variant | **easy/moderate**: store Markdown, render safely (XSS!). |
| Attachment (`multipleAttachments`) | Files up to **5 GB each** [V]; thumbnails (small/large/full); per-base storage quota by plan; expiring download URLs (~2 h) vs non-expiring viewer URLs for collaborators [V]; proofing/annotation on images & PDFs (paid) [V]; sort by filename | **moderate**: streaming upload to disk or S3, thumbnailing with a memory cap, signed expiring URLs. Previews for Office docs are **ext**. |
| Checkbox (`checkbox`) | Icon (check, star, heart, thumbs-up, flag, dot) and color [V for icon/color options] | **easy** |
| Single select (`singleSelect`) | Choices with id/name/color; order; alphabetize; default; inline add (permissions); AI-assist [K] | **easy** |
| Multiple select (`multipleSelects`) | Same as above | **easy** |
| User (`singleCollaborator` / `multipleCollaborators`) | Allow multiple users; notify users when added [V for notifications]; only users with workspace/base/interface access are selectable [V] | **easy** (notifications **ext**: SMTP) |
| Date (`date`) / Date-time (`dateTime`) | Date format Local / Friendly / US / European / ISO; include time; 12h/24h; "Use same time zone (GMT) for all collaborators" or a specific zone; display time zone; default to current date [V]; seconds not enterable in UI [V] | **moderate**: time-zone semantics are a known bug farm. Store UTC plus a field TZ, and use `chrono-tz`. |
| Phone (`phoneNumber`) | none (formats US/CA) [V] | **easy** |
| Email (`email`) | none [V] | **easy** |
| URL (`url`) | none [V] | **easy** |
| Number (`number`) | Integer / decimal with precision (0–8 [K]); thousands separator style (local, comma-period, period-comma, space, …) [K]; large-number abbreviation (K/M/B) [K]; allow negative [K]; default | **easy**. Use decimal-safe storage (i64 scaled or `rust_decimal`) for currency. |
| Currency (`currency`) | Symbol, precision, formatting as Number [V] | **easy** |
| Percent (`percent`) | Precision; stored as fraction (0.75 = 75%); optional progress bar [K] | **easy** |
| Duration (`duration`) | `h:mm`, `h:mm:ss`, `h:mm:ss.s`, `.ss`, `.sss` [V]; stored as seconds | **easy** |
| Rating (`rating`) | Max 1–10, icon (star, heart, thumbs-up, flag, dot), color [V partial] | **easy** |
| Formula (`formula`) | Expression; result type inferred; result formatting (number/date/etc.); `referencedFieldIds`; AI "Generate formula" [V] | **hard**: parser, type checker, dependency graph, incremental recompute. Core work. |
| Rollup (`rollup`) | Link field + target field + aggregation formula (section 3.2); conditions to filter linked records; result formatting [V] | **moderate**: built on the formula engine plus link joins. |
| Count (`count`) | Link field; conditions [V] | **easy** |
| Lookup (`multipleLookupValues`) | Link field + target field; conditions; **sort linked records by a field + "Limit the number of items shown"** (e.g. latest 1) [V]; preserves rich text [V] | **moderate** |
| Link to another record (`multipleRecordLinks`) | Linked table; allow linking to multiple records (off = 1); create inverse field (symmetric) or one-way [K, `isReversed`/`inverseLinkFieldId` V]; limit record selection to a view [V]; **dynamic filtering** (filter selectable records by condition, including conditions relative to the current record; paid) [V]; AI-suggested records / "Deep Match" [V]; self-links (for dependencies, trees) | **moderate**: join table, symmetric maintenance in one transaction, cascade on delete. |
| Created time (`createdTime`) | Date format/time options [V] | **easy** |
| Last modified time (`lastModifiedTime`) | All fields or **specific fields** only; formatting [V] | **easy/moderate**: per-field modification tracking. |
| Created by (`createdBy`) | none [V] | **easy** |
| Last modified by (`lastModifiedBy`) | All fields or specific fields [K] | **easy** |
| Autonumber (`autoNumber`) | none; unique increasing per table [V] | **easy** |
| Barcode (`barcode`) | Scans barcodes/QR via mobile camera; stores `{text, type}` [V] | **easy** (web: `BarcodeDetector` or a JS lib; no native app) |
| Button (`button`) | Label, style/color; actions: **Open URL** (formula), Preview URL, Open page designer, **Run script** (scripting extension), Send email with SendGrid, open Formstack / Pexels / custom extension, Open source record (synced tables) [V]; "run automation" is via the automation trigger "When a button is clicked" (interface buttons) [V] | **easy** for URL and automation buttons; extension actions depend on the extension system. |
| AI text / AI number / AI-linked ("field agents") (`aiText`, etc.) | Prompt / custom instructions referencing fields; model choice; web search and document analysis; "Generate" manually or auto-run; field agent catalog [V] | **ext**: requires an LLM API key (BYO OpenAI/Anthropic/Ollama). |
| External sync source (`externalSyncSource`) | Read-only source indicator on synced tables [V] | n/a (depends on sync) |

**Field-level extras.** These include field descriptions [K], the primary field (any non-computed type or a formula; cannot be hidden or deleted) [V], field type conversion with best-effort data conversion that may lose data [V], Field manager (paid; a table of all fields and dependencies) [V], bulk field actions [V] and field editing permissions (5.2). Field-level feasibility: **easy**, except type conversion, which is **moderate** and needs a dry-run preview and an undo snapshot.

---

## 3. Formulas, rollups, lookups, counts

### 3.1 Formula function list

The full set from the official reference (article 7330071120) was cross-checked twice today [V]. I found **84 distinct functions**.

| Category | Functions |
|---|---|
| **Operators** | Arithmetic `+ - * /`; comparison `= != < > <= >=`; text concat `&`; parentheses; field refs `{Field Name}` |
| **Text (16)** | `ARRAYJOIN`*, `CONCATENATE`, `ENCODE_URL_COMPONENT`, `FIND`, `LEFT`, `LEN`, `LOWER`, `MID`, `REPLACE`, `REPT`, `RIGHT`, `SEARCH`, `SUBSTITUTE`, `T`, `TRIM`, `UPPER` |
| **Logical (11)** | `AND`, `BLANK`, `ERROR`, `FALSE`, `IF`, `ISERROR`, `NOT`, `OR`, `SWITCH`, `TRUE`, `XOR` |
| **Numeric (22)** | `ABS`, `AVERAGE`, `CEILING`, `COUNT`, `COUNTA`, `COUNTALL`, `EVEN`, `EXP`, `FLOOR`, `INT`, `LOG`, `MAX`, `MIN`, `MOD`, `ODD`, `POWER`, `ROUND`, `ROUNDDOWN`, `ROUNDUP`, `SQRT`, `SUM`, `VALUE` |
| **Date & time (27)** | `CREATED_TIME`*, `DATEADD`, `DATESTR`, `DATETIME_DIFF`, `DATETIME_FORMAT`, `DATETIME_PARSE`, `DAY`, `HOUR`, `IS_AFTER`, `IS_BEFORE`, `IS_SAME`, `LAST_MODIFIED_TIME`*, `MINUTE`, `MONTH`, `NOW`, `SECOND`, `SET_LOCALE`, `SET_TIMEZONE`, `TIMESTR`, `TONOW`, `FROMNOW`, `TODAY`, `WEEKDAY`, `WEEKNUM`, `WORKDAY`, `WORKDAY_DIFF`, `YEAR` |
| **Array (5)**: only in rollups or on lookup inputs [V] | `ARRAYCOMPACT`, `ARRAYFLATTEN`, `ARRAYJOIN`, `ARRAYSLICE`, `ARRAYUNIQUE` |
| **Record (3)** | `CREATED_TIME`, `LAST_MODIFIED_TIME` (optionally takes field list), `RECORD_ID` |
| **Regex (3)** | `REGEX_MATCH`, `REGEX_EXTRACT`, `REGEX_REPLACE` (RE2-style syntax [K]) |

\* listed in two categories.

**Supporting specs the formula engine must match.** All have dedicated Help Center pages [V]:

- `DATETIME_FORMAT` specifiers, which are Moment.js-style tokens such as `YYYY`, `Q`, `w`, `LLL` and others.
- `DATETIME_DIFF` / `DATEADD` units: milliseconds, seconds, minutes, hours, days, weeks, months, quarters, years, plus their abbreviations.
- `SET_TIMEZONE`, which takes IANA zones.
- `SET_LOCALE` locale codes.
- `WORKDAY` / `WORKDAY_DIFF` holiday lists.
- `NOW()` / `TODAY()` recompute roughly every 5 minutes while the base is open and hourly otherwise [V].
- `TRUE` is 1 and `FALSE` is 0.
- Blank handling, `#ERROR!` propagation, and `"\n"` in strings.

**Feasibility: hard but essential.** The work is a Pratt parser with type inference (text/number/date/bool/array/error), a dependency DAG across fields and tables (via lookups and rollups), incremental recomputation on write, and a persisted computed-value cache, so that sort, filter and group can run in SQL. `NOW()`/`TODAY()` need a periodic recompute job. Regex should use the `regex` crate, which is linear-time and safe against ReDoS. Moment-format compatibility is the largest compatibility surface.

### 3.2 Rollup aggregation functions [V]

`AND`, `ARRAYCOMPACT`, `ARRAYFLATTEN`, `ARRAYJOIN`, `ARRAYSLICE`, `ARRAYUNIQUE`, `AVERAGE`, `CONCATENATE`, `COUNT`, `COUNTA`, `COUNTALL`, `MAX`, `MIN`, `OR`, `SUM`, `XOR`. The rollup expression is a formula over `values`, so arbitrary expressions such as `SUM(values) * 1.2` work.

- **Conditions:** rollups can be limited to linked records matching conditions ("conditional rollup"). View filters never affect rollups [V].

### 3.3 Lookup and count behavior [V]

- **Lookup** returns an array with one item per linked record, with no aggregation. If the target field is itself multi-valued, the result is nested (`ARRAYFLATTEN`).
- Lookups support conditions, **sort by a field of the linked record**, and **limit to N items**.
- Lookups preserve rich text and cannot be edited, used as kanban stack fields, or dragged between groups.
- **Count** returns the number of linked records in a link field, optionally filtered by conditions.
- **Invalid conditions** (a referenced field was deleted or changed type) block saving and must be fixed [V]. OpenGrid needs schema-change validation of dependent conditions.

**Feasibility:** **moderate**. Each is a join plus an aggregate, recomputed when either side changes. A naive design fans out writes, so cache per-record results and invalidate through the dependency graph.

---

## 4. Record features

| Feature | Detail | Feasibility |
|---|---|---|
| **Expand record** | Full-record modal (Space / Shift-Space for a cell); shows hidden fields on demand; prev/next navigation; record URL [V] | **easy** |
| **Add / duplicate / delete** | Duplicate record (copies values), bulk select delete, Cmd-Z undo [V]; insert above/below [K] | **easy** |
| **Comments** | Commenter+ can comment; threads per record; **@mentions** of collaborators; resolve/reopen comments; per-record "watch all comments" vs mentions-only; email and mobile push notifications; **≤ 5 attachments per comment, 10 MB each** [V]; reactions [K]; comment count available via API `recordMetadata=commentCount` [V]; comment API (read/write scopes) [V] | **easy** (email notifications **ext**: SMTP) |
| **@mentions in long text** | Mention collaborators inside rich text [V] | **easy** |
| **Record-level revision history** | Field-by-field change log with actor and time in the expanded record. Retention: Free 2 weeks, Team 1 year, Business **2 years** [C: plans page says 1 year], Enterprise Scale 3 years [V] | **moderate**: an append-only change log table. Cheap in SQLite if values are stored as compact diffs, but needs a retention/compaction policy. |
| **Base snapshots** | Automatic plus manual snapshots of a whole base; restore *to a new base*; retention Free 2 weeks, Team 1 year, Business 2 years, Ent 3 years [V] | **easy**: SQLite `VACUUM INTO` or the online backup API per base file. This is a reason to use **one SQLite file per base**. |
| **Trash** | Base trash restores deleted tables, views, fields, extensions and records for **7 days**; workspace trash restores bases and workspaces for **30 days** [V] | **easy**: soft-delete with a reaper job. |
| **Attachments** | Drag-drop, paste, URL import; preview images/PDF/video/audio/Office [V]; bulk drop creates records [V]; annotations ("proofing") [V] | **moderate** (Office preview **ext**) |
| **Record templates** | Paid. Preset parent record values plus linked child and grandchild records (up to 3 table levels); "Create record with template", "Apply template" to existing (fills empties, appends to arrays), and from automations; limits: Team 100, Business 500, Ent 2,000 templates per base (each sub-record counts) [V] | **moderate**: a transactional multi-table insert. |
| **Copy / paste** | Spreadsheet-style paste of ranges, auto-expands rows; Airtable suggests pasting in 200–300-record batches for large pastes [V] | **moderate**: batch transaction plus type coercion. |
| **Record URLs / deep links** | Every record and view has a stable URL; IDs `rec…`, `fld…`, `tbl…`, `viw…`, `app…` [V] | **easy** |
| **Row-level "who changed what" notifications** | Base activity in Slack [V] | **ext** |

---

## 5. Collaboration

### 5.1 Roles and permission levels

Workspace and base permissions are independent, and the **higher one wins** [V]. Nobody can grant a level above their own [V].

| Capability | Owner/Creator | Editor | Commenter | Read-only |
|---|---|---|---|---|
| View base, invite at or below own level | yes | yes | yes | yes |
| Create/remove view share links | yes | yes | | |
| Base invite links, rename base | yes | | | |
| Comment | yes | yes | yes | |
| Add/edit/delete records | yes | yes | | |
| Download CSV, print, copy view data | yes | yes | yes | yes |
| Create/modify views | yes | yes | personal only | |
| Lock/unlock views; delete others' personal views | yes | | | |
| Add/delete/rename/configure **fields and tables**, import CSV as table | yes | | | |
| Create/configure automations | yes | | | |
| View automation config | yes | yes | yes | yes |
| Sync now / syncable share links | yes | yes | | |
| Create/delete synced tables | yes | | | |
| Create interfaces, publish, restrict sharing | yes | | | |
| Edit records in interfaces / submit interface forms | yes | yes | | |

Source: the "Airtable base permissions" article [V]. Owner differs from Creator in that only Owners can delete or transfer the workspace and manage billing [K].

- **Interface-only collaborators** (paid): Viewer, Commenter or Editor *on an interface only*, with no access to the underlying base [V]. They require a verified Airtable account; share links are not allowed [V].
- **Portals** (paid add-on, Team+): external guests on interfaces with a custom branded sign-in page (Business+) [V].
- **Billing:** only editors and above are billable; read-only users and commenters are free on Team/Business [V]. On Free, the cap is **5 Editor-or-Creator collaborators**, unlimited read-only and 50 commenters [V].
- **Feasibility:** **easy/moderate**. Use a role enum per (user, workspace) and (user, base), take the max, and enforce on *every* API path in one place. Interface-only access is **moderate**, because it means row and field scoping per interface.

### 5.2 Field and table editing permissions [V]

- **Plans:** Team, Business, Enterprise.
- **Per field:** restrict who can **edit values**: specific users or a role threshold (e.g. Creators only, or specific editors). Configuration changes stay Creator-only.
- **Per table:** restrict who can **create records** and who can **delete records**.
- **Enforcement:** these are enforced everywhere, including the grid, interfaces, mobile, extensions and the **REST API**. A common pattern is to restrict a field to the API user's account so that only an integration can write it.
- **Limits:** these permissions do **not** restrict *visibility*. Hiding data requires share views, interfaces or interface-only access [V].
- **Feasibility: easy.** Store a per-field and per-table ACL and check it in the write path.

### 5.3 Share links

| Kind | Options | Feasibility |
|---|---|---|
| **View share link** (read-only public) | Random URL; no account needed; toggles: allow copying data out, show all fields in expanded records, **password** (paid), **restrict to email domain** (paid; viewer must log in with matching domain), restrict to enterprise domains (Business+); generate new link (revoke old); disable/re-enable keeps URL; includes view coloring/filters [V]. **No per-email allowlists** [V]. | **easy**: a share-token table with an argon2 password hash. Domain restriction needs an OpenGrid account login. |
| **Base share link** (read-only public, whole base) | Same restrictions (password/domain on Team+) [V] | **easy** |
| **Base invite link** | Grants a permission level; optional "Only allow emails from" domain [V] | **easy** |
| **Interface invite link** | Grants interface access [V] | **easy** |
| **Form link** | Public submission; see section 1.1 | **easy** |
| **Syncable share link** | Allows other bases to sync this view [V] | depends on sync |
| **iCal link** | Calendar feed; breaks when password/domain restrictions are on [V] | **easy** |
| **Embeds** | View, base and form iframes [V] | **easy** |

### 5.4 Real-time behavior

- All edits autosave instantly and propagate live to other viewers [V]. Embeds update in real time [V].
- Collaborator presence avatars and record-level "X is viewing" indicators [K].
- Undo/redo (Cmd-Z) is per user and per session [V].
- No offline mode [V: FAQ exists; the answer was not captured, though my knowledge says no offline mode].
- Airtable explicitly says it is "not intended to be a backend hosting service/real-time database" [V].
- **Feasibility: moderate.** Use a WebSocket hub per base (tokio broadcast) carrying op-based change events with a monotonically increasing base transaction number. The same number can feed webhooks and the API cursor. Airtable does its own versioning per base, as `baseTransactionNumber` in webhooks shows [V]. Last-writer-wins per cell is fine for 25 users, so CRDTs are unnecessary except for collaborative rich text, which can be cut.

### 5.5 Notifications

Mentions, comments on watched records, being added to a user field (with interface-only exceptions), and automation failure alerts to the last enabler [V]. Channels are in-app, email and mobile push [V]. Feasibility: in-app is **easy**; email is **ext** (SMTP); push is **ext**/skip.

---

## 6. Automations

### 6.1 Limits [V]

| Plan | Runs / month / workspace | Automations per base | Run history |
|---|---|---|---|
| Free | 100 | 75 | 2 weeks |
| Team | 25,000 | 100 | 6 months |
| Business | 100,000 | 150 | 1 year |
| Enterprise Scale | 500,000 | 200 | 3 years |

Other limits [V]:

- **Actions per automation:** 25. Conditional groups count toward this.
- **Repeating groups:** input list ≤ **8,000** items; iteration order not guaranteed; no "finished" signal.
- **Find records:** default and maximum **1,000** per run (legacy steps default to 100).
- **Run a script:** 30 s documented timeout, temporarily raised to **120 s**; scripting API calls time out at 12 s; `fetch` at 30 s; **50 fetches per run**; **15 mutations per second**, 50 records each; **512 MB** memory; 6 MB output; **Secrets** store for API keys. Not available on Free.
- **Webhook trigger:** **5 req/s**; **100 KB** payload; every received webhook counts as a run.
- **Email-received trigger:** Business+; **30 MB** max email; attachments via 2 h expiring URLs.
- **Send email:** recipients that are collaborators are unlimited; non-collaborators: Free none, Team 100/day, Business 1,000/day, Ent unlimited. **100 records** max in an inserted list or grid; 100 attachments; **25 MB** total.
- **Generate with AI:** prompt ≤ **64,000** characters.
- **Scheduled trigger:** fixed intervals (below); **does not adjust for DST** [V].
- **Scope:** automations cannot cross bases; a script plus the API is the workaround. They never retroactively process existing records. Failed and successful runs both count against limits. Disabled automations still count against the per-base cap.
- **Versioning:** automation **revision history** (versions per edit) and run history with step-by-step logs and filtering [V].

### 6.2 Triggers

| Trigger | Notes | Feasibility |
|---|---|---|
| When record matches conditions | Fires when a record *enters* matching state (conditions set in the automation) [V] | **moderate**: evaluate conditions after each write and track per-record match state. |
| When record created | [V] | **easy** |
| When record updated | Optionally limited to specific watched fields [V] | **easy** |
| When record enters view | [V] | **moderate**: same state-tracking as above. |
| When a form is submitted | [V] | **easy** |
| When a comment is added | Any comment in table, no filter [V] | **easy** |
| At scheduled time | Intervals: Minutes (15/30/45/60), Hours (1–24), Days (1–30), Weeks (weekday picks), Months, One time [V] | **easy**: an in-process scheduler. Do DST correctly, which beats Airtable. |
| When webhook received | Unique secret URL; JSON body becomes tokens [V] | **easy**: rate-limit and size-cap it. |
| When a button is clicked | Interface buttons [V] | **easy** |
| When email received | Unique inbound address (Business+) [V] | **ext/hard**: needs an inbound SMTP server or a provider webhook (Mailgun etc.). A good candidate to cut, or to offer as an IMAP poll. |
| Google Workspace: new Google Form response, new Sheets row | [V] | **ext**: OAuth app plus polling. |
| Outlook: new calendar event, email received | [V] | **ext** |

### 6.3 Actions and logic

| Action | Notes | Feasibility |
|---|---|---|
| Create record | Field mapping from tokens; link by primary value or ID; "From a template" [V] | **easy** |
| Update record | Same as above [V] | **easy** |
| Delete record | [V] | **easy** |
| Find records | By view or conditions (static or dynamic tokens), max records [V] | **easy** |
| Sort list | Sorts a list from a previous step [V] | **easy** |
| Send email | Markdown/limited HTML body, lists/grids of records, attachments [V] | **ext**: SMTP (lettre crate). |
| Run a script | JS sandbox with an Airtable-like API, `fetch`, secrets, input/output config [V] | **hard**: embedding a JS engine (QuickJS via `rquickjs`, or Boa) with CPU/memory limits on a 512 MB box. **Lua via `mlua` or Rhai** is much lighter. Consider WASM later. |
| Generate with AI | Model choice, prompt with tokens [V] | **ext**: BYO LLM key. |
| **Conditional groups** (if/else-if branches) | Count toward the 25 actions; no nested filter groups in automations [V] | **easy** |
| **Repeating groups** (for-each) | Max 8,000 items [V] | **easy** |
| Delay | No native delay; workaround articles exist [V: "How to delay automation runs" is a workaround] | **easy** to do natively (a differentiator). |
| Slack: send message (channel/DM) | [V] | **ext** (incoming webhook URL is easy) |
| Microsoft Teams: send message | [V] | **ext** |
| Google Workspace actions (Gmail send, Calendar create/update event, Sheets append row, Docs, Drive) | [V] | **ext** |
| Outlook: send email, calendar events | [V] | **ext** |
| Jira Cloud / Jira Server-DC: create/update issue | [V] | **ext** |
| Salesforce: create/update/find records | [V] | **ext** |
| GitHub Issues: create/update issue | [V] | **ext** |
| Facebook Pages post; Hootsuite schedule post; Twilio send SMS | [V] | **ext** |
| Document automator (generate PDF/doc from template) | [V] | **moderate**: HTML-to-PDF in pure Rust is weak. Use Typst (Rust-native) templates, or cut. |

**OpenGrid recommendation.** Ship a generic **"Send HTTP request"** action (method, headers, JSON body template, response to tokens) and an **"Outgoing webhook"** action. Together with SMTP email, these replace about 80% of the vendor-specific integrations without OAuth apps.

---

## 7. REST API, webhooks, tokens

### 7.1 Shape [V]

- **Base URL:** `https://api.airtable.com/v0/`. Authentication is `Authorization: Bearer <PAT or OAuth token>`. Legacy API keys are deprecated.
- **Records:**
  - `GET /v0/{baseId}/{tableIdOrName}` lists records. Parameters: `pageSize` ≤100, `maxRecords`, `offset` (opaque cursor), `view`, `filterByFormula` (any formula; truthy keeps the record), `sort[]`, `fields[]`, `cellFormat=json|string` (+`timeZone`, `userLocale`), `returnFieldsByFieldId`, `recordMetadata[]=commentCount`.
  - URLs must stay **under 16,000 chars**; otherwise use `POST /v0/{baseId}/{table}/listRecords`.
  - Responses look like `{records:[{id, createdTime, fields, commentCount?}], offset?}`. Empty fields are omitted.
  - `GET/PATCH/PUT/DELETE /v0/{baseId}/{table}/{recordId}`.
  - Batch create/update/delete accepts **up to 10 records per request** [V]. `PATCH` merges and `PUT` replaces (clears omitted fields).
  - **Upsert:** `performUpsert.fieldsToMergeOn` (1–3 non-computed fields) returns `createdRecords` and `updatedRecords`. `typecast:true` coerces strings, including creating new select options.
- **Comments:** list, create, update and delete comments on a record [V via scopes].
- **Attachments:** upload-attachment endpoint (~5 MB direct upload) [V]; otherwise attach by public URL.
- **Metadata / schema API:** `GET /v0/meta/bases`, `GET /v0/meta/bases/{id}/tables` (tables, fields, views), plus create table, create/update field, update table [V]. Metadata calls count toward limits [V].
- **Rate limits:**
  - **5 req/s per base**, plus **50 req/s per user/service account across all PATs** [V].
  - A 429 means waiting **30 s** [V].
  - Monthly caps: **Free 1,000 calls/workspace** (30-day grace period, then blocked); **Team 100,000** (then throttled to 2 req/s); Business and Enterprise unlimited [V].
- **Other API surfaces:** Sync API (push CSV into a synced table, premium) [V], Scripting API (in extensions and automations), Blocks SDK (custom extensions, React) [V], the Enterprise API, and the **MCP server** (official; OAuth or PAT; search/read/create/update records, create bases, interfaces and pages, inspect automations) [V].

### 7.2 Personal access tokens, OAuth, service accounts [V]

- **PATs** are scoped by **scopes** and by **resources** (specific bases, specific workspaces or all). They **do not expire** until revoked or regenerated. They cannot be scoped to an interface or view. They inherit the owner's base permissions, including field and table editing permissions.
- **Scopes** (non-enterprise): `data.records:read`, `data.records:write`, `data.recordComments:read`, `data.recordComments:write`, `schema.bases:read`, `schema.bases:write`, `webhook:manage`, `block:manage`, `user.email:read`, `workspacesAndBases:read`. Enterprise adds `workspacesAndBases:write`, `workspacesAndBases.shares:manage`, `enterprise.*` (SCIM, audit logs, change events, exports, users, groups, account) and `hyperDB.records:*`.
- **OAuth 2.0:** authorization code + PKCE for third-party integrations, using the same scopes [V].
- **Service accounts:** non-human principals, Enterprise Scale only, maximum 30 [V].
- **Feasibility: easy.**
  - Store hashed tokens (`og_pat_<id>_<secret>`) and enforce `scope ∩ resource ∩ role` in middleware.
  - **Matching the Airtable v0 API shape closely is a strong adoption lever**, because existing scripts, the `airtable.js` client, Zapier/n8n/Make connectors, and the MCP pattern would work against OpenGrid by changing the base URL.
  - `filterByFormula` comes for free once the formula engine exists.

### 7.3 Webhooks API [V]

- `POST /v0/bases/{baseId}/webhooks` takes `{notificationUrl?, specification:{options:{filters, includes}}}` and returns `{id, macSecretBase64, expirationTime}`. The MAC secret is shown **once**.
- **Filters:**
  - `dataTypes` (required): `tableData`, `tableFields`, `tableMetadata`.
  - `recordChangeScope`: table or view id (not form or list views).
  - `changeTypes`: add, remove, update.
  - `fromSources`: client, publicApi, automation, formSubmission, sync and others.
  - `sourceOptions`.
  - `watchDataInFieldIds` / `watchSchemasOfFieldIds`.
- **Includes:** `includeCellValuesInFieldIds` (ids or `"all"`), `includePreviousCellValues`, `includePreviousFieldDefinitions`.
- **Delivery model:** a *ping-then-pull* design. Airtable POSTs a small notification to `notificationUrl` (body contains base and webhook ids and a timestamp, signed with an HMAC-SHA256 header `X-Airtable-Content-MAC` [K: the header name was not on the pages I fetched]). The client then calls `GET …/webhooks/{id}/payloads?cursor=N&limit≤50`. The response contains `payloads[{timestamp, baseTransactionNumber, payloadFormat:"v0", actionMetadata{source, sourceMetadata.user}, changedTablesById…}]`, `cursor` and `mightHaveMore`. Cursors never reset.
- **Retention:** payloads are kept **7 days**. PAT/OAuth webhooks **expire after 7 days** unless refreshed (via the refresh endpoint or by listing payloads). Maximum **10 webhooks per base** (2 per OAuth integration). Creating one requires Creator.
- **Feasibility: moderate.** Store a per-base change log keyed by transaction number. This is the same log used for real-time updates, revision history and undo. Webhooks are filtered projections of it. Outbound delivery needs an SSRF guard: block private IP ranges by default and allow an admin override for LAN use.

---

## 8. Import and export

| Feature | Detail | Feasibility |
|---|---|---|
| CSV import | New base, new table, or into an existing table (field mapping, "auto-select field types", first row as headers); **100 MB CSV** limit [V] | **easy**: streaming `csv` crate; avoid loading the file into RAM. |
| Excel import (.xlsx) | **5 MB** limit [V] | **easy/moderate**: the `calamine` crate. |
| Google Sheets import | Via OAuth [V] | **ext** (users can upload a CSV export instead) |
| Paste from spreadsheet | Tab-separated paste [V] | **easy** |
| Other importers | CSV import extension (into existing with merge/dedupe), XML import extension, Calendar import, Contact import (vCard), Dedupe extension, Batch update extension [V]; imports from Trello, Asana, Smartsheet, etc. [K] | **easy-moderate** individually; third-party SaaS importers are **ext**. |
| Omni-assisted import | Upload a file, Omni designs the tables [V] | **ext** |
| CSV export | Per view, respecting filters, sorts and visible fields; attachments appear as expiring URLs [V] | **easy** |
| Calendar export | iCal feed, ICS download [V] | **easy** |
| Print | Grid/list printing; Page designer extension for printable layouts; interface print ≤100 records [V] | **moderate** (print CSS is easy; page designer is not) |
| Full-base export | **Airtable has no native whole-base export** (only per-view CSV, snapshots that restore inside Airtable, and the Enterprise exports API) [K, consistent with docs] | **easy**, and it is OpenGrid's differentiator. Offer a one-click export of the base as a SQLite file or a ZIP (CSV/JSON plus attachments). |
| Duplicate base / table / view | With or without records and comments; interfaces are duplicated, synced tables have special handling [V] | **easy** |
| API bulk read/write | See section 7 | **easy** |

---

## 9. Interfaces, extensions, sync, AI

### 9.1 Interface Designer [V]

- **Layouts:** List, Gallery, Kanban, Calendar, Timeline (paid), Grid, Overview, Form, Dashboard (charts and numbers), Record review, Record detail, Roadmap (Business+), Gantt (as a timeline layout), Blank (legacy element canvas).
- **Elements and actions:** filter elements (tabs or dropdowns, one type per page); user-adjustable filters; buttons that open a page, URL or create-record form, or **run an automation**; conditional visibility on buttons (record detail) and **field visibility rules** (Business+); inline editing toggles; record creation and deletion toggles.
- **Builder filters:** includes "current user" filters for per-person pages. Builder filters are not removable by end users.
- **Publishing:** draft then **Publish**, and sharing is a separate step. Interface-only collaborators require paid plans. Base field permissions still apply inside interfaces.
- **Mobile:** mobile interfaces exist.
- **AI-generated interface elements** are in beta (Omni builds custom visualizations).
- **Limits:** 50 interfaces per base, 50 pages per interface, ≤200 search results, print ≤100 records.
- **Feasibility: hard overall, but scopable.**
  - A **Dashboard page** (number tiles plus a few chart types from aggregate queries) is **moderate**.
  - "**Record review / record detail**" pages with field-visibility rules are **moderate**.
  - A full drag-and-drop page builder is **hard**, and a candidate for v2.
  - The **permission model** of interface-only users is the real value for small businesses (client and contractor access without exposing the base), so build the access model early even if the page builder stays simple.

### 9.2 Extensions (paid; disabled on Free) [V]

- **First-party extensions:** Chart, Pivot table, Summary, Vega-Lite chart, Matrix, Map, 3D space, Org chart, Flowchart, Base schema, Color palette, Page designer (printable layouts), Web clipper (browser extension that clips pages into records using CSS selectors), Scripting extension (run JS against the base with UI input prompts), Batch update, CSV import, XML import, Calendar import, Contact import, Dedupe, Time-based (countdown/time tracker), Description, Embed, URL preview, Flashcard, Chime, Search, Record and others.
- **Partner and external extensions:** Typeform, Formstack Documents, Pexels, Miro, Loom, Jira Cloud, SendGrid, Send SMS (Twilio), Translate, Vision (Google Cloud Vision).
- **Custom extensions:** built with the Blocks SDK (React, Node CLI, `block:manage` scope); Extensions Marketplace; Builder Hub / app library.
- **Feasibility:**
  - A third-party JS plugin SDK running in the browser (sandboxed iframe plus postMessage API) is **moderate**, and it is low server memory because the code runs client-side.
  - The most valuable built-ins for small businesses are Chart/Pivot/Summary (merge into a dashboard view), Dedupe, CSV import with merge, Map (**ext** for tiles and geocoding; OpenStreetMap tiles can be self-hosted but are heavy), Page designer/print (**moderate**) and the Scripting console (**hard**, same JS sandbox issue as automations; it can run in-browser using the user's own permissions, which is safer and cheaper).
  - Web clipper is a browser extension, **moderate**, and probably cut.

### 9.3 Sync [V]

- **Airtable-to-Airtable sync:** sources must be grid views. One-way by default; **two-way** on Business+. Multi-source (Team+, up to 20 sources per table). Real-time between bases; integrations sync about every 5 min. Manual "Sync now" on Free; automatic sync is paid. Sync pauses on inactive bases.
- **Sync limits:**
  - Team: 10 synced tables per base, 10 sources per table.
  - Business: 20 synced tables, 20 sources per table, 50 sources per base.
  - All plans: 100 sync-enabled views per base, 400 source reads per minute, **10,000-record cap for integrated sources**.
- **Integration sources:**
  - Standard: Box, Google Drive, Google Calendar, Miro, Outlook Calendar, GitHub Issues, GitHub PRs.
  - Premium: Emailed data (CSV via email), Gong, Jira Cloud, Salesforce, **Sync API** (push CSV), Tableau Online, Zendesk.
  - Enterprise: Admin panel, Azure DevOps, Adobe Experience Manager, Databricks, Jira DC, Snowflake, Workday.
- **Feasibility:**
  - **Cross-base sync within one OpenGrid instance is moderate.** Implement it as a read-only projected table fed from the change log. Two-way sync is **hard** (conflict semantics).
  - External integrations are all **ext**. Offer a generic **"Sync from URL (CSV/JSON) on schedule"** and a **Sync API** push endpoint, which is **easy**, and skip vendor connectors.

### 9.4 AI [V]

- **Omni** (all plans, consumes AI credits) is a chat assistant in bases and interfaces. It can answer questions over data, search the web, analyze fields, and build tables, views, fields, field agents, interfaces (not Gantt or blank), automations and standalone forms. It can edit records, rename fields, extract from uploaded documents, and use web search. Admins can disable it for interface-only users.
- **Field agents** (paid) are AI long text, AI number/currency/percent, and AI-suggested linked records ("Deep Match"), plus "Generate formula". They include a catalog, can browse the web and analyze documents, and run manually or automatically.
- **Generate with AI** automation action, with model choice.
- **Airtable AI in Slack**, plus the **MCP server** for external assistants (Claude, ChatGPT, Cursor).
- **AI credits** [V], per month:
  - Free: 500 per editor.
  - Team: 15,000 per billable collaborator.
  - Business: 20,000 per paid user.
  - Enterprise Scale: 25,000.
  - AI has not been billed per seat since June 2025 [V, third-party press].
  - There is also an AI-credit plan conflict: the field agents doc says "all paid plans" while Omni says "all plans".
- **2026 context:** Airtable launched **Superagent** (a separate multi-agent research product) on 2026-01-27. It is not relevant to OpenGrid [V, press].
- **Feasibility: ext for everything** (LLM provider).
  - Recommended: a provider-agnostic "AI provider" setting (OpenAI-compatible endpoint, which covers OpenAI, Anthropic via compat, OpenRouter and local Ollama), with AI text fields and an "AI generate" automation action as opt-in.
  - **Shipping an MCP server is easy and high-value.** It is just a thin layer over the REST API, and it lets users bring their own AI assistant instead of OpenGrid building Omni.
  - Do not attempt Omni-style app building in v1.

---

## 10. Plan limits (current published, 2026-10)

| Limit | Free | Team | Business | Enterprise Scale |
|---|---|---|---|---|
| Price (annual billing) | $0 | $20/user/mo | $45/user/mo | Custom [V] |
| Records per base | **1,000** | **50,000** | **125,000** | 500k+ [third-party; C: some say 250k+]; HyperDB for millions |
| Attachment storage per base | 1 GB | 20 GB | 100 GB | 1,000 GB [V] |
| Max single attachment | 5 GB (all plans) [V] | | | |
| Editors | 5 Editors/Creators, 50 commenters, unlimited read-only | unlimited (billed) | unlimited (billed) | unlimited |
| Automation runs / month | 100 | 25,000 | 100,000 | 500,000 |
| Automations per base | 75 | 100 | 150 | 200 |
| API calls / month (workspace) | 1,000 | 100,000 | unlimited | unlimited |
| Revision & snapshot history | 2 weeks | 1 year | 1 year [plans page] / **2 years** [record-history & snapshot articles] [C] | 3 years |
| Run history (automations) | 2 weeks | 6 months | 1 year | 3 years |
| AI credits / user / month | 500 | 15,000 | 20,000 | 25,000 |
| Personal & locked views, record coloring, calendar ranges, timeline, Gantt, extensions, field/table permissions, record templates, password/domain share restrictions, interface-only sharing, form branding/redirect, dynamic linked filtering | no | yes | yes | yes |
| Two-way sync, conditional form groups, Roadmap interface, field visibility rules in interfaces, email-received trigger, fixed/none date-dependency modes, enterprise-domain share restriction, data library | no | no | yes | yes |
| Synced tables per base | manual only | 10 | 20 | 20 |
| Record templates per base | no | 100 | 500 | 2,000 |
| Structural limits (all plans) [V] | 1,500 bases per workspace; 1,000 tables + views per base; **500 fields per table**; 49 filter conditions per view; 3 group levels; 3 filter nesting levels; 50 interfaces per base; 10 webhooks per base | | | |
| Trash | Base items 7 days; bases/workspaces 30 days (Ent up to 180) [V] | | | |

When record or attachment limits are exceeded, the base stays usable and no data is deleted, but no new records or attachments can be added [V].

**Implications for OpenGrid sizing.**

- "Free tier parity" is only 1,000 records per base. Small-business reality is a **Team-plan workload: 5k–50k records per base, 20 GB attachments, 25k automation runs a month, 25 users.**
- That fits comfortably in SQLite on a 1 GB VPS *if* computed fields are materialized and grids are paginated or virtualized server-side.
- OpenGrid should have **no artificial limits**. It should document tested envelopes, for example "tested: 100k records/base and 500 fields/table on 1 vCPU/1 GB".

---

## 11. Out-of-scope / Enterprise-only (for completeness)

| Feature | Plan | Feasibility / note |
|---|---|---|
| SSO (SAML: Okta, Google, OneLogin, Entra ID, ADFS), IdP sync, SCIM | Business (SSO) / Enterprise | **moderate**. OIDC login via `openidconnect` is cheap and useful even for small businesses (Google/Microsoft login). Full SAML/SCIM is optional. |
| Two-factor authentication | All [V] | **easy**: TOTP plus WebAuthn. Ship in v1. |
| Admin panel, user groups, org units, Enterprise Hub, app library, managed apps | Business/Ent | **easy-moderate** (a single-instance admin page is simple) |
| Audit logs, change events API, eDiscovery, DLP, data retention policies, EKM, data residency, HIPAA | Ent | The change log gives audit logs for free (**easy**). The rest is not applicable to self-hosting. |
| HyperDB (very large external-backed tables: Databricks, Snowflake, Salesforce) | Ent | **hard/ext**. Cut. |
| App sandbox (dev/prod base copies, deploy changes) | Ent | **hard**. Cut (snapshots and duplicate cover most of it). |
| Custom domains per base (beta) | Ent | **easy** when self-hosted (it is the user's own domain), so it comes for free. |
| Portals (branded external sign-in) | Paid add-on | **moderate**. Interface-only guest users plus a branding setting. |
| Insights (base health/usage analytics) | — [V exists] | **easy**, low priority |
| Data sets / verified data / data library | Business+ | **moderate**. Cut. |
| Mobile apps (iOS/Android, barcode scan, push) | All | Native apps are out of scope. A **responsive PWA** is **moderate** and covers most of it. |
| Desktop apps (Mac/Windows) | All | Out of scope (the PWA covers it). |

---

## 12. Feasibility summary for planning

**Core and must-have (easy/moderate, and these define "Airtable-like"):**

- Grid, form, kanban, gallery and calendar views.
- All non-AI field types.
- The shared condition engine (filters, coloring, conditional lookups).
- Sort, group and the summary bar.
- Personal and locked views.
- Comments and mentions.
- Revision history, trash and snapshots.
- Roles plus field/table edit permissions.
- Share links with password.
- CSV/XLSX import and export, iCal feeds.
- The Airtable-compatible REST API with PATs and scopes, webhooks and an MCP server.
- Automations: native triggers plus create/update/delete/find/email/HTTP actions, conditional and repeating groups, a scheduler.

**Hardest pieces (budget the most time):**

1. **Formula engine** (parser, types, dependency graph, incremental recompute, Moment-style date formatting, time zones).
2. **Grid UI** at Airtable quality (virtualization, keyboard navigation, copy/paste, fill handle, live updates).
3. **Script sandbox** for "Run a script" (memory and CPU caps on a 512 MB box). Prefer a lightweight embedded language, or run scripts client-side for the extension use case.
4. **Interfaces/page builder** (scope down to dashboards plus record-detail pages plus the interface-only permission model).
5. **Timeline/Gantt** with dependencies and resource utilization.

**External-service-dependent (make them pluggable and optional, never required):**

- SMTP email (notifications, Send email).
- LLM provider (AI fields, Generate with AI).
- OAuth SaaS integrations (Google, Microsoft, Slack, Jira, Salesforce, GitHub, Twilio, etc.). Replace these with a generic HTTP request action plus incoming and outgoing webhooks.
- Inbound email trigger.
- Office-document previews.
- Map tiles and geocoding.

**Recommended cuts for v1:** two-way cross-base sync, vendor sync connectors, HyperDB, app sandbox, data library, Omni-style app builder, Web clipper, document automator (or a Typst-based version later), native mobile apps, the full drag-and-drop interface canvas.

---

## 13. Items I could not verify

These need an in-app check:

- The full per-field-type filter operator matrix (section 1.3 rows marked [K]), especially attachment operators and "this calendar month/week" options.
- The exact webhook notification ping body and MAC header name (`X-Airtable-Content-MAC` from memory).
- Number field formatting options (separators, abbreviation, allow-negative), checkbox/rating icon sets, and the percent progress bar.
- Presence and collaborator cursor indicators, and comment reactions.
- The frozen-field maximum (the Help Center says 3; prior knowledge suggests more).
- Business-plan revision history (1 year vs 2 years; Airtable's own pages conflict).
- Enterprise Scale records-per-base (500k per third parties; not on Airtable's page).
- Whether Free includes Omni and AI credits (the Omni doc says all plans; the field agents doc says paid plans).
- Batch size for create/delete: 10 records per request appears in the Help Center; the update endpoint page did not state it.

## Sources

**Primary**

- Airtable Help Center index: https://support.airtable.com/llms.txt. Individual articles were fetched on 2026-10-12, including filtering (9290731839), grid view (7905594155), record coloring (9047816169), grouping (7361540623), sorting (8716174546), summary bar (7344081006), calendar (1834189958), gallery (6624642620), kanban (9686375912), list (8391007562), Gantt (5823496393, 9146034701), timeline (1069623552, 7045093225, 2763536968), date dependencies (1295490370), form views (8588280258, 9431794285), prefill (8283289565), view share (4130354023), base share (7934312431), base permissions (5450095623), field/table permissions (2296468758), interface permissions (2193541120), portals (5415076460), comments (1999477400), revision history (3516802427), snapshots (2163132802), trash (4837035377), attachments (9139007724, 9671148410), import (9412806945), AI fields (8052242094), Omni (1744327578), MCP (9897799762), automations (3669392397 and trigger/action articles), API limits (7735693959), PATs (9934989703), service accounts (7043107100), sync (2849803278), record templates (9772992207), formula reference (7330071120), and the plans overview.
- Developer docs:
  - https://airtable.com/developers/web/api/rate-limits
  - https://airtable.com/developers/web/api/scopes
  - https://airtable.com/developers/web/api/field-model
  - https://airtable.com/developers/web/api/list-records
  - https://airtable.com/developers/web/api/update-multiple-records
  - https://airtable.com/developers/web/api/create-a-webhook
  - https://airtable.com/developers/web/api/model/webhooks-specification
  - https://airtable.com/developers/web/api/list-webhook-payloads
- Pricing: https://airtable.com/pricing

**Secondary**

- https://www.jetadmin.io/blog/airtable-pricing-in-2026-plans-real-costs-and-when-to-upgrade/
- https://www.softr.io/blog/airtable-pricing
- https://www.maginative.com/article/airtable-bets-big-on-ai-agents-with-omni-reboots-as-an-ai-native-app-platform/
- https://www.vktr.com/digital-workplace/airtable-debuts-superagent-a-multi-agent-ai-research-platform
