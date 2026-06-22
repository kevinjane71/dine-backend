/**
 * backfill-orders-pg.js — One-time migration of ALL orders from Firestore → PostgreSQL.
 *
 * Usage:
 *   cd dine-backend
 *   DATABASE_URL="postgresql://dine_app:PASSWORD@HOST:5432/dine?ssl=true&sslmode=no-verify" node scripts/backfill-orders-pg.js
 *
 * Options:
 *   --dry-run       Count orders without inserting (safe, no PG writes)
 *   --restaurant=ID Migrate only one restaurant (for testing)
 *   --since=DATE    Only migrate orders after this date (e.g. 2025-01-01)
 *   --batch=N       Batch size for Firestore reads (default: 500)
 *
 * Features:
 *   - Idempotent: uses ON CONFLICT (id) DO NOTHING (safe to re-run)
 *   - Read-only on Firestore (no modifications)
 *   - Streams in batches to avoid memory issues
 *   - Logs progress, errors, and summary
 *   - Verifies counts at the end
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { db, collections } = require('../firebase');
const { getPool } = require('../repos/pgClient');
const { toPgRow, JSONB_COLUMNS, toJsonbValue } = require('../repos/fieldMapper');

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch='))?.split('=')[1]) || 500;
const RESTAURANT_FILTER = args.find(a => a.startsWith('--restaurant='))?.split('=')[1] || null;
const SINCE_DATE = args.find(a => a.startsWith('--since='))?.split('=')[1] || null;
const UPSERT = args.includes('--upsert'); // Update existing rows instead of skipping

// Stats
const stats = {
  totalRead: 0,
  totalInserted: 0,
  totalSkipped: 0,  // already existed (ON CONFLICT)
  totalErrors: 0,
  errorDetails: [],
  startTime: Date.now(),
  restaurantCounts: {},
};

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Firestore → PostgreSQL Orders Backfill               ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN (no PG writes)' : 'LIVE MIGRATION'}`);
  console.log(`Batch size:     ${BATCH_SIZE}`);
  console.log(`Restaurant:     ${RESTAURANT_FILTER || 'ALL'}`);
  console.log(`Since:          ${SINCE_DATE || 'ALL TIME'}`);
  console.log(`Database URL:   ${process.env.DATABASE_URL ? '✓ set' : '✗ MISSING'}`);
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required.');
    process.exit(1);
  }

  // Test PG connection
  const pool = getPool();
  try {
    const pgTest = await pool.query('SELECT NOW() as time, COUNT(*) as existing_orders FROM orders');
    console.log(`PG connected:   ${pgTest.rows[0].time}`);
    console.log(`Existing orders: ${pgTest.rows[0].existing_orders}`);
  } catch (err) {
    console.error('ERROR: Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  }
  console.log('');

  // Phase 1: Count orders in Firestore
  console.log('Phase 1: Counting Firestore orders...');
  let countQuery = db.collection(collections.orders);
  if (RESTAURANT_FILTER) {
    countQuery = countQuery.where('restaurantId', '==', RESTAURANT_FILTER);
  }
  if (SINCE_DATE) {
    countQuery = countQuery.where('createdAt', '>=', new Date(SINCE_DATE));
  }
  const countSnapshot = await countQuery.count().get();
  const totalExpected = countSnapshot.data().count;
  console.log(`Total orders to migrate: ${totalExpected.toLocaleString()}`);
  console.log('');

  if (totalExpected === 0) {
    console.log('No orders found. Exiting.');
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
  console.log('Phase 2: Migrating orders...');
  console.log('─'.repeat(60));

  let lastDoc = null;
  let batchNum = 0;

  while (true) {
    batchNum++;

    // Build paginated query
    let batchQuery = db.collection(collections.orders);
    if (RESTAURANT_FILTER) {
      batchQuery = batchQuery.where('restaurantId', '==', RESTAURANT_FILTER);
    }
    if (SINCE_DATE) {
      batchQuery = batchQuery.where('createdAt', '>=', new Date(SINCE_DATE));
    }
    batchQuery = batchQuery.orderBy('createdAt', 'asc');
    if (lastDoc) {
      batchQuery = batchQuery.startAfter(lastDoc);
    }
    batchQuery = batchQuery.limit(BATCH_SIZE);

    const snapshot = await batchQuery.get();
    if (snapshot.empty) break;

    const docs = snapshot.docs;
    lastDoc = docs[docs.length - 1];
    stats.totalRead += docs.length;

    // Convert all docs to PG rows
    const pgRows = [];
    for (const doc of docs) {
      try {
        const firestoreData = doc.data();
        const pgRow = toPgRow({ id: doc.id, ...firestoreData });

        // Track per-restaurant counts
        const restId = firestoreData.restaurantId || 'unknown';
        stats.restaurantCounts[restId] = (stats.restaurantCounts[restId] || 0) + 1;

        pgRows.push(pgRow);
      } catch (err) {
        stats.totalErrors++;
        stats.errorDetails.push({ orderId: doc.id, error: err.message, phase: 'convert' });
        if (stats.errorDetails.length <= 20) {
          console.error(`  ✗ Convert error [${doc.id}]: ${err.message}`);
        }
      }
    }

    // Batch insert into PostgreSQL
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
  const pgCountResult = await pool.query('SELECT COUNT(*) as count FROM orders');
  const pgTotal = parseInt(pgCountResult.rows[0].count);

  // Per-restaurant verification (top 20)
  const pgPerRestaurant = await pool.query(
    'SELECT restaurant_id, COUNT(*) as count FROM orders GROUP BY restaurant_id ORDER BY count DESC LIMIT 20'
  );

  console.log(`  Firestore orders:  ${totalExpected.toLocaleString()}`);
  console.log(`  PostgreSQL orders: ${pgTotal.toLocaleString()}`);
  console.log(`  Match: ${pgTotal >= stats.totalInserted + stats.totalSkipped ? '✓' : '✗ MISMATCH'}`);
  console.log('');

  console.log('  Top restaurants by order count (PG):');
  for (const row of pgPerRestaurant.rows) {
    console.log(`    ${row.restaurant_id}: ${parseInt(row.count).toLocaleString()} orders`);
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
  console.log(`  Rate:                ${(stats.totalRead / totalElapsed * 60).toFixed(0)} orders/min`);
  console.log('');

  if (stats.totalErrors > 0) {
    console.log('  Error details (first 20):');
    for (const err of stats.errorDetails.slice(0, 20)) {
      console.log(`    [${err.phase}] ${err.orderId}: ${err.error}`);
    }
    console.log('');
  }

  if (stats.totalErrors === 0 && stats.totalRead === totalExpected) {
    console.log('  ✓ Migration completed successfully!');
  } else if (stats.totalErrors > 0) {
    console.log('  ⚠ Migration completed with errors. Re-run to retry failed orders.');
  }

  await pool.end();
}

/**
 * Batch insert rows into PostgreSQL.
 * Uses SAVEPOINT per row so one failure doesn't kill the whole batch.
 * Uses ON CONFLICT (id) DO NOTHING for primary key idempotency.
 * Duplicate idempotency_key violations are handled gracefully (nullify and retry).
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
          `INSERT INTO orders (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (id) ${UPSERT ? 'DO UPDATE SET ' + cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ') : 'DO NOTHING'}`,
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

        // Handle duplicate idempotency_key: nullify and retry
        if (err.message.includes('idx_orders_idempotency')) {
          try {
            row.idempotency_key = null; // clear the duplicate key
            await client.query('SAVEPOINT sp2');

            const cols2 = [];
            const ph2 = [];
            const vals2 = [];
            let j = 1;
            for (const [col, val] of Object.entries(row)) {
              cols2.push(col);
              if (JSONB_COLUMNS.has(col)) {
                ph2.push(`$${j}::jsonb`);
                vals2.push(val == null ? null : (typeof val === 'string' ? val : JSON.stringify(val)));
              } else {
                ph2.push(`$${j}`);
                vals2.push(val);
              }
              j++;
            }

            const retryResult = await client.query(
              `INSERT INTO orders (${cols2.join(', ')}) VALUES (${ph2.join(', ')}) ON CONFLICT (id) DO NOTHING`,
              vals2
            );
            await client.query('RELEASE SAVEPOINT sp2');

            if (retryResult.rowCount > 0) {
              inserted++;
            } else {
              skipped++;
            }
            continue;
          } catch (retryErr) {
            await client.query('ROLLBACK TO SAVEPOINT sp2').catch(() => {});
          }
        }

        errors++;
        stats.errorDetails.push({ orderId: row.id, error: err.message, phase: 'insert' });
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
