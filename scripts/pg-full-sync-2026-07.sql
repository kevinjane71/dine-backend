-- pg-full-sync-2026-07.sql
-- Schema changes applied to Cloud SQL during the full Firestore->PG data sync
-- (2026-07-26/27). Idempotent. Run with:  psql "$DATABASE_URL" -f scripts/pg-full-sync-2026-07.sql
--
-- Context: full sync of the "dine" Firestore DB into Postgres so the app can run
-- without a Firestore dependency (RTDB events excepted). See collectionRegistry.js
-- for the matching 5 new generic passthrough entries.

-- 1) Missing columns that were overflowing to extra_data
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE stock_batches          ADD COLUMN IF NOT EXISTS batch_number TEXT;

-- 2) Tables for previously-unmapped / unbacked collections (generic passthrough:
--    whole doc packed into extra_data JSONB, spread back on read via genericUnpack)
CREATE TABLE IF NOT EXISTS dineai_conversations  (id TEXT PRIMARY KEY, restaurant_id TEXT, extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS desktop_auth_sessions (id TEXT PRIMARY KEY, restaurant_id TEXT, extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS admin_tasks           (id TEXT PRIMARY KEY, restaurant_id TEXT, extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS sub_admins            (id TEXT PRIMARY KEY, restaurant_id TEXT, extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS waitlist              (id TEXT PRIMARY KEY, restaurant_id TEXT, extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());

-- print_diagnostics keeps its real field mapper (printDiagnosticsFieldMapper)
CREATE TABLE IF NOT EXISTS print_diagnostics (
  id TEXT PRIMARY KEY, restaurant_id TEXT, terminal_id TEXT, type TEXT, method TEXT,
  success BOOLEAN, device_name TEXT, device_matched BOOLEAN, failure_reason TEXT, hint TEXT,
  os TEXT, app_version TEXT, electron_version TEXT, event JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(), extra_data JSONB DEFAULT '{}'::jsonb
);

-- Sadad (Qatar) transactions subcollection -> flat table so collectionGroup
-- lookup by merchantOrderNo works on PG (no Firestore fallback). 0 rows today.
CREATE TABLE IF NOT EXISTS sadad_transactions (
  id TEXT PRIMARY KEY, restaurant_id TEXT, merchant_order_no TEXT,
  extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sadad_merchant_order ON sadad_transactions(merchant_order_no);

-- Query-parity audit: mapped collections whose tables/columns were missing
-- (a .where() on them threw "does not exist" on PG). All 0-data today.
CREATE TABLE IF NOT EXISTS stock_audits       (id TEXT PRIMARY KEY, restaurant_id TEXT, extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS production_entries (id TEXT PRIMARY KEY, restaurant_id TEXT, extra_data JSONB DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
ALTER TABLE customer_offer_usage ADD COLUMN IF NOT EXISTS extra_data JSONB DEFAULT '{}'::jsonb;
ALTER TABLE order_counters       ADD COLUMN IF NOT EXISTS extra_data JSONB DEFAULT '{}'::jsonb;

-- 3) Widen every bounded NUMERIC(p,s) column -> unbounded NUMERIC (lossless).
--    Eliminates "numeric field overflow" on oversized money/qty values.
--    This block was applied dynamically; re-run to be safe:
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema='public' AND data_type='numeric' AND numeric_precision IS NOT NULL
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC', r.table_name, r.column_name);
  END LOOP;
END $$;
