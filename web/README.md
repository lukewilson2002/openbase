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

Icons for workspaces, projects and tables (`src/components/icons/`): the 20 popular Lucide icons are bundled
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
The rich long text editor adds Tiptap 3 (exact version 3.31.3, all `@tiptap/*` the same): core, pm, react, starter-kit,
markdown (the official Markdown extension; it brings its own `marked` 17), and the extensions for blocks the starter kit
lacks or that we adapt (list for task lists, table, blockquote, paragraph, hard-break, extensions for the placeholder).
They load only with the editor chunk (`components/richtext/RichTextEditor`, imported with `React.lazy` by `FieldEditor`),
so the shell and the views do not carry them; the value stays plain Markdown, rendered elsewhere by `Markdown.tsx` (marked 4).

## Commands

Install with the lockfile and without lifecycle scripts (enforced by `.npmrc`):

```sh
cd web
npm ci
npm run dev          # http://localhost:5173, proxies /api to a running openbase on :8080
                     # (the proxy sends $OPENBASE_PUBLIC_URL, default http://localhost:8080, as the
                     # Origin, which the server checks on cookie requests)
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
| `workspaces.contract.test.ts` | workspaces (create, rename, members, delete + restore), projects (schema, rename, duplicate, collaborators, members), tables |
| `fields.contract.test.ts` | every type the field dialog can create with its defaults, link pairs, formulas and the live check, lookup / rollup / count, type changes, delete + restore |
| `views.contract.test.ts` | every view type, config replacement, personal and locked views, duplicate, delete |
| `records.contract.test.ts` | create / update / delete / restore / move, typecast, links from both sides, `before_record_id`, view query (filter, sort, group, search, range, paging, colors, `transient`), aggregations, link lookup, history |
| `collab.contract.test.ts` | comments, mentions and notifications, trash, automations (CRUD, dry-run test, webhook runs, run history) |
| `sharing.contract.test.ts` | share links (create, disable, password, delete, limits, who may), public views and forms without credentials (visible fields only, search / paging / transient / range, passwords, uploads, submissions, rate limit), attachments through `?share=`, CSV export and both CSV imports |
| `automations.contract.test.ts` | what the automations UI relies on: every trigger and action type as the editor sends it, the `action N: ...` error wording, on/off rules, `next_run_at`, real test runs in the history, roles |
| `email.contract.test.ts` | Administration -> Email: the effective settings and their sources, saving (never a host: the shared server keeps email off), the write-only password, validation errors, the test-email answer, closed to regular users |
| `mcp.contract.test.ts` | the MCP endpoint: handshake, the tools a token sees, a project built through tools and read back through REST, icons set / kept / cleared and read back, the collection settings, page field and `get_home` through tools, the email tools |
| `agentAccess.contract.test.ts` | what a full-access token can do to workspaces and folders, over REST and through the tools: create a workspace (and get its top level), create, delete and restore a folder, delete and restore the workspace, the top-level project is protected, a token without `manage` is refused naming the permission, creators and editors cannot delete |
| `weeks.contract.test.ts` | calendar-week and calendar-month dates: the week start from the request, the profile or Sunday, on view queries, the summary bar, saved views and the group-by endpoint |
| `oauth.contract.test.ts` | OAuth for the MCP endpoint, driven by the official `@modelcontextprotocol/sdk` client (`OAuthClientProvider`): discovery from the 401, dynamic registration, PKCE, code exchange, tools, automatic refresh with rotation, revocation from the connected-apps list, `insufficient_scope`, OAuth tokens refused on the REST API; the consent and grant responses are checked against the generated bindings; Change access upgrades a connected app so the token it holds can delete, and back down, with the audit entry, the session-only and CSRF rules and the project-limit refusal |
| (in `flow.contract.test.ts`) | passkeys as far as a server on an IP address goes: `passkeys_enabled: false`, the "needs a domain name" answer, the empty list, session-only for tokens, the administrator's removal. The ceremonies need a domain name and a browser: they are covered by the server tests (`crates/server/tests/passkeys.rs`) and the `passkeys` end-to-end project |
| `events.contract.test.ts` | the SSE streams read by the real `connectBaseEvents` and `connectWorkspaceEvents` while a second client writes (writer's client id, echo skipping, access changes; the workspace stream relays every project the reader can open, picks up new ones and never counts as presence) |

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
| `journey` | `journey.spec.ts` | smoke | first-run setup (creates the administrator, so it must run first), workspace and project, rename a table, add number / single select / date / formula fields through the dialog, add records and edit cells, filter and sort, expanded record and a comment, log out and in |
| `grid` | `grid.spec.ts` | journey | cell editing, undo, filters, search, hiding fields, the field dialog, expanded record, add / delete records, and the row-marker column (numbers, none on the summary row, numbered records in a grouped view) |
| `sharing` | `sharing.spec.ts` | grid | build, share and anonymously submit a form in a fresh cookie-less browser context, a password-protected grid share that hides a field, CSV download and import, a viewer sorting a board |
| `oauth` | `oauth.spec.ts` | grid | an MCP OAuth client in Chrome: registers with a loopback redirect served by the test, the authorization URL sends the browser to the login and back to the consent page, "Read & edit" is approved, the code arrives at the loopback listener and is exchanged with PKCE, `tools/list` and a write tool work, a manage tool is refused with 403, then the app is revoked from Account -> AI assistants -> Connected apps and its tokens stop working; a second test denies an app named "Claude" on another host |
| `assistants` | `assistants.spec.ts` | grid | Account -> AI assistants: the MCP address is the server's public URL and answers `401` with the sign-in metadata, Claude is open by default and the sections are an accordion (mouse and keyboard), the copy buttons write the real clipboard, the token variants are collapsed until opened, the plain-http server shows the public-address warning, and the tab fits 375 px in the light and dark themes |
| `passkeys` | `passkeys.spec.ts` | grid | Chrome's virtual authenticator (CDP `WebAuthn.addVirtualAuthenticator`: CTAP2, internal transport, resident keys, user verification): add a passkey in Account -> Security, sign out, sign in with it and no password (the background request for the email field's autofill list stays pending until the button replaces it), rename and remove it, the removed passkey's leftover credential refused; a TOTP-enabled user signing in by passkey skips the code while the password still asks for it; the autofill request completing the sign-in; an administrator removing another user's passkeys |
| `mobile` | `mobile.spec.ts` | grid | an iPhone 13 sized touch screen (390 px): the bottom navigation (64 px, three tabs), the 56 px header with 44 px buttons, the workspace switcher and profile menu as sheets, the Collections tab, a collection with its back link and search, the filter builder and the record panel fit the screen without horizontal scrolling, and no text field is under 16px (iOS Safari zooms the page into a smaller one) |
| `admin-email` | `adminEmail.spec.ts` | sharing, automations, views, oauth, assistants, mobile, passkeys | Administration -> Email: the tab, saving an SMTP server (no restart), the password shown only as "Saved", the real connection error from "Send test email", and turning email off again (runs last because the setting is instance-wide) |
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

Two specs belong to the UX overhaul. `shellRoutes.spec.ts` opens every route of the spec's Routes table that exists
in a real browser at 1440 and 390 px and checks the shell (the sidebar, or the phone's bottom bar), one `main` with its
own header and one `h1`, and no horizontal scroll; the phase that adds a route adds a line to its `ROUTES`.
`ledger.spec.ts` takes the screen ledger's screenshots into `docs/plans/ux-overhaul-screenshots/NN-slug-{light,dark}-{1440,390}.png`
(NN is the ledger row, device scale factor 1). It rewrites tracked files, so it runs only with `LEDGER_SHOTS=1`
(`LEDGER_ONLY=2,4` limits it to those rows); the data it looks at is seeded through the API by `ledgerSeed.ts`, and a
phase adds a screen by adding one entry to `SHOTS`.

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
src/base/       folder screen in the app shell: the collection header, view dialogs, empty folder, permission rules
src/shell/      the app frame and its sidebar (see "The sidebar"), screen headers, search, the sidebar's dialogs
src/components/ design-system primitives (ui/) and shared dialogs
src/lib/webauthn.ts  the WebAuthn browser API <-> the server's JSON (base64url conversion, support checks, errors); `src/auth/usePasskeyLogin.ts` is the login page's passkey button and background autofill request
src/pages/      setup, login, signup, invite, password reset, home, account/ (SecuritySection: password, PasskeysSection, two-factor), admin/, oauth/ (the consent page an app's "connect" request lands on, `/oauth/consent?request=<id>`; account/AssistantsSection (the AI assistants tab: one section per assistant, with account/ConnectedAppsSection below it) and admin/ConnectedAppsTab list and revoke connected apps)
src/theme/      light/dark theme provider (the pre-paint script is public/theme-init.js)
src/views/      ViewHost + registry.ts: the extension point where grid/kanban/... plug in
src/automations/ the automations page (list, editor, test panel, run history); its own lazy chunk
```

### App frame and routes (NAV-5)

There is no app-wide top bar. `shell/AppShell.tsx` is the frame: the docked sidebar beside `main` on a desktop, and on a phone the bottom
navigation (see "The phone shell"). Each screen draws its own header as the first thing inside `main`: `shell/ScreenHeader.tsx` (on a desktop the sidebar's
toggle, an optional `h1`, actions, the search button; on a phone the `PhoneHeader` it is given in `phone`; the workspace screens get it from
`HomeShell`/`AppPage`) or `base/CollectionHeader.tsx` (path, the collection's `h1` with its color mark, presence faces, Share).
`shell/menuContext.tsx` is how a desktop header reaches the sidebar's state. A screen that scrolls inside itself passes `fill` to `AppShell` and lays out
its own column (header, then a `min-h-0 flex-1` body).

Routes (`App.tsx`; `routes.test.tsx` holds the table): `/` goes to the last workspace's Home (`workspaceToOpen` in `pages/workspace/lastWorkspace.ts`)
or shows first run; `/workspace/:id` is Home (for now the Inbox's capture box until HOME-1 to HOME-11 rebuild it); `/workspace/:id/collections` is
the phone's Collections tab and redirects to Home on a desktop; `/notifications` is a screen of its own and `/inbox` redirects to Home;
`/workspace/:id/automations` lists automations by folder and links to the unchanged editor route. `lib/topLevel.ts` splits a workspace's
projects into the top level and the folders the person can open (NAV-10: `GET /api/workspaces` lists only openable projects and drops
`root_base_id` when the top level is not one of them).

### The sidebar (NAV-1 to NAV-4, NAV-6, NAV-10)

`shell/SidebarContent.tsx` holds what the sidebar holds, top to bottom: `WorkspaceSwitcher` (the open workspace's 26 px mark, its name and "Switch
workspace"; its menu starts with the OpenBase mark, lists the workspaces with a check on the open one, then New workspace and the open workspace's
Rename, Color, Members, Invite people, Settings, History, Trash and Delete), the "Search everything" row (opens the command palette), Home, Notifications (a popover beside the docked sidebar) and Automations (creators), then `NavTree` (the top level's collections, then the folders, each folded open to its collections: `NavTables`
draws a folder's rows), then History, Trash (both filtered to the workspace), Workspace settings (owners) and `ProfileMenu`. `Sidebar.tsx` has only
the docked frame (`DockedSidebar`) and `SidebarLayout`. One component serves the docked sidebar and the phone's Collections tab (`mode`: the tab
leaves out the search row and the Home and Notifications rows, which the header and the bottom bar already have, and flows with the screen).

The tree is drawn from `GET /api/workspaces` alone: a folder carries its collections' summaries and `record_count`, so nothing is fetched when a
folder unfolds. `SidebarContent` asks for the list again on window focus and every 60 s (BE-9); `useBaseEvents` also refreshes it, at most every
3 s, when other people add or delete records in the open folder, and on a schema change. `lib/topLevel.ts` decides what is the top level and what
a folder (NAV-10). Rows are `NavRow`s with a `ColorMark`; a row's "…" menu (and a right-click) comes from `NavRowMenu.tsx` (`RowMenu`, `MenuGroups`).
Menus hold only what the person's role allows, so a viewer's collection row has no "…" at all. Colors go through `ColorDialog` (the swatch picker);
no menu offers an icon (decision 3), though the icon columns stay in the API.

Folders fold on a click or Enter (`useOpenState("ob-folders-open")`: open unless folded by hand, and a folded folder unfolds when the open
collection turns out to be inside it). Drag a collection or folder to reorder it (`sortable.tsx`, `useReorder.ts`), or use Move up and Move down;
workspaces are dragged inside the switcher's menu, or moved with Alt+Up and Alt+Down on the focused one. Width (200 to 400 px, 256 by default) and
the collapsed state are per device (`sidebarPrefs.ts`); Ctrl+\ (Cmd+\) folds it. The dialogs the rows open are `NavDialogs.tsx`, which sits
around the page so they survive the menu or sheet that opened them closing; a collection's CSV import loads the folder's schema first, because the summaries carry no properties.

### The command palette (NAV-9)

`shell/SearchEverything.tsx` wires the core `CommandPalette` (`components/ui/command-palette.tsx`) to the app. `SearchBarProvider` (in
`AppShell`) holds whether it is open and renders it, so the headers' `SearchButton`, the sidebar's row (`useOpenSearch()`) and Ctrl K or Cmd K open
the same one; it is a full-screen sheet below 1024 px. Results come from `GET /api/search` (200 ms debounce, `workspace` or `base` for the scope),
grouped records, collections, folders, views, workspaces, then comments; a record and a comment carry their collection's 8 px mark, and a
collection's color comes from the sidebar's cached `GET /api/workspaces` (the search result has none). The top-level project is never listed as a
folder, and "This folder" is offered only inside a real folder. Actions follow the results and are filtered by `actionMatches` (every typed word
starts a word of the action's name): "New record in <collection>" (editors and up, at most five, within the scope), "New collection", "Go to
Home", "Open settings" (the workspace's for owners, else the account's); with nothing typed the last three are suggested. The core component
keeps focus in the field and drives the list (arrows wrap, Enter runs the highlighted row, Escape closes and returns focus); a `stale` group
(results for text already typed past) is shown but Enter skips it. An editor that uses Ctrl K for itself (links in the rich text editor) must call
`preventDefault()` on that key press: the palette's window listener leaves a handled key alone.

### The phone shell (NAV-7, NAV-8, PH-1, PH-2)

Below 1024 px there is no sidebar and no drawer. `shell/bottomNav.tsx` is the 64 px bottom navigation (`<nav aria-label="Main menu">`, three
tabs: Home, Collections, Notifications with the unread count; 22 px icons, 12 px labels, the current tab in the accent at 600, above
`env(safe-area-inset-bottom)`). `AppShell` draws it when there is a workspace to lead to, pads the page by its height and sets
`--bottom-nav-height` on `:root` while it shows, so toasts and the floating Add button stand above it. A record page (`isRecordPath`) hides it by
its address; any other full-screen screen calls `useHideBottomNav()` from `bottomNav.tsx` while mounted. A collection belongs to the Collections tab.

`shell/PhoneHeader.tsx` is the 56 px header (PH-2): `leading` (the workspace switcher on Home, or a `PhoneBackLink` naming the parent
screen), an optional `h1`, then at most three 44 px buttons, as `PhoneAction`s: the search always has one (`SearchButton`, which opens the
command palette), and when there are more actions than fit the rest go behind a More button (it counts as one of the three) that opens a
sheet. `ScreenHeader` renders it on a phone from its `phone` prop; `HomeShell` has a `variant`: `home` (the switcher and the avatar that opens the
profile sheet), `tab` (the root of a tab: just its title) or `page` (a back link to the Collections tab, or to Home when there is no workspace).

On a phone a menu is a `Sheet` (PH-3): `components/ui/sheet-menu.tsx` (`SheetMenu`, `SheetMenuGroup`, `SheetMenuRow`, 44 px rows that close the
sheet after acting) holds the workspace switcher (`WorkspaceSwitcher` picks the menu or the sheet by `DESKTOP_QUERY`, with the same rows,
drag-to-reorder by holding a row, and Alt+Up and Alt+Down) and the profile menu (`ProfileSheet.tsx`; `ProfileMenu` is the sidebar footer row,
a dropdown on a desktop and the same sheet on a phone). The Collections tab (`pages/workspace/CollectionsPage.tsx`) is `SidebarContent
mode="page"`, live through the workspace stream (`hooks/useWorkspaceEvents.ts`); its rows keep their "…" menus, which are sheets here: `shell/menuItems.tsx`
(`ActionMenu`, `MenuItem`, `LinkItem`) draws one menu's items as a dropdown on a desktop and as `SheetMenu` rows on a phone, so a menu is written once. With no
workspace (first run) `HomeShell` gives the `tab` header the avatar, because there is no tab bar to reach the profile from. `/notifications` is `NotificationsPanel` (shared with the desktop popover; each row is an
avatar, one sentence, a `LinkChip` to the record and the time, with Mark all read at the top). In tests `stubPhone()` (`test/utils.tsx`) sets a
phone-width media query.

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
3,000-record fixture project with every field type (it is never part of a production build). `/api/__mock/role/viewer` switches the
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
| `src/lib/dateGuess/` | Deterministic date-phrase parser for capture (HOME-4): `guessDate(text, {now, timeZone, weekStart})` finds one phrase (today, tomorrow, weekdays, `next Friday`, `Nov 14`, `11/14`, `9am`, ISO), resolves it and returns the text without it; `restorePhrase` puts the words back. Pure: the clock is injected. Not wired into the UI yet |
| `src/lib/guessType/` | The FLD-1 type guesser: `guessType(value)` returns a field type, complete options and the table row that matched. `examples.json` is the example table shared with the CSV importer's `infer_kind` (a Rust test in `store/csv_io.rs` reads the same file); add a row when a rule changes |
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

`components/trash`: `TrashButton` in the project header (creators and owners) opens `TrashDialog` (tables, fields, views, records with relative deletion time and Restore; retention note: 30 days by default). A deleted *workspace* has no trash of its own to open (`GET /api/workspaces/{id}/trash` answers 404 once it is deleted), so the home page lists the caller's own deleted workspaces in "Recently deleted workspaces" (`DeletedWorkspaces`, from `GET /api/trash/workspaces`, owners only) with a Restore button; the section is absent when there are none. `components/notifications`: `NotificationBell` replaces the disabled bell; unread count polled every 60 s and refetched on window focus, `describeNotification` turns payloads (mention: `author_name`, `snippet`, `record_name` and the location keys; assigned: `field_name`, `assigned_by` (a user id, so no name is shown); automation: `message`, `automation_name`; all optional) into text and a link (a record is linked only when the payload names its table), which `BaseShell` keeps intact when it canonicalises the URL.

### Automations (`src/automations`)

`/base/:baseId/automations/:automationId?/:tab?` renders inside the project shell (`BaseShell section="automations"`, lazy chunk), reached
from a folder's menu in the sidebar, and listed by folder for the whole workspace at `/workspace/:workspaceId/automations` (the sidebar's Automations row, creators only; each row links here). Creators and owners only (`basePermissions.manageAutomations`): the server lets editors
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
dialogs behind a button (`ShareViewDialog`, `ImportCsvDialog`, `NewTableFromCsvDialog`, `TrashDialog`) through
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

### Design tokens (Notebook)

`src/styles/index.css` also holds the Notebook tokens of the UX overhaul spec (`docs/plans/2026-11-07-ux-overhaul.md`, "Design
language"): the type scale (`text-meta`, `text-label`, `text-ui`, `text-read`, `text-h3`, `text-sheet`, `text-h2`, `text-title`,
`text-home`, `text-record`, `text-capture`, with `-phone` variants where the spec has them; each sets size, line height, weight and
letter spacing), the radii (`rounded-xs` to `rounded-xl` and `rounded-pill`, which replace Tailwind's own steps of the same names),
control and row heights (`h-control-md`, `h-row-table`), layout widths (`w-sidebar`, `max-w-record`, `max-w-home`, `px-gutter`), the
ColorMark sizes (`--mark-14`, `--mark-14-radius`), the spacing steps (`--space-8`), the durations (`duration-fast`, `duration-base`,
`duration-slow`, each with a `-leave` variant 30% faster) and the enter curve (`ease-enter`). `num` turns on tabular figures. A
`prefers-reduced-motion` rule makes every transition an opacity fade. `src/lib/cn.ts` teaches tailwind-merge the new names; add a name
there whenever you add a token class. `src/styles/tokens.test.ts` pins the values.

`scripts/check-tokens.sh` (part of `scripts/check.sh`, so CI) fails on a raw hex colour, `rgb()` or px font size in `src/` outside
`styles/*.css`, `theme/accents.ts`, `lib/colors.ts`, `lib/cells/palette.ts`, `views/grid/glide/`, `components/brandMarks.ts`,
`pages/account/AssistantMarks.tsx` and test files. Files that have not moved to tokens yet are listed in
`scripts/check-tokens.temporary-list.txt`; the list only shrinks (a file that no longer has a violation must be removed from it), and
it must be empty by Phase 7 of the overhaul. The detector's tests are `src/styles/checkTokens.test.mjs`.

### Core components (`src/components/ui`)

The Notebook component set (spec "Core components"): `Button`, `IconButton` (`label` is its `aria-label`, required by type),
`ColorMark`, `NavRow`, `StatusChip`, `FilterChip`, `LinkChip`, `CaptureChip`, `Card`, `FeedRow` (with `FeedTile`), `PropertyList` /
`PropertyRow`, `Tabs`, `EmptyState` and `Skeleton`. A screen uses these rather than hand-rolling one. Components that can carry an entity
colour take `hue` (a palette colour; `null` draws the mark in the colour its `markName` hashes to, `undefined` draws none), because `color`
is an HTML attribute. `ColorMark` is the `.ob-mark` / `.ob-mark-<px>` classes plus the hue's `.ob-solid` fill. Phone sizes (44 px
targets) switch on at the compact layout (`max-md:`) and on touch screens (`pointer-coarse:`). `src/components/ui/core.test.tsx` covers
their behaviour and accessibility attributes.

### Overlays and the other core components (`src/components/ui`)

The second half of the set, all in `src/components/ui` and tested in `overlays.test.tsx`:

- **Popover and Menu**: `popover.tsx` and `dropdown-menu.tsx` share one surface (`menuSurfaceClass`: radius 12, `--shadow`, 6 px
  padding) and one row (`menuRowClass`: 40 px, 44 on phone, the highlighted row in primary-soft). A popover that holds a form rather
  than rows adds its own padding (`p-3`). Radix gives both the arrow keys and Escape. Escape returns focus to the opener.
- **Sheet** (`sheet.tsx`): the phone's bottom sheet, with the grab handle, title and Done. Hold the handle or title and it follows the
  finger, then settles at half, full or closed from the drag velocity (`sheet-snap.ts`, pure and unit tested). It is sized from the visual
  viewport, so it clears the on-screen keyboard. **Dialog** is centered above the desktop breakpoint (`DESKTOP_QUERY`, now defined in
  `hooks/useMediaQuery` and re-exported by the shell) and a full-screen sheet below it; `phone="bottom"` makes it a `Sheet` instead.
  **ConfirmDialog** is a `Dialog` with `role="alertdialog"`, focus on Cancel and no dismissal by a press outside.
- **SidePanel** (`side-panel.tsx`): the docked 360 px right panel (`w-panel`) for comments and history. Not modal; Escape or its close
  button closes it and returns focus. On phone use a `Sheet` or a full-screen `Dialog`.
- **CommandPalette** and **FilterBar**: presentational shells with the keyboard model built in (`listbox.tsx`: Arrow keys move the
  highlight while focus stays in the field, `aria-activedescendant`, wrap-around). The caller supplies results and suggestions and decides what
  choosing one does. The filter bar's Backspace-on-empty selects the last chip, then removes it.
- **TemporaryChangesBar** and **Toast**: each is a polite live region that is in the page before its text arrives. Keep the bar mounted
  and flip `open`. A toast takes `action` or `actions` (Undo, Open), waits while hovered or focused, and sits bottom-left on desktop and above
  the phone tab bar on phone: the bar sets `--bottom-nav-height` when it is shown.

Dialogs opened from state have no Radix trigger to return focus to, so `use-return-focus.ts` notes the opener and gives focus back
(A11Y-1). Leaving animations (`[data-state="closed"]` on `.ob-*-in` in `styles/index.css`) run 30% faster than entering; under reduced
motion everything fades for 120 ms. `use-presence.ts` does the same for the pieces that are not Radix primitives.

### Design reference page and icons (DL-2, DL-4)

`/__dev/design` (`src/dev/DesignPage.tsx`, sections in `src/dev/design/`) draws every token and every core component in every state, with the
light and dark themes side by side. It is built by `npm run dev` and when `VITE_DESIGN_PAGE=1` (`playwright.config.ts` sets it for the e2e
build), and never into a release build: the route in `App.tsx` is behind `import.meta.env.DEV || import.meta.env.VITE_DESIGN_PAGE === "1"`, so the
page and its chunk are tree-shaken out (check with `npm run build`, then grep `dist` for `DesignPage`). It needs no sign-in. Add a component to its
section in `src/dev/designSections.ts` and to the matching `*Sections.tsx`; `DesignPage.test.tsx` and `e2e/design.spec.ts` check every section in both themes.

- **Forcing a theme.** A column carries `data-theme-scope`, its own `data-theme` and the person's `data-accent`; `styles/index.css` and the generated
  `styles/accents.css` apply the theme variables to such an element as well as to `<html>`. States that need a pointer (hover, focus) are drawn with
  the classes the real state sets.
- **Floating pieces.** `PortalHost` (`ui/portal-host.tsx`) moves the portals of everything inside it (popovers, menus, tooltips, dialogs, sheets) into
  an element, so they take their column's theme. With `inline` it also draws a `Dialog`, `Sheet` or `CommandPalette` open in place, without the focus
  trap or scroll lock, so any number can be open at once inside a `Frame`. The app never uses either.
- **Screenshots** for the ledger are in `docs/plans/ux-overhaul-screenshots/01-design-reference-{light,dark}-{1440,390}.png`. A page taller than
  16384 px cannot be captured in one piece by Chrome: take it in strips (`clip` with `fullPage`) and append them.

`ui/icon.tsx` is the one way the core components draw an icon: stroke width 2, `currentColor`, `aria-hidden`, 16 px (20 on phone and touch screens)
by default, `size="sm"` (12 px) inside a chip or checkbox, `size="fit"` where the caller sizes it. It accepts no stroke width, colour or width/height.
`IconButton` requires `label` by type. `ui/icons.test.tsx` holds the `@ts-expect-error` cases and a scan of `components/ui` that fails on a lucide
glyph drawn directly, a stroke width set by hand, an `IconButton` without `label` or an icon-only `<button>` without `aria-label`.

### Logo, favicon and web app manifest

`brand/` holds the logo artwork (see `brand/README.md`); `scripts/gen-brand.sh` turns it into what the client ships and
`scripts/check.sh` fails when the copies are stale (`--check`):

- `public/favicon.svg` (the small mark), `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` and
  `icon-maskable-512.png`, linked from `index.html`. `public/manifest.webmanifest` (name OpenBase, theme `#1F5AE0`, the three icons) is
  handwritten. There are no inline scripts or styles in `index.html`: the server's CSP forbids them.
- `src/components/brandMarks.ts` (generated): the path data that `components/Logo.tsx` draws inline. `Logo` is the lockup (mark plus
  outlined wordmark, in the text colour, so it follows the theme) or, with `showName={false}`, the small mark; `BrandMark` is the bare
  mark. They sit on the sign-in, setup, invite and reset pages and, as "Powered by OpenBase", the footer of public
  form and share pages. The server serves these files with `Cache-Control: public, max-age=86400` and an ETag (the manifest and
  `index.html` are `no-cache`), see `crates/server/src/web.rs`.

### Conventions

- Every request goes through `src/api/client.ts` (CSRF header, client id, error mapping, 401 handling).
- Query keys live in `src/api/keys.ts`. Anything showing records of a table must key under `["records", tableId, ...]`
  so live `records_changed` events refresh it.
- The server sends `script-src 'self'`: never add inline scripts to `index.html` (the theme bootstrap is a file).
- UI permission checks (`src/base/permissions.ts`, `src/lib/roles.ts`) only hide or disable controls; the server enforces.
