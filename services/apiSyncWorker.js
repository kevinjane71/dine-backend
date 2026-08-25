'use strict';

/**
 * apiSyncWorker — the HUB side of API-based offline sync. Runs inside the forked local backend
 * (LOCAL_SERVER_MODE) and drains changes to the cloud over the authenticated /api/sync/* endpoints
 * — never a direct cloud DB connection. Reuses cloudSyncWorker's selectSince/applyRecords so the
 * UP/DOWN direction, column-scope, preserve-col and idempotent (strictly-newer) guards are identical.
 *
 *   UP   : for each UP table, SELECT rows changed since the local watermark → POST /api/sync/push.
 *   DOWN : GET /api/sync/pull since the local watermark → applyRecords() into the local DB.
 *
 * DORMANT unless CLOUD_API_URL + SYNC_TOKEN + SYNC_RESTAURANT_ID are all present in the env — so it
 * does nothing until a provisioned hub is wired up. Idempotent + retry-safe: a watermark only
 * advances once the cloud acknowledges, so a dropped connection just retries next cycle.
 */
const fs = require('fs');
const { Pool } = require('pg');
const { selectSince, applyRecords, UP_TABLES, DOWN_TABLES,
  ensureTombstoneInfra, selectTombstonesSince, applyTombstones, UP_TOMBSTONE, DOWN_TOMBSTONE } = require('./cloudSyncWorker');

let pool = null;
let timer = null;
let running = false;
let _rid = null; // resolved restaurant id (cached)
// Lightweight status for the UI "Syncing…" indicator (Phase 1.4). Never affects sync behavior.
let stats = { lastCycleAt: null, lastPushed: 0, lastPulled: 0, lastError: null };

// The hub's sync credentials live in its config file (written at provisioning) so a freshly-issued
// token is picked up WITHOUT restarting the backend. Env vars win if present (for tests).
function syncConfig() {
  try {
    const p = process.env.SYNC_CONFIG_PATH;
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch (_) {}
  return {};
}
const CLOUD = () => (process.env.CLOUD_API_URL || syncConfig().cloudApiUrl || '').replace(/\/+$/, '');
const TOKEN = () => process.env.SYNC_TOKEN || syncConfig().syncToken || '';
const INTERVAL = () => Number(process.env.API_SYNC_INTERVAL_MS) || 15000;
const BATCH = 200;

// The local DB is single-tenant (one restaurant), so the scope is simply that restaurant.
async function RID() {
  if (_rid) return _rid;
  _rid = process.env.SYNC_RESTAURANT_ID || syncConfig().boundRestaurantId || null;
  if (!_rid) {
    try {
      const r = await pool.query('SELECT id FROM restaurants ORDER BY created_at ASC NULLS FIRST LIMIT 1');
      if (r.rows[0]) _rid = r.rows[0].id;
    } catch (_) {}
  }
  return _rid;
}

async function getWatermark(key) {
  const r = await pool.query('SELECT last_updated_at FROM sync_watermark WHERE key = $1', [key]);
  const v = r.rows[0] && r.rows[0].last_updated_at;
  // ALWAYS return ISO. pg returns timestamptz as a JS Date; pullDown puts this in a URL query param
  // where `${date}` → Date.toString() ("Wed Aug 19 2026 … GMT+0530 (India Standard Time)"), which
  // Postgres on the cloud can't parse → "time zone gmt+0530 not recognized" → HTTP 500 on /sync/pull.
  // ISO is safe for both the URL and local pg. (Fixes the DOWN sync silently failing.)
  return v ? new Date(v).toISOString() : new Date(0).toISOString();
}
async function setWatermark(key, ts) {
  await pool.query(
    `INSERT INTO sync_watermark (key, last_updated_at, last_run) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET last_updated_at = EXCLUDED.last_updated_at, last_run = now()`,
    [key, ts]);
}

// UP: collect changed rows per table, push the batch, advance watermarks only on ack.
async function pushUp() {
  const rid = await RID();
  if (!rid) return { pushed: 0 };
  const groups = {};
  const nexts = {};
  for (const table of UP_TABLES) {
    const wm = await getWatermark('apiup:' + table);
    const { rows, next } = await selectSince(pool, table, wm, rid, BATCH);
    if (rows.length) { groups[table] = rows; nexts[table] = next; }
  }
  // Local deletes (structural/config only) captured by the tombstone trigger → flow UP so the cloud
  // removes them too. Own restaurant scope; whitelisted to tables that sync up.
  const tWm = await getWatermark('apiup:__tombstones__');
  const { rows: tombstones, next: tNext } = await selectTombstonesSince(pool, tWm, rid, UP_TOMBSTONE, BATCH);
  if (!Object.keys(groups).length && !tombstones.length) return { pushed: 0 };
  const res = await fetch(`${CLOUD()}/api/sync/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: rid, records: groups, tombstones }),
  });
  if (!res.ok) throw new Error(`push HTTP ${res.status}`);
  for (const [t, ts] of Object.entries(nexts)) await setWatermark('apiup:' + t, ts);
  if (tombstones.length) await setWatermark('apiup:__tombstones__', tNext);
  return { pushed: Object.values(groups).reduce((a, r) => a + r.length, 0), deleted: tombstones.length };
}

// DOWN: pull cloud changes since the watermark and apply them locally (owner menu/price/config).
async function pullDown() {
  const rid = await RID();
  if (!rid) return { applied: 0 };
  const since = await getWatermark('apidown:all');
  const tsince = await getWatermark('apidown:__tombstones__');
  const res = await fetch(`${CLOUD()}/api/sync/pull?since=${encodeURIComponent(since)}&tsince=${encodeURIComponent(tsince)}`, {
    headers: { Authorization: `Bearer ${TOKEN()}` },
  });
  if (!res.ok) throw new Error(`pull HTTP ${res.status}`);
  const data = await res.json();
  const rec = data.records || {};
  let applied = 0;
  for (const [table, rows] of Object.entries(rec)) {
    const r = await applyRecords(pool, table, rows, { scopeRid: rid, direction: 'down' });
    applied += r.applied || 0;
  }
  if (data.next) await setWatermark('apidown:all', data.next);
  // Delete propagation DOWN: apply the cloud's deletes locally (owner removed a table/offer/etc on
  // the web). Scoped to this restaurant + whitelisted to DOWN_TOMBSTONE tables.
  let deleted = 0;
  if (Array.isArray(data.tombstones) && data.tombstones.length) {
    const td = await applyTombstones(pool, data.tombstones, { scopeRid: rid, allowedTables: DOWN_TOMBSTONE });
    deleted = td.deleted || 0;
  }
  if (data.tnext) await setWatermark('apidown:__tombstones__', data.tnext);
  return { applied, deleted };
}

async function cycle() {
  if (running) return;
  if (!TOKEN()) return; // not provisioned for sync yet — quiet no-op until a token is written
  running = true;
  try {
    const up = await pushUp();
    const down = await pullDown();
    stats.lastCycleAt = new Date().toISOString();
    stats.lastPushed = (up && up.pushed) || 0;
    stats.lastPulled = (down && down.applied) || 0;
    stats.lastError = null;
  } catch (e) {
    // Offline / transient — leave watermarks, retry next tick. Log quietly.
    stats.lastError = e.message;
    if (!/HTTP (401|403)/.test(e.message)) console.warn('[apiSync] cycle:', e.message);
  } finally {
    running = false;
  }
}

// Lightweight status for the UI's "Syncing…" indicator. pendingUp = orders on THIS hub not yet
// pushed to the cloud (the count that must drain on reconnect) — one indexed COUNT, best-effort.
async function getStatus() {
  const enabled = !!TOKEN();
  let pendingUp = 0;
  try {
    if (enabled && pool) {
      const rid = await RID();
      if (rid) {
        const wm = await getWatermark('apiup:orders');
        const r = await pool.query('SELECT count(*)::int AS n FROM orders WHERE restaurant_id = $1 AND updated_at > $2', [rid, wm]);
        pendingUp = (r.rows[0] && r.rows[0].n) || 0;
      }
    }
  } catch (_) { /* best-effort — status must never throw */ }
  return { enabled, running, pendingUp, lastCycleAt: stats.lastCycleAt, lastPushed: stats.lastPushed, lastPulled: stats.lastPulled, lastError: stats.lastError };
}

function start() {
  if (!CLOUD()) {
    console.log('[apiSync] not started (no CLOUD_API_URL / cloudApiUrl).');
    return false;
  }
  if (timer) return true;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  // Ensure the tombstone table + AFTER DELETE triggers exist on the LOCAL DB so deletes made on this
  // hub are captured and can flow UP. (The direct PG↔PG worker used to do this, but it's disabled in
  // API-sync mode — so the API worker owns local capture now.) Idempotent, best-effort.
  ensureTombstoneInfra(pool).catch((e) => console.warn('[apiSync] tombstone infra:', e.message));
  timer = setInterval(cycle, INTERVAL());
  setTimeout(cycle, 3000); // first pass shortly after boot; token/rid resolved lazily each cycle
  console.log(`[apiSync] started — every ${INTERVAL()}ms → ${CLOUD()} (token+restaurant resolved from config)`);
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, cycle, getStatus };
