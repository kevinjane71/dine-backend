// Phase B pilot protection. Run AFTER daily-stats + counters upsert.
// Restores GCP pilot restaurant so its sequential counter can't regress and
// its GCP-only daily_stats contribution isn't lost.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });
const { Client } = require('pg');
const snap = require('/private/tmp/claude-501/-Users-vivek-code-dine/681cfd40-e4b0-457e-b4af-6e04dab7e286/scratchpad/pilot-snapshot.json');
const PILOT = 'LUETVd1eMwu4Bm7PvP9K';
const DS_JSONB = new Set(['payment_methods','order_types','item_counts','category_breakdown','customer_ids','extra_data']);

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL.replace(/^"|"$/g,'') });
  await c.connect();
  await c.query('BEGIN');

  // 1) order_counters — never let last_value regress below the snapshot (GCP-advanced) value.
  let counterFixes = 0;
  for (const row of snap.counters) {
    const r = await c.query(
      `UPDATE order_counters SET last_value = GREATEST(COALESCE(last_value,0), $2), updated_at = NOW()
       WHERE id = $1 AND COALESCE(last_value,0) < $2 RETURNING id, last_value`,
      [row.id, row.last_value ?? 0]
    );
    if (r.rowCount) counterFixes++;
    // If the counters upsert deleted/never-created the row, re-insert the snapshot value.
    const exists = await c.query('SELECT 1 FROM order_counters WHERE id=$1', [row.id]);
    if (!exists.rowCount) {
      await c.query(
        `INSERT INTO order_counters (id, restaurant_id, counter_type, date, last_value, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())`,
        [row.id, row.restaurant_id, row.counter_type, row.date, row.last_value]
      );
      counterFixes++;
    }
  }

  // 2) daily_stats — restore the pilot's 94 rows verbatim (delete + reinsert snapshot).
  await c.query('DELETE FROM daily_stats WHERE restaurant_id = $1', [PILOT]);
  let statsRestored = 0;
  for (const row of snap.stats) {
    const cols = Object.keys(row);
    const placeholders = cols.map((col, i) => DS_JSONB.has(col) ? `$${i+1}::jsonb` : `$${i+1}`);
    const values = cols.map(col => {
      const v = row[col];
      if (DS_JSONB.has(col)) return v === null || v === undefined ? null : JSON.stringify(v);
      return v;
    });
    await c.query(
      `INSERT INTO daily_stats (${cols.join(',')}) VALUES (${placeholders.join(',')})`,
      values
    );
    statsRestored++;
  }

  await c.query('COMMIT');
  console.log(`Pilot restore complete: counter rows protected/reinserted=${counterFixes}, daily_stats rows restored=${statsRestored}`);
  // Verify the critical sequential counter
  const seq = await c.query(`SELECT last_value FROM order_counters WHERE id=$1`, [PILOT + '_sequential_order']);
  console.log('sequential_order last_value now:', seq.rows[0]?.last_value, '(snapshot was 1551)');
  await c.end();
  process.exit(0);
})().catch(e => { console.error('RESTORE FAIL', e.message); process.exit(1); });
