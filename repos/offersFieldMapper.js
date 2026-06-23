/**
 * offersFieldMapper.js — camelCase (Firestore) ↔ snake_case (PostgreSQL)
 * for the offers collection + customerOfferUsage subcollection.
 */

const { buildReverseMap } = require('./queryBuilder');

const FIELD_MAP = {
  id:                      'id',
  restaurantId:            'restaurant_id',
  name:                    'name',
  description:             'description',
  discountType:            'discount_type',
  discountValue:           'discount_value',
  minOrderValue:           'min_order_value',
  maxDiscount:             'max_discount',
  validFrom:               'valid_from',
  validUntil:              'valid_until',
  isActive:                'is_active',
  usageLimit:              'usage_limit',
  usageCount:              'usage_count',
  isFirstOrderOnly:        'is_first_order_only',
  autoApply:               'auto_apply',
  scope:                   'scope',
  targetCategories:        'target_categories',
  targetItems:             'target_items',
  targetRestaurants:       'target_restaurants',
  schedule:                'schedule',
  promotionType:           'promotion_type',
  bogoConfig:              'bogo_config',
  eventLabel:              'event_label',
  audience:                'audience',
  tiers:                   'tiers',
  crossItemBogo:           'cross_item_bogo',
  usageLimitPerCustomer:   'usage_limit_per_customer',
  priority:                'priority',
  createdAt:               'created_at',
  updatedAt:               'updated_at',
};

const REVERSE_MAP = buildReverseMap(FIELD_MAP);

const JSONB_COLUMNS = new Set([
  'target_categories', 'target_items', 'target_restaurants',
  'schedule', 'bogo_config', 'audience', 'tiers', 'cross_item_bogo',
  'extra_data',
]);

const SKIP_FIELDS = new Set([]);

function toPgRow(firestoreObj) {
  const pgRow = {};
  const extra = {};

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && typeof value.isEqual === 'function') continue;

    let cleanValue = value;
    if (value && typeof value.toDate === 'function') {
      cleanValue = value.toDate();
    } else if (value && typeof value === 'object' && value._seconds !== undefined) {
      cleanValue = new Date(value._seconds * 1000);
    }

    const pgCol = FIELD_MAP[key];
    if (pgCol) {
      // Convert empty strings to null for timestamp columns
      if ((pgCol === 'valid_from' || pgCol === 'valid_until') && cleanValue === '') {
        cleanValue = null;
      }
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

function toFirestoreObj(pgRow) {
  const obj = {};

  for (const [col, value] of Object.entries(pgRow)) {
    if (value === null || value === undefined) continue;

    const camelKey = REVERSE_MAP[col];
    if (camelKey) {
      obj[camelKey] = value;
    } else if (col === 'extra_data' && typeof value === 'object') {
      Object.assign(obj, value);
    }
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
