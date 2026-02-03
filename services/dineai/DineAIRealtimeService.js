/**
 * DineAI Realtime Service
 * OpenAI Realtime API integration for true voice-to-voice streaming
 */

const { getDb } = require('../../firebase');
const DineAIToolExecutor = require('./DineAIToolExecutor');
const dineaiPermissions = require('./DineAIPermissions');

// Use model as per OpenAI docs - try gpt-4o-realtime-preview first
// Alternative: 'gpt-realtime' if this doesn't work
const REALTIME_MODEL = 'gpt-4o-realtime-preview';

class DineAIRealtimeService {
  constructor() {
    this.toolExecutor = new DineAIToolExecutor();
    this.activeSessions = new Map();
  }

  /**
   * Build system prompt for realtime voice assistant
   */
  buildSystemPrompt(restaurantData, userData) {
    const restaurantName = restaurantData?.name || 'the restaurant';
    const userName = userData?.name || 'there';
    const userRole = userData?.role || 'staff';

    return `You are DineAI, a friendly voice assistant for ${restaurantName}. You help staff with orders, tables, and menu.

CRITICAL VOICE RULES:
- Keep responses SHORT (1-2 sentences max)
- Use natural speech: "Got it!", "Sure thing!", "Done!"
- Speak numbers naturally: "table five", "four fifty rupees"
- Be warm and efficient like a helpful colleague
- Confirm actions briefly, then do them

USER: ${userName} (${userRole})

MENU & PRICING - You have FULL ACCESS to the menu:
- Use get_item_availability to check item price and availability
- Use search_menu_items to find items by name
- Use get_menu to browse full menu by category
- ALWAYS check the menu when user asks about prices
- When placing orders, items are validated against menu automatically

CAPABILITIES:
- Place orders: "Order paneer and naan for table 4"
- Check prices: "What's the price of biryani?" → Use get_item_availability
- Check availability: "Is paneer available?" → Use get_item_availability
- Browse menu: "What starters do you have?" → Use get_menu with category
- Check orders: "What's pending?" / "Status of order 5"
- Tables: "Which tables are free?" / "Reserve table 2"
- Analytics (manager+): "Today's revenue?" / "How many orders today?"

RESPONSE STYLE EXAMPLES:
- "One paneer for table 4? On it... Done! Order 15, total 250 rupees."
- "Paneer tikka is 280 rupees, and yes it's available!"
- "Tables 2, 5, and 7 are free right now."
- "Today you've done 23 orders, 18,450 rupees total. Nice!"

Always check menu for prices when asked. Confirm before placing orders. Be concise!`;
  }

  /**
   * Create a realtime session and get ephemeral token
   */
  async createRealtimeSession(restaurantId, userId, userRole, options = {}) {
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

      const userData = userRestaurantDoc.empty ? { name: 'User', role: userRole } : userRestaurantDoc.docs[0].data();

      // Build system prompt
      const instructions = this.buildSystemPrompt(restaurantData, userData);

      console.log('🍽️ DineAI Session Context:', {
        restaurantId,
        restaurantName: restaurantData?.name || 'NOT FOUND',
        userName: userData?.name,
        userRole,
        instructionsPreview: instructions.substring(0, 100) + '...'
      });

      // Get tools for role and convert to Realtime API format
      const chatTools = this.toolExecutor.getToolsForRole(userRole);
      // Realtime API uses a flatter format: { type, name, description, parameters }
      // Chat API uses: { type: 'function', function: { name, description, parameters } }
      const tools = chatTools.map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters
      }));

      // Create OpenAI Realtime session and get ephemeral client secret
      // Using the correct endpoint as per OpenAI docs
      const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: REALTIME_MODEL,
          voice: options.voice || 'alloy',
          instructions,
          tools,
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          },
          input_audio_transcription: {
            model: 'whisper-1'
          }
        })
      });

      // Log the response for debugging
      console.log('🔑 OpenAI Realtime API response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI Realtime session error:', response.status, errorText);

        // Parse error for helpful messages
        let errorMessage = 'Failed to create realtime session';
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error?.message) {
            errorMessage = errorJson.error.message;
          }
        } catch (e) {
          // Use raw error text if not JSON
          if (errorText) {
            errorMessage = errorText;
          }
        }

        // Specific error handling
        if (response.status === 401) {
          throw new Error('OpenAI API key invalid or missing');
        } else if (response.status === 403) {
          throw new Error('OpenAI Realtime API access not enabled for this account. Please contact OpenAI support.');
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again in a moment.');
        } else if (response.status === 404) {
          throw new Error('Realtime API endpoint not found. The API may not be available yet.');
        }

        throw new Error(errorMessage);
      }

      const data = await response.json();

      // Debug: log the response structure
      console.log('🔑 OpenAI Realtime session response:', {
        hasClientSecret: !!data.client_secret,
        clientSecretType: typeof data.client_secret,
        clientSecretKeys: data.client_secret ? Object.keys(data.client_secret) : [],
        tokenPreview: data.client_secret?.value?.substring?.(0, 30) || 'none',
        expiresAt: data.client_secret?.expires_at
      });

      // Generate session ID
      const sessionId = `rt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Store session info
      this.activeSessions.set(sessionId, {
        sessionId,
        restaurantId,
        userId,
        userRole,
        restaurantData,
        userData,
        createdAt: new Date(),
        tools
      });

      // Store in Firestore for tracking
      await db.collection('dineai_realtime_sessions').doc(sessionId).set({
        sessionId,
        restaurantId,
        userId,
        userRole,
        voiceMode: 'realtime',
        status: 'active',
        createdAt: new Date()
      });

      console.log(`🎙️ DineAI Realtime session created: ${sessionId}`);

      return {
        success: true,
        sessionId,
        clientSecret: data.client_secret,
        expiresAt: data.client_secret?.expires_at,
        voice: options.voice || 'alloy',
        model: REALTIME_MODEL,
        instructions
      };
    } catch (error) {
      console.error('Error creating realtime session:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute a function call from Realtime API
   * @param {string} sessionId - Session ID
   * @param {string} functionName - Function to execute
   * @param {object} args - Function arguments
   * @param {string} fallbackRestaurantId - Fallback restaurant ID if session not found
   * @param {string} fallbackUserId - Fallback user ID
   * @param {string} fallbackUserRole - Fallback user role
   */
  async executeFunctionCall(sessionId, functionName, args, fallbackRestaurantId, fallbackUserId, fallbackUserRole) {
    const session = this.activeSessions.get(sessionId);

    // Determine context - prefer session data, fall back to provided values
    let restaurantId, userId, userRole;

    if (session) {
      restaurantId = session.restaurantId;
      userId = session.userId;
      userRole = session.userRole;
    } else {
      // Try to find session info from Firestore
      const db = getDb();
      const sessionDoc = await db.collection('dineai_realtime_sessions').doc(sessionId).get();

      if (sessionDoc.exists) {
        const sessionData = sessionDoc.data();
        restaurantId = sessionData.restaurantId;
        userId = sessionData.userId;
        userRole = sessionData.userRole;
      }
    }

    // Use fallbacks if still not found
    restaurantId = restaurantId || fallbackRestaurantId;
    userId = userId || fallbackUserId;
    userRole = userRole || fallbackUserRole || 'employee';

    if (!restaurantId) {
      return { success: false, error: 'Restaurant ID not found for session' };
    }

    console.log(`🔧 Executing ${functionName} for restaurant ${restaurantId}`);

    const result = await this.toolExecutor.executeFunction(
      functionName,
      args,
      restaurantId,
      userId,
      userRole
    );

    // Log the function call
    await this.logFunctionCall(sessionId, functionName, args, result);

    return result;
  }

  /**
   * Log function call for analytics
   */
  async logFunctionCall(sessionId, functionName, args, result) {
    try {
      const db = getDb();
      await db.collection('dineai_realtime_sessions').doc(sessionId).collection('function_calls').add({
        functionName,
        args,
        success: result.success,
        timestamp: new Date()
      });
    } catch (error) {
      console.error('Error logging function call:', error);
    }
  }

  /**
   * End a realtime session
   */
  async endRealtimeSession(sessionId) {
    try {
      const db = getDb();

      // Update session status
      await db.collection('dineai_realtime_sessions').doc(sessionId).update({
        status: 'ended',
        endedAt: new Date()
      });

      // Remove from active sessions
      this.activeSessions.delete(sessionId);

      console.log(`🎙️ DineAI Realtime session ended: ${sessionId}`);

      return { success: true };
    } catch (error) {
      console.error('Error ending realtime session:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get session info
   */
  getSession(sessionId) {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Build initial greeting for realtime session
   */
  async buildInitialGreeting(restaurantId, userData) {
    const db = getDb();
    const userName = userData?.name || 'there';
    const userRole = userData?.role || 'staff';

    // Get some context
    let pendingOrders = 0;
    let availableTables = 0;

    try {
      // Count pending orders
      const ordersSnapshot = await db.collection('orders')
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['pending', 'preparing'])
        .get();
      pendingOrders = ordersSnapshot.size;

      // This will be spoken by the AI automatically based on the system prompt
    } catch (error) {
      console.error('Error building greeting context:', error);
    }

    // The greeting will be handled by OpenAI based on the system prompt
    // We just need to send an initial message to trigger it
    return {
      pendingOrders,
      userName,
      userRole
    };
  }
}

module.exports = new DineAIRealtimeService();
