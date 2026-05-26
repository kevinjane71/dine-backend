/**
 * Delivery Management Routes
 *
 * Handles delivery partner assignment, acceptance, location tracking,
 * status updates, and customer tracking. All endpoints (except public
 * tracking) require authentication.
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const deliveryService = require('../services/deliveryService');
const fcmService = require('../services/fcmService');
const realtimeService = require('../services/firebaseRealtimeService');

// ─── Public Route (no auth) ─────────────────────────────────────────────────

/**
 * GET /api/delivery/track/:trackingToken
 * Public customer tracking page data. No auth required.
 */
router.get('/track/:trackingToken', async (req, res) => {
  try {
    const { trackingToken } = req.params;
    const data = await deliveryService.getDeliveryByTrackingToken(trackingToken);

    if (!data) {
      return res.status(404).json({ success: false, error: 'Tracking link not found or expired' });
    }

    res.json({ success: true, data });
  } catch (err) {
    console.error('Delivery track error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch tracking data' });
  }
});

// ─── Authenticated Routes ───────────────────────────────────────────────────

router.use(authenticateToken);

/**
 * GET /api/delivery/:restaurantId/partners
 * List available delivery partners with their current status.
 */
router.get('/:restaurantId/partners', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const partners = await deliveryService.getDeliveryPartnersWithStatus(restaurantId);
    res.json({ success: true, data: partners });
  } catch (err) {
    console.error('Get delivery partners error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch delivery partners' });
  }
});

/**
 * GET /api/delivery/:restaurantId/active
 * List all active deliveries for a restaurant.
 */
router.get('/:restaurantId/active', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const deliveries = await deliveryService.getActiveDeliveries(restaurantId);
    res.json({ success: true, data: deliveries });
  } catch (err) {
    console.error('Get active deliveries error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch active deliveries' });
  }
});

/**
 * GET /api/delivery/:restaurantId/partner/:staffId/active
 * Get active deliveries for a specific delivery partner (used by mobile app).
 */
router.get('/:restaurantId/partner/:staffId/active', async (req, res) => {
  try {
    const { restaurantId, staffId } = req.params;
    const deliveries = await deliveryService.getPartnerActiveDelivery(restaurantId, staffId);
    res.json({ success: true, data: deliveries });
  } catch (err) {
    console.error('Get partner delivery error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch partner deliveries' });
  }
});

/**
 * GET /api/delivery/:restaurantId/settings
 * Get delivery feature settings for a restaurant.
 */
router.get('/:restaurantId/settings', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const settings = await deliveryService.getDeliverySettings(restaurantId);
    res.json({ success: true, data: settings });
  } catch (err) {
    console.error('Get delivery settings error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

/**
 * POST /api/delivery/:restaurantId/assign
 * Assign a delivery partner to an order. Admin/manager only.
 * Body: { orderId, staffId, staffName }
 */
router.post('/:restaurantId/assign', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { orderId, staffId, staffName } = req.body;

    if (!orderId || !staffId || !staffName) {
      return res.status(400).json({ success: false, error: 'orderId, staffId, and staffName are required' });
    }

    // Check feature flag
    const settings = await deliveryService.getDeliverySettings(restaurantId);
    if (!settings?.deliveryTrackingEnabled) {
      return res.status(403).json({ success: false, error: 'Delivery tracking is not enabled for this restaurant' });
    }

    const result = await deliveryService.assignDeliveryPartner(
      restaurantId, orderId, staffId, staffName, req.user
    );

    // Push RTDB status update
    await deliveryService.updateStatusInRTDB(restaurantId, orderId, 'assigned', staffName);

    // Send FCM push notification to delivery partner
    const token = await deliveryService.getStaffFcmToken(restaurantId, staffId);
    if (token) {
      await fcmService.sendToStaff(restaurantId, staffId, {
        type: 'delivery-assignment',
        title: 'New Delivery Assignment',
        body: `Order #${result.order.orderNumber} - ${result.order.deliveryAddress || 'Address pending'}`,
        orderId,
        orderNumber: String(result.order.orderNumber || ''),
        restaurantId,
        totalAmount: String(result.order.totalAmount || 0),
        deliveryAddress: typeof result.order.deliveryAddress === 'string'
          ? result.order.deliveryAddress
          : JSON.stringify(result.order.deliveryAddress || ''),
      });
    }

    // Notify restaurant via RTDB events
    await realtimeService.pushEvent(restaurantId, 'delivery', 'delivery-assigned', {
      orderId,
      staffId,
      staffName,
      orderNumber: result.order.orderNumber,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Delivery assign error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/delivery/:restaurantId/respond
 * Accept or reject a delivery assignment. Delivery partner only.
 * Body: { orderId, action: 'accept' | 'reject' }
 */
router.post('/:restaurantId/respond', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { orderId, action } = req.body;
    const staffId = req.user.staffId || req.user.userId || req.user.id;

    if (!orderId || !action) {
      return res.status(400).json({ success: false, error: 'orderId and action are required' });
    }

    const result = await deliveryService.respondToAssignment(restaurantId, orderId, staffId, action);

    // Update RTDB
    await deliveryService.updateStatusInRTDB(restaurantId, orderId, result.deliveryStatus, req.user.name || '');

    // Notify restaurant
    await realtimeService.pushEvent(restaurantId, 'delivery', `delivery-${action}ed`, {
      orderId,
      staffId,
      staffName: req.user.name || '',
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Delivery respond error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/delivery/:restaurantId/location-update
 * Receive GPS ping from delivery partner's device.
 * Body: { driverId, orderId, lat, lng, accuracy, speed, heading }
 */
router.post('/:restaurantId/location-update', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { driverId, orderId, lat, lng, accuracy, speed, heading } = req.body;

    if (!driverId || !orderId || lat == null || lng == null) {
      return res.status(400).json({ success: false, error: 'driverId, orderId, lat, lng are required' });
    }

    await deliveryService.updateLocation(restaurantId, driverId, orderId, {
      lat, lng, accuracy, speed, heading,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Location update error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update location' });
  }
});

/**
 * POST /api/delivery/:restaurantId/mark-picked-up
 * Delivery partner marks order as picked up from restaurant.
 * Body: { orderId }
 */
router.post('/:restaurantId/mark-picked-up', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { orderId } = req.body;
    const staffId = req.user.staffId || req.user.userId || req.user.id;

    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId is required' });
    }

    const result = await deliveryService.markPickedUp(restaurantId, orderId, staffId);

    // Update RTDB status
    await deliveryService.updateStatusInRTDB(restaurantId, orderId, 'picked_up', req.user.name || '');

    // Notify restaurant
    await realtimeService.pushEvent(restaurantId, 'delivery', 'delivery-picked-up', {
      orderId,
      staffId,
      staffName: req.user.name || '',
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Mark picked up error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/delivery/:restaurantId/mark-delivered
 * Delivery partner marks order as delivered.
 * Body: { orderId, paymentCollected: boolean, paymentMethod: string }
 */
router.post('/:restaurantId/mark-delivered', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { orderId, paymentCollected, paymentMethod } = req.body;
    const staffId = req.user.staffId || req.user.userId || req.user.id;

    if (!orderId) {
      return res.status(400).json({ success: false, error: 'orderId is required' });
    }

    const paymentInfo = {
      collected: paymentCollected || false,
      method: paymentMethod || 'cash',
    };

    const result = await deliveryService.markDelivered(restaurantId, orderId, staffId, paymentInfo);

    // Update RTDB status
    await deliveryService.updateStatusInRTDB(restaurantId, orderId, 'delivered', req.user.name || '');

    // Notify restaurant
    await realtimeService.pushEvent(restaurantId, 'delivery', 'delivery-completed', {
      orderId,
      staffId,
      staffName: req.user.name || '',
    });

    // Also fire order-status-updated for existing order listeners
    await realtimeService.notifyOrderStatusUpdated(restaurantId, orderId, 'completed', {
      orderNumber: result.orderNumber,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Mark delivered error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/delivery/:restaurantId/register-token
 * Register a delivery partner's FCM token for push notifications.
 * Body: { token, platform }
 */
router.post('/:restaurantId/register-token', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { token, platform } = req.body;
    const staffId = req.user.staffId || req.user.userId || req.user.id;

    if (!token) {
      return res.status(400).json({ success: false, error: 'FCM token is required' });
    }

    await deliveryService.registerStaffFcmToken(restaurantId, staffId, token, platform);
    res.json({ success: true, message: 'Token registered' });
  } catch (err) {
    console.error('Register token error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to register token' });
  }
});

module.exports = router;
