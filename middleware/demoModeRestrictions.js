/**
 * Demo Mode Restrictions Middleware
 * 
 * This middleware restricts demo accounts (phone: +919000000000) to read-only operations.
 * Demo users can only perform GET requests and cannot create, update, or delete any data.
 * 
 * Usage: Apply this middleware to routes that should be restricted for demo accounts.
 */

console.log('🎭 Demo Mode Middleware loaded successfully!');

const DEMO_PHONE_NUMBERS = [
  '+919000000000',
  '9000000000',
  '+91-9000000000'
];

/**
 * Check if the user is a demo account based on phone number
 * @param {string} phoneNumber - The user's phone number
 * @returns {boolean} - True if it's a demo account
 */
function isDemoAccount(phoneNumber) {
  if (!phoneNumber) return false;
  
  // Normalize phone number for comparison
  const normalizedPhone = phoneNumber.replace(/\s+/g, '').replace(/-/g, '');
  
  return DEMO_PHONE_NUMBERS.some(demoPhone => {
    const normalizedDemoPhone = demoPhone.replace(/\s+/g, '').replace(/-/g, '');
    return normalizedPhone === normalizedDemoPhone;
  });
}

/**
 * Demo Mode Restrictions Middleware
 * 
 * This middleware should be applied AFTER authentication middleware
 * but BEFORE route handlers that need demo restrictions.
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object  
 * @param {Function} next - Express next function
 */
function demoModeRestrictions(req, res, next) {
  console.log('🚨 DEMO MODE MIDDLEWARE CALLED!');
  try {
    console.log('🔍 Demo Mode Middleware - User:', req.user);
    console.log('🔍 Demo Mode Middleware - Phone:', req.user?.phoneNumber);
    console.log('🔍 Demo Mode Middleware - isDemoAccount:', req.user?.isDemoAccount);
    
    // Skip if no user is authenticated
    if (!req.user || !req.user.phoneNumber) {
      console.log('🔍 Demo Mode Middleware - No user or phone, skipping');
      return next();
    }

    // Check if this is a demo account (use both phone number and JWT field)
    const isDemo = isDemoAccount(req.user.phoneNumber) || req.user.isDemoAccount;
    
    if (isDemo) {
      console.log(`🎭 Demo Mode: Restricting ${req.method} ${req.path} for demo account: ${req.user.phoneNumber}`);
      
      // Allow only GET requests for demo accounts
      if (req.method !== 'GET') {
        console.log(`🚫 Demo Mode: Blocking ${req.method} request`);
        return res.status(403).json({
          success: false,
          error: 'Demo Mode Restriction',
          message: 'Demo accounts are restricted to read-only access. Please sign up for a full account to perform this action.',
          demoMode: true,
          allowedOperations: ['GET'],
          restrictedOperations: ['POST', 'PUT', 'PATCH', 'DELETE']
        });
      }
    }

    // Continue to next middleware/route handler
    next();
    
  } catch (error) {
    console.error('❌ Demo Mode Middleware Error:', error);
    // Don't block the request if middleware fails, just log and continue
    next();
  }
}

/**
 * Demo Mode Restrictions for Specific Routes
 * 
 * Use this for routes that should be completely blocked for demo accounts
 * (not just read-only, but completely inaccessible)
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object  
 * @param {Function} next - Express next function
 */
function blockDemoAccount(req, res, next) {
  try {
    // Skip if no user is authenticated
    if (!req.user || !req.user.phoneNumber) {
      return next();
    }

    // Check if this is a demo account
    if (isDemoAccount(req.user.phoneNumber)) {
      console.log(`🚫 Demo Mode: Blocking ${req.method} ${req.path} for demo account: ${req.user.phoneNumber}`);
      
      return res.status(403).json({
        success: false,
        error: 'Demo Mode Blocked',
        message: 'This feature is not available in demo mode. Please sign up for a full account.',
        demoMode: true,
        blockedRoute: `${req.method} ${req.path}`
      });
    }

    // Continue to next middleware/route handler
    next();
    
  } catch (error) {
    console.error('❌ Demo Block Middleware Error:', error);
    // Don't block the request if middleware fails, just log and continue
    next();
  }
}

/**
 * Demo Mode Info Middleware
 * 
 * Adds demo mode information to the response for demo accounts
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object  
 * @param {Function} next - Express next function
 */
function addDemoModeInfo(req, res, next) {
  try {
    console.log('🔍 Add Demo Mode Info - User:', req.user);
    console.log('🔍 Add Demo Mode Info - Phone:', req.user?.phoneNumber);
    console.log('🔍 Add Demo Mode Info - isDemoAccount:', req.user?.isDemoAccount);
    
    // Skip if no user is authenticated
    if (!req.user || !req.user.phoneNumber) {
      console.log('🔍 Add Demo Mode Info - No user or phone, skipping');
      return next();
    }

    // Check if this is a demo account (use both phone number and JWT field)
    const isDemo = isDemoAccount(req.user.phoneNumber) || req.user.isDemoAccount;
    
    if (isDemo) {
      console.log('🎭 Add Demo Mode Info - Demo account detected, adding info');
      // Add demo mode info to response locals
      res.locals.demoMode = true;
      res.locals.demoRestrictions = {
        readOnly: true,
        message: 'You are using a demo account with read-only access'
      };
    } else {
      console.log('🔍 Add Demo Mode Info - Not a demo account');
    }

    // Continue to next middleware/route handler
    next();
    
  } catch (error) {
    console.error('❌ Add Demo Mode Info Middleware Error:', error);
    // Don't block the request if middleware fails, just log and continue
    next();
  }
}

module.exports = {
  demoModeRestrictions,
  blockDemoAccount,
  addDemoModeInfo,
  isDemoAccount
};

