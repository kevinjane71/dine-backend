/**
 * backfill-corporate-fcm-pg.js — one-time Firestore→PG migration for the
 * collections newly mapped in the B2/B3/S2 cutover fix:
 *   B3: corporateClients, corporateSites, employees, mealPeriods, mealBookings, mealConsumptions
 *   B2: fcmTokens, staffFcmTokens  (subcollections of restaurants/{id})
 *   S2: restaurants.categories  (copied out of extra_data into the new column)
 *
 * Reads raw Firestore, writes through the pgAdapter (which now routes these to PG
 * via the added registry entries). Idempotent upsert — safe to re-run (e.g. a
 * final re-sync at deploy time to catch writes made while old code was still live).
 *
 * Usage:
 *   node scripts/backfill-corporate-fcm-pg.js --dry-run
 *   node scripts/backfill-corporate-fcm-pg.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
if (!process.env.DATABASE_URL) { console.error('ERROR: DATABASE_URL not set.'); process.exit(1); }

const fb = require('../firebase');
const pgDb = fb.db;                                        // pgAdapter-backed (routes mapped collections → PG)
const fsdb = fb.getFirestoreDb ? fb.getFirestoreDb() : null; // raw Firestore ('dine')
const { query } = require('../repos/pgClient');
if (!fsdb) { console.error('ERROR: getFirestoreDb() unavailable.'); process.exit(1); }

const DRY = process.argv.includes('--dry-run');
const TOP_LEVEL = ['corporateClients', 'corporateSites', 'employees', 'mealPeriods', 'mealBookings', 'mealConsumptions'];

async function migrateTopLevel() {
  for (const name of TOP_LEVEL) {
    const snap = await fsdb.collection(name).get();
    let ok = 0, err = 0;
    for (const doc of snap.docs) {
      if (DRY) { ok++; continue; }
      try { await pgDb.collection(name).doc(doc.id).set(doc.data()); ok++; }
      catch (e) { err++; console.error(`  ✗ ${name}/${doc.id}: ${e.message}`); }
    }
    console.log(`[${name}] Firestore=${snap.size} → PG wrote=${ok} errors=${err}`);
  }
}

async function migrateFcm() {
  for (const sub of ['fcmTokens', 'staffFcmTokens']) {
    const snap = await fsdb.collectionGroup(sub).get();
    let ok = 0, err = 0, noRid = 0;
    for (const t of snap.docs) {
      const rid = t.ref.parent.parent && t.ref.parent.parent.id;
      if (!rid) { noRid++; continue; }
      if (DRY) { ok++; continue; }
      try { await pgDb.collection('restaurants').doc(rid).collection(sub).doc(t.id).set(t.data()); ok++; }
      catch (e) { err++; console.error(`  ✗ ${sub} ${rid}/${t.id}: ${e.message}`); }
    }
    console.log(`[${sub}] Firestore=${snap.size} → PG wrote=${ok} errors=${err} noRestaurantId=${noRid}`);
  }
}

async function migrateCategories() {
  if (DRY) {
    const r = await query("SELECT count(*) c FROM restaurants WHERE extra_data ? 'categories'", []);
    console.log(`[categories] ${r.rows[0].c} restaurants have categories in extra_data (would copy → column)`);
    return;
  }
  const r = await query(
    "UPDATE restaurants SET categories = extra_data->'categories' WHERE extra_data ? 'categories' AND categories IS NULL",
    []
  );
  console.log(`[categories] copied extra_data.categories → column for ${r.rowCount} restaurants`);
}

(async () => {
  console.log(DRY ? '=== DRY RUN (no writes) ===' : '=== LIVE MIGRATION ===');
  await migrateTopLevel();
  await migrateFcm();
  await migrateCategories();
  console.log('\n✓ migration complete');
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
