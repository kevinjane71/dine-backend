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

    // Menu Management - Comprehensive
    'GET_MENU': {
      keywords: ['show menu', 'menu items', 'list menu', 'menu', 'what items', 'available items'],
      examples: ['show menu', 'list menu items', 'what items do you have', 'show all dishes'],
      apiCall: 'getMenu'
    },
    'GET_MENU_CATEGORY': {
      keywords: ['menu category', 'show category', 'items in category', 'category items'],
      examples: ['show appetizers', 'list main course', 'dessert items', 'beverages'],
      apiCall: 'getMenuByCategory'
    },
    'CREATE_MENU_ITEM': {
      keywords: ['add menu', 'create menu', 'new menu item', 'add dish', 'create dish', 'new dish'],
      examples: ['add pizza to menu', 'create new burger', 'add menu item', 'new pasta dish'],
      apiCall: 'createMenuItem'
    },
    'UPDATE_MENU_ITEM': {
      keywords: ['update menu', 'modify menu', 'change menu', 'edit menu', 'update dish', 'modify dish'],
      examples: ['update pizza price', 'modify burger description', 'change pasta name'],
      apiCall: 'updateMenuItem'
    },
    'DELETE_MENU_ITEM': {
      keywords: ['delete menu', 'remove menu', 'remove item', 'delete dish', 'remove dish'],
      examples: ['delete pizza from menu', 'remove burger', 'delete menu item', 'remove pasta'],
      apiCall: 'deleteMenuItem'
    },
    'BULK_UPLOAD_MENU': {
      keywords: ['bulk upload', 'upload menu', 'import menu', 'add many items', 'bulk add'],
      examples: ['bulk upload menu', 'import all dishes', 'add many items at once'],
      apiCall: 'bulkUploadMenu'
    },
    'BULK_SAVE_MENU': {
      keywords: ['bulk save', 'save many', 'save all items', 'bulk create'],
      examples: ['bulk save menu items', 'save all dishes', 'create many items'],
      apiCall: 'bulkSaveMenuItems'
    },
    'SEARCH_MENU': {
      keywords: ['search menu', 'find item', 'look for', 'search dish'],
      examples: ['search for pizza', 'find burger', 'look for pasta', 'search spicy food'],
      apiCall: 'searchMenuItems'
    },

    // Customer Management - Comprehensive
    'GET_CUSTOMERS': {
      keywords: ['show customers', 'list customers', 'customer list', 'all customers'],
      examples: ['show customers', 'list all customers', 'customer database'],
      apiCall: 'getCustomers'
    },
    'CREATE_CUSTOMER': {
      keywords: ['add customer', 'create customer', 'new customer', 'register customer'],
      examples: ['add new customer', 'create customer profile', 'register customer'],
      apiCall: 'createCustomer'
    },
    'UPDATE_CUSTOMER': {
      keywords: ['update customer', 'modify customer', 'edit customer', 'change customer'],
      examples: ['update customer info', 'modify customer details', 'edit customer profile'],
      apiCall: 'updateCustomer'
    },
    'DELETE_CUSTOMER': {
      keywords: ['delete customer', 'remove customer', 'remove customer profile'],
      examples: ['delete customer', 'remove customer from database'],
      apiCall: 'deleteCustomer'
    },
    'SEARCH_CUSTOMER': {
      keywords: ['search customer', 'find customer', 'look for customer', 'customer search'],
      examples: ['search for John', 'find customer by phone', 'look for customer email'],
      apiCall: 'searchCustomer'
    },
    'GET_CUSTOMER_HISTORY': {
      keywords: ['customer history', 'order history', 'customer orders', 'past orders'],
      examples: ['show customer history', 'order history for John', 'past orders'],
      apiCall: 'getCustomerHistory'
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
      // Table Management
      'CREATE_TABLE': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "table name/number", "floor": "floor name", "capacity": number}`,

      'UPDATE_TABLE_STATUS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"tableNumber": "table number", "status": "new status (AVAILABLE/OCCUPIED/CLEANING/RESERVED)"}`,

      'DELETE_TABLE': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"tableNumber": "table number"}`,

      'GET_TABLE_STATUS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"tableNumber": "table number"}`,

      // Order Management
      'CREATE_ORDER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"itemName": "menu item name", "quantity": number, "tableNumber": "table number", "customerName": "customer name"}`,

      'UPDATE_ORDER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"orderId": "order ID/number", "status": "new status"}`,

      'CANCEL_ORDER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"orderId": "order ID/number"}`,

      'GET_ORDERS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"status": "filter by status (optional)", "date": "date filter (optional)"}`,

      // Menu Management - Comprehensive
      'GET_MENU': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"category": "category filter (optional)"}`,

      'GET_MENU_CATEGORY': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"category": "category name (appetizers/main course/desserts/beverages)"}`,

      'CREATE_MENU_ITEM': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "item name", "price": number, "description": "item description", "category": "category name", "foodType": "veg/non-veg", "spiceLevel": "mild/medium/hot"}`,

      'UPDATE_MENU_ITEM': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"itemName": "item name to update", "price": "new price (optional)", "description": "new description (optional)", "name": "new name (optional)"}`,

      'DELETE_MENU_ITEM': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"itemName": "menu item name to delete"}`,

      'BULK_UPLOAD_MENU': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"fileType": "file type (csv/excel)", "description": "description of items to upload"}`,

      'BULK_SAVE_MENU': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"items": "array of menu items", "description": "description of bulk operation"}`,

      'SEARCH_MENU': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"searchTerm": "search keyword", "category": "category filter (optional)"}`,

      // Customer Management - Comprehensive
      'GET_CUSTOMERS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"limit": "number of customers to show (optional)", "sortBy": "sort field (optional)"}`,

      'CREATE_CUSTOMER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "customer name", "phone": "phone number", "email": "email address", "city": "city name", "dob": "date of birth"}`,

      'UPDATE_CUSTOMER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"customerId": "customer ID", "name": "new name (optional)", "phone": "new phone (optional)", "email": "new email (optional)", "city": "new city (optional)"}`,

      'DELETE_CUSTOMER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"customerId": "customer ID to delete"}`,

      'SEARCH_CUSTOMER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"searchTerm": "search keyword", "searchBy": "search field (name/phone/email)"}`,

      'GET_CUSTOMER_HISTORY': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"customerId": "customer ID", "customerName": "customer name", "dateRange": "date range (optional)"}`,

      // Analytics
      'GET_ANALYTICS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"period": "time period (today/week/month)", "type": "analytics type (revenue/sales/orders)"}`,

      // General
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

        // Menu Management - Comprehensive
        case 'getMenuByCategory':
          const menuByCategoryResponse = await this.apiClient.getMenu(restaurantId, extractedData.category);
          const categoryItems = menuByCategoryResponse.menuItems || [];
          result = {
            success: true,
            response: `Found ${categoryItems.length} items in ${extractedData.category} category. ${categoryItems.slice(0, 3).map(m => m.name).join(', ')}${categoryItems.length > 3 ? '...' : ''}`,
            data: categoryItems
          };
          break;

        case 'createMenuItem':
          const menuItemData = {
            name: extractedData.name,
            price: extractedData.price,
            description: extractedData.description || '',
            category: extractedData.category || 'main-course',
            foodType: extractedData.foodType || 'veg',
            spiceLevel: extractedData.spiceLevel || 'mild',
            isVeg: extractedData.foodType === 'veg',
            shortCode: extractedData.name.substring(0, 3).toUpperCase(),
            isAvailable: true,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          const menuItemResponse = await this.apiClient.createMenuItem(restaurantId, menuItemData);
          result = {
            success: true,
            response: `Menu item "${extractedData.name}" added successfully! Price: ₹${extractedData.price}`,
            data: menuItemResponse
          };
          break;

        case 'updateMenuItem':
          // Find menu item by name first
          const menuForUpdate = await this.apiClient.getMenu(restaurantId);
          const menuItemsForUpdate = menuForUpdate.menuItems || [];
          const itemToUpdate = menuItemsForUpdate.find(item => 
            item.name.toLowerCase().includes(extractedData.itemName.toLowerCase())
          );
          
          if (!itemToUpdate) {
            result = {
              success: false,
              response: `Menu item "${extractedData.itemName}" not found.`
            };
            break;
          }

          const updateData = {};
          if (extractedData.price) updateData.price = extractedData.price;
          if (extractedData.description) updateData.description = extractedData.description;
          if (extractedData.name) updateData.name = extractedData.name;
          updateData.updatedAt = new Date();

          await this.apiClient.updateMenuItem(itemToUpdate.id, updateData);
          result = {
            success: true,
            response: `Menu item "${extractedData.itemName}" updated successfully!`,
            data: updateData
          };
          break;

        case 'deleteMenuItem':
          // Find menu item by name first
          const menuForDelete = await this.apiClient.getMenu(restaurantId);
          const menuItemsForDelete = menuForDelete.menuItems || [];
          const itemToDelete = menuItemsForDelete.find(item => 
            item.name.toLowerCase().includes(extractedData.itemName.toLowerCase())
          );
          
          if (!itemToDelete) {
            result = {
              success: false,
              response: `Menu item "${extractedData.itemName}" not found.`
            };
            break;
          }

          await this.apiClient.deleteMenuItem(itemToDelete.id);
          result = {
            success: true,
            response: `Menu item "${extractedData.itemName}" deleted successfully!`
          };
          break;

        case 'searchMenuItems':
          const menuForSearch = await this.apiClient.getMenu(restaurantId);
          const allMenuItems = menuForSearch.menuItems || [];
          const searchResults = allMenuItems.filter(item => 
            item.name.toLowerCase().includes(extractedData.searchTerm.toLowerCase()) ||
            item.description.toLowerCase().includes(extractedData.searchTerm.toLowerCase())
          );
          
          result = {
            success: true,
            response: `Found ${searchResults.length} items matching "${extractedData.searchTerm}". ${searchResults.slice(0, 3).map(m => m.name).join(', ')}${searchResults.length > 3 ? '...' : ''}`,
            data: searchResults
          };
          break;

        // Customer Management - Comprehensive
        case 'getCustomers':
          const customersResponse = await this.apiClient.getCustomers(restaurantId);
          const customers = customersResponse.customers || [];
          result = {
            success: true,
            response: `Found ${customers.length} customers. ${customers.slice(0, 3).map(c => c.name).join(', ')}${customers.length > 3 ? '...' : ''}`,
            data: customers
          };
          break;

        case 'createCustomer':
          const customerData = {
            name: extractedData.name,
            phone: extractedData.phone,
            email: extractedData.email,
            city: extractedData.city,
            dob: extractedData.dob,
            restaurantId: restaurantId,
            orderHistory: [],
            totalOrders: 0,
            totalSpent: 0,
            lastOrderDate: null,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          const customerResponse = await this.apiClient.createCustomer(restaurantId, customerData);
          result = {
            success: true,
            response: `Customer "${extractedData.name}" created successfully!`,
            data: customerResponse
          };
          break;

        case 'updateCustomer':
          const customerUpdateData = {};
          if (extractedData.name) customerUpdateData.name = extractedData.name;
          if (extractedData.phone) customerUpdateData.phone = extractedData.phone;
          if (extractedData.email) customerUpdateData.email = extractedData.email;
          if (extractedData.city) customerUpdateData.city = extractedData.city;
          customerUpdateData.updatedAt = new Date();

          await this.apiClient.updateCustomer(extractedData.customerId, customerUpdateData);
          result = {
            success: true,
            response: `Customer updated successfully!`,
            data: customerUpdateData
          };
          break;

        case 'deleteCustomer':
          await this.apiClient.deleteCustomer(extractedData.customerId);
          result = {
            success: true,
            response: `Customer deleted successfully!`
          };
          break;

        case 'searchCustomer':
          const customersForSearch = await this.apiClient.getCustomers(restaurantId);
          const allCustomers = customersForSearch.customers || [];
          const customerSearchResults = allCustomers.filter(customer => {
            const searchTerm = extractedData.searchTerm.toLowerCase();
            return customer.name?.toLowerCase().includes(searchTerm) ||
                   customer.phone?.includes(searchTerm) ||
                   customer.email?.toLowerCase().includes(searchTerm);
          });
          
          result = {
            success: true,
            response: `Found ${customerSearchResults.length} customers matching "${extractedData.searchTerm}". ${customerSearchResults.slice(0, 3).map(c => c.name).join(', ')}${customerSearchResults.length > 3 ? '...' : ''}`,
            data: customerSearchResults
          };
          break;

        case 'getCustomerHistory':
          const customersForHistory = await this.apiClient.getCustomers(restaurantId);
          const allCustomersForHistory = customersForHistory.customers || [];
          const targetCustomer = allCustomersForHistory.find(customer => 
            customer.id === extractedData.customerId || 
            customer.name?.toLowerCase().includes(extractedData.customerName?.toLowerCase())
          );
          
          if (!targetCustomer) {
            result = {
              success: false,
              response: `Customer not found.`
            };
            break;
          }

          result = {
            success: true,
            response: `Customer "${targetCustomer.name}" has ${targetCustomer.totalOrders} orders totaling ₹${targetCustomer.totalSpent}. Last order: ${targetCustomer.lastOrderDate ? new Date(targetCustomer.lastOrderDate).toLocaleDateString() : 'Never'}`,
            data: targetCustomer
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
