#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Verify the local Redis cache is working + measure how much it helps.
# Run ON the VM (dine-be-vm). Read-only — safe on prod.
#
#   bash scripts/vm-cache-check.sh
#   bash scripts/vm-cache-check.sh "http://localhost:3003/api/restaurants/<RID>" "<JWT>"
#     ^ optional: times a real cached endpoint cold vs warm to show the speedup.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

echo "== Redis (local, loopback) =="
echo "  ping     : $(redis-cli ping 2>/dev/null)"
echo "  dbsize   : $(redis-cli dbsize 2>/dev/null)"
H=$(redis-cli info stats 2>/dev/null | grep -oE 'keyspace_hits:[0-9]+'   | cut -d: -f2)
M=$(redis-cli info stats 2>/dev/null | grep -oE 'keyspace_misses:[0-9]+' | cut -d: -f2)
EV=$(redis-cli info stats 2>/dev/null | grep -oE 'evicted_keys:[0-9]+'   | cut -d: -f2)
echo "  hits     : ${H:-0}   misses: ${M:-0}   evicted: ${EV:-0}"
if [ "$(( ${H:-0} + ${M:-0} ))" -gt 0 ]; then
  awk "BEGIN{printf \"  hit ratio: %.1f%%\n\", ${H:-0}*100/(${H:-0}+${M:-0})}"
fi
echo "  memory   : $(redis-cli info memory 2>/dev/null | grep -oE 'used_memory_human:[^[:space:]]+' | cut -d: -f2)"
echo "  maxmemory: $(redis-cli config get maxmemory | tail -1)  policy: $(redis-cli config get maxmemory-policy | tail -1)"
echo "  sample keys:"
redis-cli --scan --pattern 'pg:*' 2>/dev/null | head -5 | sed 's/^/    /'
[ -z "$(redis-cli --scan --pattern 'pg:*' 2>/dev/null | head -1)" ] && echo "    (none yet — needs some API traffic)"

echo "== Backend cache path =="
if sudo journalctl -u dine-backend --since '10 min ago' 2>/dev/null | grep -q 'Initialized from REDIS_URL'; then
  echo "  ✅ local redis (ioredis via loopback REDIS_URL)"
elif sudo journalctl -u dine-backend --since '10 min ago' 2>/dev/null | grep -q 'Initialized from KV_REST_API_URL'; then
  echo "  ⚠️  still on Upstash REST — REDIS_URL is not loopback"
else
  echo "  (no cache-init log in last 10 min — hit an endpoint, then re-run)"
fi

if [ "$#" -ge 2 ]; then
  URL="$1"; TOKEN="$2"
  echo "== API timing: $URL =="
  # First call may miss (cold), subsequent should hit the warm cache.
  for label in cold warm1 warm2; do
    t=$(curl -s -o /dev/null -w '%{time_total}' -H "Authorization: Bearer $TOKEN" "$URL" 2>/dev/null)
    echo "  $label : ${t}s"
  done
  echo "  (warm should be markedly faster than cold if caching is effective)"
fi
