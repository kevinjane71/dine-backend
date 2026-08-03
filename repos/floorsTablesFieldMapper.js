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
    if (value && typeof value === 'object' && typeof value.isEqual === 'function' && typeof value.toDate !== 'function' && value._seconds === undefined) continue;

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

  // extra_data first (lowest priority); a key that is a mapped column must come from the
  // real column, never from a stale extra_data copy. See tableToFirestoreObj for details.
  if (pgRow.extra_data && typeof pgRow.extra_data === 'object') {
    for (const [k, v] of Object.entries(pgRow.extra_data)) {
      if (v === null || v === undefined) continue;
      if (FLOOR_FIELD_MAP[k]) continue;
      result[k] = v;
    }
  }

  for (const [col, value] of Object.entries(pgRow)) {
    if (col === 'extra_data') continue;
    if (value === null || value === undefined) continue;
    if (col === 'id') { result.id = value; continue; }
    const camelKey = FLOOR_REVERSE_MAP[col];
    result[camelKey || col] = value;
  }

  return result;
}

// ─── Table Mappers ────────────────────────────────────────────────────

function tableToPgRow(firestoreObj) {
  const pgRow = {};
  const extraData = {};

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (key === 'id') { pgRow.id = value; continue; }
    if (value && typeof value === 'object' && typeof value.isEqual === 'function' && typeof value.toDate !== 'function' && value._seconds === undefined) continue;

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

  // 1. extra_data (unmapped/overflow fields) is LOWEST priority. Critically, a key that
  //    is actually a mapped column (e.g. `status`, `currentOrderId`) must NEVER be taken
  //    from extra_data — it can be a stale value left there by a past missing-column write
  //    and would otherwise overwrite the real column and scramble table status.
  if (pgRow.extra_data && typeof pgRow.extra_data === 'object') {
    for (const [k, v] of Object.entries(pgRow.extra_data)) {
      if (v === null || v === undefined) continue;
      if (TABLE_FIELD_MAP[k]) continue; // mapped column → take the real column below
      result[k] = v;
    }
  }

  // 2. Real columns override — always authoritative.
  for (const [col, value] of Object.entries(pgRow)) {
    if (col === 'extra_data') continue;
    if (value === null || value === undefined) continue;
    if (col === 'id') { result.id = value; continue; }
    const camelKey = TABLE_REVERSE_MAP[col];
    result[camelKey || col] = value;
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
