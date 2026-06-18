/**
 * barRepo.js — PostgreSQL data access for bar bottles + reconciliation.
 *
 * All methods return Firestore-shaped camelCase objects.
 */

const { query } = require('./pgClient');
const { barBottles: bottleMapper, barReconciliation: reconMapper } = require('./inventoryFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// BAR BOTTLES
// ═══════════════════════════════════════════════════════════════════════════

function buildInsertValues(pgRow, jsonbSet) {
  const cols = Object.keys(pgRow);
  const placeholders = [];
  const values = [];
  cols.forEach((col, i) => {
    if (jsonbSet.has(col)) {
      placeholders.push(`$${i + 1}::jsonb`);
      values.push(pgRow[col] != null ? JSON.stringify(pgRow[col]) : null);
    } else {
      placeholders.push(`$${i + 1}`);
      values.push(pgRow[col]);
    }
  });
  return { cols, placeholders, values };
}

// ── Bottles ──────────────────────────────────────────────────────────────

async function getBottleById(bottleId) {
  const result = await query('SELECT * FROM bar_bottles WHERE id = $1', [bottleId]);
  if (result.rows.length === 0) return null;
  return bottleMapper.toFirestoreObj(result.rows[0]);
}

async function getBottles(restaurantId, opts = {}) {
  const conditions = ['restaurant_id = $1'];
  const params = [restaurantId];
  let idx = 2;

  if (opts.status) {
    conditions.push(`status = $${idx}`);
    params.push(opts.status);
    idx++;
  }
  if (opts.categoryId) {
    conditions.push(`category_id = $${idx}`);
    params.push(opts.categoryId);
    idx++;
  }
  if (opts.statusIn && Array.isArray(opts.statusIn)) {
    const statusPlaceholders = opts.statusIn.map((_, si) => `$${idx + si}`);
    conditions.push(`status IN (${statusPlaceholders.join(', ')})`);
    params.push(...opts.statusIn);
    idx += opts.statusIn.length;
  }

  const limit = opts.limit || 500;
  const sql = `SELECT * FROM bar_bottles WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC
    LIMIT $${idx}`;
  params.push(limit);

  const result = await query(sql, params);
  return result.rows.map(bottleMapper.toFirestoreObj);
}

async function createBottle(bottleId, data) {
  const pgRow = bottleMapper.toPgRow({ id: bottleId, ...data });
  const { cols, placeholders, values } = buildInsertValues(pgRow, bottleMapper.JSONB_COLUMNS);
  const sql = `INSERT INTO bar_bottles (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO NOTHING`;
  await query(sql, values);
}

async function updateBottle(bottleId, updates) {
  const pgRow = bottleMapper.toPgRow(updates);
  delete pgRow.id;
  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const col of cols) {
    if (bottleMapper.JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${idx}::jsonb`);
      values.push(pgRow[col] != null ? JSON.stringify(pgRow[col]) : null);
    } else {
      setClauses.push(`${col} = $${idx}`);
      values.push(pgRow[col]);
    }
    idx++;
  }

  values.push(bottleId);
  const sql = `UPDATE bar_bottles SET ${setClauses.join(', ')} WHERE id = $${idx}`;
  await query(sql, values);
}

async function deleteBottle(bottleId) {
  await query('DELETE FROM bar_bottles WHERE id = $1', [bottleId]);
}

/**
 * Atomic increment for totalMlSold, totalPegsPoured, wastage
 * (replaces FieldValue.increment).
 */
async function incrementBottleFields(bottleId, increments) {
  const setClauses = [];
  const values = [];
  let idx = 1;

  if (increments.totalMlSold !== undefined) {
    setClauses.push(`total_ml_sold = total_ml_sold + $${idx}`);
    values.push(increments.totalMlSold);
    idx++;
  }
  if (increments.totalPegsPoured !== undefined) {
    setClauses.push(`total_pegs_poured = total_pegs_poured + $${idx}`);
    values.push(increments.totalPegsPoured);
    idx++;
  }
  if (increments.wastage !== undefined) {
    setClauses.push(`wastage = wastage + $${idx}`);
    values.push(increments.wastage);
    idx++;
  }
  if (increments.totalMlPoured !== undefined) {
    setClauses.push(`total_ml_poured = total_ml_poured + $${idx}`);
    values.push(increments.totalMlPoured);
    idx++;
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = NOW()');
  values.push(bottleId);
  const sql = `UPDATE bar_bottles SET ${setClauses.join(', ')} WHERE id = $${idx}`;
  await query(sql, values);
}

// ═══════════════════════════════════════════════════════════════════════════
// BAR RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════

async function getReconciliationById(reconId) {
  const result = await query('SELECT * FROM bar_reconciliation WHERE id = $1', [reconId]);
  if (result.rows.length === 0) return null;
  return reconMapper.toFirestoreObj(result.rows[0]);
}

async function getReconciliations(restaurantId, opts = {}) {
  const limit = opts.limit || 50;
  const sql = `SELECT * FROM bar_reconciliation
    WHERE restaurant_id = $1
    ORDER BY created_at DESC
    LIMIT $2`;
  const result = await query(sql, [restaurantId, limit]);
  return result.rows.map(reconMapper.toFirestoreObj);
}

async function createReconciliation(reconId, data) {
  const pgRow = reconMapper.toPgRow({ id: reconId, ...data });
  const { cols, placeholders, values } = buildInsertValues(pgRow, reconMapper.JSONB_COLUMNS);
  const sql = `INSERT INTO bar_reconciliation (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO NOTHING`;
  await query(sql, values);
}

async function updateReconciliation(reconId, updates) {
  const pgRow = reconMapper.toPgRow(updates);
  delete pgRow.id;
  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const col of cols) {
    if (reconMapper.JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${idx}::jsonb`);
      values.push(pgRow[col] != null ? JSON.stringify(pgRow[col]) : null);
    } else {
      setClauses.push(`${col} = $${idx}`);
      values.push(pgRow[col]);
    }
    idx++;
  }

  values.push(reconId);
  const sql = `UPDATE bar_reconciliation SET ${setClauses.join(', ')} WHERE id = $${idx}`;
  await query(sql, values);
}

module.exports = {
  // Bottles
  getBottleById,
  getBottles,
  createBottle,
  updateBottle,
  deleteBottle,
  incrementBottleFields,
  // Reconciliation
  getReconciliationById,
  getReconciliations,
  createReconciliation,
  updateReconciliation,
};
