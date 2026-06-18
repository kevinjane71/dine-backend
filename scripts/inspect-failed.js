require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { db, collections } = require('../firebase');
const { toPgRow, JSONB_COLUMNS } = require('../repos/fieldMapper');
const { getPool } = require('../repos/pgClient');

const failedIds = [
  '3Fs2GwrYQkIdR0jIN1Q1', 'YRxqG52lkUM0AiXPnOJ5', 'slFJqvmyWTsdjNPFFbrg',
  '4P7nayNHTlfcFIgu96Ak', 'faGIbTBRc25y1oLcRucz', 'Ky3DGb8YSn87bpnw8JAj',
  '9666Ys16MtDLlMeBEE0S', '3VvoOfCpYORZjiea5qom'
];

async function inspect() {
  const pool = getPool();
  let fixed = 0;

  for (const id of failedIds) {
    const doc = await db.collection(collections.orders).doc(id).get();
    if (!doc.exists) {
      console.log(id + ': NOT FOUND in Firestore');
      continue;
    }

    const data = doc.data();
    console.log(`\n=== ${id} (restaurant: ${data.restaurantId}, status: ${data.status}) ===`);

    const pgRow = toPgRow({ id: doc.id, ...data });

    // Find which columns have problematic values
    for (const [col, val] of Object.entries(pgRow)) {
      if (JSONB_COLUMNS.has(col) && val !== null && val !== undefined) {
        try {
          const str = typeof val === 'string' ? val : JSON.stringify(val);
          JSON.parse(str);
        } catch (e) {
          console.log(`  BAD JSONB: "${col}" = ${String(val).substring(0, 200)}`);
        }
      }
    }

    // Deep inspect: look for circular refs, undefined, functions in all JSONB cols
    for (const [col, val] of Object.entries(pgRow)) {
      if (JSONB_COLUMNS.has(col) && val !== null && val !== undefined) {
        try {
          JSON.stringify(val);
        } catch (e) {
          console.log(`  JSON.stringify fails for "${col}": ${e.message}`);
          // Try to sanitize
          pgRow[col] = JSON.parse(JSON.stringify(val, (key, value) => {
            if (value === undefined) return null;
            if (typeof value === 'function') return null;
            if (typeof value === 'bigint') return Number(value);
            return value;
          }));
          console.log(`  Sanitized "${col}"`);
        }
      }
    }

    // Try inserting with sanitized data
    try {
      const cols = [];
      const placeholders = [];
      const values = [];
      let i = 1;

      for (const [col, val] of Object.entries(pgRow)) {
        cols.push(col);
        if (JSONB_COLUMNS.has(col)) {
          placeholders.push(`$${i}::jsonb`);
          const jsonVal = val == null ? null : (typeof val === 'string' ? val : JSON.stringify(val));
          // Extra safety: ensure it's valid JSON
          if (jsonVal !== null) {
            try {
              JSON.parse(jsonVal);
            } catch (e) {
              console.log(`  Still bad JSON in "${col}", setting to null`);
              values.push(null);
              i++;
              continue;
            }
          }
          values.push(jsonVal);
        } else {
          values.push(val);
        }
        i++;
      }

      const result = await pool.query(
        `INSERT INTO orders (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT (id) DO NOTHING`,
        values
      );
      if (result.rowCount > 0) {
        console.log(`  ✓ FIXED - inserted successfully`);
        fixed++;
      } else {
        console.log(`  Already exists (skipped)`);
      }
    } catch (err) {
      console.log(`  ✗ Still failing: ${err.message}`);

      // Last resort: dump all JSONB values to find the problem
      for (const [col, val] of Object.entries(pgRow)) {
        if (JSONB_COLUMNS.has(col) && val !== null) {
          const str = typeof val === 'string' ? val : JSON.stringify(val);
          if (str && str.includes('undefined')) {
            console.log(`    "${col}" contains literal 'undefined'`);
          }
        }
      }
    }
  }

  // Final count
  const countResult = await pool.query('SELECT COUNT(*) as count FROM orders');
  console.log(`\nFixed: ${fixed}/${failedIds.length}`);
  console.log(`Total PG orders: ${countResult.rows[0].count}`);

  await pool.end();
}

inspect().catch(e => { console.error('ERROR:', e); process.exit(1); });
