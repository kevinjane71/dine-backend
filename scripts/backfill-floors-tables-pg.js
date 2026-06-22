/**
 * backfill-floors-tables-pg.js — Migrate floors + tables from Firestore → PostgreSQL.
 *
 * Two-pass migration:
 *   Pass 1: restaurants/{rid}/floors/ → floors table
 *   Pass 2: restaurants/{rid}/floors/{fid}/tables/ → tables table
 *
 * Usage:
 *   cd dine-backend
 *   DATABASE_URL="postgresql://..." node scripts/backfill-floors-tables-pg.js
 *
 * Options:
 *   --dry-run           Count docs without inserting
 *   --restaurant=ID     Migrate only one restaurant
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { db } = require('../firebase');
const { getPool } = require('../repos/pgClient');
const { floorToPgRow, tableToPgRow } = require('../repos/floorsTablesFieldMapper');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESTAURANT_FILTER = args.find(a => a.startsWith('--restaurant='))?.split('=')[1] || null;
const UPSERT = args.includes('--upsert');

const stats = {
  restaurants: 0,
  floorsRead: 0,
  floorsInserted: 0,
  floorsSkipped: 0,
  floorsErrors: 0,
  tablesRead: 0,
  tablesInserted: 0,
  tablesSkipped: 0,
  tablesErrors: 0,
  errorDetails: [],
  startTime: Date.now(),
};

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Firestore → PostgreSQL Floors+Tables Backfill       ║');
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
    const floorCount = await pool.query('SELECT COUNT(*) as c FROM floors');
    const tableCount = await pool.query('SELECT COUNT(*) as c FROM tables');
    console.log(`Existing:       ${floorCount.rows[0].c} floors, ${tableCount.rows[0].c} tables`);
  } catch (err) {
    console.error('ERROR: Cannot connect to PostgreSQL:', err.message);
    process.exit(1);
  }
  console.log('');

  // Get restaurant IDs
  let restaurantIds = [];
  if (RESTAURANT_FILTER) {
    restaurantIds = [RESTAURANT_FILTER];
  } else {
    console.log('Fetching restaurant IDs...');
    const restSnap = await db.collection('restaurants').select().get();
    restaurantIds = restSnap.docs.map(d => d.id);
    console.log(`Found ${restaurantIds.length} restaurants`);
  }
  console.log('');

  if (DRY_RUN) {
    // Count floors/tables per restaurant
    let totalFloors = 0, totalTables = 0;
    for (const rid of restaurantIds) {
      const floorsSnap = await db.collection('restaurants').doc(rid).collection('floors').get();
      totalFloors += floorsSnap.size;
      for (const floorDoc of floorsSnap.docs) {
        const tablesSnap = await db.collection('restaurants').doc(rid)
          .collection('floors').doc(floorDoc.id).collection('tables').get();
        totalTables += tablesSnap.size;
      }
    }
    console.log(`DRY RUN — ${totalFloors} floors, ${totalTables} tables across ${restaurantIds.length} restaurants`);
    console.log('Remove --dry-run to perform the actual migration.');
    await pool.end();
    return;
  }

  // Pass 1 + 2: For each restaurant, read floors and their tables
  console.log('Migrating floors + tables...');
  console.log('─'.repeat(60));

  for (const rid of restaurantIds) {
    stats.restaurants++;
    const floorsSnap = await db.collection('restaurants').doc(rid).collection('floors').get();

    for (const floorDoc of floorsSnap.docs) {
      stats.floorsRead++;

      // Insert floor
      try {
        const floorData = floorDoc.data();
        const pgRow = floorToPgRow({
          id: floorDoc.id,
          restaurantId: rid,
          ...floorData,
        });

        const cols = Object.keys(pgRow);
        const placeholders = cols.map((c, i) => c === 'extra_data' ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
        const values = cols.map(c => c === 'extra_data' ? JSON.stringify(pgRow[c]) : pgRow[c]);

        const result = await pool.query(
          `INSERT INTO floors (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (id, restaurant_id) ${UPSERT ? 'DO UPDATE SET ' + cols.filter(c => c !== 'id' && c !== 'restaurant_id').map(c => `${c} = EXCLUDED.${c}`).join(', ') : 'DO NOTHING'}`,
          values
        );

        if (result.rowCount > 0) {
          stats.floorsInserted++;
        } else {
          stats.floorsSkipped++;
        }
      } catch (err) {
        stats.floorsErrors++;
        stats.errorDetails.push({ type: 'floor', id: floorDoc.id, rid, error: err.message });
        if (stats.errorDetails.length <= 20) {
          console.error(`  ✗ Floor [${floorDoc.id}]: ${err.message}`);
        }
      }

      // Insert tables for this floor
      const tablesSnap = await db.collection('restaurants').doc(rid)
        .collection('floors').doc(floorDoc.id).collection('tables').get();

      for (const tableDoc of tablesSnap.docs) {
        stats.tablesRead++;

        try {
          const tableData = tableDoc.data();
          const pgRow = tableToPgRow({
            id: tableDoc.id,
            restaurantId: rid,
            floorId: floorDoc.id,
            ...tableData,
          });

          // Ensure required fields
          pgRow.restaurant_id = rid;
          pgRow.floor_id = floorDoc.id;

          const cols = Object.keys(pgRow);
          const placeholders = cols.map((c, i) => c === 'extra_data' ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
          const values = cols.map(c => c === 'extra_data' ? JSON.stringify(pgRow[c]) : pgRow[c]);

          const result = await pool.query(
            `INSERT INTO tables (${cols.join(', ')}) VALUES (${placeholders})
             ON CONFLICT (id) ${UPSERT ? 'DO UPDATE SET ' + cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ') : 'DO NOTHING'}`,
            values
          );

          if (result.rowCount > 0) {
            stats.tablesInserted++;
          } else {
            stats.tablesSkipped++;
          }
        } catch (err) {
          stats.tablesErrors++;
          stats.errorDetails.push({ type: 'table', id: tableDoc.id, rid, floorId: floorDoc.id, error: err.message });
          if (stats.errorDetails.length <= 20) {
            console.error(`  ✗ Table [${tableDoc.id}]: ${err.message}`);
          }
        }
      }
    }

    // Progress
    const elapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);
    process.stdout.write(
      `\r  ${stats.restaurants}/${restaurantIds.length} restaurants | ` +
      `Floors: ${stats.floorsInserted} new, ${stats.floorsSkipped} existing | ` +
      `Tables: ${stats.tablesInserted} new, ${stats.tablesSkipped} existing | ` +
      `Errors: ${stats.floorsErrors + stats.tablesErrors} | ${elapsed}s`
    );
  }

  console.log('\n' + '─'.repeat(60));
  console.log('');

  // Verify
  console.log('Verification...');
  const pgFloors = await pool.query('SELECT COUNT(*) as c FROM floors');
  const pgTables = await pool.query('SELECT COUNT(*) as c FROM tables');
  const pgPerRest = await pool.query(
    'SELECT restaurant_id, COUNT(*) as floors FROM floors GROUP BY restaurant_id ORDER BY floors DESC LIMIT 10'
  );

  console.log(`  PG floors:  ${pgFloors.rows[0].c}`);
  console.log(`  PG tables:  ${pgTables.rows[0].c}`);
  console.log('');
  console.log('  Top restaurants by floor count:');
  for (const row of pgPerRest.rows) {
    console.log(`    ${row.restaurant_id}: ${row.floors} floors`);
  }
  console.log('');

  const totalErrors = stats.floorsErrors + stats.tablesErrors;
  const totalElapsed = ((Date.now() - stats.startTime) / 1000).toFixed(1);

  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Migration Summary                                    ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Restaurants:     ${stats.restaurants}`);
  console.log(`  Floors read:     ${stats.floorsRead}`);
  console.log(`  Floors inserted: ${stats.floorsInserted}`);
  console.log(`  Floors skipped:  ${stats.floorsSkipped}`);
  console.log(`  Tables read:     ${stats.tablesRead}`);
  console.log(`  Tables inserted: ${stats.tablesInserted}`);
  console.log(`  Tables skipped:  ${stats.tablesSkipped}`);
  console.log(`  Errors:          ${totalErrors}`);
  console.log(`  Duration:        ${totalElapsed}s`);
  console.log('');

  if (totalErrors > 0) {
    console.log('  Error details (first 20):');
    for (const err of stats.errorDetails.slice(0, 20)) {
      console.log(`    [${err.type}] ${err.id} (${err.rid}): ${err.error}`);
    }
    console.log('');
  }

  if (totalErrors === 0) {
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
