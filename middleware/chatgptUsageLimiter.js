const { db, collections } = require('../firebase');

// ChatGPT API Usage Limiter
const chatgptUsageLimiter = {
  // Default configuration (can be overridden by DB config)
  defaultConfig: {
    dailyLimit: process.env.NODE_ENV === 'development' ? 50 : 5, // Higher limits for development
    resetTime: '00:00', // UTC time for daily reset
    ipLimit: process.env.NODE_ENV === 'development' ? 100 : 10, // Higher limits for development
    userLimit: process.env.NODE_ENV === 'development' ? 50 : 5, // Higher limits for development
    enabled: true
  },

  // Get current configuration from database
  async getConfig() {
    try {
      const configDoc = await db.collection('systemConfig').doc('chatgptLimits').get();
      if (configDoc.exists) {
        const config = configDoc.data();
        return {
          ...this.defaultConfig,
          ...config,
          lastUpdated: configDoc.updateTime?.toDate()
        };
      }
      return this.defaultConfig;
    } catch (error) {
      console.error('Error getting ChatGPT config:', error);
      return this.defaultConfig;
    }
  },

  // Update configuration in database
  async updateConfig(newConfig) {
    try {
      await db.collection('systemConfig').doc('chatgptLimits').set({
        ...newConfig,
        updatedAt: new Date().toISOString(),
        updatedBy: 'admin'
      }, { merge: true });
      
      console.log('✅ ChatGPT limits configuration updated:', newConfig);
      return true;
    } catch (error) {
      console.error('Error updating ChatGPT config:', error);
      return false;
    }
  },

  // Get today's date key for tracking
  getTodayKey() {
    const now = new Date();
    return now.toISOString().split('T')[0]; // YYYY-MM-DD format
  },

  // Get user's ChatGPT usage for today
  async getUserUsage(userId) {
    try {
      const todayKey = this.getTodayKey();
      const doc = await db.collection('chatgptUsage').doc(`${userId}_${todayKey}`).get();
      
      if (doc.exists) {
        return doc.data();
      }
      
      return {
        userId,
        date: todayKey,
        callCount: 0,
        lastCallAt: null,
        ipAddresses: [],
        totalTokensUsed: 0
      };
    } catch (error) {
      console.error('Error getting user usage:', error);
      return null;
    }
  },

  // Get IP's ChatGPT usage for today
  async getIPUsage(ipAddress) {
    try {
      const todayKey = this.getTodayKey();
      const doc = await db.collection('chatgptUsage').doc(`ip_${ipAddress}_${todayKey}`).get();
      
      if (doc.exists) {
        return doc.data();
      }
      
      return {
        ipAddress,
        date: todayKey,
        callCount: 0,
        lastCallAt: null,
        userIds: [],
        totalTokensUsed: 0
      };
    } catch (error) {
      console.error('Error getting IP usage:', error);
      return null;
    }
  },

  // Record ChatGPT API call
  async recordUsage(userId, ipAddress, tokensUsed = 0) {
    try {
      const todayKey = this.getTodayKey();
      const now = new Date().toISOString();
      
      // Update user usage
      const userUsageRef = db.collection('chatgptUsage').doc(`${userId}_${todayKey}`);
      await userUsageRef.set({
        userId,
        date: todayKey,
        callCount: 1,
        lastCallAt: now,
        ipAddresses: [ipAddress],
        totalTokensUsed: tokensUsed,
        createdAt: now
      }, { merge: true });

      // Increment call count
      await userUsageRef.update({
        callCount: db.FieldValue.increment(1),
        totalTokensUsed: db.FieldValue.increment(tokensUsed),
        lastCallAt: now
      });

      // Update IP usage
      const ipUsageRef = db.collection('chatgptUsage').doc(`ip_${ipAddress}_${todayKey}`);
      await ipUsageRef.set({
        ipAddress,
        date: todayKey,
        callCount: 1,
        lastCallAt: now,
        userIds: [userId],
        totalTokensUsed: tokensUsed,
        createdAt: now
      }, { merge: true });

      // Increment IP call count
      await ipUsageRef.update({
        callCount: db.FieldValue.increment(1),
        totalTokensUsed: db.FieldValue.increment(tokensUsed),
        lastCallAt: now
      });

      console.log(`📊 ChatGPT usage recorded - User: ${userId}, IP: ${ipAddress}, Tokens: ${tokensUsed}`);
      return true;
    } catch (error) {
      console.error('Error recording ChatGPT usage:', error);
      return false;
    }
  },

  // Check if user/IP can make ChatGPT API call
  async canMakeCall(userId, ipAddress) {
    try {
      const config = await this.getConfig();
      
      if (!config.enabled) {
        return { allowed: true, reason: 'Limits disabled' };
      }

      const userUsage = await this.getUserUsage(userId);
      const ipUsage = await this.getIPUsage(ipAddress);

      // Check user limit
      if (userUsage && userUsage.callCount >= config.userLimit) {
        return {
          allowed: false,
          reason: 'User daily limit exceeded',
          limitType: 'user',
          currentUsage: userUsage.callCount,
          limit: config.userLimit,
          resetTime: this.getNextResetTime()
        };
      }

      // Check IP limit
      if (ipUsage && ipUsage.callCount >= config.ipLimit) {
        return {
          allowed: false,
          reason: 'IP daily limit exceeded',
          limitType: 'ip',
          currentUsage: ipUsage.callCount,
          limit: config.ipLimit,
          resetTime: this.getNextResetTime()
        };
      }

      return {
        allowed: true,
        reason: 'Within limits',
        userUsage: userUsage?.callCount || 0,
        ipUsage: ipUsage?.callCount || 0,
        userLimit: config.userLimit,
        ipLimit: config.ipLimit
      };
    } catch (error) {
      console.error('Error checking ChatGPT limits:', error);
      // In case of error, allow the call but log it
      return { allowed: true, reason: 'Error checking limits - allowing call' };
    }
  },

  // Get next reset time
  getNextResetTime() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.toISOString();
  },

  // Get usage statistics
  async getUsageStats(userId = null, ipAddress = null) {
    try {
      const todayKey = this.getTodayKey();
      const config = await this.getConfig();
      
      let query = db.collection('chatgptUsage')
        .where('date', '==', todayKey);
      
      if (userId) {
        query = query.where('userId', '==', userId);
      }
      
      if (ipAddress) {
        query = query.where('ipAddress', '==', ipAddress);
      }

      const snapshot = await query.get();
      const stats = {
        totalCalls: 0,
        totalTokens: 0,
        uniqueUsers: new Set(),
        uniqueIPs: new Set(),
        config: config
      };

      snapshot.docs.forEach(doc => {
        const data = doc.data();
        stats.totalCalls += data.callCount || 0;
        stats.totalTokens += data.totalTokensUsed || 0;
        
        if (data.userId) stats.uniqueUsers.add(data.userId);
        if (data.ipAddress) stats.uniqueIPs.add(data.ipAddress);
      });

      stats.uniqueUsers = stats.uniqueUsers.size;
      stats.uniqueIPs = stats.uniqueIPs.size;

      return stats;
    } catch (error) {
      console.error('Error getting usage stats:', error);
      return null;
    }
  },

  // Clean up old usage data (run daily)
  async cleanupOldData() {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 30); // Keep 30 days
      const cutoffKey = cutoffDate.toISOString().split('T')[0];

      const snapshot = await db.collection('chatgptUsage')
        .where('date', '<', cutoffKey)
        .limit(100)
        .get();

      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });

      await batch.commit();
      console.log(`🧹 Cleaned up ${snapshot.docs.length} old ChatGPT usage records`);
    } catch (error) {
      console.error('Error cleaning up old data:', error);
    }
  },

  // Middleware for ChatGPT API calls
  middleware() {
    return async (req, res, next) => {
      try {
        const userId = req.user?.userId;
        const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                         req.headers['x-real-ip'] || 
                         req.connection?.remoteAddress || 
                         'unknown';

        if (!userId) {
          return res.status(401).json({ 
            error: 'Authentication required for ChatGPT API calls',
            code: 'AUTH_REQUIRED'
          });
        }

        const canMakeCall = await this.canMakeCall(userId, ipAddress);
        
        if (!canMakeCall.allowed) {
          // Log the blocked attempt
          await db.collection('chatgptUsage').add({
            type: 'BLOCKED_ATTEMPT',
            userId,
            ipAddress,
            reason: canMakeCall.reason,
            limitType: canMakeCall.limitType,
            currentUsage: canMakeCall.currentUsage,
            limit: canMakeCall.limit,
            timestamp: new Date().toISOString(),
            url: req.url,
            method: req.method
          });

          return res.status(429).json({
            error: 'Daily ChatGPT API limit exceeded',
            code: 'CHATGPT_LIMIT_EXCEEDED',
            reason: canMakeCall.reason,
            limitType: canMakeCall.limitType,
            currentUsage: canMakeCall.currentUsage,
            limit: canMakeCall.limit,
            resetTime: canMakeCall.resetTime,
            message: 'Your daily ChatGPT API limit has been reached. Please try again tomorrow.'
          });
        }

        // Add usage info to request for later recording
        req.chatgptUsage = {
          userId,
          ipAddress,
          canMakeCall
        };

        next();
      } catch (error) {
        console.error('ChatGPT middleware error:', error);
        // In case of error, allow the call but log it
        next();
      }
    };
  },

  // Record successful ChatGPT API call
  async recordSuccessfulCall(req, tokensUsed = 0) {
    try {
      if (req.chatgptUsage) {
        await this.recordUsage(
          req.chatgptUsage.userId,
          req.chatgptUsage.ipAddress,
          tokensUsed
        );
      }
    } catch (error) {
      console.error('Error recording successful call:', error);
    }
  }
};

module.exports = chatgptUsageLimiter;

