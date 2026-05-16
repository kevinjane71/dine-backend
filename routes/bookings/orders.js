const express = require('express');
const router = express.Router();
const { FieldValue } = require('firebase-admin/firestore');
const { generateBookingNumber, checkVenueConflict, syncCustomerData } = require('./helpers');

module.exports = function(db, collections, authenticateToken, checkFeaturePermission) {

  // GET /api/bookings/:restaurantId — List bookings with filters
  router.get('/:restaurantId', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'read'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId } = req.params;
      const { status, type, startDate, endDate, search, page = 1, pageSize = 50 } = req.query;

      let query = db.collection(collections.bookings)
        .where('restaurantId', '==', restaurantId);

      if (status && status !== 'all') {
        query = query.where('status', '==', status);
      }
      if (type && type !== 'all') {
        query = query.where('type', '==', type);
      }

      query = query.orderBy('createdAt', 'desc');

      const snap = await query.limit(500).get();

      let bookings = [];
      snap.forEach(doc => {
        const data = doc.data();
        bookings.push({ id: doc.id, ...data });
      });

      // Apply date filter in memory (Firestore limitation with compound queries)
      if (startDate) {
        bookings = bookings.filter(b => b.eventDate >= startDate);
      }
      if (endDate) {
        bookings = bookings.filter(b => b.eventDate <= endDate);
      }

      // Search filter
      if (search) {
        const s = search.toLowerCase();
        bookings = bookings.filter(b =>
          (b.customer?.name || '').toLowerCase().includes(s) ||
          (b.customer?.phone || '').includes(s) ||
          (b.bookingNumber || '').toLowerCase().includes(s) ||
          (b.eventName || '').toLowerCase().includes(s)
        );
      }

      const total = bookings.length;
      const pageNum = Math.max(1, parseInt(page));
      const size = Math.min(100, Math.max(1, parseInt(pageSize)));
      const paginated = bookings.slice((pageNum - 1) * size, pageNum * size);

      res.json({
        bookings: paginated,
        total,
        page: pageNum,
        pageSize: size,
        totalPages: Math.ceil(total / size),
      });
    } catch (error) {
      console.error('List bookings error:', error);
      res.status(500).json({ error: 'Failed to fetch bookings' });
    }
  });

  // GET /api/bookings/:restaurantId/:bookingId — Get single booking
  router.get('/:restaurantId/:bookingId', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'read'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, bookingId } = req.params;

      // Prevent matching sub-routes
      if (['calendar', 'venues'].includes(bookingId)) return res.status(400).json({ error: 'Invalid booking ID' });

      const doc = await db.collection(collections.bookings).doc(bookingId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Booking not found' });

      const data = doc.data();
      if (data.restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      res.json({ booking: { id: doc.id, ...data } });
    } catch (error) {
      console.error('Get booking error:', error);
      res.status(500).json({ error: 'Failed to fetch booking' });
    }
  });

  // POST /api/bookings/:restaurantId — Create booking
  router.post('/:restaurantId', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'add'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId } = req.params;
      const {
        type, customer, eventName, eventDate, eventEndDate, eventTime, eventEndTime,
        guestCount, specialInstructions, venue, items, subtotal, discount,
        taxAmount, serviceCharge, totalAmount, payments, trackExpense, forceBook
      } = req.body;

      // Validation
      if (!type || !['catering', 'advance_order', 'venue'].includes(type)) {
        return res.status(400).json({ error: 'Invalid booking type' });
      }
      if (!eventDate) {
        return res.status(400).json({ error: 'Event date is required' });
      }
      if (!customer || (!customer.name && !customer.phone)) {
        return res.status(400).json({ error: 'Customer name or phone is required' });
      }

      // Venue conflict check
      if (type === 'venue' && venue && venue.venueId) {
        const conflict = await checkVenueConflict(
          db, collections, restaurantId, venue.venueId,
          eventDate, eventEndDate || null, eventTime || null, eventEndTime || null, null
        );

        if (!conflict.available) {
          // Check if owner override
          const isOwner = req.user.role === 'owner' || req.user.role === 'admin';
          if (!forceBook || !isOwner) {
            // Check venue settings for multiple bookings
            const venueDoc = await db.collection(collections.bookingVenues).doc(venue.venueId).get();
            const venueData = venueDoc.exists ? venueDoc.data() : {};

            if (!venueData.allowMultipleBookings) {
              return res.status(409).json({
                error: 'Venue is already booked for this date/time',
                conflicts: conflict.conflicts
              });
            }

            // Check concurrent limit
            if (conflict.conflicts.length >= (venueData.maxConcurrentBookings || 1)) {
              return res.status(409).json({
                error: 'Maximum concurrent bookings reached for this venue',
                conflicts: conflict.conflicts
              });
            }
          }
        }
      }

      // Generate booking number
      const bookingNumber = await generateBookingNumber(db, collections, restaurantId);

      // Sync customer to customers collection
      let customerId = customer.id || null;
      if (customer.phone) {
        customerId = await syncCustomerData(db, collections, restaurantId, customer);
      }

      // Calculate payment totals
      const paymentList = payments || [];
      const paidAmount = paymentList.reduce((sum, p) => sum + (p.amount || 0), 0);
      const finalTotal = totalAmount || subtotal || 0;
      const balanceAmount = Math.max(0, finalTotal - paidAmount);

      let paymentStatus = 'unpaid';
      if (paidAmount >= finalTotal && finalTotal > 0) paymentStatus = 'paid';
      else if (paidAmount > 0) paymentStatus = paymentList.some(p => p.type === 'advance') ? 'advance_paid' : 'partial';

      const bookingData = {
        restaurantId,
        bookingNumber,
        type,
        customer: {
          id: customerId,
          name: customer.name || '',
          phone: customer.phone || '',
          email: customer.email || null,
          address: customer.address || null,
        },
        eventName: eventName || '',
        eventDate,
        eventEndDate: eventEndDate || null,
        eventTime: eventTime || null,
        eventEndTime: eventEndTime || null,
        guestCount: guestCount || 0,
        specialInstructions: specialInstructions || '',
        venue: type === 'venue' ? (venue || null) : null,
        items: (type !== 'venue') ? (items || []) : [],
        subtotal: subtotal || 0,
        discount: discount || null,
        taxAmount: taxAmount || 0,
        serviceCharge: serviceCharge || 0,
        totalAmount: finalTotal,
        payments: paymentList,
        paidAmount,
        balanceAmount,
        paymentStatus,
        status: 'confirmed',
        trackExpense: trackExpense || false,
        expenseCreated: false,
        createdBy: {
          id: req.user.userId || req.user.id,
          name: req.user.name || '',
          role: req.user.role || '',
        },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        completedAt: null,
        cancelledAt: null,
        cancelReason: null,
      };

      const ref = await db.collection(collections.bookings).add(bookingData);

      res.status(201).json({
        success: true,
        booking: { id: ref.id, ...bookingData, bookingNumber },
      });
    } catch (error) {
      console.error('Create booking error:', error);
      res.status(500).json({ error: 'Failed to create booking' });
    }
  });

  // PATCH /api/bookings/:restaurantId/:bookingId — Update booking
  router.patch('/:restaurantId/:bookingId', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'update'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, bookingId } = req.params;
      const doc = await db.collection(collections.bookings).doc(bookingId).get();

      if (!doc.exists) return res.status(404).json({ error: 'Booking not found' });
      if (doc.data().restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      const existing = doc.data();
      const updates = req.body;

      // If changing venue/date/time, re-check conflicts
      if (updates.venue || updates.eventDate || updates.eventTime || updates.eventEndTime) {
        const venueId = (updates.venue || existing.venue)?.venueId;
        const eDate = updates.eventDate || existing.eventDate;
        const eEndDate = updates.eventEndDate !== undefined ? updates.eventEndDate : existing.eventEndDate;
        const eTime = updates.eventTime !== undefined ? updates.eventTime : existing.eventTime;
        const eEndTime = updates.eventEndTime !== undefined ? updates.eventEndTime : existing.eventEndTime;

        if (venueId && existing.type === 'venue') {
          const conflict = await checkVenueConflict(
            db, collections, restaurantId, venueId,
            eDate, eEndDate, eTime, eEndTime, bookingId
          );

          if (!conflict.available) {
            const venueDoc = await db.collection(collections.bookingVenues).doc(venueId).get();
            const venueData = venueDoc.exists ? venueDoc.data() : {};

            if (!venueData.allowMultipleBookings || conflict.conflicts.length >= (venueData.maxConcurrentBookings || 1)) {
              const isOwner = req.user.role === 'owner' || req.user.role === 'admin';
              if (!updates.forceBook || !isOwner) {
                return res.status(409).json({ error: 'Venue conflict', conflicts: conflict.conflicts });
              }
            }
          }
        }
      }

      // Recalculate payment status if payments/totalAmount changed
      const updateData = { ...updates, updatedAt: FieldValue.serverTimestamp() };
      delete updateData.forceBook;

      if (updates.payments || updates.totalAmount) {
        const paymentList = updates.payments || existing.payments || [];
        const paidAmt = paymentList.reduce((s, p) => s + (p.amount || 0), 0);
        const total = updates.totalAmount || existing.totalAmount || 0;
        updateData.paidAmount = paidAmt;
        updateData.balanceAmount = Math.max(0, total - paidAmt);
        if (paidAmt >= total && total > 0) updateData.paymentStatus = 'paid';
        else if (paidAmt > 0) updateData.paymentStatus = 'partial';
        else updateData.paymentStatus = 'unpaid';
      }

      // Sync customer if updated
      if (updates.customer && updates.customer.phone) {
        await syncCustomerData(db, collections, restaurantId, updates.customer);
      }

      await db.collection(collections.bookings).doc(bookingId).update(updateData);

      const updated = await db.collection(collections.bookings).doc(bookingId).get();
      res.json({ success: true, booking: { id: bookingId, ...updated.data() } });
    } catch (error) {
      console.error('Update booking error:', error);
      res.status(500).json({ error: 'Failed to update booking' });
    }
  });

  // DELETE /api/bookings/:restaurantId/:bookingId — Cancel booking
  router.delete('/:restaurantId/:bookingId', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'delete'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, bookingId } = req.params;
      const { reason } = req.body || {};

      const doc = await db.collection(collections.bookings).doc(bookingId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Booking not found' });
      if (doc.data().restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      await db.collection(collections.bookings).doc(bookingId).update({
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        cancelReason: reason || null,
        updatedAt: FieldValue.serverTimestamp(),
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Cancel booking error:', error);
      res.status(500).json({ error: 'Failed to cancel booking' });
    }
  });

  return router;
};
