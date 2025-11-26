const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
require('dotenv').config();

let db;

console.log('🔧 Initializing Firebase Admin...');

try {
  // Initialize Firebase Admin using your pattern
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    })
  });
  
  console.log('✅ Firebase Admin initialized successfully');
  
  // Use named database "dine" like your "esigntap" pattern
  db = getFirestore(undefined, 'dine');
  console.log('🎯 Using Firestore database: "dine"');
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
  console.error('Please check your Firebase environment variables');
  process.exit(1);
}

const collections = {
  users: 'users',
  restaurants: 'restaurants',
  menus: 'menus',
  menuItems: 'menuItems',
  orders: 'orders',
  payments: 'payments',
  inventory: 'inventory',
  suppliers: 'suppliers',
  recipes: 'recipes',
  purchaseOrders: 'purchaseOrders',
  analytics: 'analytics',
  feedback: 'feedback',
  loyalty: 'loyalty',
  tables: 'tables',
  floors: 'floors',
  bookings: 'bookings',
  userRestaurants: 'userRestaurants',
  restaurantSettings: 'restaurantSettings',
  discountSettings: 'discountSettings',
  customers: 'customers',
  // SCM Collections
  purchaseRequisitions: 'purchase-requisitions',
  goodsReceiptNotes: 'goods-receipt-notes',
  supplierInvoices: 'supplier-invoices',
  supplierReturns: 'supplier-returns',
  stockTransfers: 'stock-transfers',
  poTemplates: 'po-templates',
  supplierQuotations: 'supplier-quotations',
  supplierPerformance: 'supplier-performance',
  aiUsage: 'aiUsage',
  // Automation & Loyalty Collections
  automations: 'automations',
  automationTemplates: 'automation-templates',
  automationSettings: 'automation-settings',
  automationLogs: 'automation-logs',
  coupons: 'coupons',
  customerSegments: 'customer-segments'
};

const admin = null; // We don't need the legacy admin object anymore

module.exports = {
  admin,
  db,
  collections
};