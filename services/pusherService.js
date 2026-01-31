const Pusher = require('pusher');

// Initialize Pusher with environment variables
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '2108100',
  key: process.env.PUSHER_KEY || '4e1f74ae05c66bbc4eec',
  secret: process.env.PUSHER_SECRET || '0d6a5fa44c4a8db93541',
  cluster: process.env.PUSHER_CLUSTER || 'ap2',
  useTLS: true
});

/**
 * Trigger an event on a restaurant-specific channel
 * @param {string} restaurantId - The restaurant ID
 * @param {string} eventName - The event name (e.g., 'order-created', 'order-updated')
 * @param {object} data - The data to send with the event
 */
const triggerOrderEvent = async (restaurantId, eventName, data) => {
  try {
    const channelName = `restaurant-${restaurantId}`;
    await pusher.trigger(channelName, eventName, {
      ...data,
      timestamp: new Date().toISOString()
    });
    console.log(`📡 Pusher: Event '${eventName}' triggered on channel '${channelName}'`);
  } catch (error) {
    console.error('📡 Pusher Error:', error.message);
    // Don't throw - Pusher failures shouldn't break the main flow
  }
};

/**
 * Trigger when a new order is created
 */
const notifyOrderCreated = async (restaurantId, order) => {
  await triggerOrderEvent(restaurantId, 'order-created', {
    orderId: order.id,
    orderNumber: order.orderNumber || order.dailyOrderId,
    status: order.status,
    totalAmount: order.totalAmount,
    tableNumber: order.tableNumber,
    orderType: order.orderType
  });
};

/**
 * Trigger when order status is updated
 */
const notifyOrderStatusUpdated = async (restaurantId, orderId, newStatus, orderData = {}) => {
  await triggerOrderEvent(restaurantId, 'order-status-updated', {
    orderId,
    status: newStatus,
    orderNumber: orderData.orderNumber || orderData.dailyOrderId,
    totalAmount: orderData.totalAmount
  });
};

/**
 * Trigger when order is updated (items, amount, etc.)
 */
const notifyOrderUpdated = async (restaurantId, orderId, orderData) => {
  await triggerOrderEvent(restaurantId, 'order-updated', {
    orderId,
    status: orderData.status,
    orderNumber: orderData.orderNumber || orderData.dailyOrderId,
    totalAmount: orderData.totalAmount,
    itemsCount: orderData.items?.length || 0
  });
};

/**
 * Trigger when order is deleted/cancelled
 */
const notifyOrderDeleted = async (restaurantId, orderId) => {
  await triggerOrderEvent(restaurantId, 'order-deleted', {
    orderId
  });
};

/**
 * Trigger KOT print request for dine-kot-printer app
 * Used when an order is confirmed/sent to kitchen
 */
const notifyKOTPrintRequest = async (restaurantId, orderData) => {
  await triggerOrderEvent(restaurantId, 'kot-print-request', {
    id: orderData.id,
    kotId: `KOT-${orderData.id.slice(-6).toUpperCase()}`,
    dailyOrderId: orderData.dailyOrderId,
    orderNumber: orderData.orderNumber,
    tableNumber: orderData.tableNumber || '',
    roomNumber: orderData.roomNumber || '',
    items: orderData.items || [],
    notes: orderData.notes || '',
    staffInfo: orderData.staffInfo || {},
    orderType: orderData.orderType || 'dine-in',
    createdAt: orderData.createdAt || new Date().toISOString(),
    formattedTime: new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }),
    formattedDate: new Date().toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    })
  });
};

/**
 * Trigger Billing/Invoice print request for dine-kot-printer app
 * Used when billing is completed for an order
 */
const notifyBillingPrintRequest = async (restaurantId, orderData) => {
  const completedAt = orderData.completedAt || new Date();
  await triggerOrderEvent(restaurantId, 'billing-print-request', {
    id: orderData.id,
    orderId: orderData.id,
    dailyOrderId: orderData.dailyOrderId,
    orderNumber: orderData.orderNumber,
    tableNumber: orderData.tableNumber || '',
    roomNumber: orderData.roomNumber || '',
    customerName: orderData.customerName || orderData.customerInfo?.name || '',
    customerMobile: orderData.customerMobile || orderData.customerInfo?.phone || '',
    items: orderData.items || [],
    subtotal: orderData.totalAmount || 0,
    taxAmount: orderData.taxAmount || 0,
    taxBreakdown: orderData.taxBreakdown || [],
    totalAmount: orderData.finalAmount || orderData.totalAmount || 0,
    paymentMethod: orderData.paymentMethod || 'cash',
    orderType: orderData.orderType || 'dine-in',
    createdAt: orderData.createdAt || new Date().toISOString(),
    completedAt: completedAt instanceof Date ? completedAt.toISOString() : completedAt,
    formattedTime: new Date().toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }),
    formattedDate: new Date().toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    })
  });
};

module.exports = {
  pusher,
  triggerOrderEvent,
  notifyOrderCreated,
  notifyOrderStatusUpdated,
  notifyOrderUpdated,
  notifyOrderDeleted,
  notifyKOTPrintRequest,
  notifyBillingPrintRequest
};
