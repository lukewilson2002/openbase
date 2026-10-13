#!/usr/bin/env bash
# Does the real `claude` CLI connect to OpenGrid's MCP endpoint?
#
# Starts a throwaway OpenGrid on a random localhost port with a temporary data directory,
# signs up an administrator and creates a write+manage API token (what the account page does),
# then in a temporary project directory:
#
#   1. runs the command the account page shows ("Connect an AI assistant (MCP)"),
#      `claude mcp add --transport http opengrid <url> --header "Authorization: Bearer <token>"`,
#      and `claude mcp list`. Success = the list shows `opengrid` as connected.
#   2. writes the same server as a project-scoped `.mcp.json` and reports what `claude mcp list`
#      says (Claude Code asks the user to approve project-scoped servers once, so a fresh
#      checkout is expected to show "Pending approval"; this part is informational).
#
# Nothing global is touched: `claude` runs with HOME (and its config directories) pointing at a
# temporary directory, so the real ~/.claude and ~/.claude.json are neither read nor modified,
# and everything (server, data, config, token) is deleted on exit.
#
#   scripts/mcp-claude-check.sh            # builds target/debug/opengrid if needed
#   OPENGRID_BIN=/path/to/opengrid scripts/mcp-claude-check.sh
#
# Exit status: 0 = connected, or skipped because `claude` / python3 / curl is not installed
# (printed as SKIP); 1 = the CLI could not connect.
set -euo pipefail
cd "$(dirname "$0")/.."

skip() { printf 'SKIP: %s\n' "$*"; exit 0; }
command -v claude >/dev/null 2>&1 || skip "the 'claude' CLI is not on PATH"
command -v curl >/dev/null 2>&1 || skip "curl is not installed"
command -v python3 >/dev/null 2>&1 || skip "python3 is not installed"

BIN="${OPENGRID_BIN:-target/debug/opengrid}"
if [[ -z "${OPENGRID_BIN:-}" ]]; then
  cargo build -q -p opengrid
fi
[[ -x "$BIN" ]] || { echo "no opengrid binary at $BIN" >&2; exit 1; }

TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
URL="http://127.0.0.1:$PORT"
mkdir -p "$TMP/data" "$TMP/project" "$TMP/home"

OPENGRID_DATA_DIR="$TMP/data" OPENGRID_BIND="127.0.0.1:$PORT" OPENGRID_PUBLIC_URL="$URL" \
  OPENGRID_BACKUP_HOUR=-1 "$BIN" serve >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 100); do
  curl -fs "$URL/api/health" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { cat "$TMP/server.log" >&2; echo "the server exited" >&2; exit 1; }
  sleep 0.1
done
curl -fs "$URL/api/health" >/dev/null || { cat "$TMP/server.log" >&2; echo "the server did not start" >&2; exit 1; }

# The first account becomes the administrator; the token is what the account page would create.
JAR="$TMP/cookies"
api() { curl -fsS -b "$JAR" -c "$JAR" -H 'content-type: application/json' -H 'x-opengrid-csrf: 1' "$@"; }
api -X POST "$URL/api/auth/signup" \
  -d '{"email":"check@example.com","name":"Check","password":"a long throwaway password 1"}' >/dev/null
TOKEN="$(api -X POST "$URL/api/tokens" -d '{"name":"claude-check","write":true,"manage":true}' |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"

export HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" CLAUDE_CONFIG_DIR="$TMP/home/.claude"
cd "$TMP/project"
echo "$(claude --version 2>&1 | head -1) -> $URL/mcp"

# 1. The command the account page shows, in the temporary project with the temporary HOME.
claude mcp add --transport http opengrid "$URL/mcp" --header "Authorization: Bearer $TOKEN"
OUT="$(timeout 90 claude mcp list 2>&1 || true)"
echo "$OUT"
LINE="$(echo "$OUT" | grep -E '^opengrid:' || true)"

# 2. The same server as a project-scoped .mcp.json.
claude mcp remove opengrid >/dev/null 2>&1 || true
cat >"$TMP/project/.mcp.json" <<EOF
{
  "mcpServers": {
    "opengrid": {
      "type": "http",
      "url": "$URL/mcp",
      "headers": { "Authorization": "Bearer $TOKEN" }
    }
  }
}
EOF
PROJECT_LINE="$(timeout 90 claude mcp list 2>&1 | grep -E '^opengrid:' || true)"
echo "project-scoped .mcp.json: ${PROJECT_LINE:-<not listed>}"

if echo "$LINE" | grep -qi 'connected' && ! echo "$LINE" | grep -qiE 'fail|needs auth|error|pending'; then
  echo "OK: claude mcp list shows opengrid connected"
  exit 0
fi
echo "FAILED: claude mcp list does not show opengrid as connected" >&2
exit 1
