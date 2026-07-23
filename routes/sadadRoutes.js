/**
 * Sadad Cloud (WiseCashier / PayCloud) ECR Payment Routes
 *
 * Endpoints (mounted at /api/sadad):
 *   POST /create-order          push a payment to the terminal
 *   GET  /poll/:merchantOrderNo  check status (actively queries Sadad if stale)
 *   POST /close-order            cancel a pending payment
 *   POST /refund                 refund a completed payment
 *   POST /webhook                async result from Sadad (public, signature-verified)
 *   POST /test                   live connectivity + credential/signing check
 */

const express = require('express');
const router = express.Router();
const sadadService = require('../services/sadadService');
const { getCachedRestDoc } = require('../utils/kvCache');

module.exports = (db, collections, authenticateToken) => {

  // ── Load + normalise Sadad config from the restaurant doc ──
  async function loadSadadConfig(restaurantId) {
    const doc = await getCachedRestDoc(db, collections.restaurants, restaurantId);
    if (!doc.exists) throw { status: 404, message: 'Restaurant not found' };

    const ecr = doc.data().ecrSettings;
    if (!ecr?.enabled) throw { status: 403, message: 'ECR is not enabled for this restaurant' };
    if (ecr.provider !== 'sadad-cloud') throw { status: 400, message: 'Restaurant is not configured for Sadad Cloud' };

    const missing = [];
    if (!ecr.sadadAppId) missing.push('App ID');
    if (!ecr.sadadMerchantNo) missing.push('Merchant No');
    if (!ecr.sadadTerminalSn) missing.push('Terminal SN');
    if (!ecr.sadadPrivateKey) missing.push('App RSA Private Key');
    if (missing.length) throw { status: 400, message: `Sadad configuration incomplete: ${missing.join(', ')}` };

    return {
      apiUrl: ecr.sadadApiUrl || sadadService.SADAD_URLS.PRODUCTION,
      appId: ecr.sadadAppId,
      merchantNo: ecr.sadadMerchantNo,
      storeNo: ecr.sadadStoreNo || '',
      terminalSn: ecr.sadadTerminalSn,
      privateKey: ecr.sadadPrivateKey,      // app RSA private key (ours)
      publicKey: ecr.sadadPublicKey || '',  // gateway RSA public key (Sadad's)
      currency: ecr.sadadCurrency || 'QAR',
    };
  }

  function txnRef(restaurantId, merchantOrderNo) {
    return db
      .collection(collections.restaurants)
      .doc(restaurantId)
      .collection('sadadTransactions')
      .doc(merchantOrderNo);
  }

  function webhookUrl() {
    const base = process.env.BACKEND_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://dine-be2-phi.vercel.app');
    return `${base}/api/sadad/webhook`;
  }

  // ── POST /create-order ──
  router.post('/create-order', authenticateToken, async (req, res) => {
    const { restaurantId, amount, description, merchantOrderNo } = req.body;
    if (!restaurantId || !amount || !merchantOrderNo) {
      return res.status(400).json({ error: 'Missing required fields: restaurantId, amount, merchantOrderNo' });
    }

    try {
      const config = await loadSadadConfig(restaurantId);
      const orderAmount = parseFloat(amount).toFixed(2);

      const result = await sadadService.createOrder(config, {
        merchantOrderNo,
        orderAmount,
        description: description || 'POS Payment',
        notifyUrl: webhookUrl(),
      });

      await txnRef(restaurantId, merchantOrderNo).set({
        merchantOrderNo,
        restaurantId,
        transNo: result.transNo || '',
        messageId: result.messageId || '',
        orderAmount,
        transStatus: sadadService.TRANS_STATUS.PENDING, // 9 = pre-order
        terminalOnlineStatus: result.terminalOnlineStatus || '',
        authNo: null,
        cardNetwork: null,
        payUserAccountId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        webhookReceivedAt: null,
      });

      res.json({
        success: true,
        transNo: result.transNo || '',
        merchantOrderNo,
        terminalOnlineStatus: result.terminalOnlineStatus || '',
        status: 'pending',
      });
    } catch (err) {
      console.error('Sadad create-order error:', err.message);
      const status = err.status || 502;
      res.status(status).json({ error: err.message || 'Failed to create Sadad order' });
    }
  });

  // ── GET /poll/:merchantOrderNo ──
  router.get('/poll/:merchantOrderNo', authenticateToken, async (req, res) => {
    const { merchantOrderNo } = req.params;
    const { restaurantId } = req.query;
    if (!restaurantId) return res.status(400).json({ error: 'Missing restaurantId query parameter' });

    try {
      const docRef = txnRef(restaurantId, merchantOrderNo);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: 'Transaction not found' });

      let txn = doc.data();

      // Still pending and last update > 3s ago → actively query Sadad.
      const isPending = txn.transStatus === sadadService.TRANS_STATUS.PENDING;
      const staleMs = Date.now() - (txn.updatedAt?.toDate?.()?.getTime?.() || 0);

      if (isPending && staleMs > 3000) {
        try {
          const config = await loadSadadConfig(restaurantId);
          const q = await sadadService.queryOrder(config, merchantOrderNo);
          console.log(`[Sadad] poll query ${merchantOrderNo} → trans_status=${q.transStatus} (${q.status})`);

          const update = { transStatus: q.transStatus, updatedAt: new Date() };
          if (q.authNo) update.authNo = q.authNo;
          if (q.cardNetwork) update.cardNetwork = q.cardNetwork;
          if (q.payUserAccountId) update.payUserAccountId = q.payUserAccountId;
          if (q.transNo) update.transNo = q.transNo;

          await docRef.update(update);
          txn = { ...txn, ...update };
        } catch (queryErr) {
          console.error('[Sadad] poll query failed (returning cached):', queryErr.message);
        }
      }

      res.json({
        status: sadadService.mapTransStatus(txn.transStatus),
        transStatus: txn.transStatus,
        transNo: txn.transNo || '',
        merchantOrderNo: txn.merchantOrderNo,
        orderAmount: txn.orderAmount,
        authNo: txn.authNo || '',
        cardNetwork: txn.cardNetwork || '',
        payUserAccountId: txn.payUserAccountId || '',
      });
    } catch (err) {
      console.error('Sadad poll error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to poll transaction' });
    }
  });

  // ── POST /close-order ──
  router.post('/close-order', authenticateToken, async (req, res) => {
    const { restaurantId, merchantOrderNo } = req.body;
    if (!restaurantId || !merchantOrderNo) return res.status(400).json({ error: 'Missing required fields' });

    try {
      const config = await loadSadadConfig(restaurantId);
      await sadadService.closeOrder(config, merchantOrderNo);

      const docRef = txnRef(restaurantId, merchantOrderNo);
      const doc = await docRef.get();
      if (doc.exists) await docRef.update({ transStatus: sadadService.TRANS_STATUS.CANCELLED, updatedAt: new Date() });

      res.json({ success: true });
    } catch (err) {
      console.error('Sadad close-order error:', err.message);
      res.status(err.status || 502).json({ error: err.message || 'Failed to close order' });
    }
  });

  // ── POST /refund ──
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
      res.json({ success: true, refundTransNo: result.refundTransNo });
    } catch (err) {
      console.error('Sadad refund error:', err.message);
      res.status(err.status || 502).json({ error: err.message || 'Failed to process refund' });
    }
  });

  // ── POST /webhook — public, signature-verified async result ──
  // ⚠ Exact notify payload shape needs Sadad confirmation. We parse defensively:
  //   the business fields may be flat on the body OR nested in a `data` JSON string.
  router.post('/webhook', async (req, res) => {
    const body = req.body || {};

    // Business fields may be flat or nested inside a stringified `data`.
    let biz = body;
    if (typeof body.data === 'string' && body.data.length) {
      try { biz = { ...body, ...JSON.parse(body.data) }; } catch (e) { /* keep flat */ }
    } else if (body.data && typeof body.data === 'object') {
      biz = { ...body, ...body.data };
    }

    const merchantOrderNo = biz.merchant_order_no || body.merchant_order_no;
    const transStatus = parseInt(biz.trans_status, 10);

    console.log('[Sadad Webhook] Received:', JSON.stringify({
      merchant_order_no: merchantOrderNo,
      trans_status: biz.trans_status,
      trans_no: biz.trans_no,
      order_amount: biz.order_amount || biz.trans_amount,
    }));

    if (!merchantOrderNo) {
      console.error('[Sadad Webhook] Missing merchant_order_no');
      return res.status(400).send('missing merchant_order_no');
    }

    try {
      const snapshot = await db.collectionGroup('sadadTransactions')
        .where('merchantOrderNo', '==', merchantOrderNo)
        .limit(1)
        .get();

      if (snapshot.empty) {
        console.error(`[Sadad Webhook] Transaction not found: ${merchantOrderNo}`);
        return res.send('success'); // stop retries
      }

      const txnDoc = snapshot.docs[0];
      const txn = txnDoc.data();

      // Verify signature with the gateway public key when configured.
      if (txn.restaurantId && body.sign) {
        try {
          const rDoc = await getCachedRestDoc(db, collections.restaurants, txn.restaurantId);
          const pub = rDoc.data()?.ecrSettings?.sadadPublicKey;
          if (pub && !sadadService.verifySign(body, pub)) {
            console.error(`[Sadad Webhook] Invalid signature for ${merchantOrderNo}`);
            return res.status(400).send('invalid signature');
          }
        } catch (verifyErr) {
          console.error('[Sadad Webhook] Signature check error:', verifyErr.message);
        }
      }

      // Idempotent: once in a terminal state, don't overwrite.
      const TS = sadadService.TRANS_STATUS;
      const terminal = [TS.SUCCESS, TS.FAILED, TS.CANCELLED, TS.PARTIAL_REFUND, TS.FULL_REFUND];
      if (terminal.includes(txn.transStatus)) {
        console.log(`[Sadad Webhook] ${merchantOrderNo} already terminal (${txn.transStatus}), skipping`);
        return res.send('success');
      }

      if (Number.isNaN(transStatus)) {
        console.error('[Sadad Webhook] Missing/invalid trans_status; leaving as pending');
        return res.send('success');
      }

      const update = {
        transStatus,
        updatedAt: new Date(),
        webhookReceivedAt: new Date(),
      };
      if (biz.auth_no || biz.approval_code) update.authNo = biz.auth_no || biz.approval_code;
      if (biz.card_network || biz.card_org) update.cardNetwork = biz.card_network || biz.card_org;
      if (biz.pay_user_account_id || biz.card_no) update.payUserAccountId = biz.pay_user_account_id || biz.card_no;
      if (biz.trans_no) update.transNo = biz.trans_no;

      await txnDoc.ref.update(update);
      console.log(`[Sadad Webhook] Updated ${merchantOrderNo} → ${transStatus} (${sadadService.mapTransStatus(transStatus)})`);
      res.send('success');
    } catch (err) {
      console.error('[Sadad Webhook] Error:', err.message);
      res.send('success'); // avoid infinite retries; logged for debugging
    }
  });

  // ── POST /test — live connectivity + credential/signing check ──
  // Runs a real Query Order round-trip against a throwaway order number.
  // Reaching Sadad and getting a structured response back (even a business
  // "order not found") proves URL + app_id + signing + keys all work.
  router.post('/test', authenticateToken, async (req, res) => {
    const { restaurantId } = req.body;
    if (!restaurantId) return res.status(400).json({ error: 'Missing restaurantId' });

    let config;
    try {
      config = await loadSadadConfig(restaurantId);
    } catch (err) {
      return res.json({ success: false, message: err.message || 'Configuration incomplete' });
    }

    const probeOrderNo = `CONNTEST_${Date.now()}`;
    try {
      await sadadService.queryOrder(config, probeOrderNo);
      // Unlikely to succeed for a random order, but if it did, everything works.
      res.json({ success: true, message: 'Connected to Sadad. Credentials and signing verified.' });
    } catch (err) {
      // A "business" error means we reached Sadad and it accepted our signed
      // request (auth + signing OK) but the throwaway order doesn't exist.
      if (err.kind === 'business') {
        res.json({
          success: true,
          message: `Connected to Sadad. Credentials and signing verified (probe returned: ${err.message}).`,
        });
      } else if (err.kind === 'signature') {
        res.json({ success: false, message: `Signing failed — check the App RSA Private Key. ${err.message}` });
      } else if (err.kind === 'timeout' || err.kind === 'network') {
        res.json({ success: false, message: `Cannot reach Sadad (${config.apiUrl}). ${err.message}` });
      } else {
        res.json({ success: false, message: err.message || 'Configuration test failed' });
      }
    }
  });

  return router;
};
