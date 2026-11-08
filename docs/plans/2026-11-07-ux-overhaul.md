# OpenBase UX Overhaul: Build Spec

Nov 7, 2026 · @Luke Wilson

## How agents use this spec

Build everything here, in phase order, on one branch, and stop only when every item in the Definition of done passes. Nothing merges to main until then, so main is never half-transitioned.

**Rules of engagement**

1. **Read first.** Read this whole spec, then `CONTRIBUTING.md`, `SECURITY.md` and `web/README.md`, before writing code.
2. **One branch.** All work happens on `ux-overhaul`, cut from `main`. Merge only after the final audit passes.
3. **Phase order is binding.** Phase 0 (security) must pass its gate before any UI or schema change. Each later phase starts only when the one before it meets its exit criteria.
4. **No half-transitions.** Every screen in the migration ledger moves to the new design in this effort. Old components are deleted, not left beside new ones. No feature flags, no "classic mode", no TODO stubs in shipped screens. While the branch is in progress, a screen not rebuilt yet may keep its old implementation inside the new shell; only the finished branch has to be fully moved.
5. **Numbered requirements.** Each requirement has an id (for example `NAV-3`) and acceptance criteria. Cite ids in commit messages and in the progress file.
6. **Progress file.** Keep `docs/plans/2026-11-07-ux-overhaul-progress.md` current: the ledger, each requirement's status, decisions made, and the last green check run. A fresh agent must be able to resume from it alone.
7. **When the spec is silent:** follow the design language, choose the simplest option that fits it, and log the choice in the progress file. Additive API fields and endpoints are fine: build them and log them. Stop only before removing, renaming or retyping an existing API field, deleting user data, or widening permissions beyond what this spec names. When blocked, log it under Blocked in the progress file and carry on with the next requirement that isn't blocked.
8. **Invariants.** Never break the Airtable-compatible REST API, the MCP tool contracts, or existing data. Every migration is forward-only and keeps every value a user entered.
9. **Code style.** Follow the repo's existing conventions, including its comment style: comments explain why, not what.
10. **Checks stay green.** After every requirement, the fast checks pass. The full suite, scans and audits run at each phase gate and in CI (Build plan). A red check is fixed before the next requirement starts.

**Done means done.** The work is finished when every Definition of done item is ticked in the progress file with evidence: test names, screenshots, audit output. Anything less is not finished, whatever the time.

## Goals and principles

OpenBase should feel like a notebook that happens to be a database. Someone new can capture a thing, find it again and change how they see it without setting anything up first. The configuration power stays, one step back.

**Goals**

- Records read and edit like documents: a title, a few properties, then a page.
- Fewer levels: workspace, then collections. Projects become optional folders.
- One design language across every screen, written down as tokens and shared components.
- Phone is first-class: every screen works at 390 px wide with 44 px touch targets.
- Agents stay optional. Every feature works fully by hand, and the MCP tools keep working as they do today.

**Non-goals**

- No changes to Airtable-compatible API responses or existing MCP tool contracts. Additions only.
- No AI or language-model features inside the app. Every guess the app makes is a deterministic rule.
- No block-based document model. A page body is markdown stored in a field.
- No templates, paid tiers or feature flags.
- No changes to how sign-in, sessions, permissions or sharing work, beyond restyling, the security work in Phase 0, and agent access (AGT-2, AGT-3).

**Product principles** (use these to settle anything the spec doesn't cover)

1. **Data first, settings second.** A screen opens on the data. Settings live behind one clearly named control.
2. **Changes are temporary until saved.** Filtering or regrouping a view never changes it for anyone else until someone taps Save as view.
3. **Guess, then let people correct.** The app pre-fills the likely choice (a field type, where a capture goes) and shows how to change it.
4. **Color marks places, icons mark actions.** Workspaces, folders and collections are identified by color alone. Icons appear only on buttons and controls.
5. **One way to do each thing.** If two controls do the same job, one is removed.
6. **Same app on every screen size.** Phone layouts adapt; they never drop a feature.
7. **Predictable for people and agents.** The same input always gives the same result, and the UI never does something the API can't.

**Interaction targets.** Each row becomes a Playwright test in Phase 7.

| Task | Starting point | Target |
| --- | --- | --- |
| Capture a task | Home | Type, then Enter |
| Open a record | Collection | 1 click or tap |
| Filter by a field | Collection | Type a phrase, then Enter |
| Save the current filter as a view | Collection | 1 click, then name it |
| Add a property to a record | Record page | Name, value, Enter |
| Switch layout (grid, board, calendar) | Collection | View options, then 1 tap |
| Jump to any record or collection | Anywhere | Ctrl K or Cmd K, type, Enter |

## Decisions

These are settled; agents build to them and don't reopen them. Each one says why, so edge cases can be judged the same way.

1. **Folders are projects, and a workspace's top level is one project.**
   - Add `workspaces.root_base_id`. Collections in that project show directly under the workspace. Every other project shows as a folder.
   - Migration: the first live project by position becomes the top level (ties broken by creation time, then id). A workspace with no live project gets a new one, named after the workspace. An owner can pick another with "Use as top level", which only moves the pointer. New workspaces get a top-level project named after the workspace.
   - Why: links, lookups, automations, attachments, permissions, live events and API ids are all scoped to a project (`check_link`: same base only). A pointer keeps every one of them working, with no data moved.
   - Consequence: links work only within one folder, and the top level counts as one folder. Moving a collection between folders is out of scope. The store refuses to delete the top-level project, through REST and MCP alike.
2. **Every collection has a page body, stored as a designated rich text property.**
   - Add `tables.body_field_id`, copying the primary-field pattern; it may be empty. Migration: a table with exactly one live `rich_text` field uses it as the page. Every other live table gets a new `rich_text` field named "Page" (or "Page 2", "Page 3" and so on, the first free name), hidden in every view. Tables in the trash, and tables already at the 500-field limit, are left without one. New collections get "Page" automatically. Deleting or retyping the page property just clears the pointer. When someone writes a page in a collection with no page property, the server creates "Page" as part of that save; this is the one schema change an editor can cause.
   - Why: a normal cell keeps history, search, mentions, file embeds, CSV, forms, automations and the v1 API working. A new column on `records` would bypass all of them, and the attachment cleanup would delete images that only appear in pages.
   - Consequence: text edits must stop flooding `record_history` (BE-6).
3. **Colors replace icons for workspaces, folders and collections.**
   - The UI stops showing and picking icons for them. Add `tables.color`; workspaces and projects already have one.
   - The `icon` columns, REST fields and MCP parameters stay for compatibility, but nothing in the UI reads them. `list_icons` stays, with its description saying icons are no longer displayed.
4. **Every view change is a draft until someone saves it.**
   - Every view setting except a form's own settings goes into a draft kept on this device for this person (COL-5 lists each one). Filter, sort, group, color rules and summaries travel to the server as `TransientConfig` so it can compute them (BE-12).
   - Save as view creates a new view. Update view writes the draft to the current view, for people allowed to configure it. On the default view, which sets every record's layout, editors and up can Update view for layout settings only (order, hidden, widths, frozen columns, row height, wrapped headers); its filters, sorts, groups and colors can only become a new view, as the server already enforces. The debounced auto-save is removed.
   - Why: this is the agreed direction, and it removes today's two behaviours (instant shared saves for some people, "Not saved" overlays for others).
5. **Records open as pages with their own URL:** `/base/:baseId/:tableId/r/:recordId`, or `/base/:baseId/:tableId/:viewId/r/:recordId` with the view. Without a view, previous and next follow the last view used for that collection, else the default view. Old `?record=` and `?linked=` links, which emails, notifications and history use, redirect. The `ExpandedRecord` modal is removed.
6. **Home is per workspace and absorbs the Inbox page.** `/workspace/:id` is Home again; `/` redirects to the last workspace's Home. Inbox drafts show on Home.
7. **Every guess the app makes is a deterministic rule.** That covers plain-language filters (COL-4), date phrases in capture (HOME-4) and property type guessing (FLD-1). Each is a pure function with exhaustive unit tests. No model, no network call.
8. **Agents are optional, and parity stays.** Every new setting gets a REST endpoint (catalogued, so `api_request` reaches it) and an MCP tool or parameter. No feature exists only for agents.
9. **Security first, audit last.** Phase 0 updates dependencies and fixes known issues before any UI work. Phase 8 audits the finished branch, and it doesn't merge with any critical or high finding open.
10. **This spec replaces parts of `docs/plans/2026-10-18-app-flow-redesign.md`.** It overrides that plan's item 2 (views leave the sidebar, folders fold instead of opening, and folder menus follow NAV-3), item 3 (`/workspace/:id` is Home again), item 4 (view tabs show names), item 7 (color pickers now cover collections, and icons go), item 9 (the expanded record becomes a page), item 10 for the Page only (rich text in grid cells and forms keeps its toolbar editor and expand button), item 11 (Inbox moves into Home), and item 1's interface word "project", which becomes "folder". Items 5, 6 and 8 stand, and so do item 1's MCP tool names.

Save this spec in the repo as `docs/plans/2026-11-07-ux-overhaul.md`, next to the earlier plans.

## Phase 0: Security first

No UI or schema work starts until the dependency scans are clean of fixable high and critical issues and the hardening items below are merged into the branch. Baseline from the lockfiles on 2026-11-07:

| Scan | Critical | High | Medium | Low / unscored | Notes |
| --- | --- | --- | --- | --- | --- |
| `npm audit` (532 packages) | 0 | 2 | 8 | 0 | Both highs are dev-only (undici via jsdom, body-parser via the MCP SDK). One moderate reaches the production tree: minimatch via Glide's linaria. |
| `cargo audit` (529 crates) | 0 | 2 | 3 | 8 | Plus 1 unsound warning (tokio). The highs (pulldown-cmark) need wikilinks, which the code never enables. |

**SEC-1 Rust dependencies.** Run `cargo update` and bring these to fixed versions: pulldown-cmark ≥ 0.13.6, rustls ≥ 0.23.46, rustls-webpki ≥ 0.103.16, webpki-root-certs ≥ 1.0.10, time ≥ 0.3.47, ctutils ≥ 0.4.4, tokio ≥ 1.53.3. Remove the unused `ammonia` dependency and pulldown-cmark's unused `html` feature. Two advisories have no fix today: rsa (RUSTSEC-2023-0071, via webauthn-rs; passkeys only verify signatures) and crypto-bigint (RUSTSEC-2026-0387). Check whether webauthn-rs (pinned `=0.6.1-dev`) has a release that clears them. If not, record both as ignored, with the reason and a re-check date.

**SEC-2 JavaScript dependencies.** Update undici ≥ 8.12.2, body-parser ≥ 2.4.0, qs and fast-uri ≥ 3.1.9. Add an `overrides` entry forcing minimatch ≥ 11.0.1 under `@glideapps/glide-data-grid`, rather than downgrading Glide. Confirm the grid still builds and its tests pass.

**SEC-3 Scans in CI and `scripts/check.sh`.**

- Add cargo-deny with a `deny.toml` covering advisories, bans, sources and licences. Every ignore carries its reason.
- Add `npm audit --audit-level=high` for the full tree. Leave `audit=false` in `web/.npmrc` for installs, but run audit explicitly.
- Add a gitleaks secret scan and a Trivy scan of the Docker image (fail on critical or high).
- Add the `docker` ecosystem for `deploy/` to `.github/dependabot.yml`.

**SEC-4 Hardening.** Each of these was found in the 2026-11-07 code review (paths under `crates/server/src/`):

1. **CSRF Origin check.** `http.rs` only checks the `x-openbase-csrf` header, but `docs/security.md` and the README promise an Origin check. Implement it for cookie-authenticated requests only: one whose `Origin` (or `Referer`) is present and differs from the public origin is refused with 403. Bearer-token clients and anonymous form posts are unaffected. Add tests.
2. **Share-link passwords.** New passwords need at least 8 characters (today 4, `api/sharing.rs`); existing ones keep working. Add a per-link cap of 100 wrong guesses per hour across all IP addresses, after which that link refuses guesses for 15 minutes.
3. **Hashing slots.** Give anonymous share-password checks their own concurrency limit, separate from the 2 slots used by sign-in (`auth/password.rs`), so anonymous traffic can't queue logins.
4. **Headers.** Send HSTS (1 year, no preload) when the public URL is https, plus `Permissions-Policy` (camera, microphone and geolocation off), `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`. `style-src 'unsafe-inline'` stays; it is documented as an accepted risk.
5. **Session cookie.** Use the `__Host-` prefix when the public URL is https, and add a 14-day idle timeout on top of the 30-day maximum. Renaming the cookie signs everyone out once; say so in the release notes.
6. **Real client IP for MCP.** `mcp/api.rs` already forwards `x-forwarded-for` when `trust_proxy` is on. Finish the other case: with no proxy, pass the outer peer IP to in-process `api_request` calls as a request extension, never as `X-Forwarded-For`, so rate limits and the audit log see the real caller.
7. **Images and toolchains.** Pin Docker base images by digest. Move the runtime image to current Debian stable, so ffmpeg is patched. Pin `rust-toolchain.toml` to a named version (1.99.1 as of today) and make CI and Docker use it. Build on the active Node LTS line. If the pinned toolchain can't be downloaded where the agent works, commit the pin and let CI verify it.

**SEC-5 Write it down.** Update `docs/security.md` to match the code. Accepted risks get their reason: share tokens stored in plain text (people need to copy links again later), inline styles, the two unfixed advisories, and the share-link guess cap, which lets anyone lock a link's password prompt for 15 minutes.

**Gate (exit criteria for Phase 0)**

- [ ] `cargo deny check` passes, with only documented ignores.
- [ ] `npm audit --audit-level=high` reports nothing.
- [ ] gitleaks and Trivy pass.
- [ ] Every SEC-4 item has a test or a recorded manual check in the progress file.
- [ ] `OPENBASE_E2E=1 scripts/check.sh` is green. A scan that can't run where the agent works (no Docker for Trivy, no network for audits) is recorded as not run, with the reason, and must pass in CI before the pull request (DONE-11).

## Design language: Notebook

Notebook is calm, flat and text-led. White pages on a soft grey ground, one blue accent, color only where it means something, and borders rather than shadows. It keeps OpenBase's current tokens and brand, and adds the rules that make every screen look like the mockups.

**DL-1 Codify it.** Tokens live in `web/src/styles/index.css` (CSS variables, mapped to Tailwind in `@theme`). Every color, size, radius, shadow and duration in a component comes from a token. Acceptance: a check script fails on any raw hex, `rgb(` or px font size in `web/src` outside two lists. The permanent exempt list: `styles/*.css`, `theme/accents.ts`, `lib/colors.ts`, `lib/cells/palette.ts`, `views/grid/glide/*`, `components/brandMarks.ts` (generated), `AssistantMarks.tsx` and test files. The temporary list holds files not moved yet, and must be empty by Phase 7. The script runs in CI.

**DL-2 Reference page.** A route `/__dev/design`, built in dev and in the e2e build (`VITE_DESIGN_PAGE=1`) but never in release builds, renders every token and every component below, in every state, side by side in light and dark. Phase 7 screenshots come from this page and the real screens.

### Color

Keep the existing semantic tokens and their light and dark values exactly: `--bg #f6f7f9`, `--surface #ffffff`, `--subtle #f0f2f5`, `--hover #e8ebf0`, `--line #dfe3ea`, `--line-strong #c4cad4`, `--fg #1b1f27`, `--muted #566070`, `--faint #636d7e`, `--primary #1f5ae0`, `--primary-soft #e4ecff`, `--primary-soft-line #c9d8ff`, `--primary-ink #12358a`, plus danger, success and warning. Choice chips keep their `.choice-<hue>` pastel pairs.

- The accent is the only emphasis color (blue by default, or the hue the person picked under Appearance, which stays): primary buttons, links, focus rings, the selected nav item, the active tab, filter chips.
- Status colors appear only on status values: red for overdue dates and errors, green for success.
- Text meets 4.5:1 on its background in both themes. Non-text controls meet 3:1.

**DL-3 Entity colors replace entity icons.** Workspaces, folders and collections are identified by a color mark: a solid rounded square beside the name. They never show an icon, emoji or letter. The palette is the existing one shared with the server (`lib/colors.ts`, `ob_core::field::COLORS`): ten hues (blue, cyan, teal, green, yellow, orange, red, pink, purple, gray), each with a `_dark` variant. A mark is filled with the hue's existing solid shade (`accentClass(color, "solid")`), which already has light and dark theme values.

Collections get a stored color too (BE-2); today only workspaces and projects have one. Anything without a stored color uses the existing hash-based fallback (`lib/workspaceColor.ts`), so a mark is never blank.

Marks carry a 1 px inset border at 12% of `--fg` so pale hues still read on white. A mark always sits beside its name, so color is never the only cue. Sizes: 8 px (inline in meta text, radius 2), 10 px (chips, radius 3), 14 px (sidebar rows, radius 4), 24 px (phone titles, radius 7), 26 px (workspace switcher, radius 7), 28 px (desktop titles, radius 8).

### Type

The system font stack stays (`--font-sans`). One scale, used everywhere:

| Token | Size / line height | Weight | Used for |
| --- | --- | --- | --- |
| `text-meta` | 12 / 16 | 400 | counts, timestamps, a row's collection name |
| `text-label` | 13 / 18 | 400, 600 | property labels, section labels, secondary buttons |
| `text-ui` | 14 / 20 | 400, 500, 600 | default UI text, table cells, nav rows |
| `text-read` | 15 / 24 | 400 | page body on desktop |
| `text-read-phone` | 16 / 25 | 400 | page body and every input on phone |
| `text-h3` | 16 / 21 | 600 | page subheadings |
| `text-sheet` | 18 / 24 | 600 | sheet and dialog titles, phone section titles |
| `text-h2` | 20 / 26 | 600 | page headings |
| `text-title` | 24 / 29 | 600 | collection title; phone home title is 26 |
| `text-home` | 28 / 34 | 600 | Home title |
| `text-record` | 34 / 39 desktop, 26 / 31 phone | 700 | record title |

Titles of 20 px and up use letter spacing −0.01em; the record title uses −0.02em. Numbers, dates and money use tabular figures. Inputs on touch screens are at least 16 px (the existing iOS zoom rule stays). The capture box input is the one exception to the scale: `text-capture`, 18/26 on desktop and 17/24 on phone.

### Space, size and shape

- **Spacing** steps of 4: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64.
- **Layout widths:** sidebar 256 px; record page column 760 px max; Home column 960 px max; collections use the full width with 40 px side padding on desktop and 16 px on phone.
- **Control heights:** 30 px small, 34 px default and 40 px large on desktop; 44 px minimum for anything tappable on phone. Table rows are 46 px, feed rows 44 px desktop and 56 px phone.
- **Radius:** `--radius-xs` 4 (kbd, marks), `--radius-sm` 6 (chips in inputs, link chips), `--radius-md` 8 (buttons, inputs, nav rows), `--radius-lg` 12 (cards, popovers, embeds), `--radius-xl` 16 (bottom sheets, phone cards), `--radius-pill` 999 (status chips, avatars, capture chips).
- **Elevation:** flat by default. Cards use a 1 px `--line` border. Shadows appear only on things that float: popovers, menus, the command palette, sheets and the capture card (`--shadow`).

### Motion

- Durations: 120 ms for hover and press, 180 ms for popovers and menus, 240 ms for sheets and dialogs.
- Entering uses an ease-out curve (`cubic-bezier(0.2, 0, 0, 1)`); leaving is 30% faster.
- Bottom sheets follow the finger, then ease into the nearest resting point (half or full height, or closed) when released, using the drag velocity.
- Nothing moves by itself, and nothing blocks input while it animates. With `prefers-reduced-motion`, transitions become opacity-only fades of 120 ms.

### Icons

- **DL-4** Icons mark actions and control state only: search, add, close, more, share, comments, history, back, sort, filter, layout types, checkboxes. Stroke icons at stroke width 2: 16 px on desktop, 20 to 22 px on phone. They inherit the text color.
- No icon, emoji or letter marks for workspaces, folders or collections, and no per-record icons (the record page's initials tile, REC-2, is the one exception). Feeds may show one generic page glyph on a tile tinted with the collection's hue. View tabs keep a small layout icon (grid, board, calendar and so on), because it tells you the layout, not the place.
- Every icon-only button has an `aria-label`.

### Core components

Build these once in `web/src/components/ui` and use them everywhere. A screen that hand-rolls one of these fails review.

| Component | Anatomy and rules |
| --- | --- |
| Button | Primary (blue fill, white text, 600), Secondary (white, `--line-strong` border), Soft (primary-soft fill, primary-ink text, for Save as view), Ghost (text only), Danger. Sizes 30, 34, 40; 44 on phone. |
| IconButton | 34 px square desktop, 44 px phone, radius 8, transparent until hover. `aria-label` required. |
| ColorMark | The entity color square (DL-3). Props: hue, size. Decorative: `aria-hidden`. |
| NavRow | 34 px, radius 8, 14 px mark, name, optional count on the right. Selected: primary-soft fill, primary-ink text at 600, `aria-current`. |
| StatusChip | Pill, choice hue pair, 12 to 13 px, 500. |
| FilterChip | Radius 6, primary-soft fill and border, primary-ink text, with a remove button. Lives inside the filter bar. |
| LinkChip | Radius 6, `--bg` fill, `--line` border, 8 px mark of the linked collection, record name. Opens the linked record. |
| CaptureChip | Pill, 30 px (36 on phone), shows a choice the app made for you ("Goes to Tasks", "Due today"). Tap to change. A dashed variant adds a property. |
| Card | Surface fill, 1 px line border, radius 12; 14 to 16 on phone. |
| FeedRow | Leading checkbox, event icon or tinted page glyph; title (500); meta line (12 px muted, with an 8 px mark); trailing date or time. |
| PropertyList | Two-column grid: 160 px labels (13 px muted) and values, 36 px rows; 116 px and 44 px rows on phone. |
| FilterBar | One field that holds filter chips, then free text, with a suggestion popover underneath (COL-3). Focused border: 2 px blue. |
| TemporaryChangesBar | Subtle-grey strip: "Showing 3 of 12. This filter is only for now." with Reset (ghost) and Save as view (soft). |
| Tabs | Text tabs with a 2 px blue underline on the selected one and a 15 px layout icon. |
| Popover and Menu | Surface, radius 12, `--shadow`, 6 px padding, 40 px rows; the highlighted row is primary-soft. |
| Sheet | Phone bottom sheet: radius 16 on top, a 36 × 5 px grab handle, title and Done, overlay `--overlay`. |
| SidePanel | Desktop right panel, 360 px, for comments and history. |
| Dialog | Centered on desktop, full-screen sheet on phone. Only for confirmations and short forms. |
| CommandPalette | Ctrl K or Cmd K. Searches records, collections, folders, workspaces and actions. |
| EmptyState | One sentence on what goes here, plus one primary action. No illustrations except on first-run onboarding. |
| Skeleton | Loading placeholders in the shape of the content. No spinners on page loads. |
| Toast | Bottom-left on desktop, above the bottom navigation on phone. Undo where the action can be undone. |

### Words

- Sentence case everywhere. Buttons are verbs ("Save as view", "Add property").
- Interface terms: **Workspace**, **Folder** (was project or base), **Collection** (was table), **Record**, **Property** (was field), **View**, **Page** (a record's body), **Layout** (grid, list, board, calendar, gallery, timeline, form). Kanban is called Board.
- The REST API, MCP tools and stored data keep their existing names (base, table, field). Only the interface changes.

## Navigation

The app has three levels people see: workspace, then collections (some inside folders), then records. Views are tabs inside a collection and leave the sidebar. Mockups: every desktop screen's sidebar, and "Phone: home".

**Desktop sidebar**

- **NAV-1 Structure, top to bottom:**
  1. Workspace switcher: the workspace's 26 px color mark, its name, "Switch workspace" in 12 px muted, and a chevron.
  2. "Search everything" with a Ctrl K hint, which opens the command palette.
  3. Rows for Home, Notifications (unread count) and Automations (creators only).
  4. A "Collections" heading with a + button (shown to people who can create in the top-level project), then the top-level collections, then the folders. Each folder has a disclosure chevron, its mark and name in 600 weight, and its collections indented 20 px.
  5. Footer: History, Trash, Workspace settings, then the person's avatar and name, which opens the existing profile menu.
- **NAV-2 Rows.** Collection rows show their record count on the right (BE-4). Clicking a collection opens its last-used view (existing `lastPlace`). Clicking a folder folds or unfolds it; fold state stays per device. Folders and collections reorder by dragging, as today. Width stays resizable from 200 to 400 px (default 256) and collapsible, with Ctrl+\\ as a new shortcut.
- **NAV-3 Row menus** ("…" and right-click):
  - Collection: Rename, Color, Duplicate, Import CSV, Move up, Move down, Delete. "Edit schema" and "Add view" leave this menu; views are made from the tabs.
  - Folder: Rename, Color, New collection, New collection from CSV, Share, Access, Automations, Duplicate, Move up, Move down, Use as top level (owners), Delete (owners).
  - Workspace (from the switcher menu): Rename, Color, Members, Invite people, Settings, History, Trash, Delete.
- **NAV-4 Switcher menu.** Lists every workspace by mark and name with a check on the current one, then New workspace. Drag reorders workspaces (each member's own order, as today).
- **NAV-5 No global top bar.** The sticky app top bar goes. Each screen draws its own header inside `main`: the collection header (COL-1) or the record page's breadcrumb bar (REC-1). Presence avatars and Share move into the collection header.
- **NAV-6 Brand.** The OpenBase mark appears on sign-in pages, public pages and at the top of the workspace menu. It is not in the switcher, which shows the workspace's color.

**Phone**

- **NAV-7 Collections tab.** The bottom bar's Collections tab is a full screen holding what the desktop sidebar holds: switcher, collections and folders, and the footer links. The sidebar drawer is removed on phone.
- **NAV-8 Account.** The avatar button in the Home header opens the profile menu as a sheet. Home, the Collections tab and every collection screen have a search button in the header that opens the command palette.

**Everywhere**

- **NAV-9 Command palette.** The existing `SearchEverything` (Ctrl K or Cmd K) is restyled to the Popover and Menu rules. Scopes stay as today: Everywhere (the default), This workspace, and This folder (was This project). Results are grouped: records (with their collection's mark), collections, folders, views, workspaces. Actions appear when the text matches: "New record in Clients", "New collection", "Go to Home", "Open settings". It is fully keyboard-driven.
- **NAV-10 Limited members.** People limited to some folders see only those. The top level shows only if they can open the top-level project.

**Routes**

| Screen | Route | Change |
| --- | --- | --- |
| Home | `/workspace/:id` | Was a redirect; now Home. `/` redirects to the last workspace's Home, or first-run when there is none. |
| Collection | `/base/:baseId/:tableId/:viewId?` | Unchanged |
| Record page | `/base/:baseId/:tableId/:viewId/r/:recordId` | New; the view id is optional. `?record=` and `?linked=` redirect here. |
| Collections (phone tab) | `/workspace/:id/collections` | New. Desktop redirects it to Home. |
| Notifications | `/notifications` | New full screen for phone. Desktop keeps the popover, and the route also works there. |
| Automations | `/workspace/:id/automations`, `/base/:baseId/automations/:automationId?/:tab?` | Workspace list is new; the editor route is unchanged. |
| Members, workspace settings | `/workspace/:id/members`, `/workspace/:id/settings` | Unchanged |
| History, Trash, Account, Admin | `/history`, `/trash`, `/account?tab=`, `/admin?tab=` | Unchanged |
| Inbox | none | Removed. Its old links redirect to Home. |
| Public form and share pages, sign-in pages | unchanged | Restyled only |
| Design reference | `/__dev/design` | New, dev only (DL-2), next to `/__dev/share` |

A folder with no collections yet (`/base/:baseId`) shows an empty state with New collection and Import CSV: the existing `EmptyBase`, restyled.

## Home

Home is where you land in a workspace. It has three things: a capture box, what's due soon, and what changed recently. It replaces today's home page and absorbs the Inbox page. Mockups: "Home" and "Phone: home".

- **HOME-1 Landing.** After sign-in, and when switching workspaces, the app opens that workspace's Home. The last workspace used is remembered (existing `lastWorkspace.ts`).
- **HOME-2 Header.** Today's date in the person's time zone ("Saturday, November 7", 13 px muted), then the title "Home".
- **HOME-3 Capture box.** A raised card (`--shadow`, primary-soft-line border) that holds:
  - A text input, 18 px on desktop and 17 px on phone, with the placeholder "Add a task, a note, a meal, anything". Shift+Enter adds a line.
  - A **Goes to** chip naming the target collection with its mark. It defaults to the last collection this person captured into in this workspace. Tapping it opens a searchable picker of the collections where this person can add records and whose title is a text property, plus **Inbox**, which saves a draft to file later. With no such collection, it defaults to Inbox.
  - **Date chips** the app fills in by itself (HOME-4).
  - A dashed **Property** chip that sets any other property of the target collection.
  - "Enter to add" hint and an **Add** button (44 px on phone).
  - Pasting or dropping files attaches them to the target's first attachment property, with the existing upload chips.
  - On add: the first line becomes the title and any further lines go into the page, the box clears, and a toast says "Added to Tasks" with Open and Undo.
- **HOME-4 Date guessing.** A deterministic parser (no AI) finds one date or date-time phrase in the text: today, tonight, tomorrow, weekday names, "next Friday", "Nov 14", "11/14", "14 Nov", times like "9am" or "14:30". If the target's Home date (HOME-5) is a writable date property, the phrase becomes a chip such as "Due today" and is removed from the title. Removing the chip puts the words back. Unit tests cover every phrase form and the time zone edge cases.
- **HOME-5 Which date counts.** Each collection has an optional **Home date** setting: one date property, chosen in collection settings ("Show on Home by"). The migration presets it to the first date property named Due, Due date, Deadline, Date, When or Start (case-insensitive), or leaves it off. An optional **Done** setting names a checkbox property; the migration presets it to the first checkbox named Done, Complete or Completed.
- **HOME-6 Due soon.** Records from every collection with a Home date that the person can see, dated from 30 days ago to 7 days ahead, excluding records marked Done. Sorted by date, oldest first. Each row shows a Done checkbox (or a calendar glyph when the collection has no Done setting), the title, the collection's name with its 8 px mark, and the date: red relative words when overdue ("Yesterday", "3 days ago"), "Today", a weekday within the week, plus the time for date-times. Checking the box marks it done and the row leaves with an Undo toast; people who can't edit that collection see the box disabled. Up to 8 rows, then "Show more" expands in place up to 50. If the server's scan budget ran out, a muted line says some collections weren't checked.
- **HOME-7 Recently changed.** The 10 most recently created or edited records in the workspace that the person can see. Each row shows a 28 px tile tinted with the collection's hue holding a page glyph, the title, the collection name, and a relative time. "All activity" opens the existing history page.
- **HOME-8 Inbox drafts.** Drafts belong to the person, not to a workspace, so they show on every Home. When any exist, an "Inbox" card appears between the capture box and the lists, showing each draft with File and Delete. Filing uses the existing target form. The separate Inbox page and its nav entry are removed; old Inbox links redirect to Home.
- **HOME-9 Layout.** On desktop the two lists sit side by side when the column is at least 760 px wide, and stack below that. On phone the order is capture, Inbox (if any), Due soon, Recently changed.
- **HOME-10 Live.** Both lists update live through the workspace event stream (BE-9). A new workspace with no collections still captures (to Inbox) and shows one empty state below the box: "Make your first collection" with a primary button.
- **HOME-11 Speed.** Home's data comes from one request (BE-3). It returns in under 300 ms for a workspace with 20 collections and 100,000 records on a laptop, measured by a release-mode server benchmark (an ignored test run at the Phase 6 gate), not by the debug test run.

## Collections and views

A collection opens straight onto its records. One bar filters and searches. One button holds every view setting. Nothing changes for anyone else until someone saves. Mockups: "Collection" and "Phone: collection with View options".

**Header and tabs**

- **COL-1 Header.** The 28 px mark, the title (24 px, 600), "12 records" (13 px muted), then on the right: presence avatars, Share (secondary) and a primary **New client** button. That button uses the collection's Record name (COL-10), or "New record" when none is set. A collection inside a folder shows the folder's name with its 8 px mark above the title. The description, if any, shows under the title as one muted line; creators click it to edit.
- **COL-2 View tabs.** The default view comes first and reads "All clients" ("All" plus the collection name, lowercased). Saved views follow, each with its layout icon and name. Personal views show a small person glyph and locked views a lock. Tabs that don't fit go into a More menu. Right-click or long-press opens the existing view menu: Rename, Duplicate, Share, Lock, Move left, Move right, Delete. Tabs also reorder by dragging. There is no + tab: new views come from Save as view (COL-5).

**The filter bar**

- **COL-3 One bar for filter and search.** It sits under the tabs, full width, with View options to its right. `/` focuses it, and so does Ctrl+F (which used to open view search). Chips sit inside it. Typing opens a suggestion list underneath, ranked:
  1. Filters the text can mean ("**Next follow-up** is **this week**"), most likely first.
  2. Filters on a long-text property ("**Notes** contain “follow-up this week”").
  3. "Search every property for “…”", which applies the existing view search.
  - Enter applies the highlighted suggestion as a chip. Backspace in an empty input selects the last chip, and a second Backspace removes it. Clicking a chip opens its editor (property, operator, value), built from the existing operand editors. "Advanced filter" at the bottom of the list opens the existing nested `FilterBuilder` for OR groups. Chips combine with AND. A saved filter that uses OR or nested groups shows as one chip, "Advanced filter, 3 conditions", which opens the builder.
- **COL-4 The phrase parser** is a pure TypeScript module (`web/src/lib/phraseFilter/`) that turns text plus the collection's properties into ranked filter candidates using existing operators only:
  - **Property names** match case- and punctuation-insensitively, as a run of whole words: "follow-up" matches "Next follow-up". Exact beats prefix beats partial.
  - **Operators by type:** is, is not, contains, doesn't contain, starts with, ends with; over, more than, above, at least, under, less than, below, at most (and `> >= < <=`) for numbers, currency, percent, duration and rating; before, after, on or before, on or after for dates; empty, not empty, "no Contact", "with Contact"; checked and unchecked for checkboxes; "me" and "mine" for people.
  - **Choice values** on their own ("proposal sent") match a select property when exactly one property has that choice. "A or B" becomes is any of.
  - **Dates:** today, tomorrow, yesterday, this week, next week, this month, next month, past or next N days, "Nov 14", "11/14", ISO dates. "This week", "next week" and "next month" use the new calendar operands in BE-7.
  - **Tests:** a table of at least 150 phrase-to-filter cases covering every operator, every property type, ranking ties, punctuation and empty input. Text it can't read yields only the search suggestion, never a wrong filter.

**Drafts and saving**

- **COL-5 Every change is a draft** (decision 4). Changes in View options, the filter bar, column resizing or reordering, and layout switches all write a per-device draft for that view.
  - While a draft exists, a TemporaryChangesBar shows under the filter bar: "Showing 3 of 12 clients. These changes are only for now." (it drops the count when the filter didn't change).
  - Buttons: **Reset**; **Update view**, for people who may configure this view when the layout type is the same (on the default view, editors and up, for layout settings only, per decision 4); and **Save as view**, for editors and up. Viewers and commenters see Reset only.
  - Save as view asks for a name, prefilled from the chips ("Proposal sent, follow-up this week"), and Only me or Everyone. Everyone needs the creator role, matching today's rules.
  - Drafts survive reloads. If the view changes on the server meanwhile, the bar adds "This view changed since you started" and keeps the draft.
  - Removed: the debounced auto-save in `useViewConfig.ts`, the "Not saved" and "Locked" toolbar badges, and the floating Add record pill.

**What goes into a draft.** Every `ViewConfig` key is one or the other:

| Setting | Draft or immediate | Notes |
| --- | --- | --- |
| Filter, sorts, groups | Draft | Sent as `TransientConfig`, as today |
| Row colors, summaries | Draft | Sent as `TransientConfig` so the server computes them (BE-12) |
| Hidden properties, order, widths, frozen columns, row height, wrapped headers | Draft | The layout settings; the only ones Update view saves on the default view |
| Description property, card properties | Draft |  |
| Layout type and the board, calendar, gallery, timeline and list settings | Draft | Switching layout shows the same records in the new layout. Saving a different layout always makes a new view. |
| Form settings and form fields | Immediate | A public form follows the live form, so form edits save as they're made, for people allowed to configure the view |

Drafts are keyed by person and view. On first load, the old `ob-view-local` and `ob-view-transient` entries move into the new drafts and are deleted.

**View options**

- **COL-6 One control.** A "View options" button (sliders icon) opens a 360 px popover anchored right on desktop, or a sheet on phone. Sections, in order:
  1. **Layout:** List, Grid, Board, Calendar, Gallery, Timeline and Form as a grid of tiles (4 columns on desktop, 3 on phone). The selected tile has a 2 px blue border on primary-soft. The chosen layout's own settings appear right under it: Board stacks by; Calendar date, end date and week start; Gallery cover and fit; Timeline start, end, swimlanes and dependencies; List prefix and sub-items; Form opens the form builder.
  2. **Sort**, **Group**, **Color** and **Properties**, as rows showing their current value ("Next follow-up, soonest", "None", "By status", "4 shown, 1 hidden"). Each opens a sub-screen inside the same popover or sheet, with a Back button, built from today's editors. Properties also holds the description property and card properties.
  3. **Row height** and **Wrap headers** (Grid only): Short, Medium, Tall, Extra tall. The grid's summary row and its menu stay as they are today, as drafts.
  4. **Footer:** Download CSV, Add property (creators), and layout toggles such as "Hide empty stacks" and "Fold all groups".
  - The old ViewBar toolbar, `toolbarFit.ts` and its More overflow are deleted.

**Layouts**

- **COL-7 Same behavior, new look.** Each layout keeps every feature it has today and adopts the Notebook tokens:
  - **Grid** (Glide canvas): the theme in `views/grid/glide/theme.ts` reads the tokens in both themes. The header row is 12 px 600 muted on `--bg`. The primary column is 600. Choice cells draw as StatusChips and links as LinkChips. Selection uses primary-soft. Medium rows (46 px) are the default for new views. The column menu keeps Rename, Edit property, Sort, Filter, Group, Hide, Insert left or right, Freeze and Delete.
  - **List:** cards like the phone mockup: title in 600, then up to three properties on one line (status chip, date, numbers right-aligned).
  - **Board:** 280 px stacks with the stack's value as a StatusChip and a count; cards match List; + at the foot of each stack.
  - **Calendar** (FullCalendar), **Gallery**, **Timeline:** tokens for every surface, line and event; covers get radius 12; the timeline's today line is the dashed accent.
  - **Form:** builder in the main area; the public page is in The rest of the app.
- **COL-8 Adding records.** The header button, a "+ New client" row at the end of Grid and List, + in Board stacks, and the header + icon button on phone. A new record opens as a page with its title focused (from Phase 5; until then, the current record view), except Grid's inline row, which stays inline.
- **COL-9 Empty and edge states.** No records: "No clients yet" with New client. Filtered to nothing: "No clients match these filters" with Reset. Selection keeps the existing bulk actions in a bar (desktop) or sheet (phone). On touch, a hold that then moves drags (where rows can be dragged); a hold released without moving opens the action sheet.

**Collection settings**

- **COL-10 One settings screen** (creators), opened from "…" beside the title: Name, Color, Description, Record name (singular, such as "client"), Title property (the primary field, which gets a UI for the first time), Page property (decision 2), Show on Home by (HOME-5) and Done property.

## Record as a page

A record reads top to bottom like a document: title, the properties that have values, then its page. It replaces the `ExpandedRecord` modal and the linked-record panel stack everywhere. Mockups: "Record as a page" and "Phone: record page".

- **REC-1 Frame.** On desktop the page fills `main`, under a 52 px bar holding the breadcrumb (folder › collection › record, links back), previous and next record buttons (the view's current order; Alt+Up and Alt+Down), presence avatars, Comments, History, Share (Web Share where available, otherwise copy link and a toast) and More (Duplicate, Copy link, Delete). The save status ("Saving…", "Saved", "Couldn't save") sits at the left of those buttons. On phone the 56 px header holds the back link ("Clients"), Comments, Share and More.
- **REC-2 Head.** Column of 760 px max, padded 40/32 px on desktop and 20/16 px on phone. A 44 px tile (40 on phone), radius 10, in the collection's pastel hue with the title's initials. If the collection has an attachment property whose first file on this record is an image, that image fills the tile instead. Then the title: the primary property as an `h1` (34/700, 26 on phone), edited in place. Enter moves focus to the page.
- **REC-3 Properties.** A PropertyList of the properties that have a value, in the order and visibility of the collection's default view, which today already sets every record's layout. The title and Page properties are left out.
  - Empty properties fold into one line, "Show 2 empty properties". Properties hidden from pages fold into another, "Show 1 hidden property", where **Show on pages** brings one back. Both are kept per device.
  - Values show as display text and turn into their existing editor (`FieldEditor`, form variant) on click or tap. They save on their own.
  - Computed values are read-only.
  - Creators can click a label for Rename, Edit property and Delete. Editors and up also get Hide from pages and Show on pages, which change the default view's layout and save at once: an explicit edit to the record layout, so not a draft.
- **REC-4 Add property here.** "+ Add property" (creators) opens an inline box with a Name input and a Value input. As the value is typed, a chip shows the guessed type (FLD-1): "Date · Guessed from “Nov 14”", next to Change type. Enter (or Add property) creates the property with that type, puts it at the end of the default view, and sets this record's value. Escape cancels. Editors, who can't create properties, don't see it.
- **REC-5 The page.** Below a 1 px rule, the Page property in the existing Tiptap editor, always editable for editors and up:
  - Text is 15/24 on desktop and 16/25 on phone, with no toolbar showing at rest.
  - Markdown shortcuts work while typing. Ctrl+K still adds a link while the page has focus; the command palette yields. A selection bubble offers bold, italic, strike, code and link.
  - `/` opens a block menu: Heading 1 to 3, Bulleted list, Numbered list, Checklist, Quote, Callout, Code block, Table, Divider, Image or file, Linked records, View, Property.
  - On phone, a formatting bar sits above the keyboard while editing.
  - It autosaves 800 ms after typing pauses, through the normal record save. The placeholder is "Type / to add a heading, a list, a view or a property".
  - Viewers see the rendered page through the existing Markdown renderer.
- **REC-6 Embeds.** Two embed blocks, inserted from the `/` menu:
  - **Linked records:** pick one of this record's link properties. It shows a small table: the linked collection's title plus its first three visible properties, a caption such as "Invoices · linked to this client, 2", and Open, which opens that collection with a draft filter on the inverse link. Rows open their pages. A "+ Link" row adds links (editors).
  - **View:** pick any saved view in this workspace. It shows the first 10 records (title plus three properties), read-only, with Open view. A reader who can't open that view sees "You can't open this view". Personal views can't be embedded.
  - **Storage:** a fenced code block with the info string `openbase` and a single JSON object, for example ```` ```openbase ```` then `{"embed":"linked","field":"fld…"}` or `{"embed":"view","view":"viw…","limit":10}`. Both the Tiptap node and `Markdown.tsx` read it, but embeds come alive only in a Page on a signed-in record page. Everywhere else (public share pages, forms, comments, emails, grid cells) they show a static "Embedded view" box and fetch nothing. Parsing is strict and ids are checked against their pattern. Rendering goes through React components, never raw HTML. A block that can't be read shows a muted "This embed can't be shown" box and keeps its text unchanged.
  - **For agents:** the syntax is documented in `docs/api.md` and in the MCP descriptions of rich text, so agents can write embeds. Search skips the JSON.
- **REC-7 Comments and history.** On desktop they open a 360 px SidePanel on the right, remembered per device. On phone each opens a full-screen sheet. The Comments button shows a count. The existing panels are restyled, not rebuilt.
- **REC-8 New and empty records.** A new record opens as its page with the title focused. Leaving a brand-new record with nothing entered discards it, using the existing discard endpoint.
- **REC-9 Moving around.** LinkChips open the linked record's page; back returns. On desktop, Escape returns to the collection the page was opened from. Signed-out deep links go through sign-in and come back.
- **REC-10 Roles.** Viewers see everything rendered with no edit affordances. Commenters can also comment. Editors edit values and the page. Creators also add and edit properties.

## Properties

All 28 field types stay, called properties in the interface. What changes is how they're made: from a value, with a guessed type you can correct.

- **FLD-1 Type guessing.** A pure module (`web/src/lib/guessType/`) takes a value and returns a type and its options. The first rule that matches wins:

| # | The value looks like | Guessed type | Example |
| --- | --- | --- | --- |
| 1 | Nothing | Text |  |
| 2 | yes, no, true, false, ✓, ✗ (one word) | Checkbox | yes |
| 3 | An email address | Email | dana@harperco.example |
| 4 | A web address (scheme, `www.`, or domain plus path) | URL | harperco.example/book |
| 5 | 7 to 15 digits with +, spaces, dashes or brackets | Phone | +1 870 555 0100 |
| 6 | A number with $, €, £ or ¥ | Currency (that symbol) | $600 |
| 7 | A number with % | Percent | 15% |
| 8 | h:mm, "2h 30m", "45 min" | Duration | 1:30 |
| 9 | A date phrase with a time (the HOME-4 parser) | Date, time on | Nov 14 9am |
| 10 | A date phrase | Date | Nov 14 |
| 11 | A plain number, commas allowed | Number (decimals kept) | 1,250.5 |
| 12 | Stars | Rating | ★★★ |
| 13 | Several lines | Text, multiline |  |
| 14 | Anything else | Text | Harper |

- It never guesses links or choices; Change type offers them. Tests pin the edges: "2024" is a Number, "11/14" is a Date, "1,000" is a Number, "+1 870 555 0100" is a Phone.
- It's used by the record page's Add property (REC-4), and the capture box's Property chip, so the two agree. CSV import keeps the server's guesser (APP-11).
- **FLD-2 Editing a property.** The existing `FieldDialog`, restyled: a dialog on desktop and a sheet on phone. Name, description, then a type picker in today's groups, each type with a one-line plain description. The type-change warning stays and says how many values will be cleared, using the server's existing rules (computed and link conversions clear values).
- **FLD-3 Title property.** "Use as title" in a property's menu and in collection settings calls the existing `POST /api/tables/{id}/primary-field`. Types that can't be primary are disabled with the reason.
- **FLD-4 Page property.** "Use as page" on rich text properties. Deleting or retyping the page property clears the pointer (decision 2). Nothing is refused, so existing delete and update calls behave exactly as today.
- **FLD-5 Links and computed types.** Link, lookup, rollup, count and formula keep their editors, restyled. The link target picker lists only collections in the same folder, with the note "Collections in other folders can't be linked" (decision 1). The formula editor keeps its `{Property}` autocomplete and live check.
- **FLD-6 Choices.** Select choices keep their pastel chip colors and editor. New choices take the next palette color, as today.

## The rest of the app

Every remaining screen moves to Notebook in this effort, with no behavior lost. "Restyled" means built from the core components and tokens, with the same features and the same API calls.

**Getting in**

- **APP-1 Sign-in pages** (setup, login, 2FA, signup, invite, forgot and reset password). The existing `AuthLayout` restyled: a 400 px card centered on `--bg`, the OpenBase lockup above it, 44 px inputs, a full-width primary button, and passkey sign-in as a secondary button. Invite and signup pages show the workspace by its color mark. No logic changes.
- **APP-2 First run.** With no workspace: name and color, then Create. That makes the workspace and its top-level project, then lands on Home.
- **APP-3 Intro.** The five intro steps are rewritten for the new model: Home and capture; collections and record pages; views and drafts ("changes are just for you until you save"); workspaces and folders; connecting an assistant (optional). The art is redrawn to the new layout with color marks. Replay stays in the profile menu, and reduced motion is honored.

**Working**

- **APP-4 Notifications.** The desktop popover from the sidebar row, and a full screen on phone. Rows show the avatar, one sentence, a LinkChip to the record and the time; "Mark all read" at the top.
- **APP-5 Automations.** A workspace list grouped by folder (`/workspace/:id/automations`), then the existing editor: list and editor side by side on desktop, one at a time on phone. Triggers, actions, `{{…}}` templates, Test and Runs are all kept and restyled. Reached from the sidebar row and each folder's menu.
- **APP-6 Forms.** The builder lives in the Form layout (COL-6). The public form page uses a 640 px column with the collection's color mark and the form title, 44 px fields stacked with labels, and a full-width submit button on phone. Password prompt, prefill, uploads and the success or redirect behavior are kept.
- **APP-7 Public share pages.** The shared view is drawn by the same layout components in read-only mode, under a header with the view's name and a small OpenBase footer mark.
- **APP-8 Sharing.** `ShareDialog` as a dialog on desktop and a sheet on phone, with two parts: Invite people, and Share a view (each link with enable, password, copy and delete). The password minimum follows SEC-4.
- **APP-9 History.** `HistoryPage` and `ActivityCard` restyled. Filters (workspace, folder, collection, person, kind) appear as FilterChips in a bar like the collection filter bar, without phrase parsing.
- **APP-10 Trash.** Kind chips: All, Records, Properties, Collections, Folders, Workspaces. Each item shows its color mark, who deleted it, the days left before it's purged, and Restore.
- **APP-11 CSV.** Import and export dialogs restyled. Column types keep coming from the server's `infer_kind` (`store/csv_io.rs`), which MCP `import_csv` also uses. One shared table of example values is tested against both `infer_kind` and FLD-1, so they agree wherever both apply.

**Settings**

- **APP-12 Workspace settings.** Name, color (no icon), the top-level chooser for owners (shows the current top-level project and offers "Use as top level" for each folder), and Delete workspace. The delete confirmation names the workspace and says it moves to the trash for the retention period.
- **APP-13 Members and access.** `MembersPage` restyled. Per-project access becomes "Folder access", listing Top level and each folder by mark. Roles and invites are unchanged.
- **APP-14 Account.** Profile (name, time zone, and a new week start for "this week" filters, BE-7), Security (password, passkeys, 2FA), Sessions, API tokens (Read, Read and write, or Full access; see AGT-5), AI assistants and connected apps (with Change access, AGT-2). Appearance (theme and accent) stays in the profile menu, its one home.
- **APP-15 Admin.** Users, Email, Connected apps, Audit, Stats and Backups restyled, with tables built from the shared table styles.

**Everywhere**

- **APP-16 Confirmations.** `ConfirmDialog` becomes a Dialog on desktop and a sheet on phone. A destructive confirmation names the thing and says whether it can be restored ("Moves to the trash for 30 days").
- **APP-17 Errors.** Not found and error screens use EmptyState with "Go to Home". Error messages say what happened and what to do, in one sentence each.

## Phone and accessibility

The phone layout covers every feature, and the whole app meets WCAG 2.2 AA in both themes. These rules apply to each screen in the phase that builds it; Phase 7 runs the full sweep. The compact layout keeps today's breakpoint: below 1024 px (`--breakpoint-md: 64rem`, in step with `DESKTOP_QUERY` in `AppShell.tsx`).

**Phone**

- **PH-1 Bottom navigation.** A 64 px bar with three tabs: Home, Collections and Notifications. 22 px icons and 12 px labels; the current tab is blue at 600. It sits above the home indicator (`env(safe-area-inset-bottom)`). It hides on record pages and in full-screen editors.
- **PH-2 Header.** 56 px. The left side holds the workspace switcher on Home, or a back link naming the parent screen ("Clients", "Consulting"). The right side holds up to three 44 px icon buttons. Anything more goes in a More menu.
- **PH-3 Sheets, not popovers.** On phone, View options, pickers (Goes to, property type, choice values, dates, linked records), record actions and filter suggestions open as bottom sheets (Sheet component). Dialogs become full-screen sheets.
- **PH-4 Record pages are screens.** A record opens as a full screen, never a modal. Back returns to the list at the same scroll position.
- **PH-5 Keyboard-aware.** While typing in the capture box or any sheet, the primary action stays visible above the on-screen keyboard (use the existing `useVisualViewport` hook).
- **PH-6 Touch.** Every tappable target is at least 44 × 44 px, including checkboxes (wrap the input in a 44 px label). Long-press opens a row's action sheet. Hold-to-drag keeps working for reordering.
- **PH-7 No horizontal page scroll.** Only tables, boards and timelines scroll sideways, inside their own box.

**Accessibility**

- **A11Y-1 Keyboard.** Every action works from the keyboard in a logical Tab order. Escape closes the top popover, sheet or dialog and returns focus to the control that opened it. Shortcuts: Ctrl K or Cmd K for the command palette, `/` to focus the filter bar, Alt+Up and Alt+Down for the previous and next record (kept from today), Enter to add from the capture box.
- **A11Y-2 Focus.** A visible 2 px `--ring` outline, offset 2 px, on every focusable element. Never remove it without a replacement.
- **A11Y-3 Semantics.** Real `button`, `a`, `input` and `label` elements. Landmarks: `nav` for the sidebar and bottom bar, `main` for content. One `h1` per screen. Lists are lists. Tables have header cells with `scope`.
- **A11Y-4 Announcements.** Save state ("Saving", "Saved", "Couldn't save"), filter results ("Showing 3 of 12") and toasts go through polite live regions.
- **A11Y-5 Color is never the only cue.** Marks sit beside names. Overdue dates are red and also say the date in words. Selected states also change weight or add a check.
- **A11Y-6 Sizing.** Text zooms to 200% without losing content. Desktop targets are at least 24 × 24 px. Reduced motion is honored (see Motion).
- **A11Y-7 Automated check.** Playwright runs axe-core on every screen in the migration ledger, in light and dark, at 1440 px and 390 px. Zero serious or critical violations is the bar.

## Agent access

An agent with full access can create and delete workspaces and folders, and every such delete can be undone from the trash. The MCP tools already exist (`create_workspace`, `delete_workspace`, `create_project`, `duplicate_project`, `delete_project`, `restore_from_trash`), gated by the manage permission. The gaps are in granting that access and in the new top level. The server parts land in Phase 2; the consent, account and token screens in Phase 6.

- **AGT-1 What full access means.** An API token with write and manage, or an OAuth grant at Full control (`openbase:manage`), acting for a person. Creating a workspace needs only full access. Deleting a workspace or folder also needs that person to be the workspace owner. Creating a folder needs the creator role. These are today's rules, unchanged.
- **AGT-2 Granting it.** Today the OAuth consent screen offers Full control only when the app asked for it, and many assistants don't ask. Changes:
  - Consent always offers Read, Read and write, and Full control. The default is what the app asked for. Choosing more than that shows: "This app asked for less. Give it full control anyway?" The token response reports the scope actually granted, which OAuth allows.
  - Account → AI assistants lists each connected app with its access and a **Change access** control. Upgrading or downgrading applies to the grant and its live tokens from their next request, with no reconnect.
  - Apps limited to some folders still can't manage, as today.
- **AGT-3 The top level, for agents.** `create_workspace` creates the workspace and its top-level project together and returns both ids. `list_projects` returns `is_top_level`. A new tool, `set_top_level_project` (manage, owner), moves the pointer. `delete_project` on the top-level project is refused with a message naming the fix: make another folder the top level first, or delete the workspace. Project tool descriptions say that a project appears as a folder in the app.
- **AGT-4 Always recoverable.** No MCP tool or token can permanently delete a workspace or folder: only the retention purge does that. `delete_workspace` and `delete_project` results state what moved to the trash, how to restore it (`restore_from_trash` with kind and id) and the date it will be purged. The progress file lists every destructive MCP tool and whether it's recoverable. Today comments, share links, automations and inbox drafts are deleted for good; their descriptions gain "This can't be undone".
- **AGT-5 Tokens in the UI.** Creating an API token offers Read, Read and write, or Full access, with one plain sentence on what each allows.
- **AGT-6 Tests.** Contract tests cover: a full-access token creates a workspace (and gets its top level), creates a folder, deletes the folder, restores it, deletes the workspace and restores it; a token without manage gets an error naming the missing permission; an OAuth grant upgraded with Change access can then delete; deleting the top-level project is refused.

## Backend and API

The server changes are small and additive: one migration, a few settings, two endpoints, an event stream and two filter operands. Existing responses keep their shape.

- **BE-1 Migration** (`crates/server/migrations/0016_*.sql`, plus an `after_migration` data fix in `db.rs`; the server already snapshots the database first):
  - `workspaces.root_base_id`, set to each workspace's first live project by position (decision 1, with its tie-break and the no-project case).
  - `tables.color`, filled by cycling blue, orange, green, purple, yellow, pink, teal, red, cyan, gray in table order within each project.
  - `tables.body_field_id`, set or created as decision 2 says. A created "Page" property is hidden in every view of its table.
  - `tables.home_date_field_id` and `tables.done_field_id`, preset by HOME-5's name rules.
  - `tables.record_noun` (COL-1), empty.
  - `users.week_start` (0 = Sunday, 1 = Monday), defaulting to Sunday.
  - Tested against a v15 fixture database (built by a committed helper that runs migrations 0001 to 0015 on a fresh database, then seeds it) that has several projects per workspace, tables with zero, one and two rich text fields, "Page" and "Page 2" name collisions, a table at the 500-field limit, a workspace with no live project, and trashed tables. The test asserts that no cell value changes.
- **BE-2 Colors in the API.** REST create and update for tables accept and return `color` (checked by `validate_color`). The MCP `create_table` tool and the table settings tool take it too. `icon` stays accepted and returned everywhere.
- **BE-3 Home endpoint.** `GET /api/workspaces/{id}/home` returns `due` (record, table and project ids, title, date, whether it has a time, whether the collection has a Done property, overdue), `recent` (distinct records from `record_history`, newest first, with author and time) and `drafts` (the caller's inbox drafts, which belong to no workspace).
  - It reads only projects the caller can open (`perm::require_base`) and only tables with a Home date. It compares dates in the caller's time zone, using `core/src/query/dates.rs`.
  - It has a scan budget like search's (100,000 records), returns at most 50 due items with `truncated: true` when the budget ran out, and meets HOME-11. A Home date may be a computed date property: it shows in Due soon but gets no capture chip.
  - MCP gets a read tool, `get_home`.
- **BE-4 Richer listings.** Table listings add `record_count` (one grouped count per project, not one query per table), `color`, `body_field_id`, `home_date_field_id`, `done_field_id` and `record_noun`. Workspaces add `root_base_id`; projects add `is_top_level`.
- **BE-5 Setters and guards.**
  - New endpoints: `POST /api/tables/{id}/body-field` (shaped like `primary-field`), table PATCH for color, description, record name, Home date and Done (each checked: the field belongs to the table, a Home date is date-like, Done is a checkbox, the body is rich text), and `POST /api/workspaces/{id}/top-level` (owners).
  - New MCP tools: `set_page_field`, `update_table_settings` and `set_top_level_project` (AGT-3).
  - Guards in `store/fields.rs`: deleting or retyping the body field clears it, and so does deleting a Home date or Done field. The store also refuses to delete the top-level project (decision 1).
  - Table and project duplication remap the new ids, and trash restore keeps them. About 20 files touch `primary_field_id` today; follow that list, except `v1/*` and `core/api/v1.rs`, because the v1 API doesn't change.
- **BE-6 History stops flooding.** Page text autosaves often, and `record_history` stores the full old and new text each time. For `text` and `rich_text` fields: when the record's latest history row is an update by the same person, less than 10 minutes old, that changed only this same field, that row is updated instead of a new one added: the first `old` is kept, `new` is replaced, and its time moves to now. Tests cover the window edge and edits by two people taking turns.
- **BE-7 Calendar weeks.** New relative date operands for `is_within`: `this_calendar_week`, `next_calendar_week`, `last_calendar_week`, `next_calendar_month` and `last_calendar_month`. The week start comes from the request if it names one, else the acting person's `week_start`, else Sunday; automations act as their creator. `week_start` is set through the existing profile endpoint behind `api.auth.updateMe`, which `api_request` reaches. Regenerate the TypeScript types (`scripts/gen-types.sh`) and document them for MCP filters.
- **BE-8 Embeds on the server.** Search ignores ```` ```openbase ```` blocks. The rich text descriptions in `docs/api.md` and `docs/mcp.md` document the embed syntax (REC-6).
- **BE-9 One stream for Home.** Live updates today are one SSE stream per project, and a browser allows about six HTTP/1.1 connections per site, so Home can't open one per folder. Add `GET /api/workspaces/{id}/events`, which relays the events of every project the caller can open. It never counts toward presence, and it starts relaying projects created or granted after it opened. Each tab holds one stream: Home and the Collections tab use the workspace stream, while collection and record screens use their project stream, which presence depends on. The sidebar refreshes other projects' counts when the window regains focus and every 60 seconds.
- **BE-10 Compatibility.**
  - v1 (Airtable-compatible) responses are unchanged; the new Page properties appear like any other field.
  - MCP tool names, parameters and results only gain things.
  - Every new route is catalogued (the test `every_registered_route_is_catalogued` enforces this) and has a contract test in `web/contract`.
  - `docs/api.md`, `docs/mcp.md` and the generated types are current.
- **BE-11 Small fixes found while surveying.** The MCP `create_view` description says viewers can make personal views, but the store requires editor: fix the text. Fix the stale "never stored" comment in `core/src/field.rs`. Remove the unused `invite` notification kind.

* **BE-12 Drafts the server computes.** `TransientConfig` gains optional `row_color` and `summaries`, so drafted row colors and summaries are computed like saved ones. Both are additive request fields.

## Build plan

Nine phases, run in order on the `ux-overhaul` branch. Each ends at a gate, and nothing merges until the final audit passes.

| Phase | Work | Requirements | Gate (exit criteria) |
| --- | --- | --- | --- |
| 0 · Security first | Update dependencies, add scans, harden the server | SEC-1 to SEC-5 | Scans clean, every check green |
| 1 · Foundation | Tokens, core components and the design page | DL-1 to DL-4 | Design page complete in both themes |
| 2 · Backend | Migration, endpoints, workspace stream, agent access | BE-1 to BE-12, AGT-1 to AGT-6 | Migration and contract tests green |
| 3 · Shell | Sidebar, phone tabs, routes, command palette | NAV-1 to NAV-10, PH-1, PH-2 | Every route opens in the new shell |
| 4 · Collections | Rule modules, filter bar, drafts, View options, layouts | COL-1 to COL-10, HOME-4 and FLD-1 rules | Old view toolbar deleted |
| 5 · Records | Record pages, properties, the page, embeds | REC-1 to REC-10, FLD-2 to FLD-6 | Record modal deleted |
| 6 · Home and the rest | Home, then every remaining screen | HOME-1 to HOME-11, APP-1 to APP-17 | Ledger shows every screen moved |
| 7 · Finish | Interaction tests, accessibility, screenshots, cleanup | Full A11Y-7 sweep, interaction targets | Definition of done all ticked |
| 8 · Final audit | A fresh security audit of the whole branch | Final security audit | No critical or high finding open; pull request ready to merge into main |

Phases 1 and 2 don't depend on each other, so they may run in parallel in separate worktrees, merged into `ux-overhaul` before Phase 3 starts. From Phase 3 on, each phase builds on the last. The three rule modules (HOME-4, COL-4, FLD-1) are built at the start of Phase 4, once Phase 2's new operands exist.

**The check suite.** "Checks green" means all of these pass. Extend `scripts/check.sh` so that `OPENBASE_E2E=1 scripts/check.sh` runs every one, keeping `npm run build` before `cargo test` (the server embeds the web build):

- `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- `cargo deny check` and `npm audit --audit-level=high` (new, SEC-3)
- In `web/`: `npm run typecheck`, `npm test -- --run`, `npm run test:contract`, `OPENBASE_E2E=1 npm run e2e`
- `scripts/gen-types.sh --check`, `scripts/gen-icons.sh --check`, `scripts/gen-brand.sh --check`
- The token check (DL-1) and the removed-code check (DONE-3), both new

**Inside a phase.**

- Work in requirement order. After each requirement, run the fast checks for what you touched (typecheck, the affected unit tests, `cargo test` for server changes).
- Run the full suite before calling the phase done.
- The token check starts in Phase 1 with an allowlist of files not yet moved. Each phase removes its files from the list, and the list must be empty at Phase 7.
- Every gate also needs the phase's screens in the ledger marked done, with screenshots attached in the progress file. Until a later phase rebuilds it, a route keeps showing its current screen inside the new shell.

## Definition of done

The overhaul is done when every box below is ticked in the progress file, each with its evidence (a test name, a screenshot path, a command's output or a commit). Until then it is not done, whatever state the branch is in.

- [ ] **DONE-1 Requirements.** Every requirement id in this spec is marked done, with evidence.
- [ ] **DONE-2 Ledger.** Every screen in the ledger is marked moved, with screenshots in light and dark at 1440 px and 390 px.
- [ ] **DONE-3 Old code is gone.** A new `scripts/check-removed.sh` fails while any of these (or code doing their job) remains: the `ExpandedRecord` modal and `RecordPanel` stack, the `ViewBar` toolbar with `toolbarFit.ts` and `FloatingAdd`, the debounced view auto-save, the icon pickers (`IconPicker`, `IconPickerDialog`, the lazy full icon set and `popular.ts`), entity icon rendering (`EntityIcon`, `TableIcon` and icon fallbacks in `EntityTile`), the Inbox page route, the phone `SidebarDrawer` and the sticky app top bar. It also fails if a release build contains the `/__dev/design` route.
- [ ] **DONE-4 Tokens only.** The token check (DL-1) passes with an empty temporary list.
- [ ] **DONE-5 Interaction targets.** A Playwright test for each row of the targets table passes at desktop and phone sizes.
- [ ] **DONE-6 Accessibility.** axe finds no serious or critical issues on any ledger screen (A11Y-7), and keyboard-only tests cover capture, filtering, saving a view and editing a record.
- [ ] **DONE-7 No data lost.** The migration test passes. An upgrade of the v15 fixture database keeps every record count and a checksum of every pre-existing cell value identical.
- [ ] **DONE-8 Compatible.** Contract tests pass, and a golden test shows v1 API responses for the fixture unchanged apart from the new Page properties.
- [ ] **DONE-9 Docs.** `README.md`, `web/README.md`, `docs/api.md`, `docs/mcp.md` and `docs/security.md` use the new terms and describe the new endpoints. `CHANGELOG.md` lists the visible changes, the one-time sign-out from the cookie rename, and the migration.
- [ ] **DONE-10 Speed.** Home meets HOME-11. Opening a collection on the 50,000-record fixture is no more than 10% slower than on `main`: the median of 5 Playwright runs from navigation to the first rows painted, branch against `main` on the same machine. The JavaScript the first screen loads (the entry chunk plus everything it imports eagerly) is no larger than on `main`.
- [ ] **DONE-11 Clean run.** `OPENBASE_E2E=1 scripts/check.sh` passes on a fresh checkout of the branch, and CI (with the scans) is green on the pull request.
- [ ] **DONE-12 Audit.** The final security audit below passes.

### Final security audit (Phase 8)

The code's author shouldn't grade its own security, so the audit runs in a fresh agent session that didn't write the code. If the Claude Security plugin is installed, use its full scan on the branch. Otherwise, follow this list by hand.

1. **Scans again:** `cargo deny check`, `npm audit --audit-level=high`, gitleaks and Trivy on the built image.
2. **Every new or changed endpoint:** authorization, input checks and errors for the Home endpoint, top-level, body-field and table settings, and the workspace event stream. The stream must only relay projects the caller can open, and must stop relaying a project when access is removed.
3. **Agent access:** Change access can't grant more than the person's own role, needs CSRF protection and writes an audit log entry. Granting more than an app asked for happens only by the person's explicit choice. Deletes need the owner role, stay recoverable, and no token can reach the purge.
4. **Embeds:** no HTML or script injection through the JSON. A view embed shows nothing to a reader who can't open that view. Ids from other workspaces are refused.
5. **Client state:** drafts in localStorage hold no secrets or tokens. The phrase parser and type guesser never evaluate input.
6. **Regression of Phase 0:** every SEC-4 fix still holds.
7. **Rate:** each finding gets Critical, High, Medium or Low with a one-line reason.

**The bar:** zero critical and zero high findings open. Mediums are fixed, or recorded in `docs/security.md` with the reason. The audit writes `docs/plans/2026-11-07-ux-overhaul-security-audit.md` (findings table, fixes with commits, re-test evidence). After any fix, the check suite runs again and the affected areas are re-audited.

**Hand-off.** When everything above passes, open a pull request from `ux-overhaul` to `main` with a summary, screenshots, the progress file and the audit report. Merge it only if the session was told it may; otherwise leave it ready for review.

## Appendix: screen ledger

These 45 screens and surfaces make up the whole app. Copy this table into the progress file, add a Status column, and mark each row moved only with light and dark screenshots at 1440 px and 390 px (DONE-2).

| # | Screen or surface | Where | Requirements | Phase |
| --- | --- | --- | --- | --- |
| 1 | Design reference | `/__dev/design` | DL-1 to DL-4 | 1 |
| 2 | Desktop sidebar and workspace switcher | every signed-in screen | NAV-1 to NAV-6 | 3 |
| 3 | Phone bottom bar and Collections tab | `/workspace/:id/collections` | NAV-7, NAV-8, PH-1, PH-2 | 3 |
| 4 | Command palette | Ctrl K or Cmd K | NAV-9 | 3 |
| 5 | Collection header, tabs, filter bar, drafts bar | `/base/:baseId/:tableId/:viewId?` | COL-1 to COL-5 | 4 |
| 6 | View options and its sub-screens | collection | COL-6 | 4 |
| 7 | Save as view | collection | COL-5 | 4 |
| 8 | Grid layout | collection | COL-7 | 4 |
| 9 | List layout | collection | COL-7 | 4 |
| 10 | Board layout | collection | COL-7 | 4 |
| 11 | Calendar layout and unscheduled list | collection | COL-7 | 4 |
| 12 | Gallery layout | collection | COL-7 | 4 |
| 13 | Timeline layout | collection | COL-7 | 4 |
| 14 | Form builder | collection, Form layout | COL-6 | 4 |
| 15 | Collection settings | collection "…" | COL-10 | 4 |
| 16 | Bulk selection bar and sheet | collection | COL-9 | 4 |
| 17 | Empty and filtered-empty states | collection | COL-9 | 4 |
| 18 | Record page | `/base/:baseId/:tableId/:viewId/r/:recordId` | REC-1 to REC-6, REC-8 to REC-10 | 5 |
| 19 | Comments and history panels | record page | REC-7 | 5 |
| 20 | Page embeds (linked records, view) | record page | REC-6 | 5 |
| 21 | Property editor, choices and formula | record page, grid header | FLD-2 to FLD-6 | 5 |
| 22 | Link picker and linked record peek | record page, grid | FLD-5, REC-9 | 5 |
| 23 | Home | `/workspace/:id` | HOME-1 to HOME-11 | 6 |
| 24 | Sign in | `/login` | APP-1 | 6 |
| 25 | Two-factor sign-in | `/login/2fa` | APP-1 | 6 |
| 26 | First admin setup | `/setup` | APP-1 | 6 |
| 27 | Sign up and invite | `/signup`, `/invite/:token` | APP-1 | 6 |
| 28 | Forgot and reset password | `/forgot-password`, `/reset-password` | APP-1 | 6 |
| 29 | First run | `/` with no workspace | APP-2 | 6 |
| 30 | Intro | over any screen | APP-3 | 6 |
| 31 | Notifications | sidebar popover, `/notifications` | APP-4 | 6 |
| 32 | Automations list and editor | `/workspace/:id/automations`, `/base/:baseId/automations/…` | APP-5 | 6 |
| 33 | Public form | `/form/:token`, `/f/:token` | APP-6 | 6 |
| 34 | Public shared view | `/share/:token`, `/s/:token` | APP-7 | 6 |
| 35 | Share dialog and view links | collection header, folder menu | APP-8 | 6 |
| 36 | History | `/history` | APP-9 | 6 |
| 37 | Trash | `/trash` | APP-10 | 6 |
| 38 | CSV import, export, new collection from CSV | collection and folder menus | APP-11 | 6 |
| 39 | Workspace settings | `/workspace/:id/settings` | APP-12 | 6 |
| 40 | Members, folder access, invites | `/workspace/:id/members` | APP-13 | 6 |
| 41 | Account, OAuth consent | `/account?tab=…`, `/oauth/consent` | APP-14, AGT-2, AGT-5 | 6 |
| 42 | Admin | `/admin?tab=…` | APP-15 | 6 |
| 43 | Empty folder | /base/:baseId | Navigation routes | 3 |
| 44 | File preview | record pages, grid, comments | REC-3 | 5 |
| 45 | Not found and error screens | everywhere | APP-16, APP-17 | 6 |
