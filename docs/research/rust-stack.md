# OpenGrid: Rust crate stack research

Date: 2026-10-12. Toolchain on this machine: `rustc 1.99.0 (2026-09-28)` and `cargo 1.99.0`, on aarch64-apple-darwin.

## How this was checked

The point was to rely on things we could check, not on memory.

1. **Versions.** I ran `cargo search <crate> --limit 1` locally for every candidate crate. I then cross-checked each one against the crates.io API (`max_stable_version`, `updated_at`, 90-day downloads, MSRV, license, feature maps). `cargo search` shows pre-releases as "latest" (for example leptos `0.9.0-beta2`, trunk `0.22.0-rc.2`, dioxus `0.8.0-alpha.1`, axum-test `22.0.0-rc.1`, rustls `0.24.0-dev.1`). The table below uses the **stable** versions from the API.
2. **Compile probe.** I made a throwaway crate in the session scratchpad, outside the repo, with the recommended server dependency set and feature flags below. It passed `cargo check` with no errors on rustc 1.99.0 in about 13 s on a warm cache. That confirms every feature name below exists and that the versions resolve together.
3. **Supply chain.** `cargo tree` on the probe shows **no `openssl`, `openssl-sys` or `native-tls`** anywhere in the graph. I queried all 383 locked packages against the OSV database (RustSec plus GHSA): **0 open advisories** as of today.
4. **Bundled SQLite.** `libsqlite3-sys 0.38.2`, used by `rusqlite 0.40.2` with `bundled`, ships **SQLite 3.53.2**. I read this from `sqlite3.h` in the registry source.
5. **Web research** covered things the registry cannot show, such as roadmaps and release notes. Any claim I could not confirm is marked **UNVERIFIED**.

## Local environment

| Check | Result |
|---|---|
| `rustup target list --installed` | `aarch64-apple-darwin`, **`wasm32-unknown-unknown` (installed)** |
| `which trunk` | **not installed** |
| `which wasm-bindgen` (wasm-bindgen-cli) | **not installed** |
| `which cargo-leptos` | not installed |
| `which dx` (Dioxus CLI) | installed at `~/.cargo/bin/dx`, version `dioxus 0.7.10` |

To build a CSR frontend you need to run `cargo install trunk --locked` (stable is 0.21.14) or `cargo binstall trunk`. Trunk downloads a matching `wasm-bindgen-cli` by itself. If we skip trunk, `wasm-bindgen-cli` has to match the `wasm-bindgen` crate version exactly (0.2.129). Pin both versions and put them in CI.

---

## 1. Area-by-area findings

### HTTP server: axum + tower + tower-http on tokio
- **axum 0.8.9** (2026-04-14, MSRV 1.80, MIT). This is still the 0.8 line; I found no 0.9 stable or pre-release on crates.io. It is maintained by the tokio-rs org and very widely used (about 131M downloads in 90 days). It has built-in features for `multipart` (multer underneath), `ws`, and `macros`. SSE is in core: `axum::response::sse::{Sse, Event, KeepAlive}`.
- **tower 0.5.3**: `ServiceExt::oneshot` covers in-process tests, and the `limit` and `timeout` layers are here.
- **tower-http 0.7.1** (2026-08-31). This is a **new minor release**. axum 0.8.9 itself does not depend on tower-http, so 0.7 is fine for our own middleware. Note that **reqwest 0.13.5 still pulls tower-http 0.6.11**, so two copies get compiled. That costs compile time but is harmless at runtime. Features worth using: `trace`, `compression-gzip`/`compression-br`, `limit` (RequestBodyLimit), `timeout`, `set-header` (security headers), `request-id`, `catch-panic`, `sensitive-headers`, `fs`.
- **tokio 1.53.2** (2026-10-03). Use the `rt-multi-thread` runtime. On a 1 vCPU box, tokio starts one worker per core, which is fine. Set `max_blocking_threads` low (for example 8 to 16) so SQLite and image work cannot create hundreds of threads. That matters with 512 MB of RAM.

### SQLite access
| Option | Version | Verdict |
|---|---|---|
| **rusqlite** + `bundled` | 0.40.2 (2026-08-08) | **Recommended.** Synchronous, thin, and well maintained. `bundled` compiles SQLite 3.53.2 into the binary, so there is no system lib and the version is the same on every host. That keeps the single-binary promise. It gives full access to `backup`, `hooks`, `functions`, `limits`, `serialize`, and `session`. |
| sqlx (sqlite) | 0.9.0 (2026-05-21, **MSRV 1.94**) | Not recommended. It is async over a worker thread anyway, and the compile-time query macros need a DB or an offline cache. It hides SQLite-specific controls (busy handler, hooks, backup API). The default features pull `any`/`macros`/`migrate`. Past advisory: RUSTSEC-2024-0363, which was Postgres/MySQL protocol, not SQLite. Heavier for no gain on a SQLite-only app. |
| tokio-rusqlite | 0.8.0 (2026-09-06) | Reasonable: one connection on a dedicated thread, called through `call(|conn| ...)`. Good fit for the **single writer** connection. |
| deadpool-sqlite | 0.14.0 (2026-08-26, needs rusqlite ^0.40) | Good async pool for **reader** connections. `interact()` runs on `spawn_blocking`. Smaller user base (about 210k downloads in 90 days) but maintained. |
| r2d2_sqlite / r2d2 | 0.35.0 / 0.8.10 | Works (needs rusqlite ^0.40), but **r2d2 itself has not had a release since 2022-06**. It is synchronous, which is fine inside `spawn_blocking`. It is a fallback, not the first choice. |
| async-sqlite | 0.6.0 | Small, not evaluated in depth. Skip. |

**Recommended pattern (UNVERIFIED as a benchmark; this is a design recommendation).** Use WAL mode with one dedicated writer connection, either tokio-rusqlite or a hand-rolled thread with an mpsc command channel. Serialized writes give clear transaction semantics and no `SQLITE_BUSY` storms. Add a small reader pool of 2 to 4 connections via deadpool-sqlite. Set these pragmas on every connection: `journal_mode=WAL`, `synchronous=NORMAL` (or `FULL` if we want maximum durability), `foreign_keys=ON`, `busy_timeout=5000`, `cache_size` capped at about -8000 (8 MB) per connection to respect RAM, `temp_store=MEMORY` with care, and `trusted_schema=OFF`. For backups, use the rusqlite `backup` feature (online backup API) or `VACUUM INTO`.

### Migrations
| Option | Version | Verdict |
|---|---|---|
| **rusqlite_migration** | 2.6.0 (2026-05-28, needs rusqlite ^0.40) | **Recommended.** It tracks state in `PRAGMA user_version`, so there is no extra table. Migrations are embedded as `M::up(include_str!(...))` and run in a transaction. It has a `validate()` helper for tests. Tiny dependency. |
| Hand-rolled `user_version` | n/a | Also fine, at about 40 lines. It is what rusqlite_migration does, minus the tests and edge-case handling. Only do this if we want zero dependencies. |
| refinery | 0.10.0 (2026-10-02) | Works, but refinery-core accepts `rusqlite >=0.23, <=0.40`, so a rusqlite 0.41 bump could block us until refinery updates. It is more machinery (its own history table, multi-DB) than a SQLite-only app needs. |

Always take a backup (`VACUUM INTO`) automatically before running migrations on startup.

### Auth crypto
- **argon2 0.6.0** (2026-08-27, MSRV 1.85, pure Rust, RustCrypto). It is a new minor release on the `password-hash 0.6` line. Use Argon2id with a PHC string. On a 512 MB VPS, choose memory cost carefully. OWASP's minimum is m=19 MiB, t=2, p=1. Parallel logins multiply memory use, so **limit concurrent hash operations with a `tokio::sync::Semaphore` of 2** and run them in `spawn_blocking`.
- **totp-rs 6.0.0** (2026-08-06, MSRV 1.88). It is on new RustCrypto (`hmac 0.13`, `sha1 0.11`) and uses `constant_time_eq` for comparison. Features: `otpauth`, `gen_secret`, `zeroize`. Add `qr` only if we render QR codes server-side, since that pulls image dependencies. Alternatively render the `otpauth://` URI client-side. The old timing advisory, RUSTSEC-2022-0018, is fixed in versions this old and newer.
- **rand 0.10.3** (2026-09-20) and **getrandom 0.4.3**. For session tokens, CSRF tokens and API keys, use `getrandom::fill` directly (OS CSPRNG) or `rand::rngs::OsRng`. 32 bytes, base64url-encoded.
- **sha2 0.11.1** (released today, 2026-10-12), **hmac 0.13.0**, **subtle 2.6.1**. Store only `SHA-256(token)` in the DB for sessions and API keys, and compare with `subtle::ConstantTimeEq`.
- **RustCrypto version split.** The ecosystem is partway through moving from digest 0.10 to 0.11. `cookie 0.18.2` (via axum-extra) still pulls `sha2 0.10`, `hmac 0.12`, `rand 0.8` and `base64 0.22`. governor pulls `rand 0.9`. This duplication is harmless but makes the binary bigger. If binary size matters later, pin our own `sha2`/`hmac` to 0.10/0.12 to deduplicate, or skip axum-extra's signed and private cookies (see below).

### Cookies and sessions
- **axum-extra 0.12.6** with `cookie` (plain `CookieJar`). Hand-rolled server-side sessions are recommended. Generate a 32-byte random token, store `sha256(token)`, user_id, created/expires/last_seen, ip and user-agent in a `sessions` table, and set the cookie as `HttpOnly; Secure; SameSite=Lax; Path=/; __Host-` prefix. This takes about 150 lines, can be audited fully, and supports "log out all devices" and admin revocation. That matters more for security than convenience.
- **tower-sessions 0.15.0** (2026-02-01, 8 months since its last release). It works, but the default is an in-memory store, and the SQLite stores live in a separate crate tied to sqlx (tower-sessions-sqlx-store, **UNVERIFIED** for its current version). That would pull sqlx in next to rusqlite. **Avoid.**
- `cookie-signed`/`cookie-private` (axum-extra) compiled fine in the probe, but we don't need them if sessions are opaque DB tokens.
- **CSRF.** Use SameSite=Lax cookies, an `Origin`/`Sec-Fetch-Site` check middleware, and a double-submit token for form POSTs. tower-http 0.7 lists a `csrf` feature. I did not inspect its API (**UNVERIFIED**), so evaluate it before relying on it.

### Rate limiting
- **governor 0.10.4** (2025-12-16) is the solid GCRA core, with keyed in-memory limiters.
- **tower_governor 0.8.0** (2025-08-14, about 14 months without a release). It **does** work with axum 0.8 (the probe resolves a single axum 0.8.9). It sets **`tonic` as a default feature**, so use `default-features = false, features = ["axum"]`. Its key extractors trust `X-Forwarded-For` only if configured, and getting that wrong when running behind Caddy is a classic bypass. **Recommendation:** use `governor` directly in our own roughly 60-line middleware, keyed on (route class, client IP from a trusted-proxy-aware extractor) and on (account, login). That also covers per-account login lockout, which tower_governor does not do. Treat tower_governor as optional.

### Email
- **lettre 0.11.23** (2026-08-03). **The default features include `native-tls` (OpenSSL on Linux).** Always set `default-features = false` and use `["smtp-transport","pool","hostname","builder","tokio1","tokio1-rustls","ring" (or "aws-lc-rs"),"webpki-roots"]`. All of these features were confirmed in the probe. Note that `rustls-tls` is a legacy alias that implies `ring` plus `webpki-roots`. Do not use the boring-tls backend: **RUSTSEC-2026-0141** (2026-05-14) disabled TLS hostname verification with Boring TLS.

### HTTP client (webhooks, URL attachments, OAuth later)
- **reqwest 0.13.5** (2026-09-08, MSRV 1.85). **The 0.13 line changed `default-tls` to rustls**, mapped to `rustls` = aws-lc-rs plus `rustls-platform-verifier`. OpenSSL is no longer the default. I still recommend `default-features = false, features = ["rustls","json","stream","http2"]` to be explicit.
- **Crypto provider choice.** With the features above, reqwest brings **aws-lc-rs/aws-lc-sys** (C/asm, larger, longer build) and lettre brings **ring**, so both are compiled. To unify, pick one of these:
  - (a) Use aws-lc-rs everywhere: lettre feature `aws-lc-rs` instead of `ring`. This is the rustls default and has more active development.
  - (b) Use ring everywhere: reqwest `rustls-no-provider`, plus a direct `rustls = { version = "0.23", default-features = false, features = ["ring", ...] }` and `CryptoProvider::install_default()` at startup.
  Option (b) gives a smaller and simpler cross-compile for musl/ARM VPS targets. Option (a) is less code. **Recommendation: (b) ring** for easier `cargo zigbuild` cross-compiles. I did not benchmark the binary size difference (**UNVERIFIED**).
- **rustls 0.23.45** (2026-09-14) is the current stable. RUSTSEC-2026-0285 (TLS 1.3 handshake messages across encryption levels) was published the same day. OSV reports no open advisory for the locked 0.23.45, so require `>=0.23.45`.
- **SSRF.** Webhooks and URL fetches must block private, loopback and link-local ranges after DNS resolution (a custom `reqwest` DNS resolver or connector check), turn redirects off or re-check them, and set timeouts and response-size limits. No crate does this for us.

### Images and thumbnails
- **image 0.25.10** (2026-03-10, MSRV 1.88). Use `default-features = false, features = ["png","jpeg","gif","webp"]`. This **drops `rayon`**, which matters on a 1 vCPU box (an extra thread pool and memory), and drops exotic decoders (exr, tiff, dds, hdr), which are attack surface. Do **not** enable `avif-native` (C dependency dav1d) or `nasm`.
- Set `image::Limits` (max width, height and allocation bytes, for example 64 MB) to stop decompression bombs. Make thumbnails with `thumbnail()`/`resize` in `spawn_blocking` behind a semaphore of 1 to 2.
- `fast_image_resize 6.1.0` is an option if resize CPU becomes a bottleneck. It is not needed at first.

### Static asset embedding
- **rust-embed 8.13.0** (2026-10-07, actively maintained). Use features `mime-guess` (and optionally `compression`, `include-exclude`). In debug it reads from disk, which suits hot reload of the frontend. In release it embeds. **Recommended.**
- include_dir 0.7.4 has had **no release since 2024-06**. It works but is dormant. Prefer rust-embed.
- Serve hashed files with `Cache-Control: immutable`, and set ETag from the rust-embed file hash.

### Dates and time zones
- **jiff 0.2.38** (2026-10-06, BurntSushi). Time zone arithmetic is DST-correct (`Zoned`, `Span`), and it bundles tzdb (`tzdb-bundle-platform`, which uses the system zoneinfo when present and falls back to embedded data). It has `serde`, and `js` for wasm. It is **pre-1.0**. Its docs say 1.0 has no timeline and that 0.2 gets about a year of fixes after 1.0 ships. **Recommended** for Airtable-style date fields with per-field time zones.
- chrono 0.4.45 + chrono-tz 0.10.4: mature. chrono-tz last released 2025-07, so its tzdb ships only with crate releases, which is a real issue for staying current with tz changes. chrono's timezone handling is easier to get wrong. **However:** `croner 4.0.1` depends on `chrono ^0.4.42`, so chrono will be in the tree anyway, used only for cron. That is acceptable.
- rusqlite has optional `jiff` and `chrono` features for ToSql/FromSql. Store dates as ISO-8601 TEXT or as INTEGER unix ms, which is simpler for indexes.

### Regex, CSV, serde
- **regex 1.13.1**: linear time, so it is safe against ReDoS for user-supplied filter or validation patterns. Still cap pattern size with `RegexBuilder::size_limit`. **Avoid `fancy-regex` for user input**, because backtracking means ReDoS.
- **csv 1.4.0**: mature and stable, works with serde. For imports, stream records and cap row count and field size.
- **serde 1.0.229 / serde_json 1.0.154**: standard.

### Cron parsing (automations)
- **croner 4.0.1** (2026-10-02, maintained). It handles the full Vixie and OCR syntax (L, W, #, seconds optional) and DST-aware next-occurrence. It depends on chrono. **Recommended.**
- cron 0.17.0 (2026-06-18) is quartz-style and needs a seconds field, so it is less friendly for users. Second choice.

### CLI and config
- **clap 4.6.7** with `derive` and `env`. With `env` turned on, each flag can also be set by an environment variable (`#[arg(long, env = "OPENGRID_DATA_DIR")]`). That covers configuration on its own.
- **figment 0.10.19** has had **no release since 2024-05**. It works, but it is dormant and adds a layer we don't need. **Recommendation: clap + env vars only**, plus an optional `--config` TOML read with `toml`. Better yet, keep runtime settings in the SQLite `settings` table, editable from the admin UI. Avoid `dotenv` (RUSTSEC-2021-0141, unmaintained). Use `dotenvy` if you want `.env` files at all.

### Logging
- **tracing 0.1.44** and **tracing-subscriber 0.3.23** (`env-filter`, `json`). Use `tower_http::trace::TraceLayer` with `sensitive-headers` so Cookie and Authorization never reach the logs.

### Multipart uploads
- `axum` feature `multipart` wraps **multer 3.1.0**. multer has had no release since 2024-05. It is low-churn and still the only mainstream choice, and axum keeps it. Enforce limits with `DefaultBodyLimit::max(..)` per route plus `tower_http::limit::RequestBodyLimitLayer`. Stream to a temp file (`tempfile 3.27.0`) and hash while streaming. Never buffer a whole upload in RAM. Sniff content type yourself, and don't trust the client's MIME.

### SSE (realtime grid updates)
- Built into axum: `Sse<impl Stream<Item = Result<Event, _>>>` + `KeepAlive`. Feed it from a `tokio::sync::broadcast` channel per base, adapted with **tokio-stream 0.1.19** (`BroadcastStream`). `async-stream 0.3.6` is optional. SSE is lighter than WebSocket for a server-to-client feed and works through every reverse proxy. Use the axum `ws` feature only if we later need client-to-server streaming. Disable compression on the SSE route, or flush, so events are not buffered.

### Testing
- In-process HTTP tests: `tower::ServiceExt::oneshot` on the `Router`, plus `http-body-util` to collect bodies. No extra crate is needed.
- `axum-test`: stable **21.1.0**, with **22.0.0-rc.1** in progress. Nice to have for cookie-jar-aware flows. Use it as an optional dev-dependency on the stable version.
- **proptest 1.12.0**: property tests for the formula engine, filter and sort semantics, and CSV round-trips.
- **insta 1.49.0** (2026-10-03): snapshot API JSON and formula outputs.
- Benchmarks: **divan 0.1.21** (last release 2025-04, simple, attribute-based) or **criterion 0.8.2** (2026-02, more maintained, heavier). Prefer criterion for longevity. divan is fine for quick microbenchmarks.

### Browser e2e from Rust
| Crate | Version | Notes |
|---|---|---|
| **fantoccini** | 0.22.1 (2026-02-28) | WebDriver (chromedriver or geckodriver). Thin and stable API, async on tokio. **Recommended.** Runs headless in CI with geckodriver or chromedriver. |
| thirtyfour | 0.37.8 (released today) | Also WebDriver, higher level (component wrappers, query and wait helpers), actively released. Good alternative if you want richer helpers. |
| chromiumoxide | 0.9.1 (2026-02-25) | CDP directly, Chrome only, no driver binary, but it uses a large generated CDP bindings crate and builds slowly. |

Honest note: Playwright (Node) is still the stronger e2e tool. If "all Rust" is a hard rule, use fantoccini or thirtyfour.

### WASM toolchain
- **wasm-bindgen 0.2.129** (2026-09-25), **web-sys / js-sys 0.3.106**, **wasm-bindgen-test 0.3.79**, **gloo 0.12.0** (2026-03). All are current. The CLI version must match the crate version exactly.
- With getrandom 0.3 and later on wasm32-unknown-unknown, you must turn on the `wasm_js` backend. leptos's `csr` feature already sets `getrandom?/wasm_js`. jiff needs its `js` feature on wasm.

### Frontend framework
| | Stable | Pre-release | Notes |
|---|---|---|---|
| **Leptos** | **0.8.22** (2026-10-05, MSRV 1.88) | 0.9.0-beta2 | **CSR is first-class** (`features = ["csr"]`, built with **trunk**). 0.9 beta changes: lazy loading behind a `lazy` flag, signal call syntax `foo()` on stable, signals deref to `dyn Fn`, serde_qs 1.0 for server fns, edition 2024. **Expect breakage moving from 0.8 to 0.9. Start on 0.8.22 and plan to migrate when 0.9 is stable.** I could not confirm a 0.9 stable date (**UNVERIFIED**). |
| cargo-leptos | 0.3.11 (2026-10-02) | | Only needed for SSR or hydration. |
| **trunk** | **0.21.14** | 0.22.0-rc.2 | Build tool for CSR. Not installed locally. |
| Dioxus | 0.7.10 (2026-07-31) | 0.8.0-alpha.1 | `dx 0.7.10` installed locally. Strong, but it has more surface (desktop, mobile, fullstack), and its web target runs a VDOM. For a large, dense grid UI, Leptos's fine-grained reactivity is the better fit. |

**Recommendation: Leptos 0.8.22 CSR + trunk 0.21.14**, with axum serving the built `dist/` through rust-embed. One binary, and no SSR or hydration complexity, which also avoids a Node runtime. A spreadsheet-like grid is a highly interactive app, so CSR is fine. The **real risk is grid performance**: with 10k+ rows we need DOM virtualization (windowed rendering) written by hand in Leptos. No mature Rust grid component exists (**UNVERIFIED**; I found none). That cost belongs in the plan.

---

## 2. Recommended Cargo dependencies

Versions are the exact latest stable on crates.io on 2026-10-12. The server set below was verified to compile together on rustc 1.99.0.

### Server (`[dependencies]`)

| Crate | Version | Features | Why |
|---|---|---|---|
| tokio | `1.53.2` | `rt-multi-thread, macros, signal, sync, time, fs, net` | Standard async runtime that axum is built on. |
| axum | `0.8.9` | `multipart, macros` (+ default `http1, json, query, form, tokio`) | Main tokio-rs web framework. SSE and multipart built in. |
| axum-extra | `0.12.6` | `cookie, typed-header` | CookieJar and typed headers. Signed and private jars are not needed. |
| tower | `0.5.3` | `util, limit, timeout` | `ServiceExt::oneshot`, concurrency and timeout layers. |
| tower-http | `0.7.1` | `trace, compression-gzip, compression-br, limit, timeout, set-header, request-id, catch-panic, sensitive-headers` | Ready-made security and observability middleware. |
| rusqlite | `0.40.2` | `bundled, backup, functions, hooks, limits, serde_json` | Thin, synchronous, bundles SQLite 3.53.2, full SQLite API. Keeps the single binary. |
| tokio-rusqlite | `0.8.0` | | Dedicated writer-connection thread with an async handle. |
| deadpool-sqlite | `0.14.0` | `rt_tokio_1` (check feature name at integration) | Async reader-connection pool for rusqlite 0.40. |
| rusqlite_migration | `2.6.0` | | Migrations tracked by `user_version`, embedded, transactional, testable. |
| argon2 | `0.6.0` | default | Pure-Rust Argon2id with PHC strings. |
| totp-rs | `6.0.0` | `otpauth, gen_secret, zeroize` | RFC 6238 with constant-time compare. Current RustCrypto. |
| getrandom | `0.4.3` | | OS CSPRNG for tokens. |
| rand | `0.10.3` | | General randomness (non-secret IDs, jitter). |
| sha2 | `0.11.1` | | Hash stored tokens and API keys, content hashes for attachments. |
| hmac | `0.13.0` | | Webhook signatures, signed download URLs. |
| subtle | `2.6.1` | | Constant-time comparisons. |
| governor | `0.10.4` | | GCRA rate limiter used in our own trusted-proxy-aware middleware. |
| lettre | `0.11.23` | `default-features=false`: `smtp-transport, pool, hostname, builder, tokio1, tokio1-rustls, ring, webpki-roots` | SMTP over rustls. Defaults would pull native-tls/OpenSSL. |
| reqwest | `0.13.5` | `default-features=false`: `rustls-no-provider, json, stream, http2` | Outbound HTTP for webhooks and URL imports, no OpenSSL. |
| rustls | `0.23.45` | `default-features=false`: `ring, std, tls12, logging` | Install a single ring provider for reqwest and lettre (option b above). |
| image | `0.25.10` | `default-features=false`: `png, jpeg, gif, webp` | Thumbnails. No rayon, no C codecs, smaller decode attack surface. |
| rust-embed | `8.13.0` | `mime-guess` | Embeds the frontend `dist/` and migrations into the binary. |
| jiff | `0.2.38` | `serde` | DST-correct date and time zone fields, bundled tzdb. |
| croner | `4.0.1` | | Cron parsing and next-run for automations. Pulls chrono. |
| regex | `1.13.1` | | Linear-time regex, safe for user-supplied patterns with size limits. |
| csv | `1.4.0` | | CSV import and export. |
| serde | `1.0.229` | `derive` | Serialization. |
| serde_json | `1.0.154` | | JSON API and cell values. |
| clap | `4.6.7` | `derive, env` | CLI subcommands (`serve`, `migrate`, `backup`, `reset-password`) plus env-var config. |
| tracing | `0.1.44` | | Structured logging. |
| tracing-subscriber | `0.3.23` | `env-filter, json` | Log output and filtering. |
| tokio-stream | `0.1.19` | `sync` | Broadcast channel to SSE stream. |
| tempfile | `3.27.0` | | Stream uploads to disk safely. |
| uuid | `1.28.0` | `v7` | Time-ordered IDs for records and attachments. |
| base64 | `0.23.1` | | base64url tokens. |
| thiserror | `2.0.21` | | Library error types. |
| anyhow | `1.0.104` | | Errors in the binary and CLI. |
| zeroize | `1.9.1` | | Wipe secrets (TOTP seeds, tokens) from memory. |

### Dev / test (`[dev-dependencies]`)

| Crate | Version | Why |
|---|---|---|
| proptest | `1.12.0` | Property tests for the formula engine, filters and CSV round-trip. |
| insta | `1.49.0` (`json, yaml` or `redactions`) | API and formula snapshot tests. |
| http-body-util | latest 0.1.x (not checked) | Collect response bodies in `oneshot` tests. |
| axum-test | `21.1.0` (avoid 22.0.0-rc.1 until stable) | Optional cookie-aware request-flow tests. |
| criterion | `0.8.2` | Benchmarks (formula engine, query builder). divan `0.1.21` is the lighter alternative. |
| fantoccini | `0.22.1` | WebDriver browser e2e tests (thirtyfour `0.37.8` as alternative). |

### Frontend crate (`wasm32-unknown-unknown`)

| Crate | Version | Why |
|---|---|---|
| leptos | `0.8.22` (`csr`) | Fine-grained reactive CSR. Latest stable. 0.9 is still in beta. |
| leptos_router | match the 0.8.x line (not checked separately) | Client routing. |
| wasm-bindgen | `0.2.129` | JS interop. The CLI must match exactly. |
| web-sys | `0.3.106` | DOM APIs (EventSource for SSE, ResizeObserver for virtualization). |
| js-sys | `0.3.106` | JS globals. |
| gloo | `0.12.0` (pick sub-crates: `gloo-net`, `gloo-timers`) | Ergonomic fetch, timers and storage. |
| jiff | `0.2.38` (`js`) | Same date logic on client and server. |
| serde / serde_json | as above | Shared DTOs (put them in a shared `opengrid-core` crate). |
| wasm-bindgen-test | `0.3.79` (dev) | Unit tests that run in a headless browser. |

Tooling: `trunk 0.21.14` (`cargo install trunk --locked`). The `wasm32-unknown-unknown` target is already installed.

---

## 3. Crates and configurations to avoid

| Avoid | Why |
|---|---|
| `openssl`, `openssl-sys`, `native-tls` (anywhere in the tree) | Links the system OpenSSL, which breaks static and musl single-binary builds and cross-compiling. openssl has a steady stream of advisories (RUSTSEC-2025-0004 use-after-free, RUSTSEC-2025-0022 and others). Enforce this with `cargo deny` bans. |
| `lettre` with default features | Defaults include `native-tls`. |
| `lettre` `boring-tls` / `tokio1-boring-tls` | RUSTSEC-2026-0141: TLS hostname verification disabled. |
| `reqwest` `native-tls*` features | OpenSSL linkage. Use rustls. |
| `sqlx` (for this project) | Heavy (MSRV 1.94, macros, offline cache), async wrapper over a thread anyway, hides SQLite controls. It would also be a second SQLite binding next to rusqlite (`libsqlite3-sys` `links` conflict if versions differ). |
| `tower-sessions` + sqlx store | Pulls sqlx. 8 months since last release. Hand-rolled DB sessions are simpler and auditable. |
| `rusqlite` without `bundled` | Depends on the host's SQLite version, which defeats the single-binary goal. |
| `bundled-sqlcipher-vendored-openssl` | Brings OpenSSL back. Use filesystem or volume encryption instead. |
| `image` default features | Pulls `rayon` (thread pool, memory on 1 vCPU) and many exotic decoders (larger attack surface). Never enable `avif-native` or `nasm`. |
| `fancy-regex` for user input | Backtracking means ReDoS. |
| `figment`, `include_dir`, `r2d2` | Not broken, but dormant (last releases 2024-05, 2024-06 and 2022-06). Better-maintained or zero-dependency options exist. |
| `dotenv` | Unmaintained (RUSTSEC-2021-0141). Use `dotenvy` if needed. |
| `async-std` and anything built on it | Discontinued (RUSTSEC-2025-0052). |
| `instant`, `atty`, `paste`, `proc-macro-error`, `yaml-rust`, `serde_yaml`, `backoff` | All flagged unmaintained or vulnerable in RustSec. Ban them via `cargo deny`. Use `serde_yml`/`toml` instead of YAML, or avoid YAML entirely. |
| `tower_governor` default features | Pulls `tonic` (gRPC) for nothing. If used, set `default-features = false, features = ["axum"]`. |
| Pre-releases: leptos `0.9.0-beta2`, trunk `0.22.0-rc.2`, dioxus `0.8.0-alpha.1`, axum-test `22.0.0-rc.1`, rustls `0.24.0-dev.1` | Not stable. `cargo search` lists them as "latest", so pin exact stable versions. |
| `ring < 0.17` | Unmaintained (RUSTSEC-2025-0010). |
| `rustls < 0.23.45` | RUSTSEC-2026-0285 (published 2026-09-14). |

## 4. Supply-chain guardrails to adopt from day one
- Add `cargo-deny` (not installed locally; `cargo install cargo-deny --locked`) with: `bans` for openssl-sys, native-tls, async-std and the unmaintained list above; `advisories` from the RustSec DB; a `licenses` allowlist (MIT, Apache-2.0, BSD-2/3, ISC, Unicode-3.0, Zlib, Unlicense, CDLA-Permissive-2.0 for webpki-roots); and `sources` limited to crates.io.
- Commit `Cargo.lock`, build with `--locked`, and set `rust-version` in the workspace (MSRVs found: image and totp-rs need 1.88, argon2/reqwest/lettre need 1.85). A floor of 1.88 or later is safe, and the local toolchain is 1.99.
- Release profile for a small binary and a low-RAM host: `opt-level = 3` (or `"s"`), `lto = "thin"`, `codegen-units = 1`, `panic = "abort"` (audit this; abort kills the whole process on a handler panic, so keep `CatchPanicLayer` with `unwind` instead), `strip = true`.

## 5. Things I could not verify
- Leptos 0.9 stable release date. trunk 0.22 stable date.
- The exact binary size and RSS of the recommended stack (no release build or measurement was run). This should be measured early against the 512 MB budget.
- tower-http 0.7 `csrf` feature API and quality.
- The deadpool-sqlite runtime feature name (`rt_tokio_1` follows the deadpool convention but was not in the probe).
- Whether a maintained jiff-native cron crate exists, which would let us drop chrono.
- The current state of tower-sessions SQLite stores.
- Advisory status relies on OSV.dev as of 2026-10-12. Re-check in CI with `cargo deny check advisories`.

## Sources
- crates.io API (`https://crates.io/api/v1/crates/<name>` and `/<version>`) for versions, dates, features, MSRV and dependencies (queried 2026-10-12).
- Local `cargo search`, `cargo tree` and `cargo check` on rustc 1.99.0.
- OSV.dev batch query API (RustSec and GHSA) for advisories.
- [Leptos v0.9.0-beta release notes (newreleases.io mirror)](https://newreleases.io/project/github/leptos-rs/leptos/release/v0.9.0-beta)
- [tower-governor repository](https://github.com/benwis/tower-governor), [docs.rs tower_governor](https://docs.rs/tower_governor)
- [jiff on docs.rs](https://docs.rs/crate/jiff) and [ecosyste.ms jiff](https://packages.ecosyste.ms/registries/crates.io/packages/jiff) for the 1.0 timeline statement.
