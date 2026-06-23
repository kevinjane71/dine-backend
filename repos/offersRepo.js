/**
 * offersRepo.js — PostgreSQL data access for offers + customer offer usage.
 *
 * All methods return Firestore-shaped camelCase objects so existing
 * endpoint code works unchanged.
 */

const { query } = require('./pgClient');
const { toPgRow, toFirestoreObj, JSONB_COLUMNS } = require('./offersFieldMapper');

function jsonbVal(col, val) {
  return JSONB_COLUMNS.has(col) && val !== null && val !== undefined
    ? JSON.stringify(val) : val;
}

// ── Offers Reads ─────────────────────────────────────────────────────────

async function getById(offerId) {
  const result = await query('SELECT * FROM offers WHERE id = $1', [offerId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function getByRestaurant(restaurantId, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM offers WHERE restaurant_id = $1 AND is_active = true ORDER BY created_at DESC'
    : 'SELECT * FROM offers WHERE restaurant_id = $1 ORDER BY created_at DESC';
  const result = await query(sql, [restaurantId]);
  return result.rows.map(toFirestoreObj);
}

async function getActiveByRestaurantIds(restaurantIds) {
  if (!restaurantIds || restaurantIds.length === 0) return [];
  const placeholders = restaurantIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(
    `SELECT * FROM offers WHERE restaurant_id IN (${placeholders}) AND is_active = true ORDER BY created_at DESC`,
    restaurantIds
  );
  return result.rows.map(toFirestoreObj);
}

// ── Offers Writes ────────────────────────────────────────────────────────

async function create(offerId, data) {
  const pgRow = toPgRow({ id: offerId, ...data });
  if (!pgRow.id) pgRow.id = offerId;

  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) =>
    JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
  ).join(', ');
  const values = cols.map(c => jsonbVal(c, pgRow[c]));

  const result = await query(
    `INSERT INTO offers (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET
       ${cols.filter(c => c !== 'id').map(c => `${c} = EXCLUDED.${c}`).join(', ')}
     RETURNING *`,
    values
  );
  return result.rows.length > 0 ? toFirestoreObj(result.rows[0]) : null;
}

async function update(offerId, updates) {
  const pgRow = toPgRow(updates);
  delete pgRow.id;
  delete pgRow.updated_at;

  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;

  const setClauses = [];
  const values = [];
  let i = 1;

  for (const col of cols) {
    if (JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(jsonbVal(col, pgRow[col]));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(pgRow[col]);
    }
    i++;
  }

  setClauses.push('updated_at = NOW()');
  values.push(offerId);

  await query(
    `UPDATE offers SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values
  );
}

/**
 * Atomic increment of usage_count (replaces FieldValue.increment(1)).
 */
async function incrementUsageCount(offerId, amount = 1) {
  await query(
    `UPDATE offers SET usage_count = COALESCE(usage_count, 0) + $1, updated_at = NOW() WHERE id = $2`,
    [amount, offerId]
  );
}

async function remove(offerId) {
  await query('DELETE FROM offers WHERE id = $1', [offerId]);
}

// ── Customer Offer Usage (flattened subcollection) ───────────────────────

/**
 * Get usage counts for a customer across multiple offers.
 * @param {string[]} offerIds
 * @param {string} customerKey - customerId or 'phone:<digits>'
 * @returns {Object} { [offerId]: usageCount }
 */
async function getCustomerUsageMap(offerIds, customerKey) {
  if (!offerIds || offerIds.length === 0) return {};
  const placeholders = offerIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(
    `SELECT offer_id, usage_count FROM customer_offer_usage
     WHERE offer_id IN (${placeholders}) AND customer_key = $${offerIds.length + 1}`,
    [...offerIds, customerKey]
  );
  const map = {};
  for (const row of result.rows) {
    map[row.offer_id] = row.usage_count;
  }
  return map;
}

/**
 * Atomically increment per-customer usage (replaces Firestore transaction).
 */
async function incrementCustomerUsage(offerId, customerKey) {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO customer_offer_usage (offer_id, customer_key, usage_count, first_used_at, last_used_at)
     VALUES ($1, $2, 1, $3, $3)
     ON CONFLICT (offer_id, customer_key) DO UPDATE
       SET usage_count = customer_offer_usage.usage_count + 1,
           last_used_at = $3`,
    [offerId, customerKey, now]
  );
}

/**
 * Decrement per-customer usage (for order reversal).
 */
async function decrementCustomerUsage(offerId, customerKey) {
  await query(
    `UPDATE customer_offer_usage
     SET usage_count = GREATEST(0, usage_count - 1)
     WHERE offer_id = $1 AND customer_key = $2`,
    [offerId, customerKey]
  );
}

module.exports = {
  getById,
  getByRestaurant,
  getActiveByRestaurantIds,
  create,
  update,
  incrementUsageCount,
  remove,
  getCustomerUsageMap,
  incrementCustomerUsage,
  decrementCustomerUsage,
};
