const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const pusherService = require('../services/pusherService');

router.use(authenticateToken);

// ── Helpers ─────────────────────────────────────────────────────────

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371e3;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTodayStr() {
  const now = new Date();
  return now.toISOString().split('T')[0]; // YYYY-MM-DD
}

function getLeaveYear(yearStart) {
  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentYear = now.getFullYear();
  if (currentMonth >= yearStart) return currentYear;
  return currentYear - 1;
}

async function getLeaveConfig(restaurantId) {
  const doc = await db.collection('leaveConfig').doc(restaurantId).get();
  if (doc.exists) return { id: doc.id, ...doc.data() };
  return {
    id: restaurantId,
    leaveTypes: [
      { id: 'cl', name: 'Casual Leave', shortName: 'CL', paidLeaves: 12, carryForward: false, color: '#3b82f6' },
      { id: 'sl', name: 'Sick Leave', shortName: 'SL', paidLeaves: 7, carryForward: false, color: '#ef4444' },
      { id: 'el', name: 'Earned Leave', shortName: 'EL', paidLeaves: 15, carryForward: true, maxCarryForward: 30, color: '#10b981' },
    ],
    yearStart: 4,
    weeklyOff: [0],
    holidays: [],
    workStartTime: '09:00',
    workEndTime: '18:00',
    lateGracePeriod: 15,
    geoFenceEnabled: false,
    geoFenceRadius: 150,
    geoFenceLocation: null,
    overtimeEnabled: false,
    overtimeAfterHours: 9,
    autoClockOutEnabled: false,
    autoClockOutTime: '23:59',
  };
}

async function getAllStaff(restaurantId) {
  const [staffSnap, usersSnap] = await Promise.all([
    db.collection('staffUsers').where('restaurantId', '==', restaurantId).get(),
    db.collection('users').where('restaurantId', '==', restaurantId).get(),
  ]);
  const staffMap = new Map();
  staffSnap.docs.forEach(d => {
    const data = d.data();
    staffMap.set(d.id, { id: d.id, ...data });
  });
  usersSnap.docs.forEach(d => {
    const data = d.data();
    if (!staffMap.has(d.id)) {
      staffMap.set(d.id, { id: d.id, ...data });
    }
  });
  return Array.from(staffMap.values());
}

function isAdminRole(role) {
  return ['owner', 'admin', 'manager'].includes(role);
}

// ── 1. POST /:restaurantId/clock-in ────────────────────────────────
router.post('/:restaurantId/clock-in', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { staffId, staffName, location } = req.body;

    if (!staffId) {
      return res.status(400).json({ error: 'staffId is required' });
    }

    const todayStr = getTodayStr();
    const docId = `${staffId}_${todayStr}`;
    const existingDoc = await db.collection('attendance').doc(docId).get();

    if (existingDoc.exists) {
      const data = existingDoc.data();
      if (data.clockIn && !data.clockOut) {
        return res.status(400).json({ error: 'Already clocked in' });
      }
    }

    // Load leave config for geo-fence and late calculation
    const leaveConfig = await getLeaveConfig(restaurantId);

    // Geo-fence check
    if (leaveConfig.geoFenceEnabled && leaveConfig.geoFenceLocation && location) {
      const distance = haversineDistance(
        location.lat, location.lng,
        leaveConfig.geoFenceLocation.lat, leaveConfig.geoFenceLocation.lng
      );
      if (distance > leaveConfig.geoFenceRadius) {
        return res.status(400).json({
          error: 'You are too far from the workplace',
          distance: Math.round(distance),
          maxDistance: leaveConfig.geoFenceRadius,
        });
      }
    }

    // Calculate lateBy
    let lateBy = 0;
    const now = new Date();
    if (leaveConfig.workStartTime) {
      const [startH, startM] = leaveConfig.workStartTime.split(':').map(Number);
      const gracePeriod = leaveConfig.lateGracePeriod || 0;
      const startMinutes = startH * 60 + startM + gracePeriod;
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      if (currentMinutes > startMinutes) {
        lateBy = currentMinutes - startMinutes;
      }
    }

    const attendanceData = {
      staffId,
      staffName: staffName || '',
      restaurantId,
      date: todayStr,
      status: 'present',
      clockIn: now.toISOString(),
      clockInLocation: location || null,
      lateBy,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await db.collection('attendance').doc(docId).set(attendanceData, { merge: true });

    // Check if continuous tracking is enabled for this staff
    const trackingConfig = leaveConfig.trackingConfig || {};
    const enabledStaffIds = trackingConfig.enabledStaffIds || [];
    const enabledRoles = trackingConfig.enabledRoles || [];
    // Get staff role
    let staffRole = '';
    try {
      const staffDoc = await db.collection('staffUsers').doc(staffId).get();
      if (staffDoc.exists) staffRole = staffDoc.data().role || '';
      else {
        const userDoc = await db.collection('users').doc(staffId).get();
        if (userDoc.exists) staffRole = userDoc.data().role || '';
      }
    } catch (e) { /* ignore */ }
    const trackingEnabled = enabledStaffIds.includes(staffId) || enabledRoles.includes(staffRole);

    res.json({ id: docId, ...attendanceData, trackingEnabled });
  } catch (err) {
    console.error('Clock-in error:', err);
    res.status(500).json({ error: 'Failed to clock in' });
  }
});

// ── 2. POST /:restaurantId/clock-out ───────────────────────────────
router.post('/:restaurantId/clock-out', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { staffId, location } = req.body;

    if (!staffId) {
      return res.status(400).json({ error: 'staffId is required' });
    }

    const todayStr = getTodayStr();
    const docId = `${staffId}_${todayStr}`;
    const existingDoc = await db.collection('attendance').doc(docId).get();

    if (!existingDoc.exists || !existingDoc.data().clockIn) {
      return res.status(400).json({ error: 'Not clocked in today' });
    }

    const data = existingDoc.data();
    if (data.clockOut) {
      return res.status(400).json({ error: 'Already clocked out' });
    }

    const now = new Date();
    const clockInTime = new Date(data.clockIn);
    const totalHours = parseFloat(((now - clockInTime) / (1000 * 60 * 60)).toFixed(2));

    // Overtime calculation
    const leaveConfig = await getLeaveConfig(restaurantId);
    let overtimeHours = 0;
    if (leaveConfig.overtimeEnabled && totalHours > leaveConfig.overtimeAfterHours) {
      overtimeHours = parseFloat((totalHours - leaveConfig.overtimeAfterHours).toFixed(2));
    }

    // Early leave calculation
    let earlyLeaveBy = 0;
    if (leaveConfig.workEndTime) {
      const [endH, endM] = leaveConfig.workEndTime.split(':').map(Number);
      const endMinutes = endH * 60 + endM;
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      if (currentMinutes < endMinutes) {
        earlyLeaveBy = endMinutes - currentMinutes;
      }
    }

    const updateData = {
      clockOut: now.toISOString(),
      clockOutLocation: location || null,
      totalHours,
      overtimeHours,
      earlyLeaveBy,
      updatedAt: now.toISOString(),
    };

    await db.collection('attendance').doc(docId).update(updateData);

    // Remove from live locations when clocking out
    try {
      await db.collection('staffLocations_latest').doc(staffId).delete();
    } catch (e) { /* ignore if doesn't exist */ }

    res.json({ id: docId, ...data, ...updateData });
  } catch (err) {
    console.error('Clock-out error:', err);
    res.status(500).json({ error: 'Failed to clock out' });
  }
});

// ── 3. GET /:restaurantId/today ────────────────────────────────────
router.get('/:restaurantId/today', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const todayStr = getTodayStr();

    const [attendanceSnap, allStaff] = await Promise.all([
      db.collection('attendance')
        .where('restaurantId', '==', restaurantId)
        .where('date', '==', todayStr)
        .get(),
      getAllStaff(restaurantId),
    ]);

    const attendance = attendanceSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const presentIds = new Set(attendance.map(a => a.staffId));
    const staffCount = allStaff.length;
    const presentCount = presentIds.size;
    const absentCount = staffCount - presentCount;

    res.json({ attendance, staffCount, presentCount, absentCount });
  } catch (err) {
    console.error('Today attendance error:', err);
    res.status(500).json({ error: 'Failed to fetch today attendance' });
  }
});

// ── 4. GET /:restaurantId/history ──────────────────────────────────
router.get('/:restaurantId/history', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { startDate, endDate, staffId, status } = req.query;

    let query = db.collection('attendance').where('restaurantId', '==', restaurantId);

    if (staffId) {
      query = query.where('staffId', '==', staffId);
    }

    if (startDate && endDate) {
      query = query.where('date', '>=', startDate).where('date', '<=', endDate);
    }

    query = query.orderBy('date', 'desc');

    const snap = await query.get();
    let records = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    if (status) {
      records = records.filter(r => r.status === status);
    }

    res.json({ records, total: records.length });
  } catch (err) {
    console.error('Attendance history error:', err);
    res.status(500).json({ error: 'Failed to fetch attendance history' });
  }
});

// ── 5. GET /:restaurantId/summary ──────────────────────────────────
router.get('/:restaurantId/summary', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { month } = req.query; // YYYY-MM

    if (!month) {
      return res.status(400).json({ error: 'month query param is required (YYYY-MM)' });
    }

    const [year, mon] = month.split('-').map(Number);
    const startDate = `${month}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    const snap = await db.collection('attendance')
      .where('restaurantId', '==', restaurantId)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    const records = snap.docs.map(d => d.data());

    // Group by staffId
    const grouped = {};
    records.forEach(r => {
      if (!grouped[r.staffId]) {
        grouped[r.staffId] = {
          staffId: r.staffId,
          staffName: r.staffName || '',
          present: 0,
          absent: 0,
          half_day: 0,
          leave: 0,
          holiday: 0,
          totalLateMinutes: 0,
          totalOvertimeHours: 0,
        };
      }
      const g = grouped[r.staffId];
      if (r.status === 'present') g.present++;
      else if (r.status === 'absent') g.absent++;
      else if (r.status === 'half_day') g.half_day++;
      else if (r.status === 'leave') g.leave++;
      else if (r.status === 'holiday') g.holiday++;
      g.totalLateMinutes += r.lateBy || 0;
      g.totalOvertimeHours += r.overtimeHours || 0;
    });

    const summary = Object.values(grouped);
    res.json({ summary });
  } catch (err) {
    console.error('Attendance summary error:', err);
    res.status(500).json({ error: 'Failed to fetch attendance summary' });
  }
});

// ── 6. POST /:restaurantId/manual-entry ────────────────────────────
router.post('/:restaurantId/manual-entry', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can create manual entries' });
    }

    const { staffId, staffName, date, status, clockIn, clockOut, notes } = req.body;

    if (!staffId || !date || !status) {
      return res.status(400).json({ error: 'staffId, date, and status are required' });
    }

    let totalHours = 0;
    if (clockIn && clockOut) {
      const inTime = new Date(clockIn);
      const outTime = new Date(clockOut);
      totalHours = parseFloat(((outTime - inTime) / (1000 * 60 * 60)).toFixed(2));
    }

    const docId = `${staffId}_${date}`;
    const now = new Date().toISOString();

    const attendanceData = {
      staffId,
      staffName: staffName || '',
      restaurantId,
      date,
      status,
      clockIn: clockIn || null,
      clockOut: clockOut || null,
      totalHours,
      notes: notes || '',
      manualEntry: true,
      enteredBy: req.user?.userId || req.user?.id,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection('attendance').doc(docId).set(attendanceData);

    res.json({ id: docId, ...attendanceData });
  } catch (err) {
    console.error('Manual entry error:', err);
    res.status(500).json({ error: 'Failed to create manual entry' });
  }
});

// ── 7. POST /:restaurantId/leave/apply ─────────────────────────────
router.post('/:restaurantId/leave/apply', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { staffId, staffName, leaveType, startDate, endDate, isHalfDay, halfDayType, reason } = req.body;

    if (!staffId || !leaveType || !startDate) {
      return res.status(400).json({ error: 'staffId, leaveType, and startDate are required' });
    }

    // Calculate total days
    let totalDays = 0;
    if (isHalfDay) {
      totalDays = 0.5;
    } else {
      const start = new Date(startDate);
      const end = new Date(endDate || startDate);
      let count = 0;
      const current = new Date(start);
      while (current <= end) {
        const day = current.getDay();
        if (day !== 0 && day !== 6) { // Exclude weekends
          count++;
        }
        current.setDate(current.getDate() + 1);
      }
      totalDays = count || 1;
    }

    // Check leave balance
    const leaveConfig = await getLeaveConfig(restaurantId);
    const leaveYear = getLeaveYear(leaveConfig.yearStart || 4);
    const balanceDocId = `${staffId}_${leaveYear}`;
    const balanceDoc = await db.collection('leaveBalances').doc(balanceDocId).get();

    if (balanceDoc.exists) {
      const balances = balanceDoc.data().balances || {};
      const typeBalance = balances[leaveType];
      if (typeBalance && typeBalance.remaining < totalDays) {
        return res.status(400).json({ error: 'Insufficient leave balance' });
      }
    }

    const now = new Date().toISOString();
    const leaveData = {
      staffId,
      staffName: staffName || '',
      restaurantId,
      leaveType,
      startDate,
      endDate: endDate || startDate,
      isHalfDay: isHalfDay || false,
      halfDayType: halfDayType || null,
      reason: reason || '',
      totalDays,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await db.collection('leaveRequests').add(leaveData);

    res.json({ id: docRef.id, ...leaveData });
  } catch (err) {
    console.error('Leave apply error:', err);
    res.status(500).json({ error: 'Failed to apply for leave' });
  }
});

// ── 8. PATCH /:restaurantId/leave/:id/approve ──────────────────────
router.patch('/:restaurantId/leave/:id/approve', async (req, res) => {
  try {
    const { restaurantId, id } = req.params;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can approve leave' });
    }

    const leaveDoc = await db.collection('leaveRequests').doc(id).get();
    if (!leaveDoc.exists) {
      return res.status(404).json({ error: 'Leave request not found' });
    }

    const leaveData = leaveDoc.data();
    if (leaveData.status !== 'pending') {
      return res.status(400).json({ error: `Leave request is already ${leaveData.status}` });
    }

    const now = new Date().toISOString();
    const approvedBy = req.user?.userId || req.user?.id;

    // Update leave request
    await db.collection('leaveRequests').doc(id).update({
      status: 'approved',
      approvedBy,
      approvedAt: now,
      updatedAt: now,
    });

    // Deduct from leave balances
    const leaveConfig = await getLeaveConfig(restaurantId);
    const leaveYear = getLeaveYear(leaveConfig.yearStart || 4);
    const balanceDocId = `${leaveData.staffId}_${leaveYear}`;
    const balanceDoc = await db.collection('leaveBalances').doc(balanceDocId).get();

    if (balanceDoc.exists) {
      const balances = balanceDoc.data().balances || {};
      const typeBalance = balances[leaveData.leaveType];
      if (typeBalance) {
        typeBalance.used = (typeBalance.used || 0) + leaveData.totalDays;
        typeBalance.remaining = (typeBalance.remaining || 0) - leaveData.totalDays;
        balances[leaveData.leaveType] = typeBalance;
        await db.collection('leaveBalances').doc(balanceDocId).update({ balances, updatedAt: now });
      }
    }

    // Create attendance docs for each leave day
    const start = new Date(leaveData.startDate);
    const end = new Date(leaveData.endDate);
    const current = new Date(start);
    const batch = db.batch();

    while (current <= end) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) {
        const dateStr = current.toISOString().split('T')[0];
        const attDocId = `${leaveData.staffId}_${dateStr}`;
        const attRef = db.collection('attendance').doc(attDocId);
        batch.set(attRef, {
          staffId: leaveData.staffId,
          staffName: leaveData.staffName || '',
          restaurantId,
          date: dateStr,
          status: 'leave',
          leaveType: leaveData.leaveType,
          leaveRequestId: id,
          isHalfDay: leaveData.isHalfDay || false,
          createdAt: now,
          updatedAt: now,
        });
      }
      current.setDate(current.getDate() + 1);
    }

    await batch.commit();

    const updatedDoc = await db.collection('leaveRequests').doc(id).get();
    res.json({ id, ...updatedDoc.data() });
  } catch (err) {
    console.error('Leave approve error:', err);
    res.status(500).json({ error: 'Failed to approve leave' });
  }
});

// ── 9. PATCH /:restaurantId/leave/:id/reject ───────────────────────
router.patch('/:restaurantId/leave/:id/reject', async (req, res) => {
  try {
    const { restaurantId, id } = req.params;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can reject leave' });
    }

    const leaveDoc = await db.collection('leaveRequests').doc(id).get();
    if (!leaveDoc.exists) {
      return res.status(404).json({ error: 'Leave request not found' });
    }

    const leaveData = leaveDoc.data();
    if (leaveData.status !== 'pending') {
      return res.status(400).json({ error: `Leave request is already ${leaveData.status}` });
    }

    const { reason } = req.body;
    const now = new Date().toISOString();

    await db.collection('leaveRequests').doc(id).update({
      status: 'rejected',
      rejectedReason: reason || '',
      approvedBy: req.user?.userId || req.user?.id,
      updatedAt: now,
    });

    const updatedDoc = await db.collection('leaveRequests').doc(id).get();
    res.json({ id, ...updatedDoc.data() });
  } catch (err) {
    console.error('Leave reject error:', err);
    res.status(500).json({ error: 'Failed to reject leave' });
  }
});

// ── 10. GET /:restaurantId/leave/requests ──────────────────────────
router.get('/:restaurantId/leave/requests', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, staffId } = req.query;

    let query = db.collection('leaveRequests').where('restaurantId', '==', restaurantId);

    if (status) {
      query = query.where('status', '==', status);
    }

    if (staffId) {
      query = query.where('staffId', '==', staffId);
    }

    query = query.orderBy('createdAt', 'desc');

    const snap = await query.get();
    const requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ requests, total: requests.length });
  } catch (err) {
    console.error('Leave requests error:', err);
    res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

// ── 11. GET /:restaurantId/leave/balances/:staffId ─────────────────
router.get('/:restaurantId/leave/balances/:staffId', async (req, res) => {
  try {
    const { restaurantId, staffId } = req.params;

    const leaveConfig = await getLeaveConfig(restaurantId);
    const leaveYear = getLeaveYear(leaveConfig.yearStart || 4);
    const balanceDocId = `${staffId}_${leaveYear}`;

    const doc = await db.collection('leaveBalances').doc(balanceDocId).get();
    if (!doc.exists) {
      return res.json({ id: balanceDocId, staffId, year: leaveYear, balances: {} });
    }

    res.json({ id: doc.id, ...doc.data() });
  } catch (err) {
    console.error('Leave balances error:', err);
    res.status(500).json({ error: 'Failed to fetch leave balances' });
  }
});

// ── 12. GET /:restaurantId/leave/config ────────────────────────────
router.get('/:restaurantId/leave/config', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const config = await getLeaveConfig(restaurantId);
    res.json(config);
  } catch (err) {
    console.error('Leave config fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch leave config' });
  }
});

// ── 13. PUT /:restaurantId/leave/config ────────────────────────────
router.put('/:restaurantId/leave/config', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can update leave config' });
    }

    const configData = {
      ...req.body,
      restaurantId,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.userId || req.user?.id,
    };

    await db.collection('leaveConfig').doc(restaurantId).set(configData, { merge: true });

    const updatedDoc = await db.collection('leaveConfig').doc(restaurantId).get();
    res.json({ id: updatedDoc.id, ...updatedDoc.data() });
  } catch (err) {
    console.error('Leave config update error:', err);
    res.status(500).json({ error: 'Failed to update leave config' });
  }
});

// ── 14. POST /:restaurantId/leave/config/init-balances ─────────────
router.post('/:restaurantId/leave/config/init-balances', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can initialize balances' });
    }

    const leaveConfig = await getLeaveConfig(restaurantId);
    const requestedYear = req.body.year;
    const leaveYear = requestedYear || getLeaveYear(leaveConfig.yearStart || 4);

    const allStaff = await getAllStaff(restaurantId);

    const batch = db.batch();
    let count = 0;

    for (const staff of allStaff) {
      const staffId = staff.id;
      const balanceDocId = `${staffId}_${leaveYear}`;
      const ref = db.collection('leaveBalances').doc(balanceDocId);

      const balances = {};
      (leaveConfig.leaveTypes || []).forEach(lt => {
        balances[lt.id] = {
          name: lt.name,
          shortName: lt.shortName,
          total: lt.paidLeaves,
          used: 0,
          remaining: lt.paidLeaves,
          carryForward: lt.carryForward || false,
        };
      });

      batch.set(ref, {
        staffId,
        staffName: staff.staffName || staff.name || '',
        restaurantId,
        year: leaveYear,
        balances,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      count++;
    }

    await batch.commit();

    res.json({ initialized: count });
  } catch (err) {
    console.error('Init balances error:', err);
    res.status(500).json({ error: 'Failed to initialize leave balances' });
  }
});

// ── 15. GET /:restaurantId/payroll-data ────────────────────────────
router.get('/:restaurantId/payroll-data', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { month } = req.query; // YYYY-MM

    if (!month) {
      return res.status(400).json({ error: 'month query param is required (YYYY-MM)' });
    }

    const [year, mon] = month.split('-').map(Number);
    const startDate = `${month}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    const leaveConfig = await getLeaveConfig(restaurantId);
    const weeklyOff = leaveConfig.weeklyOff || [0];

    // Calculate working days for the month
    let workingDays = 0;
    const current = new Date(year, mon - 1, 1);
    while (current.getMonth() === mon - 1) {
      if (!weeklyOff.includes(current.getDay())) {
        workingDays++;
      }
      current.setDate(current.getDate() + 1);
    }

    // Query attendance for the month
    const snap = await db.collection('attendance')
      .where('restaurantId', '==', restaurantId)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    const records = snap.docs.map(d => d.data());

    // Group by staffId
    const grouped = {};
    records.forEach(r => {
      if (!grouped[r.staffId]) {
        grouped[r.staffId] = {
          staffId: r.staffId,
          staffName: r.staffName || '',
          presentDays: 0,
          paidLeaveDays: 0,
          lopDays: 0,
          overtimeHours: 0,
        };
      }
      const g = grouped[r.staffId];
      if (r.status === 'present') {
        g.presentDays++;
      } else if (r.status === 'leave') {
        g.paidLeaveDays++;
      } else if (r.status === 'half_day') {
        g.presentDays += 0.5;
      }
      g.overtimeHours += r.overtimeHours || 0;
    });

    // Calculate LOP days
    const staffData = Object.values(grouped).map(s => {
      s.lopDays = Math.max(0, workingDays - s.presentDays - s.paidLeaveDays);
      s.overtimeHours = parseFloat(s.overtimeHours.toFixed(2));
      return s;
    });

    res.json({ month, workingDays, staffData });
  } catch (err) {
    console.error('Payroll data error:', err);
    res.status(500).json({ error: 'Failed to fetch payroll data' });
  }
});

// ── 16. POST /:restaurantId/location-ping ────────────────────────
// Receives periodic GPS pings from mobile app during active shift
router.post('/:restaurantId/location-ping', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { staffId, staffName, lat, lng, accuracy, speed, heading, timestamp } = req.body;

    if (!staffId || lat == null || lng == null) {
      return res.status(400).json({ error: 'staffId, lat, and lng are required' });
    }

    const now = new Date();
    const dateStr = (timestamp ? new Date(timestamp) : now).toISOString().split('T')[0];
    const ts = timestamp || now.toISOString();

    // Store in location history
    const historyDocId = `${staffId}_${dateStr}_${now.getTime()}`;
    const locationData = {
      staffId,
      staffName: staffName || '',
      restaurantId,
      date: dateStr,
      lat, lng,
      accuracy: accuracy || null,
      speed: speed || null,
      heading: heading || null,
      timestamp: ts,
      createdAt: now.toISOString(),
    };
    await db.collection('staffLocations').doc(historyDocId).set(locationData);

    // Update latest location (for live map)
    await db.collection('staffLocations_latest').doc(staffId).set({
      staffId,
      staffName: staffName || '',
      restaurantId,
      lat, lng,
      accuracy: accuracy || null,
      speed: speed || null,
      heading: heading || null,
      timestamp: ts,
      updatedAt: now.toISOString(),
    });

    // Push real-time update via Pusher
    try {
      await pusherService.triggerOrderEvent(restaurantId, 'staff-location-updated', {
        staffId, staffName: staffName || '', lat, lng, speed, heading,
      });
    } catch (e) { /* Pusher failure shouldn't block response */ }

    res.json({ ok: true });
  } catch (err) {
    console.error('Location ping error:', err);
    res.status(500).json({ error: 'Failed to store location ping' });
  }
});

// ── 17. GET /:restaurantId/live-locations ────────────────────────
// Returns latest location of all currently tracked staff (for live map)
router.get('/:restaurantId/live-locations', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can view live locations' });
    }

    const snap = await db.collection('staffLocations_latest')
      .where('restaurantId', '==', restaurantId)
      .get();

    const locations = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    res.json({ locations });
  } catch (err) {
    console.error('Live locations error:', err);
    res.status(500).json({ error: 'Failed to fetch live locations' });
  }
});

// ── 18. GET /:restaurantId/location-history/:staffId ─────────────
// Returns full location trail for a staff member on a given date (for route replay)
router.get('/:restaurantId/location-history/:staffId', async (req, res) => {
  try {
    const { restaurantId, staffId } = req.params;
    const { date } = req.query;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can view location history' });
    }

    if (!date) {
      return res.status(400).json({ error: 'date query param is required (YYYY-MM-DD)' });
    }

    const snap = await db.collection('staffLocations')
      .where('restaurantId', '==', restaurantId)
      .where('staffId', '==', staffId)
      .where('date', '==', date)
      .orderBy('timestamp', 'asc')
      .get();

    const locations = snap.docs.map(d => {
      const data = d.data();
      return {
        lat: data.lat,
        lng: data.lng,
        accuracy: data.accuracy,
        speed: data.speed,
        heading: data.heading,
        timestamp: data.timestamp,
      };
    });

    res.json({ staffId, date, locations, count: locations.length });
  } catch (err) {
    console.error('Location history error:', err);
    res.status(500).json({ error: 'Failed to fetch location history' });
  }
});

// ── 19. GET /:restaurantId/tracking-config ───────────────────────
// Returns which staff/roles have continuous tracking enabled
router.get('/:restaurantId/tracking-config', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const config = await getLeaveConfig(restaurantId);
    const trackingConfig = config.trackingConfig || {
      enabledStaffIds: [],
      enabledRoles: [],
    };
    res.json(trackingConfig);
  } catch (err) {
    console.error('Tracking config fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch tracking config' });
  }
});

// ── 20. PUT /:restaurantId/tracking-config ───────────────────────
// Admin updates which staff/roles should be continuously tracked
router.put('/:restaurantId/tracking-config', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userRole = req.user?.role;

    if (!isAdminRole(userRole)) {
      return res.status(403).json({ error: 'Only owner, admin, or manager can update tracking config' });
    }

    const { enabledStaffIds, enabledRoles } = req.body;

    const trackingConfig = {
      enabledStaffIds: enabledStaffIds || [],
      enabledRoles: enabledRoles || [],
      updatedAt: new Date().toISOString(),
      updatedBy: req.user?.userId || req.user?.id,
    };

    await db.collection('leaveConfig').doc(restaurantId).set(
      { trackingConfig },
      { merge: true }
    );

    res.json(trackingConfig);
  } catch (err) {
    console.error('Tracking config update error:', err);
    res.status(500).json({ error: 'Failed to update tracking config' });
  }
});

module.exports = router;
