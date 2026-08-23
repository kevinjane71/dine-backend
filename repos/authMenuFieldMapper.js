/**
 * authMenuFieldMapper.js — Field maps for Auth/Menu/User collections.
 *
 * Collections (6 tables):
 *   Menus: menus, menuItems
 *   Users: users (-> app_users), userRestaurants, staffCredentials, dine_user_data
 */

const { makeToPgRow, makeToFirestoreObj, buildReverseMap } = require('./queryBuilder');

// ── menus ───────────────────────────────────────────────────────────────────

const MENU_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  description: 'description',
  extra_data: 'extra_data',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const MENU_JSONB_COLUMNS = new Set(['extra_data']);
const menuToPgRow = makeToPgRow(MENU_FIELD_MAP, MENU_JSONB_COLUMNS);
const menuToFirestoreObj = makeToFirestoreObj(buildReverseMap(MENU_FIELD_MAP));

// ── menuItems ───────────────────────────────────────────────────────────────

const MENU_ITEM_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  nameAr: 'name_ar',
  description: 'description',
  price: 'price',
  category: 'category',
  categoryId: 'category_id',
  foodType: 'food_type',
  spiceLevel: 'spice_level',
  isVeg: 'is_veg',
  isAvailable: 'is_available',
  available: 'available',
  shortCode: 'short_code',
  status: 'status',
  order: 'order',
  image: 'image',
  imageKeyword: 'image_keyword',
  stockQuantity: 'stock_quantity',
  lowStockThreshold: 'low_stock_threshold',
  isStockManaged: 'is_stock_managed',
  deductionQuantity: 'deduction_quantity',
  availableFrom: 'available_from',
  availableUntil: 'available_until',
  soldByWeight: 'sold_by_weight',
  priceUnit: 'price_unit',
  pluCode: 'plu_code',
  source: 'source',
  unit: 'unit',
  weight: 'weight',
  shelfLife: 'shelf_life',
  servingSize: 'serving_size',
  taxGroupId: 'tax_group_id',
  taxInclusive: 'tax_inclusive',
  discountApplicable: 'discount_applicable',
  isFavorite: 'is_favorite',
  hideImage: 'hide_image',
  isOutOfStock: 'is_out_of_stock',
  isDeleted: 'is_deleted',
  orgMenuItemId: 'org_menu_item_id',
  templateId: 'template_id',
  variants: 'variants',
  customizations: 'customizations',
  images: 'images',
  allergens: 'allergens',
  tags: 'tags',
  pricingRules: 'pricing_rules',
  extra_data: 'extra_data',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  deletedAt: 'deleted_at',
  syncedAt: 'synced_at',
  barcode: 'barcode',
  barcodeFormat: 'barcode_format',
  subCategory: 'sub_category',
  modifierGroups: 'modifier_groups',
};

const MENU_ITEM_JSONB_COLUMNS = new Set(['variants', 'customizations', 'images', 'allergens', 'tags', 'pricing_rules', 'modifier_groups', 'extra_data']);
const menuItemToPgRow = makeToPgRow(MENU_ITEM_FIELD_MAP, MENU_ITEM_JSONB_COLUMNS);
const menuItemToFirestoreObj = makeToFirestoreObj(buildReverseMap(MENU_ITEM_FIELD_MAP));

// ── users -> app_users ──────────────────────────────────────────────────────

const APP_USER_FIELD_MAP = {
  id: 'id',
  email: 'email',
  phone: 'phone',
  name: 'name',
  password: 'password',
  role: 'role',
  emailVerified: 'email_verified',
  phoneVerified: 'phone_verified',
  emailOTP: 'email_otp',
  emailOTPExpiry: 'email_otp_expiry',
  provider: 'provider',
  setupComplete: 'setup_complete',
  googleUid: 'google_uid',
  appleUid: 'apple_uid',
  firebaseUid: 'firebase_uid',
  photoURL: 'photo_url',
  picture: 'picture',
  temporaryPassword: 'temporary_password',
  restaurantName: 'restaurant_name',
  loginId: 'login_id',
  username: 'username',
  usernameLower: 'username_lower',
  createdBy: 'created_by',
  createdByRole: 'created_by_role',
  lastLogin: 'last_login',
  lastLoginPlatform: 'last_login_platform',
  pinHash: 'pin_hash',
  pinEnabled: 'pin_enabled',
  pinUpdatedAt: 'pin_updated_at',
  pinAttempts: 'pin_attempts',
  pinLockedUntil: 'pin_locked_until',
  tipEarnings: 'tip_earnings',
  adminNote: 'admin_note',
  adminNoteUpdatedAt: 'admin_note_updated_at',
  tipHistory: 'tip_history',
  status: 'status',
  language: 'language',
  defaultRestaurantId: 'default_restaurant_id',
  restaurantId: 'restaurant_id',
  origin: 'origin', // 'native' = born-on-GCP, 'firestore' = synced mirror
  extra_data: 'extra_data',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const APP_USER_JSONB_COLUMNS = new Set(['tip_history', 'extra_data']);
const appUserToPgRow = makeToPgRow(APP_USER_FIELD_MAP, APP_USER_JSONB_COLUMNS);
const appUserToFirestoreObj = makeToFirestoreObj(buildReverseMap(APP_USER_FIELD_MAP));

// ── userRestaurants ─────────────────────────────────────────────────────────

const USER_RESTAURANT_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  restaurantId: 'restaurant_id',
  role: 'role',
  pageAccess: 'page_access',
  extra_data: 'extra_data',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const USER_RESTAURANT_JSONB_COLUMNS = new Set(['page_access', 'extra_data']);
const userRestaurantToPgRow = makeToPgRow(USER_RESTAURANT_FIELD_MAP, USER_RESTAURANT_JSONB_COLUMNS);
const userRestaurantToFirestoreObj = makeToFirestoreObj(buildReverseMap(USER_RESTAURANT_FIELD_MAP));

// ── staffCredentials ────────────────────────────────────────────────────────

const STAFF_CREDENTIAL_FIELD_MAP = {
  id: 'id',
  staffId: 'staff_id',
  loginId: 'login_id',
  temporaryPassword: 'temporary_password',
  terminalPin: 'terminal_pin', // one-time plaintext terminal PIN shown to the owner
  extra_data: 'extra_data',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
};

const STAFF_CREDENTIAL_JSONB_COLUMNS = new Set(['extra_data']);
const staffCredentialToPgRow = makeToPgRow(STAFF_CREDENTIAL_FIELD_MAP, STAFF_CREDENTIAL_JSONB_COLUMNS);
const staffCredentialToFirestoreObj = makeToFirestoreObj(buildReverseMap(STAFF_CREDENTIAL_FIELD_MAP));

// ── dine_user_data ──────────────────────────────────────────────────────────

const DINE_USER_DATA_FIELD_MAP = {
  id: 'id',
  uid: 'uid',
  email: 'email',
  phone: 'phone',
  role: 'role',
  app: 'app',
  subscription: 'subscription',
  restaurantInfo: 'restaurant_info',
  extra_data: 'extra_data',
  createdAt: 'created_at',
  lastUpdated: 'last_updated',
};

const DINE_USER_DATA_JSONB_COLUMNS = new Set(['subscription', 'restaurant_info', 'extra_data']);
const dineUserDataToPgRow = makeToPgRow(DINE_USER_DATA_FIELD_MAP, DINE_USER_DATA_JSONB_COLUMNS);
const dineUserDataToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINE_USER_DATA_FIELD_MAP));

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Menus
  MENU_FIELD_MAP,
  menuToPgRow, menuToFirestoreObj, MENU_JSONB_COLUMNS,
  // Menu Items
  MENU_ITEM_FIELD_MAP,
  menuItemToPgRow, menuItemToFirestoreObj, MENU_ITEM_JSONB_COLUMNS,
  // App Users
  APP_USER_FIELD_MAP,
  appUserToPgRow, appUserToFirestoreObj, APP_USER_JSONB_COLUMNS,
  // User Restaurants
  USER_RESTAURANT_FIELD_MAP,
  userRestaurantToPgRow, userRestaurantToFirestoreObj, USER_RESTAURANT_JSONB_COLUMNS,
  // Staff Credentials
  STAFF_CREDENTIAL_FIELD_MAP,
  staffCredentialToPgRow, staffCredentialToFirestoreObj, STAFF_CREDENTIAL_JSONB_COLUMNS,
  // Dine User Data
  DINE_USER_DATA_FIELD_MAP,
  dineUserDataToPgRow, dineUserDataToFirestoreObj, DINE_USER_DATA_JSONB_COLUMNS,
};
