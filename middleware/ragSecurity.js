const admin = require('firebase-admin');

// Enhanced authentication middleware for RAG system
const authenticateRAGAccess = async (req, res, next) => {
  try {
    const { restaurantId } = req.body;
    const userId = req.user.userId;
    
    if (!restaurantId || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Restaurant ID and User ID are required'
      });
    }

    // Verify user has access to this restaurant
    const userAccess = await verifyUserRestaurantAccess(userId, restaurantId);
    
    if (!userAccess.hasAccess) {
      console.log(`🚫 RAG Access Denied: User ${userId} attempted to access restaurant ${restaurantId}`);
      const errorMessage = userAccess.error || 'Access denied: You do not have permission to access this restaurant\'s data';
      return res.status(403).json({
        success: false,
        error: errorMessage
      });
    }

    // Add security context to request
    req.ragContext = {
      userId,
      restaurantId,
      userRole: userAccess.role,
      permissions: userAccess.permissions
    };

    next();
  } catch (error) {
    console.error('RAG Authentication error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

// Verify user has access to restaurant (using same logic as main system)
const verifyUserRestaurantAccess = async (userId, restaurantId) => {
  try {
    console.log(`🔍 RAG Access Check: userId=${userId}, restaurantId=${restaurantId}`);
    
    // Use the same userRestaurants collection approach as the main system
    const userRestaurantSnapshot = await admin.firestore()
      .collection('userRestaurants')
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .get();

    console.log(`🔍 User restaurant access check: found ${userRestaurantSnapshot.size} records`);
    
    if (userRestaurantSnapshot.empty) {
      console.log(`🚫 No user-restaurant relationship found for userId=${userId}, restaurantId=${restaurantId}`);
      
      // Check if the restaurant exists at all
      const restaurantDoc = await admin.firestore().collection('restaurants').doc(restaurantId).get();
      if (!restaurantDoc.exists) {
        console.log(`🚫 Restaurant ${restaurantId} does not exist in database`);
        return { 
          hasAccess: false, 
          role: null, 
          permissions: [],
          error: 'Restaurant not found. Please create a restaurant first.'
        };
      }
      
      return { 
        hasAccess: false, 
        role: null, 
        permissions: [],
        error: 'You do not have access to this restaurant. Please contact the restaurant owner.'
      };
    }

    const userRestaurantData = userRestaurantSnapshot.docs[0].data();
    const role = userRestaurantData.role;
    const permissions = userRestaurantData.permissions || [];

    console.log(`✅ User has access: role=${role}, permissions=${JSON.stringify(permissions)}`);

    return {
      hasAccess: true,
      role: role,
      permissions: permissions
    };

  } catch (error) {
    console.error('Error verifying user restaurant access:', error);
    return { hasAccess: false, role: null, permissions: [] };
  }
};

// Validate restaurant ID format and ownership
const validateRestaurantAccess = async (userId, restaurantId) => {
  try {
    // Validate restaurant ID format
    if (!restaurantId || typeof restaurantId !== 'string' || restaurantId.length < 10) {
      throw new Error('Invalid restaurant ID format');
    }

    // Check if restaurant exists and user has access
    const access = await verifyUserRestaurantAccess(userId, restaurantId);
    
    if (!access.hasAccess) {
      throw new Error('User does not have access to this restaurant');
    }

    return access;
  } catch (error) {
    console.error('Restaurant access validation error:', error);
    throw error;
  }
};

module.exports = {
  authenticateRAGAccess,
  verifyUserRestaurantAccess,
  validateRestaurantAccess
};
