const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// ── GET /api/payroll/:restaurantId/config ─────────────────────────
// Get salary configurations for all staff
router.get('/:restaurantId/config', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snap = await db.collection('payrollConfig')
      .where('restaurantId', '==', restaurantId)
      .orderBy('staffName', 'asc')
      .get();

    const configs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ configs, total: configs.length });
  } catch (err) {
    console.error('Payroll config fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch payroll config' });
  }
});

// ── POST /api/payroll/:restaurantId/config ────────────────────────
// Create or update salary config for a staff member
router.post('/:restaurantId/config', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { staffId, staffName, role, baseSalary, allowances, deductions, payFrequency, bankAccount } = req.body;

    if (!staffId || !baseSalary) {
      return res.status(400).json({ error: 'staffId and baseSalary are required' });
    }

    // Check if config already exists for this staff
    const existing = await db.collection('payrollConfig')
      .where('restaurantId', '==', restaurantId)
      .where('staffId', '==', staffId)
      .limit(1)
      .get();

    const allow = allowances || { hra: 0, travel: 0, food: 0 };
    const deduct = deductions || { pf: 0, tax: 0, other: 0 };
    const grossPay = parseFloat(baseSalary) +
      Object.values(allow).reduce((s, v) => s + parseFloat(v || 0), 0);
    const totalDeductions = Object.values(deduct).reduce((s, v) => s + parseFloat(v || 0), 0);
    const netPay = grossPay - totalDeductions;

    const data = {
      restaurantId,
      staffId,
      staffName: staffName || '',
      role: role || '',
      baseSalary: parseFloat(baseSalary),
      allowances: allow,
      deductions: deduct,
      grossPay,
      totalDeductions,
      netPay,
      payFrequency: payFrequency || 'monthly',
      bankAccount: bankAccount || '',
      updatedAt: new Date(),
    };

    if (!existing.empty) {
      await existing.docs[0].ref.update(data);
      res.json({ id: existing.docs[0].id, ...data, message: 'Salary config updated' });
    } else {
      data.createdAt = new Date();
      data.createdBy = req.user?.userId || req.user?.id;
      const docRef = await db.collection('payrollConfig').add(data);
      res.status(201).json({ id: docRef.id, ...data, message: 'Salary config created' });
    }
  } catch (err) {
    console.error('Payroll config save error:', err);
    res.status(500).json({ error: 'Failed to save payroll config' });
  }
});

// ── GET /api/payroll/:restaurantId/runs ───────────────────────────
// List payroll runs
router.get('/:restaurantId/runs', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snap = await db.collection('payrollRuns')
      .where('restaurantId', '==', restaurantId)
      .orderBy('createdAt', 'desc')
      .get();

    const runs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ runs, total: runs.length });
  } catch (err) {
    console.error('Payroll runs fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch payroll runs' });
  }
});

// ── POST /api/payroll/:restaurantId/runs ──────────────────────────
// Generate a payroll run for a specific month
router.post('/:restaurantId/runs', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { month } = req.body; // format: '2026-04'

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month is required in YYYY-MM format' });
    }

    // Check if run already exists for this month
    const existingRun = await db.collection('payrollRuns')
      .where('restaurantId', '==', restaurantId)
      .where('month', '==', month)
      .limit(1)
      .get();

    if (!existingRun.empty) {
      return res.status(400).json({ error: `Payroll run already exists for ${month}`, existingRunId: existingRun.docs[0].id });
    }

    // Get all salary configs
    const configSnap = await db.collection('payrollConfig')
      .where('restaurantId', '==', restaurantId)
      .get();

    if (configSnap.empty) {
      return res.status(400).json({ error: 'No salary configurations found. Please configure staff salaries first.' });
    }

    const batch = db.batch();
    const userId = req.user?.userId || req.user?.id;

    // Fetch attendance data for this month (if available)
    const [year, mon] = month.split('-').map(Number);
    const startDate = `${month}-01`;
    const lastDay = new Date(year, mon, 0).getDate();
    const endDate = `${month}-${String(lastDay).padStart(2, '0')}`;

    // Calculate working days (exclude weekly offs)
    let leaveConfig = null;
    try {
      const lcDoc = await db.collection('leaveConfig').doc(restaurantId).get();
      if (lcDoc.exists) leaveConfig = lcDoc.data();
    } catch (e) { /* no leave config, skip attendance integration */ }

    const weeklyOff = leaveConfig?.weeklyOff || [0]; // default Sunday
    const holidays = (leaveConfig?.holidays || []).map(h => h.date);
    let workingDays = 0;
    for (let d = 1; d <= lastDay; d++) {
      const date = new Date(year, mon - 1, d);
      const dayOfWeek = date.getDay();
      const dateStr = `${month}-${String(d).padStart(2, '0')}`;
      if (!weeklyOff.includes(dayOfWeek) && !holidays.includes(dateStr)) {
        workingDays++;
      }
    }

    // Fetch attendance records for the month
    const attendanceSnap = await db.collection('attendance')
      .where('restaurantId', '==', restaurantId)
      .where('date', '>=', startDate)
      .where('date', '<=', endDate)
      .get();

    // Build attendance map: staffId -> { presentDays, paidLeaveDays, overtimeHours }
    const attendanceMap = {};
    attendanceSnap.docs.forEach(doc => {
      const a = doc.data();
      if (!attendanceMap[a.staffId]) {
        attendanceMap[a.staffId] = { presentDays: 0, paidLeaveDays: 0, overtimeHours: 0 };
      }
      const entry = attendanceMap[a.staffId];
      if (a.status === 'present') {
        entry.presentDays++;
        entry.overtimeHours += (a.overtimeHours || 0);
      } else if (a.status === 'half_day') {
        entry.presentDays += 0.5;
      } else if (a.status === 'leave') {
        entry.paidLeaveDays++;
      }
    });

    const hasAttendanceData = attendanceSnap.docs.length > 0;

    // Create run doc
    let totalGross = 0, totalDeductions = 0, totalNet = 0;
    const slips = [];

    configSnap.docs.forEach(doc => {
      const cfg = doc.data();
      totalGross += cfg.grossPay || 0;
      totalDeductions += cfg.totalDeductions || 0;
      totalNet += cfg.netPay || 0;
      slips.push(cfg);
    });

    const runRef = db.collection('payrollRuns').doc();
    const runData = {
      restaurantId,
      month,
      totalGross,
      totalDeductions,
      totalNet,
      staffCount: slips.length,
      workingDays,
      hasAttendanceData,
      status: 'draft',
      createdBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    batch.set(runRef, runData);

    // Create pay slips for each staff
    slips.forEach(cfg => {
      const slipRef = db.collection('paySlips').doc();
      const slipData = {
        restaurantId,
        runId: runRef.id,
        staffId: cfg.staffId,
        staffName: cfg.staffName,
        role: cfg.role,
        month,
        baseSalary: cfg.baseSalary,
        allowances: cfg.allowances,
        deductions: cfg.deductions,
        grossPay: cfg.grossPay,
        netPay: cfg.netPay,
        status: 'generated',
        createdAt: new Date(),
      };

      // Add attendance summary if attendance data exists
      if (hasAttendanceData) {
        const att = attendanceMap[cfg.staffId] || { presentDays: 0, paidLeaveDays: 0, overtimeHours: 0 };
        const lopDays = Math.max(0, workingDays - att.presentDays - att.paidLeaveDays);
        const dailyRate = workingDays > 0 ? cfg.grossPay / workingDays : 0;
        const lopDeduction = Math.round(dailyRate * lopDays * 100) / 100;
        const overtimePay = leaveConfig?.overtimeEnabled
          ? Math.round((dailyRate / (leaveConfig.overtimeAfterHours || 9)) * 1.5 * att.overtimeHours * 100) / 100
          : 0;

        slipData.attendanceSummary = {
          workingDays,
          presentDays: att.presentDays,
          paidLeaveDays: att.paidLeaveDays,
          lopDays,
          overtimeHours: att.overtimeHours,
          lopDeduction,
          overtimePay,
        };
        // Adjust net pay
        slipData.netPay = Math.round((cfg.netPay - lopDeduction + overtimePay) * 100) / 100;
        slipData.lopDeduction = lopDeduction;
        slipData.overtimePay = overtimePay;
      }

      batch.set(slipRef, slipData);
    });

    await batch.commit();

    res.status(201).json({
      id: runRef.id,
      ...runData,
      slipCount: slips.length,
      message: `Payroll run generated for ${month} with ${slips.length} pay slips`,
    });
  } catch (err) {
    console.error('Payroll run generate error:', err);
    res.status(500).json({ error: 'Failed to generate payroll run' });
  }
});

// ── PATCH /api/payroll/:restaurantId/runs/:runId ──────────────────
// Update payroll run status (approve/pay)
router.patch('/:restaurantId/runs/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const { status, paidDate } = req.body;

    if (!status || !['draft', 'approved', 'paid'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Use: draft, approved, paid' });
    }

    const update = { status, updatedAt: new Date() };
    if (status === 'paid') {
      update.paidDate = paidDate ? new Date(paidDate) : new Date();
      update.paidBy = req.user?.userId || req.user?.id;
    }

    await db.collection('payrollRuns').doc(runId).update(update);

    // If marked as paid, update all pay slips too
    if (status === 'paid') {
      const slipSnap = await db.collection('paySlips')
        .where('runId', '==', runId)
        .get();
      const batch = db.batch();
      slipSnap.docs.forEach(doc => {
        batch.update(doc.ref, { status: 'paid', paidDate: update.paidDate });
      });
      await batch.commit();
    }

    res.json({ message: `Payroll run updated to ${status}` });
  } catch (err) {
    console.error('Payroll run update error:', err);
    res.status(500).json({ error: 'Failed to update payroll run' });
  }
});

// ── GET /api/payroll/:restaurantId/runs/:runId/slips ──────────────
// Get pay slips for a specific run
router.get('/:restaurantId/runs/:runId/slips', async (req, res) => {
  try {
    const { runId } = req.params;
    const snap = await db.collection('paySlips')
      .where('runId', '==', runId)
      .orderBy('staffName', 'asc')
      .get();

    const slips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ slips, total: slips.length });
  } catch (err) {
    console.error('Pay slips fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch pay slips' });
  }
});

// ── DELETE /api/payroll/:restaurantId/config/:configId ─────────────
// Delete a salary config
router.delete('/:restaurantId/config/:configId', async (req, res) => {
  try {
    await db.collection('payrollConfig').doc(req.params.configId).delete();
    res.json({ message: 'Salary config deleted' });
  } catch (err) {
    console.error('Payroll config delete error:', err);
    res.status(500).json({ error: 'Failed to delete salary config' });
  }
});

module.exports = router;
