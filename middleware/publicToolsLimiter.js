const { db } = require('../firebase');

// Public Tools Rate Limiter (IP-based, no auth required)
const publicToolsLimiter = {
  dailyLimit: 10,

  getTodayKey() {
    return new Date().toISOString().split('T')[0];
  },

  getIP(req) {
    return (
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.connection?.remoteAddress ||
      'unknown'
    );
  },

  sanitizeIP(ip) {
    return ip.replace(/[^a-zA-Z0-9._-]/g, '_');
  },

  async getIPUsage(ip) {
    try {
      const todayKey = this.getTodayKey();
      const docId = `ip_${this.sanitizeIP(ip)}_${todayKey}`;
      const doc = await db.collection('publicToolUsage').doc(docId).get();

      if (doc.exists) {
        return doc.data();
      }

      return { ipAddress: ip, date: todayKey, callCount: 0, lastCallAt: null };
    } catch (error) {
      console.error('Error getting public tool IP usage:', error);
      return null;
    }
  },

  async recordUsage(ip, tool) {
    try {
      const todayKey = this.getTodayKey();
      const now = new Date().toISOString();
      const docId = `ip_${this.sanitizeIP(ip)}_${todayKey}`;
      const ref = db.collection('publicToolUsage').doc(docId);

      await ref.set(
        {
          ipAddress: ip,
          date: todayKey,
          callCount: 1,
          lastCallAt: now,
          lastTool: tool,
          createdAt: now,
        },
        { merge: true }
      );

      await ref.update({
        callCount: db.FieldValue.increment(1),
        lastCallAt: now,
        lastTool: tool,
      });

      return true;
    } catch (error) {
      console.error('Error recording public tool usage:', error);
      return false;
    }
  },

  getNextResetTime() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.toISOString();
  },

  middleware() {
    return async (req, res, next) => {
      try {
        const ip = this.getIP(req);
        const usage = await this.getIPUsage(ip);

        if (usage && usage.callCount >= this.dailyLimit) {
          return res.status(429).json({
            error: 'Daily limit reached',
            code: 'PUBLIC_TOOL_LIMIT_EXCEEDED',
            remaining: 0,
            limit: this.dailyLimit,
            resetTime: this.getNextResetTime(),
            message:
              'You have used all 10 free AI generations for today. Try again tomorrow or sign up for unlimited access.',
          });
        }

        req.publicToolUsage = {
          ip,
          remaining: this.dailyLimit - ((usage?.callCount || 0) + 1),
        };

        next();
      } catch (error) {
        console.error('Public tools limiter error:', error);
        next();
      }
    };
  },
};

module.exports = publicToolsLimiter;
