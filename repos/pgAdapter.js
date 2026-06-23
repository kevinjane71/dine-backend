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

function resolveField(fieldMap, field) {
  if (field === '__name__') return 'id';
  return fieldMap[field] || camelToSnake(field);
}

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
  return val._operand || val.operand || 1;
}

/**
 * Extract the elements array from FieldValue.arrayUnion() / arrayRemove().
 */
function getArrayElements(val) {
  return val._elements || val.elements || [];
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
    return { id: this._collectionName };
  }

  /**
   * Execute a query — uses transaction client if available, otherwise pool.
   */
  async _exec(text, values) {
    if (this._client) {
      return this._client.query(text, values);
    }
    return pgQuery(text, values);
  }

  /**
   * GET a single document by ID.
   */
  async get() {
    try {
      const { table, cacheTTL } = this._config;

      // Redis cache check (only for non-transactional reads on cacheable collections)
      if (cacheTTL && !this._client) {
        try {
          const ver = await getTableVersion(table);
          const cKey = docCacheKey(table, ver, this.id);
          const cached = await kvGet(cKey);
          if (cached) {
            if (cached === '__null__') {
              return makeDocumentSnapshot(this.id, null, this);
            }
            return makeDocumentSnapshot(this.id, cached, this);
          }
        } catch (_) { /* cache miss — fall through to PG */ }
      }

      const result = await this._exec(
        `SELECT * FROM ${table} WHERE id = $1`,
        [this.id]
      );
      if (result.rows.length === 0) {
        // Cache the miss briefly to avoid repeated queries for non-existent docs
        if (cacheTTL && !this._client) {
          const ver = await getTableVersion(table).catch(() => 0);
          kvSet(docCacheKey(table, ver, this.id), '__null__', Math.min(cacheTTL, 30)).catch(() => {});
        }
        return makeDocumentSnapshot(this.id, null, this);
      }
      const data = this._config.toFirestoreObj(result.rows[0]);

      // Cache the result
      if (cacheTTL && !this._client) {
        const ver = await getTableVersion(table).catch(() => 0);
        kvSet(docCacheKey(table, ver, this.id), data, cacheTTL).catch(() => {});
      }

      return makeDocumentSnapshot(this.id, data, this);
    } catch (err) {
      console.error(`[pgAdapter] DocRef.get() error (${this.path}):`, err.message);
      throw err;
    }
  }

  /**
   * SET — UPSERT a document.
   * @param {Object} data
   * @param {Object} [options] - { merge: true } for partial upsert
   */
  async set(data, options) {
    try {
      const { table, jsonbCols } = this._config;
      const pgRow = this._config.toPgRow({ id: this.id, ...data });
      if (!pgRow.id) pgRow.id = this.id;

      const upsert = buildUpsert(table, pgRow, jsonbCols);
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
          const retry = buildUpsert(table, pgRow, jsonbCols);
          await this._exec(retry.text, retry.values);
        } else {
          throw innerErr;
        }
      }
      // Invalidate cache
      if (this._config.cacheTTL) bumpTableVersion(table).catch(() => {});
    } catch (err) {
      console.error(`[pgAdapter] DocRef.set() error (${this.path}):`, err.message);
      throw err;
    }
  }

  /**
   * UPDATE — partial update with FieldValue sentinel support.
   * @param {Object} data
   */
  async update(data) {
    try {
      const { table, fieldMap, jsonbCols } = this._config;
      const setClauses = [];
      const values = [];
      let paramIdx = 1;

      for (const [key, val] of Object.entries(data)) {
        if (val === undefined) continue;

        // Handle dot-notation (e.g. 'subscription.status')
        const dotParts = key.split('.');
        const topLevelKey = dotParts[0];
        const pgCol = resolveField(fieldMap, topLevelKey);

        if (dotParts.length > 1 && jsonbCols.has(pgCol)) {
          // Nested update into a JSONB column
          const jsonPath = dotParts.slice(1);
          const pathLiteral = '{' + jsonPath.join(',') + '}';
          const jsonVal = JSON.stringify(val);
          setClauses.push(
            `${pgCol} = jsonb_set(COALESCE(${pgCol}, '{}'), '${pathLiteral}', $${paramIdx}::jsonb)`
          );
          values.push(jsonVal);
          paramIdx++;
          continue;
        }

        if (dotParts.length > 1) {
          // Dot-notation on a non-JSONB column — update the top-level column
          // and ignore the nested path (no structured sub-fields in regular cols)
          if (isFieldValueSentinel(val)) {
            // still handle sentinel below using pgCol
          } else {
            setClauses.push(`${pgCol} = $${paramIdx}`);
            values.push(val instanceof Date ? val : convertTimestamp(val));
            paramIdx++;
            continue;
          }
        }

        // FieldValue sentinels
        if (isFieldValueSentinel(val)) {
          const fvType = getFieldValueType(val);
          switch (fvType) {
            case 'increment': {
              const operand = getIncrementOperand(val);
              setClauses.push(
                `${pgCol} = COALESCE(${pgCol}, 0) + ${Number(operand)}`
              );
              break;
            }
            case 'serverTimestamp': {
              setClauses.push(`${pgCol} = NOW()`);
              break;
            }
            case 'arrayUnion': {
              const elements = getArrayElements(val);
              setClauses.push(
                `${pgCol} = COALESCE(${pgCol}, '[]'::jsonb) || $${paramIdx}::jsonb`
              );
              values.push(JSON.stringify(elements));
              paramIdx++;
              break;
            }
            case 'arrayRemove': {
              const removeElements = getArrayElements(val);
              // Remove each element from the jsonb array
              let expr = `COALESCE(${pgCol}, '[]'::jsonb)`;
              for (const elem of removeElements) {
                expr = `(SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(${expr}) AS e WHERE e != $${paramIdx}::jsonb)`;
                values.push(JSON.stringify(elem));
                paramIdx++;
              }
              setClauses.push(`${pgCol} = ${expr}`);
              break;
            }
            case 'delete': {
              setClauses.push(`${pgCol} = NULL`);
              break;
            }
            default: {
              // Unknown sentinel — treat as regular value
              console.warn(
                `[pgAdapter] Unknown FieldValue sentinel type for field "${key}"`
              );
              setClauses.push(`${pgCol} = $${paramIdx}`);
              values.push(val);
              paramIdx++;
              break;
            }
          }
          continue;
        }

        // Regular field
        const cleanVal = convertTimestamp(val);
        if (jsonbCols.has(pgCol)) {
          setClauses.push(`${pgCol} = $${paramIdx}::jsonb`);
          values.push(toJsonbValue(cleanVal));
        } else {
          setClauses.push(`${pgCol} = $${paramIdx}`);
          values.push(cleanVal);
        }
        paramIdx++;
      }

      if (setClauses.length === 0) return;

      // Bump updated_at unless already set in this update
      const alreadySetsUpdatedAt = setClauses.some(c => c.startsWith('updated_at'));
      if (!alreadySetsUpdatedAt) {
        setClauses.push('updated_at = NOW()');
      }

      values.push(this.id);
      const sql = `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`;
      try {
        await this._exec(sql, values);
      } catch (innerErr) {
        // If a column doesn't exist, retry without that column
        const colMatch = innerErr.message.match(/column "([^"]+)" of relation/);
        if (colMatch) {
          const badCol = colMatch[1];
          console.warn(`[pgAdapter] Column "${badCol}" missing on ${table}, storing in extra_data`);
          // Rebuild without the bad column — collect overflow into extra_data
          const overflow = {};
          const retryClauses = [];
          const retryValues = [];
          let retryIdx = 1;
          for (const [key, val] of Object.entries(data)) {
            if (val === undefined) continue;
            const topKey = key.split('.')[0];
            const pgCol = resolveField(fieldMap, topKey);
            if (pgCol === badCol) {
              overflow[key] = val instanceof Date ? val.toISOString() : val;
              continue;
            }
          }
          // Re-run the whole update excluding bad keys
          const filteredData = { ...data };
          for (const k of Object.keys(overflow)) delete filteredData[k];
          if (Object.keys(overflow).length > 0 && jsonbCols.has('extra_data')) {
            filteredData['extra_data'] = { ...overflow };
          }
          // Recursive call with filtered data
          return this.update(filteredData);
        }
        throw innerErr;
      }
      // Invalidate cache
      if (this._config.cacheTTL) bumpTableVersion(table).catch(() => {});
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
      await this._exec(`DELETE FROM ${table} WHERE id = $1`, [this.id]);
      // Invalidate cache
      if (this._config.cacheTTL) bumpTableVersion(table).catch(() => {});
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

  startAfter(docSnapshot) {
    const q = this._clone();
    q._startAfterSnap = docSnapshot;
    return q;
  }

  offset(n) {
    const q = this._clone();
    q._offsetVal = n;
    return q;
  }

  /**
   * count() — Returns a query whose get() returns { data() { return { count } } }
   */
  count() {
    const self = this;
    return {
      async get() {
        try {
          const { table, fieldMap } = self._config;
          const conditions = [];
          const values = [];
          let paramIdx = 1;

          for (const w of self._wheres) {
            const pgCol = resolveField(fieldMap, w.field);
            const mappedOp = OP_MAP[w.op];
            if (!mappedOp) throw new Error(`[pgAdapter] Unsupported operator: "${w.op}"`);
            const cleanValue = convertTimestamp(w.value);

            if (w.op === 'in') {
              if (!Array.isArray(cleanValue) || cleanValue.length === 0) {
                return { data: () => ({ count: 0 }) };
              }
              conditions.push(`${pgCol} = ANY($${paramIdx})`);
              values.push(cleanValue);
              paramIdx++;
            } else if (w.op === 'not-in') {
              if (!Array.isArray(cleanValue) || cleanValue.length === 0) continue;
              conditions.push(`${pgCol} != ALL($${paramIdx})`);
              values.push(cleanValue);
              paramIdx++;
            } else if (w.op === 'array-contains') {
              conditions.push(`${pgCol} @> $${paramIdx}::jsonb`);
              values.push(JSON.stringify([cleanValue]));
              paramIdx++;
            } else {
              conditions.push(`${pgCol} ${mappedOp} $${paramIdx}`);
              values.push(cleanValue);
              paramIdx++;
            }
          }

          let sql = `SELECT COUNT(*) AS cnt FROM ${table}`;
          if (conditions.length > 0) {
            sql += ' WHERE ' + conditions.join(' AND ');
          }

          const result = await pgQuery(sql, values);
          const cnt = parseInt(result.rows[0].cnt, 10);
          return { data: () => ({ count: cnt }) };
        } catch (err) {
          console.error(`[pgAdapter] count() error (${self._collectionName}):`, err.message);
          return { data: () => ({ count: 0 }) };
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
      const { table, fieldMap, jsonbCols, toFirestoreObj, cacheTTL } = this._config;

      // Redis query cache check — only for cacheable collections without cursor pagination
      let qCacheKey = null;
      if (cacheTTL && !this._startAfterSnap) {
        try {
          const ver = await getTableVersion(table);
          const queryDesc = {
            w: this._wheres.map(w => ({ f: w.field, o: w.op, v: w.value instanceof Date ? w.value.toISOString() : w.value })),
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
              return makeDocumentSnapshot(item.id, item.data, ref);
            });
            return makeQuerySnapshot(docs);
          }
        } catch (_) { /* cache miss — fall through to PG */ }
      }

      const conditions = [];
      const values = [];
      let paramIdx = 1;

      // WHERE clauses
      for (const w of this._wheres) {
        // Handle dot-notation for JSONB fields (e.g. 'staffInfo.userId')
        const dotParts = w.field.split('.');
        const topField = dotParts[0];
        const pgCol = resolveField(fieldMap, topField);
        const mappedOp = OP_MAP[w.op];

        if (dotParts.length > 1 && jsonbCols && jsonbCols.has(pgCol)) {
          // JSONB path query: staff_info->>'userId' = $1
          const jsonPath = dotParts.slice(1);
          let jsonExpr = pgCol;
          for (let i = 0; i < jsonPath.length - 1; i++) {
            jsonExpr = `${jsonExpr}->'${jsonPath[i]}'`;
          }
          jsonExpr = `${jsonExpr}->>'${jsonPath[jsonPath.length - 1]}'`;
          const cleanValue = convertTimestamp(w.value);
          conditions.push(`${jsonExpr} ${mappedOp} $${paramIdx}`);
          values.push(typeof cleanValue === 'number' ? String(cleanValue) : cleanValue);
          paramIdx++;
          continue;
        }

        if (!mappedOp) {
          throw new Error(`[pgAdapter] Unsupported operator: "${w.op}"`);
        }

        const cleanValue = convertTimestamp(w.value);

        if (w.op === 'in') {
          if (!Array.isArray(cleanValue) || cleanValue.length === 0) {
            // Empty 'in' array — return empty result
            return makeQuerySnapshot([]);
          }
          conditions.push(`${pgCol} = ANY($${paramIdx})`);
          values.push(cleanValue);
          paramIdx++;
        } else if (w.op === 'not-in') {
          if (!Array.isArray(cleanValue) || cleanValue.length === 0) {
            // Empty 'not-in' — no filter needed
            continue;
          }
          conditions.push(`${pgCol} != ALL($${paramIdx})`);
          values.push(cleanValue);
          paramIdx++;
        } else if (w.op === 'array-contains') {
          // JSONB contains: col @> '["value"]'::jsonb
          conditions.push(`${pgCol} @> $${paramIdx}::jsonb`);
          values.push(JSON.stringify([cleanValue]));
          paramIdx++;
        } else {
          conditions.push(`${pgCol} ${mappedOp} $${paramIdx}`);
          values.push(cleanValue);
          paramIdx++;
        }
      }

      // Build query
      let sql = `SELECT * FROM ${table}`;
      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      // ORDER BY
      if (this._orderBys.length > 0) {
        const orderParts = this._orderBys.map((o) => {
          const col = resolveField(fieldMap, o.field);
          const dir = o.direction === 'desc' ? 'DESC' : 'ASC';
          return `${col} ${dir}`;
        });
        sql += ' ORDER BY ' + orderParts.join(', ');
      }

      // startAfter — cursor pagination using the ordered fields
      if (this._startAfterSnap && this._orderBys.length > 0) {
        const snapData = this._startAfterSnap.data
          ? this._startAfterSnap.data()
          : null;
        if (snapData) {
          const cursorConditions = [];
          for (const o of this._orderBys) {
            const col = resolveField(fieldMap, o.field);
            const snapVal =
              snapData[o.field] !== undefined
                ? snapData[o.field]
                : snapData[camelToSnake(o.field)];
            if (snapVal !== undefined && snapVal !== null) {
              const cmpOp = o.direction === 'desc' ? '<' : '>';
              cursorConditions.push(`${col} ${cmpOp} $${paramIdx}`);
              values.push(convertTimestamp(snapVal));
              paramIdx++;
            }
          }
          if (cursorConditions.length > 0) {
            // Wrap cursor conditions: they should be ANDed together and ANDed with existing WHERE
            const cursorSql = cursorConditions.join(' AND ');
            if (conditions.length > 0) {
              sql += ` AND (${cursorSql})`;
            } else {
              sql += ` WHERE ${cursorSql}`;
            }
          }
        }
      }

      // LIMIT
      if (this._limitVal != null) {
        sql += ` LIMIT ${parseInt(this._limitVal, 10)}`;
      }

      // OFFSET
      if (this._offsetVal != null) {
        sql += ` OFFSET ${parseInt(this._offsetVal, 10)}`;
      }

      const result = await pgQuery(sql, values);

      const docs = result.rows.map((row) => {
        const data = toFirestoreObj(row);
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
    return new PgDocRef(
      this._collectionName,
      id,
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

  startAfter(docSnapshot) {
    const q = new PgQuery(
      this._config,
      this._collectionName,
      this._firestoreDb
    );
    return q.startAfter(docSnapshot);
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
   * @param {Object} data
   * @returns {{ id: string }}
   */
  async add(data) {
    try {
      const { table, jsonbCols } = this._config;
      const id = generateId();
      const pgRow = this._config.toPgRow({ id, ...data });
      if (!pgRow.id) pgRow.id = id;

      const { text, values } = buildInsert(table, pgRow, jsonbCols);
      await pgQuery(text, values);
      // Invalidate cache
      if (this._config.cacheTTL) bumpTableVersion(table).catch(() => {});
      return { id };
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

  _addScope(q) {
    // Add ancestor scopes first (e.g. restaurantId from grandparent)
    for (const scope of this._ancestorScopes) {
      q._wheres.unshift({ field: scope.field, op: '==', value: scope.value });
    }
    // Add the immediate parent scope filter
    q._wheres.unshift({ field: this._scopeField, op: '==', value: this._parentDocId });
    // Deduplicate
    const seen = new Set();
    q._wheres = q._wheres.filter(w => {
      const key = `${w.field}|${w.op}|${w.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return q;
  }

  where(field, op, value) {
    return this._addScope(super.where(field, op, value));
  }

  orderBy(field, direction) {
    return this._addScope(super.orderBy(field, direction));
  }

  limit(n) {
    return this._addScope(super.limit(n));
  }

  async get() {
    const q = new PgQuery(this._config, this._collectionName, this._firestoreDb);
    // Add ancestor scopes
    for (const scope of this._ancestorScopes) {
      q._wheres.push({ field: scope.field, op: '==', value: scope.value });
    }
    q._wheres.push({ field: this._scopeField, op: '==', value: this._parentDocId });
    return q.get();
  }

  doc(id) {
    // Return a PgDocRef that carries our full scope chain for child subcollections
    const ref = new PgDocRef(
      this._collectionName,
      id,
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
      await client.query('ROLLBACK');
      console.error('[pgAdapter] Batch.commit() error:', err.message);
      throw err;
    } finally {
      client.release();
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
  }

  /**
   * GET a document within the transaction.
   * @param {PgDocRef} docRef
   */
  async get(docRef) {
    if (docRef instanceof PgDocRef) {
      const txRef = new PgDocRef(
        docRef._collectionName,
        docRef.id,
        docRef._config,
        docRef._firestoreDb,
        this._client
      );
      return txRef.get();
    }
    // Firestore ref — read outside transaction
    return docRef.get();
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
      return txRef.set(data, options);
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
      return txRef.update(data);
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
      return txRef.delete();
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
     * Batch-fetch multiple documents by their refs.
     * Equivalent to Firestore's db.getAll(...docRefs).
     * @param {...PgDocRef} docRefs
     * @returns {Array} Array of DocumentSnapshots
     */
    async getAll(...docRefs) {
      const results = [];
      for (const ref of docRefs) {
        try {
          const snap = await ref.get();
          results.push(snap);
        } catch (err) {
          // Return a non-existent snapshot on error (matches Firestore behavior)
          results.push(makeDocumentSnapshot(ref.id, null, ref));
        }
      }
      return results;
    },

    async runTransaction(updateFn) {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const transaction = new PgTransaction(client, registry, firestoreDb);
        const result = await updateFn(transaction);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('[pgAdapter] runTransaction() error:', err.message);
        throw err;
      } finally {
        client.release();
      }
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { createPgDb };
