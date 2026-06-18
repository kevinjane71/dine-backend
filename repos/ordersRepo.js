/**
 * ordersRepo.js — PostgreSQL data access layer for orders.
 *
 * This is the ONLY file that talks to PostgreSQL for orders.
 * All 6 hot endpoints use this module.
 *
 * Every method returns Firestore-shaped camelCase objects so the existing
 * endpoint code (formatOrder, KOT enrichment, etc.) works without changes.
 *
 * Usage:
 *   const ordersRepo = require('./repos/ordersRepo');
 *   const orders = await ordersRepo.getByRestaurant(restaurantId, filters);
 */

const { query } = require('./pgClient');
const { toPgRow, toFirestoreObj, buildInsert, buildUpdate, JSONB_COLUMNS } = require('./fieldMapper');

// ============================================================
// 1. GET /api/orders/single/:orderId
// ============================================================

/**
 * Fetch a single order by its document ID.
 * Returns a Firestore-shaped camelCase object, or null if not found.
 */
async function getById(orderId) {
  const result = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

// ============================================================
// 2. GET /api/orders/:restaurantId
// ============================================================

/**
 * Paginated order list with filters.
 * Mirrors the Firestore query logic in index.js GET /api/orders/:restaurantId.
 *
 * @param {string} restaurantId
 * @param {Object} filters
 * @param {number} [filters.page=1]
 * @param {number} [filters.limit=10]
 * @param {string} [filters.status] - 'pending', 'completed', etc. or 'all'
 * @param {string} [filters.orderType]
 * @param {string} [filters.date] - single date (YYYY-MM-DD)
 * @param {string} [filters.startDate] - range start
 * @param {string} [filters.endDate] - range end
 * @param {boolean} [filters.todayOnly]
 * @param {Date} [filters.todayStart] - pre-computed by endpoint (timezone-aware)
 * @param {Date} [filters.todayEnd]
 * @param {string} [filters.search] - search by ID, order number, dailyOrderId, customer name/phone, table
 * @param {string} [filters.waiterId] - filter by staff userId
 * @param {string} [filters.myOrdersOnly] - filter by staff userId
 * @param {string} [filters.paymentMethod]
 * @param {string} [filters.paymentStatus] - 'paid', 'unpaid', 'partial'
 * @param {boolean} [filters.isScheduled]
 * @param {Date} [filters.dateStart] - pre-computed single-date start bound
 * @param {Date} [filters.dateEnd] - pre-computed single-date end bound
 *
 * @returns {{ orders: Object[], pagination: Object }}
 */
async function getByRestaurant(restaurantId, filters = {}) {
  const {
    page = 1,
    limit = 10,
    status,
    orderType,
    date,
    startDate,
    endDate,
    todayOnly,
    todayStart,
    todayEnd,
    search,
    waiterId,
    myOrdersOnly,
    paymentMethod,
    paymentStatus,
    isScheduled,
    dateStart,
    dateEnd,
  } = filters;

  const pageNum = parseInt(page) || 1;
  const limitNum = parseInt(limit) || 10;
  const offsetNum = (pageNum - 1) * limitNum;

  // ---- Quick-match: search by direct ID ----
  if (search && search.trim() && !waiterId) {
    const searchValue = search.trim();

    // Try direct ID lookup
    const directResult = await query(
      'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2',
      [searchValue, restaurantId]
    );
    if (directResult.rows.length > 0) {
      const order = toFirestoreObj(directResult.rows[0]);
      return {
        orders: [order],
        pagination: { currentPage: 1, totalPages: 1, totalOrders: 1, limit: limitNum, hasNextPage: false, hasPrevPage: false },
      };
    }

    // Try dailyOrderId lookup
    const numericSearch = parseInt(searchValue);
    if (!isNaN(numericSearch)) {
      const conditions = ['restaurant_id = $1', 'daily_order_id = $2'];
      const params = [restaurantId, numericSearch];
      let paramIdx = 3;

      if (todayOnly && todayStart) {
        conditions.push(`created_at >= $${paramIdx}`);
        params.push(todayStart);
        paramIdx++;
      }

      const numResult = await query(
        `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 10`,
        params
      );
      if (numResult.rows.length > 0) {
        const orders = numResult.rows.map(toFirestoreObj);
        return {
          orders,
          pagination: { currentPage: 1, totalPages: 1, totalOrders: orders.length, limit: limitNum, hasNextPage: false, hasPrevPage: false },
        };
      }
    }
  }

  // ---- Build WHERE clause ----
  const conditions = ['restaurant_id = $1'];
  const params = [restaurantId];
  let paramIdx = 2;

  // Status filter
  if (status && status !== 'all') {
    conditions.push(`status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  } else {
    // Exclude deleted/expired (same as Firestore 'in' filter)
    conditions.push(`status IN ('pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled', 'saved')`);
  }

  // Order type
  if (orderType && orderType !== 'all') {
    conditions.push(`order_type = $${paramIdx}`);
    params.push(orderType);
    paramIdx++;
  }

  // Scheduled
  if (isScheduled) {
    conditions.push('is_scheduled = TRUE');
  }

  // Waiter filter (when not in search path)
  if (waiterId && waiterId !== 'all' && !search) {
    conditions.push(`staff_info->>'userId' = $${paramIdx}`);
    params.push(waiterId);
    paramIdx++;
  }

  // myOrdersOnly
  if (myOrdersOnly && !search) {
    conditions.push(`staff_info->>'userId' = $${paramIdx}`);
    params.push(myOrdersOnly);
    paramIdx++;
  }

  // Date filters
  if (todayOnly && todayStart && todayEnd) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(todayStart);
    paramIdx++;
    conditions.push(`created_at <= $${paramIdx}`);
    params.push(todayEnd);
    paramIdx++;
  } else if (date && dateStart && dateEnd && !todayOnly) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(dateStart);
    paramIdx++;
    conditions.push(`created_at <= $${paramIdx}`);
    params.push(dateEnd);
    paramIdx++;
  } else if (startDate && endDate && !todayOnly && !date) {
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(new Date(startDate));
    paramIdx++;
    conditions.push(`created_at <= $${paramIdx}`);
    params.push(new Date(endDate));
    paramIdx++;
  } else if (search && search.trim() && !todayOnly && !date && !startDate) {
    // Search without date → last 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    conditions.push(`created_at >= $${paramIdx}`);
    params.push(ninetyDaysAgo);
    paramIdx++;
  }

  const whereClause = conditions.join(' AND ');

  // ---- Determine if we need in-memory filtering (search/payment filters) ----
  const needsInMemoryFilter = (search && search.trim()) ||
    (waiterId && waiterId !== 'all' && search) ||
    (paymentMethod && paymentMethod !== 'all') ||
    (paymentStatus && paymentStatus !== 'all');

  if (!needsInMemoryFilter) {
    // FAST PATH: paginate at SQL level
    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT * FROM orders WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limitNum, offsetNum]
      ),
      query(
        `SELECT COUNT(*) as count FROM orders WHERE ${whereClause}`,
        params
      ),
    ]);

    const orders = dataResult.rows.map(toFirestoreObj);
    const totalOrders = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalOrders / limitNum);

    return {
      orders,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalOrders,
        limit: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    };
  }

  // SEARCH/FILTER PATH: load capped set, filter in memory
  const MAX_SEARCH_DOCS = 1000;
  const searchResult = await query(
    `SELECT * FROM orders WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${MAX_SEARCH_DOCS}`,
    params
  );

  let allOrders = searchResult.rows.map(toFirestoreObj);

  // Exclude deleted/expired when status is 'all' or not set
  if (!status || status === 'all') {
    allOrders = allOrders.filter(o => o.status !== 'deleted' && o.status !== 'expired');
  }

  // Auto-expire saved orders > 24h
  if (status === 'saved') {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expiredIds = [];
    allOrders = allOrders.filter(order => {
      const createdAt = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt);
      if (createdAt < twentyFourHoursAgo) {
        expiredIds.push(order.id);
        return false;
      }
      return true;
    });
    // Mark expired in PG (fire-and-forget)
    if (expiredIds.length > 0) {
      query(
        `UPDATE orders SET status = 'expired', expired_at = NOW() WHERE id = ANY($1)`,
        [expiredIds]
      ).catch(err => console.error('Error expiring saved orders in PG:', err));
    }
  }

  // Waiter filter (in search path)
  if (waiterId && waiterId !== 'all' && search && search.trim()) {
    allOrders = allOrders.filter(o => o.staffInfo && o.staffInfo.userId === waiterId);
  }

  // myOrdersOnly (in search path)
  if (myOrdersOnly) {
    allOrders = allOrders.filter(o => o.staffInfo && o.staffInfo.userId === myOrdersOnly);
  }

  // Payment method filter
  if (paymentMethod && paymentMethod !== 'all') {
    allOrders = allOrders.filter(o => {
      const method = (o.paymentMethod || 'cash').toLowerCase();
      return method === paymentMethod.toLowerCase();
    });
  }

  // Payment status filter
  if (paymentStatus && paymentStatus !== 'all') {
    allOrders = allOrders.filter(o => {
      if (paymentStatus === 'partial') {
        return o.paymentStatus === 'partial' || o.paymentStatus === 'due' || o.outstandingAmount > 0;
      }
      if (paymentStatus === 'paid') {
        return o.paymentStatus === 'paid' || o.paymentStatus === 'completed' || (o.status === 'completed' && !o.outstandingAmount);
      }
      if (paymentStatus === 'unpaid') {
        return o.paymentStatus === 'pending' || o.paymentStatus === 'unpaid';
      }
      return true;
    });
  }

  // Search filter
  if (search && search.trim()) {
    const searchValue = search.toLowerCase().trim();
    allOrders = allOrders.filter(o => {
      if (o.id && o.id.toLowerCase().includes(searchValue)) return true;
      if (o.orderNumber && o.orderNumber.toLowerCase().includes(searchValue)) return true;
      if (o.dailyOrderId != null && String(o.dailyOrderId) === searchValue) return true;
      if (o.tableNumber && o.tableNumber.toString().toLowerCase().includes(searchValue)) return true;
      if (o.customerInfo?.name && o.customerInfo.name.toLowerCase().includes(searchValue)) return true;
      if (o.customerInfo?.phone && o.customerInfo.phone.includes(searchValue)) return true;
      if (o.customerName && o.customerName.toLowerCase().includes(searchValue)) return true;
      if (o.customerPhone && o.customerPhone.includes(searchValue)) return true;
      return false;
    });
  }

  // Paginate in memory
  const totalOrders = allOrders.length;
  const totalPages = Math.ceil(totalOrders / limitNum);
  const paginatedOrders = allOrders.slice(offsetNum, offsetNum + limitNum);

  return {
    orders: paginatedOrders,
    pagination: {
      currentPage: pageNum,
      totalPages,
      totalOrders,
      limit: limitNum,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

// ============================================================
// 3. GET /api/kot/:restaurantId
// ============================================================

/**
 * Get active kitchen orders (KOT) for a restaurant.
 * Returns orders from yesterday onwards with valid KOT statuses.
 *
 * @param {string} restaurantId
 * @param {Object} options
 * @param {string} [options.status] - specific status filter or 'all'
 * @param {Date} [options.yesterdayStart] - pre-computed by endpoint (timezone-aware)
 * @returns {{ orders: Object[], total: number }}
 */
async function getKotOrders(restaurantId, options = {}) {
  const { status, yesterdayStart } = options;

  const validKotStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'completed'];

  const conditions = ['restaurant_id = $1', 'created_at >= $2'];
  const params = [restaurantId, yesterdayStart || getDefaultYesterdayStart()];
  let paramIdx = 3;

  if (status && status !== 'all') {
    conditions.push(`status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  } else {
    conditions.push(`status IN ('pending', 'confirmed', 'preparing', 'ready', 'completed')`);
  }

  const result = await query(
    `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 100`,
    params
  );

  const orders = result.rows.map(row => {
    const order = toFirestoreObj(row);
    return order;
  });

  return { orders, total: orders.length };
}

// ============================================================
// 4. POST /api/orders → create
// ============================================================

/**
 * Insert a new order into PostgreSQL.
 * Accepts a Firestore-shaped camelCase object (same as what goes to Firestore).
 * Returns the inserted order as a camelCase object.
 *
 * @param {string} id - The order document ID (pre-generated, same as Firestore doc ID)
 * @param {Object} orderData - camelCase order data (same shape as Firestore document)
 * @returns {Object} inserted order (camelCase)
 */
async function create(id, orderData) {
  const pgRow = toPgRow({ id, ...orderData });
  const { text, values } = buildInsert(pgRow);

  const result = await query(text, values);
  return toFirestoreObj(result.rows[0]);
}

// ============================================================
// 5. PATCH /api/orders/:orderId → update
// ============================================================

/**
 * Partial update of an order.
 * Accepts a camelCase partial object (only the fields that changed).
 * Returns the updated order as a camelCase object.
 *
 * @param {string} orderId
 * @param {Object} updateData - camelCase partial update (same shape as Firestore .update())
 * @returns {Object|null} updated order (camelCase), or null if not found
 */
async function update(orderId, updateData) {
  const pgRow = toPgRow(updateData);

  // Nothing to update
  if (Object.keys(pgRow).length === 0) return null;

  const { text, values } = buildUpdate(orderId, pgRow);
  const result = await query(text, values);

  if (result.rows.length === 0) return null;
  return toFirestoreObj(result.rows[0]);
}

// ============================================================
// 6. PATCH /api/orders/:orderId/status → updateStatus
// ============================================================

/**
 * Update order status with associated side-effect fields.
 * Returns the updated order as a camelCase object.
 *
 * @param {string} orderId
 * @param {string} newStatus
 * @param {Object} [extraData={}] - additional fields to set (e.g. cancelledBy, cancellationReason)
 * @returns {Object|null} updated order (camelCase), or null if not found
 */
async function updateStatus(orderId, newStatus, extraData = {}) {
  // Get current order to capture lastStatus
  const currentResult = await query('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (currentResult.rows.length === 0) return null;

  const currentStatus = currentResult.rows[0].status;

  const updateFields = {
    status: newStatus,
    lastStatus: currentStatus,
    updatedAt: new Date(),
    ...extraData,
  };

  // Set timestamp fields based on status
  if (newStatus === 'completed' && !extraData.completedAt) {
    updateFields.completedAt = new Date();
  }
  if (newStatus === 'cancelled' && !extraData.cancelledAt) {
    updateFields.cancelledAt = new Date();
  }
  if (newStatus === 'expired' && !extraData.expiredAt) {
    updateFields.expiredAt = new Date();
  }

  return update(orderId, updateFields);
}

// ============================================================
// Helpers
// ============================================================

function getDefaultYesterdayStart() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

module.exports = {
  getById,
  getByRestaurant,
  getKotOrders,
  create,
  update,
  updateStatus,
};
