/**
 * provisioning.js — ONE-TIME online provisioning for the on-prem local server.
 *
 * First-run "activation": the owner logs in once (online); we pull their restaurant's
 * config from the CLOUD API into the LOCAL Postgres, then the server runs offline
 * (Toast/Square-style setup).
 *
 * We pull from the cloud API (not the cloud Postgres) because production data lives in
 * Firestore. The restaurant document embeds its menu + tax/billing settings, so writing
 * the restaurant doc brings the menu with it. We write through the LOCAL db layer
 * (pgAdapter → local Postgres), so the same reads the app already uses work offline.
 *
 * Only CONFIG/catalog + staff + the owner account are pulled. Transactions (orders) are
 * created locally offline and flow UP via the cloud-sync worker.
 */

const { getDb } = require('../firebase');

const DEFAULT_CLOUD_API = process.env.CLOUD_API_URL || 'https://dine-backend-lake.vercel.app';

// The cloud API returns Firestore timestamps as { _seconds, _nanoseconds } JSON.
// Convert them to real Dates so they write cleanly into timestamptz columns.
function normalize(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') {
    if (typeof v._seconds === 'number') {
      return new Date(v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6));
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

async function cloudFetch(base, path, token, opts = {}) {
  const resp = await fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!resp.ok) throw new Error((json && json.error) || `HTTP ${resp.status} ${path}`);
  return json;
}

async function loginPhone(base, phone, otp) {
  const d = await cloudFetch(base, '/api/auth/phone/verify-otp', null, { method: 'POST', body: { phone, otp } });
  if (!d || !d.token) throw new Error('Cloud login failed');
  return { token: d.token, user: d.user };
}

/**
 * Provision one restaurant from the cloud into the local Postgres.
 * @param {{cloudApiUrl?:string, restaurantId:string, token?:string, phone?:string, otp?:string, ownerUser?:object}} opts
 */
async function provisionFromCloud(opts = {}) {
  const base = opts.cloudApiUrl || DEFAULT_CLOUD_API;
  const restaurantId = opts.restaurantId;
  if (!restaurantId) throw new Error('restaurantId is required');

  let token = opts.token;
  let ownerUser = opts.ownerUser;
  if (!token && opts.phone && opts.otp) {
    const r = await loginPhone(base, opts.phone, opts.otp);
    token = r.token; ownerUser = ownerUser || r.user;
  }
  if (!token) throw new Error('A cloud token (or phone+otp) is required to provision');

  const db = getDb();
  const summary = { restaurantId };

  // 1) Owner account → so the owner can log in offline (phone-OTP demo / PIN / password).
  try {
    if (ownerUser && ownerUser.id) {
      const { restaurant, ...userDoc } = ownerUser; // drop the embedded restaurant blob
      await db.collection('users').doc(String(ownerUser.id)).set(normalize(userDoc), { merge: true });
      summary.ownerUser = ownerUser.id;
    }
  } catch (e) { summary.ownerUser = 'err: ' + e.message; }

  // 2) Restaurant doc — contains the MENU + tax/billing settings.
  try {
    const d = await cloudFetch(base, `/api/restaurants/${restaurantId}`, token);
    const rest = (d && d.restaurant) || d;
    if (rest) {
      await db.collection('restaurants').doc(restaurantId).set(normalize(rest), { merge: true });
      summary.restaurant = 1;
      summary.menuItems = (rest.menu && rest.menu.items ? rest.menu.items.length : 0);
    }
  } catch (e) { summary.restaurant = 'err: ' + e.message; }

  // 3) Floors + their tables (tables come nested under floors).
  try {
    const fd = await cloudFetch(base, `/api/floors/${restaurantId}`, token);
    const floors = (fd && fd.floors) || fd || [];
    let tcount = 0;
    for (const f of (Array.isArray(floors) ? floors : [])) {
      const { tables, ...floorDoc } = f;
      await db.collection('restaurants').doc(restaurantId).collection('floors').doc(String(f.id)).set(normalize(floorDoc), { merge: true });
      for (const t of (tables || [])) {
        await db.collection('restaurants').doc(restaurantId).collection('floors').doc(String(f.id)).collection('tables').doc(String(t.id)).set(normalize(t), { merge: true });
        tcount++;
      }
    }
    summary.floors = Array.isArray(floors) ? floors.length : 0;
    summary.tables = tcount;
  } catch (e) { summary.floors = 'err: ' + e.message; }

  // 4) Offers (optional).
  try {
    const d = await cloudFetch(base, `/api/offers/${restaurantId}`, token);
    const offers = (d && d.offers) || d || [];
    for (const o of (Array.isArray(offers) ? offers : [])) {
      await db.collection('offers').doc(String(o.id)).set(normalize(o), { merge: true });
    }
    summary.offers = Array.isArray(offers) ? offers.length : 0;
  } catch (e) { summary.offers = 'err: ' + e.message; }

  return summary;
}

module.exports = { provisionFromCloud, loginPhone };
