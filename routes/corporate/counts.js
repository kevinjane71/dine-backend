// Live meal counts for a site/date, grouped by meal period: booked vs consumed (+ subsidy/copay
// totals). Powers the ops "live counts" board and prep planning. Cheap aggregation over the day.
const express = require('express');
const router = express.Router();
const { db } = require('./_shared');

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// GET /api/corporate/counts?siteId=&date=
router.get('/', async (req, res) => {
  try {
    const date = req.query.date || todayIST();
    const siteId = req.query.siteId;

    const byPeriod = {};
    const ensure = (pid) => (byPeriod[pid] = byPeriod[pid] || { periodId: pid, booked: 0, consumed: 0, subsidyTotal: 0, copayTotal: 0, revenue: 0 });

    // Bookings
    let bq = db.collection('mealBookings').where('restaurantId', '==', req.corporateRestaurantId).where('date', '==', date);
    if (siteId) bq = bq.where('siteId', '==', siteId);
    (await bq.get()).forEach(d => { const x = d.data(); if (x.status === 'booked') ensure(x.periodId).booked++; });

    // Consumptions
    let cq = db.collection('mealConsumptions').where('restaurantId', '==', req.corporateRestaurantId).where('date', '==', date);
    if (siteId) cq = cq.where('siteId', '==', siteId);
    (await cq.get()).forEach(d => {
      const x = d.data(); if (x.status === 'reversed') return;
      const p = ensure(x.periodId);
      p.consumed++;
      p.subsidyTotal += Number(x.subsidyAmount) || 0;
      p.copayTotal += Number(x.employeeCopay) || 0;
      p.revenue += Number(x.amount) || 0;
    });

    const periods = Object.values(byPeriod).map(p => ({
      ...p,
      subsidyTotal: Math.round(p.subsidyTotal * 100) / 100,
      copayTotal: Math.round(p.copayTotal * 100) / 100,
      revenue: Math.round(p.revenue * 100) / 100,
    }));
    const totals = periods.reduce((t, p) => ({
      booked: t.booked + p.booked, consumed: t.consumed + p.consumed,
      subsidyTotal: Math.round((t.subsidyTotal + p.subsidyTotal) * 100) / 100,
      copayTotal: Math.round((t.copayTotal + p.copayTotal) * 100) / 100,
      revenue: Math.round((t.revenue + p.revenue) * 100) / 100,
    }), { booked: 0, consumed: 0, subsidyTotal: 0, copayTotal: 0, revenue: 0 });

    res.json({ date, siteId: siteId || null, periods, totals });
  } catch (e) { console.error('counts error', e.message); res.status(500).json({ error: 'Failed to get counts' }); }
});

module.exports = router;
