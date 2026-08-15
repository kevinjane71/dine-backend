// Meal pre-bookings. Employees (Phase 2, phone-OTP) or operators book a meal for a date+period
// before the period's booking cutoff. Consumption at the counter can reference the booking.
const express = require('express');
const router = express.Router();
const { db, nowTs } = require('./_shared');

const COL = 'mealBookings';
const PERIODS = 'mealPeriods';
const EMP = 'employees';

function todayInTz(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function hmInTz(tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

// GET /api/corporate/bookings?employeeId=&siteId=&date=
router.get('/', async (req, res) => {
  try {
    let q = db.collection(COL).where('restaurantId', '==', req.corporateRestaurantId);
    if (req.query.employeeId) q = q.where('employeeId', '==', req.query.employeeId);
    else if (req.query.siteId) q = q.where('siteId', '==', req.query.siteId);
    const snap = await q.get();
    const bookings = [];
    snap.forEach(d => { const x = { id: d.id, ...d.data() }; if (!req.query.date || x.date === req.query.date) bookings.push(x); });
    res.json({ bookings });
  } catch (e) { console.error('list bookings', e.message); res.status(500).json({ error: 'Failed to list bookings' }); }
});

// POST /api/corporate/bookings  { employeeId, periodId, date, items? }
router.post('/', async (req, res) => {
  try {
    const { employeeId, periodId, date, items } = req.body || {};
    if (!employeeId || !periodId || !date) return res.status(400).json({ error: 'employeeId, periodId and date are required' });

    const emp = await db.collection(EMP).doc(employeeId).get();
    if (!emp.exists || emp.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Employee not found' });
    const pDoc = await db.collection(PERIODS).doc(periodId).get();
    if (!pDoc.exists || pDoc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Meal period not found' });
    const period = pDoc.data();

    // Cutoff: if booking for TODAY and a cutoff is set, enforce it in the site timezone.
    const site = emp.data().siteId ? await db.collection('corporateSites').doc(emp.data().siteId).get() : null;
    const tz = site?.exists ? (site.data().timezone || 'Asia/Kolkata') : 'Asia/Kolkata';
    if (period.bookingCutoff && date === todayInTz(tz) && hmInTz(tz) > period.bookingCutoff) {
      return res.status(409).json({ code: 'CUTOFF_PASSED', error: `Booking cutoff (${period.bookingCutoff}) has passed for today` });
    }

    // One booking per employee/period/date
    const dup = await db.collection(COL)
      .where('employeeId', '==', employeeId).where('periodId', '==', periodId).where('date', '==', date).get();
    let existing = null; dup.forEach(d => { if (d.data().status === 'booked') existing = { id: d.id, ...d.data() }; });
    if (existing) return res.json({ booking: existing, alreadyBooked: true });

    const booking = {
      restaurantId: req.corporateRestaurantId,
      employeeId, clientId: emp.data().clientId, siteId: emp.data().siteId,
      periodId, date,
      items: Array.isArray(items) ? items.map(i => ({ name: String(i.name || i).trim() })) : [],
      status: 'booked',
      source: req.body.source || 'operator',
      createdAt: nowTs(),
    };
    const ref = await db.collection(COL).add(booking);
    res.json({ booking: { id: ref.id, ...booking } });
  } catch (e) { console.error('create booking', e.message); res.status(500).json({ error: 'Failed to create booking' }); }
});

// DELETE /api/corporate/bookings/:id  (cancel; before cutoff for today)
router.delete('/:id', async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Booking not found' });
    await ref.update({ status: 'cancelled', updatedAt: nowTs() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to cancel booking' }); }
});

module.exports = router;
