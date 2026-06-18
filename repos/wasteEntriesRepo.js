/**
 * wasteEntriesRepo.js — PostgreSQL data access for waste entries.
 *
 * All methods return Firestore-shaped camelCase objects.
 */

const { query } = require('./pgClient');
const { wasteEntries: mapper } = require('./inventoryFieldMapper');
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

async function getById(entryId) {
  const result = await query('SELECT * FROM waste_entries WHERE id = $1', [entryId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function getByRestaurant(restaurantId, opts = {}) {
  const conditions = ['restaurant_id = $1'];
  const params = [restaurantId];
  let idx = 2;

  if (opts.reason) {
    conditions.push(`reason = $${idx}`);
    params.push(opts.reason);
    idx++;
  }
  if (opts.itemId) {
    conditions.push(`item_id = $${idx}`);
    params.push(opts.itemId);
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

  const sql = `SELECT * FROM waste_entries WHERE ${conditions.join(' AND ')}
    ORDER BY date DESC`;
  const result = await query(sql, params);
  return result.rows.map(toFirestoreObj);
}

async function create(entryId, data) {
  const pgRow = toPgRow({ id: entryId, ...data });
  const { cols, placeholders, values } = buildInsertValues(pgRow);
  const sql = `INSERT INTO waste_entries (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO NOTHING`;
  await query(sql, values);
}

/**
 * Batch create waste entries (within a PG transaction — caller provides client).
 */
async function createBatch(client, entries) {
  for (const entry of entries) {
    const pgRow = toPgRow(entry);
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
    const sql = `INSERT INTO waste_entries (${cols.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (id) DO NOTHING`;
    await client.query(sql, values);
  }
}

module.exports = {
  getById,
  getByRestaurant,
  create,
  createBatch,
};
