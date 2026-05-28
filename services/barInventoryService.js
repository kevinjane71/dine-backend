const { db, collections } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

/**
 * Bar Inventory Service
 * Tracks individual bottles: weight, pours, wastage, daily reconciliation
 */

// Generate unique ID
function genId(prefix = 'bb') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register a new bottle in bar inventory
 */
async function registerBottle(restaurantId, data, userId) {
  const id = genId('bb');
  const now = new Date();

  const bottle = {
    id,
    restaurantId,
    inventoryItemId: data.inventoryItemId || null,
    menuItemId: data.menuItemId || null,
    barcode: data.barcode || null,
    name: data.name,
    brand: data.brand || null,
    category: data.category || null,
    categoryId: data.categoryId || null,

    // Bottle specs
    bottleSize: Number(data.bottleSize) || 750,        // ml
    pegSize: Number(data.pegSize) || 60,                // ml per pour

    // Weight tracking (grams)
    fullWeight: Number(data.fullWeight) || 0,
    tareWeight: Number(data.tareWeight) || 0,
    openingWeight: 0,
    currentWeight: Number(data.fullWeight) || 0,
    closingWeight: null,

    // Status
    status: 'sealed',
    openedAt: null,
    openedBy: null,
    emptyAt: null,

    // Pour tracking
    totalPegsExpected: data.bottleSize && data.pegSize ? Math.floor(Number(data.bottleSize) / Number(data.pegSize)) : 0,
    totalPegsPoured: 0,
    totalMlPoured: 0,       // from weight measurements
    totalMlSold: 0,         // from POS orders

    // Wastage
    wastage: 0,
    wastageEntries: [],

    // Batch/cost
    batchId: data.batchId || null,
    costPrice: Number(data.costPrice) || 0,

    createdAt: now,
    updatedAt: now,
    createdBy: userId
  };

  await db.collection('barBottles').doc(id).set(bottle);
  return bottle;
}

/**
 * Open a sealed bottle (set opening weight, change status)
 */
async function openBottle(bottleId, openingWeight, userId) {
  const ref = db.collection('barBottles').doc(bottleId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Bottle not found');

  const bottle = doc.data();
  if (bottle.status !== 'sealed') {
    throw new Error(`Cannot open bottle with status: ${bottle.status}`);
  }

  const now = new Date();
  const update = {
    status: 'opened',
    openingWeight: Number(openingWeight),
    currentWeight: Number(openingWeight),
    openedAt: now,
    openedBy: userId,
    updatedAt: now
  };

  await ref.update(update);
  return { ...bottle, ...update };
}

/**
 * Record a pour from POS order (called during order deduction)
 */
async function recordPour(bottleId, mlPoured, orderId) {
  const ref = db.collection('barBottles').doc(bottleId);

  await ref.update({
    totalMlSold: FieldValue.increment(mlPoured),
    totalPegsPoured: FieldValue.increment(1),
    updatedAt: new Date()
  });
}

/**
 * Update bottle weight (manual weigh-in)
 */
async function updateWeight(bottleId, newWeight, userId) {
  const ref = db.collection('barBottles').doc(bottleId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Bottle not found');

  const bottle = doc.data();
  const weightDiff = bottle.currentWeight - newWeight;
  const mlConsumed = weightDiff > 0 ? weightDiff * (bottle.mlPerGram || 1.0) : 0;

  const update = {
    currentWeight: Number(newWeight),
    totalMlPoured: FieldValue.increment(mlConsumed),
    updatedAt: new Date()
  };

  // Auto-mark empty if weight <= tare weight
  if (newWeight <= (bottle.tareWeight || 0) + 10) { // 10g tolerance
    update.status = 'empty';
    update.emptyAt = new Date();
    update.closingWeight = Number(newWeight);
  }

  await ref.update(update);
  return { mlConsumed, newWeight, status: update.status || bottle.status };
}

/**
 * Record wastage/spillage
 */
async function recordWastage(bottleId, data, userId) {
  const ref = db.collection('barBottles').doc(bottleId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Bottle not found');

  const entry = {
    quantity: Number(data.quantity),       // ml wasted
    reason: data.reason || 'spillage',     // spillage, overpouring, breakage, other
    recordedBy: userId,
    recordedAt: new Date(),
    notes: data.notes || null
  };

  await ref.update({
    wastage: FieldValue.increment(entry.quantity),
    wastageEntries: FieldValue.arrayUnion(entry),
    updatedAt: new Date()
  });

  return entry;
}

/**
 * Close/empty a bottle
 */
async function closeBottle(bottleId, closingWeight, userId) {
  const ref = db.collection('barBottles').doc(bottleId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Bottle not found');

  const bottle = doc.data();
  const now = new Date();

  // Calculate total ml consumed from weight
  const liquidWeight = (bottle.openingWeight || bottle.fullWeight) - Number(closingWeight);
  const mlConsumed = Math.max(0, liquidWeight); // approx 1g ≈ 1ml for spirits

  await ref.update({
    status: 'empty',
    closingWeight: Number(closingWeight),
    currentWeight: Number(closingWeight),
    totalMlPoured: mlConsumed,
    emptyAt: now,
    updatedAt: now
  });

  return {
    mlConsumed,
    mlSold: bottle.totalMlSold || 0,
    variance: mlConsumed - (bottle.totalMlSold || 0),
    variancePercent: bottle.totalMlSold > 0
      ? ((mlConsumed - bottle.totalMlSold) / bottle.totalMlSold * 100).toFixed(1)
      : 0
  };
}

/**
 * Get bottles by status for a restaurant
 */
async function getBottles(restaurantId, { status, categoryId, limit: queryLimit = 100 } = {}) {
  let query = db.collection('barBottles')
    .where('restaurantId', '==', restaurantId);

  if (status) {
    query = query.where('status', '==', status);
  }
  if (categoryId) {
    query = query.where('categoryId', '==', categoryId);
  }

  const snap = await query.orderBy('updatedAt', 'desc').limit(queryLimit).get();
  return snap.docs.map(d => d.data());
}

/**
 * Get a single bottle
 */
async function getBottle(bottleId) {
  const doc = await db.collection('barBottles').doc(bottleId).get();
  if (!doc.exists) return null;
  return doc.data();
}

/**
 * Delete / discard a bottle
 */
async function deleteBottle(bottleId) {
  await db.collection('barBottles').doc(bottleId).delete();
}

/**
 * Get pour accuracy for a bottle
 */
async function getPourAccuracy(bottleId) {
  const bottle = await getBottle(bottleId);
  if (!bottle) throw new Error('Bottle not found');

  const expectedMl = bottle.totalPegsPoured * bottle.pegSize;
  const actualMl = bottle.totalMlPoured;
  const variance = actualMl - expectedMl;

  return {
    bottleId,
    name: bottle.name,
    pegsPoured: bottle.totalPegsPoured,
    expectedMl,
    actualMl,
    variance,
    variancePercent: expectedMl > 0 ? ((variance / expectedMl) * 100).toFixed(1) : 0,
    wastage: bottle.wastage,
    status: bottle.status
  };
}

/**
 * Deduct bar inventory for an order
 * Called by inventoryService after standard deduction for tracked categories
 */
async function deductBarInventoryForOrder(restaurantId, orderId, orderItems, trackedCategoryIds) {
  if (!trackedCategoryIds || trackedCategoryIds.length === 0) return [];

  const deductions = [];

  for (const item of orderItems) {
    const catId = item.categoryId || item.category;
    if (!trackedCategoryIds.includes(catId)) continue;

    // Find an open bottle matching this item
    let bottleQuery = db.collection('barBottles')
      .where('restaurantId', '==', restaurantId)
      .where('status', 'in', ['opened', 'in-use']);

    // Try to match by menuItemId first, then by inventoryItemId, then by name
    const snap = await bottleQuery.get();
    let matchedBottle = null;

    for (const doc of snap.docs) {
      const b = doc.data();
      if (item.menuItemId && b.menuItemId === item.menuItemId) {
        matchedBottle = b;
        break;
      }
      if (b.name && item.name && b.name.toLowerCase().includes(item.name.toLowerCase())) {
        matchedBottle = b;
        break;
      }
    }

    if (!matchedBottle) continue;

    // Calculate ml poured based on item quantity and peg size
    const quantity = item.quantity || 1;
    const mlPoured = quantity * (matchedBottle.pegSize || 60);

    await recordPour(matchedBottle.id, mlPoured, orderId);
    deductions.push({
      bottleId: matchedBottle.id,
      bottleName: matchedBottle.name,
      mlPoured,
      quantity
    });
  }

  return deductions;
}

// ===== RECONCILIATION =====

/**
 * Open a daily reconciliation session
 */
async function openReconciliation(restaurantId, data, userId) {
  const id = genId('br');
  const now = new Date();
  const date = data.date || now.toISOString().split('T')[0];

  // Get all open/in-use bottles
  const bottles = await getBottles(restaurantId, { status: 'opened' });
  const inUseBottles = await getBottles(restaurantId, { status: 'in-use' });
  const allOpen = [...bottles, ...inUseBottles];

  const openingSnapshot = allOpen.map(b => ({
    bottleId: b.id,
    inventoryItemId: b.inventoryItemId,
    name: b.name,
    openingWeight: b.currentWeight,
    status: b.status
  }));

  const reconciliation = {
    id,
    restaurantId,
    date,
    shift: data.shift || null,
    status: 'open',
    openingSnapshot,
    closingSnapshot: null,
    totalMlConsumed: null,
    totalMlSold: null,
    totalVariance: null,
    totalVarianceValue: null,
    openedAt: now,
    openedBy: userId,
    closedAt: null,
    closedBy: null,
    notes: data.notes || null,
    createdAt: now
  };

  await db.collection('barReconciliation').doc(id).set(reconciliation);
  return reconciliation;
}

/**
 * Close a reconciliation session with closing weights
 */
async function closeReconciliation(reconciliationId, closingData, userId) {
  const ref = db.collection('barReconciliation').doc(reconciliationId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error('Reconciliation not found');

  const recon = doc.data();
  if (recon.status !== 'open') {
    throw new Error('Reconciliation is already closed');
  }

  // closingData.bottles: [{ bottleId, closingWeight }]
  const closingSnapshot = [];
  let totalMlConsumed = 0;
  let totalMlSold = 0;
  let totalVarianceValue = 0;

  for (const entry of (closingData.bottles || [])) {
    const openEntry = recon.openingSnapshot.find(o => o.bottleId === entry.bottleId);
    if (!openEntry) continue;

    const bottle = await getBottle(entry.bottleId);
    if (!bottle) continue;

    const closingWeight = Number(entry.closingWeight);
    const mlConsumed = Math.max(0, openEntry.openingWeight - closingWeight);
    const mlSold = bottle.totalMlSold || 0;
    const variance = mlConsumed - mlSold;
    const variancePercent = mlSold > 0 ? ((variance / mlSold) * 100) : 0;

    closingSnapshot.push({
      bottleId: entry.bottleId,
      inventoryItemId: bottle.inventoryItemId,
      name: bottle.name,
      closingWeight,
      mlConsumed: Math.round(mlConsumed * 10) / 10,
      mlSold: Math.round(mlSold * 10) / 10,
      variance: Math.round(variance * 10) / 10,
      variancePercent: Math.round(variancePercent * 10) / 10
    });

    totalMlConsumed += mlConsumed;
    totalMlSold += mlSold;

    // Calculate monetary variance
    if (bottle.costPrice && bottle.bottleSize) {
      const costPerMl = bottle.costPrice / bottle.bottleSize;
      totalVarianceValue += Math.abs(variance) * costPerMl;
    }

    // Update bottle's current weight
    await db.collection('barBottles').doc(entry.bottleId).update({
      currentWeight: closingWeight,
      closingWeight,
      updatedAt: new Date()
    });
  }

  const now = new Date();
  const update = {
    status: 'closed',
    closingSnapshot,
    totalMlConsumed: Math.round(totalMlConsumed * 10) / 10,
    totalMlSold: Math.round(totalMlSold * 10) / 10,
    totalVariance: Math.round((totalMlConsumed - totalMlSold) * 10) / 10,
    totalVarianceValue: Math.round(totalVarianceValue * 100) / 100,
    closedAt: now,
    closedBy: userId,
    notes: closingData.notes || recon.notes
  };

  await ref.update(update);
  return { ...recon, ...update };
}

/**
 * Get reconciliation records
 */
async function getReconciliations(restaurantId, { limit: queryLimit = 30 } = {}) {
  const snap = await db.collection('barReconciliation')
    .where('restaurantId', '==', restaurantId)
    .orderBy('createdAt', 'desc')
    .limit(queryLimit)
    .get();
  return snap.docs.map(d => d.data());
}

/**
 * Get a single reconciliation
 */
async function getReconciliation(reconciliationId) {
  const doc = await db.collection('barReconciliation').doc(reconciliationId).get();
  if (!doc.exists) return null;
  return doc.data();
}

module.exports = {
  registerBottle,
  openBottle,
  recordPour,
  updateWeight,
  recordWastage,
  closeBottle,
  getBottles,
  getBottle,
  deleteBottle,
  getPourAccuracy,
  deductBarInventoryForOrder,
  openReconciliation,
  closeReconciliation,
  getReconciliations,
  getReconciliation
};
