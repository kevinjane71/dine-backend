const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = (db, collections) => {
  const router = express.Router();

  // GET / — Get user's organization (create default if none exists)
  router.get('/', async (req, res) => {
    try {
      const userId = req.user.userId;

      const snapshot = await db.collection(collections.invOrganizations)
        .where('userId', '==', userId)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        return res.json({
          success: true,
          data: { id: doc.id, ...doc.data() }
        });
      }

      // Create default organization
      const defaultOrg = {
        userId,
        name: '',
        email: '',
        phone: '',
        address: {
          street: '',
          city: '',
          state: '',
          zip: '',
          country: 'India'
        },
        logo: '',
        gstin: '',
        pan: '',
        currency: 'INR',
        dateFormat: 'DD/MM/YYYY',
        fiscalYearStart: 4,
        theme: {
          primaryColor: '#3b82f6'
        },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invOrganizations).add(defaultOrg);

      return res.json({
        success: true,
        data: { id: docRef.id, ...defaultOrg }
      });
    } catch (error) {
      console.error('Error getting organization:', error);
      return res.status(500).json({ success: false, error: 'Failed to get organization' });
    }
  });

  // POST / — Create organization
  router.post('/', async (req, res) => {
    try {
      const userId = req.user.userId;
      const { name, email, phone, address, logo, gstin, pan, currency, dateFormat, fiscalYearStart, theme } = req.body;

      if (!name) {
        return res.status(400).json({ success: false, error: 'Organization name is required' });
      }

      // Check if user already has an organization
      const existing = await db.collection(collections.invOrganizations)
        .where('userId', '==', userId)
        .limit(1)
        .get();

      if (!existing.empty) {
        return res.status(400).json({ success: false, error: 'Organization already exists. Use PATCH to update.' });
      }

      const orgData = {
        userId,
        name,
        email: email || '',
        phone: phone || '',
        address: address || { street: '', city: '', state: '', zip: '', country: 'India' },
        logo: logo || '',
        gstin: gstin || '',
        pan: pan || '',
        currency: currency || 'INR',
        dateFormat: dateFormat || 'DD/MM/YYYY',
        fiscalYearStart: fiscalYearStart || 4,
        theme: theme || { primaryColor: '#3b82f6' },
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invOrganizations).add(orgData);

      return res.status(201).json({
        success: true,
        data: { id: docRef.id, ...orgData }
      });
    } catch (error) {
      console.error('Error creating organization:', error);
      return res.status(500).json({ success: false, error: 'Failed to create organization' });
    }
  });

  // PATCH / — Update organization
  router.patch('/', async (req, res) => {
    try {
      const userId = req.user.userId;

      const snapshot = await db.collection(collections.invOrganizations)
        .where('userId', '==', userId)
        .limit(1)
        .get();

      if (snapshot.empty) {
        return res.status(404).json({ success: false, error: 'Organization not found' });
      }

      const doc = snapshot.docs[0];
      const allowedFields = ['name', 'email', 'phone', 'address', 'logo', 'gstin', 'pan', 'currency', 'dateFormat', 'fiscalYearStart', 'theme'];
      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invOrganizations).doc(doc.id).update(updateData);

      const updated = await db.collection(collections.invOrganizations).doc(doc.id).get();

      return res.json({
        success: true,
        data: { id: doc.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating organization:', error);
      return res.status(500).json({ success: false, error: 'Failed to update organization' });
    }
  });

  return router;
};
