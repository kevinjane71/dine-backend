/**
 * backfill-ai-automation-pg.js — Backfill Phase 9 AI/Automation/Misc Firestore collections to PG.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
 *   node scripts/backfill-ai-automation-pg.js [--upsert] [--dry-run] [--collection NAME]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const admin = require('firebase-admin');

if (!admin.apps.find(a => a && a.name === 'backfill-ai-automation')) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  }, 'backfill-ai-automation');
}

const app = admin.app('backfill-ai-automation');
const db = app.firestore();
db.settings({ databaseId: 'dine', ignoreUndefinedProperties: true });

const { query, getPool } = require('../repos/pgClient');
const { buildUpsert, buildInsert } = require('../repos/queryBuilder');
const {
  bolnaAgentToPgRow, BOLNA_AGENT_JSONB_COLUMNS,
  phoneCallToPgRow, PHONE_CALL_JSONB_COLUMNS,
  dineaiSettingsToPgRow, DINEAI_SETTINGS_JSONB_COLUMNS,
  dineaiUsageToPgRow, DINEAI_USAGE_JSONB_COLUMNS,
  dineaiKnowledgeToPgRow, DINEAI_KNOWLEDGE_JSONB_COLUMNS,
  dineaiRtSessionToPgRow, DINEAI_RT_SESSION_JSONB_COLUMNS,
  dineaiRtFuncCallToPgRow, DINEAI_RT_FUNC_CALL_JSONB_COLUMNS,
  dineaiCheapSessionToPgRow, DINEAI_CHEAP_SESSION_JSONB_COLUMNS,
  chatgptUsageToPgRow, CHATGPT_USAGE_JSONB_COLUMNS,
  aiUsageToPgRow, AI_USAGE_JSONB_COLUMNS,
  aiInsightsUsageToPgRow, AI_INSIGHTS_USAGE_JSONB_COLUMNS,
  googleReviewSettingsToPgRow, GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS,
  googleReviewsCacheToPgRow, GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS,
  googleBizTokensToPgRow, GOOGLE_BIZ_TOKENS_JSONB_COLUMNS,
  whatsappConfigToPgRow, WHATSAPP_CONFIG_JSONB_COLUMNS,
  whatsappLogToPgRow, WHATSAPP_LOG_JSONB_COLUMNS,
  automationToPgRow, AUTOMATION_JSONB_COLUMNS,
  automationTemplateToPgRow, AUTOMATION_TEMPLATE_JSONB_COLUMNS,
  automationSettingsToPgRow, AUTOMATION_SETTINGS_JSONB_COLUMNS,
  automationLogToPgRow, AUTOMATION_LOG_JSONB_COLUMNS,
} = require('../repos/aiAutomationFieldMapper');

const args = process.argv.slice(2);
const upsertMode = args.includes('--upsert');
const dryRun = args.includes('--dry-run');
const collectionFilter = args.includes('--collection') ? args[args.indexOf('--collection') + 1] : null;

const BATCH_SIZE = 200;

const COLLECTIONS = [
  { name: 'bolnaAgents', table: 'bolna_agents', toPgRow: bolnaAgentToPgRow, jsonbCols: BOLNA_AGENT_JSONB_COLUMNS },
  { name: 'phoneCalls', table: 'phone_calls', toPgRow: phoneCallToPgRow, jsonbCols: PHONE_CALL_JSONB_COLUMNS },
  { name: 'dineai_settings', table: 'dineai_settings', toPgRow: dineaiSettingsToPgRow, jsonbCols: DINEAI_SETTINGS_JSONB_COLUMNS },
  { name: 'dineai_usage', table: 'dineai_usage', toPgRow: dineaiUsageToPgRow, jsonbCols: DINEAI_USAGE_JSONB_COLUMNS },
  { name: 'dineai_knowledge', table: 'dineai_knowledge', toPgRow: dineaiKnowledgeToPgRow, jsonbCols: DINEAI_KNOWLEDGE_JSONB_COLUMNS },
  { name: 'dineai_realtime_sessions', table: 'dineai_realtime_sessions', toPgRow: dineaiRtSessionToPgRow, jsonbCols: DINEAI_RT_SESSION_JSONB_COLUMNS },
  // subcollection handled separately below
  { name: 'dineai_cheap_sessions', table: 'dineai_cheap_sessions', toPgRow: dineaiCheapSessionToPgRow, jsonbCols: DINEAI_CHEAP_SESSION_JSONB_COLUMNS },
  { name: 'chatgptUsage', table: 'chatgpt_usage', toPgRow: chatgptUsageToPgRow, jsonbCols: CHATGPT_USAGE_JSONB_COLUMNS },
  { name: 'aiUsage', table: 'ai_usage', toPgRow: aiUsageToPgRow, jsonbCols: AI_USAGE_JSONB_COLUMNS },
  { name: 'aiInsightsUsage', table: 'ai_insights_usage', toPgRow: aiInsightsUsageToPgRow, jsonbCols: AI_INSIGHTS_USAGE_JSONB_COLUMNS },
  { name: 'googleReviewSettings', table: 'google_review_settings', toPgRow: googleReviewSettingsToPgRow, jsonbCols: GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS },
  { name: 'googleReviewsCache', table: 'google_reviews_cache', toPgRow: googleReviewsCacheToPgRow, jsonbCols: GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS },
  { name: 'googleBusinessTokens', table: 'google_business_tokens', toPgRow: googleBizTokensToPgRow, jsonbCols: GOOGLE_BIZ_TOKENS_JSONB_COLUMNS },
  { name: 'whatsappOrderingConfig', table: 'whatsapp_ordering_config', toPgRow: whatsappConfigToPgRow, jsonbCols: WHATSAPP_CONFIG_JSONB_COLUMNS },
  { name: 'whatsappConversationLogs', table: 'whatsapp_conversation_logs', toPgRow: whatsappLogToPgRow, jsonbCols: WHATSAPP_LOG_JSONB_COLUMNS },
  { name: 'automations', table: 'automations', toPgRow: automationToPgRow, jsonbCols: AUTOMATION_JSONB_COLUMNS },
  { name: 'automation-templates', table: 'automation_templates', toPgRow: automationTemplateToPgRow, jsonbCols: AUTOMATION_TEMPLATE_JSONB_COLUMNS },
  { name: 'automation-settings', table: 'automation_settings', toPgRow: automationSettingsToPgRow, jsonbCols: AUTOMATION_SETTINGS_JSONB_COLUMNS },
  { name: 'automation-logs', table: 'automation_logs', toPgRow: automationLogToPgRow, jsonbCols: AUTOMATION_LOG_JSONB_COLUMNS },
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

// Backfill subcollection: dineai_realtime_sessions/{sessionId}/function_calls
async function backfillRealtimeFunctionCalls() {
  const name = 'dineai_realtime_sessions/*/function_calls';
  const table = 'dineai_realtime_function_calls';
  console.log(`\n── Backfilling ${name} → ${table} ──`);

  let totalDocs = 0;
  let totalErrors = 0;

  // First get all session docs
  let lastSessionDoc = null;
  while (true) {
    let q = db.collection('dineai_realtime_sessions').orderBy('__name__').limit(BATCH_SIZE);
    if (lastSessionDoc) q = q.startAfter(lastSessionDoc);

    const sessionSnap = await q.get();
    if (sessionSnap.empty) break;

    for (const sessionDoc of sessionSnap.docs) {
      lastSessionDoc = sessionDoc;
      const sessionId = sessionDoc.id;

      // Get all function_calls for this session
      const funcSnap = await db.collection('dineai_realtime_sessions').doc(sessionId).collection('function_calls').get();

      for (const funcDoc of funcSnap.docs) {
        totalDocs++;
        try {
          const data = funcDoc.data();
          const pgRow = dineaiRtFuncCallToPgRow({ id: funcDoc.id, sessionId, ...data });
          if (!pgRow.id) pgRow.id = funcDoc.id;

          if (dryRun) {
            if (totalDocs <= 3) console.log(`  [dry-run] ${sessionId}/${funcDoc.id}:`, JSON.stringify(pgRow).slice(0, 200));
            continue;
          }

          const qObj = upsertMode
            ? buildUpsert(table, pgRow, DINEAI_RT_FUNC_CALL_JSONB_COLUMNS)
            : buildInsert(table, pgRow, DINEAI_RT_FUNC_CALL_JSONB_COLUMNS);

          await query(qObj.text, qObj.values);
        } catch (err) {
          totalErrors++;
          console.error(`  ERROR ${sessionId}/${funcDoc.id}: ${err.message}`);
        }
      }
    }

    if (sessionSnap.docs.length < BATCH_SIZE) break;
  }

  console.log(`  ${name}: ${totalDocs} docs, ${totalErrors} errors`);
  return { name, totalDocs, totalErrors };
}

async function main() {
  console.log(`Backfill AI/Automation collections → PG (upsert=${upsertMode}, dryRun=${dryRun})`);
  if (collectionFilter) console.log(`  Filtered to: ${collectionFilter}`);

  const targets = collectionFilter
    ? COLLECTIONS.filter(c => c.name === collectionFilter || c.table === collectionFilter)
    : COLLECTIONS;

  if (targets.length === 0 && collectionFilter !== 'dineai_realtime_function_calls') {
    console.error('No matching collections found for filter:', collectionFilter);
    process.exit(1);
  }

  const results = [];
  for (const col of targets) {
    results.push(await backfillCollection(col));
  }

  // Backfill subcollection if no filter or specifically requested
  if (!collectionFilter || collectionFilter === 'dineai_realtime_function_calls') {
    results.push(await backfillRealtimeFunctionCalls());
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
