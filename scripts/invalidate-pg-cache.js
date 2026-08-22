/**
 * invalidate-pg-cache.js — flush the pgAdapter Redis query cache.
 *
 * Run AFTER an out-of-band write to PostgreSQL (a Firestore→PG sync/backfill)
 * so the running app does NOT serve stale menu / price / stock / config until
 * the cache TTL expires. It bumps `pg:{table}:ver` for every table that has a
 * cacheTTL in the collection registry (or just the tables you name).
 *
 * Usage:
 *   cd dine-backend
 *   node scripts/invalidate-pg-cache.js                 # all cached tables
 *   node scripts/invalidate-pg-cache.js restaurants inventory   # only these
 *
 * resync-all-pg.sh runs this automatically at the end of a full sync.
 * On the VM, env.json is preloaded into process.env before this runs; the
 * dotenv line below is a no-op there and loads .env.local for local runs.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const REGISTRY = require('../repos/collectionRegistry');
const { bumpTableVersion } = require('../repos/pgCache');

function cachedTablesFromRegistry() {
  return [...new Set(
    Object.values(REGISTRY)
      .filter(cfg => cfg && cfg.cacheTTL && cfg.table)
      .map(cfg => cfg.table)
  )];
}

async function main() {
  const named = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const tables = named.length ? named : cachedTablesFromRegistry();

  if (tables.length === 0) {
    console.log('[invalidate-pg-cache] no cached tables to invalidate — nothing to do.');
    return;
  }

  console.log(`[invalidate-pg-cache] bumping cache version for ${tables.length} table(s): ${tables.join(', ')}`);
  for (const t of tables) {
    await bumpTableVersion(t);
    console.log(`  ✓ pg:${t}:ver bumped`);
  }
  console.log('[invalidate-pg-cache] done — cached reads will now re-fetch from PG.');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[invalidate-pg-cache] failed:', err.message);
    process.exit(1);
  });
