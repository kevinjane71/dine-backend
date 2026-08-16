// Corporate employees. Auth is phone-OTP via existing Firebase (phone is the link); each
// employee also gets a unique `qrToken` for counter verification. Supports bulk CSV import
// (frontend parses the CSV into rows) and QR rotation.
const express = require('express');
const router = express.Router();
const { db, requireOperator, genQrToken, nowTs } = require('./_shared');

const COL = 'employees';
const SITES = 'corporateSites';

function normEntitlement(e) {
  const x = e || {};
  return { periods: Array.isArray(x.periods) ? x.periods : [], dailyCap: Number(x.dailyCap) || 0 };
}

async function assertSite(req, siteId) {
  if (!siteId) return null;
  const s = await db.collection(SITES).doc(siteId).get();
  if (!s.exists || s.data().restaurantId !== req.corporateRestaurantId) return null;
  return s;
}

// GET /api/corporate/employees?siteId=&clientId=&phone=
router.get('/', async (req, res) => {
  try {
    let q = db.collection(COL).where('restaurantId', '==', req.corporateRestaurantId);
    if (req.query.siteId) q = q.where('siteId', '==', req.query.siteId);
    else if (req.query.clientId) q = q.where('clientId', '==', req.query.clientId);
    if (req.query.phone) q = q.where('phone', '==', String(req.query.phone));
    const snap = await q.get();
    const employees = [];
    snap.forEach(d => { const x = { id: d.id, ...d.data() }; if (x.status !== 'deleted') employees.push(x); });
    res.json({ employees });
  } catch (e) { console.error('list employees', e.message); res.status(500).json({ error: 'Failed to list employees' }); }
});

// GET /api/corporate/employees/:id
router.get('/:id', async (req, res) => {
  try {
    const doc = await db.collection(COL).doc(req.params.id).get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Employee not found' });
    res.json({ employee: { id: doc.id, ...doc.data() } });
  } catch (e) { res.status(500).json({ error: 'Failed to get employee' }); }
});

function buildEmployee(req, siteDoc, row) {
  return {
    restaurantId: req.corporateRestaurantId,
    clientId: siteDoc.data().clientId,
    siteId: siteDoc.id,
    empCode: String(row.empCode || '').trim(),
    name: String(row.name || '').trim(),
    phone: row.phone ? String(row.phone).trim() : null,
    email: row.email ? String(row.email).trim() : null,
    qrToken: genQrToken(),
    pluxeeCardId: row.pluxeeCardId || null,
    walletBalance: Number(row.walletBalance) || 0,
    entitlement: normEntitlement(row.entitlement),
    status: 'active',
    createdAt: nowTs(),
    updatedAt: nowTs(),
  };
}

// POST /api/corporate/employees  { siteId, ...employee }
router.post('/', requireOperator, async (req, res) => {
  try {
    const { siteId } = req.body || {};
    if (!siteId) return res.status(400).json({ error: 'siteId is required' });
    if (!req.body.name || !String(req.body.name).trim()) return res.status(400).json({ error: 'Employee name is required' });
    const site = await assertSite(req, siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    const emp = buildEmployee(req, site, req.body);
    const ref = await db.collection(COL).add(emp);
    res.json({ employee: { id: ref.id, ...emp } });
  } catch (e) { console.error('create employee', e.message); res.status(500).json({ error: 'Failed to create employee' }); }
});

// POST /api/corporate/employees/import  { siteId, employees: [ {empCode,name,phone,email}, ... ] }
router.post('/import', requireOperator, async (req, res) => {
  try {
    const { siteId, employees } = req.body || {};
    if (!siteId) return res.status(400).json({ error: 'siteId is required' });
    if (!Array.isArray(employees) || employees.length === 0) return res.status(400).json({ error: 'employees array is required' });
    if (employees.length > 2000) return res.status(400).json({ error: 'Max 2000 rows per import' });
    const site = await assertSite(req, siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Firestore batch cap is 500 writes — chunk it.
    let created = 0; const skipped = [];
    for (let i = 0; i < employees.length; i += 400) {
      const chunk = employees.slice(i, i + 400);
      const batch = db.batch();
      chunk.forEach((row, j) => {
        if (!row || !String(row.name || '').trim()) { skipped.push(i + j); return; }
        const ref = db.collection(COL).doc();
        batch.set(ref, buildEmployee(req, site, row));
        created++;
      });
      await batch.commit();
    }
    res.json({ success: true, created, skipped });
  } catch (e) { console.error('import employees', e.message); res.status(500).json({ error: 'Failed to import employees' }); }
});

// PATCH /api/corporate/employees/:id
router.patch('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Employee not found' });
    const b = req.body || {};
    const patch = { updatedAt: nowTs() };
    if (b.name != null) patch.name = String(b.name).trim();
    if (b.empCode !== undefined) patch.empCode = String(b.empCode || '').trim();
    if (b.phone !== undefined) patch.phone = b.phone ? String(b.phone).trim() : null;
    if (b.email !== undefined) patch.email = b.email ? String(b.email).trim() : null;
    if (b.pluxeeCardId !== undefined) patch.pluxeeCardId = b.pluxeeCardId || null;
    if (b.entitlement) patch.entitlement = normEntitlement(b.entitlement);
    if (b.walletBalance !== undefined) patch.walletBalance = Number(b.walletBalance) || 0;
    if (b.status && ['active', 'inactive'].includes(b.status)) patch.status = b.status;
    await ref.update(patch);
    res.json({ employee: { id: doc.id, ...doc.data(), ...patch } });
  } catch (e) { console.error('update employee', e.message); res.status(500).json({ error: 'Failed to update employee' }); }
});

// POST /api/corporate/employees/:id/qr  — rotate the QR token (e.g. lost badge)
router.post('/:id/qr', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Employee not found' });
    const qrToken = genQrToken();
    await ref.update({ qrToken, updatedAt: nowTs() });
    res.json({ qrToken });
  } catch (e) { res.status(500).json({ error: 'Failed to rotate QR' }); }
});

// DELETE /api/corporate/employees/:id (soft)
router.delete('/:id', requireOperator, async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ error: 'Employee not found' });
    await ref.update({ status: 'deleted', updatedAt: nowTs() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete employee' }); }
});

module.exports = router;
