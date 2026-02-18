// dodoPayment.js - Dodo Payments integration for international subscriptions
const express = require('express');
const router = express.Router();

const initializeDodoPaymentRoutes = (db) => {
  let dodoClient = null;

  // Initialize Dodo Payments client
  const getDodoClient = async () => {
    if (dodoClient) return dodoClient;
    try {
      const DodoPayments = (await import('dodopayments')).default;
      dodoClient = new DodoPayments({
        bearerToken: process.env.DODO_PAYMENTS_API_KEY,
        environment: process.env.NODE_ENV === 'production' ? 'live_mode' : 'test_mode'
      });
      return dodoClient;
    } catch (error) {
      console.error('[DODO] Failed to initialize Dodo Payments client:', error);
      return null;
    }
  };

  // Dodo plan mapping - product IDs from env variables
  const DODO_PLANS = {
    spark: {
      productId: process.env.DODO_PRODUCT_ID_SPARK || 'pdt_0NYkVJEF5ywGL040N55IY',
      name: 'Spark',
      priceUSD: 9.99,
      priceGBP: 7.99
    },
    flame: {
      productId: process.env.DODO_PRODUCT_ID_FLAME || 'pdt_0NYkVvCPauMPQSMaIzqTS',
      name: 'Flame',
      priceUSD: 89,
      priceGBP: 69
    }
  };

  // Email validation helper
  const isValidEmail = (email) => {
    if (!email || typeof email !== 'string') return false;
    // Basic email regex - must have @ and domain
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  };

  // 1. Create Checkout Session
  router.post('/create-checkout', async (req, res) => {
    try {
      const { productId, planId, userId, email, name, returnUrl } = req.body;

      if (!productId || !userId || !email) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: productId, userId, and email are required'
        });
      }

      // Validate email format before sending to Dodo
      if (!isValidEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid email address',
          details: 'A valid email address is required for international payments. Phone numbers cannot be used as email.'
        });
      }

      const client = await getDodoClient();
      if (!client) {
        return res.status(503).json({
          success: false,
          error: 'Dodo Payments service unavailable - not configured'
        });
      }

      console.log('[DODO] Creating checkout session:', { productId, planId, userId, email });

      const session = await client.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: {
          email: email,
          name: name || email
        },
        return_url: returnUrl || `${process.env.FRONTEND_URL || 'http://localhost:3002'}/billing?payment=success`,
        metadata: {
          userId,
          planId: planId || '',
          app: 'Dine'
        }
      });

      // Store order in database
      const orderData = {
        sessionId: session.session_id || session.id,
        checkoutUrl: session.checkout_url || session.url,
        productId,
        planId: planId || '',
        userId,
        email,
        name: name || '',
        paymentGateway: 'dodo',
        app: 'Dine',
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      const orderRef = db.collection('dine_dodo_orders').doc(orderData.sessionId);
      await orderRef.set(orderData);

      console.log('[DODO] Checkout session created:', orderData.sessionId);

      res.json({
        success: true,
        checkoutUrl: orderData.checkoutUrl,
        sessionId: orderData.sessionId
      });

    } catch (error) {
      console.error('[DODO] Checkout creation error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create checkout session',
        details: error.message
      });
    }
  });

  // 2. Webhook Handler - All 22+ Dodo Payment events
  router.post('/webhook', async (req, res) => {
    try {
      const webhookId = req.headers['webhook-id'];
      const webhookSignature = req.headers['webhook-signature'];
      const webhookTimestamp = req.headers['webhook-timestamp'];

      if (!webhookId || !webhookSignature || !webhookTimestamp) {
        return res.status(400).json({ error: 'Missing webhook headers' });
      }

      // Verify webhook signature using raw body (preserved by bodyParser verify callback in index.js)
      const webhookSecret = process.env.DODO_WEBHOOK_KEY;
      if (webhookSecret) {
        try {
          const { Webhook } = await import('standardwebhooks');
          const wh = new Webhook(webhookSecret);
          const rawBody = req.rawBody || JSON.stringify(req.body);
          wh.verify(rawBody, {
            'webhook-id': webhookId,
            'webhook-signature': webhookSignature,
            'webhook-timestamp': webhookTimestamp
          });
        } catch (verifyError) {
          console.error('[DODO] Webhook signature verification failed:', verifyError);
          return res.status(400).json({ error: 'Invalid webhook signature' });
        }
      }

      const payload = req.body;
      const eventType = payload.type || payload.event;
      const data = payload.data || payload;

      console.log('[DODO] Webhook received:', { eventType, dataKeys: Object.keys(data) });

      // Store every webhook event for audit trail
      await db.collection('dine_dodo_webhook_events').add({
        eventType,
        payload,
        receivedAt: new Date().toISOString(),
        app: 'Dine'
      });

      // Helper to extract userId from event data
      const extractUserId = (eventData) => {
        const metadata = eventData.metadata || {};
        return metadata.userId || eventData.customer_id || null;
      };

      const extractPlanId = (eventData) => {
        const metadata = eventData.metadata || {};
        return metadata.planId || null;
      };

      // Handle all Dodo webhook events
      switch (eventType) {

        // ==================== PAYMENT EVENTS ====================

        case 'payment.succeeded': {
          const paymentData = data.payment || data;
          const userId = extractUserId(paymentData);
          const planId = extractPlanId(paymentData);

          if (userId) {
            // Update pending order to paid
            const ordersSnapshot = await db.collection('dine_dodo_orders')
              .where('userId', '==', userId)
              .where('status', '==', 'pending')
              .orderBy('createdAt', 'desc')
              .limit(1)
              .get();

            if (!ordersSnapshot.empty) {
              await ordersSnapshot.docs[0].ref.update({
                status: 'paid',
                paymentId: paymentData.id || paymentData.payment_id,
                paidAt: new Date().toISOString()
              });
            }

            // Activate subscription
            await updateDodoSubscription(db, userId, {
              status: 'active',
              planId: planId || 'spark',
              eventType: 'payment.succeeded'
            });
          }
          console.log(`[DODO] Payment succeeded for user: ${userId}`);
          break;
        }

        case 'payment.failed': {
          const paymentData = data.payment || data;
          const userId = extractUserId(paymentData);

          if (userId) {
            const ordersSnapshot = await db.collection('dine_dodo_orders')
              .where('userId', '==', userId)
              .where('status', '==', 'pending')
              .orderBy('createdAt', 'desc')
              .limit(1)
              .get();

            if (!ordersSnapshot.empty) {
              await ordersSnapshot.docs[0].ref.update({
                status: 'failed',
                failedAt: new Date().toISOString()
              });
            }
          }
          console.log(`[DODO] Payment failed for user: ${userId}`);
          break;
        }

        case 'payment.processing': {
          const paymentData = data.payment || data;
          const userId = extractUserId(paymentData);
          console.log(`[DODO] Payment processing for user: ${userId}`);
          break;
        }

        case 'payment.cancelled': {
          const paymentData = data.payment || data;
          const userId = extractUserId(paymentData);

          if (userId) {
            const ordersSnapshot = await db.collection('dine_dodo_orders')
              .where('userId', '==', userId)
              .where('status', '==', 'pending')
              .orderBy('createdAt', 'desc')
              .limit(1)
              .get();

            if (!ordersSnapshot.empty) {
              await ordersSnapshot.docs[0].ref.update({
                status: 'cancelled',
                cancelledAt: new Date().toISOString()
              });
            }
          }
          console.log(`[DODO] Payment cancelled for user: ${userId}`);
          break;
        }

        // ==================== SUBSCRIPTION EVENTS ====================

        case 'subscription.active': {
          const subData = data.subscription || data;
          const userId = extractUserId(subData);
          const planId = extractPlanId(subData);

          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'active',
              planId: planId || 'spark',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              eventType
            });
          }
          console.log(`[DODO] Subscription active for user: ${userId}`);
          break;
        }

        case 'subscription.renewed': {
          const subData = data.subscription || data;
          const userId = extractUserId(subData);
          const planId = extractPlanId(subData);

          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'active',
              planId: planId || 'spark',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              eventType
            });
          }
          console.log(`[DODO] Subscription renewed for user: ${userId}`);
          break;
        }

        case 'subscription.on_hold': {
          const subData = data.subscription || data;
          const userId = extractUserId(subData);

          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'on_hold',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              eventType
            });
          }
          console.log(`[DODO] Subscription on hold for user: ${userId}`);
          break;
        }

        case 'subscription.failed': {
          const subData = data.subscription || data;
          const userId = extractUserId(subData);

          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'failed',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              eventType
            });
          }
          console.log(`[DODO] Subscription failed for user: ${userId}`);
          break;
        }

        case 'subscription.cancelled': {
          const subData = data.subscription || data;
          const userId = extractUserId(subData);

          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'cancelled',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              eventType
            });
          }
          console.log(`[DODO] Subscription cancelled for user: ${userId}`);
          break;
        }

        case 'subscription.expired': {
          const subData = data.subscription || data;
          const userId = extractUserId(subData);

          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'expired',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              eventType
            });
          }
          console.log(`[DODO] Subscription expired for user: ${userId}`);
          break;
        }

        case 'subscription.plan_changed': {
          const subData = data.subscription || data;
          const userId = extractUserId(subData);
          const newPlanId = extractPlanId(subData) || subData.plan_id;

          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'active',
              planId: newPlanId || 'spark',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              eventType
            });
          }
          console.log(`[DODO] Subscription plan changed for user: ${userId} to ${newPlanId}`);
          break;
        }

        // ==================== REFUND EVENTS ====================

        case 'refund.succeeded': {
          const refundData = data.refund || data;
          const userId = extractUserId(refundData);

          // Store refund record
          await db.collection('dine_dodo_refunds').add({
            refundId: refundData.id || refundData.refund_id,
            paymentId: refundData.payment_id,
            amount: refundData.amount,
            currency: refundData.currency,
            userId: userId,
            status: 'succeeded',
            reason: refundData.reason || '',
            refundedAt: new Date().toISOString(),
            app: 'Dine'
          });

          // Downgrade subscription on full refund
          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'refunded',
              eventType
            });
          }
          console.log(`[DODO] Refund succeeded for user: ${userId}`);
          break;
        }

        case 'refund.failed': {
          const refundData = data.refund || data;
          const userId = extractUserId(refundData);

          await db.collection('dine_dodo_refunds').add({
            refundId: refundData.id || refundData.refund_id,
            paymentId: refundData.payment_id,
            amount: refundData.amount,
            userId: userId,
            status: 'failed',
            failedAt: new Date().toISOString(),
            app: 'Dine'
          });
          console.log(`[DODO] Refund failed for user: ${userId}`);
          break;
        }

        // ==================== DISPUTE EVENTS ====================

        case 'dispute.opened': {
          const disputeData = data.dispute || data;
          const userId = extractUserId(disputeData);

          await db.collection('dine_dodo_disputes').add({
            disputeId: disputeData.id || disputeData.dispute_id,
            paymentId: disputeData.payment_id,
            amount: disputeData.amount,
            currency: disputeData.currency,
            userId: userId,
            status: 'opened',
            reason: disputeData.reason || '',
            openedAt: new Date().toISOString(),
            app: 'Dine'
          });

          // Put subscription on hold during dispute
          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'disputed',
              eventType
            });
          }
          console.log(`[DODO] Dispute opened for user: ${userId}`);
          break;
        }

        case 'dispute.won': {
          const disputeData = data.dispute || data;
          const userId = extractUserId(disputeData);

          await db.collection('dine_dodo_disputes').add({
            disputeId: disputeData.id || disputeData.dispute_id,
            userId: userId,
            status: 'won',
            resolvedAt: new Date().toISOString(),
            app: 'Dine'
          });

          // Reactivate subscription - merchant won
          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'active',
              eventType
            });
          }
          console.log(`[DODO] Dispute won for user: ${userId}`);
          break;
        }

        case 'dispute.lost': {
          const disputeData = data.dispute || data;
          const userId = extractUserId(disputeData);

          await db.collection('dine_dodo_disputes').add({
            disputeId: disputeData.id || disputeData.dispute_id,
            userId: userId,
            status: 'lost',
            resolvedAt: new Date().toISOString(),
            app: 'Dine'
          });

          // Deactivate subscription - merchant lost
          if (userId) {
            await updateDodoSubscription(db, userId, {
              status: 'cancelled',
              eventType
            });
          }
          console.log(`[DODO] Dispute lost for user: ${userId}`);
          break;
        }

        case 'dispute.expired': {
          const disputeData = data.dispute || data;
          const userId = extractUserId(disputeData);

          await db.collection('dine_dodo_disputes').add({
            disputeId: disputeData.id || disputeData.dispute_id,
            userId: userId,
            status: 'expired',
            resolvedAt: new Date().toISOString(),
            app: 'Dine'
          });
          console.log(`[DODO] Dispute expired for user: ${userId}`);
          break;
        }

        case 'dispute.accepted': {
          const disputeData = data.dispute || data;
          const userId = extractUserId(disputeData);

          await db.collection('dine_dodo_disputes').add({
            disputeId: disputeData.id || disputeData.dispute_id,
            userId: userId,
            status: 'accepted',
            resolvedAt: new Date().toISOString(),
            app: 'Dine'
          });
          console.log(`[DODO] Dispute accepted for user: ${userId}`);
          break;
        }

        case 'dispute.cancelled': {
          const disputeData = data.dispute || data;
          const userId = extractUserId(disputeData);

          await db.collection('dine_dodo_disputes').add({
            disputeId: disputeData.id || disputeData.dispute_id,
            userId: userId,
            status: 'cancelled',
            resolvedAt: new Date().toISOString(),
            app: 'Dine'
          });

          // Reactivate if subscription was disputed
          if (userId) {
            const userDoc = await db.collection('dine_user_data').doc(userId).get();
            if (userDoc.exists && userDoc.data()?.subscription?.status === 'disputed') {
              await updateDodoSubscription(db, userId, {
                status: 'active',
                eventType
              });
            }
          }
          console.log(`[DODO] Dispute cancelled for user: ${userId}`);
          break;
        }

        case 'dispute.challenged': {
          const disputeData = data.dispute || data;
          const userId = extractUserId(disputeData);

          await db.collection('dine_dodo_disputes').add({
            disputeId: disputeData.id || disputeData.dispute_id,
            userId: userId,
            status: 'challenged',
            challengedAt: new Date().toISOString(),
            app: 'Dine'
          });
          console.log(`[DODO] Dispute challenged for user: ${userId}`);
          break;
        }

        // ==================== LICENSE EVENTS ====================

        case 'license_key.created': {
          const licenseData = data.license_key || data;
          console.log(`[DODO] License key created:`, licenseData.id);
          break;
        }

        default:
          console.log(`[DODO] Unhandled webhook event: ${eventType} - stored in audit log`);
      }

      res.json({ status: 'ok', message: `Webhook ${eventType} processed` });

    } catch (error) {
      console.error('[DODO] Webhook error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // 3. Get Dodo Subscription Status
  router.get('/subscription/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      if (!userId) {
        return res.status(400).json({ success: false, error: 'User ID is required' });
      }

      const userDoc = await db.collection('dine_user_data').doc(userId).get();

      if (!userDoc.exists) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      const userData = userDoc.data();
      const subscription = userData.subscription || {};

      res.json({
        success: true,
        subscription: {
          ...subscription,
          paymentGateway: subscription.paymentGateway || 'razorpay',
          isActive: subscription.status === 'active',
          isDodo: subscription.paymentGateway === 'dodo'
        }
      });

    } catch (error) {
      console.error('[DODO] Error fetching subscription:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch subscription',
        details: error.message
      });
    }
  });

  // 4. Get available Dodo plans
  router.get('/plans', (req, res) => {
    res.json({
      success: true,
      plans: DODO_PLANS
    });
  });

  return router;
};

// Helper: Update user subscription for Dodo payments
async function updateDodoSubscription(db, userId, { status, planId, dodoSubscriptionId, eventType }) {
  try {
    const userRef = db.collection('dine_user_data').doc(userId);
    const userDoc = await userRef.get();

    const currentDate = new Date();
    const endDate = new Date(currentDate);
    endDate.setMonth(endDate.getMonth() + 1);

    const planNames = {
      spark: 'Spark',
      flame: 'Flame'
    };

    const subscriptionUpdate = {
      status: status || 'active',
      lastUpdated: currentDate.toISOString(),
      paymentGateway: 'dodo',
      app: 'Dine'
    };

    // Only set plan fields if planId provided (some events like refund/dispute don't change plan)
    if (planId) {
      subscriptionUpdate.planId = planId;
      subscriptionUpdate.planName = planNames[planId] || planId;
    }

    // Only set dates for active/renewed events
    if (status === 'active') {
      subscriptionUpdate.startDate = currentDate.toISOString();
      subscriptionUpdate.endDate = endDate.toISOString();
    }

    if (dodoSubscriptionId) {
      subscriptionUpdate.dodoSubscriptionId = dodoSubscriptionId;
    }

    if (userDoc.exists) {
      // Merge with existing subscription data so we don't lose planId on dispute/refund events
      const existing = userDoc.data()?.subscription || {};
      await userRef.update({
        subscription: { ...existing, ...subscriptionUpdate },
        lastUpdated: currentDate.toISOString()
      });
    } else {
      await userRef.set({
        uid: userId,
        subscription: subscriptionUpdate,
        createdAt: currentDate.toISOString(),
        lastUpdated: currentDate.toISOString(),
        app: 'Dine'
      });
    }

    console.log(`[DODO] Subscription updated for user ${userId}: ${status} (${eventType})`);
  } catch (error) {
    console.error('[DODO] Error updating subscription:', error);
    throw error;
  }
}

module.exports = initializeDodoPaymentRoutes;
