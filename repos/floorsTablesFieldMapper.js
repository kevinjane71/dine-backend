/**
 * floorsTablesFieldMapper.js — Maps between Firestore floors/tables docs and PostgreSQL rows.
 *
 * Firestore path: restaurants/{rid}/floors/{fid}/tables/{tid}
 * PG: flat `floors` and `tables` tables with explicit restaurant_id + floor_id columns
 */

// ─── Floor Field Map ──────────────────────────────────────────────────
const FLOOR_FIELD_MAP = {
  restaurantId: 'restaurant_id',
  name: 'name',
  description: 'description',
  section: 'section',
  areaChargeType: 'area_charge_type',
  areaChargeValue: 'area_charge_value',
  order: 'sort_order',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const FLOOR_REVERSE_MAP = {};
for (const [camel, snake] of Object.entries(FLOOR_FIELD_MAP)) {
  FLOOR_REVERSE_MAP[snake] = camel;
}
// sort_order maps back to 'order' in Firestore
FLOOR_REVERSE_MAP['sort_order'] = 'order';

// ─── Table Field Map ──────────────────────────────────────────────────
const TABLE_FIELD_MAP = {
  restaurantId: 'restaurant_id',
  floorId: 'floor_id',
  name: 'name',
  floor: 'floor_name',
  capacity: 'capacity',
  section: 'section',
  status: 'status',
  currentOrderId: 'current_order_id',
  lastOrderTime: 'last_order_time',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const TABLE_REVERSE_MAP = {};
for (const [camel, snake] of Object.entries(TABLE_FIELD_MAP)) {
  TABLE_REVERSE_MAP[snake] = camel;
}
// floor_name maps back to 'floor' in Firestore
TABLE_REVERSE_MAP['floor_name'] = 'floor';

const JSONB_COLUMNS = new Set(['extra_data']);

/**
 * Convert Firestore Timestamp to JS Date.
 */
function convertTimestamp(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && typeof val.toDate === 'function') return val.toDate();
  if (typeof val === 'object' && val._seconds !== undefined) return new Date(val._seconds * 1000);
  return val;
}

// ─── Floor Mappers ────────────────────────────────────────────────────

function floorToPgRow(firestoreObj) {
  const pgRow = {};
  const extraData = {};

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (key === 'id') { pgRow.id = value; continue; }
    if (value && typeof value === 'object' && typeof value.isEqual === 'function') continue;

    const pgCol = FLOOR_FIELD_MAP[key];
    if (pgCol) {
      pgRow[pgCol] = convertTimestamp(value);
    } else {
      extraData[key] = convertTimestamp(value);
    }
  }

  if (Object.keys(extraData).length > 0) pgRow.extra_data = extraData;
  return pgRow;
}

function floorToFirestoreObj(pgRow) {
  const result = {};

  for (const [col, value] of Object.entries(pgRow)) {
    if (value === null || value === undefined) continue;
    if (col === 'id') { result.id = value; continue; }
    if (col === 'extra_data' && typeof value === 'object') {
      Object.assign(result, value);
      continue;
    }

    const camelKey = FLOOR_REVERSE_MAP[col];
    if (camelKey) {
      result[camelKey] = value;
    } else {
      result[col] = value;
    }
  }

  return result;
}

// ─── Table Mappers ────────────────────────────────────────────────────

function tableToPgRow(firestoreObj) {
  const pgRow = {};
  const extraData = {};

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (key === 'id') { pgRow.id = value; continue; }
    if (value && typeof value === 'object' && typeof value.isEqual === 'function') continue;

    const pgCol = TABLE_FIELD_MAP[key];
    if (pgCol) {
      pgRow[pgCol] = convertTimestamp(value);
    } else {
      extraData[key] = convertTimestamp(value);
    }
  }

  if (Object.keys(extraData).length > 0) pgRow.extra_data = extraData;
  return pgRow;
}

function tableToFirestoreObj(pgRow) {
  const result = {};

  for (const [col, value] of Object.entries(pgRow)) {
    if (value === null || value === undefined) continue;
    if (col === 'id') { result.id = value; continue; }
    if (col === 'extra_data' && typeof value === 'object') {
      Object.assign(result, value);
      continue;
    }

    const camelKey = TABLE_REVERSE_MAP[col];
    if (camelKey) {
      result[camelKey] = value;
    } else {
      result[col] = value;
    }
  }

  return result;
}

module.exports = {
  FLOOR_FIELD_MAP,
  FLOOR_REVERSE_MAP,
  TABLE_FIELD_MAP,
  TABLE_REVERSE_MAP,
  JSONB_COLUMNS,
  floorToPgRow,
  floorToFirestoreObj,
  tableToPgRow,
  tableToFirestoreObj,
  convertTimestamp,
};
