/**
 * backfill-system-misc-pg.js — Backfill Phase 10 System/Misc Firestore collections to PG.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *   FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
 *   node scripts/backfill-system-misc-pg.js [--upsert] [--dry-run] [--collection NAME]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const admin = require('firebase-admin');

if (!admin.apps.find(a => a && a.name === 'backfill-system-misc')) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey,
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL || undefined,
  }, 'backfill-system-misc');
}

const app = admin.app('backfill-system-misc');
const db = app.firestore();
db.settings({ databaseId: 'dine', ignoreUndefinedProperties: true });

const { query, getPool } = require('../repos/pgClient');
const { buildUpsert, buildInsert } = require('../repos/queryBuilder');
const {
  // GROUP A - Supply Chain
  supplierToPgRow, SUPPLIER_JSONB_COLUMNS,
  poToPgRow, PO_JSONB_COLUMNS,
  requisitionToPgRow, REQUISITION_JSONB_COLUMNS,
  grnToPgRow, GRN_JSONB_COLUMNS,
  supplierReturnToPgRow, SUPPLIER_RETURN_JSONB_COLUMNS,
  stockTransferToPgRow, STOCK_TRANSFER_JSONB_COLUMNS,
  supplierPerfToPgRow, SUPPLIER_PERF_JSONB_COLUMNS,
  supplierInvoiceToPgRow, SUPPLIER_INVOICE_JSONB_COLUMNS,
  // GROUP B - Inventory & Production
  recipeToPgRow, RECIPE_JSONB_COLUMNS,
  invTxnToPgRow, INV_TXN_JSONB_COLUMNS,
  stockBatchToPgRow, STOCK_BATCH_JSONB_COLUMNS,
  wasteEntryToPgRow, WASTE_ENTRY_JSONB_COLUMNS,
  stockAuditToPgRow, STOCK_AUDIT_JSONB_COLUMNS,
  productionEntryToPgRow, PRODUCTION_ENTRY_JSONB_COLUMNS,
  // GROUP C - Feedback & Customer
  feedbackFormToPgRow, FEEDBACK_FORM_JSONB_COLUMNS,
  feedbackResponseToPgRow, FEEDBACK_RESPONSE_JSONB_COLUMNS,
  customerGroupToPgRow, CUSTOMER_GROUP_JSONB_COLUMNS,
  // GROUP D - Booking & Space
  bookingToPgRow, BOOKING_JSONB_COLUMNS,
  bookingVenueToPgRow, BOOKING_VENUE_JSONB_COLUMNS,
  spaceBookingToPgRow, SPACE_BOOKING_JSONB_COLUMNS,
  // GROUP E - Parking
  parkingConfigToPgRow, PARKING_CONFIG_JSONB_COLUMNS,
  parkingZoneToPgRow, PARKING_ZONE_JSONB_COLUMNS,
  parkingSlotToPgRow, PARKING_SLOT_JSONB_COLUMNS,
  parkingTicketToPgRow, PARKING_TICKET_JSONB_COLUMNS,
  parkingRateToPgRow, PARKING_RATE_JSONB_COLUMNS,
  // GROUP F - Settings
  restaurantSettingsToPgRow, RESTAURANT_SETTINGS_JSONB_COLUMNS,
  discountSettingsToPgRow, DISCOUNT_SETTINGS_JSONB_COLUMNS,
  // GROUP G - Payment & Billing
  paymentToPgRow, PAYMENT_JSONB_COLUMNS,
  razorpayTokenToPgRow, RAZORPAY_TOKEN_JSONB_COLUMNS,
  dodoOrderToPgRow, DODO_ORDER_JSONB_COLUMNS,
  dodoBillingToPgRow, DODO_BILLING_JSONB_COLUMNS,
  dodoRefundToPgRow, DODO_REFUND_JSONB_COLUMNS,
  dodoDisputeToPgRow, DODO_DISPUTE_JSONB_COLUMNS,
  dodoWebhookToPgRow, DODO_WEBHOOK_JSONB_COLUMNS,
  dineWebhookToPgRow, DINE_WEBHOOK_JSONB_COLUMNS,
  // GROUP H - Cart & Idempotency
  savedCartToPgRow, SAVED_CART_JSONB_COLUMNS,
  idempotencyKeyToPgRow, IDEMPOTENCY_KEY_JSONB_COLUMNS,
  // GROUP I - Security
  blockedIpToPgRow, BLOCKED_IP_JSONB_COLUMNS,
  securityLogToPgRow, SECURITY_LOG_JSONB_COLUMNS,
  rateLimitToPgRow, RATE_LIMIT_JSONB_COLUMNS,
  publicToolUsageToPgRow, PUBLIC_TOOL_USAGE_JSONB_COLUMNS,
  systemConfigToPgRow, SYSTEM_CONFIG_JSONB_COLUMNS,
  // GROUP J - Auth & OTP
  emailOtpToPgRow, EMAIL_OTP_JSONB_COLUMNS,
  otpVerificationToPgRow, OTP_VERIFICATION_JSONB_COLUMNS,
  demoRequestToPgRow, DEMO_REQUEST_JSONB_COLUMNS,
  // GROUP K - AI & Chatbot
  chatbotConvToPgRow, CHATBOT_CONV_JSONB_COLUMNS,
  conversationToPgRow, CONVERSATION_JSONB_COLUMNS,
  ragKnowledgeToPgRow, RAG_KNOWLEDGE_JSONB_COLUMNS,
  tokenUsageToPgRow, TOKEN_USAGE_JSONB_COLUMNS,
  queryCacheToPgRow, QUERY_CACHE_JSONB_COLUMNS,
  // GROUP L - Bar Inventory
  barBottleToPgRow, BAR_BOTTLE_JSONB_COLUMNS,
  barReconciliationToPgRow, BAR_RECONCILIATION_JSONB_COLUMNS,
  // GROUP M - Staff & Scheduling
  staffAvailabilityToPgRow, STAFF_AVAILABILITY_JSONB_COLUMNS,
  staffLocationToPgRow, STAFF_LOCATION_JSONB_COLUMNS,
  staffLocationLatestToPgRow, STAFF_LOCATION_LATEST_JSONB_COLUMNS,
  // GROUP N - Miscellaneous
  invoiceToPgRow, INVOICE_JSONB_COLUMNS,
  discountApprovalToPgRow, DISCOUNT_APPROVAL_JSONB_COLUMNS,
  ownerPrefToPgRow, OWNER_PREF_JSONB_COLUMNS,
  taxSettingsToPgRow, TAX_SETTINGS_JSONB_COLUMNS,
  staffToPgRow, STAFF_JSONB_COLUMNS,
  couponToPgRow, COUPON_JSONB_COLUMNS,
  menuBulkDeleteLogToPgRow, MENU_BULK_DELETE_LOG_JSONB_COLUMNS,
  aggregatorWebhookLogToPgRow, AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS,
  whatsappOrderLogToPgRow, WHATSAPP_ORDER_LOG_JSONB_COLUMNS,
} = require('../repos/systemMiscFieldMapper');

const args = process.argv.slice(2);
const upsertMode = args.includes('--upsert');
const dryRun = args.includes('--dry-run');
const collectionFilter = args.includes('--collection') ? args[args.indexOf('--collection') + 1] : null;

const BATCH_SIZE = 200;

const COLLECTIONS = [
  // GROUP A - Supply Chain
  { name: 'suppliers', table: 'suppliers', toPgRow: supplierToPgRow, jsonbCols: SUPPLIER_JSONB_COLUMNS },
  { name: 'purchaseOrders', table: 'purchase_orders', toPgRow: poToPgRow, jsonbCols: PO_JSONB_COLUMNS },
  { name: 'purchase-requisitions', table: 'purchase_requisitions', toPgRow: requisitionToPgRow, jsonbCols: REQUISITION_JSONB_COLUMNS },
  { name: 'goods-receipt-notes', table: 'goods_receipt_notes', toPgRow: grnToPgRow, jsonbCols: GRN_JSONB_COLUMNS },
  { name: 'supplier-returns', table: 'supplier_returns', toPgRow: supplierReturnToPgRow, jsonbCols: SUPPLIER_RETURN_JSONB_COLUMNS },
  { name: 'stock-transfers', table: 'stock_transfers', toPgRow: stockTransferToPgRow, jsonbCols: STOCK_TRANSFER_JSONB_COLUMNS },
  { name: 'supplier-performance', table: 'supplier_performance', toPgRow: supplierPerfToPgRow, jsonbCols: SUPPLIER_PERF_JSONB_COLUMNS },
  { name: 'supplier-invoices', table: 'supplier_invoices', toPgRow: supplierInvoiceToPgRow, jsonbCols: SUPPLIER_INVOICE_JSONB_COLUMNS },
  // GROUP B - Inventory & Production
  { name: 'recipes', table: 'recipes', toPgRow: recipeToPgRow, jsonbCols: RECIPE_JSONB_COLUMNS },
  { name: 'inventoryTransactions', table: 'inventory_transactions', toPgRow: invTxnToPgRow, jsonbCols: INV_TXN_JSONB_COLUMNS },
  { name: 'stockBatches', table: 'stock_batches', toPgRow: stockBatchToPgRow, jsonbCols: STOCK_BATCH_JSONB_COLUMNS },
  { name: 'wasteEntries', table: 'waste_entries', toPgRow: wasteEntryToPgRow, jsonbCols: WASTE_ENTRY_JSONB_COLUMNS },
  { name: 'stockAudits', table: 'stock_audits', toPgRow: stockAuditToPgRow, jsonbCols: STOCK_AUDIT_JSONB_COLUMNS },
  { name: 'productionEntries', table: 'production_entries', toPgRow: productionEntryToPgRow, jsonbCols: PRODUCTION_ENTRY_JSONB_COLUMNS },
  // GROUP C - Feedback & Customer
  { name: 'feedbackForms', table: 'feedback_forms', toPgRow: feedbackFormToPgRow, jsonbCols: FEEDBACK_FORM_JSONB_COLUMNS },
  { name: 'feedbackResponses', table: 'feedback_responses', toPgRow: feedbackResponseToPgRow, jsonbCols: FEEDBACK_RESPONSE_JSONB_COLUMNS },
  { name: 'customerGroups', table: 'customer_groups', toPgRow: customerGroupToPgRow, jsonbCols: CUSTOMER_GROUP_JSONB_COLUMNS },
  // GROUP D - Booking & Space
  { name: 'bookings', table: 'rest_bookings', toPgRow: bookingToPgRow, jsonbCols: BOOKING_JSONB_COLUMNS },
  { name: 'bookingVenues', table: 'rest_booking_venues', toPgRow: bookingVenueToPgRow, jsonbCols: BOOKING_VENUE_JSONB_COLUMNS },
  { name: 'spaceBookings', table: 'space_bookings', toPgRow: spaceBookingToPgRow, jsonbCols: SPACE_BOOKING_JSONB_COLUMNS },
  // GROUP E - Parking
  { name: 'parkingConfigs', table: 'parking_configs', toPgRow: parkingConfigToPgRow, jsonbCols: PARKING_CONFIG_JSONB_COLUMNS },
  { name: 'parkingZones', table: 'parking_zones', toPgRow: parkingZoneToPgRow, jsonbCols: PARKING_ZONE_JSONB_COLUMNS },
  { name: 'parkingSlots', table: 'parking_slots', toPgRow: parkingSlotToPgRow, jsonbCols: PARKING_SLOT_JSONB_COLUMNS },
  { name: 'parkingTickets', table: 'parking_tickets', toPgRow: parkingTicketToPgRow, jsonbCols: PARKING_TICKET_JSONB_COLUMNS },
  { name: 'parkingRates', table: 'parking_rates', toPgRow: parkingRateToPgRow, jsonbCols: PARKING_RATE_JSONB_COLUMNS },
  // GROUP F - Settings
  { name: 'restaurantSettings', table: 'restaurant_settings', toPgRow: restaurantSettingsToPgRow, jsonbCols: RESTAURANT_SETTINGS_JSONB_COLUMNS },
  { name: 'discountSettings', table: 'discount_settings', toPgRow: discountSettingsToPgRow, jsonbCols: DISCOUNT_SETTINGS_JSONB_COLUMNS },
  // GROUP G - Payment & Billing
  { name: 'payments', table: 'pos_payments', toPgRow: paymentToPgRow, jsonbCols: PAYMENT_JSONB_COLUMNS },
  { name: 'razorpay_tokens', table: 'razorpay_tokens', toPgRow: razorpayTokenToPgRow, jsonbCols: RAZORPAY_TOKEN_JSONB_COLUMNS },
  { name: 'dine_dodo_orders', table: 'dine_dodo_orders', toPgRow: dodoOrderToPgRow, jsonbCols: DODO_ORDER_JSONB_COLUMNS },
  { name: 'dine_dodo_billing', table: 'dine_dodo_billing', toPgRow: dodoBillingToPgRow, jsonbCols: DODO_BILLING_JSONB_COLUMNS },
  { name: 'dine_dodo_refunds', table: 'dine_dodo_refunds', toPgRow: dodoRefundToPgRow, jsonbCols: DODO_REFUND_JSONB_COLUMNS },
  { name: 'dine_dodo_disputes', table: 'dine_dodo_disputes', toPgRow: dodoDisputeToPgRow, jsonbCols: DODO_DISPUTE_JSONB_COLUMNS },
  { name: 'dine_dodo_webhook_events', table: 'dine_dodo_webhook_events', toPgRow: dodoWebhookToPgRow, jsonbCols: DODO_WEBHOOK_JSONB_COLUMNS },
  { name: 'dine_webhook_events', table: 'dine_webhook_events', toPgRow: dineWebhookToPgRow, jsonbCols: DINE_WEBHOOK_JSONB_COLUMNS },
  // GROUP H - Cart & Idempotency
  { name: 'saved_carts', table: 'saved_carts', toPgRow: savedCartToPgRow, jsonbCols: SAVED_CART_JSONB_COLUMNS },
  { name: 'idempotency_keys', table: 'idempotency_keys', toPgRow: idempotencyKeyToPgRow, jsonbCols: IDEMPOTENCY_KEY_JSONB_COLUMNS },
  // GROUP I - Security
  { name: 'blockedIPs', table: 'blocked_ips', toPgRow: blockedIpToPgRow, jsonbCols: BLOCKED_IP_JSONB_COLUMNS },
  { name: 'securityLogs', table: 'security_logs', toPgRow: securityLogToPgRow, jsonbCols: SECURITY_LOG_JSONB_COLUMNS },
  { name: 'rateLimits', table: 'rate_limits', toPgRow: rateLimitToPgRow, jsonbCols: RATE_LIMIT_JSONB_COLUMNS },
  { name: 'publicToolUsage', table: 'public_tool_usage', toPgRow: publicToolUsageToPgRow, jsonbCols: PUBLIC_TOOL_USAGE_JSONB_COLUMNS },
  { name: 'systemConfig', table: 'system_config', toPgRow: systemConfigToPgRow, jsonbCols: SYSTEM_CONFIG_JSONB_COLUMNS },
  // GROUP J - Auth & OTP
  { name: 'email_otp_temp', table: 'email_otp_temp', toPgRow: emailOtpToPgRow, jsonbCols: EMAIL_OTP_JSONB_COLUMNS },
  { name: 'otp_verification', table: 'otp_verification', toPgRow: otpVerificationToPgRow, jsonbCols: OTP_VERIFICATION_JSONB_COLUMNS },
  { name: 'demoRequests', table: 'demo_requests', toPgRow: demoRequestToPgRow, jsonbCols: DEMO_REQUEST_JSONB_COLUMNS },
  // GROUP K - AI & Chatbot
  { name: 'chatbot_conversations', table: 'chatbot_conversations', toPgRow: chatbotConvToPgRow, jsonbCols: CHATBOT_CONV_JSONB_COLUMNS },
  { name: 'conversations', table: 'ai_conversations', toPgRow: conversationToPgRow, jsonbCols: CONVERSATION_JSONB_COLUMNS },
  { name: 'rag_knowledge', table: 'rag_knowledge', toPgRow: ragKnowledgeToPgRow, jsonbCols: RAG_KNOWLEDGE_JSONB_COLUMNS },
  { name: 'token_usage', table: 'token_usage', toPgRow: tokenUsageToPgRow, jsonbCols: TOKEN_USAGE_JSONB_COLUMNS },
  { name: 'query_cache', table: 'query_cache', toPgRow: queryCacheToPgRow, jsonbCols: QUERY_CACHE_JSONB_COLUMNS },
  // GROUP L - Bar Inventory
  { name: 'barBottles', table: 'bar_bottles', toPgRow: barBottleToPgRow, jsonbCols: BAR_BOTTLE_JSONB_COLUMNS },
  { name: 'barReconciliation', table: 'bar_reconciliation', toPgRow: barReconciliationToPgRow, jsonbCols: BAR_RECONCILIATION_JSONB_COLUMNS },
  // GROUP M - Staff & Scheduling
  { name: 'staffAvailability', table: 'staff_availability', toPgRow: staffAvailabilityToPgRow, jsonbCols: STAFF_AVAILABILITY_JSONB_COLUMNS },
  { name: 'staffLocations', table: 'staff_locations', toPgRow: staffLocationToPgRow, jsonbCols: STAFF_LOCATION_JSONB_COLUMNS },
  { name: 'staffLocations_latest', table: 'staff_locations_latest', toPgRow: staffLocationLatestToPgRow, jsonbCols: STAFF_LOCATION_LATEST_JSONB_COLUMNS },
  // GROUP N - Miscellaneous
  { name: 'invoices', table: 'pos_invoices', toPgRow: invoiceToPgRow, jsonbCols: INVOICE_JSONB_COLUMNS },
  { name: 'discountApprovals', table: 'discount_approvals', toPgRow: discountApprovalToPgRow, jsonbCols: DISCOUNT_APPROVAL_JSONB_COLUMNS },
  { name: 'ownerPreferences', table: 'owner_preferences', toPgRow: ownerPrefToPgRow, jsonbCols: OWNER_PREF_JSONB_COLUMNS },
  { name: 'taxSettings', table: 'tax_settings', toPgRow: taxSettingsToPgRow, jsonbCols: TAX_SETTINGS_JSONB_COLUMNS },
  { name: 'staff', table: 'legacy_staff', toPgRow: staffToPgRow, jsonbCols: STAFF_JSONB_COLUMNS },
  { name: 'coupons', table: 'coupons', toPgRow: couponToPgRow, jsonbCols: COUPON_JSONB_COLUMNS },
  { name: 'menuBulkDeleteLogs', table: 'menu_bulk_delete_logs', toPgRow: menuBulkDeleteLogToPgRow, jsonbCols: MENU_BULK_DELETE_LOG_JSONB_COLUMNS },
  { name: 'aggregatorWebhookLogs', table: 'aggregator_webhook_logs', toPgRow: aggregatorWebhookLogToPgRow, jsonbCols: AGGREGATOR_WEBHOOK_LOG_JSONB_COLUMNS },
  { name: 'whatsappOrderLogs', table: 'whatsapp_order_logs', toPgRow: whatsappOrderLogToPgRow, jsonbCols: WHATSAPP_ORDER_LOG_JSONB_COLUMNS },
];

async function backfillCollection({ name, table, toPgRow, jsonbCols }) {
  console.log(`\n── Backfilling ${name} → ${table} ──`);

  let totalDocs = 0;
  let totalErrors = 0;
  let lastDoc = null;

  while (true) {
    let q = db.collection(name).orderBy('__name__').limit(BATCH_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      totalDocs++;
      lastDoc = doc;

      try {
        const data = doc.data();
        const pgRow = toPgRow({ id: doc.id, ...data });
        if (!pgRow.id) pgRow.id = doc.id;

        if (dryRun) {
          if (totalDocs <= 3) console.log(`  [dry-run] ${doc.id}:`, JSON.stringify(pgRow).slice(0, 200));
          continue;
        }

        const qObj = upsertMode
          ? buildUpsert(table, pgRow, jsonbCols)
          : buildInsert(table, pgRow, jsonbCols);

        await query(qObj.text, qObj.values);
      } catch (err) {
        totalErrors++;
        console.error(`  ERROR ${doc.id}: ${err.message}`);
      }
    }

    if (snap.docs.length < BATCH_SIZE) break;
  }

  console.log(`  ${name}: ${totalDocs} docs, ${totalErrors} errors`);
  return { name, totalDocs, totalErrors };
}

async function main() {
  console.log(`Backfill System/Misc collections → PG (upsert=${upsertMode}, dryRun=${dryRun})`);
  if (collectionFilter) console.log(`  Filtered to: ${collectionFilter}`);

  const targets = collectionFilter
    ? COLLECTIONS.filter(c => c.name === collectionFilter || c.table === collectionFilter)
    : COLLECTIONS;

  if (targets.length === 0) {
    console.error('No matching collections found for filter:', collectionFilter);
    process.exit(1);
  }

  const results = [];
  for (const col of targets) {
    results.push(await backfillCollection(col));
  }

  console.log('\n── Summary ──');
  let grandTotal = 0;
  let grandErrors = 0;
  for (const r of results) {
    console.log(`  ${r.name}: ${r.totalDocs} docs, ${r.totalErrors} errors`);
    grandTotal += r.totalDocs;
    grandErrors += r.totalErrors;
  }
  console.log(`\n  TOTAL: ${grandTotal} docs, ${grandErrors} errors`);

  await getPool().end();
  process.exit(grandErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
