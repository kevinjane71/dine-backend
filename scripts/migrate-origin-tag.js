// One-time, idempotent origin tagging for the PG (pg-full-migration) DB.
//
// Everything in PG today came from the Firestore sync, so we tag it all
// origin='firestore'. Future inserts DEFAULT to 'native' — because on the PG
// backend the only app-path writer creates new (native) users; the sync writes via
// direct SQL and stamps origin='firestore' EXPLICITLY (backfill-restaurants /
// backfill-auth-menu). The sync also guards with `WHERE origin IS DISTINCT FROM
// 'native'`, so a native row can never be overwritten or deleted by the sync.
//
// Net: app-created rows → native automatically (default); sync-created rows →
// firestore (explicit). No signup-code change needed.
//
// Safe + reversible: only ADDs a column + a label (UPDATE origin IS NULL). Undo:
// `ALTER TABLE <t> DROP COLUMN origin;`. Run on the VM (env.json bridged in) or with
// DATABASE_URL exported.
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') }); } catch (_) {}
const { Pool } = require('pg');

const TABLES = ['restaurants', 'app_users'];

(async () => {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  for (const t of TABLES) {
    const exists = (await pool.query('SELECT to_regclass($1) AS r', [t])).rows[0].r;
    if (!exists) { console.log(`\n${t}: table not found — skipped`); continue; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS origin text`);
      const untagged = (await client.query(`SELECT count(*)::int n FROM ${t} WHERE origin IS NULL`)).rows[0].n;
      const upd = await client.query(`UPDATE ${t} SET origin='firestore' WHERE origin IS NULL`);
      await client.query(`ALTER TABLE ${t} ALTER COLUMN origin SET DEFAULT 'native'`);
      await client.query('COMMIT');
      const by = (await pool.query(`SELECT origin, count(*)::int n FROM ${t} GROUP BY origin ORDER BY n DESC`)).rows;
      console.log(`\n${t}: tagged ${upd.rowCount} previously-untagged row(s) as 'firestore' (was ${untagged} NULL); default now 'native'`);
      for (const r of by) console.log(`  origin=${r.origin ?? 'NULL'}: ${r.n}`);
    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`\n${t}: FAILED (rolled back): ${e.message}`);
    } finally {
      client.release();
    }
  }
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
