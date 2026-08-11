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
// The replicator SKIPS any table lacking `updated_at`, so a table that must sync but has no such
// column is a silent data-loss bug — this script ADDS the column (see below) then constrains it.
const SYNC_TABLES = [
  // Orders / billing / payments
  'orders', 'pos_payments', 'pos_invoices', 'daily_stats', 'shifts', 'cash_registers', 'discount_approvals',
  // Customers / CRM / feedback
  'customers', 'customer_groups', 'customer_offer_usage', 'feedback_responses', 'feedback_forms', 'waitlist',
  // Layout / bookings
  'floors', 'tables', 'rest_bookings',
  // Inventory / supply chain / bar (records + ledger + stock movements)
  'inventory', 'inventory_transactions', 'inventory_categories', 'stock_audits', 'stock_oversell_log',
  'waste_entries', 'stock_batches', 'stock_transfers', 'goods_receipt_notes', 'supplier_invoices',
  'supplier_returns', 'supplier_performance', 'purchase_orders', 'purchase_requisitions', 'production_entries',
  'bar_bottles', 'bar_reconciliation', 'suppliers', 'recipes',
  // Staff / HR / payroll / shifts
  'staff_users', 'staff_credentials', 'staff_shifts', 'staff_availability', 'attendance', 'leave_requests',
  'leave_balances', 'leave_config', 'payroll_config', 'payroll_runs', 'pay_slips', 'restaurant_shift_settings',
  // Accounting
  'expenses', 'journal_entries',
  // Config
  'restaurants', 'offers', 'coupons',
];

async function main() {
  const useCloud = process.argv.includes('--cloud');
  const url = useCloud ? process.env.CLOUD_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) { console.error(`Missing ${useCloud ? 'CLOUD_DATABASE_URL' : 'DATABASE_URL'}`); process.exit(1); }

  // Cloud SQL uses TLS with a self-signed chain (sslmode=no-verify in the URL). node-postgres does
  // not always honour the URL's ssl params, so set it explicitly when the URL asks for TLS.
  const wantsSsl = /sslmode=(require|no-verify|prefer)|[?&]ssl=true/.test(url);
  const c = new Client({ connectionString: url, ssl: wantsSsl ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  console.log(`Connected (${useCloud ? 'CLOUD' : 'LOCAL'}). Enforcing NOT NULL updated_at on ${SYNC_TABLES.length} sync tables…\n`);

  for (const t of SYNC_TABLES) {
    try {
      // Table present at all? (some entries are cloud-only / not provisioned on every device)
      const tbl = await c.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema='public' AND table_name=$1 AND table_type='BASE TABLE'`, [t]);
      if (!tbl.rows.length) { console.log(`  – ${t}: table absent — skipped`); continue; }

      // updated_at column present? If NOT, ADD it — a syncable table must have it or the
      // replicator silently skips the whole table (money/ledger records never reach the cloud).
      let col = await c.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='updated_at'`, [t]);
      let added = false;
      if (!col.rows.length) {
        await c.query(`ALTER TABLE "${t}" ADD COLUMN updated_at timestamptz`);
        added = true;
      }

      // Does the table have created_at to fall back to?
      const hasCreated = (await c.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name=$1 AND column_name='created_at'`, [t])).rows.length > 0;
      const fallback = hasCreated ? 'COALESCE(updated_at, created_at, now())' : 'COALESCE(updated_at, now())';

      const upd = await c.query(`UPDATE "${t}" SET updated_at = ${fallback} WHERE updated_at IS NULL`);
      await c.query(`ALTER TABLE "${t}" ALTER COLUMN updated_at SET DEFAULT now()`);
      await c.query(`ALTER TABLE "${t}" ALTER COLUMN updated_at SET NOT NULL`);
      console.log(`  ✓ ${t}: ${added ? 'ADDED column, ' : ''}backfilled ${upd.rowCount} NULL row(s), set DEFAULT now() + NOT NULL`);
    } catch (e) {
      console.error(`  ✗ ${t}: ${e.message}`);
    }
  }

  await c.end();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
