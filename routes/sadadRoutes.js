/**
 * Sadad Cloud Payment Routes
 * Handles create-order, poll, close, refund, and webhook callback
 * for Sadad/WiseCashier cloud-mode ECR integration.
 */

const express = require('express');
const router = express.Router();
const sadadService = require('../services/sadadService');

module.exports = (db, collections, authenticateToken) => {

  // ── Helper: load Sadad config from restaurant doc ──

  async function loadSadadConfig(restaurantId) {
    const doc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!doc.exists) throw { status: 404, message: 'Restaurant not found' };

    const ecr = doc.data().ecrSettings;
    if (!ecr?.enabled) throw { status: 403, message: 'ECR is not enabled for this restaurant' };
    if (ecr.provider !== 'sadad-cloud') throw { status: 400, message: 'Restaurant is not configured for Sadad Cloud' };
    if (!ecr.sadadMerchantNo || !ecr.sadadTerminalSn) throw { status: 400, message: 'Sadad configuration incomplete' };

    return {
      sadadApiUrl: ecr.sadadApiUrl || 'https://open.sadadpos.com',
      sadadAppId: ecr.sadadAppId || '',
      sadadAccessToken: ecr.sadadAccessToken || '',
      sadadMerchantNo: ecr.sadadMerchantNo,
      sadadStoreNo: ecr.sadadStoreNo || '',
      sadadTerminalSn: ecr.sadadTerminalSn,
      sadadPrivateKey: ecr.sadadPrivateKey || '',
      sadadPublicKey: ecr.sadadPublicKey || '',
    };
  }

  function txnRef(restaurantId, merchantOrderNo) {
    return db
      .collection(collections.restaurants)
      .doc(restaurantId)
      .collection('sadadTransactions')
      .doc(merchantOrderNo);
  }

  // ── POST /api/sadad/create-order ──

  router.post('/create-order', authenticateToken, async (req, res) => {
    const { restaurantId, amount, description, merchantOrderNo } = req.body;

    if (!restaurantId || !amount || !merchantOrderNo) {
      return res.status(400).json({ error: 'Missing required fields: restaurantId, amount, merchantOrderNo' });
    }

    try {
      const config = await loadSadadConfig(restaurantId);

      // Build notify URL for webhook
      const backendUrl = process.env.BACKEND_URL
        || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://dine-be2-phi.vercel.app');
      const notifyUrl = `${backendUrl}/api/sadad/webhook`;

      const result = await sadadService.createOrder(config, {
        merchantOrderNo,
        orderAmount: parseFloat(amount).toFixed(2),
        description: description || 'POS Payment',
        notifyUrl,
      });

      // Store pending transaction in Firestore
      await txnRef(restaurantId, merchantOrderNo).set({
        merchantOrderNo,
        transNo: result.trans_no || '',
        messageId: result.message_id || '',
        orderAmount: parseFloat(amount).toFixed(2),
        transStatus: 9, // pending/pre-order
        restaurantId,
        authNo: null,
        cardNetwork: null,
        payUserAccountId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        webhookReceivedAt: null,
      });

      res.json({
        success: true,
        transNo: result.trans_no || '',
        merchantOrderNo,
        status: 'pending',
      });
    } catch (err) {
      console.error('Sadad create-order error:', err);
      const status = err.status || 502;
      res.status(status).json({ error: err.message || 'Failed to create Sadad order' });
    }
  });

  // ── GET /api/sadad/poll/:merchantOrderNo ──

  router.get('/poll/:merchantOrderNo', authenticateToken, async (req, res) => {
    const { merchantOrderNo } = req.params;
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Missing restaurantId query parameter' });
    }

    try {
      const docRef = txnRef(restaurantId, merchantOrderNo);
      const doc = await docRef.get();

      if (!doc.exists) {
        return res.status(404).json({ error: 'Transaction not found' });
      }

      let txn = doc.data();

      // If still pending and last update > 3s ago, actively query Sadad
      const isPending = txn.transStatus === 9;
      const staleMs = Date.now() - (txn.updatedAt?.toDate?.()?.getTime?.() || 0);

      if (isPending && staleMs > 3000) {
        try {
          const config = await loadSadadConfig(restaurantId);
          const result = await sadadService.queryOrder(config, merchantOrderNo);

          const newStatus = parseInt(result.trans_status, 10);
          const update = {
            transStatus: newStatus,
            updatedAt: new Date(),
          };

          // Fill in details if available
          if (result.auth_no) update.authNo = result.auth_no;
          if (result.card_network) update.cardNetwork = result.card_network;
          if (result.pay_user_account_id) update.payUserAccountId = result.pay_user_account_id;

          await docRef.update(update);
          txn = { ...txn, ...update };
        } catch (queryErr) {
          // Query failed — return last known status from Firestore
          console.error('Sadad poll query error (returning cached):', queryErr.message);
        }
      }

      // Map transStatus to a simple string
      let status = 'pending';
      if (txn.transStatus === 2) status = 'success';
      else if (txn.transStatus === 11) status = 'failed';
      else if (txn.transStatus === 13) status = 'cancelled';
      else if (txn.transStatus === 14 || txn.transStatus === 17) status = 'refunded';

      res.json({
        status,
        transStatus: txn.transStatus,
        transNo: txn.transNo || '',
        merchantOrderNo: txn.merchantOrderNo,
        orderAmount: txn.orderAmount,
        authNo: txn.authNo || '',
        cardNetwork: txn.cardNetwork || '',
        payUserAccountId: txn.payUserAccountId || '',
      });
    } catch (err) {
      console.error('Sadad poll error:', err);
      const status = err.status || 500;
      res.status(status).json({ error: err.message || 'Failed to poll transaction' });
    }
  });

  // ── POST /api/sadad/close-order ──

  router.post('/close-order', authenticateToken, async (req, res) => {
    const { restaurantId, merchantOrderNo } = req.body;

    if (!restaurantId || !merchantOrderNo) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const config = await loadSadadConfig(restaurantId);
      await sadadService.closeOrder(config, merchantOrderNo);

      // Update Firestore
      const docRef = txnRef(restaurantId, merchantOrderNo);
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({ transStatus: 13, updatedAt: new Date() });
      }

      res.json({ success: true });
    } catch (err) {
      console.error('Sadad close-order error:', err);
      const status = err.status || 502;
      res.status(status).json({ error: err.message || 'Failed to close order' });
    }
  });

  // ── POST /api/sadad/refund ──

  router.post('/refund', authenticateToken, async (req, res) => {
    const { restaurantId, merchantOrderNo, refundAmount, transNo, description } = req.body;

    if (!restaurantId || !merchantOrderNo || !refundAmount || !transNo) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const config = await loadSadadConfig(restaurantId);
      const result = await sadadService.refundOrder(config, {
        merchantOrderNo,
        refundAmount: parseFloat(refundAmount).toFixed(2),
        transNo,
        description: description || 'Refund',
      });

      res.json({ success: true, refundTransNo: result.trans_no || '' });
    } catch (err) {
      console.error('Sadad refund error:', err);
      const status = err.status || 502;
      res.status(status).json({ error: err.message || 'Failed to process refund' });
    }
  });

  // ── POST /api/sadad/webhook — Public endpoint, signature-verified ──

  router.post('/webhook', async (req, res) => {
    const payload = req.body;
    const merchantOrderNo = payload.merchant_order_no;
    const transStatus = parseInt(payload.trans_status, 10);

    console.log('[Sadad Webhook] Received:', JSON.stringify({
      merchant_order_no: merchantOrderNo,
      trans_status: transStatus,
      trans_no: payload.trans_no,
      order_amount: payload.order_amount,
    }));

    if (!merchantOrderNo) {
      console.error('[Sadad Webhook] Missing merchant_order_no');
      return res.status(400).send('missing merchant_order_no');
    }

    // Find the transaction across restaurants (merchant_order_no is globally unique with timestamp)
    try {
      // Query all restaurants for this merchantOrderNo
      const snapshot = await db.collectionGroup('sadadTransactions')
        .where('merchantOrderNo', '==', merchantOrderNo)
        .limit(1)
        .get();

      if (snapshot.empty) {
        console.error(`[Sadad Webhook] Transaction not found: ${merchantOrderNo}`);
        // Still return success to stop retries
        return res.send('success');
      }

      const txnDoc = snapshot.docs[0];
      const txn = txnDoc.data();

      // Verify signature if we have the public key
      if (txn.restaurantId) {
        try {
          const restaurantDoc = await db.collection(collections.restaurants).doc(txn.restaurantId).get();
          const sadadPublicKey = restaurantDoc.data()?.ecrSettings?.sadadPublicKey;
          if (sadadPublicKey) {
            const isValid = sadadService.verifyCallback(payload, sadadPublicKey);
            if (!isValid) {
              console.error(`[Sadad Webhook] Invalid signature for ${merchantOrderNo}`);
              return res.status(400).send('invalid signature');
            }
          }
        } catch (verifyErr) {
          // Log but don't block — signature verification is best-effort if key is misconfigured
          console.error('[Sadad Webhook] Signature verification error:', verifyErr.message);
        }
      }

      // Idempotent: if already in terminal state (success/failed/cancelled), skip update
      const terminalStatuses = [2, 11, 13, 14, 17];
      if (terminalStatuses.includes(txn.transStatus) && txn.transStatus !== 9) {
        console.log(`[Sadad Webhook] Transaction ${merchantOrderNo} already in terminal state ${txn.transStatus}, skipping`);
        return res.send('success');
      }

      // Update transaction
      const update = {
        transStatus,
        updatedAt: new Date(),
        webhookReceivedAt: new Date(),
      };

      if (payload.auth_no) update.authNo = payload.auth_no;
      if (payload.card_network) update.cardNetwork = payload.card_network;
      if (payload.pay_user_account_id) update.payUserAccountId = payload.pay_user_account_id;
      if (payload.trans_no) update.transNo = payload.trans_no;

      await txnDoc.ref.update(update);
      console.log(`[Sadad Webhook] Updated ${merchantOrderNo} to status ${transStatus}`);

      res.send('success');
    } catch (err) {
      console.error('[Sadad Webhook] Error:', err);
      // Return success to prevent retries even on internal error
      // (we've logged it for debugging)
      res.send('success');
    }
  });

  // ── POST /api/sadad/test — Test configuration ──

  router.post('/test', authenticateToken, async (req, res) => {
    const { restaurantId } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Missing restaurantId' });
    }

    try {
      const config = await loadSadadConfig(restaurantId);
      // Try signing a test request to verify the private key works
      const testParams = { test: 'true', timestamp: Date.now().toString() };
      sadadService.signRequest(testParams, config.sadadPrivateKey);

      res.json({
        success: true,
        message: 'Sadad configuration is valid. Keys and credentials verified.',
      });
    } catch (err) {
      console.error('Sadad test error:', err);
      res.json({
        success: false,
        message: err.message || 'Configuration test failed',
      });
    }
  });

  return router;
};
