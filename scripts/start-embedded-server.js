#!/usr/bin/env node
/**
 * start-embedded-server.js — ONE-CLICK offline server for any Windows/Mac/Linux box.
 *
 * Boots a self-contained PostgreSQL (via the `embedded-postgres` package, which ships
 * real PG binaries per-platform — no separate install), ensures the `dine` database +
 * schema exist, then starts the REAL dine-backend against it. The other terminals on
 * the LAN just point at http://<this-ip>:3003.
 *
 * First run:  npm i embedded-postgres     (one-time, downloads the PG binary)
 *             node scripts/start-embedded-server.js
 *
 * Env overrides: PG_DATA_DIR, PG_PORT (default 5433), PG_USER, PG_PASSWORD, PG_DB,
 *                PG_SCHEMA_FILE (a pg_dump --schema-only file to load on first init),
 *                PORT (backend, default 3003).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

async function loadSchema(connString) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: connString });
  await client.connect();
  try {
    // Preferred: a full schema clone from production (pg_dump --schema-only).
    const schemaFile = process.env.PG_SCHEMA_FILE ||
      [path.join(__dirname, 'offline-schema.sql'), path.join(process.cwd(), 'offline-schema.sql')]
        .find((p) => fs.existsSync(p));
    if (schemaFile && fs.existsSync(schemaFile)) {
      console.log(`📐 Loading schema from ${schemaFile} ...`);
      await client.query(fs.readFileSync(schemaFile, 'utf8'));
      console.log('✅ Schema loaded.');
      return true;
    }
    // Fallback: apply the repo's create-*.sql files (best effort).
    const sqlDir = __dirname;
    const sqls = fs.readdirSync(sqlDir).filter((f) => /^create-.*\.sql$/.test(f)).sort();
    if (sqls.length) {
      console.log(`📐 No offline-schema.sql — applying ${sqls.length} create-*.sql files (best effort).`);
      for (const f of sqls) {
        try { await client.query(fs.readFileSync(path.join(sqlDir, f), 'utf8')); console.log(`   • ${f}`); }
        catch (e) { console.warn(`   ! ${f}: ${e.message}`); }
      }
      console.log('⚠️  Some tables are created by JS scripts (create-*-tables.js) and by the pgAdapter');
      console.log('   auto-column fallback. For a complete schema, generate offline-schema.sql once:');
      console.log('   pg_dump --schema-only --no-owner --no-privileges "<CLOUD_DATABASE_URL>" > scripts/offline-schema.sql');
      return false;
    }
    console.warn('⚠️  No schema files found. Provide PG_SCHEMA_FILE (pg_dump --schema-only).');
    return false;
  } finally {
    await client.end();
  }
}

async function main() {
  let EmbeddedPostgres;
  try {
    // embedded-postgres is ESM-only; use dynamic import() so it works on Node that
    // can't require() ESM (e.g. Electron's bundled Node 20).
    const M = await import('embedded-postgres');
    EmbeddedPostgres = M.default || M;
  } catch (e) {
    console.error('❌ `embedded-postgres` is not installed. Run once on this machine:');
    console.error('     npm i embedded-postgres');
    console.error('   (downloads a self-contained PostgreSQL binary for this OS — no separate install)');
    process.exit(1);
  }

  const dataDir = process.env.PG_DATA_DIR || path.join(os.homedir(), 'dineopen-pgdata');
  const port = parseInt(process.env.PG_PORT || '5433', 10);
  const user = process.env.PG_USER || 'dine_app';
  const password = process.env.PG_PASSWORD || 'dineopen_local';
  const dbName = process.env.PG_DB || 'dine';
  const firstInit = !fs.existsSync(dataDir);

  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user, password, port, persistent: true });

  if (firstInit) {
    console.log(`🐘 Initialising embedded Postgres in ${dataDir} ...`);
    await pg.initialise();
  }
  await pg.start();
  console.log(`🐘 Embedded Postgres running on 127.0.0.1:${port}`);

  // Ensure the target database exists.
  try { await pg.createDatabase(dbName); console.log(`✅ Database "${dbName}" created.`); }
  catch (_) { /* already exists */ }

  const connString = `postgresql://${user}:${password}@127.0.0.1:${port}/${dbName}`;
  if (firstInit) {
    try { await loadSchema(connString); }
    catch (e) { console.warn('Schema load warning:', e.message); }
    console.log('ℹ️  First run — seed this restaurant\'s data once while online:');
    console.log(`   DATABASE_URL="${connString}" ./scripts/resync-all-pg.sh`);
  }

  // Hand off to the real backend against the embedded PG.
  process.env.DATABASE_URL = connString;
  if (!process.env.PORT) process.env.PORT = '3003';
  process.env.LOCAL_SERVER_MODE = 'true'; // enables LAN socket + provisioning (off on cloud)
  console.log('🚀 Starting dine-backend against embedded Postgres ...');
  require(path.join(__dirname, '..', 'index.js'));

  const shutdown = async (sig) => {
    console.log(`\n${sig} — stopping embedded Postgres ...`);
    try { await pg.stop(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => { console.error('❌ Embedded server failed:', e); process.exit(1); });
