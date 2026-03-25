const express = require('express');
const OpenAI = require('openai');

module.exports = (db, collections) => {
  const router = express.Router();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  async function getOrgId(userId) {
    const snapshot = await db.collection(collections.invOrganizations)
      .where('userId', '==', userId)
      .limit(1)
      .get();
    if (snapshot.empty) return null;
    return snapshot.docs[0].id;
  }

  async function getOrgData(userId) {
    const snapshot = await db.collection(collections.invOrganizations)
      .where('userId', '==', userId)
      .limit(1)
      .get();
    if (snapshot.empty) return { id: null, data: {} };
    return { id: snapshot.docs[0].id, data: snapshot.docs[0].data() };
  }

  // POST /generate-description — Smart Item Description Generator
  router.post('/generate-description', async (req, res) => {
    try {
      const { name, type, unit, sellingPrice } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: 'Item name is required' });
      }

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a professional invoice item description writer for Indian businesses. Write a clear, concise 1-2 sentence description suitable for invoices and quotes. Be specific and professional. Do not use quotes around the description. Do not include the price in the description.'
          },
          {
            role: 'user',
            content: `Item: ${name.trim()}\nType: ${type || 'goods'}\nUnit: ${unit || 'N/A'}\nSelling Price: ₹${sellingPrice || 'N/A'}\n\nWrite a professional item description:`
          }
        ],
        max_tokens: 150,
        temperature: 0.7,
      });

      const description = completion.choices[0]?.message?.content?.trim() || '';
      return res.json({ success: true, data: { description } });
    } catch (err) {
      console.error('AI generate-description error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to generate description' });
    }
  });

  // POST /suggest-style — Invoice Template Auto-Styling
  router.post('/suggest-style', async (req, res) => {
    try {
      const { websiteUrl, brandDescription } = req.body;
      if (!websiteUrl && !brandDescription) {
        return res.status(400).json({ success: false, error: 'Provide a website URL or brand description' });
      }

      const input = websiteUrl
        ? `Website URL: ${websiteUrl}\n${brandDescription ? `Additional info: ${brandDescription}` : ''}`
        : `Brand description: ${brandDescription}`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a brand design expert specializing in invoice styling. Based on the brand info provided, suggest an invoice PDF style.

Available templates:
- "standard" — Clean, professional layout with clear sections
- "spreadsheet" — Table-heavy, data-focused, great for detailed invoices
- "continental" — Elegant European style with refined typography
- "compact" — Space-efficient minimal design for simple invoices

Return ONLY valid JSON with this exact structure:
{"template":"standard","backgroundColor":"#ffffff","labelColor":"#6b7280","fontColor":"#111827","reasoning":"Brief 1-sentence explanation of why these choices match the brand"}

Rules:
- backgroundColor should be light (white or very light tint) for readability
- labelColor should be a muted/medium tone for section headers
- fontColor should be dark for body text readability
- Colors should reflect the brand identity while maintaining print-friendliness
- All colors must be valid 7-character hex codes`
          },
          { role: 'user', content: input }
        ],
        max_tokens: 200,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });

      const suggestion = JSON.parse(completion.choices[0]?.message?.content || '{}');
      return res.json({ success: true, data: suggestion });
    } catch (err) {
      console.error('AI suggest-style error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to suggest style' });
    }
  });

  // GET /expense-categories — Get org's used categories + defaults
  router.get('/expense-categories', async (req, res) => {
    try {
      const orgId = await getOrgId(req.user.userId);
      if (!orgId) return res.status(404).json({ success: false, error: 'Organization not found' });

      const snapshot = await db.collection(collections.invExpenses)
        .where('orgId', '==', orgId)
        .select('category')
        .get();

      const usedCategories = new Set();
      snapshot.docs.forEach(doc => {
        const cat = doc.data().category;
        if (cat) usedCategories.add(cat);
      });

      // Merge with defaults
      const defaults = [
        'advertising', 'bank_fees', 'contract_work', 'fuel', 'insurance',
        'meals', 'office_supplies', 'postage', 'printing', 'rent',
        'repairs', 'salaries', 'software', 'telephone', 'travel',
        'utilities', 'other'
      ];
      defaults.forEach(c => usedCategories.add(c));

      return res.json({ success: true, data: Array.from(usedCategories).sort() });
    } catch (err) {
      console.error('AI expense-categories error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
  });

  // POST /categorize-expense — Smart Expense Categorization
  router.post('/categorize-expense', async (req, res) => {
    try {
      const { notes, amount, categories } = req.body;
      if (!notes || !notes.trim()) {
        return res.status(400).json({ success: false, error: 'Notes/description required' });
      }

      const categoryList = (categories || []).join(', ');

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are an expense categorization assistant for Indian businesses. Given expense details, suggest the most appropriate category.

Available categories: ${categoryList}

If none of the existing categories fit well, suggest a new short category name in lowercase with underscores (e.g., "vehicle_maintenance", "staff_training").

Return ONLY valid JSON: {"category":"category_name","isNew":false,"confidence":"high"}`
          },
          {
            role: 'user',
            content: `Expense notes: ${notes.trim()}\nAmount: ${amount ? `₹${amount}` : 'N/A'}`
          }
        ],
        max_tokens: 100,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const suggestion = JSON.parse(completion.choices[0]?.message?.content || '{}');
      return res.json({ success: true, data: suggestion });
    } catch (err) {
      console.error('AI categorize-expense error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to categorize expense' });
    }
  });

  // POST /chat — AI Conversational Assistant
  router.post('/chat', async (req, res) => {
    try {
      const { message, conversationHistory } = req.body;
      if (!message || !message.trim()) {
        return res.status(400).json({ success: false, error: 'Message is required' });
      }

      const { id: orgId, data: org } = await getOrgData(req.user.userId);
      if (!orgId) {
        return res.status(404).json({ success: false, error: 'Organization not found' });
      }

      // Fetch context data
      const [customersSnap, itemsSnap] = await Promise.all([
        db.collection(collections.invCustomers)
          .where('orgId', '==', orgId)
          .where('status', '==', 'active')
          .select('displayName', 'companyName', 'email')
          .limit(50)
          .get(),
        db.collection(collections.invItems)
          .where('orgId', '==', orgId)
          .where('status', '==', 'active')
          .select('name', 'sellingPrice', 'type')
          .limit(50)
          .get(),
      ]);

      const customers = customersSnap.docs.map(d => ({
        id: d.id,
        name: d.data().displayName || d.data().companyName,
        email: d.data().email
      }));
      const items = itemsSnap.docs.map(d => ({
        id: d.id,
        name: d.data().name,
        price: d.data().sellingPrice
      }));

      const systemPrompt = `You are DineOpen AI — a helpful, friendly invoice assistant for "${org.name || 'this business'}". You help with invoicing, billing, and business tasks.

AVAILABLE DATA:
Customers (${customers.length}): ${JSON.stringify(customers)}
Items/Products (${items.length}): ${JSON.stringify(items)}

YOU CAN:
1. **Create invoices** — When the user wants to create an invoice, respond with an action to navigate to the create page with pre-filled data
2. **Navigate** — Direct users to specific pages (invoices, customers, quotes, expenses, etc.)
3. **Answer questions** — About their customers, items, or general invoicing help
4. **Give business advice** — Tips on invoicing best practices, payment collection, etc.

RESPONSE FORMAT — Always respond with valid JSON:
{
  "message": "Your conversational response text here",
  "action": null
}

For navigation, use:
{"message": "...", "action": {"type": "navigate", "path": "/invoices"}}

For creating an invoice:
{"message": "...", "action": {"type": "create_invoice", "path": "/invoices/new", "params": {"customerName": "...", "items": [{"name": "...", "quantity": 1, "rate": 500}]}}}

Available pages: /dashboard, /customers, /items, /invoices, /quotes, /challans, /payments, /expenses, /reports, /settings

RULES:
- Use ₹ (Indian Rupee) for currency
- Keep responses concise and friendly (2-3 sentences max)
- If you're not sure about something, ask for clarification
- Match customer/item names fuzzy (e.g., "Sharma" matches "Sharma Electronics")`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...(conversationHistory || []).slice(-10),
        { role: 'user', content: message.trim() }
      ];

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 500,
        temperature: 0.7,
        response_format: { type: 'json_object' },
      });

      let response;
      try {
        response = JSON.parse(completion.choices[0]?.message?.content || '{}');
      } catch {
        response = { message: completion.choices[0]?.message?.content || 'Sorry, I could not process that.', action: null };
      }

      return res.json({ success: true, data: response });
    } catch (err) {
      console.error('AI chat error:', err.message);
      return res.status(500).json({ success: false, error: 'AI assistant error' });
    }
  });

  return router;
};
