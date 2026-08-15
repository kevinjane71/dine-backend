// Corporate clients (the companies EverLoop caters for). Scoped to the operator restaurant.
// Subsidy policy + payment model live on the client doc (per-period override comes later).
const express = require('express');
const router = express.Router();
const { db, requireOperator, nowTs, PAYMENT_MODELS, SUBSIDY_RULES, DEFAULT_SUBSIDY } = require('./_shared');

const COL = 'corporateClients';

function normaliseSubsidy(input) {
  const s = input || {};
  return {
    rule: SUBSIDY_RULES.includes(s.rule) ? s.rule : DEFAULT_SUBSIDY.rule,
    employerShare: Number(s.employerShare) || 0, // percentage (0-100) or flat amount per meal
    caps: {
      perMeal: Number(s.caps?.perMeal) || 0,
      perDay: Number(s.caps?.perDay) || 0,
      perMonth: Number(s.caps?.perMonth) || 0,
    },
  };
}

// GET /api/corporate/clients — list clients for this operator
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection(COL)
      .where('restaurantId', '==', req.corporateRestaurantId)
      .get();
    const clients = [];
    snap.forEach(d => { const x = { id: d.id, ...d.data() }; if (x.status !== 'deleted') clients.push(x); });
    res.json({ clients });
  } catch (e) { console.error('list clients', e.message); res.status(500).json({ error: 'Failed to list clients' }); }
});

// GET /api/corporate/clients/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection(COL).doc(req.params.id).get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: { id: doc.id, ...doc.data() } });
  } catch (e) { res.status(500).json({ error: 'Failed to get client' }); }
});

// POST /api/corporate/clients
router.post('/', requireOperator, async (req, res) => {
  try {
    const { name, gstin, billingCycle, paymentModel, subsidyPolicy, contacts, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Client name is required' });
    const client = {
      restaurantId: req.corporateRestaurantId,
      organizationId: req.corporateOrgId || null,
      name: String(name).trim(),
      gstin: gstin || null,
      billingCycle: billingCycle || 'monthly',
      paymentModel: PAYMENT_MODELS.includes(paymentModel) ? paymentModel : 'prepaid_wallet',
      subsidyPolicy: normaliseSubsidy(subsidyPolicy),
      contacts: Array.isArray(contacts) ? contacts : [],
      notes: notes || '',
      status: 'active',
      createdAt: nowTs(),
      updatedAt: nowTs(),
    };
    const ref = await db.collection(COL).add(client);
    res.json({ client: { id: ref.id, ...client } });
  } catch (e) { console.error('create client', e.message); res.status(500).json({ error: 'Failed to create client' }); }
});

// PATCH /api/corporate/clients/:id
router.patch('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Client not found' });
    const b = req.body || {};
    const patch = { updatedAt: nowTs() };
    if (b.name != null) patch.name = String(b.name).trim();
    if (b.gstin !== undefined) patch.gstin = b.gstin || null;
    if (b.billingCycle) patch.billingCycle = b.billingCycle;
    if (b.paymentModel && PAYMENT_MODELS.includes(b.paymentModel)) patch.paymentModel = b.paymentModel;
    if (b.subsidyPolicy) patch.subsidyPolicy = normaliseSubsidy(b.subsidyPolicy);
    if (b.contacts) patch.contacts = Array.isArray(b.contacts) ? b.contacts : [];
    if (b.notes !== undefined) patch.notes = b.notes || '';
    if (b.status && ['active', 'inactive'].includes(b.status)) patch.status = b.status;
    await ref.update(patch);
    res.json({ client: { id: doc.id, ...doc.data(), ...patch } });
  } catch (e) { console.error('update client', e.message); res.status(500).json({ error: 'Failed to update client' }); }
});

// DELETE /api/corporate/clients/:id  (soft delete)
router.delete('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Client not found' });
    await ref.update({ status: 'deleted', updatedAt: nowTs() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete client' }); }
});

module.exports = router;
