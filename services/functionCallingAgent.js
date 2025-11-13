const OpenAI = require('openai');
const { db, collections } = require('../firebase');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

/**
 * DineAgent - OpenAI Function Calling Agent
 * Uses OpenAI's function calling (tool use) for agentic behavior
 * Optimized for low payload and cost efficiency
 */
class FunctionCallingAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // Define all available functions for the agent
    this.functions = this.defineFunctions();
  }

  /**
   * Define all available functions for OpenAI function calling
   */
  defineFunctions() {
    return [
      {
        type: 'function',
        function: {
          name: 'get_orders',
          description: 'Get list of orders filtered by status. Returns order details including ID, items, total, status, and timestamp.',
          parameters: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['pending', 'preparing', 'ready', 'completed', 'cancelled', 'all'],
                description: 'Filter orders by status. Use "all" to get all orders.'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of orders to return. Default is 10.',
                default: 10
              }
            }
          },
          required: []
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_order_by_id',
          description: 'Get a specific order by its ID. Returns full order details.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The order ID to look up'
              }
            },
            required: ['order_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'reserve_table',
          description: 'Reserve/book a table for guests. Returns confirmation with table details.',
          parameters: {
            type: 'object',
            properties: {
              table_number: {
                type: 'string',
                description: 'The table number or table ID to reserve'
              },
              guests: {
                type: 'number',
                description: 'Number of guests'
              },
              time: {
                type: 'string',
                description: 'Reservation time in HH:MM format (24-hour)'
              },
              customer_name: {
                type: 'string',
                description: 'Name of the customer making the reservation'
              },
              customer_phone: {
                type: 'string',
                description: 'Phone number of the customer'
              }
            },
            required: ['table_number', 'guests']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_tables',
          description: 'Get FRESH table information including availability, status, and floor details. This function ALWAYS fetches the latest data from the database. Returns summary and detailed list with accurate counts for each status (available, occupied, reserved, cleaning, out-of-service).',
          parameters: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['available', 'occupied', 'reserved', 'cleaning', 'out-of-service', 'all'],
                description: 'Filter tables by status. Use "all" to get all tables with complete statistics.'
              },
              floor: {
                type: 'string',
                description: 'Filter by floor name (e.g., "Ground Floor", "First Floor")'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_table_status',
          description: 'Update the status of a table (e.g., mark as available, occupied, cleaning).',
          parameters: {
            type: 'object',
            properties: {
              table_id: {
                type: 'string',
                description: 'The table ID to update'
              },
              status: {
                type: 'string',
                enum: ['available', 'occupied', 'reserved', 'cleaning', 'out-of-service'],
                description: 'New status for the table'
              }
            },
            required: ['table_id', 'status']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'cancel_order',
          description: 'Cancel a customer order. Only pending or preparing orders can be cancelled.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The order ID to cancel'
              }
            },
            required: ['order_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_menu',
          description: 'Get menu items. Can filter by category or search by name.',
          parameters: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Filter by menu category (e.g., "Main Course", "Desserts")'
              },
              search: {
                type: 'string',
                description: 'Search menu items by name'
              },
              is_veg: {
                type: 'boolean',
                description: 'Filter vegetarian items only'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_sales_summary',
          description: 'Get sales summary for a specific date. Returns total revenue, order count, and breakdown.',
          parameters: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Date in YYYY-MM-DD format. Defaults to today if not provided.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_to_cart',
          description: 'Add menu items to the current order cart. Returns updated cart with items.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    menu_item_id: {
                      type: 'string',
                      description: 'Menu item ID'
                    },
                    name: {
                      type: 'string',
                      description: 'Menu item name'
                    },
                    quantity: {
                      type: 'number',
                      description: 'Quantity to add'
                    },
                    price: {
                      type: 'number',
                      description: 'Price per item'
                    }
                  },
                  required: ['menu_item_id', 'name', 'quantity', 'price']
                },
                description: 'Array of items to add to cart'
              }
            },
            required: ['items']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'place_order',
          description: 'Place an order to the kitchen. Creates a new order from the cart or provided items.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    menu_item_id: { type: 'string' },
                    name: { type: 'string' },
                    quantity: { type: 'number' },
                    price: { type: 'number' }
                  },
                  required: ['menu_item_id', 'name', 'quantity', 'price']
                }
              },
              table_number: {
                type: 'string',
                description: 'Table number for dine-in orders'
              },
              order_type: {
                type: 'string',
                enum: ['dine-in', 'takeaway', 'delivery'],
                description: 'Type of order'
              },
              customer_name: {
                type: 'string',
                description: 'Customer name'
              },
              customer_phone: {
                type: 'string',
                description: 'Customer phone number'
              }
            },
            required: ['items']
          }
        }
      }
    ];
  }

  /**
   * Get Session Summary from Firestore (user preferences, recent activity)
   */
  async getSessionSummary(userId, restaurantId) {
    try {
      // Get user preferences from userRestaurants collection
      const userRestaurantDoc = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (userRestaurantDoc.empty) {
        return 'No user preferences found.';
      }

      const userData = userRestaurantDoc.docs[0].data();
      const role = userData.role || 'staff';
      const name = userData.name || 'User';

      // Get recent conversation summary (last 3 messages)
      // Note: This is handled separately in processQuery, so we skip here

      let summary = `User: ${name}, Role: ${role}`;
      
      // Add any stored preferences
      if (userData.preferences) {
        summary += `. Preferences: ${JSON.stringify(userData.preferences)}`;
      }

      return summary;
    } catch (error) {
      console.error('Error fetching session summary:', error);
      return 'Unable to load user preferences.';
    }
  }

  /**
   * Get Relevant Facts using embeddings (menu items, FAQs, policies)
   * Only fetch if query is relevant to avoid unnecessary API calls
   */
  async getRelevantFacts(query, restaurantId) {
    try {
      // For now, return minimal menu context
      // In production, use embeddings for semantic search
      const menuSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('menu')
        .limit(5) // Keep minimal for cost
        .get();

      const menuItems = [];
      menuSnapshot.forEach(doc => {
        const data = doc.data();
        menuItems.push({
          id: doc.id,
          name: data.name,
          price: data.price,
          category: data.category
        });
      });

      return {
        menuItems: menuItems.slice(0, 5), // Limit to 5 items
        totalMenuItems: menuItems.length
      };
    } catch (error) {
      console.error('Error fetching relevant facts:', error);
      return { menuItems: [], totalMenuItems: 0 };
    }
  }

  /**
   * Get System State (live data - orders, tables, etc.)
   * Only fetch if needed based on query intent
   */
  async getSystemState(restaurantId, query) {
    const state = {};

    // Only fetch what's needed based on query keywords
    const lowerQuery = query.toLowerCase();

    // Fetch tables if query mentions tables
    if (lowerQuery.includes('table') || lowerQuery.includes('reserve') || lowerQuery.includes('booking')) {
      try {
        const floorsSnapshot = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .get();

        let totalTables = 0;
        let availableTables = 0;
        let occupiedTables = 0;

        for (const floorDoc of floorsSnapshot.docs) {
          const tablesSnapshot = await db.collection('restaurants')
            .doc(restaurantId)
            .collection('floors')
            .doc(floorDoc.id)
            .collection('tables')
            .get();

          totalTables += tablesSnapshot.size;
          tablesSnapshot.forEach(tableDoc => {
            const tableData = tableDoc.data();
            if (tableData.status === 'available') availableTables++;
            if (tableData.status === 'occupied') occupiedTables++;
          });
        }

        state.tables = {
          total: totalTables,
          available: availableTables,
          occupied: occupiedTables
        };
      } catch (error) {
        console.error('Error fetching tables:', error);
      }
    }

    // Fetch orders if query mentions orders
    if (lowerQuery.includes('order') || lowerQuery.includes('pending') || lowerQuery.includes('completed')) {
      try {
        const ordersSnapshot = await db.collection('orders')
          .where('restaurantId', '==', restaurantId)
          .where('status', 'in', ['pending', 'preparing'])
          .orderBy('createdAt', 'desc')
          .limit(5)
          .get();

        state.pendingOrders = ordersSnapshot.size;
      } catch (error) {
        console.error('Error fetching orders:', error);
      }
    }

    return state;
  }

  /**
   * Execute a function call
   */
  async executeFunction(functionName, arguments_, restaurantId, userId) {
    console.log(`🔧 Executing function: ${functionName}`, arguments_);

    try {
      switch (functionName) {
        case 'get_orders':
          return await this.getOrders(restaurantId, arguments_.status || 'all', arguments_.limit || 10);
        
        case 'get_order_by_id':
          return await this.getOrderById(restaurantId, arguments_.order_id);
        
        case 'get_tables':
          return await this.getTables(restaurantId, arguments_.status, arguments_.floor);
        
        case 'reserve_table':
          return await this.reserveTable(restaurantId, arguments_);
        
        case 'update_table_status':
          return await this.updateTableStatus(restaurantId, arguments_.table_id, arguments_.status);
        
        case 'cancel_order':
          return await this.cancelOrder(restaurantId, arguments_.order_id);
        
        case 'get_menu':
          return await this.getMenu(restaurantId, arguments_);
        
        case 'get_sales_summary':
          return await this.getSalesSummary(restaurantId, arguments_.date);
        
        case 'add_to_cart':
          return await this.addToCart(arguments_.items);
        
        case 'place_order':
          return await this.placeOrder(restaurantId, arguments_, userId);
        
        default:
          return { error: `Unknown function: ${functionName}` };
      }
    } catch (error) {
      console.error(`Error executing ${functionName}:`, error);
      return { error: error.message };
    }
  }

  /**
   * Function implementations
   */
  async getOrders(restaurantId, status, limit) {
    let query = db.collection('orders')
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    const snapshot = await query
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const orders = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      orders.push({
        id: doc.id,
        orderId: data.orderId || doc.id,
        items: data.items || [],
        total: data.total || 0,
        status: data.status,
        tableNumber: data.tableNumber,
        orderType: data.orderType,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
      });
    });

    return {
      success: true,
      orders,
      count: orders.length
    };
  }

  async getOrderById(restaurantId, orderId) {
    // Try to find by orderId field first
    let snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('orderId', '==', orderId.toString())
      .limit(1)
      .get();

    // If not found, try by document ID
    if (snapshot.empty) {
      const doc = await db.collection('orders').doc(orderId).get();
      if (doc.exists && doc.data().restaurantId === restaurantId) {
        const data = doc.data();
        return {
          success: true,
          order: {
            id: doc.id,
            orderId: data.orderId || doc.id,
            items: data.items || [],
            total: data.total || 0,
            status: data.status,
            tableNumber: data.tableNumber,
            orderType: data.orderType,
            createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
          }
        };
      }
    }

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const data = doc.data();
      return {
        success: true,
        order: {
          id: doc.id,
          orderId: data.orderId || doc.id,
          items: data.items || [],
          total: data.total || 0,
          status: data.status,
          tableNumber: data.tableNumber,
          orderType: data.orderType,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
        }
      };
    }

    return { success: false, error: 'Order not found' };
  }

  async getTables(restaurantId, status, floor) {
    console.log(`🔍 Fetching FRESH table data for restaurant: ${restaurantId}, status filter: ${status}, floor: ${floor}`);
    
    // Always fetch fresh data - no caching
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    const allTables = [];
    const stats = {
      total: 0,
      available: 0,
      occupied: 0,
      reserved: 0,
      cleaning: 0,
      outOfService: 0
    };

    for (const floorDoc of floorsSnapshot.docs) {
      const floorData = floorDoc.data();
      
      // Filter by floor if specified
      if (floor && floorData.name?.toLowerCase() !== floor.toLowerCase()) {
        continue;
      }

      // Fetch fresh data from Firestore
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      console.log(`📊 Floor ${floorData.name}: Found ${tablesSnapshot.size} tables`);

      tablesSnapshot.forEach(tableDoc => {
        const tableData = tableDoc.data();
        const tableStatus = tableData.status || 'available';

        console.log(`  - Table ${tableData.name || tableDoc.id}: Status = ${tableStatus}`);

        // Filter by status if specified
        if (status && status !== 'all' && tableStatus !== status) {
          return;
        }

        stats.total++;
        if (tableStatus === 'available') stats.available++;
        if (tableStatus === 'occupied') stats.occupied++;
        if (tableStatus === 'reserved') stats.reserved++;
        if (tableStatus === 'cleaning') stats.cleaning++;
        if (tableStatus === 'out-of-service') stats.outOfService++;

        allTables.push({
          id: tableDoc.id,
          name: tableData.name || tableDoc.id,
          status: tableStatus,
          floor: floorData.name || 'Unknown',
          capacity: tableData.capacity || 0
        });
      });
    }

    console.log(`✅ Table stats:`, stats);

    return {
      success: true,
      tables: allTables,
      stats,
      byFloor: allTables.reduce((acc, table) => {
        const floorName = table.floor;
        if (!acc[floorName]) {
          acc[floorName] = { total: 0, available: 0, occupied: 0, reserved: 0, cleaning: 0, outOfService: 0 };
        }
        acc[floorName].total++;
        if (table.status === 'available') acc[floorName].available++;
        if (table.status === 'occupied') acc[floorName].occupied++;
        if (table.status === 'reserved') acc[floorName].reserved++;
        if (table.status === 'cleaning') acc[floorName].cleaning++;
        if (table.status === 'out-of-service') acc[floorName].outOfService++;
        return acc;
      }, {})
    };
  }

  async reserveTable(restaurantId, args) {
    // Find table by number or ID
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    let targetTable = null;
    let targetFloorId = null;

    for (const floorDoc of floorsSnapshot.docs) {
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      for (const tableDoc of tablesSnapshot.docs) {
        const tableData = tableDoc.data();
        if (tableData.name === args.table_number || tableDoc.id === args.table_number) {
          targetTable = tableDoc;
          targetFloorId = floorDoc.id;
          break;
        }
      }
      if (targetTable) break;
    }

    if (!targetTable) {
      return { success: false, error: `Table ${args.table_number} not found` };
    }

    const tableData = targetTable.data();
    if (tableData.status !== 'available') {
      return { success: false, error: `Table ${args.table_number} is ${tableData.status}, cannot reserve` };
    }

    // Update table status
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(targetFloorId)
      .collection('tables')
      .doc(targetTable.id)
      .update({
        status: 'reserved',
        reservedBy: args.customer_name || 'Unknown',
        reservedPhone: args.customer_phone || '',
        reservedGuests: args.guests,
        reservedTime: args.time || new Date().toISOString(),
        updatedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `Table ${args.table_number} reserved for ${args.guests} guests${args.time ? ` at ${args.time}` : ''}`,
      table: {
        id: targetTable.id,
        name: tableData.name,
        floor: targetTable.ref.parent.parent.id
      }
    };
  }

  async updateTableStatus(restaurantId, tableId, status) {
    // Find table
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    let targetTable = null;
    let targetFloorId = null;

    for (const floorDoc of floorsSnapshot.docs) {
      const tableDoc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .doc(tableId)
        .get();

      if (tableDoc.exists) {
        targetTable = tableDoc;
        targetFloorId = floorDoc.id;
        break;
      }
    }

    if (!targetTable) {
      return { success: false, error: 'Table not found' };
    }

    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(targetFloorId)
      .collection('tables')
      .doc(tableId)
      .update({
        status,
        updatedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `Table status updated to ${status}`,
      table: {
        id: tableId,
        status
      }
    };
  }

  async cancelOrder(restaurantId, orderId) {
    // Find order
    let snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('orderId', '==', orderId.toString())
      .limit(1)
      .get();

    if (snapshot.empty) {
      const doc = await db.collection('orders').doc(orderId).get();
      if (doc.exists && doc.data().restaurantId === restaurantId) {
        snapshot = { docs: [doc] };
      }
    }

    if (snapshot.empty || !snapshot.docs) {
      return { success: false, error: 'Order not found' };
    }

    const orderDoc = snapshot.docs[0];
    const orderData = orderDoc.data();

    if (['completed', 'cancelled'].includes(orderData.status)) {
      return { success: false, error: `Cannot cancel order with status: ${orderData.status}` };
    }

    await db.collection('orders')
      .doc(orderDoc.id)
      .update({
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `Order ${orderId} has been cancelled`,
      order: {
        id: orderDoc.id,
        orderId: orderData.orderId || orderDoc.id,
        status: 'cancelled'
      }
    };
  }

  async getMenu(restaurantId, args) {
    let query = db.collection('restaurants')
      .doc(restaurantId)
      .collection('menu');

    const snapshot = await query.get();
    let menuItems = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // Apply filters
      if (args.category && data.category?.toLowerCase() !== args.category.toLowerCase()) {
        return;
      }
      if (args.is_veg !== undefined && data.isVeg !== args.is_veg) {
        return;
      }
      if (args.search && !data.name?.toLowerCase().includes(args.search.toLowerCase())) {
        return;
      }

      menuItems.push({
        id: doc.id,
        name: data.name,
        price: data.price,
        category: data.category,
        description: data.description,
        isVeg: data.isVeg
      });
    });

    return {
      success: true,
      menuItems,
      count: menuItems.length
    };
  }

  async getSalesSummary(restaurantId, date) {
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'completed')
      .where('createdAt', '>=', startOfDay)
      .where('createdAt', '<=', endOfDay)
      .get();

    let totalRevenue = 0;
    let orderCount = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      totalRevenue += data.total || 0;
      orderCount++;
    });

    return {
      success: true,
      date: targetDate.toISOString().split('T')[0],
      totalRevenue,
      orderCount,
      averageOrderValue: orderCount > 0 ? totalRevenue / orderCount : 0
    };
  }

  async addToCart(items) {
    // This is a UI action - return items to be added to frontend cart
    return {
      success: true,
      message: `Added ${items.length} item(s) to cart`,
      items,
      action: 'add_to_cart'
    };
  }

  async placeOrder(restaurantId, args, userId) {
    // Create order in database
    const orderData = {
      restaurantId,
      items: args.items,
      total: args.items.reduce((sum, item) => sum + (item.price * item.quantity), 0),
      status: 'pending',
      tableNumber: args.table_number || null,
      orderType: args.order_type || 'dine-in',
      customerName: args.customer_name || null,
      customerPhone: args.customer_phone || null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const orderRef = await db.collection('orders').add(orderData);
    
    // Generate order ID
    const orderId = orderRef.id.slice(-6).toUpperCase();
    await orderRef.update({ orderId });

    return {
      success: true,
      message: `Order placed successfully. Order ID: ${orderId}`,
      order: {
        id: orderRef.id,
        orderId,
        ...orderData
      },
      action: 'place_order'
    };
  }

  /**
   * Process user query using OpenAI function calling
   */
  async processQuery(query, restaurantId, userId, conversationHistory = []) {
    try {
      // Fetch context (minimal for cost efficiency)
      const sessionSummary = await this.getSessionSummary(userId, restaurantId);
      const relevantFacts = await this.getRelevantFacts(query, restaurantId);
      const systemState = await this.getSystemState(restaurantId, query);

      // Build messages for OpenAI
      const messages = [
        {
          role: 'system',
          content: `You are "DineAgent", an intelligent restaurant operations assistant connected to the restaurant's backend APIs and Firestore database.

Your goals:
1. Answer questions and take actions related to restaurant operations — orders, tables, reservations, customers, billing, and menu.
2. Use facts provided under "Relevant facts" for static info (menu, FAQs, policies).
3. Use "System state" data for dynamic info (orders, tables, etc.).
4. Always respond concisely, clearly, and politely.
5. When an action is needed, return a structured function call (do not make up data). The backend will execute it.
6. Remember the user's stable preferences and use them for personalized responses (from SessionSummary).

---

### 🔧 Context structure you will receive:
- **SessionSummary:** ${sessionSummary}
- **Relevant facts:** ${JSON.stringify(relevantFacts)}
- **System state:** ${JSON.stringify(systemState)}
- **Recent conversation:** Last ${conversationHistory.length} messages

---

### 💬 Behavior rules:
- **IMPORTANT: Context Awareness**: When a user says "check again", "what about...", "and...", "also...", or similar follow-up phrases, you MUST understand they are referring to the previous topic in the conversation. Look at the conversation history to understand what was discussed.
- If the user previously asked about tables and now says "check again", they want you to check tables again using the get_tables function.
- If the user previously asked about orders and now says "what about pending ones", they want pending orders.
- Never hallucinate; if you lack info, ask clarifying questions.
- Use exact prices, menu items, or table details only if provided in context or system state.
- Be concise — 1–3 sentences unless a longer explanation is necessary.
- Use friendly tone suitable for restaurant staff or owners.
- If a user greets you, greet them back by name (if known from SessionSummary).
- Don't show JSON, code, or internal system text to the user — only natural language output.

---

### ⚙️ Function calling:
When the user's intent is to perform an action, use the appropriate function. Always execute the function call - do not just describe what you would do.
For follow-up queries like "check again", "what about X", always call the relevant function to get fresh data.`
        },
        ...conversationHistory.slice(-8), // Last 8 messages for better context
        {
          role: 'user',
          content: query
        }
      ];

      // Call OpenAI with function calling
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', // Use mini for cost efficiency
        messages,
        tools: this.functions,
        tool_choice: 'auto', // Let model decide when to use functions
        temperature: 0.7,
        max_tokens: 500 // Limit response length
      });

      const message = response.choices[0].message;

      // Check if function call was made
      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0];
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`🔧 Function call detected: ${functionName}`, functionArgs);

        // Execute function
        const functionResult = await this.executeFunction(
          functionName,
          functionArgs,
          restaurantId,
          userId
        );

        // Send function result back to GPT for natural language response
        const followUpMessages = [
          ...messages,
          message,
          {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(functionResult)
          }
        ];

        const finalResponse = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: followUpMessages,
          temperature: 0.7,
          max_tokens: 300 // Keep response concise
        });

        const finalMessage = finalResponse.choices[0].message.content;

        return {
          success: true,
          response: finalMessage,
          functionCalled: functionName,
          functionResult,
          hasData: true,
          data: functionResult
        };
      } else {
        // Direct text response
        return {
          success: true,
          response: message.content,
          functionCalled: null
        };
      }
    } catch (error) {
      console.error('Function calling agent error:', error);
      return {
        success: false,
        error: error.message,
        response: 'Sorry, I encountered an error. Please try again.'
      };
    }
  }
}

module.exports = FunctionCallingAgent;

