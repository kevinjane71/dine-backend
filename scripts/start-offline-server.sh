#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  DineOpen — ONE-CLICK offline server for macOS / Linux.
#  Runs a self-contained PostgreSQL + the real dine-backend. Other terminals point
#  at  http://<this-machine-ip>:3003.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

command -v node >/dev/null 2>&1 || { echo "Node.js is required (https://nodejs.org)"; exit 1; }

[ -d node_modules ] || { echo "Installing dependencies (one-time)..."; npm ci --omit=dev; }

if ! node -e "require('embedded-postgres')" >/dev/null 2>&1; then
  echo "Installing embedded PostgreSQL (one-time download)..."
  npm i embedded-postgres
fi

[ -f .env.local ] || echo "NOTE: no .env.local — copy .env.offline.example → .env.local and set JWT_SECRET."

echo "Starting DineOpen local server..."
exec node scripts/start-embedded-server.js
