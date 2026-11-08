# UX overhaul: progress

Spec: [2026-11-07-ux-overhaul.md](2026-11-07-ux-overhaul.md). Branch: `ux-overhaul`, cut from `main` at `ccadee6`.

A fresh agent resumes from this file alone: read the spec, then the sections below, then continue with the first requirement whose status is not `done` in the current phase.

## Current phase

Phase 1 + 2 · Foundation and Backend (not started). Phase 0 passed its gate on 2026-11-07 (see Phase gates).

## Phase gates

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 · Security first | passed 2026-11-07 | At `bd230b8`: `cargo deny check` ok (advisories, bans, licences, sources; one ignore, RUSTSEC-2023-0071); `cd web && npm audit --audit-level=high` 0 vulnerabilities; `gitleaks git --redact` 487 commits, no leaks; Trivy on the freshly built `deploy/Dockerfile` image (`openbase:scan`, Debian 13.7) 0 findings with `--scanners vuln --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1`; `OPENBASE_E2E=1 scripts/check.sh` exit 0 ("All checks passed."). Every SEC-4 item has tests or a recorded manual check (SEC-4.7). The GitHub Actions jobs for the scans must still go green in CI before the pull request (DONE-11; see Scans not run locally). |
| 1 · Foundation | not started | |
| 2 · Backend | not started | |
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
| DL-1 | 1 | not started | |
| DL-2 | 1 | not started | |
| DL-3 | 1 | not started | |
| DL-4 | 1 | not started | |
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
| HOME-5 | 6 | not started | |
| HOME-6 | 6 | not started | |
| HOME-7 | 6 | not started | |
| HOME-8 | 6 | not started | |
| HOME-9 | 6 | not started | |
| HOME-10 | 6 | not started | |
| HOME-11 | 6 | not started | |
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
| AGT-1 | 2 | not started | |
| AGT-2 | 2 | not started | |
| AGT-3 | 2 | not started | |
| AGT-4 | 2 | not started | |
| AGT-5 | 2 | not started | |
| AGT-6 | 2 | not started | |
| BE-1 | 2 | not started | |
| BE-2 | 2 | not started | |
| BE-3 | 2 | not started | |
| BE-4 | 2 | not started | |
| BE-5 | 2 | not started | |
| BE-6 | 2 | not started | |
| BE-7 | 2 | not started | |
| BE-8 | 2 | not started | |
| BE-9 | 2 | not started | |
| BE-10 | 2 | not started | |
| BE-11 | 2 | not started | |
| BE-12 | 2 | not started | |

## Definition of done

| Id | Status | Evidence |
| --- | --- | --- |
| DONE-1 | not done | |
| DONE-2 | not done | |
| DONE-3 | not done | |
| DONE-4 | not done | |
| DONE-5 | not done | |
| DONE-6 | not done | |
| DONE-7 | not done | |
| DONE-8 | not done | |
| DONE-9 | not done | |
| DONE-10 | not done | |
| DONE-11 | not done | |
| DONE-12 | not done | |

## Screen ledger

| # | Screen or surface | Where | Requirements | Phase | Status | Screenshots |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Design reference | `/__dev/design` | DL-1 to DL-4 | 1 | not moved | |
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

## Destructive MCP tools (AGT-4)

(Filled in Phase 2.)

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

## Blocked

(none)

## Scans not run locally

Everything in the Phase 0 gate ran locally. These did not, and must pass in CI before the pull request (DONE-11):

- The GitHub Actions jobs `secrets` (gitleaks), `image` (Docker build + Trivy with the `TRIVY_DB_REPOSITORY` mirror list and the gha layer cache) and the cargo-deny install step in the checks job: not run on a runner. The workflow YAML parses; the install script was run in an amd64 Debian container and each scan command was run here.
- The multi-arch release path (`release.yml`, arm64 native/cross builds, the `binary` and `runtime-prebuilt` Dockerfile targets) and the amd64 image: only the default target was built, on this machine's native arm64.
- `gitleaks dir` on the working tree was not used (it scans build artefacts); the history scan is the real one.
- The Playwright suite ran in the local Google Chrome only; CI runs it on Linux (`ubuntu-24.04`, Node 26) as well.

## Last green check run

- Date: 2026-11-07 (the run crossed local midnight).
- Commit: `bd230b8` on `ux-overhaul`.
- `OPENBASE_E2E=1 scripts/check.sh`: exit 0, "All checks passed." (cargo fmt --check, clippy -D warnings, cargo deny check, npm audit --audit-level=high, web build, cargo test: 2228 passed 0 failed, generated bindings/icons/brand checks, tsc, vitest: 158 files and 2310 tests, contract tests: 14 files and 340 tests, Playwright: 69 passed).
- `docker build -f deploy/Dockerfile -t openbase:scan .` then `trivy image --scanners vuln --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 openbase:scan`: 0 findings, exit 0 (Debian 13.7).
- `gitleaks git --redact --no-banner`: 487 commits, no leaks.
