const OpenAI = require('openai');
const { db, collections } = require('../firebase');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const inventoryService = require('./inventoryService');

/**
 * DineAgent - OpenAI Function Calling Agent
 * Uses OpenAI's function calling (tool use) for agentic behavior
 * Optimized for low payload and cost efficiency
 */
class FunctionCallingAgent {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    // Define all available functions for the agent
    this.functions = this.defineFunctions();
  }

  /**
   * Define all available functions for OpenAI function calling
   */
  defineFunctions() {
    return [
      {
        type: 'function',
        function: {
          name: 'get_orders',
          description: 'Get list of orders filtered by status. Returns order details including ID, items, total, status, and timestamp.',
          parameters: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['pending', 'preparing', 'ready', 'completed', 'cancelled', 'all'],
                description: 'Filter orders by status. Use "all" to get all orders.'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of orders to return. Default is 10.',
                default: 10
              }
            }
          },
          required: []
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_order_by_id',
          description: 'Get a specific order by its ID. Returns full order details.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The order ID to look up'
              }
            },
            required: ['order_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'reserve_table',
          description: 'Reserve/book a table for guests. Returns confirmation with table details.',
          parameters: {
            type: 'object',
            properties: {
              table_number: {
                type: 'string',
                description: 'The table number or table ID to reserve'
              },
              guests: {
                type: 'number',
                description: 'Number of guests'
              },
              time: {
                type: 'string',
                description: 'Reservation time in HH:MM format (24-hour)'
              },
              customer_name: {
                type: 'string',
                description: 'Name of the customer making the reservation'
              },
              customer_phone: {
                type: 'string',
                description: 'Phone number of the customer'
              }
            },
            required: ['table_number', 'guests']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_tables',
          description: 'Get FRESH table information including availability, status, and floor details. This function ALWAYS fetches the latest data from the database. Returns summary and detailed list with accurate counts for each status (available, occupied, reserved, cleaning, out-of-service).',
          parameters: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['available', 'occupied', 'reserved', 'cleaning', 'out-of-service', 'all'],
                description: 'Filter tables by status. Use "all" to get all tables with complete statistics.'
              },
              floor: {
                type: 'string',
                description: 'Filter by floor name (e.g., "Ground Floor", "First Floor")'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_table_status',
          description: 'Update the status of a table (e.g., mark as available, occupied, cleaning).',
          parameters: {
            type: 'object',
            properties: {
              table_id: {
                type: 'string',
                description: 'The table ID to update'
              },
              status: {
                type: 'string',
                enum: ['available', 'occupied', 'reserved', 'cleaning', 'out-of-service'],
                description: 'New status for the table'
              }
            },
            required: ['table_id', 'status']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'cancel_order',
          description: 'Cancel a customer order. Only pending or preparing orders can be cancelled.',
          parameters: {
            type: 'object',
            properties: {
              order_id: {
                type: 'string',
                description: 'The order ID to cancel'
              }
            },
            required: ['order_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_menu',
          description: 'Get menu items. Can filter by category or search by name.',
          parameters: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description: 'Filter by menu category (e.g., "Main Course", "Desserts")'
              },
              search: {
                type: 'string',
                description: 'Search menu items by name'
              },
              is_veg: {
                type: 'boolean',
                description: 'Filter vegetarian items only'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_sales_summary',
          description: 'Get sales summary for a specific date. Returns total revenue, order count, and breakdown.',
          parameters: {
            type: 'object',
            properties: {
              date: {
                type: 'string',
                description: 'Date in YYYY-MM-DD format. Defaults to today if not provided.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_to_cart',
          description: 'Add menu items to the current order cart. Returns updated cart with items.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    menu_item_id: {
                      type: 'string',
                      description: 'Menu item ID'
                    },
                    name: {
                      type: 'string',
                      description: 'Menu item name'
                    },
                    quantity: {
                      type: 'number',
                      description: 'Quantity to add'
                    },
                    price: {
                      type: 'number',
                      description: 'Price per item'
                    }
                  },
                  required: ['menu_item_id', 'name', 'quantity', 'price']
                },
                description: 'Array of items to add to cart'
              }
            },
            required: ['items']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'place_order',
          description: 'Place an order to the kitchen. Creates a new order with proper price calculation, tax, and table status update. Prices are automatically fetched from the menu, and tax is calculated if enabled. Table status is automatically updated to "occupied" if a table number is provided.',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    menu_item_id: { 
                      type: 'string',
                      description: 'Menu item ID (preferred)'
                    },
                    id: {
                      type: 'string',
                      description: 'Alternative menu item ID'
                    },
                    name: { 
                      type: 'string',
                      description: 'Menu item name (used if ID not provided, will search by name)'
                    },
                    quantity: { 
                      type: 'number',
                      description: 'Quantity to order (default: 1)'
                    },
                    price: { 
                      type: 'number',
                      description: 'Price per item (optional, will be fetched from menu if not provided)'
                    },
                    basePrice: {
                      type: 'number',
                      description: 'Base price if variant is selected (optional)'
                    },
                    selectedVariant: {
                      type: 'object',
                      description: 'Selected variant (e.g., Half/Full) with name and price',
                      properties: {
                        name: { type: 'string' },
                        price: { type: 'number' }
                      }
                    },
                    selectedCustomizations: {
                      type: 'array',
                      description: 'Selected customizations/toppings with name and price',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          price: { type: 'number' }
                        }
                      }
                    },
                    notes: {
                      type: 'string',
                      description: 'Special notes for this item'
                    }
                  },
                  required: []
                },
                description: 'Array of items to order. Each item should have either menu_item_id/id or name, and quantity.'
              },
              table_number: {
                type: 'string',
                description: 'Table number for dine-in orders. Table status will be automatically updated to "occupied".'
              },
              order_type: {
                type: 'string',
                enum: ['dine-in', 'takeaway', 'delivery'],
                description: 'Type of order (default: dine-in)'
              },
              customer_name: {
                type: 'string',
                description: 'Customer name (optional)'
              },
              customer_phone: {
                type: 'string',
                description: 'Customer phone number (optional)'
              },
              payment_method: {
                type: 'string',
                enum: ['cash', 'card', 'upi', 'online'],
                description: 'Payment method (default: cash)'
              },
              notes: {
                type: 'string',
                description: 'Order notes or special instructions'
              }
            },
            required: ['items']
          }
        }
      },
      // Menu Management Functions
      {
        type: 'function',
        function: {
          name: 'add_menu_item',
          description: 'Add a new item to the restaurant menu. Returns the created menu item with ID.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Name of the menu item'
              },
              price: {
                type: 'number',
                description: 'Price of the item'
              },
              category: {
                type: 'string',
                description: 'Category name (e.g., "Main Course", "Appetizers", "Desserts")'
              },
              description: {
                type: 'string',
                description: 'Description of the menu item'
              },
              is_veg: {
                type: 'boolean',
                description: 'Whether the item is vegetarian'
              },
              spice_level: {
                type: 'string',
                enum: ['mild', 'medium', 'hot', 'extra-hot'],
                description: 'Spice level of the item'
              },
              short_code: {
                type: 'string',
                description: 'Short code for quick ordering (e.g., "PZ01")'
              }
            },
            required: ['name', 'price', 'category']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_menu_item',
          description: 'Update an existing menu item. Provide the menu item ID and fields to update.',
          parameters: {
            type: 'object',
            properties: {
              menu_item_id: {
                type: 'string',
                description: 'The ID of the menu item to update'
              },
              name: {
                type: 'string',
                description: 'Updated name'
              },
              price: {
                type: 'number',
                description: 'Updated price'
              },
              category: {
                type: 'string',
                description: 'Updated category'
              },
              description: {
                type: 'string',
                description: 'Updated description'
              },
              is_veg: {
                type: 'boolean',
                description: 'Updated vegetarian status'
              },
              is_available: {
                type: 'boolean',
                description: 'Whether the item is currently available'
              }
            },
            required: ['menu_item_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_menu_item',
          description: 'Delete (soft delete) a menu item from the menu. The item will be marked as deleted but not permanently removed.',
          parameters: {
            type: 'object',
            properties: {
              menu_item_id: {
                type: 'string',
                description: 'The ID of the menu item to delete'
              }
            },
            required: ['menu_item_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'search_menu_items',
          description: 'Search for menu items by name, category, or other criteria. Returns matching items.',
          parameters: {
            type: 'object',
            properties: {
              search_term: {
                type: 'string',
                description: 'Search term to find items by name or description'
              },
              category: {
                type: 'string',
                description: 'Filter by category name'
              },
              is_veg: {
                type: 'boolean',
                description: 'Filter vegetarian items only'
              },
              is_available: {
                type: 'boolean',
                description: 'Filter only available items'
              }
            }
          }
        }
      },
      // Customer Management Functions
      {
        type: 'function',
        function: {
          name: 'get_customers',
          description: 'Get list of customers for the restaurant. Returns customer details including name, phone, email, order history, and total spent.',
          parameters: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Maximum number of customers to return. Default is 50.',
                default: 50
              },
              search: {
                type: 'string',
                description: 'Search customers by name, phone, or email'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_customer_by_id',
          description: 'Get detailed information about a specific customer by their ID, phone number, or email.',
          parameters: {
            type: 'object',
            properties: {
              customer_id: {
                type: 'string',
                description: 'Customer ID'
              },
              phone: {
                type: 'string',
                description: 'Customer phone number'
              },
              email: {
                type: 'string',
                description: 'Customer email address'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'add_customer',
          description: 'Add a new customer to the restaurant database. If customer exists (by phone/email), updates their information.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Customer name'
              },
              phone: {
                type: 'string',
                description: 'Customer phone number'
              },
              email: {
                type: 'string',
                description: 'Customer email address'
              },
              city: {
                type: 'string',
                description: 'Customer city'
              },
              dob: {
                type: 'string',
                description: 'Date of birth (YYYY-MM-DD format)'
              }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_customer',
          description: 'Update customer information. Provide customer ID and fields to update.',
          parameters: {
            type: 'object',
            properties: {
              customer_id: {
                type: 'string',
                description: 'The ID of the customer to update'
              },
              name: {
                type: 'string',
                description: 'Updated name'
              },
              phone: {
                type: 'string',
                description: 'Updated phone number'
              },
              email: {
                type: 'string',
                description: 'Updated email address'
              },
              city: {
                type: 'string',
                description: 'Updated city'
              }
            },
            required: ['customer_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'delete_customer',
          description: 'Delete a customer from the restaurant database.',
          parameters: {
            type: 'object',
            properties: {
              customer_id: {
                type: 'string',
                description: 'The ID of the customer to delete'
              }
            },
            required: ['customer_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_customer_history',
          description: 'Get order history for a specific customer. Returns all past orders with details.',
          parameters: {
            type: 'object',
            properties: {
              customer_id: {
                type: 'string',
                description: 'Customer ID'
              },
              phone: {
                type: 'string',
                description: 'Customer phone number (alternative to customer_id)'
              },
              limit: {
                type: 'number',
                description: 'Maximum number of orders to return. Default is 20.',
                default: 20
              }
            }
          }
        }
      },
      // Google Reviews Management
      {
        type: 'function',
        function: {
          name: 'get_google_review_settings',
          description: 'Get Google Review settings for the restaurant including review URL, QR code status, and AI settings.',
          parameters: {
            type: 'object',
            properties: {}
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'update_google_review_settings',
          description: 'Update Google Review settings. Can set the Google Review URL/Place ID, enable/disable AI review generation, and add custom messages.',
          parameters: {
            type: 'object',
            properties: {
              google_review_url: {
                type: 'string',
                description: 'Google Review URL or Place ID. Can be a Place ID (e.g., ChIJN1t_tDeuEmsRUsoyG83frY4) or full Google Maps URL.'
              },
              ai_enabled: {
                type: 'boolean',
                description: 'Enable or disable AI-powered review content generation'
              },
              custom_message: {
                type: 'string',
                description: 'Custom message to display with QR code (optional)'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'generate_qr_code',
          description: 'Generate a QR code for the Google Review link. The QR code can be scanned by customers to directly open the Google Review writing page.',
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                description: 'Google Review URL or Place ID to generate QR code for. If not provided, uses saved URL from settings.'
              }
            }
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'generate_review_content',
          description: 'Generate AI-powered review content for a customer. Creates authentic, genuine review text based on restaurant details, customer name, and rating.',
          parameters: {
            type: 'object',
            properties: {
              customer_name: {
                type: 'string',
                description: 'Name of the customer for whom to generate the review'
              },
              rating: {
                type: 'number',
                enum: [1, 2, 3, 4, 5],
                description: 'Star rating (1-5) for the review'
              }
            },
            required: ['customer_name', 'rating']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_review_link',
          description: 'Get the Google Review link/URL for the restaurant. Returns the direct link that opens the Google Review writing page.',
          parameters: {
            type: 'object',
            properties: {
              place_id: {
                type: 'string',
                description: 'Optional Place ID. If not provided, uses saved Place ID from settings.'
              }
            }
          }
        }
      }
    ];
  }

  /**
   * Verify user has access to restaurant (Security check)
   */
  async verifyRestaurantAccess(restaurantId, userId) {
    try {
      const userRestaurantDoc = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (userRestaurantDoc.empty) {
        throw new Error('Access denied: You do not have permission to access this restaurant');
      }

      return true;
    } catch (error) {
      console.error(`🚫 Access denied: User ${userId} attempted to access restaurant ${restaurantId}`);
      throw error;
    }
  }

  /**
   * Get Session Summary from Firestore (user preferences, recent activity)
   */
  async getSessionSummary(userId, restaurantId) {
    try {
      // Get user preferences from userRestaurants collection
      const userRestaurantDoc = await db.collection('userRestaurants')
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .limit(1)
        .get();

      if (userRestaurantDoc.empty) {
        return 'No user preferences found.';
      }

      const userData = userRestaurantDoc.docs[0].data();
      const role = userData.role || 'staff';
      const name = userData.name || 'User';

      // Get recent conversation summary (last 3 messages)
      // Note: This is handled separately in processQuery, so we skip here

      let summary = `User: ${name}, Role: ${role}`;
      
      // Add any stored preferences
      if (userData.preferences) {
        summary += `. Preferences: ${JSON.stringify(userData.preferences)}`;
      }

      return summary;
    } catch (error) {
      console.error('Error fetching session summary:', error);
      return 'Unable to load user preferences.';
    }
  }

  /**
   * Get Relevant Facts using embeddings (menu items, FAQs, policies)
   * Only fetch if query is relevant to avoid unnecessary API calls
   */
  async getRelevantFacts(query, restaurantId) {
    try {
      // For now, return minimal menu context
      // In production, use embeddings for semantic search
      const menuSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('menu')
        .limit(5) // Keep minimal for cost
        .get();

      const menuItems = [];
      menuSnapshot.forEach(doc => {
        const data = doc.data();
        menuItems.push({
          id: doc.id,
          name: data.name,
          price: data.price,
          category: data.category
        });
      });

      return {
        menuItems: menuItems.slice(0, 5), // Limit to 5 items
        totalMenuItems: menuItems.length
      };
    } catch (error) {
      console.error('Error fetching relevant facts:', error);
      return { menuItems: [], totalMenuItems: 0 };
    }
  }

  /**
   * Get System State (live data - orders, tables, etc.)
   * Only fetch if needed based on query intent
   */
  async getSystemState(restaurantId, query) {
    const state = {};

    // Only fetch what's needed based on query keywords
    const lowerQuery = query.toLowerCase();

    // Fetch tables if query mentions tables
    if (lowerQuery.includes('table') || lowerQuery.includes('reserve') || lowerQuery.includes('booking')) {
      try {
        const floorsSnapshot = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .get();

        let totalTables = 0;
        let availableTables = 0;
        let occupiedTables = 0;

        for (const floorDoc of floorsSnapshot.docs) {
          const tablesSnapshot = await db.collection('restaurants')
            .doc(restaurantId)
            .collection('floors')
            .doc(floorDoc.id)
            .collection('tables')
            .get();

          totalTables += tablesSnapshot.size;
          tablesSnapshot.forEach(tableDoc => {
            const tableData = tableDoc.data();
            if (tableData.status === 'available') availableTables++;
            if (tableData.status === 'occupied') occupiedTables++;
          });
        }

        state.tables = {
          total: totalTables,
          available: availableTables,
          occupied: occupiedTables
        };
      } catch (error) {
        console.error('Error fetching tables:', error);
      }
    }

    // Fetch orders if query mentions orders
    if (lowerQuery.includes('order') || lowerQuery.includes('pending') || lowerQuery.includes('completed')) {
      try {
        const ordersSnapshot = await db.collection('orders')
          .where('restaurantId', '==', restaurantId)
          .where('status', 'in', ['pending', 'preparing'])
          .orderBy('createdAt', 'desc')
          .limit(5)
          .get();

        state.pendingOrders = ordersSnapshot.size;
      } catch (error) {
        console.error('Error fetching orders:', error);
      }
    }

    return state;
  }

  /**
   * Execute a function call
   */
  async executeFunction(functionName, arguments_, restaurantId, userId) {
    console.log(`🔧 Executing function: ${functionName}`, arguments_);

    try {
      // Verify user has access to this restaurant
      await this.verifyRestaurantAccess(restaurantId, userId);

      switch (functionName) {
        case 'get_orders':
          return await this.getOrders(restaurantId, arguments_.status || 'all', arguments_.limit || 10);
        
        case 'get_order_by_id':
          return await this.getOrderById(restaurantId, arguments_.order_id);
        
        case 'get_tables':
          return await this.getTables(restaurantId, arguments_.status, arguments_.floor);
        
        case 'reserve_table':
          return await this.reserveTable(restaurantId, arguments_);
        
        case 'update_table_status':
          return await this.updateTableStatus(restaurantId, arguments_.table_id, arguments_.status);
        
        case 'cancel_order':
          return await this.cancelOrder(restaurantId, arguments_.order_id);
        
        case 'get_menu':
          return await this.getMenu(restaurantId, arguments_);
        
        case 'get_sales_summary':
          return await this.getSalesSummary(restaurantId, arguments_.date);
        
        case 'add_to_cart':
          return await this.addToCart(arguments_.items);
        
        case 'place_order':
          return await this.placeOrder(restaurantId, arguments_, userId);
        
        // Menu Management
        case 'add_menu_item':
          return await this.addMenuItem(restaurantId, arguments_, userId);
        
        case 'update_menu_item':
          return await this.updateMenuItem(restaurantId, arguments_);
        
        case 'delete_menu_item':
          return await this.deleteMenuItem(restaurantId, arguments_);
        
        case 'search_menu_items':
          return await this.searchMenuItems(restaurantId, arguments_);
        
        // Customer Management
        case 'get_customers':
          return await this.getCustomers(restaurantId, arguments_);
        
        case 'get_customer_by_id':
          return await this.getCustomerById(restaurantId, arguments_);
        
        case 'add_customer':
          return await this.addCustomer(restaurantId, arguments_);
        
        case 'update_customer':
          return await this.updateCustomer(restaurantId, arguments_);
        
        case 'delete_customer':
          return await this.deleteCustomer(restaurantId, arguments_);
        
        case 'get_customer_history':
          return await this.getCustomerHistory(restaurantId, arguments_);
        
        // Google Reviews Management
        case 'get_google_review_settings':
          return await this.getGoogleReviewSettings(restaurantId);
        
        case 'update_google_review_settings':
          return await this.updateGoogleReviewSettings(restaurantId, arguments_);
        
        case 'generate_qr_code':
          return await this.generateQRCode(restaurantId, arguments_.url);
        
        case 'generate_review_content':
          return await this.generateReviewContent(restaurantId, arguments_.customer_name, arguments_.rating);
        
        case 'get_review_link':
          return await this.getReviewLink(restaurantId, arguments_.place_id);
        
        default:
          return { error: `Unknown function: ${functionName}` };
      }
    } catch (error) {
      console.error(`Error executing ${functionName}:`, error);
      return { error: error.message };
    }
  }

  /**
   * Function implementations
   */
  async getOrders(restaurantId, status, limit) {
    let query = db.collection('orders')
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    const snapshot = await query
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const orders = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      orders.push({
        id: doc.id,
        orderId: data.orderId || doc.id,
        items: data.items || [],
        total: data.total || 0,
        status: data.status,
        tableNumber: data.tableNumber,
        orderType: data.orderType,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
      });
    });

    return {
      success: true,
      orders,
      count: orders.length
    };
  }

  async getOrderById(restaurantId, orderId) {
    // Try to find by orderId field first
    let snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('orderId', '==', orderId.toString())
      .limit(1)
      .get();

    // If not found, try by document ID
    if (snapshot.empty) {
      const doc = await db.collection('orders').doc(orderId).get();
      if (doc.exists && doc.data().restaurantId === restaurantId) {
        const data = doc.data();
        return {
          success: true,
          order: {
            id: doc.id,
            orderId: data.orderId || doc.id,
            items: data.items || [],
            total: data.total || 0,
            status: data.status,
            tableNumber: data.tableNumber,
            orderType: data.orderType,
            createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
          }
        };
      }
    }

    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      const data = doc.data();
      return {
        success: true,
        order: {
          id: doc.id,
          orderId: data.orderId || doc.id,
          items: data.items || [],
          total: data.total || 0,
          status: data.status,
          tableNumber: data.tableNumber,
          orderType: data.orderType,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt
        }
      };
    }

    return { success: false, error: 'Order not found' };
  }

  async getTables(restaurantId, status, floor) {
    console.log(`🔍 Fetching FRESH table data for restaurant: ${restaurantId}, status filter: ${status}, floor: ${floor}`);
    
    // Always fetch fresh data - no caching
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    const allTables = [];
    const stats = {
      total: 0,
      available: 0,
      occupied: 0,
      reserved: 0,
      cleaning: 0,
      outOfService: 0
    };

    for (const floorDoc of floorsSnapshot.docs) {
      const floorData = floorDoc.data();
      
      // Filter by floor if specified
      if (floor && floorData.name?.toLowerCase() !== floor.toLowerCase()) {
        continue;
      }

      // Fetch fresh data from Firestore
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      console.log(`📊 Floor ${floorData.name}: Found ${tablesSnapshot.size} tables`);

      tablesSnapshot.forEach(tableDoc => {
        const tableData = tableDoc.data();
        const tableStatus = tableData.status || 'available';

        console.log(`  - Table ${tableData.name || tableDoc.id}: Status = ${tableStatus}`);

        // Filter by status if specified
        if (status && status !== 'all' && tableStatus !== status) {
          return;
        }

        stats.total++;
        if (tableStatus === 'available') stats.available++;
        if (tableStatus === 'occupied') stats.occupied++;
        if (tableStatus === 'reserved') stats.reserved++;
        if (tableStatus === 'cleaning') stats.cleaning++;
        if (tableStatus === 'out-of-service') stats.outOfService++;

        allTables.push({
          id: tableDoc.id,
          name: tableData.name || tableDoc.id,
          status: tableStatus,
          floor: floorData.name || 'Unknown',
          capacity: tableData.capacity || 0
        });
      });
    }

    console.log(`✅ Table stats:`, stats);

    return {
      success: true,
      tables: allTables,
      stats,
      byFloor: allTables.reduce((acc, table) => {
        const floorName = table.floor;
        if (!acc[floorName]) {
          acc[floorName] = { total: 0, available: 0, occupied: 0, reserved: 0, cleaning: 0, outOfService: 0 };
        }
        acc[floorName].total++;
        if (table.status === 'available') acc[floorName].available++;
        if (table.status === 'occupied') acc[floorName].occupied++;
        if (table.status === 'reserved') acc[floorName].reserved++;
        if (table.status === 'cleaning') acc[floorName].cleaning++;
        if (table.status === 'out-of-service') acc[floorName].outOfService++;
        return acc;
      }, {})
    };
  }

  async reserveTable(restaurantId, args) {
    // Find table by number or ID
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    let targetTable = null;
    let targetFloorId = null;

    for (const floorDoc of floorsSnapshot.docs) {
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      for (const tableDoc of tablesSnapshot.docs) {
        const tableData = tableDoc.data();
        if (tableData.name === args.table_number || tableDoc.id === args.table_number) {
          targetTable = tableDoc;
          targetFloorId = floorDoc.id;
          break;
        }
      }
      if (targetTable) break;
    }

    if (!targetTable) {
      return { success: false, error: `Table ${args.table_number} not found` };
    }

    const tableData = targetTable.data();
    if (tableData.status !== 'available') {
      return { success: false, error: `Table ${args.table_number} is ${tableData.status}, cannot reserve` };
    }

    // Update table status
    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(targetFloorId)
      .collection('tables')
      .doc(targetTable.id)
      .update({
        status: 'reserved',
        reservedBy: args.customer_name || 'Unknown',
        reservedPhone: args.customer_phone || '',
        reservedGuests: args.guests,
        reservedTime: args.time || new Date().toISOString(),
        updatedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `Table ${args.table_number} reserved for ${args.guests} guests${args.time ? ` at ${args.time}` : ''}`,
      table: {
        id: targetTable.id,
        name: tableData.name,
        floor: targetTable.ref.parent.parent.id
      }
    };
  }

  async updateTableStatus(restaurantId, tableId, status) {
    // Find table
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    let targetTable = null;
    let targetFloorId = null;

    for (const floorDoc of floorsSnapshot.docs) {
      const tableDoc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .doc(tableId)
        .get();

      if (tableDoc.exists) {
        targetTable = tableDoc;
        targetFloorId = floorDoc.id;
        break;
      }
    }

    if (!targetTable) {
      return { success: false, error: 'Table not found' };
    }

    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(targetFloorId)
      .collection('tables')
      .doc(tableId)
      .update({
        status,
        updatedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `Table status updated to ${status}`,
      table: {
        id: tableId,
        status
      }
    };
  }

  async cancelOrder(restaurantId, orderId) {
    // Find order
    let snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('orderId', '==', orderId.toString())
      .limit(1)
      .get();

    if (snapshot.empty) {
      const doc = await db.collection('orders').doc(orderId).get();
      if (doc.exists && doc.data().restaurantId === restaurantId) {
        snapshot = { docs: [doc] };
      }
    }

    if (snapshot.empty || !snapshot.docs) {
      return { success: false, error: 'Order not found' };
    }

    const orderDoc = snapshot.docs[0];
    const orderData = orderDoc.data();

    if (['completed', 'cancelled'].includes(orderData.status)) {
      return { success: false, error: `Cannot cancel order with status: ${orderData.status}` };
    }

    await db.collection('orders')
      .doc(orderDoc.id)
      .update({
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

    return {
      success: true,
      message: `Order ${orderId} has been cancelled`,
      order: {
        id: orderDoc.id,
        orderId: orderData.orderId || orderDoc.id,
        status: 'cancelled'
      }
    };
  }

  async getMenu(restaurantId, args) {
    let query = db.collection('restaurants')
      .doc(restaurantId)
      .collection('menu');

    const snapshot = await query.get();
    let menuItems = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // Apply filters
      if (args.category && data.category?.toLowerCase() !== args.category.toLowerCase()) {
        return;
      }
      if (args.is_veg !== undefined && data.isVeg !== args.is_veg) {
        return;
      }
      if (args.search && !data.name?.toLowerCase().includes(args.search.toLowerCase())) {
        return;
      }

      menuItems.push({
        id: doc.id,
        name: data.name,
        price: data.price,
        category: data.category,
        description: data.description,
        isVeg: data.isVeg
      });
    });

    return {
      success: true,
      menuItems,
      count: menuItems.length
    };
  }

  async getSalesSummary(restaurantId, date) {
    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Convert to Firestore Timestamps for proper querying
    const startTimestamp = admin.firestore.Timestamp.fromDate(startOfDay);
    const endTimestamp = admin.firestore.Timestamp.fromDate(endOfDay);

    console.log(`📊 Fetching sales summary for restaurant ${restaurantId} from ${startTimestamp.toDate()} to ${endTimestamp.toDate()}`);

    // Get all orders for today (excluding cancelled orders)
    // Include all statuses: pending, preparing, ready, completed
    const snapshot = await db.collection('orders')
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', startTimestamp)
      .where('createdAt', '<=', endTimestamp)
      .get();

    console.log(`📊 Found ${snapshot.size} orders in date range`);

    let totalRevenue = 0;
    let orderCount = 0;
    const statusBreakdown = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      
      // Skip cancelled orders
      if (data.status === 'cancelled') {
        return;
      }

      // Use totalAmount (primary field) or total (fallback) or calculate from items
      let orderTotal = 0;
      if (data.totalAmount !== undefined) {
        orderTotal = data.totalAmount;
      } else if (data.total !== undefined) {
        orderTotal = data.total;
      } else if (data.finalAmount !== undefined) {
        orderTotal = data.finalAmount;
      } else if (data.items && Array.isArray(data.items)) {
        // Calculate from items if total not available
        orderTotal = data.items.reduce((sum, item) => {
          return sum + ((item.total || 0) + ((item.price || 0) * (item.quantity || 0)));
        }, 0);
      }

      totalRevenue += orderTotal;
      orderCount++;
      
      // Track status breakdown
      const status = data.status || 'unknown';
      statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
    });

    return {
      success: true,
      date: targetDate.toISOString().split('T')[0],
      totalRevenue: Math.round(totalRevenue * 100) / 100, // Round to 2 decimal places
      orderCount,
      averageOrderValue: orderCount > 0 ? Math.round((totalRevenue / orderCount) * 100) / 100 : 0,
      statusBreakdown
    };
  }

  async addToCart(items) {
    // This is a UI action - return items to be added to frontend cart
    return {
      success: true,
      message: `Added ${items.length} item(s) to cart`,
      items,
      action: 'add_to_cart'
    };
  }

  async placeOrder(restaurantId, args, userId) {
    console.log(`🛒 Placing order via chatbot for restaurant: ${restaurantId}`, args);
    
    try {
      // Get restaurant document to access embedded menu items and settings
      const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      if (!restaurantDoc.exists) {
        return { success: false, error: 'Restaurant not found' };
      }

      const restaurantData = restaurantDoc.data();
      const menuItems = restaurantData.menu?.items || [];
      
      // Get tax settings
      const taxSettings = restaurantData.settings?.taxSettings || {};
      const taxEnabled = taxSettings.enabled || false;
      const taxRate = taxSettings.rate || 0;

      // Validate and process items
      let totalAmount = 0;
      const orderItems = [];

      if (!args.items || args.items.length === 0) {
        return { success: false, error: 'No items provided for order' };
      }

      for (const item of args.items) {
        // Find menu item in the embedded menu structure
        const menuItem = menuItems.find(mi => 
          mi.id === item.menu_item_id || 
          mi.id === item.id ||
          mi.name?.toLowerCase() === item.name?.toLowerCase()
        );
        
        if (!menuItem) {
          return { success: false, error: `Menu item "${item.name || item.menu_item_id}" not found` };
        }

        // Compute unit price considering variant and selected customizations (toppings)
        const selectedVariant = item.selectedVariant || item.variant || null;
        const customizations = Array.isArray(item.selectedCustomizations)
          ? item.selectedCustomizations
          : (Array.isArray(item.customizations) ? item.customizations : []);

        const basePrice = typeof selectedVariant?.price === 'number'
          ? selectedVariant.price
          : (typeof item.basePrice === 'number' ? item.basePrice : (typeof item.price === 'number' ? item.price : menuItem.price));

        const customizationPrice = customizations.reduce((sum, c) => sum + (typeof c.price === 'number' ? c.price : 0), 0);
        const unitPrice = (basePrice || 0) + (customizationPrice || 0);

        const itemQuantity = Math.max(1, parseInt(item.quantity, 10) || 1);
        const itemTotal = unitPrice * itemQuantity;
        totalAmount += itemTotal;

        orderItems.push({
          menuItemId: menuItem.id,
          name: menuItem.name,
          price: unitPrice,
          quantity: itemQuantity,
          total: itemTotal,
          shortCode: menuItem.shortCode || null,
          notes: item.notes || '',
          // Persist kitchen-facing details
          selectedVariant: selectedVariant ? { name: selectedVariant.name, price: selectedVariant.price || 0 } : null,
          selectedCustomizations: customizations.map(c => ({ 
            id: c.id || null, 
            name: c.name || c, 
            price: typeof c.price === 'number' ? c.price : 0 
          }))
        });
      }

      // Calculate tax
      const taxAmount = taxEnabled ? (totalAmount * taxRate / 100) : 0;
      const finalAmount = totalAmount + taxAmount;

      // Validate table number if provided
      let tableId = null;
      let tableFloorId = null;
      if (args.table_number) {
        const floorsSnapshot = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .get();
        
        let tableFound = false;
        for (const floorDoc of floorsSnapshot.docs) {
          const tablesSnapshot = await db.collection('restaurants')
            .doc(restaurantId)
            .collection('floors')
            .doc(floorDoc.id)
            .collection('tables')
            .get();

          for (const tableDoc of tablesSnapshot.docs) {
            const tableData = tableDoc.data();
            if (tableData.name && tableData.name.toString().toLowerCase() === args.table_number.trim().toLowerCase()) {
              if (tableData.status !== 'available') {
                return { 
                  success: false, 
                  error: `Table "${args.table_number}" is ${tableData.status}. Please choose another table.` 
                };
              }
              tableFound = true;
              tableId = tableDoc.id;
              tableFloorId = floorDoc.id;
              break;
            }
          }
          if (tableFound) break;
        }
        
        if (!tableFound) {
          return { success: false, error: `Table "${args.table_number}" not found` };
        }
      }

      // Generate order number and daily order ID
      const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
      
      // Generate daily order ID
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const counterRef = db.collection('daily_order_counters').doc(`${restaurantId}_${todayStr}`);
      const counterDoc = await counterRef.get();
      let dailyOrderId = 1;
      if (counterDoc.exists) {
        const counterData = counterDoc.data();
        dailyOrderId = counterData.lastOrderId + 1;
        await counterRef.update({
          lastOrderId: dailyOrderId,
          updatedAt: new Date()
        });
      } else {
        await counterRef.set({
          restaurantId,
          date: todayStr,
          lastOrderId: 1,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }

      // Get user info for staffInfo
      let staffName = 'Chatbot';
      let userRole = 'staff';
      try {
        const userRestaurantDoc = await db.collection('userRestaurants')
          .where('userId', '==', userId)
          .where('restaurantId', '==', restaurantId)
          .limit(1)
          .get();
        
        if (!userRestaurantDoc.empty) {
          const userData = userRestaurantDoc.docs[0].data();
          staffName = userData.name || 'Chatbot';
          userRole = userData.role || 'staff';
        }
      } catch (error) {
        console.error('Error fetching user info:', error);
      }

      // Create order data
      const orderData = {
        restaurantId,
        orderNumber,
        dailyOrderId,
        tableNumber: args.table_number || null,
        orderType: args.order_type || 'dine-in',
        items: orderItems,
        totalAmount,
        taxAmount,
        discountAmount: 0,
        finalAmount,
        customerInfo: {
          name: args.customer_name || 'Walk-in Customer',
          phone: args.customer_phone || null,
          email: null,
          city: null,
          seatNumber: args.table_number || 'Walk-in'
        },
        paymentMethod: args.payment_method || 'cash',
        staffInfo: {
          userId: userId,
          name: staffName,
          loginId: userId,
          role: userRole
        },
        notes: args.notes || 'Order placed via chatbot',
        status: 'confirmed',
        kotSent: false,
        paymentStatus: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Create order in database
      const orderRef = await db.collection(collections.orders).add(orderData);
      
      // AUTO-DEDUCT INVENTORY (Asynchronous - Fire and Forget)
      inventoryService.deductInventoryForOrder(restaurantId, orderRef.id, orderData.items)
        .catch(err => console.error('Agent BG Inventory Deduction Error:', err));

      // Update table status to "occupied" if table number is provided
      if (tableId && tableFloorId) {
        try {
          await db.collection('restaurants')
            .doc(restaurantId)
            .collection('floors')
            .doc(tableFloorId)
            .collection('tables')
            .doc(tableId)
            .update({
              status: 'occupied',
              currentOrderId: orderRef.id,
              lastOrderTime: new Date(),
              updatedAt: new Date()
            });
          console.log(`✅ Table ${args.table_number} status updated to occupied`);
        } catch (tableUpdateError) {
          console.error('❌ Failed to update table status:', tableUpdateError);
          // Don't fail the order if table status update fails
        }
      }

      // Create/update customer if customer info is provided
      if (args.customer_name || args.customer_phone) {
        try {
          const customerData = {
            name: args.customer_name || null,
            phone: args.customer_phone || null,
            restaurantId: restaurantId,
            orderHistory: [{
              orderId: orderRef.id,
              orderNumber: orderNumber,
              totalAmount: finalAmount,
              orderDate: new Date(),
              tableNumber: args.table_number || null
            }]
          };

          // Check if customer exists
          let customerQuery = db.collection(collections.customers || 'customers')
            .where('restaurantId', '==', restaurantId);
          
          if (args.customer_phone) {
            customerQuery = customerQuery.where('phone', '==', args.customer_phone);
          } else if (args.customer_name) {
            customerQuery = customerQuery.where('name', '==', args.customer_name);
          }

          const existingCustomer = await customerQuery.limit(1).get();
          
          if (!existingCustomer.empty) {
            // Update existing customer
            const customerDoc = existingCustomer.docs[0];
            const existingData = customerDoc.data();
            const updatedHistory = [...(existingData.orderHistory || []), customerData.orderHistory[0]];
            await customerDoc.ref.update({
              orderHistory: updatedHistory,
              totalOrders: (existingData.totalOrders || 0) + 1,
              totalSpent: (existingData.totalSpent || 0) + finalAmount,
              lastOrderDate: new Date(),
              updatedAt: new Date()
            });
          } else {
            // Create new customer
            await db.collection(collections.customers || 'customers').add({
              ...customerData,
              totalOrders: 1,
              totalSpent: finalAmount,
              lastOrderDate: new Date(),
              createdAt: new Date(),
              updatedAt: new Date()
            });
          }
        } catch (customerError) {
          console.error('Customer creation/update error:', customerError);
          // Don't fail the order if customer creation fails
        }
      }

      return {
        success: true,
        message: `Order placed successfully. Order Number: ${orderNumber}, Total: ₹${finalAmount.toFixed(2)}${taxAmount > 0 ? ` (Tax: ₹${taxAmount.toFixed(2)})` : ''}`,
        order: {
          id: orderRef.id,
          orderNumber,
          dailyOrderId,
          tableNumber: args.table_number || null,
          items: orderItems,
          totalAmount,
          taxAmount,
          finalAmount,
          status: 'confirmed'
        },
        action: 'place_order'
      };
    } catch (error) {
      console.error('Error placing order:', error);
      return { success: false, error: error.message || 'Failed to place order' };
    }
  }

  /**
   * Menu Management Functions
   */
  async addMenuItem(restaurantId, args, userId) {
    console.log(`🍽️ Adding menu item: ${args.name} to restaurant: ${restaurantId}`);
    
    // Get restaurant document
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return { success: false, error: 'Restaurant not found' };
    }

    const restaurantData = restaurantDoc.data();
    const currentMenu = restaurantData.menu || { categories: [], items: [] };

    // Create new menu item
    const newMenuItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: args.name,
      price: parseFloat(args.price),
      category: args.category,
      description: args.description || '',
      isVeg: args.is_veg || false,
      spiceLevel: args.spice_level || null,
      shortCode: args.short_code || null,
      isAvailable: true,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Add to items array
    const updatedItems = [...(currentMenu.items || []), newMenuItem];

    // Update categories
    const categories = [...(currentMenu.categories || [])];
    const categoryIndex = categories.findIndex(cat => cat.name === args.category);
    
    if (categoryIndex === -1) {
      // New category
      categories.push({
        name: args.category,
        items: [newMenuItem]
      });
    } else {
      // Existing category
      categories[categoryIndex].items = [...(categories[categoryIndex].items || []), newMenuItem];
    }

    // Update restaurant document
    await db.collection('restaurants').doc(restaurantId).update({
      menu: {
        categories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });

    // Generate recipe asynchronously
    inventoryService.createDefaultRecipe(
      restaurantId, 
      newMenuItem.id, 
      newMenuItem.name, 
      newMenuItem.description,
      userId
    ).catch(err => console.error('Agent BG Recipe Gen Error:', err));

    return {
      success: true,
      message: `Menu item "${args.name}" added successfully`,
      menuItem: newMenuItem
    };
  }

  async updateMenuItem(restaurantId, args) {
    console.log(`✏️ Updating menu item: ${args.menu_item_id}`);
    
    // Find menu item in restaurant
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return { success: false, error: 'Restaurant not found' };
    }

    const restaurantData = restaurantDoc.data();
    const currentMenu = restaurantData.menu || { categories: [], items: [] };
    
    // Find item
    const itemIndex = currentMenu.items.findIndex(item => item.id === args.menu_item_id);
    if (itemIndex === -1) {
      return { success: false, error: 'Menu item not found' };
    }

    // Update item
    const updatedItem = {
      ...currentMenu.items[itemIndex],
      ...(args.name && { name: args.name }),
      ...(args.price !== undefined && { price: parseFloat(args.price) }),
      ...(args.category && { category: args.category }),
      ...(args.description !== undefined && { description: args.description }),
      ...(args.is_veg !== undefined && { isVeg: args.is_veg }),
      ...(args.is_available !== undefined && { isAvailable: args.is_available }),
      updatedAt: new Date().toISOString()
    };

    // Update items array
    const updatedItems = [...currentMenu.items];
    updatedItems[itemIndex] = updatedItem;

    // Update categories if category changed
    let updatedCategories = [...currentMenu.categories];
    if (args.category && args.category !== currentMenu.items[itemIndex].category) {
      // Remove from old category
      const oldCategoryIndex = updatedCategories.findIndex(cat => cat.name === currentMenu.items[itemIndex].category);
      if (oldCategoryIndex !== -1) {
        updatedCategories[oldCategoryIndex].items = updatedCategories[oldCategoryIndex].items.filter(
          item => item.id !== args.menu_item_id
        );
      }
      
      // Add to new category
      const newCategoryIndex = updatedCategories.findIndex(cat => cat.name === args.category);
      if (newCategoryIndex === -1) {
        updatedCategories.push({
          name: args.category,
          items: [updatedItem]
        });
      } else {
        updatedCategories[newCategoryIndex].items.push(updatedItem);
      }
    } else {
      // Update item in existing category
      const categoryIndex = updatedCategories.findIndex(cat => cat.name === updatedItem.category);
      if (categoryIndex !== -1) {
        const itemInCategoryIndex = updatedCategories[categoryIndex].items.findIndex(
          item => item.id === args.menu_item_id
        );
        if (itemInCategoryIndex !== -1) {
          updatedCategories[categoryIndex].items[itemInCategoryIndex] = updatedItem;
        }
      }
    }

    // Update restaurant document
    await db.collection('restaurants').doc(restaurantId).update({
      menu: {
        categories: updatedCategories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });

    return {
      success: true,
      message: `Menu item "${updatedItem.name}" updated successfully`,
      menuItem: updatedItem
    };
  }

  async deleteMenuItem(restaurantId, args) {
    console.log(`🗑️ Deleting menu item: ${args.menu_item_id}`);
    
    // Find menu item in restaurant
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return { success: false, error: 'Restaurant not found' };
    }

    const restaurantData = restaurantDoc.data();
    const currentMenu = restaurantData.menu || { categories: [], items: [] };
    
    // Find item
    const itemIndex = currentMenu.items.findIndex(item => item.id === args.menu_item_id);
    if (itemIndex === -1) {
      return { success: false, error: 'Menu item not found' };
    }

    const item = currentMenu.items[itemIndex];

    // Soft delete - mark as deleted
    const deletedItem = {
      ...item,
      status: 'deleted',
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Update items array
    const updatedItems = [...currentMenu.items];
    updatedItems[itemIndex] = deletedItem;

    // Update categories
    const updatedCategories = currentMenu.categories.map(category => ({
      ...category,
      items: category.items.map(catItem => 
        catItem.id === args.menu_item_id ? deletedItem : catItem
      )
    }));

    // Update restaurant document
    await db.collection('restaurants').doc(restaurantId).update({
      menu: {
        categories: updatedCategories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });

    return {
      success: true,
      message: `Menu item "${item.name}" deleted successfully`,
      menuItem: deletedItem
    };
  }

  async searchMenuItems(restaurantId, args) {
    console.log(`🔍 Searching menu items:`, args);
    
    // Get restaurant menu
    const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return { success: false, error: 'Restaurant not found' };
    }

    const restaurantData = restaurantDoc.data();
    const menuItems = (restaurantData.menu?.items || []).filter(item => item.status !== 'deleted');

    // Apply filters
    let filteredItems = menuItems;

    if (args.search_term) {
      const searchLower = args.search_term.toLowerCase();
      filteredItems = filteredItems.filter(item =>
        item.name?.toLowerCase().includes(searchLower) ||
        item.description?.toLowerCase().includes(searchLower) ||
        item.category?.toLowerCase().includes(searchLower)
      );
    }

    if (args.category) {
      filteredItems = filteredItems.filter(item => 
        item.category?.toLowerCase() === args.category.toLowerCase()
      );
    }

    if (args.is_veg !== undefined) {
      filteredItems = filteredItems.filter(item => item.isVeg === args.is_veg);
    }

    if (args.is_available !== undefined) {
      filteredItems = filteredItems.filter(item => item.isAvailable === args.is_available);
    }

    return {
      success: true,
      menuItems: filteredItems,
      count: filteredItems.length,
      totalItems: menuItems.length
    };
  }

  /**
   * Customer Management Functions
   */
  async getCustomers(restaurantId, args) {
    console.log(`👥 Getting customers for restaurant: ${restaurantId}`);
    
    let query = db.collection(collections.customers || 'customers')
      .where('restaurantId', '==', restaurantId);

    const snapshot = await query
      .orderBy('lastOrderDate', 'desc')
      .limit(args.limit || 50)
      .get();

    let customers = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      customers.push({
        id: doc.id,
        name: data.name,
        phone: data.phone,
        email: data.email,
        city: data.city,
        totalOrders: data.totalOrders || 0,
        totalSpent: data.totalSpent || 0,
        lastOrderDate: data.lastOrderDate?.toDate?.()?.toISOString() || data.lastOrderDate
      });
    });

    // Apply search filter if provided
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      customers = customers.filter(customer =>
        customer.name?.toLowerCase().includes(searchLower) ||
        customer.phone?.includes(searchLower) ||
        customer.email?.toLowerCase().includes(searchLower)
      );
    }

    return {
      success: true,
      customers,
      count: customers.length
    };
  }

  async getCustomerById(restaurantId, args) {
    console.log(`👤 Getting customer:`, args);
    
    let customerDoc = null;

    if (args.customer_id) {
      customerDoc = await db.collection('customers').doc(args.customer_id).get();
    } else if (args.phone) {
      const snapshot = await db.collection(collections.customers || 'customers')
        .where('restaurantId', '==', restaurantId)
        .where('phone', '==', args.phone)
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        customerDoc = snapshot.docs[0];
      }
    } else if (args.email) {
      const snapshot = await db.collection(collections.customers || 'customers')
        .where('restaurantId', '==', restaurantId)
        .where('email', '==', args.email)
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        customerDoc = snapshot.docs[0];
      }
    }

    if (!customerDoc || !customerDoc.exists) {
      return { success: false, error: 'Customer not found' };
    }

    const data = customerDoc.data();
    
    // Verify restaurant access
    if (data.restaurantId !== restaurantId) {
      return { success: false, error: 'Access denied' };
    }

    return {
      success: true,
      customer: {
        id: customerDoc.id,
        name: data.name,
        phone: data.phone,
        email: data.email,
        city: data.city,
        dob: data.dob,
        totalOrders: data.totalOrders || 0,
        totalSpent: data.totalSpent || 0,
        lastOrderDate: data.lastOrderDate?.toDate?.()?.toISOString() || data.lastOrderDate,
        orderHistory: data.orderHistory || []
      }
    };
  }

  async addCustomer(restaurantId, args) {
    console.log(`➕ Adding customer:`, args);
    
    // Normalize phone number
    const normalizePhone = (phone) => {
      if (!phone) return null;
      const digits = phone.replace(/\D/g, '');
      if (digits.length === 12 && digits.startsWith('91')) {
        return digits.substring(2);
      } else if (digits.length === 10) {
        return digits;
      } else if (digits.length === 11 && digits.startsWith('0')) {
        return digits.substring(1);
      }
      return digits;
    };

    const normalizedPhone = args.phone ? normalizePhone(args.phone) : null;

    // Check if customer already exists
    let existingCustomer = null;
    if (normalizedPhone || args.email) {
      let query = db.collection(collections.customers || 'customers')
        .where('restaurantId', '==', restaurantId);
      
      if (normalizedPhone) {
        query = query.where('phone', '==', normalizedPhone);
      }
      
      const snapshot = await query.limit(1).get();
      if (!snapshot.empty) {
        existingCustomer = snapshot.docs[0];
      }
    }

    if (existingCustomer) {
      // Update existing customer
      const existingData = existingCustomer.data();
      const updatedData = {
        ...existingData,
        ...(args.name && { name: args.name }),
        ...(args.email && { email: args.email }),
        ...(args.city && { city: args.city }),
        ...(args.dob && { dob: args.dob }),
        updatedAt: new Date()
      };

      await existingCustomer.ref.update(updatedData);

      return {
        success: true,
        message: 'Customer information updated',
        customer: {
          id: existingCustomer.id,
          ...updatedData
        }
      };
    } else {
      // Create new customer
      const customerData = {
        name: args.name || null,
        phone: normalizedPhone,
        email: args.email || null,
        city: args.city || null,
        dob: args.dob || null,
        restaurantId,
        orderHistory: [],
        totalOrders: 0,
        totalSpent: 0,
        lastOrderDate: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const customerRef = await db.collection(collections.customers || 'customers').add(customerData);

      return {
        success: true,
        message: 'Customer added successfully',
        customer: {
          id: customerRef.id,
          ...customerData
        }
      };
    }
  }

  async updateCustomer(restaurantId, args) {
    console.log(`✏️ Updating customer: ${args.customer_id}`);
    
    const customerDoc = await db.collection(collections.customers || 'customers').doc(args.customer_id).get();
    if (!customerDoc.exists) {
      return { success: false, error: 'Customer not found' };
    }

    const customerData = customerDoc.data();
    
    // Verify restaurant access
    if (customerData.restaurantId !== restaurantId) {
      return { success: false, error: 'Access denied' };
    }

    const updateData = {
      ...(args.name && { name: args.name }),
      ...(args.phone && { phone: args.phone }),
      ...(args.email && { email: args.email }),
      ...(args.city && { city: args.city }),
      updatedAt: new Date()
    };

    await customerDoc.ref.update(updateData);

    return {
      success: true,
      message: 'Customer updated successfully',
      customer: {
        id: args.customer_id,
        ...customerData,
        ...updateData
      }
    };
  }

  async deleteCustomer(restaurantId, args) {
    console.log(`🗑️ Deleting customer: ${args.customer_id}`);
    
    const customerDoc = await db.collection(collections.customers || 'customers').doc(args.customer_id).get();
    if (!customerDoc.exists) {
      return { success: false, error: 'Customer not found' };
    }

    const customerData = customerDoc.data();
    
    // Verify restaurant access
    if (customerData.restaurantId !== restaurantId) {
      return { success: false, error: 'Access denied' };
    }

    await customerDoc.ref.delete();

    return {
      success: true,
      message: `Customer "${customerData.name || 'Unknown'}" deleted successfully`
    };
  }

  async getCustomerHistory(restaurantId, args) {
    console.log(`📜 Getting customer history:`, args);
    
    // First get customer
    let customerDoc = null;
    
    if (args.customer_id) {
      customerDoc = await db.collection('customers').doc(args.customer_id).get();
    } else if (args.phone) {
      const snapshot = await db.collection(collections.customers || 'customers')
        .where('restaurantId', '==', restaurantId)
        .where('phone', '==', args.phone)
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        customerDoc = snapshot.docs[0];
      }
    }

    if (!customerDoc || !customerDoc.exists) {
      return { success: false, error: 'Customer not found' };
    }

    const customerData = customerDoc.data();
    
    // Verify restaurant access
    if (customerData.restaurantId !== restaurantId) {
      return { success: false, error: 'Access denied' };
    }

    // Get order history from customer data
    const orderHistory = (customerData.orderHistory || []).slice(0, args.limit || 20);

    return {
      success: true,
      customer: {
        id: customerDoc.id,
        name: customerData.name,
        phone: customerData.phone,
        email: customerData.email
      },
      orderHistory,
      totalOrders: customerData.totalOrders || 0,
      totalSpent: customerData.totalSpent || 0
    };
  }

  // Google Reviews Management Functions
  async getGoogleReviewSettings(restaurantId) {
    console.log(`⭐ Getting Google Review settings for restaurant: ${restaurantId}`);
    
    try {
      const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();
      
      if (settingsDoc.exists) {
        const settings = settingsDoc.data();
        return {
          success: true,
          settings: {
            googleReviewUrl: settings.googleReviewUrl || '',
            aiEnabled: settings.aiEnabled !== undefined ? settings.aiEnabled : true,
            customMessage: settings.customMessage || '',
            hasQRCode: !!settings.qrCodeUrl,
            updatedAt: settings.updatedAt?.toDate?.()?.toISOString() || settings.updatedAt
          }
        };
      } else {
        return {
          success: true,
          settings: {
            googleReviewUrl: '',
            aiEnabled: true,
            customMessage: '',
            hasQRCode: false
          },
          message: 'No settings configured yet'
        };
      }
    } catch (error) {
      console.error('Error fetching Google Review settings:', error);
      return { success: false, error: 'Failed to fetch settings' };
    }
  }

  async updateGoogleReviewSettings(restaurantId, args) {
    console.log(`✏️ Updating Google Review settings:`, args);
    
    try {
      const QRCode = require('qrcode');
      
      // Normalize URL to ensure it's a write review URL
      let normalizedUrl = args.google_review_url || '';
      
      if (normalizedUrl) {
        // If it's a Place ID (long alphanumeric string), construct write review URL
        if (normalizedUrl.length > 20 && !normalizedUrl.startsWith('http') && !normalizedUrl.includes('/')) {
          normalizedUrl = `https://search.google.com/local/writereview?placeid=${normalizedUrl}`;
        }
        // If it's a Google Maps URL, try to extract Place ID
        else if (normalizedUrl.includes('maps/place/')) {
          const placeIdMatch = normalizedUrl.match(/place\/([^\/]+)/);
          if (placeIdMatch) {
            normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
          }
        }
        // If it's already a write review URL, keep it
        else if (!normalizedUrl.includes('writereview') && !normalizedUrl.includes('placeid')) {
          // If it's a regular Google Maps URL, try to extract Place ID
          const placeIdMatch = normalizedUrl.match(/placeid=([^&]+)/);
          if (placeIdMatch) {
            normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
          }
        }
      }

      const settings = {
        restaurantId,
        ...(normalizedUrl && { googleReviewUrl: normalizedUrl }),
        ...(args.ai_enabled !== undefined && { aiEnabled: args.ai_enabled }),
        ...(args.custom_message !== undefined && { customMessage: args.custom_message }),
        updatedAt: new Date()
      };

      // Generate QR code if URL is provided
      if (normalizedUrl) {
        try {
          const qrCodeDataUrl = await QRCode.toDataURL(normalizedUrl, {
            width: 400,
            margin: 2,
            color: {
              dark: '#000000',
              light: '#FFFFFF'
            }
          });
          settings.qrCodeUrl = qrCodeDataUrl;
        } catch (qrError) {
          console.error('Error generating QR code:', qrError);
        }
      }

      await db.collection('googleReviewSettings').doc(restaurantId).set(settings, { merge: true });

      return {
        success: true,
        message: 'Google Review settings updated successfully',
        settings: {
          googleReviewUrl: normalizedUrl || settings.googleReviewUrl,
          aiEnabled: args.ai_enabled !== undefined ? args.ai_enabled : settings.aiEnabled,
          customMessage: args.custom_message !== undefined ? args.custom_message : settings.customMessage,
          hasQRCode: !!settings.qrCodeUrl
        }
      };
    } catch (error) {
      console.error('Error updating Google Review settings:', error);
      return { success: false, error: 'Failed to update settings' };
    }
  }

  async generateQRCode(restaurantId, url) {
    console.log(`📱 Generating QR code for restaurant: ${restaurantId}`);
    
    try {
      const QRCode = require('qrcode');
      
      // If URL not provided, get from settings
      if (!url) {
        const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();
        if (settingsDoc.exists && settingsDoc.data().googleReviewUrl) {
          url = settingsDoc.data().googleReviewUrl;
        } else {
          return { success: false, error: 'No Google Review URL configured. Please set the URL first.' };
        }
      }

      // Normalize URL
      let normalizedUrl = url;
      if (normalizedUrl.length > 20 && !normalizedUrl.startsWith('http') && !normalizedUrl.includes('/')) {
        normalizedUrl = `https://search.google.com/local/writereview?placeid=${normalizedUrl}`;
      } else if (normalizedUrl.includes('maps/place/')) {
        const placeIdMatch = normalizedUrl.match(/place\/([^\/]+)/);
        if (placeIdMatch) {
          normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        }
      } else if (!normalizedUrl.includes('writereview') && !normalizedUrl.includes('placeid')) {
        const placeIdMatch = normalizedUrl.match(/placeid=([^&]+)/);
        if (placeIdMatch) {
          normalizedUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
        }
      }

      const qrCodeDataUrl = await QRCode.toDataURL(normalizedUrl, {
        width: 400,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      // Update settings with QR code
      await db.collection('googleReviewSettings').doc(restaurantId).set({
        restaurantId,
        qrCodeUrl: qrCodeDataUrl,
        googleReviewUrl: normalizedUrl,
        updatedAt: new Date()
      }, { merge: true });

      return {
        success: true,
        message: 'QR code generated successfully',
        hasQRCode: true,
        reviewUrl: normalizedUrl
      };
    } catch (error) {
      console.error('Error generating QR code:', error);
      return { success: false, error: 'Failed to generate QR code' };
    }
  }

  async generateReviewContent(restaurantId, customerName, rating) {
    console.log(`🤖 Generating AI review content for: ${customerName}, Rating: ${rating}`);
    
    try {
      // Fetch restaurant details
      const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      if (!restaurantDoc.exists) {
        return { success: false, error: 'Restaurant not found' };
      }

      const restaurantData = restaurantDoc.data();
      const restaurantName = restaurantData.name || 'this restaurant';
      const cuisine = restaurantData.cuisine || [];
      const address = restaurantData.address || '';

      // Generate AI review content
      const aiPrompt = `Generate a genuine, authentic Google review for a restaurant. The review should:
- Be natural and conversational (not overly promotional)
- Mention specific positive aspects (food quality, service, ambiance, value)
- Be appropriate for a ${rating || 5}-star rating
- Be between 50-200 words
- Sound like a real customer wrote it
- Follow Google Review guidelines (honest, helpful, relevant)

Restaurant Details:
- Name: ${restaurantName}
- Cuisine: ${cuisine.join(', ') || 'Various'}
- Location: ${address}

Customer Name: ${customerName}
Rating: ${rating || 5} stars

Generate a review that feels authentic and would be helpful to other customers. Return only the review text, no additional formatting.`;

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that generates authentic, genuine restaurant reviews that sound like real customers wrote them. Reviews should be honest, helpful, and follow Google Review guidelines.'
          },
          {
            role: 'user',
            content: aiPrompt
          }
        ],
        temperature: 0.8,
        max_tokens: 300
      });

      const reviewContent = completion.choices[0].message.content.trim();

      return {
        success: true,
        reviewContent,
        customerName,
        rating,
        message: 'Review content generated successfully'
      };
    } catch (error) {
      console.error('Error generating AI review content:', error);
      return { success: false, error: 'Failed to generate review content' };
    }
  }

  async getReviewLink(restaurantId, placeId) {
    console.log(`🔗 Getting review link for restaurant: ${restaurantId}`);
    
    try {
      const settingsDoc = await db.collection('googleReviewSettings').doc(restaurantId).get();
      const savedUrl = settingsDoc.exists ? settingsDoc.data().googleReviewUrl : null;

      let reviewUrl = '';

      if (placeId) {
        // If placeId is provided, construct the write review URL
        reviewUrl = `https://search.google.com/local/writereview?placeid=${placeId}`;
      } else if (savedUrl) {
        // Use saved URL, but ensure it's a write review URL
        if (savedUrl.includes('writereview') || savedUrl.includes('placeid')) {
          reviewUrl = savedUrl;
        } else if (savedUrl.includes('maps/place/')) {
          const placeIdMatch = savedUrl.match(/place\/([^\/]+)/);
          if (placeIdMatch) {
            reviewUrl = `https://search.google.com/local/writereview?placeid=${placeIdMatch[1]}`;
          } else {
            reviewUrl = savedUrl;
          }
        } else if (savedUrl.length > 20 && !savedUrl.startsWith('http')) {
          reviewUrl = `https://search.google.com/local/writereview?placeid=${savedUrl}`;
        } else {
          reviewUrl = savedUrl;
        }
      } else {
        return { success: false, error: 'No Google Review URL or Place ID configured. Please add a Place ID or direct URL in settings.' };
      }

      return {
        success: true,
        reviewUrl,
        message: 'Review link retrieved successfully'
      };
    } catch (error) {
      console.error('Error getting review link:', error);
      return { success: false, error: 'Failed to get review link' };
    }
  }

  /**
   * Process user query using OpenAI function calling
   */
  async processQuery(query, restaurantId, userId, conversationHistory = []) {
    try {
      // Fetch context (minimal for cost efficiency)
      const sessionSummary = await this.getSessionSummary(userId, restaurantId);
      const relevantFacts = await this.getRelevantFacts(query, restaurantId);
      const systemState = await this.getSystemState(restaurantId, query);

      // Build messages for OpenAI
      const messages = [
        {
          role: 'system',
          content: `You are "DineAgent", an intelligent restaurant operations assistant connected to the restaurant's backend APIs and Firestore database.

Your goals:
1. Answer questions and take actions related to restaurant operations — orders, tables, reservations, customers, billing, and menu.
2. Use facts provided under "Relevant facts" for static info (menu, FAQs, policies).
3. Use "System state" data for dynamic info (orders, tables, etc.).
4. Always respond concisely, clearly, and politely.
5. When an action is needed, return a structured function call (do not make up data). The backend will execute it.
6. Remember the user's stable preferences and use them for personalized responses (from SessionSummary).

---

### 🔧 Context structure you will receive:
- **SessionSummary:** ${sessionSummary}
- **Relevant facts:** ${JSON.stringify(relevantFacts)}
- **System state:** ${JSON.stringify(systemState)}
- **Recent conversation:** Last ${conversationHistory.length} messages

---

### 💬 Behavior rules:
- **IMPORTANT: Context Awareness**: When a user says "check again", "what about...", "and...", "also...", or similar follow-up phrases, you MUST understand they are referring to the previous topic in the conversation. Look at the conversation history to understand what was discussed.
- If the user previously asked about tables and now says "check again", they want you to check tables again using the get_tables function.
- If the user previously asked about orders and now says "what about pending ones", they want pending orders.
- Never hallucinate; if you lack info, ask clarifying questions.
- Use exact prices, menu items, or table details only if provided in context or system state.
- Be concise — 1–3 sentences unless a longer explanation is necessary.
- Use friendly tone suitable for restaurant staff or owners.
- If a user greets you, greet them back by name (if known from SessionSummary).
- Don't show JSON, code, or internal system text to the user — only natural language output.

---

### ⚙️ Function calling:
When the user's intent is to perform an action, use the appropriate function. Always execute the function call - do not just describe what you would do.
For follow-up queries like "check again", "what about X", always call the relevant function to get fresh data.`
        },
        ...conversationHistory.slice(-8), // Last 8 messages for better context
        {
          role: 'user',
          content: query
        }
      ];

      // Call OpenAI with function calling
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', // Use mini for cost efficiency
        messages,
        tools: this.functions,
        tool_choice: 'auto', // Let model decide when to use functions
        temperature: 0.7,
        max_tokens: 500 // Limit response length
      });

      const message = response.choices[0].message;

      // Check if function call was made
      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolCall = message.tool_calls[0];
        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        console.log(`🔧 Function call detected: ${functionName}`, functionArgs);

        // Execute function
        const functionResult = await this.executeFunction(
          functionName,
          functionArgs,
          restaurantId,
          userId
        );

        // Send function result back to GPT for natural language response
        const followUpMessages = [
          ...messages,
          message,
          {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(functionResult)
          }
        ];

        const finalResponse = await this.openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: followUpMessages,
          temperature: 0.7,
          max_tokens: 300 // Keep response concise
        });

        const finalMessage = finalResponse.choices[0].message.content;

        return {
          success: true,
          response: finalMessage,
          functionCalled: functionName,
          functionResult,
          hasData: true,
          data: functionResult
        };
      } else {
        // Direct text response
        return {
          success: true,
          response: message.content,
          functionCalled: null
        };
      }
    } catch (error) {
      console.error('Function calling agent error:', error);
      
      // Provide more helpful error messages
      let errorMessage = 'Sorry, I encountered an error. Please try again.';
      
      if (error.message.includes('Access denied')) {
        errorMessage = 'Access denied: You do not have permission to perform this action.';
      } else if (error.message.includes('not found')) {
        errorMessage = error.message;
      } else if (error.message.includes('Invalid schema')) {
        errorMessage = 'There was an issue with the request format. Please try rephrasing your request.';
      } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
        errorMessage = 'Service temporarily unavailable. Please try again in a moment.';
      }
      
      return {
        success: false,
        error: error.message,
        response: errorMessage
      };
    }
  }
}

module.exports = FunctionCallingAgent;

