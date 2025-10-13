const rateLimiter = require('./rateLimiter');

// Security middleware for API protection
const securityMiddleware = {
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

  // Known malicious IPs (in production, use a threat intelligence service)
  blockedIPs: new Set([
    // Add known malicious IPs here
  ]),

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
           req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
           'unknown';
  },

  // Log security event
  logSecurityEvent(req, event, details = {}) {
    const clientIP = this.getClientIP(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const timestamp = new Date().toISOString();

    console.log(`🚨 SECURITY EVENT [${timestamp}]`, {
      event,
      clientIP,
      userAgent,
      url: req.url,
      method: req.method,
      details
    });

    // In production, send to security monitoring service
    // Example: send to Sentry, DataDog, or custom security dashboard
  },

  // Main security middleware
  middleware(type = 'public') {
    return (req, res, next) => {
      const clientIP = this.getClientIP(req);
      const clientId = rateLimiter.getClientId(req);

      // Check if IP is blocked
      if (this.blockedIPs.has(clientIP)) {
        this.logSecurityEvent(req, 'BLOCKED_IP_ACCESS', { clientIP });
        return res.status(403).json({ 
          error: 'Access denied',
          code: 'IP_BLOCKED'
        });
      }

      // Check for suspicious requests
      const suspiciousCheck = this.isSuspiciousRequest(req);
      if (suspiciousCheck.suspicious) {
        this.logSecurityEvent(req, 'SUSPICIOUS_REQUEST', { 
          reason: suspiciousCheck.reason,
          clientIP 
        });
        
        // Block suspicious IPs temporarily
        this.blockedIPs.add(clientIP);
        setTimeout(() => {
          this.blockedIPs.delete(clientIP);
        }, 60 * 60 * 1000); // Block for 1 hour

        return res.status(403).json({ 
          error: 'Suspicious activity detected',
          code: 'SUSPICIOUS_REQUEST'
        });
      }

      // Check if client is rate limited
      if (rateLimiter.isBlocked(clientId)) {
        this.logSecurityEvent(req, 'RATE_LIMIT_BLOCKED', { clientId, clientIP });
        return res.status(429).json({ 
          error: 'Too many requests. Please try again later.',
          code: 'RATE_LIMITED'
        });
      }

      // Record request and check limits
      const rateLimitResult = rateLimiter.recordRequest(clientId, type);
      
      if (!rateLimitResult.allowed) {
        this.logSecurityEvent(req, 'RATE_LIMIT_EXCEEDED', { 
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
        'X-RateLimit-Limit': rateLimiter.config[type].maxRequests,
        'X-RateLimit-Remaining': rateLimitResult.remaining,
        'X-RateLimit-Reset': new Date(rateLimitResult.resetTime).toISOString()
      });

      next();
    };
  },

  // Public API security (most restrictive)
  publicAPI: function(req, res, next) {
    return this.middleware('public')(req, res, next);
  },

  // Authenticated API security (less restrictive)
  authenticatedAPI: function(req, res, next) {
    return this.middleware('authenticated')(req, res, next);
  },

  // Chatbot API security (moderate)
  chatbotAPI: function(req, res, next) {
    return this.middleware('chatbot')(req, res, next);
  },

  // Add IP to block list
  blockIP(ip, duration = 60 * 60 * 1000) {
    this.blockedIPs.add(ip);
    setTimeout(() => {
      this.blockedIPs.delete(ip);
    }, duration);
    
    console.log(`🚫 Blocked IP: ${ip} for ${duration / 1000 / 60} minutes`);
  },

  // Get security stats
  getStats() {
    return {
      blockedIPs: this.blockedIPs.size,
      rateLimitClients: rateLimiter.requests.size,
      suspiciousPatterns: this.suspiciousPatterns.length
    };
  }
};

module.exports = securityMiddleware;
