const rateLimiter = {
  // Store for rate limiting (in production, use Redis or similar)
  requests: new Map(),
  
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
    const ip = req.headers['x-forwarded-for'] || 
               req.headers['x-real-ip'] || 
               req.connection.remoteAddress || 
               req.socket.remoteAddress ||
               (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
               'unknown';
    
    const userAgent = req.headers['user-agent'] || 'unknown';
    return `${ip}-${userAgent}`;
  },

  // Check if client is blocked
  isBlocked(clientId) {
    const clientData = this.requests.get(clientId);
    if (!clientData) return false;

    const now = Date.now();
    if (clientData.blockedUntil && now < clientData.blockedUntil) {
      return true;
    }

    // Remove block if expired
    if (clientData.blockedUntil && now >= clientData.blockedUntil) {
      clientData.blockedUntil = null;
      clientData.requestCount = 0;
      clientData.windowStart = now;
    }

    return false;
  },

  // Record request and check limits
  recordRequest(clientId, type = 'public') {
    const now = Date.now();
    const config = this.config[type];
    
    let clientData = this.requests.get(clientId);
    
    if (!clientData) {
      clientData = {
        requestCount: 0,
        windowStart: now,
        blockedUntil: null,
        totalRequests: 0
      };
      this.requests.set(clientId, clientData);
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
      return {
        allowed: false,
        remaining: 0,
        resetTime: clientData.windowStart + config.windowMs,
        blockedUntil: clientData.blockedUntil
      };
    }

    return {
      allowed: true,
      remaining: config.maxRequests - clientData.requestCount,
      resetTime: clientData.windowStart + config.windowMs,
      blockedUntil: null
    };
  },

  // Clean up old entries (call periodically)
  cleanup() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    for (const [clientId, data] of this.requests.entries()) {
      if (now - data.windowStart > maxAge) {
        this.requests.delete(clientId);
      }
    }
  },

  // Get rate limit info for client
  getClientInfo(clientId) {
    const clientData = this.requests.get(clientId);
    if (!clientData) return null;

    return {
      requestCount: clientData.requestCount,
      totalRequests: clientData.totalRequests,
      windowStart: clientData.windowStart,
      blockedUntil: clientData.blockedUntil,
      isBlocked: this.isBlocked(clientId)
    };
  }
};

// Cleanup every hour
setInterval(() => {
  rateLimiter.cleanup();
}, 60 * 60 * 1000);

module.exports = rateLimiter;






