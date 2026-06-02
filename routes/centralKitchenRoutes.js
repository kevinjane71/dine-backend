const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const { requireOrgFeature, isRestaurantInOrg, requireOrgMember, getActorId } = require('../middleware/orgAccess');

// ============================================
// CENTRAL KITCHEN PRODUCTION & DISTRIBUTION APIs
// Mounted at /api/central-kitchen
// All endpoints require authenticateToken + org membership (manager+) + centralKitchen feature
// ============================================

const ckMiddleware = [authenticateToken, requireOrgMember({ minRole: 'manager' }), requireOrgFeature('centralKitchen')];

// ─── Helper: Generate next production order number ───────────────────────────
async function generateOrderNumber(orgId) {
  const counterRef = db.collection(collections.orgSettings).doc(`${orgId}_productionCounter`);
  const result = await db.runTransaction(async (t) => {
    const counterDoc = await t.get(counterRef);
    let seq = 1;
    if (counterDoc.exists) {
      seq = (counterDoc.data().current || 0) + 1;
    }
    t.set(counterRef, { current: seq }, { merge: true });
    return seq;
  });
  const year = new Date().getFullYear();
  return `PO-${year}-${String(result).padStart(4, '0')}`;
}

// ─── Helper: Verify outlet is a central kitchen in org ───────────────────────
async function verifyCentralKitchen(orgId, kitchenId) {
  const doc = await db.collection(collections.restaurants).doc(kitchenId).get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (data.organizationId !== orgId || data.outletType !== 'central_kitchen') return null;
  return { id: doc.id, ...data };
}

// ─── Helper: Create inventory transaction ────────────────────────────────────
async function createInventoryTransaction(txData) {
  await db.collection(collections.inventoryTransactions).add({
    restaurantId: txData.restaurantId,
    inventoryItemId: txData.inventoryItemId,
    inventoryItemName: txData.inventoryItemName,
    type: txData.type,
    source: txData.source,
    quantityChange: txData.quantityChange,
    previousStock: txData.previousStock,
    newStock: txData.newStock,
    unit: txData.unit || '',
    performedBy: txData.performedBy,
    notes: txData.notes || '',
    date: new Date()
  });
}

// ════════════════════════════════════════════════
//  PRODUCTION ORDERS
// ════════════════════════════════════════════════

/**
 * POST /:orgId/production-orders
 * Create a new production order
 */
router.post('/:orgId/production-orders', ...ckMiddleware, async (req, res) => {
  try {
    const userId = getActorId(req);
    const { orgId } = req.params;
    const { centralKitchenId, recipeId, targetQuantity, unit, scheduledDate, notes } = req.body;

    if (!centralKitchenId || !recipeId || !targetQuantity || !unit || !scheduledDate) {
      return res.status(400).json({ error: 'centralKitchenId, recipeId, targetQuantity, unit, and scheduledDate are required' });
    }

    // Verify central kitchen
    const kitchen = await verifyCentralKitchen(orgId, centralKitchenId);
    if (!kitchen) {
      return res.status(400).json({ error: 'Invalid central kitchen. Must be an outlet with outletType=central_kitchen belonging to this organization.' });
    }

    // Fetch recipe for name
    const recipeDoc = await db.collection(collections.recipes).doc(recipeId).get();
    if (!recipeDoc.exists) {
      return res.status(404).json({ error: 'Recipe not found' });
    }
    const recipeName = recipeDoc.data().name || recipeDoc.data().recipeName || 'Unknown Recipe';

    // Generate order number
    const orderNumber = await generateOrderNumber(orgId);

    const orderData = {
      organizationId: orgId,
      centralKitchenId,
      orderNumber,
      recipeId,
      recipeName,
      targetQuantity: Number(targetQuantity),
      producedQuantity: null,
      unit,
      status: 'planned',
      scheduledDate: new Date(scheduledDate),
      completedDate: null,
      ingredientsConsumed: [],
      productionEntryId: null,
      distributionPlanId: null,
      notes: notes || '',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const ref = await db.collection(collections.productionOrders).add(orderData);

    res.status(201).json({ id: ref.id, ...orderData });
  } catch (error) {
    console.error('Create production order error:', error.message);
    res.status(500).json({ error: 'Failed to create production order' });
  }
});

/**
 * GET /:orgId/production-orders
 * List production orders with filters
 */
router.get('/:orgId/production-orders', ...ckMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { status, centralKitchenId, startDate, endDate, page = 1, limit = 50 } = req.query;

    let query = db.collection(collections.productionOrders)
      .where('organizationId', '==', orgId);

    if (status) {
      query = query.where('status', '==', status);
    }
    if (centralKitchenId) {
      query = query.where('centralKitchenId', '==', centralKitchenId);
    }

    query = query.orderBy('scheduledDate', 'desc');

    const snapshot = await query.get();
    let orders = [];
    snapshot.forEach(doc => {
      orders.push({ id: doc.id, ...doc.data() });
    });

    // Date filtering (post-query since Firestore limits compound queries)
    if (startDate) {
      const start = new Date(startDate);
      orders = orders.filter(o => {
        const d = o.scheduledDate?.toDate ? o.scheduledDate.toDate() : new Date(o.scheduledDate);
        return d >= start;
      });
    }
    if (endDate) {
      const end = new Date(endDate);
      orders = orders.filter(o => {
        const d = o.scheduledDate?.toDate ? o.scheduledDate.toDate() : new Date(o.scheduledDate);
        return d <= end;
      });
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const total = orders.length;
    const paginated = orders.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({ orders: paginated, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error('List production orders error:', error.message);
    res.status(500).json({ error: 'Failed to list production orders' });
  }
});

/**
 * GET /:orgId/production-orders/:orderId
 * Get production order detail with recipe info
 */
router.get('/:orgId/production-orders/:orderId', ...ckMiddleware, async (req, res) => {
  try {
    const { orgId, orderId } = req.params;

    const doc = await db.collection(collections.productionOrders).doc(orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Production order not found' });
    }

    const order = { id: doc.id, ...doc.data() };
    if (order.organizationId !== orgId) {
      return res.status(403).json({ error: 'Order does not belong to this organization' });
    }

    // Fetch recipe details
    let recipe = null;
    if (order.recipeId) {
      const recipeDoc = await db.collection(collections.recipes).doc(order.recipeId).get();
      if (recipeDoc.exists) {
        recipe = { id: recipeDoc.id, ...recipeDoc.data() };
      }
    }

    res.json({ order, recipe });
  } catch (error) {
    console.error('Get production order error:', error.message);
    res.status(500).json({ error: 'Failed to get production order' });
  }
});

/**
 * PATCH /:orgId/production-orders/:orderId/start
 * Start production (set status to in_production)
 */
router.patch('/:orgId/production-orders/:orderId/start', ...ckMiddleware, async (req, res) => {
  try {
    const { orgId, orderId } = req.params;

    const doc = await db.collection(collections.productionOrders).doc(orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Production order not found' });
    }

    const order = doc.data();
    if (order.organizationId !== orgId) {
      return res.status(403).json({ error: 'Order does not belong to this organization' });
    }
    if (order.status !== 'planned') {
      return res.status(400).json({ error: `Cannot start order with status '${order.status}'. Must be 'planned'.` });
    }

    await db.collection(collections.productionOrders).doc(orderId).update({
      status: 'in_production',
      updatedAt: new Date()
    });

    res.json({ message: 'Production started', orderId, status: 'in_production' });
  } catch (error) {
    console.error('Start production error:', error.message);
    res.status(500).json({ error: 'Failed to start production' });
  }
});

/**
 * PATCH /:orgId/production-orders/:orderId/complete
 * Complete production — deduct ingredients, add finished goods, create production entry
 */
router.patch('/:orgId/production-orders/:orderId/complete', ...ckMiddleware, async (req, res) => {
  try {
    const userId = getActorId(req);
    const { orgId, orderId } = req.params;
    const { producedQuantity } = req.body;

    if (producedQuantity === undefined || producedQuantity === null || producedQuantity <= 0) {
      return res.status(400).json({ error: 'producedQuantity is required and must be greater than 0' });
    }

    const orderDoc = await db.collection(collections.productionOrders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Production order not found' });
    }

    const order = orderDoc.data();
    if (order.organizationId !== orgId) {
      return res.status(403).json({ error: 'Order does not belong to this organization' });
    }
    if (order.status !== 'in_production') {
      return res.status(400).json({ error: `Cannot complete order with status '${order.status}'. Must be 'in_production'.` });
    }

    // Fetch recipe and ingredients
    const recipeDoc = await db.collection(collections.recipes).doc(order.recipeId).get();
    if (!recipeDoc.exists) {
      return res.status(404).json({ error: 'Recipe not found. Cannot complete production without recipe.' });
    }

    const recipe = recipeDoc.data();
    const ingredients = recipe.ingredients || [];
    const ingredientsConsumed = [];
    const warnings = [];

    // Deduct each ingredient from central kitchen inventory
    for (const ingredient of ingredients) {
      const needed = recipe.servings
        ? (ingredient.quantity * producedQuantity) / recipe.servings
        : ingredient.quantity * producedQuantity;

      // Find matching inventory item in central kitchen
      const invSnapshot = await db.collection(collections.inventory)
        .where('restaurantId', '==', order.centralKitchenId)
        .where('name', '==', ingredient.name)
        .limit(1)
        .get();

      if (invSnapshot.empty) {
        warnings.push(`Inventory item '${ingredient.name}' not found in central kitchen. Skipping deduction.`);
        ingredientsConsumed.push({
          name: ingredient.name,
          quantityUsed: needed,
          unit: ingredient.unit || '',
          warning: 'Item not found in inventory'
        });
        continue;
      }

      const invDoc = invSnapshot.docs[0];
      const invData = invDoc.data();
      const previousStock = invData.currentStock || 0;
      const newStock = previousStock - needed;

      // Update inventory
      await db.collection(collections.inventory).doc(invDoc.id).update({
        currentStock: newStock,
        updatedAt: new Date()
      });

      // Create inventory transaction
      await createInventoryTransaction({
        restaurantId: order.centralKitchenId,
        inventoryItemId: invDoc.id,
        inventoryItemName: ingredient.name,
        type: 'DEDUCTION',
        source: 'CK_PRODUCTION',
        quantityChange: -needed,
        previousStock,
        newStock,
        unit: ingredient.unit || invData.unit || '',
        performedBy: userId,
        notes: `Production order ${order.orderNumber} — recipe: ${order.recipeName}`
      });

      ingredientsConsumed.push({
        name: ingredient.name,
        inventoryItemId: invDoc.id,
        quantityUsed: needed,
        unit: ingredient.unit || invData.unit || '',
        previousStock,
        newStock
      });
    }

    // Add finished goods to central kitchen inventory (if matching item exists)
    let finishedGoodsNote = null;
    const fgSnapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', order.centralKitchenId)
      .where('name', '==', order.recipeName)
      .limit(1)
      .get();

    if (!fgSnapshot.empty) {
      const fgDoc = fgSnapshot.docs[0];
      const fgData = fgDoc.data();
      const prevStock = fgData.currentStock || 0;
      const updatedStock = prevStock + Number(producedQuantity);

      await db.collection(collections.inventory).doc(fgDoc.id).update({
        currentStock: updatedStock,
        updatedAt: new Date()
      });

      await createInventoryTransaction({
        restaurantId: order.centralKitchenId,
        inventoryItemId: fgDoc.id,
        inventoryItemName: order.recipeName,
        type: 'ADDITION',
        source: 'CK_PRODUCTION',
        quantityChange: Number(producedQuantity),
        previousStock: prevStock,
        newStock: updatedStock,
        unit: order.unit,
        performedBy: userId,
        notes: `Finished goods from production order ${order.orderNumber}`
      });
    } else {
      finishedGoodsNote = `No inventory item found matching '${order.recipeName}' in central kitchen. Finished goods not added to inventory automatically.`;
      warnings.push(finishedGoodsNote);
    }

    // Create production entry
    const productionEntry = {
      restaurantId: order.centralKitchenId,
      recipeId: order.recipeId,
      recipeName: order.recipeName,
      quantity: Number(producedQuantity),
      batchNumber: order.orderNumber,
      date: new Date(),
      producedBy: userId,
      createdAt: new Date()
    };
    const peRef = await db.collection(collections.productionEntries).add(productionEntry);

    // Update production order
    await db.collection(collections.productionOrders).doc(orderId).update({
      status: 'completed',
      completedDate: new Date(),
      producedQuantity: Number(producedQuantity),
      ingredientsConsumed,
      productionEntryId: peRef.id,
      updatedAt: new Date()
    });

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'PRODUCTION_ORDER_COMPLETED',
      entityType: 'productionOrder',
      entityId: orderId,
      details: {
        orderNumber: order.orderNumber,
        recipeName: order.recipeName,
        producedQuantity: Number(producedQuantity),
        ingredientsCount: ingredientsConsumed.length
      },
      performedBy: userId,
      createdAt: new Date()
    });

    res.json({
      message: 'Production completed',
      orderId,
      status: 'completed',
      producedQuantity: Number(producedQuantity),
      ingredientsConsumed,
      productionEntryId: peRef.id,
      warnings: warnings.length > 0 ? warnings : undefined
    });
  } catch (error) {
    console.error('Complete production error:', error.message);
    res.status(500).json({ error: 'Failed to complete production' });
  }
});

/**
 * PATCH /:orgId/production-orders/:orderId/cancel
 * Cancel a production order (only if planned or in_production)
 */
router.patch('/:orgId/production-orders/:orderId/cancel', ...ckMiddleware, async (req, res) => {
  try {
    const userId = getActorId(req);
    const { orgId, orderId } = req.params;

    const doc = await db.collection(collections.productionOrders).doc(orderId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Production order not found' });
    }

    const order = doc.data();
    if (order.organizationId !== orgId) {
      return res.status(403).json({ error: 'Order does not belong to this organization' });
    }

    if (!['planned', 'in_production'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot cancel order with status '${order.status}'. Must be 'planned' or 'in_production'.` });
    }

    const note = order.status === 'in_production'
      ? 'Order cancelled while in production. No ingredient reversal performed.'
      : 'Order cancelled before production started.';

    await db.collection(collections.productionOrders).doc(orderId).update({
      status: 'cancelled',
      notes: order.notes ? `${order.notes}\n${note}` : note,
      updatedAt: new Date()
    });

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'PRODUCTION_ORDER_CANCELLED',
      entityType: 'productionOrder',
      entityId: orderId,
      details: {
        orderNumber: order.orderNumber,
        previousStatus: order.status,
        note
      },
      performedBy: userId,
      createdAt: new Date()
    });

    res.json({ message: 'Production order cancelled', orderId, status: 'cancelled', note });
  } catch (error) {
    console.error('Cancel production order error:', error.message);
    res.status(500).json({ error: 'Failed to cancel production order' });
  }
});


// ════════════════════════════════════════════════
//  DISTRIBUTION PLANS
// ════════════════════════════════════════════════

/**
 * POST /:orgId/distribution-plans
 * Create a distribution plan
 */
router.post('/:orgId/distribution-plans', ...ckMiddleware, async (req, res) => {
  try {
    const userId = getActorId(req);
    const { orgId } = req.params;
    const { productionOrderId, itemName, totalQuantity, unit, allocations } = req.body;

    if (!itemName || !totalQuantity || !unit || !allocations || !allocations.length) {
      return res.status(400).json({ error: 'itemName, totalQuantity, unit, and allocations are required' });
    }

    // Validate production order if provided
    let centralKitchenIdFromPO = null;
    if (productionOrderId) {
      const poDoc = await db.collection(collections.productionOrders).doc(productionOrderId).get();
      if (!poDoc.exists) {
        return res.status(404).json({ error: 'Production order not found' });
      }
      const po = poDoc.data();
      if (po.organizationId !== orgId) {
        return res.status(403).json({ error: 'Production order does not belong to this organization' });
      }
      centralKitchenIdFromPO = po.centralKitchenId;
    }

    // Validate allocation quantities
    const allocTotal = allocations.reduce((sum, a) => sum + Number(a.quantity || 0), 0);
    if (allocTotal > Number(totalQuantity)) {
      return res.status(400).json({ error: `Sum of allocation quantities (${allocTotal}) exceeds totalQuantity (${totalQuantity})` });
    }

    // Validate all outlets belong to org
    for (const alloc of allocations) {
      const belongs = await isRestaurantInOrg(orgId, alloc.outletId);
      if (!belongs) {
        return res.status(400).json({ error: `Outlet ${alloc.outletId} does not belong to this organization` });
      }
    }

    const planData = {
      organizationId: orgId,
      productionOrderId: productionOrderId || null,
      centralKitchenId: centralKitchenIdFromPO || req.body.centralKitchenId || null,
      itemName,
      totalQuantity: Number(totalQuantity),
      unit,
      allocations: allocations.map(a => ({
        outletId: a.outletId,
        outletName: a.outletName || '',
        quantity: Number(a.quantity),
        status: 'planned',
        dispatchedAt: null,
        receivedAt: null,
        receivedBy: null,
        actualReceivedQty: null
      })),
      status: 'draft',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const ref = await db.collection(collections.distributionPlans).add(planData);

    // Link distribution plan to production order if provided
    if (productionOrderId) {
      await db.collection(collections.productionOrders).doc(productionOrderId).update({
        distributionPlanId: ref.id,
        updatedAt: new Date()
      });
    }

    res.status(201).json({ id: ref.id, ...planData });
  } catch (error) {
    console.error('Create distribution plan error:', error.message);
    res.status(500).json({ error: 'Failed to create distribution plan' });
  }
});

/**
 * GET /:orgId/distribution-plans
 * List distribution plans with filters
 */
router.get('/:orgId/distribution-plans', ...ckMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { status, centralKitchenId, page = 1, limit = 50 } = req.query;

    let query = db.collection(collections.distributionPlans)
      .where('organizationId', '==', orgId);

    if (status) {
      query = query.where('status', '==', status);
    }
    if (centralKitchenId) {
      query = query.where('centralKitchenId', '==', centralKitchenId);
    }

    query = query.orderBy('createdAt', 'desc');

    const snapshot = await query.get();
    const plans = [];
    snapshot.forEach(doc => {
      plans.push({ id: doc.id, ...doc.data() });
    });

    // Pagination
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const total = plans.length;
    const paginated = plans.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({ plans: paginated, total, page: pageNum, limit: limitNum });
  } catch (error) {
    console.error('List distribution plans error:', error.message);
    res.status(500).json({ error: 'Failed to list distribution plans' });
  }
});

/**
 * GET /:orgId/distribution-plans/:planId
 * Get distribution plan detail
 */
router.get('/:orgId/distribution-plans/:planId', ...ckMiddleware, async (req, res) => {
  try {
    const { orgId, planId } = req.params;

    const doc = await db.collection(collections.distributionPlans).doc(planId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Distribution plan not found' });
    }

    const plan = { id: doc.id, ...doc.data() };
    if (plan.organizationId !== orgId) {
      return res.status(403).json({ error: 'Plan does not belong to this organization' });
    }

    res.json({ plan });
  } catch (error) {
    console.error('Get distribution plan error:', error.message);
    res.status(500).json({ error: 'Failed to get distribution plan' });
  }
});

/**
 * PATCH /:orgId/distribution-plans/:planId/dispatch/:outletId
 * Dispatch goods to a specific outlet
 */
router.patch('/:orgId/distribution-plans/:planId/dispatch/:outletId', ...ckMiddleware, async (req, res) => {
  try {
    const userId = getActorId(req);
    const { orgId, planId, outletId } = req.params;

    const doc = await db.collection(collections.distributionPlans).doc(planId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Distribution plan not found' });
    }

    const plan = doc.data();
    if (plan.organizationId !== orgId) {
      return res.status(403).json({ error: 'Plan does not belong to this organization' });
    }

    // Find the allocation for this outlet
    const allocIndex = plan.allocations.findIndex(a => a.outletId === outletId);
    if (allocIndex === -1) {
      return res.status(404).json({ error: `No allocation found for outlet ${outletId} in this plan` });
    }

    const allocation = plan.allocations[allocIndex];
    if (allocation.status !== 'planned') {
      return res.status(400).json({ error: `Allocation for this outlet is already '${allocation.status}'` });
    }

    // Deduct from central kitchen inventory
    const invSnapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', plan.centralKitchenId)
      .where('name', '==', plan.itemName)
      .limit(1)
      .get();

    if (!invSnapshot.empty) {
      const invDoc = invSnapshot.docs[0];
      const invData = invDoc.data();
      const previousStock = invData.currentStock || 0;
      const newStock = previousStock - allocation.quantity;

      await db.collection(collections.inventory).doc(invDoc.id).update({
        currentStock: newStock,
        updatedAt: new Date()
      });

      await createInventoryTransaction({
        restaurantId: plan.centralKitchenId,
        inventoryItemId: invDoc.id,
        inventoryItemName: plan.itemName,
        type: 'DEDUCTION',
        source: 'CK_DISTRIBUTION',
        quantityChange: -allocation.quantity,
        previousStock,
        newStock,
        unit: plan.unit,
        performedBy: userId,
        notes: `Distribution to ${allocation.outletName || outletId} — plan ${planId}`
      });
    }

    // Update allocation status
    const updatedAllocations = [...plan.allocations];
    updatedAllocations[allocIndex] = {
      ...allocation,
      status: 'dispatched',
      dispatchedAt: new Date()
    };

    // Determine plan status
    const allDispatched = updatedAllocations.every(a => ['dispatched', 'in_transit', 'received'].includes(a.status));
    const planStatus = allDispatched ? 'fully_dispatched' : 'partially_dispatched';

    await db.collection(collections.distributionPlans).doc(planId).update({
      allocations: updatedAllocations,
      status: planStatus,
      updatedAt: new Date()
    });

    res.json({
      message: `Dispatched to ${allocation.outletName || outletId}`,
      planId,
      outletId,
      quantity: allocation.quantity,
      planStatus
    });
  } catch (error) {
    console.error('Dispatch error:', error.message);
    res.status(500).json({ error: 'Failed to dispatch' });
  }
});

/**
 * PATCH /:orgId/distribution-plans/:planId/receive/:outletId
 * Outlet receives dispatched goods
 */
router.patch('/:orgId/distribution-plans/:planId/receive/:outletId', ...ckMiddleware, async (req, res) => {
  try {
    const userId = getActorId(req);
    const { orgId, planId, outletId } = req.params;
    const { actualReceivedQty } = req.body;

    if (actualReceivedQty === undefined || actualReceivedQty === null || actualReceivedQty < 0) {
      return res.status(400).json({ error: 'actualReceivedQty is required and must be >= 0' });
    }

    const doc = await db.collection(collections.distributionPlans).doc(planId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Distribution plan not found' });
    }

    const plan = doc.data();
    if (plan.organizationId !== orgId) {
      return res.status(403).json({ error: 'Plan does not belong to this organization' });
    }

    const allocIndex = plan.allocations.findIndex(a => a.outletId === outletId);
    if (allocIndex === -1) {
      return res.status(404).json({ error: `No allocation found for outlet ${outletId} in this plan` });
    }

    const allocation = plan.allocations[allocIndex];
    if (allocation.status !== 'dispatched' && allocation.status !== 'in_transit') {
      return res.status(400).json({ error: `Cannot receive. Allocation status is '${allocation.status}'. Must be 'dispatched' or 'in_transit'.` });
    }

    // Add to outlet inventory
    const invSnapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', outletId)
      .where('name', '==', plan.itemName)
      .limit(1)
      .get();

    let inventoryItemId;
    let previousStock = 0;
    let newStock = Number(actualReceivedQty);

    if (!invSnapshot.empty) {
      const invDoc = invSnapshot.docs[0];
      const invData = invDoc.data();
      inventoryItemId = invDoc.id;
      previousStock = invData.currentStock || 0;
      newStock = previousStock + Number(actualReceivedQty);

      await db.collection(collections.inventory).doc(invDoc.id).update({
        currentStock: newStock,
        updatedAt: new Date()
      });
    } else {
      // Create new inventory item at outlet
      const newInvRef = await db.collection(collections.inventory).add({
        restaurantId: outletId,
        name: plan.itemName,
        currentStock: Number(actualReceivedQty),
        unit: plan.unit,
        category: 'Central Kitchen',
        source: 'CK_DISTRIBUTION',
        createdAt: new Date(),
        updatedAt: new Date()
      });
      inventoryItemId = newInvRef.id;
    }

    // Create inventory transaction
    await createInventoryTransaction({
      restaurantId: outletId,
      inventoryItemId,
      inventoryItemName: plan.itemName,
      type: 'ADDITION',
      source: 'CK_DISTRIBUTION_RECEIVED',
      quantityChange: Number(actualReceivedQty),
      previousStock,
      newStock,
      unit: plan.unit,
      performedBy: userId,
      notes: `Received from central kitchen — plan ${planId}`
    });

    // Create stock batch for traceability
    await db.collection(collections.stockBatches).add({
      restaurantId: outletId,
      inventoryItemId,
      itemName: plan.itemName,
      batchNumber: `CK-${planId.substring(0, 6)}-${Date.now()}`,
      quantity: Number(actualReceivedQty),
      unit: plan.unit,
      source: 'CK_DISTRIBUTION',
      distributionPlanId: planId,
      centralKitchenId: plan.centralKitchenId,
      receivedAt: new Date(),
      receivedBy: userId,
      createdAt: new Date()
    });

    // Update allocation
    const updatedAllocations = [...plan.allocations];
    updatedAllocations[allocIndex] = {
      ...allocation,
      status: 'received',
      receivedAt: new Date(),
      receivedBy: userId,
      actualReceivedQty: Number(actualReceivedQty)
    };

    // If all allocations received, mark plan as completed
    const allReceived = updatedAllocations.every(a => a.status === 'received');
    const planStatus = allReceived ? 'completed' : plan.status;

    await db.collection(collections.distributionPlans).doc(planId).update({
      allocations: updatedAllocations,
      status: planStatus,
      updatedAt: new Date()
    });

    res.json({
      message: `Received at outlet ${allocation.outletName || outletId}`,
      planId,
      outletId,
      actualReceivedQty: Number(actualReceivedQty),
      expectedQuantity: allocation.quantity,
      planStatus
    });
  } catch (error) {
    console.error('Receive error:', error.message);
    res.status(500).json({ error: 'Failed to receive goods' });
  }
});


// ════════════════════════════════════════════════
//  KITCHEN DASHBOARD
// ════════════════════════════════════════════════

/**
 * GET /:orgId/kitchen/:kitchenId/dashboard
 * Kitchen daily dashboard — today's orders, ingredient requirements, recent completions
 */
router.get('/:orgId/kitchen/:kitchenId/dashboard', ...ckMiddleware, async (req, res) => {
  try {
    const { orgId, kitchenId } = req.params;

    // Verify kitchen
    const kitchen = await verifyCentralKitchen(orgId, kitchenId);
    if (!kitchen) {
      return res.status(400).json({ error: 'Invalid central kitchen' });
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Today's production orders (all statuses)
    const todaySnapshot = await db.collection(collections.productionOrders)
      .where('organizationId', '==', orgId)
      .where('centralKitchenId', '==', kitchenId)
      .where('scheduledDate', '>=', todayStart)
      .where('scheduledDate', '<=', todayEnd)
      .limit(500)
      .get();

    const todayOrders = [];
    todaySnapshot.forEach(doc => {
      todayOrders.push({ id: doc.id, ...doc.data() });
    });

    // Calculate ingredient requirements for today's planned orders
    const ingredientRequirements = {};
    const plannedOrders = todayOrders.filter(o => o.status === 'planned' || o.status === 'in_production');

    // Batch-fetch unique recipes instead of N+1 per-order lookups
    const uniqueRecipeIds = [...new Set(plannedOrders.map(o => o.recipeId).filter(Boolean))];
    const recipeMap = {};
    const recipeDocs = await Promise.all(
      uniqueRecipeIds.map(id => db.collection(collections.recipes).doc(id).get())
    );
    recipeDocs.forEach(doc => {
      if (doc.exists) recipeMap[doc.id] = doc.data();
    });

    for (const order of plannedOrders) {
      if (!order.recipeId || !recipeMap[order.recipeId]) continue;
      const recipe = recipeMap[order.recipeId];
      const ingredients = recipe.ingredients || [];

      for (const ing of ingredients) {
        const needed = recipe.servings
          ? (ing.quantity * order.targetQuantity) / recipe.servings
          : ing.quantity * order.targetQuantity;

        const key = ing.name;
        if (!ingredientRequirements[key]) {
          ingredientRequirements[key] = { name: ing.name, unit: ing.unit || '', totalNeeded: 0 };
        }
        ingredientRequirements[key].totalNeeded += needed;
      }
    }

    // Recent completions (last 7 days)
    const recentSnapshot = await db.collection(collections.productionOrders)
      .where('organizationId', '==', orgId)
      .where('centralKitchenId', '==', kitchenId)
      .where('status', '==', 'completed')
      .where('completedDate', '>=', sevenDaysAgo)
      .select('orderNumber', 'recipeName', 'producedQuantity', 'unit', 'completedDate')
      .limit(100)
      .get();

    const recentCompletions = [];
    recentSnapshot.forEach(doc => {
      const data = doc.data();
      recentCompletions.push({
        id: doc.id,
        orderNumber: data.orderNumber,
        recipeName: data.recipeName,
        producedQuantity: data.producedQuantity,
        unit: data.unit,
        completedDate: data.completedDate
      });
    });

    // Summary counts
    const statusSummary = {
      planned: todayOrders.filter(o => o.status === 'planned').length,
      in_production: todayOrders.filter(o => o.status === 'in_production').length,
      completed: todayOrders.filter(o => o.status === 'completed').length,
      cancelled: todayOrders.filter(o => o.status === 'cancelled').length
    };

    res.json({
      kitchenId,
      kitchenName: kitchen.name,
      date: todayStart.toISOString().split('T')[0],
      todayOrders,
      statusSummary,
      ingredientRequirements: Object.values(ingredientRequirements),
      recentCompletions,
      recentCompletionsCount: recentCompletions.length
    });
  } catch (error) {
    console.error('Kitchen dashboard error:', error.message);
    res.status(500).json({ error: 'Failed to load kitchen dashboard' });
  }
});

module.exports = router;
