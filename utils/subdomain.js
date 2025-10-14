/**
 * Subdomain Generation Utility
 * Generates unique subdomains for restaurants
 */

const { db, collections } = require('../firebase');

/**
 * Generate a subdomain from restaurant name
 * @param {string} restaurantName - The restaurant name
 * @param {string} restaurantId - The restaurant ID for uniqueness
 * @returns {Promise<string>} - Generated subdomain
 */
async function generateSubdomain(restaurantName, restaurantId) {
  if (!restaurantName || !restaurantId) {
    throw new Error('Restaurant name and ID are required');
  }

  // Clean the restaurant name for subdomain
  let baseSubdomain = restaurantName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

  // Ensure minimum length
  if (baseSubdomain.length < 3) {
    baseSubdomain = `restaurant-${restaurantId.slice(-6)}`;
  }

  // Check for uniqueness and add number if needed
  let subdomain = baseSubdomain;
  let counter = 1;

  while (true) {
    const existingRestaurant = await db.collection(collections.restaurants)
      .where('subdomain', '==', subdomain)
      .limit(1)
      .get();

    if (existingRestaurant.empty) {
      break; // Subdomain is unique
    }

    // Subdomain exists, try with number
    subdomain = `${baseSubdomain}${counter}`;
    counter++;

    // Safety check to prevent infinite loop
    if (counter > 100) {
      subdomain = `restaurant-${restaurantId.slice(-8)}-${Date.now()}`;
      break;
    }
  }

  return subdomain;
}

/**
 * Validate subdomain format
 * @param {string} subdomain - The subdomain to validate
 * @returns {boolean} - Whether subdomain is valid
 */
function isValidSubdomain(subdomain) {
  if (!subdomain || typeof subdomain !== 'string') {
    return false;
  }

  // Check format: lowercase letters, numbers, and hyphens only
  // Must start and end with alphanumeric character
  const subdomainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  
  return subdomainRegex.test(subdomain) && 
         subdomain.length >= 3 && 
         subdomain.length <= 63;
}

/**
 * Extract subdomain from hostname
 * @param {string} hostname - The hostname (e.g., "my-restaurant.dineopen.com" or "hj.localhost:3002")
 * @returns {string|null} - The subdomain or null if not a subdomain
 */
function extractSubdomainFromHostname(hostname) {
  if (!hostname) return null;
  
  // Check if it's a subdomain of dineopen.com
  const dineopenMatch = hostname.match(/^([a-zA-Z0-9-]+)\.dineopen\.com$/);
  if (dineopenMatch) {
    return dineopenMatch[1].toLowerCase();
  }
  
  // Check if it's a localhost subdomain (for development)
  const localhostMatch = hostname.match(/^([a-zA-Z0-9-]+)\.localhost:3002$/);
  if (localhostMatch) {
    return localhostMatch[1].toLowerCase();
  }
  
  return null;
}

/**
 * Get full subdomain URL
 * @param {string} subdomain - The subdomain
 * @param {string} path - Optional path to append
 * @returns {string} - Full subdomain URL
 */
function getSubdomainUrl(subdomain, path = '') {
  const baseUrl = process.env.NODE_ENV === 'production' 
    ? 'https://dineopen.com' 
    : 'http://localhost:3002';
  
  let subdomainUrl;
  
  if (process.env.NODE_ENV === 'production') {
    subdomainUrl = baseUrl.replace('dineopen.com', `${subdomain}.dineopen.com`);
  } else {
    // For development, use localhost subdomain
    subdomainUrl = baseUrl.replace('localhost:3002', `${subdomain}.localhost:3002`);
  }
  
  return path ? `${subdomainUrl}${path}` : subdomainUrl;
}

module.exports = {
  generateSubdomain,
  isValidSubdomain,
  extractSubdomainFromHostname,
  getSubdomainUrl
};
