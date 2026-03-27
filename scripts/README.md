# DineOpen Seed Scripts

Scripts for bulk-seeding menu items, inventory, and recipes into restaurant accounts. All scripts use the same data model as the web UI (bulk upload, manual add).

## Quick Start

```bash
# From dine-backend/ directory

# Seed tea/coffee shop demo data (inventory + recipes + menu)
npm run seed:tea

# Bulk seed menu from JSON file
npm run seed:menu -- --restaurant=RESTAURANT_ID --file=path/to/menu.json

# Dry run (preview without saving)
npm run seed:menu:dry -- --restaurant=RESTAURANT_ID --file=path/to/menu.json

# With inventory and recipe creation
npm run seed:menu -- --restaurant=RESTAURANT_ID --file=menu.json --inventory --recipes
```

---

## 1. `seed-tea-recipes.js` — Tea/Coffee Shop Demo

Seeds a complete tea/coffee shop with 18 inventory items, 14 recipes, and 14 menu items.

```bash
npm run seed:tea
```

**Configuration** (edit top of file):
```javascript
const TARGET_RESTAURANT_ID = 'LUETVd1eMwu4Bm7PvP9K';
const SEED_MENU_ITEMS = true;
```

**What it creates:**
- Inventory: Black Tea Leaves, Green Tea Leaves, Milk, Sugar, Cardamom, Ginger, etc.
- Recipes: Black Tea, Cardamom Tea, Ginger Milk Tea, Green Tea, Black Coffee, Hot Chocolate, etc.
- Menu items: All 14 drinks with prices, linked to categories and recipes
- Categories: Tea Counter, Herbal & Speciality Tea, Coffee Counter

---

## 2. `bulk-menu-seed.js` — General-Purpose Bulk Menu

Seeds menu items from a JSON file. Handles categories, variants, multi-tier pricing, inventory, and recipes.

```bash
npm run seed:menu -- --restaurant=RESTAURANT_ID --file=menu.json [options]
```

**Options:**

| Flag | Description |
|------|-------------|
| `--restaurant=ID` | Restaurant ID (required) |
| `--file=path` | Path to JSON file (required) |
| `--inventory` | Create inventory items from recipe ingredients |
| `--recipes` | Create recipe documents linked to menu items |
| `--dry-run` | Preview what would happen without saving |

### JSON Format

```json
{
  "items": [
    {
      "name": "Cardamom Tea",
      "category": "Tea Counter",
      "price": 35,
      "description": "Fragrant cardamom-infused milk tea",
      "isVeg": true
    }
  ]
}
```

### With Variants

```json
{
  "items": [
    {
      "name": "Veg Burger",
      "category": "Burgers",
      "price": 120,
      "description": "Classic veggie burger",
      "isVeg": true,
      "variants": [
        { "name": "Regular", "price": 120 },
        { "name": "Double Patty", "price": 180 },
        { "name": "Cheese", "price": 150 }
      ]
    }
  ]
}
```

Base price is automatically set to the lowest variant price.

### With Multi-Tier Pricing

Use rule names or rule IDs in `pricingRules`. The script auto-resolves names to IDs.

```json
{
  "items": [
    {
      "name": "Paneer Tikka",
      "category": "Starters",
      "price": 200,
      "isVeg": true,
      "pricingRules": {
        "AC Dining": 250,
        "Non-AC Dining": 200,
        "Takeaway": 180
      }
    }
  ]
}
```

The script will map "AC Dining" to the actual rule ID (e.g., `rule_ac_dining`) from the restaurant's pricing settings. Unknown rule names will show a warning and be skipped.

### With Recipes and Inventory

```json
{
  "items": [
    {
      "name": "Masala Chai",
      "category": "Tea Counter",
      "price": 40,
      "isVeg": true,
      "recipe": {
        "servings": 1,
        "prepTime": 3,
        "cookTime": 5,
        "ingredients": [
          { "name": "Black Tea Leaves", "quantity": 3, "unit": "g" },
          { "name": "Milk", "quantity": 150, "unit": "ml" },
          { "name": "Sugar", "quantity": 10, "unit": "g" },
          { "name": "Cardamom", "quantity": 0.5, "unit": "g" },
          { "name": "Ginger", "quantity": 2, "unit": "g" }
        ],
        "instructions": [
          "Boil water with ginger and cardamom",
          "Add tea leaves, simmer 2 minutes",
          "Add milk and sugar, bring to boil",
          "Strain and serve hot"
        ]
      }
    }
  ]
}
```

Run with `--inventory --recipes`:
```bash
npm run seed:menu -- --restaurant=ID --file=menu.json --inventory --recipes
```

This will:
1. Create inventory items for each unique ingredient (if not already present)
2. Create recipe documents linked to both the menu item and inventory items

### Full Example (All Features)

```json
{
  "items": [
    {
      "name": "Classic Burger",
      "category": "Burgers",
      "price": 150,
      "description": "Juicy classic burger with fresh veggies",
      "isVeg": false,
      "spiceLevel": "medium",
      "variants": [
        { "name": "Single", "price": 150 },
        { "name": "Double", "price": 220 }
      ],
      "pricingRules": {
        "AC Dining": 180,
        "Non-AC Dining": 150
      },
      "recipe": {
        "servings": 1,
        "prepTime": 5,
        "cookTime": 10,
        "ingredients": [
          { "name": "Burger Bun", "quantity": 1, "unit": "pcs" },
          { "name": "Cheese Slice", "quantity": 1, "unit": "pcs" },
          { "name": "Lettuce", "quantity": 20, "unit": "g" }
        ],
        "instructions": ["Toast bun", "Assemble burger", "Serve with fries"]
      }
    },
    {
      "name": "French Fries",
      "category": "Sides",
      "price": 80,
      "isVeg": true
    },
    {
      "name": "Cold Coffee",
      "category": "Beverages",
      "price": 120,
      "isVeg": true,
      "variants": [
        { "name": "Regular", "price": 120 },
        { "name": "Large", "price": 160 }
      ]
    }
  ]
}
```

### Bar/Bakery/Ice Cream Type-Specific Fields

```json
{
  "items": [
    {
      "name": "Old Fashioned",
      "category": "Cocktails",
      "price": 450,
      "isVeg": true,
      "spiritCategory": "cocktail",
      "abv": 35,
      "servingUnit": "glass"
    },
    {
      "name": "Chocolate Croissant",
      "category": "Pastries",
      "price": 120,
      "isVeg": true,
      "unit": "piece",
      "weight": "100g"
    },
    {
      "name": "Mango Sorbet",
      "category": "Sorbets",
      "price": 80,
      "isVeg": true,
      "servingSize": "scoop",
      "scoopOptions": 3
    }
  ]
}
```

---

## How It Works

### Category Handling
- Categories are auto-created from item `category` names
- If a category already exists (by ID or name), it is reused — no duplicates
- Category IDs are slugified: "Tea Counter" becomes `tea-counter`
- Same logic as the web UI's AI bulk upload

### Idempotent (Safe to Re-run)
- Items matched by name — duplicates are skipped
- Existing items get their category fixed if it was stored incorrectly
- Recipes are linked to menu items if the link was missing
- Running twice produces the same result

### Data Consistency
All scripts produce the same data format as:
- **Web UI manual add** (`POST /api/menus/:restaurantId`)
- **Web UI AI bulk upload** (`POST /api/menus/bulk-save/:restaurantId`)
- **Default menu seeding** (`POST /api/restaurants/:restaurantId/seed-default`)
