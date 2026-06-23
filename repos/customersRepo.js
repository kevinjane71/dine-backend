/**
 * customersRepo.js — PostgreSQL data access for customers.
 *
 * All methods return Firestore-shaped camelCase objects so existing
 * endpoint code works unchanged.
 */

const { query } = require('./pgClient');
const { toPgRow, toFirestoreObj, JSONB_COLUMNS } = require('./customersFieldMapper');

// ── Helpers ──────────────────────────────────────────────────────────────

function jsonbVal(col, val) {
  return JSONB_COLUMNS.has(col) && val !== null && val !== undefined
    ? JSON.stringify(val) : val;
}

function jsonbCast(col, i) {
  return JSONB_COLUMNS.has(col) ? `$${i}::jsonb` : `$${i}`;
}

// ── Reads ────────────────────────────────────────────────────────────────

async function getById(customerId) {
  const result = await query('SELECT * FROM customers WHERE id = $1', [customerId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function getByRestaurant(restaurantId, { limit = 500, orderBy = 'last_order_date', order = 'DESC' } = {}) {
  const validCols = ['last_order_date', 'created_at', 'name', 'total_orders', 'total_spent'];
  const col = validCols.includes(orderBy) ? orderBy : 'last_order_date';
  const dir = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const result = await query(
    `SELECT * FROM customers WHERE restaurant_id = $1 ORDER BY ${col} ${dir} NULLS LAST LIMIT $2`,
    [restaurantId, limit]
  );
  return result.rows.map(toFirestoreObj);
}

async function getByPhone(restaurantId, phone) {
  const result = await query(
    'SELECT * FROM customers WHERE restaurant_id = $1 AND phone = $2 LIMIT 1',
    [restaurantId, phone]
  );
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function getByPhonePrefix(restaurantId, phonePrefix) {
  const result = await query(
    'SELECT * FROM customers WHERE restaurant_id = $1 AND phone LIKE $2 LIMIT 1',
    [restaurantId, phonePrefix + '%']
  );
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function getByEmail(restaurantId, email) {
  const result = await query(
    'SELECT * FROM customers WHERE restaurant_id = $1 AND email = $2 LIMIT 1',
    [restaurantId, email]
  );
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function getByFirebaseUid(restaurantId, firebaseUid) {
  const result = await query(
    'SELECT * FROM customers WHERE restaurant_id = $1 AND firebase_uid = $2 LIMIT 1',
    [restaurantId, firebaseUid]
  );
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function search(restaurantId, searchTerm, { limit = 50 } = {}) {
  const pattern = `%${searchTerm}%`;
  const result = await query(
    `SELECT * FROM customers
     WHERE restaurant_id = $1
       AND (name ILIKE $2 OR phone ILIKE $2 OR email ILIKE $2)
     ORDER BY last_order_date DESC NULLS LAST
     LIMIT $3`,
    [restaurantId, pattern, limit]
  );
  return result.rows.map(toFirestoreObj);
}

async function countByRestaurant(restaurantId) {
  const result = await query(
    'SELECT COUNT(*) as c FROM customers WHERE restaurant_id = $1',
    [restaurantId]
  );
  return parseInt(result.rows[0].c, 10);
}

/**
 * Get minimal customer data by phone (for cache/lookup).
 * Returns { id, phone } or null.
 */
async function getMinimalByPhone(restaurantId, phone) {
  const result = await query(
    'SELECT id, phone FROM customers WHERE restaurant_id = $1 AND phone = $2 LIMIT 1',
    [restaurantId, phone]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

// ── Writes ───────────────────────────────────────────────────────────────

async function create(customerId, data) {
  const pgRow = toPgRow({ id: customerId, ...data });
  if (!pgRow.id) pgRow.id = customerId;

  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) => jsonbCast(c, i + 1)).join(', ');
  const values = cols.map(c => jsonbVal(c, pgRow[c]));

  const result = await query(
    `INSERT INTO customers (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET
       ${cols.filter(c => c !== 'id').map(c =>
         JSONB_COLUMNS.has(c)
           ? `${c} = EXCLUDED.${c}`
           : `${c} = EXCLUDED.${c}`
       ).join(', ')}
     RETURNING *`,
    values
  );
  return result.rows.length > 0 ? toFirestoreObj(result.rows[0]) : null;
}

async function update(customerId, updates) {
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
  values.push(customerId);

  await query(
    `UPDATE customers SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values
  );
}

/**
 * Atomic increment for numeric fields (replaces FieldValue.increment).
 * @param {string} customerId
 * @param {Object} increments - { totalOrders: 1, totalSpent: 500, loyaltyPoints: 10, ... }
 * @param {Object} [sets] - Additional fields to SET (non-incremental), e.g. { lastOrderDate: new Date() }
 */
async function incrementFields(customerId, increments, sets = {}) {
  const setClauses = [];
  const values = [];
  let i = 1;

  // Map camelCase increment fields to snake_case
  const fieldMap = {
    totalOrders: 'total_orders',
    totalSpent: 'total_spent',
    loyaltyPoints: 'loyalty_points',
    lifetimePoints: 'lifetime_points',
    outstandingBalance: 'outstanding_balance',
    walletBalance: 'wallet_balance',
    tipEarnings: 'tip_earnings',
  };

  for (const [camelField, amount] of Object.entries(increments)) {
    const pgCol = fieldMap[camelField];
    if (!pgCol) continue;
    setClauses.push(`${pgCol} = COALESCE(${pgCol}, 0) + $${i}`);
    values.push(amount);
    i++;
  }

  // Additional SET fields
  const pgSets = toPgRow(sets);
  delete pgSets.id;
  delete pgSets.updated_at;
  for (const [col, val] of Object.entries(pgSets)) {
    if (JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(jsonbVal(col, val));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(val);
    }
    i++;
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = NOW()');
  values.push(customerId);

  await query(
    `UPDATE customers SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values
  );
}

/**
 * Append an entry to a JSONB array field (replaces FieldValue.arrayUnion).
 * @param {string} customerId
 * @param {string} field - camelCase field name (e.g. 'orderHistory', 'creditHistory')
 * @param {Object} entry - The object to append
 */
async function arrayAppend(customerId, field, entry) {
  const fieldMap = {
    orderHistory: 'order_history',
    creditHistory: 'credit_history',
    walletHistory: 'wallet_history',
    tipHistory: 'tip_history',
    loyaltyTransactions: 'loyalty_transactions',
    settlementHistory: 'settlement_history',
  };

  const pgCol = fieldMap[field];
  if (!pgCol) return;

  await query(
    `UPDATE customers
     SET ${pgCol} = COALESCE(${pgCol}, '[]'::jsonb) || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify([entry]), customerId]
  );
}

async function remove(customerId) {
  await query('DELETE FROM customers WHERE id = $1', [customerId]);
}

async function bulkDelete(customerIds) {
  if (!customerIds || customerIds.length === 0) return;
  const placeholders = customerIds.map((_, i) => `$${i + 1}`).join(', ');
  await query(
    `DELETE FROM customers WHERE id IN (${placeholders})`,
    customerIds
  );
}

module.exports = {
  getById,
  getByRestaurant,
  getByPhone,
  getByPhonePrefix,
  getByEmail,
  getByFirebaseUid,
  search,
  countByRestaurant,
  getMinimalByPhone,
  create,
  update,
  incrementFields,
  arrayAppend,
  remove,
  bulkDelete,
};
