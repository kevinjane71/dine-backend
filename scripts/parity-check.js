/**
 * parity-check.js — proves the pgAdapter (Cloud SQL) answers each query the SAME as
 * Firestore, WITHOUT being limited by Firestore composite-index requirements.
 *
 * Method: pull the restaurant's docs from Firestore (ground truth) with a single-field
 * where (no index needed). Compute what each query SHOULD return by applying the filter/
 * sort/limit in memory. Then run the REAL query through the pgAdapter and assert it
 * returns the same doc IDs in the same order. Also cross-checks count().
 *
 *   node scripts/parity-check.js <restaurantId> [collectionFilter]
 *
 * Requires .env.local with DATABASE_URL = Cloud SQL (NOT LOCAL_SERVER_MODE).
 * Meaningful only when the restaurant's data is synced in both stores.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
if (process.env.LOCAL_SERVER_MODE === 'true') { console.error('Refusing under LOCAL_SERVER_MODE.'); process.exit(1); }

const { db, getFirestoreDb } = require('../firebase');
const fdb = getFirestoreDb();
const RID = process.argv[2];
const FILTER = process.argv[3] || '';
if (!RID) { console.error('usage: node scripts/parity-check.js <restaurantId> [collectionFilter]'); process.exit(1); }

// ── field access + comparison (timestamp-aware, dot-notation) ──
function toMillis(v) {
  if (v == null) return v;
  if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return null; } }
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object' && v._seconds !== undefined) return v._seconds * 1000;
  return v;
}
function getField(doc, f) {
  let v = doc;
  for (const k of f.split('.')) { if (v == null) return undefined; v = v[k]; }
  return v;
}
function cmp(a, b) {
  a = toMillis(a); b = toMillis(b);
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return a < b ? -1 : 1;
}
// In-memory Firestore-equivalent query over an array of {id, ...data}
function expectIds(docs, spec) {
  let out = docs.slice();
  for (const [f, op, val] of (spec.where || [])) {
    out = out.filter(d => {
      const v = toMillis(getField(d, f)); const target = toMillis(val);
      switch (op) {
        case '==': return v === target;
        case '!=': return v !== target && v !== undefined;
        case '>': return v !== undefined && v > target;
        case '>=': return v !== undefined && v >= target;
        case '<': return v !== undefined && v < target;
        case '<=': return v !== undefined && v <= target;
        case 'in': return (val).map(toMillis).includes(v);
        case 'not-in': return v !== undefined && !(val).map(toMillis).includes(v);
        case 'array-contains': return Array.isArray(getField(d, f)) && getField(d, f).includes(val);
        default: return true;
      }
    });
  }
  if (spec.orderBy) {
    const [f, dir] = spec.orderBy;
    // Firestore excludes docs missing the orderBy field
    out = out.filter(d => getField(d, f) !== undefined && getField(d, f) !== null);
    out.sort((a, b) => { const c = cmp(getField(a, f), getField(b, f)); return (c !== 0 ? c : (a.id < b.id ? -1 : 1)) * (dir === 'desc' ? -1 : 1); });
  }
  if (spec.limit) out = out.slice(0, spec.limit);
  return out.map(d => d.id);
}
// Build the real query on the pgAdapter from a spec
function pgQuery(spec) {
  let q = db.collection(spec.coll);
  for (const [f, op, val] of (spec.where || [])) q = q.where(f, op, val);
  if (spec.orderBy) q = q.orderBy(spec.orderBy[0], spec.orderBy[1]);
  if (spec.limit) q = q.limit(spec.limit);
  return q;
}
async function pgIds(spec) { const s = await pgQuery(spec).get(); return s.docs.map(d => d.id); }
async function fetchAllFS(coll) {
  const s = await fdb.collection(coll).where('restaurantId', '==', RID).limit(50000).get();
  return s.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ── the query patterns each page issues, per collection ──
const GROUPS = {
  orders: [
    { coll: 'orders', desc: 'latest 20 by createdAt desc', orderBy: ['createdAt', 'desc'], limit: 20 },
    { coll: 'orders', desc: 'status == completed, latest 30', where: [['status', '==', 'completed']], orderBy: ['createdAt', 'desc'], limit: 30 },
    { coll: 'orders', desc: 'status in [confirmed,pending,preparing,ready] (KOT)', where: [['status', 'in', ['confirmed', 'pending', 'preparing', 'ready']]], limit: 100 },
    { coll: 'orders', desc: 'finalAmount > 500, top 25 (inequality+order)', where: [['finalAmount', '>', 500]], orderBy: ['finalAmount', 'desc'], limit: 25 },
    { coll: 'orders', desc: 'status != completed, latest 40 (!=, excludes missing field)', where: [['status', '!=', 'completed']], orderBy: ['status', 'asc'], limit: 40 },
    { coll: 'orders', desc: 'status not-in [completed,cancelled], 40', where: [['status', 'not-in', ['completed', 'cancelled']]], orderBy: ['status', 'asc'], limit: 40 },
    { coll: 'orders', desc: 'compound: status==completed AND finalAmount>100, top 30', where: [['status', '==', 'completed'], ['finalAmount', '>', 100]], orderBy: ['finalAmount', 'desc'], limit: 30 },
    { coll: 'orders', desc: 'orderBy completedAt desc (many docs MISSING this field)', orderBy: ['completedAt', 'desc'], limit: 40 },
    { coll: 'orders', desc: 'paymentMethod == cash, 40', where: [['paymentMethod', '==', 'cash']], orderBy: ['createdAt', 'desc'], limit: 40 },
  ],
  customers: [
    { coll: 'customers', desc: 'latest 50 by createdAt desc', orderBy: ['createdAt', 'desc'], limit: 50 },
    { coll: 'customers', desc: 'all (set parity)', limit: 20000 },
  ],
  menuItems: [
    { coll: 'menuItems', desc: 'all (set parity)', limit: 5000 },
  ],
  inventory: [
    { coll: 'inventory', desc: 'all (set parity)', limit: 20000 },
  ],
  offers: [
    { coll: 'offers', desc: 'all (set parity)', limit: 2000 },
  ],
  staffUsers: [
    { coll: 'staffUsers', desc: 'all (set parity)', limit: 2000 },
  ],
};

(async () => {
  console.log(`\n=== pgAdapter(Cloud SQL) vs Firestore parity — restaurant ${RID} ===`);
  console.log(`method: expected = Firestore data filtered/sorted in memory ; actual = real pgAdapter query\n`);
  let pass = 0, fail = 0, err = 0; const fails = [];
  for (const [g, specs] of Object.entries(GROUPS)) {
    if (FILTER && g !== FILTER) continue;
    let fsDocs;
    try { fsDocs = await fetchAllFS(specs[0].coll); }
    catch (e) { console.log(`⚠ ${g}: could not load Firestore docs — ${e.message.slice(0, 60)}`); err++; continue; }
    // count() parity
    try {
      const pgCount = (await db.collection(specs[0].coll).where('restaurantId', '==', RID).count().get()).data().count;
      const ok = pgCount === fsDocs.length;
      console.log(`${ok ? '✓' : '✗'} ${g.padEnd(11)}| count()  FS=${fsDocs.length} PG=${pgCount}`);
      ok ? pass++ : (fail++, fails.push(`${g} count: FS=${fsDocs.length} PG=${pgCount}`));
    } catch (e) { console.log(`⚠ ${g.padEnd(11)}| count() ERROR ${e.message.slice(0, 50)}`); err++; }
    // per-query parity
    for (const spec of specs) {
      const label = `${g.padEnd(11)}| ${spec.desc}`;
      try {
        const exp = expectIds(fsDocs, spec);
        const act = await pgIds({ ...spec, where: [['restaurantId', '==', RID], ...(spec.where || [])] });
        const se = new Set(exp), sa = new Set(act);
        const missing = exp.filter(x => !sa.has(x)), extra = act.filter(x => !se.has(x));
        const sameSet = missing.length === 0 && extra.length === 0;
        // Order is only defined when the query has an orderBy; otherwise compare set only.
        const ordered = !!spec.orderBy;
        const sameOrder = exp.join(',') === act.join(',');
        if (ordered ? sameOrder : sameSet) { console.log(`  ✓ ${spec.desc}  (${exp.length} docs${ordered ? ', order match' : ', set match (unordered)'})`); pass++; }
        else if (sameSet && ordered) { console.log(`  ✗ ${spec.desc}  (${exp.length}, SET ok but ORDER differs)`); fail++; fails.push(`${label}: order`); }
        else {
          console.log(`  ✗ ${spec.desc}  exp=${exp.length} pg=${act.length} | missingInPG=${missing.length} extraInPG=${extra.length}`);
          if (missing.length) console.log(`       missing: ${missing.slice(0, 4).join(', ')}`);
          if (extra.length) console.log(`       extra:   ${extra.slice(0, 4).join(', ')}`);
          fail++; fails.push(`${label}: exp=${exp.length} pg=${act.length}`);
        }
      } catch (e) { console.log(`  ⚠ ${spec.desc}  ERROR ${e.message.slice(0, 60)}`); err++; fails.push(`${label}: ERR`); }
    }
  }
  // ── cursor pagination (startAfter with a doc snapshot) on the pgAdapter ──
  if (!FILTER || FILTER === 'orders') {
    try {
      const base = () => db.collection('orders').where('restaurantId', '==', RID).orderBy('createdAt', 'desc');
      const p1 = await base().limit(10).get();
      const p1ids = p1.docs.map(d => d.id);
      const last = p1.docs[p1.docs.length - 1];
      const p2ids = (await base().startAfter(last).limit(10).get()).docs.map(d => d.id);
      const combined = await base().limit(20).get();
      const cIds = combined.docs.map(d => d.id);
      const paged = [...p1ids, ...p2ids];
      const overlap = p1ids.filter(x => p2ids.includes(x));
      const ok = overlap.length === 0 && paged.join(',') === cIds.join(',');
      if (ok) { console.log(`✓ orders      | cursor: page1(10)+page2(10) == limit(20), no overlap`); pass++; }
      else {
        console.log(`✗ orders      | cursor pagination broken  overlap=${overlap.length}  paged==limit20? ${paged.join(',') === cIds.join(',')}`);
        fail++; fails.push('orders cursor pagination');
      }
    } catch (e) { console.log(`⚠ orders      | cursor test ERROR ${e.message.slice(0, 60)}`); err++; }
  }

  console.log(`\n=== RESULT: ${pass} pass, ${fail} mismatch, ${err} error ===`);
  if (fails.length) { console.log('ISSUES:'); fails.forEach(f => console.log('  - ' + f)); }
  process.exit(fail + err > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
