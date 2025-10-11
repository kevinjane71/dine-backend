// Simple Intent-Based Chatbot for Restaurant Management
// Maps natural language to exact API calls

const OpenAI = require('openai');

class RestaurantChatbot {
  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.apiClient = null; // Will be injected
  }

  // Intent patterns based on actual API usage
  INTENT_PATTERNS = {
    // Table Management
    'GET_TABLE_STATUS': {
      keywords: ['table status', 'table info', 'show table', 'table details', 'status of table'],
      examples: ['table status 5', 'show table 2', 'status of table number 3'],
      apiCall: 'getTableStatus'
    },
    'UPDATE_TABLE_STATUS': {
      keywords: ['mark table', 'update table', 'change table status', 'set table', 'make table'],
      examples: ['mark table 5 available', 'update table 2 occupied', 'set table 3 cleaning'],
      apiCall: 'updateTableStatus'
    },
    'CREATE_TABLE': {
      keywords: ['add table', 'create table', 'new table'],
      examples: ['add table 10', 'create table with capacity 6', 'new table on first floor'],
      apiCall: 'createTable'
    },
    'DELETE_TABLE': {
      keywords: ['delete table', 'remove table'],
      examples: ['delete table 5', 'remove table 2'],
      apiCall: 'deleteTable'
    },

    // Order Management
    'CREATE_ORDER': {
      keywords: ['place order', 'create order', 'add order', 'order'],
      examples: ['place order for pizza', 'order 2 burgers', 'create order for table 5'],
      apiCall: 'createOrder'
    },
    'UPDATE_ORDER': {
      keywords: ['update order', 'modify order', 'change order', 'edit order'],
      examples: ['update order ORD-123', 'modify my order', 'change order items'],
      apiCall: 'updateOrder'
    },
    'GET_ORDERS': {
      keywords: ['show orders', 'list orders', 'orders today', 'order history'],
      examples: ['show orders', 'list today orders', 'order history'],
      apiCall: 'getOrders'
    },
    'CANCEL_ORDER': {
      keywords: ['cancel order', 'delete order', 'remove order'],
      examples: ['cancel order ORD-123', 'delete my order', 'remove order'],
      apiCall: 'cancelOrder'
    },

    // Menu Management
    'GET_MENU': {
      keywords: ['show menu', 'menu items', 'list menu', 'menu'],
      examples: ['show menu', 'list menu items', 'what items do you have'],
      apiCall: 'getMenu'
    },
    'ADD_MENU_ITEM': {
      keywords: ['add menu', 'create menu', 'new menu item'],
      examples: ['add pizza to menu', 'create new burger', 'add menu item'],
      apiCall: 'createMenuItem'
    },
    'DELETE_MENU_ITEM': {
      keywords: ['delete menu', 'remove menu', 'remove item'],
      examples: ['delete pizza from menu', 'remove burger', 'delete menu item'],
      apiCall: 'deleteMenuItem'
    },

    // Analytics
    'GET_ANALYTICS': {
      keywords: ['revenue', 'sales', 'income', 'analytics', 'report'],
      examples: ['today revenue', 'monthly sales', 'analytics report'],
      apiCall: 'getAnalytics'
    },

    // General
    'LOGOUT': {
      keywords: ['logout', 'sign out', 'exit'],
      examples: ['logout', 'sign out', 'exit system'],
      apiCall: 'logout'
    }
  };

  // Extract data from user query using ChatGPT
  async extractData(intent, userQuery) {
    const data = {};
    
    try {
      // Use ChatGPT to extract structured data based on intent
      const extractionPrompt = this.buildExtractionPrompt(intent, userQuery);
      
      const response = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: "You are a data extraction assistant. Extract the requested parameters from the user query and return ONLY a JSON object with the extracted values. Do not include any other text or explanation."
          },
          {
            role: "user",
            content: extractionPrompt
          }
        ],
        temperature: 0.1,
        max_tokens: 200
      });

      const extractedText = response.choices[0].message.content.trim();
      const extractedData = JSON.parse(extractedText);
      
      console.log('🤖 ChatGPT extracted data:', extractedData);
      return extractedData;
      
    } catch (error) {
      console.error('Data extraction error:', error);
      return {};
    }
  }

  // Build extraction prompt based on intent
  buildExtractionPrompt(intent, userQuery) {
    const prompts = {
      'CREATE_TABLE': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "table name/number", "floor": "floor name", "capacity": number}`,

      'UPDATE_TABLE_STATUS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"tableNumber": "table number", "status": "new status (available/occupied/reserved/cleaning/maintenance)"}`,

      'DELETE_TABLE': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"tableNumber": "table number"}`,

      'GET_TABLE_STATUS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"tableNumber": "table number"}`,

      'CREATE_ORDER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"itemName": "menu item name", "quantity": number, "tableNumber": "table number", "customerName": "customer name"}`,

      'UPDATE_ORDER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"orderId": "order ID/number", "status": "new status"}`,

      'CANCEL_ORDER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"orderId": "order ID/number"}`,

      'DELETE_MENU_ITEM': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"itemName": "menu item name"}`,

      'GET_ORDERS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"status": "filter by status (optional)", "date": "date filter (optional)"}`,

      'GET_MENU': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"category": "menu category (optional)"}`,

      'LOGOUT': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {}`
    };

    return prompts[intent] || `Extract relevant parameters from: ${userQuery}`;
  }

  // Detect intent from user query
  async detectIntent(userQuery) {
    const systemPrompt = `You are an intent classifier for a restaurant management system.
    
Available intents:
${Object.keys(this.INTENT_PATTERNS).map(intent => `- ${intent}`).join('\n')}

Examples:
${Object.entries(this.INTENT_PATTERNS).map(([intent, config]) => 
  `${intent}: ${config.examples.join(', ')}`
).join('\n')}

Respond with ONLY the intent name (e.g., GET_TABLE_STATUS). If unclear, respond with UNKNOWN.`;

    try {
      const completion = await this.openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userQuery }
        ],
        temperature: 0.1,
        max_tokens: 50
      });

      const intent = completion.choices[0].message.content.trim();
      return Object.keys(this.INTENT_PATTERNS).includes(intent) ? intent : 'UNKNOWN';
    } catch (error) {
      console.error('Intent detection error:', error);
      return 'UNKNOWN';
    }
  }

  // Execute API call based on intent
  async executeIntent(intent, extractedData, restaurantId, userId, db) {
    const apiCall = this.INTENT_PATTERNS[intent]?.apiCall;
    
    if (!apiCall) {
      return {
        success: false,
        response: "I don't understand that request. Please try again."
      };
    }

    try {
      let result;
      
      switch (apiCall) {
        case 'getTableStatus':
          // First get all tables, then filter by number
          const tablesResponse = await this.apiClient.getTables(restaurantId);
          const targetTable = tablesResponse.tables?.find(t => t.name === extractedData.tableNumber);
          
          if (targetTable) {
            result = {
              success: true,
              response: `Table ${extractedData.tableNumber} status is **${targetTable.status.toLowerCase()}**.`,
              data: targetTable
            };
          } else {
            result = {
              success: false,
              response: `Table ${extractedData.tableNumber} not found.`
            };
          }
          break;

        case 'updateTableStatus':
          // Find table by number first
          const tablesForUpdate = await this.apiClient.getTables(restaurantId);
          const tableToUpdate = tablesForUpdate.tables?.find(t => t.name === extractedData.tableNumber);
          
          if (tableToUpdate) {
            await this.apiClient.updateTableStatus(tableToUpdate.id, extractedData.status);
            result = {
              success: true,
              response: `Table ${extractedData.tableNumber} status updated to **${extractedData.status.toLowerCase()}** successfully!`
            };
          } else {
            result = {
              success: false,
              response: `Table ${extractedData.tableNumber} not found.`
            };
          }
          break;

        case 'createTable':
          const tableData = {
            name: extractedData.tableNumber,
            capacity: extractedData.capacity,
            floor: extractedData.floor,
            status: 'AVAILABLE'
          };
          await this.apiClient.createTable(restaurantId, tableData);
          result = {
            success: true,
            response: `Table ${extractedData.tableNumber} created successfully on ${extractedData.floor}!`
          };
          break;

        case 'deleteTable':
          const tablesForDelete = await this.apiClient.getTables(restaurantId);
          const tableToDelete = tablesForDelete.tables?.find(t => t.name === extractedData.tableNumber);
          
          if (tableToDelete) {
            await this.apiClient.deleteTable(tableToDelete.id);
            result = {
              success: true,
              response: `Table ${extractedData.tableNumber} deleted successfully!`
            };
          } else {
            result = {
              success: false,
              response: `Table ${extractedData.tableNumber} not found.`
            };
          }
          break;

        case 'getOrders':
          const ordersResponse = await this.apiClient.getOrders(restaurantId);
          const orders = ordersResponse.orders || [];
          result = {
            success: true,
            response: `Found ${orders.length} orders. ${orders.slice(0, 3).map(o => `Order ${o.orderNumber}: ${o.status}`).join(', ')}${orders.length > 3 ? '...' : ''}`,
            data: orders
          };
          break;

        case 'getMenu':
          const menuResponse = await this.apiClient.getMenu(restaurantId);
          const menuItems = menuResponse.menuItems || [];
          result = {
            success: true,
            response: `Menu has ${menuItems.length} items. ${menuItems.slice(0, 3).map(m => m.name).join(', ')}${menuItems.length > 3 ? '...' : ''}`,
            data: menuItems
          };
          break;

        case 'createOrder':
          // Find the menu item by name
          const menuForOrder = await this.apiClient.getMenu(restaurantId);
          const menuItemsForOrder = menuForOrder.menuItems || [];
          const targetItem = menuItemsForOrder.find(item => 
            extractedData.itemName && item.name.toLowerCase().includes(extractedData.itemName.toLowerCase())
          );
          
          if (!targetItem) {
            result = {
              success: false,
              response: `Item "${extractedData.itemName}" not found in menu. Available items: ${menuItemsForOrder.slice(0, 3).map(m => m.name).join(', ')}${menuItemsForOrder.length > 3 ? '...' : ''}`
            };
            break;
          }

          // Create order data
          const orderData = {
            restaurantId: restaurantId,
            tableNumber: extractedData.tableNumber,
            customer: {
              name: extractedData.customerName || 'Walk-in Customer'
            },
            items: [{
              id: targetItem.id,
              name: targetItem.name,
              price: targetItem.price,
              quantity: extractedData.quantity || 1,
              category: targetItem.category || 'main-course',
              shortCode: targetItem.shortCode || 'ITM',
              isVeg: targetItem.isVeg || false,
              total: targetItem.price * (extractedData.quantity || 1)
            }],
            totalAmount: targetItem.price * (extractedData.quantity || 1),
            taxAmount: 0,
            discountAmount: 0,
            finalAmount: targetItem.price * (extractedData.quantity || 1),
            status: 'PENDING',
            waiterId: userId,
            waiterName: 'System',
            paymentMethod: 'CASH',
            paymentStatus: 'PENDING',
            expressBilling: false,
            notes: '',
            createdAt: new Date(),
            updatedAt: new Date()
          };

          // Create order in database
          const orderDoc = await db.collection('orders').add(orderData);
          
          // Generate order number
          const orderNumber = `ORD-${Date.now()}`;
          await db.collection('orders').doc(orderDoc.id).update({
            id: orderDoc.id,
            orderNumber: orderNumber
          });

          // Update table status if table number provided
          if (extractedData.tableNumber) {
            const tablesForOrder = await this.apiClient.getTables(restaurantId);
            const targetTable = tablesForOrder.tables?.find(t => t.name === extractedData.tableNumber);
            if (targetTable) {
              await this.apiClient.updateTableStatus(targetTable.id, 'occupied', orderDoc.id);
            }
          }

          result = {
            success: true,
            response: `Order created successfully! Order #${orderNumber} for ${extractedData.customerName || 'Walk-in Customer'} - ${targetItem.name} x${extractedData.quantity || 1} on table ${extractedData.tableNumber || 'N/A'}. Total: ₹${orderData.finalAmount}`,
            data: {
              orderId: orderDoc.id,
              orderNumber: orderNumber,
              totalAmount: orderData.finalAmount
            }
          };
          break;

        case 'logout':
          this.apiClient.clearToken();
          result = {
            success: true,
            response: "You have been logged out successfully. Redirecting to login page...",
            redirect: '/login'
          };
          break;

        default:
          result = {
            success: false,
            response: `Action "${apiCall}" is not implemented yet.`
          };
      }

      return result;

    } catch (error) {
      console.error('API execution error:', error);
      return {
        success: false,
        response: `Error: ${error.message}`
      };
    }
  }

  // Main processing function
  async processQuery(userQuery, restaurantId, userId, apiClient, db) {
    this.apiClient = apiClient;
    this.db = db;
    
    console.log('🤖 Processing query:', userQuery);
    
    // Detect intent
    const intent = await this.detectIntent(userQuery);
    console.log('🎯 Detected intent:', intent);
    
    if (intent === 'UNKNOWN') {
      return {
        success: false,
        response: "I don't understand that request. Please try asking about tables, orders, menu, or analytics."
      };
    }
    
    // Extract data from query
    const extractedData = await this.extractData(intent, userQuery);
    console.log('📊 Extracted data:', extractedData);
    
    // Execute API call
    const result = await this.executeIntent(intent, extractedData, restaurantId, userId, this.db);
    console.log('✅ Result:', result);
    
    return result;
  }
}

module.exports = RestaurantChatbot;
