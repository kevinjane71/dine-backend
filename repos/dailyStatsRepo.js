/**
 * dailyStatsRepo.js — PostgreSQL data access for daily_stats table.
 *
 * All methods return Firestore-shaped camelCase objects so existing
 * endpoint code (aggregateDailyStats, etc.) works unchanged.
 */

const { query } = require('./pgClient');
const { toPgRow, toFirestoreObj, buildInsert, toJsonbValue } = require('./dailyStatsFieldMapper');

/**
 * Get a single dailyStats doc by ID.
 * Replaces: db.collection('dailyStats').doc(docId).get()
 *
 * @param {string} docId — e.g. "rest123_2026-06-18"
 * @returns {Object|null} Firestore-shaped camelCase object or null
 */
async function getById(docId) {
  const result = await query('SELECT * FROM daily_stats WHERE id = $1', [docId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

/**
 * Get multiple dailyStats docs by IDs (batch read).
 * Replaces: db.getAll(...refs) for dailyStats
 *
 * @param {string[]} docIds — array of doc IDs
 * @returns {Object[]} Array of Firestore-shaped objects (only existing docs)
 */
async function getByIds(docIds) {
  if (!docIds || docIds.length === 0) return [];

  // Build parameterized IN query
  const placeholders = docIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(
    `SELECT * FROM daily_stats WHERE id IN (${placeholders})`,
    docIds
  );

  return result.rows.map(toFirestoreObj);
}

/**
 * Get all dailyStats docs for a specific date (across all restaurants).
 * Replaces: db.collection('dailyStats').where('date', '==', dateStr).get()
 *
 * @param {string} dateStr — "YYYY-MM-DD"
 * @returns {Object[]} Array of Firestore-shaped objects
 */
async function getByDate(dateStr) {
  const result = await query(
    'SELECT * FROM daily_stats WHERE date = $1',
    [dateStr]
  );
  return result.rows.map(toFirestoreObj);
}

/**
 * Get dailyStats docs for a restaurant where sub_restaurant_id is not null.
 * Replaces: db.collection('dailyStats').where('restaurantId', '==', rid).where('subRestaurantId', '!=', null).get()
 *
 * @param {string} restaurantId
 * @returns {Object[]} Array of Firestore-shaped objects
 */
async function getSubRestaurantStats(restaurantId) {
  const result = await query(
    'SELECT * FROM daily_stats WHERE restaurant_id = $1 AND sub_restaurant_id IS NOT NULL',
    [restaurantId]
  );
  return result.rows.map(toFirestoreObj);
}

/**
 * Get all dailyStats docs for multiple dates (across all restaurants).
 * Replaces: db.collection('dailyStats').where('date', 'in', dateStrings).get()
 *
 * @param {string[]} dateStrings — array of "YYYY-MM-DD"
 * @returns {Object[]} Array of Firestore-shaped objects
 */
async function getByDates(dateStrings) {
  if (!dateStrings || dateStrings.length === 0) return [];
  const placeholders = dateStrings.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(
    `SELECT * FROM daily_stats WHERE date IN (${placeholders})`,
    dateStrings
  );
  return result.rows.map(toFirestoreObj);
}

/**
 * Atomic upsert for dailyStats — replaces Firestore set({merge:true}) + FieldValue.increment().
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE with additive semantics:
 *   - Numeric columns: existing + new value (increment behavior)
 *   - JSONB columns: deep merge (payment_methods, order_types, item_counts, etc.)
 *   - customer_ids: array concatenation with dedup
 *
 * @param {string} docId — e.g. "rest123_2026-06-18"
 * @param {Object} increments — plain object with numeric deltas and JSONB data:
 *   {
 *     restaurantId, date, subRestaurantId?, subRestaurantName?,
 *     totalOrders: 1, totalRevenue: 500, totalRevenueWithTax: 550,
 *     totalDueAmount: 0, totalTax: 50, totalDiscounts: 0, totalRefunds: 0,
 *     paymentMethods: { cash: { transactions: 1, amount: 550 } },
 *     orderTypes: { dine_in: { count: 1, revenue: 550 } },
 *     hourBucket: "hour_14",  // which hour column to increment
 *     customerIds: ["cust123"],
 *     itemCounts: { "Burger": { qty: 2, revenue: 400 } },
 *     categoryBreakdown: { "Main Course": { itemsSold: 2, revenue: 400 } },
 *   }
 */
async function atomicUpsert(docId, increments) {
  const {
    restaurantId, date, subRestaurantId, subRestaurantName,
    totalOrders = 0, totalRevenue = 0, totalRevenueWithTax = 0,
    totalDueAmount = 0, totalTax = 0, totalDiscounts = 0, totalRefunds = 0,
    paymentMethods = {}, orderTypes = {},
    hourBucket, // e.g. "hour_14"
    customerIds = [],
    itemCounts = {},
    categoryBreakdown = {},
  } = increments;

  // Validate hour bucket
  const validHour = hourBucket && /^hour_\d{2}$/.test(hourBucket) ? hourBucket : null;

  // Build the hour column increment clause
  const hourIncrements = [];
  for (let h = 0; h < 24; h++) {
    const col = `hour_${h.toString().padStart(2, '0')}`;
    if (col === validHour) {
      hourIncrements.push(`${col} = COALESCE(daily_stats.${col}, 0) + 1`);
    }
    // Non-matching hours: no clause needed (they keep their value via ON CONFLICT)
  }

  const sql = `
    INSERT INTO daily_stats (
      id, restaurant_id, date, sub_restaurant_id, sub_restaurant_name,
      total_orders, total_revenue, total_revenue_with_tax,
      total_due_amount, total_tax, total_discounts, total_refunds,
      ${validHour ? `${validHour},` : ''}
      payment_methods, order_types, item_counts, category_breakdown, customer_ids,
      created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11, $12,
      ${validHour ? '1,' : ''}
      $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
      NOW(), NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      total_orders = daily_stats.total_orders + $6,
      total_revenue = daily_stats.total_revenue + $7,
      total_revenue_with_tax = daily_stats.total_revenue_with_tax + $8,
      total_due_amount = daily_stats.total_due_amount + $9,
      total_tax = daily_stats.total_tax + $10,
      total_discounts = daily_stats.total_discounts + $11,
      total_refunds = daily_stats.total_refunds + $12,
      ${hourIncrements.length > 0 ? hourIncrements.join(', ') + ',' : ''}
      payment_methods = daily_stats_merge_jsonb(daily_stats.payment_methods, $13::jsonb),
      order_types = daily_stats_merge_jsonb(daily_stats.order_types, $14::jsonb),
      item_counts = daily_stats_merge_jsonb(daily_stats.item_counts, $15::jsonb),
      category_breakdown = daily_stats_merge_jsonb(daily_stats.category_breakdown, $16::jsonb),
      customer_ids = daily_stats_merge_array(daily_stats.customer_ids, $17::jsonb),
      updated_at = NOW()
  `;

  const values = [
    docId, restaurantId, date, subRestaurantId || null, subRestaurantName || null,
    totalOrders, totalRevenue, totalRevenueWithTax,
    totalDueAmount, totalTax, totalDiscounts, totalRefunds,
    JSON.stringify(paymentMethods),
    JSON.stringify(orderTypes),
    JSON.stringify(itemCounts),
    JSON.stringify(categoryBreakdown),
    JSON.stringify(customerIds),
  ];

  await query(sql, values);
}

/**
 * Simple upsert for revenue diff updates (updateDailyStatsRevenueDiff).
 * Only increments totalRevenue and totalRevenueWithTax.
 *
 * @param {string} docId
 * @param {string} restaurantId
 * @param {string} date
 * @param {number} revenueDiff
 * @param {number} revenueWithTaxDiff
 * @param {string|null} subRestaurantId
 * @param {string|null} subRestaurantName
 */
async function upsertRevenueDiff(docId, restaurantId, date, revenueDiff, revenueWithTaxDiff, subRestaurantId, subRestaurantName) {
  const sql = `
    INSERT INTO daily_stats (id, restaurant_id, date, sub_restaurant_id, sub_restaurant_name,
                             total_revenue, total_revenue_with_tax, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      total_revenue = daily_stats.total_revenue + $6,
      total_revenue_with_tax = daily_stats.total_revenue_with_tax + $7,
      updated_at = NOW()
  `;
  await query(sql, [
    docId, restaurantId, date,
    subRestaurantId || null, subRestaurantName || null,
    revenueDiff, revenueWithTaxDiff,
  ]);
}

/**
 * Create a single dailyStats doc (for backfill).
 *
 * @param {Object} firestoreData — Firestore doc data (with id)
 * @returns {Object|null} Inserted row as camelCase object
 */
async function create(firestoreData) {
  const pgRow = toPgRow(firestoreData);
  const { text, values } = buildInsert(pgRow);
  // Use ON CONFLICT DO NOTHING for idempotent backfill
  const idempotentText = text.replace('RETURNING *', 'ON CONFLICT (id) DO NOTHING RETURNING *');
  const result = await query(idempotentText, values);
  return result.rows.length > 0 ? toFirestoreObj(result.rows[0]) : null;
}

module.exports = {
  getById,
  getByIds,
  getByDate,
  getByDates,
  getSubRestaurantStats,
  atomicUpsert,
  upsertRevenueDiff,
  create,
};
