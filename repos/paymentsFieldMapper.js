/**
 * paymentsFieldMapper.js — camelCase (Firestore) ↔ snake_case (PostgreSQL)
 * for dine_payments, dine_subscriptions, and dine_razorpay_orders collections.
 */

const { buildReverseMap } = require('./queryBuilder');

// ── dine_payments ─────────────────────────────────────────────────────────

const PAYMENTS_FIELD_MAP = {
  id:                'id',
  subscriptionId:    'subscription_id',
  orderId:           'order_id',
  paymentId:         'payment_id',
  signature:         'signature',
  planId:            'plan_id',
  email:             'email',
  userId:            'user_id',
  phone:             'phone',
  shopId:            'shop_id',
  amount:            'amount',
  currency:          'currency',
  app:               'app',
  status:            'status',
  type:              'type',
  method:            'method',
  syncedFromRazorpay: 'synced_from_razorpay',
  verifiedAt:        'verified_at',
  webhookAt:         'webhook_at',
  createdAt:         'created_at',
  updatedAt:         'updated_at',
};

const PAYMENTS_REVERSE_MAP = buildReverseMap(PAYMENTS_FIELD_MAP);

const PAYMENTS_JSONB_COLUMNS = new Set(['extra_data']);

// ── dine_subscriptions ────────────────────────────────────────────────────

const SUBSCRIPTIONS_FIELD_MAP = {
  id:                   'id',
  subscriptionId:       'subscription_id',
  razorpayPlanId:       'razorpay_plan_id',
  planId:               'plan_id',
  email:                'email',
  userId:               'user_id',
  phone:                'phone',
  shopId:               'shop_id',
  app:                  'app',
  status:               'status',
  paymentId:            'payment_id',
  activatedAt:          'activated_at',
  lastChargedAt:        'last_charged_at',
  cancelledAt:          'cancelled_at',
  completedAt:          'completed_at',
  createdAt:            'created_at',
  updatedAt:            'updated_at',
};

const SUBSCRIPTIONS_REVERSE_MAP = buildReverseMap(SUBSCRIPTIONS_FIELD_MAP);

const SUBSCRIPTIONS_JSONB_COLUMNS = new Set(['extra_data']);

// ── dine_razorpay_orders ──────────────────────────────────────────────────

const ORDERS_FIELD_MAP = {
  id:                   'id',
  orderId:              'order_id',
  amount:               'amount',
  currency:             'currency',
  planId:               'plan_id',
  email:                'email',
  userId:               'user_id',
  phone:                'phone',
  shopId:               'shop_id',
  app:                  'app',
  status:               'status',
  paymentId:            'payment_id',
  syncedFromRazorpay:   'synced_from_razorpay',
  createdAt:            'created_at',
  updatedAt:            'updated_at',
};

const ORDERS_REVERSE_MAP = buildReverseMap(ORDERS_FIELD_MAP);

const ORDERS_JSONB_COLUMNS = new Set(['extra_data']);

// ── Shared toPgRow / toFirestoreObj factories ─────────────────────────────

function makeToPgRow(fieldMap, jsonbColumns) {
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
  // Payments
  paymentsToPgRow:        makeToPgRow(PAYMENTS_FIELD_MAP, PAYMENTS_JSONB_COLUMNS),
  paymentsToFirestoreObj: makeToFirestoreObj(PAYMENTS_REVERSE_MAP),
  PAYMENTS_FIELD_MAP,
  PAYMENTS_REVERSE_MAP,
  PAYMENTS_JSONB_COLUMNS,

  // Subscriptions
  subscriptionsToPgRow:        makeToPgRow(SUBSCRIPTIONS_FIELD_MAP, SUBSCRIPTIONS_JSONB_COLUMNS),
  subscriptionsToFirestoreObj: makeToFirestoreObj(SUBSCRIPTIONS_REVERSE_MAP),
  SUBSCRIPTIONS_FIELD_MAP,
  SUBSCRIPTIONS_REVERSE_MAP,
  SUBSCRIPTIONS_JSONB_COLUMNS,

  // Razorpay Orders
  ordersToPgRow:        makeToPgRow(ORDERS_FIELD_MAP, ORDERS_JSONB_COLUMNS),
  ordersToFirestoreObj: makeToFirestoreObj(ORDERS_REVERSE_MAP),
  ORDERS_FIELD_MAP,
  ORDERS_REVERSE_MAP,
  ORDERS_JSONB_COLUMNS,
};
