#!/usr/bin/env node
/**
 * Enforce NOT NULL + DEFAULT now() on `updated_at` for every table the cloud sync worker
 * replicates. Why: cloudSyncWorker selects rows with `WHERE updated_at > $wm` and resolves
 * conflicts with `WHERE updated_at < EXCLUDED.updated_at`. A row whose `updated_at` is NULL
 * (legacy/backfilled/imported data, or a repo UPDATE that forgot to touch it) is INVISIBLE to
 * both — it never replicates and can never be corrected by sync. This backfills NULLs and adds
 * the constraint so it can't recur.
 *
 * Idempotent — safe to run repeatedly. Run against BOTH the local Postgres and the cloud
 * Postgres (set DATABASE_URL accordingly, or pass --cloud to use CLOUD_DATABASE_URL).
 *
 *   node scripts/enforce-updated-at-not-null.js            # uses DATABASE_URL (local)
 *   node scripts/enforce-updated-at-not-null.js --cloud    # uses CLOUD_DATABASE_URL
 */
const { Client } = require('pg');

// Union of UP_TABLES + DOWN_TABLES in cloudSyncWorker.js (+ order_counters/sync_watermark are
// operational, skipped). Keep in sync with that file if the sync table lists change.
const SYNC_TABLES = [
  'orders', 'payments', 'daily_stats', 'shifts', 'cash_registers', 'customers',
  'staff_users', 'floors', 'tables', 'menu_items', 'rest_bookings', 'offers', 'recipes', 'suppliers',
  'inventory', 'discount_settings', 'coupons', 'customer_segments', 'tax_groups',
];

async function main() {
  const useCloud = process.argv.includes('--cloud');
  const url = useCloud ? process.env.CLOUD_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) { console.error(`Missing ${useCloud ? 'CLOUD_DATABASE_URL' : 'DATABASE_URL'}`); process.exit(1); }

  const c = new Client({ connectionString: url });
  await c.connect();
  console.log(`Connected (${useCloud ? 'CLOUD' : 'LOCAL'}). Enforcing NOT NULL updated_at on ${SYNC_TABLES.length} sync tables…\n`);

  for (const t of SYNC_TABLES) {
    try {
      // Table + column present?
      const col = await c.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='updated_at'`, [t]);
      if (!col.rows.length) { console.log(`  – ${t}: no updated_at column — skipped`); continue; }

      // Does the table have created_at to fall back to?
      const hasCreated = (await c.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='created_at'`, [t])).rows.length > 0;
      const fallback = hasCreated ? 'COALESCE(updated_at, created_at, now())' : 'COALESCE(updated_at, now())';

      const upd = await c.query(`UPDATE "${t}" SET updated_at = ${fallback} WHERE updated_at IS NULL`);
      await c.query(`ALTER TABLE "${t}" ALTER COLUMN updated_at SET DEFAULT now()`);
      await c.query(`ALTER TABLE "${t}" ALTER COLUMN updated_at SET NOT NULL`);
      console.log(`  ✓ ${t}: backfilled ${upd.rowCount} NULL row(s), set DEFAULT now() + NOT NULL`);
    } catch (e) {
      console.error(`  ✗ ${t}: ${e.message}`);
    }
  }

  await c.end();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
