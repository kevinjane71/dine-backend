/**
 * cloudSyncWorker — pushes data created OFFLINE on the local server up to the cloud
 * when the internet is back. Runs ONLY on the on-prem local server (never in the cloud).
 *
 * Because the local server and the cloud both run Postgres with the SAME schema (this
 * is the pg-full-migration branch), we don't re-implement any business logic — we do
 * generic, incremental, idempotent ROW replication:
 *
 *   for each syncable table with an `updated_at` column:
 *     SELECT * FROM t WHERE updated_at > <watermark> ORDER BY updated_at LIMIT N
 *     INSERT ... ON CONFLICT (id) DO UPDATE   (idempotent by UUID primary key)
 *     advance the per-table watermark
 *
 * Direction is local → cloud only (the local box is the source of truth while offline).
 * A failed row (e.g. a missing parent FK) stops that table for the cycle WITHOUT
 * advancing past it, so it's retried next cycle — no data loss, self-healing.
 *
 * Enable on the local server with:
 *   CLOUD_SYNC_ENABLED=true
 *   CLOUD_DATABASE_URL=postgresql://…cloud-sql…   (the production/cloud Postgres)
 *   DATABASE_URL=…local…                          (the embedded/local Postgres)
 */

const { Pool } = require('pg');

const INTERVAL_MS = parseInt(process.env.CLOUD_SYNC_INTERVAL_MS, 10) || 45000;
const BATCH = parseInt(process.env.CLOUD_SYNC_BATCH, 10) || 500;
// Parent → child order so FK targets exist in the cloud before their references.
const DEFAULT_TABLES = 'customers,tables,orders,payments,daily_stats,shifts,cash_registers,inventory';
const SYNC_TABLES = (process.env.CLOUD_SYNC_TABLES || DEFAULT_TABLES)
  .split(',').map((s) => s.trim()).filter(Boolean);

let localPool = null;
let cloudPool = null;
let timer = null;
let cycleRunning = false;

async function getColumns(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rows; // [{ column_name, data_type }]
}

async function ensureWatermarkTable() {
  await localPool.query(`
    CREATE TABLE IF NOT EXISTS sync_watermark (
      table_name text PRIMARY KEY,
      last_updated_at timestamptz,
      last_run timestamptz,
      last_error text
    )`);
}

async function getWatermark(table) {
  const r = await localPool.query('SELECT last_updated_at FROM sync_watermark WHERE table_name = $1', [table]);
  return (r.rows[0] && r.rows[0].last_updated_at) || new Date(0);
}

async function setWatermark(table, ts, err) {
  await localPool.query(
    `INSERT INTO sync_watermark (table_name, last_updated_at, last_run, last_error)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (table_name) DO UPDATE
       SET last_updated_at = EXCLUDED.last_updated_at, last_run = now(), last_error = EXCLUDED.last_error`,
    [table, ts, err || null]);
}

// jsonb/json values come back as JS objects/arrays; they must be stringified so pg
// sends them as JSON (not as a Postgres array literal) on re-insert.
function coerce(value, dataType) {
  if (value == null) return value;
  if ((dataType === 'jsonb' || dataType === 'json') && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

async function syncTable(table) {
  const localCols = await getColumns(localPool, table);
  if (!localCols.length) return { table, skipped: 'not present locally' };
  const names = localCols.map((c) => c.column_name);
  if (!names.includes('id')) return { table, skipped: 'no id column' };
  if (!names.includes('updated_at')) return { table, skipped: 'no updated_at column' };

  const cloudCols = await getColumns(cloudPool, table);
  const cloudNames = new Set(cloudCols.map((c) => c.column_name));
  if (!cloudNames.size) return { table, skipped: 'not present in cloud' };

  // Only columns present in BOTH schemas (drift-safe).
  const cols = localCols.filter((c) => cloudNames.has(c.column_name));
  const colNames = cols.map((c) => c.column_name);
  const typeByName = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  const setCols = colNames.filter((c) => c !== 'id');

  const quoted = colNames.map((c) => `"${c}"`).join(',');
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(',');
  const updates = setCols.map((c) => `"${c}"=EXCLUDED."${c}"`).join(',');
  const upsertSql = `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})
                     ON CONFLICT (id) DO UPDATE SET ${updates}`;

  let watermark = await getWatermark(table);
  let lastGood = watermark;
  let synced = 0;

  for (;;) {
    const res = await localPool.query(
      `SELECT ${quoted} FROM "${table}" WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT ${BATCH}`,
      [watermark]);
    if (!res.rows.length) break;

    for (const row of res.rows) {
      const vals = colNames.map((c) => coerce(row[c], typeByName[c]));
      try {
        await cloudPool.query(upsertSql, vals);
        synced++;
        if (row.updated_at && row.updated_at > lastGood) lastGood = row.updated_at;
      } catch (rowErr) {
        // Stop this table here WITHOUT skipping the failed row — retried next cycle.
        await setWatermark(table, lastGood, `${row.id}: ${rowErr.message}`.slice(0, 300));
        return { table, synced, error: rowErr.message, stoppedAt: row.id };
      }
    }
    watermark = lastGood;
    await setWatermark(table, watermark, null);
    if (res.rows.length < BATCH) break;
  }
  return { table, synced };
}

async function cloudReachable() {
  try {
    await cloudPool.query('SELECT 1');
    return true;
  } catch (_) {
    return false;
  }
}

async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    if (!(await cloudReachable())) return; // offline — try again next tick
    let pushed = 0;
    for (const table of SYNC_TABLES) {
      try {
        const r = await syncTable(table);
        if (r.synced) pushed += r.synced;
        if (r.error) console.warn(`☁️  cloud-sync ${table}: stopped at ${r.stoppedAt} — ${r.error}`);
      } catch (tErr) {
        console.warn(`☁️  cloud-sync ${table} failed:`, tErr.message);
      }
    }
    if (pushed) console.log(`☁️  cloud-sync: pushed ${pushed} row(s) to cloud`);
  } catch (e) {
    console.warn('☁️  cloud-sync cycle error:', e.message);
  } finally {
    cycleRunning = false;
  }
}

/** Start the worker if configured for the local server. No-op otherwise. */
function startCloudSync() {
  const cloudUrl = process.env.CLOUD_DATABASE_URL;
  const localUrl = process.env.DATABASE_URL;
  if (process.env.CLOUD_SYNC_ENABLED !== 'true') return false;
  if (!cloudUrl || !localUrl || cloudUrl === localUrl) {
    console.log('☁️  cloud-sync not started (needs CLOUD_DATABASE_URL ≠ local DATABASE_URL).');
    return false;
  }
  try {
    localPool = new Pool({ connectionString: localUrl, max: 4 });
    cloudPool = new Pool({ connectionString: cloudUrl, max: 4, connectionTimeoutMillis: 8000, statement_timeout: 20000 });
  } catch (e) {
    console.warn('☁️  cloud-sync pools failed:', e.message);
    return false;
  }
  ensureWatermarkTable()
    .then(() => {
      console.log(`☁️  cloud-sync worker started — pushing ${SYNC_TABLES.length} tables to cloud every ${Math.round(INTERVAL_MS / 1000)}s`);
      timer = setInterval(runCycle, INTERVAL_MS);
      runCycle(); // first pass shortly after boot
    })
    .catch((e) => console.warn('☁️  cloud-sync init failed:', e.message));
  return true;
}

function stopCloudSync() {
  if (timer) clearInterval(timer);
  timer = null;
  if (localPool) localPool.end().catch(() => {});
  if (cloudPool) cloudPool.end().catch(() => {});
}

module.exports = { startCloudSync, stopCloudSync, runCycle };
