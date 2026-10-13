#!/usr/bin/env bash
# Full local check: formatting, lints, Rust tests, generated TypeScript bindings, the web
# checks, and the live contract tests (TypeScript API client against the real server).
# Run before every commit.
#
# OPENGRID_E2E=1 scripts/check.sh additionally runs the Playwright end-to-end tests in the
# locally installed Google Chrome (builds the web client and the server, starts it on a temporary
# data directory; see web/playwright.config.ts). They are opt-in because they need Chrome and take
# a minute or two.
#
# The web steps need `npm ci --ignore-scripts` in web/ once; without node_modules this script
# stops there with a hint (it does not silently skip them).
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$*"; }

step "cargo fmt --check"
cargo fmt --all -- --check
step "cargo clippy"
cargo clippy --workspace --all-targets -- -D warnings
step "cargo test"
cargo test --workspace

step "TypeScript bindings are current (scripts/gen-types.sh --check)"
scripts/gen-types.sh --check

if [[ ! -d web/node_modules ]]; then
  cat >&2 <<'EOF'

web/node_modules is missing, so the web checks cannot run.
Install the pinned dependencies, then re-run scripts/check.sh:

    (cd web && npm ci --ignore-scripts)

EOF
  exit 1
fi

step "web: tsc --noEmit"
(cd web && npx tsc --noEmit)
step "web: unit tests"
(cd web && npm test -- --run)
step "web: production build"
(cd web && npm run build)
step "web: live contract tests (builds and starts target/debug/opengrid)"
(cd web && npm run test:contract)

if [[ "${OPENGRID_E2E:-}" == "1" ]]; then
  step "web: end-to-end tests (Chrome; builds web/dist and the embedded server, then drives them)"
  (cd web && npm run e2e)
else
  printf '\n(skipping the end-to-end tests; run with OPENGRID_E2E=1 to include them)\n'
fi

printf '\nAll checks passed.\n'
