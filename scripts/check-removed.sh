#!/usr/bin/env bash
# Removed-code check (UX overhaul DONE-3): fail while any piece of the old interface, or code doing its
# job, is still in the web client, and fail when a release build carries the design reference page.
#
#   scripts/check-removed.sh                 builds a release bundle into a temporary directory and checks it
#   scripts/check-removed.sh --dist web/dist checks a release build that already exists (scripts/check.sh
#                                            passes the one it has just built)
#
# What must stay gone, and what replaced it (the plan's decisions 4, 5 and 6 and the NAV, HOME, COL and
# REC requirements):
#   - the ExpandedRecord modal and the RecordPanel stack of linked records      -> the record page
#   - the ViewBar toolbar, toolbarFit.ts and the FloatingAdd pill                -> the filter bar, View options
#   - the debounced view auto-save                                               -> Save as view / Update view
#   - the icon pickers, the lazy full icon set and popular.ts                    -> colour marks places
#   - entity icon rendering (EntityIcon, TableIcon, EntityTile's icon fallbacks) -> colour marks places
#   - the Inbox page (its route only redirects to Home)                          -> Home's Inbox card
#   - the phone SidebarDrawer and the sticky app top bar                         -> the bottom navigation and
#                                                                                   each screen's own header
# The API's stored `icon` fields stay (agents set them through MCP); only the web client's drawing and
# picking of them went. Names are matched as whole words in web/src, web/e2e and web/dev, comments and
# tests included: a comment that names a removed thing is reworded rather than exempted.
#
# Plain grep and find; without --dist it also needs web/node_modules, for the release build.
set -euo pipefail
cd "$(dirname "$0")/.."

DIST=""
if [[ "${1:-}" == "--dist" ]]; then
  DIST="${2:?--dist needs a directory}"
elif [[ $# -gt 0 ]]; then
  echo "usage: scripts/check-removed.sh [--dist DIR]" >&2
  exit 2
fi

SCAN=(web/src web/e2e web/dev)
failures=0
fail() {
  printf '  %s\n' "$1" >&2
  failures=$((failures + 1))
}

# Whole-word names of the removed components and helpers (also matched as file names, any extension).
names=(
  ExpandedRecord RecordPanel RecordPanelStack LinkedRecordPanel
  ViewBar ViewSwitcher toolbarFit FloatingAdd
  IconPicker IconPickerDialog IconPickerPanel EntityIcon EntityLabel EntityTile WorkspaceTile TableIcon
  POPULAR_ICONS requestFullIconSet popular fullSet
  SidebarDrawer TopBar AppTopBar BaseTopBar
  InboxPage
)
alternation="$(IFS='|'; echo "${names[*]}")"

echo "==> removed files"
while IFS= read -r path; do
  fail "$path exists"
done < <(find "${SCAN[@]}" -type f 2>/dev/null | grep -E "/(${alternation})(\\.[^/]*)?\$" || true)
for dir in web/src/components/icons web/src/pages/inbox; do
  if [[ -e "$dir" ]]; then fail "$dir exists"; fi
done

echo "==> removed names"
while IFS= read -r hit; do
  fail "$hit"
done < <(grep -rnwE "$alternation" "${SCAN[@]}" 2>/dev/null || true)
while IFS= read -r hit; do
  fail "$hit"
done < <(grep -rnE "components/icons|lucide-react/dist/esm/icons" "${SCAN[@]}" 2>/dev/null || true)

echo "==> Inbox route (old links may redirect to Home, nothing more)"
while IFS= read -r hit; do
  fail "$hit (an /inbox route must be a <Navigate>, not a page)"
done < <(grep -rnE "path=\"[^\"]*/inbox[^\"]*\"" web/src 2>/dev/null | grep -v "Navigate" | grep -v "\\.test\\." || true)

# A view changes only through Save as view and Update view. The record editors' autosave is a different
# thing, so the test is: the view config hook has no timer, and no file that updates a view also debounces
# or autosaves.
echo "==> view auto-save"
if grep -qE "setTimeout|debounce|Debounce|[Aa]utosave|AUTOSAVE" web/src/views/grid/useViewConfig.ts 2>/dev/null; then
  fail "web/src/views/grid/useViewConfig.ts has a timer or an autosave"
fi
while IFS= read -r file; do
  if grep -qE "debounce|Debounce|[Aa]utosave|AUTOSAVE" "$file"; then
    fail "$file updates a view and debounces or autosaves"
  fi
done < <(grep -rlE "useUpdateView|useSaveView|api\\.views\\.update" web/src 2>/dev/null | grep -v "\\.test\\." || true)

echo "==> release build has no /__dev/design route"
if [[ -z "$DIST" ]]; then
  if [[ ! -d web/node_modules ]]; then
    echo "web/node_modules is missing: run (cd web && npm ci --ignore-scripts), or pass --dist DIR." >&2
    exit 1
  fi
  DIST="$(mktemp -d)"
  trap 'rm -rf "$DIST"' EXIT
  # A release build is `vite build` without VITE_DESIGN_PAGE; only the e2e build sets it.
  (cd web && env -u VITE_DESIGN_PAGE npx vite build --outDir "$DIST" --emptyOutDir >/dev/null)
fi
if [[ ! -f "$DIST/index.html" ]]; then
  echo "$DIST/index.html is missing: that is not a web build." >&2
  exit 1
fi
while IFS= read -r hit; do
  fail "$hit carries the /__dev/design route (build without VITE_DESIGN_PAGE)"
done < <(grep -rlE "__dev/design|Design reference" "$DIST" 2>/dev/null || true)

if ((failures > 0)); then
  printf '\n%d thing(s) that were removed are still here (UX overhaul DONE-3).\n' "$failures" >&2
  exit 1
fi
echo "Nothing that was removed has come back."
