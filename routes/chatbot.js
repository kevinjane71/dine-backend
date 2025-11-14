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

    // Process query with function calling agent
    const result = await functionCallingAgent.processQuery(query, restaurantId, userId, conversationHistory);

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

module.exports = router;
