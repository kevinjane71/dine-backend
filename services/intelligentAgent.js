const OpenAI = require('openai');
const { db, collections } = require('../firebase');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

class IntelligentAgentService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    
    // API Intent Mapping - Maps intents to backend endpoints
    this.apiMapping = {
      'add_to_cart': {
        endpoint: '/api/orders/add-to-cart',
        method: 'POST',
        requiredParams: ['items'],
        optionalParams: ['tableNumber', 'orderType'],
        permissions: ['orders'],
        description: 'Add items to cart'
      },
      'place_order': {
        endpoint: '/api/orders',
        method: 'POST',
        requiredParams: ['items'],
        optionalParams: ['tableNumber', 'orderType', 'paymentMethod', 'customerName', 'customerPhone'],
        permissions: ['orders'],
        description: 'Place order to kitchen'
      },
      'search_order': {
        endpoint: '/api/orders/:restaurantId',
        method: 'GET',
        requiredParams: ['orderId'],
        optionalParams: ['status', 'date'],
        permissions: ['orders'],
        description: 'Search for order by ID'
      },
      'search_menu': {
        endpoint: '/api/menus/:restaurantId',
        method: 'GET',
        requiredParams: [],
        optionalParams: ['category', 'search', 'isVeg'],
        permissions: ['menu'],
        description: 'Search menu items'
      },
      'get_tables': {
        endpoint: '/api/tables/:restaurantId',
        method: 'GET',
        requiredParams: [],
        optionalParams: ['status', 'floor'],
        permissions: ['tables'],
        description: 'Get tables information'
      },
      'book_table': {
        endpoint: '/api/tables/book',
        method: 'POST',
        requiredParams: ['tableNumber', 'partySize'],
        optionalParams: ['customerName', 'customerPhone', 'date', 'time'],
        permissions: ['tables'],
        description: 'Book a table'
      },
      'update_table_status': {
        endpoint: '/api/tables/:tableId',
        method: 'PATCH',
        requiredParams: ['tableId', 'status'],
        optionalParams: [],
        permissions: ['tables'],
        description: 'Update table status'
      },
      'cancel_order': {
        endpoint: '/api/orders/:orderId/cancel',
        method: 'PATCH',
        requiredParams: ['orderId'],
        optionalParams: ['reason'],
        permissions: ['orders'],
        description: 'Cancel an order'
      },
      'get_order_status': {
        endpoint: '/api/orders/:orderId',
        method: 'GET',
        requiredParams: ['orderId'],
        optionalParams: [],
        permissions: ['orders'],
        description: 'Get order status'
      },
      'clear_cart': {
        endpoint: 'UI_ACTION',
        method: 'UI',
        requiredParams: [],
        optionalParams: [],
        permissions: ['orders'],
        description: 'Clear the cart'
      }
    };
  }

  /**
   * Extract intent and parameters from user command using ChatGPT
   */
  async extractIntentAndParams(query, context = {}) {
    try {
      const systemPrompt = `You are an intelligent restaurant assistant that extracts intent and parameters from user commands.

Available intents:
- add_to_cart: Add items to cart (e.g., "one paneer and one burger", "add 2 pizzas")
- place_order: Place order to kitchen (e.g., "place this order", "send to kitchen", "place order")
- search_order: Search for order by ID (e.g., "search order 2", "find order ID 5")
- search_menu: Search menu items (e.g., "show vegetarian items", "what's on the menu")
- get_tables: Get tables information (e.g., "show tables", "available tables", "show available tables", "list tables")
- book_table: Book a table (e.g., "book table 5", "reserve table for 4")
- update_table_status: Update table status (e.g., "mark table 3 as available")
- cancel_order: Cancel an order (e.g., "cancel order 2")
- get_order_status: Get order status (e.g., "status of order 5")
- clear_cart: Clear the cart (e.g., "clear cart", "empty cart")

Return a JSON object with:
{
  "intent": "intent_name",
  "parameters": {
    "param1": "value1",
    "param2": "value2"
  },
  "missingParams": ["param1", "param2"], // if any required params are missing
  "confidence": 0.95 // confidence score 0-1
}

For items in add_to_cart or place_order, extract as:
{
  "items": [
    {"name": "paneer", "quantity": 1},
    {"name": "burger", "quantity": 1}
  ]
}

For order search, extract orderId as number (e.g., "order 2" -> orderId: 2).

Current context: ${JSON.stringify(context)}`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      return {
        success: true,
        intent: result.intent,
        parameters: result.parameters || {},
        missingParams: result.missingParams || [],
        confidence: result.confidence || 0.8
      };
    } catch (error) {
      console.error('Intent extraction error:', error);
      return {
        success: false,
        error: 'Failed to extract intent',
        intent: null,
        parameters: {},
        missingParams: []
      };
    }
  }

  /**
   * Check if user has permission for the action
   */
  async checkPermission(userId, restaurantId, intent) {
    try {
      const intentConfig = this.apiMapping[intent];
      if (!intentConfig || !intentConfig.permissions) {
        return { allowed: true }; // No permission check needed
      }

      // Get user's restaurant access
      const userRestaurantDoc = await db.collection(collections.userRestaurants)
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (userRestaurantDoc.empty) {
        return { allowed: false, reason: 'User does not have access to this restaurant' };
      }

      const userRestaurant = userRestaurantDoc.docs[0].data();
      const userRole = userRestaurant.role;
      const userPermissions = userRestaurant.permissions || [];

      // Owners and managers have all permissions
      if (userRole === 'owner' || userRole === 'manager') {
        return { allowed: true };
      }

      // Check if user has required permissions
      const requiredPermissions = intentConfig.permissions;
      const hasPermission = requiredPermissions.some(perm => 
        userPermissions.includes(perm)
      );

      if (!hasPermission) {
        return { 
          allowed: false, 
          reason: `You don't have permission to ${intentConfig.description}. Required: ${requiredPermissions.join(', ')}` 
        };
      }

      return { allowed: true };
    } catch (error) {
      console.error('Permission check error:', error);
      return { allowed: false, reason: 'Error checking permissions' };
    }
  }

  /**
   * Match menu items from query to actual menu items
   */
  async matchMenuItems(queryItems, restaurantId) {
    try {
      // Get restaurant menu
      const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      if (!restaurantDoc.exists) {
        return { success: false, error: 'Restaurant not found' };
      }

      const menuItems = restaurantDoc.data().menu?.items || [];
      
      const matchedItems = [];
      
      for (const queryItem of queryItems) {
        const itemName = queryItem.name.toLowerCase();
        let bestMatch = null;
        let bestScore = 0;

        // Fuzzy match against menu items
        for (const menuItem of menuItems) {
          const menuName = menuItem.name.toLowerCase();
          
          // Exact match
          if (menuName === itemName) {
            bestMatch = menuItem;
            bestScore = 1.0;
            break;
          }
          
          // Contains match
          if (menuName.includes(itemName) || itemName.includes(menuName)) {
            const score = Math.min(menuName.length, itemName.length) / Math.max(menuName.length, itemName.length);
            if (score > bestScore) {
              bestMatch = menuItem;
              bestScore = score;
            }
          }
        }

        if (bestMatch && bestScore > 0.3) {
          matchedItems.push({
            ...bestMatch,
            quantity: queryItem.quantity || 1
          });
        }
      }

      return {
        success: true,
        items: matchedItems,
        unmatched: queryItems.filter((q, idx) => !matchedItems[idx])
      };
    } catch (error) {
      console.error('Menu matching error:', error);
      return { success: false, error: 'Failed to match menu items' };
    }
  }

  /**
   * Mask PII data from response before sending to ChatGPT
   */
  maskPIIData(data) {
    if (!data || typeof data !== 'object') return data;
    
    const masked = JSON.parse(JSON.stringify(data)); // Deep clone
    
    // Recursively mask PII fields
    const maskField = (obj) => {
      if (Array.isArray(obj)) {
        return obj.map(item => maskField(item));
      }
      
      if (obj && typeof obj === 'object') {
        const maskedObj = {};
        for (const [key, value] of Object.entries(obj)) {
          const lowerKey = key.toLowerCase();
          
          // Mask user PII
          if (lowerKey.includes('phone') || lowerKey.includes('mobile') || lowerKey === 'phone') {
            maskedObj[key] = '***-***-****';
          } else if (lowerKey.includes('email')) {
            maskedObj[key] = '***@***.***';
          } else if (lowerKey.includes('name') && (lowerKey.includes('customer') || lowerKey.includes('user') || lowerKey === 'name')) {
            maskedObj[key] = '***';
          } else if (lowerKey.includes('address')) {
            maskedObj[key] = '***';
          } else if (lowerKey.includes('id') && (lowerKey.includes('customer') || lowerKey.includes('user'))) {
            maskedObj[key] = '***';
          } else if (lowerKey.includes('password') || lowerKey.includes('token') || lowerKey.includes('secret')) {
            maskedObj[key] = '***';
          } else if (typeof value === 'object') {
            maskedObj[key] = maskField(value);
          } else {
            maskedObj[key] = value;
          }
        }
        return maskedObj;
      }
      
      return obj;
    };
    
    return maskField(masked);
  }

  /**
   * Extract specific information from data using ChatGPT
   */
  async extractSpecificInfo(query, data, context = {}) {
    try {
      const maskedData = this.maskPIIData(data);
      
      // Map common synonyms for table statuses
      const statusMap = {
        'serving': 'occupied',
        'served': 'occupied',
        'busy': 'occupied',
        'free': 'available',
        'empty': 'available',
        'vacant': 'available'
      };
      
      // Replace synonyms in query for better understanding
      let processedQuery = query.toLowerCase();
      Object.entries(statusMap).forEach(([synonym, status]) => {
        processedQuery = processedQuery.replace(new RegExp(synonym, 'gi'), status);
      });
      
      const systemPrompt = `You are a helpful assistant that extracts specific information from data based on user queries.

The user has asked a follow-up question about data that was already fetched. Extract and format the answer based on the query.

IMPORTANT: Table status synonyms:
- "serving", "served", "busy" = "occupied"
- "free", "empty", "vacant" = "available"

Available data:
${JSON.stringify(maskedData, null, 2)}

Previous context: ${context.previousIntent || 'none'}

User query: "${query}"
Processed query: "${processedQuery}"

Return a JSON object with:
{
  "answer": "The direct answer to the user's question",
  "formatted": "A nicely formatted response for the user",
  "data": {} // Any specific data points extracted (optional)
}

Be concise and direct. If the user asks for counts, give numbers. If they ask for lists, provide the list.
If user asks "how many serving" or "how many busy", count tables with status "occupied".
If user asks "how many available" or "how many free", count tables with status "available".`;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: processedQuery }
        ],
        temperature: 0.2, // Lower temperature for more consistent extraction
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0].message.content);
      
      return {
        success: true,
        answer: result.answer,
        formatted: result.formatted || result.answer,
        extractedData: result.data || {}
      };
    } catch (error) {
      console.error('Extract specific info error:', error);
      return {
        success: false,
        error: 'Failed to extract information',
        formatted: 'Sorry, I could not extract that information. Please try rephrasing your question.'
      };
    }
  }

  /**
   * Check if query is asking for specific info from existing data
   */
  isDataQuery(query) {
    const dataQueryKeywords = [
      'how many', 'count', 'number of', 'total', 'list', 'show me',
      'which', 'what are', 'give me', 'tell me', 'only', 'just',
      'available', 'occupied', 'reserved', 'cleaning', 'out of service',
      'serving', 'served', 'busy', 'free', 'empty', 'vacant',
      'how much', 'what is', 'what\'s', 'get', 'fetch'
    ];
    
    const lowerQuery = query.toLowerCase().trim();
    
    // If query is very short (likely a follow-up), treat as data query
    if (lowerQuery.length < 20 && !lowerQuery.includes('add') && !lowerQuery.includes('place') && !lowerQuery.includes('order')) {
      return true;
    }
    
    return dataQueryKeywords.some(keyword => lowerQuery.includes(keyword));
  }

  /**
   * Process user query and return action to execute
   */
  async processQuery(query, restaurantId, userId, context = {}) {
    try {
      console.log('🔍 Processing query:', query);
      console.log('🔍 Context:', { hasPreviousData: !!context.previousData, previousIntent: context.previousIntent });
      
      // Check if this is a follow-up query about existing data
      // Priority: If we have previous data and query looks like a data question, use cached data
      // Also check if previous intent was get_tables and current query is asking about tables
      const isTableFollowUp = context.previousIntent === 'get_tables' && 
        (query.toLowerCase().includes('table') || query.toLowerCase().includes('serving') || 
         query.toLowerCase().includes('available') || query.toLowerCase().includes('occupied') ||
         query.toLowerCase().includes('busy') || query.toLowerCase().includes('free') ||
         query.toLowerCase().includes('how many') || query.toLowerCase().includes('count') ||
         query.toLowerCase().trim().length < 20);
      
      if (context.previousData && (this.isDataQuery(query) || isTableFollowUp)) {
        console.log('🔍 Detected data query with previous data, extracting specific info...');
        const extractionResult = await this.extractSpecificInfo(query, context.previousData, {
          ...context,
          query,
          previousIntent: context.previousIntent
        });
        
        if (extractionResult.success) {
          return {
            success: true,
            intent: 'data_query',
            parameters: {},
            apiConfig: {
              endpoint: 'N/A',
              method: 'DATA_QUERY',
              isUIAction: false
            },
            response: extractionResult.formatted,
            execution: {
              type: 'data_extraction',
              action: 'extract_info',
              params: {}
            },
            data: context.previousData, // Keep the same data for further follow-ups
            hasData: true
          };
        }
      }

      // Extract intent and parameters
      const extraction = await this.extractIntentAndParams(query, context);
      
      if (!extraction.success) {
        return {
          success: false,
          error: extraction.error,
          response: 'Sorry, I could not understand your request. Please try again.'
        };
      }

      const { intent, parameters, missingParams } = extraction;

      // Check if intent is valid
      if (!this.apiMapping[intent]) {
        return {
          success: false,
          error: 'Unknown intent',
          response: `I don't understand that command. Try: "add items to cart", "place order", "search order", etc.`
        };
      }

      // Check permissions
      const permissionCheck = await this.checkPermission(userId, restaurantId, intent);
      if (!permissionCheck.allowed) {
        return {
          success: false,
          error: 'Permission denied',
          response: permissionCheck.reason || 'You do not have permission to perform this action.',
          requiresPermission: true
        };
      }

      // Handle missing parameters
      if (missingParams.length > 0) {
        const intentConfig = this.apiMapping[intent];
        const missingParamNames = missingParams.map(param => {
          // Get human-readable name
          if (param === 'items') return 'menu items';
          if (param === 'orderId') return 'order ID';
          if (param === 'tableNumber') return 'table number';
          return param;
        });

        return {
          success: true,
          intent,
          requiresFollowUp: true,
          missingParams,
          response: `I need more information: ${missingParamNames.join(', ')}. Please provide these details.`,
          parameters: parameters
        };
      }

      // Match menu items if needed
      if (intent === 'add_to_cart' || intent === 'place_order') {
        if (parameters.items && parameters.items.length > 0) {
          const matchResult = await this.matchMenuItems(parameters.items, restaurantId);
          
          if (!matchResult.success) {
            return {
              success: false,
              error: matchResult.error,
              response: 'Failed to find menu items. Please check the menu and try again.'
            };
          }

          if (matchResult.items.length === 0) {
            return {
              success: false,
              error: 'No items matched',
              response: `I couldn't find those items in the menu. Please check the item names and try again.`,
              unmatched: matchResult.unmatched
            };
          }

          // Update parameters with matched items
          parameters.items = matchResult.items.map(item => ({
            id: item.id,
            name: item.name,
            quantity: item.quantity,
            price: item.price,
            category: item.category
          }));

          if (matchResult.unmatched && matchResult.unmatched.length > 0) {
            const unmatchedNames = matchResult.unmatched.map(u => u.name).join(', ');
            return {
              success: true,
              intent,
              parameters,
              partialMatch: true,
              response: `I found some items, but couldn't find: ${unmatchedNames}. Should I proceed with the items I found?`,
              requiresConfirmation: true
            };
          }
        }
      }

      // For get_tables intent, fetch actual data
      let tableData = null;
      if (intent === 'get_tables') {
        console.log(`📊 Processing get_tables intent for restaurant: ${restaurantId}`);
        const statusFilter = parameters.status || null;
        const fetchResult = await this.fetchTablesData(restaurantId, statusFilter);
        console.log(`📊 Fetch result:`, fetchResult.success ? `Success - ${fetchResult.stats?.total || 0} tables` : `Failed - ${fetchResult.error}`);
        if (fetchResult.success) {
          tableData = fetchResult;
          console.log(`📊 Table data stats:`, tableData.stats);
        } else {
          console.error(`❌ Failed to fetch tables:`, fetchResult.error);
        }
      }

      // Get API configuration
      const apiConfig = this.apiMapping[intent];

      // Generate base response
      let response = this.generateResponse(intent, parameters, tableData);
      
      // If we have data and user might want specific info, enhance response
      if (tableData && this.isDataQuery(query)) {
        const extractionResult = await this.extractSpecificInfo(query, tableData, {
          intent,
          parameters,
          query
        });
        
        if (extractionResult.success) {
          response = extractionResult.formatted;
        }
      }

      return {
        success: true,
        intent,
        parameters,
        apiConfig: {
          endpoint: apiConfig.endpoint,
          method: apiConfig.method,
          isUIAction: apiConfig.method === 'UI'
        },
        response: response,
        execution: {
          type: apiConfig.method === 'UI' ? 'ui_action' : 'api_call',
          action: intent,
          params: parameters
        },
        data: tableData, // Include table data in response for follow-up queries
        hasData: !!tableData // Flag to indicate data is available for follow-ups
      };
    } catch (error) {
      console.error('Process query error:', error);
      return {
        success: false,
        error: error.message,
        response: 'Sorry, I encountered an error. Please try again.'
      };
    }
  }

  /**
   * Fetch tables data from database
   */
  async fetchTablesData(restaurantId, statusFilter = null) {
    try {
      console.log(`🔍 Fetching tables for restaurant: ${restaurantId}, statusFilter: ${statusFilter}`);
      
      // Get floors from restaurant subcollection
      const floorsSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .get();

      console.log(`📊 Found ${floorsSnapshot.size} floors`);

      let allTables = [];
      
      for (const floorDoc of floorsSnapshot.docs) {
        const floorData = floorDoc.data();
        console.log(`🏢 Processing floor: ${floorData.name || floorDoc.id}`);
        
        // Get tables for this floor
        const tablesSnapshot = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .doc(floorDoc.id)
          .collection('tables')
          .get();

        console.log(`🪑 Found ${tablesSnapshot.size} tables on floor ${floorData.name || floorDoc.id}`);

        tablesSnapshot.forEach(tableDoc => {
          const tableData = tableDoc.data();
          console.log(`  - Table: ${tableData.name || tableDoc.id}, Status: ${tableData.status}`);
          
          if (!statusFilter || tableData.status === statusFilter) {
            allTables.push({
              id: tableDoc.id,
              ...tableData,
              floor: floorData.name || 'Unknown Floor'
            });
          }
        });
      }

      console.log(`✅ Total tables fetched: ${allTables.length}`);

      // Count by status
      const availableTables = allTables.filter(t => t.status === 'available');
      const occupiedTables = allTables.filter(t => t.status === 'occupied');
      const reservedTables = allTables.filter(t => t.status === 'reserved');
      const cleaningTables = allTables.filter(t => t.status === 'cleaning');
      const outOfServiceTables = allTables.filter(t => t.status === 'out-of-service');

      return {
        success: true,
        tables: allTables,
        stats: {
          total: allTables.length,
          available: availableTables.length,
          occupied: occupiedTables.length,
          reserved: reservedTables.length,
          cleaning: cleaningTables.length,
          outOfService: outOfServiceTables.length
        },
        byFloor: allTables.reduce((acc, table) => {
          const floor = table.floor || 'Unknown';
          if (!acc[floor]) {
            acc[floor] = { total: 0, available: 0, occupied: 0, reserved: 0 };
          }
          acc[floor].total++;
          if (table.status === 'available') acc[floor].available++;
          if (table.status === 'occupied') acc[floor].occupied++;
          if (table.status === 'reserved') acc[floor].reserved++;
          return acc;
        }, {})
      };
    } catch (error) {
      console.error('Error fetching tables:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate human-readable response
   */
  generateResponse(intent, parameters, data = null) {
    // If we have table data, format it nicely
    if (intent === 'get_tables' && data && data.stats) {
      const { stats, byFloor } = data;
      let response = `You have **${stats.available} available tables** out of ${stats.total} total tables.\n\n`;
      
      response += `**Table Status Summary:**\n`;
      response += `- Available: ${stats.available}\n`;
      response += `- Occupied: ${stats.occupied}\n`;
      response += `- Reserved: ${stats.reserved}\n`;
      if (stats.cleaning > 0) response += `- Cleaning: ${stats.cleaning}\n`;
      if (stats.outOfService > 0) response += `- Out of Service: ${stats.outOfService}\n`;
      
      if (Object.keys(byFloor).length > 0) {
        response += `\n**By Floor:**\n`;
        Object.entries(byFloor).forEach(([floor, floorStats]) => {
          response += `- ${floor}: ${floorStats.available} available, ${floorStats.occupied} occupied, ${floorStats.reserved} reserved\n`;
        });
      }
      
      return response;
    }

    const responses = {
      'add_to_cart': `Adding ${parameters.items?.length || 0} item(s) to cart...`,
      'place_order': `Placing order with ${parameters.items?.length || 0} item(s) to kitchen...`,
      'search_order': `Searching for order ${parameters.orderId}...`,
      'search_menu': 'Searching menu...',
      'get_tables': 'Getting tables information...',
      'book_table': `Booking table ${parameters.tableNumber} for ${parameters.partySize} people...`,
      'update_table_status': `Updating table ${parameters.tableId} status...`,
      'cancel_order': `Cancelling order ${parameters.orderId}...`,
      'get_order_status': `Getting status for order ${parameters.orderId}...`,
      'clear_cart': 'Clearing cart...'
    };

    return responses[intent] || 'Processing your request...';
  }
}

module.exports = IntelligentAgentService;

