-- daily_stats table for Firestore → PostgreSQL migration
-- Doc ID pattern: {restaurantId}_{YYYY-MM-DD} or {restaurantId}_sub_{subId}_{YYYY-MM-DD}

BEGIN;

-- Helper function for auto-updating updated_at (idempotent)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS daily_stats (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  date TEXT NOT NULL,                           -- "YYYY-MM-DD"
  sub_restaurant_id TEXT,
  sub_restaurant_name TEXT,

  -- Aggregates
  total_orders INTEGER DEFAULT 0,
  total_revenue NUMERIC(14,2) DEFAULT 0,
  total_revenue_with_tax NUMERIC(14,2) DEFAULT 0,
  total_due_amount NUMERIC(14,2) DEFAULT 0,
  total_tax NUMERIC(14,2) DEFAULT 0,
  total_discounts NUMERIC(14,2) DEFAULT 0,
  total_refunds NUMERIC(14,2) DEFAULT 0,

  -- Hourly buckets (0-23)
  hour_00 INTEGER DEFAULT 0, hour_01 INTEGER DEFAULT 0, hour_02 INTEGER DEFAULT 0,
  hour_03 INTEGER DEFAULT 0, hour_04 INTEGER DEFAULT 0, hour_05 INTEGER DEFAULT 0,
  hour_06 INTEGER DEFAULT 0, hour_07 INTEGER DEFAULT 0, hour_08 INTEGER DEFAULT 0,
  hour_09 INTEGER DEFAULT 0, hour_10 INTEGER DEFAULT 0, hour_11 INTEGER DEFAULT 0,
  hour_12 INTEGER DEFAULT 0, hour_13 INTEGER DEFAULT 0, hour_14 INTEGER DEFAULT 0,
  hour_15 INTEGER DEFAULT 0, hour_16 INTEGER DEFAULT 0, hour_17 INTEGER DEFAULT 0,
  hour_18 INTEGER DEFAULT 0, hour_19 INTEGER DEFAULT 0, hour_20 INTEGER DEFAULT 0,
  hour_21 INTEGER DEFAULT 0, hour_22 INTEGER DEFAULT 0, hour_23 INTEGER DEFAULT 0,

  -- Dynamic buckets stored as JSONB
  payment_methods JSONB DEFAULT '{}',           -- {"cash": {"transactions": N, "amount": N}, ...}
  order_types JSONB DEFAULT '{}',               -- {"dine_in": {"count": N, "revenue": N}, ...}
  item_counts JSONB DEFAULT '{}',               -- {"Item Name": {"qty": N, "revenue": N}, ...}
  category_breakdown JSONB DEFAULT '{}',        -- {"Category": {"itemsSold": N, "revenue": N}, ...}
  customer_ids JSONB DEFAULT '[]',              -- array of customer IDs

  -- Catch-all for unmapped fields
  extra_data JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fetching by restaurant + date range
CREATE INDEX IF NOT EXISTS idx_daily_stats_restaurant_date ON daily_stats (restaurant_id, date DESC);

-- Index for super admin: fetch all stats for a given date
CREATE INDEX IF NOT EXISTS idx_daily_stats_date ON daily_stats (date);

-- Auto-update timestamp trigger
DROP TRIGGER IF EXISTS daily_stats_updated_at ON daily_stats;
CREATE TRIGGER daily_stats_updated_at
  BEFORE UPDATE ON daily_stats
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMIT;
