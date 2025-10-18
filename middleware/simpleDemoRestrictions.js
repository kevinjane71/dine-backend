/**
 * Simple Demo Mode Restrictions
 * Blocks non-GET requests for demo account (phone: +919000000000)
 */

function simpleDemoRestrictions(req, res, next) {
  console.log('🔍 Simple Demo Check - User:', req.user?.phoneNumber, 'Method:', req.method);
  
  // Check if user is authenticated and has phone number
  if (req.user && req.user.phoneNumber === '+919000000000') {
    console.log('🎭 Demo account detected, checking method:', req.method);
    // Allow only GET requests for demo account
    if (req.method !== 'GET') {
      return res.status(403).json({
        success: false,
        error: 'Demo Mode Restriction',
        message: 'Demo accounts are restricted to read-only access. Please sign up for a full account to perform this action.',
        demoMode: true
      });
    }
  }
  
  // Continue to next middleware/route handler
  next();
}

module.exports = { simpleDemoRestrictions };
