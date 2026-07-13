/**
 * collectionRegistry.js — Maps every Firestore collection name to its
 * PostgreSQL table config: { table, fieldMap, toPgRow, toFirestoreObj, jsonbCols }.
 *
 * The pgAdapter uses `fieldMap` to translate camelCase .where() field names
 * to snake_case PG column names. Collections without an explicit FIELD_MAP
 * fall back to generic camelToSnake conversion (fieldMap: {}).
 */

// ═══════════════════════════════════════════════════════════════════════════
// Imports — orders
// ═══════════════════════════════════════════════════════════════════════════
const {
  FIELD_MAP: ORDER_FIELD_MAP,
  toPgRow: orderToPgRow,
  toFirestoreObj: orderToFirestoreObj,
  JSONB_COLUMNS: ORDER_JSONB_COLUMNS,
} = require('./fieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — restaurants
// ═══════════════════════════════════════════════════════════════════════════
const {
  FIELD_MAP: REST_FIELD_MAP,
  toPgRow: restToPgRow,
  toFirestoreObj: restToFirestoreObj,
  JSONB_COLUMNS: REST_JSONB_COLUMNS,
} = require('./restaurantsFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — inventory (namespace exports)
// ═══════════════════════════════════════════════════════════════════════════
const invFM = require('./inventoryFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — dailyStats
// ═══════════════════════════════════════════════════════════════════════════
const {
  FIELD_MAP: DS_FIELD_MAP,
  toPgRow: dsToPgRow,
  toFirestoreObj: dsToFirestoreObj,
  JSONB_COLUMNS: DS_JSONB_COLUMNS,
  resolveKeyPath: dsResolveKeyPath,
} = require('./dailyStatsFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — floors & tables
// ═══════════════════════════════════════════════════════════════════════════
const {
  FLOOR_FIELD_MAP,
  floorToPgRow,
  floorToFirestoreObj,
  TABLE_FIELD_MAP,
  tableToPgRow,
  tableToFirestoreObj,
  JSONB_COLUMNS: FT_JSONB_COLUMNS,
} = require('./floorsTablesFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — customers
// ═══════════════════════════════════════════════════════════════════════════
const {
  FIELD_MAP: CUST_FIELD_MAP,
  toPgRow: custToPgRow,
  toFirestoreObj: custToFirestoreObj,
  JSONB_COLUMNS: CUST_JSONB_COLUMNS,
} = require('./customersFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — offers
// ═══════════════════════════════════════════════════════════════════════════
const {
  FIELD_MAP: OFFER_FIELD_MAP,
  toPgRow: offerToPgRow,
  toFirestoreObj: offerToFirestoreObj,
  JSONB_COLUMNS: OFFER_JSONB_COLUMNS,
} = require('./offersFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — payments / subscriptions / razorpay orders
// ═══════════════════════════════════════════════════════════════════════════
const {
  PAYMENTS_FIELD_MAP,
  paymentsToPgRow,
  paymentsToFirestoreObj,
  PAYMENTS_JSONB_COLUMNS,
  SUBSCRIPTIONS_FIELD_MAP,
  subscriptionsToPgRow,
  subscriptionsToFirestoreObj,
  SUBSCRIPTIONS_JSONB_COLUMNS,
  ORDERS_FIELD_MAP: RZP_ORDERS_FIELD_MAP,
  ordersToPgRow: rzpOrdersToPgRow,
  ordersToFirestoreObj: rzpOrdersToFirestoreObj,
  ORDERS_JSONB_COLUMNS: RZP_ORDERS_JSONB_COLUMNS,
} = require('./paymentsFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — cash registers, shifts, staff shifts, staff availability
// ═══════════════════════════════════════════════════════════════════════════
const {
  REGISTER_FIELD_MAP,
  registerToPgRow,
  registerToFirestoreObj,
  REGISTER_JSONB_COLUMNS,
  SHIFT_FIELD_MAP,
  shiftToPgRow,
  shiftToFirestoreObj,
  SHIFT_JSONB_COLUMNS,
  SHIFT_SETTINGS_FIELD_MAP,
  shiftSettingsToPgRow,
  shiftSettingsToFirestoreObj,
  SHIFT_SETTINGS_JSONB_COLUMNS,
  STAFF_SHIFT_FIELD_MAP,
  staffShiftToPgRow,
  staffShiftToFirestoreObj,
  STAFF_SHIFT_JSONB_COLUMNS,
  STAFF_AVAIL_FIELD_MAP,
  staffAvailToPgRow,
  staffAvailToFirestoreObj,
  STAFF_AVAIL_JSONB_COLUMNS,
} = require('./registerFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — staff HR (staff users, attendance, leave, payroll)
// ═══════════════════════════════════════════════════════════════════════════
const {
  STAFF_FIELD_MAP: SHR_STAFF_FIELD_MAP,
  staffToPgRow: shrStaffToPgRow,
  staffToFirestoreObj: shrStaffToFirestoreObj,
  STAFF_JSONB_COLUMNS: SHR_STAFF_JSONB_COLUMNS,
  ATTENDANCE_FIELD_MAP,
  attendanceToPgRow,
  attendanceToFirestoreObj,
  ATTENDANCE_JSONB_COLUMNS,
  LEAVE_REQUEST_FIELD_MAP,
  leaveRequestToPgRow,
  leaveRequestToFirestoreObj,
  LEAVE_REQUEST_JSONB_COLUMNS,
  LEAVE_CONFIG_FIELD_MAP,
  leaveConfigToPgRow,
  leaveConfigToFirestoreObj,
  LEAVE_CONFIG_JSONB_COLUMNS,
  LEAVE_BALANCE_FIELD_MAP,
  leaveBalanceToPgRow,
  leaveBalanceToFirestoreObj,
  LEAVE_BALANCE_JSONB_COLUMNS,
  PAYROLL_CONFIG_FIELD_MAP,
  payrollConfigToPgRow,
  payrollConfigToFirestoreObj,
  PAYROLL_CONFIG_JSONB_COLUMNS,
  PAYROLL_RUN_FIELD_MAP,
  payrollRunToPgRow,
  payrollRunToFirestoreObj,
  PAYROLL_RUN_JSONB_COLUMNS,
  PAY_SLIP_FIELD_MAP,
  paySlipToPgRow,
  paySlipToFirestoreObj,
  PAY_SLIP_JSONB_COLUMNS,
} = require('./staffHrFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — accounting (chart of accounts, journal entries, expenses)
// ═══════════════════════════════════════════════════════════════════════════
const {
  COA_FIELD_MAP,
  coaToPgRow,
  coaToFirestoreObj,
  COA_JSONB_COLUMNS,
  JE_FIELD_MAP,
  jeToPgRow,
  jeToFirestoreObj,
  JE_JSONB_COLUMNS,
  EXP_FIELD_MAP,
  expToPgRow,
  expToFirestoreObj,
  EXP_JSONB_COLUMNS,
} = require('./accountingFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — hotel & bookings
// ═══════════════════════════════════════════════════════════════════════════
const {
  ROOM_FIELD_MAP, roomToPgRow, roomToFirestoreObj, ROOM_JSONB_COLUMNS,
  HOTEL_BOOKING_FIELD_MAP, hotelBookingToPgRow, hotelBookingToFirestoreObj, HOTEL_BOOKING_JSONB_COLUMNS,
  HOTEL_CHECKIN_FIELD_MAP, hotelCheckinToPgRow, hotelCheckinToFirestoreObj, HOTEL_CHECKIN_JSONB_COLUMNS,
  HOTEL_GUEST_FIELD_MAP, hotelGuestToPgRow, hotelGuestToFirestoreObj, HOTEL_GUEST_JSONB_COLUMNS,
  ROOM_MAINTENANCE_FIELD_MAP, roomMaintenanceToPgRow, roomMaintenanceToFirestoreObj, ROOM_MAINTENANCE_JSONB_COLUMNS,
  PMS_ROOM_FIELD_MAP, pmsRoomToPgRow, pmsRoomToFirestoreObj, PMS_ROOM_JSONB_COLUMNS,
  PMS_BOOKING_FIELD_MAP, pmsBookingToPgRow, pmsBookingToFirestoreObj, PMS_BOOKING_JSONB_COLUMNS,
  PMS_GUEST_FIELD_MAP, pmsGuestToPgRow, pmsGuestToFirestoreObj, PMS_GUEST_JSONB_COLUMNS,
  PMS_HOUSEKEEPING_FIELD_MAP, pmsHousekeepingToPgRow, pmsHousekeepingToFirestoreObj, PMS_HOUSEKEEPING_JSONB_COLUMNS,
  PMS_MAINTENANCE_FIELD_MAP, pmsMaintenanceToPgRow, pmsMaintenanceToFirestoreObj, PMS_MAINTENANCE_JSONB_COLUMNS,
  BOOKINGS_V2_FIELD_MAP, bookingsV2ToPgRow, bookingsV2ToFirestoreObj, BOOKINGS_V2_JSONB_COLUMNS,
  BOOKING_VENUE_FIELD_MAP, bookingVenueToPgRow, bookingVenueToFirestoreObj, BOOKING_VENUE_JSONB_COLUMNS,
} = require('./hotelBookingFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — invoice
// ═══════════════════════════════════════════════════════════════════════════
const {
  orgToPgRow: invOrgToPgRow, orgToFirestoreObj: invOrgToFirestoreObj, ORG_JSONB_COLUMNS: INV_ORG_JSONB_COLUMNS, ORG_FIELD_MAP: INV_ORG_FIELD_MAP,
  customerToPgRow: invCustToPgRow, customerToFirestoreObj: invCustToFirestoreObj, CUSTOMER_JSONB_COLUMNS: INV_CUST_JSONB_COLUMNS, CUSTOMER_FIELD_MAP: INV_CUST_FIELD_MAP,
  itemToPgRow: invItemToPgRow, itemToFirestoreObj: invItemToFirestoreObj, ITEM_JSONB_COLUMNS: INV_ITEM_JSONB_COLUMNS, ITEM_FIELD_MAP: INV_ITEM_FIELD_MAP,
  invoiceToPgRow: invInvoiceToPgRow, invoiceToFirestoreObj: invInvoiceToFirestoreObj, INVOICE_JSONB_COLUMNS: INV_INVOICE_JSONB_COLUMNS, INVOICE_FIELD_MAP: INV_INVOICE_FIELD_MAP,
  quoteToPgRow, quoteToFirestoreObj, QUOTE_JSONB_COLUMNS, QUOTE_FIELD_MAP,
  challanToPgRow, challanToFirestoreObj, CHALLAN_JSONB_COLUMNS, CHALLAN_FIELD_MAP,
  paymentToPgRow: invPaymentToPgRow, paymentToFirestoreObj: invPaymentToFirestoreObj, PAYMENT_JSONB_COLUMNS: INV_PAYMENT_JSONB_COLUMNS, PAYMENT_FIELD_MAP: INV_PAYMENT_FIELD_MAP,
  expenseToPgRow: invExpenseToPgRow, expenseToFirestoreObj: invExpenseToFirestoreObj, EXPENSE_JSONB_COLUMNS: INV_EXPENSE_JSONB_COLUMNS, EXPENSE_FIELD_MAP: INV_EXPENSE_FIELD_MAP,
  settingsToPgRow, settingsToFirestoreObj, SETTINGS_JSONB_COLUMNS, SETTINGS_FIELD_MAP,
  numberSeqToPgRow, numberSeqToFirestoreObj, NUMBER_SEQ_JSONB_COLUMNS, NUMBER_SEQ_FIELD_MAP,
} = require('./invoiceFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — enterprise
// ═══════════════════════════════════════════════════════════════════════════
const {
  orgToPgRow: entOrgToPgRow, orgToFirestoreObj: entOrgToFirestoreObj, ORG_JSONB_COLUMNS: ENT_ORG_JSONB_COLUMNS, ORG_FIELD_MAP: ENT_ORG_FIELD_MAP,
  menuTemplateToPgRow, menuTemplateToFirestoreObj, MENU_TEMPLATE_JSONB_COLUMNS, MENU_TEMPLATE_FIELD_MAP,
  menuItemToPgRow: entMenuItemToPgRow, menuItemToFirestoreObj: entMenuItemToFirestoreObj, MENU_ITEM_JSONB_COLUMNS: ENT_MENU_ITEM_JSONB_COLUMNS, MENU_ITEM_FIELD_MAP: ENT_MENU_ITEM_FIELD_MAP,
  indentToPgRow, indentToFirestoreObj, INDENT_JSONB_COLUMNS, INDENT_FIELD_MAP,
  productionOrderToPgRow, productionOrderToFirestoreObj, PRODUCTION_ORDER_JSONB_COLUMNS, PRODUCTION_ORDER_FIELD_MAP,
  distributionPlanToPgRow, distributionPlanToFirestoreObj, DISTRIBUTION_PLAN_JSONB_COLUMNS, DISTRIBUTION_PLAN_FIELD_MAP,
  orgSettingsToPgRow, orgSettingsToFirestoreObj, ORG_SETTINGS_JSONB_COLUMNS, ORG_SETTINGS_FIELD_MAP,
  auditLogToPgRow, auditLogToFirestoreObj, AUDIT_LOG_JSONB_COLUMNS, AUDIT_LOG_FIELD_MAP,
} = require('./enterpriseFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — AI & automation
// ═══════════════════════════════════════════════════════════════════════════
const {
  bolnaAgentToPgRow, bolnaAgentToFirestoreObj, BOLNA_AGENT_JSONB_COLUMNS, BOLNA_AGENT_FIELD_MAP,
  phoneCallToPgRow, phoneCallToFirestoreObj, PHONE_CALL_JSONB_COLUMNS, PHONE_CALL_FIELD_MAP,
  dineaiSettingsToPgRow, dineaiSettingsToFirestoreObj, DINEAI_SETTINGS_JSONB_COLUMNS, DINEAI_SETTINGS_FIELD_MAP,
  dineaiUsageToPgRow, dineaiUsageToFirestoreObj, DINEAI_USAGE_JSONB_COLUMNS, DINEAI_USAGE_FIELD_MAP,
  dineaiKnowledgeToPgRow, dineaiKnowledgeToFirestoreObj, DINEAI_KNOWLEDGE_JSONB_COLUMNS, DINEAI_KNOWLEDGE_FIELD_MAP,
  dineaiRtSessionToPgRow, dineaiRtSessionToFirestoreObj, DINEAI_RT_SESSION_JSONB_COLUMNS, DINEAI_RT_SESSION_FIELD_MAP,
  dineaiCheapSessionToPgRow, dineaiCheapSessionToFirestoreObj, DINEAI_CHEAP_SESSION_JSONB_COLUMNS, DINEAI_CHEAP_SESSION_FIELD_MAP,
  chatgptUsageToPgRow, chatgptUsageToFirestoreObj, CHATGPT_USAGE_JSONB_COLUMNS, CHATGPT_USAGE_FIELD_MAP,
  aiUsageToPgRow, aiUsageToFirestoreObj, AI_USAGE_JSONB_COLUMNS, AI_USAGE_FIELD_MAP,
  aiInsightsUsageToPgRow, aiInsightsUsageToFirestoreObj, AI_INSIGHTS_USAGE_JSONB_COLUMNS, AI_INSIGHTS_USAGE_FIELD_MAP,
  googleReviewSettingsToPgRow, googleReviewSettingsToFirestoreObj, GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS, GOOGLE_REVIEW_SETTINGS_FIELD_MAP,
  googleReviewsCacheToPgRow, googleReviewsCacheToFirestoreObj, GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS, GOOGLE_REVIEWS_CACHE_FIELD_MAP,
  googleBizTokensToPgRow, googleBizTokensToFirestoreObj, GOOGLE_BIZ_TOKENS_JSONB_COLUMNS, GOOGLE_BIZ_TOKENS_FIELD_MAP,
  whatsappConfigToPgRow, whatsappConfigToFirestoreObj, WHATSAPP_CONFIG_JSONB_COLUMNS, WHATSAPP_CONFIG_FIELD_MAP,
  whatsappLogToPgRow, whatsappLogToFirestoreObj, WHATSAPP_LOG_JSONB_COLUMNS, WHATSAPP_LOG_FIELD_MAP,
  automationToPgRow, automationToFirestoreObj, AUTOMATION_JSONB_COLUMNS, AUTOMATION_FIELD_MAP,
  automationTemplateToPgRow, automationTemplateToFirestoreObj, AUTOMATION_TEMPLATE_JSONB_COLUMNS, AUTOMATION_TEMPLATE_FIELD_MAP,
  automationSettingsToPgRow, automationSettingsToFirestoreObj, AUTOMATION_SETTINGS_JSONB_COLUMNS, AUTOMATION_SETTINGS_FIELD_MAP,
  automationLogToPgRow, automationLogToFirestoreObj, AUTOMATION_LOG_JSONB_COLUMNS, AUTOMATION_LOG_FIELD_MAP,
} = require('./aiAutomationFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — system & misc
// ═══════════════════════════════════════════════════════════════════════════
const {
  // GROUP A: Supply Chain
  supplierToPgRow, supplierToFirestoreObj, SUPPLIER_JSONB_COLUMNS, SUPPLIER_FIELD_MAP,
  poToPgRow, poToFirestoreObj, PO_JSONB_COLUMNS, PO_FIELD_MAP,
  requisitionToPgRow, requisitionToFirestoreObj, REQUISITION_JSONB_COLUMNS, REQUISITION_FIELD_MAP,
  grnToPgRow, grnToFirestoreObj, GRN_JSONB_COLUMNS, GRN_FIELD_MAP,
  supplierReturnToPgRow, supplierReturnToFirestoreObj, SUPPLIER_RETURN_JSONB_COLUMNS, SUPPLIER_RETURN_FIELD_MAP,
  stockTransferToPgRow, stockTransferToFirestoreObj, STOCK_TRANSFER_JSONB_COLUMNS, STOCK_TRANSFER_FIELD_MAP,
  supplierPerfToPgRow, supplierPerfToFirestoreObj, SUPPLIER_PERF_JSONB_COLUMNS, SUPPLIER_PERF_FIELD_MAP,
  supplierInvoiceToPgRow, supplierInvoiceToFirestoreObj, SUPPLIER_INVOICE_JSONB_COLUMNS, SUPPLIER_INVOICE_FIELD_MAP,
  // GROUP B: Inventory & Production (systemMisc versions — used as fallback only)
  stockAuditToPgRow, stockAuditToFirestoreObj, STOCK_AUDIT_JSONB_COLUMNS, STOCK_AUDIT_FIELD_MAP,
  productionEntryToPgRow, productionEntryToFirestoreObj, PRODUCTION_ENTRY_JSONB_COLUMNS, PRODUCTION_ENTRY_FIELD_MAP,
  // GROUP C: Feedback & Customer
  feedbackFormToPgRow, feedbackFormToFirestoreObj, FEEDBACK_FORM_JSONB_COLUMNS, FEEDBACK_FORM_FIELD_MAP,
  feedbackResponseToPgRow, feedbackResponseToFirestoreObj, FEEDBACK_RESPONSE_JSONB_COLUMNS, FEEDBACK_RESPONSE_FIELD_MAP,
  customerGroupToPgRow, customerGroupToFirestoreObj, CUSTOMER_GROUP_JSONB_COLUMNS, CUSTOMER_GROUP_FIELD_MAP,
  // GROUP D: Booking & Space
  bookingToPgRow, bookingToFirestoreObj, BOOKING_JSONB_COLUMNS, BOOKING_FIELD_MAP,
  spaceBookingToPgRow, spaceBookingToFirestoreObj, SPACE_BOOKING_JSONB_COLUMNS, SPACE_BOOKING_FIELD_MAP,
  // GROUP E: Parking
  parkingConfigToPgRow, parkingConfigToFirestoreObj, PARKING_CONFIG_JSONB_COLUMNS, PARKING_CONFIG_FIELD_MAP,
  parkingZoneToPgRow, parkingZoneToFirestoreObj, PARKING_ZONE_JSONB_COLUMNS, PARKING_ZONE_FIELD_MAP,
  parkingSlotToPgRow, parkingSlotToFirestoreObj, PARKING_SLOT_JSONB_COLUMNS, PARKING_SLOT_FIELD_MAP,
  parkingTicketToPgRow, parkingTicketToFirestoreObj, PARKING_TICKET_JSONB_COLUMNS, PARKING_TICKET_FIELD_MAP,
  parkingRateToPgRow, parkingRateToFirestoreObj, PARKING_RATE_JSONB_COLUMNS, PARKING_RATE_FIELD_MAP,
  // GROUP F: Settings
  restaurantSettingsToPgRow, restaurantSettingsToFirestoreObj, RESTAURANT_SETTINGS_JSONB_COLUMNS, RESTAURANT_SETTINGS_FIELD_MAP,
  discountSettingsToPgRow, discountSettingsToFirestoreObj, DISCOUNT_SETTINGS_JSONB_COLUMNS, DISCOUNT_SETTINGS_FIELD_MAP,
  // GROUP G: Payment & Billing
  paymentToPgRow: smPaymentToPgRow, paymentToFirestoreObj: smPaymentToFirestoreObj, PAYMENT_JSONB_COLUMNS: SM_PAYMENT_JSONB_COLUMNS, PAYMENT_FIELD_MAP: SM_PAYMENT_FIELD_MAP,
  razorpayTokenToPgRow, razorpayTokenToFirestoreObj, RAZORPAY_TOKEN_JSONB_COLUMNS, RAZORPAY_TOKEN_FIELD_MAP,
  dodoOrderToPgRow, dodoOrderToFirestoreObj, DODO_ORDER_JSONB_COLUMNS, DODO_ORDER_FIELD_MAP,
  dodoBillingToPgRow, dodoBillingToFirestoreObj, DODO_BILLING_JSONB_COLUMNS, DODO_BILLING_FIELD_MAP,
  dodoRefundToPgRow, dodoRefundToFirestoreObj, DODO_REFUND_JSONB_COLUMNS, DODO_REFUND_FIELD_MAP,
  dodoDisputeToPgRow, dodoDisputeToFirestoreObj, DODO_DISPUTE_JSONB_COLUMNS, DODO_DISPUTE_FIELD_MAP,
  dodoWebhookToPgRow, dodoWebhookToFirestoreObj, DODO_WEBHOOK_JSONB_COLUMNS, DODO_WEBHOOK_FIELD_MAP,
  dineWebhookToPgRow, dineWebhookToFirestoreObj, DINE_WEBHOOK_JSONB_COLUMNS, DINE_WEBHOOK_FIELD_MAP,
  // GROUP H: Cart & Idempotency
  savedCartToPgRow, savedCartToFirestoreObj, SAVED_CART_JSONB_COLUMNS, SAVED_CART_FIELD_MAP,
  idempotencyKeyToPgRow, idempotencyKeyToFirestoreObj, IDEMPOTENCY_KEY_JSONB_COLUMNS, IDEMPOTENCY_KEY_FIELD_MAP,
  // GROUP I: Security
  blockedIpToPgRow, blockedIpToFirestoreObj, BLOCKED_IP_JSONB_COLUMNS, BLOCKED_IP_FIELD_MAP,
  securityLogToPgRow, securityLogToFirestoreObj, SECURITY_LOG_JSONB_COLUMNS, SECURITY_LOG_FIELD_MAP,
  rateLimitToPgRow, rateLimitToFirestoreObj, RATE_LIMIT_JSONB_COLUMNS, RATE_LIMIT_FIELD_MAP,
  publicToolUsageToPgRow, publicToolUsageToFirestoreObj, PUBLIC_TOOL_USAGE_JSONB_COLUMNS, PUBLIC_TOOL_USAGE_FIELD_MAP,
  systemConfigToPgRow, systemConfigToFirestoreObj, SYSTEM_CONFIG_JSONB_COLUMNS, SYSTEM_CONFIG_FIELD_MAP,
  // GROUP J: Auth & OTP
  emailOtpToPgRow, emailOtpToFirestoreObj, EMAIL_OTP_JSONB_COLUMNS, EMAIL_OTP_FIELD_MAP,
  otpVerificationToPgRow, otpVerificationToFirestoreObj, OTP_VERIFICATION_JSONB_COLUMNS, OTP_VERIFICATION_FIELD_MAP,
  demoRequestToPgRow, demoRequestToFirestoreObj, DEMO_REQUEST_JSONB_COLUMNS, DEMO_REQUEST_FIELD_MAP,
  // GROUP K: AI & Chatbot
  chatbotConvToPgRow, chatbotConvToFirestoreObj, CHATBOT_CONV_JSONB_COLUMNS, CHATBOT_CONV_FIELD_MAP,
  conversationToPgRow, conversationToFirestoreObj, CONVERSATION_JSONB_COLUMNS, CONVERSATION_FIELD_MAP,
  ragKnowledgeToPgRow, ragKnowledgeToFirestoreObj, RAG_KNOWLEDGE_JSONB_COLUMNS, RAG_KNOWLEDGE_FIELD_MAP,
  tokenUsageToPgRow, tokenUsageToFirestoreObj, TOKEN_USAGE_JSONB_COLUMNS, TOKEN_USAGE_FIELD_MAP,
  queryCacheToPgRow, queryCacheToFirestoreObj, QUERY_CACHE_JSONB_COLUMNS, QUERY_CACHE_FIELD_MAP,
  // GROUP L: Bar Inventory (systemMisc versions — inventory versions preferred)
  barBottleToPgRow, barBottleToFirestoreObj, BAR_BOTTLE_JSONB_COLUMNS,
  barReconciliationToPgRow, barReconciliationToFirestoreObj, BAR_RECONCILIATION_JSONB_COLUMNS,
  // GROUP M: Staff & Scheduling (systemMisc versions — register version preferred)
  staffAvailabilityToPgRow, staffAvailabilityToFirestoreObj, STAFF_AVAILABILITY_JSONB_COLUMNS,
  staffLocationToPgRow, staffLocationToFirestoreObj, STAFF_LOCATION_JSONB_COLUMNS, STAFF_LOCATION_FIELD_MAP,
  staffLocationLatestToPgRow, staffLocationLatestToFirestoreObj, STAFF_LOCATION_LATEST_JSONB_COLUMNS, STAFF_LOCATION_LATEST_FIELD_MAP,
  // GROUP N: Miscellaneous
  invoiceToPgRow: smInvoiceToPgRow, invoiceToFirestoreObj: smInvoiceToFirestoreObj, INVOICE_JSONB_COLUMNS: SM_INVOICE_JSONB_COLUMNS, INVOICE_FIELD_MAP: SM_INVOICE_FIELD_MAP,
  discountApprovalToPgRow, discountApprovalToFirestoreObj, DISCOUNT_APPROVAL_JSONB_COLUMNS, DISCOUNT_APPROVAL_FIELD_MAP,
  ownerPrefToPgRow, ownerPrefToFirestoreObj, OWNER_PREF_JSONB_COLUMNS, OWNER_PREF_FIELD_MAP,
  taxSettingsToPgRow, taxSettingsToFirestoreObj, TAX_SETTINGS_JSONB_COLUMNS, TAX_SETTINGS_FIELD_MAP,
  staffToPgRow: smStaffToPgRow, staffToFirestoreObj: smStaffToFirestoreObj, STAFF_JSONB_COLUMNS: SM_STAFF_JSONB_COLUMNS, STAFF_FIELD_MAP: SM_STAFF_FIELD_MAP,
  couponToPgRow, couponToFirestoreObj, COUPON_JSONB_COLUMNS, COUPON_FIELD_MAP,
  menuBulkDeleteLogToPgRow, menuBulkDeleteLogToFirestoreObj, MENU_BULK_DELETE_LOG_JSONB_COLUMNS, MENU_BULK_DELETE_LOG_FIELD_MAP,
  aggregatorWebhookLogToPgRow, aggregatorWebhookLogToFirestoreObj, AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS, AGGREGATOR_WEBHOOK_LOG_FIELD_MAP,
  whatsappOrderLogToPgRow, whatsappOrderLogToFirestoreObj, WHATSAPP_ORDER_LOG_JSONB_COLUMNS, WHATSAPP_ORDER_LOG_FIELD_MAP,
  d365SyncLogToPgRow, d365SyncLogToFirestoreObj, D365_SYNC_LOG_JSONB_COLUMNS, D365_SYNC_LOG_FIELD_MAP,
} = require('./systemMiscFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — auth & menu
// ═══════════════════════════════════════════════════════════════════════════
const {
  MENU_FIELD_MAP, menuToPgRow, menuToFirestoreObj, MENU_JSONB_COLUMNS,
  MENU_ITEM_FIELD_MAP, menuItemToPgRow, menuItemToFirestoreObj, MENU_ITEM_JSONB_COLUMNS,
  APP_USER_FIELD_MAP, appUserToPgRow, appUserToFirestoreObj, APP_USER_JSONB_COLUMNS,
  USER_RESTAURANT_FIELD_MAP, userRestaurantToPgRow, userRestaurantToFirestoreObj, USER_RESTAURANT_JSONB_COLUMNS,
  STAFF_CREDENTIAL_FIELD_MAP, staffCredentialToPgRow, staffCredentialToFirestoreObj, STAFF_CREDENTIAL_JSONB_COLUMNS,
  DINE_USER_DATA_FIELD_MAP, dineUserDataToPgRow, dineUserDataToFirestoreObj, DINE_USER_DATA_JSONB_COLUMNS,
} = require('./authMenuFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Imports — print diagnostics telemetry
// ═══════════════════════════════════════════════════════════════════════════
const {
  PRINT_DIAG_FIELD_MAP,
  PRINT_DIAG_JSONB_COLUMNS,
  printDiagToPgRow,
  printDiagToFirestoreObj,
} = require('./printDiagnosticsFieldMapper');

// ═══════════════════════════════════════════════════════════════════════════
// Counter identity helpers (counters use counterRepo atomic ops)
// ═══════════════════════════════════════════════════════════════════════════
const counterIdentity = (obj) => obj;
const COUNTER_JSONB = new Set(['extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// Generic identity + JSONB set (for simple collections with no field mapper)
// ═══════════════════════════════════════════════════════════════════════════
const GENERIC_JSONB = new Set(['extra_data']);

// ═══════════════════════════════════════════════════════════════════════════
// Registry — Firestore collection name → PG table config
// ═══════════════════════════════════════════════════════════════════════════
const REGISTRY = {
  // ── orders ──────────────────────────────────────────────────────────────
  'orders': { table: 'orders', fieldMap: ORDER_FIELD_MAP, toPgRow: orderToPgRow, toFirestoreObj: orderToFirestoreObj, jsonbCols: ORDER_JSONB_COLUMNS },

  // ── restaurants ─────────────────────────────────────────────────────────
  'restaurants': { table: 'restaurants', fieldMap: REST_FIELD_MAP, toPgRow: restToPgRow, toFirestoreObj: restToFirestoreObj, jsonbCols: REST_JSONB_COLUMNS, cacheTTL: 180 },

  // ── inventory (from inventoryFieldMapper — preferred, has FIELD_MAP) ───
  'inventory':              { table: 'inventory',              fieldMap: invFM.inventory.FIELD_MAP,              toPgRow: invFM.inventory.toPgRow,              toFirestoreObj: invFM.inventory.toFirestoreObj,              jsonbCols: invFM.inventory.JSONB_COLUMNS, cacheTTL: 30 },
  'inventoryCategories':    { table: 'inventory_categories',   fieldMap: {},                                             toPgRow: counterIdentity,                               toFirestoreObj: counterIdentity,                               jsonbCols: GENERIC_JSONB },
  'inventoryTransactions':  { table: 'inventory_transactions', fieldMap: invFM.inventoryTransactions.FIELD_MAP, toPgRow: invFM.inventoryTransactions.toPgRow, toFirestoreObj: invFM.inventoryTransactions.toFirestoreObj, jsonbCols: invFM.inventoryTransactions.JSONB_COLUMNS },
  'stockBatches':           { table: 'stock_batches',          fieldMap: invFM.stockBatches.FIELD_MAP,          toPgRow: invFM.stockBatches.toPgRow,          toFirestoreObj: invFM.stockBatches.toFirestoreObj,          jsonbCols: invFM.stockBatches.JSONB_COLUMNS },
  'wasteEntries':           { table: 'waste_entries',          fieldMap: invFM.wasteEntries.FIELD_MAP,          toPgRow: invFM.wasteEntries.toPgRow,          toFirestoreObj: invFM.wasteEntries.toFirestoreObj,          jsonbCols: invFM.wasteEntries.JSONB_COLUMNS },
  'waste_entries':          { table: 'waste_entries',          fieldMap: invFM.wasteEntries.FIELD_MAP,          toPgRow: invFM.wasteEntries.toPgRow,          toFirestoreObj: invFM.wasteEntries.toFirestoreObj,          jsonbCols: invFM.wasteEntries.JSONB_COLUMNS },
  'recipes':                { table: 'recipes',                fieldMap: invFM.recipes.FIELD_MAP,               toPgRow: invFM.recipes.toPgRow,               toFirestoreObj: invFM.recipes.toFirestoreObj,               jsonbCols: invFM.recipes.JSONB_COLUMNS },
  'barBottles':             { table: 'bar_bottles',            fieldMap: invFM.barBottles.FIELD_MAP,            toPgRow: invFM.barBottles.toPgRow,            toFirestoreObj: invFM.barBottles.toFirestoreObj,            jsonbCols: invFM.barBottles.JSONB_COLUMNS },
  'barReconciliation':      { table: 'bar_reconciliation',     fieldMap: invFM.barReconciliation.FIELD_MAP,     toPgRow: invFM.barReconciliation.toPgRow,     toFirestoreObj: invFM.barReconciliation.toFirestoreObj,     jsonbCols: invFM.barReconciliation.JSONB_COLUMNS },

  // ── dailyStats ──────────────────────────────────────────────────────────
  'dailyStats': { table: 'daily_stats', fieldMap: DS_FIELD_MAP, toPgRow: dsToPgRow, toFirestoreObj: dsToFirestoreObj, jsonbCols: DS_JSONB_COLUMNS, resolveKeyPath: dsResolveKeyPath },

  // ── floors & tables ─────────────────────────────────────────────────────
  'floors': { table: 'floors', fieldMap: FLOOR_FIELD_MAP, toPgRow: floorToPgRow, toFirestoreObj: floorToFirestoreObj, jsonbCols: FT_JSONB_COLUMNS, cacheTTL: 60 },
  'tables': { table: 'tables', fieldMap: TABLE_FIELD_MAP, toPgRow: tableToPgRow, toFirestoreObj: tableToFirestoreObj, jsonbCols: FT_JSONB_COLUMNS, cacheTTL: 60 },

  // ── customers ───────────────────────────────────────────────────────────
  'customers': { table: 'customers', fieldMap: CUST_FIELD_MAP, toPgRow: custToPgRow, toFirestoreObj: custToFirestoreObj, jsonbCols: CUST_JSONB_COLUMNS },

  // ── offers ──────────────────────────────────────────────────────────────
  'offers': { table: 'offers', fieldMap: OFFER_FIELD_MAP, toPgRow: offerToPgRow, toFirestoreObj: offerToFirestoreObj, jsonbCols: OFFER_JSONB_COLUMNS, cacheTTL: 120 },

  // ── dine payments / subscriptions / razorpay orders ─────────────────────
  'dine_payments':         { table: 'dine_payments',         fieldMap: PAYMENTS_FIELD_MAP,      toPgRow: paymentsToPgRow,         toFirestoreObj: paymentsToFirestoreObj,         jsonbCols: PAYMENTS_JSONB_COLUMNS },
  'dine_subscriptions':    { table: 'dine_subscriptions',    fieldMap: SUBSCRIPTIONS_FIELD_MAP, toPgRow: subscriptionsToPgRow,    toFirestoreObj: subscriptionsToFirestoreObj,    jsonbCols: SUBSCRIPTIONS_JSONB_COLUMNS },
  'dine_razorpay_orders':  { table: 'dine_razorpay_orders',  fieldMap: RZP_ORDERS_FIELD_MAP,    toPgRow: rzpOrdersToPgRow,        toFirestoreObj: rzpOrdersToFirestoreObj,        jsonbCols: RZP_ORDERS_JSONB_COLUMNS },
  'dine_orders':           { table: 'dine_orders',           fieldMap: {},                      toPgRow: counterIdentity,         toFirestoreObj: counterIdentity,               jsonbCols: GENERIC_JSONB },
  'subscriptions':         { table: 'dine_subscriptions',    fieldMap: SUBSCRIPTIONS_FIELD_MAP, toPgRow: subscriptionsToPgRow,    toFirestoreObj: subscriptionsToFirestoreObj,    jsonbCols: SUBSCRIPTIONS_JSONB_COLUMNS },

  // ── cash registers & shifts ─────────────────────────────────────────────
  'cashRegisters':           { table: 'cash_registers',           fieldMap: REGISTER_FIELD_MAP,       toPgRow: registerToPgRow,       toFirestoreObj: registerToFirestoreObj,       jsonbCols: REGISTER_JSONB_COLUMNS },
  'shifts':                  { table: 'shifts',                   fieldMap: SHIFT_FIELD_MAP,          toPgRow: shiftToPgRow,          toFirestoreObj: shiftToFirestoreObj,          jsonbCols: SHIFT_JSONB_COLUMNS },
  'restaurantShiftSettings': { table: 'restaurant_shift_settings', fieldMap: SHIFT_SETTINGS_FIELD_MAP, toPgRow: shiftSettingsToPgRow, toFirestoreObj: shiftSettingsToFirestoreObj, jsonbCols: SHIFT_SETTINGS_JSONB_COLUMNS },
  'staffShifts':             { table: 'staff_shifts',             fieldMap: STAFF_SHIFT_FIELD_MAP,    toPgRow: staffShiftToPgRow,     toFirestoreObj: staffShiftToFirestoreObj,     jsonbCols: STAFF_SHIFT_JSONB_COLUMNS },
  'staffAvailability':       { table: 'staff_availability',       fieldMap: STAFF_AVAIL_FIELD_MAP,    toPgRow: staffAvailToPgRow,     toFirestoreObj: staffAvailToFirestoreObj,     jsonbCols: STAFF_AVAIL_JSONB_COLUMNS },

  // ── staff HR ────────────────────────────────────────────────────────────
  'staffUsers':     { table: 'staff_users',     fieldMap: SHR_STAFF_FIELD_MAP,    toPgRow: shrStaffToPgRow,       toFirestoreObj: shrStaffToFirestoreObj,       jsonbCols: SHR_STAFF_JSONB_COLUMNS, cacheTTL: 120 },
  'attendance':     { table: 'attendance',       fieldMap: ATTENDANCE_FIELD_MAP,   toPgRow: attendanceToPgRow,     toFirestoreObj: attendanceToFirestoreObj,     jsonbCols: ATTENDANCE_JSONB_COLUMNS },
  'leaveRequests':  { table: 'leave_requests',   fieldMap: LEAVE_REQUEST_FIELD_MAP, toPgRow: leaveRequestToPgRow,  toFirestoreObj: leaveRequestToFirestoreObj,  jsonbCols: LEAVE_REQUEST_JSONB_COLUMNS },
  'leaveConfig':    { table: 'leave_config',     fieldMap: LEAVE_CONFIG_FIELD_MAP,  toPgRow: leaveConfigToPgRow,   toFirestoreObj: leaveConfigToFirestoreObj,   jsonbCols: LEAVE_CONFIG_JSONB_COLUMNS },
  'leaveBalances':  { table: 'leave_balances',   fieldMap: LEAVE_BALANCE_FIELD_MAP, toPgRow: leaveBalanceToPgRow,  toFirestoreObj: leaveBalanceToFirestoreObj,  jsonbCols: LEAVE_BALANCE_JSONB_COLUMNS },
  'payrollConfig':  { table: 'payroll_config',   fieldMap: PAYROLL_CONFIG_FIELD_MAP, toPgRow: payrollConfigToPgRow, toFirestoreObj: payrollConfigToFirestoreObj, jsonbCols: PAYROLL_CONFIG_JSONB_COLUMNS },
  'payrollRuns':    { table: 'payroll_runs',     fieldMap: PAYROLL_RUN_FIELD_MAP,   toPgRow: payrollRunToPgRow,    toFirestoreObj: payrollRunToFirestoreObj,    jsonbCols: PAYROLL_RUN_JSONB_COLUMNS },
  'paySlips':       { table: 'pay_slips',        fieldMap: PAY_SLIP_FIELD_MAP,      toPgRow: paySlipToPgRow,       toFirestoreObj: paySlipToFirestoreObj,       jsonbCols: PAY_SLIP_JSONB_COLUMNS },

  // ── accounting ──────────────────────────────────────────────────────────
  'chartOfAccounts': { table: 'chart_of_accounts', fieldMap: COA_FIELD_MAP, toPgRow: coaToPgRow, toFirestoreObj: coaToFirestoreObj, jsonbCols: COA_JSONB_COLUMNS },
  'journalEntries':  { table: 'journal_entries',   fieldMap: JE_FIELD_MAP,  toPgRow: jeToPgRow,  toFirestoreObj: jeToFirestoreObj,  jsonbCols: JE_JSONB_COLUMNS },
  'expenses':        { table: 'expenses',          fieldMap: EXP_FIELD_MAP, toPgRow: expToPgRow, toFirestoreObj: expToFirestoreObj, jsonbCols: EXP_JSONB_COLUMNS },

  // ── hotel & bookings ────────────────────────────────────────────────────
  'rooms':                        { table: 'hotel_rooms',                 fieldMap: ROOM_FIELD_MAP,             toPgRow: roomToPgRow,             toFirestoreObj: roomToFirestoreObj,             jsonbCols: ROOM_JSONB_COLUMNS },
  'hotel_bookings':               { table: 'hotel_bookings',              fieldMap: HOTEL_BOOKING_FIELD_MAP,    toPgRow: hotelBookingToPgRow,     toFirestoreObj: hotelBookingToFirestoreObj,     jsonbCols: HOTEL_BOOKING_JSONB_COLUMNS },
  'hotel_checkins':               { table: 'hotel_checkins',              fieldMap: HOTEL_CHECKIN_FIELD_MAP,    toPgRow: hotelCheckinToPgRow,     toFirestoreObj: hotelCheckinToFirestoreObj,     jsonbCols: HOTEL_CHECKIN_JSONB_COLUMNS },
  'hotel_guests':                 { table: 'hotel_guests',                fieldMap: HOTEL_GUEST_FIELD_MAP,     toPgRow: hotelGuestToPgRow,       toFirestoreObj: hotelGuestToFirestoreObj,       jsonbCols: HOTEL_GUEST_JSONB_COLUMNS },
  'room_maintenance_schedules':   { table: 'room_maintenance_schedules',  fieldMap: ROOM_MAINTENANCE_FIELD_MAP, toPgRow: roomMaintenanceToPgRow, toFirestoreObj: roomMaintenanceToFirestoreObj, jsonbCols: ROOM_MAINTENANCE_JSONB_COLUMNS },
  'pms-rooms':                    { table: 'pms_rooms',                   fieldMap: PMS_ROOM_FIELD_MAP,        toPgRow: pmsRoomToPgRow,          toFirestoreObj: pmsRoomToFirestoreObj,          jsonbCols: PMS_ROOM_JSONB_COLUMNS },
  'pms-bookings':                 { table: 'pms_bookings',                fieldMap: PMS_BOOKING_FIELD_MAP,     toPgRow: pmsBookingToPgRow,       toFirestoreObj: pmsBookingToFirestoreObj,       jsonbCols: PMS_BOOKING_JSONB_COLUMNS },
  'pms-guests':                   { table: 'pms_guests',                  fieldMap: PMS_GUEST_FIELD_MAP,       toPgRow: pmsGuestToPgRow,         toFirestoreObj: pmsGuestToFirestoreObj,         jsonbCols: PMS_GUEST_JSONB_COLUMNS },
  'pms-housekeeping':             { table: 'pms_housekeeping',            fieldMap: PMS_HOUSEKEEPING_FIELD_MAP, toPgRow: pmsHousekeepingToPgRow, toFirestoreObj: pmsHousekeepingToFirestoreObj, jsonbCols: PMS_HOUSEKEEPING_JSONB_COLUMNS },
  'pms-maintenance':              { table: 'pms_maintenance',             fieldMap: PMS_MAINTENANCE_FIELD_MAP, toPgRow: pmsMaintenanceToPgRow,   toFirestoreObj: pmsMaintenanceToFirestoreObj,   jsonbCols: PMS_MAINTENANCE_JSONB_COLUMNS },
  'bookings_v2':                  { table: 'bookings_v2',                 fieldMap: BOOKINGS_V2_FIELD_MAP,     toPgRow: bookingsV2ToPgRow,       toFirestoreObj: bookingsV2ToFirestoreObj,       jsonbCols: BOOKINGS_V2_JSONB_COLUMNS },
  'bookingVenues':                { table: 'booking_venues',              fieldMap: BOOKING_VENUE_FIELD_MAP,   toPgRow: bookingVenueToPgRow,     toFirestoreObj: bookingVenueToFirestoreObj,     jsonbCols: BOOKING_VENUE_JSONB_COLUMNS },
  'booking_venues':               { table: 'booking_venues',              fieldMap: BOOKING_VENUE_FIELD_MAP,   toPgRow: bookingVenueToPgRow,     toFirestoreObj: bookingVenueToFirestoreObj,     jsonbCols: BOOKING_VENUE_JSONB_COLUMNS },
  'booking-venues':               { table: 'booking_venues',              fieldMap: BOOKING_VENUE_FIELD_MAP,   toPgRow: bookingVenueToPgRow,     toFirestoreObj: bookingVenueToFirestoreObj,     jsonbCols: BOOKING_VENUE_JSONB_COLUMNS },

  // ── invoice module ──────────────────────────────────────────────────────
  'inv_organizations':    { table: 'inv_organizations',    fieldMap: INV_ORG_FIELD_MAP,     toPgRow: invOrgToPgRow,      toFirestoreObj: invOrgToFirestoreObj,      jsonbCols: INV_ORG_JSONB_COLUMNS },
  'inv_customers':        { table: 'inv_customers',        fieldMap: INV_CUST_FIELD_MAP,    toPgRow: invCustToPgRow,     toFirestoreObj: invCustToFirestoreObj,     jsonbCols: INV_CUST_JSONB_COLUMNS },
  'inv_items':            { table: 'inv_items',            fieldMap: INV_ITEM_FIELD_MAP,    toPgRow: invItemToPgRow,     toFirestoreObj: invItemToFirestoreObj,     jsonbCols: INV_ITEM_JSONB_COLUMNS },
  'inv_invoices':         { table: 'inv_invoices',         fieldMap: INV_INVOICE_FIELD_MAP, toPgRow: invInvoiceToPgRow,  toFirestoreObj: invInvoiceToFirestoreObj,  jsonbCols: INV_INVOICE_JSONB_COLUMNS },
  'inv_quotes':           { table: 'inv_quotes',           fieldMap: QUOTE_FIELD_MAP,       toPgRow: quoteToPgRow,       toFirestoreObj: quoteToFirestoreObj,       jsonbCols: QUOTE_JSONB_COLUMNS },
  'inv_challans':         { table: 'inv_challans',         fieldMap: CHALLAN_FIELD_MAP,     toPgRow: challanToPgRow,     toFirestoreObj: challanToFirestoreObj,     jsonbCols: CHALLAN_JSONB_COLUMNS },
  'inv_payments':         { table: 'inv_payments',         fieldMap: INV_PAYMENT_FIELD_MAP, toPgRow: invPaymentToPgRow,  toFirestoreObj: invPaymentToFirestoreObj,  jsonbCols: INV_PAYMENT_JSONB_COLUMNS },
  'inv_expenses':         { table: 'inv_expenses',         fieldMap: INV_EXPENSE_FIELD_MAP, toPgRow: invExpenseToPgRow,  toFirestoreObj: invExpenseToFirestoreObj,  jsonbCols: INV_EXPENSE_JSONB_COLUMNS },
  'inv_settings':         { table: 'inv_settings',         fieldMap: SETTINGS_FIELD_MAP,    toPgRow: settingsToPgRow,    toFirestoreObj: settingsToFirestoreObj,    jsonbCols: SETTINGS_JSONB_COLUMNS },
  'inv_number_sequences': { table: 'inv_number_sequences', fieldMap: NUMBER_SEQ_FIELD_MAP,  toPgRow: numberSeqToPgRow,   toFirestoreObj: numberSeqToFirestoreObj,   jsonbCols: NUMBER_SEQ_JSONB_COLUMNS },

  // ── enterprise ──────────────────────────────────────────────────────────
  'organizations':     { table: 'ent_organizations',  fieldMap: ENT_ORG_FIELD_MAP,           toPgRow: entOrgToPgRow,           toFirestoreObj: entOrgToFirestoreObj,           jsonbCols: ENT_ORG_JSONB_COLUMNS },
  'orgMenuTemplates':  { table: 'org_menu_templates', fieldMap: MENU_TEMPLATE_FIELD_MAP,     toPgRow: menuTemplateToPgRow,     toFirestoreObj: menuTemplateToFirestoreObj,     jsonbCols: MENU_TEMPLATE_JSONB_COLUMNS },
  'orgMenuItems':      { table: 'org_menu_items',     fieldMap: ENT_MENU_ITEM_FIELD_MAP,     toPgRow: entMenuItemToPgRow,      toFirestoreObj: entMenuItemToFirestoreObj,      jsonbCols: ENT_MENU_ITEM_JSONB_COLUMNS },
  'indentRequests':    { table: 'indent_requests',    fieldMap: INDENT_FIELD_MAP,            toPgRow: indentToPgRow,           toFirestoreObj: indentToFirestoreObj,           jsonbCols: INDENT_JSONB_COLUMNS },
  'productionOrders':  { table: 'production_orders',  fieldMap: PRODUCTION_ORDER_FIELD_MAP,  toPgRow: productionOrderToPgRow,  toFirestoreObj: productionOrderToFirestoreObj,  jsonbCols: PRODUCTION_ORDER_JSONB_COLUMNS },
  'distributionPlans': { table: 'distribution_plans', fieldMap: DISTRIBUTION_PLAN_FIELD_MAP, toPgRow: distributionPlanToPgRow, toFirestoreObj: distributionPlanToFirestoreObj, jsonbCols: DISTRIBUTION_PLAN_JSONB_COLUMNS },
  'orgSettings':       { table: 'org_settings',       fieldMap: ORG_SETTINGS_FIELD_MAP,      toPgRow: orgSettingsToPgRow,      toFirestoreObj: orgSettingsToFirestoreObj,      jsonbCols: ORG_SETTINGS_JSONB_COLUMNS },
  'orgAuditLog':       { table: 'org_audit_log',      fieldMap: AUDIT_LOG_FIELD_MAP,         toPgRow: auditLogToPgRow,         toFirestoreObj: auditLogToFirestoreObj,         jsonbCols: AUDIT_LOG_JSONB_COLUMNS },

  // ── AI & automation ─────────────────────────────────────────────────────
  'bolnaAgents':                { table: 'bolna_agents',              fieldMap: BOLNA_AGENT_FIELD_MAP, toPgRow: bolnaAgentToPgRow,           toFirestoreObj: bolnaAgentToFirestoreObj,           jsonbCols: BOLNA_AGENT_JSONB_COLUMNS },
  'phoneCalls':                 { table: 'phone_calls',              fieldMap: PHONE_CALL_FIELD_MAP, toPgRow: phoneCallToPgRow,            toFirestoreObj: phoneCallToFirestoreObj,            jsonbCols: PHONE_CALL_JSONB_COLUMNS },
  'dineai_settings':            { table: 'dineai_settings',          fieldMap: DINEAI_SETTINGS_FIELD_MAP, toPgRow: dineaiSettingsToPgRow,       toFirestoreObj: dineaiSettingsToFirestoreObj,       jsonbCols: DINEAI_SETTINGS_JSONB_COLUMNS },
  'dineai_usage':               { table: 'dineai_usage',            fieldMap: DINEAI_USAGE_FIELD_MAP, toPgRow: dineaiUsageToPgRow,          toFirestoreObj: dineaiUsageToFirestoreObj,          jsonbCols: DINEAI_USAGE_JSONB_COLUMNS },
  'dineai_knowledge':           { table: 'dineai_knowledge',        fieldMap: DINEAI_KNOWLEDGE_FIELD_MAP, toPgRow: dineaiKnowledgeToPgRow,      toFirestoreObj: dineaiKnowledgeToFirestoreObj,      jsonbCols: DINEAI_KNOWLEDGE_JSONB_COLUMNS },
  'dineai_realtime_sessions':   { table: 'dineai_realtime_sessions', fieldMap: DINEAI_RT_SESSION_FIELD_MAP, toPgRow: dineaiRtSessionToPgRow,     toFirestoreObj: dineaiRtSessionToFirestoreObj,     jsonbCols: DINEAI_RT_SESSION_JSONB_COLUMNS },
  'dineai_cheap_sessions':      { table: 'dineai_cheap_sessions',   fieldMap: DINEAI_CHEAP_SESSION_FIELD_MAP, toPgRow: dineaiCheapSessionToPgRow,   toFirestoreObj: dineaiCheapSessionToFirestoreObj,   jsonbCols: DINEAI_CHEAP_SESSION_JSONB_COLUMNS },
  'chatgptUsage':               { table: 'chatgpt_usage',           fieldMap: CHATGPT_USAGE_FIELD_MAP, toPgRow: chatgptUsageToPgRow,         toFirestoreObj: chatgptUsageToFirestoreObj,         jsonbCols: CHATGPT_USAGE_JSONB_COLUMNS },
  'aiUsage':                    { table: 'ai_usage',                fieldMap: AI_USAGE_FIELD_MAP, toPgRow: aiUsageToPgRow,              toFirestoreObj: aiUsageToFirestoreObj,              jsonbCols: AI_USAGE_JSONB_COLUMNS },
  'aiInsightsUsage':            { table: 'ai_insights_usage',       fieldMap: AI_INSIGHTS_USAGE_FIELD_MAP, toPgRow: aiInsightsUsageToPgRow,      toFirestoreObj: aiInsightsUsageToFirestoreObj,      jsonbCols: AI_INSIGHTS_USAGE_JSONB_COLUMNS },
  'googleReviewSettings':       { table: 'google_review_settings',  fieldMap: GOOGLE_REVIEW_SETTINGS_FIELD_MAP, toPgRow: googleReviewSettingsToPgRow, toFirestoreObj: googleReviewSettingsToFirestoreObj, jsonbCols: GOOGLE_REVIEW_SETTINGS_JSONB_COLUMNS },
  'googleReviewsCache':         { table: 'google_reviews_cache',    fieldMap: GOOGLE_REVIEWS_CACHE_FIELD_MAP, toPgRow: googleReviewsCacheToPgRow,   toFirestoreObj: googleReviewsCacheToFirestoreObj,   jsonbCols: GOOGLE_REVIEWS_CACHE_JSONB_COLUMNS },
  'googleBusinessTokens':       { table: 'google_business_tokens',  fieldMap: GOOGLE_BIZ_TOKENS_FIELD_MAP, toPgRow: googleBizTokensToPgRow,      toFirestoreObj: googleBizTokensToFirestoreObj,      jsonbCols: GOOGLE_BIZ_TOKENS_JSONB_COLUMNS },
  'whatsappOrderingConfig':     { table: 'whatsapp_ordering_config', fieldMap: WHATSAPP_CONFIG_FIELD_MAP, toPgRow: whatsappConfigToPgRow,      toFirestoreObj: whatsappConfigToFirestoreObj,      jsonbCols: WHATSAPP_CONFIG_JSONB_COLUMNS },
  'whatsappConversationLogs':   { table: 'whatsapp_conversation_logs', fieldMap: WHATSAPP_LOG_FIELD_MAP, toPgRow: whatsappLogToPgRow,       toFirestoreObj: whatsappLogToFirestoreObj,         jsonbCols: WHATSAPP_LOG_JSONB_COLUMNS },
  'automations':                { table: 'automations',             fieldMap: AUTOMATION_FIELD_MAP, toPgRow: automationToPgRow,           toFirestoreObj: automationToFirestoreObj,           jsonbCols: AUTOMATION_JSONB_COLUMNS },
  'automation-templates':       { table: 'automation_templates',    fieldMap: AUTOMATION_TEMPLATE_FIELD_MAP, toPgRow: automationTemplateToPgRow,   toFirestoreObj: automationTemplateToFirestoreObj,   jsonbCols: AUTOMATION_TEMPLATE_JSONB_COLUMNS },
  'automationTemplates':        { table: 'automation_templates',    fieldMap: AUTOMATION_TEMPLATE_FIELD_MAP, toPgRow: automationTemplateToPgRow,   toFirestoreObj: automationTemplateToFirestoreObj,   jsonbCols: AUTOMATION_TEMPLATE_JSONB_COLUMNS },
  'automation-settings':        { table: 'automation_settings',     fieldMap: AUTOMATION_SETTINGS_FIELD_MAP, toPgRow: automationSettingsToPgRow,   toFirestoreObj: automationSettingsToFirestoreObj,   jsonbCols: AUTOMATION_SETTINGS_JSONB_COLUMNS },
  'automation-logs':            { table: 'automation_logs',         fieldMap: AUTOMATION_LOG_FIELD_MAP, toPgRow: automationLogToPgRow,        toFirestoreObj: automationLogToFirestoreObj,        jsonbCols: AUTOMATION_LOG_JSONB_COLUMNS },

  // ── system & misc ───────────────────────────────────────────────────────
  // Supply Chain
  'suppliers':              { table: 'suppliers',             fieldMap: SUPPLIER_FIELD_MAP,         toPgRow: supplierToPgRow,        toFirestoreObj: supplierToFirestoreObj,        jsonbCols: SUPPLIER_JSONB_COLUMNS },
  'purchaseOrders':         { table: 'purchase_orders',       fieldMap: PO_FIELD_MAP,               toPgRow: poToPgRow,              toFirestoreObj: poToFirestoreObj,              jsonbCols: PO_JSONB_COLUMNS },
  'purchase-requisitions':  { table: 'purchase_requisitions', fieldMap: REQUISITION_FIELD_MAP,      toPgRow: requisitionToPgRow,     toFirestoreObj: requisitionToFirestoreObj,     jsonbCols: REQUISITION_JSONB_COLUMNS },
  'goods-receipt-notes':    { table: 'goods_receipt_notes',   fieldMap: GRN_FIELD_MAP,              toPgRow: grnToPgRow,             toFirestoreObj: grnToFirestoreObj,             jsonbCols: GRN_JSONB_COLUMNS },
  'supplier-returns':       { table: 'supplier_returns',      fieldMap: SUPPLIER_RETURN_FIELD_MAP,  toPgRow: supplierReturnToPgRow,  toFirestoreObj: supplierReturnToFirestoreObj,  jsonbCols: SUPPLIER_RETURN_JSONB_COLUMNS },
  'stock-transfers':        { table: 'stock_transfers',       fieldMap: STOCK_TRANSFER_FIELD_MAP,   toPgRow: stockTransferToPgRow,   toFirestoreObj: stockTransferToFirestoreObj,   jsonbCols: STOCK_TRANSFER_JSONB_COLUMNS },
  'supplier-performance':   { table: 'supplier_performance',  fieldMap: SUPPLIER_PERF_FIELD_MAP,    toPgRow: supplierPerfToPgRow,    toFirestoreObj: supplierPerfToFirestoreObj,    jsonbCols: SUPPLIER_PERF_JSONB_COLUMNS },
  'supplier-invoices':      { table: 'supplier_invoices',     fieldMap: SUPPLIER_INVOICE_FIELD_MAP, toPgRow: supplierInvoiceToPgRow, toFirestoreObj: supplierInvoiceToFirestoreObj, jsonbCols: SUPPLIER_INVOICE_JSONB_COLUMNS },

  // Feedback & Customer
  'feedbackForms':     { table: 'feedback_forms',     fieldMap: FEEDBACK_FORM_FIELD_MAP,     toPgRow: feedbackFormToPgRow,     toFirestoreObj: feedbackFormToFirestoreObj,     jsonbCols: FEEDBACK_FORM_JSONB_COLUMNS },
  'feedbackResponses': { table: 'feedback_responses', fieldMap: FEEDBACK_RESPONSE_FIELD_MAP, toPgRow: feedbackResponseToPgRow, toFirestoreObj: feedbackResponseToFirestoreObj, jsonbCols: FEEDBACK_RESPONSE_JSONB_COLUMNS },
  'customerGroups':    { table: 'customer_groups',    fieldMap: CUSTOMER_GROUP_FIELD_MAP,    toPgRow: customerGroupToPgRow,    toFirestoreObj: customerGroupToFirestoreObj,    jsonbCols: CUSTOMER_GROUP_JSONB_COLUMNS },
  'customer-segments': { table: 'customer_groups',    fieldMap: CUSTOMER_GROUP_FIELD_MAP,    toPgRow: customerGroupToPgRow,    toFirestoreObj: customerGroupToFirestoreObj,    jsonbCols: CUSTOMER_GROUP_JSONB_COLUMNS },
  'customerSegments':  { table: 'customer_groups',    fieldMap: CUSTOMER_GROUP_FIELD_MAP,    toPgRow: customerGroupToPgRow,    toFirestoreObj: customerGroupToFirestoreObj,    jsonbCols: CUSTOMER_GROUP_JSONB_COLUMNS },

  // Booking & Space (systemMisc versions)
  // NOTE: the 'booking_venues' / 'bookingVenues' / 'booking-venues' aliases all live in
  // the hotel & bookings section above and point to the `booking_venues` table.
  // The old duplicate here (→ rest_booking_venues) was removed — it silently shadowed
  // the hotel-booking config and split venue data across two tables.
  'bookings':       { table: 'rest_bookings',        fieldMap: BOOKING_FIELD_MAP,       toPgRow: bookingToPgRow,        toFirestoreObj: bookingToFirestoreObj,        jsonbCols: BOOKING_JSONB_COLUMNS },
  'spaceBookings':  { table: 'space_bookings',       fieldMap: SPACE_BOOKING_FIELD_MAP, toPgRow: spaceBookingToPgRow,   toFirestoreObj: spaceBookingToFirestoreObj,   jsonbCols: SPACE_BOOKING_JSONB_COLUMNS },

  // Parking
  'parkingConfigs':  { table: 'parking_configs',  fieldMap: PARKING_CONFIG_FIELD_MAP, toPgRow: parkingConfigToPgRow, toFirestoreObj: parkingConfigToFirestoreObj, jsonbCols: PARKING_CONFIG_JSONB_COLUMNS },
  'parkingZones':    { table: 'parking_zones',    fieldMap: PARKING_ZONE_FIELD_MAP,   toPgRow: parkingZoneToPgRow,   toFirestoreObj: parkingZoneToFirestoreObj,   jsonbCols: PARKING_ZONE_JSONB_COLUMNS },
  'parkingSlots':    { table: 'parking_slots',    fieldMap: PARKING_SLOT_FIELD_MAP,   toPgRow: parkingSlotToPgRow,   toFirestoreObj: parkingSlotToFirestoreObj,   jsonbCols: PARKING_SLOT_JSONB_COLUMNS },
  'parkingTickets':  { table: 'parking_tickets',  fieldMap: PARKING_TICKET_FIELD_MAP, toPgRow: parkingTicketToPgRow, toFirestoreObj: parkingTicketToFirestoreObj, jsonbCols: PARKING_TICKET_JSONB_COLUMNS },
  'parkingRates':    { table: 'parking_rates',    fieldMap: PARKING_RATE_FIELD_MAP,   toPgRow: parkingRateToPgRow,   toFirestoreObj: parkingRateToFirestoreObj,   jsonbCols: PARKING_RATE_JSONB_COLUMNS },

  // Settings
  'restaurantSettings': { table: 'restaurant_settings', fieldMap: RESTAURANT_SETTINGS_FIELD_MAP, toPgRow: restaurantSettingsToPgRow, toFirestoreObj: restaurantSettingsToFirestoreObj, jsonbCols: RESTAURANT_SETTINGS_JSONB_COLUMNS },
  'discountSettings':   { table: 'discount_settings',   fieldMap: DISCOUNT_SETTINGS_FIELD_MAP,   toPgRow: discountSettingsToPgRow,   toFirestoreObj: discountSettingsToFirestoreObj,   jsonbCols: DISCOUNT_SETTINGS_JSONB_COLUMNS },

  // Payment & Billing (generic POS payments, dodo, etc.)
  'payments':                  { table: 'pos_payments',            fieldMap: SM_PAYMENT_FIELD_MAP,     toPgRow: smPaymentToPgRow,      toFirestoreObj: smPaymentToFirestoreObj,      jsonbCols: SM_PAYMENT_JSONB_COLUMNS },
  'razorpay_tokens':           { table: 'razorpay_tokens',         fieldMap: RAZORPAY_TOKEN_FIELD_MAP, toPgRow: razorpayTokenToPgRow,   toFirestoreObj: razorpayTokenToFirestoreObj,   jsonbCols: RAZORPAY_TOKEN_JSONB_COLUMNS },
  'dine_dodo_orders':          { table: 'dine_dodo_orders',        fieldMap: DODO_ORDER_FIELD_MAP,     toPgRow: dodoOrderToPgRow,       toFirestoreObj: dodoOrderToFirestoreObj,       jsonbCols: DODO_ORDER_JSONB_COLUMNS },
  'dine_dodo_billing':         { table: 'dine_dodo_billing',       fieldMap: DODO_BILLING_FIELD_MAP,   toPgRow: dodoBillingToPgRow,     toFirestoreObj: dodoBillingToFirestoreObj,     jsonbCols: DODO_BILLING_JSONB_COLUMNS },
  'dine_dodo_refunds':         { table: 'dine_dodo_refunds',       fieldMap: DODO_REFUND_FIELD_MAP,    toPgRow: dodoRefundToPgRow,      toFirestoreObj: dodoRefundToFirestoreObj,      jsonbCols: DODO_REFUND_JSONB_COLUMNS },
  'dine_dodo_disputes':        { table: 'dine_dodo_disputes',      fieldMap: DODO_DISPUTE_FIELD_MAP,   toPgRow: dodoDisputeToPgRow,     toFirestoreObj: dodoDisputeToFirestoreObj,     jsonbCols: DODO_DISPUTE_JSONB_COLUMNS },
  'dine_dodo_webhook_events':  { table: 'dine_dodo_webhook_events', fieldMap: DODO_WEBHOOK_FIELD_MAP,  toPgRow: dodoWebhookToPgRow,   toFirestoreObj: dodoWebhookToFirestoreObj,   jsonbCols: DODO_WEBHOOK_JSONB_COLUMNS },
  'dine_webhook_events':       { table: 'dine_webhook_events',     fieldMap: DINE_WEBHOOK_FIELD_MAP,   toPgRow: dineWebhookToPgRow,     toFirestoreObj: dineWebhookToFirestoreObj,     jsonbCols: DINE_WEBHOOK_JSONB_COLUMNS },

  // Cart & Idempotency
  'saved_carts':       { table: 'saved_carts',       fieldMap: SAVED_CART_FIELD_MAP,      toPgRow: savedCartToPgRow,       toFirestoreObj: savedCartToFirestoreObj,       jsonbCols: SAVED_CART_JSONB_COLUMNS },
  'idempotency_keys':  { table: 'idempotency_keys',  fieldMap: IDEMPOTENCY_KEY_FIELD_MAP, toPgRow: idempotencyKeyToPgRow,  toFirestoreObj: idempotencyKeyToFirestoreObj,  jsonbCols: IDEMPOTENCY_KEY_JSONB_COLUMNS },

  // Security
  'blockedIPs':       { table: 'blocked_ips',       fieldMap: BLOCKED_IP_FIELD_MAP,        toPgRow: blockedIpToPgRow,       toFirestoreObj: blockedIpToFirestoreObj,       jsonbCols: BLOCKED_IP_JSONB_COLUMNS },
  'securityLogs':     { table: 'security_logs',     fieldMap: SECURITY_LOG_FIELD_MAP,      toPgRow: securityLogToPgRow,     toFirestoreObj: securityLogToFirestoreObj,     jsonbCols: SECURITY_LOG_JSONB_COLUMNS },
  'rateLimits':       { table: 'rate_limits',       fieldMap: RATE_LIMIT_FIELD_MAP,        toPgRow: rateLimitToPgRow,       toFirestoreObj: rateLimitToFirestoreObj,       jsonbCols: RATE_LIMIT_JSONB_COLUMNS },
  'publicToolUsage':  { table: 'public_tool_usage', fieldMap: PUBLIC_TOOL_USAGE_FIELD_MAP, toPgRow: publicToolUsageToPgRow, toFirestoreObj: publicToolUsageToFirestoreObj, jsonbCols: PUBLIC_TOOL_USAGE_JSONB_COLUMNS },
  'systemConfig':     { table: 'system_config',     fieldMap: SYSTEM_CONFIG_FIELD_MAP,     toPgRow: systemConfigToPgRow,    toFirestoreObj: systemConfigToFirestoreObj,    jsonbCols: SYSTEM_CONFIG_JSONB_COLUMNS },

  // Auth & OTP
  'email_otp_temp':    { table: 'email_otp_temp',    fieldMap: EMAIL_OTP_FIELD_MAP,        toPgRow: emailOtpToPgRow,          toFirestoreObj: emailOtpToFirestoreObj,          jsonbCols: EMAIL_OTP_JSONB_COLUMNS },
  'otp_verification':  { table: 'otp_verification',  fieldMap: OTP_VERIFICATION_FIELD_MAP, toPgRow: otpVerificationToPgRow,   toFirestoreObj: otpVerificationToFirestoreObj,   jsonbCols: OTP_VERIFICATION_JSONB_COLUMNS },
  'demoRequests':      { table: 'demo_requests',     fieldMap: DEMO_REQUEST_FIELD_MAP,     toPgRow: demoRequestToPgRow,       toFirestoreObj: demoRequestToFirestoreObj,       jsonbCols: DEMO_REQUEST_JSONB_COLUMNS },

  // AI & Chatbot (systemMisc)
  'chatbot_conversations': { table: 'chatbot_conversations', fieldMap: CHATBOT_CONV_FIELD_MAP,  toPgRow: chatbotConvToPgRow,    toFirestoreObj: chatbotConvToFirestoreObj,    jsonbCols: CHATBOT_CONV_JSONB_COLUMNS },
  'conversations':         { table: 'ai_conversations',      fieldMap: CONVERSATION_FIELD_MAP,  toPgRow: conversationToPgRow,   toFirestoreObj: conversationToFirestoreObj,   jsonbCols: CONVERSATION_JSONB_COLUMNS },
  'rag_knowledge':         { table: 'rag_knowledge',         fieldMap: RAG_KNOWLEDGE_FIELD_MAP, toPgRow: ragKnowledgeToPgRow,   toFirestoreObj: ragKnowledgeToFirestoreObj,   jsonbCols: RAG_KNOWLEDGE_JSONB_COLUMNS },
  'token_usage':           { table: 'token_usage',           fieldMap: TOKEN_USAGE_FIELD_MAP,   toPgRow: tokenUsageToPgRow,     toFirestoreObj: tokenUsageToFirestoreObj,     jsonbCols: TOKEN_USAGE_JSONB_COLUMNS },
  'query_cache':           { table: 'query_cache',           fieldMap: QUERY_CACHE_FIELD_MAP,   toPgRow: queryCacheToPgRow,     toFirestoreObj: queryCacheToFirestoreObj,     jsonbCols: QUERY_CACHE_JSONB_COLUMNS },

  // Staff & Scheduling (systemMisc)
  'staffLocations':        { table: 'staff_locations',        fieldMap: STAFF_LOCATION_FIELD_MAP,        toPgRow: staffLocationToPgRow,       toFirestoreObj: staffLocationToFirestoreObj,       jsonbCols: STAFF_LOCATION_JSONB_COLUMNS },
  'staffLocations_latest': { table: 'staff_locations_latest', fieldMap: STAFF_LOCATION_LATEST_FIELD_MAP, toPgRow: staffLocationLatestToPgRow, toFirestoreObj: staffLocationLatestToFirestoreObj, jsonbCols: STAFF_LOCATION_LATEST_JSONB_COLUMNS },

  // Miscellaneous
  'invoices':              { table: 'pos_invoices',            fieldMap: SM_INVOICE_FIELD_MAP,            toPgRow: smInvoiceToPgRow,            toFirestoreObj: smInvoiceToFirestoreObj,            jsonbCols: SM_INVOICE_JSONB_COLUMNS },
  'discountApprovals':     { table: 'discount_approvals',      fieldMap: DISCOUNT_APPROVAL_FIELD_MAP,     toPgRow: discountApprovalToPgRow,     toFirestoreObj: discountApprovalToFirestoreObj,     jsonbCols: DISCOUNT_APPROVAL_JSONB_COLUMNS },
  'ownerPreferences':      { table: 'owner_preferences',       fieldMap: OWNER_PREF_FIELD_MAP,            toPgRow: ownerPrefToPgRow,            toFirestoreObj: ownerPrefToFirestoreObj,            jsonbCols: OWNER_PREF_JSONB_COLUMNS },
  'taxSettings':           { table: 'tax_settings',            fieldMap: TAX_SETTINGS_FIELD_MAP,          toPgRow: taxSettingsToPgRow,           toFirestoreObj: taxSettingsToFirestoreObj,           jsonbCols: TAX_SETTINGS_JSONB_COLUMNS },
  'staff':                 { table: 'legacy_staff',            fieldMap: SM_STAFF_FIELD_MAP,              toPgRow: smStaffToPgRow,               toFirestoreObj: smStaffToFirestoreObj,               jsonbCols: SM_STAFF_JSONB_COLUMNS },
  'coupons':               { table: 'coupons',                 fieldMap: COUPON_FIELD_MAP,                toPgRow: couponToPgRow,                toFirestoreObj: couponToFirestoreObj,                jsonbCols: COUPON_JSONB_COLUMNS },
  'menuBulkDeleteLogs':    { table: 'menu_bulk_delete_logs',   fieldMap: MENU_BULK_DELETE_LOG_FIELD_MAP,  toPgRow: menuBulkDeleteLogToPgRow,     toFirestoreObj: menuBulkDeleteLogToFirestoreObj,     jsonbCols: MENU_BULK_DELETE_LOG_JSONB_COLUMNS },
  'aggregatorWebhookLogs': { table: 'aggregator_webhook_logs', fieldMap: AGGREGATOR_WEBHOOK_LOG_FIELD_MAP, toPgRow: aggregatorWebhookLogToPgRow, toFirestoreObj: aggregatorWebhookLogToFirestoreObj,  jsonbCols: AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS },
  'whatsappOrderLogs':     { table: 'whatsapp_order_logs',     fieldMap: WHATSAPP_ORDER_LOG_FIELD_MAP,    toPgRow: whatsappOrderLogToPgRow,      toFirestoreObj: whatsappOrderLogToFirestoreObj,      jsonbCols: WHATSAPP_ORDER_LOG_JSONB_COLUMNS },
  'stockAudits':           { table: 'stock_audits',            fieldMap: STOCK_AUDIT_FIELD_MAP,           toPgRow: stockAuditToPgRow,            toFirestoreObj: stockAuditToFirestoreObj,            jsonbCols: STOCK_AUDIT_JSONB_COLUMNS },
  'productionEntries':     { table: 'production_entries',      fieldMap: PRODUCTION_ENTRY_FIELD_MAP,      toPgRow: productionEntryToPgRow,       toFirestoreObj: productionEntryToFirestoreObj,       jsonbCols: PRODUCTION_ENTRY_JSONB_COLUMNS },
  'd365SyncLog':           { table: 'd365_sync_log',           fieldMap: D365_SYNC_LOG_FIELD_MAP,         toPgRow: d365SyncLogToPgRow,           toFirestoreObj: d365SyncLogToFirestoreObj,           jsonbCols: D365_SYNC_LOG_JSONB_COLUMNS },

  // ── auth & menu ─────────────────────────────────────────────────────────
  'menus':             { table: 'menus',              fieldMap: MENU_FIELD_MAP,             toPgRow: menuToPgRow,             toFirestoreObj: menuToFirestoreObj,             jsonbCols: MENU_JSONB_COLUMNS, cacheTTL: 120 },
  'menuItems':         { table: 'menu_items',         fieldMap: MENU_ITEM_FIELD_MAP,        toPgRow: menuItemToPgRow,         toFirestoreObj: menuItemToFirestoreObj,         jsonbCols: MENU_ITEM_JSONB_COLUMNS, cacheTTL: 120 },
  // Legacy subcollection alias: restaurants/{id}/menu → menu_items (scoped by restaurant_id).
  // 14 AI/RAG read sites use db.collection('restaurants').doc(id).collection('menu').
  'menu':              { table: 'menu_items',         fieldMap: MENU_ITEM_FIELD_MAP,        toPgRow: menuItemToPgRow,         toFirestoreObj: menuItemToFirestoreObj,         jsonbCols: MENU_ITEM_JSONB_COLUMNS, cacheTTL: 120 },
  'users':             { table: 'app_users',          fieldMap: APP_USER_FIELD_MAP,         toPgRow: appUserToPgRow,          toFirestoreObj: appUserToFirestoreObj,          jsonbCols: APP_USER_JSONB_COLUMNS },
  'userRestaurants':   { table: 'user_restaurants',   fieldMap: USER_RESTAURANT_FIELD_MAP,  toPgRow: userRestaurantToPgRow,   toFirestoreObj: userRestaurantToFirestoreObj,   jsonbCols: USER_RESTAURANT_JSONB_COLUMNS },
  'staffCredentials':  { table: 'staff_credentials',  fieldMap: STAFF_CREDENTIAL_FIELD_MAP, toPgRow: staffCredentialToPgRow,  toFirestoreObj: staffCredentialToFirestoreObj,  jsonbCols: STAFF_CREDENTIAL_JSONB_COLUMNS },
  'dine_user_data':    { table: 'dine_user_data',     fieldMap: DINE_USER_DATA_FIELD_MAP,   toPgRow: dineUserDataToPgRow,     toFirestoreObj: dineUserDataToFirestoreObj,     jsonbCols: DINE_USER_DATA_JSONB_COLUMNS },

  // ── counter tables (handled via counterRepo atomic ops) ─────────────────
  'daily_order_counters': { table: 'order_counters', fieldMap: {}, toPgRow: counterIdentity, toFirestoreObj: counterIdentity, jsonbCols: COUNTER_JSONB },
  'order_id_counters':    { table: 'order_counters', fieldMap: {}, toPgRow: counterIdentity, toFirestoreObj: counterIdentity, jsonbCols: COUNTER_JSONB },
  'tab_counters':         { table: 'order_counters', fieldMap: {}, toPgRow: counterIdentity, toFirestoreObj: counterIdentity, jsonbCols: COUNTER_JSONB },

  // ── print diagnostics telemetry ─────────────────────────────────────────
  // Requires the print_diagnostics table (scripts/create-print-diagnostics-table.sql)
  // to exist on Cloud SQL before this branch deploys; until then the endpoint
  // still works on Firestore. Writes are fire-and-forget + server-side try/caught.
  'printDiagnostics':     { table: 'print_diagnostics', fieldMap: PRINT_DIAG_FIELD_MAP, toPgRow: printDiagToPgRow, toFirestoreObj: printDiagToFirestoreObj, jsonbCols: PRINT_DIAG_JSONB_COLUMNS },
};

module.exports = REGISTRY;
