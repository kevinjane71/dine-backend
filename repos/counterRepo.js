/**
 * counterRepo.js — PostgreSQL atomic counters for order IDs and tab numbers.
 *
 * Replaces Firestore transactions with atomic INSERT...ON CONFLICT DO UPDATE...RETURNING.
 * Zero race conditions, no distributed locks needed.
 *
 * Counter types:
 *   - 'daily_order'      — resets each day, used for dailyOrderId
 *   - 'sequential_order' — never resets, used for permanent order numbering
 *   - 'tab'              — resets each day, used for bar tab numbers
 */

const { query } = require('./pgClient');

/**
 * Atomically increment a daily counter and return the new value.
 * If it's a new day (or first ever), starts from 1.
 *
 * Uses a single atomic upsert — safe under concurrent requests.
 *
 * @param {string} restaurantId
 * @param {string} counterType - 'daily_order' | 'tab'
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<number>} The new counter value
 */
async function incrementDailyCounter(restaurantId, counterType, date) {
  const id = `${restaurantId}_${counterType}_${date}`;

  const result = await query(
    `INSERT INTO order_counters (id, restaurant_id, counter_type, date, last_value, updated_at)
     VALUES ($1, $2, $3, $4, 1, NOW())
     ON CONFLICT (id) DO UPDATE
       SET last_value = order_counters.last_value + 1,
           updated_at = NOW()
     RETURNING last_value`,
    [id, restaurantId, counterType, date]
  );

  return result.rows[0].last_value;
}

/**
 * Atomically increment a sequential (never-resetting) counter.
 *
 * @param {string} restaurantId
 * @param {string} counterType - 'sequential_order'
 * @returns {Promise<number>} The new counter value
 */
async function incrementSequentialCounter(restaurantId, counterType) {
  const id = `${restaurantId}_${counterType}`;

  const result = await query(
    `INSERT INTO order_counters (id, restaurant_id, counter_type, last_value, updated_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (id) DO UPDATE
       SET last_value = order_counters.last_value + 1,
           updated_at = NOW()
     RETURNING last_value`,
    [id, restaurantId, counterType]
  );

  return result.rows[0].last_value;
}

// Offline order-number namespace. The offline local server and the cloud each mint a
// per-restaurant/per-date daily_order counter starting at 1 — so after sync two DIFFERENT
// orders would share the same dailyOrderId (lookups return the wrong order; receipts show
// duplicate numbers). In local-server mode we shift the offline numbers into a distinct high
// range so they can never collide with the cloud's low sequence. The underlying counter still
// stores 1,2,3… (small, resets daily); we only add the offset to the returned/stored id.
// Configurable via OFFLINE_ORDER_ID_OFFSET; 0 disables (e.g. a single-source deployment).
const OFFLINE_ORDER_ID_OFFSET = (() => {
  if (process.env.LOCAL_SERVER_MODE !== 'true') return 0;
  const v = parseInt(process.env.OFFLINE_ORDER_ID_OFFSET, 10);
  return Number.isFinite(v) ? v : 500000;
})();

/**
 * Generate next daily order ID (resets each day).
 * Drop-in replacement for the Firestore-based generateDailyOrderId.
 *
 * @param {string} restaurantId
 * @returns {Promise<number>}
 */
async function generateDailyOrderId(restaurantId) {
  const todayStr = new Date().toISOString().split('T')[0];
  const seq = await incrementDailyCounter(restaurantId, 'daily_order', todayStr);
  // Shift offline order numbers clear of the cloud's range so they never collide after sync.
  return OFFLINE_ORDER_ID_OFFSET ? OFFLINE_ORDER_ID_OFFSET + seq : seq;
}

/**
 * Generate next sequential order ID (never resets).
 * Drop-in replacement for the Firestore-based generateSequentialOrderId.
 *
 * @param {string} restaurantId
 * @returns {Promise<number>}
 */
async function generateSequentialOrderId(restaurantId) {
  return incrementSequentialCounter(restaurantId, 'sequential_order');
}

/**
 * Generate next tab number (resets each day).
 * Drop-in replacement for the Firestore-based getNextTabNumber.
 *
 * @param {string} restaurantId
 * @returns {Promise<number>}
 */
async function getNextTabNumber(restaurantId) {
  const todayStr = new Date().toISOString().split('T')[0];
  const seq = await incrementDailyCounter(restaurantId, 'tab', todayStr);
  // Same offline namespace as dailyOrderId so tab numbers can't collide after sync either.
  return OFFLINE_ORDER_ID_OFFSET ? OFFLINE_ORDER_ID_OFFSET + seq : seq;
}

/**
 * Get current counter value without incrementing (for backfill/inspection).
 *
 * @param {string} id - Counter document ID
 * @returns {Promise<number|null>}
 */
async function getCurrentValue(id) {
  const result = await query(
    'SELECT last_value FROM order_counters WHERE id = $1',
    [id]
  );
  return result.rows.length > 0 ? result.rows[0].last_value : null;
}

module.exports = {
  incrementDailyCounter,
  incrementSequentialCounter,
  generateDailyOrderId,
  generateSequentialOrderId,
  getNextTabNumber,
  getCurrentValue,
};
