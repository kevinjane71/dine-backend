/**
 * create-invoice-tables.js — Create 10 PG tables for invoice module collections.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/create-invoice-tables.js
 */

const { query, getPool } = require('../repos/pgClient');

const DDL = `
-- inv_organizations
CREATE TABLE IF NOT EXISTS inv_organizations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address JSONB DEFAULT '{}',
  logo TEXT DEFAULT '',
  gstin TEXT DEFAULT '',
  pan TEXT DEFAULT '',
  currency TEXT DEFAULT 'INR',
  date_format TEXT DEFAULT 'DD/MM/YYYY',
  fiscal_year_start INTEGER DEFAULT 4,
  theme JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_organizations_user_id ON inv_organizations (user_id);

-- inv_customers
CREATE TABLE IF NOT EXISTS inv_customers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT DEFAULT 'business',
  salutation TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  company_name TEXT DEFAULT '',
  display_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  work_phone TEXT DEFAULT '',
  mobile TEXT DEFAULT '',
  pan TEXT DEFAULT '',
  gstin TEXT DEFAULT '',
  currency TEXT DEFAULT 'INR',
  payment_terms TEXT DEFAULT 'due_on_receipt',
  language TEXT DEFAULT 'English',
  billing_address JSONB DEFAULT '{}',
  shipping_address JSONB DEFAULT '{}',
  contact_persons JSONB DEFAULT '[]',
  notes TEXT DEFAULT '',
  custom_fields JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  source_app TEXT DEFAULT 'standalone',
  source_ref TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_customers_org_id ON inv_customers (org_id);
CREATE INDEX IF NOT EXISTS idx_inv_customers_org_status ON inv_customers (org_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_customers_org_mobile ON inv_customers (org_id, mobile);

-- inv_items
CREATE TABLE IF NOT EXISTS inv_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT DEFAULT '',
  type TEXT DEFAULT 'goods',
  unit TEXT DEFAULT '',
  selling_price NUMERIC(12,2) DEFAULT 0,
  cost_price NUMERIC(12,2) DEFAULT 0,
  description TEXT DEFAULT '',
  tax_rate NUMERIC(6,2) DEFAULT 0,
  tax_type TEXT DEFAULT 'GST',
  hsn_code TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  image TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_items_org_id ON inv_items (org_id);
CREATE INDEX IF NOT EXISTS idx_inv_items_org_status ON inv_items (org_id, status);

-- inv_invoices
CREATE TABLE IF NOT EXISTS inv_invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  invoice_number TEXT DEFAULT '',
  reference_number TEXT DEFAULT '',
  invoice_date TEXT DEFAULT '',
  due_date TEXT DEFAULT '',
  payment_terms TEXT DEFAULT 'due_on_receipt',
  salesperson TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  subtotal NUMERIC(12,2) DEFAULT 0,
  discount_type TEXT DEFAULT 'fixed',
  discount_value NUMERIC(12,2) DEFAULT 0,
  discount_amount NUMERIC(12,2) DEFAULT 0,
  tax_amount NUMERIC(12,2) DEFAULT 0,
  tax_breakdown JSONB DEFAULT '[]',
  adjustments NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  paid_amount NUMERIC(12,2) DEFAULT 0,
  balance_due NUMERIC(12,2) DEFAULT 0,
  customer_notes TEXT DEFAULT '',
  terms_and_conditions TEXT DEFAULT '',
  attachments JSONB DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  source_app TEXT DEFAULT 'standalone',
  source_ref TEXT DEFAULT '',
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_invoices_org_id ON inv_invoices (org_id);
CREATE INDEX IF NOT EXISTS idx_inv_invoices_org_status ON inv_invoices (org_id, status);
CREATE INDEX IF NOT EXISTS idx_inv_invoices_org_customer ON inv_invoices (org_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_inv_invoices_org_source_ref ON inv_invoices (org_id, source_ref);

-- inv_quotes
CREATE TABLE IF NOT EXISTS inv_quotes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  quote_number TEXT DEFAULT '',
  reference_number TEXT DEFAULT '',
  quote_date TEXT DEFAULT '',
  expiry_date TEXT DEFAULT '',
  salesperson TEXT DEFAULT '',
  project_name TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  items JSONB DEFAULT '[]',
  subtotal NUMERIC(12,2) DEFAULT 0,
  discount_type TEXT DEFAULT 'fixed',
  discount_value NUMERIC(12,2) DEFAULT 0,
  discount_amount NUMERIC(12,2) DEFAULT 0,
  tax_amount NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  customer_notes TEXT DEFAULT '',
  terms_and_conditions TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',
  converted_invoice_id TEXT,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_quotes_org_id ON inv_quotes (org_id);
CREATE INDEX IF NOT EXISTS idx_inv_quotes_org_status ON inv_quotes (org_id, status);

-- inv_challans
CREATE TABLE IF NOT EXISTS inv_challans (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  challan_number TEXT DEFAULT '',
  reference_number TEXT DEFAULT '',
  challan_date TEXT DEFAULT '',
  challan_type TEXT DEFAULT 'supply_on_approval',
  items JSONB DEFAULT '[]',
  subtotal NUMERIC(12,2) DEFAULT 0,
  discount_amount NUMERIC(12,2) DEFAULT 0,
  adjustments NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  status TEXT DEFAULT 'draft',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_challans_org_id ON inv_challans (org_id);

-- inv_payments
CREATE TABLE IF NOT EXISTS inv_payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  customer_id TEXT DEFAULT '',
  invoice_id TEXT DEFAULT '',
  payment_number TEXT DEFAULT '',
  payment_date TEXT DEFAULT '',
  amount NUMERIC(12,2) DEFAULT 0,
  payment_mode TEXT DEFAULT 'other',
  reference_number TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_payments_org_id ON inv_payments (org_id);
CREATE INDEX IF NOT EXISTS idx_inv_payments_org_invoice ON inv_payments (org_id, invoice_id);

-- inv_expenses
CREATE TABLE IF NOT EXISTS inv_expenses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  date TEXT DEFAULT '',
  category TEXT DEFAULT '',
  amount NUMERIC(12,2) DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  invoice_number TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  customer_id TEXT DEFAULT '',
  receipt TEXT DEFAULT '',
  is_billable BOOLEAN DEFAULT false,
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_expenses_org_id ON inv_expenses (org_id);
CREATE INDEX IF NOT EXISTS idx_inv_expenses_org_category ON inv_expenses (org_id, category);

-- inv_settings
CREATE TABLE IF NOT EXISTS inv_settings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  invoice_number_prefix TEXT DEFAULT 'INV-',
  invoice_start_number INTEGER DEFAULT 1,
  quote_number_prefix TEXT DEFAULT 'QT-',
  challan_number_prefix TEXT DEFAULT 'DC-',
  payment_number_prefix TEXT DEFAULT 'PAY-',
  default_payment_terms TEXT DEFAULT 'due_on_receipt',
  default_customer_notes TEXT DEFAULT '',
  default_terms_and_conditions TEXT DEFAULT '',
  tax_settings JSONB DEFAULT '{}',
  pdf_template TEXT DEFAULT 'standard',
  pdf_colors JSONB DEFAULT '{}',
  extra_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_settings_org_id ON inv_settings (org_id);

-- inv_number_sequences
CREATE TABLE IF NOT EXISTS inv_number_sequences (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  type TEXT DEFAULT '',
  prefix TEXT DEFAULT '',
  current_number INTEGER DEFAULT 0,
  extra_data JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_number_sequences_org_id ON inv_number_sequences (org_id);
`;

async function main() {
  try {
    console.log('Creating 10 invoice module tables...');
    await query(DDL);
    console.log('All 10 invoice tables created successfully.');
  } catch (err) {
    console.error('Error creating tables:', err.message);
    process.exit(1);
  } finally {
    await getPool().end();
  }
}

main();
