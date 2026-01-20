const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const admin = require('firebase-admin');
const { db } = require('../firebase');

// All hotel routes require authentication
router.use(authenticateToken);

// Hotel permission check middleware - REMOVED: Using standard login authentication only
// Simple pass-through middleware (no permission check, just authentication)
const checkHotelPermission = (requiredPermission) => {
  return (req, res, next) => {
    // Authentication already handled by authenticateToken middleware
    // No additional permission checks needed - user is already authenticated
    next();
  };
};

// ==================== ROOMS ====================

// Get all rooms
router.get('/rooms', checkHotelPermission('view'), async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) {
      return res.status(400).json({ error: 'hotelId is required' });
    }

    const db = admin.firestore();
    const roomsSnapshot = await db.collection('pms-rooms')
      .where('hotelId', '==', hotelId)
      .get();

    const rooms = [];
    roomsSnapshot.forEach(doc => {
      rooms.push({ id: doc.id, ...doc.data() });
    });

    res.json({ rooms });
  } catch (error) {
    console.error('Error fetching rooms:', error);
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// Get single room
router.get('/rooms/:roomId', checkHotelPermission('view'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const db = admin.firestore();
    const roomDoc = await db.collection('pms-rooms').doc(roomId).get();

    if (!roomDoc.exists) {
      return res.status(404).json({ error: 'Room not found' });
    }

    res.json({ id: roomDoc.id, ...roomDoc.data() });
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Failed to fetch room' });
  }
});

// Create room
router.post('/rooms', checkHotelPermission('manage'), async (req, res) => {
  try {
    const roomData = req.body;
    const db = admin.firestore();

    const roomRef = await db.collection('pms-rooms').add({
      ...roomData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ id: roomRef.id, message: 'Room created successfully' });
  } catch (error) {
    console.error('Error creating room:', error);
    res.status(500).json({ error: 'Failed to create room' });
  }
});

// Update room
router.patch('/rooms/:roomId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const updateData = req.body;
    const db = admin.firestore();

    await db.collection('pms-rooms').doc(roomId).update({
      ...updateData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Room updated successfully' });
  } catch (error) {
    console.error('Error updating room:', error);
    res.status(500).json({ error: 'Failed to update room' });
  }
});

// Update room status
router.patch('/rooms/:roomId/status', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const { status } = req.body;
    const db = admin.firestore();

    await db.collection('pms-rooms').doc(roomId).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Room status updated successfully' });
  } catch (error) {
    console.error('Error updating room status:', error);
    res.status(500).json({ error: 'Failed to update room status' });
  }
});

// Delete room
router.delete('/rooms/:roomId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { roomId } = req.params;
    const db = admin.firestore();

    await db.collection('pms-rooms').doc(roomId).delete();

    res.json({ message: 'Room deleted successfully' });
  } catch (error) {
    console.error('Error deleting room:', error);
    res.status(500).json({ error: 'Failed to delete room' });
  }
});

// ==================== BOOKINGS ====================

// Get all bookings
router.get('/bookings', checkHotelPermission('view'), async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) {
      return res.status(400).json({ error: 'hotelId is required' });
    }

    const db = admin.firestore();
    const bookingsSnapshot = await db.collection('pms-bookings')
      .where('hotelId', '==', hotelId)
      .get();

    const bookings = [];
    bookingsSnapshot.forEach(doc => {
      bookings.push({ id: doc.id, ...doc.data() });
    });

    res.json({ bookings });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Get single booking
router.get('/bookings/:bookingId', checkHotelPermission('view'), async (req, res) => {
  try {
    const { bookingId } = req.params;
    const db = admin.firestore();
    const bookingDoc = await db.collection('pms-bookings').doc(bookingId).get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    res.json({ id: bookingDoc.id, ...bookingDoc.data() });
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// Create booking
router.post('/bookings', checkHotelPermission('manage'), async (req, res) => {
  try {
    const bookingData = req.body;
    const db = admin.firestore();

    const bookingRef = await db.collection('pms-bookings').add({
      ...bookingData,
      status: 'confirmed',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update room status to reserved
    if (bookingData.roomId) {
      await db.collection('pms-rooms').doc(bookingData.roomId).update({
        status: 'reserved',
        currentBookingId: bookingRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ id: bookingRef.id, message: 'Booking created successfully' });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Check-in
router.post('/bookings/:bookingId/checkin', checkHotelPermission('checkin'), async (req, res) => {
  try {
    const { bookingId } = req.params;
    const db = admin.firestore();

    const bookingRef = db.collection('pms-bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingDoc.data();
    await bookingRef.update({
      status: 'checked-in',
      checkedInAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update room status to occupied
    if (booking.roomId) {
      await db.collection('pms-rooms').doc(booking.roomId).update({
        status: 'occupied',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ message: 'Check-in successful' });
  } catch (error) {
    console.error('Error checking in:', error);
    res.status(500).json({ error: 'Failed to check in' });
  }
});

// Check-out
router.post('/bookings/:bookingId/checkout', checkHotelPermission('checkin'), async (req, res) => {
  try {
    const { bookingId } = req.params;
    const db = admin.firestore();

    const bookingRef = db.collection('pms-bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingDoc.data();
    await bookingRef.update({
      status: 'checked-out',
      checkedOutAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update room status to cleaning
    if (booking.roomId) {
      await db.collection('pms-rooms').doc(booking.roomId).update({
        status: 'cleaning',
        currentBookingId: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ message: 'Check-out successful' });
  } catch (error) {
    console.error('Error checking out:', error);
    res.status(500).json({ error: 'Failed to check out' });
  }
});

// Update booking
router.patch('/bookings/:bookingId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { bookingId } = req.params;
    const updateData = req.body;
    const db = admin.firestore();

    await db.collection('pms-bookings').doc(bookingId).update({
      ...updateData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Booking updated successfully' });
  } catch (error) {
    console.error('Error updating booking:', error);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// Delete/Cancel booking
router.delete('/bookings/:bookingId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { bookingId } = req.params;
    const db = admin.firestore();

    const bookingRef = db.collection('pms-bookings').doc(bookingId);
    const bookingDoc = await bookingRef.get();

    if (!bookingDoc.exists) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingDoc.data();
    
    // Update booking status to cancelled instead of deleting
    await bookingRef.update({
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Update room status back to available if it was reserved
    if (booking.roomId && booking.status === 'confirmed') {
      await db.collection('pms-rooms').doc(booking.roomId).update({
        status: 'available',
        currentBookingId: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json({ message: 'Booking cancelled successfully' });
  } catch (error) {
    console.error('Error cancelling booking:', error);
    res.status(500).json({ error: 'Failed to cancel booking' });
  }
});

// ==================== GUESTS ====================

// Get all guests
router.get('/guests', checkHotelPermission('view'), async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) {
      return res.status(400).json({ error: 'hotelId is required' });
    }

    const db = admin.firestore();
    const guestsSnapshot = await db.collection('pms-guests')
      .where('hotelId', '==', hotelId)
      .get();

    const guests = [];
    guestsSnapshot.forEach(doc => {
      guests.push({ id: doc.id, ...doc.data() });
    });

    res.json({ guests });
  } catch (error) {
    console.error('Error fetching guests:', error);
    res.status(500).json({ error: 'Failed to fetch guests' });
  }
});

// Create guest
router.post('/guests', checkHotelPermission('manage'), async (req, res) => {
  try {
    const guestData = req.body;
    const db = admin.firestore();

    const guestRef = await db.collection('pms-guests').add({
      ...guestData,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ id: guestRef.id, message: 'Guest created successfully' });
  } catch (error) {
    console.error('Error creating guest:', error);
    res.status(500).json({ error: 'Failed to create guest' });
  }
});

// Update guest
router.patch('/guests/:guestId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { guestId } = req.params;
    const updateData = req.body;
    const db = admin.firestore();

    await db.collection('pms-guests').doc(guestId).update({
      ...updateData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Guest updated successfully' });
  } catch (error) {
    console.error('Error updating guest:', error);
    res.status(500).json({ error: 'Failed to update guest' });
  }
});

// Get guest history
router.get('/guests/:guestId/history', checkHotelPermission('view'), async (req, res) => {
  try {
    const { guestId } = req.params;
    const db = admin.firestore();

    // Get all bookings for this guest
    const bookingsSnapshot = await db.collection('pms-bookings')
      .where('guestId', '==', guestId)
      .get();

    const history = [];
    bookingsSnapshot.forEach(doc => {
      const booking = doc.data();
      history.push({
        id: doc.id,
        roomNumber: booking.roomNumber || 'N/A',
        checkInDate: booking.checkInDate,
        checkOutDate: booking.checkOutDate,
        status: booking.status,
        createdAt: booking.createdAt
      });
    });

    res.json({ history });
  } catch (error) {
    console.error('Error fetching guest history:', error);
    res.status(500).json({ error: 'Failed to fetch guest history' });
  }
});

// Delete guest
router.delete('/guests/:guestId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { guestId } = req.params;
    const db = admin.firestore();

    await db.collection('pms-guests').doc(guestId).delete();

    res.json({ message: 'Guest deleted successfully' });
  } catch (error) {
    console.error('Error deleting guest:', error);
    res.status(500).json({ error: 'Failed to delete guest' });
  }
});

// ==================== HOUSEKEEPING ====================

// Get housekeeping tasks
router.get('/housekeeping/tasks', checkHotelPermission('view'), async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) {
      return res.status(400).json({ error: 'hotelId is required' });
    }

    const db = admin.firestore();
    const tasksSnapshot = await db.collection('pms-housekeeping')
      .where('hotelId', '==', hotelId)
      .get();

    const tasks = [];
    tasksSnapshot.forEach(doc => {
      tasks.push({ id: doc.id, ...doc.data() });
    });

    res.json({ tasks });
  } catch (error) {
    console.error('Error fetching housekeeping tasks:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Create housekeeping task
router.post('/housekeeping/tasks', checkHotelPermission('housekeeping'), async (req, res) => {
  try {
    const taskData = req.body;
    const db = admin.firestore();

    const taskRef = await db.collection('pms-housekeeping').add({
      ...taskData,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ id: taskRef.id, message: 'Task created successfully' });
  } catch (error) {
    console.error('Error creating housekeeping task:', error);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update housekeeping task
router.patch('/housekeeping/tasks/:taskId', checkHotelPermission('housekeeping'), async (req, res) => {
  try {
    const { taskId } = req.params;
    const updateData = req.body;
    const db = admin.firestore();

    await db.collection('pms-housekeeping').doc(taskId).update({
      ...updateData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Task updated successfully' });
  } catch (error) {
    console.error('Error updating housekeeping task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Delete housekeeping task
router.delete('/housekeeping/tasks/:taskId', checkHotelPermission('housekeeping'), async (req, res) => {
  try {
    const { taskId } = req.params;
    const db = admin.firestore();

    await db.collection('pms-housekeeping').doc(taskId).delete();

    res.json({ message: 'Task deleted successfully' });
  } catch (error) {
    console.error('Error deleting housekeeping task:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ==================== MAINTENANCE ====================

// Get maintenance requests
router.get('/maintenance/requests', checkHotelPermission('view'), async (req, res) => {
  try {
    const { hotelId } = req.query;
    if (!hotelId) {
      return res.status(400).json({ error: 'hotelId is required' });
    }

    const db = admin.firestore();
    const requestsSnapshot = await db.collection('pms-maintenance')
      .where('hotelId', '==', hotelId)
      .get();

    const requests = [];
    requestsSnapshot.forEach(doc => {
      requests.push({ id: doc.id, ...doc.data() });
    });

    res.json({ requests });
  } catch (error) {
    console.error('Error fetching maintenance requests:', error);
    res.status(500).json({ error: 'Failed to fetch requests' });
  }
});

// Create maintenance request
router.post('/maintenance/requests', checkHotelPermission('manage'), async (req, res) => {
  try {
    const requestData = req.body;
    const db = admin.firestore();

    const requestRef = await db.collection('pms-maintenance').add({
      ...requestData,
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ id: requestRef.id, message: 'Maintenance request created successfully' });
  } catch (error) {
    console.error('Error creating maintenance request:', error);
    res.status(500).json({ error: 'Failed to create request' });
  }
});

// Update maintenance request
router.patch('/maintenance/requests/:requestId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const updateData = req.body;
    const db = admin.firestore();

    await db.collection('pms-maintenance').doc(requestId).update({
      ...updateData,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ message: 'Request updated successfully' });
  } catch (error) {
    console.error('Error updating maintenance request:', error);
    res.status(500).json({ error: 'Failed to update request' });
  }
});

// Delete maintenance request
router.delete('/maintenance/requests/:requestId', checkHotelPermission('manage'), async (req, res) => {
  try {
    const { requestId } = req.params;
    const db = admin.firestore();

    await db.collection('pms-maintenance').doc(requestId).delete();

    res.json({ message: 'Request deleted successfully' });
  } catch (error) {
    console.error('Error deleting maintenance request:', error);
    res.status(500).json({ error: 'Failed to delete request' });
  }
});

module.exports = router;

