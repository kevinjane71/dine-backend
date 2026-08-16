// Meal periods for a site (breakfast / lunch / dinner ...). Each has a serving window, a booking
// cutoff, a price, an optional menu (display items) and an optional subsidy override.
const express = require('express');
const router = express.Router();
const { db, requireOperator, nowTs } = require('./_shared');

const COL = 'mealPeriods';
const SITES = 'corporateSites';

async function assertSite(req, siteId) {
  if (!siteId) return null;
  const s = await db.collection(SITES).doc(siteId).get();
  if (!s.exists || s.data().restaurantId !== req.corporateRestaurantId) return null;
  return s;
}

function normPeriod(body, siteId, restaurantId) {
  return {
    restaurantId,
    siteId,
    name: String(body.name || '').trim(),
    startTime: body.startTime || '00:00',      // HH:MM (site timezone)
    endTime: body.endTime || '23:59',
    bookingCutoff: body.bookingCutoff || null,  // HH:MM on the SAME day, or null = no pre-booking needed
    price: Number(body.price) || 0,
    menu: Array.isArray(body.menu) ? body.menu.map(m => ({ name: String(m.name || m).trim() })) : [],
    subsidyOverride: body.subsidyOverride || null,
    active: body.active !== false,
    updatedAt: nowTs(),
  };
}

// GET /api/corporate/meal-periods?siteId=...
router.get('/', async (req, res) => {
  try {
    let q = db.collection(COL).where('restaurantId', '==', req.corporateRestaurantId);
    if (req.query.siteId) q = q.where('siteId', '==', req.query.siteId);
    const snap = await q.get();
    const periods = [];
    snap.forEach(d => { const x = { id: d.id, ...d.data() }; if (x.status !== 'deleted') periods.push(x); });
    periods.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    res.json({ periods });
  } catch (e) { console.error('list periods', e.message); res.status(500).json({ error: 'Failed to list meal periods' }); }
});

// POST /api/corporate/meal-periods  { siteId, name, startTime, endTime, bookingCutoff, price, menu[], subsidyOverride }
router.post('/', requireOperator, async (req, res) => {
  try {
    const { siteId, name } = req.body || {};
    if (!siteId) return res.status(400).json({ error: 'siteId is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Period name is required' });
    if (!(await assertSite(req, siteId))) return res.status(404).json({ error: 'Site not found' });
    const period = { ...normPeriod(req.body, siteId, req.corporateRestaurantId), createdAt: nowTs() };
    const ref = await db.collection(COL).add(period);
    res.json({ period: { id: ref.id, ...period } });
  } catch (e) { console.error('create period', e.message); res.status(500).json({ error: 'Failed to create meal period' }); }
});

// PATCH /api/corporate/meal-periods/:id
router.patch('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Meal period not found' });
    const patch = { ...normPeriod({ ...doc.data(), ...req.body }, doc.data().siteId, req.corporateRestaurantId) };
    await ref.update(patch);
    res.json({ period: { id: doc.id, ...patch } });
  } catch (e) { console.error('update period', e.message); res.status(500).json({ error: 'Failed to update meal period' }); }
});

// DELETE /api/corporate/meal-periods/:id (soft)
router.delete('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Meal period not found' });
    await ref.update({ status: 'deleted', active: false, updatedAt: nowTs() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete meal period' }); }
});

module.exports = router;
