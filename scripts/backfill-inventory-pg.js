/**
 * backfill-inventory-pg.js — Migrate 7 inventory collections from Firestore → PostgreSQL.
 *
 * Usage:
 *   cd dine-backend
 *   DATABASE_URL="postgresql://..." node scripts/backfill-inventory-pg.js
 *
 * Options:
 *   --dry-run             Count docs without inserting
 *   --restaurant=ID       Migrate only one restaurant
 *   --collection=NAME     Migrate only one collection (inventory|inventoryTransactions|stockBatches|wasteEntries|recipes|barBottles|barReconciliation)
 *   --skip=NAME           Skip a collection (can be repeated)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { db } = require('../firebase');
const { getPool } = require('../repos/pgClient');
const mapper = require('../repos/inventoryFieldMapper');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESTAURANT_FILTER = args.find(a => a.startsWith('--restaurant='))?.split('=')[1] || null;
const COLLECTION_FILTER = args.find(a => a.startsWith('--collection='))?.split('=')[1] || null;
const SKIP_COLLECTIONS = new Set(
  args.filter(a => a.startsWith('--skip=')).map(a => a.split('=')[1])
);
const UPSERT = args.includes('--upsert');

// Collection definitions: Firestore name → PG table + mapper
const COLLECTIONS = [
  { fsName: 'inventory',              pgTable: 'inventory',               mapper: mapper.inventory },
  { fsName: 'inventoryTransactions',  pgTable: 'inventory_transactions',  mapper: mapper.inventoryTransactions },
  { fsName: 'stockBatches',           pgTable: 'stock_batches',           mapper: mapper.stockBatches },
  { fsName: 'wasteEntries',           pgTable: 'waste_entries',           mapper: mapper.wasteEntries },
  { fsName: 'recipes',                pgTable: 'recipes',                 mapper: mapper.recipes },
  { fsName: 'barBottles',             pgTable: 'bar_bottles',             mapper: mapper.barBottles },
  { fsName: 'barReconciliation',      pgTable: 'bar_reconciliation',      mapper: mapper.barReconciliation },
];

const grandStats = {
  startTime: Date.now(),
  collections: {},
};

async function migrateCollection(pool, collectionDef) {
  const { fsName, pgTable, mapper: colMapper } = collectionDef;
  const { toPgRow, JSONB_COLUMNS } = colMapper;

  const stats = { total: 0, inserted: 0, skipped: 0, errors: 0, errorDetails: [] };
  grandStats.collections[fsName] = stats;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${fsName} → ${pgTable}`);
  console.log('═'.repeat(60));

  // Fetch docs
  let query;
  if (RESTAURANT_FILTER) {
    query = db.collection(fsName).where('restaurantId', '==', RESTAURANT_FILTER);
  } else {
    query = db.collection(fsName);
  }

  const snap = await query.get();
  console.log(`  Firestore docs: ${snap.docs.length}`);

  if (snap.docs.length === 0) {
    console.log('  (empty collection — skipping)');
    return;
  }

  if (DRY_RUN) {
    // Sample a few
    const samples = snap.docs.slice(0, 3);
    for (const doc of samples) {
      const data = doc.data();
      console.log(`    ${doc.id}: ${Object.keys(data).length} fields`);
    }
    return;
  }

  // Existing count
  const existing = await pool.query(`SELECT COUNT(*)::int as c FROM ${pgTable}`);
  console.log(`  Existing in PG: ${existing.rows[0].c}`);

  // Migrate in batches
  const BATCH_SIZE = 50;
  const docs = snap.docs;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);

    for (const doc of batch) {
      stats.total++;

      try {
        const data = doc.data();
        const pgRow = toPgRow({ id: doc.id, ...data });
        if (!pgRow.id) pgRow.id = doc.id;

        const cols = Object.keys(pgRow);
        const placeholders = cols.map((c, idx) =>
          JSONB_COLUMNS.has(c) ? `$${idx + 1}::jsonb` : `$${idx + 1}`
        ).join(', ');
        const values = cols.map(c =>
          JSONB_COLUMNS.has(c) && pgRow[c] !== null && pgRow[c] !== undefined
            ? JSON.stringify(pgRow[c])
            : pgRow[c]
        );

        const result = await pool.query(
          `INSERT INTO ${pgTable} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (id) ${UPSERT ? 'DO UPDATE SET ' + cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ') : 'DO NOTHING'}`,
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
        if (stats.errorDetails.length <= 10) {
          console.error(`  ✗ [${doc.id}]: ${err.message}`);
        }
      }
    }

    // Progress
    const elapsed = ((Date.now() - grandStats.startTime) / 1000).toFixed(1);
    process.stdout.write(
      `\r  ${stats.total}/${docs.length} | ` +
      `Inserted: ${stats.inserted} | Skipped: ${stats.skipped} | ` +
      `Errors: ${stats.errors} | ${elapsed}s`
    );
  }

  console.log('');  // newline after progress

  // Verify count
  const pgCount = await pool.query(`SELECT COUNT(*)::int as c FROM ${pgTable}`);
  console.log(`  PG total after:  ${pgCount.rows[0].c}`);

  if (stats.errors > 0) {
    console.log(`  Error details (first 10):`);
    for (const err of stats.errorDetails.slice(0, 10)) {
      console.log(`    [${err.id}]: ${err.error}`);
    }
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Firestore → PostgreSQL Inventory Backfill           ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Mode:           ${DRY_RUN ? 'DRY RUN' : 'LIVE MIGRATION'}`);
  console.log(`Restaurant:     ${RESTAURANT_FILTER || 'ALL'}`);
  console.log(`Collection:     ${COLLECTION_FILTER || 'ALL'}`);
  if (SKIP_COLLECTIONS.size > 0) console.log(`Skip:           ${[...SKIP_COLLECTIONS].join(', ')}`);
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
  } catch (err) {
    console.error('ERROR: Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  }

  // Filter collections
  let collectionsToMigrate = COLLECTIONS;
  if (COLLECTION_FILTER) {
    collectionsToMigrate = COLLECTIONS.filter(c => c.fsName === COLLECTION_FILTER);
    if (collectionsToMigrate.length === 0) {
      console.error(`ERROR: Unknown collection "${COLLECTION_FILTER}"`);
      console.error(`Available: ${COLLECTIONS.map(c => c.fsName).join(', ')}`);
      process.exit(1);
    }
  }
  collectionsToMigrate = collectionsToMigrate.filter(c => !SKIP_COLLECTIONS.has(c.fsName));

  console.log(`\nMigrating ${collectionsToMigrate.length} collection(s)...`);

  for (const col of collectionsToMigrate) {
    await migrateCollection(pool, col);
  }

  // Grand summary
  const totalElapsed = ((Date.now() - grandStats.startTime) / 1000).toFixed(1);

  console.log('\n' + '═'.repeat(60));
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Migration Summary                                    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');

  let grandTotal = 0, grandInserted = 0, grandErrors = 0;
  for (const [name, stats] of Object.entries(grandStats.collections)) {
    const icon = stats.errors > 0 ? '⚠' : '✓';
    console.log(`  ${icon} ${name}: ${stats.inserted} inserted, ${stats.skipped} skipped, ${stats.errors} errors (${stats.total} total)`);
    grandTotal += stats.total;
    grandInserted += stats.inserted;
    grandErrors += stats.errors;
  }
  console.log('');
  console.log(`  Grand total: ${grandInserted} inserted / ${grandTotal} docs, ${grandErrors} errors`);
  console.log(`  Duration:    ${totalElapsed}s`);
  console.log('');

  if (grandErrors === 0) {
    console.log('  ✓ All collections migrated successfully!');
  } else {
    console.log('  ⚠ Migration completed with errors. Review above for details.');
  }

  await pool.end();
}

main().catch(err => {
  console.error('FATAL:', err.message, err.stack);
  process.exit(1);
});
