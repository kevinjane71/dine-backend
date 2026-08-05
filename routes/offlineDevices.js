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

module.exports = router;
