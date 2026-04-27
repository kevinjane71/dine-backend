const { db, collections } = require('../firebase');
const aiRecipeService = require('./aiRecipeService');

// Comprehensive unit conversion map — all conversions to a "base" unit per dimension
const UNIT_CONVERSIONS = {
  // Mass (base: g)
  'g': { dimension: 'mass', toBase: 1 },
  'gm': { dimension: 'mass', toBase: 1 },
  'gms': { dimension: 'mass', toBase: 1 },
  'gram': { dimension: 'mass', toBase: 1 },
  'grams': { dimension: 'mass', toBase: 1 },
  'kg': { dimension: 'mass', toBase: 1000 },
  'kgs': { dimension: 'mass', toBase: 1000 },
  'kilogram': { dimension: 'mass', toBase: 1000 },
  'kilograms': { dimension: 'mass', toBase: 1000 },
  'mg': { dimension: 'mass', toBase: 0.001 },
  'oz': { dimension: 'mass', toBase: 28.3495 },
  'ounce': { dimension: 'mass', toBase: 28.3495 },
  'ounces': { dimension: 'mass', toBase: 28.3495 },
  'lb': { dimension: 'mass', toBase: 453.592 },
  'lbs': { dimension: 'mass', toBase: 453.592 },
  'pound': { dimension: 'mass', toBase: 453.592 },
  'pounds': { dimension: 'mass', toBase: 453.592 },

  // Volume (base: ml)
  'ml': { dimension: 'volume', toBase: 1 },
  'milliliter': { dimension: 'volume', toBase: 1 },
  'milliliters': { dimension: 'volume', toBase: 1 },
  'l': { dimension: 'volume', toBase: 1000 },
  'ltr': { dimension: 'volume', toBase: 1000 },
  'litre': { dimension: 'volume', toBase: 1000 },
  'liter': { dimension: 'volume', toBase: 1000 },
  'litres': { dimension: 'volume', toBase: 1000 },
  'liters': { dimension: 'volume', toBase: 1000 },
  'cl': { dimension: 'volume', toBase: 10 },
  'cup': { dimension: 'volume', toBase: 236.588 },
  'cups': { dimension: 'volume', toBase: 236.588 },
  'tbsp': { dimension: 'volume', toBase: 14.787 },
  'tablespoon': { dimension: 'volume', toBase: 14.787 },
  'tablespoons': { dimension: 'volume', toBase: 14.787 },
  'tsp': { dimension: 'volume', toBase: 4.929 },
  'teaspoon': { dimension: 'volume', toBase: 4.929 },
  'teaspoons': { dimension: 'volume', toBase: 4.929 },
  'fl oz': { dimension: 'volume', toBase: 29.574 },
  'fluid ounce': { dimension: 'volume', toBase: 29.574 },
  'gallon': { dimension: 'volume', toBase: 3785.41 },
  'gallons': { dimension: 'volume', toBase: 3785.41 },
  'pint': { dimension: 'volume', toBase: 473.176 },
  'pints': { dimension: 'volume', toBase: 473.176 },
  'quart': { dimension: 'volume', toBase: 946.353 },
  'quarts': { dimension: 'volume', toBase: 946.353 },

  // Count (base: pcs)
  'pcs': { dimension: 'count', toBase: 1 },
  'pc': { dimension: 'count', toBase: 1 },
  'piece': { dimension: 'count', toBase: 1 },
  'pieces': { dimension: 'count', toBase: 1 },
  'dozen': { dimension: 'count', toBase: 12 },
  'dzn': { dimension: 'count', toBase: 12 },
  'nos': { dimension: 'count', toBase: 1 },
  'no': { dimension: 'count', toBase: 1 },
  'each': { dimension: 'count', toBase: 1 },
  'unit': { dimension: 'count', toBase: 1 },
  'units': { dimension: 'count', toBase: 1 },

  // Container units — same-type only (no cross-conversion)
  'pack': { dimension: 'pack', toBase: 1 },
  'packs': { dimension: 'pack', toBase: 1 },
  'packet': { dimension: 'pack', toBase: 1 },
  'packets': { dimension: 'pack', toBase: 1 },
  'bottle': { dimension: 'bottle', toBase: 1 },
  'bottles': { dimension: 'bottle', toBase: 1 },
  'can': { dimension: 'can', toBase: 1 },
  'cans': { dimension: 'can', toBase: 1 },
  'bag': { dimension: 'bag', toBase: 1 },
  'bags': { dimension: 'bag', toBase: 1 },
  'box': { dimension: 'box', toBase: 1 },
  'boxes': { dimension: 'box', toBase: 1 },
  'bunch': { dimension: 'bunch', toBase: 1 },
  'bunches': { dimension: 'bunch', toBase: 1 },
};

/**
 * Convert quantity between compatible units.
 * Returns original quantity if units are unknown or incompatible.
 */
function convertUnits(quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit) return quantity;
  const from = fromUnit.toLowerCase().trim();
  const to = toUnit.toLowerCase().trim();
  if (from === to) return quantity;

  const fromConv = UNIT_CONVERSIONS[from];
  const toConv = UNIT_CONVERSIONS[to];

  if (!fromConv || !toConv) return quantity;
  if (fromConv.dimension !== toConv.dimension) return quantity;

  return (quantity * fromConv.toBase) / toConv.toBase;
}

class InventoryService {
  
  /**
   * Creates a default recipe for a menu item if one doesn't exist.
   * Triggered asynchronously after menu item creation.
   */
  async createDefaultRecipe(restaurantId, menuItemId, itemName, description, userId = 'system') {
    try {
      // Check if recipe already exists for this item
      const existingRecipe = await db.collection('recipes')
        .where('restaurantId', '==', restaurantId)
        .where('menuItemId', '==', menuItemId)
        .limit(1)
        .get();

      if (!existingRecipe.empty) {
        console.log(`ℹ️ Recipe already exists for ${itemName}`);
        return;
      }

      // Generate ingredients via AI
      const ingredients = await aiRecipeService.generateRecipe(itemName, description);

      if (ingredients.length === 0) {
        console.log(`⚠️ No ingredients generated for ${itemName}`);
        return;
      }

      // Save to Firestore
      const recipeData = {
        restaurantId,
        menuItemId,
        menuItemName: itemName,
        name: `${itemName} (Auto-Generated)`,
        description: 'AI Generated Default Recipe',
        ingredients: ingredients.map(ing => ({
            inventoryItemName: ing.name,
            quantity: ing.quantity,
            unit: ing.unit,
            // We don't have inventoryItemId yet, will be matched during deduction or manually mapped later
            inventoryItemId: null 
        })),
        isAutoGenerated: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: userId
      };

      await db.collection('recipes').add(recipeData);
      console.log(`✅ Created default AI recipe for ${itemName} with ${ingredients.length} ingredients`);

    } catch (error) {
      console.error(`❌ Failed to create default recipe for ${itemName}:`, error);
    }
  }

  /**
   * Deducts inventory based on an order.
   * Triggered asynchronously after order placement.
   */
  async deductInventoryForOrder(restaurantId, orderId, orderItems) {
    console.log(`📉 Processing inventory deduction for Order ${orderId}`);
    
    try {
      if (!orderItems || orderItems.length === 0) return [];

      // Create batch using the db instance
      const batch = db.batch();
      let hasUpdates = false;

      // 1. Load all inventory items for the restaurant for matching
      const inventorySnapshot = await db.collection('inventory')
        .where('restaurantId', '==', restaurantId)
        .get();
      
      const inventoryItems = [];
      inventorySnapshot.forEach(doc => {
        inventoryItems.push({ id: doc.id, ...doc.data(), ref: doc.ref });
      });

      const deductions = [];

      // 2. Process each ordered item
      for (const item of orderItems) {
        const qtySold = item.quantity;
        
        // Find recipe for this menu item — first by menuItemId, then fallback to name match
        let recipeQuery = await db.collection('recipes')
            .where('restaurantId', '==', restaurantId)
            .where('menuItemId', '==', item.menuItemId)
            .limit(1)
            .get();

        // Fallback: match by recipe name if no menuItemId link exists
        if (recipeQuery.empty && item.name) {
            const allRecipes = await db.collection('recipes')
                .where('restaurantId', '==', restaurantId)
                .get();
            const itemNameLower = item.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
            const matched = allRecipes.docs.find(doc => {
                const rName = (doc.data().name || '').toLowerCase().trim();
                return rName === itemNameLower || itemNameLower.includes(rName) || rName.includes(itemNameLower);
            });
            if (matched) {
                recipeQuery = { empty: false, docs: [matched] };
                // Auto-link for future lookups
                matched.ref.update({ menuItemId: item.menuItemId }).catch(() => {});
            }
        }

        if (recipeQuery.empty) {
            console.log(`⚠️ No recipe found for item: ${item.name} (${item.menuItemId}). Skipping deduction.`);
            continue;
        }

        const recipe = recipeQuery.docs[0].data();
        
        // 3. Process ingredients in recipe
        for (const ingredient of recipe.ingredients) {
            const qtyNeeded = ingredient.quantity * qtySold;
            
            // Try to find matching inventory item
            // First check if linked by ID
            let inventoryItem = null;
            if (ingredient.inventoryItemId) {
                inventoryItem = inventoryItems.find(i => i.id === ingredient.inventoryItemId);
            }

            // Fallback: Fuzzy name match
            if (!inventoryItem) {
                const targetName = ingredient.inventoryItemName.toLowerCase();
                inventoryItem = inventoryItems.find(i => 
                    i.name.toLowerCase() === targetName || 
                    i.name.toLowerCase().includes(targetName) ||
                    targetName.includes(i.name.toLowerCase())
                );
            }

            if (inventoryItem) {
                // Convert recipe ingredient unit → inventory item unit
                let deductionAmount = convertUnits(qtyNeeded, ingredient.unit, inventoryItem.unit);

                // --- FIFO Batch Deduction ---
                const batchIds = [];
                let newStock;

                try {
                  const batchesSnapshot = await db.collection(collections.stockBatches)
                    .where('inventoryItemId', '==', inventoryItem.id)
                    .where('status', '==', 'active')
                    .get();

                  const activeBatches = [];
                  batchesSnapshot.forEach(doc => {
                    const d = doc.data();
                    if ((d.remainingQty || 0) > 0) {
                      activeBatches.push({ id: doc.id, ...d, ref: doc.ref });
                    }
                  });

                  if (activeBatches.length > 0) {
                    // Sort oldest first (FIFO): mfgDate ASC, fallback to createdAt
                    activeBatches.sort((a, b) => {
                      const dateA = a.mfgDate?.toDate?.() || a.mfgDate || a.createdAt?.toDate?.() || a.createdAt || 0;
                      const dateB = b.mfgDate?.toDate?.() || b.mfgDate || b.createdAt?.toDate?.() || b.createdAt || 0;
                      return new Date(dateA) - new Date(dateB);
                    });

                    const now = new Date();
                    let expiredWasteQty = 0;

                    // First pass: skip expired batches and auto-mark them as waste
                    const validBatches = [];
                    for (const stockBatch of activeBatches) {
                      const expiryDate = stockBatch.expiryDate?.toDate?.() || (stockBatch.expiryDate ? new Date(stockBatch.expiryDate) : null);
                      if (expiryDate && expiryDate < now) {
                        // Expired — mark as waste, deplete batch
                        const wastedQty = stockBatch.remainingQty;
                        batch.update(stockBatch.ref, {
                          remainingQty: 0,
                          status: 'depleted',
                          updatedAt: now
                        });
                        // Create waste entry for expired batch
                        const costPU = inventoryItem.costPerUnit || stockBatch.costPerUnit || 0;
                        const wasteRef = db.collection('wasteEntries').doc();
                        batch.set(wasteRef, {
                          restaurantId,
                          itemId: inventoryItem.id,
                          itemName: inventoryItem.name,
                          quantity: wastedQty,
                          unit: inventoryItem.unit || '',
                          reason: 'expired',
                          source: 'AUTO_EXPIRY',
                          costPerUnit: costPU,
                          wasteValue: wastedQty * costPU,
                          totalCost: wastedQty * costPU,
                          batchId: stockBatch.id,
                          notes: `Auto-detected expired batch during order ${orderId}`,
                          date: now,
                          createdAt: now
                        });
                        expiredWasteQty += wastedQty;
                        console.log(`🗑️ Auto-wasted expired batch ${stockBatch.id} for ${inventoryItem.name}: ${wastedQty} ${inventoryItem.unit || ''}`);
                      } else {
                        validBatches.push(stockBatch);
                      }
                    }

                    // Deduct expired waste from current stock
                    if (expiredWasteQty > 0) {
                      inventoryItem.currentStock = (inventoryItem.currentStock || 0) - expiredWasteQty;
                    }

                    // Second pass: FIFO deduction from valid (non-expired) batches
                    let remaining = deductionAmount;
                    for (const stockBatch of validBatches) {
                      if (remaining <= 0) break;
                      const deductFromBatch = Math.min(stockBatch.remainingQty, remaining);
                      const updatedRemaining = stockBatch.remainingQty - deductFromBatch;
                      batch.update(stockBatch.ref, {
                        remainingQty: updatedRemaining,
                        status: updatedRemaining <= 0 ? 'depleted' : 'active',
                        updatedAt: now
                      });
                      batchIds.push(stockBatch.id);
                      remaining -= deductFromBatch;
                    }

                    // If all valid batches exhausted but still need more, log warning
                    if (remaining > 0 && validBatches.length > 0) {
                      console.warn(`⚠️ Not enough non-expired stock in batches for ${inventoryItem.name}. Short by ${remaining} ${inventoryItem.unit || ''}`);
                    }

                    newStock = Math.max(0, inventoryItem.currentStock - deductionAmount);
                  } else {
                    // No batches — backward-compatible simple deduction
                    newStock = Math.max(0, (inventoryItem.currentStock || 0) - deductionAmount);
                  }
                } catch (batchErr) {
                  console.warn(`⚠️ FIFO batch query failed for ${inventoryItem.name}, using simple deduction:`, batchErr.message);
                  newStock = Math.max(0, (inventoryItem.currentStock || 0) - deductionAmount);
                }

                // Update Inventory
                batch.update(inventoryItem.ref, {
                    currentStock: newStock,
                    updatedAt: new Date()
                });

                // Log Transaction (include costPerUnit for COGS tracking)
                const unitCost = inventoryItem.costPerUnit || 0;
                const transactionRef = db.collection('inventoryTransactions').doc();
                const txData = {
                    restaurantId,
                    inventoryItemId: inventoryItem.id,
                    inventoryItemName: inventoryItem.name,
                    type: 'DEDUCTION',
                    source: 'ORDER',
                    referenceId: orderId,
                    quantityChange: -deductionAmount,
                    unit: inventoryItem.unit,
                    costPerUnit: unitCost,
                    totalCost: deductionAmount * unitCost,
                    date: new Date(),
                    notes: `Order of ${qtySold}x ${item.name}`
                };
                if (batchIds.length > 0) txData.batchIds = batchIds;
                batch.set(transactionRef, txData);

                hasUpdates = true;
                deductions.push({
                  inventoryItemId: inventoryItem.id,
                  inventoryItemName: inventoryItem.name,
                  unit: inventoryItem.unit,
                  quantityDeducted: deductionAmount,
                  newStock,
                  menuItemName: item.name,
                  ...(batchIds.length > 0 && { batchIds }),
                });
                inventoryItem.currentStock = newStock;
            } else {
                console.log(`⚠️ Could not find inventory item for ingredient: ${ingredient.inventoryItemName}`);
            }
        }
      }

      if (hasUpdates) {
        await batch.commit();
        console.log(`✅ Inventory updated for Order ${orderId}`);
      }

      return deductions;

    } catch (error) {
      console.error(`❌ Error in inventory deduction for Order ${orderId}:`, error);
      return [];
    }
  }

  /**
   * Handles "Bulk Production" (e.g., Making 10kg Gravy).
   * Deducts raw ingredients, Adds to "Prepped" inventory.
   */
  async logProductionRun(restaurantId, recipeId, batchQuantity, userId) {
      // Implementation for future use
  }
}

module.exports = new InventoryService();


