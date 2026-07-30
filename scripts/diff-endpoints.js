#!/usr/bin/env node
/**
 * diff-endpoints.js — PG query-parity validator.
 *
 * Hits the same GET endpoints on the Firestore (main) backend and the Postgres
 * (pg-full-migration) backend for the SAME restaurant + token, then deep-diffs the JSON
 * so we can SEE where the pgAdapter diverges from Firestore — no guessing.
 *
 * Timestamp/volatile fields are ignored (date drift between the two DBs is expected and
 * out of scope). Everything else must match: same keys, same values, same array order.
 *
 *   FS_URL=... PG_URL=... RID=... PHONE=+91... OTP=1234 node scripts/diff-endpoints.js [group]
 */
const FS_URL = process.env.FS_URL || 'https://dine-backend-lake.vercel.app';
const PG_URL = process.env.PG_URL || 'http://127.0.0.1:3003';
const RID = process.env.RID || '6i3RBg6Hib6BEDGfSDN9';
const PHONE = process.env.PHONE || '+919000000000';
const OTP = process.env.OTP || '1234';
const GROUP = process.argv[2] || 'stable';

// Keys ignored in the diff (timestamps / volatile / server-generated).
const IGNORE = new Set([
  'createdAt', 'updatedAt', 'lastOrderTime', 'timestamp', 'ts', 'lastUpdated', 'lastLogin',
  '_seconds', '_nanoseconds', 'serverTime', 'syncedAt', 'expiresAt', 'iat', 'exp',
  'orderTime', 'completedAt', 'closedAt', 'openedAt', 'date', 'updated_at', 'created_at',
]);

const ENDPOINTS = {
  stable: [
    `/api/restaurants/${RID}`,
    `/api/menu/${RID}`,
    `/api/floors/${RID}`,
    `/api/offers/${RID}`,
    `/api/tables/${RID}`,
  ],
  billing: [
    `/api/orders/${RID}`,
    `/api/orders/${RID}?status=completed`,
    `/api/kot/${RID}`,
    `/api/customers/${RID}`,
  ],
  inventory: [`/api/inventory/${RID}`],
};

async function login(base) {
  const r = await fetch(`${base}/api/auth/phone/verify-otp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: PHONE, otp: OTP }),
  });
  const j = await r.json();
  if (!j.token) throw new Error(`login failed on ${base}: ${JSON.stringify(j).slice(0, 120)}`);
  return j.token;
}

async function get(base, token, path) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

// Recursive diff. Returns array of { path, fs, pg } mismatches.
function diff(a, b, path = '', out = []) {
  if (a === b) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) { out.push({ path, fs: preview(a), pg: preview(b), kind: `type ${ta}≠${tb}` }); return out; }
  if (ta === 'array') {
    if (a.length !== b.length) out.push({ path, fs: `len ${a.length}`, pg: `len ${b.length}`, kind: 'array-length' });
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORE.has(k)) continue;
      if (!(k in a)) { out.push({ path: `${path}.${k}`, fs: '(missing)', pg: preview(b[k]), kind: 'only-in-PG' }); continue; }
      if (!(k in b)) { out.push({ path: `${path}.${k}`, fs: preview(a[k]), pg: '(missing)', kind: 'only-in-FS' }); continue; }
      diff(a[k], b[k], `${path}.${k}`, out);
    }
    return out;
  }
  out.push({ path, fs: preview(a), pg: preview(b), kind: 'value' });
  return out;
}
function preview(v) { const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 80 ? s.slice(0, 80) + '…' : s; }

(async () => {
  console.log(`\n🔍 PG parity diff — group="${GROUP}"  rid=${RID}\n   FS=${FS_URL}\n   PG=${PG_URL}\n`);
  const [fsTok, pgTok] = await Promise.all([login(FS_URL), login(PG_URL)]);
  const paths = ENDPOINTS[GROUP] || ENDPOINTS.stable;
  for (const p of paths) {
    const [fs, pg] = await Promise.all([get(FS_URL, fsTok, p), get(PG_URL, pgTok, p)]);
    if (fs.status !== pg.status) { console.log(`❌ ${p}\n   status FS=${fs.status} PG=${pg.status}\n`); continue; }
    if (fs.status !== 200) { console.log(`⚠️  ${p} → both ${fs.status} (skipped)\n`); continue; }
    const mismatches = diff(fs.json, pg.json);
    if (mismatches.length === 0) { console.log(`✅ ${p}  — identical (ignoring timestamps)\n`); continue; }
    console.log(`❌ ${p}  — ${mismatches.length} mismatch(es):`);
    for (const m of mismatches.slice(0, 25)) console.log(`     ${m.kind}  ${m.path}\n        FS: ${m.fs}\n        PG: ${m.pg}`);
    if (mismatches.length > 25) console.log(`     … +${mismatches.length - 25} more`);
    console.log('');
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
