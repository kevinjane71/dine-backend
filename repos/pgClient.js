const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.PG_POOL_MAX) || 10,
    min: parseInt(process.env.PG_POOL_MIN) || 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
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
