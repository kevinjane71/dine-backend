const express = require('express');
const router = express.Router();
const ChatbotRAGService = require('../services/chatbotRAG');
const EnhancedRAGService = require('../services/enhancedRAGService');
const IntelligentAgentService = require('../services/intelligentAgent');
const FunctionCallingAgent = require('../services/functionCallingAgent');
const { authenticateToken } = require('../middleware/auth');
const { authenticateRAGAccess } = require('../middleware/ragSecurity');
const aiUsageLimiter = require('../middleware/aiUsageLimiter');
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

// Get AI usage status for current user
router.get('/chatbot/usage', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const usage = await aiUsageLimiter.getUsage(userId);
    
    res.json({
      success: true,
      ...usage
    });
  } catch (error) {
    console.error('Error getting AI usage:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AI usage'
    });
  }
});

const chatbotRAG = new ChatbotRAGService();
const enhancedRAG = new EnhancedRAGService();
const intelligentAgent = new IntelligentAgentService();
const functionCallingAgent = new FunctionCallingAgent();

// Chatbot query endpoint - Enhanced RAG with Security
router.post('/chatbot/query', authenticateToken, authenticateRAGAccess, async (req, res) => {
  try {
    const { query, restaurantId } = req.body;
    const userId = req.user.userId;

    console.log(`🤖 Enhanced RAG query from user ${userId}: "${query}" for restaurant ${restaurantId}`);

    // Process the query using Enhanced RAG system
    const result = await enhancedRAG.processQuery(query, restaurantId, userId);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    // Return response with execution results
    res.json({
      success: true,
      intent: result.intent,
      response: result.response,
      execution: result.execution,
      context: result.context,
      ragContext: result.ragContext
    });

  } catch (error) {
    console.error('Enhanced RAG API error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Initialize RAG knowledge for restaurant - SECURE VERSION
router.post('/chatbot/init-rag', authenticateToken, authenticateRAGAccess, async (req, res) => {
  try {
    const { restaurantId } = req.body;
    const userId = req.user.userId;

    console.log(`🔄 Initializing RAG knowledge for restaurant ${restaurantId} by user ${userId}`);

    // Initialize RAG knowledge
    const result = await enhancedRAG.initializeRAGKnowledge(restaurantId);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: result.message
    });

  } catch (error) {
    console.error('RAG initialization error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Update RAG knowledge for restaurant - SECURE VERSION
router.post('/chatbot/update-rag', authenticateToken, authenticateRAGAccess, async (req, res) => {
  try {
    const { restaurantId } = req.body;
    const userId = req.user.userId;

    console.log(`🔄 Updating RAG knowledge for restaurant ${restaurantId} by user ${userId}`);

    // Update RAG knowledge
    const result = await enhancedRAG.updateRAGKnowledge(restaurantId);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: result.message
    });

  } catch (error) {
    console.error('RAG update error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Function Calling Agent Query Endpoint - NEW (Primary)
router.post('/chatbot/intelligent-query', authenticateToken, aiUsageLimiter.middleware(), async (req, res) => {
  try {
    const { query, restaurantId, context } = req.body;
    const userId = req.user.userId;

    if (!query || !restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Query and restaurantId are required'
      });
    }

    console.log(`🤖 Function Calling Agent query from user ${userId}: "${query}" for restaurant ${restaurantId}`);

    // Get conversation history from Firestore
    let conversationHistory = [];
    try {
      const conversationDoc = await db.collection('chatbot_conversations')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (!conversationDoc.empty) {
        const lastConversation = conversationDoc.docs[0].data();
        conversationHistory = lastConversation.messages || [];
        // Keep last 8 messages for better context understanding (especially for follow-ups)
        conversationHistory = conversationHistory.slice(-8);
        console.log(`📝 Loaded ${conversationHistory.length} messages from conversation history`);
      }
    } catch (error) {
      console.error('Error fetching conversation history:', error);
      // Continue without history
    }

    // Process query with function calling agent (pass user role for access control)
    const userRole = req.user.role || null;
    const result = await functionCallingAgent.processQuery(query, restaurantId, userId, conversationHistory, userRole, context || {});

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        response: result.response
      });
    }

    // Save conversation to Firestore
    try {
      const newMessages = [
        ...conversationHistory,
        { role: 'user', content: query },
        { role: 'assistant', content: result.response }
      ];

      // Save or update conversation
      const conversationRef = db.collection('chatbot_conversations').doc();
      await conversationRef.set({
        userId,
        restaurantId,
        messages: newMessages.slice(-10), // Keep last 10 messages
        lastMessage: query,
        lastResponse: result.response,
        functionCalled: result.functionCalled || null,
        timestamp: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error('Error saving conversation:', error);
      // Continue even if save fails
    }

    // Return result
    res.json({
      success: true,
      response: result.response,
      functionCalled: result.functionCalled || null,
      functionResult: result.functionResult || null,
      hasData: result.hasData || false,
      data: result.data || null
    });

  } catch (error) {
    console.error('Function Calling Agent API error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      response: 'Sorry, I encountered an error. Please try again.'
    });
  }
});

// Legacy Intelligent Agent Query Endpoint (kept for backward compatibility)
router.post('/chatbot/intelligent-query-legacy', authenticateToken, async (req, res) => {
  try {
    const { query, restaurantId, context } = req.body;
    const userId = req.user.userId;

    if (!query || !restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Query and restaurantId are required'
      });
    }

    console.log(`🤖 Intelligent Agent query from user ${userId}: "${query}" for restaurant ${restaurantId}`);

    // Process query with intelligent agent
    const result = await intelligentAgent.processQuery(query, restaurantId, userId, context || {});

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        response: result.response,
        requiresPermission: result.requiresPermission || false
      });
    }

    // Prepare response data (mask PII before sending to frontend)
    let responseData = null;
    if (result.data) {
      responseData = intelligentAgent.maskPIIData(result.data);
    }

    // Return result
    res.json({
      success: true,
      intent: result.intent,
      parameters: result.parameters,
      apiConfig: result.apiConfig,
      response: result.response,
      execution: result.execution,
      requiresFollowUp: result.requiresFollowUp || false,
      missingParams: result.missingParams || [],
      requiresConfirmation: result.requiresConfirmation || false,
      partialMatch: result.partialMatch || false,
      hasData: result.hasData || false,
      data: responseData // Send masked data for follow-up queries
    });

  } catch (error) {
    console.error('Intelligent Agent API error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      response: 'Sorry, I encountered an error. Please try again.'
    });
  }
});

// Get chatbot suggestions based on context
router.get('/chatbot/suggestions/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;

    // Generate suggestions based on restaurant context
    const suggestions = [
      'Add one paneer and one burger',
      'Place this order to kitchen',
      'Search order ID 2',
      'Show available tables',
      'Book table 5 for 4 people',
      'Clear cart',
      'Show vegetarian menu items',
      'What is the status of order 3?'
    ];

    res.json({
      success: true,
      suggestions
    });

  } catch (error) {
    console.error('Suggestions API error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Chatbot conversation history
router.get('/chatbot/history/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const limit = parseInt(req.query.limit) || 10;

    // Get conversation history from database
    const historySnapshot = await admin.firestore()
      .collection('restaurants')
      .doc(restaurantId)
      .collection('chatbot_conversations')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const conversations = [];
    historySnapshot.forEach(doc => {
      conversations.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({
      success: true,
      conversations: conversations.reverse() // Show oldest first
    });

  } catch (error) {
    console.error('History API error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Save chatbot conversation
router.post('/chatbot/save-conversation', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, query, response, intent } = req.body;
    const userId = req.user.userId;

    if (!restaurantId || !query || !response) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }

    const conversationData = {
      userId,
      query,
      response,
      intent,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      restaurantId
    };

    await admin.firestore()
      .collection('restaurants')
      .doc(restaurantId)
      .collection('chatbot_conversations')
      .add(conversationData);

    res.json({
      success: true,
      message: 'Conversation saved'
    });

  } catch (error) {
    console.error('Save conversation error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Context-aware suggestions endpoint (no OpenAI call — pure JS rules, <10ms)
router.post('/chatbot/suggestions', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, currentPage, platform, userRole, setupStatus } = req.body;
    const suggestions = [];

    // ── Setup-based global suggestions (highest priority) ──
    if (setupStatus) {
      if (!setupStatus.hasMenu || setupStatus.menuItemCount === 0) {
        suggestions.push({ text: 'Help me set up my menu', icon: '🍽️', priority: 0, category: 'setup' });
      }
      if (!setupStatus.hasPrinter) {
        suggestions.push({ text: 'Guide me through printer setup', icon: '🖨️', priority: 0, category: 'setup' });
      }
      if (!setupStatus.hasStaff) {
        suggestions.push({ text: 'How do I invite staff?', icon: '👥', priority: 1, category: 'setup' });
      }
      if (!setupStatus.hasTables) {
        suggestions.push({ text: 'Help me set up tables', icon: '🪑', priority: 1, category: 'setup' });
      }
      if (!setupStatus.businessType) {
        suggestions.push({ text: 'How do I choose my business type?', icon: '🏪', priority: 0, category: 'setup' });
      }
    }

    // ── Page-specific suggestions ──
    const pageRules = {
      '/home': [
        { text: 'What should I set up next?', icon: '🚀', priority: 2, category: 'onboarding' },
        { text: "What's today's revenue?", icon: '💰', priority: 3, category: 'data' },
      ],
      '/dashboard': [
        { text: 'How many orders today?', icon: '📊', priority: 2, category: 'data' },
        { text: "What's today's revenue?", icon: '💰', priority: 2, category: 'data' },
        { text: 'Show available tables', icon: '🪑', priority: 3, category: 'data' },
        { text: 'How do I place an order?', icon: '📋', priority: 4, category: 'help' },
      ],
      '/dashboard/v2': [
        { text: 'How many orders today?', icon: '📊', priority: 2, category: 'data' },
        { text: "What's today's revenue?", icon: '💰', priority: 2, category: 'data' },
        { text: 'Show available tables', icon: '🪑', priority: 3, category: 'data' },
      ],
      '/dashboard/bar': [
        { text: 'How many orders today?', icon: '📊', priority: 2, category: 'data' },
        { text: "What's today's revenue?", icon: '💰', priority: 2, category: 'data' },
      ],
      '/menu': [
        setupStatus && (!setupStatus.hasMenu || setupStatus.menuItemCount === 0)
          ? { text: 'How do I upload my menu?', icon: '📤', priority: 1, category: 'help' }
          : { text: 'How do I set up variants (Half/Full)?', icon: '🔀', priority: 3, category: 'help' },
        { text: 'How do I add categories?', icon: '📂', priority: 3, category: 'help' },
        { text: 'How do I bulk upload items?', icon: '📋', priority: 3, category: 'help' },
      ],
      '/orderhistory': [
        { text: 'Show today\'s orders', icon: '📋', priority: 2, category: 'data' },
        { text: 'How do I edit a completed order?', icon: '✏️', priority: 3, category: 'help' },
        { text: 'Show cancelled orders', icon: '❌', priority: 4, category: 'data' },
      ],
      '/tables': [
        setupStatus && !setupStatus.hasTables
          ? { text: 'How do I create table layout?', icon: '🪑', priority: 1, category: 'help' }
          : { text: 'Show table status', icon: '🪑', priority: 2, category: 'data' },
        { text: 'How do I reserve a table?', icon: '📅', priority: 3, category: 'help' },
      ],
      '/inventory': [
        { text: 'How do I add inventory items?', icon: '📦', priority: 2, category: 'help' },
        { text: 'Show low stock items', icon: '⚠️', priority: 2, category: 'data' },
        { text: 'How do recipes work?', icon: '🧾', priority: 3, category: 'help' },
      ],
      '/customers': [
        { text: 'How do I set up loyalty program?', icon: '⭐', priority: 3, category: 'help' },
        { text: 'Show top customers', icon: '👥', priority: 2, category: 'data' },
      ],
      '/analytics': [
        { text: 'Show sales breakdown', icon: '📊', priority: 2, category: 'data' },
        { text: 'What are popular items?', icon: '🔥', priority: 2, category: 'data' },
      ],
      '/admin': [
        { text: 'How do I set up taxes?', icon: '💰', priority: 2, category: 'help' },
        setupStatus && !setupStatus.hasPrinter
          ? { text: 'Help me configure printer', icon: '🖨️', priority: 1, category: 'help' }
          : { text: 'How do I customize bill template?', icon: '🧾', priority: 3, category: 'help' },
        { text: 'How do I add staff?', icon: '👥', priority: 3, category: 'help' },
        { text: 'How do I enable/disable features?', icon: '⚙️', priority: 3, category: 'help' },
      ],
      '/kot': [
        { text: 'How does KOT printing work?', icon: '🖨️', priority: 2, category: 'help' },
        { text: 'Show pending kitchen orders', icon: '🍳', priority: 2, category: 'data' },
      ],
      '/hotel': [
        { text: 'How do I manage rooms?', icon: '🏨', priority: 2, category: 'help' },
        { text: 'Show room status', icon: '🛏️', priority: 2, category: 'data' },
      ],
      '/billing': [
        { text: 'How does billing work?', icon: '💳', priority: 2, category: 'help' },
        { text: 'How do I split a bill?', icon: '➗', priority: 3, category: 'help' },
      ],
      '/bookings': [
        { text: 'How do bookings work?', icon: '📅', priority: 2, category: 'help' },
        { text: 'How do I set up catering orders?', icon: '🍽️', priority: 3, category: 'help' },
      ],
      '/attendance': [
        { text: 'How does attendance tracking work?', icon: '⏰', priority: 2, category: 'help' },
      ],
      '/shifts': [
        { text: 'How do I schedule shifts?', icon: '📅', priority: 2, category: 'help' },
      ],
      '/shifts-cash': [
        { text: 'How does cash drawer tracking work?', icon: '💵', priority: 2, category: 'help' },
      ],
      '/dineai': [
        { text: 'How do I use voice ordering?', icon: '🎤', priority: 2, category: 'help' },
        { text: 'What can DineAI do?', icon: '🤖', priority: 3, category: 'help' },
      ],
      '/offers': [
        { text: 'How do I create a discount offer?', icon: '🏷️', priority: 2, category: 'help' },
      ],
      '/feedback': [
        { text: 'How do I set up feedback forms?', icon: '📝', priority: 2, category: 'help' },
      ],
      '/parking': [
        { text: 'How does parking management work?', icon: '🅿️', priority: 2, category: 'help' },
      ],
      '/sales-summary': [
        { text: 'Show today\'s sales report', icon: '📊', priority: 2, category: 'data' },
        { text: 'How do I export reports?', icon: '📤', priority: 3, category: 'help' },
      ],
      '/books': [
        { text: 'How do I track expenses?', icon: '💸', priority: 2, category: 'help' },
        { text: 'Show profit & loss', icon: '📊', priority: 2, category: 'data' },
      ],
      '/headquarters': [
        { text: 'How do I manage multiple locations?', icon: '🏢', priority: 2, category: 'help' },
      ],
    };

    // Match page — try exact match first, then prefix match
    let pageSpecific = pageRules[currentPage];
    if (!pageSpecific && currentPage) {
      const prefix = Object.keys(pageRules).find(p => currentPage.startsWith(p) && p !== '/');
      if (prefix) pageSpecific = pageRules[prefix];
    }

    if (pageSpecific) {
      suggestions.push(...pageSpecific.filter(Boolean));
    }

    // ── Time-based suggestions ──
    const hour = new Date().getHours();
    if (hour >= 22 || hour < 2) {
      suggestions.push({ text: 'Show end-of-day summary', icon: '🌙', priority: 2, category: 'data' });
    }
    if (hour >= 6 && hour < 10) {
      suggestions.push({ text: 'What\'s the plan for today?', icon: '☀️', priority: 4, category: 'help' });
    }

    // ── Role-based filtering ──
    // Remove data suggestions for kitchen/delivery roles who can't see analytics
    const dataRoles = ['owner', 'admin', 'manager', 'cashier'];
    const filtered = suggestions.filter(s => {
      if (s.category === 'data' && userRole && !dataRoles.includes(userRole)) return false;
      return true;
    });

    // Deduplicate by text, sort by priority, limit to 6
    const seen = new Set();
    const deduped = filtered.filter(s => {
      if (seen.has(s.text)) return false;
      seen.add(s.text);
      return true;
    });
    deduped.sort((a, b) => a.priority - b.priority);

    res.json({
      success: true,
      suggestions: deduped.slice(0, 6)
    });
  } catch (error) {
    console.error('Suggestions error:', error);
    res.json({ success: true, suggestions: [] });
  }
});

module.exports = router;
