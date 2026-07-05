/**
 * enterpriseFieldMapper.js — Field maps for 8 enterprise/organization collections.
 *
 * Collections: organizations, orgMenuTemplates, orgMenuItems, indentRequests,
 * productionOrders, distributionPlans, orgSettings, orgAuditLog
 */

const { makeToPgRow, makeToFirestoreObj, buildReverseMap } = require('./queryBuilder');

// ── organizations ────────────────────────────────────────────────────────────

const ORG_FIELD_MAP = {
  id: 'id',
  name: 'name',
  type: 'type',
  ownerId: 'owner_id',
  settings: 'settings',
  outlets: 'outlets',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const ORG_JSONB_COLUMNS = new Set(['settings', 'outlets', 'extra_data']);
const orgToPgRow = makeToPgRow(ORG_FIELD_MAP, ORG_JSONB_COLUMNS);
const orgToFirestoreObj = makeToFirestoreObj(buildReverseMap(ORG_FIELD_MAP));

// ── orgMenuTemplates ─────────────────────────────────────────────────────────

const MENU_TEMPLATE_FIELD_MAP = {
  id: 'id',
  organizationId: 'organization_id',
  name: 'name',
  description: 'description',
  categories: 'categories',
  status: 'status',
  assignedOutlets: 'assigned_outlets',
  lastPushedAt: 'last_pushed_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  createdBy: 'created_by',
};

const MENU_TEMPLATE_JSONB_COLUMNS = new Set(['categories', 'assigned_outlets', 'extra_data']);
const menuTemplateToPgRow = makeToPgRow(MENU_TEMPLATE_FIELD_MAP, MENU_TEMPLATE_JSONB_COLUMNS);
const menuTemplateToFirestoreObj = makeToFirestoreObj(buildReverseMap(MENU_TEMPLATE_FIELD_MAP));

// ── orgMenuItems ─────────────────────────────────────────────────────────────

const MENU_ITEM_FIELD_MAP = {
  id: 'id',
  organizationId: 'organization_id',
  templateId: 'template_id',
  name: 'name',
  description: 'description',
  category: 'category',
  basePrice: 'base_price',
  variants: 'variants',
  image: 'image',
  images: 'images',
  isVeg: 'is_veg',
  tags: 'tags',
  isLocked: 'is_locked',
  lockFields: 'lock_fields',
  sortOrder: 'sort_order',
  shortCode: 'short_code',
  customizations: 'customizations',
  dineInPrice: 'dine_in_price',
  takeawayPrice: 'takeaway_price',
  deliveryPrice: 'delivery_price',
  allergens: 'allergens',
  status: 'status',
  outletPrices: 'outlet_prices',
  barcode: 'barcode',
  barcodeFormat: 'barcode_format',
  subCategory: 'sub_category',
  modifierGroups: 'modifier_groups',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const MENU_ITEM_JSONB_COLUMNS = new Set(['variants', 'images', 'tags', 'lock_fields', 'customizations', 'allergens', 'outlet_prices', 'modifier_groups', 'extra_data']);
const menuItemToPgRow = makeToPgRow(MENU_ITEM_FIELD_MAP, MENU_ITEM_JSONB_COLUMNS);
const menuItemToFirestoreObj = makeToFirestoreObj(buildReverseMap(MENU_ITEM_FIELD_MAP));

// ── indentRequests ───────────────────────────────────────────────────────────

const INDENT_FIELD_MAP = {
  id: 'id',
  organizationId: 'organization_id',
  requestingOutletId: 'requesting_outlet_id',
  warehouseId: 'warehouse_id',
  indentNumber: 'indent_number',
  items: 'items',
  priority: 'priority',
  status: 'status',
  requestedBy: 'requested_by',
  approvedBy: 'approved_by',
  dispatchedBy: 'dispatched_by',
  receivedBy: 'received_by',
  requestedAt: 'requested_at',
  approvedAt: 'approved_at',
  dispatchedAt: 'dispatched_at',
  receivedAt: 'received_at',
  rejectionReason: 'rejection_reason',
  deliveryNotes: 'delivery_notes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const INDENT_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const indentToPgRow = makeToPgRow(INDENT_FIELD_MAP, INDENT_JSONB_COLUMNS);
const indentToFirestoreObj = makeToFirestoreObj(buildReverseMap(INDENT_FIELD_MAP));

// ── productionOrders ─────────────────────────────────────────────────────────

const PRODUCTION_ORDER_FIELD_MAP = {
  id: 'id',
  organizationId: 'organization_id',
  centralKitchenId: 'central_kitchen_id',
  orderNumber: 'order_number',
  recipeId: 'recipe_id',
  recipeName: 'recipe_name',
  targetQuantity: 'target_quantity',
  producedQuantity: 'produced_quantity',
  unit: 'unit',
  status: 'status',
  scheduledDate: 'scheduled_date',
  completedDate: 'completed_date',
  ingredientsConsumed: 'ingredients_consumed',
  productionEntryId: 'production_entry_id',
  distributionPlanId: 'distribution_plan_id',
  notes: 'notes',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PRODUCTION_ORDER_JSONB_COLUMNS = new Set(['ingredients_consumed', 'extra_data']);
const productionOrderToPgRow = makeToPgRow(PRODUCTION_ORDER_FIELD_MAP, PRODUCTION_ORDER_JSONB_COLUMNS);
const productionOrderToFirestoreObj = makeToFirestoreObj(buildReverseMap(PRODUCTION_ORDER_FIELD_MAP));

// ── distributionPlans ────────────────────────────────────────────────────────

const DISTRIBUTION_PLAN_FIELD_MAP = {
  id: 'id',
  organizationId: 'organization_id',
  productionOrderId: 'production_order_id',
  centralKitchenId: 'central_kitchen_id',
  itemName: 'item_name',
  totalQuantity: 'total_quantity',
  unit: 'unit',
  allocations: 'allocations',
  status: 'status',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const DISTRIBUTION_PLAN_JSONB_COLUMNS = new Set(['allocations', 'extra_data']);
const distributionPlanToPgRow = makeToPgRow(DISTRIBUTION_PLAN_FIELD_MAP, DISTRIBUTION_PLAN_JSONB_COLUMNS);
const distributionPlanToFirestoreObj = makeToFirestoreObj(buildReverseMap(DISTRIBUTION_PLAN_FIELD_MAP));

// ── orgSettings ──────────────────────────────────────────────────────────────
// Used as counter storage with varied shapes — use flexible extra_data approach

const ORG_SETTINGS_FIELD_MAP = {
  id: 'id',
  count: 'count',
  current: 'current',
  updatedAt: 'updated_at',
};

const ORG_SETTINGS_JSONB_COLUMNS = new Set(['extra_data']);
const orgSettingsToPgRow = makeToPgRow(ORG_SETTINGS_FIELD_MAP, ORG_SETTINGS_JSONB_COLUMNS);
const orgSettingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(ORG_SETTINGS_FIELD_MAP));

// ── orgAuditLog ──────────────────────────────────────────────────────────────
// Append-only log — flexible schema

const AUDIT_LOG_FIELD_MAP = {
  id: 'id',
  organizationId: 'organization_id',
  action: 'action',
  performedBy: 'performed_by',
  entityType: 'entity_type',
  entityId: 'entity_id',
  details: 'details',
  createdAt: 'created_at',
  performedAt: 'performed_at',
};

const AUDIT_LOG_JSONB_COLUMNS = new Set(['details', 'extra_data']);
const auditLogToPgRow = makeToPgRow(AUDIT_LOG_FIELD_MAP, AUDIT_LOG_JSONB_COLUMNS);
const auditLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(AUDIT_LOG_FIELD_MAP));

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  orgToPgRow, orgToFirestoreObj, ORG_JSONB_COLUMNS,
  menuTemplateToPgRow, menuTemplateToFirestoreObj, MENU_TEMPLATE_JSONB_COLUMNS,
  menuItemToPgRow, menuItemToFirestoreObj, MENU_ITEM_JSONB_COLUMNS,
  indentToPgRow, indentToFirestoreObj, INDENT_JSONB_COLUMNS,
  productionOrderToPgRow, productionOrderToFirestoreObj, PRODUCTION_ORDER_JSONB_COLUMNS,
  distributionPlanToPgRow, distributionPlanToFirestoreObj, DISTRIBUTION_PLAN_JSONB_COLUMNS,
  orgSettingsToPgRow, orgSettingsToFirestoreObj, ORG_SETTINGS_JSONB_COLUMNS,
  auditLogToPgRow, auditLogToFirestoreObj, AUDIT_LOG_JSONB_COLUMNS,
};
