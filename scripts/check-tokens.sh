#!/usr/bin/env bash
# Design-token check (UX overhaul DL-1): fail on a raw hex colour, rgb()/rgba()/hsl() colour or px
# font size in web/src outside the exempt lists. See scripts/check-tokens.mjs for the rules and
# scripts/check-tokens.temporary-list.txt for the files that have not moved to tokens yet.
#
#   scripts/check-tokens.sh
#
# Plain Node, no dependencies: it does not need web/node_modules. scripts/check.sh runs it, and CI
# runs scripts/check.sh. The detector's own tests are web/src/styles/checkTokens.test.mjs, run by
# the web unit tests (Vitest).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/check-tokens.mjs
