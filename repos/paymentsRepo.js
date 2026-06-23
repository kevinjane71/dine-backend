/**
 * paymentsRepo.js — PostgreSQL data access for dine_payments,
 * dine_subscriptions, and dine_razorpay_orders.
 *
 * All methods return Firestore-shaped camelCase objects so existing
 * endpoint code works unchanged.
 */

const { query } = require('./pgClient');
const {
  paymentsToPgRow, paymentsToFirestoreObj, PAYMENTS_JSONB_COLUMNS,
  subscriptionsToPgRow, subscriptionsToFirestoreObj, SUBSCRIPTIONS_JSONB_COLUMNS,
  ordersToPgRow, ordersToFirestoreObj, ORDERS_JSONB_COLUMNS,
} = require('./paymentsFieldMapper');

function jsonbVal(col, val, jsonbCols) {
  return jsonbCols.has(col) && val !== null && val !== undefined
    ? JSON.stringify(val) : val;
}

function buildUpsertSQL(tableName, pgRow, jsonbCols) {
  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) =>
    jsonbCols.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
  ).join(', ');
  const values = cols.map(c => jsonbVal(c, pgRow[c], jsonbCols));
  const updateCols = cols.filter(c => c !== 'id');
  const updateSet = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');

  return {
    text: `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (id) DO UPDATE SET ${updateSet}
           RETURNING *`,
    values,
  };
}

function buildUpdateSQL(tableName, id, pgRow, jsonbCols) {
  delete pgRow.id;
  const cols = Object.keys(pgRow);
  if (cols.length === 0) return null;

  const setClauses = [];
  const values = [];
  let i = 1;

  for (const col of cols) {
    if (jsonbCols.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(jsonbVal(col, pgRow[col], jsonbCols));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(pgRow[col]);
    }
    i++;
  }

  values.push(id);
  return {
    text: `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values,
  };
}

// ── dine_payments ─────────────────────────────────────────────────────────

async function createPayment(paymentId, data) {
  const pgRow = paymentsToPgRow({ id: paymentId, ...data });
  if (!pgRow.id) pgRow.id = paymentId;
  const q = buildUpsertSQL('dine_payments', pgRow, PAYMENTS_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? paymentsToFirestoreObj(result.rows[0]) : null;
}

async function updatePayment(paymentId, updates) {
  const pgRow = paymentsToPgRow(updates);
  delete pgRow.updated_at;
  pgRow.updated_at = new Date();
  const q = buildUpdateSQL('dine_payments', paymentId, pgRow, PAYMENTS_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function getPaymentById(paymentId) {
  const result = await query('SELECT * FROM dine_payments WHERE id = $1', [paymentId]);
  if (result.rows.length === 0) return null;
  return paymentsToFirestoreObj(result.rows[0]);
}

async function getPaymentsByUser(userId, { limit = 10 } = {}) {
  const result = await query(
    `SELECT * FROM dine_payments WHERE user_id = $1 AND app = 'Dine' ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map(paymentsToFirestoreObj);
}

// ── dine_subscriptions ────────────────────────────────────────────────────

async function createSubscription(subId, data) {
  const pgRow = subscriptionsToPgRow({ id: subId, ...data });
  if (!pgRow.id) pgRow.id = subId;
  const q = buildUpsertSQL('dine_subscriptions', pgRow, SUBSCRIPTIONS_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? subscriptionsToFirestoreObj(result.rows[0]) : null;
}

async function updateSubscription(subId, updates) {
  const pgRow = subscriptionsToPgRow(updates);
  delete pgRow.updated_at;
  pgRow.updated_at = new Date();
  const q = buildUpdateSQL('dine_subscriptions', subId, pgRow, SUBSCRIPTIONS_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function getSubscriptionById(subId) {
  const result = await query('SELECT * FROM dine_subscriptions WHERE id = $1', [subId]);
  if (result.rows.length === 0) return null;
  return subscriptionsToFirestoreObj(result.rows[0]);
}

// ── dine_razorpay_orders ──────────────────────────────────────────────────

async function createRazorpayOrder(orderId, data) {
  const pgRow = ordersToPgRow({ id: orderId, ...data });
  if (!pgRow.id) pgRow.id = orderId;
  const q = buildUpsertSQL('dine_razorpay_orders', pgRow, ORDERS_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? ordersToFirestoreObj(result.rows[0]) : null;
}

async function updateRazorpayOrder(orderId, updates) {
  const pgRow = ordersToPgRow(updates);
  delete pgRow.updated_at;
  pgRow.updated_at = new Date();
  const q = buildUpdateSQL('dine_razorpay_orders', orderId, pgRow, ORDERS_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function getRazorpayOrderById(orderId) {
  const result = await query('SELECT * FROM dine_razorpay_orders WHERE id = $1', [orderId]);
  if (result.rows.length === 0) return null;
  return ordersToFirestoreObj(result.rows[0]);
}

async function getRazorpayOrdersByUser(userId) {
  const result = await query(
    `SELECT * FROM dine_razorpay_orders WHERE user_id = $1 AND app = 'Dine' ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map(ordersToFirestoreObj);
}

module.exports = {
  // Payments
  createPayment,
  updatePayment,
  getPaymentById,
  getPaymentsByUser,

  // Subscriptions
  createSubscription,
  updateSubscription,
  getSubscriptionById,

  // Razorpay Orders
  createRazorpayOrder,
  updateRazorpayOrder,
  getRazorpayOrderById,
  getRazorpayOrdersByUser,
};
