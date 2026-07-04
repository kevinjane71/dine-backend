-- FASSCO Feature Columns Migration
-- Run against the dine PostgreSQL database

-- Feature 1: Cover Count
ALTER TABLE orders ADD COLUMN IF NOT EXISTS covers INTEGER DEFAULT 1;

-- Feature 3: Restore Cancelled Order
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restored_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restored_by TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restored_by_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restore_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS restoration_history JSONB DEFAULT '[]'::jsonb;

-- Feature 4: Cashless Prepaid Card
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wallet_card_number TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wallet_card_barcode TEXT;

-- Indexes for card lookup
CREATE INDEX IF NOT EXISTS idx_customers_wallet_card_number ON customers (restaurant_id, wallet_card_number) WHERE wallet_card_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_wallet_card_barcode ON customers (restaurant_id, wallet_card_barcode) WHERE wallet_card_barcode IS NOT NULL;
