# OpenBase web client

React 19 + TypeScript (strict) single-page app, built with Vite and embedded into the Rust server binary
(`crates/server/src/web.rs` embeds `web/dist`). Self-hosters never need Node; only contributors do.

## Stack

| Concern | Choice |
|---|---|
| Build / dev server | Vite 8 (`/api` proxied to `http://127.0.0.1:8080`) |
| UI | React 19, Tailwind CSS v4 (tokens in `src/styles/index.css`), Radix UI primitives (`radix-ui`), lucide-react icons |
| Components | `src/components/ui/*`, written in the shadcn/ui style (copied into the repo, no CLI) |
| Server state | TanStack Query v5 (SSE events invalidate queries) |
| Routing | React Router v8, library mode |
| Contract | TypeScript types generated from the Rust DTOs by ts-rs into `src/api/types` |
| Tests | Vitest + Testing Library + jsdom; live contract tests against the real server (`contract/`); Playwright end-to-end tests in Chrome (`e2e/`) |

Icons for workspaces, bases and tables (`src/components/icons/`): the 20 popular Lucide icons are bundled
(`popular.ts`) and draw instantly; the full set (~1,900 icons, a ~190 kB gzipped chunk) is a dynamic `import()`
(`registry.ts` -> `fullSet.ts`) that loads only when an icon picker opens or an icon outside the popular 20 has to be
drawn, and is then cached. `<EntityIcon>` / `<EntityTile>` / `<EntityLabel>` draw an icon by name with the first
letter as the fallback, `<IconPicker>` is the popover (search by name and alias, windowed list, keyboard grid, "Remove
icon"), and `ui/entity-select.tsx` is the select used where a table is chosen by name (native `<option>`s cannot draw
icons). `fullSet.ts` globs `lucide-react/dist/esm/icons/*.mjs` and reads Lucide's `__iconData` export; `icons.test.ts`
fails if a Lucide upgrade removes it or renames one of the popular 20.

`@modelcontextprotocol/sdk` (exact version, dev dependency, about 90 packages in the lockfile) is used only by
`contract/oauth.contract.test.ts`, to run the official MCP OAuth client against the server; nothing of it is bundled.

Passkeys use the browser's WebAuthn API directly (`src/lib/webauthn.ts`, about 100 lines: base64url conversion of the
server's JSON options and answers, support detection, error classification, a default passkey name). No library: the
convenience of `@simplewebauthn/browser` is exactly these conversions plus polyfills for browsers older than
`parseCreationOptionsFromJSON` / `toJSON()`, which would add a runtime dependency to every page load for code that is
short and fully unit-tested here.

Dependencies are deliberately few (9 runtime for the shell): react, react-dom, react-router, @tanstack/react-query, radix-ui,
lucide-react, clsx, tailwind-merge, qrcode (the QR encoder is lazy-loaded for the 2FA dialog).
The grid adds @glideapps/glide-data-grid (with its peers lodash, marked 4 and react-responsive-carousel) and dompurify,
all loaded only with the lazy grid chunk. The other views add @dnd-kit/core, @dnd-kit/sortable and @dnd-kit/utilities
(kanban) and FullCalendar 6.1.21, standard MIT packages only: core, react, daygrid, timegrid, list and interaction
(calendar). Each is imported only by its lazy view chunk; the timeline is custom DOM + SVG with no dependency.

## Commands

Install with the lockfile and without lifecycle scripts (enforced by `.npmrc`):

```sh
cd web
npm ci
npm run dev          # http://localhost:5173, proxies /api to a running openbase on :8080
npm run build        # type-check + production build into web/dist
npm test -- --run    # unit and component tests (fetch is mocked)
npm run test:contract  # the API client against the real server (needs cargo; see below)
npx tsc --noEmit     # type-check only
```

Then `cargo build` embeds `web/dist` into the server (a plain `cargo build` without `web/dist` still works:
the server serves the API and a "web client not built" hint). Release builds embed at compile time, so rebuild the
server after rebuilding the web client.

### Regenerating API types

After changing a Rust DTO in `crates/core`:

```sh
scripts/gen-types.sh          # writes web/src/api/types/*.ts
scripts/gen-types.sh --check  # CI and scripts/check.sh: fails if the files on disk are stale
```

`src/api/types/overrides.ts` is hand-maintained (ts-rs cannot express a flattened optional enum, so `UpdateField`
is composed there). `Option<T>` fields come out as `field?: T | null`. A request DTO field that is not an
`Option` but has `#[serde(default)]` is marked `ts(as = "Option<T>", optional)` in Rust so it is optional here
too (see the conventions in `crates/core/src/api/mod.rs`); response fields stay required.

### Live contract tests

`npm run test:contract` runs the real API client (`src/api/endpoints.ts`, `src/api/records.ts`,
`src/api/events.ts`) against a real `target/debug/openbase` started on a free port with a throwaway
data directory (`contract/globalSetup.ts` builds it with `cargo build --features debug-embed`, the same
binary the end-to-end tests use). Every response is checked against the generated bindings
(`contract/typecheck.ts` reads `src/api/types/*.ts`), so a server/client mismatch fails here rather than
in a browser. Node has no cookie jar, so `contract/cookieJar.ts` wraps `fetch` (tests only), and
`contract/support.ts` gives each test file its own workspace and users (`Profile`, `createWorld`).

Two servers run: a fresh one for the first-run flow (`flow.contract.test.ts`: setup, login, 2FA, sessions,
tokens, invites, admin, audit, backups, `errors.contract.test.ts`: the error envelope) and a second one whose
administrator already exists for the data plane:

| File | Covers |
|---|---|
| `workspaces.contract.test.ts` | workspaces (create, rename, members, delete + restore), bases (schema, rename, duplicate, collaborators, members), tables |
| `fields.contract.test.ts` | every type the field dialog can create with its defaults, link pairs, formulas and the live check, lookup / rollup / count, type changes, delete + restore |
| `views.contract.test.ts` | every view type, config replacement, personal and locked views, duplicate, delete |
| `records.contract.test.ts` | create / update / delete / restore / move, typecast, links from both sides, `before_record_id`, view query (filter, sort, group, search, range, paging, colors, `transient`), aggregations, link lookup, history |
| `collab.contract.test.ts` | comments, mentions and notifications, trash, automations (CRUD, dry-run test, webhook runs, run history) |
| `sharing.contract.test.ts` | share links (create, disable, password, delete, limits, who may), public views and forms without credentials (visible fields only, search / paging / transient / range, passwords, uploads, submissions, rate limit), attachments through `?share=`, CSV export and both CSV imports |
| `automations.contract.test.ts` | what the automations UI relies on: every trigger and action type as the editor sends it, the `action N: ...` error wording, on/off rules, `next_run_at`, real test runs in the history, roles |
| `email.contract.test.ts` | Administration -> Email: the effective settings and their sources, saving (never a host: the shared server keeps email off), the write-only password, validation errors, the test-email answer, closed to regular users |
| `mcp.contract.test.ts` | the MCP endpoint: handshake, the tools a token sees, a base built through tools and read back through REST, icons set / kept / cleared and read back, the email tools |
| `oauth.contract.test.ts` | OAuth for the MCP endpoint, driven by the official `@modelcontextprotocol/sdk` client (`OAuthClientProvider`): discovery from the 401, dynamic registration, PKCE, code exchange, tools, automatic refresh with rotation, revocation from the connected-apps list, `insufficient_scope`, OAuth tokens refused on the REST API; the consent and grant responses are checked against the generated bindings |
| (in `flow.contract.test.ts`) | passkeys as far as a server on an IP address goes: `passkeys_enabled: false`, the "needs a domain name" answer, the empty list, session-only for tokens, the administrator's removal. The ceremonies need a domain name and a browser: they are covered by the server tests (`crates/server/tests/passkeys.rs`) and the `passkeys` end-to-end project |
| `events.contract.test.ts` | the SSE stream read by the real `connectBaseEvents` while a second client writes (writer's client id, echo skipping, access changes) |

`OPENBASE_CONTRACT_SKIP_BUILD=1` reuses already built binaries.

### End-to-end tests

Playwright drives the real stack in the locally installed Google Chrome (no browser download):

```sh
OPENBASE_E2E=1 npm run e2e
```

`e2e/globalSetup.ts` builds the web client, builds the server with `web/dist` embedded at compile time
(`--features debug-embed`), starts it on a temporary data directory and a free port, and checks that it serves
the app with `web/dist` moved away. The projects share that one instance and run in a chain
(`playwright.config.ts`; `workers: 1`, so one at a time):

| Project | Spec | Depends on | Covers |
|---|---|---|---|
| `smoke` | `smoke.spec.ts` | | the embedded build loads `/` without console errors or CSP violations |
| `journey` | `journey.spec.ts` | smoke | first-run setup (creates the administrator, so it must run first), workspace and base, rename a table, add number / single select / date / formula fields through the dialog, add records and edit cells, filter and sort, expanded record and a comment, log out and in |
| `grid` | `grid.spec.ts` | journey | cell editing, undo, filters, search, hiding fields, the field dialog, expanded record, add / delete records, and the row-marker column (numbers, none on the summary row, numbered records in a grouped view) |
| `sharing` | `sharing.spec.ts` | grid | build, share and anonymously submit a form in a fresh cookie-less browser context, a password-protected grid share that hides a field, CSV download and import, a viewer sorting a board |
| `oauth` | `oauth.spec.ts` | grid | an MCP OAuth client in Chrome: registers with a loopback redirect served by the test, the authorization URL sends the browser to the login and back to the consent page, "Read & edit" is approved, the code arrives at the loopback listener and is exchanged with PKCE, `tools/list` and a write tool work, a manage tool is refused with 403, then the app is revoked from Account -> AI assistants -> Connected apps and its tokens stop working; a second test denies an app named "Claude" on another host |
| `assistants` | `assistants.spec.ts` | grid | Account -> AI assistants: the MCP address is the server's public URL and answers `401` with the sign-in metadata, Claude is open by default and the sections are an accordion (mouse and keyboard), the copy buttons write the real clipboard, the token variants are collapsed until opened, the plain-http server shows the public-address warning, and the tab fits 375 px in the light and dark themes |
| `passkeys` | `passkeys.spec.ts` | grid | Chrome's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`: CTAP2, internal transport, resident keys, user verification): add a passkey in Account -> Security, sign out, sign in with it and no password (the background request for the email field's autofill list stays pending until the button replaces it), rename and remove it, the removed passkey's leftover credential refused; a TOTP-enabled user signing in by passkey skips the code while the password still asks for it; the autofill request completing the sign-in; an administrator removing another user's passkeys |
| `admin-email` | `adminEmail.spec.ts` | sharing, automations, views, oauth, assistants, passkeys | Administration -> Email: the tab, saving an SMTP server (no restart), the password shown only as "Saved", the real connection error from "Send test email", and turning email off again (runs last because the setting is instance-wide) |
| `automations` | `automations.spec.ts` | grid | builds "record created in Table 1 -> create a record in Table 2 with Name = {{trigger.record.fields.Name}}" in the editor, turns it on, adds a record in the grid, checks through the API and the Runs tab that it ran, then runs it for real from the Test panel |
| `views` | `views.spec.ts` | grid | kanban (pointer and keyboard drag), gallery, list, calendar (events, create by click, drag from "Unscheduled"), timeline (bars, dependency arrows, keyboard move, scale, create by drag), the trash, and the notification bell |

`sharing`, `automations` and `views` each sign up their own user (the server started by globalSetup allows
signup) and seed their own workspace, so they only need the instance to be set up and do not depend on each
other's data; they all hang off `grid` only to keep the order fixed on the shared server (a new spec is a
new line in `playwright.config.ts`, or it never runs). Every test
fails on a console error, an uncaught exception, a CSP violation or a failed request (`e2e/fixtures.ts`).
The grid is a canvas, so cells are operated by position with real mouse and keyboard input and results
are asserted against the API. The server's public URL is `http://localhost:<port>` (not `127.0.0.1`): WebAuthn needs a domain name as the relying party, and `localhost` is the one browsers treat as a secure context over plain http. `OPENBASE_E2E_URL=...` uses a running server, `OPENBASE_E2E_SKIP_BUILD=1`
reuses the existing builds, and `scripts/check.sh` runs all of this when `OPENBASE_E2E=1` is set.

The suite must not depend on how fast the machine is (it passes on a laptop and has to pass on a busy CI runner):

- **Client addresses.** The server limits sign-ins (10 a minute) and sign-ups (10 an hour) per client address, and
  every test would otherwise come from `127.0.0.1` and share one bucket. globalSetup starts the server (loopback
  only) with `OPENBASE_TRUST_PROXY=true`, and every test, and every browser context a test or a `beforeAll` makes
  with `newClientContext()`, sends its own `X-Forwarded-For` derived from the project, the test and the retry, as
  the contract tests do (`contract/cookieJar.ts`). The real limits are unchanged. A spec that makes a context with
  plain `browser.newContext()` shares the bucket again: use `newClientContext()` (`e2e/fixtures.ts`).
- **Waits are bounded and say what they waited for.** The grid helpers (`clickGrid`, `gridFocused`, `editorFocused`)
  time out after 5 s with the focused element and the selected cell in the message, and `clickGrid` waits out
  Glide's double-click window instead of guessing (see its comment) and retries a click that left an editor open.
- **No race with the browser's virtual authenticator.** It decides about user presence when a request reaches it, so
  `passkeys.spec.ts` holds the page's challenge request until the authenticator is ready (`signInWithButton`).
- **Slow-machine run.** `OPENBASE_E2E_CPU_THROTTLE=4 OPENBASE_E2E=1 npm run e2e` runs every page with Chrome's CPU
  throttling (try 6 for a harsher one); a test that only passes on a fast machine fails there.
- **Retries.** CI retries a failed test once (locally there are none). A test that only passes on its retry is
  *flaky*: the e2e job lists it in the job summary and as a warning, and the release workflow fails on it
  (`OPENBASE_E2E_FAIL_ON_FLAKY=1`, which `ci.yml` passes on when `release.yml` calls it with `fail_on_flaky`).

## Layout

```
src/api/        client.ts (fetch wrapper), endpoints.ts (typed), events.ts (SSE), keys.ts, types/ (generated)
src/auth/       current-user hooks and route guards
src/base/       base shell: top bar, table tabs, view sidebar, permission rules
src/components/ design-system primitives (ui/) and shared dialogs
src/lib/webauthn.ts  the WebAuthn browser API <-> the server's JSON (base64url conversion, support checks, errors); `src/auth/usePasskeyLogin.ts` is the login page's passkey button and background autofill request
src/pages/      setup, login, signup, invite, password reset, home, account/ (SecuritySection: password, PasskeysSection, two-factor), admin/, oauth/ (the consent page an app's "connect" request lands on, `/oauth/consent?request=<id>`; account/AssistantsSection (the AI assistants tab: one section per assistant, with account/ConnectedAppsSection below it) and admin/ConnectedAppsTab list and revoke connected apps)
src/theme/      light/dark theme provider (the pre-paint script is public/theme-init.js)
src/views/      ViewHost + registry.ts: the extension point where grid/kanban/... plug in
src/automations/ the automations page (list, editor, test panel, run history); its own lazy chunk
```

### Plugging in a view

Implement a component taking `ViewProps` (`schema`, `table`, `view`, `role`) and point the matching line of
`src/views/registry.ts` at it (use `React.lazy` to keep the shell bundle small).

### The grid view (`src/views/grid`)

The grid is [Glide Data Grid](https://github.com/glideapps/glide-data-grid) (canvas) pinned at exactly 6.0.3. Glide declares a
React <= 18 peer range, so `package.json` has an `overrides` entry that points it at the app's React 19. It is wrapped behind
`GridAdapter` (`views/grid/adapter.ts`); only `views/grid/glide/*` imports it, so it can be vendored or replaced by a DOM grid
on `@tanstack/react-virtual`. The grid chunk is lazy-loaded from `views/registry.ts`.

| Where | What |
|---|---|
| `src/lib/cells/` | Pure helpers: display formatting, text parsing (mirrors `ob_core::cell::parse_text`), filter operator tables, aggregation availability, view/wire value conversion |
| `src/views/grid/` | `GridView`, paged data (`useGridData`), mutations and undo (`useRecordOps`, `undo.ts`), paste/fill/clear planning (`gridOps.ts`), group rows (`rowMap.ts`), view config (`useViewConfig`) |
| `src/components/record/` | Cell editors shared by the grid overlay and the expanded record, the expanded record, comments, history |
| `src/components/fields/` | Field create/edit dialog with options for all 28 types |
| `src/components/viewbar/` | Toolbar, filter builder, pure `ViewConfig` mutations (`config.ts`) |
| `src/api/records.ts` | Typed records, comments, attachments and field/view endpoints |

To work on the grid without a server run `VITE_MOCK=1 npm run dev`: `dev/mock-api.ts` is a Vite middleware that serves a
3,000-record fixture base with every field type (it is never part of a production build). `/api/__mock/role/viewer` switches the
caller's role and `POST /api/__mock/external-edit` simulates another client's write (live refresh).

### The other views (`src/views/{kanban,gallery,calendar,timeline,list}`)

All five get `{schema, table, view, role}`, are lazy chunks registered in `views/registry.ts`, and share `views/common/`:

| Where | What |
|---|---|
| `common/useViewSetup.ts` | Current user and time zone, collaborators, format/editor environment, the saved view config (`grid/useViewConfig`), search, record writes and the `?record=` parameter |
| `common/useViewRecords.ts` | Whole-view query: pages of 1,000 up to a 5,000 cap (`truncated` drives the "showing first N" notice), cached under `["records", tableId, viewId, "query", ...]` so SSE invalidation refetches it |
| `common/useRecordWrites.ts`, `cache.ts` | Optimistic edits, manual-order moves and creates over every cached whole-view query of the table, rolled back when the server rejects them |
| `common/ViewFrame.tsx` | The shared toolbar (`components/viewbar`, with `features`/`extra` props to drop grid-only controls and add view settings) plus `ExpandedRecord` for `?record=` |
| `common/wallTime.ts` | Calendar/timeline time model: date cells are read as *wall time* (the wall-clock reading as UTC ms) in the field's zone, else the viewer's, so a day is always 86,400,000 ms and drags map back to stored values through `zonedToInstant` |

- **Kanban** stacks by single select, single user or checkbox (`stacks.ts` is pure: bucketing, `stack_order`, drop planning). dnd-kit with pointer and keyboard sensors (Space picks up, arrows move, Space drops, Enter opens). A drop writes the stack field with `typecast` and, only when the view has no sorts, a manual-order move; both are optimistic with rollback.
- **Gallery** pages the view query by offset (60 per page, IntersectionObserver plus a "Load more" button).
- **Calendar** runs FullCalendar in its `UTC` mode on wall times, queries only the visible range (padded one day each side) and the viewer's zone, and builds the unscheduled list from a whole-view query with a `transient` filter override (the saved filter plus "start date is empty", `unscheduledTransient` in `eventMath.ts`). FullCalendar's prev/next buttons are text because its icon font is a `data:` URI that the server's CSP blocks. `calendar/iconFont.ts` also deletes the font's `@font-face` rule from FullCalendar's injected stylesheet, so opening a calendar does not log a CSP violation.
- **Timeline** (`geometry.ts`, `lanes.ts` are pure; `TimelineChart.tsx` is the DOM): scales day to year, a window that grows as you scroll near an edge, swimlanes, milestones, create by dragging, whole-day drag and resize, and dependency arrows (red when the predecessor ends after the successor starts; a date-only end counts through the end of its day).
- **List** turns `QueryResponse.groups` into a collapsible outline (`outline.ts`).

Date writes honour the field: a date-only field stores `YYYY-MM-DD`, a field with time stores the UTC instant of the wall time in the field's zone (DST gaps and overlaps resolve like the server's `store_date`). Computed date fields (created/modified time, formulas) can be shown but not dragged.

`dev/mock-api.ts` also serves a "Projects" table (tbl3, 40 records with dates, owners, cover images and dependencies) with one configured view of each type, plus notifications and trash fixtures; open `/base/app1/tbl3/viw11` (Board), `viw13` (Gallery), `viw14` (Calendar), `viw16` (Timeline), `viw17` (Outline).

### Forms, sharing, public pages and CSV

| Where | What |
|---|---|
| `src/api/sharing.ts` | `sharesApi` (manage links), `publicApi` (public form / shared view / attachments), `csvApi` (export, import into a table, new table); `ImportFailedError` carries the problem rows of a refused import |
| `src/lib/forms/` | Pure logic: `formConfig.ts` (builder edits, what a form may hold, which fields the public form leaves out), `publicValues.ts` (what a visitor typed -> `values`, with validation), `drafts.ts` (the same for the internal fill-in mode) |
| `src/lib/csv/` | The CSV preview parser (BOM, delimiter detection, quotes), `mapping.ts` (the column names the server derives, auto matching, payload) and `read.ts` (size / encoding checks) |
| `src/views/form/` | The form view: `FormBuilder` (settings, `FormFieldList` with dnd-kit reorder, live preview through `FormSurface` with the record editors in their `form` variant) and `FormFill` (signed-in editors create a record through the normal records API) |
| `src/components/share/ShareViewDialog.tsx` | "Share view" / "Share form" for creators: links, enable / disable, password, delete, and what is public |
| `src/components/csv/` | Download CSV button, Import CSV (preview + column mapping + row errors), New table from CSV |
| `src/public/` | Public pages, outside the app shell: `/form/:token`, `/share/:token` (and `/f/:token`, `/s/:token`, the paths the API reports) |

- **Public pages** never call a signed-in endpoint and never redirect to `/login`: public requests pass `skipAuthRedirect`, and
  `/share/`, `/s/`, `/form/`, `/f/` are public routes for the client. A password is kept in memory only (a reload asks again) and sent as
  `X-Share-Password`; it is never in the URL, storage or a query key.
- **Public form**: native inputs per field type (`PublicFieldInput`), validated with the shared cell parsers before sending; files go to
  `POST /api/public/forms/{token}/attachments`; after submitting: the success message, "submit another" and the redirect (http/https only).
  Link and user fields are never collected by public forms (server policy); the builder marks them "Not public", and a preview switch shows
  only what visitors get.
- **Shared views** are read-only. The signed-in views are wired to the signed-in API, so the public page reuses only what is presentational
  or pure (cell display, card helpers, kanban stacking, the timeline chart, calendar date math) with simple layouts around it: grid and list
  are a clean read-only table (group header rows, click a header to sort, paging, search), gallery cards with covers, kanban read-only
  stacks, calendar a month grid (one query per month), timeline the real chart with every editing gesture off. A board, calendar or
  timeline whose configured field is hidden in the share falls back to the table and says so. Card titles use the first visible field (the
  public view does not say which field is primary).
- **Attachments of a shared view** are authorised by `?share=<token>`; an `<img>` cannot send `X-Share-Password`, so for protected links the
  page fetches the bytes with the header and shows a blob URL (CSP allows `blob:`); open links use plain URLs.
- **CSV**: export is `GET /api/views/{id}/export.csv?timezone=` saved from a blob under the server's file name; import maps columns by the
  names the server derives (trimmed, `Column N` when empty, `name 2` when repeated, or column numbers without a header row), is all or
  nothing, and lists up to 50 refused rows. Link, user, attachment and computed fields cannot receive imported data.

### Trash and notifications

`components/trash`: `TrashButton` in the base top bar (creators and owners) opens `TrashDialog` (tables, fields, views, records with relative deletion time and Restore; retention note: 30 days by default). A deleted *workspace* has no trash of its own to open (`GET /api/workspaces/{id}/trash` answers 404 once it is deleted), so the home page lists the caller's own deleted workspaces in "Recently deleted workspaces" (`DeletedWorkspaces`, from `GET /api/trash/workspaces`, owners only) with a Restore button; the section is absent when there are none. `components/notifications`: `NotificationBell` replaces the disabled bell; unread count polled every 60 s and refetched on window focus, `describeNotification` turns payloads (mention: `author_name`, `snippet`, `record_name` and the location keys; assigned: `field_name`, `assigned_by` (a user id, so no name is shown); automation: `message`, `automation_name`; all optional) into text and a link (a record is linked only when the payload names its table), which `BaseShell` keeps intact when it canonicalises the URL.

### Automations (`src/automations`)

`/base/:baseId/automations/:automationId?/:tab?` renders inside the base shell (`BaseShell section="automations"`, lazy chunk), reached
from the "Automations" button in the top bar. Creators and owners only (`basePermissions.manageAutomations`): the server lets editors
read run history, but listing automations needs a creator, so editors have no way to learn an automation's id.

| Where | What |
|---|---|
| `model.ts` | Pure: the editor's draft (the DTOs plus a stable key per action), `toCreate` / `toUpdate`, `isDirty` (key-order-insensitive), defaults for new triggers and actions, summaries, `parseSaveError` (the server prefixes action errors with `action N: `, which the editor puts on that action's card) |
| `cron.ts` | Schedule presets (every 5-30 minutes, hourly, daily, weekly, monthly) <-> 5-field cron; anything else stays "custom" and is sent untouched |
| `templates.ts` | The tokens the "Insert data" menu offers (trigger, trigger record fields, webhook body path, earlier steps' outputs) and insertion at the caret |
| `runs.ts` | Durations, trigger labels and step titles for the run history |
| `AutomationsPage`, `AutomationList`, `CreateAutomationDialog` | List with name, trigger summary, on/off switch and last run (one `limit=1` runs request per row: the list DTO has no last-run field); create, rename, delete |
| `AutomationEditor` | The draft, Save (sends `{name, trigger, actions}`), on/off (saved on its own), Discard; trigger, actions, test and the Runs tab |
| `TriggerEditor`, `ScheduleEditor`, `WebhookPanel` | One editor per trigger type; the webhook token is shown once (create / rotate / switching an automation to a webhook) and kept in page state only |
| `ActionList`, `ActionEditors`, `ValuesEditor`, `TemplateInput` | Ordered actions (max 25, reorder, remove), one editor per action type, per-action conditions with the view `FilterBuilder`, record values as typed `FieldEditor variant="form"` editors or text templates |
| `TestPanel`, `RunsTab`, `StepLogView` | Dry run by default, "run for real" behind a confirmation; paged run history (polled every 5 s while open) with expandable step logs |

Not in the UI because the server has no endpoint for it: duplicating an automation, previewing the next few run times of a schedule
(the saved automation's `next_run_at` is shown instead), re-showing a webhook token.

### Bundle

The app shell (`index-*.js` plus the chunks it needs on every page, see `vite build` output) is kept small by loading
what most visits never use on demand: the grid, the other views, automations, account, admin, the public pages, and the
dialogs behind a button (`ShareViewDialog`, `ImportCsvDialog`, `NewTableFromCsvDialog`, `TrashDialog`, `SharingDialog`) through
`React.lazy` wrappers (`Lazy*.tsx`, `TrashButton.tsx`) that render nothing while the chunk loads, plus the one-off account pages (setup,
sign-up, invite, password reset). Components that decide *whether* to show such a dialog import its small pure helpers instead
(`components/share/shareView.ts`). Measured on 2026-10-13 after `vite build` (gzip level 9 of the files `index.html` loads: entry, shared chunks
and CSS; Vite's own report uses a lower level and differs by about 1%): entry chunk 121,137 -> 110,073 bytes, whole initial load 186,200 -> 174,544 bytes. React DOM, the router and TanStack Query are
most of what is left.

### Grid marker column

Glide draws the marker column (a number that turns into a checkbox on hover) from the display row. `views/grid/glide/marker.ts` wraps
Glide's marker renderer once so the grid view decides the number instead (`GridAdapterProps.rowNumber`): a record shows its position in the
view (grouped views count records, not headers), group headers and the pinned summary row show nothing, not even the hover checkbox.
It depends on Glide 6.0.3 internals (`markerCellRenderer.draw`, `rowMarkers.startIndex` = 1); see the notes in the file.

### Themes

Colours are tokens in `src/styles/index.css` for both themes; the grid canvas mirrors them in `views/grid/glide/theme.ts`, the choice palette in
`lib/cells/palette.ts`. `src/styles/contrast.test.ts` keeps text on its usual surfaces at WCAG AA (4.5:1) in both themes. Marks (the dot of a
stack or lane, the bar of a coloured row) use `swatchColor`, because the pale chip backgrounds are about 1.3:1 on a white surface.

### Logo, favicon and web app manifest

`brand/` holds the logo artwork (see `brand/README.md`); `scripts/gen-brand.sh` turns it into what the client ships and
`scripts/check.sh` fails when the copies are stale (`--check`):

- `public/favicon.svg` (the small mark), `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` and
  `icon-maskable-512.png`, linked from `index.html`. `public/manifest.webmanifest` (name OpenBase, theme `#1F5AE0`, the three icons) is
  handwritten. There are no inline scripts or styles in `index.html`: the server's CSP forbids them.
- `src/components/brandMarks.ts` (generated): the path data that `components/Logo.tsx` draws inline. `Logo` is the lockup (mark plus
  outlined wordmark, in the text colour, so it follows the theme) or, with `showName={false}`, the small mark; `BrandMark` is the bare
  mark. They sit in the app top bars, the sign-in, setup, invite and reset pages and, as "Powered by OpenBase", the footer of public
  form and share pages. The server serves these files with `Cache-Control: public, max-age=86400` and an ETag (the manifest and
  `index.html` are `no-cache`), see `crates/server/src/web.rs`.

### Conventions

- Every request goes through `src/api/client.ts` (CSRF header, client id, error mapping, 401 handling).
- Query keys live in `src/api/keys.ts`. Anything showing records of a table must key under `["records", tableId, ...]`
  so live `records_changed` events refresh it.
- The server sends `script-src 'self'`: never add inline scripts to `index.html` (the theme bootstrap is a file).
- UI permission checks (`src/base/permissions.ts`, `src/lib/roles.ts`) only hide or disable controls; the server enforces.
