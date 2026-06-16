/**
 * Firestore Daily Counter — simple daily read/write totals.
 *
 * Uses atomic Redis INCRBY — no race conditions on serverless.
 * 2 Redis keys per day: fscount:r:YYYY-MM-DD and fscount:w:YYYY-MM-DD
 * 2 Redis calls per request (one INCRBY for reads, one for writes).
 */

const { kvIncrBy, kvGet } = require('./kvCache');

let patched = false;
let reqReads = 0;
let reqWrites = 0;

function todayStr() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function flushToRedis() {
  const r = reqReads;
  const w = reqWrites;
  reqReads = 0;
  reqWrites = 0;
  if (r === 0 && w === 0) return;

  try {
    const date = todayStr();
    const ttl = 2592000; // 30 days
    if (r > 0) await kvIncrBy(`fscount:r:${date}`, r, ttl);
    if (w > 0) await kvIncrBy(`fscount:w:${date}`, w, ttl);
  } catch (e) { /* silent */ }
}

function profilerMiddleware(req, res, next) {
  res.on('finish', () => { flushToRedis().catch(() => {}); });
  next();
}

function enableProfiler(db) {
  if (patched) return;

  try {
    const tempCol = db.collection('__profiler_init__');
    const tempDoc = tempCol.doc('__temp__');
    const ColRefProto = Object.getPrototypeOf(tempCol);
    const QueryProto = Object.getPrototypeOf(ColRefProto);
    const DocRefProto = Object.getPrototypeOf(tempDoc);
    const FirestoreProto = Object.getPrototypeOf(db);

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

async function getDailyCounts(days = 7) {
  try {
    const dates = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
    }

    const results = await Promise.all(
      dates.flatMap(date => [kvGet(`fscount:r:${date}`), kvGet(`fscount:w:${date}`)])
    );

    return dates.map((date, i) => ({
      date,
      reads: Number(results[i * 2]) || 0,
      writes: Number(results[i * 2 + 1]) || 0,
    }));
  } catch (err) {
    return [];
  }
}

module.exports = { enableProfiler, profilerMiddleware, getDailyCounts };
