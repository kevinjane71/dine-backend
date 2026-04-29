const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');

router.use(authenticateToken);

// Helper: get date range from month string 'YYYY-MM'
function getMonthRange(month) {
  const [year, mon] = month.split('-').map(Number);
  const start = new Date(year, mon - 1, 1);
  const end = new Date(year, mon, 0, 23, 59, 59, 999);
  return { start, end };
}

// Helper: split GST into CGST+SGST (intra-state) or IGST (inter-state)
function splitGST(taxAmount, rate, isInterState = false) {
  if (isInterState) {
    return { cgst: 0, sgst: 0, igst: taxAmount, rate };
  }
  return { cgst: taxAmount / 2, sgst: taxAmount / 2, igst: 0, rate };
}

// ── GET /api/gst/:restaurantId/gstr1 ─────────────────────────────
// Generate GSTR-1 data (outward supplies)
router.get('/:restaurantId/gstr1', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { month } = req.query; // 'YYYY-MM'
    if (!month) return res.status(400).json({ error: 'month query param required (YYYY-MM)' });

    const { start, end } = getMonthRange(month);

    // Fetch orders for the month
    const orderSnap = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', start)
      .where('createdAt', '<=', end)
      .get();

    let totalTaxableValue = 0, totalCGST = 0, totalSGST = 0, totalIGST = 0, totalInvoiceValue = 0;
    const invoices = [];

    orderSnap.docs.forEach(doc => {
      const order = doc.data();
      if (order.status === 'cancelled' || order.status === 'deleted') return;

      const taxAmount = order.taxAmount || 0;
      const taxableValue = (order.finalAmount || order.totalAmount || 0) - taxAmount;
      const gstRate = order.taxBreakdown?.[0]?.rate || order.taxRate || 5;
      const gst = splitGST(taxAmount, gstRate);

      totalTaxableValue += taxableValue;
      totalCGST += gst.cgst;
      totalSGST += gst.sgst;
      totalIGST += gst.igst;
      totalInvoiceValue += order.finalAmount || order.totalAmount || 0;

      invoices.push({
        orderId: doc.id,
        orderNumber: order.dailyOrderId || order.orderNumber || doc.id.slice(-6),
        date: order.createdAt?.toDate?.() || order.createdAt,
        customerName: order.customerName || 'Walk-in',
        customerPhone: order.customerPhone || '',
        orderType: order.orderType || 'dine-in',
        taxableValue: Math.round(taxableValue * 100) / 100,
        gstRate,
        cgst: Math.round(gst.cgst * 100) / 100,
        sgst: Math.round(gst.sgst * 100) / 100,
        igst: Math.round(gst.igst * 100) / 100,
        totalValue: Math.round((order.finalAmount || order.totalAmount || 0) * 100) / 100,
        paymentMethod: order.paymentMethod || 'cash',
      });
    });

    res.json({
      month,
      restaurantId,
      summary: {
        totalInvoices: invoices.length,
        totalTaxableValue: Math.round(totalTaxableValue * 100) / 100,
        totalCGST: Math.round(totalCGST * 100) / 100,
        totalSGST: Math.round(totalSGST * 100) / 100,
        totalIGST: Math.round(totalIGST * 100) / 100,
        totalTax: Math.round((totalCGST + totalSGST + totalIGST) * 100) / 100,
        totalInvoiceValue: Math.round(totalInvoiceValue * 100) / 100,
      },
      invoices,
    });
  } catch (err) {
    console.error('GSTR-1 generation error:', err);
    res.status(500).json({ error: 'Failed to generate GSTR-1 report' });
  }
});

// ── GET /api/gst/:restaurantId/gstr3b ────────────────────────────
// Generate GSTR-3B summary
router.get('/:restaurantId/gstr3b', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month query param required (YYYY-MM)' });

    const { start, end } = getMonthRange(month);

    // Outward supplies (from orders)
    const orderSnap = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', start)
      .where('createdAt', '<=', end)
      .get();

    let outwardTaxable = 0, outwardTax = 0;
    orderSnap.docs.forEach(doc => {
      const o = doc.data();
      if (o.status === 'cancelled' || o.status === 'deleted') return;
      const tax = o.taxAmount || 0;
      outwardTaxable += (o.finalAmount || o.totalAmount || 0) - tax;
      outwardTax += tax;
    });

    // Inward supplies (from supplier invoices)
    const invoiceSnap = await db.collection('supplier-invoices')
      .where('restaurantId', '==', restaurantId)
      .where('invoiceDate', '>=', start)
      .where('invoiceDate', '<=', end)
      .get();

    let inwardTaxable = 0, inwardTax = 0;
    invoiceSnap.docs.forEach(doc => {
      const inv = doc.data();
      inwardTaxable += inv.subtotal || 0;
      inwardTax += inv.taxAmount || 0;
    });

    const netTaxPayable = Math.max(0, outwardTax - inwardTax);
    const itcAvailable = inwardTax;

    res.json({
      month,
      restaurantId,
      outwardSupplies: {
        taxableValue: Math.round(outwardTaxable * 100) / 100,
        tax: Math.round(outwardTax * 100) / 100,
        cgst: Math.round(outwardTax / 2 * 100) / 100,
        sgst: Math.round(outwardTax / 2 * 100) / 100,
        igst: 0,
      },
      inwardSupplies: {
        taxableValue: Math.round(inwardTaxable * 100) / 100,
        tax: Math.round(inwardTax * 100) / 100,
        cgst: Math.round(inwardTax / 2 * 100) / 100,
        sgst: Math.round(inwardTax / 2 * 100) / 100,
        igst: 0,
      },
      itcAvailable: Math.round(itcAvailable * 100) / 100,
      netTaxPayable: Math.round(netTaxPayable * 100) / 100,
      totalTaxLiability: Math.round(outwardTax * 100) / 100,
    });
  } catch (err) {
    console.error('GSTR-3B generation error:', err);
    res.status(500).json({ error: 'Failed to generate GSTR-3B report' });
  }
});

// ── GET /api/gst/:restaurantId/hsn-summary ───────────────────────
// HSN-wise summary
router.get('/:restaurantId/hsn-summary', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month query param required (YYYY-MM)' });

    const { start, end } = getMonthRange(month);

    const orderSnap = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', start)
      .where('createdAt', '<=', end)
      .get();

    const hsnMap = {};

    orderSnap.docs.forEach(doc => {
      const order = doc.data();
      if (order.status === 'cancelled' || order.status === 'deleted') return;
      const items = order.items || [];
      const gstRate = order.taxBreakdown?.[0]?.rate || order.taxRate || 5;

      items.forEach(item => {
        const hsn = item.hsnCode || item.hsn || '9963'; // 9963 = restaurant services default
        const qty = item.quantity || 1;
        const value = (item.price || 0) * qty;
        const taxOnItem = value * (gstRate / 100);

        if (!hsnMap[hsn]) {
          hsnMap[hsn] = { hsnCode: hsn, description: item.name || '', quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0, totalValue: 0, rate: gstRate };
        }
        hsnMap[hsn].quantity += qty;
        hsnMap[hsn].taxableValue += value;
        hsnMap[hsn].cgst += taxOnItem / 2;
        hsnMap[hsn].sgst += taxOnItem / 2;
        hsnMap[hsn].totalTax += taxOnItem;
        hsnMap[hsn].totalValue += value + taxOnItem;
      });
    });

    const hsnSummary = Object.values(hsnMap).map(h => ({
      ...h,
      taxableValue: Math.round(h.taxableValue * 100) / 100,
      cgst: Math.round(h.cgst * 100) / 100,
      sgst: Math.round(h.sgst * 100) / 100,
      igst: Math.round(h.igst * 100) / 100,
      totalTax: Math.round(h.totalTax * 100) / 100,
      totalValue: Math.round(h.totalValue * 100) / 100,
    }));

    res.json({
      month,
      restaurantId,
      hsnSummary,
      totalItems: hsnSummary.length,
    });
  } catch (err) {
    console.error('HSN summary error:', err);
    res.status(500).json({ error: 'Failed to generate HSN summary' });
  }
});

// ── GET /api/gst/:restaurantId/export/:type ──────────────────────
// Export GST report as CSV
router.get('/:restaurantId/export/:type', async (req, res) => {
  try {
    const { restaurantId, type } = req.params;
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month query param required (YYYY-MM)' });

    // Reuse existing endpoints internally
    let data;
    const { start, end } = getMonthRange(month);

    if (type === 'gstr1') {
      const orderSnap = await db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', start)
        .where('createdAt', '<=', end)
        .get();

      const rows = [['Order#', 'Date', 'Customer', 'Type', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total', 'Payment']];
      orderSnap.docs.forEach(doc => {
        const o = doc.data();
        if (o.status === 'cancelled' || o.status === 'deleted') return;
        const tax = o.taxAmount || 0;
        const taxable = (o.finalAmount || o.totalAmount || 0) - tax;
        const rate = o.taxBreakdown?.[0]?.rate || 5;
        rows.push([
          o.dailyOrderId || doc.id.slice(-6),
          o.createdAt?.toDate?.()?.toISOString?.()?.split('T')[0] || '',
          o.customerName || 'Walk-in',
          o.orderType || 'dine-in',
          taxable.toFixed(2),
          (tax / 2).toFixed(2),
          (tax / 2).toFixed(2),
          '0.00',
          (o.finalAmount || o.totalAmount || 0).toFixed(2),
          o.paymentMethod || 'cash',
        ]);
      });
      data = rows.map(r => r.join(',')).join('\n');
    } else if (type === 'gstr3b') {
      // Outward supplies (from orders)
      const gstr3bSnap = await db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', start)
        .where('createdAt', '<=', end)
        .get();
      let outTaxable = 0, outTax = 0;
      gstr3bSnap.docs.forEach(doc => {
        const o = doc.data();
        if (o.status === 'cancelled' || o.status === 'deleted') return;
        const tax = o.taxAmount || 0;
        outTaxable += (o.finalAmount || o.totalAmount || 0) - tax;
        outTax += tax;
      });
      // Inward supplies (from supplier invoices)
      const invSnap = await db.collection('supplier-invoices')
        .where('restaurantId', '==', restaurantId)
        .where('invoiceDate', '>=', start)
        .where('invoiceDate', '<=', end)
        .get();
      let inTaxable = 0, inTax = 0;
      invSnap.docs.forEach(doc => {
        const inv = doc.data();
        inTaxable += inv.subtotal || 0;
        inTax += inv.taxAmount || 0;
      });
      const netPayable = Math.max(0, outTax - inTax);
      const rows3b = [
        ['Section', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total Tax'],
        ['Outward Supplies (Sales)', outTaxable.toFixed(2), (outTax / 2).toFixed(2), (outTax / 2).toFixed(2), '0.00', outTax.toFixed(2)],
        ['Inward Supplies (Purchases)', inTaxable.toFixed(2), (inTax / 2).toFixed(2), (inTax / 2).toFixed(2), '0.00', inTax.toFixed(2)],
        ['ITC Available', '', (inTax / 2).toFixed(2), (inTax / 2).toFixed(2), '0.00', inTax.toFixed(2)],
        ['Net Tax Payable', '', (netPayable / 2).toFixed(2), (netPayable / 2).toFixed(2), '0.00', netPayable.toFixed(2)],
      ];
      data = rows3b.map(r => r.join(',')).join('\n');
    } else if (type === 'hsn') {
      const hsnSnap = await db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', start)
        .where('createdAt', '<=', end)
        .get();
      const hsnMap = {};
      hsnSnap.docs.forEach(doc => {
        const order = doc.data();
        if (order.status === 'cancelled' || order.status === 'deleted') return;
        const gstRate = order.taxBreakdown?.[0]?.rate || order.taxRate || 5;
        (order.items || []).forEach(item => {
          const hsn = item.hsnCode || item.hsn || '9963';
          const qty = item.quantity || 1;
          const value = (item.price || 0) * qty;
          const taxOnItem = value * (gstRate / 100);
          if (!hsnMap[hsn]) {
            hsnMap[hsn] = { hsn, desc: item.name || '', qty: 0, taxable: 0, cgst: 0, sgst: 0, totalTax: 0, total: 0 };
          }
          hsnMap[hsn].qty += qty;
          hsnMap[hsn].taxable += value;
          hsnMap[hsn].cgst += taxOnItem / 2;
          hsnMap[hsn].sgst += taxOnItem / 2;
          hsnMap[hsn].totalTax += taxOnItem;
          hsnMap[hsn].total += value + taxOnItem;
        });
      });
      const hsnRows = [['HSN Code', 'Description', 'Qty', 'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total Tax', 'Total Value']];
      Object.values(hsnMap).forEach(h => {
        hsnRows.push([h.hsn, `"${h.desc}"`, h.qty, h.taxable.toFixed(2), h.cgst.toFixed(2), h.sgst.toFixed(2), '0.00', h.totalTax.toFixed(2), h.total.toFixed(2)]);
      });
      data = hsnRows.map(r => r.join(',')).join('\n');
    } else {
      return res.status(400).json({ error: 'Invalid export type. Use: gstr1, gstr3b, hsn' });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${type}-${month}.csv`);
    res.send(data);
  } catch (err) {
    console.error('GST export error:', err);
    res.status(500).json({ error: 'Failed to export GST report' });
  }
});

module.exports = router;
