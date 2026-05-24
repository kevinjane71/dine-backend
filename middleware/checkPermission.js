// Permission-check middleware factory
// Super-admins bypass all checks; sub-admins must have the specific permission in their JWT
const checkPermission = (requiredPermission) => {
  return (req, res, next) => {
    if (req.admin.role === 'super_admin') {
      return next();
    }

    if (req.admin.role === 'sub_admin') {
      if (!req.admin.permissions || !req.admin.permissions.includes(requiredPermission)) {
        return res.status(403).json({
          success: false,
          error: `Permission denied: ${requiredPermission} required`,
        });
      }
      return next();
    }

    return res.status(403).json({ success: false, error: 'Access denied' });
  };
};

module.exports = { checkPermission };
