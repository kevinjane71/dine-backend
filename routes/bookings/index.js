const express = require('express');
const router = express.Router();

module.exports = function(db, collections, authenticateToken, checkFeaturePermission) {
  // Mount sub-routers
  const ordersRouter = require('./orders')(db, collections, authenticateToken, checkFeaturePermission);
  const venuesRouter = require('./venues')(db, collections, authenticateToken, checkFeaturePermission);
  const paymentsRouter = require('./payments')(db, collections, authenticateToken, checkFeaturePermission);
  const calendarRouter = require('./calendar')(db, collections, authenticateToken, checkFeaturePermission);

  // Venues routes must be mounted BEFORE orders (to avoid /:bookingId catching "venues")
  router.use('/', venuesRouter);
  // Calendar route must be before orders too
  router.use('/', calendarRouter);
  // Payments (/:bookingId/payment, /:bookingId/complete, /:bookingId/invoice)
  router.use('/', paymentsRouter);
  // Orders (CRUD for bookings - /:restaurantId, /:restaurantId/:bookingId)
  router.use('/', ordersRouter);

  return router;
};
