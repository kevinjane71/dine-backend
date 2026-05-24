const jwt = require('jsonwebtoken');

// Accepts both super_admin and sub_admin roles
const authenticateSuperAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid or expired token' });
    }
    if (decoded.role !== 'super_admin' && decoded.role !== 'sub_admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    req.admin = decoded;
    next();
  });
};

// Strict super-admin only (for destructive endpoints, sub-admin CRUD, etc.)
const requireSuperAdmin = (req, res, next) => {
  if (req.admin.role !== 'super_admin') {
    return res.status(403).json({ success: false, error: 'Super admin access required' });
  }
  next();
};

module.exports = { authenticateSuperAdmin, requireSuperAdmin };
