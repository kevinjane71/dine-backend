/**
 * restaurantsRepo.js — PostgreSQL data access for restaurants.
 *
 * All methods return Firestore-shaped camelCase objects so existing
 * endpoint code works unchanged.
 */

const { query } = require('./pgClient');
const { toPgRow, toFirestoreObj, JSONB_COLUMNS } = require('./restaurantsFieldMapper');

/**
 * Get a restaurant by ID. Returns Firestore-shaped object or null.
 */
async function getById(restaurantId) {
  const result = await query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

/**
 * Get multiple restaurants by IDs. Returns array of Firestore-shaped objects.
 */
async function getByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(
    `SELECT * FROM restaurants WHERE id IN (${placeholders})`,
    ids
  );
  return result.rows.map(toFirestoreObj);
}

/**
 * Get all restaurants (for super admin). Supports optional filters.
 */
async function getAll(options = {}) {
  const { status, ownerId, limit = 500 } = options;
  const conditions = [];
  const values = [];
  let i = 1;

  if (status) {
    conditions.push(`status = $${i++}`);
    values.push(status);
  }
  if (ownerId) {
    conditions.push(`owner_id = $${i++}`);
    values.push(ownerId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await query(
    `SELECT * FROM restaurants ${where} ORDER BY created_at DESC LIMIT $${i}`,
    [...values, limit]
  );
  return result.rows.map(toFirestoreObj);
}

/**
 * Get sub-restaurants for a parent restaurant.
 */
async function getSubRestaurants(parentRestaurantId) {
  const result = await query(
    'SELECT * FROM restaurants WHERE parent_restaurant_id = $1 ORDER BY name',
    [parentRestaurantId]
  );
  return result.rows.map(toFirestoreObj);
}

/**
 * Find restaurant by subdomain.
 */
async function getBySubdomain(subdomain) {
  const result = await query(
    'SELECT * FROM restaurants WHERE subdomain = $1',
    [subdomain]
  );
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

/**
 * Find restaurant by URL slug.
 */
async function getByUrlSlug(urlSlug) {
  const result = await query(
    'SELECT * FROM restaurants WHERE url_slug = $1',
    [urlSlug]
  );
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

/**
 * Find restaurant by restaurant code.
 */
async function getByCode(restaurantCode) {
  const result = await query(
    'SELECT * FROM restaurants WHERE restaurant_code = $1',
    [restaurantCode]
  );
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

/**
 * Create or upsert a restaurant (idempotent).
 */
async function create(restaurantId, data) {
  const pgRow = toPgRow({ id: restaurantId, ...data });
  if (!pgRow.id) pgRow.id = restaurantId;

  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) =>
    JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
  ).join(', ');
  const values = cols.map(c =>
    JSONB_COLUMNS.has(c) && pgRow[c] !== null ? JSON.stringify(pgRow[c]) : pgRow[c]
  );

  const result = await query(
    `INSERT INTO restaurants (${cols.join(', ')}) VALUES (${placeholders})
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

/**
 * Update specific fields on a restaurant.
 * Accepts Firestore-style camelCase keys.
 */
async function update(restaurantId, updates) {
  const pgRow = toPgRow(updates);
  // Remove id from updates
  delete pgRow.id;

  // Remove updated_at from data — we always set it to NOW() explicitly
  delete pgRow.updated_at;

  const cols = Object.keys(pgRow);
  if (cols.length === 0) return;

  const setClauses = [];
  const values = [];
  let i = 1;

  for (const col of cols) {
    if (JSONB_COLUMNS.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(pgRow[col] !== null ? JSON.stringify(pgRow[col]) : null);
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(pgRow[col]);
    }
    i++;
  }

  setClauses.push('updated_at = NOW()');
  values.push(restaurantId);

  await query(
    `UPDATE restaurants SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values
  );
}

/**
 * Delete a restaurant (soft or hard).
 */
async function remove(restaurantId) {
  await query('DELETE FROM restaurants WHERE id = $1', [restaurantId]);
}

/**
 * Count restaurants (for super admin dashboard).
 */
async function count(options = {}) {
  const { status } = options;
  if (status) {
    const result = await query('SELECT COUNT(*) as c FROM restaurants WHERE status = $1', [status]);
    return parseInt(result.rows[0].c, 10);
  }
  const result = await query('SELECT COUNT(*) as c FROM restaurants');
  return parseInt(result.rows[0].c, 10);
}

module.exports = {
  getById,
  getByIds,
  getAll,
  getSubRestaurants,
  getBySubdomain,
  getByUrlSlug,
  getByCode,
  create,
  update,
  remove,
  count,
};
