const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');
const { getNextNumber } = require('../services/numberingService');

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

  // GET / — List payments (filter by customer, invoice)
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      let query = db.collection(collections.invPayments)
        .where('orgId', '==', orgId);

      if (req.query.customerId) {
        query = query.where('customerId', '==', req.query.customerId);
      }

      if (req.query.invoiceId) {
        query = query.where('invoiceId', '==', req.query.invoiceId);
      }

      query = query.orderBy('createdAt', 'desc');

      const limit = parseInt(req.query.limit) || 50;
      query = query.limit(limit);

      const snapshot = await query.get();
      const payments = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      return res.json({ success: true, data: payments });
    } catch (error) {
      console.error('Error listing payments:', error);
      return res.status(500).json({ success: false, error: 'Failed to list payments' });
    }
  });

  // GET /:id — Get single payment
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invPayments).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Payment not found' });
      }

      return res.json({ success: true, data: { id: doc.id, ...doc.data() } });
    } catch (error) {
      console.error('Error getting payment:', error);
      return res.status(500).json({ success: false, error: 'Failed to get payment' });
    }
  });

  // POST / — Record payment (link to invoice, update invoice paidAmount/status)
  router.post('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const { customerId, invoiceId, paymentDate, amount, paymentMode, referenceNumber, notes } = req.body;

      if (!invoiceId) {
        return res.status(400).json({ success: false, error: 'Invoice ID is required' });
      }

      if (!amount || parseFloat(amount) <= 0) {
        return res.status(400).json({ success: false, error: 'A positive payment amount is required' });
      }

      // Verify invoice exists and belongs to this org
      const invoiceDoc = await db.collection(collections.invInvoices).doc(invoiceId).get();
      if (!invoiceDoc.exists || invoiceDoc.data().orgId !== orgId) {
        return res.status(400).json({ success: false, error: 'Invalid invoice' });
      }

      const invoice = invoiceDoc.data();
      if (invoice.status === 'void') {
        return res.status(400).json({ success: false, error: 'Cannot record payment for a voided invoice' });
      }

      const paymentAmount = parseFloat(amount);
      const currentPaid = invoice.paidAmount || 0;
      const newPaidAmount = Math.round((currentPaid + paymentAmount) * 100) / 100;
      const invoiceTotal = invoice.total || 0;

      if (newPaidAmount > invoiceTotal) {
        return res.status(400).json({
          success: false,
          error: `Payment amount exceeds balance due. Balance: ${Math.round((invoiceTotal - currentPaid) * 100) / 100}`
        });
      }

      const paymentNumber = await getNextNumber(db, collections, orgId, 'payment');

      const validModes = ['cash', 'bank', 'upi', 'card', 'cheque', 'other'];
      const mode = validModes.includes(paymentMode) ? paymentMode : 'other';

      const paymentData = {
        orgId,
        customerId: customerId || invoice.customerId,
        invoiceId,
        paymentNumber,
        paymentDate: paymentDate || new Date().toISOString().split('T')[0],
        amount: paymentAmount,
        paymentMode: mode,
        referenceNumber: referenceNumber || '',
        notes: notes || '',
        createdAt: FieldValue.serverTimestamp()
      };

      // Use a batch to atomically create payment and update invoice
      const batch = db.batch();

      const paymentRef = db.collection(collections.invPayments).doc();
      batch.set(paymentRef, paymentData);

      // Update invoice paidAmount and status
      const newBalanceDue = Math.round((invoiceTotal - newPaidAmount) * 100) / 100;
      const newStatus = newBalanceDue <= 0 ? 'paid' : invoice.status === 'draft' ? 'sent' : invoice.status;

      const invoiceUpdate = {
        paidAmount: newPaidAmount,
        balanceDue: newBalanceDue,
        status: newStatus,
        updatedAt: FieldValue.serverTimestamp()
      };

      if (newStatus === 'paid') {
        invoiceUpdate.paidAt = FieldValue.serverTimestamp();
      }

      batch.update(db.collection(collections.invInvoices).doc(invoiceId), invoiceUpdate);

      await batch.commit();

      return res.status(201).json({
        success: true,
        data: { id: paymentRef.id, ...paymentData }
      });
    } catch (error) {
      console.error('Error recording payment:', error);
      return res.status(500).json({ success: false, error: 'Failed to record payment' });
    }
  });

  // DELETE /:id — Delete payment (reverse invoice paidAmount)
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const paymentDoc = await db.collection(collections.invPayments).doc(req.params.id).get();
      if (!paymentDoc.exists || paymentDoc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Payment not found' });
      }

      const payment = paymentDoc.data();

      // Reverse the payment on the invoice
      const invoiceDoc = await db.collection(collections.invInvoices).doc(payment.invoiceId).get();

      const batch = db.batch();

      // Delete the payment
      batch.delete(db.collection(collections.invPayments).doc(req.params.id));

      // Update invoice if it still exists
      if (invoiceDoc.exists) {
        const invoice = invoiceDoc.data();
        const newPaidAmount = Math.max(0, Math.round(((invoice.paidAmount || 0) - payment.amount) * 100) / 100);
        const newBalanceDue = Math.round(((invoice.total || 0) - newPaidAmount) * 100) / 100;

        // Revert status from paid if needed
        let newStatus = invoice.status;
        if (invoice.status === 'paid' && newBalanceDue > 0) {
          newStatus = 'sent';
        }

        batch.update(db.collection(collections.invInvoices).doc(payment.invoiceId), {
          paidAmount: newPaidAmount,
          balanceDue: newBalanceDue,
          status: newStatus,
          paidAt: newStatus !== 'paid' ? null : invoice.paidAt,
          updatedAt: FieldValue.serverTimestamp()
        });
      }

      await batch.commit();

      return res.json({ success: true, data: { message: 'Payment deleted and invoice updated' } });
    } catch (error) {
      console.error('Error deleting payment:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete payment' });
    }
  });

  return router;
};
