// Corporate Meal module gate.
// Every /api/corporate route passes through here. If the caller's restaurant does not have
// `settings.features.corporateMeal === true`, the whole module is invisible (404). This keeps
// the feature fully additive — no existing (non-corporate) restaurant is affected in any way.
const { db } = require('../firebase');

module.exports = async function requireCorporateMeal(req, res, next) {
  try {
    const restaurantId =
      req.user?.restaurantId ||
      req.params?.restaurantId ||
      req.query?.restaurantId ||
      req.body?.restaurantId ||
      null;

    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }

    const doc = await db.collection('restaurants').doc(restaurantId).get();
    const enabled = doc.exists && doc.data()?.settings?.features?.corporateMeal === true;
    if (!enabled) {
      // 404 (not 403) so the module is undiscoverable when off.
      return res.status(404).json({ error: 'Not found' });
    }

    // Stash resolved context for downstream handlers.
    req.corporateRestaurantId = restaurantId;
    req.corporateOrgId = doc.data()?.organizationId || null;
    next();
  } catch (err) {
    console.error('requireCorporateMeal error:', err.message);
    res.status(500).json({ error: 'Corporate meal gate failed' });
  }
};
