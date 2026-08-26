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
let stats = { lastCycleAt: null, lastPushed: 0, lastPulled: 0, lastError: null, authExpired: false };
// Phase 6 — a big offline backlog drains BATCH rows per push; loop up to this many pushes per cycle
// so days-worth of orders catch up in a cycle or two instead of one-batch-per-timer-tick. Still one
// HTTP round-trip per batch (sequential awaits) → catches up fast without hammering the cloud.
const MAX_DRAIN_LOOPS = 25;

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

// ── Dead-letter (Phase 1.5) ───────────────────────────────────────────────────────────────────
// Records the cloud REJECTED (validation error) are never silently lost: they land here, get a
// bounded number of retries, and are surfaced in getStatus. The push watermark still advances past
// them so a single bad row can never block the rest of the sync (no poison pill).
const MAX_DL_ATTEMPTS = 6;
async function ensureDeadLetterInfra(p) {
  await p.query(`CREATE TABLE IF NOT EXISTS sync_deadletter (
    table_name text NOT NULL,
    row_id     text NOT NULL,
    error      text,
    attempts   int  NOT NULL DEFAULT 1,
    first_seen timestamptz NOT NULL DEFAULT now(),
    last_seen  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (table_name, row_id)
  )`);
}
// Record the cloud's per-table failures[] (from /api/sync/push results) into the dead-letter table.
async function recordFailures(results) {
  if (!Array.isArray(results)) return;
  for (const r of results) {
    if (!r || !Array.isArray(r.failures) || !r.failures.length) continue;
    for (const f of r.failures) {
      if (!f || f.id == null) continue;
      await pool.query(
        `INSERT INTO sync_deadletter (table_name, row_id, error) VALUES ($1,$2,$3)
         ON CONFLICT (table_name, row_id) DO UPDATE SET attempts = sync_deadletter.attempts + 1,
           error = EXCLUDED.error, last_seen = now()`,
        [r.table, String(f.id), String(f.error || '').slice(0, 300)]
      ).catch(() => {});
    }
  }
}
// Re-attempt dead-lettered rows (still within budget): re-read the current local row + re-push. Clears
// the ones that now succeed, bumps attempts on the rest, and drops rows that were deleted locally.
async function retryDeadLetter() {
  if (!TOKEN()) return;
  const rid = await RID();
  if (!rid) return;
  const upTables = new Set(UP_TABLES); // whitelist — never interpolate an arbitrary table name
  const dl = await pool.query(
    'SELECT table_name, row_id FROM sync_deadletter WHERE attempts < $1 ORDER BY last_seen ASC LIMIT 100', [MAX_DL_ATTEMPTS]);
  if (!dl.rows.length) return;
  const byTable = {};
  for (const row of dl.rows) {
    if (!upTables.has(row.table_name)) continue;
    (byTable[row.table_name] = byTable[row.table_name] || []).push(row.row_id);
  }
  const groups = {};
  for (const [table, ids] of Object.entries(byTable)) {
    const q = await pool.query(`SELECT * FROM "${table}" WHERE id = ANY($1)`, [ids]);
    if (q.rows.length) groups[table] = q.rows;
    const present = new Set(q.rows.map((x) => String(x.id)));
    const gone = ids.filter((id) => !present.has(String(id)));
    if (gone.length) await pool.query('DELETE FROM sync_deadletter WHERE table_name=$1 AND row_id = ANY($2)', [table, gone]).catch(() => {});
  }
  if (!Object.keys(groups).length) return;
  const res = await fetch(`${CLOUD()}/api/sync/push`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: rid, records: groups, tombstones: [] }),
  });
  if (!res.ok) return; // transient → retry next cycle, attempts unchanged
  const body = await res.json().catch(() => ({}));
  const stillFailing = {};
  for (const r of (body.results || [])) stillFailing[r.table] = new Set((r.failures || []).map((f) => String(f.id)));
  for (const [table, ids] of Object.entries(byTable)) {
    const failing = stillFailing[table] || new Set();
    const cleared = ids.filter((id) => !failing.has(String(id)));
    const bump = ids.filter((id) => failing.has(String(id)));
    if (cleared.length) await pool.query('DELETE FROM sync_deadletter WHERE table_name=$1 AND row_id = ANY($2)', [table, cleared]).catch(() => {});
    if (bump.length) await pool.query('UPDATE sync_deadletter SET attempts = attempts + 1, last_seen = now() WHERE table_name=$1 AND row_id = ANY($2)', [table, bump]).catch(() => {});
  }
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
  const body = await res.json().catch(() => ({}));
  await recordFailures(body.results); // Phase 1.5: quarantine any rows the cloud rejected (don't lose them)
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
    // Phase 6 — drain a large backlog in one cycle (bounded): keep pushing while a full BATCH came
    // back (⇒ probably more waiting). Watermarks advance per push, so this is safe to interrupt.
    let up = await pushUp();
    let pushed = (up && up.pushed) || 0;
    let guard = 0;
    while (((up && up.pushed) || 0) >= BATCH && guard++ < MAX_DRAIN_LOOPS) {
      up = await pushUp();
      pushed += (up && up.pushed) || 0;
    }
    const down = await pullDown();
    try { await retryDeadLetter(); } catch (_) { /* best-effort — never fail the cycle on retry */ }
    // Phase 4.1 — after applying this cycle's changes, flag any item that reconciled below zero
    // (two writers sold the same units) so the manager sees an oversell instead of a silent negative.
    try { const rid = await RID(); if (rid) await require('./offlineSync/stockReconcile').flagNegativeStock(rid); } catch (_) { /* best-effort — never fail the cycle on the oversell sweep */ }
    stats.lastCycleAt = new Date().toISOString();
    stats.lastPushed = pushed;
    stats.lastPulled = (down && down.applied) || 0;
    stats.lastError = null;
    stats.authExpired = false; // a clean cycle proves the token is still good
  } catch (e) {
    // Offline / transient — leave watermarks, retry next tick. Log quietly.
    stats.lastError = e.message;
    // Phase 6 — a 401/403 means the sync token is no longer accepted (revoked / secret rotated).
    // Surface it (getStatus.authExpired) so the UI can prompt a re-connect instead of failing forever.
    if (/HTTP (401|403)/.test(e.message)) stats.authExpired = true;
    else console.warn('[apiSync] cycle:', e.message);
  } finally {
    running = false;
  }
}

// Phase 6 — disk-full guard. The terminal's embedded Postgres can't write when its data volume is
// full (orders would fail). We proactively report free space on the PG data volume so the UI can warn
// BEFORE it fills. Cached (20s) + best-effort — returns {} if statfs/SHOW is unavailable, never throws.
let _pgDataDir = null;
let _diskCache = { at: 0, val: {} };
async function diskStatus() {
  try {
    const now = Date.now();
    if (now - _diskCache.at < 20000) return _diskCache.val;
    if (!_pgDataDir && pool) {
      try { const r = await pool.query('SHOW data_directory'); _pgDataDir = r.rows[0] && r.rows[0].data_directory; } catch (_) {}
    }
    const dir = _pgDataDir || process.cwd();
    const st = await fs.promises.statfs(dir);
    const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
    const val = { diskFreeMb: freeMb, diskLow: freeMb < 500, diskCritical: freeMb < 100 };
    _diskCache = { at: now, val };
    return val;
  } catch (_) { return {}; }
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
  let deadLetter = 0;
  try {
    if (pool) { const d = await pool.query('SELECT count(*)::int AS n FROM sync_deadletter'); deadLetter = (d.rows[0] && d.rows[0].n) || 0; }
  } catch (_) { /* table may not exist yet */ }
  const disk = await diskStatus();
  return { enabled, running, pendingUp, deadLetter, authExpired: !!stats.authExpired, ...disk, lastCycleAt: stats.lastCycleAt, lastPushed: stats.lastPushed, lastPulled: stats.lastPulled, lastError: stats.lastError };
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
  ensureDeadLetterInfra(pool).catch((e) => console.warn('[apiSync] deadletter infra:', e.message));
  timer = setInterval(cycle, INTERVAL());
  setTimeout(cycle, 3000); // first pass shortly after boot; token/rid resolved lazily each cycle
  console.log(`[apiSync] started — every ${INTERVAL()}ms → ${CLOUD()} (token+restaurant resolved from config)`);
  return true;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, cycle, getStatus };
