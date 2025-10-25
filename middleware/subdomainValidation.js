/**
 * Subdomain Validation Middleware
 * Validates that the subdomain belongs to the authenticated user's restaurant
 */

const { extractSubdomainFromHostname } = require('../utils/subdomain');

/**
 * Middleware to validate subdomain access
 * Only runs for subdomain requests
 */
const subdomainValidationMiddleware = async (req, res, next) => {
  try {
    // Extract subdomain from referer header
    const referer = req.headers.referer || req.headers.origin;
    
    if (!referer) {
      // No referer means it's not a subdomain request, skip validation
      return next();
    }

    const subdomain = extractSubdomainFromHostname(new URL(referer).hostname);
    
    if (!subdomain) {
      // Not a subdomain request, skip validation
      return next();
    }

    // Check if user is authenticated
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ 
        error: 'Authentication required for subdomain access',
        code: 'SUBDOMAIN_AUTH_REQUIRED'
      });
    }

    // Find restaurant with this subdomain
    const restaurantQuery = await db.collection(collections.restaurants)
      .where('subdomain', '==', subdomain)
      .limit(1)
      .get();

    if (restaurantQuery.empty) {
      return res.status(404).json({ 
        error: 'Subdomain not found',
        code: 'SUBDOMAIN_NOT_FOUND'
      });
    }

    const restaurant = restaurantQuery.docs[0].data();
    const restaurantId = restaurantQuery.docs[0].id;

    // Check if subdomain is enabled for this restaurant
    if (!restaurant.subdomainEnabled) {
      return res.status(403).json({ 
        error: 'Subdomain access is disabled for this restaurant',
        code: 'SUBDOMAIN_DISABLED'
      });
    }

    // Check if user has access to this restaurant
    if (restaurant.ownerId !== req.user.userId) {
      return res.status(403).json({ 
        error: 'You do not have access to this restaurant subdomain',
        code: 'SUBDOMAIN_ACCESS_DENIED'
      });
    }

    // Add restaurant info to request for use in routes
    req.restaurant = {
      id: restaurantId,
      ...restaurant
    };

    next();

  } catch (error) {
    console.error('Subdomain validation error:', error);
    return res.status(500).json({ 
      error: 'Subdomain validation failed',
      code: 'SUBDOMAIN_VALIDATION_ERROR'
    });
  }
};

/**
 * Optional middleware - only validates if subdomain is present
 * Use this for routes that should work on both normal domain and subdomain
 */
const optionalSubdomainValidationMiddleware = async (req, res, next) => {
  try {
    const referer = req.headers.referer || req.headers.origin;
    
    if (!referer) {
      return next();
    }

    const subdomain = extractSubdomainFromHostname(new URL(referer).hostname);
    
    if (!subdomain) {
      return next();
    }

    // If it's a subdomain request, validate it
    return subdomainValidationMiddleware(req, res, next);

  } catch (error) {
    console.error('Optional subdomain validation error:', error);
    return next(); // Continue without validation on error
  }
};

module.exports = {
  subdomainValidationMiddleware,
  optionalSubdomainValidationMiddleware
};

