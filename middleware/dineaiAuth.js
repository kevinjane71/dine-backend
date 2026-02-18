/**
 * DineAI Authentication Middleware
 * Handles authentication and authorization for DineAI endpoints
 */

const jwt = require('jsonwebtoken');
const { getDb } = require('../firebase');
const dineaiPermissions = require('../services/dineai/DineAIPermissions');

/**
 * Authenticate DineAI requests and add user context
 */
const authenticateDineAI = async (req, res, next) => {
  try {
    console.log('🔐 DineAI Auth - Request URL:', req.originalUrl);

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    console.log('🔐 DineAI Auth - Token present:', !!token);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log('🔐 DineAI Auth - Token valid, userId:', decoded.userId);
    } catch (jwtError) {
      console.error('JWT verification failed:', jwtError.message);
      return res.status(403).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }
    req.user = decoded;

    // Get restaurant ID from request - try multiple sources
    // In Express 5, params might not be available in middleware, so also extract from URL
    let restaurantId = req.body?.restaurantId || req.params?.restaurantId || req.query?.restaurantId;

    // Fallback: extract from URL path for routes like /dineai/settings/:restaurantId
    if (!restaurantId && req.originalUrl) {
      const urlParts = req.originalUrl.split('/');
      const settingsIndex = urlParts.indexOf('settings');
      const knowledgeIndex = urlParts.indexOf('knowledge');
      const greetingIndex = urlParts.indexOf('greeting');
      const usageIndex = urlParts.indexOf('usage');
      const conversationsIndex = urlParts.indexOf('conversations');

      // Find the restaurantId after known path segments
      if (settingsIndex > -1 && urlParts[settingsIndex + 1]) {
        restaurantId = urlParts[settingsIndex + 1].split('?')[0];
      } else if (knowledgeIndex > -1 && urlParts[knowledgeIndex + 1]) {
        restaurantId = urlParts[knowledgeIndex + 1].split('?')[0];
      } else if (greetingIndex > -1 && urlParts[greetingIndex + 1]) {
        restaurantId = urlParts[greetingIndex + 1].split('?')[0];
      } else if (usageIndex > -1 && urlParts[usageIndex + 1]) {
        restaurantId = urlParts[usageIndex + 1].split('?')[0];
      } else if (conversationsIndex > -1 && urlParts[conversationsIndex + 1]) {
        restaurantId = urlParts[conversationsIndex + 1].split('?')[0];
      }
    }

    console.log('🔐 DineAI Auth - restaurantId:', restaurantId);
    console.log('🔐 DineAI Auth - userId from token:', decoded.userId);

    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Restaurant ID is required'
      });
    }

    // Verify user has access to this restaurant
    let db;
    try {
      db = getDb();
    } catch (dbError) {
      console.error('Failed to get database:', dbError.message);
      return res.status(500).json({
        success: false,
        error: 'Database connection failed'
      });
    }

    let userRestaurantDoc;
    try {
      console.log('🔐 DineAI Auth - Checking userRestaurants for userId:', decoded.userId, 'restaurantId:', restaurantId);
      userRestaurantDoc = await db.collection('userRestaurants')
        .where('userId', '==', decoded.userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();
      console.log('🔐 DineAI Auth - userRestaurants found:', !userRestaurantDoc.empty);
    } catch (queryError) {
      console.error('userRestaurants query failed:', queryError.message);
      return res.status(500).json({
        success: false,
        error: 'Failed to verify user access'
      });
    }

    if (userRestaurantDoc.empty) {
      // Check 2: User is owner via restaurant.ownerId
      let restaurantDoc;
      try {
        restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
      } catch (restError) {
        console.error('restaurants query failed:', restError.message);
        return res.status(500).json({
          success: false,
          error: 'Failed to verify restaurant ownership'
        });
      }

      console.log('🔐 DineAI Auth - Restaurant exists:', restaurantDoc.exists);
      const restaurantData = restaurantDoc.exists ? restaurantDoc.data() : {};
      console.log('🔐 DineAI Auth - Restaurant ownerId:', restaurantData.ownerId || 'N/A');
      console.log('🔐 DineAI Auth - User ID from token:', decoded.userId);

      let hasAccess = false;
      let accessMethod = '';

      // Check ownerId
      if (restaurantDoc.exists && restaurantData.ownerId === decoded.userId) {
        hasAccess = true;
        accessMethod = 'ownerId';
      }

      // Check userId field (some restaurants use this)
      if (!hasAccess && restaurantData.userId === decoded.userId) {
        hasAccess = true;
        accessMethod = 'userId';
      }

      // Check createdBy field
      if (!hasAccess && restaurantData.createdBy === decoded.userId) {
        hasAccess = true;
        accessMethod = 'createdBy';
      }

      // Check 3: Staff in users collection (fallback for existing staff)
      if (!hasAccess) {
        try {
          const userDoc = await db.collection('users').doc(decoded.userId).get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            if (userData.restaurantId === restaurantId) {
              hasAccess = true;
              accessMethod = 'user.restaurantId';
              req.userRole = userData.role || 'employee';
              req.userName = userData.name || decoded.name || 'User';
            }
          }
        } catch (userError) {
          console.error('User check failed:', userError.message);
        }
      }

      if (!hasAccess) {
        console.log('🔐 DineAI Auth - Access denied. No match found.');
        return res.status(403).json({
          success: false,
          error: 'Access denied: You do not have access to this restaurant'
        });
      }

      console.log('🔐 DineAI Auth - Access granted via:', accessMethod);
      if (!req.userRole) {
        req.userRole = 'owner';
        req.userName = decoded.name || 'Owner';
      }
    } else {
      // Get user role from userRestaurants
      const userData = userRestaurantDoc.docs[0].data();
      req.userRole = userData.role || 'employee';
      req.userName = userData.name || decoded.name || 'User';
    }

    req.restaurantId = restaurantId;

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(403).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }

    console.error('DineAI auth error:', error.message);
    console.error('DineAI auth error stack:', error.stack);
    return res.status(500).json({
      success: false,
      error: 'Authentication failed',
      details: process.env.NODE_ENV !== 'production' ? error.message : undefined
    });
  }
};

/**
 * Check if user role has permission for specific action
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.userRole) {
      return res.status(403).json({
        success: false,
        error: 'User role not determined'
      });
    }

    if (!dineaiPermissions.hasPermission(req.userRole, permission)) {
      return res.status(403).json({
        success: false,
        error: `Permission denied: Your role (${req.userRole}) cannot ${permission.replace(/_/g, ' ')}`
      });
    }

    next();
  };
};

/**
 * Require manager or owner role
 */
const requireManagerRole = (req, res, next) => {
  if (!['owner', 'manager'].includes(req.userRole)) {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Manager or owner role required'
    });
  }
  next();
};

/**
 * Require owner role
 */
const requireOwnerRole = (req, res, next) => {
  if (req.userRole !== 'owner') {
    return res.status(403).json({
      success: false,
      error: 'Access denied: Owner role required'
    });
  }
  next();
};

/**
 * Rate limiting for DineAI requests
 */
const dineaiRateLimiter = async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const restaurantId = req.restaurantId;
    const userRole = req.userRole;

    // Get daily limit for role
    const dailyLimit = dineaiPermissions.getDailyLimit(userRole);

    // Get today's usage from Firestore
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const db = getDb();
    const usageDoc = await db.collection('dineai_usage')
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('date', '>=', today)
      .limit(1)
      .get();

    let currentUsage = 0;

    if (!usageDoc.empty) {
      currentUsage = usageDoc.docs[0].data().count || 0;
    }

    if (currentUsage >= dailyLimit) {
      return res.status(429).json({
        success: false,
        error: `Daily limit reached (${currentUsage}/${dailyLimit}). Please try again tomorrow.`,
        limit: dailyLimit,
        used: currentUsage,
        resetAt: new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString()
      });
    }

    // Store usage info for tracking
    req.dineaiUsage = {
      current: currentUsage,
      limit: dailyLimit,
      remaining: dailyLimit - currentUsage - 1
    };

    next();
  } catch (error) {
    console.error('DineAI rate limiter error:', error);
    // Allow request on error to avoid blocking users
    next();
  }
};

/**
 * Track DineAI usage after successful request
 */
const trackDineAIUsage = async (req, res, next) => {
  // This middleware should be called after the main handler
  // It tracks usage for successful requests

  const originalSend = res.send;

  res.send = function(body) {
    // Only track on successful responses
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const userId = req.user?.userId;
      const restaurantId = req.restaurantId;

      if (userId && restaurantId) {
        // Async tracking - don't wait for it
        trackUsageAsync(userId, restaurantId).catch(err => {
          console.error('Error tracking DineAI usage:', err);
        });
      }
    }

    return originalSend.call(this, body);
  };

  next();
};

async function trackUsageAsync(userId, restaurantId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dateStr = today.toISOString().split('T')[0];

  const db = getDb();
  const usageRef = db.collection('dineai_usage').doc(`${userId}_${restaurantId}_${dateStr}`);

  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(usageRef);

    if (doc.exists) {
      transaction.update(usageRef, {
        count: (doc.data().count || 0) + 1,
        updatedAt: new Date()
      });
    } else {
      transaction.set(usageRef, {
        userId,
        restaurantId,
        date: today,
        count: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }
  });
}

/**
 * Simple auth for session cleanup - only verifies JWT, doesn't require restaurantId
 */
const authenticateSimple = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token required'
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(403).json({
        success: false,
        error: 'Invalid or expired token'
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

module.exports = {
  authenticateDineAI,
  authenticateSimple,
  requirePermission,
  requireManagerRole,
  requireOwnerRole,
  dineaiRateLimiter,
  trackDineAIUsage
};
