/**
 * backfill-restaurants-pg.js — Migrate restaurants from Firestore → PostgreSQL.
 *
 * Usage:
 *   cd dine-backend
 *   DATABASE_URL="postgresql://..." node scripts/backfill-restaurants-pg.js
 *
 * Options:
 *   --dry-run           Count docs without inserting
 *   --restaurant=ID     Migrate only one restaurant
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { getFirestoreDb } = require('../firebase');
const db = getFirestoreDb(); // raw Firestore ('dine'), bypasses pgAdapter
const { getPool } = require('../repos/pgClient');
const { toPgRow, JSONB_COLUMNS } = require('../repos/restaurantsFieldMapper');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESTAURANT_FILTER = args.find(a => a.startsWith('--restaurant='))?.split('=')[1] || null;
const UPSERT = args.includes('--upsert');

const stats = {
  total: 0,
  inserted: 0,
  skipped: 0,
  errors: 0,
  errorDetails: [],
  startTime: Date.now(),
};

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Firestore → PostgreSQL Restaurants Backfill         ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'LIVE MIGRATION'}`);
  console.log(`Restaurant:     ${RESTAURANT_FILTER || 'ALL'}`);
  console.log(`Database URL:   ${process.env.DATABASE_URL ? '✓ set' : '✗ MISSING'}`);
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is required.');
    process.exit(1);
  }

  const pool = getPool();
  try {
    const pgTest = await pool.query('SELECT NOW() as time');
    console.log(`PG connected:   ${pgTest.rows[0].time}`);
    const existing = await pool.query('SELECT COUNT(*) as c FROM restaurants');
    console.log(`Existing:       ${existing.rows[0].c} restaurants in PG`);
  } catch (err) {
    console.error('ERROR: Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  }
  console.log('');

  // Get restaurant docs from Firestore
  let restaurantDocs;
  if (RESTAURANT_FILTER) {
    const doc = await db.collection('restaurants').doc(RESTAURANT_FILTER).get();
    restaurantDocs = doc.exists ? [doc] : [];
    if (!doc.exists) {
      console.error(`Restaurant ${RESTAURANT_FILTER} not found in Firestore`);
      process.exit(1);
    }
  } else {
    console.log('Fetching all restaurant documents...');
    const snap = await db.collection('restaurants').get();
    restaurantDocs = snap.docs;
    console.log(`Found ${restaurantDocs.length} restaurants in Firestore`);
  }
  console.log('');

  if (DRY_RUN) {
    console.log(`DRY RUN — ${restaurantDocs.length} restaurants would be migrated.`);
    // Sample a few docs to show field stats
    const sampleDocs = restaurantDocs.slice(0, 5);
    for (const doc of sampleDocs) {
      const data = doc.data();
      const fieldCount = Object.keys(data).length;
      console.log(`  ${doc.id}: ${fieldCount} fields, name="${data.name || 'N/A'}"`);
    }
    console.log('');
    console.log('Remove --dry-run to perform the actual migration.');
    await pool.end();
    return;
  }

  // Migrate
  console.log('Migrating restaurants...');
  console.log('─'.repeat(60));

  for (const doc of restaurantDocs) {
    stats.total++;

    try {
      const data = doc.data();
      const pgRow = toPgRow({ id: doc.id, ...data });
      if (!pgRow.id) pgRow.id = doc.id;
      // Label as Firestore-origin (the app defaults new restaurants to 'native');
      // the guard on DO UPDATE below then never overwrites a native row.
      pgRow.origin = 'firestore';

      const cols = Object.keys(pgRow);
      const placeholders = cols.map((c, i) =>
        JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
      ).join(', ');
      const values = cols.map(c =>
        JSONB_COLUMNS.has(c) && pgRow[c] !== null ? JSON.stringify(pgRow[c]) : pgRow[c]
      );

      const result = await pool.query(
        `INSERT INTO restaurants (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT (id) ${UPSERT ? 'DO UPDATE SET ' + cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ') + " WHERE restaurants.origin IS DISTINCT FROM 'native'" : 'DO NOTHING'}`,
        values
      );

      if (result.rowCount > 0) {
        stats.inserted++;
      } else {
        stats.skipped++;
      }
    } catch (err) {
      stats.errors++;
      stats.errorDetails.push({ id: doc.id, error: err.message });
      if (stats.errorDetails.length <= 20) {
        console.error(`  ✗ [${doc.id}]: ${err.message}`);
      }
    }

    // Progress every 50 restaurants
    if (stats.total % 50 === 0 || stats.total === restaurantDocs.length) {
      const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
      process.stdout.write(
        `\r  ${stats.total}/${restaurantDocs.length} | ` +
        `Inserted: ${stats.inserted} | Skipped: ${stats.skipped} | ` +
        `Errors: ${stats.errors} | ${elapsed}s`
      );
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log('');

  // Verify
  console.log('Verification...');
  const pgCount = await pool.query('SELECT COUNT(*) as c FROM restaurants');
  const pgByStatus = await pool.query(
    "SELECT status, COUNT(*) as c FROM restaurants GROUP BY status ORDER BY c DESC"
  );
  const pgByType = await pool.query(
    "SELECT business_type, COUNT(*) as c FROM restaurants GROUP BY business_type ORDER BY c DESC LIMIT 10"
  );

  console.log(`  PG total:     ${pgCount.rows[0].c}`);
  console.log('  By status:');
  for (const row of pgByStatus.rows) {
    console.log(`    ${row.status || 'null'}: ${row.c}`);
  }
  console.log('  By type (top 10):');
  for (const row of pgByType.rows) {
    console.log(`    ${row.business_type || 'null'}: ${row.c}`);
  }
  console.log('');

  const totalElapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);

  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Migration Summary                                    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Firestore docs: ${stats.total}`);
  console.log(`  Inserted:       ${stats.inserted}`);
  console.log(`  Skipped:        ${stats.skipped}`);
  console.log(`  Errors:         ${stats.errors}`);
  console.log(`  Duration:       ${totalElapsed}s`);
  console.log('');

  if (stats.errors > 0) {
    console.log('  Error details (first 20):');
    for (const err of stats.errorDetails.slice(0, 20)) {
      console.log(`    [${err.id}]: ${err.error}`);
    }
    console.log('');
  }

  if (stats.errors === 0) {
    console.log('  ✓ Migration completed successfully!');
  } else {
    console.log('  ⚠ Migration completed with errors.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  process.exit(1);
});
