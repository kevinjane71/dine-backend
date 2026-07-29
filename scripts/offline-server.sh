#!/usr/bin/env bash
#
# offline-server.sh — start dine-backend as the restaurant's LOCAL/OFFLINE server.
#
# Adds preflight checks over a plain `node index.js`:
#   - loads .env.local
#   - verifies DATABASE_URL is set and the Postgres it points at is reachable
#   - warns if Redis (KV_REST_API_*) is configured (adds cloud timeouts offline)
#   - prints the LAN IP the terminals should connect to
#
# Usage:  ./scripts/offline-server.sh
#
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

if [ -f .env.local ]; then
  set -a; . ./.env.local; set +a
else
  echo "⚠️  No .env.local found. Copy .env.offline.example → .env.local first."; exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL is not set — the offline server needs a local Postgres."; exit 1
fi

case "$DATABASE_URL" in
  *localhost*|*127.0.0.1*) : ;;
  *) echo "⚠️  DATABASE_URL does not look local ($DATABASE_URL). Offline mode expects a Postgres on this machine." ;;
esac

# Reachability check (best-effort; needs psql on PATH).
if command -v psql >/dev/null 2>&1; then
  if ! psql "$DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then
    echo "❌ Cannot connect to Postgres at DATABASE_URL. Is it running? Is the schema loaded?"; exit 1
  fi
  echo "✅ Postgres reachable."
fi

if [ -n "${KV_REST_API_URL:-}" ]; then
  echo "⚠️  KV_REST_API_URL is set — Redis is cloud; unset it offline to avoid 2s timeouts."
fi

# Show the LAN IP(s) the terminals should point at.
PORT="${PORT:-3003}"
echo "── Terminals should connect to (this machine on the LAN): ──"
if command -v ipconfig >/dev/null 2>&1; then
  ipconfig getifaddr en0 2>/dev/null | sed "s#^#   http://#; s#\$#:${PORT}#"
  ipconfig getifaddr en1 2>/dev/null | sed "s#^#   http://#; s#\$#:${PORT}#"
elif command -v hostname >/dev/null 2>&1; then
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]' | sed "s#^#   http://#; s#\$#:${PORT}#"
fi
echo "────────────────────────────────────────────────────────────"

exec node index.js
