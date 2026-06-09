/**
 * WhatsApp Ordering Routes
 * - Setup/config endpoints (authenticated)
 * - Meta webhook endpoints (public)
 * - Order management endpoints (authenticated)
 */

const express = require('express');
const router = express.Router();
const { getDb, collections } = require('../firebase');
const { getCachedRestDoc } = require('../utils/kvCache');
const { authenticateToken } = require('../middleware/auth');
const whatsappService = require('../services/whatsappService');
const orderingService = require('../services/whatsappOrderingService');

// ==================== Meta Webhook Verification (Public) ====================

/**
 * GET /api/whatsapp-ordering/webhook
 * Meta sends a GET to verify the webhook URL during setup
 */
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'dineopen_whatsapp_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('✅ WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }

  console.warn('⚠️ WhatsApp webhook verification failed');
  return res.sendStatus(403);
});

// ==================== Meta Webhook Incoming Messages (Public) ====================

/**
 * POST /api/whatsapp-ordering/webhook
 * Receives incoming messages from Meta WhatsApp Cloud API
 */
router.post('/webhook', async (req, res) => {
  // Always respond 200 immediately (Meta requires this)
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body?.entry?.[0]?.changes?.[0]?.value) return;

    const value = body.entry[0].changes[0].value;

    // Handle message status updates (delivered, read, etc.)
    if (value.statuses) {
      // Status updates - we can log these
      return;
    }

    if (!value.messages || !value.messages[0]) return;

    const message = value.messages[0];
    const contact = value.contacts?.[0];
    const phoneNumberId = value.metadata?.phone_number_id;

    if (!phoneNumberId) return;

    // Find which restaurant this phone number belongs to
    const match = await orderingService.findRestaurantByPhoneNumberId(phoneNumberId);
    if (!match) {
      console.warn(`No restaurant found for WhatsApp phone number ID: ${phoneNumberId}`);
      return;
    }

    const { restaurantId, config } = match;
    const customerPhone = message.from;

    // Extract message content
    let messageType = message.type;
    let messageText = '';
    let interactiveId = null;

    switch (messageType) {
      case 'text':
        messageText = message.text?.body || '';
        break;
      case 'interactive':
        if (message.interactive?.type === 'list_reply') {
          interactiveId = message.interactive.list_reply?.id;
          messageText = message.interactive.list_reply?.title || '';
        } else if (message.interactive?.type === 'button_reply') {
          interactiveId = message.interactive.button_reply?.id;
          messageText = message.interactive.button_reply?.title || '';
        }
        break;
      case 'button':
        messageText = message.button?.text || '';
        interactiveId = message.button?.payload || '';
        break;
      default:
        messageText = '';
    }

    // Process the message through conversation engine
    const result = await orderingService.processMessage(
      customerPhone,
      restaurantId,
      messageType,
      messageText,
      interactiveId
    );

    // Build credentials for per-call usage (concurrency-safe)
    const waCreds = {
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId
    };

    // Send response messages
    for (const msg of result.messages) {
      try {
        switch (msg.type) {
          case 'text':
            await whatsappService.sendTextMessage(customerPhone, msg.text, waCreds);
            break;
          case 'list':
            await whatsappService.sendListMessage(customerPhone, {
              headerText: msg.headerText,
              bodyText: msg.bodyText,
              footerText: msg.footerText,
              buttonText: msg.buttonText,
              sections: msg.sections
            }, waCreds);
            break;
          case 'interactive_button':
            await whatsappService.sendInteractiveMessage(customerPhone, msg.text, msg.buttons, waCreds);
            break;
          case 'template':
            await whatsappService.sendTemplateMessage(customerPhone, msg.templateName, msg.language, msg.params, waCreds);
            break;
        }
      } catch (sendError) {
        console.error(`Error sending WhatsApp message to ${customerPhone}:`, sendError.message);
      }
    }

    // Log the conversation
    try {
      const db = getDb();
      await db.collection('whatsappConversationLogs').add({
        restaurantId,
        customerPhone,
        contactName: contact?.profile?.name || '',
        incomingType: messageType,
        incomingText: messageText,
        interactiveId,
        responseCount: result.messages.length,
        createdAt: new Date().toISOString()
      });
    } catch (logErr) {
      console.error('Conversation log error (non-blocking):', logErr.message);
    }

  } catch (error) {
    console.error('WhatsApp webhook processing error:', error);
  }
});

// ==================== Setup & Config Endpoints (Authenticated) ====================

/**
 * GET /api/whatsapp-ordering/config/:restaurantId
 * Get WhatsApp ordering configuration
 */
router.get('/config/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const db = getDb();
    const doc = await db.collection('whatsappOrderingConfig').doc(restaurantId).get();

    if (!doc.exists) {
      return res.json({ success: true, exists: false, config: null });
    }

    const config = doc.data();
    // Don't expose the access token in full
    if (config.accessToken) {
      config.accessTokenMasked = config.accessToken.substring(0, 10) + '...' + config.accessToken.substring(config.accessToken.length - 5);
      delete config.accessToken;
    }

    res.json({ success: true, exists: true, config });
  } catch (error) {
    console.error('Get WhatsApp config error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/whatsapp-ordering/config/:restaurantId
 * Save/update WhatsApp ordering configuration
 */
router.post('/config/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      accessToken,
      phoneNumberId,
      businessAccountId,
      webhookVerifyToken,
      appSecret,
      welcomeMessage,
      requireTableNumber,
      paymentMode,
      paymentLink,
      autoAcceptOrders,
      enabled
    } = req.body;

    const db = getDb();

    // Get restaurant name for welcome message
    const restaurantDoc = await getCachedRestDoc(db, collections.restaurants, restaurantId);
    const restaurantName = restaurantDoc.exists ? restaurantDoc.data().name : 'Restaurant';
    const currencySymbol = restaurantDoc.exists ? (restaurantDoc.data().currencySymbol || '₹') : '₹';

    const configData = {
      restaurantId,
      restaurantName,
      currencySymbol,
      accessToken: accessToken || '',
      phoneNumberId: phoneNumberId || '',
      businessAccountId: businessAccountId || '',
      webhookVerifyToken: webhookVerifyToken || 'dineopen_whatsapp_verify',
      appSecret: appSecret || '',
      welcomeMessage: welcomeMessage || `Welcome to *${restaurantName}*! 🍽️\n\nI can help you place an order.\n\nType *menu* to see our menu\nType *cart* to view your cart\nType *help* for more options`,
      requireTableNumber: requireTableNumber !== false,
      paymentMode: paymentMode || 'pay_at_counter',
      paymentLink: paymentLink || '',
      autoAcceptOrders: autoAcceptOrders || false,
      enabled: enabled || false,
      updatedAt: new Date().toISOString()
    };

    // Check if exists
    const existing = await db.collection('whatsappOrderingConfig').doc(restaurantId).get();
    if (!existing.exists) {
      configData.createdAt = new Date().toISOString();
    }

    await db.collection('whatsappOrderingConfig').doc(restaurantId).set(configData, { merge: true });

    // Mask token before returning
    const responseConfig = { ...configData };
    if (responseConfig.accessToken) {
      responseConfig.accessTokenMasked = responseConfig.accessToken.substring(0, 10) + '...' + responseConfig.accessToken.substring(responseConfig.accessToken.length - 5);
      delete responseConfig.accessToken;
    }

    res.json({ success: true, config: responseConfig });
  } catch (error) {
    console.error('Save WhatsApp config error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/whatsapp-ordering/toggle/:restaurantId
 * Enable/disable WhatsApp ordering
 */
router.put('/toggle/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { enabled } = req.body;
    const db = getDb();

    // Check config exists
    const doc = await db.collection('whatsappOrderingConfig').doc(restaurantId).get();
    if (!doc.exists) {
      return res.status(400).json({ success: false, error: 'Please complete setup first' });
    }

    const config = doc.data();
    if (enabled && (!config.accessToken || !config.phoneNumberId)) {
      return res.status(400).json({ success: false, error: 'Please configure your WhatsApp credentials first' });
    }

    await db.collection('whatsappOrderingConfig').doc(restaurantId).update({
      enabled: !!enabled,
      updatedAt: new Date().toISOString()
    });

    res.json({ success: true, enabled: !!enabled });
  } catch (error) {
    console.error('Toggle WhatsApp ordering error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/whatsapp-ordering/orders/:restaurantId
 * Get WhatsApp orders for a restaurant
 */
router.get('/orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const db = getDb();

    const snap = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('source', '==', 'whatsapp')
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ success: true, orders, count: orders.length });
  } catch (error) {
    console.error('Get WhatsApp orders error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/whatsapp-ordering/stats/:restaurantId
 * Get WhatsApp ordering stats
 */
router.get('/stats/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const db = getDb();

    // Get orders from the last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const snap = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('source', '==', 'whatsapp')
      .where('createdAt', '>=', thirtyDaysAgo)
      .get();

    const orders = snap.docs.map(d => d.data());
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    // Get conversation count
    const convSnap = await db.collection('whatsappConversationLogs')
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', thirtyDaysAgo)
      .get();

    res.json({
      success: true,
      stats: {
        totalOrders,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        totalConversations: convSnap.size,
        conversionRate: convSnap.size > 0 ? Math.round((totalOrders / convSnap.size) * 100) : 0
      }
    });
  } catch (error) {
    console.error('Get WhatsApp stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/whatsapp-ordering/test-message/:restaurantId
 * Send a test message to verify setup
 */
router.post('/test-message/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number required' });
    }

    const db = getDb();
    const doc = await db.collection('whatsappOrderingConfig').doc(restaurantId).get();
    if (!doc.exists) {
      return res.status(400).json({ success: false, error: 'WhatsApp not configured' });
    }

    const config = doc.data();
    if (!config.accessToken || !config.phoneNumberId) {
      return res.status(400).json({ success: false, error: 'Missing WhatsApp credentials' });
    }

    const testCreds = {
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId
    };

    const result = await whatsappService.sendTextMessage(
      phoneNumber,
      `✅ DineOpen WhatsApp Ordering is set up correctly for *${config.restaurantName}*!\n\nCustomers can now message this number to place orders.`,
      testCreds
    );

    res.json({ success: result.success, messageId: result.messageId, error: result.error });
  } catch (error) {
    console.error('Test message error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
