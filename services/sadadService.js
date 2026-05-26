/**
 * Sadad Cloud Payment API Service
 * Handles RSA signing, API communication, and signature verification
 * for Sadad/WiseCashier cloud-mode ECR integration.
 *
 * Docs: https://open.sadadpos.com
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ── RSA Signing ──

/**
 * Sign request parameters using RSA SHA256.
 * Per Sadad spec: sort params alphabetically by key, concat key=value with &, sign with SHA256withRSA.
 * @param {Object} params - Key-value pairs to sign (excludes 'sign' itself)
 * @param {string} privateKeyPem - RSA private key in PEM format
 * @returns {string} Base64-encoded signature
 */
function signRequest(params, privateKeyPem) {
  const filtered = Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  const paramString = filtered.map(([k, v]) => `${k}=${v}`).join('&');

  const signer = crypto.createSign('SHA256');
  signer.update(paramString);
  signer.end();

  return signer.sign(privateKeyPem, 'base64');
}

/**
 * Verify a callback signature from Sadad using their public key.
 * @param {Object} params - Callback payload (includes 'sign')
 * @param {string} sadadPublicKeyPem - Sadad's RSA public key in PEM format
 * @returns {boolean}
 */
function verifyCallback(params, sadadPublicKeyPem) {
  const signature = params.sign;
  if (!signature) return false;

  const filtered = Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  const paramString = filtered.map(([k, v]) => `${k}=${v}`).join('&');

  const verifier = crypto.createVerify('SHA256');
  verifier.update(paramString);
  verifier.end();

  return verifier.verify(sadadPublicKeyPem, signature, 'base64');
}

// ── HTTP Client ──

/**
 * Make a signed API call to Sadad Cloud.
 * @param {string} endpoint - API path (e.g., '/api/push/createOrder')
 * @param {Object} params - Request body parameters
 * @param {Object} config - { sadadApiUrl, sadadAppId, sadadAccessToken, sadadPrivateKey }
 * @returns {Promise<Object>} Parsed JSON response
 */
async function _callApi(endpoint, params, config) {
  const { sadadApiUrl, sadadAppId, sadadAccessToken, sadadPrivateKey } = config;

  if (!sadadPrivateKey) throw new Error('Sadad private key not configured');
  if (!sadadAccessToken) throw new Error('Sadad access token not configured');

  // Add app_id to params
  const allParams = { ...params, app_id: sadadAppId };
  const sign = signRequest(allParams, sadadPrivateKey);

  const body = JSON.stringify({ ...allParams, sign });
  const url = new URL(endpoint, sadadApiUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          access_token: sadadAccessToken,
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.msg === 'success' || parsed.code === '0' || parsed.trans_no) {
              resolve(parsed);
            } else {
              reject(new Error(`Sadad API error: ${parsed.msg || parsed.message || JSON.stringify(parsed)}`));
            }
          } catch (e) {
            reject(new Error(`Sadad API returned invalid JSON: ${data.substring(0, 200)}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(new Error(`Sadad API network error: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Sadad API request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ── Public API ──

/**
 * Push a payment order to a Sadad terminal via cloud.
 * @param {Object} config - Restaurant's Sadad configuration
 * @param {string} merchantOrderNo - Unique order reference from POS
 * @param {string} orderAmount - Amount string (e.g., '150.00')
 * @param {string} description - Order description
 * @param {string} notifyUrl - Webhook callback URL
 * @returns {Promise<{ trans_no, message_id, trans_status }>}
 */
async function createOrder(config, { merchantOrderNo, orderAmount, description, notifyUrl }) {
  const params = {
    merchant_no: config.sadadMerchantNo,
    store_no: config.sadadStoreNo,
    terminal_sn: config.sadadTerminalSn,
    merchant_order_no: merchantOrderNo,
    order_amount: orderAmount,
    pay_method_id: 'Bankcard',
    trans_type: '0',
    description: description || 'POS Payment',
    notify_url: notifyUrl,
  };

  return _callApi('/api/push/createOrder', params, config);
}

/**
 * Query the status of an existing order.
 * @param {Object} config - Restaurant's Sadad configuration
 * @param {string} merchantOrderNo - The merchant_order_no used in createOrder
 * @returns {Promise<{ trans_status, trans_no, order_amount, auth_no, ... }>}
 */
async function queryOrder(config, merchantOrderNo) {
  const params = {
    merchant_no: config.sadadMerchantNo,
    merchant_order_no: merchantOrderNo,
    trans_type: '0',
  };

  return _callApi('/api/push/queryOrder', params, config);
}

/**
 * Close/cancel a pending order (trans_status=9).
 * @param {Object} config
 * @param {string} merchantOrderNo
 */
async function closeOrder(config, merchantOrderNo) {
  const params = {
    merchant_no: config.sadadMerchantNo,
    merchant_order_no: merchantOrderNo,
  };

  return _callApi('/api/push/closeOrder', params, config);
}

/**
 * Refund a completed transaction.
 * @param {Object} config
 * @param {string} merchantOrderNo
 * @param {string} refundAmount
 * @param {string} transNo - Original transaction number from Sadad
 * @param {string} description
 */
async function refundOrder(config, { merchantOrderNo, refundAmount, transNo, description }) {
  const params = {
    merchant_no: config.sadadMerchantNo,
    merchant_order_no: merchantOrderNo,
    refund_amount: refundAmount,
    trans_no: transNo,
    description: description || 'Refund',
  };

  return _callApi('/api/push/refund', params, config);
}

module.exports = {
  signRequest,
  verifyCallback,
  createOrder,
  queryOrder,
  closeOrder,
  refundOrder,
};
