/**
 * WhatsApp Ordering Conversation Service
 * Manages conversation state machine for WhatsApp-based food ordering
 * Uses Redis for session state, Firestore for persistent data
 */

const { getDb, collections } = require('../firebase');

// Conversation states
const STATES = {
  IDLE: 'idle',
  WELCOME: 'welcome',
  BROWSING_CATEGORIES: 'browsing_categories',
  BROWSING_ITEMS: 'browsing_items',
  ITEM_QUANTITY: 'item_quantity',
  CART_REVIEW: 'cart_review',
  COLLECT_NAME: 'collect_name',
  COLLECT_TABLE: 'collect_table',
  CONFIRM_ORDER: 'confirm_order',
  PAYMENT_PENDING: 'payment_pending',
  ORDER_PLACED: 'order_placed'
};

// In-memory session store (Redis can be plugged in later)
const sessions = new Map();

const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function getSession(phoneNumber, restaurantId) {
  const key = `${phoneNumber}:${restaurantId}`;
  const session = sessions.get(key);
  if (session && Date.now() - session.lastActivity > SESSION_TTL) {
    sessions.delete(key);
    return null;
  }
  return session || null;
}

function setSession(phoneNumber, restaurantId, data) {
  const key = `${phoneNumber}:${restaurantId}`;
  sessions.set(key, { ...data, lastActivity: Date.now() });
}

function clearSession(phoneNumber, restaurantId) {
  sessions.delete(`${phoneNumber}:${restaurantId}`);
}

/**
 * Get restaurant's WhatsApp ordering config
 */
async function getWhatsAppConfig(restaurantId) {
  const db = getDb();
  const doc = await db.collection('whatsappOrderingConfig').doc(restaurantId).get();
  return doc.exists ? doc.data() : null;
}

/**
 * Find restaurant by phone number ID (for incoming webhook routing)
 */
async function findRestaurantByPhoneNumberId(phoneNumberId) {
  const db = getDb();
  const snap = await db.collection('whatsappOrderingConfig')
    .where('phoneNumberId', '==', phoneNumberId)
    .where('enabled', '==', true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { restaurantId: snap.docs[0].id, config: snap.docs[0].data() };
}

/**
 * Get menu categories for a restaurant
 */
async function getMenuCategories(restaurantId) {
  const db = getDb();
  const snap = await db.collection(collections.menus)
    .where('restaurantId', '==', restaurantId)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => c.name);
}

/**
 * Get menu items for a category
 */
async function getMenuItemsByCategory(restaurantId, categoryId) {
  const db = getDb();
  const snap = await db.collection(collections.menuItems)
    .where('restaurantId', '==', restaurantId)
    .where('categoryId', '==', categoryId)
    .where('available', '==', true)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Get all available menu items
 */
async function getAllMenuItems(restaurantId) {
  const db = getDb();
  const snap = await db.collection(collections.menuItems)
    .where('restaurantId', '==', restaurantId)
    .where('available', '==', true)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Build WhatsApp list sections from categories
 */
function buildCategorySections(categories) {
  const rows = categories.slice(0, 10).map(cat => ({
    id: `cat_${cat.id}`,
    title: (cat.name || 'Category').substring(0, 24),
    description: cat.description ? cat.description.substring(0, 72) : undefined
  }));

  return [{
    title: 'Menu Categories',
    rows
  }];
}

/**
 * Build WhatsApp list sections from menu items
 */
function buildItemSections(items, currencySymbol = '₹') {
  const rows = items.slice(0, 10).map(item => ({
    id: `item_${item.id}`,
    title: (item.name || 'Item').substring(0, 24),
    description: `${currencySymbol}${item.price || 0}${item.description ? ' - ' + item.description.substring(0, 40) : ''}`.substring(0, 72)
  }));

  return [{
    title: 'Items',
    rows
  }];
}

/**
 * Build cart summary text
 */
function buildCartSummary(cart, currencySymbol = '₹') {
  if (!cart || cart.length === 0) return 'Your cart is empty.';

  let total = 0;
  const lines = cart.map((item, i) => {
    const subtotal = item.price * item.quantity;
    total += subtotal;
    return `${i + 1}. ${item.name} x${item.quantity} = ${currencySymbol}${subtotal}`;
  });

  lines.push('');
  lines.push(`*Total: ${currencySymbol}${total}*`);
  return lines.join('\n');
}

/**
 * Process incoming message and return response actions
 * Returns: { messages: [{ type, ...params }] }
 */
async function processMessage(phoneNumber, restaurantId, messageType, messageText, interactiveId) {
  const config = await getWhatsAppConfig(restaurantId);
  if (!config || !config.enabled) {
    return { messages: [{ type: 'text', text: 'Online ordering is currently unavailable. Please try again later.' }] };
  }

  const session = getSession(phoneNumber, restaurantId) || {
    state: STATES.IDLE,
    cart: [],
    customerName: '',
    tableNumber: '',
    selectedCategoryId: null
  };

  const currencySymbol = config.currencySymbol || '₹';
  const restaurantName = config.restaurantName || 'Restaurant';
  const welcomeMessage = config.welcomeMessage || `Welcome to *${restaurantName}*! 🍽️\n\nI can help you place an order. Browse our menu and add items to your cart.\n\nType *menu* to see our menu\nType *cart* to view your cart\nType *help* for more options`;

  const responses = [];
  const text = (messageText || '').trim().toLowerCase();

  // Global commands (work in any state)
  if (text === 'cancel' || text === 'restart' || text === 'start over') {
    clearSession(phoneNumber, restaurantId);
    responses.push({ type: 'text', text: `Order cancelled. ${welcomeMessage}` });
    return { messages: responses };
  }

  if (text === 'cart' || text === 'view cart') {
    if (session.cart.length === 0) {
      responses.push({ type: 'text', text: 'Your cart is empty. Type *menu* to browse our menu.' });
    } else {
      const summary = buildCartSummary(session.cart, currencySymbol);
      responses.push({
        type: 'interactive_button',
        text: `🛒 *Your Cart*\n\n${summary}`,
        buttons: [
          { id: 'btn_checkout', title: 'Checkout' },
          { id: 'btn_add_more', title: 'Add More' },
          { id: 'btn_clear_cart', title: 'Clear Cart' }
        ]
      });
    }
    return { messages: responses };
  }

  if (text === 'help') {
    responses.push({
      type: 'text',
      text: `*Available Commands:*\n\n📋 *menu* - Browse our menu\n🛒 *cart* - View your cart\n❌ *cancel* - Cancel and start over\n📞 *help* - Show this help\n\nYou can also just type an item name to search!`
    });
    return { messages: responses };
  }

  // State machine
  switch (session.state) {
    case STATES.IDLE: {
      // Any message in idle state = show welcome + menu
      if (text === 'menu' || text === 'hi' || text === 'hello' || text === 'hey' || text === 'start' || text === 'order' || messageType === 'text') {
        const categories = await getMenuCategories(restaurantId);

        if (categories.length === 0) {
          // No categories, show all items directly
          const items = await getAllMenuItems(restaurantId);
          if (items.length === 0) {
            responses.push({ type: 'text', text: `${welcomeMessage}\n\nSorry, our menu is currently empty. Please check back later.` });
          } else {
            responses.push({ type: 'text', text: welcomeMessage });
            responses.push({
              type: 'list',
              headerText: '📋 Our Menu',
              bodyText: 'Select an item to add to your cart:',
              buttonText: 'View Menu',
              sections: buildItemSections(items, currencySymbol)
            });
            session.state = STATES.BROWSING_ITEMS;
            session.availableItems = items;
          }
        } else {
          responses.push({ type: 'text', text: welcomeMessage });
          responses.push({
            type: 'list',
            headerText: '📋 Menu Categories',
            bodyText: 'Select a category to browse items:',
            buttonText: 'Browse Menu',
            sections: buildCategorySections(categories)
          });
          session.state = STATES.BROWSING_CATEGORIES;
          session.categories = categories;
        }
      }
      break;
    }

    case STATES.BROWSING_CATEGORIES: {
      let categoryId = null;
      if (interactiveId && interactiveId.startsWith('cat_')) {
        categoryId = interactiveId.replace('cat_', '');
      }

      if (categoryId) {
        const items = await getMenuItemsByCategory(restaurantId, categoryId);
        if (items.length === 0) {
          responses.push({ type: 'text', text: 'No items available in this category. Please choose another.' });
          // Re-show categories
          const categories = await getMenuCategories(restaurantId);
          responses.push({
            type: 'list',
            headerText: '📋 Menu Categories',
            bodyText: 'Select a category to browse items:',
            buttonText: 'Browse Menu',
            sections: buildCategorySections(categories)
          });
        } else {
          const category = (session.categories || []).find(c => c.id === categoryId);
          responses.push({
            type: 'list',
            headerText: `📋 ${(category?.name || 'Items').substring(0, 40)}`,
            bodyText: 'Select an item to add to your cart:',
            footerText: 'Reply "menu" for categories, "cart" for cart',
            buttonText: 'View Items',
            sections: buildItemSections(items, currencySymbol)
          });
          session.state = STATES.BROWSING_ITEMS;
          session.availableItems = items;
          session.selectedCategoryId = categoryId;
        }
      } else if (text === 'menu') {
        const categories = await getMenuCategories(restaurantId);
        responses.push({
          type: 'list',
          headerText: '📋 Menu Categories',
          bodyText: 'Select a category:',
          buttonText: 'Browse Menu',
          sections: buildCategorySections(categories)
        });
      } else {
        responses.push({ type: 'text', text: 'Please select a category from the menu, or type *menu* to see categories again.' });
      }
      break;
    }

    case STATES.BROWSING_ITEMS: {
      let itemId = null;
      if (interactiveId && interactiveId.startsWith('item_')) {
        itemId = interactiveId.replace('item_', '');
      }

      if (itemId) {
        const item = (session.availableItems || []).find(i => i.id === itemId);
        if (item) {
          session.pendingItem = item;
          session.state = STATES.ITEM_QUANTITY;
          responses.push({
            type: 'text',
            text: `*${item.name}* - ${currencySymbol}${item.price}\n${item.description || ''}\n\nHow many would you like? (Enter a number, e.g. 1, 2, 3)`
          });
        } else {
          responses.push({ type: 'text', text: 'Item not found. Please select from the menu.' });
        }
      } else if (text === 'menu' || text === 'back') {
        session.state = STATES.BROWSING_CATEGORIES;
        const categories = await getMenuCategories(restaurantId);
        responses.push({
          type: 'list',
          headerText: '📋 Menu Categories',
          bodyText: 'Select a category:',
          buttonText: 'Browse Menu',
          sections: buildCategorySections(categories)
        });
      } else {
        responses.push({ type: 'text', text: 'Please select an item from the list, type *menu* to go back, or *cart* to view your cart.' });
      }
      break;
    }

    case STATES.ITEM_QUANTITY: {
      const qty = parseInt(text);
      if (isNaN(qty) || qty < 1 || qty > 50) {
        responses.push({ type: 'text', text: 'Please enter a valid quantity (1-50):' });
      } else {
        const item = session.pendingItem;
        // Check if item already in cart, update quantity
        const existing = session.cart.find(c => c.id === item.id);
        if (existing) {
          existing.quantity += qty;
        } else {
          session.cart.push({
            id: item.id,
            name: item.name,
            price: item.price,
            quantity: qty,
            categoryId: item.categoryId
          });
        }
        session.pendingItem = null;

        const summary = buildCartSummary(session.cart, currencySymbol);
        responses.push({
          type: 'interactive_button',
          text: `✅ Added *${qty}x ${item.name}* to cart!\n\n🛒 *Your Cart:*\n${summary}`,
          buttons: [
            { id: 'btn_checkout', title: 'Checkout' },
            { id: 'btn_add_more', title: 'Add More' },
            { id: 'btn_clear_cart', title: 'Clear Cart' }
          ]
        });
        session.state = STATES.CART_REVIEW;
      }
      break;
    }

    case STATES.CART_REVIEW: {
      if (interactiveId === 'btn_checkout' || text === 'checkout' || text === 'done') {
        if (session.cart.length === 0) {
          responses.push({ type: 'text', text: 'Your cart is empty. Type *menu* to browse.' });
          session.state = STATES.IDLE;
        } else {
          session.state = STATES.COLLECT_NAME;
          responses.push({ type: 'text', text: 'Great! Please enter your *name* for the order:' });
        }
      } else if (interactiveId === 'btn_add_more' || text === 'add' || text === 'more') {
        session.state = STATES.BROWSING_CATEGORIES;
        const categories = await getMenuCategories(restaurantId);
        if (categories.length === 0) {
          const items = await getAllMenuItems(restaurantId);
          session.state = STATES.BROWSING_ITEMS;
          session.availableItems = items;
          responses.push({
            type: 'list',
            headerText: '📋 Our Menu',
            bodyText: 'Select more items:',
            buttonText: 'View Menu',
            sections: buildItemSections(items, currencySymbol)
          });
        } else {
          responses.push({
            type: 'list',
            headerText: '📋 Menu Categories',
            bodyText: 'Select a category:',
            buttonText: 'Browse Menu',
            sections: buildCategorySections(categories)
          });
        }
      } else if (interactiveId === 'btn_clear_cart' || text === 'clear') {
        session.cart = [];
        session.state = STATES.IDLE;
        responses.push({ type: 'text', text: 'Cart cleared. Type *menu* to start fresh.' });
      } else {
        responses.push({ type: 'text', text: 'Please choose: *checkout*, *add more*, or *clear cart*.' });
      }
      break;
    }

    case STATES.COLLECT_NAME: {
      if (text.length < 1 || text.length > 100) {
        responses.push({ type: 'text', text: 'Please enter a valid name:' });
      } else {
        session.customerName = messageText.trim();
        if (config.requireTableNumber) {
          session.state = STATES.COLLECT_TABLE;
          responses.push({ type: 'text', text: `Thanks ${session.customerName}! Please enter your *table number*:` });
        } else {
          session.state = STATES.CONFIRM_ORDER;
          const summary = buildCartSummary(session.cart, currencySymbol);
          responses.push({
            type: 'interactive_button',
            text: `📋 *Order Summary*\n\n👤 Name: ${session.customerName}\n📱 Phone: ${phoneNumber}\n\n${summary}\n\nPlease confirm your order:`,
            buttons: [
              { id: 'btn_confirm', title: 'Confirm Order' },
              { id: 'btn_edit', title: 'Edit Order' }
            ]
          });
        }
      }
      break;
    }

    case STATES.COLLECT_TABLE: {
      session.tableNumber = messageText.trim();
      session.state = STATES.CONFIRM_ORDER;
      const summary = buildCartSummary(session.cart, currencySymbol);
      responses.push({
        type: 'interactive_button',
        text: `📋 *Order Summary*\n\n👤 Name: ${session.customerName}\n📱 Phone: ${phoneNumber}\n🪑 Table: ${session.tableNumber}\n\n${summary}\n\nPlease confirm your order:`,
        buttons: [
          { id: 'btn_confirm', title: 'Confirm Order' },
          { id: 'btn_edit', title: 'Edit Order' }
        ]
      });
      break;
    }

    case STATES.CONFIRM_ORDER: {
      if (interactiveId === 'btn_confirm' || text === 'confirm' || text === 'yes') {
        // Create the order
        const order = await createWhatsAppOrder(restaurantId, phoneNumber, session, config);
        if (order.success) {
          const paymentInfo = config.paymentMode === 'pay_at_counter'
            ? '\n💳 Please pay at the counter when your order is ready.'
            : config.paymentLink
              ? `\n💳 Pay online: ${config.paymentLink}`
              : '\n💳 Please pay at the counter.';

          responses.push({
            type: 'text',
            text: `✅ *Order Placed Successfully!*\n\n🔢 Order #${order.orderNumber}\n${buildCartSummary(session.cart, currencySymbol)}${paymentInfo}\n\nYou'll receive updates on your order status. Thank you! 🙏`
          });
          clearSession(phoneNumber, restaurantId);
        } else {
          responses.push({ type: 'text', text: `Sorry, there was an error placing your order: ${order.error}. Please try again or contact the restaurant.` });
        }
      } else if (interactiveId === 'btn_edit' || text === 'edit' || text === 'no') {
        session.state = STATES.CART_REVIEW;
        const summary = buildCartSummary(session.cart, currencySymbol);
        responses.push({
          type: 'interactive_button',
          text: `🛒 *Your Cart:*\n${summary}`,
          buttons: [
            { id: 'btn_checkout', title: 'Checkout' },
            { id: 'btn_add_more', title: 'Add More' },
            { id: 'btn_clear_cart', title: 'Clear Cart' }
          ]
        });
      } else {
        responses.push({ type: 'text', text: 'Please *confirm* or *edit* your order.' });
      }
      break;
    }

    default:
      session.state = STATES.IDLE;
      responses.push({ type: 'text', text: welcomeMessage });
  }

  // Save session
  setSession(phoneNumber, restaurantId, session);

  return { messages: responses };
}

/**
 * Create an order in Firestore from WhatsApp conversation
 */
async function createWhatsAppOrder(restaurantId, phoneNumber, session, config) {
  try {
    const db = getDb();
    const now = new Date();
    const orderNumber = `WA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;

    let totalAmount = 0;
    const items = session.cart.map(item => {
      const subtotal = item.price * item.quantity;
      totalAmount += subtotal;
      return {
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity,
        subtotal,
        categoryId: item.categoryId || null
      };
    });

    const orderData = {
      restaurantId,
      orderNumber,
      dailyOrderId: orderNumber,
      items,
      totalAmount,
      subtotal: totalAmount,
      tax: 0,
      discount: 0,
      status: 'pending',
      orderType: 'whatsapp',
      source: 'whatsapp',
      customerName: session.customerName || '',
      customerPhone: phoneNumber,
      tableNumber: session.tableNumber || '',
      paymentStatus: 'unpaid',
      paymentMethod: config.paymentMode || 'pay_at_counter',
      notes: `WhatsApp Order from ${phoneNumber}`,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null
    };

    const orderRef = await db.collection(collections.orders).add(orderData);

    // Trigger real-time notification
    try {
      const pusherService = require('./pusherService');
      await pusherService.notifyOrderCreated(restaurantId, {
        id: orderRef.id,
        orderNumber,
        status: 'pending',
        totalAmount,
        tableNumber: session.tableNumber || '',
        orderType: 'whatsapp'
      });
    } catch (e) {
      console.error('Pusher notification error (non-blocking):', e.message);
    }

    // Log the WhatsApp order
    try {
      await db.collection('whatsappOrderLogs').add({
        restaurantId,
        orderId: orderRef.id,
        orderNumber,
        phoneNumber,
        customerName: session.customerName,
        totalAmount,
        itemCount: items.length,
        createdAt: now.toISOString()
      });
    } catch (e) {
      console.error('WhatsApp order log error (non-blocking):', e.message);
    }

    return { success: true, orderId: orderRef.id, orderNumber };
  } catch (error) {
    console.error('Error creating WhatsApp order:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  STATES,
  processMessage,
  getWhatsAppConfig,
  findRestaurantByPhoneNumberId,
  createWhatsAppOrder,
  getSession,
  setSession,
  clearSession
};
