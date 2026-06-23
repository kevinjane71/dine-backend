/**
 * registerRepo.js — PostgreSQL data access for cashRegisters, shifts,
 * restaurantShiftSettings, staffShifts, and staffAvailability.
 */

const { query } = require('./pgClient');
const {
  registerToPgRow, registerToFirestoreObj, REGISTER_JSONB_COLUMNS,
  shiftToPgRow, shiftToFirestoreObj, SHIFT_JSONB_COLUMNS,
  shiftSettingsToPgRow, shiftSettingsToFirestoreObj, SHIFT_SETTINGS_JSONB_COLUMNS,
  staffShiftToPgRow, staffShiftToFirestoreObj, STAFF_SHIFT_JSONB_COLUMNS,
  staffAvailToPgRow, staffAvailToFirestoreObj, STAFF_AVAIL_JSONB_COLUMNS,
} = require('./registerFieldMapper');

function jsonbVal(col, val, jsonbCols) {
  return jsonbCols.has(col) && val !== null && val !== undefined
    ? JSON.stringify(val) : val;
}

function buildUpsert(tableName, pgRow, jsonbCols) {
  const cols = Object.keys(pgRow);
  const placeholders = cols.map((c, i) =>
    jsonbCols.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`
  ).join(', ');
  const values = cols.map(c => jsonbVal(c, pgRow[c], jsonbCols));
  const updateCols = cols.filter(c => c !== 'id');
  return {
    text: `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})
           ON CONFLICT (id) DO UPDATE SET ${updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')}
           RETURNING *`,
    values,
  };
}

function buildUpdate(tableName, id, updates, jsonbCols) {
  const cols = Object.keys(updates);
  if (cols.length === 0) return null;
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const col of cols) {
    if (jsonbCols.has(col)) {
      setClauses.push(`${col} = $${i}::jsonb`);
      values.push(jsonbVal(col, updates[col], jsonbCols));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(updates[col]);
    }
    i++;
  }
  values.push(id);
  return {
    text: `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values,
  };
}

// ── Cash Registers ────────────────────────────────────────────────────────

async function createRegister(registerId, data) {
  const pgRow = registerToPgRow({ id: registerId, ...data });
  if (!pgRow.id) pgRow.id = registerId;
  const q = buildUpsert('cash_registers', pgRow, REGISTER_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? registerToFirestoreObj(result.rows[0]) : null;
}

async function updateRegister(registerId, updates) {
  const pgRow = registerToPgRow(updates);
  delete pgRow.id;
  delete pgRow.updated_at;
  pgRow.updated_at = new Date();
  const q = buildUpdate('cash_registers', registerId, pgRow, REGISTER_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function getRegisterById(registerId) {
  const result = await query('SELECT * FROM cash_registers WHERE id = $1', [registerId]);
  if (result.rows.length === 0) return null;
  return registerToFirestoreObj(result.rows[0]);
}

async function getOpenRegister(restaurantId) {
  const result = await query(
    "SELECT * FROM cash_registers WHERE restaurant_id = $1 AND status = 'open' LIMIT 1",
    [restaurantId]
  );
  if (result.rows.length === 0) return null;
  return registerToFirestoreObj(result.rows[0]);
}

async function getRegisterHistory(restaurantId, { limit = 30 } = {}) {
  const result = await query(
    'SELECT * FROM cash_registers WHERE restaurant_id = $1 ORDER BY opened_at DESC LIMIT $2',
    [restaurantId, limit]
  );
  return result.rows.map(registerToFirestoreObj);
}

/**
 * Atomic increment for cashIn/cashOut/cashDrops + append transaction.
 * Replaces FieldValue.increment + FieldValue.arrayUnion.
 */
async function addRegisterTransaction(registerId, transaction, field, amount) {
  const fieldMap = { cashIn: 'cash_in', cashOut: 'cash_out', cashDrops: 'cash_drops' };
  const pgField = fieldMap[field] || field;
  await query(
    `UPDATE cash_registers
     SET transactions = COALESCE(transactions, '[]'::jsonb) || $1::jsonb,
         ${pgField} = COALESCE(${pgField}, 0) + $2,
         updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify([transaction]), amount, registerId]
  );
}

// ── Shifts ────────────────────────────────────────────────────────────────

async function createShift(shiftId, data) {
  const pgRow = shiftToPgRow({ id: shiftId, ...data });
  if (!pgRow.id) pgRow.id = shiftId;
  const q = buildUpsert('shifts', pgRow, SHIFT_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? shiftToFirestoreObj(result.rows[0]) : null;
}

async function updateShift(shiftId, updates) {
  const pgRow = shiftToPgRow(updates);
  delete pgRow.id;
  delete pgRow.updated_at;
  pgRow.updated_at = new Date();
  const q = buildUpdate('shifts', shiftId, pgRow, SHIFT_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function getShiftById(shiftId) {
  const result = await query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
  if (result.rows.length === 0) return null;
  return shiftToFirestoreObj(result.rows[0]);
}

async function getOpenShiftByUser(restaurantId, userId) {
  const result = await query(
    "SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'open' AND opened_by->>'userId' = $2 LIMIT 1",
    [restaurantId, userId]
  );
  if (result.rows.length === 0) return null;
  return shiftToFirestoreObj(result.rows[0]);
}

async function getAllOpenShifts(restaurantId) {
  const result = await query(
    "SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'open' LIMIT 500",
    [restaurantId]
  );
  return result.rows.map(shiftToFirestoreObj);
}

async function getShiftHistory(restaurantId, { limit = 30 } = {}) {
  const result = await query(
    'SELECT * FROM shifts WHERE restaurant_id = $1 ORDER BY opened_at DESC LIMIT $2',
    [restaurantId, limit]
  );
  return result.rows.map(shiftToFirestoreObj);
}

async function getClosedShifts(restaurantId, { limit = 500 } = {}) {
  const result = await query(
    "SELECT * FROM shifts WHERE restaurant_id = $1 AND status = 'closed' ORDER BY opened_at DESC LIMIT $2",
    [restaurantId, limit]
  );
  return result.rows.map(shiftToFirestoreObj);
}

async function addShiftTransaction(shiftId, transaction, field, amount) {
  const fieldMap = { cashIn: 'cash_in', cashOut: 'cash_out', cashDrops: 'cash_drops' };
  const pgField = fieldMap[field] || field;
  await query(
    `UPDATE shifts
     SET transactions = COALESCE(transactions, '[]'::jsonb) || $1::jsonb,
         ${pgField} = COALESCE(${pgField}, 0) + $2,
         updated_at = NOW()
     WHERE id = $3`,
    [JSON.stringify([transaction]), amount, shiftId]
  );
}

// ── Restaurant Shift Settings ─────────────────────────────────────────────

async function getShiftSettings(restaurantId) {
  const result = await query(
    'SELECT * FROM restaurant_shift_settings WHERE restaurant_id = $1',
    [restaurantId]
  );
  if (result.rows.length === 0) return null;
  return shiftSettingsToFirestoreObj(result.rows[0]);
}

async function saveShiftSettings(restaurantId, data) {
  const pgRow = shiftSettingsToPgRow({ id: restaurantId, restaurantId, ...data });
  if (!pgRow.id) pgRow.id = restaurantId;
  const q = buildUpsert('restaurant_shift_settings', pgRow, SHIFT_SETTINGS_JSONB_COLUMNS);
  await query(q.text, q.values);
}

// ── Staff Shifts ──────────────────────────────────────────────────────────

async function createStaffShift(shiftId, data) {
  const pgRow = staffShiftToPgRow({ id: shiftId, ...data });
  if (!pgRow.id) pgRow.id = shiftId;
  const q = buildUpsert('staff_shifts', pgRow, STAFF_SHIFT_JSONB_COLUMNS);
  const result = await query(q.text, q.values);
  return result.rows.length > 0 ? staffShiftToFirestoreObj(result.rows[0]) : null;
}

async function updateStaffShift(shiftId, updates) {
  const pgRow = staffShiftToPgRow(updates);
  delete pgRow.id;
  delete pgRow.updated_at;
  pgRow.updated_at = new Date();
  const q = buildUpdate('staff_shifts', shiftId, pgRow, STAFF_SHIFT_JSONB_COLUMNS);
  if (!q) return;
  await query(q.text, q.values);
}

async function deleteStaffShift(shiftId) {
  await query('DELETE FROM staff_shifts WHERE id = $1', [shiftId]);
}

async function getStaffShiftsByDateRange(restaurantId, startDate, endDate) {
  const result = await query(
    'SELECT * FROM staff_shifts WHERE restaurant_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC',
    [restaurantId, startDate, endDate]
  );
  return result.rows.map(staffShiftToFirestoreObj);
}

async function getStaffShiftsByStaffAndDate(restaurantId, staffId, date) {
  const result = await query(
    'SELECT * FROM staff_shifts WHERE restaurant_id = $1 AND staff_id = $2 AND date = $3',
    [restaurantId, staffId, date]
  );
  return result.rows.map(staffShiftToFirestoreObj);
}

async function bulkCreateStaffShifts(shifts) {
  // Use individual inserts wrapped in a single transaction-like approach
  for (const shift of shifts) {
    const pgRow = staffShiftToPgRow(shift);
    if (!pgRow.id) continue;
    const q = buildUpsert('staff_shifts', pgRow, STAFF_SHIFT_JSONB_COLUMNS);
    await query(q.text, q.values);
  }
}

async function deleteStaffShiftsByDateRange(restaurantId, startDate, endDate) {
  await query(
    'DELETE FROM staff_shifts WHERE restaurant_id = $1 AND date >= $2 AND date <= $3',
    [restaurantId, startDate, endDate]
  );
}

// ── Staff Availability ────────────────────────────────────────────────────

async function getStaffAvailability(staffId) {
  const result = await query('SELECT * FROM staff_availability WHERE id = $1', [staffId]);
  if (result.rows.length === 0) return null;
  return staffAvailToFirestoreObj(result.rows[0]);
}

async function saveStaffAvailability(staffId, data) {
  const pgRow = staffAvailToPgRow({ id: staffId, staffId, ...data });
  if (!pgRow.id) pgRow.id = staffId;
  const q = buildUpsert('staff_availability', pgRow, STAFF_AVAIL_JSONB_COLUMNS);
  await query(q.text, q.values);
}

module.exports = {
  // Cash Registers
  createRegister, updateRegister, getRegisterById,
  getOpenRegister, getRegisterHistory, addRegisterTransaction,

  // Shifts
  createShift, updateShift, getShiftById,
  getOpenShiftByUser, getAllOpenShifts, getShiftHistory,
  getClosedShifts, addShiftTransaction,

  // Shift Settings
  getShiftSettings, saveShiftSettings,

  // Staff Shifts
  createStaffShift, updateStaffShift, deleteStaffShift,
  getStaffShiftsByDateRange, getStaffShiftsByStaffAndDate,
  bulkCreateStaffShifts, deleteStaffShiftsByDateRange,

  // Staff Availability
  getStaffAvailability, saveStaffAvailability,
};
