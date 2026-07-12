# PG Cutover Runbook — Firestore (Vercel) → Postgres (GCP Cloud Run)

Goal: move ALL production traffic from `dine-backend-lake.vercel.app` (Firestore)
to the Cloud Run service (Postgres). Once cut over, writes land only in PG —
**Firestore stops being updated and rollback loses data written after the flip.**
Follow the order exactly.

## Phase 0 — Prep (any time before cutover, no downtime)

1. **Run the schema migration on Cloud SQL** (idempotent):
   ```bash
   psql "$DATABASE_URL" -f scripts/add-cutover-columns.sql
   ```
2. **Deploy the new code to Cloud Run** (adapter fixes + merged main):
   ```bash
   gcloud builds submit --tag gcr.io/ascendant-idea-443107-f8/dine-backend --project ascendant-idea-443107-f8 --quiet
   gcloud run deploy dine-backend --image gcr.io/ascendant-idea-443107-f8/dine-backend --region asia-south1 --project ascendant-idea-443107-f8 --quiet
   ```
   Env vars: NEVER `--set-env-vars` (wipes everything). Use `--update-env-vars`
   or `--env-vars-file`.
3. **Set `CRON_SECRET`** on Cloud Run env (it is missing — the daily-report cron
   endpoint currently compares against `Bearer undefined`).
4. **Create the Cloud Scheduler job** replacing the Vercel cron (hourly):
   ```bash
   gcloud scheduler jobs create http dine-daily-reports \
     --project ascendant-idea-443107-f8 --location asia-south1 \
     --schedule "0 * * * *" \
     --uri "https://dine-backend-1087929121342.asia-south1.run.app/api/cron/send-daily-reports" \
     --headers "Authorization=Bearer <CRON_SECRET>"
   ```
5. **Smoke-test the Cloud Run URL** from a test frontend (point local
   dine-frontend `NEXT_PUBLIC_API_URL` at it): login, load floors/tables,
   place order, complete order, check dashboard analytics shows the order,
   print KOT, EOD/shift close.
6. **Load config sanity**: pool is 10 conns/instance × max 3 instances = 30;
   set Cloud Run `--concurrency=40` or raise `PG_POOL_MAX` (Cloud SQL default
   max_connections is usually 100 — leave headroom for psql/backfills).
7. **Security (strongly recommended before go-live)**: rotate the DB password
   (it is committed in PG_MIGRATION_PROGRESS.md), restrict Cloud SQL authorized
   networks (currently 0.0.0.0/0), and plan a move to the Cloud SQL connector.

## Phase 1 — Data sync rehearsal (day before)

Run every backfill with `--upsert` against live Firestore to shrink the final
delta window (order matters only for sanity, not FKs):

```bash
node scripts/backfill-restaurants-pg.js --upsert
node scripts/backfill-auth-menu-pg.js --upsert        # users/staff/menus — CRITICAL for login
node scripts/backfill-floors-tables-pg.js --upsert
node scripts/backfill-customers-pg.js --upsert
node scripts/backfill-offers-pg.js --upsert
node scripts/backfill-inventory-pg.js --upsert
node scripts/backfill-orders-pg.js --upsert --since 2026-07-01
node scripts/backfill-daily-stats-pg.js --upsert --since 2026-07-01
node scripts/backfill-payments-pg.js --upsert
node scripts/backfill-register-pg.js --upsert
node scripts/backfill-staff-hr-pg.js --upsert
node scripts/backfill-accounting-pg.js --upsert
node scripts/backfill-invoice-pg.js --upsert
node scripts/backfill-hotel-booking-pg.js --upsert
node scripts/backfill-enterprise-pg.js --upsert
node scripts/backfill-ai-automation-pg.js --upsert
node scripts/backfill-system-misc-pg.js --upsert
node scripts/backfill-counters-pg.js                  # atomic upsert built in
```

## Phase 2 — Cutover (pick lowest-traffic window, e.g. 3-5 AM IST)

1. **Freeze writes on Vercel** — either pause the Vercel deployment or flip the
   frontend to a maintenance banner. Window should be < 15 min.
2. **Final delta sync** — re-run Phase 1 (fast now; most rows unchanged).
   `--since` on orders/daily-stats keeps it quick.
   **`backfill-counters-pg.js` LAST** — order/invoice numbers must be exact or
   new orders will collide.
3. **Verify row counts** per critical table (orders today, app_users,
   staff_credentials, order_counters) against Firestore counts.
4. **Flip traffic**: `./switch-backend.sh gcp` (updates `NEXT_PUBLIC_API_URL`
   on Vercel + redeploys frontend). Mobile apps pick up the API URL per their
   config mechanism — verify dine-app + KOT printers reconnect.
5. **Watch logs 30 min**:
   ```bash
   gcloud run services logs read dine-backend --region asia-south1 --limit 200
   ```
   Grep for `[pgAdapter]` warnings — every "No PG mapping ... falling back to
   Firestore" and "Column ... missing" is a work item. `column X does not
   exist` errors mean a missed DDL — add via
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.

## Phase 3 — Rollback plan (decide threshold BEFORE flipping)

- Within the first minutes and PG-era data is small: `./switch-backend.sh vercel`
  flips traffic back to Firestore. **Orders placed on PG in the meantime exist
  only in PG** — export them (`psql \copy`) and re-enter manually, or accept loss.
- After hours of PG traffic: rolling back means real data loss. Fix forward
  instead — the Firestore fallback for unmapped collections plus per-issue
  `ALTER TABLE` keeps most incidents repairable live.

## Known transitional states (intentional, post-cutover)

- Unmapped collections (`sub_admins`, `desktop_auth_sessions`, `adminTasks`,
  `fcmTokens`/`staffFcmTokens`, `dineai_conversations`, `subRestaurants`,
  `customerOfferUsage`, `print_installer_releases`, SADAD subcollection) still
  live on Firestore via automatic fallback. They keep working — Firebase creds
  must stay configured. Migrate them later to finish killing Firestore costs.
- RTDB (real-time order/table events), FCM, Pusher, Firebase Auth, GCS remain
  on Firebase by design.
