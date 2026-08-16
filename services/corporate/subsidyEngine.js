// Subsidy engine — PURE functions, no I/O. Given a meal price, the client's subsidy policy
// (with optional per-period override) and how much subsidy the employee has already used today
// and this month, compute how the price splits into employer subsidy vs employee copay.
//
// Identical for both payment models — only *settlement* of the copay differs (wallet vs payroll),
// which is handled by consumptionService.

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * @param {object} a
 * @param {number} a.price            meal price (full)
 * @param {object} a.policy           client.subsidyPolicy { rule, employerShare, caps:{perMeal,perDay,perMonth} }
 * @param {object} [a.periodOverride] optional mealPeriod.subsidyOverride (same shape as policy)
 * @param {number} [a.dayUsedSubsidy]   subsidy already granted to this employee today
 * @param {number} [a.monthUsedSubsidy] subsidy already granted to this employee this month
 * @returns {{ subsidy:number, copay:number, rule:string, employerShare:number }}
 */
function computeSplit({ price, policy, periodOverride, dayUsedSubsidy = 0, monthUsedSubsidy = 0 }) {
  const p = periodOverride && (periodOverride.rule || periodOverride.employerShare != null)
    ? periodOverride
    : (policy || {});
  const rule = p.rule === 'flat' ? 'flat' : 'percentage';
  const share = Number(p.employerShare) || 0;
  const caps = p.caps || {};
  const priceN = Math.max(0, Number(price) || 0);

  // Base subsidy from the rule
  let subsidy = rule === 'flat' ? Math.min(share, priceN) : round2(priceN * share / 100);

  // Apply caps (per-meal, then remaining per-day, then remaining per-month)
  if (Number(caps.perMeal) > 0) subsidy = Math.min(subsidy, Number(caps.perMeal));
  if (Number(caps.perDay) > 0) subsidy = Math.min(subsidy, Math.max(0, Number(caps.perDay) - (Number(dayUsedSubsidy) || 0)));
  if (Number(caps.perMonth) > 0) subsidy = Math.min(subsidy, Math.max(0, Number(caps.perMonth) - (Number(monthUsedSubsidy) || 0)));

  subsidy = round2(Math.max(0, Math.min(subsidy, priceN)));
  const copay = round2(priceN - subsidy);
  return { subsidy, copay, rule, employerShare: share };
}

module.exports = { computeSplit, round2 };
