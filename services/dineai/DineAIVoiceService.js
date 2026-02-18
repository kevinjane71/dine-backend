/**
 * DineAI Voice Service
 * OpenAI Realtime API integration for voice-to-voice conversation
 */

const OpenAI = require('openai');
const { getDb } = require('../../firebase');
const DineAIToolExecutor = require('./DineAIToolExecutor');
const dineaiPermissions = require('./DineAIPermissions');
const conversationService = require('./DineAIConversationService');

class DineAIVoiceService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.toolExecutor = new DineAIToolExecutor();
    this.activeSessions = new Map();
  }

  /**
   * Build system prompt for the voice assistant
   */
  buildSystemPrompt(restaurantData, userData, capabilities) {
    const restaurantName = restaurantData?.name || 'the restaurant';
    const userName = userData?.name || 'there';
    const userRole = userData?.role || 'staff';

    return `You are DineAI, an intelligent voice assistant for ${restaurantName}. You help restaurant staff with orders, tables, menu, and customer service.

IMPORTANT GUIDELINES:
1. Be concise and conversational - you're speaking, not typing
2. Use natural speech patterns with brief responses
3. Confirm actions before executing them when appropriate
4. If you're unsure, ask for clarification
5. Always be helpful and professional

USER CONTEXT:
- Name: ${userName}
- Role: ${userRole}
- Capabilities: ${capabilities}

MENU & PRICING - You have FULL ACCESS to the menu:
- Use get_item_availability to check item price and availability
- Use search_menu_items to find items by name or search terms
- Use get_menu to browse full menu or filter by category
- ALWAYS check the menu when user asks about prices - don't guess!
- When placing orders, items are automatically validated against menu

YOUR CAPABILITIES:
You can help with:
- Taking and managing orders (place_order, get_orders, update_order_status)
- Checking PRICES and menu items (get_item_availability, search_menu_items, get_menu)
- Checking table status and making reservations
- Providing sales summaries and today's stats
- Answering questions about the restaurant

SPEECH STYLE:
- Keep responses under 2-3 sentences when possible
- Use numbers naturally ("table five" not "table 5")
- Spell out currency ("two hundred fifty rupees")
- Be warm but efficient

When executing actions:
1. Confirm the action briefly
2. Execute it
3. Report the result concisely

Example interactions:
- User: "Place an order for table 4, one paneer butter masala and two naan"
  You: "Got it - one paneer butter masala and two naan for table 4. Placing the order now... Done! Order number 15 is in the kitchen."

- User: "What's the price of biryani?"
  You: [Use get_item_availability] "Chicken biryani is two hundred eighty rupees, and it's available."

- User: "What tables are available?"
  You: "Tables 2, 5, and 7 are available right now. Tables 1 and 3 are occupied."

- User: "Today's sales?"
  You: "Today we've had 23 orders totaling 18,450 rupees. 5 orders are still pending."`;
  }

  /**
   * Create a new voice session
   */
  async createSession(restaurantId, userId, userRole, options = {}) {
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

      const userData = userRestaurantDoc.empty ? {} : userRestaurantDoc.docs[0].data();

      // Check daily limit
      const dailyLimit = dineaiPermissions.getDailyLimit(userRole);
      const limitCheck = await conversationService.checkDailyLimit(userId, restaurantId, dailyLimit);

      if (!limitCheck.allowed) {
        return {
          success: false,
          error: `Daily limit reached (${limitCheck.used}/${limitCheck.limit} messages). Please try again tomorrow.`
        };
      }

      // Create conversation session
      const sessionType = options.sessionType || 'voice';
      const responseMode = options.responseMode || 'voice';
      const session = await conversationService.createSession(
        restaurantId,
        userId,
        sessionType,
        responseMode
      );

      // Get tools for user role
      const tools = this.toolExecutor.getToolsForRole(userRole);
      const capabilities = dineaiPermissions.getRoleCapabilitiesDescription(userRole);

      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(restaurantData, userData, capabilities);

      // Create session configuration for Realtime API
      const sessionConfig = {
        sessionId: session.sessionId,
        restaurantId,
        userId,
        userRole,
        voice: options.voice || process.env.DINEAI_DEFAULT_VOICE || 'alloy',
        systemPrompt,
        tools,
        turnDetection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        },
        inputAudioTranscription: {
          model: 'whisper-1'
        }
      };

      // Store session
      this.activeSessions.set(session.sessionId, {
        ...sessionConfig,
        restaurantData,
        userData,
        createdAt: new Date()
      });

      console.log(`🎙️ DineAI voice session created: ${session.sessionId}`);

      return {
        success: true,
        sessionId: session.sessionId,
        config: {
          voice: sessionConfig.voice,
          turnDetection: sessionConfig.turnDetection,
          tools: tools.map(t => t.function?.name || t.name)
        },
        limits: {
          remaining: limitCheck.remaining,
          total: dailyLimit
        }
      };
    } catch (error) {
      console.error('Error creating voice session:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get session configuration (for WebSocket connection)
   */
  getSessionConfig(sessionId) {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Process a text query (fallback for non-voice)
   */
  async processTextQuery(sessionId, query, restaurantId, userId, userRole) {
    try {
      const session = this.activeSessions.get(sessionId);

      if (!session) {
        return {
          success: false,
          error: 'Session not found'
        };
      }

      // Add user message to conversation
      await conversationService.addMessage(sessionId, {
        role: 'user',
        content: query
      });

      // Get conversation history for context
      const history = await conversationService.buildOpenAIHistory(sessionId, 10);

      // Create OpenAI completion with tools
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: session.systemPrompt },
          ...history,
          { role: 'user', content: query }
        ],
        tools: session.tools,
        tool_choice: 'auto',
        max_tokens: 500
      });

      const message = completion.choices[0].message;
      let response = message.content || '';
      let functionCalled = null;
      let functionResult = null;

      // Handle tool calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0];
        functionCalled = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        // Execute the function
        functionResult = await this.toolExecutor.executeFunction(
          functionCalled,
          args,
          restaurantId,
          userId,
          userRole
        );

        // Record the action
        await conversationService.recordAction(sessionId, {
          name: functionCalled,
          params: args,
          success: functionResult.success,
          result: functionResult
        });

        // Get final response with function result
        const followUp = await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: session.systemPrompt },
            ...history,
            { role: 'user', content: query },
            message,
            {
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(functionResult)
            }
          ],
          max_tokens: 300
        });

        response = followUp.choices[0].message.content || '';
      }

      // Add assistant message to conversation
      await conversationService.addMessage(sessionId, {
        role: 'assistant',
        content: response,
        toolName: functionCalled,
        toolResult: functionResult
      });

      // Update token usage
      const tokensUsed = completion.usage?.total_tokens || 0;
      await conversationService.updateTokenUsage(sessionId, tokensUsed);

      return {
        success: true,
        response,
        functionCalled,
        functionResult,
        tokensUsed
      };
    } catch (error) {
      console.error('Error processing text query:', error);
      return {
        success: false,
        error: error.message,
        response: "I'm sorry, I encountered an error processing your request."
      };
    }
  }

  /**
   * Execute a function call from Realtime API
   */
  async executeFunctionCall(sessionId, functionName, args) {
    const session = this.activeSessions.get(sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    const result = await this.toolExecutor.executeFunction(
      functionName,
      args,
      session.restaurantId,
      session.userId,
      session.userRole
    );

    // Record the action
    await conversationService.recordAction(sessionId, {
      name: functionName,
      params: args,
      success: result.success,
      result
    });

    return result;
  }

  /**
   * End a voice session
   */
  async endSession(sessionId) {
    try {
      const session = this.activeSessions.get(sessionId);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // End the conversation in Firestore
      const result = await conversationService.endSession(sessionId);

      // Remove from active sessions
      this.activeSessions.delete(sessionId);

      console.log(`🎙️ DineAI voice session ended: ${sessionId}`);

      return {
        success: true,
        ...result
      };
    } catch (error) {
      console.error('Error ending session:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId) {
    const activeSession = this.activeSessions.get(sessionId);
    const dbSession = await conversationService.getSession(sessionId);

    if (!dbSession) {
      return { success: false, error: 'Session not found' };
    }

    return {
      success: true,
      session: {
        sessionId,
        status: dbSession.status,
        isActive: !!activeSession,
        messageCount: dbSession.messageCount,
        duration: dbSession.duration,
        startedAt: dbSession.startedAt?.toDate?.()?.toISOString() || dbSession.startedAt
      }
    };
  }

  /**
   * Get or create ephemeral token for Realtime API (client-side connection)
   */
  async getEphemeralToken(sessionId) {
    const session = this.activeSessions.get(sessionId);

    if (!session) {
      return { success: false, error: 'Session not found' };
    }

    try {
      // Create ephemeral token for client-side Realtime API connection
      const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4o-realtime-preview-2024-12-17',
          voice: session.voice,
          instructions: session.systemPrompt,
          tools: session.tools,
          turn_detection: session.turnDetection,
          input_audio_transcription: session.inputAudioTranscription
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('Error getting ephemeral token:', error);
        return { success: false, error: 'Failed to get realtime token' };
      }

      const data = await response.json();

      return {
        success: true,
        token: data.client_secret?.value,
        expiresAt: data.client_secret?.expires_at
      };
    } catch (error) {
      console.error('Error getting ephemeral token:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get WebSocket URL for Realtime API connection
   */
  getRealtimeWebSocketUrl() {
    return 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
  }

  /**
   * Clean up stale sessions (for maintenance)
   */
  async cleanupStaleSessions(maxAgeMs = 30 * 60 * 1000) { // 30 minutes default
    const now = Date.now();
    const staleSessionIds = [];

    for (const [sessionId, session] of this.activeSessions) {
      const sessionAge = now - session.createdAt.getTime();

      if (sessionAge > maxAgeMs) {
        staleSessionIds.push(sessionId);
      }
    }

    for (const sessionId of staleSessionIds) {
      await this.endSession(sessionId);
    }

    return { cleaned: staleSessionIds.length };
  }
}

module.exports = new DineAIVoiceService();
