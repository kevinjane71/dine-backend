-- ============================================================================
-- Offline/Online unified POS — sync foundation (ADDITIVE, safe to run anytime)
-- Branch: pg-full-migration.  Ref: docs/unified-offline-pos-plan.md
--
-- These are NEW operational tables for the local-first sync layer. They do NOT
-- touch existing tables (orders, restaurants, ...). Nothing reads/writes them
-- yet, so creating them changes no behavior. Accessed via raw SQL by the sync
-- worker (not through pgAdapter's Firestore-collection mapping).
-- Idempotent: uses CREATE TABLE IF NOT EXISTS.
-- ============================================================================

-- 1. Device registry — every device (Hub or Terminal) that joins a restaurant.
--    device_id is generated on-device (stable UUID). display_name auto-assigned
--    by the Hub ("Terminal 1", ...). role reflects current runtime role.
CREATE TABLE IF NOT EXISTS device_registry (
  device_id      UUID PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  display_name   TEXT,                         -- "Terminal 1", "Main", ... (Hub-assigned)
  role           TEXT NOT NULL DEFAULT 'terminal', -- 'hub' | 'terminal'
  platform       TEXT,                         -- os/hostname hint
  app_version    TEXT,
  last_seen_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_registry_restaurant ON device_registry(restaurant_id);

-- 2. Order events — the append-only event log (event-sourcing). An order's state
--    is the projection of its events. hub_seq is the Hub-assigned canonical order
--    (NEVER trust device wall-clock for ordering). Existing order state columns
--    stay (dual-write) so nothing breaks during rollout.
CREATE TABLE IF NOT EXISTS order_events (
  event_id       UUID PRIMARY KEY,             -- client-generated; dedup key (idempotent apply)
  restaurant_id  TEXT NOT NULL,
  order_id       TEXT NOT NULL,                -- order id (Firestore-style ids are already collision-safe; TEXT also accepts UUIDs)
  device_id      UUID,                         -- which device emitted it
  device_seq     BIGINT,                       -- per-order sequence from the emitting device
  hub_seq        BIGSERIAL,                    -- Hub-assigned global order (authoritative ordering)
  type           TEXT NOT NULL,                -- 'order.created','item.added','item.voided','discount.applied','payment.added','order.settled',...
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(), -- device clock (audit only, NOT ordering)
  applied        BOOLEAN NOT NULL DEFAULT false      -- projected into order state yet?
);
CREATE INDEX IF NOT EXISTS idx_order_events_order    ON order_events(order_id, hub_seq);
CREATE INDEX IF NOT EXISTS idx_order_events_rest_seq ON order_events(restaurant_id, hub_seq);
CREATE INDEX IF NOT EXISTS idx_order_events_unapplied ON order_events(restaurant_id) WHERE applied = false;

-- 3. Sync outbox — pending changes on THIS device not yet acked by the next tier
--    (Terminal→Hub, or Hub→Cloud). Drives batched, idempotent, cursor-based sync.
CREATE TABLE IF NOT EXISTS sync_outbox (
  id             BIGSERIAL PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  device_id      UUID,
  event_id       UUID NOT NULL,                -- ties to order_events.event_id (idempotent)
  target         TEXT NOT NULL DEFAULT 'hub',  -- 'hub' | 'cloud'
  payload        JSONB NOT NULL,               -- the full event to ship
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at      TIMESTAMPTZ,                  -- NULL = still pending
  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending ON sync_outbox(target, id) WHERE synced_at IS NULL;

-- 4. Sync cursors — per (restaurant, peer, stream) high-water mark, so pulls/pushes
--    resume incrementally instead of re-sending everything.
CREATE TABLE IF NOT EXISTS sync_cursors (
  restaurant_id  TEXT NOT NULL,
  peer           TEXT NOT NULL,                -- 'hub' | 'cloud' | a device_id
  stream         TEXT NOT NULL,                -- 'up' | 'down'
  cursor         BIGINT NOT NULL DEFAULT 0,    -- last hub_seq / id processed
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, peer, stream)
);

-- 5. Oversell log — when offline optimistic stock deduction goes negative on Hub
--    reconciliation, we flag (never reverse a completed sale). Manager reviews.
CREATE TABLE IF NOT EXISTS stock_oversell_log (
  id             BIGSERIAL PRIMARY KEY,
  restaurant_id  TEXT NOT NULL,
  item_id        TEXT,
  order_id       TEXT,
  device_id      UUID,
  qty            NUMERIC,
  resulting_stock NUMERIC,                     -- how negative it went
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved       BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_oversell_open ON stock_oversell_log(restaurant_id) WHERE resolved = false;

-- 6. Order-number counters — Hub-authoritative per-restaurant-per-day sequence.
--    Offline terminals show a device-tagged PROVISIONAL number; the Hub assigns the
--    real sequential number here (atomic UPSERT) on create/sync, so numbers never collide.
CREATE TABLE IF NOT EXISTS order_number_counters (
  restaurant_id  TEXT NOT NULL,
  day            TEXT NOT NULL,               -- 'YYYY-MM-DD' in the restaurant's tz
  last_seq       INT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, day)
);

-- Migrate already-created tables (M1 created order_id as UUID) to TEXT.
-- Idempotent: TEXT→TEXT is a no-op; wrapped so a re-run never errors.
DO $$
BEGIN
  BEGIN ALTER TABLE order_events       ALTER COLUMN order_id TYPE TEXT USING order_id::text; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE stock_oversell_log ALTER COLUMN order_id TYPE TEXT USING order_id::text; EXCEPTION WHEN others THEN NULL; END;
END $$;
