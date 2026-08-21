/**
 * queryBuilder.js — Generic SQL query builders for PostgreSQL repos.
 *
 * Shared across all collection repos to avoid duplication.
 * Each repo passes its own JSONB_COLUMNS set and table name.
 */

/**
 * JSON.stringify replacer that normalizes all date-like values to ISO strings:
 *  - Firestore Timestamp ({ toDate() })  → ISO string
 *  - Serialized Timestamp ({ _seconds, _nanoseconds }) → ISO string
 *  - Date already serializes to ISO via its own toJSON
 * Ensures nested dates inside JSONB columns are stored consistently.
 */
function dateNormalizingReplacer(key, value) {
  const orig = this[key];
  if (orig && typeof orig === 'object') {
    if (typeof orig.toDate === 'function') {
      try { return orig.toDate().toISOString(); } catch (_) { return value; }
    }
    if (orig._seconds !== undefined && orig._nanoseconds !== undefined) {
      return new Date(orig._seconds * 1000 + orig._nanoseconds / 1e6).toISOString();
    }
  }
  return value;
}

/**
 * Convert a value to a valid JSONB string for PostgreSQL.
 */
function toJsonbValue(val) {
  if (val === null || val === undefined) return null;
  return JSON.stringify(val, dateNormalizingReplacer);
}

/**
 * Convert Firestore Timestamp or sentinel to JS Date.
 */
function convertTimestamp(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && typeof val.toDate === 'function') {
    return val.toDate();
  }
  if (typeof val === 'object' && val._seconds !== undefined) {
    return new Date(val._seconds * 1000);
  }
  return val;
}

/**
 * Check if a value is a Firestore FieldValue sentinel (delete, serverTimestamp, etc.)
 * NOTE: Firestore Timestamp objects also have isEqual() — they are data, not
 * sentinels, so exclude anything date-like (toDate / _seconds).
 */
function isFieldValueSentinel(val) {
  return (
    val !== null &&
    typeof val === 'object' &&
    typeof val.isEqual === 'function' &&
    typeof val.toDate !== 'function' &&
    val._seconds === undefined
  );
}

/**
 * Build a parameterized INSERT query.
 * @param {string} tableName
 * @param {Object} pgRow - { col: value, ... }
 * @param {Set} jsonbColumns - Set of column names that are JSONB
 * @returns {{ text: string, values: any[] }}
 */
function buildInsert(tableName, pgRow, jsonbColumns) {
  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const [col, val] of Object.entries(pgRow)) {
    cols.push(col);
    if (jsonbColumns.has(col)) {
      placeholders.push(`$${i}::jsonb`);
      values.push(toJsonbValue(val));
    } else {
      placeholders.push(`$${i}`);
      values.push(val);
    }
    i++;
  }

  return {
    text: `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values,
  };
}

/**
 * Build a parameterized UPDATE query.
 * @param {string} tableName
 * @param {string} id - Primary key value (WHERE id = $x)
 * @param {Object} pgRow - Partial row with columns to update
 * @param {Set} jsonbColumns - Set of column names that are JSONB
 * @returns {{ text: string, values: any[] }}
 */
function buildUpdate(tableName, id, pgRow, jsonbColumns) {
  const setClauses = [];
  const values = [];
  let i = 1;

  for (const [col, val] of Object.entries(pgRow)) {
    if (col === 'id') continue;
    if (jsonbColumns.has(col)) {
      if (col === 'extra_data') {
        setClauses.push(`${col} = COALESCE(${col}, '{}'::jsonb) || $${i}::jsonb`);
      } else {
        setClauses.push(`${col} = $${i}::jsonb`);
      }
      values.push(toJsonbValue(val));
    } else {
      setClauses.push(`${col} = $${i}`);
      values.push(val);
    }
    i++;
  }

  if (setClauses.length === 0) return null;

  setClauses.push('updated_at = NOW()');
  values.push(id);

  return {
    text: `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = $${i}`,
    values,
  };
}

/**
 * Build a parameterized UPSERT (INSERT ... ON CONFLICT DO UPDATE) query.
 * @param {string} tableName
 * @param {Object} pgRow - Full row
 * @param {Set} jsonbColumns - Set of column names that are JSONB
 * @param {string[]} conflictCols - Columns for ON CONFLICT clause (default: ['id'])
 * @returns {{ text: string, values: any[] }}
 */
function buildUpsert(tableName, pgRow, jsonbColumns, conflictCols = ['id'], opts = {}) {
  const cols = [];
  const placeholders = [];
  const values = [];
  let i = 1;

  for (const [col, val] of Object.entries(pgRow)) {
    cols.push(col);
    if (jsonbColumns.has(col)) {
      placeholders.push(`$${i}::jsonb`);
      values.push(toJsonbValue(val));
    } else {
      placeholders.push(`$${i}`);
      values.push(val);
    }
    i++;
  }

  // For merge-style set(), JSONB columns holding plain objects are shallow-
  // merged into the existing value (Firestore merge keeps sibling keys);
  // arrays and scalars still replace.
  const isMergeableObject = (col) => {
    const v = pgRow[col];
    return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
  };

  const updateCols = cols.filter(c => !conflictCols.includes(c));
  const updateClauses = updateCols.map(c => {
    if (c === 'extra_data') {
      return `${c} = COALESCE(${tableName}.${c}, '{}'::jsonb) || EXCLUDED.${c}`;
    }
    if (opts.mergeJsonb && jsonbColumns.has(c) && isMergeableObject(c)) {
      return `${c} = COALESCE(${tableName}.${c}, '{}'::jsonb) || EXCLUDED.${c}`;
    }
    return `${c} = EXCLUDED.${c}`;
  });

  if (updateClauses.length === 0) {
    return {
      text: `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING RETURNING *`,
      values,
    };
  }

  // Optional guard on the DO UPDATE — e.g. protect native rows from the sync:
  // opts.conflictWhere = "app_users.origin IS DISTINCT FROM 'native'"
  const guard = opts.conflictWhere ? ` WHERE ${opts.conflictWhere}` : '';
  return {
    text: `INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updateClauses.join(', ')}${guard} RETURNING *`,
    values,
  };
}

/**
 * Create a toPgRow function for a given field map, JSONB columns set, and skip fields set.
 * This is a factory — call it once per collection to get the converter function.
 */
function makeToPgRow(fieldMap, jsonbColumns, skipFields = new Set()) {
  return function toPgRow(firestoreObj) {
    const pgRow = {};
    const extra = {};

    for (const [key, value] of Object.entries(firestoreObj)) {
      if (skipFields.has(key)) continue;
      if (value === undefined) continue;
      if (isFieldValueSentinel(value)) continue;

      let cleanValue = convertTimestamp(value);

      const pgCol = fieldMap[key];
      if (pgCol) {
        pgRow[pgCol] = cleanValue;
      } else {
        extra[key] = cleanValue;
      }
    }

    if (Object.keys(extra).length > 0) {
      pgRow.extra_data = extra;
    }

    return pgRow;
  };
}

/**
 * Create a toFirestoreObj function for a given reverse map.
 */
function makeToFirestoreObj(reverseMap) {
  // Keys that correspond to REAL mapped columns. A value for any of these must come from
  // the column, never from a stale copy left inside extra_data by a past missing-column
  // write — otherwise extra_data (spread last) would overwrite the authoritative column
  // and silently scramble data (e.g. table status showing occupied when it's available).
  const mappedKeys = new Set([...Object.keys(reverseMap), ...Object.values(reverseMap)]);
  return function toFirestoreObj(pgRow) {
    const obj = {};

    // 1. extra_data (unmapped/overflow fields) FIRST, at lowest priority — but skip any
    //    key that is actually a mapped column (it will be filled from the real column).
    const ed = pgRow.extra_data;
    if (ed && typeof ed === 'object') {
      for (const [k, v] of Object.entries(ed)) {
        if (v === null || v === undefined) continue;
        if (mappedKeys.has(k)) continue;
        obj[k] = v;
      }
    }

    // 2. Real mapped columns override — authoritative. (Unmapped non-extra_data columns
    //    are dropped, preserving prior behavior.)
    for (const [col, value] of Object.entries(pgRow)) {
      if (col === 'extra_data') continue;
      if (value === null || value === undefined) continue;
      const camelKey = reverseMap[col];
      if (camelKey) obj[camelKey] = value;
    }

    return obj;
  };
}

/**
 * Build reverse map from a field map.
 */
function buildReverseMap(fieldMap) {
  const reverse = {};
  for (const [k, v] of Object.entries(fieldMap)) {
    reverse[v] = k;
  }
  return reverse;
}

module.exports = {
  toJsonbValue,
  convertTimestamp,
  isFieldValueSentinel,
  buildInsert,
  buildUpdate,
  buildUpsert,
  makeToPgRow,
  makeToFirestoreObj,
  buildReverseMap,
};
