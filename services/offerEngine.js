/**
 * Centralized Offer Engine (Phase 3)
 * Pure functions for schedule/date/audience validation and discount calculation.
 * Ported from dine-frontend/src/hooks/useOfferEngine.js and extended with:
 *   - audience targeting (all | groups | customers | first_order)
 *   - tiered discounts
 *   - cross-item BOGO (buy X get Y free, different items)
 *   - usageLimitPerCustomer enforcement helpers
 *   - priority-based tiebreaking in pickBestOffer
 *
 * Designed to be fully backward-compatible: a legacy offer doc (no new fields)
 * produces identical discount output to the prior inline logic.
 */

// ---------- helpers ----------

const normalizePhone = (phone) => {
  if (phone === null || phone === undefined || phone === '') return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length <= 10) return digits;
  return digits.slice(-10);
};

const getItemId = (item) => item.menuItemId || item.id;
const getItemCategory = (item) => (item.category || item.categoryId || '').toString();
const getItemLineTotal = (item) => item.total || (item.price || 0) * (item.quantity || 1);

// ---------- schedule & date validation ----------

const isScheduleValid = (offer, now = new Date()) => {
  if (!offer || !offer.schedule || offer.schedule.type !== 'recurring') return true;
  const currentDay = now.getDay();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const scheduleDays = offer.schedule.days || [];
  const startTime = offer.schedule.startTime || '00:00';
  const endTime = offer.schedule.endTime || '23:59';
  return scheduleDays.includes(currentDay) && currentTime >= startTime && currentTime <= endTime;
};

const isDateValid = (offer, now = new Date()) => {
  if (!offer) return false;
  if (offer.validFrom) {
    const from = new Date(offer.validFrom);
    if (now < from) return false;
  }
  if (offer.validUntil) {
    const until = new Date(offer.validUntil);
    until.setHours(23, 59, 59, 999);
    if (now > until) return false;
  }
  return true;
};

// ---------- audience matching ----------

const matchesAudience = (offer, context = {}) => {
  // Back-compat: legacy isFirstOrderOnly boolean maps to first_order audience
  const legacyFirstOrder = offer.isFirstOrderOnly === true;
  const audience = offer.audience || (legacyFirstOrder ? { type: 'first_order' } : { type: 'all' });

  const type = audience.type || 'all';

  if (type === 'all') return true;

  if (type === 'first_order') {
    return context.isFirstOrder === true;
  }

  if (type === 'groups') {
    const offerGroups = Array.isArray(audience.groupIds) ? audience.groupIds : [];
    if (offerGroups.length === 0) return false;
    const custGroups = Array.isArray(context.customerGroupIds) ? context.customerGroupIds : [];
    if (custGroups.length === 0) return false;
    return offerGroups.some(gid => custGroups.includes(gid));
  }

  if (type === 'customers') {
    const custIds = Array.isArray(audience.customerIds) ? audience.customerIds : [];
    const custPhones = Array.isArray(audience.customerPhones) ? audience.customerPhones.map(normalizePhone).filter(Boolean) : [];
    if (context.customerId && custIds.includes(context.customerId)) return true;
    const normPhone = normalizePhone(context.customerPhone);
    if (normPhone && custPhones.includes(normPhone)) return true;
    return false;
  }

  return true;
};

// ---------- tiered discount resolution ----------

// If tiers present, returns the matched tier (highest minSubtotal <= subtotal), else null.
const resolveTier = (offer, subtotal) => {
  if (!Array.isArray(offer.tiers) || offer.tiers.length === 0) return null;
  const sorted = [...offer.tiers]
    .filter(t => t && typeof t.minSubtotal === 'number')
    .sort((a, b) => a.minSubtotal - b.minSubtotal);
  let matched = null;
  for (const tier of sorted) {
    if (subtotal >= tier.minSubtotal) matched = tier;
  }
  return matched;
};

// ---------- cross-item BOGO ----------

// Calculates cross-item BOGO "Buy X get Y free" where X and Y are different items.
// Returns { discount, freeItems }.
const calculateCrossItemBogo = (offer, cart) => {
  const cfg = offer.crossItemBogo;
  if (!cfg || !cfg.enabled) return { discount: 0, freeItems: [] };

  const buyItemIds = Array.isArray(cfg.buyItemIds) ? cfg.buyItemIds : [];
  const buyCategoryIds = Array.isArray(cfg.buyCategoryIds) ? cfg.buyCategoryIds : [];
  const getItemIds = Array.isArray(cfg.getItemIds) ? cfg.getItemIds : [];
  const buyQty = Number(cfg.buyQty) || 1;
  const getQty = Number(cfg.getQty) || 1;
  const maxApps = cfg.maxApplications != null ? Number(cfg.maxApplications) : Infinity;

  if (buyQty <= 0 || getQty <= 0 || getItemIds.length === 0) {
    return { discount: 0, freeItems: [] };
  }

  // Count qualifying buy units
  let buyUnits = 0;
  for (const item of cart) {
    const id = getItemId(item);
    const cat = getItemCategory(item);
    const qty = item.quantity || 0;
    const matchById = buyItemIds.length > 0 && buyItemIds.includes(id);
    const matchByCat = buyCategoryIds.length > 0 && buyCategoryIds.includes(cat);
    if (matchById || matchByCat) buyUnits += qty;
  }

  const applications = Math.min(Math.floor(buyUnits / buyQty), maxApps);
  if (applications <= 0) return { discount: 0, freeItems: [] };

  // Build available "get" units pool (sorted by price asc — pick cheapest free units)
  const pool = [];
  for (const item of cart) {
    const id = getItemId(item);
    if (!getItemIds.includes(id)) continue;
    const qty = item.quantity || 0;
    const price = item.price || 0;
    for (let i = 0; i < qty; i++) pool.push({ itemId: id, price });
  }
  pool.sort((a, b) => a.price - b.price);

  const totalFreeUnitsWanted = applications * getQty;
  const taken = pool.slice(0, totalFreeUnitsWanted);
  if (taken.length === 0) return { discount: 0, freeItems: [] };

  // Aggregate taken back into {itemId, qty, unitPrice}
  const agg = new Map();
  let discount = 0;
  for (const u of taken) {
    discount += u.price;
    const key = `${u.itemId}:${u.price}`;
    if (!agg.has(key)) agg.set(key, { itemId: u.itemId, qty: 0, unitPrice: u.price });
    agg.get(key).qty += 1;
  }

  return {
    discount: Math.round(discount * 100) / 100,
    freeItems: Array.from(agg.values()),
  };
};

// ---------- core discount calculation ----------

const calculateDiscountForOffer = (offer, subtotal, cart = [], context = {}) => {
  if (!offer || subtotal <= 0) return { discount: 0, freeItems: [], appliedTier: null };

  const offerScope = offer.scope || 'order';
  let applicableSubtotal = subtotal;

  // Scope filtering (category / item) — identical to legacy logic
  if (offerScope === 'category' && Array.isArray(offer.targetCategories) && offer.targetCategories.length > 0) {
    const lowered = offer.targetCategories.map(c => String(c).toLowerCase());
    applicableSubtotal = cart
      .filter(item => lowered.includes(getItemCategory(item).toLowerCase()))
      .reduce((sum, item) => sum + getItemLineTotal(item), 0);
  } else if (offerScope === 'item' && Array.isArray(offer.targetItems) && offer.targetItems.length > 0) {
    applicableSubtotal = cart
      .filter(item => offer.targetItems.includes(getItemId(item)))
      .reduce((sum, item) => sum + getItemLineTotal(item), 0);
  }

  // Resolve tier (if any). When tiers match, tier overrides discountType/discountValue.
  // If offer has tiers defined but none match (subtotal below all tiers), discount is 0.
  const appliedTier = resolveTier(offer, subtotal);
  const hasTiers = Array.isArray(offer.tiers) && offer.tiers.length > 0;
  if (hasTiers && !appliedTier) return { discount: 0, freeItems: [], appliedTier: null };
  const effectiveDiscountType = appliedTier ? appliedTier.discountType : offer.discountType;
  const effectiveDiscountValue = appliedTier ? Number(appliedTier.discountValue) : (offer.discountValue || 0);

  let baseDiscount = 0;

  // Cross-item BOGO: when enabled, ONLY use free-item discount (no base discount)
  const cross = calculateCrossItemBogo(offer, cart);
  if (cross.discount > 0) {
    return { discount: cross.discount, freeItems: cross.freeItems, appliedTier };
  }

  // Legacy simple BOGO (same-item)
  if (offer.promotionType === 'bogo' && offer.bogoConfig) {
    const bogoItems = offerScope === 'item' && offer.targetItems?.length > 0
      ? cart.filter(item => offer.targetItems.includes(getItemId(item)))
      : cart;
    const totalQty = bogoItems.reduce((sum, item) => sum + (item.quantity || 1), 0);
    const buyQty = offer.bogoConfig.buyQty || 2;
    const getQty = offer.bogoConfig.getQty || 1;
    const getDiscount = offer.bogoConfig.getDiscount || 100;
    const sets = Math.floor(totalQty / (buyQty + getQty));
    if (sets > 0 && bogoItems.length > 0) {
      const cheapestPrice = Math.min(...bogoItems.map(item => item.price || 0));
      baseDiscount = Math.round(sets * getQty * cheapestPrice * (getDiscount / 100) * 100) / 100;
    }
  } else if (applicableSubtotal > 0) {
    if (effectiveDiscountType === 'percentage') {
      let disc = (applicableSubtotal * effectiveDiscountValue) / 100;
      if (offer.maxDiscount && disc > offer.maxDiscount) disc = offer.maxDiscount;
      baseDiscount = Math.round(disc * 100) / 100;
    } else {
      baseDiscount = Math.round(Math.min(effectiveDiscountValue, applicableSubtotal) * 100) / 100;
    }
  }

  const totalDiscount = baseDiscount;

  return {
    discount: totalDiscount,
    freeItems: cross.freeItems,
    appliedTier,
  };
};

// ---------- filter & pick ----------

const hasScopeMatchingCart = (offer, cart) => {
  const scope = offer.scope || 'order';
  if (scope === 'category' && Array.isArray(offer.targetCategories) && offer.targetCategories.length > 0) {
    const lowered = offer.targetCategories.map(c => String(c).toLowerCase());
    return cart.some(item => lowered.includes(getItemCategory(item).toLowerCase()));
  }
  if (scope === 'item' && Array.isArray(offer.targetItems) && offer.targetItems.length > 0) {
    return cart.some(item => offer.targetItems.includes(getItemId(item)));
  }
  return true;
};

const filterApplicableOffers = (offers, { subtotal, cart, context, now }) => {
  if (!Array.isArray(offers)) return [];
  const n = now || new Date();
  return offers.filter(offer => {
    if (!offer) return false;
    if (offer.isActive === false) return false;
    if (!isScheduleValid(offer, n)) return false;
    if (!isDateValid(offer, n)) return false;
    if (offer.minOrderValue && subtotal < offer.minOrderValue) return false;
    // Tiered offers: must meet at least the lowest tier's minSubtotal
    if (Array.isArray(offer.tiers) && offer.tiers.length > 0) {
      const lowestMin = Math.min(...offer.tiers.filter(t => t && typeof t.minSubtotal === 'number').map(t => t.minSubtotal));
      if (subtotal < lowestMin) return false;
    }
    if (!hasScopeMatchingCart(offer, cart)) return false;
    if (!matchesAudience(offer, context || {})) return false;
    return true;
  });
};

const pickBestOffer = (applicableOffers, subtotal, cart, context = {}) => {
  if (!Array.isArray(applicableOffers) || applicableOffers.length === 0) return null;
  let best = null;
  let bestDiscount = -1;
  for (const offer of applicableOffers) {
    const { discount } = calculateDiscountForOffer(offer, subtotal, cart, context);
    if (discount > bestDiscount) {
      best = offer;
      bestDiscount = discount;
    } else if (discount === bestDiscount && best) {
      // Tiebreak: higher priority first, then earlier createdAt
      const offerPrio = Number(offer.priority || 0);
      const bestPrio = Number(best.priority || 0);
      if (offerPrio > bestPrio) {
        best = offer;
      } else if (offerPrio === bestPrio) {
        const a = offer.createdAt ? new Date(offer.createdAt).getTime() : Infinity;
        const b = best.createdAt ? new Date(best.createdAt).getTime() : Infinity;
        if (a < b) best = offer;
      }
    }
  }
  return best;
};

// ---------- per-customer usage helpers ----------

const buildCustomerKey = (customerId, phone) => {
  if (customerId) return customerId;
  const n = normalizePhone(phone);
  return n ? `phone:${n}` : null;
};

const getCustomerUsageMap = async (db, offerIds, customerKey) => {
  const map = {};
  if (!db || !customerKey || !Array.isArray(offerIds) || offerIds.length === 0) return map;
  try {
    const reads = offerIds.map(oid =>
      db.collection('offers').doc(oid).collection('customerOfferUsage').doc(customerKey).get()
    );
    const snaps = await Promise.all(reads);
    snaps.forEach((snap, i) => {
      map[offerIds[i]] = snap.exists ? (snap.data().usageCount || 0) : 0;
    });
  } catch (err) {
    console.error('[offerEngine] getCustomerUsageMap error:', err);
  }
  return map;
};

const incrementUsage = async (db, offerId, customerKey) => {
  if (!db || !offerId || !customerKey) return;
  try {
    const ref = db.collection('offers').doc(offerId).collection('customerOfferUsage').doc(customerKey);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const nowIso = new Date().toISOString();
      if (snap.exists) {
        const data = snap.data();
        tx.update(ref, {
          usageCount: (data.usageCount || 0) + 1,
          lastUsedAt: nowIso,
        });
      } else {
        tx.set(ref, {
          usageCount: 1,
          firstUsedAt: nowIso,
          lastUsedAt: nowIso,
        });
      }
    });
  } catch (err) {
    console.error('[offerEngine] incrementUsage error:', err);
  }
};

module.exports = {
  normalizePhone,
  isScheduleValid,
  isDateValid,
  matchesAudience,
  calculateDiscountForOffer,
  filterApplicableOffers,
  pickBestOffer,
  buildCustomerKey,
  getCustomerUsageMap,
  incrementUsage,
};
