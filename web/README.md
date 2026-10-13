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
| Tests | Vitest + Testing Library + jsdom; live contract tests against the real server (`contract/`); Playwright end-to-end tests in Chrome (`e2e/`) |

Dependencies are deliberately few (9 runtime): react, react-dom, react-router, @tanstack/react-query, radix-ui,
lucide-react, clsx, tailwind-merge, qrcode (the QR encoder is lazy-loaded for the 2FA dialog).
The grid adds @glideapps/glide-data-grid (with its peers lodash, marked 4 and react-responsive-carousel) and dompurify,
all loaded only with the lazy grid chunk.

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

`npm run test:contract` runs the real API client (`src/api/endpoints.ts`, `src/api/records.ts`,
`src/api/events.ts`) against a real `target/debug/opengrid` started on a free port with a throwaway
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
| `events.contract.test.ts` | the SSE stream read by the real `connectBaseEvents` while a second client writes (writer's client id, echo skipping, access changes) |

`OPENGRID_CONTRACT_SKIP_BUILD=1` reuses already built binaries.

### End-to-end tests

Playwright drives the real stack in the locally installed Google Chrome (no browser download):

```sh
OPENGRID_E2E=1 npm run e2e
```

`e2e/globalSetup.ts` builds the web client, builds the server with `web/dist` embedded at compile time
(`--features debug-embed`), starts it on a temporary data directory and a free port, and checks that it serves
the app with `web/dist` moved away. The projects run in order on that one instance: `smoke` (the embedded
build loads `/` without console errors or CSP violations), `journey` (first-run setup, workspace and base, rename a
table, add number / single select / date / formula fields through the dialog, add records and edit cells,
filter and sort, expanded record and a comment, log out and in) and `grid` (`grid.spec.ts`: cell editing,
undo, filters, search, hiding fields, the field dialog, expanded record, add / delete records). Every test
fails on a console error, an uncaught exception, a CSP violation or a failed request (`e2e/fixtures.ts`).
The grid is a canvas, so cells are operated by position with real mouse and keyboard input and results
are asserted against the API. `OPENGRID_E2E_URL=...` uses a running server, `OPENGRID_E2E_SKIP_BUILD=1`
reuses the existing builds, and `scripts/check.sh` runs all of this when `OPENGRID_E2E=1` is set.

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

### Conventions

- Every request goes through `src/api/client.ts` (CSRF header, client id, error mapping, 401 handling).
- Query keys live in `src/api/keys.ts`. Anything showing records of a table must key under `["records", tableId, ...]`
  so live `records_changed` events refresh it.
- The server sends `script-src 'self'`: never add inline scripts to `index.html` (the theme bootstrap is a file).
- UI permission checks (`src/base/permissions.ts`, `src/lib/roles.ts`) only hide or disable controls; the server enforces.
