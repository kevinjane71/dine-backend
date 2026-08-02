/**
 * dailyStatsFieldMapper.js — Maps between Firestore dailyStats docs and PostgreSQL daily_stats rows.
 *
 * Special handling for dynamic Firestore keys:
 *   paymentMethod_cash.transactions → payment_methods JSONB: {"cash": {"transactions": N, "amount": N}}
 *   ordersByType_dine_in            → order_types JSONB:     {"dine_in": {"count": N, "revenue": N}}
 *   orderTypeRevenue_dine_in        → (merged into order_types)
 *   itemCounts.Item Name.qty        → item_counts JSONB
 *   categoryBreakdown.Cat.itemsSold → category_breakdown JSONB
 */

// camelCase (Firestore) → snake_case (PostgreSQL) for simple 1:1 fields
const FIELD_MAP = {
  restaurantId: 'restaurant_id',
  date: 'date',
  subRestaurantId: 'sub_restaurant_id',
  subRestaurantName: 'sub_restaurant_name',
  totalOrders: 'total_orders',
  totalRevenue: 'total_revenue',
  totalRevenueWithTax: 'total_revenue_with_tax',
  totalDueAmount: 'total_due_amount',
  totalTax: 'total_tax',
  totalDiscounts: 'total_discounts',
  totalRefunds: 'total_refunds',
  refundsIssued: 'refunds_issued',
  totalCovers: 'total_covers',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

// Hour columns map to themselves (already snake_case)
for (let h = 0; h < 24; h++) {
  const key = `hour_${h.toString().padStart(2, '0')}`;
  FIELD_MAP[key] = key;
}

// Reverse map: snake_case → camelCase
const REVERSE_MAP = {};
for (const [camel, snake] of Object.entries(FIELD_MAP)) {
  REVERSE_MAP[snake] = camel;
}

// JSONB columns
const JSONB_COLUMNS = new Set([
  'payment_methods', 'order_types', 'item_counts',
  'category_breakdown', 'customer_ids', 'extra_data',
]);

// All known PG columns
const PG_COLUMNS = new Set(Object.values(FIELD_MAP));
PG_COLUMNS.add('id');
PG_COLUMNS.add('extra_data');
for (const jc of JSONB_COLUMNS) PG_COLUMNS.add(jc);

/**
 * Convert Firestore Timestamp objects to JS Date.
 */
function convertTimestamp(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && typeof val.toDate === 'function') return val.toDate();
  if (typeof val === 'object' && val._seconds !== undefined) return new Date(val._seconds * 1000);
  return val;
}

/**
 * Convert a Firestore dailyStats doc → PostgreSQL row.
 *
 * Handles dynamic Firestore keys:
 *   paymentMethod_cash.transactions → payment_methods.cash.transactions
 *   ordersByType_dine_in → order_types.dine_in.count
 *   orderTypeRevenue_dine_in → order_types.dine_in.revenue
 *   itemCounts.Burger.qty → item_counts.Burger.qty
 *   categoryBreakdown.Main.itemsSold → category_breakdown.Main.itemsSold
 *   customerIds → customer_ids (array)
 */
function toPgRow(firestoreObj) {
  const pgRow = {};
  const extraData = {};
  const paymentMethods = {};
  const orderTypes = {};
  let itemCounts = null;
  let categoryBreakdown = null;
  let customerIds = null;

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (key === 'id') {
      pgRow.id = value;
      continue;
    }

    // Skip FieldValue sentinels (serverTimestamp, etc.)
    if (value && typeof value === 'object' && typeof value.isEqual === 'function') {
      continue;
    }

    // Dynamic payment method keys: paymentMethod_cash, paymentMethod_card, etc.
    const pmMatch = key.match(/^paymentMethod_(.+)$/);
    if (pmMatch) {
      const method = pmMatch[1];
      // Value is an object like { transactions: N, amount: N } (from Firestore merge)
      // or it's a dot-notation key handled below
      if (typeof value === 'object' && value !== null) {
        paymentMethods[method] = {
          transactions: value.transactions || 0,
          amount: value.amount || 0,
        };
      }
      continue;
    }

    // Dynamic order type keys: ordersByType_dine_in, orderTypeRevenue_dine_in
    const otCountMatch = key.match(/^ordersByType_(.+)$/);
    if (otCountMatch) {
      const type = otCountMatch[1];
      if (!orderTypes[type]) orderTypes[type] = { count: 0, revenue: 0 };
      orderTypes[type].count = typeof value === 'number' ? value : 0;
      continue;
    }
    const otRevMatch = key.match(/^orderTypeRevenue_(.+)$/);
    if (otRevMatch) {
      const type = otRevMatch[1];
      if (!orderTypes[type]) orderTypes[type] = { count: 0, revenue: 0 };
      orderTypes[type].revenue = typeof value === 'number' ? value : 0;
      continue;
    }

    // Nested objects from Firestore merge: itemCounts, categoryBreakdown
    if (key === 'itemCounts' && typeof value === 'object') {
      itemCounts = value;
      continue;
    }
    if (key === 'categoryBreakdown' && typeof value === 'object') {
      categoryBreakdown = value;
      continue;
    }
    if (key === 'customerIds') {
      customerIds = Array.isArray(value) ? value : [];
      continue;
    }

    // Standard mapped fields
    const pgCol = FIELD_MAP[key];
    if (pgCol) {
      pgRow[pgCol] = convertTimestamp(value);
    } else {
      // Unknown → extra_data
      extraData[key] = convertTimestamp(value);
    }
  }

  // Set JSONB columns
  if (Object.keys(paymentMethods).length > 0) pgRow.payment_methods = paymentMethods;
  if (Object.keys(orderTypes).length > 0) pgRow.order_types = orderTypes;
  if (itemCounts) pgRow.item_counts = itemCounts;
  if (categoryBreakdown) pgRow.category_breakdown = categoryBreakdown;
  if (customerIds) pgRow.customer_ids = customerIds;
  if (Object.keys(extraData).length > 0) pgRow.extra_data = extraData;

  return pgRow;
}

/**
 * Convert a PostgreSQL row → Firestore-shaped camelCase object.
 *
 * Unpacks JSONB columns back to flat dynamic keys:
 *   payment_methods.cash.transactions → paymentMethod_cash: { transactions, amount }
 *   order_types.dine_in → ordersByType_dine_in + orderTypeRevenue_dine_in
 *   item_counts → itemCounts
 *   category_breakdown → categoryBreakdown
 *   customer_ids → customerIds
 */
function toFirestoreObj(pgRow) {
  const result = {};

  // extra_data (unmapped/overflow) first, at lowest priority; skip any key that is a mapped
  // column so a stale copy left in extra_data can never overwrite the real column.
  const ed = pgRow.extra_data;
  if (ed && typeof ed === 'object') {
    for (const [k, v] of Object.entries(ed)) {
      if (v === null || v === undefined) continue;
      if (FIELD_MAP[k] || REVERSE_MAP[k]) continue;
      result[k] = v;
    }
  }

  for (const [col, value] of Object.entries(pgRow)) {
    if (value === null || value === undefined) continue;

    if (col === 'id') {
      result.id = value;
      continue;
    }

    if (col === 'extra_data') continue; // handled above

    // Unpack payment_methods JSONB → flat paymentMethod_* keys
    if (col === 'payment_methods' && typeof value === 'object') {
      for (const [method, data] of Object.entries(value)) {
        result[`paymentMethod_${method}`] = data;
      }
      continue;
    }

    // Unpack order_types JSONB → ordersByType_* + orderTypeRevenue_*
    if (col === 'order_types' && typeof value === 'object') {
      for (const [type, data] of Object.entries(value)) {
        if (data.count !== undefined) result[`ordersByType_${type}`] = data.count;
        if (data.revenue !== undefined) result[`orderTypeRevenue_${type}`] = data.revenue;
      }
      continue;
    }

    // Pass through nested JSONB as-is with camelCase key
    if (col === 'item_counts') { result.itemCounts = value; continue; }
    if (col === 'category_breakdown') { result.categoryBreakdown = value; continue; }
    if (col === 'customer_ids') { result.customerIds = value; continue; }

    const camelKey = REVERSE_MAP[col];
    if (camelKey) {
      result[camelKey] = value;
    } else {
      result[col] = value;
    }
  }

  return result;
}

/**
 * Resolve dynamic Firestore keys to their real JSONB column + path so the
 * pgAdapter's update()/set() transforms (FieldValue.increment etc.) land in
 * the same place toPgRow/toFirestoreObj use. Returns { col, path } or null
 * for keys the generic fieldMap/camelToSnake resolution already handles.
 *
 *   paymentMethod_cash.transactions → { col: 'payment_methods', path: ['cash','transactions'] }
 *   ordersByType_dine_in            → { col: 'order_types',     path: ['dine_in','count'] }
 *   orderTypeRevenue_dine_in        → { col: 'order_types',     path: ['dine_in','revenue'] }
 */
function resolveKeyPath(key) {
  const parts = key.split('.');
  const top = parts[0];
  let m = top.match(/^paymentMethod_(.+)$/);
  if (m) return { col: 'payment_methods', path: [m[1], ...parts.slice(1)] };
  m = top.match(/^ordersByType_(.+)$/);
  if (m) return { col: 'order_types', path: [m[1], 'count', ...parts.slice(1)] };
  m = top.match(/^orderTypeRevenue_(.+)$/);
  if (m) return { col: 'order_types', path: [m[1], 'revenue', ...parts.slice(1)] };
  return null;
}

/**
 * Serialize a value for JSONB column.
 */
function toJsonbValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return JSON.stringify(val);
  return JSON.stringify(val);
}

/**
 * Build a parameterized INSERT query for daily_stats.
 */
function buildInsert(pgRow) {
  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const [col, val] of Object.entries(pgRow)) {
    cols.push(col);
    if (JSONB_COLUMNS.has(col)) {
      placeholders.push(`$${i}::jsonb`);
      values.push(toJsonbValue(val));
    } else {
      placeholders.push(`$${i}`);
      values.push(val);
    }
    i++;
  }

  return {
    text: `INSERT INTO daily_stats (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values,
  };
}

/**
 * Build a parameterized UPDATE query for daily_stats.
 */
function buildUpdate(docId, pgRow) {
  const setClauses = [];
  const values = [];
  let i = 1;

  for (const [col, val] of Object.entries(pgRow)) {
    if (col === 'id') continue;
    if (JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(toJsonbValue(val));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(val);
    }
    i++;
  }

  values.push(docId);
  return {
    text: `UPDATE daily_stats SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
    values,
  };
}

module.exports = {
  FIELD_MAP,
  REVERSE_MAP,
  PG_COLUMNS,
  JSONB_COLUMNS,
  toPgRow,
  toFirestoreObj,
  resolveKeyPath,
  buildInsert,
  buildUpdate,
  convertTimestamp,
  toJsonbValue,
};
