/**
 * backfill-invoice-pg.js — Backfill 10 inv_* Firestore collections to PostgreSQL.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
 *   node scripts/backfill-invoice-pg.js [--upsert] [--dry-run] [--collection NAME]
 *
 * Or with dotenv (auto-loads .env.local):
 *   node scripts/backfill-invoice-pg.js [--upsert]
 *
 * Collections: inv_organizations, inv_customers, inv_items, inv_invoices,
 *   inv_quotes, inv_challans, inv_payments, inv_expenses, inv_settings,
 *   inv_number_sequences
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const admin = require('firebase-admin');

// Initialize Firebase with env-based credentials (unique app name)
if (!admin.apps.find(a => a && a.name === 'backfill-invoice')) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  }, 'backfill-invoice');
}

const app = admin.app('backfill-invoice');
const db = app.firestore();
db.settings({ databaseId: 'dine', ignoreUndefinedProperties: true });

const { query, getPool } = require('../repos/pgClient');
const { buildUpsert, buildInsert } = require('../repos/queryBuilder');
const {
  orgToPgRow, ORG_JSONB_COLUMNS,
  customerToPgRow, CUSTOMER_JSONB_COLUMNS,
  itemToPgRow, ITEM_JSONB_COLUMNS,
  invoiceToPgRow, INVOICE_JSONB_COLUMNS,
  quoteToPgRow, QUOTE_JSONB_COLUMNS,
  challanToPgRow, CHALLAN_JSONB_COLUMNS,
  paymentToPgRow, PAYMENT_JSONB_COLUMNS,
  expenseToPgRow, EXPENSE_JSONB_COLUMNS,
  settingsToPgRow, SETTINGS_JSONB_COLUMNS,
  numberSeqToPgRow, NUMBER_SEQ_JSONB_COLUMNS,
} = require('../repos/invoiceFieldMapper');

const args = process.argv.slice(2);
const upsertMode = args.includes('--upsert');
const dryRun = args.includes('--dry-run');
const collectionFilter = args.includes('--collection') ? args[args.indexOf('--collection') + 1] : null;

const BATCH_SIZE = 200;

const COLLECTIONS = [
  { name: 'inv_organizations', table: 'inv_organizations', toPgRow: orgToPgRow, jsonbCols: ORG_JSONB_COLUMNS },
  { name: 'inv_customers', table: 'inv_customers', toPgRow: customerToPgRow, jsonbCols: CUSTOMER_JSONB_COLUMNS },
  { name: 'inv_items', table: 'inv_items', toPgRow: itemToPgRow, jsonbCols: ITEM_JSONB_COLUMNS },
  { name: 'inv_invoices', table: 'inv_invoices', toPgRow: invoiceToPgRow, jsonbCols: INVOICE_JSONB_COLUMNS },
  { name: 'inv_quotes', table: 'inv_quotes', toPgRow: quoteToPgRow, jsonbCols: QUOTE_JSONB_COLUMNS },
  { name: 'inv_challans', table: 'inv_challans', toPgRow: challanToPgRow, jsonbCols: CHALLAN_JSONB_COLUMNS },
  { name: 'inv_payments', table: 'inv_payments', toPgRow: paymentToPgRow, jsonbCols: PAYMENT_JSONB_COLUMNS },
  { name: 'inv_expenses', table: 'inv_expenses', toPgRow: expenseToPgRow, jsonbCols: EXPENSE_JSONB_COLUMNS },
  { name: 'inv_settings', table: 'inv_settings', toPgRow: settingsToPgRow, jsonbCols: SETTINGS_JSONB_COLUMNS },
  { name: 'inv_number_sequences', table: 'inv_number_sequences', toPgRow: numberSeqToPgRow, jsonbCols: NUMBER_SEQ_JSONB_COLUMNS },
];

async function backfillCollection({ name, table, toPgRow, jsonbCols }) {
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

        if (dryRun) {
          if (totalDocs <= 3) console.log(`  [dry-run] ${doc.id}:`, JSON.stringify(pgRow).slice(0, 200));
          continue;
        }

        const qObj = upsertMode
          ? buildUpsert(table, pgRow, jsonbCols)
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
  console.log(`Backfill invoice collections → PG (upsert=${upsertMode}, dryRun=${dryRun})`);
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
