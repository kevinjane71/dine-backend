// razorpayOAuth.js - Razorpay OAuth Platform Partner integration
// Separate from payment.js (which handles DineOpen's own subscription billing).
// This file handles restaurants connecting their Razorpay accounts via OAuth
// so their customers can pay directly to the restaurant's account.
const express = require('express');
const crypto = require('crypto');

const RAZORPAY_AUTH_URL = 'https://auth.razorpay.com/authorize';
const RAZORPAY_TOKEN_URL = 'https://api.razorpay.com/v1/oauth/token';
const RAZORPAY_REVOKE_URL = 'https://api.razorpay.com/v1/oauth/token/revoke';
const RAZORPAY_ORDERS_URL = 'https://api.razorpay.com/v1/orders';

// --- Token encryption helpers (AES-256-GCM) ---

function getEncryptionKey() {
  const key = process.env.RAZORPAY_TOKEN_ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error('RAZORPAY_TOKEN_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(key, 'hex');
}

function encryptToken(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptToken(encryptedStr) {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertextHex] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// --- State token helpers (HMAC-signed to prevent tampering) ---

function signState(restaurantId) {
  const secret = process.env.RAZORPAY_OAUTH_CLIENT_SECRET;
  const hmac = crypto.createHmac('sha256', secret).update(restaurantId).digest('hex').slice(0, 16);
  return `${restaurantId}.${hmac}`;
}

function verifyState(state) {
  const [restaurantId, hmac] = state.split('.');
  if (!restaurantId || !hmac) return null;
  const expected = signState(restaurantId);
  if (state === expected) return restaurantId;
  return null;
}

// --- Token refresh helper ---

async function refreshAccessToken(db, restaurantId, tokenDoc) {
  const clientId = process.env.RAZORPAY_OAUTH_CLIENT_ID;
  const clientSecret = process.env.RAZORPAY_OAUTH_CLIENT_SECRET;

  let refreshToken;
  try {
    refreshToken = decryptToken(tokenDoc.refreshToken);
  } catch (e) {
    console.error(`[RazorpayOAuth] Failed to decrypt refresh token for ${restaurantId}:`, e.message);
    return null;
  }

  try {
    const response = await fetch(RAZORPAY_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[RazorpayOAuth] Token refresh failed for ${restaurantId}:`, response.status, errBody);
      // Refresh token expired — mark disconnected
      if (response.status === 400 || response.status === 401) {
        await markDisconnected(db, restaurantId);
      }
      return null;
    }

    const data = await response.json();

    // Store new tokens (encrypted)
    const updatedTokenData = {
      accessToken: encryptToken(data.access_token),
      refreshToken: encryptToken(data.refresh_token),
      publicToken: data.public_token,
      razorpayAccountId: data.razorpay_account_id || tokenDoc.razorpayAccountId,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
      updatedAt: new Date(),
    };

    await db.collection('razorpay_tokens').doc(restaurantId).update(updatedTokenData);

    return {
      accessToken: data.access_token,
      publicToken: data.public_token,
      razorpayAccountId: updatedTokenData.razorpayAccountId,
    };
  } catch (e) {
    console.error(`[RazorpayOAuth] Token refresh error for ${restaurantId}:`, e.message);
    return null;
  }
}

// --- Helper to mark restaurant as disconnected ---

async function markDisconnected(db, restaurantId) {
  try {
    // Update customerAppSettings
    const restRef = db.collection('restaurants').doc(restaurantId);
    const restDoc = await restRef.get();
    if (restDoc.exists) {
      const settings = restDoc.data().customerAppSettings || {};
      const paymentSettings = settings.paymentSettings || {};
      paymentSettings.razorpayConnected = false;
      paymentSettings.razorpayEnabled = false;
      settings.paymentSettings = paymentSettings;
      await restRef.update({ customerAppSettings: settings });
    }
  } catch (e) {
    console.error(`[RazorpayOAuth] Failed to mark disconnected for ${restaurantId}:`, e.message);
  }
}

// --- Get decrypted access token (with auto-refresh) ---

async function getAccessToken(db, restaurantId) {
  const tokenDoc = await db.collection('razorpay_tokens').doc(restaurantId).get();
  if (!tokenDoc.exists) return null;

  const data = tokenDoc.data();

  // Check if token is expired (or will expire in next 5 minutes)
  const isExpired = data.expiresAt && new Date(data.expiresAt._seconds ? data.expiresAt._seconds * 1000 : data.expiresAt) < new Date(Date.now() + 5 * 60 * 1000);

  if (isExpired) {
    const refreshed = await refreshAccessToken(db, restaurantId, data);
    if (!refreshed) return null;
    return refreshed;
  }

  try {
    return {
      accessToken: decryptToken(data.accessToken),
      publicToken: data.publicToken,
      razorpayAccountId: data.razorpayAccountId,
    };
  } catch (e) {
    console.error(`[RazorpayOAuth] Failed to decrypt access token for ${restaurantId}:`, e.message);
    return null;
  }
}

// --- Initialize routes ---

const initializeRazorpayOAuthRoutes = (db, authenticateToken) => {
  const router = express.Router();

  // A. GET /authorize-url — Authenticated, returns OAuth URL for the restaurant to connect
  router.get('/authorize-url', authenticateToken, async (req, res) => {
    try {
      const restaurantId = req.query.restaurantId;
      if (!restaurantId) {
        return res.status(400).json({ error: 'restaurantId is required' });
      }

      const clientId = process.env.RAZORPAY_OAUTH_CLIENT_ID;
      const redirectUri = process.env.RAZORPAY_OAUTH_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.dineopen.com'}/api/razorpay-oauth/callback`;

      if (!clientId) {
        return res.status(503).json({ error: 'Razorpay OAuth not configured' });
      }

      const state = signState(restaurantId);

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: state,
      });
      // scope[] needs special handling
      const url = `${RAZORPAY_AUTH_URL}?${params.toString()}&scope[]=read_write`;

      res.json({ url });
    } catch (error) {
      console.error('[RazorpayOAuth] authorize-url error:', error);
      res.status(500).json({ error: 'Failed to generate authorization URL' });
    }
  });

  // B. GET /callback — Public (Razorpay redirects here after merchant approves)
  router.get('/callback', async (req, res) => {
    try {
      const { code, state, error: oauthError, error_description } = req.query;

      const frontendUrl = process.env.FRONTEND_URL || 'https://www.dineopen.com';

      if (oauthError) {
        console.error(`[RazorpayOAuth] OAuth error: ${oauthError} - ${error_description}`);
        return res.redirect(`${frontendUrl}/customer-app?razorpay=error&message=${encodeURIComponent(error_description || oauthError)}`);
      }

      if (!code || !state) {
        return res.redirect(`${frontendUrl}/customer-app?razorpay=error&message=${encodeURIComponent('Missing authorization code')}`);
      }

      // Verify state to get restaurantId
      const restaurantId = verifyState(state);
      if (!restaurantId) {
        return res.redirect(`${frontendUrl}/customer-app?razorpay=error&message=${encodeURIComponent('Invalid state parameter')}`);
      }

      // Exchange code for tokens
      const clientId = process.env.RAZORPAY_OAUTH_CLIENT_ID;
      const clientSecret = process.env.RAZORPAY_OAUTH_CLIENT_SECRET;
      const redirectUri = process.env.RAZORPAY_OAUTH_REDIRECT_URI || `${process.env.BACKEND_URL || 'https://api.dineopen.com'}/api/razorpay-oauth/callback`;

      const tokenResponse = await fetch(RAZORPAY_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenResponse.ok) {
        const errBody = await tokenResponse.text();
        console.error(`[RazorpayOAuth] Token exchange failed:`, tokenResponse.status, errBody);
        return res.redirect(`${frontendUrl}/customer-app?razorpay=error&message=${encodeURIComponent('Token exchange failed')}`);
      }

      const tokenData = await tokenResponse.json();

      // Encrypt and store tokens
      await db.collection('razorpay_tokens').doc(restaurantId).set({
        accessToken: encryptToken(tokenData.access_token),
        refreshToken: encryptToken(tokenData.refresh_token),
        publicToken: tokenData.public_token,
        razorpayAccountId: tokenData.razorpay_account_id,
        expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Update customerAppSettings to mark as connected
      const restRef = db.collection('restaurants').doc(restaurantId);
      const restDoc = await restRef.get();
      if (restDoc.exists) {
        const settings = restDoc.data().customerAppSettings || {};
        const paymentSettings = settings.paymentSettings || {};
        paymentSettings.razorpayConnected = true;
        paymentSettings.razorpayAccountId = tokenData.razorpay_account_id;
        settings.paymentSettings = paymentSettings;
        await restRef.update({ customerAppSettings: settings });
      }

      console.log(`[RazorpayOAuth] Restaurant ${restaurantId} connected successfully (${tokenData.razorpay_account_id})`);
      res.redirect(`${frontendUrl}/customer-app?razorpay=connected`);
    } catch (error) {
      console.error('[RazorpayOAuth] callback error:', error);
      const frontendUrl = process.env.FRONTEND_URL || 'https://www.dineopen.com';
      res.redirect(`${frontendUrl}/customer-app?razorpay=error&message=${encodeURIComponent('Connection failed')}`);
    }
  });

  // C. POST /disconnect — Authenticated, disconnects restaurant's Razorpay
  router.post('/disconnect', authenticateToken, async (req, res) => {
    try {
      const { restaurantId } = req.body;
      if (!restaurantId) {
        return res.status(400).json({ error: 'restaurantId is required' });
      }

      // Try to revoke the token first (best-effort)
      try {
        const tokenDoc = await db.collection('razorpay_tokens').doc(restaurantId).get();
        if (tokenDoc.exists) {
          const data = tokenDoc.data();
          const accessToken = decryptToken(data.accessToken);
          await fetch(RAZORPAY_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: process.env.RAZORPAY_OAUTH_CLIENT_ID,
              client_secret: process.env.RAZORPAY_OAUTH_CLIENT_SECRET,
              token: accessToken,
              token_type_hint: 'access_token',
            }),
          });
        }
      } catch (revokeErr) {
        console.error('[RazorpayOAuth] Token revoke failed (non-blocking):', revokeErr.message);
      }

      // Delete stored tokens
      await db.collection('razorpay_tokens').doc(restaurantId).delete();

      // Update settings
      await markDisconnected(db, restaurantId);

      console.log(`[RazorpayOAuth] Restaurant ${restaurantId} disconnected`);
      res.json({ success: true, message: 'Razorpay account disconnected' });
    } catch (error) {
      console.error('[RazorpayOAuth] disconnect error:', error);
      res.status(500).json({ error: 'Failed to disconnect Razorpay account' });
    }
  });

  // D. GET /status — Authenticated, check connection status
  router.get('/status', authenticateToken, async (req, res) => {
    try {
      const restaurantId = req.query.restaurantId;
      if (!restaurantId) {
        return res.status(400).json({ error: 'restaurantId is required' });
      }

      const tokenDoc = await db.collection('razorpay_tokens').doc(restaurantId).get();
      if (!tokenDoc.exists) {
        return res.json({ connected: false });
      }

      const data = tokenDoc.data();
      res.json({
        connected: true,
        razorpayAccountId: data.razorpayAccountId,
        connectedAt: data.createdAt,
      });
    } catch (error) {
      console.error('[RazorpayOAuth] status error:', error);
      res.status(500).json({ error: 'Failed to check status' });
    }
  });

  return router;
};

// --- Public routes (no auth needed — for customer-facing checkout) ---

const initializeRazorpayPublicRoutes = (db) => {
  const router = express.Router();

  // POST /create-order/:restaurantId — Creates a Razorpay order using restaurant's token
  router.post('/create-order/:restaurantId', async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { amount, currency = 'INR', receipt, notes } = req.body;

      if (!amount || amount < 100) {
        return res.status(400).json({ error: 'Amount must be at least ₹1 (100 paise)' });
      }

      // Get restaurant's access token (auto-refreshes if expired)
      const tokenData = await getAccessToken(db, restaurantId);
      if (!tokenData) {
        return res.status(400).json({ error: 'Restaurant has not connected Razorpay or token expired. Please contact the restaurant.' });
      }

      // Create order using restaurant's OAuth access token
      const orderResponse = await fetch(RAZORPAY_ORDERS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.accessToken}`,
        },
        body: JSON.stringify({
          amount: Math.round(amount), // amount in paise
          currency,
          receipt: receipt || `order_${Date.now()}`,
          notes: notes || {},
        }),
      });

      if (!orderResponse.ok) {
        const errBody = await orderResponse.text();
        console.error(`[RazorpayOAuth] Create order failed for ${restaurantId}:`, orderResponse.status, errBody);

        // If unauthorized, token might be invalid — try refresh once
        if (orderResponse.status === 401) {
          const tokenDoc = await db.collection('razorpay_tokens').doc(restaurantId).get();
          if (tokenDoc.exists) {
            const refreshed = await refreshAccessToken(db, restaurantId, tokenDoc.data());
            if (refreshed) {
              // Retry with new token
              const retryResponse = await fetch(RAZORPAY_ORDERS_URL, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${refreshed.accessToken}`,
                },
                body: JSON.stringify({
                  amount: Math.round(amount),
                  currency,
                  receipt: receipt || `order_${Date.now()}`,
                  notes: notes || {},
                }),
              });

              if (retryResponse.ok) {
                const retryData = await retryResponse.json();
                return res.json({
                  orderId: retryData.id,
                  amount: retryData.amount,
                  currency: retryData.currency,
                  keyId: refreshed.publicToken,
                });
              }
            }
          }
          return res.status(400).json({ error: 'Payment gateway authorization failed. Restaurant may need to reconnect.' });
        }

        return res.status(500).json({ error: 'Failed to create payment order' });
      }

      const orderData = await orderResponse.json();

      res.json({
        orderId: orderData.id,
        amount: orderData.amount,
        currency: orderData.currency,
        keyId: tokenData.publicToken, // public_token is used as key_id in Razorpay Checkout
      });
    } catch (error) {
      console.error('[RazorpayOAuth] create-order error:', error);
      res.status(500).json({ error: 'Failed to create payment order' });
    }
  });

  // POST /verify-signature/:restaurantId — Verify payment signature
  router.post('/verify-signature/:restaurantId', async (req, res) => {
    try {
      const { restaurantId } = req.params;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return res.status(400).json({ error: 'Missing payment verification fields' });
      }

      // Get restaurant's access token to use as the signing key
      const tokenData = await getAccessToken(db, restaurantId);
      if (!tokenData) {
        return res.status(400).json({ error: 'Restaurant payment gateway not connected' });
      }

      // Razorpay signature verification: HMAC-SHA256(orderId|paymentId, secret)
      // For OAuth, the signing key is the access_token (JWT)
      const expectedSignature = crypto
        .createHmac('sha256', tokenData.accessToken)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest('hex');

      if (expectedSignature !== razorpaySignature) {
        console.error(`[RazorpayOAuth] Signature mismatch for ${restaurantId}. Expected: ${expectedSignature.slice(0, 10)}..., Got: ${razorpaySignature.slice(0, 10)}...`);
        return res.status(400).json({ error: 'Payment verification failed — signature mismatch' });
      }

      res.json({ verified: true });
    } catch (error) {
      console.error('[RazorpayOAuth] verify-signature error:', error);
      res.status(500).json({ error: 'Payment verification failed' });
    }
  });

  return router;
};

// --- Standalone verify function (used by public order endpoint in index.js) ---

async function verifyRazorpaySignature(db, restaurantId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const tokenData = await getAccessToken(db, restaurantId);
  if (!tokenData) {
    return { verified: false, error: 'Restaurant payment gateway not connected' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', tokenData.accessToken)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    return { verified: false, error: 'Payment verification failed — signature mismatch' };
  }

  return { verified: true };
}

module.exports = { initializeRazorpayOAuthRoutes, initializeRazorpayPublicRoutes, verifyRazorpaySignature };
