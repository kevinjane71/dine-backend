/**
 * DineAI Cheap Voice Service
 * Cost-effective voice assistant using:
 * - Web Speech API for STT (FREE - handled on frontend)
 * - GPT-4o-mini for responses (very cheap)
 * - TTS API for speech output (cheap)
 *
 * 95% cheaper than OpenAI Realtime API!
 */

const OpenAI = require('openai');
const { getDb } = require('../../firebase');
const DineAIToolExecutor = require('./DineAIToolExecutor');
const dineaiPermissions = require('./DineAIPermissions');

class DineAICheapVoiceService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.toolExecutor = new DineAIToolExecutor();
    this.activeSessions = new Map();
  }

  /**
   * Build a concise system prompt to minimize token usage
   */
  buildSystemPrompt(restaurantData, userData) {
    const restaurantName = restaurantData?.name || 'the restaurant';
    const userName = userData?.name || 'there';
    const userRole = userData?.role || 'staff';

    // Keep prompt SHORT to reduce token costs
    return `You are DineAI, voice assistant for ${restaurantName}. Help ${userName} (${userRole}) with orders, tables, menu.

RULES:
- Be BRIEF (1-2 sentences max)
- Speak naturally: "Got it!", "Sure!", "Done!"
- Numbers: "table five", "two fifty rupees"
- Always use functions for actions
- Ask ONE question at a time
- For orders: ask items first, table is optional

ORDER WORKFLOW:
1. place_order: items required, table optional (validates table availability)
2. update_order: add items/instructions to existing order (use order_id)
3. complete_billing: finalize payment (releases table)

FUNCTIONS:
- place_order: Create orders (items required, ask table if dine-in)
- update_order: Add items, change table, add special instructions to existing order
- get_item_availability: Check price/availability
- search_menu_items: Find menu items by name
- get_menu: Browse full menu
- get_orders: Check order status by ID or list orders
- get_table_order: Get active order for a table
- get_tables: See available tables
- complete_billing: Complete payment (cash/card/upi)
- update_order_status: Update order status
- get_today_summary: Today's stats (manager+)

EXAMPLES:
- "Place order 2 paneer, 1 dal for table 5" -> place_order with items, table_number
- "Add extra raita to order 12" -> update_order with add_items
- "What's the price of paneer butter masala" -> get_item_availability
- "Complete billing for order 15, cash" -> complete_billing

When user says "stop", "close", "bye", "cancel" - say goodbye briefly.`;
  }

  /**
   * Create a new cheap voice session
   */
  async createSession(restaurantId, userId, userRole) {
    try {
      const db = getDb();

      // Get restaurant data
      const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
      const restaurantData = restaurantDoc.exists ? restaurantDoc.data() : {};

      // Get user data
      const userRestaurantDoc = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      const userData = userRestaurantDoc.empty
        ? { name: 'User', role: userRole }
        : userRestaurantDoc.docs[0].data();

      // Generate session ID
      const sessionId = `cv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(restaurantData, userData);

      // Store session
      this.activeSessions.set(sessionId, {
        sessionId,
        restaurantId,
        userId,
        userRole,
        restaurantData,
        userData,
        systemPrompt,
        conversationHistory: [],
        createdAt: new Date()
      });

      // Store in Firestore
      await db.collection('dineai_cheap_sessions').doc(sessionId).set({
        sessionId,
        restaurantId,
        userId,
        userRole,
        voiceMode: 'cheap-realtime',
        status: 'active',
        messageCount: 0,
        createdAt: new Date()
      });

      console.log(`🎤 Cheap voice session created: ${sessionId}`);

      return {
        success: true,
        sessionId,
        greeting: `Hi ${userData.name || 'there'}! I'm ready to help. What would you like to do?`
      };
    } catch (error) {
      console.error('Error creating cheap voice session:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process a voice message (text from Web Speech API)
   */
  async processMessage(sessionId, userText, restaurantId, userId, userRole) {
    console.log(`\n🎤 ==================== Cheap Voice Message ====================`);
    console.log(`🎤 Session: ${sessionId}`);
    console.log(`🎤 User said: "${userText}"`);
    console.log(`🎤 Restaurant: ${restaurantId}`);

    try {
      // Get or create session
      let session = this.activeSessions.get(sessionId);

      if (!session) {
        // Try to restore from Firestore
        const db = getDb();
        const sessionDoc = await db.collection('dineai_cheap_sessions').doc(sessionId).get();

        if (sessionDoc.exists) {
          const sessionData = sessionDoc.data();
          const restaurantDoc = await db.collection('restaurants').doc(sessionData.restaurantId).get();
          const restaurantData = restaurantDoc.exists ? restaurantDoc.data() : {};

          session = {
            sessionId,
            restaurantId: sessionData.restaurantId,
            userId: sessionData.userId,
            userRole: sessionData.userRole,
            restaurantData,
            userData: { name: 'User', role: sessionData.userRole },
            systemPrompt: this.buildSystemPrompt(restaurantData, { role: sessionData.userRole }),
            conversationHistory: [],
            createdAt: new Date(sessionData.createdAt)
          };

          this.activeSessions.set(sessionId, session);
        } else {
          // Create new session on the fly
          const createResult = await this.createSession(restaurantId, userId, userRole);
          if (!createResult.success) {
            return { success: false, error: 'Session not found' };
          }
          session = this.activeSessions.get(createResult.sessionId);
        }
      }

      // Check for stop commands
      const stopCommands = ['stop', 'close', 'bye', 'goodbye', 'cancel', 'exit', 'quit', 'band karo', 'ruk jao'];
      const lowerText = userText.toLowerCase().trim();

      if (stopCommands.some(cmd => lowerText.includes(cmd))) {
        console.log(`🎤 Stop command detected`);
        return {
          success: true,
          response: "Goodbye! Let me know when you need help again.",
          shouldClose: true,
          functionCalled: null
        };
      }

      // Add user message to history
      session.conversationHistory.push({
        role: 'user',
        content: userText
      });

      // Keep only last 10 messages to minimize tokens
      if (session.conversationHistory.length > 10) {
        session.conversationHistory = session.conversationHistory.slice(-10);
      }

      // Get tools for user role
      const tools = this.toolExecutor.getToolsForRole(session.userRole);

      // Call GPT-4o-mini (CHEAP!)
      console.log(`🎤 Calling GPT-4o-mini...`);
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: session.systemPrompt },
          ...session.conversationHistory
        ],
        tools: tools,
        tool_choice: 'auto',
        max_tokens: 150, // Keep responses short
        temperature: 0.7
      });

      const message = completion.choices[0].message;
      let responseText = message.content || '';
      let functionCalled = null;
      let functionResult = null;

      console.log(`🎤 GPT response: "${responseText}"`);
      console.log(`🎤 Tool calls: ${message.tool_calls?.length || 0}`);

      // Handle function calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0];
        functionCalled = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        console.log(`🎤 Executing function: ${functionCalled}`);
        console.log(`🎤 Args:`, JSON.stringify(args));

        // Execute the function
        functionResult = await this.toolExecutor.executeFunction(
          functionCalled,
          args,
          session.restaurantId,
          session.userId,
          session.userRole
        );

        console.log(`🎤 Function result:`, JSON.stringify(functionResult).substring(0, 200));

        // Get final response with function result
        const followUp = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: session.systemPrompt },
            ...session.conversationHistory,
            message,
            {
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(functionResult)
            }
          ],
          max_tokens: 150,
          temperature: 0.7
        });

        responseText = followUp.choices[0].message.content || '';
        console.log(`🎤 Final response: "${responseText}"`);
      }

      // Add assistant response to history
      session.conversationHistory.push({
        role: 'assistant',
        content: responseText
      });

      // Update session in Firestore
      const db = getDb();
      await db.collection('dineai_cheap_sessions').doc(sessionId).update({
        messageCount: session.conversationHistory.length,
        lastMessageAt: new Date()
      });

      // Log token usage
      const tokensUsed = completion.usage?.total_tokens || 0;
      console.log(`🎤 Tokens used: ${tokensUsed}`);
      console.log(`🎤 ==================== End Message ====================\n`);

      return {
        success: true,
        response: responseText,
        functionCalled,
        functionResult,
        tokensUsed,
        shouldClose: false
      };
    } catch (error) {
      console.error(`❌ Error processing message:`, error);
      return {
        success: false,
        error: error.message,
        response: "Sorry, I had trouble with that. Could you try again?"
      };
    }
  }

  /**
   * Generate TTS audio for response
   */
  async generateTTS(text, voice = 'alloy') {
    try {
      console.log(`🔊 Generating TTS for: "${text.substring(0, 50)}..."`);

      const response = await this.openai.audio.speech.create({
        model: 'tts-1', // Use tts-1 for speed, tts-1-hd for quality
        voice: voice,
        input: text,
        response_format: 'mp3',
        speed: 1.0
      });

      // Convert to base64
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64Audio = buffer.toString('base64');

      console.log(`🔊 TTS generated: ${buffer.length} bytes`);

      return {
        success: true,
        audio: base64Audio,
        format: 'mp3'
      };
    } catch (error) {
      console.error('Error generating TTS:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * End a cheap voice session
   */
  async endSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);

      const db = getDb();
      await db.collection('dineai_cheap_sessions').doc(sessionId).update({
        status: 'ended',
        endedAt: new Date()
      });

      this.activeSessions.delete(sessionId);

      console.log(`🎤 Cheap voice session ended: ${sessionId}`);

      return { success: true };
    } catch (error) {
      console.error('Error ending session:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get session info
   */
  getSession(sessionId) {
    return this.activeSessions.get(sessionId);
  }
}

module.exports = new DineAICheapVoiceService();
