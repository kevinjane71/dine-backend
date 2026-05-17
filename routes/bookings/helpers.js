const { FieldValue } = require('firebase-admin/firestore');

/**
 * Generate a booking number: BK-YYYYMMDD-XXX
 */
async function generateBookingNumber(db, collections, restaurantId) {
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0].replace(/-/g, '');
  const prefix = `BK-${dateStr}`;

  try {
    // Count today's bookings by bookingNumber prefix (single-field range, no composite index needed)
    const snap = await db.collection(collections.bookings)
      .where('bookingNumber', '>=', prefix)
      .where('bookingNumber', '<=', prefix + '\uf8ff')
      .count()
      .get();

    const seq = (snap.data().count || 0) + 1;
    return `${prefix}-${String(seq).padStart(3, '0')}`;
  } catch (err) {
    // Fallback: use timestamp-based sequence
    console.warn('generateBookingNumber query failed, using fallback:', err.message);
    const seq = (Date.now() % 900) + 100;
    return `${prefix}-${String(seq)}`;
  }
}

/**
 * Check venue availability for a given date/time range.
 * Returns { available: boolean, conflicts: [] }
 */
async function checkVenueConflict(db, collections, restaurantId, venueId, eventDate, eventEndDate, eventTime, eventEndTime, excludeBookingId) {
  // Get all non-cancelled venue bookings for this venue in the date range
  const dates = [];
  const start = new Date(eventDate);
  const end = eventEndDate ? new Date(eventEndDate) : start;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().split('T')[0]);
  }

  // Query bookings for this venue that overlap with any of the dates
  const conflicts = [];

  for (const date of dates) {
    let query = db.collection(collections.bookings)
      .where('restaurantId', '==', restaurantId)
      .where('venue.venueId', '==', venueId)
      .where('status', 'in', ['confirmed', 'in_progress']);

    const snap = await query.get();

    snap.forEach(doc => {
      if (excludeBookingId && doc.id === excludeBookingId) return;

      const booking = doc.data();
      const bStart = booking.eventDate;
      const bEnd = booking.eventEndDate || bStart;

      // Check if date falls within this booking's date range
      if (date < bStart || date > bEnd) return;

      // Check time overlap (if times are specified)
      if (eventTime && eventEndTime && booking.eventTime && booking.eventEndTime) {
        const reqStart = timeToMinutes(eventTime);
        const reqEnd = timeToMinutes(eventEndTime);
        const bookStart = timeToMinutes(booking.eventTime);
        const bookEnd = timeToMinutes(booking.eventEndTime);

        // No overlap if one ends before the other starts
        if (reqEnd <= bookStart || reqStart >= bookEnd) return;
      }

      conflicts.push({
        bookingId: doc.id,
        bookingNumber: booking.bookingNumber,
        eventName: booking.eventName,
        date,
        time: `${booking.eventTime || ''} - ${booking.eventEndTime || ''}`,
        customerName: booking.customer?.name || '',
      });
    });
  }

  return { available: conflicts.length === 0, conflicts };
}

function timeToMinutes(time) {
  if (!time) return 0;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Create expense entry in inv_expenses on booking completion
 */
async function createExpenseEntry(db, collections, booking, userId) {
  const expenseData = {
    orgId: userId,
    date: booking.eventDate || new Date().toISOString().split('T')[0],
    category: 'catering',
    amount: booking.totalAmount || 0,
    currency: 'INR',
    invoiceNumber: booking.bookingNumber,
    notes: `Booking: ${booking.eventName || booking.bookingNumber} - ${booking.customer?.name || 'Unknown'}`,
    customerId: booking.customer?.id || null,
    isBillable: false,
    bookingId: booking.id || null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const ref = await db.collection(collections.invExpenses).add(expenseData);
  return ref.id;
}

/**
 * Build date filter for queries
 */
function buildDateFilter(startDate, endDate) {
  if (!startDate && !endDate) return null;
  return {
    start: startDate || '1970-01-01',
    end: endDate || '2099-12-31',
  };
}

/**
 * Sync customer data to customers collection
 */
async function syncCustomerData(db, collections, restaurantId, customerData) {
  if (!customerData || !customerData.phone) return null;

  const phone = customerData.phone.trim();
  if (!phone) return null;

  // Look for existing customer
  const snap = await db.collection(collections.customers)
    .where('restaurantId', '==', restaurantId)
    .where('phone', '==', phone)
    .limit(1)
    .get();

  if (!snap.empty) {
    // Update existing customer with address if provided
    const doc = snap.docs[0];
    const updateData = { updatedAt: FieldValue.serverTimestamp() };

    if (customerData.name && !doc.data().name) updateData.name = customerData.name;
    if (customerData.email && !doc.data().email) updateData.email = customerData.email;
    if (customerData.address) updateData.address = customerData.address;

    if (Object.keys(updateData).length > 1) {
      await doc.ref.update(updateData);
    }
    return doc.id;
  } else {
    // Create new customer
    const newCustomer = {
      restaurantId,
      name: customerData.name || null,
      phone,
      email: customerData.email || null,
      address: customerData.address || null,
      source: 'booking',
      totalOrders: 0,
      totalSpent: 0,
      loyaltyPoints: 0,
      orderHistory: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    const ref = await db.collection(collections.customers).add(newCustomer);
    return ref.id;
  }
}

module.exports = {
  generateBookingNumber,
  checkVenueConflict,
  timeToMinutes,
  createExpenseEntry,
  buildDateFilter,
  syncCustomerData,
};
