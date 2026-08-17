#!/usr/bin/env node
/**
 * backfill-generic-passthrough-pg.js — Sync the generic "passthrough" Firestore
 * collections that have NO dedicated field-mapper backfill script, so the
 * repeatable resync (resync-all-pg.sh) actually covers 100% of the DB.
 *
 * Covers: dineai_conversations, desktop_auth_sessions, adminTasks, sub_admins,
 *         waitlist, wa_agent_state (generic id/restaurant_id/extra_data tables)
 *         + printDiagnostics (its own field-mapped table).
 *
 * Reads each collection from raw Firestore and writes through the pgAdapter
 * (`db.collection(name).doc(id).set(...)`), so each collection's registry mapper
 * (genericPack / printDiagnosticsFieldMapper) packs it exactly as the app expects.
 * Idempotent upsert — safe to run repeatedly.
 *
 * Usage:
 *   node scripts/backfill-generic-passthrough-pg.js [--dry-run] [--upsert]
 */

require('dotenv').config({ path: '.env.local' });

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set — needed to reach Cloud SQL. Aborting.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

// firebase.js exposes the pgAdapter-backed `db` (DATABASE_URL is set) AND the raw
// Firestore handle via getFirestoreDb() — we read from Firestore, write to PG.
const fb = require('../firebase');
const pgDb = fb.db;
const fsdb = fb.getFirestoreDb ? fb.getFirestoreDb() : null;
const { query } = require('../repos/pgClient');

if (!fsdb) {
  console.error('ERROR: getFirestoreDb() unavailable — cannot read source Firestore. Aborting.');
  process.exit(1);
}

// Firestore collection names. All are mapped in collectionRegistry.js, so
// pgDb.collection(name) routes to PG (not the Firestore fallback).
const COLLECTIONS = [
  'dineai_conversations',
  'desktop_auth_sessions',
  'adminTasks',
  'sub_admins',
  'waitlist',
  'wa_agent_state',
  'printDiagnostics',
];

// wa_agent_state is newly mapped — make sure its generic table exists (the other
// generic tables were created in the July DDL). Generic shape mirrors the others.
async function ensureNewTables() {
  await query(`CREATE TABLE IF NOT EXISTS wa_agent_state (
    id TEXT PRIMARY KEY,
    restaurant_id TEXT,
    extra_data JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

async function backfill(name) {
  const snap = await fsdb.collection(name).get();
  console.log(`\n--- ${name}: ${snap.size} docs ---`);
  let ok = 0, err = 0;
  for (const doc of snap.docs) {
    if (dryRun) { ok++; continue; }
    try {
      await pgDb.collection(name).doc(doc.id).set(doc.data(), { merge: true });
      ok++;
    } catch (e) {
      err++;
      console.error(`  ✗ ${name}/${doc.id}: ${e.message}`);
    }
  }
  console.log(`    ${err ? '⚠' : '✓'} ${ok} upserted${err ? `, ${err} error(s)` : ''}`);
  return { ok, err };
}

(async () => {
  console.log('=== Generic passthrough backfill (Firestore → PostgreSQL) ===' + (dryRun ? '  [DRY RUN — no writes]' : ''));
  if (!dryRun) await ensureNewTables();

  let totalOk = 0, totalErr = 0;
  const failed = [];
  for (const name of COLLECTIONS) {
    try {
      const r = await backfill(name);
      totalOk += r.ok; totalErr += r.err;
      if (r.err) failed.push(name);
    } catch (e) {
      console.error(`  ✗ ${name} FAILED entirely: ${e.message}`);
      failed.push(name);
    }
  }

  console.log('\n===================================================================');
  console.log(` Done: ${totalOk} docs upserted across ${COLLECTIONS.length} collections` + (totalErr ? `, ${totalErr} doc error(s)` : ''));
  if (failed.length) console.log(` Collections with errors: ${failed.join(', ')}`);
  console.log('===================================================================');
  process.exit(totalErr ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
