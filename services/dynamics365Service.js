/**
 * dynamics365Service.js — Microsoft Dynamics 365 Business Central API service.
 *
 * Pure functions, no Express/DB dependencies. Handles OAuth2 authentication,
 * BC API calls, and data conversion between DineOpen and BC formats.
 */

const crypto = require('crypto');

// ── Constants ──────────────────────────────────────────────────
const AZURE_AD_BASE = 'https://login.microsoftonline.com';
const BC_SCOPE = 'https://api.businesscentral.dynamics.com/.default';
const BC_API_VERSION = 'v2.0';
const TOKEN_BUFFER_SECONDS = 120;

// ── Token Cache ────────────────────────────────────────────────
const tokenCache = new Map(); // key: `${tenantId}_${clientId}` → { accessToken, expiresAt }

// ── Authentication ─────────────────────────────────────────────

/**
 * Get an OAuth2 access token using client credentials flow.
 * Caches tokens per tenant+client until near-expiry (with 120s buffer).
 *
 * @param {Object} config - { tenantId, clientId, clientSecret }
 * @returns {Promise<string>} access token
 */
async function getAccessToken(config) {
  const { tenantId, clientId, clientSecret } = config;
  const cacheKey = `${tenantId}_${clientId}`;

  // Check cache
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  // Request new token via URL-encoded form
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: BC_SCOPE,
  });

  const response = await fetch(`${AZURE_AD_BASE}/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dynamics 365 auth failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const accessToken = data.access_token;
  const expiresIn = data.expires_in || 3600;

  // Cache with buffer
  tokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + (expiresIn * 1000) - (TOKEN_BUFFER_SECONDS * 1000),
  });

  return accessToken;
}

// ── API Requests ───────────────────────────────────────────────

/**
 * Make an authenticated API request to a company-scoped Business Central endpoint.
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment, companyId }
 * @param {string} method - HTTP method (GET, POST, PATCH, DELETE)
 * @param {string} path - API path after /companies({companyId})
 * @param {Object|null} body - Request body (JSON)
 * @returns {Promise<Object>} Parsed JSON response
 */
async function apiRequest(config, method, path, body = null) {
  const token = await getAccessToken(config);
  const url = `https://${config.tenantId}.api.businesscentral.dynamics.com/${BC_API_VERSION}/${config.environment}/api/v2.0/companies(${config.companyId})${path}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  if (method === 'PATCH') {
    headers['If-Match'] = '*';
  }

  const options = { method, headers };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`BC API error (${response.status}): ${errorText}`);
    error.status = response.status;
    throw error;
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

/**
 * Make an authenticated API request to a root-level Business Central endpoint
 * (without /companies(companyId) prefix). Used for endpoints like /companies.
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment }
 * @param {string} method - HTTP method
 * @param {string} path - API path (e.g. '/companies')
 * @param {Object|null} body - Request body (JSON)
 * @returns {Promise<Object>} Parsed JSON response
 */
async function apiRequestRoot(config, method, path, body = null) {
  const token = await getAccessToken(config);
  const url = `https://${config.tenantId}.api.businesscentral.dynamics.com/${BC_API_VERSION}/${config.environment}/api/v2.0${path}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  if (method === 'PATCH') {
    headers['If-Match'] = '*';
  }

  const options = { method, headers };
  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`BC API error (${response.status}): ${errorText}`);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return { success: true };
  }

  return response.json();
}

// ── Connection & Discovery ─────────────────────────────────────

/**
 * Test connectivity to Business Central by authenticating and listing companies.
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment }
 * @returns {Promise<Object>} { connected: boolean, companies?: Array, error?: string }
 */
async function testConnection(config) {
  try {
    // Step 1: test auth
    try {
      await getAccessToken(config);
    } catch (authErr) {
      return { connected: false, error: `Authentication failed: ${authErr.message}` };
    }

    // Step 2: list companies
    const response = await apiRequestRoot(config, 'GET', '/companies');
    return {
      connected: true,
      companies: response.value.map(c => ({
        id: c.id,
        name: c.name,
        displayName: c.displayName,
      })),
    };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

/**
 * Get all companies available in the Business Central environment.
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment }
 * @returns {Promise<Array>} Array of company objects
 */
async function getCompanies(config) {
  const response = await apiRequestRoot(config, 'GET', '/companies');
  return response.value;
}

// ── Chart of Accounts ──────────────────────────────────────────

/**
 * Get all non-blocked GL accounts from Business Central.
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment, companyId }
 * @returns {Promise<Array>} Array of GL account objects
 */
async function getAccounts(config) {
  const response = await apiRequest(
    config,
    'GET',
    '/accounts?$select=id,number,displayName,category,subCategory,accountType,blocked&$filter=blocked eq false'
  );
  return response.value;
}

// ── General Journal Posting ────────────────────────────────────

/**
 * Post journal lines to a named general journal batch in Business Central.
 * Creates the batch if it does not already exist.
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment, companyId }
 * @param {string} journalBatchName - Name/code of the journal batch
 * @param {Array} lines - Array of journal line objects
 * @returns {Promise<Object>} { success, postedLines, totalLines, errors }
 */
async function postGeneralJournalBatch(config, journalBatchName, lines) {
  const errors = [];
  let postedLines = 0;

  // Step 1: Find or create the journal batch
  let batchId;
  try {
    const batchResponse = await apiRequest(
      config,
      'GET',
      `/generalJournalBatches?$filter=code eq '${journalBatchName}'`
    );

    if (batchResponse.value && batchResponse.value.length > 0) {
      batchId = batchResponse.value[0].id;
    } else {
      // Create the batch
      const createResponse = await apiRequest(config, 'POST', '/generalJournalBatches', {
        code: journalBatchName,
        displayName: journalBatchName,
      });
      batchId = createResponse.id;
    }
  } catch (err) {
    return {
      success: false,
      postedLines: 0,
      totalLines: lines.length,
      errors: [{ step: 'getBatch', message: err.message }],
    };
  }

  // Step 2: Post each journal line
  for (let i = 0; i < lines.length; i++) {
    try {
      await apiRequest(
        config,
        'POST',
        `/generalJournalBatches(${batchId})/generalJournalLines`,
        lines[i]
      );
      postedLines++;
    } catch (err) {
      errors.push({ lineIndex: i, message: err.message, line: lines[i] });
    }
  }

  return {
    success: errors.length === 0,
    postedLines,
    totalLines: lines.length,
    errors,
  };
}

// ── Item Sync ──────────────────────────────────────────────────

/**
 * Sync items between DineOpen and Business Central.
 * - direction 'push': push DineOpen menu items to BC (create or update)
 * - direction 'pull': pull items from BC and convert to DineOpen format
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment, companyId }
 * @param {string} direction - 'push' or 'pull'
 * @param {Array} dineMenuItems - DineOpen menu items (used for 'push')
 * @returns {Promise<Object>} { synced, created, updated, pulled, items, errors }
 */
async function syncItems(config, direction, dineMenuItems = []) {
  const errors = [];
  let created = 0;
  let updated = 0;

  if (direction === 'push') {
    for (const menuItem of dineMenuItems) {
      const bcItem = convertMenuItemToBCItem(menuItem);

      try {
        // Check if item already exists by number
        const existing = await apiRequest(
          config,
          'GET',
          `/items?$filter=number eq '${bcItem.number}'`
        );

        if (existing.value && existing.value.length > 0) {
          // Update existing
          await apiRequest(config, 'PATCH', `/items(${existing.value[0].id})`, bcItem);
          updated++;
        } else {
          // Create new
          await apiRequest(config, 'POST', '/items', bcItem);
          created++;
        }
      } catch (err) {
        errors.push({ item: menuItem.name || menuItem.id, message: err.message });
      }
    }

    return {
      synced: created + updated,
      created,
      updated,
      pulled: 0,
      items: [],
      errors,
    };
  }

  if (direction === 'pull') {
    try {
      const response = await apiRequest(
        config,
        'GET',
        '/items?$select=id,number,displayName,unitPrice,type,blocked,itemCategoryCode'
      );

      const items = (response.value || []).map(convertBCItemToMenuItem);

      return {
        synced: items.length,
        created: 0,
        updated: 0,
        pulled: items.length,
        items,
        errors: [],
      };
    } catch (err) {
      return {
        synced: 0,
        created: 0,
        updated: 0,
        pulled: 0,
        items: [],
        errors: [{ message: err.message }],
      };
    }
  }

  return { synced: 0, created: 0, updated: 0, pulled: 0, items: [], errors: [{ message: `Unknown direction: ${direction}` }] };
}

// ── Customer Sync ──────────────────────────────────────────────

/**
 * Sync DineOpen customers to Business Central.
 * Matches existing customers by phone or email; creates new ones if not found.
 *
 * @param {Object} config - { tenantId, clientId, clientSecret, environment, companyId }
 * @param {Array} dineCustomers - Array of DineOpen customer objects
 * @returns {Promise<Object>} { synced, created, updated, errors }
 */
async function syncCustomers(config, dineCustomers) {
  const errors = [];
  let created = 0;
  let updated = 0;

  for (const customer of dineCustomers) {
    const bcCustomer = convertCustomerToBCCustomer(customer);

    try {
      // Try to find existing by phone or email
      let filterParts = [];
      if (customer.phone) {
        filterParts.push(`phoneNumber eq '${customer.phone}'`);
      }
      if (customer.email) {
        filterParts.push(`email eq '${customer.email}'`);
      }

      let existingCustomer = null;

      if (filterParts.length > 0) {
        const filterQuery = filterParts.join(' or ');
        const existing = await apiRequest(
          config,
          'GET',
          `/customers?$filter=${encodeURIComponent(filterQuery)}`
        );
        if (existing.value && existing.value.length > 0) {
          existingCustomer = existing.value[0];
        }
      }

      if (existingCustomer) {
        await apiRequest(config, 'PATCH', `/customers(${existingCustomer.id})`, bcCustomer);
        updated++;
      } else {
        await apiRequest(config, 'POST', '/customers', bcCustomer);
        created++;
      }
    } catch (err) {
      errors.push({ customer: customer.name || customer.id, message: err.message });
    }
  }

  return {
    synced: created + updated,
    created,
    updated,
    errors,
  };
}

// ── Data Conversion: Daily Stats → Journal Lines ───────────────

/**
 * Convert DineOpen daily stats into BC general journal lines for accounting.
 * Creates debit lines for payment methods and credit lines for revenue/tax.
 *
 * @param {Object} dailyStats - DineOpen daily stats object
 * @param {Object} glMapping - GL account mapping { cashAccount, cardAccount, onlinePaymentAccount, salesRevenue, taxPayable, discountExpense }
 * @param {string} documentPrefix - Prefix for document number (default: 'DINE')
 * @returns {Array} Array of journal line objects
 */
function convertDailyStatsToJournalLines(dailyStats, glMapping, documentPrefix = 'DINE') {
  const documentNumber = `${documentPrefix}-${dailyStats.date.replace(/-/g, '')}`;
  const postingDate = dailyStats.date;
  const description = `DineOpen Daily Sales - ${dailyStats.date}`;

  const paymentMethod = dailyStats.paymentMethod || {};
  const cash = parseFloat(paymentMethod.cash || 0);
  const card = parseFloat(paymentMethod.card || 0);
  const upi = parseFloat(paymentMethod.upi || 0);
  const online = parseFloat(paymentMethod.online || 0);
  const totalRevenue = parseFloat(dailyStats.totalRevenue || 0);
  const totalTax = parseFloat(dailyStats.totalTax || 0);
  const totalDiscounts = parseFloat(dailyStats.totalDiscounts || 0);

  const lines = [];

  // Debit: Cash received
  if (cash > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.cashAccount,
      postingDate,
      documentNumber,
      description,
      amount: cash,
    });
  }

  // Debit: Card + UPI received
  if (card + upi > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.cardAccount,
      postingDate,
      documentNumber,
      description,
      amount: card + upi,
    });
  }

  // Debit: Online payments received
  if (online > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.onlinePaymentAccount,
      postingDate,
      documentNumber,
      description,
      amount: online,
    });
  }

  // Credit: Sales revenue (negative = credit)
  const revenueExTax = totalRevenue - totalTax;
  if (revenueExTax > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.salesRevenue,
      postingDate,
      documentNumber,
      description,
      amount: -revenueExTax,
    });
  }

  // Credit: Tax payable (negative = credit)
  if (totalTax > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.taxPayable,
      postingDate,
      documentNumber,
      description,
      amount: -totalTax,
    });
  }

  // Debit: Discounts given
  if (totalDiscounts > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.discountExpense,
      postingDate,
      documentNumber,
      description,
      amount: totalDiscounts,
    });
  }

  // Filter out any lines with 0 amount
  return lines.filter(line => line.amount !== 0);
}

// ── Data Conversion: Order → Journal Lines ─────────────────────

/**
 * Convert a single DineOpen order into BC general journal lines.
 *
 * @param {Object} order - DineOpen order object
 * @param {Object} glMapping - GL account mapping
 * @param {string} documentPrefix - Prefix for document number (default: 'DINE-ORD')
 * @returns {Array} Array of journal line objects
 */
function convertOrderToJournalLines(order, glMapping, documentPrefix = 'DINE-ORD') {
  const orderId = order.dailyOrderId || order.orderNumber || (order.id ? order.id.substring(0, 8) : 'UNKNOWN');
  const documentNumber = `${documentPrefix}-${orderId}`;
  const postingDate = order.date || order.createdAt?.toISOString?.()?.substring(0, 10) || new Date().toISOString().substring(0, 10);
  const description = `DineOpen Order - ${orderId}`;

  const totalAmount = parseFloat(order.totalAmount || order.finalAmount || 0);
  const taxAmount = parseFloat(order.taxAmount || 0);
  const discountAmount = parseFloat(order.discountAmount || 0);
  const revenueExTax = totalAmount - taxAmount;

  const lines = [];

  // Debit: Payment received (based on payment method)
  const paymentMethod = (order.paymentMethod || '').toLowerCase();
  let paymentAccount;

  if (paymentMethod === 'cash') {
    paymentAccount = glMapping.cashAccount;
  } else if (paymentMethod === 'card' || paymentMethod === 'upi') {
    paymentAccount = glMapping.cardAccount;
  } else if (paymentMethod === 'online' || paymentMethod === 'aggregator') {
    paymentAccount = glMapping.onlinePaymentAccount;
  } else {
    paymentAccount = glMapping.cashAccount; // Default to cash
  }

  if (totalAmount > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: paymentAccount,
      postingDate,
      documentNumber,
      description,
      amount: totalAmount,
    });
  }

  // Credit: Revenue (negative = credit)
  if (revenueExTax > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.salesRevenue,
      postingDate,
      documentNumber,
      description,
      amount: -revenueExTax,
    });
  }

  // Credit: Tax (negative = credit)
  if (taxAmount > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.taxPayable,
      postingDate,
      documentNumber,
      description,
      amount: -taxAmount,
    });
  }

  // Debit: Discount
  if (discountAmount > 0) {
    lines.push({
      accountType: 'G/L Account',
      accountNumber: glMapping.discountExpense,
      postingDate,
      documentNumber,
      description,
      amount: discountAmount,
    });
  }

  // Filter out any lines with 0 amount
  return lines.filter(line => line.amount !== 0);
}

// ── Data Conversion: Menu Item ↔ BC Item ───────────────────────

/**
 * Convert a DineOpen menu item to a Business Central item.
 *
 * @param {Object} menuItem - DineOpen menu item
 * @returns {Object} BC item object
 */
function convertMenuItemToBCItem(menuItem) {
  return {
    number: menuItem.shortCode || (menuItem.id ? menuItem.id.substring(0, 20) : ''),
    displayName: menuItem.name || '',
    unitPrice: parseFloat(menuItem.price || 0),
    type: 'Inventory',
    itemCategoryCode: menuItem.category || '',
  };
}

/**
 * Convert a Business Central item to a DineOpen menu item shape.
 *
 * @param {Object} bcItem - BC item object
 * @returns {Object} DineOpen menu item shape
 */
function convertBCItemToMenuItem(bcItem) {
  return {
    bcId: bcItem.id,
    name: bcItem.displayName || '',
    shortCode: bcItem.number || '',
    price: parseFloat(bcItem.unitPrice || 0),
    category: bcItem.itemCategoryCode || '',
    type: bcItem.type || '',
    blocked: bcItem.blocked || false,
  };
}

// ── Data Conversion: Customer ──────────────────────────────────

/**
 * Convert a DineOpen customer to a Business Central customer.
 *
 * @param {Object} customer - DineOpen customer object
 * @returns {Object} BC customer object
 */
function convertCustomerToBCCustomer(customer) {
  return {
    displayName: customer.name || '',
    phoneNumber: customer.phone || '',
    email: customer.email || '',
    type: customer.isCompany ? 'Company' : 'Person',
  };
}

// ── Cache Management ───────────────────────────────────────────

/**
 * Clear cached access tokens for a given tenant. If no tenantId is provided,
 * all cached tokens are cleared.
 *
 * @param {string} [tenantId] - Azure AD tenant ID to clear tokens for
 */
function clearTokenCache(tenantId) {
  if (tenantId) {
    for (const key of tokenCache.keys()) {
      if (key.startsWith(`${tenantId}_`)) {
        tokenCache.delete(key);
      }
    }
  } else {
    tokenCache.clear();
  }
}

// ── Exports ────────────────────────────────────────────────────

module.exports = {
  getAccessToken,
  testConnection,
  clearTokenCache,
  getCompanies,
  getAccounts,
  postGeneralJournalBatch,
  syncItems,
  syncCustomers,
  convertDailyStatsToJournalLines,
  convertOrderToJournalLines,
  convertMenuItemToBCItem,
  convertBCItemToMenuItem,
  convertCustomerToBCCustomer,
};
