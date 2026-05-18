const express = require('express');
const router = express.Router();
const { db, collections } = require('../firebase');
const { authenticateToken } = require('../middleware/auth');
const crypto = require('crypto');
const feedbackAI = require('../services/feedbackAIService');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.dineopen.com';

// Pre-built templates
const TEMPLATES = {
  restaurant_dining: {
    id: 'restaurant_dining',
    title: 'Dining Experience Survey',
    description: 'Collect feedback about your restaurant dining experience',
    questions: [
      { type: 'rating_stars', title: 'How would you rate your overall dining experience?', required: true, maxRating: 5, options: null, description: null },
      { type: 'rating_stars', title: 'How was the food quality?', required: true, maxRating: 5, options: null, description: null },
      { type: 'rating_stars', title: 'How was the service?', required: true, maxRating: 5, options: null, description: null },
      { type: 'single_choice', title: 'How was the wait time?', required: true, options: ['Very Quick', 'Reasonable', 'A bit long', 'Too long'], maxRating: null, description: null },
      { type: 'rating_emoji', title: 'How was the ambiance?', required: true, maxRating: 5, options: null, description: null },
      { type: 'nps', title: 'How likely are you to recommend us to a friend or colleague?', required: true, options: null, maxRating: null, description: 'On a scale of 0-10' },
      { type: 'text', title: 'Any suggestions for improvement?', required: false, options: null, maxRating: null, description: 'We value your feedback' },
    ]
  },
  quick_service: {
    id: 'quick_service',
    title: 'Quick Service Feedback',
    description: 'Quick feedback for fast food and QSR outlets',
    questions: [
      { type: 'rating_emoji', title: 'How was your experience today?', required: true, maxRating: 5, options: null, description: null },
      { type: 'rating_stars', title: 'Rate the food quality', required: true, maxRating: 5, options: null, description: null },
      { type: 'single_choice', title: 'Was your order accurate?', required: true, options: ['Yes, perfect', 'Minor issue', 'Wrong order'], maxRating: null, description: null },
      { type: 'single_choice', title: 'How was the speed of service?', required: true, options: ['Very Fast', 'Okay', 'Slow', 'Very Slow'], maxRating: null, description: null },
      { type: 'nps', title: 'Would you visit us again?', required: true, options: null, maxRating: null, description: 'On a scale of 0-10' },
      { type: 'text', title: 'Anything else you want us to know?', required: false, options: null, maxRating: null, description: null },
    ]
  },
  bar_pub: {
    id: 'bar_pub',
    title: 'Bar & Lounge Feedback',
    description: 'Feedback form for bars, pubs and lounges',
    questions: [
      { type: 'rating_stars', title: 'How would you rate the drinks?', required: true, maxRating: 5, options: null, description: null },
      { type: 'rating_stars', title: 'How was the atmosphere?', required: true, maxRating: 5, options: null, description: null },
      { type: 'rating_stars', title: 'How was the music/entertainment?', required: true, maxRating: 5, options: null, description: null },
      { type: 'single_choice', title: 'How was the bartender/staff?', required: true, options: ['Excellent', 'Good', 'Average', 'Poor'], maxRating: null, description: null },
      { type: 'multiple_choice', title: 'What did you enjoy most?', required: false, options: ['Drinks', 'Food', 'Music', 'Ambiance', 'Service', 'Happy Hour Deals'], maxRating: null, description: 'Select all that apply' },
      { type: 'nps', title: 'Would you recommend us to friends?', required: true, options: null, maxRating: null, description: 'On a scale of 0-10' },
      { type: 'text', title: 'Share your thoughts with us', required: false, options: null, maxRating: null, description: null },
    ]
  },
  delivery: {
    id: 'delivery',
    title: 'Delivery Experience Feedback',
    description: 'Feedback for delivery and takeaway orders',
    questions: [
      { type: 'rating_stars', title: 'Rate your overall delivery experience', required: true, maxRating: 5, options: null, description: null },
      { type: 'single_choice', title: 'Was the delivery on time?', required: true, options: ['Early', 'On time', 'Slightly delayed', 'Very late'], maxRating: null, description: null },
      { type: 'rating_stars', title: 'How was the food quality on arrival?', required: true, maxRating: 5, options: null, description: null },
      { type: 'yes_no', title: 'Was the packaging satisfactory?', required: true, options: null, maxRating: null, description: null },
      { type: 'yes_no', title: 'Was your order complete and accurate?', required: true, options: null, maxRating: null, description: null },
      { type: 'nps', title: 'How likely are you to order from us again?', required: true, options: null, maxRating: null, description: 'On a scale of 0-10' },
      { type: 'text', title: 'Any feedback about the delivery?', required: false, options: null, maxRating: null, description: null },
    ]
  },
  cafe: {
    id: 'cafe',
    title: 'Cafe Experience Survey',
    description: 'Feedback form for cafes and coffee shops',
    questions: [
      { type: 'rating_emoji', title: 'How was your visit today?', required: true, maxRating: 5, options: null, description: null },
      { type: 'rating_stars', title: 'Rate the quality of your beverage', required: true, maxRating: 5, options: null, description: null },
      { type: 'rating_stars', title: 'Rate the food/snacks', required: false, maxRating: 5, options: null, description: 'If you ordered any' },
      { type: 'single_choice', title: 'How was the cafe ambiance?', required: true, options: ['Loved it', 'Nice', 'Average', 'Not great'], maxRating: null, description: null },
      { type: 'multiple_choice', title: 'What brings you to our cafe?', required: false, options: ['Coffee', 'Food', 'Work/Study', 'Meeting friends', 'Ambiance'], maxRating: null, description: 'Select all that apply' },
      { type: 'nps', title: 'Would you recommend our cafe?', required: true, options: null, maxRating: null, description: 'On a scale of 0-10' },
      { type: 'text', title: 'What could we do better?', required: false, options: null, maxRating: null, description: null },
    ]
  },
};

function generateShortCode() {
  return crypto.randomBytes(4).toString('hex'); // 8-char hex
}

function addQuestionIds(questions) {
  return questions.map((q, idx) => ({
    ...q,
    id: crypto.randomUUID(),
    order: idx,
  }));
}

// ============================================================
// AUTHENTICATED ENDPOINTS
// ============================================================

// GET /:restaurantId/forms - List all forms
router.get('/:restaurantId/forms', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snapshot = await db.collection(collections.feedbackForms)
      .where('restaurantId', '==', restaurantId)
      .where('status', 'in', ['draft', 'active', 'archived'])
      .orderBy('updatedAt', 'desc')
      .get();
    const forms = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, forms });
  } catch (error) {
    console.error('❌ Error fetching feedback forms:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch forms' });
  }
});

// POST /:restaurantId/forms - Create form
router.post('/:restaurantId/forms', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { title, description, questions, branding, templateId, aiGenerated } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const shortCode = generateShortCode();
    const now = new Date().toISOString();
    const formData = {
      restaurantId,
      title,
      description: description || '',
      status: 'draft',
      branding: branding || {
        restaurantName: '',
        logoUrl: null,
        primaryColor: '#ef4444',
        backgroundColor: '#f8fafc',
        thankYouMessage: 'Thank you for your feedback!',
      },
      questions: addQuestionIds(questions || []),
      distribution: {
        linkEnabled: true,
        qrEnabled: false,
        whatsappEnabled: false,
        shortCode,
      },
      responseCount: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: req.user.userId,
      templateId: templateId || null,
      aiGenerated: aiGenerated || false,
    };

    const docRef = await db.collection(collections.feedbackForms).add(formData);
    res.status(201).json({ success: true, form: { id: docRef.id, ...formData } });
  } catch (error) {
    console.error('❌ Error creating feedback form:', error);
    res.status(500).json({ success: false, error: 'Failed to create form' });
  }
});

// GET /:restaurantId/forms/:formId - Get form details
router.get('/:restaurantId/forms/:formId', authenticateToken, async (req, res) => {
  try {
    const { formId } = req.params;
    const doc = await db.collection(collections.feedbackForms).doc(formId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Form not found' });
    res.json({ success: true, form: { id: doc.id, ...doc.data() } });
  } catch (error) {
    console.error('❌ Error fetching feedback form:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch form' });
  }
});

// PUT /:restaurantId/forms/:formId - Update form
router.put('/:restaurantId/forms/:formId', authenticateToken, async (req, res) => {
  try {
    const { formId } = req.params;
    const updates = req.body;
    const docRef = db.collection(collections.feedbackForms).doc(formId);
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Form not found' });

    // If questions are updated, ensure they have IDs
    if (updates.questions) {
      updates.questions = updates.questions.map((q, idx) => ({
        ...q,
        id: q.id || crypto.randomUUID(),
        order: idx,
      }));
    }

    updates.updatedAt = new Date().toISOString();
    await docRef.update(updates);
    const updated = await docRef.get();
    res.json({ success: true, form: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('❌ Error updating feedback form:', error);
    res.status(500).json({ success: false, error: 'Failed to update form' });
  }
});

// DELETE /:restaurantId/forms/:formId - Archive form
router.delete('/:restaurantId/forms/:formId', authenticateToken, async (req, res) => {
  try {
    const { formId } = req.params;
    await db.collection(collections.feedbackForms).doc(formId).update({
      status: 'deleted',
      updatedAt: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error deleting feedback form:', error);
    res.status(500).json({ success: false, error: 'Failed to delete form' });
  }
});

// GET /templates - List available templates
router.get('/templates/list', async (req, res) => {
  const templateList = Object.values(TEMPLATES).map(t => ({
    id: t.id,
    title: t.title,
    description: t.description,
    questionCount: t.questions.length,
  }));
  res.json({ success: true, templates: templateList });
});

// GET /templates/:templateId - Get template with questions
router.get('/templates/:templateId', async (req, res) => {
  const template = TEMPLATES[req.params.templateId];
  if (!template) return res.status(404).json({ error: 'Template not found' });
  res.json({ success: true, template });
});

// GET /:restaurantId/forms/:formId/analytics - Form analytics
router.get('/:restaurantId/forms/:formId/analytics', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, formId } = req.params;
    const { startDate, endDate } = req.query;

    let query = db.collection(collections.feedbackResponses)
      .where('formId', '==', formId)
      .where('restaurantId', '==', restaurantId);

    if (startDate) query = query.where('submittedAt', '>=', startDate);
    if (endDate) query = query.where('submittedAt', '<=', endDate);

    const snapshot = await query.orderBy('submittedAt', 'desc').get();
    const responses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Compute analytics
    const totalResponses = responses.length;
    let totalRating = 0;
    let ratingCount = 0;
    let npsScores = [];
    let sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    const questionStats = {};

    responses.forEach(resp => {
      if (resp.sentiment) sentimentCounts[resp.sentiment]++;
      (resp.answers || []).forEach(answer => {
        if (!questionStats[answer.questionId]) {
          questionStats[answer.questionId] = { title: answer.questionTitle, type: answer.questionType, values: [] };
        }
        questionStats[answer.questionId].values.push(answer.value);

        if (['rating_stars', 'rating_emoji'].includes(answer.questionType) && typeof answer.value === 'number') {
          totalRating += answer.value;
          ratingCount++;
        }
        if (answer.questionType === 'nps' && typeof answer.value === 'number') {
          npsScores.push(answer.value);
        }
      });
    });

    const avgRating = ratingCount > 0 ? Math.round((totalRating / ratingCount) * 10) / 10 : null;

    // NPS calculation: (% promoters - % detractors)
    let npsScore = null;
    if (npsScores.length > 0) {
      const promoters = npsScores.filter(s => s >= 9).length;
      const detractors = npsScores.filter(s => s <= 6).length;
      npsScore = Math.round(((promoters - detractors) / npsScores.length) * 100);
    }

    // Per-question breakdowns
    const questionBreakdowns = Object.entries(questionStats).map(([qId, stat]) => {
      const breakdown = { questionId: qId, title: stat.title, type: stat.type, responseCount: stat.values.length };
      if (['rating_stars', 'rating_emoji'].includes(stat.type)) {
        const nums = stat.values.filter(v => typeof v === 'number');
        breakdown.average = nums.length > 0 ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
        breakdown.distribution = {};
        nums.forEach(v => { breakdown.distribution[v] = (breakdown.distribution[v] || 0) + 1; });
      }
      if (['single_choice', 'multiple_choice', 'yes_no'].includes(stat.type)) {
        breakdown.distribution = {};
        stat.values.flat().forEach(v => { breakdown.distribution[v] = (breakdown.distribution[v] || 0) + 1; });
      }
      if (stat.type === 'nps') {
        const nums = stat.values.filter(v => typeof v === 'number');
        breakdown.average = nums.length > 0 ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
        breakdown.promoters = nums.filter(v => v >= 9).length;
        breakdown.passives = nums.filter(v => v >= 7 && v <= 8).length;
        breakdown.detractors = nums.filter(v => v <= 6).length;
      }
      return breakdown;
    });

    res.json({
      success: true,
      analytics: {
        totalResponses,
        avgRating,
        npsScore,
        sentimentCounts,
        questionBreakdowns,
      }
    });
  } catch (error) {
    console.error('❌ Error fetching analytics:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// GET /:restaurantId/analytics/overview - Cross-form overview
router.get('/:restaurantId/analytics/overview', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { days } = req.query;
    const daysBack = parseInt(days) || 30;
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

    const [formsSnap, responsesSnap] = await Promise.all([
      db.collection(collections.feedbackForms).where('restaurantId', '==', restaurantId).where('status', 'in', ['draft', 'active', 'archived']).get(),
      db.collection(collections.feedbackResponses).where('restaurantId', '==', restaurantId).where('submittedAt', '>=', since).orderBy('submittedAt', 'desc').get(),
    ]);

    const forms = formsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const responses = responsesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    let totalRating = 0, ratingCount = 0, npsScores = [];
    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    const dailyCounts = {};

    responses.forEach(resp => {
      if (resp.sentiment) sentimentCounts[resp.sentiment]++;
      const day = (resp.submittedAt || '').slice(0, 10);
      if (day) dailyCounts[day] = (dailyCounts[day] || 0) + 1;
      (resp.answers || []).forEach(a => {
        if (['rating_stars', 'rating_emoji'].includes(a.questionType) && typeof a.value === 'number') {
          totalRating += a.value;
          ratingCount++;
        }
        if (a.questionType === 'nps' && typeof a.value === 'number') npsScores.push(a.value);
      });
    });

    const avgRating = ratingCount > 0 ? Math.round((totalRating / ratingCount) * 10) / 10 : null;
    let npsScore = null;
    if (npsScores.length > 0) {
      const promoters = npsScores.filter(s => s >= 9).length;
      const detractors = npsScores.filter(s => s <= 6).length;
      npsScore = Math.round(((promoters - detractors) / npsScores.length) * 100);
    }

    res.json({
      success: true,
      overview: {
        totalForms: forms.length,
        activeForms: forms.filter(f => f.status === 'active').length,
        totalResponses: responses.length,
        avgRating,
        npsScore,
        sentimentCounts,
        dailyCounts,
      }
    });
  } catch (error) {
    console.error('❌ Error fetching overview:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch overview' });
  }
});

// GET /:restaurantId/responses - List responses
router.get('/:restaurantId/responses', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { formId, startDate, endDate, sentiment, limit: limitStr } = req.query;
    const pageLimit = Math.min(parseInt(limitStr) || 50, 200);

    let query = db.collection(collections.feedbackResponses)
      .where('restaurantId', '==', restaurantId);
    if (formId) query = query.where('formId', '==', formId);
    if (sentiment) query = query.where('sentiment', '==', sentiment);
    if (startDate) query = query.where('submittedAt', '>=', startDate);
    if (endDate) query = query.where('submittedAt', '<=', endDate);

    const snapshot = await query.orderBy('submittedAt', 'desc').limit(pageLimit).get();
    const responses = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, responses });
  } catch (error) {
    console.error('❌ Error fetching responses:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch responses' });
  }
});

// GET /:restaurantId/responses/export - CSV export
router.get('/:restaurantId/responses/export', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { formId, startDate, endDate } = req.query;

    let query = db.collection(collections.feedbackResponses)
      .where('restaurantId', '==', restaurantId);
    if (formId) query = query.where('formId', '==', formId);
    if (startDate) query = query.where('submittedAt', '>=', startDate);
    if (endDate) query = query.where('submittedAt', '<=', endDate);

    const snapshot = await query.orderBy('submittedAt', 'desc').get();
    const responses = snapshot.docs.map(doc => doc.data());

    if (responses.length === 0) {
      return res.status(200).send('No responses found');
    }

    // Build CSV
    const allQuestions = new Map();
    responses.forEach(r => {
      (r.answers || []).forEach(a => {
        if (!allQuestions.has(a.questionId)) {
          allQuestions.set(a.questionId, a.questionTitle || a.questionId);
        }
      });
    });

    const questionIds = [...allQuestions.keys()];
    const headers = ['Submitted At', 'Source', 'Customer Name', 'Customer Phone', 'Order ID', 'Sentiment', ...questionIds.map(id => allQuestions.get(id))];

    const csvRows = [headers.join(',')];
    responses.forEach(r => {
      const answerMap = {};
      (r.answers || []).forEach(a => { answerMap[a.questionId] = Array.isArray(a.value) ? a.value.join('; ') : String(a.value ?? ''); });
      const row = [
        r.submittedAt || '',
        r.source || '',
        (r.customerName || '').replace(/,/g, ''),
        r.customerPhone || '',
        r.orderId || '',
        r.sentiment || '',
        ...questionIds.map(id => (answerMap[id] || '').replace(/,/g, '')),
      ];
      csvRows.push(row.join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=feedback-responses.csv');
    res.send(csvRows.join('\n'));
  } catch (error) {
    console.error('❌ Error exporting responses:', error);
    res.status(500).json({ success: false, error: 'Failed to export' });
  }
});

// POST /:restaurantId/forms/ai-generate - AI generates questions
router.post('/:restaurantId/forms/ai-generate', authenticateToken, async (req, res) => {
  try {
    const { prompt, restaurantType } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const result = await feedbackAI.generateFormQuestions(prompt, restaurantType);
    if (!result.success) return res.status(500).json({ error: result.error || 'AI generation failed' });

    res.json({
      success: true,
      title: result.title,
      description: result.description,
      questions: result.questions,
    });
  } catch (error) {
    console.error('❌ Error generating AI form:', error);
    res.status(500).json({ success: false, error: 'Failed to generate form' });
  }
});

// POST /:restaurantId/forms/:formId/ai-insights - Generate AI insights
router.post('/:restaurantId/forms/:formId/ai-insights', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, formId } = req.params;

    // Get form
    const formDoc = await db.collection(collections.feedbackForms).doc(formId).get();
    if (!formDoc.exists) return res.status(404).json({ error: 'Form not found' });

    // Get responses
    const snapshot = await db.collection(collections.feedbackResponses)
      .where('formId', '==', formId)
      .where('restaurantId', '==', restaurantId)
      .orderBy('submittedAt', 'desc')
      .limit(200)
      .get();
    const responses = snapshot.docs.map(doc => doc.data());

    if (responses.length < 3) {
      return res.status(400).json({ error: 'Need at least 3 responses to generate insights' });
    }

    // Compute quick analytics for AI
    let totalRating = 0, ratingCount = 0, npsScores = [];
    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
    const questionStats = {};

    responses.forEach(resp => {
      if (resp.sentiment) sentimentCounts[resp.sentiment]++;
      (resp.answers || []).forEach(a => {
        if (!questionStats[a.questionId]) questionStats[a.questionId] = { title: a.questionTitle, type: a.questionType, values: [] };
        questionStats[a.questionId].values.push(a.value);
        if (['rating_stars', 'rating_emoji'].includes(a.questionType) && typeof a.value === 'number') { totalRating += a.value; ratingCount++; }
        if (a.questionType === 'nps' && typeof a.value === 'number') npsScores.push(a.value);
      });
    });

    const avgRating = ratingCount > 0 ? Math.round((totalRating / ratingCount) * 10) / 10 : null;
    let npsScore = null;
    if (npsScores.length > 0) {
      npsScore = Math.round(((npsScores.filter(s => s >= 9).length - npsScores.filter(s => s <= 6).length) / npsScores.length) * 100);
    }

    const questionBreakdowns = Object.entries(questionStats).map(([qId, stat]) => {
      const bd = { questionId: qId, title: stat.title, type: stat.type, responseCount: stat.values.length };
      if (['rating_stars', 'rating_emoji'].includes(stat.type)) {
        const nums = stat.values.filter(v => typeof v === 'number');
        bd.average = nums.length > 0 ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null;
      }
      if (['single_choice', 'multiple_choice', 'yes_no'].includes(stat.type)) {
        bd.distribution = {};
        stat.values.flat().forEach(v => { bd.distribution[v] = (bd.distribution[v] || 0) + 1; });
      }
      return bd;
    });

    const result = await feedbackAI.generateInsights(
      { totalResponses: responses.length, avgRating, npsScore, sentimentCounts, questionBreakdowns },
      formDoc.data().title
    );

    if (!result.success) return res.status(500).json({ error: result.error || 'AI insights failed' });
    res.json({ success: true, insights: result.insights });
  } catch (error) {
    console.error('❌ Error generating insights:', error);
    res.status(500).json({ success: false, error: 'Failed to generate insights' });
  }
});

// ============================================================
// PUBLIC ENDPOINTS (no auth)
// ============================================================

// GET /public/form/:formId - Get form for public rendering
router.get('/public/form/:formId', async (req, res) => {
  try {
    const doc = await db.collection(collections.feedbackForms).doc(req.params.formId).get();
    if (!doc.exists || doc.data().status !== 'active') {
      return res.status(404).json({ error: 'Form not found or not active' });
    }
    const data = doc.data();
    res.json({
      success: true,
      form: {
        id: doc.id,
        title: data.title,
        description: data.description,
        branding: data.branding,
        questions: data.questions,
      }
    });
  } catch (error) {
    console.error('❌ Error fetching public form:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch form' });
  }
});

// POST /public/form/:formId/submit - Submit response
router.post('/public/form/:formId/submit', async (req, res) => {
  try {
    const { formId } = req.params;
    const { answers, customerName, customerPhone, orderId, source } = req.body;

    const formDoc = await db.collection(collections.feedbackForms).doc(formId).get();
    if (!formDoc.exists || formDoc.data().status !== 'active') {
      return res.status(404).json({ error: 'Form not found or not active' });
    }

    const formData = formDoc.data();

    // Basic sentiment analysis from text answers
    let sentiment = null;
    let sentimentScore = null;
    const textAnswers = (answers || []).filter(a => a.questionType === 'text' && a.value).map(a => a.value);
    const ratingAnswers = (answers || []).filter(a => ['rating_stars', 'rating_emoji', 'nps'].includes(a.questionType) && typeof a.value === 'number');

    if (ratingAnswers.length > 0) {
      const avgScore = ratingAnswers.reduce((sum, a) => {
        if (a.questionType === 'nps') return sum + (a.value / 10); // Normalize NPS to 0-1
        return sum + (a.value / (a.maxRating || 5)); // Normalize rating to 0-1
      }, 0) / ratingAnswers.length;

      sentimentScore = Math.round((avgScore * 2 - 1) * 100) / 100; // Map 0-1 to -1 to 1
      sentiment = sentimentScore > 0.2 ? 'positive' : sentimentScore < -0.2 ? 'negative' : 'neutral';
    }

    const responseData = {
      formId,
      restaurantId: formData.restaurantId,
      answers: answers || [],
      orderId: orderId || null,
      customerPhone: customerPhone || null,
      customerName: customerName || null,
      source: source || 'link',
      sentiment,
      sentimentScore,
      submittedAt: new Date().toISOString(),
      userAgent: req.headers['user-agent'] || null,
    };

    const docRef = await db.collection(collections.feedbackResponses).add(responseData);

    // Increment response count on form
    await db.collection(collections.feedbackForms).doc(formId).update({
      responseCount: (formData.responseCount || 0) + 1,
      updatedAt: new Date().toISOString(),
    });

    res.status(201).json({ success: true, responseId: docRef.id });
  } catch (error) {
    console.error('❌ Error submitting feedback:', error);
    res.status(500).json({ success: false, error: 'Failed to submit feedback' });
  }
});

// GET /public/form/s/:shortCode - Resolve short code
router.get('/public/form/s/:shortCode', async (req, res) => {
  try {
    const snapshot = await db.collection(collections.feedbackForms)
      .where('distribution.shortCode', '==', req.params.shortCode)
      .where('status', '==', 'active')
      .limit(1)
      .get();

    if (snapshot.empty) return res.status(404).json({ error: 'Form not found' });
    const formId = snapshot.docs[0].id;
    res.json({ success: true, formId, redirectUrl: `${FRONTEND_URL}/feedback/${formId}` });
  } catch (error) {
    console.error('❌ Error resolving short code:', error);
    res.status(500).json({ success: false, error: 'Failed to resolve' });
  }
});

module.exports = router;
