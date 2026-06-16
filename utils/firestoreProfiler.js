/**
 * Firestore Daily Counter — simple read/write count per day.
 *
 * Monkey-patches Firestore SDK, counts in memory per request,
 * flushes to ONE Redis key per day at end of each request.
 *
 * Redis cost: 2 calls per request (1 kvGet + 1 kvSet).
 * ~2,000-10,000 Redis calls/day depending on traffic.
 */

const { kvGet, kvSet } = require('./kvCache');

let patched = false;

// Per-request counters (reset each request)
let reqReads = 0;
let reqWrites = 0;

function getDateKey() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `fscount:${yyyy}-${mm}-${dd}`;
}

async function flushToRedis() {
  const r = reqReads;
  const w = reqWrites;
  reqReads = 0;
  reqWrites = 0;
  if (r === 0 && w === 0) return;

  try {
    const key = getDateKey();
    const current = await kvGet(key);
    const data = current && typeof current === 'object' ? current : { r: 0, w: 0 };
    data.r += r;
    data.w += w;
    await kvSet(key, data, 604800); // 7 day TTL
  } catch (e) { /* silent — never block requests */ }
}

// Express middleware — flush counts at end of each request
function profilerMiddleware(req, res, next) {
  res.on('finish', () => { flushToRedis().catch(() => {}); });
  next();
}

// Patch Firestore SDK to count reads and writes
function enableProfiler(db) {
  if (patched) return;

  try {
    const tempCol = db.collection('__profiler_init__');
    const tempDoc = tempCol.doc('__temp__');

    const ColRefProto = Object.getPrototypeOf(tempCol);
    const QueryProto = Object.getPrototypeOf(ColRefProto);
    const DocRefProto = Object.getPrototypeOf(tempDoc);
    const FirestoreProto = Object.getPrototypeOf(db);

    // --- READ patches ---
    const origQueryGet = QueryProto.get;
    QueryProto.get = async function (...args) {
      const result = await origQueryGet.apply(this, args);
      try { reqReads += Math.max(1, result.size || 0); } catch (e) {}
      return result;
    };

    const origDocGet = DocRefProto.get;
    DocRefProto.get = async function (...args) {
      const result = await origDocGet.apply(this, args);
      reqReads++;
      return result;
    };

    const origGetAll = FirestoreProto.getAll;
    if (origGetAll) {
      FirestoreProto.getAll = async function (...args) {
        const result = await origGetAll.apply(this, args);
        try { reqReads += args.filter(a => a && typeof a.path === 'string').length; } catch (e) {}
        return result;
      };
    }

    // --- WRITE patches ---
    const origDocSet = DocRefProto.set;
    DocRefProto.set = async function (...args) {
      const result = await origDocSet.apply(this, args);
      reqWrites++;
      return result;
    };

    const origDocUpdate = DocRefProto.update;
    DocRefProto.update = async function (...args) {
      const result = await origDocUpdate.apply(this, args);
      reqWrites++;
      return result;
    };

    const origDocDelete = DocRefProto.delete;
    DocRefProto.delete = async function (...args) {
      const result = await origDocDelete.apply(this, args);
      reqWrites++;
      return result;
    };

    const origDocCreate = DocRefProto.create;
    if (origDocCreate) {
      DocRefProto.create = async function (...args) {
        const result = await origDocCreate.apply(this, args);
        reqWrites++;
        return result;
      };
    }

    const origColAdd = ColRefProto.add;
    if (origColAdd) {
      ColRefProto.add = async function (...args) {
        const result = await origColAdd.apply(this, args);
        reqWrites++;
        return result;
      };
    }

    patched = true;
    console.log('Firestore counter: active');
  } catch (err) {
    console.error('Firestore counter failed:', err.message);
  }
}

// Get daily counts for last N days
async function getDailyCounts(days = 7) {
  try {
    const keys = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(d.getUTCDate()).padStart(2, '0');
      keys.push(`fscount:${yyyy}-${mm}-${dd}`);
    }

    const results = await Promise.all(keys.map(k => kvGet(k)));
    const daily = [];
    for (let i = 0; i < keys.length; i++) {
      const date = keys[i].replace('fscount:', '');
      const data = results[i] && typeof results[i] === 'object' ? results[i] : { r: 0, w: 0 };
      daily.push({ date, reads: data.r || 0, writes: data.w || 0 });
    }
    return daily;
  } catch (err) {
    return [];
  }
}

module.exports = { enableProfiler, profilerMiddleware, getDailyCounts };
