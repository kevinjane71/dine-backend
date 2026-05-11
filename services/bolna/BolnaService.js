/**
 * Bolna AI Voice Agent Service
 * Handles creation and management of AI phone agents for restaurants
 *
 * API Docs: https://www.bolna.ai/docs/api-reference/introduction
 * Base URL: https://api.bolna.ai
 * Auth: Bearer token
 */

const { getDb, collections } = require('../../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const BOLNA_BASE_URL = 'https://api.bolna.ai';

class BolnaService {
  constructor() {
    this.apiKey = process.env.BOLNA_API_KEY;
  }

  /**
   * Make authenticated request to Bolna API
   */
  async _request(method, path, body = null) {
    if (!this.apiKey) {
      throw new Error('BOLNA_API_KEY not configured');
    }

    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      }
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const url = `${BOLNA_BASE_URL}${path}`;
    console.log(`[Bolna] ${method} ${url}`);

    const response = await fetch(url, options);
    const data = await response.json();

    if (!response.ok) {
      console.error(`[Bolna] Error ${response.status}:`, data);
      throw new Error(data.message || `Bolna API error: ${response.status}`);
    }

    return data;
  }

  // ==================== Agent Management ====================

  /**
   * Create a Bolna voice agent for a restaurant
   */
  async createAgent(restaurantId, restaurantData, menuData) {
    const db = getDb();
    const backendUrl = process.env.BACKEND_URL || process.env.FRONTEND_URL?.replace('dineopen.com', 'api.dineopen.com') || 'https://api.dineopen.com';

    // Build the system prompt
    const systemPrompt = this._buildSystemPrompt(restaurantData, menuData);

    // Build agent config with webhook tools
    const apiTools = this._buildApiTools(backendUrl, restaurantId);
    const agentConfig = {
      agent_name: `DineOpen - ${restaurantData.name}`,
      agent_welcome_message: this._buildGreeting(restaurantData),
      webhook_url: `${backendUrl}/api/bolna/webhook/call-status?restaurantId=${restaurantId}`,
      agent_type: 'other',
      tasks: [
        {
          task_type: 'conversation',
          tools_config: {
            llm_agent: {
              agent_type: 'simple_llm_agent',
              agent_flow_type: 'streaming',
              llm_config: {
                provider: 'openai',
                family: 'openai',
                model: 'gpt-4o-mini',
                max_tokens: 512,
                temperature: 0.5,
                request_json: false
              }
            },
            synthesizer: {
              provider: 'elevenlabs',
              provider_config: {
                voice: restaurantData.bolnaVoice || 'Nila',
                voice_id: restaurantData.bolnaVoiceId || 'V9LCAAi4tTlqe9JadbCo',
                model: 'eleven_turbo_v2_5'
              },
              stream: true,
              buffer_size: 250,
              audio_format: 'wav'
            },
            transcriber: {
              provider: 'deepgram',
              model: 'nova-2',
              language: restaurantData.bolnaLanguage || 'hi',
              stream: true,
              sampling_rate: 16000,
              encoding: 'linear16',
              endpointing: 250
            },
            input: {
              provider: 'default',
              format: 'wav'
            },
            output: {
              provider: 'default',
              format: 'wav'
            },
            api_tools: apiTools
          },
          toolchain: {
            execution: 'sequential',
            pipelines: [
              ['transcriber', 'llm', 'synthesizer']
            ]
          },
          task_config: {
            hangup_after_silence: 15,
            incremental_delay: 400,
            number_of_words_for_interruption: 2,
            hangup_after_LLMCall: false,
            backchanneling: false,
            call_terminate: 120
          }
        }
      ]
    };

    const agentPrompts = {
      task_1: {
        system_prompt: systemPrompt
      }
    };

    // Create agent via Bolna API
    const result = await this._request('POST', '/v2/agent', {
      agent_config: agentConfig,
      agent_prompts: agentPrompts
    });

    // Store agent info in Firestore
    const agentDoc = {
      restaurantId,
      bolnaAgentId: result.agent_id,
      agentName: agentConfig.agent_name,
      status: 'created',
      phoneNumber: null, // Will be set after inbound setup
      phoneNumberId: null,
      language: restaurantData.bolnaLanguage || 'hi',
      voice: restaurantData.bolnaVoice || 'Nila',
      greeting: agentConfig.agent_welcome_message,
      capabilities: {
        menuQueries: true,
        reservations: true,
        phoneOrders: true,
        transferToOwner: true
      },
      callStats: {
        totalCalls: 0,
        totalMinutes: 0,
        lastCallAt: null
      },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    await db.collection('bolnaAgents').doc(restaurantId).set(agentDoc);

    return {
      success: true,
      agentId: result.agent_id,
      agent: agentDoc
    };
  }

  /**
   * Buy a phone number and assign it to the agent
   */
  async setupPhoneNumber(restaurantId, countryCode = 'IN') {
    const db = getDb();
    const agentDoc = await db.collection('bolnaAgents').doc(restaurantId).get();

    if (!agentDoc.exists) {
      throw new Error('No Bolna agent found for this restaurant. Create an agent first.');
    }

    const agent = agentDoc.data();

    // Search for available numbers
    const searchResult = await this._request('GET', `/phone-numbers/search?country=${countryCode}`);

    if (!searchResult || !searchResult.length) {
      throw new Error(`No phone numbers available for country: ${countryCode}`);
    }

    // Buy the first available number
    const buyResult = await this._request('POST', '/phone-numbers/buy', {
      phone_number_id: searchResult[0].id
    });

    // Set up inbound agent on this number
    const inboundResult = await this._request('POST', '/inbound/setup', {
      agent_id: agent.bolnaAgentId,
      phone_number_id: buyResult.id || searchResult[0].id
    });

    // Update Firestore with phone number
    await db.collection('bolnaAgents').doc(restaurantId).update({
      phoneNumber: inboundResult.phone_number,
      phoneNumberId: buyResult.id || searchResult[0].id,
      status: 'active',
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      success: true,
      phoneNumber: inboundResult.phone_number,
      callForwardingInstructions: {
        forwardAll: `**21*${inboundResult.phone_number}#`,
        forwardIfNoAnswer: `**61*${inboundResult.phone_number}#`,
        forwardIfBusy: `**67*${inboundResult.phone_number}#`,
        forwardIfUnreachable: `**62*${inboundResult.phone_number}#`,
        cancelForwarding: '##21#'
      }
    };
  }

  /**
   * Get agent status for a restaurant
   */
  async getAgentStatus(restaurantId) {
    const db = getDb();
    const agentDoc = await db.collection('bolnaAgents').doc(restaurantId).get();

    if (!agentDoc.exists) {
      return { exists: false, agent: null };
    }

    return { exists: true, agent: agentDoc.data() };
  }

  /**
   * Update agent settings (language, voice, capabilities)
   */
  async updateAgent(restaurantId, updates) {
    const db = getDb();
    const agentDoc = await db.collection('bolnaAgents').doc(restaurantId).get();

    if (!agentDoc.exists) {
      throw new Error('No Bolna agent found for this restaurant');
    }

    const agent = agentDoc.data();

    // If prompt-related changes, update on Bolna
    if (updates.greeting || updates.language || updates.voice || updates.systemPrompt) {
      const patchData = {};

      if (updates.greeting) {
        patchData.agent_welcome_message = updates.greeting;
      }

      if (Object.keys(patchData).length > 0) {
        await this._request('PATCH', `/agents/${agent.bolnaAgentId}`, patchData);
      }
    }

    // Update Firestore
    const firestoreUpdates = { updatedAt: FieldValue.serverTimestamp() };
    if (updates.language) firestoreUpdates.language = updates.language;
    if (updates.voice) firestoreUpdates.voice = updates.voice;
    if (updates.greeting) firestoreUpdates.greeting = updates.greeting;
    if (updates.capabilities) firestoreUpdates.capabilities = updates.capabilities;

    await db.collection('bolnaAgents').doc(restaurantId).update(firestoreUpdates);

    return { success: true };
  }

  /**
   * Delete/deactivate agent
   */
  async deleteAgent(restaurantId) {
    const db = getDb();
    const agentDoc = await db.collection('bolnaAgents').doc(restaurantId).get();

    if (!agentDoc.exists) {
      throw new Error('No Bolna agent found for this restaurant');
    }

    const agent = agentDoc.data();

    // Delete on Bolna
    await this._request('DELETE', `/agents/${agent.bolnaAgentId}`);

    // If there's a phone number, release it
    if (agent.phoneNumberId) {
      try {
        await this._request('DELETE', `/phone-numbers/${agent.phoneNumberId}`);
      } catch (err) {
        console.error('[Bolna] Failed to release phone number:', err.message);
      }
    }

    // Mark as deleted in Firestore
    await db.collection('bolnaAgents').doc(restaurantId).update({
      status: 'deleted',
      deletedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { success: true };
  }

  // ==================== Call Logs ====================

  /**
   * Get call history for a restaurant's agent
   */
  async getCallLogs(restaurantId, limit = 50) {
    const db = getDb();
    const agentDoc = await db.collection('bolnaAgents').doc(restaurantId).get();

    if (!agentDoc.exists) {
      return { calls: [], total: 0 };
    }

    const agent = agentDoc.data();

    // Get from Bolna API
    try {
      const executions = await this._request('GET', `/agents/${agent.bolnaAgentId}/executions`);
      return {
        calls: Array.isArray(executions) ? executions.slice(0, limit) : [],
        total: Array.isArray(executions) ? executions.length : 0
      };
    } catch (err) {
      console.error('[Bolna] Failed to fetch call logs:', err.message);
      // Fall back to local logs
      const localLogs = await db.collection('phoneCalls')
        .where('restaurantId', '==', restaurantId)
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      return {
        calls: localLogs.docs.map(d => ({ id: d.id, ...d.data() })),
        total: localLogs.size
      };
    }
  }

  /**
   * Get call recording/transcript
   */
  async getCallDetails(executionId) {
    return this._request('GET', `/executions/${executionId}`);
  }

  // ==================== Webhook Handlers ====================

  /**
   * Handle call status webhook from Bolna
   */
  async handleCallStatusWebhook(restaurantId, data) {
    const db = getDb();

    const callDoc = {
      restaurantId,
      bolnaExecutionId: data.execution_id || data.call_sid || null,
      status: data.status || 'unknown',
      callerNumber: data.from_number || data.caller || null,
      duration: data.duration || 0,
      transcript: data.transcript || null,
      summary: data.summary || null,
      recordingUrl: data.recording_url || null,
      metadata: data,
      createdAt: FieldValue.serverTimestamp()
    };

    await db.collection('phoneCalls').add(callDoc);

    // Update call stats on agent doc
    const agentRef = db.collection('bolnaAgents').doc(restaurantId);
    await agentRef.update({
      'callStats.totalCalls': FieldValue.increment(1),
      'callStats.totalMinutes': FieldValue.increment(Math.ceil((data.duration || 0) / 60)),
      'callStats.lastCallAt': FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { success: true };
  }

  /**
   * Get menu data for webhook response (called by Bolna during a call)
   */
  async getMenuForWebhook(restaurantId) {
    const db = getDb();

    // Get menu items
    const menuSnapshot = await db.collection(collections.menuItems)
      .where('restaurantId', '==', restaurantId)
      .where('available', '==', true)
      .get();

    const items = menuSnapshot.docs.map(doc => {
      const d = doc.data();
      return {
        name: d.name,
        price: d.price,
        description: d.description || '',
        category: d.category || 'Other',
        isVeg: d.isVeg || false,
        isAvailable: d.available !== false
      };
    });

    // Group by category
    const menuByCategory = {};
    items.forEach(item => {
      if (!menuByCategory[item.category]) {
        menuByCategory[item.category] = [];
      }
      menuByCategory[item.category].push(item);
    });

    return {
      restaurantId,
      totalItems: items.length,
      menu: menuByCategory
    };
  }

  /**
   * Get restaurant hours for webhook response
   */
  async getHoursForWebhook(restaurantId) {
    const db = getDb();
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();

    if (!restaurantDoc.exists) {
      return { error: 'Restaurant not found' };
    }

    const data = restaurantDoc.data();
    return {
      restaurantName: data.name,
      operatingHours: data.operatingHours || data.hours || 'Not specified',
      isOpen: data.isOpen !== false,
      address: data.address || ''
    };
  }

  /**
   * Create a reservation via webhook (called by Bolna during a call)
   */
  async createReservationFromWebhook(restaurantId, reservationData) {
    const db = getDb();

    const booking = {
      restaurantId,
      source: 'phone_ai',
      guestName: reservationData.name || 'Phone Caller',
      guestPhone: reservationData.phone || reservationData.from_number || '',
      partySize: parseInt(reservationData.party_size) || 2,
      date: reservationData.date || new Date().toISOString().split('T')[0],
      time: reservationData.time || '',
      notes: reservationData.notes || 'Booked via AI phone agent',
      status: 'confirmed',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const docRef = await db.collection(collections.bookings).add(booking);

    return {
      success: true,
      bookingId: docRef.id,
      confirmation: `Reservation confirmed for ${booking.guestName}, party of ${booking.partySize} on ${booking.date} at ${booking.time}`
    };
  }

  /**
   * Create a phone order via webhook (called by Bolna during a call)
   */
  async createOrderFromWebhook(restaurantId, orderData) {
    const db = getDb();

    const order = {
      restaurantId,
      source: 'phone_ai',
      type: orderData.order_type || 'delivery',
      customerName: orderData.name || 'Phone Caller',
      customerPhone: orderData.phone || orderData.from_number || '',
      items: orderData.items || [],
      totalAmount: orderData.total || 0,
      address: orderData.address || '',
      notes: orderData.notes || 'Ordered via AI phone agent',
      status: 'pending',
      paymentStatus: 'pending',
      paymentMethod: 'cod',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const docRef = await db.collection(collections.orders).add(order);

    return {
      success: true,
      orderId: docRef.id,
      confirmation: `Order placed for ${order.customerName}. Order ID: ${docRef.id}. Total: ₹${order.totalAmount}`
    };
  }

  // ==================== Prompt Building ====================

  /**
   * Build system prompt for the Bolna agent
   */
  _buildSystemPrompt(restaurantData, menuData) {
    const menuText = this._formatMenuForPrompt(menuData);

    return `You are the AI phone receptionist for ${restaurantData.name}.
Location: ${restaurantData.address || 'Not specified'}
Cuisine: ${restaurantData.cuisine || restaurantData.cuisineType || 'Multi-cuisine'}

Your capabilities:
1. Answer questions about the menu, prices, ingredients, and specials
2. Help customers make table reservations
3. Take phone orders for delivery or pickup
4. Provide restaurant information (hours, location, parking, etc.)
5. Transfer the call to the restaurant owner/manager if needed

Operating Hours: ${restaurantData.operatingHours || restaurantData.hours || 'Please check with the restaurant'}

IMPORTANT RULES:
- Be warm, friendly, and professional
- Speak in ${restaurantData.bolnaLanguage === 'en' ? 'English' : restaurantData.bolnaLanguage === 'hi' ? 'Hindi' : 'Hindi and English (Hinglish)'}
- Keep responses concise - this is a phone call, not a chat
- Always confirm order items and reservation details before finalizing
- If you cannot help with something, offer to transfer to the restaurant staff
- Mention any ongoing offers or specials if relevant
- For orders, always confirm: items, quantities, delivery/pickup, address (if delivery), and total
- For reservations, always confirm: name, date, time, party size

${menuText ? `MENU:\n${menuText}` : 'Use the get_menu function to fetch the latest menu when a customer asks about food items.'}

${restaurantData.specialInstructions || ''}`;
  }

  /**
   * Build greeting message
   */
  _buildGreeting(restaurantData) {
    const lang = restaurantData.bolnaLanguage || 'hi';
    if (lang === 'hi') {
      return `नमस्ते! ${restaurantData.name} में आपका स्वागत है। मैं आपकी AI असिस्टेंट हूँ। मैं आपको मेन्यू, टेबल बुकिंग, या ऑर्डर में मदद कर सकती हूँ। आप क्या जानना चाहेंगे?`;
    }
    return `Hello! Welcome to ${restaurantData.name}. I'm your AI assistant. I can help you with our menu, table reservations, or placing an order. How can I help you today?`;
  }

  /**
   * Format menu data for inclusion in prompt
   */
  _formatMenuForPrompt(menuData) {
    if (!menuData || !menuData.length) return '';

    const categories = {};
    menuData.forEach(item => {
      const cat = item.category || 'Other';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(`- ${item.name}: ₹${item.price}${item.isVeg ? ' (Veg)' : ''}${item.description ? ` - ${item.description}` : ''}`);
    });

    return Object.entries(categories)
      .map(([cat, items]) => `${cat}:\n${items.join('\n')}`)
      .join('\n\n');
  }

  /**
   * Build API tools config for Bolna agent (function calling)
   */
  _buildApiTools(backendUrl, restaurantId) {
    return {
      tools: [
        {
          name: 'get_menu',
          description: 'Get the restaurant menu with items, prices, and categories. Call this when customer asks about menu items, prices, or what food is available.',
          parameters: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Optional: specific category to filter (e.g., starters, mains, drinks)'
              }
            }
          }
        },
        {
          name: 'get_hours',
          description: 'Get restaurant operating hours and current open/closed status. Call this when customer asks about timing or if the restaurant is open.',
          parameters: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'make_reservation',
          description: 'Create a table reservation. Call this after confirming all details with the customer: name, date, time, and party size.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Guest name' },
              phone: { type: 'string', description: 'Guest phone number' },
              date: { type: 'string', description: 'Reservation date (YYYY-MM-DD)' },
              time: { type: 'string', description: 'Reservation time (HH:MM)' },
              party_size: { type: 'integer', description: 'Number of guests' },
              notes: { type: 'string', description: 'Special requests or notes' }
            },
            required: ['name', 'date', 'time', 'party_size']
          }
        },
        {
          name: 'place_order',
          description: 'Place a food order for delivery or pickup. Call this after confirming all items and details with the customer.',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Customer name' },
              phone: { type: 'string', description: 'Customer phone number' },
              order_type: { type: 'string', enum: ['delivery', 'pickup'], description: 'Delivery or pickup' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    quantity: { type: 'integer' },
                    price: { type: 'number' }
                  }
                },
                description: 'List of items to order'
              },
              total: { type: 'number', description: 'Total order amount' },
              address: { type: 'string', description: 'Delivery address (required for delivery orders)' },
              notes: { type: 'string', description: 'Special instructions' }
            },
            required: ['name', 'items', 'order_type']
          }
        }
      ],
      tools_params: {
        get_menu: {
          method: 'POST',
          url: `${backendUrl}/api/bolna/webhook/menu`,
          param: JSON.stringify({ restaurantId, category: '%(category)s' })
        },
        get_hours: {
          method: 'POST',
          url: `${backendUrl}/api/bolna/webhook/hours`,
          param: JSON.stringify({ restaurantId })
        },
        make_reservation: {
          method: 'POST',
          url: `${backendUrl}/api/bolna/webhook/reservation`,
          param: JSON.stringify({ restaurantId, name: '%(name)s', phone: '%(phone)s', date: '%(date)s', time: '%(time)s', party_size: '%(party_size)s', notes: '%(notes)s' })
        },
        place_order: {
          method: 'POST',
          url: `${backendUrl}/api/bolna/webhook/order`,
          param: JSON.stringify({ restaurantId, name: '%(name)s', phone: '%(phone)s', order_type: '%(order_type)s', items: '%(items)s', total: '%(total)s', address: '%(address)s', notes: '%(notes)s' })
        }
      }
    };
  }

  // ==================== Sync Menu ====================

  /**
   * Sync restaurant menu to update the agent's knowledge
   */
  async syncMenu(restaurantId) {
    const db = getDb();
    const agentDoc = await db.collection('bolnaAgents').doc(restaurantId).get();

    if (!agentDoc.exists) {
      throw new Error('No Bolna agent found for this restaurant');
    }

    const agent = agentDoc.data();

    // Get restaurant and menu data
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    const menuSnapshot = await db.collection(collections.menuItems)
      .where('restaurantId', '==', restaurantId)
      .where('available', '==', true)
      .get();

    const restaurantData = restaurantDoc.data();
    const menuData = menuSnapshot.docs.map(d => d.data());

    // Rebuild the system prompt with updated menu
    const systemPrompt = this._buildSystemPrompt(restaurantData, menuData);

    // Update agent on Bolna
    await this._request('PATCH', `/agents/${agent.bolnaAgentId}`, {
      agent_prompts: {
        task_1: {
          system_prompt: systemPrompt
        }
      }
    });

    await db.collection('bolnaAgents').doc(restaurantId).update({
      lastMenuSync: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      success: true,
      itemCount: menuData.length,
      syncedAt: new Date().toISOString()
    };
  }

  // ==================== Phone Numbers ====================

  /**
   * List available phone numbers
   */
  async searchPhoneNumbers(country = 'IN') {
    return this._request('GET', `/phone-numbers/search?country=${country}`);
  }

  /**
   * List purchased phone numbers
   */
  async listPhoneNumbers() {
    return this._request('GET', '/phone-numbers');
  }
}

module.exports = new BolnaService();
