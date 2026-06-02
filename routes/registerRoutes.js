const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const { FieldValue } = require('firebase-admin/firestore');
const { getCachedRestDoc } = require('../utils/kvCache');

router.use(authenticateToken);

// Helper to categorize a payment method into sales buckets
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

// ── POST /api/register/:restaurantId/open ─────────────────────────
// Open a new cash register / shift
router.post('/:restaurantId/open', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { openingCash, operatorName, openingNotes } = req.body;

    // Check if a register is already open
    const existingSnap = await db.collection(collections.cashRegisters)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'open')
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      return res.status(400).json({ error: 'A register is already open for this restaurant' });
    }

    // Look up restaurant to get organizationId
    const restaurantDoc = await getCachedRestDoc(db, collections.restaurants, restaurantId);
    const restaurantData = restaurantDoc.exists ? restaurantDoc.data() : {};

    const registerDoc = {
      restaurantId,
      organizationId: restaurantData.organizationId || null,
      openingCash: parseFloat(openingCash) || 0,
      openedBy: req.user.userId || req.user.id,
      openedByName: req.user.name || 'Staff',
      operatorName: operatorName?.trim() || null,
      openedAt: new Date().toISOString(),
      openingNotes: openingNotes?.trim() || null,
      status: 'open',
      transactions: [],
      cashIn: 0,
      cashOut: 0,
      cashDrops: 0,
    };

    const ref = await db.collection(collections.cashRegisters).add(registerDoc);

    res.status(201).json({
      success: true,
      registerId: ref.id,
      register: { id: ref.id, ...registerDoc },
    });
  } catch (err) {
    console.error('Register open error:', err);
    res.status(500).json({ error: 'Failed to open register' });
  }
});

// ── GET /api/register/:restaurantId/current ───────────────────────
// Get the currently open register for a restaurant
router.get('/:restaurantId/current', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snap = await db.collection(collections.cashRegisters)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'open')
      .limit(1)
      .get();

    if (!snap.empty) {
      const doc = snap.docs[0];
      return res.json({ success: true, register: { id: doc.id, ...doc.data() } });
    }

    res.json({ success: true, register: null });
  } catch (err) {
    console.error('Register current error:', err);
    res.status(500).json({ error: 'Failed to fetch current register' });
  }
});

// ── POST /api/register/:registerId/transaction ────────────────────
// Record a cash in/out/drop transaction on an open register
router.post('/:registerId/transaction', async (req, res) => {
  try {
    const { registerId } = req.params;
    const { type, amount, reason } = req.body;

    // Validate type
    if (!['in', 'out', 'drop'].includes(type)) {
      return res.status(400).json({ error: 'Invalid transaction type. Must be one of: in, out, drop' });
    }

    // Validate amount
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }

    // Fetch register
    const registerRef = db.collection(collections.cashRegisters).doc(registerId);
    const registerDoc = await registerRef.get();

    if (!registerDoc.exists) {
      return res.status(404).json({ error: 'Register not found' });
    }

    const registerData = registerDoc.data();
    if (registerData.status !== 'open') {
      return res.status(400).json({ error: 'Register is not open' });
    }

    const transaction = {
      type,
      amount: parsedAmount,
      reason: reason?.trim() || '',
      performedBy: req.user.userId || req.user.id,
      performedByName: req.user.name || 'Staff',
      performedAt: new Date().toISOString(),
    };

    // Build update
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

    await registerRef.update(update);

    res.json({ success: true, transaction });
  } catch (err) {
    console.error('Register transaction error:', err);
    res.status(500).json({ error: 'Failed to record transaction' });
  }
});

// ── POST /api/register/:registerId/close ──────────────────────────
// Close a register / end shift with reconciliation
router.post('/:registerId/close', async (req, res) => {
  try {
    const { registerId } = req.params;
    const { closingCash, cashTips, denominations, closingNotes } = req.body;

    // Fetch register
    const registerRef = db.collection(collections.cashRegisters).doc(registerId);
    const registerDoc = await registerRef.get();

    if (!registerDoc.exists) {
      return res.status(404).json({ error: 'Register not found' });
    }

    const registerData = registerDoc.data();
    if (registerData.status !== 'open') {
      return res.status(400).json({ error: 'Register is already closed' });
    }

    // Fetch all orders for this restaurant and filter in code
    const ordersSnap = await db.collection(collections.orders)
      .where('restaurantId', '==', registerData.restaurantId)
      .get();

    const buckets = {
      totalSales: 0, cashSales: 0, cardSales: 0, upiSales: 0,
      aggregatorSales: 0, otherSales: 0, orderCount: 0,
      cardTips: 0, serviceChargeCollected: 0,
    };

    ordersSnap.docs.forEach(doc => {
      const order = doc.data();

      // Skip cancelled/refunded
      if (['cancelled', 'refunded'].includes(order.status)) return;

      // Parse createdAt
      let orderTime;
      if (order.createdAt?.toDate) {
        orderTime = order.createdAt.toDate();
      } else if (order.createdAt) {
        orderTime = new Date(order.createdAt);
      } else {
        return;
      }

      const openedTime = new Date(registerData.openedAt);
      if (orderTime < openedTime) return;

      const amount = parseFloat(order.finalAmount || order.totalAmount || 0);
      buckets.totalSales += amount;
      buckets.orderCount++;

      // Tips and service charge
      const orderTip = parseFloat(order.tipAmount || 0);
      buckets.serviceChargeCollected += parseFloat(order.serviceChargeAmount || 0);

      // Handle split payments
      if (order.splitPayments && Array.isArray(order.splitPayments) && order.splitPayments.length > 0) {
        order.splitPayments.forEach(sp => {
          const method = (sp.method || sp.paymentMethod || 'cash').toLowerCase();
          const spAmount = parseFloat(sp.amount || 0);
          categorizePayment(method, spAmount, order, buckets);
        });
      } else {
        const method = (order.paymentMethod || 'cash').toLowerCase();
        const isAggregator = ['zomato', 'swiggy', 'aggregator', 'online', 'talabat', 'deliveroo', 'noon_food', 'careem'].includes(method) || ['online_order', 'talabat', 'deliveroo', 'noon_food', 'careem'].includes(order.orderSource);

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
    });

    // Reconciliation
    const declaredCashTips = parseFloat(cashTips) || 0;
    const actualCash = parseFloat(closingCash) || 0;
    const expectedCash = registerData.openingCash + buckets.cashSales + declaredCashTips + (registerData.cashIn || 0) - (registerData.cashOut || 0);
    const cashDifference = actualCash - expectedCash;

    const closingFields = {
      status: 'closed',
      closingCash: actualCash,
      closedBy: req.user.userId || req.user.id,
      closedByName: req.user.name || 'Staff',
      closedAt: new Date().toISOString(),
      closingNotes: closingNotes?.trim() || null,
      denominations: denominations || null,
      totalSales: buckets.totalSales,
      cashSales: buckets.cashSales,
      cardSales: buckets.cardSales,
      upiSales: buckets.upiSales,
      aggregatorSales: buckets.aggregatorSales,
      otherSales: buckets.otherSales,
      orderCount: buckets.orderCount,
      totalTips: declaredCashTips + buckets.cardTips,
      cashTips: declaredCashTips,
      cardTips: buckets.cardTips,
      serviceChargeCollected: buckets.serviceChargeCollected,
      expectedCash,
      cashDifference,
    };

    await registerRef.update(closingFields);

    res.json({
      success: true,
      summary: {
        ...closingFields,
        openingCash: registerData.openingCash,
        cashIn: registerData.cashIn,
        cashOut: registerData.cashOut,
        cashDrops: registerData.cashDrops,
      },
    });
  } catch (err) {
    console.error('Register close error:', err);
    res.status(500).json({ error: 'Failed to close register' });
  }
});

// ── GET /api/register/:restaurantId/history ───────────────────────
// Get register/shift history for a restaurant
router.get('/:restaurantId/history', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);

    const snap = await db.collection(collections.cashRegisters)
      .where('restaurantId', '==', restaurantId)
      .orderBy('openedAt', 'desc')
      .limit(limit)
      .get();

    const registers = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.json({ success: true, registers });
  } catch (err) {
    console.error('Register history error:', err);
    res.status(500).json({ error: 'Failed to fetch register history' });
  }
});

// ── GET /api/register/:registerId/x-report ────────────────────────
// Mid-shift X-report — read-only snapshot without closing the register
router.get('/:registerId/x-report', async (req, res) => {
  try {
    const { registerId } = req.params;

    const registerRef = db.collection(collections.cashRegisters).doc(registerId);
    const registerDoc = await registerRef.get();

    if (!registerDoc.exists) {
      return res.status(404).json({ error: 'Register not found' });
    }

    const registerData = registerDoc.data();
    if (registerData.status !== 'open') {
      return res.status(400).json({ error: 'Register is not open' });
    }

    // Fetch orders and compute same buckets as close endpoint
    const ordersSnap = await db.collection(collections.orders)
      .where('restaurantId', '==', registerData.restaurantId)
      .get();

    const buckets = {
      totalSales: 0, cashSales: 0, cardSales: 0, upiSales: 0,
      aggregatorSales: 0, otherSales: 0, orderCount: 0,
      cardTips: 0, serviceChargeCollected: 0,
    };

    ordersSnap.docs.forEach(doc => {
      const order = doc.data();
      if (['cancelled', 'refunded'].includes(order.status)) return;

      let orderTime;
      if (order.createdAt?.toDate) {
        orderTime = order.createdAt.toDate();
      } else if (order.createdAt) {
        orderTime = new Date(order.createdAt);
      } else {
        return;
      }

      const openedTime = new Date(registerData.openedAt);
      if (orderTime < openedTime) return;

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
        const orderTip = parseFloat(order.tipAmount || 0);
        const isAggregator = ['zomato', 'swiggy', 'aggregator', 'online', 'talabat', 'deliveroo', 'noon_food', 'careem'].includes(method) || ['online_order', 'talabat', 'deliveroo', 'noon_food', 'careem'].includes(order.orderSource);

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
    });

    const expectedCash = registerData.openingCash + buckets.cashSales + (registerData.cashIn || 0) - (registerData.cashOut || 0);

    res.json({
      success: true,
      summary: {
        ...buckets,
        openingCash: registerData.openingCash,
        cashIn: registerData.cashIn || 0,
        cashOut: registerData.cashOut || 0,
        cashDrops: registerData.cashDrops || 0,
        expectedCash,
        reportGeneratedAt: new Date().toISOString(),
        operatorName: registerData.operatorName || registerData.openedByName,
        openedAt: registerData.openedAt,
      },
    });
  } catch (err) {
    console.error('X-report error:', err);
    res.status(500).json({ error: 'Failed to generate X-report' });
  }
});

module.exports = router;
