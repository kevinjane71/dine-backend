#!/usr/bin/env node
/**
 * backfill-counters-pg.js — Migrate counter data from Firestore to PG.
 *
 * Collections: daily_order_counters, order_id_counters, tab_counters
 * Target table: order_counters
 *
 * Usage:
 *   node scripts/backfill-counters-pg.js [--dry-run] [--restaurant <id>]
 */

require('dotenv').config({ path: '.env.local' });
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase from env vars (same as firebase.js)
const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
}, 'backfill-counters');
const db = getFirestore(app, 'dine');

const { query } = require('../repos/pgClient');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const restaurantIdx = args.indexOf('--restaurant');
const filterRestaurant = restaurantIdx >= 0 ? args[restaurantIdx + 1] : null;

async function backfillCollection(collectionName, counterType, extractFn) {
  console.log(`\n--- ${collectionName} → order_counters (type: ${counterType}) ---`);

  let snap;
  if (filterRestaurant) {
    // For daily_order_counters, doc IDs are restaurantId_date
    // For order_id_counters and tab_counters, doc IDs are restaurantId
    if (counterType === 'daily_order') {
      // Can't easily filter by prefix in Firestore, so get all and filter
      snap = await db.collection(collectionName).get();
    } else {
      snap = await db.collection(collectionName).where('restaurantId', '==', filterRestaurant).get();
    }
  } else {
    snap = await db.collection(collectionName).get();
  }

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const restaurantId = data.restaurantId || doc.id;

    if (filterRestaurant && counterType === 'daily_order') {
      if (!doc.id.startsWith(filterRestaurant + '_')) {
        skipped++;
        continue;
      }
    }

    // Build the PG counter ID
    let pgId, date, lastValue;

    if (counterType === 'daily_order') {
      date = data.date || doc.id.split('_').pop();
      lastValue = data.lastOrderId || 0;
      pgId = `${restaurantId}_daily_order_${date}`;
    } else if (counterType === 'sequential_order') {
      date = null;
      lastValue = data.lastOrderId || 0;
      pgId = `${restaurantId}_sequential_order`;
    } else if (counterType === 'tab') {
      date = data.date || null;
      lastValue = data.lastTabNumber || 0;
      pgId = date ? `${restaurantId}_tab_${date}` : `${restaurantId}_tab`;
    }

    if (dryRun) {
      console.log(`  [DRY RUN] ${pgId}: last_value=${lastValue}`);
      migrated++;
      continue;
    }

    try {
      await query(
        `INSERT INTO order_counters (id, restaurant_id, counter_type, date, last_value, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (id) DO UPDATE
           SET last_value = GREATEST(order_counters.last_value, $5),
               updated_at = NOW()`,
        [pgId, restaurantId, counterType, date, lastValue]
      );
      migrated++;
    } catch (err) {
      console.error(`  ERROR ${doc.id}: ${err.message}`);
      errors++;
    }
  }

  console.log(`  Total: ${snap.docs.length}, Migrated: ${migrated}, Skipped: ${skipped}, Errors: ${errors}`);
  return { total: snap.docs.length, migrated, skipped, errors };
}

async function main() {
  console.log('=== Counter Backfill: Firestore → PG ===');
  if (dryRun) console.log('  (DRY RUN — no writes)');
  if (filterRestaurant) console.log(`  Filtering: ${filterRestaurant}`);

  const results = [];

  results.push(await backfillCollection('daily_order_counters', 'daily_order', null));
  results.push(await backfillCollection('order_id_counters', 'sequential_order', null));
  results.push(await backfillCollection('tab_counters', 'tab', null));

  // Summary
  const totalMigrated = results.reduce((s, r) => s + r.migrated, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);

  console.log(`\n=== Done. Migrated: ${totalMigrated}, Errors: ${totalErrors} ===`);

  // Verify PG count
  if (!dryRun) {
    const pgCount = await query('SELECT COUNT(*) as c FROM order_counters');
    console.log(`PG order_counters row count: ${pgCount.rows[0].c}`);
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
