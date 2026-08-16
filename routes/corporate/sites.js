// Corporate sites (a client's office/location with a canteen). A site maps to an outlet
// (outletId → an existing restaurant/canteen) where meals are served, and owns meal periods.
const express = require('express');
const router = express.Router();
const { db, requireOperator, nowTs } = require('./_shared');

const COL = 'corporateSites';
const CLIENTS = 'corporateClients';

async function assertClient(req, clientId) {
  if (!clientId) return null;
  const c = await db.collection(CLIENTS).doc(clientId).get();
  if (!c.exists || c.data().restaurantId !== req.corporateRestaurantId) return null;
  return c;
}

// GET /api/corporate/sites?clientId=...
router.get('/', async (req, res) => {
  try {
    let q = db.collection(COL).where('restaurantId', '==', req.corporateRestaurantId);
    if (req.query.clientId) q = q.where('clientId', '==', req.query.clientId);
    const snap = await q.get();
    const sites = [];
    snap.forEach(d => { const x = { id: d.id, ...d.data() }; if (x.status !== 'deleted') sites.push(x); });
    res.json({ sites });
  } catch (e) { console.error('list sites', e.message); res.status(500).json({ error: 'Failed to list sites' }); }
});

// GET /api/corporate/sites/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection(COL).doc(req.params.id).get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Site not found' });
    res.json({ site: { id: doc.id, ...doc.data() } });
  } catch (e) { res.status(500).json({ error: 'Failed to get site' }); }
});

// POST /api/corporate/sites
router.post('/', requireOperator, async (req, res) => {
  try {
    const { clientId, name, address, outletId, timezone } = req.body || {};
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Site name is required' });
    if (!(await assertClient(req, clientId))) return res.status(404).json({ error: 'Client not found' });
    const site = {
      restaurantId: req.corporateRestaurantId,
      clientId,
      name: String(name).trim(),
      address: address || '',
      outletId: outletId || req.corporateRestaurantId, // defaults to the operator outlet
      timezone: timezone || 'Asia/Kolkata',
      status: 'active',
      createdAt: nowTs(),
      updatedAt: nowTs(),
    };
    const ref = await db.collection(COL).add(site);
    res.json({ site: { id: ref.id, ...site } });
  } catch (e) { console.error('create site', e.message); res.status(500).json({ error: 'Failed to create site' }); }
});

// PATCH /api/corporate/sites/:id
router.patch('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Site not found' });
    const b = req.body || {};
    const patch = { updatedAt: nowTs() };
    if (b.name != null) patch.name = String(b.name).trim();
    if (b.address !== undefined) patch.address = b.address || '';
    if (b.outletId) patch.outletId = b.outletId;
    if (b.timezone) patch.timezone = b.timezone;
    if (b.status && ['active', 'inactive'].includes(b.status)) patch.status = b.status;
    await ref.update(patch);
    res.json({ site: { id: doc.id, ...doc.data(), ...patch } });
  } catch (e) { console.error('update site', e.message); res.status(500).json({ error: 'Failed to update site' }); }
});

// DELETE /api/corporate/sites/:id (soft)
router.delete('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Site not found' });
    await ref.update({ status: 'deleted', updatedAt: nowTs() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete site' }); }
});

module.exports = router;
