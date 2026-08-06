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

// FULL restaurant sync, split-authority (bidirectional overall, conflict-free):
//   UP (local → cloud): transactions + things created/mutated offline (local is truth offline).
//   DOWN (cloud → local): catalog/config the owner edits on the web (cloud is truth).
// Missing tables are skipped gracefully, so listing extras is safe. Override per-site via env.
const UP_TABLES = (process.env.CLOUD_SYNC_TABLES ||
  'orders,payments,daily_stats,shifts,cash_registers,customers')
  .split(',').map((s) => s.trim()).filter(Boolean);
// NOTE: `restaurants` (and its embedded menu) is intentionally NOT here — the menu lives in
// Firestore and is pulled via API provisioning (provisioning.js). Syncing the menu-less cloud
// Postgres restaurant row would clobber the menu. Structural/config tables sync down here.
//
// orders + payments are in BOTH up and down → true two-way: orders placed on the web (or on
// another terminal) flow DOWN into this app, and orders placed here flow UP. Safe because each
// order has a globally-unique id, so merge = UNION by id (never a double-count); edits resolve
// last-write-wins by updated_at. (daily_stats stays UP-only — it's an aggregate, not row-keyed,
// so two-waying it would clobber; the cloud recomputes its own.)
const DOWN_TABLES = (process.env.CLOUD_SYNC_DOWN_TABLES ||
  'orders,payments,staff_users,floors,tables,offers,recipes,suppliers,inventory,customers,discount_settings,coupons,customer_segments,tax_groups')
  .split(',').map((s) => s.trim()).filter(Boolean);
// One-restaurant device: DOWN pulls ONLY this restaurant's rows from the shared cloud DB.
const SCOPE_RID = (process.env.SYNC_RESTAURANT_ID || '').trim() || null;

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
let cyclesCompleted = 0;   // how many full sync cycles have finished (UI uses this to detect
let lastCycleAt = null;    // "first sync done" and to show a live progress/status pill)
let mode = 'off';

async function getColumns(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rows;
}

// Real primary-key columns for a table (handles composite PKs like floors=(id,restaurant_id)),
// so ON CONFLICT targets the actual PK instead of assuming (id).
const _pkCache = new Map();
async function getPk(client, table) {
  if (_pkCache.has(table)) return _pkCache.get(table);
  let pk = ['id'];
  try {
    const r = await client.query(
      `SELECT a.attname FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = ('public.' || $1)::regclass AND i.indisprimary
       ORDER BY array_position(i.indkey, a.attnum)`, [table]);
    if (r.rows.length) pk = r.rows.map((x) => x.attname);
  } catch (_) {}
  _pkCache.set(table, pk);
  return pk;
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
// scopeRid (optional): restrict to ONE restaurant. CRITICAL for DOWN (cloud→local) — the
// cloud holds every restaurant's rows, and a single-restaurant device must pull ONLY its
// own. Applied only when the table actually has a restaurant_id column (skips globals).
async function replicate(src, dst, table, key, scopeRid = null) {
  const srcCols = await getColumns(src, table);
  if (!srcCols.length) return { table, key, skipped: 'missing at source' };
  const srcNames = srcCols.map((c) => c.column_name);
  if (!srcNames.includes('id') || !srcNames.includes('updated_at')) return { table, key, skipped: 'no id/updated_at' };

  const dstNames = new Set((await getColumns(dst, table)).map((c) => c.column_name));
  if (!dstNames.size) return { table, key, skipped: 'missing at destination' };

  const cols = srcCols.filter((c) => dstNames.has(c.column_name));
  const names = cols.map((c) => c.column_name);
  const typeOf = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  const pk = await getPk(dst, table);            // real PK (composite-aware) at the destination
  const setCols = names.filter((c) => !pk.includes(c));
  const quoted = names.map((c) => `"${c}"`).join(',');
  const ph = names.map((_, i) => `$${i + 1}`).join(',');
  const conflictTgt = pk.map((c) => `"${c}"`).join(',');
  const upd = setCols.length ? setCols.map((c) => `"${c}"=EXCLUDED."${c}"`).join(',') : `"${pk[0]}"=EXCLUDED."${pk[0]}"`;
  const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${ph}) ON CONFLICT (${conflictTgt}) DO UPDATE SET ${upd}`;

  // The restaurants table is keyed by `id` (= the restaurant id); every other table scopes
  // by `restaurant_id`. Only scope when the column exists (skips truly-global tables).
  const scopeCol = table === 'restaurants' ? 'id' : 'restaurant_id';
  const scoped = scopeRid && srcNames.includes(scopeCol);
  const scopeSql = scoped ? ` AND "${scopeCol}" = $2` : '';

  let wm = await getWatermark(key);
  let lastGood = wm;
  let total = 0, failed = 0;
  let lastErr = null;
  for (;;) {
    const res = await src.query(
      `SELECT ${quoted} FROM "${table}" WHERE updated_at > $1${scopeSql} ORDER BY updated_at ASC LIMIT ${BATCH}`,
      scoped ? [wm, scopeRid] : [wm]);
    if (!res.rows.length) break;
    let batch = 0;
    for (const row of res.rows) {
      try {
        await dst.query(sql, names.map((c) => coerce(row[c], typeOf[c])));
        batch++; total++;
      } catch (rowErr) {
        // SKIP the bad row and keep going (one malformed row must not block the whole table
        // or wedge the watermark). Record the last error for visibility.
        failed++; lastErr = `${row.id}: ${rowErr.message}`;
      }
      if (row.updated_at && row.updated_at > lastGood) lastGood = row.updated_at;
    }
    wm = lastGood;
    await setWatermark(key, wm, lastErr, batch); // advance watermark past processed rows
    if (res.rows.length < BATCH) break;
  }
  return { table, key, synced: total, ...(failed ? { failed, error: lastErr } : {}) };
}

async function cloudReachable() {
  try { await cloudPool.query('SELECT 1'); return true; } catch (_) { return false; }
}

async function runCycle() {
  if (cycleRunning || !localPool || !cloudPool) return { skipped: 'not-ready' };
  cycleRunning = true;
  const summary = { up: 0, down: 0, tables: [], reachable: false, ordersMoved: 0 };
  const ORDER_TABLES = new Set(['orders', 'payments']);
  try {
    if (!(await cloudReachable())) return summary;
    summary.reachable = true;
    for (const t of UP_TABLES) {
      const r = await replicate(localPool, cloudPool, t, `up:${t}`);
      if (r.synced) { summary.up += r.synced; if (ORDER_TABLES.has(t)) summary.ordersMoved += r.synced; }
      if (r.error || r.skipped) summary.tables.push(r);
    }
    for (const t of DOWN_TABLES) {
      const r = await replicate(cloudPool, localPool, t, `down:${t}`, SCOPE_RID);
      if (r.synced) { summary.down += r.synced; if (ORDER_TABLES.has(t)) summary.ordersMoved += r.synced; }
      if (r.error || r.skipped) summary.tables.push(r);
    }
    if (summary.up || summary.down) console.log(`☁️  cloud-sync: ↑${summary.up} ↓${summary.down} rows`);
    // Recompute derived aggregates (revenue/daily_stats) from the synced orders — copied-in
    // rows don't trigger the per-order increment, so the host rebuilds stats from orders.
    if (summary.ordersMoved && onOrdersChanged) {
      try { await onOrdersChanged(summary); } catch (e) { console.warn('☁️  onOrdersChanged hook error:', e.message); }
    }
  } catch (e) {
    console.warn('☁️  cloud-sync cycle error:', e.message);
  } finally {
    cycleRunning = false;
    if (summary.reachable) { cyclesCompleted += 1; lastCycleAt = new Date().toISOString(); }
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

// Optional hook: called after a cycle that moved order rows, so the host can RECOMPUTE
// derived aggregates (daily_stats/revenue) from the now-synced orders. Aggregates are
// incrementally maintained per-order, so copied-in rows won't update them — the host
// recomputes instead (source of truth = orders).
let onOrdersChanged = null;

/** Start per SYNC_MODE. opts.onOrdersChanged({up,down}) fires after order rows sync. */
function startCloudSync(opts = {}) {
  onOrdersChanged = typeof opts.onOrdersChanged === 'function' ? opts.onOrdersChanged : null;
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
  const status = {
    mode, upTables: UP_TABLES, downTables: DOWN_TABLES, intervalMs: INTERVAL_MS,
    running: cycleRunning, cyclesCompleted, lastCycleAt, watermarks: [],
    firstSyncDone: cyclesCompleted >= 1, totalSynced: 0, categories: [],
  };
  if (!localPool) return status;
  try {
    status.reachable = await cloudReachable();
    const r = await localPool.query('SELECT key, last_updated_at, last_run, last_error, rows_synced FROM sync_watermark ORDER BY key');
    status.watermarks = r.rows;
    // Friendly rollup for the loader: one row per table (direction stripped), total rows moved.
    const byTable = {};
    for (const w of r.rows) {
      const table = String(w.key).replace(/^(up|down):/, '');
      byTable[table] = (byTable[table] || 0) + Number(w.rows_synced || 0);
      status.totalSynced += Number(w.rows_synced || 0);
    }
    status.categories = Object.entries(byTable).map(([table, rows]) => ({ table, rows }));
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
