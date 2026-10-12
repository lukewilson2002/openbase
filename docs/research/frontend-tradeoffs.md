# OpenGrid frontend trade-offs: Leptos vs Dioxus vs SSR+htmx vs Rust+TS

Status: research, 2026-10-12. Author: research agent. Scope: picking a frontend approach for OpenGrid, a self-hosted Airtable clone written in Rust, given the stated goal "write it all in Rust".

Legend: **[measured]** = run locally for this report. **[verified]** = checked against a primary source (crates.io / npm / GitHub API / official docs) today. **[unverified]** = secondary source or my own estimate. Treat these as weaker evidence.

---

## TL;DR

1. **The grid decides this, and the grid is a big custom component in every option.** Airtable-grade grid UX (virtualized 10k-50k rows, range selection, fill handle, paste ranges, column drag) is not available off the shelf in Rust. The best open-source Airtable clones have converged on **canvas-rendered grids**. Teable has its own canvas grid and also depends on `@glideapps/glide-data-grid`. NocoDB has a `grid/canvas` implementation **[verified]**. IronCalc, the leading Rust spreadsheet engine, ships its UI as React/TypeScript with a `WorksheetCanvas` component over a Rust-to-WASM engine **[verified]**.
2. **Raw speed is not why to avoid Rust/WASM.** In a like-for-like DOM virtualized grid microbenchmark, Dioxus 0.7 matched naive vanilla JS. A naive Leptos 0.8 version was about 2x slower, and the gap was traceable to my per-cell reactive closures, not to wasm-bindgen **[measured]**. Bundles are fine: a Leptos grid prototype was ~49 KB gzipped of WASM **[measured]**.
3. **The real cost is the ecosystem.** Rust has no grid with editing, range selection and fill handle. Its DnD, virtual-list, date-picker and calendar crates are mostly single-maintainer 0.x crates with hundreds to low thousands of downloads. There is no MIT gantt/timeline at all **[verified]**. Going all-Rust means building the grid, kanban DnD, calendar, timeline and pickers yourself, and absorbing a major framework version bump about once a year.
4. **Recommendation: (D-hybrid).** Use a Rust backend (single binary that embeds the prebuilt frontend assets) with a TypeScript frontend and a canvas grid. Start from Glide Data Grid (MIT) or a fork/own canvas grid modelled on it. Put the formula engine, field validation and filter/sort semantics in a **shared Rust core crate** that compiles natively for the server and to WASM for the browser, with TS types generated from Rust. Self-hosters still get one binary and never need Node; only contributors and CI do.
5. **Plain statement: "all Rust" is the wrong call for the frontend of this product.** It is defensible only if the team accepts building and maintaining roughly 4-6 complex UI components from scratch in Rust: grid, DnD board, calendar, timeline, date/time pickers and rich editors. That is an estimated extra 4-9 person-months up front **[unverified estimate]**, plus ongoing framework-churn tax. For a tiny team that time is better spent on data integrity, permissions, sync and the backend.

---

## 1. What the grid actually requires

| Requirement | Why it is hard | Implication |
|---|---|---|
| 10k-50k rows, smooth scroll | Only ~30-60 rows x ~10-30 columns can be in the DOM at once. Fast scroll replaces the whole viewport every frame | Virtualization is mandatory. DOM full-viewport replacement costs **15-30 ms on an Apple Silicon Mac [measured]**, which is over budget at 60 fps on low-end hardware |
| Range selection, keyboard nav, fill handle | Needs its own selection model, hit-testing and overlay rendering | A custom model in any framework. Library support matters a lot |
| Copy/paste ranges (TSV/HTML from Excel/Sheets) | Clipboard API, parsing and type coercion per field type | Coercion logic should be shared Rust (same as server validation) |
| Inline editors over a virtual grid | Editors must be real DOM overlays (IME, a11y, autocomplete) positioned over the virtual cells | Even canvas grids use a DOM overlay for editing |
| Column resize/reorder, frozen columns | Pointer capture, drag ghosts | Library feature, or a few hundred lines of code each |
| Kanban DnD, calendar, timeline/gantt, gallery, forms, record modal | Each is its own component family | Forms, gallery and modal are easy anywhere. DnD, calendar and gantt are where the ecosystem gap bites |

**Canvas vs DOM.** Glide's README says it chose canvas because DOM virtualization gave choppy scrolling **[verified]**. Teable's SDK grid (`RenderLayer.tsx`, `InteractionLayer.tsx`) and NocoDB's `smartsheet/grid/canvas` show both leading OSS Airtable clones went the same way **[verified]**. A canvas grid's cost is a few hundred to a few thousand `fillRect`/`fillText` calls per frame. In Rust/WASM each of those is a JS-boundary call through `web-sys`. That is fine in principle (small, monomorphic calls), but I did not benchmark a WASM canvas grid **[unverified]**.

## 2. Microbenchmark (measured)

Setup: the same virtualized grid in three implementations. 50,000 rows x 12 columns, 32 px rows, 30 rendered rows (390 cells), absolute-positioned rows, a click handler per cell, and a selected-cell class.
- **Leptos 0.8.22 CSR** (`<For>` keyed by row index, reactive `style`/`class:` closures per cell)
- **Dioxus 0.7.10 web** (`for` loop with keys, signals)
- **Vanilla JS** (naive `createElement` + `cssText`, keyed Map)

Harness: 500 iterations of a synthetic scroll by N rows, then a MessageChannel tick, then a correctness check (expected row label present, 0 stale frames in all runs), then a forced layout. Browser: the Chromium-based Claude desktop browser pane, Apple Silicon Mac, release builds, `opt-level="z"`, LTO, no `wasm-opt`.

| Implementation | 3-row scroll step (ms) | 30-row (full viewport) step (ms) |
|---|---|---|
| Vanilla JS (naive) | 2.5 | 14.4-14.8 |
| Dioxus 0.7.10 | 3.7 | 15.1-15.3 |
| Leptos 0.8.22 (naive) | 3.7-4.5 | 27.2-30.1 |

Interpretation:
- **wasm-bindgen overhead is not the bottleneck.** Dioxus batches DOM edits through its interpreter (sledgehammer lineage) and lands within ~5% of vanilla on full-viewport replacement.
- Leptos's 2x is consistent with my prototype creating 390+ reactive effects per full replace (one `style` closure per row, one `class:sel` subscription per cell). An optimized version would subscribe once per row or use a single selection overlay, and would probably close most of the gap **[unverified]**. The point stands: fine-grained reactivity per cell is the wrong grid architecture in any framework.
- **All DOM approaches cost 15-30 ms for a full viewport replace on a fast laptop.** On a cheap Windows laptop or phone expect 2-4x that **[unverified]**. This is why canvas wins for the main grid regardless of language.
- Caveats: this is a single machine and a synthetic microbenchmark. There are no editors, no text measurement and no real data, and the vanilla version is naive (no template cloning).

## 3. Bundle size

| Artifact | Raw | gzip -9 | brotli | Notes |
|---|---|---|---|---|
| Leptos 0.8 CSR grid prototype `_bg.wasm` | 118 KB | **48.7 KB** | 41.5 KB | + 28 KB JS glue (6 KB gz). No wasm-opt (Binaryen claims another 15-20%) **[measured]** |
| Dioxus 0.7 web grid prototype `_bg.wasm` | 424 KB | **169 KB** | 139 KB | Default features + `web`. Built with cargo + wasm-bindgen because local `dx build` failed on a toolchain objcopy issue, so no dx/wasm-opt pass. dx's optimized output would be smaller. Dioxus README claims "<50 KB" for a minimal app **[measured / README claim unverified]** |
| Real Leptos/Dioxus app with router, forms, i18n, editors, DnD | — | ~300-800 KB gz | — | Typical community reports. **[unverified]** Measure early and gate in CI |
| Glide Data Grid 6.0.3 | 189 KB | 64 KB | — | Plus React (~45-60 KB gz) **[verified via bundlephobia; React size unverified]** |
| htmx 4.0.0 | 42 KB | 14 KB | — | **[verified via bundlephobia]** |
| Shared Rust core (formula engine) as WASM | — | ~0.3-1.5 MB gz | — | IronCalc's npm `@ironcalc/wasm` 0.8.4 is ~2.1 MB unpacked **[verified]**. Our own engine will be smaller but a non-trivial formula engine is the largest asset in every option that runs formulas client-side |

Bundle size is not a differentiator for a self-hosted, logged-in productivity app; caching makes it a one-time cost. WASM is also compiled by the browser off the main thread with streaming compilation.

## 4. Option-by-option

### (A) Leptos CSR WASM SPA

- **Versions / churn [verified, crates.io + GitHub API]:** 0.3 (2023-05), 0.4 (2023-06), 0.5 (2023-09; removed `cx: Scope` everywhere), 0.6 (early 2024; server-fn rewrite), 0.7 (2024-11-30; "nearly-complete rewrite of the internals": `reactive_graph`, `tachys`, new `leptos::prelude::*` imports, `create_*` to `*` renames), 0.8 (2025-05-01; 0.8.22 on 2026-10-05). Next: 0.9.0-alpha (2026-05-19), 0.9.0-beta (2026-07-18), and `0.9.0-beta2` is the current max on crates.io. 0.9 changes signal traits (deref to `dyn Fn` instead of implementing `Fn`; `impl Fn` props move to `SignalOrFn`), puts lazy loading behind a feature, and has other small semver breaks that are "not intended to require meaningful migration". Pattern: **a breaking minor roughly every 6-12 months, with 0.7 the big one.** Ecosystem crates lag each bump (leptos-use ported to 0.8 in 2025-06, about a month after release).
- **Health [verified]:** 21.4k stars, 114 open issues, 5.2M total downloads (1.4M recent 90 days). Largely carried by one lead maintainer (Greg Johnston) plus contributors. Bus-factor concern **[unverified characterization]**.
- **Grid/components ecosystem [verified, crates.io 2026-10-12]:**
  - `leptos-struct-table` 0.19.1: 200k downloads, 260 stars, active. Headless, virtualized, sortable, row selection, custom editable cell renderers. **No range selection, fill handle, column drag or paste ranges.** A good table, not a spreadsheet.
  - `leptos-arrow-grid` 0.1.3: 62 downloads, created 2026-04, 0 stars. Virtual rows/columns, keyboard nav, resize, copy rows. No editing.
  - `leptos_virtual_scroller` 0.1.1 (1.6k dl), `leptos-windowing` 0.3.0 (715 dl), `chorale-leptos` 0.2.3 (113 dl): small virtualization helpers.
  - DnD: `leptos_dnd` 0.1.4 (5k dl, last update 2025-03), `taino-dnd-leptos` 0.6.1 (156 dl), `leptos_drag_reorder` 0.1.0. `leptos-use` (1.4M dl, healthy) has `use_draggable` / `use_drop_zone` primitives.
  - UI kits: `thaw` 0.5.0-beta (145k dl, last push 2026-05), `leptos-shadcn-ui` 0.9 (6k dl), `radix-leptos` 0.9 (5k dl), `leptonic` 0.5 (stale). Date/calendar: `leptos_calendar` 0.1.2 (2.5k dl, last update 2025-02), plus picker components inside thaw and the shadcn port.
  - **Gantt/timeline: nothing found.**
- **Strengths:** fine-grained reactivity (no VDOM), the smallest WASM output of the Rust options **[measured]**, best-in-class SSR/hydration if wanted, server functions, and the most mature "web-first" Rust framework.
- **Testing:** `wasm-bindgen-test` 0.3.79 runs unit/component tests in headless Chrome/Firefox/Safari. Leptos's own guidance leans on Playwright for e2e. Browser-level debugging of WASM is worse than JS: source maps for Rust exist via DWARF and the Chrome C/C++ DevTools extension, but are clunky, and panics need `console_error_panic_hook` **[unverified on current tooling quality]**.
- **Compile times [measured, M-series Mac, rustc 1.99]:** clean release build of the prototype ~28 s. Incremental release rebuild ~3 s for a tiny crate. A 30-60k LOC app's incremental WASM rebuild is usually 10-40 s in release, faster in dev **[unverified]**. `cargo-leptos` 0.3.11 and Trunk 0.22-rc are the build tools. Hot reload covers `view!` markup only, not Rust logic.

### (B) Dioxus web

- **Versions / churn [verified]:** 0.3 (2023-01), 0.4 (2023-08), 0.5 (2024-03-28; signals rewrite, removed `cx`/lifetimes, a big migration), 0.6 (2024-12-07), 0.7.0 (2025-10-31; Subsecond Rust hot-patching, Stores, new component library), 0.7.10 (2026-07-30), 0.8.0-alpha.0 (2026-05-19), 0.8.0-alpha.1 (2026-07-31). Pattern: **one breaking release per year**, with 0.5 the most disruptive.
- **Health [verified]:** 39.4k stars, 827 open issues, a VC-funded company (DioxusLabs) with several full-time engineers, 3.1M downloads. Larger team than Leptos, but priorities include desktop/mobile and the Blitz native renderer, not just web.
- **Grid/components ecosystem [verified]:** `dioxus-components` 0.1.2 (official shadcn-style set, 2.8k dl; the GitHub repo `DioxusLabs/dioxus-components` has 345 stars). `dioxus-primitives` (0.0.0 placeholder on crates.io). DnD: `dioxus-dnd` 3.1.0 (516 dl, created 2026-07; claims sortable/kanban/grid), `dioxus-dnd-kit`, `dioxus-nox-dnd`. Virtualization: `dioxus-virtual-window`, `dioxus-recycle-list`, `dioxus-nox-virtualize`. Tables: `dioxus-table`, `dioxus-tabular`, `dioxus-as-table`. **No spreadsheet-grade grid, no calendar/gantt of note.** Overall smaller than Leptos for web.
- **Strengths:** good DOM throughput via batched edits **[measured]**, Subsecond hot-patching of Rust code (experimental, tip crate only), and the same code can target desktop (useful if OpenGrid ever wants a desktop app).
- **Weaknesses for us:** larger WASM baseline **[measured, see caveat]**, VDOM diffing, and the `dx` CLI as a heavyweight required tool (it failed locally on a toolchain objcopy issue during this research, which shows the tooling fragility). Web is one of several targets.
- **Testing:** `wasm-bindgen-test`. Dioxus itself runs Playwright tests (0.8 alpha notes mention Playwright on macOS).

### (C) Server-rendered HTML (askama 0.16 / maud 0.27) + htmx 4 + small hand-written JS

- **Great for:** auth pages, settings, admin, base/table management, forms (public form view), record detail modal, permissions UI, webhooks/API-key pages, gallery. Near-zero client state, tiny payloads (htmx 4.0.0 is 14 KB gz), trivially testable with plain HTTP tests, and nothing to compile for the browser.
- **Bad for:** the grid. A 50k-row virtualized, keyboard-driven, range-selecting, paste-accepting editor cannot be round-tripped through HTML fragments: every keystroke and scroll can't wait on the server, and a 1 vCPU VPS shouldn't render scroll frames. The "small hand-written JS" becomes a **5-15k LOC untyped grid** **[unverified estimate]**, plus kanban DnD, calendar and timeline. It is option D without types, a component ecosystem or tests.
- **Churn:** htmx 4.0.0 shipped 2026-08-28 with breaking renames (events, `hx-optimistic` to `hx-pending`, SSE moved to an extension, extension registration, config merging) **[verified]**. 2.x still gets patches (2.0.10, 2026-09). askama and maud are stable and boring (good).
- **Verdict:** use C for the non-grid half of the app regardless. It does not solve the hard half.

### (D) Rust backend + conventional TS frontend (reference point)

- **Grid options [verified]:**
  - **Glide Data Grid** (MIT, canvas, 5.4k stars). Has `rangeSelect`, `fillHandle`, `onPaste`, `getCellsForSelection` (copy), `freezeColumns`, resizable/movable columns, claims millions of rows. 64 KB gz. **Risk:** last stable 6.0.3 was 2024-02, then 6.0.4-alpha builds through 2025-10 and commits to 2026-01. Peer deps say React <= 18, but Teable runs it on React 19.2. Plan to vendor or fork.
  - **AG Grid Community** (MIT, 36.2.0, 2026-09). **Range selection, clipboard ops (and reportedly fill handle) are Enterprise-only** **[verified for range/clipboard; fill handle unverified]**. Shipping Community means missing core Airtable UX, which conflicts with the "no paywalled features" principle and would be a dependency on an open-core vendor.
  - Handsontable: not OSS for commercial use (excluded). RevoGrid: MIT core, some features in Pro **[unverified]**. TanStack Table + TanStack Virtual (MIT, very active) is a headless DOM base if you build your own.
- **Other views [verified, npm]:** `@fullcalendar/core` 7.1.2 (MIT, but **resource timeline is a paid premium plugin** [unverified for v7]); `frappe-gantt` 1.2.2 (MIT, 2026-02); `vis-timeline` 8.5.4 (Apache/MIT, 2026-08); `@dnd-kit/react` 0.5.0 / `@dnd-kit/core` 6.3.1, `@atlaskit/pragmatic-drag-and-drop` 4.0.0 (Apache-2.0) for kanban.
- **Costs:** Node/pnpm in dev and CI, npm supply-chain exposure (mitigate with a lockfile, a minimal dependency set, `--ignore-scripts`, and renovate with review), and two languages. Self-hosters are unaffected: assets are built in CI and embedded in the binary (`rust-embed` / `include_dir`).
- **Type/logic sharing:** `ts-rs` 12.0.1 (7.6M recent downloads), `specta` 2.0-rc, `typeshare` 1.0.5 and `tsify` 0.5.8 generate TS types from Rust structs. `wasm-bindgen` + `tsify` exposes shared Rust logic to TS as typed WASM. This is how IronCalc ships (Rust engine to `@ironcalc/wasm`, consumed by a React/TS canvas UI) **[verified]**.

## 5. Sharing Rust logic (formula engine, validation)

This works in **every** option except pure C, and it does not require the UI to be Rust:

```
crates/
  opengrid-core/     # no_std-ish, no I/O: field types, value coercion, validation,
                     # formula parser+evaluator, filter/sort/group semantics, paste parsing
  opengrid-server/   # axum + sqlite; uses core natively (authoritative)
  opengrid-wasm/     # wasm-bindgen + tsify facade over core (optimistic client-side eval/validation)
```

- The server stays authoritative (security and data integrity first). The client copy exists only for instant feedback (formula preview, paste coercion, cell validation) and is re-checked server-side.
- Existing engines: `ironcalc_base` 0.8.3 (MIT/Apache, 191k dl, Excel-semantics, cell-addressed) and `formualizer` 0.11.1 (3.7k dl, new). Airtable formulas are **field-addressed** (`{Price} * {Qty}`), not cell-addressed, so OpenGrid probably needs its own small evaluator. IronCalc's parser/functions are a reference or partial dependency **[judgement]**.
- With A/B the sharing is "free" (same crate, direct calls). With D it costs a WASM facade and a generated `.d.ts`: roughly a day of setup, then a small per-API cost.

## 6. Real-world examples

- **Spreadsheet/grid UIs in Leptos or Dioxus:** I found **no production-grade spreadsheet or Airtable-like grid** built on either. GitHub search for "leptos spreadsheet" / "dioxus spreadsheet" returns essentially nothing relevant. The closest are `leptos-arrow-grid` (read-only data grid, new), `ruxelion/rs-grid` (1 star, "Rust/WASM data grid", Leptos example repo) and `leptos-struct-table` (tables, not spreadsheets) **[verified]**.
- **Rust spreadsheet engines with web UIs:** IronCalc (4.2k stars) uses **React/TS + canvas for the UI, Rust only for the engine** **[verified from `webapp/IronCalc/package.json` and component list]**. This is the strongest precedent, and it is option D-hybrid.
- **OSS Airtable clones:** Teable (React, own canvas grid + Glide), NocoDB (Vue, canvas grid), Baserow (Vue, DOM) **[verified for Teable/NocoDB repo structure]**. None use a Rust UI.

## 7. Maintainability for a tiny team (<= 2-3 devs)

| Factor | A Leptos | B Dioxus | C SSR+htmx | D Rust + TS |
|---|---|---|---|---|
| Grid you must build | Entire grid from scratch (canvas or DOM) | Entire grid from scratch | Entire grid in untyped JS | Fork/configure Glide, or build own canvas grid with TS ecosystem help |
| DnD / calendar / gantt | Build or adopt 0.x single-maintainer crates | Same | Hand JS or vendor JS libs | Mature MIT libs |
| Framework churn | Breaking minor ~6-12 months (0.9 in beta now) | ~yearly (0.8 in alpha) | htmx 4 just broke; templates stable | React/Solid stable. Grid lib maintenance is the risk |
| Contributor pool (OSS) | Small | Small | Large (HTML) but grid JS is untyped | Largest |
| Type safety end to end | Excellent | Excellent | Server only | Good with ts-rs/tsify |
| Debugging in browser | Weak-moderate | Weak-moderate | Excellent | Excellent |
| e2e testing | Playwright (language-agnostic) | Playwright | Playwright + HTTP tests | Playwright + Vitest |
| Self-host simplicity | Single binary | Single binary | Single binary | Single binary (assets embedded) |
| Server RAM impact (512 MB VPS) | None (static assets) | None | Small (HTML rendering) | None |

Playwright is the e2e answer in every option. Browser e2e is framework-agnostic, so testability differs mainly at the unit/component level. There, Vitest/Testing Library on TS is far more mature than `wasm-bindgen-test`.

## 8. Recommendation

**Adopt D-hybrid:**
1. **Backend:** Rust (axum + SQLite) single binary. It embeds the compiled frontend and serves the JSON API + WebSocket/SSE for realtime.
2. **Shared core crate** in Rust, used natively by the server (authoritative) and compiled to WASM for the client: field types, validation, value coercion and paste parsing, formula engine, filter/sort semantics. TS types are generated with `ts-rs` or `tsify`.
3. **Frontend:** TypeScript with one small, stable framework. React is the safest pairing with Glide. Solid/Preact are lighter but cut you off from Glide without a wrapper **[judgement]**.
   - **Grid:** start on Glide Data Grid (MIT, canvas, already has range select, fill handle, paste and column drag). Vendor/fork it from day one, given its slow release cadence. Keep the grid behind an internal interface so a home-grown canvas grid can replace it later.
   - Kanban: dnd-kit or pragmatic-drag-and-drop. Calendar: FullCalendar MIT core (avoid premium plugins). Timeline: vis-timeline or frappe-gantt, or a custom canvas timeline that reuses the grid's renderer.
4. **Optionally use server-rendered pages (askama/maud) for the non-app pages** (login, setup wizard, public forms, admin) to keep the SPA small and keep critical auth flows JS-light.
5. **Supply-chain hygiene:** pinned lockfile, a small dependency allow-list, CI-only builds, and reproducible asset embedding. Releases ship one binary, so end users never run npm.

**If the project insists on all-Rust anyway**, the least-bad path is **Leptos CSR (A) with a custom canvas grid written in Rust** (via `web-sys` `CanvasRenderingContext2d`, with DOM-overlay editors), Leptos for everything else, `leptos-use` for DnD primitives, and custom calendar/timeline. Pin Leptos 0.8 until 0.9 is stable. Budget the grid as the project's largest frontend work item. Prefer Leptos over Dioxus for this product: it is web-first, has smaller WASM, and has a larger web component ecosystem. Dioxus's edges (desktop/mobile, hot-patching) don't matter for a self-hosted web app.

### Is "all Rust" the wrong call for the frontend?

**Yes, for this product and this team size.** Rust/WASM is fast enough, and bundles are acceptable. That is not the problem. The problem is that the frontend of an Airtable clone is ~70% complex interactive widgets that already exist, MIT-licensed and battle-tested, in the JS ecosystem, and do not exist in Rust.

**What all-Rust costs:**
- Building a spreadsheet-grade grid (range selection, fill handle, paste, column drag, frozen columns, canvas rendering, DOM editor overlay, a11y), kanban DnD, calendar, timeline and pickers from scratch: an estimated **4-9 extra person-months** before feature parity with what D gets from libraries **[unverified estimate]**.
- Ongoing exposure to pre-1.0 framework breaks (Leptos 0.9 and Dioxus 0.8 are both in pre-release today), plus abandoned 0.x component crates.
- A much smaller contributor pool for an OSS project, and weaker in-browser debugging.

**What D-hybrid costs:** a second language and a Node toolchain for contributors and CI, npm supply-chain diligence, a dependency on a slow-moving grid library (mitigated by vendoring), and a ~1 day WASM facade to share Rust logic. Self-hosters see none of this.

## 9. Things I could not verify

- Current js-framework-benchmark standings for Leptos/Dioxus (the results page is JS-rendered; I found no 2026 write-up). My own microbenchmark substitutes for it but is single-machine and synthetic.
- Optimized (`dx build --release` / `wasm-opt`) Dioxus 0.7 bundle size, because local `dx` failed on a toolchain issue.
- WASM canvas-grid frame cost (not benchmarked).
- AG Grid fill handle tier, and FullCalendar v7 premium boundaries.
- Typical full-app WASM sizes (300-800 KB gz) and compile times for 30-60k LOC Leptos apps are community-typical figures, not measured.
- The exact Leptos 0.6.0 release date (early 2024).

## Sources

- crates.io API (versions, downloads, dates) for leptos, dioxus, leptos-struct-table, leptos-arrow-grid, leptos-use, thaw, dioxus-dnd, ironcalc_base, formualizer, ts-rs, tsify, specta, typeshare, wasm-bindgen(-test), askama, maud: queried 2026-10-12
- GitHub API: releases for leptos-rs/leptos, DioxusLabs/dioxus, glideapps/glide-data-grid, ag-grid/ag-grid, bigskysoftware/htmx; repo metadata for IronCalc, Teable, NocoDB
- [Leptos 0.9.0-beta notes](https://newreleases.io/project/github/leptos-rs/leptos/release/v0.9.0-beta), [Leptos 0.7.0-beta notes](https://newreleases.io/project/cargo/leptos/release/0.7.0-beta), [Leptos binary size guide](https://book.leptos.dev/deployment/binary_size.html)
- [Dioxus releases](https://github.com/DioxusLabs/dioxus/releases), [Dioxus 0.7 hot-reload docs](https://dioxuslabs.com/learn/0.7/essentials/ui/hotreload)
- [Glide Data Grid](https://github.com/glideapps/glide-data-grid) (README, API.md), [bundlephobia](https://bundlephobia.com)
- [AG Grid Community vs Enterprise](https://www.ag-grid.com/vue-data-grid/community-vs-enterprise.md)
- [IronCalc](https://github.com/ironcalc/IronCalc) (`webapp/IronCalc/package.json`, `src/components`)
- [htmx v4.0.0 release](https://github.com/bigskysoftware/htmx/releases/tag/v4.0.0)
- [leptos-struct-table](https://github.com/Synphonyte/leptos-struct-table), [leptos-arrow-grid docs](https://docs.rs/leptos-arrow-grid)
- npm registry for frappe-gantt, vis-timeline, @fullcalendar/core, @dnd-kit/*, @atlaskit/pragmatic-drag-and-drop, @ironcalc/wasm
- Local measurements: Leptos 0.8.22 / Dioxus 0.7.10 / vanilla JS prototypes, rustc 1.99.0, wasm-bindgen 0.2.129 (built in a scratch directory outside the repo)
