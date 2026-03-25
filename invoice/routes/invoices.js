const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');
const { getNextNumber } = require('../services/numberingService');
const { calculateInvoiceTotals, updateInvoiceStatus } = require('../services/invoiceService');

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

  // GET / — List invoices with status filter, date range, pagination
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      let query = db.collection(collections.invInvoices)
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

      if (req.query.startAfter) {
        const startDoc = await db.collection(collections.invInvoices).doc(req.query.startAfter).get();
        if (startDoc.exists) {
          query = query.startAfter(startDoc);
        }
      }

      const snapshot = await query.get();
      let invoices = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Date range filtering (client-side since Firestore limits compound queries)
      if (req.query.startDate) {
        const start = new Date(req.query.startDate);
        invoices = invoices.filter(inv => {
          const d = inv.invoiceDate ? new Date(inv.invoiceDate) : null;
          return d && d >= start;
        });
      }
      if (req.query.endDate) {
        const end = new Date(req.query.endDate);
        end.setHours(23, 59, 59, 999);
        invoices = invoices.filter(inv => {
          const d = inv.invoiceDate ? new Date(inv.invoiceDate) : null;
          return d && d <= end;
        });
      }

      if (req.query.search) {
        const s = req.query.search.toLowerCase();
        invoices = invoices.filter(inv =>
          (inv.invoiceNumber || '').toLowerCase().includes(s) ||
          (inv.customerName || '').toLowerCase().includes(s)
        );
      }

      return res.json({
        success: true,
        data: invoices,
        hasMore: snapshot.docs.length === limit,
        lastId: snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1].id : null
      });
    } catch (error) {
      console.error('Error listing invoices:', error);
      return res.status(500).json({ success: false, error: 'Failed to list invoices' });
    }
  });

  // GET /next-number — Preview next auto-number (read-only, does not increment)
  router.get('/next-number', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const type = 'invoice';
      const defaultPrefix = 'INV-';
      const docId = `${orgId}_${type}`;
      const seqRef = db.collection(collections.invNumberSequences).doc(docId);
      const seqDoc = await seqRef.get();

      let nextNumber;
      if (!seqDoc.exists) {
        // Check settings for custom prefix and start number
        const settingsSnap = await db.collection(collections.invSettings)
          .where('orgId', '==', orgId).limit(1).get();

        let prefix = defaultPrefix;
        let startNumber = 1;

        if (!settingsSnap.empty) {
          const settings = settingsSnap.docs[0].data();
          if (settings[`${type}NumberPrefix`]) prefix = settings[`${type}NumberPrefix`];
          if (settings.invoiceStartNumber) startNumber = settings.invoiceStartNumber;
        }

        nextNumber = `${prefix}${String(startNumber).padStart(6, '0')}`;
      } else {
        const seqData = seqDoc.data();
        const prefix = seqData.prefix || defaultPrefix;
        nextNumber = `${prefix}${String((seqData.currentNumber || 0) + 1).padStart(6, '0')}`;
      }

      return res.json({ success: true, data: { nextNumber } });
    } catch (error) {
      console.error('Error getting next invoice number:', error);
      return res.status(500).json({ success: false, error: 'Failed to get next number' });
    }
  });

  // GET /:id — Get single invoice (with customer details)
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invInvoices).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      }

      const invoiceData = { id: doc.id, ...doc.data() };

      // Fetch customer details if customerId present
      if (invoiceData.customerId) {
        const customerDoc = await db.collection(collections.invCustomers).doc(invoiceData.customerId).get();
        if (customerDoc.exists) {
          invoiceData.customer = { id: customerDoc.id, ...customerDoc.data() };
        }
      }

      return res.json({ success: true, data: invoiceData });
    } catch (error) {
      console.error('Error getting invoice:', error);
      return res.status(500).json({ success: false, error: 'Failed to get invoice' });
    }
  });

  // POST / — Create invoice (auto-generate number, calculate totals)
  router.post('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const {
        customerId, referenceNumber, invoiceDate, dueDate, paymentTerms,
        salesperson, items, discountType, discountValue, adjustments,
        customerNotes, termsAndConditions, sourceApp, sourceRef
      } = req.body;

      if (!customerId) {
        return res.status(400).json({ success: false, error: 'Customer ID is required' });
      }

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one item is required' });
      }

      // Verify customer exists and belongs to this org
      const customerDoc = await db.collection(collections.invCustomers).doc(customerId).get();
      if (!customerDoc.exists || customerDoc.data().orgId !== orgId) {
        return res.status(400).json({ success: false, error: 'Invalid customer' });
      }

      // Auto-generate invoice number
      const invoiceNumber = await getNextNumber(db, collections, orgId, 'invoice');

      // Process line items with amounts
      const processedItems = items.map(item => ({
        itemId: item.itemId || '',
        name: item.name || '',
        description: item.description || '',
        quantity: parseFloat(item.quantity) || 1,
        rate: parseFloat(item.rate) || 0,
        taxRate: parseFloat(item.taxRate) || 0,
        amount: (parseFloat(item.quantity) || 1) * (parseFloat(item.rate) || 0)
      }));

      // Calculate totals
      const totals = calculateInvoiceTotals(processedItems, discountType, discountValue, adjustments);

      const invoiceData = {
        orgId,
        customerId,
        invoiceNumber,
        referenceNumber: referenceNumber || '',
        invoiceDate: invoiceDate || new Date().toISOString().split('T')[0],
        dueDate: dueDate || '',
        paymentTerms: paymentTerms || 'due_on_receipt',
        salesperson: salesperson || '',
        items: processedItems,
        subtotal: totals.subtotal,
        discountType: discountType || 'fixed',
        discountValue: parseFloat(discountValue) || 0,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        taxBreakdown: totals.taxBreakdown,
        adjustments: parseFloat(adjustments) || 0,
        total: totals.total,
        customerNotes: customerNotes !== undefined ? customerNotes : 'Thanks for your business.',
        termsAndConditions: termsAndConditions || '',
        status: 'draft',
        paidAmount: 0,
        balanceDue: totals.total,
        attachments: [],
        sourceApp: sourceApp || 'standalone',
        sourceRef: sourceRef || '',
        sentAt: null,
        paidAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invInvoices).add(invoiceData);

      return res.status(201).json({
        success: true,
        data: { id: docRef.id, ...invoiceData }
      });
    } catch (error) {
      console.error('Error creating invoice:', error);
      return res.status(500).json({ success: false, error: 'Failed to create invoice' });
    }
  });

  // PATCH /:id — Update invoice
  router.patch('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invInvoices).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      }

      const existing = doc.data();
      if (existing.status === 'void') {
        return res.status(400).json({ success: false, error: 'Cannot update a voided invoice' });
      }

      const allowedFields = ['customerId', 'referenceNumber', 'invoiceDate', 'dueDate', 'paymentTerms', 'salesperson', 'items', 'discountType', 'discountValue', 'adjustments', 'customerNotes', 'termsAndConditions', 'attachments'];
      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      // Recalculate totals if items or discount changed
      if (updateData.items || updateData.discountType !== undefined || updateData.discountValue !== undefined || updateData.adjustments !== undefined) {
        const itemsToCalc = updateData.items || existing.items;
        const dType = updateData.discountType !== undefined ? updateData.discountType : existing.discountType;
        const dValue = updateData.discountValue !== undefined ? updateData.discountValue : existing.discountValue;
        const adj = updateData.adjustments !== undefined ? updateData.adjustments : existing.adjustments;

        // Process items
        if (updateData.items) {
          updateData.items = updateData.items.map(item => ({
            itemId: item.itemId || '',
            name: item.name || '',
            description: item.description || '',
            quantity: parseFloat(item.quantity) || 1,
            rate: parseFloat(item.rate) || 0,
            taxRate: parseFloat(item.taxRate) || 0,
            amount: (parseFloat(item.quantity) || 1) * (parseFloat(item.rate) || 0)
          }));
        }

        const totals = calculateInvoiceTotals(updateData.items || existing.items, dType, dValue, adj);
        updateData.subtotal = totals.subtotal;
        updateData.discountAmount = totals.discountAmount;
        updateData.taxAmount = totals.taxAmount;
        updateData.taxBreakdown = totals.taxBreakdown;
        updateData.total = totals.total;
        updateData.balanceDue = totals.total - (existing.paidAmount || 0);
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invInvoices).doc(req.params.id).update(updateData);

      const updated = await db.collection(collections.invInvoices).doc(req.params.id).get();

      return res.json({
        success: true,
        data: { id: updated.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating invoice:', error);
      return res.status(500).json({ success: false, error: 'Failed to update invoice' });
    }
  });

  // POST /:id/send — Mark as sent
  router.post('/:id/send', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invInvoices).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      }

      if (doc.data().status === 'void') {
        return res.status(400).json({ success: false, error: 'Cannot send a voided invoice' });
      }

      await updateInvoiceStatus(db, collections, req.params.id, 'sent');

      return res.json({ success: true, data: { message: 'Invoice marked as sent' } });
    } catch (error) {
      console.error('Error sending invoice:', error);
      return res.status(500).json({ success: false, error: 'Failed to send invoice' });
    }
  });

  // POST /:id/void — Void invoice
  router.post('/:id/void', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invInvoices).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      }

      if (doc.data().status === 'paid') {
        return res.status(400).json({ success: false, error: 'Cannot void a paid invoice. Delete associated payments first.' });
      }

      await updateInvoiceStatus(db, collections, req.params.id, 'void');

      return res.json({ success: true, data: { message: 'Invoice voided successfully' } });
    } catch (error) {
      console.error('Error voiding invoice:', error);
      return res.status(500).json({ success: false, error: 'Failed to void invoice' });
    }
  });

  // DELETE /:id — Delete draft invoices only
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invInvoices).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Invoice not found' });
      }

      if (doc.data().status !== 'draft') {
        return res.status(400).json({ success: false, error: 'Only draft invoices can be deleted' });
      }

      await db.collection(collections.invInvoices).doc(req.params.id).delete();

      return res.json({ success: true, data: { message: 'Invoice deleted successfully' } });
    } catch (error) {
      console.error('Error deleting invoice:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete invoice' });
    }
  });

  return router;
};
