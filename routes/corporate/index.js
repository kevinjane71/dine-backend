// Corporate Meal Management module router.
// Mounted once in index.js: app.use('/api/corporate', require('./routes/corporate'))
// Every route requires a valid JWT AND the restaurant flag settings.features.corporateMeal.
// Nothing here runs for a normal (non-corporate) restaurant.
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../../middleware/auth');
const requireCorporateMeal = require('../../middleware/requireCorporateMeal');

router.use(authenticateToken);
router.use(requireCorporateMeal);

// Phase 0 — foundation
router.use('/clients', require('./clients'));
router.use('/sites', require('./sites'));
router.use('/employees', require('./employees'));

// Phase 1–3 — meal periods, booking, counter verification, live counts
router.use('/meal-periods', require('./mealPeriods'));
router.use('/bookings', require('./bookings'));
router.use('/verify', require('./verification'));
router.use('/counts', require('./counts'));

// (Phase 4+ mounts land here: billing, reports, pluxee)

module.exports = router;
