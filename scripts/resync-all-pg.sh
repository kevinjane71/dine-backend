#!/usr/bin/env bash
#
# resync-all-pg.sh — Re-sync ALL collections Firestore → PostgreSQL in UPSERT mode.
#
# Runs every backfill in --upsert mode (updates rows that changed in Firestore
# since the last sync — not just inserts new ones). Safe to run repeatedly.
# Order: parents (restaurants/menu/customers) first, then dependents.
#
# Usage:
#   cd dine-backend
#   ./scripts/resync-all-pg.sh                 # loads .env.local automatically
#   DATABASE_URL="postgresql://..." ./scripts/resync-all-pg.sh   # or pass it inline
#
# Run this RIGHT BEFORE the Cloud Run cutover so PG is current at go-live.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# Load .env.local if present (DATABASE_URL + Firebase creds) unless already set.
if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  echo "Loading .env.local ..."
  set -a; . ./.env.local; set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set (needed to reach Cloud SQL). Aborting."
  exit 1
fi

# Backfill order — parents before dependents (FK safety).
SCRIPTS=(
  backfill-restaurants-pg.js
  backfill-auth-menu-pg.js
  backfill-staff-hr-pg.js
  backfill-customers-pg.js
  backfill-offers-pg.js
  backfill-inventory-pg.js
  backfill-floors-tables-pg.js
  backfill-daily-stats-pg.js
  backfill-orders-pg.js
  backfill-payments-pg.js
  backfill-register-pg.js
  backfill-accounting-pg.js
  backfill-invoice-pg.js
  backfill-hotel-booking-pg.js
  backfill-enterprise-pg.js
  backfill-ai-automation-pg.js
  backfill-counters-pg.js
  backfill-system-misc-pg.js
)

echo "==================================================================="
echo " Firestore → PostgreSQL RE-SYNC (upsert)   $(date)"
echo " DB: ${DATABASE_URL%%@*}@***"
echo "==================================================================="
FAILED=()
for s in "${SCRIPTS[@]}"; do
  echo ""
  echo ">>> $s --upsert"
  if node "scripts/$s" --upsert; then
    echo "    ✓ $s done"
  else
    echo "    ✗ $s FAILED (continuing — investigate after)"
    FAILED+=("$s")
  fi
done

echo ""
echo "==================================================================="
if [ ${#FAILED[@]} -eq 0 ]; then
  echo " ✓ RE-SYNC COMPLETE — all ${#SCRIPTS[@]} collections upserted."
else
  echo " ⚠ RE-SYNC finished with ${#FAILED[@]} failure(s):"
  for f in "${FAILED[@]}"; do echo "    - $f"; done
  echo " Re-run individually: node scripts/<name> --upsert"
fi
echo "==================================================================="
