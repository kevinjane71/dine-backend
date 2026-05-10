/**
 * Bolna AI Phone Agent Routes
 * Setup endpoints (authenticated) + Webhook endpoints (called by Bolna)
 */

const express = require('express');
const router = express.Router();
const bolnaService = require('../services/bolna/BolnaService');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const { getDb, collections } = require('../firebase');

// ==================== Setup Endpoints (Authenticated) ====================

/**
 * Create/enable AI phone agent for a restaurant
 * POST /api/bolna/setup
 */
router.post('/bolna/setup', authenticateToken, async (req, res) => {
  try {
    const restaurantId = req.body.restaurantId || req.user.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, error: 'restaurantId required' });
    }

    // Check if agent already exists
    const existing = await bolnaService.getAgentStatus(restaurantId);
    if (existing.exists && existing.agent.status !== 'deleted') {
      return res.status(400).json({
        success: false,
        error: 'Phone agent already exists for this restaurant',
        agent: existing.agent
      });
    }

    // Get restaurant data
    const db = getDb();
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurantData = { id: restaurantId, ...restaurantDoc.data() };

    // Get menu data
    const menuSnapshot = await db.collection(collections.menuItems)
      .where('restaurantId', '==', restaurantId)
      .where('available', '==', true)
      .get();
    const menuData = menuSnapshot.docs.map(d => d.data());

    // Apply user preferences
    if (req.body.language) restaurantData.bolnaLanguage = req.body.language;
    if (req.body.voice) restaurantData.bolnaVoice = req.body.voice;
    if (req.body.specialInstructions) restaurantData.specialInstructions = req.body.specialInstructions;

    // Create agent
    const result = await bolnaService.createAgent(restaurantId, restaurantData, menuData);

    res.json(result);
  } catch (error) {
    console.error('Error setting up Bolna agent:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Setup phone number for agent
 * POST /api/bolna/phone-number
 */
router.post('/bolna/phone-number', authenticateToken, async (req, res) => {
  try {
    const restaurantId = req.body.restaurantId || req.user.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, error: 'restaurantId required' });
    }

    const country = req.body.country || 'IN';
    const result = await bolnaService.setupPhoneNumber(restaurantId, country);

    res.json(result);
  } catch (error) {
    console.error('Error setting up phone number:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get agent status
 * GET /api/bolna/status/:restaurantId
 */
router.get('/bolna/status/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const result = await bolnaService.getAgentStatus(restaurantId);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error getting agent status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update agent settings
 * PUT /api/bolna/agent/:restaurantId
 */
router.put('/bolna/agent/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const result = await bolnaService.updateAgent(restaurantId, req.body);
    res.json(result);
  } catch (error) {
    console.error('Error updating agent:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Delete/deactivate agent
 * DELETE /api/bolna/agent/:restaurantId
 */
router.delete('/bolna/agent/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const result = await bolnaService.deleteAgent(restaurantId);
    res.json(result);
  } catch (error) {
    console.error('Error deleting agent:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get call logs
 * GET /api/bolna/calls/:restaurantId
 */
router.get('/bolna/calls/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const result = await bolnaService.getCallLogs(restaurantId, limit);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error getting call logs:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Get single call details
 * GET /api/bolna/calls/detail/:executionId
 */
router.get('/bolna/calls/detail/:executionId', authenticateToken, async (req, res) => {
  try {
    const { executionId } = req.params;
    const result = await bolnaService.getCallDetails(executionId);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error getting call details:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Sync menu to agent
 * POST /api/bolna/sync-menu/:restaurantId
 */
router.post('/bolna/sync-menu/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const result = await bolnaService.syncMenu(restaurantId);
    res.json(result);
  } catch (error) {
    console.error('Error syncing menu:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Search available phone numbers
 * GET /api/bolna/phone-numbers/search
 */
router.get('/bolna/phone-numbers/search', authenticateToken, async (req, res) => {
  try {
    const country = req.query.country || 'IN';
    const result = await bolnaService.searchPhoneNumbers(country);
    res.json({ success: true, numbers: result });
  } catch (error) {
    console.error('Error searching phone numbers:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== Webhook Endpoints (Called by Bolna during calls) ====================
// These are NOT authenticated with JWT — they're called by Bolna's servers

/**
 * Menu webhook — returns menu data to AI agent during call
 * POST /api/bolna/webhook/menu
 */
router.post('/bolna/webhook/menu', async (req, res) => {
  try {
    const restaurantId = req.body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId required' });
    }

    const menuData = await bolnaService.getMenuForWebhook(restaurantId);

    // Format for the AI agent to read out
    let response = '';
    for (const [category, items] of Object.entries(menuData.menu)) {
      response += `${category}: `;
      response += items.map(i => `${i.name} - ₹${i.price}${i.isVeg ? ' (veg)' : ''}`).join(', ');
      response += '. ';
    }

    res.json({
      success: true,
      result: response,
      data: menuData
    });
  } catch (error) {
    console.error('Webhook menu error:', error);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

/**
 * Hours webhook — returns operating hours
 * POST /api/bolna/webhook/hours
 */
router.post('/bolna/webhook/hours', async (req, res) => {
  try {
    const restaurantId = req.body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId required' });
    }

    const hours = await bolnaService.getHoursForWebhook(restaurantId);
    res.json({
      success: true,
      result: `${hours.restaurantName} is ${hours.isOpen ? 'currently open' : 'currently closed'}. Hours: ${JSON.stringify(hours.operatingHours)}. Address: ${hours.address}`,
      data: hours
    });
  } catch (error) {
    console.error('Webhook hours error:', error);
    res.status(500).json({ error: 'Failed to fetch hours' });
  }
});

/**
 * Reservation webhook — creates a booking
 * POST /api/bolna/webhook/reservation
 */
router.post('/bolna/webhook/reservation', async (req, res) => {
  try {
    const restaurantId = req.body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId required' });
    }

    const result = await bolnaService.createReservationFromWebhook(restaurantId, req.body);
    res.json({
      success: true,
      result: result.confirmation,
      data: result
    });
  } catch (error) {
    console.error('Webhook reservation error:', error);
    res.status(500).json({ error: 'Failed to create reservation' });
  }
});

/**
 * Order webhook — creates a phone order
 * POST /api/bolna/webhook/order
 */
router.post('/bolna/webhook/order', async (req, res) => {
  try {
    const restaurantId = req.body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId required' });
    }

    const result = await bolnaService.createOrderFromWebhook(restaurantId, req.body);
    res.json({
      success: true,
      result: result.confirmation,
      data: result
    });
  } catch (error) {
    console.error('Webhook order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

/**
 * Call status webhook — logs call events
 * POST /api/bolna/webhook/call-status
 */
router.post('/bolna/webhook/call-status', async (req, res) => {
  try {
    const restaurantId = req.query.restaurantId || req.body.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId required' });
    }

    await bolnaService.handleCallStatusWebhook(restaurantId, req.body);
    res.json({ success: true });
  } catch (error) {
    console.error('Webhook call-status error:', error);
    res.status(500).json({ error: 'Failed to log call status' });
  }
});

module.exports = router;
