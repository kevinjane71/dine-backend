const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');
const { getNextNumber } = require('../services/numberingService');
const { calculateInvoiceTotals } = require('../services/invoiceService');

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

  // GET / — List challans
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      let query = db.collection(collections.invChallans)
        .where('orgId', '==', orgId);

      if (req.query.status && req.query.status !== 'all') {
        query = query.where('status', '==', req.query.status);
      }

      if (req.query.customerId) {
        query = query.where('customerId', '==', req.query.customerId);
      }

      query = query.orderBy('createdAt', 'desc');

      const limit = parseInt(req.query.limit) || 50;
      query = query.limit(limit);

      const snapshot = await query.get();
      let challans = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      if (req.query.search) {
        const s = req.query.search.toLowerCase();
        challans = challans.filter(c =>
          (c.challanNumber || '').toLowerCase().includes(s) ||
          (c.customerName || '').toLowerCase().includes(s)
        );
      }

      return res.json({ success: true, data: challans });
    } catch (error) {
      console.error('Error listing challans:', error);
      return res.status(500).json({ success: false, error: 'Failed to list challans' });
    }
  });

  // GET /next-number — Preview next auto-number (read-only, does not increment)
  router.get('/next-number', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const type = 'challan';
      const defaultPrefix = 'DC-';
      const docId = `${orgId}_${type}`;
      const seqRef = db.collection(collections.invNumberSequences).doc(docId);
      const seqDoc = await seqRef.get();

      let nextNumber;
      if (!seqDoc.exists) {
        const settingsSnap = await db.collection(collections.invSettings)
          .where('orgId', '==', orgId).limit(1).get();

        let prefix = defaultPrefix;
        let startNumber = 1;

        if (!settingsSnap.empty) {
          const settings = settingsSnap.docs[0].data();
          if (settings[`${type}NumberPrefix`]) prefix = settings[`${type}NumberPrefix`];
        }

        nextNumber = `${prefix}${String(startNumber).padStart(6, '0')}`;
      } else {
        const seqData = seqDoc.data();
        const prefix = seqData.prefix || defaultPrefix;
        nextNumber = `${prefix}${String((seqData.currentNumber || 0) + 1).padStart(6, '0')}`;
      }

      return res.json({ success: true, data: { nextNumber } });
    } catch (error) {
      console.error('Error getting next challan number:', error);
      return res.status(500).json({ success: false, error: 'Failed to get next number' });
    }
  });

  // GET /:id — Get single challan
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invChallans).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Challan not found' });
      }

      const challanData = { id: doc.id, ...doc.data() };

      if (challanData.customerId) {
        const customerDoc = await db.collection(collections.invCustomers).doc(challanData.customerId).get();
        if (customerDoc.exists) {
          challanData.customer = { id: customerDoc.id, ...customerDoc.data() };
        }
      }

      return res.json({ success: true, data: challanData });
    } catch (error) {
      console.error('Error getting challan:', error);
      return res.status(500).json({ success: false, error: 'Failed to get challan' });
    }
  });

  // POST / — Create challan (auto-number)
  router.post('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const {
        customerId, referenceNumber, challanDate, challanType,
        items, discountAmount, adjustments
      } = req.body;

      if (!customerId) {
        return res.status(400).json({ success: false, error: 'Customer ID is required' });
      }

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one item is required' });
      }

      const validTypes = ['supply_on_approval', 'job_work', 'supply_return'];
      if (challanType && !validTypes.includes(challanType)) {
        return res.status(400).json({ success: false, error: 'Invalid challan type' });
      }

      // Verify customer
      const customerDoc = await db.collection(collections.invCustomers).doc(customerId).get();
      if (!customerDoc.exists || customerDoc.data().orgId !== orgId) {
        return res.status(400).json({ success: false, error: 'Invalid customer' });
      }

      const challanNumber = await getNextNumber(db, collections, orgId, 'challan');

      const processedItems = items.map(item => ({
        itemId: item.itemId || '',
        name: item.name || '',
        description: item.description || '',
        quantity: parseFloat(item.quantity) || 1,
        rate: parseFloat(item.rate) || 0,
        amount: (parseFloat(item.quantity) || 1) * (parseFloat(item.rate) || 0)
      }));

      const subtotal = processedItems.reduce((sum, item) => sum + item.amount, 0);
      const disc = parseFloat(discountAmount) || 0;
      const adj = parseFloat(adjustments) || 0;
      const total = Math.max(0, subtotal - disc + adj);

      const challanData = {
        orgId,
        customerId,
        challanNumber,
        referenceNumber: referenceNumber || '',
        challanDate: challanDate || new Date().toISOString().split('T')[0],
        challanType: challanType || 'supply_on_approval',
        items: processedItems,
        subtotal: Math.round(subtotal * 100) / 100,
        discountAmount: Math.round(disc * 100) / 100,
        adjustments: Math.round(adj * 100) / 100,
        total: Math.round(total * 100) / 100,
        status: 'draft',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invChallans).add(challanData);

      return res.status(201).json({
        success: true,
        data: { id: docRef.id, ...challanData }
      });
    } catch (error) {
      console.error('Error creating challan:', error);
      return res.status(500).json({ success: false, error: 'Failed to create challan' });
    }
  });

  // PATCH /:id — Update challan
  router.patch('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invChallans).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Challan not found' });
      }

      const existing = doc.data();
      const allowedFields = ['customerId', 'referenceNumber', 'challanDate', 'challanType', 'items', 'discountAmount', 'adjustments', 'status'];
      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      // Validate challan type if provided
      if (updateData.challanType) {
        const validTypes = ['supply_on_approval', 'job_work', 'supply_return'];
        if (!validTypes.includes(updateData.challanType)) {
          return res.status(400).json({ success: false, error: 'Invalid challan type' });
        }
      }

      // Validate status if provided
      if (updateData.status) {
        const validStatuses = ['draft', 'sent', 'returned'];
        if (!validStatuses.includes(updateData.status)) {
          return res.status(400).json({ success: false, error: 'Invalid status' });
        }
      }

      // Recalculate totals if items or discount changed
      if (updateData.items || updateData.discountAmount !== undefined || updateData.adjustments !== undefined) {
        if (updateData.items) {
          updateData.items = updateData.items.map(item => ({
            itemId: item.itemId || '',
            name: item.name || '',
            description: item.description || '',
            quantity: parseFloat(item.quantity) || 1,
            rate: parseFloat(item.rate) || 0,
            amount: (parseFloat(item.quantity) || 1) * (parseFloat(item.rate) || 0)
          }));
        }

        const itemsToCalc = updateData.items || existing.items;
        const subtotal = itemsToCalc.reduce((sum, item) => sum + (item.amount || 0), 0);
        const disc = updateData.discountAmount !== undefined ? parseFloat(updateData.discountAmount) || 0 : existing.discountAmount || 0;
        const adj = updateData.adjustments !== undefined ? parseFloat(updateData.adjustments) || 0 : existing.adjustments || 0;

        updateData.subtotal = Math.round(subtotal * 100) / 100;
        updateData.total = Math.round(Math.max(0, subtotal - disc + adj) * 100) / 100;
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invChallans).doc(req.params.id).update(updateData);

      const updated = await db.collection(collections.invChallans).doc(req.params.id).get();

      return res.json({
        success: true,
        data: { id: updated.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating challan:', error);
      return res.status(500).json({ success: false, error: 'Failed to update challan' });
    }
  });

  // DELETE /:id — Delete draft challans
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invChallans).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Challan not found' });
      }

      if (doc.data().status !== 'draft') {
        return res.status(400).json({ success: false, error: 'Only draft challans can be deleted' });
      }

      await db.collection(collections.invChallans).doc(req.params.id).delete();

      return res.json({ success: true, data: { message: 'Challan deleted successfully' } });
    } catch (error) {
      console.error('Error deleting challan:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete challan' });
    }
  });

  return router;
};
