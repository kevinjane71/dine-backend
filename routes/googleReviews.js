const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken, requireOwnerRole } = require('../middleware/auth');
const QRCode = require('qrcode');
const OpenAI = require('openai');
const { OAuth2Client } = require('google-auth-library');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.dineopen.com';
const BACKEND_URL = process.env.BACKEND_URL || 'https://api.dineopen.com';
const OAUTH_REDIRECT_URI = `${BACKEND_URL}/api/google-reviews/auth/callback`;
const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const REVIEW_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  OAUTH_REDIRECT_URI
);

// ---------------------------------------------------------------------------
// Helper: Get a valid access token (refresh if expired)
// ---------------------------------------------------------------------------
async function getValidAccessToken(restaurantId) {
  try {
    const tokenDoc = await db.collection('googleBusinessTokens').doc(restaurantId).get();
    if (!tokenDoc.exists) return null;

    const tokenData = tokenDoc.data();
    if (!tokenData.accessToken || !tokenData.refreshToken) return null;

    const now = Date.now();
    const expiresAt = tokenData.expiresAt?.toMillis ? tokenData.expiresAt.toMillis() : tokenData.expiresAt;

    // If token is still valid (with 5-min buffer), return it
    if (expiresAt && now < expiresAt - 5 * 60 * 1000) {
      return tokenData.accessToken;
    }

    // Refresh the token
    oauth2Client.setCredentials({ refresh_token: tokenData.refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();

    const updatedFields = {
      accessToken: credentials.access_token,
      expiresAt: credentials.expiry_date || (Date.now() + 3600 * 1000),
      updatedAt: new Date()
    };
    if (credentials.refresh_token) {
      updatedFields.refreshToken = credentials.refresh_token;
    }

    await db.collection('googleBusinessTokens').doc(restaurantId).update(updatedFields);
    return credentials.access_token;
  } catch (error) {
    console.error('Error getting valid access token:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: Get GBP account & location IDs (with caching)
// ---------------------------------------------------------------------------
async function getGbpAccountAndLocation(restaurantId, accessToken) {
  try {
    // Check cache first
    const tokenDoc = await db.collection('googleBusinessTokens').doc(restaurantId).get();
    const tokenData = tokenDoc.exists ? tokenDoc.data() : {};

    if (tokenData.gbpAccountId && tokenData.gbpLocationId) {
      return { accountId: tokenData.gbpAccountId, locationId: tokenData.gbpLocationId };
    }

    // Fetch accounts
    const accountsRes = await fetch('https://mybusiness.googleapis.com/v4/accounts', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!accountsRes.ok) return null;
    const accountsData = await accountsRes.json();
    const accounts = accountsData.accounts || [];
    if (accounts.length === 0) return null;

    // Try to load restaurant data for matching
    let restaurantData = null;
    try {
      const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      if (restaurantDoc.exists) restaurantData = restaurantDoc.data();
    } catch (_) { /* ignore */ }

    // Iterate accounts and locations to find a match
    for (const account of accounts) {
      const accountId = account.name; // e.g. "accounts/123"
      const locationsRes = await fetch(`https://mybusiness.googleapis.com/v4/${accountId}/locations`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!locationsRes.ok) continue;
      const locationsData = await locationsRes.json();
      const locations = locationsData.locations || [];

      if (locations.length === 0) continue;

      let matched = null;

      if (locations.length === 1) {
        matched = locations[0];
      } else if (restaurantData) {
        // Try to match by name or address
        const rName = (restaurantData.name || '').toLowerCase();
        const rAddress = (restaurantData.address || '').toLowerCase();
        matched = locations.find(loc => {
          const locName = (loc.locationName || loc.title || '').toLowerCase();
          const locAddr = (loc.address?.formattedAddress || '').toLowerCase();
          return (rName && locName.includes(rName)) || (rAddress && locAddr.includes(rAddress));
        }) || locations[0]; // fallback to first
      } else {
        matched = locations[0];
      }

      if (matched) {
        const locationId = matched.name; // e.g. "accounts/123/locations/456"
        // Cache the IDs
        await db.collection('googleBusinessTokens').doc(restaurantId).update({
          gbpAccountId: accountId,
          gbpLocationId: locationId
        });
        return { accountId, locationId };
      }
    }

    return null;
  } catch (error) {
    console.error('Error getting GBP account/location:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: Extract Place ID from various Google Review URL formats
// ---------------------------------------------------------------------------
function extractPlaceId(googleReviewUrl) {
  if (!googleReviewUrl) return null;

  // Direct Place ID (not a URL)
  if (/^ChIJ[A-Za-z0-9_-]+$/.test(googleReviewUrl)) {
    return googleReviewUrl;
  }

  // ?placeid= or &placeid=
  const placeIdParam = googleReviewUrl.match(/[?&]placeid=([^&]+)/i);
  if (placeIdParam) return placeIdParam[1];

  // place_id= param
  const placeIdParam2 = googleReviewUrl.match(/[?&]place_id=([^&]+)/i);
  if (placeIdParam2) return placeIdParam2[1];

  // data= format containing hex place ID: !1s0x... or !1sChIJ...
  const dataMatch = googleReviewUrl.match(/!1s(0x[0-9a-fA-F]+:[0-9a-fA-F]+|ChIJ[A-Za-z0-9_-]+)/);
  if (dataMatch) return dataMatch[1];

  // ftid= param
  const ftidMatch = googleReviewUrl.match(/[?&]ftid=([^&]+)/i);
  if (ftidMatch) return ftidMatch[1];

  return null;
}

// ===========================================================================
// EXISTING ENDPOINTS (unchanged)
// ===========================================================================

// Get Google Review settings for a restaurant
router.get('/settings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();

    if (settingsDoc.exists) {
      res.json({ success: true, settings: settingsDoc.data() });
    } else {
      res.json({
        success: true,
        settings: {
          googleReviewUrl: '',
          aiEnabled: true,
          customMessage: '',
          qrCodeUrl: null
        }
      });
    }
  } catch (error) {
    console.error('Error fetching Google Review settings:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

// Update Google Review settings
router.post('/settings/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { googleReviewUrl, aiEnabled, customMessage } = req.body;

    // Normalize the URL to ensure it's a write review URL
    let normalizedUrl = googleReviewUrl || '';

    if (normalizedUrl) {
      // If it's a Place ID (long alphanumeric string), construct write review URL
      if (normalizedUrl.length > 20 && !normalizedUrl.startsWith('http') && !normalizedUrl.includes('/')) {
        normalizedUrl = `https://search.google.com/local/writereview?placeid=${normalizedUrl}`;
      }
      // If it's a Google Maps URL, try to extract Place ID
      else if (normalizedUrl.includes('maps/place/')) {
        const placeIdMatch = normalizedUrl.match(/place\/([^\/]+)/);
        if (placeIdMatch) {
          normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        }
      }
      // If it's already a write review URL, keep it
      else if (!normalizedUrl.includes('writereview') && !normalizedUrl.includes('placeid')) {
        // If it's a regular Google Maps URL, try to extract Place ID
        const placeIdMatch = normalizedUrl.match(/placeid=([^&]+)/);
        if (placeIdMatch) {
          normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        }
      }
    }

    const settings = {
      restaurantId,
      googleReviewUrl: normalizedUrl,
      aiEnabled: aiEnabled !== undefined ? aiEnabled : true,
      customMessage: customMessage || '',
      updatedAt: new Date()
    };

    await db.collection('googleReviewSettings').doc(restaurantId).set(settings, { merge: true });

    // Generate QR code if URL is provided - use the normalized write review URL
    if (normalizedUrl) {
      try {
        const qrCodeDataUrl = await QRCode.toDataURL(normalizedUrl, {
          width: 400,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
        settings.qrCodeUrl = qrCodeDataUrl;
        await db.collection('googleReviewSettings').doc(restaurantId).update({ qrCodeUrl: qrCodeDataUrl });
      } catch (qrError) {
        console.error('Error generating QR code:', qrError);
      }
    }

    res.json({ success: true, settings, message: 'Settings updated successfully' });
  } catch (error) {
    console.error('Error updating Google Review settings:', error);
    res.status(500).json({ success: false, error: 'Failed to update settings' });
  }
});

// Generate QR code for Google Review URL
router.post('/generate-qr/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    let { url } = req.body;

    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required' });
    }

    // Normalize URL to ensure it's a write review URL
    if (url.length > 20 && !url.startsWith('http') && !url.includes('/')) {
      // Assume it's a Place ID
      url = `https://search.google.com/local/writereview?placeid=${url}`;
    } else if (url.includes('maps/place/')) {
      // Extract Place ID from Google Maps URL
      const placeIdMatch = url.match(/place\/([^\/]+)/);
      if (placeIdMatch) {
        url = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
      }
    } else if (!url.includes('writereview') && !url.includes('placeid')) {
      // Try to extract Place ID from URL
      const placeIdMatch = url.match(/placeid=([^&]+)/);
      if (placeIdMatch) {
        url = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
      }
    }

    const qrCodeDataUrl = await QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    // Update settings with QR code and normalized URL (use set with merge to create if doesn't exist)
    await db.collection('googleReviewSettings').doc(restaurantId).set({
      restaurantId,
      qrCodeUrl: qrCodeDataUrl,
      googleReviewUrl: url,
      updatedAt: new Date()
    }, { merge: true });

    res.json({ success: true, qrCodeUrl: qrCodeDataUrl, reviewUrl: url });
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ success: false, error: 'Failed to generate QR code' });
  }
});

// Generate AI review content
router.post('/generate-content/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { customerName, rating } = req.body;

    // Fetch restaurant details
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const restaurantName = restaurantData.name || 'this restaurant';
    const cuisine = restaurantData.cuisine || [];
    const address = restaurantData.address || '';

    // Generate AI review content
    const aiPrompt = `Generate a genuine, authentic Google review for a restaurant. The review should:
- Be natural and conversational (not overly promotional)
- Mention specific positive aspects (food quality, service, ambiance, value)
- Be appropriate for a ${rating || 5}-star rating
- Be between 50-200 words
- Sound like a real customer wrote it
- Follow Google Review guidelines (honest, helpful, relevant)

Restaurant Details:
- Name: ${restaurantName}
- Cuisine: ${cuisine.join(', ') || 'Various'}
- Location: ${address}

${customerName ? `Customer Name: ${customerName}` : ''}
Rating: ${rating || 5} stars

Generate a review that feels authentic and would be helpful to other customers. Return only the review text, no additional formatting.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that generates authentic, genuine restaurant reviews that sound like real customers wrote them. Reviews should be honest, helpful, and follow Google Review guidelines.'
        },
        {
          role: 'user',
          content: aiPrompt
        }
      ],
      temperature: 0.8,
      max_tokens: 300
    });

    const reviewContent = completion.choices[0].message.content.trim();

    res.json({
      success: true,
      reviewContent,
      message: 'Review content generated successfully'
    });
  } catch (error) {
    console.error('Error generating AI review content:', error);
    res.status(500).json({ success: false, error: 'Failed to generate review content' });
  }
});

// Get Google Review link helper (constructs Google Review URL)
router.get('/review-link/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { placeId } = req.query;

    // Get saved settings
    const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();
    const savedUrl = settingsDoc.exists ? settingsDoc.data().googleReviewUrl : null;

    let reviewUrl = '';

    if (placeId) {
      // If placeId is provided, construct the write review URL
      reviewUrl = `https://search.google.com/local/writereview?placeid=${placeId}`;
    } else if (savedUrl) {
      // Use saved URL, but ensure it's a write review URL
      if (savedUrl.includes('writereview') || savedUrl.includes('placeid')) {
        reviewUrl = savedUrl;
      } else if (savedUrl.includes('maps/place/')) {
        // Extract Place ID from Google Maps URL
        const placeIdMatch = savedUrl.match(/place\/([^\/]+)/);
        if (placeIdMatch) {
          reviewUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        } else {
          reviewUrl = savedUrl;
        }
      } else if (savedUrl.length > 20 && !savedUrl.startsWith('http')) {
        // Assume it's a Place ID
        reviewUrl = `https://search.google.com/local/writereview?placeid=${savedUrl}`;
      } else {
        reviewUrl = savedUrl;
      }
    } else {
      return res.json({ success: false, error: 'No Google Review URL or Place ID configured. Please add a Place ID or direct URL.' });
    }

    res.json({ success: true, reviewUrl });
  } catch (error) {
    console.error('Error getting review link:', error);
    res.status(500).json({ success: false, error: 'Failed to get review link' });
  }
});

// ===========================================================================
// NEW ENDPOINTS: Google Business Profile OAuth & Review Management
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. GET /auth/url/:restaurantId — Generate Google OAuth URL
// ---------------------------------------------------------------------------
router.get('/auth/url/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const state = Buffer.from(JSON.stringify({
      restaurantId,
      userId: req.user.uid || req.user.userId
    })).toString('base64');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [GBP_SCOPE],
      state
    });

    res.json({ success: true, authUrl });
  } catch (error) {
    console.error('Error generating Google OAuth URL:', error);
    res.status(500).json({ success: false, error: 'Failed to generate OAuth URL' });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /auth/callback — OAuth callback (no auth middleware)
// ---------------------------------------------------------------------------
router.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      console.error('OAuth error:', oauthError);
      return res.redirect(`${FRONTEND_URL}/admin?tab=google-reviews&error=${encodeURIComponent(oauthError)}`);
    }

    if (!code || !state) {
      return res.redirect(`${FRONTEND_URL}/admin?tab=google-reviews&error=missing_params`);
    }

    // Decode state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    } catch (_) {
      return res.redirect(`${FRONTEND_URL}/admin?tab=google-reviews&error=invalid_state`);
    }

    const { restaurantId, userId } = stateData;
    if (!restaurantId || !userId) {
      return res.redirect(`${FRONTEND_URL}/admin?tab=google-reviews&error=invalid_state`);
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    // Get connected email from userinfo
    let connectedEmail = '';
    try {
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      if (userinfoRes.ok) {
        const userinfo = await userinfoRes.json();
        connectedEmail = userinfo.email || '';
      }
    } catch (emailErr) {
      console.error('Error fetching userinfo:', emailErr);
    }

    // Store tokens in Firestore
    await db.collection('googleBusinessTokens').doc(restaurantId).set({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date || (Date.now() + 3600 * 1000),
      restaurantId,
      userId,
      connectedEmail,
      connectedAt: new Date()
    });

    // Update settings to mark as connected
    await db.collection('googleReviewSettings').doc(restaurantId).set({
      googleAccountConnected: true,
      connectedEmail,
      updatedAt: new Date()
    }, { merge: true });

    res.redirect(`${FRONTEND_URL}/admin?tab=google-reviews&connected=true`);
  } catch (error) {
    console.error('Error in Google OAuth callback:', error);
    res.redirect(`${FRONTEND_URL}/admin?tab=google-reviews&error=callback_failed`);
  }
});

// ---------------------------------------------------------------------------
// 3. POST /auth/disconnect/:restaurantId — Disconnect Google account
// ---------------------------------------------------------------------------
router.post('/auth/disconnect/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    // Delete token document
    await db.collection('googleBusinessTokens').doc(restaurantId).delete();

    // Clear connection flag from settings
    await db.collection('googleReviewSettings').doc(restaurantId).set({
      googleAccountConnected: false,
      connectedEmail: null,
      updatedAt: new Date()
    }, { merge: true });

    res.json({ success: true, message: 'Google account disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting Google account:', error);
    res.status(500).json({ success: false, error: 'Failed to disconnect Google account' });
  }
});

// ---------------------------------------------------------------------------
// 4. GET /auth/status/:restaurantId — Check connection status
// ---------------------------------------------------------------------------
router.get('/auth/status/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const tokenDoc = await db.collection('googleBusinessTokens').doc(restaurantId).get();

    if (!tokenDoc.exists) {
      return res.json({ success: true, connected: false, email: null, connectedAt: null });
    }

    const tokenData = tokenDoc.data();
    res.json({
      success: true,
      connected: true,
      email: tokenData.connectedEmail || null,
      connectedAt: tokenData.connectedAt || null
    });
  } catch (error) {
    console.error('Error checking auth status:', error);
    res.status(500).json({ success: false, error: 'Failed to check connection status' });
  }
});

// ---------------------------------------------------------------------------
// 5. GET /reviews/:restaurantId — Fetch Google reviews
// ---------------------------------------------------------------------------
router.get('/reviews/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { pageSize = 20, pageToken } = req.query;

    // Check review cache first
    const cacheDoc = await db.collection('googleReviewsCache').doc(restaurantId).get();
    if (cacheDoc.exists) {
      const cacheData = cacheDoc.data();
      const cachedAt = cacheData.cachedAt?.toMillis ? cacheData.cachedAt.toMillis() : cacheData.cachedAt;
      // Only use cache if not requesting a specific page and cache is fresh
      if (!pageToken && cachedAt && (Date.now() - cachedAt) < REVIEW_CACHE_TTL_MS) {
        return res.json(cacheData.response);
      }
    }

    // --- Attempt GBP API first ---
    const accessToken = await getValidAccessToken(restaurantId);
    if (accessToken) {
      try {
        const gbpIds = await getGbpAccountAndLocation(restaurantId, accessToken);
        if (gbpIds) {
          const { locationId } = gbpIds;
          let url = `https://mybusiness.googleapis.com/v4/${locationId}/reviews?pageSize=${pageSize}&orderBy=update_time desc`;
          if (pageToken) url += `&pageToken=${pageToken}`;

          const reviewsRes = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });

          if (reviewsRes.ok) {
            const reviewsData = await reviewsRes.json();
            const reviews = (reviewsData.reviews || []).map(r => ({
              reviewId: r.reviewId || r.name,
              reviewer: {
                displayName: r.reviewer?.displayName || 'Anonymous',
                profilePhotoUrl: r.reviewer?.profilePhotoUrl || null
              },
              starRating: ratingToNumber(r.starRating),
              comment: r.comment || '',
              createTime: r.createTime || null,
              updateTime: r.updateTime || null,
              reviewReply: r.reviewReply ? {
                comment: r.reviewReply.comment || '',
                updateTime: r.reviewReply.updateTime || null
              } : null
            }));

            const response = {
              success: true,
              source: 'gbp',
              reviews,
              averageRating: reviewsData.averageRating || null,
              totalReviewCount: reviewsData.totalReviewCount || reviews.length,
              nextPageToken: reviewsData.nextPageToken || null
            };

            // Cache the response (only for first page)
            if (!pageToken) {
              await db.collection('googleReviewsCache').doc(restaurantId).set({
                response,
                cachedAt: Date.now()
              });
            }

            return res.json(response);
          }

          // If 401/403, fall through to Places API
          const status = reviewsRes.status;
          if (status !== 401 && status !== 403) {
            const errorBody = await reviewsRes.text();
            console.error('GBP reviews API error:', status, errorBody);
          }
        }
      } catch (gbpError) {
        console.error('GBP API error, falling back to Places API:', gbpError.message);
      }
    }

    // --- Fallback: Google Places API (New) ---
    try {
      // Get the Google Review URL from settings to extract Place ID
      const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();
      const googleReviewUrl = settingsDoc.exists ? settingsDoc.data().googleReviewUrl : null;
      const placeId = extractPlaceId(googleReviewUrl);

      if (!placeId) {
        return res.json({
          success: true,
          source: 'none',
          reviews: [],
          averageRating: null,
          totalReviewCount: 0,
          nextPageToken: null,
          message: 'No Google Review URL configured. Please add your Google Review link in settings.'
        });
      }

      const placesApiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_API_KEY;
      if (!placesApiKey) {
        return res.json({
          success: true,
          source: 'none',
          reviews: [],
          averageRating: null,
          totalReviewCount: 0,
          nextPageToken: null,
          message: 'Google Places API key not configured.'
        });
      }

      const placesRes = await fetch(
        `https://places.googleapis.com/v1/places/${placeId}?fields=reviews,rating,userRatingCount`,
        {
          headers: {
            'X-Goog-Api-Key': placesApiKey,
            'X-Goog-FieldMask': 'reviews,rating,userRatingCount'
          }
        }
      );

      if (!placesRes.ok) {
        const errorBody = await placesRes.text();
        console.error('Places API error:', placesRes.status, errorBody);
        return res.json({
          success: true,
          source: 'none',
          reviews: [],
          averageRating: null,
          totalReviewCount: 0,
          nextPageToken: null,
          message: 'Failed to fetch reviews from Google Places API.'
        });
      }

      const placesData = await placesRes.json();
      const reviews = (placesData.reviews || []).map((r, index) => ({
        reviewId: `places_${placeId}_${index}`,
        reviewer: {
          displayName: r.authorAttribution?.displayName || 'Anonymous',
          profilePhotoUrl: r.authorAttribution?.photoUri || null
        },
        starRating: r.rating || 0,
        comment: r.text?.text || r.originalText?.text || '',
        createTime: r.publishTime || null,
        updateTime: r.publishTime || null,
        reviewReply: null // Places API does not return replies
      }));

      const response = {
        success: true,
        source: 'places',
        reviews,
        averageRating: placesData.rating || null,
        totalReviewCount: placesData.userRatingCount || reviews.length,
        nextPageToken: null // Places API returns max 5, no pagination
      };

      // Cache the response
      await db.collection('googleReviewsCache').doc(restaurantId).set({
        response,
        cachedAt: Date.now()
      });

      return res.json(response);
    } catch (placesError) {
      console.error('Places API fallback error:', placesError);
      return res.json({
        success: true,
        source: 'none',
        reviews: [],
        averageRating: null,
        totalReviewCount: 0,
        nextPageToken: null,
        message: 'Unable to fetch reviews at this time.'
      });
    }
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch reviews' });
  }
});

// ---------------------------------------------------------------------------
// 6. POST /reviews/:restaurantId/:reviewId/reply — Reply to a review
// ---------------------------------------------------------------------------
router.post('/reviews/:restaurantId/:reviewId/reply', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId, reviewId } = req.params;
    const { comment } = req.body;

    if (!comment || !comment.trim()) {
      return res.status(400).json({ success: false, error: 'Reply comment is required' });
    }

    const accessToken = await getValidAccessToken(restaurantId);
    if (!accessToken) {
      return res.status(403).json({
        success: false,
        error: 'Google Business Profile not connected. Please connect your Google account to reply to reviews.'
      });
    }

    const gbpIds = await getGbpAccountAndLocation(restaurantId, accessToken);
    if (!gbpIds) {
      return res.status(404).json({
        success: false,
        error: 'Could not find your Google Business Profile location. Please verify your account connection.'
      });
    }

    // Build the review name path
    const reviewName = reviewId.startsWith('accounts/')
      ? reviewId
      : `${gbpIds.locationId}/reviews/${reviewId}`;

    const replyRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${reviewName}/reply`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ comment: comment.trim() })
      }
    );

    if (!replyRes.ok) {
      const errorBody = await replyRes.text();
      console.error('GBP reply error:', replyRes.status, errorBody);

      if (replyRes.status === 403 || replyRes.status === 401) {
        return res.status(403).json({
          success: false,
          error: 'Unable to reply. Google Business Profile API access may not be approved yet, or your permissions are insufficient.'
        });
      }
      if (replyRes.status === 429) {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded. Please wait a moment and try again (exponential backoff recommended).'
        });
      }

      return res.status(replyRes.status).json({ success: false, error: 'Failed to post reply to Google' });
    }

    const replyData = await replyRes.json();

    // Invalidate review cache
    await db.collection('googleReviewsCache').doc(restaurantId).delete();

    res.json({
      success: true,
      reply: replyData,
      message: 'Reply posted successfully'
    });
  } catch (error) {
    console.error('Error replying to review:', error);
    res.status(500).json({ success: false, error: 'Failed to reply to review' });
  }
});

// ---------------------------------------------------------------------------
// 7. DELETE /reviews/:restaurantId/:reviewId/reply — Delete a reply
// ---------------------------------------------------------------------------
router.delete('/reviews/:restaurantId/:reviewId/reply', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId, reviewId } = req.params;

    const accessToken = await getValidAccessToken(restaurantId);
    if (!accessToken) {
      return res.status(403).json({
        success: false,
        error: 'Google Business Profile not connected. Please connect your Google account to manage replies.'
      });
    }

    const gbpIds = await getGbpAccountAndLocation(restaurantId, accessToken);
    if (!gbpIds) {
      return res.status(404).json({
        success: false,
        error: 'Could not find your Google Business Profile location.'
      });
    }

    const reviewName = reviewId.startsWith('accounts/')
      ? reviewId
      : `${gbpIds.locationId}/reviews/${reviewId}`;

    const deleteRes = await fetch(
      `https://mybusiness.googleapis.com/v4/${reviewName}/reply`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` }
      }
    );

    if (!deleteRes.ok) {
      const errorBody = await deleteRes.text();
      console.error('GBP delete reply error:', deleteRes.status, errorBody);

      if (deleteRes.status === 403 || deleteRes.status === 401) {
        return res.status(403).json({
          success: false,
          error: 'Unable to delete reply. Google Business Profile API access may not be approved yet.'
        });
      }
      if (deleteRes.status === 429) {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded. Please wait a moment and try again (exponential backoff recommended).'
        });
      }

      return res.status(deleteRes.status).json({ success: false, error: 'Failed to delete reply' });
    }

    // Invalidate review cache
    await db.collection('googleReviewsCache').doc(restaurantId).delete();

    res.json({ success: true, message: 'Reply deleted successfully' });
  } catch (error) {
    console.error('Error deleting reply:', error);
    res.status(500).json({ success: false, error: 'Failed to delete reply' });
  }
});

// ---------------------------------------------------------------------------
// 8. POST /reviews/:restaurantId/generate-reply — AI-generate a review reply
// ---------------------------------------------------------------------------
router.post('/reviews/:restaurantId/generate-reply', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { reviewerName, starRating, reviewText, tone } = req.body;

    if (!reviewText) {
      return res.status(400).json({ success: false, error: 'Review text is required' });
    }

    const validTones = ['professional', 'warm', 'apologetic', 'enthusiastic'];
    const selectedTone = validTones.includes(tone) ? tone : 'professional';

    // Fetch restaurant name
    let restaurantName = 'our restaurant';
    try {
      const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      if (restaurantDoc.exists) {
        restaurantName = restaurantDoc.data().name || restaurantName;
      }
    } catch (_) { /* ignore */ }

    const toneInstructions = {
      professional: 'Use a professional, courteous, and businesslike tone.',
      warm: 'Use a warm, friendly, and personal tone that makes the reviewer feel valued.',
      apologetic: 'Use a sincere, empathetic, and apologetic tone. Acknowledge any issues and express genuine concern.',
      enthusiastic: 'Use an enthusiastic, upbeat, and grateful tone that shows genuine excitement.'
    };

    const aiPrompt = `Generate a reply to the following Google review for "${restaurantName}".

Review Details:
- Reviewer: ${reviewerName || 'Customer'}
- Rating: ${starRating || 'N/A'} out of 5 stars
- Review: "${reviewText}"

Instructions:
- ${toneInstructions[selectedTone]}
- Be natural and human — avoid sounding robotic or templated
- Address specific points mentioned in the review
- Keep the reply between 50-150 words
- Include the restaurant name naturally if appropriate
- If the rating is low (1-2 stars), acknowledge concerns and offer to make things right
- If the rating is high (4-5 stars), express gratitude and invite them back
- Do NOT start with "Dear" — use something more natural
- Return only the reply text, no additional formatting or quotation marks`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are an experienced restaurant manager who writes thoughtful, genuine replies to customer reviews. Your replies are always helpful, specific, and match the requested tone.'
        },
        {
          role: 'user',
          content: aiPrompt
        }
      ],
      temperature: 0.7,
      max_tokens: 250
    });

    const generatedReply = completion.choices[0].message.content.trim();

    res.json({
      success: true,
      reply: generatedReply,
      tone: selectedTone,
      message: 'Reply generated successfully'
    });
  } catch (error) {
    console.error('Error generating AI reply:', error);
    res.status(500).json({ success: false, error: 'Failed to generate reply' });
  }
});

// ===========================================================================
// Utility: Convert GBP star rating enum to number
// ===========================================================================
function ratingToNumber(starRating) {
  const map = {
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
    STAR_RATING_UNSPECIFIED: 0
  };
  if (typeof starRating === 'number') return starRating;
  return map[starRating] || 0;
}

module.exports = router;
