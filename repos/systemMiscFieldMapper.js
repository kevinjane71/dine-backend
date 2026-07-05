/**
 * systemMiscFieldMapper.js — Field maps for Phase 10 system/misc collections.
 *
 * Collections (64 tables):
 *   Supply Chain: suppliers, purchaseOrders, purchaseRequisitions, goodsReceiptNotes,
 *     supplierReturns, stockTransfers, supplierPerformance, supplierInvoices
 *   Inventory & Production: recipes, inventoryTransactions, stockBatches, wasteEntries,
 *     stockAudits, productionEntries
 *   Feedback & Customer: feedbackForms, feedbackResponses, customerGroups
 *   Booking & Space: bookings, bookingVenues, spaceBookings
 *   Parking: parkingConfigs, parkingZones, parkingSlots, parkingTickets, parkingRates
 *   Settings: restaurantSettings, discountSettings
 *   Payment & Billing: payments, razorpayTokens, dineDodoOrders, dineDodoBilling,
 *     dineDodoRefunds, dineDodoDisputes, dineDodoWebhookEvents, dineWebhookEvents
 *   Cart & Idempotency: savedCarts, idempotencyKeys
 *   Security: blockedIPs, securityLogs, rateLimits, publicToolUsage, systemConfig
 *   Auth & OTP: emailOtpTemp, otpVerification, demoRequests
 *   AI & Chatbot: chatbotConversations, conversations, ragKnowledge, tokenUsage, queryCache
 *   Bar Inventory: barBottles, barReconciliation
 *   Staff & Scheduling: staffAvailability, staffLocations, staffLocationsLatest
 *   Miscellaneous: invoices, discountApprovals, ownerPreferences, taxSettings, staff,
 *     coupons, menuBulkDeleteLogs, aggregatorWebhookLogs, whatsappOrderLogs
 */

const { makeToPgRow, makeToFirestoreObj, buildReverseMap } = require('./queryBuilder');

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP A: Supply Chain (8 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── suppliers ─────────────────────────────────────────────────────────────────

const SUPPLIER_FIELD_MAP = {
  id: 'id',
  name: 'name',
  phone: 'phone',
  email: 'email',
  address: 'address',
  restaurantId: 'restaurant_id',
  isActive: 'is_active',
  status: 'status',
  gstNumber: 'gst_number',
  paymentTerms: 'payment_terms',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SUPPLIER_JSONB_COLUMNS = new Set(['address', 'extra_data']);
const supplierToPgRow = makeToPgRow(SUPPLIER_FIELD_MAP, SUPPLIER_JSONB_COLUMNS);
const supplierToFirestoreObj = makeToFirestoreObj(buildReverseMap(SUPPLIER_FIELD_MAP));

// ── purchaseOrders ────────────────────────────────────────────────────────────

const PO_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  supplierId: 'supplier_id',
  items: 'items',
  totalAmount: 'total_amount',
  status: 'status',
  deliveryDate: 'delivery_date',
  notes: 'notes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PO_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const poToPgRow = makeToPgRow(PO_FIELD_MAP, PO_JSONB_COLUMNS);
const poToFirestoreObj = makeToFirestoreObj(buildReverseMap(PO_FIELD_MAP));

// ── purchaseRequisitions (Firestore: purchase-requisitions) ─────────────────

const REQUISITION_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  requestedBy: 'requested_by',
  items: 'items',
  status: 'status',
  purchaseOrderId: 'purchase_order_id',
  priority: 'priority',
  notes: 'notes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const REQUISITION_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const requisitionToPgRow = makeToPgRow(REQUISITION_FIELD_MAP, REQUISITION_JSONB_COLUMNS);
const requisitionToFirestoreObj = makeToFirestoreObj(buildReverseMap(REQUISITION_FIELD_MAP));

// ── goodsReceiptNotes (Firestore: goods-receipt-notes) ──────────────────────

const GRN_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  purchaseOrderId: 'purchase_order_id',
  supplierId: 'supplier_id',
  items: 'items',
  receivedDate: 'received_date',
  receivedBy: 'received_by',
  status: 'status',
  notes: 'notes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const GRN_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const grnToPgRow = makeToPgRow(GRN_FIELD_MAP, GRN_JSONB_COLUMNS);
const grnToFirestoreObj = makeToFirestoreObj(buildReverseMap(GRN_FIELD_MAP));

// ── supplierReturns (Firestore: supplier-returns) ───────────────────────────

const SUPPLIER_RETURN_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  supplierId: 'supplier_id',
  items: 'items',
  reason: 'reason',
  status: 'status',
  returnDate: 'return_date',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SUPPLIER_RETURN_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const supplierReturnToPgRow = makeToPgRow(SUPPLIER_RETURN_FIELD_MAP, SUPPLIER_RETURN_JSONB_COLUMNS);
const supplierReturnToFirestoreObj = makeToFirestoreObj(buildReverseMap(SUPPLIER_RETURN_FIELD_MAP));

// ── stockTransfers (Firestore: stock-transfers) ─────────────────────────────

const STOCK_TRANSFER_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  fromLocation: 'from_location',
  toLocation: 'to_location',
  items: 'items',
  status: 'status',
  transferDate: 'transfer_date',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const STOCK_TRANSFER_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const stockTransferToPgRow = makeToPgRow(STOCK_TRANSFER_FIELD_MAP, STOCK_TRANSFER_JSONB_COLUMNS);
const stockTransferToFirestoreObj = makeToFirestoreObj(buildReverseMap(STOCK_TRANSFER_FIELD_MAP));

// ── supplierPerformance (Firestore: supplier-performance) ───────────────────

const SUPPLIER_PERF_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  supplierId: 'supplier_id',
  metrics: 'metrics',
  evaluationDate: 'evaluation_date',
};

const SUPPLIER_PERF_JSONB_COLUMNS = new Set(['metrics', 'extra_data']);
const supplierPerfToPgRow = makeToPgRow(SUPPLIER_PERF_FIELD_MAP, SUPPLIER_PERF_JSONB_COLUMNS);
const supplierPerfToFirestoreObj = makeToFirestoreObj(buildReverseMap(SUPPLIER_PERF_FIELD_MAP));

// ── supplierInvoices (Firestore: supplier-invoices) ─────────────────────────

const SUPPLIER_INVOICE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  supplierId: 'supplier_id',
  createdAt: 'created_at',
};

const SUPPLIER_INVOICE_JSONB_COLUMNS = new Set(['extra_data']);
const supplierInvoiceToPgRow = makeToPgRow(SUPPLIER_INVOICE_FIELD_MAP, SUPPLIER_INVOICE_JSONB_COLUMNS);
const supplierInvoiceToFirestoreObj = makeToFirestoreObj(buildReverseMap(SUPPLIER_INVOICE_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP B: Inventory & Production (6 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── recipes ─────────────────────────────────────────────────────────────────

const RECIPE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  menuItemId: 'menu_item_id',
  name: 'name',
  ingredients: 'ingredients',
  yield: 'yield',
  prepTime: 'prep_time',
  instructions: 'instructions',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const RECIPE_JSONB_COLUMNS = new Set(['ingredients', 'instructions', 'extra_data']);
const recipeToPgRow = makeToPgRow(RECIPE_FIELD_MAP, RECIPE_JSONB_COLUMNS);
const recipeToFirestoreObj = makeToFirestoreObj(buildReverseMap(RECIPE_FIELD_MAP));

// ── inventoryTransactions ───────────────────────────────────────────────────

const INV_TXN_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  inventoryId: 'inventory_id',
  type: 'type',
  quantity: 'quantity',
  unit: 'unit',
  batchId: 'batch_id',
  orderId: 'order_id',
  reason: 'reason',
  performedBy: 'performed_by',
  createdAt: 'created_at',
};

const INV_TXN_JSONB_COLUMNS = new Set(['extra_data']);
const invTxnToPgRow = makeToPgRow(INV_TXN_FIELD_MAP, INV_TXN_JSONB_COLUMNS);
const invTxnToFirestoreObj = makeToFirestoreObj(buildReverseMap(INV_TXN_FIELD_MAP));

// ── stockBatches ────────────────────────────────────────────────────────────

const STOCK_BATCH_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  inventoryId: 'inventory_id',
  batchNumber: 'batch_number',
  quantity: 'quantity',
  remainingQuantity: 'remaining_quantity',
  unitCost: 'unit_cost',
  expiryDate: 'expiry_date',
  supplier: 'supplier',
  receivedDate: 'received_date',
  status: 'status',
  createdAt: 'created_at',
};

const STOCK_BATCH_JSONB_COLUMNS = new Set(['extra_data']);
const stockBatchToPgRow = makeToPgRow(STOCK_BATCH_FIELD_MAP, STOCK_BATCH_JSONB_COLUMNS);
const stockBatchToFirestoreObj = makeToFirestoreObj(buildReverseMap(STOCK_BATCH_FIELD_MAP));

// ── wasteEntries ────────────────────────────────────────────────────────────

const WASTE_ENTRY_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  inventoryId: 'inventory_id',
  quantity: 'quantity',
  unit: 'unit',
  reason: 'reason',
  category: 'category',
  cost: 'cost',
  reportedBy: 'reported_by',
  auditId: 'audit_id',
  createdAt: 'created_at',
};

const WASTE_ENTRY_JSONB_COLUMNS = new Set(['extra_data']);
const wasteEntryToPgRow = makeToPgRow(WASTE_ENTRY_FIELD_MAP, WASTE_ENTRY_JSONB_COLUMNS);
const wasteEntryToFirestoreObj = makeToFirestoreObj(buildReverseMap(WASTE_ENTRY_FIELD_MAP));

// ── stockAudits ─────────────────────────────────────────────────────────────

const STOCK_AUDIT_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  items: 'items',
  auditDate: 'audit_date',
  conductedBy: 'conducted_by',
  discrepancies: 'discrepancies',
  status: 'status',
  createdAt: 'created_at',
};

const STOCK_AUDIT_JSONB_COLUMNS = new Set(['items', 'discrepancies', 'extra_data']);
const stockAuditToPgRow = makeToPgRow(STOCK_AUDIT_FIELD_MAP, STOCK_AUDIT_JSONB_COLUMNS);
const stockAuditToFirestoreObj = makeToFirestoreObj(buildReverseMap(STOCK_AUDIT_FIELD_MAP));

// ── productionEntries ───────────────────────────────────────────────────────

const PRODUCTION_ENTRY_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  recipeId: 'recipe_id',
  quantity: 'quantity',
  producedBy: 'produced_by',
  batchNumber: 'batch_number',
  inputItems: 'input_items',
  outputItems: 'output_items',
  wasteItems: 'waste_items',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PRODUCTION_ENTRY_JSONB_COLUMNS = new Set(['input_items', 'output_items', 'waste_items', 'extra_data']);
const productionEntryToPgRow = makeToPgRow(PRODUCTION_ENTRY_FIELD_MAP, PRODUCTION_ENTRY_JSONB_COLUMNS);
const productionEntryToFirestoreObj = makeToFirestoreObj(buildReverseMap(PRODUCTION_ENTRY_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP C: Feedback & Customer (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── feedbackForms ───────────────────────────────────────────────────────────

const FEEDBACK_FORM_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  title: 'title',
  fields: 'fields',
  status: 'status',
  responseCount: 'response_count',
  thankYouMessage: 'thank_you_message',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const FEEDBACK_FORM_JSONB_COLUMNS = new Set(['fields', 'extra_data']);
const feedbackFormToPgRow = makeToPgRow(FEEDBACK_FORM_FIELD_MAP, FEEDBACK_FORM_JSONB_COLUMNS);
const feedbackFormToFirestoreObj = makeToFirestoreObj(buildReverseMap(FEEDBACK_FORM_FIELD_MAP));

// ── feedbackResponses ───────────────────────────────────────────────────────

const FEEDBACK_RESPONSE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  formId: 'form_id',
  responses: 'responses',
  rating: 'rating',
  customerName: 'customer_name',
  customerPhone: 'customer_phone',
  submittedAt: 'submitted_at',
  orderId: 'order_id',
};

const FEEDBACK_RESPONSE_JSONB_COLUMNS = new Set(['responses', 'extra_data']);
const feedbackResponseToPgRow = makeToPgRow(FEEDBACK_RESPONSE_FIELD_MAP, FEEDBACK_RESPONSE_JSONB_COLUMNS);
const feedbackResponseToFirestoreObj = makeToFirestoreObj(buildReverseMap(FEEDBACK_RESPONSE_FIELD_MAP));

// ── customerGroups ──────────────────────────────────────────────────────────

const CUSTOMER_GROUP_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  description: 'description',
  color: 'color',
  icon: 'icon',
  customerIds: 'customer_ids',
  customerPhones: 'customer_phones',
  customerCount: 'customer_count',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const CUSTOMER_GROUP_JSONB_COLUMNS = new Set(['customer_ids', 'customer_phones', 'extra_data']);
const customerGroupToPgRow = makeToPgRow(CUSTOMER_GROUP_FIELD_MAP, CUSTOMER_GROUP_JSONB_COLUMNS);
const customerGroupToFirestoreObj = makeToFirestoreObj(buildReverseMap(CUSTOMER_GROUP_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP D: Booking & Space (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── bookings ────────────────────────────────────────────────────────────────

const BOOKING_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  customerName: 'customer_name',
  customerPhone: 'customer_phone',
  date: 'date',
  time: 'time',
  partySize: 'party_size',
  duration: 'duration',
  tableId: 'table_id',
  venueId: 'venue_id',
  status: 'status',
  notes: 'notes',
  totalAmount: 'total_amount',
  advanceAmount: 'advance_amount',
  payments: 'payments',
  items: 'items',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const BOOKING_JSONB_COLUMNS = new Set(['payments', 'items', 'extra_data']);
const bookingToPgRow = makeToPgRow(BOOKING_FIELD_MAP, BOOKING_JSONB_COLUMNS);
const bookingToFirestoreObj = makeToFirestoreObj(buildReverseMap(BOOKING_FIELD_MAP));

// ── bookingVenues ───────────────────────────────────────────────────────────

const BOOKING_VENUE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  capacity: 'capacity',
  pricePerHour: 'price_per_hour',
  amenities: 'amenities',
  images: 'images',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const BOOKING_VENUE_JSONB_COLUMNS = new Set(['amenities', 'images', 'extra_data']);
const bookingVenueToPgRow = makeToPgRow(BOOKING_VENUE_FIELD_MAP, BOOKING_VENUE_JSONB_COLUMNS);
const bookingVenueToFirestoreObj = makeToFirestoreObj(buildReverseMap(BOOKING_VENUE_FIELD_MAP));

// ── spaceBookings ───────────────────────────────────────────────────────────

const SPACE_BOOKING_FIELD_MAP = {
  id: 'id',
  ownerId: 'owner_id',
  restaurantId: 'restaurant_id',
  tableId: 'table_id',
  date: 'date',
  startTime: 'start_time',
  endTime: 'end_time',
  status: 'status',
  guestName: 'guest_name',
  guestPhone: 'guest_phone',
  partySize: 'party_size',
  notes: 'notes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SPACE_BOOKING_JSONB_COLUMNS = new Set(['extra_data']);
const spaceBookingToPgRow = makeToPgRow(SPACE_BOOKING_FIELD_MAP, SPACE_BOOKING_JSONB_COLUMNS);
const spaceBookingToFirestoreObj = makeToFirestoreObj(buildReverseMap(SPACE_BOOKING_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP E: Parking (5 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── parkingConfigs ──────────────────────────────────────────────────────────

const PARKING_CONFIG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  totalCapacity: 'total_capacity',
  operatingHours: 'operating_hours',
  currency: 'currency',
  enablePrepaid: 'enable_prepaid',
  vatPercentage: 'vat_percentage',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PARKING_CONFIG_JSONB_COLUMNS = new Set(['operating_hours', 'extra_data']);
const parkingConfigToPgRow = makeToPgRow(PARKING_CONFIG_FIELD_MAP, PARKING_CONFIG_JSONB_COLUMNS);
const parkingConfigToFirestoreObj = makeToFirestoreObj(buildReverseMap(PARKING_CONFIG_FIELD_MAP));

// ── parkingZones ────────────────────────────────────────────────────────────

const PARKING_ZONE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  type: 'type',
  totalSlots: 'total_slots',
  occupiedSlots: 'occupied_slots',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PARKING_ZONE_JSONB_COLUMNS = new Set(['extra_data']);
const parkingZoneToPgRow = makeToPgRow(PARKING_ZONE_FIELD_MAP, PARKING_ZONE_JSONB_COLUMNS);
const parkingZoneToFirestoreObj = makeToFirestoreObj(buildReverseMap(PARKING_ZONE_FIELD_MAP));

// ── parkingSlots ────────────────────────────────────────────────────────────

const PARKING_SLOT_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  zoneId: 'zone_id',
  slotNumber: 'slot_number',
  type: 'type',
  status: 'status',
  vehicleType: 'vehicle_type',
  currentTicketId: 'current_ticket_id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PARKING_SLOT_JSONB_COLUMNS = new Set(['extra_data']);
const parkingSlotToPgRow = makeToPgRow(PARKING_SLOT_FIELD_MAP, PARKING_SLOT_JSONB_COLUMNS);
const parkingSlotToFirestoreObj = makeToFirestoreObj(buildReverseMap(PARKING_SLOT_FIELD_MAP));

// ── parkingTickets ──────────────────────────────────────────────────────────

const PARKING_TICKET_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  zoneId: 'zone_id',
  slotId: 'slot_id',
  rateId: 'rate_id',
  vehicleNumber: 'vehicle_number',
  vehicleType: 'vehicle_type',
  entryTime: 'entry_time',
  exitTime: 'exit_time',
  duration: 'duration',
  amount: 'amount',
  paymentStatus: 'payment_status',
  paymentMethod: 'payment_method',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PARKING_TICKET_JSONB_COLUMNS = new Set(['extra_data']);
const parkingTicketToPgRow = makeToPgRow(PARKING_TICKET_FIELD_MAP, PARKING_TICKET_JSONB_COLUMNS);
const parkingTicketToFirestoreObj = makeToFirestoreObj(buildReverseMap(PARKING_TICKET_FIELD_MAP));

// ── parkingRates ────────────────────────────────────────────────────────────

const PARKING_RATE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  name: 'name',
  vehicleType: 'vehicle_type',
  rateType: 'rate_type',
  amount: 'amount',
  freeMinutes: 'free_minutes',
  maxDaily: 'max_daily',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PARKING_RATE_JSONB_COLUMNS = new Set(['extra_data']);
const parkingRateToPgRow = makeToPgRow(PARKING_RATE_FIELD_MAP, PARKING_RATE_JSONB_COLUMNS);
const parkingRateToFirestoreObj = makeToFirestoreObj(buildReverseMap(PARKING_RATE_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP F: Settings (2 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── restaurantSettings ──────────────────────────────────────────────────────

const RESTAURANT_SETTINGS_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  type: 'type',
  settings: 'settings',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const RESTAURANT_SETTINGS_JSONB_COLUMNS = new Set(['settings', 'extra_data']);
const restaurantSettingsToPgRow = makeToPgRow(RESTAURANT_SETTINGS_FIELD_MAP, RESTAURANT_SETTINGS_JSONB_COLUMNS);
const restaurantSettingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(RESTAURANT_SETTINGS_FIELD_MAP));

// ── discountSettings ────────────────────────────────────────────────────────

const DISCOUNT_SETTINGS_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  maxDiscountPercent: 'max_discount_percent',
  requireApproval: 'require_approval',
  approvalThreshold: 'approval_threshold',
  allowedRoles: 'allowed_roles',
  createdAt: 'created_at',
};

const DISCOUNT_SETTINGS_JSONB_COLUMNS = new Set(['allowed_roles', 'extra_data']);
const discountSettingsToPgRow = makeToPgRow(DISCOUNT_SETTINGS_FIELD_MAP, DISCOUNT_SETTINGS_JSONB_COLUMNS);
const discountSettingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(DISCOUNT_SETTINGS_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP G: Payment & Billing (8 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── payments ────────────────────────────────────────────────────────────────

const PAYMENT_FIELD_MAP = {
  id: 'id',
  amount: 'amount',
  method: 'method',
  orderId: 'order_id',
  restaurantId: 'restaurant_id',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const PAYMENT_JSONB_COLUMNS = new Set(['extra_data']);
const paymentToPgRow = makeToPgRow(PAYMENT_FIELD_MAP, PAYMENT_JSONB_COLUMNS);
const paymentToFirestoreObj = makeToFirestoreObj(buildReverseMap(PAYMENT_FIELD_MAP));

// ── razorpayTokens (Firestore: razorpay_tokens) ────────────────────────────

const RAZORPAY_TOKEN_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  accountId: 'account_id',
  publicToken: 'public_token',
  tokenType: 'token_type',
  expiresAt: 'expires_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const RAZORPAY_TOKEN_JSONB_COLUMNS = new Set(['extra_data']);
const razorpayTokenToPgRow = makeToPgRow(RAZORPAY_TOKEN_FIELD_MAP, RAZORPAY_TOKEN_JSONB_COLUMNS);
const razorpayTokenToFirestoreObj = makeToFirestoreObj(buildReverseMap(RAZORPAY_TOKEN_FIELD_MAP));

// ── dineDodoOrders (Firestore: dine_dodo_orders) ────────────────────────────

const DODO_ORDER_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  sessionId: 'session_id',
  planId: 'plan_id',
  productId: 'product_id',
  checkoutUrl: 'checkout_url',
  email: 'email',
  name: 'name',
  paymentGateway: 'payment_gateway',
  app: 'app',
  status: 'status',
  createdAt: 'created_at',
};

const DODO_ORDER_JSONB_COLUMNS = new Set(['extra_data']);
const dodoOrderToPgRow = makeToPgRow(DODO_ORDER_FIELD_MAP, DODO_ORDER_JSONB_COLUMNS);
const dodoOrderToFirestoreObj = makeToFirestoreObj(buildReverseMap(DODO_ORDER_FIELD_MAP));

// ── dineDodoBilling (Firestore: dine_dodo_billing) ──────────────────────────

const DODO_BILLING_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  type: 'type',
  sessionId: 'session_id',
  planId: 'plan_id',
  previousPlanId: 'previous_plan_id',
  productId: 'product_id',
  status: 'status',
  app: 'app',
  createdAt: 'created_at',
};

const DODO_BILLING_JSONB_COLUMNS = new Set(['extra_data']);
const dodoBillingToPgRow = makeToPgRow(DODO_BILLING_FIELD_MAP, DODO_BILLING_JSONB_COLUMNS);
const dodoBillingToFirestoreObj = makeToFirestoreObj(buildReverseMap(DODO_BILLING_FIELD_MAP));

// ── dineDodoRefunds (Firestore: dine_dodo_refunds) ──────────────────────────

const DODO_REFUND_FIELD_MAP = {
  id: 'id',
  type: 'type',
  refundId: 'refund_id',
  paymentId: 'payment_id',
  amount: 'amount',
  reason: 'reason',
  status: 'status',
  createdAt: 'created_at',
};

const DODO_REFUND_JSONB_COLUMNS = new Set(['extra_data']);
const dodoRefundToPgRow = makeToPgRow(DODO_REFUND_FIELD_MAP, DODO_REFUND_JSONB_COLUMNS);
const dodoRefundToFirestoreObj = makeToFirestoreObj(buildReverseMap(DODO_REFUND_FIELD_MAP));

// ── dineDodoDisputes (Firestore: dine_dodo_disputes) ────────────────────────

const DODO_DISPUTE_FIELD_MAP = {
  id: 'id',
  type: 'type',
  disputeId: 'dispute_id',
  paymentId: 'payment_id',
  amount: 'amount',
  reason: 'reason',
  status: 'status',
  createdAt: 'created_at',
};

const DODO_DISPUTE_JSONB_COLUMNS = new Set(['extra_data']);
const dodoDisputeToPgRow = makeToPgRow(DODO_DISPUTE_FIELD_MAP, DODO_DISPUTE_JSONB_COLUMNS);
const dodoDisputeToFirestoreObj = makeToFirestoreObj(buildReverseMap(DODO_DISPUTE_FIELD_MAP));

// ── dineDodoWebhookEvents (Firestore: dine_dodo_webhook_events) ─────────────

const DODO_WEBHOOK_FIELD_MAP = {
  id: 'id',
  eventType: 'event_type',
  eventId: 'event_id',
  payload: 'payload',
  processedAt: 'processed_at',
  createdAt: 'created_at',
};

const DODO_WEBHOOK_JSONB_COLUMNS = new Set(['payload', 'extra_data']);
const dodoWebhookToPgRow = makeToPgRow(DODO_WEBHOOK_FIELD_MAP, DODO_WEBHOOK_JSONB_COLUMNS);
const dodoWebhookToFirestoreObj = makeToFirestoreObj(buildReverseMap(DODO_WEBHOOK_FIELD_MAP));

// ── dineWebhookEvents (Firestore: dine_webhook_events) ─────────────────────

const DINE_WEBHOOK_FIELD_MAP = {
  id: 'id',
  fullPayload: 'full_payload',
  webhookReceivedAt: 'webhook_received_at',
  event: 'event',
  app: 'app',
};

const DINE_WEBHOOK_JSONB_COLUMNS = new Set(['full_payload', 'extra_data']);
const dineWebhookToPgRow = makeToPgRow(DINE_WEBHOOK_FIELD_MAP, DINE_WEBHOOK_JSONB_COLUMNS);
const dineWebhookToFirestoreObj = makeToFirestoreObj(buildReverseMap(DINE_WEBHOOK_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP H: Cart & Idempotency (2 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── savedCarts (Firestore: saved_carts) ─────────────────────────────────────

const SAVED_CART_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  userId: 'user_id',
  name: 'name',
  type: 'type',
  items: 'items',
  tableId: 'table_id',
  tableNumber: 'table_number',
  customerName: 'customer_name',
  customerInfo: 'customer_info',
  orderType: 'order_type',
  paymentMethod: 'payment_method',
  notes: 'notes',
  isActive: 'is_active',
  createdBy: 'created_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const SAVED_CART_JSONB_COLUMNS = new Set(['items', 'customer_info', 'created_by', 'extra_data']);
const savedCartToPgRow = makeToPgRow(SAVED_CART_FIELD_MAP, SAVED_CART_JSONB_COLUMNS);
const savedCartToFirestoreObj = makeToFirestoreObj(buildReverseMap(SAVED_CART_FIELD_MAP));

// ── idempotencyKeys (Firestore: idempotency_keys) ──────────────────────────

const IDEMPOTENCY_KEY_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  orderId: 'order_id',
  response: 'response',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
};

const IDEMPOTENCY_KEY_JSONB_COLUMNS = new Set(['response', 'extra_data']);
const idempotencyKeyToPgRow = makeToPgRow(IDEMPOTENCY_KEY_FIELD_MAP, IDEMPOTENCY_KEY_JSONB_COLUMNS);
const idempotencyKeyToFirestoreObj = makeToFirestoreObj(buildReverseMap(IDEMPOTENCY_KEY_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP I: Security (5 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── blockedIPs (Firestore: blockedIPs) ──────────────────────────────────────

const BLOCKED_IP_FIELD_MAP = {
  id: 'id',
  ip: 'ip',
  blockedUntil: 'blocked_until',
  blockedAt: 'blocked_at',
  reason: 'reason',
};

const BLOCKED_IP_JSONB_COLUMNS = new Set(['extra_data']);
const blockedIpToPgRow = makeToPgRow(BLOCKED_IP_FIELD_MAP, BLOCKED_IP_JSONB_COLUMNS);
const blockedIpToFirestoreObj = makeToFirestoreObj(buildReverseMap(BLOCKED_IP_FIELD_MAP));

// ── securityLogs (Firestore: securityLogs) ──────────────────────────────────

const SECURITY_LOG_FIELD_MAP = {
  id: 'id',
  event: 'event',
  clientIP: 'client_ip',
  userAgent: 'user_agent',
  url: 'url',
  method: 'method',
  details: 'details',
  timestamp: 'timestamp',
  requestId: 'request_id',
};

const SECURITY_LOG_JSONB_COLUMNS = new Set(['details', 'extra_data']);
const securityLogToPgRow = makeToPgRow(SECURITY_LOG_FIELD_MAP, SECURITY_LOG_JSONB_COLUMNS);
const securityLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(SECURITY_LOG_FIELD_MAP));

// ── rateLimits (Firestore: rateLimits) ──────────────────────────────────────

const RATE_LIMIT_FIELD_MAP = {
  id: 'id',
  clientId: 'client_id',
  count: 'count',
  windowStart: 'window_start',
  isBlocked: 'is_blocked',
  blockedUntil: 'blocked_until',
  lastUpdated: 'last_updated',
};

const RATE_LIMIT_JSONB_COLUMNS = new Set(['extra_data']);
const rateLimitToPgRow = makeToPgRow(RATE_LIMIT_FIELD_MAP, RATE_LIMIT_JSONB_COLUMNS);
const rateLimitToFirestoreObj = makeToFirestoreObj(buildReverseMap(RATE_LIMIT_FIELD_MAP));

// ── publicToolUsage (Firestore: publicToolUsage) ────────────────────────────

const PUBLIC_TOOL_USAGE_FIELD_MAP = {
  id: 'id',
  ipAddress: 'ip_address',
  date: 'date',
  callCount: 'call_count',
  lastCallAt: 'last_call_at',
  lastTool: 'last_tool',
};

const PUBLIC_TOOL_USAGE_JSONB_COLUMNS = new Set(['extra_data']);
const publicToolUsageToPgRow = makeToPgRow(PUBLIC_TOOL_USAGE_FIELD_MAP, PUBLIC_TOOL_USAGE_JSONB_COLUMNS);
const publicToolUsageToFirestoreObj = makeToFirestoreObj(buildReverseMap(PUBLIC_TOOL_USAGE_FIELD_MAP));

// ── systemConfig (Firestore: systemConfig) ──────────────────────────────────

const SYSTEM_CONFIG_FIELD_MAP = {
  id: 'id',
  freeLimit: 'free_limit',
  starterLimit: 'starter_limit',
  professionalLimit: 'professional_limit',
  createdAt: 'created_at',
};

const SYSTEM_CONFIG_JSONB_COLUMNS = new Set(['extra_data']);
const systemConfigToPgRow = makeToPgRow(SYSTEM_CONFIG_FIELD_MAP, SYSTEM_CONFIG_JSONB_COLUMNS);
const systemConfigToFirestoreObj = makeToFirestoreObj(buildReverseMap(SYSTEM_CONFIG_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP J: Auth & OTP (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── emailOtpTemp (Firestore: email_otp_temp) ────────────────────────────────

const EMAIL_OTP_FIELD_MAP = {
  id: 'id',
  email: 'email',
  otp: 'otp',
  otpExpiry: 'otp_expiry',
  purpose: 'purpose',
  createdAt: 'created_at',
};

const EMAIL_OTP_JSONB_COLUMNS = new Set(['extra_data']);
const emailOtpToPgRow = makeToPgRow(EMAIL_OTP_FIELD_MAP, EMAIL_OTP_JSONB_COLUMNS);
const emailOtpToFirestoreObj = makeToFirestoreObj(buildReverseMap(EMAIL_OTP_FIELD_MAP));

// ── otpVerification (Firestore: otp_verification) ──────────────────────────

const OTP_VERIFICATION_FIELD_MAP = {
  id: 'id',
  phone: 'phone',
  otp: 'otp',
  otpExpiry: 'otp_expiry',
  createdAt: 'created_at',
};

const OTP_VERIFICATION_JSONB_COLUMNS = new Set(['extra_data']);
const otpVerificationToPgRow = makeToPgRow(OTP_VERIFICATION_FIELD_MAP, OTP_VERIFICATION_JSONB_COLUMNS);
const otpVerificationToFirestoreObj = makeToFirestoreObj(buildReverseMap(OTP_VERIFICATION_FIELD_MAP));

// ── demoRequests (Firestore: demoRequests) ──────────────────────────────────

const DEMO_REQUEST_FIELD_MAP = {
  id: 'id',
  contactType: 'contact_type',
  phone: 'phone',
  email: 'email',
  restaurantName: 'restaurant_name',
  comment: 'comment',
  status: 'status',
  ipAddress: 'ip_address',
  userAgent: 'user_agent',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const DEMO_REQUEST_JSONB_COLUMNS = new Set(['extra_data']);
const demoRequestToPgRow = makeToPgRow(DEMO_REQUEST_FIELD_MAP, DEMO_REQUEST_JSONB_COLUMNS);
const demoRequestToFirestoreObj = makeToFirestoreObj(buildReverseMap(DEMO_REQUEST_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP K: AI & Chatbot (5 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── chatbotConversations (Firestore: chatbot_conversations) ─────────────────

const CHATBOT_CONV_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  restaurantId: 'restaurant_id',
  messages: 'messages',
  lastMessage: 'last_message',
  lastResponse: 'last_response',
  functionCalled: 'function_called',
  timestamp: 'timestamp',
  updatedAt: 'updated_at',
};

const CHATBOT_CONV_JSONB_COLUMNS = new Set(['messages', 'extra_data']);
const chatbotConvToPgRow = makeToPgRow(CHATBOT_CONV_FIELD_MAP, CHATBOT_CONV_JSONB_COLUMNS);
const chatbotConvToFirestoreObj = makeToFirestoreObj(buildReverseMap(CHATBOT_CONV_FIELD_MAP));

// ── conversations ───────────────────────────────────────────────────────────

const CONVERSATION_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  userId: 'user_id',
  query: 'query',
  response: 'response',
  intent: 'intent',
  action: 'action',
  timestamp: 'timestamp',
};

const CONVERSATION_JSONB_COLUMNS = new Set(['extra_data']);
const conversationToPgRow = makeToPgRow(CONVERSATION_FIELD_MAP, CONVERSATION_JSONB_COLUMNS);
const conversationToFirestoreObj = makeToFirestoreObj(buildReverseMap(CONVERSATION_FIELD_MAP));

// ── ragKnowledge (Firestore: rag_knowledge) ─────────────────────────────────

const RAG_KNOWLEDGE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  content: 'content',
  type: 'type',
  embedding: 'embedding',
  metadata: 'metadata',
  chunkIndex: 'chunk_index',
  totalChunks: 'total_chunks',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const RAG_KNOWLEDGE_JSONB_COLUMNS = new Set(['embedding', 'metadata', 'extra_data']);
const ragKnowledgeToPgRow = makeToPgRow(RAG_KNOWLEDGE_FIELD_MAP, RAG_KNOWLEDGE_JSONB_COLUMNS);
const ragKnowledgeToFirestoreObj = makeToFirestoreObj(buildReverseMap(RAG_KNOWLEDGE_FIELD_MAP));

// ── tokenUsage (Firestore: token_usage) ─────────────────────────────────────

const TOKEN_USAGE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  date: 'date',
  model: 'model',
  totalTokens: 'total_tokens',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cost: 'cost',
  requestCount: 'request_count',
  lastUpdated: 'last_updated',
};

const TOKEN_USAGE_JSONB_COLUMNS = new Set(['extra_data']);
const tokenUsageToPgRow = makeToPgRow(TOKEN_USAGE_FIELD_MAP, TOKEN_USAGE_JSONB_COLUMNS);
const tokenUsageToFirestoreObj = makeToFirestoreObj(buildReverseMap(TOKEN_USAGE_FIELD_MAP));

// ── queryCache (Firestore: query_cache) ─────────────────────────────────────

const QUERY_CACHE_FIELD_MAP = {
  id: 'id',
  query: 'query',
  response: 'response',
  restaurantId: 'restaurant_id',
  model: 'model',
  createdAt: 'created_at',
  expiresAt: 'expires_at',
};

const QUERY_CACHE_JSONB_COLUMNS = new Set(['extra_data']);
const queryCacheToPgRow = makeToPgRow(QUERY_CACHE_FIELD_MAP, QUERY_CACHE_JSONB_COLUMNS);
const queryCacheToFirestoreObj = makeToFirestoreObj(buildReverseMap(QUERY_CACHE_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP L: Bar Inventory (2 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── barBottles ──────────────────────────────────────────────────────────────

const BAR_BOTTLE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  brand: 'brand',
  type: 'type',
  size: 'size',
  totalMl: 'total_ml',
  remainingMl: 'remaining_ml',
  totalMlSold: 'total_ml_sold',
  totalPegsPoured: 'total_pegs_poured',
  totalMlPoured: 'total_ml_poured',
  costPrice: 'cost_price',
  sellingPrice: 'selling_price',
  openedAt: 'opened_at',
  status: 'status',
  wastage: 'wastage',
  wastageEntries: 'wastage_entries',
  createdAt: 'created_at',
};

const BAR_BOTTLE_JSONB_COLUMNS = new Set(['wastage_entries', 'extra_data']);
const barBottleToPgRow = makeToPgRow(BAR_BOTTLE_FIELD_MAP, BAR_BOTTLE_JSONB_COLUMNS);
const barBottleToFirestoreObj = makeToFirestoreObj(buildReverseMap(BAR_BOTTLE_FIELD_MAP));

// ── barReconciliation ───────────────────────────────────────────────────────

const BAR_RECONCILIATION_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  date: 'date',
  entries: 'entries',
  status: 'status',
  completedBy: 'completed_by',
  createdAt: 'created_at',
  completedAt: 'completed_at',
};

const BAR_RECONCILIATION_JSONB_COLUMNS = new Set(['entries', 'extra_data']);
const barReconciliationToPgRow = makeToPgRow(BAR_RECONCILIATION_FIELD_MAP, BAR_RECONCILIATION_JSONB_COLUMNS);
const barReconciliationToFirestoreObj = makeToFirestoreObj(buildReverseMap(BAR_RECONCILIATION_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP M: Staff & Scheduling (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── staffAvailability ───────────────────────────────────────────────────────

const STAFF_AVAILABILITY_FIELD_MAP = {
  id: 'id',
  staffId: 'staff_id',
  restaurantId: 'restaurant_id',
  availability: 'availability',
  preferences: 'preferences',
  updatedAt: 'updated_at',
};

const STAFF_AVAILABILITY_JSONB_COLUMNS = new Set(['availability', 'preferences', 'extra_data']);
const staffAvailabilityToPgRow = makeToPgRow(STAFF_AVAILABILITY_FIELD_MAP, STAFF_AVAILABILITY_JSONB_COLUMNS);
const staffAvailabilityToFirestoreObj = makeToFirestoreObj(buildReverseMap(STAFF_AVAILABILITY_FIELD_MAP));

// ── staffLocations ──────────────────────────────────────────────────────────

const STAFF_LOCATION_FIELD_MAP = {
  id: 'id',
  staffId: 'staff_id',
  restaurantId: 'restaurant_id',
  latitude: 'latitude',
  longitude: 'longitude',
  accuracy: 'accuracy',
  timestamp: 'timestamp',
  type: 'type',
};

const STAFF_LOCATION_JSONB_COLUMNS = new Set(['extra_data']);
const staffLocationToPgRow = makeToPgRow(STAFF_LOCATION_FIELD_MAP, STAFF_LOCATION_JSONB_COLUMNS);
const staffLocationToFirestoreObj = makeToFirestoreObj(buildReverseMap(STAFF_LOCATION_FIELD_MAP));

// ── staffLocationsLatest (Firestore: staffLocations_latest) ─────────────────

const STAFF_LOCATION_LATEST_FIELD_MAP = {
  id: 'id',
  staffId: 'staff_id',
  restaurantId: 'restaurant_id',
  latitude: 'latitude',
  longitude: 'longitude',
  accuracy: 'accuracy',
  lastUpdated: 'last_updated',
  isActive: 'is_active',
};

const STAFF_LOCATION_LATEST_JSONB_COLUMNS = new Set(['extra_data']);
const staffLocationLatestToPgRow = makeToPgRow(STAFF_LOCATION_LATEST_FIELD_MAP, STAFF_LOCATION_LATEST_JSONB_COLUMNS);
const staffLocationLatestToFirestoreObj = makeToFirestoreObj(buildReverseMap(STAFF_LOCATION_LATEST_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP N: Miscellaneous (11 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── invoices ────────────────────────────────────────────────────────────────

const INVOICE_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  orderId: 'order_id',
  invoiceNumber: 'invoice_number',
  items: 'items',
  subtotal: 'subtotal',
  tax: 'tax',
  total: 'total',
  discount: 'discount',
  customerName: 'customer_name',
  paymentMethod: 'payment_method',
  cashReceived: 'cash_received',
  changeReturned: 'change_returned',
  invoiceDate: 'invoice_date',
  generatedBy: 'generated_by',
  status: 'status',
};

const INVOICE_JSONB_COLUMNS = new Set(['items', 'extra_data']);
const invoiceToPgRow = makeToPgRow(INVOICE_FIELD_MAP, INVOICE_JSONB_COLUMNS);
const invoiceToFirestoreObj = makeToFirestoreObj(buildReverseMap(INVOICE_FIELD_MAP));

// ── discountApprovals ───────────────────────────────────────────────────────

const DISCOUNT_APPROVAL_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  requestedBy: 'requested_by',
  orderId: 'order_id',
  discountPercent: 'discount_percent',
  discountAmount: 'discount_amount',
  reason: 'reason',
  status: 'status',
  approvedBy: 'approved_by',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const DISCOUNT_APPROVAL_JSONB_COLUMNS = new Set(['extra_data']);
const discountApprovalToPgRow = makeToPgRow(DISCOUNT_APPROVAL_FIELD_MAP, DISCOUNT_APPROVAL_JSONB_COLUMNS);
const discountApprovalToFirestoreObj = makeToFirestoreObj(buildReverseMap(DISCOUNT_APPROVAL_FIELD_MAP));

// ── ownerPreferences ────────────────────────────────────────────────────────

const OWNER_PREF_FIELD_MAP = {
  id: 'id',
  userId: 'user_id',
  restaurantId: 'restaurant_id',
  insightCategories: 'insight_categories',
  preferredMetrics: 'preferred_metrics',
  dashboardLayout: 'dashboard_layout',
  updatedAt: 'updated_at',
};

const OWNER_PREF_JSONB_COLUMNS = new Set(['insight_categories', 'preferred_metrics', 'dashboard_layout', 'extra_data']);
const ownerPrefToPgRow = makeToPgRow(OWNER_PREF_FIELD_MAP, OWNER_PREF_JSONB_COLUMNS);
const ownerPrefToFirestoreObj = makeToFirestoreObj(buildReverseMap(OWNER_PREF_FIELD_MAP));

// ── taxSettings ─────────────────────────────────────────────────────────────

const TAX_SETTINGS_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  taxRate: 'tax_rate',
  taxName: 'tax_name',
  taxType: 'tax_type',
  isActive: 'is_active',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const TAX_SETTINGS_JSONB_COLUMNS = new Set(['extra_data']);
const taxSettingsToPgRow = makeToPgRow(TAX_SETTINGS_FIELD_MAP, TAX_SETTINGS_JSONB_COLUMNS);
const taxSettingsToFirestoreObj = makeToFirestoreObj(buildReverseMap(TAX_SETTINGS_FIELD_MAP));

// ── staff ───────────────────────────────────────────────────────────────────

const STAFF_FIELD_MAP = {
  id: 'id',
  name: 'name',
  phone: 'phone',
  email: 'email',
  role: 'role',
  address: 'address',
  restaurantId: 'restaurant_id',
  isActive: 'is_active',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const STAFF_JSONB_COLUMNS = new Set(['extra_data']);
const staffToPgRow = makeToPgRow(STAFF_FIELD_MAP, STAFF_JSONB_COLUMNS);
const staffToFirestoreObj = makeToFirestoreObj(buildReverseMap(STAFF_FIELD_MAP));

// ── coupons ─────────────────────────────────────────────────────────────────

const COUPON_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  code: 'code',
  type: 'type',
  value: 'value',
  minOrderAmount: 'min_order_amount',
  maxUses: 'max_uses',
  usedCount: 'used_count',
  validFrom: 'valid_from',
  validUntil: 'valid_until',
  isActive: 'is_active',
  isPublic: 'is_public',
  applicableTo: 'applicable_to',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

const COUPON_JSONB_COLUMNS = new Set(['extra_data']);
const couponToPgRow = makeToPgRow(COUPON_FIELD_MAP, COUPON_JSONB_COLUMNS);
const couponToFirestoreObj = makeToFirestoreObj(buildReverseMap(COUPON_FIELD_MAP));

// ── menuBulkDeleteLogs ──────────────────────────────────────────────────────

const MENU_BULK_DELETE_LOG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  restaurantName: 'restaurant_name',
  deletedBy: 'deleted_by',
  deletedByName: 'deleted_by_name',
  deletedByEmail: 'deleted_by_email',
  deletedByPhone: 'deleted_by_phone',
  reason: 'reason',
  deletedCount: 'deleted_count',
  deletedAt: 'deleted_at',
};

const MENU_BULK_DELETE_LOG_JSONB_COLUMNS = new Set(['extra_data']);
const menuBulkDeleteLogToPgRow = makeToPgRow(MENU_BULK_DELETE_LOG_FIELD_MAP, MENU_BULK_DELETE_LOG_JSONB_COLUMNS);
const menuBulkDeleteLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(MENU_BULK_DELETE_LOG_FIELD_MAP));

// ── aggregatorWebhookLogs ───────────────────────────────────────────────────

const AGGREGATOR_WEBHOOK_LOG_FIELD_MAP = {
  id: 'id',
  source: 'source',
  event: 'event',
  payload: 'payload',
  signature: 'signature',
  timestamp: 'timestamp',
};

const AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS = new Set(['payload', 'extra_data']);
const aggregatorWebhookLogToPgRow = makeToPgRow(AGGREGATOR_WEBHOOK_LOG_FIELD_MAP, AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS);
const aggregatorWebhookLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(AGGREGATOR_WEBHOOK_LOG_FIELD_MAP));

// ── whatsappOrderLogs ───────────────────────────────────────────────────────

const WHATSAPP_ORDER_LOG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  customerPhone: 'customer_phone',
  message: 'message',
  parsedOrder: 'parsed_order',
  timestamp: 'timestamp',
};

const WHATSAPP_ORDER_LOG_JSONB_COLUMNS = new Set(['parsed_order', 'extra_data']);
const whatsappOrderLogToPgRow = makeToPgRow(WHATSAPP_ORDER_LOG_FIELD_MAP, WHATSAPP_ORDER_LOG_JSONB_COLUMNS);
const whatsappOrderLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(WHATSAPP_ORDER_LOG_FIELD_MAP));

// ── d365SyncLog ──────────────────────────────────────────────────────────────

const D365_SYNC_LOG_FIELD_MAP = {
  id: 'id',
  restaurantId: 'restaurant_id',
  type: 'type',
  date: 'date',
  status: 'status',
  orderId: 'order_id',
  journalLinesPosted: 'journal_lines_posted',
  totalAmount: 'total_amount',
  bcDocumentNumber: 'bc_document_number',
  itemsSynced: 'items_synced',
  customersSynced: 'customers_synced',
  error: 'error',
  details: 'details',
  syncedBy: 'synced_by',
  syncedAt: 'synced_at',
};

const D365_SYNC_LOG_JSONB_COLUMNS = new Set(['details', 'extra_data']);
const d365SyncLogToPgRow = makeToPgRow(D365_SYNC_LOG_FIELD_MAP, D365_SYNC_LOG_JSONB_COLUMNS);
const d365SyncLogToFirestoreObj = makeToFirestoreObj(buildReverseMap(D365_SYNC_LOG_FIELD_MAP));

// ═══════════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // GROUP A: Supply Chain
  supplierToPgRow, supplierToFirestoreObj, SUPPLIER_JSONB_COLUMNS,
  poToPgRow, poToFirestoreObj, PO_JSONB_COLUMNS,
  requisitionToPgRow, requisitionToFirestoreObj, REQUISITION_JSONB_COLUMNS,
  grnToPgRow, grnToFirestoreObj, GRN_JSONB_COLUMNS,
  supplierReturnToPgRow, supplierReturnToFirestoreObj, SUPPLIER_RETURN_JSONB_COLUMNS,
  stockTransferToPgRow, stockTransferToFirestoreObj, STOCK_TRANSFER_JSONB_COLUMNS,
  supplierPerfToPgRow, supplierPerfToFirestoreObj, SUPPLIER_PERF_JSONB_COLUMNS,
  supplierInvoiceToPgRow, supplierInvoiceToFirestoreObj, SUPPLIER_INVOICE_JSONB_COLUMNS,

  // GROUP B: Inventory & Production
  recipeToPgRow, recipeToFirestoreObj, RECIPE_JSONB_COLUMNS,
  invTxnToPgRow, invTxnToFirestoreObj, INV_TXN_JSONB_COLUMNS,
  stockBatchToPgRow, stockBatchToFirestoreObj, STOCK_BATCH_JSONB_COLUMNS,
  wasteEntryToPgRow, wasteEntryToFirestoreObj, WASTE_ENTRY_JSONB_COLUMNS,
  stockAuditToPgRow, stockAuditToFirestoreObj, STOCK_AUDIT_JSONB_COLUMNS,
  productionEntryToPgRow, productionEntryToFirestoreObj, PRODUCTION_ENTRY_JSONB_COLUMNS,

  // GROUP C: Feedback & Customer
  feedbackFormToPgRow, feedbackFormToFirestoreObj, FEEDBACK_FORM_JSONB_COLUMNS,
  feedbackResponseToPgRow, feedbackResponseToFirestoreObj, FEEDBACK_RESPONSE_JSONB_COLUMNS,
  customerGroupToPgRow, customerGroupToFirestoreObj, CUSTOMER_GROUP_JSONB_COLUMNS,

  // GROUP D: Booking & Space
  bookingToPgRow, bookingToFirestoreObj, BOOKING_JSONB_COLUMNS,
  bookingVenueToPgRow, bookingVenueToFirestoreObj, BOOKING_VENUE_JSONB_COLUMNS,
  spaceBookingToPgRow, spaceBookingToFirestoreObj, SPACE_BOOKING_JSONB_COLUMNS,

  // GROUP E: Parking
  parkingConfigToPgRow, parkingConfigToFirestoreObj, PARKING_CONFIG_JSONB_COLUMNS,
  parkingZoneToPgRow, parkingZoneToFirestoreObj, PARKING_ZONE_JSONB_COLUMNS,
  parkingSlotToPgRow, parkingSlotToFirestoreObj, PARKING_SLOT_JSONB_COLUMNS,
  parkingTicketToPgRow, parkingTicketToFirestoreObj, PARKING_TICKET_JSONB_COLUMNS,
  parkingRateToPgRow, parkingRateToFirestoreObj, PARKING_RATE_JSONB_COLUMNS,

  // GROUP F: Settings
  restaurantSettingsToPgRow, restaurantSettingsToFirestoreObj, RESTAURANT_SETTINGS_JSONB_COLUMNS,
  discountSettingsToPgRow, discountSettingsToFirestoreObj, DISCOUNT_SETTINGS_JSONB_COLUMNS,

  // GROUP G: Payment & Billing
  paymentToPgRow, paymentToFirestoreObj, PAYMENT_JSONB_COLUMNS,
  razorpayTokenToPgRow, razorpayTokenToFirestoreObj, RAZORPAY_TOKEN_JSONB_COLUMNS,
  dodoOrderToPgRow, dodoOrderToFirestoreObj, DODO_ORDER_JSONB_COLUMNS,
  dodoBillingToPgRow, dodoBillingToFirestoreObj, DODO_BILLING_JSONB_COLUMNS,
  dodoRefundToPgRow, dodoRefundToFirestoreObj, DODO_REFUND_JSONB_COLUMNS,
  dodoDisputeToPgRow, dodoDisputeToFirestoreObj, DODO_DISPUTE_JSONB_COLUMNS,
  dodoWebhookToPgRow, dodoWebhookToFirestoreObj, DODO_WEBHOOK_JSONB_COLUMNS,
  dineWebhookToPgRow, dineWebhookToFirestoreObj, DINE_WEBHOOK_JSONB_COLUMNS,

  // GROUP H: Cart & Idempotency
  savedCartToPgRow, savedCartToFirestoreObj, SAVED_CART_JSONB_COLUMNS,
  idempotencyKeyToPgRow, idempotencyKeyToFirestoreObj, IDEMPOTENCY_KEY_JSONB_COLUMNS,

  // GROUP I: Security
  blockedIpToPgRow, blockedIpToFirestoreObj, BLOCKED_IP_JSONB_COLUMNS,
  securityLogToPgRow, securityLogToFirestoreObj, SECURITY_LOG_JSONB_COLUMNS,
  rateLimitToPgRow, rateLimitToFirestoreObj, RATE_LIMIT_JSONB_COLUMNS,
  publicToolUsageToPgRow, publicToolUsageToFirestoreObj, PUBLIC_TOOL_USAGE_JSONB_COLUMNS,
  systemConfigToPgRow, systemConfigToFirestoreObj, SYSTEM_CONFIG_JSONB_COLUMNS,

  // GROUP J: Auth & OTP
  emailOtpToPgRow, emailOtpToFirestoreObj, EMAIL_OTP_JSONB_COLUMNS,
  otpVerificationToPgRow, otpVerificationToFirestoreObj, OTP_VERIFICATION_JSONB_COLUMNS,
  demoRequestToPgRow, demoRequestToFirestoreObj, DEMO_REQUEST_JSONB_COLUMNS,

  // GROUP K: AI & Chatbot
  chatbotConvToPgRow, chatbotConvToFirestoreObj, CHATBOT_CONV_JSONB_COLUMNS,
  conversationToPgRow, conversationToFirestoreObj, CONVERSATION_JSONB_COLUMNS,
  ragKnowledgeToPgRow, ragKnowledgeToFirestoreObj, RAG_KNOWLEDGE_JSONB_COLUMNS,
  tokenUsageToPgRow, tokenUsageToFirestoreObj, TOKEN_USAGE_JSONB_COLUMNS,
  queryCacheToPgRow, queryCacheToFirestoreObj, QUERY_CACHE_JSONB_COLUMNS,

  // GROUP L: Bar Inventory
  barBottleToPgRow, barBottleToFirestoreObj, BAR_BOTTLE_JSONB_COLUMNS,
  barReconciliationToPgRow, barReconciliationToFirestoreObj, BAR_RECONCILIATION_JSONB_COLUMNS,

  // GROUP M: Staff & Scheduling
  staffAvailabilityToPgRow, staffAvailabilityToFirestoreObj, STAFF_AVAILABILITY_JSONB_COLUMNS,
  staffLocationToPgRow, staffLocationToFirestoreObj, STAFF_LOCATION_JSONB_COLUMNS,
  staffLocationLatestToPgRow, staffLocationLatestToFirestoreObj, STAFF_LOCATION_LATEST_JSONB_COLUMNS,

  // GROUP N: Miscellaneous
  invoiceToPgRow, invoiceToFirestoreObj, INVOICE_JSONB_COLUMNS,
  discountApprovalToPgRow, discountApprovalToFirestoreObj, DISCOUNT_APPROVAL_JSONB_COLUMNS,
  ownerPrefToPgRow, ownerPrefToFirestoreObj, OWNER_PREF_JSONB_COLUMNS,
  taxSettingsToPgRow, taxSettingsToFirestoreObj, TAX_SETTINGS_JSONB_COLUMNS,
  staffToPgRow, staffToFirestoreObj, STAFF_JSONB_COLUMNS,
  couponToPgRow, couponToFirestoreObj, COUPON_JSONB_COLUMNS,
  menuBulkDeleteLogToPgRow, menuBulkDeleteLogToFirestoreObj, MENU_BULK_DELETE_LOG_JSONB_COLUMNS,
  aggregatorWebhookLogToPgRow, aggregatorWebhookLogToFirestoreObj, AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS,
  whatsappOrderLogToPgRow, whatsappOrderLogToFirestoreObj, WHATSAPP_ORDER_LOG_JSONB_COLUMNS,

  // GROUP O: D365 Integration
  d365SyncLogToPgRow, d365SyncLogToFirestoreObj, D365_SYNC_LOG_JSONB_COLUMNS,
};
