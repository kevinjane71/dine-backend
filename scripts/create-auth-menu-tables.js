/**
 * create-auth-menu-tables.js — Create 6 PG tables for Auth/Menu/User collections.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/create-auth-menu-tables.js
 */

const { query, getPool } = require('../repos/pgClient');

const DDL = `
-- menus
CREATE TABLE IF NOT EXISTS menus (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_menus_restaurant ON menus (restaurant_id);

-- menu_items
CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  name_ar TEXT DEFAULT '',
  description TEXT DEFAULT '',
  price NUMERIC(12,2) DEFAULT 0,
  category TEXT DEFAULT '',
  category_id TEXT DEFAULT '',
  food_type TEXT DEFAULT '',
  spice_level TEXT DEFAULT '',
  is_veg BOOLEAN DEFAULT false,
  is_available BOOLEAN DEFAULT true,
  available BOOLEAN DEFAULT true,
  short_code TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  "order" INTEGER DEFAULT 0,
  image TEXT DEFAULT '',
  image_keyword TEXT DEFAULT '',
  stock_quantity NUMERIC(12,2),
  low_stock_threshold NUMERIC(12,2) DEFAULT 5,
  is_stock_managed BOOLEAN DEFAULT false,
  deduction_quantity NUMERIC(12,2) DEFAULT 1,
  available_from TEXT DEFAULT '',
  available_until TEXT DEFAULT '',
  sold_by_weight BOOLEAN DEFAULT false,
  price_unit TEXT DEFAULT '',
  plu_code TEXT DEFAULT '',
  source TEXT DEFAULT '',
  unit TEXT DEFAULT '',
  weight TEXT DEFAULT '',
  shelf_life INTEGER,
  serving_size TEXT DEFAULT '',
  tax_group_id TEXT DEFAULT '',
  tax_inclusive BOOLEAN,
  discount_applicable BOOLEAN DEFAULT true,
  is_favorite BOOLEAN DEFAULT false,
  hide_image BOOLEAN DEFAULT false,
  is_out_of_stock BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  org_menu_item_id TEXT DEFAULT '',
  template_id TEXT DEFAULT '',
  variants JSONB DEFAULT '[]',
  customizations JSONB DEFAULT '[]',
  images JSONB DEFAULT '[]',
  allergens JSONB DEFAULT '[]',
  tags JSONB DEFAULT '[]',
  pricing_rules JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant ON menu_items (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_category ON menu_items (restaurant_id, category);
CREATE INDEX IF NOT EXISTS idx_menu_items_restaurant_status ON menu_items (restaurant_id, status);

-- app_users (avoids conflict with PG system table "users")
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  name TEXT DEFAULT '',
  password TEXT DEFAULT '',
  role TEXT DEFAULT 'owner',
  email_verified BOOLEAN DEFAULT false,
  phone_verified BOOLEAN DEFAULT false,
  provider TEXT DEFAULT '',
  setup_complete BOOLEAN DEFAULT false,
  google_uid TEXT DEFAULT '',
  apple_uid TEXT DEFAULT '',
  firebase_uid TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  picture TEXT DEFAULT '',
  temporary_password BOOLEAN DEFAULT false,
  restaurant_name TEXT DEFAULT '',
  login_id TEXT DEFAULT '',
  username TEXT DEFAULT '',
  username_lower TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_by_role TEXT DEFAULT '',
  last_login TIMESTAMPTZ,
  last_login_platform TEXT DEFAULT '',
  pin_hash TEXT DEFAULT '',
  pin_enabled BOOLEAN DEFAULT false,
  pin_updated_at TIMESTAMPTZ,
  pin_attempts INTEGER DEFAULT 0,
  pin_locked_until TIMESTAMPTZ,
  tip_earnings NUMERIC(12,2) DEFAULT 0,
  admin_note TEXT DEFAULT '',
  admin_note_updated_at TIMESTAMPTZ,
  tip_history JSONB DEFAULT '[]',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_users_email ON app_users (email);
CREATE INDEX IF NOT EXISTS idx_app_users_phone ON app_users (phone);
CREATE INDEX IF NOT EXISTS idx_app_users_firebase_uid ON app_users (firebase_uid);
CREATE INDEX IF NOT EXISTS idx_app_users_username_lower ON app_users (username_lower);
CREATE INDEX IF NOT EXISTS idx_app_users_login_id ON app_users (login_id);

-- user_restaurants
CREATE TABLE IF NOT EXISTS user_restaurants (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT '',
  restaurant_id TEXT DEFAULT '',
  role TEXT DEFAULT '',
  page_access JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_restaurants_user ON user_restaurants (user_id);
CREATE INDEX IF NOT EXISTS idx_user_restaurants_restaurant ON user_restaurants (restaurant_id);
CREATE INDEX IF NOT EXISTS idx_user_restaurants_user_restaurant ON user_restaurants (user_id, restaurant_id);

-- staff_credentials
CREATE TABLE IF NOT EXISTS staff_credentials (
  id TEXT PRIMARY KEY,
  staff_id TEXT DEFAULT '',
  login_id TEXT DEFAULT '',
  temporary_password TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- dine_user_data
CREATE TABLE IF NOT EXISTS dine_user_data (
  id TEXT PRIMARY KEY,
  uid TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  role TEXT DEFAULT 'owner',
  app TEXT DEFAULT 'Dine',
  subscription JSONB DEFAULT '{}',
  restaurant_info JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_updated TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dine_user_data_email ON dine_user_data (email);
`;

async function main() {
  try {
    console.log('Creating 6 Auth/Menu/User tables...');
    await query(DDL);
    console.log('All 6 Auth/Menu/User tables created successfully.');
  } catch (err) {
    console.error('Error creating tables:', err.message);
    process.exit(1);
  } finally {
    await getPool().end();
  }
}

main();
