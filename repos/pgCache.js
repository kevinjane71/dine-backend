/**
 * pgCache.js — shared PostgreSQL query-cache invalidation helper.
 *
 * The pgAdapter (repos/pgAdapter.js) caches doc/query reads in Redis and
 * invalidates them by bumping a per-table version counter. Every cache key
 * embeds that version, so bumping it makes all prior reads for the table miss:
 *
 *     Version key: pg:{table}:ver
 *     Doc read:    pg:{table}:v{version}:{id}
 *     Query read:  pg:{table}:v{version}:q:{hash}
 *
 * ANY writer that bypasses the adapter and writes a cached table with raw SQL
 * (the Firestore→PG sync / backfill scripts) MUST bump the same counter after
 * writing, or the running app serves stale reads until the cache TTL expires
 * (restaurants 180s, menus/menu_items/offers/staff_users 120s, floors/tables
 * 60s, inventory 30s).
 *
 * ⚠ The version-key format here MUST stay identical to pgAdapter.js
 *   (getTableVersion / bumpTableVersion / docCacheKey / queryCacheKey).
 *   If you change the key shape in one place, change it in both.
 *
 * Depends only on kvCache (no DB, no registry) so it is safe to require from
 * lightweight scripts.
 */

const { kvGet, kvIncrBy } = require('../utils/kvCache');

function versionKey(table) {
  return `pg:${table}:ver`;
}

async function getTableVersion(table) {
  const ver = await kvGet(versionKey(table));
  return ver || 0;
}

/**
 * Bump a table's cache version → all cached doc/query reads for it auto-miss.
 * Best-effort with a 1h TTL on the counter (matches pgAdapter). A Redis blip
 * must never throw into the caller.
 */
async function bumpTableVersion(table) {
  if (!table) return;
  await kvIncrBy(versionKey(table), 1, 3600).catch(() => {});
}

/**
 * Bump many tables in sequence (used after a sync/backfill run).
 */
async function bumpTables(tables) {
  for (const t of tables || []) {
    await bumpTableVersion(t);
  }
}

module.exports = { versionKey, getTableVersion, bumpTableVersion, bumpTables };
