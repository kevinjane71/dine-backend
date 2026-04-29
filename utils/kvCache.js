/**
 * KV Cache Utility (Upstash Redis)
 * Persistent cache layer for Vercel serverless — survives cold starts.
 *
 * All methods are safe: if Redis is not configured or fails,
 * they return null / silently fail. Zero impact on existing functionality.
 *
 * REQUIRES: KV_REST_API_URL + KV_REST_API_TOKEN env vars.
 * REDIS_URL alone is NOT enough (it's the Redis protocol URL, not the REST API).
 */

let redis = null;
let redisDisabled = false;

function getRedis() {
  if (redisDisabled) return null;
  if (redis) return redis;

  try {
    // Only use explicit REST API vars — these are the correct ones for @upstash/redis
    if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      const { Redis } = require('@upstash/redis');
      redis = new Redis({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      console.log('KV Cache: Initialized from KV_REST_API_URL');
      return redis;
    }

    // REDIS_URL is the Redis protocol URL — NOT usable by @upstash/redis REST client.
    // If you only have REDIS_URL, you need to also add KV_REST_API_URL and KV_REST_API_TOKEN.
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
    const value = await withTimeout(client.get(key), 2000);
    return value || null;
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
    await withTimeout(client.set(key, data, { ex: ttlSeconds }), 2000);
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

function invalidateUserCache(userId) {
  kvDel(`user:${userId}`).catch(() => {});
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
  getCachedRestaurant,
  invalidateRestaurantCache,
  invalidateUserCache,
  cacheCustomerByPhone,
  getCachedCustomerByPhone,
  invalidateCustomerCache,
  normalizePhoneForCache,
};
