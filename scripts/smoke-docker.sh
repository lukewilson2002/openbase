#!/usr/bin/env bash
# Smoke test for the container image. Nothing is pushed anywhere.
#
#   docker build -f deploy/Dockerfile -t opengrid:local .
#   scripts/smoke-docker.sh [image]                    (default: opengrid:local)
#
# Starts a throwaway container with a throwaway named volume, publishes it on a
# loopback port, and checks, in order: the HEALTHCHECK turns "healthy", /api/health
# and /api/setup answer, first-run signup works (the first account becomes admin),
# a workspace + base + table + records can be created, the data is still there after
# `docker restart` and after removing and re-creating the container on the same
# volume, `opengrid backup` inside the container writes an archive, and the process
# runs as the unprivileged user. Prints the image size and idle memory
# (`docker stats --no-stream`). Removes the container and volume at the end.
#
# PORT=18090 picks the host port (default: a free one). Needs docker, curl, jq and python3.
set -euo pipefail

IMAGE=${1:-opengrid:local}
PORT=${PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}
NAME=opengrid-smoke-$$
VOL=opengrid-smoke-data-$$
URL=http://127.0.0.1:$PORT
PASS='correct-horse-battery-staple'
JAR=$(mktemp)

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -f "$JAR"
}
trap cleanup EXIT

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
die() { printf '    FAIL: %s\n' "$*" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2 || true; exit 1; }

run_container() {
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" -v "$VOL:/data" \
    -e OPENGRID_PUBLIC_URL="$URL" "$IMAGE" >/dev/null
}

wait_healthy() { # up to 90 s
  for _ in $(seq 1 90); do
    [[ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" == healthy ]] && return 0
    sleep 1
  done
  die "container did not become healthy within 90 s (status: $(docker inspect -f '{{.State.Health.Status}}' "$NAME"))"
}

api() { # METHOD PATH [JSON]
  local method=$1 path=$2 body=${3:-}
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" -b "$JAR" -c "$JAR" -H 'X-OpenGrid-CSRF: 1' -H 'Content-Type: application/json' -d "$body" "$URL$path"
  else
    curl -fsS -X "$method" -b "$JAR" -c "$JAR" -H 'X-OpenGrid-CSRF: 1' "$URL$path"
  fi
}

step "image"
docker image inspect "$IMAGE" --format '    platform {{.Os}}/{{.Architecture}}' || die "image $IMAGE not found"
docker images "$IMAGE"   # DISK USAGE = unpacked size, CONTENT SIZE = compressed

step "start with a named volume"
run_container
START=$(date +%s)
wait_healthy
ok "HEALTHCHECK is healthy after $(( $(date +%s) - START )) s"
ok "/api/health: $(curl -fsS "$URL/api/health")"
ok "/api/setup: $(curl -fsS "$URL/api/setup")"
[[ "$(docker exec "$NAME" id -u)" == 10001 ]] && ok "runs as uid 10001 (not root)" || die "runs as root"

step "first-run signup (becomes admin) and data"
api POST /api/auth/signup "{\"email\":\"owner@example.com\",\"name\":\"Owner\",\"password\":\"$PASS\"}" >/dev/null
[[ "$(api GET /api/auth/me | jq -r .is_admin)" == true ]] && ok "first account is admin" || die "first account not admin"
[[ "$(curl -fsS "$URL/api/setup" | jq -r .needs_setup)" == false ]] && ok "setup is closed afterwards"
WS=$(api POST /api/workspaces '{"name":"Acme"}' | jq -r .id)
BASE=$(api POST "/api/workspaces/$WS/bases" '{"name":"Orders base"}' | jq -r .id)
TJSON=$(api POST "/api/bases/$BASE/tables" '{"name":"Orders"}')
TABLE=$(jq -r .id <<<"$TJSON"); PRIMARY=$(jq -r .primary_field_id <<<"$TJSON"); VIEW=$(jq -r '.views[0].id' <<<"$TJSON")
api POST "/api/tables/$TABLE/records" "{\"records\":[{\"values\":{\"$PRIMARY\":\"first\"}},{\"values\":{\"$PRIMARY\":\"second\"}},{\"values\":{\"$PRIMARY\":\"third\"}}]}" >/dev/null
count() { api POST "/api/views/$VIEW/query" '{"limit":1}' | jq -r .total; }
[[ "$(count)" == 3 ]] && ok "3 records stored" || die "record count"

step "idle memory and size on disk"
sleep 5
docker stats --no-stream --format '    docker stats: mem {{.MemUsage}} (cgroup usage minus page cache), cpu {{.CPUPerc}}, pids {{.PIDs}}' "$NAME"
echo "    /proc/1/status (the server process): $(docker exec "$NAME" grep -E '^(VmRSS|RssAnon|RssFile)' /proc/1/status | tr -s ' \t\n' ' ')"

step "docker restart keeps the data"
docker restart "$NAME" >/dev/null
wait_healthy
rm -f "$JAR"
api POST /api/auth/login "{\"email\":\"owner@example.com\",\"password\":\"$PASS\"}" >/dev/null
[[ "$(count)" == 3 ]] && ok "3 records after docker restart" || die "data lost after restart"

step "removing the container and starting a new one on the same volume keeps the data"
docker rm -f "$NAME" >/dev/null
run_container
wait_healthy
rm -f "$JAR"
api POST /api/auth/login "{\"email\":\"owner@example.com\",\"password\":\"$PASS\"}" >/dev/null
[[ "$(count)" == 3 ]] && ok "3 records in a fresh container on the same volume" || die "data lost"

step "opengrid backup inside the container"
OUT=$(docker exec "$NAME" opengrid backup)
echo "    $OUT"
FILE=${OUT##* }
docker exec "$NAME" ls -l "$FILE" && ok "archive exists in the volume" || die "archive missing"
docker exec "$NAME" tar -tzf "$FILE" | tr '\n' ' ' | sed 's/^/    contents: /'; echo
[[ "$(api GET /api/admin/backups | jq length)" -ge 1 ]] && ok "admin API lists $(api GET /api/admin/backups | jq length) backup(s)"

printf '\nAll container checks passed.\n'
