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
  // Bar + ice-cream container/serving units (own dimension — cross-unit conversion
  // for these is handled per-item via conversionFactor, e.g. 1 bottle = 750 ml).
  'case': { dimension: 'case', toBase: 1 },
  'cases': { dimension: 'case', toBase: 1 },
  'keg': { dimension: 'keg', toBase: 1 },
  'kegs': { dimension: 'keg', toBase: 1 },
  'scoop': { dimension: 'scoop', toBase: 1 },
  'scoops': { dimension: 'scoop', toBase: 1 },
  'tub': { dimension: 'tub', toBase: 1 },
  'tubs': { dimension: 'tub', toBase: 1 },
  'peg': { dimension: 'peg', toBase: 1 },
  'pegs': { dimension: 'peg', toBase: 1 },
  'shot': { dimension: 'shot', toBase: 1 },
  'shots': { dimension: 'shot', toBase: 1 },
};

/**
 * Convert quantity between compatible units, reporting whether the conversion was
 * actually possible. Returns { value, converted, reason }.
 *  - converted:true  → value is correct (same unit, or a valid conversion)
 *  - converted:false → units are unknown (typo) or cross-dimension (g↔pcs);
 *                      value falls back to the raw quantity, and the CALLER must
 *                      decide (deduction skips + flags rather than deduct raw).
 */
function convertUnitsSafe(quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit) return { value: quantity, converted: true };
  const from = fromUnit.toLowerCase().trim();
  const to = toUnit.toLowerCase().trim();
  if (from === to) return { value: quantity, converted: true };

  const fromConv = UNIT_CONVERSIONS[from];
  const toConv = UNIT_CONVERSIONS[to];

  if (!fromConv || !toConv) return { value: quantity, converted: false, reason: 'unknown-unit' };
  if (fromConv.dimension !== toConv.dimension) return { value: quantity, converted: false, reason: 'dimension-mismatch' };

  return { value: (quantity * fromConv.toBase) / toConv.toBase, converted: true };
}

// Backward-compatible wrapper (returns the number). Prefer convertUnitsSafe in
// deduction paths so a mismatch can be flagged instead of silently deducting raw.
function convertUnits(quantity, fromUnit, toUnit) {
  return convertUnitsSafe(quantity, fromUnit, toUnit).value;
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
              minStock: 0, // must be minStock (maps to min_stock); minimumStock would land in extra_data and low-stock detection would never fire
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

      const recipeRef = await db.collection('recipes').add(recipeData);
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
   * COSTING (shared by the Menu-Engineering report and the Recipe Cost-Sheet export).
   * Load recipes + inventory once for a restaurant and return lookup maps.
   */
  async loadCostingContext(restaurantId) {
    const [recipesSnap, invSnap] = await Promise.all([
      db.collection('recipes').where('restaurantId', '==', restaurantId).get(),
      db.collection(collections.inventory).where('restaurantId', '==', restaurantId).get(),
    ]);
    const recipesList = recipesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const recipeMap = {};
    recipesList.forEach(r => { recipeMap[r.id] = r; });
    const inventoryItems = invSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const invById = {};
    const invByName = {};
    inventoryItems.forEach(i => { invById[i.id] = i; invByName[(i.name || '').toLowerCase().trim()] = i; });
    return { recipesList, recipeMap, inventoryItems, invById, invByName };
  }

  /**
   * Cost of ONE serving of a recipe = Σ(ingredient converted-qty × inventory costPerUnit) ÷ servings.
   * Mirrors the "cost per serving" the Recipes tab already shows, so all surfaces agree.
   * Returns { totalCost, servings, costPerServing, lines[] } — `lines` powers the CSV/Excel export.
   */
  computeRecipeCost(recipe, ctx) {
    const { recipeMap, invById, invByName } = ctx;
    const flat = this.flattenIngredients(recipeMap, recipe.ingredients || []);
    let total = 0;
    const lines = [];
    for (const ing of flat) {
      let inv = ing.inventoryItemId ? invById[ing.inventoryItemId] : null;
      if (!inv && ing.inventoryItemName) {
        const t = ing.inventoryItemName.toLowerCase().trim();
        inv = invByName[t] || Object.values(invById).find(i => {
          const n = (i.name || '').toLowerCase().trim();
          return n === t || n.includes(t) || t.includes(n);
        });
      }
      const costPerUnit = inv ? (Number(inv.costPerUnit) || 0) : 0;
      const conv = inv ? convertUnitsSafe(Number(ing.quantity) || 0, ing.unit, inv.unit) : { value: Number(ing.quantity) || 0, converted: false };
      const matched = !!(inv && conv.converted);
      const lineCost = matched ? costPerUnit * conv.value : 0;
      if (matched) total += lineCost;
      lines.push({
        name: inv?.name || ing.inventoryItemName || ing.name || '',
        quantity: Number(ing.quantity) || 0,
        unit: ing.unit || '',
        inventoryUnit: inv?.unit || '',
        costPerUnit,
        lineCost,
        matched,
      });
    }
    const servings = Number(recipe.servings) > 0 ? Number(recipe.servings) : 1;
    return { totalCost: total, servings, costPerServing: total / servings, lines };
  }

  /**
   * Unit cost of a menu item: recipe cost-per-serving FIRST, else the item's costPrice, else 0.
   * `item` = { name, menuItemId?, costPrice? }. Returns { unitCost, source, recipe? }.
   */
  menuItemUnitCost(item, ctx) {
    const { recipesList } = ctx;
    let recipe = item.menuItemId ? recipesList.find(r => r.menuItemId === item.menuItemId) : null;
    if (!recipe && item.name) {
      const t = String(item.name).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
      recipe = recipesList.find(r => {
        const n = (r.name || '').toLowerCase().trim();
        return n === t || t.includes(n) || n.includes(t);
      });
    }
    if (recipe) {
      const c = this.computeRecipeCost(recipe, ctx);
      if (c.costPerServing > 0) return { unitCost: c.costPerServing, source: 'recipe', recipe: c };
    }
    const cp = Number(item.costPrice);
    if (Number.isFinite(cp) && cp > 0) return { unitCost: cp, source: 'costPrice' };
    return { unitCost: 0, source: 'none' };
  }

  /**
   * Deducts inventory based on an order.
   * Triggered asynchronously after order placement.
   */
  async deductInventoryForOrder(restaurantId, orderId, orderItems, options = {}) {
    // referenceId is the per-deduction-event idempotency key (the base orderId for
    // the original deduction, or `${orderId}_edit_*` for edit-added items). The
    // base `orderId` is ALSO stamped on every txn so a cancel can reverse the
    // original AND all edit deductions together. Callers that pass a composite as
    // `orderId` should instead pass the base orderId + { referenceId }.
    const referenceId = options.referenceId || orderId;
    const baseOrderId = orderId;
    console.log(`📉 Processing inventory deduction for Order ${baseOrderId} (ref ${referenceId})`);

    try {
      if (!orderItems || orderItems.length === 0) return [];

      // Idempotency: skip only if this exact deduction event already has a
      // NON-reversed DEDUCTION txn. After a cancel stamps reversedAt on the
      // originals, an un-cancel (same referenceId) re-deducts correctly.
      const existingTxSnap = await db.collection('inventoryTransactions')
        .where('referenceId', '==', referenceId)
        .where('type', '==', 'DEDUCTION')
        .where('source', '==', 'ORDER')
        .get();

      const hasActiveDeduction = existingTxSnap.docs.some(d => !d.data().reversedAt);
      if (hasActiveDeduction) {
        console.log(`⚠️ Inventory already deducted for ${referenceId} — skipping (idempotent)`);
        return [];
      }

      // Create batch using the db instance
      const batch = db.batch();
      let hasUpdates = false;

      // ── Shared / single inventory (per-outlet flag) ──────────────────────────────────────────
      // An outlet (e.g. a small stall) can deduct from ANOTHER outlet's SINGLE stock by setting
      // `inventorySourceRestaurantId` on itself (must belong to the SAME owner). Absent or invalid
      // → it uses its OWN stock, exactly as before (zero behaviour change for every other
      // restaurant). `stockRid` = the outlet whose inventory/recipes/menu we use; `restaurantId`
      // stays the outlet where the sale happened and is recorded on each txn as `soldAtRestaurantId`.
      const selfRestDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      const selfRestData = selfRestDoc.exists ? selfRestDoc.data() : {};
      let stockRid = restaurantId;
      let restDataLoaded = selfRestData;
      const srcId = selfRestData.inventorySourceRestaurantId;
      if (srcId && srcId !== restaurantId) {
        const srcDoc = await db.collection(collections.restaurants).doc(srcId).get();
        if (srcDoc.exists && srcDoc.data().ownerId && srcDoc.data().ownerId === selfRestData.ownerId) {
          stockRid = srcId;
          restDataLoaded = srcDoc.data(); // source outlet's menu drives recipe/variant matching
          console.log(`🔗 Shared inventory: order at ${restaurantId} deducts from ${stockRid}`);
        } else {
          console.warn(`⚠️ inventorySourceRestaurantId=${srcId} invalid (missing / different owner) — using own stock`);
        }
      }

      // 1. Load all inventory items for the (stock) restaurant for matching
      const inventorySnapshot = await db.collection('inventory')
        .where('restaurantId', '==', stockRid)
        .get();

      const inventoryItems = [];
      inventorySnapshot.forEach(doc => {
        inventoryItems.push({ id: doc.id, ...doc.data(), ref: doc.ref });
      });

      // 1b. Load ALL recipes once for sub-recipe resolution (no extra queries per sub-recipe)
      const allRecipesSnap = await db.collection('recipes')
        .where('restaurantId', '==', stockRid)
        .get();
      const recipeMap = {};
      const recipesList = [];
      allRecipesSnap.forEach(doc => {
        const data = doc.data();
        recipeMap[doc.id] = data;
        recipesList.push({ id: doc.id, ...data, ref: doc.ref });
      });

      // 1c. Menu items (variant multipliers + modifier inventory links) — from the stock outlet.
      const menuItemsMap = {};
      for (const m of (restDataLoaded.menu?.items || [])) menuItemsMap[m.id] = m;

      const deductions = [];

      // 2. Process each ordered item
      for (const item of orderItems) {
        const qtySold = item.quantity;
        // Variant scaling: a Half/Small portion consumes a fraction of the recipe.
        // Defaults to 1 (full recipe) so items without a configured multiplier are
        // unchanged. Applied to every recipe ingredient below.
        const menuDef = menuItemsMap[item.menuItemId];
        // Variant scaling from the menu definition (authoritative); falls back to a
        // value on the order item, else 1 (full recipe — unchanged behaviour).
        const variantDef = item.selectedVariant?.name ? (menuDef?.variants || []).find(v => v.name === item.selectedVariant.name) : null;
        const variantMult = (() => {
          const m = (variantDef && typeof variantDef.recipeMultiplier === 'number') ? variantDef.recipeMultiplier
                  : (item.selectedVariant && typeof item.selectedVariant.recipeMultiplier === 'number') ? item.selectedVariant.recipeMultiplier
                  : 1;
          return (typeof m === 'number' && m > 0) ? m : 1;
        })();

        // Modifier/add-on deduction: a modifier option (menuDef.modifierGroups[].items[])
        // can carry an inventory link {inventoryItemId, invQuantity, invUnit}. Deduct
        // those independently of the main recipe so stock-consuming add-ons (extra
        // shot, extra cheese) are tracked. Inert until options are linked in the UI.
        for (const cust of (item.selectedCustomizations || [])) {
          if (!cust) continue;
          let link = null;
          if (cust.inventoryItemId) link = { inventoryItemId: cust.inventoryItemId, quantity: cust.quantity, unit: cust.unit };
          else if (menuDef) {
            for (const g of (menuDef.modifierGroups || [])) {
              const opt = (g.items || []).find(o => (cust.id && o.id === cust.id) || (o.name && o.name === cust.name));
              if (opt && opt.inventoryItemId) { link = { inventoryItemId: opt.inventoryItemId, quantity: opt.invQuantity, unit: opt.invUnit }; break; }
            }
          }
          if (!link || !link.inventoryItemId) continue;
          const modQty = (typeof link.quantity === 'number' ? link.quantity : 0) * qtySold;
          if (modQty <= 0) continue;
          const modInv = inventoryItems.find(i => i.id === link.inventoryItemId);
          if (!modInv) continue;
          const mconv = convertUnitsSafe(modQty, link.unit || modInv.unit, modInv.unit);
          if (!mconv.converted) { console.warn(`⚠️ Modifier unit mismatch for ${modInv.name} (${link.unit} → ${modInv.unit}) — skipped`); continue; }
          const modDeduct = mconv.value;
          batch.update(modInv.ref, { currentStock: FieldValue.increment(-modDeduct), updatedAt: new Date() });
          const mCost = modInv.costPerUnit || 0;
          batch.set(db.collection('inventoryTransactions').doc(), {
            restaurantId: stockRid, soldAtRestaurantId: restaurantId, inventoryItemId: modInv.id, inventoryItemName: modInv.name,
            type: 'DEDUCTION', source: 'ORDER', referenceId, orderId: baseOrderId,
            quantityChange: -modDeduct, unit: modInv.unit, costPerUnit: mCost, totalCost: modDeduct * mCost,
            date: new Date(), notes: `Modifier "${cust.name}" on ${qtySold}x ${item.name}`
          });
          hasUpdates = true;
          modInv.currentStock = Math.max(0, (modInv.currentStock || 0) - modDeduct);
          deductions.push({ inventoryItemId: modInv.id, inventoryItemName: modInv.name, unit: modInv.unit, quantityDeducted: modDeduct, newStock: modInv.currentStock, menuItemName: `${item.name} (${cust.name})`, method: 'modifier' });
        }

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
                  restaurantId: stockRid, soldAtRestaurantId: restaurantId, inventoryItemId: directInvItem.id, inventoryItemName: directInvItem.name,
                  type: 'DEDUCTION', source: 'ORDER', referenceId, orderId: baseOrderId,
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
            const qtyNeeded = ingredient.quantity * qtySold * variantMult;
            
            // Try to find matching inventory item
            // First check if linked by ID
            let inventoryItem = null;
            if (ingredient.inventoryItemId) {
                inventoryItem = inventoryItems.find(i => i.id === ingredient.inventoryItemId);
            }

            // Fallback: Fuzzy name match (soft link — explicit inventoryItemId is
            // preferred; name matching can hit the wrong item e.g. "Tea"→"Green Tea").
            if (!inventoryItem && ingredient.inventoryItemName) {
                const targetName = ingredient.inventoryItemName.toLowerCase();
                inventoryItem = inventoryItems.find(i =>
                    i.name.toLowerCase() === targetName ||
                    i.name.toLowerCase().includes(targetName) ||
                    targetName.includes(i.name.toLowerCase())
                );
                if (inventoryItem) {
                    console.warn(`⚠️ Ingredient "${ingredient.inventoryItemName}" matched by NAME (no inventoryItemId) → "${inventoryItem.name}". Link it explicitly to avoid mis-deduction.`);
                }
            }

            if (inventoryItem) {
                // Convert recipe ingredient unit → inventory item unit. If the units
                // are not convertible (typo or cross-dimension e.g. "g" vs "pcs"),
                // DO NOT deduct a raw number into a different unit — flag it and skip.
                const conv = convertUnitsSafe(qtyNeeded, ingredient.unit, inventoryItem.unit);
                if (!conv.converted) {
                  console.warn(`⚠️ UNIT MISMATCH: recipe "${ingredient.unit}" → stock "${inventoryItem.unit}" for ${inventoryItem.name} — skipped (${conv.reason})`);
                  batch.set(db.collection('inventoryTransactions').doc(), {
                    restaurantId, inventoryItemId: inventoryItem.id, inventoryItemName: inventoryItem.name,
                    type: 'UNIT_MISMATCH', source: 'ORDER', referenceId, orderId: baseOrderId,
                    quantityChange: 0, unit: inventoryItem.unit, recipeUnit: ingredient.unit, reason: conv.reason,
                    date: new Date(), notes: `Skipped: recipe unit "${ingredient.unit}" not convertible to stock unit "${inventoryItem.unit}" for ${item.name}`
                  });
                  hasUpdates = true;
                  continue;
                }
                let deductionAmount = conv.value;
                let expiredWasteQty = 0; // hoisted so the stock write can also subtract auto-wasted expired batches

                // --- FIFO Batch Deduction ---
                const batchIds = [];
                let newStock;

                try {
                  const batchesSnapshot = await db.collection(collections.stockBatches)
                    .where('inventoryItemId', '==', inventoryItem.id)
                    .where('status', '==', 'active')
                    .limit(50)
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
                    expiredWasteQty = 0; // (declared at ingredient scope above)

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

                // Update Inventory (atomic increment for concurrent safety). Also
                // subtract any expired batch quantity auto-wasted above, so the
                // aggregate currentStock stays equal to the sum of batch remainingQty.
                batch.update(inventoryItem.ref, {
                    currentStock: FieldValue.increment(-(deductionAmount + expiredWasteQty)),
                    updatedAt: new Date()
                });

                // Log Transaction (include costPerUnit for COGS tracking)
                const unitCost = inventoryItem.costPerUnit || 0;
                const transactionRef = db.collection('inventoryTransactions').doc();
                const txData = {
                    restaurantId: stockRid,
                    soldAtRestaurantId: restaurantId,
                    inventoryItemId: inventoryItem.id,
                    inventoryItemName: inventoryItem.name,
                    type: 'DEDUCTION',
                    source: 'ORDER',
                    referenceId,
                    orderId: baseOrderId,
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

      // Bar bottle tracking: if enabled, record pours against open bottles
      try {
        const restDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
        const restData = restDoc.exists ? restDoc.data() : {};
        const barSettings = restData.barInventorySettings;
        if (barSettings?.enabled && barSettings.trackedCategoryIds?.length > 0) {
          const barInventoryService = require('./barInventoryService');
          const barDeductions = await barInventoryService.deductBarInventoryForOrder(
            restaurantId, orderId, orderItems, barSettings.trackedCategoryIds
          );
          if (barDeductions.length > 0) {
            console.log(`🍷 Bar bottle pours recorded for Order ${orderId}: ${barDeductions.length} items`);
          }
        }
      } catch (barErr) {
        console.warn('Bar inventory deduction failed (non-blocking):', barErr.message);
      }

      if (deductions.length > 0) {
        try { require('../utils/kvCache').invalidateInventoryCache(restaurantId); } catch (_) {}
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
      // Find all DEDUCTION txns for this order — by the base `orderId` field
      // (catches the original AND every edit deduction) and by `referenceId`
      // (backward-compat for txns written before orderId existed). Merge + dedupe,
      // and keep only ACTIVE (non-reversed) order deductions so a double-cancel
      // can't double-restore.
      const [byOrderId, byRef] = await Promise.all([
        db.collection('inventoryTransactions').where('orderId', '==', orderId).get(),
        db.collection('inventoryTransactions').where('referenceId', '==', orderId).get(),
      ]);
      const seen = new Set();
      const txDocs = [];
      for (const snap of [byOrderId, byRef]) {
        snap.forEach(d => {
          if (seen.has(d.id)) return;
          seen.add(d.id);
          const data = d.data();
          if (data.type === 'DEDUCTION' && data.source === 'ORDER' && !data.reversedAt) {
            txDocs.push(d);
          }
        });
      }

      if (txDocs.length === 0) {
        console.log(`ℹ️ No active inventory deductions for Order ${orderId} — nothing to restore`);
        return [];
      }

      const batch = db.batch();
      const restorations = [];

      for (const txDoc of txDocs) {
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
          try {
            const batchRefs = tx.batchIds.map(batchId => db.collection(collections.stockBatches).doc(batchId));
            const batchDocs = await db.getAll(...batchRefs);
            batchDocs.forEach(batchDoc => {
              if (batchDoc.exists) {
                const batchData = batchDoc.data();
                batch.update(batchDoc.ref, {
                  remainingQty: (batchData.remainingQty || 0) + restoreQty / tx.batchIds.length,
                  status: 'active',
                  updatedAt: new Date()
                });
              }
            });
          } catch (batchErr) {
            console.warn(`⚠️ Could not restore batches for tx ${txDoc.id}:`, batchErr.message);
          }
        }

        // Mark the original DEDUCTION reversed so an un-cancel re-deducts and a
        // double-cancel doesn't double-restore.
        batch.update(txDoc.ref, { reversedAt: new Date() });

        // Create reversal transaction record (audit trail)
        const reversalRef = db.collection('inventoryTransactions').doc();
        batch.set(reversalRef, {
          restaurantId,
          inventoryItemId: tx.inventoryItemId,
          inventoryItemName: tx.inventoryItemName || '',
          type: 'ADDITION',
          source: 'ORDER_CANCELLED',
          referenceId: orderId,
          orderId,
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
        try { require('../utils/kvCache').invalidateInventoryCache(restaurantId); } catch (_) {}
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
        try { require('../utils/kvCache').invalidateInventoryCache(restaurantId); } catch (_) {}
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


