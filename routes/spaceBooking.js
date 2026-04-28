const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');

// ============================================
// SPACE BOOKING APIs
// Handles venue/room booking for commercial buildings
// ============================================

function getOwnerId(req) {
  return req.user.role === 'admin' ? req.user.ownerId : (req.user.userId || req.user.id);
}

// ──────────────────────────────────────────────
// PUBLIC ENDPOINTS (no auth)
// ──────────────────────────────────────────────

// GET /availability/:spaceId — Get available slots for a date
router.get('/availability/:spaceId', async (req, res) => {
  try {
    const { spaceId } = req.params;
    const date = req.query.date || new Date().toISOString().split('T')[0];

    // Fetch space info
    const spaceDoc = await db.collection(collections.restaurants).doc(spaceId).get();
    if (!spaceDoc.exists) {
      return res.status(404).json({ success: false, error: 'Space not found' });
    }
    const space = spaceDoc.data();
    const settings = space.spaceSettings || {
      hourlyRate: 0,
      operatingHours: { start: '08:00', end: '22:00' },
      slotDurationMinutes: 60,
      advancePercentage: 50,
      autoApprove: false
    };

    // Get bookings for this date (non-cancelled, non-rejected)
    const bookingsSnap = await db.collection(collections.spaceBookings)
      .where('restaurantId', '==', spaceId)
      .where('date', '==', date)
      .where('status', 'in', ['requested', 'confirmed', 'in_use'])
      .get();

    const bookedSlots = bookingsSnap.docs.map(doc => {
      const b = doc.data();
      return {
        id: doc.id,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status
      };
    });

    res.json({
      success: true,
      space: {
        id: spaceId,
        name: space.name,
        description: space.description || '',
        image: space.image || space.logo || '',
        address: space.address || '',
        city: space.city || '',
        businessType: space.businessType
      },
      settings: {
        hourlyRate: settings.hourlyRate,
        operatingHours: settings.operatingHours,
        slotDurationMinutes: settings.slotDurationMinutes,
        advancePercentage: settings.advancePercentage
      },
      date,
      bookedSlots
    });
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /availability/:spaceId/today — Display board endpoint
router.get('/availability/:spaceId/today', async (req, res) => {
  try {
    const { spaceId } = req.params;
    const today = new Date().toISOString().split('T')[0];

    const spaceDoc = await db.collection(collections.restaurants).doc(spaceId).get();
    if (!spaceDoc.exists) {
      return res.status(404).json({ success: false, error: 'Space not found' });
    }
    const space = spaceDoc.data();
    const settings = space.spaceSettings || {
      operatingHours: { start: '08:00', end: '22:00' }
    };

    const bookingsSnap = await db.collection(collections.spaceBookings)
      .where('restaurantId', '==', spaceId)
      .where('date', '==', today)
      .where('status', 'in', ['requested', 'confirmed', 'in_use'])
      .get();

    const bookings = bookingsSnap.docs.map(doc => {
      const b = doc.data();
      return {
        id: doc.id,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        name: b.customerInfo?.name || 'Reserved',
        company: b.customerInfo?.company || ''
      };
    }).sort((a, b) => a.startTime.localeCompare(b.startTime));

    res.json({
      success: true,
      space: {
        name: space.name,
        id: spaceId
      },
      date: today,
      operatingHours: settings.operatingHours,
      bookings
    });
  } catch (error) {
    console.error('Error fetching today availability:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /book/:spaceId — Submit booking request
router.post('/book/:spaceId', async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { date, startTime, endTime, customerInfo, amenities, notes } = req.body;

    // Validate required fields
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ success: false, error: 'Date, start time, and end time are required' });
    }
    if (!customerInfo?.name || !customerInfo?.phone) {
      return res.status(400).json({ success: false, error: 'Customer name and phone are required' });
    }
    if (startTime >= endTime) {
      return res.status(400).json({ success: false, error: 'Start time must be before end time' });
    }

    // Validate date is not in the past
    const today = new Date().toISOString().split('T')[0];
    if (date < today) {
      return res.status(400).json({ success: false, error: 'Cannot book for a past date' });
    }

    // Fetch space info
    const spaceDoc = await db.collection(collections.restaurants).doc(spaceId).get();
    if (!spaceDoc.exists) {
      return res.status(404).json({ success: false, error: 'Space not found' });
    }
    const space = spaceDoc.data();
    const settings = space.spaceSettings || {
      hourlyRate: 0,
      advancePercentage: 50,
      autoApprove: false
    };

    // Check for time conflicts
    const existingSnap = await db.collection(collections.spaceBookings)
      .where('restaurantId', '==', spaceId)
      .where('date', '==', date)
      .where('status', 'in', ['requested', 'confirmed', 'in_use'])
      .get();

    const hasConflict = existingSnap.docs.some(doc => {
      const b = doc.data();
      return startTime < b.endTime && endTime > b.startTime;
    });

    if (hasConflict) {
      return res.status(409).json({ success: false, error: 'This time slot conflicts with an existing booking' });
    }

    // Calculate duration in hours
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const duration = (endH + endM / 60) - (startH + startM / 60);

    // Calculate space charge
    const spaceCharge = Math.round(settings.hourlyRate * duration * 100) / 100;

    // Fetch amenity prices if amenities selected
    let amenitiesWithPrices = [];
    let amenitiesTotal = 0;
    if (amenities && amenities.length > 0) {
      const menuItemIds = amenities.map(a => a.menuItemId);
      // Fetch in batches of 10 (Firestore 'in' limit)
      const batches = [];
      for (let i = 0; i < menuItemIds.length; i += 10) {
        batches.push(menuItemIds.slice(i, i + 10));
      }
      const menuItemMap = {};
      for (const batch of batches) {
        const snap = await db.collection(collections.menuItems)
          .where('restaurantId', '==', spaceId)
          .where('__name__', 'in', batch)
          .get();
        snap.docs.forEach(doc => {
          menuItemMap[doc.id] = doc.data();
        });
      }

      amenitiesWithPrices = amenities.map(a => {
        const item = menuItemMap[a.menuItemId];
        const unitPrice = item?.price || 0;
        const totalPrice = unitPrice * (a.quantity || 1);
        amenitiesTotal += totalPrice;
        return {
          menuItemId: a.menuItemId,
          name: item?.name || 'Unknown',
          quantity: a.quantity || 1,
          unitPrice,
          totalPrice
        };
      });
    }

    const totalAmount = Math.round((spaceCharge + amenitiesTotal) * 100) / 100;
    const advanceAmount = Math.round(totalAmount * (settings.advancePercentage || 50) / 100 * 100) / 100;
    const initialStatus = settings.autoApprove ? 'confirmed' : 'requested';

    const bookingData = {
      restaurantId: spaceId,
      ownerId: space.ownerId,
      date,
      startTime,
      endTime,
      duration,
      status: initialStatus,
      customerInfo: {
        name: customerInfo.name,
        phone: customerInfo.phone,
        email: customerInfo.email || '',
        company: customerInfo.company || ''
      },
      amenities: amenitiesWithPrices,
      spaceCharge,
      amenitiesTotal,
      totalAmount,
      advanceAmount,
      advancePaid: false,
      orderId: null,
      notes: notes || '',
      rejectionReason: '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const docRef = await db.collection(collections.spaceBookings).add(bookingData);

    res.status(201).json({
      success: true,
      booking: {
        id: docRef.id,
        ...bookingData
      }
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /booking-status/:bookingId — Check booking status (polling)
router.get('/booking-status/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const doc = await db.collection(collections.spaceBookings).doc(bookingId).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }
    const b = doc.data();
    res.json({
      success: true,
      booking: {
        id: doc.id,
        status: b.status,
        date: b.date,
        startTime: b.startTime,
        endTime: b.endTime,
        totalAmount: b.totalAmount,
        advanceAmount: b.advanceAmount,
        advancePaid: b.advancePaid,
        rejectionReason: b.rejectionReason || ''
      }
    });
  } catch (error) {
    console.error('Error fetching booking status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// AUTHENTICATED ENDPOINTS
// ──────────────────────────────────────────────

// GET /bookings — List bookings for admin
router.get('/bookings', authenticateToken, async (req, res) => {
  try {
    const ownerId = getOwnerId(req);
    const { spaceId, date, status, startDate, endDate } = req.query;

    let query = db.collection(collections.spaceBookings).where('ownerId', '==', ownerId);

    if (spaceId) query = query.where('restaurantId', '==', spaceId);
    if (status) query = query.where('status', '==', status);
    if (date) {
      query = query.where('date', '==', date);
    } else if (startDate && endDate) {
      query = query.where('date', '>=', startDate).where('date', '<=', endDate);
    }

    const snap = await query.orderBy('date', 'desc').get();

    const bookings = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.() || doc.data().createdAt,
      updatedAt: doc.data().updatedAt?.toDate?.() || doc.data().updatedAt
    }));

    // Sort by date ascending, then startTime
    bookings.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.startTime.localeCompare(b.startTime);
    });

    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Error listing bookings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /bookings/:bookingId/status — Approve/reject/update
router.patch('/bookings/:bookingId/status', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { status, rejectionReason } = req.body;

    const doc = await db.collection(collections.spaceBookings).doc(bookingId).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    const booking = doc.data();
    const currentStatus = booking.status;

    // Validate status transitions
    const validTransitions = {
      requested: ['confirmed', 'rejected'],
      confirmed: ['in_use', 'cancelled'],
      in_use: ['completed']
    };

    if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(status)) {
      return res.status(400).json({
        success: false,
        error: `Cannot transition from "${currentStatus}" to "${status}"`
      });
    }

    const updateData = {
      status,
      updatedAt: new Date()
    };
    if (status === 'rejected' && rejectionReason) {
      updateData.rejectionReason = rejectionReason;
    }

    await db.collection(collections.spaceBookings).doc(bookingId).update(updateData);

    res.json({
      success: true,
      booking: { id: bookingId, ...booking, ...updateData }
    });
  } catch (error) {
    console.error('Error updating booking status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /spaces — List owner's spaces
router.get('/spaces', authenticateToken, async (req, res) => {
  try {
    const ownerId = getOwnerId(req);

    const snap = await db.collection(collections.restaurants)
      .where('ownerId', '==', ownerId)
      .get();

    // Return all restaurants — filtering by businessType='space' is done on frontend
    // This allows owners to convert any restaurant to a space
    const spaces = snap.docs
      .filter(doc => doc.data().businessType === 'space')
      .map(doc => ({
        id: doc.id,
        name: doc.data().name,
        description: doc.data().description || '',
        address: doc.data().address || '',
        city: doc.data().city || '',
        image: doc.data().image || doc.data().logo || '',
        businessType: doc.data().businessType,
        spaceSettings: doc.data().spaceSettings || {
          hourlyRate: 0,
          operatingHours: { start: '08:00', end: '22:00' },
          slotDurationMinutes: 60,
          advancePercentage: 50,
          autoApprove: false
        }
      }));

    res.json({ success: true, spaces });
  } catch (error) {
    console.error('Error listing spaces:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /spaces/:spaceId/settings — Update space settings
router.patch('/spaces/:spaceId/settings', authenticateToken, async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { hourlyRate, operatingHours, advancePercentage, slotDurationMinutes, autoApprove } = req.body;

    const spaceDoc = await db.collection(collections.restaurants).doc(spaceId).get();
    if (!spaceDoc.exists) {
      return res.status(404).json({ success: false, error: 'Space not found' });
    }

    // Verify ownership
    const ownerId = getOwnerId(req);
    if (spaceDoc.data().ownerId !== ownerId) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const currentSettings = spaceDoc.data().spaceSettings || {};
    const updatedSettings = {
      ...currentSettings,
      ...(hourlyRate !== undefined && { hourlyRate: Number(hourlyRate) }),
      ...(operatingHours && { operatingHours }),
      ...(advancePercentage !== undefined && { advancePercentage: Number(advancePercentage) }),
      ...(slotDurationMinutes !== undefined && { slotDurationMinutes: Number(slotDurationMinutes) }),
      ...(autoApprove !== undefined && { autoApprove: Boolean(autoApprove) })
    };

    await db.collection(collections.restaurants).doc(spaceId).update({
      spaceSettings: updatedSettings,
      businessType: 'space'
    });

    res.json({ success: true, spaceSettings: updatedSettings });
  } catch (error) {
    console.error('Error updating space settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
