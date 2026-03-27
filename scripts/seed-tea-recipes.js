// Seed script: Creates inventory items + recipes for a tea/coffee shop
// Run with: node scripts/seed-tea-recipes.js
// Uses the named 'dine' database

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ===== CONFIGURATION =====
const TARGET_RESTAURANT_ID = 'LUETVd1eMwu4Bm7PvP9K';
const SEED_MENU_ITEMS = true; // Also add menu items to the restaurant document
// =========================

initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
});

const firestoreDb = getFirestore(undefined, 'dine');

const RAW_MATERIALS = [
  // Teas
  { name: 'Black Tea Leaves', category: 'beverages', unit: 'g', currentStock: 1000, minStock: 200, costPerUnit: 0.5 },
  { name: 'Green Tea Leaves', category: 'beverages', unit: 'g', currentStock: 500, minStock: 100, costPerUnit: 0.8 },
  { name: 'Hibiscus Petals', category: 'beverages', unit: 'g', currentStock: 300, minStock: 50, costPerUnit: 1.2 },
  { name: 'Butterfly Pea Flowers', category: 'beverages', unit: 'g', currentStock: 200, minStock: 50, costPerUnit: 2.0 },
  { name: 'Chamomile Flowers', category: 'beverages', unit: 'g', currentStock: 200, minStock: 50, costPerUnit: 1.5 },
  // Liquids
  { name: 'Milk', category: 'dairy', unit: 'ml', currentStock: 5000, minStock: 1000, costPerUnit: 0.06 },
  { name: 'Water', category: 'other', unit: 'ml', currentStock: 50000, minStock: 5000, costPerUnit: 0.001 },
  { name: 'Coffee Decoction', category: 'beverages', unit: 'ml', currentStock: 2000, minStock: 500, costPerUnit: 0.15 },
  // Sweeteners
  { name: 'Sugar', category: 'sweeteners', unit: 'g', currentStock: 5000, minStock: 1000, costPerUnit: 0.05 },
  { name: 'Jaggery', category: 'sweeteners', unit: 'g', currentStock: 2000, minStock: 500, costPerUnit: 0.07 },
  { name: 'Honey', category: 'sweeteners', unit: 'ml', currentStock: 500, minStock: 100, costPerUnit: 0.30 },
  // Flavors
  { name: 'Cardamom', category: 'spices', unit: 'g', currentStock: 200, minStock: 50, costPerUnit: 0.80 },
  { name: 'Ginger', category: 'spices', unit: 'g', currentStock: 500, minStock: 100, costPerUnit: 0.10 },
  { name: 'Mint Leaves', category: 'herbs', unit: 'g', currentStock: 300, minStock: 100, costPerUnit: 0.15 },
  { name: 'Lemon', category: 'fruits', unit: 'pcs', currentStock: 50, minStock: 10, costPerUnit: 5.0 },
  // Coffee & Chocolate
  { name: 'Cocoa Powder', category: 'beverages', unit: 'g', currentStock: 500, minStock: 100, costPerUnit: 0.50 },
  { name: 'Vanilla Extract', category: 'spices', unit: 'ml', currentStock: 100, minStock: 20, costPerUnit: 1.00 },
  { name: 'Cinnamon', category: 'spices', unit: 'g', currentStock: 100, minStock: 30, costPerUnit: 0.40 },
];

const RECIPES = [
  {
    name: 'Black Tea',
    category: 'Tea Counter',
    description: 'Classic black tea with sugar or jaggery. Boil water + tea leaves for 3-4 min. Strain. Add sugar/jaggery. Serve hot.',
    servings: 1,
    prepTime: 5,
    cookTime: 5,
    ingredients: [
      { name: 'Black Tea Leaves', quantity: 3, unit: 'g' },
      { name: 'Water', quantity: 200, unit: 'ml' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
    ],
    instructions: [
      'Boil water + tea leaves for 3-4 minutes',
      'Strain into cup',
      'Add sugar or jaggery',
      'Serve hot',
    ],
  },
  {
    name: 'Plain Milk Tea',
    category: 'Tea Counter',
    description: 'Classic Indian milk tea. Bring water to boil, add tea leaves, simmer, add milk, sweeten.',
    servings: 1,
    prepTime: 3,
    cookTime: 7,
    ingredients: [
      { name: 'Black Tea Leaves', quantity: 3, unit: 'g' },
      { name: 'Milk', quantity: 150, unit: 'ml' },
      { name: 'Water', quantity: 50, unit: 'ml' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
    ],
    instructions: [
      'Bring water to a boil',
      'Add tea leaves and simmer for 2 minutes',
      'Pour in milk, bring to a gentle boil',
      'Sweeten with sugar',
      'Strain into a cup and serve hot',
    ],
  },
  {
    name: 'Cardamom Tea',
    category: 'Tea Counter',
    description: 'Fragrant cardamom-infused milk tea.',
    servings: 1,
    prepTime: 3,
    cookTime: 8,
    ingredients: [
      { name: 'Black Tea Leaves', quantity: 3, unit: 'g' },
      { name: 'Milk', quantity: 150, unit: 'ml' },
      { name: 'Water', quantity: 50, unit: 'ml' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
      { name: 'Cardamom', quantity: 1, unit: 'g' },
    ],
    instructions: [
      'Boil water with crushed cardamom pods for 2-3 minutes',
      'Add tea leaves and simmer for 2 minutes',
      'Pour in milk, bring to a gentle boil',
      'Sweeten with sugar/jaggery',
      'Strain into a cup and serve hot',
    ],
  },
  {
    name: 'Ginger Milk Tea',
    category: 'Tea Counter',
    description: 'Warming ginger-infused milk tea.',
    servings: 1,
    prepTime: 3,
    cookTime: 8,
    ingredients: [
      { name: 'Black Tea Leaves', quantity: 3, unit: 'g' },
      { name: 'Milk', quantity: 150, unit: 'ml' },
      { name: 'Water', quantity: 50, unit: 'ml' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
      { name: 'Ginger', quantity: 5, unit: 'g' },
    ],
    instructions: [
      'Boil water with grated/crushed ginger for 3-4 minutes',
      'Add tea leaves and simmer for 2 minutes',
      'Pour in milk, bring to a gentle boil',
      'Sweeten with sugar/jaggery',
      'Strain into a cup and serve hot',
    ],
  },
  {
    name: 'Mint Tea',
    category: 'Tea Counter',
    description: 'Refreshing mint-infused milk tea.',
    servings: 1,
    prepTime: 3,
    cookTime: 8,
    ingredients: [
      { name: 'Black Tea Leaves', quantity: 3, unit: 'g' },
      { name: 'Milk', quantity: 150, unit: 'ml' },
      { name: 'Water', quantity: 50, unit: 'ml' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
      { name: 'Mint Leaves', quantity: 3, unit: 'g' },
    ],
    instructions: [
      'Boil water and add fresh mint leaves',
      'Simmer for 2-3 minutes to release flavor',
      'Add tea leaves and brew for 2 minutes',
      'Pour in milk, bring to a gentle boil',
      'Sweeten with sugar',
      'Strain into a cup and serve hot',
    ],
  },
  {
    name: 'Green Tea',
    category: 'Herbal & Speciality Tea',
    description: 'Light green tea with honey.',
    servings: 1,
    prepTime: 2,
    cookTime: 3,
    ingredients: [
      { name: 'Green Tea Leaves', quantity: 2, unit: 'g' },
      { name: 'Water', quantity: 200, unit: 'ml' },
      { name: 'Honey', quantity: 5, unit: 'ml' },
    ],
    instructions: [
      'Steep tea leaves in hot water for 2-3 minutes',
      'Strain',
      'Add sweetener',
      'Serve warm',
    ],
  },
  {
    name: 'Lemon Tea',
    category: 'Herbal & Speciality Tea',
    description: 'Tangy lemon tea with honey.',
    servings: 1,
    prepTime: 2,
    cookTime: 5,
    ingredients: [
      { name: 'Black Tea Leaves', quantity: 3, unit: 'g' },
      { name: 'Water', quantity: 200, unit: 'ml' },
      { name: 'Lemon', quantity: 0.5, unit: 'pcs' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
    ],
    instructions: [
      'Boil tea leaves in water',
      'Strain',
      'Add lemon juice + sweetener',
      'Serve hot',
    ],
  },
  {
    name: 'Hibiscus Tea',
    category: 'Herbal & Speciality Tea',
    description: 'Floral hibiscus herbal tea.',
    servings: 1,
    prepTime: 2,
    cookTime: 5,
    ingredients: [
      { name: 'Hibiscus Petals', quantity: 5, unit: 'g' },
      { name: 'Water', quantity: 200, unit: 'ml' },
      { name: 'Honey', quantity: 5, unit: 'ml' },
    ],
    instructions: [
      'Steep petals in hot water for 5 minutes',
      'Strain',
      'Add sweetener',
      'Serve warm',
    ],
  },
  {
    name: 'Blue Pea Tea',
    category: 'Herbal & Speciality Tea',
    description: 'Vibrant blue butterfly pea flower tea.',
    servings: 1,
    prepTime: 2,
    cookTime: 5,
    ingredients: [
      { name: 'Butterfly Pea Flowers', quantity: 3, unit: 'g' },
      { name: 'Water', quantity: 200, unit: 'ml' },
      { name: 'Honey', quantity: 5, unit: 'ml' },
    ],
    instructions: [
      'Steep flowers in hot water for 5 minutes',
      'Strain',
      'Add sweetener',
      'Serve warm',
    ],
  },
  {
    name: 'Chamomile Tea',
    category: 'Herbal & Speciality Tea',
    description: 'Calming chamomile herbal tea.',
    servings: 1,
    prepTime: 2,
    cookTime: 5,
    ingredients: [
      { name: 'Chamomile Flowers', quantity: 4, unit: 'g' },
      { name: 'Water', quantity: 200, unit: 'ml' },
      { name: 'Honey', quantity: 5, unit: 'ml' },
    ],
    instructions: [
      'Steep flowers in hot water for 5 minutes',
      'Strain',
      'Add sweetener',
      'Serve warm',
    ],
  },
  {
    name: 'Black Coffee',
    category: 'Coffee Counter',
    description: 'Strong black coffee with sugar or jaggery.',
    servings: 1,
    prepTime: 2,
    cookTime: 3,
    ingredients: [
      { name: 'Coffee Decoction', quantity: 40, unit: 'ml' },
      { name: 'Water', quantity: 200, unit: 'ml' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
    ],
    instructions: [
      'Heat water until just boiling',
      'Add coffee decoction and stir well',
      'Mix in sugar/jaggery',
      'Serve hot in a cup',
    ],
  },
  {
    name: 'Milk Coffee',
    category: 'Coffee Counter',
    description: 'South Indian filter-style milk coffee.',
    servings: 1,
    prepTime: 2,
    cookTime: 5,
    ingredients: [
      { name: 'Coffee Decoction', quantity: 40, unit: 'ml' },
      { name: 'Milk', quantity: 150, unit: 'ml' },
      { name: 'Water', quantity: 50, unit: 'ml' },
      { name: 'Sugar', quantity: 10, unit: 'g' },
    ],
    instructions: [
      'Boil milk and water together',
      'Add coffee decoction and stir until blended',
      'Mix in sugar/jaggery',
      'Froth by pouring back and forth (optional)',
      'Serve hot',
    ],
  },
  {
    name: 'Hot Chocolate',
    category: 'Coffee Counter',
    description: 'Rich hot chocolate with cinnamon.',
    servings: 1,
    prepTime: 2,
    cookTime: 5,
    ingredients: [
      { name: 'Cocoa Powder', quantity: 5, unit: 'g' },
      { name: 'Milk', quantity: 240, unit: 'ml' },
      { name: 'Jaggery', quantity: 15, unit: 'g' },
      { name: 'Vanilla Extract', quantity: 1, unit: 'ml' },
      { name: 'Cinnamon', quantity: 0.5, unit: 'g' },
    ],
    instructions: [
      'Heat milk in a saucepan until warm (not boiling)',
      'Add cocoa powder and whisk until smooth',
      'Stir in jaggery until fully dissolved',
      'Mix in vanilla extract and a pinch of cinnamon',
      'Top with cocoa powder',
    ],
  },
  {
    name: 'Hot Cafe Mocha',
    category: 'Coffee Counter',
    description: 'Filter coffee meets hot chocolate.',
    servings: 1,
    prepTime: 3,
    cookTime: 5,
    ingredients: [
      { name: 'Coffee Decoction', quantity: 30, unit: 'ml' },
      { name: 'Cocoa Powder', quantity: 2.5, unit: 'g' },
      { name: 'Milk', quantity: 240, unit: 'ml' },
      { name: 'Honey', quantity: 15, unit: 'ml' },
      { name: 'Vanilla Extract', quantity: 1, unit: 'ml' },
    ],
    instructions: [
      'Brew a strong filter coffee decoction',
      'Warm milk in a saucepan, whisk in cocoa powder until smooth',
      'Stir in honey until dissolved',
      'Add the filter coffee decoction and mix well',
      'Add vanilla extract if desired',
      'Pour into a mug',
      'Top with cocoa powder',
    ],
  },
];

const MENU_ITEMS = [
  // Tea Counter
  { name: 'Black Tea', category: 'Tea Counter', price: 20, shortCode: 'BT', isVeg: true, description: 'Classic black tea with sugar or jaggery' },
  { name: 'Plain Milk Tea', category: 'Tea Counter', price: 30, shortCode: 'PMT', isVeg: true, description: 'Classic Indian milk tea' },
  { name: 'Cardamom Tea', category: 'Tea Counter', price: 35, shortCode: 'CT', isVeg: true, description: 'Fragrant cardamom-infused milk tea' },
  { name: 'Ginger Milk Tea', category: 'Tea Counter', price: 35, shortCode: 'GMT', isVeg: true, description: 'Warming ginger-infused milk tea' },
  { name: 'Mint Tea', category: 'Tea Counter', price: 35, shortCode: 'MT', isVeg: true, description: 'Refreshing mint-infused milk tea' },
  // Herbal & Speciality Tea
  { name: 'Green Tea', category: 'Herbal & Speciality Tea', price: 40, shortCode: 'GT', isVeg: true, description: 'Light green tea with honey' },
  { name: 'Lemon Tea', category: 'Herbal & Speciality Tea', price: 35, shortCode: 'LT', isVeg: true, description: 'Tangy lemon tea with honey' },
  { name: 'Hibiscus Tea', category: 'Herbal & Speciality Tea', price: 45, shortCode: 'HT', isVeg: true, description: 'Floral hibiscus herbal tea' },
  { name: 'Blue Pea Tea', category: 'Herbal & Speciality Tea', price: 50, shortCode: 'BPT', isVeg: true, description: 'Vibrant butterfly pea flower tea' },
  { name: 'Chamomile Tea', category: 'Herbal & Speciality Tea', price: 50, shortCode: 'CHT', isVeg: true, description: 'Calming chamomile herbal tea' },
  // Coffee Counter
  { name: 'Black Coffee', category: 'Coffee Counter', price: 30, shortCode: 'BC', isVeg: true, description: 'Strong black coffee with sugar or jaggery' },
  { name: 'Milk Coffee', category: 'Coffee Counter', price: 40, shortCode: 'MC', isVeg: true, description: 'South Indian filter-style milk coffee' },
  { name: 'Hot Chocolate', category: 'Coffee Counter', price: 60, shortCode: 'HC', isVeg: true, description: 'Rich hot chocolate with cinnamon' },
  { name: 'Hot Cafe Mocha', category: 'Coffee Counter', price: 70, shortCode: 'HCM', isVeg: true, description: 'Filter coffee meets hot chocolate' },
];

async function seedData() {
  console.log(`\nSeeding inventory and recipes for restaurant: ${TARGET_RESTAURANT_ID}\n`);

  // Step 1: Create all inventory items and build a name→id map
  console.log('--- Creating Inventory Items ---');
  const itemMap = {};

  for (const material of RAW_MATERIALS) {
    // Check if item already exists (avoid duplicates on re-run)
    const existing = await firestoreDb.collection('inventory')
      .where('restaurantId', '==', TARGET_RESTAURANT_ID)
      .where('name', '==', material.name)
      .limit(1).get();

    if (!existing.empty) {
      itemMap[material.name] = existing.docs[0].id;
      console.log(`  ~ Exists: ${material.name} (${existing.docs[0].id})`);
      continue;
    }

    const docRef = await firestoreDb.collection('inventory').add({
      ...material,
      restaurantId: TARGET_RESTAURANT_ID,
      maxStock: material.currentStock * 2,
      status: material.currentStock <= material.minStock ? 'low' : 'normal',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: 'seed-script',
    });
    itemMap[material.name] = docRef.id;
    console.log(`  + Created: ${material.name} → ${docRef.id}`);
  }

  console.log(`\n--- Creating Recipes (${RECIPES.length}) ---`);

  for (const recipe of RECIPES) {
    // Check if recipe already exists
    const existing = await firestoreDb.collection('recipes')
      .where('restaurantId', '==', TARGET_RESTAURANT_ID)
      .where('name', '==', recipe.name)
      .limit(1).get();

    if (!existing.empty) {
      console.log(`  ~ Exists: ${recipe.name}`);
      continue;
    }

    // Map ingredient names to inventory item IDs
    const ingredients = recipe.ingredients.map(ing => ({
      inventoryItemId: itemMap[ing.name] || null,
      inventoryItemName: ing.name,
      quantity: ing.quantity,
      unit: ing.unit,
    }));

    await firestoreDb.collection('recipes').add({
      restaurantId: TARGET_RESTAURANT_ID,
      name: recipe.name,
      menuItemName: recipe.name,
      description: recipe.description || '',
      category: recipe.category || '',
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
    console.log(`  + Created recipe: ${recipe.name} (${ingredients.length} ingredients)`);
  }

  // Step 3: Seed menu items into the restaurant document
  // Uses same patterns as POST /api/menus/bulk-save/:restaurantId (index.js:10098)
  if (SEED_MENU_ITEMS) {
    console.log('\n--- Seeding Menu Items ---');
    const restaurantRef = firestoreDb.collection('restaurants').doc(TARGET_RESTAURANT_ID);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      console.log('  ⚠ Restaurant doc not found, creating menu in a new doc');
    }

    const existingData = restaurantDoc.exists ? restaurantDoc.data() : {};
    const existingMenu = existingData.menu || { items: [] };
    const existingItems = [...(existingMenu.items || [])];

    // Canonical categoryNameToId — same as index.js:1700
    const categoryNameToId = (name) => {
      if (!name || typeof name !== 'string') return 'other';
      return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    };

    // Merge categories into restaurant.categories[] (same as bulk-save:10149)
    const existingCategories = [...(existingData.categories || [])];
    const categoryNames = [...new Set(MENU_ITEMS.map(i => i.category))];

    // Build lookup maps: by ID and by name (case-insensitive)
    const catIdMap = {}; // categoryName → resolved ID
    for (const c of existingCategories) {
      catIdMap[c.name.toLowerCase()] = c.id;
    }

    for (const catName of categoryNames) {
      const catId = categoryNameToId(catName);
      // Check if already exists by ID or by name
      const existsById = existingCategories.some(c => (c.id || '').toLowerCase() === catId);
      const existsByName = existingCategories.some(c => c.name.toLowerCase() === catName.toLowerCase());

      if (!existsById && !existsByName) {
        existingCategories.push({
          id: catId,
          name: catName,
          emoji: catName.toLowerCase().includes('coffee') ? '☕' : catName.toLowerCase().includes('herbal') ? '🌿' : '🍵',
          description: '',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`  + Category: ${catName} (${catId})`);
      } else if (existsByName && !existsById) {
        // Existing category with same name but different ID — use existing ID
        const existing = existingCategories.find(c => c.name.toLowerCase() === catName.toLowerCase());
        catIdMap[catName.toLowerCase()] = existing.id;
        console.log(`  ~ Category exists by name: ${catName} → ${existing.id}`);
      }

      // Map this category name to its ID
      if (!catIdMap[catName.toLowerCase()]) {
        catIdMap[catName.toLowerCase()] = catId;
      }
    }

    // Find max numeric shortCode for auto-increment (same as bulk-save:10139-10146)
    let maxShortCode = 0;
    for (const item of existingItems) {
      const sc = parseInt(item.shortCode, 10);
      if (!isNaN(sc) && sc > maxShortCode) maxShortCode = sc;
    }

    let added = 0;
    let fixed = 0;
    for (const item of MENU_ITEMS) {
      const catId = catIdMap[item.category.toLowerCase()] || categoryNameToId(item.category);

      // Check if item already exists by name (case-insensitive)
      const existingItem = existingItems.find(i => i.name.toLowerCase() === item.name.toLowerCase());
      if (existingItem) {
        // Fix category if it was stored as name string or wrong format
        const currentCat = existingItem.category || '';
        if (!currentCat || currentCat === item.category || !existingCategories.some(c => c.id === currentCat)) {
          existingItem.category = catId;
          fixed++;
        }
        // Fix missing fields on existing items
        if (!existingItem.pricingRules) existingItem.pricingRules = {};
        if (!existingItem.customizations) existingItem.customizations = [];
        if (existingItem.id && existingItem.id.startsWith('menu_')) {
          existingItem.id = existingItem.id.replace('menu_', 'item_');
        }
        console.log(`  ~ Exists: ${item.name} (category → ${catId})`);
        continue;
      }

      maxShortCode++;
      const menuItemId = `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Handle variants (same as bulk-save:10178-10196)
      const variants = (item.variants || [])
        .filter(v => v && v.name && v.price != null)
        .map(v => ({ name: String(v.name).trim(), price: parseFloat(v.price) || 0, description: (v.description || '').trim() }));

      const basePrice = variants.length > 0
        ? Math.min(...variants.map(v => v.price))
        : (parseFloat(item.price) || 0);

      existingItems.push({
        id: menuItemId,
        restaurantId: TARGET_RESTAURANT_ID,
        name: item.name,
        description: item.description || '',
        price: basePrice,
        category: catId,
        isVeg: item.isVeg || false,
        spiceLevel: item.spiceLevel || 'medium',
        allergens: item.allergens || [],
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
        customizations: [],
        pricingRules: item.pricingRules || {},
        source: 'seed_script',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      console.log(`  + ${item.name} (₹${basePrice}, ${catId}, #${maxShortCode})`);
      added++;
      await new Promise(r => setTimeout(r, 5));
    }

    // Clear hasDefaultMenu if present (same as bulk-save:10258)
    const updateData = {
      categories: existingCategories,
      menu: { ...existingMenu, items: existingItems, lastUpdated: new Date() },
      updatedAt: new Date(),
    };
    if (existingData.hasDefaultMenu) {
      updateData.hasDefaultMenu = false;
    }

    await restaurantRef.set(updateData, { merge: true });

    console.log(`  ✓ ${added} added, ${fixed} fixed in restaurant doc`);

    // Link recipes to menu items by matching names
    console.log('\n--- Linking Recipes to Menu Items ---');
    const allRecipes = await firestoreDb.collection('recipes')
      .where('restaurantId', '==', TARGET_RESTAURANT_ID)
      .get();

    // Re-read menu items to get the final list with IDs
    const freshDoc = await restaurantRef.get();
    const finalMenuItems = freshDoc.data()?.menu?.items || [];

    let linked = 0;
    for (const recipeDoc of allRecipes.docs) {
      const recipe = recipeDoc.data();
      if (recipe.menuItemId) continue; // already linked
      const matchedMenuItem = finalMenuItems.find(m =>
        m.name.toLowerCase().trim() === (recipe.name || '').toLowerCase().trim()
      );
      if (matchedMenuItem) {
        await recipeDoc.ref.update({ menuItemId: matchedMenuItem.id });
        console.log(`  🔗 Linked: ${recipe.name} → ${matchedMenuItem.id}`);
        linked++;
      }
    }
    console.log(`  ✓ ${linked} recipes linked to menu items`);
  }

  console.log(`\n✅ Seeding complete!`);
  console.log(`   ${RAW_MATERIALS.length} inventory items`);
  console.log(`   ${RECIPES.length} recipes`);
  console.log(`   ${SEED_MENU_ITEMS ? MENU_ITEMS.length : 0} menu items`);
  console.log(`   Restaurant: ${TARGET_RESTAURANT_ID}\n`);

  process.exit(0);
}

seedData().catch(err => {
  console.error('❌ Seeding failed:', err);
  process.exit(1);
});
