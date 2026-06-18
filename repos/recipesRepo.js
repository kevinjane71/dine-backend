/**
 * recipesRepo.js — PostgreSQL data access for recipes.
 *
 * All methods return Firestore-shaped camelCase objects.
 */

const { query } = require('./pgClient');
const { recipes: mapper } = require('./inventoryFieldMapper');
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

async function getById(recipeId) {
  const result = await query('SELECT * FROM recipes WHERE id = $1', [recipeId]);
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
  if (opts.isActive !== undefined) {
    conditions.push(`is_active = $${idx}`);
    params.push(opts.isActive);
    idx++;
  }

  const sql = `SELECT * FROM recipes WHERE ${conditions.join(' AND ')} ORDER BY name ASC`;
  const result = await query(sql, params);
  return result.rows.map(toFirestoreObj);
}

/**
 * Find recipe by menu item ID (for upsert / deduction lookup).
 */
async function getByMenuItemId(restaurantId, menuItemId) {
  const sql = `SELECT * FROM recipes
    WHERE restaurant_id = $1 AND menu_item_id = $2
    LIMIT 1`;
  const result = await query(sql, [restaurantId, menuItemId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

async function create(recipeId, data) {
  const pgRow = toPgRow({ id: recipeId, ...data });
  const { cols, placeholders, values } = buildInsertValues(pgRow);

  const sql = `INSERT INTO recipes (${cols.join(', ')})
    VALUES (${placeholders.join(', ')})
    ON CONFLICT (id) DO UPDATE SET
    ${cols.filter(c => c !== 'id').map((c) => {
      const pi = cols.indexOf(c);
      return JSONB_COLUMNS.has(c) ? `${c} = $${pi + 1}::jsonb` : `${c} = $${pi + 1}`;
    }).join(', ')}`;

  await query(sql, values);
}

async function update(recipeId, updates) {
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

  values.push(recipeId);
  const sql = `UPDATE recipes SET ${setClauses.join(', ')} WHERE id = $${idx}`;
  await query(sql, values);
}

async function remove(recipeId) {
  await query('DELETE FROM recipes WHERE id = $1', [recipeId]);
}

/**
 * Delete all recipes for a restaurant (for bulk operations).
 */
async function removeByRestaurant(restaurantId) {
  await query('DELETE FROM recipes WHERE restaurant_id = $1', [restaurantId]);
}

module.exports = {
  getById,
  getByRestaurant,
  getByMenuItemId,
  create,
  update,
  remove,
  removeByRestaurant,
};
