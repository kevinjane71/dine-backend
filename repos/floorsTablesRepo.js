/**
 * floorsTablesRepo.js — PostgreSQL data access for floors + tables.
 *
 * All methods return Firestore-shaped camelCase objects so existing
 * endpoint code works unchanged.
 */

const { query, getClient } = require('./pgClient');
const { floorToPgRow, floorToFirestoreObj, tableToPgRow, tableToFirestoreObj } = require('./floorsTablesFieldMapper');

// ═══════════════════════════════════════════════════════════════════════
// FLOORS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get all floors for a restaurant.
 */
async function getFloors(restaurantId) {
  const result = await query(
    'SELECT * FROM floors WHERE restaurant_id = $1 ORDER BY sort_order ASC, name ASC',
    [restaurantId]
  );
  return result.rows.map(floorToFirestoreObj);
}

/**
 * Get a single floor by ID + restaurantId (composite PK).
 */
async function getFloorById(floorId, restaurantId) {
  const result = await query(
    'SELECT * FROM floors WHERE id = $1 AND restaurant_id = $2',
    [floorId, restaurantId]
  );
  if (result.rows.length === 0) return null;
  return floorToFirestoreObj(result.rows[0]);
}

/**
 * Create or replace a floor (idempotent — uses ON CONFLICT DO NOTHING for backfill).
 */
async function createFloor(floorId, restaurantId, data) {
  const pgRow = floorToPgRow({ id: floorId, restaurantId, ...data });
  const cols = Object.keys(pgRow);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const values = cols.map(c => c === 'extra_data' ? JSON.stringify(pgRow[c]) : pgRow[c]);

  const result = await query(
    `INSERT INTO floors (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id, restaurant_id) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       section = EXCLUDED.section,
       area_charge_type = EXCLUDED.area_charge_type,
       area_charge_value = EXCLUDED.area_charge_value,
       sort_order = EXCLUDED.sort_order,
       updated_at = NOW()
     RETURNING *`,
    values
  );
  return result.rows.length > 0 ? floorToFirestoreObj(result.rows[0]) : null;
}

/**
 * Update a floor (requires restaurantId for composite PK lookup).
 */
async function updateFloor(floorId, updates, restaurantId) {
  const setClauses = [];
  const values = [];
  let i = 1;

  const fieldMap = {
    name: 'name',
    description: 'description',
    section: 'section',
    areaChargeType: 'area_charge_type',
    areaChargeValue: 'area_charge_value',
    order: 'sort_order',
  };

  for (const [key, val] of Object.entries(updates)) {
    const col = fieldMap[key];
    if (col) {
      setClauses.push(`${col} = $${i}`);
      values.push(val);
      i++;
    }
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = NOW()');
  values.push(floorId);
  values.push(restaurantId);

  await query(
    `UPDATE floors SET ${setClauses.join(', ')} WHERE id = $${i} AND restaurant_id = $${i + 1}`,
    values
  );
}

/**
 * Reorder floors (batch update sort_order).
 */
async function reorderFloors(restaurantId, floorOrder) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    for (let idx = 0; idx < floorOrder.length; idx++) {
      await client.query(
        'UPDATE floors SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND restaurant_id = $3',
        [idx, floorOrder[idx], restaurantId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete a floor and all its tables (CASCADE handles tables deletion).
 * Requires restaurantId for composite PK.
 */
async function deleteFloor(floorId, restaurantId) {
  await query('DELETE FROM floors WHERE id = $1 AND restaurant_id = $2', [floorId, restaurantId]);
}

// ═══════════════════════════════════════════════════════════════════════
// TABLES
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get all tables for a restaurant (flat list, all floors).
 */
async function getTablesByRestaurant(restaurantId) {
  const result = await query(
    'SELECT * FROM tables WHERE restaurant_id = $1 ORDER BY floor_id, name',
    [restaurantId]
  );
  return result.rows.map(tableToFirestoreObj);
}

/**
 * Get all tables for a specific floor.
 */
async function getTablesByFloor(floorId) {
  const result = await query(
    'SELECT * FROM tables WHERE floor_id = $1 ORDER BY name',
    [floorId]
  );
  return result.rows.map(tableToFirestoreObj);
}

/**
 * Get floors with nested tables for a restaurant (replaces N+1 Firestore pattern).
 * Returns floors array, each with a `tables` property.
 */
async function getFloorsWithTables(restaurantId) {
  const [floorsResult, tablesResult] = await Promise.all([
    query('SELECT * FROM floors WHERE restaurant_id = $1 ORDER BY sort_order ASC, name ASC', [restaurantId]),
    query('SELECT * FROM tables WHERE restaurant_id = $1 ORDER BY name', [restaurantId]),
  ]);

  const tablesByFloor = {};
  for (const row of tablesResult.rows) {
    if (!tablesByFloor[row.floor_id]) tablesByFloor[row.floor_id] = [];
    tablesByFloor[row.floor_id].push(tableToFirestoreObj(row));
  }

  return floorsResult.rows.map(floorRow => {
    const floor = floorToFirestoreObj(floorRow);
    floor.tables = tablesByFloor[floorRow.id] || [];
    return floor;
  });
}

/**
 * Direct table lookup by restaurantId + floorId + tableId.
 * Fast path for order creation.
 */
async function findTableDirect(restaurantId, floorId, tableId) {
  const result = await query(
    'SELECT * FROM tables WHERE id = $1 AND restaurant_id = $2 AND floor_id = $3',
    [tableId, restaurantId, floorId]
  );
  if (result.rows.length === 0) return null;
  return tableToFirestoreObj(result.rows[0]);
}

/**
 * Find a table by ID across all floors for a restaurant.
 */
async function findTableById(restaurantId, tableId) {
  const result = await query(
    'SELECT * FROM tables WHERE id = $1 AND restaurant_id = $2',
    [tableId, restaurantId]
  );
  if (result.rows.length === 0) return null;
  return tableToFirestoreObj(result.rows[0]);
}

/**
 * Find a table by name (case-insensitive) across all floors.
 * Fallback for order creation when no tableId is stored.
 */
async function findTableByName(restaurantId, tableName) {
  const result = await query(
    'SELECT * FROM tables WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1',
    [restaurantId, tableName.trim()]
  );
  if (result.rows.length === 0) return null;
  return tableToFirestoreObj(result.rows[0]);
}

/**
 * Atomic table claim — replaces Firestore transaction.
 * Returns the claimed table or null if not available.
 */
async function claimTable(restaurantId, floorId, tableId, orderId) {
  const result = await query(
    `UPDATE tables SET
       status = 'occupied',
       current_order_id = $1,
       last_order_time = NOW(),
       updated_at = NOW()
     WHERE id = $2 AND restaurant_id = $3 AND floor_id = $4 AND status = 'available'
     RETURNING *`,
    [orderId, tableId, restaurantId, floorId]
  );
  if (result.rowCount === 0) return null;
  return tableToFirestoreObj(result.rows[0]);
}

/**
 * Release a table (set to available, clear order).
 */
async function releaseTable(tableId) {
  await query(
    `UPDATE tables SET status = 'available', current_order_id = NULL, updated_at = NOW()
     WHERE id = $1`,
    [tableId]
  );
}

/**
 * Release a table found by name for a restaurant.
 */
async function releaseTableByName(restaurantId, tableName) {
  const result = await query(
    `UPDATE tables SET status = 'available', current_order_id = NULL, updated_at = NOW()
     WHERE restaurant_id = $1 AND LOWER(name) = LOWER($2)
     RETURNING id`,
    [restaurantId, tableName.trim()]
  );
  return result.rowCount > 0 ? result.rows[0].id : null;
}

/**
 * Occupy a table (set status + orderId).
 */
async function occupyTable(tableId, orderId) {
  await query(
    `UPDATE tables SET
       status = 'occupied',
       current_order_id = $1,
       last_order_time = NOW(),
       updated_at = NOW()
     WHERE id = $2`,
    [orderId, tableId]
  );
}

/**
 * Update table status.
 */
async function updateTableStatus(tableId, status, orderId) {
  const updates = { status };
  if (status === 'occupied' && orderId) {
    await query(
      `UPDATE tables SET status = $1, current_order_id = $2, last_order_time = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [status, orderId, tableId]
    );
  } else if (status === 'available') {
    await query(
      `UPDATE tables SET status = 'available', current_order_id = NULL, updated_at = NOW()
       WHERE id = $1`,
      [tableId]
    );
  } else {
    await query(
      'UPDATE tables SET status = $1, updated_at = NOW() WHERE id = $2',
      [status, tableId]
    );
  }
}

/**
 * Update table fields (name, floor, capacity, section).
 */
async function updateTable(tableId, updates) {
  const setClauses = [];
  const values = [];
  let i = 1;

  const fieldMap = {
    name: 'name',
    floor: 'floor_name',
    capacity: 'capacity',
    section: 'section',
    floorId: 'floor_id',
  };

  for (const [key, val] of Object.entries(updates)) {
    const col = fieldMap[key];
    if (col) {
      setClauses.push(`${col} = $${i}`);
      values.push(val);
      i++;
    }
  }

  if (setClauses.length === 0) return;

  setClauses.push('updated_at = NOW()');
  values.push(tableId);

  await query(
    `UPDATE tables SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values
  );
}

/**
 * Reset all occupied tables for a restaurant to available.
 * Returns count of reset tables.
 */
async function resetAllTables(restaurantId) {
  const result = await query(
    `UPDATE tables SET status = 'available', current_order_id = NULL, updated_at = NOW()
     WHERE restaurant_id = $1 AND status = 'occupied'`,
    [restaurantId]
  );
  return result.rowCount;
}

/**
 * Create a single table.
 */
async function createTable(restaurantId, floorId, data) {
  const pgRow = tableToPgRow({ restaurantId, floorId, ...data });
  if (!pgRow.id) {
    // Generate a random ID like Firestore
    pgRow.id = data.id || require('crypto').randomBytes(10).toString('hex');
  }
  pgRow.restaurant_id = restaurantId;
  pgRow.floor_id = floorId;

  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) => c === 'extra_data' ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
  const values = cols.map(c => c === 'extra_data' ? JSON.stringify(pgRow[c]) : pgRow[c]);

  const result = await query(
    `INSERT INTO tables (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  return tableToFirestoreObj(result.rows[0]);
}

/**
 * Bulk create tables (batch insert).
 */
async function createTablesBatch(restaurantId, floorId, tablesData) {
  if (!tablesData || tablesData.length === 0) return [];

  const client = await getClient();
  const created = [];

  try {
    await client.query('BEGIN');

    for (const data of tablesData) {
      const id = data.id || require('crypto').randomBytes(10).toString('hex');
      const result = await client.query(
        `INSERT INTO tables (id, restaurant_id, floor_id, name, floor_name, capacity, section, status, current_order_id, last_order_time, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
         RETURNING *`,
        [
          id, restaurantId, floorId,
          data.name, data.floor || null,
          data.capacity || 4, data.section || 'Main',
          'available', null, null,
        ]
      );
      created.push(tableToFirestoreObj(result.rows[0]));
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return created;
}

/**
 * Delete a table by ID.
 */
async function deleteTable(tableId) {
  await query('DELETE FROM tables WHERE id = $1', [tableId]);
}

/**
 * Update floor_name on all tables when a floor is renamed.
 * Uses restaurant_id since floor_id is not globally unique.
 */
async function updateFloorNameOnTables(floorId, newFloorName, restaurantId) {
  if (restaurantId) {
    await query(
      'UPDATE tables SET floor_name = $1, updated_at = NOW() WHERE floor_id = $2 AND restaurant_id = $3',
      [newFloorName, floorId, restaurantId]
    );
  } else {
    await query(
      'UPDATE tables SET floor_name = $1, updated_at = NOW() WHERE floor_id = $2',
      [newFloorName, floorId]
    );
  }
}

/**
 * Backfill: create floor with ON CONFLICT DO NOTHING (composite PK: id + restaurant_id).
 */
async function backfillFloor(pgRow) {
  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) => c === 'extra_data' ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
  const values = cols.map(c => c === 'extra_data' ? JSON.stringify(pgRow[c]) : pgRow[c]);

  const result = await query(
    `INSERT INTO floors (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id, restaurant_id) DO NOTHING RETURNING *`,
    values
  );
  return result.rowCount > 0;
}

/**
 * Backfill: create table with ON CONFLICT DO NOTHING.
 */
async function backfillTable(pgRow) {
  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) => c === 'extra_data' ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ');
  const values = cols.map(c => c === 'extra_data' ? JSON.stringify(pgRow[c]) : pgRow[c]);

  const result = await query(
    `INSERT INTO tables (${cols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (id) DO NOTHING RETURNING *`,
    values
  );
  return result.rowCount > 0;
}

module.exports = {
  // Floors
  getFloors,
  getFloorById,
  createFloor,
  updateFloor,
  reorderFloors,
  deleteFloor,
  // Tables
  getTablesByRestaurant,
  getTablesByFloor,
  getFloorsWithTables,
  findTableDirect,
  findTableById,
  findTableByName,
  claimTable,
  releaseTable,
  releaseTableByName,
  occupyTable,
  updateTableStatus,
  updateTable,
  resetAllTables,
  createTable,
  createTablesBatch,
  deleteTable,
  updateFloorNameOnTables,
  // Backfill
  backfillFloor,
  backfillTable,
};
