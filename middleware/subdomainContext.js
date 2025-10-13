const { db, collections } = require('../firebase');

// Subdomain context middleware for multi-tenant support
const subdomainContext = async (req, res, next) => {
  try {
    const hostname = req.headers.host;
    
    if (!hostname) {
      return next();
    }
    
    // Extract subdomain from hostname
    let subdomain = null;
    
    // Check for localhost subdomains (e.g., myrestaurant.localhost:3002)
    if (hostname.includes('localhost')) {
      const localhostParts = hostname.split('.localhost');
      if (localhostParts.length > 1) {
        subdomain = localhostParts[0];
      }
    }
    // Check for production subdomains (e.g., restaurant-name.dineopen.com)
    else {
      subdomain = hostname.split('.')[0];
    }
    
    // Check if it's a restaurant subdomain (not www, api, admin, etc.)
    const reservedSubdomains = ['www', 'api', 'admin', 'app', 'support', 'dineopen', 'localhost'];
    
    // Check for localhost subdomains (e.g., myrestaurant.localhost:3002)
    let isRestaurantSubdomain = false;
    if (hostname.includes('localhost')) {
      const localhostParts = hostname.split('.localhost');
      if (localhostParts.length > 1) {
        const localhostSubdomain = localhostParts[0];
        isRestaurantSubdomain = !reservedSubdomains.includes(localhostSubdomain) && 
                               localhostSubdomain.length > 2;
        subdomain = localhostSubdomain;
      }
    }
    // Check for production subdomains (e.g., restaurant-name.dineopen.com)
    else {
      isRestaurantSubdomain = !reservedSubdomains.includes(subdomain) && 
                             hostname.includes('.') && 
                             subdomain.length > 2;
    }
    
    if (isRestaurantSubdomain) {
      console.log(`🏢 Subdomain detected: ${subdomain}`);
      
      try {
        // Find restaurant by subdomain
        const restaurantSnapshot = await db.collection(collections.restaurants)
          .where('subdomain', '==', subdomain)
          .where('isActive', '==', true)
          .limit(1)
          .get();
        
        if (!restaurantSnapshot.empty) {
          const restaurantDoc = restaurantSnapshot.docs[0];
          const restaurantData = restaurantDoc.data();
          
          // Add restaurant context to request
          req.restaurant = {
            id: restaurantDoc.id,
            ...restaurantData
          };
          req.restaurantId = restaurantDoc.id;
          req.subdomain = subdomain;
          
          console.log(`✅ Restaurant context loaded: ${restaurantData.name} (${restaurantDoc.id})`);
        } else {
          console.log(`❌ Restaurant not found for subdomain: ${subdomain}`);
          req.subdomain = subdomain;
          req.restaurantNotFound = true;
        }
      } catch (error) {
        console.error('Error loading restaurant context:', error);
        // Continue without restaurant context
      }
    }
    
    next();
  } catch (error) {
    console.error('Subdomain context middleware error:', error);
    next(); // Continue even if subdomain detection fails
  }
};

// Helper function to check if subdomain is valid
const isValidRestaurantSubdomain = (subdomain) => {
  const reservedSubdomains = ['www', 'api', 'admin', 'app', 'support', 'dineopen'];
  return !reservedSubdomains.includes(subdomain) && 
         subdomain.length >= 3 && 
         subdomain.length <= 30 &&
         /^[a-z0-9-]+$/.test(subdomain);
};

// Helper function to generate subdomain from restaurant name
const generateSubdomain = (restaurantName) => {
  return restaurantName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .substring(0, 30); // Limit length
};

// Helper function to check if subdomain is available
const isSubdomainAvailable = async (subdomain, excludeRestaurantId = null) => {
  try {
    let query = db.collection(collections.restaurants)
      .where('subdomain', '==', subdomain);
    
    const snapshot = await query.get();
    
    if (snapshot.empty) {
      return true;
    }
    
    // If excluding a specific restaurant (for updates), check if it's the same restaurant
    if (excludeRestaurantId) {
      const existingRestaurant = snapshot.docs[0];
      return existingRestaurant.id === excludeRestaurantId;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking subdomain availability:', error);
    return false;
  }
};

module.exports = {
  subdomainContext,
  isValidRestaurantSubdomain,
  generateSubdomain,
  isSubdomainAvailable
};
