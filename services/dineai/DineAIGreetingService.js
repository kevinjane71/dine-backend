/**
 * DineAI Greeting Service
 * Generates context-aware proactive greetings based on time, user, and restaurant state
 */

const { getDb } = require('../../firebase');

class DineAIGreetingService {
  constructor() {
    this.greetingStyles = {
      professional: {
        morning: ['Good morning', 'Good morning'],
        afternoon: ['Good afternoon', 'Good afternoon'],
        evening: ['Good evening', 'Good evening']
      },
      friendly: {
        morning: ['Morning', 'Hey, good morning'],
        afternoon: ['Hi there', 'Hey'],
        evening: ['Evening', 'Hey, good evening']
      },
      casual: {
        morning: ['Hey', 'Yo'],
        afternoon: ['Hey there', 'Hi'],
        evening: ['Hey', 'Hi there']
      }
    };
  }

  /**
   * Get time-based greeting prefix
   */
  getTimeGreeting(style = 'professional') {
    const hour = new Date().getHours();
    const greetings = this.greetingStyles[style] || this.greetingStyles.professional;

    let timeOfDay;
    if (hour >= 5 && hour < 12) {
      timeOfDay = 'morning';
    } else if (hour >= 12 && hour < 17) {
      timeOfDay = 'afternoon';
    } else {
      timeOfDay = 'evening';
    }

    const options = greetings[timeOfDay];
    return options[Math.floor(Math.random() * options.length)];
  }

  /**
   * Get restaurant state for contextual greeting
   */
  async getRestaurantState(restaurantId) {
    try {
      const db = getDb();
      const state = {
        pendingOrders: 0,
        tablesOccupied: 0,
        totalTables: 0,
        lowStockItems: 0,
        todayRevenue: 0,
        urgentTasks: []
      };

      // Get pending orders
      const pendingOrdersSnapshot = await db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['pending', 'preparing'])
        .get();
      state.pendingOrders = pendingOrdersSnapshot.size;

      // Check for orders that have been pending too long (> 15 min)
      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
      pendingOrdersSnapshot.forEach(doc => {
        const data = doc.data();
        const createdAt = data.createdAt?.toDate?.() || new Date(data.createdAt);
        if (createdAt < fifteenMinAgo && data.status === 'pending') {
          state.urgentTasks.push({
            type: 'pending_order',
            orderId: data.orderId || doc.id,
            tableNumber: data.tableNumber,
            minutesWaiting: Math.round((Date.now() - createdAt.getTime()) / 60000)
          });
        }
      });

      // Get table status
      const floorsSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .get();

      for (const floorDoc of floorsSnapshot.docs) {
        const tablesSnapshot = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .doc(floorDoc.id)
          .collection('tables')
          .get();

        state.totalTables += tablesSnapshot.size;
        tablesSnapshot.forEach(tableDoc => {
          const tableData = tableDoc.data();
          if (tableData.status === 'occupied') {
            state.tablesOccupied++;
          }
        });
      }

      // Get today's revenue
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const completedOrdersSnapshot = await db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .where('status', '==', 'completed')
        .where('createdAt', '>=', today)
        .get();

      completedOrdersSnapshot.forEach(doc => {
        const data = doc.data();
        state.todayRevenue += data.finalTotal || data.total || 0;
      });

      // Check low stock items
      const lowStockSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('inventory')
        .where('quantity', '<=', 10)
        .get();
      state.lowStockItems = lowStockSnapshot.size;

      if (state.lowStockItems > 0) {
        state.urgentTasks.push({
          type: 'low_stock',
          count: state.lowStockItems
        });
      }

      return state;
    } catch (error) {
      console.error('Error getting restaurant state:', error);
      return {
        pendingOrders: 0,
        tablesOccupied: 0,
        totalTables: 0,
        lowStockItems: 0,
        todayRevenue: 0,
        urgentTasks: []
      };
    }
  }

  /**
   * Generate contextual greeting
   */
  async generateGreeting(restaurantId, userData, options = {}) {
    const style = options.style || 'professional';
    const userName = userData.name || 'there';
    const userRole = userData.role || 'staff';

    // Get time-based greeting
    const timeGreeting = this.getTimeGreeting(style);

    // Get restaurant state
    const state = await this.getRestaurantState(restaurantId);

    // Build greeting
    let greeting = `${timeGreeting}, ${userName}!`;

    // Add context based on urgency
    if (state.urgentTasks.length > 0) {
      const urgentTask = state.urgentTasks[0];

      if (urgentTask.type === 'pending_order') {
        greeting += ` Order #${urgentTask.orderId}${urgentTask.tableNumber ? ` for table ${urgentTask.tableNumber}` : ''} has been waiting for ${urgentTask.minutesWaiting} minutes.`;
      } else if (urgentTask.type === 'low_stock') {
        greeting += ` ${urgentTask.count} items are running low on stock.`;
      }
    } else {
      // Non-urgent context based on role
      if (['owner', 'manager'].includes(userRole)) {
        if (state.todayRevenue > 0) {
          greeting += ` Today's revenue so far: ₹${Math.round(state.todayRevenue).toLocaleString()}.`;
        }
        if (state.pendingOrders > 0) {
          greeting += ` ${state.pendingOrders} orders pending.`;
        }
      } else if (userRole === 'waiter') {
        if (state.pendingOrders > 0) {
          greeting += ` ${state.pendingOrders} orders in the kitchen.`;
        }
        const availableTables = state.totalTables - state.tablesOccupied;
        if (availableTables > 0) {
          greeting += ` ${availableTables} tables available.`;
        }
      } else if (userRole === 'cashier') {
        const completedToday = state.todayRevenue > 0;
        if (completedToday) {
          greeting += ` Ready to help with billing.`;
        }
      } else {
        greeting += ` How can I help you today?`;
      }
    }

    return {
      greeting,
      hasUrgentTasks: state.urgentTasks.length > 0,
      state: {
        pendingOrders: state.pendingOrders,
        tablesOccupied: state.tablesOccupied,
        totalTables: state.totalTables,
        todayRevenue: state.todayRevenue
      }
    };
  }

  /**
   * Generate voice-optimized greeting (shorter, more natural)
   */
  async generateVoiceGreeting(restaurantId, userData, options = {}) {
    const result = await this.generateGreeting(restaurantId, userData, options);

    // For voice, we want shorter greetings
    const userName = userData.name || 'there';
    const timeGreeting = this.getTimeGreeting(options.style || 'friendly');

    let voiceGreeting = `${timeGreeting}, ${userName}!`;

    // Add only the most important context
    if (result.hasUrgentTasks) {
      voiceGreeting = result.greeting; // Keep the urgent info
    } else if (result.state.pendingOrders > 0) {
      voiceGreeting += ` ${result.state.pendingOrders} orders pending.`;
    }

    voiceGreeting += ' What can I help with?';

    return {
      ...result,
      voiceGreeting
    };
  }

  /**
   * Get follow-up suggestions based on context
   */
  async getSuggestionsForContext(restaurantId, userRole, state = null) {
    if (!state) {
      state = await this.getRestaurantState(restaurantId);
    }

    // Ensure state has required properties
    const urgentTasks = state?.urgentTasks || [];
    const pendingOrders = state?.pendingOrders || 0;

    const suggestions = [];

    // Priority suggestions based on state
    if (urgentTasks.some(t => t.type === 'pending_order')) {
      suggestions.push('Show pending orders');
    }

    if (urgentTasks.some(t => t.type === 'low_stock')) {
      suggestions.push('Show inventory alerts');
    }

    // Role-based suggestions
    if (['owner', 'manager'].includes(userRole)) {
      if (pendingOrders > 0) {
        suggestions.push(`What's the status of pending orders?`);
      }
      suggestions.push("What's today's revenue?");
      suggestions.push('Show table overview');
    }

    if (['waiter', 'employee'].includes(userRole)) {
      suggestions.push('Place an order');
      suggestions.push('Show available tables');
      suggestions.push('Check menu availability');
    }

    if (userRole === 'cashier') {
      suggestions.push('Show ready orders');
      suggestions.push('Complete a billing');
      suggestions.push("Today's collection");
    }

    // Always include some basic suggestions
    if (suggestions.length < 4) {
      suggestions.push('Help me with...');
    }

    return suggestions.slice(0, 4);
  }

  /**
   * Generate shift start greeting
   */
  async generateShiftGreeting(restaurantId, userData) {
    const userName = userData.name || 'there';
    const userRole = userData.role || 'staff';
    const timeGreeting = this.getTimeGreeting('friendly');

    const state = await this.getRestaurantState(restaurantId);

    let greeting = `${timeGreeting}, ${userName}! Welcome to your shift.`;

    // Add shift-relevant info
    if (['owner', 'manager'].includes(userRole)) {
      greeting += ` Here's the current status:`;
      greeting += ` ${state.pendingOrders} pending orders,`;
      greeting += ` ${state.tablesOccupied}/${state.totalTables} tables occupied.`;
      if (state.lowStockItems > 0) {
        greeting += ` Note: ${state.lowStockItems} inventory items are low.`;
      }
    } else if (userRole === 'waiter') {
      greeting += ` ${state.tablesOccupied} tables are currently occupied.`;
      if (state.pendingOrders > 0) {
        greeting += ` ${state.pendingOrders} orders are being prepared.`;
      }
    } else if (userRole === 'cashier') {
      greeting += ` Today's collection so far: ₹${Math.round(state.todayRevenue).toLocaleString()}.`;
    }

    return {
      greeting,
      state,
      suggestions: await this.getSuggestionsForContext(restaurantId, userRole, state)
    };
  }
}

module.exports = new DineAIGreetingService();
