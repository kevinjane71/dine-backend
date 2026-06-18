-- restaurants table for Firestore → PostgreSQL migration
-- Stores all restaurant configuration, settings, and metadata.
-- Complex nested objects (posSettings, customerAppSettings, etc.) stored as JSONB.

BEGIN;

CREATE TABLE IF NOT EXISTS restaurants (
  id TEXT PRIMARY KEY,                       -- Firestore doc ID
  owner_id TEXT,                             -- Firebase Auth UID of owner
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  cuisine JSONB DEFAULT '[]',                -- Array of cuisine types
  description TEXT DEFAULT '',
  logo TEXT DEFAULT '',
  cover_image TEXT DEFAULT '',
  business_type TEXT DEFAULT 'restaurant',   -- restaurant, cafe, bar, bakery, etc.
  status TEXT DEFAULT 'active',              -- active, inactive, deleted
  is_active BOOLEAN DEFAULT TRUE,
  country_code TEXT DEFAULT 'IN',
  currency_symbol TEXT DEFAULT '₹',

  -- URL & Identity
  subdomain TEXT,                            -- Unique subdomain for multi-tenancy
  subdomain_enabled BOOLEAN DEFAULT FALSE,
  url_slug TEXT,                             -- Pretty URL slug
  restaurant_code TEXT,                      -- Code for customer app access
  qr_data TEXT,                              -- QR code data URL (NOT the base64 image)

  -- Legal & Compliance
  legal_business_name TEXT,
  gstin TEXT,
  fssai TEXT,
  pan_number TEXT,
  business_registration_number TEXT,
  show_gst_on_invoice BOOLEAN DEFAULT FALSE,

  -- Capacity & Staffing
  staff_count INTEGER DEFAULT 0,
  seating_capacity INTEGER DEFAULT 0,
  onboarding_step INTEGER DEFAULT 0,

  -- Parent (for sub-restaurants / multi-location)
  parent_restaurant_id TEXT,

  -- Menu flags
  has_default_menu BOOLEAN DEFAULT FALSE,

  -- Complex Settings (JSONB)
  operating_hours JSONB DEFAULT '{}',
  features JSONB DEFAULT '[]',              -- Array of feature flags
  pos_settings JSONB DEFAULT '{}',
  order_settings JSONB DEFAULT '{}',
  print_settings JSONB DEFAULT '{}',
  ecr_settings JSONB DEFAULT '{}',
  pricing_settings JSONB DEFAULT '{}',
  tax_settings JSONB DEFAULT '{}',
  currency_settings JSONB DEFAULT '{}',
  customer_app_settings JSONB DEFAULT '{}',
  billing_settings JSONB DEFAULT '{}',
  billing_audit JSONB DEFAULT '{}',
  booking_settings JSONB DEFAULT '{}',
  feedback_settings JSONB DEFAULT '{}',
  bar_inventory_settings JSONB DEFAULT '{}',
  discount_approval_settings JSONB DEFAULT '{}',
  kot_settings JSONB DEFAULT '{}',

  -- Catch-all for unmapped/future fields
  extra_data JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_subdomain ON restaurants (subdomain) WHERE subdomain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_url_slug ON restaurants (url_slug) WHERE url_slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_code ON restaurants (restaurant_code) WHERE restaurant_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_restaurants_owner ON restaurants (owner_id);
CREATE INDEX IF NOT EXISTS idx_restaurants_parent ON restaurants (parent_restaurant_id) WHERE parent_restaurant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_restaurants_status ON restaurants (status);

-- Auto-update timestamp trigger
DROP TRIGGER IF EXISTS restaurants_updated_at ON restaurants;
CREATE TRIGGER restaurants_updated_at
  BEFORE UPDATE ON restaurants
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

COMMIT;
