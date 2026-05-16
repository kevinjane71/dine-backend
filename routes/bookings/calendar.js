const express = require('express');
const router = express.Router();

module.exports = function(db, collections, authenticateToken, checkFeaturePermission) {

  // GET /api/bookings/:restaurantId/calendar — Get bookings for calendar view
  router.get('/:restaurantId/calendar', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'read'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId } = req.params;
      const { startDate, endDate } = req.query;

      if (!startDate || !endDate) {
        return res.status(400).json({ error: 'startDate and endDate are required' });
      }

      // Fetch non-cancelled bookings that overlap with the date range
      const snap = await db.collection(collections.bookings)
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['confirmed', 'in_progress', 'completed'])
        .where('eventDate', '>=', startDate)
        .where('eventDate', '<=', endDate)
        .get();

      const bookings = [];
      snap.forEach(doc => {
        const data = doc.data();
        bookings.push({
          id: doc.id,
          bookingNumber: data.bookingNumber,
          type: data.type,
          eventName: data.eventName,
          eventDate: data.eventDate,
          eventEndDate: data.eventEndDate,
          eventTime: data.eventTime,
          eventEndTime: data.eventEndTime,
          guestCount: data.guestCount,
          customerName: data.customer?.name || '',
          venueName: data.venue?.venueName || null,
          status: data.status,
          paymentStatus: data.paymentStatus,
          totalAmount: data.totalAmount,
        });
      });

      // Also fetch bookings that started before startDate but extend into the range (multi-day)
      const multiDaySnap = await db.collection(collections.bookings)
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['confirmed', 'in_progress', 'completed'])
        .where('eventDate', '<', startDate)
        .where('eventEndDate', '>=', startDate)
        .get();

      multiDaySnap.forEach(doc => {
        const data = doc.data();
        // Avoid duplicates
        if (!bookings.find(b => b.id === doc.id)) {
          bookings.push({
            id: doc.id,
            bookingNumber: data.bookingNumber,
            type: data.type,
            eventName: data.eventName,
            eventDate: data.eventDate,
            eventEndDate: data.eventEndDate,
            eventTime: data.eventTime,
            eventEndTime: data.eventEndTime,
            guestCount: data.guestCount,
            customerName: data.customer?.name || '',
            venueName: data.venue?.venueName || null,
            status: data.status,
            paymentStatus: data.paymentStatus,
            totalAmount: data.totalAmount,
          });
        }
      });

      res.json({ bookings });
    } catch (error) {
      console.error('Calendar bookings error:', error);
      res.status(500).json({ error: 'Failed to fetch calendar data' });
    }
  });

  return router;
};
