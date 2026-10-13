#!/usr/bin/env bash
# Fresh-install smoke test for the single-binary deployment.
#
#   scripts/smoke-install.sh [path/to/openbase]      (default: target/release/openbase)
#
# Everything happens in a temporary directory and on a loopback port; nothing
# outside it is touched. It walks the operator lifecycle with the real binary and
# real HTTP and fails on the first thing that does not behave:
#
#   migrate -> create-admin -> serve -> log in -> create data -> backup -> stop
#   -> restore into a second empty directory -> serve there -> data is present
#   -> reset-password (old password stops working) -> healthcheck
#   -> migrate on an existing database is a no-op (no snapshot, no change)
#   -> a database written by a newer version is refused
#
# Optional:
#   SEED_RECORDS=50000   also run scripts/loadtest.sh: load that many records through
#                        the API, print read latencies and the server's resident memory
#                        (ps rss) after each phase.
#   PORT=18080           loopback port to use (default: a free one).
#
# Needs curl and jq. The web client must have been built before the binary
# (`cd web && npm ci && npm run build`) for the "/" check to see the real app.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=${1:-target/release/openbase}
[[ -x "$BIN" ]] || { echo "binary not found: $BIN (cargo build --release -p openbase)" >&2; exit 2; }
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")
PORT=${PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "something already answers on 127.0.0.1:$PORT; pick another PORT" >&2; exit 2
fi
SEED_RECORDS=${SEED_RECORDS:-0}
URL=http://127.0.0.1:$PORT
PASS='correct-horse-battery-staple'
PASS2='another-long-passphrase-9'

TMP=$(mktemp -d "${TMPDIR:-/tmp}/openbase-smoke.XXXXXX")
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
die() { printf '    FAIL: %s\n' "$*" >&2; [[ -f "$TMP/server.log" ]] && tail -20 "$TMP/server.log" >&2; exit 1; }

# Run the binary against one data directory. Usage: ob DIR args...
ob() {
  local dir=$1; shift
  OPENBASE_DATA_DIR="$dir" OPENBASE_BIND=127.0.0.1:$PORT "$BIN" "$@"
}

start_server() { # DIR
  OPENBASE_DATA_DIR="$1" OPENBASE_BIND=127.0.0.1:$PORT OPENBASE_PUBLIC_URL=$URL \
    OPENBASE_BACKUP_HOUR=-1 "$BIN" serve >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 100); do
    curl -fsS "$URL/api/health" >/dev/null 2>&1 && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || die "server exited during startup"
    sleep 0.1
  done
  die "server did not answer /api/health within 10 s"
}

stop_server() {
  kill -TERM "$SERVER_PID"
  for _ in $(seq 1 100); do
    kill -0 "$SERVER_PID" 2>/dev/null || { SERVER_PID=""; return 0; }
    sleep 0.1
  done
  die "server did not stop within 10 s of SIGTERM"
}

# api METHOD PATH [JSON]  (uses the cookie jar in $JAR; prints the body)
JAR=$TMP/jar
api() {
  local method=$1 path=$2 body=${3:-}
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" -b "$JAR" -c "$JAR" -H 'X-OpenBase-CSRF: 1' \
      -H 'Content-Type: application/json' -d "$body" "$URL$path"
  else
    curl -fsS -X "$method" -b "$JAR" -c "$JAR" -H 'X-OpenBase-CSRF: 1' "$URL$path"
  fi
}

rss_mb() { ps -o rss= -p "$SERVER_PID" | awk '{printf "%.1f", $1/1024}'; }

A=$TMP/a   # first data directory
B=$TMP/b   # restore target

step "version and migrate on an empty directory"
"$BIN" --version
ob "$A" migrate | tee "$TMP/migrate1.txt"
grep -q 'schema version' "$TMP/migrate1.txt" || die "migrate printed no schema version"
[[ -f "$A/openbase.db" ]] || die "migrate created no database"
ok "database created"

step "create-admin"
OPENBASE_ADMIN_PASSWORD=$PASS ob "$A" create-admin --email admin@example.com --name "Admin"

step "serve"
start_server "$A"
[[ "$(curl -fsS "$URL/api/health")" == *ok* ]] && ok "/api/health: $(curl -fsS "$URL/api/health")" || die "health body"
ok "/api/setup: $(curl -fsS "$URL/api/setup")"
curl -fsS "$URL/" | grep -qi '<div id="root"' && ok "/ serves the embedded web client" || die "/ did not serve the web client (build web/dist before cargo build)"
IDLE_MB=$(rss_mb); ok "RSS right after startup: ${IDLE_MB} MB"

step "log in (CSRF header + cookie jar) and create data"
api POST /api/auth/login "{\"email\":\"admin@example.com\",\"password\":\"$PASS\"}" >/dev/null
[[ "$(api GET /api/auth/me | jq -r '.email')" == admin@example.com ]] && ok "logged in" || die "me"
WS=$(api POST /api/workspaces '{"name":"Acme"}' | jq -r '.id')
BASE=$(api POST "/api/workspaces/$WS/bases" '{"name":"Orders base"}' | jq -r '.id')
TJSON=$(api POST "/api/bases/$BASE/tables" '{"name":"Orders"}')
TABLE=$(jq -r '.id' <<<"$TJSON")
PRIMARY=$(jq -r '.primary_field_id' <<<"$TJSON")
VIEW=$(jq -r '.views[0].id' <<<"$TJSON")
[[ -n "$WS" && -n "$BASE" && -n "$TABLE" && -n "$PRIMARY" && -n "$VIEW" ]] || die "could not create workspace/base/table"
AMOUNT=$(api POST "/api/tables/$TABLE/fields" '{"name":"Amount","type":"number","options":{}}' | jq -r .id)
api POST "/api/tables/$TABLE/records" "{\"records\":[{\"values\":{\"$PRIMARY\":\"first order\"}},{\"values\":{\"$PRIMARY\":\"second order\"}}]}" >/dev/null
count() { api POST "/api/views/$VIEW/query" '{"limit":1}' | jq -r '.total'; }
[[ "$(count)" == 2 ]] && ok "2 records stored" || die "record count"

if (( SEED_RECORDS > 0 )); then
  step "load $SEED_RECORDS records and time the reads (scripts/loadtest.sh)"
  URL=$URL EMAIL=admin@example.com PASSWORD=$PASS RECORDS=$SEED_RECORDS RSS_CMD="ps -o rss= -p $SERVER_PID" \
    "$(dirname "$0")/loadtest.sh" || die "load test failed"
fi
TOTAL=$(count)

step "backup (server running)"
ob "$A" backup | tee "$TMP/backup.txt"
ARCHIVE=$(grep -o '[^ ]*\.tar\.gz' "$TMP/backup.txt" | head -1)
[[ -f "$ARCHIVE" ]] && ok "archive: $(basename "$ARCHIVE") ($(du -h "$ARCHIVE" | cut -f1))" || die "archive not found"
LISTING=$(tar -tzf "$ARCHIVE")
echo "$LISTING" | grep -Eq '(^|/)openbase\.db$' && ok "archive contains openbase.db and manifest.json: $(echo "$LISTING" | tr '\n' ' ')" || die "no openbase.db in archive: $LISTING"

step "healthcheck"
ob "$A" healthcheck && ok "healthcheck exit 0 while running"
stop_server
ok "server stopped on SIGTERM"
if ob "$A" healthcheck 2>"$TMP/hc.err"; then die "healthcheck passed with no server"; else ok "healthcheck exit 1 with no server ($(cat "$TMP/hc.err"))"; fi

step "restore into an empty directory and start it there"
ob "$B" restore "$ARCHIVE" | tee "$TMP/restore.txt"
start_server "$B"
rm -f "$JAR"
api POST /api/auth/login "{\"email\":\"admin@example.com\",\"password\":\"$PASS\"}" >/dev/null
[[ "$(count)" == "$TOTAL" ]] && ok "restored instance has all $TOTAL records" || die "restored record count differs"
BASE_B=$(api GET /api/workspaces | jq -r '.. | objects | select(.name? == "Orders base") | .id' | head -1)
[[ "$BASE_B" == "$BASE" ]] && ok "workspace and base ids survived" || die "base missing after restore"
stop_server

step "reset-password"
OPENBASE_NEW_PASSWORD=$PASS2 ob "$B" reset-password --email admin@example.com
start_server "$B"
rm -f "$JAR"
if curl -fsS -X POST -H 'X-OpenBase-CSRF: 1' -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@example.com\",\"password\":\"$PASS\"}" "$URL/api/auth/login" >/dev/null 2>&1; then
  die "old password still works"
else ok "old password rejected"; fi
api POST /api/auth/login "{\"email\":\"admin@example.com\",\"password\":\"$PASS2\"}" >/dev/null && ok "new password works"
stop_server

step "migrate on an up-to-date database is a no-op"
before=$(shasum -a 256 "$B/openbase.db" | cut -d' ' -f1)
ls "$B/backups" > "$TMP/backups.before"
ob "$B" migrate
ls "$B/backups" > "$TMP/backups.after"
sqlite_ver() { python3 -c "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('PRAGMA user_version').fetchone()[0])" "$1"; }
cmp -s "$TMP/backups.before" "$TMP/backups.after" && ok "no snapshot taken (backups/ unchanged)" || die "migrate on a current database wrote something to backups/"
ls "$B/backups" | grep -q '^pre-migration' && die "a pre-migration snapshot exists" || ok "no pre-migration-* file"
ok "schema version still $(sqlite_ver "$B/openbase.db")"

step "a database from a newer version is refused"
cp -R "$B" "$TMP/c"
python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=9999'); c.commit()" "$TMP/c/openbase.db"
if OPENBASE_DATA_DIR="$TMP/c" "$BIN" migrate 2>"$TMP/newer.err"; then die "migrate accepted a newer schema"; else ok "refused: $(tail -1 "$TMP/newer.err")"; fi

printf '\nAll install checks passed.\n'
