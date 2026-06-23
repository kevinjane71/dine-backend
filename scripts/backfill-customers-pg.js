#!/usr/bin/env node
/**
 * backfill-customers-pg.js — Migrate customers from Firestore → PostgreSQL.
 *
 * Usage:
 *   node scripts/backfill-customers-pg.js [--dry-run] [--restaurant <id>] [--upsert]
 */

require('dotenv').config({ path: '.env.local' });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
}, 'backfill-customers');
const db = getFirestore(app, 'dine');

const { query } = require('../repos/pgClient');
const { toPgRow, JSONB_COLUMNS } = require('../repos/customersFieldMapper');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const upsert = args.includes('--upsert');
const restaurantIdx = args.indexOf('--restaurant');
const filterRestaurant = restaurantIdx >= 0 ? args[restaurantIdx + 1] : null;

const BATCH_SIZE = 200;

async function main() {
  console.log('=== Customers Backfill: Firestore → PG ===');
  if (dryRun) console.log('  (DRY RUN — no writes)');
  if (upsert) console.log('  (UPSERT mode — update existing)');
  if (filterRestaurant) console.log(`  Filtering: ${filterRestaurant}`);

  let total = 0;
  let migrated = 0;
  let errors = 0;
  let lastDocId = null;

  while (true) {
    let q = db.collection('customers').orderBy('__name__').limit(BATCH_SIZE);

    if (filterRestaurant) {
      q = db.collection('customers')
        .where('restaurantId', '==', filterRestaurant)
        .orderBy('__name__')
        .limit(BATCH_SIZE);
    }

    if (lastDocId) {
      const lastDoc = await db.collection('customers').doc(lastDocId).get();
      if (lastDoc.exists) {
        q = q.startAfter(lastDoc);
      } else {
        break;
      }
    }

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      total++;
      lastDocId = doc.id;
      const data = doc.data();

      try {
        const pgRow = toPgRow({ id: doc.id, ...data });
        if (!pgRow.id) pgRow.id = doc.id;

        if (dryRun) {
          if (total <= 5) {
            console.log(`  [DRY RUN] ${doc.id}: restaurant=${pgRow.restaurant_id}, phone=${pgRow.phone}, name=${pgRow.name}`);
          }
          migrated++;
          continue;
        }

        const cols = Object.keys(pgRow);
        const placeholders = cols.map((c, i) =>
          JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
        ).join(', ');
        const values = cols.map(c =>
          JSONB_COLUMNS.has(c) && pgRow[c] !== null && pgRow[c] !== undefined
            ? JSON.stringify(pgRow[c]) : pgRow[c]
        );

        if (upsert) {
          const updateCols = cols.filter(c => c !== 'id');
          const updateClauses = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');

          await query(
            `INSERT INTO customers (${cols.join(', ')}) VALUES (${placeholders})
             ON CONFLICT (id) DO UPDATE SET ${updateClauses}`,
            values
          );
        } else {
          await query(
            `INSERT INTO customers (${cols.join(', ')}) VALUES (${placeholders})
             ON CONFLICT (id) DO NOTHING`,
            values
          );
        }

        migrated++;
      } catch (err) {
        errors++;
        if (errors <= 10) {
          console.error(`  ERROR ${doc.id}: ${err.message}`);
        }
      }
    }

    process.stdout.write(`\r  Processed: ${total}, Migrated: ${migrated}, Errors: ${errors}`);

    if (snap.docs.length < BATCH_SIZE) break;
  }

  console.log(`\n\n=== Done. Total: ${total}, Migrated: ${migrated}, Errors: ${errors} ===`);

  if (!dryRun) {
    const pgCount = await query('SELECT COUNT(*) as c FROM customers');
    console.log(`PG customers row count: ${pgCount.rows[0].c}`);

    // Sample check
    const sample = await query('SELECT id, restaurant_id, name, phone, total_orders, loyalty_points FROM customers LIMIT 5');
    console.log('\nSample rows:');
    console.table(sample.rows);
  }

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
