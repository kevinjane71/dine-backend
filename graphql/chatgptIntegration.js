const OpenAI = require('openai');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Generate dynamic GraphQL schema for ChatGPT by introspecting the actual GraphQL schema
async function generateGraphQLSchemaForChatGPT(db) {
  try {
    // Extract collections and their fields from the database
    const collections = await getDatabaseCollections(db);
    
    // Build dynamic schema description based on actual database structure
    let schemaDescription = `DYNAMIC GRAPHQL SCHEMA FOR RESTAURANT MANAGEMENT SYSTEM
Generated at: ${new Date().toISOString()}

AVAILABLE COLLECTIONS IN DATABASE:
${collections && collections.length > 0 ? collections.map(col => `- ${col.name}: ${col.fields.slice(0, 10).join(', ')}${col.fields.length > 10 ? '...' : ''}`).join('\n') : 'No collections found'}

GRAPHQL QUERIES AVAILABLE:
- restaurant(restaurantId: ID!): Restaurant
- tables(restaurantId: ID!, status: TableStatus, floor: String): [Table!]!
- table(id: ID!): Table
- orders(restaurantId: ID!, status: OrderStatus, tableNumber: String, waiterId: String): [Order!]!
- order(id: ID!): Order
- orderHistory(restaurantId: ID!, customerId: String, dateRange: String): [Order!]!
- customers(restaurantId: ID!, search: String): [Customer!]!
- customer(id: ID!): Customer
- menu(restaurantId: ID!, category: String, isAvailable: Boolean): Menu
- inventory(restaurantId: ID!, category: InventoryCategory, lowStock: Boolean): [InventoryItem!]!
- analytics(restaurantId: ID!, period: String!, dateRange: String): Analytics
- staff(restaurantId: ID!, role: UserRole): [Staff!]!
- invoices(restaurantId: ID!, orderId: String, dateRange: String): [Invoice!]!
- feedback(restaurantId: ID!, category: FeedbackCategory, rating: Int): [Feedback!]!
- systemInfo: SystemInfo
- userPermissions(userId: ID!, restaurantId: ID!): UserPermissions

GRAPHQL MUTATIONS AVAILABLE:
- createTable(input: CreateTableInput!): Table!
- updateTable(id: ID!, input: UpdateTableInput!): Table!
- updateTableStatus(id: ID!, status: TableStatus!): Table!
- deleteTable(id: ID!): Boolean!
- bookTable(input: BookTableInput!): Table!
- createCustomer(input: CreateCustomerInput!): Customer!
- updateCustomer(id: ID!, input: UpdateCustomerInput!): Customer!
- deleteCustomer(id: ID!): Boolean!
- createOrder(input: CreateOrderInput!): Order!
- updateOrder(id: ID!, input: UpdateOrderInput!): Order!
- updateOrderStatus(id: ID!, status: OrderStatus!): Order!
- updateOrderItems(id: ID!, items: [OrderItemInput!]!): Order!
- cancelOrder(id: ID!, reason: String): Order!
- completeOrder(id: ID!): Order!
- processPayment(input: PaymentInput!): Order!
- searchOrders(restaurantId: ID!, searchTerm: String!): [Order!]!
- createMenuItem(input: CreateMenuItemInput!): MenuItem!
- updateMenuItem(id: ID!, input: UpdateMenuItemInput!): MenuItem!
- deleteMenuItem(id: ID!): Boolean!
- createInventoryItem(input: CreateInventoryInput!): InventoryItem!
- updateInventoryItem(id: ID!, input: UpdateInventoryInput!): InventoryItem!
- updateStock(id: ID!, quantity: Float!, operation: String!): InventoryItem!
- deleteInventoryItem(id: ID!): Boolean!
- updateRestaurantSettings(input: RestaurantSettingsInput!): Restaurant!
- logout: Boolean!
- generateReport(type: String!, period: String!): Report!

ENUMS AVAILABLE:
- OrderStatus: PENDING, PREPARING, READY, COMPLETED, CANCELLED
- TableStatus: AVAILABLE, OCCUPIED, RESERVED, CLEANING, MAINTENANCE, SERVING
- PaymentMethod: CASH, CARD, UPI, ONLINE
- PaymentStatus: PENDING, COMPLETED, FAILED, REFUNDED
- UserRole: OWNER, MANAGER, ADMIN, STAFF, WAITER
- InventoryCategory: VEGETABLES, MEAT, DAIRY, SPICES, BEVERAGES, PACKAGED, OTHER

INPUT TYPES AVAILABLE:
- CreateTableInput: { name: String!, floor: String!, capacity: Int, section: String, restaurantId: ID! }
- UpdateTableInput: { name: String, floor: String, capacity: Int, section: String, status: TableStatus }
- BookTableInput: { tableId: ID!, customerName: String!, customerPhone: String!, bookingDate: String!, bookingTime: String!, partySize: Int!, notes: String }
- CreateCustomerInput: { name: String, phone: String, email: String, city: String, address: String, dob: Date, restaurantId: ID! }
- UpdateCustomerInput: { name: String, phone: String, email: String, city: String, address: String, dob: Date }
- CreateOrderInput: { tableNumber: String, customer: CustomerInput, items: [OrderItemInput!]!, notes: String, paymentMethod: PaymentMethod, restaurantId: ID! }
- UpdateOrderInput: { tableNumber: String, items: [OrderItemInput!], notes: String, paymentMethod: PaymentMethod, customerInfo: CustomerInput }
- PaymentInput: { orderId: ID!, paymentMethod: PaymentMethod!, amount: Float!, transactionId: String, notes: String }
- CreateMenuItemInput: { name: String!, price: Float!, category: String!, description: String, shortCode: String, isVeg: Boolean, isAvailable: Boolean, image: String, preparationTime: Int, ingredients: [String], allergens: [String], restaurantId: ID! }
- CreateInventoryInput: { name: String!, category: InventoryCategory!, unit: String!, currentStock: Float, minStock: Float, maxStock: Float, costPerUnit: Float, supplierId: String, location: String, barcode: String, expiryDate: Date, restaurantId: ID! }

ACTUAL DATABASE STRUCTURE:
${collections && collections.length > 0 ? collections.map(col => {
  if (col.name === 'restaurants' && col.sampleData.menu?.items) {
    const menuItems = col.sampleData.menu.items.slice(0, 10).map(item => 
      `- ${item.name} (ID: ${item.id})`
    ).join('\n');
    return `
Collection: ${col.name}
Fields: ${col.fields.join(', ')}
Menu Items (first 10):
${menuItems}
Sample Data: ${JSON.stringify(col.sampleData, null, 2).substring(0, 200)}...
`;
  } else if (col.name === 'tables') {
    // Handle tables collection - sampleData might be an object or array
    let tables = [];
    if (Array.isArray(col.sampleData)) {
      tables = col.sampleData.slice(0, 10).map(table => 
        `- Table ${table.name} (ID: ${table.id}) - Floor: ${table.floor}, Capacity: ${table.capacity}, Status: ${table.status}`
      ).join('\n');
    } else if (col.sampleData && typeof col.sampleData === 'object') {
      // If it's a single table object
      tables = `- Table ${col.sampleData.name} (ID: ${col.sampleData.id}) - Floor: ${col.sampleData.floor}, Capacity: ${col.sampleData.capacity}, Status: ${col.sampleData.status}`;
    }
    return `
Collection: ${col.name}
Fields: ${col.fields.join(', ')}
Tables:
${tables}
Sample Data: ${JSON.stringify(col.sampleData, null, 2).substring(0, 200)}...
`;
  }
  return `
Collection: ${col.name}
Fields: ${col.fields.join(', ')}
Sample Data: ${JSON.stringify(col.sampleData, null, 2).substring(0, 200)}...
`;
}).join('\n') : 'No database collections available'}

SECURITY CONSTRAINTS:
- ALL queries MUST include restaurantId parameter
- Users can ONLY access their own restaurant data
- DELETE operations require OWNER or MANAGER role
- UPDATE operations require WRITE permissions
- READ operations require READ permissions
- System operations require appropriate role permissions

DATE FILTERS:
- today: Current day
- this_week: Current week  
- this_month: Current month
- this_year: Current year
- yesterday: Previous day
- last_week: Previous week
- last_month: Previous month
- last_year: Previous year

EXAMPLES:
User: "Show me today's revenue"
Query: query GetTodayRevenue($restaurantId: ID!) { orderHistory(restaurantId: $restaurantId, dateRange: "today") { totalAmount } }

User: "How many orders today?"
Query: query GetOrdersToday($restaurantId: ID!) { orderHistory(restaurantId: $restaurantId, dateRange: "today") { id } }

User: "What's our revenue today?"
Query: query GetRevenueToday($restaurantId: ID!) { orderHistory(restaurantId: $restaurantId, dateRange: "today") { totalAmount } }

User: "Add table 5 with capacity 6"
Mutation: mutation CreateTable($restaurantId: ID!) { createTable(input: { name: "5", capacity: 6, floor: "Ground Floor", restaurantId: $restaurantId }) { id name capacity } }

User: "Add tables 1 to 10 on first floor"
Mutation: mutation CreateMultipleTables($restaurantId: ID!) { 
  createTable(input: { name: "1", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "2", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "3", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "4", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "5", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "6", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "7", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "8", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "9", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
  createTable(input: { name: "10", capacity: 4, floor: "First Floor", restaurantId: $restaurantId }) { id name }
}

User: "Delete table 2"
Mutation: mutation DeleteTable { deleteTable(id: "CxRQgSrmdi3IihPyJDA0") }

User: "Book table 3 for John with phone 9876543210 for today at 7 PM"
Mutation: mutation BookTable { bookTable(input: { tableId: "CxRQgSrmdi3IihPyJDA0", customerName: "John", customerPhone: "9876543210", bookingDate: "2025-01-11", bookingTime: "19:00", partySize: 4 }) { id name status bookingInfo { customerName bookingTime } } }

User: "Show me all available tables"
Query: query GetAvailableTables($restaurantId: ID!) { tables(restaurantId: $restaurantId, status: AVAILABLE) { id name floor capacity status } }

User: "Show me all occupied tables"
Query: query GetOccupiedTables($restaurantId: ID!) { tables(restaurantId: $restaurantId, status: OCCUPIED) { id name floor capacity status } }

User: "What is the status of table 2?"
Query: query GetTableStatus($restaurantId: ID!) { tables(restaurantId: $restaurantId) { id name status } }

User: "Show me all pending orders"
Query: query GetPendingOrders($restaurantId: ID!) { orders(restaurantId: $restaurantId, status: PENDING) { id orderNumber items { name quantity } totalAmount } }

User: "Search for order by table 5"
Query: query SearchOrders($restaurantId: ID!) { searchOrders(restaurantId: $restaurantId, searchTerm: "5") { id orderNumber tableNumber customerInfo { name phone } totalAmount status } }

User: "Place order for Pizza Al Greco 1 item for customer name Rahul"
Mutation: mutation CreateOrder($restaurantId: ID!) { createOrder(input: { tableNumber: null, customer: { name: "Rahul" }, items: [{ menuItemId: "item_1760095528480_2fwuof8bm", quantity: 1 }], paymentMethod: CASH, restaurantId: $restaurantId }) { id orderNumber totalAmount status } }

User: "Place express billing order for Pizza Al Greco 1 item for customer Rahul"
Mutation: mutation CreateOrder($restaurantId: ID!) { createOrder(input: { tableNumber: null, customer: { name: "Rahul" }, items: [{ menuItemId: "item_1760095528480_2fwuof8bm", quantity: 1 }], paymentMethod: CASH, expressBilling: true, restaurantId: $restaurantId }) { id orderNumber totalAmount status paymentStatus } }

User: "Order 2 Delhi burgers for table 5"
Mutation: mutation CreateOrder($restaurantId: ID!) { createOrder(input: { tableNumber: "5", items: [{ menuItemId: "item_1760095528480_1260qx7pp", quantity: 2 }], paymentMethod: CASH, restaurantId: $restaurantId }) { id orderNumber totalAmount status } }

User: "Create order for customer John with phone 9876543210 for 1 pizza"
Mutation: mutation CreateOrder($restaurantId: ID!) { createOrder(input: { customer: { name: "John", phone: "9876543210" }, items: [{ menuItemId: "item_1760095528480_2fwuof8bm", quantity: 1 }], paymentMethod: CASH, restaurantId: $restaurantId }) { id orderNumber totalAmount status } }

User: "Place order for table 3 with 1 pizza and 2 drinks"
Mutation: mutation CreateOrder($restaurantId: ID!) { createOrder(input: { tableNumber: "3", items: [{ menuItemId: "item_1760095528480_2fwuof8bm", quantity: 1 }, { menuItemId: "item_1760095528480_q55ee4kqt", quantity: 2 }], paymentMethod: CASH, restaurantId: $restaurantId }) { id orderNumber totalAmount status } }

User: "Update order items for order ORD-123"
Mutation: mutation UpdateOrderItems { updateOrderItems(id: "ORD-123", items: [{ menuItemId: "item_1759918044546_nhgoqwlwb", quantity: 2 }]) { id items { name quantity } totalAmount } }

User: "Cancel order ORD-123 because customer left"
Mutation: mutation CancelOrder { cancelOrder(id: "ORD-123", reason: "Customer left") { id status cancellationReason } }

User: "Complete order ORD-123"
Mutation: mutation CompleteOrder { completeOrder(id: "ORD-123") { id status completedAt } }

User: "Process payment for order ORD-123 with cash 500"
Mutation: mutation ProcessPayment { processPayment(input: { orderId: "ORD-123", paymentMethod: CASH, amount: 500 }) { id paymentInfo { paymentMethod amount status } } }

User: "Update order status to preparing"
Mutation: mutation UpdateOrderStatus { updateOrderStatus(id: "ORD-123", status: PREPARING) { id status updatedAt } }

User: "Create customer John with phone 9876543210"
Mutation: mutation CreateCustomer($restaurantId: ID!) { createCustomer(input: { name: "John", phone: "9876543210", restaurantId: $restaurantId }) { id name phone } }

User: "Show me low stock inventory items"
Query: query GetLowStockItems($restaurantId: ID!) { inventory(restaurantId: $restaurantId, lowStock: true) { id name currentStock minStock } }

User: "Delete Pasta Alfredo from menu"
Mutation: mutation DeleteMenuItem { deleteMenuItem(id: "item_1759918044547_q499zxsmt") }

User: "Add new pizza item Margherita with price 500"
Mutation: mutation CreateMenuItem($restaurantId: ID!) { createMenuItem(input: { name: "Margherita Pizza", price: 500, category: "pizza", restaurantId: $restaurantId }) { id name price } }

User: "Update pizza price to 600"
Mutation: mutation UpdateMenuItem($restaurantId: ID!) { updateMenuItem(id: "item_1759918044547_q499zxsmt", input: { price: 600 }) { id name price } }

User: "Generate monthly report"
Mutation: mutation GenerateReport($restaurantId: ID!) { generateReport(type: "monthly", period: "this_month") { id type period generatedAt } }

User: "Logout from system"
Mutation: mutation Logout { logout }

IMPORTANT RULES:
1. Always include restaurantId in queries/mutations
2. Use proper enum values (uppercase)
3. For date ranges, use predefined periods
4. For delete operations, be extra cautious
5. Always validate user permissions
6. Use proper input types for mutations
7. Handle errors gracefully
8. Log all operations for audit
9. Use the ACTUAL database structure shown above
10. Field names must match exactly what's in the database
11. CRITICAL: Use the exact menu item IDs from the "ACTUAL DATABASE STRUCTURE" section above, not the hardcoded examples
12. When placing orders, find the menu item ID by matching the item name from the database structure
`;

    return schemaDescription;
    
  } catch (error) {
    console.error('Error generating dynamic schema:', error);
    // Fallback to basic schema if introspection fails
    return `BASIC GRAPHQL SCHEMA FOR RESTAURANT MANAGEMENT SYSTEM
Available collections: tables, orders, customers, menu, inventory, analytics
Basic queries: restaurant, tables, orders, customers, menu, inventory, analytics
Basic mutations: createTable, updateTable, createOrder, updateOrder, createCustomer, updateCustomer
Security: All operations require restaurantId and proper authentication`;
  }
}

// Get actual database collections and their fields
async function getDatabaseCollections(db) {
  try {
    // Get all collections from Firestore
    const collections = [];
    
    // Define known collections with their expected fields
    const knownCollections = [
      { name: 'restaurants', fields: ['name', 'description', 'address', 'phone', 'email', 'cuisine', 'settings'] },
      { name: 'tables', fields: ['name', 'floor', 'capacity', 'section', 'status', 'restaurantId'] },
      { name: 'orders', fields: ['orderNumber', 'restaurantId', 'items', 'totalAmount', 'customer', 'tableNumber', 'status', 'waiterId'] },
      { name: 'customers', fields: ['name', 'phone', 'email', 'city', 'address', 'restaurantId', 'totalSpent'] },
      { name: 'menu', fields: ['items', 'categories'] },
      { name: 'inventory', fields: ['name', 'category', 'currentStock', 'minStock', 'maxStock', 'restaurantId'] },
      { name: 'staff', fields: ['name', 'email', 'phone', 'role', 'restaurantId'] },
      { name: 'analytics', fields: ['period', 'revenue', 'orders', 'customers'] },
      { name: 'feedback', fields: ['orderId', 'customerId', 'rating', 'comment', 'category', 'restaurantId'] },
      { name: 'invoices', fields: ['orderId', 'invoiceNumber', 'subtotal', 'total', 'restaurantId'] }
    ];
    
    // Check which collections actually exist in the database
    for (const collection of knownCollections) {
      try {
        const snapshot = await db.collection(collection.name).limit(1).get();
        if (!snapshot.empty) {
          // Get actual fields from the first document
          const doc = snapshot.docs[0];
          const actualFields = Object.keys(doc.data());
          collections.push({
            name: collection.name,
            fields: actualFields,
            sampleData: { id: doc.id, ...doc.data() }
          });
        }
      } catch (error) {
        console.log(`Collection ${collection.name} not accessible:`, error.message);
      }
    }
    
    // Get actual menu items from restaurants collection
    try {
      const restaurantsSnapshot = await db.collection('restaurants').limit(5).get();
      for (const restaurantDoc of restaurantsSnapshot.docs) {
        const restaurantData = restaurantDoc.data();
        if (restaurantData.menu && restaurantData.menu.items) {
          const menuItems = restaurantData.menu.items.map(item => ({
            id: item.id,
            name: item.name,
            price: item.price,
            category: item.category,
            shortCode: item.shortCode
          }));
          
          collections.push({
            name: `restaurant_${restaurantDoc.id}_menu_items`,
            fields: ['id', 'name', 'price', 'category', 'shortCode'],
            sampleData: menuItems.slice(0, 10) // Limit to first 10 items
          });
        }
      }
    } catch (error) {
      console.log('Error fetching menu items:', error.message);
    }
    
  } catch (error) {
    console.error('Error getting database collections:', error);
    return [];
  }
}

// Generate dynamic GraphQL query from natural language
async function generateGraphQLQuery(userQuery, restaurantId, userId, db, conversationData = null) {
  try {
    const schema = await generateGraphQLSchemaForChatGPT(db);
    
    // Build conversation context for ChatGPT
    let conversationContext = '';
    if (conversationData?.conversation) {
      const conv = conversationData.conversation;
      conversationContext = `

CONVERSATION CONTEXT:
Previous messages in this conversation:
${conv.messages.slice(-6).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

Current context:
- Last table number: ${conv.context?.lastTableNumber || 'None'}
- Last customer name: ${conv.context?.lastCustomerName || 'None'}
- Last customer phone: ${conv.context?.lastCustomerPhone || 'None'}

IMPORTANT: Use the context above to provide better responses. If the user mentions "1 item" or similar without specifying table/customer details, use the context from previous messages.`;
    }
    
    const prompt = `
You are a GraphQL query generator for a restaurant management system. 
Generate the appropriate GraphQL query or mutation based on the user's request.

${schema}

${conversationContext}

User Query: "${userQuery}"
Restaurant ID: "${restaurantId}"
User ID: "${userId}"

Generate ONLY the GraphQL query/mutation. Do not include any explanations or additional text.
If the query requires variables, include them in the format: query QueryName($variable: Type!) { ... }

Examples of expected output:
- For "show today's revenue": query GetTodayRevenue($restaurantId: ID!) { analytics(restaurantId: $restaurantId, period: "today") { revenue { total } } }
- For "add table 5": mutation CreateTable($restaurantId: ID!) { createTable(input: { name: "5", capacity: 4, floor: "Ground Floor", restaurantId: $restaurantId }) { id name } }
- For "place order for Pizza Al Greco 1 item for customer name Rahul": mutation CreateOrder($restaurantId: ID!) { createOrder(input: { tableNumber: null, customer: { name: "Rahul" }, items: [{ menuItemId: "item_1759918044546_nhgoqwlwb", quantity: 1 }], paymentMethod: CASH, restaurantId: $restaurantId }) { id orderNumber totalAmount } }
- For "logout": mutation Logout { logout }

Generate the GraphQL query/mutation now:
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a GraphQL query generator. Generate only the GraphQL query/mutation without any explanations."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 500,
      temperature: 0.1
    });

    const generatedQuery = response.choices[0].message.content.trim();
    
    // Validate the generated query
    if (!generatedQuery.startsWith('query') && !generatedQuery.startsWith('mutation')) {
      throw new Error('Invalid GraphQL query generated');
    }

    return generatedQuery;
    
  } catch (error) {
    console.error('Error generating GraphQL query:', error);
    throw new Error('Failed to generate GraphQL query');
  }
}

// Execute GraphQL query with security validation
async function executeGraphQLQuery(query, variables, context) {
  try {
    const { graphql } = require('graphql');
    const { typeDefs } = require('./schema');
    const { resolvers } = require('./resolvers');
    const { makeExecutableSchema } = require('graphql-tools');

    const schema = makeExecutableSchema({ typeDefs, resolvers });
    
    // Add security context
    const secureContext = {
      ...context,
      user: context.user,
      db: context.db
    };

    const result = await graphql({
      schema,
      source: query,
      variableValues: variables,
      contextValue: secureContext
    });

    if (result.errors) {
      console.error('GraphQL execution errors:', result.errors);
      // Return the error data instead of throwing
      return { errors: result.errors, data: result.data };
    }

    return result.data;
    
  } catch (error) {
    console.error('Error executing GraphQL query:', error);
    throw new Error('Failed to execute GraphQL query');
  }
}

// Generate user-friendly response from GraphQL result
function generateUserResponse(query, data, userQuery) {
  try {
    // Check if there were any errors in the data
    if (data.errors && data.errors.length > 0) {
      const error = data.errors[0];
      if (error.message.includes('Access denied') || error.message.includes('Forbidden')) {
        return `I apologize, but I don't have permission to perform that action. You can only manage your own restaurant's data. Please make sure you're logged in with the correct account that owns this restaurant.`;
      } else if (error.message.includes('not found')) {
        return `I couldn't find the item you're looking for. It may have already been deleted or doesn't exist in your restaurant's data.`;
      } else if (error.message.includes('authentication') || error.message.includes('token')) {
        return `I need you to log in again to perform this action. Your session may have expired.`;
      } else {
        return `I encountered an error while processing your request: ${error.message}. Please try again or contact support if the issue persists.`;
      }
    }

    // Analyze the query type and data to generate appropriate response
    if (query.includes('logout')) {
      return "You have been logged out successfully. Redirecting to login page...";
    }
    
    if (query.includes('createTable')) {
      return `Table created successfully! Table ID: ${data.createTable?.id}`;
    }
    
    if (query.includes('updateTableStatus')) {
      return `Table status updated successfully!`;
    }
    
    if (query.includes('createCustomer')) {
      return `Customer created successfully! Customer ID: ${data.createCustomer?.id}`;
    }
    
    if (query.includes('analytics')) {
      const revenue = data.analytics?.revenue?.total || 0;
      return `Today's revenue: ₹${revenue.toFixed(2)}`;
    }
    
    if (query.includes('tables')) {
      const tables = data.tables || [];
      if (tables.length === 0) {
        return "No tables found matching your criteria.";
      }
      return `Found ${tables.length} tables. Status: ${tables.map(t => `${t.name} (${t.status})`).join(', ')}`;
    }
    
    if (query.includes('orders')) {
      const orders = data.orders || [];
      if (orders.length === 0) {
        return "No orders found matching your criteria.";
      }
      return `Found ${orders.length} orders. Total value: ₹${orders.reduce((sum, order) => sum + order.totalAmount, 0).toFixed(2)}`;
    }
    
    if (query.includes('customers')) {
      const customers = data.customers || [];
      if (customers.length === 0) {
        return "No customers found matching your criteria.";
      }
      return `Found ${customers.length} customers: ${customers.map(c => c.name || c.phone).join(', ')}`;
    }
    
    if (query.includes('deleteMenuItem')) {
      return `✅ Successfully removed the menu item from your restaurant! The item has been permanently deleted from your menu.`;
    }
    
    if (query.includes('createMenuItem')) {
      return `✅ Successfully added the new menu item to your restaurant! The item is now available for customers to order.`;
    }
    
    if (query.includes('updateMenuItem')) {
      return `✅ Successfully updated the menu item! The changes have been saved to your menu.`;
    }
    
    if (query.includes('createTable')) {
      return `✅ Successfully added the new table to your restaurant! The table is now available for seating.`;
    }
    
    if (query.includes('deleteTable')) {
      return `✅ Successfully removed the table from your restaurant! The table has been permanently deleted.`;
    }
    
    if (query.includes('bookTable')) {
      return `✅ Successfully booked the table! The reservation has been confirmed and the table is now reserved.`;
    }
    
    if (query.includes('updateTableStatus')) {
      return `✅ Successfully updated the table status! The table status has been changed.`;
    }
    
    if (query.includes('createOrder')) {
      return `✅ Successfully created the order! The order has been placed and sent to the kitchen for preparation.`;
    }
    
    if (query.includes('updateOrder')) {
      return `✅ Successfully updated the order! The changes have been saved and sent to the kitchen.`;
    }
    
    if (query.includes('updateOrderItems')) {
      return `✅ Successfully updated the order items! The order has been modified and sent to the kitchen.`;
    }
    
    if (query.includes('cancelOrder')) {
      return `✅ Successfully cancelled the order! The order has been cancelled and removed from the kitchen queue.`;
    }
    
    if (query.includes('completeOrder')) {
      return `✅ Successfully completed the order! The order has been marked as completed.`;
    }
    
    if (query.includes('processPayment')) {
      return `✅ Successfully processed the payment! The order has been paid and completed.`;
    }
    
    if (query.includes('updateOrderStatus')) {
      return `✅ Successfully updated the order status! The order status has been changed.`;
    }
    
    if (query.includes('searchOrders')) {
      const orders = data.searchOrders || [];
      if (orders.length === 0) {
        return "No orders found matching your search criteria.";
      }
      return `Found ${orders.length} orders matching your search. Orders: ${orders.map(o => `#${o.orderNumber} (Table ${o.tableNumber || 'N/A'})`).join(', ')}`;
    }
    
    // Default response
    return `Query executed successfully. Found ${Object.keys(data).length} result(s).`;
    
  } catch (error) {
    console.error('Error generating user response:', error);
    return "Query executed successfully.";
  }
}

module.exports = {
  generateGraphQLQuery,
  executeGraphQLQuery,
  generateUserResponse,
  generateGraphQLSchemaForChatGPT,
  getDatabaseCollections
};
