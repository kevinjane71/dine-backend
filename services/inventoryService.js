const { db, collections } = require('../firebase');
const { FieldValue } = require('firebase-admin/firestore');
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

      // Load existing inventory items for matching
      const inventorySnap = await db.collection(collections.inventory)
        .where('restaurantId', '==', restaurantId).get();
      const inventoryItems = [];
      inventorySnap.forEach(doc => inventoryItems.push({ id: doc.id, ...doc.data() }));

      // Map ingredients to inventory — fuzzy match existing, auto-create missing
      const mappedIngredients = [];
      for (const ing of ingredients) {
        const ingName = (ing.name || '').toLowerCase().trim();
        const match = inventoryItems.find(inv => {
          const invName = (inv.name || '').toLowerCase().trim();
          return invName === ingName || invName.includes(ingName) || ingName.includes(invName);
        });

        if (match) {
          mappedIngredients.push({
            inventoryItemId: match.id,
            inventoryItemName: match.name,
            quantity: ing.quantity,
            unit: ing.unit || match.unit || 'g',
          });
        } else {
          // Auto-create inventory item with zero stock
          try {
            const newItemData = {
              restaurantId,
              name: ing.name,
              category: 'Raw Material',
              unit: ing.unit || 'g',
              currentStock: 0,
              minimumStock: 0,
              costPerUnit: 0,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
              createdBy: userId
            };
            const newRef = await db.collection(collections.inventory).add(newItemData);
            inventoryItems.push({ id: newRef.id, ...newItemData }); // track for subsequent matches
            mappedIngredients.push({
              inventoryItemId: newRef.id,
              inventoryItemName: ing.name,
              quantity: ing.quantity,
              unit: ing.unit || 'g',
            });
            console.log(`  📦 Auto-created inventory item: ${ing.name}`);
          } catch (createErr) {
            console.warn(`  ⚠️ Could not auto-create inventory item: ${ing.name}`, createErr.message);
            mappedIngredients.push({
              inventoryItemId: null,
              inventoryItemName: ing.name,
              quantity: ing.quantity,
              unit: ing.unit || 'g',
            });
          }
        }
      }

      // Save to Firestore
      const recipeData = {
        restaurantId,
        menuItemId,
        menuItemName: itemName,
        name: itemName,
        description: 'AI Generated Default Recipe',
        ingredients: mappedIngredients,
        isAutoGenerated: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: userId
      };

      await db.collection('recipes').add(recipeData);
      console.log(`✅ Created default AI recipe for ${itemName} with ${mappedIngredients.length} ingredients (${mappedIngredients.filter(i => i.inventoryItemId).length} linked)`);

    } catch (error) {
      console.error(`❌ Failed to create default recipe for ${itemName}:`, error);
    }
  }

  /**
   * Flatten recipe ingredients, resolving sub-recipes recursively using a pre-loaded map.
   * Returns flat array of raw inventory ingredients with adjusted quantities.
   */
  flattenIngredients(recipeMap, ingredients, multiplier = 1, visited = new Set()) {
    const flat = [];
    for (const ing of ingredients) {
      if (ing.type === 'recipe' && ing.subRecipeId) {
        if (visited.has(ing.subRecipeId)) continue; // circular protection
        visited.add(ing.subRecipeId);
        const subRecipe = recipeMap[ing.subRecipeId];
        if (subRecipe) {
          const subServings = subRecipe.servings || 1;
          const subMultiplier = multiplier * (ing.quantity || 1) / subServings;
          const subFlat = this.flattenIngredients(recipeMap, subRecipe.ingredients || [], subMultiplier, new Set(visited));
          flat.push(...subFlat);
        }
      } else {
        flat.push({ ...ing, quantity: (ing.quantity || 0) * multiplier });
      }
    }
    return flat;
  }

  /**
   * Deducts inventory based on an order.
   * Triggered asynchronously after order placement.
   */
  async deductInventoryForOrder(restaurantId, orderId, orderItems) {
    console.log(`📉 Processing inventory deduction for Order ${orderId}`);

    try {
      if (!orderItems || orderItems.length === 0) return [];

      // Idempotency: check if this order already has deduction transactions
      const existingTxSnap = await db.collection('inventoryTransactions')
        .where('referenceId', '==', orderId)
        .where('type', '==', 'DEDUCTION')
        .where('source', '==', 'ORDER')
        .limit(1)
        .get();

      if (!existingTxSnap.empty) {
        console.log(`⚠️ Inventory already deducted for Order ${orderId} — skipping (idempotent)`);
        return [];
      }

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

      // 1b. Load ALL recipes once for sub-recipe resolution (no extra queries per sub-recipe)
      const allRecipesSnap = await db.collection('recipes')
        .where('restaurantId', '==', restaurantId)
        .get();
      const recipeMap = {};
      const recipesList = [];
      allRecipesSnap.forEach(doc => {
        const data = doc.data();
        recipeMap[doc.id] = data;
        recipesList.push({ id: doc.id, ...data, ref: doc.ref });
      });

      const deductions = [];

      // 2. Process each ordered item
      for (const item of orderItems) {
        const qtySold = item.quantity;

        // Find recipe for this menu item — first by menuItemId, then fallback to name match
        let recipe = null;
        let recipeDoc = recipesList.find(r => r.menuItemId === item.menuItemId);

        // Fallback: match by recipe name if no menuItemId link exists
        if (!recipeDoc && item.name) {
            const itemNameLower = item.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
            recipeDoc = recipesList.find(r => {
                const rName = (r.name || '').toLowerCase().trim();
                return rName === itemNameLower || itemNameLower.includes(rName) || rName.includes(itemNameLower);
            });
            if (recipeDoc) {
                // Auto-link for future lookups
                recipeDoc.ref.update({ menuItemId: item.menuItemId }).catch(() => {});
            }
        }

        if (!recipeDoc) {
            // Direct deduction: if item is stock-managed, deduct 1:1 from linked inventory item
            if (item.isStockManaged || item.trackInventory) {
              const directInvItem = inventoryItems.find(i =>
                (item.inventoryItemId && i.id === item.inventoryItemId) ||
                (i.linkedMenuItemId === item.menuItemId) ||
                (i.linkedMenuItemId === item.id) ||
                (item.name && i.name && i.name.toLowerCase() === item.name.toLowerCase())
              );
              if (directInvItem) {
                const deductQty = (item.deductionQuantity || 1) * qtySold;
                // Use atomic increment to prevent race conditions on concurrent orders
                batch.update(directInvItem.ref, {
                  currentStock: FieldValue.increment(-deductQty),
                  updatedAt: new Date()
                });
                const unitCost = directInvItem.costPerUnit || 0;
                const transactionRef = db.collection('inventoryTransactions').doc();
                batch.set(transactionRef, {
                  restaurantId, inventoryItemId: directInvItem.id, inventoryItemName: directInvItem.name,
                  type: 'DEDUCTION', source: 'ORDER', referenceId: orderId,
                  quantityChange: -deductQty, unit: directInvItem.unit || 'pcs',
                  costPerUnit: unitCost, totalCost: deductQty * unitCost,
                  date: new Date(), notes: `Direct deduction: ${qtySold}x ${item.name}`
                });
                hasUpdates = true;
                const estimatedStock = Math.max(0, (directInvItem.currentStock || 0) - deductQty);
                deductions.push({
                  inventoryItemId: directInvItem.id, inventoryItemName: directInvItem.name,
                  unit: directInvItem.unit, quantityDeducted: deductQty, newStock: estimatedStock,
                  menuItemName: item.name, method: 'direct'
                });
                directInvItem.currentStock = estimatedStock;
                // Warn if stock likely insufficient
                if (estimatedStock <= 0) {
                  console.warn(`⚠️ Low/zero stock after deduction: ${directInvItem.name} (estimated: ${estimatedStock})`);
                }
                console.log(`📦 Direct deduction: ${deductQty} ${directInvItem.unit || 'pcs'} of ${directInvItem.name} for ${item.name}`);
                continue;
              }
            }
            console.log(`⚠️ No recipe found for item: ${item.name} (${item.menuItemId}). Skipping deduction.`);
            continue;
        }

        recipe = recipeDoc;

        // 3. Flatten ingredients (resolves sub-recipes recursively using in-memory map)
        const flatIngredients = this.flattenIngredients(recipeMap, recipe.ingredients || []);

        for (const ingredient of flatIngredients) {
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

                // Update Inventory (atomic increment for concurrent safety)
                batch.update(inventoryItem.ref, {
                    currentStock: FieldValue.increment(-deductionAmount),
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
                const estimatedNewStock = Math.max(0, (inventoryItem.currentStock || 0) - deductionAmount);
                deductions.push({
                  inventoryItemId: inventoryItem.id,
                  inventoryItemName: inventoryItem.name,
                  unit: inventoryItem.unit,
                  quantityDeducted: deductionAmount,
                  newStock: estimatedNewStock,
                  menuItemName: item.name,
                  ...(batchIds.length > 0 && { batchIds }),
                });
                if (estimatedNewStock <= 0) {
                  console.warn(`⚠️ Low/zero stock after deduction: ${inventoryItem.name} (estimated: ${estimatedNewStock})`);
                }
                inventoryItem.currentStock = estimatedNewStock;
            } else {
                console.log(`⚠️ Could not find inventory item for ingredient: ${ingredient.inventoryItemName}`);
            }
        }
      }

      if (hasUpdates) {
        await batch.commit();
        console.log(`✅ Inventory updated for Order ${orderId}`);

        // Post-commit: floor negative stock values to 0 (can happen with concurrent FieldValue.increment)
        for (const d of deductions) {
          if (d.newStock <= 0) {
            try {
              const invRef = db.collection('inventory').doc(d.inventoryItemId);
              const invDoc = await invRef.get();
              if (invDoc.exists && (invDoc.data().currentStock || 0) < 0) {
                await invRef.update({ currentStock: 0 });
                console.log(`📦 Floored negative stock to 0 for ${d.inventoryItemName}`);
              }
            } catch (floorErr) {
              // Non-critical — stock sync will fix later
            }
          }
        }
      }

      return deductions;

    } catch (error) {
      console.error(`❌ Error in inventory deduction for Order ${orderId}:`, error);
      return [];
    }
  }

  /**
   * Restores inventory that was deducted for an order (used on cancel/delete).
   *
   * Instead of re-computing from recipes, this queries the actual inventoryTransactions
   * created during deduction and reverses them exactly. This is more reliable because
   * recipes or menu items may have changed since the order was placed.
   */
  async restoreInventoryForOrder(restaurantId, orderId) {
    console.log(`📈 Restoring inventory for cancelled/deleted Order ${orderId}`);

    try {
      // Find all deduction transactions for this order
      const txSnapshot = await db.collection('inventoryTransactions')
        .where('referenceId', '==', orderId)
        .where('type', '==', 'DEDUCTION')
        .where('source', '==', 'ORDER')
        .get();

      if (txSnapshot.empty) {
        console.log(`ℹ️ No inventory deductions found for Order ${orderId} — nothing to restore`);
        return [];
      }

      const batch = db.batch();
      const restorations = [];

      for (const txDoc of txSnapshot.docs) {
        const tx = txDoc.data();
        const restoreQty = Math.abs(tx.quantityChange || 0);
        if (restoreQty <= 0) continue;

        // Restore inventory item stock (atomic increment for concurrent safety)
        const invRef = db.collection('inventory').doc(tx.inventoryItemId);
        batch.update(invRef, {
          currentStock: FieldValue.increment(restoreQty),
          updatedAt: new Date()
        });

        // Restore batch quantities if FIFO batches were used
        if (tx.batchIds && tx.batchIds.length > 0) {
          for (const batchId of tx.batchIds) {
            try {
              const batchRef = db.collection(collections.stockBatches).doc(batchId);
              const batchDoc = await batchRef.get();
              if (batchDoc.exists) {
                const batchData = batchDoc.data();
                batch.update(batchRef, {
                  remainingQty: (batchData.remainingQty || 0) + restoreQty / tx.batchIds.length,
                  status: 'active',
                  updatedAt: new Date()
                });
              }
            } catch (batchErr) {
              console.warn(`⚠️ Could not restore batch ${batchId}:`, batchErr.message);
            }
          }
        }

        // Create reversal transaction record
        const reversalRef = db.collection('inventoryTransactions').doc();
        batch.set(reversalRef, {
          restaurantId,
          inventoryItemId: tx.inventoryItemId,
          inventoryItemName: tx.inventoryItemName || '',
          type: 'ADDITION',
          source: 'ORDER_CANCELLED',
          referenceId: orderId,
          quantityChange: restoreQty,
          unit: tx.unit || '',
          costPerUnit: tx.costPerUnit || 0,
          totalCost: restoreQty * (tx.costPerUnit || 0),
          date: new Date(),
          notes: `Inventory restored — order ${orderId} cancelled/deleted`,
          originalTransactionId: txDoc.id
        });

        restorations.push({
          inventoryItemId: tx.inventoryItemId,
          inventoryItemName: tx.inventoryItemName,
          quantityRestored: restoreQty,
          unit: tx.unit
        });
      }

      if (restorations.length > 0) {
        await batch.commit();
        console.log(`✅ Inventory restored for Order ${orderId}: ${restorations.length} items`);
      }

      return restorations;

    } catch (error) {
      console.error(`❌ Error restoring inventory for Order ${orderId}:`, error);
      return [];
    }
  }

  /**
   * Restores inventory for items removed during an order edit.
   * Unlike restoreInventoryForOrder (cancel), this uses item data directly
   * since we know exactly which items and quantities were reduced.
   */
  async restoreInventoryForEditedOrder(restaurantId, orderId, removedItems) {
    console.log(`📈 Restoring inventory for edited Order ${orderId}: ${removedItems.length} items`);

    try {
      if (!removedItems || removedItems.length === 0) return [];

      const batch = db.batch();
      const restorations = [];

      // Load inventory items and recipes for matching
      const inventorySnapshot = await db.collection('inventory')
        .where('restaurantId', '==', restaurantId)
        .get();
      const inventoryItems = [];
      inventorySnapshot.forEach(doc => {
        inventoryItems.push({ id: doc.id, ...doc.data(), ref: doc.ref });
      });

      const allRecipesSnap = await db.collection('recipes')
        .where('restaurantId', '==', restaurantId)
        .get();
      const recipesList = [];
      allRecipesSnap.forEach(doc => {
        recipesList.push({ id: doc.id, ...doc.data(), ref: doc.ref });
      });

      for (const item of removedItems) {
        const qtySold = item.quantity;

        // Find recipe
        let recipeDoc = recipesList.find(r => r.menuItemId === item.menuItemId);
        if (!recipeDoc && item.name) {
          const itemNameLower = item.name.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
          recipeDoc = recipesList.find(r => {
            const rName = (r.name || '').toLowerCase().trim();
            return rName === itemNameLower || itemNameLower.includes(rName) || rName.includes(itemNameLower);
          });
        }

        if (!recipeDoc) {
          // Direct restoration for stock-managed items
          if (item.isStockManaged || item.trackInventory) {
            const directInvItem = inventoryItems.find(i =>
              (item.inventoryItemId && i.id === item.inventoryItemId) ||
              (i.linkedMenuItemId === item.menuItemId) ||
              (item.name && i.name && i.name.toLowerCase() === item.name.toLowerCase())
            );
            if (directInvItem) {
              const restoreQty = (item.deductionQuantity || 1) * qtySold;
              batch.update(directInvItem.ref, {
                currentStock: FieldValue.increment(restoreQty),
                updatedAt: new Date()
              });
              const unitCost = directInvItem.costPerUnit || 0;
              const txRef = db.collection('inventoryTransactions').doc();
              batch.set(txRef, {
                restaurantId, inventoryItemId: directInvItem.id, inventoryItemName: directInvItem.name,
                type: 'ADDITION', source: 'ORDER_EDITED', referenceId: orderId,
                quantityChange: restoreQty, unit: directInvItem.unit || 'pcs',
                costPerUnit: unitCost, totalCost: restoreQty * unitCost,
                date: new Date(), notes: `Edit restore: ${qtySold}x ${item.name} removed`
              });
              restorations.push({
                inventoryItemId: directInvItem.id, inventoryItemName: directInvItem.name,
                quantityRestored: restoreQty, unit: directInvItem.unit
              });
            }
          }
          continue;
        }

        // Recipe-based restoration
        const recipeMap = {};
        allRecipesSnap.forEach(doc => { recipeMap[doc.id] = doc.data(); });
        const flatIngredients = this.flattenIngredients(recipeMap, recipeDoc.ingredients || []);

        for (const ingredient of flatIngredients) {
          const qtyToRestore = ingredient.quantity * qtySold;
          let inventoryItem = null;
          if (ingredient.inventoryItemId) {
            inventoryItem = inventoryItems.find(i => i.id === ingredient.inventoryItemId);
          }
          if (!inventoryItem) {
            const targetName = (ingredient.inventoryItemName || '').toLowerCase();
            inventoryItem = inventoryItems.find(i =>
              i.name.toLowerCase() === targetName ||
              i.name.toLowerCase().includes(targetName) ||
              targetName.includes(i.name.toLowerCase())
            );
          }
          if (inventoryItem) {
            const restoreAmount = convertUnits(qtyToRestore, ingredient.unit, inventoryItem.unit);
            batch.update(inventoryItem.ref, {
              currentStock: FieldValue.increment(restoreAmount),
              updatedAt: new Date()
            });
            const unitCost = inventoryItem.costPerUnit || 0;
            const txRef = db.collection('inventoryTransactions').doc();
            batch.set(txRef, {
              restaurantId, inventoryItemId: inventoryItem.id, inventoryItemName: inventoryItem.name,
              type: 'ADDITION', source: 'ORDER_EDITED', referenceId: orderId,
              quantityChange: restoreAmount, unit: inventoryItem.unit,
              costPerUnit: unitCost, totalCost: restoreAmount * unitCost,
              date: new Date(), notes: `Edit restore: ${qtySold}x ${item.name} removed`
            });
            restorations.push({
              inventoryItemId: inventoryItem.id, inventoryItemName: inventoryItem.name,
              quantityRestored: restoreAmount, unit: inventoryItem.unit
            });
          }
        }
      }

      if (restorations.length > 0) {
        await batch.commit();
        console.log(`✅ Inventory restored for edited Order ${orderId}: ${restorations.length} items`);
      }

      return restorations;
    } catch (error) {
      console.error(`❌ Error restoring inventory for edited Order ${orderId}:`, error);
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


