module.exports = function initializeInvoiceRoutes(db, collections) {
  const router = require('express').Router();
  const { authenticateToken } = require('../middleware/auth');

  // Apply auth to all invoice routes
  router.use(authenticateToken);

  // Mount sub-routes
  const organizationsRoutes = require('./routes/organizations')(db, collections);
  router.use('/organizations', organizationsRoutes);

  const customersRoutes = require('./routes/customers')(db, collections);
  router.use('/customers', customersRoutes);

  const itemsRoutes = require('./routes/items')(db, collections);
  router.use('/items', itemsRoutes);

  const invoicesRoutes = require('./routes/invoices')(db, collections);
  router.use('/invoices', invoicesRoutes);

  const quotesRoutes = require('./routes/quotes')(db, collections);
  router.use('/quotes', quotesRoutes);

  const challansRoutes = require('./routes/challans')(db, collections);
  router.use('/challans', challansRoutes);

  const paymentsRoutes = require('./routes/payments')(db, collections);
  router.use('/payments', paymentsRoutes);

  const expensesRoutes = require('./routes/expenses')(db, collections);
  router.use('/expenses', expensesRoutes);

  const reportsRoutes = require('./routes/reports')(db, collections);
  router.use('/reports', reportsRoutes);

  const settingsRoutes = require('./routes/settings')(db, collections);
  router.use('/settings', settingsRoutes);

  const aiRoutes = require('./routes/ai')(db, collections);
  router.use('/ai', aiRoutes);

  return router;
};
