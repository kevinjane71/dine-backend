const { db, collections } = require('../firebase');

class AIPriceIntelligenceService {
  /**
   * Compare prices across suppliers for an item
   * @param {string} restaurantId - Restaurant ID
   * @param {string} inventoryItemId - Inventory item ID
   * @returns {Promise<Object>} Price comparison results
   */
  async comparePrices(restaurantId, inventoryItemId) {
    try {
      // Get inventory item
      const itemDoc = await db.collection(collections.inventory).doc(inventoryItemId).get();
      if (!itemDoc.exists) {
        throw new Error('Inventory item not found');
      }

      const itemData = itemDoc.data();
      const itemName = itemData.name;

      // Get all suppliers
      const suppliersSnapshot = await db.collection(collections.suppliers)
        .where('restaurantId', '==', restaurantId)
        .where('isActive', '==', true)
        .get();

      // Get purchase orders for this item from all suppliers
      const poSnapshot = await db.collection(collections.purchaseOrders)
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['received', 'partially_received'])
        .get();

      const supplierPrices = {};
      const supplierPerformance = {};

      // Get supplier performance data
      const perfSnapshot = await db.collection(collections.supplierPerformance)
        .where('restaurantId', '==', restaurantId)
        .get();

      const performances = {};
      perfSnapshot.forEach(doc => {
        const perf = doc.data();
        performances[perf.supplierId] = perf;
      });

      // Analyze purchase orders to find prices
      poSnapshot.forEach(doc => {
        const po = doc.data();
        const item = po.items?.find(i => 
          i.inventoryItemId === inventoryItemId || 
          i.inventoryItemName?.toLowerCase().includes(itemName.toLowerCase())
        );

        if (item && po.supplierId) {
          const unitPrice = item.unitPrice || 0;
          
          if (!supplierPrices[po.supplierId]) {
            supplierPrices[po.supplierId] = {
              prices: [],
              supplierId: po.supplierId,
              supplierName: 'Unknown',
              lastOrderDate: null,
              orderCount: 0
            };
          }

          supplierPrices[po.supplierId].prices.push({
            price: unitPrice,
            date: po.createdAt?.toDate?.() || po.createdAt,
            orderId: doc.id
          });

          if (!supplierPrices[po.supplierId].lastOrderDate || 
              (po.createdAt?.toDate?.() || po.createdAt) > supplierPrices[po.supplierId].lastOrderDate) {
            supplierPrices[po.supplierId].lastOrderDate = po.createdAt?.toDate?.() || po.createdAt;
          }

          supplierPrices[po.supplierId].orderCount++;
        }
      });

      // Get supplier names
      suppliersSnapshot.forEach(doc => {
        const supplier = doc.data();
        if (supplierPrices[doc.id]) {
          supplierPrices[doc.id].supplierName = supplier.name;
        }
      });

      // Calculate average prices and scores
      const comparisons = [];
      
      for (const [supplierId, data] of Object.entries(supplierPrices)) {
        if (data.prices.length === 0) continue;

        const prices = data.prices.map(p => p.price);
        const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        const latestPrice = data.prices.sort((a, b) => 
          new Date(b.date) - new Date(a.date)
        )[0].price;

        const perf = performances[supplierId];
        const reliabilityScore = perf ? (perf.onTimeRate * 0.5 + perf.qualityScore * 0.5) / 100 : 0.5;
        const overallScore = (1 / (avgPrice / Math.min(...Object.values(supplierPrices).map(s => {
          const prices = s.prices.map(p => p.price);
          return prices.reduce((sum, p) => sum + p, 0) / prices.length;
        })))) * 0.6 + reliabilityScore * 0.4;

        comparisons.push({
          supplierId,
          supplierName: data.supplierName,
          averagePrice: parseFloat(avgPrice.toFixed(2)),
          latestPrice: parseFloat(latestPrice.toFixed(2)),
          minPrice: parseFloat(minPrice.toFixed(2)),
          maxPrice: parseFloat(maxPrice.toFixed(2)),
          priceVolatility: parseFloat(((maxPrice - minPrice) / avgPrice * 100).toFixed(2)),
          orderCount: data.orderCount,
          lastOrderDate: data.lastOrderDate,
          reliabilityScore: parseFloat((reliabilityScore * 100).toFixed(2)),
          overallScore: parseFloat((overallScore * 100).toFixed(2)),
          performance: perf ? {
            grade: perf.grade,
            onTimeRate: perf.onTimeRate,
            qualityScore: perf.qualityScore
          } : null
        });
      }

      // Sort by overall score (best first)
      comparisons.sort((a, b) => b.overallScore - a.overallScore);

      // Find best price (lowest)
      const bestPrice = comparisons.length > 0 ? 
        Math.min(...comparisons.map(c => c.averagePrice)) : null;

      // Calculate market average
      const marketAverage = comparisons.length > 0 ?
        comparisons.reduce((sum, c) => sum + c.averagePrice, 0) / comparisons.length : null;

      return {
        inventoryItemId,
        inventoryItemName: itemName,
        comparisons,
        bestPrice: bestPrice ? parseFloat(bestPrice.toFixed(2)) : null,
        marketAverage: marketAverage ? parseFloat(marketAverage.toFixed(2)) : null,
        recommendedSupplier: comparisons.length > 0 ? comparisons[0] : null,
        totalSuppliers: comparisons.length
      };

    } catch (error) {
      console.error('Price comparison error:', error);
      throw error;
    }
  }

  /**
   * Analyze price trends for an item
   * @param {string} restaurantId - Restaurant ID
   * @param {string} inventoryItemId - Inventory item ID
   * @param {number} days - Number of days to analyze (default: 90)
   * @returns {Promise<Object>} Price trend analysis
   */
  async analyzePriceTrend(restaurantId, inventoryItemId, days = 90) {
    try {
      const itemDoc = await db.collection(collections.inventory).doc(inventoryItemId).get();
      if (!itemDoc.exists) {
        throw new Error('Inventory item not found');
      }

      const itemData = itemDoc.data();
      const itemName = itemData.name;

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      // Get purchase orders in the time period
      const poSnapshot = await db.collection(collections.purchaseOrders)
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['received', 'partially_received'])
        .where('createdAt', '>=', cutoffDate)
        .get();

      const priceHistory = [];
      const supplierPrices = {};

      poSnapshot.forEach(doc => {
        const po = doc.data();
        const item = po.items?.find(i => 
          i.inventoryItemId === inventoryItemId || 
          i.inventoryItemName?.toLowerCase().includes(itemName.toLowerCase())
        );

        if (item && po.supplierId) {
          const date = po.createdAt?.toDate?.() || po.createdAt;
          priceHistory.push({
            date,
            price: item.unitPrice || 0,
            supplierId: po.supplierId,
            orderId: doc.id
          });

          if (!supplierPrices[po.supplierId]) {
            supplierPrices[po.supplierId] = [];
          }
          supplierPrices[po.supplierId].push({
            date,
            price: item.unitPrice || 0
          });
        }
      });

      // Sort by date
      priceHistory.sort((a, b) => new Date(a.date) - new Date(b.date));

      // Calculate trend
      let trend = 'stable';
      let trendPercentage = 0;

      if (priceHistory.length >= 2) {
        const firstHalf = priceHistory.slice(0, Math.floor(priceHistory.length / 2));
        const secondHalf = priceHistory.slice(Math.floor(priceHistory.length / 2));

        const firstAvg = firstHalf.reduce((sum, p) => sum + p.price, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((sum, p) => sum + p.price, 0) / secondHalf.length;

        trendPercentage = ((secondAvg - firstAvg) / firstAvg) * 100;

        if (trendPercentage > 5) {
          trend = 'increasing';
        } else if (trendPercentage < -5) {
          trend = 'decreasing';
        }
      }

      // Calculate volatility
      const prices = priceHistory.map(p => p.price);
      const avgPrice = prices.reduce((sum, p) => sum + p, 0) / prices.length;
      const variance = prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length;
      const volatility = Math.sqrt(variance) / avgPrice * 100;

      // Supplier-specific trends
      const supplierTrends = {};
      for (const [supplierId, prices] of Object.entries(supplierPrices)) {
        if (prices.length >= 2) {
          const sorted = prices.sort((a, b) => new Date(a.date) - new Date(b.date));
          const firstHalf = sorted.slice(0, Math.floor(sorted.length / 2));
          const secondHalf = sorted.slice(Math.floor(sorted.length / 2));

          const firstAvg = firstHalf.reduce((sum, p) => sum + p.price, 0) / firstHalf.length;
          const secondAvg = secondHalf.reduce((sum, p) => sum + p.price, 0) / secondHalf.length;

          const supplierTrend = ((secondAvg - firstAvg) / firstAvg) * 100;

          supplierTrends[supplierId] = {
            trend: supplierTrend > 5 ? 'increasing' : supplierTrend < -5 ? 'decreasing' : 'stable',
            trendPercentage: parseFloat(supplierTrend.toFixed(2)),
            averagePrice: parseFloat(secondAvg.toFixed(2))
          };
        }
      }

      return {
        inventoryItemId,
        inventoryItemName: itemName,
        trend,
        trendPercentage: parseFloat(trendPercentage.toFixed(2)),
        volatility: parseFloat(volatility.toFixed(2)),
        currentPrice: priceHistory.length > 0 ? priceHistory[priceHistory.length - 1].price : null,
        averagePrice: parseFloat(avgPrice.toFixed(2)),
        minPrice: prices.length > 0 ? Math.min(...prices) : null,
        maxPrice: prices.length > 0 ? Math.max(...prices) : null,
        priceHistory: priceHistory.slice(-30), // Last 30 data points
        supplierTrends,
        dataPoints: priceHistory.length
      };

    } catch (error) {
      console.error('Price trend analysis error:', error);
      throw error;
    }
  }

  /**
   * Detect price anomalies
   * @param {string} restaurantId - Restaurant ID
   * @param {string} inventoryItemId - Inventory item ID
   * @returns {Promise<Object>} Anomaly detection results
   */
  async detectPriceAnomalies(restaurantId, inventoryItemId) {
    try {
      const trend = await this.analyzePriceTrend(restaurantId, inventoryItemId, 90);
      
      const anomalies = [];
      const prices = trend.priceHistory.map(p => p.price);
      const avgPrice = trend.averagePrice;
      const stdDev = Math.sqrt(
        prices.reduce((sum, p) => sum + Math.pow(p - avgPrice, 2), 0) / prices.length
      );

      // Detect outliers (more than 2 standard deviations from mean)
      trend.priceHistory.forEach((point, index) => {
        const zScore = Math.abs((point.price - avgPrice) / stdDev);
        
        if (zScore > 2) {
          anomalies.push({
            date: point.date,
            price: point.price,
            expectedPrice: avgPrice,
            deviation: parseFloat(((point.price - avgPrice) / avgPrice * 100).toFixed(2)),
            zScore: parseFloat(zScore.toFixed(2)),
            severity: zScore > 3 ? 'high' : 'medium',
            supplierId: point.supplierId
          });
        }
      });

      return {
        inventoryItemId,
        inventoryItemName: trend.inventoryItemName,
        anomalies,
        totalAnomalies: anomalies.length,
        averagePrice: trend.averagePrice,
        standardDeviation: parseFloat(stdDev.toFixed(2))
      };

    } catch (error) {
      console.error('Price anomaly detection error:', error);
      throw error;
    }
  }

  /**
   * Get best supplier recommendation for an item
   * @param {string} restaurantId - Restaurant ID
   * @param {string} inventoryItemId - Inventory item ID
   * @returns {Promise<Object>} Best supplier recommendation
   */
  async getBestSupplier(restaurantId, inventoryItemId) {
    try {
      const comparison = await this.comparePrices(restaurantId, inventoryItemId);

      if (comparison.comparisons.length === 0) {
        return {
          inventoryItemId,
          inventoryItemName: comparison.inventoryItemName,
          recommendation: null,
          message: 'No supplier data available for comparison'
        };
      }

      const best = comparison.recommendedSupplier;

      return {
        inventoryItemId,
        inventoryItemName: comparison.inventoryItemName,
        recommendedSupplier: {
          supplierId: best.supplierId,
          supplierName: best.supplierName,
          price: best.averagePrice,
          score: best.overallScore,
          grade: best.performance?.grade || 'N/A',
          reasoning: `Best overall value: Good price (₹${best.averagePrice}) with ${best.reliabilityScore}% reliability score`
        },
        alternatives: comparison.comparisons.slice(1, 4).map(c => ({
          supplierId: c.supplierId,
          supplierName: c.supplierName,
          price: c.averagePrice,
          score: c.overallScore,
          tradeOff: `₹${(c.averagePrice - best.averagePrice).toFixed(2)} ${c.averagePrice > best.averagePrice ? 'more expensive' : 'cheaper'} but ${c.reliabilityScore < best.reliabilityScore ? 'less' : 'more'} reliable`
        })),
        marketAverage: comparison.marketAverage,
        savings: comparison.marketAverage ? 
          parseFloat((comparison.marketAverage - best.averagePrice).toFixed(2)) : null
      };

    } catch (error) {
      console.error('Get best supplier error:', error);
      throw error;
    }
  }
}

module.exports = new AIPriceIntelligenceService();



