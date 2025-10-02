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
const initializePaymentRoutes = require('./payment');

const app = express();
const PORT = process.env.PORT || 3003;

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
// const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Initialize Firebase Storage
let storage;
if (process.env.NODE_ENV === 'production') {
  // For production
  const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  storage = new Storage({
    projectId: serviceAccount.project_id,
    credentials: {
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key
    }
  });
} else {
  // For local development
  storage = new Storage();
}
const bucket = storage.bucket(process.env.FIREBASE_STORAGE_BUCKET || 'dine-menu-uploads');

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
  'https://dine-frontend-ecru.vercel.app'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS not allowed"));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions)); 
app.options('*', cors(corsOptions)); // important for preflight
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));


app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  req.id = Math.random().toString(36).substring(2, 15);
  res.setHeader('X-Request-ID', req.id);
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

const generateOTP = () => {
  return "1234";
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
    const emailOTP = generateOTP();

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
    const { token } = req.body;

    const ticket = await googleClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { email, name, picture } = payload;

    let userDoc = await db.collection(collections.users)
      .where('email', '==', email)
      .get();

    let userId;

    if (userDoc.empty) {
      const newUser = {
        email,
        name,
        picture,
        role: 'customer',
        emailVerified: true,
        phoneVerified: false,
        provider: 'google',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const userRef = await db.collection(collections.users).add(newUser);
      userId = userRef.id;
    } else {
      userId = userDoc.docs[0].id;
      await userDoc.docs[0].ref.update({
        updatedAt: new Date(),
        picture: picture || userDoc.docs[0].data().picture
      });
    }

    const jwtToken = jwt.sign(
      { userId, email, role: userDoc.empty ? 'customer' : userDoc.docs[0].data().role },
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
        role: userDoc.empty ? 'customer' : userDoc.docs[0].data().role
      }
    });

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Google authentication failed' });
  }
});

// Handle OPTIONS requests for CORS preflight
app.options('/api/auth/phone/send-otp', (req, res) => {
  res.status(200).end();
});

app.post('/api/auth/phone/send-otp', async (req, res) => {
  try {
    console.log('📱 OTP request received from origin:', req.headers.origin);
    console.log('📱 Request headers:', req.headers);
    
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    const otp = generateOTP();
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

// Owner phone-based registration/login
app.post('/api/auth/phone/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    const otpQuery = await db.collection('otp_verification')
      .where('phone', '==', phone)
      .where('otp', '==', otp)
      .limit(1)
      .get();

    if (otpQuery.empty) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    const otpDoc = otpQuery.docs[0];
    const otpData = otpDoc.data();

    if (new Date() > otpData.otpExpiry.toDate()) {
      return res.status(400).json({ error: 'OTP expired' });
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
        role: 'owner'
      },
      isNewUser,
      hasRestaurants,
      redirectTo: isNewUser || !hasRestaurants ? '/admin' : '/admin'
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
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const restaurantRef = await db.collection(collections.restaurants).add(restaurantData);

    const qrData = `${process.env.FRONTEND_URL}/menu/${restaurantRef.id}`;
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

app.get('/api/menus/:restaurantId', async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { category } = req.query;

    let query = db.collection(collections.menus)
      .where('restaurantId', '==', restaurantId)
      .where('status', '==', 'active');

    if (category) {
      query = query.where('category', '==', category);
    }

    const snapshot = await query.get();
    const menuItems = [];

    snapshot.forEach(doc => {
      menuItems.push({
        id: doc.id,
        ...doc.data()
      });
    });

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

    const menuItem = {
      restaurantId,
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
      stockQuantity: req.body.stockQuantity || null, // null means unlimited
      lowStockThreshold: req.body.lowStockThreshold || 5,
      isStockManaged: req.body.isStockManaged || false,
      availableFrom: req.body.availableFrom || null, // time-based availability
      availableUntil: req.body.availableUntil || null,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const menuRef = await db.collection(collections.menus).add(menuItem);

    res.status(201).json({
      message: 'Menu item created successfully',
      menuItem: {
        id: menuRef.id,
        ...menuItem
      }
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
    
    // Get the menu item first to check ownership
    const menuItemDoc = await db.collection(collections.menus).doc(id).get();
    
    if (!menuItemDoc.exists) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    
    const menuItemData = menuItemDoc.data();
    
    // Check if user owns the restaurant this menu item belongs to
    const restaurantDoc = await db.collection(collections.restaurants).doc(menuItemData.restaurantId).get();
    if (!restaurantDoc.exists || restaurantDoc.data().ownerId !== userId) {
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
    
    await db.collection(collections.menus).doc(id).update(updateData);
    
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
    
    // Get the menu item first to check ownership
    const menuItemDoc = await db.collection(collections.menus).doc(id).get();
    
    if (!menuItemDoc.exists) {
      return res.status(404).json({ error: 'Menu item not found' });
    }
    
    const menuItemData = menuItemDoc.data();
    
    // Check if user owns the restaurant this menu item belongs to
    const restaurantDoc = await db.collection(collections.restaurants).doc(menuItemData.restaurantId).get();
    if (!restaurantDoc.exists || restaurantDoc.data().ownerId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Soft delete by setting status to 'deleted'
    await db.collection(collections.menus).doc(id).update({
      status: 'deleted',
      deletedAt: new Date(),
      updatedAt: new Date()
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

app.post('/api/orders', async (req, res) => {
  try {
    const { 
      restaurantId, 
      tableNumber, 
      items, 
      customerInfo, 
      orderType = 'dine-in',
      paymentMethod = 'cash',
      staffInfo,
      notes 
    } = req.body;

    if (!restaurantId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Restaurant ID and items are required' });
    }

    let totalAmount = 0;
    const orderItems = [];

    for (const item of items) {
      const menuItem = await db.collection(collections.menus).doc(item.menuItemId).get();
      
      if (!menuItem.exists) {
        return res.status(400).json({ error: `Menu item ${item.menuItemId} not found` });
      }

      const menuData = menuItem.data();
      const itemTotal = menuData.price * item.quantity;
      totalAmount += itemTotal;

      orderItems.push({
        menuItemId: item.menuItemId,
        name: menuData.name,
        price: menuData.price,
        quantity: item.quantity,
        total: itemTotal,
        notes: item.notes || ''
      });
    }

    const orderData = {
      restaurantId,
      tableNumber: tableNumber || null,
      orderType,
      items: orderItems,
      totalAmount,
      customerInfo: customerInfo || {},
      paymentMethod: paymentMethod || 'cash',
      staffInfo: staffInfo || null,
      notes: notes || '',
      status: req.body.status || 'pending',
      kotSent: false,
      paymentStatus: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const orderRef = await db.collection(collections.orders).add(orderData);
    
    console.log(`🛒 Order created successfully: ${orderRef.id} with status: ${orderData.status}`);
    console.log(`📋 Order items: ${orderData.items.length} items`);
    console.log(`🏪 Restaurant: ${orderData.restaurantId}`);

    res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: orderRef.id,
        ...orderData
      }
    });

  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

app.get('/api/orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { status, date, search, waiterId } = req.query;

    console.log(`🔍 Orders API - Restaurant: ${restaurantId}, Status: ${status || 'all'}, Search: ${search || 'none'}, Waiter: ${waiterId || 'all'}`);

    let query = db.collection(collections.orders)
      .where('restaurantId', '==', restaurantId);

    if (status) {
      query = query.where('status', '==', status);
    }

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      
      query = query.where('createdAt', '>=', startDate)
                   .where('createdAt', '<', endDate);
    }

    const snapshot = await query.orderBy('createdAt', 'desc').get();
    let orders = [];

    snapshot.forEach(doc => {
      orders.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Apply waiter filter if provided
    if (waiterId) {
      orders = orders.filter(order => {
        return order.staffInfo && order.staffInfo.userId === waiterId;
      });
      console.log(`👤 Filtered by waiter ${waiterId}: ${orders.length} orders found`);
    }

    // Apply search filter if provided
    if (search) {
      const searchValue = search.toLowerCase().trim();
      console.log(`🔎 Searching orders for: "${searchValue}"`);
      
      orders = orders.filter(order => {
        // Search by order ID (case insensitive) - Order IDs are unique, return regardless of status
        if (order.id.toLowerCase().includes(searchValue)) {
          console.log(`✅ Found match by order ID: ${order.id} (status: ${order.status})`);
          return true;
        }
        
        // Search by table number (if exists) - Only return non-completed for table searches
        if (order.tableNumber && order.tableNumber.toString().toLowerCase().includes(searchValue)) {
          if (order.status !== 'completed' && order.status !== 'cancelled') {
            console.log(`✅ Found match by table number: ${order.tableNumber} (status: ${order.status})`);
            return true;
          } else {
            console.log(`❌ Found order by table ${order.tableNumber} but it's ${order.status}`);
          }
        }
        
        // Search by waiter name (if exists)
        if (order.staffInfo && order.staffInfo.name && order.staffInfo.name.toLowerCase().includes(searchValue)) {
          console.log(`✅ Found match by waiter name: ${order.staffInfo.name} (status: ${order.status})`);
          return true;
        }
        
        // Search by waiter login ID (if exists)
        if (order.staffInfo && order.staffInfo.loginId && order.staffInfo.loginId.toLowerCase().includes(searchValue)) {
          console.log(`✅ Found match by waiter login ID: ${order.staffInfo.loginId} (status: ${order.status})`);
          return true;
        }
        
        return false;
      });
      
      console.log(`📊 Search results: ${orders.length} orders found`);
    } else {
      // If no search, filter out completed orders by default
      orders = orders.filter(order => order.status !== 'completed' && order.status !== 'cancelled');
      console.log(`📊 All active orders: ${orders.length} orders found`);
    }

    res.json({ orders });

  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.patch('/api/orders/:orderId/status', authenticateToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'preparing', 'ready', 'served', 'completed', 'cancelled'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
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
    const { items, tableNumber, orderType, paymentMethod, updatedAt, lastUpdatedBy } = req.body;

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
    
    // Don't allow updates to completed or cancelled orders
    if (currentOrder.status === 'completed' || currentOrder.status === 'cancelled') {
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
        paymentMethod: paymentMethod ? `Changed to ${paymentMethod}` : null
      }
    });
    updateData.updateHistory = updateHistory;

    await db.collection(collections.orders).doc(orderId).update(updateData);

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


// Bulk menu upload API
app.post('/api/menus/bulk-upload/:restaurantId', authenticateToken, upload.array('menuFiles', 10), async (req, res) => {
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

    // Save each menu item
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
          order: 0,
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

        const menuRef = await db.collection(collections.menus).add(menuItem);
        savedItems.push({
          id: menuRef.id,
          ...menuItem
        });
      } catch (error) {
        console.error(`Error saving menu item ${item.name}:`, error);
        errors.push(`Failed to save ${item.name}: ${error.message}`);
      }
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

    // Get recent menu items for this restaurant
    const menuSnapshot = await db.collection(collections.menus)
      .where('restaurantId', '==', restaurantId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const recentItems = [];
    menuSnapshot.forEach(doc => {
      recentItems.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({
      totalItems: recentItems.length,
      recentItems: recentItems
    });

  } catch (error) {
    console.error('Upload status error:', error);
    res.status(500).json({ error: 'Failed to get upload status' });
  }
});

app.post('/api/seed-data/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const sampleMenuItems = [
      {
        name: "Butter Chicken",
        description: "Creamy tomato-based chicken curry with aromatic spices",
        price: 299,
        category: "main-course",
        isVeg: false,
        spiceLevel: "medium",
        allergens: ["dairy"],
        shortCode: "BTC",
        restaurantId,
        status: "active",
        order: 1,
        isAvailable: true,
        stockQuantity: null, // unlimited
        lowStockThreshold: 5,
        isStockManaged: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Paneer Tikka Masala",
        description: "Grilled cottage cheese cubes in rich tomato gravy",
        price: 249,
        category: "main-course",
        isVeg: true,
        spiceLevel: "medium",
        allergens: ["dairy"],
        shortCode: "PTM",
        restaurantId,
        status: "active",
        order: 2,
        isAvailable: true,
        stockQuantity: null,
        lowStockThreshold: 5,
        isStockManaged: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Biryani (Chicken)",
        description: "Fragrant basmati rice cooked with marinated chicken",
        price: 349,
        category: "rice",
        isVeg: false,
        spiceLevel: "mild",
        allergens: [],
        shortCode: "CBR",
        restaurantId,
        status: "active",
        order: 3,
        isAvailable: true,
        stockQuantity: 15, // limited stock example
        lowStockThreshold: 3,
        isStockManaged: true,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Dal Tadka",
        description: "Yellow lentils tempered with cumin and garlic",
        price: 149,
        category: "dal",
        isVeg: true,
        spiceLevel: "mild",
        allergens: [],
        shortCode: "DT",
        restaurantId,
        status: "active",
        order: 4,
        isAvailable: true,
        stockQuantity: null,
        lowStockThreshold: 5,
        isStockManaged: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Garlic Naan",
        description: "Soft leavened bread topped with garlic and herbs",
        price: 89,
        category: "bread",
        isVeg: true,
        spiceLevel: "none",
        allergens: ["gluten", "dairy"],
        shortCode: "GN",
        restaurantId,
        status: "active",
        order: 5,
        isAvailable: true,
        stockQuantity: 25,
        lowStockThreshold: 5,
        isStockManaged: true,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Samosa (2 pcs)",
        description: "Crispy triangular pastries filled with spiced potatoes",
        price: 59,
        category: "appetizer",
        isVeg: true,
        spiceLevel: "mild",
        allergens: ["gluten"],
        shortCode: "SAM",
        restaurantId,
        status: "active",
        order: 6,
        isAvailable: true,
        stockQuantity: 20,
        lowStockThreshold: 3,
        isStockManaged: true,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Chicken Tikka",
        description: "Grilled marinated chicken pieces with mint chutney",
        price: 199,
        category: "appetizer",
        isVeg: false,
        spiceLevel: "medium",
        allergens: ["dairy"],
        shortCode: "CT",
        restaurantId,
        status: "active",
        order: 7,
        isAvailable: true,
        stockQuantity: null,
        lowStockThreshold: 5,
        isStockManaged: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Masala Chai",
        description: "Traditional Indian spiced tea with milk",
        price: 29,
        category: "beverages",
        isVeg: true,
        spiceLevel: "none",
        allergens: ["dairy"],
        shortCode: "MC",
        restaurantId,
        status: "active",
        order: 8,
        isAvailable: true,
        stockQuantity: null,
        lowStockThreshold: 5,
        isStockManaged: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Gulab Jamun (2 pcs)",
        description: "Soft milk dumplings in sweet cardamom syrup",
        price: 79,
        category: "dessert",
        isVeg: true,
        spiceLevel: "none",
        allergens: ["dairy", "gluten"],
        shortCode: "GJ",
        restaurantId,
        status: "active",
        order: 9,
        isAvailable: true,
        stockQuantity: 12,
        lowStockThreshold: 2,
        isStockManaged: true,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        name: "Fresh Lime Soda",
        description: "Refreshing lime drink with soda and mint",
        price: 49,
        category: "beverages",
        isVeg: true,
        spiceLevel: "none",
        allergens: [],
        shortCode: "FLS",
        restaurantId,
        status: "active",
        order: 10,
        isAvailable: true,
        stockQuantity: null,
        lowStockThreshold: 5,
        isStockManaged: false,
        availableFrom: null,
        availableUntil: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    const batch = db.batch();
    sampleMenuItems.forEach(item => {
      const docRef = db.collection(collections.menus).doc();
      batch.set(docRef, item);
    });

    await batch.commit();

    res.json({
      message: 'Sample menu data seeded successfully',
      itemsAdded: sampleMenuItems.length
    });

  } catch (error) {
    console.error('Seed data error:', error);
    res.status(500).json({ error: 'Failed to seed sample data' });
  }
});

// Seed sample orders
app.post('/api/seed-orders/:restaurantId', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const sampleOrders = [
      {
        id: `ORD-${Date.now()}-001`,
        restaurantId,
        orderType: 'dine-in',
        tableNumber: 5,
        status: 'preparing',
        customerInfo: {
          name: 'Rahul Kumar',
          phone: '+91-9876543210'
        },
        items: [
          { name: 'Butter Chicken', quantity: 2, price: 299 },
          { name: 'Garlic Naan', quantity: 3, price: 89 },
          { name: 'Basmati Rice', quantity: 1, price: 149 }
        ],
        totalAmount: 925,
        notes: 'Extra spicy',
        createdAt: new Date(Date.now() - 15 * 60 * 1000), // 15 minutes ago
        updatedAt: new Date()
      },
      {
        id: `ORD-${Date.now()}-002`,
        restaurantId,
        orderType: 'delivery',
        tableNumber: null,
        status: 'delivered',
        customerInfo: {
          name: 'Priya Sharma',
          phone: '+91-9123456789',
          address: '123 MG Road, Bangalore'
        },
        items: [
          { name: 'Chicken Tikka', quantity: 1, price: 199 },
          { name: 'Fresh Lime Soda', quantity: 2, price: 49 }
        ],
        totalAmount: 297,
        notes: null,
        createdAt: new Date(Date.now() - 45 * 60 * 1000), // 45 minutes ago
        updatedAt: new Date()
      },
      {
        id: `ORD-${Date.now()}-003`,
        restaurantId,
        orderType: 'pickup',
        tableNumber: null,
        status: 'ready',
        customerInfo: {
          name: 'Amit Patel',
          phone: '+91-9988776655'
        },
        items: [
          { name: 'Dal Tadka', quantity: 1, price: 149 },
          { name: 'Paneer Tikka Masala', quantity: 1, price: 249 },
          { name: 'Roti', quantity: 4, price: 79 }
        ],
        totalAmount: 794,
        notes: 'Less oil please',
        createdAt: new Date(Date.now() - 25 * 60 * 1000), // 25 minutes ago
        updatedAt: new Date()
      },
      {
        id: `ORD-${Date.now()}-004`,
        restaurantId,
        orderType: 'dine-in',
        tableNumber: 12,
        status: 'confirmed',
        customerInfo: {
          name: 'Sunita Reddy',
          phone: '+91-8765432109'
        },
        items: [
          { name: 'Biryani (Chicken)', quantity: 1, price: 349 },
          { name: 'Samosa', quantity: 2, price: 59 },
          { name: 'Masala Chai', quantity: 1, price: 29 }
        ],
        totalAmount: 496,
        notes: null,
        createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
        updatedAt: new Date()
      }
    ];

    // Add each order to Firestore
    const batch = db.batch();
    sampleOrders.forEach(order => {
      const orderRef = db.collection(collections.orders).doc();
      batch.set(orderRef, {
        ...order,
        id: orderRef.id // Use Firestore generated ID
      });
    });

    await batch.commit();

    res.json({
      message: 'Sample orders seeded successfully',
      ordersAdded: sampleOrders.length
    });

  } catch (error) {
    console.error('Seed orders error:', error);
    res.status(500).json({ error: 'Failed to seed sample orders' });
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

    const tableData = {
      restaurantId,
      name,
      floor: floor || 'Ground Floor',
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
    const { name } = req.body;

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
    const validKotStatuses = ['confirmed', 'preparing', 'ready'];
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
        if (status === 'expired' && new Date(itemData.expiryDate) > new Date()) return;
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
      
      items.push(itemData);
    });

    console.log(`📊 Inventory results: ${items.length} items found`);

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

// Get inventory categories
app.get('/api/inventory/:restaurantId/categories', authenticateToken, async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const snapshot = await db.collection(collections.inventory)
      .where('restaurantId', '==', restaurantId)
      .get();

    const categories = new Set();
    snapshot.forEach(doc => {
      const itemData = doc.data();
      if (itemData.category) {
        categories.add(itemData.category);
      }
    });

    res.json({ 
      categories: Array.from(categories).sort(),
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
      
      if (itemData.status === 'low') lowStockItems++;
      if (itemData.status === 'expired') expiredItems++;
      
      totalValue += itemData.currentStock * itemData.costPerUnit;
      
      if (itemData.category) {
        categories.add(itemData.category);
      }
    });

    res.json({
      stats: {
        totalItems,
        lowStockItems,
        expiredItems,
        totalValue,
        totalCategories: categories.size
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Get inventory dashboard error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
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
      '/api/kot/*'
    ]
  });
});

// Start server for both local development and production
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Dine Backend server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🍽️ Ready to serve your restaurant management app!`);
});

module.exports = app;
