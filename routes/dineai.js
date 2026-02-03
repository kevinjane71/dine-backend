/**
 * DineAI Routes
 * Voice and text endpoints for DineAI assistant
 */

const express = require('express');
const router = express.Router();
const dineaiVoiceService = require('../services/dineai/DineAIVoiceService');
const dineaiRealtimeService = require('../services/dineai/DineAIRealtimeService');
const conversationService = require('../services/dineai/DineAIConversationService');
const dineaiPermissions = require('../services/dineai/DineAIPermissions');
const greetingService = require('../services/dineai/DineAIGreetingService');
const {
  authenticateDineAI,
  authenticateSimple,
  dineaiRateLimiter,
  trackDineAIUsage,
  requireManagerRole
} = require('../middleware/dineaiAuth');

// ==================== Session Management ====================

/**
 * Start a new voice session
 * POST /api/dineai/session/start
 */
router.post('/dineai/session/start', authenticateDineAI, dineaiRateLimiter, async (req, res) => {
  try {
    const { restaurantId } = req;
    const userId = req.user.userId;
    const userRole = req.userRole;
    const { sessionType, responseMode, voice } = req.body;

    console.log(`🎙️ Starting DineAI session for user ${userId} at restaurant ${restaurantId}`);

    const result = await dineaiVoiceService.createSession(
      restaurantId,
      userId,
      userRole,
      {
        sessionType: sessionType || 'voice',
        responseMode: responseMode || 'voice',
        voice: voice || 'alloy'
      }
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      sessionId: result.sessionId,
      config: result.config,
      limits: result.limits,
      wsUrl: dineaiVoiceService.getRealtimeWebSocketUrl()
    });
  } catch (error) {
    console.error('Error starting DineAI session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start session'
    });
  }
});

/**
 * Get ephemeral token for client-side Realtime API connection
 * POST /api/dineai/session/:sessionId/token
 */
router.post('/dineai/session/:sessionId/token', authenticateDineAI, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await dineaiVoiceService.getEphemeralToken(sessionId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      token: result.token,
      expiresAt: result.expiresAt
    });
  } catch (error) {
    console.error('Error getting ephemeral token:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get token'
    });
  }
});

/**
 * End a voice session
 * POST /api/dineai/session/end
 */
router.post('/dineai/session/end', authenticateDineAI, async (req, res) => {
  try {
    const { sessionId, summary } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    const result = await dineaiVoiceService.endSession(sessionId);

    res.json(result);
  } catch (error) {
    console.error('Error ending DineAI session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to end session'
    });
  }
});

/**
 * Get session status
 * GET /api/dineai/session/:sessionId
 */
router.get('/dineai/session/:sessionId', authenticateDineAI, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const result = await dineaiVoiceService.getSessionStatus(sessionId);

    res.json(result);
  } catch (error) {
    console.error('Error getting session status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get session status'
    });
  }
});

// ==================== Text Fallback ====================

/**
 * Process a text query (non-voice)
 * POST /api/dineai/query
 */
router.post('/dineai/query', authenticateDineAI, dineaiRateLimiter, trackDineAIUsage, async (req, res) => {
  try {
    const { restaurantId } = req;
    const userId = req.user.userId;
    const userRole = req.userRole;
    const { query, sessionId } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    console.log(`🤖 DineAI query from ${userId}: "${query}"`);

    let activeSessionId = sessionId;

    // Create session if not provided
    if (!activeSessionId) {
      const sessionResult = await dineaiVoiceService.createSession(
        restaurantId,
        userId,
        userRole,
        { sessionType: 'text', responseMode: 'text' }
      );

      if (!sessionResult.success) {
        return res.status(400).json(sessionResult);
      }

      activeSessionId = sessionResult.sessionId;
    }

    // Process the query
    const result = await dineaiVoiceService.processTextQuery(
      activeSessionId,
      query,
      restaurantId,
      userId,
      userRole
    );

    res.json({
      success: result.success,
      sessionId: activeSessionId,
      response: result.response,
      functionCalled: result.functionCalled,
      functionResult: result.functionResult,
      usage: req.dineaiUsage
    });
  } catch (error) {
    console.error('Error processing DineAI query:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process query',
      response: "I'm sorry, I encountered an error. Please try again."
    });
  }
});

// ==================== Conversation History ====================

/**
 * Get conversation history for restaurant
 * GET /api/dineai/conversations/:restaurantId
 */
router.get('/dineai/conversations/:restaurantId', authenticateDineAI, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.query.userId || null; // Optional filter by user
    const limit = parseInt(req.query.limit) || 20;

    const conversations = await conversationService.getConversationHistory(
      restaurantId,
      userId,
      { limit }
    );

    res.json({
      success: true,
      conversations
    });
  } catch (error) {
    console.error('Error getting conversations:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get conversations'
    });
  }
});

/**
 * Get single conversation with messages
 * GET /api/dineai/conversation/:id
 */
router.get('/dineai/conversation/:id', authenticateDineAI, async (req, res) => {
  try {
    const { id } = req.params;

    const conversation = await conversationService.getConversationDetails(id);

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversation not found'
      });
    }

    // Verify access
    if (conversation.restaurantId !== req.restaurantId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      conversation
    });
  } catch (error) {
    console.error('Error getting conversation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get conversation'
    });
  }
});

// ==================== Settings ====================

/**
 * Get DineAI settings for restaurant
 * GET /api/dineai/settings/:restaurantId
 */
router.get('/dineai/settings/:restaurantId', authenticateDineAI, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { getDb } = require('../firebase');
    const db = getDb();

    const settingsDoc = await db.collection('dineai_settings').doc(restaurantId).get();

    const defaultSettings = {
      enabled: true,
      defaultVoice: 'alloy',
      voiceMode: 'push-to-talk', // 'push-to-talk' or 'realtime' (realtime requires OpenAI Realtime API access)
      responseMode: 'voice', // 'voice', 'text', or 'both'
      enableKnowledgeBase: true,
      enableGreetings: true,
      greetingStyle: 'professional', // 'professional', 'friendly', 'casual'
      maxSessionDuration: 600, // 10 minutes
      features: {
        orderManagement: true,
        tableManagement: true,
        menuOperations: true,
        analytics: true,
        knowledgeSearch: true
      }
    };

    const settings = settingsDoc.exists
      ? { ...defaultSettings, ...settingsDoc.data() }
      : defaultSettings;

    res.json({
      success: true,
      settings
    });
  } catch (error) {
    console.error('Error getting DineAI settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get settings'
    });
  }
});

/**
 * Update DineAI settings for restaurant
 * PUT /api/dineai/settings/:restaurantId
 */
router.put('/dineai/settings/:restaurantId', authenticateDineAI, requireManagerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const updates = req.body;
    const { getDb } = require('../firebase');
    const db = getDb();
    const { FieldValue } = require('firebase-admin/firestore');

    // Validate settings
    const allowedFields = [
      'enabled',
      'defaultVoice',
      'voiceMode',
      'responseMode',
      'enableKnowledgeBase',
      'enableGreetings',
      'greetingStyle',
      'maxSessionDuration',
      'features'
    ];

    const validUpdates = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        validUpdates[field] = updates[field];
      }
    }

    validUpdates.updatedAt = FieldValue.serverTimestamp();
    validUpdates.updatedBy = req.user.userId;

    await db.collection('dineai_settings').doc(restaurantId).set(validUpdates, { merge: true });

    res.json({
      success: true,
      message: 'Settings updated',
      settings: validUpdates
    });
  } catch (error) {
    console.error('Error updating DineAI settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update settings'
    });
  }
});

// ==================== Usage & Analytics ====================

/**
 * Get DineAI usage stats
 * GET /api/dineai/usage/:restaurantId
 */
router.get('/dineai/usage/:restaurantId', authenticateDineAI, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const userRole = req.userRole;

    // Get daily usage
    const dailyUsage = await conversationService.getDailyUsage(userId, restaurantId);
    const dailyLimit = dineaiPermissions.getDailyLimit(userRole);

    res.json({
      success: true,
      usage: {
        today: dailyUsage,
        limit: dailyLimit,
        remaining: Math.max(0, dailyLimit - dailyUsage.messages),
        role: userRole
      }
    });
  } catch (error) {
    console.error('Error getting DineAI usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get usage'
    });
  }
});

/**
 * Get DineAI capabilities for current user
 * GET /api/dineai/capabilities
 */
router.get('/dineai/capabilities', authenticateDineAI, async (req, res) => {
  try {
    const userRole = req.userRole;

    const allowedTools = dineaiPermissions.getAllowedTools(userRole);
    const capabilities = dineaiPermissions.getRoleCapabilitiesDescription(userRole);

    res.json({
      success: true,
      role: userRole,
      capabilities,
      allowedTools,
      dailyLimit: dineaiPermissions.getDailyLimit(userRole)
    });
  } catch (error) {
    console.error('Error getting capabilities:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get capabilities'
    });
  }
});

// ==================== Function Execution (for WebSocket relay) ====================

/**
 * Execute a function call (used by WebSocket relay)
 * POST /api/dineai/execute-function
 */
router.post('/dineai/execute-function', authenticateDineAI, async (req, res) => {
  try {
    const { sessionId, functionName, arguments: args } = req.body;

    if (!sessionId || !functionName) {
      return res.status(400).json({
        success: false,
        error: 'Session ID and function name are required'
      });
    }

    const result = await dineaiVoiceService.executeFunctionCall(
      sessionId,
      functionName,
      args || {}
    );

    res.json(result);
  } catch (error) {
    console.error('Error executing function:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute function'
    });
  }
});

// ==================== Suggestions ====================

/**
 * Get contextual suggestions for DineAI
 * GET /api/dineai/suggestions/:restaurantId
 */
router.get('/dineai/suggestions/:restaurantId', authenticateDineAI, async (req, res) => {
  try {
    const userRole = req.userRole;

    // Role-based suggestions
    const suggestions = {
      owner: [
        "What's today's revenue?",
        "Show me pending orders",
        "Which tables are available?",
        "Add a new menu item",
        "Show inventory alerts"
      ],
      manager: [
        "Place an order for table 5",
        "What's the status of order 3?",
        "Reserve table 2 for 4 people",
        "Show available tables",
        "Today's sales summary"
      ],
      employee: [
        "Place an order for table 4",
        "Show pending orders",
        "What tables are available?",
        "Check if paneer is available",
        "Get order status for table 3"
      ],
      waiter: [
        "Place an order for table 2",
        "Show today's specials",
        "What's available on the menu?",
        "Mark table 5 as occupied",
        "Show vegetarian options"
      ],
      cashier: [
        "Complete billing for order 5",
        "Show ready orders",
        "Today's collection",
        "Order details for table 3",
        "Cash vs card payments today"
      ]
    };

    res.json({
      success: true,
      suggestions: suggestions[userRole] || suggestions.employee
    });
  } catch (error) {
    console.error('Error getting suggestions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get suggestions'
    });
  }
});

// ==================== Greetings ====================

/**
 * Get personalized greeting
 * GET /api/dineai/greeting/:restaurantId
 */
router.get('/dineai/greeting/:restaurantId',
  authenticateDineAI,
  async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { voice } = req.query;

      const userData = {
        name: req.userName,
        role: req.userRole
      };

      // Get settings for greeting style
      const { getDb } = require('../firebase');
      const db = getDb();
      const settingsDoc = await db.collection('dineai_settings').doc(restaurantId).get();
      const settings = settingsDoc.exists ? settingsDoc.data() : {};

      let result;

      if (voice === 'true') {
        result = await greetingService.generateVoiceGreeting(
          restaurantId,
          userData,
          { style: settings.greetingStyle || 'friendly' }
        );
      } else {
        result = await greetingService.generateGreeting(
          restaurantId,
          userData,
          { style: settings.greetingStyle || 'professional' }
        );
      }

      res.json({
        success: true,
        greeting: result.greeting,
        voiceGreeting: result.voiceGreeting,
        hasUrgentTasks: result.hasUrgentTasks,
        state: result.state,
        suggestions: await greetingService.getSuggestionsForContext(
          restaurantId,
          req.userRole,
          result.state
        )
      });
    } catch (error) {
      console.error('Error getting greeting:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get greeting'
      });
    }
  }
);

/**
 * Get shift start greeting
 * GET /api/dineai/greeting/:restaurantId/shift
 */
router.get('/dineai/greeting/:restaurantId/shift',
  authenticateDineAI,
  async (req, res) => {
    try {
      const { restaurantId } = req.params;

      const userData = {
        name: req.userName,
        role: req.userRole
      };

      const result = await greetingService.generateShiftGreeting(restaurantId, userData);

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error('Error getting shift greeting:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get greeting'
      });
    }
  }
);

// ==================== Realtime Voice (WebSocket Mode) ====================

/**
 * Create a realtime voice session (for WebSocket streaming)
 * POST /api/dineai/realtime/session
 */
router.post('/dineai/realtime/session', authenticateDineAI, async (req, res) => {
  try {
    const { restaurantId } = req;
    const userId = req.user.userId;
    const userRole = req.userRole;
    const { voice } = req.body;

    console.log(`🎙️ Creating DineAI Realtime session for user ${userId}`);

    const result = await dineaiRealtimeService.createRealtimeSession(
      restaurantId,
      userId,
      userRole,
      { voice: voice || 'alloy' }
    );

    if (!result.success) {
      console.error('Realtime session creation failed:', result.error);
      return res.status(400).json({
        success: false,
        error: result.error || 'Failed to create realtime session'
      });
    }

    res.json({
      success: true,
      sessionId: result.sessionId,
      clientSecret: result.clientSecret,
      expiresAt: result.expiresAt,
      model: result.model,
      voice: result.voice,
      instructions: result.instructions,
      wsUrl: 'wss://api.openai.com/v1/realtime'
    });
  } catch (error) {
    console.error('Error creating realtime session:', error);

    // Pass through informative error messages
    const errorMessage = error.message?.includes('OpenAI')
      ? error.message
      : 'Failed to create realtime session. Please try Push-to-Talk mode.';

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

/**
 * Execute a function call from realtime session
 * POST /api/dineai/realtime/function
 */
router.post('/dineai/realtime/function', authenticateDineAI, async (req, res) => {
  try {
    const { sessionId, functionName, arguments: args, restaurantId: bodyRestaurantId } = req.body;
    const restaurantId = bodyRestaurantId || req.restaurantId;
    const userId = req.user?.userId;
    const userRole = req.userRole;

    if (!sessionId || !functionName) {
      return res.status(400).json({
        success: false,
        error: 'Session ID and function name are required'
      });
    }

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Restaurant ID is required'
      });
    }

    console.log(`🔧 DineAI Realtime function: ${functionName} for restaurant ${restaurantId}`);

    const result = await dineaiRealtimeService.executeFunctionCall(
      sessionId,
      functionName,
      args || {},
      restaurantId,
      userId,
      userRole
    );

    res.json(result);
  } catch (error) {
    console.error('Error executing realtime function:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to execute function'
    });
  }
});

/**
 * WebRTC SDP Proxy - More secure, frontend never sees token
 * POST /api/dineai/realtime/webrtc/offer
 */
router.post('/dineai/realtime/webrtc/offer', authenticateDineAI, async (req, res) => {
  try {
    const { restaurantId } = req;
    const userId = req.user.userId;
    const userRole = req.userRole;
    const { sdpOffer, voice } = req.body;

    if (!sdpOffer) {
      return res.status(400).json({
        success: false,
        error: 'SDP offer is required'
      });
    }

    console.log(`🎙️ WebRTC SDP proxy for user ${userId}`);

    // Create session and get ephemeral token (stays on server)
    const sessionResult = await dineaiRealtimeService.createRealtimeSession(
      restaurantId,
      userId,
      userRole,
      { voice: voice || 'alloy' }
    );

    if (!sessionResult.success) {
      return res.status(400).json(sessionResult);
    }

    // Get the ephemeral token
    const ephemeralToken = sessionResult.clientSecret?.value || sessionResult.clientSecret;

    if (!ephemeralToken) {
      return res.status(500).json({
        success: false,
        error: 'Failed to get ephemeral token'
      });
    }

    // Exchange SDP with OpenAI (token never leaves server)
    const model = sessionResult.model || 'gpt-4o-realtime-preview';
    const openaiResponse = await fetch(`https://api.openai.com/v1/realtime?model=${model}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ephemeralToken}`,
        'Content-Type': 'application/sdp'
      },
      body: sdpOffer
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error('OpenAI WebRTC error:', errorText);
      return res.status(500).json({
        success: false,
        error: 'Failed to establish WebRTC connection with OpenAI'
      });
    }

    const sdpAnswer = await openaiResponse.text();

    console.log(`✅ WebRTC SDP exchange complete for session ${sessionResult.sessionId}`);

    res.json({
      success: true,
      sessionId: sessionResult.sessionId,
      sdpAnswer,
      model
    });
  } catch (error) {
    console.error('WebRTC SDP proxy error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to proxy WebRTC connection'
    });
  }
});

/**
 * End a realtime session
 * POST /api/dineai/realtime/end
 */
router.post('/dineai/realtime/end', authenticateSimple, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    const result = await dineaiRealtimeService.endRealtimeSession(sessionId);

    res.json(result);
  } catch (error) {
    console.error('Error ending realtime session:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to end session'
    });
  }
});

module.exports = router;
