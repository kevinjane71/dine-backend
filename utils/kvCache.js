/**
 * KV Cache Utility (Upstash Redis)
 * Persistent cache layer for Vercel serverless — survives cold starts.
 *
 * All methods are safe: if Redis is not configured or fails,
 * they return null / silently fail. Zero impact on existing functionality.
 */

let redis = null;

function getRedis() {
  if (redis) return redis;

  // Only initialize if env vars are present
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return null;
  }

  try {
    const { Redis } = require('@upstash/redis');
    redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    return redis;
  } catch (err) {
    console.error('KV Cache: Failed to initialize Redis:', err.message);
    return null;
  }
}

/**
 * Get a value from KV cache
 * @param {string} key
 * @returns {any|null} Cached value or null
 */
async function kvGet(key) {
  try {
    const client = getRedis();
    if (!client) return null;
    const value = await client.get(key);
    return value || null;
  } catch (err) {
    // Silent fail — fall back to Firestore
    return null;
  }
}

/**
 * Set a value in KV cache with TTL
 * @param {string} key
 * @param {any} data
 * @param {number} ttlSeconds - Time to live in seconds (default: 180 = 3 min)
 */
async function kvSet(key, data, ttlSeconds = 180) {
  try {
    const client = getRedis();
    if (!client) return;
    await client.set(key, data, { ex: ttlSeconds });
  } catch (err) {
    // Silent fail
  }
}

/**
 * Delete a key from KV cache (for invalidation)
 * @param {string} key
 */
async function kvDel(key) {
  try {
    const client = getRedis();
    if (!client) return;
    await client.del(key);
  } catch (err) {
    // Silent fail
  }
}

/**
 * Get restaurant doc with KV caching (3 min TTL)
 * Falls back to direct Firestore read if KV unavailable or cache miss.
 *
 * @param {object} db - Firestore db instance
 * @param {string} collection - Collection name (e.g. 'restaurants')
 * @param {string} restaurantId - Restaurant document ID
 * @returns {object|null} { doc, data } — doc is the Firestore DocumentSnapshot, data is doc.data()
 */
async function getCachedRestaurant(db, collection, restaurantId) {
  const cacheKey = `restaurant:${restaurantId}`;

  // Try KV cache first
  const cached = await kvGet(cacheKey);
  if (cached) {
    return { data: cached, fromCache: true };
  }

  // Cache miss — read from Firestore
  const doc = await db.collection(collection).doc(restaurantId).get();
  if (!doc.exists) {
    return { doc, data: null, fromCache: false };
  }

  const data = doc.data();

  // Store in cache (fire-and-forget, don't await)
  kvSet(cacheKey, data, 180).catch(() => {});

  return { doc, data, fromCache: false };
}

/**
 * Invalidate restaurant cache after a write
 * @param {string} restaurantId
 */
function invalidateRestaurantCache(restaurantId) {
  kvDel(`restaurant:${restaurantId}`).catch(() => {});
}

/**
 * Invalidate user status cache after status change
 * @param {string} userId
 */
function invalidateUserCache(userId) {
  kvDel(`user:${userId}`).catch(() => {});
}

module.exports = {
  kvGet,
  kvSet,
  kvDel,
  getCachedRestaurant,
  invalidateRestaurantCache,
  invalidateUserCache,
};
