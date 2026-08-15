// Counter verification — the core loop. Staff scans an employee QR (or passes employeeId);
// we validate entitlement + serving window + daily limits, split the price into subsidy/copay,
// settle the copay (wallet debit / payroll accrual / cash), record the consumption and push a
// live-count event.
const express = require('express');
const router = express.Router();
const { db, nowTs } = require('./_shared');
const { computeSplit } = require('../../services/corporate/subsidyEngine');
const { recordConsumption, usedSubsidy, countToday } = require('../../services/corporate/consumptionService');
const pusher = require('../../services/firebaseRealtimeService');

const EMP = 'employees';
const PERIODS = 'mealPeriods';
const CLIENTS = 'corporateClients';

// "now" as HH:MM and YYYY-MM-DD in a given IANA timezone
function nowInTz(tz) {
  const d = new Date();
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { hm: t, date: ymd };
}

async function findEmployee(req, { qrToken, employeeId }) {
  if (employeeId) {
    const d = await db.collection(EMP).doc(employeeId).get();
    if (d.exists && d.data().restaurantId === req.corporateRestaurantId) return { id: d.id, ...d.data() };
    return null;
  }
  if (qrToken) {
    const snap = await db.collection(EMP)
      .where('restaurantId', '==', req.corporateRestaurantId)
      .where('qrToken', '==', String(qrToken))
      .limit(1).get();
    if (!snap.empty) { const d = snap.docs[0]; return { id: d.id, ...d.data() }; }
  }
  return null;
}

// POST /api/corporate/verify  { qrToken|employeeId, periodId, payMethod?, force? }
router.post('/', async (req, res) => {
  try {
    const { qrToken, employeeId, periodId, payMethod: reqPay, force } = req.body || {};
    if (!periodId) return res.status(400).json({ error: 'periodId is required' });

    // 1) Employee
    const emp = await findEmployee(req, { qrToken, employeeId });
    if (!emp) return res.status(404).json({ code: 'EMPLOYEE_NOT_FOUND', error: 'Employee not found' });
    if (emp.status !== 'active') return res.status(403).json({ code: 'EMPLOYEE_INACTIVE', error: 'Employee is inactive' });

    // 2) Period
    const pDoc = await db.collection(PERIODS).doc(periodId).get();
    if (!pDoc.exists || pDoc.data().restaurantId !== req.corporateRestaurantId) return res.status(404).json({ code: 'PERIOD_NOT_FOUND', error: 'Meal period not found' });
    const period = { id: pDoc.id, ...pDoc.data() };
    if (period.active === false) return res.status(403).json({ code: 'PERIOD_INACTIVE', error: 'Meal period is not active' });

    // 3) Entitlement (allowed periods)
    const allowed = emp.entitlement?.periods || [];
    if (allowed.length > 0 && !allowed.includes(periodId)) {
      return res.status(403).json({ code: 'NOT_ENTITLED', error: 'Employee not entitled to this meal' });
    }

    // 4) Serving window + day (site timezone)
    const site = emp.siteId ? await db.collection('corporateSites').doc(emp.siteId).get() : null;
    const tz = site?.exists ? (site.data().timezone || 'Asia/Kolkata') : 'Asia/Kolkata';
    const { hm, date } = nowInTz(tz);
    if (!force && period.startTime && period.endTime && (hm < period.startTime || hm > period.endTime)) {
      return res.status(409).json({ code: 'OUTSIDE_WINDOW', error: `Outside serving window (${period.startTime}–${period.endTime})` });
    }

    // 5) Already consumed this period today?
    const already = await countToday(emp.id, periodId, date);
    if (already >= 1 && !force) {
      return res.status(409).json({ code: 'ALREADY_CONSUMED', error: 'Already consumed this meal today' });
    }
    // Daily total cap
    const dailyCap = Number(emp.entitlement?.dailyCap) || 0;
    if (dailyCap > 0) {
      const snap = await db.collection('mealConsumptions').where('employeeId', '==', emp.id).where('date', '==', date).get();
      let total = 0; snap.forEach(d => { if (d.data().status !== 'reversed') total++; });
      if (total >= dailyCap && !force) return res.status(409).json({ code: 'DAILY_CAP', error: 'Daily meal limit reached' });
    }

    // 6) Client + subsidy split
    const cDoc = await db.collection(CLIENTS).doc(emp.clientId).get();
    if (!cDoc.exists) return res.status(404).json({ code: 'CLIENT_NOT_FOUND', error: 'Client not found' });
    const client = cDoc.data();
    const price = Number(period.price) || 0;
    const used = await usedSubsidy(emp.id, date.slice(0, 7), date); // month prefix YYYY-MM
    const { subsidy, copay } = computeSplit({
      price,
      policy: client.subsidyPolicy,
      periodOverride: period.subsidyOverride,
      dayUsedSubsidy: used.day,
      monthUsedSubsidy: used.month,
    });

    // 7) Payment method
    const model = client.paymentModel || 'prepaid_wallet';
    let payMethod = reqPay || (model === 'postpaid_payroll' ? 'payroll' : 'wallet');
    if (payMethod === 'pluxee') return res.status(400).json({ code: 'PLUXEE_OFF', error: 'Pluxee is not enabled' });
    if (!['wallet', 'payroll', 'cash'].includes(payMethod)) payMethod = 'wallet';

    // 8) Record (transactional wallet debit if applicable)
    let result;
    try {
      result = await recordConsumption({
        restaurantId: req.corporateRestaurantId,
        employeeId: emp.id, clientId: emp.clientId, siteId: emp.siteId, periodId, date,
        price, subsidy, copay, payMethod, paymentModel: model,
        verifiedBy: req.user?.id || req.user?.userId || null,
      });
    } catch (err) {
      if (err.message === 'INSUFFICIENT_WALLET') {
        return res.status(402).json({ code: 'INSUFFICIENT_WALLET', error: 'Insufficient wallet balance', copay });
      }
      throw err;
    }

    // 9) Live-count event (best-effort)
    try {
      await pusher.pushEvent(req.corporateRestaurantId, 'corporate', 'meal-consumed', {
        siteId: emp.siteId, periodId, date, employeeId: emp.id, ts: Date.now(),
      });
    } catch (_) { /* non-blocking */ }

    res.json({
      ok: true,
      employee: { id: emp.id, name: emp.name, empCode: emp.empCode },
      period: { id: period.id, name: period.name },
      price, subsidy, copay, payMethod,
      walletBalance: result.walletBalance,
      consumptionId: result.consumptionId,
      at: nowTs(),
    });
  } catch (e) {
    console.error('verify error', e.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

module.exports = router;
