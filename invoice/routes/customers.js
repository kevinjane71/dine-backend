const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = (db, collections) => {
  const router = express.Router();

  // Helper: get orgId for the current user
  async function getOrgId(userId) {
    const snapshot = await db.collection(collections.invOrganizations)
      .where('userId', '==', userId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].id;
  }

  // GET / — List customers for org (with search query param)
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found. Create one first.' });

      let query = db.collection(collections.invCustomers)
        .where('orgId', '==', orgId)
        .where('status', '==', 'active')
        .orderBy('displayName');

      const snapshot = await query.get();
      let customers = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      // Client-side search filtering (Firestore lacks full-text search)
      const search = req.query.search;
      if (search) {
        const s = search.toLowerCase();
        customers = customers.filter(c =>
          (c.displayName || '').toLowerCase().includes(s) ||
          (c.companyName || '').toLowerCase().includes(s) ||
          (c.email || '').toLowerCase().includes(s) ||
          (c.mobile || '').includes(s)
        );
      }

      return res.json({ success: true, data: customers });
    } catch (error) {
      console.error('Error listing customers:', error);
      return res.status(500).json({ success: false, error: 'Failed to list customers' });
    }
  });

  // GET /dineopen — Search DineOpen restaurant customers (for cross-app integration)
  router.get('/dineopen', async (req, res) => {
    try {
      const { restaurantId, search } = req.query;
      if (!restaurantId) {
        return res.status(400).json({ success: false, error: 'restaurantId is required' });
      }

      const snapshot = await db.collection('customers')
        .where('restaurantId', '==', restaurantId)
        .get();

      let customers = snapshot.docs.map(doc => {
        const d = doc.data();
        return {
          id: doc.id,
          displayName: d.name || 'Unnamed Customer',
          email: d.email || '',
          phone: d.phone || '',
          mobile: d.phone || '',
          totalOrders: d.totalOrders || 0,
          totalSpent: d.totalSpent || 0,
          source: 'dineopen',
        };
      });

      if (search) {
        const s = search.toLowerCase();
        customers = customers.filter(c =>
          (c.displayName || '').toLowerCase().includes(s) ||
          (c.email || '').toLowerCase().includes(s) ||
          (c.phone || '').includes(s)
        );
      }

      // Sort by name and limit results
      customers.sort((a, b) => a.displayName.localeCompare(b.displayName));
      customers = customers.slice(0, 50);

      return res.json({ success: true, data: customers });
    } catch (error) {
      console.error('Error fetching DineOpen customers:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch customers' });
    }
  });

  // GET /:id — Get single customer
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invCustomers).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      return res.json({ success: true, data: { id: doc.id, ...doc.data() } });
    } catch (error) {
      console.error('Error getting customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to get customer' });
    }
  });

  // POST / — Create customer
  router.post('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const { type, salutation, firstName, lastName, companyName, displayName, email, workPhone, mobile, pan, gstin, currency, paymentTerms, language, billingAddress, shippingAddress, contactPersons, notes, customFields, sourceApp, sourceRef } = req.body;

      if (!displayName) {
        return res.status(400).json({ success: false, error: 'Display name is required' });
      }

      const customerData = {
        orgId,
        type: type || 'business',
        salutation: salutation || '',
        firstName: firstName || '',
        lastName: lastName || '',
        companyName: companyName || '',
        displayName,
        email: email || '',
        workPhone: workPhone || '',
        mobile: mobile || '',
        pan: pan || '',
        gstin: gstin || '',
        currency: currency || 'INR',
        paymentTerms: paymentTerms || 'due_on_receipt',
        language: language || 'English',
        billingAddress: billingAddress || { street: '', city: '', state: '', zip: '', country: '' },
        shippingAddress: shippingAddress || { street: '', city: '', state: '', zip: '', country: '' },
        contactPersons: contactPersons || [],
        notes: notes || '',
        customFields: customFields || {},
        status: 'active',
        sourceApp: sourceApp || 'standalone',
        sourceRef: sourceRef || '',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invCustomers).add(customerData);

      return res.status(201).json({
        success: true,
        data: { id: docRef.id, ...customerData }
      });
    } catch (error) {
      console.error('Error creating customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to create customer' });
    }
  });

  // PATCH /:id — Update customer
  router.patch('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invCustomers).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      const allowedFields = ['type', 'salutation', 'firstName', 'lastName', 'companyName', 'displayName', 'email', 'workPhone', 'mobile', 'pan', 'gstin', 'currency', 'paymentTerms', 'language', 'billingAddress', 'shippingAddress', 'contactPersons', 'notes', 'customFields', 'sourceApp', 'sourceRef'];
      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updateData[field] = req.body[field];
        }
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invCustomers).doc(req.params.id).update(updateData);

      const updated = await db.collection(collections.invCustomers).doc(req.params.id).get();

      return res.json({
        success: true,
        data: { id: updated.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to update customer' });
    }
  });

  // DELETE /:id — Soft delete (set status to inactive)
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invCustomers).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Customer not found' });
      }

      await db.collection(collections.invCustomers).doc(req.params.id).update({
        status: 'inactive',
        updatedAt: FieldValue.serverTimestamp()
      });

      return res.json({ success: true, data: { message: 'Customer deleted successfully' } });
    } catch (error) {
      console.error('Error deleting customer:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete customer' });
    }
  });

  return router;
};
