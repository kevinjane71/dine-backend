-- create-corporate-fcm-tables.sql
-- B2 + B3 + S2 cutover schema: map the collections that were silently falling
-- back to production Firestore, plus the restaurants.categories column.
--
-- Idempotent (IF NOT EXISTS). Additive only — the running app ignores new
-- tables/columns until the mapper+registry code is deployed. PK is `id` on every
-- table because the pgAdapter upserts ON CONFLICT (id).
--
--   Run:  node scripts/run-sql.js scripts/create-corporate-fcm-tables.sql
--   (or)  psql "$DATABASE_URL" -f scripts/create-corporate-fcm-tables.sql

-- ── B3: Corporate Meal (EverLoop) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS corporate_clients (
  id           text PRIMARY KEY,
  restaurant_id text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_corporate_clients_rid ON corporate_clients(restaurant_id);

CREATE TABLE IF NOT EXISTS corporate_sites (
  id           text PRIMARY KEY,
  restaurant_id text,
  client_id    text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_corporate_sites_rid ON corporate_sites(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_corporate_sites_client ON corporate_sites(client_id);

CREATE TABLE IF NOT EXISTS corporate_employees (
  id           text PRIMARY KEY,
  restaurant_id text,
  site_id      text,
  client_id    text,
  phone        text,
  qr_token     text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_corp_emp_rid   ON corporate_employees(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_corp_emp_site  ON corporate_employees(site_id);
CREATE INDEX IF NOT EXISTS idx_corp_emp_client ON corporate_employees(client_id);
CREATE INDEX IF NOT EXISTS idx_corp_emp_phone ON corporate_employees(phone);
CREATE INDEX IF NOT EXISTS idx_corp_emp_qr    ON corporate_employees(qr_token);

CREATE TABLE IF NOT EXISTS meal_periods (
  id           text PRIMARY KEY,
  restaurant_id text,
  site_id      text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_periods_rid ON meal_periods(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_meal_periods_site ON meal_periods(site_id);

CREATE TABLE IF NOT EXISTS meal_bookings (
  id           text PRIMARY KEY,
  restaurant_id text,
  employee_id  text,
  site_id      text,
  period_id    text,
  date         text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_bookings_rid  ON meal_bookings(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_meal_bookings_emp  ON meal_bookings(employee_id);
CREATE INDEX IF NOT EXISTS idx_meal_bookings_site ON meal_bookings(site_id);
CREATE INDEX IF NOT EXISTS idx_meal_bookings_date ON meal_bookings(date);

CREATE TABLE IF NOT EXISTS meal_consumptions (
  id           text PRIMARY KEY,
  restaurant_id text,
  employee_id  text,
  site_id      text,
  date         text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_cons_rid  ON meal_consumptions(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_meal_cons_emp  ON meal_consumptions(employee_id);
CREATE INDEX IF NOT EXISTS idx_meal_cons_date ON meal_consumptions(date);

-- ── B2: FCM token subcollections (restaurants/{id}/fcmTokens|staffFcmTokens) ──
-- PK is id (the FCM device token / device id — globally unique). restaurant_id is
-- injected by the adapter's subcollection scope and used for the scoped read filter.
CREATE TABLE IF NOT EXISTS fcm_tokens (
  id           text PRIMARY KEY,
  restaurant_id text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_rid ON fcm_tokens(restaurant_id);

CREATE TABLE IF NOT EXISTS staff_fcm_tokens (
  id           text PRIMARY KEY,
  restaurant_id text,
  extra_data   jsonb DEFAULT '{}'::jsonb,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_fcm_tokens_rid ON staff_fcm_tokens(restaurant_id);

-- ── S2: restaurants.categories explicit column (was surviving via extra_data) ──
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS categories jsonb;
