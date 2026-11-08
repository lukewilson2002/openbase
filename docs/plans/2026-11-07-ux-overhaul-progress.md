# UX overhaul: progress

Spec: [2026-11-07-ux-overhaul.md](2026-11-07-ux-overhaul.md). Branch: `ux-overhaul`, cut from `main` at `ccadee6`.

A fresh agent resumes from this file alone: read the spec, then the sections below, then continue with the first requirement whose status is not `done` in the current phase.

## Current phase

Phase 3 · Shell (not started). Phases 0, 1 and 2 passed their gates (see Phase gates).

## Phase gates

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 · Security first | passed 2026-11-07 | At `bd230b8`: `cargo deny check` ok (advisories, bans, licences, sources; one ignore, RUSTSEC-2023-0071); `cd web && npm audit --audit-level=high` 0 vulnerabilities; `gitleaks git --redact` 487 commits, no leaks; Trivy on the freshly built `deploy/Dockerfile` image (`openbase:scan`, Debian 13.7) 0 findings with `--scanners vuln --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1`; `OPENBASE_E2E=1 scripts/check.sh` exit 0 ("All checks passed."). Every SEC-4 item has tests or a recorded manual check (SEC-4.7). The GitHub Actions jobs for the scans must still go green in CI before the pull request (DONE-11; see Scans not run locally). |
| 1 · Foundation | passed 2026-11-08 | DL-1 to DL-4 done. Design page `/__dev/design` complete in both themes: the four screenshots exist (`docs/plans/ux-overhaul-screenshots/01-design-reference-{light,dark}-{1440,390}.png`), were re-taken at `7e8daa8` after the fix round changed components (checkbox, swatch picker, help tip, toast, sheet, new `--paper` and `--scrim` tokens, which the first set did not show) and were opened and looked at: every token family and all core components appear in the light and dark columns at 1440, and stacked at 390. Token check green (16 files on the temporary list). `e2e/design.spec.ts` passes in the full run at ea73149. |
| 2 · Backend | passed 2026-11-08 | BE-1 to BE-12, AGT-1, AGT-3, AGT-4, AGT-6 done; AGT-2 server side done (UI in Phase 6); AGT-5 is Phase 6. Migration (DONE-7) and DONE-8 golden tests green (`migration_v16.rs`, `v1_golden.rs`, in `cargo test --workspace`), and `npm run test:contract` green (16 files, 387 tests), at ea73149. The Home benchmark (HOME-11) ran once at 86 ms against 300 ms. |
| 3 · Shell | not started | |
| 4 · Collections | not started | |
| 5 · Records | not started | |
| 6 · Home and the rest | not started | |
| 7 · Finish | not started | |
| 8 · Final audit | not started | |

## Requirements

| Id | Phase | Status | Evidence (tests, commits, screenshots) |
| --- | --- | --- | --- |
| SEC-1 | 0 | done | Commit 932ed7b. Cargo.lock: pulldown-cmark 0.13.6, rustls 0.23.46, rustls-webpki 0.103.16, webpki-root-certs 1.0.11, time 0.3.55, ctutils 0.4.8, tokio 1.54.1, webauthn-rs 0.6.2, crypto-bigint 0.7.10; `ammonia` and cmark's `html` feature removed (nothing in `crates/` uses them). RUSTSEC-2026-0387 (crypto-bigint) cleared by webauthn-rs 0.6.2, so only RUSTSEC-2023-0071 (rsa, webauthn-rs 0.6.2 pulls an rsa release candidate, no patched version) stays ignored, with reason and re-check date 2027-02-07 in `deny.toml`. Gate run: `cargo deny check` ok; `cargo test --workspace` via `scripts/check.sh`: 2228 Rust tests passed, 0 failed (passkeys suite included). |
| SEC-2 | 0 | done | Commit b84b871. web/package-lock.json: undici 8.12.4, body-parser 2.4.0, qs 6.17.1, fast-uri 3.1.9, minimatch 11.0.5 via an `overrides` entry under `@glideapps/glide-data-grid` (Glide stays 6.0.3). Gate run: `npm audit --audit-level=high` 0 vulnerabilities (also `--omit=dev`); `npx tsc --noEmit` ok; `npm test -- --run` 158 files, 2310 tests passed (grid tests included); web build ok. |
| SEC-3 | 0 | done | Commits beb30af, 723a707. `deny.toml` (advisories, bans, sources, licence allow-list; every ignore has its reason); `scripts/check.sh` runs `cargo deny check` and `npm audit --audit-level=high` (`audit=false` stays in `web/.npmrc`); `.github/workflows/ci.yml` has a `secrets` job (gitleaks, full history) and an `image` job (builds `deploy/Dockerfile`, Trivy fail on critical/high); `.github/dependabot.yml` has the `docker` ecosystem for `/deploy`. Scanners installed in CI by `scripts/ci-install-tool.sh` with pinned SHA-256 sums. Local gate runs: `cargo deny check` ok, `npm audit --audit-level=high` 0, `gitleaks git --redact` no leaks (487 commits), Trivy clean on a fresh image. The CI jobs themselves have not run on a runner (see Scans not run locally). |
| SEC-4 | 0 | done | All seven sub-items have tests or a recorded manual check (table below). Merge 053a124 (sec4-hardening) plus review fixes c222509, 2f9aada, ce9414f and commit 78fbeb0 (4.7). Server tests live in `crates/server/tests/security_hardening.rs`, `crates/server/src/ratelimit.rs`, `crates/server/src/auth/password.rs` and `crates/server/tests/mcp_*`.

| Sub-item | Evidence |
| --- | --- |
| 4.1 CSRF Origin check | `http.rs csrf_guard`. Tests: `a_cookie_request_from_another_origin_is_refused`, `the_referer_decides_only_when_there_is_no_origin`, `the_csrf_header_is_still_required_alongside_the_origin_check`, `bearer_clients_anonymous_posts_and_reads_are_not_subject_to_the_origin_check`, `the_origin_is_compared_with_the_https_public_url`. Vite dev proxy sends the public URL as Origin (f8ee36e). |
| 4.2 Share-link passwords | Minimum 8 characters for new passwords (older ones keep working); per-link guess cap redesigned after review (c222509): `begin()` returns a guard that counts as wrong unless `.right()` is called, only confirmed wrong guesses lock, in-flight checks hold places but never lock, sliding window. Tests: `ratelimit::tests::a_right_guess_after_a_lockout_does_not_lock_the_key_again`, `a_right_guess_is_not_counted`, `guesses_still_being_checked_never_lock_the_key`, `parallel_guesses_cannot_get_past_the_cap`, `a_burst_split_across_a_window_boundary_does_not_double_the_cap`, `guess_cap_holds_for_the_whole_window_not_for_each_lockout`; integration `new_share_passwords_need_eight_characters_but_older_ones_keep_working`, `a_link_locks_after_a_hundred_wrong_guesses_from_any_addresses`, `the_attachment_route_counts_against_the_same_cap`. Web: `shareLinks.test.ts`, `ShareViewDialog.test.tsx`. |
| 4.3 Hashing slots | Own 2-slot pool for anonymous checks (`verify_anonymous_async`). Test: `anonymous_checks_do_not_wait_for_sign_in_slots_and_the_reverse`. |
| 4.4 Headers | Permissions-Policy, COOP same-origin (omitted on `/oauth/authorize`, `/login`, `/login/2fa`, `/oauth/consent` so an OAuth popup keeps its opener, 2f9aada), CORP same-origin, HSTS 1 year with no preload only over https. Tests: `every_response_carries_the_hardening_headers`, `hsts_is_sent_only_when_the_public_url_is_https`, `cors_enabled_machine_endpoints_keep_their_cors_headers_under_the_resource_policy`, `the_pages_an_oauth_popup_walks_through_keep_the_window_opener_link`. |
| 4.5 Session cookie | `__Host-ob_session` over https, 14-day idle timeout inside the 30-day maximum, release note in CHANGELOG. Tests: `over_https_the_session_cookie_is_host_prefixed_and_only_that_name_signs_in`, `logging_in_and_out_over_https_use_the_host_cookie_and_clear_the_old_name`, `over_plain_http_the_cookie_keeps_its_name_and_is_not_secure`, `a_session_idle_for_fourteen_days_ends_inside_its_thirty`, `activity_keeps_a_session_alive_but_never_past_thirty_days`, `the_idle_clock_is_written_at_most_every_ten_minutes`, `idle_sessions_are_purged_with_the_expired_ones`. Dead `actor_from_session` removed (ce9414f). |
| 4.6 Real client IP for MCP | Outer peer passed as a `ConnectInfo` extension, `X-Forwarded-For` only under `trust_proxy`. Tests (fail when the extension insertion is removed, checked by mutation): `mcp_requests_are_seen_from_the_real_peer_without_a_proxy`, `mcp_requests_over_a_real_connection_record_the_socket_address`, `mcp_requests_use_the_proxy_forwarded_address_only_when_a_proxy_is_trusted`, `mcp_rate_limits_see_the_real_peer_too`. |
| 4.7 Images and toolchains | Manual check, 2026-11-07 at `bd230b8`: `deploy/Dockerfile` pins `node:26-trixie-slim@sha256:5adad64f...`, `rust:1.99.1-bookworm@sha256:e6f2cff3...` and `debian:trixie-slim@sha256:a72b4433...`; the runtime image is Debian 13.7 (`cat /etc/debian_version`) with ffmpeg 7.1.5-0+deb13u1 and `apt-get upgrade` in the runtime stage; `rust-toolchain.toml` pins `1.99.1` and the Dockerfile fails the build when its `rustc` differs (the image built, so they match); CI, release and Dockerfile use Node 26 (`ci.yml` lines 84 and 198, `release.yml` 193); `scripts/smoke-docker.sh` passed when SEC-4.7 landed (78fbeb0). | |
| SEC-5 | 0 | done | Commit 9179318 (plus doc fixes in 2f9aada). `docs/security.md` matches the code: built-in protections, administrator checklist, and accepted risks each with a reason (share tokens stored in plain text, `style-src 'unsafe-inline'`, the one ignored advisory RUSTSEC-2023-0071 with re-check 2027-02-07, the share-link guess cap and its lock, Trivy `--ignore-unfixed`, HSTS without includeSubDomains or preload, COOP exception for OAuth pages). README, SECURITY.md, `docs/mcp.md` and CHANGELOG Unreleased (cookie rename sign-out, COOP note, dependency updates, Debian 13 / Node 26 / Rust 1.99.1) updated. Checked against the code by the author; no tests apply. |
| DL-1 | 1 | done | Commits a226b70 (token check script), d58e3fd (tokens), 42e128d (web/README); fix round 71b6e54 (FE1-4 baseline file so the temporary list cannot grow, FE1-5 palette colours and conditional or quoted-key px sizes now flagged; `--paper` and `--scrim` tokens). `scripts/check-tokens.sh` is a step of `scripts/check.sh`, so CI runs it. Tests: `src/styles/checkTokens.test.mjs`, `tokens.test.ts` (pins light and dark values), `lib/cn.test.ts`. 16 files on the temporary list. |
| DL-2 | 1 | done | Commits b0bd41c (page `/__dev/design`, DEV or `VITE_DESIGN_PAGE=1` only; a release build has no trace of it: grep of web/dist for the route, component and page text found nothing, no DesignPage chunk), 7e8daa8 (paper and scrim shown), screenshots 20346a2 and ea73149. Tests: `src/dev/DesignPage.test.tsx` (6), `e2e/design.spec.ts` (3, in the e2e run). Every token family and all 22 core components in light and dark columns side by side, states included; overlays drawn open in frames. Screenshots re-taken after the fix round and looked at: docs/plans/ux-overhaul-screenshots/01-design-reference-{light,dark}-{1440,390}.png. |
| DL-3 | 1 | done | Core components A (0ab729a, df6056b, 9606e0b): Button, IconButton, Tabs, EmptyState restyled; ColorMark, NavRow, StatusChip, FilterChip, LinkChip, CaptureChip, Card, FeedRow, PropertyList, Skeleton new. Core components B (cc020d8, 26a6fcc, 5ab72f1, ad1e8fb, ff154bf): Popover, Menu, Sheet, SidePanel, Dialog, ConfirmDialog, CommandPalette and FilterBar shells, TemporaryChangesBar, Toast. Tests `components/ui/core.test.tsx` (70), `overlays.test.tsx` (54+), `anchored-menu.test.tsx`. Fix round: d1d1eee (toast action runs once, sheet returns when its close is refused), 0527e4e (help tip padding), dfbc3eb (a context menu gives focus back after its leaving animation; found by the e2e grid test, Ctrl+Z after a menu delete). Old call sites move to these in each screen's phase. |
| DL-4 | 1 | done | Commit c2d8440: `components/ui/icon.tsx` (stroke 2, 16 px, 20 on phone, text colour, aria-hidden); IconButton requires `label` by type; `components/ui/icons.test.tsx` (9, includes `@ts-expect-error` cases and a scan of components/ui) and DesignPage.test.tsx (every svg aria-hidden, stroke 2). The 140 files that draw lucide directly move with their screens. |
| NAV-1 | 3 | not started | |
| NAV-2 | 3 | not started | |
| NAV-3 | 3 | not started | |
| NAV-4 | 3 | not started | |
| NAV-5 | 3 | not started | |
| NAV-6 | 3 | not started | |
| NAV-7 | 3 | not started | |
| NAV-8 | 3 | not started | |
| NAV-9 | 3 | not started | |
| NAV-10 | 3 | not started | |
| HOME-1 | 6 | not started | |
| HOME-2 | 6 | not started | |
| HOME-3 | 6 | not started | |
| HOME-4 | 4 | not started | |
| HOME-5 | 6 | partial | Server half only: migration 0016 presets the Home date and Done properties by name (Due, Due date, Deadline, Date, When, Start; Done, Complete, Completed; priority by name, then table order; trashed tables too). The settings UI is Phase 6. |
| HOME-6 | 6 | not started | |
| HOME-7 | 6 | not started | |
| HOME-8 | 6 | not started | |
| HOME-9 | 6 | not started | |
| HOME-10 | 6 | not started | |
| HOME-11 | 6 | partial | Server half only: `crates/server/tests/home_perf.rs` (ignored, release mode) builds 4 projects, 20 collections, 100,000 records: 8 requests at 85.8 to 90.1 ms against the 300 ms limit. The UI half and the Phase 6 gate run come later. |
| COL-1 | 4 | not started | |
| COL-2 | 4 | not started | |
| COL-3 | 4 | not started | |
| COL-4 | 4 | not started | |
| COL-5 | 4 | not started | |
| COL-6 | 4 | not started | |
| COL-7 | 4 | not started | |
| COL-8 | 4 | not started | |
| COL-9 | 4 | not started | |
| COL-10 | 4 | not started | |
| REC-1 | 5 | not started | |
| REC-2 | 5 | not started | |
| REC-3 | 5 | not started | |
| REC-4 | 5 | not started | |
| REC-5 | 5 | not started | |
| REC-6 | 5 | not started | |
| REC-7 | 5 | not started | |
| REC-8 | 5 | not started | |
| REC-9 | 5 | not started | |
| REC-10 | 5 | not started | |
| FLD-1 | 4 | not started | |
| FLD-2 | 5 | not started | |
| FLD-3 | 5 | not started | |
| FLD-4 | 5 | not started | |
| FLD-5 | 5 | not started | |
| FLD-6 | 5 | not started | |
| APP-1 | 6 | not started | |
| APP-2 | 6 | not started | |
| APP-3 | 6 | not started | |
| APP-4 | 6 | not started | |
| APP-5 | 6 | not started | |
| APP-6 | 6 | not started | |
| APP-7 | 6 | not started | |
| APP-8 | 6 | not started | |
| APP-9 | 6 | not started | |
| APP-10 | 6 | not started | |
| APP-11 | 6 | not started | |
| APP-12 | 6 | not started | |
| APP-13 | 6 | not started | |
| APP-14 | 6 | not started | |
| APP-15 | 6 | not started | |
| APP-16 | 6 | not started | |
| APP-17 | 6 | not started | |
| PH-1 | 3 | not started | |
| PH-2 | 3 | not started | |
| PH-3 | 7 | not started | |
| PH-4 | 7 | not started | |
| PH-5 | 7 | not started | |
| PH-6 | 7 | not started | |
| PH-7 | 7 | not started | |
| A11Y-1 | 7 | not started | |
| A11Y-2 | 7 | not started | |
| A11Y-3 | 7 | not started | |
| A11Y-4 | 7 | not started | |
| A11Y-5 | 7 | not started | |
| A11Y-6 | 7 | not started | |
| A11Y-7 | 7 | not started | |
| AGT-1 | 2 | done | Verified, no code change: creating a workspace needs `manage`, folders need creator, deletes need owner. Pinned by `mcp_agent_access.rs` (8). |
| AGT-2 | 2 | partial | Server side done (9a42660, ccd0eb3, d90d831): consent offers Read, Read and write and Full control, preselects what the app asked for, explicit choice from the person only; `PATCH /api/oauth/grants/{id}` (Change access, session-only, CSRF, audited as `oauth_grant_update`); live tokens follow it from their next request; an app limited to some projects cannot have Full control (consent and Change access). Tests `oauth_flow.rs`, `oauth_change_access.rs`, contract `Change access` (5). The restyled consent screen and the Account page are Phase 6 (APP-14). |
| AGT-3 | 2 | done | Commit 5439da4: `create_workspace` returns `workspace_id` and `top_level_project`; `set_top_level_project`, `is_top_level`, refusal to delete the top level; project tool descriptions say a project is a folder. Tests `mcp_agent_access.rs`, `mcp_tools_collections.rs`. |
| AGT-4 | 2 | done | Commits 5439da4, 667973f: no tool or endpoint erases a workspace or project (only the retention purge); `delete_workspace` and `delete_project` report the trash, `restore_with` and the purge date; permanent deletes say "This can't be undone". List below. Test `every_destructive_tool_says_whether_it_can_be_undone` and `no_tool_or_endpoint_erases_a_workspace_or_project_for_good`. |
| AGT-5 | 2 | not started | |
| AGT-6 | 2 | done | Commits 7625e09, 0ab7975: `web/contract/agentAccess.contract.test.ts` (10) plus the Change access scenarios in `oauth.contract.test.ts`: a full-access token over REST and MCP creates a workspace and its top level, a folder, deletes and restores both; without `manage` the tools are refused naming the permission; top level refused and freed; an OAuth client upgraded with Change access deletes with the token it already holds. |
| BE-1 | 2 | done | Commits 3cb916d and 162c2de (v15 fixture and golden v1 files, before the change), 281d135 (migration 0016_collections.sql, `store/pages.rs upgrade_to_v16`), ccf3c39; 131c62e adds migration 0017 (`fields.trashed_setting`). Tests `crates/server/tests/migration_v16.rs` (15), csv.rs page column case. Schema version is now 17. |
| BE-2 | 2 | done | Commits facf65c, d35c991, 4d1f97a (`list_icons` says icons are no longer displayed). Table `color` on create and update (validated, next colour of the cycle by default), `icon` still accepted. MCP `create_table`, `rename_table` and `update_table_settings`. Tests `collections.rs`, `mcp_tools_collections.rs`, contract `collection settings`. |
| BE-3 | 2 | done | Commits 1a34ade, 17a70e0, 08aa4fd, 26a65c8, e6a3ba7. `GET /api/workspaces/{id}/home` and MCP `get_home`. Tests `crates/server/tests/home.rs` (15), `mcp_home.rs` (3), contract `home` (4). |
| BE-4 | 2 | done | Commit facf65c: table listings carry `record_count`, `color`, `body_field_id`, `home_date_field_id`, `done_field_id`, `record_noun`; workspaces `root_base_id`; projects `is_top_level`. One grouped count query per project or workspace. MCP `list_projects` and `get_project_schema` show the same. Generated types current. |
| BE-5 | 2 | done | Commits facf65c, d35c991, cb5294f, 131c62e, 0cee9db. `PATCH /api/tables/{id}` settings, `POST /api/tables/{id}/body-field` (now rejects a body with no `field_id`), `PUT /api/tables/{id}/records/{rid}/page`, `POST /api/workspaces/{id}/top-level`; MCP `set_page_field`, `update_table_settings`, `set_top_level_project`. Guards clear a setting when its property goes and restore it on trash restore (migration 0017). Top-level project cannot be deleted (409). Tests `collections.rs`, `mcp_tools_collections.rs`. |
| BE-6 | 2 | done | Commits bbff80e, b72b8d3. Repeated edits of one text or rich text cell by one person fold into one history row for 10 minutes; a fold back to the first value removes the row. Tests `history_coalesce.rs` (16). |
| BE-7 | 2 | done | Commits cff99d7, 5acdf98, 52079f7, e8b899c. `is_within` takes this, next and last calendar week and next and last calendar month; week start from the request, else `users.week_start`, else Sunday; `PATCH /api/auth/me`. Tests `calendar_ranges.rs` (20), `query_calendar_weeks.rs`, contract `weeks.contract.test.ts` (8). |
| BE-8 | 2 | done | Commit ad29f92: search skips `openbase` embed blocks in rich text; docs and MCP descriptions give the embed syntax. Tests in ob-core (7), `query_contract.rs`, `search.rs`. |
| BE-9 | 2 | done | Commits a0b6f08, cbbdf81, 3be2406. `GET /api/workspaces/{id}/events` (SSE, one stream for every project the caller can open, no presence, 20 per user); catalogued as Blocked. Tests `events_workspace.rs` (13+), contract `workspace events` (6). The client side (HOME-10) is later. |
| BE-10 | 2 | done | Contract tests for every Phase 2 route and tool (4d1f97a, 6e85edf, 42dcdc7, c19c715, 0ab7975, 3260f40): `npm run test:contract` 16 files, 387 tests. Docs audited against the code (docs/api.md, docs/mcp.md). |
| BE-11 | 2 | done | Commits d3d6985, 5c62088: `create_view` description says personal views need editor; `field.rs` says which computed values are stored; the unused `invite` notification kind removed (unknown kinds render generically). |
| BE-12 | 2 | done | Commit 5d7818c: a transient view override carries `row_color` and `summaries`. Tests `query_contract.rs` (5 new), `sharing.rs`, contract `records`. |

## Definition of done

| Id | Status | Evidence |
| --- | --- | --- |
| DONE-1 | not done | |
| DONE-2 | not done | |
| DONE-3 | not done | |
| DONE-4 | not done | |
| DONE-5 | not done | |
| DONE-6 | not done | |
| DONE-7 | partial | Phase 2 evidence, green: `crates/server/tests/migration_v16.rs` `no_cell_value_and_no_old_row_changes` (per-cell SHA-256 over every record of the v15 fixture, more than 500 cells, identical after `Db::open`; record counts live and trashed identical; every v15 column of every v15 row byte-identical; view configs differ only by the added Page ids in `hidden_fields`; the pre-migration snapshot is a v15 file with the same checksum) and `the_database_reaches_version_16_and_stays_consistent`. Migration 0017 adds a column only. Re-run at Phase 8. |
| DONE-8 | partial | Phase 2 evidence, green: `crates/server/tests/v1_golden.rs` compares 14 golden v1 files captured before the migration (`tests/golden/v1/*.json`, commit 3cb916d) with the migrated fixture; the only allowed differences are the new Page property in table metadata and the top-level projects of workspaces that had none (decision 2026-11-08, BE-V1-1). `npm run test:contract`: 16 files, 387 tests. Must stay green through the later phases; final check at Phase 8. |
| DONE-9 | not done | |
| DONE-10 | not done | |
| DONE-11 | not done | |
| DONE-12 | not done | |

## Screen ledger

| # | Screen or surface | Where | Requirements | Phase | Status | Screenshots |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Design reference | `/__dev/design` | DL-1 to DL-4 | 1 | moved | `docs/plans/ux-overhaul-screenshots/01-design-reference-light-1440.png`, `01-design-reference-dark-1440.png`, `01-design-reference-light-390.png`, `01-design-reference-dark-390.png` |
| 2 | Desktop sidebar and workspace switcher | every signed-in screen | NAV-1 to NAV-6 | 3 | not moved | |
| 3 | Phone bottom bar and Collections tab | `/workspace/:id/collections` | NAV-7, NAV-8, PH-1, PH-2 | 3 | not moved | |
| 4 | Command palette | Ctrl K or Cmd K | NAV-9 | 3 | not moved | |
| 5 | Collection header, tabs, filter bar, drafts bar | `/base/:baseId/:tableId/:viewId?` | COL-1 to COL-5 | 4 | not moved | |
| 6 | View options and its sub-screens | collection | COL-6 | 4 | not moved | |
| 7 | Save as view | collection | COL-5 | 4 | not moved | |
| 8 | Grid layout | collection | COL-7 | 4 | not moved | |
| 9 | List layout | collection | COL-7 | 4 | not moved | |
| 10 | Board layout | collection | COL-7 | 4 | not moved | |
| 11 | Calendar layout and unscheduled list | collection | COL-7 | 4 | not moved | |
| 12 | Gallery layout | collection | COL-7 | 4 | not moved | |
| 13 | Timeline layout | collection | COL-7 | 4 | not moved | |
| 14 | Form builder | collection, Form layout | COL-6 | 4 | not moved | |
| 15 | Collection settings | collection "…" | COL-10 | 4 | not moved | |
| 16 | Bulk selection bar and sheet | collection | COL-9 | 4 | not moved | |
| 17 | Empty and filtered-empty states | collection | COL-9 | 4 | not moved | |
| 18 | Record page | `/base/:baseId/:tableId/:viewId/r/:recordId` | REC-1 to REC-6, REC-8 to REC-10 | 5 | not moved | |
| 19 | Comments and history panels | record page | REC-7 | 5 | not moved | |
| 20 | Page embeds (linked records, view) | record page | REC-6 | 5 | not moved | |
| 21 | Property editor, choices and formula | record page, grid header | FLD-2 to FLD-6 | 5 | not moved | |
| 22 | Link picker and linked record peek | record page, grid | FLD-5, REC-9 | 5 | not moved | |
| 23 | Home | `/workspace/:id` | HOME-1 to HOME-11 | 6 | not moved | |
| 24 | Sign in | `/login` | APP-1 | 6 | not moved | |
| 25 | Two-factor sign-in | `/login/2fa` | APP-1 | 6 | not moved | |
| 26 | First admin setup | `/setup` | APP-1 | 6 | not moved | |
| 27 | Sign up and invite | `/signup`, `/invite/:token` | APP-1 | 6 | not moved | |
| 28 | Forgot and reset password | `/forgot-password`, `/reset-password` | APP-1 | 6 | not moved | |
| 29 | First run | `/` with no workspace | APP-2 | 6 | not moved | |
| 30 | Intro | over any screen | APP-3 | 6 | not moved | |
| 31 | Notifications | sidebar popover, `/notifications` | APP-4 | 6 | not moved | |
| 32 | Automations list and editor | `/workspace/:id/automations`, `/base/:baseId/automations/…` | APP-5 | 6 | not moved | |
| 33 | Public form | `/form/:token`, `/f/:token` | APP-6 | 6 | not moved | |
| 34 | Public shared view | `/share/:token`, `/s/:token` | APP-7 | 6 | not moved | |
| 35 | Share dialog and view links | collection header, folder menu | APP-8 | 6 | not moved | |
| 36 | History | `/history` | APP-9 | 6 | not moved | |
| 37 | Trash | `/trash` | APP-10 | 6 | not moved | |
| 38 | CSV import, export, new collection from CSV | collection and folder menus | APP-11 | 6 | not moved | |
| 39 | Workspace settings | `/workspace/:id/settings` | APP-12 | 6 | not moved | |
| 40 | Members, folder access, invites | `/workspace/:id/members` | APP-13 | 6 | not moved | |
| 41 | Account, OAuth consent | `/account?tab=…`, `/oauth/consent` | APP-14, AGT-2, AGT-5 | 6 | not moved | |
| 42 | Admin | `/admin?tab=…` | APP-15 | 6 | not moved | |
| 43 | Empty folder | /base/:baseId | Navigation routes | 3 | not moved | |
| 44 | File preview | record pages, grid, comments | REC-3 | 5 | not moved | |
| 45 | Not found and error screens | everywhere | APP-16, APP-17 | 6 | not moved | |

## Token check temporary list

(Created in Phase 1; each phase removes its files; must be empty at Phase 7.)

The list lives in `scripts/check-tokens.temporary-list.txt` (one path per line, relative to `web/src`). It holds **16 files** at the end of Phase 2. `scripts/check-tokens.baseline.txt` is the frozen copy of the list as it was when Phase 1 ended: the check fails if the list holds a path that is not in the baseline, so it can only shrink. When a file loses its last raw colour or px font size, delete its line from the list in the same commit (the check fails otherwise); never add one.

```
base/EmptyBase.tsx
components/ShareDialog.tsx
components/accountMenu.tsx
components/layouts.tsx
onboarding/IntroOverlay.tsx
onboarding/illustrations.tsx
views/calendar/calendar.css
views/common/SegmentedSwitch.tsx
views/common/UnscheduledList.tsx
views/common/ViewSetupState.tsx
views/form/FormBuilder.tsx
views/form/FormFill.tsx
views/form/FormSurface.tsx
views/gallery/GalleryView.tsx
views/kanban/KanbanBoard.tsx
views/timeline/TimelineChart.tsx
```

Most hold Tailwind arbitrary shadows written with `rgb(15_20_30/...)`; `illustrations.tsx` has amber hexes and `calendar.css` an rgb shadow. No file has a literal px font size. The check also flags Tailwind palette colours (`bg-white`, `border-slate-200`) and `hsl()`; use `bg-paper`, `bg-scrim`, `bg-hover` or `border-fg/10`.

## Destructive MCP tools (AGT-4)

Full table with reasons: `docs/mcp.md`, section "Destructive tools and what can be undone". Checked by the unit test `every_destructive_tool_says_whether_it_can_be_undone` (the `RECOVERABLE` and `PERMANENT` lists in `crates/server/src/mcp/tools.rs`); a new destructive tool must be added there and to the docs table. No tool, token or endpoint erases a workspace or project for good: only the daily retention purge (`OPENBASE_TRASH_DAYS`, default 30) does, and `delete_workspace` and `delete_project` report the trash, the `restore_with` call and the purge date. A workspace's top-level project cannot be deleted at all (409) until another folder takes its place.

Recoverable with `restore_from_trash` (kind and id), until the purge:

- `delete_workspace` (kind workspace)
- `delete_project` / `delete_base` (kind project)
- `delete_table` (table)
- `delete_field` (field)
- `delete_view` (view; its share links are not restored)
- `delete_records` (record)

Not recoverable (the description says "This can't be undone"):

- `delete_share_link` (create a new link)
- `delete_automation` (its run history goes too)
- `delete_inbox_item` (drafts have no trash)
- `revoke_invite` (create a new invite)
- `remove_member` (invite the person again)
- `update_field` with a type change (values that do not fit are lost; asks for `confirm_conversion` first)
- `update_automation` (the replaced trigger and actions are lost)
- `file_inbox_item` (the draft becomes a record)

Overwrites, listed in the docs only: `update_view` (replaced config parts are lost) and `update_records` (the history shows the old values). `api_request` is as recoverable as the endpoint it calls: records, fields, tables, views, projects and workspaces go to the trash; comments (`DELETE /api/comments/{id}`, no MCP tool), share links, automations, invites and inbox drafts do not; `POST /api/tables/{id}/records/{rid}/discard` erases a record you created in the last 24 hours that nobody touched, with no trash entry.

## Decisions

- 2026-11-07: Work happens in the main checkout on `ux-overhaul`; parallel phases use worktrees merged back into it.
- 2026-11-07 (SEC-1): `webauthn-rs` and `webauthn-authenticator-rs` moved from `=0.6.1-dev` to `=0.6.2`, which clears RUSTSEC-2026-0387 (crypto-bigint). Only RUSTSEC-2023-0071 (rsa) stays ignored in `deny.toml`, with its reason and the re-check date 2027-02-07. The spec said two ignores; one remains.
- 2026-11-07 (SEC-1): Minimum Rust version raised from 1.85 to 1.89 (`workspace.package.rust-version`): time >= 0.3.47 needs 1.88 and webauthn-rs 0.6.2 needs 1.89. The newer rust-version turns on three clippy style lints across `crates/core` and `crates/server` (about 20 sites); they are allowed in `[workspace.lints.clippy]` in the root `Cargo.toml` and can be fixed in a cleanup commit.
- 2026-11-07 (SEC-2): `minimatch` forced to >= 11.0.1 through an `overrides` entry under Glide, as the spec says; Glide was not downgraded.
- 2026-11-07 (SEC-3): The spec's Node 24 is no longer the active LTS: Node 26 entered LTS on 2026-10-28. CI, release, the Dockerfile and docs use Node 26. `site/.node-version` stays on 24 because the site deploys on Cloudflare Pages, whose build image may not offer 26 (the site builds on 26 in Docker; revisit).
- 2026-11-07 (SEC-3): Trivy runs with `--ignore-unfixed` locally and in CI. Without it the image shows 226 findings (225 high, 1 critical), all with no Debian fix, so the job could never go green. The runtime stage runs `apt-get upgrade` because the digest-pinned base lags Debian's security archive.
- 2026-11-07 (SEC-3): cargo-deny, gitleaks and Trivy are installed in CI by `scripts/ci-install-tool.sh` from the official releases against pinned SHA-256 sums, not marketplace actions (no gitleaks-action licence, no tag-rewrite supply-chain risk). Dependabot cannot bump those pins; the script header says to update them by hand now and then. `multiple-versions` is `allow` in `deny.toml` (about 30 RustCrypto duplicates out of our control). Both crates have `publish = false`.
- 2026-11-07 (SEC-4.7): The Docker builder stays on Debian 12 (`rust:1.99.1-bookworm`) so release binaries run on glibc 2.36; only the runtime moved to Debian 13. A Rust image bump fails the Docker build until `rust-toolchain.toml` changes too, on purpose.
- 2026-11-07 (SEC-4.4): HSTS is `max-age=31536000` only (no includeSubDomains, no preload), matching the bundled Caddyfile. CORP same-origin applies to every response. COOP same-origin applies everywhere except `/oauth/authorize`, `/login`, `/login/2fa` and `/oauth/consent`, so a popup-based OAuth client keeps `window.opener`; whether Claude or ChatGPT use a popup is unverified, so the exception is kept. Recorded in `docs/security.md` and CHANGELOG as an exception to SEC-4.4.
- 2026-11-07 (SEC-4.2): After review the guess cap counts only confirmed wrong guesses (a right guess never locks or counts), uses a sliding window, holds places for in-flight checks without locking, and after a lockout lets guesses through one at a time (a wrong one re-locks). A queue of 100 or more simultaneous checks can give new requests a transient 429 with no lock; documented in `docs/security.md`.
- 2026-11-07 (SEC-4.5): Sessions older than 14 days that never refreshed `last_seen_at` are signed out once at upgrade over plain http (over https everyone is signed out by the cookie rename); in the CHANGELOG Security section.
- 2026-11-07 (SEC-4.6): No code change was needed (HEAD already passed the peer as `ConnectInfo`); comment and mutation-checked tests added.
- 2026-11-07 (gate, e2e): The Playwright suite had not been run since the Oct 24-28 UI changes, and failed at the Phase 0 gate on tests that no longer matched the app, not on anything Phase 0 changed (web/src changed only in the share-password files). Fixed in bd230b8: `journey` adds and names each record (a blank new record is taken back when the next is added); `grid` row numbering counts each group's Add row; `sharing` form preview button is clickable ("Try the form"); `views` kanban keyboard test waits for the "Picked up" announcement, the list group Add is a tree item, and the timeline lane test scrolls its bar into view (its start is relative to today, and today is a Sunday); `dateGroups` list headers are tree items named "<group>, <n> records".
- 2026-11-07 (gate, product fix): The same run exposed a real bug (406874e): undoing the add of a record that the grid had just taken back as untouched raced the take-back and ended in a "Could not undo" error toast. Undo of a single add now treats a 404 as already gone, and `useRecordWrites` forgets a record once undo or delete removes it so it is not looked up again. A race remains between the grid's take-back and Undo that makes the browser log one 404 in either order; `grid.spec.ts` allows that one line and the cause (the grid's `fresh` tracker is separate from `useRecordWrites`) should go away with the Phase 4 grid rebuild (COL-7).

- 2026-11-08 (DL-1): The token check's temporary list is `scripts/check-tokens.temporary-list.txt` (16 files). A frozen baseline, `scripts/check-tokens.baseline.txt`, stops it from growing (FE1-4). `src/test/` is exempt as test support; `hsl()` and Tailwind palette colour utilities are flagged along with hex and `rgb()`; arbitrary rem sizes (`text-[0.8125rem]`) are not flagged, because the spec says px only. The detector's tests live in `web/src/styles/checkTokens.test.mjs` because Vitest only serves `web/`.
- 2026-11-08 (DL-1): Radius tokens replace Tailwind's own names globally (xs 4, sm 6, md 8, lg 12, xl 16), so old screens get slightly rounder until they move. Tokens are in rem. Phone type variants are separate tokens (`text-read-phone` and so on). `--default-transition-duration` is now 120 ms on the enter curve. Under reduced motion every transition is limited to opacity at 120 ms. `src/lib/cn.ts` knows the new class names; add new token classes there too.
- 2026-11-08 (DL-1, FE1-5): New tokens `--paper` (white in both themes: QR quiet zone, switch thumb) and `--scrim` (dark wash behind a mark on a picture) replaced `bg-white` and `bg-black/60`; swatch borders use `border-fg/10`.
- 2026-11-08 (DL-3): Entity colour is the `hue` prop on core components (`null` draws the hashed fallback mark, `undefined` none). `DropdownMenu*` is the Menu and `PopoverContent` the Popover, no parallel components. `PopoverContent` defaults to 6 px padding; callers that need more set it. `DESKTOP_QUERY` lives in `hooks/useMediaQuery.ts`. Dialog is a full-screen sheet on phone (`phone="bottom"` gives a bottom sheet; ConfirmDialog uses it). Toast sits bottom-left on desktop and above `--bottom-nav-height` on phone: the Phase 3 tab bar must set that variable. FilterBar always uses a Popover for suggestions; PH-3's bottom sheet is Phase 4. EmptyState keeps `icon` and `description` as deprecated props until the screens move.
- 2026-11-08 (DL-3): `AnchoredMenu` restores focus to what had it when the menu opened, once the menu has left, unless something else has focus by then. Without it a menu delete in the grid left focus on the page and Ctrl+Z did nothing (found by the e2e run, fixed in dfbc3eb).
- 2026-11-08 (DL-4): Icon sizes: md 16 desktop and 20 phone, `sm` 12 inside chips and checkboxes, `fit` for spinners. The 140 files that use lucide directly move with their screens; only `components/ui` is scanned.
- 2026-11-08 (DL-2): The design page is gated at compile time (`import.meta.env.DEV || VITE_DESIGN_PAGE === "1"`), registered outside `RequireAuth`, and absent from release builds. Themes are forced on a subtree with `data-theme-scope`; modal pieces are drawn open in frames through a `PortalHost` context. Screenshots are PNG8, taken in 4000 px strips because Chrome cannot capture over 16384 px at once.
- 2026-11-08 (BE-1, BE-V1-1): Decision 1 (every workspace has a top-level project) forces two differences in v1 `meta/bases` against DONE-8's wording: the top-level project added to workspaces that had no live project, and the empty one every new workspace starts with. Accepted; documented in docs/api.md and the CHANGELOG, tolerated explicitly in `v1_golden.rs`. The new Page property also appears in v1 table metadata.
- 2026-11-08 (BE-1, BE-MIG-2): Migration 0016 never uses a table's title as its Page: "exactly one live rich_text field" means one besides the primary field; a table whose only rich text is its title gets a new hidden "Page" (first free of Page, Page 2, ...). Tables in the trash and tables with 500 fields get none.
- 2026-11-08 (BE-1, HOME-5, BE-MIG-1): Home date and Done presets go by name priority in the spec's order, then table order (so Due beats Start); only date properties count for the date and only checkbox for Done; trashed tables get presets too.
- 2026-11-08 (BE-1): The new top-level project of a workspace with no live project is made by the SQL migration; members limited to a list of projects are not given it. New workspaces create theirs in `store::workspaces::create`; new tables take the next colour of ten and get a hidden Page; a view created with no config hides the Page and a view created with a config gets it appended to `hidden_fields` unless the config names it; a form leaves it out.
- 2026-11-08 (BE-1, DATA-1): Migration 0017 adds `fields.trashed_setting` (not an edit to 0016, which may already have run). Restoring a trashed Page, Home date or Done property gives the table its setting back if nothing took its place. Schema version is 17.
- 2026-11-08 (BE-5): The page can be written in a collection with no Page through `PUT /api/tables/{id}/records/{rid}/page` (adds "Page" in the same save, REST only); `POST /api/tables/{id}/body-field` takes `{field_id}` (null clears) or `{create: true}` and refuses a body with neither. A Home date may be any date-like property (date, created or last-modified time, formula or rollup resulting in a date; not a lookup); Done must be a checkbox. Settings clear with their property (retype, delete, becoming the title).
- 2026-11-08 (BE-6): History folds only for `WriteSource::Api` single-field text or rich text edits within a sliding 10-minute window by the same person on the same unchanged cell; a fold back to the first value removes the row (DATA-2).
- 2026-11-08 (BE-7): `week_start` is 0 (Sunday) or 1 (Monday) on the profile and on the query, aggregate and export requests (400 otherwise); the Airtable-compatible v1 API is unchanged and uses the profile; automations use their creator's; the MCP `aggregate_records` tool has no `week_start` argument and uses the caller's profile. Calendar-week operands only work with `is_within`.
- 2026-11-08 (BE-3, HOME-11): No index was needed (86 ms against 300 ms). Home reads whole collections within search's 100,000-record and 100-collection budget and sets `truncated` when it skips one; more than 50 due records is not truncation. Responses add `today`, `timezone`, `can_edit`, `done_field_id` and names and colours. Any member can read Home; a project-limited token gets an empty `drafts`.
- 2026-11-08 (BE-9, SEC-P2-1): The workspace stream never relays presence; creating or duplicating a project publishes `base_changed`; at most 20 streams per user (429 after); the project-to-workspace lookup is cached process-wide so other workspaces' changes cost no reads. Catalogued as Blocked like the per-project stream.
- 2026-11-08 (BE-8, BE-12): Search skips fenced `openbase` blocks in rich text (a small scanner in ob-core, rich text only). A transient override drops a saved row colour with `{mode: by_conditions, rules: []}` and replaces all summaries with a map (`{}` drops them); drafted fields must be shown fields on public shares. The MCP `query_view` tool takes no `transient`; `api_request` reaches it.
- 2026-11-08 (BE-2): `list_icons` says the app no longer displays icons; `icon_schema` (the per-tool icon argument text) is unchanged.
- 2026-11-08 (BE-11): The unused `invite` notification kind is gone from the app and docs; stored rows, if any, render as a generic notification. Migration 0001's comment is untouched.
- 2026-11-08 (AGT-2): Change access (`PATCH /api/oauth/grants/{id}`) is session-only with no MCP tool or `api_request` reach, so an agent cannot raise its own access. The consent default is what the app asked for (Read when it named nothing). An app limited to some projects cannot have Full control, in consent and in Change access (SEC-P2-2). The refresh endpoint still rejects a `scope` that differs from the grant's.
- 2026-11-08 (AGT-3, AGT-4): `create_workspace` returns `workspace_id` and `top_level_project` beside the unchanged summary. Delete results keep `deleted` and `note` and add `trashed`, `restore_with`, `purge_after` and `retention_days`; REST responses are unchanged. `remove_member`, `revoke_invite`, `update_field` type change, `update_automation` and `file_inbox_item` also say "This can't be undone".
- 2026-11-08 (BE-10): `connectWorkspaceEvents` is the client for the workspace stream. The contract servers raise the MCP rate limits (the Rust `mcp_*` tests keep covering them). MCP calls for contract tests live in `web/contract/mcpClient.ts`.
- 2026-11-08 (gate, e2e): The Playwright suite follows Phase 2: a new workspace opens its top-level project (the journey renames it "Journey base" through the API), the grid's hidden-field button counts the hidden Page ("1 hidden field" from the start), and a client that replaces a view's `hidden_fields` keeps the Page in the list (CSV export). The Share dialog's "N hidden fields" counts the Page too until APP-8 redoes it.
- 2026-11-08 (parallel chains): The shared `CARGO_TARGET_DIR` gave two worktrees the same unit directory for the workspace crates, so one could link the other's library. Use per-package `codegen-units` overrides or separate target dirs when two worktrees build at once; the main checkout's `target/` is not affected.

## Blocked

(none)

## Scans not run locally

Everything in the Phase 0 gate ran locally. These did not, and must pass in CI before the pull request (DONE-11):

- The GitHub Actions jobs `secrets` (gitleaks), `image` (Docker build + Trivy with the `TRIVY_DB_REPOSITORY` mirror list and the gha layer cache) and the cargo-deny install step in the checks job: not run on a runner. The workflow YAML parses; the install script was run in an amd64 Debian container and each scan command was run here.
- The multi-arch release path (`release.yml`, arm64 native/cross builds, the `binary` and `runtime-prebuilt` Dockerfile targets) and the amd64 image: only the default target was built, on this machine's native arm64.
- `gitleaks dir` on the working tree was not used (it scans build artefacts); the history scan is the real one.
- The Playwright suite ran in the local Google Chrome only; CI runs it on Linux (`ubuntu-24.04`, Node 26) as well.
- Phase 1 and 2 added no dependencies, so `cargo deny` and `npm audit` results are those of `scripts/check.sh` below; the three CI-only scans (gitleaks, Trivy image, multi-arch release) were not re-run after Phase 0.
- The Home benchmark (`home_perf.rs`, `#[ignore]`) is not part of `scripts/check.sh`; it ran once in release mode (86 ms). The Phase 6 gate must run it again with the UI.
- Not checked on a phone or real device: the toast, sheet and help-tip fixes (FE1-1 to FE1-3) are covered by jsdom tests and the design page in desktop Chrome only.
- Weeks tests in `web/contract/weeks.contract.test.ts` take their expectations from the machine clock in UTC and could flake if a run straddles midnight UTC; the Rust tests were run on a Sunday and compute their dates relative to it.

## Last green check run

- Date: 2026-11-08.
- Commit: `ea73149` on `ux-overhaul`.
- `OPENBASE_E2E=1 scripts/check.sh`: exit 0, "All checks passed." (cargo fmt --check, clippy -D warnings, cargo deny check, npm audit --audit-level=high, token check, web build, cargo test: 2408 passed 0 failed, generated bindings/icons/brand checks, tsc, vitest: 166 files and 2703 tests, contract tests: 16 files and 387 tests, Playwright: 72 passed). This is the Phase 1 and 2 gate run; before it, the first run of the same command failed on e2e tests that no longer matched Phase 2 (fixed in dfbc3eb and 03904d1).
- Earlier in the same session (Phase 0 gate, 2026-11-07, `bd230b8`): `docker build -f deploy/Dockerfile -t openbase:scan .` then `trivy image --scanners vuln --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 openbase:scan`: 0 findings; `gitleaks git --redact --no-banner`: 487 commits, no leaks. Not re-run for Phase 1 and 2 (no dependency or image change).
