'use strict';

/**
 * API-based sync endpoints (secure transport for the offline LAN hub).
 *
 *   POST /api/sync/push   — hub pushes a batch of its changed rows UP to the cloud.
 *   GET  /api/sync/pull   — hub pulls DOWN changes (menu/prices/settings) since a watermark.
 *
 * The restaurant scope is taken ONLY from the authenticated token (req.user.restaurantId) — never
 * from the request body/query — so a hub can only ever read/write its own restaurant's data. Writes
 * go through cloudSyncWorker.applyRecords(), which reuses the same idempotent (strictly-newer),
 * column-scoped, preserve-col, restaurant-scoped guards as the mature PG↔PG replicator.
 *
 * DORMANT until a hub worker calls these — no existing flow invokes them.
 */
const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { authenticateToken } = require('../middleware/auth');
const { applyRecords, selectSince, DOWN_TABLES } = require('../services/cloudSyncWorker');

// Dedicated small pool to this backend's own DB (Cloud SQL on GCP). Absent on Firestore-only
// deployments → endpoints degrade gracefully to a 503 / empty pull.
let _pool = null;
function pool() {
  if (!process.env.DATABASE_URL) return null;
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, statement_timeout: 20000 });
  return _pool;
}

// The restaurant is supplied by the hub, but we NEVER trust it blindly: verify the authenticated
// user actually owns or belongs to that restaurant before scoping any read/write to it.
async function resolveScope(req, rid) {
  // A dedicated sync token (issued by POST /api/sync/token) carries the restaurant grant directly,
  // scoped to exactly one restaurant — no per-request access lookup needed.
  if (req.user && req.user.syncRestaurantId) {
    return (!rid || String(rid) === String(req.user.syncRestaurantId)) ? req.user.syncRestaurantId : null;
  }
  if (!rid) return null;
  const userId = req.user && req.user.userId;
  if (!userId) return null;
  const p = pool();
  if (!p) return null;
  try {
    const r = await p.query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM restaurants WHERE id = $1 AND owner_id = $2)
             OR EXISTS (SELECT 1 FROM user_restaurants WHERE restaurant_id = $1 AND user_id = $2)
             OR EXISTS (SELECT 1 FROM staff_users WHERE restaurant_id = $1 AND id = $2)`,
      [rid, userId]);
    return r.rowCount > 0 ? rid : null;
  } catch (_) { return null; }
}

// ─── Issue a long-lived, restaurant-scoped SYNC TOKEN for a hub ───────────────
// Owner/staff of the restaurant only. The hub stores this and authenticates its sync worker with
// it — far safer than a shared DB credential: it grants exactly one restaurant, nothing else.
router.post('/token', authenticateToken, async (req, res) => {
  const rid = await resolveScope(req, req.body && req.body.restaurantId);
  if (!rid) return res.status(403).json({ error: 'no access to that restaurant' });
  const token = jwt.sign({ syncRestaurantId: rid, role: 'sync' }, process.env.JWT_SECRET, { expiresIn: '365d' });
  res.json({ token, restaurantId: rid });
});

// ─── UP: hub → cloud ──────────────────────────────────────────────────────────
// body: { records: { "<table>": [ {id, updated_at, ...cols}, … ], … } }
router.post('/push', authenticateToken, express.json({ limit: '25mb' }), async (req, res) => {
  const p = pool();
  if (!p) return res.status(503).json({ error: 'cloud sync not available on this backend' });
  const rid = await resolveScope(req, req.body && req.body.restaurantId);
  if (!rid) return res.status(403).json({ error: 'no access to that restaurant' });

  const groups = (req.body && req.body.records) || {};
  if (typeof groups !== 'object' || Array.isArray(groups)) return res.status(400).json({ error: 'records must be an object keyed by table' });

  try {
    const results = [];
    for (const [table, rows] of Object.entries(groups)) {
      if (!Array.isArray(rows) || !rows.length) continue;
      results.push(await applyRecords(p, table, rows, { scopeRid: rid, direction: 'up' }));
    }
    const applied = results.reduce((a, r) => a + (r.applied || 0), 0);
    res.json({ ok: true, applied, results });
  } catch (e) {
    console.error('[sync/push] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── DOWN: cloud → hub ────────────────────────────────────────────────────────
// query: ?since=<iso>&tables=menus,menu_items,…  (defaults to DOWN_TABLES)
router.get('/pull', authenticateToken, async (req, res) => {
  const p = pool();
  if (!p) return res.json({ records: {}, next: req.query.since || null });
  const rid = await resolveScope(req, req.query.restaurantId);
  if (!rid) return res.status(403).json({ error: 'no access to that restaurant' });

  const since = req.query.since || new Date(0).toISOString();
  const tables = (req.query.tables ? String(req.query.tables).split(',') : DOWN_TABLES)
    .map((t) => String(t).trim()).filter(Boolean);

  try {
    const out = {};
    let maxNext = since;
    for (const table of tables) {
      const { rows, next } = await selectSince(p, table, since, rid, 500);
      if (rows.length) out[table] = rows;
      if (next && new Date(next) > new Date(maxNext)) maxNext = next;
    }
    res.json({ records: out, next: maxNext });
  } catch (e) {
    console.error('[sync/pull] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
