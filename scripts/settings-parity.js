/**
 * settings-parity.js — deep field-by-field parity of the restaurant document (all the
 * /admin settings) between raw Firestore and the pgAdapter (Cloud SQL). The admin tab
 * reads/writes posSettings, printSettings, taxSettings, currencySettings, billingSettings,
 * etc. — deeply nested JSONB. A single dropped/changed nested value = a broken setting.
 *
 *   node scripts/settings-parity.js <restaurantId> [--full]
 *
 * Reports every path whose value differs (timestamp-normalized). --full also lists paths
 * present on only one side.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });
const { db, getFirestoreDb } = require('../firebase');
const fdb = getFirestoreDb();
const RID = process.argv[2];
const FULL = process.argv.includes('--full');
if (!RID) { console.error('usage: node scripts/settings-parity.js <restaurantId> [--full]'); process.exit(1); }

// The critical admin-settings fields (from restaurantsFieldMapper) to scrutinize first.
const SETTINGS_KEYS = [
  'posSettings', 'orderSettings', 'printSettings', 'ecrSettings', 'pricingSettings',
  'taxSettings', 'currencySettings', 'customerAppSettings', 'billingSettings',
  'bookingSettings', 'feedbackSettings', 'barInventorySettings', 'discountApprovalSettings',
  'kotSettings', 'aggregatorConfig', 'operatingHours', 'features',
];

function norm(v) {
  if (v === null || v === undefined) return null;
  if (typeof v.toDate === 'function') { try { return 'ts:' + v.toDate().getTime(); } catch { return 'ts:?'; } }
  if (v instanceof Date) return 'ts:' + v.getTime();
  if (typeof v === 'object' && v._seconds !== undefined) return 'ts:' + (v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6));
  // ISO date string ↔ (nested Firestore Timestamps get serialized to ISO in JSONB) — normalize
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) { const t = Date.parse(v); if (!isNaN(t)) return 'ts:' + t; }
  if (typeof v === 'number') return Math.abs(v) < 1e-9 ? 0 : v; // treat -0/tiny as 0
  return v;
}
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v) && typeof v.toDate !== 'function' && v._seconds === undefined && !(v instanceof Date); }

// Recursively collect differences. diffs: [{path, fs, pg}], onlyFs/onlyPg: [path]
function deepDiff(a, b, p, out) {
  const na = norm(a), nb = norm(b);
  const aObj = isObj(a), bObj = isObj(b);
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aObj && bObj) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const ak = a[k], bk = b[k];
      if (!(k in a)) { if (bk !== undefined && bk !== null) out.onlyPg.push(`${p}.${k}`); continue; }
      if (!(k in b)) { if (ak !== undefined && ak !== null) out.onlyFs.push(`${p}.${k}`); continue; }
      deepDiff(ak, bk, `${p}.${k}`, out);
    }
    return;
  }
  if (aArr && bArr) {
    if (a.length !== b.length) { out.diffs.push({ path: `${p}[len]`, fs: a.length, pg: b.length }); return; }
    for (let i = 0; i < a.length; i++) deepDiff(a[i], b[i], `${p}[${i}]`, out);
    return;
  }
  if (JSON.stringify(na) !== JSON.stringify(nb)) out.diffs.push({ path: p, fs: na, pg: nb });
}

(async () => {
  const [fsSnap] = await Promise.all([fdb.collection('restaurants').doc(RID).get()]);
  const pgSnap = await db.collection('restaurants').doc(RID).get();
  if (!fsSnap.exists) { console.error('restaurant not in Firestore'); process.exit(2); }
  if (!pgSnap.exists) { console.error('restaurant not in Postgres'); process.exit(2); }
  const fs = fsSnap.data(), pg = pgSnap.data();
  const out = { diffs: [], onlyFs: [], onlyPg: [] };

  console.log(`\n=== restaurant ${RID} — admin/settings deep parity (Firestore vs Postgres) ===`);
  console.log(`name: ${fs.name || '(?)'}\n`);

  // 1. Each critical settings object
  let settingsClean = true;
  for (const k of SETTINGS_KEYS) {
    const sub = { diffs: [], onlyFs: [], onlyPg: [] };
    if (fs[k] === undefined && pg[k] === undefined) { console.log(`  – ${k}  (absent both)`); continue; }
    deepDiff(fs[k], pg[k], k, sub);
    const nIssues = sub.diffs.length + sub.onlyFs.length + sub.onlyPg.length;
    if (nIssues === 0) { console.log(`  ✓ ${k}`); }
    else {
      settingsClean = false;
      console.log(`  ✗ ${k}  (${sub.diffs.length} changed, ${sub.onlyFs.length} only-FS, ${sub.onlyPg.length} only-PG)`);
      sub.diffs.slice(0, 6).forEach(d => console.log(`       ${d.path}: FS=${JSON.stringify(d.fs)} PG=${JSON.stringify(d.pg)}`));
      if (FULL) { sub.onlyFs.slice(0, 6).forEach(x => console.log(`       only-FS: ${x}`)); sub.onlyPg.slice(0, 6).forEach(x => console.log(`       only-PG: ${x}`)); }
    }
  }

  // 2. Whole-doc scan for any OTHER differing top-level field
  const allKeys = new Set([...Object.keys(fs), ...Object.keys(pg)]);
  const otherDiffs = [];
  for (const k of allKeys) {
    if (SETTINGS_KEYS.includes(k)) continue;
    if (['createdAt', 'updatedAt', 'qrCode', 'qr_code'].includes(k)) continue; // volatile/skip-by-design
    const sub = { diffs: [], onlyFs: [], onlyPg: [] };
    deepDiff(fs[k], pg[k], k, sub);
    if (sub.diffs.length) otherDiffs.push(...sub.diffs);
  }
  if (otherDiffs.length) {
    console.log(`\n  other top-level field diffs (${otherDiffs.length}):`);
    otherDiffs.slice(0, 15).forEach(d => console.log(`    ${d.path}: FS=${JSON.stringify(d.fs)?.slice(0, 60)} PG=${JSON.stringify(d.pg)?.slice(0, 60)}`));
  }

  const ok = settingsClean && otherDiffs.length === 0;
  console.log(`\n=== ${ok ? '✓ ALL admin settings identical' : '✗ differences found (above)'} ===`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
