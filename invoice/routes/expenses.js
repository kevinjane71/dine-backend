const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');

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

  // GET / — List expenses (filter by category, date range)
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      let query = db.collection(collections.invExpenses)
        .where('orgId', '==', orgId);

      if (req.query.category) {
        query = query.where('category', '==', req.query.category);
      }

      if (req.query.customerId) {
        query = query.where('customerId', '==', req.query.customerId);
      }

      query = query.orderBy('date', 'desc');

      const limit = parseInt(req.query.limit) || 50;
      query = query.limit(limit);

      const snapshot = await query.get();
      let expenses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Date range filtering (client-side)
      if (req.query.startDate) {
        const start = req.query.startDate;
        expenses = expenses.filter(e => e.date >= start);
      }
      if (req.query.endDate) {
        const end = req.query.endDate;
        expenses = expenses.filter(e => e.date <= end);
      }

      return res.json({ success: true, data: expenses });
    } catch (error) {
      console.error('Error listing expenses:', error);
      return res.status(500).json({ success: false, error: 'Failed to list expenses' });
    }
  });

  // GET /:id — Get single expense
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invExpenses).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Expense not found' });
      }

      return res.json({ success: true, data: { id: doc.id, ...doc.data() } });
    } catch (error) {
      console.error('Error getting expense:', error);
      return res.status(500).json({ success: false, error: 'Failed to get expense' });
    }
  });

  // POST / — Create expense
  router.post('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const { date, category, amount, currency, invoiceNumber, notes, customerId, receipt, isBillable } = req.body;

      if (!amount || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A positive amount is required' });
      }

      if (!category) {
        return res.status(400).json({ success: false, error: 'Category is required' });
      }

      const expenseData = {
        orgId,
        date: date || new Date().toISOString().split('T')[0],
        category,
        amount: parseFloat(amount),
        currency: currency || 'INR',
        invoiceNumber: invoiceNumber || '',
        notes: notes || '',
        customerId: customerId || '',
        receipt: receipt || '',
        isBillable: isBillable === true,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invExpenses).add(expenseData);

      return res.status(201).json({
        success: true,
        data: { id: docRef.id, ...expenseData }
      });
    } catch (error) {
      console.error('Error creating expense:', error);
      return res.status(500).json({ success: false, error: 'Failed to create expense' });
    }
  });

  // PATCH /:id — Update expense
  router.patch('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invExpenses).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Expense not found' });
      }

      const allowedFields = ['date', 'category', 'amount', 'currency', 'invoiceNumber', 'notes', 'customerId', 'receipt', 'isBillable'];
      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          if (field === 'amount') {
            updateData[field] = parseFloat(req.body[field]) || 0;
          } else if (field === 'isBillable') {
            updateData[field] = req.body[field] === true;
          } else {
            updateData[field] = req.body[field];
          }
        }
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invExpenses).doc(req.params.id).update(updateData);

      const updated = await db.collection(collections.invExpenses).doc(req.params.id).get();

      return res.json({
        success: true,
        data: { id: updated.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating expense:', error);
      return res.status(500).json({ success: false, error: 'Failed to update expense' });
    }
  });

  // DELETE /:id — Delete expense
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invExpenses).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Expense not found' });
      }

      await db.collection(collections.invExpenses).doc(req.params.id).delete();

      return res.json({ success: true, data: { message: 'Expense deleted successfully' } });
    } catch (error) {
      console.error('Error deleting expense:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete expense' });
    }
  });

  return router;
};
