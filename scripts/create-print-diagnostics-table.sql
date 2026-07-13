-- ============================================================================
-- create-print-diagnostics-table.sql
--
-- Backs the /api/print-diagnostics telemetry endpoint on the PostgreSQL branch.
--
-- ⚠️  RUN THIS ON CLOUD SQL **BEFORE** DEPLOYING the pg-full-migration revision
--     that registers 'printDiagnostics' in collectionRegistry.js. Until the
--     table exists, keep the collection UNregistered so the pgAdapter falls
--     back to Firestore (the endpoint still works either way).
--
-- Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- Run with:  psql "$DATABASE_URL" -f scripts/create-print-diagnostics-table.sql
-- ============================================================================

BEGIN;

-- Shared trigger helper (idempotent; also defined by other create-*-table scripts)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS print_diagnostics (
  id               TEXT PRIMARY KEY,
  restaurant_id    TEXT NOT NULL,
  terminal_id      TEXT,
  type             TEXT,          -- 'kot' | 'bill' | 'unknown'
  method           TEXT,          -- 'os-driver' | 'tcp' | 'pdf-fallback'
  success          BOOLEAN,
  device_name      TEXT,          -- configured printer name (or IP for TCP)
  device_matched   BOOLEAN,       -- was the configured printer found in the OS list
  failure_reason   TEXT,
  hint             TEXT,          -- plain-English likely cause
  os               TEXT,          -- e.g. "Windows 10 (build 19045)"
  app_version      TEXT,
  electron_version TEXT,
  event            JSONB,         -- full sanitized diagnostic blob
  extra_data       JSONB,         -- pgAdapter overflow for unmapped fields
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Look up a terminal's history and filter to failures fast.
CREATE INDEX IF NOT EXISTS idx_print_diag_restaurant_created
  ON print_diagnostics (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_print_diag_failures
  ON print_diagnostics (restaurant_id, created_at DESC)
  WHERE success = FALSE;

DROP TRIGGER IF EXISTS trg_print_diagnostics_updated_at ON print_diagnostics;
CREATE TRIGGER trg_print_diagnostics_updated_at
  BEFORE UPDATE ON print_diagnostics
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
