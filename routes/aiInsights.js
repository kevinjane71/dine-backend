const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const emailService = require('../emailService');
const { parseTZ, parseDayStart, todayInTZ, dateStrInTZ, dateBoundsInTZ } = require('../utils/timezone');

// ============================================
// AI INSIGHTS & DAILY REPORTS
// Provides AI-powered analytics and automated emails
// ============================================

/**
 * Convert a local time + timezone to UTC hour for cron matching.
 * E.g. "08:00" in "Asia/Kolkata" → 2 (08:00 IST = 02:30 UTC → hour 2)
 */
function convertToUTCHour(timeStr, tz) {
  try {
    const [hours, minutes = 0] = timeStr.split(':').map(Number);
    // Create a date string as if in the target timezone, then read UTC hour
    // Use June 15 to avoid DST edge cases
    const dateStr = `2024-06-15T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;
    // Intl to find the UTC offset for this timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    // Find offset by: create a UTC date, format in tz, compare
    // Use a noon reference to avoid day-boundary confusion
    const ref = new Date('2024-06-15T12:00:00Z');
    const parts = formatter.formatToParts(ref);
    const lH = parseInt(parts.find(p => p.type === 'hour')?.value || '12');
    const lM = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    const lD = parseInt(parts.find(p => p.type === 'day')?.value || '15');
    // UTC is 12:00 on June 15. Local might be different day.
    const dayDiff = lD - 15; // -1, 0, or +1
    const offsetMinutes = (dayDiff * 24 * 60) + (lH * 60 + lM) - (12 * 60);
    // Convert desired local time to UTC
    const desiredLocalMinutes = hours * 60 + minutes;
    const utcMinutes = ((desiredLocalMinutes - offsetMinutes) % 1440 + 1440) % 1440;
    return Math.floor(utcMinutes / 60);
  } catch {
    return 2; // Default: 08:00 IST = 02:30 UTC → hour 2
  }
}

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

  const { restaurants, orders, analytics, period, currencySymbol: cs = '₹' } = data;
  const totalRestaurants = restaurants?.length || 0;
  const totalRevenue = analytics?.totalRevenue || 0;
  const totalOrders = analytics?.totalOrders || 0;
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

  // ==================== SUMMARY ====================
  const periodLabel = period === 'today' || period === '1d' ? 'today' :
                     period === '7d' ? 'this week' :
                     period === '30d' ? 'this month' : 'this period';

  if (totalRevenue > 0) {
    insights.summary = totalRestaurants > 1
      ? `Your ${totalRestaurants} restaurants generated ${cs}${totalRevenue.toLocaleString()} in revenue from ${totalOrders} orders ${periodLabel}. Average order value is ${cs}${avgOrderValue.toFixed(0)}.`
      : `You generated ${cs}${totalRevenue.toLocaleString()} in revenue from ${totalOrders} orders ${periodLabel}. Average order value is ${cs}${avgOrderValue.toFixed(0)}.`;
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
        message: `${topPerformer.name} is leading with ${cs}${topRevenue.toLocaleString()} in revenue`,
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
        message: `Your average order is ${cs}${avgOrderValue.toFixed(0)}. Consider upselling combos or premium items to increase this.`,
        action: 'Create combo deals or suggest add-ons at checkout'
      });
    } else if (avgOrderValue > 500) {
      insights.pricingInsights.push({
        icon: '✨',
        title: 'Strong Average Order Value',
        message: `Excellent! Your average order of ${cs}${avgOrderValue.toFixed(0)} indicates good upselling or premium positioning.`,
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

    // Calculate date range (timezone-aware)
    const now = new Date();
    const tzOffset = parseTZ(req);
    let dateStart;
    switch (period) {
      case 'today':
        dateStart = tzOffset !== undefined ? todayInTZ(tzOffset, parseDayStart(req)).start : (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d; })();
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

    // Fetch orders for analytics (select only fields needed for aggregation)
    const ordersPromises = restaurantIds.map(id =>
      db.collection(collections.orders)
        .where('restaurantId', '==', id)
        .where('createdAt', '>=', dateStart)
        .select('createdAt', 'totalAmount', 'finalAmount', 'status', 'items', 'orderType', 'paymentMethod')
        .limit(5000)
        .get()
    );

    // Fetch staff count (only need count by role)
    const staffPromises = restaurantIds.map(id =>
      db.collection(collections.users)
        .where('restaurantId', '==', id)
        .where('status', '==', 'active')
        .select('role')
        .limit(1000)
        .get()
    );

    // Fetch inventory (only need stock levels)
    const inventoryPromises = restaurantIds.map(id =>
      db.collection(collections.inventory)
        .where('restaurantId', '==', id)
        .select('name', 'currentStock', 'minStock', 'reorderLevel', 'unit', 'category')
        .limit(2000)
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
            const baseName = item.name || item.itemName;
            if (baseName) {
              const name = item.selectedVariant?.name ? `${baseName} (${item.selectedVariant.name})` : baseName;
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

    // Resolve currency symbol from restaurant settings
    const filteredRestaurants = restaurants.filter(r => restaurantIds.includes(r.id));
    const csVotes = {};
    filteredRestaurants.forEach(r => {
      const sym = r.currencySettings?.currencySymbol || r.currencySymbol || '₹';
      csVotes[sym] = (csVotes[sym] || 0) + 1;
    });
    const resolvedCurrency = Object.entries(csVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || '₹';

    // Generate AI insights
    const insights = generateAIInsights({
      restaurants: filteredRestaurants,
      orders: allOrders,
      analytics,
      period,
      staffCount,
      lowStockCount,
      outOfStockCount,
      currencySymbol: resolvedCurrency
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
    const { emailEnabled, email, reportEmails, timezone = 'Asia/Kolkata', reportTime = '08:00', reportFrequency = 'daily' } = req.body;

    // Normalize: support both old single email and new array (max 5)
    const emails = (reportEmails && reportEmails.length > 0)
      ? reportEmails.slice(0, 5)
      : (email ? [email] : []);

    // Pre-compute UTC hour for cron job matching
    const reportTimeUTC = convertToUTCHour(reportTime, timezone);

    // Validate frequency
    const validFrequencies = ['daily', 'weekly', 'both'];
    const freq = validFrequencies.includes(reportFrequency) ? reportFrequency : 'daily';

    await db.collection('ownerPreferences').doc(userId).set({
      emailEnabled: !!emailEnabled,
      reportEmails: emails,
      reportEmail: emails[0] || req.user.email || '', // Legacy compat
      timezone,
      reportTime,
      reportTimeUTC,
      reportFrequency: freq,
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
          reportEmails: req.user.email ? [req.user.email] : [],
          reportEmail: req.user.email || '',
          timezone: 'Asia/Kolkata',
          reportTime: '08:00',
          reportFrequency: 'daily'
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
 * Generate a full AI insights report for an owner (reusable by test + cron)
 * Returns { insights, analytics, restaurantCount } or null if no restaurants
 */
/**
 * Convert IANA timezone string to tzOffset (minutes from UTC, same as getTimezoneOffset).
 * E.g. "Asia/Kolkata" → -330, "America/New_York" → 300 (EST) or 240 (EDT)
 */
function ianaToTzOffset(tz) {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(now);
    const lY = parseInt(parts.find(p => p.type === 'year')?.value);
    const lM = parseInt(parts.find(p => p.type === 'month')?.value) - 1;
    const lD = parseInt(parts.find(p => p.type === 'day')?.value);
    const lH = parseInt(parts.find(p => p.type === 'hour')?.value);
    const lMin = parseInt(parts.find(p => p.type === 'minute')?.value);
    const lS = parseInt(parts.find(p => p.type === 'second')?.value);
    const localAsUTC = Date.UTC(lY, lM, lD, lH === 24 ? 0 : lH, lMin, lS);
    const utcMs = now.getTime();
    // tzOffset = UTC - local (in minutes), same as JS getTimezoneOffset()
    return Math.round((utcMs - localAsUTC) / 60000);
  } catch (_) {
    return -330; // fallback to IST
  }
}

async function generateReportForOwner(userId, timezone, frequency = 'daily') {
  // --- Find ALL restaurants for this owner ---
  // 1. Direct ownership via ownerId
  const restaurantsSnap = await db.collection(collections.restaurants)
    .where('ownerId', '==', userId)
    .get();

  const restaurantMap = new Map();
  restaurantsSnap.docs.forEach(doc => {
    restaurantMap.set(doc.id, { id: doc.id, ...doc.data() });
  });

  // 2. Also check userRestaurants collection for additional access
  try {
    const urSnap = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .get();
    const extraIds = urSnap.docs
      .map(d => d.data().restaurantId)
      .filter(rid => rid && !restaurantMap.has(rid));
    if (extraIds.length > 0) {
      const extraDocs = await Promise.all(
        extraIds.map(rid => db.collection(collections.restaurants).doc(rid).get())
      );
      extraDocs.forEach(doc => {
        if (doc.exists) restaurantMap.set(doc.id, { id: doc.id, ...doc.data() });
      });
    }
  } catch (_) {}

  // 3. Check if any found restaurant has an organizationId — if so, include all org restaurants
  const orgIds = new Set();
  for (const r of restaurantMap.values()) {
    if (r.organizationId) orgIds.add(r.organizationId);
  }
  for (const orgId of orgIds) {
    try {
      const orgSnap = await db.collection(collections.restaurants)
        .where('organizationId', '==', orgId)
        .get();
      orgSnap.docs.forEach(doc => {
        if (!restaurantMap.has(doc.id)) {
          restaurantMap.set(doc.id, { id: doc.id, ...doc.data() });
        }
      });
    } catch (_) {}
  }

  if (restaurantMap.size === 0) return null;

  const restaurants = Array.from(restaurantMap.values());
  const restaurantIds = restaurants.map(r => r.id);

  // --- Resolve timezone and business day start from settings ---
  // timezone param comes from ownerPreferences (IANA string) or fallback
  let ownerTz = timezone;
  if (!ownerTz) {
    try {
      const prefDoc = await db.collection('ownerPreferences').doc(userId).get();
      if (prefDoc.exists) ownerTz = prefDoc.data().timezone;
    } catch (_) {}
  }
  const tzOffset = ownerTz ? ianaToTzOffset(ownerTz) : -330; // fallback IST
  const dayStartHour = restaurants[0]?.posSettings?.businessDayStartHour || 0;

  // --- Analytics period (timezone-aware) ---
  const today = todayInTZ(tzOffset, dayStartHour);
  let analyticsStart;
  if (frequency === 'weekly') {
    const sevenDaysAgoStr = dateStrInTZ(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), tzOffset, dayStartHour
    );
    analyticsStart = dateBoundsInTZ(sevenDaysAgoStr, tzOffset, dayStartHour).start;
  } else {
    // daily — use today's start only
    analyticsStart = today.start;
  }

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

  await Promise.all(restaurantIds.map(async (restaurantId) => {
    const [ordersSnap, staffNewSnap, staffLegacySnap, invSnap] = await Promise.all([
      db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', analyticsStart)
        .get(),
      db.collection(collections.staffUsers)
        .where('restaurantId', '==', restaurantId)
        .where('status', '==', 'active')
        .select('role')
        .get(),
      db.collection(collections.users)
        .where('restaurantId', '==', restaurantId)
        .where('status', '==', 'active')
        .select('role')
        .get(),
      db.collection(collections.inventory)
        .where('restaurantId', '==', restaurantId)
        .select('currentStock', 'minStock', 'reorderLevel')
        .get()
    ]);

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

      const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
      const dateKey = orderDate.toISOString().split('T')[0];
      if (!revenueByDay[dateKey]) revenueByDay[dateKey] = { date: dateKey, revenue: 0, orders: 0 };
      revenueByDay[dateKey].revenue += amount;
      revenueByDay[dateKey].orders++;

      if (order.items) {
        order.items.forEach(item => {
          const baseName = item.name || item.itemName;
          if (baseName) {
            const name = item.selectedVariant?.name ? `${baseName} (${item.selectedVariant.name})` : baseName;
            itemCounts[name] = (itemCounts[name] || 0) + (item.quantity || 1);
            itemRevenue[name] = (itemRevenue[name] || 0) + (item.price || 0) * (item.quantity || 1);
          }
        });
      }

      const type = order.orderType || 'dine_in';
      ordersByType[type] = (ordersByType[type] || 0) + 1;

      const hour = orderDate.getHours();
      const hourStr = `${hour.toString().padStart(2, '0')}:00`;
      hourCounts[hourStr] = (hourCounts[hourStr] || 0) + 1;
    });

    if (restaurant) {
      restaurant.revenue = restaurantRevenue;
      restaurant.orders = restaurantOrders;
    }

    staffNewSnap.docs.forEach(() => staffCount++);
    staffLegacySnap.docs.forEach(doc => {
      const role = (doc.data().role || '').toLowerCase();
      if (role !== 'owner' && role !== 'customer') staffCount++;
    });

    invSnap.docs.forEach(doc => {
      const data = doc.data();
      const currentStock = data.currentStock || 0;
      const minStock = data.minStock || data.reorderLevel || 0;
      if (currentStock <= 0) outOfStockCount++;
      else if (currentStock <= minStock) lowStockCount++;
    });
  }));

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

  // Currency: prefer most recently configured currencySettings, else vote
  let currencySymbol = '₹';
  const withSettings = restaurants.filter(r => r.currencySettings?.currencySymbol);
  if (withSettings.length > 0) {
    // Pick the most recently updated currencySettings
    const sorted = [...withSettings].sort((a, b) => {
      const aTime = a.currencySettings?.updatedAt?.toDate?.() || a.currencySettings?.updatedAt || 0;
      const bTime = b.currencySettings?.updatedAt?.toDate?.() || b.currencySettings?.updatedAt || 0;
      return (bTime > aTime ? 1 : bTime < aTime ? -1 : 0);
    });
    currencySymbol = sorted[0].currencySettings.currencySymbol;
  } else {
    // Fallback: vote from old currencySymbol field
    const currencyVotes = {};
    restaurants.forEach(r => {
      const sym = r.currencySymbol || '₹';
      currencyVotes[sym] = (currencyVotes[sym] || 0) + 1;
    });
    currencySymbol = Object.entries(currencyVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || '₹';
  }

  const insights = generateAIInsights({
    restaurants,
    orders: allOrders,
    analytics,
    period: frequency === 'weekly' ? '7d' : '1d',
    staffCount,
    lowStockCount,
    outOfStockCount,
    currencySymbol
  });

  // --- Today's detailed EOD-style report across ALL restaurants (timezone-aware) ---
  const startOfDay = today.start;
  const endOfDay = today.end;

  let todayRevenue = 0, todayOrderCount = 0, todayCashCollected = 0;
  const paymentBreakdown = {}; // dynamic: collects all payment methods from orders
  let totalTax = 0, totalDiscount = 0;
  let cancelledCount = 0, refundedCount = 0, refundedAmount = 0;
  const taxBreakdown = {}; // dynamic: collects all tax names from orders
  const categoryWise = {};
  const todayItemCounts = {};
  const staffWise = {};

  for (const restaurantId of restaurantIds) {
    const todayOrdersSnap = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', startOfDay)
      .where('createdAt', '<=', endOfDay)
      .get();

    todayOrdersSnap.forEach(doc => {
      const order = doc.data();

      if (order.status === 'cancelled' || order.status === 'deleted') {
        cancelledCount++;
        return;
      }
      if (order.status === 'refunded') {
        refundedCount++;
        refundedAmount += order.finalAmount || order.totalAmount || 0;
        return;
      }

      const amount = order.finalAmount || order.totalAmount || 0;
      todayRevenue += amount;
      todayOrderCount++;

      // Payment method breakdown — dynamic, tracks all methods
      const method = (order.paymentMethod || 'cash').toLowerCase();
      paymentBreakdown[method] = (paymentBreakdown[method] || 0) + amount;
      if (method === 'cash') {
        todayCashCollected += amount;
      } else if (method === 'split' && order.splitPayments) {
        order.splitPayments.forEach(sp => {
          const spMethod = (sp.method || 'cash').toLowerCase();
          if (spMethod === 'cash') todayCashCollected += sp.amount || 0;
        });
      }

      // Staff-wise tracking — dynamic payment methods per staff
      const staffId = order.staffInfo?.userId || order.staffInfo?.waiterId || order.waiterId || 'unknown';
      const staffName = order.staffInfo?.waiterName || order.staffInfo?.name || order.waiterName || 'Owner';
      const staffRole = order.staffInfo?.role || '';
      if (!staffWise[staffId]) {
        staffWise[staffId] = { staffName, role: staffRole, orderCount: 0, totalSales: 0, payments: {} };
      }
      staffWise[staffId].orderCount += 1;
      staffWise[staffId].totalSales += amount;
      staffWise[staffId].payments[method] = (staffWise[staffId].payments[method] || 0) + amount;

      // Tax breakdown — dynamically collect all tax names
      totalTax += order.taxAmount || 0;
      if (order.taxBreakdown && Array.isArray(order.taxBreakdown)) {
        order.taxBreakdown.forEach(tax => {
          const name = (tax.name || 'Tax').toUpperCase().trim();
          if (name && tax.amount) {
            taxBreakdown[name] = (taxBreakdown[name] || 0) + (tax.amount || 0);
          }
        });
      }

      // Discount tracking
      totalDiscount += (order.discountAmount || 0) + (order.manualDiscount || 0) + (order.loyaltyDiscount || 0);

      // Item-level and category tracking
      if (order.items && Array.isArray(order.items)) {
        order.items.forEach(item => {
          const itemKey = item.name || 'Unknown';
          if (!todayItemCounts[itemKey]) {
            todayItemCounts[itemKey] = { name: itemKey, qty: 0, revenue: 0 };
          }
          todayItemCounts[itemKey].qty += item.quantity || 1;
          todayItemCounts[itemKey].revenue += (item.price || 0) * (item.quantity || 1);

          const cat = item.category || 'Uncategorized';
          if (!categoryWise[cat]) categoryWise[cat] = { name: cat, revenue: 0 };
          categoryWise[cat].revenue += (item.price || 0) * (item.quantity || 1);
        });
      }
    });
  }

  const topItems = Object.values(todayItemCounts).sort((a, b) => b.qty - a.qty).slice(0, 15);
  const categorySales = Object.values(categoryWise).sort((a, b) => b.revenue - a.revenue);

  // Shifts for today
  const allShifts = [];
  for (const restaurantId of restaurantIds) {
    const restaurant = restaurants.find(r => r.id === restaurantId);
    const storeName = restaurant?.name || restaurantId;
    try {
      const shiftsSnap = await db.collection(collections.shifts || 'shifts')
        .where('restaurantId', '==', restaurantId)
        .where('openedAt', '>=', startOfDay)
        .where('openedAt', '<=', endOfDay)
        .get();
      shiftsSnap.forEach(doc => {
        const s = doc.data();
        allShifts.push({
          storeName,
          openedBy: s.openedBy || s.staffName || '',
          openedAt: s.openedAt?.toDate ? s.openedAt.toDate().toISOString() : s.openedAt,
          closedAt: s.closedAt?.toDate ? s.closedAt.toDate().toISOString() : s.closedAt,
          status: s.status,
          totalSales: s.totalSales || 0,
          orderCount: s.orderCount || 0,
        });
      });
    } catch (_) {}
  }

  const round = v => Math.round(v * 100) / 100;
  const todayReport = {
    reportDate: today.dateStr,
    timezone: ownerTz || 'Asia/Kolkata',
    summary: {
      totalRevenue: round(todayRevenue),
      orderCount: todayOrderCount,
      avgOrderValue: todayOrderCount > 0 ? round(todayRevenue / todayOrderCount) : 0,
      cashCollected: round(todayCashCollected),
    },
    payments: Object.fromEntries(Object.entries(paymentBreakdown).map(([k, v]) => [k, round(v)])),
    tax: {
      total: round(totalTax),
      breakdown: Object.entries(taxBreakdown).map(([name, amount]) => ({
        name,
        amount: round(amount),
      })).sort((a, b) => b.amount - a.amount),
    },
    discounts: { total: round(totalDiscount) },
    returns: { count: 0, amount: 0 },
    cancelled: { count: cancelledCount },
    refunded: { count: refundedCount, amount: round(refundedAmount) },
    topItems,
    categorySales,
    shifts: allShifts,
    staffBreakdown: Object.values(staffWise).map(s => ({
      staffName: s.staffName,
      role: s.role,
      orderCount: s.orderCount,
      totalSales: round(s.totalSales),
      payments: Object.fromEntries(Object.entries(s.payments).map(([k, v]) => [k, round(v)])),
    })).sort((a, b) => b.totalSales - a.totalSales),
    currencySymbol,
  };

  return { insights, analytics, restaurantCount: restaurants.length, todayReport, currencySymbol, reportType: frequency };
}

/**
 * POST /api/ai/send-test-report
 * Send a test daily report email with AI insights (supports multiple emails)
 */
router.post('/send-test-report', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { email, emails, timezone, currencySymbol: clientCurrency, reportFrequency } = req.body;

    // Support both single email (legacy) and array
    const recipients = (emails && emails.length > 0) ? emails : (email ? [email] : []);
    if (recipients.length === 0) {
      return res.status(400).json({ success: false, error: 'Email address required' });
    }

    console.log(`🤖 Generating AI insights report for ${recipients.join(', ')}...`);

    const reportData = await generateReportForOwner(userId, timezone, reportFrequency || 'daily');
    if (!reportData) {
      return res.status(400).json({ success: false, error: 'No restaurants found for this owner' });
    }

    // Use client-provided currency (from CurrencyContext) if available, else use report's resolved currency
    const resolvedCurrency = clientCurrency || reportData.currencySymbol;

    // If currency was overridden, fix the pre-generated AI summary text
    const insights = { ...reportData.insights };
    if (resolvedCurrency && resolvedCurrency !== reportData.currencySymbol && insights.summary) {
      insights.summary = insights.summary.replace(new RegExp(reportData.currencySymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), resolvedCurrency);
    }

    const ownerName = req.user.name || req.user.displayName || 'Restaurant Owner';

    // Send to all recipients
    for (const recipientEmail of recipients) {
      await emailService.sendAIInsightsReport({
        ownerEmail: recipientEmail,
        ownerName,
        insights,
        analytics: reportData.analytics,
        restaurantCount: reportData.restaurantCount,
        todayReport: { ...reportData.todayReport, currencySymbol: resolvedCurrency },
        currencySymbol: resolvedCurrency,
        reportType: reportData.reportType || 'daily'
      });
    }

    console.log(`✅ AI Insights report sent to: ${recipients.join(', ')}`);

    res.json({
      success: true,
      message: `AI Insights report sent successfully to ${recipients.join(', ')}`
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

  // Get today's data — use IST (UTC+5:30) as default for automated reports
  // TODO: Should use store-specific timezone from restaurant settings
  const IST_OFFSET = -330; // IST getTimezoneOffset() value
  const todayBounds = todayInTZ(IST_OFFSET);
  const today = todayBounds.start;
  const tomorrow = new Date(todayBounds.end.getTime() + 1);

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

// Export router as default, plus helper for cron job
module.exports = router;
module.exports.generateReportForOwner = generateReportForOwner;
