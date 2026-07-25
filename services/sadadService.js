/**
 * Sadad Cloud (WiseCashier / PayCloud) ECR Payment Service
 *
 * Implements the "PayCloud Open API for Sadad" (Wiseasy) signed-envelope protocol:
 *   - Every request carries system params (app_id, method, format, charset,
 *     sign_type, version, timestamp) + business params, all RSA2-signed.
 *   - Signature: sort all non-empty params by ASCII key, join `key=value` with `&`,
 *     SHA256withRSA using the app private key, Base64 encode → `sign`.
 *   - Response envelope: { code, msg, data (JSON string), psn, sign }.
 *       code === '0' && msg === 'success'  →  API-level success.
 *       `data` is a JSON *string* that must be parsed for the business result.
 *   - Responses / async notifications are signed with the gateway public key.
 *
 * Docs: PayCloud Open API for Sadad (open.sadadpos.com), ECR Cloud Mode.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONFIRMED from the official PDF spec:
 *   - URLs, Create Order + Query Order endpoints/methods, request/response shape,
 *     signing algorithm, and trans_status = 9 (pre-order / awaiting payment).
 *
 * ⚠ NEEDS CONFIRMATION FROM SADAD (collapsed sections not in the shared PDF):
 *   - The full trans_status enum (which code = paid / failed / refunded).
 *   - Close Order + Refund endpoint paths and `method` names.
 *   - Exact async notify (webhook) payload structure.
 *   These are isolated in the clearly-marked constants below so they are a
 *   one-line fix once Sadad confirms. Success is NEVER inferred from an
 *   unmapped status — an unknown status stays "pending" so we never mark an
 *   unpaid order as paid.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ── URLs ──
const SADAD_URLS = {
  PRODUCTION: 'https://open.sadadpos.com',
  UAT: 'https://open-uat.sadadpos.com',
};

// ── API endpoints ── (CONFIRMED: create + query. VERIFY: close + refund)
const ENDPOINTS = {
  CREATE_ORDER: '/api/entry/ecrorder',   // CONFIRMED
  QUERY_ORDER: '/api/entry/orderquery',  // CONFIRMED
  CLOSE_ORDER: '/api/entry/orderclose',  // ⚠ VERIFY WITH SADAD
  REFUND: '/api/entry/orderrefund',      // ⚠ VERIFY WITH SADAD
};

// ── API method names ── (CONFIRMED: create + query. VERIFY: close + refund)
const METHODS = {
  CREATE_ORDER: 'wisehub.cloud.pay.order', // CONFIRMED
  QUERY_ORDER: 'order.query',              // CONFIRMED
  CLOSE_ORDER: 'wisehub.cloud.pay.close',  // ⚠ VERIFY WITH SADAD
  REFUND: 'wisehub.cloud.pay.refund',      // ⚠ VERIFY WITH SADAD
};

// ── Transaction status codes ──
// CONFIRMED by docs: 9 = pre-order / awaiting payment (cancellable via Close Order).
// ⚠ The rest are the working assumption and MUST be confirmed against Sadad's
//   status-code table. The first UAT transaction will reveal the real "paid"
//   code in the logs (we log raw trans_status loudly). Update here when known.
const TRANS_STATUS = {
  PENDING: 9,          // CONFIRMED
  SUCCESS: 2,          // ⚠ VERIFY
  FAILED: 11,          // ⚠ VERIFY
  CANCELLED: 13,       // ⚠ VERIFY
  PARTIAL_REFUND: 14,  // ⚠ VERIFY
  FULL_REFUND: 17,     // ⚠ VERIFY
};

/**
 * Map a numeric trans_status to a simple lifecycle string the app understands.
 * Unknown / unmapped statuses resolve to 'pending' on purpose — we never treat
 * an unrecognised status as a completed payment.
 * @param {number|string} ts
 * @returns {'success'|'failed'|'cancelled'|'refunded'|'pending'}
 */
function mapTransStatus(ts) {
  const s = parseInt(ts, 10);
  if (s === TRANS_STATUS.SUCCESS) return 'success';
  if (s === TRANS_STATUS.FAILED) return 'failed';
  if (s === TRANS_STATUS.CANCELLED) return 'cancelled';
  if (s === TRANS_STATUS.PARTIAL_REFUND || s === TRANS_STATUS.FULL_REFUND) return 'refunded';
  return 'pending';
}

// ── PEM normalisation ──

/**
 * Accept a key whether it's already PEM (with headers), PEM with escaped `\n`,
 * or a bare Base64 blob, and return a valid PEM string.
 * @param {string} key
 * @param {'private'|'public'} kind
 */
function toPem(key, kind) {
  if (!key || typeof key !== 'string') return key;
  let k = key.trim().replace(/\\n/g, '\n');
  if (k.includes('BEGIN')) return k; // already PEM (PKCS1 or PKCS8, public or private)
  const header = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
  const body = (k.match(/.{1,64}/g) || []).join('\n');
  return `-----BEGIN ${header}-----\n${body}\n-----END ${header}-----`;
}

// ── Signing ──

/**
 * Build the canonical string to sign: drop empty/null/undefined and `sign`,
 * sort by ASCII key, join `key=value` pairs with `&`.
 */
function buildSignString(params) {
  return Object.entries(params)
    .filter(([k, v]) => k !== 'sign' && v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * RSA2 (SHA256withRSA) sign, Base64 encoded.
 * @param {Object} params
 * @param {string} privateKeyPem
 * @returns {string}
 */
function signParams(params, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(buildSignString(params), 'utf8');
  signer.end();
  return signer.sign(toPem(privateKeyPem, 'private'), 'base64');
}

/**
 * Verify a signed response / async notification using the gateway public key.
 * @param {Object} params - payload including `sign`
 * @param {string} gatewayPublicKeyPem
 * @returns {boolean}
 */
function verifySign(params, gatewayPublicKeyPem) {
  if (!params || !params.sign || !gatewayPublicKeyPem) return false;
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(buildSignString(params), 'utf8');
  verifier.end();
  return verifier.verify(toPem(gatewayPublicKeyPem, 'public'), params.sign, 'base64');
}

// ── HTTP client ──

/**
 * Make a signed API call to Sadad PayCloud.
 * @param {Object} config - { apiUrl, appId, privateKey, publicKey }
 * @param {string} method - one of METHODS.*
 * @param {string} endpoint - one of ENDPOINTS.*
 * @param {Object} bizParams - business parameters
 * @returns {Promise<{ data: Object, raw: Object }>}
 *          `data` = parsed business result, `raw` = full response envelope.
 * @throws {Error} with `.kind` in { 'network','timeout','parse','business','signature' }
 */
function callApi(config, method, endpoint, bizParams) {
  return new Promise((resolve, reject) => {
    if (!config.privateKey) return reject(_err('Sadad private key not configured', 'business'));
    if (!config.appId) return reject(_err('Sadad App ID not configured', 'business'));

    const params = {
      app_id: config.appId,
      method,
      format: 'JSON',
      charset: 'UTF-8',
      sign_type: 'RSA2',
      version: '1.0',
      timestamp: String(Date.now()),
      ...bizParams,
    };

    let sign;
    try {
      sign = signParams(params, config.privateKey);
    } catch (e) {
      return reject(_err(`Failed to sign request (check private key): ${e.message}`, 'signature'));
    }

    const body = JSON.stringify({ ...params, sign });
    const url = new URL(endpoint, config.apiUrl || SADAD_URLS.PRODUCTION);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 35000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let env;
          try {
            env = JSON.parse(raw);
          } catch (e) {
            return reject(_err(`Sadad returned invalid JSON: ${raw.slice(0, 300)}`, 'parse'));
          }

          // API-level result
          const ok = env.code === '0' || env.code === 0 || env.msg === 'success';
          if (!ok) {
            return reject(_err(
              `Sadad API error [${env.code}]: ${env.msg || env.message || JSON.stringify(env)}`,
              'business',
              env.code,
            ));
          }

          // Verify gateway signature on the response (best-effort; log only).
          if (config.publicKey && env.sign) {
            try {
              if (!verifySign(env, config.publicKey)) {
                console.warn('[Sadad] Response signature verification FAILED for', method);
              }
            } catch (e) {
              console.warn('[Sadad] Response signature check error:', e.message);
            }
          }

          // `data` is a JSON string in the documented responses.
          let data = env.data;
          if (typeof data === 'string' && data.length) {
            try { data = JSON.parse(data); } catch (e) { /* leave as string */ }
          }
          resolve({ data: data || {}, raw: env });
        });
      }
    );

    req.on('error', (err) => reject(_err(`Sadad network error: ${err.message}`, 'network')));
    req.on('timeout', () => { req.destroy(); reject(_err('Sadad request timed out', 'timeout')); });
    req.write(body);
    req.end();
  });
}

function _err(message, kind, sadadCode) {
  const e = new Error(message);
  e.kind = kind;
  if (sadadCode !== undefined) e.sadadCode = sadadCode;
  return e;
}

// ── Public API ──

/**
 * Push a payment order to the terminal. SadadSystem pre-creates the order
 * (trans_status=9) and wakes WiseCashier on the device.
 * @returns {Promise<{ transNo, messageId, terminalOnlineStatus, transAmount }>}
 */
async function createOrder(config, { merchantOrderNo, orderAmount, description, notifyUrl, attach }) {
  const biz = {
    merchant_no: config.merchantNo,
    store_no: config.storeNo,
    terminal_sn: config.terminalSn,
    merchant_order_no: merchantOrderNo,
    order_amount: orderAmount,
    price_currency: config.currency || 'QAR',
    trans_type: 1,                                 // 1 = sale/payment
    pay_scenario: 'SWIPE_CARD',                    // card on terminal
    message_receiving_application: 'SADAD POS',
    description: description || 'POS Payment',
    notify_url: notifyUrl,
    expires: 300,                                  // seconds the terminal waits
    reject_trade_when_terminal_offline: false,
    required_terminal_authentication: false,
    api_version: '2.0',
  };
  if (attach) biz.attach = typeof attach === 'string' ? attach : JSON.stringify(attach);

  const { data, raw } = await callApi(config, METHODS.CREATE_ORDER, ENDPOINTS.CREATE_ORDER, biz);
  return {
    transNo: data.trans_no || '',
    messageId: data.message_id || '',
    terminalOnlineStatus: data.terminal_online_status || '',
    transAmount: data.trans_amount || orderAmount,
    raw,
  };
}

/**
 * Query the current status of an order.
 * @returns {Promise<{ transStatus, status, transNo, orderAmount, transAmount,
 *                      authNo, cardNetwork, payUserAccountId, raw, data }>}
 */
async function queryOrder(config, merchantOrderNo) {
  const biz = {
    merchant_no: config.merchantNo,
    merchant_order_no: merchantOrderNo,
  };
  const { data, raw } = await callApi(config, METHODS.QUERY_ORDER, ENDPOINTS.QUERY_ORDER, biz);
  const transStatus = parseInt(data.trans_status, 10);
  return {
    transStatus,
    status: mapTransStatus(transStatus),
    transNo: data.trans_no || '',
    orderAmount: data.order_amount || '',
    transAmount: data.trans_amount || '',
    authNo: data.auth_no || data.approval_code || '',
    cardNetwork: data.card_network || data.card_org || '',
    payUserAccountId: data.pay_user_account_id || data.card_no || '',
    data,
    raw,
  };
}

/**
 * Close / cancel a pending (trans_status=9) order.
 * ⚠ Endpoint + method need Sadad confirmation (see ENDPOINTS/METHODS).
 */
async function closeOrder(config, merchantOrderNo) {
  const biz = {
    merchant_no: config.merchantNo,
    merchant_order_no: merchantOrderNo,
  };
  return callApi(config, METHODS.CLOSE_ORDER, ENDPOINTS.CLOSE_ORDER, biz);
}

/**
 * Refund a completed transaction.
 * ⚠ Endpoint + method + exact params need Sadad confirmation.
 */
async function refundOrder(config, { merchantOrderNo, refundAmount, transNo, description }) {
  const biz = {
    merchant_no: config.merchantNo,
    merchant_order_no: merchantOrderNo,
    trans_no: transNo,
    refund_amount: refundAmount,
    price_currency: config.currency || 'QAR',
    description: description || 'Refund',
  };
  const { data, raw } = await callApi(config, METHODS.REFUND, ENDPOINTS.REFUND, biz);
  return { refundTransNo: data.trans_no || '', data, raw };
}

module.exports = {
  SADAD_URLS,
  ENDPOINTS,
  METHODS,
  TRANS_STATUS,
  mapTransStatus,
  toPem,
  buildSignString,
  signParams,
  verifySign,
  callApi,
  createOrder,
  queryOrder,
  closeOrder,
  refundOrder,
};
