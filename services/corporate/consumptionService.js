// Consumption service — records a meal consumption and settles the employee copay.
//  - prepaid_wallet + payMethod 'wallet' → atomically debit employee.walletBalance (rejects if short)
//  - postpaid_payroll (payMethod 'payroll') → accrue the copay (recorded, settled via payroll export)
//  - 'cash' → recorded as collected at counter, no wallet touch
// The employer subsidy is always recorded for billing regardless of payment model.
const { db } = require('../../firebase');

const CONS = 'mealConsumptions';
const EMP = 'employees';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Subsidy already granted to an employee today and this month (for cap enforcement).
// Reads the employee's consumptions and filters in memory (small per-employee volume);
// a (employeeId, date) index can optimise this later.
async function usedSubsidy(employeeId, monthPrefix, todayStr) {
  const snap = await db.collection(CONS).where('employeeId', '==', employeeId).get();
  let day = 0, month = 0;
  snap.forEach(d => {
    const x = d.data();
    if (x.status === 'reversed') return;
    const s = Number(x.subsidyAmount) || 0;
    if ((x.date || '').startsWith(monthPrefix)) month += s;
    if (x.date === todayStr) day += s;
  });
  return { day: round2(day), month: round2(month) };
}

// How many times an employee already consumed a given period today (for daily entitlement cap).
async function countToday(employeeId, periodId, todayStr) {
  const snap = await db.collection(CONS)
    .where('employeeId', '==', employeeId)
    .where('date', '==', todayStr)
    .get();
  let n = 0;
  snap.forEach(d => { const x = d.data(); if (x.periodId === periodId && x.status !== 'reversed') n++; });
  return n;
}

/**
 * Record a consumption. Throws 'INSUFFICIENT_WALLET' if a prepaid wallet can't cover the copay.
 * @returns {{ consumptionId:string, walletBalance:number }}
 */
async function recordConsumption(p) {
  const empRef = db.collection(EMP).doc(p.employeeId);
  const consRef = db.collection(CONS).doc();
  let walletBalance = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(empRef);
    if (!snap.exists) throw new Error('Employee not found');
    const emp = snap.data();
    walletBalance = Number(emp.walletBalance) || 0;

    if (p.payMethod === 'wallet') {
      if (walletBalance < p.copay) throw new Error('INSUFFICIENT_WALLET');
      walletBalance = round2(walletBalance - p.copay);
      tx.update(empRef, { walletBalance, updatedAt: new Date() });
    }

    tx.set(consRef, {
      restaurantId: p.restaurantId,
      employeeId: p.employeeId,
      clientId: p.clientId,
      siteId: p.siteId,
      periodId: p.periodId,
      date: p.date,                       // YYYY-MM-DD
      amount: round2(p.price),
      subsidyAmount: round2(p.subsidy),
      employeeCopay: round2(p.copay),
      payMethod: p.payMethod,             // wallet | payroll | cash | pluxee
      paymentModel: p.paymentModel,       // prepaid_wallet | postpaid_payroll
      bookingId: p.bookingId || null,
      verifiedBy: p.verifiedBy || null,
      status: 'consumed',
      createdAt: new Date(),
    });
  });

  return { consumptionId: consRef.id, walletBalance };
}

module.exports = { recordConsumption, usedSubsidy, countToday, round2 };
