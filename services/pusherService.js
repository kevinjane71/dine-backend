/**
 * COMMENTED OUT — Replaced by firebaseRealtimeService.js (Firebase Realtime Database)
 * Kept for reference during migration. Safe to delete after verifying Firebase RTDB works.
 *
 * Original: Pusher-based real-time notification service
 */

/*
const Pusher = require('pusher');
const fcmService = require('./fcmService');

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '2108100',
  key: process.env.PUSHER_KEY || '4e1f74ae05c66bbc4eec',
  secret: process.env.PUSHER_SECRET || '0d6a5fa44c4a8db93541',
  cluster: process.env.PUSHER_CLUSTER || 'ap2',
  useTLS: true
});

const triggerOrderEvent = async (restaurantId, eventName, data) => {
  try {
    const channelName = `restaurant-${restaurantId}`;
    await pusher.trigger(channelName, eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Pusher Error:', error.message);
  }
};

const notifyOrderCreated = async (restaurantId, order) => {
  await triggerOrderEvent(restaurantId, 'order-created', {
    orderId: order.id,
    orderNumber: order.orderNumber || order.dailyOrderId,
    status: order.status,
    totalAmount: order.totalAmount,
    tableNumber: order.tableNumber,
    tableId: order.tableId || null,
    floorId: order.floorId || null,
    orderType: order.orderType
  });
  fcmService.sendToRestaurant(restaurantId, { ... }).catch(() => {});
};

const notifyOrderStatusUpdated = async (restaurantId, orderId, newStatus, orderData = {}) => { ... };
const notifyOrderUpdated = async (restaurantId, orderId, orderData) => { ... };
const notifyOrderDeleted = async (restaurantId, orderId) => { ... };
const notifyKOTPrintRequest = async (restaurantId, orderData) => { ... };
const notifyBillingPrintRequest = async (restaurantId, orderData) => { ... };
const notifyMenuItemCreated = async (restaurantId, menuItem) => { ... };
const notifyMenuUpdated = async (restaurantId, itemId, updatedFields) => { ... };
const notifyMenuItemDeleted = async (restaurantId, itemId) => { ... };

module.exports = {
  pusher, triggerOrderEvent,
  notifyOrderCreated, notifyOrderStatusUpdated, notifyOrderUpdated, notifyOrderDeleted,
  notifyKOTPrintRequest, notifyBillingPrintRequest,
  notifyMenuItemCreated, notifyMenuUpdated, notifyMenuItemDeleted
};
*/

// This file is no longer active. See firebaseRealtimeService.js
module.exports = {};
