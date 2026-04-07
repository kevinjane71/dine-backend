// FCM (Firebase Cloud Messaging) service for KOT/Bill print notifications.
//
// Why this exists:
//   Pusher is unreliable on long-lived mobile connections (carrier NAT
//   timeouts, Doze mode, mobile data dropouts). FCM is Google's purpose-built
//   push system — it's the same channel Gmail/WhatsApp use, and it survives
//   background, doze, and network drops gracefully. We use it as an
//   alternative to Pusher (chosen by the printer client at runtime).
//
// Architecture:
//   - Tokens are stored per device under a subcollection:
//     restaurants/{restaurantId}/fcmTokens/{deviceId}
//   - Each printer client (Android tablet, Electron desktop) registers its
//     token via POST /api/printer/register-fcm-token on startup.
//   - When a print event fires (KOT or bill), pusherService also calls into
//     this module which fans out to every registered token for that
//     restaurant. Same payload as Pusher — slim, fetch-based.
//   - Invalid/unregistered tokens are auto-cleaned on send failure so the
//     token list never grows stale.
//
// IMPORTANT: This module never throws to the caller. FCM failures must not
// break the order/billing flow. All errors are logged and swallowed.

const { getMessaging } = require('firebase-admin/messaging');
const { getDb, collections } = require('../firebase');

let messagingClient = null;

/**
 * Lazy-init the messaging client. firebase-admin is already initialized in
 * firebase.js, so we just grab the messaging instance the first time it's
 * needed (mirrors the lazy db pattern in that module).
 */
function getMessagingClient() {
  if (!messagingClient) {
    try {
      messagingClient = getMessaging();
      console.log('✅ FCM messaging client initialized');
    } catch (err) {
      console.error('❌ FCM init failed:', err.message);
      return null;
    }
  }
  return messagingClient;
}

/**
 * Token storage path: restaurants/{restaurantId}/fcmTokens/{deviceId}
 * deviceId is supplied by the client and is stable across reinstalls (we
 * use Android's androidId / Electron's machineId).
 */
function tokenCollection(restaurantId) {
  return getDb()
    .collection(collections.restaurants)
    .doc(restaurantId)
    .collection('fcmTokens');
}

/**
 * Register or update a printer device's FCM token. Idempotent — safe to
 * call on every app launch (which is what the clients do, since FCM tokens
 * can rotate).
 */
async function registerToken({ restaurantId, deviceId, token, deviceType, deviceName }) {
  if (!restaurantId || !deviceId || !token) {
    throw new Error('restaurantId, deviceId and token are required');
  }
  await tokenCollection(restaurantId).doc(deviceId).set(
    {
      token,
      deviceType: deviceType || 'unknown', // 'android' | 'electron' | 'ios'
      deviceName: deviceName || '',
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  console.log(`📬 FCM token registered: ${restaurantId}/${deviceId} (${deviceType})`);
}

/**
 * Unregister a device — called when the user changes restaurantId or
 * uninstalls. Safe if doc doesn't exist.
 */
async function unregisterToken({ restaurantId, deviceId }) {
  if (!restaurantId || !deviceId) return;
  try {
    await tokenCollection(restaurantId).doc(deviceId).delete();
    console.log(`📬 FCM token unregistered: ${restaurantId}/${deviceId}`);
  } catch (err) {
    console.warn(`FCM unregister failed for ${restaurantId}/${deviceId}:`, err.message);
  }
}

/**
 * Fetch all registered tokens for a restaurant. Returns an array of
 * { deviceId, token } so we can clean up dead tokens after a send.
 */
async function getTokensForRestaurant(restaurantId) {
  try {
    const snap = await tokenCollection(restaurantId).get();
    const list = [];
    snap.forEach(doc => {
      const data = doc.data();
      if (data?.token) list.push({ deviceId: doc.id, token: data.token });
    });
    return list;
  } catch (err) {
    console.error(`FCM token fetch failed for ${restaurantId}:`, err.message);
    return [];
  }
}

/**
 * Internal: send a data-only message to every device for a restaurant.
 * Cleans up tokens that come back as Unregistered/InvalidArgument.
 *
 * We send DATA messages (not notification messages) so the printer app
 * gets full control — it processes the payload silently in the background
 * and decides itself whether to print and/or show a notification.
 */
async function sendToRestaurant(restaurantId, data) {
  const messaging = getMessagingClient();
  if (!messaging) return { success: false, sent: 0, reason: 'fcm-not-initialized' };

  const tokens = await getTokensForRestaurant(restaurantId);
  if (tokens.length === 0) {
    return { success: true, sent: 0, reason: 'no-tokens' };
  }

  // FCM data fields must all be strings — coerce here to avoid surprises.
  const stringData = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === null || v === undefined) continue;
    stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }

  try {
    const response = await messaging.sendEachForMulticast({
      tokens: tokens.map(t => t.token),
      data: stringData,
      android: {
        // High priority is required for instant delivery (~1-3s). Normal
        // priority can be batched/delayed by the OS for up to several
        // minutes which is unacceptable for a print event.
        priority: 'high',
        // TTL of 1 minute — after that the print is stale and shouldn't
        // be delivered (the order may have been edited or cancelled).
        ttl: 60 * 1000,
      },
      // APNs (iOS) settings — if we ever ship an iPad printer client,
      // these ensure background delivery on iOS too.
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { contentAvailable: true } },
      },
    });

    // Clean up tokens that are no longer valid. FCM returns one response
    // per token in the same order as the input, so we can map by index.
    const cleanups = [];
    response.responses.forEach((res, idx) => {
      if (!res.success) {
        const code = res.error?.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          cleanups.push(unregisterToken({ restaurantId, deviceId: tokens[idx].deviceId }));
        } else {
          console.warn(`FCM send failure for ${tokens[idx].deviceId}:`, code);
        }
      }
    });
    if (cleanups.length) await Promise.allSettled(cleanups);

    console.log(
      `📬 FCM sent to ${restaurantId}: ${response.successCount}/${tokens.length} delivered, ${cleanups.length} stale tokens cleaned`,
    );
    return { success: true, sent: response.successCount, total: tokens.length };
  } catch (err) {
    console.error(`FCM send failed for ${restaurantId}:`, err.message);
    return { success: false, sent: 0, error: err.message };
  }
}

/**
 * Send a KOT print request to all registered devices. Mirrors the slim
 * payload that pusherService.notifyKOTPrintRequest sends — clients then
 * fetch the full render via /api/kot/render/:restaurantId/:orderId.
 */
async function sendKOTPrintNotification(restaurantId, orderData) {
  return sendToRestaurant(restaurantId, {
    type: 'kot-print-request',
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
  });
}

/**
 * Send a Billing print request to all registered devices. Mirrors the
 * pusherService.notifyBillingPrintRequest payload.
 */
async function sendBillingPrintNotification(restaurantId, orderData) {
  const completedAt = orderData.completedAt || new Date();
  return sendToRestaurant(restaurantId, {
    type: 'billing-print-request',
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
    completedAt: completedAt instanceof Date ? completedAt.toISOString() : completedAt,
  });
}

module.exports = {
  registerToken,
  unregisterToken,
  getTokensForRestaurant,
  sendKOTPrintNotification,
  sendBillingPrintNotification,
};
