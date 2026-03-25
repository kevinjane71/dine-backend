const { FieldValue } = require('firebase-admin/firestore');

/**
 * Calculate invoice totals from line items, discount, and adjustments.
 *
 * @param {Array} items - [{quantity, rate, taxRate, ...}]
 * @param {string} discountType - 'percentage' | 'fixed'
 * @param {number} discountValue - discount amount or percentage
 * @param {number} adjustments - flat adjustment amount (positive or negative)
 * @returns {{ subtotal, discountAmount, taxAmount, taxBreakdown, total }}
 */
function calculateInvoiceTotals(items = [], discountType = 'fixed', discountValue = 0, adjustments = 0) {
  // Calculate subtotal from line items (before tax)
  let subtotal = 0;
  const taxMap = {}; // taxRate -> { rate, taxableAmount, taxAmount }

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

  // Calculate discount
  let discountAmount = 0;
  if (discountType === 'percentage' && discountValue > 0) {
    discountAmount = round2((subtotal * discountValue) / 100);
  } else if (discountType === 'fixed' && discountValue > 0) {
    discountAmount = round2(Math.min(discountValue, subtotal));
  }

  // Taxable amount after discount (proportional discount across tax slabs)
  const taxableAfterDiscount = subtotal - discountAmount;
  let taxAmount = 0;
  const taxBreakdown = [];

  for (const key of Object.keys(taxMap)) {
    const slab = taxMap[key];
    // Proportionally reduce taxable amount by discount ratio
    const proportion = subtotal > 0 ? slab.taxableAmount / subtotal : 0;
    const adjustedTaxable = round2(taxableAfterDiscount * proportion);
    const slabTax = round2((adjustedTaxable * slab.rate) / 100);

    taxAmount += slabTax;
    taxBreakdown.push({
      rate: slab.rate,
      taxableAmount: adjustedTaxable,
      taxAmount: slabTax
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

/**
 * Update invoice status with a timestamp.
 */
async function updateInvoiceStatus(db, collections, invoiceId, status) {
  const invoiceRef = db.collection(collections.invInvoices).doc(invoiceId);
  const updateData = {
    status,
    updatedAt: FieldValue.serverTimestamp()
  };

  if (status === 'sent') {
    updateData.sentAt = FieldValue.serverTimestamp();
  } else if (status === 'paid') {
    updateData.paidAt = FieldValue.serverTimestamp();
  }

  await invoiceRef.update(updateData);
  return updateData;
}

function round2(num) {
  return Math.round((num + Number.EPSILON) * 100) / 100;
}

module.exports = { calculateInvoiceTotals, updateInvoiceStatus };
