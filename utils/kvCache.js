/**
 * KV Cache Utility (Redis)
 * Persistent cache layer — survives serverless cold starts.
 *
 * Backends (auto-selected):
 *   • REDIS_URL set              → local / co-located Redis (ioredis) — VM deployment
 *   • KV_REST_API_URL + _TOKEN   → Upstash REST — Vercel / serverless
 *   • neither                    → cache disabled (all ops no-op → reads hit the DB)
 *
 * All methods are safe: on any Redis failure they degrade to null / silent no-op,
 * so the caller falls through to Firestore. Zero impact on correctness.
 *
 * Storage format: values are stored as STRINGS. Payloads larger than
 * COMPRESS_THRESHOLD are gzip-compressed (base64 + 'GZ1:' marker) — the order-list
 * responses are ~250KB of JSON that shrink ~6-8x, which slashes Redis memory AND
 * metered bandwidth (e.g. Upstash's monthly bandwidth cap). Small values (version
 * counters, tiny docs) are stored plain. Decoding is transparent + backward-compatible
 * with older uncompressed entries.
 */

const zlib = require('zlib');

let redis = null;
let redisDisabled = false;

// Only compress payloads bigger than this (below it, gzip overhead isn't worth it).
const COMPRESS_THRESHOLD = 1024; // bytes
const GZ_PREFIX = 'GZ1:';

// Object → storable string (gzip+base64 with marker when large enough).
function encodeValue(data) {
  const json = JSON.stringify(data);
  if (typeof json === 'string' && Buffer.byteLength(json) > COMPRESS_THRESHOLD) {
    try { return GZ_PREFIX + zlib.gzipSync(json).toString('base64'); } catch (_) { /* fall back to plain */ }
  }
  return json;
}

// Stored value → object. Handles gzipped, plain-JSON, and legacy already-parsed values.
function decodeValue(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw; // legacy/auto-deserialized entry or a raw number
  if (raw.startsWith(GZ_PREFIX)) {
    try { return JSON.parse(zlib.gunzipSync(Buffer.from(raw.slice(GZ_PREFIX.length), 'base64')).toString()); }
    catch (_) { return null; }
  }
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

// True only for a Redis on this same machine (redis://[user:pass@]127.0.0.1|localhost|::1).
// A remote redis:// URL (e.g. Upstash's TCP endpoint left in a serverless env) returns false
// so it never hijacks the Upstash REST path.
function isLoopbackRedisUrl(u) {
  if (!u) return false;
  try {
    const host = new URL(u).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch (_) { return false; }
}

function getRedis() {
  if (redisDisabled) return null;
  if (redis) return redis;

  try {
    // ── Local / co-located Redis (VM deployment) — ONLY when REDIS_URL is loopback ──
    // A standard Redis on the SAME box (redis://127.0.0.1) speaks the Redis protocol, which
    // @upstash/redis (REST) can't use, so we use ioredis. But we deliberately accept ONLY a
    // loopback REDIS_URL: on serverless (Vercel) a leftover REMOTE redis:// URL (e.g. the
    // Upstash TCP endpoint) must NOT hijack the fast REST path — so a non-local REDIS_URL is
    // ignored and we fall through to Upstash REST below. Foolproof across both deployments.
    if (isLoopbackRedisUrl(process.env.REDIS_URL)) {
      const IORedis = require('ioredis');
      const client = new IORedis(process.env.REDIS_URL, {
        // Buffer commands issued during the brief startup connect (offline queue ON), but cap
        // retries so a genuinely-down Redis fails fast; kvGet's 2s withTimeout then returns null
        // → the request falls through to Firestore. Local co-located Redis connects in <50ms.
        maxRetriesPerRequest: 3,
        connectTimeout: 3000,
        retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2000)),
      });
      // Swallow connection errors — every kv* helper already guards and degrades to Firestore.
      client.on('error', (e) => { if (!getRedis._warned) { console.warn('KV Cache: Redis error:', e.message); getRedis._warned = true; } });
      redis = {
        _mode: 'ioredis',
        get(key) { return client.get(key); }, // raw string | null — decoded by kvGet
        set(key, val, opts) {                  // val is already an encoded string
          if (opts && opts.ex) return client.set(key, val, 'EX', opts.ex);
          return client.set(key, val);
        },
        incrby(key, n) { return client.incrby(key, n); },
        expire(key, ttl) { return client.expire(key, ttl); },
        del(key) { return client.del(key); },
      };
      console.log('KV Cache: Initialized from REDIS_URL (local/standard Redis via ioredis)');
      return redis;
    }

    // ── Upstash REST (Vercel / serverless) ──
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const { Redis } = require('@upstash/redis');
      redis = new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
        // We JSON-encode + gzip ourselves (encodeValue/decodeValue); keep Upstash from
        // re-parsing so get/set round-trip our exact strings deterministically.
        automaticDeserialization: false,
      });
      console.log('KV Cache: Initialized from KV_REST_API_URL');
      return redis;
    }

    return null;
  } catch (err) {
    console.error('KV Cache: Failed to initialize Redis:', err.message);
    redisDisabled = true;
    return null;
  }
}

/**
 * Race a promise against a timeout. Returns null if it takes too long.
 */
function withTimeout(promise, ms = 2000) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ]);
}

/**
 * Get a value from KV cache
 */
async function kvGet(key) {
  try {
    const client = getRedis();
    if (!client) return null;
    const raw = await withTimeout(client.get(key), 2000);
    return decodeValue(raw); // handles gzip + JSON + legacy passthrough; null-safe
  } catch (err) {
    console.warn('KV Cache: kvGet failed, disabling:', err.message);
    redisDisabled = true;
    return null;
  }
}

/**
 * Set a value in KV cache with TTL
 */
async function kvSet(key, data, ttlSeconds = 180) {
  try {
    const client = getRedis();
    if (!client) return;
    await withTimeout(client.set(key, encodeValue(data), { ex: ttlSeconds }), 2000);
  } catch (err) {
    // Silent fail
  }
}

/**
 * Delete a key from KV cache (for invalidation)
 */
async function kvDel(key) {
  try {
    const client = getRedis();
    if (!client) return;
    await withTimeout(client.del(key), 2000);
  } catch (err) {
    // Silent fail
  }
}

/**
 * Atomic increment — no race condition on serverless.
 * Returns new value after increment.
 */
async function kvIncrBy(key, amount, ttlSeconds) {
  try {
    const client = getRedis();
    if (!client) return 0;
    const result = await withTimeout(client.incrby(key, amount), 2000);
    if (ttlSeconds && result === amount) {
      // First increment — set TTL (only when result equals amount, meaning key was new)
      await withTimeout(client.expire(key, ttlSeconds), 1000);
    }
    return result || 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Get restaurant doc with KV caching (3 min TTL)
 */
async function getCachedRestaurant(db, collection, restaurantId) {
  const cacheKey = `restaurant:${restaurantId}`;

  const cached = await kvGet(cacheKey);
  if (cached) {
    return { data: cached, fromCache: true };
  }

  const doc = await db.collection(collection).doc(restaurantId).get();
  if (!doc.exists) {
    return { doc, data: null, fromCache: false };
  }

  const data = doc.data();
  kvSet(cacheKey, data, 180).catch(() => {});

  return { doc, data, fromCache: false };
}

function invalidateRestaurantCache(restaurantId) {
  kvDel(`restaurant:${restaurantId}`).catch(() => {});
}

/**
 * Drop-in replacement for db.collection('restaurants').doc(id).get()
 * Returns a Firestore-doc-like object: { exists, data(), id }
 * Safe for READ-ONLY use. Do NOT use when you need .ref for writes.
 */
async function getCachedRestDoc(db, collection, restaurantId) {
  const result = await getCachedRestaurant(db, collection, restaurantId);
  if (result.fromCache) {
    return { exists: !!result.data, data: () => result.data, id: restaurantId };
  }
  return result.doc;
}

function invalidateUserCache(userId) {
  kvDel(`user:${userId}`).catch(() => {});
}

// ── Orders list cache: version-counter invalidation ───────────────────────────
// GET /api/orders/:restaurantId (dashboard + order history) caches its result under a
// per-restaurant version. ANY order write bumps the version, so every cached order-list
// variant (status filters, pagination, date range) instantly misses → next read is fresh.
// This keeps orders LIVE (a new/edited order invalidates immediately) while killing the
// repeated idle re-fetches that dominate the read cost.
async function getOrdersVersion(restaurantId) {
  const v = await kvGet(`orders:${restaurantId}:ver`);
  return v != null ? String(v) : '0';
}
function invalidateOrdersCache(restaurantId) {
  if (!restaurantId) return;
  // 1h TTL on the counter — if it ever expires the cache just misses (safe).
  kvIncrBy(`orders:${restaurantId}:ver`, 1, 3600).catch(() => {});
}
function ordersCacheKey(restaurantId, version, queryDesc) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(String(queryDesc || '')).digest('hex').slice(0, 16);
  return `orders:${restaurantId}:v${version}:${hash}`;
}

// ── Inventory list cache: same version-counter pattern ────────────────────────
// The inventory page (GET /api/inventory/:restaurantId) is re-fetched a lot but stock
// changes on order-deduction, manual edits, purchases, waste, audits. Any of those bumps
// the version → cached inventory reads go fresh. Order-time stock checks read Firestore
// directly (not this cache), so deduction accuracy is never affected.
async function getInventoryVersion(restaurantId) {
  const v = await kvGet(`inventory:${restaurantId}:ver`);
  return v != null ? String(v) : '0';
}
function invalidateInventoryCache(restaurantId) {
  if (!restaurantId) return;
  kvIncrBy(`inventory:${restaurantId}:ver`, 1, 3600).catch(() => {});
}
function inventoryCacheKey(restaurantId, version, queryDesc) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(String(queryDesc || '')).digest('hex').slice(0, 16);
  return `inventory:${restaurantId}:v${version}:${hash}`;
}

// ── Floors/tables cache: version-counter (LIVE table status) ──────────────────
// GET /api/floors + GET /api/tables re-fetch constantly. Table status must stay LIVE,
// so the version is bumped by ANY table/floor write AND any order/billing/table realtime
// event (order placement occupies a table, settle frees it). Short TTL is only a backstop —
// correctness comes from event + write invalidation, so users never see a stale table.
async function getFloorsVersion(restaurantId) {
  const v = await kvGet(`floors:${restaurantId}:ver`);
  return v != null ? String(v) : '0';
}
function invalidateFloorsCache(restaurantId) {
  if (!restaurantId) return;
  kvIncrBy(`floors:${restaurantId}:ver`, 1, 3600).catch(() => {});
}
function floorsCacheKey(restaurantId, version, queryDesc) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(String(queryDesc || '')).digest('hex').slice(0, 16);
  return `floors:${restaurantId}:v${version}:${hash}`;
}

// ── KOT + owner-dashboard caches ──────────────────────────────────────────────
// Both are DERIVED from orders, so they ride on the ORDERS version counter: any order
// write (create/status/edit/settle/cancel/…) already bumps orders:<rid>:ver, which makes
// these keys miss too — so the kitchen screen and dashboard refresh the instant an order
// changes. Callers pass the current orders version into the key.
function kotCacheKey(restaurantId, ordersVersion, queryDesc) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(String(queryDesc || '')).digest('hex').slice(0, 16);
  return `kot:${restaurantId}:v${ordersVersion}:${hash}`;
}
function dashboardCacheKey(restaurantId, ordersVersion, queryDesc) {
  const crypto = require('crypto');
  const hash = crypto.createHash('md5').update(String(queryDesc || '')).digest('hex').slice(0, 16);
  return `dash:${restaurantId}:v${ordersVersion}:${hash}`;
}

/**
 * Normalize phone number for cache key consistency
 */
function normalizePhoneForCache(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.substring(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.substring(1);
  if (digits.length === 10) return digits;
  return digits;
}

/**
 * Cache customer lookup by normalized phone (5 min TTL).
 * Stores minimal data: { id, phone } — enough to do a direct doc read.
 */
async function cacheCustomerByPhone(restaurantId, normalizedPhone, customerData) {
  if (!normalizedPhone) return;
  const key = `customer:${restaurantId}:${normalizedPhone}`;
  await kvSet(key, customerData, 300); // 5 min TTL
}

/**
 * Get cached customer by normalized phone. Returns { id, phone } or null.
 */
async function getCachedCustomerByPhone(restaurantId, normalizedPhone) {
  if (!normalizedPhone) return null;
  const key = `customer:${restaurantId}:${normalizedPhone}`;
  return await kvGet(key);
}

/**
 * Invalidate customer cache entry when customer is created/updated.
 */
function invalidateCustomerCache(restaurantId, phone) {
  const normalized = normalizePhoneForCache(phone);
  if (!normalized) return;
  kvDel(`customer:${restaurantId}:${normalized}`).catch(() => {});
}

module.exports = {
  kvGet,
  kvSet,
  kvDel,
  kvIncrBy,
  getCachedRestaurant,
  getCachedRestDoc,
  invalidateRestaurantCache,
  invalidateUserCache,
  cacheCustomerByPhone,
  getCachedCustomerByPhone,
  invalidateCustomerCache,
  normalizePhoneForCache,
  getOrdersVersion,
  invalidateOrdersCache,
  ordersCacheKey,
  getInventoryVersion,
  invalidateInventoryCache,
  inventoryCacheKey,
  getFloorsVersion,
  invalidateFloorsCache,
  floorsCacheKey,
  kotCacheKey,
  dashboardCacheKey,
};
