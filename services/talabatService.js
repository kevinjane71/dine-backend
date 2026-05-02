/**
 * Talabat Aggregator Integration Service
 *
 * Handles all communication with the Talabat Integration Platform API:
 * - OAuth2 authentication (client credentials)
 * - Order management (accept, reject, mark prepared)
 * - Menu/catalog sync (push menu, update availability)
 * - Store management (open/close)
 * - Data conversion (Talabat ↔ DineOpen formats)
 *
 * Talabat API docs: https://integration.talabat.com/en/documentation/
 * Delivery Hero POS docs: https://developers.deliveryhero.com/documentation/pos.html
 */

const crypto = require('crypto');

// ─── Constants ────────────────────────────────────────────────────────────────

const TALABAT_API_BASE = process.env.TALABAT_API_BASE_URL || 'https://api.integration.talabat.com';
const TALABAT_AUTH_URL = process.env.TALABAT_AUTH_URL || 'https://auth.integration.talabat.com';
const TOKEN_BUFFER_SECONDS = 60; // Refresh token 60s before expiry

// ─── Token Cache ──────────────────────────────────────────────────────────────

const tokenCache = new Map(); // key: vendorId → { accessToken, expiresAt }

// ─── Authentication ───────────────────────────────────────────────────────────

/**
 * Get an OAuth2 access token using client credentials flow.
 * Caches tokens per vendor until near-expiry.
 *
 * @param {Object} config - { vendorId, clientId, clientSecret }
 * @returns {string} access token
 */
async function getAccessToken(config) {
  const { vendorId, clientId, clientSecret } = config;
  const cacheKey = vendorId || clientId;

  // Check cache
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  // Request new token
  const response = await fetch(`${TALABAT_AUTH_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Talabat auth failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const accessToken = data.access_token;
  const expiresIn = data.expires_in || 3600; // Default 1 hour

  // Cache with buffer
  tokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + (expiresIn - TOKEN_BUFFER_SECONDS) * 1000,
  });

  return accessToken;
}

/**
 * Make an authenticated request to the Talabat API.
 *
 * @param {Object} config - { vendorId, clientId, clientSecret }
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. '/orders/123/accept')
 * @param {Object|null} body - Request body (JSON)
 * @returns {Object} Response data
 */
async function apiRequest(config, method, path, body = null) {
  const token = await getAccessToken(config);
  const url = `${TALABAT_API_BASE}${path}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  // Some endpoints return 204 No Content
  if (response.status === 204) {
    return { success: true };
  }

  const responseData = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`Talabat API error (${response.status}): ${JSON.stringify(responseData)}`);
    error.status = response.status;
    error.data = responseData;
    throw error;
  }

  return responseData;
}

// ─── Order Management ─────────────────────────────────────────────────────────

/**
 * Accept a Talabat order.
 * Called when staff accepts the order in KOT.
 */
async function acceptOrder(config, talabatOrderId) {
  return apiRequest(config, 'POST', `/orders/${talabatOrderId}/status`, {
    status: 'ACCEPTED',
  });
}

/**
 * Reject a Talabat order.
 * Called when staff rejects the order in KOT.
 */
async function rejectOrder(config, talabatOrderId, reason = '') {
  return apiRequest(config, 'POST', `/orders/${talabatOrderId}/status`, {
    status: 'REJECTED',
    reason: reason || 'Restaurant unable to fulfill order',
  });
}

/**
 * Mark a Talabat order as prepared / ready for pickup.
 * Called when kitchen marks the order as ready.
 */
async function markOrderPrepared(config, talabatOrderId) {
  return apiRequest(config, 'POST', `/orders/${talabatOrderId}/status`, {
    status: 'READY_FOR_PICKUP',
  });
}

/**
 * Get order details from Talabat.
 */
async function getOrderDetail(config, talabatOrderId) {
  return apiRequest(config, 'GET', `/orders/${talabatOrderId}`);
}

/**
 * Get recent order IDs (last 24 hours).
 */
async function getRecentOrderIds(config) {
  return apiRequest(config, 'GET', '/orders');
}

// ─── Menu / Catalog Management ────────────────────────────────────────────────

/**
 * Push the full menu catalog to Talabat.
 * This creates/updates/deletes items on the Talabat platform.
 *
 * @param {Object} config - Auth config
 * @param {Array} menuItems - DineOpen menu items
 * @param {Array} categories - DineOpen categories
 * @returns {Object} { jobId, status }
 */
async function pushMenuCatalog(config, menuItems, categories) {
  const catalog = convertMenuToTalabatCatalog(menuItems, categories);

  return apiRequest(config, 'PUT', `/vendors/${config.vendorId}/catalog`, {
    catalog,
  });
}

/**
 * Check the status of a catalog import job.
 */
async function getCatalogImportStatus(config, jobId) {
  return apiRequest(config, 'GET', `/vendors/${config.vendorId}/catalog/imports/${jobId}`);
}

/**
 * Update a single item's availability on Talabat.
 *
 * @param {Object} config - Auth config
 * @param {string} itemId - The item's ID on Talabat (mapped from DineOpen)
 * @param {boolean} available - true = available, false = unavailable
 */
async function updateItemAvailability(config, itemId, available) {
  return apiRequest(config, 'POST', `/vendors/${config.vendorId}/items/availability`, {
    items: [{ id: itemId, is_available: available }],
  });
}

/**
 * Get list of currently unavailable items.
 */
async function getUnavailableItems(config) {
  return apiRequest(config, 'GET', `/vendors/${config.vendorId}/items/unavailable`);
}

// ─── Store Management ─────────────────────────────────────────────────────────

/**
 * Update store open/close status on Talabat.
 *
 * @param {Object} config - Auth config
 * @param {boolean} isOpen - true = open, false = closed
 */
async function updateStoreStatus(config, isOpen) {
  return apiRequest(config, 'POST', `/vendors/${config.vendorId}/availability`, {
    is_available: isOpen,
  });
}

/**
 * Get current store status from Talabat.
 */
async function getStoreStatus(config) {
  return apiRequest(config, 'GET', `/vendors/${config.vendorId}/availability`);
}

// ─── Webhook Verification ─────────────────────────────────────────────────────

/**
 * Verify the HMAC signature of an incoming Talabat webhook.
 *
 * @param {Buffer|string} rawBody - Raw request body
 * @param {string} signature - Signature from webhook headers
 * @param {string} secret - Webhook secret for this vendor
 * @returns {boolean} true if signature is valid
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;

  const computed = crypto
    .createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? rawBody : rawBody.toString())
    .digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

// ─── Data Conversion: Talabat Order → DineOpen Order ──────────────────────────

/**
 * Convert a Talabat webhook order payload into a DineOpen order document.
 *
 * @param {Object} talabatOrder - The order from Talabat's webhook
 * @param {string} restaurantId - DineOpen restaurant ID
 * @param {Array} menuItems - Current DineOpen menu items (for ID mapping)
 * @param {boolean} autoAccept - Whether to auto-accept
 * @returns {Object} DineOpen order document (ready for Firestore)
 */
function convertTalabatOrderToDineOpen(talabatOrder, restaurantId, menuItems = [], autoAccept = false) {
  const now = new Date();
  const orderNumber = `TAL-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  // Build a lookup map: item name (lowercase) → DineOpen menu item
  const menuLookup = {};
  menuItems.forEach(item => {
    if (item.name) {
      menuLookup[item.name.toLowerCase()] = item;
    }
  });

  // Convert items
  const items = (talabatOrder.items || talabatOrder.products || []).map((tItem, idx) => {
    const itemName = tItem.name || tItem.product_name || `Item ${idx + 1}`;
    const matched = menuLookup[itemName.toLowerCase()];
    const quantity = tItem.quantity || 1;
    const unitPrice = parseFloat(tItem.unit_price || tItem.price || 0);
    const totalPrice = unitPrice * quantity;

    return {
      menuItemId: matched?.id || `talabat_${tItem.id || idx}`,
      name: itemName,
      price: unitPrice,
      quantity,
      total: totalPrice,
      category: matched?.category || tItem.category || 'Uncategorized',
      notes: tItem.special_instructions || tItem.notes || '',
      isVeg: matched?.isVeg ?? null,
      // Variants / modifiers from Talabat
      selectedVariant: tItem.option_groups?.[0] ? {
        name: tItem.option_groups[0].name,
        price: parseFloat(tItem.option_groups[0].price || 0),
      } : null,
      customizations: (tItem.modifier_groups || []).flatMap(mg =>
        (mg.items || mg.modifiers || []).map(m => ({
          name: m.name,
          price: parseFloat(m.price || 0),
        }))
      ),
    };
  });

  // Calculate totals
  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const deliveryFee = parseFloat(talabatOrder.delivery_fee || 0);
  const discount = parseFloat(talabatOrder.discount || talabatOrder.voucher_amount || 0);
  const totalAmount = parseFloat(talabatOrder.total || talabatOrder.total_amount || subtotal);
  const finalAmount = totalAmount;

  // Customer info
  const customer = talabatOrder.customer || talabatOrder.consumer || {};
  const customerInfo = {
    name: customer.name || customer.first_name || 'Talabat Customer',
    phone: customer.phone || customer.mobile || '',
    email: customer.email || '',
  };

  // Delivery address
  const address = talabatOrder.delivery_address || talabatOrder.address || {};
  const deliveryAddress = {
    line1: address.street || address.address_line1 || address.description || '',
    line2: address.area || address.address_line2 || '',
    city: address.city || '',
    landmark: address.landmark || address.building || '',
    latitude: address.latitude || null,
    longitude: address.longitude || null,
  };

  // Rider info
  const rider = talabatOrder.rider || talabatOrder.driver || {};
  const aggregatorRiderInfo = rider.name ? {
    name: rider.name,
    phone: rider.phone || '',
    eta: rider.eta || null,
  } : null;

  return {
    restaurantId,
    orderNumber,
    items,
    subtotal,
    discountAmount: discount,
    deliveryFee,
    taxAmount: parseFloat(talabatOrder.tax || talabatOrder.vat_amount || 0),
    totalAmount,
    finalAmount,
    customerInfo,
    deliveryAddress,
    orderType: 'delivery',
    orderSource: 'talabat',
    paymentMethod: 'aggregator',
    paymentStatus: 'paid', // Talabat collects payment
    status: autoAccept ? 'preparing' : 'pending',
    kotSent: false,
    notes: talabatOrder.special_instructions || talabatOrder.notes || '',
    // Aggregator-specific fields
    aggregatorOrderId: String(talabatOrder.id || talabatOrder.order_id || talabatOrder.code || ''),
    aggregatorPlatform: 'talabat',
    aggregatorStatus: autoAccept ? 'ACCEPTED' : 'RECEIVED',
    aggregatorRiderInfo,
    aggregatorDeliveryFee: deliveryFee,
    aggregatorDiscount: discount,
    aggregatorRawPayload: talabatOrder, // Store full payload for debugging
    // Timestamps
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Data Conversion: DineOpen Menu → Talabat Catalog ─────────────────────────

/**
 * Convert DineOpen menu items + categories into Talabat catalog format.
 *
 * @param {Array} menuItems - DineOpen menu items
 * @param {Array} categories - DineOpen categories [{name, sortOrder}]
 * @returns {Object} Talabat catalog JSON
 */
function convertMenuToTalabatCatalog(menuItems, categories = []) {
  // Group items by category
  const categoryMap = {};
  const activeItems = menuItems.filter(item =>
    item.isAvailable !== false && item.status !== 'inactive'
  );

  activeItems.forEach(item => {
    const cat = item.category || 'Uncategorized';
    if (!categoryMap[cat]) {
      categoryMap[cat] = [];
    }
    categoryMap[cat].push(item);
  });

  // Build Talabat catalog structure
  const talabatCategories = Object.entries(categoryMap).map(([catName, items], catIdx) => {
    const catDef = categories.find(c => c.name === catName);

    return {
      id: `cat_${catIdx}`,
      name: catName,
      sort_order: catDef?.sortOrder ?? catIdx,
      products: items.map((item, itemIdx) => {
        const product = {
          id: item.id || `item_${catIdx}_${itemIdx}`,
          name: item.name,
          description: item.description || '',
          price: parseFloat(item.deliveryPrice || item.price || item.basePrice || 0),
          is_available: item.isAvailable !== false,
          image_url: item.image || (item.images && item.images[0]) || '',
          sort_order: item.sortOrder ?? itemIdx,
          tags: [],
        };

        // Veg/NonVeg tag
        if (item.isVeg === true) product.tags.push('vegetarian');
        if (item.isVeg === false) product.tags.push('non-vegetarian');

        // Variants → option groups
        if (item.variants && item.variants.length > 0) {
          product.option_groups = [{
            id: `${product.id}_variants`,
            name: 'Size / Variant',
            min_selections: 1,
            max_selections: 1,
            options: item.variants.map((v, vIdx) => ({
              id: `${product.id}_var_${vIdx}`,
              name: v.name,
              price: parseFloat(v.price || 0),
              is_available: true,
            })),
          }];
        }

        // Customizations → modifier groups
        if (item.customizations && item.customizations.length > 0) {
          const modifierGroup = {
            id: `${product.id}_mods`,
            name: 'Add-ons',
            min_selections: 0,
            max_selections: item.customizations.length,
            modifiers: item.customizations.map((c, cIdx) => ({
              id: `${product.id}_mod_${cIdx}`,
              name: c.name,
              price: parseFloat(c.price || 0),
              is_available: true,
            })),
          };
          product.modifier_groups = [modifierGroup];
        }

        return product;
      }),
    };
  });

  return {
    categories: talabatCategories,
    metadata: {
      source: 'dineopen',
      exported_at: new Date().toISOString(),
      item_count: activeItems.length,
      category_count: talabatCategories.length,
    },
  };
}

// ─── Test Connection ──────────────────────────────────────────────────────────

/**
 * Test if the Talabat credentials are valid by attempting to fetch store status.
 *
 * @param {Object} config - { vendorId, clientId, clientSecret }
 * @returns {Object} { connected: boolean, storeStatus, error? }
 */
async function testConnection(config) {
  try {
    const token = await getAccessToken(config);
    if (!token) {
      return { connected: false, error: 'Failed to obtain access token' };
    }

    const status = await getStoreStatus(config);
    return {
      connected: true,
      storeStatus: status.is_available ? 'open' : 'closed',
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message || 'Connection test failed',
    };
  }
}

// ─── Clear Token Cache ────────────────────────────────────────────────────────

function clearTokenCache(vendorId) {
  if (vendorId) {
    tokenCache.delete(vendorId);
  } else {
    tokenCache.clear();
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Auth
  getAccessToken,
  testConnection,
  clearTokenCache,

  // Orders
  acceptOrder,
  rejectOrder,
  markOrderPrepared,
  getOrderDetail,
  getRecentOrderIds,

  // Menu / Catalog
  pushMenuCatalog,
  getCatalogImportStatus,
  updateItemAvailability,
  getUnavailableItems,

  // Store
  updateStoreStatus,
  getStoreStatus,

  // Webhook
  verifyWebhookSignature,

  // Conversion
  convertTalabatOrderToDineOpen,
  convertMenuToTalabatCatalog,
};
