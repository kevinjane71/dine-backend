const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const emailService = require('../emailService');

// ============================================
// AI INSIGHTS & DAILY REPORTS
// Provides AI-powered analytics and automated emails
// ============================================

/**
 * Generate AI insights based on restaurant data
 * This analyzes patterns and provides actionable recommendations
 */
const generateAIInsights = (data) => {
  const insights = {
    summary: '',
    performance: [],
    recommendations: [],
    alerts: [],
    trends: [],
    pricingInsights: [],
    staffingInsights: [],
    inventoryInsights: []
  };

  const { restaurants, orders, analytics, period } = data;
  const totalRestaurants = restaurants?.length || 0;
  const totalRevenue = analytics?.totalRevenue || 0;
  const totalOrders = analytics?.totalOrders || 0;
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  // ==================== SUMMARY ====================
  const periodLabel = period === 'today' ? 'today' :
                     period === '7d' ? 'this week' :
                     period === '30d' ? 'this month' : 'this period';

  if (totalRevenue > 0) {
    insights.summary = `Your ${totalRestaurants} restaurant${totalRestaurants > 1 ? 's' : ''} generated ₹${totalRevenue.toLocaleString()} in revenue from ${totalOrders} orders ${periodLabel}. Average order value is ₹${avgOrderValue.toFixed(0)}.`;
  } else {
    insights.summary = `No orders recorded ${periodLabel}. Consider running promotions to drive traffic.`;
  }

  // ==================== PERFORMANCE ANALYSIS ====================
  if (restaurants && restaurants.length > 1) {
    // Sort by revenue
    const sortedByRevenue = [...restaurants].sort((a, b) => (b.todayRevenue || b.revenue || 0) - (a.todayRevenue || a.revenue || 0));
    const topPerformer = sortedByRevenue[0];
    const bottomPerformer = sortedByRevenue[sortedByRevenue.length - 1];

    if (topPerformer) {
      const topRevenue = topPerformer.todayRevenue || topPerformer.revenue || 0;
      insights.performance.push({
        type: 'top_performer',
        icon: '🏆',
        title: 'Top Performer',
        message: `${topPerformer.name} is leading with ₹${topRevenue.toLocaleString()} in revenue`,
        restaurant: topPerformer.name
      });
    }

    if (bottomPerformer && restaurants.length > 1) {
      const bottomRevenue = bottomPerformer.todayRevenue || bottomPerformer.revenue || 0;
      const topRevenue = topPerformer?.todayRevenue || topPerformer?.revenue || 0;
      if (topRevenue > 0 && bottomRevenue < topRevenue * 0.3) {
        insights.performance.push({
          type: 'underperformer',
          icon: '📉',
          title: 'Needs Attention',
          message: `${bottomPerformer.name} is significantly underperforming compared to other locations`,
          restaurant: bottomPerformer.name
        });
      }
    }

    // Revenue distribution analysis
    const avgRevenue = totalRevenue / totalRestaurants;
    const aboveAvg = restaurants.filter(r => (r.todayRevenue || r.revenue || 0) > avgRevenue).length;
    insights.performance.push({
      type: 'distribution',
      icon: '📊',
      title: 'Revenue Distribution',
      message: `${aboveAvg} of ${totalRestaurants} restaurants are performing above average`
    });
  }

  // ==================== PRICING INSIGHTS ====================
  if (avgOrderValue > 0) {
    if (avgOrderValue < 200) {
      insights.pricingInsights.push({
        icon: '💰',
        title: 'Low Average Order Value',
        message: `Your average order is ₹${avgOrderValue.toFixed(0)}. Consider upselling combos or premium items to increase this.`,
        action: 'Create combo deals or suggest add-ons at checkout'
      });
    } else if (avgOrderValue > 500) {
      insights.pricingInsights.push({
        icon: '✨',
        title: 'Strong Average Order Value',
        message: `Excellent! Your average order of ₹${avgOrderValue.toFixed(0)} indicates good upselling or premium positioning.`,
        action: 'Maintain current pricing strategy'
      });
    }

    // Peak hour pricing suggestion
    if (analytics?.busyHours?.length > 0) {
      const peakHour = analytics.busyHours[0];
      insights.pricingInsights.push({
        icon: '⏰',
        title: 'Peak Hour Opportunity',
        message: `${peakHour.hour} is your busiest time with ${peakHour.orders} orders. Consider dynamic pricing or special offers during off-peak hours.`,
        action: 'Implement happy hour pricing 3-5 PM to balance traffic'
      });
    }
  }

  // ==================== RECOMMENDATIONS ====================
  // Order volume recommendations
  if (totalOrders < 10 && period === 'today') {
    insights.recommendations.push({
      priority: 'high',
      icon: '🎯',
      title: 'Boost Today\'s Orders',
      message: 'Order volume is low today. Consider pushing a flash sale or social media promotion.',
      action: 'Launch a 2-hour flash discount on popular items'
    });
  }

  // Menu optimization
  if (analytics?.popularItems?.length > 0) {
    const topItem = analytics.popularItems[0];
    insights.recommendations.push({
      priority: 'medium',
      icon: '⭐',
      title: 'Leverage Best Sellers',
      message: `"${topItem.name}" is your top seller with ${topItem.orders} orders. Feature it prominently and consider variations.`,
      action: 'Create a combo featuring this item'
    });

    if (analytics.popularItems.length >= 5) {
      const bottomItems = analytics.popularItems.slice(-2);
      insights.recommendations.push({
        priority: 'low',
        icon: '🔄',
        title: 'Menu Refresh Opportunity',
        message: 'Some menu items have very low sales. Consider updating or replacing them.',
        action: 'Review and refresh underperforming menu items'
      });
    }
  }

  // Staff optimization
  if (data.staffCount > 0) {
    const ordersPerStaff = totalOrders / data.staffCount;
    if (ordersPerStaff < 5 && period === 'today') {
      insights.staffingInsights.push({
        icon: '👥',
        title: 'Staff Efficiency',
        message: `With ${data.staffCount} active staff and ${totalOrders} orders, you have ${ordersPerStaff.toFixed(1)} orders per staff member today.`,
        action: 'Consider optimizing shift schedules based on peak hours'
      });
    }
  }

  // ==================== ALERTS ====================
  // Low stock alerts
  if (data.lowStockCount > 0) {
    insights.alerts.push({
      severity: 'warning',
      icon: '⚠️',
      title: 'Low Stock Alert',
      message: `${data.lowStockCount} inventory items are running low across your restaurants.`,
      action: 'Review and reorder inventory immediately'
    });
  }

  if (data.outOfStockCount > 0) {
    insights.alerts.push({
      severity: 'critical',
      icon: '🚨',
      title: 'Out of Stock',
      message: `${data.outOfStockCount} items are out of stock. This may be affecting sales.`,
      action: 'Urgent: Restock critical items'
    });
  }

  // ==================== TRENDS ====================
  if (analytics?.revenueByDay?.length >= 3) {
    const days = analytics.revenueByDay;
    const recent = days.slice(-3);
    const older = days.slice(0, Math.max(1, days.length - 3));

    const recentAvg = recent.reduce((sum, d) => sum + d.revenue, 0) / recent.length;
    const olderAvg = older.reduce((sum, d) => sum + d.revenue, 0) / older.length;

    if (olderAvg > 0) {
      const trend = ((recentAvg - olderAvg) / olderAvg) * 100;
      if (trend > 10) {
        insights.trends.push({
          direction: 'up',
          icon: '📈',
          title: 'Revenue Trending Up',
          message: `Revenue has increased by ${trend.toFixed(0)}% in recent days. Great momentum!`,
          value: `+${trend.toFixed(0)}%`
        });
      } else if (trend < -10) {
        insights.trends.push({
          direction: 'down',
          icon: '📉',
          title: 'Revenue Declining',
          message: `Revenue has decreased by ${Math.abs(trend).toFixed(0)}% recently. Time to investigate.`,
          value: `${trend.toFixed(0)}%`
        });
      } else {
        insights.trends.push({
          direction: 'stable',
          icon: '➡️',
          title: 'Stable Performance',
          message: 'Revenue is holding steady. Consider new initiatives to drive growth.',
          value: '~0%'
        });
      }
    }
  }

  // Order type analysis
  if (analytics?.ordersByType?.length > 0) {
    const dineIn = analytics.ordersByType.find(t => t.type === 'dine_in' || t.type === 'dine-in');
    const delivery = analytics.ordersByType.find(t => t.type === 'delivery');
    const takeaway = analytics.ordersByType.find(t => t.type === 'takeaway' || t.type === 'pickup');

    if (delivery && delivery.percentage > 50) {
      insights.trends.push({
        direction: 'info',
        icon: '🛵',
        title: 'Delivery Dominant',
        message: `${delivery.percentage}% of orders are delivery. Optimize your delivery operations and consider exclusive online deals.`,
        value: `${delivery.percentage}%`
      });
    }
  }

  return insights;
};

const AI_INSIGHTS_DAILY_LIMIT = 10;

/**
 * Check and update AI insights usage for a user
 * Returns { allowed: boolean, remaining: number }
 */
async function checkAIInsightsLimit(userId) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const usageRef = db.collection('aiInsightsUsage').doc(userId);

  const usageDoc = await usageRef.get();

  if (!usageDoc.exists) {
    // First time user - create record
    await usageRef.set({
      date: today,
      count: 1,
      updatedAt: new Date()
    });
    return { allowed: true, remaining: AI_INSIGHTS_DAILY_LIMIT - 1 };
  }

  const data = usageDoc.data();

  // Reset if it's a new day
  if (data.date !== today) {
    await usageRef.set({
      date: today,
      count: 1,
      updatedAt: new Date()
    });
    return { allowed: true, remaining: AI_INSIGHTS_DAILY_LIMIT - 1 };
  }

  // Check if limit exceeded
  if (data.count >= AI_INSIGHTS_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  // Increment count
  await usageRef.update({
    count: data.count + 1,
    updatedAt: new Date()
  });

  return { allowed: true, remaining: AI_INSIGHTS_DAILY_LIMIT - data.count - 1 };
}

/**
 * GET /api/ai/insights
 * Generate AI insights for owner's restaurants
 */
router.get('/insights', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { period = '7d' } = req.query;
    let restaurantIds = req.query.restaurantIds || req.query['restaurantIds[]'];

    // Check daily limit
    const limitCheck = await checkAIInsightsLimit(userId);
    if (!limitCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: 'Daily limit exceeded',
        message: 'You have reached the daily limit of 10 AI insights. Please try again tomorrow.',
        remaining: 0
      });
    }

    if (typeof restaurantIds === 'string') {
      restaurantIds = [restaurantIds];
    }

    console.log(`🤖 AI Insights: Generating for owner ${userId}, period=${period}`);

    // Get owner's restaurants
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .get();

    if (restaurantsSnap.empty) {
      return res.json({
        success: true,
        insights: {
          summary: 'No restaurants found. Add your first restaurant to get started!',
          performance: [],
          recommendations: [],
          alerts: [],
          trends: [],
          pricingInsights: [],
          staffingInsights: [],
          inventoryInsights: []
        }
      });
    }

    const restaurants = [];
    const ownedIds = [];
    restaurantsSnap.docs.forEach(doc => {
      ownedIds.push(doc.id);
      restaurants.push({ id: doc.id, ...doc.data() });
    });

    // Filter to selected restaurants
    if (restaurantIds && restaurantIds.length > 0) {
      restaurantIds = restaurantIds.filter(id => ownedIds.includes(id));
    } else {
      restaurantIds = ownedIds;
    }

    // Calculate date range
    const now = new Date();
    let dateStart;
    switch (period) {
      case 'today':
        dateStart = new Date(now);
        dateStart.setHours(0, 0, 0, 0);
        break;
      case '7d':
        dateStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        dateStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        dateStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    // Fetch orders for analytics
    const ordersPromises = restaurantIds.map(id =>
      db.collection(collections.orders)
        .where('restaurantId', '==', id)
        .where('createdAt', '>=', dateStart)
        .get()
    );

    // Fetch staff count
    const staffPromises = restaurantIds.map(id =>
      db.collection(collections.users)
        .where('restaurantId', '==', id)
        .where('status', '==', 'active')
        .get()
    );

    // Fetch inventory
    const inventoryPromises = restaurantIds.map(id =>
      db.collection(collections.inventory)
        .where('restaurantId', '==', id)
        .get()
    );

    const [ordersResults, staffResults, inventoryResults] = await Promise.all([
      Promise.all(ordersPromises),
      Promise.all(staffPromises),
      Promise.all(inventoryPromises)
    ]);

    // Process data
    let totalRevenue = 0;
    let totalOrders = 0;
    let staffCount = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    const allOrders = [];
    const revenueByDay = {};
    const itemCounts = {};
    const itemRevenue = {};
    const ordersByType = {};
    const hourCounts = {};

    // Process orders
    ordersResults.forEach((snapshot, idx) => {
      const restaurantId = restaurantIds[idx];
      const restaurant = restaurants.find(r => r.id === restaurantId);
      let restaurantRevenue = 0;
      let restaurantOrders = 0;

      snapshot.docs.forEach(doc => {
        const order = doc.data();
        const amount = order.totalAmount || order.finalAmount || 0;
        totalRevenue += amount;
        totalOrders++;
        restaurantRevenue += amount;
        restaurantOrders++;

        allOrders.push(order);

        // Revenue by day
        const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
        const dateKey = orderDate.toISOString().split('T')[0];
        if (!revenueByDay[dateKey]) revenueByDay[dateKey] = { date: dateKey, revenue: 0, orders: 0 };
        revenueByDay[dateKey].revenue += amount;
        revenueByDay[dateKey].orders++;

        // Items
        if (order.items) {
          order.items.forEach(item => {
            const name = item.name || item.itemName;
            if (name) {
              itemCounts[name] = (itemCounts[name] || 0) + (item.quantity || 1);
              itemRevenue[name] = (itemRevenue[name] || 0) + (item.price || 0) * (item.quantity || 1);
            }
          });
        }

        // Order type
        const type = order.orderType || 'dine_in';
        ordersByType[type] = (ordersByType[type] || 0) + 1;

        // Busy hours
        const hour = orderDate.getHours();
        const hourStr = `${hour.toString().padStart(2, '0')}:00`;
        hourCounts[hourStr] = (hourCounts[hourStr] || 0) + 1;
      });

      // Update restaurant data
      if (restaurant) {
        restaurant.revenue = restaurantRevenue;
        restaurant.orders = restaurantOrders;
      }
    });

    // Process staff
    staffResults.forEach(snapshot => {
      snapshot.docs.forEach(doc => {
        const role = (doc.data().role || '').toLowerCase();
        if (role !== 'owner' && role !== 'customer') {
          staffCount++;
        }
      });
    });

    // Process inventory
    inventoryResults.forEach(snapshot => {
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        const currentStock = data.currentStock || 0;
        const minStock = data.minStock || data.reorderLevel || 0;
        if (currentStock <= 0) outOfStockCount++;
        else if (currentStock <= minStock) lowStockCount++;
      });
    });

    // Build analytics object
    const popularItems = Object.keys(itemCounts)
      .map(name => ({ name, orders: itemCounts[name], revenue: itemRevenue[name] }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10);

    const busyHours = Object.keys(hourCounts)
      .map(hour => ({ hour, orders: hourCounts[hour] }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 5);

    const ordersByTypeArray = Object.keys(ordersByType).map(type => ({
      type,
      count: ordersByType[type],
      percentage: totalOrders > 0 ? Math.round((ordersByType[type] / totalOrders) * 100) : 0
    }));

    const analytics = {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalOrders,
      avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
      revenueByDay: Object.values(revenueByDay).sort((a, b) => a.date.localeCompare(b.date)),
      popularItems,
      busyHours,
      ordersByType: ordersByTypeArray
    };

    // Generate AI insights
    const insights = generateAIInsights({
      restaurants: restaurants.filter(r => restaurantIds.includes(r.id)),
      orders: allOrders,
      analytics,
      period,
      staffCount,
      lowStockCount,
      outOfStockCount
    });

    res.json({
      success: true,
      insights,
      analytics,
      remaining: limitCheck.remaining,
      meta: {
        period,
        restaurantsAnalyzed: restaurantIds.length,
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('AI Insights error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate insights',
      message: error.message
    });
  }
});

/**
 * GET /api/ai/usage
 * Get remaining AI insights for today (without consuming one)
 */
router.get('/usage', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const today = new Date().toISOString().split('T')[0];
    const usageRef = db.collection('aiInsightsUsage').doc(userId);
    const usageDoc = await usageRef.get();

    if (!usageDoc.exists || usageDoc.data().date !== today) {
      return res.json({
        success: true,
        remaining: AI_INSIGHTS_DAILY_LIMIT,
        limit: AI_INSIGHTS_DAILY_LIMIT,
        used: 0
      });
    }

    const data = usageDoc.data();
    res.json({
      success: true,
      remaining: Math.max(0, AI_INSIGHTS_DAILY_LIMIT - data.count),
      limit: AI_INSIGHTS_DAILY_LIMIT,
      used: data.count
    });
  } catch (error) {
    console.error('Get AI usage error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get usage',
      message: error.message
    });
  }
});

/**
 * POST /api/ai/email-preferences
 * Update owner's email report preferences
 */
router.post('/email-preferences', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { emailEnabled, email, timezone = 'Asia/Kolkata', reportTime = '08:00' } = req.body;

    // Store preferences in user document or a separate collection
    await db.collection('ownerPreferences').doc(userId).set({
      emailEnabled: !!emailEnabled,
      reportEmail: email || req.user.email,
      timezone,
      reportTime,
      updatedAt: new Date()
    }, { merge: true });

    res.json({
      success: true,
      message: 'Email preferences updated successfully'
    });

  } catch (error) {
    console.error('Email preferences error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update preferences',
      message: error.message
    });
  }
});

/**
 * GET /api/ai/email-preferences
 * Get owner's email report preferences
 */
router.get('/email-preferences', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    const prefDoc = await db.collection('ownerPreferences').doc(userId).get();

    if (!prefDoc.exists) {
      return res.json({
        success: true,
        preferences: {
          emailEnabled: false,
          reportEmail: req.user.email || '',
          timezone: 'Asia/Kolkata',
          reportTime: '08:00'
        }
      });
    }

    res.json({
      success: true,
      preferences: prefDoc.data()
    });

  } catch (error) {
    console.error('Get email preferences error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get preferences',
      message: error.message
    });
  }
});

/**
 * POST /api/ai/send-test-report
 * Send a test daily report email with AI insights
 */
router.post('/send-test-report', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, error: 'Email address required' });
    }

    console.log(`🤖 Generating AI insights report for ${email}...`);

    // Get owner's restaurants
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .get();

    if (restaurantsSnap.empty) {
      return res.status(400).json({
        success: false,
        error: 'No restaurants found for this owner'
      });
    }

    const restaurants = [];
    const restaurantIds = [];
    restaurantsSnap.docs.forEach(doc => {
      restaurantIds.push(doc.id);
      restaurants.push({ id: doc.id, ...doc.data() });
    });

    // Get orders for last 7 days
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    let totalRevenue = 0;
    let totalOrders = 0;
    let staffCount = 0;
    let lowStockCount = 0;
    let outOfStockCount = 0;
    const allOrders = [];
    const revenueByDay = {};
    const itemCounts = {};
    const itemRevenue = {};
    const ordersByType = {};
    const hourCounts = {};

    // Fetch orders
    for (const restaurantId of restaurantIds) {
      const ordersSnap = await db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', sevenDaysAgo)
        .get();

      const restaurant = restaurants.find(r => r.id === restaurantId);
      let restaurantRevenue = 0;
      let restaurantOrders = 0;

      ordersSnap.docs.forEach(doc => {
        const order = doc.data();
        const amount = order.totalAmount || order.finalAmount || 0;
        totalRevenue += amount;
        totalOrders++;
        restaurantRevenue += amount;
        restaurantOrders++;
        allOrders.push(order);

        // Revenue by day
        const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
        const dateKey = orderDate.toISOString().split('T')[0];
        if (!revenueByDay[dateKey]) revenueByDay[dateKey] = { date: dateKey, revenue: 0, orders: 0 };
        revenueByDay[dateKey].revenue += amount;
        revenueByDay[dateKey].orders++;

        // Items
        if (order.items) {
          order.items.forEach(item => {
            const name = item.name || item.itemName;
            if (name) {
              itemCounts[name] = (itemCounts[name] || 0) + (item.quantity || 1);
              itemRevenue[name] = (itemRevenue[name] || 0) + (item.price || 0) * (item.quantity || 1);
            }
          });
        }

        // Order type
        const type = order.orderType || 'dine_in';
        ordersByType[type] = (ordersByType[type] || 0) + 1;

        // Busy hours
        const hour = orderDate.getHours();
        const hourStr = `${hour.toString().padStart(2, '0')}:00`;
        hourCounts[hourStr] = (hourCounts[hourStr] || 0) + 1;
      });

      if (restaurant) {
        restaurant.revenue = restaurantRevenue;
        restaurant.orders = restaurantOrders;
      }
    }

    // Get staff count
    for (const restaurantId of restaurantIds) {
      const staffSnap = await db.collection(collections.users)
        .where('restaurantId', '==', restaurantId)
        .where('status', '==', 'active')
        .get();
      staffSnap.docs.forEach(doc => {
        const role = (doc.data().role || '').toLowerCase();
        if (role !== 'owner' && role !== 'customer') staffCount++;
      });
    }

    // Get inventory alerts
    for (const restaurantId of restaurantIds) {
      const invSnap = await db.collection(collections.inventory)
        .where('restaurantId', '==', restaurantId)
        .get();
      invSnap.docs.forEach(doc => {
        const data = doc.data();
        const currentStock = data.currentStock || 0;
        const minStock = data.minStock || data.reorderLevel || 0;
        if (currentStock <= 0) outOfStockCount++;
        else if (currentStock <= minStock) lowStockCount++;
      });
    }

    // Build analytics
    const popularItems = Object.keys(itemCounts)
      .map(name => ({ name, orders: itemCounts[name], revenue: itemRevenue[name] }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10);

    const busyHours = Object.keys(hourCounts)
      .map(hour => ({ hour, orders: hourCounts[hour] }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 5);

    const ordersByTypeArray = Object.keys(ordersByType).map(type => ({
      type,
      count: ordersByType[type],
      percentage: totalOrders > 0 ? Math.round((ordersByType[type] / totalOrders) * 100) : 0
    }));

    const analytics = {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalOrders,
      avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
      revenueByDay: Object.values(revenueByDay).sort((a, b) => a.date.localeCompare(b.date)),
      popularItems,
      busyHours,
      ordersByType: ordersByTypeArray
    };

    // Generate AI insights
    const insights = generateAIInsights({
      restaurants,
      orders: allOrders,
      analytics,
      period: '7d',
      staffCount,
      lowStockCount,
      outOfStockCount
    });

    // Get owner name from user data
    const ownerName = req.user.name || req.user.displayName || 'Restaurant Owner';

    // Send email using emailService
    const emailResult = await emailService.sendAIInsightsReport({
      ownerEmail: email,
      ownerName: ownerName,
      insights: insights,
      analytics: analytics,
      restaurantCount: restaurants.length
    });

    console.log(`✅ AI Insights report sent to: ${email}`);

    res.json({
      success: true,
      message: `AI Insights report sent successfully to ${email}`,
      emailId: emailResult.messageId
    });

  } catch (error) {
    console.error('Send test report error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test report',
      message: error.message
    });
  }
});

/**
 * Helper function to generate daily report data
 */
async function generateDailyReport(userId, period = 'today') {
  const restaurantsSnap = await db.collection(collections.restaurants)
    .where('ownerId', '==', userId)
    .get();

  if (restaurantsSnap.empty) {
    return { summary: 'No restaurants found' };
  }

  const restaurants = [];
  const restaurantIds = [];
  restaurantsSnap.docs.forEach(doc => {
    restaurantIds.push(doc.id);
    restaurants.push({ id: doc.id, ...doc.data() });
  });

  // Get today's data
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  let totalRevenue = 0;
  let totalOrders = 0;

  for (const restaurantId of restaurantIds) {
    const ordersSnap = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', today)
      .where('createdAt', '<', tomorrow)
      .get();

    ordersSnap.docs.forEach(doc => {
      const order = doc.data();
      totalRevenue += order.totalAmount || order.finalAmount || 0;
      totalOrders++;
    });
  }

  return {
    date: today.toISOString().split('T')[0],
    totalRestaurants: restaurants.length,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalOrders,
    avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
    restaurants: restaurants.map(r => ({ name: r.name, id: r.id }))
  };
}

module.exports = router;
