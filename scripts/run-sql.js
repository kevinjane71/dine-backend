/**
 * run-sql.js — execute a .sql file against DATABASE_URL (Cloud SQL / PG VM).
 *
 * Usage:  node scripts/run-sql.js scripts/create-corporate-fcm-tables.sql
 *
 * Runs the whole file in one round-trip (node-postgres allows multiple statements
 * in a non-parameterized query). Prints success or the failing statement's error.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set. Aborting.');
  process.exit(1);
}

const fs = require('fs');
const { query } = require('../repos/pgClient');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/run-sql.js <file.sql>'); process.exit(1); }

(async () => {
  const sql = fs.readFileSync(file, 'utf8');
  console.log(`[run-sql] executing ${file} (${sql.length} bytes) against ${process.env.DATABASE_URL.replace(/:[^:@]*@/, ':***@')}`);
  try {
    await query(sql, []);
    console.log('[run-sql] ✓ done');
    process.exit(0);
  } catch (err) {
    console.error('[run-sql] ✗ failed:', err.message);
    process.exit(1);
  }
})();
