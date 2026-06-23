#!/usr/bin/env node
/**
 * backfill-register-pg.js — Migrate cashRegisters, shifts, restaurantShiftSettings,
 * staffShifts, staffAvailability from Firestore → PG.
 *
 * Usage:
 *   node scripts/backfill-register-pg.js [--dry-run] [--upsert] [--collection <name>]
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
}, 'backfill-register');
const db = getFirestore(app, 'dine');

const { query } = require('../repos/pgClient');
const {
  registerToPgRow, REGISTER_JSONB_COLUMNS,
  shiftToPgRow, SHIFT_JSONB_COLUMNS,
  shiftSettingsToPgRow, SHIFT_SETTINGS_JSONB_COLUMNS,
  staffShiftToPgRow, STAFF_SHIFT_JSONB_COLUMNS,
  staffAvailToPgRow, STAFF_AVAIL_JSONB_COLUMNS,
} = require('../repos/registerFieldMapper');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const upsert = args.includes('--upsert');
const collectionIdx = args.indexOf('--collection');
const filterCollection = collectionIdx >= 0 ? args[collectionIdx + 1] : null;

const BATCH_SIZE = 200;

async function backfillCollection(collectionName, pgTable, toPgRowFn, jsonbCols) {
  console.log(`\n--- ${collectionName} → ${pgTable} ---`);
  let total = 0, migrated = 0, errors = 0;
  let lastDocId = null;

  while (true) {
    let q = db.collection(collectionName).orderBy('__name__').limit(BATCH_SIZE);
    if (lastDocId) {
      const lastDoc = await db.collection(collectionName).doc(lastDocId).get();
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
        const pgRow = toPgRowFn({ id: doc.id, ...data });
        if (!pgRow.id) pgRow.id = doc.id;

        if (dryRun) {
          if (total <= 5) console.log(`  [DRY RUN] ${doc.id}: status=${pgRow.status || 'n/a'}`);
          migrated++;
          continue;
        }

        const cols = Object.keys(pgRow);
        const placeholders = cols.map((c, i) =>
          jsonbCols.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
        ).join(', ');
        const values = cols.map(c =>
          jsonbCols.has(c) && pgRow[c] !== null && pgRow[c] !== undefined
            ? JSON.stringify(pgRow[c]) : pgRow[c]
        );

        if (upsert) {
          const updateCols = cols.filter(c => c !== 'id');
          await query(
            `INSERT INTO ${pgTable} (${cols.join(', ')}) VALUES (${placeholders})
             ON CONFLICT (id) DO UPDATE SET ${updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}`,
            values
          );
        } else {
          await query(
            `INSERT INTO ${pgTable} (${cols.join(', ')}) VALUES (${placeholders})
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

    process.stdout.write(`\r  ${collectionName}: ${total}, Migrated: ${migrated}, Errors: ${errors}`);
    if (snap.docs.length < BATCH_SIZE) break;
  }

  console.log(`\n  Done. Total: ${total}, Migrated: ${migrated}, Errors: ${errors}`);
  return { total, migrated, errors };
}

async function main() {
  console.log('=== Register + Shifts Backfill: Firestore → PG ===');
  if (dryRun) console.log('  (DRY RUN)');
  if (upsert) console.log('  (UPSERT mode)');
  if (filterCollection) console.log(`  Filtering: ${filterCollection}`);

  let totalErrors = 0;

  const collections = [
    { name: 'cashRegisters',           table: 'cash_registers',           fn: registerToPgRow,       jsonb: REGISTER_JSONB_COLUMNS },
    { name: 'shifts',                  table: 'shifts',                   fn: shiftToPgRow,          jsonb: SHIFT_JSONB_COLUMNS },
    { name: 'restaurantShiftSettings', table: 'restaurant_shift_settings', fn: shiftSettingsToPgRow,  jsonb: SHIFT_SETTINGS_JSONB_COLUMNS },
    { name: 'staffShifts',             table: 'staff_shifts',             fn: staffShiftToPgRow,     jsonb: STAFF_SHIFT_JSONB_COLUMNS },
    { name: 'staffAvailability',       table: 'staff_availability',       fn: staffAvailToPgRow,     jsonb: STAFF_AVAIL_JSONB_COLUMNS },
  ];

  for (const col of collections) {
    if (filterCollection && col.name !== filterCollection) continue;
    const result = await backfillCollection(col.name, col.table, col.fn, col.jsonb);
    totalErrors += result.errors;
  }

  if (!dryRun) {
    for (const col of collections) {
      if (filterCollection && col.name !== filterCollection) continue;
      const count = await query(`SELECT COUNT(*) as c FROM ${col.table}`);
      console.log(`PG ${col.table}: ${count.rows[0].c}`);
    }
  }

  console.log(`\n=== Done. Total errors: ${totalErrors} ===`);
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
