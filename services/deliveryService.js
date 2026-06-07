/**
 * Delivery Management Service
 *
 * Business logic for the delivery partner assignment, tracking, and
 * status management flow. Works with Firestore for order state and
 * Firebase RTDB for real-time location streaming.
 */

const { getDb, getRealtimeDb, collections } = require('../firebase');
const crypto = require('crypto');

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateTrackingToken() {
  return crypto.randomBytes(16).toString('hex');
}

function isAdminRole(role) {
  return ['owner', 'admin', 'manager'].includes(role);
}

// ─── Restaurant Feature Checks ──────────────────────────────────────────────

/**
 * Check if a restaurant has delivery tracking enabled.
 * Returns the delivery settings object or null if disabled.
 */
async function getDeliverySettings(restaurantId) {
  const db = getDb();
  const doc = await db.collection(collections.restaurants).doc(restaurantId).get();
  if (!doc.exists) return null;

  const data = doc.data();
  const settings = {
    deliveryTrackingEnabled: data.deliveryTrackingEnabled || false,
    deliveryRealtimeTracking: data.deliveryRealtimeTracking || false,
  };
  return settings;
}

// ─── Delivery Partners ──────────────────────────────────────────────────────

/**
 * Get all staff marked as delivery partners for a restaurant.
 */
async function getDeliveryPartners(restaurantId) {
  const db = getDb();
  const snap = await db
    .collection(collections.staffUsers)
    .where('restaurantId', '==', restaurantId)
    .where('isDeliveryPartner', '==', true)
    .where('status', '==', 'active')
    .select('name', 'phone', 'role')
    .limit(200)
    .get();

  return snap.docs.map(doc => ({
    id: doc.id,
    name: doc.data().name,
    phone: doc.data().phone,
    role: doc.data().role,
  }));
}

/**
 * Check the active delivery status of each partner to show availability.
 */
async function getDeliveryPartnersWithStatus(restaurantId) {
  const partners = await getDeliveryPartners(restaurantId);
  if (partners.length === 0) return [];

  const db = getDb();
  // Find orders with active deliveries for these partners
  const activeStatuses = ['assigned', 'accepted', 'picked_up', 'on_the_way'];
  const activeSnap = await db
    .collection(collections.orders)
    .where('restaurantId', '==', restaurantId)
    .where('deliveryStatus', 'in', activeStatuses)
    .select('assignedStaff')
    .limit(500)
    .get();

  const busyPartnerIds = new Set();
  activeSnap.docs.forEach(doc => {
    const data = doc.data();
    if (data.assignedStaff?.id) {
      busyPartnerIds.add(data.assignedStaff.id);
    }
  });

  return partners.map(p => ({
    ...p,
    status: busyPartnerIds.has(p.id) ? 'busy' : 'available',
  }));
}

// ─── Assignment ─────────────────────────────────────────────────────────────

/**
 * Assign a delivery partner to an order.
 * Sets deliveryStatus to 'assigned', generates tracking token.
 */
async function assignDeliveryPartner(restaurantId, orderId, staffId, staffName, assignedBy) {
  const db = getDb();
  const orderRef = db.collection(collections.orders).doc(orderId);
  const orderDoc = await orderRef.get();

  if (!orderDoc.exists) {
    throw new Error('Order not found');
  }

  const order = orderDoc.data();
  if (order.restaurantId !== restaurantId) {
    throw new Error('Order does not belong to this restaurant');
  }

  if (order.deliveryStatus && !['rejected'].includes(order.deliveryStatus)) {
    throw new Error(`Order already has delivery status: ${order.deliveryStatus}`);
  }

  const trackingToken = generateTrackingToken();
  const now = new Date().toISOString();

  await orderRef.update({
    deliveryStatus: 'assigned',
    assignedStaff: { id: staffId, name: staffName },
    deliveryAssignedAt: now,
    deliveryTrackingToken: trackingToken,
    updatedAt: now,
  });

  return {
    orderId,
    staffId,
    staffName,
    deliveryStatus: 'assigned',
    deliveryTrackingToken: trackingToken,
    deliveryAssignedAt: now,
    order: {
      id: orderId,
      orderNumber: order.orderNumber || order.dailyOrderId,
      orderType: order.orderType,
      items: order.items,
      totalAmount: order.finalAmount || order.totalAmount,
      customerInfo: order.customerInfo,
      deliveryAddress: order.deliveryAddress,
      deliveryInfo: order.deliveryInfo,
      restaurantId,
    },
  };
}

// ─── Accept / Reject ────────────────────────────────────────────────────────

/**
 * Delivery partner accepts or rejects an assignment.
 */
async function respondToAssignment(restaurantId, orderId, staffId, action) {
  const db = getDb();
  const orderRef = db.collection(collections.orders).doc(orderId);
  const orderDoc = await orderRef.get();

  if (!orderDoc.exists) throw new Error('Order not found');

  const order = orderDoc.data();
  if (order.restaurantId !== restaurantId) throw new Error('Order mismatch');
  if (order.assignedStaff?.id !== staffId) throw new Error('Not assigned to you');
  if (order.deliveryStatus !== 'assigned') {
    throw new Error(`Cannot respond to delivery with status: ${order.deliveryStatus}`);
  }

  const now = new Date().toISOString();

  if (action === 'accept') {
    await orderRef.update({
      deliveryStatus: 'accepted',
      deliveryAcceptedAt: now,
      updatedAt: now,
    });
    return { orderId, deliveryStatus: 'accepted' };
  } else if (action === 'reject') {
    await orderRef.update({
      deliveryStatus: 'rejected',
      assignedStaff: null,
      deliveryAssignedAt: null,
      updatedAt: now,
    });
    return { orderId, deliveryStatus: 'rejected' };
  } else {
    throw new Error('Invalid action. Use "accept" or "reject"');
  }
}

// ─── Status Transitions ─────────────────────────────────────────────────────

/**
 * Mark order as picked up by delivery partner.
 */
async function markPickedUp(restaurantId, orderId, staffId) {
  const db = getDb();
  const orderRef = db.collection(collections.orders).doc(orderId);
  const orderDoc = await orderRef.get();

  if (!orderDoc.exists) throw new Error('Order not found');
  const order = orderDoc.data();
  if (order.restaurantId !== restaurantId) throw new Error('Order mismatch');
  if (order.assignedStaff?.id !== staffId) throw new Error('Not assigned to you');
  if (order.deliveryStatus !== 'accepted') {
    throw new Error(`Cannot pick up order with status: ${order.deliveryStatus}`);
  }

  const now = new Date().toISOString();
  await orderRef.update({
    deliveryStatus: 'picked_up',
    deliveryPickedUpAt: now,
    updatedAt: now,
  });

  return { orderId, deliveryStatus: 'picked_up' };
}

/**
 * Mark order as delivered. Completes the delivery and optionally marks bill as paid.
 */
async function markDelivered(restaurantId, orderId, staffId, paymentInfo = {}) {
  const db = getDb();
  const orderRef = db.collection(collections.orders).doc(orderId);
  const orderDoc = await orderRef.get();

  if (!orderDoc.exists) throw new Error('Order not found');
  const order = orderDoc.data();
  if (order.restaurantId !== restaurantId) throw new Error('Order mismatch');
  if (order.assignedStaff?.id !== staffId) throw new Error('Not assigned to you');
  if (!['accepted', 'picked_up'].includes(order.deliveryStatus)) {
    throw new Error(`Cannot mark delivered with status: ${order.deliveryStatus}`);
  }

  const now = new Date().toISOString();
  const updateData = {
    deliveryStatus: 'delivered',
    deliveryCompletedAt: now,
    status: 'completed',
    updatedAt: now,
    completedAt: now,
  };

  // If payment collected on delivery
  if (paymentInfo.collected) {
    updateData.paymentStatus = 'paid';
    updateData.paymentMethod = paymentInfo.method || 'cash';
    updateData.paidAmount = order.finalAmount || order.totalAmount;
  }

  await orderRef.update(updateData);

  // Clean up RTDB location data
  try {
    const rtdb = getRealtimeDb();
    await rtdb.ref(`delivery/${restaurantId}/${orderId}`).remove();
  } catch (err) {
    console.warn('RTDB delivery cleanup failed:', err.message);
  }

  return { orderId, deliveryStatus: 'delivered', status: 'completed' };
}

// ─── Location Update ────────────────────────────────────────────────────────

/**
 * Store delivery partner's location in RTDB for real-time streaming.
 */
async function updateLocation(restaurantId, driverId, orderId, location) {
  const rtdb = getRealtimeDb();
  const locationData = {
    lat: location.lat,
    lng: location.lng,
    accuracy: location.accuracy || null,
    speed: location.speed || null,
    heading: location.heading || null,
    timestamp: Date.now(),
    driverId,
  };

  // Overwrite (not push) — always latest location only
  await rtdb.ref(`delivery/${restaurantId}/${orderId}/location`).set(locationData);

  return { success: true };
}

/**
 * Update delivery status in RTDB for real-time listeners (customer tracking page).
 */
async function updateStatusInRTDB(restaurantId, orderId, status, driverName) {
  const rtdb = getRealtimeDb();
  await rtdb.ref(`delivery/${restaurantId}/${orderId}/status`).set({
    status,
    driverName: driverName || '',
    updatedAt: Date.now(),
  });
}

// ─── Active Deliveries ──────────────────────────────────────────────────────

/**
 * Get all active deliveries for a restaurant.
 */
async function getActiveDeliveries(restaurantId) {
  const db = getDb();
  const activeStatuses = ['assigned', 'accepted', 'picked_up', 'on_the_way'];
  const snap = await db
    .collection(collections.orders)
    .where('restaurantId', '==', restaurantId)
    .where('deliveryStatus', 'in', activeStatuses)
    .orderBy('deliveryAssignedAt', 'desc')
    .limit(200)
    .get();

  return snap.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      orderNumber: data.orderNumber || data.dailyOrderId,
      deliveryStatus: data.deliveryStatus,
      assignedStaff: data.assignedStaff,
      deliveryAddress: data.deliveryAddress,
      deliveryInfo: data.deliveryInfo,
      customerInfo: data.customerInfo,
      totalAmount: data.finalAmount || data.totalAmount,
      items: data.items,
      deliveryAssignedAt: data.deliveryAssignedAt,
      deliveryAcceptedAt: data.deliveryAcceptedAt,
      deliveryPickedUpAt: data.deliveryPickedUpAt,
      deliveryTrackingToken: data.deliveryTrackingToken,
      createdAt: data.createdAt,
    };
  });
}

/**
 * Get active delivery for a specific partner (used by app).
 */
async function getPartnerActiveDelivery(restaurantId, staffId) {
  const db = getDb();
  const activeStatuses = ['assigned', 'accepted', 'picked_up', 'on_the_way'];
  const snap = await db
    .collection(collections.orders)
    .where('restaurantId', '==', restaurantId)
    .where('assignedStaff.id', '==', staffId)
    .where('deliveryStatus', 'in', activeStatuses)
    .limit(5)
    .get();

  return snap.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      orderNumber: data.orderNumber || data.dailyOrderId,
      deliveryStatus: data.deliveryStatus,
      deliveryAddress: data.deliveryAddress,
      deliveryInfo: data.deliveryInfo,
      customerInfo: data.customerInfo,
      totalAmount: data.finalAmount || data.totalAmount,
      items: data.items,
      deliveryAssignedAt: data.deliveryAssignedAt,
      deliveryAcceptedAt: data.deliveryAcceptedAt,
      deliveryPickedUpAt: data.deliveryPickedUpAt,
      deliveryTrackingToken: data.deliveryTrackingToken,
      createdAt: data.createdAt,
    };
  });
}

// ─── Customer Tracking ──────────────────────────────────────────────────────

/**
 * Get delivery info by tracking token (public, no auth required).
 */
async function getDeliveryByTrackingToken(trackingToken) {
  const db = getDb();
  const snap = await db
    .collection(collections.orders)
    .where('deliveryTrackingToken', '==', trackingToken)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();

  // Check if restaurant has real-time tracking enabled
  const settings = await getDeliverySettings(data.restaurantId);

  return {
    orderId: doc.id,
    orderNumber: data.orderNumber || data.dailyOrderId,
    deliveryStatus: data.deliveryStatus,
    driverName: data.assignedStaff?.name || null,
    deliveryAddress: data.deliveryAddress,
    deliveryAssignedAt: data.deliveryAssignedAt,
    deliveryAcceptedAt: data.deliveryAcceptedAt,
    deliveryPickedUpAt: data.deliveryPickedUpAt,
    deliveryCompletedAt: data.deliveryCompletedAt,
    restaurantId: data.restaurantId,
    realtimeTrackingEnabled: settings?.deliveryRealtimeTracking || false,
    // RTDB path for client to subscribe (only if real-time enabled)
    rtdbPath: settings?.deliveryRealtimeTracking
      ? `delivery/${data.restaurantId}/${doc.id}/location`
      : null,
  };
}

// ─── FCM Token Management (Staff) ──────────────────────────────────────────

/**
 * Register a delivery partner's FCM token (separate from printer tokens).
 */
async function registerStaffFcmToken(restaurantId, staffId, token, platform) {
  const db = getDb();
  await db
    .collection(collections.restaurants)
    .doc(restaurantId)
    .collection('staffFcmTokens')
    .doc(staffId)
    .set(
      { token, platform: platform || 'android', updatedAt: new Date().toISOString() },
      { merge: true }
    );
}

/**
 * Get FCM token for a specific staff member.
 */
async function getStaffFcmToken(restaurantId, staffId) {
  const db = getDb();
  const doc = await db
    .collection(collections.restaurants)
    .doc(restaurantId)
    .collection('staffFcmTokens')
    .doc(staffId)
    .get();

  if (!doc.exists) return null;
  return doc.data().token;
}

module.exports = {
  getDeliverySettings,
  getDeliveryPartners,
  getDeliveryPartnersWithStatus,
  assignDeliveryPartner,
  respondToAssignment,
  markPickedUp,
  markDelivered,
  updateLocation,
  updateStatusInRTDB,
  getActiveDeliveries,
  getPartnerActiveDelivery,
  getDeliveryByTrackingToken,
  registerStaffFcmToken,
  getStaffFcmToken,
  generateTrackingToken,
};
