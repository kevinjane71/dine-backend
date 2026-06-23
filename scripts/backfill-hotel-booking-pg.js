#!/usr/bin/env node
/**
 * backfill-hotel-booking-pg.js — Migrate hotel, PMS, and booking collections
 * from Firestore -> PG.
 *
 * Usage:
 *   node scripts/backfill-hotel-booking-pg.js [--dry-run] [--upsert] [--collection <name>]
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
}, 'backfill-hotel-booking');
const db = getFirestore(app, 'dine');

const { query } = require('../repos/pgClient');
const {
  roomToPgRow, ROOM_JSONB_COLUMNS,
  hotelBookingToPgRow, HOTEL_BOOKING_JSONB_COLUMNS,
  hotelCheckinToPgRow, HOTEL_CHECKIN_JSONB_COLUMNS,
  hotelGuestToPgRow, HOTEL_GUEST_JSONB_COLUMNS,
  roomMaintenanceToPgRow, ROOM_MAINTENANCE_JSONB_COLUMNS,
  pmsRoomToPgRow, PMS_ROOM_JSONB_COLUMNS,
  pmsBookingToPgRow, PMS_BOOKING_JSONB_COLUMNS,
  pmsGuestToPgRow, PMS_GUEST_JSONB_COLUMNS,
  pmsHousekeepingToPgRow, PMS_HOUSEKEEPING_JSONB_COLUMNS,
  pmsMaintenanceToPgRow, PMS_MAINTENANCE_JSONB_COLUMNS,
  bookingsV2ToPgRow, BOOKINGS_V2_JSONB_COLUMNS,
  bookingVenueToPgRow, BOOKING_VENUE_JSONB_COLUMNS,
  legacyBookingToPgRow, LEGACY_BOOKING_JSONB_COLUMNS,
} = require('../repos/hotelBookingFieldMapper');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const upsert = args.includes('--upsert');
const collectionIdx = args.indexOf('--collection');
const filterCollection = collectionIdx >= 0 ? args[collectionIdx + 1] : null;

const BATCH_SIZE = 200;

async function backfillCollection(collectionName, pgTable, toPgRowFn, jsonbCols) {
  console.log(`\n--- ${collectionName} -> ${pgTable} ---`);
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
          if (total <= 5) console.log(`  [DRY RUN] ${doc.id}`);
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
  console.log('=== Hotel + Booking Backfill: Firestore -> PG ===');
  if (dryRun) console.log('  (DRY RUN)');
  if (upsert) console.log('  (UPSERT mode)');

  let totalErrors = 0;

  const collections = [
    // Hotel core
    { name: 'rooms',                       table: 'hotel_rooms',                fn: roomToPgRow,              jsonb: ROOM_JSONB_COLUMNS },
    { name: 'hotel_bookings',              table: 'hotel_bookings',             fn: hotelBookingToPgRow,      jsonb: HOTEL_BOOKING_JSONB_COLUMNS },
    { name: 'hotel_checkins',              table: 'hotel_checkins',             fn: hotelCheckinToPgRow,      jsonb: HOTEL_CHECKIN_JSONB_COLUMNS },
    { name: 'hotel_guests',                table: 'hotel_guests',               fn: hotelGuestToPgRow,        jsonb: HOTEL_GUEST_JSONB_COLUMNS },
    { name: 'room_maintenance_schedules',  table: 'room_maintenance_schedules', fn: roomMaintenanceToPgRow,   jsonb: ROOM_MAINTENANCE_JSONB_COLUMNS },
    // PMS
    { name: 'pms-rooms',                   table: 'pms_rooms',                  fn: pmsRoomToPgRow,           jsonb: PMS_ROOM_JSONB_COLUMNS },
    { name: 'pms-bookings',                table: 'pms_bookings',               fn: pmsBookingToPgRow,        jsonb: PMS_BOOKING_JSONB_COLUMNS },
    { name: 'pms-guests',                  table: 'pms_guests',                 fn: pmsGuestToPgRow,          jsonb: PMS_GUEST_JSONB_COLUMNS },
    { name: 'pms-housekeeping',            table: 'pms_housekeeping',           fn: pmsHousekeepingToPgRow,   jsonb: PMS_HOUSEKEEPING_JSONB_COLUMNS },
    { name: 'pms-maintenance',             table: 'pms_maintenance',            fn: pmsMaintenanceToPgRow,    jsonb: PMS_MAINTENANCE_JSONB_COLUMNS },
    // Bookings
    { name: 'bookings_v2',                 table: 'bookings_v2',                fn: bookingsV2ToPgRow,        jsonb: BOOKINGS_V2_JSONB_COLUMNS },
    { name: 'booking_venues',              table: 'booking_venues',             fn: bookingVenueToPgRow,      jsonb: BOOKING_VENUE_JSONB_COLUMNS },
    { name: 'bookingVenues',               table: 'booking_venues',             fn: bookingVenueToPgRow,      jsonb: BOOKING_VENUE_JSONB_COLUMNS },
    { name: 'bookings',                    table: 'legacy_bookings',            fn: legacyBookingToPgRow,     jsonb: LEGACY_BOOKING_JSONB_COLUMNS },
  ];

  for (const col of collections) {
    if (filterCollection && col.name !== filterCollection) continue;
    const result = await backfillCollection(col.name, col.table, col.fn, col.jsonb);
    totalErrors += result.errors;
  }

  if (!dryRun) {
    const tables = [
      'hotel_rooms', 'hotel_bookings', 'hotel_checkins', 'hotel_guests',
      'room_maintenance_schedules', 'pms_rooms', 'pms_bookings', 'pms_guests',
      'pms_housekeeping', 'pms_maintenance', 'bookings_v2', 'booking_venues', 'legacy_bookings'
    ];
    for (const t of tables) {
      const count = await query(`SELECT COUNT(*) as c FROM ${t}`);
      console.log(`PG ${t}: ${count.rows[0].c}`);
    }
  }

  console.log(`\n=== Done. Total errors: ${totalErrors} ===`);
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
