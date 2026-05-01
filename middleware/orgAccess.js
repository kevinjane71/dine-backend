const { db, collections } = require('../firebase');

/**
 * Resolves the effective owner ID from the JWT.
 * Admin co-owners have ownerId pointing to the actual owner's userId.
 */
function getOwnerId(req) {
  return req.user.role === 'admin' ? req.user.ownerId : (req.user.userId || req.user.id);
}

/**
 * Middleware: Verify user belongs to the organization.
 * Reads orgId from req.params.orgId.
 * Sets req.org = { id, ...orgData } on success.
 */
async function requireOrgAccess(req, res, next) {
  try {
    const orgId = req.params.orgId;
    if (!orgId) {
      return res.status(400).json({ error: 'Organization ID required' });
    }

    const orgDoc = await db.collection(collections.organizations).doc(orgId).get();
    if (!orgDoc.exists) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const org = orgDoc.data();
    const userId = getOwnerId(req);

    if (org.ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied. Not a member of this organization.' });
    }

    req.org = { id: orgDoc.id, ...org };
    next();
  } catch (error) {
    console.error('Org access check error:', error.message);
    return res.status(500).json({ error: 'Failed to verify organization access' });
  }
}

/**
 * Middleware factory: Check that a specific feature is enabled in org settings.
 * Must be used AFTER requireOrgAccess (needs req.org).
 * @param {string} featureKey - Key in org.settings (e.g. 'centralizedMenu', 'centralKitchen', 'centralWarehouse')
 */
function requireOrgFeature(featureKey) {
  return (req, res, next) => {
    if (!req.org) {
      return res.status(500).json({ error: 'Organization context not loaded. Use requireOrgAccess first.' });
    }
    if (!req.org.settings || !req.org.settings[featureKey]) {
      return res.status(403).json({
        error: `Feature '${featureKey}' is not enabled for this organization.`
      });
    }
    next();
  };
}

/**
 * Helper: Verify that a restaurant belongs to the organization.
 * @param {string} orgId
 * @param {string} restaurantId
 * @returns {boolean}
 */
async function isRestaurantInOrg(orgId, restaurantId) {
  const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
  if (!restaurantDoc.exists) return false;
  return restaurantDoc.data().organizationId === orgId;
}

/**
 * Helper: Get all outlet restaurant IDs for an organization.
 * @param {string} orgId
 * @returns {Array<{id, name, outletType, outletCode}>}
 */
async function getOrgOutlets(orgId) {
  const snapshot = await db.collection(collections.restaurants)
    .where('organizationId', '==', orgId)
    .get();

  const outlets = [];
  snapshot.forEach(doc => {
    const data = doc.data();
    outlets.push({
      id: doc.id,
      name: data.name,
      outletType: data.outletType || 'outlet',
      outletCode: data.outletCode || null,
      address: data.address || '',
      status: data.status || 'active'
    });
  });
  return outlets;
}

module.exports = {
  requireOrgAccess,
  requireOrgFeature,
  isRestaurantInOrg,
  getOrgOutlets,
  getOwnerId
};
