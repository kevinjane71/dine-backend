/**
 * Pure billing calculation functions extracted from index.js for testability.
 * These functions have ZERO side effects — no DB, no I/O.
 *
 * index.js should require and re-export these so there is a single source of truth.
 */

// ── Rounding ──────────────────────────────────────────────────────

function round2(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

// ── Tax Helpers ───────────────────────────────────────────────────

function getDefaultTaxSettings(restaurantData) {
  const currency = restaurantData?.currencySettings;
  const isIndia = !currency || currency.countryCode === 'IN' || currency.currencyCode === 'INR';
  if (isIndia) {
    return {
      enabled: true,
      taxes: [{ id: 'gst', name: 'GST', rate: 5, enabled: true, type: 'percentage' }],
      defaultTaxRate: 5
    };
  }
  return { enabled: false, taxes: [], defaultTaxRate: 0 };
}

function isItemTaxInclusive(item, taxSettings) {
  if (item.taxInclusive === true) return true;
  if (item.taxInclusive === false) return false;
  return taxSettings.taxInclusivePricing === true;
}

function resolveTaxesForItem(item, taxSettings, categories) {
  if (!taxSettings?.enabled) return [];
  const groups = taxSettings.taxGroups || [];
  const globalTaxes = (taxSettings.taxes && taxSettings.taxes.length > 0)
    ? taxSettings.taxes.filter(t => t.enabled)
    : (taxSettings.defaultTaxRate
      ? [{ name: 'Tax', rate: taxSettings.defaultTaxRate, type: 'percentage' }]
      : []);

  const resolveGroup = (group) => {
    const groupTaxes = group.taxes || [];
    if (group.alsoApplyGlobalTax && globalTaxes.length > 0) {
      const merged = [...groupTaxes];
      for (const gt of globalTaxes) {
        if (!merged.some(t => t.name === gt.name && t.rate === gt.rate)) merged.push(gt);
      }
      return merged;
    }
    return groupTaxes;
  };

  // Priority 1: Item-level tax group
  if (item.taxGroupId) {
    const group = groups.find(g => g.id === item.taxGroupId);
    if (group) return resolveGroup(group);
  }

  // Priority 2: Category-level tax group
  const catId = item.category || item.categoryId;
  if (catId && categories && categories.length > 0) {
    const cat = categories.find(c => c.id === catId || c.name === catId);
    if (cat?.taxGroupId) {
      const group = groups.find(g => g.id === cat.taxGroupId);
      if (group) return resolveGroup(group);
    }
  }

  // Priority 3: Restaurant default taxes (global)
  return globalTaxes;
}

// ── Per-Item Tax Calculation ──────────────────────────────────────

function calculatePerItemTax(orderItems, taxSettings, categories, totalDiscount, serviceChargeAmount) {
  const subtotal = orderItems.reduce((sum, item) => sum + (item.total || item.price * item.quantity), 0);

  const discountableSubtotal = orderItems.reduce((sum, item) => {
    if (item.discountApplicable === false) return sum;
    return sum + (item.total || item.price * item.quantity);
  }, 0);

  const taxTotals = {};
  let totalTaxAmount = 0;
  let inclusiveTaxAmount = 0;
  let exclusiveTaxAmount = 0;

  for (const item of orderItems) {
    const itemTotal = item.total || item.price * item.quantity;
    const isDiscountable = item.discountApplicable !== false;
    const isInclusive = isItemTaxInclusive(item, taxSettings);

    const itemDiscShare = (isDiscountable && discountableSubtotal > 0)
      ? (itemTotal / discountableSubtotal) * totalDiscount
      : 0;
    const itemTaxable = Math.max(0, itemTotal - itemDiscShare);

    const postDiscountSubtotal = Math.max(0, subtotal - totalDiscount);
    const itemSCShare = postDiscountSubtotal > 0
      ? (itemTaxable / postDiscountSubtotal) * (serviceChargeAmount || 0)
      : (subtotal > 0 ? (itemTotal / subtotal) * (serviceChargeAmount || 0) : 0);
    const itemTaxableWithSC = itemTaxable + itemSCShare;

    const itemTaxes = resolveTaxesForItem(item, taxSettings, categories);
    const totalRate = itemTaxes.reduce((sum, t) => sum + (t.rate || 0), 0);
    let itemTaxAmount = 0;

    for (const tax of itemTaxes) {
      const amt = isInclusive
        ? (itemTaxableWithSC * (tax.rate || 0) / (100 + totalRate))
        : (itemTaxableWithSC * (tax.rate || 0) / 100);
      const key = `${tax.name || 'Tax'}|${tax.rate || 0}|${isInclusive}`;
      if (!taxTotals[key]) taxTotals[key] = { name: tax.name || 'Tax', rate: tax.rate || 0, amount: 0, inclusive: isInclusive };
      taxTotals[key].amount += amt;
      itemTaxAmount += amt;
      totalTaxAmount += amt;
      if (isInclusive) inclusiveTaxAmount += amt;
      else exclusiveTaxAmount += amt;
    }

    item.itemTaxAmount = Math.round(itemTaxAmount * 100) / 100;
    item.taxInclusive = isInclusive;
    item.taxGroupId = item.taxGroupId || null;
  }

  const taxBreakdown = Object.values(taxTotals).map(t => ({
    ...t,
    amount: Math.round(t.amount * 100) / 100
  }));

  return {
    taxBreakdown,
    totalTaxAmount: Math.round(totalTaxAmount * 100) / 100,
    inclusiveTaxAmount: Math.round(inclusiveTaxAmount * 100) / 100,
    exclusiveTaxAmount: Math.round(exclusiveTaxAmount * 100) / 100,
  };
}

// ── Discount Stacking ─────────────────────────────────────────────

/**
 * Calculate stacked discounts in the correct order with proper capping.
 * Order: offer → manual → loyalty → coupon
 * Each layer is capped so total never exceeds subtotal.
 *
 * @param {number} subtotal - Order subtotal (items + zone surcharge, before discounts)
 * @param {number} offerDiscount - Discount from offers (already calculated)
 * @param {number} manualDiscount - Manual/staff discount amount
 * @param {number} loyaltyDiscount - Raw loyalty discount (before capping)
 * @param {number} couponDiscount - Raw coupon discount (before capping)
 * @param {object} loyaltySettings - { maxRedemptionPercent }
 * @returns {{ offerDiscount, manualDiscount, loyaltyDiscount, couponDiscount, totalDiscount }}
 */
function calculateStackedDiscounts(subtotal, offerDiscount = 0, manualDiscount = 0, loyaltyDiscount = 0, couponDiscount = 0, loyaltySettings = {}) {
  // 1. Cap offer discount at subtotal
  const cappedOffer = Math.min(Math.max(0, offerDiscount), subtotal);

  // 2. Cap manual discount at remaining
  const afterOffer = subtotal - cappedOffer;
  const cappedManual = Math.min(Math.max(0, manualDiscount), afterOffer);

  // 3. Cap loyalty discount at maxRedemptionPercent of remaining
  const afterManual = afterOffer - cappedManual;
  const maxRedemptionPercent = loyaltySettings.maxRedemptionPercent || 20;
  const maxLoyaltyByPercent = (afterManual * maxRedemptionPercent) / 100;
  const maxLoyalty = Math.min(maxLoyaltyByPercent, afterManual);
  const cappedLoyalty = Math.min(Math.max(0, loyaltyDiscount), maxLoyalty);

  // 4. Cap coupon discount at remaining
  const afterLoyalty = afterManual - cappedLoyalty;
  const cappedCoupon = Math.min(Math.max(0, couponDiscount), afterLoyalty);

  const totalDiscount = cappedOffer + cappedManual + cappedLoyalty + cappedCoupon;

  return {
    offerDiscount: round2(cappedOffer),
    manualDiscount: round2(cappedManual),
    loyaltyDiscount: round2(cappedLoyalty),
    couponDiscount: round2(cappedCoupon),
    totalDiscount: round2(totalDiscount)
  };
}

// ── Payment Validation ────────────────────────────────────────────

/**
 * Validate split payment amounts.
 * @param {Array} splitPayments - [{ method, amount }]
 * @param {number} grandTotal - Expected total
 * @returns {{ valid: boolean, error?: string }}
 */
function validateSplitPayments(splitPayments, grandTotal) {
  if (!Array.isArray(splitPayments) || splitPayments.length === 0) {
    return { valid: true };
  }

  for (let i = 0; i < splitPayments.length; i++) {
    const sp = splitPayments[i];
    const amt = parseFloat(sp.amount);
    if (isNaN(amt) || amt < 0) {
      return { valid: false, error: `Split payment #${i + 1} has invalid amount: ${sp.amount}` };
    }
    if (!sp.method) {
      return { valid: false, error: `Split payment #${i + 1} is missing payment method` };
    }
  }

  const splitTotal = round2(splitPayments.reduce((sum, sp) => sum + (parseFloat(sp.amount) || 0), 0));
  if (Math.abs(splitTotal - grandTotal) > 0.01) {
    return { valid: false, error: `Split payment total (${splitTotal}) does not match order total (${grandTotal})` };
  }

  return { valid: true };
}

/**
 * Validate cash tendered and change calculation.
 * @param {number} cashAmount - Cash given by customer
 * @param {number} grandTotal - Order total
 * @returns {{ valid: boolean, change?: number, error?: string }}
 */
function validateCashPayment(cashAmount, grandTotal) {
  const cash = parseFloat(cashAmount);
  if (isNaN(cash) || cash < 0) {
    return { valid: false, error: 'Cash amount must be a non-negative number' };
  }
  if (cash < grandTotal) {
    return { valid: false, error: `Cash amount (${cash}) is less than order total (${grandTotal})` };
  }
  return { valid: true, change: round2(cash - grandTotal) };
}

/**
 * Validate order item prices and quantities.
 * @param {Array} items - [{ name, price, quantity }]
 * @returns {{ valid: boolean, error?: string }}
 */
function validateOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { valid: false, error: 'Order must have at least one item' };
  }

  for (const item of items) {
    const price = parseFloat(item.price);
    if (isNaN(price) || price < 0) {
      return { valid: false, error: `Invalid price for item "${item.name || 'Unknown'}": must be a non-negative number` };
    }
    const qty = parseFloat(item.quantity);
    if (isNaN(qty) || qty <= 0) {
      return { valid: false, error: `Invalid quantity for item "${item.name || 'Unknown'}": must be a positive number` };
    }
  }

  return { valid: true };
}

// ── Invoice Totals (from invoiceService.js) ───────────────────────

function calculateInvoiceTotals(items = [], discountType = 'fixed', discountValue = 0, adjustments = 0) {
  let subtotal = 0;
  const taxMap = {};

  for (const item of items) {
    const quantity = parseFloat(item.quantity) || 0;
    const rate = parseFloat(item.rate) || 0;
    const lineAmount = quantity * rate;
    subtotal += lineAmount;

    const taxRate = parseFloat(item.taxRate) || 0;
    if (taxRate > 0) {
      if (!taxMap[taxRate]) {
        taxMap[taxRate] = { rate: taxRate, taxableAmount: 0, taxAmount: 0 };
      }
      taxMap[taxRate].taxableAmount += lineAmount;
    }
  }

  subtotal = round2(subtotal);

  let discountAmount = 0;
  if (discountType === 'percentage' && discountValue > 0) {
    discountAmount = round2((subtotal * discountValue) / 100);
  } else if (discountType === 'fixed' && discountValue > 0) {
    discountAmount = round2(Math.min(discountValue, subtotal));
  }

  const taxableAfterDiscount = subtotal - discountAmount;
  let taxAmount = 0;
  const taxBreakdown = [];

  for (const key of Object.keys(taxMap)) {
    const slab = taxMap[key];
    const proportion = subtotal > 0 ? slab.taxableAmount / subtotal : 0;
    const adjustedTaxable = taxableAfterDiscount * proportion;
    const slabTax = (adjustedTaxable * slab.rate) / 100;

    taxAmount += slabTax;
    taxBreakdown.push({
      rate: slab.rate,
      taxableAmount: round2(adjustedTaxable),
      taxAmount: round2(slabTax)
    });
  }

  taxAmount = round2(taxAmount);
  const total = round2(subtotal - discountAmount + taxAmount + (parseFloat(adjustments) || 0));

  return {
    subtotal,
    discountAmount,
    taxAmount,
    taxBreakdown,
    total: Math.max(0, total)
  };
}

module.exports = {
  round2,
  getDefaultTaxSettings,
  isItemTaxInclusive,
  resolveTaxesForItem,
  calculatePerItemTax,
  calculateStackedDiscounts,
  validateSplitPayments,
  validateCashPayment,
  validateOrderItems,
  calculateInvoiceTotals
};
