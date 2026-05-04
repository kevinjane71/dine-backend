const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const { requireOrgAccess, getOwnerId, getOrgOutlets } = require('../middleware/orgAccess');

// ============================================
// HQ-LEVEL CROSS-OUTLET REPORTS
// Mounted at /api/hq-reports
// All endpoints require owner role + org access
// ============================================

const reportMiddleware = [authenticateToken, requireOwnerRole, requireOrgAccess];

// ─── Helper: Parse date range from query params ──────────────────────────────
function parseDateRange(query) {
  const now = new Date();
  let startDate, endDate;

  if (query.startDate) {
    startDate = new Date(query.startDate);
    if (isNaN(startDate.getTime())) {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    }
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  if (query.endDate) {
    endDate = new Date(query.endDate);
    if (isNaN(endDate.getTime())) {
      endDate = now;
    }
  } else {
    endDate = now;
  }

  // Ensure endDate covers the full day
  endDate.setHours(23, 59, 59, 999);

  return { startDate, endDate };
}

// ─── Helper: Get completed/paid orders for an outlet in date range ───────────
async function getOutletOrders(outletId, startDate, endDate) {
  const validStatuses = ['completed', 'paid', 'settled'];
  const orders = [];

  for (const status of validStatuses) {
    const snapshot = await db.collection(collections.orders)
      .where('restaurantId', '==', outletId)
      .where('status', '==', status)
      .get();

    snapshot.forEach(doc => {
      const data = doc.data();
      const orderDate = data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt)) : null;
      if (orderDate && orderDate >= startDate && orderDate <= endDate) {
        orders.push({ id: doc.id, ...data });
      }
    });
  }

  return orders;
}

// ─── Helper: Get expenses for an outlet in date range ────────────────────────
async function getOutletExpenses(outletId, startDate, endDate) {
  const snapshot = await db.collection(collections.expenses)
    .where('restaurantId', '==', outletId)
    .get();

  const expenses = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    const expDate = data.date ? (data.date.toDate ? data.date.toDate() : new Date(data.date)) : null;
    if (expDate && expDate >= startDate && expDate <= endDate) {
      expenses.push({ id: doc.id, ...data });
    }
  });
  return expenses;
}

// ─── Helper: Get order revenue ───────────────────────────────────────────────
function getOrderRevenue(order) {
  return Number(order.totalAmount) || Number(order.total) || 0;
}

// ═══════════════════════════════════════════════
//  1. GET /:orgId/inventory-comparison
//     Cross-outlet inventory comparison matrix
// ═══════════════════════════════════════════════
router.get('/:orgId/inventory-comparison', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const outlets = await getOrgOutlets(orgId);

    if (outlets.length === 0) {
      return res.json({ success: true, outlets: [], items: [], matrix: [] });
    }

    // Fetch inventory for all outlets in parallel
    const inventoryByOutlet = {};
    const allItemNames = new Set();

    const inventoryPromises = outlets.map(async (outlet) => {
      const snapshot = await db.collection(collections.inventory)
        .where('restaurantId', '==', outlet.id)
        .get();

      const items = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        const itemName = data.name || data.itemName || 'Unnamed Item';
        allItemNames.add(itemName);
        items.push({
          id: doc.id,
          name: itemName,
          currentStock: Number(data.currentStock) || Number(data.quantity) || 0,
          reorderLevel: Number(data.reorderLevel) || Number(data.reorderPoint) || 0,
          unit: data.unit || '',
          category: data.category || ''
        });
      });

      inventoryByOutlet[outlet.id] = items;
    });

    await Promise.all(inventoryPromises);

    // Build matrix: rows = item names, columns = outlets
    const sortedItemNames = Array.from(allItemNames).sort();
    const matrix = sortedItemNames.map(itemName => {
      const row = {
        itemName,
        outlets: {}
      };

      let hasLowStock = false;

      outlets.forEach(outlet => {
        const outletItems = inventoryByOutlet[outlet.id] || [];
        const match = outletItems.find(i => i.name === itemName);

        if (match) {
          const lowStockThreshold = match.reorderLevel > 0 ? match.reorderLevel : 10;
          const isLowStock = match.currentStock < lowStockThreshold;
          if (isLowStock) hasLowStock = true;

          row.outlets[outlet.id] = {
            currentStock: match.currentStock,
            reorderLevel: match.reorderLevel,
            unit: match.unit,
            category: match.category,
            lowStock: isLowStock
          };
        } else {
          row.outlets[outlet.id] = {
            currentStock: 0,
            reorderLevel: 0,
            unit: '',
            category: '',
            lowStock: false,
            notFound: true
          };
        }
      });

      row.hasLowStock = hasLowStock;
      return row;
    });

    return res.json({
      success: true,
      outlets: outlets.map(o => ({ id: o.id, name: o.name, outletType: o.outletType })),
      totalItems: sortedItemNames.length,
      lowStockItems: matrix.filter(r => r.hasLowStock).length,
      matrix
    });
  } catch (error) {
    console.error('Inventory comparison error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate inventory comparison' });
  }
});

// ═══════════════════════════════════════════════
//  2. GET /:orgId/consolidated-pl
//     Aggregated P&L across outlets
// ═══════════════════════════════════════════════
router.get('/:orgId/consolidated-pl', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    if (outlets.length === 0) {
      return res.json({
        success: true,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        totalRevenue: 0,
        totalExpenses: 0,
        grossProfit: 0,
        outletBreakdown: []
      });
    }

    const outletBreakdown = [];
    let totalRevenue = 0;
    let totalExpenses = 0;

    const outletPromises = outlets.map(async (outlet) => {
      const [orders, expenses] = await Promise.all([
        getOutletOrders(outlet.id, startDate, endDate),
        getOutletExpenses(outlet.id, startDate, endDate)
      ]);

      const revenue = orders.reduce((sum, o) => sum + getOrderRevenue(o), 0);
      const expenseTotal = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
      const profit = revenue - expenseTotal;

      return {
        outletId: outlet.id,
        outletName: outlet.name,
        outletType: outlet.outletType,
        totalRevenue: Math.round(revenue * 100) / 100,
        totalExpenses: Math.round(expenseTotal * 100) / 100,
        grossProfit: Math.round(profit * 100) / 100,
        orderCount: orders.length,
        expenseCount: expenses.length
      };
    });

    const results = await Promise.all(outletPromises);

    results.forEach(r => {
      outletBreakdown.push(r);
      totalRevenue += r.totalRevenue;
      totalExpenses += r.totalExpenses;
    });

    // Sort by revenue descending
    outletBreakdown.sort((a, b) => b.totalRevenue - a.totalRevenue);

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      grossProfit: Math.round((totalRevenue - totalExpenses) * 100) / 100,
      outletCount: outlets.length,
      outletBreakdown
    });
  } catch (error) {
    console.error('Consolidated P&L error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate consolidated P&L report' });
  }
});

// ═══════════════════════════════════════════════
//  3. GET /:orgId/kitchen-reports
//     Production efficiency reports
// ═══════════════════════════════════════════════
router.get('/:orgId/kitchen-reports', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);

    // Query production orders for this org
    const prodSnapshot = await db.collection(collections.productionOrders)
      .where('organizationId', '==', orgId)
      .get();

    const productionOrders = [];
    prodSnapshot.forEach(doc => {
      const data = doc.data();
      const orderDate = data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt)) : null;
      if (orderDate && orderDate >= startDate && orderDate <= endDate) {
        productionOrders.push({ id: doc.id, ...data });
      }
    });

    // Overall stats
    const totalOrders = productionOrders.length;
    const completedCount = productionOrders.filter(o => o.status === 'completed').length;
    const cancelledCount = productionOrders.filter(o => o.status === 'cancelled').length;
    const inProgressCount = productionOrders.filter(o => o.status === 'in_progress' || o.status === 'in-progress').length;
    const pendingCount = productionOrders.filter(o => o.status === 'pending' || o.status === 'requested').length;
    const totalProducedQty = productionOrders.reduce((sum, o) => sum + (Number(o.producedQuantity) || 0), 0);
    const totalTargetQty = productionOrders.reduce((sum, o) => sum + (Number(o.targetQuantity) || 0), 0);

    // Group by recipe
    const recipeMap = {};
    productionOrders.forEach(order => {
      const recipeName = order.recipeName || order.recipeId || 'Unknown Recipe';
      if (!recipeMap[recipeName]) {
        recipeMap[recipeName] = {
          recipeName,
          recipeId: order.recipeId || null,
          totalOrders: 0,
          completedOrders: 0,
          cancelledOrders: 0,
          totalTargetQty: 0,
          totalProducedQty: 0,
          unit: order.unit || ''
        };
      }
      recipeMap[recipeName].totalOrders++;
      if (order.status === 'completed') recipeMap[recipeName].completedOrders++;
      if (order.status === 'cancelled') recipeMap[recipeName].cancelledOrders++;
      recipeMap[recipeName].totalTargetQty += Number(order.targetQuantity) || 0;
      recipeMap[recipeName].totalProducedQty += Number(order.producedQuantity) || 0;
    });

    const recipeBreakdown = Object.values(recipeMap).sort((a, b) => b.totalProducedQty - a.totalProducedQty);

    // Query waste entries for this org in date range
    const outlets = await getOrgOutlets(orgId);
    let totalWasteEntries = 0;
    let totalWasteQty = 0;
    let totalWasteCost = 0;
    const wasteByReason = {};

    const wastePromises = outlets.map(async (outlet) => {
      const wasteSnapshot = await db.collection(collections.wasteEntries)
        .where('restaurantId', '==', outlet.id)
        .get();

      const entries = [];
      wasteSnapshot.forEach(doc => {
        const data = doc.data();
        const wasteDate = data.date ? (data.date.toDate ? data.date.toDate() : new Date(data.date)) : null;
        if (wasteDate && wasteDate >= startDate && wasteDate <= endDate) {
          entries.push(data);
        }
      });
      return entries;
    });

    const wasteResults = await Promise.all(wastePromises);
    wasteResults.forEach(entries => {
      entries.forEach(entry => {
        totalWasteEntries++;
        totalWasteQty += Number(entry.quantity) || 0;
        totalWasteCost += Number(entry.costValue) || Number(entry.cost) || 0;
        const reason = entry.reason || entry.wasteReason || 'Other';
        wasteByReason[reason] = (wasteByReason[reason] || 0) + (Number(entry.quantity) || 0);
      });
    });

    const completionRate = totalOrders > 0 ? Math.round((completedCount / totalOrders) * 10000) / 100 : 0;
    const yieldRate = totalTargetQty > 0 ? Math.round((totalProducedQty / totalTargetQty) * 10000) / 100 : 0;

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      summary: {
        totalOrders,
        completedCount,
        cancelledCount,
        inProgressCount,
        pendingCount,
        totalTargetQty,
        totalProducedQty,
        completionRate,
        yieldRate
      },
      recipeBreakdown,
      waste: {
        totalWasteEntries,
        totalWasteQty: Math.round(totalWasteQty * 100) / 100,
        totalWasteCost: Math.round(totalWasteCost * 100) / 100,
        wasteByReason
      }
    });
  } catch (error) {
    console.error('Kitchen reports error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate kitchen reports' });
  }
});

// ═══════════════════════════════════════════════
//  4. GET /:orgId/warehouse-metrics
//     Warehouse performance metrics
// ═══════════════════════════════════════════════
router.get('/:orgId/warehouse-metrics', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);

    const snapshot = await db.collection(collections.indentRequests)
      .where('organizationId', '==', orgId)
      .get();

    const indents = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      const requestDate = data.requestedAt || data.createdAt;
      const indentDate = requestDate ? (requestDate.toDate ? requestDate.toDate() : new Date(requestDate)) : null;
      if (indentDate && indentDate >= startDate && indentDate <= endDate) {
        indents.push({ id: doc.id, ...data });
      }
    });

    const totalIndents = indents.length;

    // Fill rate: sum of receivedQty / sum of requestedQty across all indent items
    let totalRequestedQty = 0;
    let totalReceivedQty = 0;

    // Average processing time (requestedAt to receivedAt) for completed indents
    let totalProcessingTimeMs = 0;
    let processedIndentCount = 0;

    // Top requested items
    const itemRequestMap = {};

    // Status pipeline
    const statusCounts = {};

    indents.forEach(indent => {
      // Status counts
      const status = indent.status || 'unknown';
      statusCounts[status] = (statusCounts[status] || 0) + 1;

      // Process items
      const items = indent.items || [];
      items.forEach(item => {
        const reqQty = Number(item.requestedQty) || 0;
        const recQty = Number(item.receivedQty) || 0;
        totalRequestedQty += reqQty;
        totalReceivedQty += recQty;

        const itemName = item.inventoryItemName || item.itemName || 'Unknown Item';
        if (!itemRequestMap[itemName]) {
          itemRequestMap[itemName] = { itemName, totalRequested: 0, totalReceived: 0, indentCount: 0 };
        }
        itemRequestMap[itemName].totalRequested += reqQty;
        itemRequestMap[itemName].totalReceived += recQty;
        itemRequestMap[itemName].indentCount++;
      });

      // Processing time for received/completed indents
      if (indent.status === 'received' || indent.status === 'completed') {
        const requestedAt = indent.requestedAt || indent.createdAt;
        const receivedAt = indent.receivedAt || indent.completedAt;
        if (requestedAt && receivedAt) {
          const reqTime = requestedAt.toDate ? requestedAt.toDate() : new Date(requestedAt);
          const recTime = receivedAt.toDate ? receivedAt.toDate() : new Date(receivedAt);
          const diff = recTime.getTime() - reqTime.getTime();
          if (diff > 0) {
            totalProcessingTimeMs += diff;
            processedIndentCount++;
          }
        }
      }
    });

    const fillRate = totalRequestedQty > 0
      ? Math.round((totalReceivedQty / totalRequestedQty) * 10000) / 100
      : 0;

    const avgProcessingTimeHours = processedIndentCount > 0
      ? Math.round((totalProcessingTimeMs / processedIndentCount / (1000 * 60 * 60)) * 100) / 100
      : 0;

    const topRequestedItems = Object.values(itemRequestMap)
      .sort((a, b) => b.totalRequested - a.totalRequested)
      .slice(0, 20);

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      summary: {
        totalIndents,
        fillRate,
        avgProcessingTimeHours,
        totalRequestedQty,
        totalReceivedQty
      },
      statusPipeline: statusCounts,
      topRequestedItems
    });
  } catch (error) {
    console.error('Warehouse metrics error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate warehouse metrics' });
  }
});

// ═══════════════════════════════════════════════
//  5. GET /:orgId/indent-tracking
//     All active indents with status
// ═══════════════════════════════════════════════
router.get('/:orgId/indent-tracking', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const outlets = await getOrgOutlets(orgId);
    const outletMap = {};
    outlets.forEach(o => { outletMap[o.id] = o.name; });

    const snapshot = await db.collection(collections.indentRequests)
      .where('organizationId', '==', orgId)
      .get();

    const terminalStatuses = ['received', 'cancelled', 'rejected'];
    const activeIndents = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (!terminalStatuses.includes(data.status)) {
        activeIndents.push({ id: doc.id, ...data });
      }
    });

    // Enrich with outlet names and group by status
    const groupedByStatus = {};
    activeIndents.forEach(indent => {
      const status = indent.status || 'unknown';
      if (!groupedByStatus[status]) {
        groupedByStatus[status] = [];
      }
      groupedByStatus[status].push({
        id: indent.id,
        indentNumber: indent.indentNumber || null,
        requestingOutletId: indent.requestingOutletId,
        requestingOutletName: outletMap[indent.requestingOutletId] || 'Unknown Outlet',
        warehouseId: indent.warehouseId,
        warehouseName: outletMap[indent.warehouseId] || 'Unknown Warehouse',
        priority: indent.priority || 'medium',
        itemCount: (indent.items || []).length,
        requestedAt: indent.requestedAt || indent.createdAt || null,
        items: (indent.items || []).map(item => ({
          inventoryItemName: item.inventoryItemName || item.itemName || 'Unknown',
          requestedQty: Number(item.requestedQty) || 0,
          approvedQty: item.approvedQty != null ? Number(item.approvedQty) : null,
          pickedQty: item.pickedQty != null ? Number(item.pickedQty) : null,
          receivedQty: item.receivedQty != null ? Number(item.receivedQty) : null,
          unit: item.unit || ''
        }))
      });
    });

    // Summary counts
    const summaryCounts = {};
    Object.keys(groupedByStatus).forEach(status => {
      summaryCounts[status] = groupedByStatus[status].length;
    });

    return res.json({
      success: true,
      totalActiveIndents: activeIndents.length,
      summaryCounts,
      groupedByStatus
    });
  } catch (error) {
    console.error('Indent tracking error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load indent tracking data' });
  }
});

// ═══════════════════════════════════════════════
//  6. GET /:orgId/menu-performance
//     Same item performance across outlets
// ═══════════════════════════════════════════════
router.get('/:orgId/menu-performance', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    if (outlets.length === 0) {
      return res.json({ success: true, items: [], outlets: [] });
    }

    // For each outlet, get orders and aggregate by menu item name
    const itemPerformanceMap = {}; // itemName -> { totals, outlets: { outletId -> {count, revenue} } }

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);

      orders.forEach(order => {
        const orderItems = order.items || order.cartItems || [];
        orderItems.forEach(item => {
          const itemName = item.name || item.itemName || 'Unknown Item';
          const qty = Number(item.quantity) || Number(item.qty) || 1;
          const price = Number(item.price) || Number(item.itemPrice) || 0;
          const itemRevenue = qty * price;

          if (!itemPerformanceMap[itemName]) {
            itemPerformanceMap[itemName] = {
              itemName,
              totalSalesCount: 0,
              totalRevenue: 0,
              outlets: {}
            };
          }

          itemPerformanceMap[itemName].totalSalesCount += qty;
          itemPerformanceMap[itemName].totalRevenue += itemRevenue;

          if (!itemPerformanceMap[itemName].outlets[outlet.id]) {
            itemPerformanceMap[itemName].outlets[outlet.id] = {
              outletId: outlet.id,
              outletName: outlet.name,
              salesCount: 0,
              revenue: 0
            };
          }

          itemPerformanceMap[itemName].outlets[outlet.id].salesCount += qty;
          itemPerformanceMap[itemName].outlets[outlet.id].revenue += itemRevenue;
        });
      });
    });

    await Promise.all(outletPromises);

    // Convert to array and sort by total revenue descending
    const items = Object.values(itemPerformanceMap).map(item => ({
      itemName: item.itemName,
      totalSalesCount: item.totalSalesCount,
      totalRevenue: Math.round(item.totalRevenue * 100) / 100,
      outletBreakdown: Object.values(item.outlets).map(o => ({
        outletId: o.outletId,
        outletName: o.outletName,
        salesCount: o.salesCount,
        revenue: Math.round(o.revenue * 100) / 100
      }))
    })).sort((a, b) => b.totalRevenue - a.totalRevenue);

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalUniqueItems: items.length,
      outlets: outlets.map(o => ({ id: o.id, name: o.name })),
      items
    });
  } catch (error) {
    console.error('Menu performance error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate menu performance report' });
  }
});

// ═══════════════════════════════════════════════
//  7. GET /:orgId/outlet-ranking
//     Revenue/orders/avg ticket by outlet
// ═══════════════════════════════════════════════
router.get('/:orgId/outlet-ranking', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    if (outlets.length === 0) {
      return res.json({
        success: true,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        rankings: []
      });
    }

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);
      const totalRevenue = orders.reduce((sum, o) => sum + getOrderRevenue(o), 0);
      const totalOrders = orders.length;
      const avgTicketSize = totalOrders > 0 ? totalRevenue / totalOrders : 0;

      return {
        outletId: outlet.id,
        outletName: outlet.name,
        outletType: outlet.outletType,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalOrders,
        avgTicketSize: Math.round(avgTicketSize * 100) / 100
      };
    });

    const results = await Promise.all(outletPromises);

    // Sort by revenue descending and assign rank
    results.sort((a, b) => b.totalRevenue - a.totalRevenue);
    const rankings = results.map((r, idx) => ({
      rank: idx + 1,
      ...r
    }));

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalOutlets: rankings.length,
      rankings
    });
  } catch (error) {
    console.error('Outlet ranking error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate outlet ranking' });
  }
});

// ─── Helper: Normalize payment method to bucket ─────────────────────────────
function normalizePaymentMethod(method, order) {
  const m = (method || 'cash').toLowerCase();
  const isAgg = ['zomato', 'swiggy', 'aggregator', 'online'].includes(m) || order.orderSource === 'online_order';
  if (isAgg) return 'aggregator';
  if (m === 'cash') return 'cash';
  if (['card', 'credit_card', 'debit_card'].includes(m)) return 'card';
  if (['upi', 'razorpay', 'phonepe', 'gpay', 'paytm'].includes(m)) return 'upi';
  return 'other';
}

// ─── Helper: Normalize order/service type ────────────────────────────────────
function normalizeServiceType(order) {
  const t = (order.orderType || order.type || 'dine_in').toLowerCase();
  if (['dine_in', 'dine-in', 'dinein'].includes(t)) return 'dine_in';
  if (['takeaway', 'take_away', 'take-away', 'pickup'].includes(t)) return 'takeaway';
  if (['delivery', 'home_delivery'].includes(t)) return 'delivery';
  if (order.orderSource === 'online_order') return 'aggregator';
  return 'dine_in';
}

// ═══════════════════════════════════════════════
//  8. GET /:orgId/sales-summary
//     Comprehensive sales breakdown
// ═══════════════════════════════════════════════
router.get('/:orgId/sales-summary', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    const paymentBuckets = { cash: { count: 0, amount: 0 }, card: { count: 0, amount: 0 }, upi: { count: 0, amount: 0 }, aggregator: { count: 0, amount: 0 }, other: { count: 0, amount: 0 } };
    const serviceBuckets = { dine_in: { count: 0, amount: 0 }, takeaway: { count: 0, amount: 0 }, delivery: { count: 0, amount: 0 }, aggregator: { count: 0, amount: 0 } };
    const dailyMap = {};
    const hourMap = {};
    let totalRevenue = 0, totalOrders = 0, totalTips = 0, totalServiceCharge = 0;
    const outletResults = [];

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);
      let outletRevenue = 0, outletOrders = orders.length;

      orders.forEach(order => {
        const revenue = getOrderRevenue(order);
        totalRevenue += revenue;
        outletRevenue += revenue;
        totalOrders++;
        totalTips += Number(order.tipAmount) || 0;
        totalServiceCharge += Number(order.serviceChargeAmount) || 0;

        // Payment breakdown
        if (order.splitPayments && Array.isArray(order.splitPayments) && order.splitPayments.length > 0) {
          order.splitPayments.forEach(sp => {
            const bucket = normalizePaymentMethod(sp.method || sp.paymentMethod, order);
            paymentBuckets[bucket].count++;
            paymentBuckets[bucket].amount += Number(sp.amount) || 0;
          });
        } else {
          const bucket = normalizePaymentMethod(order.paymentMethod, order);
          paymentBuckets[bucket].count++;
          paymentBuckets[bucket].amount += revenue;
        }

        // Service type
        const svcType = normalizeServiceType(order);
        serviceBuckets[svcType].count++;
        serviceBuckets[svcType].amount += revenue;

        // Daily trend
        const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
        if (orderDate) {
          const dayKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}-${String(orderDate.getDate()).padStart(2, '0')}`;
          if (!dailyMap[dayKey]) dailyMap[dayKey] = { date: dayKey, revenue: 0, orderCount: 0 };
          dailyMap[dayKey].revenue += revenue;
          dailyMap[dayKey].orderCount++;

          // Peak hours
          const hour = orderDate.getHours();
          const hourKey = `${String(hour).padStart(2, '0')}:00`;
          if (!hourMap[hourKey]) hourMap[hourKey] = { hour: hourKey, orderCount: 0, revenue: 0 };
          hourMap[hourKey].orderCount++;
          hourMap[hourKey].revenue += revenue;
        }
      });

      outletResults.push({
        outletId: outlet.id,
        outletName: outlet.name,
        revenue: Math.round(outletRevenue * 100) / 100,
        orderCount: outletOrders,
        avgTicketSize: outletOrders > 0 ? Math.round((outletRevenue / outletOrders) * 100) / 100 : 0,
      });
    });

    await Promise.all(outletPromises);

    const round = v => Math.round(v * 100) / 100;
    const paymentBreakdown = Object.entries(paymentBuckets).map(([method, d]) => ({
      method, count: d.count, amount: round(d.amount), percentage: totalRevenue > 0 ? round((d.amount / totalRevenue) * 100) : 0,
    })).filter(p => p.count > 0 || p.amount > 0);

    const serviceTypeBreakdown = Object.entries(serviceBuckets).map(([type, d]) => ({
      type, count: d.count, amount: round(d.amount), percentage: totalRevenue > 0 ? round((d.amount / totalRevenue) * 100) : 0,
    })).filter(s => s.count > 0);

    const dailyTrend = Object.values(dailyMap).map(d => ({ ...d, revenue: round(d.revenue) })).sort((a, b) => a.date.localeCompare(b.date));
    const peakHours = Object.values(hourMap).map(h => ({ ...h, revenue: round(h.revenue) })).sort((a, b) => b.orderCount - a.orderCount).slice(0, 8);
    outletResults.sort((a, b) => b.revenue - a.revenue);

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      summary: { totalRevenue: round(totalRevenue), totalOrders, avgTicketSize: totalOrders > 0 ? round(totalRevenue / totalOrders) : 0, totalTips: round(totalTips), totalServiceCharge: round(totalServiceCharge) },
      paymentBreakdown,
      serviceTypeBreakdown,
      dailyTrend,
      peakHours,
      outletBreakdown: outletResults,
    });
  } catch (error) {
    console.error('Sales summary error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate sales summary' });
  }
});

// ═══════════════════════════════════════════════
//  9. GET /:orgId/staff-performance
//     Per-staff sales, orders, tips
// ═══════════════════════════════════════════════
router.get('/:orgId/staff-performance', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    const staffMap = {};
    const outletStaffMap = {};

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);
      outletStaffMap[outlet.id] = { outletId: outlet.id, outletName: outlet.name, staff: {} };

      orders.forEach(order => {
        const staffId = order.waiterId || order.staffId || order.createdBy || 'unknown';
        const staffName = order.waiterName || order.staffName || order.createdByName || 'Unknown Staff';
        const revenue = getOrderRevenue(order);
        const tip = Number(order.tipAmount) || 0;

        if (!staffMap[staffId]) {
          staffMap[staffId] = { staffId, staffName, ordersHandled: 0, totalSales: 0, tipsEarned: 0, outlets: new Set() };
        }
        staffMap[staffId].ordersHandled++;
        staffMap[staffId].totalSales += revenue;
        staffMap[staffId].tipsEarned += tip;
        staffMap[staffId].outlets.add(outlet.name);

        if (!outletStaffMap[outlet.id].staff[staffId]) {
          outletStaffMap[outlet.id].staff[staffId] = { staffId, staffName, ordersHandled: 0, totalSales: 0, tipsEarned: 0 };
        }
        outletStaffMap[outlet.id].staff[staffId].ordersHandled++;
        outletStaffMap[outlet.id].staff[staffId].totalSales += revenue;
        outletStaffMap[outlet.id].staff[staffId].tipsEarned += tip;
      });
    });

    await Promise.all(outletPromises);

    const round = v => Math.round(v * 100) / 100;
    const staffRankings = Object.values(staffMap)
      .filter(s => s.staffId !== 'unknown')
      .map(s => ({
        staffId: s.staffId,
        staffName: s.staffName,
        ordersHandled: s.ordersHandled,
        totalSales: round(s.totalSales),
        avgTicketSize: s.ordersHandled > 0 ? round(s.totalSales / s.ordersHandled) : 0,
        tipsEarned: round(s.tipsEarned),
        outlets: Array.from(s.outlets),
      }))
      .sort((a, b) => b.totalSales - a.totalSales)
      .map((s, idx) => ({ rank: idx + 1, ...s }));

    const outletBreakdown = Object.values(outletStaffMap).map(o => ({
      outletId: o.outletId,
      outletName: o.outletName,
      staff: Object.values(o.staff).map(s => ({
        ...s, totalSales: round(s.totalSales), avgTicketSize: s.ordersHandled > 0 ? round(s.totalSales / s.ordersHandled) : 0, tipsEarned: round(s.tipsEarned),
      })).sort((a, b) => b.totalSales - a.totalSales),
    }));

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalStaff: staffRankings.length,
      staffRankings,
      outletBreakdown,
    });
  } catch (error) {
    console.error('Staff performance error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate staff performance report' });
  }
});

// ═══════════════════════════════════════════════
//  10. GET /:orgId/category-sales
//      Revenue by menu category
// ═══════════════════════════════════════════════
router.get('/:orgId/category-sales', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    const categoryMap = {};

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);

      orders.forEach(order => {
        const items = order.items || order.cartItems || [];
        items.forEach(item => {
          const category = item.category || item.menuCategory || 'Uncategorized';
          const qty = Number(item.quantity) || Number(item.qty) || 1;
          const price = Number(item.price) || Number(item.itemPrice) || 0;
          const itemRevenue = qty * price;
          const itemName = item.name || item.itemName || 'Unknown';

          if (!categoryMap[category]) {
            categoryMap[category] = { category, totalQuantity: 0, totalRevenue: 0, uniqueItems: new Set(), outletMap: {} };
          }
          categoryMap[category].totalQuantity += qty;
          categoryMap[category].totalRevenue += itemRevenue;
          categoryMap[category].uniqueItems.add(itemName);

          if (!categoryMap[category].outletMap[outlet.id]) {
            categoryMap[category].outletMap[outlet.id] = { outletId: outlet.id, outletName: outlet.name, quantity: 0, revenue: 0 };
          }
          categoryMap[category].outletMap[outlet.id].quantity += qty;
          categoryMap[category].outletMap[outlet.id].revenue += itemRevenue;
        });
      });
    });

    await Promise.all(outletPromises);

    const round = v => Math.round(v * 100) / 100;
    const grandTotal = Object.values(categoryMap).reduce((s, c) => s + c.totalRevenue, 0);

    const categories = Object.values(categoryMap)
      .map(c => ({
        category: c.category,
        totalQuantity: c.totalQuantity,
        totalRevenue: round(c.totalRevenue),
        revenuePercentage: grandTotal > 0 ? round((c.totalRevenue / grandTotal) * 100) : 0,
        uniqueItems: c.uniqueItems.size,
        outletBreakdown: Object.values(c.outletMap).map(o => ({ ...o, revenue: round(o.revenue) })),
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalCategories: categories.length,
      categories,
    });
  } catch (error) {
    console.error('Category sales error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate category sales report' });
  }
});

// ═══════════════════════════════════════════════
//  11. GET /:orgId/discount-report
//      Discount usage and impact analysis
// ═══════════════════════════════════════════════
router.get('/:orgId/discount-report', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    let totalDiscountGiven = 0, discountedOrderCount = 0, nonDiscountedOrderCount = 0;
    let discountedRevenue = 0, nonDiscountedRevenue = 0;
    const sourceMap = {};
    const outletResults = [];

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);
      let outletDiscount = 0, outletDiscounted = 0;

      orders.forEach(order => {
        const revenue = getOrderRevenue(order);
        const discount = Number(order.discountAmount) || 0;
        const manualDiscount = Number(order.manualDiscount) || 0;
        const loyaltyDiscount = Number(order.loyaltyDiscount) || 0;
        const totalDiscount = discount + manualDiscount + loyaltyDiscount;

        if (totalDiscount > 0) {
          discountedOrderCount++;
          outletDiscounted++;
          discountedRevenue += revenue;
          totalDiscountGiven += totalDiscount;
          outletDiscount += totalDiscount;

          // Track by source
          if (discount > 0) {
            const offerName = order.selectedOfferName || order.appliedOffer || 'Offer Discount';
            if (!sourceMap[offerName]) sourceMap[offerName] = { source: 'offer', name: offerName, count: 0, totalDiscount: 0 };
            sourceMap[offerName].count++;
            sourceMap[offerName].totalDiscount += discount;
          }
          if (manualDiscount > 0) {
            if (!sourceMap['__manual']) sourceMap['__manual'] = { source: 'manual', name: 'Manual Discount', count: 0, totalDiscount: 0 };
            sourceMap['__manual'].count++;
            sourceMap['__manual'].totalDiscount += manualDiscount;
          }
          if (loyaltyDiscount > 0) {
            if (!sourceMap['__loyalty']) sourceMap['__loyalty'] = { source: 'loyalty', name: 'Loyalty Discount', count: 0, totalDiscount: 0 };
            sourceMap['__loyalty'].count++;
            sourceMap['__loyalty'].totalDiscount += loyaltyDiscount;
          }
        } else {
          nonDiscountedOrderCount++;
          nonDiscountedRevenue += revenue;
        }
      });

      outletResults.push({
        outletId: outlet.id,
        outletName: outlet.name,
        totalDiscount: Math.round(outletDiscount * 100) / 100,
        discountedOrders: outletDiscounted,
        totalOrders: orders.length,
      });
    });

    await Promise.all(outletPromises);

    const round = v => Math.round(v * 100) / 100;
    const totalOrders = discountedOrderCount + nonDiscountedOrderCount;

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      summary: {
        totalDiscountGiven: round(totalDiscountGiven),
        discountedOrderCount,
        nonDiscountedOrderCount,
        discountedOrderPercentage: totalOrders > 0 ? round((discountedOrderCount / totalOrders) * 100) : 0,
        avgTicketWithDiscount: discountedOrderCount > 0 ? round(discountedRevenue / discountedOrderCount) : 0,
        avgTicketWithoutDiscount: nonDiscountedOrderCount > 0 ? round(nonDiscountedRevenue / nonDiscountedOrderCount) : 0,
      },
      discountSourceBreakdown: Object.values(sourceMap).map(s => ({ ...s, totalDiscount: round(s.totalDiscount) })).sort((a, b) => b.totalDiscount - a.totalDiscount),
      outletBreakdown: outletResults,
    });
  } catch (error) {
    console.error('Discount report error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate discount report' });
  }
});

// ═══════════════════════════════════════════════
//  12. GET /:orgId/tax-summary
//      Tax collected, breakdown, monthly trend
// ═══════════════════════════════════════════════
router.get('/:orgId/tax-summary', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    let totalTaxCollected = 0, totalTaxableAmount = 0, totalNonTaxableOrders = 0, totalOrdersWithTax = 0;
    const taxTypeMap = {};
    const monthlyMap = {};
    const outletResults = [];

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);
      let outletTax = 0, outletTaxable = 0;

      orders.forEach(order => {
        const taxAmount = Number(order.taxAmount) || 0;
        const subtotal = Number(order.subtotal) || Number(order.totalBeforeTax) || getOrderRevenue(order);

        if (taxAmount > 0) {
          totalTaxCollected += taxAmount;
          outletTax += taxAmount;
          totalTaxableAmount += subtotal;
          outletTaxable += subtotal;
          totalOrdersWithTax++;

          // Tax type breakdown
          if (order.taxBreakdown && Array.isArray(order.taxBreakdown)) {
            order.taxBreakdown.forEach(tb => {
              const taxName = tb.name || tb.taxName || 'Tax';
              const rate = tb.rate || tb.taxRate || 0;
              const key = `${taxName}_${rate}`;
              if (!taxTypeMap[key]) taxTypeMap[key] = { taxName, rate, totalAmount: 0, orderCount: 0 };
              taxTypeMap[key].totalAmount += Number(tb.amount) || 0;
              taxTypeMap[key].orderCount++;
            });
          } else if (order.taxes && Array.isArray(order.taxes)) {
            order.taxes.forEach(tb => {
              const taxName = tb.name || tb.taxName || 'Tax';
              const rate = tb.rate || tb.taxRate || 0;
              const key = `${taxName}_${rate}`;
              if (!taxTypeMap[key]) taxTypeMap[key] = { taxName, rate, totalAmount: 0, orderCount: 0 };
              taxTypeMap[key].totalAmount += Number(tb.amount) || Number(tb.taxAmount) || 0;
              taxTypeMap[key].orderCount++;
            });
          } else {
            if (!taxTypeMap['Tax_0']) taxTypeMap['Tax_0'] = { taxName: 'Tax', rate: 0, totalAmount: 0, orderCount: 0 };
            taxTypeMap['Tax_0'].totalAmount += taxAmount;
            taxTypeMap['Tax_0'].orderCount++;
          }
        } else {
          totalNonTaxableOrders++;
        }

        // Monthly trend
        const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
        if (orderDate && taxAmount > 0) {
          const monthKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}`;
          if (!monthlyMap[monthKey]) monthlyMap[monthKey] = { month: monthKey, taxCollected: 0, orderCount: 0 };
          monthlyMap[monthKey].taxCollected += taxAmount;
          monthlyMap[monthKey].orderCount++;
        }
      });

      outletResults.push({
        outletId: outlet.id,
        outletName: outlet.name,
        totalTax: Math.round(outletTax * 100) / 100,
        taxableAmount: Math.round(outletTaxable * 100) / 100,
        orderCount: orders.length,
      });
    });

    await Promise.all(outletPromises);

    const round = v => Math.round(v * 100) / 100;

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      summary: {
        totalTaxCollected: round(totalTaxCollected),
        totalTaxableAmount: round(totalTaxableAmount),
        totalNonTaxableOrders,
        avgTaxPerOrder: totalOrdersWithTax > 0 ? round(totalTaxCollected / totalOrdersWithTax) : 0,
      },
      taxBreakdown: Object.values(taxTypeMap).map(t => ({ ...t, totalAmount: round(t.totalAmount) })).sort((a, b) => b.totalAmount - a.totalAmount),
      monthlyTrend: Object.values(monthlyMap).map(m => ({ ...m, taxCollected: round(m.taxCollected) })).sort((a, b) => a.month.localeCompare(b.month)),
      outletBreakdown: outletResults,
    });
  } catch (error) {
    console.error('Tax summary error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate tax summary' });
  }
});

// ═══════════════════════════════════════════════
//  13. GET /:orgId/customer-insights
//      Customer analysis with privacy masking
// ═══════════════════════════════════════════════
router.get('/:orgId/customer-insights', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    const customerMap = {};
    let anonymousOrders = 0;
    const outletResults = [];

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);
      const outletCustomers = new Set();
      let outletNew = 0;

      orders.forEach(order => {
        const phone = order.customerInfo?.phone || order.customerInfo?.mobile || order.customerPhone;
        if (!phone) {
          anonymousOrders++;
          return;
        }

        const key = String(phone).replace(/\D/g, '').slice(-10); // normalize to last 10 digits
        if (!customerMap[key]) {
          customerMap[key] = {
            phone: key,
            name: order.customerInfo?.name || order.customerName || '',
            visitCount: 0,
            totalSpend: 0,
            firstVisit: null,
            lastVisit: null,
            outlets: new Set(),
          };
        }

        customerMap[key].visitCount++;
        customerMap[key].totalSpend += getOrderRevenue(order);
        customerMap[key].outlets.add(outlet.name);
        if (!customerMap[key].name && (order.customerInfo?.name || order.customerName)) {
          customerMap[key].name = order.customerInfo?.name || order.customerName;
        }

        const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
        if (orderDate) {
          if (!customerMap[key].firstVisit || orderDate < customerMap[key].firstVisit) customerMap[key].firstVisit = orderDate;
          if (!customerMap[key].lastVisit || orderDate > customerMap[key].lastVisit) customerMap[key].lastVisit = orderDate;
        }

        outletCustomers.add(key);
      });

      // Count new vs returning per outlet
      let outletReturning = 0;
      outletCustomers.forEach(k => {
        if (customerMap[k].visitCount === 1) outletNew++;
        else outletReturning++;
      });

      outletResults.push({
        outletId: outlet.id,
        outletName: outlet.name,
        totalCustomers: outletCustomers.size,
        // Note: new/returning counts will be recalculated after all outlets
      });
    });

    await Promise.all(outletPromises);

    const round = v => Math.round(v * 100) / 100;
    const allCustomers = Object.values(customerMap);
    const newCustomers = allCustomers.filter(c => c.visitCount === 1).length;
    const returningCustomers = allCustomers.filter(c => c.visitCount > 1).length;
    const totalSpendAll = allCustomers.reduce((s, c) => s + c.totalSpend, 0);

    // Mask phone numbers and build top customers
    const topCustomers = allCustomers
      .sort((a, b) => b.totalSpend - a.totalSpend)
      .slice(0, 20)
      .map((c, idx) => ({
        rank: idx + 1,
        name: c.name || 'Guest',
        phone: c.phone.length >= 4 ? '****' + c.phone.slice(-4) : '****',
        visitCount: c.visitCount,
        totalSpend: round(c.totalSpend),
        avgOrderValue: c.visitCount > 0 ? round(c.totalSpend / c.visitCount) : 0,
        lastVisit: c.lastVisit ? c.lastVisit.toISOString() : null,
      }));

    // Recalculate outlet new/returning based on global counts
    const outletBreakdown = outletResults.map(o => ({
      ...o,
      newCustomers: 0,  // Simplified: per-outlet new/returning requires cross-referencing
      returningCustomers: 0,
    }));

    return res.json({
      success: true,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      summary: {
        totalCustomers: allCustomers.length,
        newCustomers,
        returningCustomers,
        anonymousOrders,
        avgLifetimeValue: allCustomers.length > 0 ? round(totalSpendAll / allCustomers.length) : 0,
        avgVisitFrequency: allCustomers.length > 0 ? round(allCustomers.reduce((s, c) => s + c.visitCount, 0) / allCustomers.length) : 0,
      },
      topCustomers,
      outletBreakdown,
    });
  } catch (error) {
    console.error('Customer insights error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to generate customer insights' });
  }
});

// ═══════════════════════════════════════════════
//  14. GET /:orgId/export/:reportType
//     CSV export for reports
// ═══════════════════════════════════════════════
router.get('/:orgId/export/:reportType', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId, reportType } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);

    let csvContent = '';
    let filename = '';

    switch (reportType) {
      case 'inventory': {
        filename = `inventory-comparison-${orgId}.csv`;

        // Build inventory data
        const inventoryByOutlet = {};
        const allItemNames = new Set();

        const invPromises = outlets.map(async (outlet) => {
          const snapshot = await db.collection(collections.inventory)
            .where('restaurantId', '==', outlet.id)
            .get();

          const items = [];
          snapshot.forEach(doc => {
            const data = doc.data();
            const itemName = data.name || data.itemName || 'Unnamed Item';
            allItemNames.add(itemName);
            items.push({
              name: itemName,
              currentStock: Number(data.currentStock) || Number(data.quantity) || 0,
              unit: data.unit || ''
            });
          });
          inventoryByOutlet[outlet.id] = items;
        });

        await Promise.all(invPromises);

        const sortedNames = Array.from(allItemNames).sort();

        // Header: Item Name, Outlet1 Stock, Outlet1 Unit, Outlet2 Stock, ...
        const headerParts = ['Item Name'];
        outlets.forEach(o => {
          headerParts.push(`${escapeCsvField(o.name)} Stock`);
          headerParts.push(`${escapeCsvField(o.name)} Unit`);
        });
        csvContent += headerParts.join(',') + '\n';

        sortedNames.forEach(itemName => {
          const rowParts = [escapeCsvField(itemName)];
          outlets.forEach(outlet => {
            const outletItems = inventoryByOutlet[outlet.id] || [];
            const match = outletItems.find(i => i.name === itemName);
            rowParts.push(match ? String(match.currentStock) : '0');
            rowParts.push(match ? escapeCsvField(match.unit) : '');
          });
          csvContent += rowParts.join(',') + '\n';
        });

        break;
      }

      case 'pl': {
        filename = `consolidated-pl-${orgId}.csv`;
        csvContent += 'Outlet Name,Outlet Type,Total Revenue,Total Expenses,Gross Profit,Order Count,Expense Count\n';

        let grandRevenue = 0;
        let grandExpenses = 0;

        const plPromises = outlets.map(async (outlet) => {
          const [orders, expenses] = await Promise.all([
            getOutletOrders(outlet.id, startDate, endDate),
            getOutletExpenses(outlet.id, startDate, endDate)
          ]);

          const revenue = orders.reduce((sum, o) => sum + getOrderRevenue(o), 0);
          const expenseTotal = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
          return {
            name: outlet.name,
            outletType: outlet.outletType,
            revenue: Math.round(revenue * 100) / 100,
            expenses: Math.round(expenseTotal * 100) / 100,
            profit: Math.round((revenue - expenseTotal) * 100) / 100,
            orderCount: orders.length,
            expenseCount: expenses.length
          };
        });

        const plResults = await Promise.all(plPromises);
        plResults.sort((a, b) => b.revenue - a.revenue);

        plResults.forEach(r => {
          grandRevenue += r.revenue;
          grandExpenses += r.expenses;
          csvContent += `${escapeCsvField(r.name)},${escapeCsvField(r.outletType)},${r.revenue},${r.expenses},${r.profit},${r.orderCount},${r.expenseCount}\n`;
        });

        csvContent += `\nTotal,,${Math.round(grandRevenue * 100) / 100},${Math.round(grandExpenses * 100) / 100},${Math.round((grandRevenue - grandExpenses) * 100) / 100},,\n`;

        break;
      }

      case 'indents': {
        filename = `indent-tracking-${orgId}.csv`;
        csvContent += 'Indent Number,Status,Requesting Outlet,Warehouse,Priority,Item Count,Requested At\n';

        const outletMap = {};
        outlets.forEach(o => { outletMap[o.id] = o.name; });

        const indentSnapshot = await db.collection(collections.indentRequests)
          .where('organizationId', '==', orgId)
          .get();

        const indents = [];
        indentSnapshot.forEach(doc => {
          indents.push({ id: doc.id, ...doc.data() });
        });

        // Sort by date descending
        indents.sort((a, b) => {
          const dateA = a.requestedAt || a.createdAt;
          const dateB = b.requestedAt || b.createdAt;
          const tA = dateA ? (dateA.toDate ? dateA.toDate() : new Date(dateA)).getTime() : 0;
          const tB = dateB ? (dateB.toDate ? dateB.toDate() : new Date(dateB)).getTime() : 0;
          return tB - tA;
        });

        indents.forEach(indent => {
          const reqAt = indent.requestedAt || indent.createdAt;
          const dateStr = reqAt ? (reqAt.toDate ? reqAt.toDate() : new Date(reqAt)).toISOString() : '';
          csvContent += `${escapeCsvField(indent.indentNumber || indent.id)},${escapeCsvField(indent.status || 'unknown')},${escapeCsvField(outletMap[indent.requestingOutletId] || 'Unknown')},${escapeCsvField(outletMap[indent.warehouseId] || 'Unknown')},${escapeCsvField(indent.priority || 'medium')},${(indent.items || []).length},${dateStr}\n`;
        });

        break;
      }

      case 'outlet-ranking': {
        filename = `outlet-ranking-${orgId}.csv`;
        csvContent += 'Rank,Outlet Name,Outlet Type,Total Revenue,Total Orders,Avg Ticket Size\n';

        const rankPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          const totalRevenue = orders.reduce((sum, o) => sum + getOrderRevenue(o), 0);
          const totalOrders = orders.length;
          const avgTicket = totalOrders > 0 ? totalRevenue / totalOrders : 0;
          return {
            name: outlet.name,
            outletType: outlet.outletType,
            totalRevenue: Math.round(totalRevenue * 100) / 100,
            totalOrders,
            avgTicketSize: Math.round(avgTicket * 100) / 100
          };
        });

        const rankResults = await Promise.all(rankPromises);
        rankResults.sort((a, b) => b.totalRevenue - a.totalRevenue);

        rankResults.forEach((r, idx) => {
          csvContent += `${idx + 1},${escapeCsvField(r.name)},${escapeCsvField(r.outletType)},${r.totalRevenue},${r.totalOrders},${r.avgTicketSize}\n`;
        });

        break;
      }

      case 'sales-summary': {
        filename = `sales-summary-${orgId}.csv`;
        csvContent += 'Outlet Name,Revenue,Orders,Avg Ticket,Cash,Card,UPI,Aggregator,Other\n';
        const ssPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          const rev = orders.reduce((s, o) => s + getOrderRevenue(o), 0);
          const pm = { cash: 0, card: 0, upi: 0, aggregator: 0, other: 0 };
          orders.forEach(o => {
            const amount = getOrderRevenue(o);
            if (o.splitPayments && Array.isArray(o.splitPayments) && o.splitPayments.length > 0) {
              o.splitPayments.forEach(sp => { pm[normalizePaymentMethod(sp.method || sp.paymentMethod, o)] += Number(sp.amount) || 0; });
            } else {
              pm[normalizePaymentMethod(o.paymentMethod, o)] += amount;
            }
          });
          return { name: outlet.name, rev: Math.round(rev * 100) / 100, orders: orders.length, avg: orders.length > 0 ? Math.round((rev / orders.length) * 100) / 100 : 0, ...Object.fromEntries(Object.entries(pm).map(([k, v]) => [k, Math.round(v * 100) / 100])) };
        });
        const ssResults = await Promise.all(ssPromises);
        ssResults.sort((a, b) => b.rev - a.rev);
        ssResults.forEach(r => { csvContent += `${escapeCsvField(r.name)},${r.rev},${r.orders},${r.avg},${r.cash},${r.card},${r.upi},${r.aggregator},${r.other}\n`; });
        break;
      }

      case 'staff-performance': {
        filename = `staff-performance-${orgId}.csv`;
        csvContent += 'Rank,Staff Name,Outlet(s),Orders,Total Sales,Avg Ticket,Tips\n';
        const spStaffMap = {};
        const spPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          orders.forEach(order => {
            const sid = order.waiterId || order.staffId || order.createdBy || 'unknown';
            const sname = order.waiterName || order.staffName || order.createdByName || 'Unknown';
            if (!spStaffMap[sid]) spStaffMap[sid] = { name: sname, orders: 0, sales: 0, tips: 0, outlets: new Set() };
            spStaffMap[sid].orders++;
            spStaffMap[sid].sales += getOrderRevenue(order);
            spStaffMap[sid].tips += Number(order.tipAmount) || 0;
            spStaffMap[sid].outlets.add(outlet.name);
          });
        });
        await Promise.all(spPromises);
        const spArr = Object.entries(spStaffMap).filter(([k]) => k !== 'unknown').map(([, v]) => v).sort((a, b) => b.sales - a.sales);
        spArr.forEach((s, i) => { csvContent += `${i + 1},${escapeCsvField(s.name)},${escapeCsvField(Array.from(s.outlets).join('; '))},${s.orders},${Math.round(s.sales * 100) / 100},${s.orders > 0 ? Math.round((s.sales / s.orders) * 100) / 100 : 0},${Math.round(s.tips * 100) / 100}\n`; });
        break;
      }

      case 'category-sales': {
        filename = `category-sales-${orgId}.csv`;
        csvContent += 'Category,Qty Sold,Revenue,% of Revenue,Unique Items\n';
        const csMap = {};
        const csPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          orders.forEach(order => {
            (order.items || order.cartItems || []).forEach(item => {
              const cat = item.category || item.menuCategory || 'Uncategorized';
              const qty = Number(item.quantity) || Number(item.qty) || 1;
              const rev = qty * (Number(item.price) || Number(item.itemPrice) || 0);
              if (!csMap[cat]) csMap[cat] = { qty: 0, rev: 0, items: new Set() };
              csMap[cat].qty += qty;
              csMap[cat].rev += rev;
              csMap[cat].items.add(item.name || item.itemName || 'Unknown');
            });
          });
        });
        await Promise.all(csPromises);
        const csTotal = Object.values(csMap).reduce((s, c) => s + c.rev, 0);
        const csArr = Object.entries(csMap).sort((a, b) => b[1].rev - a[1].rev);
        csArr.forEach(([cat, d]) => { csvContent += `${escapeCsvField(cat)},${d.qty},${Math.round(d.rev * 100) / 100},${csTotal > 0 ? Math.round((d.rev / csTotal) * 100 * 100) / 100 : 0},${d.items.size}\n`; });
        break;
      }

      case 'discount-report': {
        filename = `discount-report-${orgId}.csv`;
        csvContent += 'Outlet Name,Total Discount,Discounted Orders,Total Orders,Avg Ticket (Discounted),Avg Ticket (Non-Discounted)\n';
        const drPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          let disc = 0, dCount = 0, dRev = 0, ndCount = 0, ndRev = 0;
          orders.forEach(o => {
            const td = (Number(o.discountAmount) || 0) + (Number(o.manualDiscount) || 0) + (Number(o.loyaltyDiscount) || 0);
            const rev = getOrderRevenue(o);
            if (td > 0) { disc += td; dCount++; dRev += rev; } else { ndCount++; ndRev += rev; }
          });
          return { name: outlet.name, disc: Math.round(disc * 100) / 100, dCount, total: orders.length, dAvg: dCount > 0 ? Math.round((dRev / dCount) * 100) / 100 : 0, ndAvg: ndCount > 0 ? Math.round((ndRev / ndCount) * 100) / 100 : 0 };
        });
        const drResults = await Promise.all(drPromises);
        drResults.forEach(r => { csvContent += `${escapeCsvField(r.name)},${r.disc},${r.dCount},${r.total},${r.dAvg},${r.ndAvg}\n`; });
        break;
      }

      case 'tax-summary': {
        filename = `tax-summary-${orgId}.csv`;
        csvContent += 'Outlet Name,Total Tax,Taxable Amount,Orders\n';
        const tsPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          let tax = 0, taxable = 0;
          orders.forEach(o => { tax += Number(o.taxAmount) || 0; taxable += Number(o.subtotal) || Number(o.totalBeforeTax) || getOrderRevenue(o); });
          return { name: outlet.name, tax: Math.round(tax * 100) / 100, taxable: Math.round(taxable * 100) / 100, orders: orders.length };
        });
        const tsResults = await Promise.all(tsPromises);
        tsResults.forEach(r => { csvContent += `${escapeCsvField(r.name)},${r.tax},${r.taxable},${r.orders}\n`; });
        break;
      }

      case 'customer-insights': {
        filename = `customer-insights-${orgId}.csv`;
        csvContent += 'Rank,Name,Phone,Visits,Total Spend,Avg Order,Last Visit\n';
        const ciMap = {};
        const ciPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          orders.forEach(o => {
            const ph = o.customerInfo?.phone || o.customerInfo?.mobile || o.customerPhone;
            if (!ph) return;
            const key = String(ph).replace(/\D/g, '').slice(-10);
            if (!ciMap[key]) ciMap[key] = { name: '', phone: key, visits: 0, spend: 0, last: null };
            ciMap[key].visits++;
            ciMap[key].spend += getOrderRevenue(o);
            if (!ciMap[key].name) ciMap[key].name = o.customerInfo?.name || o.customerName || '';
            const d = o.createdAt ? (o.createdAt.toDate ? o.createdAt.toDate() : new Date(o.createdAt)) : null;
            if (d && (!ciMap[key].last || d > ciMap[key].last)) ciMap[key].last = d;
          });
        });
        await Promise.all(ciPromises);
        const ciArr = Object.values(ciMap).sort((a, b) => b.spend - a.spend).slice(0, 50);
        ciArr.forEach((c, i) => {
          const masked = c.phone.length >= 4 ? '****' + c.phone.slice(-4) : '****';
          csvContent += `${i + 1},${escapeCsvField(c.name || 'Guest')},${masked},${c.visits},${Math.round(c.spend * 100) / 100},${c.visits > 0 ? Math.round((c.spend / c.visits) * 100) / 100 : 0},${c.last ? c.last.toISOString().split('T')[0] : ''}\n`;
        });
        break;
      }

      case 'payment-analytics': {
        filename = `payment-analytics-${orgId}.csv`;
        csvContent += 'Payment Method,Transactions,Amount,Percentage,Avg Value\n';
        const paMethodMap = {};
        let paTotalRevenue = 0;
        const paPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          orders.forEach(order => {
            const revenue = getOrderRevenue(order);
            paTotalRevenue += revenue;
            if (order.splitPayments && Array.isArray(order.splitPayments) && order.splitPayments.length > 0) {
              order.splitPayments.forEach(sp => {
                const method = normalizePaymentMethod(sp.method || sp.paymentMethod, order);
                const amount = Number(sp.amount) || 0;
                if (!paMethodMap[method]) paMethodMap[method] = { count: 0, amount: 0 };
                paMethodMap[method].count++;
                paMethodMap[method].amount += amount;
              });
            } else {
              const method = normalizePaymentMethod(order.paymentMethod, order);
              if (!paMethodMap[method]) paMethodMap[method] = { count: 0, amount: 0 };
              paMethodMap[method].count++;
              paMethodMap[method].amount += revenue;
            }
          });
        });
        await Promise.all(paPromises);
        Object.entries(paMethodMap).sort((a, b) => b[1].amount - a[1].amount).forEach(([method, d]) => {
          const pct = paTotalRevenue > 0 ? Math.round((d.amount / paTotalRevenue) * 100 * 100) / 100 : 0;
          const avg = d.count > 0 ? Math.round((d.amount / d.count) * 100) / 100 : 0;
          csvContent += `${escapeCsvField(method)},${d.count},${Math.round(d.amount * 100) / 100},${pct},${avg}\n`;
        });
        break;
      }

      case 'order-analytics': {
        filename = `order-analytics-${orgId}.csv`;
        csvContent += 'Date,Orders,Revenue,Avg Value\n';
        const oaDailyMap = {};
        const oaPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          orders.forEach(order => {
            const revenue = getOrderRevenue(order);
            const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
            if (orderDate) {
              const dayKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}-${String(orderDate.getDate()).padStart(2, '0')}`;
              if (!oaDailyMap[dayKey]) oaDailyMap[dayKey] = { orderCount: 0, revenue: 0 };
              oaDailyMap[dayKey].orderCount++;
              oaDailyMap[dayKey].revenue += revenue;
            }
          });
        });
        await Promise.all(oaPromises);
        Object.entries(oaDailyMap).sort(([a], [b]) => a.localeCompare(b)).forEach(([date, d]) => {
          const avg = d.orderCount > 0 ? Math.round((d.revenue / d.orderCount) * 100) / 100 : 0;
          csvContent += `${date},${d.orderCount},${Math.round(d.revenue * 100) / 100},${avg}\n`;
        });
        break;
      }

      case 'revenue-trends': {
        filename = `revenue-trends-${orgId}.csv`;
        csvContent += 'Date,Revenue,Orders,Avg Value\n';
        const rtDailyMap = {};
        const rtPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          orders.forEach(order => {
            const revenue = getOrderRevenue(order);
            const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
            if (orderDate) {
              const dayKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}-${String(orderDate.getDate()).padStart(2, '0')}`;
              if (!rtDailyMap[dayKey]) rtDailyMap[dayKey] = { revenue: 0, orderCount: 0 };
              rtDailyMap[dayKey].revenue += revenue;
              rtDailyMap[dayKey].orderCount++;
            }
          });
        });
        await Promise.all(rtPromises);
        Object.entries(rtDailyMap).sort(([a], [b]) => a.localeCompare(b)).forEach(([date, d]) => {
          const avg = d.orderCount > 0 ? Math.round((d.revenue / d.orderCount) * 100) / 100 : 0;
          csvContent += `${date},${Math.round(d.revenue * 100) / 100},${d.orderCount},${avg}\n`;
        });
        break;
      }

      case 'wallet-loyalty': {
        filename = `wallet-loyalty-${orgId}.csv`;
        csvContent += 'Metric,Value\n';
        let wlWalletRedeemed = 0, wlLoyaltyIssued = 0, wlLoyaltyRedeemed = 0;
        let wlLoyaltyOrders = 0, wlWalletOrders = 0, wlTotalOrders = 0;
        const wlPromises = outlets.map(async (outlet) => {
          const orders = await getOutletOrders(outlet.id, startDate, endDate);
          orders.forEach(order => {
            wlTotalOrders++;
            const walletAmt = Number(order.walletRedeemAmount) || 0;
            const loyaltyEarned = Number(order.loyaltyPointsEarned) || 0;
            const loyaltyRedeemedAmt = Number(order.loyaltyPointsRedeemed) || 0;
            const loyaltyDisc = Number(order.loyaltyDiscount) || 0;
            if (walletAmt > 0) { wlWalletRedeemed += walletAmt; wlWalletOrders++; }
            wlLoyaltyIssued += loyaltyEarned;
            wlLoyaltyRedeemed += loyaltyRedeemedAmt;
            if (loyaltyEarned > 0 || loyaltyRedeemedAmt > 0 || loyaltyDisc > 0) wlLoyaltyOrders++;
          });
        });
        await Promise.all(wlPromises);
        csvContent += `Total Wallet Redeemed,${Math.round(wlWalletRedeemed * 100) / 100}\n`;
        csvContent += `Total Loyalty Points Issued,${Math.round(wlLoyaltyIssued * 100) / 100}\n`;
        csvContent += `Total Loyalty Points Redeemed,${Math.round(wlLoyaltyRedeemed * 100) / 100}\n`;
        csvContent += `Loyalty Order Count,${wlLoyaltyOrders}\n`;
        csvContent += `Wallet Order Count,${wlWalletOrders}\n`;
        csvContent += `Total Orders,${wlTotalOrders}\n`;
        csvContent += `Loyalty Order Percentage,${wlTotalOrders > 0 ? Math.round((wlLoyaltyOrders / wlTotalOrders) * 100 * 100) / 100 : 0}\n`;
        break;
      }

      default:
        return res.status(400).json({
          success: false,
          error: `Invalid report type: '${reportType}'. Valid types: inventory, pl, indents, outlet-ranking, sales-summary, staff-performance, category-sales, discount-report, tax-summary, customer-insights, payment-analytics, order-analytics, revenue-trends, wallet-loyalty`
        });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csvContent);
  } catch (error) {
    console.error('CSV export error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to export report as CSV' });
  }
});

// ─── Helper: Escape a field for CSV ──────────────────────────────────────────
function escapeCsvField(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ═══════════════════════════════════════════════
//  15. GET /:orgId/payment-analytics
//     Payment method breakdown & trends
// ═══════════════════════════════════════════════
router.get('/:orgId/payment-analytics', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);
    const round = v => Math.round(v * 100) / 100;

    const methodMap = {};
    const hourlyMap = {};
    const dailyMap = {};
    let totalTransactions = 0;
    let totalRevenue = 0;
    let splitPaymentCount = 0;

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);

      orders.forEach(order => {
        const revenue = getOrderRevenue(order);
        totalRevenue += revenue;
        totalTransactions++;

        const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
        const hourKey = orderDate ? `${String(orderDate.getHours()).padStart(2, '0')}:00` : null;
        const dayKey = orderDate ? `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}-${String(orderDate.getDate()).padStart(2, '0')}` : null;

        if (order.splitPayments && Array.isArray(order.splitPayments) && order.splitPayments.length > 0) {
          splitPaymentCount++;
          order.splitPayments.forEach(sp => {
            const method = normalizePaymentMethod(sp.method || sp.paymentMethod, order);
            const amount = Number(sp.amount) || 0;
            if (!methodMap[method]) methodMap[method] = { count: 0, amount: 0 };
            methodMap[method].count++;
            methodMap[method].amount += amount;

            if (hourKey) {
              if (!hourlyMap[hourKey]) hourlyMap[hourKey] = { cash: 0, card: 0, upi: 0, other: 0, total: 0 };
              hourlyMap[hourKey][method] = (hourlyMap[hourKey][method] || 0) + amount;
              hourlyMap[hourKey].total += amount;
            }
            if (dayKey) {
              if (!dailyMap[dayKey]) dailyMap[dayKey] = { cash: 0, card: 0, upi: 0, total: 0 };
              dailyMap[dayKey][method] = (dailyMap[dayKey][method] || 0) + amount;
              dailyMap[dayKey].total += amount;
            }
          });
        } else {
          const method = normalizePaymentMethod(order.paymentMethod, order);
          if (!methodMap[method]) methodMap[method] = { count: 0, amount: 0 };
          methodMap[method].count++;
          methodMap[method].amount += revenue;

          if (hourKey) {
            if (!hourlyMap[hourKey]) hourlyMap[hourKey] = { cash: 0, card: 0, upi: 0, other: 0, total: 0 };
            hourlyMap[hourKey][method] = (hourlyMap[hourKey][method] || 0) + revenue;
            hourlyMap[hourKey].total += revenue;
          }
          if (dayKey) {
            if (!dailyMap[dayKey]) dailyMap[dayKey] = { cash: 0, card: 0, upi: 0, total: 0 };
            dailyMap[dayKey][method] = (dailyMap[dayKey][method] || 0) + revenue;
            dailyMap[dayKey].total += revenue;
          }
        }
      });
    });

    await Promise.all(outletPromises);

    const methodBreakdown = Object.entries(methodMap).map(([method, d]) => ({
      method,
      count: d.count,
      amount: round(d.amount),
      percentage: totalRevenue > 0 ? round((d.amount / totalRevenue) * 100) : 0,
      avgValue: d.count > 0 ? round(d.amount / d.count) : 0,
    })).sort((a, b) => b.amount - a.amount);

    const hourlyTrend = Object.entries(hourlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, d]) => ({ hour, cash: round(d.cash || 0), card: round(d.card || 0), upi: round(d.upi || 0), other: round(d.other || 0), total: round(d.total) }));

    const dailyTrend = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, cash: round(d.cash || 0), card: round(d.card || 0), upi: round(d.upi || 0), total: round(d.total) }));

    return res.json({
      success: true,
      summary: {
        totalTransactions,
        totalRevenue: round(totalRevenue),
        avgTransactionValue: totalTransactions > 0 ? round(totalRevenue / totalTransactions) : 0,
        splitPaymentCount,
      },
      methodBreakdown,
      hourlyTrend,
      dailyTrend,
    });
  } catch (error) {
    console.error('Payment analytics error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch payment analytics' });
  }
});

// ═══════════════════════════════════════════════
//  16. GET /:orgId/order-analytics
//     Order volume, type & cancellation data
// ═══════════════════════════════════════════════
router.get('/:orgId/order-analytics', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);
    const round = v => Math.round(v * 100) / 100;

    const typeMap = {};
    const hourlyMap = {};
    const dailyMap = {};
    const dowMap = {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let totalOrders = 0;
    let totalRevenue = 0;
    let totalItems = 0;
    let cancelledCount = 0;

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);

      // Query cancelled orders separately
      const cancelledSnapshot = await db.collection(collections.orders)
        .where('restaurantId', '==', outlet.id)
        .where('status', '==', 'cancelled')
        .get();

      cancelledSnapshot.forEach(doc => {
        const data = doc.data();
        const orderDate = data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate() : new Date(data.createdAt)) : null;
        if (orderDate && orderDate >= startDate && orderDate <= endDate) {
          cancelledCount++;
        }
      });

      orders.forEach(order => {
        const revenue = getOrderRevenue(order);
        totalRevenue += revenue;
        totalOrders++;
        totalItems += (order.items || order.cartItems || []).length || Number(order.itemCount) || 0;

        const svcType = normalizeServiceType(order);
        if (!typeMap[svcType]) typeMap[svcType] = { count: 0, amount: 0 };
        typeMap[svcType].count++;
        typeMap[svcType].amount += revenue;

        const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
        if (orderDate) {
          const hourKey = `${String(orderDate.getHours()).padStart(2, '0')}:00`;
          if (!hourlyMap[hourKey]) hourlyMap[hourKey] = { orderCount: 0, revenue: 0 };
          hourlyMap[hourKey].orderCount++;
          hourlyMap[hourKey].revenue += revenue;

          const dayKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}-${String(orderDate.getDate()).padStart(2, '0')}`;
          if (!dailyMap[dayKey]) dailyMap[dayKey] = { orderCount: 0, revenue: 0 };
          dailyMap[dayKey].orderCount++;
          dailyMap[dayKey].revenue += revenue;

          const dow = dayNames[orderDate.getDay()];
          if (!dowMap[dow]) dowMap[dow] = { orderCount: 0, revenue: 0 };
          dowMap[dow].orderCount++;
          dowMap[dow].revenue += revenue;
        }
      });
    });

    await Promise.all(outletPromises);

    const allOrdersPlusCancelled = totalOrders + cancelledCount;

    const typeBreakdown = Object.entries(typeMap).map(([type, d]) => ({
      type,
      count: d.count,
      amount: round(d.amount),
      percentage: totalOrders > 0 ? round((d.count / totalOrders) * 100) : 0,
    })).sort((a, b) => b.count - a.count);

    const hourlyVolume = Object.entries(hourlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, d]) => ({ hour, orderCount: d.orderCount, revenue: round(d.revenue) }));

    const dailyVolume = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, orderCount: d.orderCount, revenue: round(d.revenue), avgValue: d.orderCount > 0 ? round(d.revenue / d.orderCount) : 0 }));

    const dayOfWeekAnalysis = dayNames.map(day => {
      const d = dowMap[day] || { orderCount: 0, revenue: 0 };
      return { day, orderCount: d.orderCount, revenue: round(d.revenue), avgValue: d.orderCount > 0 ? round(d.revenue / d.orderCount) : 0 };
    });

    return res.json({
      success: true,
      summary: {
        totalOrders,
        avgItemsPerOrder: totalOrders > 0 ? round(totalItems / totalOrders) : 0,
        cancellationRate: allOrdersPlusCancelled > 0 ? round((cancelledCount / allOrdersPlusCancelled) * 100) : 0,
        avgOrderValue: totalOrders > 0 ? round(totalRevenue / totalOrders) : 0,
      },
      typeBreakdown,
      hourlyVolume,
      dailyVolume,
      dayOfWeekAnalysis,
    });
  } catch (error) {
    console.error('Order analytics error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch order analytics' });
  }
});

// ═══════════════════════════════════════════════
//  17. GET /:orgId/revenue-trends
//     Revenue analysis with period comparison
// ═══════════════════════════════════════════════
router.get('/:orgId/revenue-trends', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);
    const round = v => Math.round(v * 100) / 100;

    // Calculate previous period (same duration before startDate)
    const periodMs = endDate.getTime() - startDate.getTime();
    const prevStartDate = new Date(startDate.getTime() - periodMs);
    const prevEndDate = new Date(startDate.getTime() - 1);
    prevEndDate.setHours(23, 59, 59, 999);

    const dailyMap = {};
    const dowMap = {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let totalRevenue = 0;
    let totalOrders = 0;
    const outletTrend = [];

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);
      const prevOrders = await getOutletOrders(outlet.id, prevStartDate, prevEndDate);

      let outletRevenue = 0;
      let outletPrevRevenue = 0;

      prevOrders.forEach(order => {
        outletPrevRevenue += getOrderRevenue(order);
      });

      orders.forEach(order => {
        const revenue = getOrderRevenue(order);
        totalRevenue += revenue;
        outletRevenue += revenue;
        totalOrders++;

        const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
        if (orderDate) {
          const dayKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}-${String(orderDate.getDate()).padStart(2, '0')}`;
          if (!dailyMap[dayKey]) dailyMap[dayKey] = { revenue: 0, orderCount: 0 };
          dailyMap[dayKey].revenue += revenue;
          dailyMap[dayKey].orderCount++;

          const dow = dayNames[orderDate.getDay()];
          if (!dowMap[dow]) dowMap[dow] = { totalRevenue: 0, totalOrders: 0, occurrences: new Set() };
          dowMap[dow].totalRevenue += revenue;
          dowMap[dow].totalOrders++;
          dowMap[dow].occurrences.add(dayKey);
        }
      });

      outletTrend.push({
        outletName: outlet.name,
        revenue: round(outletRevenue),
        previousRevenue: round(outletPrevRevenue),
        growth: outletPrevRevenue > 0 ? round(((outletRevenue - outletPrevRevenue) / outletPrevRevenue) * 100) : 0,
      });
    });

    await Promise.all(outletPromises);

    // Previous period total
    let previousPeriodRevenue = outletTrend.reduce((sum, o) => sum + o.previousRevenue, 0);

    const dailyTrend = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, revenue: round(d.revenue), orderCount: d.orderCount, avgValue: d.orderCount > 0 ? round(d.revenue / d.orderCount) : 0 }));

    const numDays = dailyTrend.length || 1;

    let bestDay = { date: '', revenue: 0 };
    let worstDay = { date: '', revenue: Infinity };
    dailyTrend.forEach(d => {
      if (d.revenue > bestDay.revenue) bestDay = { date: d.date, revenue: d.revenue };
      if (d.revenue < worstDay.revenue) worstDay = { date: d.date, revenue: d.revenue };
    });
    if (worstDay.revenue === Infinity) worstDay = { date: '', revenue: 0 };

    const dayOfWeekAvg = dayNames.map(day => {
      const d = dowMap[day];
      if (!d) return { day, avgRevenue: 0, avgOrders: 0, totalRevenue: 0, occurrences: 0 };
      const occ = d.occurrences.size || 1;
      return {
        day,
        avgRevenue: round(d.totalRevenue / occ),
        avgOrders: round(d.totalOrders / occ),
        totalRevenue: round(d.totalRevenue),
        occurrences: occ,
      };
    });

    outletTrend.sort((a, b) => b.revenue - a.revenue);

    return res.json({
      success: true,
      summary: {
        totalRevenue: round(totalRevenue),
        previousPeriodRevenue: round(previousPeriodRevenue),
        growthRate: previousPeriodRevenue > 0 ? round(((totalRevenue - previousPeriodRevenue) / previousPeriodRevenue) * 100) : 0,
        avgDailyRevenue: round(totalRevenue / numDays),
        bestDay,
        worstDay,
      },
      dailyTrend,
      dayOfWeekAvg,
      outletTrend,
    });
  } catch (error) {
    console.error('Revenue trends error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch revenue trends' });
  }
});

// ═══════════════════════════════════════════════
//  18. GET /:orgId/wallet-loyalty
//     Wallet & loyalty program analytics
// ═══════════════════════════════════════════════
router.get('/:orgId/wallet-loyalty', ...reportMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { startDate, endDate } = parseDateRange(req.query);
    const outlets = await getOrgOutlets(orgId);
    const round = v => Math.round(v * 100) / 100;

    let totalWalletRedeemed = 0;
    let totalLoyaltyPointsIssued = 0;
    let totalLoyaltyPointsRedeemed = 0;
    let loyaltyOrderCount = 0;
    let walletOrderCount = 0;
    let totalOrders = 0;
    const walletUserMap = {};
    const loyaltyDailyMap = {};

    const outletPromises = outlets.map(async (outlet) => {
      const orders = await getOutletOrders(outlet.id, startDate, endDate);

      orders.forEach(order => {
        totalOrders++;

        const walletAmount = Number(order.walletRedeemAmount) || 0;
        const loyaltyEarned = Number(order.loyaltyPointsEarned) || 0;
        const loyaltyRedeemed = Number(order.loyaltyPointsRedeemed) || 0;
        const loyaltyDiscount = Number(order.loyaltyDiscount) || 0;

        if (walletAmount > 0) {
          totalWalletRedeemed += walletAmount;
          walletOrderCount++;

          // Aggregate by customer
          const phone = order.customerInfo?.phone || order.customerInfo?.mobile || order.customerPhone || '';
          const custKey = phone ? String(phone).replace(/\D/g, '').slice(-10) : (order.customerId || '');
          if (custKey) {
            if (!walletUserMap[custKey]) {
              walletUserMap[custKey] = {
                name: order.customerInfo?.name || order.customerName || 'Guest',
                phone: custKey,
                totalRedeemed: 0,
                orderCount: 0,
              };
            }
            walletUserMap[custKey].totalRedeemed += walletAmount;
            walletUserMap[custKey].orderCount++;
          }
        }

        if (loyaltyEarned > 0 || loyaltyRedeemed > 0 || loyaltyDiscount > 0) {
          loyaltyOrderCount++;
        }

        totalLoyaltyPointsIssued += loyaltyEarned;
        totalLoyaltyPointsRedeemed += loyaltyRedeemed;

        // Daily loyalty trend
        const orderDate = order.createdAt ? (order.createdAt.toDate ? order.createdAt.toDate() : new Date(order.createdAt)) : null;
        if (orderDate && (loyaltyEarned > 0 || loyaltyRedeemed > 0 || loyaltyDiscount > 0 || walletAmount > 0)) {
          const dayKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}-${String(orderDate.getDate()).padStart(2, '0')}`;
          if (!loyaltyDailyMap[dayKey]) loyaltyDailyMap[dayKey] = { pointsIssued: 0, pointsRedeemed: 0, redemptionValue: 0 };
          loyaltyDailyMap[dayKey].pointsIssued += loyaltyEarned;
          loyaltyDailyMap[dayKey].pointsRedeemed += loyaltyRedeemed;
          loyaltyDailyMap[dayKey].redemptionValue += loyaltyDiscount + walletAmount;
        }
      });
    });

    await Promise.all(outletPromises);

    const topWalletUsers = Object.values(walletUserMap)
      .sort((a, b) => b.totalRedeemed - a.totalRedeemed)
      .slice(0, 20)
      .map(u => ({
        name: u.name,
        phone: u.phone.length >= 4 ? '****' + u.phone.slice(-4) : '****',
        totalRedeemed: round(u.totalRedeemed),
        orderCount: u.orderCount,
      }));

    const loyaltyTrend = Object.entries(loyaltyDailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        pointsIssued: round(d.pointsIssued),
        pointsRedeemed: round(d.pointsRedeemed),
        redemptionValue: round(d.redemptionValue),
      }));

    return res.json({
      success: true,
      summary: {
        totalWalletRedeemed: round(totalWalletRedeemed),
        totalLoyaltyPointsIssued: round(totalLoyaltyPointsIssued),
        totalLoyaltyPointsRedeemed: round(totalLoyaltyPointsRedeemed),
        loyaltyOrderCount,
        walletOrderCount,
        loyaltyOrderPercentage: totalOrders > 0 ? round((loyaltyOrderCount / totalOrders) * 100) : 0,
      },
      topWalletUsers,
      loyaltyTrend,
    });
  } catch (error) {
    console.error('Wallet loyalty error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch wallet & loyalty analytics' });
  }
});

module.exports = router;
