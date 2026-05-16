const express = require('express');
const router = express.Router();
const { FieldValue } = require('firebase-admin/firestore');
const { checkVenueConflict } = require('./helpers');

module.exports = function(db, collections, authenticateToken, checkFeaturePermission) {

  // GET /api/bookings/:restaurantId/venues — List venues
  router.get('/:restaurantId/venues', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'read'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId } = req.params;

      const snap = await db.collection(collections.bookingVenues)
        .where('restaurantId', '==', restaurantId)
        .get();

      const venues = [];
      snap.forEach(doc => venues.push({ id: doc.id, ...doc.data() }));

      res.json({ venues });
    } catch (error) {
      console.error('List venues error:', error);
      res.status(500).json({ error: 'Failed to fetch venues' });
    }
  });

  // POST /api/bookings/:restaurantId/venues — Create venue
  router.post('/:restaurantId/venues', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'add'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId } = req.params;
      const { name, capacity, description, hourlyRate, fixedRate, operatingHours, allowMultipleBookings, maxConcurrentBookings, amenities } = req.body;

      if (!name) return res.status(400).json({ error: 'Venue name is required' });

      const venueData = {
        restaurantId,
        name,
        capacity: capacity || 0,
        description: description || '',
        hourlyRate: hourlyRate || null,
        fixedRate: fixedRate || null,
        operatingHours: operatingHours || { start: '08:00', end: '22:00' },
        allowMultipleBookings: allowMultipleBookings || false,
        maxConcurrentBookings: maxConcurrentBookings || 1,
        amenities: amenities || [],
        isActive: true,
        createdAt: FieldValue.serverTimestamp(),
      };

      const ref = await db.collection(collections.bookingVenues).add(venueData);
      res.status(201).json({ success: true, venue: { id: ref.id, ...venueData } });
    } catch (error) {
      console.error('Create venue error:', error);
      res.status(500).json({ error: 'Failed to create venue' });
    }
  });

  // PATCH /api/bookings/:restaurantId/venues/:venueId — Update venue
  router.patch('/:restaurantId/venues/:venueId', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'update'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, venueId } = req.params;
      const doc = await db.collection(collections.bookingVenues).doc(venueId).get();

      if (!doc.exists) return res.status(404).json({ error: 'Venue not found' });
      if (doc.data().restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      const allowed = ['name', 'capacity', 'description', 'hourlyRate', 'fixedRate', 'operatingHours', 'allowMultipleBookings', 'maxConcurrentBookings', 'amenities', 'isActive'];
      const updates = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }

      await db.collection(collections.bookingVenues).doc(venueId).update(updates);

      const updated = await db.collection(collections.bookingVenues).doc(venueId).get();
      res.json({ success: true, venue: { id: venueId, ...updated.data() } });
    } catch (error) {
      console.error('Update venue error:', error);
      res.status(500).json({ error: 'Failed to update venue' });
    }
  });

  // DELETE /api/bookings/:restaurantId/venues/:venueId — Delete venue
  router.delete('/:restaurantId/venues/:venueId', authenticateToken, async (req, res) => {
    try {
      if (!(await checkFeaturePermission(req, 'bookings', 'delete'))) {
        return res.status(403).json({ error: 'Access denied' });
      }

      const { restaurantId, venueId } = req.params;
      const doc = await db.collection(collections.bookingVenues).doc(venueId).get();

      if (!doc.exists) return res.status(404).json({ error: 'Venue not found' });
      if (doc.data().restaurantId !== restaurantId) return res.status(403).json({ error: 'Access denied' });

      await db.collection(collections.bookingVenues).doc(venueId).delete();
      res.json({ success: true });
    } catch (error) {
      console.error('Delete venue error:', error);
      res.status(500).json({ error: 'Failed to delete venue' });
    }
  });

  // GET /api/bookings/:restaurantId/venues/:venueId/availability — Check availability
  router.get('/:restaurantId/venues/:venueId/availability', authenticateToken, async (req, res) => {
    try {
      const { restaurantId, venueId } = req.params;
      const { date, endDate, startTime, endTime } = req.query;

      if (!date) return res.status(400).json({ error: 'Date is required' });

      const result = await checkVenueConflict(
        db, collections, restaurantId, venueId,
        date, endDate || null, startTime || null, endTime || null, null
      );

      res.json({
        available: result.available,
        conflicts: result.conflicts,
        date,
      });
    } catch (error) {
      console.error('Check availability error:', error);
      res.status(500).json({ error: 'Failed to check availability' });
    }
  });

  return router;
};
