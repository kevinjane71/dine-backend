/**
 * DineOpen Product Knowledge Base
 *
 * Static, in-memory knowledge base covering all DineOpen features.
 * Used by the chatbot's get_product_help tool to answer product usage questions.
 * NOT per-restaurant — this is universal product knowledge shared across all users.
 */

const articles = [
  // ═══════════════════════════════════════════
  // ONBOARDING & SETUP
  // ═══════════════════════════════════════════
  {
    id: 'getting-started',
    title: 'Getting Started with DineOpen',
    category: 'onboarding',
    keywords: ['getting started', 'start', 'setup', 'new', 'begin', 'first time', 'onboarding', 'how to use', 'help', 'guide', 'tutorial'],
    pages: ['/home'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Getting Started with DineOpen

Welcome! Here's how to set up your restaurant:

1. **Set your business type** — Go to **Admin Settings** (/admin) → **General** tab → select your business type (Restaurant, Cafe, Bar, Hotel, Bakery, etc.)
2. **Add restaurant details** — Fill in name, address, phone, email, operating hours in the General tab
3. **Upload your menu** — Go to **Menu** (/menu) → click **Add Item** or use **Bulk Upload** for CSV/Excel
4. **Configure tables** — Go to **Tables** (/tables) → create floors and add tables with capacity
5. **Set up billing** — Go to **Admin Settings** → **Tax** tab for tax rates, **Payments** tab for payment methods
6. **Connect a printer** — Go to **Admin Settings** → **Print** tab to configure receipt printing
7. **Invite staff** — Go to **Admin Settings** → **Staff** tab to create staff accounts with roles
8. **Place your first order** — Go to **Dashboard** (/dashboard) to start taking orders!

Check your setup progress on the **Home** page (/home) — the onboarding checklist shows what's done and what's remaining.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings (gear icon)' },
      { action: 'Select business type', page: '/admin', element: 'General tab → Business Type dropdown' },
      { action: 'Go to Menu page', page: '/menu', element: 'Sidebar → Menu' },
      { action: 'Go to Tables page', page: '/tables', element: 'Sidebar → Tables' },
      { action: 'Configure tax & payments', page: '/admin', element: 'Tax tab, Payments tab' },
      { action: 'Set up printer', page: '/admin', element: 'Print tab' },
      { action: 'Add staff', page: '/admin', element: 'Staff tab' },
      { action: 'Start taking orders', page: '/dashboard', element: 'Sidebar → Dashboard/Billing' },
    ],
    relatedArticles: ['business-type-setup', 'menu-add-items', 'table-management', 'printer-setup', 'invite-staff'],
  },

  {
    id: 'business-type-setup',
    title: 'Choosing Your Business Type',
    category: 'onboarding',
    keywords: ['business type', 'restaurant type', 'cafe', 'bar', 'hotel', 'bakery', 'cloud kitchen', 'food truck', 'qsr', 'fine dining', 'retail', 'sweet shop', 'juice bar', 'ice cream'],
    pages: ['/admin'],
    adminTab: 'settings',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Choosing Your Business Type

DineOpen supports many business types, each with tailored features:

- **Restaurant** — Full-service dining with tables, KOT, and dine-in billing
- **Cafe** — Quick counter service with takeaway focus
- **Bar** — Special bar billing mode with bottle/peg tracking, bar inventory
- **Hotel** — Room management, check-in/check-out, room service billing
- **Bakery** — Counter billing, pre-orders, product catalog
- **Cloud Kitchen** — Delivery-only, no table management, aggregator integration
- **Food Truck** — Mobile POS, simplified billing
- **QSR (Quick Service)** — Token-based ordering, speed-focused
- **Fine Dining** — Course management, reservations, premium billing
- **Ice Cream Parlor / Juice Bar / Sweet Shop** — Counter POS with quick billing
- **Catering** — Advance orders, event-based billing
- **Retail / Jewellery Store** — Product catalog, barcode scanning

**How to set it:**
1. Go to **Admin Settings** (/admin)
2. Click the **General** tab
3. Find **Business Type** dropdown
4. Select your type — features will auto-adjust

Your business type affects which features are shown, default categories, and billing flow.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click General tab', element: 'First tab in the tab bar' },
      { action: 'Select business type', element: 'Business Type dropdown' },
    ],
    relatedArticles: ['getting-started', 'restaurant-details'],
  },

  {
    id: 'restaurant-details',
    title: 'Restaurant Details & Operating Hours',
    category: 'onboarding',
    keywords: ['restaurant name', 'address', 'phone', 'email', 'operating hours', 'opening hours', 'closing time', 'timezone', 'language', 'details', 'info'],
    pages: ['/admin'],
    adminTab: 'settings',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Restaurant Details & Operating Hours

**To update your restaurant info:**
1. Go to **Admin Settings** (/admin) → **General** tab
2. Edit: Restaurant name, address, phone, email
3. Set **Operating Hours** — opening and closing time for each day
4. Set **Timezone** for accurate order timestamps
5. Choose **Language** — 9 languages supported (English, Hindi, Spanish, Chinese, Arabic, French, Portuguese, Japanese, German)
6. Choose **Dashboard Version** — Classic (V1) or Modern Dark (V2)

These details appear on your receipts, invoices, and customer-facing pages.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click General tab', element: 'Tab bar → General' },
      { action: 'Fill in restaurant details', element: 'Name, address, phone, email fields' },
      { action: 'Set operating hours', element: 'Operating Hours section' },
    ],
    relatedArticles: ['getting-started', 'business-type-setup'],
  },

  {
    id: 'invite-staff',
    title: 'Inviting Staff & Managing Roles',
    category: 'staff',
    keywords: ['staff', 'employee', 'invite', 'add staff', 'waiter', 'cashier', 'manager', 'role', 'permission', 'access', 'login', 'password', 'team'],
    pages: ['/admin'],
    adminTab: 'staff',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Inviting Staff & Managing Roles

**To add a staff member:**
1. Go to **Admin Settings** (/admin) → **Staff** tab
2. Click **Add Staff**
3. Enter: Name, email/phone, and set a password
4. Assign a **Role**: Owner, Manager, Waiter, Cashier, Employee, Kitchen, Delivery
5. Configure **Page Access** — which dashboard pages they can see
6. Configure **Feature Permissions** — read, add, edit, delete per feature
7. Save — they can now log in with their credentials

**Role capabilities:**
- **Owner/Admin** — Full access to everything
- **Manager** — Orders, menu, tables, analytics, staff
- **Waiter** — Take orders, manage tables, view menu
- **Cashier** — Complete billing, view orders, refunds
- **Kitchen** — View KOT, update order status
- **Employee** — Custom permissions set by owner

**Offline login:** For the mobile app, staff can set up a PIN for offline device login at **/local-login**.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Staff tab', element: 'Tab bar → Staff' },
      { action: 'Click Add Staff', element: 'Green "Add Staff" button' },
      { action: 'Fill in details and assign role', element: 'Staff form fields' },
      { action: 'Configure page access', element: 'Page Access toggles' },
      { action: 'Save', element: 'Save button' },
    ],
    relatedArticles: ['staff-permissions', 'shifts-attendance'],
  },

  {
    id: 'first-order',
    title: 'Placing Your First Order',
    category: 'onboarding',
    keywords: ['first order', 'place order', 'test order', 'how to order', 'take order', 'new order'],
    pages: ['/dashboard'],
    roles: ['owner', 'admin', 'manager', 'waiter', 'cashier'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Placing Your First Order

**To place an order:**
1. Go to **Dashboard** (/dashboard) — this is the main POS screen
2. **Select order type** — Dine-in (pick a table), Takeaway, or Delivery
3. **Browse menu** — Use the category tabs on the left to find items, or search
4. **Add items** — Click on a menu item to add it to the cart on the right
5. **Adjust quantity** — Use +/- buttons in the cart
6. **Apply discount** (optional) — Click discount button in the cart
7. **Place order** — Click **Place Order** button to send it to kitchen
8. **Complete billing** — When ready, click **Complete Billing** to generate the bill

**For Dine-in:** Select a table first → it shows as occupied → order is linked to that table
**For Takeaway:** Enter customer name/phone → order gets a token number
**For Delivery:** Enter delivery address + customer details

The order appears in **Kitchen Orders** (/kot) for the kitchen staff and in **Order History** (/orderhistory) once completed.`,
    steps: [
      { action: 'Go to Dashboard', page: '/dashboard', element: 'Sidebar → Dashboard/Billing' },
      { action: 'Select order type', element: 'Dine-in / Takeaway / Delivery tabs at top' },
      { action: 'Pick a table (for dine-in)', element: 'Table grid on the right side' },
      { action: 'Add menu items', element: 'Click items from menu grid on the left' },
      { action: 'Click Place Order', element: 'Green "Place Order" button at bottom of cart' },
      { action: 'Complete Billing when ready', element: '"Complete Billing" button' },
    ],
    relatedArticles: ['billing-complete', 'kot-flow', 'order-history'],
  },

  // ═══════════════════════════════════════════
  // MENU MANAGEMENT
  // ═══════════════════════════════════════════
  {
    id: 'menu-add-items',
    title: 'Adding Menu Items',
    category: 'menu',
    keywords: ['add item', 'new item', 'menu item', 'create item', 'add dish', 'add food', 'product', 'price', 'image', 'description'],
    pages: ['/menu'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Adding Menu Items

**To add a menu item:**
1. Go to **Menu** (/menu)
2. Click the **+ Add Item** button (top-right)
3. Fill in:
   - **Name** — Item name (e.g., "Chicken Biryani")
   - **Category** — Select or create a category (e.g., "Main Course")
   - **Price** — Base price
   - **Description** — Optional description
   - **Image** — Upload a photo or use a placeholder
   - **Veg/Non-veg** — Toggle for dietary indicator
   - **Tax** — Apply tax group if needed
4. Click **Save**

**Tips:**
- Use **categories** to organize items (Starters, Main Course, Beverages, Desserts)
- Set items as **out of stock** to temporarily hide them without deleting
- Use **variants** for size options (Small/Medium/Large, Half/Full)
- Add **add-ons** for extras (Extra cheese, Butter, etc.)

For bulk adding, use the **Bulk Upload** feature to import from CSV/Excel.`,
    steps: [
      { action: 'Go to Menu', page: '/menu', element: 'Sidebar → Menu' },
      { action: 'Click + Add Item', element: 'Green button top-right' },
      { action: 'Fill in item details', element: 'Name, category, price, image fields' },
      { action: 'Click Save', element: 'Save button at bottom of form' },
    ],
    relatedArticles: ['menu-categories', 'menu-variants', 'menu-bulk-upload'],
  },

  {
    id: 'menu-categories',
    title: 'Menu Categories',
    category: 'menu',
    keywords: ['category', 'categories', 'organize', 'group', 'section', 'menu section', 'add category', 'create category'],
    pages: ['/menu'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Menu Categories

Categories organize your menu into sections (Starters, Main Course, Beverages, etc.).

**To create a category:**
1. Go to **Menu** (/menu)
2. Click **Manage Categories** or find the category section
3. Click **Add Category**
4. Enter category name
5. Optionally set display order
6. Save

**Tips:**
- Categories appear as tabs on the left side of the POS dashboard
- Reorder categories to control how they appear
- Common categories: Starters, Soups, Main Course, Rice & Biryani, Breads, Beverages, Desserts
- You can also create categories while adding an item — just type a new category name`,
    steps: [
      { action: 'Go to Menu', page: '/menu', element: 'Sidebar → Menu' },
      { action: 'Click Manage Categories', element: 'Category management section' },
      { action: 'Add new category', element: 'Add Category button' },
    ],
    relatedArticles: ['menu-add-items', 'menu-customize'],
  },

  {
    id: 'menu-bulk-upload',
    title: 'Bulk Menu Upload (CSV/Excel)',
    category: 'menu',
    keywords: ['bulk upload', 'csv', 'excel', 'import', 'upload menu', 'spreadsheet', 'batch', 'mass upload', 'multiple items'],
    pages: ['/menu'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Bulk Menu Upload

Upload many items at once using a CSV or Excel file.

**Steps:**
1. Go to **Menu** (/menu)
2. Click the **Bulk Upload** button (usually near the Add Item button)
3. Download the **template file** — it shows the required format
4. Fill in your items in the spreadsheet:
   - Column A: Item Name
   - Column B: Category
   - Column C: Price
   - Column D: Description (optional)
   - Column E: Veg/Non-veg (optional)
5. Upload the completed file
6. Review the preview — check items are parsed correctly
7. Click **Import** to add all items

**Supported formats:** .csv, .xlsx, .xls

**Tips:**
- Start with the template to avoid format issues
- Make sure category names are consistent (exact spelling matters)
- Prices should be numbers only (no currency symbols)
- You can update existing items by re-uploading with the same names`,
    steps: [
      { action: 'Go to Menu', page: '/menu', element: 'Sidebar → Menu' },
      { action: 'Click Bulk Upload', element: 'Bulk Upload button near top' },
      { action: 'Download template', element: 'Download Template link' },
      { action: 'Fill in spreadsheet and upload', element: 'File upload area' },
      { action: 'Review and import', element: 'Import button after preview' },
    ],
    relatedArticles: ['menu-add-items', 'menu-categories'],
  },

  {
    id: 'menu-variants',
    title: 'Menu Variants & Add-ons',
    category: 'menu',
    keywords: ['variant', 'size', 'half', 'full', 'small', 'medium', 'large', 'add-on', 'extra', 'customization', 'topping', 'addon'],
    pages: ['/menu'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Menu Variants & Add-ons

**Variants** let you offer different sizes/options at different prices (Half/Full, Small/Medium/Large).

**To add variants to an item:**
1. Go to **Menu** (/menu)
2. Click **Edit** on the menu item
3. Scroll to **Variants** section
4. Click **Add Variant**
5. Enter variant name (e.g., "Half") and price
6. Add more variants as needed (e.g., "Full" at higher price)
7. Save

**Add-ons** are extras customers can add (Extra cheese, Butter, etc.):
1. In the item edit form, find **Add-ons** section
2. Click **Add Add-on**
3. Enter add-on name and extra price
4. Save

When placing an order on the Dashboard, staff will see variant and add-on options when clicking the item.`,
    steps: [
      { action: 'Go to Menu', page: '/menu', element: 'Sidebar → Menu' },
      { action: 'Click Edit on an item', element: 'Edit icon on the item card' },
      { action: 'Scroll to Variants section', element: 'Variants section in edit form' },
      { action: 'Add variant with name and price', element: 'Add Variant button' },
    ],
    relatedArticles: ['menu-add-items', 'menu-customize'],
  },

  {
    id: 'menu-customize',
    title: 'Menu Theme & Display Settings',
    category: 'menu',
    keywords: ['menu theme', 'customize menu', 'menu display', 'menu appearance', 'menu design', 'qr menu', 'customer menu'],
    pages: ['/menu/customize'],
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Menu Theme & Display Settings

Customize how your menu looks for customers (QR menu and customer app).

**To customize:**
1. Go to **Menu** (/menu) → click **Customize** tab or go to /menu/customize
2. Options include:
   - **Theme color** — Primary brand color for the menu
   - **Logo** — Upload your restaurant logo
   - **Layout** — Grid or list view for items
   - **Show prices** — Toggle price visibility
   - **Show images** — Toggle item images
   - **Show descriptions** — Toggle item descriptions
   - **Category ordering** — Drag to reorder categories

Your QR menu URL can be shared with customers for contactless ordering.`,
    steps: [
      { action: 'Go to Menu Customize', page: '/menu/customize', element: 'Menu → Customize tab' },
      { action: 'Adjust theme and display options', element: 'Settings panel' },
    ],
    relatedArticles: ['menu-add-items', 'menu-categories'],
  },

  // ═══════════════════════════════════════════
  // ORDERS & BILLING
  // ═══════════════════════════════════════════
  {
    id: 'place-order',
    title: 'Taking Orders on Dashboard',
    category: 'orders',
    keywords: ['order', 'place order', 'take order', 'new order', 'dine in', 'takeaway', 'delivery', 'dashboard', 'pos', 'billing', 'cart'],
    pages: ['/dashboard', '/dashboard/v2', '/dashboard/bar'],
    roles: ['owner', 'admin', 'manager', 'waiter', 'cashier'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Taking Orders on Dashboard

The **Dashboard** (/dashboard) is your main POS screen for taking orders.

**Layout:**
- **Left side** — Menu items organized by category tabs
- **Right side** — Cart/order summary with item list, totals, and action buttons
- **Top bar** — Search, table selection, order type toggle

**Order flow:**
1. **Select order type**: Dine-in, Takeaway, or Delivery (tabs at top)
2. **For Dine-in**: Click a table from the table selector
3. **Browse & add items**: Click category tabs on left → click items to add to cart
4. **Adjust quantities**: Use +/− buttons in the cart
5. **Add notes**: Click the note icon on an item for special instructions
6. **Apply discount**: Click discount button to add percentage or flat discount
7. **Place Order**: Click the green **Place Order** button — order goes to kitchen (KOT)
8. **Complete Billing**: When the customer is ready to pay, click **Complete Billing**

**Tips:**
- Use the **search bar** to quickly find items by name
- For bar billing (/dashboard/bar): special layout for bottle/peg ordering
- Modern Dashboard V2 (/dashboard/v2): dark theme with horizontal category tabs`,
    steps: [
      { action: 'Go to Dashboard', page: '/dashboard', element: 'Sidebar → Dashboard/Billing' },
      { action: 'Select order type', element: 'Dine-in / Takeaway / Delivery tabs' },
      { action: 'Click items to add to cart', element: 'Menu grid on left side' },
      { action: 'Click Place Order', element: 'Green button at bottom of cart' },
    ],
    relatedArticles: ['billing-complete', 'kot-flow', 'first-order'],
  },

  {
    id: 'order-history',
    title: 'Order History & Past Orders',
    category: 'orders',
    keywords: ['order history', 'past orders', 'previous orders', 'find order', 'search order', 'order list', 'completed orders', 'order details'],
    pages: ['/orderhistory'],
    roles: ['owner', 'admin', 'manager', 'waiter', 'cashier'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Order History

View all past orders at **Order History** (/orderhistory).

**Features:**
- **Filter by date** — Select a date range to view orders from specific periods
- **Filter by status** — Completed, Cancelled, Pending
- **Filter by type** — Dine-in, Takeaway, Delivery
- **Search** — Find orders by order ID, customer name, or item name
- **View details** — Click any order to see full item list, timestamps, payment info
- **Reprint receipt** — Print a copy of any past order's bill
- **Edit completed order** — Modify items on a completed order (creates a revised bill)

**Order detail view shows:**
- Order ID and timestamp
- Items with quantities and prices
- Subtotal, tax, discount, final total
- Payment method used
- Table number (for dine-in)
- Waiter/staff who placed it`,
    steps: [
      { action: 'Go to Order History', page: '/orderhistory', element: 'Sidebar → Order History' },
      { action: 'Use filters to narrow results', element: 'Filter bar at top (date, status, type)' },
      { action: 'Click an order for details', element: 'Order row in the list' },
    ],
    relatedArticles: ['edit-completed-order', 'billing-complete'],
  },

  {
    id: 'edit-completed-order',
    title: 'Editing Completed Orders',
    category: 'orders',
    keywords: ['edit order', 'modify order', 'change order', 'completed order', 'revised bill', 'correct order', 'fix order', 'edit completed', 'edit items'],
    pages: ['/orderhistory'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Editing Completed Orders

You can edit items on completed orders to correct mistakes (creates a revised bill).

**Steps:**
1. Go to **Order History** (/orderhistory)
2. Find the order you want to edit
3. Click **Edit Items** button on the order
4. Enter an **edit reason** (required — e.g., "Wrong item billed")
5. If PIN verification is enabled, enter the admin PIN
6. Modify items: add, remove, or change quantities
7. Click **Save Changes**

**What happens:**
- The bill is recalculated with the new items
- If the new total is less, an auto-refund note is created
- The receipt shows **"REVISED BILL (Edit #N)"** banner
- Revenue stats are automatically adjusted
- Full edit history is preserved for audit

**To enable/disable PIN verification:**
Go to **Admin Settings** → **POS Settings** → **Advanced Features** → toggle **Require PIN for Editing**.`,
    steps: [
      { action: 'Go to Order History', page: '/orderhistory', element: 'Sidebar → Order History' },
      { action: 'Click Edit Items on an order', element: 'Edit Items button on order card' },
      { action: 'Enter edit reason', element: 'Reason text field' },
      { action: 'Modify items and save', element: 'Item editor + Save Changes button' },
    ],
    relatedArticles: ['order-history', 'billing-complete'],
  },

  {
    id: 'billing-complete',
    title: 'Completing Billing & Payments',
    category: 'billing',
    keywords: ['billing', 'complete billing', 'payment', 'pay', 'bill', 'receipt', 'cash', 'card', 'upi', 'split bill', 'tip', 'refund', 'discount', 'settlement'],
    pages: ['/dashboard'],
    roles: ['owner', 'admin', 'manager', 'cashier'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Completing Billing & Payments

**To complete billing on an order:**
1. On the **Dashboard** (/dashboard), select the active order (click the table or order)
2. Click **Complete Billing** button
3. The billing panel shows:
   - Item list with prices
   - Subtotal, Tax, Discounts
   - **Service Charge** (if enabled)
   - **Round-off** (if enabled)
   - **Final Total**
4. Select **Payment Method**: Cash, Card, UPI, Online, or Multiple
5. For **Cash**: Enter cash tendered → shows change
6. Click **Complete** to finalize

**Advanced billing features** (enable in Admin → Billing Settings):
- **Split Bill** — Split by items, equal share, or custom amounts
- **Tips** — Add tip amount to the bill
- **Discount** — Apply percentage or flat discount with reason
- **Service Charge** — Auto-add service charge percentage
- **Settlement** — Settle payments across multiple methods
- **Credit Book** — Allow customers to pay later
- **Comp/Void** — Mark as complimentary with reason
- **Refund** — Process full or partial refund
- **Email/WhatsApp Bill** — Send digital receipt to customer`,
    steps: [
      { action: 'Select the order on Dashboard', page: '/dashboard', element: 'Click table or order in cart' },
      { action: 'Click Complete Billing', element: 'Complete Billing button at bottom' },
      { action: 'Select payment method', element: 'Cash / Card / UPI buttons' },
      { action: 'Click Complete', element: 'Complete button to finalize' },
    ],
    relatedArticles: ['place-order', 'bill-templates', 'payment-settings'],
  },

  {
    id: 'kot-flow',
    title: 'KOT (Kitchen Order Tickets)',
    category: 'orders',
    keywords: ['kot', 'kitchen', 'kitchen order', 'kitchen display', 'kitchen ticket', 'cooking', 'preparation', 'order ticket', 'print kot'],
    pages: ['/kot'],
    roles: ['owner', 'admin', 'manager', 'waiter'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## KOT (Kitchen Order Tickets)

KOTs are printed tickets sent to the kitchen when an order is placed.

**Viewing KOTs:**
1. Go to **Kitchen Orders** (/kot) — shows all active KOTs
2. Orders are grouped by status: Pending, Preparing, Ready
3. Each KOT shows: table number, items, special instructions, time elapsed

**KOT Flow:**
1. Staff places order on Dashboard → KOT auto-prints (if printer configured)
2. Kitchen sees KOT and starts preparing
3. Kitchen marks items as **Preparing** → then **Ready**
4. Waiter/staff is notified when order is ready for serving

**KOT Printer Setup:**
- **Dedicated KOT printer**: Use the **DineOpen KOT Printer** app on a device connected to a thermal printer
- **Same printer as billing**: Configure in Admin → Print tab
- **Auto-print**: Enable in Admin → Features tab → auto-print KOT on order placement

**KOT Printer App (Separate Device):**
- Download the **DineOpen KOT Printer** desktop app (Electron) or mobile app
- Connect it to the same restaurant account
- It listens for new orders and auto-prints KOTs on the connected printer`,
    steps: [
      { action: 'Go to Kitchen Orders', page: '/kot', element: 'Sidebar → Kitchen Orders' },
      { action: 'View pending KOTs', element: 'KOT cards grouped by status' },
      { action: 'Update status', element: 'Status buttons on each KOT (Preparing → Ready)' },
    ],
    relatedArticles: ['place-order', 'printer-setup', 'kot-printer-app'],
  },

  // ═══════════════════════════════════════════
  // TABLES & BOOKINGS
  // ═══════════════════════════════════════════
  {
    id: 'table-management',
    title: 'Table Management & Floor Setup',
    category: 'tables',
    keywords: ['table', 'tables', 'floor', 'seating', 'capacity', 'add table', 'create table', 'table layout', 'section', 'area'],
    pages: ['/tables'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Table Management & Floor Setup

**To set up tables:**
1. Go to **Tables** (/tables)
2. Click **Add Floor** to create a section (e.g., "Ground Floor", "Terrace", "AC Section")
3. Click **Add Table** within a floor
4. Set: Table number, seating capacity, shape (round/square)
5. Repeat for all tables

**Table statuses:**
- 🟢 **Available** — Ready for guests
- 🔴 **Occupied** — Has an active order
- 🟡 **Reserved** — Booked for future
- 🔵 **Cleaning** — Being cleaned after checkout

**On the Dashboard:**
- Tables appear in the right panel when "Dine-in" is selected
- Click a table to start a new order or view the current order
- Table turns occupied when an order is placed, available when billing completes

**Tips:**
- Use floors/sections to organize by area (indoor, outdoor, private, etc.)
- Set accurate capacity for reservation management
- Tables can be combined for large groups`,
    steps: [
      { action: 'Go to Tables', page: '/tables', element: 'Sidebar → Tables' },
      { action: 'Add a floor', element: 'Add Floor button' },
      { action: 'Add tables within floor', element: 'Add Table button per floor' },
      { action: 'Set table details', element: 'Table number, capacity, shape' },
    ],
    relatedArticles: ['table-reservations', 'place-order'],
  },

  {
    id: 'table-reservations',
    title: 'Table Reservations',
    category: 'tables',
    keywords: ['reservation', 'reserve', 'book table', 'booking', 'advance booking', 'table booking'],
    pages: ['/tables', '/bookings'],
    roles: ['owner', 'admin', 'manager', 'waiter'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Table Reservations

**To reserve a table:**
1. Go to **Tables** (/tables) or **Bookings** (/bookings)
2. Click on an available table
3. Click **Reserve**
4. Enter: Guest name, phone, date, time, party size
5. Confirm reservation

**Managing reservations:**
- View all upcoming reservations in the Bookings page
- Reserved tables show a yellow indicator on the Dashboard
- When guests arrive, the reservation auto-converts to an active order
- Cancel reservations from the Bookings page if needed`,
    steps: [
      { action: 'Go to Tables or Bookings', page: '/tables', element: 'Sidebar → Tables' },
      { action: 'Click an available table', element: 'Green table in the grid' },
      { action: 'Click Reserve', element: 'Reserve button' },
      { action: 'Enter guest details', element: 'Name, phone, date, time, party size' },
    ],
    relatedArticles: ['table-management', 'bookings-catering'],
  },

  {
    id: 'bookings-catering',
    title: 'Advance Orders, Catering & Venue Bookings',
    category: 'tables',
    keywords: ['booking', 'catering', 'advance order', 'pre-order', 'venue', 'event', 'hall', 'party', 'function'],
    pages: ['/bookings'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Advance Orders, Catering & Venue Bookings

The **Bookings** page (/bookings) handles advance orders and event bookings.

**Features:**
- **Advance Orders** — Take orders for future dates (pre-orders for pickup/delivery)
- **Catering Orders** — Large orders with menu selection, headcount, delivery details
- **Venue Bookings** — Book halls/spaces for events (birthday, wedding, corporate)
- **Calendar view** — See all bookings on a calendar

**To create a booking:**
1. Go to **Bookings** (/bookings)
2. Click **New Booking**
3. Select type: Advance Order, Catering, or Venue
4. Fill in details: date, time, guest count, menu selections
5. Add customer details and any advance payment
6. Save

Bookings appear on the calendar and send reminders to staff.`,
    steps: [
      { action: 'Go to Bookings', page: '/bookings', element: 'Sidebar → More → Bookings' },
      { action: 'Click New Booking', element: 'New Booking button' },
      { action: 'Select type and fill details', element: 'Booking form' },
    ],
    relatedArticles: ['table-reservations', 'table-management'],
  },

  // ═══════════════════════════════════════════
  // INVENTORY
  // ═══════════════════════════════════════════
  {
    id: 'inventory-setup',
    title: 'Inventory Setup & Stock Tracking',
    category: 'inventory',
    keywords: ['inventory', 'stock', 'ingredient', 'raw material', 'add inventory', 'track stock', 'quantity', 'unit', 'supplier'],
    pages: ['/inventory'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Inventory Setup & Stock Tracking

**To add inventory items:**
1. Go to **Inventory** (/inventory)
2. Click **Add Item**
3. Enter: Item name, category, unit (kg, liters, pieces, etc.)
4. Set current stock quantity
5. Set **minimum stock level** — triggers low-stock alerts
6. Optionally add supplier info
7. Save

**Tracking stock:**
- Stock updates automatically when orders are placed (if recipes are linked)
- Manually adjust stock via **Stock Adjustment** (for wastage, received goods, etc.)
- View stock history for audit trail
- **Purchase Orders** — Create POs to restock from suppliers

**For bar inventory** (/inventory/bar):
- Track bottles, pegs, and beverage-specific inventory
- Bottle-level tracking for premium spirits`,
    steps: [
      { action: 'Go to Inventory', page: '/inventory', element: 'Sidebar → Inventory' },
      { action: 'Click Add Item', element: 'Add Item button' },
      { action: 'Fill in details', element: 'Name, category, unit, stock, min level' },
      { action: 'Save', element: 'Save button' },
    ],
    relatedArticles: ['inventory-recipes', 'inventory-alerts'],
  },

  {
    id: 'inventory-recipes',
    title: 'Recipes — Linking Menu Items to Ingredients',
    category: 'inventory',
    keywords: ['recipe', 'ingredient', 'link', 'auto deduct', 'deduction', 'raw material', 'consumption', 'menu ingredient'],
    pages: ['/inventory'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Recipes — Linking Menu Items to Ingredients

Recipes link menu items to inventory ingredients so stock is auto-deducted when orders are placed.

**To create a recipe:**
1. Go to **Inventory** (/inventory)
2. Click **Recipes** tab
3. Click **Add Recipe**
4. Select the **menu item** (e.g., "Chicken Biryani")
5. Add ingredients with quantities:
   - Chicken: 200g
   - Rice: 150g
   - Spices: 10g
   - Oil: 20ml
6. Save

**How it works:**
- When "Chicken Biryani" is ordered, inventory auto-deducts: 200g chicken, 150g rice, etc.
- If any ingredient drops below minimum level, you get a low-stock alert
- Helps with cost analysis — see ingredient cost per dish
- Supports variant-specific recipes (Half biryani uses less ingredients)`,
    steps: [
      { action: 'Go to Inventory', page: '/inventory', element: 'Sidebar → Inventory' },
      { action: 'Click Recipes tab', element: 'Recipes tab in Inventory page' },
      { action: 'Click Add Recipe', element: 'Add Recipe button' },
      { action: 'Select menu item and add ingredients', element: 'Recipe form' },
    ],
    relatedArticles: ['inventory-setup', 'inventory-alerts'],
  },

  {
    id: 'inventory-alerts',
    title: 'Low Stock Alerts & Purchase Orders',
    category: 'inventory',
    keywords: ['low stock', 'alert', 'restock', 'purchase order', 'po', 'reorder', 'out of stock', 'stock alert'],
    pages: ['/inventory'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Low Stock Alerts & Purchase Orders

**Low stock alerts** trigger when inventory items fall below their minimum stock level.

**To check low stock:**
1. Go to **Inventory** (/inventory)
2. Items below minimum level are highlighted in red/orange
3. Dashboard also shows low-stock notifications

**Creating a purchase order:**
1. In Inventory, click **Purchase Orders**
2. Click **Create PO**
3. Select supplier
4. Add items and quantities to restock
5. Set expected delivery date
6. Submit — PO is sent to supplier (if email configured)
7. When goods arrive, click **Receive** to update stock

**Tips:**
- Set realistic minimum levels based on daily usage
- Review stock weekly to catch trends
- Use purchase order history for cost tracking`,
    steps: [
      { action: 'Go to Inventory', page: '/inventory', element: 'Sidebar → Inventory' },
      { action: 'Check highlighted low-stock items', element: 'Red/orange items in list' },
      { action: 'Click Purchase Orders', element: 'Purchase Orders tab/section' },
      { action: 'Create PO', element: 'Create PO button' },
    ],
    relatedArticles: ['inventory-setup', 'inventory-recipes'],
  },

  // ═══════════════════════════════════════════
  // CUSTOMERS
  // ═══════════════════════════════════════════
  {
    id: 'customer-crm',
    title: 'Customer Management & CRM',
    category: 'customers',
    keywords: ['customer', 'crm', 'add customer', 'customer list', 'customer history', 'repeat customer', 'contact', 'segment'],
    pages: ['/customers'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Customer Management & CRM

**To manage customers:**
1. Go to **Customers** (/customers)
2. View all customers with their order history, total spent, last visit

**Adding a customer:**
- Customers are auto-created when their phone/email is entered during ordering
- Or manually click **Add Customer** → enter name, phone, email, address

**Customer profile** (click a customer):
- Order history with dates and amounts
- Total orders, total spent, average order value
- Last visit date
- Customer segments (VIP, Regular, New, etc.)
- Notes and tags

**Customer segments:**
- Auto-segments: New (first order), Regular (3+ orders), VIP (10+ orders or high spend)
- Custom segments: Create your own based on criteria`,
    steps: [
      { action: 'Go to Customers', page: '/customers', element: 'Sidebar → Customers' },
      { action: 'Click Add Customer or search', element: 'Add Customer button or search bar' },
      { action: 'Click a customer for profile', element: 'Customer row in list' },
    ],
    relatedArticles: ['loyalty-program'],
  },

  {
    id: 'loyalty-program',
    title: 'Loyalty Program & Rewards',
    category: 'customers',
    keywords: ['loyalty', 'points', 'rewards', 'earn points', 'redeem', 'loyalty program', 'reward', 'cashback'],
    pages: ['/admin'],
    adminTab: 'loyalty',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Loyalty Program & Rewards

Set up a points-based loyalty program for repeat customers.

**To configure:**
1. Go to **Admin Settings** (/admin) → **Loyalty** tab
2. Enable loyalty program
3. Set earning rules:
   - Points per currency unit spent (e.g., 1 point per ₹10)
   - Bonus points for specific items/categories
4. Set redemption rules:
   - Points required for discount (e.g., 100 points = ₹50 off)
   - Minimum order value for redemption
5. Set tier levels (optional):
   - Bronze: 0-500 points
   - Silver: 500-2000 points
   - Gold: 2000+ points (with tier-specific perks)
6. Save

**How customers earn/redeem:**
- Points auto-accumulate on each order
- During billing, staff can apply loyalty redemption
- Customer app shows points balance and rewards available`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Loyalty tab', element: 'Tab bar → Loyalty' },
      { action: 'Enable and configure rules', element: 'Earning/redemption rule fields' },
      { action: 'Save', element: 'Save button' },
    ],
    relatedArticles: ['customer-crm'],
  },

  // ═══════════════════════════════════════════
  // ADMIN SETTINGS
  // ═══════════════════════════════════════════
  {
    id: 'tax-settings',
    title: 'Tax Configuration (GST/VAT/Sales Tax)',
    category: 'admin',
    keywords: ['tax', 'gst', 'vat', 'sales tax', 'tax rate', 'cgst', 'sgst', 'igst', 'tax group', 'tax inclusive', 'tax exempt'],
    pages: ['/admin'],
    adminTab: 'tax',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Tax Configuration

**To set up taxes:**
1. Go to **Admin Settings** (/admin) → **Tax & Identity** tab
2. Set your **global tax rate** (applies to all items by default)
3. For India: Enter GSTIN, set GST rates (CGST + SGST or IGST)
4. For other countries: Set VAT, Sales Tax, or custom tax name and rate
5. Toggle **Tax Inclusive Pricing** — prices include tax or tax is added on top

**Tax groups** (for different rates on different items):
1. Click **Add Tax Group**
2. Name it (e.g., "Beverages Tax", "Alcohol Tax")
3. Set the rate
4. Assign to specific menu items or categories

**Business registration:**
- GSTIN (India), VAT Number (UK/EU), ABN (Australia), TRN (UAE)
- Entered in the Tax tab — shows on invoices and receipts

**Discount settings:**
- Max manual discount percentage allowed
- Discount reason required (optional)`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Tax & Identity tab', element: 'Tab bar → Tax & Identity' },
      { action: 'Set global tax rate', element: 'Tax rate input field' },
      { action: 'Add tax groups if needed', element: 'Add Tax Group button' },
    ],
    relatedArticles: ['pricing-rules', 'billing-complete'],
  },

  {
    id: 'pricing-rules',
    title: 'Pricing Rules & Tiers',
    category: 'admin',
    keywords: ['pricing', 'price tier', 'ac dining', 'non-ac', 'takeaway price', 'delivery price', 'zone pricing', 'floor pricing', 'surcharge'],
    pages: ['/admin'],
    adminTab: 'pricing',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Pricing Rules & Tiers

Set different prices based on order type or dining area.

**To configure:**
1. Go to **Admin Settings** (/admin) → **Pricing Rules** tab
2. Options:
   - **AC Dining** — Higher prices for AC section
   - **Non-AC Dining** — Standard prices
   - **Takeaway** — Different prices for takeaway
   - **Delivery** — Delivery-specific pricing
3. Set percentage markup or flat difference for each tier
4. Assign tiers to specific floors/sections

**Zone-based pricing:**
- Different prices per floor (e.g., Terrace = +10%)
- Per-section surcharges (VIP area, private dining)

Prices auto-adjust on the Dashboard based on the selected order type or table location.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Pricing Rules tab', element: 'Tab bar → Pricing Rules' },
      { action: 'Set pricing tiers', element: 'Tier configuration fields' },
    ],
    relatedArticles: ['tax-settings', 'billing-complete'],
  },

  {
    id: 'payment-settings',
    title: 'Payment Methods & Gateway Setup',
    category: 'admin',
    keywords: ['payment', 'upi', 'razorpay', 'card', 'cash', 'payment method', 'qr code', 'online payment', 'gateway', 'dodo'],
    pages: ['/admin'],
    adminTab: 'payments',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Payment Methods & Gateway Setup

**To configure payment methods:**
1. Go to **Admin Settings** (/admin) → **Payment Settings** tab
2. Enable/disable payment methods:
   - **Cash** — Always available
   - **Card** — Credit/debit card payments
   - **UPI** — QR code-based payments (India)
   - **Online** — Razorpay / Dodo Payments gateway
3. For **UPI**: Upload your UPI QR code image or enter UPI ID
4. For **Razorpay**: Connect your Razorpay account via OAuth
5. For **Dodo Payments** (international): Add API keys

**UPI QR Code Setup:**
1. Click **UPI Settings**
2. Upload your QR code image (from Google Pay, PhonePe, etc.)
3. Or enter your UPI ID (e.g., name@upi)
4. QR code shows during billing when UPI is selected

During billing, staff selects the payment method. Multiple methods can be combined (split payment).`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Payment Settings tab', element: 'Tab bar → Payment Settings' },
      { action: 'Enable payment methods', element: 'Toggle switches for each method' },
      { action: 'Configure UPI/Razorpay if needed', element: 'Setup sections below toggles' },
    ],
    relatedArticles: ['billing-complete', 'tax-settings'],
  },

  {
    id: 'printer-setup',
    title: 'Printer Setup & Configuration',
    category: 'printer',
    keywords: ['printer', 'print', 'thermal', 'receipt', 'bluetooth', 'usb', 'wifi', 'a4', 'receipt printer', 'bill print', 'printing', 'connect printer'],
    pages: ['/admin'],
    adminTab: 'print',
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Printer Setup & Configuration

**To set up your printer:**
1. Go to **Admin Settings** (/admin) → **Print** tab
2. Select **Printer Type**:
   - **Thermal** — 58mm/80mm thermal receipt printers
   - **A4** — Standard paper printer
   - **Roll** — Continuous roll paper
3. Configure receipt width, font size, content options
4. Test print to verify setup

### Platform-Specific Setup:

**Desktop (Electron app):**
- Supports **USB** and **WiFi** thermal printers directly
- Go to Print tab → select your connected printer from the dropdown
- For WiFi: enter printer IP address
- Auto-print supported — receipts print automatically on order/billing

**Mobile (DineOpen App):**
- Supports **Bluetooth** thermal printers
- Go to **Printer Settings** tab in the app
- Pair your Bluetooth printer in phone settings first
- Then select it in the app's printer settings
- Supported brands: Epson, Star, Rongta, and generic ESC/POS printers

**Web Browser:**
- Uses your browser's built-in print dialog
- For thermal printers, the Desktop app is recommended for auto-printing
- You can still print by clicking the Print button on receipts

**Receipt Customization** (in Print tab):
- Show/hide: restaurant address, phone, table number, waiter name, tax breakdown
- Custom header and footer text
- Logo on receipt
- Font size adjustments`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Print tab', element: 'Tab bar → Print' },
      { action: 'Select printer type', element: 'Printer Type dropdown (Thermal/A4/Roll)' },
      { action: 'Configure settings', element: 'Width, font, content options' },
      { action: 'Test print', element: 'Test Print button' },
    ],
    platformNotes: {
      electron: 'Desktop app supports USB and WiFi thermal printers directly. Select from the printer dropdown in Print tab. Auto-print is available for receipts and KOTs.',
      capacitor: 'Mobile app supports Bluetooth thermal printers. Pair your printer in phone Bluetooth settings first, then select it in the app\'s Printer Settings tab.',
      web: 'Web browser uses the system print dialog. For thermal receipt printers with auto-printing, use the DineOpen Desktop app instead.'
    },
    relatedArticles: ['bill-templates', 'kot-flow', 'kot-printer-app'],
  },

  {
    id: 'bill-templates',
    title: 'Bill Templates & Receipt Customization',
    category: 'billing',
    keywords: ['bill template', 'receipt template', 'receipt design', 'bill format', 'receipt format', 'customize receipt', 'bill layout', 'receipt layout'],
    pages: ['/admin'],
    adminTab: 'billing-settings',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Bill Templates & Receipt Customization

**To choose and customize your bill template:**
1. Go to **Admin Settings** (/admin) → **Billing** tab
2. Browse available bill templates (5+ designs)
3. Select your preferred template
4. Customize what's shown on the receipt:
   - Restaurant name, address, phone
   - Table number, waiter name
   - Item-wise tax breakdown
   - Service charge line
   - Custom header text (e.g., "Thank you for dining!")
   - Custom footer text (e.g., "Visit us again!")
   - QR code for feedback
5. Preview the template
6. Save

**Bill sections you can toggle on/off:**
- Service Charge, Round-off, Cash Tendering display
- Settlement details, Split bill details
- Tips line, Credit book reference
- Comp/Void indicator
- Email/WhatsApp share buttons
- Refund information`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Billing tab', element: 'Tab bar → Billing' },
      { action: 'Browse and select template', element: 'Template gallery' },
      { action: 'Toggle receipt fields', element: 'Show/hide toggles for each field' },
      { action: 'Save', element: 'Save button' },
    ],
    relatedArticles: ['printer-setup', 'billing-complete'],
  },

  {
    id: 'staff-permissions',
    title: 'Staff Permissions & Page Access',
    category: 'admin',
    keywords: ['permission', 'access', 'page access', 'feature access', 'restrict', 'role permission', 'staff access', 'rbac'],
    pages: ['/admin'],
    adminTab: 'staff',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Staff Permissions & Page Access

Control what each staff member can see and do.

**Page-level access** (which pages they see in sidebar):
1. Go to **Admin Settings** → **Staff** tab
2. Click **Edit** on a staff member
3. Toggle pages: Dashboard, Orders, Tables, Menu, Inventory, Customers, Analytics, KOT, Admin, etc.
4. Save

**Feature-level permissions** (what actions they can take):
- **Read** — View data
- **Add** — Create new items
- **Update** — Edit existing items
- **Delete** — Remove items
- **Cancel** — Cancel orders
- **Refund** — Process refunds
- **Complete Bill** — Finalize billing
- **Config** — Change settings

**Role presets:**
- Owner/Admin: Full access
- Manager: Most features except sensitive settings
- Waiter: Orders, tables, menu (view only)
- Cashier: Billing, order history, refunds
- Kitchen: KOT view and status updates
- Employee: Fully customizable

Staff who try to access a restricted page are redirected to Home.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Staff tab', element: 'Tab bar → Staff' },
      { action: 'Click Edit on staff member', element: 'Edit icon on staff row' },
      { action: 'Toggle page access', element: 'Page Access toggle switches' },
      { action: 'Set feature permissions', element: 'Feature Permissions grid' },
    ],
    relatedArticles: ['invite-staff'],
  },

  {
    id: 'features-toggle',
    title: 'Enabling & Disabling Features',
    category: 'admin',
    keywords: ['features', 'enable', 'disable', 'toggle', 'turn on', 'turn off', 'activate', 'deactivate', 'feature flag'],
    pages: ['/admin'],
    adminTab: 'features',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Enabling & Disabling Features

Toggle DineOpen features on/off based on your needs.

**To configure:**
1. Go to **Admin Settings** (/admin) → **Features** tab
2. Toggle features:
   - **KOT Management** — Kitchen order tickets
   - **Auto-Print KOT** — Auto-print on order placement
   - **Table Management** — Floor and table system
   - **Delivery** — Delivery order management
   - **Inventory** — Stock tracking
   - **Customer CRM** — Customer database
   - **Loyalty Program** — Points and rewards
   - **Hotel Features** — Room management
   - **Parking** — Parking lot management
   - **WhatsApp Integration** — Order via WhatsApp
   - **Social Media** — Content scheduling
   - **DineAI** — AI voice assistant
   - And many more...
3. Save

Disabled features are hidden from the sidebar and not accessible. This keeps the interface clean and focused on what you actually use.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Features tab', element: 'Tab bar → Features' },
      { action: 'Toggle features on/off', element: 'Toggle switches for each feature' },
      { action: 'Save', element: 'Save button' },
    ],
    relatedArticles: ['getting-started', 'staff-permissions'],
  },

  {
    id: 'currency-settings',
    title: 'Currency & Multi-Currency Setup',
    category: 'admin',
    keywords: ['currency', 'inr', 'usd', 'eur', 'sar', 'aed', 'gbp', 'symbol', 'decimal', 'multi-currency', 'exchange rate'],
    pages: ['/admin'],
    adminTab: 'currency',
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Currency & Multi-Currency Setup

**To set your currency:**
1. Go to **Admin Settings** (/admin) → **Currency** tab
2. Select your **country** — currency auto-sets (INR, USD, EUR, SAR, AED, GBP, etc.)
3. Customize:
   - Currency symbol position (before/after amount)
   - Decimal places (0, 1, or 2)
   - Thousand separator format
4. Save

Currency settings affect: billing, receipts, reports, analytics, and the customer app.`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click Currency tab', element: 'Tab bar → Currency' },
      { action: 'Select country and customize', element: 'Country dropdown and format options' },
    ],
    relatedArticles: ['tax-settings'],
  },

  // ═══════════════════════════════════════════
  // ANALYTICS & REPORTS
  // ═══════════════════════════════════════════
  {
    id: 'sales-summary',
    title: 'Sales Summary & Reports',
    category: 'analytics',
    keywords: ['sales', 'revenue', 'report', 'daily report', 'summary', 'income', 'earnings', 'profit', 'sales summary', 'end of day'],
    pages: ['/sales-summary'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Sales Summary & Reports

**To view sales summary:**
1. Go to **Sales Summary** (/sales-summary)
2. Select a date range
3. View:
   - **Total Revenue** — Gross sales for the period
   - **Order Count** — Total orders
   - **Average Order Value** — Revenue ÷ orders
   - **Payment Breakdown** — Cash vs Card vs UPI vs Online
   - **Category Breakdown** — Revenue by menu category
   - **Order Type** — Dine-in vs Takeaway vs Delivery revenue
   - **Tax Collected** — Total tax amount
   - **Discounts Given** — Total discounts
   - **Refunds** — Total refunded amount

**Exporting:**
- Download as PDF or CSV
- Print the summary
- Share via email or WhatsApp`,
    steps: [
      { action: 'Go to Sales Summary', page: '/sales-summary', element: 'Sidebar → More → Sales Summary' },
      { action: 'Select date range', element: 'Date picker at top' },
      { action: 'View breakdown sections', element: 'Revenue, payments, categories panels' },
    ],
    relatedArticles: ['analytics-dashboard'],
  },

  {
    id: 'analytics-dashboard',
    title: 'Analytics & Insights',
    category: 'analytics',
    keywords: ['analytics', 'insights', 'chart', 'trend', 'popular items', 'customer insights', 'performance', 'graph', 'data'],
    pages: ['/analytics'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Analytics & Insights

**To view analytics:**
1. Go to **Analytics** (/analytics)
2. Explore:
   - **Revenue trends** — Daily/weekly/monthly revenue charts
   - **Order trends** — Order volume over time
   - **Popular items** — Best-selling dishes by quantity and revenue
   - **Peak hours** — Busiest hours of the day
   - **Customer analytics** — New vs returning, average spend
   - **Table performance** — Revenue per table, turnover rate
   - **Staff performance** — Orders handled per staff member

**Using analytics:**
- Identify your best-selling items to keep them in stock
- Find peak hours to schedule staff accordingly
- Track revenue trends to set business goals
- Compare periods (this week vs last week)`,
    steps: [
      { action: 'Go to Analytics', page: '/analytics', element: 'Sidebar → More → Analytics' },
      { action: 'Browse different report sections', element: 'Tab bar with report categories' },
    ],
    relatedArticles: ['sales-summary'],
  },

  // ═══════════════════════════════════════════
  // AI FEATURES
  // ═══════════════════════════════════════════
  {
    id: 'dineai-voice',
    title: 'DineAI Voice Assistant',
    category: 'ai',
    keywords: ['dineai', 'voice', 'voice assistant', 'ai', 'speak', 'talk', 'voice order', 'hands-free', 'speech'],
    pages: ['/dineai'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## DineAI Voice Assistant

DineAI lets you manage your restaurant with voice commands.

**To use DineAI:**
1. Go to **DineAI** (/dineai) or click the DineAI button (bottom-right)
2. Choose voice mode:
   - **Push-to-Talk** — Press and hold button, speak, release (free, uses browser speech)
   - **Cheap Realtime** — Continuous voice with AI (cost-optimized)
   - **Full Realtime** — Premium voice experience (most natural but costs more)
3. Speak naturally: "Place an order for table 5", "Show today's revenue", "What tables are available?"

**What DineAI can do:**
- Place and manage orders by voice
- Check table status and reservations
- Get revenue and analytics reports
- Search menu items
- Manage inventory
- Answer questions about your restaurant data

**Settings:**
Go to **DineAI** (/dineai) → Settings to configure voice type, response mode, greeting style, and which features DineAI can access.

**Knowledge Base:**
Upload your own documents (menu descriptions, SOPs, policies) to DineAI's knowledge base so it can answer restaurant-specific questions.`,
    steps: [
      { action: 'Go to DineAI', page: '/dineai', element: 'Sidebar → More → DineAI' },
      { action: 'Select voice mode', element: 'Mode selector (PTT / Cheap / Realtime)' },
      { action: 'Speak your command', element: 'Microphone button' },
    ],
    relatedArticles: ['phone-agent', 'whatsapp-ordering'],
  },

  {
    id: 'phone-agent',
    title: 'AI Phone Agent',
    category: 'ai',
    keywords: ['phone', 'phone agent', 'ai call', 'auto answer', 'phone order', 'call center', 'bolna', 'automated phone'],
    pages: ['/phone-agent'],
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## AI Phone Agent

The AI Phone Agent answers phone calls and takes orders automatically.

**To set up:**
1. Go to **Phone Agent** (/phone-agent)
2. Configure:
   - Restaurant phone number for forwarding
   - Voice personality and greeting
   - Menu knowledge (auto-synced from your menu)
   - Operating hours for the agent
3. Test the agent with a sample call
4. Enable to start receiving calls

**How it works:**
- Customer calls your number
- AI agent answers with your restaurant's greeting
- Takes the order conversationally
- Confirms items, quantities, and delivery details
- Places the order in your DineOpen system
- Sends confirmation to the customer

This is powered by Bolna AI and requires a subscription plan that includes AI features.`,
    steps: [
      { action: 'Go to Phone Agent', page: '/phone-agent', element: 'Sidebar → More → Phone Agent' },
      { action: 'Configure settings', element: 'Phone number, voice, hours' },
      { action: 'Test with sample call', element: 'Test Call button' },
      { action: 'Enable agent', element: 'Enable toggle' },
    ],
    relatedArticles: ['dineai-voice', 'whatsapp-ordering'],
  },

  {
    id: 'whatsapp-ordering',
    title: 'WhatsApp Ordering',
    category: 'ai',
    keywords: ['whatsapp', 'whatsapp order', 'whatsapp bot', 'whatsapp integration', 'messaging', 'chat order'],
    pages: ['/whatsapp-ordering'],
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## WhatsApp Ordering

Let customers place orders through WhatsApp.

**To set up:**
1. Go to **WhatsApp Ordering** (/whatsapp-ordering)
2. Connect your WhatsApp Business number
3. Configure automated responses:
   - Welcome message
   - Menu sharing (sends your menu as a formatted message)
   - Order confirmation templates
4. Enable WhatsApp ordering

**How it works:**
- Customer sends a message to your WhatsApp business number
- Bot responds with menu options
- Customer selects items and confirms order
- Order appears in your DineOpen dashboard
- Staff processes the order normally

**Also in Admin Settings** → **WhatsApp** tab for advanced configuration.`,
    steps: [
      { action: 'Go to WhatsApp Ordering', page: '/whatsapp-ordering', element: 'Sidebar → More → WhatsApp Ordering' },
      { action: 'Connect WhatsApp Business', element: 'Connect button' },
      { action: 'Configure templates', element: 'Message template editor' },
      { action: 'Enable', element: 'Enable toggle' },
    ],
    relatedArticles: ['phone-agent', 'dineai-voice'],
  },

  // ═══════════════════════════════════════════
  // HOTEL & ADVANCED
  // ═══════════════════════════════════════════
  {
    id: 'hotel-rooms',
    title: 'Hotel Room Management',
    category: 'hotel',
    keywords: ['hotel', 'room', 'check in', 'check out', 'room service', 'guest', 'booking', 'housekeeping', 'pms'],
    pages: ['/hotel'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Hotel Room Management

**To manage hotel rooms:**
1. Go to **Hotel** (/hotel)
2. View room grid with status indicators:
   - 🟢 Available, 🔴 Occupied, 🟡 Reserved, 🔵 Cleaning
3. **Check-in**: Click an available room → enter guest details → confirm
4. **Room Service**: Click occupied room → place food order → charges added to room bill
5. **Check-out**: Click occupied room → review total charges → process payment → check out

**Room setup** (one-time):
1. Go to Admin Settings → Features → enable Hotel
2. In Hotel page, click **Add Room**
3. Set: Room number, type (Standard/Deluxe/Suite), floor, rate per night
4. Set amenities, max occupancy

**Features:**
- Room billing with food, laundry, and extra charges
- Guest history and contact management
- Housekeeping status tracking
- Room availability calendar`,
    steps: [
      { action: 'Go to Hotel', page: '/hotel', element: 'Sidebar → Hotel' },
      { action: 'View room grid', element: 'Room status grid' },
      { action: 'Click room for check-in/check-out', element: 'Room card' },
    ],
    relatedArticles: ['billing-complete', 'bookings-catering'],
  },

  {
    id: 'shifts-attendance',
    title: 'Shifts & Staff Attendance',
    category: 'staff',
    keywords: ['shift', 'attendance', 'clock in', 'clock out', 'schedule', 'roster', 'work hours', 'break', 'leave', 'time tracking'],
    pages: ['/shifts', '/shifts-cash', '/attendance'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Shifts & Staff Attendance

**Attendance Tracking (/attendance):**
1. Staff clock in when they arrive (via app or web)
2. Geo-location verification ensures they're at the restaurant
3. Clock out when shift ends
4. View attendance records, late arrivals, total hours

**Shift Scheduling (/shifts):**
1. Create shift templates (Morning: 9am-3pm, Evening: 3pm-11pm)
2. Assign staff to shifts
3. View weekly/monthly roster
4. Manage shift swaps and time-off requests

**Shifts & Cash (/shifts-cash):**
- Track cash drawer per shift
- Opening balance and closing balance
- Cash in/out transactions during shift
- Discrepancy reporting (expected vs actual cash)

**How to set up:**
1. Go to **Admin Settings** → enable Attendance/Shifts features
2. Go to **Attendance** (/attendance) or **Shifts** (/shifts)
3. Staff can clock in via the DineOpen mobile app or web dashboard`,
    steps: [
      { action: 'Go to Attendance or Shifts', page: '/attendance', element: 'Sidebar → More → Attendance' },
      { action: 'View attendance records', element: 'Attendance log with dates and times' },
      { action: 'Go to Shifts for scheduling', page: '/shifts', element: 'Sidebar → More → Shifts' },
    ],
    relatedArticles: ['invite-staff', 'staff-permissions'],
  },

  {
    id: 'parking-management',
    title: 'Parking Lot Management',
    category: 'hotel',
    keywords: ['parking', 'parking lot', 'valet', 'qr', 'vehicle', 'car', 'ticket', 'parking ticket'],
    pages: ['/parking'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Parking Lot Management

**To manage parking:**
1. Go to **Parking** (/parking)
2. Set up parking zones and slots
3. Features:
   - **QR-based entry/exit** — Scan QR codes for vehicle tracking
   - **Ticket generation** — Print parking tickets
   - **Time-based billing** — Auto-calculate charges based on duration
   - **Vehicle type pricing** — Different rates for cars, bikes, etc.
   - **Slot availability** — Real-time slot status

**Setup:**
1. Enable Parking in Admin Settings → Features
2. Go to Parking page → configure zones, slots, and pricing
3. Print QR codes for entry/exit points

The **OpenParking** mobile app provides a dedicated parking management interface with OCR for license plate scanning.`,
    steps: [
      { action: 'Go to Parking', page: '/parking', element: 'Sidebar → More → Parking' },
      { action: 'Configure zones and slots', element: 'Zone setup section' },
      { action: 'Set pricing rules', element: 'Pricing configuration' },
    ],
    relatedArticles: ['hotel-rooms'],
  },

  // ═══════════════════════════════════════════
  // OTHER
  // ═══════════════════════════════════════════
  {
    id: 'download-apps',
    title: 'Download DineOpen Apps',
    category: 'general',
    keywords: ['download', 'app', 'desktop', 'mobile', 'electron', 'play store', 'app store', 'install', 'dmg', 'exe', 'android', 'ios', 'iphone', 'mac', 'windows'],
    pages: ['/admin'],
    adminTab: 'app-download',
    roles: ['owner', 'admin', 'manager', 'waiter', 'cashier', 'employee'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Download DineOpen Apps

DineOpen is available on multiple platforms:

**Desktop App (recommended for POS):**
- **Mac**: Download the DMG file from Admin Settings → App Download tab
- **Windows**: Download the EXE installer
- Benefits: Direct USB/WiFi printer support, auto-print, offline mode, faster performance

**Mobile App (for staff on the go):**
- **Android**: Download "DineOpen" from the Google Play Store
- **iOS**: Download "DineOpen" from the Apple App Store
- Benefits: Bluetooth printer support, attendance with geo-verification, delivery tracking

**Web (works anywhere):**
- Access from any browser at your DineOpen URL
- No installation needed
- Limited printer support (uses browser print dialog)

**KOT Printer App (dedicated kitchen printer):**
- Separate app for a device connected to the kitchen printer
- Available as desktop (Electron) or Android app
- Auto-prints KOTs when new orders come in

**To find download links:**
Go to **Admin Settings** (/admin) → **App Download** tab`,
    steps: [
      { action: 'Go to Admin Settings', page: '/admin', element: 'Sidebar → Admin Settings' },
      { action: 'Click App Download tab', element: 'Tab bar → App Download' },
      { action: 'Download for your platform', element: 'Download buttons for Mac/Windows/Android/iOS' },
    ],
    platformNotes: {
      electron: 'You are already using the Desktop app! Check for updates in Admin → App Download.',
      capacitor: 'You are already using the Mobile app! Check for updates in your app store.',
      web: 'For the best POS experience with printer support and auto-print, download the Desktop app from Admin → App Download.'
    },
    relatedArticles: ['printer-setup', 'kot-printer-app'],
  },

  {
    id: 'kot-printer-app',
    title: 'KOT Printer App Setup',
    category: 'printer',
    keywords: ['kot printer', 'kitchen printer', 'dedicated printer', 'kot app', 'printer app', 'auto print kot'],
    pages: ['/admin'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## KOT Printer App Setup

Set up a dedicated device for auto-printing KOTs (Kitchen Order Tickets).

**What is it?**
A separate app that runs on a device (tablet, old phone, or computer) connected to a thermal printer near the kitchen. It auto-prints KOTs when new orders come in.

**Setup:**
1. Get a device for the kitchen (Android tablet or computer)
2. Connect a thermal printer to it (USB or Bluetooth)
3. Install the **DineOpen KOT Printer** app:
   - **Desktop**: Download from Admin → App Download
   - **Android**: Download from Play Store "DineOpen KOT Printer"
4. Log in with your restaurant account
5. Select the printer in the app settings
6. The app now listens for new orders and auto-prints KOTs

**How it works:**
- Orders placed on any device (web, mobile, desktop POS) trigger a real-time event
- The KOT Printer app receives the event via Firebase/Pusher
- KOT auto-prints on the connected thermal printer
- No manual action needed — fully automated`,
    steps: [
      { action: 'Get a kitchen device', element: 'Android tablet or computer' },
      { action: 'Connect thermal printer', element: 'USB or Bluetooth connection' },
      { action: 'Install KOT Printer app', element: 'Download from Admin → App Download' },
      { action: 'Log in and select printer', element: 'App login + printer selection' },
    ],
    relatedArticles: ['printer-setup', 'kot-flow', 'download-apps'],
  },

  {
    id: 'cancelled-orders',
    title: 'Cancelled & Refunded Orders',
    category: 'orders',
    keywords: ['cancel', 'cancelled', 'refund', 'void', 'cancel order', 'refund order'],
    pages: ['/cancelled-orders'],
    roles: ['owner', 'admin', 'manager', 'cashier'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Cancelled & Refunded Orders

**To view cancelled orders:**
1. Go to **Cancelled Orders** (/cancelled-orders)
2. View all cancelled and refunded orders with reasons
3. Filter by date range

**To cancel an active order:**
1. On the **Dashboard**, select the order
2. Click **Cancel Order**
3. Enter a cancellation reason (required)
4. Confirm — order status changes to "Cancelled"

**To refund a completed order:**
1. Go to **Order History** (/orderhistory)
2. Find the order
3. Click **Refund** button
4. Choose full or partial refund
5. Enter refund reason
6. Confirm — refund is recorded and revenue stats adjusted

**Settings:**
- In Admin → Order Management tab: configure cancellation policies, require reasons, WhatsApp notification on cancellation`,
    steps: [
      { action: 'Go to Cancelled Orders', page: '/cancelled-orders', element: 'Sidebar → More → Cancelled Orders' },
      { action: 'View cancelled orders with reasons', element: 'Order list with cancellation details' },
    ],
    relatedArticles: ['order-history', 'edit-completed-order'],
  },

  {
    id: 'social-media',
    title: 'Social Media Management',
    category: 'ai',
    keywords: ['social media', 'instagram', 'facebook', 'twitter', 'linkedin', 'post', 'schedule', 'content'],
    pages: ['/social-media'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Social Media Management

Schedule and publish social media posts from DineOpen.

**To use:**
1. Go to **Social Media** (/social-media)
2. Connect your social accounts (Instagram, Twitter/X, LinkedIn)
3. Create a post:
   - Write caption
   - Add images
   - Select platforms to publish on
   - Schedule for a specific date/time or post immediately
4. View scheduled posts in the calendar
5. Track engagement (likes, comments, shares)

**AI-powered content:**
- Use AI to generate post captions
- Get content suggestions based on your menu and specials`,
    steps: [
      { action: 'Go to Social Media', page: '/social-media', element: 'Sidebar → More → Social Media' },
      { action: 'Connect social accounts', element: 'Connect buttons for each platform' },
      { action: 'Create and schedule post', element: 'New Post button' },
    ],
    relatedArticles: ['dineai-voice'],
  },

  {
    id: 'offers-discounts',
    title: 'Offers & Discounts',
    category: 'admin',
    keywords: ['offer', 'discount', 'coupon', 'promo', 'promotion', 'deal', 'discount code', 'percentage off', 'flat off'],
    pages: ['/offers', '/admin'],
    adminTab: 'offers',
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Offers & Discounts

**To create an offer:**
1. Go to **Offers** (/offers) or Admin Settings → **Offers** tab
2. Click **Create Offer**
3. Configure:
   - **Discount type**: Percentage (%) or Flat amount
   - **Value**: e.g., 10% or ₹100 off
   - **Applicable items**: All items, specific categories, or specific items
   - **Minimum order**: Minimum order value to apply
   - **Date range**: Start and end dates
   - **Usage limit**: Max uses per customer or total
   - **Coupon code** (optional): e.g., "WELCOME10"
4. Save and activate

**Applying during billing:**
- Staff clicks the Discount button on the cart
- Selects the offer or enters coupon code
- Discount is applied to eligible items

**Visibility:**
- Offers can be shown on the customer app (Crave)
- Or kept as staff-only (manual application)`,
    steps: [
      { action: 'Go to Offers', page: '/offers', element: 'Sidebar → More → Offers' },
      { action: 'Click Create Offer', element: 'Create Offer button' },
      { action: 'Configure discount rules', element: 'Offer form fields' },
      { action: 'Save and activate', element: 'Save button' },
    ],
    relatedArticles: ['billing-complete', 'loyalty-program'],
  },

  {
    id: 'feedback-forms',
    title: 'Customer Feedback Forms',
    category: 'admin',
    keywords: ['feedback', 'survey', 'review', 'rating', 'customer feedback', 'satisfaction', 'nps'],
    pages: ['/feedback'],
    roles: ['owner', 'admin', 'manager'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Customer Feedback Forms

Collect feedback from customers after their dining experience.

**To set up:**
1. Go to **Feedback** (/feedback) or Admin Settings → **Feedback** tab
2. Create a feedback form:
   - Add questions (rating, text, multiple choice)
   - Set form title and description
   - Choose when to show (after billing, via QR code, via link)
3. Save and activate

**How customers give feedback:**
- QR code on receipt or table tent — customers scan and fill the form
- Direct link shared via WhatsApp or SMS after billing
- Tablet at the exit for in-person feedback

**Viewing feedback:**
- Go to **Feedback** page to see all responses
- Filter by date, rating, or question
- View overall satisfaction scores and trends`,
    steps: [
      { action: 'Go to Feedback', page: '/feedback', element: 'Sidebar → More → Feedback' },
      { action: 'Create feedback form', element: 'Create Form button' },
      { action: 'Add questions', element: 'Question builder' },
      { action: 'View responses', element: 'Responses tab' },
    ],
    relatedArticles: ['customer-crm'],
  },

  {
    id: 'multi-location',
    title: 'Multi-Location (Headquarters)',
    category: 'admin',
    keywords: ['multi location', 'headquarters', 'chain', 'multiple restaurants', 'branch', 'outlet', 'franchise', 'hq'],
    pages: ['/headquarters'],
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Multi-Location (Headquarters)

Manage multiple restaurant locations from one account.

**To set up:**
1. Go to **Headquarters** (/headquarters)
2. View all your restaurant locations
3. Features:
   - **Unified dashboard** — Revenue, orders, and performance across all locations
   - **Shared menu** — Push menu changes to multiple locations
   - **Staff management** — Assign staff to specific locations
   - **Centralized reporting** — Compare performance across outlets
   - **Inventory sync** — Track stock across locations

**Adding a new location:**
1. Go to Admin Settings → **Restaurants** tab
2. Click **Add Restaurant**
3. Enter details for the new location
4. Choose shared or independent menu/settings
5. Assign staff

**Switching between locations:**
- Use the restaurant switcher in the sidebar header
- Each location has its own orders, tables, and billing
- Reports can be combined at headquarters level`,
    steps: [
      { action: 'Go to Headquarters', page: '/headquarters', element: 'Sidebar → More → Headquarters' },
      { action: 'View all locations', element: 'Location cards/list' },
      { action: 'Add location in Admin → Restaurants', page: '/admin', element: 'Restaurants tab → Add Restaurant' },
    ],
    relatedArticles: ['getting-started', 'invite-staff'],
  },

  {
    id: 'books-accounting',
    title: 'Books & Expense Tracking',
    category: 'analytics',
    keywords: ['books', 'accounting', 'expense', 'profit', 'loss', 'p&l', 'profit and loss', 'expense tracking', 'ledger', 'financial'],
    pages: ['/books'],
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Books & Expense Tracking

Track your restaurant's finances.

**To use:**
1. Go to **Books** (/books)
2. Features:
   - **Revenue overview** — Auto-tracked from completed orders
   - **Expense tracking** — Add expenses (rent, utilities, salaries, supplies)
   - **Profit & Loss** — Automatic P&L statement
   - **Category-wise expenses** — Organize by type
   - **Period reports** — Daily, weekly, monthly financial summaries
   - **Chart of accounts** — Standard accounting structure

**Adding an expense:**
1. Click **Add Expense**
2. Enter: Amount, category (rent, supplies, utilities, etc.), date, description
3. Attach receipt photo (optional)
4. Save

Revenue is auto-calculated from your order data. Expenses are manual entries. The P&L report combines both for a complete financial picture.`,
    steps: [
      { action: 'Go to Books', page: '/books', element: 'Sidebar → More → Books' },
      { action: 'View revenue overview', element: 'Revenue section' },
      { action: 'Add expenses', element: 'Add Expense button' },
      { action: 'View P&L report', element: 'P&L tab' },
    ],
    relatedArticles: ['sales-summary', 'analytics-dashboard'],
  },

  {
    id: 'automation-rules',
    title: 'Workflow Automation',
    category: 'admin',
    keywords: ['automation', 'workflow', 'rule', 'trigger', 'auto', 'automatic', 'notification'],
    pages: ['/automation'],
    roles: ['owner', 'admin'],
    platforms: ['web', 'electron', 'capacitor'],
    content: `## Workflow Automation

Set up rules to automate repetitive tasks.

**To create an automation:**
1. Go to **Automation** (/automation)
2. Click **Create Rule**
3. Set a **trigger** (when something happens):
   - New order placed
   - Order completed
   - Low stock detected
   - Customer birthday
   - End of shift
4. Set an **action** (what should happen):
   - Send notification to staff
   - Send WhatsApp message to customer
   - Print receipt
   - Update inventory
   - Apply discount
5. Set conditions (optional filters)
6. Save and activate

**Examples:**
- "When an order is completed, send a thank-you WhatsApp to the customer"
- "When inventory drops below minimum, notify the manager"
- "At 10 PM daily, send the day's sales summary to the owner"`,
    steps: [
      { action: 'Go to Automation', page: '/automation', element: 'Sidebar → More → Automation' },
      { action: 'Click Create Rule', element: 'Create Rule button' },
      { action: 'Set trigger and action', element: 'Rule builder form' },
      { action: 'Save and activate', element: 'Save button' },
    ],
    relatedArticles: ['features-toggle'],
  },
];


// ═══════════════════════════════════════════
// SEARCH ENGINE
// ═══════════════════════════════════════════

/**
 * Build a keyword-to-article index for fast lookup
 */
function buildIndex(articles) {
  const index = {};
  for (const article of articles) {
    for (const keyword of article.keywords) {
      const words = keyword.toLowerCase().split(/\s+/);
      for (const word of words) {
        if (!index[word]) index[word] = new Set();
        index[word].add(article.id);
      }
    }
    // Also index title words
    const titleWords = article.title.toLowerCase().split(/\s+/);
    for (const word of titleWords) {
      if (word.length > 2) {
        if (!index[word]) index[word] = new Set();
        index[word].add(article.id);
      }
    }
    // Index category
    if (!index[article.category]) index[article.category] = new Set();
    index[article.category].add(article.id);
  }
  return index;
}

const articleMap = {};
for (const a of articles) articleMap[a.id] = a;

const keywordIndex = buildIndex(articles);

/**
 * Search articles by query with context-aware scoring
 * @param {string} query - User's search query
 * @param {Object} context - { category, page, platform, role }
 * @returns {Array} Top 3 matching articles with content
 */
function searchArticles(query, context = {}) {
  if (!query) return [];

  const queryWords = query.toLowerCase().replace(/[?.,!'"]/g, '').split(/\s+/).filter(w => w.length > 1);
  const scores = {};

  // Score by keyword index matches
  for (const word of queryWords) {
    // Exact match
    if (keywordIndex[word]) {
      for (const articleId of keywordIndex[word]) {
        scores[articleId] = (scores[articleId] || 0) + 3;
      }
    }
    // Partial match (for words like "print" matching "printer")
    for (const [indexWord, articleIds] of Object.entries(keywordIndex)) {
      if (indexWord.startsWith(word) || word.startsWith(indexWord)) {
        for (const articleId of articleIds) {
          scores[articleId] = (scores[articleId] || 0) + 1;
        }
      }
    }
  }

  // Check full keyword phrase matches (higher score)
  const queryLower = query.toLowerCase();
  for (const article of articles) {
    for (const keyword of article.keywords) {
      if (queryLower.includes(keyword.toLowerCase())) {
        scores[article.id] = (scores[article.id] || 0) + 5;
      }
    }
  }

  // Context bonuses
  if (context.page) {
    for (const article of articles) {
      if (article.pages && article.pages.some(p => context.page.startsWith(p))) {
        scores[article.id] = (scores[article.id] || 0) + 4;
      }
    }
  }

  if (context.category) {
    for (const article of articles) {
      if (article.category === context.category) {
        scores[article.id] = (scores[article.id] || 0) + 3;
      }
    }
  }

  // Sort by score, take top 3
  const sorted = Object.entries(scores)
    .filter(([, score]) => score >= 3) // minimum relevance threshold
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return sorted.map(([articleId]) => {
    const article = articleMap[articleId];
    const result = {
      id: article.id,
      title: article.title,
      category: article.category,
      content: article.content,
      steps: article.steps || [],
      pages: article.pages || [],
      relatedArticles: article.relatedArticles || [],
    };

    // Add platform-specific notes if platform is known
    if (context.platform && article.platformNotes && article.platformNotes[context.platform]) {
      result.platformNote = article.platformNotes[context.platform];
    }

    // Add guide image if available
    if (article.guideImage) {
      result.guideImage = article.guideImage;
    }

    // Add admin tab info
    if (article.adminTab) {
      result.adminTab = article.adminTab;
    }

    return result;
  });
}

module.exports = {
  articles,
  searchArticles,
};
