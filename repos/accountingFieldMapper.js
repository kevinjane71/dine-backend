/**
 * accountingFieldMapper.js — camelCase (Firestore) ↔ snake_case (PostgreSQL)
 * for chartOfAccounts, journalEntries, and expenses collections.
 */

const { buildReverseMap } = require('./queryBuilder');

// ── chartOfAccounts ───────────────────────────────────────────────────────

const COA_FIELD_MAP = {
  id:            'id',
  restaurantId:  'restaurant_id',
  code:          'code',
  name:          'name',
  type:          'type',
  parentCode:    'parent_code',
  isSystem:      'is_system',
  balance:       'balance',
  description:   'description',
  createdAt:     'created_at',
  updatedAt:     'updated_at',
};

const COA_REVERSE_MAP = buildReverseMap(COA_FIELD_MAP);
const COA_JSONB_COLUMNS = new Set(['extra_data']);

// ── journalEntries ────────────────────────────────────────────────────────

const JE_FIELD_MAP = {
  id:                 'id',
  restaurantId:       'restaurant_id',
  date:               'date',
  description:        'description',
  debitAccount:       'debit_account',
  debitAccountName:   'debit_account_name',
  creditAccount:      'credit_account',
  creditAccountName:  'credit_account_name',
  amount:             'amount',
  reference:          'reference',
  createdBy:          'created_by',
  createdAt:          'created_at',
};

const JE_REVERSE_MAP = buildReverseMap(JE_FIELD_MAP);
const JE_JSONB_COLUMNS = new Set(['reference', 'extra_data']);

// ── expenses ──────────────────────────────────────────────────────────────

const EXP_FIELD_MAP = {
  id:                   'id',
  restaurantId:         'restaurant_id',
  category:             'category',
  subCategories:        'sub_categories',
  amount:               'amount',
  date:                 'date',
  description:          'description',
  paymentMethod:        'payment_method',
  receiptUrl:           'receipt_url',
  isRecurring:          'is_recurring',
  recurringFrequency:   'recurring_frequency',
  vendor:               'vendor',
  createdBy:            'created_by',
  createdAt:            'created_at',
  updatedAt:            'updated_at',
};

const EXP_REVERSE_MAP = buildReverseMap(EXP_FIELD_MAP);
const EXP_JSONB_COLUMNS = new Set(['sub_categories', 'extra_data']);

// ── Generic factories ─────────────────────────────────────────────────────

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
  coaToPgRow:        makeToPgRow(COA_FIELD_MAP),
  coaToFirestoreObj: makeToFirestoreObj(COA_REVERSE_MAP),
  COA_FIELD_MAP, COA_REVERSE_MAP, COA_JSONB_COLUMNS,

  jeToPgRow:        makeToPgRow(JE_FIELD_MAP),
  jeToFirestoreObj: makeToFirestoreObj(JE_REVERSE_MAP),
  JE_FIELD_MAP, JE_REVERSE_MAP, JE_JSONB_COLUMNS,

  expToPgRow:        makeToPgRow(EXP_FIELD_MAP),
  expToFirestoreObj: makeToFirestoreObj(EXP_REVERSE_MAP),
  EXP_FIELD_MAP, EXP_REVERSE_MAP, EXP_JSONB_COLUMNS,
};
