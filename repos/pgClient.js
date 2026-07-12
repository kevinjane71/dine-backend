const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.PG_POOL_MAX) || 10,
    min: parseInt(process.env.PG_POOL_MIN) || 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT_MS) || 10000,
    // Kill runaway queries server-side so a bad plan can't hold a connection forever
    statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS) || 30000,
  });

  pool.on('error', (err) => {
    console.error('PG pool error:', err.message);
  });

  return pool;
}

async function query(text, params) {
  const pool = getPool();
  return pool.query(text, params);
}

async function getClient() {
  const pool = getPool();
  return pool.connect();
}

module.exports = { getPool, query, getClient };
