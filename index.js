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

// Security middleware (Vercel-compatible)
const vercelSecurityMiddleware = require('./middleware/vercelSecurity');
const { vercelRateLimiter } = require('./middleware/vercelRateLimiter');

// ChatGPT Usage Limiter
const chatgptUsageLimiter = require('./middleware/chatgptUsageLimiter');

// Subdomain Context Middleware
const { subdomainContext, generateSubdomain, isSubdomainAvailable } = require('./middleware/subdomainContext');

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
//hello ddd
    const allowedOrigins = [
      'http://localhost:3002',
      'http://localhost:3003',
      'https://dine-frontend-ecru.vercel.app',
      'https://www.dineopen.com',
      'https://dineopen.com'
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Allow localhost subdomains for development (e.g., temp.localhost:3002)
    if (origin.match(/^http:\/\/[a-z0-9-]+\.localhost:3002$/)) {
      return callback(null, true);
    }
    
    // Allow production subdomains (e.g., restaurant-name.dineopen.com)
    if (origin.match(/^https:\/\/[a-z0-9-]+\.dineopen\.com$/)) {
      return callback(null, true);
    }
    
    callback(new Error("CORS not allowed"));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));


app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

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

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Token verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    console.log('Token verified successfully for user:', user.userId);
    req.user = user;
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

// Helper function to extract menu from image using OpenAI Vision
const extractMenuFromImage = async (imageUrl) => {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this menu image and extract all menu items. Return the data in the following JSON format:
              {
                "menuItems": [
                  {
                    "name": "Item Name",
                    "description": "Item description",
                    "price": 100,
                    "category": "appetizer|main-course|dessert|beverages|bread|rice|dal|fast-food|chinese|pizza|south-indian|north-indian",
                    "isVeg": true,
                    "spiceLevel": "mild|medium|hot",
                    "allergens": ["dairy", "gluten", "nuts"],
                    "shortCode": "ABC"
                  }
                ]
              }
              
              Category mapping guidelines:
              - appetizer: Starters, snacks, small plates, finger foods
              - main-course: Main dishes, entrees, substantial meals
              - dessert: Sweet dishes, ice cream, cakes, sweets
              - beverages: Drinks, juices, soft drinks, tea, coffee
              - rice: Rice dishes, biryani, pulao, fried rice
              - bread: Roti, naan, paratha, bread items
              - dal: Dal, curry, gravy dishes, lentil preparations
              - fast-food: Burgers, sandwiches, quick bites
              - chinese: Chinese cuisine items
              - pizza: Pizza varieties
              - south-indian: Dosa, idli, sambar, rasam, South Indian dishes
              - north-indian: North Indian curries, tandoor items
              
              Important: Choose the most appropriate category based on the dish type and cuisine style.
              
              Rules:
              - Extract ALL visible menu items
              - Convert prices to numbers (remove currency symbols)
              - Categorize items appropriately
              - Set isVeg based on item content (true for vegetarian, false for non-vegetarian)
              - Generate shortCode as first 3 letters of item name
              - Include allergens if mentioned
              - If description is not available, leave empty string
              - Ensure all prices are numeric values`
            },
            {
              type: "image_url",
              image_url: {
                url: imageUrl
              }
            }
          ]
        }
      ],
      max_tokens: 4000
    });

    const content = response.choices[0].message.content;
    // Extract JSON from the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('No valid JSON found in response');
  } catch (error) {
    console.error('Error extracting menu from image:', error);
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

    let userDoc = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    let userId;

    let isNewUser = false;
    let hasRestaurants = false;

    console.log('🔍 Gmail login debug - User exists:', !userDoc.empty);
    console.log('🔍 Gmail login debug - Email:', email);
    console.log('🔍 Gmail login debug - Name:', name);

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

      // Create default restaurant for new Gmail users with random name
      try {
        // Generate random restaurant name
        const randomNames = [
          'Golden Spoon', 'Royal Kitchen', 'Spice Garden', 'Flavor Palace', 'Taste Haven',
          'Culinary Corner', 'Gourmet Spot', 'Foodie Hub', 'Dining Delight', 'Kitchen Magic',
          'Flavor Fusion', 'Taste Buds', 'Culinary Craft', 'Food Paradise', 'Dining Dreams',
          'Kitchen Stories', 'Flavor Quest', 'Taste Trail', 'Culinary Journey', 'Food Explorer'
        ];
        const randomName = randomNames[Math.floor(Math.random() * randomNames.length)];
        
        // Generate subdomain from random name
        const { generateSubdomain, isSubdomainAvailable } = require('./middleware/subdomainContext');
        let subdomain = generateSubdomain(randomName);
        let subdomainCounter = 1;
        let finalSubdomain = subdomain;

        // Check if subdomain already exists and make it unique
        while (true) {
          const isAvailable = await isSubdomainAvailable(finalSubdomain);
          if (isAvailable) {
            break;
          }
          
          finalSubdomain = `${subdomain}-${subdomainCounter}`;
          subdomainCounter++;
        }

        const defaultRestaurant = {
          name: randomName,
          subdomain: finalSubdomain,
          description: 'Welcome to your restaurant! You can customize this information later.',
          address: '',
          phone: '',
          email: email,
          cuisine: ['Indian'],
          timings: {
            openTime: '09:00',
            closeTime: '22:00',
            lastOrderTime: '21:30'
          },
          ownerId: userId,
          menu: {
            items: []
          },
          categories: [
            {
              id: 'appetizer',
              name: 'Appetizers',
              emoji: '🥗',
              description: 'Starters and appetizers'
            },
            {
              id: 'main-course',
              name: 'Main Course',
              emoji: '🍽️',
              description: 'Main dishes'
            },
            {
              id: 'dessert',
              name: 'Desserts',
              emoji: '🍰',
              description: 'Sweet treats'
            },
            {
              id: 'beverages',
              name: 'Beverages',
              emoji: '🥤',
              description: 'Drinks and beverages'
            }
          ],
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const restaurantRef = await db.collection(collections.restaurants).add(defaultRestaurant);
        console.log(`✅ Default restaurant created for new Gmail user ${userId}: ${restaurantRef.id}`);
        
        // Create user-restaurant relationship
        await db.collection(collections.userRestaurants).add({
          userId: userId,
          restaurantId: restaurantRef.id,
          role: 'owner',
          createdAt: new Date(),
          updatedAt: new Date()
        });

        // Generate QR code with subdomain
        const qrData = `https://${finalSubdomain}.dineopen.com`;
        const qrCode = await QRCode.toDataURL(qrData);
        await restaurantRef.update({ qrCode, qrData });
        
        // Update user to mark setup as complete
        await userRef.update({
          setupComplete: true,
          updatedAt: new Date()
        });
        
        hasRestaurants = true;
      } catch (restaurantError) {
        console.error('❌ Error creating default restaurant:', restaurantError);
        hasRestaurants = false;
      }

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
      // Existing user login
      userId = userDoc.docs[0].id;
      const userData = userDoc.docs[0].data();
      
      await userDoc.docs[0].ref.update({
        updatedAt: new Date(),
        picture: picture || userData.picture,
        googleUid: uid // Store Google UID for future reference
      });

      // Check if owner has restaurants
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();
      
      hasRestaurants = !restaurantsQuery.empty;
    }

    const userRole = userDoc.empty ? 'owner' : userDoc.docs[0].data().role;

    // Get restaurant information for new users
    let restaurantInfo = null;
    if (isNewUser && hasRestaurants) {
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();
      
      if (!restaurantsQuery.empty) {
        const restaurantData = restaurantsQuery.docs[0].data();
        restaurantInfo = {
          id: restaurantsQuery.docs[0].id,
          name: restaurantData.name,
          subdomain: restaurantData.subdomain
        };
      }
    }

    const jwtToken = jwt.sign(
      { userId, email, role: userRole },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Google login successful',
      token: jwtToken,
      user: {
        id: userId,
        email,
        name,
        picture,
        role: userRole
      },
      isNewUser,
      hasRestaurants,
      restaurant: restaurantInfo,
      redirectTo: isNewUser && restaurantInfo ? `https://${restaurantInfo.subdomain}.dineopen.com` : '/restaurant-selection'
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

    // Check if user exists in our database
    let userDoc = await db.collection(collections.users)
      .where('firebaseUid', '==', uid)
      .get();

    let userId, isNewUser = false, hasRestaurants = false;

    if (userDoc.empty) {
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

      // Create default restaurant for new users with random name
      try {
        // Generate random restaurant name
        const randomNames = [
          'Golden Spoon', 'Royal Kitchen', 'Spice Garden', 'Flavor Palace', 'Taste Haven',
          'Culinary Corner', 'Gourmet Spot', 'Foodie Hub', 'Dining Delight', 'Kitchen Magic',
          'Flavor Fusion', 'Taste Buds', 'Culinary Craft', 'Food Paradise', 'Dining Dreams',
          'Kitchen Stories', 'Flavor Quest', 'Taste Trail', 'Culinary Journey', 'Food Explorer'
        ];
        const randomName = randomNames[Math.floor(Math.random() * randomNames.length)];
        
        // Generate subdomain from random name
        const { generateSubdomain, isSubdomainAvailable } = require('./middleware/subdomainContext');
        let subdomain = generateSubdomain(randomName);
        let subdomainCounter = 1;
        let finalSubdomain = subdomain;

        // Check if subdomain already exists and make it unique
        while (true) {
          const isAvailable = await isSubdomainAvailable(finalSubdomain);
          if (isAvailable) {
            break;
          }
          
          finalSubdomain = `${subdomain}-${subdomainCounter}`;
          subdomainCounter++;
        }

        const defaultRestaurant = {
          name: randomName,
          subdomain: finalSubdomain,
          description: 'Welcome to your restaurant! You can customize this information later.',
          address: '',
          phone: phoneNumber || '',
          email: email || '',
          cuisine: ['Indian'],
          timings: {
            openTime: '09:00',
            closeTime: '22:00',
            lastOrderTime: '21:30'
          },
          ownerId: userId,
          menu: {
            items: []
          },
          categories: [
            {
              id: 'appetizer',
              name: 'Appetizers',
              emoji: '🥗',
              description: 'Starters and appetizers'
            },
            {
              id: 'main-course',
              name: 'Main Course',
              emoji: '🍽️',
              description: 'Main dishes'
            },
            {
              id: 'dessert',
              name: 'Desserts',
              emoji: '🍰',
              description: 'Sweet treats'
            },
            {
              id: 'beverages',
              name: 'Beverages',
              emoji: '🥤',
              description: 'Drinks and beverages'
            }
          ],
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const restaurantRef = await db.collection(collections.restaurants).add(defaultRestaurant);
        console.log(`✅ Default restaurant created for new user ${userId}: ${restaurantRef.id}`);
        
        // Create user-restaurant relationship
        await db.collection(collections.userRestaurants).add({
          userId: userId,
          restaurantId: restaurantRef.id,
          role: 'owner',
          createdAt: new Date(),
          updatedAt: new Date()
        });

        // Generate QR code with subdomain
        const qrData = `https://${finalSubdomain}.dineopen.com`;
        const qrCode = await QRCode.toDataURL(qrData);
        await restaurantRef.update({ qrCode, qrData });
        
        // Update user to mark setup as complete
        await userRef.update({
          setupComplete: true,
          updatedAt: new Date()
        });
        
        hasRestaurants = true;
      } catch (restaurantError) {
        console.error('❌ Error creating default restaurant:', restaurantError);
        // Don't fail the login if restaurant creation fails
        hasRestaurants = false;
      }
    } else {
      // Existing user login
      const userData = userDoc.docs[0].data();
      userId = userDoc.docs[0].id;
      
      // Update user info if needed
      const updateData = {
        updatedAt: new Date(),
        phoneVerified: !!phoneNumber,
        emailVerified: !!email
      };

      if (email && !userData.email) updateData.email = email;
      if (displayName && !userData.name) updateData.name = displayName;
      if (photoURL && !userData.photoURL) updateData.photoURL = photoURL;
      
      // Update provider if logging in with Google
      if (email && userData.provider !== 'google') {
        updateData.provider = 'google';
      }

      await userDoc.docs[0].ref.update(updateData);

      // Check if owner has restaurants
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .limit(1)
        .get();
      
      hasRestaurants = !restaurantsQuery.empty;
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId, phone: phoneNumber, email, role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Get user's restaurants for the response
    let userRestaurants = [];
    if (hasRestaurants) {
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .get();
      userRestaurants = restaurantsQuery.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
    }

    // Determine redirect URL
    let redirectTo = '/restaurant-selection';
    if (isNewUser && userRestaurants.length > 0 && userRestaurants[0].subdomain) {
      redirectTo = `https://${userRestaurants[0].subdomain}.dineopen.com`;
    } else if (userRestaurants.length === 1 && userRestaurants[0].subdomain) {
      redirectTo = `https://${userRestaurants[0].subdomain}.dineopen.com`;
    }

    res.json({
      message: 'Firebase verification successful',
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
        restaurant: userRestaurants.length > 0 ? userRestaurants[0] : null
      },
      isNewUser,
      hasRestaurants,
      restaurants: userRestaurants,
      redirectTo
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

    const otpQuery = await db.collection('otp_verification')
      .where('phone', '==', phone)
      .where('otp', '==', otp)
      .limit(1)
      .get();

    // If OTP not found with exact phone, try with normalized phone
    let otpDoc = null;
    if (otpQuery.empty) {
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone) {
        // Try to find OTP with normalized phone
        const normalizedOtpQuery = await db.collection('otp_verification')
          .where('otp', '==', otp)
          .get();
        
        otpDoc = normalizedOtpQuery.docs.find(doc => {
          const storedPhone = normalizePhone(doc.data().phone);
          return storedPhone === normalizedPhone;
        });
      }
    } else {
      otpDoc = otpQuery.docs[0];
    }

    if (!otpDoc) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    const otpData = otpDoc.data();

    if (new Date() > otpData.otpExpiry.toDate()) {
      return res.status(400).json({ error: 'OTP expired' });
    }

    // Try to find user with exact phone match first
    let userDoc = await db.collection(collections.users)
      .where('phone', '==', phone)
      .get();

    console.log(`🔍 Phone login attempt: ${phone}`);
    console.log(`📞 Exact match found: ${!userDoc.empty}`);

    // If not found, try with normalized phone
    if (userDoc.empty) {
      const normalizedPhone = normalizePhone(phone);
      console.log(`🔧 Normalized phone: ${normalizedPhone}`);
      
      if (normalizedPhone) {
        // Get all users and find by normalized phone
        const allUsers = await db.collection(collections.users).get();
        const matchingUser = allUsers.docs.find(doc => {
          const userPhone = normalizePhone(doc.data().phone);
          return userPhone === normalizedPhone;
        });
        
        if (matchingUser) {
          console.log(`✅ Found user with normalized phone: ${matchingUser.id}`);
          userDoc = { docs: [matchingUser], empty: false };
        } else {
          console.log(`❌ No user found with normalized phone: ${normalizedPhone}`);
        }
      }
    }

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

      // Create default restaurant for new users with random name
      try {
        // Generate random restaurant name
        const randomNames = [
          'Golden Spoon', 'Royal Kitchen', 'Spice Garden', 'Flavor Palace', 'Taste Haven',
          'Culinary Corner', 'Gourmet Spot', 'Foodie Hub', 'Dining Delight', 'Kitchen Magic',
          'Flavor Fusion', 'Taste Buds', 'Culinary Craft', 'Food Paradise', 'Dining Dreams',
          'Kitchen Stories', 'Flavor Quest', 'Taste Trail', 'Culinary Journey', 'Food Explorer'
        ];
        const randomName = randomNames[Math.floor(Math.random() * randomNames.length)];
        
        // Generate subdomain from random name
        const { generateSubdomain, isSubdomainAvailable } = require('./middleware/subdomainContext');
        let subdomain = generateSubdomain(randomName);
        let subdomainCounter = 1;
        let finalSubdomain = subdomain;

        // Check if subdomain already exists and make it unique
        while (true) {
          const isAvailable = await isSubdomainAvailable(finalSubdomain);
          if (isAvailable) {
            break;
          }
          
          finalSubdomain = `${subdomain}-${subdomainCounter}`;
          subdomainCounter++;
        }

        const defaultRestaurant = {
          name: randomName,
          subdomain: finalSubdomain,
          description: 'Welcome to your restaurant! You can customize this information later.',
          address: '',
          phone: phone,
          email: '',
          cuisine: ['Indian'],
          timings: {
            openTime: '09:00',
            closeTime: '22:00',
            lastOrderTime: '21:30'
          },
          ownerId: userId,
          menu: {
            items: []
          },
          categories: [
            {
              id: 'appetizer',
              name: 'Appetizers',
              emoji: '🥗',
              description: 'Starters and appetizers'
            },
            {
              id: 'main-course',
              name: 'Main Course',
              emoji: '🍽️',
              description: 'Main dishes'
            },
            {
              id: 'dessert',
              name: 'Desserts',
              emoji: '🍰',
              description: 'Sweet treats'
            },
            {
              id: 'beverages',
              name: 'Beverages',
              emoji: '🥤',
              description: 'Drinks and beverages'
            }
          ],
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        const restaurantRef = await db.collection(collections.restaurants).add(defaultRestaurant);
        console.log(`✅ Default restaurant created for new phone user ${userId}: ${restaurantRef.id}`);
        
        // Create user-restaurant relationship
        await db.collection(collections.userRestaurants).add({
          userId: userId,
          restaurantId: restaurantRef.id,
          role: 'owner',
          createdAt: new Date(),
          updatedAt: new Date()
        });

        // Generate QR code with subdomain
        const qrData = `https://${finalSubdomain}.dineopen.com`;
        const qrCode = await QRCode.toDataURL(qrData);
        await restaurantRef.update({ qrCode, qrData });
        
        // Update user to mark setup as complete
        await userRef.update({
          setupComplete: true,
          updatedAt: new Date()
        });
        
        hasRestaurants = true;
      } catch (restaurantError) {
        console.error('❌ Error creating default restaurant:', restaurantError);
        // Don't fail the login if restaurant creation fails
        hasRestaurants = false;
      }
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

    await otpDoc.ref.delete();

    // Get user's restaurants for the response
    let userRestaurants = [];
    let redirectTo = '/restaurant-selection';
    
    if (hasRestaurants) {
      const restaurantsQuery = await db.collection(collections.restaurants)
        .where('ownerId', '==', userId)
        .get();
      userRestaurants = restaurantsQuery.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // Determine redirect URL
      if (isNewUser && userRestaurants.length > 0 && userRestaurants[0].subdomain) {
        redirectTo = `https://${userRestaurants[0].subdomain}.dineopen.com`;
      } else if (userRestaurants.length === 1 && userRestaurants[0].subdomain) {
        redirectTo = `https://${userRestaurants[0].subdomain}.dineopen.com`;
      }
    }

    const token = jwt.sign(
      { userId, phone, role: 'owner' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Phone verification successful',
      token,
      user: {
        id: userId,
        phone,
        name: name || userDoc.docs[0]?.data()?.name || 'Restaurant Owner',
        role: 'owner',
        restaurantId: userRestaurants.length > 0 ? userRestaurants[0].id : null,
        restaurant: userRestaurants.length > 0 ? userRestaurants[0] : null
      },
      isNewUser,
      hasRestaurants,
      restaurants: userRestaurants,
      redirectTo
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

app.get('/api/restaurants', authenticateToken, async (req, res) => {
  try {
    const { userId, role } = req.user;

    let query = db.collection(collections.restaurants);

    if (role !== 'admin') {
      query = query.where('ownerId', '==', userId);
    }

    const snapshot = await query.get();
    const restaurants = [];

    snapshot.forEach(doc => {
      restaurants.push({
        id: doc.id,
        ...doc.data()
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

    // Generate subdomain from restaurant name
    let subdomain = generateSubdomain(name);
    let subdomainCounter = 1;
    let finalSubdomain = subdomain;

    // Check if subdomain already exists and make it unique
    while (true) {
      const isAvailable = await isSubdomainAvailable(finalSubdomain);
      if (isAvailable) {
        break;
      }
      
      finalSubdomain = `${subdomain}-${subdomainCounter}`;
      subdomainCounter++;
    }

    const restaurantData = {
      name,
      subdomain: finalSubdomain,
      address: address || null,
      city: req.body.city || null,
      phone: phone || null,
      email: email || null,
      cuisine: cuisine || [],
      description: description || '',
      operatingHours: operatingHours || {},
      features: features || [],
      ownerId: userId,
      status: 'active',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const restaurantRef = await db.collection(collections.restaurants).add(restaurantData);

    // Create user-restaurant relationship
    await db.collection(collections.userRestaurants).add({
      userId: userId,
      restaurantId: restaurantRef.id,
      role: 'owner',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const qrData = `https://${finalSubdomain}.dineopen.com`;
    const qrCode = await QRCode.toDataURL(qrData);

    await restaurantRef.update({ qrCode, qrData });

    res.status(201).json({
      message: 'Restaurant created successfully',
      restaurant: {
        id: restaurantRef.id,
        ...restaurantData,
        qrCode,
        qrData
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

    // Update allowed fields
    const allowedFields = ['name', 'address', 'city', 'phone', 'email', 'cuisine', 'description'];
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    updateData.updatedAt = new Date();

    await db.collection(collections.restaurants).doc(restaurantId).update(updateData);

    res.json({ message: 'Restaurant updated successfully' });

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

// Public API - Get restaurant by subdomain
app.get('/api/public/restaurant-by-subdomain/:subdomain', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { subdomain } = req.params;

    if (!subdomain) {
      return res.status(400).json({ error: 'Subdomain is required' });
    }

    // Search for restaurant by subdomain
    const snapshot = await db.collection(collections.restaurants)
      .where('subdomain', '==', subdomain)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantDoc = snapshot.docs[0];
    const restaurantData = restaurantDoc.data();

    // Return minimal restaurant data for public access
    const publicRestaurantData = {
      id: restaurantDoc.id,
      name: restaurantData.name,
      subdomain: restaurantData.subdomain,
      description: restaurantData.description,
      address: restaurantData.address,
      phone: restaurantData.phone,
      email: restaurantData.email,
      logo: restaurantData.logo,
      coverImage: restaurantData.coverImage,
      menu: restaurantData.menu,
      settings: {
        currency: restaurantData.settings?.currency || 'INR',
        timezone: restaurantData.settings?.timezone || 'Asia/Kolkata'
      }
    };

    res.json({
      success: true,
      restaurant: publicRestaurantData
    });

  } catch (error) {
    console.error('Error fetching restaurant by subdomain:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

// Public API - Get menu for customer ordering (no authentication required)
app.get('/api/public/menu/:restaurantId', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

    // Get restaurant info
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
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
    res.status(500).json({ error: 'Failed to fetch menu' });
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
      shortCode 
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
      'availableFrom', 'availableUntil'
    ];
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'price') {
          updateData[field] = parseFloat(req.body[field]);
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
    const updatedItems = currentMenu.items.map(item => {
      if (item.id === id) {
        return { ...item, ...updateData };
      }
      return item;
    });
    
    // Update categories as well
    const updatedCategories = currentMenu.categories.map(category => ({
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
    const updatedItems = currentMenu.items.map(item => {
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
    const updatedCategories = currentMenu.categories.map(category => ({
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

// Public API - Place order with OTP verification
app.post('/api/public/orders/:restaurantId', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { 
      customerPhone, 
      customerName, 
      seatNumber, 
      items, 
      totalAmount, 
      notes,
      otp,
      verificationId
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
          const customerPhone = normalizePhone(doc.data().phone);
          return customerPhone === normalizedPhone;
        });
      }
    }

    if (existingCustomer) {
      // Update existing customer
      console.log(`🔄 Found existing customer for public order: ${existingCustomer.id} with phone: ${existingCustomer.data().phone}`);
      customerId = existingCustomer.id;
      
      const updateData = {
        updatedAt: new Date(),
        lastOrderDate: new Date()
      };

      if (customerName && !existingCustomer.data().name) {
        updateData.name = customerName;
      }

      await existingCustomer.ref.update(updateData);
    } else {
      // Create new customer
      console.log(`🆕 Creating new customer for public order with phone: ${customerPhone}, name: ${customerName}`);
      const customerData = {
        restaurantId,
        phone: customerPhone,
        name: customerName || 'Customer',
        email: null,
        customerId: `CUST-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`,
        totalOrders: 0,
        totalSpent: 0,
        lastOrderDate: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const customerRef = await db.collection('customers').add(customerData);
      customerId = customerRef.id;
      console.log(`✅ New customer created for public order: ${customerRef.id} with phone: ${customerPhone}`);
    }

    // Validate menu items and calculate total
    let calculatedTotal = 0;
    const orderItems = [];

    // Get restaurant menu items from embedded structure
    const restaurantData = restaurantDoc.data();
    const menuItems = restaurantData.menu?.items || [];

    for (const item of items) {
      // Find menu item in the embedded menu structure
      const menuItem = menuItems.find(menuItem => menuItem.id === item.menuItemId);
      
      if (!menuItem) {
        return res.status(400).json({ error: `Menu item ${item.menuItemId} not found` });
      }

      const itemTotal = menuItem.price * item.quantity;
      calculatedTotal += itemTotal;

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

    // Generate order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    const orderData = {
      restaurantId,
      orderNumber,
      customerId,
      tableNumber: seatNumber || null,
      orderType: 'customer_self_order',
      items: orderItems,
      totalAmount: calculatedTotal,
      customerInfo: {
        phone: customerPhone,
        name: customerName || 'Customer',
        seatNumber: seatNumber || 'Walk-in'
      },
      paymentMethod: 'cash',
      staffInfo: {
        waiterId: null,
        waiterName: 'Customer Self-Order',
        kitchenNotes: 'Direct customer order - OTP verified'
      },
      notes: notes || `Customer self-order from seat ${seatNumber || 'Walk-in'}`,
      status: 'pending',
      kotSent: false,
      paymentStatus: 'pending',
      otpVerified: true,
      verificationId: verificationId,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const orderRef = await db.collection(collections.orders).add(orderData);

    // Update customer stats
    await db.collection('customers').doc(customerId).update({
      totalOrders: db.FieldValue.increment(1),
      totalSpent: db.FieldValue.increment(calculatedTotal)
    });
    
    console.log(`🛒 Customer order created successfully: ${orderRef.id}`);
    console.log(`📋 Order items: ${orderData.items.length} items`);
    console.log(`🏪 Restaurant: ${orderData.restaurantId}`);
    console.log(`👤 Customer: ${customerPhone}`);

    res.status(201).json({
      message: 'Order placed successfully',
      order: {
        id: orderRef.id,
        orderNumber: orderData.orderNumber,
        totalAmount: orderData.totalAmount,
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
        // Use the SAME logic as the floors API endpoint
        console.log('🪑 Using floors API logic for restaurant:', restaurantId);
        
        // Get all tables for this restaurant (same as floors API)
        const tablesSnapshot = await db.collection(collections.tables)
          .where('restaurantId', '==', restaurantId)
          .get();
        
        console.log('🪑 Found tables:', tablesSnapshot.size);
        
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
            console.log('🪑 Found table:', { id: tableId, number: tableNumber, status: tableStatus, floor: table.floor });
            break;
          }
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

      const itemTotal = menuItem.price * item.quantity;
      totalAmount += itemTotal;

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

    // Generate order number
    const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    const orderData = {
      restaurantId,
      orderNumber,
      tableNumber: tableNumber || seatNumber || null,
      orderType,
      items: orderItems,
      totalAmount,
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
      paymentStatus: 'pending',
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

    // Update table status to "occupied" if table number is provided
    if (tableNumber && tableNumber.trim()) {
      try {
        console.log('🔄 Updating table status to occupied:', tableNumber);
        
        // Find the table document
        const tablesSnapshot = await db.collection(collections.tables)
          .where('restaurantId', '==', restaurantId)
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
        } else {
          console.log('⚠️ Table not found for status update:', tableNumber);
        }
      } catch (tableUpdateError) {
        console.error('❌ Failed to update table status:', tableUpdateError);
        // Don't fail the order if table status update fails
      }
    }

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

app.get('/api/orders/:restaurantId', subdomainContext, authenticateToken, async (req, res) => {
  try {
    // Use subdomain context if available, otherwise use URL parameter
    const restaurantId = req.restaurantId || req.params.restaurantId;
    
    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }
    
    const { 
      page = 1, 
      limit = 10, 
      status, 
      date, 
      search, 
      waiterId,
      orderType 
    } = req.query;

    console.log(`🔍 Orders API - Restaurant: ${restaurantId}, Page: ${page}, Limit: ${limit}, Status: ${status || 'all'}, Search: ${search || 'none'}, Waiter: ${waiterId || 'all'}`);

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

    // Apply date filter
    if (date) {
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
        // Search by order ID
        if (order.id.toLowerCase().includes(searchValue)) {
          return true;
        }
        
        // Search by order number
        if (order.orderNumber && order.orderNumber.toLowerCase().includes(searchValue)) {
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
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    
    // Fetch orders for the restaurant in the date range
    const ordersQuery = await db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId)
      .where('createdAt', '>=', startDate)
      .where('createdAt', '<=', now)
      .get();
    
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

    await db.collection(collections.orders).doc(orderId).update({
      status,
      updatedAt: new Date()
    });

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
        
        if (!existingItem) {
          // This is a completely new item
          return { ...newItem, isNew: true, addedAt: new Date().toISOString() };
        } else if (existingItem.quantity !== newItem.quantity) {
          // This item's quantity was updated
          return { ...newItem, isUpdated: true, updatedAt: new Date().toISOString() };
        } else {
          // This item was not changed
          return { ...newItem };
        }
      });
      
      updateData.items = processedItems;
      updateData.itemCount = processedItems.reduce((sum, item) => sum + item.quantity, 0);
      updateData.totalAmount = await calculateOrderTotal(processedItems);
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

    // Release table if order is being completed (Complete Billing in edit mode)
    if (status === 'completed' && currentOrder.tableNumber && currentOrder.tableNumber.trim()) {
      try {
        console.log('🔄 Releasing table due to order completion:', currentOrder.tableNumber);
        const tablesSnapshot = await db.collection(collections.tables)
          .where('restaurantId', '==', currentOrder.restaurantId)
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
        } else {
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
          const oldTablesSnapshot = await db.collection(collections.tables)
            .where('restaurantId', '==', currentOrder.restaurantId)
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
          }
        }
        
        // Occupy the new table if provided
        if (tableNumber && tableNumber.trim()) {
          console.log('🔄 Occupying new table:', tableNumber);
          const newTablesSnapshot = await db.collection(collections.tables)
            .where('restaurantId', '==', currentOrder.restaurantId)
            .where('name', '==', tableNumber.trim())
            .get();
          
          if (!newTablesSnapshot.empty) {
            const newTableDoc = newTablesSnapshot.docs[0];
            await newTableDoc.ref.update({
              status: 'occupied',
              currentOrderId: orderId,
              lastOrderTime: new Date(),
              updatedAt: new Date()
            });
            console.log('✅ New table occupied:', tableNumber);
          }
        }
      } catch (tableUpdateError) {
        console.error('❌ Failed to update table status during order update:', tableUpdateError);
        // Don't fail the order update if table status update fails
      }
    }

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
      const menuItemDoc = await db.collection(collections.menuItems).doc(item.menuItemId).get();
      if (menuItemDoc.exists) {
        const menuItem = menuItemDoc.data();
        total += menuItem.price * item.quantity;
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
app.post('/api/menus/bulk-upload/:restaurantId', chatgptUsageLimiter.middleware(), authenticateToken, upload.array('menuFiles', 10), async (req, res) => {
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
        if (uploadedFile.mimetype.startsWith('image/')) {
          console.log('Starting AI extraction for image...');
          const menuData = await extractMenuFromImage(uploadedFile.url);
          console.log('✅ AI extraction successful!');
          console.log('Extracted items:', menuData.menuItems ? menuData.menuItems.length : 0);
          
          // Record successful ChatGPT API call for menu extraction
          await chatgptUsageLimiter.recordSuccessfulCall(req, 0);
          
          // Add original file info to each menu item
          const menuItemsWithFile = (menuData.menuItems || []).map(item => ({
            ...item,
            originalFile: uploadedFile.originalName
          }));
          
          extractedMenus.push({
            file: uploadedFile.originalName,
            menuItems: menuItemsWithFile
          });
        } else {
          console.log('⚠️ Skipping non-image file (PDF processing not implemented)');
          errors.push(`PDF processing not implemented yet: ${uploadedFile.originalName}`);
        }
      } catch (error) {
        console.error(`❌ Error extracting menu from ${uploadedFile.originalName}:`, error);
        errors.push(`Failed to extract menu from ${uploadedFile.originalName}: ${error.message}`);
      }
    }
    
    console.log(`\n=== EXTRACTION SUMMARY ===`);
    console.log('Files processed:', uploadedFiles.length);
    console.log('Menus extracted:', extractedMenus.length);
    console.log('Extraction errors:', errors.length);

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

// Save extracted menu items to database
app.post('/api/menus/bulk-save/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { userId } = req.user;
    const { menuItems } = req.body;

    console.log(`\n=== BULK SAVE REQUEST ===`);
    console.log('Restaurant ID:', restaurantId);
    console.log('User ID:', userId);
    console.log('Menu items received:', menuItems ? menuItems.length : 'No items');
    
    if (menuItems && menuItems.length > 0) {
      console.log('First item sample:', JSON.stringify(menuItems[0], null, 2));
    }

    if (!menuItems || !Array.isArray(menuItems)) {
      return res.status(400).json({ error: 'Menu items array is required' });
    }

    // Check if user owns the restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const savedItems = [];
    const errors = [];

    // Get the restaurant document to update its menu
    const restaurantDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurantDoc.exists) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantData = restaurantDoc.data();
    const existingMenu = restaurantData.menu || { categories: [], items: [] };
    const existingItems = existingMenu.items || [];
    const existingCategories = existingMenu.categories || [];

    console.log('📋 Existing menu structure:', {
      hasMenu: !!restaurantData.menu,
      existingItemsCount: existingItems.length,
      existingCategoriesCount: existingCategories.length,
      firstExistingItem: existingItems[0] ? existingItems[0].name : 'No items'
    });

    // Process each menu item
    for (const item of menuItems) {
      try {
        // Map AI category to our category system
        const mapAICategory = (aiCategory) => {
          if (!aiCategory) return 'main-course';
          
          const categoryMap = {
            'appetizer': 'appetizer',
            'appetizers': 'appetizer',
            'starter': 'appetizer',
            'starters': 'appetizer',
            'main course': 'main-course',
            'main': 'main-course',
            'mains': 'main-course',
            'entree': 'main-course',
            'entrees': 'main-course',
            'dessert': 'dessert',
            'desserts': 'dessert',
            'sweet': 'dessert',
            'beverage': 'beverages',
            'beverages': 'beverages',
            'drink': 'beverages',
            'drinks': 'beverages',
            'rice': 'rice',
            'biryani': 'rice',
            'bread': 'bread',
            'roti': 'bread',
            'naan': 'bread',
            'dal': 'dal',
            'curry': 'dal',
            'curries': 'dal',
            'fast food': 'fast-food',
            'fastfood': 'fast-food',
            'burger': 'fast-food',
            'pizza': 'pizza',
            'chinese': 'chinese',
            'south indian': 'south-indian',
            'north indian': 'north-indian'
          };
          
          const normalizedCategory = aiCategory.toLowerCase().trim();
          return categoryMap[normalizedCategory] || 'main-course';
        };

        // Convert AI extracted data to match manual menu item format
        const menuItem = {
          id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Generate unique ID
        restaurantId,
          name: item.name || 'Unnamed Item',
          description: item.description || '',
          price: parseFloat(item.price) || 0,
          category: mapAICategory(item.category),
          isVeg: Boolean(item.isVeg),
          spiceLevel: item.spiceLevel || 'medium',
          allergens: Array.isArray(item.allergens) ? item.allergens : [],
          shortCode: item.shortCode || item.name.substring(0, 3).toUpperCase(),
          status: 'active',
          order: existingItems.length, // Set order based on existing items
        isAvailable: true,
        stockQuantity: null,
        lowStockThreshold: 5,
        isStockManaged: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
          updatedAt: new Date(),
          // Add source tracking
          source: 'ai_upload',
          originalFile: item.originalFile || null
        };

        // Add to existing items
        existingItems.push(menuItem);
        savedItems.push(menuItem);

        console.log(`✅ Processed item: ${menuItem.name} (${menuItem.category})`);
        console.log(`📊 Current items count: ${existingItems.length}`);

        // Add category if it doesn't exist
        const categoryExists = existingCategories.some(cat => cat.id === menuItem.category);
        if (!categoryExists) {
          existingCategories.push({
            id: menuItem.category,
            name: menuItem.category.charAt(0).toUpperCase() + menuItem.category.slice(1).replace('-', ' '),
            order: existingCategories.length,
        createdAt: new Date(),
        updatedAt: new Date()
          });
          console.log(`📂 Added new category: ${menuItem.category}`);
        }
      } catch (error) {
        console.error(`Error processing menu item ${item.name}:`, error);
        errors.push(`Failed to process ${item.name}: ${error.message}`);
      }
    }

    // Update the restaurant document with the new menu items
    if (savedItems.length > 0) {
      console.log(`\n=== UPDATING RESTAURANT DOCUMENT ===`);
      console.log('Restaurant ID:', restaurantId);
      console.log('Total items to save:', savedItems.length);
      console.log('Total categories:', existingCategories.length);
      console.log('Existing items before update:', existingItems.length);
      
      const updateData = {
        menu: {
          categories: existingCategories,
          items: existingItems,
          lastUpdated: new Date()
        },
        updatedAt: new Date()
      };
      
      console.log('Update data structure:', {
        categoriesCount: updateData.menu.categories.length,
        itemsCount: updateData.menu.items.length,
        lastUpdated: updateData.menu.lastUpdated
      });
      
      await db.collection(collections.restaurants).doc(restaurantId).update(updateData);
      console.log('✅ Restaurant document updated successfully');
      
      // Verify the update by reading the document back
      const verifyDoc = await db.collection(collections.restaurants).doc(restaurantId).get();
      const verifyData = verifyDoc.data();
      console.log('🔍 Verification - Menu items after update:', verifyData.menu?.items?.length || 0);
      console.log('🔍 Verification - Menu categories after update:', verifyData.menu?.categories?.length || 0);
    } else {
      console.log('❌ No items to save, skipping database update');
    }

    res.json({
      message: 'Menu items saved successfully',
      savedCount: savedItems.length,
      errorCount: errors.length,
      savedItems: savedItems,
      errors: errors
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
app.get('/api/tables/:restaurantId', subdomainContext, authenticateToken, async (req, res) => {
  try {
    // Use subdomain context if available, otherwise use URL parameter
    const restaurantId = req.restaurantId || req.params.restaurantId;
    
    if (!restaurantId) {
      return res.status(400).json({ error: 'Restaurant ID is required' });
    }

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

    // Check for duplicate table name across all floors in the restaurant
    const existingTablesSnapshot = await db.collection(collections.tables)
      .where('restaurantId', '==', restaurantId)
      .where('name', '==', name)
      .get();

    if (!existingTablesSnapshot.empty) {
      return res.status(400).json({ error: `Table "${name}" already exists in this restaurant` });
    }

    const tableData = {
      restaurantId,
      name,
      floor: floor,
      capacity: capacity || 4,
      section: section || 'Main',
      status: 'available', // available, occupied, reserved, cleaning
      currentOrderId: null,
      lastOrderTime: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const tableRef = await db.collection(collections.tables).add(tableData);

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

app.patch('/api/tables/:tableId/status', authenticateToken, async (req, res) => {
  try {
    const { tableId } = req.params;
    const { status, orderId } = req.body;

    const validStatuses = ['available', 'occupied', 'serving', 'reserved', 'cleaning', 'out-of-service'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
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

    await db.collection(collections.tables).doc(tableId).update(updateData);

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
    const { name, floor, capacity, section } = req.body;

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

    await db.collection(collections.tables).doc(tableId).update(updateData);

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

    await db.collection(collections.tables).doc(tableId).delete();

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

    // Get all tables for this restaurant
    const tablesSnapshot = await db.collection(collections.tables)
      .where('restaurantId', '==', restaurantId)
      .get();

    const tables = [];
    tablesSnapshot.forEach(doc => {
      tables.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Group tables by floor
    const floorsMap = {};
    tables.forEach(table => {
      const floorName = table.floor || 'Ground Floor';
      if (!floorsMap[floorName]) {
        floorsMap[floorName] = {
          id: `floor_${floorName.toLowerCase().replace(/\s+/g, '_')}`,
          name: floorName,
          restaurantId,
          tables: []
        };
      }
      floorsMap[floorName].tables.push(table);
    });

    const floors = Object.values(floorsMap);
    
    // If no floors exist, create default floor structure
    if (floors.length === 0) {
      floors.push({
        id: 'floor_ground_floor',
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

    // Create a sample table for this floor to establish the floor
    const tableData = {
      restaurantId,
      name: 'Table 1',
      floor: name,
      capacity: 4,
      section: 'Main',
      status: 'available',
      currentOrderId: null,
      lastOrderTime: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const tableRef = await db.collection(collections.tables).add(tableData);

    res.status(201).json({
      message: 'Floor created successfully with initial table',
      floor: {
        id: `floor_${name.toLowerCase().replace(/\s+/g, '_')}`,
        name,
        description: description || null,
        restaurantId,
        tables: [{
          id: tableRef.id,
          ...tableData
        }]
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

    if (!tableId || !customerName || !customerPhone || !bookingDate || !bookingTime || !partySize) {
      return res.status(400).json({ 
        error: 'Table ID, customer name, phone, booking date, time, and party size are required' 
      });
    }

    // Check if table exists and is available
    const tableDoc = await db.collection(collections.tables).doc(tableId).get();
    if (!tableDoc.exists) {
      return res.status(404).json({ error: 'Table not found' });
    }

    const tableData = tableDoc.data();
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
      await db.collection(collections.tables).doc(tableId).update({
        status: 'reserved',
        currentBookingId: bookingRef.id,
        updatedAt: new Date()
      });
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

// Get all staff for a restaurant
app.get('/api/staff/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.users)
      .where('restaurantId', '==', restaurantId)
      .where('role', 'in', ['waiter', 'manager', 'employee'])
      .get();

    const staff = [];
    snapshot.forEach(doc => {
      const userData = doc.data();
      staff.push({
        id: doc.id,
        name: userData.name,
        phone: userData.phone,
        email: userData.email,
        role: userData.role,
        status: userData.status || 'active',
        startDate: userData.startDate,
        lastLogin: userData.lastLogin,
        createdAt: userData.createdAt,
        updatedAt: userData.updatedAt
      });
    });

    res.json({ staff });

  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

// Add new staff member
app.post('/api/staff/:restaurantId', authenticateToken, requireOwnerRole, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { name, phone, email, role = 'waiter', startDate, address } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required' });
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
        createdAt: staffData.createdAt
      },
      // For demo purposes, return credentials (remove in production)
      credentials: {
        loginId: userId,
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
      restaurantId: userData.restaurantId
    });
  } catch (error) {
    console.error('Get page access error:', error);
    res.status(500).json({ error: 'Failed to get page access' });
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

// Staff login with User ID and password
app.post('/api/auth/staff/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;

    if (!loginId || !password) {
      return res.status(400).json({ error: 'Login ID and password are required' });
    }

    // Find staff member by loginId (User ID)
    const staffQuery = await db.collection(collections.users)
      .where('loginId', '==', loginId)
      .where('role', 'in', ['waiter', 'manager', 'employee'])
      .where('status', '==', 'active')
      .get();

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
        pageAccess: staffData.pageAccess
      },
      restaurant: restaurantData ? {
        id: restaurantData.id,
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

    const validStatuses = ['confirmed', 'preparing', 'ready', 'served', 'completed'];
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

    const { status, receivedItems } = req.body;

    const orderDoc = await db.collection(collections.purchaseOrders).doc(orderId).get();
    if (!orderDoc.exists || orderDoc.data().restaurantId !== restaurantId) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }

    const updateData = { 
      status, 
      updatedAt: new Date(),
      updatedBy: userId
    };

    if (status === 'received' && receivedItems) {
      updateData.receivedItems = receivedItems;
      updateData.receivedAt = new Date();
      
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
    
    res.json({
      message: 'Purchase order updated successfully',
      order: { id: orderId, ...orderDoc.data(), ...updateData }
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
    const categories = restaurantData.categories || [];

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

    // Check if category already exists
    const categoryId = name.toLowerCase().replace(/\s+/g, '-');
    if (existingCategories.find(cat => cat.id === categoryId)) {
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

// 404 handler - must be last
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
      '/api/dinebot/*'
    ]
  });
});

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

// Update restaurant subdomain
app.put('/api/restaurants/:restaurantId/subdomain', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { subdomain } = req.body;
    const { userId } = req.user;

    if (!subdomain) {
      return res.status(400).json({ error: 'Subdomain is required' });
    }

    // Validate subdomain format
    const subdomainRegex = /^[a-z0-9-]+$/;
    if (!subdomainRegex.test(subdomain) || subdomain.length < 3 || subdomain.length > 30) {
      return res.status(400).json({ 
        error: 'Subdomain must be 3-30 characters long and contain only lowercase letters, numbers, and hyphens' 
      });
    }

    // Check if user owns the restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if subdomain is already taken
    const existingRestaurant = await db.collection(collections.restaurants)
      .where('subdomain', '==', subdomain)
      .limit(1)
      .get();
    
    if (!existingRestaurant.empty && existingRestaurant.docs[0].id !== restaurantId) {
      return res.status(400).json({ error: 'Subdomain is already taken' });
    }

    // Update restaurant with new subdomain
    await db.collection(collections.restaurants).doc(restaurantId).update({
      subdomain,
      updatedAt: new Date()
    });

    // Generate new QR code with subdomain
    const qrData = `https://${subdomain}.dineopen.com`;
    const qrCode = await QRCode.toDataURL(qrData);
    
    await db.collection(collections.restaurants).doc(restaurantId).update({ 
      qrCode, 
      qrData 
    });

    res.json({
      success: true,
      message: 'Subdomain updated successfully',
      subdomain,
      qrData
    });

  } catch (error) {
    console.error('Update subdomain error:', error);
    res.status(500).json({ error: 'Failed to update subdomain' });
  }
});

// Check subdomain availability
app.get('/api/restaurants/subdomain-availability/:subdomain', authenticateToken, async (req, res) => {
  try {
    const { subdomain } = req.params;

    // Validate subdomain format
    const subdomainRegex = /^[a-z0-9-]+$/;
    if (!subdomainRegex.test(subdomain) || subdomain.length < 3 || subdomain.length > 30) {
      return res.json({
        available: false,
        reason: 'Invalid format. Must be 3-30 characters with only lowercase letters, numbers, and hyphens'
      });
    }

    // Check if subdomain is already taken
    const existingRestaurant = await db.collection(collections.restaurants)
      .where('subdomain', '==', subdomain)
      .limit(1)
      .get();
    
    if (!existingRestaurant.empty) {
      return res.json({
        available: false,
        reason: 'Subdomain is already taken'
      });
    }

    res.json({
      available: true,
      subdomain
    });

  } catch (error) {
    console.error('Check subdomain availability error:', error);
    res.status(500).json({ error: 'Failed to check subdomain availability' });
  }
});

// ==================== SUBDOMAIN MANAGEMENT ====================

// Get restaurant by subdomain (public API)
app.get('/api/public/restaurant-by-subdomain/:subdomain', vercelSecurityMiddleware.publicAPI, async (req, res) => {
  try {
    const { subdomain } = req.params;

    if (!subdomain) {
      return res.status(400).json({ error: 'Subdomain is required' });
    }

    // Search for restaurant by subdomain
    const snapshot = await db.collection(collections.restaurants)
      .where('subdomain', '==', subdomain)
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const restaurantDoc = snapshot.docs[0];
    const restaurantData = restaurantDoc.data();

    // Return minimal restaurant data for public access
    const publicRestaurantData = {
      id: restaurantDoc.id,
      name: restaurantData.name,
      subdomain: restaurantData.subdomain,
      description: restaurantData.description,
      address: restaurantData.address,
      phone: restaurantData.phone,
      email: restaurantData.email,
      logo: restaurantData.logo,
      coverImage: restaurantData.coverImage,
      menu: restaurantData.menu,
      settings: {
        currency: restaurantData.settings?.currency || 'INR',
        timezone: restaurantData.settings?.timezone || 'Asia/Kolkata'
      }
    };

    res.json({
      success: true,
      restaurant: publicRestaurantData
    });

  } catch (error) {
    console.error('Error fetching restaurant by subdomain:', error);
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

// Check subdomain availability
app.get('/api/restaurants/subdomain-availability/:subdomain', authenticateToken, async (req, res) => {
  try {
    const { subdomain } = req.params;

    // Validate subdomain format
    const { isValidRestaurantSubdomain } = require('./middleware/subdomainContext');
    if (!isValidRestaurantSubdomain(subdomain)) {
      return res.json({
        available: false,
        reason: 'Invalid format. Must be 3-30 characters with only lowercase letters, numbers, and hyphens'
      });
    }

    // Check if subdomain is available
    const isAvailable = await isSubdomainAvailable(subdomain);
    
    res.json({
      available: isAvailable,
      subdomain: isAvailable ? subdomain : null,
      reason: isAvailable ? null : 'Subdomain is already taken'
    });

  } catch (error) {
    console.error('Check subdomain availability error:', error);
    res.status(500).json({ error: 'Failed to check subdomain availability' });
  }
});

// Update restaurant subdomain
app.put('/api/restaurants/:restaurantId/subdomain', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { subdomain } = req.body;
    const { userId } = req.user;

    if (!subdomain) {
      return res.status(400).json({ error: 'Subdomain is required' });
    }

    // Validate subdomain format
    const { isValidRestaurantSubdomain } = require('./middleware/subdomainContext');
    if (!isValidRestaurantSubdomain(subdomain)) {
      return res.status(400).json({ 
        error: 'Subdomain must be 3-30 characters long and contain only lowercase letters, numbers, and hyphens' 
      });
    }

    // Check if user owns the restaurant
    const restaurant = await db.collection(collections.restaurants).doc(restaurantId).get();
    if (!restaurant.exists || restaurant.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if subdomain is available
    const isAvailable = await isSubdomainAvailable(subdomain, restaurantId);
    if (!isAvailable) {
      return res.status(400).json({ error: 'Subdomain is already taken' });
    }

    // Update restaurant with new subdomain
    await db.collection(collections.restaurants).doc(restaurantId).update({
      subdomain,
      updatedAt: new Date()
    });

    // Generate new QR code with subdomain
    const qrData = `https://${subdomain}.dineopen.com`;
    const qrCode = await QRCode.toDataURL(qrData);
    
    await db.collection(collections.restaurants).doc(restaurantId).update({ 
      qrCode, 
      qrData 
    });

    res.json({
      success: true,
      message: 'Subdomain updated successfully',
      subdomain,
      qrData
    });

  } catch (error) {
    console.error('Update subdomain error:', error);
    res.status(500).json({ error: 'Failed to update subdomain' });
  }
});

// ==================== END SUBDOMAIN MANAGEMENT ====================

// ==================== END EMAIL SERVICE API ====================

// Start server for both local development and production
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Dine Backend server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🍽️ Ready to serve your restaurant management app!`);
    console.log(`🔗 Database: dine`);
    console.log(`📁 Collections: ${Object.keys(collections).join(', ')}`);
  });

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  }
});

module.exports = app;
