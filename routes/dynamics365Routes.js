/**
 * dynamics365Routes.js — Microsoft Dynamics 365 Business Central integration routes.
 *
 * Handles connection setup, GL account mapping, daily/order posting,
 * item/customer sync, and sync log retrieval.
 *
 * Base path: /api/d365
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const d365Service = require('../services/dynamics365Service');

// ── Encryption helpers (AES-256-GCM, same pattern as razorpayOAuth.js) ──

function getEncryptionKey() {
  const key = process.env.D365_ENCRYPTION_KEY || process.env.RAZORPAY_TOKEN_ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('D365_ENCRYPTION_KEY (or RAZORPAY_TOKEN_ENCRYPTION_KEY) must be a 64-char hex string');
  }
  return Buffer.from(key, 'hex');
}

function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(encryptedStr) {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ── Helper: load & decrypt D365 config from restaurant doc ──

async function getD365Config(restaurantId) {
  const doc = await db.collection('restaurants').doc(restaurantId).get();
  if (!doc.exists) throw Object.assign(new Error('Restaurant not found'), { status: 404 });

  const restaurant = doc.data();
  const cfg = restaurant.d365Config;
  if (!cfg || !cfg.enabled) {
    throw Object.assign(new Error('Dynamics 365 is not connected for this restaurant'), { status: 400 });
  }

  let clientSecret;
  try {
    clientSecret = decryptSecret(cfg.clientSecretEncrypted);
  } catch (e) {
    throw Object.assign(new Error('Failed to decrypt D365 credentials'), { status: 500 });
  }

  return {
    tenantId: cfg.tenantId,
    clientId: cfg.clientId,
    clientSecret,
    environment: cfg.environment,
    companyId: cfg.companyId,
    companyName: cfg.companyName,
    journalBatchName: cfg.journalBatchName || 'DINEOPEN',
    glMapping: cfg.glMapping || {},
    autoSync: cfg.autoSync || false,
    syncMode: cfg.syncMode || 'daily',
  };
}

// ── Helper: log sync result (fire-and-forget) ──

function logSync(logData) {
  db.collection('d365SyncLog').add({
    ...logData,
    syncedAt: new Date(),
  }).catch(err => console.error('[D365] Failed to log sync:', err.message));
}

// Default GL mapping for new connections
const DEFAULT_GL_MAPPING = {
  salesRevenue: '40100',
  deliveryRevenue: '40200',
  taxPayable: '23100',
  cashAccount: '11100',
  cardAccount: '11200',
  onlinePaymentAccount: '11300',
  aggregatorAccount: '11400',
  discountExpense: '60500',
  tipsLiability: '24000',
  cogsAccount: '50100',
  dueReceivable: '12000',
};

// ============================================================
// POST /connect/:restaurantId — Test connection & save config
// ============================================================
router.post('/connect/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { tenantId, clientId, clientSecret, environment, companyId, journalBatchName } = req.body;

    if (!tenantId || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'tenantId, clientId, and clientSecret are required' });
    }

    const env = environment || 'production';

    // Test connection first
    const testResult = await d365Service.testConnection({ tenantId, clientId, clientSecret, environment: env });
    if (!testResult.connected) {
      return res.status(400).json({ error: testResult.error || 'Connection failed', connected: false });
    }

    // If no companyId provided, return companies for selection
    if (!companyId) {
      return res.json({
        success: true,
        connected: false,
        step: 'select_company',
        companies: testResult.companies,
        message: 'Connection successful. Please select a company.',
      });
    }

    // Find selected company name
    const selectedCompany = testResult.companies.find(c => c.id === companyId);
    const companyName = selectedCompany?.displayName || selectedCompany?.name || '';

    // Encrypt client secret
    const clientSecretEncrypted = encryptSecret(clientSecret);

    // Save config to restaurant document
    const d365Config = {
      enabled: true,
      tenantId,
      clientId,
      clientSecretEncrypted,
      environment: env,
      companyId,
      companyName,
      journalBatchName: journalBatchName || 'DINEOPEN',
      autoSync: false,
      syncMode: 'daily',
      glMapping: DEFAULT_GL_MAPPING,
      lastSyncAt: null,
      lastSyncStatus: null,
      connectedAt: new Date().toISOString(),
      connectedBy: req.user.userId || req.user.uid,
    };

    await db.collection('restaurants').doc(restaurantId).update({ d365Config });

    res.json({
      success: true,
      connected: true,
      companyName,
      message: `Connected to ${companyName} on Dynamics 365 Business Central`,
    });
  } catch (err) {
    console.error('[D365] Connect error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to connect' });
  }
});

// ============================================================
// DELETE /disconnect/:restaurantId
// ============================================================
router.delete('/disconnect/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const doc = await db.collection('restaurants').doc(restaurantId).get();
    if (doc.exists && doc.data().d365Config?.tenantId) {
      d365Service.clearTokenCache(doc.data().d365Config.tenantId);
    }

    // Use dot notation to delete the nested field
    await db.collection('restaurants').doc(restaurantId).update({
      d365Config: {
        enabled: false,
        disconnectedAt: new Date().toISOString(),
        disconnectedBy: req.user.userId || req.user.uid,
      },
    });

    res.json({ success: true, message: 'Dynamics 365 disconnected' });
  } catch (err) {
    console.error('[D365] Disconnect error:', err);
    res.status(500).json({ error: err.message || 'Failed to disconnect' });
  }
});

// ============================================================
// GET /status/:restaurantId
// ============================================================
router.get('/status/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const doc = await db.collection('restaurants').doc(restaurantId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Restaurant not found' });

    const cfg = doc.data().d365Config;
    if (!cfg || !cfg.enabled) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      tenantId: cfg.tenantId,
      clientId: cfg.clientId,
      environment: cfg.environment,
      companyId: cfg.companyId,
      companyName: cfg.companyName,
      journalBatchName: cfg.journalBatchName || 'DINEOPEN',
      autoSync: cfg.autoSync || false,
      syncMode: cfg.syncMode || 'daily',
      glMapping: cfg.glMapping || DEFAULT_GL_MAPPING,
      lastSyncAt: cfg.lastSyncAt,
      lastSyncStatus: cfg.lastSyncStatus,
      connectedAt: cfg.connectedAt,
    });
  } catch (err) {
    console.error('[D365] Status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PATCH /settings/:restaurantId — Update GL mapping, sync prefs
// ============================================================
router.patch('/settings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { glMapping, autoSync, syncMode, journalBatchName } = req.body;

    const updates = {};
    if (glMapping !== undefined) updates['d365Config.glMapping'] = glMapping;
    if (autoSync !== undefined) updates['d365Config.autoSync'] = autoSync;
    if (syncMode !== undefined) updates['d365Config.syncMode'] = syncMode;
    if (journalBatchName !== undefined) updates['d365Config.journalBatchName'] = journalBatchName;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No settings to update' });
    }

    await db.collection('restaurants').doc(restaurantId).update(updates);
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    console.error('[D365] Settings update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /accounts/:restaurantId — Fetch BC chart of accounts
// ============================================================
router.get('/accounts/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const config = await getD365Config(req.params.restaurantId);
    const accounts = await d365Service.getAccounts(config);
    res.json({ success: true, accounts });
  } catch (err) {
    console.error('[D365] Get accounts error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============================================================
// GET /companies/:restaurantId — Fetch BC companies list
// ============================================================
router.get('/companies/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const config = await getD365Config(req.params.restaurantId);
    const companies = await d365Service.getCompanies(config);
    res.json({ success: true, companies });
  } catch (err) {
    console.error('[D365] Get companies error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============================================================
// POST /sync-daily/:restaurantId — Post daily summary to BC
// ============================================================
router.post('/sync-daily/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const config = await getD365Config(restaurantId);

    // Default to yesterday if no date provided
    const dateStr = req.query.date || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString().split('T')[0];
    })();

    // Read dailyStats document
    const docId = `${restaurantId}_${dateStr}`;
    const statsDoc = await db.collection('dailyStats').doc(docId).get();
    if (!statsDoc.exists) {
      return res.status(404).json({ error: `No daily stats found for ${dateStr}` });
    }

    const dailyStats = { ...statsDoc.data(), date: dateStr };

    // Convert to journal lines
    const lines = d365Service.convertDailyStatsToJournalLines(dailyStats, config.glMapping, 'DINE');
    if (lines.length === 0) {
      return res.json({ success: true, message: 'No transactions to post', journalLinesPosted: 0 });
    }

    // Post to BC
    const result = await d365Service.postGeneralJournalBatch(config, config.journalBatchName, lines);

    // Update last sync status
    await db.collection('restaurants').doc(restaurantId).update({
      'd365Config.lastSyncAt': new Date().toISOString(),
      'd365Config.lastSyncStatus': result.success ? 'success' : 'error',
    });

    // Log sync
    logSync({
      restaurantId,
      type: 'daily_summary',
      date: dateStr,
      status: result.success ? 'success' : (result.errors.length > 0 ? 'partial' : 'error'),
      journalLinesPosted: result.postedLines,
      totalAmount: dailyStats.totalRevenue || 0,
      bcDocumentNumber: `DINE-${dateStr.replace(/-/g, '')}`,
      error: result.errors.length > 0 ? result.errors.join('; ') : null,
      details: { lines: lines.length, stats: { orders: dailyStats.totalOrders, revenue: dailyStats.totalRevenue } },
      syncedBy: req.user.userId || req.user.uid,
    });

    res.json({
      success: result.success,
      journalLinesPosted: result.postedLines,
      totalLines: result.totalLines,
      date: dateStr,
      errors: result.errors,
      message: result.success
        ? `Posted ${result.postedLines} journal lines for ${dateStr}`
        : `Partially posted with ${result.errors.length} errors`,
    });
  } catch (err) {
    console.error('[D365] Sync daily error:', err);
    logSync({
      restaurantId: req.params.restaurantId,
      type: 'daily_summary',
      date: req.query.date || 'unknown',
      status: 'error',
      journalLinesPosted: 0,
      error: err.message,
      syncedBy: req.user?.userId || req.user?.uid,
    });
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============================================================
// POST /post-order/:restaurantId/:orderId — Post single order
// ============================================================
router.post('/post-order/:restaurantId/:orderId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;
    const config = await getD365Config(restaurantId);

    // Read order document
    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = { id: orderId, ...orderDoc.data() };

    // Convert to journal lines
    const lines = d365Service.convertOrderToJournalLines(order, config.glMapping, 'DINE-ORD');
    if (lines.length === 0) {
      return res.json({ success: true, message: 'No lines to post for this order', journalLinesPosted: 0 });
    }

    // Post to BC
    const result = await d365Service.postGeneralJournalBatch(config, config.journalBatchName, lines);

    // Mark order as synced
    if (result.success) {
      await db.collection('orders').doc(orderId).update({
        d365Synced: true,
        d365SyncedAt: new Date(),
      });
    }

    // Log sync
    logSync({
      restaurantId,
      type: 'single_order',
      orderId,
      status: result.success ? 'success' : 'error',
      journalLinesPosted: result.postedLines,
      totalAmount: order.totalAmount || order.finalAmount || 0,
      bcDocumentNumber: lines[0]?.documentNumber || '',
      error: result.errors.length > 0 ? result.errors.join('; ') : null,
      syncedBy: req.user.userId || req.user.uid,
    });

    res.json({
      success: result.success,
      journalLinesPosted: result.postedLines,
      orderId,
      errors: result.errors,
    });
  } catch (err) {
    console.error('[D365] Post order error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============================================================
// POST /sync-items/:restaurantId — Push/pull menu items
// ============================================================
router.post('/sync-items/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { direction } = req.body; // 'push' or 'pull'
    const config = await getD365Config(restaurantId);

    if (!direction || !['push', 'pull'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be "push" or "pull"' });
    }

    let menuItems = [];
    if (direction === 'push') {
      // Load menu items from DineOpen
      const snapshot = await db.collection('menuItems')
        .where('restaurantId', '==', restaurantId)
        .get();
      menuItems = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    const result = await d365Service.syncItems(config, direction, menuItems);

    // Log sync
    logSync({
      restaurantId,
      type: 'item_sync',
      status: (result.errors?.length || 0) === 0 ? 'success' : 'partial',
      itemsSynced: result.synced || result.pulled || 0,
      details: { direction, created: result.created, updated: result.updated, errors: result.errors },
      syncedBy: req.user.userId || req.user.uid,
    });

    res.json({ success: true, ...result, direction });
  } catch (err) {
    console.error('[D365] Sync items error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============================================================
// POST /sync-customers/:restaurantId — Push customers to BC
// ============================================================
router.post('/sync-customers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const config = await getD365Config(restaurantId);

    // Load customers from DineOpen
    const snapshot = await db.collection('customers')
      .where('restaurantId', '==', restaurantId)
      .get();
    const customers = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

    if (customers.length === 0) {
      return res.json({ success: true, message: 'No customers to sync', synced: 0 });
    }

    const result = await d365Service.syncCustomers(config, customers);

    // Log sync
    logSync({
      restaurantId,
      type: 'customer_sync',
      status: (result.errors?.length || 0) === 0 ? 'success' : 'partial',
      customersSynced: result.synced || 0,
      details: { created: result.created, updated: result.updated, errors: result.errors },
      syncedBy: req.user.userId || req.user.uid,
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[D365] Sync customers error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ============================================================
// GET /sync-log/:restaurantId — Sync history (paginated)
// ============================================================
router.get('/sync-log/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { limit: limitStr, type, startDate, endDate } = req.query;
    const limit = Math.min(parseInt(limitStr) || 50, 200);

    let query = db.collection('d365SyncLog')
      .where('restaurantId', '==', restaurantId)
      .orderBy('syncedAt', 'desc')
      .limit(limit);

    if (type) {
      query = db.collection('d365SyncLog')
        .where('restaurantId', '==', restaurantId)
        .where('type', '==', type)
        .orderBy('syncedAt', 'desc')
        .limit(limit);
    }

    const snapshot = await query.get();
    const logs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

    // Filter by date range in memory if needed (Firestore compound query limitations)
    let filtered = logs;
    if (startDate) {
      filtered = filtered.filter(l => (l.date || '') >= startDate);
    }
    if (endDate) {
      filtered = filtered.filter(l => (l.date || '') <= endDate);
    }

    res.json({ success: true, logs: filtered, total: filtered.length });
  } catch (err) {
    console.error('[D365] Sync log error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
