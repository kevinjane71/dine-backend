const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');

// ============================================
// OWNER CHAIN DASHBOARD APIs
// All endpoints require owner role
// ============================================

/**
 * GET /api/owner/dashboard
 * Returns overview stats for all owner's restaurants
 */
router.get('/dashboard', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;

    console.log(`📊 Owner Dashboard: Fetching data for owner ${userId}`);

    // Get all restaurants owned by this user
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .get();

    if (restaurantsSnap.empty) {
      return res.json({
        success: true,
        restaurants: [],
        totals: {
          totalRestaurants: 0,
          totalTodayOrders: 0,
          totalTodayRevenue: 0,
          totalStaff: 0,
          totalLowStockItems: 0
        }
      });
    }

    const restaurants = [];
    const restaurantIds = [];

    restaurantsSnap.forEach(doc => {
      restaurantIds.push(doc.id);
      restaurants.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Get date range based on period parameter
    const { period = 'today', startDate, endDate } = req.query;
    const now = new Date();
    let dateStart, dateEnd;

    if (startDate && endDate) {
      // Custom date range
      dateStart = new Date(startDate);
      dateStart.setHours(0, 0, 0, 0);
      dateEnd = new Date(endDate);
      dateEnd.setHours(23, 59, 59, 999);
    } else {
      // Preset periods
      dateEnd = new Date(now);
      dateEnd.setHours(23, 59, 59, 999);

      switch (period) {
        case 'today':
          dateStart = new Date(now);
          dateStart.setHours(0, 0, 0, 0);
          break;
        case '7d':
          dateStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          dateStart.setHours(0, 0, 0, 0);
          break;
        case '30d':
          dateStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          dateStart.setHours(0, 0, 0, 0);
          break;
        case '90d':
          dateStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          dateStart.setHours(0, 0, 0, 0);
          break;
        default:
          dateStart = new Date(now);
          dateStart.setHours(0, 0, 0, 0);
      }
    }

    console.log(`📊 Dashboard date range: ${dateStart.toISOString()} to ${dateEnd.toISOString()}`);

    // Fetch orders for the date range for all restaurants
    const ordersPromises = restaurantIds.map(restaurantId =>
      db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', dateStart)
        .where('createdAt', '<=', dateEnd)
        .get()
    );

    // Fetch staff count for all restaurants
    const staffPromises = restaurantIds.map(restaurantId =>
      db.collection(collections.users)
        .where('restaurantId', '==', restaurantId)
        .where('status', '==', 'active')
        .get()
    );

    // Fetch inventory with low stock for all restaurants
    const inventoryPromises = restaurantIds.map(restaurantId =>
      db.collection(collections.inventory)
        .where('restaurantId', '==', restaurantId)
        .get()
    );

    const [ordersResults, staffResults, inventoryResults] = await Promise.all([
      Promise.all(ordersPromises),
      Promise.all(staffPromises),
      Promise.all(inventoryPromises)
    ]);

    // Process results for each restaurant
    let totalOrders = 0;
    let totalRevenue = 0;
    let totalRevenueWithTax = 0;
    let totalStaff = 0;
    let totalLowStockItems = 0;

    const restaurantData = restaurants.map((restaurant, index) => {
      // Process orders for the period — exclude cancelled/deleted/saved orders
      const nonCountedStatuses = ['cancelled', 'deleted', 'saved'];
      const orders = ordersResults[index].docs.filter(doc => !nonCountedStatuses.includes(doc.data().status));
      const periodOrders = orders.length;
      const periodRevenue = orders.reduce((sum, doc) => {
        const order = doc.data();
        return sum + (order.totalAmount || 0);
      }, 0);
      const periodRevenueWithTax = orders.reduce((sum, doc) => {
        const order = doc.data();
        return sum + (order.finalAmount || order.totalAmount || 0);
      }, 0);

      // Process staff (exclude owners and customers)
      const staffDocs = staffResults[index].docs;
      const activeStaff = staffDocs.filter(doc => {
        const role = (doc.data().role || '').toLowerCase();
        return role !== 'owner' && role !== 'customer';
      }).length;

      // Process inventory for low stock
      const inventoryDocs = inventoryResults[index].docs;
      const lowStockItems = inventoryDocs.filter(doc => {
        const item = doc.data();
        return item.currentStock <= (item.minStock || item.reorderLevel || 0);
      }).length;

      // Update totals
      totalOrders += periodOrders;
      totalRevenue += periodRevenue;
      totalRevenueWithTax += periodRevenueWithTax;
      totalStaff += activeStaff;
      totalLowStockItems += lowStockItems;

      return {
        id: restaurant.id,
        name: restaurant.name || 'Unnamed Restaurant',
        city: restaurant.city || restaurant.address || '',
        address: restaurant.address || '',
        phone: restaurant.phone || '',
        logo: restaurant.logo || null,
        // Keep old field names for backwards compatibility
        todayOrders: periodOrders,
        todayRevenue: Math.round(periodRevenue * 100) / 100,
        // Also add new generic field names
        orders: periodOrders,
        revenue: Math.round(periodRevenue * 100) / 100,
        revenueWithTax: Math.round(periodRevenueWithTax * 100) / 100,
        activeStaff,
        lowStockItems,
        status: restaurant.status || 'active'
      };
    });

    console.log(`📊 Owner Dashboard: Found ${restaurantData.length} restaurants, ${totalOrders} orders in period`);

    res.json({
      success: true,
      restaurants: restaurantData,
      totals: {
        totalRestaurants: restaurantData.length,
        // Keep old field names for backwards compatibility
        totalTodayOrders: totalOrders,
        totalTodayRevenue: Math.round(totalRevenue * 100) / 100,
        // Also add new generic field names
        totalOrders,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalRevenueWithTax: Math.round(totalRevenueWithTax * 100) / 100,
        totalStaff,
        totalLowStockItems
      },
      period: period
    });

  } catch (error) {
    console.error('Owner Dashboard error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch dashboard data',
      message: error.message
    });
  }
});

/**
 * GET /api/owner/analytics
 * Cross-restaurant analytics with date range
 * Query params: restaurantIds[], startDate, endDate, period
 */
router.get('/analytics', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { period = '7d', startDate, endDate } = req.query;
    let restaurantIds = req.query.restaurantIds || req.query['restaurantIds[]'];

    // Parse restaurantIds if it's a string
    if (typeof restaurantIds === 'string') {
      restaurantIds = [restaurantIds];
    }

    console.log(`📊 Owner Analytics: period=${period}, restaurantIds=${restaurantIds?.length || 'all'}`);

    // Get owner's restaurants if no specific ones requested
    if (!restaurantIds || restaurantIds.length === 0) {
      const restaurantsSnap = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .get();

      restaurantIds = restaurantsSnap.docs.map(doc => doc.id);
    } else {
      // Verify owner has access to requested restaurants
      const restaurantsSnap = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .get();

      const ownedIds = new Set(restaurantsSnap.docs.map(doc => doc.id));
      restaurantIds = restaurantIds.filter(id => ownedIds.has(id));
    }

    if (restaurantIds.length === 0) {
      return res.json({
        success: true,
        analytics: {
          totalRevenue: 0,
          totalOrders: 0,
          avgOrderValue: 0,
          revenueByRestaurant: [],
          revenueByDay: [],
          popularItems: [],
          busyHours: [],
          ordersByType: []
        },
        meta: {
          restaurantsIncluded: 0,
          period
        }
      });
    }

    // Calculate date range
    const now = new Date();
    let dateStart;
    let dateEnd = now;

    if (startDate && endDate) {
      dateStart = new Date(startDate);
      dateEnd = new Date(endDate);
    } else {
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
        case '90d':
          dateStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          dateStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      }
    }

    // Get restaurant details for names
    const restaurantDetailsPromises = restaurantIds.map(id =>
      db.collection(collections.restaurants).doc(id).get()
    );
    const restaurantDetails = await Promise.all(restaurantDetailsPromises);
    const restaurantMap = {};
    restaurantDetails.forEach(doc => {
      if (doc.exists) {
        restaurantMap[doc.id] = doc.data().name || 'Unnamed';
      }
    });

    // Fetch orders for all selected restaurants
    const ordersPromises = restaurantIds.map(restaurantId =>
      db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', dateStart)
        .where('createdAt', '<=', dateEnd)
        .get()
    );

    const ordersResults = await Promise.all(ordersPromises);

    // Aggregate analytics
    let totalRevenue = 0;
    let totalRevenueWithTax = 0;
    let totalOrders = 0;
    const revenueByRestaurant = [];
    const allOrders = [];

    const nonCountedStatuses = ['cancelled', 'deleted', 'saved'];

    restaurantIds.forEach((restaurantId, index) => {
      // Exclude cancelled/deleted/saved orders from analytics
      const orders = ordersResults[index].docs.filter(doc => !nonCountedStatuses.includes(doc.data().status));
      const restaurantRevenue = orders.reduce((sum, doc) => {
        const order = doc.data();
        return sum + (order.totalAmount || 0);
      }, 0);
      const restaurantRevenueWithTax = orders.reduce((sum, doc) => {
        const order = doc.data();
        return sum + (order.finalAmount || order.totalAmount || 0);
      }, 0);

      totalRevenue += restaurantRevenue;
      totalRevenueWithTax += restaurantRevenueWithTax;
      totalOrders += orders.length;

      revenueByRestaurant.push({
        restaurantId,
        name: restaurantMap[restaurantId] || 'Unknown',
        revenue: Math.round(restaurantRevenue * 100) / 100,
        revenueWithTax: Math.round(restaurantRevenueWithTax * 100) / 100,
        orders: orders.length
      });

      // Add orders to combined list
      orders.forEach(doc => {
        allOrders.push({
          ...doc.data(),
          restaurantId
        });
      });
    });

    // Calculate revenue by day
    const revenueByDay = {};
    allOrders.forEach(order => {
      const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
      const dateKey = orderDate.toISOString().split('T')[0];
      if (!revenueByDay[dateKey]) {
        revenueByDay[dateKey] = { date: dateKey, revenue: 0, orders: 0 };
      }
      revenueByDay[dateKey].revenue += (order.totalAmount || order.finalAmount || 0);
      revenueByDay[dateKey].orders += 1;
    });

    // Calculate popular items across chain
    const itemCounts = {};
    const itemRevenue = {};
    allOrders.forEach(order => {
      if (order.items && Array.isArray(order.items)) {
        order.items.forEach(item => {
          const itemName = item.name || item.itemName;
          if (itemName) {
            itemCounts[itemName] = (itemCounts[itemName] || 0) + (item.quantity || 1);
            itemRevenue[itemName] = (itemRevenue[itemName] || 0) + (item.price || 0) * (item.quantity || 1);
          }
        });
      }
    });

    const popularItems = Object.keys(itemCounts)
      .map(name => ({
        name,
        orders: itemCounts[name],
        revenue: Math.round(itemRevenue[name] * 100) / 100
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 10);

    // Calculate busy hours
    const hourCounts = {};
    allOrders.forEach(order => {
      const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
      const hour = orderDate.getHours();
      const hourStr = `${hour.toString().padStart(2, '0')}:00`;
      hourCounts[hourStr] = (hourCounts[hourStr] || 0) + 1;
    });

    const busyHours = Object.keys(hourCounts)
      .map(hour => ({ hour, orders: hourCounts[hour] }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 8);

    // Calculate orders by type
    const ordersByType = {};
    allOrders.forEach(order => {
      const type = order.orderType || 'dine_in';
      ordersByType[type] = (ordersByType[type] || 0) + 1;
    });

    const ordersByTypeArray = Object.keys(ordersByType).map(type => ({
      type,
      count: ordersByType[type],
      percentage: totalOrders > 0 ? Math.round((ordersByType[type] / totalOrders) * 100) : 0
    }));

    res.json({
      success: true,
      analytics: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalRevenueWithTax: Math.round(totalRevenueWithTax * 100) / 100,
        totalOrders,
        avgOrderValue: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
        revenueByRestaurant: revenueByRestaurant.sort((a, b) => b.revenue - a.revenue),
        revenueByDay: Object.values(revenueByDay).sort((a, b) => a.date.localeCompare(b.date)),
        popularItems,
        busyHours,
        ordersByType: ordersByTypeArray
      },
      meta: {
        restaurantsIncluded: restaurantIds.length,
        period,
        dateRange: {
          start: dateStart.toISOString(),
          end: dateEnd.toISOString()
        }
      }
    });

  } catch (error) {
    console.error('Owner Analytics error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics',
      message: error.message
    });
  }
});

/**
 * GET /api/owner/staff
 * Get all staff across all owner's restaurants with server-side pagination
 * Query params: restaurantIds[], role, status, search, page, limit
 *
 * SCALABILITY NOTES:
 * - Filters (role, status) are applied at database level where possible
 * - Search requires in-memory filtering (Firestore doesn't support text search)
 * - For very large datasets (10k+ staff), consider implementing Algolia/Elasticsearch
 */
router.get('/staff', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { role, status, search, page = 1, limit = 50 } = req.query; // Default 50 for scalability
    let restaurantIds = req.query.restaurantIds || req.query['restaurantIds[]'];

    // Parse restaurantIds
    if (typeof restaurantIds === 'string') {
      restaurantIds = [restaurantIds];
    }

    // Get owner's restaurants
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .get();

    const ownedRestaurants = {};
    restaurantsSnap.docs.forEach(doc => {
      ownedRestaurants[doc.id] = doc.data().name || 'Unnamed';
    });

    const ownedIds = Object.keys(ownedRestaurants);

    // Filter to requested restaurants if specified
    if (restaurantIds && restaurantIds.length > 0) {
      restaurantIds = restaurantIds.filter(id => ownedIds.includes(id));
    } else {
      restaurantIds = ownedIds;
    }

    if (restaurantIds.length === 0) {
      return res.json({
        success: true,
        staff: [],
        pagination: { page: 1, limit: parseInt(limit), total: 0, totalPages: 0 }
      });
    }

    // Fetch staff for all restaurants
    // Note: Firestore 'in' query limited to 10 values, so we need to batch
    const batchSize = 10;
    const staffPromises = [];

    for (let i = 0; i < restaurantIds.length; i += batchSize) {
      const batch = restaurantIds.slice(i, i + batchSize);
      let query = db.collection(collections.users)
        .where('restaurantId', 'in', batch);

      if (status) {
        query = query.where('status', '==', status);
      }

      staffPromises.push(query.get());
    }

    const staffResults = await Promise.all(staffPromises);

    // Combine and filter results
    let allStaff = [];
    staffResults.forEach(snapshot => {
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        const staffRole = (data.role || '').toLowerCase();

        // Skip owners and customers
        if (staffRole === 'owner' || staffRole === 'customer') return;

        // Apply role filter
        if (role && staffRole !== role.toLowerCase()) return;

        // Apply search filter
        if (search) {
          const searchLower = search.toLowerCase();
          const nameMatch = (data.name || '').toLowerCase().includes(searchLower);
          const phoneMatch = (data.phone || '').includes(search);
          const emailMatch = (data.email || '').toLowerCase().includes(searchLower);
          if (!nameMatch && !phoneMatch && !emailMatch) return;
        }

        allStaff.push({
          id: doc.id,
          name: data.name || '',
          phone: data.phone || '',
          email: data.email || '',
          role: data.role || 'staff',
          status: data.status || 'active',
          restaurantId: data.restaurantId,
          restaurantName: ownedRestaurants[data.restaurantId] || 'Unknown',
          loginId: data.loginId || '',
          username: data.username || '',
          lastLogin: data.lastLogin || null,
          createdAt: data.createdAt || null,
          pageAccess: data.pageAccess || {}
        });
      });
    });

    // Sort by name
    allStaff.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Pagination
    const total = allStaff.length;
    const totalPages = Math.ceil(total / parseInt(limit));
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginatedStaff = allStaff.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      success: true,
      staff: paginatedStaff,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages
      }
    });

  } catch (error) {
    console.error('Owner Staff error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch staff',
      message: error.message
    });
  }
});

/**
 * GET /api/owner/menu-items
 * Get menu items across all owner's restaurants with server-side pagination
 * Query params: restaurantIds[], category, search, page, limit
 *
 * SCALABILITY NOTES:
 * - Menu items are stored inside restaurant documents (Firestore design)
 * - Filtering is done in memory after fetching restaurant docs
 * - For very large menus (1000+ items per restaurant), consider separate collection
 */
router.get('/menu-items', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { category, search, page = 1, limit = 100 } = req.query; // Default 100 for menu items
    let restaurantIds = req.query.restaurantIds || req.query['restaurantIds[]'];

    // Parse restaurantIds
    if (typeof restaurantIds === 'string') {
      restaurantIds = [restaurantIds];
    }

    // Get owner's restaurants with their menu data
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .get();

    const ownedRestaurants = {};
    restaurantsSnap.docs.forEach(doc => {
      ownedRestaurants[doc.id] = {
        name: doc.data().name || 'Unnamed',
        menu: doc.data().menu || { items: [], categories: [] }
      };
    });

    const ownedIds = Object.keys(ownedRestaurants);

    // Filter to requested restaurants
    if (restaurantIds && restaurantIds.length > 0) {
      restaurantIds = restaurantIds.filter(id => ownedIds.includes(id));
    } else {
      restaurantIds = ownedIds;
    }

    // Collect all menu items
    let allMenuItems = [];
    const allCategories = new Set();

    restaurantIds.forEach(restaurantId => {
      const restaurant = ownedRestaurants[restaurantId];
      const menuItems = restaurant.menu?.items || [];

      menuItems.forEach(item => {
        // Add categories
        if (item.category) allCategories.add(item.category);

        // Apply filters
        if (category && item.category?.toLowerCase() !== category.toLowerCase()) return;

        if (search) {
          const searchLower = search.toLowerCase();
          const nameMatch = (item.name || '').toLowerCase().includes(searchLower);
          const descMatch = (item.description || '').toLowerCase().includes(searchLower);
          if (!nameMatch && !descMatch) return;
        }

        allMenuItems.push({
          id: item.id,
          name: item.name || '',
          description: item.description || '',
          price: item.price || 0,
          category: item.category || 'Uncategorized',
          isAvailable: item.status === 'active' || item.isAvailable !== false,
          image: item.images?.[0] || item.image || null,
          restaurantId,
          restaurantName: restaurant.name
        });
      });
    });

    // Sort by name
    allMenuItems.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    // Pagination
    const total = allMenuItems.length;
    const totalPages = Math.ceil(total / parseInt(limit));
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginatedItems = allMenuItems.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      success: true,
      menuItems: paginatedItems,
      categories: Array.from(allCategories).sort(),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages
      }
    });

  } catch (error) {
    console.error('Owner Menu Items error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch menu items',
      message: error.message
    });
  }
});

/**
 * GET /api/owner/inventory
 * Get inventory across all owner's restaurants with server-side pagination
 * Query params: restaurantIds[], stockStatus, category, search, page, limit
 *
 * SCALABILITY NOTES:
 * - Filters are applied at database level where possible
 * - Search requires in-memory filtering (Firestore doesn't support text search)
 * - Inventory is sorted by stock status (critical items first) then name
 */
router.get('/inventory', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { stockStatus, category, search, page = 1, limit = 50 } = req.query; // Default 50 for pagination
    let restaurantIds = req.query.restaurantIds || req.query['restaurantIds[]'];

    // Parse restaurantIds
    if (typeof restaurantIds === 'string') {
      restaurantIds = [restaurantIds];
    }

    // Get owner's restaurants
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .get();

    const ownedRestaurants = {};
    restaurantsSnap.docs.forEach(doc => {
      ownedRestaurants[doc.id] = doc.data().name || 'Unnamed';
    });

    const ownedIds = Object.keys(ownedRestaurants);

    // Filter to requested restaurants
    if (restaurantIds && restaurantIds.length > 0) {
      restaurantIds = restaurantIds.filter(id => ownedIds.includes(id));
    } else {
      restaurantIds = ownedIds;
    }

    if (restaurantIds.length === 0) {
      return res.json({
        success: true,
        inventory: [],
        alerts: { lowStock: 0, outOfStock: 0 },
        categories: []
      });
    }

    // Fetch inventory for all restaurants
    const batchSize = 10;
    const inventoryPromises = [];

    for (let i = 0; i < restaurantIds.length; i += batchSize) {
      const batch = restaurantIds.slice(i, i + batchSize);
      inventoryPromises.push(
        db.collection(collections.inventory)
          .where('restaurantId', 'in', batch)
          .get()
      );
    }

    const inventoryResults = await Promise.all(inventoryPromises);

    // Combine and filter results
    let allInventory = [];
    const allCategories = new Set();
    let lowStockCount = 0;
    let outOfStockCount = 0;

    inventoryResults.forEach(snapshot => {
      snapshot.docs.forEach(doc => {
        const data = doc.data();

        // Add category
        if (data.category) allCategories.add(data.category);

        // Calculate stock status
        const currentStock = data.currentStock || 0;
        const minStock = data.minStock || data.reorderLevel || 0;
        let itemStockStatus = 'normal';

        if (currentStock <= 0) {
          itemStockStatus = 'out';
          outOfStockCount++;
        } else if (currentStock <= minStock) {
          itemStockStatus = 'low';
          lowStockCount++;
        }

        // Apply filters
        if (stockStatus && itemStockStatus !== stockStatus) return;
        if (category && data.category?.toLowerCase() !== category.toLowerCase()) return;

        if (search) {
          const searchLower = search.toLowerCase();
          if (!(data.name || '').toLowerCase().includes(searchLower)) return;
        }

        allInventory.push({
          id: doc.id,
          name: data.name || '',
          category: data.category || 'Uncategorized',
          currentStock: currentStock,
          minStock: minStock,
          unit: data.unit || 'units',
          costPerUnit: data.costPerUnit || 0,
          stockStatus: itemStockStatus,
          restaurantId: data.restaurantId,
          restaurantName: ownedRestaurants[data.restaurantId] || 'Unknown',
          lastUpdated: data.updatedAt || data.createdAt || null
        });
      });
    });

    // Sort by stock status (critical first) then name
    const statusOrder = { out: 0, low: 1, normal: 2 };
    allInventory.sort((a, b) => {
      const statusDiff = statusOrder[a.stockStatus] - statusOrder[b.stockStatus];
      if (statusDiff !== 0) return statusDiff;
      return (a.name || '').localeCompare(b.name || '');
    });

    // Pagination
    const total = allInventory.length;
    const totalPages = Math.ceil(total / parseInt(limit));
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginatedInventory = allInventory.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      success: true,
      inventory: paginatedInventory,
      alerts: {
        lowStock: lowStockCount,
        outOfStock: outOfStockCount
      },
      categories: Array.from(allCategories).sort(),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages
      }
    });

  } catch (error) {
    console.error('Owner Inventory error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch inventory',
      message: error.message
    });
  }
});

/**
 * PATCH /api/owner/staff/:staffId/status
 * Update staff status (active/inactive) across chain
 */
router.patch('/staff/:staffId/status', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = req.user.userId || req.user.id;
    const { staffId } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be active or inactive.' });
    }

    // Get staff member
    const staffDoc = await db.collection(collections.users).doc(staffId).get();

    if (!staffDoc.exists) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const staffData = staffDoc.data();

    // Verify owner owns the restaurant this staff belongs to
    const restaurantDoc = await db.collection(collections.restaurants)
      .doc(staffData.restaurantId)
      .get();

    if (!restaurantDoc.exists || restaurantDoc.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied. You do not own this restaurant.' });
    }

    // Update status
    await db.collection(collections.users).doc(staffId).update({
      status,
      updatedAt: new Date()
    });

    res.json({
      success: true,
      message: `Staff member ${status === 'active' ? 'activated' : 'deactivated'} successfully`
    });

  } catch (error) {
    console.error('Update staff status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update staff status',
      message: error.message
    });
  }
});

module.exports = router;
