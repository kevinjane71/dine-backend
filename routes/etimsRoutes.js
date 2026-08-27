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

  // --- Diagnostics ----------------------------------------------------------
  // Persist every VSCU touch-point (device init + sale fiscalisation) — success
  // AND failure — to a queryable Firestore collection so a Kenya store's real KRA
  // rejection reason can be diagnosed REMOTELY by restaurantId, without a site
  // visit or asking a non-technical customer to read a log. Mirrors the print
  // diagnostics pattern. Best-effort: a logging error can NEVER break fiscalisation.
  const DIAG_COL = (collections && collections.etimsDiagnostics) || 'etimsDiagnostics';
  const truncStr = (v, n = 2000) => {
    try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…[truncated]' : s; }
    catch { return null; }
  };
  // Masked config context so a diagnostic row is self-explanatory (spot mis-config
  // without a second lookup). Never logs the device signing keys.
  const cfgCtx = (r) => {
    const c = (r && r.data && r.data.etimsConfig) || {};
    const d = c.device || {};
    return { tin: c.tin, bhfId: c.bhfId, dvcSrlNo: c.dvcSrlNo, vscuUrl: c.vscuUrl, sdcId: d.sdcId, manual: d.manual };
  };
  const logDiag = async (restaurantId, rec = {}) => {
    try {
      const cfg = rec._cfg || {};
      await db.collection(DIAG_COL).add({
        restaurantId: String(restaurantId).slice(0, 128),
        restaurantName: rec.restaurantName ? String(rec.restaurantName).slice(0, 160) : null,
        phase: rec.phase || null,                       // init | prepare-sale | confirm-sale | relay | test | items
        ok: typeof rec.ok === 'boolean' ? rec.ok : null,
        orderId: rec.orderId ? String(rec.orderId).slice(0, 128) : null,
        invcNo: (rec.invcNo != null && !isNaN(Number(rec.invcNo))) ? Number(rec.invcNo) : null,
        resultCd: rec.resultCd != null ? String(rec.resultCd).slice(0, 32) : null,
        resultMsg: rec.resultMsg ? String(rec.resultMsg).slice(0, 500) : null,
        errorMessage: rec.errorMessage ? String(rec.errorMessage).slice(0, 500) : null,
        tin: cfg.tin ? String(cfg.tin).slice(0, 20) : null,
        bhfId: cfg.bhfId ? String(cfg.bhfId).slice(0, 8) : null,
        dvcSrlNo: cfg.dvcSrlNo ? String(cfg.dvcSrlNo).slice(0, 60) : null,
        vscuUrl: cfg.vscuUrl ? String(cfg.vscuUrl).slice(0, 200) : null,
        sdcId: cfg.sdcId ? String(cfg.sdcId).slice(0, 40) : null,
        manualDevice: cfg.manual === true ? true : (cfg.manual === false ? false : null),
        source: rec.source || 'backend',                // backend | client
        raw: rec.raw !== undefined ? truncStr(rec.raw) : null,
        createdAt: new Date(),
      });
    } catch (err) {
      console.error('[etims] diag log failed:', err.message);
    }
  };

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

  // Connectivity probe — hand the desktop app a PURE-READ request (selectCodeList)
  // so it can test "is the local VSCU reachable?" WITHOUT initialising the device
  // or touching any sale. Only needs the VSCU URL configured.
  router.get('/api/etims/:restaurantId/test-payload', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const cfg = r.data.etimsConfig || {};
      if (!cfg.vscuUrl) return res.status(400).json({ error: 'Set the VSCU URL before testing the connection.' });
      res.json({
        success: true,
        vscuUrl: cfg.vscuUrl,
        path: '/code/selectCodeList',
        body: { tin: String(cfg.tin || ''), bhfId: String(cfg.bhfId || '00'), lastReqDt: '20200101000000' },
      });
    } catch (e) { console.error('etims test-payload:', e); res.status(500).json({ error: 'Failed to prepare connection test' }); }
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
        logDiag(req.params.restaurantId, { phase: 'init', ok: false, restaurantName: r.data.name, resultCd: rc, resultMsg: rm, errorMessage: hint, raw: body, _cfg: cfgCtx(r) });
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
      logDiag(req.params.restaurantId, { phase: 'init', ok: true, restaurantName: r.data.name, resultCd: '000', _cfg: { ...cfgCtx(r), sdcId: device.sdcId } });
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
      // Log the attempt START (invoice reserved). This is what was missing: a fiscalisation that dies
      // at the VSCU/confirm step used to leave order.etims={pendingInvcNo} with NO diagnostic. Now every
      // attempt is traceable — pair a 'prepare-sale' with (or WITHOUT) a later 'confirm-sale' to see
      // exactly where it stopped. Best-effort; never blocks the sale.
      logDiag(restaurantId, { phase: 'prepare-sale', ok: true, restaurantName: r.data.name, orderId, invcNo: reserved.invcNo, _cfg: cfgCtx(r) });
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
        // The VSCU received the sale but refused to SIGN it — it returned an error
        // code instead of a receipt signature. Log the real reason (lands in Vercel
        // logs) AND put it in the error string, which the frontend shows verbatim,
        // so the cashier sees WHY on screen. Mirrors the init-result logging.
        const rc = parsed.resultCd || 'none';
        const rm = parsed.resultMsg || null;
        console.error('[etims] confirm-sale: VSCU returned no rcptSign. resultCd=%s resultMsg=%s raw=%j', rc, rm, vscuResponse);
        const reason = rm ? `${rm} (code ${rc})` : `no receipt signature returned (code ${rc})`;
        logDiag(restaurantId, { phase: 'confirm-sale', ok: false, restaurantName: r.data.name, orderId, invcNo: order.etims && order.etims.pendingInvcNo, resultCd: rc, resultMsg: rm, errorMessage: `VSCU rejected the sale: ${reason}`, raw: vscuResponse, _cfg: cfgCtx(r) });
        return res.status(422).json({ error: `VSCU rejected the sale: ${reason}`, detail: rm || rc, resultCd: rc, resultMsg: rm, parsed });
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
      try { require('../utils/kvCache').invalidateOrdersCache(restaurantId); } catch (_) {}
      logDiag(restaurantId, { phase: 'confirm-sale', ok: true, restaurantName: r.data.name, orderId, invcNo: etimsRecord.invcNo, resultCd: '000', _cfg: cfgCtx(r) });
      res.json({ success: true, etims: etimsRecord });
    } catch (e) { console.error('etims confirm-sale:', e); res.status(500).json({ error: 'Failed to confirm sale' }); }
  });

  // --- Diagnostics: client-reported events + recent-history read -------------
  // The Electron relay call (renderer → VSCU) can fail BEFORE it ever reaches the
  // backend (VSCU unreachable / offline / bad URL). The frontend reports those here
  // so the failure is still captured server-side. Also accepts a client "test" ping.
  router.post('/api/etims/:restaurantId/diagnostic', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      const b = req.body || {};
      await logDiag(req.params.restaurantId, {
        phase: b.phase || 'relay',
        ok: b.ok === true,
        restaurantName: r.data.name,
        orderId: b.orderId,
        invcNo: b.invcNo,
        resultCd: b.resultCd,
        resultMsg: b.resultMsg,
        errorMessage: b.errorMessage || b.error,
        raw: b.raw,
        source: 'client',
        _cfg: cfgCtx(r),
      });
      res.json({ success: true });
    } catch (e) { res.status(200).json({ success: false }); } // telemetry must never hard-fail
  });

  // Recent eTIMS diagnostics for THIS restaurant (newest first) — powers the admin
  // "Recent eTIMS activity" panel and lets support see the real reason on the FE.
  router.get('/api/etims/:restaurantId/diagnostics', authenticateToken, async (req, res) => {
    try {
      const r = await requireKenya(req, res); if (!r) return;
      // where-only (no composite index needed); sort newest-first in memory.
      const snap = await db.collection(DIAG_COL).where('restaurantId', '==', req.params.restaurantId).limit(300).get();
      const toMs = (v) => { try { if (!v) return 0; if (v._seconds) return v._seconds * 1000; if (v.toDate) return v.toDate().getTime(); return new Date(v).getTime() || 0; } catch { return 0; } };
      const items = snap.docs
        .map(d => { const x = d.data(); return { id: d.id, phase: x.phase, ok: x.ok, orderId: x.orderId, invcNo: x.invcNo, resultCd: x.resultCd, resultMsg: x.resultMsg, errorMessage: x.errorMessage, source: x.source, createdAt: x.createdAt, _ms: toMs(x.createdAt) }; })
        .sort((a, b) => b._ms - a._ms)
        .slice(0, 25)
        .map(({ _ms, ...rest }) => rest);
      res.json({ success: true, items });
    } catch (e) { console.error('etims diagnostics get:', e.message); res.status(500).json({ error: 'Failed to load diagnostics' }); }
  });

  return router;
};
