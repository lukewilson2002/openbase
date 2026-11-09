# UX overhaul: Phase 8 security audit

Branch `ux-overhaul`. Audited commit `d81062c` (the end of Phase 7); the full suite ran at `1d7ab68` with the two generated bindings files, committed unchanged afterwards as `87be643`. Written 2026-11-09.

## Result

- **Critical: 0. High: 0 open (6 found, 6 fixed).** The scan rated nothing Critical.
- **Medium: 35 found. 34 fixed, 1 recorded** (F10, the first sign-up becomes the administrator; docs/security.md, Accepted risks).
- **Low: 27 found, 27 fixed.** Some fixes leave a narrower residual risk, recorded in docs/security.md (listed under "Recorded instead of fixed").
- **The independent re-audit the spec calls for was NOT run.** See "What was not done". The Definition of done item DONE-12 therefore stays open.
- Full suite on the fixed branch: `OPENBASE_E2E=1 scripts/check.sh` exit 0 (at `1d7ab68` plus the two generated files committed as `87be643`).

## Scope and method

Two independent readings of the branch were done by agents that did not write the Phase 1 to 7 code or the fixes.

**1. Claude Security full scan.** A whole-repository scan of commit `d81062c206f2` started 2026-11-09 at 14:04 UTC at `high` effort, focused on production code an attacker can reach. Verification status: "verified". The inventory split the 1,844 tracked files into 17 components; 127 researchers were dispatched (two per component and category, two breadth sweeps and a secrets pass) and all 127 returned. Every candidate went to a three-lens panel (reachability, impact, defenses) and needed two of three votes to survive: 63 findings survived 3 of 3 and 5 survived 2 of 3 (F4, F16, F46, F50, F65). Result: **68 findings, 0 critical, 6 high, 35 medium, 27 low.** Several findings are the same defect found by different researchers; the table below groups them.

What the scan did not cover, and what it could not see (from the report's own Coverage section):

- **Skipped on purpose:** `web/contract` and `web/e2e` (test code), the lockfile, manifest and tool config in `web/`, `crates/server/tests`, `docs`, and `brand`.
- **Memory safety was not asked about.** The workflow decided from the inventory's language alone, before the researchers were briefed, that the web, `site` and `deploy` components were managed-language code, so none of those researchers was asked about memory-safety bugs. The Rust crates were not covered by that decision.
- **Partial reading.** By the researchers' own account (not checked as fact), of 1,256 tracked files inside the components 486 were read to a conclusion, 741 lie under a path a researcher declared not reached, and 29 were accounted for by nobody (all unit tests). 588 tracked files lie outside every component.
- **Web components were sink-searched, not read.** `web/src/views`, `web/src/components/record`, `web/src/components/richtext`, `web/src/pages/account`, `web/src/pages/admin` and `web/src/pages/history` were searched for dangerous sinks rather than read file by file. A defect that is not a known sink pattern in those directories could have been missed.
- **A gap in the formula and cell code.** For the `core-formula-cell` component, one researcher (the injection-and-input lens) read `crates/core/src/formula` and `crates/core/src/cell` but its results were not delivered, because a safety classifier stopped its response. Its empty result is not a clean result for that reading; the other researcher on that component did return. That lens of that code has no second reading.
- **Nothing was executed.** The scan read code. It fired no exploit and ran none of the repository's code. Each finding is derived from reading; the fix agents confirmed each one against the current code and wrote a regression test.
- The scan is nondeterministic and complements dependency scanning, SAST and code review; another run may surface other issues. A "verified" status covers the panel's work on the findings; it does not mean the skipped or unread areas are clean.

**2. Manual checklist audit** of the spec's list (section "Final security audit (Phase 8)"), run read-only by a separate agent at `d81062c`. It found nothing at any severity. Summary below.

### Spec checklist, items 1 to 6

1. **Scans again.** `cargo deny check` ok (advisories, bans, licences, sources; the one ignore, RUSTSEC-2023-0071, is unchanged from main). `npm audit --audit-level=high`: 0 vulnerabilities. gitleaks over `main..ux-overhaul`: 299 commits, no leaks; whole history (767 commits): no leaks. Trivy on the built image: see the note under "Scans re-run" (225 High and 1 Critical with no fix available; 0 with the project's `--ignore-unfixed` gate).
2. **New and changed endpoints.** Home (`GET /api/workspaces/{id}/home`), top-level, body-field, the table settings, the page endpoint, `week_start`, and the workspace event stream were each read for authorization, input checks and errors. Home filters every project through `require_base(Viewer)`, so a token's project limit and read-only cap apply. The stream relays only projects the caller can open, re-reads access every 60 seconds and after a lag, ends when the person leaves the workspace or the credential is gone, and every removal path publishes `base_changed`. The audit agent ran its own throwaway experiment (3 of 3 passed, then deleted) for removal through the project-level endpoint, a deleted token, a deactivated user, a sign-out, and cross-workspace isolation. Existing tests: `events_workspace` 14 of 14. A credential that ends silently (deactivation, token deleted, sign-out) can take up to 60 seconds to close an open stream; this is documented in docs/security.md and matches the per-project stream.
3. **Agent access.** Change access (`PATCH /api/oauth/grants/{id}`) is session-only, needs Manage to grant Manage, looks the grant up by id and user, cannot exceed the person's own role, is covered by the CSRF guard and writes an audit entry. Consent needs an explicit `access` choice. Project and workspace deletes need Owner plus the matching token capability and are soft deletes; no route purges. Tests: `oauth_change_access` 10 of 10, `oauth_flow` 49, `oauth_mcp` 27, `token_capabilities` 17.
4. **Embeds.** Parsing is strict (info string `openbase`, at most 512 characters, one JSON object with the documented keys, id patterns, limit 1 to 50). The renderer never puts the block's text into HTML, live places carry a per-render nonce, and all output passes DOMPurify. A reader sees only views the server returns for them in the current workspace; share pages, forms and comments show the static box.
5. **Client state.** Drafts in localStorage are keyed per person and view and hold only the view's changes (no tokens or credentials). The phrase parser and type guesser contain no `eval`, `new Function`, `innerHTML`, `fetch` or `import()`; every `new RegExp` is built from constants. The only HTML sink is `dangerouslySetInnerHTML` in `Markdown.tsx`, fed by DOMPurify.
6. **Phase 0 (SEC-4) regression.** CSRF Origin check, share-link password minimum and per-link limits, the separate hashing slots, security headers, the `__Host-` session cookie with idle timeout, the real client address for MCP, and the pinned images and toolchains all still hold. `security_hardening` 23 of 23; `ratelimit` and `password` lib tests 20 of 20.

Item 7 (rate each finding) is the table below. The checklist audit found no issues, so every finding comes from the scan.

## Findings

All 68 findings, grouped so that one defect is one fix. "Commit" is the code commit; the docs commit follows it. Severities are the scan's.

| Id | Severity | One-line reason | Status | Commit or docs reference |
| --- | --- | --- | --- | --- |
| **A. A share link's visitor could replace the view's saved filter (one defect, 4 reports)** | | | | |
| F1 | High | an anonymous query's `transient.filter` replaced the saved filter, so a link exposed every row of the table | Fixed | 9d1c8ca; docs 0a72c80 |
| F7 | Medium | same defect, reported again | Fixed | as above |
| F24 | Medium | same defect, reported again | Fixed | as above |
| F29 | Medium | same defect, reported again | Fixed | as above |
| **B. The administrator role granted by a token (one defect, 9 reports)** | | | | |
| F4 | High | a manage token could create an administrator on a mailbox it controls and claim it through Forgot password | Fixed | 4eb57b6; docs f923679 |
| F5 | High | a manage token could promote an account to administrator, past the session-only boundary | Fixed | as above |
| F13 | Medium | MCP `admin_create_user` reached the same path | Fixed | as above |
| F15 | Medium | same defect, reported again | Fixed | as above |
| F17 | Medium | same defect, reported again | Fixed | as above |
| F19 | Medium | same defect, reported again | Fixed | as above |
| F23 | Medium | same defect, reported again | Fixed | as above |
| F25 | Medium | same defect, reported again | Fixed | as above |
| F26 | Medium | same defect, reported again (also through a Full control OAuth grant) | Fixed | as above |
| **C. Outgoing mail pointed at another server by a token (one defect, 3 reports)** | | | | |
| F9 | Medium | a token could change the SMTP host while no password was stored and read reset mail | Fixed | 4eb57b6; docs f923679 |
| F14 | Medium | same defect, through MCP `admin_update_email_settings` | Fixed | as above |
| F16 | Medium | same defect, reported again | Fixed | as above |
| **D. Filter parsing cost (3 defects)** | | | | |
| F2 | High | a nested filter was copied at every level while parsing, so one anonymous body forced gigabytes of allocation | Fixed | 72afe54, f0f3c38, 466a213; docs a480824 |
| F28 | Medium | an id-list operand was copied and scanned for every row (same defect as F30) | Fixed | as above |
| F30 | Medium | same defect, reported again | Fixed | as above |
| **E. Formula evaluation limits** | | | | |
| F3 | High | REGEX_REPLACE built an expansion with no size check, so one formula could abort the server on allocation failure | Fixed | ae3218c, 4549c2d, 9a2ee1b, 58165e4, 237a3fc; docs ad65572 |
| F40 | Medium | the regex work budget did not grow with the size of the compiled pattern | Fixed | as above |
| F27 | Medium | the DATETIME_PARSE tokenizer was quadratic on unclosed brackets and took any format length | Fixed | as above |
| F39 | Medium | the parse cache was bounded by count only, so an Editor could pin gigabytes | Fixed | as above |
| F41 | Medium | filterByFormula requests could hold every reader connection and starve all reads | Fixed | as above |
| F44 | Low | dates at the edge of the range reached a panicking chrono call | Fixed | as above |
| F63 | Low | same family as F44: a date plus a zone offset panicked and stopped the volatile refresh of later bases | Fixed | as above |
| **F. Automation templates (one defect in 4 reports, plus 2 related)** | | | | |
| F43 | Low | a dot-only value passed URL escaping and moved the request to a parent path | Fixed | 7f32fea, 069dced; docs 9c239a1 |
| F61 | Low | same defect as F43, reported again | Fixed | as above |
| F64 | Low | same defect as F43, reported again | Fixed | as above |
| F68 | Low | same defect as F43, reported again | Fixed | as above |
| F11 | Medium | no total size cap on rendered JSON, so one webhook body was copied once per placeholder | Fixed | as above |
| F60 | Low | a recipient list was split after substitution, so a value could add recipients | Fixed | as above |
| **G. Invite confirmation (one defect, 4 reports)** | | | | |
| F18 | Medium | an email-restricted invite trusted a self-typed address | Fixed | 8c545b2; docs e3a65ea |
| F36 | Medium | same defect, reported again (open sign-up variant recorded) | Fixed | as above |
| F45 | Low | same defect, reported again | Fixed | as above |
| F52 | Low | same defect, reported again | Fixed | as above |
| **H. Reset links outlive a password change (one defect, 3 reports)** | | | | |
| F47 | Low | a password changed from the command line left reset links valid | Fixed | 8c545b2; docs e3a65ea |
| F48 | Low | same defect, reported again | Fixed | as above |
| F53 | Low | same defect, reported again | Fixed | as above |
| **I. Invites and the workspace boundary** | | | | |
| F42 | Low | an invite could be pointed at a base of another workspace, so a demoted creator's invite stayed live | Fixed | 8c545b2; docs e3a65ea |
| F57 | Low | accepting an invite granted trashed bases its creator could no longer open | Fixed | as above |
| **J. Account hardening** | | | | |
| F51 | Low | turning on two-factor needed no password or fresh session | Fixed | 8c545b2, 58530f7; docs e3a65ea |
| F58 | Low | a flood of other limiter keys evicted per-account sign-in counters | Fixed | as above |
| F59 | Low | a percent-encoded look-alike of the session cookie name was accepted | Fixed | as above |
| F8 | Medium | an authorization request problem redirected to a client's registered address with no session | Fixed | as above |
| **K. First-run administrator** | | | | |
| F10 | Medium | the first sign-up on an uninitialised server becomes the administrator with no setup secret | Recorded | docs/security.md (Accepted risks); docs e3a65ea |
| **L. Files, uploads and previews** | | | | |
| F50 | Low | a public form could attach a file a member had uploaded | Fixed | 9d1c8ca, 8b097ea, 1310731, 8d956de, 069dced; docs 0a72c80, 9c239a1 |
| F6 | High | a PDF that states a huge image size aborted the server while rendering a preview | Fixed | as above |
| F62 | Low | the CSV guard looked only at the first character of a cell | Fixed | as above |
| F49 | Low | webhooks and schedules of a trashed base kept running | Fixed | as above |
| F38 | Medium | Azure's platform address was not on the automation target deny-list | Fixed | as above |
| **M. Records, people and the MCP read path** | | | | |
| F12 | Medium | an Editor could restore records others deleted through Undo | Fixed | ebacbae, 9d1c8ca; docs 923fa25, 0a72c80 |
| F21 | Medium | list_activity resolved people among all of the owner's workspaces despite a token's project limit | Fixed | as above |
| F22 | Medium | same defect as F21, reported again | Fixed | as above |
| F33 | Medium | same defect as F21, reported again | Fixed | as above |
| F46 | Low | converting text to a User property stored arbitrary user ids | Fixed | as above |
| F54 | Low | same defect as F46, reported again | Fixed | as above |
| F65 | Low | same defect as F46, reported again | Fixed | as above |
| F55 | Low | public share responses carried user ids inside rich text mentions | Fixed | as above |
| **N. Resource limits (queries, icons, aggregates, rich text)** | | | | |
| F37 | Medium | aggregate sort accepted an unbounded list | Fixed | 3d46ec2, 3aff713, 26b3980; docs a480824 |
| F20 | Medium | list_icons took an uncapped query and blocked a worker | Fixed | as above |
| F34 | Medium | nested rich text lists allocated memory quadratic in depth when a property's type changed | Fixed | as above |
| **O. Web: rich text styling and long runs of spaces** | | | | |
| F31 | Medium | raw HTML in Markdown kept its class attribute and could cover the screen with the app's own utility classes | Fixed | d325766; docs 1d7ab68 |
| F32 | Medium | same defect, reported again | Fixed | as above |
| F66 | Low | same defect, reported again | Fixed | as above |
| F67 | Low | same defect, reported again | Fixed | as above |
| F35 | Medium | a quadratic line-break pattern let a stored text freeze the grid | Fixed | as above |
| F56 | Low | a quadratic paragraph pattern let a stored text freeze a browser tab | Fixed | as above |

Counts by severity and status: High 6 fixed; Medium 34 fixed and 1 recorded; Low 27 fixed.

Evidence for each group (regression tests, which fail without the fix according to the fix agents unless noted under "Re-test evidence"):

- **A share link's visitor could replace the view's saved filter (one defect, 4 reports)**: the shared query sink refuses `transient.filter` for an anonymous viewer (400); `an_anonymous_transient_filter_cannot_widen_the_saved_filter`
- **The administrator role granted by a token (one defect, 9 reports)**: `create_user` and `update_user` refuse `is_admin: true` for any token or grant (403); `token_capabilities::admin_credential_actions_are_session_only`, `mcp_tools_people`
- **Outgoing mail pointed at another server by a token (one defect, 3 reports)**: host, port, security mode and username are session-only in every case; `admin_email::an_admin_manage_token_reads_and_edits_but_never_touches_the_password`, `mcp_tools_email`
- **Filter parsing cost (3 defects)**: F2: one-pass parser with depth and item limits (8 levels, 5,000 items) and a 64 KiB public query body; F28/F30: operand capped and compiled to a set once; `view::tests::deep_filters_are_refused_while_parsing`, `sharing::public_query_bodies_are_small_and_nested_filters_are_refused`, `query::tests::filter::an_id_list_is_capped_per_condition_and_per_filter`
- **Formula evaluation limits**: F3 `replace_stops_an_expansion_that_would_not_fit_before_building_it`; F40 `scan_cost_grows_with_the_size_of_the_pattern`; F27 `datetime_parse_format_is_capped_and_unclosed_brackets_are_cheap`; F39 `check_does_not_leave_the_expression_in_the_parse_cache`; F41 `formula_filters_are_limited_to_a_slot_each_and_a_few_in_all`; F44/F63 `formula_dates_stay_within_years_0_to_9999`, `a_panic_in_one_base_is_an_error_not_an_unwind`
- **Automation templates (one defect in 4 reports, plus 2 related)**: F43 family: refused at the URL escape sink, `a_dot_only_value_is_refused_in_a_url`; F11 `many_placeholders_for_one_large_value_hit_the_total_budget`; F60 `a_recipient_placeholder_is_one_address`, `send_email_refuses_a_substituted_value_that_adds_recipients`
- **Invite confirmation (one defect, 4 reports)**: an invite for one address needs a code mailed to it; `security_auth_phase8::an_invite_for_one_address_needs_a_code_mailed_to_it`, `five_wrong_codes_void_the_code`, `an_invite_for_one_address_is_refused_when_the_server_cannot_mail`. Residual (unverified account addresses): docs/security.md, Accepted risks
- **Reset links outlive a password change (one defect, 3 reports)**: every route that sets a password voids reset links; `changing_the_password_voids_reset_links`, `the_command_line_password_reset_voids_reset_links`
- **Invites and the workspace boundary**: `an_invite_cannot_be_pointed_at_a_base_of_another_workspace`, `trashing_a_base_the_creator_lost_does_not_revive_their_invite`
- **Account hardening**: F51 `an_old_session_confirms_the_password_to_turn_on_two_factor`; F58 `a_flood_of_other_keys_does_not_evict_account_counters`; F59 `a_percent_encoded_cookie_name_is_not_the_session_cookie`; F8 `problems_with_the_request_are_shown_and_never_redirected`. F58 residual (very many source addresses): docs/security.md, Accepted risks
- **First-run administrator**: docs/security.md, Accepted risks, 'The first account becomes the administrator'; operator guidance added to docs/self-hosting.md. A setup secret would change the first-run screen, so it is not built
- **Files, uploads and previews**: F50 `a_public_form_cannot_attach_a_file_a_member_uploaded` (a narrower residual recorded in docs/security.md, What a share link exposes); F6 `a_pdf_that_asks_for_terabytes_of_pixels_fails_its_preview_not_the_server` (Linux only: the cap is not enforced on macOS); F62 `guards_formula_injection_but_not_numbers`; F49 `a_webhook_of_a_trashed_base_or_workspace_answers_as_an_unknown_token`, `schedules_and_queued_runs_of_a_trashed_base_do_not_run`; F38 `forbidden_addresses`
- **Records, people and the MCP read path**: F12 `undo_restores_for_an_editor_only_the_records_they_deleted_themselves`; F21/F22/F33 `list_activity_resolves_people_only_among_those_of_the_projects_a_token_reaches`; F46/F54/F65 `text_naming_a_user_id_does_not_become_a_user_cell`; F55 `public_rich_text_shows_mentions_by_name_not_user_id`
- **Resource limits (queries, icons, aggregates, rich text)**: `the_sort_list_is_bounded_and_repeats_are_dropped`; `a_long_icon_query_is_refused_and_a_long_icon_name_is_bounded`; `deeply_nested_lists_do_not_blow_up_the_output`. A time or row budget for a view scan is not added: docs/security.md, Accepted risks
- **Web: rich text styling and long runs of spaces**: F31/F32/F66/F67 one class allowlist at the single sanitize sink (`Markdown.test.tsx`: drops every class text brings, keeps the classes its own formatting needs); F35 `draw.test.ts` oneLine and drawCellText; F56 `Markdown.test.tsx` long run of spaces next to media

## Fixes with commits

Code commits (31 commits in total since `d81062c`, including the docs commits):

- Share link: `9d1c8ca` (F1, F7, F24, F29, F55, F50); docs `0a72c80`.
- Query and limits: `72afe54` (F2), `466a213` (F28, F30), `f0f3c38` (F2), `3d46ec2` (F37), `3aff713` (F20), `26b3980` (F34); docs `a480824`.
- Formulas: `4549c2d` (F44, F63, F27), `ae3218c` (F3, F40), `9a2ee1b` (F39), `58165e4` (F41), `237a3fc` (F44, F63); docs `ad65572`.
- Administrator boundary: `4eb57b6` (F4, F5, F9, F13, F14, F15, F16, F17, F19, F23, F25, F26); docs `f923679`.
- Sign-in, invites, OAuth: `58530f7` (F8), `8c545b2` (F18, F36, F45, F52, F42, F57, F47, F48, F53, F51, F58, F59); docs `e3a65ea` (also F10).
- Automations and files: `8b097ea` (F6), `7f32fea` (F11, F43, F61, F64, F68), `069dced` (F38, F60), `8d956de` (F49), `1310731` (F62); docs `9c239a1`.
- Records and MCP: `ebacbae` (F12, F21, F22, F33, F46, F54, F65); docs `923fa25`.
- Web: `d325766` (F31, F32, F66, F67, F35, F56); docs `1d7ab68`.
- Gate: `87be643`, the generated `Filter` and `TransientConfig` TypeScript bindings. The Filter parser fix (F2) and the share-link rule (F1) changed Rust doc comments that the bindings carry; the fix agent regenerated the two files but did not commit them. `scripts/gen-types.sh --check` compares the files on disk, so it passed in the working tree, and it would have failed on a clean clone (CI). Committed here.

## Behaviour changes for tokens, agents and API clients

Dangerous abilities taken away from tokens (each refuses with a clear error that names what to do instead; documented in docs/mcp.md, docs/api.md, docs/security.md and CHANGELOG.md):

- **Granting the administrator role is session-only.** `POST /api/admin/users` and `PATCH /api/admin/users/{id}` with `is_admin: true` answer 403 for any token or OAuth grant, and so do MCP `admin_create_user` and `admin_update_user`. Taking the role away (`is_admin: false`) and creating ordinary users still work for tokens.
- **Pointing outgoing mail at another server is session-only.** Changing the SMTP host, port, security mode or username in `PATCH /api/admin/email` and `admin_update_email_settings` answers 403 in every case (before, only while a password was stored). A token can no longer do first-time mail setup. Tokens can still change the sender address and clear the host to switch email off.

Other changes a client or agent will notice (additions to contracts or stricter validation; v1 API and stored data unchanged):

- `POST /api/public/shares/{token}/query` answers 400 when the body has `transient.filter`; sorts, groups, search and the rest still work. The body is limited to 64 KiB (413). Public rich text shows mentions as `@Name`. A public form refuses a file a signed-in member uploaded (400).
- `POST /api/tables/{id}/records/restore` (Undo) answers 403 to an Editor for records another member deleted.
- Changing a property to the User type keeps values only from User, Created by and Last modified by properties; text is cleared.
- MCP `list_activity` resolves `person` only among people of the projects the token reaches. `list_icons` refuses a query over 200 characters. `aggregate_records` `sort` takes at most 23 entries (a repeated key is dropped).
- `POST /api/auth/signup` with an invite for one address mails an 8-digit code and answers 403 `email_code_required` until it is repeated with `email_code`; a server without email refuses such a sign-up. `GET /oauth/authorize` shows request problems on a 400 page instead of redirecting. `POST /api/auth/2fa/enable` takes an optional password and needs it from a session older than 10 minutes. Changing a password voids outstanding reset links. The session cookie is matched by its exact name.
- Automations: a template stops at 4 MB of copied values; a dot-only value in a URL and a recipient value containing a comma or semicolon fail the action; 168.63.129.16 is refused as a target; webhooks, schedules and queued runs of a trashed base stop until it is restored.
- PDF previews are produced by a memory-capped child process (the binary has a hidden `preview-pdf` subcommand; the Docker image needs `sh`, which Debian slim has). A PDF that needs more than the cap gets no preview and is still stored.
- Formulas: dates stay within years 0 to 9999; `DATETIME_PARSE` and `DATETIME_FORMAT` take a format of at most 1,000 bytes; `REGEX_REPLACE` checks an expansion before building it. `filterByFormula` answers 429 with `Retry-After: 1` when two filters are already evaluating on the instance or one is for the same user. CSV export guards a formula after an inner semicolon.
- Web: rich text keeps only the classes the renderer writes (`ob-*`, `language-*`); a run of 200 or more spaces is cut to 200 before Markdown reads it, and a grid cell draws at most 2,000 characters.

No MCP tool name or schema was removed or renamed; the parity test passes.

## What was not done: the independent re-audit

The spec says that after any fix the check suite runs again and the affected areas are re-audited. **That independent re-audit was NOT run.** The owner cancelled it on 2026-11-09 because of weekly usage. These fixes are therefore checked by their regression tests and the full suite only, not by a second reader. In particular nothing re-read the fixes for new defects (the larger changes are the invite confirmation code, the PDF child process, the one-pass filter parser, the cookie parsing and the limiter eviction change), and the gaps in the scan's coverage listed above were not closed by another scan. DONE-12 stays open for that reason.

## Re-test evidence

- **`OPENBASE_E2E=1 scripts/check.sh` at `1d7ab68` plus the two generated bindings files that `87be643` then committed unchanged: exit 0, "All checks passed."** Steps: cargo fmt --check, cargo clippy -D warnings, cargo deny check (advisories, bans, licences and sources ok), npm audit --audit-level=high (0 vulnerabilities), token check (709 files), web production build, `scripts/check-removed.sh`, cargo test (2,477 passed, 0 failed, 6 ignored, which includes the MCP parity test and every new regression test below), generated TypeScript bindings, Lucide icons and brand files current, tsc, vitest (225 files, 5,169 tests), live contract tests (16 files, 387 tests), Playwright (541 passed, 308 skipped, which are the ledger screenshots; the two smoke watchdog tests show a cross and count as passed). It passed on the first run.
- Fix agents ran, per area: cargo fmt and clippy clean; the affected suites (`sharing`, `forms`, `query`, `aggregate`, `mentions`, `security_hardening`, `attachments`, `token_capabilities`, `admin_email`, `mcp_tools_*`, `auth_*`, `oauth_*`, `passkeys`, `automations_*`, `csv`, `formula_fields`) and the lib tests; vitest `Markdown*.test.tsx`, `draw.test.ts`, `auth.test.tsx`, `account.test.tsx`.
- For the share-link fixes (F1 group, F55, F50) the agent stashed the source changes and re-ran the sharing suite: the three new regression tests failed without the fix.
- Not confirmed that each other regression test fails without its fix: the agents for the query-limits, web and formula areas did not run the new tests against the old code (the F34 test would need gigabytes to fail). The tests were written against the defects the findings describe, but this was not shown for every one.
- **Not run here:** the F6 PDF test (`a_pdf_that_asks_for_terabytes_of_pixels_fails_its_preview_not_the_server`) only compiles on Linux, and this machine is macOS, so it did not run in the suite above; it runs in CI on Linux. On macOS the memory cap itself is not enforced (the PDF is still rendered in a separate process). The Docker image built and was scanned, but the test suite was not run inside it.

## Scans re-run (2026-11-09, at `1d7ab68`; the later gate commit changes only two generated TypeScript comments)

| Scan | Result |
| --- | --- |
| `cargo deny check` | advisories ok, bans ok, licences ok, sources ok |
| `cd web && npm audit --audit-level=high` | found 0 vulnerabilities |
| `gitleaks detect --source . --log-opts="main..ux-overhaul" --redact` | 329 commits scanned, no leaks found |
| `docker build -f deploy/Dockerfile -t openbase:audit .` | exit 0 (73 GB free before the build) |
| `trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 openbase:audit` (the project's own gate) | exit 0, 0 vulnerabilities on Debian 13.7 |
| the same without `--ignore-unfixed` | 226 findings: 225 High and 1 Critical (libxml2). None has a fixed version: 154 `fix_deferred`, 71 `affected`, 1 `will_not_fix`. Most are in ffmpeg and the libav libraries. Counted by severity, this is the same picture the checklist audit saw at `d81062c`. `--ignore-unfixed` is a recorded accepted risk in docs/security.md |
| `docker rmi openbase:audit` | done |

Trivy found no language-specific files in the image, so the Rust binary and the web assets are covered by `cargo deny` and `npm audit` only. The GitHub Actions jobs for these scans (`secrets`, `image`, the cargo-deny install step) have not run on a runner and must go green in CI on the pull request (DONE-11).

## Recorded instead of fixed

All in docs/security.md.

- **F10** (Medium): the first sign-up on an uninitialised server becomes the administrator. Accepted risks, "The first account becomes the administrator and nothing proves it is the operator". A setup secret would change the first-run screen; the guard is operational (create the administrator before the server is reachable from elsewhere; check Admin, Users afterwards). Guidance also added to docs/self-hosting.md.
- **F36** (Medium, residual): account addresses are not verified at sign-up (Accepted risks, "Account addresses are not verified"). The invite fix covers the leaked-link case for a new account; someone with an existing account under that address accepts without a code, and on an instance with open sign-up an address can be registered before its owner does. Sign-up is invite-only by default.
- **F58** (Low, residual): a sign-in flood from very many IPv4 addresses or IPv6 /64 prefixes can still evict per-account counters (Accepted risks, "A sign-in flood from many networks...").
- **F50** (Low, residual): a file another visitor uploaded to a form of the same folder is still accepted by a public form if its id is known; it is not bound to one form's share id (that needs a schema migration) and is bounded by the 2 hour clean-up of unattached public uploads (What a share link exposes).
- **F28 and F30** (Medium, the budget half): the per-row cost no longer depends on the operand, but a view query still has no time or row budget and a large scan holds one of four reader connections until done and is not cancelled when the client leaves (Accepted risks, "A view query has no time or row budget of its own").
- **F17, F25** (the optional hardening to skip accounts with an unusable password in the reset flow) was not made: without administrator promotion a token-created account is an ordinary user, which tokens may still create.
- **F6** on macOS: the memory cap of the PDF child is enforced on Linux only (documented in docs/security.md, Formula, query and API cost limits).

## The bar

- Zero critical open: met (none found).
- Zero high open: met by the fix results (F1 to F6 fixed, each with a regression test, and the full suite green). Not re-audited by a second reader.
- Every medium fixed or recorded: met. 34 fixed and F10 recorded with its reason; the residuals of F36, F28 and F30 are also recorded.
- After any fix the check suite runs again: met (the full suite passed, see Re-test evidence).
- After any fix the affected areas are re-audited: **not met.** The owner cancelled the re-audit on 2026-11-09. DONE-12 stays open.
