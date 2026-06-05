const express = require('express');
const router = express.Router();
const { FieldValue } = require('firebase-admin/firestore');
const { createExpenseEntry } = require('./helpers');
const { getCachedRestDoc } = require('../../utils/kvCache');

module.exports = function(db, collections, authenticateToken, checkFeaturePermission) {

  // POST /api/bookings/:restaurantId/:bookingId/payment — Record payment
  router.post('/:restaurantId/:bookingId/payment', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'update'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, bookingId } = req.params;
      const { amount, method, note, type } = req.body;

      if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount is required' });

      const doc = await db.collection(collections.bookings).doc(bookingId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Booking not found' });
      if (doc.data().restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      const booking = doc.data();
      const newPayment = {
        amount: Number(amount),
        method: method || 'cash',
        date: new Date().toISOString(),
        note: note || null,
        type: type || 'partial',
      };

      const updatedPayments = [...(booking.payments || []), newPayment];
      const paidAmount = updatedPayments.reduce((s, p) => s + (p.amount || 0), 0);
      const totalAmount = booking.totalAmount || 0;
      const balanceAmount = Math.max(0, totalAmount - paidAmount);

      let paymentStatus = 'unpaid';
      if (paidAmount >= totalAmount && totalAmount > 0) paymentStatus = 'paid';
      else if (paidAmount > 0) paymentStatus = updatedPayments.some(p => p.type === 'advance') ? 'advance_paid' : 'partial';

      await db.collection(collections.bookings).doc(bookingId).update({
        payments: updatedPayments,
        paidAmount,
        balanceAmount,
        paymentStatus,
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({
        success: true,
        paidAmount,
        balanceAmount,
        paymentStatus,
        payments: updatedPayments,
      });
    } catch (error) {
      console.error('Record payment error:', error);
      res.status(500).json({ error: 'Failed to record payment' });
    }
  });

  // POST /api/bookings/:restaurantId/:bookingId/complete — Mark booking complete
  router.post('/:restaurantId/:bookingId/complete', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'complete'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, bookingId } = req.params;

      const doc = await db.collection(collections.bookings).doc(bookingId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Booking not found' });
      if (doc.data().restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      const booking = doc.data();

      if (booking.status === 'completed') {
        return res.status(400).json({ error: 'Booking is already completed' });
      }
      if (booking.status === 'cancelled') {
        return res.status(400).json({ error: 'Cannot complete a cancelled booking' });
      }

      const updateData = {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      // Create expense entry if flagged
      let expenseId = null;
      if (booking.trackExpense && !booking.expenseCreated) {
        try {
          const userId = req.user.userId || req.user.id;
          expenseId = await createExpenseEntry(db, collections, { ...booking, id: bookingId }, userId);
          updateData.expenseCreated = true;
        } catch (err) {
          console.error('Failed to create expense entry:', err);
          // Don't fail the completion for expense error
        }
      }

      // Update customer stats (totalSpent, totalOrders)
      if (booking.customer?.id) {
        try {
          await db.collection(collections.customers).doc(booking.customer.id).update({
            totalOrders: FieldValue.increment(1),
            totalSpent: FieldValue.increment(booking.totalAmount || 0),
            lastOrderDate: new Date(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        } catch (err) {
          console.error('Failed to update customer stats:', err);
        }
      }

      await db.collection(collections.bookings).doc(bookingId).update(updateData);

      res.json({ success: true, expenseId });
    } catch (error) {
      console.error('Complete booking error:', error);
      res.status(500).json({ error: 'Failed to complete booking' });
    }
  });

  // POST /api/bookings/:restaurantId/:bookingId/invoice — Generate invoice data
  router.post('/:restaurantId/:bookingId/invoice', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'read'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, bookingId } = req.params;

      const doc = await db.collection(collections.bookings).doc(bookingId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Booking not found' });
      if (doc.data().restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      const booking = doc.data();

      // Get restaurant info for invoice header
      const restaurantDoc = await getCachedRestDoc(db, collections.restaurants, restaurantId);
      const restaurant = restaurantDoc.exists ? restaurantDoc.data() : {};

      const invoice = {
        bookingNumber: booking.bookingNumber,
        type: booking.type,
        date: new Date().toISOString().split('T')[0],
        restaurant: {
          name: restaurant.name || '',
          address: restaurant.address || '',
          phone: restaurant.phone || '',
          email: restaurant.email || '',
          gst: restaurant.gstNumber || '',
        },
        customer: booking.customer,
        event: {
          name: booking.eventName,
          date: booking.eventDate,
          endDate: booking.eventEndDate,
          time: booking.eventTime,
          endTime: booking.eventEndTime,
          guestCount: booking.guestCount,
          venue: booking.venue?.venueName || null,
        },
        items: booking.items || [],
        subtotal: booking.subtotal,
        discount: booking.discount,
        taxAmount: booking.taxAmount,
        serviceCharge: booking.serviceCharge,
        totalAmount: booking.totalAmount,
        payments: booking.payments,
        paidAmount: booking.paidAmount,
        balanceAmount: booking.balanceAmount,
        specialInstructions: booking.specialInstructions,
      };

      res.json({ invoice });
    } catch (error) {
      console.error('Generate invoice error:', error);
      res.status(500).json({ error: 'Failed to generate invoice' });
    }
  });

  return router;
};
