const { getRealtimeDb } = require('../firebase');
const fcmService = require('./fcmService');

/**
 * Firebase Realtime Database service — replaces Pusher for real-time events.
 *
 * Path structure:
 *   /events/{restaurantId}/orders/   — order lifecycle events
 *   /events/{restaurantId}/tables/   — table status events
 *   /events/{restaurantId}/menu/     — menu change events
 *   /events/{restaurantId}/kot/      — kitchen print requests
 *   /events/{restaurantId}/billing/  — billing print requests
 *
 * Each node: { type, ...payload, ts }
 * Clients subscribe to only the categories they need (cost-optimized).
 */

/**
 * Push an event to a specific category under a restaurant
 * @param {string} restaurantId
 * @param {string} category  — 'orders' | 'tables' | 'menu' | 'kot' | 'billing'
 * @param {string} eventType — e.g. 'order-created', 'table-status-updated'
 * @param {object} data      — event payload
 */
const pushEvent = async (restaurantId, category, eventType, data) => {
  try {
    const rtdb = getRealtimeDb();
    const eventsRef = rtdb.ref(`events/${restaurantId}/${category}`);
    await eventsRef.push({
      type: eventType,
      ...data,
      ts: Date.now()
    });
    console.log(`📡 RTDB: Event '${eventType}' pushed to events/${restaurantId}/${category}`);
  } catch (error) {
    console.error('📡 RTDB Error:', error.message);
    // Don't throw — realtime failures shouldn't break the main flow
  }
};

// ─── Order Events ────────────────────────────────────────────────────────────

const notifyOrderCreated = async (restaurantId, order) => {
  await pushEvent(restaurantId, 'orders', 'order-created', {
    orderId: order.id,
    orderNumber: order.orderNumber || order.dailyOrderId,
    status: order.status,
    totalAmount: order.totalAmount,
    tableNumber: order.tableNumber,
    tableId: order.tableId || null,
    floorId: order.floorId || null,
    orderType: order.orderType
  });

  // FCM push notification (unchanged — keep as-is)
  fcmService.sendToRestaurant(restaurantId, {
    type: 'new-order',
    title: `New ${order.orderType || 'Online'} Order #${order.orderNumber || order.dailyOrderId || ''}`,
    body: `${order.tableNumber ? 'Table ' + order.tableNumber + ' • ' : ''}${order.itemsCount || ''} items${order.totalAmount ? ' • \u20B9' + order.totalAmount : ''}`,
    orderId: order.id,
    dailyOrderId: order.dailyOrderId || order.orderNumber || '',
    orderType: order.orderType || 'online',
    tableNumber: order.tableNumber || '',
    totalAmount: order.totalAmount || 0,
  }).catch(err => console.warn('FCM web push error (non-blocking):', err.message));
};

const notifyOrderStatusUpdated = async (restaurantId, orderId, newStatus, orderData = {}) => {
  await pushEvent(restaurantId, 'orders', 'order-status-updated', {
    orderId,
    status: newStatus,
    orderNumber: orderData.orderNumber || orderData.dailyOrderId,
    totalAmount: orderData.totalAmount,
    tableNumber: orderData.tableNumber,
    tableId: orderData.tableId || null,
    floorId: orderData.floorId || null,
  });
};

const notifyOrderUpdated = async (restaurantId, orderId, orderData) => {
  await pushEvent(restaurantId, 'orders', 'order-updated', {
    orderId,
    status: orderData.status,
    orderNumber: orderData.orderNumber || orderData.dailyOrderId,
    totalAmount: orderData.totalAmount,
    itemsCount: orderData.items?.length || 0,
    tableNumber: orderData.tableNumber,
    tableId: orderData.tableId || null,
    floorId: orderData.floorId || null,
  });
};

const notifyOrderDeleted = async (restaurantId, orderId) => {
  await pushEvent(restaurantId, 'orders', 'order-deleted', { orderId });
};

// ─── KOT & Billing Print Events ─────────────────────────────────────────────

const notifyKOTPrintRequest = async (restaurantId, orderData) => {
  await pushEvent(restaurantId, 'kot', 'kot-print-request', {
    id: orderData.id,
    orderId: orderData.id,
    kotId: `KOT-${orderData.id.slice(-6).toUpperCase()}`,
    dailyOrderId: orderData.dailyOrderId,
    orderNumber: orderData.orderNumber,
    tableNumber: orderData.tableNumber || '',
    roomNumber: orderData.roomNumber || '',
    orderType: orderData.orderType || 'dine-in',
    itemsCount: orderData.items?.length || 0,
    createdAt: orderData.createdAt || new Date().toISOString(),
    isReprint: orderData.isReprint || false,
    forcePrint: orderData.forcePrint || false,
    printStationId: orderData.printStationId || null,
    printStationName: orderData.printStationName || null
  });

  fcmService.sendKOTPrintNotification(restaurantId, orderData)
    .catch(err => console.error('FCM KOT notify failed:', err.message));
};

const notifyBillingPrintRequest = async (restaurantId, orderData) => {
  const completedAt = orderData.completedAt || new Date();
  await pushEvent(restaurantId, 'billing', 'billing-print-request', {
    id: orderData.id,
    orderId: orderData.id,
    dailyOrderId: orderData.dailyOrderId,
    orderNumber: orderData.orderNumber,
    tableNumber: orderData.tableNumber || '',
    roomNumber: orderData.roomNumber || '',
    orderType: orderData.orderType || 'dine-in',
    itemsCount: orderData.items?.length || 0,
    totalAmount: orderData.finalAmount || orderData.totalAmount || 0,
    paymentMethod: orderData.paymentMethod || 'cash',
    createdAt: orderData.createdAt || new Date().toISOString(),
    completedAt: completedAt instanceof Date ? completedAt.toISOString() : completedAt
  });

  fcmService.sendBillingPrintNotification(restaurantId, orderData)
    .catch(err => console.error('FCM Bill notify failed:', err.message));
};

// ─── Menu Events ─────────────────────────────────────────────────────────────

const notifyMenuItemCreated = async (restaurantId, menuItem) => {
  await pushEvent(restaurantId, 'menu', 'menu-item-created', {
    itemId: menuItem.id,
    name: menuItem.name,
    category: menuItem.category,
  });
};

const notifyMenuUpdated = async (restaurantId, itemId, updatedFields) => {
  await pushEvent(restaurantId, 'menu', 'menu-updated', {
    itemId,
    updatedFields,
  });
};

const notifyMenuItemDeleted = async (restaurantId, itemId) => {
  await pushEvent(restaurantId, 'menu', 'menu-item-deleted', { itemId });
};

// ─── Table Events ────────────────────────────────────────────────────────────

/**
 * Trigger table-status-updated event (used by moveOrder.js and other places
 * that previously called pusher.trigger() directly)
 */
const triggerTableStatusUpdated = async (restaurantId, data) => {
  await pushEvent(restaurantId, 'tables', 'table-status-updated', data);
};

// ─── Cleanup (call via cron to keep storage costs near zero) ─────────────────

const cleanupOldEvents = async () => {
  try {
    const rtdb = getRealtimeDb();
    const eventsRef = rtdb.ref('events');
    const cutoff = Date.now() - (60 * 60 * 1000); // 1 hour ago

    const snapshot = await eventsRef.once('value');
    if (!snapshot.exists()) return;

    const updates = {};
    snapshot.forEach(restaurantSnap => {
      restaurantSnap.forEach(categorySnap => {
        categorySnap.forEach(eventSnap => {
          const event = eventSnap.val();
          if (event && event.ts && event.ts < cutoff) {
            updates[`${restaurantSnap.key}/${categorySnap.key}/${eventSnap.key}`] = null;
          }
        });
      });
    });

    if (Object.keys(updates).length > 0) {
      await eventsRef.update(updates);
      console.log(`🧹 RTDB cleanup: removed ${Object.keys(updates).length} old events`);
    }
  } catch (error) {
    console.error('🧹 RTDB cleanup error:', error.message);
  }
};

// ─── Delivery Events ────────────────────────────────────────────────────────

const notifyDeliveryAssigned = async (restaurantId, { orderId, staffId, staffName, orderNumber }) => {
  await pushEvent(restaurantId, 'delivery', 'delivery-assigned', {
    orderId,
    staffId,
    staffName,
    orderNumber,
  });
};

const notifyDeliveryStatusUpdated = async (restaurantId, { orderId, status, staffName }) => {
  await pushEvent(restaurantId, 'delivery', 'delivery-status-updated', {
    orderId,
    status,
    staffName,
  });
};

// ─── RTDB Security Rules Setup ───────────────────────────────────────────────

/**
 * Ensure RTDB security rules allow authenticated users to read events.
 * Call once on server startup. Safe to call multiple times.
 */
const ensureRtdbRules = async () => {
  try {
    const fbAdmin = require('firebase-admin');
    const adminDb = fbAdmin.database();

    const rules = {
      rules: {
        events: {
          $restaurantId: {
            '.read': true,    // Events are ephemeral, non-sensitive (order IDs + status only)
            '.write': false   // Only server (Admin SDK) writes
          }
        },
        '.read': false,
        '.write': false
      }
    };

    await adminDb.setRules(rules);
    console.log('✅ RTDB: Security rules set (public reads on events, server-only writes)');
  } catch (error) {
    // Non-fatal: rules might already be set, or we might not have permission
    console.warn('⚠️ RTDB: Could not set security rules:', error.message);
  }
};

module.exports = {
  pushEvent,
  ensureRtdbRules,
  triggerTableStatusUpdated,
  notifyOrderCreated,
  notifyOrderStatusUpdated,
  notifyOrderUpdated,
  notifyOrderDeleted,
  notifyKOTPrintRequest,
  notifyBillingPrintRequest,
  notifyMenuItemCreated,
  notifyMenuUpdated,
  notifyMenuItemDeleted,
  notifyDeliveryAssigned,
  notifyDeliveryStatusUpdated,
  cleanupOldEvents
};
