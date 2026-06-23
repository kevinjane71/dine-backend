/**
 * create-enterprise-tables.js — Create 8 PG tables for enterprise/org collections.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/create-enterprise-tables.js
 */

const { query, getPool } = require('../repos/pgClient');

const DDL = `
-- ent_organizations (named with ent_ prefix to avoid clash with inv_organizations)
CREATE TABLE IF NOT EXISTS ent_organizations (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  type TEXT DEFAULT 'chain',
  owner_id TEXT DEFAULT '',
  settings JSONB DEFAULT '{}',
  outlets JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ent_organizations_owner ON ent_organizations (owner_id);

-- org_menu_templates
CREATE TABLE IF NOT EXISTS org_menu_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  categories JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  assigned_outlets JSONB DEFAULT '[]',
  last_pushed_at TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_org_menu_templates_org ON org_menu_templates (organization_id);

-- org_menu_items
CREATE TABLE IF NOT EXISTS org_menu_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT DEFAULT '',
  template_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  base_price NUMERIC(12,2) DEFAULT 0,
  variants JSONB DEFAULT '[]',
  image TEXT DEFAULT '',
  images JSONB DEFAULT '[]',
  is_veg BOOLEAN DEFAULT false,
  tags JSONB DEFAULT '[]',
  is_locked BOOLEAN DEFAULT false,
  lock_fields JSONB DEFAULT '[]',
  sort_order INTEGER DEFAULT 0,
  short_code TEXT DEFAULT '',
  customizations JSONB DEFAULT '[]',
  dine_in_price NUMERIC(12,2),
  takeaway_price NUMERIC(12,2),
  delivery_price NUMERIC(12,2),
  allergens JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_menu_items_org ON org_menu_items (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_menu_items_template ON org_menu_items (template_id);

-- indent_requests
CREATE TABLE IF NOT EXISTS indent_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT DEFAULT '',
  requesting_outlet_id TEXT DEFAULT '',
  warehouse_id TEXT DEFAULT '',
  indent_number TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'requested',
  requested_by TEXT DEFAULT '',
  approved_by TEXT,
  dispatched_by TEXT,
  received_by TEXT,
  requested_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  rejection_reason TEXT,
  delivery_notes TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_indent_requests_org ON indent_requests (organization_id);
CREATE INDEX IF NOT EXISTS idx_indent_requests_org_status ON indent_requests (organization_id, status);

-- production_orders
CREATE TABLE IF NOT EXISTS production_orders (
  id TEXT PRIMARY KEY,
  organization_id TEXT DEFAULT '',
  central_kitchen_id TEXT DEFAULT '',
  order_number TEXT DEFAULT '',
  recipe_id TEXT DEFAULT '',
  recipe_name TEXT DEFAULT '',
  target_quantity NUMERIC(12,2) DEFAULT 0,
  produced_quantity NUMERIC(12,2),
  unit TEXT DEFAULT '',
  status TEXT DEFAULT 'planned',
  scheduled_date TIMESTAMPTZ,
  completed_date TIMESTAMPTZ,
  ingredients_consumed JSONB DEFAULT '[]',
  production_entry_id TEXT,
  distribution_plan_id TEXT,
  notes TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_production_orders_org ON production_orders (organization_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_org_status ON production_orders (organization_id, status);

-- distribution_plans
CREATE TABLE IF NOT EXISTS distribution_plans (
  id TEXT PRIMARY KEY,
  organization_id TEXT DEFAULT '',
  production_order_id TEXT,
  central_kitchen_id TEXT,
  item_name TEXT DEFAULT '',
  total_quantity NUMERIC(12,2) DEFAULT 0,
  unit TEXT DEFAULT '',
  allocations JSONB DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  created_by TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_distribution_plans_org ON distribution_plans (organization_id);

-- org_settings (counter storage — flexible schema)
CREATE TABLE IF NOT EXISTS org_settings (
  id TEXT PRIMARY KEY,
  count INTEGER,
  current INTEGER,
  extra_data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- org_audit_log (append-only)
CREATE TABLE IF NOT EXISTS org_audit_log (
  id TEXT PRIMARY KEY,
  organization_id TEXT DEFAULT '',
  action TEXT DEFAULT '',
  performed_by TEXT DEFAULT '',
  entity_type TEXT,
  entity_id TEXT,
  details JSONB DEFAULT '{}',
  performed_at TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_audit_log_org ON org_audit_log (organization_id);
CREATE INDEX IF NOT EXISTS idx_org_audit_log_org_action ON org_audit_log (organization_id, action);
`;

async function main() {
  try {
    console.log('Creating 8 enterprise/org tables...');
    await query(DDL);
    console.log('All 8 enterprise tables created successfully.');
  } catch (err) {
    console.error('Error creating tables:', err.message);
    process.exit(1);
  } finally {
    await getPool().end();
  }
}

main();
