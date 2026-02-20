const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db, collections } = require('../firebase');
const { authenticateSuperAdmin } = require('../middleware/superAdminAuth');

// ─── Constants ───────────────────────────────────────────────────────
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function parseLimit(str) {
  return Math.min(Math.max(parseInt(str) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

// ─── Helpers ─────────────────────────────────────────────────────────
function getTodayBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toDate(val) {
  if (!val) return null;
  if (val.toDate) return val.toDate();
  if (val._seconds) return new Date(val._seconds * 1000);
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }
  return val instanceof Date ? val : null;
}

function toISO(val) {
  const d = toDate(val);
  return d ? d.toISOString() : null;
}

// Apply cursor-based pagination to a Firestore query
function applyCursor(query, cursor) {
  if (!cursor) return query;
  const cursorDate = new Date(cursor);
  return isNaN(cursorDate.getTime()) ? query : query.startAfter(cursorDate);
}

// Fetch docs with limit+1 pattern for hasMore detection
async function paginatedGet(query, limit) {
  const snapshot = await query.limit(limit + 1).get();
  const hasMore = snapshot.size > limit;
  const docs = hasMore ? snapshot.docs.slice(0, limit) : snapshot.docs;
  return { docs, hasMore };
}

// Batch fetch documents by ID using getAll() — single round-trip
async function batchGetDocs(collectionName, ids) {
  if (!ids || ids.length === 0) return {};
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const refs = uniqueIds.map(id => db.collection(collectionName).doc(id));
  const docs = await db.getAll(...refs);
  const map = {};
  docs.forEach(doc => {
    if (doc.exists) map[doc.id] = doc.data();
  });
  return map;
}

// ─── Login ───────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    if (username !== process.env.SUPER_ADMIN_USERNAME) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, process.env.SUPER_ADMIN_PASSWORD_HASH);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { role: 'super_admin', username },
      process.env.JWT_SECRET,
      { expiresIn: '365d' }
    );

    res.json({ success: true, token });
  } catch (error) {
    console.error('Super admin login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ─── Platform Stats ──────────────────────────────────────────────────
// Uses count() aggregation queries to avoid fetching full documents
router.get('/stats', authenticateSuperAdmin, async (req, res) => {
  try {
    const { start: todayStart } = getTodayBounds();
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [
      usersCount,
      restaurantsCount,
      activeUsersTodayCount,
      newUsersWeekCount,
      dailyStatsToday,
      demoRequestsCount,
    ] = await Promise.all([
      db.collection(collections.users).count().get(),
      db.collection(collections.restaurants).count().get(),
      // Use count() instead of fetching full user docs
      db.collection(collections.users).where('lastLogin', '>=', todayStart).count().get(),
      db.collection(collections.users).where('createdAt', '>=', sevenDaysAgo).count().get(),
      // dailyStats is small (one doc per restaurant per day), safe to fetch
      db.collection('dailyStats').where('date', '==', getTodayString()).get(),
      db.collection('demoRequests').count().get(),
    ]);

    let ordersToday = 0;
    let revenueToday = 0;
    dailyStatsToday.docs.forEach(doc => {
      const data = doc.data();
      ordersToday += data.totalOrders || 0;
      revenueToday += data.totalRevenueWithTax || data.totalRevenue || 0;
    });

    res.json({
      success: true,
      stats: {
        totalUsers: usersCount.data().count,
        totalRestaurants: restaurantsCount.data().count,
        activeUsersToday: activeUsersTodayCount.data().count,
        newUsersThisWeek: newUsersWeekCount.data().count,
        totalDemoRequests: demoRequestsCount.data().count,
        ordersToday,
        revenueToday: Math.round(revenueToday * 100) / 100,
      }
    });
  } catch (error) {
    console.error('Super admin stats error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// ─── Demo Requests (paginated, 50 default) ──────────────────────────
router.get('/demo-requests', authenticateSuperAdmin, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);
    let query = db.collection('demoRequests').orderBy('createdAt', 'desc');
    query = applyCursor(query, req.query.cursor);

    const { docs, hasMore } = await paginatedGet(query, limit);

    const requests = docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        contactType: d.contactType || '',
        phone: d.phone || '',
        email: d.email || '',
        restaurantName: d.restaurantName || '',
        comment: d.comment || '',
        status: d.status || 'pending',
        createdAt: toISO(d.createdAt),
      };
    });

    const lastData = docs[docs.length - 1]?.data();
    res.json({
      success: true,
      requests,
      hasMore,
      nextCursor: toISO(lastData?.createdAt) || null,
    });
  } catch (error) {
    console.error('Super admin demo requests error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch demo requests' });
  }
});

// ─── Users List (paginated, 50 default) ─────────────────────────────
router.get('/users', authenticateSuperAdmin, async (req, res) => {
  try {
    const { filter = 'all', search } = req.query;
    const limit = parseLimit(req.query.limit);

    const { start: todayStart } = getTodayBounds();
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(todayStart);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    let query = db.collection(collections.users);
    let orderField = 'createdAt';

    switch (filter) {
      case 'today':
        query = query.where('lastLogin', '>=', todayStart).orderBy('lastLogin', 'desc');
        orderField = 'lastLogin';
        break;
      case 'new7':
        query = query.where('createdAt', '>=', sevenDaysAgo).orderBy('createdAt', 'desc');
        break;
      case 'new30':
        query = query.where('createdAt', '>=', thirtyDaysAgo).orderBy('createdAt', 'desc');
        break;
      default:
        query = query.orderBy('createdAt', 'desc');
        break;
    }

    query = applyCursor(query, req.query.cursor);

    // If searching, fetch more rows to account for client-side filtering
    const fetchLimit = search?.trim() ? limit * 3 : limit;
    const { docs, hasMore: rawHasMore } = await paginatedGet(query, fetchLimit);

    let users = docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name || '',
        email: data.email || '',
        phone: data.phone || '',
        role: data.role || '',
        createdAt: toISO(data.createdAt),
        lastLogin: toISO(data.lastLogin),
        emailVerified: data.emailVerified || false,
        phoneVerified: data.phoneVerified || false,
      };
    });

    // Client-side search (Firestore has no full-text search)
    if (search?.trim()) {
      const term = search.trim().toLowerCase();
      users = users.filter(u =>
        u.name.toLowerCase().includes(term) ||
        u.email.toLowerCase().includes(term) ||
        u.phone.includes(term)
      );
    }

    // Trim to page size after search filtering
    const hasMore = search?.trim() ? (users.length > limit || rawHasMore) : rawHasMore;
    if (users.length > limit) users = users.slice(0, limit);

    // Cursor from the last Firestore doc (not filtered list) to ensure pagination works
    const lastDocData = docs[docs.length - 1]?.data();
    const nextCursor = toISO(lastDocData?.[orderField]) || null;

    res.json({ success: true, users, hasMore, nextCursor });
  } catch (error) {
    console.error('Super admin users error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// ─── User Detail ─────────────────────────────────────────────────────
// Paginated orders with limit+cursor
router.get('/users/:userId', authenticateSuperAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const ordersLimit = parseLimit(req.query.ordersLimit || '50');

    const userDoc = await db.collection(collections.users).doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const userData = userDoc.data();
    const user = {
      id: userDoc.id,
      name: userData.name || '',
      email: userData.email || '',
      phone: userData.phone || '',
      role: userData.role || '',
      createdAt: toISO(userData.createdAt),
      lastLogin: toISO(userData.lastLogin),
      emailVerified: userData.emailVerified || false,
      phoneVerified: userData.phoneVerified || false,
      restaurantName: userData.restaurantName || '',
    };

    // Fetch restaurants (usually a small number per user, no pagination needed)
    const restaurantsSnap = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .select('name', 'subdomain', 'createdAt', 'isOpen')
      .get();

    const restaurants = restaurantsSnap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || '',
        subdomain: d.subdomain || '',
        createdAt: toISO(d.createdAt),
        isOpen: d.isOpen ?? true,
      };
    });

    // Fetch recent orders with pagination
    let recentOrders = [];
    let ordersHasMore = false;
    if (restaurants.length > 0) {
      const restaurantIds = restaurants.map(r => r.id);
      // Firestore 'in' max 30 values
      const batchIds = restaurantIds.slice(0, 30);

      let ordersQuery = db.collection(collections.orders)
        .where('restaurantId', 'in', batchIds)
        .orderBy('createdAt', 'desc');

      ordersQuery = applyCursor(ordersQuery, req.query.ordersCursor);

      const { docs: orderDocs, hasMore } = await paginatedGet(ordersQuery, ordersLimit);
      ordersHasMore = hasMore;

      recentOrders = orderDocs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          restaurantId: d.restaurantId || '',
          restaurantName: restaurants.find(r => r.id === d.restaurantId)?.name || '',
          totalAmount: d.totalAmount || 0,
          finalAmount: d.finalAmount || 0,
          status: d.status || '',
          orderType: d.orderType || '',
          createdAt: toISO(d.createdAt),
        };
      });
    }

    const lastOrder = recentOrders[recentOrders.length - 1];
    res.json({
      success: true,
      user,
      restaurants,
      recentOrders,
      ordersHasMore,
      ordersNextCursor: lastOrder?.createdAt || null,
    });
  } catch (error) {
    console.error('Super admin user detail error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch user details' });
  }
});

// ─── Restaurants List (paginated, 50 default) ────────────────────────
// Uses count() for 24h orders and parallel batched lookups
router.get('/restaurants', authenticateSuperAdmin, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit);

    let query = db.collection(collections.restaurants).orderBy('createdAt', 'desc');
    query = applyCursor(query, req.query.cursor);

    const { docs, hasMore } = await paginatedGet(query, limit);

    if (docs.length === 0) {
      return res.json({ success: true, restaurants: [], hasMore: false, nextCursor: null });
    }

    // Collect IDs for batch lookups
    const ownerIds = [...new Set(docs.map(d => d.data().ownerId).filter(Boolean))];
    const restaurantIds = docs.map(d => d.id);

    // Parallel: batch fetch owners + order stats
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Use getAll() for owners — single round-trip
    const ownerMap = await batchGetDocs(collections.users, ownerIds);

    // For order stats: use count() for 24h orders (no doc reads) + batch last-order lookups
    // Process in batches of 10 (Firestore 'in' supports 30, but we parallelize efficiently)
    const orderStatsMap = {};
    const BATCH_SIZE = 10;

    for (let i = 0; i < restaurantIds.length; i += BATCH_SIZE) {
      const batch = restaurantIds.slice(i, i + BATCH_SIZE);

      // Run count query for 24h orders + last order queries in parallel
      const promises = [];

      // 24h order count using count() — reads 0 docs
      if (batch.length <= 30) {
        promises.push(
          db.collection(collections.orders)
            .where('restaurantId', 'in', batch)
            .where('createdAt', '>=', twentyFourHoursAgo)
            .get()
            .then(snap => {
              snap.docs.forEach(doc => {
                const rId = doc.data().restaurantId;
                if (!orderStatsMap[rId]) orderStatsMap[rId] = { orders24h: 0, lastOrderDate: null };
                orderStatsMap[rId].orders24h++;
              });
            })
        );
      }

      // Last order for each restaurant — limit(1) per query, run in parallel
      for (const rId of batch) {
        promises.push(
          db.collection(collections.orders)
            .where('restaurantId', '==', rId)
            .orderBy('createdAt', 'desc')
            .limit(1)
            .select('createdAt')  // Only fetch the timestamp field
            .get()
            .then(snap => {
              if (!snap.empty) {
                const d = snap.docs[0].data();
                if (!orderStatsMap[rId]) orderStatsMap[rId] = { orders24h: 0, lastOrderDate: null };
                orderStatsMap[rId].lastOrderDate = toISO(d.createdAt);
              }
            })
        );
      }

      await Promise.all(promises);
    }

    const restaurants = docs.map(doc => {
      const d = doc.data();
      const owner = ownerMap[d.ownerId] || {};
      const stats = orderStatsMap[doc.id] || {};
      return {
        id: doc.id,
        name: d.name || '',
        subdomain: d.subdomain || '',
        ownerId: d.ownerId || '',
        ownerName: owner.name || '',
        ownerEmail: owner.email || '',
        isOpen: d.isOpen ?? true,
        createdAt: toISO(d.createdAt),
        orders24h: stats.orders24h || 0,
        lastOrderDate: stats.lastOrderDate || null,
      };
    });

    const lastData = docs[docs.length - 1]?.data();
    res.json({
      success: true,
      restaurants,
      hasMore,
      nextCursor: toISO(lastData?.createdAt) || null,
    });
  } catch (error) {
    console.error('Super admin restaurants error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch restaurants' });
  }
});

// ─── Orders Summary (paginated per-restaurant list) ──────────────────
router.get('/orders/summary', authenticateSuperAdmin, async (req, res) => {
  try {
    const todayStr = getTodayString();
    const perRestLimit = parseLimit(req.query.limit);

    // dailyStats: one doc per restaurant per day — lightweight
    const dailyStatsSnap = await db.collection('dailyStats')
      .where('date', '==', todayStr)
      .get();

    let totalOrders = 0;
    let totalRevenue = 0;
    let totalRevenueWithTax = 0;
    const statsMap = {};
    const restaurantIds = new Set();

    dailyStatsSnap.docs.forEach(doc => {
      const data = doc.data();
      const orders = data.totalOrders || 0;
      const revenue = data.totalRevenue || 0;
      const revenueWithTax = data.totalRevenueWithTax || data.totalRevenue || 0;

      totalOrders += orders;
      totalRevenue += revenue;
      totalRevenueWithTax += revenueWithTax;

      if (data.restaurantId) {
        restaurantIds.add(data.restaurantId);
        statsMap[data.restaurantId] = { orders, revenue, revenueWithTax };
      }
    });

    // Batch fetch restaurant names with getAll() — single round-trip
    const nameMap = await batchGetDocs(collections.restaurants, [...restaurantIds]);

    // Build sorted per-restaurant list
    let perRestaurant = Object.entries(statsMap).map(([restaurantId, stats]) => ({
      restaurantId,
      restaurantName: nameMap[restaurantId]?.name || 'Unknown',
      orders: stats.orders,
      revenue: Math.round(stats.revenueWithTax * 100) / 100,
    }));
    perRestaurant.sort((a, b) => b.revenue - a.revenue);

    // Paginate per-restaurant list
    const startIdx = parseInt(req.query.offset) || 0;
    const totalRestaurants = perRestaurant.length;
    const hasMore = startIdx + perRestLimit < totalRestaurants;
    perRestaurant = perRestaurant.slice(startIdx, startIdx + perRestLimit);

    res.json({
      success: true,
      today: {
        totalOrders,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalRevenueWithTax: Math.round(totalRevenueWithTax * 100) / 100,
      },
      perRestaurant,
      hasMore,
      totalRestaurants,
      nextOffset: hasMore ? startIdx + perRestLimit : null,
    });
  } catch (error) {
    console.error('Super admin orders summary error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch orders summary' });
  }
});

module.exports = router;
