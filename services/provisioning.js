/**
 * provisioning.js — ONE-TIME online provisioning for the on-prem local server.
 *
 * Industry-standard "activation": when the server is first set up (online), it pulls
 * a restaurant's config from the cloud into the LOCAL Postgres, then runs offline.
 * This is the productized version of the manual seed — Toast/Square/Petpooja all do
 * this at setup.
 *
 * Both sides are Postgres with the same schema, so we copy the restaurant's rows
 * (scoped by restaurant_id) from the CLOUD db into the LOCAL db. Idempotent upsert by
 * id, so it's safe to re-run (e.g. to refresh config).
 *
 * Only CONFIG/catalog + staff is pulled here (what you need to log in and take orders).
 * Transactions (orders/payments) are NOT pulled — those are created locally offline and
 * flow UP via the cloud-sync worker.
 */

const { Pool } = require('pg');

// Copied cloud → local, scoped to one restaurant. Parent→child order (FK safety).
const PROVISION_TABLES = [
  { table: 'restaurants', by: 'id' },            // the restaurant record (posSettings, taxSettings…)
  { table: 'app_users', by: 'restaurant_id' },   // owner/user accounts (offline login)
  { table: 'user_restaurants', by: 'restaurant_id' },
  { table: 'staff_users', by: 'restaurant_id' },  // staff (loginId + hashed password + PIN)
  { table: 'menus', by: 'restaurant_id' },
  { table: 'menu_items', by: 'restaurant_id' },
  { table: 'floors', by: 'restaurant_id' },
  { table: 'tables', by: 'restaurant_id' },
  { table: 'offers', by: 'restaurant_id' },
  { table: 'customers', by: 'restaurant_id' },
  { table: 'inventory', by: 'restaurant_id' },
];

async function getColumns(client, table) {
  const r = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return r.rows;
}

function coerce(value, dataType) {
  if (value == null) return value;
  if ((dataType === 'jsonb' || dataType === 'json') && typeof value === 'object') return JSON.stringify(value);
  return value;
}

async function copyScoped(cloud, local, table, byCol, rid) {
  const srcCols = await getColumns(cloud, table);
  if (!srcCols.length) return { table, skipped: 'missing in cloud' };
  const names = srcCols.map((c) => c.column_name);
  if (!names.includes('id')) return { table, skipped: 'no id' };
  if (!names.includes(byCol)) return { table, skipped: `no ${byCol}` };
  const dstNames = new Set((await getColumns(local, table)).map((c) => c.column_name));
  if (!dstNames.size) return { table, skipped: 'missing locally' };

  const cols = srcCols.filter((c) => dstNames.has(c.column_name));
  const colNames = cols.map((c) => c.column_name);
  const typeOf = Object.fromEntries(cols.map((c) => [c.column_name, c.data_type]));
  const setCols = colNames.filter((c) => c !== 'id');
  const quoted = colNames.map((c) => `"${c}"`).join(',');
  const ph = colNames.map((_, i) => `$${i + 1}`).join(',');
  const upd = setCols.map((c) => `"${c}"=EXCLUDED."${c}"`).join(',');
  const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${upd}`;

  const res = await cloud.query(`SELECT ${quoted} FROM "${table}" WHERE "${byCol}" = $1`, [rid]);
  let copied = 0;
  for (const row of res.rows) {
    await local.query(sql, colNames.map((c) => coerce(row[c], typeOf[c])));
    copied++;
  }
  return { table, copied };
}

/**
 * Pull one restaurant's config from cloud → local Postgres.
 * @param {string} restaurantId
 * @param {{cloudUrl?:string, localUrl?:string}} opts
 * @returns {Promise<{restaurantId:string, tables:object[]}>}
 */
async function provisionRestaurant(restaurantId, opts = {}) {
  const cloudUrl = opts.cloudUrl || process.env.CLOUD_DATABASE_URL;
  const localUrl = opts.localUrl || process.env.DATABASE_URL;
  if (!restaurantId) throw new Error('restaurantId is required');
  if (!cloudUrl) throw new Error('CLOUD_DATABASE_URL is not set (needed to pull data from the cloud)');
  if (!localUrl) throw new Error('DATABASE_URL (local) is not set');
  if (cloudUrl === localUrl) throw new Error('CLOUD_DATABASE_URL must differ from the local DATABASE_URL');

  const cloud = new Pool({ connectionString: cloudUrl, max: 4, connectionTimeoutMillis: 12000 });
  const local = new Pool({ connectionString: localUrl, max: 4 });
  const tables = [];
  try {
    // Confirm the restaurant exists in the cloud first (clear error if wrong id).
    const chk = await cloud.query('SELECT 1 FROM restaurants WHERE id = $1', [restaurantId]);
    if (!chk.rows.length) throw new Error(`Restaurant ${restaurantId} not found in the cloud database`);
    for (const { table, by } of PROVISION_TABLES) {
      try { tables.push(await copyScoped(cloud, local, table, by, restaurantId)); }
      catch (e) { tables.push({ table, error: e.message }); }
    }
  } finally {
    await cloud.end().catch(() => {});
    await local.end().catch(() => {});
  }
  return { restaurantId, tables };
}

module.exports = { provisionRestaurant, PROVISION_TABLES };
