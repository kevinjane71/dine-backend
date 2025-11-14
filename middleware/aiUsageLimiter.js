const { db, collections } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');

/**
 * AI Usage Limiter Middleware
 * Tracks and limits AI agent (chatbot/voice bot) usage per user based on their subscription plan
 * 
 * Plan Limits:
 * - Starter: 500 credits/month
 * - Professional: 1000 credits/month
 * - Enterprise: 2000 credits/month
 * 
 * Resets automatically when month changes
 */
class AIUsageLimiter {
  constructor() {
    this.planLimits = {
      'starter': 500,
      'professional': 1000,
      'enterprise': 2000
    };
  }

  /**
   * Get current month string (YYYY-MM format)
   */
  getCurrentMonth() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * Get user's subscription plan
   */
  async getUserPlan(userId) {
    try {
      // Check dine_user_data collection (primary source for subscription)
      const userDoc = await db.collection('dine_user_data').doc(userId).get();
      
      if (userDoc.exists) {
        const userData = userDoc.data();
        if (userData.subscription?.planId) {
          const planId = userData.subscription.planId.toLowerCase();
          // Map plan IDs to standard format
          if (planId.includes('starter')) return 'starter';
          if (planId.includes('professional')) return 'professional';
          if (planId.includes('enterprise')) return 'enterprise';
          return planId;
        }
        if (userData.subscription?.planName) {
          const planName = userData.subscription.planName.toLowerCase();
          if (planName.includes('starter')) return 'starter';
          if (planName.includes('professional')) return 'professional';
          if (planName.includes('enterprise')) return 'enterprise';
        }
      }

      // Check userRestaurants collection for plan info
      const userRestaurantSnapshot = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .limit(1)
        .get();

      if (!userRestaurantSnapshot.empty) {
        const userData = userRestaurantSnapshot.docs[0].data();
        // Check if plan is stored in userRestaurants
        if (userData.plan) {
          const plan = userData.plan.toLowerCase();
          if (plan.includes('starter')) return 'starter';
          if (plan.includes('professional')) return 'professional';
          if (plan.includes('enterprise')) return 'enterprise';
          return plan;
        }
      }

      // Check subscriptions collection
      const subscriptionSnapshot = await db.collection('subscriptions')
        .where('userId', '==', userId)
        .where('status', '==', 'active')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (!subscriptionSnapshot.empty) {
        const subscription = subscriptionSnapshot.docs[0].data();
        if (subscription.planId) {
          const planId = subscription.planId.toLowerCase();
          if (planId.includes('starter')) return 'starter';
          if (planId.includes('professional')) return 'professional';
          if (planId.includes('enterprise')) return 'enterprise';
          return planId;
        }
        if (subscription.planName) {
          // Map plan names to IDs
          const planName = subscription.planName.toLowerCase();
          if (planName.includes('starter')) return 'starter';
          if (planName.includes('professional')) return 'professional';
          if (planName.includes('enterprise')) return 'enterprise';
        }
      }

      // Default to starter if no plan found
      return 'starter';
    } catch (error) {
      console.error('Error getting user plan:', error);
      return 'starter'; // Default to starter on error
    }
  }

  /**
   * Get or initialize AI usage data for user
   */
  async getAIUsage(userId) {
    try {
      // Check if user has AI usage document
      const usageDoc = await db.collection('aiUsage').doc(userId).get();

      if (usageDoc.exists) {
        return usageDoc.data();
      }

      // Initialize new usage document
      const currentMonth = this.getCurrentMonth();
      const initialData = {
        userId,
        creditsUsed: 0,
        creditsMonth: currentMonth,
        lastUpdated: FieldValue.serverTimestamp()
      };

      await db.collection('aiUsage').doc(userId).set(initialData);
      return initialData;
    } catch (error) {
      console.error('Error getting AI usage:', error);
      // Return default on error
      return {
        creditsUsed: 0,
        creditsMonth: this.getCurrentMonth()
      };
    }
  }

  /**
   * Update AI usage for user
   */
  async updateAIUsage(userId, increment = 1) {
    try {
      const currentMonth = this.getCurrentMonth();
      const usageData = await this.getAIUsage(userId);

      // Check if month has changed
      if (usageData.creditsMonth !== currentMonth) {
        // Reset counter for new month
        await db.collection('aiUsage').doc(userId).set({
          userId,
          creditsUsed: increment,
          creditsMonth: currentMonth,
          lastUpdated: FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`🔄 AI usage reset for user ${userId} - new month: ${currentMonth}`);
        return {
          creditsUsed: increment,
          creditsMonth: currentMonth,
          reset: true
        };
      } else {
        // Increment existing counter
        const newCount = (usageData.creditsUsed || 0) + increment;
        await db.collection('aiUsage').doc(userId).update({
          creditsUsed: newCount,
          lastUpdated: FieldValue.serverTimestamp()
        });

        return {
          creditsUsed: newCount,
          creditsMonth: currentMonth,
          reset: false
        };
      }
    } catch (error) {
      console.error('Error updating AI usage:', error);
      throw error;
    }
  }

  /**
   * Check if user has exceeded their AI credit limit
   */
  async checkLimit(userId) {
    try {
      const plan = await this.getUserPlan(userId);
      const limit = this.planLimits[plan] || this.planLimits['starter'];
      
      const currentMonth = this.getCurrentMonth();
      const usageData = await this.getAIUsage(userId);

      // If month changed, reset is needed
      if (usageData.creditsMonth !== currentMonth) {
        return {
          allowed: true,
          limit,
          used: 0,
          remaining: limit,
          plan,
          reset: true
        };
      }

      const used = usageData.creditsUsed || 0;
      const remaining = Math.max(0, limit - used);

      return {
        allowed: used < limit,
        limit,
        used,
        remaining,
        plan,
        reset: false
      };
    } catch (error) {
      console.error('Error checking AI limit:', error);
      // Allow on error to prevent blocking users
      return {
        allowed: true,
        limit: this.planLimits['starter'],
        used: 0,
        remaining: this.planLimits['starter'],
        plan: 'starter',
        reset: false
      };
    }
  }

  /**
   * Middleware function to check and track AI usage
   */
  middleware() {
    return async (req, res, next) => {
      try {
        // Only apply to chatbot/voice bot endpoints
        const isChatbotRequest = 
          req.path.includes('/chatbot/') || 
          req.path.includes('/voice/') ||
          req.path.includes('/intelligent-query');

        if (!isChatbotRequest) {
          return next(); // Skip for non-AI requests
        }

        // Get user ID from authenticated request
        const userId = req.user?.userId || req.user?.uid || req.user?.id;
        
        if (!userId) {
          console.warn('⚠️ AI Usage Limiter: No user ID found in request');
          return next(); // Allow request if no user ID (shouldn't happen with auth middleware)
        }

        // Check limit
        const limitCheck = await this.checkLimit(userId);

        if (!limitCheck.allowed) {
          console.log(`🚫 AI usage limit reached for user ${userId}: ${limitCheck.used}/${limitCheck.limit} (Plan: ${limitCheck.plan})`);
          
          return res.status(429).json({
            success: false,
            error: 'AI usage limit reached',
            message: `You have reached your monthly AI credit limit (${limitCheck.used}/${limitCheck.limit} credits used). Your credits will reset next month. For more credits, please upgrade your plan or contact DineOpen support.`,
            limit: limitCheck.limit,
            used: limitCheck.used,
            remaining: 0,
            plan: limitCheck.plan,
            resetDate: this.getNextMonthResetDate()
          });
        }

        // If month changed, reset first
        if (limitCheck.reset) {
          await this.updateAIUsage(userId, 1);
        } else {
          // Increment usage
          await this.updateAIUsage(userId, 1);
        }

        // Get updated usage after increment
        const updatedUsage = await this.getAIUsage(userId);
        const plan = await this.getUserPlan(userId);
        const limit = this.planLimits[plan] || this.planLimits['starter'];

        // Add usage info to request for logging
        req.aiUsage = {
          used: updatedUsage.creditsUsed || 0,
          limit,
          remaining: Math.max(0, limit - (updatedUsage.creditsUsed || 0)),
          plan
        };

        console.log(`✅ AI usage tracked for user ${userId}: ${updatedUsage.creditsUsed}/${limit} (Plan: ${plan}, Remaining: ${req.aiUsage.remaining})`);

        next();
      } catch (error) {
        console.error('AI Usage Limiter middleware error:', error);
        // Allow request on error to prevent blocking users
        next();
      }
    };
  }

  /**
   * Get next month reset date for error messages
   */
  getNextMonthResetDate() {
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth.toISOString().split('T')[0];
  }

  /**
   * Get current usage for a user (for API endpoints)
   */
  async getUsage(userId) {
    try {
      const plan = await this.getUserPlan(userId);
      const limit = this.planLimits[plan] || this.planLimits['starter'];
      const usageData = await this.getAIUsage(userId);
      const currentMonth = this.getCurrentMonth();

      // Check if month changed
      const used = (usageData.creditsMonth === currentMonth) ? (usageData.creditsUsed || 0) : 0;
      const remaining = Math.max(0, limit - used);

      return {
        plan,
        limit,
        used,
        remaining,
        month: currentMonth,
        resetDate: this.getNextMonthResetDate()
      };
    } catch (error) {
      console.error('Error getting AI usage:', error);
      return {
        plan: 'starter',
        limit: this.planLimits['starter'],
        used: 0,
        remaining: this.planLimits['starter'],
        month: this.getCurrentMonth(),
        resetDate: this.getNextMonthResetDate()
      };
    }
  }
}

// Export singleton instance
const aiUsageLimiter = new AIUsageLimiter();

module.exports = aiUsageLimiter;

