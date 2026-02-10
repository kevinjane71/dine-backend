const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');

// Default currency settings (INR for backward compatibility)
const defaultCurrencySettings = {
  countryCode: 'IN',
  currencyCode: 'INR',
  currencySymbol: '₹',
  symbolPosition: 'before',
  decimalPlaces: 2,
  thousandSeparator: ',',
  decimalSeparator: '.',
  locale: 'en-IN',
  taxLabel: 'GST'
};

// Helper function to verify user access to restaurant
const verifyRestaurantAccess = async (userId, restaurantId, allowedRoles) => {
  // Check userRestaurants collection
  const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
    .where('userId', '==', userId)
    .where('restaurantId', '==', restaurantId)
    .where('role', 'in', allowedRoles)
    .get();

  if (!userRestaurantSnapshot.empty) {
    return { hasAccess: true };
  }

  // Fallback: Check users collection for staff with restaurantId
  const userDoc = await db.collection(collections.users).doc(userId).get();
  if (userDoc.exists) {
    const userData = userDoc.data();
    if (userData.restaurantId === restaurantId && allowedRoles.includes(userData.role?.toLowerCase())) {
      return { hasAccess: true };
    }
  }

  // Final fallback: Check if user is the owner directly from restaurant document
  const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
  const restaurantDoc = await restaurantRef.get();

  if (!restaurantDoc.exists) {
    return { hasAccess: false, error: 'Restaurant not found', status: 404 };
  }

  const restaurant = restaurantDoc.data();
  if (restaurant.ownerId === userId) {
    return { hasAccess: true, restaurant, restaurantRef };
  }

  return { hasAccess: false, error: 'Access denied', status: 403 };
};

// Get currency settings for a restaurant
router.get('/admin/currency/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;

    console.log(`💰 Getting currency settings for restaurant: ${restaurantId}, userId: ${userId}`);

    // Verify user has access to this restaurant
    const allowedRoles = ['owner', 'manager', 'admin', 'cashier'];
    const accessCheck = await verifyRestaurantAccess(userId, restaurantId, allowedRoles);

    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.status || 403).json({ error: accessCheck.error || 'Access denied' });
    }

    // Get restaurant document
    const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();

    // Return currency settings or defaults
    const currencySettings = restaurant.currencySettings || defaultCurrencySettings;

    res.json({
      success: true,
      currencySettings
    });

  } catch (error) {
    console.error('Get currency settings error:', error);
    res.status(500).json({ error: 'Failed to get currency settings' });
  }
});

// Update currency settings for a restaurant
router.put('/admin/currency/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const { currencySettings } = req.body;

    console.log(`💰 Updating currency settings for restaurant: ${restaurantId}, userId: ${userId}`);

    // Verify user has access (owner, manager, admin only for currency changes)
    const allowedRoles = ['owner', 'manager', 'admin'];
    const accessCheck = await verifyRestaurantAccess(userId, restaurantId, allowedRoles);

    if (!accessCheck.hasAccess) {
      return res.status(accessCheck.status || 403).json({
        error: accessCheck.error || 'Access denied. Required role: owner, manager, or admin.'
      });
    }

    // Validate currency settings
    if (!currencySettings) {
      return res.status(400).json({ error: 'Currency settings are required' });
    }

    // Validate required fields
    const requiredFields = ['countryCode', 'currencyCode', 'currencySymbol'];
    for (const field of requiredFields) {
      if (!currencySettings[field]) {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }

    // Get restaurant document
    const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    const oldSettings = restaurant.currencySettings || defaultCurrencySettings;
    const newTaxLabel = currencySettings.taxLabel || 'Tax';

    // Auto-update tax names if country changed and tax label differs
    let taxSettingsUpdated = false;
    if (restaurant.taxSettings && restaurant.taxSettings.taxes && Array.isArray(restaurant.taxSettings.taxes)) {
      const oldTaxLabel = oldSettings.taxLabel || 'GST';
      if (newTaxLabel !== oldTaxLabel) {
        // Update tax names that match the old label
        const updatedTaxes = restaurant.taxSettings.taxes.map(tax => {
          if (tax.name === oldTaxLabel || tax.name.toUpperCase() === oldTaxLabel.toUpperCase()) {
            return { ...tax, name: newTaxLabel };
          }
          return tax;
        });

        await restaurantRef.update({
          'taxSettings.taxes': updatedTaxes,
          'taxSettings.updatedAt': new Date(),
          'taxSettings.updatedBy': userId
        });
        taxSettingsUpdated = true;
        console.log(`📊 Auto-updated tax labels from ${oldTaxLabel} to ${newTaxLabel}`);
      }
    }

    // Update currency settings
    const settingsToSave = {
      countryCode: currencySettings.countryCode,
      currencyCode: currencySettings.currencyCode,
      currencySymbol: currencySettings.currencySymbol,
      symbolPosition: currencySettings.symbolPosition || 'before',
      decimalPlaces: currencySettings.decimalPlaces ?? 2,
      thousandSeparator: currencySettings.thousandSeparator || ',',
      decimalSeparator: currencySettings.decimalSeparator || '.',
      locale: currencySettings.locale || 'en-IN',
      taxLabel: newTaxLabel,
      updatedAt: new Date(),
      updatedBy: userId
    };

    await restaurantRef.update({
      currencySettings: settingsToSave
    });

    res.json({
      success: true,
      message: 'Currency settings updated successfully',
      currencySettings: settingsToSave,
      taxSettingsUpdated
    });

  } catch (error) {
    console.error('Update currency settings error:', error);
    res.status(500).json({ error: 'Failed to update currency settings' });
  }
});

module.exports = router;
