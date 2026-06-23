#!/usr/bin/env node
/**
 * backfill-offers-pg.js — Migrate offers + customerOfferUsage from Firestore → PG.
 *
 * Usage:
 *   node scripts/backfill-offers-pg.js [--dry-run] [--restaurant <id>] [--upsert] [--skip-usage]
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
}, 'backfill-offers');
const db = getFirestore(app, 'dine');

const { query } = require('../repos/pgClient');
const { toPgRow, JSONB_COLUMNS } = require('../repos/offersFieldMapper');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const upsert = args.includes('--upsert');
const skipUsage = args.includes('--skip-usage');
const restaurantIdx = args.indexOf('--restaurant');
const filterRestaurant = restaurantIdx >= 0 ? args[restaurantIdx + 1] : null;

const BATCH_SIZE = 200;

async function backfillOffers() {
  console.log('\n--- offers ---');
  let total = 0, migrated = 0, errors = 0;
  let lastDocId = null;

  while (true) {
    let q = db.collection('offers').orderBy('__name__').limit(BATCH_SIZE);
    if (filterRestaurant) {
      q = db.collection('offers')
        .where('restaurantId', '==', filterRestaurant)
        .orderBy('__name__')
        .limit(BATCH_SIZE);
    }
    if (lastDocId) {
      const lastDoc = await db.collection('offers').doc(lastDocId).get();
      if (lastDoc.exists) q = q.startAfter(lastDoc);
      else break;
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
          if (total <= 5) console.log(`  [DRY RUN] ${doc.id}: ${pgRow.name}`);
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
          await query(
            `INSERT INTO offers (${cols.join(', ')}) VALUES (${placeholders})
             ON CONFLICT (id) DO UPDATE SET ${updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
            values
          );
        } else {
          await query(
            `INSERT INTO offers (${cols.join(', ')}) VALUES (${placeholders})
             ON CONFLICT (id) DO NOTHING`,
            values
          );
        }
        migrated++;
      } catch (err) {
        errors++;
        if (errors <= 10) console.error(`  ERROR ${doc.id}: ${err.message}`);
      }
    }

    process.stdout.write(`\r  Offers: ${total}, Migrated: ${migrated}, Errors: ${errors}`);
    if (snap.docs.length < BATCH_SIZE) break;
  }

  console.log(`\n  Offers done. Total: ${total}, Migrated: ${migrated}, Errors: ${errors}`);
  return { total, migrated, errors };
}

async function backfillCustomerOfferUsage() {
  if (skipUsage) {
    console.log('\n--- customerOfferUsage (SKIPPED) ---');
    return { total: 0, migrated: 0, errors: 0 };
  }

  console.log('\n--- customerOfferUsage (subcollections) ---');
  let total = 0, migrated = 0, errors = 0;

  // Get all offer IDs first
  const offersSnap = await db.collection('offers').select().get();
  const offerIds = offersSnap.docs.map(d => d.id);
  console.log(`  Found ${offerIds.length} offers to scan for subcollections`);

  for (const offerId of offerIds) {
    const usageSnap = await db.collection('offers').doc(offerId)
      .collection('customerOfferUsage').get();

    for (const doc of usageSnap.docs) {
      total++;
      const data = doc.data();

      try {
        if (dryRun) {
          if (total <= 5) console.log(`  [DRY RUN] ${offerId}/${doc.id}: count=${data.usageCount}`);
          migrated++;
          continue;
        }

        const firstUsedAt = data.firstUsedAt || null;
        const lastUsedAt = data.lastUsedAt || null;

        await query(
          `INSERT INTO customer_offer_usage (offer_id, customer_key, usage_count, first_used_at, last_used_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (offer_id, customer_key) DO UPDATE
             SET usage_count = GREATEST(customer_offer_usage.usage_count, $3),
                 last_used_at = COALESCE($5, customer_offer_usage.last_used_at)`,
          [offerId, doc.id, data.usageCount || 0, firstUsedAt, lastUsedAt]
        );
        migrated++;
      } catch (err) {
        errors++;
        if (errors <= 10) console.error(`  ERROR ${offerId}/${doc.id}: ${err.message}`);
      }
    }
  }

  console.log(`  customerOfferUsage done. Total: ${total}, Migrated: ${migrated}, Errors: ${errors}`);
  return { total, migrated, errors };
}

async function main() {
  console.log('=== Offers Backfill: Firestore → PG ===');
  if (dryRun) console.log('  (DRY RUN)');
  if (upsert) console.log('  (UPSERT mode)');
  if (filterRestaurant) console.log(`  Filtering: ${filterRestaurant}`);

  const r1 = await backfillOffers();
  const r2 = await backfillCustomerOfferUsage();

  const totalErrors = r1.errors + r2.errors;
  console.log(`\n=== Done. Offers: ${r1.migrated}, Usage: ${r2.migrated}, Errors: ${totalErrors} ===`);

  if (!dryRun) {
    const pgOffers = await query('SELECT COUNT(*) as c FROM offers');
    const pgUsage = await query('SELECT COUNT(*) as c FROM customer_offer_usage');
    console.log(`PG offers: ${pgOffers.rows[0].c}, customer_offer_usage: ${pgUsage.rows[0].c}`);
  }

  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
