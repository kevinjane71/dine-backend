/**
 * stockBatchesRepo.js — PostgreSQL data access for stock batches (FIFO tracking).
 *
 * All methods return Firestore-shaped camelCase objects.
 */

const { query } = require('./pgClient');
const { stockBatches: mapper } = require('./inventoryFieldMapper');
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

async function getById(batchId) {
  const result = await query('SELECT * FROM stock_batches WHERE id = $1', [batchId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

/**
 * Get all batches for a specific inventory item.
 */
async function getByItem(restaurantId, inventoryItemId) {
  const sql = `SELECT * FROM stock_batches
    WHERE restaurant_id = $1 AND inventory_item_id = $2
    ORDER BY created_at DESC`;
  const result = await query(sql, [restaurantId, inventoryItemId]);
  return result.rows.map(toFirestoreObj);
}

/**
 * Get active batches for FIFO deduction (ordered by mfg_date ASC).
 */
async function getActiveBatches(inventoryItemId, limit = 50) {
  const sql = `SELECT * FROM stock_batches
    WHERE inventory_item_id = $1 AND status = 'active'
    ORDER BY mfg_date ASC NULLS LAST, created_at ASC
    LIMIT $2`;
  const result = await query(sql, [inventoryItemId, limit]);
  return result.rows.map(toFirestoreObj);
}

/**
 * Get all batches for a restaurant (for dashboard wastage calculations).
 */
async function getByRestaurant(restaurantId, opts = {}) {
  const conditions = ['restaurant_id = $1'];
  const params = [restaurantId];
  let idx = 2;

  if (opts.status) {
    conditions.push(`status = $${idx}`);
    params.push(opts.status);
    idx++;
  }

  const sql = `SELECT * FROM stock_batches WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC LIMIT 5000`;
  const result = await query(sql, params);
  return result.rows.map(toFirestoreObj);
}

/**
 * Get expired active batches (for auto-waste detection).
 */
async function getExpiredActive(restaurantId) {
  const sql = `SELECT * FROM stock_batches
    WHERE restaurant_id = $1 AND status = 'active'
    AND expiry_date IS NOT NULL AND expiry_date < NOW()
    AND remaining_qty > 0`;
  const result = await query(sql, [restaurantId]);
  return result.rows.map(toFirestoreObj);
}

async function create(batchId, data) {
  const pgRow = toPgRow({ id: batchId, ...data });
  const { cols, placeholders, values } = buildInsertValues(pgRow);
  const sql = `INSERT INTO stock_batches (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO NOTHING`;
  await query(sql, values);
}

async function update(batchId, updates) {
  const pgRow = toPgRow(updates);
  delete pgRow.id;
  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const col of cols) {
    if (JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${idx}::jsonb`);
      values.push(pgRow[col] != null ? JSON.stringify(pgRow[col]) : null);
    } else {
      setClauses.push(`${col} = $${idx}`);
      values.push(pgRow[col]);
    }
    idx++;
  }

  values.push(batchId);
  const sql = `UPDATE stock_batches SET ${setClauses.join(', ')} WHERE id = $${idx}`;
  await query(sql, values);
}

/**
 * Atomic decrement of remaining_qty (replaces FieldValue.increment(-qty)).
 * Also marks as depleted if remaining_qty reaches 0.
 */
async function decrementRemainingQty(batchId, amount) {
  const sql = `UPDATE stock_batches
    SET remaining_qty = GREATEST(remaining_qty - $1, 0),
        status = CASE WHEN remaining_qty - $1 <= 0 THEN 'depleted' ELSE status END,
        updated_at = NOW()
    WHERE id = $2
    RETURNING remaining_qty, status`;
  const result = await query(sql, [amount, batchId]);
  if (result.rows.length === 0) return null;
  return {
    remainingQty: parseFloat(result.rows[0].remaining_qty),
    status: result.rows[0].status,
  };
}

/**
 * Atomic increment of remaining_qty (for order cancellation restore).
 */
async function incrementRemainingQty(batchId, amount) {
  const sql = `UPDATE stock_batches
    SET remaining_qty = remaining_qty + $1,
        status = 'active',
        updated_at = NOW()
    WHERE id = $2`;
  await query(sql, [amount, batchId]);
}

/**
 * Mark batch as depleted/cancelled.
 */
async function markStatus(batchId, status) {
  await query(`UPDATE stock_batches SET status = $1, updated_at = NOW() WHERE id = $2`, [status, batchId]);
}

/**
 * Batch operations within a PG transaction (caller provides client).
 */
async function decrementBatch(client, batchId, amount) {
  const sql = `UPDATE stock_batches
    SET remaining_qty = GREATEST(remaining_qty - $1, 0),
        status = CASE WHEN remaining_qty - $1 <= 0 THEN 'depleted' ELSE status END,
        updated_at = NOW()
    WHERE id = $2`;
  await client.query(sql, [amount, batchId]);
}

async function incrementBatch(client, batchId, amount) {
  const sql = `UPDATE stock_batches
    SET remaining_qty = remaining_qty + $1,
        status = 'active',
        updated_at = NOW()
    WHERE id = $2`;
  await client.query(sql, [amount, batchId]);
}

module.exports = {
  getById,
  getByItem,
  getActiveBatches,
  getByRestaurant,
  getExpiredActive,
  create,
  update,
  decrementRemainingQty,
  incrementRemainingQty,
  markStatus,
  decrementBatch,
  incrementBatch,
};
