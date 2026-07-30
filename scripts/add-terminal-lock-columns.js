/**
 * add-terminal-lock-columns.js — Terminal PIN lock (shared POS) columns.
 *
 * Adds dedicated PG columns so the terminal-lock fields are stored as real columns
 * instead of overflowing into extra_data JSONB:
 *   - staff_users.pin_hash     (bcrypt hash of the staff's terminal PIN)
 *   - staff_users.pin_enabled  (per-staff enable flag; owner/admin can disable)
 *   - orders.operator_id       (staff who unlocked the terminal & placed this order)
 *   - orders.operator_name     (denormalised operator name for reports)
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS). The terminal-lock config itself
 * (posSettings.terminalLock / roleLandingPages) lives inside restaurants.pos_settings
 * JSONB and needs no schema change.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/add-terminal-lock-columns.js
 */

const { query, getPool } = require('../repos/pgClient');

const DDL = `
-- ── Staff: terminal PIN lock ──
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN DEFAULT true;

-- ── Owner (app_users): terminal PIN lock — owner can also unlock the terminal.
--    (These columns usually already exist for the offline device PIN; IF NOT EXISTS
--     makes this a no-op when they do.) ──
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN DEFAULT true;

-- ── Staff credentials: one-time plaintext terminal PIN shown to the owner ──
ALTER TABLE staff_credentials ADD COLUMN IF NOT EXISTS terminal_pin TEXT;

-- ── Orders: terminal-lock operator attribution ──
ALTER TABLE orders ADD COLUMN IF NOT EXISTS operator_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS operator_name TEXT;

-- Attribution lookups (which orders an operator placed)
CREATE INDEX IF NOT EXISTS idx_orders_operator ON orders (restaurant_id, operator_id);
`;

async function main() {
  try {
    console.log('Adding terminal-lock columns (staff_users, orders)...');
    await query(DDL);
    console.log('Terminal-lock columns added successfully.');
  } catch (err) {
    console.error('Error adding terminal-lock columns:', err.message);
    process.exit(1);
  } finally {
    await getPool().end();
  }
}

main();
