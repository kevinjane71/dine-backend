/**
 * backfill-daily-stats-pg.js — One-time migration of dailyStats from Firestore → PostgreSQL.
 *
 * Usage:
 *   cd dine-backend
 *   DATABASE_URL="postgresql://..." node scripts/backfill-daily-stats-pg.js
 *
 * Options:
 *   --dry-run         Count docs without inserting
 *   --restaurant=ID   Migrate only one restaurant's stats
 *   --batch=N         Batch size for Firestore reads (default: 500)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { db } = require('../firebase');
const { getPool } = require('../repos/pgClient');
const { toPgRow, JSONB_COLUMNS, toJsonbValue } = require('../repos/dailyStatsFieldMapper');

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1]) || 500;
const RESTAURANT_FILTER = args.find(a => a.startsWith('--restaurant='))?.split('=')[1] || null;
const UPSERT = args.includes('--upsert');

// Stats
const stats = {
  totalRead: 0,
  totalInserted: 0,
  totalSkipped: 0,
  totalErrors: 0,
  errorDetails: [],
  startTime: Date.now(),
  restaurantCounts: {},
};

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Firestore → PostgreSQL DailyStats Backfill           ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN (no PG writes)' : 'LIVE MIGRATION'}`);
  console.log(`Batch size:     ${BATCH_SIZE}`);
  console.log(`Restaurant:     ${RESTAURANT_FILTER || 'ALL'}`);
  console.log(`Database URL:   ${process.env.DATABASE_URL ? '✓ set' : '✗ MISSING'}`);
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  // Test PG connection
  const pool = getPool();
  try {
    const pgTest = await pool.query('SELECT NOW() as time, COUNT(*) as existing FROM daily_stats');
    console.log(`PG connected:   ${pgTest.rows[0].time}`);
    console.log(`Existing rows:  ${pgTest.rows[0].existing}`);
  } catch (err) {
    console.error('ERROR: Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  }
  console.log('');

  // Phase 1: Count docs in Firestore
  console.log('Phase 1: Counting Firestore dailyStats docs...');
  let countQuery = db.collection('dailyStats');
  if (RESTAURANT_FILTER) {
    countQuery = countQuery.where('restaurantId', '==', RESTAURANT_FILTER);
  }
  const countSnapshot = await countQuery.count().get();
  const totalExpected = countSnapshot.data().count;
  console.log(`Total docs to migrate: ${totalExpected.toLocaleString()}`);
  console.log('');

  if (totalExpected === 0) {
    console.log('No dailyStats docs found. Exiting.');
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log('DRY RUN — no data will be written to PostgreSQL.');
    console.log('Remove --dry-run to perform the actual migration.');
    await pool.end();
    return;
  }

  // Phase 2: Stream and insert
  console.log('Phase 2: Migrating dailyStats...');
  console.log('─'.repeat(60));

  let lastDoc = null;
  let batchNum = 0;

  while (true) {
    batchNum++;

    // Build paginated query (order by __name__ since dailyStats has no createdAt guaranteed)
    let batchQuery = db.collection('dailyStats');
    if (RESTAURANT_FILTER) {
      batchQuery = batchQuery.where('restaurantId', '==', RESTAURANT_FILTER);
    }
    if (lastDoc) {
      batchQuery = batchQuery.startAfter(lastDoc);
    }
    batchQuery = batchQuery.limit(BATCH_SIZE);

    const snapshot = await batchQuery.get();
    if (snapshot.empty) break;

    const docs = snapshot.docs;
    lastDoc = docs[docs.length - 1];
    stats.totalRead += docs.length;

    // Convert docs to PG rows
    const pgRows = [];
    for (const doc of docs) {
      try {
        const firestoreData = doc.data();
        const pgRow = toPgRow({ id: doc.id, ...firestoreData });

        const restId = firestoreData.restaurantId || 'unknown';
        stats.restaurantCounts[restId] = (stats.restaurantCounts[restId] || 0) + 1;

        pgRows.push(pgRow);
      } catch (err) {
        stats.totalErrors++;
        stats.errorDetails.push({ docId: doc.id, error: err.message, phase: 'convert' });
        if (stats.errorDetails.length <= 20) {
          console.error(`  ✗ Convert error [${doc.id}]: ${err.message}`);
        }
      }
    }

    // Batch insert
    if (pgRows.length > 0) {
      const { inserted, skipped, errors } = await batchInsert(pool, pgRows);
      stats.totalInserted += inserted;
      stats.totalSkipped += skipped;
      stats.totalErrors += errors;
    }

    // Progress
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    const rate = (stats.totalRead / elapsed * 60).toFixed(0);
    const pct = ((stats.totalRead / totalExpected) * 100).toFixed(1);
    process.stdout.write(
      `\r  Batch ${batchNum}: ${stats.totalRead.toLocaleString()}/${totalExpected.toLocaleString()} (${pct}%) | ` +
      `Inserted: ${stats.totalInserted.toLocaleString()} | Skipped: ${stats.totalSkipped.toLocaleString()} | ` +
      `Errors: ${stats.totalErrors} | ${rate}/min | ${elapsed}s`
    );
  }

  console.log('\n' + '─'.repeat(60));
  console.log('');

  // Phase 3: Verify
  console.log('Phase 3: Verification...');
  const pgCountResult = await pool.query('SELECT COUNT(*) as count FROM daily_stats');
  const pgTotal = parseInt(pgCountResult.rows[0].count);

  const pgPerRestaurant = await pool.query(
    'SELECT restaurant_id, COUNT(*) as count FROM daily_stats GROUP BY restaurant_id ORDER BY count DESC LIMIT 20'
  );

  console.log(`  Firestore docs:    ${totalExpected.toLocaleString()}`);
  console.log(`  PostgreSQL rows:   ${pgTotal.toLocaleString()}`);
  console.log(`  Match: ${pgTotal >= stats.totalInserted + stats.totalSkipped ? '✓' : '✗ MISMATCH'}`);
  console.log('');

  console.log('  Top restaurants by dailyStats count (PG):');
  for (const row of pgPerRestaurant.rows) {
    console.log(`    ${row.restaurant_id}: ${parseInt(row.count).toLocaleString()} days`);
  }
  console.log('');

  // Summary
  const totalElapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Migration Summary                                    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Read from Firestore: ${stats.totalRead.toLocaleString()}`);
  console.log(`  Inserted into PG:    ${stats.totalInserted.toLocaleString()}`);
  console.log(`  Skipped (existing):  ${stats.totalSkipped.toLocaleString()}`);
  console.log(`  Errors:              ${stats.totalErrors}`);
  console.log(`  Restaurants:         ${Object.keys(stats.restaurantCounts).length}`);
  console.log(`  Duration:            ${totalElapsed}s`);
  console.log(`  Rate:                ${(stats.totalRead / totalElapsed * 60).toFixed(0)} docs/min`);
  console.log('');

  if (stats.totalErrors > 0) {
    console.log('  Error details (first 20):');
    for (const err of stats.errorDetails.slice(0, 20)) {
      console.log(`    [${err.phase}] ${err.docId}: ${err.error}`);
    }
    console.log('');
  }

  if (stats.totalErrors === 0 && stats.totalRead === totalExpected) {
    console.log('  ✓ Migration completed successfully!');
  } else if (stats.totalErrors > 0) {
    console.log('  ⚠ Migration completed with errors. Re-run to retry failed docs.');
  }

  await pool.end();
}

/**
 * Batch insert rows into PostgreSQL with SAVEPOINT per row.
 */
async function batchInsert(pool, pgRows) {
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of pgRows) {
      try {
        await client.query('SAVEPOINT sp');

        const cols = [];
        const placeholders = [];
        const values = [];
        let i = 1;

        for (const [col, val] of Object.entries(row)) {
          cols.push(col);
          if (JSONB_COLUMNS.has(col)) {
            placeholders.push(`$${i}::jsonb`);
            values.push(toJsonbValue(val));
          } else {
            placeholders.push(`$${i}`);
            values.push(val);
          }
          i++;
        }

        const result = await client.query(
          `INSERT INTO daily_stats (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (id) ${UPSERT ? 'DO UPDATE SET ' + cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ') : 'DO NOTHING'}`,
          values
        );

        await client.query('RELEASE SAVEPOINT sp');

        if (result.rowCount > 0) {
          inserted++;
        } else {
          skipped++;
        }
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT sp');
        errors++;
        stats.errorDetails.push({ docId: row.id, error: err.message, phase: 'insert' });
        if (stats.errorDetails.length <= 20) {
          console.error(`\n  ✗ Insert error [${row.id}]: ${err.message}`);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n  ✗ Batch transaction error: ${err.message}`);
    errors += pgRows.length;
  } finally {
    client.release();
  }

  return { inserted, skipped, errors };
}

// Run
main().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  process.exit(1);
});
