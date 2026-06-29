'use strict';

const { PDFDocument } = require('pdf-lib');
const realtimeService = require('./firebaseRealtimeService');
const { kvSet } = require('../utils/kvCache');

// Lazy-init OpenAI (same pattern as index.js)
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const OpenAI = require('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// Same prompt used by existing extraction in index.js
const MENU_PDF_PROMPT = `Analyze this document. If it is a restaurant menu: 1) List section headers in "categories" as [{"name":"SectionName","order":1}]. Use EXACT names. If no sections, use "categories":[].
2) Extract ALL menu items. Set "category" to section name or "Other".
3) VARIANTS: If item shows multiple sizes/prices (e.g., "Half ₹110/Full ₹180", "110/180"), extract as "variants":[{"name":"Half","price":110},{"name":"Full","price":180}]. Otherwise use "variants":[].
For each item also add "imageKeyword": a specific hyphen-separated keyword (1-3 words) that uniquely identifies this dish. Make each keyword DIFFERENT from similar items: "egg-thali" not "thali", "chicken-biryani" not "biryani", "masala-dosa" not "dosa", "chocolate-icecream" not "icecream", "chicken-burger" not "burger". Use the protein/variant as prefix (e.g. "mutton-thali", "veg-fried-rice", "strawberry-shake", "cheese-naan").
Return JSON: {"categories":[...],"menuItems":[{"name":"","description":"","price":0,"category":"...","isVeg":true,"shortCode":"1","variants":[],"imageKeyword":""}]}
shortCode: 1,2,3... If NOT a menu: {"categories":[],"menuItems":[]}`;

// ─── Concurrency Controller ────────────────────────────────────────────────────

async function processWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

// ─── Detect MIME type from file extension ──────────────────────────────────────

function detectMimeType(filePath) {
  const ext = (filePath || '').split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', tiff: 'image/tiff',
    csv: 'text/csv',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

// ─── Single Page Extraction (OpenAI Files API) ────────────────────────────────

async function extractSinglePage(pageBuffer, pageIndex) {
  const openai = getOpenAI();
  const { toFile } = require('openai');

  const uploaded = await openai.files.create({
    file: await toFile(Buffer.from(pageBuffer), `page-${pageIndex + 1}.pdf`, { type: 'application/pdf' }),
    purpose: 'user_data',
  });

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'file', file: { file_id: uploaded.id } },
          { type: 'text', text: MENU_PDF_PROMPT },
        ],
      }],
      max_tokens: 8000,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const d = JSON.parse(jsonMatch[0]);
      return {
        categories: Array.isArray(d.categories) ? d.categories : [],
        menuItems: Array.isArray(d.menuItems) ? d.menuItems : [],
      };
    }
    return { categories: [], menuItems: [] };
  } finally {
    openai.files.del(uploaded.id).catch(() => {});
  }
}

// ─── Retry Wrapper ─────────────────────────────────────────────────────────────

async function extractPageWithRetry(pageBuffer, pageIndex, maxRetries) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await extractSinglePage(pageBuffer, pageIndex);
    } catch (err) {
      console.warn(`⚠️ Page ${pageIndex + 1} attempt ${attempt + 1} failed:`, err.message);
      if (attempt === maxRetries) {
        return { categories: [], menuItems: [], error: err.message, page: pageIndex + 1 };
      }
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

// ─── PDF Page-by-Page Processing ───────────────────────────────────────────────

async function processPDFPageByPage(pdfBuffer, jobId, restaurantId, fileName, options = {}) {
  const concurrency = options.concurrency || 3;
  const maxRetries = options.maxRetries || 2;

  // Split PDF into pages
  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const totalPages = pdfDoc.getPageCount();
  console.log(`📄 PDF has ${totalPages} pages — processing with concurrency ${concurrency}`);

  // Notify start
  await realtimeService.pushEvent(restaurantId, 'bulk-upload', 'bulk-upload-started', {
    jobId, fileName, totalPages,
  });

  // Create single-page PDF buffers
  const pageBuffers = [];
  for (let i = 0; i < totalPages; i++) {
    const singleDoc = await PDFDocument.create();
    const [copiedPage] = await singleDoc.copyPages(pdfDoc, [i]);
    singleDoc.addPage(copiedPage);
    pageBuffers.push(await singleDoc.save());
  }

  // Process pages with concurrency
  const pageResults = await processWithConcurrency(pageBuffers, concurrency, async (pageBuffer, pageIndex) => {
    console.log(`📖 Processing page ${pageIndex + 1}/${totalPages}...`);
    const result = await extractPageWithRetry(pageBuffer, pageIndex, maxRetries);

    // Push progress to RTDB
    if (result.error) {
      await realtimeService.pushEvent(restaurantId, 'bulk-upload', 'bulk-upload-page-error', {
        jobId, page: pageIndex + 1, totalPages, error: result.error,
      });
    } else {
      await realtimeService.pushEvent(restaurantId, 'bulk-upload', 'bulk-upload-page-done', {
        jobId, page: pageIndex + 1, totalPages, itemsFound: result.menuItems.length,
      });
    }
    return result;
  });

  // Merge all page results
  return mergePageResults(pageResults);
}

// ─── Non-PDF File Processing (delegates to existing extractors) ────────────────

async function processNonPDFFile(bucket, gcsPath, fileType, fileName, businessType, jobId, restaurantId) {
  const fileUrl = `https://storage.googleapis.com/${bucket.name}/${gcsPath}`;

  // Push single "processing" event
  await realtimeService.pushEvent(restaurantId, 'bulk-upload', 'bulk-upload-started', {
    jobId, fileName, totalPages: 1,
  });

  // Use the existing extractors from index.js
  // We import them lazily to avoid circular deps with the monolithic index.js
  let result = { categories: [], menuItems: [] };

  try {
    if (fileType.startsWith('image/')) {
      // Download buffer and use OpenAI Vision
      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: fileUrl, detail: 'high' } },
            { type: 'text', text: MENU_PDF_PROMPT },
          ],
        }],
        max_tokens: 8000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const d = JSON.parse(jsonMatch[0]);
        result = {
          categories: Array.isArray(d.categories) ? d.categories : [],
          menuItems: Array.isArray(d.menuItems) ? d.menuItems : [],
        };
      }
    } else if (fileType.includes('csv') || fileType.includes('excel') || fileType.includes('spreadsheet')) {
      // Download and parse spreadsheet
      const axios = require('axios');
      const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(resp.data);
      const XLSX = require('xlsx');
      const ext = (fileName || '').split('.').pop().toLowerCase();
      const isCSV = ext === 'csv' || ext === 'tsv' || ext === 'txt';
      const workbook = isCSV
        ? XLSX.read(buffer.toString('utf-8').replace(/^\uFEFF/, ''), { type: 'string' })
        : XLSX.read(buffer, { type: 'buffer', codepage: 65001 });

      // Convert to text and send to AI
      const lines = [];
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_csv(sheet);
        if (data.trim()) lines.push(data);
      }
      const csvText = lines.join('\n').substring(0, 60000);

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: `${MENU_PDF_PROMPT}\n\nHere is the spreadsheet data:\n${csvText}` }],
        max_tokens: 8000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const d = JSON.parse(jsonMatch[0]);
        result = {
          categories: Array.isArray(d.categories) ? d.categories : [],
          menuItems: Array.isArray(d.menuItems) ? d.menuItems : [],
        };
      }
    } else {
      // Documents (Word, text) — download and extract text
      const axios = require('axios');
      const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(resp.data);
      let text = buffer.toString('utf-8').substring(0, 60000);

      const openai = getOpenAI();
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: `${MENU_PDF_PROMPT}\n\nHere is the document text:\n${text}` }],
        max_tokens: 8000,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const d = JSON.parse(jsonMatch[0]);
        result = {
          categories: Array.isArray(d.categories) ? d.categories : [],
          menuItems: Array.isArray(d.menuItems) ? d.menuItems : [],
        };
      }
    }
  } catch (err) {
    console.error(`❌ Non-PDF extraction failed for ${fileName}:`, err.message);
  }

  // Push done event
  await realtimeService.pushEvent(restaurantId, 'bulk-upload', 'bulk-upload-page-done', {
    jobId, page: 1, totalPages: 1, itemsFound: result.menuItems.length,
  });

  return result;
}

// ─── Merge Page Results ────────────────────────────────────────────────────────

function mergePageResults(pageResults) {
  const allItems = [];
  const categoryMap = new Map();

  for (const page of pageResults) {
    if (!page || page.error) continue;

    for (const cat of (page.categories || [])) {
      const key = (cat.name || '').toLowerCase().trim();
      if (key && !categoryMap.has(key)) {
        categoryMap.set(key, { name: cat.name, order: categoryMap.size + 1 });
      }
    }

    for (const item of (page.menuItems || [])) {
      allItems.push(item);
    }
  }

  // Assign sequential shortCodes (temporary — bulk-save re-generates from max existing)
  allItems.forEach((item, i) => {
    item.shortCode = String(i + 1);
  });

  return {
    categories: Array.from(categoryMap.values()),
    menuItems: allItems,
  };
}

// ─── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Process an uploaded file from GCS.
 * PDFs are split page-by-page; other types are processed as single units.
 * Progress is pushed to Firebase RTDB. Results are stored in Redis.
 *
 * @param {object} bucket - GCS bucket instance
 * @param {string} gcsPath - Path in GCS bucket
 * @param {string} jobId - Unique job ID
 * @param {string} restaurantId - Restaurant ID
 * @param {string} businessType - 'restaurant' | 'bar' | 'bakery' | etc.
 * @param {object} options - { concurrency, maxRetries }
 * @returns {Promise<{ categories: Array, menuItems: Array }>}
 */
async function processUploadedFile(bucket, gcsPath, jobId, restaurantId, businessType = 'restaurant', options = {}) {
  const fileName = gcsPath.split('/').pop();
  const fileType = detectMimeType(gcsPath);

  console.log(`\n=== MENU EXTRACTION SERVICE ===`);
  console.log(`Job: ${jobId} | File: ${fileName} | Type: ${fileType} | Restaurant: ${restaurantId}`);

  let result;

  if (fileType === 'application/pdf') {
    // Download PDF and process page-by-page
    const [buffer] = await bucket.file(gcsPath).download();
    result = await processPDFPageByPage(buffer, jobId, restaurantId, fileName, options);
  } else {
    // Non-PDF: process as single unit
    result = await processNonPDFFile(bucket, gcsPath, fileType, fileName, businessType, jobId, restaurantId);
  }

  // Push completion event
  await realtimeService.pushEvent(restaurantId, 'bulk-upload', 'bulk-upload-complete', {
    jobId,
    totalItems: result.menuItems.length,
    totalCategories: result.categories.length,
  });

  // Store results in Redis (30 min TTL)
  await kvSet(`bulk-upload:${jobId}`, JSON.stringify(result), 1800);

  // Cleanup: delete uploaded file from GCS (non-blocking)
  bucket.file(gcsPath).delete().catch(err => {
    console.warn('GCS cleanup failed (non-blocking):', err.message);
  });

  console.log(`✅ Extraction complete: ${result.menuItems.length} items, ${result.categories.length} categories`);
  return result;
}

module.exports = {
  processUploadedFile,
};
