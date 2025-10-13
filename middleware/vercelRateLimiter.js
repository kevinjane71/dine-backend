const { db, collections } = require('../firebase');

// Vercel-compatible rate limiter using Firestore
const vercelRateLimiter = {
  // Rate limiting configuration
  config: {
    // Public API limits (more restrictive)
    public: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 100, // 100 requests per window
      blockDurationMs: 60 * 60 * 1000, // Block for 1 hour if exceeded
    },
    // Authenticated API limits (less restrictive)
    authenticated: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 1000, // 1000 requests per window
      blockDurationMs: 30 * 60 * 1000, // Block for 30 minutes if exceeded
    },
    // Chatbot API limits (moderate)
    chatbot: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      maxRequests: 200, // 200 requests per window
      blockDurationMs: 60 * 60 * 1000, // Block for 1 hour if exceeded
    }
  },

  // Get client identifier (IP + User-Agent for better tracking)
  getClientId(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
               req.headers['x-real-ip'] || 
               req.connection?.remoteAddress || 
               req.socket?.remoteAddress ||
               'unknown';
    
    const userAgent = req.headers['user-agent'] || 'unknown';
    return `${ip}-${userAgent}`;
  },

  // Get rate limit data from Firestore
  async getClientData(clientId) {
    try {
      const doc = await db.collection('rateLimits').doc(clientId).get();
      if (doc.exists) {
        return doc.data();
      }
      return null;
    } catch (error) {
      console.error('Error getting client data:', error);
      return null;
    }
  },

  // Save rate limit data to Firestore
  async saveClientData(clientId, data) {
    try {
      await db.collection('rateLimits').doc(clientId).set({
        ...data,
        lastUpdated: new Date().toISOString()
      }, { merge: true });
    } catch (error) {
      console.error('Error saving client data:', error);
    }
  },

  // Check if client is blocked
  async isBlocked(clientId) {
    const clientData = await this.getClientData(clientId);
    if (!clientData) return false;

    const now = Date.now();
    if (clientData.blockedUntil && now < clientData.blockedUntil) {
      return true;
    }

    // Remove block if expired
    if (clientData.blockedUntil && now >= clientData.blockedUntil) {
      await this.saveClientData(clientId, {
        blockedUntil: null,
        requestCount: 0,
        windowStart: now
      });
    }

    return false;
  },

  // Record request and check limits
  async recordRequest(clientId, type = 'public') {
    const now = Date.now();
    const config = this.config[type];
    
    let clientData = await this.getClientData(clientId);
    
    if (!clientData) {
      clientData = {
        requestCount: 0,
        windowStart: now,
        blockedUntil: null,
        totalRequests: 0,
        clientType: type
      };
    }

    // Reset window if expired
    if (now - clientData.windowStart > config.windowMs) {
      clientData.requestCount = 0;
      clientData.windowStart = now;
    }

    // Increment request count
    clientData.requestCount++;
    clientData.totalRequests++;

    // Check if limit exceeded
    if (clientData.requestCount > config.maxRequests) {
      clientData.blockedUntil = now + config.blockDurationMs;
      await this.saveClientData(clientId, clientData);
      
      return {
        allowed: false,
        remaining: 0,
        resetTime: clientData.windowStart + config.windowMs,
        blockedUntil: clientData.blockedUntil
      };
    }

    // Save updated data
    await this.saveClientData(clientId, clientData);

    return {
      allowed: true,
      remaining: config.maxRequests - clientData.requestCount,
      resetTime: clientData.windowStart + config.windowMs,
      blockedUntil: null
    };
  },

  // Clean up old entries (call periodically)
  async cleanup() {
    try {
      const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
      const cutoffDate = new Date(cutoffTime).toISOString();
      
      const snapshot = await db.collection('rateLimits')
        .where('lastUpdated', '<', cutoffDate)
        .limit(100)
        .get();
      
      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
      console.log(`🧹 Cleaned up ${snapshot.docs.length} old rate limit entries`);
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  },

  // Get rate limit info for client
  async getClientInfo(clientId) {
    const clientData = await this.getClientData(clientId);
    if (!clientData) return null;

    return {
      requestCount: clientData.requestCount,
      totalRequests: clientData.totalRequests,
      windowStart: clientData.windowStart,
      blockedUntil: clientData.blockedUntil,
      isBlocked: await this.isBlocked(clientId)
    };
  },

  // Get all rate limit stats
  async getStats() {
    try {
      const snapshot = await db.collection('rateLimits').get();
      const stats = {
        totalClients: snapshot.docs.length,
        blockedClients: 0,
        publicClients: 0,
        authenticatedClients: 0,
        chatbotClients: 0
      };

      snapshot.docs.forEach(doc => {
        const data = doc.data();
        if (data.blockedUntil && Date.now() < data.blockedUntil) {
          stats.blockedClients++;
        }
        if (data.clientType === 'public') stats.publicClients++;
        if (data.clientType === 'authenticated') stats.authenticatedClients++;
        if (data.clientType === 'chatbot') stats.chatbotClients++;
      });

      return stats;
    } catch (error) {
      console.error('Error getting stats:', error);
      return { totalClients: 0, blockedClients: 0 };
    }
  }
};

// Cleanup every hour (only runs when function is active)
let lastCleanup = 0;
const cleanupInterval = 60 * 60 * 1000; // 1 hour

const maybeCleanup = async () => {
  const now = Date.now();
  if (now - lastCleanup > cleanupInterval) {
    await vercelRateLimiter.cleanup();
    lastCleanup = now;
  }
};

module.exports = { vercelRateLimiter, maybeCleanup };
