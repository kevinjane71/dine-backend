/**
 * inventoryTransactionsRepo.js — PostgreSQL data access for inventory transactions.
 *
 * All methods return Firestore-shaped camelCase objects.
 */

const { query } = require('./pgClient');
const { inventoryTransactions: mapper } = require('./inventoryFieldMapper');
const { JSONB_COLUMNS, toPgRow, toFirestoreObj } = mapper;

// ── Helpers ──────────────────────────────────────────────────────────────

function buildInsertValues(pgRow) {
  const cols = Object.keys(pgRow);
  const placeholders = [];
  const values = [];
  cols.forEach((col, i) => {
    if (JSONB_COLUMNS.has(col)) {
      placeholders.push(`$${i + 1}::jsonb`);
      values.push(pgRow[col] != null ? JSON.stringify(pgRow[col]) : null);
    } else {
      placeholders.push(`$${i + 1}`);
      values.push(pgRow[col]);
    }
  });
  return { cols, placeholders, values };
}

// ── Methods ──────────────────────────────────────────────────────────────

async function getById(txId) {
  const result = await query('SELECT * FROM inventory_transactions WHERE id = $1', [txId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

/**
 * Paginated transactions with filters.
 */
async function getByRestaurant(restaurantId, opts = {}) {
  const conditions = ['restaurant_id = $1'];
  const params = [restaurantId];
  let idx = 2;

  if (opts.inventoryItemId) {
    conditions.push(`inventory_item_id = $${idx}`);
    params.push(opts.inventoryItemId);
    idx++;
  }
  if (opts.type) {
    conditions.push(`type = $${idx}`);
    params.push(opts.type.toUpperCase());
    idx++;
  }
  if (opts.source) {
    conditions.push(`source = $${idx}`);
    params.push(opts.source);
    idx++;
  }
  if (opts.dateStart) {
    conditions.push(`date >= $${idx}`);
    params.push(opts.dateStart);
    idx++;
  }
  if (opts.dateEnd) {
    conditions.push(`date <= $${idx}`);
    params.push(opts.dateEnd);
    idx++;
  }
  if (opts.referenceId) {
    conditions.push(`reference_id = $${idx}`);
    params.push(opts.referenceId);
    idx++;
  }

  const limit = Math.min(opts.limit || 50, 200);
  const offset = opts.offset || 0;

  const sql = `SELECT * FROM inventory_transactions
    WHERE ${conditions.join(' AND ')}
    ORDER BY date DESC
    LIMIT $${idx} OFFSET $${idx + 1}`;
  params.push(limit, offset);

  const result = await query(sql, params);
  return result.rows.map(toFirestoreObj);
}

/**
 * Get deduction transactions for a specific order (idempotency check).
 */
async function getByOrderId(orderId) {
  const sql = `SELECT * FROM inventory_transactions
    WHERE reference_id = $1 AND type = 'DEDUCTION' AND source = 'ORDER'
    LIMIT 1`;
  const result = await query(sql, [orderId]);
  return result.rows.length > 0 ? toFirestoreObj(result.rows[0]) : null;
}

/**
 * Get all deduction transactions for an order (for restoration on cancel).
 */
async function getDeductionsForOrder(orderId) {
  const sql = `SELECT * FROM inventory_transactions
    WHERE reference_id = $1 AND type = 'DEDUCTION' AND source = 'ORDER'`;
  const result = await query(sql, [orderId]);
  return result.rows.map(toFirestoreObj);
}

/**
 * Usage summary: aggregate deductions by item for a date range.
 */
async function getUsageSummary(restaurantId, dateStart, dateEnd) {
  const sql = `SELECT inventory_item_id, inventory_item_name, unit,
    SUM(ABS(quantity_change)) as total_used,
    SUM(ABS(total_cost)) as total_cost,
    COUNT(*)::int as transaction_count
    FROM inventory_transactions
    WHERE restaurant_id = $1 AND type = 'DEDUCTION' AND source = 'ORDER'
    AND date >= $2 AND date <= $3
    GROUP BY inventory_item_id, inventory_item_name, unit
    ORDER BY total_used DESC`;
  const result = await query(sql, [restaurantId, dateStart, dateEnd]);
  return result.rows.map(row => ({
    inventoryItemId: row.inventory_item_id,
    inventoryItemName: row.inventory_item_name,
    unit: row.unit,
    totalUsed: parseFloat(row.total_used) || 0,
    totalCost: parseFloat(row.total_cost) || 0,
    transactionCount: row.transaction_count,
  }));
}

/**
 * Create a single transaction record.
 */
async function create(txId, data) {
  const pgRow = toPgRow({ id: txId, ...data });
  const { cols, placeholders, values } = buildInsertValues(pgRow);
  const sql = `INSERT INTO inventory_transactions (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO NOTHING`;
  await query(sql, values);
}

/**
 * Batch create transactions (within a PG transaction — caller provides client).
 */
async function createBatch(client, transactions) {
  for (const tx of transactions) {
    const pgRow = toPgRow(tx);
    const cols = Object.keys(pgRow);
    const placeholders = [];
    const values = [];
    cols.forEach((col, i) => {
      if (JSONB_COLUMNS.has(col)) {
        placeholders.push(`$${i + 1}::jsonb`);
        values.push(pgRow[col] != null ? JSON.stringify(pgRow[col]) : null);
      } else {
        placeholders.push(`$${i + 1}`);
        values.push(pgRow[col]);
      }
    });
    const sql = `INSERT INTO inventory_transactions (${cols.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (id) DO NOTHING`;
    await client.query(sql, values);
  }
}

module.exports = {
  getById,
  getByRestaurant,
  getByOrderId,
  getDeductionsForOrder,
  getUsageSummary,
  create,
  createBatch,
};
