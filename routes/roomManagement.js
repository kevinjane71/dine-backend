const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');
const { authenticateToken } = require('../middleware/auth');

// Room statuses: available, occupied, cleaning, maintenance, reserved, out-of-service

// Add a single room
router.post('/room', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, roomNumber, type, floor, capacity, amenities, tariff } = req.body;

    if (!restaurantId || !roomNumber) {
      return res.status(400).json({ success: false, message: 'Restaurant ID and room number are required' });
    }

    // Check if room already exists
    const existingRoom = await db.collection('rooms')
      .where('restaurantId', '==', restaurantId)
      .where('roomNumber', '==', roomNumber)
      .limit(1)
      .get();

    if (!existingRoom.empty) {
      return res.status(400).json({ success: false, message: 'Room number already exists' });
    }

    const roomData = {
      restaurantId,
      roomNumber,
      type: type || 'standard', // standard, deluxe, suite
      floor: floor || 'Ground',
      capacity: capacity || 2,
      amenities: amenities || [],
      tariff: tariff || 0,
      status: 'available',
      currentGuest: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const roomRef = await db.collection('rooms').add(roomData);

    res.json({
      success: true,
      message: 'Room added successfully',
      room: { id: roomRef.id, ...roomData }
    });
  } catch (error) {
    console.error('Error adding room:', error);
    res.status(500).json({ success: false, message: 'Failed to add room', error: error.message });
  }
});

// Bulk add rooms
router.post('/rooms/bulk', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, fromNumber, toNumber, type, floor, capacity, amenities, tariff } = req.body;

    if (!restaurantId || !fromNumber || !toNumber) {
      return res.status(400).json({ success: false, message: 'Restaurant ID, from number, and to number are required' });
    }

    const from = parseInt(fromNumber);
    const to = parseInt(toNumber);

    if (from > to || from < 1 || to > 9999) {
      return res.status(400).json({ success: false, message: 'Invalid room number range' });
    }

    const batch = db.batch();
    const roomsToAdd = [];

    for (let i = from; i <= to; i++) {
      const roomNumber = i.toString();

      // Check if room exists
      const existingRoom = await db.collection('rooms')
        .where('restaurantId', '==', restaurantId)
        .where('roomNumber', '==', roomNumber)
        .limit(1)
        .get();

      if (existingRoom.empty) {
        const roomRef = db.collection('rooms').doc();
        const roomData = {
          restaurantId,
          roomNumber,
          type: type || 'standard',
          floor: floor || 'Ground',
          capacity: capacity || 2,
          amenities: amenities || [],
          tariff: tariff || 0,
          status: 'available',
          currentGuest: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        };

        batch.set(roomRef, roomData);
        roomsToAdd.push({ id: roomRef.id, ...roomData });
      }
    }

    await batch.commit();

    res.json({
      success: true,
      message: `${roomsToAdd.length} rooms added successfully`,
      rooms: roomsToAdd
    });
  } catch (error) {
    console.error('Error bulk adding rooms:', error);
    res.status(500).json({ success: false, message: 'Failed to add rooms', error: error.message });
  }
});

// Get all rooms for a restaurant
router.get('/rooms/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, floor } = req.query;

    let query = db.collection('rooms').where('restaurantId', '==', restaurantId);

    if (status) {
      query = query.where('status', '==', status);
    }

    if (floor) {
      query = query.where('floor', '==', floor);
    }

    const snapshot = await query.get();

    const rooms = [];
    snapshot.forEach(doc => {
      rooms.push({ id: doc.id, ...doc.data() });
    });

    // Sort by room number
    rooms.sort((a, b) => {
      const numA = parseInt(a.roomNumber) || 0;
      const numB = parseInt(b.roomNumber) || 0;
      return numA - numB;
    });

    res.json({ success: true, rooms });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch rooms', error: error.message });
  }
});

// Update room status
router.patch('/room/:roomId/status', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { status, currentGuest } = req.body;

    const validStatuses = ['available', 'occupied', 'cleaning', 'maintenance', 'reserved', 'out-of-service'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const updateData = {
      status,
      updatedAt: FieldValue.serverTimestamp()
    };

    if (currentGuest !== undefined) {
      updateData.currentGuest = currentGuest;
    }

    await db.collection('rooms').doc(roomId).update(updateData);

    res.json({ success: true, message: 'Room status updated' });
  } catch (error) {
    console.error('Error updating room status:', error);
    res.status(500).json({ success: false, message: 'Failed to update room status', error: error.message });
  }
});

// Delete room
router.delete('/room/:roomId', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;

    // Check if room has active check-in
    const checkInSnapshot = await db.collection('hotel_checkins')
      .where('roomId', '==', roomId)
      .where('status', '==', 'checked-in')
      .limit(1)
      .get();

    if (!checkInSnapshot.empty) {
      return res.status(400).json({ success: false, message: 'Cannot delete room with active check-in' });
    }

    await db.collection('rooms').doc(roomId).delete();

    res.json({ success: true, message: 'Room deleted successfully' });
  } catch (error) {
    console.error('Error deleting room:', error);
    res.status(500).json({ success: false, message: 'Failed to delete room', error: error.message });
  }
});

// Create a booking (future reservation)
router.post('/booking', authenticateToken, async (req, res) => {
  try {
    const {
      restaurantId,
      roomId,
      roomNumber,
      guestInfo,
      bookingDate,
      checkInDate,
      checkOutDate,
      numberOfGuests,
      estimatedTariff,
      specialRequests,
      bookingSource,
      overrideUnavailable
    } = req.body;

    // Validate required fields (phone number is now optional)
    if (!restaurantId || !roomNumber || !checkInDate || !checkOutDate || !guestInfo || !guestInfo.name) {
      return res.status(400).json({ success: false, message: 'Missing required fields: restaurantId, roomNumber, checkInDate, checkOutDate, guestInfo.name' });
    }

    // Validate dates
    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const stayDuration = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));

    if (stayDuration < 1) {
      return res.status(400).json({ success: false, message: 'Check-out must be after check-in' });
    }

    // Check if check-in date is in the past
    if (checkIn < today) {
      return res.status(400).json({ success: false, message: 'Check-in date cannot be in the past' });
    }

    // Check 120-day advance booking limit
    const daysInFuture = Math.floor((checkIn - today) / (1000 * 60 * 60 * 24));
    if (daysInFuture > 120) {
      return res.status(400).json({
        success: false,
        message: 'Cannot book more than 120 days in advance',
        code: 'BOOKING_TOO_FAR_AHEAD'
      });
    }

    // Check room availability
    const roomSnapshot = await db.collection('rooms')
      .where('restaurantId', '==', restaurantId)
      .where('roomNumber', '==', roomNumber)
      .limit(1)
      .get();

    if (roomSnapshot.empty) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }

    const roomDoc = roomSnapshot.docs[0];
    const roomData = roomDoc.data();

    // Check if room is unavailable (out-of-service or maintenance)
    if ((roomData.status === 'out-of-service' || roomData.status === 'maintenance') && !overrideUnavailable) {
      return res.status(400).json({
        success: false,
        message: `Room is currently marked as ${roomData.status}. Set overrideUnavailable=true to book anyway.`,
        code: 'ROOM_UNAVAILABLE',
        roomStatus: roomData.status
      });
    }

    // STRICT DOUBLE-BOOKING VALIDATION
    // Check for conflicting bookings
    const conflictingBookings = await db.collection('hotel_bookings')
      .where('restaurantId', '==', restaurantId)
      .where('roomNumber', '==', roomNumber)
      .where('status', 'in', ['confirmed', 'checked-in'])
      .get();

    const bookingConflicts = [];
    for (const booking of conflictingBookings.docs) {
      const bookingData = booking.data();
      const existingCheckIn = new Date(bookingData.checkInDate);
      const existingCheckOut = new Date(bookingData.checkOutDate);

      // Overlap check: existingStart < newEnd AND existingEnd > newStart
      if (existingCheckIn < checkOut && existingCheckOut > checkIn) {
        bookingConflicts.push({
          id: booking.id,
          guestName: bookingData.guestName,
          checkInDate: bookingData.checkInDate,
          checkOutDate: bookingData.checkOutDate
        });
      }
    }

    // Also check for active check-ins
    const conflictingCheckIns = await db.collection('hotel_checkins')
      .where('restaurantId', '==', restaurantId)
      .where('roomNumber', '==', roomNumber)
      .where('status', '==', 'checked-in')
      .get();

    const checkInConflicts = [];
    for (const checkIn of conflictingCheckIns.docs) {
      const checkInData = checkIn.data();
      const existingCheckIn = new Date(checkInData.checkInDate);
      const existingCheckOut = new Date(checkInData.checkOutDate);

      // Overlap check
      if (existingCheckIn < checkOut && existingCheckOut > checkIn) {
        checkInConflicts.push({
          id: checkIn.id,
          guestName: checkInData.guestName,
          checkInDate: checkInData.checkInDate,
          checkOutDate: checkInData.checkOutDate,
          type: 'check-in'
        });
      }
    }

    const allConflicts = [...bookingConflicts, ...checkInConflicts];

    if (allConflicts.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Room is already booked for these dates',
        code: 'BOOKING_CONFLICT',
        conflicts: allConflicts
      });
    }

    const bookingData = {
      restaurantId,
      roomId: roomDoc.id,
      roomNumber,
      guestName: guestInfo.name,
      guestPhone: guestInfo.phone || null, // Phone is now optional
      guestEmail: guestInfo.email || null,
      checkInDate,
      checkOutDate,
      numberOfGuests: numberOfGuests || 1,
      stayDuration,
      estimatedTariff: estimatedTariff || roomData.tariff || 0,
      totalAmount: (estimatedTariff || roomData.tariff || 0) * stayDuration,
      specialRequests: specialRequests || null,
      bookingSource: bookingSource || 'front-desk',
      status: 'confirmed',
      unavailableOverride: overrideUnavailable || false, // Track if unavailable room was overridden
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const bookingRef = await db.collection('hotel_bookings').add(bookingData);

    // Update room status to reserved if booking is for today
    const today = new Date().toISOString().split('T')[0];
    if (checkInDate === today) {
      await db.collection('rooms').doc(roomDoc.id).update({
        status: 'reserved',
        currentGuest: guestInfo.name
      });
    }

    res.json({
      success: true,
      message: 'Booking created successfully',
      booking: { id: bookingRef.id, ...bookingData }
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ success: false, message: 'Failed to create booking', error: error.message });
  }
});

// Get all bookings
router.get('/bookings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, date } = req.query;

    let query = db.collection('hotel_bookings').where('restaurantId', '==', restaurantId);

    if (status) {
      query = query.where('status', '==', status);
    }

    if (date) {
      query = query.where('checkInDate', '==', date);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();

    const bookings = [];
    snapshot.forEach(doc => {
      bookings.push({ id: doc.id, ...doc.data() });
    });

    res.json({ success: true, bookings });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch bookings', error: error.message });
  }
});

// Cancel booking
router.patch('/booking/:bookingId/cancel', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.params;

    const bookingDoc = await db.collection('hotel_bookings').doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const bookingData = bookingDoc.data();

    await db.collection('hotel_bookings').doc(bookingId).update({
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    // Update room status if it was reserved
    if (bookingData.roomId) {
      const roomDoc = await db.collection('rooms').doc(bookingData.roomId).get();
      if (roomDoc.exists && roomDoc.data().status === 'reserved') {
        await db.collection('rooms').doc(bookingData.roomId).update({
          status: 'available',
          currentGuest: null
        });
      }
    }

    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling booking:', error);
    res.status(500).json({ success: false, message: 'Failed to cancel booking', error: error.message });
  }
});

// Convert booking to check-in
router.post('/booking/:bookingId/checkin', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { idProof, gstInfo, advancePayment, paymentMode } = req.body;

    const bookingDoc = await db.collection('hotel_bookings').doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const bookingData = bookingDoc.data();

    if (bookingData.status !== 'confirmed') {
      return res.status(400).json({ success: false, message: 'Booking is not confirmed' });
    }

    // Create check-in
    const checkInData = {
      restaurantId: bookingData.restaurantId,
      roomId: bookingData.roomId,
      roomNumber: bookingData.roomNumber,
      guestName: bookingData.guestName,
      guestPhone: bookingData.guestPhone,
      guestEmail: bookingData.guestEmail,
      checkInDate: bookingData.checkInDate,
      checkOutDate: bookingData.checkOutDate,
      numberOfGuests: bookingData.numberOfGuests,
      stayDuration: bookingData.stayDuration,
      roomTariff: bookingData.estimatedTariff,
      totalRoomCharges: bookingData.estimatedTariff * bookingData.stayDuration,
      totalFoodCharges: 0,
      totalCharges: bookingData.estimatedTariff * bookingData.stayDuration,
      advancePayment: advancePayment || 0,
      balanceAmount: (bookingData.estimatedTariff * bookingData.stayDuration) - (advancePayment || 0),
      paymentMode: paymentMode || 'cash',
      idProof: idProof || null,
      gstInfo: gstInfo || null,
      specialRequests: bookingData.specialRequests,
      foodOrders: [],
      status: 'checked-in',
      bookingId: bookingId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const checkInRef = await db.collection('hotel_checkins').add(checkInData);

    // Update booking status
    await db.collection('hotel_bookings').doc(bookingId).update({
      status: 'checked-in',
      checkInId: checkInRef.id,
      updatedAt: FieldValue.serverTimestamp()
    });

    // Update room status
    await db.collection('rooms').doc(bookingData.roomId).update({
      status: 'occupied',
      currentGuest: bookingData.guestName
    });

    res.json({
      success: true,
      message: 'Checked in successfully',
      checkIn: { id: checkInRef.id, ...checkInData }
    });
  } catch (error) {
    console.error('Error converting booking to check-in:', error);
    res.status(500).json({ success: false, message: 'Failed to check in', error: error.message });
  }
});

module.exports = router;
