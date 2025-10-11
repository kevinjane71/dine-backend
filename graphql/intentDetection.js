// Intent-based query generation for DineBot
// This reduces ChatGPT token usage by 90%+

const INTENT_PATTERNS = {
  // Order Management
  'PLACE_ORDER': {
    keywords: ['order', 'place order', 'create order', 'add order', 'book order'],
    examples: ['place order for pizza', 'order 2 burgers', 'create order for table 5']
  },
  'UPDATE_ORDER': {
    keywords: ['update order', 'modify order', 'change order', 'edit order'],
    examples: ['update order ORD-123', 'modify my order', 'change order items']
  },
  'CANCEL_ORDER': {
    keywords: ['cancel order', 'delete order', 'remove order'],
    examples: ['cancel order ORD-123', 'delete my order', 'remove order']
  },
  'COMPLETE_ORDER': {
    keywords: ['complete order', 'finish order', 'ready order'],
    examples: ['complete order ORD-123', 'mark order as ready', 'finish order']
  },
  
  // Table Management
  'CREATE_TABLE': {
    keywords: ['add table', 'create table', 'new table'],
    examples: ['add table 5', 'create table with capacity 6', 'new table on first floor']
  },
  'DELETE_TABLE': {
    keywords: ['delete table', 'remove table'],
    examples: ['delete table 5', 'remove table 2']
  },
  'BOOK_TABLE': {
    keywords: ['book table', 'reserve table', 'table reservation'],
    examples: ['book table 3', 'reserve table for John', 'table reservation']
  },
  'TABLE_STATUS': {
    keywords: ['table status', 'table info', 'show table', 'table details'],
    examples: ['table status 2', 'show table 5', 'table info']
  },
  
  // Analytics & Reports
  'REVENUE_QUERY': {
    keywords: ['revenue', 'sales', 'income', 'money', 'earnings'],
    examples: ['today revenue', 'monthly sales', 'total income']
  },
  'ORDER_COUNT': {
    keywords: ['orders', 'order count', 'how many orders'],
    examples: ['orders today', 'order count', 'how many orders']
  },
  'CUSTOMER_COUNT': {
    keywords: ['customers', 'customer count', 'how many customers'],
    examples: ['customers today', 'customer count', 'how many customers']
  },
  
  // Menu Management
  'ADD_MENU_ITEM': {
    keywords: ['add menu', 'create menu', 'new menu item'],
    examples: ['add pizza to menu', 'create new burger', 'add menu item']
  },
  'DELETE_MENU_ITEM': {
    keywords: ['delete menu', 'remove menu', 'delete item'],
    examples: ['delete pizza from menu', 'remove burger', 'delete menu item']
  },
  
  // Inventory
  'INVENTORY_STATUS': {
    keywords: ['inventory', 'stock', 'low stock'],
    examples: ['inventory status', 'stock levels', 'low stock items']
  },
  
  // General Queries
  'SHOW_TABLES': {
    keywords: ['show tables', 'all tables', 'list tables'],
    examples: ['show all tables', 'list tables', 'tables']
  },
  'SHOW_ORDERS': {
    keywords: ['show orders', 'all orders', 'list orders'],
    examples: ['show all orders', 'list orders', 'orders']
  }
};

// Lightweight intent detection using ChatGPT (minimal tokens)
async function detectIntent(userQuery, conversationContext = null) {
  const openai = require('openai');
  
  const client = new openai.OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Minimal prompt for intent detection
  const prompt = `
You are an intent classifier for a restaurant management system.

User Query: "${userQuery}"

${conversationContext ? `Context: ${JSON.stringify(conversationContext)}` : ''}

Classify this query into ONE of these intents:
${Object.keys(INTENT_PATTERNS).map(intent => `- ${intent}`).join('\n')}

Respond with ONLY the intent name (e.g., PLACE_ORDER). If unclear, respond with UNKNOWN.`;

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 20,
      temperature: 0.1,
    });

    const intent = completion.choices[0].message.content.trim();
    return Object.keys(INTENT_PATTERNS).includes(intent) ? intent : 'UNKNOWN';
  } catch (error) {
    console.error('Intent detection error:', error);
    return 'UNKNOWN';
  }
}

// Server-side query generation based on intent
function generateQueryFromIntent(intent, userQuery, restaurantId, conversationContext = null) {
  const queryPatterns = {
    'PLACE_ORDER': () => {
      // Extract order details from query
      const tableMatch = userQuery.match(/table\s+(\d+)/i);
      const phoneMatch = userQuery.match(/(\d{10})/);
      const itemMatch = userQuery.match(/(?:order|for)\s+([^0-9]+?)(?:\s+\d+|\s+item|$)/i);
      
      let tableNumber = tableMatch ? tableMatch[1] : null;
      let customerPhone = phoneMatch ? phoneMatch[1] : null;
      let itemName = itemMatch ? itemMatch[1].trim() : null;
      
      // Use conversation context if available
      if (conversationContext) {
        tableNumber = tableNumber || conversationContext.lastTableNumber;
        customerPhone = customerPhone || conversationContext.lastCustomerPhone;
      }
      
      // For now, return a template - we'll need to map item names to IDs
      return {
        type: 'mutation',
        name: 'createOrder',
        variables: { restaurantId },
        input: {
          tableNumber,
          customer: customerPhone ? { phone: customerPhone } : null,
          items: [{ menuItemId: 'DYNAMIC_ITEM_ID', quantity: 1 }], // Will be resolved
          paymentMethod: 'CASH',
          restaurantId: '$restaurantId'
        },
        fields: ['id', 'orderNumber', 'totalAmount', 'status']
      };
    },
    
    'TABLE_STATUS': () => ({
      type: 'query',
      name: 'tables',
      variables: { restaurantId },
      filters: {},
      fields: ['id', 'name', 'floor', 'capacity', 'status']
    }),
    
    'SHOW_TABLES': () => ({
      type: 'query',
      name: 'tables',
      variables: { restaurantId },
      filters: {},
      fields: ['id', 'name', 'floor', 'capacity', 'status']
    }),
    
    'SHOW_ORDERS': () => {
      // Check if user wants today's orders
      const todayMatch = userQuery.match(/today|todays/i);
      const dateRange = todayMatch ? 'today' : null;
      
      return {
        type: 'query',
        name: 'orderHistory',
        variables: { restaurantId },
        filters: dateRange ? { dateRange } : {},
        fields: ['id', 'orderNumber', 'totalAmount', 'status', 'createdAt', 'customer { name phone }', 'tableNumber']
      };
    },
    
    'REVENUE_QUERY': () => ({
      type: 'query',
      name: 'orderHistory',
      variables: { restaurantId },
      filters: { dateRange: 'today' },
      fields: ['totalAmount']
    }),
    
    'ORDER_COUNT': () => ({
      type: 'query',
      name: 'orderHistory',
      variables: { restaurantId },
      filters: { dateRange: 'today' },
      fields: ['id']
    })
  };

  const generator = queryPatterns[intent];
  return generator ? generator() : null;
}

// Resolve dynamic values (like menu item IDs)
async function resolveDynamicValues(queryTemplate, userQuery, db, restaurantId) {
  if (!queryTemplate) return null;
  
  // If it's an order creation, resolve menu item ID
  if (queryTemplate.name === 'createOrder') {
    const itemMatch = userQuery.match(/(?:order|for)\s+([^0-9]+?)(?:\s+\d+|\s+item|$)/i);
    if (itemMatch) {
      const itemName = itemMatch[1].trim();
      
      // Get menu items from database
      const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
      if (restaurantDoc.exists) {
        const restaurantData = restaurantDoc.data();
        if (restaurantData.menu && restaurantData.menu.items) {
          const menuItem = restaurantData.menu.items.find(item => 
            item.name.toLowerCase().includes(itemName.toLowerCase()) ||
            itemName.toLowerCase().includes(item.name.toLowerCase())
          );
          
          if (menuItem) {
            queryTemplate.input.items[0].menuItemId = menuItem.id;
          }
        }
      }
    }
  }
  
  return queryTemplate;
}

// Convert query template to GraphQL string
function templateToGraphQL(queryTemplate) {
  if (!queryTemplate) return null;
  
  const { type, name, variables, filters, input, fields } = queryTemplate;
  
  let query = '';
  
  if (type === 'query') {
    const varDeclarations = Object.keys(variables).map(key => `$${key}: ID!`).join(', ');
    const filterParams = Object.keys(filters).map(key => `${key}: "${filters[key]}"`).join(', ');
    const fieldList = fields.join(' ');
    
    query = `query ${name.charAt(0).toUpperCase() + name.slice(1)}(${varDeclarations}) {
  ${name}(${Object.keys(variables).map(key => `${key}: $${key}`).join(', ')}, ${filterParams}) {
    ${fieldList}
  }
}`;
  } else if (type === 'mutation') {
    const varDeclarations = Object.keys(variables).map(key => `$${key}: ID!`).join(', ');
    const fieldList = fields.join(' ');
    
    query = `mutation ${name.charAt(0).toUpperCase() + name.slice(1)}(${varDeclarations}) {
  ${name}(input: {
    ${Object.entries(input).map(([key, value]) => {
      if (value === null) return `${key}: null`;
      if (typeof value === 'string' && value.startsWith('$')) return `${key}: ${value}`;
      if (Array.isArray(value)) return `${key}: ${JSON.stringify(value)}`;
      if (typeof value === 'object') return `${key}: ${JSON.stringify(value)}`;
      return `${key}: ${JSON.stringify(value)}`;
    }).join('\n    ')}
  }) {
    ${fieldList}
  }
}`;
  }
  
  return query;
}

module.exports = {
  detectIntent,
  generateQueryFromIntent,
  resolveDynamicValues,
  templateToGraphQL,
  INTENT_PATTERNS
};
