const { db, collections } = require('../firebase');
const OpenAI = require('openai');

class AIReorderService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  /**
   * Predict demand for an inventory item
   * @param {string} inventoryItemId - Item ID
   * @param {string} restaurantId - Restaurant ID
   * @param {number} daysAhead - Days to predict ahead (default: 7)
   * @returns {Promise<Object>} Demand prediction with confidence
   */
  async predictDemand(inventoryItemId, restaurantId, daysAhead = 7) {
    try {
      // Get inventory item
      const itemDoc = await db.collection(collections.inventory).doc(inventoryItemId).get();
      if (!itemDoc.exists) {
        throw new Error('Inventory item not found');
      }

      const itemData = itemDoc.data();
      
      // Get historical order data (last 30 days)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const ordersSnapshot = await db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('status', 'in', ['completed', 'billed'])
        .where('createdAt', '>=', thirtyDaysAgo)
        .get();

      // Calculate consumption from orders
      let totalConsumed = 0;
      const dailyConsumption = {};
      
      ordersSnapshot.forEach(doc => {
        const order = doc.data();
        const orderDate = order.createdAt.toDate().toISOString().split('T')[0];
        
        // Check if item is used in any menu item in this order
        order.items?.forEach(orderItem => {
          // This is simplified - in real implementation, you'd check recipe ingredients
          // For now, we'll use a simple consumption estimate
          if (orderItem.name && itemData.name && 
              orderItem.name.toLowerCase().includes(itemData.name.toLowerCase())) {
            totalConsumed += 1; // Simplified
            dailyConsumption[orderDate] = (dailyConsumption[orderDate] || 0) + 1;
          }
        });
      });

      // Calculate average daily consumption
      const daysWithData = Object.keys(dailyConsumption).length || 1;
      const avgDailyConsumption = totalConsumed / Math.max(daysWithData, 1);

      // Simple prediction: average consumption * days ahead
      // In production, use time series forecasting (Prophet, LSTM, etc.)
      const predictedDemand = avgDailyConsumption * daysAhead;
      
      // Adjust for current stock and min stock
      const currentStock = itemData.currentStock || 0;
      const minStock = itemData.minStock || 0;
      const stockNeeded = Math.max(0, predictedDemand - currentStock + minStock);

      return {
        inventoryItemId,
        currentStock,
        minStock,
        predictedDemand: Math.ceil(predictedDemand),
        stockNeeded: Math.ceil(stockNeeded),
        averageDailyConsumption: parseFloat(avgDailyConsumption.toFixed(2)),
        confidence: daysWithData >= 7 ? 0.8 : daysWithData >= 3 ? 0.6 : 0.4,
        daysAhead,
        historicalDataPoints: daysWithData
      };

    } catch (error) {
      console.error('Demand prediction error:', error);
      throw error;
    }
  }

  /**
   * Get smart reorder suggestions for all low stock items
   * @param {string} restaurantId - Restaurant ID
   * @returns {Promise<Array>} Array of reorder suggestions
   */
  async getReorderSuggestions(restaurantId) {
    try {
      // Get all inventory items
      const inventorySnapshot = await db.collection(collections.inventory)
        .where('restaurantId', '==', restaurantId)
        .get();

      const suggestions = [];

      for (const doc of inventorySnapshot.docs) {
        const item = { id: doc.id, ...doc.data() };
        
        // Check if item needs reorder
        if (item.currentStock <= item.minStock) {
          // Predict demand
          const demandPrediction = await this.predictDemand(item.id, restaurantId, 7);
          
          // Get supplier info
          const supplierId = item.supplierId || item.supplier;
          let supplierData = null;
          if (supplierId) {
            const supplierDoc = await db.collection(collections.suppliers).doc(supplierId).get();
            if (supplierDoc.exists) {
              supplierData = { id: supplierDoc.id, ...supplierDoc.data() };
            }
          }

          // Calculate suggested reorder quantity
          // Suggested = (predicted demand + safety stock) - current stock
          const safetyStock = item.minStock || 10;
          const suggestedQuantity = Math.max(
            item.minStock * 2, // At least 2x min stock
            demandPrediction.stockNeeded + safetyStock
          );

          suggestions.push({
            inventoryItemId: item.id,
            inventoryItemName: item.name,
            currentStock: item.currentStock,
            minStock: item.minStock,
            suggestedQuantity: Math.ceil(suggestedQuantity),
            unit: item.unit || 'unit',
            supplierId: supplierId,
            supplierName: supplierData?.name || 'No supplier',
            costPerUnit: item.costPerUnit || 0,
            estimatedCost: (item.costPerUnit || 0) * suggestedQuantity,
            predictedDemand: demandPrediction.predictedDemand,
            confidence: demandPrediction.confidence,
            urgency: item.currentStock <= item.minStock * 0.5 ? 'high' : 
                    item.currentStock <= item.minStock ? 'medium' : 'low',
            reasoning: `Current stock (${item.currentStock}) is below minimum (${item.minStock}). ` +
                       `Predicted demand: ${demandPrediction.predictedDemand} units in next 7 days. ` +
                       `Suggested reorder: ${suggestedQuantity} units.`
          });
        }
      }

      // Sort by urgency and confidence
      suggestions.sort((a, b) => {
        const urgencyOrder = { high: 3, medium: 2, low: 1 };
        if (urgencyOrder[a.urgency] !== urgencyOrder[b.urgency]) {
          return urgencyOrder[b.urgency] - urgencyOrder[a.urgency];
        }
        return b.confidence - a.confidence;
      });

      return suggestions;

    } catch (error) {
      console.error('Get reorder suggestions error:', error);
      throw error;
    }
  }

  /**
   * Get reorder suggestions for specific items
   * @param {string} restaurantId - Restaurant ID
   * @param {Array<string>} itemIds - Array of inventory item IDs
   * @returns {Promise<Array>} Array of reorder suggestions
   */
  async getReorderSuggestionsForItems(restaurantId, itemIds) {
    try {
      const suggestions = [];

      for (const itemId of itemIds) {
        const itemDoc = await db.collection(collections.inventory).doc(itemId).get();
        if (!itemDoc.exists) continue;

        const item = { id: itemDoc.id, ...itemDoc.data() };
        const demandPrediction = await this.predictDemand(item.id, restaurantId, 7);
        
        const safetyStock = item.minStock || 10;
        const suggestedQuantity = Math.max(
          item.minStock * 2,
          demandPrediction.stockNeeded + safetyStock
        );

        const supplierId = item.supplierId || item.supplier;
        let supplierData = null;
        if (supplierId) {
          const supplierDoc = await db.collection(collections.suppliers).doc(supplierId).get();
          if (supplierDoc.exists) {
            supplierData = { id: supplierDoc.id, ...supplierDoc.data() };
          }
        }

        suggestions.push({
          inventoryItemId: item.id,
          inventoryItemName: item.name,
          currentStock: item.currentStock,
          minStock: item.minStock,
          suggestedQuantity: Math.ceil(suggestedQuantity),
          unit: item.unit || 'unit',
          supplierId: supplierId,
          supplierName: supplierData?.name || 'No supplier',
          costPerUnit: item.costPerUnit || 0,
          estimatedCost: (item.costPerUnit || 0) * suggestedQuantity,
          predictedDemand: demandPrediction.predictedDemand,
          confidence: demandPrediction.confidence,
          urgency: item.currentStock <= item.minStock * 0.5 ? 'high' : 
                  item.currentStock <= item.minStock ? 'medium' : 'low'
        });
      }

      return suggestions;

    } catch (error) {
      console.error('Get reorder suggestions for items error:', error);
      throw error;
    }
  }
}

module.exports = new AIReorderService();

