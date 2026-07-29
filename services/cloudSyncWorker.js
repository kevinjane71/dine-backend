/**
 * cloudSyncWorker — keeps the on-prem local server and the cloud (main) DB in sync so
 * the SAME restaurant can also be used from the web version. Runs only on the local
 * server. Both sides are Postgres with the same schema, so this is generic, idempotent
 * ROW replication (no re-coded logic):
 *
 *   SELECT * FROM t WHERE updated_at > <watermark> ORDER BY updated_at LIMIT N
 *   INSERT ... ON CONFLICT (id) DO UPDATE            (idempotent by UUID)
 *
 * SPLIT AUTHORITY (avoids conflicts — a table only ever flows ONE way):
 *   • UP   (local → cloud): transactions — orders, payments, daily_stats, shifts…
 *                            local is the source of truth while offline.
 *   • DOWN (cloud → local): catalog/config — menu, prices, offers, staff, settings…
 *                            cloud is the source of truth (owner edits on the web).
 *
 * SYNC_MODE flag (set per site on the local server):
 *   • off | offline  — complete island, no cloud sync at all.
 *   • periodic       — auto every CLOUD_SYNC_INTERVAL_MS when the cloud is reachable.
 *   • manual         — only when POST /api/local-server/sync-now is called.
 *
 * Env: CLOUD_DATABASE_URL (the cloud/main DB, ≠ local DATABASE_URL),
 *      CLOUD_SYNC_TABLES (up), CLOUD_SYNC_DOWN_TABLES (down), CLOUD_SYNC_INTERVAL_MS,
 *      CLOUD_SYNC_BATCH. Back-compat: CLOUD_SYNC_ENABLED=true ⇒ mode 'periodic'.
 */

const { Pool } = require('pg');

const INTERVAL_MS = parseInt(process.env.CLOUD_SYNC_INTERVAL_MS, 10) || 45000;
const BATCH = parseInt(process.env.CLOUD_SYNC_BATCH, 10) || 500;

// Up = transactions (local → cloud). Parent→child order for FK safety.
const UP_TABLES = (process.env.CLOUD_SYNC_TABLES ||
  'customers,tables,orders,payments,daily_stats,shifts,cash_registers,inventory')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Down = catalog/config (cloud → local). Empty by default (opt in per site).
const DOWN_TABLES = (process.env.CLOUD_SYNC_DOWN_TABLES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function resolveMode() {
  let m = (process.env.SYNC_MODE || '').toLowerCase().trim();
  if (!m) m = process.env.CLOUD_SYNC_ENABLED === 'true' ? 'periodic' : 'off';
  if (m === 'offline') m = 'off';
  return ['off', 'periodic', 'manual'].includes(m) ? m : 'off';
}

let localPool = null;
let cloudPool = null;
let timer = null;
let cycleRunning = false;
let mode = 'off';

async function getColumns(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rows;
}

async function ensureWatermarkTable() {
  await localPool.query(`
    CREATE TABLE IF NOT EXISTS sync_watermark (
      key text PRIMARY KEY,
      last_updated_at timestamptz,
      last_run timestamptz,
      last_error text,
      rows_synced bigint DEFAULT 0
    )`);
}

async function getWatermark(key) {
  const r = await localPool.query('SELECT last_updated_at FROM sync_watermark WHERE key = $1', [key]);
  return (r.rows[0] && r.rows[0].last_updated_at) || new Date(0);
}
async function setWatermark(key, ts, err, addRows) {
  await localPool.query(
    `INSERT INTO sync_watermark (key, last_updated_at, last_run, last_error, rows_synced)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (key) DO UPDATE SET
       last_updated_at = EXCLUDED.last_updated_at, last_run = now(),
       last_error = EXCLUDED.last_error, rows_synced = sync_watermark.rows_synced + EXCLUDED.rows_synced`,
    [key, ts, err || null, addRows || 0]);
}

// jsonb/json values come back as objects/arrays; stringify so pg sends JSON (not a PG array literal).
function coerce(value, dataType) {
  if (value == null) return value;
  if ((dataType === 'jsonb' || dataType === 'json') && typeof value === 'object') return JSON.stringify(value);
  return value;
}

// Replicate one table from src → dst. `key` namespaces the watermark (direction:table).
async function replicate(src, dst, table, key) {
  const srcCols = await getColumns(src, table);
  if (!srcCols.length) return { table, key, skipped: 'missing at source' };
  const srcNames = srcCols.map((c) => c.column_name);
  if (!srcNames.includes('id') || !srcNames.includes('updated_at')) return { table, key, skipped: 'no id/updated_at' };

  const dstNames = new Set((await getColumns(dst, table)).map((c) => c.column_name));
  if (!dstNames.size) return { table, key, skipped: 'missing at destination' };

  const cols = srcCols.filter((c) => dstNames.has(c.column_name));
  const names = cols.map((c) => c.column_name);
  const typeOf = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  const setCols = names.filter((c) => c !== 'id');
  const quoted = names.map((c) => `"${c}"`).join(',');
  const ph = names.map((_, i) => `$${i + 1}`).join(',');
  const upd = setCols.map((c) => `"${c}"=EXCLUDED."${c}"`).join(',');
  const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${upd}`;

  let wm = await getWatermark(key);
  let lastGood = wm;
  let total = 0;
  for (;;) {
    const res = await src.query(
      `SELECT ${quoted} FROM "${table}" WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT ${BATCH}`, [wm]);
    if (!res.rows.length) break;
    let batch = 0;
    for (const row of res.rows) {
      try {
        await dst.query(sql, names.map((c) => coerce(row[c], typeOf[c])));
        batch++; total++;
        if (row.updated_at && row.updated_at > lastGood) lastGood = row.updated_at;
      } catch (rowErr) {
        // Stop this table WITHOUT skipping the failed row → retried next cycle.
        await setWatermark(key, lastGood, `${row.id}: ${rowErr.message}`.slice(0, 300), batch);
        return { table, key, synced: total, error: rowErr.message, stoppedAt: row.id };
      }
    }
    wm = lastGood;
    await setWatermark(key, wm, null, batch); // per-batch delta (rows_synced accumulates)
    if (res.rows.length < BATCH) break;
  }
  return { table, key, synced: total };
}

async function cloudReachable() {
  try { await cloudPool.query('SELECT 1'); return true; } catch (_) { return false; }
}

async function runCycle() {
  if (cycleRunning || !localPool || !cloudPool) return { skipped: 'not-ready' };
  cycleRunning = true;
  const summary = { up: 0, down: 0, tables: [], reachable: false };
  try {
    if (!(await cloudReachable())) return summary;
    summary.reachable = true;
    for (const t of UP_TABLES) {
      const r = await replicate(localPool, cloudPool, t, `up:${t}`);
      if (r.synced) summary.up += r.synced;
      if (r.error || r.skipped) summary.tables.push(r);
    }
    for (const t of DOWN_TABLES) {
      const r = await replicate(cloudPool, localPool, t, `down:${t}`);
      if (r.synced) summary.down += r.synced;
      if (r.error || r.skipped) summary.tables.push(r);
    }
    if (summary.up || summary.down) console.log(`☁️  cloud-sync: ↑${summary.up} ↓${summary.down} rows`);
  } catch (e) {
    console.warn('☁️  cloud-sync cycle error:', e.message);
  } finally {
    cycleRunning = false;
  }
  return summary;
}

function initPools() {
  const cloudUrl = process.env.CLOUD_DATABASE_URL;
  const localUrl = process.env.DATABASE_URL;
  if (!cloudUrl || !localUrl || cloudUrl === localUrl) return false;
  localPool = new Pool({ connectionString: localUrl, max: 4 });
  cloudPool = new Pool({ connectionString: cloudUrl, max: 4, connectionTimeoutMillis: 8000, statement_timeout: 20000 });
  return true;
}

/** Start per SYNC_MODE. Returns the resolved mode. */
function startCloudSync() {
  mode = resolveMode();
  if (mode === 'off') { console.log('☁️  cloud-sync: OFF (complete offline island).'); return 'off'; }
  if (!initPools()) {
    console.log('☁️  cloud-sync not started (needs CLOUD_DATABASE_URL ≠ local DATABASE_URL).');
    mode = 'off';
    return 'off';
  }
  ensureWatermarkTable()
    .then(() => {
      const dirs = `↑${UP_TABLES.length}${DOWN_TABLES.length ? ` ↓${DOWN_TABLES.length}` : ''} tables`;
      if (mode === 'periodic') {
        console.log(`☁️  cloud-sync: PERIODIC every ${Math.round(INTERVAL_MS / 1000)}s (${dirs}).`);
        timer = setInterval(runCycle, INTERVAL_MS);
        runCycle();
      } else {
        console.log(`☁️  cloud-sync: MANUAL (${dirs}). Trigger via POST /api/local-server/sync-now.`);
      }
    })
    .catch((e) => console.warn('☁️  cloud-sync init failed:', e.message));
  return mode;
}

/** On-demand sync (used by the "Sync Now" endpoint). Works in periodic + manual modes. */
async function triggerSync() {
  if (mode === 'off' || !localPool) return { ok: false, mode, error: 'sync disabled (SYNC_MODE=off)' };
  const summary = await runCycle();
  return { ok: true, mode, ...summary };
}

async function getSyncStatus() {
  const status = { mode, upTables: UP_TABLES, downTables: DOWN_TABLES, intervalMs: INTERVAL_MS, running: cycleRunning, watermarks: [] };
  if (!localPool) return status;
  try {
    status.reachable = await cloudReachable();
    const r = await localPool.query('SELECT key, last_updated_at, last_run, last_error, rows_synced FROM sync_watermark ORDER BY key');
    status.watermarks = r.rows;
  } catch (_) {}
  return status;
}

function stopCloudSync() {
  if (timer) clearInterval(timer);
  timer = null;
  if (localPool) localPool.end().catch(() => {});
  if (cloudPool) cloudPool.end().catch(() => {});
  localPool = cloudPool = null;
}

module.exports = { startCloudSync, stopCloudSync, runCycle, triggerSync, getSyncStatus };
