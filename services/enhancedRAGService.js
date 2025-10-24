const admin = require('firebase-admin');
const OpenAI = require('openai');
const FirebaseEmbeddingsRAGService = require('./firebaseEmbeddingsRAG');

class EnhancedRAGService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
    this.ragService = new FirebaseEmbeddingsRAGService();
    this.db = admin.firestore();
  }

  // Main RAG processing method
  async processQuery(query, restaurantId, userId = null) {
    try {
      console.log(`🔍 Enhanced RAG processing: "${query}" for restaurant ${restaurantId}`);
      
      // Step 1: Check if RAG knowledge exists, if not create it
      const hasRAGKnowledge = await this.ragService.hasRAGKnowledge(restaurantId);
      if (!hasRAGKnowledge) {
        console.log(`🔄 No RAG knowledge found, initializing for restaurant ${restaurantId}`);
        await this.ragService.storeRestaurantKnowledge(restaurantId);
      }

      // Step 2: Intent Classification (Lightweight)
      const intent = await this.classifyIntent(query);
      console.log(`🎯 Detected intent: ${intent}`);

      // Step 3: Search RAG Database - SECURE VERSION
      const ragResults = await this.ragService.searchRAGDatabase(query, restaurantId, userId);
      console.log(`🔍 Found ${ragResults.length} relevant knowledge chunks`);

      // Step 4: Generate response with RAG context
      const response = await this.generateResponseWithRAG(query, intent, ragResults, restaurantId);

          // Step 5: Execute API if needed
          let executionResult = null;
          let finalResponse = response;
          
          if (response.action === 'api_call') {
            executionResult = await this.executeAPICall(response.endpoint, response.method, response.payload, restaurantId);
            console.log(`🔧 API executed: ${response.method} ${response.endpoint}`);
            
            // Generate a meaningful response based on the API result
            if (executionResult.success) {
              finalResponse = await this.generateMeaningfulResponse(query, intent, executionResult.data, response.endpoint, response.method);
            } else {
              finalResponse = {
                action: "direct_response",
                response: `Sorry, I couldn't fetch that information: ${executionResult.error}`,
                requiresConfirmation: false
              };
            }
          }

      // Step 6: Save conversation for learning
      await this.saveConversation(restaurantId, userId, query, response, intent);

      return {
        success: true,
        intent,
        response: finalResponse,
        execution: executionResult,
        ragContext: ragResults,
        context: {
          restaurant: await this.getRestaurantName(restaurantId),
          dataAvailable: ragResults.length > 0,
          cached: false
        }
      };

    } catch (error) {
      console.error('Enhanced RAG processing error:', error);
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

  // Generate response using RAG context
  async generateResponseWithRAG(query, intent, ragResults, restaurantId) {
    try {
      // Build context from RAG results
      const ragContext = this.buildRAGContext(ragResults);
      
      const systemPrompt = `You are a helpful restaurant assistant for ${await this.getRestaurantName(restaurantId)}. 

RAG CONTEXT (from database):
${ragContext}

Based on the user's query and the RAG context, generate a response.
If an API call is needed, respond in JSON format:
{
  "action": "api_call",
  "endpoint": "/api/...",
  "method": "GET", 
  "payload": {},
  "response": "I'll fetch that information for you.",
  "requiresConfirmation": false
}

If no API call is needed:
{
  "action": "direct_response",
  "response": "Your direct answer",
  "requiresConfirmation": false
}

IMPORTANT: 
- For table status queries (show tables, how many tables), use endpoint "/api/tables" with method "GET"
- For table status updates (mark table X as Y, set table X to Y), use endpoint "/api/tables" with method "PATCH" and payload {"tableName": "X", "status": "Y"}
- For menu-related queries, always use endpoint "/api/menu" with method "GET"
- For order-related queries, always use endpoint "/api/orders" with method "GET"

Table status values: available, occupied, reserved, out-of-service, cleaning`;

      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: query }
        ],
        max_tokens: 300,
        temperature: 0.1
      });

      const parsedResponse = JSON.parse(response.choices[0].message.content);
      
      // Add suggestions based on intent
      parsedResponse.suggestions = this.generateSuggestions(intent, ragResults);
      
      return parsedResponse;

    } catch (error) {
      console.error('RAG response generation error:', error);
      return {
        action: "direct_response",
        response: "I'm sorry, I couldn't process your request. Please try again.",
        requiresConfirmation: false
      };
    }
  }

  // Build context from RAG results
  buildRAGContext(ragResults) {
    let context = '';
    
    ragResults.forEach(result => {
      context += `${result.type.toUpperCase()}: ${result.text}\n`;
      if (result.fields.length > 0) {
        context += `Related fields: ${result.fields.join(', ')}\n`;
      }
      if (result.apiEndpoint) {
        context += `API endpoint: ${result.apiEndpoint}\n`;
      }
      context += `Relevance: ${(result.score * 100).toFixed(1)}%\n\n`;
    });

    return context;
  }

  // Lightweight intent classification
  async classifyIntent(query) {
    const queryLower = query.toLowerCase();
    
    // Rule-based classification first (free)
    if (queryLower.includes('menu') || queryLower.includes('dish') || queryLower.includes('food') || queryLower.includes('item')) {
      return 'menu_query';
    }
    if (queryLower.includes('table') && (queryLower.includes('book') || queryLower.includes('reserve'))) {
      return 'table_booking';
    }
    if (queryLower.includes('order') && (queryLower.includes('place') || queryLower.includes('add'))) {
      return 'order_placement';
    }
    if (queryLower.includes('table') && (queryLower.includes('show') || queryLower.includes('status') || queryLower.includes('available'))) {
      return 'table_management';
    }
    if (queryLower.includes('open') || queryLower.includes('hours') || queryLower.includes('time') || queryLower.includes('contact')) {
      return 'restaurant_info';
    }
    
    // Fallback to AI classification for complex queries
    try {
      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { 
            role: "user", 
            content: `Classify this restaurant query into one of these categories: menu_query, table_booking, order_placement, table_management, restaurant_info, general_query. Query: "${query}"` 
          }
        ],
        max_tokens: 20,
        temperature: 0
      });

      const intent = response.choices[0].message.content.trim().toLowerCase();
      return intent.replace(' ', '_');
      
    } catch (error) {
      console.error('AI intent classification error:', error);
      return 'general_query';
    }
  }

  // Execute API call - Direct database access instead of HTTP requests
  async executeAPICall(endpoint, method, payload, restaurantId) {
    try {
      console.log(`🔄 Executing API: ${method} ${endpoint}`, payload);
      
      // Direct database access instead of HTTP requests
      if (endpoint === '/api/tables') {
        if (method === 'GET') {
          return await this.getTablesData(restaurantId);
        } else if (method === 'PATCH' || method === 'PUT') {
          return await this.updateTableStatus(restaurantId, payload);
        }
      } else if (endpoint === '/api/menu') {
        return await this.getMenuData(restaurantId);
      } else if (endpoint === '/api/orders') {
        return await this.getOrdersData(restaurantId);
      } else if (endpoint === '/api/restaurants') {
        return await this.getRestaurantData(restaurantId);
      }
      
      // For other endpoints, return a generic response
      return {
        success: true,
        data: { message: 'API call executed successfully' }
      };
      
    } catch (error) {
      console.error('API execution error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get tables data directly from database - New structure
  async getTablesData(restaurantId) {
    try {
      // Get floors from restaurant subcollection
      const floorsSnapshot = await this.db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .get();

      let allTables = [];
      
      for (const floorDoc of floorsSnapshot.docs) {
        const floorData = floorDoc.data();
        
        // Get tables for this floor
        const tablesSnapshot = await this.db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .doc(floorDoc.id)
          .collection('tables')
          .get();

        const floorTables = [];
        tablesSnapshot.forEach(tableDoc => {
          floorTables.push({
            id: tableDoc.id,
            ...tableDoc.data(),
            floor: floorData.name
          });
        });

        allTables = allTables.concat(floorTables);
      }

      return {
        success: true,
        data: {
          tables: allTables,
          totalTables: allTables.length,
          availableTables: allTables.filter(t => t.status === 'available').length,
          occupiedTables: allTables.filter(t => t.status === 'occupied').length,
          reservedTables: allTables.filter(t => t.status === 'reserved').length,
          outOfServiceTables: allTables.filter(t => t.status === 'out-of-service').length
        }
      };
    } catch (error) {
      console.error('Error fetching tables:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Update table status - Use new restaurant-centric structure
  async updateTableStatus(restaurantId, payload) {
    try {
      const { tableName, status } = payload;
      
      if (!tableName || !status) {
        return {
          success: false,
          error: 'Table name and status are required'
        };
      }

      // Find the table across all floors in the restaurant
      const floorsSnapshot = await this.db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .get();

      let targetTable = null;
      let targetFloor = null;
      
      for (const floorDoc of floorsSnapshot.docs) {
        const tablesSnapshot = await this.db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .doc(floorDoc.id)
          .collection('tables')
          .where('name', '==', tableName)
          .get();

        if (!tablesSnapshot.empty) {
          targetTable = tablesSnapshot.docs[0];
          targetFloor = floorDoc;
          break;
        }
      }

      if (!targetTable) {
        return {
          success: false,
          error: `Table ${tableName} not found`
        };
      }

      // Update the table status
      await targetTable.ref.update({
        status: status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const updatedTable = { id: targetTable.id, ...targetTable.data(), status };

      return {
        success: true,
        data: {
          message: `Table ${tableName} status updated to ${status}`,
          table: updatedTable,
          floor: targetFloor.data().name
        }
      };

    } catch (error) {
      console.error('Error updating table status:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get menu data directly from database
  async getMenuData(restaurantId) {
    try {
      const menuSnapshot = await this.db.collection('restaurants')
        .doc(restaurantId)
        .collection('menu')
        .get();

      const menuItems = menuSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      return {
        success: true,
        data: {
          menuItems: menuItems,
          totalItems: menuItems.length,
          vegItems: menuItems.filter(item => item.isVeg).length,
          nonVegItems: menuItems.filter(item => !item.isVeg).length
        }
      };
    } catch (error) {
      console.error('Error fetching menu:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get orders data directly from database
  async getOrdersData(restaurantId) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const ordersSnapshot = await this.db.collection('restaurants')
        .doc(restaurantId)
        .collection('orders')
        .where('createdAt', '>=', today)
        .get();

      const orders = ordersSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      return {
        success: true,
        data: {
          orders: orders,
          totalOrdersToday: orders.length,
          totalRevenue: orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0)
        }
      };
    } catch (error) {
      console.error('Error fetching orders:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Get restaurant data directly from database
  async getRestaurantData(restaurantId) {
    try {
      const restaurantDoc = await this.db.collection('restaurants')
        .doc(restaurantId)
        .get();

      if (!restaurantDoc.exists) {
        return {
          success: false,
          error: 'Restaurant not found'
        };
      }

      return {
        success: true,
        data: {
          restaurant: {
            id: restaurantDoc.id,
            ...restaurantDoc.data()
          }
        }
      };
    } catch (error) {
      console.error('Error fetching restaurant:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // Generate meaningful response based on API execution results
  async generateMeaningfulResponse(query, intent, apiData, endpoint, method = 'GET') {
    try {
      let response = "";
      
      if (endpoint === '/api/tables') {
        // Handle table updates (PATCH/PUT)
        if (method === 'PATCH' || method === 'PUT') {
          const { message, table, floor } = apiData;
          response = `✅ **${message}**\n\nTable ${table.name} on ${floor} is now **${table.status}**.`;
          return {
            action: "direct_response",
            response: response,
            requiresConfirmation: false
          };
        }
        
        // Handle table queries (GET)
        const { totalTables, availableTables, occupiedTables, reservedTables, outOfServiceTables, tables } = apiData;
        
        if (query.toLowerCase().includes('how many') && query.toLowerCase().includes('total')) {
          response = `You have **${totalTables} total tables** in your restaurant.`;
        } else if (query.toLowerCase().includes('available')) {
          response = `You have **${availableTables} available tables** out of ${totalTables} total tables.`;
        } else if (query.toLowerCase().includes('occupied')) {
          response = `You have **${occupiedTables} occupied tables** out of ${totalTables} total tables.`;
        } else if (query.toLowerCase().includes('reserved')) {
          response = `You have **${reservedTables} reserved tables** out of ${totalTables} total tables.`;
        } else if (query.toLowerCase().includes('out of service') || query.toLowerCase().includes('out-of-service')) {
          response = `You have **${outOfServiceTables} out-of-service tables** out of ${totalTables} total tables.`;
        } else {
          response = `Here's your table status:\n• **Total Tables:** ${totalTables}\n• **Available:** ${availableTables}\n• **Occupied:** ${occupiedTables}\n• **Reserved:** ${reservedTables}\n• **Out of Service:** ${outOfServiceTables}`;
        }
        
        // Add table details if requested
        if (query.toLowerCase().includes('show') || query.toLowerCase().includes('list')) {
          response += `\n\n**Table Details:**\n`;
          tables.forEach(table => {
            response += `• Table ${table.name}: ${table.status} (${table.capacity} seats) - ${table.floor}\n`;
          });
        }
        
      } else if (endpoint === '/api/menu') {
        const { totalItems, vegItems, nonVegItems, menuItems } = apiData;
        
        if (query.toLowerCase().includes('how many') && query.toLowerCase().includes('items')) {
          response = `You have **${totalItems} menu items** in total (${vegItems} vegetarian, ${nonVegItems} non-vegetarian).`;
        } else if (query.toLowerCase().includes('vegetarian') || query.toLowerCase().includes('veg')) {
          response = `You have **${vegItems} vegetarian items** out of ${totalItems} total menu items.`;
        } else {
          response = `Here's your menu summary:\n• **Total Items:** ${totalItems}\n• **Vegetarian:** ${vegItems}\n• **Non-Vegetarian:** ${nonVegItems}`;
        }
        
      } else if (endpoint === '/api/orders') {
        const { totalOrdersToday, totalRevenue, orders } = apiData;
        
        if (query.toLowerCase().includes('how many') && query.toLowerCase().includes('order')) {
          response = `You have **${totalOrdersToday} orders** today.`;
        } else if (query.toLowerCase().includes('revenue') || query.toLowerCase().includes('sales')) {
          response = `Today's revenue is **₹${totalRevenue}** from ${totalOrdersToday} orders.`;
        } else {
          response = `Today's order summary:\n• **Total Orders:** ${totalOrdersToday}\n• **Total Revenue:** ₹${totalRevenue}`;
        }
        
      } else {
        response = "I've retrieved the information you requested.";
      }
      
      return {
        action: "direct_response",
        response: response,
        requiresConfirmation: false
      };
      
    } catch (error) {
      console.error('Error generating meaningful response:', error);
      return {
        action: "direct_response",
        response: "I retrieved the information but couldn't format it properly.",
        requiresConfirmation: false
      };
    }
  }

  // Generate suggestions based on intent and context
  generateSuggestions(intent, ragResults) {
    const suggestions = {
      'menu_query': [
        'Show me vegetarian dishes',
        'What are the most popular items?',
        'Show me appetizers',
        'What\'s available under ₹200?'
      ],
      'table_booking': [
        'Book table for 4 people',
        'Reserve table number 5',
        'Show available tables',
        'Book a table for tonight'
      ],
      'order_placement': [
        'Place order for table 3',
        'Add biryani to cart',
        'Order food for table 5',
        'Show my current order'
      ],
      'table_management': [
        'Show all tables',
        'Which tables are available?',
        'Clean table 4',
        'Show occupied tables'
      ],
      'restaurant_info': [
        'What are your opening hours?',
        'What\'s your phone number?',
        'Where are you located?',
        'Tell me about the restaurant'
      ]
    };

    return suggestions[intent] || [
      'How can I help you?',
      'What would you like to know?',
      'Ask me anything about the restaurant'
    ];
  }

  // Save conversation for learning
  async saveConversation(restaurantId, userId, query, response, intent) {
    try {
      await this.db.collection('conversations').add({
        restaurantId,
        userId: userId || 'anonymous',
        query,
        response: response.response,
        intent,
        action: response.action,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error('Save conversation error:', error);
    }
  }

  // Get restaurant name
  async getRestaurantName(restaurantId) {
    try {
      const restaurantDoc = await this.db.collection('restaurants').doc(restaurantId).get();
      return restaurantDoc.exists ? restaurantDoc.data().name : 'Restaurant';
    } catch (error) {
      console.error('Get restaurant name error:', error);
      return 'Restaurant';
    }
  }

  // Initialize RAG knowledge for restaurant
  async initializeRAGKnowledge(restaurantId) {
    try {
      console.log(`🔄 Initializing RAG knowledge for restaurant ${restaurantId}`);
      await this.ragService.storeRestaurantKnowledge(restaurantId);
      return { success: true, message: 'RAG knowledge initialized successfully' };
    } catch (error) {
      console.error('RAG initialization error:', error);
      return { success: false, error: error.message };
    }
  }

  // Update RAG knowledge for restaurant
  async updateRAGKnowledge(restaurantId) {
    try {
      console.log(`🔄 Updating RAG knowledge for restaurant ${restaurantId}`);
      
      // Clear existing knowledge
      await this.ragService.clearRAGKnowledge(restaurantId);
      
      // Store new knowledge
      await this.ragService.storeRestaurantKnowledge(restaurantId);
      
      return { success: true, message: 'RAG knowledge updated successfully' };
    } catch (error) {
      console.error('RAG update error:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = EnhancedRAGService;
