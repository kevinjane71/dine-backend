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

// Set room maintenance schedule (date-specific)
router.post('/room/:roomId/maintenance', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { userId } = req.user;
    const { restaurantId, roomNumber, startDate, endDate, reason } = req.body;

    if (!restaurantId || !roomNumber || !startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: restaurantId, roomNumber, startDate, endDate' 
      });
    }

    // Validate dates
    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start < today) {
      return res.status(400).json({ 
        success: false, 
        message: 'Start date cannot be in the past' 
      });
    }

    // Normalize dates to start of day for comparison
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    
    // Validate: End date must be same as or after start date
    if (end < start) {
      return res.status(400).json({ 
        success: false, 
        message: 'End date cannot be before start date' 
      });
    }

    // Create maintenance schedule document
    const maintenanceData = {
      restaurantId,
      roomId,
      roomNumber,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      reason: reason || 'Maintenance required',
      status: 'active',
      createdBy: userId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const maintenanceRef = await db.collection('room_maintenance_schedules').add(maintenanceData);

    // Update room status to maintenance if the schedule includes today
    if (start <= today && end >= today) {
      await db.collection('rooms').doc(roomId).update({
        status: 'maintenance',
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    res.json({ 
      success: true, 
      message: 'Maintenance schedule created successfully',
      maintenanceId: maintenanceRef.id
    });
  } catch (error) {
    console.error('Error creating maintenance schedule:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to create maintenance schedule', 
      error: error.message 
    });
  }
});

// Get maintenance schedules for a room
router.get('/room/:roomId/maintenance', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required field: restaurantId' 
      });
    }

    const query = db.collection('room_maintenance_schedules')
      .where('restaurantId', '==', restaurantId)
      .where('roomId', '==', roomId)
      .where('status', '==', 'active');

    const maintenanceSnapshot = await query.get();

    const schedules = [];
    maintenanceSnapshot.forEach(doc => {
      const data = doc.data();
      schedules.push({
        id: doc.id,
        startDate: data.startDate?._seconds ? new Date(data.startDate._seconds * 1000).toISOString().split('T')[0] : (data.startDate instanceof Date ? data.startDate.toISOString().split('T')[0] : data.startDate),
        endDate: data.endDate?._seconds ? new Date(data.endDate._seconds * 1000).toISOString().split('T')[0] : (data.endDate instanceof Date ? data.endDate.toISOString().split('T')[0] : data.endDate),
        reason: data.reason,
        roomNumber: data.roomNumber
      });
    });

    res.json({ 
      success: true, 
      schedules 
    });
  } catch (error) {
    console.error('Error fetching maintenance schedules:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch maintenance schedules', 
      error: error.message 
    });
  }
});

// Cancel/delete maintenance schedules for a room
// Supports canceling all schedules or schedules within a date range
router.delete('/room/:roomId/maintenance', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { restaurantId, startDate, endDate } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required field: restaurantId' 
      });
    }

    // Get all active maintenance schedules for this room
    const query = db.collection('room_maintenance_schedules')
      .where('restaurantId', '==', restaurantId)
      .where('roomId', '==', roomId)
      .where('status', '==', 'active');

    const maintenanceSnapshot = await query.get();

    if (maintenanceSnapshot.empty) {
      return res.json({ 
        success: true, 
        message: 'No active maintenance schedules found',
        cancelledCount: 0
      });
    }

    const batch = db.batch();
    let cancelledCount = 0;

    // If date range provided, only cancel schedules that overlap with the range
    if (startDate && endDate) {
      const cancelStart = new Date(startDate);
      const cancelEnd = new Date(endDate);
      cancelStart.setHours(0, 0, 0, 0);
      cancelEnd.setHours(23, 59, 59, 999);

      maintenanceSnapshot.forEach(doc => {
        const data = doc.data();
        let scheduleStart = data.startDate?._seconds ? new Date(data.startDate._seconds * 1000) : new Date(data.startDate);
        let scheduleEnd = data.endDate?._seconds ? new Date(data.endDate._seconds * 1000) : new Date(data.endDate);
        scheduleStart.setHours(0, 0, 0, 0);
        scheduleEnd.setHours(23, 59, 59, 999);

        // Check if schedules overlap
        if (scheduleStart <= cancelEnd && scheduleEnd >= cancelStart) {
          batch.update(doc.ref, {
            status: 'cancelled',
            updatedAt: FieldValue.serverTimestamp()
          });
          cancelledCount++;
        }
      });
    } else {
      // Cancel ALL active maintenance schedules for this room
      maintenanceSnapshot.forEach(doc => {
        batch.update(doc.ref, {
          status: 'cancelled',
          updatedAt: FieldValue.serverTimestamp()
        });
        cancelledCount++;
      });
    }

    await batch.commit();

    res.json({ 
      success: true, 
      message: `Cancelled ${cancelledCount} maintenance schedule(s)`,
      cancelledCount
    });
  } catch (error) {
    console.error('Error cancelling maintenance schedules:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to cancel maintenance schedules', 
      error: error.message 
    });
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
    
    // Normalize dates to start of day for comparison
    checkIn.setHours(0, 0, 0, 0);
    checkOut.setHours(0, 0, 0, 0);

    // Validate: Check-out date must be same as or after check-in date
    if (checkOut < checkIn) {
      return res.status(400).json({ success: false, message: 'Check-out date cannot be before check-in date' });
    }

    const stayDuration = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));

    if (stayDuration < 1) {
      return res.status(400).json({ success: false, message: 'Check-out must be on or after check-in date' });
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
      
      // Parse dates - handle both string dates and Firestore Timestamps
      let existingCheckIn;
      let existingCheckOut;
      
      if (bookingData.checkInDate instanceof Date) {
        existingCheckIn = new Date(bookingData.checkInDate);
      } else if (bookingData.checkInDate && bookingData.checkInDate._seconds) {
        existingCheckIn = new Date(bookingData.checkInDate._seconds * 1000);
      } else if (bookingData.checkInDate) {
        existingCheckIn = new Date(bookingData.checkInDate);
      } else {
        continue; // Skip if no valid check-in date
      }
      
      if (bookingData.checkOutDate instanceof Date) {
        existingCheckOut = new Date(bookingData.checkOutDate);
      } else if (bookingData.checkOutDate && bookingData.checkOutDate._seconds) {
        existingCheckOut = new Date(bookingData.checkOutDate._seconds * 1000);
      } else if (bookingData.checkOutDate) {
        existingCheckOut = new Date(bookingData.checkOutDate);
      } else {
        continue; // Skip if no valid check-out date
      }
      
      // Normalize dates to start of day
      existingCheckIn.setHours(0, 0, 0, 0);
      existingCheckOut.setHours(0, 0, 0, 0);
      checkIn.setHours(0, 0, 0, 0);
      checkOut.setHours(0, 0, 0, 0);

      // Hotel industry standard: Check-out date is available for next booking
      // Overlap check: existingStart < newEnd AND existingEnd > newStart
      // This means: New booking can start on the same day as existing checkout
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
    const todayStr = new Date().toISOString().split('T')[0];
    if (checkInDate === todayStr) {
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
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: 'Cancellation reason is required' });
    }

    const bookingDoc = await db.collection('hotel_bookings').doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const bookingData = bookingDoc.data();

    // Don't allow canceling already cancelled or checked-in bookings
    if (bookingData.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Booking is already cancelled' });
    }

    if (bookingData.status === 'checked-in') {
      return res.status(400).json({ success: false, message: 'Cannot cancel a booking that is already checked in' });
    }

    // Update booking status
    await db.collection('hotel_bookings').doc(bookingId).update({
      status: 'cancelled',
      cancellationReason: reason.trim(),
      cancelledAt: FieldValue.serverTimestamp(),
      cancelledBy: req.user.userId,
      updatedAt: FieldValue.serverTimestamp()
    });

    // Update room status if it was reserved for this booking
    if (bookingData.roomId) {
      const roomDoc = await db.collection('rooms').doc(bookingData.roomId).get();
      if (roomDoc.exists) {
        const roomData = roomDoc.data();
        
        // Only update room status if it's currently reserved and the current guest matches this booking
        // This ensures we don't accidentally free a room that was reserved for a different booking
        if (roomData.status === 'reserved' && roomData.currentGuest === bookingData.guestName) {
          // Check if there are any other active bookings for this room
          const otherBookings = await db.collection('hotel_bookings')
            .where('roomId', '==', bookingData.roomId)
            .where('status', 'in', ['confirmed', 'checked-in'])
            .where('restaurantId', '==', bookingData.restaurantId)
            .get();

          // If no other active bookings, mark room as available
          if (otherBookings.empty) {
            await db.collection('rooms').doc(bookingData.roomId).update({
              status: 'available',
              currentGuest: null,
              updatedAt: FieldValue.serverTimestamp()
            });
          }
        }
      }
    }

    res.json({ 
      success: true, 
      message: 'Booking cancelled successfully',
      booking: {
        id: bookingId,
        roomNumber: bookingData.roomNumber,
        checkInDate: bookingData.checkInDate,
        checkOutDate: bookingData.checkOutDate
      }
    });
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
