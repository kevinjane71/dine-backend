const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');

// ============================================
// PARKING LOT MANAGEMENT APIs
// Full parking management: config, zones, slots, rates, tickets
// Entry/exit flow, QR codes, AI plate recognition, printing
// ============================================

function getOwnerId(req) {
  return req.user.role === 'admin' ? req.user.ownerId : (req.user.userId || req.user.id);
}

function getActorId(req) {
  return req.user.userId || req.user.id;
}

function getActorName(req) {
  return req.user.name || req.user.email || 'Unknown';
}

// All routes require auth
router.use(authenticateToken);

// ──────────────────────────────────────────────
// CONFIGURATION
// ──────────────────────────────────────────────

// GET /config/:restaurantId — Get parking config
router.get('/config/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const doc = await db.collection(collections.parkingConfigs).doc(restaurantId).get();

    if (!doc.exists) {
      return res.json({
        success: true,
        config: null,
        message: 'No parking config found. Create one to get started.'
      });
    }

    res.json({ success: true, config: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error('Error fetching parking config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /config/:restaurantId — Create/update parking config
router.put('/config/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const ownerId = getOwnerId(req);
    const {
      lotName, lotNameAr, address, addressAr, totalCapacity,
      operatingHours, timezone, currency, vehicleTypes,
      ticketPrefix, slotTrackingMode, enableLicensePlateAI,
      enableVehiclePhoto, printLanguage, receiptHeader, receiptHeaderAr,
      receiptFooter, receiptFooterAr, logo
    } = req.body;

    const configData = {
      restaurantId,
      ownerId,
      lotName: lotName || '',
      lotNameAr: lotNameAr || '',
      address: address || '',
      addressAr: addressAr || '',
      totalCapacity: totalCapacity || 0,
      operatingHours: operatingHours || { start: '00:00', end: '23:59' },
      timezone: timezone || 'Asia/Dubai',
      currency: currency || 'AED',
      vehicleTypes: vehicleTypes || [
        { id: 'car', label: 'Car', labelAr: 'سيارة', icon: 'car', enabled: true },
        { id: 'suv', label: 'SUV', labelAr: 'دفع رباعي', icon: 'car', enabled: true },
        { id: 'bike', label: 'Motorcycle', labelAr: 'دراجة نارية', icon: 'bike', enabled: true },
        { id: 'truck', label: 'Truck', labelAr: 'شاحنة', icon: 'truck', enabled: true },
        { id: 'bus', label: 'Bus', labelAr: 'حافلة', icon: 'bus', enabled: false },
      ],
      ticketPrefix: ticketPrefix || 'PKT',
      ticketSequence: 0,
      slotTrackingMode: slotTrackingMode || 'zone_capacity',
      enableLicensePlateAI: enableLicensePlateAI ?? true,
      enableVehiclePhoto: enableVehiclePhoto ?? true,
      printLanguage: printLanguage || 'dual',
      receiptHeader: receiptHeader || '',
      receiptHeaderAr: receiptHeaderAr || '',
      receiptFooter: receiptFooter || '',
      receiptFooterAr: receiptFooterAr || '',
      logo: logo || '',
      valetEnabled: false,
      valetSettings: {},
      policies: [],
      updatedAt: FieldValue.serverTimestamp()
    };

    const existing = await db.collection(collections.parkingConfigs).doc(restaurantId).get();
    if (!existing.exists) {
      configData.createdAt = FieldValue.serverTimestamp();
    } else {
      // Preserve existing sequence and createdAt
      const existingData = existing.data();
      configData.ticketSequence = existingData.ticketSequence || 0;
      configData.createdAt = existingData.createdAt;
    }

    await db.collection(collections.parkingConfigs).doc(restaurantId).set(configData, { merge: true });

    res.json({ success: true, config: { id: restaurantId, ...configData } });
  } catch (error) {
    console.error('Error saving parking config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /config/:restaurantId/dashboard-stats — Live dashboard summary
router.get('/config/:restaurantId/dashboard-stats', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    // Get zones for capacity
    const zonesSnap = await db.collection(collections.parkingZones)
      .where('restaurantId', '==', restaurantId)
      .where('isActive', '==', true)
      .get();

    let totalSlots = 0;
    let occupiedSlots = 0;
    const zones = [];
    zonesSnap.forEach(doc => {
      const z = doc.data();
      totalSlots += z.totalSlots || 0;
      occupiedSlots += z.occupiedSlots || 0;
      zones.push({ id: doc.id, zoneName: z.zoneName, zoneCode: z.zoneCode, totalSlots: z.totalSlots || 0, occupiedSlots: z.occupiedSlots || 0 });
    });

    // Get today's revenue
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const ticketsSnap = await db.collection(collections.parkingTickets)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'completed')
      .where('exitTime', '>=', startOfDay)
      .get();

    let todayRevenue = 0;
    let todayVehicles = 0;
    ticketsSnap.forEach(doc => {
      const t = doc.data();
      todayRevenue += t.finalAmount || 0;
      todayVehicles++;
    });

    // Active tickets count
    const activeSnap = await db.collection(collections.parkingTickets)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'active')
      .get();

    res.json({
      success: true,
      stats: {
        totalSlots,
        occupiedSlots,
        availableSlots: totalSlots - occupiedSlots,
        activeTickets: activeSnap.size,
        todayRevenue,
        todayVehicles,
        zones
      }
    });
  } catch (error) {
    console.error('Error fetching dashboard stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// ZONES
// ──────────────────────────────────────────────

// GET /zones/:restaurantId — List all zones
router.get('/zones/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snap = await db.collection(collections.parkingZones)
      .where('restaurantId', '==', restaurantId)
      .orderBy('sortOrder', 'asc')
      .get();

    const zones = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, zones });
  } catch (error) {
    console.error('Error fetching zones:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /zones/:restaurantId — Create zone
router.post('/zones/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { zoneName, zoneNameAr, zoneCode, floor, zoneType, totalSlots, sortOrder } = req.body;

    if (!zoneName || !zoneCode) {
      return res.status(400).json({ success: false, error: 'zoneName and zoneCode are required' });
    }

    const zoneData = {
      restaurantId,
      zoneName,
      zoneNameAr: zoneNameAr || '',
      zoneCode,
      floor: floor ?? 0,
      zoneType: zoneType || 'general',
      totalSlots: totalSlots || 0,
      occupiedSlots: 0,
      isActive: true,
      valetStaging: false,
      sortOrder: sortOrder ?? 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection(collections.parkingZones).add(zoneData);
    res.json({ success: true, zone: { id: ref.id, ...zoneData } });
  } catch (error) {
    console.error('Error creating zone:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /zones/:restaurantId/:zoneId — Update zone
router.put('/zones/:restaurantId/:zoneId', async (req, res) => {
  try {
    const { restaurantId, zoneId } = req.params;
    const updates = req.body;
    delete updates.restaurantId;
    delete updates.occupiedSlots; // Don't allow manual override of occupancy counter

    updates.updatedAt = FieldValue.serverTimestamp();

    await db.collection(collections.parkingZones).doc(zoneId).update(updates);

    const updated = await db.collection(collections.parkingZones).doc(zoneId).get();
    res.json({ success: true, zone: { id: zoneId, ...updated.data() } });
  } catch (error) {
    console.error('Error updating zone:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /zones/:restaurantId/:zoneId — Soft delete zone
router.delete('/zones/:restaurantId/:zoneId', async (req, res) => {
  try {
    const { zoneId } = req.params;
    await db.collection(collections.parkingZones).doc(zoneId).update({
      isActive: false,
      updatedAt: FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: 'Zone deactivated' });
  } catch (error) {
    console.error('Error deleting zone:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// SLOTS
// ──────────────────────────────────────────────

// GET /slots/:restaurantId — List slots (filter by zoneId, status)
router.get('/slots/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { zoneId, status } = req.query;

    let query = db.collection(collections.parkingSlots)
      .where('restaurantId', '==', restaurantId)
      .where('isActive', '==', true);

    if (zoneId) query = query.where('zoneId', '==', zoneId);
    if (status) query = query.where('status', '==', status);

    const snap = await query.orderBy('sortOrder', 'asc').get();
    const slots = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, slots });
  } catch (error) {
    console.error('Error fetching slots:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /slots/:restaurantId — Create single slot
router.post('/slots/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { zoneId, slotNumber, slotType, vehicleTypeRestriction, sortOrder } = req.body;

    if (!zoneId || !slotNumber) {
      return res.status(400).json({ success: false, error: 'zoneId and slotNumber are required' });
    }

    const slotData = {
      restaurantId,
      zoneId,
      slotNumber,
      slotType: slotType || 'standard',
      vehicleTypeRestriction: vehicleTypeRestriction || null,
      status: 'available',
      currentTicketId: null,
      isActive: true,
      sortOrder: sortOrder ?? 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection(collections.parkingSlots).add(slotData);
    res.json({ success: true, slot: { id: ref.id, ...slotData } });
  } catch (error) {
    console.error('Error creating slot:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /slots/:restaurantId/bulk — Bulk create slots for a zone
router.post('/slots/:restaurantId/bulk', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { zoneId, prefix, startNumber, count, slotType, vehicleTypeRestriction } = req.body;

    if (!zoneId || !prefix || !count) {
      return res.status(400).json({ success: false, error: 'zoneId, prefix, and count are required' });
    }

    const batch = db.batch();
    const createdSlots = [];
    const start = startNumber || 1;

    for (let i = 0; i < count; i++) {
      const slotNumber = `${prefix}-${String(start + i).padStart(3, '0')}`;
      const ref = db.collection(collections.parkingSlots).doc();
      const slotData = {
        restaurantId,
        zoneId,
        slotNumber,
        slotType: slotType || 'standard',
        vehicleTypeRestriction: vehicleTypeRestriction || null,
        status: 'available',
        currentTicketId: null,
        isActive: true,
        sortOrder: start + i,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };
      batch.set(ref, slotData);
      createdSlots.push({ id: ref.id, ...slotData });
    }

    await batch.commit();

    // Update zone totalSlots
    const zoneDoc = await db.collection(collections.parkingZones).doc(zoneId).get();
    if (zoneDoc.exists) {
      const currentTotal = zoneDoc.data().totalSlots || 0;
      await db.collection(collections.parkingZones).doc(zoneId).update({
        totalSlots: currentTotal + count,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    res.json({ success: true, slots: createdSlots, count: createdSlots.length });
  } catch (error) {
    console.error('Error bulk creating slots:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /slots/:restaurantId/:slotId — Update slot
router.put('/slots/:restaurantId/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    const updates = req.body;
    delete updates.restaurantId;
    updates.updatedAt = FieldValue.serverTimestamp();

    await db.collection(collections.parkingSlots).doc(slotId).update(updates);
    const updated = await db.collection(collections.parkingSlots).doc(slotId).get();
    res.json({ success: true, slot: { id: slotId, ...updated.data() } });
  } catch (error) {
    console.error('Error updating slot:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /slots/:restaurantId/:slotId — Soft delete slot
router.delete('/slots/:restaurantId/:slotId', async (req, res) => {
  try {
    const { slotId } = req.params;
    await db.collection(collections.parkingSlots).doc(slotId).update({
      isActive: false,
      updatedAt: FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: 'Slot deactivated' });
  } catch (error) {
    console.error('Error deleting slot:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// RATES
// ──────────────────────────────────────────────

// GET /rates/:restaurantId — List all rates
router.get('/rates/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snap = await db.collection(collections.parkingRates)
      .where('restaurantId', '==', restaurantId)
      .where('isActive', '==', true)
      .orderBy('sortOrder', 'asc')
      .get();

    const rates = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, rates });
  } catch (error) {
    console.error('Error fetching rates:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /rates/:restaurantId — Create rate
router.post('/rates/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      rateName, rateNameAr, vehicleType, rateType,
      hourlyRate, minimumCharge, gracePeriodMinutes, maxDailyRate,
      flatRate, tiers, nightSurcharge, weekendSurcharge,
      isDefault, zoneIds, sortOrder
    } = req.body;

    if (!rateName || !rateType) {
      return res.status(400).json({ success: false, error: 'rateName and rateType are required' });
    }

    const rateData = {
      restaurantId,
      rateName,
      rateNameAr: rateNameAr || '',
      vehicleType: vehicleType || 'all',
      rateType,
      hourlyRate: hourlyRate || 0,
      minimumCharge: minimumCharge || 0,
      gracePeriodMinutes: gracePeriodMinutes ?? 15,
      maxDailyRate: maxDailyRate || null,
      flatRate: flatRate || 0,
      tiers: tiers || [],
      nightSurcharge: nightSurcharge || { enabled: false, startHour: 22, endHour: 6, multiplier: 1.5 },
      weekendSurcharge: weekendSurcharge || { enabled: false, multiplier: 1.2 },
      isDefault: isDefault || false,
      isActive: true,
      zoneIds: zoneIds || null,
      sortOrder: sortOrder ?? 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection(collections.parkingRates).add(rateData);
    res.json({ success: true, rate: { id: ref.id, ...rateData } });
  } catch (error) {
    console.error('Error creating rate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /rates/:restaurantId/:rateId — Update rate
router.put('/rates/:restaurantId/:rateId', async (req, res) => {
  try {
    const { rateId } = req.params;
    const updates = req.body;
    delete updates.restaurantId;
    updates.updatedAt = FieldValue.serverTimestamp();

    await db.collection(collections.parkingRates).doc(rateId).update(updates);
    const updated = await db.collection(collections.parkingRates).doc(rateId).get();
    res.json({ success: true, rate: { id: rateId, ...updated.data() } });
  } catch (error) {
    console.error('Error updating rate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /rates/:restaurantId/:rateId — Soft delete rate
router.delete('/rates/:restaurantId/:rateId', async (req, res) => {
  try {
    const { rateId } = req.params;
    await db.collection(collections.parkingRates).doc(rateId).update({
      isActive: false,
      updatedAt: FieldValue.serverTimestamp()
    });
    res.json({ success: true, message: 'Rate deactivated' });
  } catch (error) {
    console.error('Error deleting rate:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// TICKET ENTRY / EXIT FLOW
// ──────────────────────────────────────────────

// Calculate parking fee based on rate and duration
function calculateParkingFee(rate, durationMinutes) {
  if (!rate || durationMinutes <= 0) return 0;

  // Apply grace period
  const effectiveMinutes = Math.max(0, durationMinutes - (rate.gracePeriodMinutes || 0));
  if (effectiveMinutes === 0) return 0;

  let amount = 0;

  switch (rate.rateType) {
    case 'hourly': {
      const hours = Math.ceil(effectiveMinutes / 60);
      amount = hours * (rate.hourlyRate || 0);
      if (rate.maxDailyRate && amount > rate.maxDailyRate) {
        amount = rate.maxDailyRate;
      }
      break;
    }
    case 'flat': {
      amount = rate.flatRate || 0;
      break;
    }
    case 'tiered': {
      if (rate.tiers && rate.tiers.length > 0) {
        const sortedTiers = [...rate.tiers].sort((a, b) => (a.upToMinutes || Infinity) - (b.upToMinutes || Infinity));
        for (const tier of sortedTiers) {
          if (tier.upToMinutes === null || effectiveMinutes <= tier.upToMinutes) {
            amount = tier.rate || 0;
            break;
          }
        }
      }
      break;
    }
    case 'daily': {
      const days = Math.ceil(effectiveMinutes / (24 * 60));
      amount = days * (rate.flatRate || rate.hourlyRate || 0);
      break;
    }
    case 'monthly': {
      amount = rate.flatRate || 0;
      break;
    }
    default:
      amount = 0;
  }

  // Apply minimum charge
  if (amount > 0 && rate.minimumCharge && amount < rate.minimumCharge) {
    amount = rate.minimumCharge;
  }

  // Apply surcharges
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay();

  if (rate.nightSurcharge?.enabled) {
    const { startHour, endHour, multiplier } = rate.nightSurcharge;
    if (startHour > endHour) {
      // Overnight (e.g., 22-6)
      if (hour >= startHour || hour < endHour) {
        amount *= (multiplier || 1);
      }
    } else if (hour >= startHour && hour < endHour) {
      amount *= (multiplier || 1);
    }
  }

  if (rate.weekendSurcharge?.enabled && (day === 5 || day === 6)) {
    // Friday and Saturday for Dubai/Kuwait
    amount *= (rate.weekendSurcharge.multiplier || 1);
  }

  return Math.round(amount * 100) / 100;
}

// POST /tickets/:restaurantId/entry — Create parking ticket (vehicle enters)
router.post('/tickets/:restaurantId/entry', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      vehicleNumber, vehicleType, vehicleColor, vehicleMake, vehicleModel,
      vehicleImageUrl, licensePlateImageUrl,
      aiRecognizedPlate, aiConfidence,
      zoneId, slotId, rateId, notes
    } = req.body;

    if (!vehicleNumber && !aiRecognizedPlate) {
      return res.status(400).json({ success: false, error: 'vehicleNumber is required' });
    }

    if (!zoneId) {
      return res.status(400).json({ success: false, error: 'zoneId is required' });
    }

    // Get config for ticket number
    const configDoc = await db.collection(collections.parkingConfigs).doc(restaurantId).get();
    const config = configDoc.exists ? configDoc.data() : { ticketPrefix: 'PKT', ticketSequence: 0 };
    const newSequence = (config.ticketSequence || 0) + 1;
    const ticketNumber = `${config.ticketPrefix || 'PKT'}-${String(newSequence).padStart(6, '0')}`;

    // Update ticket sequence atomically
    await db.collection(collections.parkingConfigs).doc(restaurantId).update({
      ticketSequence: newSequence
    });

    // Get zone info and validate
    const zoneDoc = await db.collection(collections.parkingZones).doc(zoneId).get();
    if (!zoneDoc.exists) {
      return res.status(400).json({ success: false, error: 'Zone not found' });
    }
    const zoneData = zoneDoc.data();
    if (zoneData.isActive === false) {
      return res.status(400).json({ success: false, error: 'Zone is inactive' });
    }
    // Check zone capacity
    if (zoneData.totalSlots && (zoneData.occupiedSlots || 0) >= zoneData.totalSlots) {
      return res.status(400).json({ success: false, error: 'Zone is full — no available slots' });
    }
    const zoneName = zoneData.zoneName || '';
    const zoneCode = zoneData.zoneCode || '';

    // Get slot info if individual tracking
    let slotNumber = null;
    if (slotId) {
      const slotDoc = await db.collection(collections.parkingSlots).doc(slotId).get();
      if (slotDoc.exists) {
        slotNumber = slotDoc.data().slotNumber;
        // Mark slot as occupied
        await db.collection(collections.parkingSlots).doc(slotId).update({
          status: 'occupied',
          currentTicketId: null, // Will update after ticket creation
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    }

    // Auto-match rate: find best rate for vehicle type + zone
    let matchedRateId = rateId || null;
    let rateName = '';
    let rateData = null;

    if (rateId) {
      // Client explicitly provided a rate — use it
      const rateDoc = await db.collection(collections.parkingRates).doc(rateId).get();
      if (rateDoc.exists) {
        rateData = rateDoc.data();
        rateName = rateData.rateName;
        matchedRateId = rateId;
      }
    }

    if (!matchedRateId) {
      // Auto-match: query all active rates for this restaurant
      const ratesSnap = await db.collection(collections.parkingRates)
        .where('restaurantId', '==', restaurantId)
        .where('isActive', '==', true)
        .get();

      const allRates = ratesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const vType = vehicleType || 'car';

      // Score each rate: higher = better match
      let bestRate = null;
      let bestScore = -1;

      for (const r of allRates) {
        let score = 0;
        // Vehicle type match
        const rVehicle = r.vehicleType || 'all';
        if (rVehicle === vType) {
          score += 10; // Exact vehicle type match
        } else if (rVehicle === 'all') {
          score += 1; // Generic match
        } else {
          continue; // Wrong vehicle type, skip
        }
        // Zone match
        if (r.zoneIds && Array.isArray(r.zoneIds) && r.zoneIds.length > 0) {
          if (r.zoneIds.includes(zoneId)) {
            score += 5; // Zone-specific match
          } else {
            continue; // Wrong zone, skip
          }
        } else {
          score += 2; // Applies to all zones
        }
        // Default rate bonus (fallback)
        if (r.isDefault) score += 0.5;

        if (score > bestScore) {
          bestScore = score;
          bestRate = r;
        }
      }

      if (bestRate) {
        matchedRateId = bestRate.id;
        rateData = bestRate;
        rateName = bestRate.rateName;
      }
    }

    // Generate QR code
    let qrCodeDataUrl = '';
    try {
      const QRCode = require('qrcode');
      const qrContent = `PKT:${ticketNumber}`;
      qrCodeDataUrl = await QRCode.toDataURL(qrContent, { width: 200, margin: 1, errorCorrectionLevel: 'M' });
    } catch (qrErr) {
      console.warn('QR code generation failed:', qrErr.message);
    }

    const ticketData = {
      restaurantId,
      ticketNumber,
      vehicleNumber: vehicleNumber || aiRecognizedPlate || '',
      vehicleType: vehicleType || 'car',
      vehicleColor: vehicleColor || '',
      vehicleMake: vehicleMake || '',
      vehicleModel: vehicleModel || '',
      vehicleImageUrl: vehicleImageUrl || '',
      licensePlateImageUrl: licensePlateImageUrl || '',
      aiRecognizedPlate: aiRecognizedPlate || '',
      aiConfidence: aiConfidence || 0,
      zoneId,
      zoneName,
      zoneCode,
      slotId: slotId || null,
      slotNumber: slotNumber || null,
      entryTime: FieldValue.serverTimestamp(),
      exitTime: null,
      duration: null,
      rateId: matchedRateId || null,
      rateName,
      calculatedAmount: null,
      discountAmount: 0,
      finalAmount: null,
      currency: config.currency || 'AED',
      paymentStatus: 'pending',
      paymentMethod: null,
      status: 'active',
      qrCodeData: `PKT:${ticketNumber}`,
      qrCodeDataUrl,
      entryOperatorId: getActorId(req),
      entryOperatorName: getActorName(req),
      exitOperatorId: null,
      exitOperatorName: null,
      notes: notes || '',
      isValet: false,
      valetDetails: {},
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection(collections.parkingTickets).add(ticketData);

    // Update slot with ticket reference
    if (slotId) {
      await db.collection(collections.parkingSlots).doc(slotId).update({
        currentTicketId: ref.id
      });
    }

    // Increment zone occupied counter
    await db.collection(collections.parkingZones).doc(zoneId).update({
      occupiedSlots: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    });

    // Pusher real-time notification (fire-and-forget)
    try {
      const pusherService = require('../services/pusherService');
      pusherService.triggerOrderEvent(restaurantId, 'parking-entry', {
        ticketId: ref.id,
        ticketNumber,
        vehicleNumber: ticketData.vehicleNumber,
        vehicleType: ticketData.vehicleType,
        zoneName,
        slotNumber
      });
    } catch (e) { /* ignore */ }

    res.json({
      success: true,
      ticket: { id: ref.id, ...ticketData },
      printData: {
        ticketNumber,
        vehicleNumber: ticketData.vehicleNumber,
        vehicleType: ticketData.vehicleType,
        vehicleColor: ticketData.vehicleColor,
        zoneName,
        zoneCode,
        slotNumber,
        rateName,
        entryTime: new Date().toISOString(),
        qrCodeDataUrl,
        currency: ticketData.currency
      }
    });
  } catch (error) {
    console.error('Error creating parking ticket:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /tickets/:restaurantId/exit — Process exit (calculate amount)
router.post('/tickets/:restaurantId/exit', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { ticketId, ticketNumber, qrData } = req.body;

    // Lookup ticket
    let ticketDoc;
    if (ticketId) {
      ticketDoc = await db.collection(collections.parkingTickets).doc(ticketId).get();
    } else if (ticketNumber) {
      const snap = await db.collection(collections.parkingTickets)
        .where('restaurantId', '==', restaurantId)
        .where('ticketNumber', '==', ticketNumber)
        .where('status', '==', 'active')
        .limit(1)
        .get();
      if (!snap.empty) ticketDoc = snap.docs[0];
    } else if (qrData) {
      // Parse QR: "PKT:PKT-000123"
      const parsedNumber = qrData.startsWith('PKT:') ? qrData.substring(4) : qrData;
      const snap = await db.collection(collections.parkingTickets)
        .where('restaurantId', '==', restaurantId)
        .where('ticketNumber', '==', parsedNumber)
        .where('status', '==', 'active')
        .limit(1)
        .get();
      if (!snap.empty) ticketDoc = snap.docs[0];
    }

    if (!ticketDoc || !ticketDoc.exists) {
      return res.status(404).json({ success: false, error: 'Active ticket not found' });
    }

    const ticket = ticketDoc.data();
    const now = new Date();
    const entryTime = ticket.entryTime?.toDate ? ticket.entryTime.toDate() : new Date(ticket.entryTime);
    const durationMs = now.getTime() - entryTime.getTime();
    const durationMinutes = Math.round(durationMs / (1000 * 60));

    // Get rate for calculation
    let calculatedAmount = 0;
    let rateData = null;
    if (ticket.rateId) {
      const rateDoc = await db.collection(collections.parkingRates).doc(ticket.rateId).get();
      if (rateDoc.exists) {
        rateData = rateDoc.data();
        calculatedAmount = calculateParkingFee(rateData, durationMinutes);
      }
    }

    res.json({
      success: true,
      exitPreview: {
        ticketId: ticketDoc.id,
        ticketNumber: ticket.ticketNumber,
        vehicleNumber: ticket.vehicleNumber,
        vehicleType: ticket.vehicleType,
        zoneName: ticket.zoneName,
        slotNumber: ticket.slotNumber,
        entryTime: entryTime.toISOString(),
        exitTime: now.toISOString(),
        durationMinutes,
        durationFormatted: `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`,
        rateName: ticket.rateName,
        calculatedAmount,
        currency: ticket.currency
      }
    });
  } catch (error) {
    console.error('Error processing exit:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /tickets/:restaurantId/exit/confirm — Confirm exit and payment
router.post('/tickets/:restaurantId/exit/confirm', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { ticketId, paymentMethod, discountAmount, finalAmount, notes } = req.body;

    if (!ticketId) {
      return res.status(400).json({ success: false, error: 'ticketId is required' });
    }

    const ticketDoc = await db.collection(collections.parkingTickets).doc(ticketId).get();
    if (!ticketDoc.exists) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    const ticket = ticketDoc.data();
    if (ticket.restaurantId !== restaurantId) {
      return res.status(403).json({ success: false, error: 'Ticket does not belong to this restaurant' });
    }
    if (ticket.status !== 'active') {
      return res.status(400).json({ success: false, error: 'Ticket is not active' });
    }

    const validPaymentMethods = ['cash', 'card', 'upi', 'wallet', 'online', 'free'];
    if (paymentMethod && !validPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({ success: false, error: `Invalid payment method. Allowed: ${validPaymentMethods.join(', ')}` });
    }

    const now = new Date();
    const entryTime = ticket.entryTime?.toDate ? ticket.entryTime.toDate() : new Date(ticket.entryTime);
    const durationMinutes = Math.round((now.getTime() - entryTime.getTime()) / (1000 * 60));

    // Calculate amount if not provided
    let computedAmount = finalAmount;
    if (computedAmount === undefined || computedAmount === null) {
      if (ticket.rateId) {
        const rateDoc = await db.collection(collections.parkingRates).doc(ticket.rateId).get();
        if (rateDoc.exists) {
          computedAmount = calculateParkingFee(rateDoc.data(), durationMinutes);
        }
      }
      computedAmount = computedAmount || 0;
    }

    const discount = discountAmount || 0;
    const finalAmt = Math.max(0, computedAmount - discount);

    // Update ticket
    const updateData = {
      exitTime: FieldValue.serverTimestamp(),
      duration: durationMinutes,
      calculatedAmount: computedAmount,
      discountAmount: discount,
      finalAmount: finalAmt,
      paymentStatus: finalAmt === 0 ? 'free' : 'paid',
      paymentMethod: paymentMethod || 'cash',
      status: 'completed',
      exitOperatorId: getActorId(req),
      exitOperatorName: getActorName(req),
      notes: notes || ticket.notes || '',
      updatedAt: FieldValue.serverTimestamp()
    };

    await db.collection(collections.parkingTickets).doc(ticketId).update(updateData);

    // Free up slot if assigned
    if (ticket.slotId) {
      await db.collection(collections.parkingSlots).doc(ticket.slotId).update({
        status: 'available',
        currentTicketId: null,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    // Decrement zone occupied counter
    if (ticket.zoneId) {
      await db.collection(collections.parkingZones).doc(ticket.zoneId).update({
        occupiedSlots: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    // Pusher real-time notification (fire-and-forget)
    try {
      const pusherService = require('../services/pusherService');
      pusherService.triggerOrderEvent(restaurantId, 'parking-exit', {
        ticketId,
        ticketNumber: ticket.ticketNumber,
        vehicleNumber: ticket.vehicleNumber,
        duration: durationMinutes,
        amount: finalAmt
      });
    } catch (e) { /* ignore */ }

    const updatedTicket = await db.collection(collections.parkingTickets).doc(ticketId).get();
    res.json({
      success: true,
      ticket: { id: ticketId, ...updatedTicket.data() },
      exitData: {
        ticketNumber: ticket.ticketNumber,
        vehicleNumber: ticket.vehicleNumber,
        vehicleType: ticket.vehicleType,
        zoneName: ticket.zoneName,
        slotNumber: ticket.slotNumber,
        entryTime: entryTime.toISOString(),
        exitTime: now.toISOString(),
        durationMinutes,
        durationFormatted: `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`,
        calculatedAmount: computedAmount,
        discountAmount: discount,
        finalAmount: finalAmt,
        paymentMethod: paymentMethod || 'cash',
        currency: ticket.currency,
        qrCodeDataUrl: ticket.qrCodeDataUrl
      }
    });
  } catch (error) {
    console.error('Error confirming exit:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /tickets/:restaurantId — List tickets with filters
router.get('/tickets/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, date, vehicleNumber, zoneId, limit: queryLimit } = req.query;

    let query = db.collection(collections.parkingTickets)
      .where('restaurantId', '==', restaurantId);

    if (status) query = query.where('status', '==', status);
    if (zoneId) query = query.where('zoneId', '==', zoneId);

    if (date) {
      const dayStart = new Date(date);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(date);
      dayEnd.setHours(23, 59, 59, 999);
      query = query.where('entryTime', '>=', dayStart).where('entryTime', '<=', dayEnd);
    }

    query = query.orderBy('entryTime', 'desc').limit(parseInt(queryLimit) || 100);

    const snap = await query.get();
    let tickets = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Client-side filter for vehicleNumber (Firestore doesn't support substring search)
    if (vehicleNumber) {
      const search = vehicleNumber.toLowerCase();
      tickets = tickets.filter(t => t.vehicleNumber?.toLowerCase().includes(search));
    }

    res.json({ success: true, tickets });
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /tickets/:restaurantId/:ticketId — Get single ticket
router.get('/tickets/:restaurantId/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const doc = await db.collection(collections.parkingTickets).doc(ticketId).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }
    res.json({ success: true, ticket: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error('Error fetching ticket:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /tickets/:restaurantId/lookup — Lookup by vehicleNumber or ticketNumber
router.get('/tickets/:restaurantId/lookup', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { vehicleNumber, ticketNumber } = req.query;

    let snap;
    if (ticketNumber) {
      snap = await db.collection(collections.parkingTickets)
        .where('restaurantId', '==', restaurantId)
        .where('ticketNumber', '==', ticketNumber)
        .limit(1)
        .get();
    } else if (vehicleNumber) {
      snap = await db.collection(collections.parkingTickets)
        .where('restaurantId', '==', restaurantId)
        .where('vehicleNumber', '==', vehicleNumber)
        .where('status', '==', 'active')
        .limit(1)
        .get();
    } else {
      return res.status(400).json({ success: false, error: 'vehicleNumber or ticketNumber required' });
    }

    if (snap.empty) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    const doc = snap.docs[0];
    res.json({ success: true, ticket: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error('Error looking up ticket:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /tickets/:restaurantId/:ticketId — Update ticket
router.put('/tickets/:restaurantId/:ticketId', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const updates = req.body;
    delete updates.restaurantId;
    delete updates.status; // Use dedicated cancel endpoint for status changes
    updates.updatedAt = FieldValue.serverTimestamp();

    await db.collection(collections.parkingTickets).doc(ticketId).update(updates);
    const updated = await db.collection(collections.parkingTickets).doc(ticketId).get();
    res.json({ success: true, ticket: { id: ticketId, ...updated.data() } });
  } catch (error) {
    console.error('Error updating ticket:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /tickets/:restaurantId/:ticketId/cancel — Cancel ticket
router.post('/tickets/:restaurantId/:ticketId/cancel', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { reason } = req.body;

    const ticketDoc = await db.collection(collections.parkingTickets).doc(ticketId).get();
    if (!ticketDoc.exists) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    const ticket = ticketDoc.data();
    if (ticket.status !== 'active') {
      return res.status(400).json({ success: false, error: 'Only active tickets can be cancelled' });
    }

    await db.collection(collections.parkingTickets).doc(ticketId).update({
      status: 'cancelled',
      paymentStatus: 'waived',
      notes: reason ? `Cancelled: ${reason}` : ticket.notes,
      exitOperatorId: getActorId(req),
      exitOperatorName: getActorName(req),
      updatedAt: FieldValue.serverTimestamp()
    });

    // Free up slot
    if (ticket.slotId) {
      await db.collection(collections.parkingSlots).doc(ticket.slotId).update({
        status: 'available',
        currentTicketId: null,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    // Decrement zone counter
    if (ticket.zoneId) {
      await db.collection(collections.parkingZones).doc(ticket.zoneId).update({
        occupiedSlots: FieldValue.increment(-1),
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    res.json({ success: true, message: 'Ticket cancelled' });
  } catch (error) {
    console.error('Error cancelling ticket:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// AI LICENSE PLATE RECOGNITION
// ──────────────────────────────────────────────

// POST /ai/recognize-plate/:restaurantId — Upload image, extract plate via OpenAI Vision
router.post('/ai/recognize-plate/:restaurantId', async (req, res) => {
  try {
    const multer = require('multer');
    const uploadSingle = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('image');

    uploadSingle(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ success: false, error: 'Image upload failed: ' + err.message });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No image provided' });
      }

      // Upload to GCS
      let imageUrl = '';
      try {
        const { Storage } = require('@google-cloud/storage');
        let storage;
        const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        const fbClientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const fbPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
        const fbProjectId = process.env.FIREBASE_PROJECT_ID;

        if (credentialsJson && credentialsJson !== 'undefined') {
          const cleaned = credentialsJson.trim().replace(/^["']|["']$/g, '');
          const serviceAccount = JSON.parse(cleaned);
          storage = new Storage({ projectId: serviceAccount.project_id, credentials: { client_email: serviceAccount.client_email, private_key: serviceAccount.private_key } });
        } else if (fbClientEmail && fbPrivateKey) {
          storage = new Storage({ projectId: fbProjectId, credentials: { client_email: fbClientEmail, private_key: fbPrivateKey.replace(/\\n/g, '\n') } });
        } else {
          storage = new Storage();
        }

        const bucketObj = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET || 'dine-menu-uploads');
        const fileName = `parking/plates/${req.params.restaurantId}/${Date.now()}_${req.file.originalname || 'plate.jpg'}`;
        const file = bucketObj.file(fileName);
        await file.save(req.file.buffer, { metadata: { contentType: req.file.mimetype } });
        await file.makePublic();
        imageUrl = `https://storage.googleapis.com/${bucketObj.name}/${fileName}`;
      } catch (uploadErr) {
        console.warn('GCS upload failed, using base64 fallback:', uploadErr.message);
        // Fallback: use base64 for AI call (no persistent URL)
      }

      // Call OpenAI Vision
      try {
        const OpenAI = require('openai');
        const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        const imageContent = imageUrl
          ? { type: 'image_url', image_url: { url: imageUrl } }
          : { type: 'image_url', image_url: { url: `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` } };

        const response = await openaiClient.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: `Extract the vehicle license plate number from this image. Also identify the vehicle type (car, suv, bike, truck, bus), color, and any visible make/model.

Return ONLY valid JSON in this exact format:
{
  "plateNumber": "the plate number as shown",
  "confidence": 0.95,
  "country": "UAE or Kuwait or unknown",
  "vehicleType": "car",
  "vehicleColor": "white",
  "vehicleMake": "Toyota",
  "vehicleModel": "Camry"
}

If you cannot read the plate clearly, set confidence below 0.5 and plateNumber to your best guess.`
                },
                imageContent
              ]
            }
          ],
          max_tokens: 300,
          temperature: 0
        });

        const content = response.choices[0]?.message?.content || '';
        let parsed;
        try {
          // Extract JSON from potential markdown code block
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
        } catch {
          parsed = { plateNumber: '', confidence: 0, error: 'Failed to parse AI response' };
        }

        res.json({
          success: true,
          recognition: {
            plateNumber: parsed.plateNumber || '',
            confidence: parsed.confidence || 0,
            country: parsed.country || 'unknown',
            vehicleType: parsed.vehicleType || 'car',
            vehicleColor: parsed.vehicleColor || '',
            vehicleMake: parsed.vehicleMake || '',
            vehicleModel: parsed.vehicleModel || '',
            imageUrl
          }
        });
      } catch (aiErr) {
        console.error('OpenAI Vision error:', aiErr);
        res.status(500).json({
          success: false,
          error: 'AI recognition failed',
          imageUrl // Still return the uploaded image URL
        });
      }
    });
  } catch (error) {
    console.error('Error in plate recognition:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// PRINT DATA
// ──────────────────────────────────────────────

// GET /tickets/:restaurantId/:ticketId/print-data — Structured JSON for slip generation
router.get('/tickets/:restaurantId/:ticketId/print-data', async (req, res) => {
  try {
    const { restaurantId, ticketId } = req.params;

    const [ticketDoc, configDoc] = await Promise.all([
      db.collection(collections.parkingTickets).doc(ticketId).get(),
      db.collection(collections.parkingConfigs).doc(restaurantId).get()
    ]);

    if (!ticketDoc.exists) {
      return res.status(404).json({ success: false, error: 'Ticket not found' });
    }

    const ticket = ticketDoc.data();
    const config = configDoc.exists ? configDoc.data() : {};

    const entryTime = ticket.entryTime?.toDate ? ticket.entryTime.toDate() : new Date(ticket.entryTime);
    const exitTime = ticket.exitTime?.toDate ? ticket.exitTime.toDate() : (ticket.exitTime ? new Date(ticket.exitTime) : null);

    res.json({
      success: true,
      printData: {
        // Config
        lotName: config.lotName || '',
        lotNameAr: config.lotNameAr || '',
        address: config.address || '',
        addressAr: config.addressAr || '',
        logo: config.logo || '',
        receiptHeader: config.receiptHeader || '',
        receiptHeaderAr: config.receiptHeaderAr || '',
        receiptFooter: config.receiptFooter || '',
        receiptFooterAr: config.receiptFooterAr || '',
        printLanguage: config.printLanguage || 'dual',
        currency: config.currency || 'AED',
        // Ticket
        ticketNumber: ticket.ticketNumber,
        vehicleNumber: ticket.vehicleNumber,
        vehicleType: ticket.vehicleType,
        vehicleColor: ticket.vehicleColor || '',
        zoneName: ticket.zoneName || '',
        zoneCode: ticket.zoneCode || '',
        slotNumber: ticket.slotNumber || '',
        rateName: ticket.rateName || '',
        entryTime: entryTime.toISOString(),
        exitTime: exitTime ? exitTime.toISOString() : null,
        duration: ticket.duration || null,
        durationFormatted: ticket.duration ? `${Math.floor(ticket.duration / 60)}h ${ticket.duration % 60}m` : null,
        calculatedAmount: ticket.calculatedAmount,
        discountAmount: ticket.discountAmount || 0,
        finalAmount: ticket.finalAmount,
        paymentMethod: ticket.paymentMethod,
        paymentStatus: ticket.paymentStatus,
        status: ticket.status,
        qrCodeDataUrl: ticket.qrCodeDataUrl || ''
      }
    });
  } catch (error) {
    console.error('Error fetching print data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ──────────────────────────────────────────────
// REPORTS
// ──────────────────────────────────────────────

// GET /reports/:restaurantId — Parking analytics
router.get('/reports/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d; })();
    const end = endDate ? new Date(endDate) : new Date();
    end.setHours(23, 59, 59, 999);

    const snap = await db.collection(collections.parkingTickets)
      .where('restaurantId', '==', restaurantId)
      .where('entryTime', '>=', start)
      .where('entryTime', '<=', end)
      .get();

    let totalRevenue = 0;
    let totalVehicles = 0;
    let totalDuration = 0;
    const vehicleTypeCounts = {};
    const zoneCounts = {};
    const dailyRevenue = {};
    const hourlyDistribution = {};
    const paymentMethodCounts = {};

    snap.forEach(doc => {
      const t = doc.data();
      totalVehicles++;

      if (t.finalAmount) totalRevenue += t.finalAmount;
      if (t.duration) totalDuration += t.duration;

      // Vehicle type breakdown
      const vType = t.vehicleType || 'unknown';
      vehicleTypeCounts[vType] = (vehicleTypeCounts[vType] || 0) + 1;

      // Zone breakdown
      const zName = t.zoneName || 'Unknown';
      zoneCounts[zName] = (zoneCounts[zName] || 0) + 1;

      // Daily revenue
      const entryDate = t.entryTime?.toDate ? t.entryTime.toDate() : new Date(t.entryTime);
      const dateKey = entryDate.toISOString().split('T')[0];
      if (!dailyRevenue[dateKey]) dailyRevenue[dateKey] = { revenue: 0, vehicles: 0 };
      dailyRevenue[dateKey].revenue += t.finalAmount || 0;
      dailyRevenue[dateKey].vehicles++;

      // Hourly distribution
      const hour = entryDate.getHours();
      hourlyDistribution[hour] = (hourlyDistribution[hour] || 0) + 1;

      // Payment methods
      if (t.paymentMethod) {
        paymentMethodCounts[t.paymentMethod] = (paymentMethodCounts[t.paymentMethod] || 0) + 1;
      }
    });

    res.json({
      success: true,
      reports: {
        period: { start: start.toISOString(), end: end.toISOString() },
        summary: {
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          totalVehicles,
          averageDuration: totalVehicles > 0 ? Math.round(totalDuration / totalVehicles) : 0,
          averageRevenue: totalVehicles > 0 ? Math.round((totalRevenue / totalVehicles) * 100) / 100 : 0
        },
        vehicleTypes: vehicleTypeCounts,
        zones: zoneCounts,
        dailyRevenue,
        hourlyDistribution,
        paymentMethods: paymentMethodCounts
      }
    });
  } catch (error) {
    console.error('Error generating reports:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
