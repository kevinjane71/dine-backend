/**
 * fieldMapper.js — Maps between Firestore camelCase and PostgreSQL snake_case field names.
 *
 * This is the ONLY place that knows about the mapping. ordersRepo.js uses it
 * to convert Firestore-shaped objects to PG rows and vice versa.
 *
 * Any Firestore field NOT in this map goes into the `extra_data` JSONB column.
 * Any PG column NOT in this map is returned as-is (already snake_case).
 */

// camelCase (Firestore) → snake_case (PostgreSQL)
const FIELD_MAP = {
  // Core identifiers
  restaurantId: 'restaurant_id',
  orderNumber: 'order_number',
  dailyOrderId: 'daily_order_id',
  tabNumber: 'tab_number',
  idempotencyKey: 'idempotency_key',
  syncSource: 'sync_source',

  // Order type & status
  orderType: 'order_type',
  status: 'status',
  lastStatus: 'last_status',

  // Table / location
  tableNumber: 'table_number',
  tableId: 'table_id',
  floorId: 'floor_id',
  floorName: 'floor_name',
  tableSection: 'table_section',
  roomNumber: 'room_number',

  // Customer
  customerId: 'customer_id',
  customerName: 'customer_name',
  customerPhone: 'customer_phone',
  customerInfo: 'customer_info',

  // Staff
  staffInfo: 'staff_info',
  assignedStaff: 'assigned_staff',

  // Items
  items: 'items',

  // Pricing
  subtotal: 'subtotal',
  totalAmount: 'total_amount',
  finalAmount: 'final_amount',

  // Discounts
  discountAmount: 'discount_amount',
  offerDiscount: 'offer_discount',
  manualDiscount: 'manual_discount',
  manualDiscountType: 'manual_discount_type',
  manualDiscountValue: 'manual_discount_value',
  loyaltyDiscount: 'loyalty_discount',
  totalDiscountAmount: 'total_discount_amount',
  couponCode: 'coupon_code',
  couponId: 'coupon_id',
  couponDiscount: 'coupon_discount',
  walletRedeemAmount: 'wallet_redeem_amount',

  // Offers & pricing rules
  appliedOffer: 'applied_offer',
  appliedOffers: 'applied_offers',
  selectedOfferName: 'selected_offer_name',
  pricingRuleId: 'pricing_rule_id',
  pricingRuleName: 'pricing_rule_name',
  appliedPricingRules: 'applied_pricing_rules',
  zoneSurcharge: 'zone_surcharge',

  // Taxes
  taxAmount: 'tax_amount',
  taxBreakdown: 'tax_breakdown',
  taxInclusiveMode: 'tax_inclusive_mode',

  // Billing components
  serviceChargeRate: 'service_charge_rate',
  serviceChargeAmount: 'service_charge_amount',
  serviceChargeEnabled: 'service_charge_enabled',
  tipAmount: 'tip_amount',
  tipPercentage: 'tip_percentage',
  roundOffAmount: 'round_off_amount',
  deliveryCharge: 'delivery_charge',
  packingCharge: 'packing_charge',

  // Payment
  paymentMethod: 'payment_method',
  paymentStatus: 'payment_status',
  paidAmount: 'paid_amount',
  outstandingAmount: 'outstanding_amount',
  cashReceived: 'cash_received',
  changeReturned: 'change_returned',
  splitPayments: 'split_payments',
  splitBill: 'split_bill',

  // Loyalty
  loyaltyPointsEarned: 'loyalty_points_earned',
  loyaltyPointsRedeemed: 'loyalty_points_redeemed',
  redeemLoyaltyPoints: 'redeem_loyalty_points',

  // KOT / Kitchen
  notes: 'notes',
  specialInstructions: 'special_instructions',
  kotSent: 'kot_sent',
  kotPrinted: 'kot_printed',
  kotPrintedAt: 'kot_printed_at',
  kotPrintedStations: 'kot_printed_stations',
  kotNumber: 'kot_number',
  kotTime: 'kot_time',
  cookingStartTime: 'cooking_start_time',
  cookingEndTime: 'cooking_end_time',

  // Scheduling
  isScheduled: 'is_scheduled',
  scheduledFor: 'scheduled_for',

  // Source / Aggregator
  source: 'source',
  aggregatorOrderId: 'aggregator_order_id',
  aggregatorPlatform: 'aggregator_platform',

  // Delivery
  deliveryInfo: 'delivery_info',
  deliveryAddress: 'delivery_address',
  deliveryPartnerId: 'delivery_partner_id',

  // Multi-location
  subRestaurantId: 'sub_restaurant_id',
  subRestaurantName: 'sub_restaurant_name',

  // Hotel
  linkedToHotel: 'linked_to_hotel',
  hotelCheckInId: 'hotel_check_in_id',
  hotelBilledAndCheckedOut: 'hotel_billed_and_checked_out',

  // Edit tracking
  editCount: 'edit_count',
  editReason: 'edit_reason',
  preEditSnapshot: 'pre_edit_snapshot',

  // Cover count
  covers: 'covers',

  // Cancellation
  cancelledAt: 'cancelled_at',
  cancelledBy: 'cancelled_by',
  cancellationReason: 'cancellation_reason',

  // Restoration (recall cancelled order)
  restoredAt: 'restored_at',
  restoredBy: 'restored_by',
  restoredByName: 'restored_by_name',
  restoreReason: 'restore_reason',
  restorationHistory: 'restoration_history',

  // Refund
  refundedAt: 'refunded_at',
  refundedBy: 'refunded_by',
  refundAmount: 'refund_amount',
  refundReason: 'refund_reason',
  refundType: 'refund_type',

  // Comp / Void
  compAmount: 'comp_amount',
  voidItems: 'void_items',
  removedItems: 'removed_items',

  // Item count
  itemCount: 'item_count',

  // Misc
  shareToken: 'share_token',
  billPrinted: 'bill_printed',
  priceDiscrepancies: 'price_discrepancies',

  // Timestamps
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  completedAt: 'completed_at',
  expiredAt: 'expired_at',
};

// Reverse map: snake_case → camelCase
const REVERSE_MAP = {};
for (const [camel, snake] of Object.entries(FIELD_MAP)) {
  REVERSE_MAP[snake] = camel;
}

// Set of all known PG column names (for identifying what goes to extra_data)
const PG_COLUMNS = new Set(Object.values(FIELD_MAP));
PG_COLUMNS.add('id');
PG_COLUMNS.add('extra_data');

// JSONB columns — values must be serialized as JSON strings for pg parameterized queries
const JSONB_COLUMNS = new Set([
  'customer_info', 'staff_info', 'assigned_staff', 'items',
  'applied_offer', 'applied_offers', 'applied_pricing_rules',
  'tax_breakdown', 'split_payments', 'split_bill',
  'kot_printed_stations', 'delivery_info', 'delivery_address',
  'pre_edit_snapshot', 'void_items', 'removed_items',
  'price_discrepancies', 'restoration_history', 'extra_data',
]);

/**
 * Convert a Firestore camelCase order object → PostgreSQL row object.
 * - Known fields are mapped to snake_case columns
 * - Unknown fields are collected into extra_data JSONB
 * - 'id' is passed through as-is
 *
 * @param {Object} firestoreObj - Firestore order document data (with or without id)
 * @returns {Object} pgRow - { column_name: value, ... }
 */
function toPgRow(firestoreObj) {
  const pgRow = {};
  const extraData = {};

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (key === 'id') {
      pgRow.id = value;
      continue;
    }

    const pgCol = FIELD_MAP[key];
    if (pgCol) {
      pgRow[pgCol] = convertTimestamp(value);
    } else {
      // Unknown field → extra_data
      extraData[key] = convertTimestamp(value);
    }
  }

  // Only set extra_data if there are unmapped fields
  if (Object.keys(extraData).length > 0) {
    pgRow.extra_data = extraData;
  }

  return pgRow;
}

/**
 * Convert a PostgreSQL row → Firestore-shaped camelCase object.
 * - Known columns are mapped back to camelCase
 * - extra_data fields are spread into the top-level object
 * - 'id' is passed through as-is
 *
 * @param {Object} pgRow - PostgreSQL row object
 * @returns {Object} camelObj - { camelCaseField: value, ... }
 */
function toFirestoreObj(pgRow) {
  const result = {};

  for (const [col, value] of Object.entries(pgRow)) {
    if (value === null || value === undefined) continue;

    if (col === 'id') {
      result.id = value;
      continue;
    }

    if (col === 'extra_data' && typeof value === 'object') {
      // Spread extra_data fields back into top-level
      Object.assign(result, value);
      continue;
    }

    const camelKey = REVERSE_MAP[col];
    if (camelKey) {
      result[camelKey] = value;
    } else {
      // PG column with no reverse mapping — pass through as-is
      result[col] = value;
    }
  }

  return result;
}

/**
 * Convert Firestore Timestamp objects to JS Date.
 * Handles: Firestore Timestamp (.toDate()), { _seconds, _nanoseconds }, Date, primitives.
 */
function convertTimestamp(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && typeof val.toDate === 'function') {
    return val.toDate();
  }
  if (typeof val === 'object' && val._seconds !== undefined) {
    return new Date(val._seconds * 1000);
  }
  return val;
}

/**
 * Convert a value to a valid JSONB string for PostgreSQL.
 * Handles: null, objects/arrays (JSON.stringify), and plain strings
 * (which must be JSON-encoded as `"string"` for JSONB).
 */
function toJsonbValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return JSON.stringify(val);
  // Plain string — must be wrapped as a JSON string for JSONB
  // e.g. "Chennai" → '"Chennai"'
  return JSON.stringify(val);
}

/**
 * Build a parameterized INSERT query from a pgRow object.
 * Returns { text, values } for use with pg client.query().
 */
function buildInsert(pgRow) {
  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const [col, val] of Object.entries(pgRow)) {
    cols.push(col);
    if (JSONB_COLUMNS.has(col)) {
      placeholders.push(`$${i}::jsonb`);
      values.push(toJsonbValue(val));
    } else {
      placeholders.push(`$${i}`);
      values.push(val);
    }
    i++;
  }

  return {
    text: `INSERT INTO orders (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values,
  };
}

/**
 * Build a parameterized UPDATE query from a partial pgRow object.
 * Returns { text, values } for use with pg client.query().
 *
 * @param {string} orderId - The order ID (WHERE clause)
 * @param {Object} pgRow - Partial row with only the columns to update
 */
function buildUpdate(orderId, pgRow) {
  const setClauses = [];
  const values = [];
  let i = 1;

  for (const [col, val] of Object.entries(pgRow)) {
    if (col === 'id') continue; // never update the PK
    if (JSONB_COLUMNS.has(col)) {
      if (col === 'extra_data') {
        // Merge into existing extra_data instead of replacing
        setClauses.push(`${col} = COALESCE(${col}, '{}'::jsonb) || $${i}::jsonb`);
      } else {
        setClauses.push(`${col} = $${i}::jsonb`);
      }
      values.push(toJsonbValue(val));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(val);
    }
    i++;
  }

  values.push(orderId);
  return {
    text: `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $${i} RETURNING *`,
    values,
  };
}

module.exports = {
  FIELD_MAP,
  REVERSE_MAP,
  PG_COLUMNS,
  JSONB_COLUMNS,
  toPgRow,
  toFirestoreObj,
  buildInsert,
  buildUpdate,
  convertTimestamp,
  toJsonbValue,
};
