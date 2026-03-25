const express = require('express');

module.exports = (db, collections) => {
  const router = express.Router();

  async function getOrgId(userId) {
    const snapshot = await db.collection(collections.invOrganizations)
      .where('userId', '==', userId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].id;
  }

  // GET /receivables — Receivables aging summary
  router.get('/receivables', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      // Fetch all unpaid/partially paid invoices
      const snapshot = await db.collection(collections.invInvoices)
        .where('orgId', '==', orgId)
        .where('status', 'in', ['sent', 'viewed', 'overdue'])
        .get();

      const now = new Date();
      const aging = {
        current: { count: 0, amount: 0 },
        '1_15': { count: 0, amount: 0 },
        '16_30': { count: 0, amount: 0 },
        '31_45': { count: 0, amount: 0 },
        '45_plus': { count: 0, amount: 0 },
        total: { count: 0, amount: 0 }
      };

      const invoiceDetails = [];

      snapshot.docs.forEach(doc => {
        const inv = doc.data();
        const balanceDue = inv.balanceDue || (inv.total - (inv.paidAmount || 0));
        if (balanceDue <= 0) return;

        const dueDate = inv.dueDate ? new Date(inv.dueDate) : null;
        let daysOverdue = 0;

        if (dueDate) {
          daysOverdue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
        }

        const entry = {
          invoiceId: doc.id,
          invoiceNumber: inv.invoiceNumber,
          customerId: inv.customerId,
          dueDate: inv.dueDate,
          total: inv.total,
          balanceDue,
          daysOverdue: Math.max(0, daysOverdue)
        };

        if (daysOverdue <= 0) {
          aging.current.count++;
          aging.current.amount += balanceDue;
          entry.bucket = 'current';
        } else if (daysOverdue <= 15) {
          aging['1_15'].count++;
          aging['1_15'].amount += balanceDue;
          entry.bucket = '1_15';
        } else if (daysOverdue <= 30) {
          aging['16_30'].count++;
          aging['16_30'].amount += balanceDue;
          entry.bucket = '16_30';
        } else if (daysOverdue <= 45) {
          aging['31_45'].count++;
          aging['31_45'].amount += balanceDue;
          entry.bucket = '31_45';
        } else {
          aging['45_plus'].count++;
          aging['45_plus'].amount += balanceDue;
          entry.bucket = '45_plus';
        }

        aging.total.count++;
        aging.total.amount += balanceDue;
        invoiceDetails.push(entry);
      });

      // Round amounts
      for (const key of Object.keys(aging)) {
        aging[key].amount = Math.round(aging[key].amount * 100) / 100;
      }

      return res.json({
        success: true,
        data: { aging, invoices: invoiceDetails }
      });
    } catch (error) {
      console.error('Error generating receivables report:', error);
      return res.status(500).json({ success: false, error: 'Failed to generate receivables report' });
    }
  });

  // GET /sales — Sales summary by date range
  router.get('/sales', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      // Default to current month if no date range
      const now = new Date();
      const startDate = req.query.startDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = req.query.endDate || now.toISOString().split('T')[0];

      const snapshot = await db.collection(collections.invInvoices)
        .where('orgId', '==', orgId)
        .get();

      let totalSales = 0;
      let totalTax = 0;
      let totalDiscount = 0;
      let totalReceived = 0;
      let invoiceCount = 0;
      const salesByStatus = {};
      const salesByCustomer = {};

      snapshot.docs.forEach(doc => {
        const inv = doc.data();
        if (inv.status === 'void') return;

        const invDate = inv.invoiceDate || '';
        if (invDate < startDate || invDate > endDate) return;

        invoiceCount++;
        totalSales += inv.total || 0;
        totalTax += inv.taxAmount || 0;
        totalDiscount += inv.discountAmount || 0;
        totalReceived += inv.paidAmount || 0;

        // By status
        const status = inv.status || 'draft';
        if (!salesByStatus[status]) {
          salesByStatus[status] = { count: 0, amount: 0 };
        }
        salesByStatus[status].count++;
        salesByStatus[status].amount += inv.total || 0;

        // By customer
        const custId = inv.customerId || 'unknown';
        if (!salesByCustomer[custId]) {
          salesByCustomer[custId] = { count: 0, amount: 0 };
        }
        salesByCustomer[custId].count++;
        salesByCustomer[custId].amount += inv.total || 0;
      });

      // Round amounts
      for (const key of Object.keys(salesByStatus)) {
        salesByStatus[key].amount = Math.round(salesByStatus[key].amount * 100) / 100;
      }
      for (const key of Object.keys(salesByCustomer)) {
        salesByCustomer[key].amount = Math.round(salesByCustomer[key].amount * 100) / 100;
      }

      return res.json({
        success: true,
        data: {
          period: { startDate, endDate },
          summary: {
            invoiceCount,
            totalSales: Math.round(totalSales * 100) / 100,
            totalTax: Math.round(totalTax * 100) / 100,
            totalDiscount: Math.round(totalDiscount * 100) / 100,
            totalReceived: Math.round(totalReceived * 100) / 100,
            totalOutstanding: Math.round((totalSales - totalReceived) * 100) / 100
          },
          byStatus: salesByStatus,
          byCustomer: salesByCustomer
        }
      });
    } catch (error) {
      console.error('Error generating sales report:', error);
      return res.status(500).json({ success: false, error: 'Failed to generate sales report' });
    }
  });

  // GET /expenses — Expense summary by category
  router.get('/expenses', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const now = new Date();
      const startDate = req.query.startDate || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      const endDate = req.query.endDate || now.toISOString().split('T')[0];

      const snapshot = await db.collection(collections.invExpenses)
        .where('orgId', '==', orgId)
        .get();

      let totalExpenses = 0;
      let expenseCount = 0;
      const byCategory = {};
      const billableTotal = { count: 0, amount: 0 };
      const nonBillableTotal = { count: 0, amount: 0 };

      snapshot.docs.forEach(doc => {
        const exp = doc.data();
        const expDate = exp.date || '';
        if (expDate < startDate || expDate > endDate) return;

        expenseCount++;
        totalExpenses += exp.amount || 0;

        const category = exp.category || 'Uncategorized';
        if (!byCategory[category]) {
          byCategory[category] = { count: 0, amount: 0 };
        }
        byCategory[category].count++;
        byCategory[category].amount += exp.amount || 0;

        if (exp.isBillable) {
          billableTotal.count++;
          billableTotal.amount += exp.amount || 0;
        } else {
          nonBillableTotal.count++;
          nonBillableTotal.amount += exp.amount || 0;
        }
      });

      // Round amounts
      for (const key of Object.keys(byCategory)) {
        byCategory[key].amount = Math.round(byCategory[key].amount * 100) / 100;
      }
      billableTotal.amount = Math.round(billableTotal.amount * 100) / 100;
      nonBillableTotal.amount = Math.round(nonBillableTotal.amount * 100) / 100;

      return res.json({
        success: true,
        data: {
          period: { startDate, endDate },
          summary: {
            expenseCount,
            totalExpenses: Math.round(totalExpenses * 100) / 100
          },
          byCategory,
          billable: billableTotal,
          nonBillable: nonBillableTotal
        }
      });
    } catch (error) {
      console.error('Error generating expense report:', error);
      return res.status(500).json({ success: false, error: 'Failed to generate expense report' });
    }
  });

  return router;
};
