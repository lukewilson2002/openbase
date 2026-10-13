#!/usr/bin/env bash
# Regenerate crates/server/data/lucide-icons.txt (the Lucide icon names MCP tools accept and
# `list_icons` searches) from the lucide-react package installed in web/node_modules.
#
#   scripts/gen-icons.sh          rewrite the file in place
#   scripts/gen-icons.sh --check  fail if the committed file differs from a fresh generation
#                                 (scripts/check.sh); never modifies the tree
#
# Needs `npm ci --ignore-scripts` in web/ first. The file is committed, so building the server
# needs neither Node nor web/node_modules.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=crates/server/data/lucide-icons.txt
FRESH="$(mktemp)"
trap 'rm -f "$FRESH"' EXIT
node scripts/gen-icons.mjs >"$FRESH"

if [[ "${1:-}" == "--check" ]]; then
  if ! diff -q "$FRESH" "$OUT" >/dev/null; then
    echo "$OUT is out of date. Run scripts/gen-icons.sh and commit the result." >&2
    exit 1
  fi
  echo "Icon list is current."
else
  mkdir -p "$(dirname "$OUT")"
  cp "$FRESH" "$OUT"
  echo "Wrote $OUT ($(grep -vc '^#' "$OUT") icons)."
fi
