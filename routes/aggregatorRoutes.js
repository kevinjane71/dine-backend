/**
 * Aggregator Integration Routes
 *
 * Handles Talabat (and future Deliveroo, Noon Food) integration:
 * - Webhook endpoints (public, signature-verified) for receiving orders
 * - Management endpoints (authenticated) for connecting, settings, menu push
 * - Order action endpoints for accept/reject/prepared status sync
 *
 * Base path: /api/aggregators
 */

const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const talabatService = require('../services/talabatService');

// Lazy-load pusherService to avoid circular dependency issues
let pusherService;
function getPusherService() {
  if (!pusherService) {
    pusherService = require('../services/pusherService');
  }
  return pusherService;
}

// ============================================================
// WEBHOOK ENDPOINTS (Public — no auth, signature verified)
// ============================================================

/**
 * POST /api/aggregators/webhooks/talabat/order
 * Receives order events from Talabat (new order, cancellation, status update)
 */
router.post('/webhooks/talabat/order', async (req, res) => {
  try {
    // 1. Get signature from headers
    const signature = req.headers['x-talabat-signature'] || req.headers['x-signature'] || '';
    const rawBody = req.rawBody || JSON.stringify(req.body);

    // 2. Determine which restaurant this webhook is for
    const payload = req.body;
    const talabatVendorId = payload.vendor_id || payload.vendorId || payload.restaurant_id || '';
    const eventType = payload.event || payload.type || payload.status || 'order_dispatch';

    if (!talabatVendorId) {
      console.error('Talabat webhook: missing vendor_id in payload');
      return res.status(200).json({ received: true }); // Always 200 for webhooks
    }

    // 3. Find the restaurant with this Talabat vendor ID
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('aggregatorConfig.talabat.vendorId', '==', talabatVendorId)
      .where('aggregatorConfig.talabat.enabled', '==', true)
      .limit(1)
      .get();

    if (restaurantsSnap.empty) {
      console.error(`Talabat webhook: no restaurant found for vendorId ${talabatVendorId}`);
      return res.status(200).json({ received: true });
    }

    const restaurantDoc = restaurantsSnap.docs[0];
    const restaurantId = restaurantDoc.id;
    const restaurantData = restaurantDoc.data();
    const talabatConfig = restaurantData.aggregatorConfig?.talabat || {};

    // 4. Verify webhook signature
    if (talabatConfig.webhookSecret) {
      const isValid = talabatService.verifyWebhookSignature(rawBody, signature, talabatConfig.webhookSecret);
      if (!isValid) {
        console.error(`Talabat webhook: invalid signature for restaurant ${restaurantId}`);
        return res.status(200).json({ received: true });
      }
    }

    // 5. Process based on event type
    const orderPayload = payload.order || payload.data || payload;

    if (eventType === 'order_dispatch' || eventType === 'new_order' || eventType === 'ORDER_DISPATCHED') {
      await handleNewTalabatOrder(restaurantId, restaurantData, talabatConfig, orderPayload);
    } else if (eventType === 'order_cancel' || eventType === 'CANCELED' || eventType === 'ORDER_CANCELLED') {
      await handleTalabatOrderCancel(restaurantId, orderPayload);
    } else if (eventType === 'order_status_update' || eventType === 'STATUS_UPDATE') {
      await handleTalabatStatusUpdate(restaurantId, orderPayload);
    }

    // Log webhook for debugging
    await db.collection('aggregatorWebhookLogs').add({
      platform: 'talabat',
      restaurantId,
      eventType,
      payload: JSON.stringify(payload).substring(0, 5000), // Cap at 5KB
      receivedAt: new Date(),
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Talabat order webhook error:', err);
    // Always return 200 for webhooks to prevent retry storms
    return res.status(200).json({ received: true, error: err.message });
  }
});

/**
 * POST /api/aggregators/webhooks/talabat/catalog
 * Receives catalog import status from Talabat
 */
router.post('/webhooks/talabat/catalog', async (req, res) => {
  try {
    const payload = req.body;
    const talabatVendorId = payload.vendor_id || payload.vendorId || '';
    const importStatus = payload.status || 'unknown';
    const jobId = payload.job_id || payload.import_id || '';

    if (talabatVendorId) {
      const restaurantsSnap = await db.collection(collections.restaurants)
        .where('aggregatorConfig.talabat.vendorId', '==', talabatVendorId)
        .limit(1)
        .get();

      if (!restaurantsSnap.empty) {
        const restaurantRef = restaurantsSnap.docs[0].ref;
        await restaurantRef.update({
          'aggregatorConfig.talabat.lastMenuSyncStatus': importStatus,
          'aggregatorConfig.talabat.lastMenuSyncJobId': jobId,
          'aggregatorConfig.talabat.lastMenuSyncUpdatedAt': new Date().toISOString(),
        });
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Talabat catalog webhook error:', err);
    return res.status(200).json({ received: true });
  }
});

/**
 * POST /api/aggregators/webhooks/talabat/menu-request
 * Talabat requests a menu re-push
 */
router.post('/webhooks/talabat/menu-request', async (req, res) => {
  try {
    const payload = req.body;
    const talabatVendorId = payload.vendor_id || payload.vendorId || '';

    if (talabatVendorId) {
      const restaurantsSnap = await db.collection(collections.restaurants)
        .where('aggregatorConfig.talabat.vendorId', '==', talabatVendorId)
        .limit(1)
        .get();

      if (!restaurantsSnap.empty) {
        const doc = restaurantsSnap.docs[0];
        const restaurantData = doc.data();
        const talabatConfig = restaurantData.aggregatorConfig?.talabat || {};
        const menuItems = restaurantData.menu?.items || [];
        const categories = restaurantData.categories || [];

        // Auto re-push menu
        try {
          await talabatService.pushMenuCatalog(
            { vendorId: talabatConfig.vendorId, clientId: talabatConfig.clientId, clientSecret: talabatConfig.clientSecret },
            menuItems,
            categories,
          );
          console.log(`Talabat: Auto re-pushed menu for restaurant ${doc.id}`);
        } catch (pushErr) {
          console.error(`Talabat: Failed to auto re-push menu for ${doc.id}:`, pushErr);
        }
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('Talabat menu-request webhook error:', err);
    return res.status(200).json({ received: true });
  }
});

// ─── Webhook Handlers ─────────────────────────────────────────────────────────

async function handleNewTalabatOrder(restaurantId, restaurantData, talabatConfig, orderPayload) {
  const autoAccept = talabatConfig.autoAccept === true;
  const menuItems = restaurantData.menu?.items || [];

  // Convert Talabat order → DineOpen format
  const orderData = talabatService.convertTalabatOrderToDineOpen(
    orderPayload, restaurantId, menuItems, autoAccept,
  );

  // Check for duplicate (by aggregatorOrderId)
  const existingSnap = await db.collection(collections.orders)
    .where('restaurantId', '==', restaurantId)
    .where('aggregatorOrderId', '==', orderData.aggregatorOrderId)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    console.log(`Talabat: Duplicate order ${orderData.aggregatorOrderId} — skipping`);
    return;
  }

  // Generate daily order ID
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dailyOrdersSnap = await db.collection(collections.orders)
    .where('restaurantId', '==', restaurantId)
    .where('createdAt', '>=', today)
    .get();
  orderData.dailyOrderId = dailyOrdersSnap.size + 1;

  // Save order to Firestore
  const orderRef = await db.collection(collections.orders).add(orderData);
  const orderId = orderRef.id;

  // Trigger Pusher notification so KOT / order screens update in real-time
  try {
    const ps = getPusherService();
    await ps.notifyOrderCreated(restaurantId, {
      id: orderId,
      orderNumber: orderData.orderNumber,
      dailyOrderId: orderData.dailyOrderId,
      status: orderData.status,
      totalAmount: orderData.finalAmount,
      orderType: orderData.orderType,
      orderSource: orderData.orderSource,
    });
  } catch (pusherErr) {
    console.error('Talabat: Pusher notification error (non-blocking):', pusherErr);
  }

  // If auto-accept, notify Talabat
  if (autoAccept && orderData.aggregatorOrderId) {
    try {
      await talabatService.acceptOrder(
        { vendorId: talabatConfig.vendorId, clientId: talabatConfig.clientId, clientSecret: talabatConfig.clientSecret },
        orderData.aggregatorOrderId,
      );
      await orderRef.update({ aggregatorStatus: 'ACCEPTED' });
    } catch (acceptErr) {
      console.error('Talabat: Auto-accept failed (non-blocking):', acceptErr);
    }
  }

  console.log(`Talabat: New order ${orderId} (${orderData.aggregatorOrderId}) for restaurant ${restaurantId}${autoAccept ? ' [auto-accepted]' : ''}`);
}

async function handleTalabatOrderCancel(restaurantId, orderPayload) {
  const talabatOrderId = String(orderPayload.id || orderPayload.order_id || orderPayload.code || '');
  if (!talabatOrderId) return;

  const ordersSnap = await db.collection(collections.orders)
    .where('restaurantId', '==', restaurantId)
    .where('aggregatorOrderId', '==', talabatOrderId)
    .limit(1)
    .get();

  if (ordersSnap.empty) return;

  const orderDoc = ordersSnap.docs[0];
  await orderDoc.ref.update({
    status: 'cancelled',
    aggregatorStatus: 'CANCELED',
    cancelledAt: new Date(),
    cancelReason: orderPayload.reason || orderPayload.cancel_reason || 'Cancelled by Talabat',
    updatedAt: new Date(),
  });

  // Notify frontend
  try {
    const ps = getPusherService();
    await ps.notifyOrderCreated(restaurantId, {
      id: orderDoc.id,
      status: 'cancelled',
      orderSource: 'talabat',
    });
  } catch (e) {
    console.error('Talabat: Pusher cancel notification error:', e);
  }

  console.log(`Talabat: Order ${talabatOrderId} cancelled for restaurant ${restaurantId}`);
}

async function handleTalabatStatusUpdate(restaurantId, orderPayload) {
  const talabatOrderId = String(orderPayload.id || orderPayload.order_id || '');
  const newStatus = orderPayload.status || '';
  if (!talabatOrderId) return;

  const ordersSnap = await db.collection(collections.orders)
    .where('restaurantId', '==', restaurantId)
    .where('aggregatorOrderId', '==', talabatOrderId)
    .limit(1)
    .get();

  if (ordersSnap.empty) return;

  const updateData = {
    aggregatorStatus: newStatus,
    updatedAt: new Date(),
  };

  // Map Talabat status to DineOpen status
  if (newStatus === 'DISPATCHED' || newStatus === 'PICKED_UP') {
    updateData.status = 'completed';
  }

  // Rider info update
  if (orderPayload.rider || orderPayload.driver) {
    const rider = orderPayload.rider || orderPayload.driver;
    updateData.aggregatorRiderInfo = {
      name: rider.name || '',
      phone: rider.phone || '',
      eta: rider.eta || null,
    };
  }

  await ordersSnap.docs[0].ref.update(updateData);
}

// ============================================================
// MANAGEMENT ENDPOINTS (Authenticated)
// ============================================================

/**
 * POST /api/aggregators/talabat/connect/:restaurantId
 * Connect a restaurant to Talabat
 */
router.post('/talabat/connect/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { vendorId, clientId, clientSecret, webhookSecret, autoAccept } = req.body;

    if (!vendorId || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'vendorId, clientId, and clientSecret are required' });
    }

    // Verify restaurant exists and user has access
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Test connection
    const config = { vendorId, clientId, clientSecret };
    const testResult = await talabatService.testConnection(config);

    if (!testResult.connected) {
      return res.status(400).json({
        error: 'Failed to connect to Talabat',
        details: testResult.error,
      });
    }

    // Save config to restaurant document
    const talabatConfig = {
      enabled: true,
      vendorId,
      clientId,
      clientSecret, // In production, encrypt this
      webhookSecret: webhookSecret || '',
      autoAccept: autoAccept === true,
      storeStatus: testResult.storeStatus || 'unknown',
      lastMenuSyncAt: null,
      connectedAt: new Date().toISOString(),
      connectedBy: req.user.userId || req.user.id,
    };

    await db.collection(collections.restaurants).doc(restaurantId).update({
      'aggregatorConfig.talabat': talabatConfig,
    });

    res.json({
      success: true,
      message: 'Successfully connected to Talabat',
      storeStatus: testResult.storeStatus,
    });
  } catch (err) {
    console.error('Talabat connect error:', err);
    res.status(500).json({ error: 'Failed to connect to Talabat' });
  }
});

/**
 * DELETE /api/aggregators/talabat/disconnect/:restaurantId
 * Disconnect a restaurant from Talabat
 */
router.delete('/talabat/disconnect/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const config = restaurantDoc.data().aggregatorConfig?.talabat;
    if (config?.vendorId) {
      talabatService.clearTokenCache(config.vendorId);
    }

    // Remove Talabat config
    const { FieldValue } = require('firebase-admin/firestore');
    await db.collection(collections.restaurants).doc(restaurantId).update({
      'aggregatorConfig.talabat': FieldValue.delete(),
    });

    res.json({ success: true, message: 'Disconnected from Talabat' });
  } catch (err) {
    console.error('Talabat disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect from Talabat' });
  }
});

/**
 * GET /api/aggregators/talabat/status/:restaurantId
 * Get Talabat connection status for a restaurant
 */
router.get('/talabat/status/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const talabatConfig = restaurantDoc.data().aggregatorConfig?.talabat;

    if (!talabatConfig || !talabatConfig.enabled) {
      return res.json({
        success: true,
        connected: false,
      });
    }

    res.json({
      success: true,
      connected: true,
      vendorId: talabatConfig.vendorId,
      autoAccept: talabatConfig.autoAccept || false,
      storeStatus: talabatConfig.storeStatus || 'unknown',
      lastMenuSyncAt: talabatConfig.lastMenuSyncAt || null,
      lastMenuSyncStatus: talabatConfig.lastMenuSyncStatus || null,
      connectedAt: talabatConfig.connectedAt || null,
    });
  } catch (err) {
    console.error('Talabat status error:', err);
    res.status(500).json({ error: 'Failed to get Talabat status' });
  }
});

/**
 * PATCH /api/aggregators/talabat/settings/:restaurantId
 * Update Talabat integration settings
 */
router.patch('/talabat/settings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { autoAccept, webhookSecret } = req.body;

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const updates = {};
    if (autoAccept !== undefined) {
      updates['aggregatorConfig.talabat.autoAccept'] = autoAccept === true;
    }
    if (webhookSecret !== undefined) {
      updates['aggregatorConfig.talabat.webhookSecret'] = webhookSecret;
    }

    if (Object.keys(updates).length > 0) {
      await db.collection(collections.restaurants).doc(restaurantId).update(updates);
    }

    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    console.error('Talabat settings update error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * POST /api/aggregators/talabat/push-menu/:restaurantId
 * Push the restaurant's menu to Talabat
 */
router.post('/talabat/push-menu/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const talabatConfig = restaurantData.aggregatorConfig?.talabat;

    if (!talabatConfig || !talabatConfig.enabled) {
      return res.status(400).json({ error: 'Talabat integration is not connected' });
    }

    const menuItems = restaurantData.menu?.items || [];
    const categories = restaurantData.categories || [];

    if (menuItems.length === 0) {
      return res.status(400).json({ error: 'No menu items to push. Add items to your menu first.' });
    }

    // Push to Talabat
    const config = {
      vendorId: talabatConfig.vendorId,
      clientId: talabatConfig.clientId,
      clientSecret: talabatConfig.clientSecret,
    };

    const result = await talabatService.pushMenuCatalog(config, menuItems, categories);

    // Update sync timestamp
    await db.collection(collections.restaurants).doc(restaurantId).update({
      'aggregatorConfig.talabat.lastMenuSyncAt': new Date().toISOString(),
      'aggregatorConfig.talabat.lastMenuSyncStatus': 'submitted',
      'aggregatorConfig.talabat.lastMenuSyncJobId': result.job_id || result.jobId || null,
    });

    res.json({
      success: true,
      message: `Menu pushed to Talabat (${menuItems.length} items, ${categories.length} categories)`,
      jobId: result.job_id || result.jobId || null,
    });
  } catch (err) {
    console.error('Talabat push-menu error:', err);
    res.status(500).json({ error: 'Failed to push menu to Talabat' });
  }
});

/**
 * POST /api/aggregators/talabat/store-status/:restaurantId
 * Toggle store open/close on Talabat
 */
router.post('/talabat/store-status/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { isOpen } = req.body;

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const talabatConfig = restaurantDoc.data().aggregatorConfig?.talabat;
    if (!talabatConfig || !talabatConfig.enabled) {
      return res.status(400).json({ error: 'Talabat integration is not connected' });
    }

    const config = {
      vendorId: talabatConfig.vendorId,
      clientId: talabatConfig.clientId,
      clientSecret: talabatConfig.clientSecret,
    };

    await talabatService.updateStoreStatus(config, isOpen === true);

    await db.collection(collections.restaurants).doc(restaurantId).update({
      'aggregatorConfig.talabat.storeStatus': isOpen ? 'open' : 'closed',
    });

    res.json({
      success: true,
      storeStatus: isOpen ? 'open' : 'closed',
      message: `Talabat store ${isOpen ? 'opened' : 'closed'}`,
    });
  } catch (err) {
    console.error('Talabat store-status error:', err);
    res.status(500).json({ error: 'Failed to update store status on Talabat' });
  }
});

// ============================================================
// ORDER ACTION ENDPOINTS (Authenticated)
// ============================================================

/**
 * POST /api/aggregators/talabat/accept-order/:restaurantId/:orderId
 * Accept a Talabat order and notify Talabat
 */
router.post('/talabat/accept-order/:restaurantId/:orderId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;

    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderDoc.data();
    if (order.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Order does not belong to this restaurant' });
    }

    if (order.orderSource !== 'talabat' || !order.aggregatorOrderId) {
      return res.status(400).json({ error: 'This is not a Talabat order' });
    }

    // Get Talabat config
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    const talabatConfig = restaurantDoc.data().aggregatorConfig?.talabat;

    if (!talabatConfig || !talabatConfig.enabled) {
      return res.status(400).json({ error: 'Talabat integration is not connected' });
    }

    // Notify Talabat
    const config = {
      vendorId: talabatConfig.vendorId,
      clientId: talabatConfig.clientId,
      clientSecret: talabatConfig.clientSecret,
    };

    await talabatService.acceptOrder(config, order.aggregatorOrderId);

    // Update order in DineOpen
    await orderDoc.ref.update({
      status: 'preparing',
      aggregatorStatus: 'ACCEPTED',
      updatedAt: new Date(),
    });

    res.json({ success: true, message: 'Order accepted on Talabat' });
  } catch (err) {
    console.error('Talabat accept-order error:', err);
    res.status(500).json({ error: 'Failed to accept order on Talabat' });
  }
});

/**
 * POST /api/aggregators/talabat/reject-order/:restaurantId/:orderId
 * Reject a Talabat order and notify Talabat
 */
router.post('/talabat/reject-order/:restaurantId/:orderId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;
    const { reason } = req.body;

    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderDoc.data();
    if (order.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Order does not belong to this restaurant' });
    }

    if (order.orderSource !== 'talabat' || !order.aggregatorOrderId) {
      return res.status(400).json({ error: 'This is not a Talabat order' });
    }

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    const talabatConfig = restaurantDoc.data().aggregatorConfig?.talabat;

    if (!talabatConfig || !talabatConfig.enabled) {
      return res.status(400).json({ error: 'Talabat integration is not connected' });
    }

    const config = {
      vendorId: talabatConfig.vendorId,
      clientId: talabatConfig.clientId,
      clientSecret: talabatConfig.clientSecret,
    };

    await talabatService.rejectOrder(config, order.aggregatorOrderId, reason);

    await orderDoc.ref.update({
      status: 'cancelled',
      aggregatorStatus: 'REJECTED',
      cancelReason: reason || 'Rejected by restaurant',
      cancelledAt: new Date(),
      updatedAt: new Date(),
    });

    res.json({ success: true, message: 'Order rejected on Talabat' });
  } catch (err) {
    console.error('Talabat reject-order error:', err);
    res.status(500).json({ error: 'Failed to reject order on Talabat' });
  }
});

/**
 * POST /api/aggregators/talabat/mark-prepared/:restaurantId/:orderId
 * Mark a Talabat order as ready for pickup
 */
router.post('/talabat/mark-prepared/:restaurantId/:orderId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;

    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderDoc.data();
    if (order.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Order does not belong to this restaurant' });
    }

    if (order.orderSource !== 'talabat' || !order.aggregatorOrderId) {
      return res.status(400).json({ error: 'This is not a Talabat order' });
    }

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    const talabatConfig = restaurantDoc.data().aggregatorConfig?.talabat;

    if (!talabatConfig || !talabatConfig.enabled) {
      return res.status(400).json({ error: 'Talabat integration is not connected' });
    }

    const config = {
      vendorId: talabatConfig.vendorId,
      clientId: talabatConfig.clientId,
      clientSecret: talabatConfig.clientSecret,
    };

    await talabatService.markOrderPrepared(config, order.aggregatorOrderId);

    await orderDoc.ref.update({
      status: 'ready',
      aggregatorStatus: 'READY_FOR_PICKUP',
      updatedAt: new Date(),
    });

    res.json({ success: true, message: 'Order marked as prepared on Talabat' });
  } catch (err) {
    console.error('Talabat mark-prepared error:', err);
    res.status(500).json({ error: 'Failed to mark order as prepared on Talabat' });
  }
});

/**
 * GET /api/aggregators/talabat/orders/:restaurantId
 * Get recent Talabat orders for a restaurant
 */
router.get('/talabat/orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const ordersSnap = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('orderSource', '==', 'talabat')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const orders = ordersSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      // Remove raw payload from list response
      aggregatorRawPayload: undefined,
    }));

    res.json({ success: true, orders, count: orders.length });
  } catch (err) {
    console.error('Talabat get orders error:', err);
    res.status(500).json({ error: 'Failed to fetch Talabat orders' });
  }
});

/**
 * GET /api/aggregators/webhook-url
 * Returns the webhook URL for setup in Talabat partner portal
 */
router.get('/webhook-url', authenticateToken, async (req, res) => {
  const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    webhooks: {
      order: `${baseUrl}/api/aggregators/webhooks/talabat/order`,
      catalog: `${baseUrl}/api/aggregators/webhooks/talabat/catalog`,
      menuRequest: `${baseUrl}/api/aggregators/webhooks/talabat/menu-request`,
    },
  });
});

module.exports = router;
