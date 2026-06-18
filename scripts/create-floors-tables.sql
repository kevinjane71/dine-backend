-- floors + tables tables for Firestore → PostgreSQL migration
-- Flattens Firestore subcollection: restaurants/{rid}/floors/{fid}/tables/{tid}
-- Into two flat tables with explicit restaurant_id + floor_id columns
--
-- NOTE: Floor IDs in Firestore are slug-based (e.g. "floor_ground_floor") and
-- repeat across restaurants. Composite PK (id, restaurant_id) is required.

BEGIN;

-- ─── Floors ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS floors (
  id TEXT NOT NULL,                       -- e.g. "floor_ground_floor" (NOT globally unique)
  restaurant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  section TEXT,
  area_charge_type TEXT DEFAULT 'none',   -- 'none', 'percentage', 'flat'
  area_charge_value NUMERIC(10,2) DEFAULT 0,
  sort_order INTEGER DEFAULT 0,          -- renamed from Firestore 'order' (reserved word)

  -- Catch-all for unmapped fields
  extra_data JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (id, restaurant_id)
);

CREATE INDEX IF NOT EXISTS idx_floors_restaurant ON floors (restaurant_id);

-- ─── Tables ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tables (
  id TEXT PRIMARY KEY,                    -- Firestore auto-generated doc ID (globally unique)
  restaurant_id TEXT NOT NULL,
  floor_id TEXT NOT NULL,
  name TEXT NOT NULL,                     -- Table number/name: "1", "2", "VIP-1"
  floor_name TEXT,                        -- Denormalized floor name for compatibility
  capacity INTEGER DEFAULT 4,
  section TEXT DEFAULT 'Main',
  status TEXT DEFAULT 'available',        -- available, occupied, serving, reserved, out-of-service, cleaning, maintenance
  current_order_id TEXT,                  -- References orders collection
  last_order_time TIMESTAMPTZ,

  -- Catch-all for unmapped fields
  extra_data JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  FOREIGN KEY (floor_id, restaurant_id) REFERENCES floors(id, restaurant_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON tables (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_tables_floor ON tables (floor_id);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant_status ON tables (restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant_name ON tables (restaurant_id, name);

-- Auto-update timestamp triggers
DROP TRIGGER IF EXISTS floors_updated_at ON floors;
CREATE TRIGGER floors_updated_at
  BEFORE UPDATE ON floors
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS tables_updated_at ON tables;
CREATE TRIGGER tables_updated_at
  BEFORE UPDATE ON tables
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMIT;
