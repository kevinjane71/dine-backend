const OpenAI = require('openai');
const db = require('../firebase');

class AiRecipeService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  /**
   * Generates a default recipe (ingredients and quantities) for a menu item using OpenAI.
   * @param {string} itemName - The name of the menu item (e.g., "Butter Chicken").
   * @param {string} description - Optional description.
   * @returns {Promise<Array>} - List of ingredients.
   */
  async generateRecipe(itemName, description = '') {
    try {
      console.log(`🤖 Generating AI recipe for: ${itemName}`);

      const prompt = `
        You are an expert chef and restaurant manager. 
        Create a standard commercial recipe for one serving of "${itemName}" ${description ? `(${description})` : ''}.
        
        Return ONLY a valid JSON object with a single key "ingredients" containing an array of objects.
        Each object must have:
        - "name": Common name of the ingredient (e.g., "Chicken Breast", "Butter", "Heavy Cream").
        - "quantity": Numeric value for one serving (number only).
        - "unit": Standard metric unit (g, ml, kg, l, pcs). Use 'g' or 'ml' for small amounts.

        Example output:
        {
          "ingredients": [
            { "name": "Chicken Breast", "quantity": 200, "unit": "g" },
            { "name": "Butter", "quantity": 30, "unit": "g" }
          ]
        }
        
        Do not include instructions, just the bill of materials.
      `;

      const completion = await this.openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            { role: "system", content: "You are a helpful culinary AI assistant that outputs strictly valid JSON." },
            { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      });

      const result = JSON.parse(completion.choices[0].message.content);
      
      if (!result.ingredients || !Array.isArray(result.ingredients)) {
        console.warn('⚠️ AI returned invalid recipe format:', result);
        return [];
      }

      return result.ingredients;

    } catch (error) {
      console.error('❌ Error generating AI recipe:', error);
      return []; // Return empty on error to not break the flow
    }
  }
}

module.exports = new AiRecipeService();


