#!/usr/bin/env node
// General-purpose bulk menu seeding script
// Consistent with POST /api/menus/bulk-save/:restaurantId (index.js:10098)
//
// Usage:
//   node scripts/bulk-menu-seed.js --restaurant=RESTAURANT_ID --file=menu.json
//   node scripts/bulk-menu-seed.js --restaurant=RESTAURANT_ID --file=menu.json --inventory --recipes
//   node scripts/bulk-menu-seed.js --restaurant=RESTAURANT_ID --file=menu.json --dry-run
//
// JSON format:
// {
//   "items": [
//     {
//       "name": "Cardamom Tea",
//       "category": "Tea Counter",
//       "price": 35,
//       "description": "Fragrant cardamom tea",
//       "isVeg": true,
//       "variants": [{ "name": "Small", "price": 25 }, { "name": "Large", "price": 45 }],
//       "pricingRules": { "ac-dining": 45, "takeaway": 30 },
//       "recipe": {
//         "servings": 1, "prepTime": 2, "cookTime": 5,
//         "ingredients": [{ "name": "Black Tea Leaves", "quantity": 3, "unit": "g" }],
//         "instructions": ["Boil water", "Add tea"]
//       }
//     }
//   ]
// }

const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ===== Parse CLI args =====
const args = {};
process.argv.slice(2).forEach(arg => {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    args[key] = val || true;
  }
});

const RESTAURANT_ID = args.restaurant;
const INPUT_FILE = args.file;
const DRY_RUN = !!args['dry-run'];
const SEED_INVENTORY = !!args.inventory;
const SEED_RECIPES = !!args.recipes;

if (!RESTAURANT_ID || !INPUT_FILE) {
  console.log(`
Usage: node scripts/bulk-menu-seed.js --restaurant=RESTAURANT_ID --file=menu.json [options]

Options:
  --restaurant=ID   Restaurant ID (required)
  --file=path       Path to JSON file (required)
  --inventory       Also create inventory items from recipe ingredients
  --recipes         Also create recipe documents linked to menu items
  --dry-run         Preview without saving
  `);
  process.exit(1);
}

// Resolve file path
const filePath = path.isAbsolute(INPUT_FILE) ? INPUT_FILE : path.join(process.cwd(), INPUT_FILE);
if (!fs.existsSync(filePath)) {
  console.error(`❌ File not found: ${filePath}`);
  process.exit(1);
}

// ===== Initialize Firebase =====
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
});

const db = getFirestore(undefined, 'dine');

// Canonical categoryNameToId — same as index.js:1700
const categoryNameToId = (name) => {
  if (!name || typeof name !== 'string') return 'other';
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
};

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Bulk Menu Seed${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`Restaurant: ${RESTAURANT_ID}`);
  console.log(`File: ${filePath}`);
  console.log(`Options: ${[SEED_INVENTORY && 'inventory', SEED_RECIPES && 'recipes'].filter(Boolean).join(', ') || 'menu only'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Read input JSON
  let inputData;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    inputData = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Failed to parse JSON: ${err.message}`);
    process.exit(1);
  }

  const inputItems = inputData.items || inputData.menuItems || inputData;
  if (!Array.isArray(inputItems) || inputItems.length === 0) {
    console.error('❌ No items found. Expected { "items": [...] } or an array of items.');
    process.exit(1);
  }

  console.log(`📋 Input: ${inputItems.length} item(s)\n`);

  // ===== Load existing restaurant data =====
  const restaurantRef = db.collection('restaurants').doc(RESTAURANT_ID);
  const restaurantDoc = await restaurantRef.get();

  if (!restaurantDoc.exists) {
    console.error(`❌ Restaurant not found: ${RESTAURANT_ID}`);
    process.exit(1);
  }

  const restaurantData = restaurantDoc.data();
  const existingMenu = restaurantData.menu || { items: [] };
  const existingItems = [...(existingMenu.items || [])];
  const existingCategories = [...(restaurantData.categories || [])];

  // Load pricing rules for validation
  const pricingSettings = restaurantData.pricingSettings || {};
  const multiPricing = pricingSettings.multiPricing || { enabled: false, rules: [] };
  const pricingRules = (multiPricing.rules || []).filter(r => r.isActive);

  // Build pricing rule lookup: name → id, id → id
  const ruleMap = {};
  for (const rule of pricingRules) {
    ruleMap[rule.id] = rule.id;
    ruleMap[rule.name.toLowerCase()] = rule.id;
    // Also map slugified name
    ruleMap[categoryNameToId(rule.name)] = rule.id;
  }

  if (pricingRules.length > 0) {
    console.log(`💰 Multi-tier pricing rules: ${pricingRules.map(r => `${r.name} (${r.id})`).join(', ')}\n`);
  }

  // ===== Process categories =====
  console.log('--- Categories ---');
  const catNames = [...new Set(inputItems.map(i => i.category).filter(Boolean))];
  const catIdMap = {};

  // Index existing categories by ID and name
  for (const c of existingCategories) {
    catIdMap[c.name.toLowerCase()] = c.id;
    catIdMap[c.id] = c.id;
  }

  for (const catName of catNames) {
    const catId = categoryNameToId(catName);
    const existsById = existingCategories.some(c => (c.id || '').toLowerCase() === catId);
    const existsByName = existingCategories.some(c => c.name.toLowerCase() === catName.toLowerCase());

    if (!existsById && !existsByName) {
      existingCategories.push({
        id: catId, name: catName, emoji: '🍽️', description: '',
        createdAt: new Date(), updatedAt: new Date(),
      });
      catIdMap[catName.toLowerCase()] = catId;
      console.log(`  + ${catName} (${catId})`);
    } else {
      const existing = existingCategories.find(c =>
        c.id === catId || c.name.toLowerCase() === catName.toLowerCase()
      );
      catIdMap[catName.toLowerCase()] = existing.id;
      console.log(`  ~ ${catName} → ${existing.id} (exists)`);
    }
  }

  // Ensure 'other' category exists
  if (!existingCategories.some(c => c.id === 'other')) {
    existingCategories.push({
      id: 'other', name: 'Other', emoji: '🍽️', description: '',
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  // ===== Process menu items =====
  console.log('\n--- Menu Items ---');

  // Find max numeric shortCode
  let maxShortCode = 0;
  for (const item of existingItems) {
    const sc = parseInt(item.shortCode, 10);
    if (!isNaN(sc) && sc > maxShortCode) maxShortCode = sc;
  }

  const stats = { added: 0, skipped: 0, fixed: 0, pricingWarnings: 0 };
  const newMenuItems = []; // Track newly added items for recipe linking

  for (const item of inputItems) {
    if (!item.name) {
      console.log(`  ⚠ Skipping item without name`);
      stats.skipped++;
      continue;
    }

    // Check for duplicate by name
    const existingItem = existingItems.find(i => i.name.toLowerCase() === item.name.toLowerCase());
    if (existingItem) {
      // Fix category if needed
      const catId = catIdMap[(item.category || '').toLowerCase()] || categoryNameToId(item.category || 'other');
      const currentCat = existingItem.category || '';
      if (!currentCat || !existingCategories.some(c => c.id === currentCat)) {
        existingItem.category = catId;
        stats.fixed++;
      }
      // Fix ID prefix
      if (existingItem.id && existingItem.id.startsWith('menu_')) {
        existingItem.id = existingItem.id.replace('menu_', 'item_');
        stats.fixed++;
      }
      // Ensure missing fields
      if (!existingItem.pricingRules) existingItem.pricingRules = {};
      if (!existingItem.customizations) existingItem.customizations = [];

      // Update pricingRules if provided
      if (item.pricingRules && Object.keys(item.pricingRules).length > 0) {
        const resolvedRules = {};
        for (const [key, price] of Object.entries(item.pricingRules)) {
          const ruleId = ruleMap[key] || ruleMap[key.toLowerCase()] || ruleMap[categoryNameToId(key)];
          if (ruleId) {
            resolvedRules[ruleId] = parseFloat(price);
          } else {
            console.log(`    ⚠ Unknown pricing rule: "${key}" — skipped`);
            stats.pricingWarnings++;
          }
        }
        if (Object.keys(resolvedRules).length > 0) {
          existingItem.pricingRules = { ...(existingItem.pricingRules || {}), ...resolvedRules };
          console.log(`  ~ ${item.name} (exists, updated pricing: ${Object.entries(resolvedRules).map(([k, v]) => `${k}=₹${v}`).join(', ')})`);
        } else {
          console.log(`  ~ ${item.name} (exists)`);
        }
      } else {
        console.log(`  ~ ${item.name} (exists)`);
      }
      stats.skipped++;
      continue;
    }

    // Resolve category
    const catId = catIdMap[(item.category || '').toLowerCase()] || categoryNameToId(item.category || 'other');

    // Handle variants (same as bulk-save:10178-10196)
    const variants = (item.variants || [])
      .filter(v => v && v.name && v.price != null)
      .map(v => ({ name: String(v.name).trim(), price: parseFloat(v.price) || 0, description: (v.description || '').trim() }));

    const basePrice = variants.length > 0
      ? Math.min(...variants.map(v => v.price))
      : (parseFloat(item.price) || 0);

    // Resolve pricingRules (map names/slugs → actual rule IDs)
    const resolvedPricingRules = {};
    if (item.pricingRules && typeof item.pricingRules === 'object') {
      for (const [key, price] of Object.entries(item.pricingRules)) {
        const ruleId = ruleMap[key] || ruleMap[key.toLowerCase()] || ruleMap[categoryNameToId(key)];
        if (ruleId) {
          resolvedPricingRules[ruleId] = parseFloat(price);
        } else {
          console.log(`    ⚠ Unknown pricing rule: "${key}" — skipped`);
          stats.pricingWarnings++;
        }
      }
    }

    maxShortCode++;
    const menuItemId = `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const menuItem = {
      id: menuItemId,
      restaurantId: RESTAURANT_ID,
      name: item.name,
      description: item.description || '',
      price: basePrice,
      category: catId,
      isVeg: item.isVeg != null ? Boolean(item.isVeg) : true,
      spiceLevel: item.spiceLevel || 'medium',
      allergens: Array.isArray(item.allergens) ? item.allergens : [],
      shortCode: String(maxShortCode),
      status: 'active',
      order: existingItems.length,
      isAvailable: true,
      stockQuantity: null,
      lowStockThreshold: 5,
      isStockManaged: false,
      availableFrom: null,
      availableUntil: null,
      variants,
      customizations: (item.customizations || []).map(c => ({
        id: c.id || `cust_${Date.now()}`,
        name: c.name, price: parseFloat(c.price) || 0, description: c.description || '',
      })),
      pricingRules: resolvedPricingRules,
      // Type-specific fields
      spiritCategory: item.spiritCategory || null,
      ingredients: item.ingredients || null,
      abv: item.abv ? parseFloat(item.abv) : null,
      servingUnit: item.servingUnit || null,
      bottleSize: item.bottleSize || null,
      unit: item.unit || null,
      weight: item.weight || null,
      servingSize: item.servingSize || null,
      scoopOptions: item.scoopOptions ? parseInt(item.scoopOptions) : null,
      source: 'seed_script',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    existingItems.push(menuItem);
    newMenuItems.push({ ...menuItem, _recipe: item.recipe }); // Keep recipe data for linking

    const extras = [];
    if (variants.length > 0) extras.push(`${variants.length} variants`);
    if (Object.keys(resolvedPricingRules).length > 0) extras.push(`${Object.keys(resolvedPricingRules).length} tiers`);
    console.log(`  + ${item.name} (₹${basePrice}, ${catId}, #${maxShortCode}${extras.length ? ' [' + extras.join(', ') + ']' : ''})`);
    stats.added++;

    await new Promise(r => setTimeout(r, 5));
  }

  // ===== Process inventory (if --inventory) =====
  const inventoryMap = {}; // ingredient name → inventory doc ID

  if (SEED_INVENTORY || SEED_RECIPES) {
    // Load existing inventory for linking
    const invSnapshot = await db.collection('inventory')
      .where('restaurantId', '==', RESTAURANT_ID).get();
    invSnapshot.forEach(doc => {
      inventoryMap[doc.data().name.toLowerCase()] = doc.id;
    });
  }

  if (SEED_INVENTORY) {
    console.log('\n--- Inventory Items ---');
    // Collect all unique ingredients from recipes
    const allIngredients = new Map();
    for (const item of inputItems) {
      if (!item.recipe?.ingredients) continue;
      for (const ing of item.recipe.ingredients) {
        if (ing.name && !allIngredients.has(ing.name.toLowerCase())) {
          allIngredients.set(ing.name.toLowerCase(), ing);
        }
      }
    }

    let invAdded = 0;
    for (const [key, ing] of allIngredients) {
      if (inventoryMap[key]) {
        console.log(`  ~ ${ing.name} (${inventoryMap[key]})`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  + [DRY] ${ing.name} (${ing.unit})`);
        invAdded++;
        continue;
      }

      const docRef = await db.collection('inventory').add({
        restaurantId: RESTAURANT_ID,
        name: ing.name,
        category: ing.category || 'other',
        unit: ing.unit || 'g',
        currentStock: ing.currentStock || 0,
        minStock: ing.minStock || 0,
        maxStock: ing.maxStock || 0,
        costPerUnit: ing.costPerUnit || 0,
        status: 'normal',
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'seed-script',
      });
      inventoryMap[key] = docRef.id;
      console.log(`  + ${ing.name} → ${docRef.id}`);
      invAdded++;
    }
    console.log(`  ✓ ${invAdded} inventory items processed`);
  }

  // ===== Process recipes (if --recipes) =====
  if (SEED_RECIPES) {
    console.log('\n--- Recipes ---');
    let recAdded = 0;

    for (const menuItem of newMenuItems) {
      const recipe = menuItem._recipe;
      if (!recipe) continue;

      // Check if recipe exists
      const existing = await db.collection('recipes')
        .where('restaurantId', '==', RESTAURANT_ID)
        .where('name', '==', menuItem.name)
        .limit(1).get();

      if (!existing.empty) {
        // Update menuItemId link if missing
        const existingRecipe = existing.docs[0];
        if (!existingRecipe.data().menuItemId && !DRY_RUN) {
          await existingRecipe.ref.update({ menuItemId: menuItem.id });
          console.log(`  🔗 ${menuItem.name} → linked to ${menuItem.id}`);
        } else {
          console.log(`  ~ ${menuItem.name} (exists)`);
        }
        continue;
      }

      // Map ingredients to inventory IDs
      const ingredients = (recipe.ingredients || []).map(ing => ({
        inventoryItemId: inventoryMap[ing.name.toLowerCase()] || null,
        inventoryItemName: ing.name,
        quantity: ing.quantity || 0,
        unit: ing.unit || 'g',
      }));

      if (DRY_RUN) {
        console.log(`  + [DRY] ${menuItem.name} (${ingredients.length} ingredients)`);
        recAdded++;
        continue;
      }

      await db.collection('recipes').add({
        restaurantId: RESTAURANT_ID,
        name: menuItem.name,
        menuItemId: menuItem.id,
        menuItemName: menuItem.name,
        description: recipe.description || menuItem.description || '',
        category: menuItem.category || '',
        servings: recipe.servings || 1,
        prepTime: recipe.prepTime || 0,
        cookTime: recipe.cookTime || 0,
        ingredients,
        instructions: recipe.instructions || [],
        isActive: true,
        isAutoGenerated: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'seed-script',
      });
      console.log(`  + ${menuItem.name} (${ingredients.length} ingredients)`);
      recAdded++;
    }
    console.log(`  ✓ ${recAdded} recipes processed`);
  }

  // ===== Save to Firestore =====
  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN — nothing saved');
  } else {
    console.log('\n--- Saving ---');
    const updateData = {
      categories: existingCategories,
      menu: { ...existingMenu, items: existingItems, lastUpdated: new Date() },
      updatedAt: new Date(),
    };
    if (restaurantData.hasDefaultMenu) {
      updateData.hasDefaultMenu = false;
      console.log('  🔄 Clearing default menu flag');
    }
    await restaurantRef.set(updateData, { merge: true });
    console.log('  ✓ Restaurant document updated');
  }

  // ===== Summary =====
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Summary${DRY_RUN ? ' (DRY RUN)' : ''}:`);
  console.log(`  Menu items: ${stats.added} added, ${stats.skipped} skipped, ${stats.fixed} fixed`);
  console.log(`  Categories: ${existingCategories.length} total`);
  if (stats.pricingWarnings > 0) console.log(`  ⚠ Pricing warnings: ${stats.pricingWarnings}`);
  console.log(`  Restaurant: ${RESTAURANT_ID}`);
  console.log(`${'='.repeat(60)}\n`);

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
