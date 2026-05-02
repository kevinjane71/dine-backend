const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const { requireOrgAccess, requireOrgFeature, isRestaurantInOrg, getOrgOutlets, getOwnerId } = require('../middleware/orgAccess');

// All routes require authentication, owner role, org access, and centralizedMenu feature
router.use('/:orgId', authenticateToken, requireOwnerRole, requireOrgAccess, requireOrgFeature('centralizedMenu'));

// ============================================================
// 1. POST /:orgId/templates — Create a menu template
// ============================================================
router.post('/:orgId/templates', async (req, res) => {
  try {
    const { orgId } = req.params;
    const { name, description, categories } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Template name is required' });
    }

    if (categories && !Array.isArray(categories)) {
      return res.status(400).json({ success: false, error: 'Categories must be an array' });
    }

    const templateRef = db.collection(collections.orgMenuTemplates).doc();
    const now = new Date().toISOString();

    const template = {
      id: templateRef.id,
      organizationId: orgId,
      name: name.trim(),
      description: description || '',
      categories: (categories || []).map((cat, idx) => ({
        name: cat.name,
        sortOrder: cat.sortOrder !== undefined ? cat.sortOrder : idx,
      })),
      status: 'active',
      assignedOutlets: [],
      lastPushedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.uid,
    };

    await templateRef.set(template);

    return res.status(201).json({ success: true, template });
  } catch (error) {
    console.error('Error creating template:', error);
    return res.status(500).json({ success: false, error: 'Failed to create template' });
  }
});

// ============================================================
// 2. GET /:orgId/templates — List all templates for the org
// ============================================================
router.get('/:orgId/templates', async (req, res) => {
  try {
    const { orgId } = req.params;

    const templatesSnap = await db.collection(collections.orgMenuTemplates)
      .where('organizationId', '==', orgId)
      .get();

    const templates = [];

    for (const doc of templatesSnap.docs) {
      const template = doc.data();

      // Get item count for this template
      const itemsSnap = await db.collection(collections.orgMenuItems)
        .where('templateId', '==', template.id)
        .where('status', '==', 'active')
        .get();

      templates.push({
        ...template,
        itemCount: itemsSnap.size,
      });
    }

    return res.json({ success: true, templates });
  } catch (error) {
    console.error('Error listing templates:', error);
    return res.status(500).json({ success: false, error: 'Failed to list templates' });
  }
});

// ============================================================
// 3. GET /:orgId/templates/:templateId — Get template detail with items
// ============================================================
router.get('/:orgId/templates/:templateId', async (req, res) => {
  try {
    const { orgId, templateId } = req.params;

    const templateDoc = await db.collection(collections.orgMenuTemplates).doc(templateId).get();

    if (!templateDoc.exists) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const template = templateDoc.data();

    if (template.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Template does not belong to this organization' });
    }

    // Get all items for this template
    const itemsSnap = await db.collection(collections.orgMenuItems)
      .where('templateId', '==', templateId)
      .where('status', '==', 'active')
      .get();

    const items = itemsSnap.docs.map(doc => doc.data());

    return res.json({ success: true, template, items });
  } catch (error) {
    console.error('Error getting template:', error);
    return res.status(500).json({ success: false, error: 'Failed to get template' });
  }
});

// ============================================================
// 4. PATCH /:orgId/templates/:templateId — Update template metadata
// ============================================================
router.patch('/:orgId/templates/:templateId', async (req, res) => {
  try {
    const { orgId, templateId } = req.params;
    const { name, description, categories, status } = req.body;

    const templateRef = db.collection(collections.orgMenuTemplates).doc(templateId);
    const templateDoc = await templateRef.get();

    if (!templateDoc.exists) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const template = templateDoc.data();

    if (template.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Template does not belong to this organization' });
    }

    const updates = { updatedAt: new Date().toISOString() };

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ success: false, error: 'Template name cannot be empty' });
      }
      updates.name = name.trim();
    }
    if (description !== undefined) updates.description = description;
    if (categories !== undefined) {
      if (!Array.isArray(categories)) {
        return res.status(400).json({ success: false, error: 'Categories must be an array' });
      }
      updates.categories = categories.map((cat, idx) => ({
        name: cat.name,
        sortOrder: cat.sortOrder !== undefined ? cat.sortOrder : idx,
      }));
    }
    if (status !== undefined) {
      if (!['active', 'archived'].includes(status)) {
        return res.status(400).json({ success: false, error: 'Invalid status. Must be active or archived' });
      }
      updates.status = status;
    }

    await templateRef.update(updates);

    const updatedTemplate = { ...template, ...updates };

    return res.json({ success: true, template: updatedTemplate });
  } catch (error) {
    console.error('Error updating template:', error);
    return res.status(500).json({ success: false, error: 'Failed to update template' });
  }
});

// ============================================================
// 5. DELETE /:orgId/templates/:templateId — Archive template
// ============================================================
router.delete('/:orgId/templates/:templateId', async (req, res) => {
  try {
    const { orgId, templateId } = req.params;

    const templateRef = db.collection(collections.orgMenuTemplates).doc(templateId);
    const templateDoc = await templateRef.get();

    if (!templateDoc.exists) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const template = templateDoc.data();

    if (template.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Template does not belong to this organization' });
    }

    await templateRef.update({
      status: 'archived',
      updatedAt: new Date().toISOString(),
    });

    return res.json({ success: true, message: 'Template archived successfully' });
  } catch (error) {
    console.error('Error archiving template:', error);
    return res.status(500).json({ success: false, error: 'Failed to archive template' });
  }
});

// ============================================================
// 6. POST /:orgId/templates/:templateId/items — Add item to template
// ============================================================
router.post('/:orgId/templates/:templateId/items', async (req, res) => {
  try {
    const { orgId, templateId } = req.params;
    const {
      name, description, category, basePrice, variants, image, images, isVeg, tags,
      isLocked, lockFields, sortOrder, shortCode, customizations,
      dineInPrice, takeawayPrice, deliveryPrice, allergens,
      spiritCategory, ingredients, abv, servingUnit, bottleSize,
      unit, weight, shelfLife, mfgDate, expiryDate, servingSize, scoopOptions,
      isStockManaged, stockQuantity, lowStockThreshold,
    } = req.body;

    // Validate template exists and belongs to org
    const templateDoc = await db.collection(collections.orgMenuTemplates).doc(templateId).get();

    if (!templateDoc.exists) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const template = templateDoc.data();

    if (template.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Template does not belong to this organization' });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Item name is required' });
    }

    if (basePrice === undefined || basePrice === null || isNaN(Number(basePrice))) {
      return res.status(400).json({ success: false, error: 'Valid base price is required' });
    }

    if (!category || !category.trim()) {
      return res.status(400).json({ success: false, error: 'Category is required' });
    }

    const itemRef = db.collection(collections.orgMenuItems).doc();
    const now = new Date().toISOString();

    const item = {
      id: itemRef.id,
      organizationId: orgId,
      templateId,
      name: name.trim(),
      description: description || '',
      category: category.trim(),
      basePrice: Number(basePrice),
      variants: variants || [],
      image: image || '',
      images: images || [],
      isVeg: isVeg !== undefined ? isVeg : true,
      tags: tags || [],
      isLocked: isLocked || false,
      lockFields: lockFields || [],
      sortOrder: sortOrder !== undefined ? sortOrder : 0,
      shortCode: shortCode || '',
      customizations: customizations || [],
      dineInPrice: dineInPrice != null ? Number(dineInPrice) : null,
      takeawayPrice: takeawayPrice != null ? Number(takeawayPrice) : null,
      deliveryPrice: deliveryPrice != null ? Number(deliveryPrice) : null,
      allergens: allergens || [],
      spiritCategory: spiritCategory || '',
      ingredients: ingredients || '',
      abv: abv || '',
      servingUnit: servingUnit || '',
      bottleSize: bottleSize || '',
      unit: unit || '',
      weight: weight || '',
      shelfLife: shelfLife || '',
      mfgDate: mfgDate || null,
      expiryDate: expiryDate || null,
      servingSize: servingSize || '',
      scoopOptions: scoopOptions || '',
      isStockManaged: isStockManaged || false,
      stockQuantity: stockQuantity != null ? Number(stockQuantity) : null,
      lowStockThreshold: lowStockThreshold != null ? Number(lowStockThreshold) : 5,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await itemRef.set(item);

    return res.status(201).json({ success: true, item });
  } catch (error) {
    console.error('Error adding item to template:', error);
    return res.status(500).json({ success: false, error: 'Failed to add item' });
  }
});

// ============================================================
// 7. PATCH /:orgId/templates/:templateId/items/:itemId — Update a master menu item
// ============================================================
router.patch('/:orgId/templates/:templateId/items/:itemId', async (req, res) => {
  try {
    const { orgId, templateId, itemId } = req.params;

    const itemRef = db.collection(collections.orgMenuItems).doc(itemId);
    const itemDoc = await itemRef.get();

    if (!itemDoc.exists) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    const item = itemDoc.data();

    if (item.organizationId !== orgId || item.templateId !== templateId) {
      return res.status(403).json({ success: false, error: 'Item does not belong to this template or organization' });
    }

    const allowedFields = [
      'name', 'description', 'category', 'basePrice', 'variants', 'image', 'images',
      'isVeg', 'tags', 'isLocked', 'lockFields', 'sortOrder',
      'shortCode', 'customizations', 'dineInPrice', 'takeawayPrice', 'deliveryPrice',
      'allergens', 'spiritCategory', 'ingredients', 'abv', 'servingUnit', 'bottleSize',
      'unit', 'weight', 'shelfLife', 'mfgDate', 'expiryDate', 'servingSize', 'scoopOptions',
      'isStockManaged', 'stockQuantity', 'lowStockThreshold',
    ];
    const updates = { updatedAt: new Date().toISOString() };

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'name' && !req.body[field].trim()) {
          return res.status(400).json({ success: false, error: 'Item name cannot be empty' });
        }
        if (field === 'basePrice') {
          if (isNaN(Number(req.body[field]))) {
            return res.status(400).json({ success: false, error: 'Valid base price is required' });
          }
          updates[field] = Number(req.body[field]);
        } else if (field === 'name' || field === 'category') {
          updates[field] = req.body[field].trim();
        } else {
          updates[field] = req.body[field];
        }
      }
    }

    await itemRef.update(updates);

    const updatedItem = { ...item, ...updates };

    return res.json({ success: true, item: updatedItem });
  } catch (error) {
    console.error('Error updating item:', error);
    return res.status(500).json({ success: false, error: 'Failed to update item' });
  }
});

// ============================================================
// 8. DELETE /:orgId/templates/:templateId/items/:itemId — Set item status to inactive
// ============================================================
router.delete('/:orgId/templates/:templateId/items/:itemId', async (req, res) => {
  try {
    const { orgId, templateId, itemId } = req.params;

    const itemRef = db.collection(collections.orgMenuItems).doc(itemId);
    const itemDoc = await itemRef.get();

    if (!itemDoc.exists) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    const item = itemDoc.data();

    if (item.organizationId !== orgId || item.templateId !== templateId) {
      return res.status(403).json({ success: false, error: 'Item does not belong to this template or organization' });
    }

    await itemRef.update({
      status: 'inactive',
      updatedAt: new Date().toISOString(),
    });

    return res.json({ success: true, message: 'Item deactivated successfully' });
  } catch (error) {
    console.error('Error deactivating item:', error);
    return res.status(500).json({ success: false, error: 'Failed to deactivate item' });
  }
});

// ============================================================
// Reusable helper: push template items to outlets
// ============================================================
async function pushTemplateToOutlets(templateId, outletIds, overwriteExisting = false) {
  const templateRef = db.collection(collections.orgMenuTemplates).doc(templateId);
  const templateDoc = await templateRef.get();

  if (!templateDoc.exists) {
    throw new Error('Template not found');
  }

  const template = templateDoc.data();

  // Get all active items for this template
  const itemsSnap = await db.collection(collections.orgMenuItems)
    .where('templateId', '==', templateId)
    .where('status', '==', 'active')
    .get();

  const masterItems = itemsSnap.docs.map(doc => doc.data());

  const results = [];
  const now = new Date().toISOString();

  for (const outletId of outletIds) {
    const restaurantRef = db.collection(collections.restaurants).doc(outletId);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      results.push({ outletId, status: 'error', error: 'Restaurant not found' });
      continue;
    }

    const restaurant = restaurantDoc.data();
    const menuItems = (restaurant.menu && restaurant.menu.items) ? [...restaurant.menu.items] : [];

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (const masterItem of masterItems) {
      const existingIndex = menuItems.findIndex(mi => mi.orgMenuItemId === masterItem.id);

      if (existingIndex !== -1) {
        // Item already exists in outlet
        if (!overwriteExisting) {
          skipped++;
          continue;
        }

        // Overwrite, but keep local price if isLocalOverride is true
        const existingItem = menuItems[existingIndex];
        const updatedItem = {
          ...existingItem,
          name: masterItem.name,
          description: masterItem.description,
          category: masterItem.category,
          price: existingItem.isLocalOverride ? existingItem.price : masterItem.basePrice,
          variants: masterItem.variants,
          image: masterItem.image,
          images: masterItem.images || [],
          isVeg: masterItem.isVeg,
          tags: masterItem.tags,
          shortCode: masterItem.shortCode || existingItem.shortCode || '',
          customizations: masterItem.customizations || [],
          dineInPrice: masterItem.dineInPrice ?? existingItem.dineInPrice ?? null,
          takeawayPrice: masterItem.takeawayPrice ?? existingItem.takeawayPrice ?? null,
          deliveryPrice: masterItem.deliveryPrice ?? existingItem.deliveryPrice ?? null,
          allergens: masterItem.allergens || [],
          spiritCategory: masterItem.spiritCategory || '',
          ingredients: masterItem.ingredients || '',
          abv: masterItem.abv || '',
          servingUnit: masterItem.servingUnit || '',
          bottleSize: masterItem.bottleSize || '',
          unit: masterItem.unit || '',
          weight: masterItem.weight || '',
          shelfLife: masterItem.shelfLife || '',
          mfgDate: masterItem.mfgDate || null,
          expiryDate: masterItem.expiryDate || null,
          servingSize: masterItem.servingSize || '',
          scoopOptions: masterItem.scoopOptions || '',
          orgMenuItemId: masterItem.id,
          templateId: templateId,
          syncedAt: now,
          localOnly: false,
        };

        menuItems[existingIndex] = updatedItem;
        updated++;
      } else {
        // New item — add to outlet menu
        const newItem = {
          id: masterItem.id + '_' + outletId.substring(0, 6),
          name: masterItem.name,
          description: masterItem.description,
          category: masterItem.category,
          price: masterItem.basePrice,
          variants: masterItem.variants,
          image: masterItem.image,
          images: masterItem.images || [],
          isVeg: masterItem.isVeg,
          tags: masterItem.tags,
          shortCode: masterItem.shortCode || '',
          customizations: masterItem.customizations || [],
          dineInPrice: masterItem.dineInPrice ?? null,
          takeawayPrice: masterItem.takeawayPrice ?? null,
          deliveryPrice: masterItem.deliveryPrice ?? null,
          allergens: masterItem.allergens || [],
          spiritCategory: masterItem.spiritCategory || '',
          ingredients: masterItem.ingredients || '',
          abv: masterItem.abv || '',
          servingUnit: masterItem.servingUnit || '',
          bottleSize: masterItem.bottleSize || '',
          unit: masterItem.unit || '',
          weight: masterItem.weight || '',
          shelfLife: masterItem.shelfLife || '',
          mfgDate: masterItem.mfgDate || null,
          expiryDate: masterItem.expiryDate || null,
          servingSize: masterItem.servingSize || '',
          scoopOptions: masterItem.scoopOptions || '',
          isAvailable: true,
          orgMenuItemId: masterItem.id,
          templateId: templateId,
          syncedAt: now,
          localOnly: false,
        };

        menuItems.push(newItem);
        added++;
      }
    }

    // Write updated menu back to restaurant
    await restaurantRef.update({
      'menu.items': menuItems,
      'menu.lastUpdated': now,
    });

    results.push({ outletId, status: 'success', added, updated, skipped });
  }

  // Update template metadata
  const existingOutlets = template.assignedOutlets || [];
  const allOutlets = [...new Set([...existingOutlets, ...outletIds])];

  await templateRef.update({
    assignedOutlets: allOutlets,
    lastPushedAt: now,
    updatedAt: now,
  });

  return { results, template };
}

// ============================================================
// 9. POST /:orgId/templates/:templateId/push — Push template to outlets (CORE)
// ============================================================
router.post('/:orgId/templates/:templateId/push', async (req, res) => {
  try {
    const { orgId, templateId } = req.params;
    const { outletIds, overwriteExisting } = req.body;

    if (!outletIds || !Array.isArray(outletIds) || outletIds.length === 0) {
      return res.status(400).json({ success: false, error: 'outletIds array is required and must not be empty' });
    }

    // Validate template belongs to org
    const templateDoc = await db.collection(collections.orgMenuTemplates).doc(templateId).get();
    if (!templateDoc.exists) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    if (templateDoc.data().organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Template does not belong to this organization' });
    }

    // Validate all outlets belong to org
    for (const outletId of outletIds) {
      const belongs = await isRestaurantInOrg(orgId, outletId);
      if (!belongs) {
        return res.status(403).json({ success: false, error: `Outlet ${outletId} does not belong to this organization` });
      }
    }

    const { results, template } = await pushTemplateToOutlets(templateId, outletIds, overwriteExisting);

    // Log to audit
    const auditRef = db.collection(collections.orgAuditLog).doc();
    await auditRef.set({
      id: auditRef.id,
      organizationId: orgId,
      action: 'template_push',
      templateId,
      templateName: template.name,
      outletIds,
      overwriteExisting: overwriteExisting || false,
      results,
      performedBy: req.user.uid,
      performedAt: new Date().toISOString(),
    });

    return res.json({
      success: true,
      message: `Template pushed to ${outletIds.length} outlet(s)`,
      results,
    });
  } catch (error) {
    console.error('Error pushing template:', error);
    return res.status(500).json({ success: false, error: 'Failed to push template to outlets' });
  }
});

// ============================================================
// 10. POST /:orgId/templates/:templateId/sync — Re-sync changes to pushed outlets
// ============================================================
router.post('/:orgId/templates/:templateId/sync', async (req, res) => {
  try {
    const { orgId, templateId } = req.params;

    const templateRef = db.collection(collections.orgMenuTemplates).doc(templateId);
    const templateDoc = await templateRef.get();

    if (!templateDoc.exists) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }

    const template = templateDoc.data();

    if (template.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Template does not belong to this organization' });
    }

    const assignedOutlets = template.assignedOutlets || [];

    if (assignedOutlets.length === 0) {
      return res.status(400).json({ success: false, error: 'Template has no assigned outlets to sync' });
    }

    // Get all active master items
    const itemsSnap = await db.collection(collections.orgMenuItems)
      .where('templateId', '==', templateId)
      .where('status', '==', 'active')
      .get();

    const masterItems = itemsSnap.docs.map(doc => doc.data());
    const now = new Date().toISOString();
    const results = [];

    for (const outletId of assignedOutlets) {
      const restaurantRef = db.collection(collections.restaurants).doc(outletId);
      const restaurantDoc = await restaurantRef.get();

      if (!restaurantDoc.exists) {
        results.push({ outletId, status: 'error', error: 'Restaurant not found' });
        continue;
      }

      const restaurant = restaurantDoc.data();
      const menuItems = (restaurant.menu && restaurant.menu.items) ? [...restaurant.menu.items] : [];

      let synced = 0;
      let skipped = 0;

      for (const masterItem of masterItems) {
        const existingIndex = menuItems.findIndex(mi => mi.orgMenuItemId === masterItem.id);

        if (existingIndex === -1) {
          // Item not in outlet, skip (use push to add new items)
          skipped++;
          continue;
        }

        const existingItem = menuItems[existingIndex];

        // isLocked items always sync; non-locked items only sync if not locally overridden
        if (masterItem.isLocked || !existingItem.isLocalOverride) {
          const updatedItem = {
            ...existingItem,
            name: masterItem.name,
            description: masterItem.description,
            category: masterItem.category,
            price: (existingItem.isLocalOverride && !masterItem.isLocked) ? existingItem.price : masterItem.basePrice,
            variants: masterItem.variants,
            image: masterItem.image,
            images: masterItem.images || [],
            isVeg: masterItem.isVeg,
            tags: masterItem.tags,
            shortCode: masterItem.shortCode || existingItem.shortCode || '',
            customizations: masterItem.customizations || [],
            dineInPrice: masterItem.dineInPrice ?? existingItem.dineInPrice ?? null,
            takeawayPrice: masterItem.takeawayPrice ?? existingItem.takeawayPrice ?? null,
            deliveryPrice: masterItem.deliveryPrice ?? existingItem.deliveryPrice ?? null,
            allergens: masterItem.allergens || [],
            spiritCategory: masterItem.spiritCategory || '',
            ingredients: masterItem.ingredients || '',
            abv: masterItem.abv || '',
            servingUnit: masterItem.servingUnit || '',
            bottleSize: masterItem.bottleSize || '',
            unit: masterItem.unit || '',
            weight: masterItem.weight || '',
            shelfLife: masterItem.shelfLife || '',
            mfgDate: masterItem.mfgDate || null,
            expiryDate: masterItem.expiryDate || null,
            servingSize: masterItem.servingSize || '',
            scoopOptions: masterItem.scoopOptions || '',
            syncedAt: now,
          };

          menuItems[existingIndex] = updatedItem;
          synced++;
        } else {
          skipped++;
        }
      }

      await restaurantRef.update({
        'menu.items': menuItems,
        'menu.lastUpdated': now,
      });

      results.push({ outletId, status: 'success', synced, skipped });
    }

    // Update template metadata
    await templateRef.update({
      lastPushedAt: now,
      updatedAt: now,
    });

    // Log to audit
    const auditRef = db.collection(collections.orgAuditLog).doc();
    await auditRef.set({
      id: auditRef.id,
      organizationId: orgId,
      action: 'template_sync',
      templateId,
      templateName: template.name,
      outletIds: assignedOutlets,
      results,
      performedBy: req.user.uid,
      performedAt: now,
    });

    return res.json({
      success: true,
      message: `Template synced to ${assignedOutlets.length} outlet(s)`,
      results,
    });
  } catch (error) {
    console.error('Error syncing template:', error);
    return res.status(500).json({ success: false, error: 'Failed to sync template' });
  }
});

// ============================================================
// 11. GET /:orgId/sync-status — Sync status across all outlets
// ============================================================
router.get('/:orgId/sync-status', async (req, res) => {
  try {
    const { orgId } = req.params;

    // Get all active templates for this org
    const templatesSnap = await db.collection(collections.orgMenuTemplates)
      .where('organizationId', '==', orgId)
      .where('status', '==', 'active')
      .get();

    // Collect all master items across all templates
    const masterItemsByTemplate = {};
    for (const tDoc of templatesSnap.docs) {
      const t = tDoc.data();
      const itemsSnap = await db.collection(collections.orgMenuItems)
        .where('templateId', '==', t.id)
        .where('status', '==', 'active')
        .get();
      masterItemsByTemplate[t.id] = itemsSnap.docs.map(d => d.data());
    }

    // Get all outlets for this org
    const outlets = await getOrgOutlets(orgId);
    const outletStatuses = [];

    for (const outlet of outlets) {
      const outletId = outlet.id;
      if (!outletId) continue;
      const restaurantDoc = await db.collection(collections.restaurants).doc(outletId).get();

      if (!restaurantDoc.exists) {
        outletStatuses.push({ outletId, status: 'error', error: 'Restaurant not found' });
        continue;
      }

      const restaurant = restaurantDoc.data();
      const menuItems = (restaurant.menu && restaurant.menu.items) ? restaurant.menu.items : [];

      let totalMasterItems = 0;
      let syncedCount = 0;
      let overriddenCount = 0;
      let missingCount = 0;

      for (const templateId of Object.keys(masterItemsByTemplate)) {
        const masterItems = masterItemsByTemplate[templateId];
        totalMasterItems += masterItems.length;

        for (const masterItem of masterItems) {
          const outletItem = menuItems.find(mi => mi.orgMenuItemId === masterItem.id);

          if (!outletItem) {
            missingCount++;
          } else if (outletItem.isLocalOverride) {
            overriddenCount++;
          } else {
            syncedCount++;
          }
        }
      }

      outletStatuses.push({
        outletId,
        restaurantName: restaurant.name || '',
        totalMasterItems,
        syncedCount,
        overriddenCount,
        missingCount,
      });
    }

    return res.json({ success: true, outlets: outletStatuses });
  } catch (error) {
    console.error('Error getting sync status:', error);
    return res.status(500).json({ success: false, error: 'Failed to get sync status' });
  }
});

// ============================================================
// 12. POST /:orgId/items/:itemId/lock — Toggle lock on a master item
// ============================================================
router.post('/:orgId/items/:itemId/lock', async (req, res) => {
  try {
    const { orgId, itemId } = req.params;
    const { locked, lockFields } = req.body;

    if (locked === undefined) {
      return res.status(400).json({ success: false, error: 'locked field is required' });
    }

    const itemRef = db.collection(collections.orgMenuItems).doc(itemId);
    const itemDoc = await itemRef.get();

    if (!itemDoc.exists) {
      return res.status(404).json({ success: false, error: 'Item not found' });
    }

    const item = itemDoc.data();

    if (item.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Item does not belong to this organization' });
    }

    const updates = {
      isLocked: !!locked,
      lockFields: lockFields || [],
      updatedAt: new Date().toISOString(),
    };

    await itemRef.update(updates);

    return res.json({ success: true, item: { ...item, ...updates } });
  } catch (error) {
    console.error('Error toggling lock:', error);
    return res.status(500).json({ success: false, error: 'Failed to toggle item lock' });
  }
});

// ============================================================
// 13. POST /:orgId/import-from-outlet/:restaurantId — Import menu as template
// ============================================================
router.post('/:orgId/import-from-outlet/:restaurantId', async (req, res) => {
  try {
    const { orgId, restaurantId } = req.params;

    // Validate restaurant belongs to org
    const belongs = await isRestaurantInOrg(orgId, restaurantId);
    if (!belongs) {
      return res.status(403).json({ success: false, error: 'Restaurant does not belong to this organization' });
    }

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    const menuItems = (restaurant.menu && restaurant.menu.items) ? restaurant.menu.items : [];

    if (menuItems.length === 0) {
      return res.status(400).json({ success: false, error: 'Restaurant has no menu items to import' });
    }

    const now = new Date().toISOString();

    // Extract unique categories from menu items
    const categorySet = new Set();
    menuItems.forEach(item => {
      if (item.category) categorySet.add(item.category);
    });

    const categories = Array.from(categorySet).map((name, idx) => ({
      name,
      sortOrder: idx,
    }));

    // Create template
    const templateRef = db.collection(collections.orgMenuTemplates).doc();
    const template = {
      id: templateRef.id,
      organizationId: orgId,
      name: `Imported from ${restaurant.name || restaurantId}`,
      description: `Menu imported from ${restaurant.name || restaurantId} on ${now}`,
      categories,
      status: 'active',
      assignedOutlets: [],
      lastPushedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.uid,
    };

    const batch = db.batch();
    batch.set(templateRef, template);

    // Create orgMenuItems from restaurant menu items
    const createdItems = [];

    for (const menuItem of menuItems) {
      const itemRef = db.collection(collections.orgMenuItems).doc();

      const orgMenuItem = {
        id: itemRef.id,
        organizationId: orgId,
        templateId: templateRef.id,
        name: menuItem.name || '',
        description: menuItem.description || '',
        category: menuItem.category || 'Uncategorized',
        basePrice: menuItem.price || 0,
        variants: menuItem.variants || [],
        image: menuItem.image || '',
        images: menuItem.images || [],
        isVeg: menuItem.isVeg !== undefined ? menuItem.isVeg : true,
        tags: menuItem.tags || [],
        shortCode: menuItem.shortCode || '',
        customizations: menuItem.customizations || [],
        dineInPrice: menuItem.dineInPrice ?? null,
        takeawayPrice: menuItem.takeawayPrice ?? null,
        deliveryPrice: menuItem.deliveryPrice ?? null,
        allergens: menuItem.allergens || [],
        spiritCategory: menuItem.spiritCategory || '',
        ingredients: menuItem.ingredients || '',
        abv: menuItem.abv || '',
        servingUnit: menuItem.servingUnit || '',
        bottleSize: menuItem.bottleSize || '',
        unit: menuItem.unit || '',
        weight: menuItem.weight || '',
        shelfLife: menuItem.shelfLife || '',
        mfgDate: menuItem.mfgDate || null,
        expiryDate: menuItem.expiryDate || null,
        servingSize: menuItem.servingSize || '',
        scoopOptions: menuItem.scoopOptions || '',
        isStockManaged: menuItem.isStockManaged || false,
        stockQuantity: menuItem.stockQuantity ?? null,
        lowStockThreshold: menuItem.lowStockThreshold ?? 5,
        isLocked: false,
        lockFields: [],
        sortOrder: menuItem.sortOrder || 0,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };

      batch.set(itemRef, orgMenuItem);
      createdItems.push(orgMenuItem);
    }

    await batch.commit();

    // Log to audit
    const auditRef = db.collection(collections.orgAuditLog).doc();
    await auditRef.set({
      id: auditRef.id,
      organizationId: orgId,
      action: 'menu_import',
      sourceRestaurantId: restaurantId,
      templateId: templateRef.id,
      itemCount: createdItems.length,
      performedBy: req.user.uid,
      performedAt: now,
    });

    return res.status(201).json({
      success: true,
      template,
      itemCount: createdItems.length,
      message: `Imported ${createdItems.length} items from ${restaurant.name || restaurantId}`,
    });
  } catch (error) {
    console.error('Error importing menu:', error);
    return res.status(500).json({ success: false, error: 'Failed to import menu from outlet' });
  }
});

module.exports = router;
module.exports.pushTemplateToOutlets = pushTemplateToOutlets;
