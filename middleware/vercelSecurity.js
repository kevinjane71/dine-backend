const { vercelRateLimiter, maybeCleanup } = require('./vercelRateLimiter');
const { db, collections } = require('../firebase');

// Vercel-compatible security middleware using Firestore
const vercelSecurityMiddleware = {
  // Suspicious patterns to detect
  suspiciousPatterns: [
    /\.\./, // Directory traversal
    /<script/i, // XSS attempts
    /union.*select/i, // SQL injection
    /javascript:/i, // JavaScript injection
    /eval\(/i, // Code injection
    /base64/i, // Base64 encoding (often used for obfuscation)
    /cmd\.exe/i, // Command injection
    /powershell/i, // PowerShell injection
  ],

  // Suspicious user agents
  suspiciousUserAgents: [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scraper/i,
    /curl/i,
    /wget/i,
    /python/i,
    /java/i,
    /go-http/i,
    /okhttp/i,
  ],

  // Get blocked IPs from Firestore
  async getBlockedIPs() {
    try {
      const snapshot = await db.collection('blockedIPs')
        .where('blockedUntil', '>', new Date().toISOString())
        .get();
      
      const blockedIPs = new Set();
      snapshot.docs.forEach(doc => {
        const data = doc.data();
        blockedIPs.add(data.ip);
      });
      
      return blockedIPs;
    } catch (error) {
      console.error('Error getting blocked IPs:', error);
      return new Set();
    }
  },

  // Block IP in Firestore
  async blockIP(ip, duration = 60 * 60 * 1000) {
    try {
      const blockedUntil = new Date(Date.now() + duration).toISOString();
      await db.collection('blockedIPs').doc(ip).set({
        ip,
        blockedUntil,
        blockedAt: new Date().toISOString(),
        reason: 'Suspicious activity'
      });
      
      console.log(`🚫 Blocked IP: ${ip} until ${blockedUntil}`);
    } catch (error) {
      console.error('Error blocking IP:', error);
    }
  },

  // Check if request is suspicious
  isSuspiciousRequest(req) {
    const url = req.url || '';
    const body = JSON.stringify(req.body || {});
    const userAgent = req.headers['user-agent'] || '';
    const content = `${url} ${body} ${userAgent}`.toLowerCase();

    // Check for suspicious patterns
    for (const pattern of this.suspiciousPatterns) {
      if (pattern.test(content)) {
        return { suspicious: true, reason: `Suspicious pattern detected: ${pattern}` };
      }
    }

    // Check for suspicious user agents
    for (const pattern of this.suspiciousUserAgents) {
      if (pattern.test(userAgent)) {
        return { suspicious: true, reason: `Suspicious user agent: ${userAgent}` };
      }
    }

    return { suspicious: false };
  },

  // Get client IP
  getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           'unknown';
  },

  // Log security event to Firestore
  async logSecurityEvent(req, event, details = {}) {
    try {
      const clientIP = this.getClientIP(req);
      const userAgent = req.headers['user-agent'] || 'unknown';
      const timestamp = new Date().toISOString();

      const logData = {
        event,
        clientIP,
        userAgent,
        url: req.url,
        method: req.method,
        details,
        timestamp,
        requestId: req.id || 'unknown'
      };

      // Log to console for immediate visibility
      console.log(`🚨 SECURITY EVENT [${timestamp}]`, logData);

      // Save to Firestore for persistence
      await db.collection('securityLogs').add(logData);
    } catch (error) {
      console.error('Error logging security event:', error);
    }
  },

  // Main security middleware
  middleware(type = 'public') {
    return async (req, res, next) => {
      try {
        // Run cleanup if needed
        await maybeCleanup();

        const clientIP = this.getClientIP(req);
        const clientId = vercelRateLimiter.getClientId(req);

        // Whitelist for development and localhost
        const whitelistedIPs = [
          '127.0.0.1',      // localhost IPv4
          '::1',            // localhost IPv6
          '::ffff:127.0.0.1', // localhost IPv4 mapped to IPv6
          'localhost',      // localhost hostname
          '0.0.0.0'         // all interfaces
        ];

        // Skip security checks for whitelisted IPs
        if (whitelistedIPs.includes(clientIP) || clientIP.startsWith('127.') || clientIP.startsWith('192.168.') || clientIP.startsWith('10.')) {
          console.log(`🔓 Whitelisted IP accessing API: ${clientIP}`);
          return next();
        }

        // Check if IP is blocked
        const blockedIPs = await this.getBlockedIPs();
        if (blockedIPs.has(clientIP)) {
          await this.logSecurityEvent(req, 'BLOCKED_IP_ACCESS', { clientIP });
          return res.status(403).json({ 
            error: 'Access denied',
            code: 'IP_BLOCKED'
          });
        }

        // Check for suspicious requests
        const suspiciousCheck = this.isSuspiciousRequest(req);
        if (suspiciousCheck.suspicious) {
          await this.logSecurityEvent(req, 'SUSPICIOUS_REQUEST', { 
            reason: suspiciousCheck.reason,
            clientIP 
          });
          
          // Block suspicious IPs temporarily
          await vercelSecurityMiddleware.blockIP(clientIP, 60 * 60 * 1000); // Block for 1 hour

          return res.status(403).json({ 
            error: 'Suspicious activity detected',
            code: 'SUSPICIOUS_REQUEST'
          });
        }

        // Check if client is rate limited
        const isBlocked = await vercelRateLimiter.isBlocked(clientId);
        if (isBlocked) {
          await this.logSecurityEvent(req, 'RATE_LIMIT_BLOCKED', { clientId, clientIP });
          return res.status(429).json({ 
            error: 'Too many requests. Please try again later.',
            code: 'RATE_LIMITED'
          });
        }

        // Record request and check limits
        const rateLimitResult = await vercelRateLimiter.recordRequest(clientId, type);
        
        if (!rateLimitResult.allowed) {
          await this.logSecurityEvent(req, 'RATE_LIMIT_EXCEEDED', { 
            clientId, 
            clientIP,
            blockedUntil: rateLimitResult.blockedUntil
          });
          
          return res.status(429).json({ 
            error: 'Rate limit exceeded. Please try again later.',
            code: 'RATE_LIMITED',
            retryAfter: Math.ceil((rateLimitResult.blockedUntil - Date.now()) / 1000)
          });
        }

        // Add rate limit headers
        res.set({
          'X-RateLimit-Limit': vercelRateLimiter.config[type].maxRequests,
          'X-RateLimit-Remaining': rateLimitResult.remaining,
          'X-RateLimit-Reset': new Date(rateLimitResult.resetTime).toISOString()
        });

        next();
      } catch (error) {
        console.error('Security middleware error:', error);
        // In case of error, allow request but log it
        next();
      }
    };
  },

  // Public API security (most restrictive)
  publicAPI: function(req, res, next) {
    return vercelSecurityMiddleware.middleware('public')(req, res, next);
  },

  // Authenticated API security (less restrictive)
  authenticatedAPI: function(req, res, next) {
    return vercelSecurityMiddleware.middleware('authenticated')(req, res, next);
  },

  // Chatbot API security (moderate)
  chatbotAPI: function(req, res, next) {
    return vercelSecurityMiddleware.middleware('chatbot')(req, res, next);
  },

  // Add IP to block list (wrapper function)
  async addToBlockList(ip, duration = 60 * 60 * 1000) {
    await vercelSecurityMiddleware.blockIP(ip, duration);
    console.log(`🚫 Blocked IP: ${ip} for ${duration / 1000 / 60} minutes`);
  },

  // Clear blocked IPs for localhost/development
  async clearLocalhostBlocks() {
    try {
      const whitelistedIPs = [
        '127.0.0.1',
        '::1',
        '::ffff:127.0.0.1',
        'localhost',
        '0.0.0.0'
      ];

      for (const ip of whitelistedIPs) {
        try {
          await db.collection('blockedIPs').doc(ip).delete();
          console.log(`🔓 Cleared block for IP: ${ip}`);
        } catch (error) {
          // Ignore if document doesn't exist
        }
      }

      // Also clear any 127.x.x.x, 192.168.x.x, and 10.x.x.x ranges
      const snapshot = await db.collection('blockedIPs').get();
      const batch = db.batch();
      
      snapshot.docs.forEach(doc => {
        const ip = doc.id;
        if (ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.')) {
          batch.delete(doc.ref);
          console.log(`🔓 Cleared block for local IP: ${ip}`);
        }
      });
      
      await batch.commit();
    } catch (error) {
      console.error('Error clearing localhost blocks:', error);
    }
  },

  // Get security stats
  async getStats() {
    try {
      const rateLimitStats = await vercelRateLimiter.getStats();
      
      // Get blocked IPs count
      const blockedIPsSnapshot = await db.collection('blockedIPs')
        .where('blockedUntil', '>', new Date().toISOString())
        .get();
      
      return {
        ...rateLimitStats,
        blockedIPs: blockedIPsSnapshot.docs.length,
        suspiciousPatterns: this.suspiciousPatterns.length
      };
    } catch (error) {
      console.error('Error getting security stats:', error);
      return { totalClients: 0, blockedClients: 0, blockedIPs: 0 };
    }
  }
};

module.exports = vercelSecurityMiddleware;
