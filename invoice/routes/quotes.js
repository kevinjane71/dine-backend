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

  // GET / — List quotes
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      let query = db.collection(collections.invQuotes)
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
      let quotes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      if (req.query.search) {
        const s = req.query.search.toLowerCase();
        quotes = quotes.filter(q =>
          (q.quoteNumber || '').toLowerCase().includes(s) ||
          (q.customerName || '').toLowerCase().includes(s)
        );
      }

      return res.json({ success: true, data: quotes });
    } catch (error) {
      console.error('Error listing quotes:', error);
      return res.status(500).json({ success: false, error: 'Failed to list quotes' });
    }
  });

  // GET /next-number — Preview next auto-number (read-only, does not increment)
  router.get('/next-number', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const type = 'quote';
      const defaultPrefix = 'QT-';
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
      console.error('Error getting next quote number:', error);
      return res.status(500).json({ success: false, error: 'Failed to get next number' });
    }
  });

  // GET /:id — Get single quote
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invQuotes).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Quote not found' });
      }

      const quoteData = { id: doc.id, ...doc.data() };

      if (quoteData.customerId) {
        const customerDoc = await db.collection(collections.invCustomers).doc(quoteData.customerId).get();
        if (customerDoc.exists) {
          quoteData.customer = { id: customerDoc.id, ...customerDoc.data() };
        }
      }

      return res.json({ success: true, data: quoteData });
    } catch (error) {
      console.error('Error getting quote:', error);
      return res.status(500).json({ success: false, error: 'Failed to get quote' });
    }
  });

  // POST / — Create quote (auto-number)
  router.post('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const {
        customerId, referenceNumber, quoteDate, expiryDate, salesperson,
        projectName, subject, items, discountType, discountValue,
        customerNotes, termsAndConditions
      } = req.body;

      if (!customerId) {
        return res.status(400).json({ success: false, error: 'Customer ID is required' });
      }

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: 'At least one item is required' });
      }

      // Verify customer
      const customerDoc = await db.collection(collections.invCustomers).doc(customerId).get();
      if (!customerDoc.exists || customerDoc.data().orgId !== orgId) {
        return res.status(400).json({ success: false, error: 'Invalid customer' });
      }

      const quoteNumber = await getNextNumber(db, collections, orgId, 'quote');

      const processedItems = items.map(item => ({
        itemId: item.itemId || '',
        name: item.name || '',
        description: item.description || '',
        quantity: parseFloat(item.quantity) || 1,
        rate: parseFloat(item.rate) || 0,
        taxRate: parseFloat(item.taxRate) || 0,
        amount: (parseFloat(item.quantity) || 1) * (parseFloat(item.rate) || 0)
      }));

      const totals = calculateInvoiceTotals(processedItems, discountType, discountValue, 0);

      const quoteData = {
        orgId,
        customerId,
        quoteNumber,
        referenceNumber: referenceNumber || '',
        quoteDate: quoteDate || new Date().toISOString().split('T')[0],
        expiryDate: expiryDate || '',
        salesperson: salesperson || '',
        projectName: projectName || '',
        subject: subject || '',
        items: processedItems,
        subtotal: totals.subtotal,
        discountType: discountType || 'fixed',
        discountValue: parseFloat(discountValue) || 0,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        customerNotes: customerNotes || '',
        termsAndConditions: termsAndConditions || '',
        status: 'draft',
        convertedInvoiceId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invQuotes).add(quoteData);

      return res.status(201).json({
        success: true,
        data: { id: docRef.id, ...quoteData }
      });
    } catch (error) {
      console.error('Error creating quote:', error);
      return res.status(500).json({ success: false, error: 'Failed to create quote' });
    }
  });

  // PATCH /:id — Update quote
  router.patch('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invQuotes).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Quote not found' });
      }

      const existing = doc.data();
      if (existing.status === 'invoiced') {
        return res.status(400).json({ success: false, error: 'Cannot update a quote that has been converted to an invoice' });
      }

      const allowedFields = ['customerId', 'referenceNumber', 'quoteDate', 'expiryDate', 'salesperson', 'projectName', 'subject', 'items', 'discountType', 'discountValue', 'customerNotes', 'termsAndConditions', 'status'];
      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      // Recalculate totals if items or discount changed
      if (updateData.items || updateData.discountType !== undefined || updateData.discountValue !== undefined) {
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

        const itemsToCalc = updateData.items || existing.items;
        const dType = updateData.discountType !== undefined ? updateData.discountType : existing.discountType;
        const dValue = updateData.discountValue !== undefined ? updateData.discountValue : existing.discountValue;

        const totals = calculateInvoiceTotals(itemsToCalc, dType, dValue, 0);
        updateData.subtotal = totals.subtotal;
        updateData.discountAmount = totals.discountAmount;
        updateData.taxAmount = totals.taxAmount;
        updateData.total = totals.total;
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invQuotes).doc(req.params.id).update(updateData);

      const updated = await db.collection(collections.invQuotes).doc(req.params.id).get();

      return res.json({
        success: true,
        data: { id: updated.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating quote:', error);
      return res.status(500).json({ success: false, error: 'Failed to update quote' });
    }
  });

  // POST /:id/send — Mark as sent
  router.post('/:id/send', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invQuotes).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Quote not found' });
      }

      await db.collection(collections.invQuotes).doc(req.params.id).update({
        status: 'sent',
        updatedAt: FieldValue.serverTimestamp()
      });

      return res.json({ success: true, data: { message: 'Quote marked as sent' } });
    } catch (error) {
      console.error('Error sending quote:', error);
      return res.status(500).json({ success: false, error: 'Failed to send quote' });
    }
  });

  // POST /:id/convert — Convert quote to invoice
  router.post('/:id/convert', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const quoteDoc = await db.collection(collections.invQuotes).doc(req.params.id).get();
      if (!quoteDoc.exists || quoteDoc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Quote not found' });
      }

      const quote = quoteDoc.data();
      if (quote.status === 'invoiced') {
        return res.status(400).json({ success: false, error: 'Quote has already been converted to an invoice' });
      }

      if (quote.status === 'declined') {
        return res.status(400).json({ success: false, error: 'Cannot convert a declined quote' });
      }

      // Generate invoice number
      const invoiceNumber = await getNextNumber(db, collections, orgId, 'invoice');

      // Create invoice from quote data
      const invoiceData = {
        orgId,
        customerId: quote.customerId,
        invoiceNumber,
        referenceNumber: quote.referenceNumber || '',
        invoiceDate: new Date().toISOString().split('T')[0],
        dueDate: '',
        paymentTerms: 'due_on_receipt',
        salesperson: quote.salesperson || '',
        items: quote.items || [],
        subtotal: quote.subtotal || 0,
        discountType: quote.discountType || 'fixed',
        discountValue: quote.discountValue || 0,
        discountAmount: quote.discountAmount || 0,
        taxAmount: quote.taxAmount || 0,
        taxBreakdown: [],
        adjustments: 0,
        total: quote.total || 0,
        customerNotes: quote.customerNotes || 'Thanks for your business.',
        termsAndConditions: quote.termsAndConditions || '',
        status: 'draft',
        paidAmount: 0,
        balanceDue: quote.total || 0,
        attachments: [],
        sourceApp: 'standalone',
        sourceRef: `quote:${req.params.id}`,
        sentAt: null,
        paidAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const invoiceRef = await db.collection(collections.invInvoices).add(invoiceData);

      // Update quote status to invoiced
      await db.collection(collections.invQuotes).doc(req.params.id).update({
        status: 'invoiced',
        convertedInvoiceId: invoiceRef.id,
        updatedAt: FieldValue.serverTimestamp()
      });

      return res.status(201).json({
        success: true,
        data: {
          invoice: { id: invoiceRef.id, ...invoiceData },
          quoteId: req.params.id
        }
      });
    } catch (error) {
      console.error('Error converting quote:', error);
      return res.status(500).json({ success: false, error: 'Failed to convert quote to invoice' });
    }
  });

  // DELETE /:id — Delete draft quotes
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invQuotes).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Quote not found' });
      }

      if (doc.data().status !== 'draft') {
        return res.status(400).json({ success: false, error: 'Only draft quotes can be deleted' });
      }

      await db.collection(collections.invQuotes).doc(req.params.id).delete();

      return res.json({ success: true, data: { message: 'Quote deleted successfully' } });
    } catch (error) {
      console.error('Error deleting quote:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete quote' });
    }
  });

  return router;
};
