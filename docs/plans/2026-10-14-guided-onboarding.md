# Guided Onboarding and Workspace Access Plan
**Goal:** Make OpenBase understandable for non-technical people: a short intro, a sidebar-based app shell, empty bases that ask for a first table, and one simple access model (people join a workspace and are given some or all of its bases).
**Approach:** Backend first: replace per-base roles with per-member base access inside a workspace (one role per person), add an `empty` option to base creation and an `intro_seen` flag on users, and expose who can open each base. Then the web client: intro, new app shell with a resizable/collapsible sidebar and a profile menu at its foot, workspace pages, members page, a merged Share dialog, and a base shell whose sidebar lists tables with their views.
**Stack:** Rust (axum, rusqlite, ts-rs) and React 19 + TypeScript + Tailwind v4 + Radix + TanStack Query.
**Spec:** the agreed design canvas "OpenBase Onboarding Redesign" (Claude artifact), summarised under "Agreed behaviour" below.

## Agreed behaviour (the spec in words)

- **Intro**: everyone (owner and invited people) sees it once per account after first sign-in: 3 steps (Bases: a base card unfolds to show its tables; Tables: a mini table with arrows labelling "A field" (a column, outlined) and "A record" (a row, outlined); Workspaces: two separate workspaces with different people), then a closing screen recommending a trusted AI assistant ("Connect an assistant" → `/account?tab=assistants`, "I'll do it myself" → app). Skip link on every step. Replay from the profile menu. Must fit a 320px wide phone. Respect reduced motion.
- **Setup page** (first person on a self-hosted instance): "Welcome to your OpenBase. You are the first person here, so this OpenBase is yours…"; name, email, password (no confirm field); button "Create my account"; then the intro.
- **Terms stay**: workspace, base, table, record, field, view. Explain them; don't rename them.
- **Workspaces are created deliberately** and isolate data and members. No auto-created workspace. Home with none shows "Create your first workspace" with name suggestions (Personal, Household, Side business, Team).
- **Access model**: a person gets access by joining a workspace. Each member has exactly one role in the workspace and either **all bases (including new ones)** or a **picked list of bases**. Owners always have all bases. Per-base roles and base-only members no longer exist. View share links and public forms remain the way to show data to people outside.
- **Avatars**: each base card and the base top bar show who can open that base; invited-but-not-joined people appear greyed with a dashed outline; a base nobody else can open shows a lock and "Only you".
- **Share dialog** (from a base): two tabs. "Invite people": email, role, "Bases they can open" with "Only the bases I pick" (current base ticked by default) or "All bases in <workspace>, including bases made later"; note that they join the workspace; link to members page. "Share a view": pick a view; states that the link shows only what that view shows, now and as it changes later, read-only; link + copy; optional password.
- **Members page** per workspace: role per person (one role), base access editor (All bases / checklist), pending invites with Resend / Cancel.
- **App shell**: top bar with a sidebar toggle at top-left (replaces any back button), logo, search, bell. Sidebar = main menu: on home it lists workspaces (+ new workspace), Trash and Settings; inside a base it starts with "‹ <workspace>" back link, then Tables (each table expands to its views, "Add view"), "+ New table", and Automations, Trash, Members at the bottom. The profile (avatar, name, email) sits at the very bottom of the sidebar and opens a menu: Account settings, Connect an assistant, Replay the intro, Appearance, Administration (admins), Log out. Sidebar is resizable and collapsible on desktop (width and collapsed state remembered per device), and a slide-in drawer with a close button in its top-right corner on phones.
- **Workspace page**: header (tile, name, "N members · M invites waiting" → members page), buttons Invite, Import a spreadsheet, New base; base cards with avatars.
- **Phone**: Import (bottom-left) and New base (bottom-right) float at the bottom of the workspace page.
- **New base** starts with **no tables** and shows "Create your first table" (name field + Create table, or Import a CSV).
- **Base toolbar**: tools can be collapsed to one "Tools" button; the device remembers it. The main add button just says "Add".

## Decisions taken while planning

- `POST /api/workspaces/{id}/bases` keeps creating the starter table by default so the public API, MCP tools and existing tests keep working; the web client sends `empty: true`.
- Migration of existing data (no data is lost, no access is widened):
  - A base member who is not a member of that base's workspace becomes a workspace member with the base member's role and access to just the bases they were members of (if they were members of several bases in one workspace: their highest role, and all those bases).
  - A base member who is already a workspace member keeps their workspace role and all-bases access (their base row only ever raised a role on one base; we drop that raise rather than widen it to the whole workspace). Called out in the changelog.
  - Pending base invites become workspace invites limited to that base.
  - `base_members` is dropped after the copy.
- Inviting: workspace owners can invite with any base selection; creators can invite from a base they can open, limited to bases they themselves can open, never "all bases", never above their own role.
- A limited member who creates a base gets it added to their list (otherwise they could create a base they can't open).

## Interfaces (the contract between backend and web tasks)

Rust DTOs in `crates/core` (exported with ts-rs; regenerate with `scripts/gen-types.sh`):

```rust
// crates/core/src/api/workspaces.rs
pub struct WorkspaceSummary { /* existing */ pub role: RoleName /* no longer Option */, pub member_count: i64, pub pending_invite_count: i64 }
pub struct BaseSummary { /* existing */ pub people: Vec<BasePerson> }
pub struct BasePerson { pub user_id: Option<String> /* None for a pending invite */, pub name: String, pub email: String, pub pending: bool, pub role: RoleName }
pub struct Member { /* existing */ pub all_bases: bool, pub base_ids: Vec<String> }
pub struct UpdateMember { pub role: Option<RoleName>, pub all_bases: Option<bool>, pub base_ids: Option<Vec<String>> }
pub struct CreateBase { /* existing */ pub empty: Option<bool> }
// crates/core/src/api/auth.rs
pub struct CreateInviteRequest { /* existing */ pub all_bases: Option<bool>, pub base_ids: Option<Vec<String>> }
pub struct InviteInfo { /* existing */ pub all_bases: bool, pub base_ids: Vec<String> }
pub struct User { /* existing */ pub intro_seen: bool }
pub struct UpdateMeRequest { /* existing */ pub intro_seen: Option<bool> }
// BaseSchema (GET /api/bases/{id}) gains: pub people: Vec<BasePerson>, pub workspace_name: String
```

Endpoints:
- `GET /api/workspaces` – only workspaces the caller is a member of; bases filtered to those they can open; each base has `people`.
- `PATCH /api/workspaces/{id}/members/{user_id}` – body `UpdateMember`; owner only; owners are always all-bases; at least one base or all-bases.
- `POST /api/workspaces/{id}/invites` – owner; accepts `all_bases`/`base_ids` (default all bases).
- `POST /api/bases/{id}/invites` – creator+ on that base; creates a workspace invite; default `base_ids = [id]`; rejects `all_bases` and bases the inviter can't open.
- `GET /api/bases/{id}/members` – any member who can open the base; workspace members with access to it.
- `DELETE /api/bases/{id}/members/{user_id}` – owner removes that base from a limited member's list (or a limited member removes it from their own list); 400 for all-bases members (edit them on the members page). `PATCH /api/bases/{id}/members/{user_id}` is removed.
- `PATCH /api/auth/me` – accepts `intro_seen`.

## Tasks

### Task 1 – Backend: access model, empty bases, intro flag (one agent, sequential)
- **Intent:** implement the access model, migration, endpoints and DTOs above; `empty` on base creation; `users.intro_seen`.
- **Files:** `crates/server/migrations/0005_workspace_base_access.sql` (new), `crates/server/src/db.rs` (MIGRATIONS, schema_version test), `crates/server/src/perm.rs` (`base_role`), `crates/server/src/store/{workspaces,bases,invites,trash,users or auth}.rs`, `crates/server/src/engine/write.rs` and `crates/server/src/v1/input.rs` (collaborator sets), `crates/server/src/api/{workspaces,bases,invites,auth}.rs`, `crates/server/src/mcp/{data,people,catalogue,mod}.rs`, `crates/core/src/api/{workspaces,auth}.rs`, `web/src/api/types/*` (regenerated), Rust tests under `crates/server/tests/` and `crates/server/src/store/invites.rs` unit tests, `docs/{api,mcp,security}.md`, `README.md`, `CHANGELOG.md`.
- **Check:** `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `scripts/gen-types.sh --check` all pass. New tests prove: limited member sees only listed bases (list + 404 on others + SSE access), all-bases member sees new bases, owner can't be limited, creator invites can't exceed own bases/role, migration converts base-only members and base invites, `empty: true` creates a base with no tables, `intro_seen` round-trips.
- **Risks:** many tests use `grant_base_role`/`base_guest`; rewrite them to "limited workspace member" rather than delete coverage. The trash store has its own copy of the role query. Keep the web client compiling (adjust TS usages of the changed types minimally; the web tasks will redo the UI).
- **Checkpoint:** review the diff of `perm.rs`, the migration and the invite rules before any web task builds on them.

### Task 2 – Web: intro and setup (parallel with Task 1, coded against the interfaces above)
- **Intent:** `IntroDialog`/`IntroPage` component with the 4 screens; shown after sign-in when `me.intro_seen` is false, marks seen via `PATCH /api/auth/me {intro_seen: true}`; replayable. Setup page copy and fields per spec. Invited users see it too.
- **Files:** `web/src/onboarding/*` (new), `web/src/App.tsx` or `auth/guards.tsx` (mount point), `web/src/pages/SetupPage.tsx`, tests `web/src/onboarding/intro.test.tsx`, `web/src/pages/auth.test.tsx`, e2e selectors in `web/e2e/journey.spec.ts`.
- **Check:** `npx tsc --noEmit`, `npm test -- --run` pass; a Playwright screenshot at 1280×800 and 390×844 of each step shows nothing clipped.

### Task 3 – Web: app shell, home/workspace pages, members page, Share dialog (after Task 1)
- **Intent:** `AppShell` (top bar + `Sidebar` primitive with resize/collapse persisted in localStorage `ob-sidebar`, mobile drawer, `ProfileMenu` at the foot) used by home/workspace/members/account pages; routes `/` (redirect to last-used or first workspace, or "Create your first workspace"), `/workspace/:id`, `/workspace/:id/members`; base cards with `BaseAvatars`; members page; `ShareDialog` with Invite/Share-a-view tabs replacing the base-scope SharingDialog and the separate ShareViewDialog entry point; new base sends `empty: true`.
- **Files:** `web/src/shell/{AppShell,Sidebar,ProfileMenu,BaseAvatars}.tsx` (new), `web/src/pages/{HomePage,WorkspacePage,MembersPage}.tsx`, `web/src/components/ShareDialog.tsx`, `web/src/App.tsx`, `web/src/components/layouts.tsx`, tests alongside, e2e selector updates.
- **Check:** tsc + vitest pass; screenshots at 1280 and 390 of home (empty and populated), workspace page, members page, Share dialog both tabs.

### Task 4 – Web: base shell (after Task 3's shell primitives)
- **Intent:** base layout uses `AppShell`'s Sidebar with the base menu (back link, tables with nested views, add view/table, Automations/Trash/Members, profile); top bar with toggle, base tile/name, avatars, Share, bell; remove `TableTabs` strip and `ViewSidebar` panel (their menus move into the sidebar items); empty-base screen; ViewBar tools collapse remembered per device (`ob-tools-collapsed`); primary "Add" button in the ViewBar where the view supports adding.
- **Files:** `web/src/base/{BaseShell,TopBar,BaseSidebar,EmptyBase}.tsx`, removal of `TableTabs.tsx`/`ViewSidebar.tsx` (logic moved), `web/src/components/viewbar/ViewBar.tsx`, `web/src/views/grid/GridView.tsx`, `web/src/base/baseShell.test.tsx`, e2e specs.
- **Check:** tsc + vitest pass; screenshots of a base at 1280 and 390 (menu open and closed), the empty base.

### Task 5 – Full verification and review
- `scripts/check.sh` (includes contract tests) and `OPENBASE_E2E=1` e2e run with Playwright's Chromium; fix fallout. Independent review agent on the full diff. Then PR.
