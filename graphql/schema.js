const { gql } = require('graphql-tag');

// Comprehensive GraphQL Schema for Restaurant Management System
const typeDefs = gql`
  # Scalar Types
  scalar Date
  scalar JSON

  # Enums
  enum OrderStatus {
    PENDING
    PREPARING
    READY
    COMPLETED
    CANCELLED
  }

  enum TableStatus {
    AVAILABLE
    OCCUPIED
    RESERVED
    CLEANING
    MAINTENANCE
  }

  enum PaymentMethod {
    CASH
    CARD
    UPI
    ONLINE
  }

  enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
  }

  enum UserRole {
    OWNER
    MANAGER
    ADMIN
    STAFF
    WAITER
  }

  enum InventoryCategory {
    VEGETABLES
    MEAT
    DAIRY
    SPICES
    BEVERAGES
    PACKAGED
    OTHER
  }

  enum FeedbackCategory {
    FOOD_QUALITY
    SERVICE
    AMBIANCE
    VALUE
    OTHER
  }

  # Input Types
  input CreateTableInput {
    name: String!
    floor: String!
    capacity: Int
    section: String
    restaurantId: ID!
  }

  input UpdateTableInput {
    name: String
    floor: String
    capacity: Int
    section: String
    status: TableStatus
  }

  input BookTableInput {
    tableId: ID!
    customerName: String!
    customerPhone: String!
    bookingDate: String!
    bookingTime: String!
    partySize: Int!
    notes: String
  }

  input CreateCustomerInput {
    name: String
    phone: String
    email: String
    city: String
    address: String
    dob: Date
  }

  input UpdateCustomerInput {
    name: String
    phone: String
    email: String
    city: String
    address: String
    dob: Date
  }

  input CreateOrderInput {
    tableNumber: String
    customer: CustomerInput
    items: [OrderItemInput!]!
    notes: String
    paymentMethod: PaymentMethod
    expressBilling: Boolean
    restaurantId: ID!
  }

  input UpdateOrderInput {
    tableNumber: String
    items: [OrderItemInput!]
    notes: String
    paymentMethod: PaymentMethod
    customerInfo: CustomerInput
  }

  input PaymentInput {
    orderId: ID!
    paymentMethod: PaymentMethod!
    amount: Float!
    transactionId: String
    notes: String
  }

  input CustomerInput {
    name: String
    phone: String
    email: String
  }

  input OrderItemInput {
    menuItemId: ID!
    quantity: Int!
  }

  input CreateMenuItemInput {
    name: String!
    price: Float!
    category: String!
    description: String
    shortCode: String
    isVeg: Boolean
    isAvailable: Boolean
    image: String
    preparationTime: Int
    ingredients: [String]
    allergens: [String]
  }

  input UpdateMenuItemInput {
    name: String
    price: Float
    category: String
    description: String
    shortCode: String
    isVeg: Boolean
    isAvailable: Boolean
    image: String
    preparationTime: Int
    ingredients: [String]
    allergens: [String]
  }

  input CreateInventoryInput {
    name: String!
    category: InventoryCategory!
    unit: String!
    currentStock: Float
    minStock: Float
    maxStock: Float
    costPerUnit: Float
    supplierId: String
    location: String
    barcode: String
    expiryDate: Date
  }

  input UpdateInventoryInput {
    name: String
    category: InventoryCategory
    unit: String
    currentStock: Float
    minStock: Float
    maxStock: Float
    costPerUnit: Float
    supplierId: String
    location: String
    barcode: String
    expiryDate: Date
  }

  input RestaurantSettingsInput {
    openTime: String
    closeTime: String
    lastOrderTime: String
    taxSettings: TaxSettingsInput
    features: FeatureSettingsInput
    notifications: NotificationSettingsInput
  }

  input TaxSettingsInput {
    enabled: Boolean
    rate: Float
    type: String
  }

  input FeatureSettingsInput {
    inventoryManagement: Boolean
    customerLoyalty: Boolean
    analytics: Boolean
    multiRestaurant: Boolean
  }

  input NotificationSettingsInput {
    emailNotifications: Boolean
    smsNotifications: Boolean
    pushNotifications: Boolean
  }

  # Main Types
  type Query {
    # Restaurant Info
    restaurant(restaurantId: ID!): Restaurant
    
    # Tables
    tables(restaurantId: ID!, status: TableStatus, floor: String): [Table!]!
    table(id: ID!): Table
    
    # Orders
    orders(restaurantId: ID!, status: OrderStatus, tableNumber: String, waiterId: String): [Order!]!
    order(id: ID!): Order
    orderHistory(restaurantId: ID!, customerId: String, dateRange: String): [Order!]!
    
    # Customers
    customers(restaurantId: ID!, search: String): [Customer!]!
    customer(id: ID!): Customer
    
    # Menu
    menu(restaurantId: ID!, category: String, isAvailable: Boolean): Menu
    
    # Inventory
    inventory(restaurantId: ID!, category: InventoryCategory, lowStock: Boolean): [InventoryItem!]!
    inventoryItem(id: ID!): InventoryItem
    
    # Analytics
    analytics(restaurantId: ID!, period: String!, dateRange: String): Analytics
    
    # Staff
    staff(restaurantId: ID!, role: UserRole): [Staff!]!
    
    # Invoices
    invoices(restaurantId: ID!, orderId: String, dateRange: String): [Invoice!]!
    
    # Feedback
    feedback(restaurantId: ID!, category: FeedbackCategory, rating: Int): [Feedback!]!
    conversation(userId: ID!, restaurantId: ID!): Conversation
    
    # System
    systemInfo: SystemInfo
    userPermissions(userId: ID!, restaurantId: ID!): UserPermissions
  }

  type Mutation {
    # Table Operations
    createTable(input: CreateTableInput!): Table!
    updateTable(id: ID!, input: UpdateTableInput!): Table!
    updateTableStatus(id: ID!, status: TableStatus!): Table!
    deleteTable(id: ID!): Boolean!
    bookTable(input: BookTableInput!): Table!
    
    # Customer Operations
    createCustomer(input: CreateCustomerInput!): Customer!
    updateCustomer(id: ID!, input: UpdateCustomerInput!): Customer!
    deleteCustomer(id: ID!): Boolean!
    
    # Order Operations
    createOrder(input: CreateOrderInput!): Order!
    updateOrder(id: ID!, input: UpdateOrderInput!): Order!
    updateOrderStatus(id: ID!, status: OrderStatus!): Order!
    updateOrderItems(id: ID!, items: [OrderItemInput!]!): Order!
    cancelOrder(id: ID!, reason: String): Order!
    completeOrder(id: ID!): Order!
    processPayment(input: PaymentInput!): Order!
    searchOrders(restaurantId: ID!, searchTerm: String!): [Order!]!
    
    # Menu Operations
    createMenuItem(input: CreateMenuItemInput!): MenuItem!
    updateMenuItem(id: ID!, input: UpdateMenuItemInput!): MenuItem!
    deleteMenuItem(id: ID!): Boolean!
    
    # Inventory Operations
    createInventoryItem(input: CreateInventoryInput!): InventoryItem!
    updateInventoryItem(id: ID!, input: UpdateInventoryInput!): InventoryItem!
    updateStock(id: ID!, quantity: Float!, operation: String!): InventoryItem!
    deleteInventoryItem(id: ID!): Boolean!
    
    # Restaurant Operations
    updateRestaurantSettings(input: RestaurantSettingsInput!): Restaurant!
    
    # System Operations
    logout: Boolean!
    generateReport(type: String!, period: String!): Report!
    
    # Conversation Operations
    saveConversationMessage(userId: ID!, restaurantId: ID!, role: MessageRole!, content: String!, metadata: JSON): Conversation!
    updateConversationContext(userId: ID!, restaurantId: ID!, context: JSON!): Conversation!
  }

  # Subscription Types
  type Subscription {
    orderStatusChanged(restaurantId: ID!): Order!
    tableStatusChanged(restaurantId: ID!): Table!
    newOrder(restaurantId: ID!): Order!
    inventoryAlert(restaurantId: ID!): InventoryItem!
  }

  # Core Types
  type Restaurant {
    id: ID!
    name: String!
    description: String
    address: String
    phone: String
    email: String
    cuisine: [String]
    settings: RestaurantSettings
    menu: Menu
    tables: [Table!]!
    floors: [Floor!]!
    createdAt: Date!
    updatedAt: Date!
  }

  type RestaurantSettings {
    openTime: String
    closeTime: String
    lastOrderTime: String
    taxSettings: TaxSettings
    features: FeatureSettings
    notifications: NotificationSettings
  }

  type TaxSettings {
    enabled: Boolean!
    rate: Float!
    type: String!
  }

  type FeatureSettings {
    inventoryManagement: Boolean!
    customerLoyalty: Boolean!
    analytics: Boolean!
    multiRestaurant: Boolean!
  }

  type NotificationSettings {
    emailNotifications: Boolean!
    smsNotifications: Boolean!
    pushNotifications: Boolean!
  }

  type Table {
    id: ID!
    name: String!
    floor: String!
    capacity: Int!
    section: String!
    status: TableStatus!
    currentOrderId: String
    currentOrder: Order
    lastOrderTime: Date
    waiterId: String
    waiter: Staff
    revenue: RevenueStats
    ordersCount: Int
    createdAt: Date!
    updatedAt: Date!
  }

  type Floor {
    id: ID!
    name: String!
    description: String
    capacity: Int!
    tables: [Table!]!
    createdAt: Date!
    updatedAt: Date!
  }

  type Order {
    id: ID!
    orderNumber: String!
    restaurantId: ID!
    items: [OrderItem!]!
    totalAmount: Float!
    taxAmount: Float!
    discountAmount: Float!
    finalAmount: Float!
    customer: Customer
    tableNumber: String
    table: Table
    status: OrderStatus!
    waiterId: String!
    waiterName: String!
    waiter: Staff
    paymentMethod: PaymentMethod
    paymentStatus: PaymentStatus
    expressBilling: Boolean
    notes: String
    createdAt: Date!
    updatedAt: Date!
    completedAt: Date
  }

  type OrderItem {
    id: String!
    name: String!
    price: Float!
    quantity: Int!
    category: String
    shortCode: String
    isVeg: Boolean
    totalPrice: Float!
  }

  type Customer {
    id: ID!
    name: String
    phone: String
    email: String
    city: String
    address: String
    dob: Date
    orderHistory: [Order!]!
    totalSpent: Float!
    lastVisit: Date
    loyaltyPoints: Int
    createdAt: Date!
    updatedAt: Date!
  }

  type Menu {
    items: [MenuItem!]!
    categories: [String!]!
  }

  type MenuItem {
    id: ID!
    name: String!
    price: Float!
    category: String!
    description: String
    shortCode: String
    isVeg: Boolean!
    isAvailable: Boolean!
    image: String
    preparationTime: Int
    ingredients: [String]
    allergens: [String]
    createdAt: Date!
    updatedAt: Date!
  }

  type InventoryItem {
    id: ID!
    name: String!
    category: InventoryCategory!
    unit: String!
    currentStock: Float!
    minStock: Float!
    maxStock: Float!
    costPerUnit: Float
    supplierId: String
    supplier: Supplier
    location: String
    barcode: String
    expiryDate: Date
    isLowStock: Boolean!
    createdAt: Date!
    updatedAt: Date!
  }

  type Supplier {
    id: ID!
    name: String!
    contactPerson: String
    phone: String
    email: String
    address: String
    paymentTerms: String
    notes: String
    createdAt: Date!
    updatedAt: Date!
  }

  type Staff {
    id: ID!
    name: String!
    email: String
    phone: String
    role: UserRole!
    permissions: [String!]!
    isActive: Boolean!
    createdAt: Date!
    updatedAt: Date!
  }

  type Analytics {
    period: String!
    revenue: RevenueAnalytics!
    orders: OrderAnalytics!
    customers: CustomerAnalytics!
    inventory: InventoryAnalytics!
    tables: TableAnalytics!
    popularItems: [PopularItem!]!
    peakHours: [PeakHour!]!
  }

  type RevenueAnalytics {
    total: Float!
    byPaymentMethod: [PaymentMethodRevenue!]!
    byHour: [HourlyRevenue!]!
    byDay: [DailyRevenue!]!
    growth: Float!
  }

  type OrderAnalytics {
    total: Int!
    averageValue: Float!
    byStatus: [StatusCount!]!
    byWaiter: [WaiterStats!]!
    growth: Float!
  }

  type CustomerAnalytics {
    total: Int!
    newCustomers: Int!
    returningCustomers: Int!
    averageOrderValue: Float!
    loyaltyPoints: LoyaltyStats!
  }

  type InventoryAnalytics {
    lowStockItems: [InventoryItem!]!
    topMovingItems: [MovingItem!]!
    totalValue: Float!
  }

  type TableAnalytics {
    occupancyRate: Float!
    averageTurnoverTime: Float!
    byFloor: [FloorStats!]!
  }

  type RevenueStats {
    today: Float!
    thisWeek: Float!
    thisMonth: Float!
    total: Float!
  }

  type PopularItem {
    name: String!
    quantity: Int!
    revenue: Float!
    category: String!
  }

  type PeakHour {
    hour: Int!
    orders: Int!
    revenue: Float!
  }

  type PaymentMethodRevenue {
    method: PaymentMethod!
    amount: Float!
    percentage: Float!
  }

  type HourlyRevenue {
    hour: Int!
    amount: Float!
  }

  type DailyRevenue {
    date: Date!
    amount: Float!
  }

  type StatusCount {
    status: OrderStatus!
    count: Int!
  }

  type WaiterStats {
    waiterName: String!
    count: Int!
    revenue: Float!
  }

  type LoyaltyStats {
    total: Int!
    redeemed: Int!
    active: Int!
  }

  type MovingItem {
    name: String!
    quantitySold: Float!
    revenue: Float!
  }

  type FloorStats {
    floor: String!
    occupancyRate: Float!
    revenue: Float!
  }

  type Invoice {
    id: ID!
    orderId: ID!
    order: Order
    invoiceNumber: String!
    subtotal: Float!
    taxBreakdown: [TaxBreakdown!]!
    total: Float!
    generatedBy: String!
    generatedAt: Date!
    customer: Customer
    items: [OrderItem!]!
  }

  type TaxBreakdown {
    type: String!
    rate: Float!
    amount: Float!
  }

  type Feedback {
    id: ID!
    orderId: ID!
    order: Order
    customerId: ID!
    customer: Customer
    rating: Int!
    comment: String
    category: FeedbackCategory!
    createdAt: Date!
    updatedAt: Date!
  }

  type Report {
    id: ID!
    type: String!
    period: String!
    data: JSON!
    generatedAt: Date!
    generatedBy: String!
  }

  type Conversation {
    id: ID!
    userId: ID!
    restaurantId: ID!
    messages: [ConversationMessage!]!
    context: ConversationContext
    createdAt: Date!
    updatedAt: Date!
  }

  type ConversationMessage {
    id: ID!
    role: MessageRole!
    content: String!
    timestamp: Date!
    metadata: JSON
  }

  type ConversationContext {
    currentOrder: Order
    lastTableNumber: String
    lastCustomerName: String
    lastCustomerPhone: String
    preferences: JSON
  }

  enum MessageRole {
    USER
    ASSISTANT
    SYSTEM
  }

  type SystemInfo {
    version: String!
    uptime: String!
    database: String!
    features: [String!]!
  }

  type UserPermissions {
    userId: ID!
    restaurantId: ID!
    role: UserRole!
    permissions: [String!]!
    canRead: Boolean!
    canWrite: Boolean!
    canDelete: Boolean!
    canAdmin: Boolean!
  }
`;

module.exports = { typeDefs };
