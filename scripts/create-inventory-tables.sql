-- Inventory ecosystem tables for Firestore → PostgreSQL migration
-- 7 tables: inventory, inventory_transactions, stock_batches, waste_entries,
--           recipes, bar_bottles, bar_reconciliation

BEGIN;

-- Helper function for auto-updating updated_at (idempotent)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════
-- 1. inventory — stock items
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,

  name TEXT NOT NULL,
  category TEXT,
  unit TEXT,
  current_stock NUMERIC(14,4) DEFAULT 0,
  min_stock NUMERIC(14,4) DEFAULT 0,
  max_stock NUMERIC(14,4) DEFAULT 0,
  cost_per_unit NUMERIC(14,4) DEFAULT 0,

  supplier TEXT,
  description TEXT,
  barcode TEXT,
  location TEXT,
  status TEXT DEFAULT 'good',

  -- Menu item linkage
  linked_menu_item_id TEXT,
  linked_menu_item_name TEXT,

  -- Expiry
  expiry_date TIMESTAMPTZ,
  mfg_date TIMESTAMPTZ,
  expiry_days INTEGER,

  -- Waste tracking
  wasted_qty NUMERIC(14,4) DEFAULT 0,

  -- Audit
  created_by TEXT,
  updated_by TEXT,
  last_updated TIMESTAMPTZ,

  -- Catch-all
  extra_data JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_restaurant ON inventory (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_restaurant_category ON inventory (restaurant_id, category);
CREATE INDEX IF NOT EXISTS idx_inventory_restaurant_status ON inventory (restaurant_id, status);

DROP TRIGGER IF EXISTS inventory_updated_at ON inventory;
CREATE TRIGGER inventory_updated_at
  BEFORE UPDATE ON inventory
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════
-- 2. inventory_transactions — audit log of all stock movements
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  inventory_item_id TEXT,
  inventory_item_name TEXT,

  type TEXT NOT NULL,                        -- ADDITION, DEDUCTION, ADJUSTMENT, WASTE
  source TEXT,                               -- ORDER, MANUAL, PRODUCTION, AUDIT, EXPIRY, etc.
  quantity_change NUMERIC(14,4) DEFAULT 0,
  previous_stock NUMERIC(14,4),
  new_stock NUMERIC(14,4),
  unit TEXT,

  cost_per_unit NUMERIC(14,4),
  previous_cost_per_unit NUMERIC(14,4),
  total_cost NUMERIC(14,2),

  date TIMESTAMPTZ,
  reference_id TEXT,                         -- order/batch/audit ID
  batch_ids JSONB DEFAULT '[]',              -- array of batch IDs used
  performed_by TEXT,
  notes TEXT,
  original_transaction_id TEXT,              -- for reversals

  -- Catch-all
  extra_data JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inv_tx_restaurant ON inventory_transactions (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_item ON inventory_transactions (restaurant_id, inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_inv_tx_date ON inventory_transactions (restaurant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_inv_tx_type ON inventory_transactions (restaurant_id, type);
CREATE INDEX IF NOT EXISTS idx_inv_tx_reference ON inventory_transactions (reference_id);

-- ═══════════════════════════════════════════════════════════════
-- 3. stock_batches — FIFO batch tracking
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stock_batches (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  inventory_item_id TEXT NOT NULL,
  inventory_item_name TEXT,

  quantity NUMERIC(14,4) DEFAULT 0,          -- initial quantity
  initial_qty NUMERIC(14,4) DEFAULT 0,
  remaining_qty NUMERIC(14,4) DEFAULT 0,
  unit TEXT,

  mfg_date TIMESTAMPTZ,
  expiry_date TIMESTAMPTZ,
  expiry_days INTEGER,
  cost_per_unit NUMERIC(14,4) DEFAULT 0,
  supplier TEXT,
  source TEXT,                               -- manual, production, menu-link
  status TEXT DEFAULT 'active',              -- active, depleted, cancelled
  batch_id TEXT,                             -- external batch identifier

  added_by TEXT,

  -- Catch-all
  extra_data JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_batches_restaurant ON stock_batches (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_stock_batches_item ON stock_batches (restaurant_id, inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_stock_batches_active ON stock_batches (restaurant_id, inventory_item_id, status)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_stock_batches_expiry ON stock_batches (expiry_date)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS stock_batches_updated_at ON stock_batches;
CREATE TRIGGER stock_batches_updated_at
  BEFORE UPDATE ON stock_batches
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════
-- 4. waste_entries — waste / spoilage / shrinkage log
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS waste_entries (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  item_id TEXT,
  item_name TEXT,

  quantity NUMERIC(14,4) DEFAULT 0,
  unit TEXT,
  reason TEXT,                               -- expired, spillage, breakage, etc.
  source TEXT,                               -- MANUAL, AUTO_EXPIRY, PRODUCTION, etc.
  cost_per_unit NUMERIC(14,4),
  waste_value NUMERIC(14,2),
  total_cost NUMERIC(14,2),

  batch_id TEXT,
  notes TEXT,
  recorded_by TEXT,
  date TIMESTAMPTZ,

  -- Catch-all
  extra_data JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_waste_entries_restaurant ON waste_entries (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_waste_entries_date ON waste_entries (restaurant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_waste_entries_item ON waste_entries (restaurant_id, item_id);

-- ═══════════════════════════════════════════════════════════════
-- 5. recipes — recipe definitions (menu item → ingredients)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  menu_item_id TEXT,
  menu_item_name TEXT,

  name TEXT,
  description TEXT,
  category TEXT,
  servings INTEGER,
  prep_time INTEGER,                         -- minutes
  cook_time INTEGER,                         -- minutes

  ingredients JSONB DEFAULT '[]',            -- array of ingredient objects
  instructions JSONB DEFAULT '[]',           -- array of instruction strings

  is_active BOOLEAN DEFAULT true,
  is_auto_generated BOOLEAN DEFAULT false,

  -- Audit
  created_by TEXT,
  updated_by TEXT,

  -- Catch-all
  extra_data JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recipes_restaurant ON recipes (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_recipes_menu_item ON recipes (restaurant_id, menu_item_id);

DROP TRIGGER IF EXISTS recipes_updated_at ON recipes;
CREATE TRIGGER recipes_updated_at
  BEFORE UPDATE ON recipes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════
-- 6. bar_bottles — individual bottle tracking (weight-based)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bar_bottles (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  inventory_item_id TEXT,
  menu_item_id TEXT,

  barcode TEXT,
  name TEXT,
  brand TEXT,
  category TEXT,
  category_id TEXT,

  -- Size & pour
  bottle_size NUMERIC(10,2),                 -- total capacity in ml
  peg_size NUMERIC(10,2),                    -- standard pour size in ml

  -- Weight tracking (grams)
  full_weight NUMERIC(10,2),
  tare_weight NUMERIC(10,2),
  opening_weight NUMERIC(10,2),
  current_weight NUMERIC(10,2),
  closing_weight NUMERIC(10,2),

  -- Status & lifecycle
  status TEXT DEFAULT 'sealed',              -- sealed, opened, in-use, empty
  opened_at TIMESTAMPTZ,
  opened_by TEXT,
  empty_at TIMESTAMPTZ,

  -- Consumption tracking
  total_pegs_expected NUMERIC(10,2),
  total_pegs_poured NUMERIC(10,2) DEFAULT 0,
  total_ml_poured NUMERIC(10,2) DEFAULT 0,
  total_ml_sold NUMERIC(10,2) DEFAULT 0,
  wastage NUMERIC(10,2) DEFAULT 0,
  wastage_entries JSONB DEFAULT '[]',        -- array of wastage entry objects

  -- Cost & batch
  batch_id TEXT,
  cost_price NUMERIC(14,2),
  ml_per_gram NUMERIC(6,4) DEFAULT 1.0,

  -- Audit
  created_by TEXT,

  -- Catch-all
  extra_data JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bar_bottles_restaurant ON bar_bottles (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_bar_bottles_status ON bar_bottles (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_bar_bottles_item ON bar_bottles (restaurant_id, inventory_item_id);

DROP TRIGGER IF EXISTS bar_bottles_updated_at ON bar_bottles;
CREATE TRIGGER bar_bottles_updated_at
  BEFORE UPDATE ON bar_bottles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ═══════════════════════════════════════════════════════════════
-- 7. bar_reconciliation — daily/shift bar reconciliation
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bar_reconciliation (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,

  date TEXT,                                 -- YYYY-MM-DD
  shift TEXT,
  status TEXT DEFAULT 'open',                -- open, closed

  opening_snapshot JSONB DEFAULT '[]',       -- array of bottle opening states
  closing_snapshot JSONB DEFAULT '[]',       -- array of bottle closing states

  total_ml_consumed NUMERIC(10,2) DEFAULT 0,
  total_ml_sold NUMERIC(10,2) DEFAULT 0,
  total_variance NUMERIC(10,2) DEFAULT 0,
  total_variance_value NUMERIC(14,2) DEFAULT 0,

  opened_at TIMESTAMPTZ,
  opened_by TEXT,
  closed_at TIMESTAMPTZ,
  closed_by TEXT,
  notes TEXT,

  -- Catch-all
  extra_data JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bar_recon_restaurant ON bar_reconciliation (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_bar_recon_date ON bar_reconciliation (restaurant_id, date DESC);

COMMIT;
