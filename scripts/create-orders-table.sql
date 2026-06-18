-- PostgreSQL Orders Table Schema
-- Run this after creating Cloud SQL instance and database
-- gcloud sql connect dine-orders --user=dine_app --database=dine

BEGIN;

CREATE TABLE IF NOT EXISTS orders (
  -- Core identifiers
  id TEXT PRIMARY KEY,                          -- Firestore doc ID (keep same IDs)
  restaurant_id TEXT NOT NULL,
  order_number TEXT,                            -- e.g. "ORD-1234567890-ABC1"
  daily_order_id INTEGER,
  tab_number INTEGER,                           -- for bar tabs / saved orders
  idempotency_key TEXT,                         -- offline sync deduplication
  sync_source TEXT,                             -- 'online' | 'offline'

  -- Order type & status
  order_type TEXT DEFAULT 'dine-in',            -- dine-in, takeaway, delivery, customer_self_order
  status TEXT NOT NULL DEFAULT 'pending',       -- pending, confirmed, preparing, ready, served, completed, cancelled, saved, deleted, expired
  last_status TEXT,                             -- previous status (audit trail)

  -- Table / location info
  table_number TEXT,
  table_id TEXT,
  floor_id TEXT,
  floor_name TEXT,
  table_section TEXT,
  room_number TEXT,                             -- hotel room

  -- Customer info (denormalized fields)
  customer_id TEXT,
  customer_name TEXT,
  customer_phone TEXT,
  customer_info JSONB,                          -- { phone, name, email, city, dob, seatNumber }

  -- Staff info
  staff_info JSONB,                             -- { userId, name, role, phone, loginId }
  assigned_staff JSONB,                         -- { id, name }

  -- Items (stored as JSONB — same structure as Firestore)
  items JSONB NOT NULL DEFAULT '[]',

  -- Pricing
  subtotal NUMERIC(12,2) DEFAULT 0,
  total_amount NUMERIC(12,2) DEFAULT 0,
  final_amount NUMERIC(12,2) DEFAULT 0,

  -- Discounts
  discount_amount NUMERIC(12,2) DEFAULT 0,
  offer_discount NUMERIC(12,2) DEFAULT 0,
  manual_discount NUMERIC(12,2) DEFAULT 0,
  manual_discount_type TEXT,                    -- 'percentage' | 'fixed'
  manual_discount_value NUMERIC(12,2) DEFAULT 0,
  loyalty_discount NUMERIC(12,2) DEFAULT 0,
  total_discount_amount NUMERIC(12,2) DEFAULT 0,
  coupon_code TEXT,
  coupon_id TEXT,
  coupon_discount NUMERIC(12,2) DEFAULT 0,
  wallet_redeem_amount NUMERIC(12,2) DEFAULT 0,

  -- Offers & pricing rules
  applied_offer JSONB,                          -- { id, name, discountType, discountValue, discountApplied, scope, promotionType }
  applied_offers JSONB DEFAULT '[]',
  selected_offer_name TEXT,
  pricing_rule_id TEXT,
  pricing_rule_name TEXT,
  applied_pricing_rules JSONB DEFAULT '[]',
  zone_surcharge NUMERIC(12,2) DEFAULT 0,

  -- Taxes
  tax_amount NUMERIC(12,2) DEFAULT 0,
  tax_breakdown JSONB DEFAULT '[]',
  tax_inclusive_mode TEXT,                       -- 'inclusive' | 'exclusive' | 'mixed'

  -- Billing components
  service_charge_rate NUMERIC(5,2) DEFAULT 0,
  service_charge_amount NUMERIC(12,2) DEFAULT 0,
  service_charge_enabled BOOLEAN DEFAULT FALSE,
  tip_amount NUMERIC(12,2) DEFAULT 0,
  tip_percentage NUMERIC(5,2) DEFAULT 0,
  round_off_amount NUMERIC(12,2) DEFAULT 0,
  delivery_charge NUMERIC(12,2) DEFAULT 0,
  packing_charge NUMERIC(12,2) DEFAULT 0,

  -- Payment
  payment_method TEXT DEFAULT 'cash',           -- cash, card, razorpay, upi, wallet, check, split, etc.
  payment_status TEXT DEFAULT 'unpaid',         -- pending, paid, due, partial, hotel-billing, completed, unpaid
  paid_amount NUMERIC(12,2) DEFAULT 0,
  outstanding_amount NUMERIC(12,2) DEFAULT 0,
  cash_received NUMERIC(12,2) DEFAULT 0,
  change_returned NUMERIC(12,2) DEFAULT 0,
  split_payments JSONB,
  split_bill JSONB,                             -- { method, splits[] }

  -- Loyalty
  loyalty_points_earned INTEGER DEFAULT 0,
  loyalty_points_redeemed INTEGER DEFAULT 0,
  redeem_loyalty_points INTEGER DEFAULT 0,

  -- KOT / Kitchen
  notes TEXT,
  special_instructions TEXT,
  kot_sent BOOLEAN DEFAULT FALSE,
  kot_printed BOOLEAN DEFAULT FALSE,
  kot_printed_at TIMESTAMPTZ,
  kot_printed_stations JSONB,
  kot_number INTEGER,
  kot_time TIMESTAMPTZ,
  cooking_start_time TIMESTAMPTZ,
  cooking_end_time TIMESTAMPTZ,

  -- Scheduling
  is_scheduled BOOLEAN DEFAULT FALSE,
  scheduled_for TIMESTAMPTZ,

  -- Source / Aggregator
  source TEXT,                                  -- 'pos', 'customer_app', 'whatsapp', 'talabat', 'phone_agent'
  aggregator_order_id TEXT,
  aggregator_platform TEXT,

  -- Delivery
  delivery_info JSONB,
  delivery_address JSONB,
  delivery_partner_id TEXT,

  -- Multi-location
  sub_restaurant_id TEXT,
  sub_restaurant_name TEXT,

  -- Hotel
  linked_to_hotel BOOLEAN DEFAULT FALSE,
  hotel_check_in_id TEXT,
  hotel_billed_and_checked_out BOOLEAN DEFAULT FALSE,

  -- Edit tracking
  edit_count INTEGER DEFAULT 0,
  edit_reason TEXT,
  pre_edit_snapshot JSONB,

  -- Cancellation
  cancelled_at TIMESTAMPTZ,
  cancelled_by TEXT,
  cancellation_reason TEXT,

  -- Refund
  refunded_at TIMESTAMPTZ,
  refunded_by TEXT,
  refund_amount NUMERIC(12,2) DEFAULT 0,
  refund_reason TEXT,
  refund_type TEXT,                              -- 'full' | 'partial'

  -- Comp / Void
  comp_amount NUMERIC(12,2) DEFAULT 0,
  void_items JSONB,
  removed_items JSONB DEFAULT '[]',

  -- Misc
  share_token TEXT,                             -- public invoice link
  bill_printed BOOLEAN DEFAULT FALSE,
  price_discrepancies JSONB,

  -- Catch-all for unmapped fields (future-proof)
  extra_data JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ
);

-- ============================================================
-- INDEXES for the 6 hot query patterns
-- ============================================================

-- GET /api/orders/:restaurantId — paginated order list (most called endpoint)
-- Filters: restaurant_id + status + created_at DESC
CREATE INDEX idx_orders_restaurant_status_created
  ON orders (restaurant_id, status, created_at DESC);

-- GET /api/orders/:restaurantId — date-range queries
CREATE INDEX idx_orders_restaurant_created
  ON orders (restaurant_id, created_at DESC);

-- GET /api/orders/:restaurantId — daily order ID lookup
CREATE INDEX idx_orders_restaurant_daily_id
  ON orders (restaurant_id, daily_order_id);

-- GET /api/kot/:restaurantId — active kitchen orders (yesterday onwards, active statuses)
CREATE INDEX idx_orders_restaurant_active
  ON orders (restaurant_id, created_at DESC)
  WHERE status IN ('pending', 'confirmed', 'preparing', 'ready');

-- GET /api/orders/:restaurantId?todayOnly=true — today's orders (all non-deleted statuses)
CREATE INDEX idx_orders_restaurant_today
  ON orders (restaurant_id, created_at DESC)
  WHERE status IN ('pending', 'confirmed', 'preparing', 'ready', 'completed', 'saved', 'served');

-- Aggregator order lookup (Talabat etc)
CREATE INDEX idx_orders_aggregator
  ON orders (aggregator_order_id)
  WHERE aggregator_order_id IS NOT NULL;

-- Customer phone search
CREATE INDEX idx_orders_customer_phone
  ON orders (restaurant_id, customer_phone)
  WHERE customer_phone IS NOT NULL;

-- Payment status filter (common in order list)
CREATE INDEX idx_orders_payment_status
  ON orders (restaurant_id, payment_status, created_at DESC);

-- Idempotency key (offline sync dedup)
CREATE UNIQUE INDEX idx_orders_idempotency
  ON orders (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Scheduled orders
CREATE INDEX idx_orders_scheduled
  ON orders (restaurant_id, scheduled_for)
  WHERE is_scheduled = TRUE;

-- ============================================================
-- Auto-update updated_at on row changes
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMIT;
