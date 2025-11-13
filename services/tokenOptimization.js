const admin = require('firebase-admin');

class TokenOptimizationService {
  constructor() {
    this.dailyLimits = {
      'gpt-3.5-turbo': 100000, // tokens per day
      'gpt-4': 50000
    };
    
    this.costPerToken = {
      'gpt-3.5-turbo': {
        input: 0.0015 / 1000,  // $0.0015 per 1K tokens
        output: 0.002 / 1000   // $0.002 per 1K tokens
      },
      'gpt-4': {
        input: 0.03 / 1000,    // $0.03 per 1K tokens
        output: 0.06 / 1000    // $0.06 per 1K tokens
      }
    };
  }

  // Track token usage
  async trackTokenUsage(restaurantId, model, inputTokens, outputTokens, cost) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const docId = `${restaurantId}_${today}`;
      
      const usageData = {
        restaurantId,
        date: today,
        model,
        inputTokens: admin.firestore.FieldValue.increment(inputTokens),
        outputTokens: admin.firestore.FieldValue.increment(outputTokens),
        totalTokens: admin.firestore.FieldValue.increment(inputTokens + outputTokens),
        cost: admin.firestore.FieldValue.increment(cost),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      };

      await admin.firestore()
        .collection('token_usage')
        .doc(docId)
        .set(usageData, { merge: true });

      console.log(`📊 Token usage tracked: ${inputTokens + outputTokens} tokens, $${cost.toFixed(4)}`);
      
    } catch (error) {
      console.error('Token tracking error:', error);
    }
  }

  // Check if restaurant has exceeded daily limits
  async checkDailyLimit(restaurantId, model) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const docId = `${restaurantId}_${today}`;
      
      const usageDoc = await admin.firestore()
        .collection('token_usage')
        .doc(docId)
        .get();

      if (!usageDoc.exists) {
        return { withinLimit: true, usage: 0, limit: this.dailyLimits[model] };
      }

      const usage = usageDoc.data();
      const totalTokens = usage.totalTokens || 0;
      const limit = this.dailyLimits[model];

      return {
        withinLimit: totalTokens < limit,
        usage: totalTokens,
        limit,
        remaining: limit - totalTokens
      };

    } catch (error) {
      console.error('Daily limit check error:', error);
      return { withinLimit: true, usage: 0, limit: this.dailyLimits[model] };
    }
  }

  // Calculate cost for a request
  calculateCost(model, inputTokens, outputTokens) {
    const rates = this.costPerToken[model];
    if (!rates) return 0;

    const inputCost = inputTokens * rates.input;
    const outputCost = outputTokens * rates.output;
    
    return inputCost + outputCost;
  }

  // Get usage statistics
  async getUsageStats(restaurantId, days = 7) {
    try {
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - (days * 24 * 60 * 60 * 1000));
      
      const usageSnapshot = await admin.firestore()
        .collection('token_usage')
        .where('restaurantId', '==', restaurantId)
        .where('date', '>=', startDate.toISOString().split('T')[0])
        .orderBy('date', 'desc')
        .get();

      const stats = {
        totalTokens: 0,
        totalCost: 0,
        dailyBreakdown: [],
        modelBreakdown: {}
      };

      usageSnapshot.forEach(doc => {
        const data = doc.data();
        stats.totalTokens += data.totalTokens || 0;
        stats.totalCost += data.cost || 0;
        
        stats.dailyBreakdown.push({
          date: data.date,
          tokens: data.totalTokens || 0,
          cost: data.cost || 0,
          model: data.model
        });

        if (!stats.modelBreakdown[data.model]) {
          stats.modelBreakdown[data.model] = {
            tokens: 0,
            cost: 0
          };
        }
        stats.modelBreakdown[data.model].tokens += data.totalTokens || 0;
        stats.modelBreakdown[data.model].cost += data.cost || 0;
      });

      return stats;

    } catch (error) {
      console.error('Usage stats error:', error);
      return null;
    }
  }

  // Optimize context based on usage patterns
  async optimizeContext(restaurantId, intent, query) {
    try {
      // Get recent usage patterns
      const stats = await this.getUsageStats(restaurantId, 3);
      
      if (!stats || stats.totalCost > 5) { // If cost > $5 in 3 days
        console.log(`💰 High usage detected for restaurant ${restaurantId}, optimizing context`);
        
        // Return minimal context for expensive operations
        return {
          optimized: true,
          reason: 'High usage detected',
          context: await this.getMinimalContext(restaurantId, intent)
        };
      }

      return {
        optimized: false,
        context: null
      };

    } catch (error) {
      console.error('Context optimization error:', error);
      return { optimized: false, context: null };
    }
  }

  // Get minimal context for cost optimization
  async getMinimalContext(restaurantId, intent) {
    const minimalContexts = {
      table_management: {
        tables: 'Use table API endpoints',
        actions: ['book', 'free', 'status']
      },
      menu_query: {
        categories: 'Use menu API endpoints',
        actions: ['search', 'filter', 'price']
      },
      order_management: {
        orders: 'Use order API endpoints',
        actions: ['place', 'modify', 'cancel']
      },
      restaurant_info: {
        info: 'Use restaurant API endpoints',
        actions: ['timings', 'contact', 'address']
      }
    };

    return minimalContexts[intent] || minimalContexts['restaurant_info'];
  }

  // Smart caching for repeated queries
  async getCachedResponse(restaurantId, query) {
    try {
      const queryHash = this.hashQuery(query);
      const cacheDoc = await admin.firestore()
        .collection('query_cache')
        .doc(`${restaurantId}_${queryHash}`)
        .get();

      if (cacheDoc.exists) {
        const data = cacheDoc.data();
        const cacheAge = Date.now() - data.timestamp.toMillis();
        
        // Cache valid for 1 hour
        if (cacheAge < 3600000) {
          console.log(`🎯 Cache hit for query: "${query}"`);
          return data.response;
        }
      }

      return null;

    } catch (error) {
      console.error('Cache retrieval error:', error);
      return null;
    }
  }

  // Cache response for future use
  async cacheResponse(restaurantId, query, response) {
    try {
      const queryHash = this.hashQuery(query);
      
      await admin.firestore()
        .collection('query_cache')
        .doc(`${restaurantId}_${queryHash}`)
        .set({
          restaurantId,
          query,
          response,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

      console.log(`💾 Response cached for query: "${query}"`);

    } catch (error) {
      console.error('Cache storage error:', error);
    }
  }

  // Simple hash function for queries
  hashQuery(query) {
    let hash = 0;
    for (let i = 0; i < query.length; i++) {
      const char = query.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }
}

module.exports = TokenOptimizationService;



