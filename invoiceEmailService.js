/**
 * Invoice Email Service
 * Sends invoice emails to customers after order completion.
 * Designed to be called async (fire-and-forget) — never blocks order flow.
 */

const emailService = require('./emailService');
const { db, collections } = require('./firebase');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const toIsoOrNull = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  return null;
};

const formatIST = (iso) => {
  const d = iso ? new Date(iso) : new Date();
  const formattedTime = d.toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
  });
  const formattedDate = d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
  });
  return { formattedDate, formattedTime };
};

/**
 * Normalize phone number to 10-digit Indian format
 */
function normPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.substring(2);
  if (d.length === 11 && d.startsWith('0')) return d.substring(1);
  return d.length === 10 ? d : d;
}

/**
 * Build invoice data from order and restaurant docs
 */
function buildInvoiceData(orderId, order, restaurant, restaurantId) {
  const taxSettings = restaurant.taxSettings || {
    enabled: true,
    taxes: [{ id: 'gst', name: 'GST', rate: 5, enabled: true }],
    defaultTaxRate: 5
  };

  const itemsSubtotal = (order.items || []).reduce((sum, it) => sum + ((it.price || 0) * (it.quantity || 1)), 0);
  const subtotal = r2(order.subtotal || itemsSubtotal);
  const discountAmount = r2(order.discountAmount);
  const manualDiscount = r2(order.manualDiscount);
  const loyaltyDiscount = r2(order.loyaltyDiscount);
  const totalDiscount = r2(discountAmount + manualDiscount + loyaltyDiscount);

  let totalTax = 0;
  let taxBreakdown = [];
  if (Array.isArray(order.taxBreakdown) && order.taxBreakdown.length > 0) {
    taxBreakdown = order.taxBreakdown;
    totalTax = r2(order.taxAmount || taxBreakdown.reduce((s, t) => s + (t.amount || 0), 0));
  } else if (taxSettings.enabled) {
    const taxable = Math.max(0, subtotal - totalDiscount);
    for (const tax of (taxSettings.taxes || [])) {
      if (tax.enabled) {
        const amt = (taxable * (tax.rate || 0)) / 100;
        taxBreakdown.push({ id: tax.id, name: tax.name, rate: tax.rate, amount: r2(amt) });
        totalTax += amt;
      }
    }
    totalTax = r2(totalTax);
  }

  const serviceChargeAmount = order.serviceChargeAmount ? r2(order.serviceChargeAmount) : null;
  const tipAmount = order.tipAmount ? r2(order.tipAmount) : null;
  const roundOffAmount = order.roundOffAmount != null ? r2(order.roundOffAmount) : null;
  const grandTotal = r2(order.finalAmount || (subtotal - totalDiscount + totalTax + (serviceChargeAmount || 0) + (tipAmount || 0) + (roundOffAmount || 0)));

  const createdAtIso = toIsoOrNull(order.createdAt);
  const completedAtIso = toIsoOrNull(order.completedAt);
  const { formattedDate, formattedTime } = formatIST(completedAtIso || createdAtIso);

  const currencySymbol = restaurant.currencySymbol || (restaurant.currency === 'USD' ? '$' : '₹');

  return {
    orderId,
    orderNumber: order.orderNumber || order.dailyOrderId || orderId.slice(-6).toUpperCase(),
    restaurantName: restaurant.name || 'Restaurant',
    restaurantAddress: restaurant.address || '',
    restaurantPhone: restaurant.phone || '',
    restaurantEmail: restaurant.email || '',
    restaurantGstin: restaurant.gstin || '',
    restaurantFssai: restaurant.fssai || '',
    customerName: order.customerInfo?.name || 'Valued Customer',
    customerPhone: order.customerInfo?.phone || '',
    tableNumber: order.tableNumber || '',
    orderType: order.orderType || 'dine-in',
    items: order.items || [],
    subtotal,
    discountAmount,
    manualDiscount,
    loyaltyDiscount,
    totalDiscount,
    appliedOffer: order.appliedOffer || null,
    selectedOfferName: order.selectedOfferName || (order.appliedOffer?.name) || null,
    taxBreakdown,
    totalTax,
    serviceChargeRate: order.serviceChargeRate || null,
    serviceChargeAmount,
    tipAmount,
    roundOffAmount,
    grandTotal,
    paymentMethod: order.paymentMethod || 'cash',
    cashReceived: order.cashReceived ? r2(order.cashReceived) : null,
    changeReturned: order.changeReturned ? r2(order.changeReturned) : null,
    paidAmount: order.paidAmount ? r2(order.paidAmount) : null,
    outstandingAmount: order.outstandingAmount ? r2(order.outstandingAmount) : null,
    splitPayments: order.splitPayments || null,
    formattedDate,
    formattedTime,
    currencySymbol,
  };
}

/**
 * Generate the invoice HTML email body
 */
function generateInvoiceEmailHtml(inv) {
  const cs = inv.currencySymbol;

  const itemRows = inv.items.map(item => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#374151;font-size:14px;">${item.name || 'Item'}${item.variant ? ` (${item.variant})` : ''}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#6b7280;font-size:14px;text-align:center;">${item.quantity || 1}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#6b7280;font-size:14px;text-align:right;">${cs}${r2(item.price || 0)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #f1f5f9;color:#1f2937;font-size:14px;text-align:right;font-weight:600;">${cs}${r2((item.price || 0) * (item.quantity || 1))}</td>
    </tr>
  `).join('');

  const taxRows = inv.taxBreakdown.map(t => `
    <tr>
      <td style="padding:6px 0;color:#6b7280;font-size:13px;">${t.name} (${t.rate}%)</td>
      <td style="padding:6px 0;color:#374151;font-size:13px;text-align:right;">${cs}${r2(t.amount)}</td>
    </tr>
  `).join('');

  const orderTypeLabel = {
    'dine-in': 'Dine In',
    'takeaway': 'Takeaway',
    'delivery': 'Delivery',
    'customer_self_order': 'Self Order'
  }[inv.orderType] || inv.orderType;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#ef4444,#dc2626);padding:32px 28px;text-align:center;">
      <div style="display:inline-block;background:white;width:44px;height:44px;border-radius:12px;line-height:44px;margin-bottom:12px;">
        <span style="color:#ef4444;font-weight:800;font-size:18px;">DO</span>
      </div>
      <h1 style="margin:0;color:white;font-size:22px;font-weight:700;">Your Invoice</h1>
      <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">from ${inv.restaurantName}</p>
    </div>

    <!-- Restaurant & Order Info -->
    <div style="padding:24px 28px 0;">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;">
        <div>
          <p style="margin:0;font-size:15px;font-weight:700;color:#1f2937;">${inv.restaurantName}</p>
          ${inv.restaurantAddress ? `<p style="margin:2px 0 0;font-size:12px;color:#6b7280;">${inv.restaurantAddress}</p>` : ''}
          ${inv.restaurantPhone ? `<p style="margin:2px 0 0;font-size:12px;color:#6b7280;">Tel: ${inv.restaurantPhone}</p>` : ''}
          ${inv.restaurantGstin ? `<p style="margin:2px 0 0;font-size:12px;color:#6b7280;">GSTIN: ${inv.restaurantGstin}</p>` : ''}
          ${inv.restaurantFssai ? `<p style="margin:2px 0 0;font-size:12px;color:#6b7280;">FSSAI: ${inv.restaurantFssai}</p>` : ''}
        </div>
        <div style="text-align:right;">
          <p style="margin:0;font-size:12px;color:#9ca3af;">Order #</p>
          <p style="margin:0;font-size:15px;font-weight:700;color:#1f2937;">${inv.orderNumber}</p>
          <p style="margin:6px 0 0;font-size:12px;color:#6b7280;">${inv.formattedDate} · ${inv.formattedTime}</p>
          <p style="margin:2px 0 0;font-size:12px;color:#6b7280;">${orderTypeLabel}${inv.tableNumber ? ` · Table ${inv.tableNumber}` : ''}</p>
        </div>
      </div>
    </div>

    <!-- Customer Info -->
    <div style="padding:16px 28px 0;">
      <p style="margin:0;font-size:13px;color:#9ca3af;">Bill To</p>
      <p style="margin:2px 0 0;font-size:14px;font-weight:600;color:#1f2937;">${inv.customerName}</p>
      ${inv.customerPhone ? `<p style="margin:1px 0 0;font-size:12px;color:#6b7280;">${inv.customerPhone}</p>` : ''}
    </div>

    <!-- Items Table -->
    <div style="padding:20px 28px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:2px solid #e5e7eb;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Item</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Price</th>
            <th style="padding:10px 12px;text-align:right;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>
    </div>

    <!-- Summary -->
    <div style="padding:0 28px 24px;">
      <div style="border-top:2px solid #e5e7eb;padding-top:16px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="padding:6px 0;color:#6b7280;font-size:13px;">Subtotal</td>
            <td style="padding:6px 0;color:#374151;font-size:13px;text-align:right;">${cs}${inv.subtotal}</td>
          </tr>
          ${inv.totalDiscount > 0 ? `
          <tr>
            <td style="padding:6px 0;color:#16a34a;font-size:13px;">Discount${inv.selectedOfferName ? ` (${inv.selectedOfferName})` : ''}</td>
            <td style="padding:6px 0;color:#16a34a;font-size:13px;text-align:right;">-${cs}${inv.totalDiscount}</td>
          </tr>` : ''}
          ${taxRows}
          ${inv.serviceChargeAmount ? `
          <tr>
            <td style="padding:6px 0;color:#6b7280;font-size:13px;">Service Charge${inv.serviceChargeRate ? ` (${inv.serviceChargeRate}%)` : ''}</td>
            <td style="padding:6px 0;color:#374151;font-size:13px;text-align:right;">${cs}${inv.serviceChargeAmount}</td>
          </tr>` : ''}
          ${inv.tipAmount ? `
          <tr>
            <td style="padding:6px 0;color:#6b7280;font-size:13px;">Tip</td>
            <td style="padding:6px 0;color:#374151;font-size:13px;text-align:right;">${cs}${inv.tipAmount}</td>
          </tr>` : ''}
          ${inv.roundOffAmount != null && inv.roundOffAmount !== 0 ? `
          <tr>
            <td style="padding:6px 0;color:#6b7280;font-size:13px;">Round Off</td>
            <td style="padding:6px 0;color:#374151;font-size:13px;text-align:right;">${inv.roundOffAmount > 0 ? '+' : ''}${cs}${inv.roundOffAmount}</td>
          </tr>` : ''}
        </table>

        <!-- Grand Total -->
        <div style="margin-top:12px;padding:16px;background:linear-gradient(135deg,#1f2937,#111827);border-radius:12px;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:rgba(255,255,255,0.8);font-size:14px;font-weight:600;">Total Amount</span>
          <span style="color:white;font-size:22px;font-weight:800;">${cs}${inv.grandTotal}</span>
        </div>

        <!-- Payment Info -->
        <div style="margin-top:12px;padding:12px 16px;background:#f9fafb;border-radius:10px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:13px;color:#6b7280;">Payment Method</span>
            <span style="font-size:13px;font-weight:600;color:#1f2937;text-transform:capitalize;">${inv.paymentMethod}</span>
          </div>
          ${inv.paidAmount ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span style="font-size:13px;color:#6b7280;">Paid</span>
            <span style="font-size:13px;font-weight:600;color:#16a34a;">${cs}${inv.paidAmount}</span>
          </div>` : ''}
          ${inv.outstandingAmount && inv.outstandingAmount > 0 ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span style="font-size:13px;color:#6b7280;">Outstanding</span>
            <span style="font-size:13px;font-weight:600;color:#ef4444;">${cs}${inv.outstandingAmount}</span>
          </div>` : ''}
          ${inv.cashReceived ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span style="font-size:13px;color:#6b7280;">Cash Received</span>
            <span style="font-size:13px;color:#374151;">${cs}${inv.cashReceived}</span>
          </div>` : ''}
          ${inv.changeReturned ? `
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
            <span style="font-size:13px;color:#6b7280;">Change</span>
            <span style="font-size:13px;color:#374151;">${cs}${inv.changeReturned}</span>
          </div>` : ''}
        </div>
      </div>
    </div>

    <!-- Thank You -->
    <div style="padding:0 28px 28px;text-align:center;">
      <p style="margin:0;font-size:15px;color:#1f2937;font-weight:600;">Thank you for dining with us!</p>
      <p style="margin:6px 0 0;font-size:13px;color:#9ca3af;">We hope to see you again soon.</p>
    </div>

    <!-- Footer -->
    <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #f1f5f9;text-align:center;">
      <p style="margin:0;font-size:11px;color:#9ca3af;">Powered by <a href="https://www.dineopen.com" style="color:#ef4444;text-decoration:none;font-weight:600;">DineOpen</a> — AI-Powered Restaurant Management</p>
    </div>

  </div>
</body>
</html>`;
}

/**
 * Generate a printable invoice HTML (for attachment)
 */
function generateInvoiceAttachmentHtml(inv) {
  const cs = inv.currencySymbol;

  const itemRows = inv.items.map(item => `
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;">${item.name || 'Item'}${item.variant ? ` (${item.variant})` : ''}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:center;">${item.quantity || 1}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;">${cs}${r2(item.price || 0)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;text-align:right;font-weight:600;">${cs}${r2((item.price || 0) * (item.quantity || 1))}</td>
    </tr>
  `).join('');

  const orderTypeLabel = {
    'dine-in': 'Dine In', 'takeaway': 'Takeaway', 'delivery': 'Delivery', 'customer_self_order': 'Self Order'
  }[inv.orderType] || inv.orderType;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Invoice #${inv.orderNumber} - ${inv.restaurantName}</title>
  <style>
    @media print { body { margin: 0; } .no-print { display: none; } }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1f2937; max-width: 600px; margin: 20px auto; padding: 0 20px; }
    .header { text-align: center; padding-bottom: 20px; border-bottom: 2px solid #e5e7eb; margin-bottom: 20px; }
    .header h1 { margin: 0; font-size: 22px; color: #1f2937; }
    .header p { margin: 4px 0 0; font-size: 13px; color: #6b7280; }
    .info-row { display: flex; justify-content: space-between; margin-bottom: 20px; }
    .info-block p { margin: 2px 0; font-size: 13px; color: #6b7280; }
    .info-block .label { font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; }
    .info-block .value { font-size: 14px; color: #1f2937; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th { text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 10px; border-bottom: 2px solid #e5e7eb; }
    th:nth-child(2) { text-align: center; }
    th:nth-child(3), th:nth-child(4) { text-align: right; }
    .summary { border-top: 2px solid #e5e7eb; padding-top: 12px; }
    .summary-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; color: #6b7280; }
    .summary-row.total { font-size: 18px; font-weight: 800; color: #1f2937; padding: 12px 0; border-top: 2px solid #1f2937; margin-top: 8px; }
    .footer { text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e7eb; font-size: 12px; color: #9ca3af; }
  </style>
</head>
<body>
  <div class="header">
    <h1>${inv.restaurantName}</h1>
    ${inv.restaurantAddress ? `<p>${inv.restaurantAddress}</p>` : ''}
    ${inv.restaurantPhone ? `<p>Tel: ${inv.restaurantPhone}</p>` : ''}
    ${inv.restaurantGstin ? `<p>GSTIN: ${inv.restaurantGstin}</p>` : ''}
    ${inv.restaurantFssai ? `<p>FSSAI: ${inv.restaurantFssai}</p>` : ''}
  </div>

  <div class="info-row">
    <div class="info-block">
      <p class="label">Bill To</p>
      <p class="value">${inv.customerName}</p>
      ${inv.customerPhone ? `<p>${inv.customerPhone}</p>` : ''}
    </div>
    <div class="info-block" style="text-align:right;">
      <p class="label">Invoice</p>
      <p class="value">#${inv.orderNumber}</p>
      <p>${inv.formattedDate} · ${inv.formattedTime}</p>
      <p>${orderTypeLabel}${inv.tableNumber ? ` · Table ${inv.tableNumber}` : ''}</p>
    </div>
  </div>

  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="summary">
    <div class="summary-row"><span>Subtotal</span><span>${cs}${inv.subtotal}</span></div>
    ${inv.totalDiscount > 0 ? `<div class="summary-row" style="color:#16a34a;"><span>Discount${inv.selectedOfferName ? ` (${inv.selectedOfferName})` : ''}</span><span>-${cs}${inv.totalDiscount}</span></div>` : ''}
    ${inv.taxBreakdown.map(t => `<div class="summary-row"><span>${t.name} (${t.rate}%)</span><span>${cs}${r2(t.amount)}</span></div>`).join('')}
    ${inv.serviceChargeAmount ? `<div class="summary-row"><span>Service Charge${inv.serviceChargeRate ? ` (${inv.serviceChargeRate}%)` : ''}</span><span>${cs}${inv.serviceChargeAmount}</span></div>` : ''}
    ${inv.tipAmount ? `<div class="summary-row"><span>Tip</span><span>${cs}${inv.tipAmount}</span></div>` : ''}
    ${inv.roundOffAmount != null && inv.roundOffAmount !== 0 ? `<div class="summary-row"><span>Round Off</span><span>${inv.roundOffAmount > 0 ? '+' : ''}${cs}${inv.roundOffAmount}</span></div>` : ''}
    <div class="summary-row total"><span>Total</span><span>${cs}${inv.grandTotal}</span></div>
    <div class="summary-row"><span>Payment</span><span style="text-transform:capitalize;">${inv.paymentMethod}</span></div>
    ${inv.paidAmount ? `<div class="summary-row"><span>Paid</span><span>${cs}${inv.paidAmount}</span></div>` : ''}
    ${inv.outstandingAmount && inv.outstandingAmount > 0 ? `<div class="summary-row" style="color:#ef4444;"><span>Outstanding</span><span>${cs}${inv.outstandingAmount}</span></div>` : ''}
  </div>

  <div class="footer">
    <p>Thank you for dining with us!</p>
    <p style="margin-top:8px;">Powered by DineOpen — dineopen.com</p>
  </div>
</body>
</html>`;
}

/**
 * Main function: Send invoice email for a completed order.
 * This is fire-and-forget — never throws, never blocks calling code.
 */
async function sendInvoiceEmail({ orderId, restaurantId }) {
  try {
    console.log(`📧 Invoice email: checking for order ${orderId}...`);

    // 1. Get restaurant and check if feature is enabled
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      console.log(`📧 Restaurant ${restaurantId} not found, skipping invoice email`);
      return;
    }
    const restaurant = restaurantDoc.data();
    const billingSettings = restaurant.billingSettings || {};
    if (!billingSettings.emailInvoiceEnabled) {
      return; // Feature not enabled, silently skip
    }

    // 2. Get order data
    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      console.log(`📧 Order ${orderId} not found, skipping invoice email`);
      return;
    }
    const order = orderDoc.data();

    // 3. Find customer email — from order, or look up by phone
    let customerEmail = order.customerInfo?.email || '';

    if (!customerEmail && order.customerInfo?.phone) {
      try {
        const phone = order.customerInfo.phone;
        const custQuery = await db.collection(collections.customers)
          .where('restaurantId', '==', restaurantId)
          .where('phone', '==', phone)
          .limit(1).get();

        if (!custQuery.empty) {
          customerEmail = custQuery.docs[0].data().email || '';
        }

        // Try normalized phone if direct match failed
        if (!customerEmail) {
          const np = normPhone(phone);
          if (np) {
            const allCust = await db.collection(collections.customers)
              .where('restaurantId', '==', restaurantId)
              .get();
            const match = allCust.docs.find(d => normPhone(d.data().phone) === np);
            if (match) {
              customerEmail = match.data().email || '';
            }
          }
        }
      } catch (lookupErr) {
        console.error(`📧 Customer lookup error for order ${orderId}:`, lookupErr.message);
      }
    }

    if (!customerEmail) {
      console.log(`📧 No customer email for order ${orderId}, skipping invoice email`);
      return;
    }

    // 4. Build invoice data
    const inv = buildInvoiceData(orderId, order, restaurant, restaurantId);
    const customerName = inv.customerName;

    // 5. Generate email HTML and attachment
    const emailHtml = generateInvoiceEmailHtml(inv);
    const attachmentHtml = generateInvoiceAttachmentHtml(inv);

    // 6. Send email
    const subject = `Invoice #${inv.orderNumber} from ${inv.restaurantName}`;
    const textContent = `Hi ${customerName},\n\nThank you for your visit to ${inv.restaurantName}!\n\nYour invoice for Order #${inv.orderNumber} is attached.\n\nTotal: ${inv.currencySymbol}${inv.grandTotal}\nPayment: ${inv.paymentMethod}\nDate: ${inv.formattedDate} ${inv.formattedTime}\n\nThank you for dining with us!\n\n— ${inv.restaurantName}\nPowered by DineOpen (dineopen.com)`;

    await emailService.sendEmail({
      to: customerEmail,
      subject,
      text: textContent,
      html: emailHtml,
      attachments: [{
        filename: `Invoice_${inv.orderNumber}_${inv.restaurantName.replace(/[^a-zA-Z0-9]/g, '_')}.html`,
        content: attachmentHtml,
        contentType: 'text/html'
      }]
    });

    console.log(`✅ Invoice email sent for order ${orderId} to ${customerEmail}`);

  } catch (error) {
    // Never throw — this is fire-and-forget
    console.error(`❌ Invoice email failed for order ${orderId}:`, error.message);
  }
}

module.exports = { sendInvoiceEmail };
