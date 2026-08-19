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
const { selectSince, applyRecords, UP_TABLES, DOWN_TABLES } = require('./cloudSyncWorker');

let pool = null;
let timer = null;
let running = false;
let _rid = null; // resolved restaurant id (cached)

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
  return (r.rows[0] && r.rows[0].last_updated_at) || new Date(0).toISOString();
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
  if (!Object.keys(groups).length) return { pushed: 0 };
  const res = await fetch(`${CLOUD()}/api/sync/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: rid, records: groups }),
  });
  if (!res.ok) throw new Error(`push HTTP ${res.status}`);
  for (const [t, ts] of Object.entries(nexts)) await setWatermark('apiup:' + t, ts);
  return { pushed: Object.values(groups).reduce((a, r) => a + r.length, 0) };
}

// DOWN: pull cloud changes since the watermark and apply them locally (owner menu/price/config).
async function pullDown() {
  const rid = await RID();
  if (!rid) return { applied: 0 };
  const since = await getWatermark('apidown:all');
  const res = await fetch(`${CLOUD()}/api/sync/pull?since=${encodeURIComponent(since)}`, {
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
  return { applied };
}

async function cycle() {
  if (running) return;
  if (!TOKEN()) return; // not provisioned for sync yet — quiet no-op until a token is written
  running = true;
  try {
    await pushUp();
    await pullDown();
  } catch (e) {
    // Offline / transient — leave watermarks, retry next tick. Log quietly.
    if (!/HTTP (401|403)/.test(e.message)) console.warn('[apiSync] cycle:', e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (!CLOUD()) {
    console.log('[apiSync] not started (no CLOUD_API_URL / cloudApiUrl).');
    return false;
  }
  if (timer) return true;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  timer = setInterval(cycle, INTERVAL());
  setTimeout(cycle, 3000); // first pass shortly after boot; token/rid resolved lazily each cycle
  console.log(`[apiSync] started — every ${INTERVAL()}ms → ${CLOUD()} (token+restaurant resolved from config)`);
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, cycle };
