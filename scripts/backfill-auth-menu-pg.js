/**
 * backfill-auth-menu-pg.js — Backfill Auth/Menu/User Firestore collections to PG.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   node scripts/backfill-auth-menu-pg.js [--upsert] [--dry-run] [--collection NAME]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.apps.find(a => a && a.name === 'backfill-auth-menu')) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  }, 'backfill-auth-menu');
}

const app = admin.app('backfill-auth-menu');
const db = getFirestore(app, 'dine'); // named 'dine' DB, not (default)
db.settings({ databaseId: 'dine', ignoreUndefinedProperties: true });

const { query, getPool } = require('../repos/pgClient');
const { buildUpsert, buildInsert } = require('../repos/queryBuilder');
const {
  menuToPgRow, MENU_JSONB_COLUMNS,
  menuItemToPgRow, MENU_ITEM_JSONB_COLUMNS,
  appUserToPgRow, APP_USER_JSONB_COLUMNS,
  userRestaurantToPgRow, USER_RESTAURANT_JSONB_COLUMNS,
  staffCredentialToPgRow, STAFF_CREDENTIAL_JSONB_COLUMNS,
  dineUserDataToPgRow, DINE_USER_DATA_JSONB_COLUMNS,
} = require('../repos/authMenuFieldMapper');

const args = process.argv.slice(2);
const upsertMode = args.includes('--upsert');
const dryRun = args.includes('--dry-run');
const collectionFilter = args.includes('--collection') ? args[args.indexOf('--collection') + 1] : null;

const BATCH_SIZE = 200;

const COLLECTIONS = [
  { name: 'menus', table: 'menus', toPgRow: menuToPgRow, jsonbCols: MENU_JSONB_COLUMNS },
  { name: 'menuItems', table: 'menu_items', toPgRow: menuItemToPgRow, jsonbCols: MENU_ITEM_JSONB_COLUMNS },
  { name: 'users', table: 'app_users', toPgRow: appUserToPgRow, jsonbCols: APP_USER_JSONB_COLUMNS, hasOrigin: true },
  { name: 'userRestaurants', table: 'user_restaurants', toPgRow: userRestaurantToPgRow, jsonbCols: USER_RESTAURANT_JSONB_COLUMNS },
  { name: 'staffCredentials', table: 'staff_credentials', toPgRow: staffCredentialToPgRow, jsonbCols: STAFF_CREDENTIAL_JSONB_COLUMNS },
  { name: 'dine_user_data', table: 'dine_user_data', toPgRow: dineUserDataToPgRow, jsonbCols: DINE_USER_DATA_JSONB_COLUMNS },
];

async function backfillCollection({ name, table, toPgRow, jsonbCols, hasOrigin }) {
  console.log(`\n── Backfilling ${name} → ${table} ──`);

  let totalDocs = 0;
  let totalErrors = 0;
  let lastDoc = null;

  while (true) {
    let q = db.collection(name).orderBy('__name__').limit(BATCH_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      totalDocs++;
      lastDoc = doc;

      try {
        const data = doc.data();
        const pgRow = toPgRow({ id: doc.id, ...data });
        if (!pgRow.id) pgRow.id = doc.id;
        // Label this synced row as Firestore-origin (the app defaults new rows to
        // 'native'); the guard below then stops the sync from ever overwriting a native row.
        if (hasOrigin) pgRow.origin = 'firestore';

        if (dryRun) {
          if (totalDocs <= 3) console.log(`  [dry-run] ${doc.id}:`, JSON.stringify(pgRow).slice(0, 200));
          continue;
        }

        const qObj = upsertMode
          ? buildUpsert(table, pgRow, jsonbCols, ['id'], hasOrigin ? { conflictWhere: `${table}.origin IS DISTINCT FROM 'native'` } : {})
          : buildInsert(table, pgRow, jsonbCols);

        await query(qObj.text, qObj.values);
      } catch (err) {
        totalErrors++;
        console.error(`  ERROR ${doc.id}: ${err.message}`);
      }
    }

    if (snap.docs.length < BATCH_SIZE) break;
  }

  console.log(`  ${name}: ${totalDocs} docs, ${totalErrors} errors`);
  return { name, totalDocs, totalErrors };
}

async function main() {
  console.log(`Backfill Auth/Menu collections → PG (upsert=${upsertMode}, dryRun=${dryRun})`);
  if (collectionFilter) console.log(`  Filtered to: ${collectionFilter}`);

  const targets = collectionFilter
    ? COLLECTIONS.filter(c => c.name === collectionFilter || c.table === collectionFilter)
    : COLLECTIONS;

  if (targets.length === 0) {
    console.error('No matching collections found for filter:', collectionFilter);
    process.exit(1);
  }

  const results = [];
  for (const col of targets) {
    results.push(await backfillCollection(col));
  }

  console.log('\n── Summary ──');
  let grandTotal = 0;
  let grandErrors = 0;
  for (const r of results) {
    console.log(`  ${r.name}: ${r.totalDocs} docs, ${r.totalErrors} errors`);
    grandTotal += r.totalDocs;
    grandErrors += r.totalErrors;
  }
  console.log(`\n  TOTAL: ${grandTotal} docs, ${grandErrors} errors`);

  await getPool().end();
  process.exit(grandErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
