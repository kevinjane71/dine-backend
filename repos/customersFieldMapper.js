/**
 * customersFieldMapper.js — camelCase (Firestore) ↔ snake_case (PostgreSQL)
 * for the customers collection.
 *
 * Array fields (orderHistory, creditHistory, walletHistory, tipHistory,
 * loyaltyTransactions, settlementHistory) are stored as JSONB arrays.
 */

const { buildReverseMap } = require('./queryBuilder');

// ── Field mapping: Firestore camelCase → PG snake_case ──────────────────

const FIELD_MAP = {
  id:                     'id',
  customerId:             'customer_id',
  restaurantId:           'restaurant_id',
  firebaseUid:            'firebase_uid',

  // Basic info
  name:                   'name',
  phone:                  'phone',
  email:                  'email',
  city:                   'city',
  dob:                    'dob',
  address:                'address',
  locality:               'locality',
  anniversary:            'anniversary',
  gstNumber:              'gst_number',
  source:                 'source',
  doNotContact:           'do_not_contact',
  whatsappBillEnabled:    'whatsapp_bill_enabled',

  // Order tracking
  totalOrders:            'total_orders',
  totalSpent:             'total_spent',
  lastOrderDate:          'last_order_date',
  orderHistory:           'order_history',

  // Loyalty
  loyaltyPoints:          'loyalty_points',
  lifetimePoints:         'lifetime_points',
  loyaltyTier:            'loyalty_tier',
  loyaltyTransactions:    'loyalty_transactions',

  // Credit
  outstandingBalance:     'outstanding_balance',
  creditHistory:          'credit_history',
  settlementHistory:      'settlement_history',

  // Wallet
  walletBalance:          'wallet_balance',
  walletHistory:          'wallet_history',
  walletCardNumber:       'wallet_card_number',
  walletCardBarcode:      'wallet_card_barcode',

  // Tips
  tipEarnings:            'tip_earnings',
  tipHistory:             'tip_history',

  // Timestamps
  createdAt:              'created_at',
  updatedAt:              'updated_at',
};

const REVERSE_MAP = buildReverseMap(FIELD_MAP);

const JSONB_COLUMNS = new Set([
  'order_history',
  'loyalty_transactions',
  'credit_history',
  'settlement_history',
  'wallet_history',
  'tip_history',
  'extra_data',
]);

const SKIP_FIELDS = new Set([]);

/**
 * Convert a Firestore customer object → PG row.
 */
function toPgRow(firestoreObj) {
  const pgRow = {};
  const extra = {};

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (value === undefined) continue;

    // Skip Firestore FieldValue sentinels (serverTimestamp/increment/…) — but NOT
    // Timestamp values, which ALSO expose isEqual() and must be converted below.
    // (A Timestamp has toDate()/_seconds; a sentinel does not.) Dropping them here was
    // silently discarding createdAt/updatedAt so the column defaulted to NOW().
    if (value !== null && typeof value === 'object' && typeof value.isEqual === 'function'
        && typeof value.toDate !== 'function' && value._seconds === undefined) {
      continue;
    }

    // Convert Firestore Timestamps to Date
    let cleanValue = value;
    if (value && typeof value.toDate === 'function') {
      cleanValue = value.toDate();
    } else if (value && typeof value === 'object' && value._seconds !== undefined) {
      cleanValue = new Date(value._seconds * 1000);
    }

    const pgCol = FIELD_MAP[key];
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
}

/**
 * Convert a PG row → Firestore-shaped camelCase object.
 */
function toFirestoreObj(pgRow) {
  const obj = {};

  // extra_data first (lowest priority); skip mapped-column keys so a stale copy never
  // overwrites the real column. Then real columns override.
  const ed = pgRow.extra_data;
  if (ed && typeof ed === 'object') {
    for (const [k, v] of Object.entries(ed)) {
      if (v === null || v === undefined) continue;
      if (FIELD_MAP[k] || REVERSE_MAP[k]) continue;
      obj[k] = v;
    }
  }
  for (const [col, value] of Object.entries(pgRow)) {
    if (col === 'extra_data') continue;
    if (value === null || value === undefined) continue;
    const camelKey = REVERSE_MAP[col];
    if (camelKey) obj[camelKey] = value;
  }

  return obj;
}

module.exports = {
  toPgRow,
  toFirestoreObj,
  FIELD_MAP,
  REVERSE_MAP,
  JSONB_COLUMNS,
  SKIP_FIELDS,
};
