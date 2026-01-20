const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');
const { authenticateToken } = require('../middleware/auth');

/**
 * Hotel Management Routes
 *
 * This module provides complete hotel check-in/check-out functionality
 * including guest management, room assignments, and billing integration.
 *
 * Feature flag: ENABLE_HOTEL_MODE
 */

// Collection names
const COLLECTIONS = {
  guests: 'hotel_guests',
  checkIns: 'hotel_checkins',
  rooms: 'hotel_rooms',
  restaurants: 'restaurants'
};

// ==================== GUEST CHECK-IN ====================

/**
 * POST /api/hotel/checkin
 * Create a new hotel check-in
 */
router.post('/hotel/checkin', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.user;
    const {
      restaurantId,
      guestInfo,
      roomNumber,
      checkInDate,
      checkOutDate,
      numberOfGuests,
      roomTariff,
      advancePayment,
      paymentMode,
      idProof,
      gstInfo,
      specialRequests
    } = req.body;

    // Validate required fields (phone number is now optional)
    if (!restaurantId || !guestInfo?.name || !roomNumber || !checkInDate || !checkOutDate) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: restaurantId, guest name, roomNumber, checkInDate, checkOutDate'
      });
    }

    // Check if room is already occupied
    const existingCheckIn = await db.collection(COLLECTIONS.checkIns)
      .where('restaurantId', '==', restaurantId)
      .where('roomNumber', '==', roomNumber)
      .where('status', '==', 'checked-in')
      .limit(1)
      .get();

    if (!existingCheckIn.empty) {
      return res.status(400).json({
        success: false,
        error: `Room ${roomNumber} is already occupied`
      });
    }

    // Create guest record
    const guestData = {
      name: guestInfo.name,
      phone: guestInfo.phone || null, // Phone is now optional
      email: guestInfo.email || null,
      address: guestInfo.address || null,
      city: guestInfo.city || null,
      state: guestInfo.state || null,
      country: guestInfo.country || null,
      zipCode: guestInfo.zipCode || null,
      idProofType: idProof?.type || null,
      idProofNumber: idProof?.number || null,
      idProofImageUrl: idProof?.imageUrl || null,
      gstNumber: gstInfo?.gstNumber || null,
      gstCompanyName: gstInfo?.companyName || null,
      restaurantId,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: userId
    };

    const guestRef = await db.collection(COLLECTIONS.guests).add(guestData);

    // Calculate stay duration in days
    const checkIn = new Date(checkInDate);
    const checkOut = new Date(checkOutDate);
    const stayDuration = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));

    // Create check-in record
    const checkInData = {
      restaurantId,
      guestId: guestRef.id,
      guestName: guestInfo.name,
      guestPhone: guestInfo.phone || null, // Phone is now optional
      guestEmail: guestInfo.email || null,
      roomNumber,
      checkInDate: new Date(checkInDate),
      checkOutDate: new Date(checkOutDate),
      stayDuration,
      numberOfGuests: numberOfGuests || 1,
      roomTariff: roomTariff || 0,
      totalRoomCharges: (roomTariff || 0) * stayDuration,
      advancePayment: advancePayment || 0,
      paymentMode: paymentMode || 'cash',
      specialRequests: specialRequests || null,
      status: 'checked-in',
      foodOrders: [], // Will be populated when orders are placed
      totalFoodCharges: 0,
      totalCharges: (roomTariff || 0) * stayDuration,
      balanceAmount: ((roomTariff || 0) * stayDuration) - (advancePayment || 0),
      checkInBy: userId,
      checkInAt: FieldValue.serverTimestamp(),
      lastUpdated: FieldValue.serverTimestamp()
    };

    const checkInRef = await db.collection(COLLECTIONS.checkIns).add(checkInData);

    // Update room status to occupied
    const roomSnapshot = await db.collection('rooms')
      .where('restaurantId', '==', restaurantId)
      .where('roomNumber', '==', roomNumber)
      .limit(1)
      .get();

    if (!roomSnapshot.empty) {
      const roomDoc = roomSnapshot.docs[0];
      await db.collection('rooms').doc(roomDoc.id).update({
        status: 'occupied',
        currentGuest: guestInfo.name,
        checkInId: checkInRef.id,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    res.status(201).json({
      success: true,
      message: `Guest checked in to Room ${roomNumber} successfully`,
      checkIn: {
        id: checkInRef.id,
        ...checkInData,
        guestId: guestRef.id
      }
    });

  } catch (error) {
    console.error('Hotel check-in error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process check-in'
    });
  }
});

// ==================== GET CHECK-INS ====================

/**
 * GET /api/hotel/checkins/:restaurantId
 * Get all check-ins for a restaurant
 */
router.get('/hotel/checkins/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status } = req.query; // active, checked-out, all

    let query = db.collection(COLLECTIONS.checkIns)
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      if (status === 'active') {
        query = query.where('status', '==', 'checked-in');
      } else {
        query = query.where('status', '==', status);
      }
    }

    const snapshot = await query.orderBy('checkInAt', 'desc').get();

    const checkIns = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      checkIns.push({
        id: doc.id,
        ...data,
        checkInDate: data.checkInDate?.toDate?.() || data.checkInDate,
        checkOutDate: data.checkOutDate?.toDate?.() || data.checkOutDate,
        checkInAt: data.checkInAt?.toDate?.() || data.checkInAt,
        actualCheckOutAt: data.actualCheckOutAt?.toDate?.() || data.actualCheckOutAt
      });
    });

    res.json({
      success: true,
      checkIns,
      total: checkIns.length
    });

  } catch (error) {
    console.error('Get check-ins error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch check-ins'
    });
  }
});

// ==================== GET CHECK-IN BY ROOM ====================

/**
 * GET /api/hotel/checkin/room/:restaurantId/:roomNumber
 * Get active check-in for a specific room
 */
router.get('/hotel/checkin/room/:restaurantId/:roomNumber', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, roomNumber } = req.params;

    const snapshot = await db.collection(COLLECTIONS.checkIns)
      .where('restaurantId', '==', restaurantId)
      .where('roomNumber', '==', roomNumber)
      .where('status', '==', 'checked-in')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        error: `No active check-in found for Room ${roomNumber}`
      });
    }

    const doc = snapshot.docs[0];
    const data = doc.data();

    res.json({
      success: true,
      checkIn: {
        id: doc.id,
        ...data,
        checkInDate: data.checkInDate?.toDate?.() || data.checkInDate,
        checkOutDate: data.checkOutDate?.toDate?.() || data.checkOutDate,
        checkInAt: data.checkInAt?.toDate?.() || data.checkInAt
      }
    });

  } catch (error) {
    console.error('Get check-in by room error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch check-in'
    });
  }
});

// ==================== LINK ORDER TO CHECK-IN ====================

/**
 * POST /api/hotel/link-order
 * Link a food order to a hotel check-in (room)
 */
router.post('/hotel/link-order', authenticateToken, async (req, res) => {
  try {
    const { checkInId, orderId, orderAmount } = req.body;

    if (!checkInId || !orderId || !orderAmount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: checkInId, orderId, orderAmount'
      });
    }

    // Check if order exists and is not already billed/checked-out
    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    const orderData = orderDoc.data();
    if (orderData.hotelBilledAndCheckedOut || orderData.hotelCheckoutId) {
      return res.status(400).json({
        success: false,
        error: 'Order has already been billed and checked-out',
        message: `Order ${orderId} was already processed in a previous checkout`
      });
    }

    const checkInRef = db.collection(COLLECTIONS.checkIns).doc(checkInId);
    const checkInDoc = await checkInRef.get();

    if (!checkInDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Check-in not found'
      });
    }

    const checkInData = checkInDoc.data();

    // Add order to foodOrders array (with duplicate prevention)
    const foodOrders = checkInData.foodOrders || [];

    // Check if order is already linked to prevent duplicates
    const existingOrder = foodOrders.find(order => order.orderId === orderId);
    if (existingOrder) {
      return res.status(400).json({
        success: false,
        error: 'Order already linked to this check-in',
        message: `Order ${orderId} is already linked to room ${checkInData.roomNumber}`
      });
    }

    // Use finalAmount (with tax) if available, otherwise use provided orderAmount
    const finalOrderAmount = orderData.finalAmount || (orderData.totalAmount + (orderData.taxAmount || 0)) || orderAmount;
    
    foodOrders.push({
      orderId,
      amount: Math.round(finalOrderAmount * 100) / 100, // Use final amount with tax
      linkedAt: new Date(),
      status: orderData.status || 'pending',
      paymentStatus: orderData.paymentStatus || 'pending',
      createdAt: orderData.createdAt || new Date(),
      dailyOrderId: orderData.dailyOrderId || null,
      orderNumber: orderData.orderNumber || null
    });

    // Update totals
    const totalFoodCharges = (checkInData.totalFoodCharges || 0) + orderAmount;
    const totalCharges = checkInData.totalRoomCharges + totalFoodCharges;
    const balanceAmount = totalCharges - (checkInData.advancePayment || 0);

    // Update check-in with linked order
    await checkInRef.update({
      foodOrders,
      totalFoodCharges,
      totalCharges,
      balanceAmount,
      lastUpdated: FieldValue.serverTimestamp()
    });

    // IMPORTANT: Mark order as linked to this check-in to prevent re-linking
    await db.collection('orders').doc(orderId).update({
      hotelCheckInId: checkInId,
      linkedToHotel: true,
      hotelLinkTimestamp: FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Order linked to room successfully',
      totalFoodCharges,
      totalCharges,
      balanceAmount
    });

  } catch (error) {
    console.error('Link order error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to link order'
    });
  }
});

// ==================== CHECKOUT ====================

/**
 * POST /api/hotel/checkout/:checkInId
 * Process hotel checkout and generate final invoice
 */
router.post('/hotel/checkout/:checkInId', authenticateToken, async (req, res) => {
  try {
    const { checkInId } = req.params;
    const { userId } = req.user;
    const {
      finalPayment,
      paymentMode,
      discounts,
      additionalCharges,
      notes
    } = req.body;

    const checkInRef = db.collection(COLLECTIONS.checkIns).doc(checkInId);
    const checkInDoc = await checkInRef.get();

    if (!checkInDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Check-in not found'
      });
    }

    const checkInData = checkInDoc.data();

    if (checkInData.status === 'checked-out') {
      return res.status(400).json({
        success: false,
        error: 'Guest has already checked out'
      });
    }

    // Recalculate totals from actual data (don't rely on stored values which might be 0)
    // 1. Recalculate room charges
    const roomTariff = checkInData.roomTariff || 0;
    const stayDuration = checkInData.stayDuration || 1;
    const totalRoomCharges = roomTariff * stayDuration;

    // 2. Recalculate food charges from foodOrders array
    const foodOrders = checkInData.foodOrders || [];
    const totalFoodCharges = foodOrders.reduce((sum, order) => sum + (order.amount || 0), 0);

    // 3. Calculate subtotal (room + food)
    let subtotal = totalRoomCharges + totalFoodCharges;

    // 4. Add additional charges if any
    let additionalChargesTotal = 0;
    if (additionalCharges && Array.isArray(additionalCharges)) {
      additionalChargesTotal = additionalCharges.reduce((sum, charge) => sum + (charge.amount || 0), 0);
      subtotal += additionalChargesTotal;
    }

    // 5. Apply discounts if any
    let discountAmount = 0;
    if (discounts && Array.isArray(discounts)) {
      discountAmount = discounts.reduce((sum, discount) => sum + (discount.amount || 0), 0);
      subtotal -= discountAmount;
    }

    // 6. Final total charges
    const totalCharges = subtotal;

    const totalPaid = (checkInData.advancePayment || 0) + (finalPayment || 0);
    const balanceAmount = totalCharges - totalPaid;

    // Update check-in record with recalculated values
    const checkoutData = {
      status: 'checked-out',
      actualCheckOutAt: FieldValue.serverTimestamp(),
      finalPayment: finalPayment || 0,
      finalPaymentMode: paymentMode || 'cash',
      totalRoomCharges, // Update with recalculated value
      totalFoodCharges, // Update with recalculated value
      totalCharges,
      discounts: discounts || [],
      discountAmount,
      additionalCharges: additionalCharges || [],
      totalPaid,
      balanceAmount,
      checkoutNotes: notes || null,
      checkOutBy: userId,
      billingComplete: balanceAmount <= 0,
      lastUpdated: FieldValue.serverTimestamp()
    };

    await checkInRef.update(checkoutData);

    // If there are linked food orders, mark them as billed and checked-out
    if (checkInData.foodOrders && checkInData.foodOrders.length > 0) {
      const batch = db.batch();

      for (const foodOrder of checkInData.foodOrders) {
        const orderRef = db.collection('orders').doc(foodOrder.orderId);
        batch.update(orderRef, {
          paymentStatus: 'paid',
          paidAt: FieldValue.serverTimestamp(),
          paidVia: 'hotel-checkout',
          // IMPORTANT: Mark as checked-out to prevent re-linking to future check-ins
          hotelCheckoutId: checkInId,
          hotelCheckoutAt: FieldValue.serverTimestamp(),
          hotelBilledAndCheckedOut: true
        });
      }

      await batch.commit();
      console.log(`✅ Marked ${checkInData.foodOrders.length} orders as billed and checked-out`);
    }

    // Update room status to cleaning/available
    const roomSnapshot = await db.collection('rooms')
      .where('restaurantId', '==', checkInData.restaurantId)
      .where('roomNumber', '==', checkInData.roomNumber)
      .limit(1)
      .get();

    if (!roomSnapshot.empty) {
      const roomDoc = roomSnapshot.docs[0];
      await db.collection('rooms').doc(roomDoc.id).update({
        status: 'cleaning', // Set to cleaning, staff can manually change to available
        currentGuest: null,
        checkInId: null,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    // Generate invoice data with recalculated values
    const invoice = {
      checkInId,
      guestName: checkInData.guestName,
      guestPhone: checkInData.guestPhone,
      guestEmail: checkInData.guestEmail,
      roomNumber: checkInData.roomNumber,
      checkInDate: checkInData.checkInDate,
      checkOutDate: checkInData.checkOutDate,
      actualCheckOutDate: new Date(),
      stayDuration: checkInData.stayDuration,
      roomTariff: checkInData.roomTariff,
      roomCharges: totalRoomCharges, // Use recalculated value
      foodCharges: totalFoodCharges, // Use recalculated value
      additionalCharges: additionalCharges || [],
      discounts: discounts || [],
      subtotal: totalRoomCharges + totalFoodCharges + additionalChargesTotal,
      discountAmount,
      totalAmount: totalCharges,
      advancePayment: checkInData.advancePayment || 0,
      finalPayment: finalPayment || 0,
      totalPaid,
      balanceAmount,
      foodOrders: checkInData.foodOrders || [],
      idProof: checkInData.idProof || null,
      gstInfo: checkInData.gstInfo || null
    };

    res.json({
      success: true,
      message: 'Checkout completed successfully',
      invoice,
      checkOut: {
        id: checkInId,
        ...checkoutData
      }
    });

  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to process checkout'
    });
  }
});

// ==================== GET INVOICE ====================

/**
 * GET /api/hotel/invoice/:checkInId
 * Get invoice for a check-in
 */
router.get('/hotel/invoice/:checkInId', authenticateToken, async (req, res) => {
  try {
    const { checkInId } = req.params;

    const checkInDoc = await db.collection(COLLECTIONS.checkIns).doc(checkInId).get();

    if (!checkInDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Check-in not found'
      });
    }

    const data = checkInDoc.data();

    // Recalculate totals from actual data (don't rely on stored values which might be 0)
    // 1. Recalculate room charges
    const roomTariff = data.roomTariff || 0;
    const stayDuration = data.stayDuration || 1;
    const totalRoomCharges = roomTariff * stayDuration;

    // 2. Recalculate food charges from foodOrders array
    const foodOrders = data.foodOrders || [];
    const totalFoodCharges = foodOrders.reduce((sum, order) => sum + (order.amount || 0), 0);

    // 3. Calculate subtotal (room + food)
    let subtotal = totalRoomCharges + totalFoodCharges;

    // 4. Add additional charges if any
    const additionalCharges = data.additionalCharges || [];
    let additionalChargesTotal = 0;
    if (additionalCharges.length > 0) {
      additionalChargesTotal = additionalCharges.reduce((sum, charge) => sum + (charge.amount || 0), 0);
      subtotal += additionalChargesTotal;
    }

    // 5. Apply discounts if any
    const discounts = data.discounts || [];
    const discountAmount = discounts.reduce((sum, discount) => sum + (discount.amount || 0), 0);
    subtotal -= discountAmount;

    // 6. Final total charges
    const totalCharges = subtotal;

    // 7. Calculate payments
    const advancePayment = data.advancePayment || 0;
    const finalPayment = data.finalPayment || 0;
    const totalPaid = advancePayment + finalPayment;
    const balanceAmount = totalCharges - totalPaid;

    const invoice = {
      checkInId,
      guestName: data.guestName,
      guestPhone: data.guestPhone,
      guestEmail: data.guestEmail,
      roomNumber: data.roomNumber,
      checkInDate: data.checkInDate?.toDate?.() || data.checkInDate,
      checkOutDate: data.checkOutDate?.toDate?.() || data.checkOutDate,
      actualCheckOutDate: data.actualCheckOutAt?.toDate?.() || null,
      stayDuration: data.stayDuration,
      roomTariff: data.roomTariff,
      roomCharges: totalRoomCharges, // Use recalculated value
      foodCharges: totalFoodCharges, // Use recalculated value
      additionalCharges: additionalCharges,
      discounts: discounts,
      subtotal: totalRoomCharges + totalFoodCharges + additionalChargesTotal,
      discountAmount: discountAmount,
      totalAmount: totalCharges, // Use recalculated value
      advancePayment: advancePayment,
      finalPayment: finalPayment,
      totalPaid: totalPaid, // Use recalculated value
      balanceAmount: balanceAmount, // Use recalculated value
      status: data.status,
      billingComplete: data.billingComplete || false,
      foodOrders: foodOrders,
      idProof: data.idProof || null,
      gstInfo: data.gstInfo || null
    };

    res.json({
      success: true,
      invoice
    });

  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch invoice'
    });
  }
});

// ==================== UPDATE CHECK-IN ====================

/**
 * PATCH /api/hotel/checkin/:checkInId
 * Update check-in details
 */
router.patch('/hotel/checkin/:checkInId', authenticateToken, async (req, res) => {
  try {
    const { checkInId } = req.params;
    const updates = req.body;

    // Remove fields that shouldn't be updated directly
    delete updates.restaurantId;
    delete updates.guestId;
    delete updates.status;
    delete updates.checkInAt;
    delete updates.checkOutBy;

    updates.lastUpdated = FieldValue.serverTimestamp();

    await db.collection(COLLECTIONS.checkIns).doc(checkInId).update(updates);

    res.json({
      success: true,
      message: 'Check-in updated successfully'
    });

  } catch (error) {
    console.error('Update check-in error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update check-in'
    });
  }
});

// ==================== GUEST SEARCH ====================

/**
 * GET /api/hotel/guests/:restaurantId
 * Search guests by phone or name
 */
router.get('/hotel/guests/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { phone, name } = req.query;

    let query = db.collection(COLLECTIONS.guests)
      .where('restaurantId', '==', restaurantId);

    if (phone) {
      query = query.where('phone', '==', phone);
    }

    const snapshot = await query.limit(50).get();

    let guests = [];
    snapshot.forEach(doc => {
      guests.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Filter by name if provided (Firestore doesn't support case-insensitive search)
    if (name) {
      const searchName = name.toLowerCase();
      guests = guests.filter(guest =>
        guest.name?.toLowerCase().includes(searchName)
      );
    }

    res.json({
      success: true,
      guests,
      total: guests.length
    });

  } catch (error) {
    console.error('Guest search error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search guests'
    });
  }
});

// ==================== ROOM AVAILABILITY ====================

/**
 * GET /api/hotel/rooms/availability
 * Get room availability for a specific date
 * Query params: date (YYYY-MM-DD), restaurantId
 */
router.get('/hotel/rooms/availability', authenticateToken, async (req, res) => {
  try {
    const { date, restaurantId } = req.query;

    if (!date || !restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query params: date, restaurantId'
      });
    }

    // Parse the date and create date range for the query
    const queryDate = new Date(date);
    queryDate.setHours(0, 0, 0, 0);

    const nextDay = new Date(queryDate);
    nextDay.setDate(nextDay.getDate() + 1);

    // Get all rooms for the restaurant
    const roomsSnapshot = await db.collection('rooms')
      .where('restaurantId', '==', restaurantId)
      .get();

    const rooms = [];
    roomsSnapshot.forEach(doc => {
      rooms.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Get all bookings that overlap with the query date
    const bookingsSnapshot = await db.collection('hotel_bookings')
      .where('restaurantId', '==', restaurantId)
      .where('status', 'in', ['confirmed', 'checked-in'])
      .get();

    const bookings = [];
    bookingsSnapshot.forEach(doc => {
      const data = doc.data();
      const checkIn = new Date(data.checkInDate);
      const checkOut = new Date(data.checkOutDate);

      // Check if booking overlaps with query date
      if (checkIn <= queryDate && checkOut > queryDate) {
        bookings.push({
          id: doc.id,
          ...data,
          roomId: data.roomId || null,
          roomNumber: data.roomNumber || null
        });
      }
    });

    // Get all active check-ins that overlap with the query date
    const checkInsSnapshot = await db.collection(COLLECTIONS.checkIns)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'checked-in')
      .get();

    const checkIns = [];
    checkInsSnapshot.forEach(doc => {
      const data = doc.data();
      const checkIn = new Date(data.checkInDate);
      const checkOut = new Date(data.checkOutDate);

      // Check if check-in overlaps with query date
      if (checkIn <= queryDate && checkOut > queryDate) {
        checkIns.push({
          id: doc.id,
          ...data
        });
      }
    });

    // Get all active maintenance schedules that overlap with the query date
    const maintenanceSnapshot = await db.collection('room_maintenance_schedules')
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'active')
      .get();

    const maintenanceSchedules = [];
    maintenanceSnapshot.forEach(doc => {
      const data = doc.data();
      
      // Parse dates - handle both Firestore Timestamp and Date objects
      let startDate;
      let endDate;
      
      if (data.startDate instanceof Date) {
        startDate = new Date(data.startDate);
      } else if (data.startDate && data.startDate._seconds) {
        startDate = new Date(data.startDate._seconds * 1000);
      } else if (data.startDate) {
        startDate = new Date(data.startDate);
      } else {
        return; // Skip if no valid start date
      }
      
      if (data.endDate instanceof Date) {
        endDate = new Date(data.endDate);
      } else if (data.endDate && data.endDate._seconds) {
        endDate = new Date(data.endDate._seconds * 1000);
      } else if (data.endDate) {
        endDate = new Date(data.endDate);
      } else {
        return; // Skip if no valid end date
      }
      
      // Normalize dates to start of day for comparison
      startDate.setHours(0, 0, 0, 0);
      endDate.setHours(23, 59, 59, 999); // End of day

      // Check if maintenance schedule overlaps with query date
      if (startDate <= queryDate && endDate >= queryDate) {
        maintenanceSchedules.push({
          id: doc.id,
          roomId: data.roomId,
          roomNumber: data.roomNumber,
          startDate,
          endDate,
          reason: data.reason
        });
      }
    });

    // Build room availability map
    const roomAvailability = rooms.map(room => {
      // Check if room has an active check-in
      const activeCheckIn = checkIns.find(ci => ci.roomNumber === room.roomNumber);

      // Check if room has a booking
      const booking = bookings.find(b =>
        b.roomNumber === room.roomNumber || b.roomId === room.id
      );

      // Check if room has an active maintenance schedule for this date
      const maintenanceSchedule = maintenanceSchedules.find(ms => 
        ms.roomId === room.id || ms.roomNumber === room.roomNumber
      );

      let currentStatus = room.status || 'available';
      let scheduledStatus = room.status || 'available';
      let bookingInfo = null;

      // Determine current status (real-time) - prioritize check-ins, then maintenance schedules, then room status
      if (activeCheckIn) {
        currentStatus = 'occupied';
      } else if (maintenanceSchedule) {
        // If there's a maintenance schedule for this date, show maintenance
        currentStatus = 'maintenance';
      } else if (room.status === 'cleaning' || room.status === 'maintenance' || room.status === 'out-of-service') {
        // Only use room.status if there's no date-specific maintenance
        currentStatus = room.status;
      } else {
        currentStatus = 'available';
      }

      // Determine scheduled status (based on bookings and maintenance schedules)
      if (booking) {
        scheduledStatus = 'booked';
        bookingInfo = {
          id: booking.id,
          guestName: booking.guestName,
          checkInDate: booking.checkInDate,
          checkOutDate: booking.checkOutDate,
          status: booking.status
        };
      } else if (activeCheckIn) {
        scheduledStatus = 'occupied';
        bookingInfo = {
          id: activeCheckIn.id,
          guestName: activeCheckIn.guestName,
          checkInDate: activeCheckIn.checkInDate,
          checkOutDate: activeCheckIn.checkOutDate,
          status: 'checked-in'
        };
      } else if (maintenanceSchedule) {
        // If there's a maintenance schedule for this date, show maintenance
        scheduledStatus = 'maintenance';
      } else if (room.status === 'cleaning' || room.status === 'maintenance' || room.status === 'out-of-service') {
        // Only use room.status if there's no date-specific maintenance
        scheduledStatus = room.status;
      } else {
        scheduledStatus = 'available';
      }

      return {
        id: room.id,
        roomNumber: room.roomNumber,
        roomType: room.roomType || null,
        floor: room.floor || null,
        currentStatus,
        scheduledStatus,
        booking: bookingInfo
      };
    });

    // Calculate summary
    const summary = {
      total: rooms.length,
      available: roomAvailability.filter(r => r.scheduledStatus === 'available').length,
      occupied: roomAvailability.filter(r => r.scheduledStatus === 'occupied').length,
      booked: roomAvailability.filter(r => r.scheduledStatus === 'booked').length,
      cleaning: roomAvailability.filter(r => r.scheduledStatus === 'cleaning').length,
      maintenance: roomAvailability.filter(r => r.scheduledStatus === 'maintenance').length,
      outOfService: roomAvailability.filter(r => r.scheduledStatus === 'out-of-service').length
    };

    res.json({
      success: true,
      date: date,
      rooms: roomAvailability,
      summary
    });

  } catch (error) {
    console.error('Room availability error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch room availability'
    });
  }
});

// ==================== BOOKING OVERLAP VALIDATION ====================

/**
 * POST /api/hotel/bookings/validate
 * Validate if a booking has date overlaps
 */
router.post('/hotel/bookings/validate', authenticateToken, async (req, res) => {
  try {
    const { roomId, roomNumber, checkInDate, checkOutDate, excludeBookingId, restaurantId } = req.body;

    if ((!roomId && !roomNumber) || !checkInDate || !checkOutDate || !restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: (roomId or roomNumber), checkInDate, checkOutDate, restaurantId'
      });
    }

    const newStart = new Date(checkInDate);
    const newEnd = new Date(checkOutDate);

    // Get all bookings for this room
    let bookingsQuery = db.collection('hotel_bookings')
      .where('restaurantId', '==', restaurantId)
      .where('status', 'in', ['confirmed', 'checked-in']);

    if (roomId) {
      bookingsQuery = bookingsQuery.where('roomId', '==', roomId);
    }

    const bookingsSnapshot = await bookingsQuery.get();

    // Filter by roomNumber if roomId not provided
    let bookings = [];
    bookingsSnapshot.forEach(doc => {
      const data = doc.data();
      if (!roomId && data.roomNumber !== roomNumber) {
        return; // Skip if roomNumber doesn't match
      }
      if (excludeBookingId && doc.id === excludeBookingId) {
        return; // Skip the booking being edited
      }
      bookings.push({
        id: doc.id,
        ...data
      });
    });

    // Check for overlaps in bookings
    const bookingConflicts = bookings.filter(booking => {
      const existingStart = new Date(booking.checkInDate);
      const existingEnd = new Date(booking.checkOutDate);

      // Overlap check: existingStart < newEnd AND existingEnd > newStart
      return existingStart < newEnd && existingEnd > newStart;
    });

    // Also check check-ins
    let checkInsQuery = db.collection(COLLECTIONS.checkIns)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'checked-in');

    if (roomNumber) {
      checkInsQuery = checkInsQuery.where('roomNumber', '==', roomNumber);
    }

    const checkInsSnapshot = await checkInsQuery.get();

    const checkInConflicts = [];
    checkInsSnapshot.forEach(doc => {
      const data = doc.data();
      const existingStart = new Date(data.checkInDate);
      const existingEnd = new Date(data.checkOutDate);

      // Overlap check
      if (existingStart < newEnd && existingEnd > newStart) {
        checkInConflicts.push({
          id: doc.id,
          ...data,
          type: 'check-in'
        });
      }
    });

    const allConflicts = [...bookingConflicts, ...checkInConflicts];
    const hasConflict = allConflicts.length > 0;

    res.json({
      success: true,
      hasConflict,
      conflicts: allConflicts
    });

  } catch (error) {
    console.error('Booking validation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to validate booking'
    });
  }
});

// ==================== CALENDAR SUMMARY ====================

/**
 * GET /api/hotel/calendar/summary
 * Get booking summary for a month
 * Query params: month (1-12), year (YYYY), restaurantId
 */
router.get('/hotel/calendar/summary', authenticateToken, async (req, res) => {
  try {
    const { month, year, restaurantId } = req.query;

    if (!month || !year || !restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query params: month, year, restaurantId'
      });
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);

    // Get first and last day of month
    const startDate = new Date(yearNum, monthNum - 1, 1);
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(yearNum, monthNum, 0);
    endDate.setHours(23, 59, 59, 999);

    // Get total number of rooms
    const roomsSnapshot = await db.collection('rooms')
      .where('restaurantId', '==', restaurantId)
      .get();

    const totalRooms = roomsSnapshot.size;

    // Get all bookings that overlap with this month
    const bookingsSnapshot = await db.collection('hotel_bookings')
      .where('restaurantId', '==', restaurantId)
      .where('status', 'in', ['confirmed', 'checked-in'])
      .get();

    const bookings = [];
    bookingsSnapshot.forEach(doc => {
      bookings.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Get all check-ins that overlap with this month
    const checkInsSnapshot = await db.collection(COLLECTIONS.checkIns)
      .where('restaurantId', '==', restaurantId)
      .get();

    const checkIns = [];
    checkInsSnapshot.forEach(doc => {
      checkIns.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Build daily summary
    const dailySummary = {};

    // Iterate through each day of the month
    for (let date = new Date(startDate); date <= endDate; date.setDate(date.getDate() + 1)) {
      const dateStr = date.toISOString().split('T')[0];
      const currentDate = new Date(date);
      currentDate.setHours(0, 0, 0, 0);

      const nextDay = new Date(currentDate);
      nextDay.setDate(nextDay.getDate() + 1);

      // Count bookings for this date
      const bookingsOnDate = bookings.filter(booking => {
        const checkIn = new Date(booking.checkInDate);
        const checkOut = new Date(booking.checkOutDate);
        return checkIn <= currentDate && checkOut > currentDate;
      });

      // Count check-ins for this date
      const checkInsOnDate = checkIns.filter(checkIn => {
        const ciDate = new Date(checkIn.checkInDate);
        const coDate = new Date(checkIn.checkOutDate);
        return ciDate <= currentDate && coDate > currentDate;
      });

      const totalBookings = bookingsOnDate.length + checkInsOnDate.length;
      const occupancyRate = totalRooms > 0 ? (totalBookings / totalRooms) * 100 : 0;
      const availableRooms = totalRooms - totalBookings;

      dailySummary[dateStr] = {
        bookingCount: totalBookings,
        occupancyRate: Math.round(occupancyRate * 10) / 10, // Round to 1 decimal
        availableRooms,
        occupiedRooms: bookingsOnDate.map(b => b.roomNumber || b.roomId).filter(Boolean),
        checkInCount: checkInsOnDate.length,
        bookingListCount: bookingsOnDate.length
      };
    }

    res.json({
      success: true,
      month: monthNum,
      year: yearNum,
      totalRooms,
      summary: dailySummary
    });

  } catch (error) {
    console.error('Calendar summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch calendar summary'
    });
  }
});

// ==================== ROOM HISTORY ====================

/**
 * GET /api/hotel/history
 * Get room history (past check-ins)
 * Query params: startDate, endDate, roomId, status, restaurantId
 */
router.get('/hotel/history', authenticateToken, async (req, res) => {
  try {
    const { startDate, endDate, roomId, status, restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query param: restaurantId'
      });
    }

    let query = db.collection(COLLECTIONS.checkIns)
      .where('restaurantId', '==', restaurantId);

    // Filter by status (default to checked-out for history)
    if (status) {
      query = query.where('status', '==', status);
    } else {
      query = query.where('status', '==', 'checked-out');
    }

    const snapshot = await query.orderBy('actualCheckOutAt', 'desc').get();

    let history = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      history.push({
        id: doc.id,
        ...data,
        checkInDate: data.checkInDate?.toDate?.() || data.checkInDate,
        checkOutDate: data.checkOutDate?.toDate?.() || data.checkOutDate,
        actualCheckOutAt: data.actualCheckOutAt?.toDate?.() || data.actualCheckOutAt,
        checkInAt: data.checkInAt?.toDate?.() || data.checkInAt
      });
    });

    // Filter by date range if provided
    if (startDate || endDate) {
      history = history.filter(record => {
        const checkOutDate = new Date(record.checkOutDate);

        if (startDate && endDate) {
          return checkOutDate >= new Date(startDate) && checkOutDate <= new Date(endDate);
        } else if (startDate) {
          return checkOutDate >= new Date(startDate);
        } else if (endDate) {
          return checkOutDate <= new Date(endDate);
        }

        return true;
      });
    }

    // Filter by roomId if provided
    if (roomId) {
      // Get room number from roomId
      const roomDoc = await db.collection('rooms').doc(roomId).get();
      if (roomDoc.exists) {
        const roomNumber = roomDoc.data().roomNumber;
        history = history.filter(record => record.roomNumber === roomNumber);
      } else {
        history = [];
      }
    }

    res.json({
      success: true,
      history,
      total: history.length
    });

  } catch (error) {
    console.error('Room history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch room history'
    });
  }
});

module.exports = router;
