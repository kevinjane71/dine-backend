/**
 * systemMiscRepo.js — PostgreSQL data access for Phase 10 System/Misc collections (64 tables).
 */

const { query } = require('./pgClient');
const { buildUpsert, buildUpdate } = require('./queryBuilder');
const {
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
} = require('./systemMiscFieldMapper');

// ── Generic helpers ──────────────────────────────────────────────────────────

function makeUpsert(table, toPgRowFn, jsonbCols, toFsObjFn) {
  return async function upsert(docId, data) {
    const pgRow = toPgRowFn({ id: docId, ...data });
    if (!pgRow.id) pgRow.id = docId;
    const q = buildUpsert(table, pgRow, jsonbCols);
    const result = await query(q.text, q.values);
    return result.rows.length > 0 ? toFsObjFn(result.rows[0]) : null;
  };
}

function makeUpdate(table, toPgRowFn, jsonbCols) {
  return async function update(docId, updates) {
    const pgRow = toPgRowFn(updates);
    delete pgRow.id;
    const q = buildUpdate(table, docId, pgRow, jsonbCols);
    if (!q) return;
    await query(q.text, q.values);
  };
}

function makeDelete(table) {
  return async function remove(docId) {
    await query(`DELETE FROM ${table} WHERE id = $1`, [docId]);
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP A: Supply Chain (8 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── suppliers ────────────────────────────────────────────────────────────────
const upsertSupplier = makeUpsert('suppliers', supplierToPgRow, SUPPLIER_JSONB_COLUMNS, supplierToFirestoreObj);
const updateSupplier = makeUpdate('suppliers', supplierToPgRow, SUPPLIER_JSONB_COLUMNS);
const deleteSupplier = makeDelete('suppliers');

// ── purchaseOrders ───────────────────────────────────────────────────────────
const upsertPurchaseOrder = makeUpsert('purchase_orders', poToPgRow, PO_JSONB_COLUMNS, poToFirestoreObj);
const updatePurchaseOrder = makeUpdate('purchase_orders', poToPgRow, PO_JSONB_COLUMNS);
const deletePurchaseOrder = makeDelete('purchase_orders');

// ── purchaseRequisitions ─────────────────────────────────────────────────────
const upsertRequisition = makeUpsert('purchase_requisitions', requisitionToPgRow, REQUISITION_JSONB_COLUMNS, requisitionToFirestoreObj);
const updateRequisition = makeUpdate('purchase_requisitions', requisitionToPgRow, REQUISITION_JSONB_COLUMNS);
const deleteRequisition = makeDelete('purchase_requisitions');

// ── goodsReceiptNotes ────────────────────────────────────────────────────────
const upsertGoodsReceiptNote = makeUpsert('goods_receipt_notes', grnToPgRow, GRN_JSONB_COLUMNS, grnToFirestoreObj);
const updateGoodsReceiptNote = makeUpdate('goods_receipt_notes', grnToPgRow, GRN_JSONB_COLUMNS);

// ── supplierReturns ──────────────────────────────────────────────────────────
const upsertSupplierReturn = makeUpsert('supplier_returns', supplierReturnToPgRow, SUPPLIER_RETURN_JSONB_COLUMNS, supplierReturnToFirestoreObj);
const updateSupplierReturn = makeUpdate('supplier_returns', supplierReturnToPgRow, SUPPLIER_RETURN_JSONB_COLUMNS);

// ── stockTransfers ───────────────────────────────────────────────────────────
const upsertStockTransfer = makeUpsert('stock_transfers', stockTransferToPgRow, STOCK_TRANSFER_JSONB_COLUMNS, stockTransferToFirestoreObj);
const updateStockTransfer = makeUpdate('stock_transfers', stockTransferToPgRow, STOCK_TRANSFER_JSONB_COLUMNS);

// ── supplierPerformance ──────────────────────────────────────────────────────
const upsertSupplierPerformance = makeUpsert('supplier_performance', supplierPerfToPgRow, SUPPLIER_PERF_JSONB_COLUMNS, supplierPerfToFirestoreObj);
const updateSupplierPerformance = makeUpdate('supplier_performance', supplierPerfToPgRow, SUPPLIER_PERF_JSONB_COLUMNS);

// ── supplierInvoices ─────────────────────────────────────────────────────────
const upsertSupplierInvoice = makeUpsert('supplier_invoices', supplierInvoiceToPgRow, SUPPLIER_INVOICE_JSONB_COLUMNS, supplierInvoiceToFirestoreObj);
const updateSupplierInvoice = makeUpdate('supplier_invoices', supplierInvoiceToPgRow, SUPPLIER_INVOICE_JSONB_COLUMNS);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP B: Inventory & Production (6 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── recipes ──────────────────────────────────────────────────────────────────
const upsertRecipe = makeUpsert('recipes', recipeToPgRow, RECIPE_JSONB_COLUMNS, recipeToFirestoreObj);
const updateRecipe = makeUpdate('recipes', recipeToPgRow, RECIPE_JSONB_COLUMNS);
const deleteRecipe = makeDelete('recipes');

// ── inventoryTransactions (append-only) ──────────────────────────────────────
const upsertInventoryTransaction = makeUpsert('inventory_transactions', invTxnToPgRow, INV_TXN_JSONB_COLUMNS, invTxnToFirestoreObj);

// ── stockBatches ─────────────────────────────────────────────────────────────
const upsertStockBatch = makeUpsert('stock_batches', stockBatchToPgRow, STOCK_BATCH_JSONB_COLUMNS, stockBatchToFirestoreObj);
const updateStockBatch = makeUpdate('stock_batches', stockBatchToPgRow, STOCK_BATCH_JSONB_COLUMNS);

// ── wasteEntries (append-only) ───────────────────────────────────────────────
const upsertWasteEntry = makeUpsert('waste_entries', wasteEntryToPgRow, WASTE_ENTRY_JSONB_COLUMNS, wasteEntryToFirestoreObj);

// ── stockAudits ──────────────────────────────────────────────────────────────
const upsertStockAudit = makeUpsert('stock_audits', stockAuditToPgRow, STOCK_AUDIT_JSONB_COLUMNS, stockAuditToFirestoreObj);
const updateStockAudit = makeUpdate('stock_audits', stockAuditToPgRow, STOCK_AUDIT_JSONB_COLUMNS);

// ── productionEntries ────────────────────────────────────────────────────────
const upsertProductionEntry = makeUpsert('production_entries', productionEntryToPgRow, PRODUCTION_ENTRY_JSONB_COLUMNS, productionEntryToFirestoreObj);
const updateProductionEntry = makeUpdate('production_entries', productionEntryToPgRow, PRODUCTION_ENTRY_JSONB_COLUMNS);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP C: Feedback & Customer (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── feedbackForms ────────────────────────────────────────────────────────────
const upsertFeedbackForm = makeUpsert('feedback_forms', feedbackFormToPgRow, FEEDBACK_FORM_JSONB_COLUMNS, feedbackFormToFirestoreObj);
const updateFeedbackForm = makeUpdate('feedback_forms', feedbackFormToPgRow, FEEDBACK_FORM_JSONB_COLUMNS);
const deleteFeedbackForm = makeDelete('feedback_forms');

// ── feedbackResponses (append-only) ──────────────────────────────────────────
const upsertFeedbackResponse = makeUpsert('feedback_responses', feedbackResponseToPgRow, FEEDBACK_RESPONSE_JSONB_COLUMNS, feedbackResponseToFirestoreObj);

// ── customerGroups ───────────────────────────────────────────────────────────
const upsertCustomerGroup = makeUpsert('customer_groups', customerGroupToPgRow, CUSTOMER_GROUP_JSONB_COLUMNS, customerGroupToFirestoreObj);
const updateCustomerGroup = makeUpdate('customer_groups', customerGroupToPgRow, CUSTOMER_GROUP_JSONB_COLUMNS);
const deleteCustomerGroup = makeDelete('customer_groups');

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP D: Booking & Space (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── bookings ─────────────────────────────────────────────────────────────────
const upsertBooking = makeUpsert('rest_bookings', bookingToPgRow, BOOKING_JSONB_COLUMNS, bookingToFirestoreObj);
const updateBooking = makeUpdate('rest_bookings', bookingToPgRow, BOOKING_JSONB_COLUMNS);
const deleteBooking = makeDelete('rest_bookings');

// ── bookingVenues ────────────────────────────────────────────────────────────
const upsertBookingVenue = makeUpsert('rest_booking_venues', bookingVenueToPgRow, BOOKING_VENUE_JSONB_COLUMNS, bookingVenueToFirestoreObj);
const updateBookingVenue = makeUpdate('rest_booking_venues', bookingVenueToPgRow, BOOKING_VENUE_JSONB_COLUMNS);
const deleteBookingVenue = makeDelete('rest_booking_venues');

// ── spaceBookings ────────────────────────────────────────────────────────────
const upsertSpaceBooking = makeUpsert('space_bookings', spaceBookingToPgRow, SPACE_BOOKING_JSONB_COLUMNS, spaceBookingToFirestoreObj);
const updateSpaceBooking = makeUpdate('space_bookings', spaceBookingToPgRow, SPACE_BOOKING_JSONB_COLUMNS);
const deleteSpaceBooking = makeDelete('space_bookings');

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP E: Parking (5 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── parkingConfigs ───────────────────────────────────────────────────────────
const upsertParkingConfig = makeUpsert('parking_configs', parkingConfigToPgRow, PARKING_CONFIG_JSONB_COLUMNS, parkingConfigToFirestoreObj);
const updateParkingConfig = makeUpdate('parking_configs', parkingConfigToPgRow, PARKING_CONFIG_JSONB_COLUMNS);

// ── parkingZones ─────────────────────────────────────────────────────────────
const upsertParkingZone = makeUpsert('parking_zones', parkingZoneToPgRow, PARKING_ZONE_JSONB_COLUMNS, parkingZoneToFirestoreObj);
const updateParkingZone = makeUpdate('parking_zones', parkingZoneToPgRow, PARKING_ZONE_JSONB_COLUMNS);
const deleteParkingZone = makeDelete('parking_zones');

// ── parkingSlots ─────────────────────────────────────────────────────────────
const upsertParkingSlot = makeUpsert('parking_slots', parkingSlotToPgRow, PARKING_SLOT_JSONB_COLUMNS, parkingSlotToFirestoreObj);
const updateParkingSlot = makeUpdate('parking_slots', parkingSlotToPgRow, PARKING_SLOT_JSONB_COLUMNS);
const deleteParkingSlot = makeDelete('parking_slots');

// ── parkingTickets ───────────────────────────────────────────────────────────
const upsertParkingTicket = makeUpsert('parking_tickets', parkingTicketToPgRow, PARKING_TICKET_JSONB_COLUMNS, parkingTicketToFirestoreObj);
const updateParkingTicket = makeUpdate('parking_tickets', parkingTicketToPgRow, PARKING_TICKET_JSONB_COLUMNS);

// ── parkingRates ─────────────────────────────────────────────────────────────
const upsertParkingRate = makeUpsert('parking_rates', parkingRateToPgRow, PARKING_RATE_JSONB_COLUMNS, parkingRateToFirestoreObj);
const updateParkingRate = makeUpdate('parking_rates', parkingRateToPgRow, PARKING_RATE_JSONB_COLUMNS);
const deleteParkingRate = makeDelete('parking_rates');

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP F: Settings (2 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── restaurantSettings ───────────────────────────────────────────────────────
const upsertRestaurantSettings = makeUpsert('restaurant_settings', restaurantSettingsToPgRow, RESTAURANT_SETTINGS_JSONB_COLUMNS, restaurantSettingsToFirestoreObj);
const updateRestaurantSettings = makeUpdate('restaurant_settings', restaurantSettingsToPgRow, RESTAURANT_SETTINGS_JSONB_COLUMNS);

// ── discountSettings ─────────────────────────────────────────────────────────
const upsertDiscountSettings = makeUpsert('discount_settings', discountSettingsToPgRow, DISCOUNT_SETTINGS_JSONB_COLUMNS, discountSettingsToFirestoreObj);
const updateDiscountSettings = makeUpdate('discount_settings', discountSettingsToPgRow, DISCOUNT_SETTINGS_JSONB_COLUMNS);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP G: Payment & Billing (8 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── payments ─────────────────────────────────────────────────────────────────
const upsertPayment = makeUpsert('pos_payments', paymentToPgRow, PAYMENT_JSONB_COLUMNS, paymentToFirestoreObj);
const updatePayment = makeUpdate('pos_payments', paymentToPgRow, PAYMENT_JSONB_COLUMNS);

// ── razorpayTokens ───────────────────────────────────────────────────────────
const upsertRazorpayToken = makeUpsert('razorpay_tokens', razorpayTokenToPgRow, RAZORPAY_TOKEN_JSONB_COLUMNS, razorpayTokenToFirestoreObj);
const updateRazorpayToken = makeUpdate('razorpay_tokens', razorpayTokenToPgRow, RAZORPAY_TOKEN_JSONB_COLUMNS);
const deleteRazorpayToken = makeDelete('razorpay_tokens');

// ── dineDodoOrders ───────────────────────────────────────────────────────────
const upsertDodoOrder = makeUpsert('dine_dodo_orders', dodoOrderToPgRow, DODO_ORDER_JSONB_COLUMNS, dodoOrderToFirestoreObj);
const updateDodoOrder = makeUpdate('dine_dodo_orders', dodoOrderToPgRow, DODO_ORDER_JSONB_COLUMNS);

// ── dineDodoBilling ──────────────────────────────────────────────────────────
const upsertDodoBilling = makeUpsert('dine_dodo_billing', dodoBillingToPgRow, DODO_BILLING_JSONB_COLUMNS, dodoBillingToFirestoreObj);
const updateDodoBilling = makeUpdate('dine_dodo_billing', dodoBillingToPgRow, DODO_BILLING_JSONB_COLUMNS);

// ── dineDodoRefunds (append-only) ────────────────────────────────────────────
const upsertDodoRefund = makeUpsert('dine_dodo_refunds', dodoRefundToPgRow, DODO_REFUND_JSONB_COLUMNS, dodoRefundToFirestoreObj);

// ── dineDodoDisputes ─────────────────────────────────────────────────────────
const upsertDodoDispute = makeUpsert('dine_dodo_disputes', dodoDisputeToPgRow, DODO_DISPUTE_JSONB_COLUMNS, dodoDisputeToFirestoreObj);
const updateDodoDispute = makeUpdate('dine_dodo_disputes', dodoDisputeToPgRow, DODO_DISPUTE_JSONB_COLUMNS);

// ── dineDodoWebhookEvents (append-only) ──────────────────────────────────────
const upsertDodoWebhookEvent = makeUpsert('dine_dodo_webhook_events', dodoWebhookToPgRow, DODO_WEBHOOK_JSONB_COLUMNS, dodoWebhookToFirestoreObj);

// ── dineWebhookEvents (append-only) ─────────────────────────────────────────
const upsertDineWebhookEvent = makeUpsert('dine_webhook_events', dineWebhookToPgRow, DINE_WEBHOOK_JSONB_COLUMNS, dineWebhookToFirestoreObj);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP H: Cart & Idempotency (2 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── savedCarts ───────────────────────────────────────────────────────────────
const upsertSavedCart = makeUpsert('saved_carts', savedCartToPgRow, SAVED_CART_JSONB_COLUMNS, savedCartToFirestoreObj);
const updateSavedCart = makeUpdate('saved_carts', savedCartToPgRow, SAVED_CART_JSONB_COLUMNS);
const deleteSavedCart = makeDelete('saved_carts');

// ── idempotencyKeys ──────────────────────────────────────────────────────────
const upsertIdempotencyKey = makeUpsert('idempotency_keys', idempotencyKeyToPgRow, IDEMPOTENCY_KEY_JSONB_COLUMNS, idempotencyKeyToFirestoreObj);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP I: Security (5 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── blockedIPs ───────────────────────────────────────────────────────────────
const upsertBlockedIp = makeUpsert('blocked_ips', blockedIpToPgRow, BLOCKED_IP_JSONB_COLUMNS, blockedIpToFirestoreObj);
const updateBlockedIp = makeUpdate('blocked_ips', blockedIpToPgRow, BLOCKED_IP_JSONB_COLUMNS);
const deleteBlockedIp = makeDelete('blocked_ips');

// ── securityLogs (append-only) ───────────────────────────────────────────────
const upsertSecurityLog = makeUpsert('security_logs', securityLogToPgRow, SECURITY_LOG_JSONB_COLUMNS, securityLogToFirestoreObj);

// ── rateLimits ───────────────────────────────────────────────────────────────
const upsertRateLimit = makeUpsert('rate_limits', rateLimitToPgRow, RATE_LIMIT_JSONB_COLUMNS, rateLimitToFirestoreObj);
const updateRateLimit = makeUpdate('rate_limits', rateLimitToPgRow, RATE_LIMIT_JSONB_COLUMNS);

// ── publicToolUsage ──────────────────────────────────────────────────────────
const upsertPublicToolUsage = makeUpsert('public_tool_usage', publicToolUsageToPgRow, PUBLIC_TOOL_USAGE_JSONB_COLUMNS, publicToolUsageToFirestoreObj);
const updatePublicToolUsage = makeUpdate('public_tool_usage', publicToolUsageToPgRow, PUBLIC_TOOL_USAGE_JSONB_COLUMNS);

// ── systemConfig ─────────────────────────────────────────────────────────────
const upsertSystemConfig = makeUpsert('system_config', systemConfigToPgRow, SYSTEM_CONFIG_JSONB_COLUMNS, systemConfigToFirestoreObj);
const updateSystemConfig = makeUpdate('system_config', systemConfigToPgRow, SYSTEM_CONFIG_JSONB_COLUMNS);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP J: Auth & OTP (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── emailOtpTemp ─────────────────────────────────────────────────────────────
const upsertEmailOtp = makeUpsert('email_otp_temp', emailOtpToPgRow, EMAIL_OTP_JSONB_COLUMNS, emailOtpToFirestoreObj);
const deleteEmailOtp = makeDelete('email_otp_temp');

// ── otpVerification ──────────────────────────────────────────────────────────
const upsertOtpVerification = makeUpsert('otp_verification', otpVerificationToPgRow, OTP_VERIFICATION_JSONB_COLUMNS, otpVerificationToFirestoreObj);
const deleteOtpVerification = makeDelete('otp_verification');

// ── demoRequests ─────────────────────────────────────────────────────────────
const upsertDemoRequest = makeUpsert('demo_requests', demoRequestToPgRow, DEMO_REQUEST_JSONB_COLUMNS, demoRequestToFirestoreObj);
const updateDemoRequest = makeUpdate('demo_requests', demoRequestToPgRow, DEMO_REQUEST_JSONB_COLUMNS);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP K: AI & Chatbot (5 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── chatbotConversations ─────────────────────────────────────────────────────
const upsertChatbotConversation = makeUpsert('chatbot_conversations', chatbotConvToPgRow, CHATBOT_CONV_JSONB_COLUMNS, chatbotConvToFirestoreObj);
const updateChatbotConversation = makeUpdate('chatbot_conversations', chatbotConvToPgRow, CHATBOT_CONV_JSONB_COLUMNS);

// ── conversations ────────────────────────────────────────────────────────────
const upsertConversation = makeUpsert('ai_conversations', conversationToPgRow, CONVERSATION_JSONB_COLUMNS, conversationToFirestoreObj);

// ── ragKnowledge ─────────────────────────────────────────────────────────────
const upsertRagKnowledge = makeUpsert('rag_knowledge', ragKnowledgeToPgRow, RAG_KNOWLEDGE_JSONB_COLUMNS, ragKnowledgeToFirestoreObj);
const updateRagKnowledge = makeUpdate('rag_knowledge', ragKnowledgeToPgRow, RAG_KNOWLEDGE_JSONB_COLUMNS);
const deleteRagKnowledge = makeDelete('rag_knowledge');

// ── tokenUsage ───────────────────────────────────────────────────────────────
const upsertTokenUsage = makeUpsert('token_usage', tokenUsageToPgRow, TOKEN_USAGE_JSONB_COLUMNS, tokenUsageToFirestoreObj);
const updateTokenUsage = makeUpdate('token_usage', tokenUsageToPgRow, TOKEN_USAGE_JSONB_COLUMNS);

// ── queryCache ───────────────────────────────────────────────────────────────
const upsertQueryCache = makeUpsert('query_cache', queryCacheToPgRow, QUERY_CACHE_JSONB_COLUMNS, queryCacheToFirestoreObj);
const deleteQueryCache = makeDelete('query_cache');

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP L: Bar Inventory (2 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── barBottles ───────────────────────────────────────────────────────────────
const upsertBarBottle = makeUpsert('bar_bottles', barBottleToPgRow, BAR_BOTTLE_JSONB_COLUMNS, barBottleToFirestoreObj);
const updateBarBottle = makeUpdate('bar_bottles', barBottleToPgRow, BAR_BOTTLE_JSONB_COLUMNS);
const deleteBarBottle = makeDelete('bar_bottles');

// ── barReconciliation ────────────────────────────────────────────────────────
const upsertBarReconciliation = makeUpsert('bar_reconciliation', barReconciliationToPgRow, BAR_RECONCILIATION_JSONB_COLUMNS, barReconciliationToFirestoreObj);
const updateBarReconciliation = makeUpdate('bar_reconciliation', barReconciliationToPgRow, BAR_RECONCILIATION_JSONB_COLUMNS);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP M: Staff & Scheduling (3 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── staffAvailability ────────────────────────────────────────────────────────
const upsertStaffAvailability = makeUpsert('staff_availability', staffAvailabilityToPgRow, STAFF_AVAILABILITY_JSONB_COLUMNS, staffAvailabilityToFirestoreObj);
const updateStaffAvailability = makeUpdate('staff_availability', staffAvailabilityToPgRow, STAFF_AVAILABILITY_JSONB_COLUMNS);

// ── staffLocations (append-only) ─────────────────────────────────────────────
const upsertStaffLocation = makeUpsert('staff_locations', staffLocationToPgRow, STAFF_LOCATION_JSONB_COLUMNS, staffLocationToFirestoreObj);

// ── staffLocationsLatest ─────────────────────────────────────────────────────
const upsertStaffLocationLatest = makeUpsert('staff_locations_latest', staffLocationLatestToPgRow, STAFF_LOCATION_LATEST_JSONB_COLUMNS, staffLocationLatestToFirestoreObj);
const updateStaffLocationLatest = makeUpdate('staff_locations_latest', staffLocationLatestToPgRow, STAFF_LOCATION_LATEST_JSONB_COLUMNS);

// ═══════════════════════════════════════════════════════════════════════════════
// GROUP N: Miscellaneous (9 collections)
// ═══════════════════════════════════════════════════════════════════════════════

// ── invoices ─────────────────────────────────────────────────────────────────
const upsertInvoice = makeUpsert('pos_invoices', invoiceToPgRow, INVOICE_JSONB_COLUMNS, invoiceToFirestoreObj);
const updateInvoice = makeUpdate('pos_invoices', invoiceToPgRow, INVOICE_JSONB_COLUMNS);

// ── discountApprovals ────────────────────────────────────────────────────────
const upsertDiscountApproval = makeUpsert('discount_approvals', discountApprovalToPgRow, DISCOUNT_APPROVAL_JSONB_COLUMNS, discountApprovalToFirestoreObj);
const updateDiscountApproval = makeUpdate('discount_approvals', discountApprovalToPgRow, DISCOUNT_APPROVAL_JSONB_COLUMNS);

// ── ownerPreferences ─────────────────────────────────────────────────────────
const upsertOwnerPreferences = makeUpsert('owner_preferences', ownerPrefToPgRow, OWNER_PREF_JSONB_COLUMNS, ownerPrefToFirestoreObj);
const updateOwnerPreferences = makeUpdate('owner_preferences', ownerPrefToPgRow, OWNER_PREF_JSONB_COLUMNS);

// ── taxSettings ──────────────────────────────────────────────────────────────
const upsertTaxSettings = makeUpsert('tax_settings', taxSettingsToPgRow, TAX_SETTINGS_JSONB_COLUMNS, taxSettingsToFirestoreObj);
const updateTaxSettings = makeUpdate('tax_settings', taxSettingsToPgRow, TAX_SETTINGS_JSONB_COLUMNS);
const deleteTaxSettings = makeDelete('tax_settings');

// ── staff (legacy) ───────────────────────────────────────────────────────────
const upsertStaff = makeUpsert('legacy_staff', staffToPgRow, STAFF_JSONB_COLUMNS, staffToFirestoreObj);
const updateStaff = makeUpdate('legacy_staff', staffToPgRow, STAFF_JSONB_COLUMNS);
const deleteStaff = makeDelete('legacy_staff');

// ── coupons ──────────────────────────────────────────────────────────────────
const upsertCoupon = makeUpsert('coupons', couponToPgRow, COUPON_JSONB_COLUMNS, couponToFirestoreObj);
const updateCoupon = makeUpdate('coupons', couponToPgRow, COUPON_JSONB_COLUMNS);
const deleteCoupon = makeDelete('coupons');

// ── menuBulkDeleteLogs (append-only) ─────────────────────────────────────────
const upsertMenuBulkDeleteLog = makeUpsert('menu_bulk_delete_logs', menuBulkDeleteLogToPgRow, MENU_BULK_DELETE_LOG_JSONB_COLUMNS, menuBulkDeleteLogToFirestoreObj);

// ── aggregatorWebhookLogs (append-only) ──────────────────────────────────────
const upsertAggregatorWebhookLog = makeUpsert('aggregator_webhook_logs', aggregatorWebhookLogToPgRow, AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS, aggregatorWebhookLogToFirestoreObj);

// ── whatsappOrderLogs (append-only) ──────────────────────────────────────────
const upsertWhatsappOrderLog = makeUpsert('whatsapp_order_logs', whatsappOrderLogToPgRow, WHATSAPP_ORDER_LOG_JSONB_COLUMNS, whatsappOrderLogToFirestoreObj);

// ═══════════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // GROUP A: Supply Chain
  upsertSupplier, updateSupplier, deleteSupplier,
  upsertPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder,
  upsertRequisition, updateRequisition, deleteRequisition,
  upsertGoodsReceiptNote, updateGoodsReceiptNote,
  upsertSupplierReturn, updateSupplierReturn,
  upsertStockTransfer, updateStockTransfer,
  upsertSupplierPerformance, updateSupplierPerformance,
  upsertSupplierInvoice, updateSupplierInvoice,

  // GROUP B: Inventory & Production
  upsertRecipe, updateRecipe, deleteRecipe,
  upsertInventoryTransaction,
  upsertStockBatch, updateStockBatch,
  upsertWasteEntry,
  upsertStockAudit, updateStockAudit,
  upsertProductionEntry, updateProductionEntry,

  // GROUP C: Feedback & Customer
  upsertFeedbackForm, updateFeedbackForm, deleteFeedbackForm,
  upsertFeedbackResponse,
  upsertCustomerGroup, updateCustomerGroup, deleteCustomerGroup,

  // GROUP D: Booking & Space
  upsertBooking, updateBooking, deleteBooking,
  upsertBookingVenue, updateBookingVenue, deleteBookingVenue,
  upsertSpaceBooking, updateSpaceBooking, deleteSpaceBooking,

  // GROUP E: Parking
  upsertParkingConfig, updateParkingConfig,
  upsertParkingZone, updateParkingZone, deleteParkingZone,
  upsertParkingSlot, updateParkingSlot, deleteParkingSlot,
  upsertParkingTicket, updateParkingTicket,
  upsertParkingRate, updateParkingRate, deleteParkingRate,

  // GROUP F: Settings
  upsertRestaurantSettings, updateRestaurantSettings,
  upsertDiscountSettings, updateDiscountSettings,

  // GROUP G: Payment & Billing
  upsertPayment, updatePayment,
  upsertRazorpayToken, updateRazorpayToken, deleteRazorpayToken,
  upsertDodoOrder, updateDodoOrder,
  upsertDodoBilling, updateDodoBilling,
  upsertDodoRefund,
  upsertDodoDispute, updateDodoDispute,
  upsertDodoWebhookEvent,
  upsertDineWebhookEvent,

  // GROUP H: Cart & Idempotency
  upsertSavedCart, updateSavedCart, deleteSavedCart,
  upsertIdempotencyKey,

  // GROUP I: Security
  upsertBlockedIp, updateBlockedIp, deleteBlockedIp,
  upsertSecurityLog,
  upsertRateLimit, updateRateLimit,
  upsertPublicToolUsage, updatePublicToolUsage,
  upsertSystemConfig, updateSystemConfig,

  // GROUP J: Auth & OTP
  upsertEmailOtp, deleteEmailOtp,
  upsertOtpVerification, deleteOtpVerification,
  upsertDemoRequest, updateDemoRequest,

  // GROUP K: AI & Chatbot
  upsertChatbotConversation, updateChatbotConversation,
  upsertConversation,
  upsertRagKnowledge, updateRagKnowledge, deleteRagKnowledge,
  upsertTokenUsage, updateTokenUsage,
  upsertQueryCache, deleteQueryCache,

  // GROUP L: Bar Inventory
  upsertBarBottle, updateBarBottle, deleteBarBottle,
  upsertBarReconciliation, updateBarReconciliation,

  // GROUP M: Staff & Scheduling
  upsertStaffAvailability, updateStaffAvailability,
  upsertStaffLocation,
  upsertStaffLocationLatest, updateStaffLocationLatest,

  // GROUP N: Miscellaneous
  upsertInvoice, updateInvoice,
  upsertDiscountApproval, updateDiscountApproval,
  upsertOwnerPreferences, updateOwnerPreferences,
  upsertTaxSettings, updateTaxSettings, deleteTaxSettings,
  upsertStaff, updateStaff, deleteStaff,
  upsertCoupon, updateCoupon, deleteCoupon,
  upsertMenuBulkDeleteLog,
  upsertAggregatorWebhookLog,
  upsertWhatsappOrderLog,
};
