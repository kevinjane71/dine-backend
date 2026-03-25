const express = require('express');
const { FieldValue } = require('firebase-admin/firestore');

module.exports = (db, collections) => {
  const router = express.Router();

  async function getOrgId(userId) {
    const snapshot = await db.collection(collections.invOrganizations)
      .where('userId', '==', userId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].id;
  }

  // GET / — List items for org (with search, type filter)
  router.get('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      let query = db.collection(collections.invItems)
        .where('orgId', '==', orgId)
        .where('status', '==', 'active');

      if (req.query.type && ['goods', 'service'].includes(req.query.type)) {
        query = query.where('type', '==', req.query.type);
      }

      const snapshot = await query.orderBy('name').get();
      let items = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      const search = req.query.search;
      if (search) {
        const s = search.toLowerCase();
        items = items.filter(i =>
          (i.name || '').toLowerCase().includes(s) ||
          (i.sku || '').toLowerCase().includes(s) ||
          (i.description || '').toLowerCase().includes(s)
        );
      }

      return res.json({ success: true, data: items });
    } catch (error) {
      console.error('Error listing items:', error);
      return res.status(500).json({ success: false, error: 'Failed to list items' });
    }
  });

  // GET /:id — Get single item
  router.get('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invItems).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Item not found' });
      }

      return res.json({ success: true, data: { id: doc.id, ...doc.data() } });
    } catch (error) {
      console.error('Error getting item:', error);
      return res.status(500).json({ success: false, error: 'Failed to get item' });
    }
  });

  // POST / — Create item
  router.post('/', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const { name, type, unit, sellingPrice, costPrice, description, taxRate, taxType, hsnCode, sku, image } = req.body;

      if (!name) {
        return res.status(400).json({ success: false, error: 'Item name is required' });
      }

      const itemData = {
        orgId,
        name,
        type: type || 'goods',
        unit: unit || '',
        sellingPrice: parseFloat(sellingPrice) || 0,
        costPrice: parseFloat(costPrice) || 0,
        description: description || '',
        taxRate: parseFloat(taxRate) || 0,
        taxType: taxType || 'GST',
        hsnCode: hsnCode || '',
        sku: sku || '',
        image: image || '',
        status: 'active',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      const docRef = await db.collection(collections.invItems).add(itemData);

      return res.status(201).json({
        success: true,
        data: { id: docRef.id, ...itemData }
      });
    } catch (error) {
      console.error('Error creating item:', error);
      return res.status(500).json({ success: false, error: 'Failed to create item' });
    }
  });

  // PATCH /:id — Update item
  router.patch('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invItems).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Item not found' });
      }

      const allowedFields = ['name', 'type', 'unit', 'sellingPrice', 'costPrice', 'description', 'taxRate', 'taxType', 'hsnCode', 'sku', 'image'];
      const updateData = {};

      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          if (['sellingPrice', 'costPrice', 'taxRate'].includes(field)) {
            updateData[field] = parseFloat(req.body[field]) || 0;
          } else {
            updateData[field] = req.body[field];
          }
        }
      }

      updateData.updatedAt = FieldValue.serverTimestamp();

      await db.collection(collections.invItems).doc(req.params.id).update(updateData);

      const updated = await db.collection(collections.invItems).doc(req.params.id).get();

      return res.json({
        success: true,
        data: { id: updated.id, ...updated.data() }
      });
    } catch (error) {
      console.error('Error updating item:', error);
      return res.status(500).json({ success: false, error: 'Failed to update item' });
    }
  });

  // DELETE /:id — Soft delete
  router.delete('/:id', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const doc = await db.collection(collections.invItems).doc(req.params.id).get();
      if (!doc.exists || doc.data().orgId !== orgId) {
        return res.status(404).json({ success: false, error: 'Item not found' });
      }

      await db.collection(collections.invItems).doc(req.params.id).update({
        status: 'inactive',
        updatedAt: FieldValue.serverTimestamp()
      });

      return res.json({ success: true, data: { message: 'Item deleted successfully' } });
    } catch (error) {
      console.error('Error deleting item:', error);
      return res.status(500).json({ success: false, error: 'Failed to delete item' });
    }
  });

  return router;
};
