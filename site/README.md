# OpenBase website (myopenbase.app)

The public site: a landing page and the documentation. [Astro](https://astro.build) with the
[Starlight](https://starlight.astro.build) docs theme, static output only (no server, no adapter),
no analytics, no cookies, no third-party requests: fonts, icons, search and screenshots are all
served from the site itself. It is deployed by **Cloudflare Pages** from this repository.

## The documentation is not copied

`docs/*.md` (and `CHANGELOG.md`) in the repository are the single source of truth. Every build runs
`scripts/sync-docs.mjs` first, which writes them into `src/content/docs/docs/` with Starlight front
matter and rewrites links:

| Source | Page |
|---|---|
| `docs/self-hosting.md` | `/docs/self-hosting/` |
| `docs/mcp.md` | `/docs/mcp/` (sidebar: Connect AI assistants) |
| `docs/automations.md` | `/docs/automations/` |
| `docs/api.md` | `/docs/api/` |
| `docs/security.md` | `/docs/security/` |
| `docs/releasing.md` (when it exists) | `/docs/releasing/` (sidebar: Releasing (maintainers)) |
| `CHANGELOG.md` (when it exists) | `/docs/changelog/` |

Links between synced docs become site links, links to any other file in the repository
(`../README.md#configuration`, `deploy/Caddyfile`, ...) become GitHub `blob`/`tree` URLs, and local
images are copied to `public/docs-assets/`. The generated files, the copied brand assets
(`src/assets/brand/`, `public/favicon.*`, `public/apple-touch-icon.png`) and `public/docs-assets/` are
gitignored; do not edit them. Edit the source file in `docs/`. Missing optional docs are skipped
silently; a missing required one makes the build fail in `scripts/postbuild.mjs`.

Hand-written pages live in `src/content/docs/`: `docs/index.md` (overview), `docs/quickstart.md`, `404.md`.
The landing page is `src/pages/index.astro` (styles in `src/styles/landing.css`; the theme tokens match
the app and `brand/README.md` in `src/styles/theme.css`).

## Commands

```sh
cd site
npm ci               # lockfile install, no lifecycle scripts (.npmrc)
npm run dev          # sync docs, then http://localhost:4321 with hot reload
npm run build        # sync docs, build into dist/, write the CSP hashes into dist/_headers
npm run preview      # Astro's preview server (does not apply _headers)
npm run serve        # dist/ with _headers and _redirects applied, like Cloudflare Pages (port 4400)
npm run check-links  # dist/: internal links and #anchors, one h1 per page, alt/width/height on images, canonical URLs
npm run smoke        # Chrome opens every page (desktop and phone, light and dark) under the real CSP; checks search
```

Node 24 (`.node-version`). `npm run check-links -- --external` also requests every external link once
(needs network; not run in CI).

## Screenshots

`public/screenshots/*.webp` are real screenshots of the app. `npm run screenshots` regenerates them:
it starts an **existing** release binary on a free localhost port (8080 when free) with a temporary data
directory, creates the first admin, seeds a made-up bakery through the REST API (customers, orders with
linked records and a formula, products with generated photos, a production plan, a public form,
automations), drives the installed Google Chrome with Playwright (`channel: "chrome"`; no browser is
downloaded), writes 2x WebP files under 300 KB each, then stops the server and deletes the data directory.

```sh
OPENBASE_BIN=../target/release/openbase npm run screenshots    # default: <repo>/target/release/openbase
npm run screenshots -- --only grid,kanban                      # only some shots
npm run screenshots -- --seed-only                             # seed, print the URL and login, wait for Ctrl-C
```

Build the binary the usual way first (`cargo build --release -p openbase` after `cd web && npm ci && npm run build`).
Dates in the demo are relative to today, so regenerated calendar and timeline images show the current month.

`public/og.png` (1200x630 social preview) is generated from the brand lockup by `scripts/make-og.sh`
(needs `rsvg-convert` and ImageMagick).

## Security headers

`public/_headers` sets a strict Content-Security-Policy (`default-src 'none'`, scripts only from the site
itself, from the build's inline scripts by sha256 hash, and `wasm-unsafe-eval` for the Pagefind search index),
HSTS (one year, without `includeSubDomains` or `preload` on purpose), `nosniff`, a referrer policy,
`frame-ancestors 'none'` and a Permissions-Policy. The inline-script hashes are computed by
`scripts/postbuild.mjs` at build time and substituted for `__SCRIPT_HASHES__`, so an upgrade of Astro or
Starlight cannot silently break the policy. `npm run smoke` serves `dist/` with these headers and fails
on any violation.

## Cloudflare Pages settings

Create the project with **Workers & Pages -> Create -> Pages -> Connect to Git**, choose this repository, then:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | `Astro` |
| Root directory | `site` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Environment variable (production and preview) | `NODE_VERSION` = `24` (in addition to `site/.node-version`) |
| Build watch paths -> Include paths | `site/**`, `docs/**`, `brand/**`, `CHANGELOG.md` |
| Preview deployments | Enabled for all non-production branches and pull requests (the default) |

Notes:

- The build needs the whole repository checked out, which Pages does: `scripts/sync-docs.mjs` reads
  `../docs`, `../CHANGELOG.md` and `../brand`, and that is why changes to those paths must trigger a build
  (the watch paths above).
- **Custom domain:** in the project, Custom domains -> Set up a custom domain -> `myopenbase.app`. If the
  zone is on Cloudflare the DNS record is created for you.
- **www to apex:** Pages cannot redirect by host name (`_redirects` matches paths only), so use a
  Cloudflare redirect rule. First add a proxied DNS record for `www` (type `AAAA`, name `www`, content
  `100::`, proxied). Then Rules -> Redirect Rules -> Create rule: when *Hostname* equals
  `www.myopenbase.app`, run a **Dynamic** redirect to `concat("https://myopenbase.app", http.request.uri.path)`,
  status 301, with *Preserve query string* on.
- `public/_redirects` only contains a few short links (`/quickstart`, `/mcp`, ...).
- Every page has a canonical URL on `https://myopenbase.app`, so `*.pages.dev` preview and production
  addresses are not indexed as duplicates.
- Analytics: none. Do not turn on Cloudflare Web Analytics if you want the "no third-party requests"
  property: it injects a script, which the CSP would also block.

## Verified and not verified

Verified locally with Node 24.18 and Google Chrome: `npm ci` and `npm run build` from a clean checkout of
`site/`, the link and anchor check, the browser smoke test with the CSP and `_headers` applied, the screenshot
generator against a real release binary.

Not verified: a build on Cloudflare Pages itself (its build image has to offer Node 24, which is why
`NODE_VERSION` is set; if it does not, the log says so), the `_headers` and `_redirects` rules on Cloudflare's
edge (the local server in `scripts/serve-dist.mjs` imitates them), and the www redirect rule.
