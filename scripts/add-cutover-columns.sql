-- ============================================================================
-- add-cutover-columns.sql
--
-- ⚠️  RUN THIS ON CLOUD SQL **BEFORE** DEPLOYING THE pg-full-migration BRANCH
--     REVISION THAT WIRES REAL fieldMaps INTO collectionRegistry.js.
--
-- Why: several Firestore fields that are queried in WHERE clauses (or read
-- back with .toDate()) previously overflowed into the extra_data JSONB column
-- because their field mappers had no column mapping. The new mappers write
-- these fields to real columns and translate WHERE clauses to them — so the
-- columns must exist first, and existing values must be moved out of
-- extra_data into the new columns.
--
-- The script is idempotent (ADD COLUMN IF NOT EXISTS / guarded UPDATEs) and
-- safe to re-run. Run with:
--   psql "$DATABASE_URL" -f scripts/add-cutover-columns.sql
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. restaurants.aggregator_config (JSONB)
--    Talabat webhook queries aggregatorConfig.talabat.vendorId / .enabled
--    (routes/aggregatorRoutes.js:56,122,154)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS aggregator_config JSONB;

UPDATE restaurants
   SET aggregator_config = extra_data->'aggregatorConfig'
 WHERE aggregator_config IS NULL AND extra_data ? 'aggregatorConfig';

UPDATE restaurants
   SET extra_data = extra_data - 'aggregatorConfig'
 WHERE aggregator_config IS NOT NULL AND extra_data ? 'aggregatorConfig';

-- Hot path: webhook lookup by vendor id
CREATE INDEX IF NOT EXISTS idx_restaurants_talabat_vendor
  ON restaurants ((aggregator_config->'talabat'->>'vendorId'))
  WHERE aggregator_config IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. orders.delivery_status (TEXT) + orders.delivery_assigned_at (TIMESTAMPTZ)
--    services/deliveryService.js:78,313,349 — WHERE deliveryStatus IN (...),
--    ORDER BY deliveryAssignedAt DESC
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_assigned_at TIMESTAMPTZ;

UPDATE orders
   SET delivery_status = extra_data->>'deliveryStatus'
 WHERE delivery_status IS NULL AND extra_data ? 'deliveryStatus';

UPDATE orders
   SET extra_data = extra_data - 'deliveryStatus'
 WHERE delivery_status IS NOT NULL AND extra_data ? 'deliveryStatus';

UPDATE orders
   SET delivery_assigned_at = CASE
       WHEN jsonb_typeof(extra_data->'deliveryAssignedAt') = 'string'
         THEN (extra_data->>'deliveryAssignedAt')::timestamptz
       WHEN jsonb_typeof(extra_data->'deliveryAssignedAt') = 'object'
            AND extra_data->'deliveryAssignedAt' ? '_seconds'
         THEN to_timestamp((extra_data->'deliveryAssignedAt'->>'_seconds')::bigint)
       ELSE NULL
     END
 WHERE delivery_assigned_at IS NULL AND extra_data ? 'deliveryAssignedAt';

UPDATE orders
   SET extra_data = extra_data - 'deliveryAssignedAt'
 WHERE delivery_assigned_at IS NOT NULL AND extra_data ? 'deliveryAssignedAt';

CREATE INDEX IF NOT EXISTS idx_orders_restaurant_delivery_status
  ON orders (restaurant_id, delivery_status)
  WHERE delivery_status IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. feedback_forms.distribution (JSONB)
--    routes/feedback.js:646 — WHERE distribution.shortCode == :code
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE feedback_forms ADD COLUMN IF NOT EXISTS distribution JSONB;

UPDATE feedback_forms
   SET distribution = extra_data->'distribution'
 WHERE distribution IS NULL AND extra_data ? 'distribution';

UPDATE feedback_forms
   SET extra_data = extra_data - 'distribution'
 WHERE distribution IS NOT NULL AND extra_data ? 'distribution';

CREATE INDEX IF NOT EXISTS idx_feedback_forms_short_code
  ON feedback_forms ((distribution->>'shortCode'))
  WHERE distribution IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. rest_bookings.venue (JSONB)
--    routes/bookings/helpers.js:49 — WHERE venue.venueId == :id
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE rest_bookings ADD COLUMN IF NOT EXISTS venue JSONB;

UPDATE rest_bookings
   SET venue = extra_data->'venue'
 WHERE venue IS NULL AND extra_data ? 'venue';

UPDATE rest_bookings
   SET extra_data = extra_data - 'venue'
 WHERE venue IS NOT NULL AND extra_data ? 'venue';

CREATE INDEX IF NOT EXISTS idx_rest_bookings_venue_id
  ON rest_bookings (restaurant_id, (venue->>'venueId'))
  WHERE venue IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. owner_preferences.email_enabled (BOOLEAN) +
--    owner_preferences.active_report_hours_utc (JSONB array)
--    index.js daily-report cron — WHERE emailEnabled == true AND
--    activeReportHoursUTC array-contains :hour
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE owner_preferences ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN;
ALTER TABLE owner_preferences ADD COLUMN IF NOT EXISTS active_report_hours_utc JSONB;

UPDATE owner_preferences
   SET email_enabled = (extra_data->>'emailEnabled')::boolean
 WHERE email_enabled IS NULL AND extra_data ? 'emailEnabled';

UPDATE owner_preferences
   SET extra_data = extra_data - 'emailEnabled'
 WHERE email_enabled IS NOT NULL AND extra_data ? 'emailEnabled';

UPDATE owner_preferences
   SET active_report_hours_utc = extra_data->'activeReportHoursUTC'
 WHERE active_report_hours_utc IS NULL AND extra_data ? 'activeReportHoursUTC';

UPDATE owner_preferences
   SET extra_data = extra_data - 'activeReportHoursUTC'
 WHERE active_report_hours_utc IS NOT NULL AND extra_data ? 'activeReportHoursUTC';

-- ────────────────────────────────────────────────────────────────────────────
-- 6. daily_stats.total_covers (NUMERIC)
--    updateDailyStats() — FieldValue.increment on totalCovers (covers feature)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE daily_stats ADD COLUMN IF NOT EXISTS total_covers NUMERIC DEFAULT 0;

UPDATE daily_stats
   SET total_covers = (extra_data->>'totalCovers')::numeric
 WHERE (total_covers IS NULL OR total_covers = 0) AND extra_data ? 'totalCovers';

UPDATE daily_stats
   SET extra_data = extra_data - 'totalCovers'
 WHERE total_covers IS NOT NULL AND extra_data ? 'totalCovers';

-- ────────────────────────────────────────────────────────────────────────────
-- 7. automation_logs.message_id (TEXT) + btree index
--    WhatsApp dedup / status updates — WHERE messageId == :id
--    (column exists in newer DDL; ensure + index for the hot dedup lookup)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE automation_logs ADD COLUMN IF NOT EXISTS message_id TEXT DEFAULT '';

UPDATE automation_logs
   SET message_id = extra_data->>'messageId'
 WHERE (message_id IS NULL OR message_id = '') AND extra_data ? 'messageId';

UPDATE automation_logs
   SET extra_data = extra_data - 'messageId'
 WHERE message_id IS NOT NULL AND message_id <> '' AND extra_data ? 'messageId';

CREATE INDEX IF NOT EXISTS idx_automation_logs_message_id
  ON automation_logs (message_id)
  WHERE message_id IS NOT NULL AND message_id <> '';

-- ────────────────────────────────────────────────────────────────────────────
-- 8. customers.wallet_card_number / wallet_card_barcode (TEXT)
--    index.js:31139/31147 — wallet card lookup WHERE walletCardNumber == :n
--    (already mapped + added by add-fassco-columns.sql; kept here so this
--    script alone is sufficient on a fresh instance)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wallet_card_number TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS wallet_card_barcode TEXT;

UPDATE customers
   SET wallet_card_number = extra_data->>'walletCardNumber'
 WHERE wallet_card_number IS NULL AND extra_data ? 'walletCardNumber';

UPDATE customers
   SET extra_data = extra_data - 'walletCardNumber'
 WHERE wallet_card_number IS NOT NULL AND extra_data ? 'walletCardNumber';

UPDATE customers
   SET wallet_card_barcode = extra_data->>'walletCardBarcode'
 WHERE wallet_card_barcode IS NULL AND extra_data ? 'walletCardBarcode';

UPDATE customers
   SET extra_data = extra_data - 'walletCardBarcode'
 WHERE wallet_card_barcode IS NOT NULL AND extra_data ? 'walletCardBarcode';

CREATE INDEX IF NOT EXISTS idx_customers_wallet_card_number
  ON customers (restaurant_id, wallet_card_number) WHERE wallet_card_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_wallet_card_barcode
  ON customers (restaurant_id, wallet_card_barcode) WHERE wallet_card_barcode IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. app_users.email_otp (TEXT) + app_users.email_otp_expiry (TIMESTAMPTZ)
--    Email OTP verification flows read userData.emailOTPExpiry.toDate()
--    (index.js:3653,4142/4162,4376) — an ISO string from extra_data crashes.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_otp TEXT;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email_otp_expiry TIMESTAMPTZ;

UPDATE app_users
   SET email_otp = extra_data->>'emailOTP'
 WHERE email_otp IS NULL AND extra_data ? 'emailOTP';

UPDATE app_users
   SET extra_data = extra_data - 'emailOTP'
 WHERE email_otp IS NOT NULL AND extra_data ? 'emailOTP';

UPDATE app_users
   SET email_otp_expiry = CASE
       WHEN jsonb_typeof(extra_data->'emailOTPExpiry') = 'string'
         THEN (extra_data->>'emailOTPExpiry')::timestamptz
       WHEN jsonb_typeof(extra_data->'emailOTPExpiry') = 'object'
            AND extra_data->'emailOTPExpiry' ? '_seconds'
         THEN to_timestamp((extra_data->'emailOTPExpiry'->>'_seconds')::bigint)
       ELSE NULL
     END
 WHERE email_otp_expiry IS NULL AND extra_data ? 'emailOTPExpiry';

UPDATE app_users
   SET extra_data = extra_data - 'emailOTPExpiry'
 WHERE email_otp_expiry IS NOT NULL AND extra_data ? 'emailOTPExpiry';

-- ────────────────────────────────────────────────────────────────────────────
-- 10. purchase_orders.expected_delivery_date / received_at (TIMESTAMPTZ)
--     index.js:28653-28654 — po.expectedDeliveryDate.toDate(),
--     po.receivedAt.toDate() (unguarded); also index.js:23775
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS expected_delivery_date TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

UPDATE purchase_orders
   SET expected_delivery_date = CASE
       WHEN jsonb_typeof(extra_data->'expectedDeliveryDate') = 'string'
         THEN (extra_data->>'expectedDeliveryDate')::timestamptz
       WHEN jsonb_typeof(extra_data->'expectedDeliveryDate') = 'object'
            AND extra_data->'expectedDeliveryDate' ? '_seconds'
         THEN to_timestamp((extra_data->'expectedDeliveryDate'->>'_seconds')::bigint)
       ELSE NULL
     END
 WHERE expected_delivery_date IS NULL AND extra_data ? 'expectedDeliveryDate';

UPDATE purchase_orders
   SET extra_data = extra_data - 'expectedDeliveryDate'
 WHERE expected_delivery_date IS NOT NULL AND extra_data ? 'expectedDeliveryDate';

UPDATE purchase_orders
   SET received_at = CASE
       WHEN jsonb_typeof(extra_data->'receivedAt') = 'string'
         THEN (extra_data->>'receivedAt')::timestamptz
       WHEN jsonb_typeof(extra_data->'receivedAt') = 'object'
            AND extra_data->'receivedAt' ? '_seconds'
         THEN to_timestamp((extra_data->'receivedAt'->>'_seconds')::bigint)
       ELSE NULL
     END
 WHERE received_at IS NULL AND extra_data ? 'receivedAt';

UPDATE purchase_orders
   SET extra_data = extra_data - 'receivedAt'
 WHERE received_at IS NOT NULL AND extra_data ? 'receivedAt';

-- ────────────────────────────────────────────────────────────────────────────
-- 11. menu_items.sub_category (TEXT)
--     MENU_ITEM_FIELD_MAP maps subCategory → sub_category but the original
--     create-auth-menu-tables.js DDL never added the column, so writes were
--     overflowing to extra_data.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sub_category TEXT;

UPDATE menu_items
   SET sub_category = extra_data->>'subCategory'
 WHERE sub_category IS NULL AND extra_data ? 'subCategory';

UPDATE menu_items
   SET extra_data = extra_data - 'subCategory'
 WHERE sub_category IS NOT NULL AND extra_data ? 'subCategory';

COMMIT;

-- ============================================================================
-- Post-run sanity checks (optional, read-only):
--   SELECT count(*) FROM restaurants WHERE extra_data ? 'aggregatorConfig';
--   SELECT count(*) FROM orders WHERE extra_data ? 'deliveryStatus';
--   SELECT count(*) FROM app_users WHERE extra_data ? 'emailOTPExpiry';
-- All should be 0 (or only rows whose values could not be parsed).
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 12. owner_preferences.report_time_utc (INTEGER) — legacy hourly-report field
--     queried by /api/cron/send-daily-reports (index.js ~19903)
--     (added 2026-07-12 after live cron test)
-- ────────────────────────────────────────────────────────────────────────────
BEGIN;
ALTER TABLE owner_preferences ADD COLUMN IF NOT EXISTS report_time_utc INTEGER;

UPDATE owner_preferences
   SET report_time_utc = NULLIF(extra_data->>'reportTimeUTC','')::numeric::integer
 WHERE report_time_utc IS NULL AND extra_data ? 'reportTimeUTC';

UPDATE owner_preferences
   SET extra_data = extra_data - 'reportTimeUTC'
 WHERE report_time_utc IS NOT NULL AND extra_data ? 'reportTimeUTC';
COMMIT;
