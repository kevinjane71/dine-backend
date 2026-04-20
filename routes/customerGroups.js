// Customer Groups API
// CRUD for grouping customers (e.g. "Gym members") for targeted offers.
const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const admin = require('firebase-admin');

const COLLECTION = 'customerGroups';
const FieldValue = admin.firestore.FieldValue;

// ─── helpers ──────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function nowISO() { return new Date().toISOString(); }

function sanitizeGroupInput(body = {}) {
  return {
    name: String(body.name || '').trim(),
    description: String(body.description || '').trim(),
    color: String(body.color || '#6366f1').trim(),
    icon: String(body.icon || '').trim() || null,
  };
}

async function ensureRestaurantOwnership(req, restaurantId) {
  const userId = req.user.userId || req.user.id;
  const snap = await db.collection(collections.restaurants).doc(restaurantId).get();
  if (!snap.exists) return { ok: false, code: 404, error: 'Restaurant not found' };
  const data = snap.data();
  // owners + staff with same restaurant access (loose check; downstream APIs do similar)
  if (data.ownerId && data.ownerId !== userId && req.user.role === 'owner') {
    return { ok: false, code: 403, error: 'Not authorized' };
  }
  return { ok: true };
}

// ─── Lookup: which groups does a customer belong to? ──────────────────
// GET /lookup/:restaurantId?phone=98xxxx&customerId=...
// NOTE: Must be declared BEFORE /:restaurantId to avoid Express matching "lookup" as restaurantId
router.get('/lookup/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const phone = normalizePhone(req.query.phone);
    const customerId = req.query.customerId || null;
    if (!phone && !customerId) {
      return res.status(400).json({ success: false, error: 'phone or customerId required' });
    }
    const snap = await db.collection(COLLECTION)
      .where('restaurantId', '==', restaurantId)
      .get();
    const groups = [];
    snap.forEach(doc => {
      const d = doc.data();
      const inIds = customerId && Array.isArray(d.customerIds) && d.customerIds.includes(customerId);
      const inPhones = phone && Array.isArray(d.customerPhones) && d.customerPhones.includes(phone);
      if (inIds || inPhones) groups.push({ id: doc.id, name: d.name, color: d.color });
    });
    res.json({ success: true, groups });
  } catch (err) {
    console.error('[customerGroups] lookup error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LIST groups ──────────────────────────────────────────────────────
router.get('/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snap = await db.collection(COLLECTION)
      .where('restaurantId', '==', restaurantId)
      .get();
    const groups = [];
    snap.forEach(doc => groups.push({ id: doc.id, ...doc.data() }));
    groups.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json({ success: true, groups });
  } catch (err) {
    console.error('[customerGroups] list error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── GET single group ─────────────────────────────────────────────────
router.get('/:restaurantId/:groupId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, groupId } = req.params;
    const doc = await db.collection(COLLECTION).doc(groupId).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'Group not found' });
    const data = doc.data();
    if (data.restaurantId !== restaurantId) {
      return res.status(403).json({ success: false, error: 'Restaurant mismatch' });
    }
    res.json({ success: true, group: { id: doc.id, ...data } });
  } catch (err) {
    console.error('[customerGroups] get error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── CREATE group ─────────────────────────────────────────────────────
router.post('/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const own = await ensureRestaurantOwnership(req, restaurantId);
    if (!own.ok) return res.status(own.code).json({ success: false, error: own.error });

    const input = sanitizeGroupInput(req.body);
    if (!input.name) return res.status(400).json({ success: false, error: 'name is required' });

    const customerIds = Array.isArray(req.body.customerIds) ? [...new Set(req.body.customerIds.filter(Boolean))] : [];
    const customerPhones = Array.isArray(req.body.customerPhones)
      ? [...new Set(req.body.customerPhones.map(normalizePhone).filter(Boolean))]
      : [];

    const now = nowISO();
    const docRef = db.collection(COLLECTION).doc();
    const data = {
      restaurantId,
      ...input,
      customerIds,
      customerPhones,
      customerCount: customerIds.length + customerPhones.length,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.userId || req.user.id || null,
    };
    await docRef.set(data);
    res.json({ success: true, group: { id: docRef.id, ...data } });
  } catch (err) {
    console.error('[customerGroups] create error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── UPDATE group (metadata only) ─────────────────────────────────────
router.patch('/:restaurantId/:groupId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, groupId } = req.params;
    const ref = db.collection(COLLECTION).doc(groupId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Group not found' });
    if (snap.data().restaurantId !== restaurantId) {
      return res.status(403).json({ success: false, error: 'Restaurant mismatch' });
    }

    const input = sanitizeGroupInput({ ...snap.data(), ...req.body });
    const update = { ...input, updatedAt: nowISO() };
    await ref.update(update);
    const fresh = await ref.get();
    res.json({ success: true, group: { id: groupId, ...fresh.data() } });
  } catch (err) {
    console.error('[customerGroups] update error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── DELETE group ─────────────────────────────────────────────────────
router.delete('/:restaurantId/:groupId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, groupId } = req.params;
    const ref = db.collection(COLLECTION).doc(groupId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Group not found' });
    if (snap.data().restaurantId !== restaurantId) {
      return res.status(403).json({ success: false, error: 'Restaurant mismatch' });
    }
    await ref.delete();
    res.json({ success: true });
  } catch (err) {
    console.error('[customerGroups] delete error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ADD members (by customerIds and/or phones) ───────────────────────
router.post('/:restaurantId/:groupId/members', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, groupId } = req.params;
    const ref = db.collection(COLLECTION).doc(groupId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Group not found' });
    if (snap.data().restaurantId !== restaurantId) {
      return res.status(403).json({ success: false, error: 'Restaurant mismatch' });
    }

    const addIds = Array.isArray(req.body.customerIds) ? req.body.customerIds.filter(Boolean) : [];
    const addPhones = Array.isArray(req.body.customerPhones)
      ? req.body.customerPhones.map(normalizePhone).filter(Boolean)
      : [];

    if (!addIds.length && !addPhones.length) {
      return res.status(400).json({ success: false, error: 'No customerIds or customerPhones provided' });
    }

    const update = { updatedAt: nowISO() };
    if (addIds.length) update.customerIds = FieldValue.arrayUnion(...addIds);
    if (addPhones.length) update.customerPhones = FieldValue.arrayUnion(...addPhones);
    await ref.update(update);

    const fresh = await ref.get();
    const data = fresh.data();
    const newCount = (data.customerIds?.length || 0) + (data.customerPhones?.length || 0);
    if (newCount !== data.customerCount) {
      await ref.update({ customerCount: newCount });
      data.customerCount = newCount;
    }
    res.json({ success: true, group: { id: groupId, ...data } });
  } catch (err) {
    console.error('[customerGroups] add members error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── REMOVE members ───────────────────────────────────────────────────
router.delete('/:restaurantId/:groupId/members', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, groupId } = req.params;
    const ref = db.collection(COLLECTION).doc(groupId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ success: false, error: 'Group not found' });
    if (snap.data().restaurantId !== restaurantId) {
      return res.status(403).json({ success: false, error: 'Restaurant mismatch' });
    }

    const removeIds = Array.isArray(req.body.customerIds) ? req.body.customerIds.filter(Boolean) : [];
    const removePhones = Array.isArray(req.body.customerPhones)
      ? req.body.customerPhones.map(normalizePhone).filter(Boolean)
      : [];

    const update = { updatedAt: nowISO() };
    if (removeIds.length) update.customerIds = FieldValue.arrayRemove(...removeIds);
    if (removePhones.length) update.customerPhones = FieldValue.arrayRemove(...removePhones);
    await ref.update(update);

    const fresh = await ref.get();
    const data = fresh.data();
    const newCount = (data.customerIds?.length || 0) + (data.customerPhones?.length || 0);
    await ref.update({ customerCount: newCount });
    data.customerCount = newCount;
    res.json({ success: true, group: { id: groupId, ...data } });
  } catch (err) {
    console.error('[customerGroups] remove members error', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
