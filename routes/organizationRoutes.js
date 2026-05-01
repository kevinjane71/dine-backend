const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const { requireOrgAccess, getOwnerId, getOrgOutlets } = require('../middleware/orgAccess');

// ============================================
// ORGANIZATION / CHAIN MANAGEMENT APIs
// All endpoints require owner (or admin co-owner) role
// ============================================

/**
 * POST /api/organizations
 * Create a new organization and optionally assign restaurants
 */
router.post('/', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = getOwnerId(req);
    const { name, type, settings, restaurantIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Organization name is required' });
    }

    const validTypes = ['chain', 'franchise', 'group'];
    const orgType = validTypes.includes(type) ? type : 'chain';

    // Verify all provided restaurants belong to this owner
    if (restaurantIds && restaurantIds.length > 0) {
      for (const rid of restaurantIds) {
        const rDoc = await db.collection(collections.restaurants).doc(rid).get();
        if (!rDoc.exists) {
          return res.status(400).json({ error: `Restaurant ${rid} not found` });
        }
        if (rDoc.data().ownerId !== userId) {
          return res.status(403).json({ error: `Restaurant ${rid} does not belong to you` });
        }
        if (rDoc.data().organizationId) {
          return res.status(400).json({ error: `Restaurant "${rDoc.data().name}" is already part of another organization` });
        }
      }
    }

    const orgData = {
      name: name.trim(),
      type: orgType,
      ownerId: userId,
      settings: {
        centralizedMenu: settings?.centralizedMenu === true,
        centralKitchen: settings?.centralKitchen === true,
        centralWarehouse: settings?.centralWarehouse === true,
        menuLocking: settings?.menuLocking === true,
        autoSyncMenu: settings?.autoSyncMenu === true,
      },
      outlets: restaurantIds || [],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const orgRef = await db.collection(collections.organizations).add(orgData);
    const orgId = orgRef.id;

    // Assign organizationId to selected restaurants
    if (restaurantIds && restaurantIds.length > 0) {
      const batch = db.batch();
      for (const rid of restaurantIds) {
        const rRef = db.collection(collections.restaurants).doc(rid);
        batch.update(rRef, {
          organizationId: orgId,
          outletType: 'outlet',
          updatedAt: new Date()
        });
      }
      await batch.commit();
    }

    // Log audit
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'ORG_CREATED',
      performedBy: userId,
      details: { name: orgData.name, outlets: restaurantIds || [] },
      createdAt: new Date()
    });

    res.status(201).json({
      success: true,
      message: 'Organization created successfully',
      organization: { id: orgId, ...orgData }
    });
  } catch (error) {
    console.error('Create organization error:', error);
    res.status(500).json({ error: 'Failed to create organization' });
  }
});

/**
 * GET /api/organizations
 * List all organizations for the current owner
 */
router.get('/', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const userId = getOwnerId(req);

    const snapshot = await db.collection(collections.organizations)
      .where('ownerId', '==', userId)
      .where('status', '==', 'active')
      .get();

    const organizations = [];
    snapshot.forEach(doc => {
      organizations.push({ id: doc.id, ...doc.data() });
    });

    res.json({ success: true, organizations });
  } catch (error) {
    console.error('List organizations error:', error);
    res.status(500).json({ error: 'Failed to list organizations' });
  }
});

/**
 * GET /api/organizations/:orgId
 * Get organization detail with outlet information
 */
router.get('/:orgId', authenticateToken, requireOwnerRole, requireOrgAccess, async (req, res) => {
  try {
    const outlets = await getOrgOutlets(req.org.id);

    // Group outlets by type
    const grouped = {
      outlets: outlets.filter(o => o.outletType === 'outlet'),
      warehouses: outlets.filter(o => o.outletType === 'warehouse'),
      centralKitchens: outlets.filter(o => o.outletType === 'central_kitchen')
    };

    res.json({
      success: true,
      organization: req.org,
      outlets: grouped,
      totalOutlets: outlets.length
    });
  } catch (error) {
    console.error('Get organization error:', error);
    res.status(500).json({ error: 'Failed to get organization' });
  }
});

/**
 * PATCH /api/organizations/:orgId
 * Update organization settings
 */
router.patch('/:orgId', authenticateToken, requireOwnerRole, requireOrgAccess, async (req, res) => {
  try {
    const { name, type, settings } = req.body;
    const updateData = { updatedAt: new Date() };

    if (name && name.trim()) {
      updateData.name = name.trim();
    }

    const validTypes = ['chain', 'franchise', 'group'];
    if (type && validTypes.includes(type)) {
      updateData.type = type;
    }

    if (settings && typeof settings === 'object') {
      // Merge settings — only update provided keys
      const currentSettings = req.org.settings || {};
      updateData.settings = {
        centralizedMenu: settings.centralizedMenu !== undefined ? settings.centralizedMenu === true : (currentSettings.centralizedMenu || false),
        centralKitchen: settings.centralKitchen !== undefined ? settings.centralKitchen === true : (currentSettings.centralKitchen || false),
        centralWarehouse: settings.centralWarehouse !== undefined ? settings.centralWarehouse === true : (currentSettings.centralWarehouse || false),
        menuLocking: settings.menuLocking !== undefined ? settings.menuLocking === true : (currentSettings.menuLocking || false),
        autoSyncMenu: settings.autoSyncMenu !== undefined ? settings.autoSyncMenu === true : (currentSettings.autoSyncMenu || false),
      };
    }

    await db.collection(collections.organizations).doc(req.org.id).update(updateData);

    res.json({
      success: true,
      message: 'Organization updated successfully'
    });
  } catch (error) {
    console.error('Update organization error:', error);
    res.status(500).json({ error: 'Failed to update organization' });
  }
});

/**
 * POST /api/organizations/:orgId/outlets
 * Add a restaurant to the organization
 */
router.post('/:orgId/outlets', authenticateToken, requireOwnerRole, requireOrgAccess, async (req, res) => {
  try {
    const userId = getOwnerId(req);
    const { restaurantId, outletType, outletCode } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    if (restaurant.ownerId !== userId) {
      return res.status(403).json({ error: 'Restaurant does not belong to you' });
    }

    if (restaurant.organizationId && restaurant.organizationId !== req.org.id) {
      return res.status(400).json({ error: 'Restaurant is already part of another organization' });
    }

    const validTypes = ['outlet', 'central_kitchen', 'warehouse'];
    const type = validTypes.includes(outletType) ? outletType : 'outlet';

    // Update restaurant with org link
    await db.collection(collections.restaurants).doc(restaurantId).update({
      organizationId: req.org.id,
      outletType: type,
      outletCode: outletCode?.trim() || null,
      updatedAt: new Date()
    });

    // Update org outlets array
    const currentOutlets = req.org.outlets || [];
    if (!currentOutlets.includes(restaurantId)) {
      await db.collection(collections.organizations).doc(req.org.id).update({
        outlets: [...currentOutlets, restaurantId],
        updatedAt: new Date()
      });
    }

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: req.org.id,
      action: 'OUTLET_ADDED',
      performedBy: userId,
      details: { restaurantId, outletType: type, restaurantName: restaurant.name },
      createdAt: new Date()
    });

    res.json({
      success: true,
      message: `${restaurant.name} added as ${type}`
    });
  } catch (error) {
    console.error('Add outlet error:', error);
    res.status(500).json({ error: 'Failed to add outlet' });
  }
});

/**
 * DELETE /api/organizations/:orgId/outlets/:restaurantId
 * Remove a restaurant from the organization
 */
router.delete('/:orgId/outlets/:restaurantId', authenticateToken, requireOwnerRole, requireOrgAccess, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = getOwnerId(req);

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    if (restaurant.organizationId !== req.org.id) {
      return res.status(400).json({ error: 'Restaurant is not part of this organization' });
    }

    // Clear org fields from restaurant
    await db.collection(collections.restaurants).doc(restaurantId).update({
      organizationId: null,
      outletType: null,
      outletCode: null,
      updatedAt: new Date()
    });

    // Remove from org outlets array
    const updatedOutlets = (req.org.outlets || []).filter(id => id !== restaurantId);
    await db.collection(collections.organizations).doc(req.org.id).update({
      outlets: updatedOutlets,
      updatedAt: new Date()
    });

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: req.org.id,
      action: 'OUTLET_REMOVED',
      performedBy: userId,
      details: { restaurantId, restaurantName: restaurant.name },
      createdAt: new Date()
    });

    res.json({
      success: true,
      message: `${restaurant.name} removed from organization`
    });
  } catch (error) {
    console.error('Remove outlet error:', error);
    res.status(500).json({ error: 'Failed to remove outlet' });
  }
});

/**
 * PATCH /api/organizations/:orgId/outlets/:restaurantId/type
 * Change outlet type (outlet, central_kitchen, warehouse)
 */
router.patch('/:orgId/outlets/:restaurantId/type', authenticateToken, requireOwnerRole, requireOrgAccess, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { outletType, outletCode } = req.body;

    const validTypes = ['outlet', 'central_kitchen', 'warehouse'];
    if (!outletType || !validTypes.includes(outletType)) {
      return res.status(400).json({ error: `Invalid outlet type. Must be one of: ${validTypes.join(', ')}` });
    }

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    if (restaurantDoc.data().organizationId !== req.org.id) {
      return res.status(400).json({ error: 'Restaurant is not part of this organization' });
    }

    const updateData = {
      outletType,
      updatedAt: new Date()
    };
    if (outletCode !== undefined) {
      updateData.outletCode = outletCode?.trim() || null;
    }

    await db.collection(collections.restaurants).doc(restaurantId).update(updateData);

    res.json({
      success: true,
      message: `Outlet type changed to ${outletType}`
    });
  } catch (error) {
    console.error('Change outlet type error:', error);
    res.status(500).json({ error: 'Failed to change outlet type' });
  }
});

/**
 * GET /api/organizations/:orgId/outlets
 * List all outlets grouped by type
 */
router.get('/:orgId/outlets', authenticateToken, requireOwnerRole, requireOrgAccess, async (req, res) => {
  try {
    const outlets = await getOrgOutlets(req.org.id);

    const grouped = {
      outlet: outlets.filter(o => o.outletType === 'outlet'),
      central_kitchen: outlets.filter(o => o.outletType === 'central_kitchen'),
      warehouse: outlets.filter(o => o.outletType === 'warehouse')
    };

    res.json({
      success: true,
      outlets,
      grouped,
      counts: {
        total: outlets.length,
        outlets: grouped.outlet.length,
        centralKitchens: grouped.central_kitchen.length,
        warehouses: grouped.warehouse.length
      }
    });
  } catch (error) {
    console.error('List outlets error:', error);
    res.status(500).json({ error: 'Failed to list outlets' });
  }
});

module.exports = router;
