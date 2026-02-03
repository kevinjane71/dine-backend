/**
 * DineAI Tool Executor
 * Wraps existing DineOpen APIs as tools for the voice assistant
 */

const { getDb, collections } = require('../../firebase');
const { FieldValue } = require('firebase-admin/firestore');
const dineaiPermissions = require('./DineAIPermissions');

class DineAIToolExecutor {
  constructor() {
    this.tools = this.defineTools();
  }

  /**
   * Define all available tools for OpenAI function calling
   */
  defineTools() {
    return [
      // Order Management
      {
        type: 'function',
        function: {
          name: 'get_orders',
          description: 'Get list of orders filtered by status, table, or date. Returns order details including ID, items, total, status, and timestamp.',
          parameters: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['pending', 'preparing', 'ready', 'completed', 'cancelled', 'all'],
                description: 'Filter orders by status. Use "all" to get all orders.'
              },
              table_number: {
                type: 'string',
                description: 'Filter orders by table number'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of orders to return. Default is 10.',
                default: 10
              }
            }
          }
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
          name: 'place_order',
          description: 'Place an order to the kitchen. Creates a new order with proper price calculation, tax, and table status update.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Menu item name' },
                    quantity: { type: 'number', description: 'Quantity to order' },
                    menu_item_id: { type: 'string', description: 'Menu item ID (optional)' },
                    selectedVariant: {
                      type: 'object',
                      description: 'Selected variant (e.g., Half/Full)',
                      properties: {
                        name: { type: 'string' },
                        price: { type: 'number' }
                      }
                    },
                    notes: { type: 'string', description: 'Special notes for this item' }
                  },
                  required: ['name', 'quantity']
                },
                description: 'Array of items to order'
              },
              table_number: {
                type: 'string',
                description: 'Table number for dine-in orders'
              },
              order_type: {
                type: 'string',
                enum: ['dine-in', 'takeaway', 'delivery'],
                description: 'Type of order (default: dine-in)'
              },
              customer_name: { type: 'string', description: 'Customer name' },
              customer_phone: { type: 'string', description: 'Customer phone number' },
              notes: { type: 'string', description: 'Order notes or special instructions' }
            },
            required: ['items']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_order_status',
          description: 'Change the status of an order (pending→preparing→ready→completed)',
          parameters: {
            type: 'object',
            properties: {
              order_id: { type: 'string', description: 'The order ID to update' },
              status: {
                type: 'string',
                enum: ['pending', 'preparing', 'ready', 'completed', 'cancelled'],
                description: 'New status for the order'
              }
            },
            required: ['order_id', 'status']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'cancel_order',
          description: 'Cancel an existing order. Only pending or preparing orders can be cancelled.',
          parameters: {
            type: 'object',
            properties: {
              order_id: { type: 'string', description: 'The order ID to cancel' }
            },
            required: ['order_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'complete_billing',
          description: 'Process payment and complete an order billing',
          parameters: {
            type: 'object',
            properties: {
              order_id: { type: 'string', description: 'The order ID to bill' },
              payment_method: {
                type: 'string',
                enum: ['cash', 'card', 'upi', 'online'],
                description: 'Payment method'
              },
              discount: { type: 'number', description: 'Discount amount (optional)' }
            },
            required: ['order_id', 'payment_method']
          }
        }
      },

      // Table Management
      {
        type: 'function',
        function: {
          name: 'get_tables',
          description: 'Get all tables with their status (available, occupied, reserved, cleaning)',
          parameters: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['available', 'occupied', 'reserved', 'cleaning', 'all'],
                description: 'Filter tables by status'
              },
              floor: { type: 'string', description: 'Filter by floor name' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_table_status',
          description: 'Get detailed status of a specific table',
          parameters: {
            type: 'object',
            properties: {
              table_number: { type: 'string', description: 'The table number' }
            },
            required: ['table_number']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'reserve_table',
          description: 'Create a table reservation',
          parameters: {
            type: 'object',
            properties: {
              table_number: { type: 'string', description: 'Table number to reserve' },
              guests: { type: 'number', description: 'Number of guests' },
              time: { type: 'string', description: 'Reservation time (HH:MM format)' },
              customer_name: { type: 'string', description: 'Customer name' },
              customer_phone: { type: 'string', description: 'Customer phone' }
            },
            required: ['table_number', 'guests']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_table_status',
          description: 'Update the status of a table',
          parameters: {
            type: 'object',
            properties: {
              table_number: { type: 'string', description: 'Table number to update' },
              status: {
                type: 'string',
                enum: ['available', 'occupied', 'reserved', 'cleaning'],
                description: 'New status'
              }
            },
            required: ['table_number', 'status']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_table_order',
          description: 'Get the active order for a specific table',
          parameters: {
            type: 'object',
            properties: {
              table_number: { type: 'string', description: 'Table number' }
            },
            required: ['table_number']
          }
        }
      },

      // Menu Operations
      {
        type: 'function',
        function: {
          name: 'get_menu',
          description: 'Get the full menu with categories',
          parameters: {
            type: 'object',
            properties: {
              category: { type: 'string', description: 'Filter by category' },
              is_veg: { type: 'boolean', description: 'Filter vegetarian items only' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_menu_items',
          description: 'Search menu items by name or description',
          parameters: {
            type: 'object',
            properties: {
              search_term: { type: 'string', description: 'Search term' },
              category: { type: 'string', description: 'Filter by category' },
              is_veg: { type: 'boolean', description: 'Filter vegetarian only' }
            },
            required: ['search_term']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_item_availability',
          description: 'Check if a specific menu item is available',
          parameters: {
            type: 'object',
            properties: {
              item_name: { type: 'string', description: 'Menu item name' }
            },
            required: ['item_name']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_menu_item',
          description: 'Add a new item to the menu',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Item name' },
              price: { type: 'number', description: 'Item price' },
              category: { type: 'string', description: 'Category name' },
              description: { type: 'string', description: 'Item description' },
              is_veg: { type: 'boolean', description: 'Is vegetarian' },
              spice_level: {
                type: 'string',
                enum: ['mild', 'medium', 'hot', 'extra-hot'],
                description: 'Spice level'
              }
            },
            required: ['name', 'price', 'category']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_menu_item',
          description: 'Update an existing menu item',
          parameters: {
            type: 'object',
            properties: {
              item_name: { type: 'string', description: 'Current item name to find' },
              menu_item_id: { type: 'string', description: 'Menu item ID (preferred)' },
              new_name: { type: 'string', description: 'New name' },
              new_price: { type: 'number', description: 'New price' },
              new_category: { type: 'string', description: 'New category' },
              description: { type: 'string', description: 'New description' },
              is_available: { type: 'boolean', description: 'Availability status' }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'toggle_item_availability',
          description: 'Mark a menu item as available or unavailable',
          parameters: {
            type: 'object',
            properties: {
              item_name: { type: 'string', description: 'Menu item name' },
              is_available: { type: 'boolean', description: 'Availability status' }
            },
            required: ['item_name', 'is_available']
          }
        }
      },

      // Knowledge Base
      {
        type: 'function',
        function: {
          name: 'search_knowledge',
          description: 'Search the restaurant knowledge base for information about policies, procedures, FAQs, etc.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              category: {
                type: 'string',
                enum: ['faq', 'policy', 'menu', 'procedure', 'general'],
                description: 'Filter by category'
              }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_restaurant_info',
          description: 'Get restaurant details, hours, location, and policies',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },

      // Analytics
      {
        type: 'function',
        function: {
          name: 'get_today_summary',
          description: 'Get today\'s summary: orders, revenue, popular items, table occupancy',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_sales_summary',
          description: 'Get sales summary for a specific date or date range',
          parameters: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
              start_date: { type: 'string', description: 'Start date for range' },
              end_date: { type: 'string', description: 'End date for range' }
            }
          }
        }
      },

      // Inventory
      {
        type: 'function',
        function: {
          name: 'get_inventory_alerts',
          description: 'Get low stock items and expiring inventory alerts',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },

      // Customer Management
      {
        type: 'function',
        function: {
          name: 'get_customers',
          description: 'Get list of customers',
          parameters: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Search by name or phone' },
              limit: { type: 'number', description: 'Maximum results', default: 20 }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_customer_by_id',
          description: 'Get customer details by ID or phone',
          parameters: {
            type: 'object',
            properties: {
              customer_id: { type: 'string', description: 'Customer ID' },
              phone: { type: 'string', description: 'Customer phone number' }
            }
          }
        }
      }
    ];
  }

  /**
   * Get tools filtered by user role
   */
  getToolsForRole(role) {
    return dineaiPermissions.filterToolsForRole(this.tools, role);
  }

  /**
   * Execute a tool/function
   */
  async executeFunction(functionName, args, restaurantId, userId, userRole) {
    console.log(`🔧 DineAI executing: ${functionName}`, args);

    // Check permission
    if (!dineaiPermissions.hasPermission(userRole, functionName)) {
      return {
        success: false,
        error: `You don't have permission to ${functionName.replace(/_/g, ' ')}. Your role: ${userRole}`
      };
    }

    try {
      switch (functionName) {
        // Order Management
        case 'get_orders':
          return await this.getOrders(restaurantId, args);
        case 'get_order_by_id':
          return await this.getOrderById(restaurantId, args.order_id);
        case 'place_order':
          return await this.placeOrder(restaurantId, args, userId);
        case 'update_order_status':
          return await this.updateOrderStatus(restaurantId, args.order_id, args.status);
        case 'cancel_order':
          return await this.cancelOrder(restaurantId, args.order_id);
        case 'complete_billing':
          return await this.completeBilling(restaurantId, args);

        // Table Management
        case 'get_tables':
          return await this.getTables(restaurantId, args);
        case 'get_table_status':
          return await this.getTableStatus(restaurantId, args.table_number);
        case 'reserve_table':
          return await this.reserveTable(restaurantId, args);
        case 'update_table_status':
          return await this.updateTableStatus(restaurantId, args.table_number, args.status);
        case 'get_table_order':
          return await this.getTableOrder(restaurantId, args.table_number);

        // Menu Operations
        case 'get_menu':
          return await this.getMenu(restaurantId, args);
        case 'search_menu_items':
          return await this.searchMenuItems(restaurantId, args);
        case 'get_item_availability':
          return await this.getItemAvailability(restaurantId, args.item_name);
        case 'add_menu_item':
          return await this.addMenuItem(restaurantId, args, userId);
        case 'update_menu_item':
          return await this.updateMenuItem(restaurantId, args);
        case 'toggle_item_availability':
          return await this.toggleItemAvailability(restaurantId, args.item_name, args.is_available);

        // Knowledge Base
        case 'search_knowledge':
          return await this.searchKnowledge(restaurantId, args.query, args.category);
        case 'get_restaurant_info':
          return await this.getRestaurantInfo(restaurantId);

        // Analytics
        case 'get_today_summary':
          return await this.getTodaySummary(restaurantId);
        case 'get_sales_summary':
          return await this.getSalesSummary(restaurantId, args);

        // Inventory
        case 'get_inventory_alerts':
          return await this.getInventoryAlerts(restaurantId);

        // Customer Management
        case 'get_customers':
          return await this.getCustomers(restaurantId, args);
        case 'get_customer_by_id':
          return await this.getCustomerById(restaurantId, args);

        default:
          return { success: false, error: `Unknown function: ${functionName}` };
      }
    } catch (error) {
      console.error(`Error executing ${functionName}:`, error);
      return { success: false, error: error.message };
    }
  }

  // ================== Order Management ==================

  async getOrders(restaurantId, args) {
    const db = getDb();
    let query = db.collection('orders').where('restaurantId', '==', restaurantId);

    if (args.status && args.status !== 'all') {
      query = query.where('status', '==', args.status);
    }

    if (args.table_number) {
      query = query.where('tableNumber', '==', args.table_number);
    }

    const snapshot = await query
      .orderBy('createdAt', 'desc')
      .limit(args.limit || 10)
      .get();

    const orders = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      orders.push({
        id: doc.id,
        orderId: data.orderId || doc.id,
        items: (data.items || []).map(item => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price
        })),
        total: data.total || 0,
        status: data.status,
        tableNumber: data.tableNumber,
        orderType: data.orderType || 'dine-in',
        customerName: data.customerName,
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
    const db = getDb();
    // Try to find by orderId field first
    let snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('orderId', '==', parseInt(orderId) || orderId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      // Try by document ID
      const doc = await db.collection('orders').doc(orderId).get();
      if (!doc.exists || doc.data().restaurantId !== restaurantId) {
        return { success: false, error: `Order ${orderId} not found` };
      }
      const data = doc.data();
      return {
        success: true,
        order: {
          id: doc.id,
          orderId: data.orderId || doc.id,
          items: data.items || [],
          total: data.total,
          subtotal: data.subtotal,
          tax: data.tax,
          status: data.status,
          tableNumber: data.tableNumber,
          orderType: data.orderType,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          notes: data.notes,
          createdAt: data.createdAt?.toDate?.()?.toISOString(),
          updatedAt: data.updatedAt?.toDate?.()?.toISOString()
        }
      };
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    return {
      success: true,
      order: {
        id: doc.id,
        orderId: data.orderId || doc.id,
        items: data.items || [],
        total: data.total,
        subtotal: data.subtotal,
        tax: data.tax,
        status: data.status,
        tableNumber: data.tableNumber,
        orderType: data.orderType,
        customerName: data.customerName,
        customerPhone: data.customerPhone,
        notes: data.notes,
        createdAt: data.createdAt?.toDate?.()?.toISOString(),
        updatedAt: data.updatedAt?.toDate?.()?.toISOString()
      }
    };
  }

  async placeOrder(restaurantId, args, userId) {
    const db = getDb();
    // Get menu items to match names to IDs and get prices
    const menuSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('menu')
      .get();

    const menuItems = {};
    menuSnapshot.forEach(doc => {
      const data = doc.data();
      menuItems[data.name.toLowerCase()] = { id: doc.id, ...data };
    });

    // Process order items
    const processedItems = [];
    let subtotal = 0;

    for (const item of args.items) {
      const menuItem = menuItems[item.name.toLowerCase()];
      if (!menuItem) {
        return { success: false, error: `Menu item "${item.name}" not found` };
      }

      const quantity = item.quantity || 1;
      let itemPrice = menuItem.price;

      // Handle variant pricing
      if (item.selectedVariant && menuItem.variants) {
        const variant = menuItem.variants.find(v =>
          v.name.toLowerCase() === item.selectedVariant.name.toLowerCase()
        );
        if (variant) {
          itemPrice = variant.price;
        }
      }

      const itemTotal = itemPrice * quantity;
      subtotal += itemTotal;

      processedItems.push({
        menuItemId: menuItem.id,
        name: menuItem.name,
        price: itemPrice,
        quantity,
        total: itemTotal,
        selectedVariant: item.selectedVariant || null,
        notes: item.notes || ''
      });
    }

    // Get restaurant settings for tax
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    const restaurantData = restaurantDoc.data() || {};
    const taxRate = restaurantData.taxSettings?.taxRate || 0;
    const tax = Math.round(subtotal * (taxRate / 100) * 100) / 100;
    const total = subtotal + tax;

    // Generate order ID
    const todayStr = new Date().toISOString().split('T')[0];
    const counterRef = db.collection('daily_order_counters').doc(`${restaurantId}_${todayStr}`);
    const counterDoc = await counterRef.get();
    let orderId = 1;

    if (counterDoc.exists) {
      orderId = counterDoc.data().lastOrderId + 1;
      await counterRef.update({ lastOrderId: orderId, updatedAt: new Date() });
    } else {
      await counterRef.set({
        restaurantId,
        date: todayStr,
        lastOrderId: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    // Create order
    const orderData = {
      restaurantId,
      orderId,
      items: processedItems,
      subtotal,
      tax,
      taxRate,
      total,
      status: 'pending',
      orderType: args.order_type || 'dine-in',
      tableNumber: args.table_number || null,
      customerName: args.customer_name || null,
      customerPhone: args.customer_phone || null,
      notes: args.notes || '',
      createdBy: userId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const orderRef = await db.collection('orders').add(orderData);

    // Update table status if table number provided
    if (args.table_number) {
      await this.updateTableStatus(restaurantId, args.table_number, 'occupied');
    }

    return {
      success: true,
      order: {
        id: orderRef.id,
        orderId,
        items: processedItems,
        subtotal,
        tax,
        total,
        status: 'pending',
        tableNumber: args.table_number
      },
      message: `Order #${orderId} placed successfully${args.table_number ? ` for table ${args.table_number}` : ''}`
    };
  }

  async updateOrderStatus(restaurantId, orderId, status) {
    const orderResult = await this.getOrderById(restaurantId, orderId);
    if (!orderResult.success) {
      return orderResult;
    }

    const db = getDb();
    const order = orderResult.order;
    await db.collection('orders').doc(order.id).update({
      status,
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `Order #${order.orderId} status updated to ${status}`,
      order: { ...order, status }
    };
  }

  async cancelOrder(restaurantId, orderId) {
    const orderResult = await this.getOrderById(restaurantId, orderId);
    if (!orderResult.success) {
      return orderResult;
    }

    const db = getDb();
    const order = orderResult.order;
    if (!['pending', 'preparing'].includes(order.status)) {
      return { success: false, error: `Cannot cancel order with status: ${order.status}` };
    }

    await db.collection('orders').doc(order.id).update({
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      success: true,
      message: `Order #${order.orderId} has been cancelled`,
      order: { ...order, status: 'cancelled' }
    };
  }

  async completeBilling(restaurantId, args) {
    const orderResult = await this.getOrderById(restaurantId, args.order_id);
    if (!orderResult.success) {
      return orderResult;
    }

    const db = getDb();
    const order = orderResult.order;
    const discount = args.discount || 0;
    const finalTotal = order.total - discount;

    await db.collection('orders').doc(order.id).update({
      status: 'completed',
      paymentMethod: args.payment_method,
      discount,
      finalTotal,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    // Free up the table
    if (order.tableNumber) {
      await this.updateTableStatus(restaurantId, order.tableNumber, 'cleaning');
    }

    return {
      success: true,
      message: `Order #${order.orderId} billing completed. Total: ₹${finalTotal}`,
      order: {
        ...order,
        status: 'completed',
        paymentMethod: args.payment_method,
        discount,
        finalTotal
      }
    };
  }

  // ================== Table Management ==================

  async getTables(restaurantId, args) {
    const db = getDb();
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    const tables = [];
    const statusCount = { available: 0, occupied: 0, reserved: 0, cleaning: 0 };

    for (const floorDoc of floorsSnapshot.docs) {
      const floorData = floorDoc.data();
      const floorName = floorData.name || 'Main Floor';

      if (args.floor && floorName.toLowerCase() !== args.floor.toLowerCase()) {
        continue;
      }

      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      tablesSnapshot.forEach(tableDoc => {
        const tableData = tableDoc.data();
        const status = tableData.status || 'available';

        if (args.status && args.status !== 'all' && status !== args.status) {
          return;
        }

        statusCount[status] = (statusCount[status] || 0) + 1;

        tables.push({
          id: tableDoc.id,
          number: tableData.number || tableData.tableNumber,
          floor: floorName,
          floorId: floorDoc.id,
          status,
          capacity: tableData.capacity || tableData.seats || 4,
          currentOrder: tableData.currentOrderId || null
        });
      });
    }

    return {
      success: true,
      tables,
      summary: statusCount,
      total: tables.length
    };
  }

  async getTableStatus(restaurantId, tableNumber) {
    const tablesResult = await this.getTables(restaurantId, {});
    const table = tablesResult.tables.find(t =>
      String(t.number) === String(tableNumber)
    );

    if (!table) {
      return { success: false, error: `Table ${tableNumber} not found` };
    }

    // Get current order if occupied
    let currentOrder = null;
    if (table.status === 'occupied') {
      const orderResult = await this.getTableOrder(restaurantId, tableNumber);
      if (orderResult.success) {
        currentOrder = orderResult.order;
      }
    }

    return {
      success: true,
      table: {
        ...table,
        currentOrder
      }
    };
  }

  async reserveTable(restaurantId, args) {
    const tableResult = await this.getTableStatus(restaurantId, args.table_number);
    if (!tableResult.success) {
      return tableResult;
    }

    const db = getDb();
    const table = tableResult.table;
    if (table.status !== 'available') {
      return { success: false, error: `Table ${args.table_number} is currently ${table.status}` };
    }

    // Update table status
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(table.floorId)
      .collection('tables')
      .doc(table.id)
      .update({
        status: 'reserved',
        reservedBy: args.customer_name || 'Guest',
        reservedPhone: args.customer_phone || null,
        reservedGuests: args.guests,
        reservedTime: args.time || null,
        reservedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `Table ${args.table_number} reserved for ${args.guests} guests${args.customer_name ? ` (${args.customer_name})` : ''}`,
      table: {
        ...table,
        status: 'reserved',
        reservedBy: args.customer_name,
        reservedGuests: args.guests
      }
    };
  }

  async updateTableStatus(restaurantId, tableNumber, status) {
    const db = getDb();
    const tablesResult = await this.getTables(restaurantId, {});
    const table = tablesResult.tables.find(t =>
      String(t.number) === String(tableNumber)
    );

    if (!table) {
      return { success: false, error: `Table ${tableNumber} not found` };
    }

    const updateData = {
      status,
      updatedAt: FieldValue.serverTimestamp()
    };

    // Clear reservation data if making available
    if (status === 'available') {
      updateData.reservedBy = null;
      updateData.reservedPhone = null;
      updateData.reservedGuests = null;
      updateData.reservedTime = null;
      updateData.reservedAt = null;
      updateData.currentOrderId = null;
    }

    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(table.floorId)
      .collection('tables')
      .doc(table.id)
      .update(updateData);

    return {
      success: true,
      message: `Table ${tableNumber} is now ${status}`,
      table: { ...table, status }
    };
  }

  async getTableOrder(restaurantId, tableNumber) {
    const db = getDb();
    const snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('tableNumber', '==', tableNumber)
      .where('status', 'in', ['pending', 'preparing', 'ready'])
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return { success: false, error: `No active order for table ${tableNumber}` };
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    return {
      success: true,
      order: {
        id: doc.id,
        orderId: data.orderId,
        items: data.items,
        total: data.total,
        status: data.status,
        tableNumber: data.tableNumber
      }
    };
  }

  // ================== Menu Operations ==================

  async getMenu(restaurantId, args) {
    const db = getDb();
    let query = db.collection('restaurants')
      .doc(restaurantId)
      .collection('menu')
      .where('isDeleted', '!=', true);

    const snapshot = await query.get();
    const items = [];
    const categories = new Set();

    snapshot.forEach(doc => {
      const data = doc.data();

      if (args.category && data.category?.toLowerCase() !== args.category.toLowerCase()) {
        return;
      }

      if (args.is_veg !== undefined && data.isVeg !== args.is_veg) {
        return;
      }

      categories.add(data.category);

      items.push({
        id: doc.id,
        name: data.name,
        price: data.price,
        category: data.category,
        description: data.description,
        isVeg: data.isVeg,
        isAvailable: data.isAvailable !== false,
        spiceLevel: data.spiceLevel,
        variants: data.variants || []
      });
    });

    return {
      success: true,
      items,
      categories: Array.from(categories),
      count: items.length
    };
  }

  async searchMenuItems(restaurantId, args) {
    const menuResult = await this.getMenu(restaurantId, {
      category: args.category,
      is_veg: args.is_veg
    });

    if (!menuResult.success) {
      return menuResult;
    }

    const searchTerm = args.search_term.toLowerCase();
    const matchedItems = menuResult.items.filter(item =>
      item.name.toLowerCase().includes(searchTerm) ||
      (item.description && item.description.toLowerCase().includes(searchTerm))
    );

    return {
      success: true,
      items: matchedItems,
      count: matchedItems.length
    };
  }

  async getItemAvailability(restaurantId, itemName) {
    const searchResult = await this.searchMenuItems(restaurantId, { search_term: itemName });

    if (!searchResult.success || searchResult.count === 0) {
      return { success: false, error: `Item "${itemName}" not found in menu` };
    }

    const item = searchResult.items[0];
    return {
      success: true,
      item: {
        name: item.name,
        price: item.price,
        isAvailable: item.isAvailable,
        category: item.category
      },
      message: item.isAvailable
        ? `${item.name} is available (₹${item.price})`
        : `${item.name} is currently unavailable`
    };
  }

  async addMenuItem(restaurantId, args, userId) {
    const db = getDb();
    const menuData = {
      name: args.name,
      price: args.price,
      category: args.category,
      description: args.description || '',
      isVeg: args.is_veg || false,
      spiceLevel: args.spice_level || 'medium',
      isAvailable: true,
      isDeleted: false,
      createdBy: userId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('menu')
      .add(menuData);

    return {
      success: true,
      message: `Added "${args.name}" to menu at ₹${args.price}`,
      item: { id: ref.id, ...menuData }
    };
  }

  async updateMenuItem(restaurantId, args) {
    const db = getDb();
    // Find item by name or ID
    let itemDoc = null;

    if (args.menu_item_id) {
      const doc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('menu')
        .doc(args.menu_item_id)
        .get();
      if (doc.exists) {
        itemDoc = { id: doc.id, ref: doc.ref, data: doc.data() };
      }
    } else if (args.item_name) {
      const searchResult = await this.searchMenuItems(restaurantId, { search_term: args.item_name });
      if (searchResult.success && searchResult.count > 0) {
        const item = searchResult.items[0];
        const doc = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('menu')
          .doc(item.id)
          .get();
        itemDoc = { id: doc.id, ref: doc.ref, data: doc.data() };
      }
    }

    if (!itemDoc) {
      return { success: false, error: 'Menu item not found' };
    }

    const updateData = { updatedAt: FieldValue.serverTimestamp() };

    if (args.new_name) updateData.name = args.new_name;
    if (args.new_price !== undefined) updateData.price = args.new_price;
    if (args.new_category) updateData.category = args.new_category;
    if (args.description !== undefined) updateData.description = args.description;
    if (args.is_available !== undefined) updateData.isAvailable = args.is_available;

    await itemDoc.ref.update(updateData);

    return {
      success: true,
      message: `Updated "${itemDoc.data.name}" successfully`,
      item: { ...itemDoc.data, ...updateData }
    };
  }

  async toggleItemAvailability(restaurantId, itemName, isAvailable) {
    const searchResult = await this.searchMenuItems(restaurantId, { search_term: itemName });

    if (!searchResult.success || searchResult.count === 0) {
      return { success: false, error: `Item "${itemName}" not found` };
    }

    const db = getDb();
    const item = searchResult.items[0];

    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('menu')
      .doc(item.id)
      .update({
        isAvailable,
        updatedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `${item.name} is now ${isAvailable ? 'available' : 'unavailable'}`,
      item: { ...item, isAvailable }
    };
  }

  // ================== Knowledge Base ==================

  async searchKnowledge(restaurantId, query, category) {
    // This will be implemented with Pinecone in Phase 2
    // For now, return a placeholder
    return {
      success: true,
      results: [],
      message: 'Knowledge base search will be available soon'
    };
  }

  async getRestaurantInfo(restaurantId) {
    const db = getDb();
    const doc = await db.collection('restaurants').doc(restaurantId).get();

    if (!doc.exists) {
      return { success: false, error: 'Restaurant not found' };
    }

    const data = doc.data();

    return {
      success: true,
      restaurant: {
        name: data.name,
        address: data.address,
        phone: data.phone,
        email: data.email,
        hours: data.hours || 'Not specified',
        cuisine: data.cuisine,
        description: data.description,
        taxSettings: {
          taxEnabled: data.taxSettings?.taxEnabled || false,
          taxRate: data.taxSettings?.taxRate || 0
        }
      }
    };
  }

  // ================== Analytics ==================

  async getTodaySummary(restaurantId) {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const ordersSnapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', today)
      .get();

    let totalRevenue = 0;
    let completedOrders = 0;
    let pendingOrders = 0;
    const itemCounts = {};

    ordersSnapshot.forEach(doc => {
      const data = doc.data();
      if (data.status === 'completed') {
        totalRevenue += data.total || data.finalTotal || 0;
        completedOrders++;
      } else if (['pending', 'preparing', 'ready'].includes(data.status)) {
        pendingOrders++;
      }

      // Count popular items
      (data.items || []).forEach(item => {
        itemCounts[item.name] = (itemCounts[item.name] || 0) + item.quantity;
      });
    });

    // Get popular items
    const popularItems = Object.entries(itemCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // Get table status
    const tablesResult = await this.getTables(restaurantId, {});

    return {
      success: true,
      summary: {
        totalOrders: ordersSnapshot.size,
        completedOrders,
        pendingOrders,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        popularItems,
        tables: tablesResult.summary
      }
    };
  }

  async getSalesSummary(restaurantId, args) {
    let startDate, endDate;

    if (args.date) {
      startDate = new Date(args.date);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(args.date);
      endDate.setHours(23, 59, 59, 999);
    } else if (args.start_date && args.end_date) {
      startDate = new Date(args.start_date);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(args.end_date);
      endDate.setHours(23, 59, 59, 999);
    } else {
      // Default to today
      startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date();
      endDate.setHours(23, 59, 59, 999);
    }

    const db = getDb();
    const ordersSnapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'completed')
      .where('createdAt', '>=', startDate)
      .where('createdAt', '<=', endDate)
      .get();

    let totalRevenue = 0;
    let totalTax = 0;
    let totalOrders = 0;
    const paymentMethods = {};

    ordersSnapshot.forEach(doc => {
      const data = doc.data();
      totalRevenue += data.finalTotal || data.total || 0;
      totalTax += data.tax || 0;
      totalOrders++;

      const method = data.paymentMethod || 'cash';
      paymentMethods[method] = (paymentMethods[method] || 0) + 1;
    });

    return {
      success: true,
      sales: {
        period: args.date || `${args.start_date} to ${args.end_date}` || 'today',
        totalOrders,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalTax: Math.round(totalTax * 100) / 100,
        averageOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
        paymentMethods
      }
    };
  }

  // ================== Inventory ==================

  async getInventoryAlerts(restaurantId) {
    const db = getDb();
    const snapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('inventory')
      .where('quantity', '<=', 10) // Low stock threshold
      .get();

    const lowStockItems = [];
    const expiringItems = [];
    const today = new Date();
    const nextWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    snapshot.forEach(doc => {
      const data = doc.data();
      lowStockItems.push({
        id: doc.id,
        name: data.name,
        quantity: data.quantity,
        unit: data.unit,
        reorderLevel: data.reorderLevel || 10
      });
    });

    // Check for expiring items
    const expirySnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('inventory')
      .where('expiryDate', '<=', nextWeek)
      .where('expiryDate', '>=', today)
      .get();

    expirySnapshot.forEach(doc => {
      const data = doc.data();
      expiringItems.push({
        id: doc.id,
        name: data.name,
        quantity: data.quantity,
        expiryDate: data.expiryDate?.toDate?.()?.toISOString() || data.expiryDate
      });
    });

    return {
      success: true,
      alerts: {
        lowStock: lowStockItems,
        expiringSoon: expiringItems,
        totalAlerts: lowStockItems.length + expiringItems.length
      }
    };
  }

  // ================== Customer Management ==================

  async getCustomers(restaurantId, args) {
    const db = getDb();
    let query = db.collection('restaurants')
      .doc(restaurantId)
      .collection('customers');

    const snapshot = await query.limit(args.limit || 20).get();
    const customers = [];

    snapshot.forEach(doc => {
      const data = doc.data();

      if (args.search) {
        const search = args.search.toLowerCase();
        if (!data.name?.toLowerCase().includes(search) &&
            !data.phone?.includes(search)) {
          return;
        }
      }

      customers.push({
        id: doc.id,
        name: data.name,
        phone: data.phone,
        email: data.email,
        totalOrders: data.totalOrders || 0,
        totalSpent: data.totalSpent || 0
      });
    });

    return {
      success: true,
      customers,
      count: customers.length
    };
  }

  async getCustomerById(restaurantId, args) {
    const db = getDb();
    let doc = null;

    if (args.customer_id) {
      doc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('customers')
        .doc(args.customer_id)
        .get();
    } else if (args.phone) {
      const snapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('customers')
        .where('phone', '==', args.phone)
        .limit(1)
        .get();
      if (!snapshot.empty) {
        doc = snapshot.docs[0];
      }
    }

    if (!doc || !doc.exists) {
      return { success: false, error: 'Customer not found' };
    }

    const data = doc.data();
    return {
      success: true,
      customer: {
        id: doc.id,
        name: data.name,
        phone: data.phone,
        email: data.email,
        address: data.address,
        totalOrders: data.totalOrders || 0,
        totalSpent: data.totalSpent || 0,
        lastVisit: data.lastVisit?.toDate?.()?.toISOString() || data.lastVisit
      }
    };
  }
}

module.exports = DineAIToolExecutor;
