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

/**
 * Resolve inventory permissions from pageAccess.
 * Handles boolean (legacy) and object (granular) formats.
 */
function resolveInventoryPermissions(pageAccess) {
  const inv = pageAccess?.inventory;
  if (typeof inv === 'object' && inv !== null) {
    return { read: !!inv.read, add: !!inv.add, update: !!inv.update, delete: !!inv.delete };
  }
  const val = !!inv;
  return { read: val, add: val, update: val, delete: val };
}

/**
 * Middleware factory for inventory operation permissions.
 * Owners always pass. Staff checked via pageAccess from Firestore.
 */
function requireInventoryPermission(operation) {
  return async (req, res, next) => {
    try {
      const { role } = req.user;
      // Owners always have full access
      if (role === 'owner' || role === 'admin') return next();

      // For staff roles, check pageAccess
      const { db, collections } = require('../firebase');
      const userId = req.user.userId || req.user.id;

      // Try staffUsers first, then users
      let userDoc = await db.collection(collections.staffUsers).doc(userId).get();
      if (!userDoc.exists) {
        userDoc = await db.collection(collections.users).doc(userId).get();
      }

      if (!userDoc.exists) {
        return res.status(403).json({ error: 'User not found' });
      }

      const perms = resolveInventoryPermissions(userDoc.data()?.pageAccess);
      if (perms[operation]) return next();

      return res.status(403).json({ error: `Access denied. Inventory ${operation} permission required.` });
    } catch (err) {
      console.error('Inventory permission check error:', err.message);
      // On error, fall back to role-based check
      const { role } = req.user;
      if (role === 'owner' || role === 'admin' || role === 'manager') return next();
      return res.status(403).json({ error: 'Access denied.' });
    }
  };
}

module.exports = {
  authenticateToken,
  requireOwnerRole,
  resolveInventoryPermissions,
  requireInventoryPermission
};



