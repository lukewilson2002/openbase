#!/usr/bin/env bash
# Load a running OpenBase with N records through the HTTP API and time the common reads.
#
#   URL=http://127.0.0.1:8080 EMAIL=me@example.com PASSWORD=... RECORDS=50000 scripts/loadtest.sh
#
# Creates a workspace "Load test" with one base and one table "Orders" shaped like the
# scale test (text, long text, two numbers, single and multiple select, date, checkbox
# and a formula that is recomputed on every write), inserts the records in batches of
# 1,000, then prints loopback latencies (curl's timer, so they include JSON encoding
# and the HTTP stack but no network): first page cold, cached page, a text sort deep
# in the table, the same after a single-record write, and 8 simultaneous cold searches.
#
# RSS_CMD="ps -o rss= -p 1234"   optional command that prints the server's resident set
#                                in KiB; when given, the memory after each phase is printed.
#
# Use a throwaway instance: this adds 50,000 records to whatever it is pointed at.
# Needs curl, jq and python3 (wall-clock timer).
set -euo pipefail

URL=${URL:?set URL, e.g. http://127.0.0.1:8080}
EMAIL=${EMAIL:?set EMAIL}
PASSWORD=${PASSWORD:?set PASSWORD}
RECORDS=${RECORDS:-50000}
RSS_CMD=${RSS_CMD:-}

JAR=$(mktemp)
TMP=$(mktemp -d)
trap 'rm -rf "$JAR" "$TMP"' EXIT

ok() { printf '    %s\n' "$*"; }
rss() { [[ -n "$RSS_CMD" ]] && printf '%.1f MB' "$(eval "$RSS_CMD" | awk '{print $1/1024}')" || printf 'n/a'; }
api() { # METHOD PATH [JSON]
  local method=$1 path=$2 body=${3:-}
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" -b "$JAR" -c "$JAR" -H 'X-OpenBase-CSRF: 1' -H 'Content-Type: application/json' -d "$body" "$URL$path"
  else
    curl -fsS -X "$method" -b "$JAR" -c "$JAR" -H 'X-OpenBase-CSRF: 1' "$URL$path"
  fi
}

api POST /api/auth/login "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
WS=$(api POST /api/workspaces '{"name":"Load test"}' | jq -r .id)
BASE=$(api POST "/api/workspaces/$WS/bases" '{"name":"Load test base"}' | jq -r .id)
TJSON=$(api POST "/api/bases/$BASE/tables" '{"name":"Orders"}')
TABLE=$(jq -r .id <<<"$TJSON"); PRIMARY=$(jq -r .primary_field_id <<<"$TJSON"); VIEW=$(jq -r '.views[0].id' <<<"$TJSON")
mkfield() { api POST "/api/tables/$TABLE/fields" "$1" | jq -r .id; }
AMOUNT=$(mkfield '{"name":"Amount","type":"number","options":{}}')
NOTES=$(mkfield '{"name":"Notes","type":"rich_text","options":{}}')
QTY=$(mkfield '{"name":"Qty","type":"number","options":{}}')
STATUS=$(mkfield '{"name":"Status","type":"single_select","options":{"choices":[{"name":"New"},{"name":"Packed"},{"name":"Shipped"},{"name":"Delivered"},{"name":"Returned"}]}}')
TAGS=$(mkfield '{"name":"Tags","type":"multiple_select","options":{"choices":[{"name":"rush"},{"name":"gift"},{"name":"fragile"}]}}')
DUE=$(mkfield '{"name":"Due","type":"date","options":{}}')
PAID=$(mkfield '{"name":"Paid","type":"checkbox","options":{}}')
mkfield '{"name":"Total","type":"formula","options":{"expression":"{Amount} * {Qty}"}}' >/dev/null

printf '==> inserting %s records (batches of 1000), server RSS before: %s\n' "$RECORDS" "$(rss)"
start=$(date +%s)
n=0
while ((n < RECORDS)); do
  take=$((RECORDS - n < 1000 ? RECORDS - n : 1000))
  jq -nc --arg p "$PRIMARY" --arg amount "$AMOUNT" --arg qty "$QTY" --arg status "$STATUS" --arg due "$DUE" \
    --arg notes "$NOTES" --arg tags "$TAGS" --arg paid "$PAID" --argjson from "$n" --argjson take "$take" '
    def two: tostring | if length < 2 then "0" + . else . end;
    {typecast: true, records: [range($from; $from+$take) | . as $i | {values: ({
      ($p): "Order \($i)", ($amount): (($i * 7919) % 100000 / 100), ($qty): (1 + ($i % 20)),
      ($status): ["New","Packed","Shipped","Delivered","Returned"][$i % 5],
      ($due): "2026-\(1 + ($i % 12) | two)-\(1 + ($i % 28) | two)"}
      + (if $i % 3 == 0 then {($notes): "note for order \($i)", ($tags): ["rush"]} else {} end)
      + (if $i % 4 == 0 then {($paid): true} else {} end))}]}' >"$TMP/batch.json"
  curl -fsS -X POST -b "$JAR" -H 'X-OpenBase-CSRF: 1' -H 'Content-Type: application/json' \
    --data-binary @"$TMP/batch.json" "$URL/api/tables/$TABLE/records" >/dev/null
  n=$((n + take))
done
ok "inserted in $(($(date +%s) - start)) s; server RSS after the load: $(rss)"

# milliseconds for one POST /api/views/{id}/query
qms() {
  curl -fsS -o /dev/null -w '%{time_total}' -X POST -b "$JAR" -H 'X-OpenBase-CSRF: 1' \
    -H 'Content-Type: application/json' -d "$1" "$URL/api/views/$VIEW/query" | awk '{printf "%.0f", $1*1000}'
}
printf '==> reads (nothing has been read since the load, so the first one is truly cold)\n'
ok "first page of 100 rows, cold:               $(qms '{"limit":100,"offset":0}') ms   (server RSS after: $(rss))"
ok "same page again, cached:                    $(qms '{"limit":100,"offset":0}') ms"
SORTED='{"limit":100,"offset":20000,"transient":{"sorts":[{"field_id":"'$PRIMARY'","direction":"desc"}]}}'
ok "page 200 of a text sort, cold:              $(qms "$SORTED") ms"
ok "same sorted page again, cached:             $(qms "$SORTED") ms"
RID=$(api POST "/api/views/$VIEW/query" '{"limit":1}' | jq -r '.records[0].id')
api PATCH "/api/tables/$TABLE/records" "{\"records\":[{\"id\":\"$RID\",\"values\":{\"$QTY\":99}}]}" >/dev/null
ok "sorted page right after a one-record write: $(qms "$SORTED") ms"
[[ "$(api POST "/api/views/$VIEW/query" '{"limit":1}' | jq -r .total)" == "$RECORDS" ]] || { echo "FAIL: record count" >&2; exit 1; }
ok "table holds $RECORDS records"

export URL JAR VIEW
par_start=$(python3 -c 'import time; print(time.time())')
seq 1 8 | xargs -P 8 -I{} sh -c 'curl -fsS -o /dev/null -X POST -b "$JAR" -H "X-OpenBase-CSRF: 1" -H "Content-Type: application/json" -d "{\"limit\":100,\"search\":\"order {}2{}\"}" "$URL/api/views/$VIEW/query"'
par_end=$(python3 -c 'import time; print(time.time())')
ok "8 simultaneous cold searches over all fields: $(awk -v a="$par_start" -v b="$par_end" 'BEGIN{printf "%.0f", (b-a)*1000}') ms wall   (server RSS after: $(rss))"
sleep 5
ok "server RSS 5 s later: $(rss)"
