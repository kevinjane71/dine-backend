/**
 * restaurantsFieldMapper.js — camelCase (Firestore) ↔ snake_case (PostgreSQL)
 * for the restaurants collection.
 *
 * Complex nested objects (posSettings, customerAppSettings, etc.) are stored
 * as JSONB columns directly — no flattening.
 */

// ── Field mapping: Firestore camelCase → PG snake_case ──────────────────

const FIELD_MAP = {
  id:                          'id',
  ownerId:                     'owner_id',
  name:                        'name',
  address:                     'address',
  city:                        'city',
  phone:                       'phone',
  email:                       'email',
  cuisine:                     'cuisine',
  description:                 'description',
  logo:                        'logo',
  coverImage:                  'cover_image',
  businessType:                'business_type',
  status:                      'status',
  isActive:                    'is_active',
  countryCode:                 'country_code',
  currencySymbol:              'currency_symbol',

  // URL & Identity
  subdomain:                   'subdomain',
  subdomainEnabled:            'subdomain_enabled',
  urlSlug:                     'url_slug',
  restaurantCode:              'restaurant_code',
  qrData:                      'qr_data',

  // Legal
  legalBusinessName:           'legal_business_name',
  gstin:                       'gstin',
  fssai:                       'fssai',
  panNumber:                   'pan_number',
  businessRegistrationNumber:  'business_registration_number',
  showGstOnInvoice:            'show_gst_on_invoice',

  // Capacity
  staffCount:                  'staff_count',
  seatingCapacity:             'seating_capacity',
  onboardingStep:              'onboarding_step',

  // Multi-location
  parentRestaurantId:          'parent_restaurant_id',

  // Menu flag
  hasDefaultMenu:              'has_default_menu',

  // Menu (embedded items + categories)
  menu:                        'menu',
  categories:                  'categories',

  // JSONB complex settings
  operatingHours:              'operating_hours',
  features:                    'features',
  posSettings:                 'pos_settings',
  orderSettings:               'order_settings',
  printSettings:               'print_settings',
  ecrSettings:                 'ecr_settings',
  pricingSettings:             'pricing_settings',
  taxSettings:                 'tax_settings',
  currencySettings:            'currency_settings',
  customerAppSettings:         'customer_app_settings',
  billingSettings:             'billing_settings',
  billingAudit:                'billing_audit',
  bookingSettings:             'booking_settings',
  feedbackSettings:            'feedback_settings',
  barInventorySettings:        'bar_inventory_settings',
  discountApprovalSettings:    'discount_approval_settings',
  kotSettings:                 'kot_settings',
  aggregatorConfig:            'aggregator_config',
  etimsConfig:                 'etims_config',

  // Timestamps
  createdAt:                   'created_at',
  updatedAt:                   'updated_at',
};

// Reverse map: snake_case → camelCase
const REVERSE_MAP = {};
for (const [k, v] of Object.entries(FIELD_MAP)) {
  REVERSE_MAP[v] = k;
}

// Set of PG columns that store JSONB
const JSONB_COLUMNS = new Set([
  'cuisine', 'operating_hours', 'features', 'pos_settings', 'order_settings',
  'print_settings', 'ecr_settings', 'pricing_settings', 'tax_settings',
  'currency_settings', 'customer_app_settings', 'billing_settings',
  'billing_audit', 'booking_settings', 'feedback_settings',
  'bar_inventory_settings', 'discount_approval_settings', 'kot_settings',
  'aggregator_config', 'etims_config', 'menu', 'categories', 'extra_data',
]);

// Fields to skip entirely (too large / separate concern)
const SKIP_FIELDS = new Set([
  'qrCode',     // Huge base64 string, fetched separately
]);

/**
 * Convert a Firestore restaurant object → PG row.
 */
function toPgRow(firestoreObj) {
  const pgRow = {};
  const extra = {};

  for (const [key, value] of Object.entries(firestoreObj)) {
    if (SKIP_FIELDS.has(key)) continue;
    if (value === undefined) continue;

    // Handle Firestore FieldValue sentinels
    if (value !== null && typeof value === 'object' && typeof value.isEqual === 'function' && typeof value.toDate !== 'function' && value._seconds === undefined) {
      continue; // Skip FieldValue.delete(), serverTimestamp(), etc.
    }

    // Convert Firestore Timestamps to Date
    let cleanValue = value;
    if (value && typeof value.toDate === 'function') {
      cleanValue = value.toDate();
    }

    const pgCol = FIELD_MAP[key];
    if (pgCol) {
      // Type coercion for integer columns that may have string values
      if (pgCol === 'onboarding_step' && typeof cleanValue === 'string') {
        cleanValue = cleanValue === 'complete' ? 100 : parseInt(cleanValue, 10) || 0;
      }
      if ((pgCol === 'staff_count' || pgCol === 'seating_capacity') && typeof cleanValue === 'string') {
        cleanValue = parseInt(cleanValue, 10) || 0;
      }
      pgRow[pgCol] = cleanValue;
    } else {
      // Unknown field → extra_data
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
  // overwrites the real column. Then real columns override. Unknown PG columns ignored.
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
