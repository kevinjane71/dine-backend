const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { db, collections } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

// JWT secret for customer tokens
const CUSTOMER_JWT_SECRET = process.env.JWT_SECRET || 'dineopen-secret-key';

// ============================================
// MIDDLEWARE
// ============================================

// Authenticate customer token
const authenticateCustomer = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);

    if (decoded.type !== 'customer') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    req.customer = decoded;
    next();
  } catch (error) {
    console.error('Customer auth error:', error);
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

// ============================================
// OTP STORAGE (In-memory for simplicity, use Redis in production)
// ============================================
const otpStore = new Map();

const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// ============================================
// PUBLIC APIs (No Auth Required)
// ============================================

// Get restaurant by code (for QR scan / manual entry)
router.get('/public/restaurant/:code', async (req, res) => {
  try {
    const { code } = req.params;
    console.log(`📱 Public API: Looking up restaurant with code: ${code}`);

    // First try to find by restaurantCode field
    let restaurantSnapshot = await db.collection(collections.restaurants)
      .where('restaurantCode', '==', code.toUpperCase())
      .limit(1)
      .get();

    // If not found, try by document ID
    if (restaurantSnapshot.empty) {
      const restaurantDoc = await db.collection(collections.restaurants).doc(code).get();
      if (restaurantDoc.exists) {
        const data = restaurantDoc.data();
        // Check if customer app is enabled
        if (!data.customerAppSettings?.enabled) {
          return res.status(404).json({ error: 'Customer ordering is not enabled for this restaurant' });
        }

        return res.json({
          success: true,
          restaurant: {
            id: restaurantDoc.id,
            name: data.name,
            description: data.description,
            address: data.address,
            phone: data.phone,
            branding: data.customerAppSettings?.branding || {},
            settings: {
              allowDineIn: data.customerAppSettings?.allowDineIn ?? true,
              allowTakeaway: data.customerAppSettings?.allowTakeaway ?? true,
              allowDelivery: data.customerAppSettings?.allowDelivery ?? false,
              requireTableSelection: data.customerAppSettings?.requireTableSelection ?? false,
              minimumOrder: data.customerAppSettings?.minimumOrder ?? 0
            },
            loyaltySettings: data.customerAppSettings?.loyaltySettings || {
              enabled: false,
              pointsPerRupee: 1,
              redemptionRate: 100,
              maxRedemptionPercent: 20
            }
          }
        });
      }
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantDoc = restaurantSnapshot.docs[0];
    const data = restaurantDoc.data();

    // Check if customer app is enabled
    if (!data.customerAppSettings?.enabled) {
      return res.status(404).json({ error: 'Customer ordering is not enabled for this restaurant' });
    }

    res.json({
      success: true,
      restaurant: {
        id: restaurantDoc.id,
        name: data.name,
        description: data.description,
        address: data.address,
        phone: data.phone,
        branding: data.customerAppSettings?.branding || {},
        settings: {
          allowDineIn: data.customerAppSettings?.allowDineIn ?? true,
          allowTakeaway: data.customerAppSettings?.allowTakeaway ?? true,
          allowDelivery: data.customerAppSettings?.allowDelivery ?? false,
          requireTableSelection: data.customerAppSettings?.requireTableSelection ?? false,
          minimumOrder: data.customerAppSettings?.minimumOrder ?? 0
        },
        loyaltySettings: data.customerAppSettings?.loyaltySettings || {
          enabled: false,
          pointsPerRupee: 1,
          redemptionRate: 100,
          maxRedemptionPercent: 20
        }
      }
    });
  } catch (error) {
    console.error('Error fetching restaurant:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

// Get public menu for restaurant
router.get('/public/menu/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    console.log(`📱 Public API: Fetching menu for restaurant: ${restaurantId}`);

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const data = restaurantDoc.data();

    // Check if customer app is enabled
    if (!data.customerAppSettings?.enabled) {
      return res.status(404).json({ error: 'Customer ordering is not enabled for this restaurant' });
    }

    const menu = data.menu || { categories: [], items: [] };

    // Filter only available items
    const availableItems = (menu.items || []).filter(item =>
      item.isAvailable !== false && item.status !== 'unavailable'
    );

    // Get active offers
    const offersSnapshot = await db.collection('offers')
      .where('restaurantId', '==', restaurantId)
      .where('isActive', '==', true)
      .get();

    const now = new Date();
    const activeOffers = offersSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(offer => {
        const validFrom = offer.validFrom?.toDate?.() || new Date(offer.validFrom);
        const validUntil = offer.validUntil?.toDate?.() || new Date(offer.validUntil);
        return now >= validFrom && now <= validUntil;
      })
      .map(offer => ({
        id: offer.id,
        name: offer.name,
        description: offer.description,
        type: offer.type,
        value: offer.value,
        minOrderValue: offer.minOrderValue,
        maxDiscount: offer.maxDiscount,
        code: offer.code,
        autoApply: offer.autoApply
      }));

    res.json({
      success: true,
      restaurant: {
        id: restaurantDoc.id,
        name: data.name,
        branding: data.customerAppSettings?.branding || {}
      },
      categories: menu.categories || [],
      items: availableItems,
      offers: activeOffers
    });
  } catch (error) {
    console.error('Error fetching public menu:', error);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

// ============================================
// CUSTOMER AUTH APIs
// ============================================

// Send OTP to phone
router.post('/customer/auth/send-otp', async (req, res) => {
  try {
    const { phone, restaurantId } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Normalize phone number
    const normalizedPhone = phone.replace(/\D/g, '').slice(-10);
    if (normalizedPhone.length !== 10) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }

    // Generate OTP
    const otp = generateOTP();
    const otpKey = `${normalizedPhone}_${restaurantId || 'global'}`;

    // Store OTP with expiry (5 minutes)
    otpStore.set(otpKey, {
      otp,
      phone: normalizedPhone,
      restaurantId,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
    });

    // In production, send OTP via SMS (Twilio, etc.)
    // For now, log it and also return in development
    console.log(`📱 OTP for ${normalizedPhone}: ${otp}`);

    // TODO: Send SMS via Twilio
    // await sendSMS(normalizedPhone, `Your Crave verification code is: ${otp}`);

    res.json({
      success: true,
      message: 'OTP sent successfully',
      // Only include OTP in development for testing
      ...(process.env.NODE_ENV === 'development' && { otp })
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP and login/register
router.post('/customer/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, restaurantId, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    const normalizedPhone = phone.replace(/\D/g, '').slice(-10);
    const otpKey = `${normalizedPhone}_${restaurantId || 'global'}`;
    const storedData = otpStore.get(otpKey);

    // Verify OTP
    if (!storedData) {
      return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });
    }

    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(otpKey);
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }

    if (storedData.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // OTP verified, delete it
    otpStore.delete(otpKey);

    // Find or create customer
    let customerId;
    let customer;
    let isNewCustomer = false;

    // Search in customers collection
    const customerSnapshot = await db.collection(collections.customers)
      .where('phone', '==', normalizedPhone)
      .where('restaurantId', '==', restaurantId)
      .limit(1)
      .get();

    if (!customerSnapshot.empty) {
      // Existing customer
      const customerDoc = customerSnapshot.docs[0];
      customerId = customerDoc.id;
      customer = customerDoc.data();

      // Update last visit
      await db.collection(collections.customers).doc(customerId).update({
        lastVisit: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    } else {
      // New customer - create record
      isNewCustomer = true;
      const newCustomer = {
        phone: normalizedPhone,
        name: name || '',
        restaurantId,
        loyaltyPoints: 0,
        totalPointsEarned: 0,
        totalPointsRedeemed: 0,
        totalOrders: 0,
        totalSpent: 0,
        visitHistory: [],
        usedOffers: [],
        source: 'customer_app',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastVisit: new Date().toISOString()
      };

      const customerRef = await db.collection(collections.customers).add(newCustomer);
      customerId = customerRef.id;
      customer = newCustomer;
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        type: 'customer',
        customerId,
        phone: normalizedPhone,
        restaurantId,
        name: customer.name || name || ''
      },
      CUSTOMER_JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      isNewCustomer,
      token,
      customer: {
        id: customerId,
        phone: normalizedPhone,
        name: customer.name || name || '',
        loyaltyPoints: customer.loyaltyPoints || 0,
        totalOrders: customer.totalOrders || 0
      }
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// ============================================
// CUSTOMER PROFILE APIs (Auth Required)
// ============================================

// Get customer profile
router.get('/customer/profile', authenticateCustomer, async (req, res) => {
  try {
    const { customerId, restaurantId } = req.customer;

    const customerDoc = await db.collection(collections.customers).doc(customerId).get();
    if (!customerDoc.exists) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = customerDoc.data();

    // Get restaurant loyalty settings
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    const loyaltySettings = restaurantDoc.exists
      ? restaurantDoc.data().customerAppSettings?.loyaltySettings
      : null;

    res.json({
      success: true,
      customer: {
        id: customerId,
        phone: customer.phone,
        name: customer.name,
        email: customer.email,
        loyaltyPoints: customer.loyaltyPoints || 0,
        totalPointsEarned: customer.totalPointsEarned || 0,
        totalPointsRedeemed: customer.totalPointsRedeemed || 0,
        totalOrders: customer.totalOrders || 0,
        totalSpent: customer.totalSpent || 0
      },
      loyaltySettings
    });
  } catch (error) {
    console.error('Error fetching customer profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update customer profile
router.put('/customer/profile', authenticateCustomer, async (req, res) => {
  try {
    const { customerId } = req.customer;
    const { name, email } = req.body;

    const updateData = { updatedAt: new Date().toISOString() };
    if (name) updateData.name = name;
    if (email) updateData.email = email;

    await db.collection(collections.customers).doc(customerId).update(updateData);

    res.json({ success: true, message: 'Profile updated' });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================
// CUSTOMER ORDERS APIs
// ============================================

// Place order
router.post('/customer/orders', authenticateCustomer, async (req, res) => {
  try {
    const { customerId, restaurantId, phone, name } = req.customer;
    const {
      items,
      orderType, // 'dine_in', 'takeaway', 'delivery'
      tableNumber,
      deliveryAddress,
      redeemPoints,
      offerId,
      notes
    } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Order items are required' });
    }

    if (!orderType) {
      return res.status(400).json({ error: 'Order type is required' });
    }

    // Get restaurant
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    const settings = restaurant.customerAppSettings || {};
    const loyaltySettings = settings.loyaltySettings || {};

    // Validate order type
    if (orderType === 'dine_in' && !settings.allowDineIn) {
      return res.status(400).json({ error: 'Dine-in orders are not available' });
    }
    if (orderType === 'takeaway' && !settings.allowTakeaway) {
      return res.status(400).json({ error: 'Takeaway orders are not available' });
    }
    if (orderType === 'delivery' && !settings.allowDelivery) {
      return res.status(400).json({ error: 'Delivery orders are not available' });
    }

    // Validate table selection
    if (orderType === 'dine_in' && settings.requireTableSelection && !tableNumber) {
      return res.status(400).json({ error: 'Table number is required for dine-in orders' });
    }

    // Get customer
    const customerDoc = await db.collection(collections.customers).doc(customerId).get();
    const customer = customerDoc.exists ? customerDoc.data() : {};

    // Calculate order total
    const menu = restaurant.menu || { items: [] };
    let subtotal = 0;
    const orderItems = [];

    for (const orderItem of items) {
      const menuItem = menu.items.find(item => item.id === orderItem.itemId);
      if (!menuItem) {
        return res.status(400).json({ error: `Item not found: ${orderItem.itemId}` });
      }

      let itemPrice = menuItem.price || 0;

      // Handle variants
      if (orderItem.variantId && menuItem.variants) {
        const variant = menuItem.variants.find(v => v.name === orderItem.variantId || v.id === orderItem.variantId);
        if (variant) {
          itemPrice = variant.price;
        }
      }

      // Handle customizations
      let customizationsTotal = 0;
      if (orderItem.customizations && menuItem.customizations) {
        for (const custId of orderItem.customizations) {
          const customization = menuItem.customizations.find(c => c.id === custId || c.name === custId);
          if (customization) {
            customizationsTotal += customization.price || 0;
          }
        }
      }

      const itemTotal = (itemPrice + customizationsTotal) * orderItem.quantity;
      subtotal += itemTotal;

      orderItems.push({
        itemId: menuItem.id,
        name: menuItem.name,
        price: itemPrice,
        quantity: orderItem.quantity,
        variant: orderItem.variantId || null,
        customizations: orderItem.customizations || [],
        total: itemTotal
      });
    }

    // Validate minimum order
    if (settings.minimumOrder && subtotal < settings.minimumOrder) {
      return res.status(400).json({
        error: `Minimum order value is ₹${settings.minimumOrder}`
      });
    }

    // Calculate discounts
    let discount = 0;
    let appliedOffer = null;

    // Apply offer if provided
    if (offerId) {
      const offerDoc = await db.collection('offers').doc(offerId).get();
      if (offerDoc.exists) {
        const offer = offerDoc.data();

        // Validate offer
        const now = new Date();
        const validFrom = offer.validFrom?.toDate?.() || new Date(offer.validFrom);
        const validUntil = offer.validUntil?.toDate?.() || new Date(offer.validUntil);

        if (offer.isActive && now >= validFrom && now <= validUntil) {
          // Check if customer already used this offer
          const usedOffers = customer.usedOffers || [];
          if (!usedOffers.includes(offerId) || !offer.usageLimit || offer.usageLimit > 1) {
            // Check minimum order value
            if (!offer.minOrderValue || subtotal >= offer.minOrderValue) {
              // Calculate discount
              if (offer.type === 'percentage') {
                discount = (subtotal * offer.value) / 100;
                if (offer.maxDiscount) {
                  discount = Math.min(discount, offer.maxDiscount);
                }
              } else if (offer.type === 'flat') {
                discount = offer.value;
              }

              appliedOffer = {
                offerId: offerDoc.id,
                offerName: offer.name,
                discountAmount: discount
              };
            }
          }
        }
      }
    }

    // Calculate points redemption
    let pointsRedeemed = 0;
    let pointsDiscount = 0;

    if (redeemPoints && redeemPoints > 0 && loyaltySettings.enabled) {
      const availablePoints = customer.loyaltyPoints || 0;
      const maxRedeemablePoints = Math.min(redeemPoints, availablePoints);

      // Calculate max discount from points
      const maxPointsDiscount = (subtotal * (loyaltySettings.maxRedemptionPercent || 20)) / 100;
      const pointsValue = maxRedeemablePoints / (loyaltySettings.redemptionRate || 100);

      pointsDiscount = Math.min(pointsValue, maxPointsDiscount);
      pointsRedeemed = Math.floor(pointsDiscount * (loyaltySettings.redemptionRate || 100));
    }

    // Calculate final total
    const total = Math.max(0, subtotal - discount - pointsDiscount);

    // Calculate points earned
    let pointsEarned = 0;
    if (loyaltySettings.enabled) {
      pointsEarned = Math.floor(total * (loyaltySettings.pointsPerRupee || 1));
    }

    // Generate order number
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const counterRef = db.collection('daily_order_counters').doc(`${restaurantId}_${todayStr}`);

    const counterDoc = await counterRef.get();
    let orderNumber;
    if (counterDoc.exists) {
      await counterRef.update({ count: FieldValue.increment(1) });
      orderNumber = (counterDoc.data().count || 0) + 1;
    } else {
      await counterRef.set({ count: 1, date: todayStr });
      orderNumber = 1;
    }

    // Create order
    const order = {
      restaurantId,
      orderNumber,
      items: orderItems,
      subtotal,
      discount,
      pointsRedeemed,
      pointsDiscount,
      total,
      pointsEarned,
      appliedOffer,
      status: 'pending',
      orderSource: 'customer_app',
      customerAppOrderType: orderType,
      tableNumber: orderType === 'dine_in' ? tableNumber : null,
      deliveryAddress: orderType === 'delivery' ? deliveryAddress : null,
      notes,
      customer: {
        id: customerId,
        phone,
        name: name || customer.name || ''
      },
      paymentStatus: 'pending',
      paymentMethod: 'pay_at_restaurant',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const orderRef = await db.collection(collections.orders).add(order);

    // Update customer stats
    const customerUpdate = {
      totalOrders: FieldValue.increment(1),
      totalSpent: FieldValue.increment(total),
      lastVisit: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (pointsEarned > 0) {
      customerUpdate.loyaltyPoints = FieldValue.increment(pointsEarned - pointsRedeemed);
      customerUpdate.totalPointsEarned = FieldValue.increment(pointsEarned);
    }

    if (pointsRedeemed > 0) {
      customerUpdate.totalPointsRedeemed = FieldValue.increment(pointsRedeemed);
    }

    if (appliedOffer) {
      customerUpdate.usedOffers = FieldValue.arrayUnion(appliedOffer.offerId);
    }

    // Add to visit history
    customerUpdate.visitHistory = FieldValue.arrayUnion({
      date: new Date().toISOString(),
      orderId: orderRef.id,
      amount: total,
      pointsEarned,
      pointsRedeemed
    });

    await db.collection(collections.customers).doc(customerId).update(customerUpdate);

    // Update offer usage count
    if (appliedOffer) {
      await db.collection('offers').doc(appliedOffer.offerId).update({
        currentUsage: FieldValue.increment(1)
      });
    }

    res.json({
      success: true,
      order: {
        id: orderRef.id,
        orderNumber,
        status: 'pending',
        total,
        subtotal,
        discount,
        pointsRedeemed,
        pointsDiscount,
        pointsEarned,
        appliedOffer,
        estimatedTime: orderType === 'delivery' ? '30-45 mins' : '15-20 mins'
      }
    });
  } catch (error) {
    console.error('Error placing order:', error);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

// Get customer order history
router.get('/customer/orders', authenticateCustomer, async (req, res) => {
  try {
    const { customerId, restaurantId } = req.customer;
    const { limit = 20, offset = 0 } = req.query;

    const ordersSnapshot = await db.collection(collections.orders)
      .where('customer.id', '==', customerId)
      .where('restaurantId', '==', restaurantId)
      .orderBy('createdAt', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .get();

    const orders = ordersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Get single order
router.get('/customer/orders/:orderId', authenticateCustomer, async (req, res) => {
  try {
    const { customerId } = req.customer;
    const { orderId } = req.params;

    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderDoc.data();
    if (order.customer?.id !== customerId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ success: true, order: { id: orderDoc.id, ...order } });
  } catch (error) {
    console.error('Error fetching order:', error);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ============================================
// OFFERS APIs (for customer viewing)
// ============================================

// Get available offers for customer
router.get('/customer/offers/:restaurantId', authenticateCustomer, async (req, res) => {
  try {
    const { customerId } = req.customer;
    const { restaurantId } = req.params;

    // Get customer to check used offers
    const customerDoc = await db.collection(collections.customers).doc(customerId).get();
    const usedOffers = customerDoc.exists ? (customerDoc.data().usedOffers || []) : [];

    // Get active offers
    const offersSnapshot = await db.collection('offers')
      .where('restaurantId', '==', restaurantId)
      .where('isActive', '==', true)
      .get();

    const now = new Date();
    const offers = offersSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(offer => {
        const validFrom = offer.validFrom?.toDate?.() || new Date(offer.validFrom);
        const validUntil = offer.validUntil?.toDate?.() || new Date(offer.validUntil);
        return now >= validFrom && now <= validUntil;
      })
      .map(offer => ({
        id: offer.id,
        name: offer.name,
        description: offer.description,
        type: offer.type,
        value: offer.value,
        minOrderValue: offer.minOrderValue,
        maxDiscount: offer.maxDiscount,
        code: offer.code,
        autoApply: offer.autoApply,
        isUsed: usedOffers.includes(offer.id) && offer.usageLimit === 1
      }));

    res.json({ success: true, offers });
  } catch (error) {
    console.error('Error fetching offers:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

module.exports = router;
