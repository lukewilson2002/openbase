# Contributing to OpenBase

Thanks for helping. The short version: run `scripts/check.sh` before you push; a pull request is
ready when CI is green.

## Setting up

You need Rust (rustup installs the exact version `rust-toolchain.toml` pins), Node 26 (the
active LTS line), [cargo-deny](https://github.com/EmbarkStudios/cargo-deny) for the dependency
scan (`cargo install --locked cargo-deny` or `brew install cargo-deny`) and, for the end-to-end
tests, Google Chrome. Nothing is downloaded for the tests: they use the Chrome you already have.

The toolchains are pinned on purpose: Rust to an exact version (raise it in `rust-toolchain.toml`
and in the `rust:` tag of `deploy/Dockerfile` together; the Docker build refuses a mismatch) and
Node to the active LTS line (26 since 2026-10-28; Node 24 moved to maintenance on 2026-10-20). To
move to the next LTS, change the Node version in CI, the release workflow, the Dockerfile, the
README and here in one commit.

```sh
git clone https://github.com/lukewilson2002/openbase
cd openbase
(cd web && npm ci --ignore-scripts)     # once
scripts/check.sh                        # the full local check
OPENBASE_E2E=1 scripts/check.sh         # the same plus the Playwright end-to-end tests
```

`scripts/check.sh` runs rustfmt, clippy with `-D warnings`, `cargo deny check` (advisories,
licences, bans, sources; policy in `deny.toml`), `npm audit --audit-level=high`, the Rust tests,
the generated-file checks (TypeScript bindings, icon list, brand files), the design-token check (no
raw colour or px font size in `web/src`; see `scripts/check-tokens.mjs`), the removed-code check
(the old interface stays gone and a release build has no design reference page; see
`scripts/check-removed.sh`), `tsc`, Vitest, the
production web build and the live contract tests. The two audits need network access. Details and other scripts are in the
[README](README.md#running-the-tests). If you change a Rust type that crosses the API, run
`scripts/gen-types.sh` and commit the regenerated bindings.

CI (`.github/workflows/ci.yml`) runs the same script and the end-to-end tests on every pull request
and on every push to `main`, plus a gitleaks scan of the git history and a Trivy scan of the Docker
image (critical or high findings that have a fix fail it). It never publishes anything. To run those
two yourself: `gitleaks git --redact .` and, after `docker build -f deploy/Dockerfile -t openbase:scan .`,
`trivy image --severity CRITICAL,HIGH --ignore-unfixed openbase:scan`.

## Pull requests

- Keep a change focused, with tests for new behaviour. Say in the description what you ran.
- Note user-visible changes under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- Security problems do not belong in a public pull request: see [SECURITY.md](SECURITY.md).
- By contributing you agree that your work is licensed like the project, under either the Apache
  License 2.0 or the MIT license, at the user's option.

## How releases work

Only a maintainer publishes releases, and **only a published GitHub Release builds and publishes
anything**. Merging to `main` deploys nothing and moves no Docker tag.

1. `scripts/release.sh X.Y.Z` bumps the version everywhere, writes the changelog section, runs the
   checks, commits `Release vX.Y.Z` and creates the annotated tag `vX.Y.Z`.
2. The maintainer pushes (`git push origin main --follow-tags`) and creates the GitHub Release for
   the tag (`gh release create vX.Y.Z --verify-tag --notes-from-tag`).
3. Publishing the release starts `.github/workflows/release.yml`: it checks that the tag matches the
   version in the tree, runs the full checks, builds the web client once, builds linux/amd64 and
   linux/arm64, smoke-tests the images, then publishes `ghcr.io/lukewilson2002/openbase`
   (tags `X.Y.Z`, `X.Y`, `X`, `latest`; pre-releases get only their exact tag) and attaches the
   binaries and `SHA256SUMS` to the release.

The maintainer's full procedure, including the one-time setup, is in
[docs/releasing.md](docs/releasing.md).
