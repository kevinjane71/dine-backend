const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, connectFirestoreEmulator } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
require('dotenv').config();

let db;
let firestoreDb; // raw Firestore ref (kept for RTDB, auth, and pgAdapter fallback)
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
      firestoreDb = getFirestore(undefined, 'dine');
      if (firestoreDb) {
        isInitialized = true;
        console.log('✅ Firebase Admin reused (serverless optimization)');
        db = firestoreDb;
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
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });

  console.log('✅ Firebase Admin initialized successfully');

  // Use named database "dine" like your "esigntap" pattern
  firestoreDb = getFirestore(undefined, 'dine');

    // Optimize Firestore settings for better performance
    // These settings help reduce latency, especially from India to US regions
    firestoreDb.settings({
      // Enable offline persistence (not available in serverless, but helps with connection reuse)
      ignoreUndefinedProperties: true,
    });

    isInitialized = true;
  console.log('🎯 Using Firestore database: "dine"');

    db = firestoreDb;
    return db;
} catch (error) {
    // If already initialized, return existing instance
    if (error.code === 'app/duplicate-app') {
      firestoreDb = getFirestore(undefined, 'dine');
      db = firestoreDb;
      isInitialized = true;
      console.log('✅ Firebase Admin reused (duplicate app detected)');
      return db;
    }

  console.error('❌ Firebase initialization error:', error.message);
  console.error('Please check your Firebase environment variables');
    throw error;
  }
}

// ── Offline (Postgres-only) boot guard ──────────────────────────────────────
// A local/offline server runs everything against Postgres (DATABASE_URL). If Firebase
// Admin can't initialize (creds absent, expired, or intentionally omitted on a local
// box), we must NOT crash — Postgres is the real store. We swap in a stub Firestore
// that only errors if an UNMAPPED collection is actually touched (all hot-path
// collections are mapped to PG, so the stub is never hit in normal offline use).
function makeOfflineFirestoreStub() {
  const unavailable = () => {
    throw new Error('Firestore unavailable in offline mode — this collection is not mapped to Postgres.');
  };
  return {
    __offlineStub: true,
    collection: unavailable,
    collectionGroup: unavailable,
    doc: unavailable,
    batch: unavailable,
    runTransaction: unavailable,
    settings: () => {},
  };
}

// Initialize on module load
try {
  db = initializeFirebase();
} catch (fbErr) {
  if (process.env.DATABASE_URL) {
    console.warn('⚠️  Firebase Admin unavailable — booting in OFFLINE (Postgres-only) mode:', fbErr.message);
    // Initialize a PLACEHOLDER Firebase app (no real creds) so services that eagerly
    // call admin.firestore()/database()/messaging() at module-load don't crash the
    // whole server. Their actual network calls will fail and be caught; the primary
    // data path is Postgres via the pgAdapter below. Real (mapped) data never touches this.
    try {
      const admin = require('firebase-admin');
      if (!admin.apps || !admin.apps.length) {
        admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'dineopen-offline' });
        console.warn('   (placeholder Firebase app initialised so eager admin.* callers don\'t crash)');
      }
    } catch (_) { /* if even this fails, the stub below still handles the db path */ }
    firestoreDb = makeOfflineFirestoreStub();
    db = firestoreDb;
    isInitialized = true;
  } else {
    throw fbErr;
  }
}

// ── PostgreSQL adapter ──────────────────────────────────────────────────────
// When DATABASE_URL is set, wrap the Firestore db with pgAdapter so all
// collection reads/writes go to PostgreSQL instead of Firestore.
// Unmapped collections fall back to Firestore automatically.
if (process.env.DATABASE_URL) {
  try {
    const REGISTRY = require('./repos/collectionRegistry');
    const { createPgDb } = require('./repos/pgAdapter');
    db = createPgDb(REGISTRY, firestoreDb);
    console.log('🐘 PostgreSQL adapter enabled — reads/writes routed to PG');
  } catch (err) {
    console.error('❌ Failed to initialize pgAdapter, staying on Firestore:', err.message);
    // db remains as firestoreDb
  }
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
  feedbackForms: 'feedbackForms',
  feedbackResponses: 'feedbackResponses',
  loyalty: 'loyalty',
  tables: 'tables',
  floors: 'floors',
  bookings: 'bookings',
  staffUsers: 'staffUsers',
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
  inventoryTransactions: 'inventoryTransactions',
  stockBatches: 'stockBatches',
  aiUsage: 'aiUsage',
  // Automation & Loyalty Collections
  automations: 'automations',
  automationTemplates: 'automation-templates',
  automationSettings: 'automation-settings',
  automationLogs: 'automation-logs',
  coupons: 'coupons',
  customerSegments: 'customer-segments',
  // Saved Carts & Offline Support
  savedCarts: 'saved_carts',
  idempotencyKeys: 'idempotency_keys',
  // Invoice Module Collections
  invOrganizations: 'inv_organizations',
  invCustomers: 'inv_customers',
  invItems: 'inv_items',
  invInvoices: 'inv_invoices',
  invQuotes: 'inv_quotes',
  invChallans: 'inv_challans',
  invPayments: 'inv_payments',
  invExpenses: 'inv_expenses',
  invSettings: 'inv_settings',
  invNumberSequences: 'inv_number_sequences',
  // Books (Accounting) Collections
  expenses: 'expenses',
  payrollConfig: 'payrollConfig',
  payrollRuns: 'payrollRuns',
  paySlips: 'paySlips',
  chartOfAccounts: 'chartOfAccounts',
  journalEntries: 'journalEntries',
  // Attendance & Leave Collections
  attendance: 'attendance',
  leaveRequests: 'leaveRequests',
  leaveConfig: 'leaveConfig',
  leaveBalances: 'leaveBalances',
  staffLocations: 'staffLocations',
  // Waste Tracking Collections
  wasteEntries: 'wasteEntries',
  stockAudits: 'stockAudits',
  productionEntries: 'productionEntries',
  // Space Booking Collections
  spaceBookings: 'spaceBookings',
  // Chain / Enterprise Collections
  organizations: 'organizations',
  orgMenuTemplates: 'orgMenuTemplates',
  orgMenuItems: 'orgMenuItems',
  indentRequests: 'indentRequests',
  productionOrders: 'productionOrders',
  distributionPlans: 'distributionPlans',
  orgAuditLog: 'orgAuditLog',
  orgSettings: 'orgSettings',
  // Cash Register / Shift Management
  cashRegisters: 'cashRegisters',
  shifts: 'shifts',
  // Bolna AI Phone Agent
  bolnaAgents: 'bolnaAgents',
  phoneCalls: 'phoneCalls',
  // Parking Lot Management
  parkingConfigs: 'parkingConfigs',
  parkingZones: 'parkingZones',
  parkingSlots: 'parkingSlots',
  parkingTickets: 'parkingTickets',
  parkingRates: 'parkingRates',
  // Bookings & Catering
  bookings: 'bookings',
  bookingVenues: 'bookingVenues',
  // Print diagnostics telemetry (desktop app printer troubleshooting)
  printDiagnostics: 'printDiagnostics'
};

const admin = null; // We don't need the legacy admin object anymore

// Export getter function to ensure initialization
function getDb() {
  if (!db || !isInitialized) {
    db = initializeFirebase();
  }
  return db;
}

// Get raw Firestore db (bypasses pgAdapter — use for auth/RTDB-coupled operations)
function getFirestoreDb() {
  if (!firestoreDb || !isInitialized) {
    initializeFirebase();
  }
  return firestoreDb;
}

// Realtime Database getter (lazy init)
let rtdb;
function getRealtimeDb() {
  if (!rtdb) {
    if (!isInitialized) initializeFirebase();
    rtdb = getDatabase();
  }
  return rtdb;
}

module.exports = {
  admin,
  get db() {
    return getDb();
  },
  getDb, // Export getter for lazy initialization
  getFirestoreDb, // Raw Firestore (bypasses pgAdapter)
  getRealtimeDb,
  collections
};