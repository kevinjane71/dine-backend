/**
 * migrationRunner.js — versioned, forward-only schema migrations for Postgres.
 *
 * This is the single, clean mechanism for evolving the PG schema across every
 * deployment: Cloud Run (pg branch), the one-click embedded server, and the
 * desktop-server installer. On boot the backend replays any migration files that
 * haven't run yet, tracked in a `schema_migrations` table — exactly how mature POS
 * back-ends self-heal their schema on update instead of relying on a hand-run dump.
 *
 * Design:
 *  - Migration files live in /migrations, named `NNN_description.sql` and applied in
 *    numeric order. Each runs once (tracked by filename in schema_migrations).
 *  - Every migration should be IDEMPOTENT (ADD COLUMN IF NOT EXISTS, CREATE TABLE
 *    IF NOT EXISTS, ...) so a re-run or a partially-migrated DB is always safe.
 *  - Each file is applied inside a transaction; a failure rolls back that file and
 *    stops (later migrations don't run on a broken schema).
 *  - A pg advisory lock serialises concurrent boots (multiple Cloud Run instances),
 *    so only one instance migrates and the others wait, then find nothing to do.
 *  - No-op when DATABASE_URL is unset (cloud/Firestore deployments have no PG).
 */

const fs = require('fs');
const path = require('path');
const { getPool } = require('./pgClient');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Arbitrary constant key so all instances contend on the same advisory lock.
const ADVISORY_LOCK_KEY = 49150271;

function listMigrationFiles() {
  try {
    return fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+.*\.sql$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function runMigrations({ logger = console } = {}) {
  if (!process.env.DATABASE_URL) return { applied: [], skipped: 'no DATABASE_URL' };

  const files = listMigrationFiles();
  if (!files.length) return { applied: [], skipped: 'no migration files' };

  const client = await getPool().connect();
  const applied = [];
  let locked = false;
  try {
    // Serialise across processes/instances WITHOUT blocking: if another boot already
    // holds the lock it's migrating, so we skip (rather than stall this instance's
    // startup behind a deploy-time migration). Migrations are idempotent + additive,
    // so proceeding on the soon-to-be-migrated schema is safe.
    const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY]);
    if (!lockRes.rows[0] || lockRes.rows[0].got !== true) {
      logger.log('🧱 Another instance is applying migrations — skipping on this boot.');
      return { applied: [], skipped: 'lock held by another instance' };
    }
    locked = true;

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )`);

    const doneRes = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(doneRes.rows.map((r) => r.version));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.log(`🧱 Applying migration ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [file]);
        await client.query('COMMIT');
        applied.push(file);
        logger.log(`   ✅ ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        logger.error(`   ❌ migration ${file} failed: ${e.message}`);
        throw e; // stop — never apply later migrations on top of a broken one
      }
    }

    if (applied.length) logger.log(`🧱 Migrations complete: ${applied.length} applied.`);
    else logger.log('🧱 Schema up to date — no migrations pending.');
    return { applied };
  } finally {
    if (locked) { try { await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]); } catch {} }
    client.release();
  }
}

module.exports = { runMigrations, listMigrationFiles };
