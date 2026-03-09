const express = require('express');
const router = express.Router();
const OpenAI = require('openai');
const publicToolsLimiter = require('../middleware/publicToolsLimiter');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Tool definitions: validation + system prompt
const TOOLS = {
  'review-response': {
    required: ['reviewText', 'rating'],
    maxLengths: { reviewText: 2000, restaurantName: 100 },
    systemPrompt: `You are a helpful restaurant review response writer. Write a professional, warm, and authentic response to the customer review. Keep it 2-4 sentences. Be grateful for positive reviews, empathetic for negative ones. Never be defensive. Include the restaurant name if provided. Do not use emojis excessively.`,
    buildUserPrompt: (p) =>
      `Restaurant: ${p.restaurantName || 'Our Restaurant'}\nRating: ${p.rating}/5\nReview: ${p.reviewText}\n\nWrite a professional response:`,
  },
  'menu-description': {
    required: ['dishName'],
    maxLengths: { dishName: 100, ingredients: 500, cuisine: 50, style: 50 },
    systemPrompt: `You are a food copywriter specializing in restaurant menus. Write an appetizing, concise menu description (1-2 sentences). Make it vivid and sensory. Don't be overly flowery. Match the cuisine style.`,
    buildUserPrompt: (p) =>
      `Dish: ${p.dishName}\nCuisine: ${p.cuisine || 'Any'}\nIngredients: ${p.ingredients || 'Not specified'}\nStyle: ${p.style || 'descriptive'}\n\nWrite a menu description:`,
  },
  tagline: {
    required: ['restaurantName'],
    maxLengths: { restaurantName: 100, cuisine: 50, vibe: 100 },
    systemPrompt: `You are a branding expert for restaurants. Generate 5 catchy, memorable taglines. Each should be under 10 words. Make them unique, not generic. Consider the cuisine type and vibe. Return as a numbered list.`,
    buildUserPrompt: (p) =>
      `Restaurant: ${p.restaurantName}\nCuisine: ${p.cuisine || 'Any'}\nVibe: ${p.vibe || 'casual dining'}\n\nGenerate 5 taglines:`,
  },
  'social-caption': {
    required: ['postType'],
    maxLengths: { postType: 50, details: 500, restaurantName: 100, platform: 20 },
    systemPrompt: `You are a social media manager for restaurants. Write an engaging social media caption. Include relevant hashtags (5-8). Match the platform tone (Instagram = visual/trendy, Facebook = community/detailed, Twitter = concise/witty). Keep it authentic, not corporate.`,
    buildUserPrompt: (p) =>
      `Restaurant: ${p.restaurantName || 'Our Restaurant'}\nPlatform: ${p.platform || 'Instagram'}\nPost Type: ${p.postType}\nDetails: ${p.details || ''}\n\nWrite a caption with hashtags:`,
  },
  'complaint-response': {
    required: ['complaint'],
    maxLengths: { complaint: 2000, restaurantName: 100, channel: 50 },
    systemPrompt: `You are a customer service expert for restaurants. Write a professional, empathetic response to the customer complaint. Acknowledge the issue, apologize sincerely, offer a solution or next step, and invite them back. Keep it 3-5 sentences. Never be defensive or dismissive.`,
    buildUserPrompt: (p) =>
      `Restaurant: ${p.restaurantName || 'Our Restaurant'}\nChannel: ${p.channel || 'Email'}\nComplaint: ${p.complaint}\n\nWrite a professional response:`,
  },
  'job-description': {
    required: ['role'],
    maxLengths: { role: 100, restaurantName: 100, experience: 50, location: 100, requirements: 500 },
    systemPrompt: `You are an HR specialist for the restaurant industry. Write a compelling job description that attracts quality candidates. Include: role overview (2-3 sentences), key responsibilities (5-7 bullet points), requirements (4-6 bullet points), and what you offer (3-5 bullet points). Keep it professional but warm.`,
    buildUserPrompt: (p) =>
      `Restaurant: ${p.restaurantName || 'Restaurant'}\nRole: ${p.role}\nExperience: ${p.experience || 'Any'}\nLocation: ${p.location || 'Not specified'}\nSpecial Requirements: ${p.requirements || 'None'}\n\nWrite a job description:`,
  },
  'restaurant-name': {
    required: ['cuisine'],
    maxLengths: { cuisine: 50, vibe: 100, location: 100, keywords: 200 },
    systemPrompt: `You are a creative branding expert for restaurants. Generate 10 unique, memorable restaurant name ideas. Each name should be easy to pronounce, memorable, and relevant to the cuisine/vibe. Include a brief 1-line explanation for each. Return as a numbered list with format: "Name — explanation".`,
    buildUserPrompt: (p) =>
      `Cuisine: ${p.cuisine}\nVibe: ${p.vibe || 'casual'}\nLocation: ${p.location || 'India'}\nKeywords/themes: ${p.keywords || 'None'}\n\nGenerate 10 restaurant name ideas:`,
  },
};

// Strip HTML tags from string
function stripHTML(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').trim();
}

// Validate and sanitize inputs
function validateInput(tool, params) {
  const toolDef = TOOLS[tool];
  if (!toolDef) {
    return { valid: false, error: `Unknown tool: ${tool}` };
  }

  // Check required fields
  for (const field of toolDef.required) {
    if (!params[field] || stripHTML(params[field]).length === 0) {
      return { valid: false, error: `Missing required field: ${field}` };
    }
  }

  // Sanitize and check lengths
  const sanitized = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string') continue;
    const clean = stripHTML(value);
    const maxLen = toolDef.maxLengths?.[key];
    if (maxLen && clean.length > maxLen) {
      return {
        valid: false,
        error: `${key} exceeds maximum length of ${maxLen} characters`,
      };
    }
    sanitized[key] = clean;
  }

  return { valid: true, sanitized };
}

// POST /tools/ai-generate
router.post(
  '/ai-generate',
  publicToolsLimiter.middleware(),
  async (req, res) => {
    try {
      const { tool, params } = req.body;

      if (!tool || !params) {
        return res.status(400).json({ error: 'Missing tool or params in request body' });
      }

      const validation = validateInput(tool, params);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      const toolDef = TOOLS[tool];
      const userPrompt = toolDef.buildUserPrompt(validation.sanitized);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: toolDef.systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1000,
        temperature: 0.8,
      });

      const result = completion.choices[0]?.message?.content || '';

      // Record usage after successful generation
      const ip = publicToolsLimiter.getIP(req);
      await publicToolsLimiter.recordUsage(ip, tool);

      res.json({
        result,
        remaining: req.publicToolUsage?.remaining ?? null,
        tool,
      });
    } catch (error) {
      console.error('Public AI tool error:', error);

      if (error?.status === 429 || error?.code === 'rate_limit_exceeded') {
        return res.status(503).json({
          error: 'AI service temporarily busy. Please try again in a moment.',
          code: 'AI_RATE_LIMIT',
        });
      }

      res.status(500).json({
        error: 'Failed to generate content. Please try again.',
        code: 'GENERATION_FAILED',
      });
    }
  }
);

module.exports = router;
