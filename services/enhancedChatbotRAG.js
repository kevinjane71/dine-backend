const { OpenAI } = require('openai');
const admin = require('firebase-admin');
const TokenOptimizationService = require('./tokenOptimization');

class EnhancedChatbotRAGService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    this.tokenOptimizer = new TokenOptimizationService();
    this.restaurantContexts = new Map();
    
    // Enhanced intent patterns with confidence scoring
    this.intentPatterns = {
      table_management: {
        keywords: ['book', 'reserve', 'table', 'seat', 'available', 'assign', 'free'],
        confidence: 0.8,
        costWeight: 'medium'
      },
      menu_query: {
        keywords: ['menu', 'food', 'dish', 'price', 'vegetarian', 'spicy', 'category'],
        confidence: 0.9,
        costWeight: 'low'
      },
      order_management: {
        keywords: ['order', 'cart', 'bill', 'payment', 'checkout', 'add', 'remove'],
        confidence: 0.85,
        costWeight: 'high'
      },
      restaurant_info: {
        keywords: ['timings', 'hours', 'contact', 'address', 'phone', 'about'],
        confidence: 0.95,
        costWeight: 'low'
      },
      booking: {
        keywords: ['book', 'reserve', 'appointment', 'schedule'],
        confidence: 0.7,
        costWeight: 'medium'
      }
    };
  }

  // Enhanced intent classification with confidence scoring
  async classifyIntent(query) {
    try {
      // First try rule-based classification (free)
      const ruleBasedIntent = this.ruleBasedClassification(query);
      if (ruleBasedIntent.confidence > 0.8) {
        return ruleBasedIntent.intent;
      }

      // Fall back to AI classification if confidence is low
      const prompt = `Classify this restaurant query. Respond with only the intent name:
      - table_management: Table booking, reservation, status
      - menu_query: Menu items, prices, availability  
      - order_management: Placing orders, cart management
      - restaurant_info: Restaurant details, timings, contact
      - booking: General booking requests
      
      Query: "${query}"`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 10,
        temperature: 0
      });

      const intent = response.choices[0].message.content.trim();
      
      // Track token usage
      await this.tokenOptimizer.trackTokenUsage(
        'system', 'gpt-3.5-turbo', 
        prompt.length / 4, // Rough token estimate
        response.usage?.completion_tokens || 10,
        this.tokenOptimizer.calculateCost('gpt-3.5-turbo', prompt.length / 4, response.usage?.completion_tokens || 10)
      );

      return intent;
    } catch (error) {
      console.error('Intent classification error:', error);
      return 'general';
    }
  }

  // Rule-based classification (cost-free)
  ruleBasedClassification(query) {
    const queryLower = query.toLowerCase();
    let bestMatch = { intent: 'general', confidence: 0 };

    for (const [intent, pattern] of Object.entries(this.intentPatterns)) {
      const matches = pattern.keywords.filter(keyword => 
        queryLower.includes(keyword)
      ).length;
      
      const confidence = matches / pattern.keywords.length;
      
      if (confidence > bestMatch.confidence) {
        bestMatch = { intent, confidence };
      }
    }

    return bestMatch;
  }

  // Smart context retrieval with cost optimization
  async getRelevantContext(intent, restaurantId, query) {
    try {
      // Check cache first
      const cachedResponse = await this.tokenOptimizer.getCachedResponse(restaurantId, query);
      if (cachedResponse) {
        return cachedResponse;
      }

      // Check daily limits
      const limitCheck = await this.tokenOptimizer.checkDailyLimit(restaurantId, 'gpt-3.5-turbo');
      if (!limitCheck.withinLimit) {
        console.log(`⚠️ Daily limit exceeded for restaurant ${restaurantId}`);
        return this.getMinimalContext(intent, restaurantId);
      }

      // Get optimized context
      const optimization = await this.tokenOptimizer.optimizeContext(restaurantId, intent, query);
      if (optimization.optimized) {
        return optimization.context;
      }

      // Get full context
      const restaurantContext = await this.getRestaurantContext(restaurantId);
      let relevantData = {};

      switch (intent) {
        case 'table_management':
          relevantData = await this.getTableContext(restaurantId);
          break;
        case 'menu_query':
          relevantData = await this.getMenuContext(restaurantId, query);
          break;
        case 'order_management':
          relevantData = await this.getOrderContext(restaurantId);
          break;
        case 'restaurant_info':
          relevantData = restaurantContext;
          break;
        default:
          relevantData = restaurantContext;
      }

      const context = {
        restaurant: restaurantContext,
        relevantData,
        intent,
        timestamp: Date.now()
      };

      // Cache the context
      await this.tokenOptimizer.cacheResponse(restaurantId, query, context);

      return context;
    } catch (error) {
      console.error('Context retrieval error:', error);
      return this.getMinimalContext(intent, restaurantId);
    }
  }

  // Enhanced response generation with dynamic API calls
  async generateResponse(query, context, restaurantId) {
    try {
      const { intent, restaurant, relevantData } = context;
      
      // Create dynamic API mapping based on intent
      const apiMapping = this.createAPIMapping(intent, relevantData);
      
      const systemPrompt = `You are a restaurant management assistant. Generate appropriate responses and actions.

Restaurant: ${restaurant?.name || 'Restaurant'}
Intent: ${intent}
Available APIs: ${JSON.stringify(apiMapping)}

Respond with JSON:
{
  "action": "api_call|direct_response|clarification",
  "endpoint": "API endpoint",
  "method": "GET|POST|PUT|DELETE", 
  "payload": "Request data",
  "response": "User-friendly response",
  "requiresConfirmation": boolean,
  "suggestions": ["Follow-up suggestions"]
}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query }
        ],
        max_tokens: 400,
        temperature: 0.1
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      // Track token usage
      await this.tokenOptimizer.trackTokenUsage(
        restaurantId, 'gpt-3.5-turbo',
        systemPrompt.length / 4 + query.length / 4,
        response.usage?.completion_tokens || 50,
        this.tokenOptimizer.calculateCost('gpt-3.5-turbo', 
          systemPrompt.length / 4 + query.length / 4, 
          response.usage?.completion_tokens || 50)
      );

      return result;
    } catch (error) {
      console.error('Response generation error:', error);
      return {
        action: "direct_response",
        response: "I'm sorry, I couldn't process your request. Please try again.",
        requiresConfirmation: false
      };
    }
  }

  // Create dynamic API mapping based on context
  createAPIMapping(intent, relevantData) {
    const baseURL = process.env.API_BASE_URL || 'https://dine-backend-lake.vercel.app/api';
    
    const mappings = {
      table_management: {
        'GET /tables': 'Get all tables',
        'POST /tables/book': 'Book a table',
        'PUT /tables/:id/status': 'Update table status',
        'DELETE /tables/:id': 'Free a table'
      },
      menu_query: {
        'GET /menu': 'Get menu items',
        'GET /menu/category/:category': 'Get items by category',
        'GET /menu/search': 'Search menu items'
      },
      order_management: {
        'POST /orders': 'Place new order',
        'GET /orders': 'Get orders',
        'PUT /orders/:id': 'Update order',
        'DELETE /orders/:id': 'Cancel order'
      },
      restaurant_info: {
        'GET /restaurant': 'Get restaurant info',
        'PUT /restaurant': 'Update restaurant info'
      }
    };

    return mappings[intent] || mappings['restaurant_info'];
  }

  // Execute dynamic API calls
  async executeAPICall(endpoint, method, payload, restaurantId) {
    try {
      const baseURL = process.env.API_BASE_URL || 'https://dine-backend-lake.vercel.app/api';
      const url = `${baseURL}${endpoint}`;
      
      const options = {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.API_SECRET_KEY}` // Add your API key
        }
      };

      if (payload && (method === 'POST' || method === 'PUT')) {
        options.body = JSON.stringify(payload);
      }

      const response = await fetch(url, options);
      const data = await response.json();

      return {
        success: response.ok,
        data,
        status: response.status
      };

    } catch (error) {
      console.error('API call error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Main processing method with full pipeline
  async processQuery(query, restaurantId, userId = null) {
    try {
      console.log(`🤖 Enhanced RAG processing: "${query}" for restaurant: ${restaurantId}`);
      
      // Step 1: Intent classification
      const intent = await this.classifyIntent(query);
      console.log(`🎯 Intent: ${intent}`);
      
      // Step 2: Context retrieval
      const context = await this.getRelevantContext(intent, restaurantId, query);
      console.log(`📚 Context retrieved: ${Object.keys(context).length} fields`);
      
      // Step 3: Response generation
      const response = await this.generateResponse(query, context, restaurantId);
      console.log(`✅ Response generated: ${response.action}`);
      
      // Step 4: Execute action if needed
      let executionResult = null;
      if (response.action === 'api_call' && response.endpoint) {
        executionResult = await this.executeAPICall(
          response.endpoint, 
          response.method, 
          response.payload, 
          restaurantId
        );
        console.log(`🔧 API executed: ${response.method} ${response.endpoint}`);
      }

      // Step 5: Save conversation
      await this.saveConversation(restaurantId, userId, query, response, intent);

      return {
        success: true,
        intent,
        response,
        execution: executionResult,
        context: {
          restaurant: context.restaurant?.name,
          dataAvailable: Object.keys(context.relevantData).length > 0,
          cached: context.timestamp ? true : false
        }
      };
      
    } catch (error) {
      console.error('❌ Enhanced RAG processing error:', error);
      return {
        success: false,
        error: error.message,
        response: {
          action: "direct_response",
          response: "I'm sorry, I encountered an error processing your request. Please try again.",
          requiresConfirmation: false
        }
      };
    }
  }

  // Save conversation for learning
  async saveConversation(restaurantId, userId, query, response, intent) {
    try {
      const conversationData = {
        userId: userId || 'anonymous',
        query,
        response,
        intent,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        restaurantId,
        success: true
      };

      await admin.firestore()
        .collection('restaurants')
        .doc(restaurantId)
        .collection('chatbot_conversations')
        .add(conversationData);

    } catch (error) {
      console.error('Save conversation error:', error);
    }
  }

  // Helper methods (same as before but optimized)
  async getRestaurantContext(restaurantId) {
    if (this.restaurantContexts.has(restaurantId)) {
      return this.restaurantContexts.get(restaurantId);
    }

    try {
      const restaurantDoc = await admin.firestore()
        .collection('restaurants')
        .doc(restaurantId)
        .get();

      if (restaurantDoc.exists) {
        const data = restaurantDoc.data();
        const context = {
          name: data.name,
          description: data.description,
          address: data.address,
          phone: data.phone,
          email: data.email,
          timings: data.timings || '9:00 AM - 10:00 PM',
          features: data.features || []
        };
        
        this.restaurantContexts.set(restaurantId, context);
        return context;
      }
    } catch (error) {
      console.error('Error fetching restaurant context:', error);
    }

    return null;
  }

  async getTableContext(restaurantId) {
    try {
      const tablesSnapshot = await admin.firestore()
        .collection('restaurants')
        .doc(restaurantId)
        .collection('tables')
        .limit(20) // Limit for cost optimization
        .get();

      const tables = [];
      tablesSnapshot.forEach(doc => {
        tables.push({ id: doc.id, ...doc.data() });
      });

      return {
        tables,
        totalTables: tables.length,
        availableTables: tables.filter(t => t.status === 'available').length
      };
    } catch (error) {
      console.error('Error fetching table context:', error);
      return { tables: [], totalTables: 0, availableTables: 0 };
    }
  }

  async getMenuContext(restaurantId, query) {
    try {
      const menuSnapshot = await admin.firestore()
        .collection('restaurants')
        .doc(restaurantId)
        .collection('menu')
        .limit(15) // Limit for cost optimization
        .get();

      const menuItems = [];
      menuSnapshot.forEach(doc => {
        menuItems.push({ id: doc.id, ...doc.data() });
      });

      // Smart filtering based on query
      const relevantItems = menuItems.filter(item => 
        item.name.toLowerCase().includes(query.toLowerCase()) ||
        item.description.toLowerCase().includes(query.toLowerCase()) ||
        item.category.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 8); // Further limit for cost

      return {
        menuItems: relevantItems,
        totalItems: menuItems.length,
        categories: [...new Set(menuItems.map(item => item.category))]
      };
    } catch (error) {
      console.error('Error fetching menu context:', error);
      return { menuItems: [], totalItems: 0, categories: [] };
    }
  }

  async getOrderContext(restaurantId) {
    try {
      const ordersSnapshot = await admin.firestore()
        .collection('restaurants')
        .doc(restaurantId)
        .collection('orders')
        .where('status', 'in', ['pending', 'preparing', 'ready'])
        .limit(5) // Limit for cost optimization
        .get();

      const orders = [];
      ordersSnapshot.forEach(doc => {
        orders.push({ id: doc.id, ...doc.data() });
      });

      return {
        activeOrders: orders,
        orderCount: orders.length
      };
    } catch (error) {
      console.error('Error fetching order context:', error);
      return { activeOrders: [], orderCount: 0 };
    }
  }

  async getMinimalContext(intent, restaurantId) {
    return {
      restaurant: { name: 'Restaurant' },
      relevantData: { message: 'Use API endpoints for detailed information' },
      intent,
      minimal: true
    };
  }
}

module.exports = EnhancedChatbotRAGService;



