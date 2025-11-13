const { OpenAI } = require('openai');
const admin = require('firebase-admin');

class ChatbotRAGService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    // Restaurant context cache
    this.restaurantContexts = new Map();
    
    // Intent patterns for classification
    this.intentPatterns = {
      table_management: [
        'book table', 'reserve table', 'table available', 'table status',
        'assign table', 'free table', 'table booking', 'table reservation'
      ],
      menu_query: [
        'menu', 'food', 'dish', 'price', 'available', 'vegetarian', 'non-veg',
        'spicy', 'category', 'appetizer', 'main course', 'dessert'
      ],
      order_management: [
        'place order', 'add to cart', 'remove item', 'order status',
        'bill', 'payment', 'checkout', 'order history'
      ],
      restaurant_info: [
        'timings', 'hours', 'contact', 'address', 'phone', 'email',
        'location', 'about', 'description'
      ],
      booking: [
        'book', 'reserve', 'appointment', 'schedule', 'availability'
      ]
    };
  }

  // Step 1: Intent Classification (Cost: ~50 tokens)
  async classifyIntent(query) {
    try {
      const prompt = `Classify this restaurant query into one of these intents:
      - table_management: Table booking, reservation, status
      - menu_query: Menu items, prices, availability
      - order_management: Placing orders, cart management
      - restaurant_info: Restaurant details, timings, contact
      - booking: General booking requests
      
      Query: "${query}"
      
      Respond with only the intent name.`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 10,
        temperature: 0
      });

      return response.choices[0].message.content.trim();
    } catch (error) {
      console.error('Intent classification error:', error);
      return 'general';
    }
  }

  // Step 2: Context Retrieval (Cost: ~200-500 tokens)
  async getRelevantContext(intent, restaurantId, query) {
    try {
      // Get restaurant-specific context
      const restaurantContext = await this.getRestaurantContext(restaurantId);
      
      // Get relevant data based on intent
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

      return {
        restaurant: restaurantContext,
        relevantData,
        intent
      };
    } catch (error) {
      console.error('Context retrieval error:', error);
      return null;
    }
  }

  // Step 3: Dynamic Query Generation (Cost: ~100-300 tokens)
  async generateResponse(query, context, restaurantId) {
    try {
      const { intent, restaurant, relevantData } = context;
      
      const systemPrompt = `You are a restaurant management assistant. Generate appropriate responses and actions based on the query.

Restaurant Info: ${JSON.stringify(restaurant)}
Relevant Data: ${JSON.stringify(relevantData)}
Intent: ${intent}

Available Actions:
- For table management: Use table API endpoints
- For menu queries: Use menu API endpoints  
- For orders: Use order API endpoints
- For restaurant info: Provide direct information

Respond with JSON format:
{
  "action": "api_call|direct_response|clarification",
  "endpoint": "API endpoint if applicable",
  "method": "GET|POST|PUT|DELETE",
  "payload": "Request payload if applicable",
  "response": "Direct response if applicable",
  "requiresConfirmation": boolean
}`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query }
        ],
        max_tokens: 500,
        temperature: 0.1
      });

      return JSON.parse(response.choices[0].message.content);
    } catch (error) {
      console.error('Response generation error:', error);
      return {
        action: "direct_response",
        response: "I'm sorry, I couldn't process your request. Please try again.",
        requiresConfirmation: false
      };
    }
  }

  // Helper Methods
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
        .get();

      const tables = [];
      tablesSnapshot.forEach(doc => {
        tables.push({
          id: doc.id,
          ...doc.data()
        });
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
        .get();

      const menuItems = [];
      menuSnapshot.forEach(doc => {
        menuItems.push({
          id: doc.id,
          ...doc.data()
        });
      });

      // Filter relevant items based on query
      const relevantItems = menuItems.filter(item => 
        item.name.toLowerCase().includes(query.toLowerCase()) ||
        item.description.toLowerCase().includes(query.toLowerCase()) ||
        item.category.toLowerCase().includes(query.toLowerCase())
      );

      return {
        menuItems: relevantItems.slice(0, 10), // Limit to 10 items
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
        .limit(10)
        .get();

      const orders = [];
      ordersSnapshot.forEach(doc => {
        orders.push({
          id: doc.id,
          ...doc.data()
        });
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

  // Main method to process chatbot queries
  async processQuery(query, restaurantId, userId = null) {
    try {
      console.log(`🤖 Processing query: "${query}" for restaurant: ${restaurantId}`);
      
      // Step 1: Classify intent
      const intent = await this.classifyIntent(query);
      console.log(`🎯 Intent classified as: ${intent}`);
      
      // Step 2: Get relevant context
      const context = await this.getRelevantContext(intent, restaurantId, query);
      if (!context) {
        throw new Error('Failed to retrieve context');
      }
      
      // Step 3: Generate response
      const response = await this.generateResponse(query, context, restaurantId);
      console.log(`✅ Generated response:`, response);
      
      return {
        success: true,
        intent,
        response,
        context: {
          restaurant: context.restaurant?.name,
          dataAvailable: Object.keys(context.relevantData).length > 0
        }
      };
      
    } catch (error) {
      console.error('❌ Chatbot processing error:', error);
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

  // Execute the generated action
  async executeAction(action, restaurantId, userId = null) {
    try {
      const { endpoint, method, payload } = action;
      
      if (!endpoint) {
        return { success: true, data: action.response };
      }

      // Here you would implement the actual API calls
      // For now, return a placeholder
      return {
        success: true,
        data: `Action executed: ${method} ${endpoint}`,
        payload
      };
      
    } catch (error) {
      console.error('Action execution error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = ChatbotRAGService;



