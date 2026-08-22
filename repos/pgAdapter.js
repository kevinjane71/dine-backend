/**
 * pgAdapter.js — Firestore-compatible API layer backed by PostgreSQL.
 *
 * When DATABASE_URL is set, this adapter replaces Firestore so ALL existing
 * code continues to work without changes.
 *
 * Usage:
 *   const { createPgDb } = require('./pgAdapter');
 *   const pgDb = createPgDb(registry, firestoreDb);
 *   pgDb.collection('orders').where('restaurantId', '==', 'abc').get();
 *
 * For unmapped collections the adapter falls back to the real firestoreDb.
 */

const { query: pgQuery, getClient } = require('./pgClient');
const {
  buildUpsert,
  buildInsert,
  buildUpdate,
  isFieldValueSentinel,
  toJsonbValue,
  convertTimestamp,
} = require('./queryBuilder');

// Fix node-postgres returning NUMERIC as strings — parse them as JS numbers
const pg = require('pg');
// NUMERIC (OID 1700)
pg.types.setTypeParser(1700, (val) => parseFloat(val));
// INT8 / BIGINT (OID 20)
pg.types.setTypeParser(20, (val) => parseInt(val, 10));

// Monotonic counter for unique SAVEPOINT names inside transactions/batches.
let _savepointSeq = 0;

// ---------------------------------------------------------------------------
// Redis Cache Layer (Upstash — kvCache)
// ---------------------------------------------------------------------------

const { kvGet, kvSet, kvDel, kvIncrBy } = require('../utils/kvCache');
const crypto = require('crypto');

/**
 * Table version keys track write generations. When any doc in a table is
 * written, the version bumps. Query cache keys include the version so they
 * auto-invalidate without needing to enumerate cached queries.
 *
 * Cache key patterns:
 *   Doc read:   pg:{table}:v{version}:{id}
 *   Query read: pg:{table}:v{version}:q:{hash}
 *   Version:    pg:{table}:ver
 */

async function getTableVersion(table) {
  const ver = await kvGet(`pg:${table}:ver`);
  return ver || 0;
}

async function bumpTableVersion(table) {
  // Increment version; TTL 1 hour (will auto-reset if it expires — cache just misses)
  await kvIncrBy(`pg:${table}:ver`, 1, 3600).catch(() => {});
}

function docCacheKey(table, version, id) {
  return `pg:${table}:v${version}:${id}`;
}

function queryCacheKey(table, version, queryDesc) {
  const hash = crypto.createHash('md5').update(JSON.stringify(queryDesc)).digest('hex').slice(0, 12);
  return `pg:${table}:v${version}:q:${hash}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OP_MAP = {
  '==': '=',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  'in': 'ANY',
  'not-in': 'NOT ANY',
  'array-contains': '@>',
};

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
}

// Only plain identifiers may be interpolated into SQL as column names
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function resolveField(fieldMap, field) {
  // Support FieldPath objects (e.g. FieldPath.documentId() → '__name__')
  if (typeof field !== 'string') {
    const segments = field && field.segments;
    const s = Array.isArray(segments) ? segments.join('.') : String(field);
    if (s === '__name__') return 'id';
    field = s;
  }
  if (field === '__name__') return 'id';
  const col = fieldMap[field] || camelToSnake(field);
  if (!SAFE_IDENT_RE.test(col)) {
    throw new Error(`[pgAdapter] Unsafe column name derived from field "${field}"`);
  }
  return col;
}

// Per-table real-column cache (lazy, module-lived). Lets a WHERE on a field whose
// resolved column does NOT physically exist fall back to extra_data->>'field' —
// the symmetric read side of write-overflow (unmapped writes go to
// extra_data.<originalKey>). Prevents "column does not exist" on PG for any field
// that isn't in the collection's field map. Returns null if introspection fails
// (then callers behave exactly as before — no fallback).
const _tableColsCache = new Map();
const _tableTextColsCache = new Map(); // table -> Set of text-typed column names (for COLLATE "C")
const _TEXT_TYPES = new Set(['text', 'character varying', 'character', 'varchar', 'char', 'citext', 'name']);
async function getTableColumns(table) {
  if (_tableColsCache.has(table)) return _tableColsCache.get(table);
  try {
    const res = await pgQuery(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      [table]
    );
    const set = new Set((res.rows || []).map((r) => String(r.column_name).toLowerCase()));
    const textSet = new Set((res.rows || [])
      .filter((r) => _TEXT_TYPES.has(String(r.data_type).toLowerCase()))
      .map((r) => String(r.column_name).toLowerCase()));
    const val = set.size > 0 ? set : null;
    if (val) { _tableColsCache.set(table, val); _tableTextColsCache.set(table, textSet); }
    return val;
  } catch (_) {
    return null;
  }
}
// Text-typed columns for a table (populated by getTableColumns). Used to add COLLATE "C"
// so string ORDER BY matches Firestore's byte-order sort instead of the DB's locale collation.
function getTextColumns(table) { return _tableTextColsCache.get(table) || null; }

function generateId() {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 20; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// ---------------------------------------------------------------------------
// FieldValue sentinel helpers
// ---------------------------------------------------------------------------

function getFieldValueType(val) {
  const str = (val.constructor && val.constructor.name) || '';
  if (str.includes('Increment') || str === 'NumericIncrementTransform')
    return 'increment';
  if (str.includes('ServerTimestamp')) return 'serverTimestamp';
  if (str.includes('ArrayUnion')) return 'arrayUnion';
  if (str.includes('ArrayRemove')) return 'arrayRemove';
  if (str.includes('Delete') || str === 'DeleteTransform') return 'delete';
  // Fallback: check _methodName if available
  if (val._methodName) {
    if (val._methodName.includes('increment')) return 'increment';
    if (val._methodName.includes('serverTimestamp')) return 'serverTimestamp';
    if (val._methodName.includes('arrayUnion')) return 'arrayUnion';
    if (val._methodName.includes('arrayRemove')) return 'arrayRemove';
    if (val._methodName.includes('delete')) return 'delete';
  }
  return 'unknown';
}

/**
 * Extract the numeric operand from a FieldValue.increment() sentinel.
 */
function getIncrementOperand(val) {
  const op = val._operand !== undefined ? val._operand : val.operand;
  const n = Number(op);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Extract the elements array from FieldValue.arrayUnion() / arrayRemove().
 */
function getArrayElements(val) {
  return val._elements || val.elements || [];
}

// ---------------------------------------------------------------------------
// Timestamp revival — Firestore returns Timestamp objects (.toDate()/.seconds);
// PG returns raw JS Dates (timestamptz columns) and {_seconds,_nanoseconds}
// blobs inside JSONB (from backfilled Firestore Timestamps). App code written
// for Firestore calls .toDate() everywhere, so wrap both shapes on every read.
// ---------------------------------------------------------------------------

let TimestampClass = null;
try {
  TimestampClass = require('firebase-admin/firestore').Timestamp;
} catch (_) { /* firebase-admin not available — use shim */ }

function toTimestamp(date) {
  if (TimestampClass) return TimestampClass.fromDate(date);
  const ms = date.getTime();
  const seconds = Math.floor(ms / 1000);
  const nanoseconds = (ms - seconds * 1000) * 1e6;
  return {
    seconds,
    nanoseconds,
    _seconds: seconds,
    _nanoseconds: nanoseconds,
    toDate: () => new Date(ms),
    toMillis: () => ms,
    isEqual: (o) => !!o && typeof o.toMillis === 'function' && o.toMillis() === ms,
    toJSON: () => ({ _seconds: seconds, _nanoseconds: nanoseconds }),
  };
}

/**
 * Recursively wrap date-like values as Firestore Timestamps (mutates in place
 * for objects/arrays). Converts: JS Date, {_seconds,_nanoseconds}.
 * Leaves plain ISO strings alone — those were strings on Firestore too.
 */
function reviveTimestamps(val, depth = 0) {
  if (val == null || depth > 12) return val;
  if (val instanceof Date) return toTimestamp(val);
  if (typeof val !== 'object') return val;
  if (typeof val.toDate === 'function') return val; // already a Timestamp
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) val[i] = reviveTimestamps(val[i], depth + 1);
    return val;
  }
  if (
    val._seconds !== undefined &&
    val._nanoseconds !== undefined &&
    Object.keys(val).length <= 2
  ) {
    return toTimestamp(new Date(val._seconds * 1000 + val._nanoseconds / 1e6));
  }
  for (const k of Object.keys(val)) val[k] = reviveTimestamps(val[k], depth + 1);
  return val;
}

// ---------------------------------------------------------------------------
// Sentinel resolution for INSERT paths — set()/add() can carry FieldValue
// sentinels and dotted keys; resolve them to concrete values for a fresh row.
// ---------------------------------------------------------------------------

function setNestedValue(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof node[p] !== 'object' || node[p] === null || Array.isArray(node[p])) {
      node[p] = {};
    }
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

function hasSentinelOrDottedKey(data) {
  for (const [key, val] of Object.entries(data)) {
    if (key.includes('.')) return true;
    if (isFieldValueSentinel(val)) return true;
  }
  return false;
}

function resolveSentinelsToValues(data) {
  const out = {};
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    let resolved = val;
    if (isFieldValueSentinel(val)) {
      switch (getFieldValueType(val)) {
        case 'increment':
          resolved = getIncrementOperand(val);
          break;
        case 'serverTimestamp':
          resolved = new Date();
          break;
        case 'arrayUnion':
          resolved = getArrayElements(val);
          break;
        case 'arrayRemove':
          resolved = [];
          break;
        case 'delete':
          continue;
        default:
          console.warn(`[pgAdapter] Dropping unknown sentinel for field "${key}" in set()/add()`);
          continue;
      }
    }
    if (key.includes('.')) setNestedValue(out, key, resolved);
    else out[key] = resolved;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DocumentSnapshot / QuerySnapshot
// ---------------------------------------------------------------------------

function makeDocumentSnapshot(id, data, ref) {
  const exists = data != null;
  return {
    exists,
    id,
    ref,
    data: () => (exists ? data : undefined),
  };
}

function makeQuerySnapshot(docs) {
  return {
    empty: docs.length === 0,
    size: docs.length,
    docs,
    forEach: (fn) => docs.forEach(fn),
  };
}

// ---------------------------------------------------------------------------
// PgDocRef
// ---------------------------------------------------------------------------

class PgDocRef {
  /**
   * @param {string} collectionName - Firestore collection name
   * @param {string} docId - Document ID
   * @param {Object} config - Registry config for this collection
   * @param {Object|null} firestoreDb - Fallback Firestore DB (for subcollections)
   * @param {Object} [clientOverride] - PG client to use (for transactions)
   */
  constructor(collectionName, docId, config, firestoreDb, clientOverride) {
    this._collectionName = collectionName;
    this.id = docId;
    this._config = config;
    this._firestoreDb = firestoreDb;
    this._client = clientOverride || null;
  }

  get path() {
    return `${this._collectionName}/${this.id}`;
  }

  get parent() {
    // Firestore: docRef.parent = collection ref; docRef.parent.parent = parent DOC ref.
    // For scoped subcollection docs (restaurants/X/floors/Y/tables/Z) expose the
    // nearest ancestor doc id so patterns like ref.parent.parent.id work.
    const chain = this._scopeChain;
    return {
      id: this._collectionName,
      parent:
        chain && chain.length
          ? { id: chain[chain.length - 1].value }
          : null,
    };
  }

  /**
   * Execute a query — uses transaction client if available, otherwise pool.
   */
  async _exec(text, values) {
    if (this._client) {
      // On a transaction/batch connection, wrap each WRITE in a SAVEPOINT so a failing
      // statement (e.g. a missing column that the caller retries into extra_data) can be
      // rolled back to the savepoint WITHOUT poisoning the whole transaction (Postgres
      // 25P02 would otherwise abort every other write in the batch). Reads are left alone.
      if (/^\s*SELECT/i.test(text)) {
        return this._client.query(text, values);
      }
      const sp = `pgsp_${++_savepointSeq}`;
      await this._client.query(`SAVEPOINT ${sp}`);
      try {
        const r = await this._client.query(text, values);
        await this._client.query(`RELEASE SAVEPOINT ${sp}`);
        return r;
      } catch (e) {
        try { await this._client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch (_) {}
        throw e;
      }
    }
    return pgQuery(text, values);
  }

  /**
   * GET a single document by ID.
   */
  /**
   * Build the subcollection-scope WHERE conditions for this doc (empty for
   * top-level docs). A scoped doc (e.g. restaurants/{r}/floors/{f}/tables/{t},
   * or offers/{o}/customerOfferUsage/{c}) must resolve by id AND its ancestor
   * scope columns — matching by id alone lets a doc from another parent/tenant
   * leak in when ids collide across scopes. Returns { sql, values }.
   */
  _scopeConditions(startIdx) {
    const chain = this._scopeChain || [];
    if (!chain.length) return { sql: '', values: [] };
    const { fieldMap } = this._config;
    const parts = [];
    const values = [];
    let idx = startIdx;
    for (const s of chain) {
      parts.push(`${resolveField(fieldMap, s.field)} = $${idx++}`);
      values.push(s.value);
    }
    return { sql: ' AND ' + parts.join(' AND '), values };
  }

  // Cache-key suffix so scoped docs with colliding ids don't share a cache slot
  _scopeCacheSuffix() {
    const chain = this._scopeChain || [];
    return chain.length ? '|' + chain.map(s => s.value).join('|') : '';
  }

  async get() {
    try {
      const { table, cacheTTL } = this._config;
      const scope = this._scopeConditions(2);
      const cacheId = this.id + this._scopeCacheSuffix();

      // Redis cache check (only for non-transactional reads on cacheable collections)
      if (cacheTTL && !this._client) {
        try {
          const ver = await getTableVersion(table);
          const cKey = docCacheKey(table, ver, cacheId);
          const cached = await kvGet(cKey);
          if (cached) {
            if (cached === '__null__') {
              return makeDocumentSnapshot(this.id, null, this);
            }
            return makeDocumentSnapshot(this.id, reviveTimestamps(cached), this);
          }
        } catch (_) { /* cache miss — fall through to PG */ }
      }

      // Inside a transaction, lock the row (Firestore transactions are
      // read-modify-write safe; plain READ COMMITTED SELECTs are not)
      const result = await this._exec(
        `SELECT * FROM ${table} WHERE id = $1${scope.sql}${this._client ? ' FOR UPDATE' : ''}`,
        [this.id, ...scope.values]
      );
      if (result.rows.length === 0) {
        // Cache the miss briefly to avoid repeated queries for non-existent docs
        if (cacheTTL && !this._client) {
          const ver = await getTableVersion(table).catch(() => 0);
          kvSet(docCacheKey(table, ver, cacheId), '__null__', Math.min(cacheTTL, 30)).catch(() => {});
        }
        return makeDocumentSnapshot(this.id, null, this);
      }
      const data = reviveTimestamps(this._config.toFirestoreObj(result.rows[0]));

      // Cache the result
      if (cacheTTL && !this._client) {
        const ver = await getTableVersion(table).catch(() => 0);
        kvSet(docCacheKey(table, ver, cacheId), data, cacheTTL).catch(() => {});
      }

      return makeDocumentSnapshot(this.id, data, this);
    } catch (err) {
      console.error(`[pgAdapter] DocRef.get() error (${this.path}):`, err.message);
      throw err;
    }
  }

  /**
   * SET — UPSERT a document.
   *
   * Firestore semantics supported:
   *  - set(data) — replace-style upsert (mapped columns overwritten)
   *  - set(data, { merge: true }) — partial upsert; JSONB object values are
   *    shallow-merged into existing JSONB columns instead of replacing them
   *  - FieldValue sentinels (increment/serverTimestamp/arrayUnion/...) and
   *    dotted keys work in both modes: on an existing row they are applied as
   *    transforms (via update()); on a missing row they are resolved to
   *    initial values and inserted. This is what updateDailyStats() relies on.
   *
   * @param {Object} data
   * @param {Object} [options] - { merge: true } for partial upsert
   */
  async set(data, options) {
    try {
      const { table, jsonbCols } = this._config;
      const merge = !!(
        options &&
        (options.merge || (options.mergeFields && options.mergeFields.length))
      );

      // Inject subcollection scope fields (restaurantId/floorId/...) so docs
      // created via scopedRef.doc(id).set() are visible to scoped queries
      let payload = data;
      if (this._scopeChain && this._scopeChain.length) {
        payload = { ...data };
        for (const scope of this._scopeChain) {
          if (payload[scope.field] === undefined) payload[scope.field] = scope.value;
        }
      }

      if (merge && hasSentinelOrDottedKey(payload)) {
        // Transform-style merge upsert: UPDATE first (sentinel machinery lives
        // there), INSERT a resolved initial row when the doc doesn't exist yet.
        const updated = await this.update(payload, { allowMissing: true });
        if (!updated) {
          const inserted = await this._insertResolved(payload);
          if (!inserted) {
            // Concurrent writer inserted first — apply our transforms on top
            await this.update(payload, { allowMissing: true });
          }
        }
        if (this._config.cacheTTL) await bumpTableVersion(table).catch(() => {}); // awaited so a read-after-write in the same request sees the new version (cloud Redis cache)
        return;
      }

      const rowData = hasSentinelOrDottedKey(payload)
        ? resolveSentinelsToValues(payload)
        : payload;
      const pgRow = this._config.toPgRow({ id: this.id, ...rowData });
      if (!pgRow.id) pgRow.id = this.id;

      const upsert = buildUpsert(table, pgRow, jsonbCols, ['id'], { mergeJsonb: merge });
      try {
        await this._exec(upsert.text, upsert.values);
      } catch (innerErr) {
        const colMatch = innerErr.message.match(/column "([^"]+)" of relation/);
        if (colMatch) {
          const badCol = colMatch[1];
          console.warn(`[pgAdapter] Column "${badCol}" missing on ${table} during set(), moving to extra_data`);
          const overflow = pgRow[badCol];
          delete pgRow[badCol];
          if (overflow !== undefined) {
            pgRow.extra_data = { ...(pgRow.extra_data || {}), [badCol]: overflow };
          }
          const retry = buildUpsert(table, pgRow, jsonbCols, ['id'], { mergeJsonb: merge });
          await this._exec(retry.text, retry.values);
        } else {
          throw innerErr;
        }
      }
      // Invalidate cache
      if (this._config.cacheTTL) await bumpTableVersion(table).catch(() => {}); // awaited so a read-after-write in the same request sees the new version (cloud Redis cache)
    } catch (err) {
      console.error(`[pgAdapter] DocRef.set() error (${this.path}):`, err.message);
      throw err;
    }
  }

  /**
   * create() — Firestore semantics: INSERT the document, but reject with
   * ALREADY_EXISTS (err.code = 6) if a document with this id already exists.
   * Used for atomic key reservation (e.g. order idempotency): concurrent
   * callers race on INSERT and only one wins. Backed by INSERT ... ON CONFLICT
   * (id) DO NOTHING (via _insertResolved), so it is race-safe at the DB level.
   */
  async create(data) {
    try {
      const { table } = this._config;
      let payload = data || {};
      // Inject subcollection scope fields like set() does
      if (this._scopeChain && this._scopeChain.length) {
        payload = { ...payload };
        for (const scope of this._scopeChain) {
          if (payload[scope.field] === undefined) payload[scope.field] = scope.value;
        }
      }
      const inserted = await this._insertResolved(payload);
      if (!inserted) {
        const err = new Error(`ALREADY_EXISTS: document already exists: ${this.path}`);
        err.code = 6; // Firestore ALREADY_EXISTS
        throw err;
      }
      if (this._config.cacheTTL) await bumpTableVersion(table).catch(() => {}); // awaited so a read-after-write in the same request sees the new version (cloud Redis cache)
    } catch (err) {
      if (err.code !== 6) {
        console.error(`[pgAdapter] DocRef.create() error (${this.path}):`, err.message);
      }
      throw err;
    }
  }

  /**
   * INSERT a row with sentinels/dotted keys resolved to concrete values.
   * ON CONFLICT DO NOTHING — returns true if the row was inserted, false if a
   * concurrent writer beat us to it. Retries missing columns into extra_data.
   */
  async _insertResolved(payload) {
    const { table, jsonbCols } = this._config;
    const resolved = resolveSentinelsToValues(payload);
    let pgRow = this._config.toPgRow({ id: this.id, ...resolved });
    if (!pgRow.id) pgRow.id = this.id;

    for (let attempt = 0; attempt < 4; attempt++) {
      const ins = buildInsert(table, pgRow, jsonbCols);
      const text = ins.text.replace(/ RETURNING \*$/, ' ON CONFLICT (id) DO NOTHING');
      try {
        const res = await this._exec(text, ins.values);
        return res.rowCount > 0;
      } catch (innerErr) {
        const colMatch = innerErr.message.match(/column "([^"]+)" of relation/);
        if (!colMatch) throw innerErr;
        const badCol = colMatch[1];
        console.warn(`[pgAdapter] Column "${badCol}" missing on ${table} during insert, moving to extra_data`);
        const overflow = pgRow[badCol];
        delete pgRow[badCol];
        if (overflow !== undefined) {
          pgRow.extra_data = { ...(pgRow.extra_data || {}), [badCol]: overflow };
        }
      }
    }
    throw new Error(`[pgAdapter] Insert retry limit exceeded for ${this.path}`);
  }

  /**
   * UPDATE — partial update with FieldValue sentinel support.
   *
   * Matches Firestore semantics:
   *  - dot-notation paths write into JSONB columns (creating intermediate
   *    objects), with full sentinel support at the leaf
   *  - throws NOT_FOUND (err.code = 5) when the document doesn't exist
   *  - arrayUnion dedupes (Firestore set semantics)
   *  - unknown columns overflow into extra_data via a merging JSONB write
   *
   * @param {Object} data
   * @param {Object} [_opts] - internal: { allowMissing, _retryDepth, _skipAutoUpdatedAt }
   * @returns {boolean} true if a row was updated (false only with allowMissing)
   */
  async update(data, _opts = {}) {
    const { allowMissing = false, _retryDepth = 0, _skipAutoUpdatedAt = false } = _opts;
    try {
      const { table, fieldMap, jsonbCols } = this._config;
      const setClauses = [];
      const values = [];
      const addValue = (v) => {
        values.push(v);
        return values.length;
      };
      // Accumulate all writes targeting the same JSONB column into ONE chained
      // expression, flushed to a single SET clause after the loop. Postgres
      // rejects multiple assignments to the same column in one UPDATE, so
      // writing e.g. two dynamic keys into payment_methods, or overflowing
      // several unmapped fields into extra_data, must combine — not emit N
      // clauses. Keyed by column → current RHS SQL expression.
      const jsonbAccum = {};
      // Track which parent prefixes we've already ensured exist, per column, within THIS
      // statement. A prefix must be created only once — re-creating it for a later sibling
      // rebuilds it from the raw column and discards the earlier sibling's write (the
      // dailyStats sibling-clobber bug). Once ensured, later siblings find the parent in
      // the evolving expression and jsonb_set their leaf without touching it.
      const jsonbEnsured = {};
      const jsonbBase = (col) => (jsonbAccum[col] !== undefined ? jsonbAccum[col] : `COALESCE(${col}, '{}'::jsonb)`);

      for (const [key, val] of Object.entries(data)) {
        if (val === undefined) continue;

        // Resolve the target column + JSONB path. Collections with dynamic
        // key packing (e.g. dailyStats paymentMethod_cash → payment_methods
        // JSONB) expose resolveKeyPath in their registry config; everything
        // else uses dot-notation + fieldMap.
        let pgCol;
        let jsonPath;
        const hook = this._config.resolveKeyPath ? this._config.resolveKeyPath(key) : null;
        if (hook && hook.col) {
          pgCol = hook.col;
          jsonPath = hook.path || [];
        } else {
          const dotParts = key.split('.');
          pgCol = resolveField(fieldMap, dotParts[0]);
          jsonPath = dotParts.slice(1);
        }

        if (jsonPath.length > 0 && jsonbCols.has(pgCol)) {
          // Nested update into a JSONB column. jsonb_set only creates the leaf
          // key, so chain jsonb_set calls to create intermediate objects first.
          // baseExpr chains off any prior write to this same column so multiple
          // path writes collapse into one SET clause (see jsonbAccum above).
          let baseExpr = jsonbBase(pgCol);
          const ensured = jsonbEnsured[pgCol] || (jsonbEnsured[pgCol] = new Set());
          for (let d = 1; d < jsonPath.length; d++) {
            const prefix = jsonPath.slice(0, d);
            const pkey = prefix.join(' ');
            // Only ensure each parent prefix once per statement — otherwise a later sibling
            // resets it from the raw column and wipes the earlier sibling's write.
            if (ensured.has(pkey)) continue;
            ensured.add(pkey);
            const prefixIdx = addValue(prefix);
            baseExpr = `jsonb_set(${baseExpr}, $${prefixIdx}::text[], COALESCE(${pgCol}#>$${prefixIdx}::text[], '{}'::jsonb), true)`;
          }
          const pathIdx = addValue(jsonPath);
          const pathParam = `$${pathIdx}::text[]`;

          if (isFieldValueSentinel(val)) {
            switch (getFieldValueType(val)) {
              case 'increment': {
                const operand = getIncrementOperand(val);
                jsonbAccum[pgCol] =
                  `jsonb_set(${baseExpr}, ${pathParam}, to_jsonb(COALESCE((${pgCol}#>>${pathParam})::numeric, 0) + ${operand}), true)`;
                break;
              }
              case 'serverTimestamp': {
                jsonbAccum[pgCol] =
                  `jsonb_set(${baseExpr}, ${pathParam}, to_jsonb(NOW()), true)`;
                break;
              }
              case 'arrayUnion': {
                const elemsIdx = addValue(JSON.stringify(getArrayElements(val)));
                jsonbAccum[pgCol] =
                  `jsonb_set(${baseExpr}, ${pathParam}, COALESCE(${pgCol}#>${pathParam}, '[]'::jsonb) || (SELECT COALESCE(jsonb_agg(n), '[]'::jsonb) FROM jsonb_array_elements($${elemsIdx}::jsonb) AS n WHERE NOT (COALESCE(${pgCol}#>${pathParam}, '[]'::jsonb) @> jsonb_build_array(n))), true)`;
                break;
              }
              case 'arrayRemove': {
                const remIdx = addValue(JSON.stringify(getArrayElements(val)));
                jsonbAccum[pgCol] =
                  `jsonb_set(${baseExpr}, ${pathParam}, (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(${pgCol}#>${pathParam}, '[]'::jsonb)) AS e WHERE NOT ($${remIdx}::jsonb @> jsonb_build_array(e))), true)`;
                break;
              }
              case 'delete': {
                jsonbAccum[pgCol] = `${baseExpr} #- ${pathParam}`;
                break;
              }
              default: {
                console.warn(`[pgAdapter] Unknown sentinel at "${key}" — skipping`);
                break;
              }
            }
          } else {
            const valIdx = addValue(toJsonbValue(convertTimestamp(val)));
            jsonbAccum[pgCol] =
              `jsonb_set(${baseExpr}, ${pathParam}, $${valIdx}::jsonb, true)`;
          }
          continue;
        }

        if (jsonPath.length > 0 && !isFieldValueSentinel(val)) {
          // Dot-notation on a non-JSONB column — write the leaf value to the
          // top-level column (no structured sub-fields in regular cols)
          const leafIdx = addValue(convertTimestamp(val));
          setClauses.push(`${pgCol} = $${leafIdx}`);
          continue;
        }

        // FieldValue sentinels on top-level columns
        if (isFieldValueSentinel(val)) {
          const fvType = getFieldValueType(val);
          switch (fvType) {
            case 'increment': {
              const operand = getIncrementOperand(val);
              setClauses.push(`${pgCol} = COALESCE(${pgCol}, 0) + ${operand}`);
              break;
            }
            case 'serverTimestamp': {
              setClauses.push(`${pgCol} = NOW()`);
              break;
            }
            case 'arrayUnion': {
              // Firestore arrayUnion has set semantics — only append elements
              // not already present
              const elemsIdx = addValue(JSON.stringify(getArrayElements(val)));
              setClauses.push(
                `${pgCol} = COALESCE(${pgCol}, '[]'::jsonb) || (SELECT COALESCE(jsonb_agg(n), '[]'::jsonb) FROM jsonb_array_elements($${elemsIdx}::jsonb) AS n WHERE NOT (COALESCE(${pgCol}, '[]'::jsonb) @> jsonb_build_array(n)))`
              );
              break;
            }
            case 'arrayRemove': {
              const remIdx = addValue(JSON.stringify(getArrayElements(val)));
              setClauses.push(
                `${pgCol} = (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(${pgCol}, '[]'::jsonb)) AS e WHERE NOT ($${remIdx}::jsonb @> jsonb_build_array(e)))`
              );
              break;
            }
            case 'delete': {
              setClauses.push(`${pgCol} = NULL`);
              break;
            }
            default: {
              console.warn(`[pgAdapter] Unknown FieldValue sentinel type for field "${key}" — skipping`);
              break;
            }
          }
          continue;
        }

        // Regular field
        const cleanVal = convertTimestamp(val);
        if (jsonbCols.has(pgCol)) {
          const jIdx = addValue(toJsonbValue(cleanVal));
          if (pgCol === 'extra_data') {
            // Merge — replacing would wipe every other unmapped field. Chain off
            // any prior write to extra_data so it stays a single SET clause.
            jsonbAccum[pgCol] = `${jsonbBase(pgCol)} || $${jIdx}::jsonb`;
          } else {
            // Full replace of a JSONB column overrides any prior accumulation.
            jsonbAccum[pgCol] = `$${jIdx}::jsonb`;
          }
        } else {
          const rIdx = addValue(cleanVal);
          setClauses.push(`${pgCol} = $${rIdx}`);
        }
      }

      // Flush accumulated JSONB-column expressions — one SET clause per column.
      for (const [col, expr] of Object.entries(jsonbAccum)) {
        setClauses.push(`${col} = ${expr}`);
      }

      if (setClauses.length === 0) return true;

      // Bump updated_at unless already set in this update
      const alreadySetsUpdatedAt = setClauses.some(c => c.startsWith('updated_at'));
      if (!alreadySetsUpdatedAt && !_skipAutoUpdatedAt) {
        setClauses.push('updated_at = NOW()');
      }

      const idIdx = addValue(this.id);
      const scope = this._scopeConditions(idIdx + 1);
      for (const v of scope.values) values.push(v);
      const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${idIdx}${scope.sql}`;
      let result;
      try {
        result = await this._exec(sql, values);
      } catch (innerErr) {
        // If a column doesn't exist, retry with the offending fields routed
        // into extra_data (as JSONB path writes — preserves sentinel semantics).
        // Postgres reports only ONE missing column per error, so each retry
        // moves one field and re-executes. The cap must therefore be >= the max
        // number of distinct unmapped columns a single update() can carry, or
        // the write 500s once it exceeds the cap (this was breaking bill
        // completion, which writes update_history + update_count + offer_ids +
        // last_updated_by = 4 unmapped fields). Each retry only continues while
        // it made progress (moved > 0), so this is bounded, not an infinite loop.
        const colMatch = innerErr.message.match(/column "([^"]+)" of relation/);
        if (colMatch && _retryDepth < 25) {
          const badCol = colMatch[1];
          if (badCol === 'updated_at' && !_skipAutoUpdatedAt) {
            return this.update(data, { ..._opts, _retryDepth: _retryDepth + 1, _skipAutoUpdatedAt: true });
          }
          const filteredData = {};
          let moved = 0;
          for (const [key, val] of Object.entries(data)) {
            if (val === undefined) continue;
            const h = this._config.resolveKeyPath ? this._config.resolveKeyPath(key) : null;
            const col = h && h.col ? h.col : resolveField(fieldMap, key.split('.')[0]);
            if (col === badCol) {
              filteredData[`extra_data.${key}`] = val;
              moved++;
            } else {
              filteredData[key] = val;
            }
          }
          if (moved > 0 && jsonbCols.has('extra_data')) {
            console.warn(`[pgAdapter] Column "${badCol}" missing on ${table}, storing ${moved} field(s) in extra_data`);
            return this.update(filteredData, { ..._opts, _retryDepth: _retryDepth + 1 });
          }
        }
        throw innerErr;
      }

      if (result.rowCount === 0) {
        if (allowMissing) return false;
        // Firestore update() rejects with NOT_FOUND — app code relies on this
        // for update-or-create fallbacks
        const nf = new Error(`NOT_FOUND: no document to update: ${this.path}`);
        nf.code = 5;
        throw nf;
      }

      // Invalidate cache
      if (this._config.cacheTTL) await bumpTableVersion(table).catch(() => {}); // awaited so a read-after-write in the same request sees the new version (cloud Redis cache)
      return true;
    } catch (err) {
      console.error(
        `[pgAdapter] DocRef.update() error (${this.path}):`,
        err.message
      );
      throw err;
    }
  }

  /**
   * DELETE a document.
   */
  async delete() {
    try {
      const { table } = this._config;
      const scope = this._scopeConditions(2);
      await this._exec(`DELETE FROM ${table} WHERE id = $1${scope.sql}`, [this.id, ...scope.values]);
      // Invalidate cache
      if (this._config.cacheTTL) await bumpTableVersion(table).catch(() => {}); // awaited so a read-after-write in the same request sees the new version (cloud Redis cache)
    } catch (err) {
      console.error(
        `[pgAdapter] DocRef.delete() error (${this.path}):`,
        err.message
      );
      throw err;
    }
  }

  /**
   * Subcollection access — routes known subcollections to PG tables,
   * falls back to Firestore for unknown ones.
   *
   * Known patterns:
   *   restaurants/{id}/floors  → PG "floors" table, scoped by restaurant_id
   *   restaurants/{id}/floors/{floorId}/tables → PG "tables" table, scoped by floor_id
   */
  collection(subName) {
    // Try to find a PG mapping for this subcollection
    const registry = require('./collectionRegistry');
    const config = registry[subName];
    if (config) {
      // Pass down any ancestor scopes from the scope chain
      const ancestorScopes = this._scopeChain || [];
      const scopedRef = new PgScopedCollectionRef(
        config, subName, this._firestoreDb,
        this._collectionName, this.id,
        ancestorScopes
      );
      return scopedRef;
    }

    if (this._firestoreDb) {
      return this._firestoreDb
        .collection(this._collectionName)
        .doc(this.id)
        .collection(subName);
    }
    throw new Error(
      `[pgAdapter] Subcollection "${subName}" on ${this.path} has no Firestore fallback`
    );
  }
}

// ---------------------------------------------------------------------------
// PgQuery — chainable query builder
// ---------------------------------------------------------------------------

class PgQuery {
  /**
   * @param {Object} config - Registry config
   * @param {string} collectionName
   * @param {Object|null} firestoreDb
   */
  constructor(config, collectionName, firestoreDb) {
    this._config = config;
    this._collectionName = collectionName;
    this._firestoreDb = firestoreDb;
    this._wheres = [];
    this._orderBys = [];
    this._limitVal = null;
    this._startAfterSnap = null;
    this._startAfterValues = null;
    this._client = null; // set when running inside a PG transaction
  }

  /**
   * Return a new PgQuery with copied state so chaining does not mutate.
   */
  _clone() {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    q._wheres = [...this._wheres];
    q._orderBys = [...this._orderBys];
    q._limitVal = this._limitVal;
    q._offsetVal = this._offsetVal;
    q._startAfterSnap = this._startAfterSnap;
    q._startAfterValues = this._startAfterValues;
    q._client = this._client;
    return q;
  }

  where(field, op, value) {
    const q = this._clone();
    q._wheres.push({ field, op, value });
    return q;
  }

  orderBy(field, direction) {
    const q = this._clone();
    q._orderBys.push({ field, direction: direction || 'asc' });
    return q;
  }

  limit(n) {
    const q = this._clone();
    q._limitVal = n;
    return q;
  }

  /**
   * startAfter — accepts a DocumentSnapshot (Firestore style) OR raw field
   * values matching the orderBy clauses (also Firestore style).
   */
  startAfter(...args) {
    const q = this._clone();
    if (args.length === 1 && args[0] && typeof args[0].data === 'function') {
      q._startAfterSnap = args[0];
      q._startAfterValues = null;
    } else if (args.length > 0 && args[0] !== undefined) {
      q._startAfterSnap = null;
      q._startAfterValues = args;
    }
    return q;
  }

  offset(n) {
    const q = this._clone();
    q._offsetVal = n;
    return q;
  }

  /**
   * Build WHERE conditions for this query's filters. Pushes parameters onto
   * `values` and returns { conditions, emptyResult }. Shared by get()/count().
   */
  _buildConditions(values, knownCols, textCols) {
    const { fieldMap, jsonbCols } = this._config;
    const conditions = [];
    // Range comparisons on TEXT keys must use byte order (COLLATE "C") to match Firestore's
    // string sort. Without it, the DB's locale collation mis-scopes prefix ranges (the
    // Firestore `` idiom) — e.g. it can silently under-count and produce duplicate
    // booking numbers. Equality (`=`/`!=`) is byte-exact under either collation, so only the
    // relational operators need it. Mirrors the COLLATE "C" already applied in ORDER BY.
    const RANGE_OPS = new Set(['<', '<=', '>', '>=']);
    const collateText = (expr, op) => (RANGE_OPS.has(op) ? `${expr} COLLATE "C"` : expr);

    for (const w of this._wheres) {
      const mappedOp = OP_MAP[w.op];
      if (!mappedOp) {
        throw new Error(`[pgAdapter] Unsupported operator: "${w.op}"`);
      }
      const dotParts = typeof w.field === 'string' ? w.field.split('.') : [w.field];
      const topField = dotParts[0];
      const pgCol = resolveField(fieldMap, topField);
      const cleanValue = convertTimestamp(w.value);
      const addValue = (v) => {
        values.push(v);
        return values.length;
      };

      // Dot-notation into a JSONB column (e.g. 'staffInfo.userId')
      if (dotParts.length > 1 && jsonbCols && jsonbCols.has(pgCol)) {
        const pathIdx = addValue(dotParts.slice(1));
        const pathParam = `$${pathIdx}::text[]`;
        const textExpr = `${pgCol}#>>${pathParam}`;

        if (w.op === 'array-contains') {
          const vIdx = addValue(JSON.stringify([cleanValue]));
          conditions.push(`COALESCE(${pgCol}#>${pathParam}, '[]'::jsonb) @> $${vIdx}::jsonb`);
        } else if (cleanValue === null && (w.op === '==' || w.op === '!=')) {
          // Firestore `== null` matches only an EXPLICIT null (key present, value
          // null) — NOT a missing key. jsonb_typeof distinguishes the two so PG
          // matches Firestore exactly. (`!= null` = key present & not-null already.)
          conditions.push(
            w.op === '=='
              ? `jsonb_typeof(${pgCol}#>${pathParam}) = 'null'`
              : `${textExpr} IS NOT NULL`
          );
        } else if (w.op === 'in') {
          if (!Array.isArray(cleanValue) || cleanValue.length === 0) {
            return { conditions, emptyResult: true };
          }
          const vIdx = addValue(cleanValue.map((v) => (typeof v === 'string' ? v : String(v))));
          conditions.push(`${textExpr} = ANY($${vIdx})`);
        } else if (w.op === 'not-in') {
          if (!Array.isArray(cleanValue) || cleanValue.length === 0) continue;
          const vIdx = addValue(cleanValue.map((v) => (typeof v === 'string' ? v : String(v))));
          conditions.push(`${textExpr} != ALL($${vIdx})`);
        } else if (typeof cleanValue === 'number') {
          // ->> returns text — cast so numeric comparisons aren't lexicographic
          const vIdx = addValue(cleanValue);
          conditions.push(`(CASE WHEN (${textExpr}) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${textExpr})::numeric END) ${mappedOp} $${vIdx}`);
        } else if (cleanValue instanceof Date) {
          const vIdx = addValue(cleanValue);
          conditions.push(`(CASE WHEN (${textExpr}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (${textExpr})::timestamptz END) ${mappedOp} $${vIdx}`);
        } else if (typeof cleanValue === 'boolean') {
          const vIdx = addValue(String(cleanValue));
          conditions.push(`${textExpr} ${mappedOp} $${vIdx}`);
        } else {
          const vIdx = addValue(cleanValue);
          conditions.push(`${collateText(textExpr, w.op)} ${mappedOp} $${vIdx}`);
        }
        continue;
      }

      // Unmapped field whose column does NOT physically exist → query the JSONB
      // overflow instead of throwing "column does not exist". Writes store such
      // fields as extra_data.<originalKey>, so use the ORIGINAL field name as key.
      if (
        dotParts.length === 1 &&
        knownCols &&
        !knownCols.has(pgCol.toLowerCase()) &&
        jsonbCols && jsonbCols.has('extra_data')
      ) {
        const keyIdx = addValue(topField);
        const jsonExpr = `extra_data -> $${keyIdx}`;
        const textExpr = `extra_data ->> $${keyIdx}`;
        if (w.op === 'array-contains') {
          const vIdx = addValue(JSON.stringify([cleanValue]));
          conditions.push(`COALESCE(${jsonExpr}, '[]'::jsonb) @> $${vIdx}::jsonb`);
        } else if (cleanValue === null && (w.op === '==' || w.op === '!=')) {
          // Match Firestore: `== null` = explicit null only (key present, null value)
          conditions.push(
            w.op === '=='
              ? `jsonb_typeof(${jsonExpr}) = 'null'`
              : `${textExpr} IS NOT NULL`
          );
        } else if (w.op === 'in') {
          if (!Array.isArray(cleanValue) || cleanValue.length === 0) {
            return { conditions, emptyResult: true };
          }
          const vIdx = addValue(cleanValue.map((v) => (typeof v === 'string' ? v : String(v))));
          conditions.push(`${textExpr} = ANY($${vIdx})`);
        } else if (w.op === 'not-in') {
          if (!Array.isArray(cleanValue) || cleanValue.length === 0) continue;
          const vIdx = addValue(cleanValue.map((v) => (typeof v === 'string' ? v : String(v))));
          conditions.push(`${textExpr} != ALL($${vIdx})`);
        } else if (typeof cleanValue === 'number') {
          const vIdx = addValue(cleanValue);
          conditions.push(`(CASE WHEN (${textExpr}) ~ '^-?[0-9]+([.][0-9]+)?$' THEN (${textExpr})::numeric END) ${mappedOp} $${vIdx}`);
        } else if (cleanValue instanceof Date) {
          const vIdx = addValue(cleanValue);
          conditions.push(`(CASE WHEN (${textExpr}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (${textExpr})::timestamptz END) ${mappedOp} $${vIdx}`);
        } else if (typeof cleanValue === 'boolean') {
          const vIdx = addValue(String(cleanValue));
          conditions.push(`${textExpr} ${mappedOp} $${vIdx}`);
        } else {
          const vIdx = addValue(cleanValue);
          conditions.push(`${collateText(textExpr, w.op)} ${mappedOp} $${vIdx}`);
        }
        continue;
      }

      // NULL equality — SQL 'col != NULL' matches nothing; Firestore semantics
      // are IS NULL / IS NOT NULL
      if (cleanValue === null && (w.op === '==' || w.op === '!=')) {
        conditions.push(w.op === '==' ? `${pgCol} IS NULL` : `${pgCol} IS NOT NULL`);
        continue;
      }

      if (w.op === 'in') {
        if (!Array.isArray(cleanValue) || cleanValue.length === 0) {
          return { conditions, emptyResult: true };
        }
        const vIdx = addValue(cleanValue);
        conditions.push(`${pgCol} = ANY($${vIdx})`);
      } else if (w.op === 'not-in') {
        if (!Array.isArray(cleanValue) || cleanValue.length === 0) continue;
        const vIdx = addValue(cleanValue);
        conditions.push(`${pgCol} != ALL($${vIdx})`);
      } else if (w.op === 'array-contains') {
        const vIdx = addValue(JSON.stringify([cleanValue]));
        conditions.push(`COALESCE(${pgCol}, '[]'::jsonb) @> $${vIdx}::jsonb`);
      } else {
        const vIdx = addValue(cleanValue);
        const isTextCol = textCols && textCols.has(pgCol.toLowerCase());
        const lhs = isTextCol ? collateText(pgCol, w.op) : pgCol;
        conditions.push(`${lhs} ${mappedOp} $${vIdx}`);
      }
    }

    return { conditions, emptyResult: false };
  }

  /**
   * count() — Returns a query whose get() returns { data() { return { count } } }
   * Errors propagate (Firestore throws too) — a silent 0 hides real failures.
   */
  count() {
    const self = this;
    return {
      async get() {
        try {
          const { table } = self._config;
          const values = [];
          const knownCols = await getTableColumns(table);
          const { conditions, emptyResult } = self._buildConditions(values, knownCols, getTextColumns(table));
          if (emptyResult) return { data: () => ({ count: 0 }) };

          let sql = `SELECT COUNT(*) AS cnt FROM ${table}`;
          if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
          }

          const exec = self._client ? self._client.query.bind(self._client) : pgQuery;
          const result = await exec(sql, values);
          const cnt = parseInt(result.rows[0].cnt, 10);
          return { data: () => ({ count: cnt }) };
        } catch (err) {
          console.error(`[pgAdapter] count() error (${self._collectionName}):`, err.message);
          throw err;
        }
      }
    };
  }

  /**
   * select() — Firestore field projection. In PG we always SELECT * since
   * toFirestoreObj needs all columns. This is a no-op for API compatibility.
   */
  select(..._fields) {
    return this._clone();
  }

  /**
   * Build and execute the SELECT query.
   */
  async get() {
    try {
      const { table, fieldMap, toFirestoreObj, cacheTTL } = this._config;
      const usingCursor = !!(this._startAfterSnap || this._startAfterValues);

      // Redis query cache check — only for cacheable, non-transactional,
      // non-cursor reads
      let qCacheKey = null;
      if (cacheTTL && !usingCursor && !this._client) {
        try {
          const ver = await getTableVersion(table);
          const queryDesc = {
            w: this._wheres.map(w => ({ f: typeof w.field === 'string' ? w.field : String(w.field), o: w.op, v: w.value instanceof Date ? w.value.toISOString() : w.value })),
            ob: this._orderBys,
            l: this._limitVal,
            off: this._offsetVal,
          };
          qCacheKey = queryCacheKey(table, ver, queryDesc);
          const cached = await kvGet(qCacheKey);
          if (cached && Array.isArray(cached)) {
            // Reconstruct DocumentSnapshots from cached data
            const docs = cached.map(item => {
              const ref = new PgDocRef(this._collectionName, item.id, this._config, this._firestoreDb);
              return makeDocumentSnapshot(item.id, reviveTimestamps(item.data), ref);
            });
            return makeQuerySnapshot(docs);
          }
        } catch (_) { /* cache miss — fall through to PG */ }
      }

      const values = [];
      const knownCols = await getTableColumns(table);
      const { conditions, emptyResult } = this._buildConditions(values, knownCols, getTextColumns(table));
      if (emptyResult) return makeQuerySnapshot([]);

      // ORDER BY — Firestore excludes documents that lack the orderBy field,
      // so filter NULLs (also fixes NULLS-first-on-DESC surprises).
      // Symmetric with WHERE: if the orderBy field isn't a real column it lives in the
      // extra_data JSONB overflow (stored under its ORIGINAL key) — order on that instead
      // of emitting `ORDER BY <col>` for a column that doesn't exist (which 500s).
      const orderJsonbCols = this._config.jsonbCols;
      // Firestore implicitly orders by an inequality/range field (ASC) when the query has
      // such a filter and no explicit orderBy — without this, `where(x,'>',n).limit(k)`
      // returns an arbitrary heap-order slice instead of the k smallest. Scope this to the
      // exact case (no explicit orderBy, no cursor) so cursor/multi-orderBy paths are untouched.
      let orderBys = this._orderBys;
      if (orderBys.length === 0 && !usingCursor) {
        const INEQ = new Set(['<', '<=', '>', '>=', '!=']);
        const ineq = this._wheres.find(w => INEQ.has(w.op) && typeof w.field === 'string');
        if (ineq) orderBys = [{ field: ineq.field, direction: 'asc' }];
      }
      const textCols = getTextColumns(table);
      const orderParts = [];
      for (const o of orderBys) {
        const pgCol = resolveField(fieldMap, o.field);
        const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
        let colExpr = pgCol;
        // Firestore sorts strings by UTF-8 byte order; Postgres default is the DB locale
        // (en_US here), which reorders case/accents. Add COLLATE "C" to TEXT sort keys so
        // string ordering (and which docs fall under a limit) matches Firestore.
        let isTextExpr = !!(textCols && textCols.has(pgCol.toLowerCase()));
        const simpleField = typeof o.field === 'string' && !o.field.includes('.');
        if (simpleField && knownCols && !knownCols.has(pgCol.toLowerCase()) && orderJsonbCols && orderJsonbCols.has('extra_data')) {
          values.push(o.field);
          const je = `(extra_data ->> $${values.length})`;
          // A field that overflowed to extra_data (JSONB ->> is TEXT) must still sort like
          // Firestore: numeric values numerically (not "10" < "2"), everything else by UTF-8
          // bytes. Sort by a numeric cast first (NULL for non-numeric → NULLS LAST), then by the
          // COLLATE "C" text key. Fixes lexicographic ordering of numeric extra_data fields.
          orderParts.push(`(CASE WHEN ${je} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${je}::numeric END) ${dir} NULLS LAST`);
          orderParts.push(`${je} COLLATE "C" ${dir}`);
          conditions.push(`${je} IS NOT NULL`);
          continue;
        }
        const collate = isTextExpr ? ' COLLATE "C"' : '';
        orderParts.push(`${colExpr}${collate} ${dir}`);
        conditions.push(`${colExpr} IS NOT NULL`);
      }

      // startAfter — cursor pagination
      if (this._orderBys.length > 0 && usingCursor) {
        let cursorVals = null;
        let cursorId = null;

        if (this._startAfterSnap) {
          const snapData = this._startAfterSnap.data
            ? this._startAfterSnap.data()
            : null;
          if (snapData) {
            cursorVals = this._orderBys.map((o) => {
              let v = snapData[o.field];
              if (v === undefined && typeof o.field === 'string' && o.field.includes('.')) {
                v = o.field.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), snapData);
              }
              if (v === undefined) v = snapData[camelToSnake(String(o.field))];
              return convertTimestamp(v);
            });
            cursorId = this._startAfterSnap.id || null;
          }
        } else if (this._startAfterValues) {
          cursorVals = this._startAfterValues
            .slice(0, this._orderBys.length)
            .map(convertTimestamp);
        }

        // A cursor whose orderBy field overflowed to extra_data (not a physical column) would
        // build a tuple comparison on a non-existent column and 500. ORDER BY has an extra_data
        // fallback; the cursor tuple does not. No live query paginates by an overflow field, so
        // degrade safely — skip the cursor bound (paginate from the start) rather than crash.
        const cursorColsReal = !cursorVals || !knownCols
          || this._orderBys.every((o) => knownCols.has(resolveField(fieldMap, o.field).toLowerCase()));
        if (cursorVals && cursorVals.length > 0 && !cursorColsReal) {
          console.warn('[pgAdapter] cursor on a non-column (extra_data) orderBy field — skipping cursor bound to avoid an invalid-column error');
        } else if (cursorVals && cursorVals.length > 0) {
          const dirs = this._orderBys.map((o) => (o.direction === 'desc' ? 'desc' : 'asc'));
          const uniform = dirs.every((d) => d === dirs[0]);
          const allPresent = cursorVals.every((v) => v !== undefined && v !== null);

          if (uniform && allPresent) {
            // Row-value comparison with doc-id tiebreak — Firestore appends
            // __name__ implicitly, preventing skips/dupes on equal sort keys
            const cols = this._orderBys.map((o) => resolveField(fieldMap, o.field));
            const placeholders = cursorVals.map((v) => {
              values.push(v);
              return `$${values.length}`;
            });
            if (cursorId) {
              cols.push('id');
              values.push(cursorId);
              placeholders.push(`$${values.length}`);
            }
            const cmp = dirs[0] === 'desc' ? '<' : '>';
            conditions.push(`(${cols.join(', ')}) ${cmp} (${placeholders.join(', ')})`);
          } else {
            // Mixed directions or missing cursor values — per-field fallback
            for (let i = 0; i < this._orderBys.length; i++) {
              const v = cursorVals[i];
              if (v === undefined || v === null) continue;
              const col = resolveField(fieldMap, this._orderBys[i].field);
              const cmpOp = dirs[i] === 'desc' ? '<' : '>';
              values.push(v);
              conditions.push(`${col} ${cmpOp} $${values.length}`);
            }
          }
        }
      }

      // Build query
      let sql = `SELECT * FROM ${table}`;
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }
      if (orderParts.length > 0) {
        // Doc-id tiebreak mirrors Firestore's implicit __name__ ordering.
        // COLLATE "C" sorts by UTF-8 byte order to match Firestore's __name__
        // (code-point) ordering — the DB's locale collation would tie-break
        // same-sort-key rows in a different order than Firestore.
        const lastDir =
          orderBys[orderBys.length - 1].direction === 'desc' ? 'DESC' : 'ASC';
        sql += ' ORDER BY ' + orderParts.join(', ') + `, id COLLATE "C" ${lastDir}`;
      }

      // LIMIT
      if (this._limitVal != null) {
        sql += ` LIMIT ${parseInt(this._limitVal, 10)}`;
      }

      // OFFSET
      if (this._offsetVal != null) {
        sql += ` OFFSET ${parseInt(this._offsetVal, 10)}`;
      }

      const exec = this._client ? this._client.query.bind(this._client) : pgQuery;
      const result = await exec(sql, values);

      const docs = result.rows.map((row) => {
        const data = reviveTimestamps(toFirestoreObj(row));
        const id = row.id;
        const ref = new PgDocRef(
          this._collectionName,
          id,
          this._config,
          this._firestoreDb
        );
        return makeDocumentSnapshot(id, data, ref);
      });

      // Cache query results (only for cacheable collections, max 500 results to avoid huge cache entries)
      if (qCacheKey && docs.length <= 500) {
        const cachePayload = docs.map(d => ({ id: d.id, data: d.data() }));
        kvSet(qCacheKey, cachePayload, cacheTTL).catch(() => {});
      }

      return makeQuerySnapshot(docs);
    } catch (err) {
      console.error(
        `[pgAdapter] PgQuery.get() error (${this._collectionName}):`,
        err.message
      );
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// PgCollectionRef
// ---------------------------------------------------------------------------

class PgCollectionRef {
  /**
   * @param {Object} config - Registry config for this collection
   * @param {string} collectionName
   * @param {Object|null} firestoreDb - Fallback Firestore DB
   */
  constructor(config, collectionName, firestoreDb) {
    this._config = config;
    this._collectionName = collectionName;
    this._firestoreDb = firestoreDb;
  }

  doc(id) {
    // Firestore collection.doc() with no args mints a random ID
    return new PgDocRef(
      this._collectionName,
      id || generateId(),
      this._config,
      this._firestoreDb
    );
  }

  where(field, op, value) {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.where(field, op, value);
  }

  orderBy(field, direction) {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.orderBy(field, direction);
  }

  limit(n) {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.limit(n);
  }

  startAfter(...args) {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.startAfter(...args);
  }

  select(...fields) {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.select(...fields);
  }

  offset(n) {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.offset(n);
  }

  count() {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.count();
  }

  /**
   * GET all documents in the collection (no filters).
   */
  async get() {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.get();
  }

  /**
   * ADD — insert a new document with an auto-generated ID.
   * Resolves FieldValue sentinels (serverTimestamp etc.) to concrete values
   * and retries missing columns into extra_data.
   * @param {Object} data
   * @returns {PgDocRef} document reference (has .id, .get(), .update(), ...)
   */
  async add(data) {
    try {
      const { table, jsonbCols } = this._config;
      const id = generateId();
      const rowData = hasSentinelOrDottedKey(data)
        ? resolveSentinelsToValues(data)
        : data;
      let pgRow = this._config.toPgRow({ id, ...rowData });
      if (!pgRow.id) pgRow.id = id;

      for (let attempt = 0; attempt < 4; attempt++) {
        const { text, values } = buildInsert(table, pgRow, jsonbCols);
        try {
          await pgQuery(text, values);
          break;
        } catch (innerErr) {
          const colMatch = innerErr.message.match(/column "([^"]+)" of relation/);
          if (!colMatch || attempt === 3) throw innerErr;
          const badCol = colMatch[1];
          console.warn(`[pgAdapter] Column "${badCol}" missing on ${table} during add(), moving to extra_data`);
          const overflow = pgRow[badCol];
          delete pgRow[badCol];
          if (overflow !== undefined) {
            pgRow.extra_data = { ...(pgRow.extra_data || {}), [badCol]: overflow };
          }
        }
      }
      // Invalidate cache
      if (this._config.cacheTTL) await bumpTableVersion(table).catch(() => {}); // awaited so a read-after-write in the same request sees the new version (cloud Redis cache)
      return new PgDocRef(this._collectionName, id, this._config, this._firestoreDb);
    } catch (err) {
      console.error(
        `[pgAdapter] CollectionRef.add() error (${this._collectionName}):`,
        err.message
      );
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// PgScopedCollectionRef — Subcollection that auto-scopes by parent doc ID
// e.g. restaurants/{id}/floors → floors WHERE restaurant_id = {id}
// ---------------------------------------------------------------------------

class PgScopedCollectionRef extends PgCollectionRef {
  /**
   * @param {Object} config - Registry config for this collection
   * @param {string} collectionName - e.g. 'floors'
   * @param {Object|null} firestoreDb
   * @param {string} parentCollectionName - e.g. 'restaurants'
   * @param {string} parentDocId - e.g. 'abc123'
   */
  /**
   * @param {Object} config
   * @param {string} collectionName
   * @param {Object|null} firestoreDb
   * @param {string} parentCollectionName
   * @param {string} parentDocId
   * @param {Array} [ancestorScopes] - inherited scopes from grandparent, e.g. [{field:'restaurantId', value:'abc'}]
   */
  constructor(config, collectionName, firestoreDb, parentCollectionName, parentDocId, ancestorScopes) {
    super(config, collectionName, firestoreDb);
    this._parentCollectionName = parentCollectionName;
    this._parentDocId = parentDocId;
    // Derive Firestore-style scope field: 'restaurants' → 'restaurantId', 'floors' → 'floorId'
    const singular = parentCollectionName.replace(/s$/, '');
    this._scopeField = singular + 'Id'; // Firestore camelCase field name
    // Ancestor scopes for multi-level subcollections (e.g. restaurants/X/floors/Y/tables)
    this._ancestorScopes = ancestorScopes || [];
  }

  /**
   * Base query with all scope filters applied. EVERY query entry point must
   * come through here, otherwise a chained call (count/offset/select/...)
   * would silently query across ALL parents (cross-tenant leak).
   */
  _scopedQuery() {
    const q = new PgQuery(this._config, this._collectionName, this._firestoreDb);
    for (const scope of this._ancestorScopes) {
      q._wheres.push({ field: scope.field, op: '==', value: scope.value });
    }
    q._wheres.push({ field: this._scopeField, op: '==', value: this._parentDocId });
    return q;
  }

  where(field, op, value) {
    return this._scopedQuery().where(field, op, value);
  }

  orderBy(field, direction) {
    return this._scopedQuery().orderBy(field, direction);
  }

  limit(n) {
    return this._scopedQuery().limit(n);
  }

  offset(n) {
    return this._scopedQuery().offset(n);
  }

  select(...fields) {
    return this._scopedQuery().select(...fields);
  }

  startAfter(...args) {
    return this._scopedQuery().startAfter(...args);
  }

  count() {
    return this._scopedQuery().count();
  }

  async get() {
    return this._scopedQuery().get();
  }

  doc(id) {
    // Return a PgDocRef that carries our full scope chain for child subcollections
    const ref = new PgDocRef(
      this._collectionName,
      id || generateId(),
      this._config,
      this._firestoreDb
    );
    // Attach scope chain so PgDocRef.collection() can pass it down
    ref._scopeChain = [
      ...this._ancestorScopes,
      { field: this._scopeField, value: this._parentDocId }
    ];
    return ref;
  }

  async add(data) {
    if (!data[this._scopeField]) {
      data[this._scopeField] = this._parentDocId;
    }
    // Also inject ancestor scope fields
    for (const scope of this._ancestorScopes) {
      if (!data[scope.field]) {
        data[scope.field] = scope.value;
      }
    }
    return super.add(data);
  }
}

// ---------------------------------------------------------------------------
// PgBatch — Firestore-compatible batch writes backed by a PG transaction
// ---------------------------------------------------------------------------

class PgBatch {
  /**
   * @param {Object} registry - Collection registry
   * @param {Object|null} firestoreDb - Fallback Firestore DB
   */
  constructor(registry, firestoreDb) {
    this._ops = [];
    this._registry = registry;
    this._firestoreDb = firestoreDb;
  }

  set(docRef, data, options) {
    this._ops.push({ type: 'set', ref: docRef, data, options });
  }

  update(docRef, data) {
    this._ops.push({ type: 'update', ref: docRef, data });
  }

  delete(docRef) {
    this._ops.push({ type: 'delete', ref: docRef });
  }

  async commit() {
    if (this._ops.length === 0) return;

    const client = await getClient();
    let poisoned = null;
    try {
      await client.query('BEGIN');

      for (const op of this._ops) {
        if (op.ref instanceof PgDocRef) {
          // PG-backed doc ref — create a transaction-aware copy
          const txRef = new PgDocRef(
            op.ref._collectionName,
            op.ref.id,
            op.ref._config,
            op.ref._firestoreDb,
            client
          );
          // Preserve subcollection scope so scoped creates keep their FK columns
          if (op.ref._scopeChain) txRef._scopeChain = op.ref._scopeChain;
          switch (op.type) {
            case 'set':
              await txRef.set(op.data, op.options);
              break;
            case 'update':
              await txRef.update(op.data);
              break;
            case 'delete':
              await txRef.delete();
              break;
          }
        } else {
          // Firestore doc ref — cannot participate in PG transaction,
          // execute outside (best-effort)
          console.warn(
            `[pgAdapter] Batch: Firestore ref "${op.ref.path}" cannot be in PG transaction`
          );
          switch (op.type) {
            case 'set':
              await op.ref.set(op.data, op.options);
              break;
            case 'update':
              await op.ref.update(op.data);
              break;
            case 'delete':
              await op.ref.delete();
              break;
          }
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rbErr) {
        // Connection is unusable — make sure the pool destroys it
        poisoned = rbErr;
      }
      console.error('[pgAdapter] Batch.commit() error:', err.message);
      throw err;
    } finally {
      client.release(poisoned || undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// PgTransaction — Firestore-compatible transaction
// ---------------------------------------------------------------------------

class PgTransaction {
  /**
   * @param {Object} client - PG client (from pool.connect())
   * @param {Object} registry - Collection registry
   * @param {Object|null} firestoreDb
   */
  constructor(client, registry, firestoreDb) {
    this._client = client;
    this._registry = registry;
    this._firestoreDb = firestoreDb;
    // Firestore's transaction.set/update/delete are SYNCHRONOUS (writes are buffered and
    // applied atomically at commit), so app code legitimately does NOT await them. Our
    // versions execute immediately and async. If we don't track them, runTransaction()
    // can COMMIT before an un-awaited write's SAVEPOINT/RELEASE finishes, which then hits
    // "RELEASE SAVEPOINT ... no active transaction" (25P01) and crashes. We collect every
    // write promise here and runTransaction() drains them before COMMIT.
    this._pending = [];
  }

  /** Await all writes issued in this transaction (even un-awaited ones) before commit. */
  async _drain() {
    if (this._pending.length) {
      const p = this._pending;
      this._pending = [];
      await Promise.all(p);
    }
  }

  /**
   * GET a document or query within the transaction.
   * Doc reads take a row lock (SELECT ... FOR UPDATE); queries run on the
   * transaction's connection so they see uncommitted writes.
   * @param {PgDocRef|PgQuery} docRefOrQuery
   */
  async get(docRefOrQuery) {
    if (docRefOrQuery instanceof PgDocRef) {
      const txRef = new PgDocRef(
        docRefOrQuery._collectionName,
        docRefOrQuery.id,
        docRefOrQuery._config,
        docRefOrQuery._firestoreDb,
        this._client
      );
      if (docRefOrQuery._scopeChain) txRef._scopeChain = docRefOrQuery._scopeChain;
      return txRef.get();
    }
    if (docRefOrQuery instanceof PgQuery) {
      const q = docRefOrQuery._clone();
      q._client = this._client;
      return q.get();
    }
    // Firestore ref — read outside transaction
    return docRefOrQuery.get();
  }

  /**
   * SET within the transaction.
   */
  set(docRef, data, options) {
    if (docRef instanceof PgDocRef) {
      const txRef = new PgDocRef(
        docRef._collectionName,
        docRef.id,
        docRef._config,
        docRef._firestoreDb,
        this._client
      );
      if (docRef._scopeChain) txRef._scopeChain = docRef._scopeChain;
      const p = txRef.set(data, options);
      this._pending.push(p);
      return p;
    }
    return docRef.set(data, options);
  }

  /**
   * UPDATE within the transaction.
   */
  update(docRef, data) {
    if (docRef instanceof PgDocRef) {
      const txRef = new PgDocRef(
        docRef._collectionName,
        docRef.id,
        docRef._config,
        docRef._firestoreDb,
        this._client
      );
      if (docRef._scopeChain) txRef._scopeChain = docRef._scopeChain;
      const p = txRef.update(data);
      this._pending.push(p);
      return p;
    }
    return docRef.update(data);
  }

  /**
   * DELETE within the transaction.
   */
  delete(docRef) {
    if (docRef instanceof PgDocRef) {
      const txRef = new PgDocRef(
        docRef._collectionName,
        docRef.id,
        docRef._config,
        docRef._firestoreDb,
        this._client
      );
      if (docRef._scopeChain) txRef._scopeChain = docRef._scopeChain;
      const p = txRef.delete();
      this._pending.push(p);
      return p;
    }
    return docRef.delete();
  }
}

// ---------------------------------------------------------------------------
// createPgDb — main entry point
// ---------------------------------------------------------------------------

/**
 * Create a Firestore-compatible database object backed by PostgreSQL.
 *
 * @param {Object} registry - Map of collection names to config objects:
 *   {
 *     'orders': {
 *       table: 'orders',
 *       fieldMap: { restaurantId: 'restaurant_id', ... },
 *       toPgRow: Function,
 *       toFirestoreObj: Function,
 *       jsonbCols: Set
 *     },
 *     ...
 *   }
 * @param {Object|null} firestoreDb - Real Firestore DB for unmapped collections
 * @returns {Object} Firestore-compatible DB object
 */
function createPgDb(registry, firestoreDb) {
  const db = {
    _registry: registry,
    _firestoreDb: firestoreDb,

    /**
     * Get a collection reference.
     * Returns PgCollectionRef for mapped collections, falls back to Firestore.
     */
    collection(name) {
      if (!registry[name]) {
        if (firestoreDb) {
          console.warn(
            `[pgAdapter] No PG mapping for collection "${name}", falling back to Firestore`
          );
          return firestoreDb.collection(name);
        }
        throw new Error(
          `[pgAdapter] No PG mapping for collection "${name}" and no Firestore fallback`
        );
      }
      return new PgCollectionRef(registry[name], name, firestoreDb);
    },

    /**
     * Create a batch writer.
     */
    batch() {
      return new PgBatch(registry, firestoreDb);
    },

    /**
     * Run a transaction.
     * @param {Function} updateFn - async (transaction) => result
     */
    /**
     * Query a collection across all parents (Firestore collectionGroup).
     * PG subcollections are flattened into single tables, so an unscoped
     * query over the mapped table IS the collection-group query.
     */
    collectionGroup(name) {
      if (registry[name]) {
        return new PgQuery(registry[name], name, firestoreDb);
      }
      if (firestoreDb) {
        console.warn(
          `[pgAdapter] No PG mapping for collectionGroup "${name}", falling back to Firestore`
        );
        return firestoreDb.collectionGroup(name);
      }
      throw new Error(
        `[pgAdapter] No PG mapping for collectionGroup "${name}" and no Firestore fallback`
      );
    },

    /**
     * Batch-fetch multiple documents by their refs.
     * Equivalent to Firestore's db.getAll(...docRefs).
     * Errors propagate — Firestore's getAll rejects too; swallowing them made
     * failing reads look like missing documents.
     * @param {...PgDocRef} docRefs
     * @returns {Array} Array of DocumentSnapshots
     */
    async getAll(...docRefs) {
      return Promise.all(docRefs.map((ref) => ref.get()));
    },

    async runTransaction(updateFn) {
      const client = await getClient();
      let poisoned = null;
      try {
        await client.query('BEGIN');
        const transaction = new PgTransaction(client, registry, firestoreDb);
        const result = await updateFn(transaction);
        // Drain any writes the callback issued without awaiting (Firestore-style
        // synchronous set/update/delete) so they finish INSIDE the transaction — before
        // COMMIT — otherwise their SAVEPOINT/RELEASE races the commit and 25P01-crashes.
        await transaction._drain();
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rbErr) {
          poisoned = rbErr;
        }
        console.error('[pgAdapter] runTransaction() error:', err.message);
        throw err;
      } finally {
        client.release(poisoned || undefined);
      }
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createPgDb };
