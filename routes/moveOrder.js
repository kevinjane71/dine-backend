const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
// const pusherService = require('../services/pusherService'); // COMMENTED OUT — replaced by Firebase RTDB
const pusherService = require('../services/firebaseRealtimeService');

// ==========================================
// Move Order to Another Table
// ==========================================
router.post('/:orderId/move-table', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { targetTableId, targetTableName, targetFloorId, targetFloorName, restaurantId } = req.body;

    if (!targetTableId || !targetTableName) {
      return res.status(400).json({ error: 'Target table ID and name are required.' });
    }

    // 1. Get the order
    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });
    const order = orderDoc.data();

    // Validate restaurant access
    const user = req.user;
    const userRestaurantId = user.restaurantId || restaurantId || order.restaurantId;
    if (order.restaurantId !== userRestaurantId && user.role !== 'admin' && user.role !== 'owner') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Don't move completed/cancelled orders
    if (order.status === 'completed' || order.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot move completed or cancelled orders.' });
    }

    // 2. Verify target table exists and is available
    const rid = order.restaurantId;
    const floorsSnapshot = await db.collection('restaurants').doc(rid).collection('floors').get();

    let targetTableDoc = null;
    let targetTableFloorDocId = null;

    // Fast path: use targetFloorId directly
    if (targetFloorId) {
      const tDoc = await db.collection('restaurants').doc(rid)
        .collection('floors').doc(targetFloorId)
        .collection('tables').doc(targetTableId).get();
      if (tDoc.exists) {
        targetTableDoc = tDoc;
        targetTableFloorDocId = targetFloorId;
      }
    }

    // Fallback: iterate floors
    if (!targetTableDoc) {
      for (const floorDoc of floorsSnapshot.docs) {
        const tDoc = await db.collection('restaurants').doc(rid)
          .collection('floors').doc(floorDoc.id)
          .collection('tables').doc(targetTableId).get();
        if (tDoc.exists) {
          targetTableDoc = tDoc;
          targetTableFloorDocId = floorDoc.id;
          break;
        }
      }
    }

    if (!targetTableDoc) {
      return res.status(400).json({ error: 'Target table not found.' });
    }

    const targetTableData = targetTableDoc.data();
    if (targetTableData.status !== 'available') {
      return res.status(400).json({ error: `Table "${targetTableName}" is currently ${targetTableData.status}. Please choose an available table.` });
    }

    // 3. Update order with new table info
    const oldTableId = order.tableId || null;
    const oldFloorId = order.floorId || null;
    const oldTableNumber = order.tableNumber || null;

    await db.collection(collections.orders).doc(orderId).update({
      tableNumber: targetTableName,
      tableId: targetTableId,
      floorId: targetFloorId || targetTableFloorDocId || null,
      floorName: targetFloorName || null,
      updatedAt: new Date(),
    });

    // Also update customerInfo.tableNumber if present
    if (order.customerInfo) {
      await db.collection(collections.orders).doc(orderId).update({
        'customerInfo.tableNumber': targetTableName,
        'customerInfo.floorName': targetFloorName || null,
      });
    }

    // 4. Release old table → available
    if (oldTableId) {
      let released = false;
      // Fast path
      if (oldFloorId) {
        const oldDoc = await db.collection('restaurants').doc(rid)
          .collection('floors').doc(oldFloorId)
          .collection('tables').doc(oldTableId).get();
        if (oldDoc.exists) {
          await oldDoc.ref.update({ status: 'available', currentOrderId: null, updatedAt: new Date() });
          released = true;
        }
      }
      // Fallback: iterate
      if (!released) {
        for (const floorDoc of floorsSnapshot.docs) {
          const oldDoc = await db.collection('restaurants').doc(rid)
            .collection('floors').doc(floorDoc.id)
            .collection('tables').doc(oldTableId).get();
          if (oldDoc.exists) {
            await oldDoc.ref.update({ status: 'available', currentOrderId: null, updatedAt: new Date() });
            break;
          }
        }
      }
    } else if (oldTableNumber) {
      // Legacy: no tableId, find by name
      for (const floorDoc of floorsSnapshot.docs) {
        const snap = await db.collection('restaurants').doc(rid)
          .collection('floors').doc(floorDoc.id)
          .collection('tables').where('name', '==', oldTableNumber.trim()).get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({ status: 'available', currentOrderId: null, updatedAt: new Date() });
          break;
        }
      }
    }

    // 5. Occupy new table
    await targetTableDoc.ref.update({
      status: 'occupied',
      currentOrderId: orderId,
      lastOrderTime: new Date(),
      updatedAt: new Date(),
    });

    // 6. Real-time events for table sync (Firebase RTDB)
    if (oldTableId) {
      pusherService.triggerTableStatusUpdated(rid, {
        tableId: oldTableId, status: 'available', orderId: null, tableNumber: oldTableNumber,
      }).catch(err => console.error('RTDB error (old table):', err));
    }
    pusherService.triggerTableStatusUpdated(rid, {
      tableId: targetTableId, status: 'occupied', orderId, tableNumber: targetTableName,
    }).catch(err => console.error('RTDB error (new table):', err));

    // Notify order update
    pusherService.notifyOrderUpdated(rid, orderId, {
      status: order.status,
      tableNumber: targetTableName,
      orderNumber: order.orderNumber,
      dailyOrderId: order.dailyOrderId,
    }).catch(err => console.error('Pusher order update error:', err));

    console.log(`Order ${orderId} moved from table "${oldTableNumber}" to "${targetTableName}"`);
    res.json({ success: true, message: 'Order moved successfully', orderId, targetTableId, targetTableName });

  } catch (error) {
    console.error('Move order error:', error);
    res.status(500).json({ error: 'Failed to move order' });
  }
});

module.exports = router;
