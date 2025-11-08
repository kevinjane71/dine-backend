const { db, collections } = require('../firebase');

class AIWastePredictionService {
  /**
   * Predict waste risk for inventory items
   * @param {string} restaurantId - Restaurant ID
   * @returns {Promise<Array>} Array of waste risk predictions
   */
  async predictWasteRisk(restaurantId) {
    try {
      // Get all inventory items with expiry dates
      const inventorySnapshot = await db.collection(collections.inventory)
        .where('restaurantId', '==', restaurantId)
        .get();

      const wastePredictions = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (const doc of inventorySnapshot.docs) {
        const item = { id: doc.id, ...doc.data() };
        
        if (!item.expiryDate) continue;

        const expiryDate = item.expiryDate.toDate ? item.expiryDate.toDate() : new Date(item.expiryDate);
        const daysToExpiry = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
        
        if (daysToExpiry < 0) {
          // Already expired
          wastePredictions.push({
            inventoryItemId: item.id,
            inventoryItemName: item.name,
            currentStock: item.currentStock,
            expiryDate: expiryDate,
            daysToExpiry: daysToExpiry,
            wasteRisk: 'expired',
            wasteRiskScore: 1.0,
            estimatedWaste: item.currentStock,
            estimatedLoss: (item.costPerUnit || 0) * item.currentStock,
            recommendations: [
              'Item has expired - dispose immediately',
              'Check if item can still be used',
              'Contact supplier for return/credit if possible'
            ]
          });
          continue;
        }

        // Calculate consumption rate (simplified)
        const consumptionRate = await this.calculateConsumptionRate(item.id, restaurantId);
        const daysToConsume = consumptionRate > 0 ? item.currentStock / consumptionRate : Infinity;
        
        // Calculate waste risk
        let wasteRisk = 'low';
        let wasteRiskScore = 0;
        let estimatedWaste = 0;

        if (daysToExpiry < daysToConsume) {
          // Will expire before consumed
          const excessStock = item.currentStock - (consumptionRate * daysToExpiry);
          estimatedWaste = Math.max(0, excessStock);
          
          if (daysToExpiry <= 1) {
            wasteRisk = 'critical';
            wasteRiskScore = 0.9;
          } else if (daysToExpiry <= 3) {
            wasteRisk = 'high';
            wasteRiskScore = 0.7;
          } else if (daysToExpiry <= 7) {
            wasteRisk = 'medium';
            wasteRiskScore = 0.5;
          } else {
            wasteRisk = 'low';
            wasteRiskScore = 0.3;
          }
        }

        if (wasteRisk !== 'low' || estimatedWaste > 0) {
          const recommendations = this.generateWasteReductionRecommendations(
            item, daysToExpiry, estimatedWaste, consumptionRate
          );

          wastePredictions.push({
            inventoryItemId: item.id,
            inventoryItemName: item.name,
            category: item.category,
            currentStock: item.currentStock,
            expiryDate: expiryDate,
            daysToExpiry: daysToExpiry,
            consumptionRate: parseFloat(consumptionRate.toFixed(2)),
            daysToConsume: consumptionRate > 0 ? Math.ceil(daysToConsume) : Infinity,
            wasteRisk,
            wasteRiskScore: parseFloat(wasteRiskScore.toFixed(2)),
            estimatedWaste: Math.ceil(estimatedWaste),
            estimatedLoss: (item.costPerUnit || 0) * estimatedWaste,
            recommendations
          });
        }
      }

      // Sort by waste risk score (highest first)
      wastePredictions.sort((a, b) => b.wasteRiskScore - a.wasteRiskScore);

      return wastePredictions;

    } catch (error) {
      console.error('Waste prediction error:', error);
      throw error;
    }
  }

  /**
   * Calculate consumption rate for an item
   * @param {string} itemId - Inventory item ID
   * @param {string} restaurantId - Restaurant ID
   * @returns {Promise<number>} Average daily consumption rate
   */
  async calculateConsumptionRate(itemId, restaurantId) {
    try {
      // Get last 30 days of orders
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const ordersSnapshot = await db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['completed', 'billed'])
        .where('createdAt', '>=', thirtyDaysAgo)
        .get();

      // Simplified consumption calculation
      // In production, this would check recipe ingredients
      let totalConsumed = 0;
      const itemDoc = await db.collection(collections.inventory).doc(itemId).get();
      if (!itemDoc.exists) return 0;

      const itemData = itemDoc.data();
      
      // Count orders that might use this item (simplified)
      ordersSnapshot.forEach(doc => {
        const order = doc.data();
        order.items?.forEach(orderItem => {
          // Simplified matching - in production, use recipe ingredients
          if (orderItem.name && itemData.name && 
              orderItem.name.toLowerCase().includes(itemData.name.toLowerCase())) {
            totalConsumed += 1;
          }
        });
      });

      const days = 30;
      return totalConsumed / days;

    } catch (error) {
      console.error('Calculate consumption rate error:', error);
      return 0;
    }
  }

  /**
   * Generate waste reduction recommendations
   * @param {Object} item - Inventory item
   * @param {number} daysToExpiry - Days until expiry
   * @param {number} estimatedWaste - Estimated waste amount
   * @param {number} consumptionRate - Daily consumption rate
   * @returns {Array<string>} Array of recommendations
   */
  generateWasteReductionRecommendations(item, daysToExpiry, estimatedWaste, consumptionRate) {
    const recommendations = [];

    if (daysToExpiry <= 3) {
      recommendations.push('⚠️ URGENT: Item expiring soon - immediate action required');
    }

    // Recipe suggestions (simplified - in production, check actual recipes)
    if (item.category) {
      recommendations.push(`Create daily special using ${item.name} (${item.category})`);
      recommendations.push(`Add ${item.name} to popular dishes to increase consumption`);
    }

    // Promotion suggestions
    if (estimatedWaste > item.currentStock * 0.3) {
      recommendations.push(`Run promotion for dishes containing ${item.name}`);
    }

    // Transfer suggestions (if multi-location)
    recommendations.push(`Consider transferring to another location if available`);

    // Supplier return
    if (daysToExpiry > 0 && daysToExpiry <= 7) {
      recommendations.push(`Contact supplier for possible return/credit`);
    }

    // Increase consumption
    if (consumptionRate > 0 && daysToExpiry < (item.currentStock / consumptionRate)) {
      const neededIncrease = (item.currentStock / daysToExpiry) - consumptionRate;
      recommendations.push(`Increase consumption by ${neededIncrease.toFixed(1)} units/day to avoid waste`);
    }

    return recommendations;
  }

  /**
   * Get waste summary for dashboard
   * @param {string} restaurantId - Restaurant ID
   * @returns {Promise<Object>} Waste summary statistics
   */
  async getWasteSummary(restaurantId) {
    try {
      const predictions = await this.predictWasteRisk(restaurantId);
      
      const summary = {
        totalItemsAtRisk: predictions.length,
        criticalRisk: predictions.filter(p => p.wasteRisk === 'critical').length,
        highRisk: predictions.filter(p => p.wasteRisk === 'high').length,
        mediumRisk: predictions.filter(p => p.wasteRisk === 'medium').length,
        expiredItems: predictions.filter(p => p.wasteRisk === 'expired').length,
        totalEstimatedWaste: predictions.reduce((sum, p) => sum + p.estimatedWaste, 0),
        totalEstimatedLoss: predictions.reduce((sum, p) => sum + p.estimatedLoss, 0),
        topRiskyItems: predictions.slice(0, 5)
      };

      return summary;

    } catch (error) {
      console.error('Get waste summary error:', error);
      throw error;
    }
  }
}

module.exports = new AIWastePredictionService();

