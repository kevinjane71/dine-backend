-- ============================================================================
-- add-cutover-parity-columns.sql
--
-- Adds real columns for fields the app writes/filters that were unmapped,
-- surfaced by the pre-cutover parity audit. Without these:
--   • bill completion overflowed the adapter's update() retry cap → 500
--     (update_history + update_count + offer_ids + last_updated_by)
--   • cancelled-orders "deleted" report filtered/ordered by deleted_at → 500
--   • generate-invoice-from-PO filtered by purchase_order_id → 500
--   • /suppliers/:id/performance ordered by overall_score → 500
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Run on Cloud SQL before deploying.
--   psql "$DATABASE_URL" -f scripts/add-cutover-parity-columns.sql
-- ============================================================================

BEGIN;

-- ── orders: update tracking + billing audit + comp/void + soft-delete ──────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS update_history        JSONB   DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS update_count          INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_ids             JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_updated_by       TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_audit         JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_reason       TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS manager_pin           TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS split_payments_stale  BOOLEAN;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS void_amount           NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS adjusted_final_amount NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS comp_items            JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at            TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_by            TEXT;

-- Migrate any values already written to extra_data before these columns existed
UPDATE orders SET update_history = (extra_data->'updateHistory')
  WHERE (update_history IS NULL OR update_history = '[]'::jsonb) AND extra_data ? 'updateHistory';
UPDATE orders SET update_count = NULLIF(extra_data->>'updateCount','')::int
  WHERE (update_count IS NULL OR update_count = 0) AND extra_data ? 'updateCount';
UPDATE orders SET offer_ids = (extra_data->'offerIds')       WHERE offer_ids IS NULL AND extra_data ? 'offerIds';
UPDATE orders SET last_updated_by = extra_data->>'lastUpdatedBy' WHERE last_updated_by IS NULL AND extra_data ? 'lastUpdatedBy';
UPDATE orders SET billing_audit = (extra_data->'billingAudit') WHERE billing_audit IS NULL AND extra_data ? 'billingAudit';
UPDATE orders SET discount_reason = extra_data->>'discountReason' WHERE discount_reason IS NULL AND extra_data ? 'discountReason';
UPDATE orders SET void_amount = NULLIF(extra_data->>'voidAmount','')::numeric WHERE void_amount IS NULL AND extra_data ? 'voidAmount';
UPDATE orders SET adjusted_final_amount = NULLIF(extra_data->>'adjustedFinalAmount','')::numeric WHERE adjusted_final_amount IS NULL AND extra_data ? 'adjustedFinalAmount';
UPDATE orders SET comp_items = (extra_data->'compItems')     WHERE comp_items IS NULL AND extra_data ? 'compItems';
UPDATE orders SET deleted_at = (extra_data->>'deletedAt')::timestamptz
  WHERE deleted_at IS NULL AND extra_data ? 'deletedAt' AND extra_data->>'deletedAt' ~ '^\d{4}-';
UPDATE orders SET deleted_by = extra_data->>'deletedBy'      WHERE deleted_by IS NULL AND extra_data ? 'deletedBy';

UPDATE orders SET extra_data = extra_data
    - 'updateHistory' - 'updateCount' - 'offerIds' - 'lastUpdatedBy' - 'billingAudit'
    - 'discountReason' - 'managerPin' - 'splitPaymentsStale' - 'voidAmount'
    - 'adjustedFinalAmount' - 'compItems' - 'deletedAt' - 'deletedBy'
  WHERE extra_data ?| array['updateHistory','updateCount','offerIds','lastUpdatedBy','billingAudit',
                            'discountReason','managerPin','splitPaymentsStale','voidAmount',
                            'adjustedFinalAmount','compItems','deletedAt','deletedBy'];

-- ── supplier_invoices: purchase_order_id + invoice_date ────────────────────
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS purchase_order_id TEXT;
ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS invoice_date      TIMESTAMPTZ;
UPDATE supplier_invoices SET purchase_order_id = extra_data->>'purchaseOrderId'
  WHERE purchase_order_id IS NULL AND extra_data ? 'purchaseOrderId';
UPDATE supplier_invoices SET extra_data = extra_data - 'purchaseOrderId' - 'invoiceDate'
  WHERE extra_data ?| array['purchaseOrderId','invoiceDate'];

-- ── supplier_performance: overall_score ────────────────────────────────────
ALTER TABLE supplier_performance ADD COLUMN IF NOT EXISTS overall_score NUMERIC;
UPDATE supplier_performance SET overall_score = NULLIF(extra_data->>'overallScore','')::numeric
  WHERE overall_score IS NULL AND extra_data ? 'overallScore';
UPDATE supplier_performance SET extra_data = extra_data - 'overallScore'
  WHERE extra_data ? 'overallScore';

COMMIT;
