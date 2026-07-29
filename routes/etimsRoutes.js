/**
 * Kenya KRA eTIMS routes — self-contained module.
 *
 * Mounted from index.js with a single line:
 *     app.use(require('./routes/etimsRoutes')(db, collections, authenticateToken));
 *
 * Every route is gated on isKenya() — a non-Kenya store gets 409/no-op and is
 * never affected. The heavy lifting (payload building) lives in
 * services/etims/etimsService.js. The actual VSCU HTTP call is performed by the
 * Electron desktop app (the VSCU is on the restaurant LAN); these routes only
 * (a) hold config, (b) hand the Electron app the exact payload + target URL, and
 * (c) store the signed result back onto the order.
 */

'use strict';

const express = require('express');
const etims = require('../services/etims/etimsService');

module.exports = function initEtimsRoutes(db, collections, authenticateToken, validateRestaurantAccess) {
  const router = express.Router();
  const restaurantsCol = (collections && collections.restaurants) || 'restaurants';

  const getRestaurant = async (restaurantId) => {
    const snap = await db.collection(restaurantsCol).doc(restaurantId).get();
    return snap.exists ? { ref: snap.ref, data: snap.data() } : null;
  };

  // Guard: (1) the caller must have access to THIS restaurant (prevents cross-
  // tenant access), (2) it must be a Kenya store. Returns null + sends the
  // response on failure.
  const requireKenya = async (req, res) => {
    const { restaurantId } = req.params;
    if (typeof validateRestaurantAccess === 'function') {
      const hasAccess = await validateRestaurantAccess(req.user && req.user.userId, restaurantId);
      if (!hasAccess) { res.status(403).json({ error: 'Access denied for this restaurant.' }); return null; }
    }
    const r = await getRestaurant(restaurantId);
    if (!r) { res.status(404).json({ error: 'Restaurant not found' }); return null; }
    if (!etims.isKenya(r.data)) {
      res.status(409).json({ error: 'eTIMS is only available for Kenya (KES) stores.' });
      return null;
    }
    return r;
  };

  const maskConfig = (cfg = {}) => ({
    enabled: !!cfg.enabled,
    tin: cfg.tin || '',
    bhfId: cfg.bhfId || '00',
    dvcSrlNo: cfg.dvcSrlNo || '',
    vscuUrl: cfg.vscuUrl || '',
    defaultItemClassCode: cfg.defaultItemClassCode || '',
    receiptTopMsg: cfg.receiptTopMsg || '',
    receiptBottomMsg: cfg.receiptBottomMsg || '',
    initialised: !!(cfg.device && cfg.device.sdcId),
    device: cfg.device ? { sdcId: cfg.device.sdcId, mrcNo: cfg.device.mrcNo, lastInvcNo: cfg.device.lastInvcNo || 0 } : null,
    // keys are never returned to the client
  });

  // --- Config ---------------------------------------------------------------
  router.get('/api/etims/:restaurantId/config', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      res.json({ success: true, config: maskConfig(r.data.etimsConfig) });
    } catch (e) { console.error('etims config get:', e); res.status(500).json({ error: 'Failed to load eTIMS config' }); }
  });

  router.put('/api/etims/:restaurantId/config', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const b = req.body || {};
      const existing = r.data.etimsConfig || {};
      const next = {
        ...existing,
        enabled: b.enabled != null ? !!b.enabled : (existing.enabled || false),
        tin: (b.tin != null ? String(b.tin) : existing.tin || '').trim(),
        bhfId: (b.bhfId != null ? String(b.bhfId) : existing.bhfId || '00').trim(),
        dvcSrlNo: (b.dvcSrlNo != null ? String(b.dvcSrlNo) : existing.dvcSrlNo || '').trim(),
        vscuUrl: (b.vscuUrl != null ? String(b.vscuUrl) : existing.vscuUrl || '').trim().replace(/\/+$/, ''),
        defaultItemClassCode: b.defaultItemClassCode != null ? String(b.defaultItemClassCode) : (existing.defaultItemClassCode || ''),
        receiptTopMsg: b.receiptTopMsg != null ? String(b.receiptTopMsg) : (existing.receiptTopMsg || ''),
        receiptBottomMsg: b.receiptBottomMsg != null ? String(b.receiptBottomMsg) : (existing.receiptBottomMsg || ''),
        updatedAt: new Date(),
      };
      await r.ref.update({ etimsConfig: next });
      res.json({ success: true, config: maskConfig(next) });
    } catch (e) { console.error('etims config put:', e); res.status(500).json({ error: 'Failed to save eTIMS config' }); }
  });

  // --- Device initialisation -------------------------------------------------
  // Hand the Electron app the exact init request + target URL.
  router.get('/api/etims/:restaurantId/init-payload', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const cfg = r.data.etimsConfig || {};
      if (!cfg.vscuUrl || !cfg.tin || !cfg.dvcSrlNo) {
        return res.status(400).json({ error: 'Set TIN, device serial and VSCU URL before initialising.' });
      }
      res.json({ success: true, vscuUrl: cfg.vscuUrl, path: '/initializer/selectInitInfo', body: etims.buildInitPayload(cfg) });
    } catch (e) { console.error('etims init-payload:', e); res.status(500).json({ error: 'Failed to prepare init' }); }
  });

  // Store what the VSCU returned from selectInitInfo (device id, keys, counters).
  router.post('/api/etims/:restaurantId/init-result', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const body = req.body || {};
      // KRA's selectInitInfo nests the device fields under data.info on a first-time
      // success; some VSCU builds return them flat under data. Unwrap either shape.
      const outer = body.data || body.result || body;
      const data = (outer && typeof outer === 'object' && outer.info && typeof outer.info === 'object') ? outer.info : (outer || {});
      if (!data.sdcId) {
        // Surface the VSCU's own result code/message so the operator knows WHY.
        // The most common case: the device was already initialised on this PC — KRA
        // only returns the sdcId + keys on the FIRST init (resultCd 902 afterwards).
        const rc = body.resultCd || (outer && outer.resultCd) || null;
        const rm = body.resultMsg || (outer && outer.resultMsg) || null;
        console.error('[etims] init-result missing sdcId. resultCd=%s resultMsg=%s bodyKeys=%j', rc, rm, Object.keys(body));
        let hint = 'VSCU response missing sdcId — initialisation failed.';
        if (rc && String(rc) !== '000') {
          hint = `VSCU rejected initialisation (code ${rc})${rm ? ': ' + rm : ''}.`;
        }
        if ((rc && String(rc) === '902') || /already/i.test(String(rm || ''))) {
          hint = `This device is already initialised on this PC (VSCU code ${rc || '902'}${rm ? ': ' + rm : ''}). KRA only returns the SDC ID + keys on the FIRST initialisation. Either re-register/reset the device on the eTIMS portal, or contact support to enter the existing SDC ID/MRC No manually.`;
        }
        return res.status(400).json({ error: hint, resultCd: rc, resultMsg: rm });
      }
      const existing = r.data.etimsConfig || {};
      const device = {
        dvcId: data.dvcId || null,
        sdcId: data.sdcId,
        mrcNo: data.mrcNo || null,
        // keys stay server-side only, never sent back to the client
        intrlKey: data.intrlKey || null,
        signKey: data.signKey || null,
        cmcKey: data.cmcKey || null,
        lastInvcNo: Number(data.lastSaleInvcNo || data.lastInvcNo || 0) || 0,
        initialisedAt: new Date(),
      };
      await r.ref.update({ etimsConfig: { ...existing, enabled: true, device } });
      res.json({ success: true, device: { sdcId: device.sdcId, mrcNo: device.mrcNo, lastInvcNo: device.lastInvcNo } });
    } catch (e) { console.error('etims init-result:', e); res.status(500).json({ error: 'Failed to store init result' }); }
  });

  // Manual device registration — for a VSCU that was ALREADY initialised on the PC
  // (KRA only returns the SDC ID + keys on the first init, so re-init returns none).
  // The VSCU signs sales locally with its own keys, so the backend only needs the
  // SDC ID + MRC No + the last invoice number to activate + print correct receipts.
  router.post('/api/etims/:restaurantId/set-device-manual', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const b = req.body || {};
      const sdcId = (b.sdcId != null ? String(b.sdcId) : '').trim();
      const mrcNo = (b.mrcNo != null ? String(b.mrcNo) : '').trim();
      if (!sdcId) return res.status(400).json({ error: 'SDC ID is required.' });
      const existing = r.data.etimsConfig || {};
      const prevDevice = existing.device || {};
      const device = {
        ...prevDevice,
        dvcId: (b.dvcId != null ? String(b.dvcId) : prevDevice.dvcId) || null,
        sdcId,
        mrcNo: mrcNo || prevDevice.mrcNo || null,
        lastInvcNo: b.lastInvcNo != null ? (Number(b.lastInvcNo) || 0) : (Number(prevDevice.lastInvcNo) || 0),
        manual: true,
        initialisedAt: prevDevice.initialisedAt || new Date(),
        updatedAt: new Date(),
      };
      await r.ref.update({ etimsConfig: { ...existing, enabled: true, device } });
      res.json({ success: true, device: { sdcId: device.sdcId, mrcNo: device.mrcNo, lastInvcNo: device.lastInvcNo } });
    } catch (e) { console.error('etims set-device-manual:', e); res.status(500).json({ error: 'Failed to save device details' }); }
  });

  // --- Item registration (saveItems) ----------------------------------------
  // Return one payload per active menu item for the Electron app to relay.
  router.post('/api/etims/:restaurantId/prepare-items', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      if (!etims.isEtimsActive(r.data)) return res.status(400).json({ error: 'eTIMS device not initialised.' });
      const cfg = r.data.etimsConfig || {};
      const menuItems = (r.data.menu && Array.isArray(r.data.menu.items)) ? r.data.menu.items : [];
      const payloads = etims.buildSaveItemsPayloads(menuItems, r.data);
      res.json({ success: true, vscuUrl: cfg.vscuUrl, path: '/items/saveItems', count: payloads.length, items: payloads });
    } catch (e) { console.error('etims prepare-items:', e); res.status(500).json({ error: 'Failed to prepare items' }); }
  });

  // Record the result of an item-registration sync (counts only; advisory).
  router.post('/api/etims/:restaurantId/items-result', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const b = req.body || {};
      // Full-object merge (no dot-path — Firestore + pgAdapter safe).
      const existing = r.data.etimsConfig || {};
      await r.ref.update({ etimsConfig: { ...existing, lastItemSync: { at: new Date(), ok: Number(b.ok) || 0, failed: Number(b.failed) || 0 } } });
      res.json({ success: true });
    } catch (e) { console.error('etims items-result:', e); res.status(500).json({ error: 'Failed to record item sync' }); }
  });

  // --- Sale (fiscalisation) --------------------------------------------------
  // Build the saveSales payload for a completed order + give Electron the URL.
  router.post('/api/etims/:restaurantId/prepare-sale', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      if (!etims.isEtimsActive(r.data)) return res.status(400).json({ error: 'eTIMS device not initialised.' });
      const { restaurantId } = req.params;
      const orderId = req.body && req.body.orderId;
      if (!orderId) return res.status(400).json({ error: 'orderId required' });

      // Reserve the invoice number ATOMICALLY (transaction) so two concurrent
      // sales can never share an invcNo. Also verifies the order belongs to this
      // restaurant. Uses full-object writes (Firestore + pgAdapter safe — no
      // dot-path updates). A re-prepare reuses the same reserved number.
      let reserved;
      try {
        reserved = await db.runTransaction(async (tx) => {
          const rSnap = await tx.get(r.ref);
          const rData = rSnap.data() || {};
          const cfg = rData.etimsConfig || {};
          const device = cfg.device || {};
          const oRef = db.collection('orders').doc(orderId);
          const oSnap = await tx.get(oRef);
          if (!oSnap.exists) { const e = new Error('Order not found'); e.code = 404; throw e; }
          const order = { id: oSnap.id, ...oSnap.data() };
          if (order.restaurantId !== restaurantId) { const e = new Error('Order does not belong to this restaurant.'); e.code = 403; throw e; }
          if (order.status !== 'completed' && order.status !== 'paid') { const e = new Error('Order is not a completed sale yet.'); e.code = 409; e.status = order.status; throw e; }
          if (!Array.isArray(order.items) || order.items.length === 0) { const e = new Error('Order has no items to fiscalise.'); e.code = 422; throw e; }
          if (order.etims && order.etims.rcptSign) return { alreadyFiscalised: true, etims: order.etims };
          let invcNo = order.etims && order.etims.pendingInvcNo;
          if (!invcNo) {
            invcNo = (Number(device.lastInvcNo) || 0) + 1;
            tx.update(r.ref, { etimsConfig: { ...cfg, device: { ...device, lastInvcNo: invcNo } } });
            tx.set(oRef, { etims: { pendingInvcNo: invcNo, preparedAt: new Date() } }, { merge: true });
          }
          return { invcNo, order, rData };
        });
      } catch (e) {
        if (e && e.code) return res.status(e.code).json({ error: e.message, status: e.status });
        throw e;
      }

      if (reserved.alreadyFiscalised) return res.json({ success: true, alreadyFiscalised: true, etims: reserved.etims });
      const cfg = reserved.rData.etimsConfig || {};
      const { payload } = etims.buildSaveSalesPayload(reserved.order, reserved.rData, reserved.invcNo);
      res.json({ success: true, vscuUrl: cfg.vscuUrl, path: '/trnsSales/saveSales', body: payload });
    } catch (e) { console.error('etims prepare-sale:', e); res.status(500).json({ error: 'Failed to prepare sale' }); }
  });

  // Store the signed VSCU result back onto the order + advance the invoice counter.
  router.post('/api/etims/:restaurantId/confirm-sale', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const { restaurantId } = req.params;
      const { orderId, vscuResponse } = req.body || {};
      if (!orderId || !vscuResponse) return res.status(400).json({ error: 'orderId and vscuResponse required' });
      const oRef = db.collection('orders').doc(orderId);
      const oSnap = await oRef.get();
      if (!oSnap.exists) return res.status(404).json({ error: 'Order not found' });
      const order = { id: oSnap.id, ...oSnap.data() };
      if (order.restaurantId !== restaurantId) return res.status(403).json({ error: 'Order does not belong to this restaurant.' });
      // Idempotent: if already signed, return the stored record.
      if (order.etims && order.etims.rcptSign) return res.json({ success: true, etims: order.etims });

      const parsed = etims.parseSaleResult(vscuResponse);
      if (!parsed.rcptSign) {
        return res.status(422).json({ error: 'VSCU did not return a receipt signature', detail: parsed.resultMsg || parsed.resultCd, parsed });
      }
      // Use the invoice number RESERVED at prepare-sale (never the client's).
      const etimsRecord = {
        invcNo: (order.etims && order.etims.pendingInvcNo) || null,
        rcptNo: parsed.rcptNo,
        totRcptNo: parsed.totRcptNo,
        intrlData: parsed.intrlData,
        rcptSign: parsed.rcptSign,
        sdcId: parsed.sdcId,
        mrcNo: parsed.mrcNo,
        vsdcRcptPbctDate: parsed.vsdcRcptPbctDate,
        fiscalisedAt: new Date(),
      };
      // Full-object merge (no dot-path — Firestore + pgAdapter safe). The device
      // counter was already advanced atomically at prepare-sale.
      await oRef.set({ etims: etimsRecord }, { merge: true });
      res.json({ success: true, etims: etimsRecord });
    } catch (e) { console.error('etims confirm-sale:', e); res.status(500).json({ error: 'Failed to confirm sale' }); }
  });

  return router;
};
