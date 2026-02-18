const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');

// Reserved slugs that cannot be used by restaurants
const RESERVED_SLUGS = [
  'admin', 'api', 'login', 'logout', 'signup', 'register', 'dashboard', 'billing',
  'menu', 'orders', 'settings', 'profile', 'help', 'support', 'contact', 'about',
  'privacy', 'terms', 'blog', 'products', 'for', 'tools', 'restaurants', 'onlineorder',
  'placeorder', 'print-kot', 'setup', 'local-login', 'kot', 'orderhistory', 'customers',
  'offers', 'customer-app', 'tables', 'hotel', 'inventory', 'automation', 'analytics',
  'www', 'app', 'static', 'assets', 'images', 'public', 'favicon', 'robots',"dineai"
];

// Validate slug format
const isValidSlugFormat = (slug) => {
  // Lowercase letters, numbers, and hyphens only
  // 3-30 characters, cannot start or end with hyphen
  const slugRegex = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
  return slugRegex.test(slug) && !slug.includes('--');
};

// Get restaurant by URL slug (public endpoint)
router.get('/public/restaurant-by-slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    if (!slug) {
      return res.status(400).json({ error: 'Slug is required' });
    }

    const normalizedSlug = slug.toLowerCase().trim();

    // Find restaurant by urlSlug
    const restaurantsSnapshot = await db.collection(collections.restaurants)
      .where('urlSlug', '==', normalizedSlug)
      .limit(1)
      .get();

    if (restaurantsSnapshot.empty) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantDoc = restaurantsSnapshot.docs[0];
    const restaurantData = restaurantDoc.data();

    // Check if customer app is enabled
    if (!restaurantData.customerAppSettings?.enabled) {
      return res.status(404).json({ error: 'Restaurant online ordering not enabled' });
    }

    res.json({
      restaurantId: restaurantDoc.id,
      name: restaurantData.name,
      urlSlug: restaurantData.urlSlug
    });
  } catch (error) {
    console.error('Get restaurant by slug error:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

// Check if slug is available (public endpoint)
router.get('/public/check-slug/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { excludeRestaurantId } = req.query; // Exclude current restaurant when updating

    if (!slug) {
      return res.status(400).json({ available: false, error: 'Slug is required' });
    }

    const normalizedSlug = slug.toLowerCase().trim();

    // Check if slug is reserved
    if (RESERVED_SLUGS.includes(normalizedSlug)) {
      return res.json({ available: false, reason: 'This URL is reserved' });
    }

    // Check slug format
    if (!isValidSlugFormat(normalizedSlug)) {
      return res.json({
        available: false,
        reason: 'URL must be 3-30 characters, lowercase letters, numbers, and hyphens only. Cannot start/end with hyphen.'
      });
    }

    // Check if slug is already taken
    const restaurantsSnapshot = await db.collection(collections.restaurants)
      .where('urlSlug', '==', normalizedSlug)
      .limit(1)
      .get();

    if (!restaurantsSnapshot.empty) {
      const existingRestaurantId = restaurantsSnapshot.docs[0].id;
      // If excluding current restaurant (for updates), check if it's the same one
      if (excludeRestaurantId && existingRestaurantId === excludeRestaurantId) {
        return res.json({ available: true });
      }
      return res.json({ available: false, reason: 'This URL is already taken' });
    }

    res.json({ available: true });
  } catch (error) {
    console.error('Check slug availability error:', error);
    res.status(500).json({ available: false, error: 'Failed to check availability' });
  }
});

// Set/update restaurant URL slug (authenticated endpoint)
router.patch('/restaurants/:restaurantId/slug', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { slug } = req.body;
    const { userId, role } = req.user;

    // Verify ownership
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    if (role !== 'superadmin' && restaurantData.ownerId !== userId) {
      return res.status(403).json({ error: 'Not authorized to update this restaurant' });
    }

    // Allow clearing the slug
    if (!slug || slug.trim() === '') {
      await db.collection(collections.restaurants).doc(restaurantId).update({
        urlSlug: null,
        updatedAt: new Date()
      });
      return res.json({ success: true, urlSlug: null });
    }

    const normalizedSlug = slug.toLowerCase().trim();

    // Check if slug is reserved
    if (RESERVED_SLUGS.includes(normalizedSlug)) {
      return res.status(400).json({ error: 'This URL is reserved and cannot be used' });
    }

    // Check slug format
    if (!isValidSlugFormat(normalizedSlug)) {
      return res.status(400).json({
        error: 'URL must be 3-30 characters, lowercase letters, numbers, and hyphens only. Cannot start/end with hyphen.'
      });
    }

    // Check if slug is already taken by another restaurant
    const existingSnapshot = await db.collection(collections.restaurants)
      .where('urlSlug', '==', normalizedSlug)
      .limit(1)
      .get();

    if (!existingSnapshot.empty && existingSnapshot.docs[0].id !== restaurantId) {
      return res.status(400).json({ error: 'This URL is already taken by another restaurant' });
    }

    // Update the slug
    await db.collection(collections.restaurants).doc(restaurantId).update({
      urlSlug: normalizedSlug,
      updatedAt: new Date()
    });

    res.json({ success: true, urlSlug: normalizedSlug });
  } catch (error) {
    console.error('Update restaurant slug error:', error);
    res.status(500).json({ error: 'Failed to update URL' });
  }
});

module.exports = router;
