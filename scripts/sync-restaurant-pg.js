#!/usr/bin/env node
/**
 * sync-restaurant-pg.js — Sync ONE restaurant's data Firestore → PostgreSQL, generically.
 *
 * One tool for a per-restaurant migration/refresh: iterates every restaurant-scoped
 * collection in the collectionRegistry, reads the docs for this restaurant from Firestore,
 * and UPSERTs them into the matching PG table (using the registry's field mappers, so the
 * mapping stays identical to the live pgAdapter). Optional date range for incremental syncs.
 *
 * Safe: UPSERT only (no deletes/truncates). Never overwrites born-on-GCP rows — tables with an
 * `origin` column get a guard `origin IS DISTINCT FROM 'native'` on the ON CONFLICT DO UPDATE.
 *
 * Usage:
 *   node scripts/sync-restaurant-pg.js --restaurant=<RID> [options]
 *
 * Options:
 *   --restaurant=<RID>        (required) restaurant id to sync
 *   --since=YYYY-MM-DD        only docs with dateField >= since (docs without the field are kept)
 *   --until=YYYY-MM-DD        only docs with dateField <= until
 *   --date-field=<field>      date field to range-filter on (default: updatedAt, else createdAt)
 *   --collections=a,b,c       only these Firestore collections (default: all restaurant-scoped)
 *   --dry-run                 count only, no PG writes
 *
 * Examples:
 *   node scripts/sync-restaurant-pg.js --restaurant=bdBGprVGyBRpjfmvpIhm            # full sync
 *   node scripts/sync-restaurant-pg.js --restaurant=bdBG... --since=2026-08-01      # since Aug 1
 *   node scripts/sync-restaurant-pg.js --restaurant=bdBG... --collections=orders,payments --dry-run
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
// VM fallback: there is no .env.local on the VM — load env.json into process.env so the same
// script runs unchanged both locally and on the VM (where it's fastest: same region as Cloud SQL).
if (!process.env.DATABASE_URL) { try { Object.assign(process.env, require(require('path').join(__dirname, '..', 'env.json'))); } catch (_) {} }
const { getFirestoreDb } = require('../firebase');
const { getPool } = require('../repos/pgClient');
const REGISTRY = require('../repos/collectionRegistry');
const { buildUpsert } = require('../repos/queryBuilder');

const args = process.argv.slice(2);
const getArg = (name) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const RID = getArg('restaurant');
const SINCE = getArg('since') ? new Date(getArg('since') + 'T00:00:00.000Z') : null;
const UNTIL = getArg('until') ? new Date(getArg('until') + 'T23:59:59.999Z') : null;
const DATE_FIELD = getArg('date-field') || null; // null → try updatedAt then createdAt
const ONLY = getArg('collections') ? getArg('collections').split(',').map(s => s.trim()).filter(Boolean) : null;
const DRY = args.includes('--dry-run');
const CONC = Math.max(1, parseInt(getArg('concurrency') || '20', 10)); // parallel upserts — hides per-write latency
// Size the PG pool to the concurrency so the parallel upserts actually run in parallel (default max
// is 10). Kept modest so a sync never starves the live backend's connections on Cloud SQL.
if (!process.env.PG_POOL_MAX || parseInt(process.env.PG_POOL_MAX, 10) < CONC + 2) process.env.PG_POOL_MAX = String(CONC + 2);

if (!RID) { console.error('ERROR: --restaurant=<id> is required'); process.exit(1); }

// Tables whose native (born-on-GCP) rows must never be overwritten by a Firestore sync.
const ORIGIN_GUARDED_TABLES = new Set(['restaurants', 'app_users']);

// Collections handled by a dedicated backfill with special key/column mapping (identity mappers
// that don't snake-case restaurantId, composite keys, etc.). Run backfill-counters-pg.js for these.
const SKIP_COLLECTIONS = new Set(['order_id_counters', 'counters', 'orderNumberCounters']);

const toDate = (v) => {
  if (!v) return null;
  if (v.toDate) { try { return v.toDate(); } catch { return null; } }
  if (v instanceof Date) return v;
  if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? null : d; }
  if (v._seconds != null) return new Date(v._seconds * 1000);
  return null;
};

// Keep a doc if: no date range set, OR the doc has no usable date field, OR its date is in range.
const inDateRange = (data) => {
  if (!SINCE && !UNTIL) return true;
  const raw = DATE_FIELD ? data[DATE_FIELD] : (data.updatedAt ?? data.createdAt);
  const d = toDate(raw);
  if (!d) return true; // dateless (config/static) docs are always kept
  if (SINCE && d < SINCE) return false;
  if (UNTIL && d > UNTIL) return false;
  return true;
};

async function main() {
  const fsdb = getFirestoreDb();
  const pool = getPool();

  // Which collections to walk: caller subset, else every registry collection (the empty ones
  // for this restaurant are silently skipped). 'restaurants' first so FK parents exist.
  let names = ONLY || Object.keys(REGISTRY);
  names = ['restaurants', ...names.filter(n => n !== 'restaurants')];

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Per-restaurant Firestore → PostgreSQL sync              ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Restaurant:  ${RID}`);
  console.log(`Date range:  ${SINCE ? SINCE.toISOString().slice(0,10) : 'ALL'} → ${UNTIL ? UNTIL.toISOString().slice(0,10) : 'NOW'}${(SINCE||UNTIL)?` (on ${DATE_FIELD || 'updatedAt|createdAt'})`:''}`);
  console.log(`Mode:        ${DRY ? 'DRY RUN (no writes)' : 'LIVE UPSERT'}`);
  console.log(`Collections: ${ONLY ? ONLY.join(', ') : 'ALL restaurant-scoped'}\n`);

  let grandDocs = 0, grandWrote = 0, grandErr = 0;
  const done = new Set();

  for (const name of names) {
    const entry = REGISTRY[name];
    if (!entry || typeof entry.toPgRow !== 'function' || !entry.table) continue;
    if (SKIP_COLLECTIONS.has(name)) continue;
    if (done.has(name)) continue; done.add(name);

    // Fetch this restaurant's docs for the collection.
    let docs = [];
    try {
      if (name === 'restaurants') {
        const d = await fsdb.collection('restaurants').doc(RID).get();
        docs = d.exists ? [d] : [];
      } else {
        const snap = await fsdb.collection(name).where('restaurantId', '==', RID).get();
        docs = snap.docs;
      }
    } catch (e) {
      // A collection without a restaurantId field / no index just yields nothing — ignore.
      continue;
    }

    const picked = docs.filter(d => inDateRange(d.data()));
    if (picked.length === 0) continue;

    const guard = ORIGIN_GUARDED_TABLES.has(entry.table) ? `${entry.table}.origin IS DISTINCT FROM 'native'` : undefined;
    let wrote = 0, err = 0;
    // Upsert in parallel chunks so latency is overlapped (huge win from a laptop; still fast on the
    // VM). Each row still uses the battle-tested single-row buildUpsert — only the awaits parallelize.
    for (let i = 0; i < picked.length; i += CONC) {
      const chunk = picked.slice(i, i + CONC);
      const results = await Promise.all(chunk.map(async (d) => {
        try {
          const row = entry.toPgRow({ id: d.id, ...d.data() });
          if (!DRY) {
            const q = buildUpsert(entry.table, row, entry.jsonbCols || new Set(), ['id'], guard ? { conflictWhere: guard } : {});
            await pool.query(q.text, q.values);
          }
          return null;
        } catch (e) { return { id: d.id, msg: e.message }; }
      }));
      for (const r of results) {
        if (r) { err++; if (err <= 3) console.log(`   ⚠️ ${name}/${r.id}: ${r.msg}`); }
        else wrote++;
      }
    }
    grandDocs += picked.length; grandWrote += wrote; grandErr += err;
    console.log(`  ${DRY ? '•' : '✓'} ${name.padEnd(24)} → ${entry.table.padEnd(24)} ${wrote}/${picked.length}${err?` (${err} errors)`:''}`);
  }

  console.log(`\n${DRY ? 'DRY RUN' : 'DONE'} — ${grandWrote}/${grandDocs} docs ${DRY ? 'would sync' : 'upserted'}, ${grandErr} errors.`);
  await pool.end().catch(() => {});
  process.exit(grandErr > 0 ? 2 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
