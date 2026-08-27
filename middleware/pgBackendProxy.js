// ─────────────────────────────────────────────────────────────────────────────
// pgBackendProxy — transparent per-restaurant reverse proxy (Vercel → GCP)
//
// WHY: Some restaurants have been migrated to the GCP/Postgres backend and marked
// with `pgBackendUrl` (via the dine-admin per-owner / per-restaurant switch). But a
// client that is already logged in keeps hitting the Vercel URL until it re-logs-in,
// so its live traffic (orders, payments) keeps landing on Firestore even though the
// account is "on GCP" — the split that leaks data.
//
// This middleware closes that gap on the SERVER: for any request that belongs to a
// flagged restaurant/owner, Vercel transparently forwards the request to that
// restaurant's GCP backend and pipes the response back. The client never changes and
// never has to refresh — it keeps calling Vercel, Vercel relays to GCP.
//
// SAFETY PROPERTIES (this is a live-traffic bridge — every choice is fail-safe):
//   • DISABLED by default. Does nothing unless env `ENABLE_PG_PROXY=true`. Merging /
//     deploying this file changes NOTHING for existing customers until that flag is set.
//   • Only proxies when a REAL flagged id (20-char Firestore id) is found in the
//     request. No flagged id → next() → handled on Vercel exactly as today.
//   • NEVER proxies the control plane (/api/super-admin, resolve-backend), webhooks,
//     health, or CORS preflight — the migration toggle itself always answers on Vercel.
//   • Loop-guarded (x-dine-proxied header) so the GCP side never bounces it back.
//   • On a forward error it returns 502 and does NOT fall back to Vercel — falling back
//     would write the order to Firestore and re-create the split. Client simply retries.
//   • On an internal decision error it serves locally (current behavior) — never 500s
//     a customer because of the proxy layer.
// ─────────────────────────────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const { kvGet, kvSet, kvDel } = require('../utils/kvCache');

const PROXY_ENABLED = process.env.ENABLE_PG_PROXY === 'true';

const FLAGGED_CACHE_KEY = 'pg_proxy:flagged_v1';
const FLAGGED_REDIS_TTL = 300;          // seconds — Redis copy of the flagged map
const MEM_TTL_MS = 60 * 1000;           // in-memory freshness before we re-check
const FORWARD_TIMEOUT_MS = 30000;       // upstream (GCP) request timeout

// Hop-by-hop headers must not be forwarded/echoed (RFC 7230 §6.1) + host/content-length
// which the fetch layer recomputes from the target URL and body.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

// ── singleton state ──────────────────────────────────────────────────────────
let _db = null;
let _collections = null;
let _map = null;            // Map<id, backendUrl> — flagged restaurant ids AND owner ids
let _loadedAt = 0;
let _loading = null;        // in-flight load promise (coalesces concurrent requests)

function init(db, collections) {
  _db = db;
  _collections = collections;
}

// Build the flagged map straight from Firestore. Only docs that actually carry a
// non-null pgBackendUrl are returned, so this reads a handful of docs, not the world.
async function buildFromFirestore() {
  const map = {};
  const [rSnap, uSnap] = await Promise.all([
    _db.collection(_collections.restaurants).where('pgBackendUrl', '!=', null).get(),
    _db.collection(_collections.users).where('pgBackendUrl', '!=', null).get(),
  ]);
  rSnap.forEach((d) => { const u = d.data().pgBackendUrl; if (u) map[d.id] = u; });
  uSnap.forEach((d) => { const u = d.data().pgBackendUrl; if (u) map[d.id] = u; });
  return map;
}

// Returns the flagged Map, using in-memory cache → Redis → Firestore in that order.
// Fail-safe: any error yields an empty map (⇒ nothing gets proxied ⇒ Vercel handles it).
async function getFlaggedMap() {
  const now = Date.now();
  if (_map && (now - _loadedAt) < MEM_TTL_MS) return _map;
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      let obj = await kvGet(FLAGGED_CACHE_KEY);
      if (!obj || typeof obj !== 'object') {
        obj = await buildFromFirestore();
        kvSet(FLAGGED_CACHE_KEY, obj, FLAGGED_REDIS_TTL).catch(() => {});
      }
      _map = new Map(Object.entries(obj));
      _loadedAt = Date.now();
      return _map;
    } catch (e) {
      console.error('[pg-proxy] failed to load flagged map:', e.message);
      if (!_map) _map = new Map();   // fail-safe: empty ⇒ proxy nothing
      return _map;
    } finally {
      _loading = null;
    }
  })();

  return _loading;
}

// Called by the dine-admin backend-routing endpoints right after they change a flag,
// so the switch takes effect within seconds instead of waiting for the TTL.
function invalidateFlaggedCache() {
  _map = null;
  _loadedAt = 0;
  kvDel(FLAGGED_CACHE_KEY).catch(() => {});
}

// Requests that must ALWAYS be served by Vercel, never proxied.
function shouldSkip(req) {
  if (req.method === 'OPTIONS') return true;              // CORS preflight
  if (req.headers['x-dine-proxied']) return true;         // loop guard (came back from GCP)
  const p = req.path || '';
  if (p === '/' || p === '/health' || p === '/api/health') return true;
  if (p.startsWith('/api/super-admin')) return true;      // control plane — owns the flag
  if (p.startsWith('/api/auth/resolve-backend')) return true; // login routing resolver
  if (p.includes('/webhook')) return true;                // global payment webhooks
  return false;
}

// Find a flagged id anywhere the request can carry a restaurant/owner identity.
// Because the map only holds real flagged ids, checking raw path segments / query /
// body values against it is both precise (no false hits) and route-shape agnostic.
function pickTarget(req, map) {
  if (!map || map.size === 0) return null;

  // 1) URL path segments  (/api/orders/:restaurantId, /api/kot/:restaurantId, ...)
  const segs = (req.path || '').split('/');
  for (const s of segs) {
    if (s && map.has(s)) return map.get(s);
  }

  // 2) query params
  const q = req.query || {};
  for (const k of ['restaurantId', 'restaurant_id', 'rid']) {
    const v = q[k];
    if (typeof v === 'string' && map.has(v)) return map.get(v);
  }

  // 3) parsed JSON body  (POST /api/orders carries restaurantId here)
  const b = req.body;
  if (b && typeof b === 'object') {
    for (const k of ['restaurantId', 'restaurant_id']) {
      const v = b[k];
      if (typeof v === 'string' && map.has(v)) return map.get(v);
    }
  }

  // 4) owner id from the JWT  (covers owner-scoped requests with no restaurantId)
  const auth = req.headers['authorization'];
  const tok = auth && auth.split(' ')[1];
  if (tok) {
    try {
      const dec = jwt.verify(tok, process.env.JWT_SECRET);
      if (dec && dec.userId && map.has(dec.userId)) return map.get(dec.userId);
    } catch (_) { /* bad/expired token — let the normal auth layer reject it */ }
  }

  return null;
}

// Forward the request to the restaurant's GCP backend and pipe the response back.
async function forward(req, res, target) {
  const base = String(target).replace(/\/+$/, '');
  const url = base + req.originalUrl;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  headers['x-dine-proxied'] = '1';                                   // loop guard
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || 'https';

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req._rawBodyBuf && req._rawBodyBuf.length) {
      body = req._rawBodyBuf;                                        // byte-exact
    } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) {
      body = JSON.stringify(req.body);
      headers['content-type'] = 'application/json';
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FORWARD_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body,
      signal: ctrl.signal,
      redirect: 'manual',
    });
    clearTimeout(timer);

    res.status(upstream.status);
    upstream.headers.forEach((val, key) => {
      const lk = key.toLowerCase();
      if (HOP_BY_HOP.has(lk)) return;
      if (lk === 'content-encoding' || lk === 'content-length') return; // body already decoded by fetch
      if (lk.startsWith('access-control-')) return;                     // CORS set by our own layer
      try { res.setHeader(key, val); } catch (_) {}
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);   // res.end is wrapped upstream to stamp the correct CORS header
  } catch (e) {
    clearTimeout(timer);
    console.error(`[pg-proxy] forward failed ${req.method} ${req.originalUrl} → ${base}: ${e.message}`);
    // FAIL-SAFE: do NOT fall back to Vercel. The restaurant's live data lives on GCP;
    // serving from Firestore here would write the order to the wrong store and re-split.
    if (!res.headersSent) {
      res.status(502).json({ error: 'Backend temporarily unavailable. Please retry.' });
    }
  }
}

async function middleware(req, res, next) {
  if (!PROXY_ENABLED) return next();
  try {
    if (shouldSkip(req)) return next();
    const map = await getFlaggedMap();
    const target = pickTarget(req, map);
    if (!target) return next();
    console.log(`[pg-proxy] ${req.method} ${req.path} → ${target}`);
    return forward(req, res, target);
  } catch (e) {
    // Decision-layer failure: serve locally (current behavior) rather than 500 the client.
    console.error('[pg-proxy] middleware error:', e.message);
    return next();
  }
}

module.exports = { init, middleware, invalidateFlaggedCache, PROXY_ENABLED };
