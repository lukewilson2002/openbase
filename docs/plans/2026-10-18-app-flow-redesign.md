# App Flow Redesign Plan
**Goal:** Make OpenBase feel linear and easy on a phone: one sidebar that holds the whole tree, projects instead of bases, a WYSIWYG long-text editor, honest presence, and an Inbox for quick capture.
**Approach:** Three waves. Wave 1 runs three independent pieces at once (navigation shell, record editor, server work). Wave 2 builds on them (polish + presence UI + touch fixes, and the Inbox page). Wave 3 renames "base" to "project" across the UI and docs in one sweep, then verifies everything on a phone-sized browser.
**Stack:** Rust (axum, rusqlite, ts-rs), React 19 + TypeScript + Tailwind v4 + Radix + TanStack Query, Tiptap 3 (new, lazy-loaded).
**Spec:** the owner's screen recording of 2026-10-18 (summarised under "Agreed behaviour").

## Agreed behaviour

1. **Projects.** Everything people read says *project* where it said *base* (Bases → Projects, New base → New project, "Who can open this base" → "…this project", the intro, empty states, toasts, docs). MCP tools get project names (`list_projects`, `create_project`, `rename_project`, `delete_project`, `duplicate_project`, `get_project_schema`; `project_id` accepted wherever `base_id` is) and tool descriptions say project; the old names and `base_id` keep working as unlisted aliases. REST routes (`/api/bases/...`), the v1 API, DB tables and `bas…` ids do not change. *This reverses the 2026-10-14 decision "terms stay".*
2. **One sidebar everywhere.** Every signed-in page shows the same tree: Inbox, Notifications, then Workspaces → projects → tables → views. Workspaces and projects expand and collapse (remembered per device); a project's tables load when it is expanded. Tapping a table opens the **last view used in that table** on this device (else its first view); its chevron shows the views. Tapping a project opens its last table and view. An expanded project also lists Automations (creators). Each row has a "…" menu with what the old pickers, workspace page and sidebar footer offered: workspace → New project, Import a spreadsheet, Members, Trash, Settings (owner), Rename, Icon, Color; project → Rename, Icon, Color, Share, Members, Trash, Automations, Delete; tables and views keep their current menus. "+ New workspace" stays at the Workspaces heading. Global Trash stays above the profile.
3. **No more pickers.** The split dropdowns ("Workspaces | Bases in X", "Tables | Views of X") and the desktop `Workspace ⌄ / Base ⌄` pickers go. The top bar shows the project's tile and name as plain text (phone: workspace small above project name; tapping it opens the drawer). The workspace home page (`/workspace/:id`) goes: that URL redirects to the workspace's last-opened project, or opens the drawer on that workspace when it has none.
4. **View switcher icons.** The view toolbar shows the table's name, then one icon button per view of that table (its type icon; the active one highlighted; name in the tooltip and accessible name; personal/locked markers kept). Too many to fit → the rest in a "…" overflow. A trailing "+" adds a view (who may). The view's name is not shown as text.
5. **Profile menu icons.** Every item in the profile menu has an icon (Settings, Connect an assistant, Replay the intro, Appearance, Administration, Sign out).
6. **Presence like Google Drive.** The top bar's faces are the people **viewing this project right now** (you included). Members who can open it but are not viewing are one grey "+N" chip. Tapping the faces still opens Members. "Only you" with the lock stays when nobody else can open it.
7. **Colors.** New workspace and new project dialogs have a color picker; the "…" menu's Color item (and workspace Settings page) changes it later. MCP `create_workspace`/`rename_workspace` take `color` like the project tools.
8. **Touch and scrolling (iOS Safari).** A swipe that starts on a menu trigger, button or row scrolls and never opens anything; menus open on a tap (pointer up without movement). Fix it once in `ui/dropdown-menu.tsx`, popover, select and every other trigger, not per screen. In the expanded record, dragging the Comments/History header does not scroll a nested panel on its own: one scroll container on phones.
9. **Expanded record.** On a phone it is full screen (no margin, no radius, safe-area padding). The header's link icon becomes a Share icon (Web Share API where available, else copy link + toast). Saving stays automatic, and the header shows "Saving…" / "Saved" / "Couldn't save" for the record.
10. **Rich long text.** Long text fields with `rich: true` are edited in a Tiptap WYSIWYG editor that stores Markdown (no Write/Preview tabs). Toolbar: text style (paragraph, H1–H6), bold, italic, strikethrough, inline code, link, bulleted / numbered / task list, indent / outdent, quote, callout (GitHub alert syntax `> [!NOTE]`, `[!TIP]`, `[!WARNING]`…), code block, table (add/remove rows and columns visually), horizontal rule. Numbered lists keep their start number (`5.` continues 6, 7…). Markdown shortcuts work while typing. An expand button sits at the bottom-right of the box and opens the same editor full screen; closing returns to the record. The Markdown renderer used elsewhere (`Markdown.tsx`) renders callouts and tables the same way. Plain (non-rich) long text keeps its textarea, and also gets the bottom-right expand button.
11. **Inbox for quick capture.** `/` is the Inbox: a big "Write something…" rich-text box like an AI chat home, with Attach files, and a "Save to…" picker (project, then table). With no target, what you type autosaves as an **inbox draft** (yours only), listed below the box. Picking a table turns the box into that table's form: the primary field as a title at the top, then the table's other editable fields, with the note body going into the first rich long-text field (the person can change which). "Save" creates the record and removes the draft. The old Inbox (notifications) is renamed **Notifications** and stays below Inbox in the sidebar.

## Decisions taken while planning

- Last view per table / last table per project / last project per workspace: localStorage `ob-last-place` (`{ tables: {tableId: viewId}, projects: {baseId: tableId}, workspaces: {wsId: baseId} }`), written by `BaseShell` whenever it renders a view. Per device, like the sidebar width.
- Presence is in-memory on the server (no DB): the per-project SSE stream (`GET /api/bases/{id}/events`) counts open streams per user; opening or closing one broadcasts `presence_changed { viewers: [user_id] }` on that project's bus. `GET /api/bases/{id}/presence` returns the current list (catalogued for MCP parity). Several tabs of one person count once.
- Inbox drafts are a new table `inbox_items (id TEXT PK 'inb…', user_id, body TEXT markdown, attachments JSON, created_at, updated_at)`. Only their owner sees them; they are not in any workspace. Filing reuses record creation and moves the attachments into the target attachment field.
- Tiptap with `@tiptap/markdown` (official, v3). Exact versions pinned, at least two weeks old; loaded with a dynamic `import()` so the shell's bundle does not grow. README "Dependencies" paragraph updated.
- The callout syntax is GitHub's alert syntax, so a value stays readable as plain Markdown and on GitHub.

## Interfaces

Rust (`crates/core/src/api`, exported with ts-rs; run `scripts/gen-types.sh`):

```rust
// events
pub enum BaseEvent { /* existing */ PresenceChanged { viewers: Vec<String> } }   // serde tag "presence_changed"
pub struct Presence { pub viewers: Vec<String> }                                  // GET /api/bases/{id}/presence

// inbox
pub struct InboxItem { pub id: String, pub body: String, pub attachments: Vec<Attachment>, pub created_at: String, pub updated_at: String }
pub struct CreateInboxItem { pub body: String, pub attachments: Option<Vec<Attachment>> }
pub struct UpdateInboxItem { pub body: Option<String>, pub attachments: Option<Vec<Attachment>> }
pub struct FileInboxItem { pub table_id: String, pub fields: serde_json::Map<String, Value> }   // -> the created Record
```

REST: `GET/POST /api/inbox`, `PATCH/DELETE /api/inbox/{id}`, `POST /api/inbox/{id}/file`, `GET /api/bases/{id}/presence`.
MCP: `list_inbox`, `add_to_inbox`, `update_inbox_item`, `file_inbox_item`, `delete_inbox_item`; project-named aliases as in behaviour 1; `color` on workspace tools.

Web:

```ts
// web/src/lib/lastPlace.ts
export function rememberPlace(p: { workspaceId: string; baseId: string; tableId: string; viewId: string }): void;
export function lastViewOf(tableId: string): string | undefined;
export function lastTableOf(baseId: string): string | undefined;
export function lastBaseOf(workspaceId: string): string | undefined;

// web/src/components/richtext/RichTextEditor.tsx (lazy chunk)
export function RichTextEditor(props: { value: string; onChange(md: string): void; onBlur?(): void; autoFocus?: boolean; fullScreen?: boolean; placeholder?: string; "aria-label"?: string }): JSX.Element;
```

## Tasks

### Wave 1 (parallel; separate worktrees)

**1. Navigation shell (web).** Behaviour 2, 3, 4 and the last-place memory.
- Files: `web/src/shell/{AppShell,HomeShell,Sidebar}.tsx`, new `web/src/shell/NavTree.tsx`, `web/src/base/{BaseShell,BaseSidebar,BaseTopBar}.tsx`, `web/src/components/viewbar/ViewSwitcher.tsx`, `web/src/pages/HomePage.tsx`, `web/src/pages/workspace/*` (WorkspacePage removed; its dialogs move to the tree's menus), `web/src/App.tsx`, new `web/src/lib/lastPlace.ts`, and the tests beside them (`shell.test.tsx`, `baseShell.test.tsx`, `home.test.tsx`).
- `/` keeps redirecting (now to the last place) until task 5 replaces it.
- Check: `cd web && npx tsc --noEmit && npm test -- --run` green; new tests: tapping a table in the tree opens its remembered view; the tree shows other workspaces' projects from inside a project; `/workspace/:id` redirects.
- Risks: the drawer closes on navigation (`AppShell` effect), so expanding rows must not navigate. Loading each expanded project's schema is one `api.bases.get` per project; reuse `keys.base(id)` so the open project is not fetched twice.

**2. Record editor (web).** Behaviour 9 (except presence) and 10.
- Files: `web/src/components/record/ExpandedRecord.tsx`, `web/src/components/record/editors/{FieldEditor,TextEditor}.tsx`, `web/src/components/record/Markdown.tsx`, new `web/src/components/richtext/*`, `web/package.json` + lockfile, `web/README.md`, tests beside them.
- Check: tsc + vitest green; tests for Markdown round-trip (headings 1–6, nested lists, `5.` start, task list, table, callout, strike) `md → editor → md` is stable; ExpandedRecord shows Saving/Saved; on a 390 px viewport the dialog has no inset.
- Risks: jsdom and ProseMirror (contenteditable) — keep round-trip tests on the Markdown layer, not on typing. Bundle: confirm with `npm run build` that Tiptap lands in its own chunk.

**3. Server (Rust).** Presence, inbox, MCP names and colors (behaviour 1's MCP half, 6's server half, 7's MCP half, 11's server half).
- Files: `crates/core/src/api/{events,inbox}.rs` (+ `mod.rs`), `crates/server/migrations/0009_inbox.sql`, `crates/server/src/store/inbox.rs`, `crates/server/src/api/{events,inbox,mod}.rs`, `crates/server/src/events.rs`, `crates/server/src/mcp/{tools,data,people,schema,catalogue}.rs`, new MCP inbox tools, `docs/mcp.md`, `docs/api.md`, regenerated `web/src/api/types`, tests in `crates/server/tests/`.
- Check: `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` green, including `every_registered_route_is_catalogued`; new tests: two SSE streams of two users → presence lists both, closing one → `presence_changed`; inbox CRUD is per-user (another user gets 404); filing creates the record and removes the item; `list_projects` and `list_bases` both work.
- Risks: one Rust worktree only (each target dir is 20–40 GB); delete it right after merging.

**Checkpoint A:** merge 1–3 into this branch, run `scripts/check.sh`, look at the phone layout in the browser before wave 2.

### Wave 2 (parallel after checkpoint A)

**4. Polish, presence UI, touch (web).** Behaviour 5, 6 (UI), 7 (UI), 8.
- Files: `web/src/shell/ProfileMenu.tsx`, `web/src/shell/BaseAvatars.tsx`, `web/src/base/BaseTopBar.tsx`, `web/src/hooks/useBaseEvents.ts`, `web/src/api/events.ts`, `web/src/components/NameDialog.tsx`, workspace dialogs and settings page, `web/src/components/ui/{dropdown-menu,popover,select,split-menu}.tsx` and a new shared `web/src/lib/tapGuard.ts` (built on the constants in `lib/holdToDrag.ts`), `ExpandedRecord.tsx` scroll container, `web/e2e/mobile.spec.ts`.
- Check: tsc + vitest; a Playwright mobile test where a touch swipe starting on a menu trigger scrolls the page and opens nothing, and a tap opens it.

**5. Inbox page (web).** Behaviour 11 (UI).
- Files: new `web/src/pages/inbox/*`, `web/src/App.tsx` (`/`), the tree's Inbox and Notifications rows, `web/src/components/notifications/Inbox.tsx` (renamed Notifications), `web/src/api/endpoints.ts`, tests.
- Check: tsc + vitest; typing autosaves a draft (debounced, one POST then PATCHes); picking a table shows its fields; Save creates the record and the draft disappears.

### Wave 3

**6. Rename sweep (web + docs).** Every user-visible "base" → "project" in `web/src` (strings only: identifiers, routes and API types stay), the intro (`web/src/onboarding/*`), `README.md`, `docs/*.md` (not the dated plans), e2e selectors. `CHANGELOG.md` Unreleased entries for every behaviour above.
- Check: `grep -rniE "\bbases?\b" web/src --include=*.tsx | grep -v test` shows only identifiers; full `scripts/check.sh` and `OPENBASE_E2E=1 scripts/check.sh` green.

**Checkpoint B:** review the whole branch (code review pass), walk the main flows at 390×844 in the browser (Inbox capture → file to a table; sidebar tree navigation; record editing with the rich editor; menu swipe), then hand back.
