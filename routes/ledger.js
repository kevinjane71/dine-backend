const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Default chart of accounts for restaurants
const DEFAULT_ACCOUNTS = [
  { code: '1000', name: 'Cash', type: 'asset', parentCode: null },
  { code: '1010', name: 'Bank Account', type: 'asset', parentCode: null },
  { code: '1020', name: 'Accounts Receivable', type: 'asset', parentCode: null },
  { code: '1030', name: 'Inventory', type: 'asset', parentCode: null },
  { code: '2000', name: 'Accounts Payable', type: 'liability', parentCode: null },
  { code: '2010', name: 'GST Payable', type: 'liability', parentCode: null },
  { code: '2020', name: 'Salaries Payable', type: 'liability', parentCode: null },
  { code: '3000', name: 'Owner Equity', type: 'equity', parentCode: null },
  { code: '3010', name: 'Retained Earnings', type: 'equity', parentCode: null },
  { code: '4000', name: 'Sales Revenue', type: 'revenue', parentCode: null },
  { code: '4010', name: 'Delivery Revenue', type: 'revenue', parentCode: null },
  { code: '4020', name: 'Takeaway Revenue', type: 'revenue', parentCode: null },
  { code: '5000', name: 'Cost of Goods Sold', type: 'expense', parentCode: null },
  { code: '5010', name: 'Food Costs', type: 'expense', parentCode: '5000' },
  { code: '5020', name: 'Beverage Costs', type: 'expense', parentCode: '5000' },
  { code: '6000', name: 'Rent', type: 'expense', parentCode: null },
  { code: '6010', name: 'Utilities', type: 'expense', parentCode: null },
  { code: '6020', name: 'Salaries & Wages', type: 'expense', parentCode: null },
  { code: '6030', name: 'Marketing', type: 'expense', parentCode: null },
  { code: '6040', name: 'Insurance', type: 'expense', parentCode: null },
  { code: '6050', name: 'Repairs & Maintenance', type: 'expense', parentCode: null },
  { code: '6060', name: 'Supplies', type: 'expense', parentCode: null },
  { code: '6070', name: 'Licenses & Permits', type: 'expense', parentCode: null },
  { code: '6080', name: 'Equipment', type: 'expense', parentCode: null },
  { code: '6090', name: 'Miscellaneous Expenses', type: 'expense', parentCode: null },
];

// ── GET /api/ledger/:restaurantId/accounts ────────────────────────
// Get chart of accounts (auto-seed on first access)
router.get('/:restaurantId/accounts', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    let snap = await db.collection('chartOfAccounts')
      .where('restaurantId', '==', restaurantId)
      .orderBy('code', 'asc')
      .get();

    // Auto-seed if empty
    if (snap.empty) {
      const batch = db.batch();
      DEFAULT_ACCOUNTS.forEach(acc => {
        const ref = db.collection('chartOfAccounts').doc();
        batch.set(ref, {
          ...acc,
          restaurantId,
          isSystem: true,
          balance: 0,
          createdAt: new Date(),
        });
      });
      await batch.commit();

      // Re-fetch
      snap = await db.collection('chartOfAccounts')
        .where('restaurantId', '==', restaurantId)
        .orderBy('code', 'asc')
        .get();
    }

    const accounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ accounts, total: accounts.length });
  } catch (err) {
    console.error('Chart of accounts error:', err);
    res.status(500).json({ error: 'Failed to fetch chart of accounts' });
  }
});

// ── GET /api/ledger/:restaurantId/entries ─────────────────────────
// Get journal entries with filters
router.get('/:restaurantId/entries', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { startDate, endDate, account, type, limit: lim } = req.query;

    let query = db.collection('journalEntries')
      .where('restaurantId', '==', restaurantId)
      .orderBy('date', 'desc');

    if (startDate) query = query.where('date', '>=', new Date(startDate));
    if (endDate) query = query.where('date', '<=', new Date(endDate));
    if (lim) query = query.limit(parseInt(lim));

    const snap = await query.get();
    let entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Client-side filter for account/type (Firestore can't do multiple range + equality)
    if (account) {
      entries = entries.filter(e => e.debitAccount === account || e.creditAccount === account);
    }
    if (type) {
      entries = entries.filter(e => e.reference?.type === type);
    }

    res.json({ entries, total: entries.length });
  } catch (err) {
    console.error('Journal entries error:', err);
    res.status(500).json({ error: 'Failed to fetch journal entries' });
  }
});

// ── POST /api/ledger/:restaurantId/entries ────────────────────────
// Create a manual journal entry
router.post('/:restaurantId/entries', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { date, description, debitAccount, creditAccount, amount, reference } = req.body;

    if (!debitAccount || !creditAccount || !amount) {
      return res.status(400).json({ error: 'debitAccount, creditAccount, and amount are required' });
    }

    if (debitAccount === creditAccount) {
      return res.status(400).json({ error: 'Debit and credit accounts must be different' });
    }

    const entry = {
      restaurantId,
      date: date ? new Date(date) : new Date(),
      description: description || '',
      debitAccount,
      debitAccountName: '',
      creditAccount,
      creditAccountName: '',
      amount: parseFloat(amount),
      reference: reference || { type: 'manual', refId: null },
      createdBy: req.user?.userId || req.user?.id,
      createdAt: new Date(),
    };

    // Look up account names
    const accountSnap = await db.collection('chartOfAccounts')
      .where('restaurantId', '==', restaurantId)
      .where('code', 'in', [debitAccount, creditAccount])
      .get();

    accountSnap.docs.forEach(doc => {
      const acc = doc.data();
      if (acc.code === debitAccount) entry.debitAccountName = acc.name;
      if (acc.code === creditAccount) entry.creditAccountName = acc.name;
    });

    const docRef = await db.collection('journalEntries').add(entry);
    res.status(201).json({ id: docRef.id, ...entry, message: 'Journal entry created' });
  } catch (err) {
    console.error('Journal entry create error:', err);
    res.status(500).json({ error: 'Failed to create journal entry' });
  }
});

// ── GET /api/ledger/:restaurantId/trial-balance ──────────────────
// Generate trial balance for a period
router.get('/:restaurantId/trial-balance', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { startDate, endDate } = req.query;

    // Get all accounts
    const accountSnap = await db.collection('chartOfAccounts')
      .where('restaurantId', '==', restaurantId)
      .get();

    const accounts = {};
    accountSnap.docs.forEach(doc => {
      const acc = doc.data();
      accounts[acc.code] = { code: acc.code, name: acc.name, type: acc.type, debit: 0, credit: 0 };
    });

    // Get journal entries for period
    let query = db.collection('journalEntries')
      .where('restaurantId', '==', restaurantId);
    if (startDate) query = query.where('date', '>=', new Date(startDate));
    if (endDate) query = query.where('date', '<=', new Date(endDate));

    const entrySnap = await query.get();

    entrySnap.docs.forEach(doc => {
      const entry = doc.data();
      const amt = entry.amount || 0;
      if (accounts[entry.debitAccount]) accounts[entry.debitAccount].debit += amt;
      if (accounts[entry.creditAccount]) accounts[entry.creditAccount].credit += amt;
    });

    const trialBalance = Object.values(accounts)
      .filter(a => a.debit > 0 || a.credit > 0)
      .map(a => ({
        ...a,
        debit: Math.round(a.debit * 100) / 100,
        credit: Math.round(a.credit * 100) / 100,
        balance: Math.round((a.debit - a.credit) * 100) / 100,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));

    const totalDebit = trialBalance.reduce((s, a) => s + a.debit, 0);
    const totalCredit = trialBalance.reduce((s, a) => s + a.credit, 0);

    res.json({
      trialBalance,
      totals: {
        debit: Math.round(totalDebit * 100) / 100,
        credit: Math.round(totalCredit * 100) / 100,
        difference: Math.round((totalDebit - totalCredit) * 100) / 100,
        isBalanced: Math.abs(totalDebit - totalCredit) < 0.01,
      },
    });
  } catch (err) {
    console.error('Trial balance error:', err);
    res.status(500).json({ error: 'Failed to generate trial balance' });
  }
});

// ── GET /api/ledger/:restaurantId/summary ────────────────────────
// Monthly/weekly summary report
router.get('/:restaurantId/summary', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { period, year } = req.query; // period: 'monthly' or 'weekly', year: '2026'
    const yr = parseInt(year) || new Date().getFullYear();

    // Fetch all orders for the year
    const yearStart = new Date(yr, 0, 1);
    const yearEnd = new Date(yr, 11, 31, 23, 59, 59, 999);

    const [orderSnap, expenseSnap] = await Promise.all([
      db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', yearStart)
        .where('createdAt', '<=', yearEnd)
        .get(),
      db.collection('expenses')
        .where('restaurantId', '==', restaurantId)
        .where('date', '>=', yearStart)
        .where('date', '<=', yearEnd)
        .get(),
    ]);

    const summaryMap = {};

    function getKey(date, periodType) {
      const d = date?.toDate?.() || new Date(date);
      if (periodType === 'weekly') {
        const startOfYear = new Date(d.getFullYear(), 0, 1);
        const weekNum = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
        return `W${String(weekNum).padStart(2, '0')}`;
      }
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    // Aggregate orders
    orderSnap.docs.forEach(doc => {
      const o = doc.data();
      if (o.status === 'cancelled') return;
      const key = getKey(o.createdAt, period);
      if (!summaryMap[key]) summaryMap[key] = { period: key, revenue: 0, tax: 0, orders: 0, expenses: 0, profit: 0 };
      summaryMap[key].revenue += o.finalAmount || o.totalAmount || 0;
      summaryMap[key].tax += o.taxAmount || 0;
      summaryMap[key].orders += 1;
    });

    // Aggregate expenses
    expenseSnap.docs.forEach(doc => {
      const e = doc.data();
      const key = getKey(e.date, period);
      if (!summaryMap[key]) summaryMap[key] = { period: key, revenue: 0, tax: 0, orders: 0, expenses: 0, profit: 0 };
      summaryMap[key].expenses += e.amount || 0;
    });

    // Calculate profit
    const summary = Object.values(summaryMap)
      .map(s => ({
        ...s,
        revenue: Math.round(s.revenue * 100) / 100,
        tax: Math.round(s.tax * 100) / 100,
        expenses: Math.round(s.expenses * 100) / 100,
        profit: Math.round((s.revenue - s.expenses) * 100) / 100,
      }))
      .sort((a, b) => a.period.localeCompare(b.period));

    const totals = summary.reduce(
      (acc, s) => ({
        revenue: acc.revenue + s.revenue,
        tax: acc.tax + s.tax,
        orders: acc.orders + s.orders,
        expenses: acc.expenses + s.expenses,
        profit: acc.profit + s.profit,
      }),
      { revenue: 0, tax: 0, orders: 0, expenses: 0, profit: 0 }
    );

    res.json({ year: yr, periodType: period || 'monthly', summary, totals });
  } catch (err) {
    console.error('Ledger summary error:', err);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

module.exports = router;
