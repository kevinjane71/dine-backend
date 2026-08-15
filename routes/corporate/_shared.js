// Shared helpers for the Corporate Meal routers. Kept tiny and self-contained so the module
// stays fully isolated from the rest of the backend.
const crypto = require('crypto');
const { db } = require('../../firebase');

// Operator gate: only the caterer's own staff (owner/admin/manager) may manage corporate config
// (clients, sites, employees, pricing, billing). Employees/counter use separate, narrower routes.
function requireOperator(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (!['owner', 'admin', 'manager'].includes(role)) {
    return res.status(403).json({ error: 'Operator role (owner/admin/manager) required' });
  }
  next();
}

const genQrToken = () => 'emp_' + crypto.randomBytes(16).toString('hex');
const nowTs = () => new Date();

// Whitelisted enums
const PAYMENT_MODELS = ['prepaid_wallet', 'postpaid_payroll'];
const SUBSIDY_RULES = ['percentage', 'flat'];

// Default subsidy policy when a client doesn't specify one (no subsidy).
const DEFAULT_SUBSIDY = { rule: 'percentage', employerShare: 0, caps: { perMeal: 0, perDay: 0, perMonth: 0 } };

module.exports = { db, requireOperator, genQrToken, nowTs, PAYMENT_MODELS, SUBSIDY_RULES, DEFAULT_SUBSIDY };
