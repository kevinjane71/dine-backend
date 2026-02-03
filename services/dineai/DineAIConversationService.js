/**
 * DineAI Conversation Service
 * Manages conversation memory and history in Firestore
 */

const { getDb } = require('../../firebase');
const { FieldValue } = require('firebase-admin/firestore');

const COLLECTION_NAME = 'dineai_conversations';

class DineAIConversationService {
  /**
   * Create a new conversation session
   */
  async createSession(restaurantId, userId, sessionType = 'voice', responseMode = 'voice') {
    const db = getDb();
    const sessionData = {
      restaurantId,
      userId,
      sessionType, // 'voice' or 'text'
      responseMode, // 'voice', 'text', or 'both'
      status: 'active',
      startedAt: FieldValue.serverTimestamp(),
      endedAt: null,
      duration: 0,
      summary: null,
      actionsPerformed: [],
      messageCount: 0,
      tokensUsed: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    const ref = await db.collection(COLLECTION_NAME).add(sessionData);

    return {
      sessionId: ref.id,
      ...sessionData,
      startedAt: new Date()
    };
  }

  /**
   * Get a conversation session by ID
   */
  async getSession(sessionId) {
    const db = getDb();
    const doc = await db.collection(COLLECTION_NAME).doc(sessionId).get();

    if (!doc.exists) {
      return null;
    }

    return {
      sessionId: doc.id,
      ...doc.data()
    };
  }

  /**
   * End a conversation session
   */
  async endSession(sessionId, summary = null) {
    const session = await this.getSession(sessionId);

    if (!session) {
      throw new Error('Session not found');
    }

    const startedAt = session.startedAt?.toDate?.() || session.startedAt || new Date();
    const endedAt = new Date();
    const duration = Math.round((endedAt - new Date(startedAt)) / 1000); // seconds

    const db = getDb();
    await db.collection(COLLECTION_NAME).doc(sessionId).update({
      status: 'completed',
      endedAt: FieldValue.serverTimestamp(),
      duration,
      summary: summary || await this.generateSummary(sessionId),
      updatedAt: FieldValue.serverTimestamp()
    });

    return {
      sessionId,
      status: 'completed',
      duration,
      summary
    };
  }

  /**
   * Add a message to the conversation
   */
  async addMessage(sessionId, message) {
    const db = getDb();
    const messageData = {
      role: message.role, // 'user', 'assistant', or 'tool'
      content: message.content,
      audioUrl: message.audioUrl || null,
      toolName: message.toolName || null,
      toolResult: message.toolResult || null,
      timestamp: FieldValue.serverTimestamp(),
      metadata: message.metadata || {}
    };

    // Add to messages subcollection
    await db.collection(COLLECTION_NAME)
      .doc(sessionId)
      .collection('messages')
      .add(messageData);

    // Update session message count
    await db.collection(COLLECTION_NAME).doc(sessionId).update({
      messageCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    });

    return messageData;
  }

  /**
   * Get messages for a conversation
   */
  async getMessages(sessionId, limit = 50) {
    const db = getDb();
    const snapshot = await db.collection(COLLECTION_NAME)
      .doc(sessionId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .limit(limit)
      .get();

    const messages = [];
    snapshot.forEach(doc => {
      messages.push({
        id: doc.id,
        ...doc.data()
      });
    });

    return messages;
  }

  /**
   * Get recent messages for context (last N messages)
   */
  async getRecentMessages(sessionId, count = 10) {
    const db = getDb();
    const snapshot = await db.collection(COLLECTION_NAME)
      .doc(sessionId)
      .collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(count)
      .get();

    const messages = [];
    snapshot.forEach(doc => {
      messages.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Reverse to get chronological order
    return messages.reverse();
  }

  /**
   * Record an action performed during the conversation
   */
  async recordAction(sessionId, action) {
    const db = getDb();
    const actionData = {
      action: action.name,
      params: action.params || {},
      success: action.success,
      result: action.result || null,
      timestamp: new Date().toISOString()
    };

    await db.collection(COLLECTION_NAME).doc(sessionId).update({
      actionsPerformed: FieldValue.arrayUnion(actionData),
      updatedAt: FieldValue.serverTimestamp()
    });

    return actionData;
  }

  /**
   * Get conversation history for a user/restaurant
   */
  async getConversationHistory(restaurantId, userId = null, options = {}) {
    const db = getDb();
    let query = db.collection(COLLECTION_NAME)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'completed');

    if (userId) {
      query = query.where('userId', '==', userId);
    }

    query = query.orderBy('startedAt', 'desc')
      .limit(options.limit || 20);

    const snapshot = await query.get();
    const conversations = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      conversations.push({
        id: doc.id,
        sessionType: data.sessionType,
        startedAt: data.startedAt?.toDate?.()?.toISOString() || data.startedAt,
        duration: data.duration,
        summary: data.summary,
        messageCount: data.messageCount,
        actionsCount: data.actionsPerformed?.length || 0
      });
    });

    return conversations;
  }

  /**
   * Get a single conversation with full details
   */
  async getConversationDetails(sessionId) {
    const session = await this.getSession(sessionId);

    if (!session) {
      return null;
    }

    const messages = await this.getMessages(sessionId);

    return {
      ...session,
      messages
    };
  }

  /**
   * Generate a summary of the conversation
   */
  async generateSummary(sessionId) {
    const messages = await this.getMessages(sessionId);

    if (messages.length === 0) {
      return 'No messages in this conversation';
    }

    // Get session for actions
    const session = await this.getSession(sessionId);
    const actions = session?.actionsPerformed || [];

    // Simple summary based on actions and message count
    const actionNames = actions.map(a => a.action).filter(Boolean);
    const uniqueActions = [...new Set(actionNames)];

    let summary = `Conversation with ${messages.length} messages`;

    if (uniqueActions.length > 0) {
      summary += `. Actions: ${uniqueActions.join(', ')}`;
    }

    // Get first user message as topic indicator
    const firstUserMessage = messages.find(m => m.role === 'user');
    if (firstUserMessage) {
      const topic = firstUserMessage.content.substring(0, 50);
      summary = `${topic}${firstUserMessage.content.length > 50 ? '...' : ''} - ${summary}`;
    }

    return summary;
  }

  /**
   * Update token usage for the session
   */
  async updateTokenUsage(sessionId, tokens) {
    const db = getDb();
    await db.collection(COLLECTION_NAME).doc(sessionId).update({
      tokensUsed: FieldValue.increment(tokens),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  /**
   * Get daily usage stats for a user
   */
  async getDailyUsage(userId, restaurantId) {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const snapshot = await db.collection(COLLECTION_NAME)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('startedAt', '>=', today)
      .get();

    let totalSessions = 0;
    let totalMessages = 0;
    let totalDuration = 0;
    let totalTokens = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      totalSessions++;
      totalMessages += data.messageCount || 0;
      totalDuration += data.duration || 0;
      totalTokens += data.tokensUsed || 0;
    });

    return {
      date: today.toISOString().split('T')[0],
      sessions: totalSessions,
      messages: totalMessages,
      duration: totalDuration,
      tokens: totalTokens
    };
  }

  /**
   * Check if user has exceeded daily limit
   */
  async checkDailyLimit(userId, restaurantId, limit) {
    const usage = await this.getDailyUsage(userId, restaurantId);
    return {
      allowed: usage.messages < limit,
      used: usage.messages,
      limit,
      remaining: Math.max(0, limit - usage.messages)
    };
  }

  /**
   * Clean up old conversations (for maintenance)
   */
  async cleanupOldConversations(restaurantId, daysToKeep = 30) {
    const db = getDb();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const snapshot = await db.collection(COLLECTION_NAME)
      .where('restaurantId', '==', restaurantId)
      .where('startedAt', '<', cutoffDate)
      .limit(100)
      .get();

    const batch = db.batch();
    let deleted = 0;

    for (const doc of snapshot.docs) {
      // Delete messages subcollection first
      const messagesSnapshot = await doc.ref.collection('messages').get();
      messagesSnapshot.forEach(msgDoc => {
        batch.delete(msgDoc.ref);
      });

      // Delete the conversation document
      batch.delete(doc.ref);
      deleted++;
    }

    if (deleted > 0) {
      await batch.commit();
    }

    return { deleted };
  }

  /**
   * Get active session for user (if any)
   */
  async getActiveSession(userId, restaurantId) {
    const db = getDb();
    const snapshot = await db.collection(COLLECTION_NAME)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'active')
      .orderBy('startedAt', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    return {
      sessionId: doc.id,
      ...doc.data()
    };
  }

  /**
   * Build conversation history for OpenAI format
   */
  async buildOpenAIHistory(sessionId, maxMessages = 10) {
    const messages = await this.getRecentMessages(sessionId, maxMessages);

    return messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role,
        content: m.content
      }));
  }
}

module.exports = new DineAIConversationService();
