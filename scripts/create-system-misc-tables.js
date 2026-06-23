/**
 * create-system-misc-tables.js — Create 64 PG tables for Phase 10 collections.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/create-system-misc-tables.js
 */

const { query, getPool } = require('../repos/pgClient');

const DDL = `
-- ========================================
-- GROUP A: Supply Chain (7 tables)
-- ========================================

-- suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'active',
  gst_number TEXT DEFAULT '',
  payment_terms TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppliers_restaurant ON suppliers (restaurant_id);

-- purchase_orders
CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  supplier_id TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  total_amount NUMERIC(12,2) DEFAULT 0,
  status TEXT DEFAULT 'draft',
  delivery_date TIMESTAMPTZ,
  notes TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_restaurant ON purchase_orders (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_restaurant_status ON purchase_orders (restaurant_id, status);

-- purchase_requisitions
CREATE TABLE IF NOT EXISTS purchase_requisitions (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  requested_by TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  purchase_order_id TEXT DEFAULT '',
  priority TEXT DEFAULT 'medium',
  notes TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_requisitions_restaurant ON purchase_requisitions (restaurant_id);

-- goods_receipt_notes
CREATE TABLE IF NOT EXISTS goods_receipt_notes (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  purchase_order_id TEXT DEFAULT '',
  supplier_id TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  received_date TIMESTAMPTZ,
  received_by TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  notes TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_notes_restaurant ON goods_receipt_notes (restaurant_id);

-- supplier_returns
CREATE TABLE IF NOT EXISTS supplier_returns (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  supplier_id TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  return_date TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_supplier_returns_restaurant ON supplier_returns (restaurant_id);

-- stock_transfers
CREATE TABLE IF NOT EXISTS stock_transfers (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  from_location TEXT DEFAULT '',
  to_location TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  transfer_date TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_restaurant ON stock_transfers (restaurant_id);

-- supplier_performance
CREATE TABLE IF NOT EXISTS supplier_performance (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  supplier_id TEXT DEFAULT '',
  metrics JSONB DEFAULT '{}',
  evaluation_date TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_supplier_performance_restaurant ON supplier_performance (restaurant_id);

-- supplier_invoices
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  supplier_id TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_restaurant ON supplier_invoices (restaurant_id);

-- GROUP B: Inventory & Production — SKIPPED (6 tables already exist from earlier phases)
-- recipes, inventory_transactions, stock_batches, waste_entries, stock_audits, production_entries

-- ========================================
-- GROUP C: Feedback & Customer (3 tables)
-- ========================================

-- feedback_forms
CREATE TABLE IF NOT EXISTS feedback_forms (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  title TEXT DEFAULT '',
  fields JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  response_count INTEGER DEFAULT 0,
  thank_you_message TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_forms_restaurant ON feedback_forms (restaurant_id);

-- feedback_responses
CREATE TABLE IF NOT EXISTS feedback_responses (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  form_id TEXT DEFAULT '',
  responses JSONB DEFAULT '{}',
  rating NUMERIC(3,1),
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  order_id TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_feedback_responses_restaurant ON feedback_responses (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_feedback_responses_form ON feedback_responses (form_id);

-- customer_groups
CREATE TABLE IF NOT EXISTS customer_groups (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  color TEXT DEFAULT '',
  icon TEXT DEFAULT '',
  customer_ids JSONB DEFAULT '[]',
  customer_phones JSONB DEFAULT '[]',
  customer_count INTEGER DEFAULT 0,
  created_by TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_groups_restaurant ON customer_groups (restaurant_id);

-- ========================================
-- GROUP D: Booking & Space (3 tables)
-- ========================================

-- rest_bookings (use rest_ prefix to avoid clash with hotel bookings_v2)
CREATE TABLE IF NOT EXISTS rest_bookings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  date TEXT DEFAULT '',
  time TEXT DEFAULT '',
  party_size INTEGER DEFAULT 0,
  duration TEXT DEFAULT '',
  table_id TEXT DEFAULT '',
  venue_id TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  notes TEXT DEFAULT '',
  total_amount NUMERIC(12,2) DEFAULT 0,
  advance_amount NUMERIC(12,2) DEFAULT 0,
  payments JSONB DEFAULT '[]',
  items JSONB DEFAULT '[]',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rest_bookings_restaurant ON rest_bookings (restaurant_id);

-- rest_booking_venues (use rest_ prefix)
CREATE TABLE IF NOT EXISTS rest_booking_venues (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  capacity INTEGER DEFAULT 0,
  price_per_hour NUMERIC(12,2) DEFAULT 0,
  amenities JSONB DEFAULT '[]',
  images JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rest_booking_venues_restaurant ON rest_booking_venues (restaurant_id);

-- space_bookings
CREATE TABLE IF NOT EXISTS space_bookings (
  id TEXT PRIMARY KEY,
  owner_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  table_id TEXT DEFAULT '',
  date TEXT DEFAULT '',
  start_time TEXT DEFAULT '',
  end_time TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  guest_name TEXT DEFAULT '',
  guest_phone TEXT DEFAULT '',
  party_size INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_space_bookings_restaurant ON space_bookings (restaurant_id);

-- ========================================
-- GROUP E: Parking (5 tables)
-- ========================================

-- parking_configs
CREATE TABLE IF NOT EXISTS parking_configs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  total_capacity INTEGER DEFAULT 0,
  operating_hours JSONB DEFAULT '{}',
  currency TEXT DEFAULT '',
  enable_prepaid BOOLEAN DEFAULT false,
  vat_percentage NUMERIC(5,2) DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parking_configs_restaurant ON parking_configs (restaurant_id);

-- parking_zones
CREATE TABLE IF NOT EXISTS parking_zones (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  type TEXT DEFAULT '',
  total_slots INTEGER DEFAULT 0,
  occupied_slots INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parking_zones_restaurant ON parking_zones (restaurant_id);

-- parking_slots
CREATE TABLE IF NOT EXISTS parking_slots (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  zone_id TEXT DEFAULT '',
  slot_number TEXT DEFAULT '',
  type TEXT DEFAULT '',
  status TEXT DEFAULT 'available',
  vehicle_type TEXT DEFAULT '',
  current_ticket_id TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parking_slots_restaurant ON parking_slots (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_parking_slots_zone ON parking_slots (zone_id);

-- parking_tickets
CREATE TABLE IF NOT EXISTS parking_tickets (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  zone_id TEXT DEFAULT '',
  slot_id TEXT DEFAULT '',
  rate_id TEXT DEFAULT '',
  vehicle_number TEXT DEFAULT '',
  vehicle_type TEXT DEFAULT '',
  entry_time TIMESTAMPTZ,
  exit_time TIMESTAMPTZ,
  duration NUMERIC(10,2) DEFAULT 0,
  amount NUMERIC(12,2) DEFAULT 0,
  payment_status TEXT DEFAULT 'pending',
  payment_method TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parking_tickets_restaurant ON parking_tickets (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_parking_tickets_restaurant_status ON parking_tickets (restaurant_id, status);

-- parking_rates
CREATE TABLE IF NOT EXISTS parking_rates (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  vehicle_type TEXT DEFAULT '',
  rate_type TEXT DEFAULT '',
  amount NUMERIC(12,2) DEFAULT 0,
  free_minutes INTEGER DEFAULT 0,
  max_daily NUMERIC(12,2) DEFAULT 0,
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parking_rates_restaurant ON parking_rates (restaurant_id);

-- ========================================
-- GROUP F: Settings (2 tables)
-- ========================================

-- restaurant_settings
CREATE TABLE IF NOT EXISTS restaurant_settings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  type TEXT DEFAULT '',
  settings JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_restaurant_settings_restaurant ON restaurant_settings (restaurant_id);

-- discount_settings
CREATE TABLE IF NOT EXISTS discount_settings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  max_discount_percent NUMERIC(5,2) DEFAULT 0,
  require_approval BOOLEAN DEFAULT false,
  approval_threshold NUMERIC(5,2) DEFAULT 0,
  allowed_roles JSONB DEFAULT '[]',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_discount_settings_restaurant ON discount_settings (restaurant_id);

-- ========================================
-- GROUP G: Payment & Billing (8 tables)
-- ========================================

-- pos_payments (use pos_ prefix to avoid conflicts)
CREATE TABLE IF NOT EXISTS pos_payments (
  id TEXT PRIMARY KEY,
  amount NUMERIC(12,2) DEFAULT 0,
  method TEXT DEFAULT '',
  order_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pos_payments_restaurant ON pos_payments (restaurant_id);

-- razorpay_tokens
CREATE TABLE IF NOT EXISTS razorpay_tokens (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  refresh_token TEXT DEFAULT '',
  account_id TEXT DEFAULT '',
  public_token TEXT DEFAULT '',
  token_type TEXT DEFAULT '',
  expires_at TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_razorpay_tokens_restaurant ON razorpay_tokens (restaurant_id);

-- dine_dodo_orders
CREATE TABLE IF NOT EXISTS dine_dodo_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  session_id TEXT DEFAULT '',
  plan_id TEXT DEFAULT '',
  product_id TEXT DEFAULT '',
  checkout_url TEXT DEFAULT '',
  email TEXT DEFAULT '',
  name TEXT DEFAULT '',
  payment_gateway TEXT DEFAULT '',
  app TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dine_dodo_orders_user ON dine_dodo_orders (user_id);

-- dine_dodo_billing
CREATE TABLE IF NOT EXISTS dine_dodo_billing (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  type TEXT DEFAULT '',
  session_id TEXT DEFAULT '',
  plan_id TEXT DEFAULT '',
  previous_plan_id TEXT DEFAULT '',
  product_id TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  app TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dine_dodo_billing_user ON dine_dodo_billing (user_id);

-- dine_dodo_refunds
CREATE TABLE IF NOT EXISTS dine_dodo_refunds (
  id TEXT PRIMARY KEY,
  type TEXT DEFAULT '',
  refund_id TEXT DEFAULT '',
  payment_id TEXT DEFAULT '',
  amount NUMERIC(12,2) DEFAULT 0,
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- dine_dodo_disputes
CREATE TABLE IF NOT EXISTS dine_dodo_disputes (
  id TEXT PRIMARY KEY,
  type TEXT DEFAULT '',
  dispute_id TEXT DEFAULT '',
  payment_id TEXT DEFAULT '',
  amount NUMERIC(12,2) DEFAULT 0,
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- dine_dodo_webhook_events
CREATE TABLE IF NOT EXISTS dine_dodo_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT DEFAULT '',
  event_id TEXT DEFAULT '',
  payload JSONB DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- dine_webhook_events
CREATE TABLE IF NOT EXISTS dine_webhook_events (
  id TEXT PRIMARY KEY,
  full_payload JSONB DEFAULT '{}',
  webhook_received_at TIMESTAMPTZ,
  event TEXT DEFAULT '',
  app TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}'
);

-- ========================================
-- GROUP H: Cart & Idempotency (2 tables)
-- ========================================

-- saved_carts
CREATE TABLE IF NOT EXISTS saved_carts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  user_id TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  table_id TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_carts_restaurant ON saved_carts (restaurant_id);

-- idempotency_keys
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  order_id TEXT DEFAULT '',
  response JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_restaurant ON idempotency_keys (restaurant_id);

-- ========================================
-- GROUP I: Security (5 tables)
-- ========================================

-- blocked_ips
CREATE TABLE IF NOT EXISTS blocked_ips (
  id TEXT PRIMARY KEY,
  ip TEXT DEFAULT '',
  blocked_until TIMESTAMPTZ,
  blocked_at TIMESTAMPTZ,
  reason TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}'
);

-- security_logs
CREATE TABLE IF NOT EXISTS security_logs (
  id TEXT PRIMARY KEY,
  event TEXT DEFAULT '',
  client_ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  url TEXT DEFAULT '',
  method TEXT DEFAULT '',
  details JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  request_id TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}'
);

-- rate_limits
CREATE TABLE IF NOT EXISTS rate_limits (
  id TEXT PRIMARY KEY,
  client_id TEXT DEFAULT '',
  count INTEGER DEFAULT 0,
  window_start TIMESTAMPTZ,
  is_blocked BOOLEAN DEFAULT false,
  blocked_until TIMESTAMPTZ,
  last_updated TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}'
);

-- public_tool_usage
CREATE TABLE IF NOT EXISTS public_tool_usage (
  id TEXT PRIMARY KEY,
  ip_address TEXT DEFAULT '',
  date TEXT DEFAULT '',
  call_count INTEGER DEFAULT 0,
  last_call_at TIMESTAMPTZ,
  last_tool TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}'
);

-- system_config
CREATE TABLE IF NOT EXISTS system_config (
  id TEXT PRIMARY KEY,
  free_limit INTEGER DEFAULT 0,
  starter_limit INTEGER DEFAULT 0,
  professional_limit INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ========================================
-- GROUP J: Auth & OTP (3 tables)
-- ========================================

-- email_otp_temp
CREATE TABLE IF NOT EXISTS email_otp_temp (
  id TEXT PRIMARY KEY,
  email TEXT DEFAULT '',
  otp TEXT DEFAULT '',
  otp_expiry TIMESTAMPTZ,
  purpose TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- otp_verification
CREATE TABLE IF NOT EXISTS otp_verification (
  id TEXT PRIMARY KEY,
  phone TEXT DEFAULT '',
  otp TEXT DEFAULT '',
  otp_expiry TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- demo_requests
CREATE TABLE IF NOT EXISTS demo_requests (
  id TEXT PRIMARY KEY,
  contact_type TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  restaurant_name TEXT DEFAULT '',
  comment TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ========================================
-- GROUP K: AI & Chatbot (5 tables)
-- ========================================

-- chatbot_conversations
CREATE TABLE IF NOT EXISTS chatbot_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  messages JSONB DEFAULT '[]',
  last_message TEXT DEFAULT '',
  last_response TEXT DEFAULT '',
  function_called TEXT DEFAULT '',
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  extra_data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chatbot_conversations_restaurant ON chatbot_conversations (restaurant_id);

-- ai_conversations (use ai_ prefix to be specific)
CREATE TABLE IF NOT EXISTS ai_conversations (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  user_id TEXT DEFAULT '',
  query TEXT DEFAULT '',
  response TEXT DEFAULT '',
  intent TEXT DEFAULT '',
  action TEXT DEFAULT '',
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_restaurant ON ai_conversations (restaurant_id);

-- rag_knowledge
CREATE TABLE IF NOT EXISTS rag_knowledge (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  content TEXT DEFAULT '',
  type TEXT DEFAULT '',
  embedding JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  chunk_index INTEGER DEFAULT 0,
  total_chunks INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rag_knowledge_restaurant ON rag_knowledge (restaurant_id);

-- token_usage
CREATE TABLE IF NOT EXISTS token_usage (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  date TEXT DEFAULT '',
  model TEXT DEFAULT '',
  total_tokens INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost NUMERIC(12,6) DEFAULT 0,
  request_count INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  last_updated TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_usage_restaurant ON token_usage (restaurant_id);

-- query_cache
CREATE TABLE IF NOT EXISTS query_cache (
  id TEXT PRIMARY KEY,
  query TEXT DEFAULT '',
  response TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  model TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_query_cache_restaurant ON query_cache (restaurant_id);

-- ========================================
-- GROUP L: Bar Inventory (2 tables)
-- ========================================

-- GROUP L: Bar Inventory — SKIPPED (2 tables already exist from earlier phases)
-- bar_bottles, bar_reconciliation

-- ========================================
-- GROUP M: Staff & Scheduling (3 tables)
-- ========================================

-- staff_availability — SKIPPED (already exists from earlier phase)

-- staff_locations
CREATE TABLE IF NOT EXISTS staff_locations (
  id TEXT PRIMARY KEY,
  staff_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  latitude NUMERIC(10,7),
  longitude NUMERIC(11,7),
  accuracy NUMERIC(10,2),
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  type TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_staff_locations_restaurant ON staff_locations (restaurant_id);

-- staff_locations_latest
CREATE TABLE IF NOT EXISTS staff_locations_latest (
  id TEXT PRIMARY KEY,
  staff_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  latitude NUMERIC(10,7),
  longitude NUMERIC(11,7),
  accuracy NUMERIC(10,2),
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT false,
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_staff_locations_latest_restaurant ON staff_locations_latest (restaurant_id);

-- ========================================
-- GROUP N: Miscellaneous (9 tables)
-- ========================================

-- pos_invoices (use pos_ prefix to avoid clash with inv_invoices)
CREATE TABLE IF NOT EXISTS pos_invoices (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  order_id TEXT DEFAULT '',
  invoice_number TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  subtotal NUMERIC(12,2) DEFAULT 0,
  tax NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  discount NUMERIC(12,2) DEFAULT 0,
  customer_name TEXT DEFAULT '',
  payment_method TEXT DEFAULT '',
  cash_received NUMERIC(12,2) DEFAULT 0,
  change_returned NUMERIC(12,2) DEFAULT 0,
  invoice_date TIMESTAMPTZ,
  generated_by TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_pos_invoices_restaurant ON pos_invoices (restaurant_id);

-- discount_approvals
CREATE TABLE IF NOT EXISTS discount_approvals (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  requested_by TEXT DEFAULT '',
  order_id TEXT DEFAULT '',
  discount_percent NUMERIC(5,2) DEFAULT 0,
  discount_amount NUMERIC(12,2) DEFAULT 0,
  reason TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  approved_by TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_discount_approvals_restaurant ON discount_approvals (restaurant_id);

-- owner_preferences
CREATE TABLE IF NOT EXISTS owner_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  insight_categories JSONB DEFAULT '[]',
  preferred_metrics JSONB DEFAULT '[]',
  dashboard_layout JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_preferences_user ON owner_preferences (user_id);

-- tax_settings
CREATE TABLE IF NOT EXISTS tax_settings (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  tax_rate NUMERIC(5,2) DEFAULT 0,
  tax_name TEXT DEFAULT '',
  tax_type TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tax_settings_restaurant ON tax_settings (restaurant_id);

-- legacy_staff (use legacy_ prefix to avoid clash with staff_users)
CREATE TABLE IF NOT EXISTS legacy_staff (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  role TEXT DEFAULT '',
  address TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT true,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_legacy_staff_restaurant ON legacy_staff (restaurant_id);

-- coupons
CREATE TABLE IF NOT EXISTS coupons (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  code TEXT DEFAULT '',
  type TEXT DEFAULT '',
  value NUMERIC(12,2) DEFAULT 0,
  min_order_amount NUMERIC(12,2) DEFAULT 0,
  max_uses INTEGER DEFAULT 0,
  used_count INTEGER DEFAULT 0,
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  is_public BOOLEAN DEFAULT false,
  applicable_to TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coupons_restaurant ON coupons (restaurant_id);

-- menu_bulk_delete_logs
CREATE TABLE IF NOT EXISTS menu_bulk_delete_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  restaurant_name TEXT DEFAULT '',
  deleted_by TEXT DEFAULT '',
  deleted_by_name TEXT DEFAULT '',
  deleted_by_email TEXT DEFAULT '',
  deleted_by_phone TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  deleted_count INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  deleted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_menu_bulk_delete_logs_restaurant ON menu_bulk_delete_logs (restaurant_id);

-- aggregator_webhook_logs
CREATE TABLE IF NOT EXISTS aggregator_webhook_logs (
  id TEXT PRIMARY KEY,
  source TEXT DEFAULT '',
  event TEXT DEFAULT '',
  payload JSONB DEFAULT '{}',
  signature TEXT DEFAULT '',
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  extra_data JSONB DEFAULT '{}'
);

-- whatsapp_order_logs
CREATE TABLE IF NOT EXISTS whatsapp_order_logs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  message TEXT DEFAULT '',
  parsed_order JSONB DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_order_logs_restaurant ON whatsapp_order_logs (restaurant_id);
`;

async function main() {
  try {
    console.log('Creating 64 system/misc tables...');
    await query(DDL);
    console.log('All 64 tables created successfully.');
  } catch (err) {
    console.error('Error creating tables:', err.message);
    process.exit(1);
  } finally {
    await getPool().end();
  }
}

main();
