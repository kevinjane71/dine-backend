const jwt = require('jsonwebtoken');

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ 
      success: false,
      error: 'Access token required' 
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ 
        success: false,
        error: 'Invalid or expired token' 
      });
    }
    req.user = user;
    next();
  });
};

// Owner role requirement middleware
const requireOwnerRole = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Access denied. Owner role required.' });
  }
  next();
};

// Per-feature operations for granular permissions
const FEATURE_OPS = {
  inventory: ['read', 'add', 'update', 'delete'],
  menu: ['read', 'add', 'update', 'delete', 'markOutOfStock'],
  orders: ['read', 'update', 'cancel', 'refund', 'completeBill'],
  tables: ['read', 'add', 'update', 'delete', 'reset'],
  customers: ['read', 'add', 'update', 'delete'],
  offers: ['read', 'add', 'update', 'delete']
};

/**
 * Resolve permissions for any feature from pageAccess.
 * Handles boolean (legacy) and object (granular) formats.
 */
function resolveFeaturePermissions(pageAccess, feature) {
  const ops = FEATURE_OPS[feature] || ['read', 'add', 'update', 'delete'];
  const val = pageAccess?.[feature];
  if (typeof val === 'object' && val !== null) {
    const result = {};
    for (const op of ops) result[op] = !!val[op];
    return result;
  }
  const boolVal = !!val;
  const result = {};
  for (const op of ops) result[op] = boolVal;
  return result;
}

/**
 * Generic middleware factory for feature+operation permission checks.
 * Owner/admin always pass. Manager allowed by default if no explicit restriction.
 * Checks legacy standalone booleans (completeBill, resetTables) as fallbacks.
 */
function requireFeaturePermission(feature, operation) {
  return async (req, res, next) => {
    try {
      const { role } = req.user;
      if (role === 'owner' || role === 'admin') return next();

      const { db, collections } = require('../firebase');
      const userId = req.user.userId || req.user.id;

      let userDoc = await db.collection(collections.staffUsers).doc(userId).get();
      if (!userDoc.exists) {
        userDoc = await db.collection(collections.users).doc(userId).get();
      }

      if (!userDoc.exists) {
        if (role === 'manager') return next();
        return res.status(403).json({ error: `Access denied. ${feature} ${operation} permission required.` });
      }

      const pageAccess = userDoc.data()?.pageAccess;

      // Legacy standalone boolean fallbacks
      if (feature === 'orders' && operation === 'completeBill' && pageAccess?.completeBill !== undefined) {
        if (!!pageAccess.completeBill) return next();
      }
      if (feature === 'tables' && operation === 'reset' && pageAccess?.resetTables !== undefined) {
        if (!!pageAccess.resetTables) return next();
      }

      const perms = resolveFeaturePermissions(pageAccess, feature);
      if (perms[operation]) return next();

      // Manager fallback: allow if feature key not set at all
      if (role === 'manager' && pageAccess?.[feature] === undefined) return next();

      return res.status(403).json({ error: `Access denied. ${feature} ${operation} permission required.` });
    } catch (err) {
      console.error(`${feature} permission check error:`, err.message);
      const { role } = req.user;
      if (role === 'owner' || role === 'admin' || role === 'manager') return next();
      return res.status(403).json({ error: 'Access denied.' });
    }
  };
}

// Backward-compatible aliases for inventory
function resolveInventoryPermissions(pageAccess) {
  return resolveFeaturePermissions(pageAccess, 'inventory');
}

function requireInventoryPermission(operation) {
  return requireFeaturePermission('inventory', operation);
}

module.exports = {
  authenticateToken,
  requireOwnerRole,
  resolveInventoryPermissions,
  requireInventoryPermission,
  resolveFeaturePermissions,
  requireFeaturePermission,
  FEATURE_OPS
};



