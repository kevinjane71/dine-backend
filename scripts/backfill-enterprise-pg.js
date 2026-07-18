/**
 * backfill-enterprise-pg.js — Backfill 8 enterprise/org Firestore collections to PG.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
 *   node scripts/backfill-enterprise-pg.js [--upsert] [--dry-run] [--collection NAME]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

if (!admin.apps.find(a => a && a.name === 'backfill-enterprise')) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  }, 'backfill-enterprise');
}

const app = admin.app('backfill-enterprise');
const db = getFirestore(app, 'dine'); // named 'dine' DB, not (default)
db.settings({ databaseId: 'dine', ignoreUndefinedProperties: true });

const { query, getPool } = require('../repos/pgClient');
const { buildUpsert, buildInsert } = require('../repos/queryBuilder');
const {
  orgToPgRow, ORG_JSONB_COLUMNS,
  menuTemplateToPgRow, MENU_TEMPLATE_JSONB_COLUMNS,
  menuItemToPgRow, MENU_ITEM_JSONB_COLUMNS,
  indentToPgRow, INDENT_JSONB_COLUMNS,
  productionOrderToPgRow, PRODUCTION_ORDER_JSONB_COLUMNS,
  distributionPlanToPgRow, DISTRIBUTION_PLAN_JSONB_COLUMNS,
  orgSettingsToPgRow, ORG_SETTINGS_JSONB_COLUMNS,
  auditLogToPgRow, AUDIT_LOG_JSONB_COLUMNS,
} = require('../repos/enterpriseFieldMapper');

const args = process.argv.slice(2);
const upsertMode = args.includes('--upsert');
const dryRun = args.includes('--dry-run');
const collectionFilter = args.includes('--collection') ? args[args.indexOf('--collection') + 1] : null;

const BATCH_SIZE = 200;

const COLLECTIONS = [
  { name: 'organizations', table: 'ent_organizations', toPgRow: orgToPgRow, jsonbCols: ORG_JSONB_COLUMNS },
  { name: 'orgMenuTemplates', table: 'org_menu_templates', toPgRow: menuTemplateToPgRow, jsonbCols: MENU_TEMPLATE_JSONB_COLUMNS },
  { name: 'orgMenuItems', table: 'org_menu_items', toPgRow: menuItemToPgRow, jsonbCols: MENU_ITEM_JSONB_COLUMNS },
  { name: 'indentRequests', table: 'indent_requests', toPgRow: indentToPgRow, jsonbCols: INDENT_JSONB_COLUMNS },
  { name: 'productionOrders', table: 'production_orders', toPgRow: productionOrderToPgRow, jsonbCols: PRODUCTION_ORDER_JSONB_COLUMNS },
  { name: 'distributionPlans', table: 'distribution_plans', toPgRow: distributionPlanToPgRow, jsonbCols: DISTRIBUTION_PLAN_JSONB_COLUMNS },
  { name: 'orgSettings', table: 'org_settings', toPgRow: orgSettingsToPgRow, jsonbCols: ORG_SETTINGS_JSONB_COLUMNS },
  { name: 'orgAuditLog', table: 'org_audit_log', toPgRow: auditLogToPgRow, jsonbCols: AUDIT_LOG_JSONB_COLUMNS },
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
  console.log(`Backfill enterprise collections → PG (upsert=${upsertMode}, dryRun=${dryRun})`);
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
