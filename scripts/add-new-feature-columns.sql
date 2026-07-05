-- New Feature Columns Migration (pg-full-migration branch)
-- Run against the dine PostgreSQL database
-- Covers: bill reprint tracking, menu barcode/subCategory, outlet prices, d365 sync log

-- ── Orders: Bill reprint tracking ──
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_reprint_count INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_reprint_history JSONB DEFAULT '[]'::jsonb;

-- ── Menu Items: Barcode, sub-category, modifier groups ──
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS barcode TEXT DEFAULT '';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS barcode_format TEXT DEFAULT '';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sub_category TEXT DEFAULT '';
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS modifier_groups JSONB DEFAULT '[]'::jsonb;

-- ── Org Menu Items (enterprise): Outlet prices, barcode, sub-category, modifier groups ──
ALTER TABLE org_menu_items ADD COLUMN IF NOT EXISTS outlet_prices JSONB DEFAULT '{}'::jsonb;
ALTER TABLE org_menu_items ADD COLUMN IF NOT EXISTS barcode TEXT DEFAULT '';
ALTER TABLE org_menu_items ADD COLUMN IF NOT EXISTS barcode_format TEXT DEFAULT '';
ALTER TABLE org_menu_items ADD COLUMN IF NOT EXISTS sub_category TEXT DEFAULT '';
ALTER TABLE org_menu_items ADD COLUMN IF NOT EXISTS modifier_groups JSONB DEFAULT '[]'::jsonb;

-- ── D365 Sync Log table ──
CREATE TABLE IF NOT EXISTS d365_sync_log (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  type TEXT DEFAULT '',
  date TEXT DEFAULT '',
  status TEXT DEFAULT '',
  order_id TEXT DEFAULT '',
  journal_lines_posted INTEGER DEFAULT 0,
  total_amount NUMERIC DEFAULT 0,
  bc_document_number TEXT DEFAULT '',
  items_synced INTEGER DEFAULT 0,
  customers_synced INTEGER DEFAULT 0,
  error TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  synced_by TEXT DEFAULT '',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  extra_data JSONB DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_d365_sync_log_restaurant ON d365_sync_log (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_d365_sync_log_restaurant_type ON d365_sync_log (restaurant_id, type);
CREATE INDEX IF NOT EXISTS idx_d365_sync_log_synced_at ON d365_sync_log (synced_at DESC);
