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

    // Analytics and Reporting
    'GET_ANALYTICS': {
      keywords: ['revenue', 'sales', 'income', 'analytics', 'report', 'earnings', 'profit'],
      examples: ['today revenue', 'monthly sales', 'analytics report', 'show earnings', 'profit today'],
      apiCall: 'getAnalytics'
    },

    // Staff Management
    'GET_STAFF': {
      keywords: ['show staff', 'list staff', 'staff members', 'employees', 'team'],
      examples: ['show staff', 'list employees', 'staff members', 'team list'],
      apiCall: 'getStaff'
    },
    'CREATE_STAFF': {
      keywords: ['add staff', 'hire staff', 'new employee', 'add employee', 'create staff'],
      examples: ['add new staff member', 'hire employee', 'create staff profile'],
      apiCall: 'createStaff'
    },
    'UPDATE_STAFF': {
      keywords: ['update staff', 'modify staff', 'edit staff', 'change staff'],
      examples: ['update staff info', 'modify employee details', 'edit staff profile'],
      apiCall: 'updateStaff'
    },
    'DELETE_STAFF': {
      keywords: ['delete staff', 'remove staff', 'fire employee', 'remove employee'],
      examples: ['delete staff member', 'remove employee', 'fire staff'],
      apiCall: 'deleteStaff'
    },

    // Inventory Management
    'GET_INVENTORY': {
      keywords: ['show inventory', 'list inventory', 'stock', 'inventory items'],
      examples: ['show inventory', 'list stock', 'inventory items', 'stock levels'],
      apiCall: 'getInventory'
    },
    'CREATE_INVENTORY_ITEM': {
      keywords: ['add inventory', 'new inventory item', 'add stock', 'create inventory'],
      examples: ['add inventory item', 'new stock item', 'create inventory entry'],
      apiCall: 'createInventoryItem'
    },
    'UPDATE_INVENTORY_ITEM': {
      keywords: ['update inventory', 'modify inventory', 'edit inventory', 'change stock'],
      examples: ['update inventory item', 'modify stock', 'edit inventory'],
      apiCall: 'updateInventoryItem'
    },
    'DELETE_INVENTORY_ITEM': {
      keywords: ['delete inventory', 'remove inventory', 'remove stock'],
      examples: ['delete inventory item', 'remove stock item'],
      apiCall: 'deleteInventoryItem'
    },
    'GET_INVENTORY_CATEGORIES': {
      keywords: ['inventory categories', 'stock categories', 'inventory types'],
      examples: ['show inventory categories', 'list stock categories'],
      apiCall: 'getInventoryCategories'
    },
    'GET_INVENTORY_DASHBOARD': {
      keywords: ['inventory dashboard', 'stock dashboard', 'inventory summary'],
      examples: ['show inventory dashboard', 'stock summary', 'inventory overview'],
      apiCall: 'getInventoryDashboard'
    },

    // Supplier Management
    'GET_SUPPLIERS': {
      keywords: ['show suppliers', 'list suppliers', 'vendors', 'supplier list'],
      examples: ['show suppliers', 'list vendors', 'supplier database'],
      apiCall: 'getSuppliers'
    },
    'CREATE_SUPPLIER': {
      keywords: ['add supplier', 'new supplier', 'add vendor', 'create supplier'],
      examples: ['add new supplier', 'create vendor', 'new supplier'],
      apiCall: 'createSupplier'
    },
    'UPDATE_SUPPLIER': {
      keywords: ['update supplier', 'modify supplier', 'edit supplier', 'change supplier'],
      examples: ['update supplier info', 'modify vendor details'],
      apiCall: 'updateSupplier'
    },
    'DELETE_SUPPLIER': {
      keywords: ['delete supplier', 'remove supplier', 'remove vendor'],
      examples: ['delete supplier', 'remove vendor'],
      apiCall: 'deleteSupplier'
    },

    // Recipe Management
    'GET_RECIPES': {
      keywords: ['show recipes', 'list recipes', 'recipe book', 'recipes'],
      examples: ['show recipes', 'list recipe book', 'all recipes'],
      apiCall: 'getRecipes'
    },
    'CREATE_RECIPE': {
      keywords: ['add recipe', 'new recipe', 'create recipe', 'add dish recipe'],
      examples: ['add new recipe', 'create dish recipe', 'new recipe'],
      apiCall: 'createRecipe'
    },
    'UPDATE_RECIPE': {
      keywords: ['update recipe', 'modify recipe', 'edit recipe', 'change recipe'],
      examples: ['update recipe', 'modify dish recipe', 'edit recipe'],
      apiCall: 'updateRecipe'
    },
    'DELETE_RECIPE': {
      keywords: ['delete recipe', 'remove recipe', 'remove dish recipe'],
      examples: ['delete recipe', 'remove dish recipe'],
      apiCall: 'deleteRecipe'
    },

    // Payment Management
    'CREATE_PAYMENT': {
      keywords: ['create payment', 'process payment', 'make payment', 'payment'],
      examples: ['create payment', 'process payment', 'make payment'],
      apiCall: 'createPayment'
    },
    'VERIFY_PAYMENT': {
      keywords: ['verify payment', 'confirm payment', 'check payment'],
      examples: ['verify payment', 'confirm payment status'],
      apiCall: 'verifyPayment'
    },

    // Settings Management
    'GET_SETTINGS': {
      keywords: ['show settings', 'get settings', 'restaurant settings', 'settings'],
      examples: ['show settings', 'restaurant settings', 'get settings'],
      apiCall: 'getSettings'
    },
    'UPDATE_SETTINGS': {
      keywords: ['update settings', 'modify settings', 'change settings', 'edit settings'],
      examples: ['update settings', 'modify restaurant settings'],
      apiCall: 'updateSettings'
    },
    'GET_TAX_SETTINGS': {
      keywords: ['tax settings', 'tax configuration', 'tax rates'],
      examples: ['show tax settings', 'tax configuration', 'tax rates'],
      apiCall: 'getTaxSettings'
    },
    'UPDATE_TAX_SETTINGS': {
      keywords: ['update tax', 'modify tax', 'change tax', 'edit tax'],
      examples: ['update tax settings', 'modify tax rates'],
      apiCall: 'updateTaxSettings'
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

      // Staff Management
      'GET_STAFF': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"limit": "number of staff to show (optional)", "role": "staff role filter (optional)"}`,

      'CREATE_STAFF': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "staff name", "phone": "phone number", "email": "email address", "role": "staff role", "address": "address"}`,

      'UPDATE_STAFF': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"staffId": "staff ID", "name": "new name (optional)", "phone": "new phone (optional)", "email": "new email (optional)", "role": "new role (optional)"}`,

      'DELETE_STAFF': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"staffId": "staff ID to delete"}`,

      // Inventory Management
      'GET_INVENTORY': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"category": "category filter (optional)", "search": "search term (optional)"}`,

      'CREATE_INVENTORY_ITEM': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "item name", "category": "category", "quantity": "quantity", "unit": "unit", "price": "price per unit"}`,

      'UPDATE_INVENTORY_ITEM': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"itemId": "item ID", "name": "new name (optional)", "quantity": "new quantity (optional)", "price": "new price (optional)"}`,

      'DELETE_INVENTORY_ITEM': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"itemId": "inventory item ID to delete"}`,

      'GET_INVENTORY_CATEGORIES': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {}`,

      'GET_INVENTORY_DASHBOARD': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {}`,

      // Supplier Management
      'GET_SUPPLIERS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"limit": "number of suppliers to show (optional)"}`,

      'CREATE_SUPPLIER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "supplier name", "contact": "contact person", "phone": "phone number", "email": "email address", "address": "address"}`,

      'UPDATE_SUPPLIER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"supplierId": "supplier ID", "name": "new name (optional)", "contact": "new contact (optional)", "phone": "new phone (optional)"}`,

      'DELETE_SUPPLIER': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"supplierId": "supplier ID to delete"}`,

      // Recipe Management
      'GET_RECIPES': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"category": "recipe category (optional)", "search": "search term (optional)"}`,

      'CREATE_RECIPE': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"name": "recipe name", "description": "recipe description", "ingredients": "ingredients list", "instructions": "cooking instructions"}`,

      'UPDATE_RECIPE': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"recipeId": "recipe ID", "name": "new name (optional)", "description": "new description (optional)", "ingredients": "new ingredients (optional)"}`,

      'DELETE_RECIPE': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"recipeId": "recipe ID to delete"}`,

      // Payment Management
      'CREATE_PAYMENT': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"amount": "payment amount", "method": "payment method", "orderId": "order ID"}`,

      'VERIFY_PAYMENT': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"paymentId": "payment ID", "transactionId": "transaction ID"}`,

      // Settings Management
      'GET_SETTINGS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {}`,

      'UPDATE_SETTINGS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"settings": "settings object", "key": "setting key", "value": "setting value"}`,

      'GET_TAX_SETTINGS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {}`,

      'UPDATE_TAX_SETTINGS': `Extract these parameters from the user query: ${userQuery}
      Return JSON with: {"taxRate": "tax rate percentage", "taxType": "tax type"}`,

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
          const orderList = ordersResponse.orders || [];
          result = {
            success: true,
            response: `Found ${orderList.length} orders. ${orderList.slice(0, 3).map(o => `Order ${o.orderNumber}: ${o.status}`).join(', ')}${orderList.length > 3 ? '...' : ''}`,
            data: orderList
          };
          break;

        case 'getMenu':
          // Get menu items from database
          const getMenuSnapshot = await db.collection('menuItems')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const menuItems = [];
          getMenuSnapshot.forEach(doc => {
            menuItems.push({ id: doc.id, ...doc.data() });
          });
          
          result = {
            success: true,
            response: `Menu has ${menuItems.length} items. ${menuItems.slice(0, 3).map(m => m.name).join(', ')}${menuItems.length > 3 ? '...' : ''}`,
            data: menuItems
          };
          break;

        case 'createOrder':
          // Find the menu item by name
          const orderMenuSnapshot = await db.collection('menuItems')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const menuItemsForOrder = [];
          orderMenuSnapshot.forEach(doc => {
            menuItemsForOrder.push({ id: doc.id, ...doc.data() });
          });
          
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
          // Get menu items by category from database
          const categorySnapshot = await db.collection('menuItems')
            .where('restaurantId', '==', restaurantId)
            .where('category', '==', extractedData.category)
            .get();
          
          const categoryItems = [];
          categorySnapshot.forEach(doc => {
            categoryItems.push({ id: doc.id, ...doc.data() });
          });
          
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
          
          // Create menu item directly in database
          const menuItemDoc = await db.collection('menuItems').add({
            ...menuItemData,
            restaurantId: restaurantId
          });
          
          result = {
            success: true,
            response: `Menu item "${extractedData.name}" added successfully! Price: ₹${extractedData.price}`,
            data: { id: menuItemDoc.id, ...menuItemData }
          };
          break;

        case 'updateMenuItem':
          // Find menu item by name first
          const updateMenuSnapshot = await db.collection('menuItems')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          let itemToUpdate = null;
          let updateItemDocRef = null;
          
          updateMenuSnapshot.forEach(doc => {
            const item = doc.data();
            if (item.name.toLowerCase().includes(extractedData.itemName.toLowerCase())) {
              itemToUpdate = { id: doc.id, ...item };
              updateItemDocRef = doc.ref;
            }
          });
          
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

          await updateItemDocRef.update(updateData);
          result = {
            success: true,
            response: `Menu item "${extractedData.itemName}" updated successfully!`,
            data: updateData
          };
          break;

        case 'deleteMenuItem':
          // Find menu item by name first
          const deleteMenuSnapshot = await db.collection('menuItems')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          let itemToDelete = null;
          let deleteItemDocRef = null;
          
          deleteMenuSnapshot.forEach(doc => {
            const item = doc.data();
            if (item.name.toLowerCase().includes(extractedData.itemName.toLowerCase())) {
              itemToDelete = { id: doc.id, ...item };
              deleteItemDocRef = doc.ref;
            }
          });
          
          if (!itemToDelete) {
            result = {
              success: false,
              response: `Menu item "${extractedData.itemName}" not found.`
            };
            break;
          }

          await deleteItemDocRef.delete();
          result = {
            success: true,
            response: `Menu item "${extractedData.itemName}" deleted successfully!`
          };
          break;

        case 'searchMenuItems':
          // Search menu items in database
          const searchMenuSnapshot = await db.collection('menuItems')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const allMenuItems = [];
          searchMenuSnapshot.forEach(doc => {
            allMenuItems.push({ id: doc.id, ...doc.data() });
          });
          
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
          // Get customers from database
          const customersSnapshot = await db.collection('customers')
            .where('restaurantId', '==', restaurantId)
            .orderBy('lastOrderDate', 'desc')
            .limit(100)
            .get();
          
          const customers = [];
          customersSnapshot.forEach(doc => {
            customers.push({ id: doc.id, ...doc.data() });
          });
          
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
          
          // Create customer directly in database
          const customerDoc = await db.collection('customers').add(customerData);
          
          result = {
            success: true,
            response: `Customer "${extractedData.name}" created successfully!`,
            data: { id: customerDoc.id, ...customerData }
          };
          break;

        case 'updateCustomer':
          // Find customer by ID
          const updateCustomerDoc = await db.collection('customers').doc(extractedData.customerId).get();
          
          if (!updateCustomerDoc.exists) {
            result = {
              success: false,
              response: `Customer not found.`
            };
            break;
          }

          const customerUpdateData = {};
          if (extractedData.name) customerUpdateData.name = extractedData.name;
          if (extractedData.phone) customerUpdateData.phone = extractedData.phone;
          if (extractedData.email) customerUpdateData.email = extractedData.email;
          if (extractedData.city) customerUpdateData.city = extractedData.city;
          customerUpdateData.updatedAt = new Date();

          await updateCustomerDoc.ref.update(customerUpdateData);
          result = {
            success: true,
            response: `Customer updated successfully!`,
            data: customerUpdateData
          };
          break;

        case 'deleteCustomer':
          const customerToDelete = await db.collection('customers').doc(extractedData.customerId).get();
          
          if (!customerToDelete.exists) {
            result = {
              success: false,
              response: `Customer not found.`
            };
            break;
          }

          await customerToDelete.ref.delete();
          result = {
            success: true,
            response: `Customer deleted successfully!`
          };
          break;

        case 'searchCustomer':
          // Search customers in database
          const searchCustomersSnapshot = await db.collection('customers')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const allCustomers = [];
          searchCustomersSnapshot.forEach(doc => {
            allCustomers.push({ id: doc.id, ...doc.data() });
          });
          
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
          // Get customer history from database
          const historyCustomersSnapshot = await db.collection('customers')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const allCustomersForHistory = [];
          historyCustomersSnapshot.forEach(doc => {
            allCustomersForHistory.push({ id: doc.id, ...doc.data() });
          });
          
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

        // Staff Management
        case 'getStaff':
          // Get staff from database
          const staffSnapshot = await db.collection('staff')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const staff = [];
          staffSnapshot.forEach(doc => {
            staff.push({ id: doc.id, ...doc.data() });
          });
          
          result = {
            success: true,
            response: `Found ${staff.length} staff members. ${staff.slice(0, 3).map(s => s.name).join(', ')}${staff.length > 3 ? '...' : ''}`,
            data: staff
          };
          break;

        case 'createStaff':
          const staffData = {
            name: extractedData.name,
            phone: extractedData.phone,
            email: extractedData.email,
            role: extractedData.role || 'employee',
            address: extractedData.address,
            restaurantId: restaurantId,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          const staffDoc = await db.collection('staff').add(staffData);
          
          result = {
            success: true,
            response: `Staff member "${extractedData.name}" created successfully!`,
            data: { id: staffDoc.id, ...staffData }
          };
          break;

        case 'updateStaff':
          const updateStaffDoc = await db.collection('staff').doc(extractedData.staffId).get();
          
          if (!updateStaffDoc.exists) {
            result = {
              success: false,
              response: `Staff member not found.`
            };
            break;
          }

          const staffUpdateData = {};
          if (extractedData.name) staffUpdateData.name = extractedData.name;
          if (extractedData.phone) staffUpdateData.phone = extractedData.phone;
          if (extractedData.email) staffUpdateData.email = extractedData.email;
          if (extractedData.role) staffUpdateData.role = extractedData.role;
          staffUpdateData.updatedAt = new Date();

          await updateStaffDoc.ref.update(staffUpdateData);
          result = {
            success: true,
            response: `Staff member updated successfully!`,
            data: staffUpdateData
          };
          break;

        case 'deleteStaff':
          const deleteStaffDoc = await db.collection('staff').doc(extractedData.staffId).get();
          
          if (!deleteStaffDoc.exists) {
            result = {
              success: false,
              response: `Staff member not found.`
            };
            break;
          }

          await deleteStaffDoc.ref.delete();
          result = {
            success: true,
            response: `Staff member deleted successfully!`
          };
          break;

        // Inventory Management
        case 'getInventory':
          // Get inventory items from database
          const inventorySnapshot = await db.collection('inventory')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const inventoryItems = [];
          inventorySnapshot.forEach(doc => {
            inventoryItems.push({ id: doc.id, ...doc.data() });
          });
          
          result = {
            success: true,
            response: `Found ${inventoryItems.length} inventory items. ${inventoryItems.slice(0, 3).map(i => i.name).join(', ')}${inventoryItems.length > 3 ? '...' : ''}`,
            data: inventoryItems
          };
          break;

        case 'createInventoryItem':
          const inventoryData = {
            name: extractedData.name,
            category: extractedData.category || 'general',
            quantity: extractedData.quantity || 0,
            unit: extractedData.unit || 'pieces',
            price: extractedData.price || 0,
            restaurantId: restaurantId,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          const inventoryDoc = await db.collection('inventory').add(inventoryData);
          
          result = {
            success: true,
            response: `Inventory item "${extractedData.name}" created successfully!`,
            data: { id: inventoryDoc.id, ...inventoryData }
          };
          break;

        case 'updateInventoryItem':
          const updateInventoryDoc = await db.collection('inventory').doc(extractedData.itemId).get();
          
          if (!updateInventoryDoc.exists) {
            result = {
              success: false,
              response: `Inventory item not found.`
            };
            break;
          }

          const inventoryUpdateData = {};
          if (extractedData.name) inventoryUpdateData.name = extractedData.name;
          if (extractedData.quantity) inventoryUpdateData.quantity = extractedData.quantity;
          if (extractedData.price) inventoryUpdateData.price = extractedData.price;
          inventoryUpdateData.updatedAt = new Date();

          await updateInventoryDoc.ref.update(inventoryUpdateData);
          result = {
            success: true,
            response: `Inventory item updated successfully!`,
            data: inventoryUpdateData
          };
          break;

        case 'deleteInventoryItem':
          const deleteInventoryDoc = await db.collection('inventory').doc(extractedData.itemId).get();
          
          if (!deleteInventoryDoc.exists) {
            result = {
              success: false,
              response: `Inventory item not found.`
            };
            break;
          }

          await deleteInventoryDoc.ref.delete();
          result = {
            success: true,
            response: `Inventory item deleted successfully!`
          };
          break;

        case 'getInventoryCategories':
          // Get inventory categories from database
          const categoriesSnapshot = await db.collection('inventoryCategories')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const categories = [];
          categoriesSnapshot.forEach(doc => {
            categories.push({ id: doc.id, ...doc.data() });
          });
          
          result = {
            success: true,
            response: `Found ${categories.length} inventory categories. ${categories.slice(0, 3).map(c => c.name).join(', ')}${categories.length > 3 ? '...' : ''}`,
            data: categories
          };
          break;

        case 'getInventoryDashboard':
          // Get inventory dashboard data
          const dashboardSnapshot = await db.collection('inventory')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const dashboardItems = [];
          dashboardSnapshot.forEach(doc => {
            dashboardItems.push({ id: doc.id, ...doc.data() });
          });

          const totalItems = dashboardItems.length;
          const lowStockItems = dashboardItems.filter(item => item.quantity < 10).length;
          const totalValue = dashboardItems.reduce((sum, item) => sum + (item.quantity * item.price), 0);

          result = {
            success: true,
            response: `📊 Inventory Dashboard:\n• Total Items: ${totalItems}\n• Low Stock Items: ${lowStockItems}\n• Total Value: ₹${totalValue.toFixed(2)}`,
            data: {
              totalItems,
              lowStockItems,
              totalValue,
              items: dashboardItems.slice(0, 10)
            }
          };
          break;

        // Supplier Management
        case 'getSuppliers':
          // Get suppliers from database
          const suppliersSnapshot = await db.collection('suppliers')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const suppliers = [];
          suppliersSnapshot.forEach(doc => {
            suppliers.push({ id: doc.id, ...doc.data() });
          });
          
          result = {
            success: true,
            response: `Found ${suppliers.length} suppliers. ${suppliers.slice(0, 3).map(s => s.name).join(', ')}${suppliers.length > 3 ? '...' : ''}`,
            data: suppliers
          };
          break;

        case 'createSupplier':
          const supplierData = {
            name: extractedData.name,
            contact: extractedData.contact,
            phone: extractedData.phone,
            email: extractedData.email,
            address: extractedData.address,
            restaurantId: restaurantId,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          const supplierDoc = await db.collection('suppliers').add(supplierData);
          
          result = {
            success: true,
            response: `Supplier "${extractedData.name}" created successfully!`,
            data: { id: supplierDoc.id, ...supplierData }
          };
          break;

        case 'updateSupplier':
          const updateSupplierDoc = await db.collection('suppliers').doc(extractedData.supplierId).get();
          
          if (!updateSupplierDoc.exists) {
            result = {
              success: false,
              response: `Supplier not found.`
            };
            break;
          }

          const supplierUpdateData = {};
          if (extractedData.name) supplierUpdateData.name = extractedData.name;
          if (extractedData.contact) supplierUpdateData.contact = extractedData.contact;
          if (extractedData.phone) supplierUpdateData.phone = extractedData.phone;
          supplierUpdateData.updatedAt = new Date();

          await updateSupplierDoc.ref.update(supplierUpdateData);
          result = {
            success: true,
            response: `Supplier updated successfully!`,
            data: supplierUpdateData
          };
          break;

        case 'deleteSupplier':
          const deleteSupplierDoc = await db.collection('suppliers').doc(extractedData.supplierId).get();
          
          if (!deleteSupplierDoc.exists) {
            result = {
              success: false,
              response: `Supplier not found.`
            };
            break;
          }

          await deleteSupplierDoc.ref.delete();
          result = {
            success: true,
            response: `Supplier deleted successfully!`
          };
          break;

        // Recipe Management
        case 'getRecipes':
          // Get recipes from database
          const recipesSnapshot = await db.collection('recipes')
            .where('restaurantId', '==', restaurantId)
            .get();
          
          const recipes = [];
          recipesSnapshot.forEach(doc => {
            recipes.push({ id: doc.id, ...doc.data() });
          });
          
          result = {
            success: true,
            response: `Found ${recipes.length} recipes. ${recipes.slice(0, 3).map(r => r.name).join(', ')}${recipes.length > 3 ? '...' : ''}`,
            data: recipes
          };
          break;

        case 'createRecipe':
          const recipeData = {
            name: extractedData.name,
            description: extractedData.description,
            ingredients: extractedData.ingredients || [],
            instructions: extractedData.instructions,
            restaurantId: restaurantId,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          const recipeDoc = await db.collection('recipes').add(recipeData);
          
          result = {
            success: true,
            response: `Recipe "${extractedData.name}" created successfully!`,
            data: { id: recipeDoc.id, ...recipeData }
          };
          break;

        case 'updateRecipe':
          const updateRecipeDoc = await db.collection('recipes').doc(extractedData.recipeId).get();
          
          if (!updateRecipeDoc.exists) {
            result = {
              success: false,
              response: `Recipe not found.`
            };
            break;
          }

          const recipeUpdateData = {};
          if (extractedData.name) recipeUpdateData.name = extractedData.name;
          if (extractedData.description) recipeUpdateData.description = extractedData.description;
          if (extractedData.ingredients) recipeUpdateData.ingredients = extractedData.ingredients;
          recipeUpdateData.updatedAt = new Date();

          await updateRecipeDoc.ref.update(recipeUpdateData);
          result = {
            success: true,
            response: `Recipe updated successfully!`,
            data: recipeUpdateData
          };
          break;

        case 'deleteRecipe':
          const deleteRecipeDoc = await db.collection('recipes').doc(extractedData.recipeId).get();
          
          if (!deleteRecipeDoc.exists) {
            result = {
              success: false,
              response: `Recipe not found.`
            };
            break;
          }

          await deleteRecipeDoc.ref.delete();
          result = {
            success: true,
            response: `Recipe deleted successfully!`
          };
          break;

        // Payment Management
        case 'createPayment':
          const paymentData = {
            amount: extractedData.amount,
            method: extractedData.method || 'CASH',
            orderId: extractedData.orderId,
            restaurantId: restaurantId,
            status: 'PENDING',
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          const paymentDoc = await db.collection('payments').add(paymentData);
          
          result = {
            success: true,
            response: `Payment of ₹${extractedData.amount} created successfully!`,
            data: { id: paymentDoc.id, ...paymentData }
          };
          break;

        case 'verifyPayment':
          const verifyPaymentDoc = await db.collection('payments').doc(extractedData.paymentId).get();
          
          if (!verifyPaymentDoc.exists) {
            result = {
              success: false,
              response: `Payment not found.`
            };
            break;
          }

          await verifyPaymentDoc.ref.update({
            status: 'VERIFIED',
            transactionId: extractedData.transactionId,
            verifiedAt: new Date(),
            updatedAt: new Date()
          });

          result = {
            success: true,
            response: `Payment verified successfully!`,
            data: { paymentId: extractedData.paymentId, status: 'VERIFIED' }
          };
          break;

        // Settings Management
        case 'getSettings':
          // Get restaurant settings from database
          const settingsDoc = await db.collection('restaurants').doc(restaurantId).get();
          
          if (!settingsDoc.exists) {
            result = {
              success: false,
              response: `Restaurant settings not found.`
            };
            break;
          }

          const restaurantData = settingsDoc.data();
          result = {
            success: true,
            response: `Restaurant settings loaded successfully!`,
            data: restaurantData
          };
          break;

        case 'updateSettings':
          const updateSettingsDoc = await db.collection('restaurants').doc(restaurantId).get();
          
          if (!updateSettingsDoc.exists) {
            result = {
              success: false,
              response: `Restaurant not found.`
            };
            break;
          }

          const settingsUpdateData = {};
          if (extractedData.key && extractedData.value) {
            settingsUpdateData[extractedData.key] = extractedData.value;
          }
          settingsUpdateData.updatedAt = new Date();

          await updateSettingsDoc.ref.update(settingsUpdateData);
          result = {
            success: true,
            response: `Settings updated successfully!`,
            data: settingsUpdateData
          };
          break;

        case 'getTaxSettings':
          // Get tax settings from database
          const taxDoc = await db.collection('taxSettings')
            .where('restaurantId', '==', restaurantId)
            .limit(1)
            .get();
          
          if (taxDoc.empty) {
            result = {
              success: true,
              response: `No tax settings found. Default tax rate: 0%`,
              data: { taxRate: 0, taxType: 'percentage' }
            };
            break;
          }

          const taxData = taxDoc.docs[0].data();
          result = {
            success: true,
            response: `Tax settings loaded successfully!`,
            data: taxData
          };
          break;

        case 'updateTaxSettings':
          const taxSettingsData = {
            taxRate: extractedData.taxRate || 0,
            taxType: extractedData.taxType || 'percentage',
            restaurantId: restaurantId,
            updatedAt: new Date()
          };
          
          // Check if tax settings exist
          const existingTaxDoc = await db.collection('taxSettings')
            .where('restaurantId', '==', restaurantId)
            .limit(1)
            .get();
          
          if (existingTaxDoc.empty) {
            await db.collection('taxSettings').add(taxSettingsData);
          } else {
            await existingTaxDoc.docs[0].ref.update(taxSettingsData);
          }
          
          result = {
            success: true,
            response: `Tax settings updated successfully! Tax rate: ${extractedData.taxRate}%`,
            data: taxSettingsData
          };
          break;

        // Analytics and Reporting
        case 'getAnalytics':
          // Get analytics data from database
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);

          // Get orders for the specified period
          let ordersSnapshot;
          if (extractedData.period === 'today') {
            ordersSnapshot = await db.collection('orders')
              .where('restaurantId', '==', restaurantId)
              .where('createdAt', '>=', today)
              .where('createdAt', '<', tomorrow)
              .get();
          } else if (extractedData.period === 'week') {
            const weekAgo = new Date(today);
            weekAgo.setDate(weekAgo.getDate() - 7);
            ordersSnapshot = await db.collection('orders')
              .where('restaurantId', '==', restaurantId)
              .where('createdAt', '>=', weekAgo)
              .get();
          } else if (extractedData.period === 'month') {
            const monthAgo = new Date(today);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            ordersSnapshot = await db.collection('orders')
              .where('restaurantId', '==', restaurantId)
              .where('createdAt', '>=', monthAgo)
              .get();
          } else {
            ordersSnapshot = await db.collection('orders')
              .where('restaurantId', '==', restaurantId)
              .get();
          }

          const analyticsOrders = [];
          ordersSnapshot.forEach(doc => {
            analyticsOrders.push({ id: doc.id, ...doc.data() });
          });

          // Calculate analytics
          const totalRevenue = analyticsOrders.reduce((sum, order) => sum + (order.finalAmount || 0), 0);
          const totalOrders = analyticsOrders.length;
          const completedOrders = analyticsOrders.filter(o => o.status === 'COMPLETED').length;
          const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

          result = {
            success: true,
            response: `📊 ${extractedData.period || 'Overall'} Analytics:\n• Total Revenue: ₹${totalRevenue.toFixed(2)}\n• Total Orders: ${totalOrders}\n• Completed Orders: ${completedOrders}\n• Average Order Value: ₹${averageOrderValue.toFixed(2)}`,
            data: {
              period: extractedData.period || 'overall',
              totalRevenue,
              totalOrders,
              completedOrders,
              averageOrderValue,
              orders: analyticsOrders.slice(0, 10) // Show first 10 orders
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
