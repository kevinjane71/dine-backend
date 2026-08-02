/**
 * inventoryFieldMapper.js — camelCase (Firestore) ↔ snake_case (PostgreSQL)
 * for all 7 inventory-related collections.
 *
 * Each collection has its own FIELD_MAP / REVERSE_MAP / JSONB_COLUMNS set.
 * Complex nested objects (ingredients, snapshots, wastageEntries) stored as JSONB.
 */

// ── Helper: build reverse map ────────────────────────────────────────────
function buildReverse(map) {
  const rev = {};
  for (const [k, v] of Object.entries(map)) rev[v] = k;
  return rev;
}

// ── Helper: convert Firestore Timestamps / FieldValue sentinels ──────────
function cleanValue(value) {
  if (value === undefined) return undefined;
  if (value !== null && typeof value === 'object' && typeof value.isEqual === 'function') {
    return undefined; // Skip FieldValue.delete(), serverTimestamp(), etc.
  }
  if (value && typeof value.toDate === 'function') {
    return value.toDate();
  }
  return value;
}

// ── Generic toPgRow / toFirestoreObj ─────────────────────────────────────
function makeToPgRow(fieldMap, skipFields = new Set()) {
  return function toPgRow(firestoreObj) {
    const pgRow = {};
    const extra = {};

    for (const [key, value] of Object.entries(firestoreObj)) {
      if (skipFields.has(key)) continue;
      const cleaned = cleanValue(value);
      if (cleaned === undefined) continue;

      const pgCol = fieldMap[key];
      if (pgCol) {
        pgRow[pgCol] = cleaned;
      } else {
        extra[key] = cleaned;
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. INVENTORY
// ═══════════════════════════════════════════════════════════════════════════
const INVENTORY_FIELD_MAP = {
  id:                  'id',
  restaurantId:        'restaurant_id',
  name:                'name',
  category:            'category',
  unit:                'unit',
  currentStock:        'current_stock',
  minStock:            'min_stock',
  maxStock:            'max_stock',
  costPerUnit:         'cost_per_unit',
  supplier:            'supplier',
  description:         'description',
  barcode:             'barcode',
  location:            'location',
  status:              'status',
  linkedMenuItemId:    'linked_menu_item_id',
  linkedMenuItemName:  'linked_menu_item_name',
  expiryDate:          'expiry_date',
  mfgDate:             'mfg_date',
  expiryDays:          'expiry_days',
  wastedQty:           'wasted_qty',
  createdBy:           'created_by',
  updatedBy:           'updated_by',
  lastUpdated:         'last_updated',
  createdAt:           'created_at',
  updatedAt:           'updated_at',
};
const INVENTORY_REVERSE = buildReverse(INVENTORY_FIELD_MAP);
const INVENTORY_JSONB = new Set(['extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// 2. INVENTORY TRANSACTIONS
// ═══════════════════════════════════════════════════════════════════════════
const INV_TX_FIELD_MAP = {
  id:                      'id',
  restaurantId:            'restaurant_id',
  inventoryItemId:         'inventory_item_id',
  inventoryItemName:       'inventory_item_name',
  type:                    'type',
  source:                  'source',
  quantityChange:          'quantity_change',
  previousStock:           'previous_stock',
  newStock:                'new_stock',
  unit:                    'unit',
  costPerUnit:             'cost_per_unit',
  previousCostPerUnit:     'previous_cost_per_unit',
  totalCost:               'total_cost',
  date:                    'date',
  referenceId:             'reference_id',
  orderId:                 'order_id',      // base order id (restore queries WHERE on this)
  reversedAt:              'reversed_at',   // set when a deduction is reversed on cancel
  batchIds:                'batch_ids',
  performedBy:             'performed_by',
  notes:                   'notes',
  originalTransactionId:   'original_transaction_id',
  createdAt:               'created_at',
};
const INV_TX_REVERSE = buildReverse(INV_TX_FIELD_MAP);
const INV_TX_JSONB = new Set(['batch_ids', 'extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// 3. STOCK BATCHES
// ═══════════════════════════════════════════════════════════════════════════
const STOCK_BATCH_FIELD_MAP = {
  id:                  'id',
  restaurantId:        'restaurant_id',
  inventoryItemId:     'inventory_item_id',
  inventoryItemName:   'inventory_item_name',
  quantity:            'quantity',
  initialQty:          'initial_qty',
  remainingQty:        'remaining_qty',
  unit:                'unit',
  mfgDate:             'mfg_date',
  expiryDate:          'expiry_date',
  expiryDays:          'expiry_days',
  costPerUnit:         'cost_per_unit',
  supplier:            'supplier',
  source:              'source',
  status:              'status',
  batchId:             'batch_id',
  addedBy:             'added_by',
  createdAt:           'created_at',
  updatedAt:           'updated_at',
};
const STOCK_BATCH_REVERSE = buildReverse(STOCK_BATCH_FIELD_MAP);
const STOCK_BATCH_JSONB = new Set(['extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// 4. WASTE ENTRIES
// ═══════════════════════════════════════════════════════════════════════════
const WASTE_FIELD_MAP = {
  id:            'id',
  restaurantId:  'restaurant_id',
  itemId:        'item_id',
  itemName:      'item_name',
  quantity:      'quantity',
  unit:          'unit',
  reason:        'reason',
  source:        'source',
  costPerUnit:   'cost_per_unit',
  wasteValue:    'waste_value',
  totalCost:     'total_cost',
  batchId:       'batch_id',
  notes:         'notes',
  recordedBy:    'recorded_by',
  date:          'date',
  createdAt:     'created_at',
};
const WASTE_REVERSE = buildReverse(WASTE_FIELD_MAP);
const WASTE_JSONB = new Set(['extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// 5. RECIPES
// ═══════════════════════════════════════════════════════════════════════════
const RECIPE_FIELD_MAP = {
  id:                'id',
  restaurantId:      'restaurant_id',
  menuItemId:        'menu_item_id',
  menuItemName:      'menu_item_name',
  name:              'name',
  description:       'description',
  category:          'category',
  servings:          'servings',
  prepTime:          'prep_time',
  cookTime:          'cook_time',
  ingredients:       'ingredients',
  instructions:      'instructions',
  isActive:          'is_active',
  isAutoGenerated:   'is_auto_generated',
  createdBy:         'created_by',
  updatedBy:         'updated_by',
  createdAt:         'created_at',
  updatedAt:         'updated_at',
};
const RECIPE_REVERSE = buildReverse(RECIPE_FIELD_MAP);
const RECIPE_JSONB = new Set(['ingredients', 'instructions', 'extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// 6. BAR BOTTLES
// ═══════════════════════════════════════════════════════════════════════════
const BAR_BOTTLE_FIELD_MAP = {
  id:                 'id',
  restaurantId:       'restaurant_id',
  inventoryItemId:    'inventory_item_id',
  menuItemId:         'menu_item_id',
  barcode:            'barcode',
  name:               'name',
  brand:              'brand',
  category:           'category',
  categoryId:         'category_id',
  bottleSize:         'bottle_size',
  pegSize:            'peg_size',
  fullWeight:         'full_weight',
  tareWeight:         'tare_weight',
  openingWeight:      'opening_weight',
  currentWeight:      'current_weight',
  closingWeight:      'closing_weight',
  status:             'status',
  openedAt:           'opened_at',
  openedBy:           'opened_by',
  emptyAt:            'empty_at',
  totalPegsExpected:  'total_pegs_expected',
  totalPegsPoured:    'total_pegs_poured',
  totalMlPoured:      'total_ml_poured',
  totalMlSold:        'total_ml_sold',
  wastage:            'wastage',
  wastageEntries:     'wastage_entries',
  batchId:            'batch_id',
  costPrice:          'cost_price',
  mlPerGram:          'ml_per_gram',
  createdBy:          'created_by',
  createdAt:          'created_at',
  updatedAt:          'updated_at',
};
const BAR_BOTTLE_REVERSE = buildReverse(BAR_BOTTLE_FIELD_MAP);
const BAR_BOTTLE_JSONB = new Set(['wastage_entries', 'extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// 7. BAR RECONCILIATION
// ═══════════════════════════════════════════════════════════════════════════
const BAR_RECON_FIELD_MAP = {
  id:                  'id',
  restaurantId:        'restaurant_id',
  date:                'date',
  shift:               'shift',
  status:              'status',
  openingSnapshot:     'opening_snapshot',
  closingSnapshot:     'closing_snapshot',
  totalMlConsumed:     'total_ml_consumed',
  totalMlSold:         'total_ml_sold',
  totalVariance:       'total_variance',
  totalVarianceValue:  'total_variance_value',
  openedAt:            'opened_at',
  openedBy:            'opened_by',
  closedAt:            'closed_at',
  closedBy:            'closed_by',
  notes:               'notes',
  createdAt:           'created_at',
};
const BAR_RECON_REVERSE = buildReverse(BAR_RECON_FIELD_MAP);
const BAR_RECON_JSONB = new Set(['opening_snapshot', 'closing_snapshot', 'extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// Build converters for each collection
// ═══════════════════════════════════════════════════════════════════════════
const inventory = {
  FIELD_MAP: INVENTORY_FIELD_MAP,
  REVERSE_MAP: INVENTORY_REVERSE,
  JSONB_COLUMNS: INVENTORY_JSONB,
  toPgRow: makeToPgRow(INVENTORY_FIELD_MAP),
  toFirestoreObj: makeToFirestoreObj(INVENTORY_REVERSE),
};

const inventoryTransactions = {
  FIELD_MAP: INV_TX_FIELD_MAP,
  REVERSE_MAP: INV_TX_REVERSE,
  JSONB_COLUMNS: INV_TX_JSONB,
  toPgRow: makeToPgRow(INV_TX_FIELD_MAP),
  toFirestoreObj: makeToFirestoreObj(INV_TX_REVERSE),
};

const stockBatches = {
  FIELD_MAP: STOCK_BATCH_FIELD_MAP,
  REVERSE_MAP: STOCK_BATCH_REVERSE,
  JSONB_COLUMNS: STOCK_BATCH_JSONB,
  toPgRow: makeToPgRow(STOCK_BATCH_FIELD_MAP),
  toFirestoreObj: makeToFirestoreObj(STOCK_BATCH_REVERSE),
};

const wasteEntries = {
  FIELD_MAP: WASTE_FIELD_MAP,
  REVERSE_MAP: WASTE_REVERSE,
  JSONB_COLUMNS: WASTE_JSONB,
  toPgRow: makeToPgRow(WASTE_FIELD_MAP),
  toFirestoreObj: makeToFirestoreObj(WASTE_REVERSE),
};

const recipes = {
  FIELD_MAP: RECIPE_FIELD_MAP,
  REVERSE_MAP: RECIPE_REVERSE,
  JSONB_COLUMNS: RECIPE_JSONB,
  toPgRow: makeToPgRow(RECIPE_FIELD_MAP),
  toFirestoreObj: makeToFirestoreObj(RECIPE_REVERSE),
};

const barBottles = {
  FIELD_MAP: BAR_BOTTLE_FIELD_MAP,
  REVERSE_MAP: BAR_BOTTLE_REVERSE,
  JSONB_COLUMNS: BAR_BOTTLE_JSONB,
  toPgRow: makeToPgRow(BAR_BOTTLE_FIELD_MAP),
  toFirestoreObj: makeToFirestoreObj(BAR_BOTTLE_REVERSE),
};

const barReconciliation = {
  FIELD_MAP: BAR_RECON_FIELD_MAP,
  REVERSE_MAP: BAR_RECON_REVERSE,
  JSONB_COLUMNS: BAR_RECON_JSONB,
  toPgRow: makeToPgRow(BAR_RECON_FIELD_MAP),
  toFirestoreObj: makeToFirestoreObj(BAR_RECON_REVERSE),
};

module.exports = {
  inventory,
  inventoryTransactions,
  stockBatches,
  wasteEntries,
  recipes,
  barBottles,
  barReconciliation,
};
