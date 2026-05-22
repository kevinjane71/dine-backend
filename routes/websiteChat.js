const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const { DINEOPEN_SYSTEM_PROMPT, LEAD_EXTRACTION_PROMPT } = require('../services/websiteChatKnowledge');
const { db } = require('../firebase');

// ──── Rate Limiting (in-memory) ────
const rateLimits = new Map();
const RATE_LIMIT = 10; // messages per window
const RATE_WINDOW = 60000; // 1 minute

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimits.get(ip);

  if (!entry || now > entry.resetTime) {
    rateLimits.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetTime) rateLimits.delete(ip);
  }
}, 300000);

// ──── OpenAI Client ────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ──── POST /api/website-chat ────
router.post('/website-chat', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || 'unknown';

    if (!checkRateLimit(ip)) {
      return res.status(429).json({
        success: false,
        error: 'Too many messages. Please wait a moment before trying again.'
      });
    }

    const { message, history = [] } = req.body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    if (message.length > 500) {
      return res.status(400).json({ success: false, error: 'Message too long (max 500 characters)' });
    }

    // Build conversation messages (limit history to last 6 messages)
    const conversationHistory = (history || []).slice(-6).map(msg => ({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: (msg.content || '').slice(0, 500),
    }));

    const messages = [
      { role: 'system', content: DINEOPEN_SYSTEM_PROMPT },
      ...conversationHistory,
      { role: 'user', content: message.trim() },
    ];

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 400,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content || 'Sorry, I couldn\'t process that. Please try again.';

    // Check if user provided contact info (simple regex detection)
    const contactInfo = extractContactInfo(message);

    res.json({
      success: true,
      reply,
      contactDetected: contactInfo,
    });

  } catch (error) {
    console.error('[website-chat] Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Something went wrong. Please try again.'
    });
  }
});

// ──── Contact Info Extraction (regex-based, no API call) ────
function extractContactInfo(message) {
  const info = {};

  // Phone number detection (various formats)
  const phoneMatch = message.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,5}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/);
  if (phoneMatch) info.phone = phoneMatch[0].trim();

  // Email detection
  const emailMatch = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) info.email = emailMatch[0].trim();

  return Object.keys(info).length > 0 ? info : null;
}

module.exports = router;
