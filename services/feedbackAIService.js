const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FORM_GENERATION_SYSTEM_PROMPT = `You are an expert at creating customer feedback forms for restaurants and food businesses.
Generate a structured feedback form based on the user's description. Return a JSON object with this exact structure:

{
  "title": "Form title",
  "description": "Short subtitle for the form",
  "questions": [
    {
      "type": "rating_stars" | "rating_emoji" | "single_choice" | "multiple_choice" | "text" | "nps" | "yes_no",
      "title": "Question text",
      "description": "Optional help text or null",
      "required": true/false,
      "options": ["Option 1", "Option 2"] or null (only for single_choice and multiple_choice),
      "maxRating": 5 or null (only for rating_stars and rating_emoji)
    }
  ]
}

Guidelines:
- Keep 5-8 questions maximum
- Start with an engaging emoji-based or star rating question
- Include a mix of question types for variety
- Always include an NPS question near the end
- End with an optional text question for open feedback
- Make questions specific to the restaurant type/context described
- Keep question text concise and friendly
- For choice questions, provide 3-5 clear options`;

const INSIGHTS_SYSTEM_PROMPT = `You are a restaurant analytics expert. Analyze the customer feedback data and provide actionable insights.
Return a JSON object with:
{
  "summary": "2-3 sentence overall summary",
  "strengths": ["strength 1", "strength 2"],
  "improvements": ["area 1", "area 2"],
  "actionItems": ["specific action 1", "specific action 2"],
  "trends": "Brief note on any trends spotted"
}
Keep insights practical and specific to the restaurant industry.`;

async function generateFormQuestions(prompt, restaurantType) {
  try {
    const userPrompt = restaurantType
      ? `Create a customer feedback form for a ${restaurantType} restaurant. Additional context: ${prompt}`
      : `Create a customer feedback form. Context: ${prompt}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: FORM_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
      max_tokens: 2000,
    });

    const result = JSON.parse(response.choices[0].message.content);
    return { success: true, ...result };
  } catch (error) {
    console.error('❌ AI form generation error:', error);
    return { success: false, error: error.message };
  }
}

async function analyzeSentiment(textAnswers) {
  if (!textAnswers || textAnswers.length === 0) return null;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Analyze the sentiment of these customer feedback texts. Return JSON: {"sentiment": "positive"|"neutral"|"negative", "score": -1 to 1}' },
        { role: 'user', content: textAnswers.join('\n') }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 100,
    });
    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error('❌ Sentiment analysis error:', error);
    return null;
  }
}

async function generateInsights(analyticsData, formTitle) {
  try {
    const dataStr = JSON.stringify({
      formTitle,
      totalResponses: analyticsData.totalResponses,
      avgRating: analyticsData.avgRating,
      npsScore: analyticsData.npsScore,
      sentimentCounts: analyticsData.sentimentCounts,
      questionBreakdowns: analyticsData.questionBreakdowns,
    });

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: INSIGHTS_SYSTEM_PROMPT },
        { role: 'user', content: `Analyze this restaurant feedback data and provide insights:\n${dataStr}` }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_tokens: 1500,
    });

    return { success: true, insights: JSON.parse(response.choices[0].message.content) };
  } catch (error) {
    console.error('❌ AI insights generation error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  generateFormQuestions,
  analyzeSentiment,
  generateInsights,
};
