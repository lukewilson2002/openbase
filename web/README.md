# OpenGrid web client

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
| Tests | Vitest + Testing Library + jsdom; Playwright skeleton in `e2e/` |

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
npm run dev          # http://localhost:5173, proxies /api to a running opengrid on :8080
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

`npm run test:contract` runs the real API client (`src/api/endpoints.ts`) against a real `target/debug/opengrid`
started on a free port with a throwaway data directory (`contract/globalSetup.ts` builds it with `cargo build`).
Every response is checked against the generated bindings (`contract/typecheck.ts` reads `src/api/types/*.ts`), so
a server/client mismatch fails here rather than in a browser. Node has no cookie jar, so `contract/cookieJar.ts`
wraps `fetch` (tests only) and `setApiBase()` points the client at the server. Set
`OPENGRID_CONTRACT_SKIP_BUILD=1` to reuse already built binaries. Covered: setup, signup, login/logout, 2FA,
sessions, tokens, invites, admin users, audit paging, backups, and the error envelope. Workspaces, bases,
tables, views and records are added as their endpoints land. Invites need a workspace, which cannot be created
over the API yet, so `crates/server/examples/contract_seed.rs` inserts one; drop it once the workspace API exists.

### End-to-end tests

```sh
npx playwright install chromium     # once; npm ci does not download browsers
OPENGRID_E2E=1 OPENGRID_E2E_URL=http://127.0.0.1:8080 npm run e2e
```

## Layout

```
src/api/        client.ts (fetch wrapper), endpoints.ts (typed), events.ts (SSE), keys.ts, types/ (generated)
src/auth/       current-user hooks and route guards
src/base/       base shell: top bar, table tabs, view sidebar, permission rules
src/components/ design-system primitives (ui/) and shared dialogs
src/pages/      setup, login, signup, invite, password reset, home, account/, admin/
src/theme/      light/dark theme provider (the pre-paint script is public/theme-init.js)
src/views/      ViewHost + registry.ts: the extension point where grid/kanban/... plug in
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
| `src/lib/cells/` | Pure helpers: display formatting, text parsing (mirrors `og_core::cell::parse_text`), filter operator tables, aggregation availability, view/wire value conversion |
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
- **Calendar** runs FullCalendar in its `UTC` mode on wall times, queries only the visible range (padded one day each side) and the viewer's zone, and builds the unscheduled list from a whole-view query with a `transient` filter override (the saved filter plus "start date is empty", `unscheduledTransient` in `eventMath.ts`). FullCalendar's prev/next buttons are text because its icon font is a `data:` URI that the server's CSP blocks.
- **Timeline** (`geometry.ts`, `lanes.ts` are pure; `TimelineChart.tsx` is the DOM): scales day to year, a window that grows as you scroll near an edge, swimlanes, milestones, create by dragging, whole-day drag and resize, and dependency arrows (red when the predecessor ends after the successor starts; a date-only end counts through the end of its day).
- **List** turns `QueryResponse.groups` into a collapsible outline (`outline.ts`).

Date writes honour the field: a date-only field stores `YYYY-MM-DD`, a field with time stores the UTC instant of the wall time in the field's zone (DST gaps and overlaps resolve like the server's `store_date`). Computed date fields (created/modified time, formulas) can be shown but not dragged.

`dev/mock-api.ts` also serves a "Projects" table (tbl3, 40 records with dates, owners, cover images and dependencies) with one configured view of each type, plus notifications and trash fixtures; open `/base/app1/tbl3/viw11` (Board), `viw13` (Gallery), `viw14` (Calendar), `viw16` (Timeline), `viw17` (Outline).

### Trash and notifications

`components/trash`: `TrashButton` in the base top bar (creators and owners) opens `TrashDialog` (tables, fields, views, records with relative deletion time and Restore; retention note: 30 days by default). `components/notifications`: `NotificationBell` replaces the disabled bell; unread count polled every 60 s and refetched on window focus, `describeNotification` turns payloads (mention: `author_name`, `snippet`, `record_name` and the location keys; assigned: `field_name`, `assigned_by` (a user id, so no name is shown); automation: `message`, `automation_name`; all optional) into text and a link (a record is linked only when the payload names its table), which `BaseShell` keeps intact when it canonicalises the URL.

### Conventions

- Every request goes through `src/api/client.ts` (CSRF header, client id, error mapping, 401 handling).
- Query keys live in `src/api/keys.ts`. Anything showing records of a table must key under `["records", tableId, ...]`
  so live `records_changed` events refresh it.
- The server sends `script-src 'self'`: never add inline scripts to `index.html` (the theme bootstrap is a file).
- UI permission checks (`src/base/permissions.ts`, `src/lib/roles.ts`) only hide or disable controls; the server enforces.
