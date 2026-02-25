// dodoPayment.js - Dodo Payments integration for international subscriptions
// Handles: checkout, webhooks, cancel, verify-session, sync, billing history, plan switch
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
        // Use dedicated env var instead of NODE_ENV (Vercel always sets production)
        environment: process.env.DODO_PAYMENTS_ENVIRONMENT || (process.env.NODE_ENV === 'production' ? 'live_mode' : 'test_mode')
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
      priceGBP: 7.99,
      interval: 'month',
    },
    flame: {
      productId: process.env.DODO_PRODUCT_ID_FLAME || 'pdt_0NYkVvCPauMPQSMaIzqTS',
      name: 'Flame',
      priceUSD: 89,
      priceGBP: 69,
      interval: 'month',
    }
  };

  // Email validation helper
  const isValidEmail = (email) => {
    if (!email || typeof email !== 'string') return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email.trim());
  };

  /** Helper: get frontend URL (never localhost for payment redirects) */
  function getFrontendUrl() {
    let url = process.env.FRONTEND_URL || 'https://dineopen.com';
    if (url.includes('localhost')) url = 'https://dineopen.com';
    return url;
  }

  /** Helper: log a billing event to dine_dodo_billing collection */
  async function logBillingEvent(data) {
    return db.collection('dine_dodo_billing').add({
      ...data,
      app: 'Dine',
      createdAt: new Date().toISOString(),
    });
  }

  /** Helper: find user by Dodo info (metadata.userId → subscriptionId → email) */
  async function findUserByDodoInfo({ customerEmail, subscriptionId, metadata }) {
    // Try by metadata userId first (most reliable)
    if (metadata?.userId) {
      const userDoc = await db.collection('dine_user_data').doc(metadata.userId).get();
      if (userDoc.exists) {
        return { id: userDoc.id, ...userDoc.data() };
      }
    }

    // Try by subscription ID
    if (subscriptionId) {
      const subQuery = await db.collection('dine_user_data')
        .where('subscription.dodoSubscriptionId', '==', subscriptionId)
        .limit(1)
        .get();
      if (!subQuery.empty) {
        const doc = subQuery.docs[0];
        return { id: doc.id, ...doc.data() };
      }
    }

    // Fallback to customer email
    if (customerEmail) {
      const emailQuery = await db.collection('dine_user_data')
        .where('email', '==', customerEmail)
        .limit(1)
        .get();
      if (!emailQuery.empty) {
        const doc = emailQuery.docs[0];
        return { id: doc.id, ...doc.data() };
      }
    }

    return null;
  }

  // ──────────────────────────────────────────────────────────
  // 1. Create Checkout Session
  // ──────────────────────────────────────────────────────────
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
          details: 'A valid email address is required for international payments.'
        });
      }

      const client = await getDodoClient();
      if (!client) {
        return res.status(503).json({
          success: false,
          error: 'Dodo Payments service unavailable - not configured'
        });
      }

      // Get current subscription to check for same-plan and plan switch
      const userDoc = await db.collection('dine_user_data').doc(userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      const currentSub = userData.subscription || {};

      // Prevent buying same plan
      if (currentSub.planId === planId && currentSub.status === 'active' && currentSub.paymentGateway === 'dodo') {
        return res.status(400).json({
          success: false,
          error: 'You are already on this plan'
        });
      }

      // Cancel old Dodo subscription if switching plans
      if (currentSub.dodoSubscriptionId && currentSub.status === 'active' && currentSub.paymentGateway === 'dodo') {
        try {
          await client.subscriptions.update(currentSub.dodoSubscriptionId, { status: 'cancelled' });
          console.log(`[DODO] Cancelled old subscription ${currentSub.dodoSubscriptionId} for plan switch`);

          await logBillingEvent({
            userId,
            type: 'subscription_cancelled_for_switch',
            previousPlanId: currentSub.planId,
            newPlanId: planId,
            dodoSubscriptionId: currentSub.dodoSubscriptionId,
          });
        } catch (err) {
          console.warn('[DODO] Could not cancel old subscription:', err.message);
          await logBillingEvent({
            userId,
            type: 'cancel_old_sub_failed',
            previousPlanId: currentSub.planId,
            newPlanId: planId,
            dodoSubscriptionId: currentSub.dodoSubscriptionId,
            error: err.message,
          });
        }
      }

      const checkoutReturnUrl = returnUrl || `${getFrontendUrl()}/billing`;
      console.log('[DODO] Creating checkout session:', { productId, planId, userId, email, returnUrl: checkoutReturnUrl });

      const session = await client.checkoutSessions.create({
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: {
          email: email,
          name: name || email
        },
        return_url: checkoutReturnUrl,
        metadata: {
          userId,
          planId: planId || '',
          previousPlanId: currentSub.planId || 'free-trial',
          app: 'Dine'
        }
      });

      // Store order in database
      const orderData = {
        sessionId: session.session_id || session.id,
        checkoutUrl: session.checkout_url || session.url,
        productId,
        planId: planId || '',
        previousPlanId: currentSub.planId || 'free-trial',
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

      // Log checkout creation
      await logBillingEvent({
        userId,
        type: 'checkout_created',
        sessionId: orderData.sessionId,
        planId: planId || '',
        previousPlanId: currentSub.planId || 'free-trial',
        productId,
        status: 'pending',
      });

      console.log('[DODO] Checkout session created:', orderData.sessionId);

      res.json({
        success: true,
        checkoutUrl: orderData.checkoutUrl,
        sessionId: orderData.sessionId
      });

    } catch (error) {
      console.error('[DODO] Checkout creation error:', error);

      // Log failure
      await logBillingEvent({
        userId: req.body?.userId,
        type: 'checkout_failed',
        planId: req.body?.planId,
        error: error.message,
        status: 'failed',
      }).catch(() => {});

      res.status(500).json({
        success: false,
        error: 'Failed to create checkout session',
        details: error.message
      });
    }
  });

  // ──────────────────────────────────────────────────────────
  // 2. Verify Session — After redirect back from Dodo checkout
  //    Dodo appends: ?subscription_id=sub_xxx&status=active&email=xxx
  // ──────────────────────────────────────────────────────────
  router.get('/verify-session', async (req, res) => {
    try {
      const { subscription_id, status, userId } = req.query;

      if (!subscription_id || !userId) {
        return res.status(400).json({ success: false, error: 'subscription_id and userId are required' });
      }

      // Find most recent pending order for this user (no orderBy — avoids index issues)
      const ordersSnapshot = await db.collection('dine_dodo_orders')
        .where('userId', '==', userId)
        .where('status', '==', 'pending')
        .limit(5)
        .get();

      if (ordersSnapshot.empty) {
        return res.status(404).json({ success: false, error: 'No pending checkout found' });
      }

      // Find most recent
      let latestDoc = null;
      let latestTime = 0;
      ordersSnapshot.docs.forEach(doc => {
        const t = new Date(doc.data().createdAt).getTime();
        if (t > latestTime) { latestTime = t; latestDoc = doc; }
      });

      const orderData = latestDoc.data();

      // Check if already activated (webhook may have fired first)
      const userDoc = await db.collection('dine_user_data').doc(userId).get();
      const currentSub = userDoc.exists ? userDoc.data()?.subscription : null;
      if (currentSub && currentSub.planId === orderData.planId && currentSub.status === 'active' && currentSub.paymentGateway === 'dodo') {
        return res.json({
          success: true,
          status: 'active',
          subscription: currentSub,
          message: 'Subscription is already active!',
        });
      }

      // Activate if Dodo returned active/succeeded/pending
      if (status === 'active' || status === 'succeeded' || status === 'pending') {
        await updateDodoSubscription(db, userId, {
          status: 'active',
          planId: orderData.planId || 'spark',
          dodoSubscriptionId: subscription_id,
          eventType: 'verify-session',
        });

        // Update order record
        await latestDoc.ref.update({
          status: 'paid',
          dodoSubscriptionId: subscription_id,
          completedAt: new Date().toISOString(),
        });

        await logBillingEvent({
          userId,
          type: 'subscription_activated',
          planId: orderData.planId,
          previousPlanId: orderData.previousPlanId || 'free-trial',
          dodoSubscriptionId: subscription_id,
          activatedVia: 'verify-session',
        });

        const updatedUser = await db.collection('dine_user_data').doc(userId).get();
        return res.json({
          success: true,
          status: 'active',
          subscription: updatedUser.data()?.subscription,
          message: `Successfully upgraded to ${orderData.planId}!`,
        });
      }

      // Unexpected status
      await logBillingEvent({
        userId,
        type: 'verify_session_unexpected_status',
        dodoStatus: status,
        dodoSubscriptionId: subscription_id,
        planId: orderData.planId,
      });

      res.json({ success: true, status: status || 'unknown', message: 'Payment processing...' });

    } catch (error) {
      console.error('[DODO] Verify session error:', error);
      res.status(500).json({ success: false, error: 'Failed to verify session' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // 3. Sync / Restore — recover pending checkouts on page load
  // ──────────────────────────────────────────────────────────
  router.post('/sync', async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId is required' });
      }

      // Find pending orders (no orderBy — avoids index issues)
      const pendingQuery = await db.collection('dine_dodo_orders')
        .where('userId', '==', userId)
        .where('status', '==', 'pending')
        .limit(5)
        .get();

      if (pendingQuery.empty) {
        return res.json({ success: true, synced: false, message: 'No pending checkouts found' });
      }

      // Find most recent valid
      let latestDoc = null;
      let latestTime = 0;
      pendingQuery.docs.forEach(doc => {
        const data = doc.data();
        if (!data.planId) return;
        const t = new Date(data.createdAt).getTime();
        if (t > latestTime) { latestTime = t; latestDoc = doc; }
      });

      if (!latestDoc) {
        return res.json({ success: true, synced: false, message: 'No valid pending checkouts' });
      }

      const checkout = latestDoc.data();
      const checkoutAge = Date.now() - latestTime;

      // Only sync checkouts from last 7 days
      if (checkoutAge > 7 * 24 * 60 * 60 * 1000) {
        await latestDoc.ref.update({ status: 'expired' });
        return res.json({ success: true, synced: false, message: 'Pending checkout expired' });
      }

      // Activate the subscription
      await updateDodoSubscription(db, userId, {
        status: 'active',
        planId: checkout.planId,
        dodoSubscriptionId: checkout.dodoSubscriptionId || null,
        eventType: 'manual-sync',
      });

      await latestDoc.ref.update({ status: 'paid', syncedAt: new Date().toISOString() });

      await logBillingEvent({
        userId,
        type: 'subscription_activated',
        planId: checkout.planId,
        activatedVia: 'manual-sync',
      });

      const updatedUser = await db.collection('dine_user_data').doc(userId).get();

      res.json({
        success: true,
        synced: true,
        subscription: updatedUser.data()?.subscription,
        message: `Successfully activated ${checkout.planId}!`,
      });

    } catch (error) {
      console.error('[DODO] Sync error:', error);
      res.status(500).json({ success: false, error: 'Failed to sync subscription' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // 4. Cancel Subscription
  // ──────────────────────────────────────────────────────────
  router.post('/cancel', async (req, res) => {
    try {
      const { userId } = req.body;

      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId is required' });
      }

      const userDoc = await db.collection('dine_user_data').doc(userId).get();
      if (!userDoc.exists) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      const userData = userDoc.data();
      const subscription = userData.subscription || {};

      if (!subscription.planId || subscription.planId === 'free-trial' || subscription.planId === 'free') {
        return res.status(400).json({ success: false, error: 'No active paid subscription to cancel' });
      }

      if (subscription.status === 'cancelled') {
        return res.status(400).json({ success: false, error: 'Subscription is already cancelled' });
      }

      // Cancel on Dodo if we have a subscription ID
      let dodoCancelSuccess = false;
      if (subscription.dodoSubscriptionId && subscription.paymentGateway === 'dodo') {
        try {
          const client = await getDodoClient();
          if (client) {
            await client.subscriptions.update(subscription.dodoSubscriptionId, { status: 'cancelled' });
            dodoCancelSuccess = true;
          }
        } catch (err) {
          console.error('[DODO] Error cancelling on Dodo:', err.message);
          await logBillingEvent({
            userId,
            type: 'dodo_cancel_failed',
            dodoSubscriptionId: subscription.dodoSubscriptionId,
            planId: subscription.planId,
            error: err.message,
          });
        }
      }

      // Update local subscription
      await db.collection('dine_user_data').doc(userId).update({
        'subscription.status': 'cancelled',
        'subscription.cancelledAt': new Date().toISOString(),
        'subscription.autoRenew': false,
        lastUpdated: new Date().toISOString(),
      });

      await logBillingEvent({
        userId,
        type: 'subscription_cancelled',
        planId: subscription.planId,
        dodoSubscriptionId: subscription.dodoSubscriptionId,
        dodoCancelSuccess,
        endDate: subscription.endDate,
      });

      res.json({
        success: true,
        message: subscription.endDate
          ? `Subscription cancelled. You will retain access until ${subscription.endDate}`
          : 'Subscription cancelled.',
        endDate: subscription.endDate,
      });

    } catch (error) {
      console.error('[DODO] Cancel error:', error);
      res.status(500).json({ success: false, error: 'Failed to cancel subscription' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // 5. Billing History
  // ──────────────────────────────────────────────────────────
  router.get('/billing-history/:userId', async (req, res) => {
    try {
      const { userId } = req.params;

      if (!userId) {
        return res.status(400).json({ success: false, error: 'User ID is required' });
      }

      // Get billing events (no orderBy — avoids index issues, sort in memory)
      const billingSnapshot = await db.collection('dine_dodo_billing')
        .where('userId', '==', userId)
        .limit(50)
        .get();

      const history = [];
      billingSnapshot.forEach(doc => {
        const data = doc.data();
        history.push({
          id: doc.id,
          type: data.type,
          planId: data.planId,
          amount: data.amount,
          currency: data.currency || 'USD',
          status: data.status,
          createdAt: data.createdAt,
        });
      });

      // Sort by date descending
      history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      res.json({ success: true, history });

    } catch (error) {
      console.error('[DODO] Billing history error:', error);
      res.status(500).json({ success: false, error: 'Failed to get billing history' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // 6. Webhook Handler — All Dodo Payment events
  //    ALWAYS returns 200 to prevent infinite retries
  // ──────────────────────────────────────────────────────────
  router.post('/webhook', async (req, res) => {
    try {
      const webhookId = req.headers['webhook-id'];
      const webhookSignature = req.headers['webhook-signature'];
      const webhookTimestamp = req.headers['webhook-timestamp'];

      if (!webhookId || !webhookSignature || !webhookTimestamp) {
        return res.status(200).json({ received: true, error: 'Missing webhook headers' });
      }

      // Verify webhook signature using raw body
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
          // Still return 200 to prevent retries, but log the failure
          return res.status(200).json({ received: true, error: 'Invalid signature' });
        }
      }

      const payload = req.body;
      const eventType = payload.type || payload.event;
      const data = payload.data || payload;

      console.log('[DODO] Webhook received:', { eventType, dataKeys: Object.keys(data) });

      // Store every webhook event for audit trail
      const eventRef = await db.collection('dine_dodo_webhook_events').add({
        eventType,
        payload,
        headers: {
          'webhook-id': webhookId,
          'webhook-timestamp': webhookTimestamp,
        },
        receivedAt: new Date().toISOString(),
        processed: false,
        app: 'Dine'
      });

      try {
        // Helper to extract userId from event data
        const extractUserId = (eventData) => {
          const metadata = eventData.metadata || {};
          return metadata.userId || eventData.customer_id || null;
        };

        const extractPlanId = (eventData) => {
          const metadata = eventData.metadata || {};
          return metadata.planId || null;
        };

        switch (eventType) {
          // ── PAYMENT EVENTS ──
          case 'payment.succeeded': {
            const paymentData = data.payment || data;
            const userId = extractUserId(paymentData);
            const planId = extractPlanId(paymentData);

            if (userId) {
              // Update pending order (no orderBy — avoids index issues)
              const ordersSnapshot = await db.collection('dine_dodo_orders')
                .where('userId', '==', userId)
                .where('status', '==', 'pending')
                .limit(5)
                .get();

              if (!ordersSnapshot.empty) {
                // Find most recent
                let latestDoc = ordersSnapshot.docs[0];
                let latestTime = 0;
                ordersSnapshot.docs.forEach(doc => {
                  const t = new Date(doc.data().createdAt).getTime();
                  if (t > latestTime) { latestTime = t; latestDoc = doc; }
                });
                await latestDoc.ref.update({
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

            await logBillingEvent({
              userId: userId || null,
              type: 'payment_succeeded',
              dodoPaymentId: paymentData.id || paymentData.payment_id,
              amount: paymentData.amount,
              currency: paymentData.currency || 'USD',
              planId: planId,
            });

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
                .limit(5)
                .get();

              if (!ordersSnapshot.empty) {
                let latestDoc = ordersSnapshot.docs[0];
                let latestTime = 0;
                ordersSnapshot.docs.forEach(doc => {
                  const t = new Date(doc.data().createdAt).getTime();
                  if (t > latestTime) { latestTime = t; latestDoc = doc; }
                });
                await latestDoc.ref.update({
                  status: 'failed',
                  failedAt: new Date().toISOString()
                });
              }
            }

            await logBillingEvent({
              userId: userId || null,
              type: 'payment_failed',
              dodoPaymentId: paymentData.id || paymentData.payment_id,
              amount: paymentData.amount,
              failureReason: paymentData.failure_reason || 'unknown',
            });

            console.log(`[DODO] Payment failed for user: ${userId}`);
            break;
          }

          case 'payment.processing': {
            const paymentData = data.payment || data;
            const userId = extractUserId(paymentData);
            await logBillingEvent({ userId, type: 'payment_processing', dodoPaymentId: paymentData.id });
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
                .limit(5)
                .get();

              if (!ordersSnapshot.empty) {
                let latestDoc = ordersSnapshot.docs[0];
                let latestTime = 0;
                ordersSnapshot.docs.forEach(doc => {
                  const t = new Date(doc.data().createdAt).getTime();
                  if (t > latestTime) { latestTime = t; latestDoc = doc; }
                });
                await latestDoc.ref.update({
                  status: 'cancelled',
                  cancelledAt: new Date().toISOString()
                });
              }
            }

            await logBillingEvent({ userId, type: 'payment_cancelled', dodoPaymentId: (data.payment || data).id });
            console.log(`[DODO] Payment cancelled for user: ${userId}`);
            break;
          }

          // ── SUBSCRIPTION EVENTS ──
          case 'subscription.active': {
            const subData = data.subscription || data;
            const userId = extractUserId(subData);
            const planId = extractPlanId(subData);
            const subscriptionId = subData.id || subData.subscription_id;

            // Also try finding user by subscription ID or email
            let resolvedUserId = userId;
            if (!resolvedUserId) {
              const user = await findUserByDodoInfo({
                subscriptionId,
                customerEmail: subData.customer?.email,
                metadata: subData.metadata,
              });
              if (user) resolvedUserId = user.id;
            }

            // Match plan by product ID if planId not in metadata
            let resolvedPlanId = planId || 'spark';
            if (!planId) {
              const productId = subData.product_id || subData.items?.[0]?.product_id;
              for (const [key, plan] of Object.entries(DODO_PLANS)) {
                if (plan.productId === productId) { resolvedPlanId = key; break; }
              }
            }

            if (resolvedUserId) {
              await updateDodoSubscription(db, resolvedUserId, {
                status: 'active',
                planId: resolvedPlanId,
                dodoSubscriptionId: subscriptionId,
                eventType
              });
            }

            await logBillingEvent({
              userId: resolvedUserId,
              type: 'subscription_activated',
              planId: resolvedPlanId,
              dodoSubscriptionId: subscriptionId,
              activatedVia: 'webhook',
            });

            console.log(`[DODO] Subscription active for user: ${resolvedUserId}`);
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

            await logBillingEvent({
              userId,
              type: 'renewal',
              planId: planId,
              dodoSubscriptionId: subData.id || subData.subscription_id,
              amount: subData.amount,
            });

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

            await logBillingEvent({ userId, type: 'subscription_on_hold', dodoSubscriptionId: subData.id });
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

            await logBillingEvent({ userId, type: 'subscription_creation_failed', dodoSubscriptionId: subData.id, reason: subData.failure_reason });
            console.log(`[DODO] Subscription failed for user: ${userId}`);
            break;
          }

          // Handle both spellings
          case 'subscription.cancelled':
          case 'subscription.canceled': {
            const subData = data.subscription || data;
            const userId = extractUserId(subData);

            if (userId) {
              await db.collection('dine_user_data').doc(userId).update({
                'subscription.status': 'cancelled',
                'subscription.cancelledAt': new Date().toISOString(),
                'subscription.autoRenew': false,
                lastUpdated: new Date().toISOString(),
              }).catch(() => {});
            }

            await logBillingEvent({
              userId,
              type: 'subscription_cancelled',
              dodoSubscriptionId: subData.id || subData.subscription_id,
              cancelledVia: 'webhook',
            });

            console.log(`[DODO] Subscription cancelled for user: ${userId}`);
            break;
          }

          case 'subscription.expired': {
            const subData = data.subscription || data;
            const userId = extractUserId(subData);

            if (userId) {
              // Downgrade to free trial
              const previousPlan = (await db.collection('dine_user_data').doc(userId).get()).data()?.subscription?.planId;
              await updateDodoSubscription(db, userId, {
                status: 'expired',
                dodoSubscriptionId: subData.id || subData.subscription_id,
                eventType
              });

              await logBillingEvent({
                userId,
                type: 'subscription_expired',
                previousPlanId: previousPlan,
                dodoSubscriptionId: subData.id,
                downgradedTo: 'free-trial',
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

            await logBillingEvent({ userId, type: 'plan_changed', planId: newPlanId, dodoSubscriptionId: subData.id });
            console.log(`[DODO] Subscription plan changed for user: ${userId} to ${newPlanId}`);
            break;
          }

          // ── REFUND EVENTS ──
          case 'refund.succeeded': {
            const refundData = data.refund || data;
            const userId = extractUserId(refundData);

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

            // Downgrade subscription on refund
            if (userId) {
              const previousPlan = (await db.collection('dine_user_data').doc(userId).get()).data()?.subscription?.planId;
              await updateDodoSubscription(db, userId, {
                status: 'refunded',
                eventType
              });

              await logBillingEvent({
                userId,
                type: 'refund_downgrade',
                previousPlanId: previousPlan,
                refundAmount: refundData.amount,
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

            await logBillingEvent({ userId, type: 'refund_failed', dodoPaymentId: refundData.payment_id });
            console.log(`[DODO] Refund failed for user: ${userId}`);
            break;
          }

          // ── DISPUTE EVENTS ──
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

            if (userId) {
              await updateDodoSubscription(db, userId, {
                status: 'disputed',
                eventType
              });
            }

            await logBillingEvent({ userId, type: 'dispute_opened', amount: disputeData.amount });
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

            // Reactivate — merchant won
            if (userId) {
              await updateDodoSubscription(db, userId, {
                status: 'active',
                eventType
              });
            }

            await logBillingEvent({ userId, type: 'dispute_won' });
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

            // Deactivate — merchant lost
            if (userId) {
              const previousPlan = (await db.collection('dine_user_data').doc(userId).get()).data()?.subscription?.planId;
              await updateDodoSubscription(db, userId, {
                status: 'cancelled',
                eventType
              });

              await logBillingEvent({ userId, type: 'dispute_lost_downgrade', previousPlanId: previousPlan });
            }
            console.log(`[DODO] Dispute lost for user: ${userId}`);
            break;
          }

          case 'dispute.expired':
          case 'dispute.accepted':
          case 'dispute.challenged': {
            const disputeData = data.dispute || data;
            const userId = extractUserId(disputeData);

            await db.collection('dine_dodo_disputes').add({
              disputeId: disputeData.id || disputeData.dispute_id,
              userId: userId,
              status: eventType.split('.')[1],
              resolvedAt: new Date().toISOString(),
              app: 'Dine'
            });

            // Reactivate if dispute was cancelled and sub was disputed
            if (eventType === 'dispute.cancelled' && userId) {
              const userDoc = await db.collection('dine_user_data').doc(userId).get();
              if (userDoc.exists && userDoc.data()?.subscription?.status === 'disputed') {
                await updateDodoSubscription(db, userId, { status: 'active', eventType });
              }
            }

            await logBillingEvent({ userId, type: eventType.replace('.', '_') });
            console.log(`[DODO] ${eventType} for user: ${userId}`);
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
                await updateDodoSubscription(db, userId, { status: 'active', eventType });
              }
            }

            await logBillingEvent({ userId, type: 'dispute_cancelled' });
            console.log(`[DODO] Dispute cancelled for user: ${userId}`);
            break;
          }

          case 'license_key.created': {
            const licenseData = data.license_key || data;
            console.log(`[DODO] License key created:`, licenseData.id);
            break;
          }

          default:
            console.log(`[DODO] Unhandled webhook event: ${eventType} - stored in audit log`);
        }

        // Mark event as processed
        await eventRef.update({ processed: true, processedAt: new Date().toISOString() });

      } catch (processingError) {
        console.error(`[DODO] Error processing ${eventType}:`, processingError.message);
        await eventRef.update({
          processed: false,
          error: processingError.message,
          errorAt: new Date().toISOString(),
        });
      }

      // ALWAYS return 200 to prevent retries
      res.status(200).json({ received: true, message: `Webhook ${eventType} processed` });

    } catch (error) {
      console.error('[DODO] Webhook error:', error);
      // Always return 200 even on unexpected errors
      res.status(200).json({ received: true, error: 'Processing error logged' });
    }
  });

  // ──────────────────────────────────────────────────────────
  // 7. Get Dodo Subscription Status (with auto-recovery)
  // ──────────────────────────────────────────────────────────
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
      let subscription = userData.subscription || {};

      // Auto-recover: if user is on free/expired, check for pending checkouts (< 24h)
      const isFree = !subscription.planId || subscription.planId === 'free-trial' || subscription.planId === 'free' || subscription.status === 'expired';
      if (isFree) {
        try {
          const pendingQuery = await db.collection('dine_dodo_orders')
            .where('userId', '==', userId)
            .where('status', '==', 'pending')
            .limit(5)
            .get();

          if (!pendingQuery.empty) {
            let latestDoc = null;
            let latestTime = 0;
            pendingQuery.docs.forEach(doc => {
              const t = new Date(doc.data().createdAt).getTime();
              if (t > latestTime) { latestTime = t; latestDoc = doc; }
            });

            if (latestDoc) {
              const checkout = latestDoc.data();
              const checkoutAge = Date.now() - latestTime;
              if (checkoutAge < 24 * 60 * 60 * 1000 && checkout.planId) {
                await updateDodoSubscription(db, userId, {
                  status: 'active',
                  planId: checkout.planId,
                  dodoSubscriptionId: checkout.dodoSubscriptionId || null,
                  eventType: 'auto-recover',
                });
                await latestDoc.ref.update({ status: 'paid', recoveredAt: new Date().toISOString() });

                await logBillingEvent({
                  userId,
                  type: 'auto_recovered',
                  planId: checkout.planId,
                  message: 'Pending checkout auto-recovered on page load',
                });

                console.log(`[DODO] Auto-recovered ${checkout.planId} for user ${userId}`);

                // Re-read updated subscription
                const updatedDoc = await db.collection('dine_user_data').doc(userId).get();
                subscription = updatedDoc.data()?.subscription || {};
              }
            }
          }
        } catch (err) {
          console.error('[DODO] Auto-recover check failed:', err.message);
        }
      }

      res.json({
        success: true,
        subscription: {
          ...subscription,
          paymentGateway: subscription.paymentGateway || 'dodo',
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

  // ──────────────────────────────────────────────────────────
  // 8. Get available Dodo plans
  // ──────────────────────────────────────────────────────────
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
      autoRenew: status === 'active',
      app: 'Dine'
    };

    // Only set plan fields if planId provided
    if (planId) {
      subscriptionUpdate.planId = planId;
      subscriptionUpdate.planName = planNames[planId] || planId;
    }

    // Only set dates for active/renewed events
    if (status === 'active') {
      subscriptionUpdate.startDate = currentDate.toISOString();
      subscriptionUpdate.endDate = endDate.toISOString();
      subscriptionUpdate.cancelledAt = null;
    }

    if (status === 'cancelled' || status === 'expired' || status === 'refunded') {
      subscriptionUpdate.autoRenew = false;
      if (status === 'cancelled') {
        subscriptionUpdate.cancelledAt = currentDate.toISOString();
      }
    }

    if (dodoSubscriptionId) {
      subscriptionUpdate.dodoSubscriptionId = dodoSubscriptionId;
    }

    if (userDoc.exists) {
      // Merge with existing subscription data
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
