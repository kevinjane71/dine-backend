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

// ═══════════════════════════════════════════════
//  8. GET /:orgId/export/:reportType
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

      default:
        return res.status(400).json({
          success: false,
          error: `Invalid report type: '${reportType}'. Valid types: inventory, pl, indents, outlet-ranking`
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

module.exports = router;
