/**
 * Kenya KRA eTIMS / VSCU — server-side mapping & orchestration.
 *
 * ARCHITECTURE
 *  - The VSCU is a KRA-provided JAR that runs on the RESTAURANT's LAN (e.g.
 *    http://localhost:8088). The cloud backend cannot reach it, so the actual
 *    HTTP call is relayed by the Electron desktop app. This module owns the
 *    single source of truth for building the exact KRA payloads and reading
 *    back the signed result — Electron is only a dumb local relay.
 *
 *  - EVERYTHING here is gated on isKenya(). Non-Kenya stores never touch it.
 *
 * Spec: VSCU_Specification_Document_v2.0 (KRA). See
 * memory/kenya-etims-vscu-compliance.md. Fields marked "CONFIRM §4.x" use a
 * sensible default from the spec that should be verified against the KRA code
 * tables before go-live.
 */

'use strict';

// ---------------------------------------------------------------------------
// Country gate — mirrors the existing `isIndia` pattern (index.js) so eTIMS is
// completely dormant unless the store's admin currency is Kenya.
// ---------------------------------------------------------------------------
function isKenya(restaurantData) {
  const cs = restaurantData && restaurantData.currencySettings;
  if (!cs) return false;
  return cs.countryCode === 'KE' || cs.currencyCode === 'KES';
}

/** eTIMS is "active" only when it's a Kenya store AND the device is configured+initialised. */
function isEtimsActive(restaurantData) {
  if (!isKenya(restaurantData)) return false;
  const cfg = restaurantData.etimsConfig;
  return !!(cfg && cfg.enabled && cfg.tin && cfg.bhfId && cfg.dvcSrlNo && cfg.vscuUrl && cfg.device && cfg.device.sdcId);
}

// ---------------------------------------------------------------------------
// Kenya VAT tax bands (spec §4.1 — CONFIRM exact codes before go-live).
//   A = Exempt (0%)   B = 16% standard   C = 0% zero-rated
//   D = Non-VAT       E = 8%
// Each sale carries per-band totals (taxblAmtA..E / taxRtA..E / taxAmtA..E) and
// each item carries a taxTyCd (the band letter).
// ---------------------------------------------------------------------------
const TAX_BANDS = {
  A: { code: 'A', rate: 0 },   // Exempt
  B: { code: 'B', rate: 16 },  // Standard
  C: { code: 'C', rate: 0 },   // Zero-rated
  D: { code: 'D', rate: 0 },   // Non-VAT
  E: { code: 'E', rate: 8 },   // 8%
};

/** Map an item's VAT rate (%) to a KRA tax band letter. Default: 16% standard (B). */
function bandForRate(rate, explicitBand) {
  if (explicitBand && TAX_BANDS[explicitBand]) return explicitBand;
  const r = Number(rate);
  if (r === 16) return 'B';
  if (r === 8) return 'E';
  if (r === 0) return 'C';       // treat 0% as zero-rated by default (A=exempt is opt-in per item)
  return 'B';                    // anything else → standard
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// Date formatting (KRA wants local time, no separators).
// ---------------------------------------------------------------------------
function fmt(date, withTime) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return withTime ? '' : '';
  const p = (n) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  if (!withTime) return ymd;
  return `${ymd}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Payment method (§4.10 — CONFIRM). Map our methods to KRA codes.
function paymentTypeCode(method) {
  switch ((method || '').toLowerCase()) {
    case 'cash': return '01';
    case 'card':
    case 'credit-card':
    case 'debit-card': return '05';
    case 'mpesa':
    case 'mobile':
    case 'upi':
    case 'wallet': return '06';   // mobile money
    case 'credit':
    case 'khata': return '02';
    default: return '01';         // default cash
  }
}

// ---------------------------------------------------------------------------
// Build the device-initialisation request (POST /initializer/selectInitInfo).
// ---------------------------------------------------------------------------
function buildInitPayload(cfg) {
  return {
    tin: String(cfg.tin || ''),
    bhfId: String(cfg.bhfId || '00'),
    dvcSrlNo: String(cfg.dvcSrlNo || ''),
  };
}

// ---------------------------------------------------------------------------
// Build the sale request (POST /trnsSales/saveSales) from a DineOpen order.
//
// Assumes VAT-inclusive pricing when restaurant.taxSettings.taxInclusivePricing
// is true (common in Kenya); otherwise VAT is added on top. Per item we derive
// its band, taxable amount and VAT, then roll them up into the A–E band totals.
// ---------------------------------------------------------------------------
function buildSaveSalesPayload(order, restaurantData, overrideInvcNo) {
  const cfg = restaurantData.etimsConfig || {};
  const device = cfg.device || {};
  const taxInclusive = !!(restaurantData.taxSettings && restaurantData.taxSettings.taxInclusivePricing);

  // Invoice number MUST be reserved atomically by the caller (prepare-sale) and
  // passed in here — never recomputed, to avoid duplicate invoice numbers.
  const invcNo = overrideInvcNo != null ? Number(overrideInvcNo) : (Number(device.lastInvcNo) || 0) + 1;

  const items = Array.isArray(order.items) ? order.items : [];

  // Per-band accumulators
  const band = { A: 0, B: 0, C: 0, D: 0, E: 0 };      // taxable amounts
  const bandTax = { A: 0, B: 0, C: 0, D: 0, E: 0 };   // tax amounts
  let totTaxblAmt = 0, totTaxAmt = 0, totAmt = 0;

  const itemList = items.map((it, i) => {
    const qty = Number(it.quantity) || 1;
    const unitPrice = Number(it.price) || 0;      // price as sold (incl. VAT if inclusive)
    const lineGross = round2(unitPrice * qty);
    const bandLetter = bandForRate(it.gstRate != null ? it.gstRate : (it.taxRate != null ? it.taxRate : 16), it.kraTaxBand);
    const rate = TAX_BANDS[bandLetter].rate;

    let taxbl, tax;
    if (rate === 0) {
      taxbl = lineGross; tax = 0;
    } else if (taxInclusive) {
      taxbl = round2(lineGross / (1 + rate / 100));
      tax = round2(lineGross - taxbl);
    } else {
      taxbl = lineGross;
      tax = round2(lineGross * rate / 100);
    }
    const lineTotal = round2(taxbl + tax);

    band[bandLetter] += taxbl;
    bandTax[bandLetter] += tax;
    totTaxblAmt += taxbl;
    totTaxAmt += tax;
    totAmt += lineTotal;

    return {
      itemSeq: i + 1,
      itemCd: String(it.pluCode || it.shortCode || it.menuItemId || it.id || `ITEM${i + 1}`).slice(0, 20),
      itemClsCd: String(it.kraItemClassCode || cfg.defaultItemClassCode || '42294957'), // §4.17 (UNSPSC) — 42294957 is the KRA-accepted default (matches a proven live sale)
      itemNm: String(it.name || 'Item').slice(0, 200),
      bcd: it.barcode ? String(it.barcode) : null,
      pkgUnitCd: 'CTN',           // §4.5 packaging unit — 'CTN' is a KRA-accepted code (a proven live sale used it; 'NT' was rejected by the sandbox VSCU)
      pkg: 0,                      // packaging qty — proven live sale used 0
      qtyUnitCd: 'U',             // §4.6 (unit of quantity — 'U' = each)
      qty,
      prc: round2(unitPrice),
      splyAmt: lineGross,
      dcRt: 0,
      dcAmt: 0,
      isrccNm: null, isrcRt: null, isrcAmt: null, // insurance (pharmacy) — sent as null on a normal sale
      taxTyCd: bandLetter,
      taxblAmt: round2(taxbl),
      taxAmt: round2(tax),        // KRA item field is `taxAmt` (the proven-working payload uses this, NOT totTaxAmt)
      totAmt: lineTotal,
    };
  });

  const now = order.completedAt ? new Date(order.completedAt) : new Date();
  const custPhone = (order.customerInfo && (order.customerInfo.phone || order.customerInfo.mobile)) || order.customerMobile || '';
  const custName = (order.customerInfo && order.customerInfo.name) || order.customerName || '';

  const payload = {
    tin: String(cfg.tin || ''),
    bhfId: String(cfg.bhfId || '00'),
    invcNo,
    trdInvcNo: String(order.orderNumber || order.id || invcNo).slice(0, 50),
    orgInvcNo: 0,                 // 0 for an original sale (non-credit-note)
    // KRA requires a buyer PIN + name; for a walk-in sale use the KRA generic-customer
    // defaults (custTin 'A000000000D' / custNm 'CASH') — a null here is rejected by the VSCU.
    custTin: order.customerTin ? String(order.customerTin) : 'A000000000D',
    custNm: custName ? String(custName).slice(0, 60) : 'CASH',
    salesTyCd: 'N',              // §4.8 — send only 'N'
    rcptTyCd: 'S',               // §4.9 — 'S' = Sale
    pmtTyCd: paymentTypeCode(order.paymentMethod),  // §4.10
    salesSttsCd: '02',           // §4.11 — '02' = Approved
    cfmDt: fmt(now, true),
    salesDt: fmt(now, false),
    stockRlsDt: fmt(now, true),
    cnclReqDt: null, cnclDt: null, rfdDt: null, rfdRsnCd: null,
    totItemCnt: itemList.length,

    taxblAmtA: round2(band.A), taxblAmtB: round2(band.B), taxblAmtC: round2(band.C), taxblAmtD: round2(band.D), taxblAmtE: round2(band.E),
    taxRtA: TAX_BANDS.A.rate, taxRtB: TAX_BANDS.B.rate, taxRtC: TAX_BANDS.C.rate, taxRtD: TAX_BANDS.D.rate, taxRtE: TAX_BANDS.E.rate,
    taxAmtA: round2(bandTax.A), taxAmtB: round2(bandTax.B), taxAmtC: round2(bandTax.C), taxAmtD: round2(bandTax.D), taxAmtE: round2(bandTax.E),

    totTaxblAmt: round2(totTaxblAmt),
    totTaxAmt: round2(totTaxAmt),
    totAmt: round2(totAmt),
    prchrAcptcYn: 'N',
    remark: '',
    // Registrant/modifier — KRA expects these at the TOP LEVEL too (not only inside receipt).
    // A null/absent value is rejected; use the staff, falling back to a safe non-empty code.
    regrId: String(order.createdBy || order.staffId || 'POS').slice(0, 20) || 'POS',
    regrNm: String(order.createdByName || order.staffName || 'POS').slice(0, 60) || 'POS',
    modrId: String(order.createdBy || order.staffId || 'POS').slice(0, 20) || 'POS',
    modrNm: String(order.createdByName || order.staffName || 'POS').slice(0, 60) || 'POS',

    // Receipt sub-object
    receipt: {
      custTin: order.customerTin ? String(order.customerTin) : 'A000000000D',
      custMblNo: custPhone ? String(custPhone).slice(0, 20) : null,
      rptNo: invcNo,
      trdeNm: String(restaurantData.name || '').slice(0, 60),
      adrs: String((restaurantData.address && (restaurantData.address.full || restaurantData.address)) || restaurantData.location || '').slice(0, 200),
      topMsg: cfg.receiptTopMsg || null,
      btmMsg: cfg.receiptBottomMsg || 'Thank you for your business',
      prchrAcptcYn: 'N',
      regrNm: String((order.createdByName || order.staffName || 'POS')).slice(0, 60),
      regrId: String((order.createdBy || order.staffId || 'POS')).slice(0, 20),
      modrNm: String((order.createdByName || order.staffName || 'POS')).slice(0, 60),
      modrId: String((order.createdBy || order.staffId || 'POS')).slice(0, 20),
    },

    itemList,
  };

  return { payload, invcNo };
}

// ---------------------------------------------------------------------------
// Item registration (POST /items/saveItems). KRA requires items to be
// registered before they appear on a fiscal sale. Build one payload per menu
// item. Codes marked CONFIRM §4.x default to sensible values.
// ---------------------------------------------------------------------------
function buildSaveItemsPayloads(menuItems, restaurantData) {
  const cfg = restaurantData.etimsConfig || {};
  const device = cfg.device || {};
  const regr = { id: 'POS', nm: 'DineOpen' };
  const items = Array.isArray(menuItems) ? menuItems : [];
  return items
    .filter((it) => it && (it.status ? it.status === 'active' : true))
    .map((it) => {
      const band = bandForRate(it.gstRate != null ? it.gstRate : (it.taxRate != null ? it.taxRate : 16), it.kraTaxBand);
      return {
        tin: String(cfg.tin || ''),
        bhfId: String(cfg.bhfId || '00'),
        itemCd: String(it.pluCode || it.shortCode || it.menuItemId || it.id || '').slice(0, 20),
        itemClsCd: String(it.kraItemClassCode || cfg.defaultItemClassCode || '42294957'), // §4.17 — KRA-accepted default (matches saveSales)
        itemTyCd: '2',              // §4 — '2' = finished/service item (typical for F&B)
        itemNm: String(it.name || 'Item').slice(0, 200),
        itemStdNm: String(it.name || '').slice(0, 200),
        orgnNatCd: 'KE',            // country of origin
        pkgUnitCd: 'CTN',           // §4.5 packaging unit — KRA-accepted code (keep in step with saveSales)
        qtyUnitCd: 'U',             // CONFIRM §4.6 — 'U' = each
        taxTyCd: band,              // A–E
        bcd: it.barcode ? String(it.barcode) : null,
        dftPrc: round2(it.price || 0),
        isrcAplcbYn: 'N',
        useYn: 'Y',
        regrId: regr.id, regrNm: regr.nm, modrId: regr.id, modrNm: regr.nm,
      };
    })
    .filter((p) => p.itemCd);      // skip items with no usable code
}

/** Normalise the VSCU saveSales response into the fields we store + print. */
function parseSaleResult(vscuResponse) {
  const data = (vscuResponse && (vscuResponse.data || vscuResponse.result || vscuResponse)) || {};
  const resultCd = vscuResponse && (vscuResponse.resultCd || vscuResponse.result_cd);
  return {
    ok: resultCd === '000' || resultCd === undefined ? (data.rcptSign ? true : (resultCd === '000')) : false,
    resultCd: resultCd || null,
    resultMsg: (vscuResponse && (vscuResponse.resultMsg || vscuResponse.result_msg)) || null,
    rcptNo: data.rcptNo != null ? data.rcptNo : null,
    totRcptNo: data.totRcptNo != null ? data.totRcptNo : null,
    intrlData: data.intrlData || null,
    rcptSign: data.rcptSign || null,
    sdcId: data.sdcId || null,
    mrcNo: data.mrcNo || null,
    vsdcRcptPbctDate: data.VSCURcptPbctDate || data.vsdcRcptPbctDate || null,
    raw: data,
  };
}

module.exports = {
  isKenya,
  isEtimsActive,
  buildInitPayload,
  buildSaveSalesPayload,
  buildSaveItemsPayloads,
  parseSaleResult,
  paymentTypeCode,
  TAX_BANDS,
};
