#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Provision a self-hosted Redis cache ON the pg-full-migration VM (dine-be-vm).
#
# WHY: the pg backend runs on a GCP VM in asia-south1 (Mumbai). Running Redis on
# the SAME box (loopback) makes the cache free and sub-millisecond — no Upstash /
# US-East round-trip. kvCache.js already switches to a local Redis via ioredis
# whenever REDIS_URL is a loopback address, so this is env + ops only (no code).
#
# Firestore/main (Vercel) is UNAFFECTED — it keeps its Upstash KV_REST_API env.
#
# Idempotent. Run ON the VM, or from a laptop:
#   gcloud compute ssh dine-be-vm --zone asia-south1-a \
#     --project ascendant-idea-443107-f8 --command "bash -s" < scripts/vm-local-redis-setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV_JSON="${ENV_JSON:-/opt/dine-backend/env.json}"
REDIS_URL_LOCAL="redis://127.0.0.1:6379"
MAXMEM="${MAXMEM:-384mb}"

echo "[1/4] install redis-server (if missing)"
if ! command -v redis-server >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server
else
  echo "     already installed: $(redis-server --version | awk '{print $1,$3}')"
fi

echo "[2/4] configure as a pure cache — loopback only, ${MAXMEM}, LRU, no persistence"
sudo systemctl enable redis-server >/dev/null 2>&1 || true
sudo systemctl restart redis-server
sleep 1
redis-cli CONFIG SET maxmemory "$MAXMEM"          >/dev/null
redis-cli CONFIG SET maxmemory-policy allkeys-lru >/dev/null
redis-cli CONFIG SET save ""                      >/dev/null   # no RDB snapshots
redis-cli CONFIG SET appendonly no                >/dev/null   # no AOF — cache is rebuildable
sudo redis-cli CONFIG REWRITE >/dev/null 2>&1 || redis-cli CONFIG REWRITE >/dev/null 2>&1 || true
[ "$(redis-cli ping)" = "PONG" ] || { echo "!! redis not responding"; exit 1; }
# Safety: must bind loopback only (the VM has a public IP — never expose 6379).
BIND="$(redis-cli CONFIG GET bind | tail -1)"
echo "     bind=$BIND  maxmemory=$(redis-cli CONFIG GET maxmemory | tail -1)  policy=$(redis-cli CONFIG GET maxmemory-policy | tail -1)"
case "$BIND" in *0.0.0.0*|"") echo "!! WARNING: redis is not loopback-only — fix bind before continuing"; exit 1;; esac

echo "[3/4] point backend REDIS_URL at loopback (env.json backed up first)"
sudo cp "$ENV_JSON" "$ENV_JSON.bak.$(date +%Y%m%d-%H%M%S)"
sudo python3 - "$ENV_JSON" "$REDIS_URL_LOCAL" <<'PY'
import json, sys
p, url = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d["REDIS_URL"] = url          # loopback -> kvCache uses local ioredis
# KV_REST_API_* left as a dormant fallback (loopback wins in kvCache.getRedis()).
json.dump(d, open(p, "w"), indent=2)
print("     REDIS_URL ->", url)
PY

echo "[4/4] restart backend + verify local-redis cache path"
sudo systemctl restart dine-backend
sleep 5
echo "     health: $(curl -s -o /dev/null -w '%{http_code}' localhost:3003/api/health)"
# The cache client is lazy; the init line prints on first cache use.
sleep 8
if sudo journalctl -u dine-backend --since '30 seconds ago' 2>/dev/null | grep -q 'KV Cache: Initialized from REDIS_URL'; then
  echo "     ✅ using LOCAL redis (ioredis via loopback REDIS_URL)"
else
  echo "     (init line not seen yet — run scripts/vm-cache-check.sh after some traffic)"
fi
echo "done."
