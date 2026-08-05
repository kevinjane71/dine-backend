/**
 * Order numbering for the unified offline/online POS.
 *
 * Problem: two offline terminals must never mint the same human order number.
 * Solution (Toast-style):
 *   - Internal id = UUID / Firestore id (already collision-safe).
 *   - The HUB is the ONLY issuer of the real sequential number, via an atomic
 *     per-restaurant-per-day counter (single-statement UPSERT → no race).
 *   - Offline, a Terminal shows a device-tagged PROVISIONAL number ("T2-P7") that
 *     can't collide (device-scoped); the Hub swaps in the real number on sync.
 *
 * ADDITIVE, isolated: does not touch the existing daily_order_counters flow.
 */
const { query } = require('../../repos/pgClient');

/**
 * HUB: atomically issue the next sequential number for (restaurant, day).
 * Single INSERT..ON CONFLICT DO UPDATE ... RETURNING → race-free even under concurrency.
 * @returns integer sequence (1, 2, 3, ...)
 */
async function issueDailyNumber(restaurantId, dayStr) {
  if (!restaurantId || !dayStr) throw new Error('restaurantId and dayStr required');
  const r = await query(
    `INSERT INTO order_number_counters (restaurant_id, day, last_seq)
     VALUES ($1, $2, 1)
     ON CONFLICT (restaurant_id, day)
     DO UPDATE SET last_seq = order_number_counters.last_seq + 1, updated_at = now()
     RETURNING last_seq`,
    [restaurantId, dayStr]
  );
  return r.rows[0].last_seq;
}

/** Peek the current counter without incrementing (for display/debug). */
async function peekDailyNumber(restaurantId, dayStr) {
  const r = await query(
    'SELECT last_seq FROM order_number_counters WHERE restaurant_id = $1 AND day = $2',
    [restaurantId, dayStr]
  );
  return r.rows.length ? r.rows[0].last_seq : 0;
}

/**
 * TERMINAL (offline): a provisional number that can't collide across devices.
 * e.g. deviceTag "T2" + localSeq 7 → "T2-P7". Replaced by the Hub's real number on sync.
 */
function provisionalNumber(deviceTag, localSeq) {
  const tag = String(deviceTag || 'T?').replace(/[^A-Za-z0-9]/g, '');
  return `${tag}-P${localSeq}`;
}

function isProvisional(num) {
  return typeof num === 'string' && /^[A-Za-z0-9]+-P\d+$/.test(num);
}

module.exports = { issueDailyNumber, peekDailyNumber, provisionalNumber, isProvisional };
