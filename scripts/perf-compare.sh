#!/usr/bin/env bash
# DONE-10: opening a collection of 50,000 records, and the first screen's JavaScript, on this
# checkout against `main` (or MAIN_REF), on this machine.
#
#   scripts/perf-compare.sh                # RUNS=5 RECORDS=50000 MAIN_REF=main
#   KEEP_MAIN=1 scripts/perf-compare.sh    # keep the main worktree and its build for another run
#
# Builds a release server with the web client embedded for both sides (main in a temporary git
# worktree under .claude/worktrees/perf-main, with its own CARGO_TARGET_DIR inside it so nothing
# collides with this checkout's target directory), then web/e2e/perf/compare.mjs starts each side's
# server on a throwaway data directory, loads the records through the API, and times the runs
# alternately. Exits 1 when the checkout is more than 10% slower or its entry JavaScript is larger.
#
# A Rust target directory is 5 to 40 GB: the script stops when less than MIN_FREE_GB (60) is free,
# and removes the worktree and its target when it is done (unless KEEP_MAIN=1), also on failure.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MAIN_REF=${MAIN_REF:-main}
MAIN="$ROOT/.claude/worktrees/perf-main"
MIN_FREE_GB=${MIN_FREE_GB:-60}

free_gb=$(df -k "$ROOT" | awk 'NR==2 {printf "%d", $4/1024/1024}')
if ((free_gb < MIN_FREE_GB)); then
  echo "only ${free_gb} GB free, need ${MIN_FREE_GB} GB for a second build: free some space first" >&2
  exit 2
fi

cleanup() {
  if [[ -z "${KEEP_MAIN:-}" && -d "$MAIN" ]]; then
    git -C "$ROOT" worktree remove --force "$MAIN" 2>/dev/null || true
    rm -rf "$MAIN" # the target directory is untracked, so remove --force leaves it behind
    git -C "$ROOT" worktree prune
  fi
}
trap cleanup EXIT

[[ -d "$MAIN" ]] || git -C "$ROOT" worktree add --detach "$MAIN" "$MAIN_REF"

build() { # DIR TARGET_DIR: the web client, then the server that embeds it
  (cd "$1/web" && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run build >/dev/null)
  # rust-embed tracks the files it embedded, not new ones: make sure the crate is rebuilt.
  touch "$1/crates/server/src/web.rs"
  (cd "$1" && CARGO_TARGET_DIR="$2" cargo build --release -p openbase --bin openbase)
}
echo "==> building this checkout"
build "$ROOT" "${CARGO_TARGET_DIR:-$ROOT/target}"
echo "==> building $MAIN_REF"
build "$MAIN" "$MAIN/target"

cd "$ROOT/web"
node e2e/perf/compare.mjs \
  --branch-bin "${CARGO_TARGET_DIR:-$ROOT/target}/release/openbase" --branch-dist "$ROOT/web/dist" \
  --main-bin "$MAIN/target/release/openbase" --main-dist "$MAIN/web/dist" \
  --runs "${RUNS:-5}" --records "${RECORDS:-50000}"
