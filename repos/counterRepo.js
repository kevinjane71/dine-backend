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

/**
 * Generate next daily order ID (resets each day).
 * Drop-in replacement for the Firestore-based generateDailyOrderId.
 *
 * @param {string} restaurantId
 * @returns {Promise<number>}
 */
async function generateDailyOrderId(restaurantId) {
  const todayStr = new Date().toISOString().split('T')[0];
  return incrementDailyCounter(restaurantId, 'daily_order', todayStr);
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
  return incrementDailyCounter(restaurantId, 'tab', todayStr);
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
