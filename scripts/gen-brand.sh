#!/usr/bin/env bash
# Regenerate the web client's brand files (favicon, touch and manifest icons, and the inline
# path data of <Logo>) from brand/, the source of truth for the logo.
#
#   scripts/gen-brand.sh          rewrite the files in place
#   scripts/gen-brand.sh --check  fail if a committed file differs from brand/ (scripts/check.sh);
#                                 never modifies the tree
#
# Needs only node. The generated files are committed, so building the web client does not need
# brand/'s own tooling (Python, rsvg-convert, ImageMagick).
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/gen-brand.mjs "$@"
