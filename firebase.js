const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, connectFirestoreEmulator } = require('firebase-admin/firestore');
require('dotenv').config();

let db;
let isInitialized = false;

console.log('🔧 Initializing Firebase Admin...');

// Optimize Firebase initialization for Vercel serverless
function initializeFirebase() {
  if (isInitialized && db) {
    return db;
  }

  try {
    // Check if already initialized (for Vercel serverless reuse)
    try {
      db = getFirestore(undefined, 'dine');
      if (db) {
        isInitialized = true;
        console.log('✅ Firebase Admin reused (serverless optimization)');
        return db;
      }
    } catch (e) {
      // Not initialized yet, continue
    }

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
    
    // Optimize Firestore settings for better performance
    // These settings help reduce latency, especially from India to US regions
    db.settings({
      // Enable offline persistence (not available in serverless, but helps with connection reuse)
      ignoreUndefinedProperties: true,
    });
    
    isInitialized = true;
  console.log('🎯 Using Firestore database: "dine"');
    
    return db;
} catch (error) {
    // If already initialized, return existing instance
    if (error.code === 'app/duplicate-app') {
      db = getFirestore(undefined, 'dine');
      isInitialized = true;
      console.log('✅ Firebase Admin reused (duplicate app detected)');
      return db;
    }
    
  console.error('❌ Firebase initialization error:', error.message);
  console.error('Please check your Firebase environment variables');
    throw error;
  }
}

// Initialize on module load
db = initializeFirebase();

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

// Export getter function to ensure initialization
function getDb() {
  if (!db || !isInitialized) {
    db = initializeFirebase();
  }
  return db;
}

module.exports = {
  admin,
  get db() {
    return getDb();
  },
  getDb, // Export getter for lazy initialization
  collections
};