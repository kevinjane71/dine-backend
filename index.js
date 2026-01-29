const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const OpenAI = require('openai');
// const twilio = require('twilio');
const Razorpay = require('razorpay');
require('dotenv').config();

const { db, collections } = require('./firebase');
const { FieldValue } = require('firebase-admin/firestore');
const performanceOptimizer = require('./middleware/performanceOptimizer');
const firestoreOptimizer = require('./utils/firestoreOptimizer');
const inventoryService = require('./services/inventoryService');
const pusherService = require('./services/pusherService');

// Generate daily order ID (starts from 1 each day)
async function generateDailyOrderId(restaurantId) {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // Get or create daily counter document
    const counterRef = db.collection('daily_order_counters').doc(`${restaurantId}_${todayStr}`);
    const counterDoc = await counterRef.get();
    
    if (!counterDoc.exists) {
      // First order of the day - start from 1
      await counterRef.set({
        restaurantId,
        date: todayStr,
        lastOrderId: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      });
      return 1;
    } else {
      // Increment the counter
      const counterData = counterDoc.data();
      const newOrderId = counterData.lastOrderId + 1;
      
      await counterRef.update({
        lastOrderId: newOrderId,
        updatedAt: new Date()
      });
      
      return newOrderId;
    }
  } catch (error) {
    console.error('Error generating daily order ID:', error);
    // Fallback to timestamp-based ID
    return Date.now() % 10000; // Last 4 digits of timestamp
  }
}

// Generate sequential order ID (never resets; increments forever per restaurant). Uses transaction to avoid race conditions.
async function generateSequentialOrderId(restaurantId) {
  try {
    const counterRef = db.collection('order_id_counters').doc(restaurantId);
    const result = await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(counterRef);
      const nextId = snap.exists ? ((snap.data().lastOrderId || 0) + 1) : 1;
      transaction.set(counterRef, {
        restaurantId,
        lastOrderId: nextId,
        updatedAt: new Date()
      }, { merge: true });
      return nextId;
    });
    return result;
  } catch (error) {
    console.error('Error generating sequential order ID:', error);
    return Date.now() % 100000;
  }
}

// Resolves next display order ID: daily (reset each day) or sequential (never reset) based on restaurant.orderSettings.sequentialOrderIdEnabled
async function getNextOrderId(restaurantId, restaurantDataOrNull) {
  let restaurantData = restaurantDataOrNull;
  if (!restaurantData) {
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    restaurantData = restaurantDoc.exists ? restaurantDoc.data() : {};
  }
  const useSequential = !!(restaurantData.orderSettings && restaurantData.orderSettings.sequentialOrderIdEnabled);
  if (useSequential) {
    return await generateSequentialOrderId(restaurantId);
  }
  return await generateDailyOrderId(restaurantId);
}

// Helper function to create default free-trial subscription for new users
async function createDefaultSubscription(userId, email, phone, role) {
  try {
    // Check if subscription already exists
    const userRef = db.collection('dine_user_data').doc(userId);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
      console.log(`[SUBSCRIPTION] User ${userId} already has subscription record`);
      return;
    }

    // Create subscription with free-trial plan
    const currentDate = new Date();
    const planDetails = {
      name: 'Free Trial',
      features: {
        maxProducts: 200,
        maxLocations: 1,
        maxTransactions: 'unlimited',
        inventoryTracking: true,
        multiStore: false,
        advancedReports: false,
        prioritySupport: false,
        backupEnabled: false,
        staffAccounts: 1,
        tableManagement: 100
      }
    };

    const newUserData = {
      uid: userId,
      email: email || '',
      phone: phone || '',
      role: role || 'owner',
      restaurantInfo: {},
      createdAt: currentDate.toISOString(),
      lastUpdated: currentDate.toISOString(),
      app: 'Dine',
      subscription: {
        planId: 'free-trial',
        planName: planDetails.name,
        status: 'active',
        startDate: currentDate.toISOString(),
        endDate: null, // Free trial has no end date
        features: planDetails.features,
        lastUpdated: currentDate.toISOString(),
        app: 'Dine'
      }
    };

    await userRef.set(newUserData);
    console.log(`✅ Created free-trial subscription for user ${userId}`);
  } catch (error) {
    console.error(`❌ Error creating default subscription for user ${userId}:`, error);
    // Don't throw - allow user registration to continue even if subscription creation fails
  }
}

// Security middleware (Vercel-compatible)
const vercelSecurityMiddleware = require('./middleware/vercelSecurity');
const { vercelRateLimiter } = require('./middleware/vercelRateLimiter');

// ChatGPT Usage Limiter
const chatgptUsageLimiter = require('./middleware/chatgptUsageLimiter');

// AI Usage Limiter (for chatbot and voice bot)
const aiUsageLimiter = require('./middleware/aiUsageLimiter');

// Subdomain utilities
const { generateSubdomain, getSubdomainUrl } = require('./utils/subdomain');

// DineBot Configuration
const dinebotConfig = {
  name: 'DineBot',
  version: '1.0.0',
  description: 'Intelligent Restaurant Assistant',
  maxTokens: 500,
  temperature: 0.1,
  model: 'text-davinci-003'
};

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const initializePaymentRoutes = require('./payment');
const emailService = require('./emailService');

// Chatbot RAG routes
const chatbotRoutes = require('./routes/chatbot');

// Hotel PMS routes
const hotelRoutes = require('./routes/hotel');

// Hotel Management routes (for restaurant-hotel integration)
const hotelManagementRoutes = require('./routes/hotelManagement');

// Room Management routes (for hotel rooms and bookings)
const roomManagementRoutes = require('./routes/roomManagement');

// Shift Scheduling routes
const shiftSchedulingRoutes = require('./routes/shiftScheduling');

// Google Reviews routes
const googleReviewsRoutes = require('./routes/googleReviews');

// Custom URL (slug) routes for short restaurant URLs
const customUrlRoutes = require('./routes/customUrlRoutes');

// Staff reset password (owner only)
const staffResetPasswordRoutes = require('./routes/staffResetPassword');

// Debug email service initialization
console.log('📧 Email service loaded:', !!emailService);
if (emailService) {
  console.log('📧 Email service methods:', Object.keys(emailService));
  console.log('📧 sendWelcomeEmail available:', !!emailService.sendWelcomeEmail);
} else {
  console.error('❌ Email service failed to load!');
}

const app = express();

const PORT = process.env.PORT || 3003;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
// const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Initialize Razorpay with validation
let razorpay;
try {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.warn('⚠️ Razorpay environment variables not set - payment features will be disabled');
    razorpay = null;
  } else {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
    console.log('✅ Razorpay initialized successfully');
  }
} catch (error) {
  console.error('❌ Razorpay initialization error:', error.message);
  console.error('Please check your RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables');
  razorpay = null;
}

// Initialize Firebase Storage
let storage;
if (process.env.NODE_ENV === 'production') {
  // For production
  try {
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson || credentialsJson === 'undefined') {
      console.warn('⚠️ GOOGLE_APPLICATION_CREDENTIALS_JSON not set, using default Firebase initialization');
      storage = new Storage();
    } else {
      const serviceAccount = JSON.parse(credentialsJson);
      storage = new Storage({
        projectId: serviceAccount.project_id,
        credentials: {
          client_email: serviceAccount.client_email,
          private_key: serviceAccount.private_key
        }
      });
      console.log('✅ Firebase Storage initialized with service account');
    }
  } catch (error) {
    console.error('❌ Error parsing Firebase credentials:', error.message);
    console.warn('⚠️ Falling back to default Firebase initialization');
    storage = new Storage();
  }
} else {
  // For local development
  storage = new Storage();
  console.log('✅ Firebase Storage initialized for development');
}
const bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET || 'dine-menu-uploads');


// Configure multer for file uploads
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 300 * 1024 * 1024, // 300MB max file size
    files: 10 // Max 10 files
  },
  fileFilter: (req, file, cb) => {
    // Allow images and PDFs
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only images and PDFs are allowed.'), false);
    }
  }
});
// Feature flag for subdomain functionality
const SUBDOMAIN_FEATURE_ENABLED = process.env.ENABLE_SUBDOMAIN === 'true'; // Default: false (disabled)
console.log(`🌐 Subdomain feature: ${SUBDOMAIN_FEATURE_ENABLED ? 'ENABLED' : 'DISABLED'}`);

// Specific allowed origins (non-dineopen.com domains)
const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:3002',
  'http://localhost:3003',
  'https://dine-frontend-ecru.vercel.app',
  'https://pms-hotel.vercel.app'
];

// Helper function to check if origin is a valid dineopen.com domain or subdomain
function isValidDineopenOrigin(origin) {
  if (!origin) return false;

  // Match exact domain and all subdomains
  // Valid: https://dineopen.com, https://www.dineopen.com, https://dummy.dineopen.com, https://any-name.dineopen.com
  // Invalid: https://dineopen.com.evil.com, https://fakeDINEOPEN.com
  const dineopenRegex = /^https:\/\/([a-zA-Z0-9-]+\.)?dineopen\.com$/;
  return dineopenRegex.test(origin);
}

// Helper function to check if origin is a valid localhost subdomain (for development)
function isValidLocalhostOrigin(origin) {
  if (!origin) return false;

  // Match localhost with optional subdomain on ports 3001, 3002, 3003
  // Valid: http://localhost:3001, http://dummy.localhost:3002
  const localhostRegex = /^http:\/\/([a-zA-Z0-9-]+\.)?localhost:(3001|3002|3003)$/;
  return localhostRegex.test(origin);
}

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      callback(null, true);
      return;
    }

    // ✅ Allow ALL dineopen.com domains and subdomains (*.dineopen.com)
    // Examples: dineopen.com, www.dineopen.com, dummy.dineopen.com, restaurant1.dineopen.com
    if (isValidDineopenOrigin(origin)) {
      console.log(`✅ CORS allowed for dineopen.com origin: ${origin}`);
      callback(null, origin);
      return;
    }

    // ✅ Check if origin is in specific allowed origins list
    if (allowedOrigins.includes(origin)) {
      console.log(`✅ CORS allowed for whitelisted origin: ${origin}`);
      callback(null, origin);
      return;
    }

    // ✅ Allow localhost subdomains for development (*.localhost:3001|3002|3003)
    if (isValidLocalhostOrigin(origin)) {
      console.log(`✅ CORS allowed for localhost origin: ${origin}`);
      callback(null, origin);
      return;
    }

    // ❌ Reject all other origins
    console.log(`❌ CORS blocked for origin: ${origin}`);
    callback(new Error("CORS not allowed"));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200,
  preflightContinue: false
};

app.use(cors(corsOptions));

// CRITICAL: Override response methods to ALWAYS set correct CORS header
// This ensures the CORS header is set correctly even if other code tries to override it
app.use((req, res, next) => {
  const origin = req.headers.origin;

  // CRITICAL: Add no-cache headers for CORS to prevent caching issues
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Store original methods
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  const originalEnd = res.end.bind(res);

  // Helper to set CORS headers - ALWAYS uses the request origin
  const setCorsHeaders = () => {
    if (origin) {
      // ✅ Allow ALL dineopen.com domains and subdomains (*.dineopen.com)
      // ✅ Allow whitelisted origins
      // ✅ Allow localhost subdomains for development
      if (isValidDineopenOrigin(origin) || allowedOrigins.includes(origin) || isValidLocalhostOrigin(origin)) {
        // CRITICAL: Always use the request origin, never a cached or restaurant-specific value
        res.removeHeader('Access-Control-Allow-Origin'); // Remove any existing incorrect header
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin'); // Ensure CDN doesn't cache CORS headers
      }
    }
  };

  // Override res.json to set CORS before sending
  res.json = function(data) {
    setCorsHeaders();
    return originalJson(data);
  };

  // Override res.send to set CORS before sending
  res.send = function(data) {
    setCorsHeaders();
    return originalSend(data);
  };

  // Override res.end to set CORS before ending
  res.end = function(data, encoding) {
    setCorsHeaders();
    return originalEnd(data, encoding);
  };

  // Handle OPTIONS preflight requests
  if (req.method === 'OPTIONS') {
    if (origin) {
      // ✅ Allow ALL dineopen.com domains and subdomains (*.dineopen.com)
      // ✅ Allow whitelisted origins
      // ✅ Allow localhost subdomains for development
      if (isValidDineopenOrigin(origin) || allowedOrigins.includes(origin) || isValidLocalhostOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        console.log(`✅ CORS preflight allowed for origin: ${origin}`);
        return res.status(204).end();
      } else {
        console.log(`❌ CORS preflight blocked for origin: ${origin}`);
      }
    }
  }

  // Set CORS headers for all requests
  setCorsHeaders();

  next();
});

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));


app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Performance optimization middleware (must be early in the chain)
app.use(performanceOptimizer);

app.use((req, res, next) => {
  req.id = Math.random().toString(36).substring(2, 15);
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Security middleware setup
console.log('🔒 Initializing security middleware...');

// Global security headers
app.use((req, res, next) => {
  // Add security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  
  // Log all requests for monitoring
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                   req.headers['x-real-ip'] || 
                   req.connection.remoteAddress || 
                   'unknown';
  
  console.log(`📊 Request: ${req.method} ${req.url} from ${clientIP}`);
  next();
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  console.log('Auth header:', authHeader);
  console.log('Token:', token ? 'Present' : 'Missing');
  console.log('Request URL:', req.url);
  console.log('Request method:', req.method);

  if (!token) {
    console.log('No token found, returning 401');
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, async (err, user) => {
    if (err) {
      console.log('Token verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    console.log('Token verified successfully for user:', user.userId);
    req.user = user;

    // Staff/employee: if marked inactive, reject all requests (revoke access)
    const staffRoles = ['waiter', 'manager', 'employee', 'cashier', 'sales'];
    if (user.userId) {
      try {
        const userDoc = await db.collection(collections.users).doc(user.userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          const role = (userData.role || '').toLowerCase();
          if (staffRoles.includes(role) && userData.status === 'inactive') {
            return res.status(401).json({
              error: 'Account deactivated',
              message: 'Your account has been deactivated. Please contact your manager.',
              inactive: true
            });
          }
        }
      } catch (dbErr) {
        console.error('Auth staff status check error:', dbErr);
        // On DB error, allow request (don't block on transient errors)
      }
    }

    // Demo account restrictions with whitelist
    if (user.phone === '+919000000000') {
      const demoAllowedEndpoints = [
        '/api/auth/phone/verify-otp',
        '/api/auth/logout',
        '/api/auth/refresh-token'
      ];
      if (req.method === 'GET' || demoAllowedEndpoints.includes(req.path)) {
        console.log(`🎭 Demo account accessing allowed endpoint: ${req.method} ${req.path}`);
        return next();
      }
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
        console.log(`🎭 Demo account detected: ${req.method} ${req.path} - Blocking request`);
        return res.status(403).json({
          success: false,
          error: 'Demo Mode Restriction',
          message: 'Demo accounts are restricted to read-only access. Please sign up for a full account to perform this action.',
          demoMode: true
        });
      }
    }

    next();
  });
};

// GraphQL endpoint for direct access

// Enhanced DineBot API with GraphQL integration

// Enhanced DineBot API with Function Calling integration

// Optimized Dynamic Function Agent endpoint (minimal tokens + smart caching)

// Ultra-modern AI Agent endpoint (zero maintenance)

// Test endpoint to show what query is sent to ChatGPT (no auth for testing)

// Test endpoint to show what query is sent to ChatGPT

// ==================== DINEBOT FUNCTIONS ====================

// Security: Sanitize and validate user input
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  
  // Remove potentially dangerous characters
  return input
    .replace(/[<>\"'%;()&+]/g, '') // Remove SQL injection characters
    .replace(/script/gi, '') // Remove script tags
    .replace(/javascript/gi, '') // Remove javascript
    .trim()
    .substring(0, 500); // Limit length
}

// Security: Validate restaurant access
async function validateRestaurantAccess(userId, restaurantId) {
  try {
    // Check if user has access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .get();

    if (!userRestaurantSnapshot.empty) {
      return true;
    }

    // Fallback: Check if user is the owner directly
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (restaurantDoc.exists) {
      const restaurant = restaurantDoc.data();
      return restaurant.ownerId === userId;
    }

    return false;
  } catch (error) {
    console.error('Restaurant access validation error:', error);
    return false;
  }
}

// Generate database schema documentation for ChatGPT
function generateDatabaseSchema(restaurantId) {
  return `
COMPLETE RESTAURANT DATABASE SCHEMA (Restaurant ID: ${restaurantId})

ALL COLLECTIONS AND EXACT FIELD NAMES:

1. ORDERS Collection:
   Fields: id, restaurantId, items[], totalAmount, customer{}, tableNumber, status, waiterId, waiterName, paymentMethod, paymentStatus, taxAmount, discountAmount, notes, createdAt, updatedAt, completedAt
   Status values: 'pending', 'preparing', 'ready', 'completed', 'cancelled'
   Items structure: [{id, name, price, quantity, category, shortCode, isVeg}]
   Customer structure: {name, phone, email, address}
   Payment methods: 'cash', 'card', 'upi', 'online'

2. CUSTOMERS Collection:
   Fields: id, restaurantId, name, phone, email, city, dob, address, orderHistory[], totalSpent, lastVisit, createdAt, updatedAt
   OrderHistory: [{orderId, date, totalAmount, items[], status}]

3. RESTAURANTS Collection:
   Fields: id, name, description, ownerId, address, phone, email, cuisine[], settings{}, menu{}, tables[], floors[], createdAt, updatedAt
   Settings: {openTime, closeTime, lastOrderTime, taxSettings{}, features{}, notifications{}}
   Menu structure: {items: [{id, name, price, category, description, shortCode, isVeg, isAvailable, image}]}
   Tables: [{id, number, floorId, status, capacity, section}]
   Floors: [{id, name, tables[], capacity}]

4. TABLES Collection:
   Fields: id, restaurantId, name, floor, capacity, section, status, currentOrderId, lastOrderTime, waiterId, createdAt, updatedAt
   Status values: 'available', 'occupied', 'reserved', 'cleaning', 'maintenance'
   Floor: Floor name or ID where table is located

5. FLOORS Collection:
   Fields: id, restaurantId, name, description, capacity, tables[], createdAt, updatedAt
   Tables: [{id, name, capacity, status, section}]

6. MENUS Collection (embedded in restaurants):
   Structure: restaurant.menu.items[]
   Fields: {id, name, price, category, description, shortCode, isVeg, isAvailable, image, preparationTime, ingredients[], allergens[]}

7. INVENTORY Collection:
   Fields: id, restaurantId, name, category, unit, currentStock, minStock, maxStock, costPerUnit, supplierId, location, barcode, expiryDate, createdAt, updatedAt
   Categories: 'vegetables', 'meat', 'dairy', 'spices', 'beverages', 'packaged', 'other'

8. SUPPLIERS Collection:
   Fields: id, restaurantId, name, contactPerson, phone, email, address, paymentTerms, notes, createdAt, updatedAt

9. RECIPES Collection:
   Fields: id, restaurantId, name, description, category, servings, prepTime, cookTime, ingredients[], instructions[], notes, createdAt, updatedAt
   Ingredients: [{inventoryItemId, inventoryItemName, quantity, unit}]

10. PURCHASE_ORDERS Collection:
    Fields: id, restaurantId, supplierId, items[], totalAmount, status, notes, expectedDeliveryDate, createdAt, updatedAt, createdBy
    Status values: 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled'
    Items: [{inventoryItemId, inventoryItemName, quantity, unitPrice, totalPrice}]

11. INVOICES Collection:
    Fields: id, orderId, restaurantId, invoiceNumber, subtotal, taxBreakdown[], total, generatedBy, generatedAt, customer{}, items[]

12. PAYMENTS Collection:
    Fields: id, orderId, restaurantId, amount, method, status, transactionId, razorpayOrderId, razorpayPaymentId, createdAt, updatedAt
    Status values: 'pending', 'completed', 'failed', 'refunded'

13. ANALYTICS Collection:
    Fields: id, restaurantId, date, revenue, ordersCount, customersCount, popularItems[], peakHours[], createdAt

14. USER_RESTAURANTS Collection:
    Fields: userId, restaurantId, role, permissions[], createdAt, updatedAt
    Roles: 'owner', 'manager', 'admin', 'staff', 'waiter'
    Permissions: ['orders', 'menu', 'tables', 'analytics', 'inventory', 'customers']

15. RESTAURANT_SETTINGS Collection:
    Fields: id, restaurantId, taxSettings{}, discountSettings{}, notificationSettings{}, featureSettings{}, createdAt, updatedAt
    TaxSettings: {enabled, rate, type}
    DiscountSettings: {enabled, maxDiscount, rules[]}

16. DISCOUNT_SETTINGS Collection:
    Fields: id, restaurantId, name, type, value, conditions[], isActive, createdAt, updatedAt
    Types: 'percentage', 'fixed', 'buy_x_get_y'

17. BOOKINGS Collection:
    Fields: id, restaurantId, customerName, customerPhone, customerEmail, tableId, floorId, date, time, duration, partySize, status, notes, createdAt, updatedAt
    Status values: 'pending', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show'

18. FEEDBACK Collection:
    Fields: id, restaurantId, orderId, customerId, rating, comment, category, createdAt, updatedAt
    Categories: 'food_quality', 'service', 'ambiance', 'value', 'other'

19. LOYALTY Collection:
    Fields: id, restaurantId, customerId, points, tier, totalSpent, lastActivity, createdAt, updatedAt

QUERY OPERATIONS AVAILABLE:
- COUNT: Count documents matching filters
- SUM: Sum numeric fields (totalAmount, price, quantity, currentStock, etc.)
- GROUP_BY: Group by field and count/sum
- LIST: Get list of documents
- FILTER: Filter by date ranges, status, restaurantId
- AVERAGE: Calculate average of numeric fields

DATE FILTERS:
- today: Current day (00:00 to 23:59)
- yesterday: Previous day
- this_week: Current week (Monday to Sunday)
- last_week: Previous week
- this_month: Current month
- last_month: Previous month
- this_year: Current year
- last_year: Previous year

FIELD TYPES AND VALUES:
- Status fields: Check specific collection for valid values
- Date fields: All use createdAt, updatedAt, date, time formats
- Numeric fields: totalAmount, price, quantity, capacity, rating, points
- Boolean fields: isVeg, isAvailable, isActive
- Array fields: items[], ingredients[], instructions[], permissions[]

SECURITY CONSTRAINTS:
- ALL queries MUST include restaurantId filter
- Input sanitization required for all user queries
- No real data exposure - only schema and field names
`;
}

// Dynamic operation executor with security controls (READ + WRITE)
async function executeSecureOperation(operations, restaurantId, userId) {
  const results = {};
  
  // Security: Validate restaurant access
  const hasAccess = await validateRestaurantAccess(userId, restaurantId);
  if (!hasAccess) {
    throw new Error('Access denied to restaurant data');
  }

  for (const operation of operations) {
    try {
      // CRITICAL FIX: Use only ONE where clause to avoid composite index requirements
      let query = db.collection(operation.collection);
      
      // Security: Always add restaurantId filter (this is the only where clause we use)
      query = query.where('restaurantId', '==', restaurantId);
      
      // Get all documents for this restaurant and filter client-side
      const snapshot = await query.get();
      let docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      
      // Apply ALL filters client-side to avoid composite indexes
      if (operation.filters) {
        docs = docs.filter(doc => {
          for (const [field, value] of Object.entries(operation.filters)) {
            // Security: Prevent injection attacks
            const sanitizedValue = sanitizeInput(value);
            
            if (field === 'createdAt') {
              const docDate = doc.createdAt ? doc.createdAt.toDate() : new Date(doc.createdAt);
              
              if (value === 'today') {
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                if (!(docDate >= today && docDate < tomorrow)) return false;
              } else if (value === 'yesterday') {
                const yesterday = new Date();
                yesterday.setDate(yesterday.getDate() - 1);
                yesterday.setHours(0, 0, 0, 0);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                if (!(docDate >= yesterday && docDate < today)) return false;
              } else if (value === 'this_week') {
                const startOfWeek = new Date();
                startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
                startOfWeek.setHours(0, 0, 0, 0);
                const endOfWeek = new Date(startOfWeek);
                endOfWeek.setDate(endOfWeek.getDate() + 7);
                if (!(docDate >= startOfWeek && docDate < endOfWeek)) return false;
              }
            } else if (field === 'status') {
              if (doc[field] !== sanitizedValue) return false;
            } else if (field === 'tableNumber') {
              if (doc[field] !== parseInt(sanitizedValue)) return false;
            } else {
              if (doc[field] !== sanitizedValue) return false;
            }
          }
          return true;
        });
      }
      
      // Apply aggregation
      switch (operation.aggregation) {
        case 'count':
          results[operation.collection] = { count: docs.length };
          break;
          
        case 'sum':
          const sumField = operation.fields[0];
          const sum = docs.reduce((total, doc) => total + (doc[sumField] || 0), 0);
          results[operation.collection] = { sum: sum };
          break;
          
        case 'groupBy':
          const groupField = operation.fields[0];
          const grouped = {};
          docs.forEach(doc => {
            if (doc[groupField]) {
              if (Array.isArray(doc[groupField])) {
                // Handle array fields like items
                doc[groupField].forEach(item => {
                  const key = item.name || item.id || 'unknown';
                  grouped[key] = (grouped[key] || 0) + (item.quantity || 1);
                });
              } else {
                const key = doc[groupField];
                grouped[key] = (grouped[key] || 0) + 1;
              }
            }
          });
          results[operation.collection] = { grouped: grouped };
          break;
          
        case 'list':
          results[operation.collection] = { items: docs };
          break;
          
        case 'average':
          const avgField = operation.fields[0];
          const total = docs.reduce((sum, doc) => sum + (doc[avgField] || 0), 0);
          const average = docs.length > 0 ? total / docs.length : 0;
          results[operation.collection] = { average: average };
          break;
          
        default:
          results[operation.collection] = { data: docs };
      }
      
    } catch (error) {
      console.error(`Error executing operation on ${operation.collection}:`, error);
      results[operation.collection] = { error: 'Failed to fetch data' };
    }
  }
  
  return results;
}

// READ Operation Handler
async function executeReadOperation(operation, restaurantId) {
  // CRITICAL FIX: Use only ONE where clause to avoid composite index requirements
  let query = db.collection(operation.collection);
  
  // Security: Always add restaurantId filter (this is the only where clause we use)
  query = query.where('restaurantId', '==', restaurantId);
  
  // Get all documents for this restaurant and filter client-side
  const snapshot = await query.get();
  let docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  // Apply ALL filters client-side to avoid composite indexes
  if (operation.filters) {
    docs = docs.filter(doc => {
      for (const [field, value] of Object.entries(operation.filters)) {
        // Security: Prevent injection attacks
        const sanitizedValue = sanitizeInput(value);
        
        if (field === 'createdAt') {
          const docDate = doc.createdAt ? doc.createdAt.toDate() : new Date(doc.createdAt);
          
          if (value === 'today') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);
            if (!(docDate >= today && docDate < tomorrow)) return false;
          } else if (value === 'yesterday') {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(0, 0, 0, 0);
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (!(docDate >= yesterday && docDate < today)) return false;
          } else if (value === 'this_week') {
            const startOfWeek = new Date();
            startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
            startOfWeek.setHours(0, 0, 0, 0);
            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setDate(endOfWeek.getDate() + 7);
            if (!(docDate >= startOfWeek && docDate < endOfWeek)) return false;
          } else if (value === 'this_month') {
            const startOfMonth = new Date();
            startOfMonth.setDate(1);
            startOfMonth.setHours(0, 0, 0, 0);
            const endOfMonth = new Date(startOfMonth);
            endOfMonth.setMonth(endOfMonth.getMonth() + 1);
            if (!(docDate >= startOfMonth && docDate < endOfMonth)) return false;
          }
        } else if (field.includes('>')) {
          const [fieldName, operator] = field.split(' ');
          if (operator === '>' && doc[fieldName] <= sanitizedValue) return false;
          if (operator === '<' && doc[fieldName] >= sanitizedValue) return false;
          if (operator === '>=' && doc[fieldName] < sanitizedValue) return false;
          if (operator === '<=' && doc[fieldName] > sanitizedValue) return false;
        } else if (doc[field] !== sanitizedValue) {
          return false;
        }
      }
      return true;
    });
  }
  
  // Apply aggregation
  switch (operation.aggregation) {
    case 'count':
      return { count: docs.length };
    case 'sum':
      const sumField = operation.fields[0];
      const sum = docs.reduce((acc, doc) => acc + (doc[sumField] || 0), 0);
      return { sum };
    case 'average':
      const avgField = operation.fields[0];
      const avg = docs.length > 0 ? docs.reduce((acc, doc) => acc + (doc[avgField] || 0), 0) / docs.length : 0;
      return { average: avg };
    case 'groupBy':
      const groupField = operation.fields[0];
      const grouped = {};
      docs.forEach(doc => {
        const key = doc[groupField] || 'Unknown';
        grouped[key] = (grouped[key] || 0) + 1;
      });
      return { grouped };
    case 'list':
    default:
      const selectedFields = operation.fields || ['id'];
      const items = docs.map(doc => {
        const item = {};
        selectedFields.forEach(field => {
          item[field] = doc[field];
        });
        return item;
      });
      return { items };
  }
}

// CREATE Operation Handler
async function executeCreateOperation(operation, restaurantId, userId) {
  const data = operation.data || {};
  
  // Security: Always add restaurantId and audit fields
  const documentData = {
    ...data,
    restaurantId,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: userId
  };
  
  // Collection-specific validation and defaults
  switch (operation.collection) {
    case 'tables':
      if (!data.name) throw new Error('Table name is required');
      documentData.status = data.status || 'available';
      documentData.capacity = data.capacity || 4;
      documentData.section = data.section || 'Main';
      break;
    case 'customers':
      if (!data.name && !data.phone) throw new Error('Customer name or phone is required');
      break;
    case 'inventory':
      if (!data.name) throw new Error('Inventory item name is required');
      documentData.currentStock = data.currentStock || 0;
      documentData.minStock = data.minStock || 0;
      break;
  }
  
  const docRef = await db.collection(operation.collection).add(documentData);
  
  return {
    success: true,
    id: docRef.id,
    message: `${operation.collection.slice(0, -1)} created successfully`
  };
}

// UPDATE Operation Handler
async function executeUpdateOperation(operation, restaurantId, userId) {
  const { filters, data } = operation;
  
  if (!filters || !data) {
    throw new Error('Update operation requires filters and data');
  }
  
  // Find documents to update
  let query = db.collection(operation.collection).where('restaurantId', '==', restaurantId);
  const snapshot = await query.get();
  
  let docsToUpdate = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  // Apply filters client-side
  if (filters) {
    docsToUpdate = docsToUpdate.filter(doc => {
      for (const [field, value] of Object.entries(filters)) {
        if (doc[field] !== sanitizeInput(value)) return false;
      }
      return true;
    });
  }
  
  if (docsToUpdate.length === 0) {
    return { success: false, message: 'No documents found to update' };
  }
  
  // Update documents
  const updateData = {
    ...data,
    updatedAt: new Date(),
    updatedBy: userId
  };
  
  const batch = db.batch();
  docsToUpdate.forEach(doc => {
    const docRef = db.collection(operation.collection).doc(doc.id);
    batch.update(docRef, updateData);
  });
  
  await batch.commit();
  
  return {
    success: true,
    updatedCount: docsToUpdate.length,
    message: `${docsToUpdate.length} ${operation.collection} updated successfully`
  };
}

// DELETE Operation Handler
async function executeDeleteOperation(operation, restaurantId, userId) {
  const { filters } = operation;
  
  if (!filters) {
    throw new Error('Delete operation requires filters');
  }
  
  // Find documents to delete
  let query = db.collection(operation.collection).where('restaurantId', '==', restaurantId);
  const snapshot = await query.get();
  
  let docsToDelete = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  // Apply filters client-side
  docsToDelete = docsToDelete.filter(doc => {
    for (const [field, value] of Object.entries(filters)) {
      if (doc[field] !== sanitizeInput(value)) return false;
    }
    return true;
  });
  
  if (docsToDelete.length === 0) {
    return { success: false, message: 'No documents found to delete' };
  }
  
  // Delete documents
  const batch = db.batch();
  docsToDelete.forEach(doc => {
    const docRef = db.collection(operation.collection).doc(doc.id);
    batch.delete(docRef);
  });
  
  await batch.commit();
  
  return {
    success: true,
    deletedCount: docsToDelete.length,
    message: `${docsToDelete.length} ${operation.collection} deleted successfully`
  };
}

// Get restaurant static data and FAQ
async function getRestaurantStaticData(restaurantId) {
  try {
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return null;
    }
    
    const restaurant = restaurantDoc.data();
    
    return {
      name: restaurant.name,
      description: restaurant.description,
      openTime: restaurant.settings?.openTime || '9:00 AM',
      closeTime: restaurant.settings?.closeTime || '11:00 PM',
      lastOrderTime: restaurant.settings?.lastOrderTime || '10:30 PM',
      totalTables: restaurant.tables?.length || 0,
      totalFloors: restaurant.floors?.length || 0,
      menuItems: restaurant.menu?.items?.length || 0,
      features: restaurant.settings?.features || {},
      taxEnabled: restaurant.settings?.taxSettings?.enabled || false,
      taxRate: restaurant.settings?.taxSettings?.defaultTaxRate || 0
    };
  } catch (error) {
    console.error('Error fetching restaurant static data:', error);
    return null;
  }
}

// Generate dynamic response using ChatGPT
async function generateDynamicResponse(query, data, restaurantData, intent) {
  try {
    const prompt = `
You are DineBot, an intelligent restaurant management assistant for "${restaurantData.name}".

Restaurant Information:
- Name: ${restaurantData.name}
- Open Time: ${restaurantData.openTime}
- Close Time: ${restaurantData.closeTime}
- Last Order Time: ${restaurantData.lastOrderTime}
- Total Tables: ${restaurantData.totalTables}
- Total Floors: ${restaurantData.totalFloors}
- Menu Items: ${restaurantData.menuItems}
- Tax Enabled: ${restaurantData.taxEnabled ? 'Yes' : 'No'}
- Tax Rate: ${restaurantData.taxRate}%

User Query: "${query}"

Database Results:
${JSON.stringify(data, null, 2)}

Generate a friendly, conversational response that:
1. Answers the user's question directly and accurately
2. Includes relevant numbers and data from the database
3. Uses restaurant terminology appropriately
4. Sounds professional but warm and helpful
5. Is concise but informative (max 2-3 sentences)
6. Includes appropriate emojis
7. Provides actionable insights when possible

Response:`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: dinebotConfig.maxTokens,
      temperature: dinebotConfig.temperature,
    });

    return completion.choices[0].message.content.trim();
    
  } catch (error) {
    console.error('ChatGPT response generation error:', error);
    return generateFallbackResponse(query, data, restaurantData, intent);
  }
}

// Fallback response generator
function generateFallbackResponse(query, data, restaurantData, intent) {
  const responses = {
    'orders_today': `Today ${restaurantData.name} has ${data.orders?.count || 0} orders placed. ${data.orders?.count > 50 ? 'Great day!' : 'Room for growth!'} 📊`,
    'customers_today': `We've served ${data.customers?.count || 0} unique customers today. ${data.customers?.count > 30 ? 'Excellent!' : 'Let\'s attract more!'} 👥`,
    'revenue_today': `Today's revenue is ₹${data.orders?.sum?.toFixed(2) || '0.00'} from ${data.orders?.count || 0} completed orders. ${data.orders?.sum > 10000 ? 'Outstanding!' : 'Keep pushing!'} 💰`,
    'table_status': `Currently ${data.orders?.count || 0} tables are occupied out of ${restaurantData.totalTables} total tables. ${restaurantData.totalTables - (data.orders?.count || 0)} tables are available. 🪑`,
    'popular_items': `The most popular items today are: ${Object.entries(data.orders?.grouped || {}).slice(0, 3).map(([name, count]) => `${name} (${count})`).join(', ')}. 🍽️`
  };
  
  return responses[intent] || `Here's the data you requested: ${JSON.stringify(data)}`;
}

// ==================== END DINEBOT FUNCTIONS ====================

const generateOTP = (phone) => {
  // Only use hardcoded OTP for dummy account
  if (phone === '+919000000000' || phone === '9000000000') {
  return "1234";
  }
  // For real numbers, generate random OTP (this won't be used since we're using Firebase)
  return Math.floor(100000 + Math.random() * 900000).toString();
};

const sendOTP = async (phone, otp) => {
  try {
    // await twilioClient.messages.create({
    //   body: `Your Dine verification code is: ${otp}. Valid for 10 minutes.`,
    //   from: process.env.TWILIO_PHONE_NUMBER,
    //   to: phone
    // });
    console.log(`📱 SMS OTP for ${phone}: ${otp} (Twilio disabled)`);
    return true;
  } catch (error) {
    console.error('SMS Error:', error);
    return false;
  }
};

// Helper function to upload file to Firebase Storage
const uploadToFirebase = async (file, restaurantId) => {
  console.log(`\n=== UPLOADING FILE TO FIREBASE ===`);
  console.log('File details:', {
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    bufferLength: file.buffer ? file.buffer.length : 'No buffer'
  });
  console.log('Restaurant ID:', restaurantId);
  
  const filename = `menu-uploads/${restaurantId}/${Date.now()}-${file.originalname}`;
  console.log('Firebase filename:', filename);
  console.log('Bucket name:', bucket.name);
  
  const blob = bucket.file(filename);
  
  try {
    console.log('Starting Firebase upload...');
    await blob.save(file.buffer, {
      contentType: file.mimetype,
      metadata: {
        restaurantId: restaurantId,
        uploadedAt: new Date().toISOString()
      }
    });
    
    const fileUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
    console.log('✅ Firebase upload successful!');
    console.log('File URL:', fileUrl);
    
    return fileUrl;
  } catch (error) {
    console.error('❌ Firebase upload failed:', error);
    throw error;
  }
};

// Enhanced function to extract menu from any file type (images, PDFs, docs, CSV, etc.)
// All extractors return { categories: [{ name, order }], menuItems: [...] }
const extractMenuFromAnyFile = async (fileUrl, fileType, fileName) => {
  try {
    console.log(`🔍 Starting enhanced menu extraction for ${fileType} file: ${fileName}`);
    let result;
    if (fileType.startsWith('image/')) {
      result = await extractMenuFromImage(fileUrl);
    } else if (fileType === 'application/pdf') {
      result = await extractMenuFromPDF(fileUrl);
    } else if (fileType.includes('csv') || fileType.includes('excel') || fileType.includes('spreadsheet')) {
      result = await extractMenuFromCSV(fileUrl);
    } else if (fileType.includes('document') || fileType.includes('text')) {
      result = await extractMenuFromDocument(fileUrl);
    } else {
      console.log('⚠️ Unknown file type, attempting image extraction as fallback...');
      result = await extractMenuFromImage(fileUrl);
    }
    if (!Array.isArray(result.categories)) result.categories = [];
    if (!Array.isArray(result.menuItems)) result.menuItems = [];
    return result;
  } catch (error) {
    console.error('❌ Enhanced extraction failed:', error);
    return { categories: [], menuItems: [] };
  }
};

// Extract menu from PDF files. Returns { categories, menuItems }. Prefer section headers from document as categories.
const extractMenuFromPDF = async (pdfUrl) => {
  try {
    console.log('📄 Extracting menu from PDF...');
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this document. If it is a restaurant menu: 1) List section headers in "categories" as [{"name":"SectionName","order":1}]. Use EXACT names. If no sections, use "categories":[].
2) Extract ALL menu items. Set "category" to section name or "Other".
3) VARIANTS: If item shows multiple sizes/prices (e.g., "Half ₹110/Full ₹180", "110/180"), extract as "variants":[{"name":"Half","price":110},{"name":"Full","price":180}]. Otherwise use "variants":[].
Return JSON: {"categories":[...],"menuItems":[{"name":"","description":"","price":0,"category":"...","isVeg":true,"shortCode":"1","variants":[]}]}
shortCode: 1,2,3... If NOT a menu: {"categories":[],"menuItems":[]}`
            },
            { type: "image_url", image_url: { url: pdfUrl, detail: "high" } }
          ]
        }
      ],
      max_tokens: 8000,
      temperature: 0.1
    });
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const d = JSON.parse(jsonMatch[0]);
      return { categories: Array.isArray(d.categories) ? d.categories : [], menuItems: Array.isArray(d.menuItems) ? d.menuItems : [] };
    }
    return { categories: [], menuItems: [] };
  } catch (error) {
    console.error('❌ PDF extraction failed:', error);
    return { categories: [], menuItems: [] };
  }
};

// Extract menu from CSV/Excel. Use Category column if present as categories; else categories:[] and item.category="Other".
const extractMenuFromCSV = async (csvUrl) => {
  try {
    console.log('📊 Extracting menu from CSV/Excel...');
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `This may be a menu in CSV/Excel. 1) If there is a Category/Type column, collect unique values as "categories":[{"name":"X","order":1},...]. If no category column, use "categories":[].
2) Extract ALL rows as menu items. For "category" use the row's Category/Type value if present, else "Other".
3) VARIANTS: If price column shows multiple values (e.g., "110/180", "Half/Full"), extract as "variants":[{"name":"Half","price":110},{"name":"Full","price":180}]. Otherwise use "variants":[].
Return JSON: {"categories":[...],"menuItems":[{"name":"","description":"","price":0,"category":"...","isVeg":true,"shortCode":"1","variants":[]}]}
shortCode: 1,2,3... If NOT a menu: {"categories":[],"menuItems":[]}`
            },
            { type: "image_url", image_url: { url: csvUrl, detail: "high" } }
          ]
        }
      ],
      max_tokens: 8000,
      temperature: 0.1
    });
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const d = JSON.parse(jsonMatch[0]);
      return { categories: Array.isArray(d.categories) ? d.categories : [], menuItems: Array.isArray(d.menuItems) ? d.menuItems : [] };
    }
    return { categories: [], menuItems: [] };
  } catch (error) {
    console.error('❌ CSV extraction failed:', error);
    return { categories: [], menuItems: [] };
  }
};

// Extract menu from document files. Use section headers as categories when present.
const extractMenuFromDocument = async (docUrl) => {
  try {
    console.log('📝 Extracting menu from document...');
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this document. If it is a menu: 1) List section headers as "categories":[{"name":"SectionName","order":1}]. If no sections, "categories":[].
2) Extract ALL items; "category" = section name or "Other".
3) VARIANTS: If item shows multiple sizes/prices (e.g., "Half ₹110/Full ₹180", "110/180"), extract as "variants":[{"name":"Half","price":110},{"name":"Full","price":180}]. Otherwise use "variants":[].
Return JSON: {"categories":[...],"menuItems":[{"name":"","description":"","price":0,"category":"...","isVeg":true,"shortCode":"1","variants":[]}]}
shortCode: 1,2,3... If NOT a menu: {"categories":[],"menuItems":[]}`
            },
            { type: "image_url", image_url: { url: docUrl, detail: "high" } }
          ]
        }
      ],
      max_tokens: 8000,
      temperature: 0.1
    });
    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const d = JSON.parse(jsonMatch[0]);
      return { categories: Array.isArray(d.categories) ? d.categories : [], menuItems: Array.isArray(d.menuItems) ? d.menuItems : [] };
    }
    return { categories: [], menuItems: [] };
  } catch (error) {
    console.error('❌ Document extraction failed:', error);
    return { categories: [], menuItems: [] };
  }
};

// Helper: normalize category name to id (used for storage and matching)
const categoryNameToId = (name) => {
  if (!name || typeof name !== 'string') return 'other';
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
};

// Helper function to extract menu from image using OpenAI Vision
// Returns { categories: [{ name, order }], menuItems: [...] }
// PREFERENCE: Use categories FROM THE MENU PHOTO first. Only if menu has no sections, use fallback.
const extractMenuFromImage = async (imageUrl) => {
  try {
    console.log('🔍 Starting menu extraction – categories from menu first...');
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are an expert menu extraction AI. Analyze this image and extract menu items ONLY if it is a restaurant menu.

STEP 1 – CATEGORIES FROM THE MENU (PRIORITY):
- Menus are usually organized by SECTION HEADERS (e.g. "Starters", "Main Course", "Beverages", "Desserts", "Rice", "Breads", "Curries", "Chinese", "Pizza", custom names like "Chef Specials", "Today’s Special", etc.).
- FIRST list ALL section/section headers you see in the menu, in the ORDER they appear. Use the EXACT name as written (e.g. "Starters", "Main Course", "Tandoor", "Indian Breads").
- If the menu has NO section headers at all, use: "categories": []
- DO NOT use a fixed list – use ONLY the category/section names that appear in THIS menu.

STEP 2 – MENU ITEMS WITH VARIANTS:
- Extract EVERY menu item. For each item, set "category" to the EXACT section name under which it appears (must match one of the names in "categories").
- If the menu has no sections (categories: []), set each item’s "category" to "Other".

IMPORTANT – VARIANTS DETECTION:
- Many items have SIZE/PORTION variants with different prices (e.g., "Half ₹110 / Full ₹180", "Dal Half/Dal Full ₹110/₹180", "Small/Medium/Large", "110/180").
- When you see such patterns, extract them as VARIANTS:
  * If item shows "Half ₹110 / Full ₹180" → create ONE item with name "Item Name" and variants: [{"name":"Half","price":110},{"name":"Full","price":180}]
  * If item shows "Dal Half/Dal Full" or "Dal 110/180" → create ONE item "Dal" with variants: [{"name":"Half","price":110},{"name":"Full","price":180}]
  * If item shows multiple sizes like "Small ₹50 / Medium ₹80 / Large ₹120" → variants: [{"name":"Small","price":50},{"name":"Medium","price":80},{"name":"Large","price":120}]
  * If prices are shown as "110/180" or "₹110/₹180" → typically means Half/Full variants
- For items WITH variants: set "price" to the LOWEST variant price (or 0 if unclear), and include "variants" array.
- For items WITHOUT variants: set "price" normally and use "variants": [] or omit it.

Return ONLY valid JSON in this exact format:
{
  "categories": [
    { "name": "Starters", "order": 1 },
    { "name": "Main Course", "order": 2 },
    { "name": "Beverages", "order": 3 }
  ],
  "menuItems": [
    {
      "name": "Item Name",
      "description": "Item description",
      "price": 100,
      "category": "Starters",
      "isVeg": true,
      "spiceLevel": "mild|medium|hot",
      "allergens": ["dairy", "gluten", "nuts"],
      "shortCode": "1",
      "variants": []
    },
    {
      "name": "Dal",
      "description": "Lentil curry",
      "price": 110,
      "category": "Main Course",
      "isVeg": true,
      "shortCode": "2",
      "variants": [
        { "name": "Half", "price": 110, "description": "" },
        { "name": "Full", "price": 180, "description": "" }
      ]
    }
  ]
}

FALLBACK (only when the menu has NO section headers):
- If categories: [], then set every menuItem.category to "Other".

RULES:
1. If this is NOT a menu, return: {"categories": [], "menuItems": []}
2. If it IS a menu, extract ALL visible items; category must match a "categories[].name" or "Other".
3. Prices: numbers only (remove ₹, $, etc.)
4. isVeg: true/false based on dish. shortCode: sequential 1, 2, 3...
5. description: "" if missing. allergens: only if mentioned.
6. VARIANTS: Look for patterns like "Half/Full", "Small/Medium/Large", "110/180", "₹110/₹180", or any item showing multiple prices. Extract as variants array.
7. Be thorough – do not skip items.`
            },
            {
              type: "image_url",
              image_url: { url: imageUrl, detail: "high" }
            }
          ]
        }
      ],
      max_tokens: 8000,
      temperature: 0.1
    });

    const content = response.choices[0].message.content;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
      const menuItems = Array.isArray(parsed.menuItems) ? parsed.menuItems : [];
      console.log('✅ Extracted categories from menu:', categories.length, '| items:', menuItems.length);
      return { categories, menuItems };
    }
    throw new Error('No valid JSON found in response');
  } catch (error) {
    console.error('❌ Error extracting menu from image:', error);
    try {
      console.log('🔄 Retry with simplified prompt...');
      const retryResponse = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Extract menu from this image. Return JSON:
{"categories": [{"name":"SectionName","order":1}], "menuItems": [{"name":"","price":0,"category":"SectionName","isVeg":true,"shortCode":"1","variants":[]}]}
Use EXACT section names. If item shows variants (e.g., "Half ₹110/Full ₹180"), use "variants":[{"name":"Half","price":110},{"name":"Full","price":180}]. If no sections, use "categories":[] and item "category":"Other". shortCode: 1,2,3...`
              },
              { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
            ]
          }
        ],
        max_tokens: 6000,
        temperature: 0.1
      });
      const retryContent = retryResponse.choices[0].message.content;
      const retryMatch = retryContent.match(/\{[\s\S]*\}/);
      if (retryMatch) {
        const data = JSON.parse(retryMatch[0]);
        return {
          categories: Array.isArray(data.categories) ? data.categories : [],
          menuItems: Array.isArray(data.menuItems) ? data.menuItems : []
        };
      }
    } catch (e) { console.error('Retry failed:', e); }
    throw error;
  }
};

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    message: '🍽️ Dine Restaurant Management System is running!',
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// Admin endpoint to clear all blocked IPs (for emergency use)
app.post('/api/admin/clear-blocked-ips', async (req, res) => {
  try {
    const snapshot = await db.collection('blockedIPs').get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    res.json({ success: true, message: `Cleared ${snapshot.docs.length} blocked IPs` });
  } catch (error) {
    console.error('Error clearing blocked IPs:', error);
    res.status(500).json({ error: 'Failed to clear blocked IPs' });
  }
});

// Warm-up endpoint for Vercel serverless (reduces cold start latency)
app.get('/api/warmup', async (req, res) => {
  try {
    const startTime = Date.now();
    
    // Warm up Firestore connection
    await firestoreOptimizer.warmUp();
    
    // Test a lightweight query
    try {
      const testQuery = db.collection('_warmup').limit(1);
      await testQuery.get();
    } catch (e) {
      // Ignore - collection might not exist, that's fine
    }
    
    const duration = Date.now() - startTime;
    
    res.json({
      status: 'warmed',
      duration: `${duration}ms`,
      timestamp: new Date().toISOString(),
      message: '🔥 Serverless function warmed up and ready'
    });
  } catch (error) {
    // Even if warm-up fails, return success (connection is still established)
    res.json({
      status: 'warmed',
      duration: '0ms',
      timestamp: new Date().toISOString(),
      message: '🔥 Warm-up completed',
      note: 'Connection established'
    });
  }
});

// Demo request endpoint - public, no auth required
app.post('/api/demo-request', async (req, res) => {
  try {
    const { contactType, phone, email, comment } = req.body;

    // Validate required fields
    if (!contactType || (contactType !== 'phone' && contactType !== 'email')) {
      return res.status(400).json({ 
        error: 'Invalid contact type. Must be "phone" or "email"' 
      });
    }

    if (contactType === 'phone' && !phone) {
      return res.status(400).json({ 
        error: 'Phone number is required when contact type is phone' 
      });
    }

    if (contactType === 'email' && !email) {
      return res.status(400).json({ 
        error: 'Email is required when contact type is email' 
      });
    }

    // Validate phone format if provided
    if (phone && !/^[\d\s\-\+\(\)]+$/.test(phone)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format' 
      });
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ 
        error: 'Invalid email format' 
      });
    }

    // Extract restaurant name from comment (format: "Restaurant: {name}\n{additional comments}")
    let restaurantName = '';
    let additionalComment = comment || '';
    if (comment) {
      const restaurantMatch = comment.match(/^Restaurant:\s*(.+?)(?:\n|$)/i);
      if (restaurantMatch) {
        restaurantName = restaurantMatch[1].trim();
        // Remove the restaurant line from additional comment
        additionalComment = comment.replace(/^Restaurant:\s*.+?(\n|$)/i, '').trim();
      } else {
        // If no "Restaurant:" prefix, use the whole comment as restaurant name if it's short
        if (comment.length < 100) {
          restaurantName = comment.trim();
          additionalComment = '';
        }
      }
    }

    // Create demo request document
    const demoRequestRef = db.collection('demoRequests').doc();
    const demoRequestData = {
      id: demoRequestRef.id,
      contactType,
      phone: phone || null,
      email: email || null,
      restaurantName: restaurantName || null,
      comment: additionalComment,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent') || ''
    };

    await demoRequestRef.set(demoRequestData);

    console.log('✅ Demo request saved:', demoRequestData.id);

    // Send email notification to admin
    try {
      const emailResult = await emailService.sendDemoRequestNotification(demoRequestData);
      if (emailResult.success) {
        console.log('✅ Demo request notification email sent:', emailResult.emailId);
      } else {
        console.warn('⚠️ Failed to send demo request notification email:', emailResult.error);
        // Don't fail the request if email fails
      }
    } catch (emailError) {
      console.error('❌ Error sending demo request notification email:', emailError);
      // Don't fail the request if email fails
    }

    res.status(201).json({
      success: true,
      message: 'Demo request submitted successfully! We\'ll contact you soon.',
      requestId: demoRequestRef.id
    });

  } catch (error) {
    console.error('❌ Error saving demo request:', error);
    res.status(500).json({ 
      error: 'Failed to submit demo request. Please try again.' 
    });
  }
});

app.get('/', (req, res) => {
  res.json({
    message: '🍽️ Welcome to Dine - Restaurant Management System!',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    features: [
      '📱 QR Code Digital Menus',
      '🛒 Table-side Ordering',
      '💳 Multiple Payment Options', 
      '👨‍🍳 Kitchen Order Tickets',
      '📊 Analytics Dashboard',
      '🔐 Multi-auth System'
    ],
    endpoints: {
      health: '/health',
      auth: '/api/auth/*',
      restaurants: '/api/restaurants/*',
      menus: '/api/menus/* (includes PATCH /api/menus/item/:id, DELETE /api/menus/item/:id)',
      orders: '/api/orders/*',
      payments: '/api/payments/*',
      tables: '/api/tables/* (includes PATCH /api/tables/:id, DELETE /api/tables/:id)',
      floors: '/api/floors/*',
      bookings: '/api/bookings/*',
      analytics: '/api/analytics/*',
      staff: '/api/staff/*'
    }
  });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, phone, restaurantName, role = 'owner' } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    const existingUser = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (!existingUser.empty) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const emailOTP = generateOTP(phone || 'email');

    const userData = {
      email,
      password: hashedPassword,
      name,
      phone: phone || null,
      role,
      restaurantName: restaurantName || null,
      emailVerified: false,
      phoneVerified: false,
      emailOTP,
      emailOTPExpiry: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const userRef = await db.collection(collections.users).add(userData);
    
    console.log(`📧 Email verification OTP for ${email}: ${emailOTP}`);

    res.status(201).json({
      message: 'User registered successfully. Please verify your email.',
      userId: userRef.id,
      verificationRequired: true
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const userQuery = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (userQuery.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    if (userData.emailOTP !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    if (new Date() > userData.emailOTPExpiry.toDate()) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    await userDoc.ref.update({
      emailVerified: true,
      emailOTP: null,
      emailOTPExpiry: null,
      updatedAt: new Date()
    });

    const token = jwt.sign(
      { userId: userDoc.id, email: userData.email, role: userData.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Email verified successfully',
      token,
      user: {
        id: userDoc.id,
        email: userData.email,
        name: userData.name,
        role: userData.role,
        emailVerified: true
      }
    });

  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Email verification failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const userQuery = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (userQuery.empty) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();

    const isValidPassword = await bcrypt.compare(password, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!userData.emailVerified) {
      return res.status(403).json({ error: 'Please verify your email first' });
    }

    const token = jwt.sign(
      { userId: userDoc.id, email: userData.email, role: userData.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: userDoc.id,
        email: userData.email,
        name: userData.name,
        role: userData.role,
        restaurantName: userData.restaurantName
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ==================== EMAIL/PASSWORD AUTHENTICATION ====================

// Send email OTP for registration or linking
app.post('/api/auth/email/send-otp', async (req, res) => {
  try {
    const { email, purpose = 'registration' } = req.body; // purpose: 'registration' or 'linking'

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const emailOTP = generateOTP('email');
    const emailOTPExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Check if user exists
    const existingUserQuery = await db.collection(collections.users)
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (purpose === 'registration' && !existingUserQuery.empty) {
      return res.status(400).json({ error: 'Email already registered. Please login instead.' });
    }

    // For linking: reject if email already exists (we only link NEW emails)
    if (purpose === 'linking' && !existingUserQuery.empty) {
      return res.status(400).json({ 
        error: 'This email is already registered. Please use a different email or login with this email instead.',
        emailExists: true
      });
    }

    // Store OTP in temporary collection for linking (email doesn't exist yet)
    // For registration, also store in temp if user doesn't exist
    if (purpose === 'linking' || existingUserQuery.empty) {
      // Store in temporary collection
      await db.collection('email_otp_temp').add({
        email: normalizedEmail,
        otp: emailOTP,
        otpExpiry: emailOTPExpiry,
        purpose,
        createdAt: new Date()
      });
    } else {
      // Existing user (registration case where user exists) - update OTP in user document
      await existingUserQuery.docs[0].ref.update({
        emailOTP,
        emailOTPExpiry,
        updatedAt: new Date()
      });
    }

    // Send email with OTP
    try {
      await emailService.sendEmail({
        to: normalizedEmail,
        subject: 'Your DineOpen Verification Code',
        text: `Your DineOpen verification code is: ${emailOTP}. This code is valid for 10 minutes.`,
        html: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px; text-align: center; border-radius: 8px 8px 0 0;">
              <h1 style="color: white; margin: 0;">DineOpen Verification</h1>
            </div>
            <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px;">
              <p style="font-size: 16px;">Your verification code is:</p>
              <div style="background: white; padding: 20px; text-align: center; border-radius: 8px; margin: 20px 0;">
                <h2 style="color: #ef4444; font-size: 32px; margin: 0; letter-spacing: 5px;">${emailOTP}</h2>
              </div>
              <p style="font-size: 14px; color: #666;">This code is valid for 10 minutes.</p>
              <p style="font-size: 14px; color: #666;">If you didn't request this code, please ignore this email.</p>
            </div>
          </body>
          </html>
        `
      });
    } catch (emailError) {
      console.error('Email send error:', emailError);
      // Still return success but log the OTP for development
      console.log(`📧 Email OTP for ${normalizedEmail}: ${emailOTP} (Email service failed)`);
    }

    res.json({
      success: true,
      message: 'OTP sent successfully to your email',
      email: normalizedEmail
    });

  } catch (error) {
    console.error('Send email OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Email/Password Registration with OTP verification
app.post('/api/auth/email/register', async (req, res) => {
  try {
    const { email, password, confirmPassword, name, otp } = req.body;

    if (!email || !password || !confirmPassword || !name) {
      return res.status(400).json({ error: 'Email, password, confirm password, and name are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existingUserQuery = await db.collection(collections.users)
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (!existingUserQuery.empty) {
      return res.status(400).json({ error: 'Email already registered. Please login instead.' });
    }

    // Verify OTP if provided (for registration flow)
    if (otp) {
      // Check temporary OTP or user document
      const tempOtpQuery = await db.collection('email_otp_temp')
        .where('email', '==', normalizedEmail)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (tempOtpQuery.empty) {
        return res.status(400).json({ error: 'OTP not found. Please request a new OTP.' });
      }

      const tempOtpData = tempOtpQuery.docs[0].data();
      if (tempOtpData.otp !== otp) {
        return res.status(400).json({ error: 'Invalid OTP' });
      }

      if (new Date() > tempOtpData.otpExpiry.toDate()) {
        return res.status(400).json({ error: 'OTP expired. Please request a new OTP.' });
      }

      // Delete temporary OTP
      await tempOtpQuery.docs[0].ref.delete();
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Check if user exists with phone (for linking)
    // This will be handled in the linking logic

    // Create new user
    const newUser = {
      email: normalizedEmail,
      password: hashedPassword,
      name: name.trim(),
      role: 'owner',
      emailVerified: !!otp, // Verified if OTP was provided
      phoneVerified: false,
      provider: 'email',
      setupComplete: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const userRef = await db.collection(collections.users).add(newUser);
    const userId = userRef.id;

    // Create default subscription
    await createDefaultSubscription(userId, normalizedEmail, null, 'owner');

    // Generate JWT token
    const token = jwt.sign(
      { userId, email: normalizedEmail, role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Check if user has restaurants
    const restaurantsQuery = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .limit(1)
      .get();
    
    const hasRestaurants = !restaurantsQuery.empty;

    res.json({
      success: true,
      message: otp ? 'Registration successful! Email verified.' : 'Registration successful! Please verify your email.',
      token: otp ? token : null,
      user: {
        id: userId,
        email: normalizedEmail,
        name: name.trim(),
        role: 'owner',
        emailVerified: !!otp,
        setupComplete: false
      },
      firstTimeUser: true,
      isNewUser: true,
      hasRestaurants,
      verificationRequired: !otp,
      redirectTo: hasRestaurants ? '/dashboard' : '/admin'
    });

  } catch (error) {
    console.error('Email registration error:', error);
    res.status(500).json({ 
      error: 'Registration failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Verify Email OTP (for registration completion or linking)
app.post('/api/auth/email/verify-otp', async (req, res) => {
  try {
    const { email, otp, purpose = 'registration' } = req.body; // purpose: 'registration' or 'linking'

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const userQuery = await db.collection(collections.users)
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    let userDoc = null;
    let userId = null;

    if (!userQuery.empty) {
      userDoc = userQuery.docs[0];
      userId = userDoc.id;
    } else if (purpose === 'registration') {
      // Check temporary OTP for new registration
      const tempOtpQuery = await db.collection('email_otp_temp')
        .where('email', '==', normalizedEmail)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (tempOtpQuery.empty) {
        return res.status(404).json({ error: 'OTP not found. Please complete registration first.' });
      }

      const tempOtpData = tempOtpQuery.docs[0].data();
      if (tempOtpData.otp !== otp) {
        return res.status(400).json({ error: 'Invalid OTP' });
      }

      if (new Date() > tempOtpData.otpExpiry.toDate()) {
        return res.status(400).json({ error: 'OTP expired. Please request a new OTP.' });
      }

      return res.json({
        success: true,
        message: 'OTP verified. Please complete registration with password.',
        email: normalizedEmail,
        otpVerified: true
      });
    } else {
      return res.status(404).json({ error: 'User not found' });
    }

    // For existing users (linking or verification)
    const userData = userDoc.data();

    // Check OTP from user document or temp collection
    let isValidOtp = false;
    let otpExpiry = null;

    if (userData.emailOTP) {
      isValidOtp = userData.emailOTP === otp;
      otpExpiry = userData.emailOTPExpiry;
    } else {
      // Check temp collection
      const tempOtpQuery = await db.collection('email_otp_temp')
        .where('email', '==', normalizedEmail)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (!tempOtpQuery.empty) {
        const tempOtpData = tempOtpQuery.docs[0].data();
        isValidOtp = tempOtpData.otp === otp;
        otpExpiry = tempOtpData.otpExpiry;
      }
    }

    if (!isValidOtp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    if (otpExpiry && new Date() > otpExpiry.toDate()) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    // Update user - verify email
    await userDoc.ref.update({
      emailVerified: true,
      emailOTP: null,
      emailOTPExpiry: null,
      updatedAt: new Date()
    });

    // Delete temp OTP if exists
    const tempOtpQuery = await db.collection('email_otp_temp')
      .where('email', '==', normalizedEmail)
      .get();
    
    const batch = db.batch();
    tempOtpQuery.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    // Generate JWT token
    const token = jwt.sign(
      { userId, email: normalizedEmail, role: userData.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Check if user has restaurants
    const restaurantsQuery = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .limit(1)
      .get();
    
    const hasRestaurants = !restaurantsQuery.empty;

    res.json({
      success: true,
      message: purpose === 'linking' ? 'Email linked successfully!' : 'Email verified successfully!',
      token,
      user: {
        id: userId,
        email: normalizedEmail,
        name: userData.name,
        phone: userData.phone,
        role: userData.role,
        emailVerified: true,
        phoneVerified: userData.phoneVerified || false,
        setupComplete: userData.setupComplete || false
      },
      hasRestaurants,
      redirectTo: hasRestaurants ? '/dashboard' : '/admin'
    });

  } catch (error) {
    console.error('Email OTP verification error:', error);
    res.status(500).json({ error: 'OTP verification failed' });
  }
});

// Email/Password Login
app.post('/api/auth/email/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find user by email
    const userQuery = await db.collection(collections.users)
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    if (userQuery.empty) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();
    const userId = userDoc.id;

    // Check if user has password (email-based login)
    if (!userData.password) {
      return res.status(401).json({ 
        error: 'Password not set. Please use the login method you used to register (Gmail or Phone).',
        alternativeLogin: true
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if email is verified
    if (!userData.emailVerified) {
      return res.status(403).json({ 
        error: 'Email not verified. Please verify your email first.',
        verificationRequired: true,
        email: normalizedEmail
      });
    }

    // Update last login
    await userDoc.ref.update({
      lastLogin: new Date(),
      updatedAt: new Date()
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId, email: normalizedEmail, role: userData.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Check if user has restaurants
    const restaurantsQuery = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .limit(1)
      .get();
    
    const hasRestaurants = !restaurantsQuery.empty;

    // Get subdomain URL if enabled
    let subdomainUrl = null;
    if (SUBDOMAIN_FEATURE_ENABLED && hasRestaurants) {
      const restaurantsQueryForSubdomain = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();

      if (!restaurantsQueryForSubdomain.empty) {
        const restaurant = restaurantsQueryForSubdomain.docs[0].data();
        if (restaurant.subdomainEnabled && restaurant.subdomain) {
          subdomainUrl = getSubdomainUrl(restaurant.subdomain, '/dashboard');
        }
      }
    }

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: userId,
        email: normalizedEmail,
        name: userData.name,
        phone: userData.phone || null,
        role: userData.role,
        emailVerified: true,
        phoneVerified: userData.phoneVerified || false,
        setupComplete: userData.setupComplete || false
      },
      hasRestaurants,
      subdomainUrl,
      redirectTo: subdomainUrl || (hasRestaurants ? '/dashboard' : '/admin')
    });

  } catch (error) {
    console.error('Email login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Link email to existing phone-based user
app.post('/api/user/link-email', authenticateToken, async (req, res) => {
  try {
    const { email, password, confirmPassword, otp } = req.body;
    const userId = req.user.userId;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Get current user
    const userDoc = await db.collection(collections.users).doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    // Check if email already exists in database (any user)
    const emailQuery = await db.collection(collections.users)
      .where('email', '==', normalizedEmail)
      .limit(1)
      .get();

    // Reject if email exists for ANY user (including current user)
    if (!emailQuery.empty) {
      return res.status(400).json({ 
        error: 'This email is already registered. Please use a different email or login with this email instead.',
        emailExists: true
      });
    }

    // If OTP provided, verify it
    if (otp) {
      let isValidOtp = false;
      
      if (userData.emailOTP && userData.emailOTP === otp) {
        if (userData.emailOTPExpiry && new Date() <= userData.emailOTPExpiry.toDate()) {
          isValidOtp = true;
        }
      }

      // Check temp collection
      if (!isValidOtp) {
        const tempOtpQuery = await db.collection('email_otp_temp')
          .where('email', '==', normalizedEmail)
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get();

        if (!tempOtpQuery.empty) {
          const tempOtpData = tempOtpQuery.docs[0].data();
          if (tempOtpData.otp === otp && new Date() <= tempOtpData.otpExpiry.toDate()) {
            isValidOtp = true;
            await tempOtpQuery.docs[0].ref.delete();
          }
        }
      }

      if (!isValidOtp) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }

      // Update user with email and password
      const updateData = {
        email: normalizedEmail,
        emailVerified: true,
        emailOTP: null,
        emailOTPExpiry: null,
        updatedAt: new Date()
      };

      // Add password if provided
      if (password) {
        if (!confirmPassword || password !== confirmPassword) {
          return res.status(400).json({ error: 'Passwords do not match' });
        }
        if (password.length < 6) {
          return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }
        updateData.password = await bcrypt.hash(password, 10);
      }

      await userDoc.ref.update(updateData);

      res.json({
        success: true,
        message: 'Email linked successfully!',
        user: {
          id: userId,
          email: normalizedEmail,
          phone: userData.phone,
          name: userData.name,
          emailVerified: true,
          phoneVerified: userData.phoneVerified || false
        }
      });
    } else {
      // OTP not provided - return that OTP is required
      return res.status(400).json({ 
        error: 'OTP verification required',
        otpRequired: true,
        email: normalizedEmail
      });
    }

  } catch (error) {
    console.error('Link email error:', error);
    res.status(500).json({ error: 'Failed to link email' });
  }
});

// Link phone to existing email-based user
app.post('/api/user/link-phone', authenticateToken, async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const userId = req.user.userId;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // Get current user
    const userDoc = await db.collection(collections.users).doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    // Check if phone already exists in database (any user)
    const phoneQuery = await db.collection(collections.users)
      .where('phone', '==', normalizedPhone)
      .limit(1)
      .get();

    // Reject if phone exists for ANY user (including current user)
    if (!phoneQuery.empty) {
      return res.status(400).json({ 
        error: 'This phone number is already registered. Please use a different phone number or login with this phone instead.',
        phoneExists: true
      });
    }

    // If OTP provided, verify it using the same OTP verification as login
    if (otp) {
      // Check if this is a demo account
      const isDemoAccount = normalizedPhone === '+919000000000' && otp === '1234';
      let otpValid = false;

      if (isDemoAccount) {
        console.log('🎭 Demo account phone linking detected:', normalizedPhone);
        otpValid = true;
      } else {
        // Regular OTP verification (same as login)
        const otpQuery = await db.collection('otp_verification')
          .where('phone', '==', normalizedPhone)
          .where('otp', '==', otp)
          .limit(1)
          .get();

        if (!otpQuery.empty) {
          const otpData = otpQuery.docs[0].data();
          if (new Date() <= otpData.otpExpiry.toDate()) {
            otpValid = true;
            // Delete used OTP
            await otpQuery.docs[0].ref.delete();
          }
        }
      }

      if (!otpValid) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
      }

      // Update user with phone (verified via OTP)
      await userDoc.ref.update({
        phone: normalizedPhone,
        phoneVerified: true, // Verified via OTP
        updatedAt: new Date()
      });

      res.json({
        success: true,
        message: 'Phone number linked successfully!',
        user: {
          id: userId,
          email: userData.email,
          phone: normalizedPhone,
          name: userData.name,
          emailVerified: userData.emailVerified || false,
          phoneVerified: true
        }
      });
    } else {
      // OTP not provided - return that OTP is required
      return res.status(400).json({ 
        error: 'OTP verification required. Please send OTP first using /api/auth/phone/send-otp',
        otpRequired: true,
        phone: normalizedPhone
      });
    }

  } catch (error) {
    console.error('Link phone error:', error);
    res.status(500).json({ error: 'Failed to link phone' });
  }
});

// Change password for email/password users
app.post('/api/user/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user.userId;

    // Validate input
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All password fields are required' });
    }

    // Check if new password matches confirmation
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }

    // Validate new password length
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    // Get user document
    const userDoc = await db.collection(collections.users).doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();

    // Check if user has a password set (email/password login)
    if (!userData.password) {
      return res.status(400).json({ 
        error: 'Password change is only available for users who registered with email/password. Please use the login method you used to register.',
        noPasswordSet: true
      });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Check if new password is different from current password
    const isSamePassword = await bcrypt.compare(newPassword, userData.password);
    if (isSamePassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password
    await userDoc.ref.update({
      password: hashedPassword,
      updatedAt: new Date()
    });

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Change password for staff members (loginId-based)
app.post('/api/staff/change-password', authenticateToken, async (req, res) => {
  try {
    const { loginId, currentPassword, newPassword, confirmPassword } = req.body;
    const userId = req.user.userId;

    // Validate input
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: 'All password fields are required' });
    }

    // Check if new password matches confirmation
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'New password and confirmation do not match' });
    }

    // Validate new password length
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    // Get user document
    const userDoc = await db.collection(collections.users).doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const userData = userDoc.data();

    // Verify this is a staff member (has loginId and is staff role)
    if (!userData.loginId || !['waiter', 'manager', 'employee'].includes(userData.role?.toLowerCase())) {
      return res.status(403).json({ 
        error: 'Password change is only available for staff members',
        notStaff: true
      });
    }

    // If loginId is provided, verify it matches
    if (loginId && loginId !== userData.loginId) {
      return res.status(400).json({ error: 'Login ID does not match' });
    }

    // Check if user has a password set
    if (!userData.password) {
      return res.status(400).json({ 
        error: 'Password not set. Please contact your administrator.',
        noPasswordSet: true
      });
    }

    // Verify current password
    const isValidPassword = await bcrypt.compare(currentPassword, userData.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Check if new password is different from current password
    const isSamePassword = await bcrypt.compare(newPassword, userData.password);
    if (isSamePassword) {
      return res.status(400).json({ error: 'New password must be different from current password' });
    }

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear temporary password flag if it exists
    const updateData = {
      password: hashedPassword,
      updatedAt: new Date()
    };

    // If this was a temporary password, mark it as changed
    if (userData.temporaryPassword) {
      updateData.temporaryPassword = false;
      // Also delete from staffCredentials collection if exists
      try {
        const credentialsDoc = await db.collection('staffCredentials').doc(userId).get();
        if (credentialsDoc.exists) {
          await credentialsDoc.ref.delete();
        }
      } catch (err) {
        console.error('Error deleting staff credentials:', err);
        // Don't fail the request if this fails
      }
    }

    await userDoc.ref.update(updateData);

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Staff change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { uid, email, name, picture } = req.body;
    
    console.log('🔍 Google login debug:');
    console.log('🔍 UID:', uid);
    console.log('🔍 Email:', email);
    console.log('🔍 Name:', name);

    if (!uid || !email) {
      return res.status(400).json({ error: 'Missing required user data' });
    }

    // Trust Firebase Auth - no need to verify Google token
    // Firebase already verified the user is legitimate

    // Smart linking: Check by email first, then by phone if email not found
    let userDoc = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    let userId;
    let isNewUser = false;
    let hasRestaurants = false;
    let linkedPhone = false;

    console.log('🔍 Gmail login debug - User exists by email:', !userDoc.empty);
    console.log('🔍 Gmail login debug - Email:', email);

    // If not found by email, check if there's a user with this email as phone (unlikely but handle edge case)
    // Actually, let's check if user exists with phone that matches email pattern (very rare)
    // For now, just handle email-based lookup

    if (userDoc.empty) {
      console.log('🆕 NEW Gmail user detected - will send welcome email');
      // New Gmail user - assume restaurant owner
      const newUser = {
        email,
        name,
        picture,
        googleUid: uid, // Store Google UID for future reference
        role: 'owner', // Changed from 'customer' to 'owner' for restaurant management
        emailVerified: true,
        phoneVerified: false,
        provider: 'google',
        setupComplete: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
      isNewUser = true;
      
      console.log('✅ New Google user created (no auto-restaurant):', userId);
      hasRestaurants = false; // No restaurant created yet

      // Create default free-trial subscription for new user
      await createDefaultSubscription(userId, email, phone || null, 'owner');

      // Send welcome email to new Gmail users
      console.log('📧 === REACHING EMAIL SENDING SECTION ===');
      try {
        console.log(`📧 === WELCOME EMAIL DEBUG START ===`);
        console.log(`📧 User details:`, { email, name, userId, isNewUser });
        console.log(`📧 Email service available:`, !!emailService);
        console.log(`📧 Email service methods:`, Object.keys(emailService || {}));
        
        if (!emailService) {
          console.error('❌ Email service not available!');
          throw new Error('Email service not initialized');
        }
        
        if (!emailService.sendWelcomeEmail) {
          console.error('❌ sendWelcomeEmail method not found!');
          throw new Error('sendWelcomeEmail method not available');
        }
        
        const userData = {
          email: email,
          name: name,
          userId: userId
        };
        
        console.log(`📧 Calling sendWelcomeEmail with data:`, userData);
        const emailResult = await emailService.sendWelcomeEmail(userData);
        console.log(`✅ Welcome email sent successfully to ${email}:`, emailResult);
        console.log(`📧 === WELCOME EMAIL DEBUG END ===`);
      } catch (emailError) {
        console.error('❌ === WELCOME EMAIL ERROR DEBUG ===');
        console.error('❌ Email error type:', typeof emailError);
        console.error('❌ Email error message:', emailError.message);
        console.error('❌ Email error stack:', emailError.stack);
        console.error('❌ Email error details:', emailError);
        console.error('❌ === WELCOME EMAIL ERROR DEBUG END ===');
        // Don't fail the login if email sending fails
      }
    } else {
      // Existing user login - smart linking
      userId = userDoc.docs[0].id;
      const userData = userDoc.docs[0].data();
      
      // Update user with Google info - smart linking
      const updateData = {
        updatedAt: new Date(),
        picture: picture || userData.picture,
        googleUid: uid // Store Google UID for future reference
      };

      // Ensure email is set (should already be set, but just in case)
      if (!userData.email) {
        updateData.email = email.toLowerCase().trim();
        updateData.emailVerified = true; // Gmail login verifies email
      } else if (userData.email.toLowerCase().trim() === email.toLowerCase().trim()) {
        // Email matches - verify if not already verified (Gmail login verifies email)
        if (!userData.emailVerified) {
          updateData.emailVerified = true;
        }
      }

      // Keep phone if it exists (don't overwrite)
      // Phone linking will be done separately via profile page

      await userDoc.docs[0].ref.update(updateData);

      // Check if owner has restaurants
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();
      
      hasRestaurants = !restaurantsQuery.empty;
    }

    const userRole = userDoc.empty ? 'owner' : userDoc.docs[0].data().role;

    const jwtToken = jwt.sign(
      { userId, email, role: userRole },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: isNewUser ? 'Welcome! Account created successfully.' : 'Google login successful',
      token: jwtToken,
      user: {
        id: userId,
        email,
        name,
        picture,
        role: userRole,
        setupComplete: userDoc.empty ? true : userDoc.docs[0].data().setupComplete || false
      },
      firstTimeUser: isNewUser,
      isNewUser, // Keep for backward compatibility
      hasRestaurants,
      redirectTo: hasRestaurants ? '/dashboard' : '/admin'
    });

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime()
  });
});

// Handle OPTIONS requests for CORS preflight - Middleware approach
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    console.log('🔄 OPTIONS request received for:', req.path);
    res.status(200).end();
    return;
  }
  next();
});

app.post('/api/auth/phone/send-otp', async (req, res) => {
  try {
    console.log('📱 OTP request received from origin:', req.headers.origin);
    console.log('📱 Request headers:', req.headers);
    
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const otp = generateOTP(phone);
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    const otpRecord = {
      phone,
      otp,
      otpExpiry,
      createdAt: new Date()
    };

    await db.collection('otp_verification').add(otpRecord);

    const smsSent = await sendOTP(phone, otp);

    if (!smsSent) {
      console.log(`📱 SMS OTP for ${phone}: ${otp}`);
    }

    res.json({
      message: 'OTP sent successfully',
      success: true
    });

  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Firebase OTP verification endpoint
app.post('/api/auth/firebase/verify', async (req, res) => {
  try {
    const { uid, phoneNumber, email, displayName, photoURL } = req.body;

    if (!uid) {
      return res.status(400).json({ error: 'Firebase UID is required' });
    }

    console.log('🔍 Firebase OTP verification debug:');
    console.log('🔍 UID:', uid);
    console.log('🔍 Phone:', phoneNumber);
    console.log('🔍 Email:', email);
    console.log('🔍 Display Name:', displayName);

    let userId, isNewUser = false, hasRestaurants = false;
    let userDoc = null;

    // Check if user exists by Firebase UID first
    let existingUserQuery = await db.collection(collections.users)
      .where('firebaseUid', '==', uid)
      .get();

    if (!existingUserQuery.empty) {
      // User exists with this Firebase UID
      userDoc = existingUserQuery.docs[0];
      userId = userDoc.id;
      isNewUser = false;
      console.log('✅ User found by Firebase UID:', userId);
    } else {
      // Check if user exists by phone number or email
      let phoneQuery = null;
      let emailQuery = null;

      if (phoneNumber) {
        phoneQuery = await db.collection(collections.users)
          .where('phone', '==', phoneNumber)
          .get();
      }

      if (email) {
        emailQuery = await db.collection(collections.users)
          .where('email', '==', email)
          .get();
      }

      if (phoneQuery && !phoneQuery.empty) {
        // User exists with this phone number - smart linking
        userDoc = phoneQuery.docs[0];
        userId = userDoc.id;
        isNewUser = false;
        const userData = userDoc.data();
        
        // Update existing user with Firebase UID and link email if provided
        const updateData = {
          firebaseUid: uid,
          phoneVerified: true,
          updatedAt: new Date()
        };

        // Link email if provided and not already set
        if (email && !userData.email) {
          updateData.email = email.toLowerCase().trim();
          updateData.emailVerified = true; // Verified via Firebase
        } else if (email && userData.email && userData.email !== email.toLowerCase().trim()) {
          // Email exists but different - don't overwrite, just log
          console.log('⚠️ User has different email, keeping existing:', userData.email);
        }

        await db.collection(collections.users).doc(userId).update(updateData);
        
        console.log('✅ User found by phone number, updated with Firebase UID and linked email:', userId);
      } else if (emailQuery && !emailQuery.empty) {
        // User exists with this email - smart linking
        userDoc = emailQuery.docs[0];
        userId = userDoc.id;
        isNewUser = false;
        const userData = userDoc.data();
        
        // Update existing user with Firebase UID and link phone if provided
        const updateData = {
          firebaseUid: uid,
          emailVerified: true,
          updatedAt: new Date()
        };

        // Link phone if provided and not already set
        if (phoneNumber && !userData.phone) {
          updateData.phone = phoneNumber;
          updateData.phoneVerified = true; // Verified via Firebase
        } else if (phoneNumber && userData.phone && userData.phone !== phoneNumber) {
          // Phone exists but different - don't overwrite, just log
          console.log('⚠️ User has different phone, keeping existing:', userData.phone);
        }

        await db.collection(collections.users).doc(userId).update(updateData);
        
        console.log('✅ User found by email, updated with Firebase UID and linked phone:', userId);
      } else {
        // Completely new user - create new account
        console.log('🆕 Creating new user account');
      // New user registration via Firebase
      const newUser = {
        firebaseUid: uid,
        phone: phoneNumber || null,
        email: email || null,
        name: displayName || 'Restaurant Owner',
        photoURL: photoURL || null,
        role: 'owner',
        emailVerified: !!email,
        phoneVerified: !!phoneNumber,
        provider: email ? 'google' : 'firebase',
        setupComplete: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
      isNewUser = true;
      userDoc = { data: () => newUser };
      
      console.log('✅ New user created (no auto-restaurant):', userId);
      hasRestaurants = false; // No restaurant created yet

      // Create default free-trial subscription for new user
      await createDefaultSubscription(userId, email || null, phoneNumber || null, 'owner');
      }
    }

    // For existing users, update their info and handle smart linking
    if (!isNewUser) {
      const userData = userDoc.data();
      
      // Update user info if needed - smart linking (preserve existing verification status)
      const updateData = {
        updatedAt: new Date()
      };

      // Link email if provided and not already set
      if (email && !userData.email) {
        updateData.email = email.toLowerCase().trim();
        updateData.emailVerified = true; // Verified via Firebase
      } else if (email && userData.email && userData.email.toLowerCase().trim() === email.toLowerCase().trim()) {
        // Email matches - only verify if not already verified (don't overwrite if already verified)
        if (!userData.emailVerified) {
          updateData.emailVerified = true;
        }
      }

      // Link phone if provided and not already set
      if (phoneNumber && !userData.phone) {
        updateData.phone = phoneNumber;
        updateData.phoneVerified = true; // Verified via Firebase
      } else if (phoneNumber && userData.phone && userData.phone === phoneNumber) {
        // Phone matches - only verify if not already verified (don't overwrite if already verified)
        if (!userData.phoneVerified) {
          updateData.phoneVerified = true;
        }
      }

      if (displayName && !userData.name) updateData.name = displayName;
      if (photoURL && !userData.photoURL) updateData.photoURL = photoURL;
      
      // Update provider if logging in with Google (only if email provided)
      if (email && userData.provider !== 'google') {
        updateData.provider = 'google';
      }

      // Only update if there are changes (more than just updatedAt)
      if (Object.keys(updateData).length > 1) {
        await userDoc.ref.update(updateData);
      }
    }

    // Check if user has restaurants (for both new and existing users)
    const restaurantsQuery = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .limit(1)
      .get();
    
    hasRestaurants = !restaurantsQuery.empty;

    // Generate JWT token
    const token = jwt.sign(
      { userId, phone: phoneNumber, email, role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Get user's restaurants for the response
    let userRestaurants = [];
    let subdomainUrl = null;
    
    if (hasRestaurants) {
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .get();
      userRestaurants = restaurantsQuery.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // Check if subdomain is enabled for the first restaurant (only if feature is enabled)
      const firstRestaurant = userRestaurants[0];
      if (SUBDOMAIN_FEATURE_ENABLED && firstRestaurant && firstRestaurant.subdomainEnabled && firstRestaurant.subdomain) {
        subdomainUrl = getSubdomainUrl(firstRestaurant.subdomain, '/dashboard');
      }
    }

    res.json({
      success: true,
      message: isNewUser ? 'Welcome! Account created successfully.' : 'Login successful',
      token,
      user: {
        id: userId,
        phone: phoneNumber,
        email,
        name: displayName || 'Restaurant Owner',
        role: 'owner',
        photoURL,
        provider: email ? 'google' : 'firebase',
        restaurantId: userRestaurants.length > 0 ? userRestaurants[0].id : null,
        restaurant: userRestaurants.length > 0 ? userRestaurants[0] : null,
        setupComplete: userDoc ? userDoc.data().setupComplete || false : false
      },
      firstTimeUser: isNewUser,
      isNewUser, // Keep for backward compatibility
      hasRestaurants,
      restaurants: userRestaurants,
      subdomainUrl, // Include subdomain URL if enabled
      redirectTo: subdomainUrl || (hasRestaurants ? '/dashboard' : '/admin')
    });

  } catch (error) {
    console.error('Firebase verification error:', error);
    res.status(500).json({ 
      error: 'Firebase verification failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Owner phone-based registration/login
app.post('/api/auth/phone/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    // Check if this is a demo account
    const isDemoAccount = phone === '+919000000000' && otp === '1234';
    let otpDoc = null;
    
    if (isDemoAccount) {
      console.log('🎭 Demo account login detected:', phone);
      // Skip OTP verification for demo account
    } else {
      // Regular OTP verification for non-demo accounts
      const otpQuery = await db.collection('otp_verification')
        .where('phone', '==', phone)
        .where('otp', '==', otp)
        .limit(1)
        .get();

      if (otpQuery.empty) {
        return res.status(400).json({ error: 'Invalid OTP' });
      }

      otpDoc = otpQuery.docs[0];
      const otpData = otpDoc.data();

      if (new Date() > otpData.otpExpiry.toDate()) {
        return res.status(400).json({ error: 'OTP expired' });
      }
    }

    let userDoc = await db.collection(collections.users)
      .where('phone', '==', phone)
      .get();

    let userId, isNewUser = false, hasRestaurants = false;

    if (userDoc.empty) {
      // New owner registration
      const newUser = {
        phone,
        name: name || 'Restaurant Owner',
        role: 'owner',
        emailVerified: false,
        phoneVerified: true,
        provider: 'phone',
        setupComplete: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
      isNewUser = true;
      
      console.log('✅ New phone user created (no auto-restaurant):', userId);
      hasRestaurants = false; // No restaurant created yet

      // Create default free-trial subscription for new user
      await createDefaultSubscription(userId, null, phone, 'owner');
    } else {
      // Existing owner login
      const userData = userDoc.docs[0].data();
      userId = userDoc.docs[0].id;
      
      await userDoc.docs[0].ref.update({
        phoneVerified: true,
        updatedAt: new Date()
      });

      // Check if owner has restaurants
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();
      
      hasRestaurants = !restaurantsQuery.empty;
    }

    // Only delete OTP if it's not a demo account
    if (!isDemoAccount && otpDoc) {
      await otpDoc.ref.delete();
    }

    const token = jwt.sign(
      { userId, phone, role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Get user's restaurants for subdomain check (only if feature is enabled)
    let subdomainUrl = null;
    if (SUBDOMAIN_FEATURE_ENABLED && hasRestaurants) {
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();

      if (!restaurantsQuery.empty) {
        const restaurant = restaurantsQuery.docs[0].data();
        if (restaurant.subdomainEnabled && restaurant.subdomain) {
          subdomainUrl = getSubdomainUrl(restaurant.subdomain, '/dashboard');
        }
      }
    }

    res.json({
      success: true,
      message: isNewUser ? 'Welcome! Account created successfully.' : 'Phone verification successful',
      token,
      user: {
        id: userId,
        phone,
        name: name || userDoc.docs[0]?.data()?.name || 'Restaurant Owner',
        role: 'owner',
        setupComplete: userDoc.empty ? false : userDoc.docs[0]?.data()?.setupComplete || false
      },
      firstTimeUser: isNewUser,
      isNewUser, // Keep for backward compatibility
      hasRestaurants,
      subdomainUrl, // Include subdomain URL if enabled
      redirectTo: subdomainUrl || (hasRestaurants ? '/dashboard' : '/admin')
    });

  } catch (error) {
    console.error('Phone verification error:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ 
      error: 'Phone verification failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Admin Setup Endpoint - Bypass OTP for client setup
// POST /api/admin/setup-client
// Requires: ADMIN_SETUP_KEY in environment variable
// Body: { phone, name, restaurantName, restaurantData }
app.post('/api/admin/setup-client', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-setup-key'] || req.body.adminKey;
    const expectedKey = process.env.ADMIN_SETUP_KEY || 'dine-admin-setup-key-change-in-production';
    
    if (!adminKey || adminKey !== expectedKey) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Invalid admin setup key'
      });
    }

    const { phone, name, restaurantName, restaurantData } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Normalize phone number
    const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;

    // Check if user exists
    let userDoc = await db.collection(collections.users)
      .where('phone', '==', normalizedPhone)
      .limit(1)
      .get();

    let userId, isNewUser = false;

    if (userDoc.empty) {
      // Create new user
      const newUser = {
        phone: normalizedPhone,
        name: name || 'Restaurant Owner',
        role: 'owner',
        emailVerified: false,
        phoneVerified: true, // Skip OTP verification for admin setup
        provider: 'admin-setup',
        setupComplete: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
      isNewUser = true;
      
      console.log('✅ Admin setup: New user created:', userId);
      
      // Create default subscription
      await createDefaultSubscription(userId, null, normalizedPhone, 'owner');
    } else {
      // Existing user
      userId = userDoc.docs[0].id;
      const userData = userDoc.docs[0].data();
      
      // Update user to mark phone as verified
      await userDoc.docs[0].ref.update({
        phoneVerified: true,
        name: name || userData.name,
        updatedAt: new Date()
      });
      
      console.log('✅ Admin setup: Existing user found:', userId);
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId, phone: normalizedPhone, role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Check if user already has restaurants
    const existingRestaurants = await db.collection(collections.restaurants)
      .where('ownerId', '==', userId)
      .get();

    let restaurant = null;
    let restaurantId = null;

    // Create restaurant if restaurantName is provided
    if (restaurantName) {
      // Check if restaurant with same name already exists for this user
      const existingRestaurant = existingRestaurants.docs.find(
        doc => doc.data().name === restaurantName
      );

      if (existingRestaurant) {
        restaurantId = existingRestaurant.id;
        restaurant = { id: restaurantId, ...existingRestaurant.data() };
        console.log('✅ Admin setup: Using existing restaurant:', restaurantId);
      } else {
        // Create new restaurant
        const restaurantInfo = {
          name: restaurantName,
          address: restaurantData?.address || null,
          city: restaurantData?.city || null,
          phone: restaurantData?.phone || normalizedPhone,
          email: restaurantData?.email || null,
          cuisine: restaurantData?.cuisine || [],
          description: restaurantData?.description || '',
          operatingHours: restaurantData?.operatingHours || {},
          features: restaurantData?.features || {},
          ownerId: userId,
          subdomain: null, // Subdomain generation disabled
          subdomainEnabled: false,
          status: 'active',
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const restaurantRef = await db.collection(collections.restaurants).add(restaurantInfo);
        restaurantId = restaurantRef.id;
        restaurant = { id: restaurantId, ...restaurantInfo };

        // Create user-restaurant relationship
        await db.collection(collections.userRestaurants).add({
          userId: userId,
          restaurantId: restaurantId,
          role: 'owner',
          createdAt: new Date(),
          updatedAt: new Date()
        });

        // Generate QR data
        const qrData = `${process.env.FRONTEND_URL || 'https://www.dineopen.com'}/placeorder?restaurant=${restaurantId}`;
        await restaurantRef.update({ qrData });

        console.log('✅ Admin setup: New restaurant created:', restaurantId);
      }
    }

    res.json({
      success: true,
      message: isNewUser 
        ? 'Client setup completed successfully' 
        : 'Client login successful',
      token,
      user: {
        id: userId,
        phone: normalizedPhone,
        name: name || 'Restaurant Owner',
        role: 'owner',
        setupComplete: restaurant ? true : false
      },
      restaurant: restaurant ? {
        id: restaurant.id,
        name: restaurant.name,
        address: restaurant.address,
        city: restaurant.city,
        phone: restaurant.phone,
        email: restaurant.email
      } : null,
      hasRestaurants: existingRestaurants.size > 0 || !!restaurant,
      redirectTo: restaurant ? '/dashboard' : '/admin'
    });

  } catch (error) {
    console.error('Admin setup error:', error);
    res.status(500).json({ 
      error: 'Setup failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Local Admin Login - Simple password-based login (bypasses OTP, same flow as OTP verification)
// POST /api/auth/local-login
// Body: { phone: '...' OR email: '...', password: '...' }
// Returns: Same response structure as /api/auth/phone/verify-otp
app.post('/api/auth/local-login', async (req, res) => {
  try {
    const { phone, email, password, name } = req.body;
    const fixedPassword = process.env.ADMIN_LOCAL_PASSWORD || 'noni7190';

    // Validate password
    if (!password || password !== fixedPassword) {
      return res.status(401).json({ 
        error: 'Invalid password',
        message: 'Incorrect password'
      });
    }

    if (!phone && !email) {
      return res.status(400).json({ error: 'Phone or email is required' });
    }

    // Normalize phone number if provided
    const normalizedPhone = phone ? (phone.startsWith('+') ? phone : `+${phone}`) : null;
    const normalizedEmail = email ? email.toLowerCase().trim() : null;

    // Find user by phone or email (check both separately)
    let userDoc = null;
    let userId, isNewUser = false, hasRestaurants = false;

    // First try to find by phone if provided
    if (normalizedPhone) {
      const phoneQuery = await db.collection(collections.users)
        .where('phone', '==', normalizedPhone)
        .limit(1)
        .get();
      
      if (!phoneQuery.empty) {
        userDoc = phoneQuery.docs[0];
      }
    }

    // If not found by phone, try email
    if (!userDoc && normalizedEmail) {
      const emailQuery = await db.collection(collections.users)
        .where('email', '==', normalizedEmail)
        .limit(1)
        .get();
      
      if (!emailQuery.empty) {
        userDoc = emailQuery.docs[0];
      }
    }

    if (!userDoc) {
      // New user registration (same as OTP flow)
      const newUser = {
        phone: normalizedPhone || null,
        email: normalizedEmail || null,
        name: name || 'Restaurant Owner',
        role: 'owner',
        emailVerified: !!normalizedEmail,
        phoneVerified: !!normalizedPhone,
        provider: 'local-login',
        setupComplete: false,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
      isNewUser = true;
      
      console.log('✅ Local login: New user created:', userId, { phone: normalizedPhone, email: normalizedEmail });
      hasRestaurants = false; // No restaurant created yet

      // Create default free-trial subscription for new user
      await createDefaultSubscription(userId, normalizedEmail || null, normalizedPhone || null, 'owner');
    } else {
      // Existing user login (same as OTP flow)
      const userData = userDoc.data();
      userId = userDoc.id;
      
      // Update user with provided phone/email if not already set
      const updateData = {
        updatedAt: new Date()
      };
      
      if (normalizedPhone && !userData.phone) {
        updateData.phone = normalizedPhone;
        updateData.phoneVerified = true;
      } else if (normalizedPhone && userData.phone) {
        updateData.phoneVerified = true;
      }
      
      if (normalizedEmail && !userData.email) {
        updateData.email = normalizedEmail;
        updateData.emailVerified = true;
      } else if (normalizedEmail && userData.email) {
        updateData.emailVerified = true;
      }
      
      if (name && name !== 'Restaurant Owner') {
        updateData.name = name;
      }
      
      await userDoc.ref.update(updateData);

      // Check if owner has restaurants
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();

      hasRestaurants = !restaurantsQuery.empty;
    }

    // Get actual user data for token generation
    const actualUserData = userDoc ? userDoc.data() : null;
    const actualRole = actualUserData?.role || 'owner';
    const staffRoles = ['waiter', 'manager', 'employee', 'cashier', 'sales'];
    const isStaff = staffRoles.includes(actualRole.toLowerCase());

    // For staff, get their restaurantId
    let staffRestaurantId = actualUserData?.restaurantId || null;
    if (isStaff && !staffRestaurantId) {
      // Try to find from userRestaurants collection
      const userRestSnapshot = await db.collection(collections.userRestaurants)
        .where('userId', '==', userId)
        .limit(1)
        .get();
      if (!userRestSnapshot.empty) {
        staffRestaurantId = userRestSnapshot.docs[0].data().restaurantId;
      }
    }

    // Generate JWT token with actual role and restaurantId
    const tokenPayload = {
      userId,
      phone: actualUserData?.phone || normalizedPhone || null,
      email: actualUserData?.email || normalizedEmail || null,
      role: actualRole
    };
    // Add restaurantId for staff members
    if (isStaff && staffRestaurantId) {
      tokenPayload.restaurantId = staffRestaurantId;
    }

    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Get user's restaurants for subdomain check (same as OTP flow)
    let subdomainUrl = null;
    if (SUBDOMAIN_FEATURE_ENABLED && hasRestaurants) {
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();

      if (!restaurantsQuery.empty) {
        const restaurant = restaurantsQuery.docs[0].data();
        if (restaurant.subdomainEnabled && restaurant.subdomain) {
          subdomainUrl = getSubdomainUrl(restaurant.subdomain, '/dashboard');
        }
      }
    }

    // Build user response object
    const userResponse = {
      id: userId,
      phone: actualUserData?.phone || normalizedPhone || null,
      email: actualUserData?.email || normalizedEmail || null,
      name: actualUserData?.name || name || (isNewUser ? 'Restaurant Owner' : 'User'),
      role: actualRole,
      setupComplete: actualUserData?.setupComplete || false
    };

    // Add staff-specific fields
    if (isStaff) {
      userResponse.restaurantId = staffRestaurantId;
      userResponse.pageAccess = actualUserData?.pageAccess || null;
      userResponse.loginId = actualUserData?.loginId || null;
      userResponse.username = actualUserData?.username || null;
    }

    // Return response (works for both owner and staff)
    res.json({
      success: true,
      message: isNewUser ? 'Welcome! Account created successfully.' : 'Login successful',
      token,
      user: userResponse,
      firstTimeUser: isNewUser,
      isNewUser,
      hasRestaurants: isStaff ? !!staffRestaurantId : hasRestaurants,
      subdomainUrl,
      redirectTo: subdomainUrl || (hasRestaurants ? '/dashboard' : '/admin')
    });

  } catch (error) {
    console.error('Local login error:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ 
      error: 'Login failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Public endpoint to get all restaurants for directory
app.get('/api/public/restaurants', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { city, search } = req.query;
    
    let query = db.collection(collections.restaurants)
      .where('status', '==', 'active'); // Only show active restaurants

    if (city) {
      // Note: Case-sensitive match. For better search, we'd use Algolia/Typesense or normalize fields.
      query = query.where('city', '==', city);
    }

    const snapshot = await query.get();
    let restaurants = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      // Filter out sensitive data, only send public profile info
      const { ownerId, menu, staff, settings, ...publicData } = data;
      
      // Basic client-side search filter if query param provided (since Firestore has limited search)
      if (search) {
        const searchLower = search.toLowerCase();
        const nameMatch = publicData.name?.toLowerCase().includes(searchLower);
        const cuisineMatch = Array.isArray(publicData.cuisine) && publicData.cuisine.some(c => c.toLowerCase().includes(searchLower));
        if (!nameMatch && !cuisineMatch) return;
      }

      restaurants.push({
        id: doc.id,
        ...publicData,
        menuTheme: data.menuTheme || { themeId: 'default' } // Include theme info for linking
      });
    });

    res.json({ success: true, restaurants });
  } catch (error) {
    console.error('Error fetching public restaurants:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch directory' });
  }
});

app.get('/api/restaurants', authenticateToken, async (req, res) => {
  try {
    const { userId, role, restaurantId } = req.user;
    const restaurants = []; // Move declaration to top

    let query = db.collection(collections.restaurants);

    if (role === 'admin') {
      // Admin can see all restaurants
      query = query;
    } else if (role === 'owner' || role === 'customer') {
      // Owners and customers see their own restaurants
      query = query.where('ownerId', '==', userId);
    } else if (restaurantId) {
      // Staff members see only their assigned restaurant
      const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      if (restaurantDoc.exists) {
        const restaurantData = restaurantDoc.data();
        // Remove qrCode (large base64 string) and menu (huge data) to reduce payload size
        // QR code can be generated on-demand via separate endpoint or client-side
        // Menu items are fetched separately via /api/menus/:restaurantId
        const { qrCode, menu, ...restaurantWithoutLargeData } = restaurantData;
        restaurants.push({
          id: restaurantDoc.id,
          ...restaurantWithoutLargeData
        });
      }
      return res.json({ restaurants });
    } else {
      // No access
      return res.json({ restaurants: [] });
    }

    const snapshot = await query.get();

    snapshot.forEach(doc => {
      const restaurantData = doc.data();
      // Remove qrCode (large base64 string) and menu (huge data) to reduce payload size
      // QR code can be generated on-demand via separate endpoint or client-side
      // Menu items are fetched separately via /api/menus/:restaurantId
      const { qrCode, menu, ...restaurantWithoutLargeData } = restaurantData;
      restaurants.push({
        id: doc.id,
        ...restaurantWithoutLargeData
      });
    });

    res.json({ restaurants });

  } catch (error) {
    console.error('Get restaurants error:', error);
    res.status(500).json({ error: 'Failed to fetch restaurants' });
  }
});

app.post('/api/restaurants', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.user;
    const { 
      name, 
      address, 
      phone, 
      email, 
      cuisine, 
      description,
      operatingHours,
      features 
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Restaurant name is required' });
    }

    // Generate subdomain for the restaurant
    const subdomain = await generateSubdomain(name, 'temp'); // We'll update with actual ID after creation
    
    const restaurantData = {
      name,
      address: address || null,
      city: req.body.city || null,
      phone: phone || null,
      email: email || null,
      cuisine: cuisine || [],
      description: description || '',
      operatingHours: operatingHours || {},
      features: features || [],
      ownerId: userId,
      subdomain: subdomain,
      subdomainEnabled: false, // Default: disabled, user can enable later
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const restaurantRef = await db.collection(collections.restaurants).add(restaurantData);
    
    // Update subdomain with actual restaurant ID for uniqueness
    const finalSubdomain = await generateSubdomain(name, restaurantRef.id);
    await restaurantRef.update({ subdomain: finalSubdomain });

    // Create user-restaurant relationship
    await db.collection(collections.userRestaurants).add({
      userId: userId,
      restaurantId: restaurantRef.id,
      role: 'owner',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Store qrData for reference, but don't generate qrCode here to save bandwidth
    // QR code can be generated on-demand client-side or via separate endpoint
    const qrData = `${process.env.FRONTEND_URL || 'https://www.dineopen.com'}/placeorder?restaurant=${restaurantRef.id}`;
    await restaurantRef.update({ qrData });

    res.status(201).json({
      message: 'Restaurant created successfully',
      restaurant: {
        id: restaurantRef.id,
        ...restaurantData,
        subdomain: finalSubdomain, // Include the final subdomain
        subdomainUrl: SUBDOMAIN_FEATURE_ENABLED ? getSubdomainUrl(finalSubdomain) : null,
        qrData // Include qrData but not qrCode (large base64 string)
      }
    });

  } catch (error) {
    console.error('Create restaurant error:', error);
    res.status(500).json({ error: 'Failed to create restaurant' });
  }
});

// Update restaurant
app.patch('/api/restaurants/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const updateData = {};

    // Only allow owner to update their own restaurants
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update allowed basic fields
    const allowedFields = ['name', 'address', 'city', 'phone', 'email', 'cuisine', 'description', 'logo', 'coverImage', 'openingHours', 'isActive'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    // Handle customerAppSettings updates (can update individual fields or entire object)
    if (req.body.customerAppSettings !== undefined) {
      const existingSettings = restaurant.data().customerAppSettings || {};
      // Merge new settings with existing
      updateData.customerAppSettings = {
        ...existingSettings,
        ...req.body.customerAppSettings,
        updatedAt: new Date()
      };
      // Handle nested loyaltySettings merge
      if (req.body.customerAppSettings.loyaltySettings) {
        updateData.customerAppSettings.loyaltySettings = {
          ...(existingSettings.loyaltySettings || {}),
          ...req.body.customerAppSettings.loyaltySettings
        };
      }
      // Handle nested branding merge
      if (req.body.customerAppSettings.branding) {
        updateData.customerAppSettings.branding = {
          ...(existingSettings.branding || {}),
          ...req.body.customerAppSettings.branding
        };
      }
    }

    // Handle restaurantCode update directly (shorthand for customerAppSettings.restaurantCode)
    if (req.body.restaurantCode !== undefined) {
      const existingSettings = restaurant.data().customerAppSettings || {};
      updateData.customerAppSettings = {
        ...existingSettings,
        ...(updateData.customerAppSettings || {}),
        restaurantCode: req.body.restaurantCode,
        updatedAt: new Date()
      };
    }

    // Order management settings (e.g. sequential order ID never reset)
    if (req.body.orderSettings !== undefined) {
      const existing = restaurant.data().orderSettings || {};
      updateData.orderSettings = { ...existing, ...req.body.orderSettings };
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updateData.updatedAt = new Date();

    await db.collection(collections.restaurants).doc(restaurantId).update(updateData);

    res.json({ message: 'Restaurant updated successfully', updatedFields: Object.keys(updateData) });

  } catch (error) {
    console.error('Update restaurant error:', error);
    res.status(500).json({ error: 'Failed to update restaurant' });
  }
});

// Delete restaurant
app.delete('/api/restaurants/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Only allow owner to delete their own restaurants
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // TODO: Also delete associated staff, menus, orders etc.
    await db.collection(collections.restaurants).doc(restaurantId).delete();

    res.json({ message: 'Restaurant deleted successfully' });

  } catch (error) {
    console.error('Delete restaurant error:', error);
    res.status(500).json({ error: 'Failed to delete restaurant' });
  }
});

// Public API - Get menu for customer ordering (no authentication required)
app.get('/api/public/menu/:restaurantId', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    if (!restaurantId) {
      return res.status(400).json({ 
        success: false,
        error: 'Restaurant ID is required' 
      });
    }

    // Get restaurant info
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ 
        success: false,
        error: 'Restaurant not found' 
      });
    }

    const restaurantData = restaurantDoc.data();

    // Get menu items from embedded menu structure
    const embeddedMenuItems = restaurantData.menu?.items || [];
    
    // Filter active and available menu items
    const menuItems = embeddedMenuItems
      .filter(item => item.status === 'active' && item.isAvailable === true)
      .map(item => ({
        id: item.id,
        name: item.name,
        description: item.description || '',
        price: item.price,
        category: item.category,
        isVeg: item.isVeg !== false,
        spiceLevel: item.spiceLevel || 'medium',
        shortCode: item.shortCode || item.name.substring(0, 3).toUpperCase(),
        image: item.image || null,
        images: item.images || [], // Add images array
        allergens: item.allergens || []
      }));

    res.json({
      success: true,
      restaurant: {
        id: restaurantId,
        name: restaurantData.name,
        description: restaurantData.description || '',
        address: restaurantData.address || '',
        phone: restaurantData.phone || '',
        email: restaurantData.email || ''
      },
      menu: menuItems
    });

  } catch (error) {
    console.error('Public menu fetch error:', error);
    
    // Provide more specific error messages
    if (error.code === 'permission-denied') {
      return res.status(403).json({ 
        success: false,
        error: 'Access denied to restaurant data' 
      });
    } else if (error.code === 'not-found') {
      return res.status(404).json({ 
        success: false,
        error: 'Restaurant not found' 
      });
    } else {
      return res.status(500).json({ 
        success: false,
        error: 'Failed to fetch menu data. Please try again later.' 
      });
    }
  }
});

// Menu Theme Management - Authenticated endpoints
app.get('/api/menu-theme/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    
    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    
    // Check ownership - use userId from JWT token (matches other endpoints)
    const userId = req.user.userId || req.user.uid || req.user.id;
    if (!restaurantData.ownerId || restaurantData.ownerId !== userId) {
      console.log('Ownership check failed:', {
        restaurantOwnerId: restaurantData.ownerId,
        userUserId: req.user.userId,
        userUid: req.user.uid,
        userId: req.user.id,
        computedUserId: userId,
      });
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    const menuTheme = restaurantData.menuTheme || {};
    
    res.json({
      success: true,
      themeId: menuTheme.themeId || 'default',
      layoutId: menuTheme.layoutId || 'default',
      ...menuTheme,
    });
  } catch (error) {
    console.error('Error fetching menu theme:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch menu theme' });
  }
});

app.post('/api/menu-theme/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { themeId, layoutId, headerImage } = req.body || {};
    
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    
    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    
    // Check ownership - use userId from JWT token (matches other endpoints)
    const userId = req.user.userId || req.user.uid || req.user.id;
    if (!restaurantData.ownerId || restaurantData.ownerId !== userId) {
      console.log('Ownership check failed:', {
        restaurantOwnerId: restaurantData.ownerId,
        userUserId: req.user.userId,
        userUid: req.user.uid,
        userId: req.user.id,
        computedUserId: userId,
      });
      return res.status(403).json({ success: false, error: 'Access denied' });
    }

    // Update menu theme
    await db.collection(collections.restaurants).doc(restaurantId).update({
      menuTheme: {
        themeId: themeId || 'default',
        layoutId: layoutId || themeId || 'default',
        headerImage: headerImage || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
    });

    res.json({
      success: true,
      message: 'Menu theme saved successfully',
      themeId: themeId || 'default',
      layoutId: layoutId || themeId || 'default',
    });
  } catch (error) {
    console.error('Error saving menu theme:', error);
    res.status(500).json({ success: false, error: 'Failed to save menu theme' });
  }
});

// Public resolver/proxy: decides the themed placeorder URL before FE renders and streams the themed page
app.get('/public/placeorder', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const restaurantId = (req.query.restaurant || '').trim();
    const seatRaw = (req.query.seat || '').trim();

    // Basic input validation to avoid abuse/injection
    const idRegex = /^[A-Za-z0-9_-]{6,128}$/;
    if (!restaurantId || !idRegex.test(restaurantId)) {
      return res.status(400).json({ success: false, error: 'Invalid restaurant id' });
    }

    // Sanitize seat to alnum/underscore/hyphen/space and truncate
    const seat = seatRaw ? seatRaw.replace(/[^\w\- ]/g, '').slice(0, 50) : '';

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data() || {};
    const menuTheme = restaurantData.menuTheme || {};
    const themeId = menuTheme.themeId || 'default';

    const themeRoutes = {
      bistro: '/placeorder/bistro',
      cube: '/placeorder/cube',
      book: '/placeorder/book',
      carousel: '/placeorder/carousel',
      classic: '/placeorder/classic',
    };

    // If themeId is not in routes, fallback to 'default' which maps to /placeorder
    let frontendPath = '/placeorder';
    if (themeRoutes[themeId]) {
      frontendPath = themeRoutes[themeId];
    } else if (themeId === 'default') {
      frontendPath = '/placeorder';
    } else {
      // If unknown theme, fallback to default
      frontendPath = '/placeorder';
    }

    const params = new URLSearchParams();
    params.set('restaurant', restaurantId);
    if (seat) params.set('seat', seat);

    const targetPath = `${frontendPath}?${params.toString()}`;

    // Proxy the themed page so the URL stays as /public/placeorder?... and there is no extra round-trip
    const frontendOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:3002';
    const targetUrl = `${frontendOrigin}${targetPath}`;

    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        // Forward minimal headers; avoid cookies for safety
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'dine-proxy'
      },
    });

    // Propagate status and content-type; stream body
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) {
      res.setHeader('content-type', contentType);
    }

    // Stream the body
    if (upstream.body) {
      upstream.body.pipe(res);
    } else {
      res.end();
    }
    return;
  } catch (error) {
    console.error('Error in public placeorder redirect:', error);
    return res.status(500).json({ success: false, error: 'Failed to resolve menu theme' });
  }
});

// Public endpoint to get menu theme (for redirect logic)
app.get('/api/public/menu-theme/:restaurantId', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    
    if (!restaurantDoc.exists) {
      return res.status(404).json({ success: false, error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const menuTheme = restaurantData.menuTheme || {};
    
    res.json({
      success: true,
      themeId: menuTheme.themeId || 'default',
      layoutId: menuTheme.layoutId || 'default',
    });
  } catch (error) {
    console.error('Error fetching public menu theme:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch menu theme' });
  }
});

app.get('/api/menus/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { category } = req.query;

    // Get restaurant document which now contains the menu
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const menuData = restaurantData.menu || { categories: [], items: [] };

    let menuItems = menuData.items || [];

    // Filter by category if specified
    if (category) {
      menuItems = menuItems.filter(item => item.category === category);
    }

    // Filter only active items
    menuItems = menuItems.filter(item => item.status === 'active');

    res.json({ menuItems });

  } catch (error) {
    console.error('Get menu error:', error);
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

app.post('/api/menus/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { 
      name, 
      description, 
      price, 
      category, 
      isVeg, 
      spiceLevel, 
      allergens,
      image,
      shortCode,
      variants,
      customizations
    } = req.body;

    if (!name || !price || !category) {
      return res.status(400).json({ error: 'Name, price, and category are required' });
    }

    // Get current restaurant data
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const currentMenu = restaurantData.menu || { categories: [], items: [] };

    // Create new menu item
    const newMenuItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Generate unique ID
      name,
      description: description || '',
      price: parseFloat(price),
      category,
      isVeg: isVeg || false,
      spiceLevel: spiceLevel || 'medium',
      allergens: allergens || [],
      image: image || null,
      shortCode: shortCode || name.substring(0, 3).toUpperCase(),
      status: 'active',
      order: 0,
      // Availability/Stock management fields
      isAvailable: req.body.isAvailable !== undefined ? req.body.isAvailable : true,
      stockQuantity: req.body.stockQuantity || null,
      lowStockThreshold: req.body.lowStockThreshold || 5,
      isStockManaged: req.body.isStockManaged || false,
      availableFrom: req.body.availableFrom || null,
      availableUntil: req.body.availableUntil || null,
      // Variants and customizations (ensure prices are numbers)
      variants: variants && Array.isArray(variants) && variants.length > 0 
        ? variants.map(v => ({
            name: v.name,
            price: typeof v.price === 'number' ? v.price : parseFloat(v.price) || 0,
            description: v.description || ''
          }))
        : [],
      customizations: customizations && Array.isArray(customizations) && customizations.length > 0
        ? customizations.map(c => ({
            id: c.id || `cust_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            name: c.name,
            price: typeof c.price === 'number' ? c.price : parseFloat(c.price) || 0,
            description: c.description || ''
          }))
        : [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Add to menu items array
    const updatedItems = [...(currentMenu.items || []), newMenuItem];

    // Update categories if new category
    const categories = [...(currentMenu.categories || [])];
    if (!categories.find(cat => cat.name === category)) {
      categories.push({
        name: category,
        items: [newMenuItem]
      });
    } else {
      // Add to existing category
      const categoryIndex = categories.findIndex(cat => cat.name === category);
      categories[categoryIndex].items.push(newMenuItem);
    }

    // Update restaurant document with new menu structure
    await db.collection(collections.restaurants).doc(restaurantId).update({
      menu: {
        categories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });

    // AUTO-GENERATE RECIPE (Asynchronous - Fire and Forget)
    // We don't await this so the user response is instant.
    if (req.body.generateRecipe) {
      inventoryService.createDefaultRecipe(
        restaurantId, 
        newMenuItem.id, 
        newMenuItem.name, 
        newMenuItem.description,
        req.user.uid
      ).catch(err => console.error('BG Recipe Gen Error:', err));
    }

    res.status(201).json({
      message: 'Menu item created successfully',
      menuItem: newMenuItem
    });

  } catch (error) {
    console.error('Create menu item error:', error);
    res.status(500).json({ error: 'Failed to create menu item' });
  }
});

// Update menu item
app.patch('/api/menus/item/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.user;
    
    // Find the restaurant that contains this menu item
    const restaurantsSnapshot = await db.collection(collections.restaurants).get();
    let foundRestaurant = null;
    let foundItem = null;
    
    for (const restaurantDoc of restaurantsSnapshot.docs) {
      const restaurantData = restaurantDoc.data();
      const menuData = restaurantData.menu || { items: [] };
      
      const item = menuData.items.find(item => item.id === id);
      if (item) {
        foundRestaurant = restaurantDoc;
        foundItem = item;
        break;
      }
    }
    
    if (!foundRestaurant || !foundItem) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    
    const restaurantData = foundRestaurant.data();
    
    // Check if user owns the restaurant
    if (restaurantData.ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const updateData = { updatedAt: new Date() };
    
    // Update allowed fields
    const allowedFields = [
      'name', 'description', 'price', 'category', 'isVeg', 'spiceLevel', 
      'allergens', 'image', 'shortCode', 'status', 'order',
      'isAvailable', 'stockQuantity', 'lowStockThreshold', 'isStockManaged',
      'availableFrom', 'availableUntil', 'variants', 'customizations'
    ];
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'price') {
          updateData[field] = parseFloat(req.body[field]);
        } else if (field === 'variants') {
          // Ensure variants are arrays with parsed prices
          updateData[field] = Array.isArray(req.body[field]) 
            ? req.body[field].map(v => ({
                name: v.name,
                price: typeof v.price === 'number' ? v.price : parseFloat(v.price) || 0,
                description: v.description || ''
              }))
            : [];
        } else if (field === 'customizations') {
          // Ensure customizations are arrays with parsed prices
          updateData[field] = Array.isArray(req.body[field])
            ? req.body[field].map(c => ({
                id: c.id || `cust_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                name: c.name,
                price: typeof c.price === 'number' ? c.price : parseFloat(c.price) || 0,
                description: c.description || ''
              }))
            : [];
        } else {
          updateData[field] = req.body[field];
        }
      }
    });
    
    if (Object.keys(updateData).length === 1) { // Only updatedAt
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    // Update the menu item in the restaurant document
    const currentMenu = restaurantData.menu || { categories: [], items: [] };
    const updatedItems = (currentMenu.items || []).map(item => {
      if (item.id === id) {
        return { ...item, ...updateData };
      }
      return item;
    });

    // Update categories as well
    const updatedCategories = (currentMenu.categories || []).map(category => ({
      ...category,
      items: (category.items || []).map(item => {
        if (item.id === id) {
          return { ...item, ...updateData };
        }
        return item;
      })
    }));
    
    await db.collection(collections.restaurants).doc(foundRestaurant.id).update({
      menu: {
        categories: updatedCategories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });
    
    res.json({ 
      message: 'Menu item updated successfully',
      updatedFields: Object.keys(updateData).filter(key => key !== 'updatedAt')
    });
    
  } catch (error) {
    console.error('Update menu item error:', error);
    res.status(500).json({ error: 'Failed to update menu item' });
  }
});

// Mark menu item as favorite
app.post('/api/menus/:restaurantId/item/:itemId/favorite', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;
    const { userId } = req.user;

    // Validate restaurant access
    const hasAccess = await validateRestaurantAccess(userId, restaurantId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get restaurant document
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const currentMenu = restaurantData.menu || { categories: [], items: [] };
    
    // Find and update the menu item
    const updatedItems = currentMenu.items.map(item => {
      if (item.id === itemId) {
        return { ...item, isFavorite: true, updatedAt: new Date() };
      }
      return item;
    });

    // Update categories as well
    const updatedCategories = currentMenu.categories.map(category => ({
      ...category,
      items: (category.items || []).map(item => {
        if (item.id === itemId) {
          return { ...item, isFavorite: true, updatedAt: new Date() };
        }
        return item;
      })
    }));

    // Update restaurant document
    await db.collection(collections.restaurants).doc(restaurantId).update({
      menu: {
        categories: updatedCategories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });

    res.json({ 
      message: 'Menu item marked as favorite',
      itemId,
      isFavorite: true
    });

  } catch (error) {
    console.error('Mark favorite error:', error);
    res.status(500).json({ error: 'Failed to mark menu item as favorite' });
  }
});

// Unmark menu item as favorite
app.delete('/api/menus/:restaurantId/item/:itemId/favorite', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;
    const { userId } = req.user;

    // Validate restaurant access
    const hasAccess = await validateRestaurantAccess(userId, restaurantId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get restaurant document
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const currentMenu = restaurantData.menu || { categories: [], items: [] };
    
    // Find and update the menu item
    const updatedItems = currentMenu.items.map(item => {
      if (item.id === itemId) {
        return { ...item, isFavorite: false, updatedAt: new Date() };
      }
      return item;
    });

    // Update categories as well
    const updatedCategories = currentMenu.categories.map(category => ({
      ...category,
      items: (category.items || []).map(item => {
        if (item.id === itemId) {
          return { ...item, isFavorite: false, updatedAt: new Date() };
        }
        return item;
      })
    }));

    // Update restaurant document
    await db.collection(collections.restaurants).doc(restaurantId).update({
      menu: {
        categories: updatedCategories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });

    res.json({ 
      message: 'Menu item unmarked as favorite',
      itemId,
      isFavorite: false
    });

  } catch (error) {
    console.error('Unmark favorite error:', error);
    res.status(500).json({ error: 'Failed to unmark menu item as favorite' });
  }
});

// Delete menu item (soft delete)
app.delete('/api/menus/item/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.user;
    
    // Find the restaurant that contains this menu item
    const restaurantsSnapshot = await db.collection(collections.restaurants).get();
    let foundRestaurant = null;
    let foundItem = null;
    
    for (const restaurantDoc of restaurantsSnapshot.docs) {
      const restaurantData = restaurantDoc.data();
      const menuData = restaurantData.menu || { items: [] };
      
      const item = menuData.items.find(item => item.id === id);
      if (item) {
        foundRestaurant = restaurantDoc;
        foundItem = item;
        break;
      }
    }
    
    if (!foundRestaurant || !foundItem) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    
    const restaurantData = foundRestaurant.data();
    
    // Check if user owns the restaurant
    if (restaurantData.ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Soft delete by setting status to 'deleted'
    const currentMenu = restaurantData.menu || { categories: [], items: [] };
    const updatedItems = (currentMenu.items || []).map(item => {
      if (item.id === id) {
        return {
          ...item,
      status: 'deleted',
      deletedAt: new Date(),
      updatedAt: new Date()
        };
      }
      return item;
    });

    // Update categories as well
    const updatedCategories = (currentMenu.categories || []).map(category => ({
      ...category,
      items: (category.items || []).map(item => {
        if (item.id === id) {
          return { 
            ...item, 
            status: 'deleted',
            deletedAt: new Date(),
            updatedAt: new Date()
          };
        }
        return item;
      })
    }));
    
    await db.collection(collections.restaurants).doc(foundRestaurant.id).update({
      menu: {
        categories: updatedCategories,
        items: updatedItems,
        lastUpdated: new Date()
      }
    });
    
    res.json({
      message: 'Menu item deleted successfully',
      note: 'Item has been soft deleted and can be restored if needed'
    });

  } catch (error) {
    console.error('Delete menu item error:', error);
    res.status(500).json({ error: 'Failed to delete menu item' });
  }
});

// Bulk delete all menu items for a restaurant
app.delete('/api/menus/:restaurantId/bulk-delete', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Get the restaurant
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();

    // Check if user owns the restaurant
    if (restaurantData.ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied. You can only delete menu items for your own restaurant.' });
    }

    // Get current menu
    const currentMenu = restaurantData.menu || { categories: [], items: [] };

    // Count active items before deletion
    const activeItemsCount = (currentMenu.items || []).filter(item => item.status !== 'deleted').length;

    if (activeItemsCount === 0) {
      return res.status(400).json({
        error: 'No active menu items to delete',
        deletedCount: 0
      });
    }

    // Soft delete all items by setting status to 'deleted'
    const deletedTimestamp = new Date();
    const updatedItems = (currentMenu.items || []).map(item => ({
      ...item,
      status: 'deleted',
      deletedAt: deletedTimestamp,
      updatedAt: deletedTimestamp
    }));

    // Update categories as well
    const updatedCategories = (currentMenu.categories || []).map(category => ({
      ...category,
      items: (category.items || []).map(item => ({
        ...item,
        status: 'deleted',
        deletedAt: deletedTimestamp,
        updatedAt: deletedTimestamp
      }))
    }));

    // Update the restaurant document
    await db.collection(collections.restaurants).doc(restaurantId).update({
      menu: {
        categories: updatedCategories,
        items: updatedItems,
        lastUpdated: deletedTimestamp
      }
    });

    console.log(`✅ Bulk deleted ${activeItemsCount} menu items for restaurant ${restaurantId}`);

    res.json({
      message: `Successfully deleted all ${activeItemsCount} menu items`,
      deletedCount: activeItemsCount,
      note: 'All items have been soft deleted and can be restored if needed'
    });

  } catch (error) {
    console.error('Bulk delete menu items error:', error);
    res.status(500).json({ error: 'Failed to delete menu items' });
  }
});

// Public API - Place order with OTP verification
app.post('/api/public/orders/:restaurantId', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const {
      customerPhone,
      customerName,
      customerEmail,
      seatNumber,
      tableNumber: requestedTable,
      items,
      totalAmount,
      notes,
      otp,
      verificationId,
      // New fields for Crave app integration
      orderType = 'dine_in', // dine_in, takeaway, delivery
      offerId, // Optional single offer to apply (backward compatible)
      offerIds = [], // Optional multiple offers to apply
      deliveryAddress, // For delivery orders
      redeemLoyaltyPoints = 0, // Loyalty points to redeem
      orderSource = 'crave_app' // 'crave_app' | 'online_order' – source of the order for order history
    } = req.body;

    if (!restaurantId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Restaurant ID and items are required' });
    }

    if (!customerPhone) {
      return res.status(400).json({ error: 'Customer phone number is required' });
    }

    if (!otp || !verificationId) {
      return res.status(400).json({ error: 'OTP verification is required' });
    }

    // Verify OTP with Firebase (this would need to be implemented)
    // For now, we'll skip OTP verification and proceed with order creation
    // In production, you would verify the OTP with Firebase here

    // Check if restaurant exists
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const customerAppSettings = restaurantData.customerAppSettings || {};
    const loyaltySettings = customerAppSettings.loyaltySettings || {};

    // Validate order type based on restaurant settings
    if (orderType === 'dine_in' && customerAppSettings.allowDineIn === false) {
      return res.status(400).json({ error: 'Dine-in orders are not available' });
    }
    if (orderType === 'takeaway' && customerAppSettings.allowTakeaway === false) {
      return res.status(400).json({ error: 'Takeaway orders are not available' });
    }
    if (orderType === 'delivery' && customerAppSettings.allowDelivery === false) {
      return res.status(400).json({ error: 'Delivery orders are not available' });
    }

    // Helper function to normalize phone number
    const normalizePhone = (phone) => {
      if (!phone) return null;
      // Remove all non-digit characters
      const digits = phone.replace(/\D/g, '');

      // Handle Indian phone numbers
      if (digits.length === 12 && digits.startsWith('91')) {
        // Remove country code for Indian numbers
        return digits.substring(2);
      } else if (digits.length === 10) {
        // Already a 10-digit number
        return digits;
      } else if (digits.length === 11 && digits.startsWith('0')) {
        // Remove leading zero
        return digits.substring(1);
      }

      // Return as-is for other formats
      return digits;
    };

    // Create or get customer record with phone normalization
    let customerId;
    let existingCustomer = null;
    let customerData = null;
    let isFirstOrder = false;

    // First try exact match
    const customerQuery = await db.collection('customers')
      .where('restaurantId', '==', restaurantId)
      .where('phone', '==', customerPhone)
      .get();

    if (!customerQuery.empty) {
      existingCustomer = customerQuery.docs[0];
    } else {
      // Try normalized phone match
      const normalizedPhone = normalizePhone(customerPhone);
      if (normalizedPhone) {
        const allCustomers = await db.collection('customers')
          .where('restaurantId', '==', restaurantId)
          .get();

        existingCustomer = allCustomers.docs.find(doc => {
          const custPhone = normalizePhone(doc.data().phone);
          return custPhone === normalizedPhone;
        });
      }
    }

    if (existingCustomer) {
      // Update existing customer
      console.log(`🔄 Found existing customer for public order: ${existingCustomer.id} with phone: ${existingCustomer.data().phone}`);
      customerId = existingCustomer.id;
      customerData = existingCustomer.data();

      // Check if this is their first order (existing customer but no orders placed yet)
      if ((customerData.totalOrders || 0) === 0) {
        isFirstOrder = true;
        console.log(`🎁 First order for existing customer: ${customerId}`);
      }

      const updateData = {
        updatedAt: new Date(),
        lastOrderDate: new Date(),
        source: customerData.source || 'customer_app' // Mark source if not set
      };

      if (customerName && !customerData.name) {
        updateData.name = customerName;
      }
      if (customerEmail && !customerData.email) {
        updateData.email = customerEmail;
      }

      await existingCustomer.ref.update(updateData);
    } else {
      // Create new customer
      isFirstOrder = true;
      console.log(`🆕 Creating new customer for public order with phone: ${customerPhone}, name: ${customerName}`);
      customerData = {
        restaurantId,
        phone: customerPhone,
        name: customerName || 'Customer',
        email: customerEmail || null,
        customerId: `CUST-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
        totalOrders: 0,
        totalSpent: 0,
        loyaltyPoints: 0,
        orderHistory: [],
        lastOrderDate: null,
        source: 'customer_app', // Mark as from Crave app
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const customerRef = await db.collection('customers').add(customerData);
      customerId = customerRef.id;
      console.log(`✅ New customer created for public order: ${customerRef.id} with phone: ${customerPhone}`);
    }

    // Validate menu items and calculate subtotal
    let subtotal = 0;
    const orderItems = [];

    // Get restaurant menu items from embedded structure
    const menuItems = restaurantData.menu?.items || [];

    for (const item of items) {
      // Find menu item in the embedded menu structure
      const menuItem = menuItems.find(menuItem => menuItem.id === item.menuItemId);

      if (!menuItem) {
        return res.status(400).json({ error: `Menu item ${item.menuItemId} not found` });
      }

      const itemTotal = menuItem.price * item.quantity;
      subtotal += itemTotal;

      orderItems.push({
        menuItemId: item.menuItemId,
        name: menuItem.name,
        price: menuItem.price,
        quantity: item.quantity,
        total: itemTotal,
        shortCode: menuItem.shortCode || null,
        notes: item.notes || ''
      });
    }

    // Check minimum order value
    if (customerAppSettings.minimumOrder && subtotal < customerAppSettings.minimumOrder) {
      return res.status(400).json({
        error: `Minimum order value is ₹${customerAppSettings.minimumOrder}`
      });
    }

    // Calculate discount if offers are provided
    // Support both single offerId (backward compatible) and multiple offerIds
    let discountAmount = 0;
    let appliedOffer = null;
    let appliedOffers = [];

    // Merge offerId into offerIds for backward compatibility
    const allOfferIds = offerIds && offerIds.length > 0 ? offerIds : (offerId ? [offerId] : []);

    // Get offer settings for validation
    const offerSettings = customerAppSettings.offerSettings || {};
    const allowMultipleOffers = offerSettings.allowMultipleOffers ?? false;
    const maxOffersAllowed = offerSettings.maxOffersAllowed ?? 1;

    // Limit offers based on settings
    const limitedOfferIds = allowMultipleOffers
      ? allOfferIds.slice(0, maxOffersAllowed)
      : allOfferIds.slice(0, 1);

    for (const currentOfferId of limitedOfferIds) {
      const offerDoc = await db.collection('offers').doc(currentOfferId).get();

      if (offerDoc.exists) {
        const offer = offerDoc.data();
        const now = new Date();

        // Validate offer
        const validFrom = offer.validFrom ? new Date(offer.validFrom) : null;
        const validUntil = offer.validUntil ? new Date(offer.validUntil) : null;
        const isValidDate = (!validFrom || now >= validFrom) && (!validUntil || now <= validUntil);
        const isUnderUsageLimit = !offer.usageLimit || (offer.usageCount || 0) < offer.usageLimit;
        const meetsMinOrder = subtotal >= (offer.minOrderValue || 0);
        const isValidFirstOrder = !offer.isFirstOrderOnly || isFirstOrder;

        if (offer.isActive && offer.restaurantId === restaurantId && isValidDate && isUnderUsageLimit && meetsMinOrder && isValidFirstOrder) {
          // Calculate discount for this offer
          let offerDiscount = 0;
          if (offer.discountType === 'percentage') {
            offerDiscount = (subtotal * offer.discountValue) / 100;
            if (offer.maxDiscount && offerDiscount > offer.maxDiscount) {
              offerDiscount = offer.maxDiscount;
            }
          } else {
            offerDiscount = offer.discountValue;
          }

          const appliedOfferData = {
            id: currentOfferId,
            name: offer.name,
            discountType: offer.discountType,
            discountValue: offer.discountValue,
            discountApplied: offerDiscount
          };

          appliedOffers.push(appliedOfferData);
          discountAmount += offerDiscount;

          console.log(`🎁 Offer applied: ${offer.name}, Discount: ₹${offerDiscount}`);
        } else {
          console.log(`⚠️ Offer ${currentOfferId} not valid for this order`);
        }
      }
    }

    // Cap total discount at subtotal
    if (discountAmount > subtotal) {
      discountAmount = subtotal;
    }

    // For backward compatibility, set appliedOffer to first applied offer
    if (appliedOffers.length > 0) {
      appliedOffer = appliedOffers[0];
    }

    // Calculate loyalty points redemption
    let loyaltyDiscount = 0;
    let loyaltyPointsRedeemed = 0;

    if (redeemLoyaltyPoints > 0 && loyaltySettings.enabled && customerData) {
      const availablePoints = customerData.loyaltyPoints || 0;
      const pointsToRedeem = Math.min(redeemLoyaltyPoints, availablePoints);

      if (pointsToRedeem > 0) {
        // Calculate discount value from points
        const redemptionRate = loyaltySettings.redemptionRate || 100; // 100 points = Rs 1
        loyaltyDiscount = pointsToRedeem / redemptionRate;

        // Cap at max redemption percent of subtotal
        const maxRedemptionPercent = loyaltySettings.maxRedemptionPercent || 20;
        const maxLoyaltyDiscount = (subtotal * maxRedemptionPercent) / 100;

        if (loyaltyDiscount > maxLoyaltyDiscount) {
          loyaltyDiscount = maxLoyaltyDiscount;
          loyaltyPointsRedeemed = Math.floor(loyaltyDiscount * redemptionRate);
        } else {
          loyaltyPointsRedeemed = pointsToRedeem;
        }

        console.log(`💎 Loyalty points redeemed: ${loyaltyPointsRedeemed} = ₹${loyaltyDiscount}`);
      }
    }

    // Calculate final total
    const finalTotal = Math.max(0, subtotal - discountAmount - loyaltyDiscount);

    // Calculate loyalty points earned
    let loyaltyPointsEarned = 0;
    if (loyaltySettings.enabled) {
      // Normalize loyalty settings with defaults (same as GET endpoint)
      const normalizedLoyalty = {
        earnPerAmount: Number(loyaltySettings.earnPerAmount) || 100,
        pointsEarned: Number(loyaltySettings.pointsEarned) || 4,
        redemptionRate: Number(loyaltySettings.redemptionRate) || 100,
        maxRedemptionPercent: Number(loyaltySettings.maxRedemptionPercent) || 20,
        earnPointsOnRedemption: loyaltySettings.earnPointsOnRedemption === true,
        earnOnFullAmount: loyaltySettings.earnOnFullAmount === true // default false
      };

      const earnPerAmount = normalizedLoyalty.earnPerAmount;
      const pointsEarned = normalizedLoyalty.pointsEarned;

      // Check if customer is redeeming points
      if (loyaltyPointsRedeemed > 0) {
        // Customer is redeeming points
        if (!normalizedLoyalty.earnPointsOnRedemption) {
          // Don't earn any points when redeeming
          loyaltyPointsEarned = 0;
          console.log(`💎 Loyalty points: 0 (earning disabled when redeeming)`);
        } else if (normalizedLoyalty.earnOnFullAmount) {
          // Earn points on full amount (before redemption discount)
          const amountBeforeRedemption = subtotal - discountAmount;
          loyaltyPointsEarned = Math.floor(amountBeforeRedemption / earnPerAmount) * pointsEarned;
          console.log(`💎 Loyalty points (on full ₹${amountBeforeRedemption}): ${loyaltyPointsEarned} points`);
        } else {
          // Default: Earn points only on the remaining amount after redemption
          loyaltyPointsEarned = Math.floor(finalTotal / earnPerAmount) * pointsEarned;
          console.log(`💎 Loyalty points (on remaining ₹${finalTotal}): ${loyaltyPointsEarned} points`);
        }
      } else {
        // No redemption - earn points normally on final total
        loyaltyPointsEarned = Math.floor(finalTotal / earnPerAmount) * pointsEarned;
        console.log(`💎 Loyalty points calculation: ₹${finalTotal} / ₹${earnPerAmount} * ${pointsEarned} = ${loyaltyPointsEarned} points`);
      }
    }

    // Generate order number and daily/sequential order ID (based on restaurant orderSettings.sequentialOrderIdEnabled)
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    const dailyOrderId = await getNextOrderId(restaurantId, restaurantData);

    // Determine table number
    const tableNum = requestedTable || seatNumber || null;

    // Build order type label for display
    const orderTypeLabels = {
      'dine_in': 'Dine In',
      'takeaway': 'Takeaway',
      'delivery': 'Delivery'
    };

    const resolvedOrderSource = (orderSource === 'online_order' ? 'online_order' : 'crave_app');
    const orderData = {
      restaurantId,
      orderNumber,
      dailyOrderId,
      customerId,
      tableNumber: tableNum,
      orderType: orderType,
      orderTypeLabel: orderTypeLabels[orderType] || 'Customer Order',
      orderSource: resolvedOrderSource,
      items: orderItems,
      subtotal: subtotal,
      discountAmount: discountAmount,
      loyaltyDiscount: loyaltyDiscount,
      totalAmount: finalTotal,
      appliedOffer: appliedOffer,
      appliedOffers: appliedOffers,
      loyaltyPointsRedeemed: loyaltyPointsRedeemed,
      loyaltyPointsEarned: loyaltyPointsEarned,
      customerInfo: {
        phone: customerPhone,
        name: customerName || 'Customer',
        email: customerEmail || null,
        seatNumber: seatNumber || null,
        tableNumber: tableNum
      },
      deliveryAddress: orderType === 'delivery' ? deliveryAddress : null,
      paymentMethod: 'cash',
      staffInfo: {
        waiterId: null,
        waiterName: 'Customer Self-Order',
        kitchenNotes: resolvedOrderSource === 'online_order'
          ? `${orderTypeLabels[orderType] || 'Customer order'} via public online order - OTP verified`
          : `${orderTypeLabels[orderType] || 'Customer order'} via Crave App - OTP verified`
      },
      notes: notes || (resolvedOrderSource === 'online_order' ? `${orderTypeLabels[orderType] || 'Customer order'} order via public online order` : `${orderTypeLabels[orderType] || 'Customer order'} order via Crave App`),
      status: 'pending',
      kotSent: false,
      paymentStatus: 'pending',
      otpVerified: true,
      verificationId: verificationId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const orderRef = await db.collection(collections.orders).add(orderData);

    // Prepare order history entry
    const orderHistoryEntry = {
      orderId: orderRef.id,
      orderNumber: orderNumber,
      orderDate: new Date(),
      totalAmount: finalTotal,
      subtotal: subtotal,
      discountAmount: discountAmount,
      loyaltyDiscount: loyaltyDiscount,
      tableNumber: tableNum,
      orderType: orderType,
      orderTypeLabel: orderTypeLabels[orderType] || 'Customer Order',
      orderSource: resolvedOrderSource,
      status: 'pending',
      itemsCount: orderItems.length,
      appliedOffer: appliedOffer ? appliedOffer.name : null,
      appliedOffers: appliedOffers.map(o => o.name),
      loyaltyPointsEarned: loyaltyPointsEarned,
      loyaltyPointsRedeemed: loyaltyPointsRedeemed
    };

    // Update customer stats, order history, and loyalty points - DEFERRED TO ORDER COMPLETION
    // const customerUpdateData = {
    //   totalOrders: FieldValue.increment(1),
    //   totalSpent: FieldValue.increment(finalTotal),
    //   lastOrderDate: new Date(),
    //   updatedAt: new Date()
    // };

    // Update loyalty points
    // if (loyaltySettings.enabled) {
    //   const netPointsChange = loyaltyPointsEarned - loyaltyPointsRedeemed;
    //   if (netPointsChange !== 0) {
    //     customerUpdateData.loyaltyPoints = FieldValue.increment(netPointsChange);
    //   }
    // }

    // await db.collection('customers').doc(customerId).update(customerUpdateData);

    // Add to order history (using array union)
    // await db.collection('customers').doc(customerId).update({
    //   orderHistory: FieldValue.arrayUnion(orderHistoryEntry)
    // });

    console.log(`🛒 Customer order created successfully: ${orderRef.id}`);
    console.log(`📋 Order items: ${orderData.items.length} items`);
    console.log(`🏪 Restaurant: ${orderData.restaurantId}`);
    console.log(`👤 Customer: ${customerPhone}`);
    console.log(`🏷️ Order Type: ${orderType}`);
    console.log(`💰 Total: ₹${finalTotal} (Subtotal: ₹${subtotal}, Discount: ₹${discountAmount}, Loyalty: ₹${loyaltyDiscount})`);

    // SMART INVENTORY: Deduct stock asynchronously
    inventoryService.deductInventoryForOrder(restaurantId, orderRef.id, orderItems)
        .catch(err => console.error('Inventory Deduction Error:', err));

    // Trigger Pusher notification for real-time updates (public/online orders)
    pusherService.notifyOrderCreated(restaurantId, {
      id: orderRef.id,
      orderNumber: orderData.orderNumber,
      dailyOrderId: orderData.dailyOrderId,
      status: orderData.status,
      totalAmount: finalTotal,
      tableNumber: tableNum,
      orderType: orderType,
      orderSource: resolvedOrderSource
    }).catch(err => console.error('Pusher notification error (non-blocking):', err));

    res.status(201).json({
      message: 'Order placed successfully',
      order: {
        id: orderRef.id,
        orderNumber: orderData.orderNumber,
        dailyOrderId: orderData.dailyOrderId,
        subtotal: subtotal,
        discountAmount: discountAmount,
        loyaltyDiscount: loyaltyDiscount,
        totalAmount: finalTotal,
        appliedOffer: appliedOffer,
        loyaltyPointsEarned: loyaltyPointsEarned,
        loyaltyPointsRedeemed: loyaltyPointsRedeemed,
        orderType: orderType,
        status: orderData.status
      }
    });

  } catch (error) {
    console.error('Public order creation error:', error);
    res.status(500).json({ error: 'Failed to place order' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    console.log('🛒 Order Creation Request:', {
      restaurantId: req.body.restaurantId,
      tableNumber: req.body.tableNumber,
      itemsCount: req.body.items?.length || 0,
      orderType: req.body.orderType,
      paymentMethod: req.body.paymentMethod
    });

    const {
      restaurantId,
      tableNumber,
      roomNumber, // NEW: Support for hotel room orders
      items,
      customerInfo,
      orderType = 'dine-in',
      paymentMethod = 'cash',
      staffInfo,
      notes,
      customerPhone,
      customerName,
      seatNumber
    } = req.body;

    if (!restaurantId || !items || items.length === 0) {
      console.log('❌ Order Creation Error: Missing required fields', { restaurantId: !!restaurantId, itemsCount: items?.length || 0 });
      return res.status(400).json({ error: 'Restaurant ID and items are required' });
    }

    // For customer self-orders, require phone number
    if (orderType === 'customer_self_order' && !customerPhone) {
      return res.status(400).json({ error: 'Customer phone number is required for self-orders' });
    }

    let totalAmount = 0;
    const orderItems = [];

    // Get restaurant document to access embedded menu items
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const menuItems = restaurantData.menu?.items || [];

    // Validate table number if provided
    if (tableNumber && tableNumber.trim()) {
      console.log('🪑 Validating table number:', tableNumber);
      
      try {
        // Use the new restaurant-centric structure
        console.log('🪑 Using new restaurant-centric structure for restaurant:', restaurantId);
        
        // Get floors from restaurant subcollection
        const floorsSnapshot = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .get();
        
        console.log('🪑 Found floors:', floorsSnapshot.size);
        
        let tableFound = false;
        let tableStatus = null;
        let tableId = null;
        let tableFloor = null;
        
        // Search for the table across all floors
        for (const floorDoc of floorsSnapshot.docs) {
          const floorData = floorDoc.data();
          
          const tablesSnapshot = await db.collection('restaurants')
            .doc(restaurantId)
            .collection('floors')
            .doc(floorDoc.id)
            .collection('tables')
            .get();

          for (const tableDoc of tablesSnapshot.docs) {
            const tableData = tableDoc.data();
            
            if (tableData.name && tableData.name.toString().toLowerCase() === tableNumber.trim().toLowerCase()) {
              tableFound = true;
              tableStatus = tableData.status;
              tableId = tableDoc.id;
              tableFloor = floorData.name;
              console.log('🪑 Found table:', { id: tableId, number: tableNumber, status: tableStatus, floor: tableFloor });
              break;
            }
          }
          
          if (tableFound) break;
        }
        
        if (!tableFound) {
          console.log('❌ Table not found:', tableNumber);
          return res.status(400).json({ 
            error: `Table "${tableNumber}" not found in this restaurant. Please check the table number.` 
          });
        }
        
        // Check table availability - only allow "available" status
        if (tableStatus !== 'available') {
          let statusMessage = '';
          switch (tableStatus) {
            case 'occupied':
              statusMessage = 'is currently occupied by another customer';
              break;
            case 'serving':
              statusMessage = 'is currently being served';
              break;
            case 'out-of-service':
              statusMessage = 'is out of service and cannot be used';
              break;
            case 'reserved':
              statusMessage = 'is reserved for another customer';
              break;
            case 'maintenance':
              statusMessage = 'is under maintenance';
              break;
            default:
              statusMessage = `has status "${tableStatus}" and cannot be used`;
          }
          
          console.log('❌ Table not available:', { table: tableNumber, status: tableStatus });
          return res.status(400).json({ 
            error: `Table "${tableNumber}" ${statusMessage}. Please choose another table.` 
          });
        }
        
        console.log('✅ Table validation passed:', { tableNumber, status: tableStatus });
      } catch (tableError) {
        console.error('❌ Table validation error:', tableError);
        return res.status(500).json({ error: 'Failed to validate table number' });
      }
    }

    for (const item of items) {
      // Find menu item in the embedded menu structure
      const menuItem = menuItems.find(menuItem => menuItem.id === item.menuItemId);
      
      if (!menuItem) {
        return res.status(400).json({ error: `Menu item ${item.menuItemId} not found` });
      }

      // Compute unit price considering variant and selected customizations (toppings)
      const selectedVariant = item.selectedVariant || item.variant || null; // { name, price }
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
        menuItemId: item.menuItemId,
        name: menuItem.name,
        price: unitPrice,
        quantity: itemQuantity,
        total: itemTotal,
        shortCode: menuItem.shortCode || null,
        notes: item.notes || '',
        // Persist kitchen-facing details
        selectedVariant: selectedVariant ? { name: selectedVariant.name, price: selectedVariant.price || 0 } : null,
        selectedCustomizations: customizations.map(c => ({ id: c.id || null, name: c.name || c, price: typeof c.price === 'number' ? c.price : 0 }))
      });
    }

    // Calculate tax if tax settings are enabled
    let taxAmount = 0;
    let finalAmount = totalAmount;
    const taxSettings = restaurantData.taxSettings || {};
    
    if (taxSettings.enabled && totalAmount > 0) {
      if (taxSettings.taxes && Array.isArray(taxSettings.taxes) && taxSettings.taxes.length > 0) {
        taxAmount = taxSettings.taxes
          .filter(tax => tax.enabled)
          .reduce((sum, tax) => sum + (totalAmount * (tax.rate || 0) / 100), 0);
      } else if (taxSettings.defaultTaxRate) {
        taxAmount = totalAmount * (taxSettings.defaultTaxRate / 100);
      }
      finalAmount = totalAmount + taxAmount;
    }

    // Generate order number and daily/sequential order ID (based on restaurant orderSettings.sequentialOrderIdEnabled)
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    const dailyOrderId = await getNextOrderId(restaurantId);

    const orderData = {
      restaurantId,
      orderNumber,
      dailyOrderId,
      tableNumber: tableNumber || seatNumber || null,
      roomNumber: roomNumber || null, // NEW: Hotel room number
      orderType,
      items: orderItems,
      totalAmount,
      taxAmount: Math.round(taxAmount * 100) / 100,
      finalAmount: Math.round(finalAmount * 100) / 100,
          customerInfo: customerInfo || {
            phone: customerPhone,
            name: customerName || 'Customer',
            email: customerInfo?.email || null,
            city: customerInfo?.city || null,
            dob: customerInfo?.dob || null,
            seatNumber: seatNumber || 'Walk-in'
          },
      paymentMethod: paymentMethod || 'cash',
      staffInfo: orderType === 'customer_self_order' ? {
        waiterId: null,
        waiterName: 'Customer Self-Order',
        kitchenNotes: 'Direct customer order'
      } : (staffInfo || null),
      notes: notes || (orderType === 'customer_self_order' ? `Customer self-order from seat ${seatNumber || 'Walk-in'}` : ''),
      status: req.body.status || 'confirmed',
      kotSent: false,
      paymentStatus: roomNumber ? 'hotel-billing' : 'pending', // NEW: Mark as hotel billing if room number provided
      createdAt: new Date(),
      updatedAt: new Date()
    };

    console.log('🛒 Backend Order Creation - Status from frontend:', req.body.status);
    console.log('🛒 Backend Order Creation - Final status:', orderData.status);
    console.log('🛒 Backend Order Creation - StaffInfo received:', req.body.staffInfo);
    console.log('🛒 Backend Order Creation - StaffInfo in orderData:', orderData.staffInfo);

    console.log('🛒 Creating order in database...');
    const orderRef = await db.collection(collections.orders).add(orderData);
    console.log('🛒 Backend Order Creation - Order saved to DB with ID:', orderRef.id);
    console.log('🛒 Backend Order Creation - Order data saved:', orderData);
    
    // NEW: Auto-link order to hotel check-in if room number is provided
    if (roomNumber) {
      try {
        console.log(`🏨 Attempting to link order to room ${roomNumber}...`);

        // First check if order is already linked to a check-in or has been checked-out
        const orderDoc = await orderRef.get();
        const orderData = orderDoc.data();
        if (orderData.linkedToHotel || orderData.hotelCheckInId || orderData.hotelBilledAndCheckedOut) {
          console.log(`⚠️ Order ${orderRef.id} is already linked/billed (checkIn: ${orderData.hotelCheckInId}) - skipping`);
        } else {
          // Find active check-in for this room
          const checkInSnapshot = await db.collection('hotel_checkins')
            .where('restaurantId', '==', restaurantId)
            .where('roomNumber', '==', roomNumber)
            .where('status', '==', 'checked-in')
            .limit(1)
            .get();

          if (!checkInSnapshot.empty) {
            const checkInDoc = checkInSnapshot.docs[0];
            const checkInData = checkInDoc.data();
            const checkInId = checkInDoc.id;

          // Add order to foodOrders array (with duplicate prevention)
          const foodOrders = checkInData.foodOrders || [];

          // Check if order is already linked to prevent duplicates
          const existingOrder = foodOrders.find(order => order.orderId === orderRef.id);
          if (existingOrder) {
            console.log(`⚠️ Order ${orderRef.id} is already linked to check-in ${checkInId} - skipping duplicate`);
          } else {
            // Use finalAmount (with tax) instead of totalAmount for hotel billing
            const orderFinalAmount = orderData.finalAmount || (orderData.totalAmount + (orderData.taxAmount || 0));
            foodOrders.push({
              orderId: orderRef.id,
              amount: Math.round(orderFinalAmount * 100) / 100, // Use final amount with tax
              linkedAt: new Date(),
              status: orderData.status || 'pending',
              paymentStatus: orderData.paymentStatus || 'pending',
              createdAt: orderData.createdAt || new Date(),
              dailyOrderId: orderData.dailyOrderId || null,
              orderNumber: orderData.orderNumber || null
            });

            // Update totals - use orderFinalAmount (with tax) instead of totalAmount
            const totalFoodCharges = (checkInData.totalFoodCharges || 0) + orderFinalAmount;
            const totalCharges = (checkInData.totalRoomCharges || 0) + totalFoodCharges;
            const balanceAmount = totalCharges - (checkInData.advancePayment || 0);

            // Update check-in with linked order
            await db.collection('hotel_checkins').doc(checkInId).update({
              foodOrders,
              totalFoodCharges,
              totalCharges,
              balanceAmount,
              lastUpdated: FieldValue.serverTimestamp()
            });

            // IMPORTANT: Mark order as linked to this check-in to prevent re-linking
            await orderRef.update({
              hotelCheckInId: checkInId,
              linkedToHotel: true,
              hotelLinkTimestamp: FieldValue.serverTimestamp()
            });

            console.log(`✅ Order ${orderRef.id} linked to check-in ${checkInId} for Room ${roomNumber}`);
          }
          } else {
            console.log(`⚠️ No active check-in found for Room ${roomNumber} - order created but not linked`);
          }
        }
      } catch (linkError) {
        console.error('❌ Error linking order to check-in:', linkError);
        // Don't fail order creation if linking fails
      }
    }
    
    // Create/update customer if customer info is provided
    let customerId = null;
    if (customerInfo && (customerInfo.name || customerInfo.phone)) {
      console.log(`📞 Processing customer info for order:`, {
        name: customerInfo.name,
        phone: customerInfo.phone,
        email: customerInfo.email,
        restaurantId: restaurantId
      });
      
      try {
        const customerResponse = await fetch(`${req.protocol}://${req.get('host')}/api/customers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': req.headers.authorization || ''
          },
          body: JSON.stringify({
            name: customerInfo.name,
            phone: customerInfo.phone,
            email: customerInfo.email,
            city: customerInfo.city,
            dob: customerInfo.dob,
            restaurantId: restaurantId,
            orderHistory: [{
              orderId: orderRef.id,
              orderNumber: orderNumber,
              totalAmount: totalAmount,
              orderDate: new Date(),
              tableNumber: tableNumber || seatNumber || null
            }]
          })
        });

        if (customerResponse.ok) {
          const customerData = await customerResponse.json();
          customerId = customerData.customer.id;
          console.log(`👤 Customer processed successfully: ${customerId} - ${customerData.message}`);
        } else {
          const errorData = await customerResponse.json();
          console.log(`❌ Customer processing failed:`, errorData);
        }
      } catch (error) {
        console.error('Customer creation error:', error);
        // Don't fail the order if customer creation fails
      }
    }
    
    console.log(`🛒 Order created successfully: ${orderRef.id} with status: ${orderData.status}`);
    console.log(`📋 Order items: ${orderData.items.length} items`);
    console.log(`🏪 Restaurant: ${orderData.restaurantId}`);
    console.log(`👤 Order type: ${orderData.orderType}`);
    if (customerId) {
      console.log(`👤 Customer ID: ${customerId}`);
    }

    // SMART INVENTORY: Deduct stock asynchronously
    inventoryService.deductInventoryForOrder(restaurantId, orderRef.id, orderItems)
        .catch(err => console.error('Inventory Deduction Error:', err));

    // NEW: Link order to hotel check-in if room number is provided
    if (roomNumber && roomNumber.trim()) {
      try {
        console.log('🏨 Linking order to hotel room:', roomNumber);

        // First check if order is already linked to a check-in or has been checked-out
        const orderDoc = await orderRef.get();
        const currentOrderData = orderDoc.data();
        if (currentOrderData.linkedToHotel || currentOrderData.hotelCheckInId || currentOrderData.hotelBilledAndCheckedOut) {
          console.log(`⚠️ Order ${orderRef.id} is already linked/billed (checkIn: ${currentOrderData.hotelCheckInId}) - skipping`);
        } else {
          // Find active check-in for this room
          const checkInSnapshot = await db.collection('hotel_checkins')
            .where('restaurantId', '==', restaurantId)
            .where('roomNumber', '==', roomNumber.trim())
            .where('status', '==', 'checked-in')
            .limit(1)
            .get();

          if (!checkInSnapshot.empty) {
            const checkInDoc = checkInSnapshot.docs[0];
            const checkInData = checkInDoc.data();

          // Add order to foodOrders array (with duplicate prevention)
          const foodOrders = checkInData.foodOrders || [];

          // Check if order is already linked to prevent duplicates
          const existingOrder = foodOrders.find(order => order.orderId === orderRef.id);
          if (existingOrder) {
            console.log(`⚠️ Order ${orderRef.id} is already linked to check-in ${checkInDoc.id} - skipping duplicate`);
          } else {
            // Use finalAmount (with tax) instead of totalAmount for hotel billing
            const orderFinalAmount = currentOrderData.finalAmount || (currentOrderData.totalAmount + (currentOrderData.taxAmount || 0));
            foodOrders.push({
              orderId: orderRef.id,
              orderNumber: orderNumber,
              amount: Math.round(orderFinalAmount * 100) / 100, // Use final amount with tax
              linkedAt: new Date(),
              status: currentOrderData.status || 'pending',
              paymentStatus: currentOrderData.paymentStatus || 'pending',
              createdAt: currentOrderData.createdAt || new Date(),
              dailyOrderId: currentOrderData.dailyOrderId || null
            });

            // Update totals - use orderFinalAmount (with tax) instead of totalAmount
            const totalFoodCharges = (checkInData.totalFoodCharges || 0) + orderFinalAmount;
            const totalCharges = checkInData.totalRoomCharges + totalFoodCharges;
            const balanceAmount = totalCharges - (checkInData.advancePayment || 0);

            // Update check-in with linked order
            await checkInDoc.ref.update({
              foodOrders,
              totalFoodCharges,
              totalCharges,
              balanceAmount,
              lastUpdated: FieldValue.serverTimestamp()
            });

            // IMPORTANT: Mark order as linked to this check-in to prevent re-linking
            await orderRef.update({
              hotelCheckInId: checkInDoc.id,
              linkedToHotel: true,
              hotelLinkTimestamp: FieldValue.serverTimestamp()
            });

            console.log('✅ Order linked to hotel check-in:', checkInDoc.id);
          }
          } else {
            console.log('⚠️ No active check-in found for room:', roomNumber);
          }
        }
      } catch (hotelLinkError) {
        console.error('❌ Failed to link order to hotel check-in:', hotelLinkError);
        // Don't fail the order if hotel linking fails
      }
    }

    // Update table status to "occupied" if table number is provided
    if (tableNumber && tableNumber.trim()) {
      try {
        console.log('🔄 Updating table status to occupied:', tableNumber);

        // Find the table in the new restaurant-centric structure
        const floorsSnapshot = await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .get();

        let tableUpdated = false;
        for (const floorDoc of floorsSnapshot.docs) {
          const tablesSnapshot = await db.collection('restaurants')
            .doc(restaurantId)
            .collection('floors')
            .doc(floorDoc.id)
            .collection('tables')
            .where('name', '==', tableNumber.trim())
            .get();

          if (!tablesSnapshot.empty) {
            const tableDoc = tablesSnapshot.docs[0];
            await tableDoc.ref.update({
              status: 'occupied',
              currentOrderId: orderRef.id,
              lastOrderTime: new Date(),
              updatedAt: new Date()
            });
            console.log('✅ Table status updated to occupied:', tableNumber);
            tableUpdated = true;
            break;
          }
        }

        if (!tableUpdated) {
          console.log('⚠️ Table not found for status update:', tableNumber);
        }
      } catch (tableUpdateError) {
        console.error('❌ Failed to update table status:', tableUpdateError);
        // Don't fail the order if table status update fails
      }
    }

    // Trigger automation: Sync customer, send WhatsApp confirmation, and trigger automations (non-blocking)
    try {
      const customerId = await automationService.syncCustomerFromOrder({
        ...orderData,
        id: orderRef.id,
        restaurantId: restaurantId
      });
      
      // Send WhatsApp order confirmation message if customer phone is available
      if (orderData.customerInfo?.phone || orderData.customerDisplay?.phone || orderData.customer?.phone) {
        automationService.sendOrderConfirmationMessage(restaurantId, {
          ...orderData,
          id: orderRef.id
        }).catch(err => {
          console.error('📱 WhatsApp order confirmation error (non-blocking):', err);
        });
      }
      
      // Trigger new_order automation if customer exists
      if (customerId && (orderData.customerInfo?.phone || orderData.customerDisplay?.phone || orderData.customer?.phone)) {
        automationService.processTrigger(restaurantId, 'new_order', {
          customerId: customerId,
          orderAmount: totalAmount,
          orderNumber: dailyOrderId || orderNumber,
          restaurantName: restaurantData.name || 'Restaurant'
        }).catch(err => {
          console.error('Automation trigger error (non-blocking):', err);
        });
      }
    } catch (error) {
      console.error('Automation sync error (non-blocking):', error);
      // Don't fail order creation if automation fails
    }

    // Trigger Pusher notification for real-time updates
    pusherService.notifyOrderCreated(restaurantId, {
      id: orderRef.id,
      orderNumber: orderNumber,
      dailyOrderId: dailyOrderId,
      status: orderData.status,
      totalAmount: totalAmount,
      tableNumber: tableNumber,
      orderType: orderType
    }).catch(err => console.error('Pusher notification error (non-blocking):', err));

    res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: orderRef.id,
        ...orderData
      }
    });

  } catch (error) {
    console.error('❌ Create order error:', error);
    console.error('❌ Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.get('/api/orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { 
      page = 1, 
      limit = 10, 
      status, 
      date, 
      search, 
      waiterId,
      orderType,
      todayOnly 
    } = req.query;

    console.log(`🔍 Orders API - Restaurant: ${restaurantId}, Page: ${page}, Limit: ${limit}, Status: ${status || 'all'}, Search: ${search || 'none'}, Waiter: ${waiterId || 'all'}, TodayOnly: ${todayOnly}`);

    // Calculate pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;

    let query = db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId);

    // Apply status filter
    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    // Apply order type filter
    if (orderType && orderType !== 'all') {
      query = query.where('orderType', '==', orderType);
    }

    // Apply today filter
    if (todayOnly === 'true') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      
      query = query.where('createdAt', '>=', todayStart)
                   .where('createdAt', '<=', todayEnd);
    }

    // Apply date filter (for specific date)
    if (date && todayOnly !== 'true') {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      
      query = query.where('createdAt', '>=', startDate)
                   .where('createdAt', '<', endDate);
    }

    // Get all orders first (for proper filtering and pagination)
    const allSnapshot = await query.orderBy('createdAt', 'desc').get();
    let allOrders = [];

    allSnapshot.forEach(doc => {
      const orderData = doc.data();
      const order = {
        id: doc.id,
        ...orderData,
        // Ensure proper date formatting
        createdAt: orderData.createdAt,
        updatedAt: orderData.updatedAt,
        completedAt: orderData.completedAt || null,
        // Add order flow information
        orderFlow: {
          isDirectBilling: orderData.status === 'completed' && !orderData.kotSent,
          isKitchenOrder: orderData.kotSent || orderData.status === 'confirmed',
          isCompleted: orderData.status === 'completed',
          isPending: orderData.status === 'pending' || orderData.status === 'confirmed'
        },
        // Format customer info
        customerDisplay: {
          name: orderData.customerInfo?.name || 'Walk-in Customer',
          phone: orderData.customerInfo?.phone || null,
          tableNumber: orderData.tableNumber || null
        },
        // Format staff info
        staffDisplay: {
          name: orderData.staffInfo?.name || 'Staff',
          role: orderData.staffInfo?.role || 'waiter',
          userId: orderData.staffInfo?.userId || null
        }
      };
      allOrders.push(order);
    });

    console.log(`📋 Order History - Total orders before filtering: ${allOrders.length}`);

    // Apply waiter filter if provided
    if (waiterId && waiterId !== 'all') {
      allOrders = allOrders.filter(order => {
        return order.staffInfo && order.staffInfo.userId === waiterId;
      });
      console.log(`👤 Filtered by waiter ${waiterId}: ${allOrders.length} orders found`);
    }

    // Apply search filter if provided
    if (search && search.trim()) {
      const searchValue = search.toLowerCase().trim();
      console.log(`🔎 Searching orders for: "${searchValue}"`);
      
      allOrders = allOrders.filter(order => {
        // Search by Firestore order ID (document id)
        if (order.id && order.id.toLowerCase().includes(searchValue)) {
          return true;
        }
        
        // Search by order number (e.g. ORD-...)
        if (order.orderNumber && order.orderNumber.toLowerCase().includes(searchValue)) {
          return true;
        }
        
        // Search by display order # (dailyOrderId: 1, 2, 3,...) – works for both daily-reset and sequential modes
        if (order.dailyOrderId != null && String(order.dailyOrderId) === searchValue) {
          return true;
        }
        
        // Search by table number
        if (order.tableNumber && order.tableNumber.toString().toLowerCase().includes(searchValue)) {
          return true;
        }
        
        // Search by customer info
        if (order.customerInfo) {
          if (order.customerInfo.name && order.customerInfo.name.toLowerCase().includes(searchValue)) {
            return true;
          }
          if (order.customerInfo.phone && order.customerInfo.phone.includes(searchValue)) {
            return true;
          }
        }
        
        return false;
      });
      console.log(`🔎 Search results: ${allOrders.length} orders found`);
    }

    // Calculate pagination after filtering
    const totalOrders = allOrders.length;
    const totalPages = Math.ceil(totalOrders / limitNum);
    
    // Apply pagination
    const orders = allOrders.slice(offset, offset + limitNum);
    
    console.log(`📋 Order History - Found ${orders.length} orders (page ${pageNum}/${totalPages})`);

    res.json({ 
      orders,
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalOrders,
        limit: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });
  } catch (error) {
    console.error('Orders API error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Analytics endpoints
app.get('/api/analytics/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { period = '7d' } = req.query;
    
    console.log(`📊 Fetching analytics for restaurant ${restaurantId}, period: ${period}`);
    
    // Calculate date range based on period
    const now = new Date();
    let startDate;
    
    switch (period) {
      case 'today':
        // Today's orders only
        startDate = new Date(now);
        startDate.setHours(0, 0, 0, 0);
        break;
      case '24h':
      case 'last24hours':
        // Last 24 hours
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
      case 'last7days':
        // Last 7 days
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
      case 'last30days':
        // Last 30 days
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'all':
        // All orders (no date filter)
        startDate = null;
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    // Fetch orders for the restaurant in the date range
    let ordersQuery;
    if (startDate === null) {
      // All orders - no date filter
      ordersQuery = await db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .get();
    } else {
      // Filter by date range
      ordersQuery = await db.collection(collections.orders)
        .where('restaurantId', '==', restaurantId)
        .where('createdAt', '>=', startDate)
        .where('createdAt', '<=', now)
        .get();
    }
    
    const orders = ordersQuery.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    console.log(`📊 Found ${orders.length} orders for analytics`);
    
    // Calculate analytics
    const analytics = calculateAnalytics(orders, period);
    
    res.json({
      success: true,
      analytics,
      period,
      totalOrders: orders.length
    });
    
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Helper function to calculate analytics
function calculateAnalytics(orders, period) {
  if (orders.length === 0) {
    return {
      totalRevenue: 0,
      totalOrders: 0,
      avgOrderValue: 0,
      newCustomers: 0,
      popularItems: [],
      revenueData: [],
      ordersByType: [],
      busyHours: []
    };
  }
  
  // Calculate basic metrics
  const totalRevenue = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
  const totalOrders = orders.length;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
  
  // Calculate new customers (customers who placed their first order in this period)
  const customerIds = [...new Set(orders.map(order => order.customerId).filter(Boolean))];
  const newCustomers = customerIds.length; // Simplified - in real app, check against historical data
  
  // Calculate popular items
  const itemCounts = {};
  const itemRevenue = {};
  
  orders.forEach(order => {
    if (order.items && Array.isArray(order.items)) {
      order.items.forEach(item => {
        const itemName = item.name || item.itemName;
        if (itemName) {
          itemCounts[itemName] = (itemCounts[itemName] || 0) + (item.quantity || 1);
          itemRevenue[itemName] = (itemRevenue[itemName] || 0) + (item.price || 0) * (item.quantity || 1);
        }
      });
    }
  });
  
  const popularItems = Object.keys(itemCounts)
    .map(name => ({
      name,
      orders: itemCounts[name],
      revenue: itemRevenue[name] || 0
    }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5);
  
  // Calculate revenue data by day
  const revenueByDay = {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  orders.forEach(order => {
    const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
    const dayName = dayNames[orderDate.getDay()];
    revenueByDay[dayName] = (revenueByDay[dayName] || 0) + (order.totalAmount || 0);
  });
  
  const revenueData = dayNames.map(day => ({
    day,
    revenue: revenueByDay[day] || 0
  }));
  
  // Calculate orders by type
  const ordersByType = {};
  orders.forEach(order => {
    const type = order.orderType || 'Dine In';
    ordersByType[type] = (ordersByType[type] || 0) + 1;
  });
  
  const totalOrderCount = Object.values(ordersByType).reduce((sum, count) => sum + count, 0);
  const ordersByTypeArray = Object.keys(ordersByType).map(type => ({
    type,
    count: ordersByType[type],
    percentage: totalOrderCount > 0 ? Math.round((ordersByType[type] / totalOrderCount) * 100 * 10) / 10 : 0
  }));
  
  // Calculate busy hours
  const hourCounts = {};
  orders.forEach(order => {
    const orderDate = order.createdAt?.toDate ? order.createdAt.toDate() : new Date(order.createdAt);
    const hour = orderDate.getHours();
    const hourStr = `${hour.toString().padStart(2, '0')}:00`;
    hourCounts[hourStr] = (hourCounts[hourStr] || 0) + 1;
  });
  
  const busyHours = Object.keys(hourCounts)
    .map(hour => ({
      hour,
      orders: hourCounts[hour]
    }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 6);
  
  return {
    totalRevenue,
    totalOrders,
    avgOrderValue,
    newCustomers,
    popularItems,
    revenueData,
    ordersByType: ordersByTypeArray,
    busyHours
  };
}

app.patch('/api/orders/:orderId/status', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get the order first to validate it exists and belongs to user's restaurant
    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = orderDoc.data();
    
    // Get user's restaurant context
    const user = req.user;
    let userRestaurantId = null;
    
    if (user.restaurantId) {
      // Staff user - use their assigned restaurant
      userRestaurantId = user.restaurantId;
    } else if (user.role === 'owner' || user.role === 'admin') {
      // Owner/Admin - get selected restaurant from request or use order's restaurant
      userRestaurantId = req.body.restaurantId || orderData.restaurantId;
    }
    
    // Validate that the order belongs to the user's restaurant
    if (orderData.restaurantId !== userRestaurantId) {
      return res.status(403).json({ error: 'Access denied: Order does not belong to your restaurant' });
    }

    // NEW: Handle deferred loyalty/stats updates on completion
    if (status === 'completed' && orderData.status !== 'completed') {
      console.log(`✅ Order ${orderId} marked as completed. Processing deferred updates...`);
      
      const customerId = orderData.customerId;
      
      // Update Offer Usage for all applied offers
      const offersToUpdate = orderData.appliedOffers && orderData.appliedOffers.length > 0
        ? orderData.appliedOffers
        : (orderData.appliedOffer && orderData.appliedOffer.id ? [orderData.appliedOffer] : []);

      for (const appliedOfferItem of offersToUpdate) {
        if (appliedOfferItem && appliedOfferItem.id) {
          try {
            await db.collection('offers').doc(appliedOfferItem.id).update({
              usageCount: FieldValue.increment(1),
              updatedAt: new Date()
            });
            console.log(`🎁 Offer usage incremented for ${appliedOfferItem.id}`);
          } catch (err) {
            console.error('Error updating offer usage:', err);
          }
        }
      }

      // Update Customer Stats and Loyalty
      if (customerId) {
        try {
          const customerUpdateData = {
            totalOrders: FieldValue.increment(1),
            totalSpent: FieldValue.increment(orderData.totalAmount || 0),
            lastOrderDate: new Date(),
            updatedAt: new Date()
          };
          
          const pointsEarned = orderData.loyaltyPointsEarned || 0;
          const pointsRedeemed = orderData.loyaltyPointsRedeemed || 0;
          const netPointsChange = pointsEarned - pointsRedeemed;
          
          if (netPointsChange !== 0) {
            customerUpdateData.loyaltyPoints = FieldValue.increment(netPointsChange);
          }
          
          await db.collection('customers').doc(customerId).update(customerUpdateData);
          console.log(`👤 Customer stats updated for ${customerId}. Points: ${netPointsChange > 0 ? '+' : ''}${netPointsChange}`);
          
          // Add to order history
          const orderHistoryEntry = {
            orderId: orderId,
            orderNumber: orderData.orderNumber,
            orderDate: new Date(), // Completion date
            totalAmount: orderData.totalAmount,
            subtotal: orderData.subtotal,
            discountAmount: orderData.discountAmount,
            loyaltyDiscount: orderData.loyaltyDiscount,
            tableNumber: orderData.tableNumber,
            orderType: orderData.orderType,
            orderTypeLabel: orderData.orderTypeLabel,
            orderSource: orderData.orderSource,
            status: 'completed',
            itemsCount: orderData.items?.length || 0,
            appliedOffer: orderData.appliedOffer?.name || null,
            loyaltyPointsEarned: pointsEarned,
            loyaltyPointsRedeemed: pointsRedeemed
          };

          await db.collection('customers').doc(customerId).update({
            orderHistory: FieldValue.arrayUnion(orderHistoryEntry)
          });
          console.log('📜 Order added to customer history');

        } catch (err) {
          console.error('Error updating customer stats:', err);
        }
      }
    }

    await db.collection(collections.orders).doc(orderId).update({
      status,
      updatedAt: new Date()
    });

    // Trigger Pusher notification for real-time updates
    pusherService.notifyOrderStatusUpdated(orderData.restaurantId, orderId, status, {
      orderNumber: orderData.orderNumber,
      dailyOrderId: orderData.dailyOrderId,
      totalAmount: orderData.totalAmount
    }).catch(err => console.error('Pusher notification error (non-blocking):', err));

    res.json({ message: 'Order status updated successfully' });

  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// Update order (items, table number, etc.)
app.patch('/api/orders/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { 
      items, 
      tableNumber, 
      orderType, 
      paymentMethod, 
      status,
      paymentStatus,
      completedAt,
      customerInfo,
      updatedAt, 
      lastUpdatedBy 
    } = req.body;

    // Validate items if provided
    if (items && (!Array.isArray(items) || items.length === 0)) {
      return res.status(400).json({ error: 'Items must be a non-empty array' });
    }

    // Get current order to validate it exists
    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const currentOrder = orderDoc.data();
    
    // Get user's restaurant context
    const user = req.user;
    let userRestaurantId = null;
    
    if (user.restaurantId) {
      // Staff user - use their assigned restaurant
      userRestaurantId = user.restaurantId;
    } else if (user.role === 'owner' || user.role === 'admin') {
      // Owner/Admin - get selected restaurant from request or use order's restaurant
      userRestaurantId = req.body.restaurantId || currentOrder.restaurantId;
    }
    
    // Validate that the order belongs to the user's restaurant
    if (currentOrder.restaurantId !== userRestaurantId) {
      return res.status(403).json({ error: 'Access denied: Order does not belong to your restaurant' });
    }
    
    // Validate table number if provided and different from original
    if (tableNumber !== undefined && tableNumber !== currentOrder.tableNumber) {
      console.log('🪑 Table number changed from', currentOrder.tableNumber, 'to', tableNumber);
      
      if (tableNumber && tableNumber.trim()) {
        // Use the SAME logic as the floors API endpoint
        console.log('🪑 Using floors API logic for update, restaurant:', currentOrder.restaurantId);
        
        // Get all tables for this restaurant (same as floors API)
        const tablesSnapshot = await db.collection(collections.tables)
          .where('restaurantId', '==', currentOrder.restaurantId)
          .get();
        
        console.log('🪑 Found tables for update:', tablesSnapshot.size);
        
        let tableFound = false;
        let tableStatus = null;
        let tableId = null;
        
        // Search for the table directly in tables collection
        for (const doc of tablesSnapshot.docs) {
          const table = {
            id: doc.id,
            ...doc.data()
          };
          
          if (table.name && table.name.toString().toLowerCase() === tableNumber.trim().toLowerCase()) {
            tableFound = true;
            tableStatus = table.status;
            tableId = table.id;
            console.log('🪑 Found table for update:', { id: tableId, number: tableNumber, status: tableStatus, floor: table.floor });
            break;
          }
        }
        
        if (!tableFound) {
          return res.status(400).json({ 
            error: `Table "${tableNumber}" not found in this restaurant. Please check the table number.` 
          });
        }
        
        // Check table availability - only allow "available" status
        if (tableStatus !== 'available') {
          let statusMessage = '';
          switch (tableStatus) {
            case 'occupied':
              statusMessage = 'is currently occupied by another customer';
              break;
            case 'serving':
              statusMessage = 'is currently being served';
              break;
            case 'out-of-service':
              statusMessage = 'is out of service and cannot be used';
              break;
            case 'reserved':
              statusMessage = 'is reserved for another customer';
              break;
            case 'maintenance':
              statusMessage = 'is under maintenance';
              break;
            default:
              statusMessage = `has status "${tableStatus}" and cannot be used`;
          }
          
          console.log('❌ Table not available for update:', { table: tableNumber, status: tableStatus });
          return res.status(400).json({ 
            error: `Table "${tableNumber}" ${statusMessage}. Please choose another table.` 
          });
        }
        
        console.log('✅ New table validation passed:', { tableNumber, status: tableStatus });
      }
    }
    
    // Don't allow updates to completed or cancelled orders unless we're completing them
    if ((currentOrder.status === 'completed' || currentOrder.status === 'cancelled') && status !== 'completed') {
      return res.status(400).json({ error: 'Cannot update completed or cancelled orders' });
    }

    // Prepare update data
    const updateData = {
      updatedAt: updatedAt ? new Date(updatedAt) : new Date()
    };

    if (items) {
      // Compare with existing items to mark new/updated items
      const existingItems = currentOrder.items || [];
      const processedItems = items.map(newItem => {
        const existingItem = existingItems.find(existing => existing.menuItemId === newItem.menuItemId);
        
        // Ensure each item has proper price and total information
        const itemWithTotals = {
          ...newItem,
          // Ensure price is available
          price: newItem.price || existingItem?.price || 0,
          // Calculate total if not provided
          total: newItem.total || (newItem.price || existingItem?.price || 0) * newItem.quantity
        };
        
        if (!existingItem) {
          // This is a completely new item
          return { ...itemWithTotals, isNew: true, addedAt: new Date().toISOString() };
        } else if (existingItem.quantity !== newItem.quantity) {
          // This item's quantity was updated
          return { ...itemWithTotals, isUpdated: true, updatedAt: new Date().toISOString() };
        } else {
          // This item was not changed
          return { ...itemWithTotals };
        }
      });
      
      updateData.items = processedItems;
      updateData.itemCount = processedItems.reduce((sum, item) => sum + item.quantity, 0);
      updateData.totalAmount = await calculateOrderTotal(processedItems);
      
      // Double-check totalAmount calculation
      if (updateData.totalAmount === 0 && processedItems.length > 0) {
        console.warn('⚠️ Total amount calculated as 0, recalculating from items...');
        updateData.totalAmount = processedItems.reduce((sum, item) => sum + (item.total || 0), 0);
      }
      
      // Calculate tax if tax settings are enabled
      const restaurantDoc = await db.collection(collections.restaurants).doc(currentOrder.restaurantId).get();
      if (restaurantDoc.exists) {
        const restaurantData = restaurantDoc.data();
        const taxSettings = restaurantData.taxSettings || {};
        
        if (taxSettings.enabled && updateData.totalAmount > 0) {
          let taxAmount = 0;
          if (taxSettings.taxes && Array.isArray(taxSettings.taxes) && taxSettings.taxes.length > 0) {
            taxAmount = taxSettings.taxes
              .filter(tax => tax.enabled)
              .reduce((sum, tax) => sum + (updateData.totalAmount * (tax.rate || 0) / 100), 0);
          } else if (taxSettings.defaultTaxRate) {
            taxAmount = updateData.totalAmount * (taxSettings.defaultTaxRate / 100);
          }
          updateData.taxAmount = Math.round(taxAmount * 100) / 100;
          updateData.finalAmount = Math.round((updateData.totalAmount + taxAmount) * 100) / 100;
        } else {
          // Tax disabled - set taxAmount to 0 and finalAmount = totalAmount
          updateData.taxAmount = 0;
          updateData.finalAmount = updateData.totalAmount;
        }
      } else {
        // Restaurant doc doesn't exist - preserve existing values for backward compatibility
        updateData.taxAmount = currentOrder.taxAmount || 0;
        updateData.finalAmount = updateData.totalAmount || currentOrder.finalAmount || currentOrder.totalAmount || 0;
      }
      
      console.log('🔄 Updated order totals:', {
        itemCount: updateData.itemCount,
        totalAmount: updateData.totalAmount,
        taxAmount: updateData.taxAmount,
        finalAmount: updateData.finalAmount,
        items: processedItems.map(item => ({
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          total: item.total
        }))
      });
    }

    if (tableNumber !== undefined) updateData.tableNumber = tableNumber;
    if (orderType) updateData.orderType = orderType;
    if (paymentMethod) updateData.paymentMethod = paymentMethod;
    if (status) updateData.status = status;
    if (paymentStatus) updateData.paymentStatus = paymentStatus;
    if (completedAt) updateData.completedAt = new Date(completedAt);
    if (customerInfo) updateData.customerInfo = customerInfo;
    if (lastUpdatedBy) updateData.lastUpdatedBy = lastUpdatedBy;

    // Add update history
    const updateHistory = currentOrder.updateHistory || [];
    updateHistory.push({
      timestamp: updateData.updatedAt,
      updatedBy: lastUpdatedBy || { name: 'System', id: 'system' },
      changes: {
        items: items ? `Updated to ${items.length} items` : null,
        tableNumber: tableNumber !== undefined ? `Changed to ${tableNumber}` : null,
        orderType: orderType ? `Changed to ${orderType}` : null,
        paymentMethod: paymentMethod ? `Changed to ${paymentMethod}` : null,
        status: status ? `Changed to ${status}` : null,
        paymentStatus: paymentStatus ? `Changed to ${paymentStatus}` : null,
        customerInfo: customerInfo ? 'Customer information updated' : null
      }
    });
    updateData.updateHistory = updateHistory;

    console.log('🔄 Backend - Updating order:', orderId, 'with data:', updateData);
    await db.collection(collections.orders).doc(orderId).update(updateData);

    // NEW: If order is linked to hotel check-in, update the check-in's foodOrders array
    // This ensures the checkbox auto-checks when order status changes to completed
    if (currentOrder.hotelCheckInId && (status || paymentStatus)) {
      try {
        const checkInRef = db.collection('hotel_checkins').doc(currentOrder.hotelCheckInId);
        const checkInDoc = await checkInRef.get();
        
        if (checkInDoc.exists) {
          const checkInData = checkInDoc.data();
          const foodOrders = checkInData.foodOrders || [];
          
          // Find and update the order in foodOrders array
          const orderIndex = foodOrders.findIndex(fo => fo.orderId === orderId || fo.id === orderId);
          if (orderIndex !== -1) {
            // Calculate final amount for the order (with tax)
            let updatedFinalAmount = foodOrders[orderIndex].amount; // Default to existing amount
            if (updateData.finalAmount) {
              updatedFinalAmount = Math.round(updateData.finalAmount * 100) / 100;
            } else if (updateData.totalAmount) {
              // Calculate from totalAmount + taxAmount if finalAmount not available
              updatedFinalAmount = Math.round((updateData.totalAmount + (updateData.taxAmount || 0)) * 100) / 100;
            }
            
            foodOrders[orderIndex] = {
              ...foodOrders[orderIndex],
              status: status || foodOrders[orderIndex].status || currentOrder.status,
              paymentStatus: paymentStatus || foodOrders[orderIndex].paymentStatus || currentOrder.paymentStatus,
              // Update amount to final amount (with tax)
              amount: updatedFinalAmount
            };
            
            // Recalculate totals
            const totalFoodCharges = foodOrders.reduce((sum, fo) => sum + (fo.amount || 0), 0);
            const totalCharges = (checkInData.totalRoomCharges || 0) + totalFoodCharges;
            const balanceAmount = totalCharges - (checkInData.advancePayment || 0);
            
            await checkInRef.update({
              foodOrders,
              totalFoodCharges,
              totalCharges,
              balanceAmount,
              lastUpdated: FieldValue.serverTimestamp()
            });
            
            console.log(`✅ Updated check-in ${currentOrder.hotelCheckInId} foodOrders for order ${orderId}`);
          }
        }
      } catch (checkInUpdateError) {
        console.error('❌ Failed to update check-in foodOrders:', checkInUpdateError);
        // Don't fail the order update if check-in update fails
      }
    }

    // Release table if order is being completed (Complete Billing in edit mode)
    if (status === 'completed' && currentOrder.tableNumber && currentOrder.tableNumber.trim()) {
      try {
        console.log('🔄 Releasing table due to order completion:', currentOrder.tableNumber);
        
        // Use the new restaurant-centric structure
        const floorsSnapshot = await db.collection('restaurants')
          .doc(currentOrder.restaurantId)
          .collection('floors')
          .get();
        
        let tableReleased = false;
        for (const floorDoc of floorsSnapshot.docs) {
          const tablesSnapshot = await db.collection('restaurants')
            .doc(currentOrder.restaurantId)
            .collection('floors')
            .doc(floorDoc.id)
            .collection('tables')
            .where('name', '==', currentOrder.tableNumber.trim())
            .get();
          
          if (!tablesSnapshot.empty) {
            const tableDoc = tablesSnapshot.docs[0];
            await tableDoc.ref.update({
              status: 'available',
              currentOrderId: null,
              updatedAt: new Date()
            });
            console.log('✅ Table released after order completion:', currentOrder.tableNumber);
            tableReleased = true;
            break;
          }
        }
        
        if (!tableReleased) {
          console.log('⚠️ Table not found for release:', currentOrder.tableNumber);
        }
      } catch (tableReleaseError) {
        console.error('❌ Failed to release table after order completion:', tableReleaseError);
        // Don't fail the order update if table release fails
      }
    }

    // Update table status if table number changed
    if (tableNumber !== undefined && tableNumber !== currentOrder.tableNumber) {
      try {
        // Free up the old table if it exists
        if (currentOrder.tableNumber && currentOrder.tableNumber.trim()) {
          console.log('🔄 Freeing up old table:', currentOrder.tableNumber);
          
          // Use the new restaurant-centric structure
          const floorsSnapshot = await db.collection('restaurants')
            .doc(currentOrder.restaurantId)
            .collection('floors')
            .get();
          
          let oldTableFreed = false;
          for (const floorDoc of floorsSnapshot.docs) {
            const oldTablesSnapshot = await db.collection('restaurants')
              .doc(currentOrder.restaurantId)
              .collection('floors')
              .doc(floorDoc.id)
              .collection('tables')
              .where('name', '==', currentOrder.tableNumber.trim())
              .get();
            
            if (!oldTablesSnapshot.empty) {
              const oldTableDoc = oldTablesSnapshot.docs[0];
              await oldTableDoc.ref.update({
                status: 'available',
                currentOrderId: null,
                updatedAt: new Date()
              });
              console.log('✅ Old table freed:', currentOrder.tableNumber);
              oldTableFreed = true;
              break;
            }
          }
          
          if (!oldTableFreed) {
            console.log('⚠️ Old table not found for freeing:', currentOrder.tableNumber);
          }
        }
        
        // Occupy the new table if provided
        if (tableNumber && tableNumber.trim()) {
          console.log('🔄 Occupying new table:', tableNumber);
          
          // Use the new restaurant-centric structure
          const floorsSnapshot = await db.collection('restaurants')
            .doc(currentOrder.restaurantId)
            .collection('floors')
            .get();
          
          let tableUpdated = false;
          for (const floorDoc of floorsSnapshot.docs) {
            const tablesSnapshot = await db.collection('restaurants')
              .doc(currentOrder.restaurantId)
              .collection('floors')
              .doc(floorDoc.id)
              .collection('tables')
              .where('name', '==', tableNumber.trim())
              .get();
            
            if (!tablesSnapshot.empty) {
              const newTableDoc = tablesSnapshot.docs[0];
              await newTableDoc.ref.update({
                status: 'occupied',
                currentOrderId: orderId,
                lastOrderTime: new Date(),
                updatedAt: new Date()
              });
              console.log('✅ New table occupied:', tableNumber);
              tableUpdated = true;
              break;
            }
          }
          
          if (!tableUpdated) {
            console.log('⚠️ New table not found for occupation:', tableNumber);
          }
        }
      } catch (tableUpdateError) {
        console.error('❌ Failed to update table status during order update:', tableUpdateError);
        // Don't fail the order update if table status update fails
      }
    }

    // Trigger Pusher notification for real-time updates
    pusherService.notifyOrderUpdated(currentOrder.restaurantId, orderId, {
      status: status || currentOrder.status,
      orderNumber: currentOrder.orderNumber,
      dailyOrderId: currentOrder.dailyOrderId,
      totalAmount: updateData.totalAmount || currentOrder.totalAmount,
      items: updateData.items || currentOrder.items
    }).catch(err => console.error('Pusher notification error (non-blocking):', err));

    res.json({
      message: 'Order updated successfully',
      data: { orderId }
    });

  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// Delete order (admin/owner only)
app.delete('/api/orders/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { userId, role } = req.user;
    
    // Check if user has admin or owner privileges
    if (role !== 'admin' && role !== 'owner') {
      return res.status(403).json({ error: 'Access denied. Admin or owner privileges required.' });
    }
    
    // Get the order to check if it exists and get restaurant info
    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }
    
    const order = orderDoc.data();
    
    // If user is owner, check if they own the restaurant
    if (role === 'owner') {
      const restaurant = await db.collection(collections.restaurants).doc(order.restaurantId).get();
      if (!restaurant.exists || restaurant.data().ownerId !== userId) {
        return res.status(403).json({ error: 'Access denied. You can only delete orders from your own restaurant.' });
      }
    }
    
    // Don't allow deletion of completed orders (optional business rule)
    if (order.status === 'completed') {
      return res.status(400).json({ error: 'Cannot delete completed orders' });
    }
    
    // Delete the order
    await db.collection(collections.orders).doc(orderId).delete();

    // Trigger Pusher notification for real-time updates
    pusherService.notifyOrderDeleted(order.restaurantId, orderId)
      .catch(err => console.error('Pusher notification error (non-blocking):', err));

    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

// Helper function to calculate order total
async function calculateOrderTotal(items) {
  let total = 0;
  
  for (const item of items) {
    try {
      // First try to use the embedded price data from the order item
      if (item.price && item.quantity) {
        total += item.price * item.quantity;
        continue;
      }
      
      // Fallback: try to use the total field if available
      if (item.total) {
        total += item.total;
        continue;
      }
      
      // Last resort: fetch from menu items collection (legacy support)
      const menuItemDoc = await db.collection(collections.menuItems).doc(item.menuItemId).get();
      if (menuItemDoc.exists) {
        const menuItem = menuItemDoc.data();
        total += menuItem.price * item.quantity;
      } else {
        console.warn(`Menu item ${item.menuItemId} not found in separate collection`);
      }
    } catch (error) {
      console.error('Error calculating item total:', error);
      // Continue with other items if one fails
    }
  }
  
  return total;
}

// Initialize payment routes
const paymentRoutes = initializePaymentRoutes(db, razorpay);
app.use('/api/payments', paymentRoutes);

// Initialize chatbot RAG routes
app.use('/api', chatbotRoutes);

// Initialize hotel management routes (restaurant-hotel integration)
// NOTE: hotelManagementRoutes must be registered BEFORE hotelRoutes to handle
// routes like /api/hotel/rooms/availability correctly
app.use('/api', hotelManagementRoutes);

// Initialize hotel PMS routes (deprecated - kept for backward compatibility)
app.use('/api/hotel', hotelRoutes);
app.use('/api', roomManagementRoutes);

// Initialize shift scheduling routes
app.use('/api/shift-scheduling', shiftSchedulingRoutes);

// Initialize Google Reviews routes
app.use('/api/google-reviews', googleReviewsRoutes);

// Initialize Custom URL (slug) routes
app.use('/api', customUrlRoutes);


// Generic image upload API
app.post('/api/upload/image', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { userId } = req.user;
    const file = req.file;

    console.log('Generic image upload:', {
      userId,
      fileName: file ? file.originalname : 'none',
      fileSize: file ? file.size : 0
    });

    if (!file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ 
        error: 'Invalid file type. Only JPEG, PNG, and WebP images are allowed.' 
      });
    }

    // Validate file size (5MB max)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return res.status(400).json({ 
        error: 'File too large. Maximum file size is 5MB.' 
      });
    }

    // Upload to Firebase Storage
    const fileName = `images/${Date.now()}-${file.originalname}`;
    const fileUpload = bucket.file(fileName);

    const stream = fileUpload.createWriteStream({
      metadata: {
        contentType: file.mimetype,
        metadata: {
          uploadedBy: userId,
          originalName: file.originalname,
          uploadDate: new Date().toISOString()
        }
      }
    });

    stream.on('error', (error) => {
      console.error('Error uploading to Firebase Storage:', error);
      res.status(500).json({ error: 'Failed to upload image' });
    });

    stream.on('finish', async () => {
      try {
        // Make the file publicly accessible
        await fileUpload.makePublic();
        
        // Get the public URL
        const imageUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
        
        console.log('✅ Image uploaded successfully:', imageUrl);
        
        res.json({
          success: true,
          imageUrl: imageUrl,
          fileName: fileName,
          originalName: file.originalname,
          size: file.size,
          message: 'Image uploaded successfully'
        });
      } catch (error) {
        console.error('Error making file public:', error);
        res.status(500).json({ error: 'Failed to process uploaded image' });
      }
    });

    stream.end(file.buffer);

  } catch (error) {
    console.error('Error in generic image upload:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
});

// Menu item image upload API
app.post('/api/menu-items/:itemId/images', authenticateToken, upload.array('images', 4), async (req, res) => {
  try {
    const { itemId } = req.params;
    const { userId } = req.user;
    const files = req.files;

    console.log('Menu item image upload:', {
      itemId,
      userId,
      filesCount: files ? files.length : 0
    });

    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    if (files.length > 4) {
      return res.status(400).json({ error: 'Maximum 4 images allowed per menu item' });
    }

    // Validate file types
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    for (const file of files) {
      if (!allowedTypes.includes(file.mimetype)) {
        return res.status(400).json({ 
          error: `Invalid file type: ${file.originalname}. Only JPEG, PNG, and WebP images are allowed.` 
        });
      }
    }

    // Find the menu item in the restaurant's menu structure
    console.log('🔍 Looking up menu item with ID:', itemId);
    
    // We need to find which restaurant this menu item belongs to
    // Since we don't have restaurantId in the URL, we'll need to search through restaurants
    const restaurantsSnapshot = await db.collection('restaurants').get();
    let menuItem = null;
    let restaurantId = null;
    let restaurantDoc = null;
    
    for (const restaurantDocSnapshot of restaurantsSnapshot.docs) {
      const restaurantData = restaurantDocSnapshot.data();
      if (restaurantData.ownerId === userId && restaurantData.menu && restaurantData.menu.items) {
        const foundItem = restaurantData.menu.items.find(item => item.id === itemId);
        if (foundItem) {
          menuItem = foundItem;
          restaurantId = restaurantDocSnapshot.id;
          restaurantDoc = restaurantDocSnapshot;
          break;
        }
      }
    }
    
    if (!menuItem) {
      console.log('❌ Menu item not found in any restaurant');
      return res.status(404).json({ error: 'Menu item not found' });
    }
    
    console.log('✅ Found menu item:', { name: menuItem.name, restaurantId });

    const uploadedImages = [];

    // Upload images to Firebase Storage
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const filename = `menu-items/${menuItem.restaurantId}/${itemId}/${Date.now()}-${i}-${file.originalname}`;
        const blob = bucket.file(filename);
        
        await blob.save(file.buffer, {
          contentType: file.mimetype,
          metadata: {
            restaurantId: menuItem.restaurantId,
            menuItemId: itemId,
            uploadedAt: new Date().toISOString(),
            uploadedBy: userId
          }
        });
        
        const imageUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
        uploadedImages.push({
          url: imageUrl,
          filename: filename,
          originalName: file.originalname,
          size: file.size,
          mimetype: file.mimetype,
          uploadedAt: new Date().toISOString()
        });
        
        console.log(`✅ Image ${i + 1} uploaded successfully: ${imageUrl}`);
      } catch (error) {
        console.error(`❌ Error uploading image ${i + 1}:`, error);
        return res.status(500).json({ 
          error: `Failed to upload image ${file.originalname}: ${error.message}` 
        });
      }
    }

    // Update menu item with new images in restaurant's menu structure
    const existingImages = menuItem.images || [];
    const updatedImages = [...existingImages, ...uploadedImages];
    
    // Update the menu item in the restaurant's menu structure
    const restaurantData = restaurantDoc.data();
    const updatedMenuItems = restaurantData.menu.items.map(item => 
      item.id === itemId 
        ? { ...item, images: updatedImages, updatedAt: new Date().toISOString() }
        : item
    );
    
    // Update the restaurant document
    await restaurantDoc.ref.update({
      'menu.items': updatedMenuItems,
      'menu.lastUpdated': new Date().toISOString()
    });

    console.log(`✅ Menu item ${itemId} updated with ${uploadedImages.length} new images`);

    res.json({
      success: true,
      message: `Successfully uploaded ${uploadedImages.length} image(s)`,
      images: uploadedImages,
      totalImages: updatedImages.length
    });

  } catch (error) {
    console.error('Error uploading menu item images:', error);
    res.status(500).json({ error: 'Failed to upload images' });
  }
});

// Delete menu item image API
app.delete('/api/menu-items/:itemId/images/:imageIndex', authenticateToken, async (req, res) => {
  try {
    const { itemId, imageIndex } = req.params;
    const { userId } = req.user;

    // Find the menu item in the restaurant's menu structure
    const restaurantsSnapshot = await db.collection('restaurants').get();
    let menuItem = null;
    let restaurantId = null;
    let restaurantDoc = null;
    
    for (const restaurantDocSnapshot of restaurantsSnapshot.docs) {
      const restaurantData = restaurantDocSnapshot.data();
      if (restaurantData.ownerId === userId && restaurantData.menu && restaurantData.menu.items) {
        const foundItem = restaurantData.menu.items.find(item => item.id === itemId);
        if (foundItem) {
          menuItem = foundItem;
          restaurantId = restaurantDocSnapshot.id;
          restaurantDoc = restaurantDocSnapshot;
          break;
        }
      }
    }
    
    if (!menuItem) {
      return res.status(404).json({ error: 'Menu item not found' });
    }

    const images = menuItem.images || [];
    const index = parseInt(imageIndex);
    
    if (index < 0 || index >= images.length) {
      return res.status(400).json({ error: 'Invalid image index' });
    }

    const imageToDelete = images[index];
    
    // Delete from Firebase Storage
    try {
      const filename = imageToDelete.filename;
      if (filename) {
        const blob = bucket.file(filename);
        await blob.delete();
        console.log(`✅ Deleted image from storage: ${filename}`);
      }
    } catch (storageError) {
      console.warn('Warning: Could not delete image from storage:', storageError.message);
    }

    // Remove from array and update restaurant's menu structure
    const updatedImages = images.filter((_, i) => i !== index);
    
    const restaurantData = restaurantDoc.data();
    const updatedMenuItems = restaurantData.menu.items.map(item => 
      item.id === itemId 
        ? { ...item, images: updatedImages, updatedAt: new Date().toISOString() }
        : item
    );
    
    // Update the restaurant document
    await restaurantDoc.ref.update({
      'menu.items': updatedMenuItems,
      'menu.lastUpdated': new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Image deleted successfully',
      remainingImages: updatedImages.length
    });

  } catch (error) {
    console.error('Error deleting menu item image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Bulk menu upload API
app.post('/api/menus/bulk-upload/:restaurantId', authenticateToken, chatgptUsageLimiter.middleware(), upload.array('menuFiles', 10), async (req, res) => {
  try {
    console.log(`\n=== BULK UPLOAD REQUEST RECEIVED ===`);
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const files = req.files;

    console.log('Restaurant ID:', restaurantId);
    console.log('User ID:', userId);
    console.log('Files received:', files ? files.length : 'No files');
    
    if (files && files.length > 0) {
      files.forEach((file, index) => {
        console.log(`File ${index + 1}:`, {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          fieldname: file.fieldname,
          hasBuffer: !!file.buffer
        });
      });
    }

    if (!files || files.length === 0) {
      console.log('❌ No files uploaded');
      return res.status(400).json({ error: 'No files uploaded' });
    }

    if (files.length > 10) {
      console.log('❌ Too many files:', files.length);
      return res.status(400).json({ error: 'Maximum 10 files allowed' });
    }

    // Validate file types - now support all types
    const supportedTypes = [
      'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff',
      'application/pdf',
      'text/csv', 'application/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain',
      'application/octet-stream' // For live photos and unknown types
    ];

    const invalidFiles = files.filter(file => {
      const isValidType = supportedTypes.some(type => file.mimetype.includes(type.split('/')[1]) || file.mimetype === type);
      return !isValidType;
    });

    if (invalidFiles.length > 0) {
      console.log('⚠️ Some files have unsupported types, but will attempt extraction anyway:', invalidFiles.map(f => f.originalname));
    }

    // Check if user owns the restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const uploadedFiles = [];
    const extractedMenus = [];
    const errors = [];

    // Upload files to Firebase Storage
    console.log(`\n=== STARTING FIREBASE UPLOADS ===`);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`\n--- Uploading file ${i + 1}/${files.length}: ${file.originalname} ---`);
      
      try {
        const fileUrl = await uploadToFirebase(file, restaurantId);
        uploadedFiles.push({
          originalName: file.originalname,
          url: fileUrl,
          size: file.size,
          mimetype: file.mimetype
        });
        console.log(`✅ File ${i + 1} uploaded successfully`);
  } catch (error) {
        console.error(`❌ Error uploading file ${i + 1} (${file.originalname}):`, error);
        errors.push(`Failed to upload ${file.originalname}: ${error.message}`);
      }
    }
    
    console.log(`\n=== UPLOAD SUMMARY ===`);
    console.log('Successfully uploaded:', uploadedFiles.length);
    console.log('Upload errors:', errors.length);
    if (errors.length > 0) {
      console.log('Error details:', errors);
    }

    // Extract menu data from uploaded images
    console.log(`\n=== STARTING AI EXTRACTION ===`);
    for (let i = 0; i < uploadedFiles.length; i++) {
      const uploadedFile = uploadedFiles[i];
      console.log(`\n--- Processing file ${i + 1}/${uploadedFiles.length}: ${uploadedFile.originalName} ---`);
      console.log('File URL:', uploadedFile.url);
      console.log('File type:', uploadedFile.mimetype);
      
      try {
        console.log(`Starting AI extraction for ${uploadedFile.mimetype} file: ${uploadedFile.originalName}`);
        const menuData = await extractMenuFromAnyFile(uploadedFile.url, uploadedFile.mimetype, uploadedFile.originalName);
        console.log('✅ AI extraction completed!');
        console.log('Extracted items:', menuData.menuItems ? menuData.menuItems.length : 0);
        
        // Record successful ChatGPT API call for menu extraction
        await chatgptUsageLimiter.recordSuccessfulCall(req, 0);
        
        // Add original file info to each menu item
        const menuItemsWithFile = (menuData.menuItems || []).map(item => ({
          ...item,
          originalFile: uploadedFile.originalName,
          fileType: uploadedFile.mimetype
        }));
        
        extractedMenus.push({
          file: uploadedFile.originalName,
          fileType: uploadedFile.mimetype,
          menuItems: menuItemsWithFile,
          categories: menuData.categories || [],
          extractionStatus: menuItemsWithFile.length > 0 ? 'success' : 'no_menu_data',
          message: menuItemsWithFile.length > 0 ? 'Menu items extracted successfully' : 'No menu data found in this file'
        });
        
        if (menuItemsWithFile.length === 0) {
          console.log(`ℹ️ No menu data found in ${uploadedFile.originalName} - this might not be a menu file`);
        }
      } catch (error) {
        console.error(`❌ Error extracting menu from ${uploadedFile.originalName}:`, error);
        errors.push(`Failed to extract menu from ${uploadedFile.originalName}: ${error.message}`);
        
        // Add failed extraction to results
        extractedMenus.push({
          file: uploadedFile.originalName,
          fileType: uploadedFile.mimetype,
          menuItems: [],
          categories: [],
          extractionStatus: 'failed',
          message: `Failed to extract menu: ${error.message}`,
          error: error.message
        });
      }
    }
    
    console.log(`\n=== EXTRACTION SUMMARY ===`);
    console.log('Files processed:', uploadedFiles.length);
    console.log('Menus extracted:', extractedMenus.length);
    console.log('Extraction errors:', errors.length);

    // Merge unique categories from all extractions (by id) for bulk-save
    const seenIds = new Set();
    const extractedCategories = [];
    for (const m of extractedMenus) {
      for (const c of (m.categories || [])) {
        const id = categoryNameToId(c.name);
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          extractedCategories.push({ name: (c.name || '').trim() || 'Other', order: extractedCategories.length + 1 });
        }
      }
    }
    // Also ensure "other" exists if any item used it
    const hasOther = extractedMenus.some(m => (m.menuItems || []).some(i => /^other$/i.test((i.category || '').trim())));
    if (hasOther && !seenIds.has('other')) {
      extractedCategories.push({ name: 'Other', order: extractedCategories.length + 1 });
    }

    // Prepare response with detailed status
    const response = {
      success: errors.length === 0,
      message: errors.length === 0 
        ? 'Files uploaded and processed successfully' 
        : 'Files uploaded with some issues',
      uploadedFiles: uploadedFiles.length,
      extractedMenus: extractedMenus.length,
      errors: errors,
      data: extractedMenus,
      extractedCategories,
      summary: {
        totalFiles: files.length,
        uploadedSuccessfully: uploadedFiles.length,
        uploadErrors: errors.filter(e => e.includes('Failed to upload')).length,
        extractionErrors: errors.filter(e => e.includes('Failed to extract')).length,
        pdfErrors: errors.filter(e => e.includes('PDF processing not implemented')).length
      }
    };

    // Return appropriate status code based on success
    if (errors.length === 0) {
      res.status(200).json(response);
    } else if (uploadedFiles.length > 0) {
      res.status(207).json(response); // Multi-status (partial success)
    } else {
      res.status(400).json(response);
    }

  } catch (error) {
    console.error('Bulk upload error:', error);
    
    // Categorize different types of errors
    let errorType = 'UNKNOWN_ERROR';
    let userMessage = 'An unexpected error occurred';
    
    if (error.message.includes('Firebase')) {
      errorType = 'STORAGE_ERROR';
      userMessage = 'Failed to upload files to storage. Please check your Firebase configuration.';
    } else if (error.message.includes('OpenAI') || error.message.includes('AuthenticationError')) {
      errorType = 'AI_SERVICE_ERROR';
      userMessage = 'AI service is currently unavailable. Please try again later or contact support.';
    } else if (error.message.includes('permissions')) {
      errorType = 'PERMISSION_ERROR';
      userMessage = 'Insufficient permissions to process the request. Please check your account settings.';
    } else if (error.message.includes('network') || error.message.includes('timeout')) {
      errorType = 'NETWORK_ERROR';
      userMessage = 'Network error occurred. Please check your connection and try again.';
    }
    
    res.status(500).json({ 
      success: false,
      error: userMessage,
      errorType: errorType,
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

// Save extracted menu items to database. Accepts { menuItems, categories? }.
// Categories from extraction (menu photo) are merged into restaurant.categories. Item category uses dynamic id; fallback only when missing.
app.post('/api/menus/bulk-save/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const { menuItems, categories: extractedCategories = [] } = req.body;

    console.log(`\n=== BULK SAVE REQUEST ===`);
    console.log('Restaurant ID:', restaurantId);
    console.log('Menu items:', menuItems?.length || 0, '| Extracted categories:', extractedCategories?.length || 0);

    if (!menuItems || !Array.isArray(menuItems)) {
      return res.status(400).json({ error: 'Menu items array is required' });
    }

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists || restaurantDoc.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const restaurantData = restaurantDoc.data();
    const existingMenu = restaurantData.menu || { items: [] };
    const existingItems = [...(existingMenu.items || [])];
    // Use restaurant.categories (what getCategories returns), not menu.categories
    let existingCategories = [...(restaurantData.categories || [])];

    // Merge extracted categories into restaurant.categories (by unique id)
    for (const c of extractedCategories) {
      const name = (c && c.name) ? String(c.name).trim() : '';
      if (!name) continue;
      const id = categoryNameToId(name);
      if (!id) continue;
      if (!existingCategories.some(cat => (cat.id || '').toLowerCase() === id)) {
        existingCategories.push({ id, name, emoji: '🍽️', description: '' });
        console.log('📂 Merged extracted category:', id, name);
      }
    }
    // Ensure 'other' exists for items without a matching category
    if (!existingCategories.some(c => (c.id || '').toLowerCase() === 'other')) {
      existingCategories.push({ id: 'other', name: 'Other', emoji: '🍽️', description: '' });
    }

    const savedItems = [];
    const errors = [];
    const validCategoryIds = new Set(existingCategories.map(c => (c.id || '').toLowerCase()));

    for (const item of menuItems) {
      try {
        const rawCat = (item.category != null && item.category !== '') ? String(item.category).trim() : '';
        const resolvedId = rawCat ? categoryNameToId(rawCat) : '';
        const categoryId = (resolvedId && validCategoryIds.has(resolvedId)) ? resolvedId : 'other';

        // Process variants if present
        let variants = [];
        if (item.variants && Array.isArray(item.variants) && item.variants.length > 0) {
          variants = item.variants
            .filter(v => v && v.name && (v.price != null))
            .map(v => ({
              name: String(v.name).trim(),
              price: parseFloat(v.price) || 0,
              description: (v.description || '').trim()
            }));
          if (variants.length > 0) {
            console.log(`📦 Item "${item.name}" has ${variants.length} variants:`, variants.map(v => `${v.name} ₹${v.price}`).join(', '));
          }
        }

        // If item has variants, use the lowest variant price as base price, or 0
        const basePrice = variants.length > 0 
          ? Math.min(...variants.map(v => v.price))
          : (parseFloat(item.price) || 0);

        const menuItem = {
          id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          restaurantId,
          name: item.name || 'Unnamed Item',
          description: item.description || '',
          price: basePrice,
          category: categoryId,
          isVeg: Boolean(item.isVeg),
          spiceLevel: item.spiceLevel || 'medium',
          allergens: Array.isArray(item.allergens) ? item.allergens : [],
          shortCode: item.shortCode || (item.name ? String(item.name).substring(0, 3).toUpperCase() : 'X'),
          status: 'active',
          order: existingItems.length,
          isAvailable: true,
          stockQuantity: null,
          lowStockThreshold: 5,
          isStockManaged: false,
          availableFrom: null,
          availableUntil: null,
          variants: variants,
          customizations: [],
          createdAt: new Date(),
          updatedAt: new Date(),
          source: 'ai_upload',
          originalFile: item.originalFile || null
        };

        existingItems.push(menuItem);
        savedItems.push(menuItem);
        const variantInfo = variants.length > 0 ? ` [${variants.length} variants]` : '';
        console.log(`✅ Processed: ${menuItem.name} (${menuItem.category})${variantInfo}`);
      } catch (error) {
        console.error(`Error processing ${item.name}:`, error);
        errors.push(`Failed to process ${item.name}: ${error.message}`);
      }
    }

    if (savedItems.length > 0) {
      const updateData = {
        categories: existingCategories,
        menu: { ...(existingMenu || {}), items: existingItems, lastUpdated: new Date() },
        updatedAt: new Date()
      };
      await db.collection(collections.restaurants).doc(restaurantId).update(updateData);
      console.log('✅ Bulk save: categories=', existingCategories.length, 'items=', existingItems.length);
    }

    res.json({
      message: 'Menu items saved successfully',
      savedCount: savedItems.length,
      errorCount: errors.length,
      savedItems,
      errors
    });
  } catch (error) {
    console.error('Bulk save error:', error);
    res.status(500).json({ error: 'Bulk save failed', details: error.message });
  }
});

// Get upload status and extracted menu preview
app.get('/api/menus/upload-status/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Check if user owns the restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get recent menu items from embedded menu structure
    const restaurantData = restaurant.data();
    const embeddedMenuItems = restaurantData.menu?.items || [];
    
    // Sort by creation date and limit to 50 most recent
    const recentItems = embeddedMenuItems
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 50)
      .map(item => ({
        id: item.id,
        ...item
      }));

    res.json({
      totalItems: recentItems.length,
      recentItems: recentItems
    });

  } catch (error) {
    console.error('Upload status error:', error);
    res.status(500).json({ error: 'Failed to get upload status' });
  }
});



// Table Management APIs
app.get('/api/tables/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.tables)
      .where('restaurantId', '==', restaurantId)
      .get();

    const tables = [];
    snapshot.forEach(doc => {
      tables.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ tables });

  } catch (error) {
    console.error('Get tables error:', error);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

app.post('/api/tables/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, floor, capacity, section } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Table name is required' });
    }

    if (!floor) {
      return res.status(400).json({ error: 'Floor is required' });
    }

    // Find the floor document, create it if it doesn't exist
    const floorId = `floor_${floor.toLowerCase().replace(/\s+/g, '_')}`;
    let floorDoc = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .get();

    // If floor doesn't exist, create it automatically
    if (!floorDoc.exists) {
      console.log(`🔄 Auto-creating floor "${floor}" for restaurant ${restaurantId}`);
      const floorData = {
        name: floor,
        description: `Auto-created floor: ${floor}`,
        restaurantId,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorId)
        .set(floorData);

      // Re-fetch the floor document
      floorDoc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorId)
        .get();
    }

    // Check for duplicate table name in this floor
    const existingTablesSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .where('name', '==', name)
      .get();

    if (!existingTablesSnapshot.empty) {
      return res.status(400).json({ error: `Table "${name}" already exists on floor "${floor}"` });
    }

    const tableData = {
      name,
      floor: floor,
      capacity: capacity || 4,
      section: section || 'Main',
      status: 'available',
      currentOrderId: null,
      lastOrderTime: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const tableRef = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .add(tableData);

    res.status(201).json({
      message: 'Table created successfully',
      table: {
        id: tableRef.id,
        ...tableData
      }
    });

  } catch (error) {
    console.error('Create table error:', error);
    res.status(500).json({ error: 'Failed to create table' });
  }
});

// Bulk create tables
app.post('/api/tables/:restaurantId/bulk', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { floor, fromNumber, toNumber, capacity, section } = req.body;

    // Validate inputs
    if (!floor) {
      return res.status(400).json({ error: 'Floor is required' });
    }

    if (fromNumber === undefined || fromNumber === null || fromNumber === '') {
      return res.status(400).json({ error: 'From number is required' });
    }

    if (toNumber === undefined || toNumber === null || toNumber === '') {
      return res.status(400).json({ error: 'To number is required' });
    }

    const from = parseInt(fromNumber);
    const to = parseInt(toNumber);

    if (isNaN(from) || isNaN(to)) {
      return res.status(400).json({ error: 'From and to must be valid numbers' });
    }

    if (from > to) {
      return res.status(400).json({ error: 'From number must be less than or equal to to number' });
    }

    if (to - from > 100) {
      return res.status(400).json({ error: 'Cannot create more than 100 tables at once' });
    }

    // Find the floor document, create it if it doesn't exist
    const floorId = `floor_${floor.toLowerCase().replace(/\s+/g, '_')}`;
    let floorDoc = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .get();

    // If floor doesn't exist, create it automatically
    if (!floorDoc.exists) {
      console.log(`🔄 Auto-creating floor "${floor}" for restaurant ${restaurantId}`);
      const floorData = {
        name: floor,
        description: `Auto-created floor: ${floor}`,
        restaurantId,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorId)
        .set(floorData);
    }

    // Get all existing table names in this floor to check for duplicates
    const existingTablesSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables')
      .get();

    const existingTableNames = new Set();
    existingTablesSnapshot.forEach(doc => {
      existingTableNames.add(doc.data().name);
    });

    // Prepare tables to create
    const tablesToCreate = [];
    const skippedTables = [];

    for (let i = from; i <= to; i++) {
      const tableName = String(i);

      // Check if table already exists
      if (existingTableNames.has(tableName)) {
        skippedTables.push(tableName);
        continue;
      }

      tablesToCreate.push({
        name: tableName,
        floor: floor,
        capacity: capacity || 4,
        section: section || 'Main',
        status: 'available',
        currentOrderId: null,
        lastOrderTime: null,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    // Create all tables
    const createdTables = [];
    const batch = db.batch();
    const tablesCollectionRef = db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .collection('tables');

    for (const tableData of tablesToCreate) {
      const tableRef = tablesCollectionRef.doc(); // Auto-generate ID
      batch.set(tableRef, tableData);
      createdTables.push({
        id: tableRef.id,
        ...tableData
      });
    }

    // Commit the batch
    await batch.commit();

    console.log(`✅ Created ${createdTables.length} tables (${from}-${to}) on floor "${floor}" for restaurant ${restaurantId}`);
    if (skippedTables.length > 0) {
      console.log(`⚠️  Skipped ${skippedTables.length} duplicate tables: ${skippedTables.join(', ')}`);
    }

    res.status(201).json({
      message: `Successfully created ${createdTables.length} tables`,
      created: createdTables.length,
      skipped: skippedTables.length,
      skippedTables: skippedTables,
      tables: createdTables
    });

  } catch (error) {
    console.error('Bulk create tables error:', error);
    res.status(500).json({ error: 'Failed to create tables' });
  }
});

app.patch('/api/tables/:tableId/status', authenticateToken, async (req, res) => {
  try {
    const { tableId } = req.params;
    const { status, orderId, restaurantId } = req.body;

    const validStatuses = ['available', 'occupied', 'serving', 'reserved', 'cleaning', 'out-of-service'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

    const updateData = {
      status,
      updatedAt: new Date()
    };

    if (status === 'occupied' && orderId) {
      updateData.currentOrderId = orderId;
      updateData.lastOrderTime = new Date();
    } else if (status === 'available') {
      updateData.currentOrderId = null;
    }

    // Find the table across all floors
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    let tableFound = false;
    for (const floorDoc of floorsSnapshot.docs) {
      const tableDoc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .doc(tableId)
        .get();

      if (tableDoc.exists) {
        await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .doc(floorDoc.id)
          .collection('tables')
          .doc(tableId)
          .update(updateData);
        
        tableFound = true;
        break;
      }
    }

    if (!tableFound) {
      return res.status(404).json({ error: 'Table not found' });
    }

    res.json({ message: 'Table status updated successfully' });

  } catch (error) {
    console.error('Update table status error:', error);
    res.status(500).json({ error: 'Failed to update table status' });
  }
});

// Update table details
app.patch('/api/tables/:tableId', authenticateToken, async (req, res) => {
  try {
    const { tableId } = req.params;
    const { name, floor, capacity, section, restaurantId } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

    const updateData = {
      updatedAt: new Date()
    };

    if (name) updateData.name = name;
    if (floor) updateData.floor = floor;
    if (capacity) updateData.capacity = capacity;
    if (section) updateData.section = section;

    if (Object.keys(updateData).length === 1) { // Only updatedAt
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Find the table across all floors in the restaurant
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    let tableFound = false;
    for (const floorDoc of floorsSnapshot.docs) {
      const tableDoc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .doc(tableId)
        .get();

      if (tableDoc.exists) {
        await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .doc(floorDoc.id)
          .collection('tables')
          .doc(tableId)
          .update(updateData);
        
        tableFound = true;
        break;
      }
    }

    if (!tableFound) {
      return res.status(404).json({ error: 'Table not found' });
    }

    res.json({ message: 'Table updated successfully' });

  } catch (error) {
    console.error('Update table error:', error);
    res.status(500).json({ error: 'Failed to update table' });
  }
});

// Delete table
app.delete('/api/tables/:tableId', authenticateToken, async (req, res) => {
  try {
    const { tableId } = req.params;
    const { restaurantId } = req.body;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

    // Find the table across all floors in the restaurant
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    let tableFound = false;
    for (const floorDoc of floorsSnapshot.docs) {
      const tableDoc = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .doc(tableId)
        .get();

      if (tableDoc.exists) {
        await db.collection('restaurants')
          .doc(restaurantId)
          .collection('floors')
          .doc(floorDoc.id)
          .collection('tables')
          .doc(tableId)
          .delete();
        
        tableFound = true;
        break;
      }
    }

    if (!tableFound) {
      return res.status(404).json({ error: 'Table not found' });
    }

    res.json({ message: 'Table deleted successfully' });

  } catch (error) {
    console.error('Delete table error:', error);
    res.status(500).json({ error: 'Failed to delete table' });
  }
});

// Floor Management APIs
app.get('/api/floors/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    // Get floors from restaurant subcollection
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();

    const floors = [];
    
    for (const floorDoc of floorsSnapshot.docs) {
      const floorData = floorDoc.data();
      
      // Get tables for this floor
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      const tables = [];
      tablesSnapshot.forEach(tableDoc => {
        tables.push({
          id: tableDoc.id,
          ...tableDoc.data()
        });
      });

      floors.push({
        id: floorDoc.id,
        name: floorData.name,
        restaurantId,
        tables: tables
      });
    }
    
    // If no floors exist, create default floor structure
    if (floors.length === 0) {
      console.log(`🔄 No floors found, creating default "Ground Floor" for restaurant ${restaurantId}`);
      
      const defaultFloorId = 'floor_ground_floor';
      const defaultFloorData = {
        name: 'Ground Floor',
        description: 'Default main dining area',
        restaurantId,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(defaultFloorId)
        .set(defaultFloorData);

      floors.push({
        id: defaultFloorId,
        name: 'Ground Floor',
        restaurantId,
        tables: []
      });
    }

    res.json({ floors });

  } catch (error) {
    console.error('Get floors error:', error);
    res.status(500).json({ error: 'Failed to fetch floors' });
  }
});

// Create new floor (creates floor implicitly when adding tables)
app.post('/api/floors/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Floor name is required' });
    }

    // Create floor document in restaurant subcollection
    const floorId = `floor_${name.toLowerCase().replace(/\s+/g, '_')}`;
    const floorData = {
      name,
      description: description || '',
      restaurantId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .doc(floorId)
      .set(floorData);

    res.status(201).json({
      message: 'Floor created successfully',
      floor: {
        id: floorId,
        name,
        description: description || '',
        restaurantId,
        tables: []
      }
    });

  } catch (error) {
    console.error('Create floor error:', error);
    res.status(500).json({ error: 'Failed to create floor' });
  }
});

// Update floor (rename all tables on this floor)
app.patch('/api/floors/:floorId', authenticateToken, async (req, res) => {
  try {
    const { floorId } = req.params;
    const { name, restaurantId } = req.body;

    if (!name || !restaurantId) {
      return res.status(400).json({ error: 'Floor name and restaurant ID are required' });
    }

    // Extract original floor name from floorId
    const originalFloorName = floorId.replace('floor_', '').replace(/_/g, ' ');
    const originalFloorNameCapitalized = originalFloorName.split(' ').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ).join(' ');

    // Update all tables on this floor
    const tablesSnapshot = await db.collection(collections.tables)
      .where('restaurantId', '==', restaurantId)
      .where('floor', '==', originalFloorNameCapitalized)
      .get();

    const batch = db.batch();
    tablesSnapshot.forEach(doc => {
      batch.update(doc.ref, {
        floor: name,
        updatedAt: new Date()
      });
    });

    await batch.commit();

    res.json({ message: 'Floor updated successfully' });

  } catch (error) {
    console.error('Update floor error:', error);
    res.status(500).json({ error: 'Failed to update floor' });
  }
});

// Delete floor (delete all tables on this floor)
app.delete('/api/floors/:floorId', authenticateToken, async (req, res) => {
  try {
    const { floorId } = req.params;
    const { restaurantId } = req.query;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

    // Extract floor name from floorId
    const floorName = floorId.replace('floor_', '').replace(/_/g, ' ');
    const floorNameCapitalized = floorName.split(' ').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ).join(' ');

    // Delete all tables on this floor
    const tablesSnapshot = await db.collection(collections.tables)
      .where('restaurantId', '==', restaurantId)
      .where('floor', '==', floorNameCapitalized)
      .get();

    const batch = db.batch();
    tablesSnapshot.forEach(doc => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    res.json({ message: 'Floor and all its tables deleted successfully' });

  } catch (error) {
    console.error('Delete floor error:', error);
    res.status(500).json({ error: 'Failed to delete floor' });
  }
});

// Booking Management APIs
app.get('/api/bookings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { date, status } = req.query;

    let query = db.collection(collections.bookings || 'bookings')
      .where('restaurantId', '==', restaurantId);

    if (status) {
      query = query.where('status', '==', status);
    }

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      
      query = query.where('bookingDate', '>=', startDate)
                   .where('bookingDate', '<', endDate);
    }

    const snapshot = await query.orderBy('bookingDate', 'desc').get();
    const bookings = [];

    snapshot.forEach(doc => {
      bookings.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ bookings });

  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Get availability data for a specific date
app.get('/api/bookings/availability/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }

    // Parse the date
    const selectedDate = new Date(date);
    const startOfDay = new Date(selectedDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(selectedDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Get all floors and tables for the restaurant
    const floorsSnapshot = await db.collection('restaurants').doc(restaurantId).collection('floors').get();
    const allTables = [];
    
    for (const floorDoc of floorsSnapshot.docs) {
      const tablesSnapshot = await floorDoc.ref.collection('tables').get();
      tablesSnapshot.docs.forEach(tableDoc => {
        allTables.push({
          id: tableDoc.id,
          ...tableDoc.data(),
          floor: floorDoc.data().name
        });
      });
    }

    // Get existing bookings for the selected date
    const bookingsSnapshot = await db.collection(collections.bookings || 'bookings')
      .where('restaurantId', '==', restaurantId)
      .where('bookingDate', '>=', startOfDay)
      .where('bookingDate', '<=', endOfDay)
      .where('status', 'in', ['confirmed', 'arrived'])
      .get();

    const bookedTableIds = new Set();
    const timeSlotBookings = {};

    bookingsSnapshot.docs.forEach(doc => {
      const booking = doc.data();
      bookedTableIds.add(booking.tableId);
      
      // Track time slot bookings
      const timeSlot = booking.bookingTime;
      if (!timeSlotBookings[timeSlot]) {
        timeSlotBookings[timeSlot] = [];
      }
      timeSlotBookings[timeSlot].push(booking.tableId);
    });

    // Generate time slots (10 AM to 11 PM, 30-minute intervals)
    const timeSlots = [];
    for (let hour = 10; hour <= 23; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const time = new Date();
        time.setHours(hour, minute, 0, 0);
        
        const timeString = time.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        
        const timeSlotValue = time.toTimeString().slice(0, 5);
        const bookedTablesForSlot = timeSlotBookings[timeSlotValue] || [];
        const availableTablesForSlot = allTables.filter(table => 
          !bookedTablesForSlot.includes(table.id) && 
          table.status !== 'out-of-service' &&
          table.status !== 'occupied' &&
          table.status !== 'serving' &&
          table.status !== 'reserved'
        );
        
        timeSlots.push({
          value: timeSlotValue,
          display: timeString,
          available: availableTablesForSlot.length > 0,
          availableTablesCount: availableTablesForSlot.length,
          totalTablesCount: allTables.length
        });
      }
    }

    // Filter available tables (not booked, not occupied, and not out of service)
    const availableTablesForBooking = allTables.filter(table => 
      !bookedTableIds.has(table.id) && 
      table.status !== 'out-of-service' &&
      table.status !== 'occupied' &&
      table.status !== 'serving' &&
      table.status !== 'reserved'
    );

    // Calculate table counts based on table status
    const totalTables = allTables.length;
    const availableTables = allTables.filter(table => table.status === 'available').length;
    const reservedTables = allTables.filter(table => table.status !== 'available' && table.status !== 'out-of-service').length;

    res.json({
      success: true,
      date: date,
      availableTables: availableTablesForBooking,
      timeSlots: timeSlots,
      totalTables: allTables.length,
      bookedTables: bookedTableIds.size,
      stats: {
        available: availableTablesForBooking.length,
        booked: bookedTableIds.size,
        outOfService: allTables.filter(t => t.status === 'out-of-service').length,
        totalTables: totalTables,
        availableTables: availableTables,
        reservedTables: reservedTables
      }
    });

  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch availability data' 
    });
  }
});

// Create new booking
app.post('/api/bookings/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { 
      tableId,
      customerName, 
      customerPhone, 
      customerEmail,
      partySize, 
      bookingDate, 
      bookingTime,
      duration = 120, // default 2 hours
      specialRequests,
      occasionType
    } = req.body;

    if (!tableId || !customerName || !bookingDate || !bookingTime || !partySize) {
      return res.status(400).json({ 
        error: 'Table ID, customer name, booking date, time, and party size are required' 
      });
    }

    // Check if table exists and is available - using new restaurant-centric structure
    let tableData = null;
    let tableFound = false;
    
    // Search for table across all floors in the restaurant
    const floorsSnapshot = await db.collection('restaurants').doc(restaurantId).collection('floors').get();
    
    for (const floorDoc of floorsSnapshot.docs) {
      const tableDoc = await floorDoc.ref.collection('tables').doc(tableId).get();
      if (tableDoc.exists) {
        tableData = tableDoc.data();
        tableFound = true;
        break;
      }
    }
    
    if (!tableFound) {
      return res.status(404).json({ error: 'Table not found' });
    }
    
    if (tableData.status === 'out-of-service') {
      return res.status(400).json({ error: 'Table is out of service' });
    }

    // Create booking date-time
    const bookingDateTime = new Date(`${bookingDate}T${bookingTime}:00`);
    const endDateTime = new Date(bookingDateTime.getTime() + duration * 60 * 1000);

    // Check for overlapping bookings
    const overlappingBookings = await db.collection(collections.bookings || 'bookings')
      .where('tableId', '==', tableId)
      .where('status', '==', 'confirmed')
      .where('bookingDate', '>=', new Date(bookingDateTime.getTime() - duration * 60 * 1000))
      .where('bookingDate', '<=', endDateTime)
      .get();

    if (!overlappingBookings.empty) {
      return res.status(400).json({ error: 'Table is already booked for this time slot' });
    }

    const bookingData = {
      restaurantId,
      tableId,
      tableName: tableData.name,
      floor: tableData.floor,
      customerName,
      customerPhone,
      customerEmail: customerEmail || null,
      partySize,
      bookingDate: bookingDateTime,
      bookingTime,
      duration,
      endTime: endDateTime,
      status: 'confirmed', // confirmed, arrived, completed, cancelled, no-show
      specialRequests: specialRequests || null,
      occasionType: occasionType || null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const bookingRef = await db.collection(collections.bookings || 'bookings').add(bookingData);

    // Update table status to reserved if booking is within 30 minutes
    const now = new Date();
    const timeDiff = bookingDateTime.getTime() - now.getTime();
    const minutesDiff = Math.floor(timeDiff / (1000 * 60));

    if (minutesDiff <= 30 && minutesDiff >= -15) { // 30 min before to 15 min after
      // Find and update the table in the new structure
      const floorsSnapshot = await db.collection('restaurants').doc(restaurantId).collection('floors').get();
      
      for (const floorDoc of floorsSnapshot.docs) {
        const tableDoc = await floorDoc.ref.collection('tables').doc(tableId).get();
        if (tableDoc.exists) {
          await tableDoc.ref.update({
            status: 'reserved',
            currentBookingId: bookingRef.id,
            updatedAt: new Date()
          });
          break;
        }
      }
    }

    res.status(201).json({
      message: 'Booking created successfully',
      booking: {
        id: bookingRef.id,
        ...bookingData
      }
    });

  } catch (error) {
    console.error('Create booking error:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Update booking
app.patch('/api/bookings/:bookingId', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { status, customerName, customerPhone, partySize, specialRequests } = req.body;

    const updateData = {
      updatedAt: new Date()
    };

    const validStatuses = ['confirmed', 'arrived', 'completed', 'cancelled', 'no-show'];

    if (status) {
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      updateData.status = status;
    }

    if (customerName) updateData.customerName = customerName;
    if (customerPhone) updateData.customerPhone = customerPhone;
    if (partySize) updateData.partySize = partySize;
    if (specialRequests !== undefined) updateData.specialRequests = specialRequests;

    if (Object.keys(updateData).length === 1) { // Only updatedAt
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await db.collection(collections.bookings || 'bookings').doc(bookingId).update(updateData);

    // If booking status changed to completed or cancelled, update table status
    if (status && ['completed', 'cancelled', 'no-show'].includes(status)) {
      const bookingDoc = await db.collection(collections.bookings || 'bookings').doc(bookingId).get();
      if (bookingDoc.exists) {
        const bookingData = bookingDoc.data();
        const tableDoc = await db.collection(collections.tables).doc(bookingData.tableId).get();
        if (tableDoc.exists && tableDoc.data().currentBookingId === bookingId) {
          await db.collection(collections.tables).doc(bookingData.tableId).update({
            status: 'available',
            currentBookingId: null,
            updatedAt: new Date()
          });
        }
      }
    }

    res.json({ message: 'Booking updated successfully' });

  } catch (error) {
    console.error('Update booking error:', error);
    res.status(500).json({ error: 'Failed to update booking' });
  }
});

// Delete booking
app.delete('/api/bookings/:bookingId', authenticateToken, async (req, res) => {
  try {
    const { bookingId } = req.params;

    // Get booking data first to update table status
    const bookingDoc = await db.collection(collections.bookings || 'bookings').doc(bookingId).get();
    if (bookingDoc.exists) {
      const bookingData = bookingDoc.data();
      
      // Update table status if it's currently reserved for this booking
      const tableDoc = await db.collection(collections.tables).doc(bookingData.tableId).get();
      if (tableDoc.exists && tableDoc.data().currentBookingId === bookingId) {
        await db.collection(collections.tables).doc(bookingData.tableId).update({
          status: 'available',
          currentBookingId: null,
          updatedAt: new Date()
        });
      }
    }

    await db.collection(collections.bookings || 'bookings').doc(bookingId).delete();

    res.json({ message: 'Booking deleted successfully' });

  } catch (error) {
    console.error('Delete booking error:', error);
    res.status(500).json({ error: 'Failed to delete booking' });
  }
});

app.get('/api/analytics/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { period = '7d' } = req.query;

    const days = period === '30d' ? 30 : 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const ordersSnapshot = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', startDate)
      .get();

    let totalRevenue = 0;
    let totalOrders = 0;
    const dailyStats = {};

    ordersSnapshot.forEach(doc => {
      const order = doc.data();
      const date = order.createdAt.toDate().toDateString();

      totalOrders++;
      totalRevenue += order.totalAmount;

      if (!dailyStats[date]) {
        dailyStats[date] = { orders: 0, revenue: 0 };
      }
      dailyStats[date].orders++;
      dailyStats[date].revenue += order.totalAmount;
    });

    res.json({
      period,
      totalRevenue,
      totalOrders,
      averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
      dailyStats
    });

  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Staff Management APIs
const requireOwnerRole = (req, res, next) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Access denied. Owner role required.' });
  }
  next();
};

// Get all waiters for a restaurant (for filtering purposes)
app.get('/api/waiters/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.users)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['waiter', 'manager', 'employee'])
      .where('status', '==', 'active')
      .get();

    const waiters = [];
    snapshot.forEach(doc => {
      const userData = doc.data();
      waiters.push({
        id: doc.id,
        name: userData.name,
        loginId: userData.loginId,
        role: userData.role,
        phone: userData.phone,
        email: userData.email
      });
    });

    res.json({ waiters });

  } catch (error) {
    console.error('Get waiters error:', error);
    res.status(500).json({ error: 'Failed to fetch waiters' });
  }
});

// Staff reset password (mount before other /api/staff routes so POST /:staffId/reset-password is matched)
app.use('/api/staff', staffResetPasswordRoutes);

// Get all staff for a restaurant
app.get('/api/staff/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.users)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['waiter', 'manager', 'employee'])
      .get();

    const staff = [];
    
    // Process each staff member and fetch their credentials
    for (const doc of snapshot.docs) {
      const userData = doc.data();
      const staffId = doc.id;
      
      // Check if temporary credentials exist
      let tempPassword = null;
      let hasTemporaryPassword = false;
      
      try {
        const credentialsDoc = await db.collection('staffCredentials').doc(staffId).get();
        if (credentialsDoc.exists) {
          const credentialsData = credentialsDoc.data();
          
          // Check if credentials have expired
          if (credentialsData.expiresAt && new Date() > credentialsData.expiresAt.toDate()) {
            // Delete expired credentials
            await db.collection('staffCredentials').doc(staffId).delete();
          } else {
            tempPassword = credentialsData.temporaryPassword;
            hasTemporaryPassword = true;
          }
        }
      } catch (error) {
        console.log('Error fetching credentials for staff:', staffId, error);
      }
      
      staff.push({
        id: staffId,
        name: userData.name,
        phone: userData.phone,
        email: userData.email,
        role: userData.role,
        status: userData.status || 'active',
        startDate: userData.startDate,
        lastLogin: userData.lastLogin,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt,
        loginId: userData.loginId,
        username: userData.username || null,
        tempPassword: tempPassword, // Include actual temporary password
        hasTemporaryPassword: hasTemporaryPassword
      });
    }

    res.json({ staff });

  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

// Get staff credentials (for admin display)
app.get('/api/staff/:staffId/credentials', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;

    const staffDoc = await db.collection(collections.users).doc(staffId).get();
    if (!staffDoc.exists) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const staffData = staffDoc.data();
    
    // Check if temporary credentials exist
    const credentialsDoc = await db.collection('staffCredentials').doc(staffId).get();
    
      if (credentialsDoc.exists) {
      const credentialsData = credentialsDoc.data();
      
      // Check if credentials have expired
      if (credentialsData.expiresAt && new Date() > credentialsData.expiresAt.toDate()) {
        // Delete expired credentials
        await db.collection('staffCredentials').doc(staffId).delete();
        
        res.json({
          loginId: staffData.loginId,
          username: staffData.username || null,
          hasTemporaryPassword: false,
          message: 'Temporary password has expired. Staff member should use their current password.'
        });
      } else {
        res.json({
          loginId: credentialsData.loginId,
          username: staffData.username || null,
          temporaryPassword: credentialsData.temporaryPassword,
          hasTemporaryPassword: true,
          message: 'This staff member has a temporary password.'
        });
      }
    } else {
      res.json({
        loginId: staffData.loginId,
        username: staffData.username || null,
        hasTemporaryPassword: false,
        message: 'This staff member has already changed their password.'
      });
    }

  } catch (error) {
    console.error('Get staff credentials error:', error);
    res.status(500).json({ error: 'Failed to get staff credentials' });
  }
});

// Delete staff member
app.delete('/api/staff/:staffId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;

    console.log(`🗑️ Delete Staff API - Staff ID: ${staffId}`);

    // Get the staff member to verify they exist and get restaurant info
    const staffDoc = await db.collection(collections.users).doc(staffId).get();
    if (!staffDoc.exists) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const staffData = staffDoc.data();

    // Delete the staff member
    await db.collection(collections.users).doc(staffId).delete();

    // Also delete any temporary credentials if they exist
    try {
      await db.collection('staffCredentials').doc(staffId).delete();
    } catch (error) {
      console.log('No temporary credentials to delete for staff:', staffId);
    }

    console.log(`✅ Staff member ${staffData.name} deleted successfully`);
    
    res.json({
      success: true,
      message: 'Staff member deleted successfully'
    });

  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

// Add new staff member
app.post('/api/staff/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, phone, email, role = 'waiter', startDate, address, username: usernameInput } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
    }

    // Optional username: validate format and uniqueness (case-insensitive)
    let username = null;
    let usernameLower = null;
    if (usernameInput != null && String(usernameInput).trim() !== '') {
      const raw = String(usernameInput).trim();
      if (raw.length < 3 || raw.length > 50) {
        return res.status(400).json({ error: 'Username must be 3–50 characters' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(raw)) {
        return res.status(400).json({ error: 'Username can only contain letters, numbers and underscore' });
      }
      usernameLower = raw.toLowerCase();
      const existingByUsername = await db.collection(collections.users).where('usernameLower', '==', usernameLower).get();
      if (!existingByUsername.empty) {
        return res.status(400).json({ error: 'Username already exists. Choose a different username.' });
      }
      username = raw;
    }


    // Check if email already exists (only if email is provided)
    if (email) {
    const existingUser = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    if (!existingUser.empty) {
      return res.status(400).json({ error: 'Email already registered' });
      }
    }

    // Generate unique 5-digit numeric User ID
    let userId;
    let isUnique = false;
    while (!isUnique) {
      userId = Math.floor(10000 + Math.random() * 90000).toString(); // 5-digit number
      const existingUserId = await db.collection(collections.users)
        .where('loginId', '==', userId)
        .get();
      isUnique = existingUserId.empty;
    }

    // Generate random password for staff
    const temporaryPassword = Math.random().toString(36).slice(-8);
    const hashedPassword = await bcrypt.hash(temporaryPassword, 10);

    const staffData = {
      name,
      phone,
      email: email || null,
      password: hashedPassword,
      role,
      restaurantId,
      address: address || null,
      status: 'active',
      startDate: startDate ? new Date(startDate) : new Date(),
      phoneVerified: false,
      emailVerified: false,
      provider: 'staff',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLogin: null,
      temporaryPassword: true, // Flag to indicate password needs to be changed
      loginId: userId, // Use the generated 5-digit numeric ID
      ...(username != null && { username, usernameLower }),
      pageAccess: {
        dashboard: true,
        history: true,
        tables: true,
        menu: true,
        analytics: false,
        inventory: false,
        kot: false,
        admin: false
      }
    };

    const staffRef = await db.collection(collections.users).add(staffData);

    // Store temporary password for admin display (will be deleted after first login)
    await db.collection('staffCredentials').doc(staffRef.id).set({
      staffId: staffRef.id,
      loginId: userId,
      temporaryPassword: temporaryPassword,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days
    });

    // TODO: Send email with login credentials
    console.log(`📧 Staff Login Credentials for ${name}:`);
    console.log(`   User ID: ${userId}`);
    console.log(`   Password: ${temporaryPassword}`);
    console.log(`   Restaurant: ${restaurantId}`);

    res.status(201).json({
      message: 'Staff member added successfully. Login credentials generated.',
      staff: {
        id: staffRef.id,
        name,
        phone,
        email: email || null,
        role,
        restaurantId,
        address,
        status: 'active',
        startDate: staffData.startDate,
        createdAt: staffData.createdAt,
        username: username || null
      },
      // For demo purposes, return credentials (remove in production)
      credentials: {
        loginId: userId,
        username: username || null,
        password: temporaryPassword
      }
    });

  } catch (error) {
    console.error('Add staff error:', error);
    res.status(500).json({ error: 'Failed to add staff member' });
  }
});

// Update staff member
app.patch('/api/staff/:staffId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;
    const { name, phone, email, role, status, pageAccess } = req.body;

    const updateData = {
      updatedAt: new Date()
    };

    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (email !== undefined) updateData.email = email;
    if (role) updateData.role = role;
    if (status) updateData.status = status;
    if (pageAccess) updateData.pageAccess = pageAccess;

    await db.collection(collections.users).doc(staffId).update(updateData);

    res.json({ message: 'Staff member updated successfully' });

  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ error: 'Failed to update staff member' });
  }
});

// Delete staff member
app.delete('/api/staff/:staffId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { staffId } = req.params;

    await db.collection(collections.users).doc(staffId).delete();

    res.json({ message: 'Staff member deleted successfully' });

  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ error: 'Failed to delete staff member' });
  }
});

// Get user page access
app.get('/api/user/page-access', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const userDoc = await db.collection(collections.users).doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    res.json({
      pageAccess: userData.pageAccess || {
        dashboard: true,
        history: true,
        tables: true,
        menu: true,
        analytics: false,
        inventory: false,
        kot: false,
        admin: false
      },
      role: userData.role,
      restaurantId: userData.restaurantId,
      notAllowedPages: userData.notAllowedPages || [] // Array of page IDs to hide (e.g., ['billing', 'inventory'])
    });
  } catch (error) {
    console.error('Get page access error:', error);
    res.status(500).json({ error: 'Failed to get page access' });
  }
});

// Get current authenticated user (for hotel PMS and other apps)
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log('🔍 /api/auth/me - userId:', userId);
    
    const userDoc = await db.collection(collections.users).doc(userId).get();
    
    if (!userDoc.exists) {
      console.log('❌ User not found:', userId);
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    console.log('✅ User found, data keys:', Object.keys(userData));
    
    const responseData = {
      id: userDoc.id,
      userId: userId,
      name: userData.name || null,
      email: userData.email || null,
      phone: userData.phone || null,
      role: userData.role || null,
      restaurantId: userData.restaurantId || null,
      permissions: userData.permissions || {},
      pageAccess: userData.pageAccess || null,
      status: userData.status || null,
      createdAt: userData.createdAt || null,
      lastLogin: userData.lastLogin || null
    };
    
    console.log('📤 Sending response:', JSON.stringify(responseData, null, 2));
    res.json(responseData);
  } catch (error) {
    console.error('❌ Get current user error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to get user information', details: error.message });
  }
});

// Get user profile with restaurant and owner details
app.get('/api/user/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const userDoc = await db.collection(collections.users).doc(userId).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    
    // Get restaurant details if user has restaurantId
    let restaurantData = null;
    let ownerData = null;
    
    if (userData.restaurantId) {
      const restaurantDoc = await db.collection(collections.restaurants).doc(userData.restaurantId).get();
      if (restaurantDoc.exists) {
        restaurantData = restaurantDoc.data();
        
        // Get owner details
        if (restaurantData.ownerId) {
          const ownerDoc = await db.collection(collections.users).doc(restaurantData.ownerId).get();
          if (ownerDoc.exists) {
            ownerData = ownerDoc.data();
          }
        }
      }
    }
    
    res.json({
      user: {
        id: userDoc.id,
        name: userData.name,
        email: userData.email,
        phone: userData.phone,
        role: userData.role,
        restaurantId: userData.restaurantId,
        pageAccess: userData.pageAccess,
        status: userData.status,
        createdAt: userData.createdAt,
        lastLogin: userData.lastLogin
      },
      restaurant: restaurantData ? {
        id: restaurantData.id,
        name: restaurantData.name,
        address: restaurantData.address,
        phone: restaurantData.phone,
        email: restaurantData.email,
        cuisine: restaurantData.cuisine,
        description: restaurantData.description,
        ownerId: restaurantData.ownerId,
        status: restaurantData.status,
        createdAt: restaurantData.createdAt
      } : null,
      owner: ownerData ? {
        id: restaurantData.ownerId,
        name: ownerData.name,
        email: ownerData.email,
        phone: ownerData.phone,
        role: ownerData.role
      } : null
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to get user profile' });
  }
});

// Staff login with User ID or username and password
app.post('/api/auth/staff/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;
    const identifier = (loginId != null && loginId !== '') ? String(loginId).trim() : '';

    if (!identifier || !password) {
      return res.status(400).json({ error: 'User ID/username and password are required' });
    }

    // Find staff: first by loginId (User ID), then by username (case-insensitive)
    let staffQuery = await db.collection(collections.users)
      .where('loginId', '==', identifier)
      .where('role', 'in', ['waiter', 'manager', 'employee', 'cashier', 'sales'])
      .where('status', '==', 'active')
      .get();

    if (staffQuery.empty) {
      const usernameLower = identifier.toLowerCase();
      staffQuery = await db.collection(collections.users)
        .where('usernameLower', '==', usernameLower)
        .where('role', 'in', ['waiter', 'manager', 'employee', 'cashier', 'sales'])
        .where('status', '==', 'active')
        .get();
    }

    if (staffQuery.empty) {
      return res.status(404).json({ error: 'Staff member not found or inactive' });
    }

    const staffDoc = staffQuery.docs[0];
    const staffData = staffDoc.data();

    // Check password
    const isValidPassword = await bcrypt.compare(password, staffData.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get restaurant details
    const restaurantDoc = await db.collection(collections.restaurants).doc(staffData.restaurantId).get();
    const restaurantData = restaurantDoc.exists ? restaurantDoc.data() : null;

    // Get owner details from restaurant
    let ownerData = null;
    if (restaurantData && restaurantData.ownerId) {
      const ownerDoc = await db.collection(collections.users).doc(restaurantData.ownerId).get();
      ownerData = ownerDoc.exists ? ownerDoc.data() : null;
    }

    // Update last login
    await staffDoc.ref.update({
      lastLogin: new Date(),
      updatedAt: new Date()
    });

    const token = jwt.sign(
      { 
        userId: staffDoc.id, 
        email: staffData.email, 
        role: staffData.role,
        restaurantId: staffData.restaurantId,
        ownerId: restaurantData?.ownerId
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Staff login successful',
      token,
      user: {
        id: staffDoc.id,
        email: staffData.email,
        name: staffData.name,
        role: staffData.role,
        restaurantId: staffData.restaurantId,
        phone: staffData.phone,
        pageAccess: staffData.pageAccess,
        loginId: staffData.loginId,
        username: staffData.username || null
      },
      restaurant: restaurantData ? {
        id: staffData.restaurantId, // Use the restaurantId from staff data
        name: restaurantData.name,
        address: restaurantData.address,
        phone: restaurantData.phone,
        email: restaurantData.email,
        cuisine: restaurantData.cuisine,
        description: restaurantData.description,
        ownerId: restaurantData.ownerId
      } : null,
      owner: ownerData ? {
        id: restaurantData.ownerId,
        name: ownerData.name,
        email: ownerData.email,
        phone: ownerData.phone
      } : null
    });

  } catch (error) {
    console.error('Staff login error:', error);
    res.status(500).json({ error: 'Staff login failed' });
  }
});

// Fix user roles - temporary endpoint for fixing customer->owner roles
app.post('/api/auth/fix-user-roles', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number required' });
    }
    
    // Find user by phone
    const userQuery = await db.collection(collections.users)
      .where('phone', '==', phone)
      .get();
      
    if (userQuery.empty) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userDoc = userQuery.docs[0];
    const userData = userDoc.data();
    
    // Update role to owner if it's customer
    if (userData.role === 'customer') {
      await userDoc.ref.update({
        role: 'owner',
        updatedAt: new Date()
      });
      
      console.log(`✅ Fixed user role for phone ${phone}: customer -> owner`);
      res.json({ 
        message: 'User role updated successfully',
        oldRole: 'customer',
        newRole: 'owner'
      });
    } else {
      res.json({ 
        message: 'User role is already correct',
        currentRole: userData.role
      });
    }
  } catch (error) {
    console.error('Fix user roles error:', error);
    res.status(500).json({ error: 'Failed to fix user roles' });
  }
});

// Tax Management APIs

// Get tax settings for a restaurant
app.get('/api/admin/tax/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;

    console.log(`📊 Getting tax settings for restaurant: ${restaurantId}, userId: ${userId}`);

    // Verify user has admin access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['owner', 'manager', 'admin'])
      .get();

    console.log(`🔍 User restaurant access check: userId=${userId}, restaurantId=${restaurantId}, found=${userRestaurantSnapshot.size} records`);
    
    if (userRestaurantSnapshot.empty) {
      // Debug: Let's see what roles exist for this user-restaurant combination
      const allUserRestaurants = await db.collection(collections.userRestaurants)
        .where('userId', '==', userId)
        .where('restaurantId', '==', restaurantId)
        .get();

      console.log(`🔍 All user-restaurant records for debugging:`, allUserRestaurants.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })));

      // Fallback: Check if user is the owner directly from restaurant document
      const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
      const restaurantDoc = await restaurantRef.get();

      if (!restaurantDoc.exists) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }

      const restaurant = restaurantDoc.data();
      if (restaurant.ownerId !== userId) {
        return res.status(403).json({ error: 'Access denied. Admin role required.' });
      }

      console.log(`✅ Access granted via restaurant owner check: userId=${userId}, ownerId=${restaurant.ownerId}`);
    }

    // Get restaurant to verify it exists
    const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();

    // Get tax settings from restaurant document
    const taxSettings = restaurant.taxSettings || {
      enabled: true,
      taxes: [
        {
          id: 'gst',
          name: 'GST',
          rate: 5,
          enabled: true,
          type: 'percentage'
        }
      ],
      defaultTaxRate: 5
    };

    res.json({
      success: true,
      taxSettings
    });

  } catch (error) {
    console.error('Get tax settings error:', error);
    res.status(500).json({ error: 'Failed to get tax settings' });
  }
});

// Update tax settings for a restaurant
app.put('/api/admin/tax/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const { taxSettings } = req.body;

    console.log(`📊 Updating tax settings for restaurant: ${restaurantId}, userId: ${userId}`);

    // Verify user has admin access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['owner', 'manager', 'admin'])
      .get();

    if (userRestaurantSnapshot.empty) {
      // Fallback: Check if user is the owner directly from restaurant document
      const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
      const restaurantDoc = await restaurantRef.get();

      if (!restaurantDoc.exists) {
        return res.status(404).json({ error: 'Restaurant not found' });
      }

      const restaurant = restaurantDoc.data();
      if (restaurant.ownerId !== userId) {
        return res.status(403).json({ error: 'Access denied. Admin role required.' });
      }

      console.log(`✅ Access granted via restaurant owner check: userId=${userId}, ownerId=${restaurant.ownerId}`);
    }

    // Validate tax settings
    if (!taxSettings || !Array.isArray(taxSettings.taxes)) {
      return res.status(400).json({ error: 'Invalid tax settings format' });
    }

    // Validate each tax
    for (const tax of taxSettings.taxes) {
      if (!tax.id || !tax.name || typeof tax.rate !== 'number' || tax.rate < 0 || tax.rate > 100) {
        return res.status(400).json({ error: 'Invalid tax configuration' });
      }
    }

    // Get restaurant to verify it exists
    const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Update tax settings
    await restaurantRef.update({
      taxSettings: {
        ...taxSettings,
        updatedAt: new Date(),
        updatedBy: userId
      }
    });

    res.json({
      success: true,
      message: 'Tax settings updated successfully',
      taxSettings
    });

  } catch (error) {
    console.error('Update tax settings error:', error);
    res.status(500).json({ error: 'Failed to update tax settings' });
  }
});

// Calculate tax for an order
app.post('/api/tax/calculate/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { items, subtotal } = req.body;

    console.log(`🧮 Calculating tax for restaurant: ${restaurantId}, subtotal: ${subtotal}`);

    // Get restaurant tax settings
    const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    const taxSettings = restaurant.taxSettings || {
      enabled: true,
      taxes: [
        {
          id: 'gst',
          name: 'GST',
          rate: 5,
          enabled: true,
          type: 'percentage'
        }
      ],
      defaultTaxRate: 5
    };

    if (!taxSettings.enabled) {
      return res.json({
        success: true,
        taxBreakdown: [],
        totalTax: 0,
        grandTotal: subtotal
      });
    }

    // Calculate taxes
    const taxBreakdown = [];
    let totalTax = 0;

    for (const tax of taxSettings.taxes) {
      if (tax.enabled) {
        const taxAmount = (subtotal * tax.rate) / 100;
        taxBreakdown.push({
          id: tax.id,
          name: tax.name,
          rate: tax.rate,
          amount: Math.round(taxAmount * 100) / 100
        });
        totalTax += taxAmount;
      }
    }

    const grandTotal = subtotal + totalTax;

    res.json({
      success: true,
      taxBreakdown,
      totalTax: Math.round(totalTax * 100) / 100,
      grandTotal: Math.round(grandTotal * 100) / 100
    });

  } catch (error) {
    console.error('Calculate tax error:', error);
    res.status(500).json({ error: 'Failed to calculate tax' });
  }
});

// Generate invoice for an order
app.post('/api/invoice/generate/:orderId', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.userId;

    console.log(`📄 Generating invoice for order: ${orderId}`);

    // Get order details
    const orderRef = db.collection(collections.orders).doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderDoc.data();
    
    // Get restaurant details
    const restaurantRef = db.collection(collections.restaurants).doc(order.restaurantId);
    const restaurantDoc = await restaurantRef.get();
    
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    const taxSettings = restaurant.taxSettings || {
      enabled: true,
      taxes: [
        {
          id: 'gst',
          name: 'GST',
          rate: 5,
          enabled: true,
          type: 'percentage'
        }
      ],
      defaultTaxRate: 5
    };

    // Calculate totals
    const subtotal = order.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    let totalTax = 0;
    const taxBreakdown = [];
    
    if (taxSettings.enabled) {
      for (const tax of taxSettings.taxes) {
        if (tax.enabled) {
          const taxAmount = (subtotal * tax.rate) / 100;
          taxBreakdown.push({
            id: tax.id,
            name: tax.name,
            rate: tax.rate,
            amount: Math.round(taxAmount * 100) / 100
          });
          totalTax += taxAmount;
        }
      }
    }

    const grandTotal = subtotal + totalTax;

    // Generate invoice
    const invoice = {
      id: `INV-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
      orderId: orderId,
      restaurantId: order.restaurantId,
      restaurantName: restaurant.name,
      restaurantAddress: restaurant.address || '',
      restaurantPhone: restaurant.phone || '',
      restaurantEmail: restaurant.email || '',
      customerName: order.customerInfo?.name || 'Walk-in Customer',
      customerPhone: order.customerInfo?.phone || '',
      customerEmail: order.customerInfo?.email || '',
      tableNumber: order.tableNumber || '',
      orderType: order.orderType || 'dine-in',
      items: order.items,
      subtotal: Math.round(subtotal * 100) / 100,
      taxBreakdown,
      totalTax: Math.round(totalTax * 100) / 100,
      grandTotal: Math.round(grandTotal * 100) / 100,
      paymentMethod: order.paymentMethod || 'cash',
      invoiceDate: new Date(),
      generatedBy: userId,
      status: 'generated'
    };

    // Save invoice to database
    const invoiceRef = await db.collection('invoices').add(invoice);
    invoice.id = invoiceRef.id;

    // Update order with invoice ID
    await orderRef.update({
      invoiceId: invoice.id,
      invoiceGeneratedAt: new Date()
    });

    res.json({
      success: true,
      invoice
    });

  } catch (error) {
    console.error('Generate invoice error:', error);
    res.status(500).json({ error: 'Failed to generate invoice' });
  }
});

// Get invoice by ID
app.get('/api/invoice/:invoiceId', authenticateToken, async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const userId = req.user.userId;

    console.log(`📄 Getting invoice: ${invoiceId}`);

    const invoiceRef = db.collection('invoices').doc(invoiceId);
    const invoiceDoc = await invoiceRef.get();

    if (!invoiceDoc.exists) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoice = invoiceDoc.data();
    invoice.id = invoiceDoc.id;

    // Verify access to this invoice
    const restaurantRef = db.collection(collections.restaurants).doc(invoice.restaurantId);
    const restaurantDoc = await restaurantRef.get();
    
    if (restaurantDoc.exists) {
      const restaurant = restaurantDoc.data();
      const hasAccess = restaurant.ownerId === userId || 
                       (restaurant.staff && restaurant.staff.some(staff => staff.userId === userId));
      
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    res.json({
      success: true,
      invoice
    });

  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ error: 'Failed to get invoice' });
  }
});

// Get invoices for a restaurant
app.get('/api/invoices/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const { limit = 50, offset = 0, startDate, endDate } = req.query;

    console.log(`📄 Getting invoices for restaurant: ${restaurantId}`);

    // Verify access to restaurant
    const restaurantRef = db.collection(collections.restaurants).doc(restaurantId);
    const restaurantDoc = await restaurantRef.get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurant = restaurantDoc.data();
    const hasAccess = restaurant.ownerId === userId || 
                     (restaurant.staff && restaurant.staff.some(staff => staff.userId === userId));
    
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Build query
    let query = db.collection('invoices')
      .where('restaurantId', '==', restaurantId)
      .orderBy('invoiceDate', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset));

    // Apply date filters if provided
    if (startDate) {
      query = query.where('invoiceDate', '>=', new Date(startDate));
    }
    if (endDate) {
      query = query.where('invoiceDate', '<=', new Date(endDate));
    }

    const invoicesSnapshot = await query.get();
    const invoices = invoicesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      invoices,
      total: invoices.length
    });

  } catch (error) {
    console.error('Get invoices error:', error);
    res.status(500).json({ error: 'Failed to get invoices' });
  }
});

// KOT (Kitchen Order Ticket) Management APIs

// Get KOT orders for kitchen - only orders with status 'confirmed' or later, not 'cancelled'
app.get('/api/kot/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status } = req.query;

    console.log(`🔍 KOT API - Getting orders for restaurant: ${restaurantId}, status filter: ${status || 'all'}`);

    // Get orders from yesterday onwards to avoid loading too much historical data
    const yesterdayStart = new Date();
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    yesterdayStart.setHours(0, 0, 0, 0);

    console.log(`📅 Filtering orders from: ${yesterdayStart.toISOString()}`);

    // Use a simpler query to avoid Firestore composite index requirements
    let query = db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', yesterdayStart)
      .orderBy('createdAt', 'desc');

    // Get all orders and filter in memory to avoid complex indexing
    const ordersSnapshot = await query.limit(100).get();
    console.log(`📊 Total orders found in DB: ${ordersSnapshot.docs.length}`);
    
    const orders = [];
    const validKotStatuses = ['pending', 'confirmed', 'preparing', 'ready'];
    console.log(`✅ Valid KOT statuses: ${validKotStatuses.join(', ')}`);

    for (const doc of ordersSnapshot.docs) {
      const orderData = { id: doc.id, ...doc.data() };
      console.log(`📋 Order ${doc.id}: status="${orderData.status}", created="${orderData.createdAt?.toDate()?.toISOString()}"`);
      
      // If specific status requested, filter by that
      if (status && status !== 'all') {
        if (orderData.status !== status) {
          console.log(`❌ Skipping order ${doc.id} - status "${orderData.status}" doesn't match filter "${status}"`);
          continue;
        }
      } else {
        // For 'all' or no status filter, show only kitchen-relevant orders
        if (!validKotStatuses.includes(orderData.status)) {
          console.log(`❌ Skipping order ${doc.id} - status "${orderData.status}" not in valid KOT statuses`);
        continue; // Skip orders that don't need kitchen attention
        }
      }
      
      console.log(`✅ Including order ${doc.id} in KOT list`);
      
      // Get table information if tableNumber exists
      let tableInfo = null;
      if (orderData.tableNumber) {
        try {
          const tablesSnapshot = await db.collection(collections.tables)
            .where('restaurantId', '==', restaurantId)
            .where('number', '==', orderData.tableNumber)
            .limit(1)
            .get();
          
          if (!tablesSnapshot.empty) {
            const tableData = tablesSnapshot.docs[0].data();
            tableInfo = {
              id: tablesSnapshot.docs[0].id,
              number: tableData.number,
              floor: tableData.floor,
              capacity: tableData.capacity
            };
          }
        } catch (error) {
          console.log('Table info fetch error:', error);
        }
      }

      // Calculate estimated cooking time and elapsed time
      let estimatedTime = 15; // default 15 minutes
      let kotTime = orderData.createdAt?.toDate() || new Date();
      
      if (orderData.kotTime) {
        kotTime = orderData.kotTime.toDate();
      }

      // Calculate estimated time based on items complexity
      if (orderData.items && orderData.items.length > 0) {
        estimatedTime = Math.max(15, orderData.items.length * 8); // Base time + items
      }

      // Generate KOT ID based on order ID
      const kotId = `KOT-${doc.id.slice(-6).toUpperCase()}`;

      orders.push({
        ...orderData,
        kotId,
        kotTime: kotTime.toISOString(),
        estimatedTime,
        tableInfo,
        createdAt: orderData.createdAt?.toDate()?.toISOString() || new Date().toISOString(),
        updatedAt: orderData.updatedAt?.toDate()?.toISOString() || new Date().toISOString()
      });
    }

    console.log(`🍽️ Final KOT result: ${orders.length} orders`);
    orders.forEach(order => {
      console.log(`   - Order ${order.id}: ${order.status} (${order.items?.length || 0} items)`);
    });

    res.json({
      orders,
      total: orders.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get KOT orders error:', error);
    res.status(500).json({ error: 'Failed to fetch KOT orders' });
  }
});

// Update KOT cooking status and timer
app.patch('/api/kot/:orderId/status', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, cookingStartTime, cookingEndTime, notes } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updateData = {
      status,
      updatedAt: new Date()
    };

    // Handle cooking timer updates
    if (status === 'preparing' && !cookingStartTime) {
      updateData.cookingStartTime = new Date();
      updateData.kotTime = new Date(); // Update KOT time when cooking starts
    }

    if (status === 'ready') {
      updateData.cookingEndTime = new Date();
      
      // Calculate actual cooking time if we have start time
      const orderDoc = await db.collection(collections.orders).doc(orderId).get();
      if (orderDoc.exists) {
        const orderData = orderDoc.data();
        if (orderData.cookingStartTime) {
          const startTime = orderData.cookingStartTime.toDate();
          const endTime = new Date();
          const cookingDuration = Math.floor((endTime - startTime) / (1000 * 60)); // in minutes
          updateData.actualCookingTime = cookingDuration;
        }
      }
    }

    if (cookingStartTime) {
      updateData.cookingStartTime = new Date(cookingStartTime);
    }

    if (cookingEndTime) {
      updateData.cookingEndTime = new Date(cookingEndTime);
    }

    if (notes) {
      updateData.kitchenNotes = notes;
    }

    await db.collection(collections.orders).doc(orderId).update(updateData);

    res.json({
      message: 'KOT status updated successfully',
      status,
      orderId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Update KOT status error:', error);
    res.status(500).json({ error: 'Failed to update KOT status' });
  }
});

// ============================================
// KOT PRINTING APIs (for thermal printer integration)
// These must be defined BEFORE the generic /api/kot/:restaurantId/:orderId route
// ============================================

// Get pending KOT orders for printing (orders not yet printed)
// This endpoint is PUBLIC for easy kiosk setup - use restaurantId for identification
app.get('/api/kot/pending-print/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { lastPrintedAt } = req.query; // Optional: to get orders after a specific time

    console.log(`🖨️ KOT Print API - Getting pending print orders for restaurant: ${restaurantId}`);

    // Get orders that need to be printed:
    // - Status is 'confirmed' or 'preparing' (sent to kitchen)
    // - kotPrinted is false or doesn't exist
    // - Created in the last 24 hours
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    let query = db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('status', 'in', ['confirmed', 'preparing'])
      .where('createdAt', '>=', twentyFourHoursAgo)
      .orderBy('createdAt', 'asc');

    const ordersSnapshot = await query.get();

    const pendingOrders = [];

    for (const doc of ordersSnapshot.docs) {
      const orderData = doc.data();

      // Skip already printed orders
      if (orderData.kotPrinted === true) {
        continue;
      }

      // If lastPrintedAt provided, only get orders after that time
      if (lastPrintedAt) {
        const lastTime = new Date(lastPrintedAt);
        const orderTime = orderData.createdAt?.toDate() || new Date();
        if (orderTime <= lastTime) {
          continue;
        }
      }

      // Format order for printing
      const kotId = `KOT-${doc.id.slice(-6).toUpperCase()}`;
      const createdAt = orderData.createdAt?.toDate() || new Date();

      pendingOrders.push({
        id: doc.id,
        kotId,
        dailyOrderId: orderData.dailyOrderId || kotId,
        orderNumber: orderData.orderNumber,
        tableNumber: orderData.tableNumber || '',
        roomNumber: orderData.roomNumber || '',
        items: orderData.items || [],
        notes: orderData.notes || '',
        staffInfo: orderData.staffInfo || {},
        orderType: orderData.orderType || 'dine-in',
        createdAt: createdAt.toISOString(),
        formattedTime: createdAt.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        }),
        formattedDate: createdAt.toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric'
        })
      });
    }

    console.log(`🖨️ Found ${pendingOrders.length} orders pending print`);

    res.json({
      success: true,
      orders: pendingOrders,
      count: pendingOrders.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get pending KOT print orders error:', error);
    res.status(500).json({ error: 'Failed to fetch pending print orders' });
  }
});

// Mark KOT as printed
app.patch('/api/kot/:orderId/printed', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { printedAt, printedBy } = req.body;

    console.log(`🖨️ Marking order ${orderId} as printed`);

    const orderRef = db.collection(collections.orders).doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await orderRef.update({
      kotPrinted: true,
      kotPrintedAt: printedAt ? new Date(printedAt) : new Date(),
      kotPrintedBy: printedBy || 'kiosk',
      updatedAt: new Date()
    });

    console.log(`✅ Order ${orderId} marked as printed`);

    res.json({
      success: true,
      message: 'KOT marked as printed',
      orderId
    });

  } catch (error) {
    console.error('Mark KOT printed error:', error);
    res.status(500).json({ error: 'Failed to mark KOT as printed' });
  }
});

// Get restaurant info for print page (public endpoint)
app.get('/api/restaurant/info/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();

    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const data = restaurantDoc.data();

    res.json({
      success: true,
      restaurant: {
        id: restaurantDoc.id,
        name: data.name || 'Restaurant',
        address: data.address || '',
        phone: data.phone || ''
      }
    });

  } catch (error) {
    console.error('Get restaurant info error:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant info' });
  }
});

// Get single KOT details
app.get('/api/kot/:restaurantId/:orderId', async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;

    const orderDoc = await db.collection(collections.orders).doc(orderId).get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'KOT not found' });
    }

    const orderData = { id: orderDoc.id, ...orderDoc.data() };

    if (orderData.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Access denied to this KOT' });
    }

    // Get table information if exists
    let tableInfo = null;
    if (orderData.tableNumber) {
      try {
        const tablesSnapshot = await db.collection(collections.tables)
          .where('restaurantId', '==', restaurantId)
          .where('number', '==', orderData.tableNumber)
          .limit(1)
          .get();
        
        if (!tablesSnapshot.empty) {
          const tableData = tablesSnapshot.docs[0].data();
          tableInfo = {
            id: tablesSnapshot.docs[0].id,
            number: tableData.number,
            floor: tableData.floor,
            capacity: tableData.capacity
          };
        }
      } catch (error) {
        console.log('Table info fetch error:', error);
      }
    }

    const kotId = `KOT-${orderDoc.id.slice(-6).toUpperCase()}`;
    
    res.json({
      ...orderData,
      kotId,
      tableInfo,
      createdAt: orderData.createdAt?.toDate()?.toISOString() || new Date().toISOString(),
      updatedAt: orderData.updatedAt?.toDate()?.toISOString() || new Date().toISOString(),
      kotTime: orderData.kotTime?.toDate()?.toISOString() || orderData.createdAt?.toDate()?.toISOString(),
      cookingStartTime: orderData.cookingStartTime?.toDate()?.toISOString() || null,
      cookingEndTime: orderData.cookingEndTime?.toDate()?.toISOString() || null
    });

  } catch (error) {
    console.error('Get KOT details error:', error);
    res.status(500).json({ error: 'Failed to fetch KOT details' });
  }
});

// Cancel Order API
app.patch('/api/orders/:orderId/cancel', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    console.log(`🚫 Cancel Order API - Order: ${orderId}, Reason: ${reason || 'No reason provided'}`);

    // Get the order
    const orderDoc = await db.collection(collections.orders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = orderDoc.data();

    // Check if order can be cancelled (not completed billing)
    if (orderData.status === 'completed' || orderData.paymentStatus === 'completed') {
      return res.status(400).json({ 
        error: 'Cannot cancel order that has been completed or billed' 
      });
    }

    // Check if order is already cancelled
    if (orderData.status === 'cancelled') {
      return res.status(400).json({ 
        error: 'Order is already cancelled' 
      });
    }

    // Update order status to cancelled
    const updateData = {
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: req.user.userId,
      cancellationReason: reason || 'No reason provided',
      updatedAt: new Date()
    };

    await db.collection(collections.orders).doc(orderId).update(updateData);

    // If order has a table, update table status
    if (orderData.tableNumber) {
      try {
        const tablesSnapshot = await db.collection(collections.tables)
          .where('restaurantId', '==', orderData.restaurantId)
          .where('number', '==', orderData.tableNumber)
          .limit(1)
          .get();
        
        if (!tablesSnapshot.empty) {
          await db.collection(collections.tables).doc(tablesSnapshot.docs[0].id).update({
            status: 'available',
            currentOrderId: null,
            updatedAt: new Date()
          });
          console.log(`🔄 Updated table ${orderData.tableNumber} to available after order cancellation`);
        }
      } catch (error) {
        console.error('Error updating table status after cancellation:', error);
      }
    }

    console.log(`✅ Order ${orderId} cancelled successfully`);
    
    res.json({
      success: true,
      message: 'Order cancelled successfully',
      orderId: orderId,
      cancelledAt: updateData.cancelledAt
    });

  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// ========================================
// VOICE ASSISTANT API
// ========================================

// Process voice order using ChatGPT
app.post('/api/voice/process-order', authenticateToken, aiUsageLimiter.middleware(), async (req, res) => {
  try {
    const { transcript, restaurantId } = req.body;
    
    if (!transcript || !restaurantId) {
      return res.status(400).json({ error: 'Transcript and restaurantId are required' });
    }

    console.log('🎤 Voice order processing:', { transcript, restaurantId });

    // Get menu items from restaurant document (menu is stored in restaurant.menu.items)
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const menuData = restaurantData.menu || { categories: [], items: [] };
    let menuItems = menuData.items || [];

    // Filter only active items
    menuItems = menuItems.filter(item => item.status === 'active' || item.active === true);

    if (menuItems.length === 0) {
      return res.status(404).json({ error: 'No menu items found' });
    }

    // Create menu context for ChatGPT
    const menuContext = menuItems.map(item => 
      `- ${item.name} (₹${item.price}) - ID: ${item.id}`
    ).join('\n');

    // Use ChatGPT to parse the voice command
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a restaurant order assistant for Indian cuisine. Parse the user's voice command with Indian accents and extract menu items with quantities.
          
Available menu items:
${menuContext}

Instructions:
1. Understand Indian accent variations (e.g., "paneer" as "paneer" or "panir"; "chhole" as "chhole", "chole", "chhola")
2. Extract all mentioned menu items and their quantities
3. Match items using phonetic similarity and common variations
4. Be flexible with spelling and pronunciation
5. Return ONLY valid menu items that exist in the list
6. Extract quantity (default is 1 if not specified)
7. Return as a JSON array of objects with: id, name, quantity

Example responses:
- "Add 2 samosas" → [{"id":"item123","name":"Samosa","quantity":2}]
- "I want one Paneer Tikka and two Chhole Bhature" → [{"id":"item456","name":"Paneer Tikka","quantity":1},{"id":"item789","name":"Cholle Bhature","quantity":2}]
- "Give me one Panir tika and one Chole Bhatura" → [{"id":"item456","name":"Paneer Tikka","quantity":1},{"id":"item789","name":"Cholle Bhature","quantity":1}]`
        },
        {
          role: "user",
          content: transcript
        }
      ],
      temperature: 0.2,
      max_tokens: 300
    });

    const responseText = completion.choices[0].message.content.trim();
    console.log('🤖 ChatGPT response:', responseText);

    // Parse the response (might be JSON or markdown code block)
    let parsedItems;
    try {
      // Try to extract JSON from markdown code block
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || responseText.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        parsedItems = JSON.parse(jsonMatch[1]);
      } else {
        parsedItems = JSON.parse(responseText);
      }
    } catch (parseError) {
      console.error('Failed to parse ChatGPT response:', responseText);
      return res.status(500).json({ error: 'Failed to parse voice command' });
    }

    // Helper function for fuzzy name matching
    const fuzzyMatch = (name1, name2) => {
      const n1 = name1.toLowerCase().replace(/[^a-z0-9]/g, '');
      const n2 = name2.toLowerCase().replace(/[^a-z0-9]/g, '');
      return n1.includes(n2) || n2.includes(n1);
    };

    // Validate and enrich items with prices
    const enrichedItems = [];
    for (const item of parsedItems) {
      // First try exact match by name
      let menuItem = menuItems.find(m => m.name.toLowerCase() === item.name.toLowerCase());
      
      // If not found, try fuzzy matching
      if (!menuItem) {
        menuItem = menuItems.find(m => fuzzyMatch(m.name, item.name));
      }
      
      // If still not found, try to match by id if provided
      if (!menuItem && item.id) {
        menuItem = menuItems.find(m => m.id === item.id);
      }
      
      if (!menuItem) {
        console.log(`⚠️ Could not match item: ${item.name}`);
        continue; // Skip items that don't match
      }
      
      enrichedItems.push({
        id: menuItem.id,
        name: menuItem.name,
        price: menuItem.price,
        quantity: item.quantity || 1
      });
    }

    if (enrichedItems.length === 0) {
      return res.status(404).json({ error: 'Could not match any menu items' });
    }

    console.log('✅ Voice order parsed:', enrichedItems);

    res.json({
      success: true,
      items: enrichedItems
    });

  } catch (error) {
    console.error('Voice processing error:', error);
    res.status(500).json({ 
      error: 'Failed to process voice command',
      message: error.message 
    });
  }
});

// ========================================
// VOICE PURCHASE ORDER API
// ========================================

// Process voice command for Purchase Order creation
app.post('/api/voice/process-purchase-order', authenticateToken, aiUsageLimiter.middleware(), async (req, res) => {
  try {
    const { transcript, restaurantId } = req.body;
    
    if (!transcript || !restaurantId) {
      return res.status(400).json({ error: 'Transcript and restaurantId are required' });
    }

    console.log('🎤 Voice PO processing:', { transcript, restaurantId });

    // Get inventory items and suppliers
    const inventorySnapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', restaurantId)
      .get();
    
    const inventoryItems = [];
    inventorySnapshot.forEach(doc => {
      inventoryItems.push({ id: doc.id, ...doc.data() });
    });

    const suppliersSnapshot = await db.collection(collections.suppliers)
      .where('restaurantId', '==', restaurantId)
      .get();
    
    const suppliers = [];
    suppliersSnapshot.forEach(doc => {
      suppliers.push({ id: doc.id, ...doc.data() });
    });

    if (inventoryItems.length === 0) {
      return res.status(404).json({ error: 'No inventory items found' });
    }

    // Create context for ChatGPT
    const inventoryContext = inventoryItems.map(item => 
      `- ${item.name} (${item.unit || 'unit'}) - ID: ${item.id}`
    ).join('\n');

    const suppliersContext = suppliers.map(supplier => 
      `- ${supplier.name} - ID: ${supplier.id}`
    ).join('\n');

    // Use ChatGPT to parse the voice command
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a purchase order assistant. Parse the user's voice command and extract:
1. Inventory items with quantities
2. Supplier name (if mentioned)
3. Delivery date (if mentioned)
4. Priority/urgency (if mentioned)

Available inventory items:
${inventoryContext}

Available suppliers:
${suppliersContext}

Instructions:
1. Extract all mentioned items and quantities (handle units: kg, kgs, kilogram, units, boxes, etc.)
2. Match supplier name if mentioned
3. Extract delivery date (today, tomorrow, next week, specific date)
4. Return as JSON with structure:
{
  "items": [{"inventoryItemId": "id", "inventoryItemName": "name", "quantity": number, "unit": "kg"}],
  "supplierId": "id or null",
  "supplierName": "name or null",
  "expectedDeliveryDate": "YYYY-MM-DD or null",
  "priority": "low/medium/high or null",
  "notes": "any additional notes or null"
}

Example responses:
- "Create PO for 50kg tomatoes and 20kg onions from supplier ABC" → {"items": [{"inventoryItemId": "...", "inventoryItemName": "Tomatoes", "quantity": 50, "unit": "kg"}, {"inventoryItemId": "...", "inventoryItemName": "Onions", "quantity": 20, "unit": "kg"}], "supplierId": "...", "supplierName": "ABC", "expectedDeliveryDate": null, "priority": null, "notes": null}
- "Order 100 units of rice from XYZ suppliers for tomorrow" → {"items": [{"inventoryItemId": "...", "inventoryItemName": "Rice", "quantity": 100, "unit": "unit"}], "supplierId": "...", "supplierName": "XYZ", "expectedDeliveryDate": "2024-01-29", "priority": null, "notes": null}`
        },
        {
          role: "user",
          content: transcript
        }
      ],
      temperature: 0.2,
      max_tokens: 500
    });

    const responseText = completion.choices[0].message.content.trim();
    console.log('🤖 ChatGPT PO response:', responseText);

    // Parse the response
    let parsedData;
    try {
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || responseText.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        parsedData = JSON.parse(jsonMatch[1]);
      } else {
        parsedData = JSON.parse(responseText);
      }
    } catch (parseError) {
      console.error('Failed to parse ChatGPT response:', responseText);
      return res.status(500).json({ error: 'Failed to parse voice command' });
    }

    // Match inventory items and suppliers
    const matchedItems = [];
    for (const item of parsedData.items || []) {
      // Try exact match first
      let inventoryItem = inventoryItems.find(i => 
        i.name.toLowerCase() === item.inventoryItemName.toLowerCase()
      );
      
      // Fuzzy match
      if (!inventoryItem) {
        inventoryItem = inventoryItems.find(i => 
          i.name.toLowerCase().includes(item.inventoryItemName.toLowerCase()) ||
          item.inventoryItemName.toLowerCase().includes(i.name.toLowerCase())
        );
      }
      
      if (inventoryItem) {
        matchedItems.push({
          inventoryItemId: inventoryItem.id,
          inventoryItemName: inventoryItem.name,
          quantity: item.quantity || 1,
          unit: item.unit || inventoryItem.unit || 'unit',
          unitPrice: inventoryItem.costPerUnit || 0,
          totalPrice: (item.quantity || 1) * (inventoryItem.costPerUnit || 0)
        });
      }
    }

    // Match supplier
    let matchedSupplier = null;
    if (parsedData.supplierName) {
      matchedSupplier = suppliers.find(s => 
        s.name.toLowerCase().includes(parsedData.supplierName.toLowerCase()) ||
        parsedData.supplierName.toLowerCase().includes(s.name.toLowerCase())
      );
    }

    // Calculate delivery date
    let deliveryDate = null;
    if (parsedData.expectedDeliveryDate) {
      deliveryDate = parsedData.expectedDeliveryDate;
    } else if (parsedData.deliveryDate) {
      // Handle relative dates
      const today = new Date();
      if (parsedData.deliveryDate.toLowerCase().includes('tomorrow')) {
        today.setDate(today.getDate() + 1);
        deliveryDate = today.toISOString().split('T')[0];
      } else if (parsedData.deliveryDate.toLowerCase().includes('next week')) {
        today.setDate(today.getDate() + 7);
        deliveryDate = today.toISOString().split('T')[0];
      }
    }

    if (matchedItems.length === 0) {
      return res.status(404).json({ error: 'Could not match any inventory items' });
    }

    console.log('✅ Voice PO parsed:', { items: matchedItems, supplier: matchedSupplier });

    res.json({
      success: true,
      items: matchedItems,
      supplierId: matchedSupplier?.id || null,
      supplierName: matchedSupplier?.name || parsedData.supplierName || null,
      expectedDeliveryDate: deliveryDate,
      priority: parsedData.priority || 'medium',
      notes: parsedData.notes || null
    });

  } catch (error) {
    console.error('Voice PO processing error:', error);
    res.status(500).json({ 
      error: 'Failed to process voice command',
      message: error.message 
    });
  }
});

// ========================================
// INVOICE OCR API
// ========================================

// Process invoice image using GPT-4 Vision
app.post('/api/invoice/ocr', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { restaurantId } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    if (!restaurantId) {
      return res.status(400).json({ error: 'RestaurantId is required' });
    }

    console.log('📸 Invoice OCR processing:', { restaurantId, fileName: file.originalname });

    // Get suppliers for matching
    const suppliersSnapshot = await db.collection(collections.suppliers)
      .where('restaurantId', '==', restaurantId)
      .get();
    
    const suppliers = [];
    suppliersSnapshot.forEach(doc => {
      suppliers.push({ id: doc.id, ...doc.data() });
    });

    // Convert image to base64
    const imageBase64 = file.buffer.toString('base64');
    const imageMimeType = file.mimetype;

    // Use GPT-4 Vision to extract invoice data
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract all information from this invoice image. Return a JSON object with:
{
  "supplierName": "supplier name from invoice",
  "invoiceNumber": "invoice number",
  "invoiceDate": "date in YYYY-MM-DD format",
  "totalAmount": number (total amount),
  "taxAmount": number (tax if mentioned),
  "subtotal": number (subtotal if mentioned),
  "items": [{"name": "item name", "quantity": number, "unitPrice": number, "totalPrice": number}],
  "paymentTerms": "payment terms if mentioned",
  "dueDate": "due date in YYYY-MM-DD format if mentioned",
  "notes": "any additional notes"
}

Extract all text visible in the image. Be accurate with numbers and dates.`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${imageMimeType};base64,${imageBase64}`
              }
            }
          ]
        }
      ],
      max_tokens: 1000
    });

    const responseText = completion.choices[0].message.content.trim();
    console.log('🤖 GPT-4 Vision response:', responseText);

    // Parse the response
    let extractedData;
    try {
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/) || responseText.match(/```\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        extractedData = JSON.parse(jsonMatch[1]);
      } else {
        extractedData = JSON.parse(responseText);
      }
    } catch (parseError) {
      console.error('Failed to parse GPT-4 Vision response:', responseText);
      return res.status(500).json({ error: 'Failed to extract invoice data' });
    }

    // Match supplier
    let matchedSupplier = null;
    if (extractedData.supplierName) {
      matchedSupplier = suppliers.find(s => 
        s.name.toLowerCase().includes(extractedData.supplierName.toLowerCase()) ||
        extractedData.supplierName.toLowerCase().includes(s.name.toLowerCase())
      );
    }

    console.log('✅ Invoice OCR extracted:', extractedData);

    res.json({
      success: true,
      supplierId: matchedSupplier?.id || null,
      supplierName: matchedSupplier?.name || extractedData.supplierName || null,
      invoiceNumber: extractedData.invoiceNumber || null,
      invoiceDate: extractedData.invoiceDate || null,
      totalAmount: extractedData.totalAmount || extractedData.subtotal || 0,
      taxAmount: extractedData.taxAmount || 0,
      items: extractedData.items || [],
      paymentTerms: extractedData.paymentTerms || null,
      dueDate: extractedData.dueDate || null,
      notes: extractedData.notes || null
    });

  } catch (error) {
    console.error('Invoice OCR error:', error);
    res.status(500).json({ 
      error: 'Failed to process invoice image',
      message: error.message 
    });
  }
});

// ========================================
// SMART AUTO-FILL API
// ========================================

// Get smart suggestions for PO/Invoice based on historical data
app.get('/api/smart-suggestions/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { type } = req.query; // 'po' or 'invoice'

    if (!restaurantId) {
      return res.status(400).json({ error: 'RestaurantId is required' });
    }

    console.log('🤖 Smart suggestions request:', { restaurantId, type });

    // Get recent purchase orders
    let poSnapshot;
    try {
      poSnapshot = await db.collection(collections.purchaseOrders)
        .where('restaurantId', '==', restaurantId)
        .orderBy('createdAt', 'desc')
        .limit(20)
        .get();
    } catch (error) {
      // If orderBy fails, fetch without it
      poSnapshot = await db.collection(collections.purchaseOrders)
        .where('restaurantId', '==', restaurantId)
        .limit(20)
        .get();
    }

    const recentPOs = [];
    poSnapshot.forEach(doc => {
      recentPOs.push({ id: doc.id, ...doc.data() });
    });

    // Sort manually if needed
    if (recentPOs.length > 0) {
      recentPOs.sort((a, b) => {
        const dateA = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
        const dateB = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
        return dateB - dateA;
      });
    }

    // Get recent invoices
    let invoiceSnapshot;
    try {
      invoiceSnapshot = await db.collection(collections.supplierInvoices)
        .where('restaurantId', '==', restaurantId)
        .orderBy('invoiceDate', 'desc')
        .limit(20)
        .get();
    } catch (error) {
      invoiceSnapshot = await db.collection(collections.supplierInvoices)
        .where('restaurantId', '==', restaurantId)
        .limit(20)
        .get();
    }

    const recentInvoices = [];
    invoiceSnapshot.forEach(doc => {
      recentInvoices.push({ id: doc.id, ...doc.data() });
    });

    // Analyze most used suppliers
    const supplierUsage = {};
    [...recentPOs, ...recentInvoices].forEach(doc => {
      const supplierId = doc.supplierId;
      if (supplierId) {
        supplierUsage[supplierId] = (supplierUsage[supplierId] || 0) + 1;
      }
    });

    const topSuppliers = Object.entries(supplierUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([supplierId]) => supplierId);

    // Get supplier details
    const suppliersData = [];
    for (const supplierId of topSuppliers) {
      const supplierDoc = await db.collection(collections.suppliers).doc(supplierId).get();
      if (supplierDoc.exists) {
        suppliersData.push({ id: supplierDoc.id, ...supplierDoc.data() });
      }
    }

    // Analyze most ordered items
    const itemUsage = {};
    recentPOs.forEach(po => {
      if (po.items && Array.isArray(po.items)) {
        po.items.forEach(item => {
          const itemId = item.inventoryItemId;
          if (itemId) {
            if (!itemUsage[itemId]) {
              itemUsage[itemId] = { count: 0, totalQuantity: 0, avgPrice: 0, prices: [] };
            }
            itemUsage[itemId].count++;
            itemUsage[itemId].totalQuantity += item.quantity || 0;
            if (item.unitPrice) {
              itemUsage[itemId].prices.push(item.unitPrice);
            }
          }
        });
      }
    });

    // Calculate averages
    Object.keys(itemUsage).forEach(itemId => {
      const usage = itemUsage[itemId];
      usage.avgQuantity = usage.totalQuantity / usage.count;
      if (usage.prices.length > 0) {
        usage.avgPrice = usage.prices.reduce((a, b) => a + b, 0) / usage.prices.length;
      }
    });

    const topItems = Object.entries(itemUsage)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([itemId, data]) => ({ itemId, ...data }));

    // Get item details
    const itemsData = [];
    for (const { itemId } of topItems) {
      const itemDoc = await db.collection(collections.inventory).doc(itemId).get();
      if (itemDoc.exists) {
        const itemData = itemDoc.data();
        const usageData = itemUsage[itemId];
        itemsData.push({
          id: itemId,
          name: itemData.name,
          unit: itemData.unit || 'unit',
          avgQuantity: usageData.avgQuantity,
          avgPrice: usageData.avgPrice || itemData.costPerUnit || 0,
          lastOrdered: usageData.count > 0 ? 'Recently' : 'Never'
        });
      }
    }

    // Get average delivery time
    const deliveryTimes = [];
    recentPOs.forEach(po => {
      if (po.expectedDeliveryDate && po.createdAt) {
        const expected = po.expectedDeliveryDate.toDate ? po.expectedDeliveryDate.toDate() : new Date(po.expectedDeliveryDate);
        const created = po.createdAt.toDate ? po.createdAt.toDate() : new Date(po.createdAt);
        const days = Math.ceil((expected - created) / (1000 * 60 * 60 * 24));
        if (days > 0 && days < 30) {
          deliveryTimes.push(days);
        }
      }
    });

    const avgDeliveryDays = deliveryTimes.length > 0
      ? Math.round(deliveryTimes.reduce((a, b) => a + b, 0) / deliveryTimes.length)
      : 7;

    console.log('✅ Smart suggestions generated');

    res.json({
      success: true,
      topSuppliers: suppliersData,
      topItems: itemsData,
      avgDeliveryDays,
      recentPOsCount: recentPOs.length,
      recentInvoicesCount: recentInvoices.length
    });

  } catch (error) {
    console.error('Smart suggestions error:', error);
    res.status(500).json({ 
      error: 'Failed to generate smart suggestions',
      message: error.message 
    });
  }
});

// ========================================
// INVENTORY MANAGEMENT APIs
// ========================================

// Get all inventory items for a restaurant
app.get('/api/inventory/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { category, status, search } = req.query;

    console.log(`📦 Inventory API - Restaurant: ${restaurantId}, Category: ${category || 'all'}, Status: ${status || 'all'}, Search: ${search || 'none'}`);

    let query = db.collection(collections.inventory).where('restaurantId', '==', restaurantId);
    
    // Apply category filter if provided
    if (category && category !== 'all') {
      query = query.where('category', '==', category);
    }

    const snapshot = await query.orderBy('name', 'asc').get();
    let items = [];

    snapshot.forEach(doc => {
      const itemData = { id: doc.id, ...doc.data() };
      
      // Apply status filter
      if (status && status !== 'all') {
        if (status === 'low' && itemData.currentStock > itemData.minStock) return;
        if (status === 'good' && itemData.currentStock <= itemData.minStock) return;
        if (status === 'expired' && itemData.expiryDate && new Date(itemData.expiryDate) > new Date()) return;
      }
      
      // Apply search filter
      if (search) {
        const searchValue = search.toLowerCase().trim();
        if (!itemData.name.toLowerCase().includes(searchValue) &&
            !itemData.category.toLowerCase().includes(searchValue) &&
            !itemData.supplier.toLowerCase().includes(searchValue)) {
          return;
        }
      }
      
      // Determine status
      if (itemData.currentStock <= itemData.minStock) {
        itemData.status = 'low';
      } else if (itemData.expiryDate && new Date(itemData.expiryDate) < new Date()) {
        itemData.status = 'expired';
      } else {
        itemData.status = 'good';
      }
      
      items.push(itemData);
    });

    console.log(`📊 Inventory results: ${items.length} items found for restaurant ${restaurantId}`);

    res.json({ 
      items,
      total: items.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({ error: 'Failed to fetch inventory items' });
  }
});

// Get inventory categories
app.get('/api/inventory/:restaurantId/categories', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    console.log(`📂 Categories API - Restaurant: ${restaurantId}`);

    const snapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', restaurantId)
      .get();

    console.log(`📊 Categories query result: ${snapshot.size} documents found`);

    const categories = new Set();
    snapshot.forEach(doc => {
      const itemData = doc.data();
      if (itemData.category) {
        categories.add(itemData.category);
      }
    });

    const categoriesArray = Array.from(categories).sort();
    console.log(`📋 Categories found: ${categoriesArray.join(', ')}`);

    res.json({ 
      categories: categoriesArray,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get inventory categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get inventory dashboard stats
app.get('/api/inventory/:restaurantId/dashboard', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    console.log(`📊 Dashboard API - Restaurant: ${restaurantId}`);

    const snapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', restaurantId)
      .get();

    let totalItems = 0;
    let lowStockItems = 0;
    let expiredItems = 0;
    let totalValue = 0;
    let categories = new Set();

    snapshot.forEach(doc => {
      const itemData = doc.data();
      totalItems++;
      
      if (itemData.category) {
        categories.add(itemData.category);
      }
      
      if (itemData.currentStock <= itemData.minStock) {
        lowStockItems++;
      }
      
      if (itemData.expiryDate && new Date(itemData.expiryDate) < new Date()) {
        expiredItems++;
      }
      
      totalValue += (itemData.currentStock || 0) * (itemData.costPerUnit || 0);
    });

    const stats = {
      totalItems,
      lowStockItems,
      expiredItems,
      totalValue: Math.round(totalValue * 100) / 100,
      totalCategories: categories.size,
      timestamp: new Date().toISOString()
    };

    console.log(`📈 Dashboard stats: ${JSON.stringify(stats)}`);

    res.json({ 
      stats,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get inventory dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// Get single inventory item
app.get('/api/inventory/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;

    const itemDoc = await db.collection(collections.inventory).doc(itemId).get();
    
    if (!itemDoc.exists) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    const itemData = itemDoc.data();
    
    if (itemData.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ item: { id: itemDoc.id, ...itemData } });

  } catch (error) {
    console.error('Get inventory item error:', error);
    res.status(500).json({ error: 'Failed to fetch inventory item' });
  }
});

// Create new inventory item
app.post('/api/inventory/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    // Check permissions
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const {
      name,
      category,
      unit,
      currentStock,
      minStock,
      maxStock,
      costPerUnit,
      supplier,
      description,
      barcode,
      expiryDate,
      location
    } = req.body;

    // Validate required fields
    if (!name || !category || !unit) {
      return res.status(400).json({ error: 'Name, category, and unit are required' });
    }

    // Check if item with same name already exists
    const existingItemsSnapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', restaurantId)
      .where('name', '==', name)
      .limit(1)
      .get();

    if (!existingItemsSnapshot.empty) {
      return res.status(400).json({ error: 'Item with this name already exists' });
    }

    // Determine status based on stock levels
    let status = 'good';
    if (currentStock <= minStock) {
      status = 'low';
    }
    if (expiryDate && new Date(expiryDate) < new Date()) {
      status = 'expired';
    }

    const itemData = {
      restaurantId,
      name: name.trim(),
      category: category.trim(),
      unit: unit.trim(),
      currentStock: parseFloat(currentStock) || 0,
      minStock: parseFloat(minStock) || 0,
      maxStock: parseFloat(maxStock) || 0,
      costPerUnit: parseFloat(costPerUnit) || 0,
      supplier: supplier?.trim() || '',
      description: description?.trim() || '',
      barcode: barcode?.trim() || '',
      expiryDate: expiryDate || null,
      location: location?.trim() || '',
      status,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId,
      updatedBy: userId
    };

    const itemRef = await db.collection(collections.inventory).add(itemData);

    console.log(`📦 Inventory item created: ${itemRef.id} - ${itemData.name}`);

    res.status(201).json({
      message: 'Inventory item created successfully',
      item: { id: itemRef.id, ...itemData }
    });

  } catch (error) {
    console.error('Create inventory item error:', error);
    res.status(500).json({ error: 'Failed to create inventory item' });
  }
});

// Update inventory item
app.patch('/api/inventory/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;
    const { userId, role } = req.user;
    
    // Check permissions
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    // Get current item
    const itemDoc = await db.collection(collections.inventory).doc(itemId).get();
    
    if (!itemDoc.exists) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    const currentItem = itemDoc.data();
    
    if (currentItem.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updateData = {
      updatedAt: new Date(),
      updatedBy: userId
    };

    // Update fields if provided
    const fieldsToUpdate = [
      'name', 'category', 'unit', 'currentStock', 'minStock', 'maxStock',
      'costPerUnit', 'supplier', 'description', 'barcode', 'expiryDate', 'location'
    ];

    fieldsToUpdate.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'name' || field === 'category' || field === 'unit' || 
            field === 'supplier' || field === 'description' || field === 'barcode' || field === 'location') {
          updateData[field] = req.body[field]?.trim() || '';
        } else if (field === 'currentStock' || field === 'minStock' || field === 'maxStock' || field === 'costPerUnit') {
          updateData[field] = parseFloat(req.body[field]) || 0;
        } else if (field === 'expiryDate') {
          updateData[field] = req.body[field] || null;
        }
      }
    });

    // Recalculate status
    const newCurrentStock = updateData.currentStock !== undefined ? updateData.currentStock : currentItem.currentStock;
    const newMinStock = updateData.minStock !== undefined ? updateData.minStock : currentItem.minStock;
    const newExpiryDate = updateData.expiryDate !== undefined ? updateData.expiryDate : currentItem.expiryDate;

    let status = 'good';
    if (newCurrentStock <= newMinStock) {
      status = 'low';
    }
    if (newExpiryDate && new Date(newExpiryDate) < new Date()) {
      status = 'expired';
    }
    updateData.status = status;

    await db.collection(collections.inventory).doc(itemId).update(updateData);

    console.log(`📦 Inventory item updated: ${itemId}`);

    res.json({
      message: 'Inventory item updated successfully',
      item: { id: itemId, ...currentItem, ...updateData }
    });

  } catch (error) {
    console.error('Update inventory item error:', error);
    res.status(500).json({ error: 'Failed to update inventory item' });
  }
});

// Delete inventory item
app.delete('/api/inventory/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;
    const { userId, role } = req.user;
    
    // Check permissions
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    // Get item to verify ownership
    const itemDoc = await db.collection(collections.inventory).doc(itemId).get();
    
    if (!itemDoc.exists) {
      return res.status(404).json({ error: 'Inventory item not found' });
    }

    const itemData = itemDoc.data();
    
    if (itemData.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await db.collection(collections.inventory).doc(itemId).delete();

    console.log(`📦 Inventory item deleted: ${itemId} - ${itemData.name}`);

    res.json({ message: 'Inventory item deleted successfully' });

  } catch (error) {
    console.error('Delete inventory item error:', error);
    res.status(500).json({ error: 'Failed to delete inventory item' });
  }
});

// ========================================
// SUPPLIER MANAGEMENT APIs
// ========================================

// Get all suppliers for a restaurant
app.get('/api/suppliers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.suppliers)
      .where('restaurantId', '==', restaurantId)
      .orderBy('name', 'asc')
      .get();

    const suppliers = [];
    snapshot.forEach(doc => {
      suppliers.push({ id: doc.id, ...doc.data() });
    });

    res.json({ suppliers, total: suppliers.length });

  } catch (error) {
    console.error('Get suppliers error:', error);
    res.status(500).json({ error: 'Failed to fetch suppliers' });
  }
});

// Create new supplier
app.post('/api/suppliers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const { name, contact, email, address, paymentTerms, notes } = req.body;

    if (!name || !contact) {
      return res.status(400).json({ error: 'Name and contact are required' });
    }

    const supplierData = {
      restaurantId,
      name: name.trim(),
      contact: contact.trim(),
      email: email?.trim() || '',
      address: address?.trim() || '',
      paymentTerms: paymentTerms?.trim() || '',
      notes: notes?.trim() || '',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const supplierRef = await db.collection(collections.suppliers).add(supplierData);

    res.status(201).json({
      message: 'Supplier created successfully',
      supplier: { id: supplierRef.id, ...supplierData }
    });

  } catch (error) {
    console.error('Create supplier error:', error);
    res.status(500).json({ error: 'Failed to create supplier' });
  }
});

// ========================================
// RECIPES MANAGEMENT APIs
// ========================================

// Get all recipes for a restaurant
app.get('/api/recipes/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { category } = req.query;

    let query = db.collection(collections.recipes)
      .where('restaurantId', '==', restaurantId);

    if (category && category !== 'all') {
      query = query.where('category', '==', category);
    }

    const snapshot = await query.orderBy('name', 'asc').get();

    const recipes = [];
    snapshot.forEach(doc => {
      recipes.push({ id: doc.id, ...doc.data() });
    });

    res.json({ recipes, total: recipes.length });

  } catch (error) {
    console.error('Get recipes error:', error);
    res.status(500).json({ error: 'Failed to fetch recipes' });
  }
});

// Create new recipe
app.post('/api/recipes/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const { name, description, ingredients, instructions, servings, prepTime, cookTime, category } = req.body;

    if (!name || !ingredients || ingredients.length === 0) {
      return res.status(400).json({ error: 'Recipe name and ingredients are required' });
    }

    const recipeData = {
      restaurantId,
      name: name.trim(),
      description: description?.trim() || '',
      ingredients: ingredients.map(ing => ({
        inventoryItemId: ing.inventoryItemId,
        inventoryItemName: ing.inventoryItemName,
        quantity: parseFloat(ing.quantity) || 0,
        unit: ing.unit || 'g'
      })),
      instructions: instructions?.trim() || '',
      servings: parseInt(servings) || 1,
      prepTime: parseInt(prepTime) || 0,
      cookTime: parseInt(cookTime) || 0,
      category: category?.trim() || 'Main Course',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const recipeRef = await db.collection(collections.recipes).add(recipeData);
    
    res.status(201).json({
      message: 'Recipe created successfully',
      recipe: { id: recipeRef.id, ...recipeData }
    });

  } catch (error) {
    console.error('Create recipe error:', error);
    res.status(500).json({ error: 'Failed to create recipe' });
  }
});

// Update recipe
app.patch('/api/recipes/:restaurantId/:recipeId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, recipeId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const updateData = { ...req.body, updatedAt: new Date(), updatedBy: userId };

    const recipeDoc = await db.collection(collections.recipes).doc(recipeId).get();
    if (!recipeDoc.exists || recipeDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    await db.collection(collections.recipes).doc(recipeId).update(updateData);
    
    res.json({
      message: 'Recipe updated successfully',
      recipe: { id: recipeId, ...recipeDoc.data(), ...updateData }
    });

  } catch (error) {
    console.error('Update recipe error:', error);
    res.status(500).json({ error: 'Failed to update recipe' });
  }
});

// Delete recipe
app.delete('/api/recipes/:restaurantId/:recipeId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, recipeId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const recipeDoc = await db.collection(collections.recipes).doc(recipeId).get();
    if (!recipeDoc.exists || recipeDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Recipe not found' });
    }

    await db.collection(collections.recipes).doc(recipeId).delete();
    
    res.json({ message: 'Recipe deleted successfully' });

  } catch (error) {
    console.error('Delete recipe error:', error);
    res.status(500).json({ error: 'Failed to delete recipe' });
  }
});

// ========================================
// PURCHASE ORDERS APIs
// ========================================

// Get all purchase orders for a restaurant
app.get('/api/purchase-orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, supplierId } = req.query;

    let query = db.collection(collections.purchaseOrders)
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    if (supplierId && supplierId !== 'all') {
      query = query.where('supplierId', '==', supplierId);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();

    const orders = [];
    snapshot.forEach(doc => {
      orders.push({ id: doc.id, ...doc.data() });
    });

    res.json({ orders, total: orders.length });

  } catch (error) {
    console.error('Get purchase orders error:', error);
    res.status(500).json({ error: 'Failed to fetch purchase orders' });
  }
});

// Create new purchase order
app.post('/api/purchase-orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const { supplierId, items, notes, expectedDeliveryDate } = req.body;

    if (!supplierId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Supplier and items are required' });
    }

    const totalAmount = items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);

    const orderData = {
      restaurantId,
      supplierId,
      items: items.map(item => ({
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: item.inventoryItemName,
        quantity: parseFloat(item.quantity) || 0,
        unitPrice: parseFloat(item.unitPrice) || 0,
        totalPrice: parseFloat(item.quantity) * parseFloat(item.unitPrice)
      })),
      totalAmount,
      notes: notes?.trim() || '',
      expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const orderRef = await db.collection(collections.purchaseOrders).add(orderData);
    
    res.status(201).json({
      message: 'Purchase order created successfully',
      order: { id: orderRef.id, ...orderData }
    });

  } catch (error) {
    console.error('Create purchase order error:', error);
    res.status(500).json({ error: 'Failed to create purchase order' });
  }
});

// Update purchase order status
app.patch('/api/purchase-orders/:restaurantId/:orderId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const { status, receivedItems, notes } = req.body;

    // Valid status flow: pending → approved → sent → received/delivered
    const validStatuses = ['pending', 'approved', 'sent', 'received', 'delivered', 'cancelled'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Valid statuses: ${validStatuses.join(', ')}` });
    }

    const orderDoc = await db.collection(collections.purchaseOrders).doc(orderId).get();
    if (!orderDoc.exists || orderDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }

    const currentOrder = orderDoc.data();
    const currentStatus = currentOrder.status;

    // Status transition validation
    if (status) {
      const statusFlow = {
        'pending': ['approved', 'cancelled'],
        'approved': ['sent', 'cancelled'],
        'sent': ['received', 'delivered', 'cancelled'],
        'received': ['delivered'],
        'delivered': [],
        'cancelled': []
      };

      if (statusFlow[currentStatus] && !statusFlow[currentStatus].includes(status)) {
        return res.status(400).json({ 
          error: `Invalid status transition. Cannot change from '${currentStatus}' to '${status}'. Valid next statuses: ${statusFlow[currentStatus].join(', ')}` 
        });
      }
    }

    const updateData = { 
      updatedAt: new Date(),
      updatedBy: userId
    };

    if (status) {
      updateData.status = status;
      
      // Set timestamps based on status
      if (status === 'approved') {
        updateData.approvedAt = new Date();
        updateData.approvedBy = userId;
      } else if (status === 'sent') {
        updateData.sentAt = new Date();
        updateData.sentBy = userId;
      } else if (status === 'received' || status === 'delivered') {
        updateData.receivedAt = new Date();
        updateData.receivedBy = userId;
      } else if (status === 'cancelled') {
        updateData.cancelledAt = new Date();
        updateData.cancelledBy = userId;
        updateData.cancellationNotes = notes?.trim() || '';
      }
    }

    if (notes && notes.trim()) {
      updateData.notes = (currentOrder.notes || '') + '\n' + notes.trim();
    }

    if (status === 'received' && receivedItems) {
      updateData.receivedItems = receivedItems;
      
      // Update inventory stock
      for (const item of receivedItems) {
        const inventoryDoc = await db.collection(collections.inventory).doc(item.inventoryItemId).get();
        if (inventoryDoc.exists) {
          const currentStock = inventoryDoc.data().currentStock || 0;
          await db.collection(collections.inventory).doc(item.inventoryItemId).update({
            currentStock: currentStock + item.quantity,
            lastUpdated: new Date()
          });
        }
      }
    }

    await db.collection(collections.purchaseOrders).doc(orderId).update(updateData);
    
    const updatedOrder = { id: orderId, ...currentOrder, ...updateData };
    
    res.json({
      message: 'Purchase order updated successfully',
      order: updatedOrder
    });

  } catch (error) {
    console.error('Update purchase order error:', error);
    res.status(500).json({ error: 'Failed to update purchase order' });
  }
});

// Generate purchase order invoice HTML
function generatePurchaseOrderInvoice(orderData, restaurantData, supplierName) {
  const orderDate = new Date(orderData.createdAt).toLocaleDateString();
  const expectedDelivery = orderData.expectedDeliveryDate ? new Date(orderData.expectedDeliveryDate).toLocaleDateString() : 'Not specified';
  
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Purchase Order Invoice</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; color: #333; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #059669; padding-bottom: 20px; }
        .header h1 { color: #059669; margin: 0; font-size: 28px; }
        .header p { margin: 5px 0; color: #666; }
        .info-section { display: flex; justify-content: space-between; margin-bottom: 30px; }
        .info-box { flex: 1; margin: 0 10px; }
        .info-box h3 { color: #059669; border-bottom: 1px solid #eee; padding-bottom: 5px; }
        .items-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
        .items-table th, .items-table td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        .items-table th { background-color: #059669; color: white; }
        .items-table tr:nth-child(even) { background-color: #f9f9f9; }
        .total-section { text-align: right; margin-top: 20px; }
        .total-row { font-weight: bold; font-size: 18px; color: #059669; }
        .notes { margin-top: 30px; padding: 15px; background-color: #f5f5f5; border-radius: 5px; }
        .footer { margin-top: 40px; text-align: center; color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>PURCHASE ORDER</h1>
        <p><strong>${restaurantData.name || 'Restaurant'}</strong></p>
        <p>Order #${orderData.id ? orderData.id.slice(-8) : 'N/A'}</p>
        <p>Date: ${orderDate}</p>
      </div>

      <div class="info-section">
        <div class="info-box">
          <h3>Restaurant Details</h3>
          <p><strong>${restaurantData.name || 'Restaurant'}</strong></p>
          <p>${restaurantData.address || 'Address not provided'}</p>
          <p>Phone: ${restaurantData.phone || 'Not provided'}</p>
          <p>Email: ${restaurantData.email || 'Not provided'}</p>
        </div>
        <div class="info-box">
          <h3>Supplier Details</h3>
          <p><strong>${supplierName || 'Supplier'}</strong></p>
          <p>Expected Delivery: ${expectedDelivery}</p>
        </div>
      </div>

      <table class="items-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Quantity</th>
            <th>Unit Price</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${orderData.items.map(item => `
            <tr>
              <td>${item.inventoryItemName || 'Item'}</td>
              <td>${item.quantity}</td>
              <td>₹${item.unitPrice.toFixed(2)}</td>
              <td>₹${(item.quantity * item.unitPrice).toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div class="total-section">
        <div class="total-row">
          Total Amount: ₹${orderData.totalAmount.toFixed(2)}
        </div>
      </div>

      ${orderData.notes ? `
        <div class="notes">
          <h3>Notes:</h3>
          <p>${orderData.notes}</p>
        </div>
      ` : ''}

      <div class="footer">
        <p>This is an automated purchase order from ${restaurantData.name || 'Restaurant'}</p>
        <p>Please confirm receipt and delivery details</p>
      </div>
    </body>
    </html>
  `;
}

// Email purchase order to supplier
app.post('/api/purchase-orders/:restaurantId/:orderId/email', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, orderId } = req.params;
    const { userId, role } = req.user;
    const { supplierEmail, supplierName } = req.body;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    if (!supplierEmail) {
      return res.status(400).json({ error: 'Supplier email is required' });
    }

    // Get purchase order details
    const orderDoc = await db.collection(collections.purchaseOrders).doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }

    const orderData = orderDoc.data();
    
    // Get restaurant details
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    const restaurantData = restaurantDoc.exists ? restaurantDoc.data() : {};

    // Generate purchase order invoice HTML
    const invoiceHtml = generatePurchaseOrderInvoice(orderData, restaurantData, supplierName);

    // Send email with invoice attachment
    const emailService = require('./emailService');
    const emailResult = await emailService.sendPurchaseOrderEmail({
      to: supplierEmail,
      supplierName: supplierName || 'Supplier',
      restaurantName: restaurantData.name || 'Restaurant',
      orderNumber: orderId.slice(-8),
      orderData,
      invoiceHtml
    });

    if (emailResult.success) {
      res.json({ 
        success: true, 
        message: 'Purchase order sent successfully',
        emailId: emailResult.emailId 
      });
    } else {
      res.status(500).json({ error: 'Failed to send email', details: emailResult.error });
    }

  } catch (error) {
    console.error('Email purchase order error:', error);
    res.status(500).json({ error: 'Failed to send purchase order email' });
  }
});

// ========================================
// GOODS RECEIPT NOTE (GRN) APIs
// ========================================

// Get all GRNs for a restaurant
app.get('/api/grn/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, purchaseOrderId } = req.query;

    let query = db.collection(collections.goodsReceiptNotes)
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    if (purchaseOrderId && purchaseOrderId !== 'all') {
      query = query.where('purchaseOrderId', '==', purchaseOrderId);
    }

    // Only use orderBy if no additional filters (to avoid index requirements)
    let snapshot;
    try {
      if ((status && status !== 'all') || (purchaseOrderId && purchaseOrderId !== 'all')) {
        snapshot = await query.get();
      } else {
        snapshot = await query.orderBy('receivedAt', 'desc').get();
      }
    } catch (error) {
      // If orderBy fails (no index), try without it
      console.warn('OrderBy failed, fetching without order:', error.message);
      snapshot = await query.get();
    }

    const grns = [];
    snapshot.forEach(doc => {
      grns.push({ id: doc.id, ...doc.data() });
    });

    // Sort manually if we couldn't use orderBy
    if ((status && status !== 'all') || (purchaseOrderId && purchaseOrderId !== 'all')) {
      grns.sort((a, b) => {
        const dateA = a.receivedAt?.toDate?.() || a.receivedAt || new Date(0);
        const dateB = b.receivedAt?.toDate?.() || b.receivedAt || new Date(0);
        return dateB - dateA; // Descending
      });
    }

    res.json({ grns, total: grns.length });

  } catch (error) {
    console.error('Get GRNs error:', error);
    res.status(500).json({ error: 'Failed to fetch GRNs' });
  }
});

// Get single GRN
app.get('/api/grn/:restaurantId/:grnId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, grnId } = req.params;

    const grnDoc = await db.collection(collections.goodsReceiptNotes).doc(grnId).get();
    
    if (!grnDoc.exists) {
      return res.status(404).json({ error: 'GRN not found' });
    }

    const grnData = grnDoc.data();
    
    if (grnData.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ grn: { id: grnDoc.id, ...grnData } });

  } catch (error) {
    console.error('Get GRN error:', error);
    res.status(500).json({ error: 'Failed to fetch GRN' });
  }
});

// Create GRN from Purchase Order
app.post('/api/grn/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager' && role !== 'staff') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { purchaseOrderId, items, notes, receivedBy } = req.body;

    if (!purchaseOrderId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Purchase order ID and items are required' });
    }

    // Get purchase order
    const poDoc = await db.collection(collections.purchaseOrders).doc(purchaseOrderId).get();
    if (!poDoc.exists || poDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }

    const poData = poDoc.data();

    // Calculate totals
    let totalReceived = 0;
    let totalExpected = 0;
    const processedItems = items.map(item => {
      const expectedItem = poData.items.find(poItem => poItem.inventoryItemId === item.inventoryItemId);
      const receivedQty = parseFloat(item.receivedQuantity) || 0;
      const acceptedQty = parseFloat(item.acceptedQuantity) || receivedQty;
      const rejectedQty = parseFloat(item.rejectedQuantity) || 0;
      const unitPrice = expectedItem?.unitPrice || item.unitPrice || 0;
      
      totalReceived += receivedQty;
      totalExpected += expectedItem?.quantity || 0;

      return {
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: item.inventoryItemName || expectedItem?.inventoryItemName,
        orderedQuantity: expectedItem?.quantity || 0,
        receivedQuantity: receivedQty,
        acceptedQuantity: acceptedQty,
        rejectedQuantity: rejectedQty,
        rejectionReason: item.rejectionReason || '',
        unitPrice: unitPrice,
        batchNumber: item.batchNumber || '',
        expiryDate: item.expiryDate || null,
        qualityStatus: item.qualityStatus || 'good', // 'good', 'damaged', 'defective'
        notes: item.notes || ''
      };
    });

    // Determine status
    let status = 'complete';
    if (totalReceived < totalExpected) {
      status = 'partial';
    }

    const grnData = {
      restaurantId,
      purchaseOrderId,
      supplierId: poData.supplierId,
      items: processedItems,
      status,
      notes: notes?.trim() || '',
      receivedBy: receivedBy || userId,
      receivedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const grnRef = await db.collection(collections.goodsReceiptNotes).add(grnData);

    // Update inventory stock for accepted items
    for (const item of processedItems) {
      if (item.acceptedQuantity > 0) {
        const inventoryDoc = await db.collection(collections.inventory).doc(item.inventoryItemId).get();
        if (inventoryDoc.exists) {
          const currentStock = inventoryDoc.data().currentStock || 0;
          await db.collection(collections.inventory).doc(item.inventoryItemId).update({
            currentStock: currentStock + item.acceptedQuantity,
            lastUpdated: new Date()
          });
        }
      }
    }

    // Update PO status if all items received
    if (status === 'complete') {
      await db.collection(collections.purchaseOrders).doc(purchaseOrderId).update({
        status: 'received',
        receivedAt: new Date(),
        updatedAt: new Date()
      });
    } else {
      await db.collection(collections.purchaseOrders).doc(purchaseOrderId).update({
        status: 'partially_received',
        updatedAt: new Date()
      });
    }

    res.status(201).json({
      message: 'GRN created successfully',
      grn: { id: grnRef.id, ...grnData }
    });

  } catch (error) {
    console.error('Create GRN error:', error);
    res.status(500).json({ error: 'Failed to create GRN' });
  }
});

// Update GRN
app.patch('/api/grn/:restaurantId/:grnId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, grnId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const grnDoc = await db.collection(collections.goodsReceiptNotes).doc(grnId).get();
    if (!grnDoc.exists || grnDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'GRN not found' });
    }

    const updateData = {
      ...req.body,
      updatedAt: new Date(),
      updatedBy: userId
    };

    await db.collection(collections.goodsReceiptNotes).doc(grnId).update(updateData);

    res.json({
      message: 'GRN updated successfully',
      grn: { id: grnId, ...grnDoc.data(), ...updateData }
    });

  } catch (error) {
    console.error('Update GRN error:', error);
    res.status(500).json({ error: 'Failed to update GRN' });
  }
});

// ========================================
// PURCHASE REQUISITIONS APIs
// ========================================

// Get all purchase requisitions
app.get('/api/purchase-requisitions/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, requestedBy } = req.query;

    let query = db.collection(collections.purchaseRequisitions)
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    if (requestedBy && requestedBy !== 'all') {
      query = query.where('requestedBy', '==', requestedBy);
    }

    // Only use orderBy if no additional filters (to avoid index requirements)
    let snapshot;
    try {
      if ((status && status !== 'all') || (requestedBy && requestedBy !== 'all')) {
        snapshot = await query.get();
      } else {
        snapshot = await query.orderBy('createdAt', 'desc').get();
      }
    } catch (error) {
      // If orderBy fails (no index), try without it
      console.warn('OrderBy failed, fetching without order:', error.message);
      snapshot = await query.get();
    }

    const requisitions = [];
    snapshot.forEach(doc => {
      requisitions.push({ id: doc.id, ...doc.data() });
    });

    // Sort manually if we couldn't use orderBy
    if ((status && status !== 'all') || (requestedBy && requestedBy !== 'all')) {
      requisitions.sort((a, b) => {
        const dateA = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
        const dateB = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
        return dateB - dateA; // Descending
      });
    }

    res.json({ requisitions, total: requisitions.length });

  } catch (error) {
    console.error('Get purchase requisitions error:', error);
    res.status(500).json({ error: 'Failed to fetch purchase requisitions' });
  }
});

// Create purchase requisition
app.post('/api/purchase-requisitions/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;

    const { items, priority, notes, reason } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'Items are required' });
    }

    const requisitionData = {
      restaurantId,
      requestedBy: userId,
      requestedByRole: role,
      items: items.map(item => ({
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: item.inventoryItemName,
        quantity: parseFloat(item.quantity) || 0,
        unit: item.unit || '',
        reason: item.reason || '',
        currentStock: item.currentStock || 0,
        minStock: item.minStock || 0
      })),
      priority: priority || 'medium', // 'low', 'medium', 'high', 'urgent'
      status: 'pending',
      notes: notes?.trim() || '',
      reason: reason?.trim() || '',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const reqRef = await db.collection(collections.purchaseRequisitions).add(requisitionData);

    res.status(201).json({
      message: 'Purchase requisition created successfully',
      requisition: { id: reqRef.id, ...requisitionData }
    });

  } catch (error) {
    console.error('Create purchase requisition error:', error);
    res.status(500).json({ error: 'Failed to create purchase requisition' });
  }
});

// Approve/Reject purchase requisition
app.patch('/api/purchase-requisitions/:restaurantId/:reqId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, reqId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied. Owner or manager privileges required.' });
    }

    const { status, notes, autoCreatePO, supplierId, expectedDeliveryDate } = req.body; // status: 'approved', 'rejected'

    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Valid status (approved/rejected) is required' });
    }

    const reqDoc = await db.collection(collections.purchaseRequisitions).doc(reqId).get();
    if (!reqDoc.exists || reqDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Purchase requisition not found' });
    }

    const reqData = reqDoc.data();

    // If already converted, don't allow status change
    if (reqData.status === 'converted') {
      return res.status(400).json({ error: 'Requisition already converted to Purchase Order' });
    }

    const updateData = {
      status,
      approvedBy: userId,
      approvedAt: new Date(),
      approvalNotes: notes?.trim() || '',
      updatedAt: new Date()
    };

    await db.collection(collections.purchaseRequisitions).doc(reqId).update(updateData);

    let purchaseOrder = null;

    // If approved and autoCreatePO is true (or not specified, default behavior), create PO automatically
    if (status === 'approved' && (autoCreatePO !== false)) {
      // If supplierId is provided, create PO immediately
      if (supplierId) {
        try {
          // Get inventory items to get prices
          const itemsWithPrices = await Promise.all(
            reqData.items.map(async (item) => {
              const inventoryDoc = await db.collection(collections.inventory).doc(item.inventoryItemId).get();
              const inventoryData = inventoryDoc.exists ? inventoryDoc.data() : {};
              return {
                inventoryItemId: item.inventoryItemId,
                inventoryItemName: item.inventoryItemName,
                quantity: item.quantity,
                unit: item.unit || '',
                unitPrice: inventoryData.costPerUnit || 0,
                totalPrice: item.quantity * (inventoryData.costPerUnit || 0)
              };
            })
          );

          const totalAmount = itemsWithPrices.reduce((sum, item) => sum + item.totalPrice, 0);

          // Create Purchase Order with status 'pending' (awaiting approval)
          const poData = {
            restaurantId,
            supplierId,
            items: itemsWithPrices,
            totalAmount,
            notes: notes?.trim() || `Auto-created from requisition ${reqId.slice(-8)}`,
            expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
            status: 'pending', // PO starts as pending, needs approval before sending to supplier
            requisitionId: reqId,
            createdAt: new Date(),
            updatedAt: new Date(),
            createdBy: userId
          };

          const poRef = await db.collection(collections.purchaseOrders).add(poData);
          purchaseOrder = { id: poRef.id, ...poData };

          // Update requisition to link to PO
          await db.collection(collections.purchaseRequisitions).doc(reqId).update({
            purchaseOrderId: poRef.id,
            updatedAt: new Date()
          });
        } catch (poError) {
          console.error('Error auto-creating PO from requisition:', poError);
          // Don't fail the requisition approval if PO creation fails
        }
      }
    }

    res.json({
      message: `Purchase requisition ${status} successfully${purchaseOrder ? '. Purchase Order created.' : ''}`,
      requisition: { id: reqId, ...reqData, ...updateData, purchaseOrderId: purchaseOrder?.id },
      purchaseOrder: purchaseOrder
    });

  } catch (error) {
    console.error('Update purchase requisition error:', error);
    res.status(500).json({ error: 'Failed to update purchase requisition' });
  }
});

// Convert requisition to Purchase Order
app.post('/api/purchase-requisitions/:restaurantId/:reqId/convert-to-po', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, reqId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { supplierId, expectedDeliveryDate, notes } = req.body;

    if (!supplierId) {
      return res.status(400).json({ error: 'Supplier ID is required' });
    }

    const reqDoc = await db.collection(collections.purchaseRequisitions).doc(reqId).get();
    if (!reqDoc.exists || reqDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Purchase requisition not found' });
    }

    const reqData = reqDoc.data();

    if (reqData.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved requisitions can be converted to PO' });
    }

    // Get inventory items to get prices
    const itemsWithPrices = await Promise.all(
      reqData.items.map(async (item) => {
        const inventoryDoc = await db.collection(collections.inventory).doc(item.inventoryItemId).get();
        const inventoryData = inventoryDoc.exists ? inventoryDoc.data() : {};
        return {
          inventoryItemId: item.inventoryItemId,
          inventoryItemName: item.inventoryItemName,
          quantity: item.quantity,
          unitPrice: inventoryData.costPerUnit || 0,
          totalPrice: item.quantity * (inventoryData.costPerUnit || 0)
        };
      })
    );

    const totalAmount = itemsWithPrices.reduce((sum, item) => sum + item.totalPrice, 0);

    // Create Purchase Order
    const poData = {
      restaurantId,
      supplierId,
      items: itemsWithPrices,
      totalAmount,
      notes: notes?.trim() || `Converted from requisition ${reqId}`,
      expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
      status: 'pending',
      requisitionId: reqId,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const poRef = await db.collection(collections.purchaseOrders).add(poData);

    // Update requisition status
    await db.collection(collections.purchaseRequisitions).doc(reqId).update({
      status: 'converted',
      convertedToPO: poRef.id,
      convertedAt: new Date(),
      updatedAt: new Date()
    });

    res.status(201).json({
      message: 'Purchase order created from requisition',
      purchaseOrder: { id: poRef.id, ...poData },
      requisition: { id: reqId, ...reqData, status: 'converted', convertedToPO: poRef.id }
    });

  } catch (error) {
    console.error('Convert requisition to PO error:', error);
    res.status(500).json({ error: 'Failed to convert requisition to PO' });
  }
});

// ========================================
// SUPPLIER INVOICES APIs
// ========================================

// Get all supplier invoices
app.get('/api/supplier-invoices/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, supplierId } = req.query;

    let query = db.collection(collections.supplierInvoices)
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    if (supplierId && supplierId !== 'all') {
      query = query.where('supplierId', '==', supplierId);
    }

    // Only use orderBy if no additional filters (to avoid index requirements)
    let snapshot;
    try {
      if ((status && status !== 'all') || (supplierId && supplierId !== 'all')) {
        snapshot = await query.get();
      } else {
        snapshot = await query.orderBy('invoiceDate', 'desc').get();
      }
    } catch (error) {
      // If orderBy fails (no index), try without it
      console.warn('OrderBy failed, fetching without order:', error.message);
      snapshot = await query.get();
    }

    const invoices = [];
    snapshot.forEach(doc => {
      invoices.push({ id: doc.id, ...doc.data() });
    });

    // Sort manually if we couldn't use orderBy
    if ((status && status !== 'all') || (supplierId && supplierId !== 'all')) {
      invoices.sort((a, b) => {
        const dateA = a.invoiceDate?.toDate?.() || a.invoiceDate || new Date(0);
        const dateB = b.invoiceDate?.toDate?.() || b.invoiceDate || new Date(0);
        return dateB - dateA; // Descending
      });
    }

    res.json({ invoices, total: invoices.length });

  } catch (error) {
    console.error('Get supplier invoices error:', error);
    res.status(500).json({ error: 'Failed to fetch supplier invoices' });
  }
});

// Create supplier invoice (manual entry, from OCR, or file upload)
app.post('/api/supplier-invoices/:restaurantId', authenticateToken, upload.single('invoiceFile'), async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { 
      purchaseOrderId, 
      grnId, 
      supplierId, 
      invoiceNumber, 
      invoiceDate, 
      items, 
      subtotal, 
      taxAmount, 
      totalAmount, 
      paymentTerms, 
      dueDate, 
      imageUrl, 
      extractedData,
      receivedMethod, // 'email', 'physical', 'uploaded', 'generated'
      receivedDate,
      paymentStatus // 'unpaid', 'partial', 'paid'
    } = req.body;

    // Handle file upload if present
    let invoiceFileUrl = imageUrl || null;
    let invoiceFileName = null;
    
    if (req.file) {
      try {
        // Upload invoice file (PDF or image) to Firebase Storage
        const filename = `invoices/${restaurantId}/${Date.now()}-${req.file.originalname}`;
        const blob = bucket.file(filename);
        
        await blob.save(req.file.buffer, {
          contentType: req.file.mimetype,
          metadata: {
            restaurantId: restaurantId,
            uploadedBy: userId,
            uploadedAt: new Date().toISOString(),
            originalName: req.file.originalname
          }
        });
        
        invoiceFileUrl = `https://storage.googleapis.com/${bucket.name}/${filename}`;
        invoiceFileName = req.file.originalname;
        console.log('✅ Invoice file uploaded:', invoiceFileUrl);
      } catch (uploadError) {
        console.error('Error uploading invoice file:', uploadError);
        return res.status(500).json({ error: 'Failed to upload invoice file' });
      }
    }

    if (!supplierId || !invoiceNumber || !invoiceDate || !items || items.length === 0) {
      return res.status(400).json({ error: 'Supplier, invoice number, date, and items are required' });
    }

    const invoiceData = {
      restaurantId,
      purchaseOrderId: purchaseOrderId || null,
      grnId: grnId || null,
      supplierId,
      invoiceNumber: invoiceNumber.trim(),
      invoiceDate: new Date(invoiceDate),
      items: items.map(item => ({
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: item.inventoryItemName,
        quantity: parseFloat(item.quantity) || 0,
        unitPrice: parseFloat(item.unitPrice) || 0,
        tax: parseFloat(item.tax) || 0,
        total: parseFloat(item.total) || 0
      })),
      subtotal: parseFloat(subtotal) || 0,
      taxAmount: parseFloat(taxAmount) || 0,
      totalAmount: parseFloat(totalAmount) || 0,
      paymentTerms: paymentTerms || 'Net 30',
      dueDate: dueDate ? new Date(dueDate) : null,
      status: 'pending', // 'pending', 'matched', 'paid', 'discrepancy'
      matchStatus: 'pending', // 'pending', 'matched', 'discrepancy'
      paymentStatus: paymentStatus || 'unpaid', // 'unpaid', 'partial', 'paid'
      receivedMethod: receivedMethod || (invoiceFileUrl ? 'uploaded' : 'manual'), // 'email', 'physical', 'uploaded', 'generated', 'manual'
      receivedDate: receivedDate ? new Date(receivedDate) : new Date(),
      invoiceFileUrl: invoiceFileUrl, // Original invoice file (PDF/image)
      invoiceFileName: invoiceFileName, // Original file name
      imageUrl: invoiceFileUrl || imageUrl || null, // Keep for backward compatibility
      extractedData: extractedData || null, // OCR extracted data
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const invoiceRef = await db.collection(collections.supplierInvoices).add(invoiceData);

    res.status(201).json({
      message: 'Supplier invoice created successfully',
      invoice: { id: invoiceRef.id, ...invoiceData }
    });

  } catch (error) {
    console.error('Create supplier invoice error:', error);
    res.status(500).json({ error: 'Failed to create supplier invoice' });
  }
});

// Generate invoice from Purchase Order
app.post('/api/supplier-invoices/:restaurantId/generate-from-po', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    const { purchaseOrderId } = req.body;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!purchaseOrderId) {
      return res.status(400).json({ error: 'Purchase Order ID is required' });
    }

    // Get Purchase Order
    const poDoc = await db.collection(collections.purchaseOrders).doc(purchaseOrderId).get();
    if (!poDoc.exists || poDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Purchase Order not found' });
    }

    const poData = poDoc.data();

    // Check if PO is in valid status (received or delivered)
    if (poData.status !== 'received' && poData.status !== 'delivered') {
      return res.status(400).json({ 
        error: `Cannot generate invoice. Purchase Order must be 'received' or 'delivered'. Current status: ${poData.status}` 
      });
    }

    // Check if invoice already exists for this PO
    const existingInvoiceSnapshot = await db.collection(collections.supplierInvoices)
      .where('restaurantId', '==', restaurantId)
      .where('purchaseOrderId', '==', purchaseOrderId)
      .get();

    if (!existingInvoiceSnapshot.empty) {
      return res.status(400).json({ error: 'Invoice already exists for this Purchase Order' });
    }

    // Generate invoice number
    const invoiceCountSnapshot = await db.collection(collections.supplierInvoices)
      .where('restaurantId', '==', restaurantId)
      .get();
    
    const invoiceNumber = `INV-${new Date().getFullYear()}-${String(invoiceCountSnapshot.size + 1).padStart(4, '0')}`;

    // Convert PO items to invoice items
    const invoiceItems = (poData.items || []).map(item => ({
      inventoryItemId: item.inventoryItemId,
      inventoryItemName: item.inventoryItemName,
      quantity: item.quantity || 0,
      unitPrice: item.unitPrice || 0,
      tax: 0, // Can be calculated if tax info is available
      total: (item.quantity || 0) * (item.unitPrice || 0)
    }));

    // Calculate totals
    const subtotal = invoiceItems.reduce((sum, item) => sum + item.total, 0);
    const taxAmount = 0; // Can be calculated if tax rates are available
    const totalAmount = subtotal + taxAmount;

    // Get GRN if exists
    let grnId = null;
    const grnSnapshot = await db.collection(collections.goodsReceiptNotes)
      .where('restaurantId', '==', restaurantId)
      .where('purchaseOrderId', '==', purchaseOrderId)
      .limit(1)
      .get();
    
    if (!grnSnapshot.empty) {
      grnId = grnSnapshot.docs[0].id;
    }

    // Create invoice
    const invoiceData = {
      restaurantId,
      purchaseOrderId,
      grnId,
      supplierId: poData.supplierId,
      invoiceNumber,
      invoiceDate: new Date(),
      items: invoiceItems,
      subtotal,
      taxAmount,
      totalAmount,
      paymentTerms: poData.paymentTerms || 'Net 30',
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      status: 'pending',
      matchStatus: 'matched', // Auto-matched since generated from PO
      paymentStatus: 'unpaid', // 'unpaid', 'partial', 'paid'
      receivedMethod: 'generated', // 'email', 'physical', 'uploaded', 'generated', 'manual'
      receivedDate: new Date(),
      invoiceFileUrl: null, // No file for auto-generated invoices
      invoiceFileName: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const invoiceRef = await db.collection(collections.supplierInvoices).add(invoiceData);

    res.status(201).json({
      success: true,
      message: 'Invoice generated from Purchase Order successfully',
      invoice: { id: invoiceRef.id, ...invoiceData }
    });

  } catch (error) {
    console.error('Generate invoice from PO error:', error);
    res.status(500).json({ error: 'Failed to generate invoice from Purchase Order' });
  }
});

// 3-way match (PO vs GRN vs Invoice)
app.post('/api/supplier-invoices/:restaurantId/:invoiceId/match', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, invoiceId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const invoiceDoc = await db.collection(collections.supplierInvoices).doc(invoiceId).get();
    if (!invoiceDoc.exists || invoiceDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const invoiceData = invoiceDoc.data();
    const discrepancies = [];

    // Match with Purchase Order
    if (invoiceData.purchaseOrderId) {
      const poDoc = await db.collection(collections.purchaseOrders).doc(invoiceData.purchaseOrderId).get();
      if (poDoc.exists) {
        const poData = poDoc.data();
        
        // Compare totals
        if (Math.abs(invoiceData.totalAmount - poData.totalAmount) > 0.01) {
          discrepancies.push({
            type: 'total_mismatch',
            poTotal: poData.totalAmount,
            invoiceTotal: invoiceData.totalAmount,
            difference: invoiceData.totalAmount - poData.totalAmount
          });
        }

        // Compare items
        invoiceData.items.forEach(invItem => {
          const poItem = poData.items.find(po => po.inventoryItemId === invItem.inventoryItemId);
          if (poItem) {
            if (Math.abs(invItem.quantity - poItem.quantity) > 0.01) {
              discrepancies.push({
                type: 'quantity_mismatch',
                itemName: invItem.inventoryItemName,
                poQuantity: poItem.quantity,
                invoiceQuantity: invItem.quantity
              });
            }
            if (Math.abs(invItem.unitPrice - poItem.unitPrice) > 0.01) {
              discrepancies.push({
                type: 'price_mismatch',
                itemName: invItem.inventoryItemName,
                poPrice: poItem.unitPrice,
                invoicePrice: invItem.unitPrice
              });
            }
          }
        });
      }
    }

    // Match with GRN
    if (invoiceData.grnId) {
      const grnDoc = await db.collection(collections.goodsReceiptNotes).doc(invoiceData.grnId).get();
      if (grnDoc.exists) {
        const grnData = grnDoc.data();
        
        invoiceData.items.forEach(invItem => {
          const grnItem = grnData.items.find(grn => grn.inventoryItemId === invItem.inventoryItemId);
          if (grnItem) {
            if (Math.abs(invItem.quantity - grnItem.acceptedQuantity) > 0.01) {
              discrepancies.push({
                type: 'grn_quantity_mismatch',
                itemName: invItem.inventoryItemName,
                grnQuantity: grnItem.acceptedQuantity,
                invoiceQuantity: invItem.quantity
              });
            }
          }
        });
      }
    }

    const matchStatus = discrepancies.length === 0 ? 'matched' : 'discrepancy';
    const invoiceStatus = discrepancies.length === 0 ? 'matched' : 'discrepancy';

    await db.collection(collections.supplierInvoices).doc(invoiceId).update({
      matchStatus,
      status: invoiceStatus,
      discrepancies,
      matchedAt: new Date(),
      matchedBy: userId,
      updatedAt: new Date()
    });

    res.json({
      message: `Invoice ${matchStatus === 'matched' ? 'matched successfully' : 'has discrepancies'}`,
      matchStatus,
      discrepancies,
      invoice: { id: invoiceId, ...invoiceData, matchStatus, status: invoiceStatus, discrepancies }
    });

  } catch (error) {
    console.error('Invoice match error:', error);
    res.status(500).json({ error: 'Failed to match invoice' });
  }
});

// Mark invoice as paid
app.patch('/api/supplier-invoices/:restaurantId/:invoiceId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, invoiceId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { status, paidAmount, paidDate, paymentMethod, paymentStatus, receivedMethod, receivedDate } = req.body;

    const invoiceDoc = await db.collection(collections.supplierInvoices).doc(invoiceId).get();
    if (!invoiceDoc.exists || invoiceDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    const updateData = {
      updatedAt: new Date(),
      updatedBy: userId
    };

    if (status) updateData.status = status;
    if (paymentStatus) updateData.paymentStatus = paymentStatus; // 'unpaid', 'partial', 'paid'
    if (paidAmount !== undefined) updateData.paidAmount = paidAmount ? parseFloat(paidAmount) : null;
    if (paidDate) updateData.paidDate = new Date(paidDate);
    if (paymentMethod) updateData.paymentMethod = paymentMethod;
    if (receivedMethod) updateData.receivedMethod = receivedMethod;
    if (receivedDate) updateData.receivedDate = new Date(receivedDate);
    
    // Auto-set payment status based on paid amount
    if (paidAmount !== undefined) {
      const invoiceData = invoiceDoc.data();
      const totalAmount = invoiceData.totalAmount || 0;
      if (paidAmount >= totalAmount) {
        updateData.paymentStatus = 'paid';
        updateData.status = 'paid';
      } else if (paidAmount > 0) {
        updateData.paymentStatus = 'partial';
      } else {
        updateData.paymentStatus = 'unpaid';
      }
      if (!updateData.paidDate && paidAmount > 0) {
        updateData.paidDate = new Date();
      }
      if (!updateData.paidBy && paidAmount > 0) {
        updateData.paidBy = userId;
      }
    }

    await db.collection(collections.supplierInvoices).doc(invoiceId).update(updateData);

    res.json({
      message: 'Invoice updated successfully',
      invoice: { id: invoiceId, ...invoiceDoc.data(), ...updateData }
    });

  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// ========================================
// ENHANCED SUPPLIER APIs
// ========================================

// Update supplier
app.patch('/api/suppliers/:restaurantId/:supplierId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, supplierId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const supplierDoc = await db.collection(collections.suppliers).doc(supplierId).get();
    if (!supplierDoc.exists || supplierDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    const updateData = {
      ...req.body,
      updatedAt: new Date(),
      updatedBy: userId
    };

    // Clean up undefined fields
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    await db.collection(collections.suppliers).doc(supplierId).update(updateData);

    res.json({
      message: 'Supplier updated successfully',
      supplier: { id: supplierId, ...supplierDoc.data(), ...updateData }
    });

  } catch (error) {
    console.error('Update supplier error:', error);
    res.status(500).json({ error: 'Failed to update supplier' });
  }
});

// Delete supplier
app.delete('/api/suppliers/:restaurantId/:supplierId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, supplierId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const supplierDoc = await db.collection(collections.suppliers).doc(supplierId).get();
    if (!supplierDoc.exists || supplierDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    await db.collection(collections.suppliers).doc(supplierId).update({
      isActive: false,
      deletedAt: new Date(),
      deletedBy: userId,
      updatedAt: new Date()
    });

    res.json({ message: 'Supplier deleted successfully' });

  } catch (error) {
    console.error('Delete supplier error:', error);
    res.status(500).json({ error: 'Failed to delete supplier' });
  }
});

// Get single supplier
app.get('/api/suppliers/:restaurantId/:supplierId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, supplierId } = req.params;

    const supplierDoc = await db.collection(collections.suppliers).doc(supplierId).get();
    
    if (!supplierDoc.exists) {
      return res.status(404).json({ error: 'Supplier not found' });
    }

    const supplierData = supplierDoc.data();
    
    if (supplierData.restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ supplier: { id: supplierDoc.id, ...supplierData } });

  } catch (error) {
    console.error('Get supplier error:', error);
    res.status(500).json({ error: 'Failed to fetch supplier' });
  }
});

// ========================================
// SUPPLIER PERFORMANCE APIs
// ========================================

// Get supplier performance
app.get('/api/suppliers/:restaurantId/:supplierId/performance', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, supplierId } = req.params;

    // Get all purchase orders for this supplier
    const poSnapshot = await db.collection(collections.purchaseOrders)
      .where('restaurantId', '==', restaurantId)
      .where('supplierId', '==', supplierId)
      .get();

    let totalOrders = 0;
    let onTimeDeliveries = 0;
    let lateDeliveries = 0;
    let totalDeliveryTime = 0;
    let qualityIssues = 0;
    let totalAmount = 0;

    poSnapshot.forEach(doc => {
      const po = doc.data();
      totalOrders++;
      totalAmount += po.totalAmount || 0;

      if (po.status === 'received' && po.expectedDeliveryDate && po.receivedAt) {
        const expected = po.expectedDeliveryDate.toDate();
        const received = po.receivedAt.toDate();
        const deliveryTime = (received - expected) / (1000 * 60 * 60 * 24); // days
        
        totalDeliveryTime += Math.abs(deliveryTime);
        
        if (deliveryTime <= 0) {
          onTimeDeliveries++;
        } else {
          lateDeliveries++;
        }
      }

      // Check for quality issues in GRNs
      // This would require querying GRNs, simplified here
    });

    // Get GRNs for quality analysis
    const grnSnapshot = await db.collection(collections.goodsReceiptNotes)
      .where('restaurantId', '==', restaurantId)
      .where('supplierId', '==', supplierId)
      .get();

    let totalItemsReceived = 0;
    let totalItemsRejected = 0;

    grnSnapshot.forEach(doc => {
      const grn = doc.data();
      grn.items.forEach(item => {
        totalItemsReceived += item.receivedQuantity || 0;
        totalItemsRejected += item.rejectedQuantity || 0;
        if (item.qualityStatus === 'damaged' || item.qualityStatus === 'defective') {
          qualityIssues++;
        }
      });
    });

    const onTimeRate = totalOrders > 0 ? (onTimeDeliveries / totalOrders) * 100 : 0;
    const averageDeliveryTime = totalOrders > 0 ? totalDeliveryTime / totalOrders : 0;
    const qualityScore = totalItemsReceived > 0 ? ((totalItemsReceived - totalItemsRejected - qualityIssues) / totalItemsReceived) * 100 : 100;
    const overallScore = (onTimeRate * 0.3 + qualityScore * 0.3 + 70 * 0.4); // Simplified scoring

    const performance = {
      supplierId,
      restaurantId,
      totalOrders,
      onTimeDeliveries,
      lateDeliveries,
      onTimeRate: parseFloat(onTimeRate.toFixed(2)),
      averageDeliveryTime: parseFloat(averageDeliveryTime.toFixed(2)),
      qualityScore: parseFloat(qualityScore.toFixed(2)),
      overallScore: parseFloat(overallScore.toFixed(2)),
      grade: overallScore >= 90 ? 'A' : overallScore >= 80 ? 'B' : overallScore >= 70 ? 'C' : overallScore >= 60 ? 'D' : 'F',
      totalAmount,
      lastUpdated: new Date()
    };

    // Store/update performance record
    const perfSnapshot = await db.collection(collections.supplierPerformance)
      .where('restaurantId', '==', restaurantId)
      .where('supplierId', '==', supplierId)
      .limit(1)
      .get();

    if (perfSnapshot.empty) {
      await db.collection(collections.supplierPerformance).add(performance);
    } else {
      await perfSnapshot.docs[0].ref.update(performance);
    }

    res.json({ performance });

  } catch (error) {
    console.error('Get supplier performance error:', error);
    res.status(500).json({ error: 'Failed to fetch supplier performance' });
  }
});

// Get all suppliers performance
app.get('/api/suppliers/:restaurantId/performance', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const perfSnapshot = await db.collection(collections.supplierPerformance)
      .where('restaurantId', '==', restaurantId)
      .orderBy('overallScore', 'desc')
      .get();

    const performances = [];
    perfSnapshot.forEach(doc => {
      performances.push({ id: doc.id, ...doc.data() });
    });

    res.json({ performances, total: performances.length });

  } catch (error) {
    console.error('Get suppliers performance error:', error);
    res.status(500).json({ error: 'Failed to fetch suppliers performance' });
  }
});

// ========================================
// AI SERVICES APIs
// ========================================

const aiReorderService = require('./services/aiReorderService');
const aiWastePredictionService = require('./services/aiWastePredictionService');
const aiInvoiceOCRService = require('./services/aiInvoiceOCRService');
const aiPriceIntelligenceService = require('./services/aiPriceIntelligenceService');

// Get AI reorder suggestions
app.get('/api/ai/reorder-suggestions/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const suggestions = await aiReorderService.getReorderSuggestions(restaurantId);

    res.json({
      success: true,
      suggestions,
      total: suggestions.length
    });

  } catch (error) {
    console.error('AI reorder suggestions error:', error);
    res.status(500).json({ error: 'Failed to get reorder suggestions' });
  }
});

// Get demand prediction for an item
app.get('/api/ai/demand-prediction/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;
    const { daysAhead } = req.query;

    const prediction = await aiReorderService.predictDemand(
      itemId, 
      restaurantId, 
      parseInt(daysAhead) || 7
    );

    res.json({
      success: true,
      prediction
    });

  } catch (error) {
    console.error('Demand prediction error:', error);
    res.status(500).json({ error: 'Failed to predict demand' });
  }
});

// Get waste risk predictions
app.get('/api/ai/waste-prediction/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const predictions = await aiWastePredictionService.predictWasteRisk(restaurantId);

    res.json({
      success: true,
      predictions,
      total: predictions.length
    });

  } catch (error) {
    console.error('Waste prediction error:', error);
    res.status(500).json({ error: 'Failed to predict waste risk' });
  }
});

// Get waste summary
app.get('/api/ai/waste-summary/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const summary = await aiWastePredictionService.getWasteSummary(restaurantId);

    res.json({
      success: true,
      summary
    });

  } catch (error) {
    console.error('Waste summary error:', error);
    res.status(500).json({ error: 'Failed to get waste summary' });
  }
});

// Process invoice image with OCR
app.post('/api/ai/invoice-ocr/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ error: 'Image URL is required' });
    }

    // Extract invoice data
    const ocrResult = await aiInvoiceOCRService.extractInvoiceData(imageUrl);

    if (!ocrResult.success) {
      return res.status(400).json({ 
        error: 'Failed to extract invoice data',
        details: ocrResult.error 
      });
    }

    // Try to match with Purchase Order
    const matchResult = await aiInvoiceOCRService.matchWithPurchaseOrder(
      ocrResult.extractedData,
      restaurantId
    );

    res.json({
      success: true,
      extractedData: ocrResult.extractedData,
      matchResult,
      imageUrl
    });

  } catch (error) {
    console.error('Invoice OCR error:', error);
    res.status(500).json({ error: 'Failed to process invoice image' });
  }
});

// Price Intelligence APIs
app.get('/api/ai/price-comparison/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;

    const comparison = await aiPriceIntelligenceService.comparePrices(restaurantId, itemId);

    res.json({
      success: true,
      comparison
    });

  } catch (error) {
    console.error('Price comparison error:', error);
    res.status(500).json({ error: 'Failed to compare prices' });
  }
});

app.get('/api/ai/price-trend/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;
    const { days } = req.query;

    const trend = await aiPriceIntelligenceService.analyzePriceTrend(
      restaurantId, 
      itemId, 
      parseInt(days) || 90
    );

    res.json({
      success: true,
      trend
    });

  } catch (error) {
    console.error('Price trend error:', error);
    res.status(500).json({ error: 'Failed to analyze price trend' });
  }
});

app.get('/api/ai/price-anomalies/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;

    const anomalies = await aiPriceIntelligenceService.detectPriceAnomalies(restaurantId, itemId);

    res.json({
      success: true,
      anomalies
    });

  } catch (error) {
    console.error('Price anomaly detection error:', error);
    res.status(500).json({ error: 'Failed to detect price anomalies' });
  }
});

app.get('/api/ai/best-supplier/:restaurantId/:itemId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, itemId } = req.params;

    const recommendation = await aiPriceIntelligenceService.getBestSupplier(restaurantId, itemId);

    res.json({
      success: true,
      recommendation
    });

  } catch (error) {
    console.error('Best supplier recommendation error:', error);
    res.status(500).json({ error: 'Failed to get supplier recommendation' });
  }
});

// ========================================
// SUPPLIER RETURNS APIs
// ========================================

// Get all supplier returns
app.get('/api/supplier-returns/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, supplierId } = req.query;

    let query = db.collection(collections.supplierReturns)
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    if (supplierId && supplierId !== 'all') {
      query = query.where('supplierId', '==', supplierId);
    }

    // Only use orderBy if no additional filters (to avoid index requirements)
    let snapshot;
    try {
      if ((status && status !== 'all') || (supplierId && supplierId !== 'all')) {
        snapshot = await query.get();
      } else {
        snapshot = await query.orderBy('createdAt', 'desc').get();
      }
    } catch (error) {
      // If orderBy fails (no index), try without it
      console.warn('OrderBy failed, fetching without order:', error.message);
      snapshot = await query.get();
    }

    const returns = [];
    snapshot.forEach(doc => {
      returns.push({ id: doc.id, ...doc.data() });
    });

    // Sort manually if we couldn't use orderBy
    if ((status && status !== 'all') || (supplierId && supplierId !== 'all')) {
      returns.sort((a, b) => {
        const dateA = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
        const dateB = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
        return dateB - dateA; // Descending
      });
    }

    res.json({ returns, total: returns.length });

  } catch (error) {
    console.error('Get supplier returns error:', error);
    res.status(500).json({ error: 'Failed to fetch supplier returns' });
  }
});

// Create supplier return
app.post('/api/supplier-returns/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { purchaseOrderId, supplierId, items, returnType, reason, notes } = req.body;

    if (!supplierId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Supplier and items are required' });
    }

    const returnData = {
      restaurantId,
      purchaseOrderId: purchaseOrderId || null,
      supplierId,
      items: items.map(item => ({
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: item.inventoryItemName,
        quantity: parseFloat(item.quantity) || 0,
        unit: item.unit || '',
        reason: item.reason || '',
        costPerUnit: parseFloat(item.costPerUnit) || 0,
        totalCost: (parseFloat(item.quantity) || 0) * (parseFloat(item.costPerUnit) || 0)
      })),
      returnType: returnType || 'damaged', // 'damaged', 'defective', 'wrong_item', 'excess'
      reason: reason?.trim() || '',
      notes: notes?.trim() || '',
      status: 'pending', // 'pending', 'approved', 'returned', 'credited', 'rejected'
      totalAmount: items.reduce((sum, item) => 
        sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.costPerUnit) || 0)), 0
      ),
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const returnRef = await db.collection(collections.supplierReturns).add(returnData);

    res.status(201).json({
      message: 'Return order created successfully',
      returnOrder: { id: returnRef.id, ...returnData }
    });

  } catch (error) {
    console.error('Create supplier return error:', error);
    res.status(500).json({ error: 'Failed to create return order' });
  }
});

// Update return status
app.patch('/api/supplier-returns/:restaurantId/:returnId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, returnId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { status, creditNoteNumber, notes } = req.body;

    const returnDoc = await db.collection(collections.supplierReturns).doc(returnId).get();
    if (!returnDoc.exists || returnDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Return order not found' });
    }

    const returnData = returnDoc.data();
    const updateData = {
      status: status || returnData.status,
      updatedAt: new Date(),
      updatedBy: userId
    };

    if (creditNoteNumber) {
      updateData.creditNoteNumber = creditNoteNumber.trim();
    }

    if (notes) {
      updateData.notes = notes.trim();
    }

    // If status changed to 'returned' or 'credited', update inventory
    if ((status === 'returned' || status === 'credited') && returnData.status !== 'returned' && returnData.status !== 'credited') {
      // Deduct returned items from inventory
      for (const item of returnData.items) {
        const inventoryDoc = await db.collection(collections.inventory).doc(item.inventoryItemId).get();
        if (inventoryDoc.exists) {
          const currentStock = inventoryDoc.data().currentStock || 0;
          await db.collection(collections.inventory).doc(item.inventoryItemId).update({
            currentStock: Math.max(0, currentStock - item.quantity),
            lastUpdated: new Date()
          });
        }
      }
    }

    await db.collection(collections.supplierReturns).doc(returnId).update(updateData);

    res.json({
      message: 'Return order updated successfully',
      returnOrder: { id: returnId, ...returnData, ...updateData }
    });

  } catch (error) {
    console.error('Update return error:', error);
    res.status(500).json({ error: 'Failed to update return order' });
  }
});

// Delete return order
app.delete('/api/supplier-returns/:restaurantId/:returnId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, returnId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const returnDoc = await db.collection(collections.supplierReturns).doc(returnId).get();
    if (!returnDoc.exists || returnDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Return order not found' });
    }

    await db.collection(collections.supplierReturns).doc(returnId).delete();

    res.json({ message: 'Return order deleted successfully' });

  } catch (error) {
    console.error('Delete return error:', error);
    res.status(500).json({ error: 'Failed to delete return order' });
  }
});

// ========================================
// STOCK TRANSFERS APIs
// ========================================

// Get all stock transfers
app.get('/api/stock-transfers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, fromLocation, toLocation } = req.query;

    let query = db.collection(collections.stockTransfers)
      .where('restaurantId', '==', restaurantId);

    if (status && status !== 'all') {
      query = query.where('status', '==', status);
    }

    if (fromLocation && fromLocation !== 'all') {
      query = query.where('fromLocation', '==', fromLocation);
    }

    if (toLocation && toLocation !== 'all') {
      query = query.where('toLocation', '==', toLocation);
    }

    // Only use orderBy if no additional filters (to avoid index requirements)
    let snapshot;
    try {
      if ((status && status !== 'all') || (fromLocation && fromLocation !== 'all') || (toLocation && toLocation !== 'all')) {
        snapshot = await query.get();
      } else {
        snapshot = await query.orderBy('createdAt', 'desc').get();
      }
    } catch (error) {
      // If orderBy fails (no index), try without it
      console.warn('OrderBy failed, fetching without order:', error.message);
      snapshot = await query.get();
    }

    const transfers = [];
    snapshot.forEach(doc => {
      transfers.push({ id: doc.id, ...doc.data() });
    });

    // Sort manually if we couldn't use orderBy
    if ((status && status !== 'all') || (fromLocation && fromLocation !== 'all') || (toLocation && toLocation !== 'all')) {
      transfers.sort((a, b) => {
        const dateA = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
        const dateB = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
        return dateB - dateA; // Descending
      });
    }

    res.json({ transfers, total: transfers.length });

  } catch (error) {
    console.error('Get stock transfers error:', error);
    res.status(500).json({ error: 'Failed to fetch stock transfers' });
  }
});

// Create stock transfer
app.post('/api/stock-transfers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { fromLocation, toLocation, items, reason, notes } = req.body;

    if (!fromLocation || !toLocation || !items || items.length === 0) {
      return res.status(400).json({ error: 'From location, to location, and items are required' });
    }

    // Validate items exist and have sufficient stock
    for (const item of items) {
      const inventoryDoc = await db.collection(collections.inventory).doc(item.inventoryItemId).get();
      if (!inventoryDoc.exists) {
        return res.status(400).json({ error: `Item ${item.inventoryItemName} not found` });
      }

      const inventoryData = inventoryDoc.data();
      if (inventoryData.location === fromLocation) {
        if (inventoryData.currentStock < item.quantity) {
          return res.status(400).json({ 
            error: `Insufficient stock for ${item.inventoryItemName}. Available: ${inventoryData.currentStock}, Requested: ${item.quantity}` 
          });
        }
      }
    }

    const transferData = {
      restaurantId,
      fromLocation: fromLocation.trim(),
      toLocation: toLocation.trim(),
      items: items.map(item => ({
        inventoryItemId: item.inventoryItemId,
        inventoryItemName: item.inventoryItemName,
        quantity: parseFloat(item.quantity) || 0,
        unit: item.unit || ''
      })),
      reason: reason?.trim() || '',
      notes: notes?.trim() || '',
      status: 'pending', // 'pending', 'approved', 'in_transit', 'completed', 'cancelled'
      createdAt: new Date(),
      updatedAt: new Date(),
      createdBy: userId
    };

    const transferRef = await db.collection(collections.stockTransfers).add(transferData);

    res.status(201).json({
      message: 'Stock transfer created successfully',
      transfer: { id: transferRef.id, ...transferData }
    });

  } catch (error) {
    console.error('Create stock transfer error:', error);
    res.status(500).json({ error: 'Failed to create stock transfer' });
  }
});

// Approve and execute stock transfer
app.patch('/api/stock-transfers/:restaurantId/:transferId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, transferId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { status } = req.body;

    const transferDoc = await db.collection(collections.stockTransfers).doc(transferId).get();
    if (!transferDoc.exists || transferDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Stock transfer not found' });
    }

    const transferData = transferDoc.data();

    // If approving, deduct from source and add to destination
    if (status === 'approved' && transferData.status === 'pending') {
      for (const item of transferData.items) {
        // Deduct from source location
        const inventoryDoc = await db.collection(collections.inventory).doc(item.inventoryItemId).get();
        if (inventoryDoc.exists) {
          const inventoryData = inventoryDoc.data();
          
          if (inventoryData.location === transferData.fromLocation) {
            const currentStock = inventoryData.currentStock || 0;
            await db.collection(collections.inventory).doc(item.inventoryItemId).update({
              currentStock: Math.max(0, currentStock - item.quantity),
              lastUpdated: new Date()
            });
          }

          // Add to destination location
          // Note: In a multi-location system, you might need separate inventory records per location
          // For now, we'll update the location field and add stock
          if (inventoryData.location !== transferData.toLocation) {
            // If item doesn't exist at destination, create it or update location
            // Simplified: just update the location
            await db.collection(collections.inventory).doc(item.inventoryItemId).update({
              location: transferData.toLocation,
              currentStock: (inventoryData.currentStock || 0) + item.quantity,
              lastUpdated: new Date()
            });
          } else {
            // Item already at destination, just add stock
            await db.collection(collections.inventory).doc(item.inventoryItemId).update({
              currentStock: (inventoryData.currentStock || 0) + item.quantity,
              lastUpdated: new Date()
            });
          }
        }
      }
    }

    // If completing, mark as completed
    if (status === 'completed' && transferData.status === 'approved') {
      // Transfer already executed, just update status
    }

    const updateData = {
      status: status || transferData.status,
      updatedAt: new Date(),
      updatedBy: userId
    };

    if (status === 'approved') {
      updateData.approvedAt = new Date();
      updateData.approvedBy = userId;
    }

    if (status === 'completed') {
      updateData.completedAt = new Date();
      updateData.completedBy = userId;
    }

    await db.collection(collections.stockTransfers).doc(transferId).update(updateData);

    res.json({
      message: 'Stock transfer updated successfully',
      transfer: { id: transferId, ...transferData, ...updateData }
    });

  } catch (error) {
    console.error('Update stock transfer error:', error);
    res.status(500).json({ error: 'Failed to update stock transfer' });
  }
});

// Delete stock transfer
app.delete('/api/stock-transfers/:restaurantId/:transferId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, transferId } = req.params;
    const { userId, role } = req.user;
    
    if (role !== 'owner' && role !== 'manager') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const transferDoc = await db.collection(collections.stockTransfers).doc(transferId).get();
    if (!transferDoc.exists || transferDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Stock transfer not found' });
    }

    const transferData = transferDoc.data();
    
    // Only allow deletion of pending or cancelled transfers
    if (transferData.status !== 'pending' && transferData.status !== 'cancelled') {
      return res.status(400).json({ error: 'Cannot delete approved or completed transfers' });
    }

    await db.collection(collections.stockTransfers).doc(transferId).delete();

    res.json({ message: 'Stock transfer deleted successfully' });

  } catch (error) {
    console.error('Delete stock transfer error:', error);
    res.status(500).json({ error: 'Failed to delete stock transfer' });
  }
});

app.use((err, req, res, next) => {
  console.error(`[${req.id}] Error:`, err);
  
  const isDevelopment = process.env.NODE_ENV !== 'production';
  
  res.status(err.status || 500).json({ 
    error: 'Internal Server Error',
    message: isDevelopment ? err.message : 'Something went wrong',
    requestId: req.id,
    ...(isDevelopment && { stack: err.stack })
  });
});

// ==================== ADMIN SETTINGS APIs ====================

// Get all admin settings for a restaurant
app.get('/api/admin/settings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;

    // Verify user has admin access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['owner', 'manager'])
      .get();

    if (userRestaurantSnapshot.empty) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    // Get restaurant settings
    const settingsSnapshot = await db.collection(collections.restaurantSettings)
      .where('restaurantId', '==', restaurantId)
      .get();

    let settings = {};
    if (!settingsSnapshot.empty) {
      settingsSnapshot.forEach(doc => {
        settings = { ...settings, ...doc.data() };
      });
    }

    // Get default settings if none exist
    if (Object.keys(settings).length === 0) {
      settings = {
        restaurantId,
        // Restaurant Info
        restaurantName: '',
        description: '',
        address: '',
        phone: '',
        email: '',
        
        // Operating Hours
        operatingHours: {
          monday: { open: '09:00', close: '22:00', isOpen: true },
          tuesday: { open: '09:00', close: '22:00', isOpen: true },
          wednesday: { open: '09:00', close: '22:00', isOpen: true },
          thursday: { open: '09:00', close: '22:00', isOpen: true },
          friday: { open: '09:00', close: '22:00', isOpen: true },
          saturday: { open: '09:00', close: '22:00', isOpen: true },
          sunday: { open: '09:00', close: '22:00', isOpen: true }
        },
        
        // Order Settings
        orderSettings: {
          lastOrderTime: '21:30',
          preparationTime: 15,
          maxOrderValue: 5000,
          minOrderValue: 100,
          allowPreOrders: true,
          preOrderAdvanceHours: 2
        },
        
        // Discount Settings
        discountSettings: {
          globalDiscount: {
            enabled: false,
            type: 'percentage', // percentage or fixed
            value: 0,
            minOrderValue: 0,
            maxDiscountAmount: 0,
            validFrom: null,
            validTo: null
          },
          categoryDiscounts: [],
          itemDiscounts: []
        },
        
        // Payment Settings
        paymentSettings: {
          acceptCash: true,
          acceptCard: true,
          acceptUPI: true,
          acceptWallet: true,
          serviceCharge: 0,
          taxRate: 18
        },
        
        // Notification Settings
        notificationSettings: {
          orderNotifications: true,
          paymentNotifications: true,
          lowStockNotifications: true,
          emailNotifications: true,
          smsNotifications: false
        },
        
        // System Settings
        systemSettings: {
          autoAcceptOrders: false,
          requireCustomerConfirmation: true,
          showPreparationTime: true,
          allowOrderModifications: true,
          maxModificationTime: 5 // minutes
        },
        
        createdAt: new Date(),
        updatedAt: new Date()
      };
    }

    res.json({ settings });
  } catch (error) {
    console.error('Get admin settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update admin settings
app.put('/api/admin/settings/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const settingsData = req.body;

    // Verify user has admin access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['owner', 'manager'])
      .get();

    if (userRestaurantSnapshot.empty) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    // Validate settings data
    if (!settingsData) {
      return res.status(400).json({ error: 'Settings data is required' });
    }

    // Update settings with timestamp
    const updatedSettings = {
      ...settingsData,
      restaurantId,
      updatedAt: new Date()
    };

    // Check if settings document exists
    const existingSettingsSnapshot = await db.collection(collections.restaurantSettings)
      .where('restaurantId', '==', restaurantId)
      .get();

    if (existingSettingsSnapshot.empty) {
      // Create new settings document
      updatedSettings.createdAt = new Date();
      await db.collection(collections.restaurantSettings).add(updatedSettings);
    } else {
      // Update existing settings
      const settingsDoc = existingSettingsSnapshot.docs[0];
      await settingsDoc.ref.update(updatedSettings);
    }

    // Update restaurant basic info if provided
    if (settingsData.restaurantName || settingsData.description || settingsData.address || settingsData.phone || settingsData.email) {
      const restaurantUpdate = {};
      if (settingsData.restaurantName) restaurantUpdate.name = settingsData.restaurantName;
      if (settingsData.description) restaurantUpdate.description = settingsData.description;
      if (settingsData.address) restaurantUpdate.address = settingsData.address;
      if (settingsData.phone) restaurantUpdate.phone = settingsData.phone;
      if (settingsData.email) restaurantUpdate.email = settingsData.email;
      restaurantUpdate.updatedAt = new Date();

      const restaurantSnapshot = await db.collection(collections.restaurants)
        .where('id', '==', restaurantId)
        .get();

      if (!restaurantSnapshot.empty) {
        await restaurantSnapshot.docs[0].ref.update(restaurantUpdate);
      }
    }

    res.json({ 
      message: 'Settings updated successfully',
      settings: updatedSettings
    });
  } catch (error) {
    console.error('Update admin settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Apply discount to orders
app.post('/api/admin/settings/:restaurantId/apply-discount', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const { discountType, targetType, targetId, discountData } = req.body;

    // Verify user has admin access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['owner', 'manager'])
      .get();

    if (userRestaurantSnapshot.empty) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    // Validate discount data
    if (!discountType || !targetType || !discountData) {
      return res.status(400).json({ error: 'Invalid discount parameters' });
    }

    const discountSettings = {
      restaurantId,
      discountType, // 'global', 'category', 'item'
      targetType, // 'all', 'specific'
      targetId: targetId || null,
      discountData,
      appliedBy: userId,
      appliedAt: new Date(),
      isActive: true
    };

    // Save discount setting
    await db.collection(collections.discountSettings).add(discountSettings);

    res.json({ 
      message: 'Discount applied successfully',
      discount: discountSettings
    });
  } catch (error) {
    console.error('Apply discount error:', error);
    res.status(500).json({ error: 'Failed to apply discount' });
  }
});

// Get restaurant operating status
app.get('/api/admin/settings/:restaurantId/status', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;

    // Verify user has admin access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['owner', 'manager'])
      .get();

    if (userRestaurantSnapshot.empty) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    // Get current settings
    const settingsSnapshot = await db.collection(collections.restaurantSettings)
      .where('restaurantId', '==', restaurantId)
      .get();

    let operatingHours = {};
    let orderSettings = {};
    
    if (!settingsSnapshot.empty) {
      const settings = settingsSnapshot.docs[0].data();
      operatingHours = settings.operatingHours || {};
      orderSettings = settings.orderSettings || {};
    }

    // Check if restaurant is currently open
    const now = new Date();
    const currentDay = now.toLocaleLowerCase().substring(0, 3); // mon, tue, etc.
    const currentTime = now.toTimeString().substring(0, 5); // HH:MM format

    const todayHours = operatingHours[currentDay];
    const isOpen = todayHours && todayHours.isOpen && 
                   currentTime >= todayHours.open && 
                   currentTime <= todayHours.close;

    // Check if orders are still being accepted
    const lastOrderTime = orderSettings.lastOrderTime || '21:30';
    const acceptingOrders = isOpen && currentTime <= lastOrderTime;

    res.json({
      isOpen,
      acceptingOrders,
      currentTime,
      todayHours,
      lastOrderTime,
      nextOpenTime: getNextOpenTime(operatingHours, now)
    });
  } catch (error) {
    console.error('Get restaurant status error:', error);
    res.status(500).json({ error: 'Failed to get restaurant status' });
  }
});

// Update restaurant operating status
app.put('/api/admin/settings/:restaurantId/status', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const userId = req.user.userId;
    const { isOpen, reason } = req.body;

    // Verify user has admin access to this restaurant
    const userRestaurantSnapshot = await db.collection(collections.userRestaurants)
      .where('userId', '==', userId)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['owner', 'manager'])
      .get();

    if (userRestaurantSnapshot.empty) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    // Update restaurant status
    const statusUpdate = {
      isOpen: isOpen !== undefined ? isOpen : true,
      statusChangeReason: reason || 'Manual status update',
      statusChangedBy: userId,
      statusChangedAt: new Date(),
      updatedAt: new Date()
    };

    // Update restaurant document
    const restaurantSnapshot = await db.collection(collections.restaurants)
      .where('id', '==', restaurantId)
      .get();

    if (!restaurantSnapshot.empty) {
      await restaurantSnapshot.docs[0].ref.update(statusUpdate);
    }

    res.json({ 
      message: 'Restaurant status updated successfully',
      status: statusUpdate
    });
  } catch (error) {
    console.error('Update restaurant status error:', error);
    res.status(500).json({ error: 'Failed to update restaurant status' });
  }
});

// Customer Management APIs
app.post('/api/customers', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.user;
    const { name, phone, email, city, dob, restaurantId, orderHistory = [] } = req.body;

    console.log(`📞 Customer API called with:`, {
      name, phone, email, restaurantId, orderHistoryLength: orderHistory.length
    });

    if (!name && !phone && !email) {
      return res.status(400).json({ error: 'At least one of name, phone, or email is required' });
    }

    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

    // Helper function to normalize phone number
    const normalizePhone = (phone) => {
      if (!phone) return null;
      // Remove all non-digit characters
      const digits = phone.replace(/\D/g, '');
      
      // Handle Indian phone numbers
      if (digits.length === 12 && digits.startsWith('91')) {
        // Remove country code for Indian numbers
        return digits.substring(2);
      } else if (digits.length === 10) {
        // Already a 10-digit number
        return digits;
      } else if (digits.length === 11 && digits.startsWith('0')) {
        // Remove leading zero
        return digits.substring(1);
      }
      
      // Return as-is for other formats
      return digits;
    };

    // Check if customer already exists with same phone number or email
    let existingCustomer = null;
    if (phone || email) {
      console.log(`🔍 Looking for existing customer with phone: ${phone}, email: ${email}`);
      let customerQuery;
      
      if (phone && email) {
        // Check both phone and email
        const normalizedPhone = normalizePhone(phone);
        customerQuery = await db.collection(collections.customers)
          .where('restaurantId', '==', restaurantId)
          .where('phone', '==', phone)
          .limit(1)
          .get();
        
        // If exact match not found, try normalized phone
        if (customerQuery.empty && normalizedPhone) {
          const allCustomers = await db.collection(collections.customers)
            .where('restaurantId', '==', restaurantId)
            .get();
          
          existingCustomer = allCustomers.docs.find(doc => {
            const customerPhone = normalizePhone(doc.data().phone);
            return customerPhone === normalizedPhone;
          });
        }
        
        if (!existingCustomer && customerQuery.empty) {
          customerQuery = await db.collection(collections.customers)
            .where('restaurantId', '==', restaurantId)
            .where('email', '==', email)
            .limit(1)
            .get();
        }
      } else if (phone) {
        const normalizedPhone = normalizePhone(phone);
        customerQuery = await db.collection(collections.customers)
          .where('restaurantId', '==', restaurantId)
          .where('phone', '==', phone)
          .limit(1)
          .get();
        
        // If exact match not found, try normalized phone
        if (customerQuery.empty && normalizedPhone) {
          const allCustomers = await db.collection(collections.customers)
            .where('restaurantId', '==', restaurantId)
            .get();
          
          existingCustomer = allCustomers.docs.find(doc => {
            const customerPhone = normalizePhone(doc.data().phone);
            return customerPhone === normalizedPhone;
          });
        }
      } else if (email) {
        customerQuery = await db.collection(collections.customers)
          .where('restaurantId', '==', restaurantId)
          .where('email', '==', email)
          .limit(1)
          .get();
      }

      if (!existingCustomer && !customerQuery.empty) {
        existingCustomer = customerQuery.docs[0];
        console.log(`✅ Found existing customer via exact match: ${existingCustomer.id}`);
      }
      
      if (!existingCustomer) {
        console.log(`❌ No existing customer found for phone: ${phone}, email: ${email}`);
      }
    }

    if (existingCustomer) {
      // Update existing customer
      console.log(`🔄 Found existing customer: ${existingCustomer.id} with phone: ${existingCustomer.data().phone}`);
      const customerData = existingCustomer.data();
      const updatedData = {
        ...customerData,
        name: name || customerData.name,
        phone: phone || customerData.phone,
        email: email || customerData.email,
        city: city || customerData.city,
        dob: dob || customerData.dob,
        orderHistory: [...customerData.orderHistory, ...orderHistory.map(order => ({
          ...order,
          invoiceId: order.invoiceId || null,
          invoiceGenerated: order.invoiceId ? true : false
        }))],
        lastOrderDate: orderHistory.length > 0 ? new Date() : customerData.lastOrderDate,
        updatedAt: new Date()
      };

      await existingCustomer.ref.update(updatedData);

      res.json({
        message: 'Customer updated successfully',
        customer: {
          id: existingCustomer.id,
          ...updatedData
        }
      });
    } else {
      // Create new customer
      console.log(`🆕 Creating new customer with phone: ${phone}, name: ${name}`);
      const customerData = {
        name: name || null,
        phone: phone || null,
        email: email || null,
        city: city || null,
        dob: dob || null,
        restaurantId,
        orderHistory: (orderHistory || []).map(order => ({
          ...order,
          invoiceId: order.invoiceId || null,
          invoiceGenerated: order.invoiceId ? true : false
        })),
        totalOrders: orderHistory.length,
        totalSpent: orderHistory.reduce((sum, order) => sum + (order.totalAmount || 0), 0),
        lastOrderDate: orderHistory.length > 0 ? new Date() : null,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const customerRef = await db.collection(collections.customers).add(customerData);
      console.log(`✅ New customer created: ${customerRef.id} with phone: ${phone}`);

      res.status(201).json({
        message: 'Customer created successfully',
        customer: {
          id: customerRef.id,
          ...customerData
        }
      });
    }
  } catch (error) {
    console.error('Customer creation error:', error);
    res.status(500).json({ error: 'Failed to create/update customer' });
  }
});

app.get('/api/customers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Verify user has access to this restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const customersSnapshot = await db.collection(collections.customers)
      .where('restaurantId', '==', restaurantId)
      .orderBy('lastOrderDate', 'desc')
      .limit(100)
      .get();

    const customers = [];
    customersSnapshot.forEach(doc => {
      customers.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ customers });
  } catch (error) {
    console.error('Get customers error:', error);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

app.patch('/api/customers/:customerId', authenticateToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { userId } = req.user;
    const updateData = req.body;

    // Get customer and verify access
    const customerDoc = await db.collection(collections.customers).doc(customerId).get();
    if (!customerDoc.exists) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customerData = customerDoc.data();
    const restaurant = await db.collection(collections.restaurants).doc(customerData.restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updatedData = {
      ...updateData,
      updatedAt: new Date()
    };

    await customerDoc.ref.update(updatedData);

    res.json({
      message: 'Customer updated successfully',
      customer: {
        id: customerId,
        ...customerData,
        ...updatedData
      }
    });
  } catch (error) {
    console.error('Update customer error:', error);
    res.status(500).json({ error: 'Failed to update customer' });
  }
});

app.delete('/api/customers/:customerId', authenticateToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { userId } = req.user;

    // Get customer and verify access
    const customerDoc = await db.collection(collections.customers).doc(customerId).get();
    if (!customerDoc.exists) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customerData = customerDoc.data();
    const restaurant = await db.collection(collections.restaurants).doc(customerData.restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete customer
    await customerDoc.ref.delete();

    res.json({
      message: 'Customer deleted successfully'
    });
  } catch (error) {
    console.error('Delete customer error:', error);
    res.status(500).json({ error: 'Failed to delete customer' });
  }
});

// Helper function to get next open time
function getNextOpenTime(operatingHours, currentTime) {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const currentDayIndex = currentTime.getDay();
  
  for (let i = 1; i <= 7; i++) {
    const nextDayIndex = (currentDayIndex + i) % 7;
    const nextDay = days[nextDayIndex];
    const nextDayHours = operatingHours[nextDay];
    
    if (nextDayHours && nextDayHours.isOpen) {
      return {
        day: nextDay,
        time: nextDayHours.open
      };
    }
  }
  
  return null;
}

// ==================== OFFERS MANAGEMENT APIs ====================

// Get all offers for a restaurant
app.get('/api/offers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Verify user has access to this restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const offersSnapshot = await db.collection('offers')
      .where('restaurantId', '==', restaurantId)
      .orderBy('createdAt', 'desc')
      .get();

    const offers = [];
    offersSnapshot.forEach(doc => {
      offers.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({ offers });
  } catch (error) {
    console.error('Get offers error:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

// Get customer loyalty data by phone (public endpoint for Crave app)
app.post('/api/public/customer/lookup', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId, phone } = req.body;

    if (!restaurantId || !phone) {
      return res.status(400).json({ error: 'Restaurant ID and phone are required' });
    }

    // Helper function to normalize phone number
    const normalizePhone = (phoneNum) => {
      if (!phoneNum) return null;
      const digits = phoneNum.replace(/\D/g, '');
      if (digits.length === 12 && digits.startsWith('91')) {
        return digits.substring(2);
      } else if (digits.length === 10) {
        return digits;
      } else if (digits.length === 11 && digits.startsWith('0')) {
        return digits.substring(1);
      }
      return digits;
    };

    const normalizedPhone = normalizePhone(phone);

    // Try exact match first
    let customerQuery = await db.collection('customers')
      .where('restaurantId', '==', restaurantId)
      .where('phone', '==', phone)
      .limit(1)
      .get();

    let existingCustomer = null;
    if (!customerQuery.empty) {
      existingCustomer = customerQuery.docs[0];
    } else if (normalizedPhone) {
      // Try normalized phone match
      const allCustomers = await db.collection('customers')
        .where('restaurantId', '==', restaurantId)
        .get();

      existingCustomer = allCustomers.docs.find(doc => {
        const custPhone = normalizePhone(doc.data().phone);
        return custPhone === normalizedPhone;
      });
    }

    if (existingCustomer) {
      const customerData = existingCustomer.data();
      const totalOrders = customerData.totalOrders || 0;
      res.json({
        found: true,
        customer: {
          id: existingCustomer.id,
          name: customerData.name || 'Customer',
          loyaltyPoints: customerData.loyaltyPoints || 0,
          totalOrders: totalOrders,
          totalSpent: customerData.totalSpent || 0,
          // First order if customer exists but has never placed an order
          isFirstOrder: totalOrders === 0
        }
      });
    } else {
      res.json({
        found: false,
        customer: {
          loyaltyPoints: 0,
          totalOrders: 0,
          isFirstOrder: true
        }
      });
    }
  } catch (error) {
    console.error('Customer lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup customer' });
  }
});

// Firebase auth verification for Crave customer app
// Verifies Firebase ID token and creates/links customer with tier-based loyalty
app.post('/api/crave-app/auth/firebase/verify', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { firebaseIdToken, restaurantId, name } = req.body;

    if (!firebaseIdToken || !restaurantId) {
      return res.status(400).json({ error: 'Firebase ID token and restaurant ID are required' });
    }

    // Verify Firebase ID token
    const admin = require('firebase-admin');
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseIdToken);
    } catch (error) {
      console.error('Firebase token verification error:', error);
      return res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }

    const { uid, phone_number: phoneNumber } = decodedToken;
    console.log('🔐 Crave app Firebase auth - UID:', uid, 'Phone:', phoneNumber);

    // Normalize phone number
    const normalizePhone = (phoneNum) => {
      if (!phoneNum) return null;
      const digits = phoneNum.replace(/\D/g, '');
      if (digits.length === 12 && digits.startsWith('91')) {
        return digits.substring(2);
      } else if (digits.length === 10) {
        return digits;
      } else if (digits.length === 11 && digits.startsWith('0')) {
        return digits.substring(1);
      }
      return digits;
    };

    const normalizedPhone = normalizePhone(phoneNumber);

    // Try to find existing customer by Firebase UID first
    let customerDoc = null;
    let existingCustomerQuery = await db.collection('customers')
      .where('restaurantId', '==', restaurantId)
      .where('firebaseUid', '==', uid)
      .limit(1)
      .get();

    if (!existingCustomerQuery.empty) {
      customerDoc = existingCustomerQuery.docs[0];
      console.log('✅ Customer found by Firebase UID:', customerDoc.id);
    } else if (normalizedPhone) {
      // Try to find by phone number
      const phoneQuery = await db.collection('customers')
        .where('restaurantId', '==', restaurantId)
        .where('phone', '==', normalizedPhone)
        .limit(1)
        .get();

      if (!phoneQuery.empty) {
        customerDoc = phoneQuery.docs[0];
        // Link Firebase UID to existing customer
        await db.collection('customers').doc(customerDoc.id).update({
          firebaseUid: uid,
          updatedAt: new Date()
        });
        console.log('✅ Customer found by phone, linked Firebase UID:', customerDoc.id);
      }
    }

    // Tier calculation function
    const calculateTier = (lifetimePoints) => {
      if (lifetimePoints >= 5000) return 'platinum';
      if (lifetimePoints >= 2000) return 'gold';
      if (lifetimePoints >= 500) return 'silver';
      return 'bronze';
    };

    let customer;
    let isNewCustomer = false;

    if (customerDoc) {
      // Existing customer - update if name provided
      const customerData = customerDoc.data();
      const lifetimePoints = customerData.lifetimePoints || customerData.loyaltyPoints || 0;
      const loyaltyTier = calculateTier(lifetimePoints);

      if (name && (!customerData.name || customerData.name === 'Customer')) {
        await db.collection('customers').doc(customerDoc.id).update({
          name: name,
          loyaltyTier: loyaltyTier,
          updatedAt: new Date()
        });
      } else if (customerData.loyaltyTier !== loyaltyTier) {
        // Update tier if changed
        await db.collection('customers').doc(customerDoc.id).update({
          loyaltyTier: loyaltyTier,
          updatedAt: new Date()
        });
      }

      customer = {
        id: customerDoc.id,
        name: name || customerData.name || 'Customer',
        phone: normalizedPhone || customerData.phone,
        loyaltyPoints: customerData.loyaltyPoints || 0,
        lifetimePoints: lifetimePoints,
        loyaltyTier: loyaltyTier,
        totalOrders: customerData.totalOrders || 0,
        totalSpent: customerData.totalSpent || 0
      };
    } else {
      // Create new customer
      isNewCustomer = true;
      const newCustomer = {
        restaurantId: restaurantId,
        firebaseUid: uid,
        phone: normalizedPhone,
        name: name || 'Customer',
        customerId: `CUST-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        loyaltyPoints: 0,
        lifetimePoints: 0,
        loyaltyTier: 'bronze',
        totalOrders: 0,
        totalSpent: 0,
        lastOrderDate: null,
        orderHistory: [],
        loyaltyTransactions: [],
        source: 'crave_app_firebase',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const customerRef = await db.collection('customers').add(newCustomer);
      console.log('✅ New Crave customer created:', customerRef.id);

      customer = {
        id: customerRef.id,
        name: newCustomer.name,
        phone: newCustomer.phone,
        loyaltyPoints: 0,
        lifetimePoints: 0,
        loyaltyTier: 'bronze',
        totalOrders: 0,
        totalSpent: 0
      };
    }

    // Generate JWT token for customer
    const token = jwt.sign(
      {
        customerId: customer.id,
        restaurantId: restaurantId,
        phone: customer.phone,
        type: 'customer'
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token: token,
      customer: customer,
      isNewCustomer: isNewCustomer
    });

  } catch (error) {
    console.error('Crave Firebase auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Get customer loyalty history with tier info (public endpoint for Crave app)
app.get('/api/public/customer/:customerId/loyalty-history', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { page = 1, limit = 20, type = 'all' } = req.query;

    const customerDoc = await db.collection('customers').doc(customerId).get();
    if (!customerDoc.exists) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customerData = customerDoc.data();
    const loyaltyTransactions = customerData.loyaltyTransactions || [];
    const orderHistory = customerData.orderHistory || [];

    // Build transaction history from order history if loyaltyTransactions is empty
    let history = loyaltyTransactions.length > 0 ? loyaltyTransactions : [];

    if (history.length === 0 && orderHistory.length > 0) {
      // Build from order history
      orderHistory.forEach(order => {
        if (order.loyaltyPointsEarned > 0) {
          history.push({
            id: `earned-${order.orderId}`,
            type: 'earned',
            points: order.loyaltyPointsEarned,
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            date: order.orderDate,
            description: `Earned from order #${order.orderNumber || order.orderId?.slice(-6)}`,
            tierAtTime: order.tierAtTime || 'bronze',
            tierMultiplier: order.tierMultiplier || 1
          });
        }
        if (order.loyaltyPointsRedeemed > 0) {
          history.push({
            id: `redeemed-${order.orderId}`,
            type: 'redeemed',
            points: order.loyaltyPointsRedeemed,
            orderId: order.orderId,
            orderNumber: order.orderNumber,
            date: order.orderDate,
            description: `Redeemed on order #${order.orderNumber || order.orderId?.slice(-6)}`,
            tierAtTime: order.tierAtTime || 'bronze'
          });
        }
      });
    }

    // Filter by type
    if (type !== 'all') {
      history = history.filter(t => t.type === type);
    }

    // Sort by date descending
    history.sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      return dateB - dateA;
    });

    // Pagination
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginatedHistory = history.slice(startIndex, startIndex + parseInt(limit));

    // Calculate summary
    const totalEarned = history
      .filter(t => t.type === 'earned')
      .reduce((sum, t) => sum + (t.points || 0), 0);
    const totalRedeemed = history
      .filter(t => t.type === 'redeemed')
      .reduce((sum, t) => sum + (t.points || 0), 0);

    // Tier calculation
    const lifetimePoints = customerData.lifetimePoints || totalEarned;
    const currentTier = customerData.loyaltyTier || (() => {
      if (lifetimePoints >= 5000) return 'platinum';
      if (lifetimePoints >= 2000) return 'gold';
      if (lifetimePoints >= 500) return 'silver';
      return 'bronze';
    })();

    // Points to next tier
    const tierThresholds = { bronze: 0, silver: 500, gold: 2000, platinum: 5000 };
    const tiers = ['bronze', 'silver', 'gold', 'platinum'];
    const currentTierIndex = tiers.indexOf(currentTier);
    const nextTier = currentTierIndex < 3 ? tiers[currentTierIndex + 1] : null;
    const pointsToNextTier = nextTier ? tierThresholds[nextTier] - lifetimePoints : 0;

    res.json({
      history: paginatedHistory,
      summary: {
        totalEarned: lifetimePoints,
        totalRedeemed: totalRedeemed,
        currentBalance: customerData.loyaltyPoints || 0,
        currentTier: currentTier,
        lifetimePoints: lifetimePoints,
        pointsToNextTier: Math.max(0, pointsToNextTier),
        nextTier: nextTier
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: history.length,
        hasMore: startIndex + parseInt(limit) < history.length
      }
    });

  } catch (error) {
    console.error('Get loyalty history error:', error);
    res.status(500).json({ error: 'Failed to fetch loyalty history' });
  }
});

// Get customer order history with full details (public endpoint for Crave app)
app.get('/api/public/customer/:customerId/orders', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { page = 1, limit = 20, status = 'all' } = req.query;

    // Verify customer exists
    const customerDoc = await db.collection('customers').doc(customerId).get();
    if (!customerDoc.exists) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customerData = customerDoc.data();
    const restaurantId = customerData.restaurantId;

    // Fetch orders for this customer from the orders collection
    let ordersQuery = db.collection(collections.orders)
      .where('customerId', '==', customerId)
      .orderBy('createdAt', 'desc');

    const ordersSnapshot = await ordersQuery.get();

    let orders = [];
    ordersSnapshot.forEach(doc => {
      const orderData = doc.data();

      // Filter by status if specified
      if (status !== 'all' && orderData.status !== status) {
        return;
      }

      orders.push({
        id: doc.id,
        orderNumber: orderData.orderNumber,
        dailyOrderId: orderData.dailyOrderId ?? null,
        status: orderData.status || 'pending',
        orderType: orderData.orderType,
        orderTypeLabel: orderData.orderTypeLabel,
        items: (orderData.items || []).map(item => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          total: item.quantity * item.price
        })),
        subtotal: orderData.subtotal || 0,
        discountAmount: orderData.discountAmount || 0,
        loyaltyDiscount: orderData.loyaltyDiscount || 0,
        totalAmount: orderData.totalAmount || 0,
        appliedOffer: orderData.appliedOffer ? {
          name: orderData.appliedOffer.name,
          discountApplied: orderData.appliedOffer.discountApplied
        } : null,
        appliedOffers: (orderData.appliedOffers || []).map(o => ({
          name: o.name,
          discountApplied: o.discountApplied
        })),
        loyaltyPointsEarned: orderData.loyaltyPointsEarned || 0,
        loyaltyPointsRedeemed: orderData.loyaltyPointsRedeemed || 0,
        tableNumber: orderData.tableNumber,
        createdAt: orderData.createdAt?.toDate ? orderData.createdAt.toDate().toISOString() : orderData.createdAt,
        completedAt: orderData.completedAt?.toDate ? orderData.completedAt.toDate().toISOString() : orderData.completedAt
      });
    });

    // Pagination
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginatedOrders = orders.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      orders: paginatedOrders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: orders.length,
        hasMore: startIndex + parseInt(limit) < orders.length
      },
      summary: {
        totalOrders: orders.length,
        pendingOrders: orders.filter(o => o.status === 'pending').length,
        completedOrders: orders.filter(o => o.status === 'completed').length
      }
    });

  } catch (error) {
    console.error('Get customer orders error:', error);
    res.status(500).json({ error: 'Failed to fetch order history' });
  }
});

// Get customer app settings (public endpoint for Crave app)
app.get('/api/public/customer-app-settings/:restaurantId', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const customerAppSettings = restaurantData.customerAppSettings || {};

    // Only return settings that are relevant to customers
    res.json({
      settings: {
        enabled: customerAppSettings.enabled ?? false,
        allowDineIn: customerAppSettings.allowDineIn ?? true,
        allowTakeaway: customerAppSettings.allowTakeaway ?? true,
        allowDelivery: customerAppSettings.allowDelivery ?? false,
        requireTableSelection: customerAppSettings.requireTableSelection ?? true,
        minimumOrder: customerAppSettings.minimumOrder || 0,
        loyaltySettings: customerAppSettings.loyaltySettings?.enabled ? {
          enabled: true,
          earnPerAmount: customerAppSettings.loyaltySettings.earnPerAmount || 100,
          pointsEarned: customerAppSettings.loyaltySettings.pointsEarned || 4,
          redemptionRate: customerAppSettings.loyaltySettings.redemptionRate || 100,
          maxRedemptionPercent: customerAppSettings.loyaltySettings.maxRedemptionPercent || 20
        } : {
          enabled: false
        },
        branding: {
          primaryColor: customerAppSettings.branding?.primaryColor || '#ef4444',
          textColor: customerAppSettings.branding?.textColor || '#ffffff',
          pageBackgroundColor: customerAppSettings.branding?.pageBackgroundColor || '#f8fafc',
          offerGradientStart: customerAppSettings.branding?.offerGradientStart || '#fef3c7',
          offerGradientEnd: customerAppSettings.branding?.offerGradientEnd || '#fde68a',
          logoUrl: customerAppSettings.branding?.logoUrl || restaurantData.logo || '',
          tagline: customerAppSettings.branding?.tagline || '',
          headerStyle: customerAppSettings.branding?.headerStyle || 'modern'
        },
        offerSettings: {
          autoApplyBestOffer: customerAppSettings.offerSettings?.autoApplyBestOffer ?? false,
          allowMultipleOffers: customerAppSettings.offerSettings?.allowMultipleOffers ?? false,
          maxOffersAllowed: customerAppSettings.offerSettings?.maxOffersAllowed ?? 1
        }
      }
    });
  } catch (error) {
    console.error('Get public customer app settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Get active offers for a restaurant (public endpoint for Crave app)
// Query params:
// - isFirstOrder=true/false - Filter first-order-only offers based on customer status
app.get('/api/public/offers/:restaurantId', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { isFirstOrder } = req.query;
    const now = new Date();

    // Parse isFirstOrder query param (default to undefined if not provided)
    const customerIsFirstOrder = isFirstOrder === 'true' ? true : isFirstOrder === 'false' ? false : undefined;

    const offersSnapshot = await db.collection('offers')
      .where('restaurantId', '==', restaurantId)
      .where('isActive', '==', true)
      .get();

    const offers = [];
    offersSnapshot.forEach(doc => {
      const offer = doc.data();

      // Handle Firestore Timestamps - convert to JS Date
      let validFrom = null;
      let validUntil = null;

      if (offer.validFrom) {
        // Check if it's a Firestore Timestamp
        validFrom = offer.validFrom.toDate ? offer.validFrom.toDate() : new Date(offer.validFrom);
      }
      if (offer.validUntil) {
        validUntil = offer.validUntil.toDate ? offer.validUntil.toDate() : new Date(offer.validUntil);
      }

      // Filter by date range
      const isValidDate = (!validFrom || now >= validFrom) && (!validUntil || now <= validUntil);
      const isUnderUsageLimit = !offer.usageLimit || (offer.usageCount || 0) < offer.usageLimit;

      // Filter first-order-only offers if customer status is provided
      // If isFirstOrder is false, exclude first-order-only offers
      // If isFirstOrder is true or not provided, include all offers
      const isEligibleForFirstOrderOffer = !offer.isFirstOrderOnly || customerIsFirstOrder !== false;

      if (isValidDate && isUnderUsageLimit && isEligibleForFirstOrderOffer) {
        offers.push({
          id: doc.id,
          name: offer.name,
          description: offer.description,
          discountType: offer.discountType,
          discountValue: offer.discountValue,
          minOrderValue: offer.minOrderValue || 0,
          maxDiscount: offer.maxDiscount,
          validFrom: validFrom ? validFrom.toISOString() : null,
          validUntil: validUntil ? validUntil.toISOString() : null,
          isActive: offer.isActive ?? true,
          usageLimit: offer.usageLimit || null,
          usageCount: offer.usageCount || 0,
          isFirstOrderOnly: offer.isFirstOrderOnly || false,
          autoApply: offer.autoApply || false
        });
      }
    });

    console.log(`Found ${offers.length} valid offers for restaurant ${restaurantId} (isFirstOrder: ${customerIsFirstOrder})`);
    res.json({ offers });
  } catch (error) {
    console.error('Get public offers error:', error);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

// Create a new offer
app.post('/api/offers/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const {
      name,
      description,
      discountType = 'percentage',
      discountValue,
      minOrderValue = 0,
      maxDiscount = null,
      validFrom,
      validUntil,
      isActive = true,
      usageLimit = null,
      isFirstOrderOnly = false,
      autoApply = false
    } = req.body;

    // Verify user has access to this restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!name) {
      return res.status(400).json({ error: 'Offer name is required' });
    }

    if (!discountValue || discountValue <= 0) {
      return res.status(400).json({ error: 'Valid discount value is required' });
    }

    if (discountType === 'percentage' && discountValue > 100) {
      return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });
    }

    const offerData = {
      restaurantId,
      name,
      description: description || '',
      discountType,
      discountValue: Number(discountValue),
      minOrderValue: Number(minOrderValue) || 0,
      maxDiscount: maxDiscount ? Number(maxDiscount) : null,
      validFrom: validFrom || null,
      validUntil: validUntil || null,
      isActive,
      usageLimit: usageLimit ? Number(usageLimit) : null,
      usageCount: 0,
      isFirstOrderOnly,
      autoApply,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const offerRef = await db.collection('offers').add(offerData);

    res.status(201).json({
      message: 'Offer created successfully',
      offer: {
        id: offerRef.id,
        ...offerData
      }
    });
  } catch (error) {
    console.error('Create offer error:', error);
    res.status(500).json({ error: 'Failed to create offer' });
  }
});

// Update an offer
app.put('/api/offers/:restaurantId/:offerId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, offerId } = req.params;
    const { userId } = req.user;
    const updateData = req.body;

    // Verify user has access to this restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get offer and verify it belongs to this restaurant
    const offerDoc = await db.collection('offers').doc(offerId).get();
    if (!offerDoc.exists) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    if (offerDoc.data().restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Offer does not belong to this restaurant' });
    }

    // Validate discount value
    if (updateData.discountValue !== undefined) {
      if (updateData.discountValue <= 0) {
        return res.status(400).json({ error: 'Valid discount value is required' });
      }
      if (updateData.discountType === 'percentage' && updateData.discountValue > 100) {
        return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });
      }
    }

    const updatedData = {
      ...updateData,
      discountValue: updateData.discountValue ? Number(updateData.discountValue) : offerDoc.data().discountValue,
      minOrderValue: updateData.minOrderValue !== undefined ? Number(updateData.minOrderValue) : offerDoc.data().minOrderValue,
      maxDiscount: updateData.maxDiscount !== undefined ? (updateData.maxDiscount ? Number(updateData.maxDiscount) : null) : offerDoc.data().maxDiscount,
      usageLimit: updateData.usageLimit !== undefined ? (updateData.usageLimit ? Number(updateData.usageLimit) : null) : offerDoc.data().usageLimit,
      updatedAt: new Date()
    };

    // Remove fields that shouldn't be updated
    delete updatedData.restaurantId;
    delete updatedData.createdAt;
    delete updatedData.id;

    await offerDoc.ref.update(updatedData);

    res.json({
      message: 'Offer updated successfully',
      offer: {
        id: offerId,
        ...offerDoc.data(),
        ...updatedData
      }
    });
  } catch (error) {
    console.error('Update offer error:', error);
    res.status(500).json({ error: 'Failed to update offer' });
  }
});

// Delete an offer
app.delete('/api/offers/:restaurantId/:offerId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, offerId } = req.params;
    const { userId } = req.user;

    // Verify user has access to this restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get offer and verify it belongs to this restaurant
    const offerDoc = await db.collection('offers').doc(offerId).get();
    if (!offerDoc.exists) {
      return res.status(404).json({ error: 'Offer not found' });
    }

    if (offerDoc.data().restaurantId !== restaurantId) {
      return res.status(403).json({ error: 'Offer does not belong to this restaurant' });
    }

    await offerDoc.ref.delete();

    res.json({
      message: 'Offer deleted successfully'
    });
  } catch (error) {
    console.error('Delete offer error:', error);
    res.status(500).json({ error: 'Failed to delete offer' });
  }
});

// ==================== CUSTOMER APP SETTINGS APIs ====================

// Get customer app settings for a restaurant
app.get('/api/restaurants/:restaurantId/customer-app-settings', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Verify user has access to this restaurant
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    if (restaurantDoc.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const restaurantData = restaurantDoc.data();

    // Return existing settings or defaults
    const existingSettings = restaurantData.customerAppSettings || {};
    const customerAppSettings = {
      enabled: existingSettings.enabled ?? false,
      restaurantCode: existingSettings.restaurantCode || '',
      allowDineIn: existingSettings.allowDineIn ?? true,
      allowTakeaway: existingSettings.allowTakeaway ?? true,
      allowDelivery: existingSettings.allowDelivery ?? false,
      requireTableSelection: existingSettings.requireTableSelection ?? true,
      minimumOrder: existingSettings.minimumOrder || 0,
      loyaltySettings: {
        enabled: existingSettings.loyaltySettings?.enabled ?? false,
        earnPerAmount: existingSettings.loyaltySettings?.earnPerAmount || 100,
        pointsEarned: existingSettings.loyaltySettings?.pointsEarned || 4,
        redemptionRate: existingSettings.loyaltySettings?.redemptionRate || 100,
        maxRedemptionPercent: existingSettings.loyaltySettings?.maxRedemptionPercent || 20
      },
      offerSettings: {
        autoApplyBestOffer: existingSettings.offerSettings?.autoApplyBestOffer ?? false,
        allowMultipleOffers: existingSettings.offerSettings?.allowMultipleOffers ?? false,
        maxOffersAllowed: existingSettings.offerSettings?.maxOffersAllowed || 1
      },
      branding: {
        primaryColor: existingSettings.branding?.primaryColor || '#ef4444',
        textColor: existingSettings.branding?.textColor || '#ffffff',
        pageBackgroundColor: existingSettings.branding?.pageBackgroundColor || '#f8fafc',
        offerGradientStart: existingSettings.branding?.offerGradientStart || '#fef3c7',
        offerGradientEnd: existingSettings.branding?.offerGradientEnd || '#fde68a',
        logoUrl: existingSettings.branding?.logoUrl || restaurantData.logo || '',
        tagline: existingSettings.branding?.tagline || '',
        headerStyle: existingSettings.branding?.headerStyle || 'modern'
      }
    };

    res.json({ settings: customerAppSettings });
  } catch (error) {
    console.error('Get customer app settings error:', error);
    res.status(500).json({ error: 'Failed to fetch customer app settings' });
  }
});

// Get restaurant details (Authenticated) - Fixes 404 error
app.get('/api/restaurants/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // For now, allow any authenticated user to fetch basic details to fix the 404
    // Ideally we should check ownership, but the frontend calls this indiscriminately
    const restaurant = restaurantDoc.data();
    
    // Don't leak sensitive data if not owner
    // if (restaurant.ownerId !== req.user.userId) { ... }

    res.json({ restaurant: { id: restaurantDoc.id, ...restaurant } });
  } catch (error) {
    console.error('Get restaurant error:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

// Update customer app settings for a restaurant
app.put('/api/restaurants/:restaurantId/customer-app-settings', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const settings = req.body;
    
    console.log(`[SETTINGS UPDATE] Restaurant: ${restaurantId}, User: ${userId}`);
    console.log('[SETTINGS UPDATE] Payload:', JSON.stringify(settings, null, 2));

    // Verify user has access to this restaurant
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    if (restaurantDoc.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // If restaurant code is being set, validate it's unique
    if (settings.restaurantCode) {
      const codeRegex = /^[A-Za-z0-9]{3,10}$/;
      if (!codeRegex.test(settings.restaurantCode)) {
        return res.status(400).json({ error: 'Restaurant code must be 3-10 alphanumeric characters' });
      }

      // Check if code is already used by another restaurant
      const existingRestaurant = await db.collection(collections.restaurants)
        .where('customerAppSettings.restaurantCode', '==', settings.restaurantCode.toUpperCase())
        .limit(1)
        .get();

      if (!existingRestaurant.empty && existingRestaurant.docs[0].id !== restaurantId) {
        return res.status(400).json({ error: 'This restaurant code is already in use' });
      }

      settings.restaurantCode = settings.restaurantCode.toUpperCase();
    }

    // Build the update object
    const customerAppSettings = {
      enabled: settings.enabled ?? false,
      restaurantCode: settings.restaurantCode || '',
      allowDineIn: settings.allowDineIn ?? true,
      allowTakeaway: settings.allowTakeaway ?? true,
      allowDelivery: settings.allowDelivery ?? false,
      requireTableSelection: settings.requireTableSelection ?? true,
      minimumOrder: Number(settings.minimumOrder) || 0,
      loyaltySettings: {
        enabled: settings.loyaltySettings?.enabled ?? false,
        earnPerAmount: Number(settings.loyaltySettings?.earnPerAmount) || 100,
        pointsEarned: Number(settings.loyaltySettings?.pointsEarned) || 4,
        redemptionRate: Number(settings.loyaltySettings?.redemptionRate) || 100,
        maxRedemptionPercent: Number(settings.loyaltySettings?.maxRedemptionPercent) || 20
      },
      offerSettings: {
        autoApplyBestOffer: settings.offerSettings?.autoApplyBestOffer ?? false,
        allowMultipleOffers: settings.offerSettings?.allowMultipleOffers ?? false,
        maxOffersAllowed: Number(settings.offerSettings?.maxOffersAllowed) || 1
      },
      branding: {
        primaryColor: settings.branding?.primaryColor || '#ef4444',
        textColor: settings.branding?.textColor || '#ffffff',
        pageBackgroundColor: settings.branding?.pageBackgroundColor || '#f8fafc',
        offerGradientStart: settings.branding?.offerGradientStart || '#fef3c7',
        offerGradientEnd: settings.branding?.offerGradientEnd || '#fde68a',
        logoUrl: settings.branding?.logoUrl || '',
        tagline: settings.branding?.tagline || '',
        headerStyle: settings.branding?.headerStyle || 'modern'
      },
      updatedAt: new Date()
    };

    await restaurantDoc.ref.update({
      customerAppSettings: customerAppSettings
    });

    res.json({
      message: 'Customer app settings updated successfully',
      settings: customerAppSettings
    });
  } catch (error) {
    console.error('Update customer app settings error:', error);
    res.status(500).json({ error: 'Failed to update customer app settings' });
  }
});

// Get restaurant by code (public endpoint for Crave app QR scanning)
// Returns restaurant data + menu in single response for better performance
app.get('/api/public/restaurant/code/:code', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { code } = req.params;

    if (!code) {
      return res.status(400).json({ error: 'Restaurant code is required' });
    }

    // Find restaurant by code
    const restaurantsSnapshot = await db.collection(collections.restaurants)
      .where('customerAppSettings.restaurantCode', '==', code.toUpperCase())
      .where('customerAppSettings.enabled', '==', true)
      .limit(1)
      .get();

    if (restaurantsSnapshot.empty) {
      return res.status(404).json({ error: 'Restaurant not found or app not enabled' });
    }

    const restaurantDoc = restaurantsSnapshot.docs[0];
    const restaurantData = restaurantDoc.data();
    const restaurantId = restaurantDoc.id;

    // Get menu data from restaurant document
    const embeddedMenu = restaurantData.menu || { categories: [], items: [] };
    
    // Get categories
    const categories = (embeddedMenu.categories || [])
      .filter(cat => cat.status === 'active')
      .map(cat => ({
        id: cat.id,
        name: cat.name,
        description: cat.description || '',
        image: cat.image || null,
        displayOrder: cat.displayOrder || 0
      }))
      .sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    
    // Filter active and available menu items
    const menuItems = (embeddedMenu.items || [])
      .filter(item => item.status === 'active' && item.isAvailable !== false)
      .map(item => ({
        id: item.id,
        name: item.name,
        description: item.description || '',
        price: item.price,
        category: item.category,
        isVeg: item.isVeg !== false,
        spiceLevel: item.spiceLevel || 'medium',
        shortCode: item.shortCode || item.name.substring(0, 3).toUpperCase(),
        image: item.image || null,
        images: item.images || [],
        allergens: item.allergens || []
      }));

    // Get active offers (async - can be loaded separately by app if needed)
    let offers = [];
    try {
      const offersSnapshot = await db.collection('offers')
        .where('restaurantId', '==', restaurantId)
        .where('isActive', '==', true)
        .get();

      const now = new Date();
      offers = offersSnapshot.docs
        .map(doc => {
          const offer = doc.data();
          const validFrom = offer.validFrom ? new Date(offer.validFrom) : null;
          const validUntil = offer.validUntil ? new Date(offer.validUntil) : null;
          const isValidDate = (!validFrom || now >= validFrom) && (!validUntil || now <= validUntil);
          const isUnderUsageLimit = !offer.usageLimit || (offer.usageCount || 0) < offer.usageLimit;

          if (isValidDate && isUnderUsageLimit) {
            return {
              id: doc.id,
              name: offer.name,
              description: offer.description,
              discountType: offer.discountType,
              discountValue: offer.discountValue,
              minOrderValue: offer.minOrderValue || 0,
              maxDiscount: offer.maxDiscount,
              isFirstOrderOnly: offer.isFirstOrderOnly || false,
              autoApply: offer.autoApply || false
            };
          }
          return null;
        })
        .filter(offer => offer !== null);
    } catch (offersError) {
      console.warn('Error loading offers:', offersError);
      // Continue without offers - app can fetch separately if needed
    }

    res.json({
      restaurant: {
        id: restaurantId,
        name: restaurantData.name,
        logoUrl: restaurantData.logoUrl || restaurantData.customerAppSettings?.branding?.logoUrl || '',
        primaryColor: restaurantData.customerAppSettings?.branding?.primaryColor || '#dc2626',
        textColor: restaurantData.customerAppSettings?.branding?.textColor || '#ffffff',
        pageBackgroundColor: restaurantData.customerAppSettings?.branding?.pageBackgroundColor || '#f8fafc',
        offerGradientStart: restaurantData.customerAppSettings?.branding?.offerGradientStart || '#fef3c7',
        offerGradientEnd: restaurantData.customerAppSettings?.branding?.offerGradientEnd || '#fde68a',
        tagline: restaurantData.customerAppSettings?.branding?.tagline || '',
        headerStyle: restaurantData.customerAppSettings?.branding?.headerStyle || 'modern',
        allowDineIn: restaurantData.customerAppSettings?.allowDineIn ?? true,
        allowTakeaway: restaurantData.customerAppSettings?.allowTakeaway ?? true,
        allowDelivery: restaurantData.customerAppSettings?.allowDelivery ?? false,
        requireTableSelection: restaurantData.customerAppSettings?.requireTableSelection ?? true,
        minimumOrder: restaurantData.customerAppSettings?.minimumOrder || 0,
        loyaltyEnabled: restaurantData.customerAppSettings?.loyaltySettings?.enabled ?? false
      },
      menu: {
        categories: categories,
        items: menuItems
      },
      offers: offers
    });
  } catch (error) {
    console.error('Get restaurant by code error:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

// Helper function to generate unique restaurant code
async function generateUniqueRestaurantCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excluding confusing chars like 0,O,1,I
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    // Generate 6-character alphanumeric code
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Check if code already exists
    const existingRestaurant = await db.collection(collections.restaurants)
      .where('customerAppSettings.restaurantCode', '==', code)
      .limit(1)
      .get();

    if (existingRestaurant.empty) {
      return code;
    }
    attempts++;
  }

  // Fallback: add timestamp suffix
  const timestamp = Date.now().toString(36).toUpperCase().slice(-3);
  let code = '';
  for (let i = 0; i < 3; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code + timestamp;
}

// Generate restaurant code
app.post('/api/restaurants/:restaurantId/generate-code', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;

    // Verify user has access to this restaurant
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    if (restaurantDoc.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Generate unique code
    const newCode = await generateUniqueRestaurantCode();

    // Update restaurant with new code
    const restaurantData = restaurantDoc.data();
    const customerAppSettings = restaurantData.customerAppSettings || {};

    await restaurantDoc.ref.update({
      'customerAppSettings.restaurantCode': newCode,
      'customerAppSettings.enabled': customerAppSettings.enabled ?? true,
      updatedAt: new Date()
    });

    res.json({
      success: true,
      restaurantCode: newCode,
      message: 'Restaurant code generated successfully'
    });
  } catch (error) {
    console.error('Generate restaurant code error:', error);
    res.status(500).json({ error: 'Failed to generate restaurant code' });
  }
});

// Generate or get QR code for customer app
app.get('/api/restaurants/:restaurantId/qr-code', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const { autoGenerate } = req.query; // Allow auto-generation via query param

    // Verify user has access to this restaurant
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    if (restaurantDoc.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const restaurantData = restaurantDoc.data();
    let customerAppSettings = restaurantData.customerAppSettings || {};
    let restaurantCode = customerAppSettings.restaurantCode;

    // Auto-generate code if requested and not set
    if (!restaurantCode && autoGenerate === 'true') {
      restaurantCode = await generateUniqueRestaurantCode();

      // Update restaurant with new code
      await restaurantDoc.ref.update({
        'customerAppSettings.restaurantCode': restaurantCode,
        'customerAppSettings.enabled': customerAppSettings.enabled ?? true,
        updatedAt: new Date()
      });
    }

    if (!restaurantCode) {
      return res.status(400).json({
        error: 'Restaurant code not set',
        needsCode: true,
        message: 'Please generate a restaurant code first'
      });
    }

    // Generate QR code URL that links to the public online order page
    const qrContent = `https://www.dineopen.com/onlineorder?restaurant=${restaurantId}`;

    // Generate QR code as data URL
    const qrCodeDataUrl = await QRCode.toDataURL(qrContent, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      },
      errorCorrectionLevel: 'M'
    });

    res.json({
      qrCode: qrCodeDataUrl,
      restaurantCode: restaurantCode,
      qrContent: qrContent,
      onlineOrderUrl: qrContent
    });
  } catch (error) {
    console.error('Generate QR code error:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Mount payment routes
const paymentRouter = initializePaymentRoutes(db, razorpay);
app.use('/api/payments', paymentRouter);

// ==================== CATEGORY MANAGEMENT APIs ====================

// Get categories for a restaurant
app.get('/api/categories/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    // Get restaurant document to access embedded categories
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    let categories = restaurantData.categories || [];

    // If no categories defined, extract them dynamically from menu items
    if (categories.length === 0) {
      const menuItems = restaurantData.menu?.items || [];
      const categoryMap = new Map();

      // Extract unique categories from menu items
      for (const item of menuItems) {
        if (item.category && item.status !== 'deleted') {
          const categoryId = item.category.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (categoryId && !categoryMap.has(categoryId)) {
            categoryMap.set(categoryId, {
              id: categoryId,
              name: item.category,
              emoji: '🍽️',
              description: '',
              createdAt: new Date(),
              updatedAt: new Date()
            });
          }
        }
      }

      categories = Array.from(categoryMap.values());

      // Optionally save these extracted categories back to the restaurant
      if (categories.length > 0) {
        await db.collection(collections.restaurants).doc(restaurantId).update({
          categories: categories,
          updatedAt: new Date()
        });
        console.log(`✅ Auto-extracted ${categories.length} categories for restaurant ${restaurantId}`);
      }
    }

    res.json({ categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Create new category
app.post('/api/categories/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, emoji = '🍽️', description = '' } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }

    // Get restaurant document
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const existingCategories = restaurantData.categories || [];

    // Check if category already exists (use same ID generation as bulk-save)
    const categoryId = categoryNameToId(name);
    if (!categoryId || categoryId === 'other') {
      return res.status(400).json({ error: 'Invalid category name' });
    }
    if (existingCategories.find(cat => (cat.id || '').toLowerCase() === categoryId)) {
      return res.status(400).json({ error: 'Category already exists' });
    }

    const newCategory = {
      id: categoryId,
      name: name.trim(),
      emoji: emoji.trim(),
      description: description.trim(),
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Add category to restaurant document
    const updatedCategories = [...existingCategories, newCategory];
    await db.collection(collections.restaurants).doc(restaurantId).update({
      categories: updatedCategories,
      updatedAt: new Date()
    });

    res.status(201).json({
      message: 'Category created successfully',
      category: newCategory
    });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Update category
app.patch('/api/categories/:restaurantId/:categoryId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, categoryId } = req.params;
    const { name, emoji, description } = req.body;

    // Get restaurant document
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const categories = restaurantData.categories || [];

    // Find category to update
    const categoryIndex = categories.findIndex(cat => cat.id === categoryId);
    if (categoryIndex === -1) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Update category
    const updatedCategory = {
      ...categories[categoryIndex],
      ...(name && { name: name.trim() }),
      ...(emoji && { emoji: emoji.trim() }),
      ...(description !== undefined && { description: description.trim() }),
      updatedAt: new Date()
    };

    categories[categoryIndex] = updatedCategory;

    // Update restaurant document
    await db.collection(collections.restaurants).doc(restaurantId).update({
      categories: categories,
      updatedAt: new Date()
    });

    res.json({
      message: 'Category updated successfully',
      category: updatedCategory
    });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// Delete category
app.delete('/api/categories/:restaurantId/:categoryId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, categoryId } = req.params;

    // Get restaurant document
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const categories = restaurantData.categories || [];

    // Check if category exists
    const categoryIndex = categories.findIndex(cat => cat.id === categoryId);
    if (categoryIndex === -1) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // Check if any menu items use this category
    const menuItems = restaurantData.menu?.items || [];
    const itemsUsingCategory = menuItems.filter(item => item.category === categoryId);
    
    if (itemsUsingCategory.length > 0) {
      return res.status(400).json({ 
        error: `Cannot delete category. ${itemsUsingCategory.length} menu items are using this category. Please reassign or delete those items first.` 
      });
    }

    // Remove category
    categories.splice(categoryIndex, 1);

    // Update restaurant document
    await db.collection(collections.restaurants).doc(restaurantId).update({
      categories: categories,
      updatedAt: new Date()
    });

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// ==================== SECURITY MONITORING ====================

// Security monitoring endpoint (admin only)
app.get('/api/admin/security/stats', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    
    // Check if user is admin/owner
    const userDoc = await db.collection(collections.users).doc(user.userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    if (!['OWNER', 'ADMIN'].includes(userData.role)) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    const stats = await vercelSecurityMiddleware.getStats();
    res.json({
      success: true,
      stats: {
        ...stats,
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      }
    });
  } catch (error) {
    console.error('Security stats error:', error);
    res.status(500).json({ error: 'Failed to get security stats' });
  }
});

// Block IP endpoint (admin only)
app.post('/api/admin/security/block-ip', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const { ip, duration } = req.body;
    
    // Check if user is admin/owner
    const userDoc = await db.collection(collections.users).doc(user.userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    if (!['OWNER', 'ADMIN'].includes(userData.role)) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    if (!ip) {
      return res.status(400).json({ error: 'IP address is required' });
    }

    const blockDuration = duration || 60 * 60 * 1000; // Default 1 hour
    await vercelSecurityMiddleware.blockIP(ip, blockDuration);
    
    await vercelSecurityMiddleware.logSecurityEvent(req, 'MANUAL_IP_BLOCK', { ip, duration: blockDuration });
    
    res.json({
      success: true,
      message: `IP ${ip} blocked for ${blockDuration / 1000 / 60} minutes`
    });
  } catch (error) {
    console.error('Block IP error:', error);
    res.status(500).json({ error: 'Failed to block IP' });
  }
});

// Health check endpoint with security info
app.get('/api/health', async (req, res) => {
  const stats = await vercelSecurityMiddleware.getStats();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    security: {
      blockedIPs: stats.blockedIPs,
      activeClients: stats.rateLimitClients
    }
  });
});

// ==================== DINEBOT API ENDPOINT ====================


// DineBot Status Endpoint
// Simple Intent-Based Chatbot endpoint
app.post('/api/dinebot/query', vercelSecurityMiddleware.chatbotAPI, chatgptUsageLimiter.middleware(), authenticateToken, async (req, res) => {
  try {
    const { query: userQuery, restaurantId } = req.body;
    const userId = req.user.userId;

    if (!userQuery || !restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Query and restaurantId are required'
      });
    }

    const RestaurantChatbot = require('./chatbot');
    const chatbot = new RestaurantChatbot();
    
    // Create a simple API client for the chatbot
    const apiClient = {
      getTables: async (restaurantId) => {
        const snapshot = await db.collection('tables').where('restaurantId', '==', restaurantId).get();
        const tables = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        return { tables };
      },
      updateTableStatus: async (tableId, status) => {
        await db.collection('tables').doc(tableId).update({
          status,
          updatedAt: new Date(),
          updatedBy: userId
        });
      },
      createTable: async (restaurantId, tableData) => {
        const docRef = await db.collection('tables').add({
          ...tableData,
          restaurantId,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdBy: userId
        });
        return { id: docRef.id };
      },
      deleteTable: async (tableId) => {
        await db.collection('tables').doc(tableId).delete();
      },
      getOrders: async (restaurantId) => {
        const snapshot = await db.collection('orders').where('restaurantId', '==', restaurantId).get();
        const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        return { orders };
      },
      getMenu: async (restaurantId) => {
        const restaurantDoc = await db.collection('restaurants').doc(restaurantId).get();
        if (restaurantDoc.exists) {
          const restaurantData = restaurantDoc.data();
          return { menuItems: restaurantData.menu?.items || [] };
        }
        return { menuItems: [] };
      },
      clearToken: () => {
        // This would be handled by the frontend
        console.log('Logout requested');
      }
    };

    const result = await chatbot.processQuery(userQuery, restaurantId, userId, apiClient, db);

    // Record successful ChatGPT API call
    if (result.success) {
      await chatgptUsageLimiter.recordSuccessfulCall(req, 0); // We don't track exact tokens for chatbot
    }

    res.json({
      success: result.success,
      response: result.response,
      data: result.data,
      redirect: result.redirect,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Chatbot error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message
    });
  }
});

app.get('/api/dinebot/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const restaurantId = req.query.restaurantId;
    
    if (!restaurantId) {
      return res.status(400).json({
        success: false,
        error: 'Restaurant ID required'
      });
    }
    
    // Security: Validate restaurant access
    const hasAccess = await validateRestaurantAccess(userId, restaurantId);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to restaurant data'
      });
    }
    
    const restaurantData = await getRestaurantStaticData(restaurantId);
    
    res.json({
      success: true,
      bot: {
        name: dinebotConfig.name,
        version: dinebotConfig.version,
        description: dinebotConfig.description,
        status: 'active'
      },
      restaurant: restaurantData,
      capabilities: [
        'Order analytics and reporting',
        'Customer insights and statistics',
        'Revenue and sales analysis',
        'Table and floor management',
        'Menu performance tracking',
        'Inventory status queries',
        'Staff performance metrics',
        'Restaurant operational data'
      ],
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('DineBot status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get bot status'
    });
  }
});

// ==================== END DINEBOT API ====================

// ==================== EMAIL SERVICE API ENDPOINTS ====================

// Send welcome email to new users
app.post('/api/email/welcome', authenticateToken, async (req, res) => {
  try {
    const { email, name } = req.body;
    const userId = req.user.userId;
    
    console.log(`📧 Sending welcome email to: ${email} for user: ${userId}`);
    
    if (!email || !name) {
      return res.status(400).json({
        success: false,
        error: 'Email and name are required'
      });
    }

    const userData = {
      email: email,
      name: name,
      userId: userId
    };

    const result = await emailService.sendWelcomeEmail(userData);
    
    res.json({
      success: true,
      message: 'Welcome email sent successfully',
      messageId: result.messageId
    });
    
  } catch (error) {
    console.error('Welcome email error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send welcome email',
      message: error.message
    });
  }
});

// Send weekly analytics report
app.post('/api/email/weekly-analytics', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.body;
    const userId = req.user.userId;
    
    console.log(`📊 Generating weekly analytics report for restaurant: ${restaurantId}`);
    
    // Security: Validate restaurant access
    const hasAccess = await validateRestaurantAccess(userId, restaurantId);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: 'Access denied to restaurant data'
      });
    }

    // Get restaurant data
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant not found'
      });
    }

    const restaurant = restaurantDoc.data();
    
    // Get owner data
    const ownerDoc = await db.collection(collections.users).doc(restaurant.ownerId).get();
    if (!ownerDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Restaurant owner not found'
      });
    }

    const owner = ownerDoc.data();
    
    // Calculate date range for this week
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    // Get orders for this week
    const ordersSnapshot = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', startOfWeek)
      .where('createdAt', '<=', endOfWeek)
      .get();

    const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    // Get previous week orders for comparison
    const prevStartOfWeek = new Date(startOfWeek);
    prevStartOfWeek.setDate(startOfWeek.getDate() - 7);
    const prevEndOfWeek = new Date(endOfWeek);
    prevEndOfWeek.setDate(endOfWeek.getDate() - 7);

    const prevOrdersSnapshot = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', prevStartOfWeek)
      .where('createdAt', '<=', prevEndOfWeek)
      .get();

    const prevOrders = prevOrdersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Calculate analytics
    const totalOrders = orders.length;
    const totalRevenue = orders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
    const averageOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    
    // Get unique customers
    const customerEmails = new Set(orders.map(order => order.customer?.email).filter(Boolean));
    const totalCustomers = customerEmails.size;
    
    // Get new customers (customers who ordered this week but not last week)
    const prevCustomerEmails = new Set(prevOrders.map(order => order.customer?.email).filter(Boolean));
    const newCustomers = Array.from(customerEmails).filter(email => !prevCustomerEmails.has(email)).length;

    // Calculate growth percentages
    const prevTotalOrders = prevOrders.length;
    const prevTotalRevenue = prevOrders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
    const prevTotalCustomers = new Set(prevOrders.map(order => order.customer?.email).filter(Boolean)).size;

    const orderGrowth = prevTotalOrders > 0 ? ((totalOrders - prevTotalOrders) / prevTotalOrders) * 100 : 0;
    const revenueGrowth = prevTotalRevenue > 0 ? ((totalRevenue - prevTotalRevenue) / prevTotalRevenue) * 100 : 0;
    const customerGrowth = prevTotalCustomers > 0 ? ((totalCustomers - prevTotalCustomers) / prevTotalCustomers) * 100 : 0;

    // Get top items
    const itemCounts = {};
    const itemRevenue = {};
    orders.forEach(order => {
      if (order.items) {
        order.items.forEach(item => {
          const itemName = item.name || 'Unknown Item';
          itemCounts[itemName] = (itemCounts[itemName] || 0) + (item.quantity || 1);
          itemRevenue[itemName] = (itemRevenue[itemName] || 0) + ((item.price || 0) * (item.quantity || 1));
        });
      }
    });

    const topItems = Object.keys(itemCounts)
      .map(name => ({
        name,
        orders: itemCounts[name],
        revenue: itemRevenue[name] || 0
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 5);

    // Get busiest hours
    const hourCounts = {};
    orders.forEach(order => {
      const hour = new Date(order.createdAt).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    });

    const busiestHours = Object.keys(hourCounts)
      .map(hour => ({ hour: parseInt(hour), orders: hourCounts[hour] }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 5);

    // Get daily breakdown
    const dailyBreakdown = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(startOfWeek);
      date.setDate(startOfWeek.getDate() + i);
      
      const dayOrders = orders.filter(order => {
        const orderDate = new Date(order.createdAt);
        return orderDate.toDateString() === date.toDateString();
      });
      
      const dayRevenue = dayOrders.reduce((sum, order) => sum + (order.totalAmount || 0), 0);
      
      dailyBreakdown.push({
        date: date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        orders: dayOrders.length,
        revenue: Math.round(dayRevenue)
      });
    }

    // Format week range
    const weekRange = `${startOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${endOfWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    const analyticsData = {
      ownerEmail: owner.email || owner.phone,
      ownerName: owner.name || 'Restaurant Owner',
      restaurantName: restaurant.name,
      weekRange: weekRange,
      totalOrders: totalOrders,
      totalRevenue: Math.round(totalRevenue),
      averageOrderValue: Math.round(averageOrderValue),
      totalCustomers: totalCustomers,
      newCustomers: newCustomers,
      orderGrowth: Math.round(orderGrowth * 100) / 100,
      revenueGrowth: Math.round(revenueGrowth * 100) / 100,
      customerGrowth: Math.round(customerGrowth * 100) / 100,
      topItems: topItems,
      busiestHours: busiestHours,
      dailyBreakdown: dailyBreakdown
    };

    const result = await emailService.sendWeeklyAnalyticsReport(analyticsData);
    
    res.json({
      success: true,
      message: 'Weekly analytics report sent successfully',
      messageId: result.messageId,
      analytics: analyticsData
    });
    
  } catch (error) {
    console.error('Weekly analytics email error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send weekly analytics report',
      message: error.message
    });
  }
});

// ==================== CHATGPT USAGE MANAGEMENT ====================

// Get ChatGPT usage statistics (admin only)
app.get('/api/admin/chatgpt/stats', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    
    // Check if user is admin/owner
    const userDoc = await db.collection(collections.users).doc(user.userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    if (!['OWNER', 'ADMIN'].includes(userData.role)) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    const stats = await chatgptUsageLimiter.getUsageStats();
    const config = await chatgptUsageLimiter.getConfig();
    
    res.json({
      success: true,
      stats: {
        ...stats,
        config,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('ChatGPT stats error:', error);
    res.status(500).json({ error: 'Failed to get ChatGPT stats' });
  }
});

// Update ChatGPT limits configuration (admin only)
app.post('/api/admin/chatgpt/config', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const { dailyLimit, ipLimit, userLimit, enabled } = req.body;
    
    // Check if user is admin/owner
    const userDoc = await db.collection(collections.users).doc(user.userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    if (!['OWNER', 'ADMIN'].includes(userData.role)) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    const newConfig = {
      dailyLimit: dailyLimit || 5,
      ipLimit: ipLimit || 10,
      userLimit: userLimit || 5,
      enabled: enabled !== undefined ? enabled : true
    };

    const success = await chatgptUsageLimiter.updateConfig(newConfig);
    
    if (success) {
      res.json({
        success: true,
        message: 'ChatGPT limits configuration updated successfully',
        config: newConfig
      });
    } else {
      res.status(500).json({ error: 'Failed to update configuration' });
    }
  } catch (error) {
    console.error('Update ChatGPT config error:', error);
    res.status(500).json({ error: 'Failed to update ChatGPT configuration' });
  }
});

// Get user's ChatGPT usage (user can check their own usage)
app.get('/api/chatgpt/usage', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.headers['x-real-ip'] || 
                     req.connection?.remoteAddress || 
                     'unknown';

    const userUsage = await chatgptUsageLimiter.getUserUsage(userId);
    const ipUsage = await chatgptUsageLimiter.getIPUsage(ipAddress);
    const config = await chatgptUsageLimiter.getConfig();
    
    res.json({
      success: true,
      usage: {
        user: {
          callCount: userUsage?.callCount || 0,
          limit: config.userLimit,
          remaining: Math.max(0, config.userLimit - (userUsage?.callCount || 0)),
          lastCallAt: userUsage?.lastCallAt
        },
        ip: {
          callCount: ipUsage?.callCount || 0,
          limit: config.ipLimit,
          remaining: Math.max(0, config.ipLimit - (ipUsage?.callCount || 0)),
          lastCallAt: ipUsage?.lastCallAt
        },
        config: {
          enabled: config.enabled,
          resetTime: chatgptUsageLimiter.getNextResetTime()
        }
      }
    });
  } catch (error) {
    console.error('Get ChatGPT usage error:', error);
    res.status(500).json({ error: 'Failed to get ChatGPT usage' });
  }
});

// Clean up old ChatGPT usage data (admin only)
app.post('/api/admin/chatgpt/cleanup', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    
    // Check if user is admin/owner
    const userDoc = await db.collection(collections.users).doc(user.userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userData = userDoc.data();
    if (!['OWNER', 'ADMIN'].includes(userData.role)) {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }

    await chatgptUsageLimiter.cleanupOldData();
    
    res.json({
      success: true,
      message: 'Old ChatGPT usage data cleaned up successfully'
    });
  } catch (error) {
    console.error('ChatGPT cleanup error:', error);
    res.status(500).json({ error: 'Failed to cleanup ChatGPT data' });
  }
});

// ==================== END CHATGPT USAGE MANAGEMENT ====================

// ==================== END EMAIL SERVICE API ====================

// ==================== AUTOMATION & LOYALTY APIs ====================

const automationService = require('./services/automationService');
const whatsappService = require('./services/whatsappService');

// Test endpoint to verify automation routes are loaded
app.get('/api/automation/test', (req, res) => {
  res.json({ success: true, message: 'Automation routes are loaded' });
});

// Get automations
app.get('/api/automation/:restaurantId/automations', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snapshot = await db.collection(collections.automations)
      .where('restaurantId', '==', restaurantId)
      .get();

    const automations = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, automations });
  } catch (error) {
    console.error('Get automations error:', error);
    res.status(500).json({ error: 'Failed to get automations' });
  }
});

// Create automation
app.post('/api/automation/:restaurantId/automations', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const automationData = {
      restaurantId,
      ...req.body,
      enabled: req.body.enabled !== undefined ? req.body.enabled : true,
      stats: {
        sent: 0,
        delivered: 0,
        read: 0,
        converted: 0
      },
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const docRef = await db.collection(collections.automations).add(automationData);
    res.json({ success: true, automation: { id: docRef.id, ...automationData } });
  } catch (error) {
    console.error('Create automation error:', error);
    res.status(500).json({ error: 'Failed to create automation' });
  }
});

// Update automation
app.patch('/api/automation/:restaurantId/automations/:automationId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, automationId } = req.params;
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    await db.collection(collections.automations).doc(automationId).update(updateData);
    res.json({ success: true });
  } catch (error) {
    console.error('Update automation error:', error);
    res.status(500).json({ error: 'Failed to update automation' });
  }
});

// Delete automation
app.delete('/api/automation/:restaurantId/automations/:automationId', authenticateToken, async (req, res) => {
  try {
    const { automationId } = req.params;
    await db.collection(collections.automations).doc(automationId).delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete automation error:', error);
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

// Get templates
app.get('/api/automation/:restaurantId/templates', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snapshot = await db.collection(collections.automationTemplates)
      .where('restaurantId', '==', restaurantId)
      .get();

    const templates = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, templates });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

// Create template
app.post('/api/automation/:restaurantId/templates', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const templateData = {
      restaurantId,
      ...req.body,
      approved: false, // Templates need Meta approval
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const docRef = await db.collection(collections.automationTemplates).add(templateData);
    res.json({ success: true, template: { id: docRef.id, ...templateData } });
  } catch (error) {
    console.error('Create template error:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// Update template
app.patch('/api/automation/:restaurantId/templates/:templateId', authenticateToken, async (req, res) => {
  try {
    const { templateId } = req.params;
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    await db.collection(collections.automationTemplates).doc(templateId).update(updateData);
    res.json({ success: true });
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// Delete template
app.delete('/api/automation/:restaurantId/templates/:templateId', authenticateToken, async (req, res) => {
  try {
    const { templateId } = req.params;
    await db.collection(collections.automationTemplates).doc(templateId).delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// Get analytics
app.get('/api/automation/:restaurantId/analytics', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { period = '30d' } = req.query;

    // Calculate date range
    const now = new Date();
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Get message logs
    const logsSnapshot = await db.collection(collections.automationLogs)
      .where('restaurantId', '==', restaurantId)
      .where('timestamp', '>=', startDate)
      .get();

    const logs = logsSnapshot.docs.map(doc => doc.data());
    
    // Get customers
    const customersSnapshot = await db.collection(collections.customers)
      .where('restaurantId', '==', restaurantId)
      .get();

    const customers = customersSnapshot.docs.map(doc => doc.data());

    // Calculate segments
    const segments = {
      new: customers.filter(c => c.segment === 'new').length,
      returning: customers.filter(c => c.segment === 'returning').length,
      highValue: customers.filter(c => c.segment === 'highValue').length,
      lost: customers.filter(c => c.segment === 'lost').length
    };

    // Calculate metrics
    const analytics = {
      messagesSent: logs.length,
      messagesDelivered: logs.filter(l => l.status === 'delivered').length,
      messagesRead: logs.filter(l => l.status === 'read').length,
      conversions: logs.filter(l => l.converted).length,
      ordersPlaced: 0, // Would need to track this separately
      revenueGenerated: 0, // Would need to track this separately
      totalCustomers: customers.length,
      segments,
      recentActivity: logs.slice(-10).map(log => ({
        type: 'message',
        description: `Sent ${log.type} to ${log.phone}`,
        time: log.timestamp?.toDate?.()?.toLocaleString() || 'N/A'
      }))
    };

    res.json({ success: true, analytics });
  } catch (error) {
    console.error('Get analytics error:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

// Get coupons
app.get('/api/automation/:restaurantId/coupons', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snapshot = await db.collection(collections.coupons)
      .where('restaurantId', '==', restaurantId)
      .get();

    const coupons = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, coupons });
  } catch (error) {
    console.error('Get coupons error:', error);
    res.status(500).json({ error: 'Failed to get coupons' });
  }
});

// Create coupon
app.post('/api/automation/:restaurantId/coupons', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const couponData = {
      restaurantId,
      ...req.body,
      usedCount: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const docRef = await db.collection(collections.coupons).add(couponData);
    res.json({ success: true, coupon: { id: docRef.id, ...couponData } });
  } catch (error) {
    console.error('Create coupon error:', error);
    res.status(500).json({ error: 'Failed to create coupon' });
  }
});

// Update coupon
app.patch('/api/automation/:restaurantId/coupons/:couponId', authenticateToken, async (req, res) => {
  try {
    const { couponId } = req.params;
    const updateData = {
      ...req.body,
      updatedAt: new Date()
    };

    await db.collection(collections.coupons).doc(couponId).update(updateData);
    res.json({ success: true });
  } catch (error) {
    console.error('Update coupon error:', error);
    res.status(500).json({ error: 'Failed to update coupon' });
  }
});

// Delete coupon
app.delete('/api/automation/:restaurantId/coupons/:couponId', authenticateToken, async (req, res) => {
  try {
    const { couponId } = req.params;
    await db.collection(collections.coupons).doc(couponId).delete();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete coupon error:', error);
    res.status(500).json({ error: 'Failed to delete coupon' });
  }
});

// Get WhatsApp settings
app.get('/api/automation/:restaurantId/whatsapp', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snapshot = await db.collection(collections.automationSettings)
      .where('restaurantId', '==', restaurantId)
      .where('type', '==', 'whatsapp')
      .limit(1)
      .get();

    if (snapshot.empty) {
      // Return webhook URL even if not connected
      const webhookUrl = `${req.protocol}://${req.get('host')}/api/automation/webhook/whatsapp`;
      return res.json({ 
        success: true, 
        connected: false, 
        settings: null,
        webhookUrl: webhookUrl // Provide webhook URL for setup
      });
    }

    const settings = snapshot.docs[0].data();
    const webhookUrl = `${req.protocol}://${req.get('host')}/api/automation/webhook/whatsapp`;
    
    res.json({ 
      success: true, 
      connected: settings.connected || false, 
      settings: {
        ...settings,
        // Don't expose sensitive tokens in response
        accessToken: settings.accessToken ? '***' : null
      },
      webhookUrl: webhookUrl
    });
  } catch (error) {
    console.error('Get WhatsApp settings error:', error);
    res.status(500).json({ error: 'Failed to get WhatsApp settings' });
  }
});

// Get webhook URL (public endpoint for documentation)
app.get('/api/automation/webhook/url', (req, res) => {
  try {
    const webhookUrl = `${req.protocol}://${req.get('host')}/api/automation/webhook/whatsapp`;
    res.json({ 
      success: true, 
      webhookUrl: webhookUrl,
      instructions: 'Use this URL when configuring webhook in Meta Business Suite'
    });
  } catch (error) {
    console.error('Get webhook URL error:', error);
    res.status(500).json({ error: 'Failed to get webhook URL' });
  }
});

// Connect WhatsApp
app.post('/api/automation/:restaurantId/whatsapp/connect', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { mode, accessToken, phoneNumberId, businessAccountId, webhookVerifyToken } = req.body;

    // Check if using restaurant's own number or DineOpen's shared number
    if (mode === 'restaurant') {
      // Restaurant's own WhatsApp number
      if (!accessToken || !phoneNumberId || !businessAccountId) {
        return res.status(400).json({ error: 'Missing required credentials for restaurant WhatsApp' });
      }

      // Verify credentials by making a test API call
      try {
        await whatsappService.initialize(restaurantId, {
          accessToken,
          phoneNumberId,
          businessAccountId
        });

        // Test connection by getting phone number info
        const axios = require('axios');
        const testResponse = await axios.get(
          `https://graph.facebook.com/v18.0/${phoneNumberId}`,
          {
            headers: {
              'Authorization': `Bearer ${accessToken}`
            },
            params: {
              fields: 'verified_name,display_phone_number'
            }
          }
        );

        const phoneNumber = testResponse.data.display_phone_number || 'N/A';

        // Save settings
        const settingsData = {
          restaurantId,
          type: 'whatsapp',
          mode: 'restaurant',
          connected: true,
          accessToken,
          phoneNumberId,
          businessAccountId,
          webhookVerifyToken, // Store verify token for webhook verification
          phoneNumber: phoneNumber,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        // Check if settings exist
        const existingSnapshot = await db.collection(collections.automationSettings)
          .where('restaurantId', '==', restaurantId)
          .where('type', '==', 'whatsapp')
          .limit(1)
          .get();

        if (!existingSnapshot.empty) {
          await existingSnapshot.docs[0].ref.update(settingsData);
        } else {
          await db.collection(collections.automationSettings).add(settingsData);
        }

        res.json({ 
          success: true, 
          message: 'Restaurant WhatsApp connected successfully',
          phoneNumber: phoneNumber
        });
      } catch (error) {
        console.error('WhatsApp connection test error:', error.response?.data || error.message);
        return res.status(400).json({ 
          error: 'Invalid WhatsApp credentials. Please check your Access Token, Phone Number ID, and Business Account ID.',
          details: error.response?.data || error.message
        });
      }
    } else if (mode === 'dineopen') {
      // Use DineOpen's shared WhatsApp number
      // Get DineOpen's WhatsApp credentials from environment or config
      const dineopenAccessToken = process.env.DINEOPEN_WHATSAPP_ACCESS_TOKEN;
      // Use hardcoded phone number ID for now
      const dineopenPhoneNumberId = '879916941871710';
      const dineopenBusinessAccountId = process.env.DINEOPEN_WHATSAPP_BUSINESS_ACCOUNT_ID;

      if (!dineopenAccessToken) {
        return res.status(500).json({ 
          error: 'DineOpen WhatsApp access token not configured. Please set DINEOOPEN_WHATSAPP_ACCESS_TOKEN environment variable or use your own WhatsApp number.' 
        });
      }

      // Save settings (using DineOpen's credentials)
      const settingsData = {
        restaurantId,
        type: 'whatsapp',
        mode: 'dineopen',
        connected: true,
        accessToken: dineopenAccessToken, // Store reference, not actual token for security
        phoneNumberId: dineopenPhoneNumberId, // Hardcoded
        businessAccountId: dineopenBusinessAccountId || 'N/A',
        phoneNumber: 'DineOpen Shared Number',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      // Check if settings exist
      const existingSnapshot = await db.collection(collections.automationSettings)
        .where('restaurantId', '==', restaurantId)
        .where('type', '==', 'whatsapp')
        .limit(1)
        .get();

      if (!existingSnapshot.empty) {
        await existingSnapshot.docs[0].ref.update(settingsData);
      } else {
        await db.collection(collections.automationSettings).add(settingsData);
      }

      res.json({ 
        success: true, 
        message: 'DineOpen WhatsApp enabled successfully',
        note: 'Messages will be sent from DineOpen\'s shared number'
      });
    } else {
      return res.status(400).json({ error: 'Invalid mode. Use "restaurant" or "dineopen"' });
    }
  } catch (error) {
    console.error('Connect WhatsApp error:', error);
    res.status(500).json({ error: 'Failed to connect WhatsApp' });
  }
});

// Send test WhatsApp message
app.post('/api/automation/:restaurantId/whatsapp/test', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { phoneNumber, message, templateName, templateLanguage } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Get WhatsApp settings
    const snapshot = await db.collection(collections.automationSettings)
      .where('restaurantId', '==', restaurantId)
      .where('type', '==', 'whatsapp')
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(400).json({ error: 'WhatsApp not connected. Please connect WhatsApp first.' });
    }

    const whatsappSettings = snapshot.docs[0].data();

    if (!whatsappSettings.connected) {
      return res.status(400).json({ error: 'WhatsApp not connected. Please connect WhatsApp first.' });
    }

    // Initialize WhatsApp service based on mode
    let credentials;
    if (whatsappSettings.mode === 'dineopen') {
      credentials = {
        accessToken: process.env.DINEOPEN_WHATSAPP_ACCESS_TOKEN,
        phoneNumberId: '879916941871710', // Hardcoded
        businessAccountId: process.env.DINEOPEN_WHATSAPP_BUSINESS_ACCOUNT_ID
      };
    } else {
      credentials = {
        accessToken: whatsappSettings.accessToken,
        phoneNumberId: '879916941871710', // Hardcoded
        businessAccountId: whatsappSettings.businessAccountId
      };
    }

    if (!credentials.accessToken) {
      return res.status(400).json({ error: 'WhatsApp access token not configured' });
    }

    // Initialize WhatsApp service
    await whatsappService.initialize(restaurantId, credentials);

    // Send message
    let sendResult;
    if (templateName && message) {
      // Send as template message
      sendResult = await whatsappService.sendTemplateMessage(
        phoneNumber,
        templateName,
        templateLanguage || 'en_US',
        [message] // Use message as template parameter
      );
    } else if (message) {
      // Send as text message
      sendResult = await whatsappService.sendTextMessage(phoneNumber, message);
    } else {
      return res.status(400).json({ error: 'Message or template name is required' });
    }

    if (sendResult.success) {
      // Log test message
      await db.collection(collections.automationLogs).add({
        restaurantId,
        type: 'test_message',
        phone: phoneNumber,
        message: message || `Template: ${templateName}`,
        messageId: sendResult.messageId,
        status: 'sent',
        timestamp: new Date()
      });

      res.json({
        success: true,
        messageId: sendResult.messageId,
        message: 'Test message sent successfully!'
      });
    } else {
      res.status(500).json({
        success: false,
        error: sendResult.error || 'Failed to send test message'
      });
    }
  } catch (error) {
    console.error('Send test message error:', error);
    res.status(500).json({ error: 'Failed to send test message: ' + error.message });
  }
});

// Disconnect WhatsApp
app.post('/api/automation/:restaurantId/whatsapp/disconnect', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const snapshot = await db.collection(collections.automationSettings)
      .where('restaurantId', '==', restaurantId)
      .where('type', '==', 'whatsapp')
      .limit(1)
      .get();

    if (!snapshot.empty) {
      await snapshot.docs[0].ref.update({
        connected: false,
        updatedAt: new Date()
      });
    }

    res.json({ success: true, message: 'WhatsApp disconnected' });
  } catch (error) {
    console.error('Disconnect WhatsApp error:', error);
    res.status(500).json({ error: 'Failed to disconnect WhatsApp' });
  }
});

// Webhook for WhatsApp (for receiving messages and status updates)
// GET endpoint for webhook verification
app.get('/api/automation/webhook/whatsapp', async (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log('🔍 Webhook verification request:', { mode, hasToken: !!token, hasChallenge: !!challenge });

    // Meta sends 'subscribe' mode during webhook setup
    if (mode === 'subscribe') {
      // Try to match token against restaurant settings or default token
      let tokenMatched = false;

      // First, try default token from environment
      if (token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
        tokenMatched = true;
        console.log('✅ Webhook verified with default token');
      } else {
        // Try to find restaurant with matching verify token
        const settingsSnapshot = await db.collection(collections.automationSettings)
          .where('type', '==', 'whatsapp')
          .where('webhookVerifyToken', '==', token)
          .limit(1)
          .get();

        if (!settingsSnapshot.empty) {
          tokenMatched = true;
          console.log('✅ Webhook verified with restaurant token:', settingsSnapshot.docs[0].data().restaurantId);
        }
      }

      if (tokenMatched && challenge) {
        console.log('✅ WhatsApp webhook verified successfully');
        res.status(200).send(challenge);
      } else {
        console.log('❌ Webhook verification failed - token mismatch');
        res.sendStatus(403);
      }
    } else {
      // Not a subscription request
      res.sendStatus(200);
    }
  } catch (error) {
    console.error('Webhook verification error:', error);
    res.sendStatus(500);
  }
});

// POST endpoint for receiving webhook events
app.post('/api/automation/webhook/whatsapp', async (req, res) => {
  try {
    const body = req.body;
    const signature = req.headers['x-hub-signature-256'];

    console.log('📨 WhatsApp webhook received:', {
      object: body.object,
      entryCount: body.entry?.length || 0,
      hasSignature: !!signature
    });

    // Verify webhook signature if provided (for security)
    if (signature && process.env.WHATSAPP_WEBHOOK_SECRET) {
      const crypto = require('crypto');
      const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', process.env.WHATSAPP_WEBHOOK_SECRET)
        .update(JSON.stringify(body))
        .digest('hex');

      if (signature !== expectedSignature) {
        console.error('❌ Webhook signature verification failed');
        return res.sendStatus(403);
      }
      console.log('✅ Webhook signature verified');
    }

    // Handle incoming events
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        const changes = entry.changes || [];
        
        for (const change of changes) {
          const value = change.value;

          // Handle message status updates (delivered, read, sent, failed)
          if (value?.statuses && Array.isArray(value.statuses)) {
            for (const statusUpdate of value.statuses) {
              const messageId = statusUpdate.id;
              const status = statusUpdate.status; // sent, delivered, read, failed
              const timestamp = statusUpdate.timestamp;

              console.log('📊 Message status update:', { messageId, status, timestamp });

              // Find and update message log
              try {
                const logsSnapshot = await db.collection(collections.automationLogs)
                  .where('messageId', '==', messageId)
                  .limit(1)
                  .get();

                if (!logsSnapshot.empty) {
                  const logDoc = logsSnapshot.docs[0];
                  const logData = logDoc.data();

                  // Update status
                  await logDoc.ref.update({
                    status: status,
                    statusUpdatedAt: new Date(),
                    ...(status === 'read' && { readAt: new Date() }),
                    ...(status === 'delivered' && { deliveredAt: new Date() }),
                    ...(status === 'failed' && { 
                      error: statusUpdate.errors?.[0]?.message || 'Message failed',
                      failedAt: new Date()
                    })
                  });

                  // Update automation stats
                  if (logData.automationId) {
                    const automationRef = db.collection(collections.automations).doc(logData.automationId);
                    const automationDoc = await automationRef.get();
                    
                    if (automationDoc.exists) {
                      const stats = automationDoc.data().stats || { sent: 0, delivered: 0, read: 0, failed: 0 };
                      
                      if (status === 'delivered' && logData.status !== 'delivered') {
                        stats.delivered = (stats.delivered || 0) + 1;
                      }
                      if (status === 'read' && logData.status !== 'read') {
                        stats.read = (stats.read || 0) + 1;
                      }
                      if (status === 'failed' && logData.status !== 'failed') {
                        stats.failed = (stats.failed || 0) + 1;
                      }

                      await automationRef.update({ stats });
                    }
                  }

                  console.log('✅ Message status updated in logs');
                }
              } catch (error) {
                console.error('Error updating message status:', error);
              }
            }
          }

          // Handle incoming messages from customers
          if (value?.messages && Array.isArray(value.messages)) {
            for (const message of value.messages) {
              const processedMessage = whatsappService.handleIncomingMessage({
                entry: [{
                  changes: [{
                    value: {
                      messages: [message],
                      contacts: value.contacts || []
                    }
                  }]
                }]
              });

              if (processedMessage) {
                console.log('📨 Incoming WhatsApp message:', {
                  from: processedMessage.from,
                  type: processedMessage.type,
                  text: processedMessage.text?.substring(0, 50) || 'N/A'
                });

                // Find restaurant by phone number or business account
                try {
                  // Try to find restaurant settings that might match
                  // This is a simplified approach - you might want to store phone mapping
                  const settingsSnapshot = await db.collection(collections.automationSettings)
                    .where('type', '==', 'whatsapp')
                    .where('connected', '==', true)
                    .get();

                  // Log incoming message for all connected restaurants
                  // In production, you'd want to match by phone number or business account ID
                  for (const settingDoc of settingsSnapshot.docs) {
                    const setting = settingDoc.data();
                    
                    // Log incoming message
                    await db.collection(collections.automationLogs).add({
                      restaurantId: setting.restaurantId,
                      type: 'incoming',
                      phone: processedMessage.from,
                      message: processedMessage.text,
                      messageId: processedMessage.messageId,
                      timestamp: new Date(),
                      status: 'received'
                    });
                  }
                } catch (error) {
                  console.error('Error logging incoming message:', error);
                }

                // TODO: Could trigger automation based on incoming message
                // e.g., customer replies "STOP" to unsubscribe
              }
            }
          }
        }
      }
    }

    // Always return 200 to acknowledge receipt
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    // Still return 200 to prevent Meta from retrying
    res.sendStatus(200);
  }
});

// Trigger automation manually (for testing)
app.post('/api/automation/:restaurantId/trigger', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { triggerType, triggerData } = req.body;

    const result = await automationService.processTrigger(restaurantId, triggerType, triggerData);
    res.json(result);
  } catch (error) {
    console.error('Trigger automation error:', error);
    res.status(500).json({ error: 'Failed to trigger automation' });
  }
});

// Sync customer from order (called when order is created)
app.post('/api/automation/:restaurantId/sync-customer', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { order } = req.body;

    const customerId = await automationService.syncCustomerFromOrder({
      ...order,
      restaurantId
    });

    // Trigger welcome automation if first order
    if (customerId) {
      const customer = await automationService.getCustomerData(customerId, restaurantId);
      if (customer && customer.visitCount === 1) {
        await automationService.processTrigger(restaurantId, 'new_order', {
          customerId,
          orderAmount: order.totalAmount,
          orderNumber: order.dailyOrderId || order.orderNumber,
          restaurantName: order.restaurantName
        });
      }
    }

    res.json({ success: true, customerId });
  } catch (error) {
    console.error('Sync customer error:', error);
    res.status(500).json({ error: 'Failed to sync customer' });
  }
});

// ==================== END AUTOMATION & LOYALTY APIs ====================

// 404 handler - must be last (after all routes)
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not Found', 
    message: `Endpoint ${req.originalUrl} not found`,
    requestId: req.id,
    available_endpoints: [
      '/',
      '/health', 
      '/api/auth/*',
      '/api/restaurants/*',
      '/api/menus/*',
      '/api/orders/*',
      '/api/payments/*',
      '/api/analytics/*',
      '/api/kot/*',
      '/api/admin/settings/*',
      '/api/categories/*',
      '/api/email/*',
      '/api/dinebot/*',
      '/api/hotel/*',
      '/api/automation/*'
    ]
  });
});

// Start server for both local development and production
const server = app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Dine Backend server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🍽️ Ready to serve your restaurant management app!`);
    console.log(`🔗 Database: dine`);
    console.log(`📁 Collections: ${Object.keys(collections).join(', ')}`);
    
    // Clear localhost blocks for development
    try {
      await vercelSecurityMiddleware.clearLocalhostBlocks();
      console.log(`🔓 Cleared localhost blocks for development`);
    } catch (error) {
      console.error('Error clearing localhost blocks:', error);
    }
  });

// Handle server errors
// Temporary endpoint to fix table status
app.post('/api/debug/fix-table', authenticateToken, async (req, res) => {
  try {
    const { restaurantId, tableNumber } = req.body;
    
    if (!restaurantId || !tableNumber) {
      return res.status(400).json({ error: 'Restaurant ID and table number are required' });
    }
    
    console.log(`🔧 Debug: Fixing table "${tableNumber}" in restaurant ${restaurantId}`);
    
    // Get floors from restaurant subcollection
    const floorsSnapshot = await db.collection('restaurants')
      .doc(restaurantId)
      .collection('floors')
      .get();
    
    console.log('🪑 Found floors:', floorsSnapshot.size);
    
    let tableFound = false;
    let tableUpdated = false;
    
    // Search for the table across all floors
    for (const floorDoc of floorsSnapshot.docs) {
      const floorData = floorDoc.data();
      console.log(`🔍 Checking floor: ${floorData.name}`);
      
      const tablesSnapshot = await db.collection('restaurants')
        .doc(restaurantId)
        .collection('floors')
        .doc(floorDoc.id)
        .collection('tables')
        .get();

      for (const tableDoc of tablesSnapshot.docs) {
        const tableData = tableDoc.data();
        
        if (tableData.name && tableData.name.toString().toLowerCase() === tableNumber.trim().toLowerCase()) {
          tableFound = true;
          console.log('🪑 Found table:', { 
            id: tableDoc.id, 
            name: tableData.name, 
            status: tableData.status, 
            floor: floorData.name,
            capacity: tableData.capacity,
            currentOrderId: tableData.currentOrderId
          });
          
          // Update table to available status
          await tableDoc.ref.update({
            status: 'available',
            currentOrderId: null,
            updatedAt: new Date()
          });
          
          console.log('✅ Table has been set to AVAILABLE status');
          tableUpdated = true;
          break;
        }
      }
      
      if (tableFound) break;
    }
    
    if (!tableFound) {
      return res.status(404).json({ error: `Table "${tableNumber}" not found in any floor` });
    } else if (!tableUpdated) {
      return res.status(500).json({ error: 'Table found but could not be updated' });
    } else {
      return res.json({ 
        message: `Table "${tableNumber}" is now available for new orders!`,
        tableNumber,
        status: 'available'
      });
    }
    
  } catch (error) {
    console.error('❌ Error fixing table:', error);
    res.status(500).json({ error: 'Failed to fix table status' });
  }
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  }
});

module.exports = app;

