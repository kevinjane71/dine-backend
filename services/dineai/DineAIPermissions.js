/**
 * DineAI Permissions Service
 * Role-based access control for DineAI voice assistant
 */

const ROLE_PERMISSIONS = {
  owner: {
    // Order Management
    get_orders: true,
    get_order_by_id: true,
    place_order: true,
    update_order: true,
    cancel_order: true,
    update_order_status: true,
    complete_billing: true,

    // Table Management
    get_tables: true,
    get_table_status: true,
    reserve_table: true,
    update_table_status: true,
    get_table_order: true,

    // Menu Operations
    get_menu: true,
    search_menu_items: true,
    get_item_availability: true,
    add_menu_item: true,
    update_menu_item: true,
    toggle_item_availability: true,

    // Knowledge Base
    search_knowledge: true,
    get_restaurant_info: true,

    // Inventory
    get_inventory: true,
    update_inventory: true,
    get_inventory_alerts: true,

    // Analytics
    get_today_summary: true,
    get_sales_summary: true,
    get_analytics: true,

    // Customer Management
    get_customers: true,
    get_customer_by_id: true,
    add_customer: true,
    update_customer: true,

    dailyLimit: 1000
  },

  manager: {
    // Order Management
    get_orders: true,
    get_order_by_id: true,
    place_order: true,
    update_order: true,
    cancel_order: true,
    update_order_status: true,
    complete_billing: true,

    // Table Management
    get_tables: true,
    get_table_status: true,
    reserve_table: true,
    update_table_status: true,
    get_table_order: true,

    // Menu Operations
    get_menu: true,
    search_menu_items: true,
    get_item_availability: true,
    add_menu_item: true,
    update_menu_item: true,
    toggle_item_availability: true,

    // Knowledge Base
    search_knowledge: true,
    get_restaurant_info: true,

    // Inventory
    get_inventory: true,
    update_inventory: true,
    get_inventory_alerts: true,

    // Analytics (view only)
    get_today_summary: true,
    get_sales_summary: true,
    get_analytics: false,

    // Customer Management
    get_customers: true,
    get_customer_by_id: true,
    add_customer: true,
    update_customer: true,

    dailyLimit: 500
  },

  employee: {
    // Order Management
    get_orders: true,
    get_order_by_id: true,
    place_order: true,
    update_order: true, // Employees can add items/instructions to orders
    cancel_order: false,
    update_order_status: true,
    complete_billing: false,

    // Table Management
    get_tables: true,
    get_table_status: true,
    reserve_table: true,
    update_table_status: true,
    get_table_order: true,

    // Menu Operations
    get_menu: true,
    search_menu_items: true,
    get_item_availability: true,
    add_menu_item: false,
    update_menu_item: false,
    toggle_item_availability: false,

    // Knowledge Base
    search_knowledge: true,
    get_restaurant_info: true,

    // Inventory (view only)
    get_inventory: true,
    update_inventory: false,
    get_inventory_alerts: false,

    // Analytics
    get_today_summary: false,
    get_sales_summary: false,
    get_analytics: false,

    // Customer Management
    get_customers: true,
    get_customer_by_id: true,
    add_customer: true,
    update_customer: false,

    dailyLimit: 200
  },

  waiter: {
    // Order Management
    get_orders: true,
    get_order_by_id: true,
    place_order: true,
    update_order: true, // Waiters can add items/instructions to orders
    cancel_order: false,
    update_order_status: false,
    complete_billing: false,

    // Table Management
    get_tables: true,
    get_table_status: true,
    reserve_table: false,
    update_table_status: true,
    get_table_order: true,

    // Menu Operations
    get_menu: true,
    search_menu_items: true,
    get_item_availability: true,
    add_menu_item: false,
    update_menu_item: false,
    toggle_item_availability: false,

    // Knowledge Base
    search_knowledge: true,
    get_restaurant_info: true,

    // Inventory
    get_inventory: false,
    update_inventory: false,
    get_inventory_alerts: false,

    // Analytics
    get_today_summary: false,
    get_sales_summary: false,
    get_analytics: false,

    // Customer Management
    get_customers: false,
    get_customer_by_id: false,
    add_customer: false,
    update_customer: false,

    dailyLimit: 150
  },

  cashier: {
    // Order Management
    get_orders: true,
    get_order_by_id: true,
    place_order: false,
    update_order: false,
    cancel_order: false,
    update_order_status: false,
    complete_billing: true,

    // Table Management
    get_tables: true,
    get_table_status: true,
    reserve_table: false,
    update_table_status: false,
    get_table_order: true,

    // Menu Operations
    get_menu: true,
    search_menu_items: true,
    get_item_availability: true,
    add_menu_item: false,
    update_menu_item: false,
    toggle_item_availability: false,

    // Knowledge Base
    search_knowledge: true,
    get_restaurant_info: true,

    // Inventory
    get_inventory: false,
    update_inventory: false,
    get_inventory_alerts: false,

    // Analytics (view only)
    get_today_summary: true,
    get_sales_summary: true,
    get_analytics: false,

    // Customer Management
    get_customers: true,
    get_customer_by_id: true,
    add_customer: false,
    update_customer: false,

    dailyLimit: 150
  }
};

class DineAIPermissions {
  /**
   * Get permissions for a specific role
   * @param {string} role - User role
   * @returns {Object} Role permissions
   */
  getPermissionsForRole(role) {
    const normalizedRole = (role || 'employee').toLowerCase();
    return ROLE_PERMISSIONS[normalizedRole] || ROLE_PERMISSIONS.employee;
  }

  /**
   * Check if a role has permission for a specific tool
   * @param {string} role - User role
   * @param {string} toolName - Name of the tool/function
   * @returns {boolean} Whether the role has permission
   */
  hasPermission(role, toolName) {
    const permissions = this.getPermissionsForRole(role);
    return permissions[toolName] === true;
  }

  /**
   * Get the daily usage limit for a role
   * @param {string} role - User role
   * @returns {number} Daily limit
   */
  getDailyLimit(role) {
    const permissions = this.getPermissionsForRole(role);
    return permissions.dailyLimit || 100;
  }

  /**
   * Filter tools based on role permissions
   * @param {Array} allTools - All available tools
   * @param {string} role - User role
   * @returns {Array} Filtered tools for the role
   */
  filterToolsForRole(allTools, role) {
    const permissions = this.getPermissionsForRole(role);

    return allTools.filter(tool => {
      const functionName = tool.function?.name || tool.name;
      return permissions[functionName] === true;
    });
  }

  /**
   * Get all allowed tool names for a role
   * @param {string} role - User role
   * @returns {Array<string>} List of allowed tool names
   */
  getAllowedTools(role) {
    const permissions = this.getPermissionsForRole(role);
    const allowedTools = [];

    for (const [key, value] of Object.entries(permissions)) {
      if (value === true && key !== 'dailyLimit') {
        allowedTools.push(key);
      }
    }

    return allowedTools;
  }

  /**
   * Get a human-readable description of role capabilities
   * @param {string} role - User role
   * @returns {string} Description of capabilities
   */
  getRoleCapabilitiesDescription(role) {
    const permissions = this.getPermissionsForRole(role);
    const capabilities = [];

    // Order capabilities
    if (permissions.place_order) capabilities.push('place orders');
    if (permissions.update_order) capabilities.push('modify orders');
    if (permissions.cancel_order) capabilities.push('cancel orders');
    if (permissions.complete_billing) capabilities.push('process payments');

    // Table capabilities
    if (permissions.reserve_table) capabilities.push('make reservations');
    if (permissions.update_table_status) capabilities.push('update table status');

    // Menu capabilities
    if (permissions.add_menu_item) capabilities.push('add menu items');
    if (permissions.update_menu_item) capabilities.push('update menu items');

    // Analytics capabilities
    if (permissions.get_sales_summary) capabilities.push('view sales data');
    if (permissions.get_analytics) capabilities.push('view analytics');

    // Inventory capabilities
    if (permissions.update_inventory) capabilities.push('manage inventory');

    return capabilities.join(', ');
  }
}

module.exports = new DineAIPermissions();
