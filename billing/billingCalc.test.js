const {
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
} = require('./billingCalc');

// ═══════════════════════════════════════════════════════════════════
// round2
// ═══════════════════════════════════════════════════════════════════

describe('round2', () => {
  test('rounds to 2 decimal places', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(1.004)).toBe(1);
    expect(round2(100.456)).toBe(100.46);
  });

  test('handles 0 and negatives', () => {
    expect(round2(0)).toBe(0);
    expect(round2(-1.005)).toBe(-1);
    expect(round2(-1.006)).toBe(-1.01);
  });

  test('handles already-rounded values', () => {
    expect(round2(10)).toBe(10);
    expect(round2(10.5)).toBe(10.5);
    expect(round2(10.55)).toBe(10.55);
  });
});

// ═══════════════════════════════════════════════════════════════════
// getDefaultTaxSettings
// ═══════════════════════════════════════════════════════════════════

describe('getDefaultTaxSettings', () => {
  test('defaults to Indian GST when no currency', () => {
    const settings = getDefaultTaxSettings({});
    expect(settings.enabled).toBe(true);
    expect(settings.defaultTaxRate).toBe(5);
    expect(settings.taxes[0].name).toBe('GST');
  });

  test('defaults to Indian GST for INR', () => {
    const settings = getDefaultTaxSettings({ currencySettings: { countryCode: 'IN', currencyCode: 'INR' } });
    expect(settings.enabled).toBe(true);
    expect(settings.defaultTaxRate).toBe(5);
  });

  test('returns disabled taxes for non-Indian currencies', () => {
    const settings = getDefaultTaxSettings({ currencySettings: { countryCode: 'US', currencyCode: 'USD' } });
    expect(settings.enabled).toBe(false);
    expect(settings.taxes).toHaveLength(0);
  });

  test('handles null/undefined restaurantData', () => {
    expect(getDefaultTaxSettings(null).enabled).toBe(true); // defaults to India
    expect(getDefaultTaxSettings(undefined).enabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// isItemTaxInclusive
// ═══════════════════════════════════════════════════════════════════

describe('isItemTaxInclusive', () => {
  test('item-level true overrides settings', () => {
    expect(isItemTaxInclusive({ taxInclusive: true }, { taxInclusivePricing: false })).toBe(true);
  });

  test('item-level false overrides settings', () => {
    expect(isItemTaxInclusive({ taxInclusive: false }, { taxInclusivePricing: true })).toBe(false);
  });

  test('falls back to settings when item has no override', () => {
    expect(isItemTaxInclusive({}, { taxInclusivePricing: true })).toBe(true);
    expect(isItemTaxInclusive({}, { taxInclusivePricing: false })).toBe(false);
    expect(isItemTaxInclusive({}, {})).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// resolveTaxesForItem
// ═══════════════════════════════════════════════════════════════════

describe('resolveTaxesForItem', () => {
  const globalTaxSettings = {
    enabled: true,
    taxes: [{ name: 'GST', rate: 5, enabled: true }],
    taxGroups: [
      { id: 'beverage-tax', taxes: [{ name: 'Beverage GST', rate: 12 }] },
      { id: 'alcohol-tax', taxes: [{ name: 'Excise', rate: 20 }], alsoApplyGlobalTax: true }
    ]
  };

  test('returns empty when tax disabled', () => {
    expect(resolveTaxesForItem({}, { enabled: false }, [])).toEqual([]);
  });

  test('returns global taxes by default', () => {
    const taxes = resolveTaxesForItem({}, globalTaxSettings, []);
    expect(taxes).toHaveLength(1);
    expect(taxes[0].name).toBe('GST');
    expect(taxes[0].rate).toBe(5);
  });

  test('item-level taxGroupId takes priority', () => {
    const taxes = resolveTaxesForItem({ taxGroupId: 'beverage-tax' }, globalTaxSettings, []);
    expect(taxes).toHaveLength(1);
    expect(taxes[0].name).toBe('Beverage GST');
    expect(taxes[0].rate).toBe(12);
  });

  test('alsoApplyGlobalTax merges group + global taxes', () => {
    const taxes = resolveTaxesForItem({ taxGroupId: 'alcohol-tax' }, globalTaxSettings, []);
    expect(taxes).toHaveLength(2);
    expect(taxes.find(t => t.name === 'Excise').rate).toBe(20);
    expect(taxes.find(t => t.name === 'GST').rate).toBe(5);
  });

  test('category-level taxGroupId used when no item-level', () => {
    const categories = [{ id: 'cat1', name: 'Beverages', taxGroupId: 'beverage-tax' }];
    const taxes = resolveTaxesForItem({ category: 'cat1' }, globalTaxSettings, categories);
    expect(taxes).toHaveLength(1);
    expect(taxes[0].name).toBe('Beverage GST');
  });

  test('falls back to defaultTaxRate when no taxes array', () => {
    const settings = { enabled: true, taxes: [], defaultTaxRate: 18 };
    const taxes = resolveTaxesForItem({}, settings, []);
    expect(taxes).toHaveLength(1);
    expect(taxes[0].rate).toBe(18);
  });

  test('filters disabled global taxes', () => {
    const settings = {
      enabled: true,
      taxes: [
        { name: 'GST', rate: 5, enabled: true },
        { name: 'Cess', rate: 1, enabled: false }
      ]
    };
    const taxes = resolveTaxesForItem({}, settings, []);
    expect(taxes).toHaveLength(1);
    expect(taxes[0].name).toBe('GST');
  });
});

// ═══════════════════════════════════════════════════════════════════
// calculatePerItemTax — Exclusive Tax
// ═══════════════════════════════════════════════════════════════════

describe('calculatePerItemTax — exclusive tax', () => {
  const taxSettings = {
    enabled: true,
    taxes: [{ name: 'GST', rate: 5, enabled: true }],
    taxInclusivePricing: false
  };

  test('basic exclusive tax on single item', () => {
    const items = [{ name: 'Burger', price: 200, quantity: 2 }];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    // Subtotal = 400, Tax = 400 * 5% = 20
    expect(result.totalTaxAmount).toBe(20);
    expect(result.exclusiveTaxAmount).toBe(20);
    expect(result.inclusiveTaxAmount).toBe(0);
    expect(result.taxBreakdown).toHaveLength(1);
    expect(result.taxBreakdown[0].amount).toBe(20);
  });

  test('multiple items with same tax rate', () => {
    const items = [
      { name: 'Burger', price: 200, quantity: 1 },
      { name: 'Fries', price: 100, quantity: 1 }
    ];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    // Subtotal = 300, Tax = 300 * 5% = 15
    expect(result.totalTaxAmount).toBe(15);
  });

  test('tax after discount is applied proportionally', () => {
    const items = [
      { name: 'Burger', price: 200, quantity: 1 },
      { name: 'Fries', price: 100, quantity: 1 }
    ];
    const result = calculatePerItemTax(items, taxSettings, [], 30, 0); // 30 discount
    // Subtotal = 300, After discount = 270, Tax = 270 * 5% = 13.5
    expect(result.totalTaxAmount).toBe(13.5);
  });

  test('discount only applies to discountable items', () => {
    const items = [
      { name: 'Burger', price: 200, quantity: 1, discountApplicable: true },
      { name: 'Packing', price: 50, quantity: 1, discountApplicable: false }
    ];
    const result = calculatePerItemTax(items, taxSettings, [], 100, 0);
    // Discountable subtotal = 200, Burger gets full 100 discount → taxable = 100
    // Packing gets 0 discount → taxable = 50
    // Tax = (100 + 50) * 5% = 7.5
    expect(result.totalTaxAmount).toBe(7.5);
  });

  test('service charge is distributed proportionally and taxed', () => {
    const items = [{ name: 'Burger', price: 1000, quantity: 1 }];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 100); // 100 SC
    // Taxable with SC = 1000 + 100 = 1100, Tax = 1100 * 5% = 55
    expect(result.totalTaxAmount).toBe(55);
  });

  test('zero subtotal produces zero tax', () => {
    const items = [{ name: 'Free Item', price: 0, quantity: 1 }];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    expect(result.totalTaxAmount).toBe(0);
    // Breakdown may still contain an entry with amount 0 (GST slab exists but taxable is 0)
    expect(result.taxBreakdown.every(b => b.amount === 0)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// calculatePerItemTax — Inclusive Tax
// ═══════════════════════════════════════════════════════════════════

describe('calculatePerItemTax — inclusive tax', () => {
  const taxSettings = {
    enabled: true,
    taxes: [{ name: 'GST', rate: 5, enabled: true }],
    taxInclusivePricing: true
  };

  test('back-calculates inclusive tax correctly', () => {
    const items = [{ name: 'Burger', price: 105, quantity: 1 }];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    // Inclusive: tax = 105 * 5 / 105 = 5
    expect(result.totalTaxAmount).toBe(5);
    expect(result.inclusiveTaxAmount).toBe(5);
    expect(result.exclusiveTaxAmount).toBe(0);
  });

  test('inclusive tax with discount', () => {
    const items = [{ name: 'Burger', price: 105, quantity: 2 }]; // total = 210
    const result = calculatePerItemTax(items, taxSettings, [], 10.5, 0); // 10.5 discount
    // Taxable = 210 - 10.5 = 199.5
    // Tax = 199.5 * 5 / 105 = 9.5
    expect(result.totalTaxAmount).toBe(9.5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// calculatePerItemTax — Mixed Tax (item overrides)
// ═══════════════════════════════════════════════════════════════════

describe('calculatePerItemTax — mixed inclusive/exclusive', () => {
  const taxSettings = {
    enabled: true,
    taxes: [{ name: 'GST', rate: 5, enabled: true }],
    taxInclusivePricing: false // default exclusive
  };

  test('item-level inclusive override works alongside exclusive items', () => {
    const items = [
      { name: 'Burger', price: 200, quantity: 1, taxInclusive: false },  // exclusive
      { name: 'Drink', price: 105, quantity: 1, taxInclusive: true }     // inclusive
    ];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    // Burger: 200 * 5% = 10 (exclusive)
    // Drink: 105 * 5/105 = 5 (inclusive)
    expect(result.exclusiveTaxAmount).toBe(10);
    expect(result.inclusiveTaxAmount).toBe(5);
    expect(result.totalTaxAmount).toBe(15);
    expect(result.taxBreakdown).toHaveLength(2); // separate keys for inclusive vs exclusive
  });
});

// ═══════════════════════════════════════════════════════════════════
// calculatePerItemTax — Tax Groups
// ═══════════════════════════════════════════════════════════════════

describe('calculatePerItemTax — tax groups', () => {
  const taxSettings = {
    enabled: true,
    taxes: [{ name: 'GST', rate: 5, enabled: true }],
    taxGroups: [
      { id: 'bev-tax', taxes: [{ name: 'Beverage GST', rate: 12 }] }
    ],
    taxInclusivePricing: false
  };

  test('items with taxGroupId use group rate, others use global', () => {
    const items = [
      { name: 'Burger', price: 100, quantity: 1 },                     // global 5%
      { name: 'Soda', price: 50, quantity: 1, taxGroupId: 'bev-tax' }  // group 12%
    ];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    // Burger: 100 * 5% = 5
    // Soda: 50 * 12% = 6
    expect(result.totalTaxAmount).toBe(11);
    expect(result.taxBreakdown).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// calculatePerItemTax — Rounding consistency
// ═══════════════════════════════════════════════════════════════════

describe('calculatePerItemTax — rounding', () => {
  const taxSettings = {
    enabled: true,
    taxes: [{ name: 'GST', rate: 18, enabled: true }],
    taxInclusivePricing: false
  };

  test('many small items accumulate correctly without per-item rounding drift', () => {
    // 7 items at 33 each = 231 subtotal
    // 18% of 231 = 41.58
    const items = Array.from({ length: 7 }, (_, i) => ({
      name: `Item ${i}`, price: 33, quantity: 1
    }));
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    expect(result.totalTaxAmount).toBe(41.58);
  });

  test('tax with fractional amounts rounds final total correctly', () => {
    const items = [{ name: 'Item', price: 333, quantity: 3 }];
    const result = calculatePerItemTax(items, taxSettings, [], 0, 0);
    // 999 * 18% = 179.82
    expect(result.totalTaxAmount).toBe(179.82);
  });
});

// ═══════════════════════════════════════════════════════════════════
// calculateStackedDiscounts
// ═══════════════════════════════════════════════════════════════════

describe('calculateStackedDiscounts', () => {
  test('basic stacking: each layer capped correctly', () => {
    const result = calculateStackedDiscounts(1000, 200, 100, 50, 30);
    expect(result.offerDiscount).toBe(200);
    expect(result.manualDiscount).toBe(100);
    // Remaining after offer+manual = 700, loyalty capped at 20% of 700 = 140, so 50 is fine
    expect(result.loyaltyDiscount).toBe(50);
    expect(result.couponDiscount).toBe(30);
    expect(result.totalDiscount).toBe(380);
  });

  test('offer discount capped at subtotal', () => {
    const result = calculateStackedDiscounts(100, 200, 0, 0, 0);
    expect(result.offerDiscount).toBe(100);
    expect(result.totalDiscount).toBe(100);
  });

  test('manual discount capped at remaining after offer', () => {
    const result = calculateStackedDiscounts(100, 80, 50, 0, 0);
    expect(result.offerDiscount).toBe(80);
    expect(result.manualDiscount).toBe(20); // only 20 remaining
    expect(result.totalDiscount).toBe(100);
  });

  test('loyalty discount capped at maxRedemptionPercent of remaining', () => {
    const result = calculateStackedDiscounts(1000, 0, 0, 500, 0, { maxRedemptionPercent: 20 });
    // 20% of 1000 = 200
    expect(result.loyaltyDiscount).toBe(200);
    expect(result.totalDiscount).toBe(200);
  });

  test('loyalty with higher maxRedemptionPercent', () => {
    const result = calculateStackedDiscounts(1000, 0, 0, 500, 0, { maxRedemptionPercent: 100 });
    expect(result.loyaltyDiscount).toBe(500);
  });

  test('coupon capped at remaining after all prior discounts', () => {
    const result = calculateStackedDiscounts(1000, 500, 300, 100, 500, { maxRedemptionPercent: 100 });
    // After offer(500) + manual(300) = 200 remaining
    // Loyalty: min(100, 100% of 200) = 100 → remaining = 100
    // Coupon: min(500, 100) = 100
    expect(result.couponDiscount).toBe(100);
    expect(result.totalDiscount).toBe(1000);
  });

  test('total never exceeds subtotal', () => {
    const result = calculateStackedDiscounts(500, 999, 999, 999, 999, { maxRedemptionPercent: 100 });
    expect(result.totalDiscount).toBe(500);
  });

  test('negative discounts are treated as zero', () => {
    const result = calculateStackedDiscounts(1000, -50, -20, -10, -5);
    expect(result.offerDiscount).toBe(0);
    expect(result.manualDiscount).toBe(0);
    expect(result.loyaltyDiscount).toBe(0);
    expect(result.couponDiscount).toBe(0);
    expect(result.totalDiscount).toBe(0);
  });

  test('zero subtotal: everything is zero', () => {
    const result = calculateStackedDiscounts(0, 100, 50, 30, 20);
    expect(result.totalDiscount).toBe(0);
  });

  test('defaults maxRedemptionPercent to 20 when not provided', () => {
    const result = calculateStackedDiscounts(1000, 0, 0, 500, 0);
    // 20% of 1000 = 200
    expect(result.loyaltyDiscount).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
// validateSplitPayments
// ═══════════════════════════════════════════════════════════════════

describe('validateSplitPayments', () => {
  test('valid split payments that match total', () => {
    const result = validateSplitPayments([
      { method: 'cash', amount: 300 },
      { method: 'upi', amount: 200 }
    ], 500);
    expect(result.valid).toBe(true);
  });

  test('empty array is valid (no split)', () => {
    expect(validateSplitPayments([], 500).valid).toBe(true);
  });

  test('null is valid (no split)', () => {
    expect(validateSplitPayments(null, 500).valid).toBe(true);
  });

  test('rejects negative split amount', () => {
    const result = validateSplitPayments([
      { method: 'cash', amount: -100 }
    ], 500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invalid amount');
  });

  test('rejects NaN split amount', () => {
    const result = validateSplitPayments([
      { method: 'cash', amount: 'abc' }
    ], 500);
    expect(result.valid).toBe(false);
  });

  test('rejects missing payment method', () => {
    const result = validateSplitPayments([
      { amount: 500 }
    ], 500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('missing payment method');
  });

  test('rejects when split total does not match order total', () => {
    const result = validateSplitPayments([
      { method: 'cash', amount: 200 },
      { method: 'upi', amount: 200 }
    ], 500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not match');
  });

  test('allows tiny floating point difference (within 0.01)', () => {
    const result = validateSplitPayments([
      { method: 'cash', amount: 333.33 },
      { method: 'upi', amount: 166.67 }
    ], 500);
    expect(result.valid).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// validateCashPayment
// ═══════════════════════════════════════════════════════════════════

describe('validateCashPayment', () => {
  test('exact cash', () => {
    const result = validateCashPayment(500, 500);
    expect(result.valid).toBe(true);
    expect(result.change).toBe(0);
  });

  test('cash with change', () => {
    const result = validateCashPayment(1000, 435);
    expect(result.valid).toBe(true);
    expect(result.change).toBe(565);
  });

  test('rejects insufficient cash', () => {
    const result = validateCashPayment(400, 500);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('less than');
  });

  test('rejects negative cash', () => {
    const result = validateCashPayment(-100, 500);
    expect(result.valid).toBe(false);
  });

  test('rejects NaN cash', () => {
    const result = validateCashPayment('abc', 500);
    expect(result.valid).toBe(false);
  });

  test('handles string number input', () => {
    const result = validateCashPayment('1000', 500);
    expect(result.valid).toBe(true);
    expect(result.change).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════════════
// validateOrderItems
// ═══════════════════════════════════════════════════════════════════

describe('validateOrderItems', () => {
  test('valid items pass', () => {
    const result = validateOrderItems([
      { name: 'Burger', price: 200, quantity: 2 },
      { name: 'Fries', price: 100, quantity: 1 }
    ]);
    expect(result.valid).toBe(true);
  });

  test('rejects empty array', () => {
    expect(validateOrderItems([]).valid).toBe(false);
  });

  test('rejects null', () => {
    expect(validateOrderItems(null).valid).toBe(false);
  });

  test('rejects negative price', () => {
    const result = validateOrderItems([
      { name: 'Hacked Item', price: -50, quantity: 1 }
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Hacked Item');
    expect(result.error).toContain('price');
  });

  test('rejects zero quantity', () => {
    const result = validateOrderItems([
      { name: 'Burger', price: 200, quantity: 0 }
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('quantity');
  });

  test('rejects negative quantity', () => {
    const result = validateOrderItems([
      { name: 'Burger', price: 200, quantity: -1 }
    ]);
    expect(result.valid).toBe(false);
  });

  test('allows zero price (free items)', () => {
    const result = validateOrderItems([
      { name: 'Free Sample', price: 0, quantity: 1 }
    ]);
    expect(result.valid).toBe(true);
  });

  test('rejects NaN price', () => {
    const result = validateOrderItems([
      { name: 'Bad Item', price: 'abc', quantity: 1 }
    ]);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// calculateInvoiceTotals
// ═══════════════════════════════════════════════════════════════════

describe('calculateInvoiceTotals', () => {
  test('basic invoice with no discount or tax', () => {
    const result = calculateInvoiceTotals([
      { quantity: 2, rate: 100 }
    ]);
    expect(result.subtotal).toBe(200);
    expect(result.discountAmount).toBe(0);
    expect(result.taxAmount).toBe(0);
    expect(result.total).toBe(200);
  });

  test('fixed discount', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, rate: 500 }
    ], 'fixed', 100);
    expect(result.subtotal).toBe(500);
    expect(result.discountAmount).toBe(100);
    expect(result.total).toBe(400);
  });

  test('percentage discount', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, rate: 1000 }
    ], 'percentage', 10);
    expect(result.subtotal).toBe(1000);
    expect(result.discountAmount).toBe(100);
    expect(result.total).toBe(900);
  });

  test('fixed discount capped at subtotal', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, rate: 100 }
    ], 'fixed', 500);
    expect(result.discountAmount).toBe(100); // capped at subtotal
    expect(result.total).toBe(0);
  });

  test('tax calculated on post-discount amount proportionally', () => {
    const items = [
      { quantity: 1, rate: 600, taxRate: 18 },
      { quantity: 1, rate: 400, taxRate: 5 }
    ];
    const result = calculateInvoiceTotals(items, 'fixed', 100);
    // Subtotal = 1000, Discount = 100, After discount = 900
    // 18% slab: taxable = 600, proportion = 0.6, adjusted = 900*0.6 = 540, tax = 540*18% = 97.2
    // 5% slab: taxable = 400, proportion = 0.4, adjusted = 900*0.4 = 360, tax = 360*5% = 18
    expect(result.subtotal).toBe(1000);
    expect(result.discountAmount).toBe(100);
    expect(result.taxAmount).toBe(115.2);
    expect(result.total).toBe(1015.2);
    expect(result.taxBreakdown).toHaveLength(2);
  });

  test('adjustments (positive and negative)', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, rate: 1000 }
    ], 'fixed', 0, 50);
    expect(result.total).toBe(1050);

    const result2 = calculateInvoiceTotals([
      { quantity: 1, rate: 1000 }
    ], 'fixed', 0, -50);
    expect(result2.total).toBe(950);
  });

  test('total never goes below 0', () => {
    const result = calculateInvoiceTotals([
      { quantity: 1, rate: 100 }
    ], 'fixed', 100, -50);
    // Subtotal 100 - discount 100 + tax 0 + adjustment -50 = -50 → capped to 0
    expect(result.total).toBe(0);
  });

  test('empty items returns zeros', () => {
    const result = calculateInvoiceTotals([]);
    expect(result.subtotal).toBe(0);
    expect(result.total).toBe(0);
  });

  test('multiple items with same tax rate are grouped', () => {
    const items = [
      { quantity: 2, rate: 100, taxRate: 18 },
      { quantity: 3, rate: 50, taxRate: 18 }
    ];
    const result = calculateInvoiceTotals(items);
    // Subtotal = 200 + 150 = 350, Tax = 350 * 18% = 63
    expect(result.taxBreakdown).toHaveLength(1);
    expect(result.taxBreakdown[0].rate).toBe(18);
    expect(result.taxAmount).toBe(63);
    expect(result.total).toBe(413);
  });

  test('handles string quantities and rates (parseFloat)', () => {
    const result = calculateInvoiceTotals([
      { quantity: '3', rate: '100.50' }
    ]);
    expect(result.subtotal).toBe(301.5);
    expect(result.total).toBe(301.5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// End-to-End Billing Scenarios
// ═══════════════════════════════════════════════════════════════════

describe('end-to-end billing scenarios', () => {
  test('typical restaurant order: items + discount + tax + SC', () => {
    const taxSettings = {
      enabled: true,
      taxes: [{ name: 'GST', rate: 5, enabled: true }],
      taxInclusivePricing: false
    };

    const items = [
      { name: 'Butter Chicken', price: 350, quantity: 1 },
      { name: 'Naan', price: 60, quantity: 3 },
      { name: 'Lassi', price: 80, quantity: 2 }
    ];
    // Subtotal = 350 + 180 + 160 = 690

    // Discount stacking: 10% offer = 69, manual = 0, loyalty = 0
    const discounts = calculateStackedDiscounts(690, 69, 0, 0, 0);
    expect(discounts.totalDiscount).toBe(69);

    // Tax on discounted amount with service charge
    const scAmount = Math.round((690 - 69) * 5 / 100 * 100) / 100; // 5% SC on 621 = 31.05
    const taxResult = calculatePerItemTax(items, taxSettings, [], discounts.totalDiscount, scAmount);

    // After discount = 621, with SC = 621 + 31.05 = 652.05
    // Tax = 652.05 * 5% = 32.60 (rounded)
    expect(taxResult.totalTaxAmount).toBe(32.6);

    // Grand total = 621 + 31.05 + 32.60 = 684.65
    const grandTotal = round2(690 - discounts.totalDiscount + scAmount + taxResult.exclusiveTaxAmount);
    expect(grandTotal).toBe(684.65);
  });

  test('full discount stacking scenario with loyalty and coupon', () => {
    const subtotal = 2000;
    // Offer: 20% = 400
    // Manual: 100
    // Loyalty: 500 (capped at 20% of remaining)
    // Coupon: 200

    const discounts = calculateStackedDiscounts(subtotal, 400, 100, 500, 200, { maxRedemptionPercent: 20 });

    expect(discounts.offerDiscount).toBe(400);
    expect(discounts.manualDiscount).toBe(100);
    // After offer+manual = 1500, 20% of 1500 = 300, so loyalty capped at 300
    expect(discounts.loyaltyDiscount).toBe(300);
    // After all = 1500 - 300 = 1200, coupon 200 fits
    expect(discounts.couponDiscount).toBe(200);
    expect(discounts.totalDiscount).toBe(1000);
  });

  test('validate items then calculate tax — negative price caught before tax calc', () => {
    const items = [
      { name: 'Good Item', price: 200, quantity: 1 },
      { name: 'Bad Item', price: -50, quantity: 1 }
    ];
    const validation = validateOrderItems(items);
    expect(validation.valid).toBe(false);
    // Tax calc should never be reached with invalid items
  });

  test('split payment validation after tax calculation', () => {
    const taxSettings = {
      enabled: true,
      taxes: [{ name: 'GST', rate: 18, enabled: true }],
      taxInclusivePricing: false
    };

    const items = [{ name: 'Pizza', price: 500, quantity: 2 }];
    const taxResult = calculatePerItemTax(items, taxSettings, [], 0, 0);
    const grandTotal = round2(1000 + taxResult.exclusiveTaxAmount); // 1000 + 180 = 1180

    // Valid split
    const valid = validateSplitPayments([
      { method: 'cash', amount: 680 },
      { method: 'card', amount: 500 }
    ], grandTotal);
    expect(valid.valid).toBe(true);

    // Invalid split (doesn't add up)
    const invalid = validateSplitPayments([
      { method: 'cash', amount: 600 },
      { method: 'card', amount: 500 }
    ], grandTotal);
    expect(invalid.valid).toBe(false);
  });
});
