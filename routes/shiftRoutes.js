const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const { FieldValue } = require('firebase-admin/firestore');
const { getCachedRestDoc } = require('../utils/kvCache');

router.use(authenticateToken);

// Helper to categorize a payment method into sales buckets (same as registerRoutes)
function categorizePayment(method, amount, order, buckets) {
  const isAggregator = ['zomato', 'swiggy', 'aggregator', 'online', 'talabat', 'deliveroo', 'noon_food', 'careem'].includes(method) || ['online_order', 'talabat', 'deliveroo', 'noon_food', 'careem'].includes(order.orderSource);
  const orderTip = parseFloat(order.tipAmount || 0);

  if (isAggregator) {
    buckets.aggregatorSales += amount;
  } else if (method === 'cash') {
    buckets.cashSales += amount;
  } else if (method === 'card' || method === 'credit_card' || method === 'debit_card') {
    buckets.cardSales += amount;
    buckets.cardTips += orderTip;
  } else if (method === 'upi' || method === 'razorpay') {
    buckets.upiSales += amount;
    buckets.cardTips += orderTip;
  } else {
    buckets.otherSales += amount;
  }
}

// Helper to compute sales buckets from orders for a shift
function computeShiftSales(ordersSnap, shiftOpenDate, shiftUserId, isShiftOwnerAdmin) {
  const buckets = {
    totalSales: 0, cashSales: 0, cardSales: 0, upiSales: 0,
    aggregatorSales: 0, otherSales: 0, orderCount: 0,
    cardTips: 0, serviceChargeCollected: 0,
  };

  ordersSnap.docs.forEach(doc => {
    const order = doc.data();
    if (['cancelled', 'refunded', 'deleted'].includes(order.status)) return;

    let orderTime;
    if (order.createdAt?.toDate) {
      orderTime = order.createdAt.toDate();
    } else if (order.createdAt) {
      orderTime = new Date(order.createdAt);
    } else {
      return;
    }
    if (orderTime < shiftOpenDate) return;

    // Non-admin staff only see their own orders
    if (!isShiftOwnerAdmin && shiftUserId) {
      const orderStaffId = order.staffInfo?.userId || order.staffInfo?.waiterId || order.userId || order.createdBy;
      if (orderStaffId && orderStaffId !== shiftUserId) return;
    }

    const amount = parseFloat(order.finalAmount || order.totalAmount || 0);
    buckets.totalSales += amount;
    buckets.orderCount++;
    buckets.serviceChargeCollected += parseFloat(order.serviceChargeAmount || 0);

    if (order.splitPayments && Array.isArray(order.splitPayments) && order.splitPayments.length > 0) {
      order.splitPayments.forEach(sp => {
        const method = (sp.method || sp.paymentMethod || 'cash').toLowerCase();
        const spAmount = parseFloat(sp.amount || 0);
        categorizePayment(method, spAmount, order, buckets);
      });
    } else {
      const method = (order.paymentMethod || 'cash').toLowerCase();
      categorizePayment(method, amount, order, buckets);
    }
  });

  // Round to 2 decimals
  for (const key of Object.keys(buckets)) {
    buckets[key] = Math.round(buckets[key] * 100) / 100;
  }
  return buckets;
}

// Helper to parse shift openedAt to Date
function parseShiftDate(openedAt) {
  return openedAt?.toDate ? openedAt.toDate() : new Date(openedAt);
}

// Helper to normalize openedBy for frontend display
function normalizeOpenedBy(openedBy) {
  return typeof openedBy === 'object'
    ? openedBy
    : { userId: openedBy, name: openedBy, role: 'staff' };
}

// ── POST /:restaurantId/open ─────────────────────────
// Open a per-user shift
router.post('/:restaurantId/open', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { openingCash } = req.body;
    const userId = req.user.userId || req.user.id;

    // Check if THIS user already has an open shift
    const existing = await db.collection(collections.shifts)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'open')
      .where('openedBy.userId', '==', userId)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(400).json({
        error: 'You already have an open shift. Close it before opening a new one.',
        shiftId: existing.docs[0].id,
      });
    }

    // Get staff name and role
    let staffName = req.user.name || 'Staff';
    let staffRole = req.user.role || 'staff';
    try {
      const collName = req.user.source === 'staffUsers' ? collections.staffUsers : collections.users;
      const userDoc = await db.collection(collName).doc(userId).get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        staffName = userData.name || userData.displayName || userData.email || staffName;
        staffRole = userData.role || staffRole;
      }
    } catch (e) { /* non-blocking */ }

    const restaurantDoc = await getCachedRestDoc(db, collections.restaurants, restaurantId);
    const restaurantData = restaurantDoc.exists ? restaurantDoc.data() : {};

    const openedAt = new Date();
    const shiftDoc = {
      restaurantId,
      organizationId: restaurantData.organizationId || null,
      openingCash: parseFloat(openingCash) || 0,
      openedBy: { userId, name: staffName, role: staffRole },
      openedAt,
      status: 'open',
      transactions: [],
      cashIn: 0,
      cashOut: 0,
      cashDrops: 0,
    };

    const ref = await db.collection(collections.shifts).add(shiftDoc);

    res.status(201).json({
      success: true,
      shiftId: ref.id,
      shift: { id: ref.id, ...shiftDoc, openedAt: openedAt.toISOString() },
    });
  } catch (err) {
    console.error('Shift open error:', err);
    res.status(500).json({ error: 'Failed to open shift' });
  }
});

// ── GET /:restaurantId/current ───────────────────────
// Get current user's open shift with live sales
router.get('/:restaurantId/current', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId || req.user.id;

    const snapshot = await db.collection(collections.shifts)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'open')
      .where('openedBy.userId', '==', userId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.json({ success: true, shift: null });
    }

    const doc = snapshot.docs[0];
    const shiftData = doc.data();
    const shiftOpenDate = parseShiftDate(shiftData.openedAt);
    const shiftUserId = shiftData.openedBy?.userId || userId;
    const shiftRole = (shiftData.openedBy?.role || '').toLowerCase();
    const isShiftOwnerAdmin = ['owner', 'admin'].includes(shiftRole);

    // Fetch orders since shift opened
    let ordersSnap;
    try {
      ordersSnap = await db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', shiftOpenDate)
        .limit(5000)
        .get();
    } catch (indexErr) {
      // Fallback if composite index missing
      ordersSnap = await db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .limit(5000)
        .get();
    }

    const buckets = computeShiftSales(ordersSnap, shiftOpenDate, shiftUserId, isShiftOwnerAdmin);

    res.json({
      success: true,
      shift: {
        id: doc.id,
        ...shiftData,
        openedBy: normalizeOpenedBy(shiftData.openedBy),
        openedAt: shiftOpenDate.toISOString(),
        ...buckets,
      },
    });
  } catch (err) {
    console.error('Shift current error:', err);
    res.status(500).json({ error: 'Failed to fetch current shift' });
  }
});

// ── GET /:restaurantId/active-all ────────────────────
// All active shifts across staff (admin/owner only)
router.get('/:restaurantId/active-all', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const role = (req.user?.role || '').toLowerCase();
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only owner/admin can view all active shifts' });
    }

    const snapshot = await db.collection(collections.shifts)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'open')
      .limit(500)
      .get();

    const shifts = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      const openedAt = parseShiftDate(data.openedAt);
      const shiftUserId = data.openedBy?.userId || (typeof data.openedBy === 'string' ? data.openedBy : null);
      const shiftRole = (data.openedBy?.role || '').toLowerCase();
      const isShiftOwnerAdmin = ['owner', 'admin'].includes(shiftRole);

      let totalSales = 0, orderCount = 0;
      try {
        let ordersSnap;
        try {
          ordersSnap = await db.collection(collections.orders)
            .where('restaurantId', '==', restaurantId)
            .where('createdAt', '>=', openedAt)
            .limit(5000)
            .get();
        } catch (indexErr) {
          ordersSnap = await db.collection(collections.orders)
            .where('restaurantId', '==', restaurantId)
            .limit(5000)
            .get();
        }
        ordersSnap.docs.forEach(oDoc => {
          const order = oDoc.data();
          if (['cancelled', 'refunded', 'deleted'].includes(order.status)) return;
          const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
          if (orderDate < openedAt) return;
          if (!isShiftOwnerAdmin && shiftUserId) {
            const orderStaffId = order.staffInfo?.userId || order.staffInfo?.waiterId || order.userId || order.createdBy;
            if (orderStaffId && orderStaffId !== shiftUserId) return;
          }
          totalSales += parseFloat(order.finalAmount || order.totalAmount || 0);
          orderCount++;
        });
      } catch (e) { /* non-blocking */ }

      shifts.push({
        id: doc.id,
        openedBy: normalizeOpenedBy(data.openedBy),
        openedAt: openedAt.toISOString(),
        openingCash: data.openingCash || 0,
        cashIn: data.cashIn || 0,
        cashOut: data.cashOut || 0,
        cashDrops: data.cashDrops || 0,
        status: data.status,
        totalSales: Math.round(totalSales * 100) / 100,
        orderCount,
      });
    }

    res.json({ success: true, shifts });
  } catch (err) {
    console.error('Active-all shifts error:', err);
    res.status(500).json({ error: 'Failed to fetch active shifts' });
  }
});

// ── POST /:shiftId/cash-in-out ───────────────────────
// Record a cash in/out/drop transaction on an open shift
router.post('/:shiftId/cash-in-out', async (req, res) => {
  try {
    const { shiftId } = req.params;
    const { type, amount, reason } = req.body;

    if (!['in', 'out', 'drop'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type. Must be one of: in, out, drop' });
    }

    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    const shiftRef = db.collection(collections.shifts).doc(shiftId);
    const shiftDoc = await shiftRef.get();

    if (!shiftDoc.exists) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const shiftData = shiftDoc.data();
    if (shiftData.status !== 'open') {
      return res.status(400).json({ error: 'Shift is not open' });
    }

    const transaction = {
      type,
      amount: parsedAmount,
      reason: reason?.trim() || '',
      performedBy: req.user.userId || req.user.id,
      performedByName: req.user.name || 'Staff',
      performedAt: new Date().toISOString(),
    };

    const update = {
      transactions: FieldValue.arrayUnion(transaction),
    };

    if (type === 'in') {
      update.cashIn = FieldValue.increment(parsedAmount);
    } else if (type === 'out') {
      update.cashOut = FieldValue.increment(parsedAmount);
    } else if (type === 'drop') {
      update.cashOut = FieldValue.increment(parsedAmount);
      update.cashDrops = FieldValue.increment(parsedAmount);
    }

    await shiftRef.update(update);

    res.json({ success: true, transaction });
  } catch (err) {
    console.error('Shift cash-in-out error:', err);
    res.status(500).json({ error: 'Failed to record transaction' });
  }
});

// ── POST /:shiftId/close ────────────────────────────
// Close a shift with reconciliation
router.post('/:shiftId/close', async (req, res) => {
  try {
    const { shiftId } = req.params;
    const { closingCash, cashTips, denominations, closingNotes } = req.body;

    const shiftRef = db.collection(collections.shifts).doc(shiftId);
    const shiftDoc = await shiftRef.get();

    if (!shiftDoc.exists) {
      return res.status(404).json({ error: 'Shift not found' });
    }

    const shiftData = shiftDoc.data();
    if (shiftData.status !== 'open') {
      return res.status(400).json({ error: 'Shift is already closed' });
    }

    const shiftOpenDate = parseShiftDate(shiftData.openedAt);
    const shiftUserId = shiftData.openedBy?.userId || (typeof shiftData.openedBy === 'string' ? shiftData.openedBy : null);
    const shiftRole = (shiftData.openedBy?.role || '').toLowerCase();
    const isShiftOwnerAdmin = ['owner', 'admin'].includes(shiftRole);
    const now = new Date();

    // Fetch orders since shift opened
    let ordersSnap;
    try {
      ordersSnap = await db.collection(collections.orders)
        .where('restaurantId', '==', shiftData.restaurantId)
        .where('createdAt', '>=', shiftOpenDate)
        .where('createdAt', '<=', now)
        .limit(5000)
        .get();
    } catch (indexErr) {
      ordersSnap = await db.collection(collections.orders)
        .where('restaurantId', '==', shiftData.restaurantId)
        .limit(5000)
        .get();
    }

    const buckets = computeShiftSales(ordersSnap, shiftOpenDate, shiftUserId, isShiftOwnerAdmin);

    // Reconciliation
    const declaredCashTips = parseFloat(cashTips) || 0;
    const actualCash = parseFloat(closingCash) || 0;
    const expectedCash = (shiftData.openingCash || 0) + buckets.cashSales + declaredCashTips + (shiftData.cashIn || 0) - (shiftData.cashOut || 0);
    const cashDifference = actualCash - expectedCash;

    const closingFields = {
      status: 'closed',
      closingCash: actualCash,
      closedBy: req.user.userId || req.user.id,
      closedByName: req.user.name || 'Staff',
      closedAt: now.toISOString(),
      closingNotes: closingNotes?.trim() || null,
      denominations: denominations || null,
      cashTips: declaredCashTips,
      cardTips: buckets.cardTips,
      totalTips: declaredCashTips + buckets.cardTips,
      totalSales: buckets.totalSales,
      cashSales: buckets.cashSales,
      cardSales: buckets.cardSales,
      upiSales: buckets.upiSales,
      aggregatorSales: buckets.aggregatorSales,
      otherSales: buckets.otherSales,
      orderCount: buckets.orderCount,
      serviceChargeCollected: buckets.serviceChargeCollected,
      expectedCash: Math.round(expectedCash * 100) / 100,
      cashDifference: Math.round(cashDifference * 100) / 100,
    };

    await shiftRef.update(closingFields);

    res.json({
      success: true,
      summary: {
        ...closingFields,
        openingCash: shiftData.openingCash,
        cashIn: shiftData.cashIn || 0,
        cashOut: shiftData.cashOut || 0,
        cashDrops: shiftData.cashDrops || 0,
      },
    });
  } catch (err) {
    console.error('Shift close error:', err);
    res.status(500).json({ error: 'Failed to close shift' });
  }
});

// ── GET /:restaurantId/history ───────────────────────
// Get closed shift history
router.get('/:restaurantId/history', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const role = (req.user?.role || '').toLowerCase();
    const userId = req.user.userId || req.user.id;
    const isAdmin = ['owner', 'admin'].includes(role);

    const snap = await db.collection(collections.shifts)
      .where('restaurantId', '==', restaurantId)
      .orderBy('openedAt', 'desc')
      .limit(limit)
      .get();

    let shifts = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        openedBy: normalizeOpenedBy(d.openedBy),
        openedAt: d.openedAt?.toDate ? d.openedAt.toDate().toISOString() : d.openedAt,
        closedAt: d.closedAt?.toDate ? d.closedAt.toDate().toISOString() : d.closedAt,
      };
    });

    // Non-admin staff only see their own shifts
    if (!isAdmin) {
      shifts = shifts.filter(s => s.openedBy?.userId === userId);
    }

    res.json({ success: true, shifts });
  } catch (err) {
    console.error('Shift history error:', err);
    res.status(500).json({ error: 'Failed to fetch shift history' });
  }
});

// ── GET /:restaurantId/report ────────────────────────
// Download shift report (xlsx/csv)
router.get('/:restaurantId/report', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { format = 'csv', startDate, endDate, staffId } = req.query;
    const role = (req.user?.role || '').toLowerCase();
    const userId = req.user.userId || req.user.id;
    const isAdmin = ['owner', 'admin'].includes(role);

    // Non-admin can only download own report
    if (!isAdmin && staffId && staffId !== userId) {
      return res.status(403).json({ error: 'You can only download your own shift report' });
    }

    // Build query
    let query = db.collection(collections.shifts)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'closed')
      .orderBy('openedAt', 'desc')
      .limit(500);

    const snap = await query.get();

    let shifts = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        ...d,
        openedBy: normalizeOpenedBy(d.openedBy),
        openedAt: d.openedAt?.toDate ? d.openedAt.toDate().toISOString() : d.openedAt,
        closedAt: d.closedAt?.toDate ? d.closedAt.toDate().toISOString() : d.closedAt,
      };
    });

    // Date filter in-memory
    if (startDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      shifts = shifts.filter(s => new Date(s.openedAt) >= start);
    }
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      shifts = shifts.filter(s => new Date(s.openedAt) <= end);
    }

    // Staff filter
    const filterStaffId = staffId || (!isAdmin ? userId : null);
    if (filterStaffId) {
      shifts = shifts.filter(s => s.openedBy?.userId === filterStaffId);
    }

    if (format === 'xlsx') {
      // Lazy-load xlsx
      let XLSX;
      try { XLSX = require('xlsx'); } catch (e) {
        return res.status(500).json({ error: 'XLSX library not available' });
      }

      const wb = XLSX.utils.book_new();

      // Summary sheet
      const summaryData = shifts.map(s => ({
        'Staff': s.openedBy?.name || 'Unknown',
        'Role': s.openedBy?.role || '',
        'Opened At': s.openedAt || '',
        'Closed At': s.closedAt || '',
        'Opening Cash': s.openingCash || 0,
        'Total Sales': s.totalSales || 0,
        'Cash Sales': s.cashSales || 0,
        'Card Sales': s.cardSales || 0,
        'UPI Sales': s.upiSales || 0,
        'Aggregator Sales': s.aggregatorSales || 0,
        'Other Sales': s.otherSales || 0,
        'Order Count': s.orderCount || 0,
        'Cash In': s.cashIn || 0,
        'Cash Out': s.cashOut || 0,
        'Cash Drops': s.cashDrops || 0,
        'Expected Cash': s.expectedCash || 0,
        'Closing Cash': s.closingCash || 0,
        'Cash Difference': s.cashDifference || 0,
        'Cash Tips': s.cashTips || 0,
        'Card Tips': s.cardTips || 0,
      }));
      const ws = XLSX.utils.json_to_sheet(summaryData);
      XLSX.utils.book_append_sheet(wb, ws, 'Shift Summary');

      // Transactions sheet
      const txnData = [];
      shifts.forEach(s => {
        (s.transactions || []).forEach(t => {
          txnData.push({
            'Shift Staff': s.openedBy?.name || 'Unknown',
            'Shift Opened': s.openedAt || '',
            'Type': t.type || '',
            'Amount': t.amount || 0,
            'Reason': t.reason || '',
            'Performed By': t.performedByName || t.performedBy || '',
            'Time': t.performedAt || '',
          });
        });
      });
      if (txnData.length > 0) {
        const ws2 = XLSX.utils.json_to_sheet(txnData);
        XLSX.utils.book_append_sheet(wb, ws2, 'Cash Transactions');
      }

      // Grand totals sheet
      const totals = shifts.reduce((acc, s) => {
        acc.totalSales += s.totalSales || 0;
        acc.cashSales += s.cashSales || 0;
        acc.cardSales += s.cardSales || 0;
        acc.upiSales += s.upiSales || 0;
        acc.orderCount += s.orderCount || 0;
        acc.cashDifference += s.cashDifference || 0;
        return acc;
      }, { totalSales: 0, cashSales: 0, cardSales: 0, upiSales: 0, orderCount: 0, cashDifference: 0 });
      const totalsSheet = XLSX.utils.json_to_sheet([{
        'Total Shifts': shifts.length,
        'Total Sales': Math.round(totals.totalSales * 100) / 100,
        'Total Cash Sales': Math.round(totals.cashSales * 100) / 100,
        'Total Card Sales': Math.round(totals.cardSales * 100) / 100,
        'Total UPI Sales': Math.round(totals.upiSales * 100) / 100,
        'Total Orders': totals.orderCount,
        'Net Cash Difference': Math.round(totals.cashDifference * 100) / 100,
      }]);
      XLSX.utils.book_append_sheet(wb, totalsSheet, 'Grand Totals');

      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="shift-report-${restaurantId}.xlsx"`);
      return res.send(buffer);
    }

    // Default: CSV
    const csvRows = ['Staff,Role,Opened At,Closed At,Opening Cash,Total Sales,Cash Sales,Card Sales,UPI Sales,Order Count,Expected Cash,Closing Cash,Cash Difference'];
    shifts.forEach(s => {
      csvRows.push([
        `"${(s.openedBy?.name || 'Unknown').replace(/"/g, '""')}"`,
        s.openedBy?.role || '',
        s.openedAt || '',
        s.closedAt || '',
        s.openingCash || 0,
        s.totalSales || 0,
        s.cashSales || 0,
        s.cardSales || 0,
        s.upiSales || 0,
        s.orderCount || 0,
        s.expectedCash || 0,
        s.closingCash || 0,
        s.cashDifference || 0,
      ].join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="shift-report-${restaurantId}.csv"`);
    res.send(csvRows.join('\n'));
  } catch (err) {
    console.error('Shift report error:', err);
    res.status(500).json({ error: 'Failed to generate shift report' });
  }
});

module.exports = router;
