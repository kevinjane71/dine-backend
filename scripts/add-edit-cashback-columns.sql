-- ============================================================================
-- add-edit-cashback-columns.sql
--
-- ⚠️  RUN ON CLOUD SQL BEFORE (RE)DEPLOYING the revision that maps these fields.
--
-- Adds real columns for order fields introduced by the completed-bill edit +
-- cashback + wallet features. Without them, the completed-bill auto-refund path
-- writes 5 previously-unmapped columns in one UPDATE, which exceeds the
-- pgAdapter's extra_data overflow cap (3 per update) and 500s. These columns
-- (now mapped in fieldMapper.js) drop the overflow to zero. Also migrates any
-- values already written to extra_data on GCP since the feature deployed.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + guarded UPDATEs). Run with:
--   psql "$DATABASE_URL" -f scripts/add-edit-cashback-columns.sql
-- ============================================================================

BEGIN;

-- ── orders: edit history + auto-refund (the blocker) ──────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS edit_history        JSONB DEFAULT '[]'::jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_refund_amount  NUMERIC DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_refund_reason  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_refund_at      TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS auto_refund_by      TEXT;

-- ── orders: cashback + wallet + billing-clamp flag ────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashback_earned      NUMERIC;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashback_offer_id    TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cashback_offer_name  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS wallet_customer_id   TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_clamped      BOOLEAN;

-- Migrate values already written to extra_data before these columns existed
UPDATE orders SET edit_history = (extra_data->'editHistory')
  WHERE (edit_history IS NULL OR edit_history = '[]'::jsonb) AND extra_data ? 'editHistory';
UPDATE orders SET cashback_earned = NULLIF(extra_data->>'cashbackEarned','')::numeric
  WHERE cashback_earned IS NULL AND extra_data ? 'cashbackEarned';
UPDATE orders SET cashback_offer_id = extra_data->>'cashbackOfferId'
  WHERE cashback_offer_id IS NULL AND extra_data ? 'cashbackOfferId';
UPDATE orders SET cashback_offer_name = extra_data->>'cashbackOfferName'
  WHERE cashback_offer_name IS NULL AND extra_data ? 'cashbackOfferName';
UPDATE orders SET wallet_customer_id = extra_data->>'walletCustomerId'
  WHERE wallet_customer_id IS NULL AND extra_data ? 'walletCustomerId';
UPDATE orders SET auto_refund_amount = NULLIF(extra_data->>'autoRefundAmount','')::numeric
  WHERE (auto_refund_amount IS NULL OR auto_refund_amount = 0) AND extra_data ? 'autoRefundAmount';
UPDATE orders SET auto_refund_reason = extra_data->>'autoRefundReason'
  WHERE auto_refund_reason IS NULL AND extra_data ? 'autoRefundReason';

UPDATE orders SET extra_data = extra_data
    - 'editHistory' - 'cashbackEarned' - 'cashbackOfferId' - 'cashbackOfferName'
    - 'walletCustomerId' - 'billingClamped'
    - 'autoRefundAmount' - 'autoRefundReason' - 'autoRefundAt' - 'autoRefundBy'
  WHERE extra_data ?| array['editHistory','cashbackEarned','cashbackOfferId','cashbackOfferName',
                            'walletCustomerId','billingClamped','autoRefundAmount','autoRefundReason',
                            'autoRefundAt','autoRefundBy'];

COMMIT;

-- ── daily_stats: refunds_issued (display-only refund tracker) ──────────────
BEGIN;
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS refunds_issued NUMERIC DEFAULT 0;
UPDATE daily_stats SET refunds_issued = NULLIF(extra_data->>'refundsIssued','')::numeric
  WHERE (refunds_issued IS NULL OR refunds_issued = 0) AND extra_data ? 'refundsIssued';
UPDATE daily_stats SET extra_data = extra_data - 'refundsIssued' WHERE extra_data ? 'refundsIssued';
COMMIT;
