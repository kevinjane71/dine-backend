// payment.js - Dine POS Payment API for Razorpay integration
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// Initialize routes using shared database instance
const initializePaymentRoutes = (db, razorpay) => {
  // 1. Create Order API
  router.post('/create-order', async (req, res) => {
    try {
      if (!razorpay) {
        return res.status(503).json({
          success: false,
          error: 'Payment service unavailable - Razorpay not configured'
        });
      }
      
      const { amount, currency = 'INR', planId, email, userId, phone, shopId } = req.body;
      
      // Validate required fields
      if (!amount || !planId || !email || !userId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: amount, planId, email, and userId are required'
        });
      }
      
      const amountInPaise = Math.round(Number(amount) * 100);

      console.log('[PAYMENT] Creating order with amount:', {
        originalAmount: amount,
        amountInPaise: amountInPaise,
        planId,
        email,
        userId,
        phone,
        shopId
      });

      // Create Razorpay order
      const order = await razorpay.orders.create({
        amount: amountInPaise, // convert to paise
        currency,
        receipt: `kirana_${Date.now()}`,
        notes: {
          planId,
          email,
          userId,
          phone,
          shopId,
          app: 'Dine' // Add app name to identify in webhook
        }
      });

      // Store order in database (filter out undefined values)
      const orderData = {
        orderId: order.id,
        amount: amountInPaise,
        currency,
        planId,
        email,
        userId,
        app: 'Dine', // Also store app name in database
        status: 'created',
        createdAt: new Date()
      };
      
      // Only add optional fields if they have values
      if (phone) orderData.phone = phone;
      if (shopId) orderData.shopId = shopId;
      
      await db.collection('dine_orders').doc(order.id).set(orderData);

      res.json({ 
        success: true, 
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency
        }
      });

    } catch (error) {
      console.error('[PAYMENT] Order creation error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to create order',
        details: error.message
      });
    }
  });

  // 2. Verify Payment API
  router.post('/verify', async (req, res) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        planId,
        userId
      } = req.body;

      // Verify signature
      const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
      shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
      const digest = shasum.digest('hex');

      if (digest !== razorpay_signature) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid signature' 
        });
      }

      // Get order details from database
      const orderDoc = await db.collection('dine_orders').doc(razorpay_order_id).get();

      if (!orderDoc.exists) {
        return res.status(404).json({ 
          success: false, 
          error: 'Order not found' 
        });
      }

      const orderData = orderDoc.data();

      // Create payment record (filter out undefined values)
      const paymentRef = db.collection('dine_payments').doc(razorpay_payment_id);
      const paymentDoc = {
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
        signature: razorpay_signature,
        planId: planId || orderData.planId,
        email: orderData.email,
        userId: userId || orderData.userId,
        amount: orderData.amount,
        currency: orderData.currency,
        app: 'Dine', // Add app name
        status: 'verified',
        verifiedAt: new Date()
      };
      
      // Only add optional fields if they have values
      if (orderData.phone) paymentDoc.phone = orderData.phone;
      if (orderData.shopId) paymentDoc.shopId = orderData.shopId;

      await paymentRef.set(paymentDoc);

      // Update order status
      await db.collection('dine_orders').doc(razorpay_order_id).update({
        status: 'paid',
        paymentId: razorpay_payment_id,
        updatedAt: new Date()
      });

      // Update user subscription
      await updateUserSubscription(db, orderData.userId, orderData.email, orderData.planId || planId);

      res.json({ 
        success: true, 
        message: 'Payment verified successfully',
        data: {
          planId: orderData.planId || planId,
          paymentId: razorpay_payment_id,
          email: orderData.email,
          userId: orderData.userId,
          phone: orderData.phone,
          shopId: orderData.shopId,
          orderId: razorpay_order_id,
          app: 'Dine' // Include app name in response
        }
      });

    } catch (error) {
      console.error('[PAYMENT] Payment verification error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Payment verification failed',
        details: error.message
      });
    }
  });

  // 3. Webhook Handler for automated payment notifications
  router.post('/webhook', 
    express.raw({ type: 'application/json' }), 
    async (req, res) => {
      try {
        // Verify webhook signature
        const signature = req.headers['x-razorpay-signature'];
        const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET);
        shasum.update(JSON.stringify(req.body));
        const digest = shasum.digest('hex');

        if (digest !== signature) {
          return res.status(400).json({ error: 'Invalid webhook signature' });
        }

        const event = req.body.event;
        const payment = req.body.payload.payment?.entity;
        
        if (!payment) {
          return res.status(400).json({ error: 'Invalid payment data in webhook' });
        }

        // FIRST check if this webhook is for Dine by examining the order notes
        try {
          const orderInfo = await razorpay.orders.fetch(payment.order_id);
          const appName = orderInfo.notes?.app || 'Unknown';
          
          // If this webhook is not for Dine, acknowledge it and return immediately
          if (appName !== 'Dine') {
            console.log(`[PAYMENT] Ignoring webhook for app: ${appName}, not for Dine`);
            return res.json({ 
              status: 'ok', 
              message: 'Webhook acknowledged but ignored - not for Dine'
            });
          }
          
          console.log(`[PAYMENT] Processing webhook for Dine:`, {
            paymentId: payment.id,
            orderId: payment.order_id,
            status: payment.status,
            event: event
          });
          
          // Create webhook record
          const webhookDoc = {
            fullPayload: req.body,
            webhookReceivedAt: new Date(),
            event,
            orderId: payment.order_id,
            paymentId: payment.id,
            status: payment.status || null,
            amount: payment.amount,
            currency: payment.currency,
            app: 'Dine'
          };

          // Store in dine_webhook_events collection
          await db.collection('dine_webhook_events').add(webhookDoc);

          // Handle specific events for Dine app
          if (event === 'payment.captured' || event === 'payment.authorized') {
            // Get order details
            const orderDoc = await db.collection('dine_orders').doc(payment.order_id).get();
            
            if (orderDoc.exists) {
              const orderData = orderDoc.data();
              
              // Update order status if it's not already paid
              if (orderData.status !== 'paid') {
                await db.collection('dine_orders').doc(payment.order_id).update({
                  status: 'paid',
                  paymentId: payment.id,
                  updatedAt: new Date()
                });
              }

              // Create or update payment record
              const paymentRef = db.collection('dine_payments').doc(payment.id);
              const paymentDoc = await paymentRef.get();
              
              if (!paymentDoc.exists) {
                const webhookPaymentDoc = {
                  orderId: payment.order_id,
                  paymentId: payment.id,
                  planId: orderData.planId,
                  email: orderData.email,
                  userId: orderData.userId,
                  amount: payment.amount,
                  currency: payment.currency,
                  status: payment.status,
                  app: 'Dine',
                  webhookAt: new Date()
                };
                
                // Only add optional fields if they have values
                if (orderData.phone) webhookPaymentDoc.phone = orderData.phone;
                if (orderData.shopId) webhookPaymentDoc.shopId = orderData.shopId;
                
                await paymentRef.set(webhookPaymentDoc);
              }

              // Update user subscription
              await updateUserSubscription(db, orderData.userId, orderData.email, orderData.planId);
              console.log(`[PAYMENT] Successfully processed payment for Dine, userId: ${orderData.userId}`);
            } else {
              console.log(`[PAYMENT] Order ${payment.order_id} not found for webhook ${event}`);
            }
          }
          
          // Send success response
          return res.json({ status: 'ok', message: 'Webhook processed successfully for Dine' });
          
        } catch (orderError) {
          console.error('[PAYMENT] Failed to fetch order details:', orderError);
          // If we can't determine the app, respond with an error
          return res.status(500).json({ 
            error: 'Error determining app ownership',
            details: orderError.message
          });
        }

      } catch (error) {
        console.error('[PAYMENT] Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
  });

  // 4. Get Payment History API
  router.get('/history/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const { limit = 10 } = req.query;

      // Validate userId
      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'User ID is required'
        });
      }

      // Get payment history for user
      const paymentsSnapshot = await db.collection('dine_payments')
        .where('userId', '==', userId)
        .where('app', '==', 'Dine') // Filter by app name
        .orderBy('verifiedAt', 'desc')
        .limit(parseInt(limit))
        .get();

      const payments = [];
      paymentsSnapshot.forEach(doc => {
        const data = doc.data();
        payments.push({
          paymentId: doc.id,
          orderId: data.orderId,
          planId: data.planId,
          amount: data.amount / 100, // Convert from paise to currency units
          currency: data.currency,
          status: data.status,
          date: data.verifiedAt ? data.verifiedAt.toDate() : null
        });
      });

      res.json({
        success: true,
        data: payments
      });

    } catch (error) {
      console.error('[PAYMENT] Error fetching payment history:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch payment history',
        details: error.message
      });
    }
  });

  // 5. Get Current Plan API
  router.get('/plan/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      // Validate userId
      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'User ID is required'
        });
      }

      // Get user document to check subscription
      const userDoc = await db.collection('dine_user_data').doc(userId).get();

      if (!userDoc.exists) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      const userData = userDoc.data();
      const subscription = userData.subscription || {
        planId: 'free',
        planName: 'Free Plan',
        status: 'active',
        startDate: new Date().toISOString(),
        endDate: null,
        features: getFeaturesByPlan('free')
      };

      res.json({
        success: true,
        data: subscription
      });

    } catch (error) {
      console.error('[PAYMENT] Error fetching current plan:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch current plan',
        details: error.message
      });
    }
  });

  // 6. Get User Subscription Status API
  router.get('/subscription/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'User ID is required'
        });
      }

      // Get user document to check subscription
      const userDoc = await db.collection('dine_user_data').doc(userId).get();

      if (!userDoc.exists) {
        console.log(`[PAYMENT] User ${userId} not found in billing database`);
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      const userData = userDoc.data();
      const subscription = userData.subscription || {
        planId: 'free',
        planName: 'Free Plan',
        status: 'active',
        startDate: new Date().toISOString(),
        endDate: null,
        features: getFeaturesByPlan('free'),
        app: 'Dine'
      };

      // Calculate days remaining for paid plans
      let daysRemaining = null;
      if (subscription.endDate && subscription.planId !== 'free') {
        const endDate = new Date(subscription.endDate);
        const now = new Date();
        const diffTime = endDate - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        daysRemaining = Math.max(0, diffDays);
        
        // Update status based on expiration
        if (diffDays <= 0 && subscription.status === 'active') {
          subscription.status = 'expired';
        }
      }

      res.json({
        success: true,
        subscription: {
          ...subscription,
          daysRemaining,
          isActive: subscription.status === 'active',
          isPaid: subscription.planId !== 'free'
        }
      });

    } catch (error) {
      console.error('[PAYMENT] Error fetching subscription:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch subscription status',
        details: error.message
      });
    }
  });

  // 7. Create User with Default Subscription API
  router.post('/create-user', async (req, res) => {
    try {
      const { userId, email, phone, role, planId = 'starter', restaurantInfo } = req.body;

      console.log('[PAYMENT] Creating billing user:', { userId, email, role, planId });

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'User ID is required'
        });
      }

      // Only owners and admins can have billing accounts
      if (role !== 'owner' && role !== 'admin') {
        return res.status(403).json({
          success: false,
          error: 'Only owners and admins can access billing'
        });
      }

      // Check if user already exists
      const userRef = db.collection('dine_user_data').doc(userId);
      const userDoc = await userRef.get();

      if (userDoc.exists) {
        console.log('[PAYMENT] User already exists:', userDoc.data());
        return res.json({
          success: true,
          message: 'User already exists',
          data: userDoc.data()
        });
      }

      // Create new user with default subscription
      const currentDate = new Date();
      const planDetails = getPlanDetails(planId);

      const newUserData = {
        uid: userId,
        email: email || '',
        phone: phone || '',
        role: role,
        restaurantInfo: restaurantInfo || {},
        createdAt: currentDate.toISOString(),
        lastUpdated: currentDate.toISOString(),
        app: 'Dine',
        subscription: {
          planId,
          planName: planDetails.name,
          status: 'active',
          startDate: currentDate.toISOString(),
          endDate: planId === 'starter' ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          features: planDetails.features,
          lastUpdated: currentDate.toISOString(),
          app: 'Dine'
        }
      };

      await userRef.set(newUserData);

      console.log('[PAYMENT] User created successfully:', newUserData);

      res.json({
        success: true,
        message: 'Billing user created successfully',
        data: newUserData
      });

    } catch (error) {
      console.error('[PAYMENT] Error creating user:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create billing user',
        details: error.message
      });
    }
  });

  // 8. Get Billing Information API
  router.post('/billing', async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required'
        });
      }

      // Find user document
      const usersRef = db.collection('dine_user_data');
      const userSnapshot = await usersRef
        .where('email', '==', email)
        .limit(1)
        .get();

      if (userSnapshot.empty) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      const userData = userSnapshot.docs[0].data();
      
      // Get subscription data from user document
      const subscription = userData.subscription || {};
      
      // Format as billing object
      const billingData = {
        currentPlan: subscription.planId || 'free',
        planName: subscription.planName || 'Free Plan',
        status: subscription.status || 'active',
        nextBillingDate: subscription.endDate || 'NA',
        lastPaymentDate: subscription.startDate || 'NA',
        features: subscription.features || getFeaturesByPlan('free'),
        lastUpdated: subscription.lastUpdated || new Date().toISOString()
      };

      return res.status(200).json({
        success: true,
        billing: billingData
      });

    } catch (error) {
      console.error('[PAYMENT] Error fetching billing data:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    }
  });

  return router;
};

// Helper function to update user subscription
async function updateUserSubscription(db, userId, email, planId) {
  try {
    console.log(`[PAYMENT] Updating subscription for user: ${userId}, plan: ${planId}`);
    
    if (!userId) {
      throw new Error('User ID is required for subscription update');
    }
    
    const userRef = db.collection('dine_user_data').doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      // Try to find by email as fallback
      if (email) {
        const userByEmailSnapshot = await db.collection('dine_user_data')
          .where('email', '==', email)
          .limit(1)
          .get();
        
        if (!userByEmailSnapshot.empty) {
          const userFoundByEmail = userByEmailSnapshot.docs[0];
          return updateUserSubscriptionDoc(userFoundByEmail.ref, planId);
        }
      }
      
      // User doesn't exist, create a new user document
      console.log(`[PAYMENT] User not found, creating new user document for: ${userId}`);
      const currentDate = new Date();
      const newUserData = {
        uid: userId,
        email: email || '',
        createdAt: currentDate.toISOString(),
        lastUpdated: currentDate.toISOString(),
        app: 'Dine'
      };
      
      // Create the user document
      await userRef.set(newUserData);
      console.log(`[PAYMENT] Created new user document for: ${userId}`);
      
      // Now update with subscription
      return updateUserSubscriptionDoc(userRef, planId);
    }
    
    return updateUserSubscriptionDoc(userRef, planId);
  } catch (error) {
    console.error('[PAYMENT] Update subscription error:', error);
    throw error;
  }
}

// Helper function to update the user document with subscription data
async function updateUserSubscriptionDoc(userRef, planId) {
  const currentDate = new Date();
  const endDate = new Date(currentDate);
  
  // Set end date based on plan (default to 1 month)
  switch (planId) {
    case 'yearly':
      endDate.setFullYear(endDate.getFullYear() + 1);
      break;
    case 'quarterly':
      endDate.setMonth(endDate.getMonth() + 3);
      break;
    default:
      endDate.setMonth(endDate.getMonth() + 1); // Monthly plan
  }
  
  // Get plan details
  const planDetails = getPlanDetails(planId);
  
  // Update user document with subscription information
  await userRef.update({
    subscription: {
      planId,
      planName: planDetails.name,
      status: 'active',
      startDate: currentDate.toISOString(),
      endDate: endDate.toISOString(),
      features: planDetails.features,
      lastUpdated: currentDate.toISOString(),
      app: 'Dine' // Add app name
    },
    lastUpdated: currentDate
  });
  
  return true;
}

// Helper function to get plan details
function getPlanDetails(planId) {
  const plans = {
    'starter': {
      name: 'Starter',
      features: getFeaturesByPlan('starter')
    },
    'professional': {
      name: 'Professional',
      features: getFeaturesByPlan('professional')
    },
    'enterprise': {
      name: 'Enterprise',
      features: getFeaturesByPlan('enterprise')
    },
    'free': {
      name: 'Free Plan',
      features: getFeaturesByPlan('free')
    },
    'basic': {
      name: 'Basic Plan',
      features: getFeaturesByPlan('basic')
    },
    'pro': {
      name: 'Pro Plan',
      features: getFeaturesByPlan('pro')
    },
    'monthly': {
      name: 'Monthly Plan',
      features: getFeaturesByPlan('pro')
    },
    'quarterly': {
      name: 'Quarterly Plan',
      features: getFeaturesByPlan('pro')
    },
    'yearly': {
      name: 'Annual Plan',
      features: getFeaturesByPlan('pro')
    }
  };
  
  return plans[planId] || plans['starter'];
}

// Helper function to get features by plan
function getFeaturesByPlan(planId) {
  switch (planId) {
    case 'enterprise':
      return {
        maxProducts: 'unlimited',
        maxLocations: 'unlimited',
        maxTransactions: 'unlimited',
        inventoryTracking: true,
        multiStore: true,
        advancedReports: true,
        prioritySupport: true,
        backupEnabled: true,
        staffAccounts: 'unlimited',
        apiAccess: true,
        customIntegrations: true
      };
    case 'professional':
      return {
        maxProducts: 'unlimited',
        maxLocations: 3,
        maxTransactions: 'unlimited',
        inventoryTracking: true,
        multiStore: true,
        advancedReports: true,
        prioritySupport: true,
        backupEnabled: true,
        staffAccounts: 10,
        customBranding: true
      };
    case 'starter':
      return {
        maxProducts: 50,
        maxLocations: 1,
        maxTransactions: 'unlimited',
        inventoryTracking: true,
        multiStore: false,
        advancedReports: false,
        prioritySupport: false,
        backupEnabled: false,
        staffAccounts: 1,
        tableManagement: 20
      };
    case 'pro':
      return {
        maxProducts: 10000,
        maxTransactions: 'unlimited',
        inventoryTracking: true,
        multiStore: true,
        advancedReports: true,
        prioritySupport: true,
        backupEnabled: true,
        staffAccounts: 10
      };
    case 'basic':
      return {
        maxProducts: 1000,
        maxTransactions: 5000,
        inventoryTracking: true,
        multiStore: false,
        advancedReports: false,
        prioritySupport: false,
        backupEnabled: true,
        staffAccounts: 3
      };
    case 'free':
    default:
      return {
        maxProducts: 100,
        maxTransactions: 500,
        inventoryTracking: true,
        multiStore: false,
        advancedReports: false,
        prioritySupport: false,
        backupEnabled: false,
        staffAccounts: 1
      };
  }
}

module.exports = initializePaymentRoutes; 