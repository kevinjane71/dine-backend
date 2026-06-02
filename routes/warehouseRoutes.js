const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const { requireOrgFeature, isRestaurantInOrg, requireOrgMember, getActorId } = require('../middleware/orgAccess');
const { getCachedRestDoc } = require('../utils/kvCache');

// ============================================
// CENTRAL WAREHOUSE + INDENT SYSTEM
// Mounted at /api/warehouse
// All endpoints require authenticateToken + org membership (manager+) + centralWarehouse feature
// ============================================

const commonMiddleware = [authenticateToken, requireOrgMember({ minRole: 'manager' }), requireOrgFeature('centralWarehouse')];

// -------------------------------------------------------
// Helper: Generate sequential indent number
// -------------------------------------------------------
async function generateIndentNumber(orgId) {
  const counterDocId = `${orgId}_indentCounter`;
  const counterRef = db.collection(collections.orgSettings).doc(counterDocId);

  const result = await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);
    let currentCount = 0;

    if (counterDoc.exists) {
      currentCount = counterDoc.data().count || 0;
    }

    const newCount = currentCount + 1;
    transaction.set(counterRef, { count: newCount, updatedAt: new Date() }, { merge: true });

    const year = new Date().getFullYear();
    const padded = String(newCount).padStart(4, '0');
    return `IND-${year}-${padded}`;
  });

  return result;
}

// -------------------------------------------------------
// 1. POST /:orgId/indents — Create indent request
// -------------------------------------------------------
router.post('/:orgId/indents', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const userId = getActorId(req);
    const { requestingOutletId, warehouseId, items, priority, deliveryNotes } = req.body;

    // Validate required fields
    if (!requestingOutletId || !warehouseId || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'requestingOutletId, warehouseId, and items are required' });
    }

    // Validate both outlets belong to org
    const [outletInOrg, warehouseInOrg] = await Promise.all([
      isRestaurantInOrg(orgId, requestingOutletId),
      isRestaurantInOrg(orgId, warehouseId)
    ]);

    if (!outletInOrg) {
      return res.status(400).json({ success: false, error: 'Requesting outlet does not belong to this organization' });
    }
    if (!warehouseInOrg) {
      return res.status(400).json({ success: false, error: 'Warehouse does not belong to this organization' });
    }

    // Validate warehouseId has outletType='warehouse'
    const warehouseDoc = await getCachedRestDoc(db, collections.restaurants, warehouseId);
    if (!warehouseDoc.exists || warehouseDoc.data().outletType !== 'warehouse') {
      return res.status(400).json({ success: false, error: 'Specified warehouseId is not a warehouse outlet' });
    }

    // Validate priority
    const validPriorities = ['low', 'medium', 'high', 'urgent'];
    const indentPriority = validPriorities.includes(priority) ? priority : 'medium';

    // Generate indent number
    const indentNumber = await generateIndentNumber(orgId);

    const now = new Date();
    const indentData = {
      organizationId: orgId,
      requestingOutletId,
      warehouseId,
      indentNumber,
      items: items.map(item => ({
        inventoryItemId: item.inventoryItemId || null,
        inventoryItemName: item.inventoryItemName || item.name || '',
        requestedQty: Number(item.requestedQty || item.quantity) || 0,
        approvedQty: null,
        pickedQty: null,
        receivedQty: null,
        unit: item.unit || 'pcs',
        notes: item.notes || ''
      })),
      priority: indentPriority,
      status: 'requested',
      requestedBy: userId,
      approvedBy: null,
      dispatchedBy: null,
      receivedBy: null,
      requestedAt: now,
      approvedAt: null,
      dispatchedAt: null,
      receivedAt: null,
      rejectionReason: null,
      deliveryNotes: deliveryNotes || '',
      createdAt: now,
      updatedAt: now
    };

    const docRef = await db.collection(collections.indentRequests).add(indentData);

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'INDENT_CREATED',
      entityType: 'indent',
      entityId: docRef.id,
      performedBy: userId,
      details: { indentNumber, requestingOutletId, warehouseId, itemCount: items.length, priority: indentPriority },
      createdAt: now
    });

    return res.status(201).json({
      success: true,
      indent: { id: docRef.id, ...indentData }
    });
  } catch (error) {
    console.error('Create indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to create indent request' });
  }
});

// -------------------------------------------------------
// 2. GET /:orgId/indents — List indents
// -------------------------------------------------------
router.get('/:orgId/indents', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { status, requestingOutletId, warehouseId, page, limit } = req.query;

    const pageSize = Math.min(parseInt(limit) || 50, 100);
    const pageNum = parseInt(page) || 1;

    let query = db.collection(collections.indentRequests)
      .where('organizationId', '==', orgId);

    if (status) {
      query = query.where('status', '==', status);
    }
    if (requestingOutletId) {
      query = query.where('requestingOutletId', '==', requestingOutletId);
    }
    if (warehouseId) {
      query = query.where('warehouseId', '==', warehouseId);
    }

    query = query.orderBy('createdAt', 'desc');

    // Pagination via offset (Firestore)
    const offset = (pageNum - 1) * pageSize;
    if (offset > 0) {
      query = query.offset(offset);
    }
    query = query.limit(pageSize);

    const snapshot = await query.get();
    const indents = [];
    snapshot.forEach(doc => {
      indents.push({ id: doc.id, ...doc.data() });
    });

    return res.json({
      success: true,
      indents,
      page: pageNum,
      limit: pageSize,
      count: indents.length
    });
  } catch (error) {
    console.error('List indents error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to list indent requests' });
  }
});

// -------------------------------------------------------
// 3. GET /:orgId/indents/:indentId — Get indent detail
// -------------------------------------------------------
router.get('/:orgId/indents/:indentId', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, indentId } = req.params;

    const doc = await db.collection(collections.indentRequests).doc(indentId).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Indent request not found' });
    }

    const indent = doc.data();
    if (indent.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Indent does not belong to this organization' });
    }

    return res.json({ success: true, indent: { id: doc.id, ...indent } });
  } catch (error) {
    console.error('Get indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to get indent request' });
  }
});

// -------------------------------------------------------
// 4. PATCH /:orgId/indents/:indentId/receive — Outlet confirms receipt
// -------------------------------------------------------
router.patch('/:orgId/indents/:indentId/receive', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, indentId } = req.params;
    const userId = getActorId(req);
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array with receivedQty is required' });
    }

    const indentDoc = await db.collection(collections.indentRequests).doc(indentId).get();
    if (!indentDoc.exists) {
      return res.status(404).json({ success: false, error: 'Indent request not found' });
    }

    const indent = indentDoc.data();
    if (indent.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Indent does not belong to this organization' });
    }

    if (!['dispatched', 'in_transit'].includes(indent.status)) {
      return res.status(400).json({ success: false, error: 'Indent can only be received when status is dispatched or in_transit' });
    }

    const now = new Date();
    const batch = db.batch();

    // Build a map of received items for quick lookup
    const receivedMap = {};
    for (let i = 0; i < items.length; i++) {
      const key = items[i].inventoryItemId || `_idx_${i}`;
      receivedMap[key] = Number(items[i].receivedQty) || 0;
    }

    // Update indent items with receivedQty
    const updatedItems = indent.items.map((item, idx) => {
      const key = item.inventoryItemId || `_idx_${idx}`;
      const receivedQty = receivedMap[key] !== undefined
        ? receivedMap[key]
        : item.receivedQty;
      return { ...item, receivedQty };
    });

    // For each received item, add stock to the requesting outlet's inventory
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const receivedQty = Number(item.receivedQty) || 0;
      if (receivedQty <= 0) continue;

      // Find the matching indent item for metadata
      const indentItem = item.inventoryItemId
        ? indent.items.find(ii => ii.inventoryItemId === item.inventoryItemId)
        : indent.items[i];
      if (!indentItem) continue;

      // Read current inventory for the outlet
      let invSnapshot;
      if (item.inventoryItemId) {
        invSnapshot = await db.collection(collections.inventory)
          .where('restaurantId', '==', indent.requestingOutletId)
          .where('inventoryItemId', '==', item.inventoryItemId)
          .limit(1)
          .get();
      } else {
        const itemName = item.inventoryItemName || indentItem.inventoryItemName || '';
        invSnapshot = await db.collection(collections.inventory)
          .where('restaurantId', '==', indent.requestingOutletId)
          .where('name', '==', itemName)
          .limit(1)
          .get();
      }

      let previousStock = 0;
      let invDocRef;

      if (!invSnapshot.empty) {
        const invDoc = invSnapshot.docs[0];
        previousStock = invDoc.data().currentStock || 0;
        invDocRef = invDoc.ref;
        batch.update(invDocRef, {
          currentStock: previousStock + receivedQty,
          updatedAt: now
        });
      } else {
        // Create new inventory entry if it doesn't exist
        invDocRef = db.collection(collections.inventory).doc();
        batch.set(invDocRef, {
          restaurantId: indent.requestingOutletId,
          inventoryItemId: item.inventoryItemId || null,
          name: indentItem.inventoryItemName || '',
          inventoryItemName: indentItem.inventoryItemName || '',
          currentStock: receivedQty,
          unit: indentItem.unit,
          createdAt: now,
          updatedAt: now
        });
      }

      const newStock = previousStock + receivedQty;

      // Create inventoryTransaction
      const txnRef = db.collection(collections.inventoryTransactions).doc();
      batch.set(txnRef, {
        restaurantId: indent.requestingOutletId,
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: indentItem.inventoryItemName,
        type: 'ADDITION',
        source: 'INDENT_RECEIVED',
        quantityChange: receivedQty,
        previousStock,
        newStock,
        unit: indentItem.unit,
        performedBy: userId,
        notes: `Received from indent ${indent.indentNumber}`,
        referenceId: indentId,
        date: now
      });

      // Create stockBatch entry for traceability
      const batchRef = db.collection(collections.stockBatches).doc();
      batch.set(batchRef, {
        restaurantId: indent.requestingOutletId,
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: indentItem.inventoryItemName,
        quantity: receivedQty,
        unit: indentItem.unit,
        source: 'INDENT_RECEIVED',
        referenceId: indentId,
        indentNumber: indent.indentNumber,
        receivedBy: userId,
        createdAt: now
      });
    }

    // Update indent status
    const indentRef = db.collection(collections.indentRequests).doc(indentId);
    batch.update(indentRef, {
      items: updatedItems,
      status: 'received',
      receivedBy: userId,
      receivedAt: now,
      updatedAt: now
    });

    await batch.commit();

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'INDENT_RECEIVED',
      entityType: 'indent',
      entityId: indentId,
      performedBy: userId,
      details: { indentNumber: indent.indentNumber, itemCount: items.length },
      createdAt: now
    });

    return res.json({
      success: true,
      message: 'Indent received successfully',
      indent: { id: indentId, ...indent, items: updatedItems, status: 'received', receivedBy: userId, receivedAt: now, updatedAt: now }
    });
  } catch (error) {
    console.error('Receive indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to receive indent' });
  }
});

// -------------------------------------------------------
// 5. DELETE /:orgId/indents/:indentId — Cancel indent (only if status='requested')
// -------------------------------------------------------
router.delete('/:orgId/indents/:indentId', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, indentId } = req.params;
    const userId = getActorId(req);

    const indentDoc = await db.collection(collections.indentRequests).doc(indentId).get();
    if (!indentDoc.exists) {
      return res.status(404).json({ success: false, error: 'Indent request not found' });
    }

    const indent = indentDoc.data();
    if (indent.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Indent does not belong to this organization' });
    }

    if (indent.status !== 'requested') {
      return res.status(400).json({ success: false, error: 'Only indents with status "requested" can be cancelled' });
    }

    const now = new Date();
    await db.collection(collections.indentRequests).doc(indentId).update({
      status: 'cancelled',
      updatedAt: now
    });

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'INDENT_CANCELLED',
      entityType: 'indent',
      entityId: indentId,
      performedBy: userId,
      details: { indentNumber: indent.indentNumber },
      createdAt: now
    });

    return res.json({ success: true, message: 'Indent cancelled successfully' });
  } catch (error) {
    console.error('Cancel indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to cancel indent' });
  }
});

// -------------------------------------------------------
// 6. PATCH /:orgId/indents/:indentId/approve — Approve indent
// -------------------------------------------------------
router.patch('/:orgId/indents/:indentId/approve', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, indentId } = req.params;
    const userId = getActorId(req);
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array with approvedQty is required' });
    }

    const indentDoc = await db.collection(collections.indentRequests).doc(indentId).get();
    if (!indentDoc.exists) {
      return res.status(404).json({ success: false, error: 'Indent request not found' });
    }

    const indent = indentDoc.data();
    if (indent.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Indent does not belong to this organization' });
    }

    if (indent.status !== 'requested') {
      return res.status(400).json({ success: false, error: 'Only indents with status "requested" can be approved' });
    }

    // Build approved qty map
    const approvedMap = {};
    for (const item of items) {
      approvedMap[item.inventoryItemId] = Number(item.approvedQty) || 0;
    }

    const updatedItems = indent.items.map(item => {
      const approvedQty = approvedMap[item.inventoryItemId] !== undefined
        ? approvedMap[item.inventoryItemId]
        : item.approvedQty;
      return { ...item, approvedQty };
    });

    const now = new Date();
    await db.collection(collections.indentRequests).doc(indentId).update({
      items: updatedItems,
      status: 'approved',
      approvedBy: userId,
      approvedAt: now,
      updatedAt: now
    });

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'INDENT_APPROVED',
      entityType: 'indent',
      entityId: indentId,
      performedBy: userId,
      details: { indentNumber: indent.indentNumber },
      createdAt: now
    });

    return res.json({
      success: true,
      message: 'Indent approved successfully',
      indent: { id: indentId, ...indent, items: updatedItems, status: 'approved', approvedBy: userId, approvedAt: now, updatedAt: now }
    });
  } catch (error) {
    console.error('Approve indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to approve indent' });
  }
});

// -------------------------------------------------------
// 7. PATCH /:orgId/indents/:indentId/reject — Reject indent
// -------------------------------------------------------
router.patch('/:orgId/indents/:indentId/reject', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, indentId } = req.params;
    const userId = getActorId(req);
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, error: 'Rejection reason is required' });
    }

    const indentDoc = await db.collection(collections.indentRequests).doc(indentId).get();
    if (!indentDoc.exists) {
      return res.status(404).json({ success: false, error: 'Indent request not found' });
    }

    const indent = indentDoc.data();
    if (indent.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Indent does not belong to this organization' });
    }

    if (indent.status !== 'requested') {
      return res.status(400).json({ success: false, error: 'Only indents with status "requested" can be rejected' });
    }

    const now = new Date();
    await db.collection(collections.indentRequests).doc(indentId).update({
      status: 'rejected',
      rejectionReason: reason.trim(),
      updatedAt: now
    });

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'INDENT_REJECTED',
      entityType: 'indent',
      entityId: indentId,
      performedBy: userId,
      details: { indentNumber: indent.indentNumber, reason: reason.trim() },
      createdAt: now
    });

    return res.json({ success: true, message: 'Indent rejected successfully' });
  } catch (error) {
    console.error('Reject indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to reject indent' });
  }
});

// -------------------------------------------------------
// 8. PATCH /:orgId/indents/:indentId/pick — Mark as picking
// -------------------------------------------------------
router.patch('/:orgId/indents/:indentId/pick', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, indentId } = req.params;
    const userId = getActorId(req);

    const indentDoc = await db.collection(collections.indentRequests).doc(indentId).get();
    if (!indentDoc.exists) {
      return res.status(404).json({ success: false, error: 'Indent request not found' });
    }

    const indent = indentDoc.data();
    if (indent.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Indent does not belong to this organization' });
    }

    if (indent.status !== 'approved') {
      return res.status(400).json({ success: false, error: 'Only approved indents can be marked as picking' });
    }

    const now = new Date();
    await db.collection(collections.indentRequests).doc(indentId).update({
      status: 'picking',
      updatedAt: now
    });

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'INDENT_PICKING',
      entityType: 'indent',
      entityId: indentId,
      performedBy: userId,
      details: { indentNumber: indent.indentNumber },
      createdAt: now
    });

    return res.json({ success: true, message: 'Indent marked as picking' });
  } catch (error) {
    console.error('Pick indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to update indent status' });
  }
});

// -------------------------------------------------------
// 9. PATCH /:orgId/indents/:indentId/dispatch — Dispatch to outlet
// -------------------------------------------------------
router.patch('/:orgId/indents/:indentId/dispatch', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, indentId } = req.params;
    const userId = getActorId(req);
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'items array with pickedQty is required' });
    }

    const indentDoc = await db.collection(collections.indentRequests).doc(indentId).get();
    if (!indentDoc.exists) {
      return res.status(404).json({ success: false, error: 'Indent request not found' });
    }

    const indent = indentDoc.data();
    if (indent.organizationId !== orgId) {
      return res.status(403).json({ success: false, error: 'Indent does not belong to this organization' });
    }

    if (!['approved', 'picking'].includes(indent.status)) {
      return res.status(400).json({ success: false, error: 'Only approved or picking indents can be dispatched' });
    }

    const now = new Date();
    const firestoreBatch = db.batch();

    // Build picked qty map (by inventoryItemId or by index as fallback)
    const pickedMap = {};
    for (let i = 0; i < items.length; i++) {
      const key = items[i].inventoryItemId || `_idx_${i}`;
      pickedMap[key] = Number(items[i].pickedQty) || 0;
    }

    // Update indent items with pickedQty
    const updatedItems = indent.items.map((item, idx) => {
      const key = item.inventoryItemId || `_idx_${idx}`;
      const pickedQty = pickedMap[key] !== undefined
        ? pickedMap[key]
        : item.pickedQty;
      return { ...item, pickedQty };
    });

    // For each item, deduct pickedQty from warehouse inventory
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const pickedQty = Number(item.pickedQty) || 0;
      if (pickedQty <= 0) continue;

      // Find the matching indent item for metadata
      const indentItem = item.inventoryItemId
        ? indent.items.find(ii => ii.inventoryItemId === item.inventoryItemId)
        : indent.items[i];
      if (!indentItem) continue;

      // Read current warehouse inventory — match by inventoryItemId or by name
      let invSnapshot;
      if (item.inventoryItemId) {
        invSnapshot = await db.collection(collections.inventory)
          .where('restaurantId', '==', indent.warehouseId)
          .where('inventoryItemId', '==', item.inventoryItemId)
          .limit(1)
          .get();
      } else {
        // Fallback: match by item name in warehouse inventory
        const itemName = item.inventoryItemName || indentItem.inventoryItemName || '';
        invSnapshot = await db.collection(collections.inventory)
          .where('restaurantId', '==', indent.warehouseId)
          .where('name', '==', itemName)
          .limit(1)
          .get();
      }

      if (invSnapshot.empty) {
        return res.status(400).json({
          success: false,
          error: `Inventory item ${indentItem.inventoryItemName || item.inventoryItemId} not found in warehouse stock`
        });
      }

      const invDoc = invSnapshot.docs[0];
      const previousStock = invDoc.data().currentStock || 0;

      if (previousStock < pickedQty) {
        return res.status(400).json({
          success: false,
          error: `Insufficient warehouse stock for ${indentItem.inventoryItemName || item.inventoryItemId}. Available: ${previousStock}, Requested: ${pickedQty}`
        });
      }

      const newStock = previousStock - pickedQty;

      firestoreBatch.update(invDoc.ref, {
        currentStock: newStock,
        updatedAt: now
      });

      // Create inventoryTransaction for deduction
      const txnRef = db.collection(collections.inventoryTransactions).doc();
      firestoreBatch.set(txnRef, {
        restaurantId: indent.warehouseId,
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: indentItem.inventoryItemName,
        type: 'DEDUCTION',
        source: 'INDENT_DISPATCH',
        quantityChange: -pickedQty,
        previousStock,
        newStock,
        unit: indentItem.unit,
        performedBy: userId,
        notes: `Dispatched for indent ${indent.indentNumber}`,
        referenceId: indentId,
        date: now
      });
    }

    // Update indent status
    const indentRef = db.collection(collections.indentRequests).doc(indentId);
    firestoreBatch.update(indentRef, {
      items: updatedItems,
      status: 'dispatched',
      dispatchedBy: userId,
      dispatchedAt: now,
      updatedAt: now
    });

    await firestoreBatch.commit();

    // Audit log
    await db.collection(collections.orgAuditLog).add({
      organizationId: orgId,
      action: 'INDENT_DISPATCHED',
      entityType: 'indent',
      entityId: indentId,
      performedBy: userId,
      details: { indentNumber: indent.indentNumber, itemCount: items.length },
      createdAt: now
    });

    return res.json({
      success: true,
      message: 'Indent dispatched successfully',
      indent: { id: indentId, ...indent, items: updatedItems, status: 'dispatched', dispatchedBy: userId, dispatchedAt: now, updatedAt: now }
    });
  } catch (error) {
    console.error('Dispatch indent error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to dispatch indent' });
  }
});

// -------------------------------------------------------
// 10. GET /:orgId/warehouse/:warehouseId/stock — Get warehouse stock levels
// -------------------------------------------------------
router.get('/:orgId/warehouse/:warehouseId/stock', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, warehouseId } = req.params;

    // Verify warehouse belongs to org
    const inOrg = await isRestaurantInOrg(orgId, warehouseId);
    if (!inOrg) {
      return res.status(400).json({ success: false, error: 'Warehouse does not belong to this organization' });
    }

    // Verify it's actually a warehouse
    const warehouseDoc = await getCachedRestDoc(db, collections.restaurants, warehouseId);
    if (!warehouseDoc.exists || warehouseDoc.data().outletType !== 'warehouse') {
      return res.status(400).json({ success: false, error: 'Specified outlet is not a warehouse' });
    }

    const snapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', warehouseId)
      .get();

    const stockItems = [];
    snapshot.forEach(doc => {
      stockItems.push({ id: doc.id, ...doc.data() });
    });

    return res.json({
      success: true,
      warehouseId,
      warehouseName: warehouseDoc.data().name,
      stock: stockItems,
      count: stockItems.length
    });
  } catch (error) {
    console.error('Get warehouse stock error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to get warehouse stock' });
  }
});

// -------------------------------------------------------
// 11. GET /:orgId/warehouse/:warehouseId/pending — Pending indents dashboard
// -------------------------------------------------------
router.get('/:orgId/warehouse/:warehouseId/pending', ...commonMiddleware, async (req, res) => {
  try {
    const { orgId, warehouseId } = req.params;

    // Verify warehouse belongs to org
    const inOrg = await isRestaurantInOrg(orgId, warehouseId);
    if (!inOrg) {
      return res.status(400).json({ success: false, error: 'Warehouse does not belong to this organization' });
    }

    const snapshot = await db.collection(collections.indentRequests)
      .where('organizationId', '==', orgId)
      .where('warehouseId', '==', warehouseId)
      .where('status', 'in', ['requested', 'approved', 'picking'])
      .orderBy('createdAt', 'desc')
      .get();

    const indents = [];
    const summary = { requested: 0, approved: 0, picking: 0, totalItemsPending: 0 };

    snapshot.forEach(doc => {
      const data = doc.data();
      indents.push({ id: doc.id, ...data });

      // Count by status
      if (summary[data.status] !== undefined) {
        summary[data.status]++;
      }

      // Count total items pending
      if (data.items && Array.isArray(data.items)) {
        summary.totalItemsPending += data.items.length;
      }
    });

    return res.json({
      success: true,
      warehouseId,
      indents,
      summary,
      count: indents.length
    });
  } catch (error) {
    console.error('Get pending indents error:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to get pending indents' });
  }
});

module.exports = router;
