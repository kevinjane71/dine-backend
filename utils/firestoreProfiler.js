/**
 * Firestore Profiler (Reads + Writes + Per-Endpoint tracking)
 *
 * Monkey-patches Firestore SDK methods to count reads and writes per collection,
 * AND per API endpoint using AsyncLocalStorage to tie operations to requests.
 *
 * Enable via: FIRESTORE_PROFILER=true env var
 * View data via: GET /api/super-admin/firestore-usage
 *
 * Safe: all tracking is fire-and-forget. If Redis fails, profiling
 * silently stops. Zero impact on request handling.
 *
 * Works on Vercel Pro (Node.js 18+ required for AsyncLocalStorage).
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { kvGet, kvSet, kvDel } = require('./kvCache');

let enabled = false;
let patched = false;

// AsyncLocalStorage to track which API endpoint is currently executing
const requestContext = new AsyncLocalStorage();

// In-memory buffers — flushed to Redis periodically
const readBuffer = {};     // { collectionName: count }
const writeBuffer = {};    // { collectionName: count }
const endpointBuffer = {}; // { "METHOD /path": { reads: N, writes: N, cols: { col: [reads, writes] } } }
let lastFlush = Date.now();
const FLUSH_INTERVAL_MS = 10_000;

function getHourKey(type) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  return `fsprof:${type}:${yyyy}-${mm}-${dd}-${hh}`;
}

function extractCollection(path) {
  if (!path) return 'unknown';
  const first = path.split('/')[0];
  return first || 'unknown';
}

/**
 * Get a normalized endpoint key from the current request.
 * Uses req.route.path (Express matched pattern) when available,
 * otherwise normalizes the URL by replacing dynamic IDs with :id.
 */
function getEndpointKey() {
  const req = requestContext.getStore();
  if (!req) return null;
  const method = req.method || 'GET';
  // Express route pattern (most accurate — gives /api/orders/:restaurantId)
  if (req.route && req.route.path) {
    const base = req.baseUrl || '';
    return `${method} ${base}${req.route.path}`;
  }
  // Fallback: normalize path by replacing dynamic segments
  let path = (req.originalUrl || req.path || '/').split('?')[0];
  path = path
    .replace(/\/[a-zA-Z0-9_-]{20,}/g, '/:id')     // Firestore doc IDs (20+ alphanumeric)
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-/g, '/:id') // UUIDs
    .replace(/\/\d{10,}/g, '/:id');                  // Timestamps
  return `${method} ${path}`;
}

function track(buf, collection, count, isWrite) {
  if (!enabled || count <= 0) return;
  buf[collection] = (buf[collection] || 0) + count;

  // Also track per-endpoint
  const ep = getEndpointKey();
  if (ep) {
    if (!endpointBuffer[ep]) endpointBuffer[ep] = { reads: 0, writes: 0, cols: {} };
    if (isWrite) {
      endpointBuffer[ep].writes += count;
    } else {
      endpointBuffer[ep].reads += count;
    }
    if (!endpointBuffer[ep].cols[collection]) endpointBuffer[ep].cols[collection] = [0, 0];
    endpointBuffer[ep].cols[collection][isWrite ? 1 : 0] += count;
  }

  // Flush if interval elapsed
  if (Date.now() - lastFlush > FLUSH_INTERVAL_MS) {
    flushToRedis();
  }
}

async function flushBuffer(buf, type) {
  const snapshot = { ...buf };
  for (const key of Object.keys(buf)) delete buf[key];

  if (Object.keys(snapshot).length === 0) return;

  try {
    const hourKey = getHourKey(type);
    const existing = await kvGet(hourKey);
    const merged = existing && typeof existing === 'object' ? { ...existing } : {};
    for (const [col, count] of Object.entries(snapshot)) {
      merged[col] = (merged[col] || 0) + count;
    }
    await kvSet(hourKey, merged, 172800);

    const indexKey = `fsprof:${type}:index`;
    const index = await kvGet(indexKey);
    const hours = Array.isArray(index) ? index : [];
    if (!hours.includes(hourKey)) {
      hours.push(hourKey);
      while (hours.length > 48) hours.shift();
      await kvSet(indexKey, hours, 172800);
    }
  } catch (err) { /* silent */ }
}

async function flushEndpointBuffer() {
  const snapshot = { ...endpointBuffer };
  for (const key of Object.keys(endpointBuffer)) delete endpointBuffer[key];

  if (Object.keys(snapshot).length === 0) return;

  try {
    const hourKey = getHourKey('ep');
    const existing = await kvGet(hourKey);
    const merged = existing && typeof existing === 'object' ? { ...existing } : {};

    for (const [ep, data] of Object.entries(snapshot)) {
      if (!merged[ep]) merged[ep] = { reads: 0, writes: 0, cols: {} };
      merged[ep].reads += data.reads;
      merged[ep].writes += data.writes;
      for (const [col, rw] of Object.entries(data.cols)) {
        if (!merged[ep].cols[col]) merged[ep].cols[col] = [0, 0];
        merged[ep].cols[col][0] += rw[0];
        merged[ep].cols[col][1] += rw[1];
      }
    }

    // Cap: keep only top 100 endpoints per hour to avoid Redis bloat
    const entries = Object.entries(merged);
    if (entries.length > 100) {
      entries.sort((a, b) => (b[1].reads + b[1].writes) - (a[1].reads + a[1].writes));
      const trimmed = {};
      for (const [ep, val] of entries.slice(0, 100)) {
        // Cap: top 15 collections per endpoint
        const colEntries = Object.entries(val.cols).sort((a, b) => (b[1][0] + b[1][1]) - (a[1][0] + a[1][1]));
        const trimmedCols = {};
        for (const [col, rw] of colEntries.slice(0, 15)) trimmedCols[col] = rw;
        trimmed[ep] = { reads: val.reads, writes: val.writes, cols: trimmedCols };
      }
      await kvSet(hourKey, trimmed, 172800);
    } else {
      await kvSet(hourKey, merged, 172800);
    }

    const indexKey = 'fsprof:ep:index';
    const index = await kvGet(indexKey);
    const hours = Array.isArray(index) ? index : [];
    if (!hours.includes(hourKey)) {
      hours.push(hourKey);
      while (hours.length > 48) hours.shift();
      await kvSet(indexKey, hours, 172800);
    }
  } catch (err) { /* silent */ }
}

async function flushToRedis() {
  lastFlush = Date.now();
  await Promise.all([
    flushBuffer(readBuffer, 'reads'),
    flushBuffer(writeBuffer, 'writes'),
    flushEndpointBuffer()
  ]);
}

/**
 * Express middleware — wraps each request in AsyncLocalStorage context.
 * Add AFTER route matching or as early as possible.
 * Usage: app.use(profilerMiddleware);
 */
function profilerMiddleware(req, res, next) {
  if (!enabled) return next();
  requestContext.run(req, next);
}

/**
 * Enable the profiler by patching Firestore SDK prototypes.
 */
function enableProfiler(db) {
  if (patched) {
    enabled = true;
    return;
  }

  try {
    const tempCol = db.collection('__profiler_init__');
    const tempDoc = tempCol.doc('__temp__');

    const ColRefProto = Object.getPrototypeOf(tempCol);
    const QueryProto = Object.getPrototypeOf(ColRefProto);
    const DocRefProto = Object.getPrototypeOf(tempDoc);
    const FirestoreProto = Object.getPrototypeOf(db);

    // ─── READ PATCHES ──────────────────────────────────────────────

    const origQueryGet = QueryProto.get;
    const origDocGet = DocRefProto.get;
    const origGetAll = FirestoreProto.getAll;

    QueryProto.get = async function (...args) {
      const result = await origQueryGet.apply(this, args);
      if (enabled) {
        try {
          let col = 'unknown';
          if (this._queryOptions && this._queryOptions.collectionId) {
            col = this._queryOptions.collectionId;
          } else if (typeof this.path === 'string') {
            col = extractCollection(this.path);
          } else if (this._path && this._path.segments) {
            col = this._path.segments[0] || 'unknown';
          }
          track(readBuffer, col, Math.max(1, result.size || 0), false);
        } catch (e) { /* silent */ }
      }
      return result;
    };

    DocRefProto.get = async function (...args) {
      const result = await origDocGet.apply(this, args);
      if (enabled) {
        try {
          track(readBuffer, extractCollection(this.path), 1, false);
        } catch (e) { /* silent */ }
      }
      return result;
    };

    if (origGetAll) {
      FirestoreProto.getAll = async function (...args) {
        const result = await origGetAll.apply(this, args);
        if (enabled) {
          try {
            const refs = args.filter(a => a && typeof a.path === 'string');
            const cols = {};
            refs.forEach(ref => {
              const col = extractCollection(ref.path);
              cols[col] = (cols[col] || 0) + 1;
            });
            for (const [col, count] of Object.entries(cols)) {
              track(readBuffer, col, count, false);
            }
          } catch (e) { /* silent */ }
        }
        return result;
      };
    }

    // ─── WRITE PATCHES ─────────────────────────────────────────────

    const origDocSet = DocRefProto.set;
    const origDocUpdate = DocRefProto.update;
    const origDocDelete = DocRefProto.delete;
    const origDocCreate = DocRefProto.create;

    DocRefProto.set = async function (...args) {
      const result = await origDocSet.apply(this, args);
      if (enabled) {
        try { track(writeBuffer, extractCollection(this.path), 1, true); } catch (e) { /* silent */ }
      }
      return result;
    };

    DocRefProto.update = async function (...args) {
      const result = await origDocUpdate.apply(this, args);
      if (enabled) {
        try { track(writeBuffer, extractCollection(this.path), 1, true); } catch (e) { /* silent */ }
      }
      return result;
    };

    DocRefProto.delete = async function (...args) {
      const result = await origDocDelete.apply(this, args);
      if (enabled) {
        try { track(writeBuffer, extractCollection(this.path), 1, true); } catch (e) { /* silent */ }
      }
      return result;
    };

    if (origDocCreate) {
      DocRefProto.create = async function (...args) {
        const result = await origDocCreate.apply(this, args);
        if (enabled) {
          try { track(writeBuffer, extractCollection(this.path), 1, true); } catch (e) { /* silent */ }
        }
        return result;
      };
    }

    const origColAdd = ColRefProto.add;
    if (origColAdd) {
      ColRefProto.add = async function (...args) {
        const result = await origColAdd.apply(this, args);
        if (enabled) {
          try {
            const col = typeof this.path === 'string' ? extractCollection(this.path) : (this.id || 'unknown');
            track(writeBuffer, col, 1, true);
          } catch (e) { /* silent */ }
        }
        return result;
      };
    }

    patched = true;
    enabled = true;
    console.log('📊 Firestore profiler: ENABLED (tracking reads + writes + endpoints)');
  } catch (err) {
    console.error('📊 Firestore profiler: failed to patch —', err.message);
  }
}

function disableProfiler() {
  enabled = false;
  flushToRedis().catch(() => {});
  console.log('📊 Firestore profiler: DISABLED');
}

function isEnabled() {
  return enabled;
}

// ─── Reports ────────────────────────────────────────────────────────

async function getReportForType(type, lastNHours) {
  const indexKey = `fsprof:${type}:index`;
  const index = await kvGet(indexKey);
  const hourKeys = Array.isArray(index) ? index.slice(-lastNHours) : [];

  const hours = [];
  const totals = {};

  const hourDataArray = await Promise.all(hourKeys.map(k => kvGet(k)));
  for (let i = 0; i < hourKeys.length; i++) {
    const data = hourDataArray[i];
    if (!data || typeof data !== 'object') continue;
    const hour = hourKeys[i].replace(`fsprof:${type}:`, '');
    hours.push({ hour, collections: data });
    for (const [col, count] of Object.entries(data)) {
      totals[col] = (totals[col] || 0) + count;
    }
  }

  const sorted = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .reduce((obj, [k, v]) => { obj[k] = v; return obj; }, {});

  return {
    total: Object.values(totals).reduce((s, v) => s + v, 0),
    byCollection: sorted,
    hourly: hours
  };
}

async function getEndpointReport(lastNHours) {
  const indexKey = 'fsprof:ep:index';
  const index = await kvGet(indexKey);
  const hourKeys = Array.isArray(index) ? index.slice(-lastNHours) : [];

  const totals = {}; // { endpoint: { reads, writes, cols: { col: [r, w] } } }

  const hourDataArray = await Promise.all(hourKeys.map(k => kvGet(k)));
  for (const data of hourDataArray) {
    if (!data || typeof data !== 'object') continue;
    for (const [ep, val] of Object.entries(data)) {
      if (!val || typeof val !== 'object') continue;
      if (!totals[ep]) totals[ep] = { reads: 0, writes: 0, cols: {} };
      totals[ep].reads += val.reads || 0;
      totals[ep].writes += val.writes || 0;
      if (val.cols && typeof val.cols === 'object') {
        for (const [col, rw] of Object.entries(val.cols)) {
          if (!totals[ep].cols[col]) totals[ep].cols[col] = [0, 0];
          if (Array.isArray(rw)) {
            totals[ep].cols[col][0] += rw[0] || 0;
            totals[ep].cols[col][1] += rw[1] || 0;
          }
        }
      }
    }
  }

  // Sort endpoints by total operations descending
  const sorted = Object.entries(totals)
    .sort((a, b) => (b[1].reads + b[1].writes) - (a[1].reads + a[1].writes));

  return sorted.map(([endpoint, data]) => {
    // Sort collections within endpoint by total ops
    const colsSorted = Object.entries(data.cols)
      .sort((a, b) => (b[1][0] + b[1][1]) - (a[1][0] + a[1][1]))
      .map(([col, rw]) => ({ collection: col, reads: rw[0], writes: rw[1] }));
    return { endpoint, reads: data.reads, writes: data.writes, total: data.reads + data.writes, collections: colsSorted };
  });
}

async function getReport(lastNHours = 24) {
  await flushToRedis();

  try {
    const [reads, writes, endpoints] = await Promise.all([
      getReportForType('reads', lastNHours),
      getReportForType('writes', lastNHours),
      getEndpointReport(lastNHours)
    ]);

    return {
      enabled,
      hoursTracked: Math.max(reads.hourly.length, writes.hourly.length),
      reads: { total: reads.total, byCollection: reads.byCollection, hourly: reads.hourly },
      writes: { total: writes.total, byCollection: writes.byCollection, hourly: writes.hourly },
      endpoints
    };
  } catch (err) {
    return { enabled, error: err.message, reads: { total: 0, byCollection: {} }, writes: { total: 0, byCollection: {} }, endpoints: [] };
  }
}

async function clearReport() {
  try {
    for (const type of ['reads', 'writes', 'ep']) {
      const indexKey = `fsprof:${type}:index`;
      const index = await kvGet(indexKey);
      if (Array.isArray(index)) {
        await Promise.all(index.map(k => kvDel(k)));
      }
      await kvDel(indexKey);
    }
    for (const key of Object.keys(readBuffer)) delete readBuffer[key];
    for (const key of Object.keys(writeBuffer)) delete writeBuffer[key];
    for (const key of Object.keys(endpointBuffer)) delete endpointBuffer[key];
  } catch (err) { /* silent */ }
}

module.exports = {
  enableProfiler,
  disableProfiler,
  isEnabled,
  getReport,
  clearReport,
  flushToRedis,
  profilerMiddleware,
};
