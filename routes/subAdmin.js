const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('../firebase');
const { authenticateSuperAdmin, requireSuperAdmin } = require('../middleware/superAdminAuth');

const SUB_ADMINS_COLLECTION = 'sub_admins';

const VALID_PERMISSIONS = [
  'dine:create-user',
  'retail:create-user',
  'dine:reset-mpin',
  'retail:reset-mpin',
  'dine:view-users',
  'retail:view-users',
];

// ─── Sub-Admin Login (no auth required) ─────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const snap = await db.collection(SUB_ADMINS_COLLECTION)
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const doc = snap.docs[0];
    const subAdmin = doc.data();

    if (!subAdmin.enabled) {
      return res.status(403).json({ success: false, error: 'Account has been disabled' });
    }

    const valid = await bcrypt.compare(password, subAdmin.password);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        role: 'sub_admin',
        subAdminId: doc.id,
        email: subAdmin.email,
        name: subAdmin.name,
        permissions: subAdmin.permissions || [],
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Update last login
    await doc.ref.update({ lastLogin: new Date() });

    res.json({
      success: true,
      token,
      user: {
        id: doc.id,
        name: subAdmin.name,
        email: subAdmin.email,
        role: 'sub_admin',
        permissions: subAdmin.permissions || [],
      },
    });
  } catch (error) {
    console.error('Sub-admin login error:', error);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// ─── All routes below require super_admin ────────────────────────────
router.use(authenticateSuperAdmin, requireSuperAdmin);

// ─── List all sub-admins ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const snap = await db.collection(SUB_ADMINS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .get();

    const subAdmins = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        name: d.name || '',
        email: d.email || '',
        phone: d.phone || '',
        permissions: d.permissions || [],
        enabled: d.enabled ?? true,
        createdAt: d.createdAt?.toDate ? d.createdAt.toDate().toISOString() : d.createdAt,
        lastLogin: d.lastLogin?.toDate ? d.lastLogin.toDate().toISOString() : d.lastLogin || null,
        createdBy: d.createdBy || '',
      };
    });

    res.json({ success: true, subAdmins });
  } catch (error) {
    console.error('List sub-admins error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch sub-admins' });
  }
});

// ─── Create sub-admin ────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { email, password, name, phone, permissions } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ success: false, error: 'Email, password, and name are required' });
    }
    if (!permissions || !Array.isArray(permissions) || permissions.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one permission is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check for duplicate email
    const existing = await db.collection(SUB_ADMINS_COLLECTION)
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();
    if (!existing.empty) {
      return res.status(409).json({ success: false, error: 'A sub-admin with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const filteredPerms = permissions.filter(p => VALID_PERMISSIONS.includes(p));

    if (filteredPerms.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid permissions provided' });
    }

    const docRef = await db.collection(SUB_ADMINS_COLLECTION).add({
      email: normalizedEmail,
      password: hashedPassword,
      name: name.trim(),
      phone: (phone || '').trim(),
      permissions: filteredPerms,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: req.admin.username || 'super_admin',
    });

    res.status(201).json({
      success: true,
      subAdmin: {
        id: docRef.id,
        email: normalizedEmail,
        name: name.trim(),
        phone: (phone || '').trim(),
        permissions: filteredPerms,
        enabled: true,
      },
    });
  } catch (error) {
    console.error('Create sub-admin error:', error);
    res.status(500).json({ success: false, error: 'Failed to create sub-admin' });
  }
});

// ─── Update sub-admin ────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection(SUB_ADMINS_COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Sub-admin not found' });
    }

    const updateData = { updatedAt: new Date() };
    const { name, phone, permissions, enabled, password } = req.body;

    if (name !== undefined) updateData.name = name.trim();
    if (phone !== undefined) updateData.phone = phone.trim();
    if (permissions !== undefined) {
      updateData.permissions = permissions.filter(p => VALID_PERMISSIONS.includes(p));
    }
    if (enabled !== undefined) updateData.enabled = !!enabled;
    if (password) updateData.password = await bcrypt.hash(password, 10);

    await docRef.update(updateData);
    res.json({ success: true });
  } catch (error) {
    console.error('Update sub-admin error:', error);
    res.status(500).json({ success: false, error: 'Failed to update sub-admin' });
  }
});

// ─── Delete sub-admin ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection(SUB_ADMINS_COLLECTION).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Sub-admin not found' });
    }
    await docRef.delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete sub-admin error:', error);
    res.status(500).json({ success: false, error: 'Failed to delete sub-admin' });
  }
});

module.exports = router;
