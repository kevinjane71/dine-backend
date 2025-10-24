const express = require('express');
const router = express.Router();
const ChatbotRAGService = require('../services/chatbotRAG');
const EnhancedRAGService = require('../services/enhancedRAGService');
const { authenticateToken } = require('../middleware/auth');
const { authenticateRAGAccess } = require('../middleware/ragSecurity');

const chatbotRAG = new ChatbotRAGService();
const enhancedRAG = new EnhancedRAGService();

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

// Get chatbot suggestions based on context
router.get('/chatbot/suggestions/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;

    // Generate suggestions based on restaurant context
    const suggestions = [
      'Show me the menu',
      'Book a table',
      'Show available tables',
      'Place an order',
      'What are your opening hours?',
      'Show vegetarian options',
      'Reserve table for 4 people',
      'What dishes do you recommend?'
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
