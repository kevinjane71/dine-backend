-- 001_terminal_lock.sql — Terminal PIN lock (shared POS) + operator attribution.
-- Idempotent. Baseline tables (staff_users, app_users, staff_credentials, orders)
-- already exist from the schema clone / create-*-tables. The terminal-lock config
-- itself lives inside restaurants.pos_settings (JSONB) — no column needed.

-- Staff terminal PIN (bcrypt hash + per-staff enable flag)
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN DEFAULT true;

-- Owner can also unlock the terminal (owner lives in app_users)
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN DEFAULT true;

-- One-time plaintext PIN shown to the owner on staff create
ALTER TABLE staff_credentials ADD COLUMN IF NOT EXISTS terminal_pin TEXT;

-- Which staff (by PIN) placed each order at a shared terminal
ALTER TABLE orders ADD COLUMN IF NOT EXISTS operator_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS operator_name TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_operator ON orders (restaurant_id, operator_id);
