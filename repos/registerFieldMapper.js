/**
 * registerFieldMapper.js — camelCase (Firestore) ↔ snake_case (PostgreSQL)
 * for cashRegisters, shifts, restaurantShiftSettings, staffShifts, staffAvailability.
 */

const { buildReverseMap } = require('./queryBuilder');

// ── cashRegisters ─────────────────────────────────────────────────────────

const REGISTER_FIELD_MAP = {
  id:                      'id',
  restaurantId:            'restaurant_id',
  organizationId:          'organization_id',
  openingCash:             'opening_cash',
  openedBy:                'opened_by',
  openedByName:            'opened_by_name',
  operatorName:            'operator_name',
  openedAt:                'opened_at',
  openingNotes:            'opening_notes',
  status:                  'status',
  transactions:            'transactions',
  cashIn:                  'cash_in',
  cashOut:                 'cash_out',
  cashDrops:               'cash_drops',
  closingCash:             'closing_cash',
  closedBy:                'closed_by',
  closedByName:            'closed_by_name',
  closedAt:                'closed_at',
  closingNotes:            'closing_notes',
  denominations:           'denominations',
  totalSales:              'total_sales',
  cashSales:               'cash_sales',
  cardSales:               'card_sales',
  upiSales:                'upi_sales',
  aggregatorSales:         'aggregator_sales',
  otherSales:              'other_sales',
  orderCount:              'order_count',
  totalTips:               'total_tips',
  cashTips:                'cash_tips',
  cardTips:                'card_tips',
  serviceChargeCollected:  'service_charge_collected',
  expectedCash:            'expected_cash',
  cashDifference:          'cash_difference',
  createdAt:               'created_at',
  updatedAt:               'updated_at',
};

const REGISTER_REVERSE_MAP = buildReverseMap(REGISTER_FIELD_MAP);

const REGISTER_JSONB_COLUMNS = new Set([
  'transactions', 'denominations', 'extra_data',
]);

// ── shifts ────────────────────────────────────────────────────────────────

const SHIFT_FIELD_MAP = {
  id:                      'id',
  restaurantId:            'restaurant_id',
  organizationId:          'organization_id',
  openingCash:             'opening_cash',
  openedBy:                'opened_by',
  openedAt:                'opened_at',
  status:                  'status',
  transactions:            'transactions',
  cashIn:                  'cash_in',
  cashOut:                 'cash_out',
  cashDrops:               'cash_drops',
  closingCash:             'closing_cash',
  closedBy:                'closed_by',
  closedByName:            'closed_by_name',
  closedAt:                'closed_at',
  closingNotes:            'closing_notes',
  denominations:           'denominations',
  totalSales:              'total_sales',
  cashSales:               'cash_sales',
  cardSales:               'card_sales',
  upiSales:                'upi_sales',
  aggregatorSales:         'aggregator_sales',
  otherSales:              'other_sales',
  orderCount:              'order_count',
  totalTips:               'total_tips',
  cashTips:                'cash_tips',
  cardTips:                'card_tips',
  serviceChargeCollected:  'service_charge_collected',
  expectedCash:            'expected_cash',
  cashDifference:          'cash_difference',
  createdAt:               'created_at',
  updatedAt:               'updated_at',
};

const SHIFT_REVERSE_MAP = buildReverseMap(SHIFT_FIELD_MAP);

const SHIFT_JSONB_COLUMNS = new Set([
  'opened_by', 'transactions', 'denominations', 'extra_data',
]);

// ── restaurantShiftSettings ───────────────────────────────────────────────

const SHIFT_SETTINGS_FIELD_MAP = {
  id:                'id',
  restaurantId:      'restaurant_id',
  shiftTypes:        'shift_types',
  operatingHours:    'operating_hours',
  peakHours:         'peak_hours',
  minRestHours:      'min_rest_hours',
  maxHoursPerWeek:   'max_hours_per_week',
  maxHoursPerDay:    'max_hours_per_day',
  timeOff:           'time_off',
  createdAt:         'created_at',
  updatedAt:         'updated_at',
};

const SHIFT_SETTINGS_REVERSE_MAP = buildReverseMap(SHIFT_SETTINGS_FIELD_MAP);

const SHIFT_SETTINGS_JSONB_COLUMNS = new Set([
  'shift_types', 'operating_hours', 'peak_hours', 'time_off', 'extra_data',
]);

// ── staffShifts ───────────────────────────────────────────────────────────

const STAFF_SHIFT_FIELD_MAP = {
  id:                 'id',
  restaurantId:       'restaurant_id',
  staffId:            'staff_id',
  date:               'date',
  startTime:          'start_time',
  endTime:            'end_time',
  role:               'role',
  notes:              'notes',
  shiftName:          'shift_name',
  shiftId:            'shift_id',
  color:              'color',
  requiredEmployees:  'required_employees',
  requiredRoles:      'required_roles',
  isUnderstaffed:     'is_understaffed',
  hasConflicts:       'has_conflicts',
  createdAt:          'created_at',
  updatedAt:          'updated_at',
};

const STAFF_SHIFT_REVERSE_MAP = buildReverseMap(STAFF_SHIFT_FIELD_MAP);

const STAFF_SHIFT_JSONB_COLUMNS = new Set(['required_roles', 'extra_data']);

// ── staffAvailability ─────────────────────────────────────────────────────

const STAFF_AVAIL_FIELD_MAP = {
  id:            'id',
  staffId:       'staff_id',
  availability:  'availability',
  preferences:   'preferences',
  createdAt:     'created_at',
  updatedAt:     'updated_at',
};

const STAFF_AVAIL_REVERSE_MAP = buildReverseMap(STAFF_AVAIL_FIELD_MAP);

const STAFF_AVAIL_JSONB_COLUMNS = new Set(['availability', 'preferences', 'extra_data']);

// ── Generic toPgRow / toFirestoreObj ──────────────────────────────────────

function makeToPgRow(fieldMap) {
  return function toPgRow(firestoreObj) {
    const pgRow = {};
    const extra = {};

    for (const [key, value] of Object.entries(firestoreObj)) {
      if (value === undefined) continue;
      if (value !== null && typeof value === 'object' && typeof value.isEqual === 'function') continue;

      let cleanValue = value;
      if (value && typeof value.toDate === 'function') {
        cleanValue = value.toDate();
      } else if (value && typeof value === 'object' && value._seconds !== undefined) {
        cleanValue = new Date(value._seconds * 1000);
      }

      const pgCol = fieldMap[key];
      if (pgCol) {
        pgRow[pgCol] = cleanValue;
      } else {
        extra[key] = cleanValue;
      }
    }

    if (Object.keys(extra).length > 0) {
      pgRow.extra_data = extra;
    }

    return pgRow;
  };
}

function makeToFirestoreObj(reverseMap) {
  // A mapped column must come from the real column, never a stale extra_data copy.
  const mappedKeys = new Set([...Object.keys(reverseMap), ...Object.values(reverseMap)]);
  return function toFirestoreObj(pgRow) {
    const obj = {};
    const ed = pgRow.extra_data;
    if (ed && typeof ed === 'object') {
      for (const [k, v] of Object.entries(ed)) {
        if (v === null || v === undefined) continue;
        if (mappedKeys.has(k)) continue;
        obj[k] = v;
      }
    }
    for (const [col, value] of Object.entries(pgRow)) {
      if (col === 'extra_data') continue;
      if (value === null || value === undefined) continue;
      const camelKey = reverseMap[col];
      if (camelKey) obj[camelKey] = value;
    }
    return obj;
  };
}

module.exports = {
  // Cash Registers
  registerToPgRow:        makeToPgRow(REGISTER_FIELD_MAP),
  registerToFirestoreObj: makeToFirestoreObj(REGISTER_REVERSE_MAP),
  REGISTER_FIELD_MAP, REGISTER_REVERSE_MAP, REGISTER_JSONB_COLUMNS,

  // Shifts
  shiftToPgRow:        makeToPgRow(SHIFT_FIELD_MAP),
  shiftToFirestoreObj: makeToFirestoreObj(SHIFT_REVERSE_MAP),
  SHIFT_FIELD_MAP, SHIFT_REVERSE_MAP, SHIFT_JSONB_COLUMNS,

  // Restaurant Shift Settings
  shiftSettingsToPgRow:        makeToPgRow(SHIFT_SETTINGS_FIELD_MAP),
  shiftSettingsToFirestoreObj: makeToFirestoreObj(SHIFT_SETTINGS_REVERSE_MAP),
  SHIFT_SETTINGS_FIELD_MAP, SHIFT_SETTINGS_REVERSE_MAP, SHIFT_SETTINGS_JSONB_COLUMNS,

  // Staff Shifts
  staffShiftToPgRow:        makeToPgRow(STAFF_SHIFT_FIELD_MAP),
  staffShiftToFirestoreObj: makeToFirestoreObj(STAFF_SHIFT_REVERSE_MAP),
  STAFF_SHIFT_FIELD_MAP, STAFF_SHIFT_REVERSE_MAP, STAFF_SHIFT_JSONB_COLUMNS,

  // Staff Availability
  staffAvailToPgRow:        makeToPgRow(STAFF_AVAIL_FIELD_MAP),
  staffAvailToFirestoreObj: makeToFirestoreObj(STAFF_AVAIL_REVERSE_MAP),
  STAFF_AVAIL_FIELD_MAP, STAFF_AVAIL_REVERSE_MAP, STAFF_AVAIL_JSONB_COLUMNS,
};
