/**
 * Device registry + event API for the unified offline/online POS.
 * Mounted at /api/offline. ADDITIVE — new endpoints, nothing existing depends on them.
 * Requires the sync tables (scripts/create-offline-sync-tables.sql).
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const registry = require('../services/offlineSync/deviceRegistry');
const orderEvents = require('../services/offlineSync/orderEvents');
const syncEngine = require('../services/offlineSync/syncEngine');
const numbering = require('../services/offlineSync/orderNumbering');
const stockReconcile = require('../services/offlineSync/stockReconcile');

// Register (or refresh) this device; returns its record incl. auto-assigned name.
router.post('/offline/devices/register', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, deviceId, role, platform, appVersion } = req.body || {};
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId required' });
    const device = await registry.registerDevice(restaurantId, deviceId, { role, platform, appVersion });
    res.json({ success: true, device });
  } catch (e) {
    console.error('device register error:', e.message);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// Lightweight liveness ping (drives Hub-election heartbeat later).
router.post('/offline/devices/heartbeat', authenticateToken, async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
    await registry.heartbeat(deviceId);
    res.json({ success: true });
  } catch (e) {
    console.error('device heartbeat error:', e.message);
    res.status(500).json({ error: 'Failed to heartbeat' });
  }
});

router.get('/offline/devices/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const devices = await registry.listDevices(req.params.restaurantId);
    res.json({ success: true, devices });
  } catch (e) {
    console.error('device list error:', e.message);
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

router.patch('/offline/devices/:deviceId/name', authenticateToken, async (req, res) => {
  try {
    const { displayName } = req.body || {};
    if (!displayName) return res.status(400).json({ error: 'displayName required' });
    await registry.renameDevice(req.params.deviceId, displayName);
    res.json({ success: true });
  } catch (e) {
    console.error('device rename error:', e.message);
    res.status(500).json({ error: 'Failed to rename device' });
  }
});

// Read an order projected from its event log (deterministic replay).
router.get('/offline/orders/:restaurantId/:orderId/projection', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;
    const result = await orderEvents.projectOrder(restaurantId, orderId);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('order projection error:', e.message);
    res.status(500).json({ error: 'Failed to project order' });
  }
});

// ── Sync transport (receiver side; called by a Terminal on the Hub, or Hub on Cloud) ──

// Push a batch of events up. Idempotent. Returns acked event_ids + high-water mark.
router.post('/offline/sync/push', authenticateToken, async (req, res) => {
  try {
    const { events } = req.body || {};
    if (!Array.isArray(events)) return res.status(400).json({ error: 'events[] required' });
    if (events.length > 1000) return res.status(413).json({ error: 'batch too large (max 1000)' });
    const result = await syncEngine.applyPush(events);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('sync push error:', e.message);
    res.status(500).json({ error: 'Failed to apply sync batch' });
  }
});

// Pull events after a cursor (down direction). Returns events + next cursor.
router.get('/offline/sync/pull', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, since = '0', limit = '200' } = req.query;
    if (!restaurantId) return res.status(400).json({ error: 'restaurantId required' });
    const result = await syncEngine.pullSince(restaurantId, parseInt(since) || 0, parseInt(limit) || 200);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('sync pull error:', e.message);
    res.status(500).json({ error: 'Failed to pull sync batch' });
  }
});

// ── Order numbering (Hub issues the real sequential number) ──
router.post('/offline/order-number/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { day } = req.body || {};
    if (!day) return res.status(400).json({ error: 'day (YYYY-MM-DD) required' });
    const seq = await numbering.issueDailyNumber(req.params.restaurantId, day);
    res.json({ success: true, seq });
  } catch (e) {
    console.error('order-number error:', e.message);
    res.status(500).json({ error: 'Failed to issue order number' });
  }
});

// ── Oversell log (manager reviews offline oversells) ──
router.get('/offline/oversells/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const rows = await stockReconcile.listOpenOversells(req.params.restaurantId);
    res.json({ success: true, oversells: rows });
  } catch (e) {
    console.error('oversell list error:', e.message);
    res.status(500).json({ error: 'Failed to list oversells' });
  }
});

router.post('/offline/oversells/:id/resolve', authenticateToken, async (req, res) => {
  try {
    await stockReconcile.resolveOversell(req.params.id);
    res.json({ success: true });
  } catch (e) {
    console.error('oversell resolve error:', e.message);
    res.status(500).json({ error: 'Failed to resolve oversell' });
  }
});

module.exports = router;
