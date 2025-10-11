const { GraphQLError } = require('graphql');

// Security and validation utilities
const validateRestaurantAccess = async (userId, restaurantId, db) => {
  if (!userId || !restaurantId) {
    throw new GraphQLError('Authentication required', {
      extensions: { code: 'UNAUTHENTICATED' }
    });
  }

  // First check if user owns the restaurant directly
  const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
  if (restaurantDoc.exists) {
    const restaurantData = restaurantDoc.data();
    if (restaurantData.ownerId === userId) {
      return {
        userId,
        restaurantId,
        role: 'OWNER',
        permissions: ['read', 'write', 'delete', 'admin']
      };
    }
  }

  // If not owner, check user_restaurants collection
  const userRestaurantRef = await db.collection('user_restaurants')
    .where('userId', '==', userId)
    .where('restaurantId', '==', restaurantId)
    .get();

  if (userRestaurantRef.empty) {
    throw new GraphQLError('Access denied to restaurant data', {
      extensions: { code: 'FORBIDDEN' }
    });
  }

  const userRestaurantData = userRestaurantRef.docs[0].data();
  return {
    userId,
    restaurantId,
    role: userRestaurantData.role || 'STAFF',
    permissions: userRestaurantData.permissions || ['read']
  };
};

const validatePermission = (userRole, requiredPermission, operation) => {
  const rolePermissions = {
    OWNER: ['read', 'write', 'delete', 'admin'],
    MANAGER: ['read', 'write', 'admin'],
    ADMIN: ['read', 'write'],
    STAFF: ['read', 'write'],
    WAITER: ['read']
  };

  const userPermissions = rolePermissions[userRole] || [];
  
  if (!userPermissions.includes(requiredPermission)) {
    throw new GraphQLError(`Insufficient permissions for ${operation}`, {
      extensions: { code: 'FORBIDDEN' }
    });
  }
};

const sanitizeInput = (input) => {
  if (typeof input === 'string') {
    return input.replace(/[<>]/g, '');
  }
  if (Array.isArray(input)) {
    return input.map(item => sanitizeInput(item));
  }
  if (typeof input === 'object' && input !== null) {
    const sanitized = {};
    for (const [key, value] of Object.entries(input)) {
      sanitized[key] = sanitizeInput(value);
    }
    return sanitized;
  }
  return input;
};

const validateDeleteOperation = (collection, id, userId, userRole) => {
  // Extra security for delete operations
  if (userRole !== 'OWNER' && userRole !== 'MANAGER') {
    throw new GraphQLError('Only owners and managers can delete data', {
      extensions: { code: 'FORBIDDEN' }
    });
  }

  // Prevent bulk delete operations
  if (Array.isArray(id)) {
    throw new GraphQLError('Bulk delete operations are not allowed', {
      extensions: { code: 'BAD_USER_INPUT' }
    });
  }

  // Log delete operations for audit
  console.log(`DELETE OPERATION: User ${userId} (${userRole}) deleting ${collection} with ID ${id}`);
};

// GraphQL Resolvers
const resolvers = {
  Date: {
    serialize: (value) => value instanceof Date ? value.toISOString() : value,
    parseValue: (value) => new Date(value),
    parseLiteral: (ast) => new Date(ast.value)
  },

  JSON: {
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: (ast) => ast.value
  },

  Query: {
    // Restaurant Info
    restaurant: async (_, { restaurantId }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'restaurant query');

      const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
      if (!restaurantDoc.exists) {
        throw new GraphQLError('Restaurant not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      return { id: restaurantDoc.id, ...restaurantDoc.data() };
    },

    // Tables
    tables: async (_, { restaurantId, status, floor }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'tables query');

      let query = db.collection('tables').where('restaurantId', '==', restaurantId);
      
      const snapshot = await query.get();
      let tables = snapshot.docs.map(doc => {
        const data = doc.data();
        // Convert status to uppercase to match GraphQL enum
        if (data.status) {
          data.status = data.status.toUpperCase();
        }
        return { id: doc.id, ...data };
      });

      // Apply client-side filters
      if (status) {
        tables = tables.filter(table => table.status === status);
      }
      if (floor) {
        tables = tables.filter(table => table.floor === floor);
      }

      return tables;
    },

    table: async (_, { id }, { db, user }) => {
      const tableDoc = await db.collection('tables').doc(id).get();
      if (!tableDoc.exists) {
        throw new GraphQLError('Table not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const tableData = tableDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, tableData.restaurantId, db);
      validatePermission(userAccess.role, 'read', 'table query');

      return { id: tableDoc.id, ...tableData };
    },

    // Orders
    orders: async (_, { restaurantId, status, tableNumber, waiterId }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'orders query');

      let query = db.collection('orders').where('restaurantId', '==', restaurantId);
      
      const snapshot = await query.get();
      let orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Apply client-side filters
      if (status) {
        orders = orders.filter(order => order.status === status);
      }
      if (tableNumber) {
        orders = orders.filter(order => order.tableNumber === tableNumber);
      }
      if (waiterId) {
        orders = orders.filter(order => order.waiterId === waiterId);
      }

      return orders;
    },

    order: async (_, { id }, { db, user }) => {
      const orderDoc = await db.collection('orders').doc(id).get();
      if (!orderDoc.exists) {
        throw new GraphQLError('Order not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const orderData = orderDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, orderData.restaurantId, db);
      validatePermission(userAccess.role, 'read', 'order query');

      return { id: orderDoc.id, ...orderData };
    },

    orderHistory: async (_, { restaurantId, customerId, dateRange }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'order history query');

      let query = db.collection('orders').where('restaurantId', '==', restaurantId);
      
      const snapshot = await query.get();
      let orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Apply filters
      if (customerId) {
        orders = orders.filter(order => order.customer?.id === customerId);
      }
      if (dateRange) {
        const now = new Date();
        const filterDate = new Date();
        
        switch (dateRange) {
          case 'today':
            filterDate.setHours(0, 0, 0, 0);
            orders = orders.filter(order => order.createdAt >= filterDate);
            break;
          case 'this_week':
            filterDate.setDate(filterDate.getDate() - 7);
            orders = orders.filter(order => order.createdAt >= filterDate);
            break;
          case 'this_month':
            filterDate.setMonth(filterDate.getMonth() - 1);
            orders = orders.filter(order => order.createdAt >= filterDate);
            break;
        }
      }

      return orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },

    // Customers
    customers: async (_, { restaurantId, search }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'customers query');

      let query = db.collection('customers').where('restaurantId', '==', restaurantId);
      
      const snapshot = await query.get();
      let customers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      if (search) {
        const searchLower = search.toLowerCase();
        customers = customers.filter(customer => 
          customer.name?.toLowerCase().includes(searchLower) ||
          customer.phone?.includes(search) ||
          customer.email?.toLowerCase().includes(searchLower)
        );
      }

      return customers;
    },

    customer: async (_, { id }, { db, user }) => {
      const customerDoc = await db.collection('customers').doc(id).get();
      if (!customerDoc.exists) {
        throw new GraphQLError('Customer not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const customerData = customerDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, customerData.restaurantId, db);
      validatePermission(userAccess.role, 'read', 'customer query');

      return { id: customerDoc.id, ...customerData };
    },

    // Menu
    menu: async (_, { restaurantId, category, isAvailable }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'menu query');

      const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
      if (!restaurantDoc.exists) {
        throw new GraphQLError('Restaurant not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const restaurant = restaurantDoc.data();
      let menuItems = restaurant.menu?.items || [];

      // Apply filters
      if (category) {
        menuItems = menuItems.filter(item => item.category === category);
      }
      if (isAvailable !== undefined) {
        menuItems = menuItems.filter(item => item.isAvailable === isAvailable);
      }

      const categories = [...new Set(menuItems.map(item => item.category))];

      return {
        items: menuItems,
        categories
      };
    },

    // Analytics
    analytics: async (_, { restaurantId, period, dateRange }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'analytics query');

      // Get orders for the specified period
      let query = db.collection('orders').where('restaurantId', '==', restaurantId);
      const snapshot = await query.get();
      let orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Filter by period
      const now = new Date();
      const filterDate = new Date();
      
      switch (period) {
        case 'today':
          filterDate.setHours(0, 0, 0, 0);
          orders = orders.filter(order => order.createdAt >= filterDate);
          break;
        case 'this_week':
          filterDate.setDate(filterDate.getDate() - 7);
          orders = orders.filter(order => order.createdAt >= filterDate);
          break;
        case 'this_month':
          filterDate.setMonth(filterDate.getMonth() - 1);
          orders = orders.filter(order => order.createdAt >= filterDate);
          break;
      }

      // Calculate analytics
      const revenue = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
      const ordersCount = orders.length;
      const averageOrderValue = ordersCount > 0 ? revenue / ordersCount : 0;

      // Popular items
      const itemCounts = {};
      orders.forEach(order => {
        order.items?.forEach(item => {
          const key = item.name;
          if (!itemCounts[key]) {
            itemCounts[key] = { name: item.name, quantity: 0, revenue: 0, category: item.category };
          }
          itemCounts[key].quantity += item.quantity;
          itemCounts[key].revenue += item.totalPrice;
        });
      });

      const popularItems = Object.values(itemCounts)
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10);

      return {
        period,
        revenue: {
          total: revenue,
          byPaymentMethod: [],
          byHour: [],
          byDay: [],
          growth: 0
        },
        orders: {
          total: ordersCount,
          averageValue: averageOrderValue,
          byStatus: [],
          byWaiter: [],
          growth: 0
        },
        customers: {
          total: 0,
          newCustomers: 0,
          returningCustomers: 0,
          averageOrderValue: averageOrderValue,
          loyaltyPoints: { total: 0, redeemed: 0, active: 0 }
        },
        inventory: {
          lowStockItems: [],
          topMovingItems: [],
          totalValue: 0
        },
        tables: {
          occupancyRate: 0,
          averageTurnoverTime: 0,
          byFloor: []
        },
        popularItems,
        peakHours: []
      };
    },

    // System Info
    systemInfo: async () => {
      return {
        version: '1.0.0',
        uptime: process.uptime().toString(),
        database: 'Firestore',
        features: ['tables', 'orders', 'customers', 'menu', 'analytics', 'inventory']
      };
    },

    // User Permissions
    userPermissions: async (_, { userId, restaurantId }, { db, user }) => {
      if (user.userId !== userId) {
        throw new GraphQLError('Cannot access other user permissions', {
          extensions: { code: 'FORBIDDEN' }
        });
      }

      const userAccess = await validateRestaurantAccess(userId, restaurantId, db);
      
      const rolePermissions = {
        OWNER: ['read', 'write', 'delete', 'admin'],
        MANAGER: ['read', 'write', 'admin'],
        ADMIN: ['read', 'write'],
        STAFF: ['read', 'write'],
        WAITER: ['read']
      };

      const permissions = rolePermissions[userAccess.role] || [];

      return {
        userId,
        restaurantId,
        role: userAccess.role,
        permissions,
        canRead: permissions.includes('read'),
        canWrite: permissions.includes('write'),
        canDelete: permissions.includes('delete'),
        canAdmin: permissions.includes('admin')
      };
    },

    // Conversation Operations
    conversation: async (_, { userId, restaurantId }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'conversation');

      const conversationDoc = await db.collection('conversations')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (conversationDoc.empty) {
        // Create new conversation
        const newConversation = {
          userId,
          restaurantId,
          messages: [],
          context: {
            lastTableNumber: null,
            lastCustomerName: null,
            lastCustomerPhone: null,
            preferences: {}
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const docRef = await db.collection('conversations').add(newConversation);
        return { id: docRef.id, ...newConversation };
      }

      const conversationData = conversationDoc.docs[0].data();
      return { id: conversationDoc.docs[0].id, ...conversationData };
    }
  },

  Mutation: {
    // Table Operations
    createTable: async (_, { input }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, input.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'create table');

      const sanitizedInput = sanitizeInput(input);
      
      // Check for duplicate table name
      const existingTables = await db.collection('tables')
        .where('restaurantId', '==', input.restaurantId)
        .where('name', '==', sanitizedInput.name)
        .get();

      if (!existingTables.empty) {
        throw new GraphQLError(`Table "${sanitizedInput.name}" already exists`, {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      const tableData = {
        ...sanitizedInput,
        restaurantId: input.restaurantId,
        status: 'AVAILABLE',
        capacity: sanitizedInput.capacity || 4,
        section: sanitizedInput.section || 'Main',
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: user.userId
      };

      const docRef = await db.collection('tables').add(tableData);
      
      return { id: docRef.id, ...tableData };
    },

    updateTable: async (_, { id, input }, { db, user }) => {
      const tableDoc = await db.collection('tables').doc(id).get();
      if (!tableDoc.exists) {
        throw new GraphQLError('Table not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const tableData = tableDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, tableData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'update table');

      const sanitizedInput = sanitizeInput(input);
      const updateData = {
        ...sanitizedInput,
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      await db.collection('tables').doc(id).update(updateData);
      
      return { id, ...tableData, ...updateData };
    },

    updateTableStatus: async (_, { id, status }, { db, user }) => {
      const tableDoc = await db.collection('tables').doc(id).get();
      if (!tableDoc.exists) {
        throw new GraphQLError('Table not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const tableData = tableDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, tableData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'update table status');

      await db.collection('tables').doc(id).update({
        status,
        updatedAt: new Date(),
        updatedBy: user.userId
      });

      return { id, ...tableData, status, updatedAt: new Date() };
    },

    deleteTable: async (_, { id }, { db, user }) => {
      const tableDoc = await db.collection('tables').doc(id).get();
      if (!tableDoc.exists) {
        throw new GraphQLError('Table not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const tableData = tableDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, tableData.restaurantId, db);
      validatePermission(userAccess.role, 'delete', 'delete table');

      validateDeleteOperation('tables', id, user.userId, userAccess.role);

      await db.collection('tables').doc(id).delete();
      return true;
    },

    bookTable: async (_, { input }, { db, user }) => {
      const sanitizedInput = sanitizeInput(input);
      
      const tableDoc = await db.collection('tables').doc(sanitizedInput.tableId).get();
      if (!tableDoc.exists) {
        throw new GraphQLError('Table not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const tableData = tableDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, tableData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'book table');

      // Check if table is available
      if (tableData.status !== 'AVAILABLE') {
        throw new GraphQLError(`Table ${tableData.name} is not available for booking`, {
          extensions: { code: 'UNAVAILABLE' }
        });
      }

      // Create booking data
      const bookingData = {
        customerName: sanitizedInput.customerName,
        customerPhone: sanitizedInput.customerPhone,
        bookingDate: sanitizedInput.bookingDate,
        bookingTime: sanitizedInput.bookingTime,
        partySize: sanitizedInput.partySize,
        notes: sanitizedInput.notes || '',
        bookedAt: new Date(),
        bookedBy: user.userId,
        status: 'CONFIRMED'
      };

      // Update table with booking
      await db.collection('tables').doc(sanitizedInput.tableId).update({
        status: 'RESERVED',
        currentBookingId: `booking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        bookingInfo: bookingData,
        updatedAt: new Date()
      });

      return { 
        id: sanitizedInput.tableId, 
        ...tableData, 
        status: 'RESERVED',
        bookingInfo: bookingData,
        updatedAt: new Date()
      };
    },

    // Customer Operations
    createCustomer: async (_, { input }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, input.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'create customer');

      const sanitizedInput = sanitizeInput(input);
      
      if (!sanitizedInput.name && !sanitizedInput.phone) {
        throw new GraphQLError('Customer name or phone is required', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      const customerData = {
        ...sanitizedInput,
        restaurantId: input.restaurantId,
        orderHistory: [],
        totalSpent: 0,
        loyaltyPoints: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: user.userId
      };

      const docRef = await db.collection('customers').add(customerData);
      
      return { id: docRef.id, ...customerData };
    },

    updateCustomer: async (_, { id, input }, { db, user }) => {
      const customerDoc = await db.collection('customers').doc(id).get();
      if (!customerDoc.exists) {
        throw new GraphQLError('Customer not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const customerData = customerDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, customerData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'update customer');

      const sanitizedInput = sanitizeInput(input);
      const updateData = {
        ...sanitizedInput,
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      await db.collection('customers').doc(id).update(updateData);
      
      return { id, ...customerData, ...updateData };
    },

    deleteCustomer: async (_, { id }, { db, user }) => {
      const customerDoc = await db.collection('customers').doc(id).get();
      if (!customerDoc.exists) {
        throw new GraphQLError('Customer not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const customerData = customerDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, customerData.restaurantId, db);
      validatePermission(userAccess.role, 'delete', 'delete customer');

      validateDeleteOperation('customers', id, user.userId, userAccess.role);

      await db.collection('customers').doc(id).delete();
      return true;
    },

    // Order Operations
    createOrder: async (_, { input }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, input.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'create order');

      const sanitizedInput = sanitizeInput(input);
      
      if (!sanitizedInput.items || sanitizedInput.items.length === 0) {
        throw new GraphQLError('Order must have at least one item', {
          extensions: { code: 'BAD_USER_INPUT' }
        });
      }

      // Fetch menu item details for each item
      const processedItems = [];
      let subtotal = 0;

      for (const item of sanitizedInput.items) {
        // Get menu item details
        const menuItemDoc = await db.collection('restaurants').doc(input.restaurantId).get();
        if (!menuItemDoc.exists) {
          throw new GraphQLError('Restaurant not found', {
            extensions: { code: 'NOT_FOUND' }
          });
        }

        const restaurantData = menuItemDoc.data();
        let menuItem = null;

        // Search through menu items directly
        if (restaurantData.menu && restaurantData.menu.items) {
          menuItem = restaurantData.menu.items.find(menuItem => menuItem.id === item.menuItemId);
        }

        if (!menuItem) {
          throw new GraphQLError(`Menu item with ID ${item.menuItemId} not found`, {
            extensions: { code: 'NOT_FOUND' }
          });
        }

        const itemTotal = menuItem.price * item.quantity;
        subtotal += itemTotal;

        processedItems.push({
          id: menuItem.id,
          name: menuItem.name,
          price: menuItem.price,
          quantity: item.quantity,
          category: menuItem.category,
          shortCode: menuItem.shortCode,
          isVeg: menuItem.isVeg,
          total: itemTotal
        });
      }

      const taxAmount = subtotal * 0.18; // 18% GST
      const totalAmount = subtotal + taxAmount;

      // Determine initial status based on express billing
      const initialStatus = sanitizedInput.expressBilling ? 'READY' : 'PREPARING';

      const orderData = {
        ...sanitizedInput,
        items: processedItems,
        restaurantId: input.restaurantId,
        orderNumber: `ORD-${Date.now()}`,
        totalAmount: subtotal,
        taxAmount,
        discountAmount: 0,
        finalAmount: totalAmount,
        status: initialStatus,
        waiterId: user.userId,
        waiterName: user.name || 'Unknown',
        paymentMethod: sanitizedInput.paymentMethod || 'CASH',
        paymentStatus: sanitizedInput.expressBilling ? 'COMPLETED' : 'PENDING',
        expressBilling: sanitizedInput.expressBilling || false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const docRef = await db.collection('orders').add(orderData);
      
      return { id: docRef.id, ...orderData };
    },

    updateOrderStatus: async (_, { id, status }, { db, user }) => {
      const orderDoc = await db.collection('orders').doc(id).get();
      if (!orderDoc.exists) {
        throw new GraphQLError('Order not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const orderData = orderDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, orderData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'update order status');

      const updateData = {
        status,
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      if (status === 'COMPLETED') {
        updateData.completedAt = new Date();
      }

      await db.collection('orders').doc(id).update(updateData);
      
      return { id, ...orderData, ...updateData };
    },

    updateOrder: async (_, { id, input }, { db, user }) => {
      const orderDoc = await db.collection('orders').doc(id).get();
      if (!orderDoc.exists) {
        throw new GraphQLError('Order not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const orderData = orderDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, orderData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'update order');

      const sanitizedInput = sanitizeInput(input);
      
      const updateData = {
        ...sanitizedInput,
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      await db.collection('orders').doc(id).update(updateData);
      
      return { id, ...orderData, ...updateData };
    },

    updateOrderItems: async (_, { id, items }, { db, user }) => {
      const orderDoc = await db.collection('orders').doc(id).get();
      if (!orderDoc.exists) {
        throw new GraphQLError('Order not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const orderData = orderDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, orderData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'update order items');

      const sanitizedItems = items.map(item => sanitizeInput(item));
      
      const updateData = {
        items: sanitizedItems,
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      await db.collection('orders').doc(id).update(updateData);
      
      return { id, ...orderData, ...updateData };
    },

    cancelOrder: async (_, { id, reason }, { db, user }) => {
      const orderDoc = await db.collection('orders').doc(id).get();
      if (!orderDoc.exists) {
        throw new GraphQLError('Order not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const orderData = orderDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, orderData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'cancel order');

      const updateData = {
        status: 'CANCELLED',
        cancellationReason: reason || 'Cancelled by user',
        cancelledAt: new Date(),
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      await db.collection('orders').doc(id).update(updateData);
      
      return { id, ...orderData, ...updateData };
    },

    completeOrder: async (_, { id }, { db, user }) => {
      const orderDoc = await db.collection('orders').doc(id).get();
      if (!orderDoc.exists) {
        throw new GraphQLError('Order not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const orderData = orderDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, orderData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'complete order');

      const updateData = {
        status: 'COMPLETED',
        completedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      await db.collection('orders').doc(id).update(updateData);

      return { id, ...orderData, ...updateData };
    },

    processPayment: async (_, { input }, { db, user }) => {
      const sanitizedInput = sanitizeInput(input);
      
      const orderDoc = await db.collection('orders').doc(sanitizedInput.orderId).get();
      if (!orderDoc.exists) {
        throw new GraphQLError('Order not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const orderData = orderDoc.data();
      const userAccess = await validateRestaurantAccess(user.userId, orderData.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'process payment');

      const paymentData = {
        paymentMethod: sanitizedInput.paymentMethod,
        amount: sanitizedInput.amount,
        transactionId: sanitizedInput.transactionId || `txn_${Date.now()}`,
        processedAt: new Date(),
        processedBy: user.userId,
        status: 'COMPLETED',
        notes: sanitizedInput.notes || ''
      };

      const updateData = {
        paymentInfo: paymentData,
        paymentStatus: 'COMPLETED',
        status: 'COMPLETED',
        completedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      await db.collection('orders').doc(sanitizedInput.orderId).update(updateData);

      return { id: sanitizedInput.orderId, ...orderData, ...updateData };
    },

    searchOrders: async (_, { restaurantId, searchTerm }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'read', 'search orders');

      const sanitizedSearchTerm = sanitizeInput({ search: searchTerm }).search.toLowerCase();
      
      // Search in orders collection
      const ordersSnapshot = await db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .get();

      let orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Filter orders based on search term
      orders = orders.filter(order => {
        const orderNumber = order.orderNumber?.toLowerCase() || '';
        const tableNumber = order.tableNumber?.toLowerCase() || '';
        const customerName = order.customerInfo?.name?.toLowerCase() || '';
        const customerPhone = order.customerInfo?.phone?.toLowerCase() || '';
        
        return orderNumber.includes(sanitizedSearchTerm) ||
               tableNumber.includes(sanitizedSearchTerm) ||
               customerName.includes(sanitizedSearchTerm) ||
               customerPhone.includes(sanitizedSearchTerm);
      });

      return orders;
    },

    // Menu Operations
    createMenuItem: async (_, { input }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, input.restaurantId, db);
      validatePermission(userAccess.role, 'write', 'create menu item');

      const sanitizedInput = sanitizeInput(input);
      
      const menuItemData = {
        ...sanitizedInput,
        id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        restaurantId: input.restaurantId,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: user.userId
      };

      // Update restaurant menu
      const restaurantDoc = await db.collection('restaurants').doc(input.restaurantId).get();
      if (!restaurantDoc.exists) {
        throw new GraphQLError('Restaurant not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const restaurantData = restaurantDoc.data();
      const currentMenu = restaurantData.menu || { categories: [], items: [] };
      
      // Add to items array
      currentMenu.items.push(menuItemData);
      
      // Update restaurant
      await db.collection('restaurants').doc(input.restaurantId).update({
        menu: {
          ...currentMenu,
          lastUpdated: new Date()
        }
      });

      return menuItemData;
    },

    updateMenuItem: async (_, { id, input }, { db, user }) => {
      const sanitizedInput = sanitizeInput(input);
      
      // Find restaurant containing this menu item
      const restaurantsSnapshot = await db.collection('restaurants').get();
      let foundRestaurant = null;
      let foundItem = null;
      
      for (const restaurantDoc of restaurantsSnapshot.docs) {
        const restaurantData = restaurantDoc.data();
        const menuData = restaurantData.menu || { items: [] };
        
        const item = menuData.items.find(item => item.id === id);
        if (item) {
          foundRestaurant = restaurantDoc;
          foundItem = item;
          break;
        }
      }
      
      if (!foundRestaurant || !foundItem) {
        throw new GraphQLError('Menu item not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const restaurantData = foundRestaurant.data();
      const userAccess = await validateRestaurantAccess(user.userId, restaurantData.ownerId, db);
      validatePermission(userAccess.role, 'write', 'update menu item');

      const updateData = {
        ...sanitizedInput,
        updatedAt: new Date(),
        updatedBy: user.userId
      };

      // Update the menu item in the restaurant document
      const currentMenu = restaurantData.menu || { categories: [], items: [] };
      const updatedItems = currentMenu.items.map(item => {
        if (item.id === id) {
          return { ...item, ...updateData };
        }
        return item;
      });

      await db.collection('restaurants').doc(foundRestaurant.id).update({
        menu: {
          ...currentMenu,
          items: updatedItems,
          lastUpdated: new Date()
        }
      });

      return { id, ...foundItem, ...updateData };
    },

    deleteMenuItem: async (_, { id }, { db, user }) => {
      // Find restaurant containing this menu item
      const restaurantsSnapshot = await db.collection('restaurants').get();
      let foundRestaurant = null;
      let foundItem = null;
      
      for (const restaurantDoc of restaurantsSnapshot.docs) {
        const restaurantData = restaurantDoc.data();
        const menuData = restaurantData.menu || { items: [] };
        
        const item = menuData.items.find(item => item.id === id);
        if (item) {
          foundRestaurant = restaurantDoc;
          foundItem = item;
          break;
        }
      }
      
      if (!foundRestaurant || !foundItem) {
        throw new GraphQLError('Menu item not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      const restaurantData = foundRestaurant.data();
      const userAccess = await validateRestaurantAccess(user.userId, restaurantData.ownerId, db);
      validatePermission(userAccess.role, 'delete', 'delete menu item');

      validateDeleteOperation('menu_items', id, user.userId, userAccess.role);

      // Remove the menu item from the restaurant document
      const currentMenu = restaurantData.menu || { categories: [], items: [] };
      const updatedItems = currentMenu.items.filter(item => item.id !== id);

      await db.collection('restaurants').doc(foundRestaurant.id).update({
        menu: {
          ...currentMenu,
          items: updatedItems,
          lastUpdated: new Date()
        }
      });

      return true;
    },

    // System Operations
    logout: async (_, __, { user }) => {
      // Log logout action
      console.log(`User ${user.userId} logged out`);
      return true;
    },

    generateReport: async (_, { type, period }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, user.restaurantId, db);
      validatePermission(userAccess.role, 'read', 'generate report');

      const reportData = {
        type,
        period,
        generatedAt: new Date(),
        generatedBy: user.userId,
        data: {} // Report data would be generated here
      };

      const docRef = await db.collection('reports').add(reportData);
      
      return { id: docRef.id, ...reportData };
    },


    saveConversationMessage: async (_, { userId, restaurantId, role, content, metadata }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'write', 'save conversation message');

      const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const newMessage = {
        id: messageId,
        role,
        content,
        timestamp: new Date(),
        metadata: metadata || {}
      };

      // Get or create conversation
      const conversationDoc = await db.collection('conversations')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (conversationDoc.empty) {
        // Create new conversation
        const newConversation = {
          userId,
          restaurantId,
          messages: [newMessage],
          context: {
            lastTableNumber: null,
            lastCustomerName: null,
            lastCustomerPhone: null,
            preferences: {}
          },
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const docRef = await db.collection('conversations').add(newConversation);
        return { id: docRef.id, ...newConversation };
      } else {
        // Update existing conversation
        const conversationData = conversationDoc.docs[0].data();
        const updatedMessages = [...conversationData.messages, newMessage];

        await db.collection('conversations').doc(conversationDoc.docs[0].id).update({
          messages: updatedMessages,
          updatedAt: new Date()
        });

        return { id: conversationDoc.docs[0].id, ...conversationData, messages: updatedMessages };
      }
    },

    updateConversationContext: async (_, { userId, restaurantId, context }, { db, user }) => {
      const userAccess = await validateRestaurantAccess(user.userId, restaurantId, db);
      validatePermission(userAccess.role, 'write', 'update conversation context');

      const conversationDoc = await db.collection('conversations')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (conversationDoc.empty) {
        throw new GraphQLError('Conversation not found', {
          extensions: { code: 'NOT_FOUND' }
        });
      }

      // Filter out undefined values
      const cleanContext = Object.fromEntries(
        Object.entries(context).filter(([key, value]) => value !== undefined)
      );

      await db.collection('conversations').doc(conversationDoc.docs[0].id).update({
        context: cleanContext,
        updatedAt: new Date()
      });

      const conversationData = conversationDoc.docs[0].data();
      return { id: conversationDoc.docs[0].id, ...conversationData, context };
    }
  },

  // Type resolvers for complex fields
  Table: {
    currentOrder: async (parent, _, { db }) => {
      if (!parent.currentOrderId) return null;
      
      const orderDoc = await db.collection('orders').doc(parent.currentOrderId).get();
      if (!orderDoc.exists) return null;
      
      return { id: orderDoc.id, ...orderDoc.data() };
    },
    
    waiter: async (parent, _, { db }) => {
      if (!parent.waiterId) return null;
      
      const staffDoc = await db.collection('staff').doc(parent.waiterId).get();
      if (!staffDoc.exists) return null;
      
      return { id: staffDoc.id, ...staffDoc.data() };
    }
  },

  Order: {
    table: async (parent, _, { db }) => {
      if (!parent.tableNumber) return null;
      
      const tablesSnapshot = await db.collection('tables')
        .where('restaurantId', '==', parent.restaurantId)
        .where('name', '==', parent.tableNumber)
        .get();
      
      if (tablesSnapshot.empty) return null;
      
      const tableDoc = tablesSnapshot.docs[0];
      return { id: tableDoc.id, ...tableDoc.data() };
    },
    
    customer: async (parent, _, { db }) => {
      if (!parent.customer?.id) return null;
      
      const customerDoc = await db.collection('customers').doc(parent.customer.id).get();
      if (!customerDoc.exists) return null;
      
      return { id: customerDoc.id, ...customerDoc.data() };
    },
    
    waiter: async (parent, _, { db }) => {
      if (!parent.waiterId) return null;
      
      const staffDoc = await db.collection('staff').doc(parent.waiterId).get();
      if (!staffDoc.exists) return null;
      
      return { id: staffDoc.id, ...staffDoc.data() };
    }
  },

  Customer: {
    orderHistory: async (parent, _, { db }) => {
      const ordersSnapshot = await db.collection('orders')
        .where('restaurantId', '==', parent.restaurantId)
        .where('customer.id', '==', parent.id)
        .get();
      
      return ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }
  },

  InventoryItem: {
    isLowStock: (parent) => {
      return parent.currentStock <= parent.minStock;
    },
    
    supplier: async (parent, _, { db }) => {
      if (!parent.supplierId) return null;
      
      const supplierDoc = await db.collection('suppliers').doc(parent.supplierId).get();
      if (!supplierDoc.exists) return null;
      
      return { id: supplierDoc.id, ...supplierDoc.data() };
    }
  }
};

module.exports = { resolvers };
