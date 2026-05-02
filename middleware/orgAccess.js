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
 * Returns the acting user's ID for audit/createdBy fields.
 * Unlike getOwnerId (which returns the actual owner for admin co-owners),
 * this always returns the person performing the action.
 */
function getActorId(req) {
  return req.user.userId || req.user.id;
}

/**
 * Middleware factory: Verify user is a member of the organization.
 * Replaces requireOwnerRole + requireOrgAccess for routes that staff should access.
 *
 * - Owner/admin: checks org.ownerId match (same as requireOrgAccess)
 * - Staff (manager+): checks their restaurant belongs to this org
 *
 * Sets req.org, and for staff also sets req.staffRestaurantId + req.staffOutletType.
 *
 * @param {Object} options
 * @param {string} options.minRole - Minimum role required (default: 'manager')
 */
function requireOrgMember(options = {}) {
  const minRole = options.minRole || 'manager';
  const roleLevels = { owner: 4, admin: 3, manager: 2, cashier: 1, waiter: 1, employee: 1, sales: 1 };

  return async (req, res, next) => {
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
      const userRole = req.user.role;

      // Owner/admin path — same as existing requireOrgAccess
      if (userRole === 'owner' || userRole === 'admin') {
        const ownerId = getOwnerId(req);
        if (org.ownerId !== ownerId) {
          return res.status(403).json({ error: 'Access denied. Not a member of this organization.' });
        }
        req.org = { id: orgDoc.id, ...org };
        return next();
      }

      // Staff path — check role level
      const userLevel = roleLevels[userRole] || 0;
      const minLevel = roleLevels[minRole] || 2;
      if (userLevel < minLevel) {
        return res.status(403).json({ error: `Access denied. Minimum role '${minRole}' required.` });
      }

      // Staff must have a restaurant assignment
      const staffRestaurantId = req.user.restaurantId;
      if (!staffRestaurantId) {
        return res.status(403).json({ error: 'Access denied. No restaurant assignment found.' });
      }

      // Verify staff's restaurant belongs to this org
      const restaurantDoc = await db.collection(collections.restaurants).doc(staffRestaurantId).get();
      if (!restaurantDoc.exists) {
        return res.status(403).json({ error: 'Access denied. Restaurant not found.' });
      }

      const restaurantData = restaurantDoc.data();
      if (restaurantData.organizationId !== orgId) {
        return res.status(403).json({ error: 'Access denied. Your restaurant is not part of this organization.' });
      }

      req.org = { id: orgDoc.id, ...org };
      req.staffRestaurantId = staffRestaurantId;
      req.staffOutletType = restaurantData.outletType || 'outlet';
      return next();
    } catch (error) {
      console.error('Org member check error:', error.message);
      return res.status(500).json({ error: 'Failed to verify organization membership' });
    }
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
  requireOrgMember,
  isRestaurantInOrg,
  getOrgOutlets,
  getOwnerId,
  getActorId
};
