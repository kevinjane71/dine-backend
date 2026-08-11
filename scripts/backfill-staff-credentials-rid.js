#!/usr/bin/env node
/**
 * Add `restaurant_id` to staff_credentials and backfill it from staff_users (join on staff_id).
 * Why: cloudSyncWorker DOWN sync is scoped by restaurant_id — without it, staff_credentials could
 * not flow DOWN (a device would refuse it, or pulling it unscoped would leak every tenant's PINs).
 * With it, a staff created on the web has their login/PIN reach the shop so they can log in offline.
 *
 * Idempotent + additive. Run on BOTH the local Postgres and Cloud SQL:
 *   node scripts/backfill-staff-credentials-rid.js            # DATABASE_URL (local)
 *   node scripts/backfill-staff-credentials-rid.js --cloud    # CLOUD_DATABASE_URL
 */
const { Client } = require('pg');

async function main() {
  const useCloud = process.argv.includes('--cloud');
  const url = useCloud ? process.env.CLOUD_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) { console.error(`Missing ${useCloud ? 'CLOUD_DATABASE_URL' : 'DATABASE_URL'}`); process.exit(1); }
  const wantsSsl = /sslmode=(require|no-verify|prefer)|[?&]ssl=true/.test(url);
  const c = new Client({ connectionString: url, ssl: wantsSsl ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  console.log(`Connected (${useCloud ? 'CLOUD' : 'LOCAL'}).`);

  const exists = (await c.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='staff_credentials'`)).rows.length;
  if (!exists) { console.log('staff_credentials table absent — nothing to do.'); await c.end(); return; }

  await c.query(`ALTER TABLE staff_credentials ADD COLUMN IF NOT EXISTS restaurant_id text`);
  // Backfill from staff_users by staff_id (the credential's owner). Only fills nulls.
  const r = await c.query(`
    UPDATE staff_credentials sc
       SET restaurant_id = su.restaurant_id
      FROM staff_users su
     WHERE sc.staff_id = su.id
       AND sc.restaurant_id IS NULL
       AND su.restaurant_id IS NOT NULL`);
  const stillNull = (await c.query(`SELECT count(*)::int n FROM staff_credentials WHERE restaurant_id IS NULL`)).rows[0].n;
  await c.query(`CREATE INDEX IF NOT EXISTS idx_staff_credentials_rid ON staff_credentials (restaurant_id)`);
  console.log(`  ✓ staff_credentials.restaurant_id: backfilled ${r.rowCount} row(s); ${stillNull} still NULL (orphan creds / no matching staff_user).`);
  await c.end();
  console.log('Done.');
}
main().catch((e) => { console.error(e); process.exit(1); });
