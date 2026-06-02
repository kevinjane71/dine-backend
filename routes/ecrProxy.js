/**
 * NAPS Qatar ECR Payment Terminal Proxy
 * Forwards ECR API requests from web POS clients to the local payment terminal.
 * Used when the POS runs in a browser (cannot make direct HTTPS to self-signed cert terminals).
 * Electron and Capacitor bypass this by calling the terminal directly.
 */

const express = require('express');
const https = require('https');
const { getCachedRestDoc } = require('../utils/kvCache');
const router = express.Router();

const ECR_TIMEOUT_MS = 120000; // 2 minutes for card tap

module.exports = (db, collections, authenticateToken) => {

  /**
   * POST /api/ecr/proxy
   * Proxy a request to the ECR terminal
   */
  router.post('/proxy', authenticateToken, async (req, res) => {
    const { terminalIp, port, endpoint, payload, restaurantId } = req.body;

    if (!terminalIp || !endpoint || !restaurantId) {
      return res.status(400).json({ error: 'Missing required fields: terminalIp, endpoint, restaurantId' });
    }

    // Validate that restaurant has ECR enabled and IP matches stored config
    try {
      const restaurantDoc = await getCachedRestDoc(db, collections.restaurants, restaurantId);
      if (!restaurantDoc.exists) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }
      const ecrSettings = restaurantDoc.data().ecrSettings;
      if (!ecrSettings?.enabled) {
        return res.status(403).json({ error: 'ECR is not enabled for this restaurant' });
      }
      if (ecrSettings.terminalIp !== terminalIp) {
        return res.status(403).json({ error: 'Terminal IP does not match stored configuration' });
      }
    } catch (err) {
      console.error('ECR proxy: Error validating restaurant:', err);
      return res.status(500).json({ error: 'Failed to validate restaurant settings' });
    }

    // Forward request to terminal
    try {
      const result = await makeEcrCall(terminalIp, port || 8443, endpoint, payload || {});
      res.json(result);
    } catch (err) {
      console.error('ECR proxy: Terminal communication error:', err.message);
      res.status(502).json({ error: 'ECR terminal unreachable', message: err.message });
    }
  });

  /**
   * POST /api/ecr/test
   * Test connectivity to a terminal (used from admin settings)
   */
  router.post('/test', authenticateToken, async (req, res) => {
    const { terminalIp, port } = req.body;

    if (!terminalIp) {
      return res.status(400).json({ error: 'Missing terminalIp' });
    }

    try {
      const result = await makeEcrCall(terminalIp, port || 8443, '/getLastTransaction', {});
      res.json({ success: true, message: 'Terminal is reachable', result });
    } catch (err) {
      res.json({ success: false, message: err.message || 'Terminal unreachable' });
    }
  });

  return router;
};

/**
 * Make an HTTPS request to the ECR terminal
 * Uses rejectUnauthorized:false because NAPS terminals use self-signed certificates
 */
function makeEcrCall(ip, port, endpoint, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: ip,
        port: port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        rejectUnauthorized: false, // NAPS terminals use self-signed certs
        timeout: ECR_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ raw: data });
          }
        });
      }
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('ECR terminal timeout — no response within 2 minutes'));
    });
    req.write(postData);
    req.end();
  });
}
