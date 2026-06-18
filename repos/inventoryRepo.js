/**
 * inventoryRepo.js — PostgreSQL data access for inventory items.
 *
 * All methods return Firestore-shaped camelCase objects.
 */

const { query } = require('./pgClient');
const { inventory: mapper } = require('./inventoryFieldMapper');
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

// ── CRUD ─────────────────────────────────────────────────────────────────

async function getById(itemId) {
  const result = await query('SELECT * FROM inventory WHERE id = $1', [itemId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function getByRestaurant(restaurantId, opts = {}) {
  const conditions = ['restaurant_id = $1'];
  const params = [restaurantId];
  let idx = 2;

  if (opts.category) {
    conditions.push(`category = $${idx}`);
    params.push(opts.category);
    idx++;
  }

  const sql = `SELECT * FROM inventory WHERE ${conditions.join(' AND ')} ORDER BY name ASC`;
  const result = await query(sql, params);
  return result.rows.map(toFirestoreObj);
}

async function getByRestaurantSelect(restaurantId, fields) {
  const pgFields = fields.map(f => mapper.FIELD_MAP[f] || f).filter(Boolean);
  const selectCols = pgFields.length > 0 ? pgFields.join(', ') : '*';
  const sql = `SELECT ${selectCols} FROM inventory WHERE restaurant_id = $1 LIMIT 5000`;
  const result = await query(sql, [restaurantId]);
  return result.rows.map(toFirestoreObj);
}

async function getCategories(restaurantId) {
  const sql = `SELECT DISTINCT category FROM inventory WHERE restaurant_id = $1 AND category IS NOT NULL LIMIT 2000`;
  const result = await query(sql, [restaurantId]);
  return result.rows.map(r => r.category);
}

async function create(itemId, data) {
  const pgRow = toPgRow({ id: itemId, ...data });
  const { cols, placeholders, values } = buildInsertValues(pgRow);

  const sql = `INSERT INTO inventory (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO UPDATE SET
    ${cols.filter(c => c !== 'id').map((c, i) => {
      const pi = cols.indexOf(c);
      return JSONB_COLUMNS.has(c) ? `${c} = $${pi + 1}::jsonb` : `${c} = $${pi + 1}`;
    }).join(', ')}`;

  await query(sql, values);
}

async function update(itemId, updates) {
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

  values.push(itemId);
  const sql = `UPDATE inventory SET ${setClauses.join(', ')} WHERE id = $${idx}`;
  await query(sql, values);
}

async function remove(itemId) {
  await query('DELETE FROM inventory WHERE id = $1', [itemId]);
}

/**
 * Atomic stock increment/decrement (replaces FieldValue.increment).
 */
async function incrementStock(itemId, amount) {
  const sql = `UPDATE inventory SET current_stock = current_stock + $1, updated_at = NOW() WHERE id = $2 RETURNING current_stock`;
  const result = await query(sql, [amount, itemId]);
  return result.rows.length > 0 ? parseFloat(result.rows[0].current_stock) : null;
}

/**
 * Atomic increment of wasted_qty.
 */
async function incrementWastedQty(itemId, amount) {
  await query(`UPDATE inventory SET wasted_qty = wasted_qty + $1, updated_at = NOW() WHERE id = $2`, [amount, itemId]);
}

/**
 * Bulk get by IDs (for batch operations).
 */
async function getByIds(itemIds) {
  if (!itemIds || itemIds.length === 0) return [];
  const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(`SELECT * FROM inventory WHERE id IN (${placeholders})`, itemIds);
  return result.rows.map(toFirestoreObj);
}

/**
 * Count inventory items by restaurant.
 */
async function count(restaurantId) {
  const result = await query('SELECT COUNT(*)::int FROM inventory WHERE restaurant_id = $1', [restaurantId]);
  return result.rows[0].count;
}

module.exports = {
  getById,
  getByRestaurant,
  getByRestaurantSelect,
  getCategories,
  create,
  update,
  remove,
  incrementStock,
  incrementWastedQty,
  getByIds,
  count,
};
